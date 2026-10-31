import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Azure DevOps (src/hosts/azure.ts): pull requests through `az repos pr`, their iterations, statuses and comments, commit
// statuses, refs and annotated tags through `az devops invoke` (the REST API, 7.1), said in GitHub's words, so the
// Steward's rounds are the same on Azure Repos. The answers below are shaped as Azure DevOps' REST API documents them.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-azure-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { hostFor, must } = await import('../src/hosts/index.ts');
const { AzureDevOps, NO_EXTENSION, mergeStatesOf, prOf, refused, whereAzure } = await import('../src/hosts/azure.ts');
const { autoWords, hostOf, isAzureRepo, isGitlabRepo, repoFromUrl } = await import('../src/scm.ts');
const { resolveCommand } = await import('../src/run.ts');
const { parsePrs } = await import('../src/stages/staff.ts');
const { ok } = await import('./helpers.ts');
type Ran = import('../src/run.ts').Ran;
type ScmLook = import('../src/scm.ts').ScmLook;

const R = 'dev.azure.com/acme/proj/_git/fake';
const ORG = 'https://dev.azure.com/acme';
const signedIn: ScmLook = { at: '2026-10-09T00:00:00Z', tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.47', supported: true }, { cmd: 'az', name: 'Azure CLI', version: 'azure-cli 2.65.0', signedIn: true, supported: true }] };

/** A pull request as az repos pr shows one (the REST API's GitPullRequest). */
const pull = (o: Record<string, unknown> = {}) => ({ pullRequestId: 7, title: 'Fake 0.4.1: A feature', description: '**A feature.**', status: 'active', sourceRefName: 'refs/heads/claude/feature', targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: 'abc123' }, isDraft: false, createdBy: { uniqueName: 'jcollier0120' }, mergeStatus: 'succeeded', labels: [{ name: 'steward' }], creationDate: '2026-10-10T11:50:00Z', repository: { id: 'r-1', name: 'fake', project: { id: 'p-1', name: 'proj' } }, ...o });
const list = (value: unknown[]) => ok({ count: value.length, value });

const opt = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
/** The words after an option, up to the next option. */
const words = (args: string[], name: string) => {
  const i = args.indexOf(name);
  const end = args.findIndex((a, j) => j > i && a.startsWith('--'));
  return i < 0 ? [] : args.slice(i + 1, end < 0 ? undefined : end);
};
/**
 * What an az command asked, in short: "pr show 7", "pr update 7 completed", "pr list active refs/heads/x", "GET statuses
 * commitId=abc123 latestOnly=true" (its route below the repository, then its query), "account show".
 */
const call = (args: string[]) => {
  if (args[0] === 'repos') return ['pr', args[2], opt(args, '--id'), opt(args, '--status'), args[2] === 'list' ? opt(args, '--source-branch') : undefined].filter(Boolean).join(' ');
  if (args[0] === 'devops') return [opt(args, '--http-method'), opt(args, '--resource'), ...words(args, '--route-parameters').slice(2), ...words(args, '--query-parameters')].join(' ');
  return args.slice(0, 2).join(' ');
};

