import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Azure DevOps (src/hosts/azure.ts): pull requests, commit statuses and tag releases through `az rest` to its REST API
// (7.1), said in GitHub's words, so the Steward's rounds are the same on Azure Repos. The answers below are shaped as
// Azure DevOps' REST API documents them.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-azure-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { hostFor, must } = await import('../src/hosts/index.ts');
const { mergeStatesOf, prOf, whereAzure } = await import('../src/hosts/azure.ts');
const { autoWords, hostOf, isAzureRepo, isGitlabRepo, repoFromUrl } = await import('../src/scm.ts');
const { resolveCommand } = await import('../src/run.ts');
const { merge } = await import('../src/stages/merge.ts');
const { parsePrs } = await import('../src/stages/staff.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type Ran = import('../src/run.ts').Ran;
type ScmLook = import('../src/scm.ts').ScmLook;

const R = 'dev.azure.com/acme/proj/_git/fake';
const B = 'https://dev.azure.com/acme/proj/_apis/git/repositories/fake';
const signedIn: ScmLook = { at: '2026-10-09T00:00:00Z', tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.47', supported: true }, { cmd: 'az', name: 'Azure CLI', version: 'azure-cli 2.65.0', signedIn: true, supported: true }] };

/** A pull request as GET …/pullrequests lists one. */
const pull = (o: Record<string, unknown> = {}) => ({ pullRequestId: 7, title: 'Fake 0.4.1: A feature', description: '**A feature.**', status: 'active', sourceRefName: 'refs/heads/claude/feature', targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: 'abc123' }, isDraft: false, createdBy: { uniqueName: 'jcollier0120' }, mergeStatus: 'succeeded', labels: [{ name: 'steward' }], creationDate: '2026-10-10T11:50:00Z', ...o });
const list = (value: unknown[]) => ok({ count: value.length, value });

/** A request's method and where it went, below the repository (`/pullrequests…`) or the URL whole, api-version left out. */
const call = (args: string[]) => {
  const url = args[args.indexOf('--url') + 1].replace(/[?&]api-version=7\.1$/, '');
  return [args[args.indexOf('--method') + 1].toUpperCase(), url.startsWith(B) ? url.slice(B.length) : url];
};

/** A host on Azure DevOps whose az answers `answer`, and every az command it ran, with any --body as parsed. */
function recorded(answer: (m: string, at: string) => Ran | undefined) {
  const ran: { args: string[]; body?: any }[] = [];
  const host = hostFor(
    {
      run: async (cmd, args) => {
        assert.equal(cmd, 'az');
        const i = args.indexOf('--body');
        ran.push({ args, ...(i >= 0 ? { body: JSON.parse(readFileSync(args[i + 1].replace(/^@/, ''), 'utf8')) } : {}) });
        const [m, at] = call(args);
        return answer(m, at) ?? { code: 1, out: '', err: `no stand-in for az ${args.join(' ')}` };
      },
      neutralDir: tmp,
      host: () => 'azure',
    },
    { repo: R },
  );
  return { host, ran };
}

test("a repository on Azure DevOps is worked with its way once az is signed in; else plain git", () => {
  for (const url of ['https://acme@dev.azure.com/acme/proj/_git/fake', 'git@ssh.dev.azure.com:v3/acme/proj/fake', 'https://acme.visualstudio.com/DefaultCollection/proj/_git/fake']) {
    const repo = repoFromUrl(url)!;
    assert.equal(isAzureRepo(repo), true, repo);
    assert.equal(isGitlabRepo(repo), false, repo);
    assert.deepEqual(whereAzure(repo), { base: 'https://dev.azure.com/acme', org: 'acme', project: 'proj', repo: 'fake' }, repo);
  }
  assert.deepEqual(whereAzure('dev.azure.com/acme/My%20Project/_git/fake')?.project, 'My Project');
  assert.equal(isAzureRepo('Jcollier0120/Fake'), false);
  assert.equal(whereAzure('gitlab.com/acme/fake'), null);
  const s = { sourceControl: 'auto' as const, releasesCastellan: false };
  assert.equal(hostOf({ repo: R }, s, signedIn), 'azure');
  assert.equal(hostOf({ repo: R }, s, { ...signedIn, tools: signedIn.tools.map((t) => ({ ...t, signedIn: false })) }), 'git');
  assert.equal(hostOf({ repo: R }, s, null), 'git');
  assert.equal(hostOf({ repo: R }, { ...s, sourceControl: 'git' }, signedIn), 'git');
  assert.equal(hostOf({ repo: R }, { ...s, releasesCastellan: true }, signedIn), 'github');
  assert.match(autoWords(signedIn), /Azure DevOps for repositories on Azure DevOps \(the Azure CLI is signed in\), Git for any other/);
  assert.match(autoWords({ ...signedIn, tools: signedIn.tools.map((t) => ({ ...t, signedIn: false })) }), /the Azure CLI is installed, but not signed in: az login/);
  // az on Windows is a .cmd, which execFile can't start: its own Python is, where it is installed.
  const [file, argv] = resolveCommand('az', ['rest']);
  if (process.platform === 'win32' && file !== 'az') assert.deepEqual([path.basename(file).toLowerCase(), argv], ['python.exe', ['-IBm', 'azure.cli', 'rest']]);
  else assert.deepEqual([file, argv], ['az', ['rest']]);
});

test("a pull request in GitHub's words: what the Steward reads of one", () => {
  const pr = prOf(R, pull(), { files: ['src/a.ts', 'y'], statuses: [{ context: { genre: 'ci', name: 'test' }, state: 'succeeded' }, { context: { genre: 'steward', name: 'tested' }, state: 'succeeded' }] });
  assert.deepEqual(pr, {
    number: 7,
    title: 'Fake 0.4.1: A feature',
    url: 'https://dev.azure.com/acme/proj/_git/fake/pullrequest/7',
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
    additions: 0,
    deletions: 0,
    files: [{ path: 'src/a.ts' }, { path: 'y' }],
  });
  const [info] = parsePrs(JSON.stringify([pr]), ['Jcollier0120']);
  assert.equal(info.whose, 'team');
  assert.equal(info.checks, 'passing');
  assert.equal(prOf(R, pull({ forkSource: { name: 'refs/heads/x' } })).isCrossRepository, true);
  assert.equal(prOf(R, pull({ status: 'completed' })).state, 'MERGED');
  assert.equal(prOf(R, pull({ status: 'abandoned' })).state, 'CLOSED');
  assert.equal(prOf(R, pull({ isDraft: true })).isDraft, true);
  const running = prOf(R, pull(), { statuses: [{ context: { name: 'test' }, state: 'pending' }] });
  assert.equal(parsePrs(JSON.stringify([running]), ['Jcollier0120'])[0].checks, 'pending');
  const failed = prOf(R, pull(), { statuses: [{ context: { name: 'test' }, state: 'failed' }] });
  assert.equal(parsePrs(JSON.stringify([failed]), ['Jcollier0120'])[0].checks, 'failing');

  const s = (mergeStatus?: string) => mergeStatesOf(pull({ mergeStatus }));
  assert.deepEqual(s('succeeded'), { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  assert.deepEqual(s('conflicts'), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  assert.deepEqual(s('rejectedByPolicy'), { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' });
  assert.deepEqual(s('queued'), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(s(undefined), { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
});

test("Azure DevOps' requests: az rest to the repository's organization, bodies as JSON from a file", async () => {
  const { host, ran } = recorded((m, at) => {
    if (at === '/pullrequests?searchCriteria.status=active&$top=100') return list([pull()]);
    if (at === '/pullrequests?searchCriteria.status=abandoned&$top=30&searchCriteria.sourceRefName=refs%2Fheads%2Fclaude%2Ffeature') return list([]);
    if (at === '/pullrequests/7/iterations') return list([{ id: 1 }, { id: 2 }]);
    if (at === '/pullrequests/7/iterations/2/changes?$top=1000') return ok({ changeEntries: [{ item: { path: '/a.ts' } }] });
    if (at === '/pullrequests/7/statuses') return list([{ id: 1, context: { genre: 'ci', name: 'test' }, state: 'succeeded' }]);
    if (at === '/commits/abc123/statuses?latestOnly=true') return list([{ id: 2, context: { genre: 'steward', name: 'tested' }, state: 'succeeded' }]);
    if (at === '/commits/abc123/statuses') return list([{ id: 1, context: { genre: 'ci', name: 'test' }, state: 'succeeded', creationDate: '2026-10-09T10:00:00Z', createdBy: { uniqueName: 'ci' } }, { id: 2, context: { genre: 'steward', name: 'tested' }, state: 'succeeded', description: 'passed', creationDate: '2026-10-09T11:00:00Z', createdBy: { uniqueName: 'jcollier0120' } }]);
    if (at === '/pullrequests' && m === 'POST') return ok(pull({ pullRequestId: 8 }));
    if (at === '/pullrequests/7' && m === 'PATCH') return ok(pull({ status: 'abandoned' }));
    if (at === 'https://dev.azure.com/acme/_apis/connectionData') return ok({ authenticatedUser: { properties: { Account: { $type: 'System.String', $value: 'jcollier0120' } } } });
    if (at.startsWith('/')) return ok({});
  });
  const prs = JSON.parse(must(await host.listPrs(R, { state: 'open', limit: 100, fields: 'number,files,statusCheckRollup' })));
  assert.deepEqual([prs[0].number, prs[0].files, prs[0].statusCheckRollup.map((c: any) => c.context)], [7, [{ path: 'a.ts' }], ['ci/test', 'steward/tested']]);
  assert.deepEqual(JSON.parse(must(await host.listPrs(R, { state: 'closed', head: 'claude/feature', fields: 'number,headRefOid' }))), []);
  assert.equal(must(await host.createPr(R, { base: 'main', head: 'claude/x', title: 'T', body: '**B**' })), 'https://dev.azure.com/acme/proj/_git/fake/pullrequest/8\n');
  await host.readyPr(R, 7);
  await host.mergePr(R, 7, { matchHead: 'abc123', deleteBranch: true });
  await host.closePr(R, 7, { comment: 'bye', deleteBranch: true });
  const statuses = JSON.parse(must(await host.statuses(R, 'abc123')));
  await host.setStatus(R, 'abc123', { state: 'success', context: 'steward/tested', description: 'npm test passed at abc123' });
  assert.equal(must(await host.whoAmI()), 'jcollier0120\n');

  assert.deepEqual(statuses.map((s: any) => [s.context, s.state, s.creator.login]), [['steward/tested', 'success', 'jcollier0120'], ['ci/test', 'success', 'ci']]);
  assert.ok(ran.every((r) => r.args[0] === 'rest' && r.args[r.args.indexOf('--resource') + 1] === '499b84ac-1321-427f-aa17-267ca6975798'));
  assert.ok(ran.filter((r) => r.args[r.args.indexOf('--url') + 1].startsWith(B)).every((r) => r.args[r.args.indexOf('--url') + 1].endsWith('api-version=7.1')));
  assert.deepEqual(ran.filter((r) => r.body).map((r) => [...call(r.args), r.body]), [
    ['POST', '/pullrequests', { sourceRefName: 'refs/heads/claude/x', targetRefName: 'refs/heads/main', title: 'T', description: '**B**' }],
    ['PATCH', '/pullrequests/7', { isDraft: false }],
    ['PATCH', '/pullrequests/7', { status: 'completed', lastMergeSourceCommit: { commitId: 'abc123' }, completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: true } }],
    ['POST', '/pullrequests/7/threads', { comments: [{ parentCommentId: 0, content: 'bye', commentType: 1 }], status: 'closed' }],
    ['PATCH', '/pullrequests/7', { status: 'abandoned' }],
    ['POST', '/refs', [{ name: 'refs/heads/claude/feature', oldObjectId: 'abc123', newObjectId: '0000000000000000000000000000000000000000' }]],
    ['POST', '/commits/abc123/statuses', { state: 'succeeded', description: 'npm test passed at abc123', context: { genre: 'steward', name: 'tested' } }],
  ]);
  // No pull request head ref on Azure DevOps: its branch is fetched.
  assert.equal(host.prRef({ number: 7, head: 'claude/feature' }), 'refs/heads/claude/feature');
  assert.equal(host.releaseUrl(R, 'v0.4.1'), 'https://dev.azure.com/acme/proj/_git/fake?version=GTv0.4.1');
});

test('a branch with no active pull request says so as gh does, so steward vouch vouches for the branch', async () => {
  const { host } = recorded(() => list([]));
  const a = await host.viewPr(R, 'claude/feature', 'number,state,headRefOid,isCrossRepository');
  assert.equal(a.code, 1);
  assert.match(a.err, /no pull requests found for branch "claude\/feature"/);
});

test('releases are v<version> tags; issues are not filed on Azure DevOps yet', async () => {
  const { host, ran } = recorded((m, at) => {
    if (at === '/refs?filter=tags/v&peelTags=true') return list([{ name: 'refs/tags/v0.4.0', objectId: 't0', peeledObjectId: 'c0' }]);
    if (at === '/refs?filter=tags%2Fv0.4.0&peelTags=true') return list([{ name: 'refs/tags/v0.4.0', objectId: 't0', peeledObjectId: 'c0' }]);
    if (m === 'POST') return ok({});
  });
  assert.deepEqual(JSON.parse(must(await host.listReleases(R, 'tagName,isDraft,publishedAt'))), [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null, body: '', targetCommitish: 'c0' }]);
  assert.equal(JSON.parse(must(await host.viewRelease(R, 'v0.4.0', 'targetCommitish'))).targetCommitish, 'c0');
  const notes = path.join(tmp, 'notes.md');
  writeFileSync(notes, '**Fake 0.4.1.**');
  must(await host.createRelease(R, { tag: 'v0.4.1', target: 'abc', title: 'Fake 0.4.1', notesFile: notes }));
  assert.deepEqual(ran.filter((r) => r.body).map((r) => [...call(r.args), r.body]), [['POST', '/annotatedtags', { name: 'v0.4.1', taggedObject: { objectId: 'abc' }, message: 'Fake 0.4.1\n\n**Fake 0.4.1.**' }]]);
  const issues = await host.listIssues(R, { label: 'manor:work', state: 'open', fields: 'number' });
  assert.equal(issues.code, 1);
  assert.match(issues.err, /work items/);
  assert.equal((await host.downloadRelease(R, 'v0.4.0', { patterns: ['*.zip'], dir: tmp })).code, 1);
});

test("a merge round on Azure DevOps: the team's pull request, its checks passed, completed at the head it read", async () => {
  const f = fakeEmployee(path.join(tmp, 'round'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/feature');
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').split('0.4.0').join('0.4.1'));
  writeFileSync(path.join(f.checkout, 'feature.txt'), 'a feature\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'A feature');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/feature');
  sh(f.checkout, 'switch', '--quiet', 'main');

  const az: { args: string[]; body?: any }[] = [];
  const gh = runner();
  const run = async (cmd: string, args: string[], opts?: any): Promise<Ran> => {
    if (cmd !== 'az') return gh.run(cmd, args, opts);
    const i = args.indexOf('--body');
    az.push({ args, ...(i >= 0 ? { body: JSON.parse(readFileSync(args[i + 1].replace(/^@/, ''), 'utf8')) } : {}) });
    const [m, at] = call(args);
    if (at === '/pullrequests?searchCriteria.status=active&$top=100') return list([pull({ lastMergeSourceCommit: { commitId: head } })]);
    if (at === '/pullrequests/7/iterations') return list([{ id: 1 }]);
    if (at === '/pullrequests/7/iterations/1/changes?$top=1000') return ok({ changeEntries: [{ item: { path: '/feature.txt' } }, { item: { path: '/package.json' } }] });
    if (at === '/pullrequests/7/statuses') return list([]);
    if (at === `/commits/${head}/statuses?latestOnly=true`) return list([{ id: 1, context: { genre: 'ci', name: 'test' }, state: 'succeeded' }]);
    if (at === '/refs?filter=tags/v&peelTags=true') return list([{ name: 'refs/tags/v0.4.0', objectId: 't0', peeledObjectId: 'c0' }]);
    if (m === 'PATCH' && at === '/pullrequests/7') return ok(pull({ status: 'completed', lastMergeSourceCommit: { commitId: head } }));
    if (m === 'POST') return ok({});
    return { code: 1, out: '', err: `404 Not Found: ${m} ${at}` };
  };
  // Checks that would fail, were they run here: Azure DevOps' checks passed, so they aren't.
  const e = employee(f.checkout, { repo: R, fill: '', test: ['node -e process.exit(1)'] });
  const ctx = { ...ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run, neutralDir: tmp }), host: () => 'azure' as const };
  const [m] = await merge(ctx, [e], { yes: true, team: true });
  assert.equal(m.outcome, 'done', `${m.message}\n${ctx.lines.join('\n')}`);
  assert.match(m.message, /merged #7/);
  assert.deepEqual(gh.gh, [], 'GitHub is never asked');
  const completed = az.find((a) => call(a.args)[0] === 'PATCH' && call(a.args)[1] === '/pullrequests/7');
  assert.ok(completed, 'completed through Azure DevOps');
  assert.deepEqual(completed.body.lastMergeSourceCommit, { commitId: head });
});

test('completing waits for Azure DevOps to finish; a policy that holds it is a failure', async () => {
  const { AzureDevOps } = await import('../src/hosts/azure.ts');
  const answers = (...prs: Record<string, unknown>[]) => {
    const asked: string[] = [];
    const host = new AzureDevOps(async (_cmd, args) => (asked.push(call(args).join(' ')), ok(pull(prs.shift() ?? {}))), tmp, 'https://dev.azure.com/acme');
    return { host, asked };
  };
  const queued = answers({ mergeStatus: 'queued' }, { mergeStatus: 'queued' }, { status: 'completed' });
  assert.equal((await queued.host.mergePr(R, 7, { matchHead: 'abc123' }, 0)).code, 0);
  assert.deepEqual(queued.asked, ['PATCH /pullrequests/7', 'GET /pullrequests/7', 'GET /pullrequests/7']);
  const held = await answers({ mergeStatus: 'rejectedByPolicy' }).host.mergePr(R, 7, { matchHead: 'abc123' }, 0);
  assert.equal(held.code, 1);
  assert.match(held.err, /wasn't completed: rejectedByPolicy/);
  const slow = await answers(...Array.from({ length: 20 }, () => ({ mergeStatus: 'queued' }))).host.mergePr(R, 7, { matchHead: 'abc123' }, 0);
  assert.match(slow.err, /still being completed/);
});
