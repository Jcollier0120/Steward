import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Gitea and Forgejo (src/hosts/gitea.ts): pull requests, commit statuses, releases and issues through `tea api` to
// their REST API (v1), said in GitHub's words, so the Steward's rounds are the same on Codeberg or a Gitea of your own.
// The answers below are shaped as Gitea's API documents them; tea writes the status line to stderr (-i) and exits 0
// whatever the server answered.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-gitea-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { hostFor, must } = await import('../src/hosts/index.ts');
const { answered, mergeStatesOf, prOf, teaLogins, unwip, whereGitea } = await import('../src/hosts/gitea.ts');
const { autoWords, findScm, hostOf, isGiteaRepo, repoFromUrl } = await import('../src/scm.ts');
const { merge } = await import('../src/stages/merge.ts');
const { parsePrs } = await import('../src/stages/staff.ts');
const { ctxFor, employee, fakeEmployee, runner, sh } = await import('./helpers.ts');
type Ran = import('../src/run.ts').Ran;
type ScmLook = import('../src/scm.ts').ScmLook;

const R = 'codeberg.org/acme/fake';
const P = 'repos/acme/fake';
const LOGINS = JSON.stringify([
  { name: 'gitea.com', url: 'https://gitea.com', ssh_host: 'gitea.com', user: 'someone', default: 'false' },
  { name: 'codeberg', url: 'https://codeberg.org', ssh_host: 'codeberg.org', user: 'jcollier0120', default: 'true' },
]);
const signedIn: ScmLook = { at: '2026-10-09T00:00:00Z', tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.47', supported: true }, { cmd: 'tea', name: 'Gitea CLI', version: 'Version: 0.11.0', signedIn: true, hosts: ['codeberg.org', 'gitea.com'], supported: true }] };

/** What `tea api -i` prints: the body on stdout, the status line (and headers) on stderr, exit 0. */
const http = (status: number, body: unknown = {}): Ran => ({ code: 0, out: typeof body === 'string' ? body : JSON.stringify(body), err: `HTTP/1.1 ${status} ${status < 300 ? 'OK' : status === 404 ? 'Not Found' : 'Error'}\nContent-Type: application/json\n` });

/** A pull request as GET /repos/:owner/:repo/pulls lists one. */
const pull = (o: Record<string, unknown> = {}) => ({ number: 7, title: 'Fake 0.4.1: A feature', body: '**A feature.**', state: 'open', merged: false, html_url: 'https://codeberg.org/acme/fake/pulls/7', head: { ref: 'claude/feature', sha: 'abc123', repo: { full_name: 'acme/fake' } }, base: { ref: 'main', sha: 'def', repo: { full_name: 'acme/fake' } }, user: { login: 'jcollier0120' }, mergeable: true, draft: false, labels: [{ id: 1, name: 'steward' }], additions: 2, deletions: 1, created_at: '2026-10-10T11:50:00Z', ...o });

/** A tea api request's method, endpoint and parsed body. */
const call = (args: string[]) => {
  const i = args.indexOf('-d');
  return { method: args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET', at: args.at(-1)!, login: args[args.indexOf('--login') + 1], body: i >= 0 ? JSON.parse(readFileSync(args[i + 1].replace(/^@/, ''), 'utf8')) : undefined, out: args.includes('-o') ? args[args.indexOf('-o') + 1] : undefined };
};

/** A host on Codeberg whose tea answers `answer`, and every request it made. */
function recorded(answer: (c: ReturnType<typeof call>) => Ran | undefined) {
  const ran: ReturnType<typeof call>[] = [];
  const host = hostFor(
    {
      run: async (cmd, args) => {
        assert.equal(cmd, 'tea');
        if (args[0] === 'logins') return { code: 0, out: LOGINS, err: '' };
        const c = call(args);
        ran.push(c);
        return answer(c) ?? http(404, { message: `no stand-in for ${c.method} ${c.at}` });
      },
      neutralDir: tmp,
      host: () => 'gitea',
    },
    { repo: R },
  );
  return { host, ran };
}

test("a repository on a Gitea or Forgejo tea has a login for is worked with Gitea's way; else plain git", async () => {
  for (const url of ['https://codeberg.org/acme/fake.git', 'git@codeberg.org:acme/fake.git']) assert.equal(repoFromUrl(url), R);
  assert.deepEqual(whereGitea(R), { hostname: 'codeberg.org', owner: 'acme', name: 'fake' });
  assert.equal(whereGitea('Jcollier0120/Fake'), null);
  assert.equal(isGiteaRepo(R, signedIn), true);
  assert.equal(isGiteaRepo('git.example.com/acme/fake', signedIn), false, 'no tea login for that server');
  const s = { sourceControl: 'auto' as const, releasesCastellan: false };
  assert.equal(hostOf({ repo: R }, s, signedIn), 'gitea');
  assert.equal(hostOf({ repo: 'git.example.com/acme/fake' }, s, signedIn), 'git');
  assert.equal(hostOf({ repo: R }, s, { ...signedIn, tools: signedIn.tools.map((t) => ({ ...t, signedIn: false })) }), 'git');
  assert.equal(hostOf({ repo: R }, s, null), 'git');
  assert.equal(hostOf({ repo: R }, { ...s, sourceControl: 'git' }, signedIn), 'git');
  assert.equal(hostOf({ repo: 'gitlab.com/acme/fake' }, s, signedIn), 'git', 'GitLab stays GitLab\'s (or git)');
  assert.match(autoWords(signedIn), /Gitea for repositories on codeberg\.org, gitea\.com \(the Gitea CLI is signed in there\), Git for any other/);
  assert.match(autoWords({ ...signedIn, tools: signedIn.tools.map((t) => ({ ...t, signedIn: false })) }), /the Gitea CLI is installed, but has no login/);

  // Found: tea's logins name the servers; an older tea without `tea api` isn't worked with.
  const look = async (apiHelp: number) =>
    (await findScm(async (cmd, args) => (cmd !== 'tea' ? { code: 1, out: '', err: '' } : args[0] === '--version' ? { code: 0, out: 'Version: 0.11.0', err: '' } : args[0] === 'logins' ? { code: 0, out: LOGINS, err: '' } : { code: apiHelp, out: '', err: '' }))).tools.find((t) => t.cmd === 'tea')!;
  assert.deepEqual(await look(0), { cmd: 'tea', name: 'Gitea CLI', version: 'Version: 0.11.0', supported: true, hosts: ['codeberg.org', 'gitea.com'], signedIn: true });
  assert.equal((await look(1)).signedIn, false);
});

test("tea's answers: an HTTP error is a failure though tea exits 0; logins by server, the default first", () => {
  assert.deepEqual(answered(http(200, { a: 1 })), { code: 0, out: '{"a":1}', err: '' });
  assert.deepEqual(answered(http(404, { message: 'pull request does not exist' })), { code: 1, out: '', err: 'HTTP 404 Not Found: pull request does not exist' });
  assert.deepEqual(answered({ code: 1, out: '', err: 'Error: no login' }), { code: 1, out: '', err: 'Error: no login' });
  const two = teaLogins(JSON.stringify([{ Name: 'work', URL: 'https://git.example.com', Default: 'false' }, { Name: 'mine', URL: 'https://git.example.com/', Default: 'true' }, { Name: 'bad', URL: 'not a url' }]));
  assert.deepEqual([...two], [['git.example.com', 'mine']]);
  assert.equal(unwip('WIP: Fake 0.4.1'), 'Fake 0.4.1');
  assert.equal(unwip('[WIP] Fake 0.4.1'), 'Fake 0.4.1');
  assert.equal(unwip('Fake: WIP: stays'), 'Fake: WIP: stays');
});

test("a pull request in GitHub's words: what the Steward reads of one", () => {
  const pr = prOf(pull(), { files: ['src/a.ts', 'y'], statuses: [{ context: 'ci/test', status: 'success' }, { context: 'steward/tested', status: 'success' }] });
  assert.deepEqual(pr, {
    number: 7,
    title: 'Fake 0.4.1: A feature',
    url: 'https://codeberg.org/acme/fake/pulls/7',
    body: '**A feature.**',
    state: 'OPEN',
    headRefName: 'claude/feature',
    headRefOid: 'abc123',
    createdAt: '2026-10-10T11:50:00Z',
    baseRefName: 'main',
    isCrossRepository: false,
    author: { login: 'jcollier0120' },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    isDraft: false,
    statusCheckRollup: [
      { __typename: 'StatusContext', context: 'ci/test', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'steward/tested', state: 'SUCCESS' },
    ],
    labels: [{ name: 'steward' }],
    additions: 2,
    deletions: 1,
    files: [{ path: 'src/a.ts' }, { path: 'y' }],
  });
  const [info] = parsePrs(JSON.stringify([pr]), ['Jcollier0120']);
  assert.equal(info.whose, 'team');
  assert.equal(info.checks, 'passing');
  assert.equal(info.changed, 3);
  assert.equal(prOf(pull({ head: { ref: 'x', sha: 'a', repo: { full_name: 'fork/fake' } } })).isCrossRepository, true);
  assert.equal(prOf(pull({ state: 'closed', merged: true })).state, 'MERGED');
  assert.equal(prOf(pull({ state: 'closed' })).state, 'CLOSED');
  assert.equal(prOf(pull({ title: 'WIP: Fake 0.4.1', draft: undefined })).isDraft, true);
  assert.equal(parsePrs(JSON.stringify([prOf(pull(), { statuses: [{ context: 'ci', status: 'pending' }] })]), ['Jcollier0120'])[0].checks, 'pending');
  assert.equal(parsePrs(JSON.stringify([prOf(pull(), { statuses: [{ context: 'ci', status: 'failure' }] })]), ['Jcollier0120'])[0].checks, 'failing');
  assert.deepEqual(mergeStatesOf(pull({ mergeable: false })), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  assert.deepEqual(mergeStatesOf(pull({ mergeable: undefined })), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
});

test("Gitea's requests: tea api with the server's own login, bodies as JSON from a file", async () => {
  const { host, ran } = recorded(({ method, at }) => {
    if (at === `${P}/pulls?state=open&sort=recentupdate&limit=50&page=1`) return http(200, [pull()]);
    if (at === `${P}/pulls?state=closed&sort=recentupdate&limit=50&page=1`) return http(200, [pull({ state: 'closed', merged: true }), pull({ number: 6, state: 'closed', head: { ref: 'claude/feature', sha: 'old', repo: { full_name: 'acme/fake' } } })]);
    if (at === `${P}/pulls/7/files?limit=50&page=1`) return http(200, [{ filename: 'a.ts' }]);
    if (at === `${P}/commits/abc123/status`) return http(200, { state: 'success', statuses: [{ context: 'ci/test', status: 'success' }] });
    if (at === `${P}/commits/abc123/statuses?sort=newest&limit=50&page=1`) return http(200, [{ id: 1, context: 'ci/test', status: 'success', created_at: '2026-10-09T10:00:00Z', creator: { login: 'ci' } }, { id: 2, context: 'steward/tested', status: 'success', description: 'passed', created_at: '2026-10-09T11:00:00Z', creator: { login: 'jcollier0120' } }]);
    if (at === `${P}/pulls` && method === 'POST') return http(201, pull({ number: 8, html_url: 'https://codeberg.org/acme/fake/pulls/8' }));
    if (at === `${P}/pulls/7` && method === 'GET') return http(200, pull({ title: 'WIP: Fake 0.4.1' }));
    if (at === `${P}/pulls/7` && method === 'PATCH') return http(201, pull({ state: 'closed' }));
    if (at === 'user') return http(200, { login: 'jcollier0120' });
    if (at.startsWith(`${P}/`) && method !== 'GET') return http(method === 'DELETE' ? 204 : 200, method === 'DELETE' ? '' : {});
  });
  const list = JSON.parse(must(await host.listPrs(R, { state: 'open', limit: 100, fields: 'number,files,statusCheckRollup' })));
  assert.deepEqual([list[0].number, list[0].files, list[0].statusCheckRollup.length], [7, [{ path: 'a.ts' }], 1]);
  // Closed, not merged, from the branch: Gitea has no such filter, so the Steward picks them out.
  assert.deepEqual(JSON.parse(must(await host.listPrs(R, { state: 'closed', head: 'claude/feature', fields: 'number' }))).map((p: any) => p.number), [6]);
  assert.equal(must(await host.createPr(R, { base: 'main', head: 'claude/x', title: 'T', body: '**B**' })), 'https://codeberg.org/acme/fake/pulls/8\n');
  must(await host.readyPr(R, 7));
  must(await host.mergePr(R, 7, { matchHead: 'abc123', deleteBranch: true }));
  must(await host.closePr(R, 7, { comment: 'bye', deleteBranch: true }));
  const statuses = JSON.parse(must(await host.statuses(R, 'abc123')));
  must(await host.setStatus(R, 'abc123', { state: 'success', context: 'steward/tested', description: 'npm test passed at abc123' }));
  assert.equal(must(await host.whoAmI()), 'jcollier0120\n');
  const missing = await host.viewPr(R, 99, 'number');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /HTTP 404/);

  assert.deepEqual(statuses.map((s: any) => [s.context, s.state, s.creator.login]), [['steward/tested', 'success', 'jcollier0120'], ['ci/test', 'success', 'ci']]);
  assert.ok(ran.every((c) => c.login === 'codeberg'), 'the login for codeberg.org');
  assert.deepEqual(ran.filter((c) => c.body).map((c) => [c.method, c.at, c.body]), [
    ['POST', `${P}/pulls`, { head: 'claude/x', base: 'main', title: 'T', body: '**B**' }],
    ['PATCH', `${P}/pulls/7`, { title: 'Fake 0.4.1' }],
    ['POST', `${P}/pulls/7/merge`, { Do: 'merge', head_commit_id: 'abc123', delete_branch_after_merge: true }],
    ['POST', `${P}/issues/7/comments`, { body: 'bye' }],
    ['PATCH', `${P}/pulls/7`, { state: 'closed' }],
    ['POST', `${P}/statuses/abc123`, { state: 'success', context: 'steward/tested', description: 'npm test passed at abc123' }],
  ]);
  assert.deepEqual(ran.filter((c) => c.method === 'DELETE').map((c) => c.at), [`${P}/branches/claude%2Ffeature`]);
  assert.equal(host.prRef({ number: 7, head: 'x' }), 'refs/pull/7/head');
  assert.equal(host.releaseUrl(R, 'v0.4.1'), 'https://codeberg.org/acme/fake/releases/tag/v0.4.1');
});

test('a branch with no open pull request says so as gh does, so steward vouch vouches for the branch', async () => {
  const { host } = recorded(() => http(200, []));
  const a = await host.viewPr(R, 'claude/feature', 'number,state,headRefOid,isCrossRepository');
  assert.equal(a.code, 1);
  assert.match(a.err, /no pull requests found for branch "claude\/feature"/);
});

test("releases, their files and issues in GitHub's words", async () => {
  const files = path.join(tmp, 'download');
  const { host, ran } = recorded(({ method, at, out }) => {
    if (at === `${P}/releases?limit=50&page=1`) return http(200, [{ tag_name: 'v0.4.0', name: 'Fake 0.4.0', draft: false, published_at: '2026-10-01T00:00:00Z', body: 'First', target_commitish: 'c0' }]);
    if (at === `${P}/releases/tags/v0.4.0`) return http(200, { tag_name: 'v0.4.0', target_commitish: 'c0', assets: [{ name: 'fake-0.4.0.zip', browser_download_url: 'https://codeberg.org/acme/fake/releases/download/v0.4.0/fake-0.4.0.zip' }, { name: 'notes.txt', browser_download_url: 'https://codeberg.org/x' }] });
    if (at === `${P}/releases/tags/v9.9.9`) return http(404, { message: 'release not found' });
    if (at.startsWith('https://codeberg.org/acme/fake/releases/download/') && out) return (writeFileSync(out, 'zip'), http(200, ''));
    if (at === `${P}/issues?type=issues&state=open&labels=manor%3Awork&limit=50&page=1`) return http(200, [{ number: 3, title: 'Bump', html_url: 'https://codeberg.org/acme/fake/issues/3', body: '<!-- steward:work:x -->' }]);
    if (at === `${P}/labels?limit=50&page=1`) return http(200, [{ id: 12, name: 'manor:work' }]);
    if (method !== 'GET') return http(201, { html_url: 'https://codeberg.org/acme/fake/issues/4' });
  });
  assert.deepEqual(JSON.parse(must(await host.listReleases(R, 'tagName,isDraft,publishedAt'))), [{ tagName: 'v0.4.0', name: 'Fake 0.4.0', isDraft: false, publishedAt: '2026-10-01T00:00:00Z', body: 'First', targetCommitish: 'c0' }]);
  assert.match((await host.viewRelease(R, 'v9.9.9', 'tagName')).err, /release not found/);
  must(await host.downloadRelease(R, 'v0.4.0', { patterns: ['*.zip'], dir: files }));
  assert.equal(readFileSync(path.join(files, 'fake-0.4.0.zip'), 'utf8'), 'zip');
  assert.equal(existsSync(path.join(files, 'notes.txt')), false);
  assert.deepEqual(JSON.parse(must(await host.listIssues(R, { label: 'manor:work', state: 'open', fields: 'number,url,body' }))), [{ number: 3, title: 'Bump', url: 'https://codeberg.org/acme/fake/issues/3', body: '<!-- steward:work:x -->' }]);
  assert.equal(must(await host.createIssue(R, { title: 'New', body: 'b', label: 'manor:work' })), 'https://codeberg.org/acme/fake/issues/4\n');
  must(await host.editIssue(R, 3, { body: 'c', removeLabel: 'manor:work' }));
  const notes = path.join(tmp, 'notes.md');
  writeFileSync(notes, '**Fake 0.4.1.**');
  must(await host.createRelease(R, { tag: 'v0.4.1', target: 'abc', title: 'Fake 0.4.1', notesFile: notes }));
  must(await host.closeIssue(R, 3, { reason: 'not planned', comment: 'superseded' }));
  must(await host.createLabel(R, 'manor:work', { color: '1d76db', description: 'Queued for the Wright' }));
  assert.deepEqual(ran.filter((c) => c.method !== 'GET').map((c) => [c.method, c.at, c.body]), [
    ['POST', `${P}/issues`, { title: 'New', body: 'b', labels: [12] }],
    ['PATCH', `${P}/issues/3`, { body: 'c' }],
    ['DELETE', `${P}/issues/3/labels/12`, undefined],
    ['POST', `${P}/releases`, { tag_name: 'v0.4.1', target_commitish: 'abc', name: 'Fake 0.4.1', body: '**Fake 0.4.1.**' }],
    ['POST', `${P}/issues/3/comments`, { body: 'superseded' }],
    ['PATCH', `${P}/issues/3`, { state: 'closed' }],
    ['POST', `${P}/labels`, { name: 'manor:work', color: '#1d76db', description: 'Queued for the Wright' }],
  ]);
});

test("a merge round on Codeberg: the team's pull request, its checks passed, merged at the head it read", async () => {
  const f = fakeEmployee(path.join(tmp, 'round'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/feature');
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').split('0.4.0').join('0.4.1'));
  writeFileSync(path.join(f.checkout, 'feature.txt'), 'a feature\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'A feature');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/feature');
  sh(f.origin, 'update-ref', 'refs/pull/7/head', head);
  sh(f.checkout, 'switch', '--quiet', 'main');

  const tea: ReturnType<typeof call>[] = [];
  const gh = runner();
  const run = async (cmd: string, args: string[], opts?: any): Promise<Ran> => {
    if (cmd !== 'tea') return gh.run(cmd, args, opts);
    if (args[0] === 'logins') return { code: 0, out: LOGINS, err: '' };
    const c = call(args);
    tea.push(c);
    const sha = { ref: 'claude/feature', sha: head, repo: { full_name: 'acme/fake' } };
    if (c.at === `${P}/pulls?state=open&sort=recentupdate&limit=50&page=1`) return http(200, [pull({ head: sha })]);
    if (c.at === `${P}/pulls/7/files?limit=50&page=1`) return http(200, [{ filename: 'feature.txt' }, { filename: 'package.json' }]);
    if (c.at === `${P}/commits/${head}/status`) return http(200, { state: 'success', statuses: [{ context: 'ci/test', status: 'success' }] });
    if (c.at === `${P}/releases?limit=50&page=1`) return http(200, [{ tag_name: 'v0.4.0', published_at: '2026-10-03T00:00:00Z', target_commitish: 'c0' }]);
    if (c.method === 'POST' && c.at === `${P}/pulls/7/merge`) return http(200, '');
    if (c.method === 'POST') return http(201, {});
    return http(404, { message: `${c.method} ${c.at}` });
  };
  // Checks that would fail, were they run here: Gitea's checks passed, so they aren't.
  const e = employee(f.checkout, { repo: R, fill: '', test: ['node -e process.exit(1)'] });
  const ctx = { ...ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run, neutralDir: tmp }), host: () => 'gitea' as const };
  const [m] = await merge(ctx, [e], { yes: true, team: true });
  assert.equal(m.outcome, 'done', `${m.message}\n${ctx.lines.join('\n')}`);
  assert.match(m.message, /merged #7/);
  assert.deepEqual(gh.gh, [], 'GitHub is never asked');
  const merged = tea.find((c) => c.at === `${P}/pulls/7/merge`);
  assert.deepEqual(merged?.body, { Do: 'merge', head_commit_id: head });
});
