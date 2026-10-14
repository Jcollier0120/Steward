import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Each repository's version queue, for Manor (version-queue.ts): an employee's and a non-employee project's, on fake
// repositories made with git in a temporary folder, with gh standing in for GitHub.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-vq-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { keepVersionQueues, loadVersionQueues } = await import('../src/version-queue.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
const { shareRemoteHeads } = await import('../src/kit/remote-heads.ts');

const VERSION_FILES = ['package.json', 'package-lock.json', 'src/app.ts'];
const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const red = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }];

/** A fake repository at 0.4.0, and PRs made on it, each pushed as refs/pull/<n>/head. */
function repoWithPrs(name: string, files = VERSION_FILES) {
  const f = fakeEmployee(path.join(tmp, name), { version: '0.4.0' });
  const base = sh(f.checkout, 'rev-parse', 'HEAD');
  const make = (n: number, version?: string) => {
    sh(f.checkout, 'switch', '--quiet', '--detach', base);
    if (version) for (const file of files) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', version));
    writeFileSync(path.join(f.checkout, `change-${n}.txt`), `#${n}\n`);
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', `#${n}`);
    const sha = sh(f.checkout, 'rev-parse', 'HEAD');
    sh(f.checkout, 'push', '--quiet', '--force', 'origin', `${sha}:refs/pull/${n}/head`);
    sh(f.checkout, 'switch', '--quiet', 'main');
    return sha;
  };
  return { ...f, make };
}

const listed = (repo: string, n: number, sha: string, o: Record<string, unknown> = {}) => ({
  number: n,
  title: `#${n}`,
  url: `https://github.com/${repo}/pull/${n}`,
  headRefName: `feat/${n}`,
  headRefOid: sha,
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'someone' },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: green,
  body: '',
  ...o,
});

test("each repository's version, and the PR versions above it lowest first: an employee's and a project's", async () => {
  const a = repoWithPrs('agent');
  const shas = { 7: a.make(7, '0.4.2'), 8: a.make(8, '0.4.1'), 9: a.make(9, '0.4.3'), 10: a.make(10), 11: a.make(11, '0.3.9') };
  const agentPrs = [listed('Jcollier0120/Fake', 7, shas[7]), listed('Jcollier0120/Fake', 8, shas[8], { statusCheckRollup: red }), listed('Jcollier0120/Fake', 9, shas[9], { isDraft: true }), listed('Jcollier0120/Fake', 10, shas[10]), listed('Jcollier0120/Fake', 11, shas[11])];
  // A project names no version files: its package.json is found.
  const p = repoWithPrs('project', ['package.json']);
  const three = p.make(3, '0.5.0');
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok(args[3] === 'someone/Side' ? [listed('someone/Side', 3, three)] : agentPrs);
  });
  const e = employee(a.checkout, { id: 'fake', name: 'Fake' });
  const project = { name: 'Side Car', checkout: p.checkout, repo: 'someone/Side', branch: 'main', test: null, versionFiles: [], cleanBranches: true, merges: false, release: '' };
  const ctx = () => ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });

  const q = await keepVersionQueues(ctx(), { projects: [project] });
  const [agent, side] = q.repos;
  assert.equal(agent.id, 'fake');
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.version, '0.4.0');
  assert.deepEqual(agent.queue.map((x) => [x.number, x.version, x.ready]), [[8, '0.4.1', false], [7, '0.4.2', true], [9, '0.4.3', false]], 'lowest first, a draft holding its place; one that sets no version and one below the branch are left out');
  assert.equal(agent.queue[0].why, 'checks failing');
  assert.deepEqual(agent.queue.map((x) => !!x.draft), [false, false, true]);
  assert.deepEqual(q.upcoming?.map((u) => [u.id, u.number, u.position]), [['fake', 9, 2]], 'the draft, third in line, is coming up');
  assert.equal(agent.working, '0.4.1');
  assert.equal(agent.latest, '0.4.2');
  assert.equal(side.id, 'project:side-car');
  assert.equal(side.kind, 'project');
  assert.deepEqual(side.files, ['package.json']);
  assert.equal(side.version, '0.4.0');
  assert.deepEqual(side.queue.map((x) => [x.number, x.version]), [[3, '0.5.0']]);
  assert.deepEqual(loadVersionQueues(), q, 'kept for /api/version-queues');

  // #8 merged: its branch is at 0.4.1, and the queue moves on to #7.
  sh(a.checkout, 'push', '--quiet', 'origin', `${shas[8]}:refs/heads/main`);
  agentPrs.splice(1, 1);
  const next = await keepVersionQueues(ctx(), { projects: [project] });
  assert.equal(next.repos[0].version, '0.4.1');
  assert.deepEqual(next.repos[0].queue.map((x) => x.number), [7, 9]);
  assert.equal(next.repos[0].working, '0.4.2');
});

