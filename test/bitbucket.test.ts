import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Bitbucket Cloud (src/hosts/bitbucket.ts): pull requests, build statuses and tag releases through its REST API (2.0)
// by curl, with an Atlassian API token from this PC's git credential store, said in GitHub's words, so the Steward's
// rounds are the same on Bitbucket. The answers below are shaped as Bitbucket's API documents them.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-bitbucket-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { hostFor, must } = await import('../src/hosts/index.ts');
const { answered, credentialOf, curlQuoted, mergeStatesOf, prOf, statusOf, whereBitbucket } = await import('../src/hosts/bitbucket.ts');
const { autoWords, findScm, hostOf, repoFromUrl } = await import('../src/scm.ts');
const { run: realRun } = await import('../src/run.ts');
const { merge } = await import('../src/stages/merge.ts');
const { parsePrs } = await import('../src/stages/staff.ts');
const { ctxFor, employee, fakeEmployee, runner, sh } = await import('./helpers.ts');
type Ran = import('../src/run.ts').Ran;
type Runner = import('../src/run.ts').Runner;
type ScmLook = import('../src/scm.ts').ScmLook;

const R = 'bitbucket.org/acme/fake';
const B = 'https://api.bitbucket.org/2.0/repositories/acme/fake';
const TOKEN = 'ATATT3x"secret\\token';
const signedIn: ScmLook = { at: '2026-10-09T00:00:00Z', tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.47', supported: true }, { cmd: 'bitbucket', name: 'Bitbucket API token', version: 'in the credential store, for api.bitbucket.org', signedIn: true, supported: true }] };

/** A pull request as GET …/pullrequests lists one: its head commit by a short hash. */
const pull = (o: Record<string, unknown> = {}) => ({ id: 7, title: 'Fake 0.4.1: A feature', description: '**A feature.**', state: 'OPEN', draft: false, author: { nickname: 'jcollier0120', display_name: 'J' }, source: { branch: { name: 'claude/feature' }, commit: { hash: 'abc123def456' }, repository: { full_name: 'acme/fake' } }, destination: { branch: { name: 'main' }, repository: { full_name: 'acme/fake' } }, links: { html: { href: 'https://bitbucket.org/acme/fake/pull-requests/7' } }, created_on: '2026-10-10T11:50:00Z', ...o });
const FULL = 'abc123def456' + '0'.repeat(28);

/** What curl prints with --write-out '\n%{http_code}': the body, then the status. */
const http = (status: number, body: unknown = {}): Ran => ({ code: 0, out: `${typeof body === 'string' ? body : JSON.stringify(body)}\n${status}`, err: '' });

/** A curl request's method, where it went below the repository, its body, and the user line of its config. */
const call = (args: string[]) => {
  const url = args[args.indexOf('--url') + 1];
  const i = args.indexOf('--data-binary');
  return {
    method: args[args.indexOf('--request') + 1],
    at: url.startsWith(B) ? url.slice(B.length) : url,
    body: i >= 0 ? JSON.parse(readFileSync(args[i + 1].replace(/^@/, ''), 'utf8')) : undefined,
    auth: readFileSync(args[args.indexOf('--config') + 1], 'utf8'),
    out: args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined,
    args,
  };
};

/** A runner whose credential store holds the token and whose curl answers `answer`; every request it made. */
function fake(answer: (c: ReturnType<typeof call>) => Ran | undefined, other?: Runner) {
  const ran: ReturnType<typeof call>[] = [];
  const asked: { cmd: string; args: string[]; input?: string; env?: Record<string, string | undefined> }[] = [];
  const run: Runner = async (cmd, args, opts) => {
    if (cmd === 'git' && args[0] === 'credential') {
      asked.push({ cmd, args, input: opts?.input, env: opts?.env });
      return { code: 0, out: `protocol=https\nhost=api.bitbucket.org\nusername=me@example.com\npassword=${TOKEN}\n`, err: '' };
    }
    if (cmd !== 'curl') return other ? other(cmd, args, opts) : { code: 1, out: '', err: `no stand-in for ${cmd}` };
    const c = call(args);
    ran.push(c);
    return answer(c) ?? http(404, { type: 'error', error: { message: `no stand-in for ${c.method} ${c.at}` } });
  };
  return { run, ran, asked };
}

function recorded(answer: (c: ReturnType<typeof call>) => Ran | undefined) {
  const f = fake(answer);
  return { ...f, host: hostFor({ run: f.run, neutralDir: tmp, host: () => 'bitbucket' }, { repo: R }) };
}

test('a repository on Bitbucket Cloud is worked with its way once its API token is in the credential store; else plain git', async () => {
  for (const url of ['https://jc@bitbucket.org/acme/fake.git', 'git@bitbucket.org:acme/fake.git']) assert.equal(repoFromUrl(url), R);
  assert.deepEqual(whereBitbucket(R), { workspace: 'acme', slug: 'fake' });
  assert.equal(whereBitbucket('bitbucket.example.com/scm/acme/fake'), null, 'Bitbucket Data Center is plain git');
  const s = { sourceControl: 'auto' as const, releasesCastellan: false };
  assert.equal(hostOf({ repo: R }, s, signedIn), 'bitbucket');
  assert.equal(hostOf({ repo: R }, s, { ...signedIn, tools: signedIn.tools.map((t) => ({ ...t, signedIn: false })) }), 'git');
  assert.equal(hostOf({ repo: R }, s, null), 'git');
  assert.equal(hostOf({ repo: R }, { ...s, sourceControl: 'git' }, signedIn), 'git');
  assert.match(autoWords(signedIn), /Bitbucket for repositories on bitbucket\.org \(its API token is in the credential store\), Git for any other/);

  // Found by asking git's credential store, with every prompt off; the token is never kept in what was found.
  const f = fake(() => undefined, async (cmd) => (cmd === 'git' ? { code: 0, out: 'git version 2.47.0', err: '' } : { code: 1, out: '', err: '' }));
  const found = await findScm(f.run);
  assert.deepEqual(found.tools.find((t) => t.cmd === 'bitbucket'), { cmd: 'bitbucket', name: 'Bitbucket API token', version: 'in the credential store, for api.bitbucket.org', signedIn: true, supported: true });
  assert.ok(!JSON.stringify(found).includes('ATATT'), 'the token is never kept');
  assert.deepEqual([f.asked[0].args, f.asked[0].input, f.asked[0].env?.GIT_TERMINAL_PROMPT, f.asked[0].env?.GCM_INTERACTIVE], [['credential', 'fill'], 'protocol=https\nhost=api.bitbucket.org\n\n', '0', 'never']);
  assert.equal(credentialOf('protocol=https\nhost=api.bitbucket.org\n'), null);
  assert.deepEqual(credentialOf('username=a@b.c\r\npassword=t\r\n'), { username: 'a@b.c', password: 't' });

  // The runner writes a command's standard input, as git credential fill reads its question.
  const echoed = await realRun('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'protocol=https\n' });
  assert.equal(echoed.out, 'protocol=https\n');
});

test("curl's answers: the status after the body, an HTTP error a failure with Bitbucket's message; the token quoted for its config", () => {
  assert.deepEqual(answered(http(200, { a: 1 })), { code: 0, out: '{"a":1}', err: '' });
  assert.deepEqual(answered(http(404, { type: 'error', error: { message: 'Repository not found' } })), { code: 1, out: '', err: 'HTTP 404: Repository not found' });
  assert.deepEqual(answered({ code: 6, out: '', err: 'curl: (6) Could not resolve host' }), { code: 6, out: '', err: 'curl: (6) Could not resolve host' });
  assert.deepEqual(answered({ code: 0, out: '\n204', err: '' }), { code: 0, out: '', err: '' });
  assert.equal(curlQuoted('a"b\\c'), 'a\\"b\\\\c');
});

test("a pull request in GitHub's words: what the Steward reads of one", () => {
  const diffstat = [{ status: 'modified', lines_added: 2, lines_removed: 1, old: { path: 'src/a.ts' }, new: { path: 'src/a.ts' } }, { status: 'added', lines_added: 1, lines_removed: 0, old: null, new: { path: 'y' } }];
  const pr = prOf(pull(), { head: FULL, diffstat, statuses: [{ key: 'ci-test', state: 'SUCCESSFUL' }, { key: 'steward/tested', state: 'SUCCESSFUL' }] });
  assert.deepEqual(pr, {
    number: 7,
    title: 'Fake 0.4.1: A feature',
    url: 'https://bitbucket.org/acme/fake/pull-requests/7',
    body: '**A feature.**',
    state: 'OPEN',
    headRefName: 'claude/feature',
    headRefOid: FULL,
    createdAt: '2026-10-10T11:50:00Z',
    baseRefName: 'main',
    isCrossRepository: false,
    author: { login: 'jcollier0120' },
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    isDraft: false,
    statusCheckRollup: [
      { __typename: 'StatusContext', context: 'ci-test', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'steward/tested', state: 'SUCCESS' },
    ],
    labels: [],
    additions: 3,
    deletions: 1,
    files: [{ path: 'src/a.ts' }, { path: 'y' }],
  });
  const [info] = parsePrs(JSON.stringify([pr]), ['Jcollier0120']);
  assert.equal(info.whose, 'team');
  assert.equal(info.checks, 'passing');
  assert.equal(prOf(pull({ source: { branch: { name: 'x' }, commit: { hash: 'a' }, repository: { full_name: 'fork/fake' } } })).isCrossRepository, true);
  assert.equal(prOf(pull({ state: 'MERGED' })).state, 'MERGED');
  assert.equal(prOf(pull({ state: 'DECLINED' })).state, 'CLOSED');
  assert.equal(prOf(pull({ draft: true })).isDraft, true);
  assert.equal(parsePrs(JSON.stringify([prOf(pull(), { statuses: [{ key: 'ci', state: 'INPROGRESS' }] })]), ['Jcollier0120'])[0].checks, 'pending');
  assert.equal(parsePrs(JSON.stringify([prOf(pull(), { statuses: [{ key: 'ci', state: 'FAILED' }] })]), ['Jcollier0120'])[0].checks, 'failing');
  assert.deepEqual(mergeStatesOf([{ status: 'merge conflict' }]), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  assert.deepEqual(mergeStatesOf(undefined), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  // Who set a build status, from its name: Bitbucket's own says nothing of it.
  assert.deepEqual((statusOf({ key: 'steward/tested', state: 'SUCCESSFUL', name: 'steward/tested by jcollier0120' }) as any).creator, { login: 'jcollier0120' });
  assert.deepEqual((statusOf({ key: 'ci', state: 'SUCCESSFUL', name: 'Pipeline #12' }) as any).creator, { login: '' });
});

test("Bitbucket's requests: curl with the token from a file of its own, bodies as JSON from a file", async () => {
  const { host, ran } = recorded(({ method, at }) => {
    if (at === `/pullrequests?state=OPEN&pagelen=50`) return http(200, { values: [pull()], next: `${B}/pullrequests?state=OPEN&pagelen=50&page=2` });
    if (at === `/pullrequests?state=OPEN&pagelen=50&page=2`) return http(200, { values: [] });
    if (at === `/pullrequests?state=DECLINED&state=SUPERSEDED&pagelen=50&q=${encodeURIComponent('source.branch.name="claude/feature"')}`) return http(200, { values: [] });
    if (at === '/commit/abc123def456') return http(200, { hash: FULL });
    if (at === '/pullrequests/7/diffstat?pagelen=500') return http(200, { values: [{ status: 'added', lines_added: 1, lines_removed: 0, new: { path: 'a.ts' } }] });
    if (at === `/commit/${FULL}/statuses?pagelen=100`) return http(200, { values: [{ key: 'ci-test', state: 'SUCCESSFUL' }] });
    if (at === `/commit/${FULL}/statuses?pagelen=100&sort=-created_on`) return http(200, { values: [{ key: 'ci-test', state: 'SUCCESSFUL', name: 'CI', updated_on: '2026-10-09T10:00:00Z' }, { key: 'steward/tested', state: 'SUCCESSFUL', name: 'steward/tested by jcollier0120', description: 'passed', updated_on: '2026-10-09T11:00:00Z' }] });
    if (at === '/pullrequests' && method === 'POST') return http(201, pull({ id: 8, links: { html: { href: 'https://bitbucket.org/acme/fake/pull-requests/8' } } }));
    if (at === '/pullrequests/7' && method === 'GET') return http(200, pull());
    if (at === '/pullrequests/7/merge') return http(200, pull({ state: 'MERGED' }));
    if (at === '/pullrequests/7/decline') return http(200, pull({ state: 'DECLINED' }));
    if (at === 'https://api.bitbucket.org/2.0/user') return http(200, { nickname: 'jcollier0120', account_id: '5f' });
    if (method !== 'GET') return http(method === 'DELETE' ? 204 : 200, method === 'DELETE' ? '' : {});
  });
  const list = JSON.parse(must(await host.listPrs(R, { state: 'open', limit: 100, fields: 'number,headRefOid,files,statusCheckRollup,mergeable' })));
  assert.deepEqual([list[0].number, list[0].headRefOid, list[0].files, list[0].statusCheckRollup.length, list[0].mergeable], [7, FULL, [{ path: 'a.ts' }], 1, 'MERGEABLE']);
  assert.deepEqual(JSON.parse(must(await host.listPrs(R, { state: 'closed', head: 'claude/feature', fields: 'number' }))), []);
  assert.equal(must(await host.createPr(R, { base: 'main', head: 'claude/x', title: 'T', body: '**B**' })), 'https://bitbucket.org/acme/fake/pull-requests/8\n');
  must(await host.editPr(R, 7, { body: 'new' }));
  must(await host.readyPr(R, 7));
  must(await host.mergePr(R, 7, { matchHead: FULL, deleteBranch: true }));
  const moved = await host.mergePr(R, 7, { matchHead: 'f'.repeat(40) });
  assert.match(moved.err, /head moved .*: not merged/);
  must(await host.closePr(R, 7, { comment: 'bye', deleteBranch: true }));
  const statuses = JSON.parse(must(await host.statuses(R, FULL)));
  must(await host.setStatus(R, FULL, { state: 'success', context: 'steward/tested', description: 'npm test passed at abc123d' }));
  assert.equal(must(await host.whoAmI()), 'jcollier0120\n');

  assert.deepEqual(statuses.map((s: any) => [s.context, s.state, s.creator.login]), [['steward/tested', 'success', 'jcollier0120'], ['ci-test', 'success', '']]);
  assert.ok(ran.every((c) => c.auth === `user = "me@example.com:${curlQuoted(TOKEN)}"\n`), 'the token from the credential store, in curl\'s config');
  assert.ok(ran.every((c) => !c.args.join(' ').includes('ATATT')), 'never on the command line');
  assert.deepEqual(ran.filter((c) => c.body).map((c) => [c.method, c.at, c.body]), [
    ['POST', '/pullrequests', { title: 'T', description: '**B**', source: { branch: { name: 'claude/x' } }, destination: { branch: { name: 'main' } } }],
    ['PUT', '/pullrequests/7', { title: 'Fake 0.4.1: A feature', description: 'new' }],
    ['PUT', '/pullrequests/7', { title: 'Fake 0.4.1: A feature', draft: false }],
    ['POST', '/pullrequests/7/merge', { type: 'pullrequest_merge_parameters', merge_strategy: 'merge_commit', close_source_branch: true }],
    ['POST', '/pullrequests/7/comments', { content: { raw: 'bye' } }],
    ['POST', `/commit/${FULL}/statuses/build`, { key: 'steward/tested', state: 'SUCCESSFUL', name: 'steward/tested by jcollier0120', description: 'npm test passed at abc123d', url: `https://bitbucket.org/acme/fake/commits/${FULL}` }],
  ]);
  assert.deepEqual(ran.filter((c) => c.method === 'DELETE').map((c) => c.at), ['/refs/branches/claude%2Ffeature']);
  assert.equal(ran.filter((c) => c.at === '/pullrequests/7/merge').length, 1, 'a moved head is never merged');
  assert.equal(host.prRef({ number: 7, head: 'claude/feature' }), 'refs/heads/claude/feature');
  assert.equal(host.releaseUrl(R, 'v0.4.1'), 'https://bitbucket.org/acme/fake/src/v0.4.1');
});

test('a branch with no open pull request says so as gh does; no token, no request', async () => {
  const { host } = recorded(() => http(200, { values: [] }));
  const a = await host.viewPr(R, 'claude/feature', 'number,state,headRefOid,isCrossRepository');
  assert.equal(a.code, 1);
  assert.match(a.err, /no pull requests found for branch "claude\/feature"/);
  const none = hostFor({ run: async () => ({ code: 128, out: '', err: 'fatal: could not read Username: terminal prompts disabled' }), neutralDir: tmp, host: () => 'bitbucket' }, { repo: R });
  assert.match((await none.listPrs(R, { state: 'open', fields: 'number' })).err, /no Bitbucket API token for api\.bitbucket\.org/);
});

test('releases are v<version> tags; a merge Bitbucket finishes later is waited for; issues are not filed', async () => {
  const { host, ran } = recorded(({ method, at }) => {
    if (at === `/refs/tags?pagelen=100&sort=-target.date&q=${encodeURIComponent('name ~ "v"')}`) return http(200, { values: [{ name: 'v0.4.0', message: 'Fake 0.4.0', target: { hash: 'c0', date: '2026-10-01T00:00:00+00:00' } }] });
    if (at === '/refs/tags/v9.9.9') return http(404, { type: 'error', error: { message: 'Tag not found' } });
    if (method === 'POST') return http(201, {});
  });
  assert.deepEqual(JSON.parse(must(await host.listReleases(R, 'tagName,isDraft,publishedAt'))), [{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-01T00:00:00+00:00', body: 'Fake 0.4.0', targetCommitish: 'c0' }]);
  assert.match((await host.viewRelease(R, 'v9.9.9', 'tagName')).err, /release not found/);
  const notes = path.join(tmp, 'notes.md');
  writeFileSync(notes, '**Fake 0.4.1.**');
  must(await host.createRelease(R, { tag: 'v0.4.1', target: FULL, title: 'Fake 0.4.1', notesFile: notes }));
  assert.deepEqual(ran.filter((c) => c.body).map((c) => [c.method, c.at, c.body]), [['POST', '/refs/tags', { name: 'v0.4.1', target: { hash: FULL }, message: 'Fake 0.4.1\n\n**Fake 0.4.1.**' }]]);
  assert.match((await host.listIssues(R, { label: 'manor:work', state: 'open', fields: 'number' })).err, /issue tracker/);
  assert.equal((await host.downloadRelease(R, 'v0.4.0', { patterns: ['*.zip'], dir: tmp })).code, 1);

  const { Bitbucket } = await import('../src/hosts/bitbucket.ts');
  const states = ['OPEN', 'OPEN', 'MERGED'];
  const later = fake(({ at }) => (at === '/pullrequests/7/merge' ? http(202, {}) : http(200, pull({ state: states.shift() }))));
  assert.equal((await new Bitbucket(later.run, tmp).mergePr(R, 7, {}, 0)).code, 0);
  assert.deepEqual(later.ran.map((c) => `${c.method} ${c.at}`), ['POST /pullrequests/7/merge', 'GET /pullrequests/7', 'GET /pullrequests/7', 'GET /pullrequests/7']);
});

test("a merge round on Bitbucket: the team's pull request, its checks passed, merged at the head it read", async () => {
  const f = fakeEmployee(path.join(tmp, 'round'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/feature');
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').split('0.4.0').join('0.4.1'));
  writeFileSync(path.join(f.checkout, 'feature.txt'), 'a feature\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'A feature');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/feature');
  sh(f.checkout, 'switch', '--quiet', 'main');

  const gh = runner();
  const short = head.slice(0, 12);
  const open = () => pull({ source: { branch: { name: 'claude/feature' }, commit: { hash: short }, repository: { full_name: 'acme/fake' } } });
  const bb = fake(({ method, at }) => {
    if (at === '/pullrequests?state=OPEN&pagelen=50') return http(200, { values: [open()] });
    if (at === '/pullrequests/7' && method === 'GET') return http(200, open());
    if (at === `/commit/${short}`) return http(200, { hash: head });
    if (at === '/pullrequests/7/diffstat?pagelen=500') return http(200, { values: [{ status: 'added', lines_added: 1, lines_removed: 0, new: { path: 'feature.txt' } }, { status: 'modified', lines_added: 1, lines_removed: 1, new: { path: 'package.json' } }] });
    if (at === `/commit/${head}/statuses?pagelen=100`) return http(200, { values: [{ key: 'ci-test', state: 'SUCCESSFUL' }] });
    if (at.startsWith('/refs/tags?')) return http(200, { values: [{ name: 'v0.4.0', target: { hash: 'c0', date: '2026-10-03T00:00:00+00:00' } }] });
    if (at === '/pullrequests/7/merge') return http(200, { ...open(), state: 'MERGED' });
    if (method === 'POST') return http(201, {});
  }, gh.run);
  // Checks that would fail, were they run here: Bitbucket's checks passed, so they aren't.
  const e = employee(f.checkout, { repo: R, fill: '', test: ['node -e process.exit(1)'] });
  const ctx = { ...ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: bb.run, neutralDir: tmp }), host: () => 'bitbucket' as const };
  const [m] = await merge(ctx, [e], { yes: true, team: true });
  assert.equal(m.outcome, 'done', `${m.message}\n${ctx.lines.join('\n')}`);
  assert.match(m.message, /merged #7/);
  assert.deepEqual(gh.gh, [], 'GitHub is never asked');
  assert.ok(bb.ran.some((c) => c.at === '/pullrequests/7/merge'), 'merged through Bitbucket');
});