/** A host on Azure DevOps whose az answers `answer`, and every az command it ran, with the texts it read from files. */
function recorded(answer: (at: string, args: string[]) => Ran | undefined) {
  const ran: { args: string[]; at: string; body?: any; texts?: Record<string, string> }[] = [];
  const host = hostFor(
    {
      run: async (cmd, args) => {
        assert.equal(cmd, 'az');
        const at = call(args);
        const file = opt(args, '--in-file');
        const texts = Object.fromEntries(['--title', '--description'].filter((o) => opt(args, o)?.startsWith('@')).map((o) => [o.slice(2), readFileSync(opt(args, o)!.slice(1), 'utf8')]));
        ran.push({ args, at, ...(file ? { body: JSON.parse(readFileSync(file, 'utf8')) } : {}), ...(Object.keys(texts).length ? { texts } : {}) });
        return answer(at, args) ?? { code: 1, out: '', err: `no stand-in for az ${args.join(' ')}` };
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
    assert.deepEqual(whereAzure(repo), { base: ORG, org: 'acme', project: 'proj', repo: 'fake' }, repo);
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
  // az on Windows is a .cmd, which execFile can't start: its own Python is, where it is installed, in UTF-8 (-I leaves
  // out PYTHONUTF8 and PYTHONIOENCODING, and a page with "∞" stopped az on the PC's code page).
  const [file, argv] = resolveCommand('az', ['account', 'show']);
  if (process.platform === 'win32' && file !== 'az') assert.deepEqual([path.basename(file).toLowerCase(), argv], ['python.exe', ['-IB', '-X', 'utf8', '-m', 'azure.cli', 'account', 'show']]);
  else assert.deepEqual([file, argv], ['az', ['account', 'show']]);
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

test("Azure DevOps' requests: pull requests by az repos pr, the rest by az devops invoke in the repository's route, texts from files", async () => {
  const { host, ran } = recorded((at) => {
    if (at === 'pr list active') return ok([pull()]);
    if (at === 'pr list abandoned refs/heads/claude/feature') return ok([]);
    if (at === 'GET pullRequestIterations pullRequestId=7') return list([{ id: 1 }, { id: 2 }]);
    if (at === 'GET pullRequestIterationChanges pullRequestId=7 iterationId=2 $top=1000') return ok({ changeEntries: [{ item: { path: '/a.ts' } }] });
    if (at === 'GET pullRequestStatuses pullRequestId=7') return list([{ id: 1, context: { genre: 'ci', name: 'test' }, state: 'succeeded' }]);
    if (at === 'GET statuses commitId=abc123 latestOnly=true') return list([{ id: 2, context: { genre: 'steward', name: 'tested' }, state: 'succeeded' }]);
    if (at === 'GET statuses commitId=abc123') return list([{ id: 1, context: { genre: 'ci', name: 'test' }, state: 'succeeded', creationDate: '2026-10-09T10:00:00Z', createdBy: { uniqueName: 'ci' } }, { id: 2, context: { genre: 'steward', name: 'tested' }, state: 'succeeded', description: 'passed', creationDate: '2026-10-09T11:00:00Z', createdBy: { uniqueName: 'jcollier0120' } }]);
    if (at === 'pr create') return ok(pull({ pullRequestId: 8 }));
    if (at === 'pr show 7') return ok(pull());
    if (at === 'pr update 7 completed') return ok(pull({ status: 'completed' }));
    if (at === 'pr update 7 abandoned') return ok(pull({ status: 'abandoned' }));
    if (at === 'pr update 7') return ok(pull({ title: 'Fake 0.4.2: A feature' }));
    if (at === 'account show') return ok('Jcollier0120@example.com\n');
    if (at.startsWith('POST ')) return ok({});
  });
  const prs = JSON.parse(must(await host.listPrs(R, { state: 'open', limit: 100, fields: 'number,files,statusCheckRollup' })));
  assert.deepEqual([prs[0].number, prs[0].files, prs[0].statusCheckRollup.map((c: any) => c.context)], [7, [{ path: 'a.ts' }], ['ci/test', 'steward/tested']]);
  assert.deepEqual(JSON.parse(must(await host.listPrs(R, { state: 'closed', head: 'claude/feature', fields: 'number,headRefOid' }))), []);
  assert.equal(must(await host.createPr(R, { base: 'main', head: 'claude/x', title: 'T: @x=@y', body: '**B**\n\n- ünïcode ∞' })), 'https://dev.azure.com/acme/proj/_git/fake/pullrequest/8\n');
  must(await host.editPr(R, 7, { title: 'Fake 0.4.2: A feature' }));
  must(await host.mergePr(R, 7, { matchHead: 'abc123', deleteBranch: true }));
  must(await host.closePr(R, 7, { comment: 'bye', deleteBranch: true }));
  const statuses = JSON.parse(must(await host.statuses(R, 'abc123')));
  must(await host.setStatus(R, 'abc123', { state: 'success', context: 'steward/tested', description: 'npm test passed at abc123' }));
  assert.equal(must(await host.whoAmI()), 'Jcollier0120@example.com\n');
  assert.deepEqual(statuses.map((s: any) => [s.context, s.state, s.creator.login]), [['steward/tested', 'success', 'jcollier0120'], ['ci/test', 'success', 'ci']]);

  // Each pull request asked by its number is shown first: Azure DevOps numbers them across the organization.
  assert.deepEqual(ran.slice(6).map((r) => r.at), ['pr create', 'pr show 7', 'pr update 7', 'pr show 7', 'pr update 7 completed', 'pr show 7', 'POST pullRequestThreads pullRequestId=7', 'pr update 7 abandoned', 'POST refs', 'GET statuses commitId=abc123', 'POST statuses commitId=abc123', 'account show']);
  for (const { args } of ran.filter((r) => r.args[0] === 'repos')) {
    assert.deepEqual([opt(args, '--org'), opt(args, '--detect'), opt(args, '--output')], [ORG, 'false', 'json'], args.join(' '));
    // list and create name the repository; show and update take a number alone, which is the organization's.
    assert.deepEqual([opt(args, '--project'), opt(args, '--repository')], args[2] === 'list' || args[2] === 'create' ? ['proj', 'fake'] : [undefined, undefined], args.join(' '));
  }
  for (const { args } of ran.filter((r) => r.args[0] === 'devops')) {
    assert.deepEqual([opt(args, '--org'), opt(args, '--area'), words(args, '--route-parameters').slice(0, 2), opt(args, '--api-version'), opt(args, '--detect')], [ORG, 'git', ['project=proj', 'repositoryId=fake'], '7.1', 'false'], args.join(' '));
  }
  assert.deepEqual(ran.find((r) => r.at === 'pr update 7 completed')!.args.slice(3, 11), ['--id', '7', '--status', 'completed', '--squash', 'false', '--delete-source-branch', 'true']);
  assert.deepEqual(words(ran.find((r) => r.at === 'pr create')!.args, '--source-branch').concat(words(ran.find((r) => r.at === 'pr create')!.args, '--target-branch')), ['refs/heads/claude/x', 'refs/heads/main']);
  // A text is never on az's command line: a title, a description or a body is read from a file, so az's @file and = are
  // never applied to it, and a character the PC's code page hasn't reaches Azure DevOps as it is.
  assert.ok(ran.every((r) => r.args.every((a) => !/bye|\*\*B\*\*|T: @x|steward\/tested|npm test passed/.test(a))));
  assert.deepEqual(ran.filter((r) => r.texts).map((r) => [r.at, r.texts]), [
    ['pr create', { title: 'T: @x=@y', description: '**B**\n\n- ünïcode ∞' }],
    ['pr update 7', { title: 'Fake 0.4.2: A feature' }],
  ]);
  assert.deepEqual(ran.filter((r) => r.body).map((r) => [r.at, r.body]), [
    ['POST pullRequestThreads pullRequestId=7', { comments: [{ parentCommentId: 0, content: 'bye', commentType: 1 }], status: 'closed' }],
    ['POST refs', [{ name: 'refs/heads/claude/feature', oldObjectId: 'abc123', newObjectId: '0000000000000000000000000000000000000000' }]],
    ['POST statuses commitId=abc123', { state: 'succeeded', description: 'npm test passed at abc123', context: { genre: 'steward', name: 'tested' } }],
  ]);
  assert.ok(ran.filter((r) => r.body).every((r) => opt(r.args, '--encoding') === 'utf-8'));
  assert.equal(host.releaseUrl(R, 'v0.4.1'), 'https://dev.azure.com/acme/proj/_git/fake?version=GTv0.4.1');
});

test("a pull request of another repository in the organization, or one pushed to since it was read, isn't touched; nor is a base or a rebase asked of az", async () => {
  const other = recorded((at) => (at === 'pr show 7' ? ok(pull({ repository: { name: 'other', project: { name: 'proj' } } })) : at === 'pr show 9' ? ok(pull({ pullRequestId: 9, repository: { name: 'fake', project: { name: 'elsewhere' } } })) : ok({})));
  for (const a of [await other.host.mergePr(R, 7, { matchHead: 'abc123' }), await other.host.closePr(R, 7, { comment: 'bye', deleteBranch: true }), await other.host.editPr(R, 7, { title: 'T' }), await other.host.viewPr(R, 7, 'number')]) {
    assert.equal(a.code, 1);
    assert.equal(a.err, "pull request 7 isn't proj/fake's: it is proj/other's");
  }
  assert.match((await other.host.mergePr(R, 9, {})).err, /^pull request 9 isn't proj\/fake's: it is elsewhere\/fake's$/);
  assert.deepEqual([...new Set(other.ran.map((r) => r.at))], ['pr show 7', 'pr show 9'], 'nothing but the look');
  // Its name and project in another case are its own (Azure DevOps' names ignore case).
  const cased = recorded((at) => (at === 'pr show 7' ? ok(pull({ repository: { name: 'Fake', project: { name: 'PROJ' } } })) : undefined));
  assert.equal((await cased.host.viewPr(R, 7, 'number')).code, 0);

  const pushed = recorded((at) => (at === 'pr show 7' ? ok(pull({ lastMergeSourceCommit: { commitId: 'def456' } })) : ok({})));
  const p = await pushed.host.mergePr(R, 7, { matchHead: 'abc123' });
  assert.equal(p.err, "pull request 7's head is def456, not abc123: it was pushed to since");
  assert.deepEqual(pushed.ran.map((r) => r.at), ['pr show 7']);

  const none = recorded(() => ok({}));
  const base = await none.host.editPr(R, 7, { title: 'T', base: 'release' });
  assert.match(base.err, /^the Azure CLI can't change a pull request's base branch: change it on its page in Azure DevOps \(pull request 7 to release\)$/);
  assert.match((await none.host.mergePr(R, 7, { method: 'rebase' })).err, /can't complete a pull request by rebasing/);
  assert.deepEqual(none.ran, []);
  const squashed = recorded((at) => (at === 'pr show 7' ? ok(pull()) : at.startsWith('pr update') ? ok(pull({ status: 'completed' })) : undefined));
  must(await squashed.host.mergePr(R, 7, { method: 'squash' }));
  assert.deepEqual([opt(squashed.ran[1].args, '--squash'), opt(squashed.ran[1].args, '--delete-source-branch')], ['true', 'false']);
});

test("what az says when Azure DevOps doesn't let its sign-in in, or its extension isn't there, is said in a sentence", async () => {
  const page = '<!DOCTYPE html><html><head><title>Azure DevOps Services | Sign In</title></head><body>∞</body></html>';
  const said = async (r: Ran) => (await recorded(() => r).host.listPrs(R, { state: 'open', fields: 'number' })).err;
  const signIn = /^az's sign-in isn't let into https:\/\/dev\.azure\.com\/acme through Azure DevOps' API \(az login, as an account the organization has\): /;
  // A page where JSON was asked, as an organization of Microsoft accounts answered az rest.
  assert.match(await said(ok(page)), new RegExp(`${signIn.source}it answered with a page, not JSON$`));
  assert.match(await said({ code: 1, out: '', err: "ERROR: TF400813: The user '' is not authorized to access this resource.\n" }), new RegExp(`${signIn.source}TF400813: The user '' is not authorized to access this resource\\.$`));
  assert.match(await said({ code: 1, out: '', err: 'ERROR: Operation returned a 401 status code.' }), signIn);
  assert.match(await said({ code: 1, out: '', err: 'Before you can run Azure DevOps commands, you need to run the login command (az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.' }), signIn);
  assert.match(await said({ code: 1, out: '', err: 'AADSTS70043: The refresh token has expired due to inactivity.' }), signIn);
  for (const err of ["ERROR: The command requires the extension azure-devops. It will be installed first.\nERROR: Run 'az extension add --name azure-devops' to install it.", "az: 'repos' is not in the 'az' command group. See 'az --help'.", "ERROR: 'devops' is misspelled or not recognized by the system."]) {
    assert.equal(await said({ code: 1, out: '', err }), NO_EXTENSION, err);
  }
  // Anything else as az said it: a repository that isn't there, or isn't shared, isn't a sign-in.
  const missing = 'ERROR: TF401019: The Git repository with name or identifier fake does not exist or you do not have permissions for the operation you are attempting.';
  assert.equal(await said({ code: 1, out: '', err: missing }), missing);
  // az account show, before az login: no organization to name.
  const who = await recorded(() => ({ code: 1, out: '', err: "ERROR: Please run 'az login' to setup account.\n" })).host.whoAmI();
  assert.equal(who.err, "az isn't signed in (az login): Please run 'az login' to setup account.");
  assert.equal(refused({ code: 0, out: 'jcollier0120\n', err: '', what: 'az account show' }, null, false).code, 0);
});

test('a branch with no active pull request says so as gh does, so steward vouch vouches for the branch', async () => {
  const { host, ran } = recorded(() => ok([]));
  const a = await host.viewPr(R, 'claude/feature', 'number,state,headRefOid,isCrossRepository');
  assert.equal(a.code, 1);
  assert.match(a.err, /no pull requests found for branch "claude\/feature"/);
  assert.deepEqual(ran.map((r) => [r.at, opt(r.args, '--top')]), [['pr list active refs/heads/claude/feature', '1']]);
});

test('releases are v<version> tags; issues are not filed on Azure DevOps yet', async () => {
  const { host, ran } = recorded((at) => {
    if (at === 'GET refs filter=tags/v peelTags=true') return list([{ name: 'refs/tags/v0.4.0', objectId: 't0', peeledObjectId: 'c0' }]);
    if (at === 'GET refs filter=tags/v0.4.0 peelTags=true') return list([{ name: 'refs/tags/v0.4.0', objectId: 't0', peeledObjectId: 'c0' }]);
    if (at.startsWith('POST ')) return ok({});
  });
  assert.deepEqual(JSON.parse(must(await host.listReleases(R, 'tagName,isDraft,publishedAt'))), [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null, body: '', targetCommitish: 'c0' }]);
  assert.equal(JSON.parse(must(await host.viewRelease(R, 'v0.4.0', 'targetCommitish'))).targetCommitish, 'c0');
  const notes = path.join(tmp, 'notes.md');
  writeFileSync(notes, '**Fake 0.4.1.**');
  must(await host.createRelease(R, { tag: 'v0.4.1', target: 'abc', title: 'Fake 0.4.1', notesFile: notes }));
  assert.deepEqual(ran.filter((r) => r.body).map((r) => [r.at, r.body]), [['POST annotatedTags', { name: 'v0.4.1', taggedObject: { objectId: 'abc' }, message: 'Fake 0.4.1\n\n**Fake 0.4.1.**' }]]);
  const issues = await host.listIssues(R, { label: 'manor:work', state: 'open', fields: 'number' });
  assert.equal(issues.code, 1);
  assert.match(issues.err, /work items/);
});

test('completing waits for Azure DevOps to finish; a policy that holds it, or a head that moved, is a failure', async () => {
  const answers = (...prs: Record<string, unknown>[]) => {
    const asked: string[] = [];
    const host = new AzureDevOps(async (_cmd, args) => (asked.push(call(args)), ok(pull(prs.shift() ?? {}))), tmp);
    return { host, asked };
  };
  const queued = answers({}, { mergeStatus: 'queued' }, { mergeStatus: 'queued' }, { status: 'completed' });
  assert.equal((await queued.host.mergePr(R, 7, { matchHead: 'abc123' }, 0)).code, 0);
  assert.deepEqual(queued.asked, ['pr show 7', 'pr update 7 completed', 'pr show 7', 'pr show 7']);
  const held = await answers({}, { mergeStatus: 'rejectedByPolicy' }).host.mergePr(R, 7, { matchHead: 'abc123' }, 0);
  assert.equal(held.code, 1);
  assert.match(held.err, /wasn't completed: rejectedByPolicy/);
  const slow = await answers({}, ...Array.from({ length: 20 }, () => ({ mergeStatus: 'queued' }))).host.mergePr(R, 7, { matchHead: 'abc123' }, 0);
  assert.match(slow.err, /still being completed/);
  // Pushed to between the look and az's own: completed, but not at the head that was checked, which is said.
  const moved = await answers({}, { status: 'completed', lastMergeSourceCommit: { commitId: 'def456' } }).host.mergePr(R, 7, { matchHead: 'abc123' }, 0);
  assert.equal(moved.err, 'pull request 7 was completed at def456, not at abc123, the head that was checked: it was pushed to as it was completed');
});