test('a repository that can\'t be read says why, and a project that is one of the employees\' checkouts is not listed twice', async () => {
  const a = repoWithPrs('agent2');
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'list' ? ok([]) : undefined));
  const e = employee(a.checkout, { id: 'fake2', name: 'Fake2' });
  const gone = { name: 'Gone', checkout: path.join(tmp, 'nowhere'), repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true, merges: false, release: '' };
  const twin = { name: 'Twin', checkout: a.checkout, repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true, merges: false, release: '' };
  const q = await keepVersionQueues(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work2'), run: r.run, neutralDir: tmp }), { projects: [gone, twin] });
  assert.deepEqual(q.repos.map((x) => x.id), ['fake2', 'project:gone']);
  assert.equal(q.repos[0].version, '0.4.0');
  assert.deepEqual(q.repos[0].queue, []);
  assert.equal(q.repos[0].working, null);
  assert.match(q.repos[1].note ?? '', /^no checkout at /);
});

test("an employee whose branch on GitHub is where its clone has it already isn't fetched; one the glance says moved is", async () => {
  const a = repoWithPrs('glanced');
  const e = employee(a.checkout, { versionFiles: VERSION_FILES });
  const git: string[][] = [];
  const r = runner(() => undefined);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: (cmd, args, opts) => (cmd === 'git' && git.push(args), r.run(cmd, args, opts)), neutralDir: tmp });
  const before = sh(a.checkout, 'rev-parse', 'origin/main');
  ctx.glance = { at: '', stewardReleases: null, repos: { fake: { head: before, prs: [], releases: [] } }, errors: {} };
  const q = await keepVersionQueues(ctx, { projects: [] });
  assert.deepEqual([q.repos[0].version, q.repos[0].head], ['0.4.0', before]);
  assert.ok(!git.some((x) => x.includes('fetch')), 'nothing fetched');

  // Raised on GitHub: this clone's origin/main is still where it was, and the glance says otherwise.
  for (const file of VERSION_FILES) writeFileSync(path.join(a.checkout, file), readFileSync(path.join(a.checkout, file), 'utf8').replaceAll('0.4.0', '0.4.1'));
  sh(a.checkout, 'commit', '--quiet', '-am', 'Fake 0.4.1');
  sh(a.checkout, 'push', '--quiet', 'origin', 'main');
  const moved = sh(a.checkout, 'rev-parse', 'HEAD');
  sh(a.checkout, 'update-ref', 'refs/remotes/origin/main', before);
  ctx.glance.repos.fake.head = moved;
  git.length = 0;
  const again = await keepVersionQueues(ctx, { projects: [] });
  assert.ok(git.some((x) => x.includes('fetch')), 'fetched');
  assert.deepEqual([again.repos[0].version, again.repos[0].head], ['0.4.1', moved]);
});

