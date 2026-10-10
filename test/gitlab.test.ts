import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// GitLab (src/hosts/gitlab.ts): merge requests, commit statuses, releases and issues through glab's REST API, said in
// GitHub's words, so the Steward's rounds are the same on GitLab. The answers below are shaped as GitLab's API v4
// documents them.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-gitlab-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { hostFor, must } = await import('../src/hosts/index.ts');
const { mergeStatesOf, prOf, undraft, whereIs } = await import('../src/hosts/gitlab.ts');
const { autoWords, hostOf, isGitlabRepo } = await import('../src/scm.ts');
const { merge } = await import('../src/stages/merge.ts');
const { parsePrs } = await import('../src/stages/staff.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type Ran = import('../src/run.ts').Ran;
type ScmLook = import('../src/scm.ts').ScmLook;

const R = 'gitlab.com/acme/fake';
const P = 'projects/acme%2Ffake';
const signedIn: ScmLook = { at: '2026-10-09T00:00:00Z', tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.47', supported: true }, { cmd: 'glab', name: 'GitLab CLI', version: 'glab 1.50.0', signedIn: true, supported: true }] };

/** A merge request as GET /projects/:id/merge_requests lists one. */
const mr = (o: Record<string, unknown> = {}) => ({ id: 901, iid: 7, project_id: 42, title: 'Fake 0.4.1: A feature', description: '**A feature.**', state: 'opened', source_branch: 'claude/feature', target_branch: 'main', source_project_id: 42, target_project_id: 42, author: { username: 'jcollier0120' }, draft: false, work_in_progress: false, labels: ['steward'], sha: 'abc123', detailed_merge_status: 'mergeable', has_conflicts: false, merge_status: 'can_be_merged', web_url: 'https://gitlab.com/acme/fake/-/merge_requests/7', created_at: '2026-10-10T11:50:00Z', ...o });

/** A host on GitLab whose glab answers `answer`, and every glab command it ran, with any --input body as parsed. */
function recorded(answer: (args: string[]) => Ran | undefined) {
  const ran: { args: string[]; body?: any }[] = [];
  const host = hostFor(
    {
      run: async (cmd, args) => {
        assert.equal(cmd, 'glab');
        const i = args.indexOf('--input');
        ran.push({ args, ...(i >= 0 ? { body: JSON.parse(readFileSync(args[i + 1], 'utf8')) } : {}) });
        return answer(args) ?? { code: 1, out: '', err: `no stand-in for glab ${args.join(' ')}` };
      },
      neutralDir: tmp,
      host: () => 'gitlab',
    },
    { repo: R },
  );
  return { host, ran };
}
const call = (r: { args: string[] }) => [r.args.includes('-X') ? r.args[r.args.indexOf('-X') + 1] : 'GET', r.args[1]];

test('a repository on GitLab is worked with GitLab\'s way once glab is signed in; else plain git', () => {
  assert.equal(isGitlabRepo('gitlab.com/acme/fake'), true);
  assert.equal(isGitlabRepo('gitlab.example.com/team/sub/app'), true);
  assert.equal(isGitlabRepo('Jcollier0120/Fake'), false);
  assert.equal(isGitlabRepo('dev.azure.com/org/project/_git/app'), false);
  const s = { sourceControl: 'auto' as const, releasesCastellan: false };
  assert.equal(hostOf({ repo: R }, s, signedIn), 'gitlab');
  assert.equal(hostOf({ repo: R }, s, { ...signedIn, tools: signedIn.tools.map((t) => ({ ...t, signedIn: false })) }), 'git');
  assert.equal(hostOf({ repo: R }, s, null), 'git');
  assert.equal(hostOf({ repo: R }, { ...s, sourceControl: 'git' }, signedIn), 'git');
  assert.equal(hostOf({ repo: 'Jcollier0120/Fake' }, s, signedIn), 'git');
  assert.match(autoWords(signedIn), /GitLab for repositories on GitLab \(the GitLab CLI is signed in\), Git for any other/);
  assert.deepEqual(whereIs('gitlab.example.com/team/sub/app'), { hostname: 'gitlab.example.com', project: 'team/sub/app' });
});

test("a merge request in GitHub's words: what the Steward reads of a pull request", () => {
  const pr = prOf(mr(), { diffs: [{ new_path: 'src/a.ts', diff: '@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n' }, { old_path: 'x', new_path: 'y', diff: '' }], statuses: [{ name: 'test', status: 'success' }, { name: 'steward/tested', status: 'success' }] });
  assert.deepEqual(pr, {
    number: 7,
    title: 'Fake 0.4.1: A feature',
    url: 'https://gitlab.com/acme/fake/-/merge_requests/7',
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
      { __typename: 'StatusContext', context: 'test', state: 'SUCCESS' },
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
  assert.equal(prOf(mr({ source_project_id: 43 })).isCrossRepository, true);
  assert.equal(prOf(mr({ state: 'merged' })).state, 'MERGED');
  assert.equal(prOf(mr({ draft: true })).isDraft, true);
  const running = prOf(mr(), { statuses: [{ name: 'test', status: 'running' }] });
  assert.equal(parsePrs(JSON.stringify([running]), ['Jcollier0120'])[0].checks, 'pending');
  const failed = prOf(mr(), { statuses: [{ name: 'test', status: 'failed' }] });
  assert.equal(parsePrs(JSON.stringify([failed]), ['Jcollier0120'])[0].checks, 'failing');
});

test('whether GitLab can merge it, as GitHub would say', () => {
  const s = (o: Record<string, unknown>) => mergeStatesOf(mr(o));
  assert.deepEqual(s({}), { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  assert.deepEqual(s({ has_conflicts: true, detailed_merge_status: 'conflict' }), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  assert.deepEqual(s({ detailed_merge_status: 'need_rebase' }), { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' });
  assert.deepEqual(s({ detailed_merge_status: 'checking' }), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(s({ detailed_merge_status: undefined, merge_status: 'unchecked' }), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(s({ detailed_merge_status: 'not_approved' }), { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' });
  assert.deepEqual(s({ detailed_merge_status: 'ci_still_running' }), { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' });
  assert.equal(undraft('Draft: Fake 0.4.1'), 'Fake 0.4.1');
  assert.equal(undraft('[Draft] Fake 0.4.1'), 'Fake 0.4.1');
  assert.equal(undraft('WIP: Fake'), 'Fake');
  assert.equal(undraft('Fake: Draft: stays'), 'Fake: Draft: stays');
});

test("GitLab's requests: glab api to the repository's own GitLab, bodies as JSON from a file", async () => {
  const { host, ran } = recorded((args) => {
    const [m, at] = call({ args });
    if (at === `${P}/merge_requests?state=opened&per_page=100`) return ok([mr()]);
    if (at === `${P}/merge_requests?state=closed&per_page=30&source_branch=claude%2Ffeature`) return ok([]);
    if (at === `${P}/merge_requests/7/diffs?per_page=100`) return ok([{ new_path: 'a.ts', diff: '+a\n' }]);
    if (at === `${P}/repository/commits/abc123/statuses?per_page=100`) return ok([{ id: 1, name: 'test', status: 'success', created_at: '2026-10-09T10:00:00Z', author: { username: 'ci' } }, { id: 2, name: 'steward/tested', status: 'success', description: 'passed', created_at: '2026-10-09T11:00:00Z', author: { username: 'jcollier0120' } }]);
    if (at === `${P}/merge_requests` && m === 'POST') return ok({ iid: 8, web_url: 'https://gitlab.com/acme/fake/-/merge_requests/8' });
    if (at === `${P}/merge_requests/7` && m === 'GET') return ok(mr({ title: 'Draft: Fake 0.4.1' }));
    if (at === `${P}/merge_requests/7` && m === 'PUT') return ok(mr({ state: 'closed' }));
    if (at.startsWith(`${P}/`)) return ok({});
    if (at === 'user') return ok({ username: 'jcollier0120' });
  });
  const list = JSON.parse(must(await host.listPrs(R, { state: 'open', limit: 100, fields: 'number,files,statusCheckRollup' })));
  assert.deepEqual([list[0].number, list[0].files, list[0].statusCheckRollup.length], [7, [{ path: 'a.ts' }], 2]);
  assert.deepEqual(JSON.parse(must(await host.listPrs(R, { state: 'closed', head: 'claude/feature', fields: 'number,headRefOid' }))), []);
  assert.equal(must(await host.createPr(R, { base: 'main', head: 'claude/x', title: 'T', body: '**B**' })), 'https://gitlab.com/acme/fake/-/merge_requests/8\n');
  await host.readyPr(R, 7);
  await host.mergePr(R, 7, { matchHead: 'abc123', deleteBranch: true });
  await host.closePr(R, 7, { comment: 'bye', deleteBranch: true });
  const statuses = JSON.parse(must(await host.statuses(R, 'abc123')));
  await host.setStatus(R, 'abc123', { state: 'success', context: 'steward/tested', description: 'npm test passed at abc123' });
  assert.equal(must(await host.whoAmI()), 'jcollier0120\n');

  assert.deepEqual(statuses.map((s: any) => [s.context, s.state, s.creator.login]), [['steward/tested', 'success', 'jcollier0120'], ['test', 'success', 'ci']]);
  assert.ok(ran.every((r) => r.args[0] === 'api' && r.args[r.args.indexOf('--hostname') + 1] === 'gitlab.com'));
  const writes = ran.filter((r) => r.body).map((r) => [...call(r), r.body]);
  assert.deepEqual(writes, [
    ['POST', `${P}/merge_requests`, { source_branch: 'claude/x', target_branch: 'main', title: 'T', description: '**B**' }],
    ['PUT', `${P}/merge_requests/7`, { title: 'Fake 0.4.1' }],
    ['PUT', `${P}/merge_requests/7/merge`, { sha: 'abc123', should_remove_source_branch: true }],
    ['POST', `${P}/merge_requests/7/notes`, { body: 'bye' }],
    ['PUT', `${P}/merge_requests/7`, { state_event: 'close' }],
    ['POST', `${P}/statuses/abc123`, { state: 'success', name: 'steward/tested', description: 'npm test passed at abc123' }],
  ]);
  assert.deepEqual(call(ran.find((r) => r.args.includes('DELETE'))!), ['DELETE', `${P}/repository/branches/claude%2Ffeature`]);
  assert.equal(host.prRef({ number: 7, head: 'x' }), 'refs/merge-requests/7/head');
  assert.equal(host.releaseUrl(R, 'v0.4.1'), 'https://gitlab.com/acme/fake/-/releases/v0.4.1');
});

test("a branch with no open merge request says so as gh does, so steward vouch vouches for the branch", async () => {
  const { host } = recorded(() => ok([]));
  const a = await host.viewPr(R, 'claude/feature', 'number,state,headRefOid,isCrossRepository');
  assert.equal(a.code, 1);
  assert.match(a.err, /no pull requests found for branch "claude\/feature"/);
});

test('releases and issues in GitHub\'s words', async () => {
  const { host, ran } = recorded((args) => {
    const [m, at] = call({ args });
    if (at === `${P}/releases?per_page=100`) return ok([{ tag_name: 'v0.4.0', name: 'Fake 0.4.0', released_at: '2026-10-01T00:00:00Z', description: 'First', commit: { id: 'c0' } }]);
    if (at === `${P}/issues?labels=manor%3Awork&state=opened&per_page=100`) return ok([{ iid: 3, title: 'Bump', web_url: 'https://gitlab.com/acme/fake/-/issues/3', description: '<!-- steward:work:x -->' }]);
    if (m !== 'GET') return ok({ web_url: 'https://gitlab.com/acme/fake/-/issues/4' });
  });
  assert.deepEqual(JSON.parse(must(await host.listReleases(R, 'tagName,isDraft,publishedAt'))), [{ tagName: 'v0.4.0', name: 'Fake 0.4.0', isDraft: false, publishedAt: '2026-10-01T00:00:00Z', body: 'First', targetCommitish: 'c0' }]);
  assert.deepEqual(JSON.parse(must(await host.listIssues(R, { label: 'manor:work', state: 'open', fields: 'number,url,body' }))), [{ number: 3, title: 'Bump', url: 'https://gitlab.com/acme/fake/-/issues/3', body: '<!-- steward:work:x -->' }]);
  const notes = path.join(tmp, 'notes.md');
  writeFileSync(notes, '**Fake 0.4.1.**');
  await host.createRelease(R, { tag: 'v0.4.1', target: 'abc', title: 'Fake 0.4.1', notesFile: notes });
  await host.closeIssue(R, 3, { reason: 'not planned', comment: 'superseded' });
  await host.createLabel(R, 'manor:work', { color: '1d76db', description: 'Queued for the Wright' });
  assert.deepEqual(ran.filter((r) => r.body).map((r) => [...call(r), r.body]), [
    ['POST', `${P}/releases`, { tag_name: 'v0.4.1', ref: 'abc', name: 'Fake 0.4.1', description: '**Fake 0.4.1.**' }],
    ['POST', `${P}/issues/3/notes`, { body: 'superseded' }],
    ['PUT', `${P}/issues/3`, { state_event: 'close' }],
    ['POST', `${P}/labels`, { name: 'manor:work', color: '#1d76db', description: 'Queued for the Wright' }],
  ]);
});

test("a merge round on GitLab: the team's merge request, its pipeline passed, merged at the head it read", async () => {
  const f = fakeEmployee(path.join(tmp, 'round'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/feature');
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').split('0.4.0').join('0.4.1'));
  writeFileSync(path.join(f.checkout, 'feature.txt'), 'a feature\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'A feature');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/feature');
  sh(f.origin, 'update-ref', 'refs/merge-requests/7/head', head);
  sh(f.checkout, 'switch', '--quiet', 'main');

  const glab: string[][] = [];
  const gh = runner();
  const run = async (cmd: string, args: string[], opts?: any): Promise<Ran> => {
    if (cmd !== 'glab') return gh.run(cmd, args, opts);
    glab.push(args);
    const [m, at] = call({ args });
    if (at === `${P}/merge_requests?state=opened&per_page=100`) return ok([mr({ sha: head })]);
    if (at === `${P}/merge_requests/7/diffs?per_page=100`) return ok([{ new_path: 'feature.txt', diff: '+a feature\n' }, { new_path: 'package.json', diff: '-  "version": "0.4.0",\n+  "version": "0.4.1",\n' }]);
    if (at === `${P}/repository/commits/${head}/statuses?per_page=100`) return ok([{ id: 1, name: 'test', status: 'success', author: { username: 'ci' } }]);
    if (at === `${P}/releases?per_page=100`) return ok([{ tag_name: 'v0.4.0', released_at: '2026-10-03T00:00:00Z', commit: { id: 'c0' } }]);
    if (m === 'PUT' && at === `${P}/merge_requests/7/merge`) return ok(mr({ state: 'merged', sha: head }));
    if (m === 'POST') return ok({});
    return { code: 1, out: '', err: `404 Not Found: ${m} ${at}` };
  };
  // Checks that would fail, were they run here: GitLab's pipeline passed, so they aren't.
  const e = employee(f.checkout, { repo: R, fill: '', test: ['node -e process.exit(1)'] });
  const ctx = { ...ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run, neutralDir: tmp }), host: () => 'gitlab' as const };
  const [m] = await merge(ctx, [e], { yes: true, team: true });
  assert.equal(m.outcome, 'done', `${m.message}\n${ctx.lines.join('\n')}`);
  assert.match(m.message, /merged #7/);
  assert.deepEqual(gh.gh, [], 'GitHub is never asked');
  const merged = glab.find((a) => call({ args: a })[1] === `${P}/merge_requests/7/merge`)!;
  assert.ok(merged, 'merged through GitLab');
  const i = merged.indexOf('--input');
  assert.ok(i > 0);
});