test('the head kept stands whatever the clone has, and one the stage merged or released to is fetched whatever the glance said', async () => {
  const a = repoWithPrs('agent3');
  const h0 = sh(a.checkout, 'rev-parse', 'origin/main');
  const h1 = a.make(1, '0.4.1');
  const r = runner();
  const fetches: string[][] = [];
  const run: typeof r.run = (cmd, args, opts) => (cmd === 'git' && args.includes('fetch') && fetches.push(args), r.run(cmd, args, opts));
  const e = employee(a.checkout, { id: 'fake3', name: 'Fake3' });
  const ctx = (head: string) => ({ ...ctxFor({ employees: [e], workRoot: path.join(tmp, 'work3'), run, neutralDir: tmp }), glance: { at: '', stewardReleases: null, repos: { fake3: { head, prs: [], releases: [] } }, errors: {} } });

  // GitHub's branch moved past the clone's: fetched once, and read at the new head.
  sh(a.checkout, 'push', '--quiet', 'origin', `${h1}:refs/heads/main`);
  sh(a.checkout, 'update-ref', 'refs/remotes/origin/main', h0);
  let q = await keepVersionQueues(ctx(h1), { projects: [] });
  assert.deepEqual([q.repos[0].head, q.repos[0].version, fetches.length], [h1, '0.4.1', 1]);

  // The same head next round: the one kept stands, whatever the clone has.
  sh(a.checkout, 'update-ref', 'refs/remotes/origin/main', h0);
  q = await keepVersionQueues(ctx(h1), { projects: [] });
  assert.deepEqual([q.repos[0].head, q.repos[0].version, fetches.length], [h1, '0.4.1', 1]);

  // One the stage merged or released to since its glance is fetched, whatever the glance said.
  q = await keepVersionQueues(ctx(h1), { projects: [], moved: ['fake3'] });
  assert.deepEqual([q.repos[0].head, fetches.length], [h1, 2]);
});

test("a project's clone isn't fetched while remote-heads.json says its branch on GitHub is where the clone has it; once it moved, it is", async () => {
  const was = process.env.MANOR_HOME;
  process.env.MANOR_HOME = path.join(tmp, 'manor');
  try {
    const p = repoWithPrs('project3', ['package.json']);
    const before = sh(p.checkout, 'rev-parse', 'origin/main');
    const r = runner((args) => (args[0] === 'pr' && args[1] === 'list' ? ok([]) : undefined));
    const fetches: string[][] = [];
    const run: typeof r.run = (cmd, args, opts) => (cmd === 'git' && args.includes('fetch') && fetches.push(args), r.run(cmd, args, opts));
    const project = { name: 'Side Three', checkout: p.checkout, repo: 'someone/Side3', branch: 'main', test: null, versionFiles: [], cleanBranches: true, merges: false, release: '' };
    const ctx = ctxFor({ employees: [], workRoot: path.join(tmp, 'work4'), run, neutralDir: tmp });
    shareRemoteHeads({ 'someone/Side3': { heads: { main: before }, complete: true } });
    let q = await keepVersionQueues(ctx, { projects: [project] });
    assert.deepEqual([q.repos[0].version, q.repos[0].head, fetches.length], ['0.4.0', before, 0]);

    // Raised on GitHub, as the heads shared since say: fetched, and read at the new head.
    const raised = p.make(1, '0.4.1');
    sh(p.checkout, 'push', '--quiet', 'origin', `${raised}:refs/heads/main`);
    sh(p.checkout, 'update-ref', 'refs/remotes/origin/main', before);
    shareRemoteHeads({ 'someone/Side3': { heads: { main: raised }, complete: true } });
    q = await keepVersionQueues(ctx, { projects: [project] });
    assert.deepEqual([q.repos[0].version, q.repos[0].head, fetches.length], ['0.4.1', raised, 1]);
  } finally {
    if (was === undefined) delete process.env.MANOR_HOME;
    else process.env.MANOR_HOME = was;
  }
});
