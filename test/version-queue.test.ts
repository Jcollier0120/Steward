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

const { heldQueues, keepVersionQueues, loadVersionQueues, queueHold } = await import('../src/version-queue.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
const { shareRemoteHeads } = await import('../src/kit/remote-heads.ts');
const { reconcile, roundConditions } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');
const { CONFLICTS } = await import('../src/conflicts.ts');
const { GAVE_WAY } = await import('../src/stages/merge.ts');
type QueuedPr = import('../src/version-queue.ts').QueuedPr;

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

const T = '2026-10-15T08:00:00.000Z';
const later = (min: number) => new Date(Date.parse(T) + min * 60_000);
const queued = (number: number, version: string, o: Partial<QueuedPr> = {}): QueuedPr => ({ number, title: `#${number}`, url: `https://github.com/Jcollier0120/Steward/pull/${number}`, version, ready: true, why: null, head: `h${number}`, ...o });
const turn = (n: number, v: string) => `its turn comes after #${n} (v${v}): the lowest version merges first`;

test('what holds a version queue: its lowest PR not ready, with ready PRs waiting behind it, since the first round that saw it', () => {
  const draft = queued(233, '0.36.41', { ready: false, why: 'a draft', draft: true });
  const queue = [draft, queued(266, '0.36.43'), queued(268, '0.36.44')];
  const first = queueHold(queue, T);
  assert.deepEqual(first, { number: 233, title: '#233', url: 'https://github.com/Jcollier0120/Steward/pull/233', version: '0.36.41', why: 'a draft', draft: true, behind: [266, 268], since: T });
  assert.equal(queueHold(queue, later(90).toISOString(), { before: first })?.since, T, 'the same PR holding it: since it first did');

  // Marked ready but untested here: the merge stage's reason is the one said, and the PRs waiting their turn behind it
  // count as ready.
  const held = new Map([[233, 'untested: its checks run here first'], [266, turn(233, '0.36.41')], [268, turn(233, '0.36.41')]]);
  const untested = queueHold([{ ...draft, ready: true, why: null, draft: false }, ...queue.slice(1)], later(90).toISOString(), { held, before: first });
  assert.deepEqual([untested?.number, untested?.why, untested?.draft, untested?.behind, untested?.since], [233, 'untested: its checks run here first', false, [266, 268], T]);

  // Another PR holding it: since starts over.
  const failing = queueHold([queued(266, '0.36.43', { ready: false, why: 'checks failing' }), queued(268, '0.36.44')], later(120).toISOString(), { before: first });
  assert.deepEqual([failing?.number, failing?.behind, failing?.since], [266, [268], later(120).toISOString()]);

  assert.equal(queueHold([draft, queued(266, '0.36.43', { ready: false, why: 'a draft', draft: true })], T), null, 'nothing ready behind it: nothing waits');
  assert.equal(queueHold([queued(266, '0.36.43'), draft], T), null, 'a draft above the ready ones holds nothing');
  assert.equal(queueHold([queued(250, '0.36.40', { ready: false, why: CONFLICTS }), ...queue.slice(1)], T, { held: new Map([[250, GAVE_WAY]]) }), null, 'one that gives up its turn holds nothing');
  assert.equal(queueHold([], T), null);
});

test("the round says what holds the Steward's own queue and since when, and an alarm is raised once it has held more than an hour", async () => {
  const s = repoWithPrs('steward-own');
  const shas = { 21: s.make(21, '0.4.1'), 22: s.make(22, '0.4.2'), 23: s.make(23, '0.4.3') };
  const prs = [listed('Jcollier0120/Steward', 21, shas[21], { isDraft: true }), listed('Jcollier0120/Steward', 22, shas[22]), listed('Jcollier0120/Steward', 23, shas[23])];
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'list' ? ok(prs) : undefined));
  const self = employee(s.checkout, { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward' });
  const ctx = ctxFor({ employees: [], workRoot: path.join(tmp, 'work5'), run: r.run, neutralDir: tmp });

  // The Steward's own repository is no employee of its own: its queue is read as the merge stage's `self`.
  let q = await keepVersionQueues(ctx, { projects: [], self, now: () => later(0) });
  const own = q.repos.find((x) => x.id === 'steward')!;
  assert.deepEqual([own.held?.number, own.held?.draft, own.held?.behind, own.held?.since], [21, true, [22, 23], T]);
  assert.ok(ctx.lines.some((l) => /^\[steward\] #21 \(v0\.4\.1, .+\) holds its version queue: #22, #23 wait behind it, since 2026-10-15T08:00:00\.000Z$/.test(l)), ctx.lines.join('\n'));

  // An hour and a half on, the merge stage's reason for it, and the same since.
  q = await keepVersionQueues(ctx, { projects: [], self, now: () => later(90), held: [{ employee: self, prs: [{ number: 21, why: 'a draft: review it, then mark it ready' }] }] });
  const holds = heldQueues(loadVersionQueues());
  assert.deepEqual(holds.map((h) => [h.id, h.repo, h.hold.number, h.hold.why, h.hold.since]), [['steward', 'Jcollier0120/Steward', 21, 'a draft: review it, then mark it ready', T]]);

  const settings = structuredClone(DEFAULT_SETTINGS);
  const round = { stage: 'round' as const, started: T, finished: T, kit: null, asked: {}, results: [], log: [] };
  const conditions = (queueHolds: typeof holds) => roundConditions({ round, held: [], failedReleases: {}, queueHolds, employees: [], settings }).filter((c) => c.id.startsWith('queue:'));
  const c = conditions(holds);
  assert.deepEqual(c.map((x) => [x.id, x.who, x.url, x.since]), [['queue:Jcollier0120/Steward#21', 'steward', 'https://github.com/Jcollier0120/Steward/pull/21', T]]);
  const empty = { at: null, watching: {}, open: [], cleared: [] };
  assert.equal(reconcile(empty, c, later(59)).raised.length, 0, 'not within the hour');
  const raised = reconcile(empty, c, later(61)).raised;
  assert.equal(raised.length, 1);
  assert.equal(raised[0].title, 'Steward #21 (v0.4.1) has held its version queue for 1 hour or more: #22, #23 wait behind it');
  assert.ok(raised[0].detail.some((d) => d.startsWith('Mark it ready once it is done')), raised[0].detail.join('\n'));

  // Its turn another PC's (turns.json): that PC's Steward merges there and raises it, so this one doesn't as well.
  const turnIs = (status: 'here' | 'elsewhere') => ({ repos: { 'jcollier0120/steward': { repo: 'Jcollier0120/Steward', status, at: T } } });
  assert.deepEqual(heldQueues(loadVersionQueues(), turnIs('elsewhere')), []);
  assert.equal(heldQueues(loadVersionQueues(), turnIs('here')).length, 1);

  // A conflict holding it is the blocking alarm's, which names its files.
  assert.deepEqual(conditions([{ ...holds[0], hold: { ...holds[0].hold, why: `${CONFLICTS} in src/app.ts` } }]), []);

  // Marked ready: nothing holds it, and the alarm goes.
  prs[0] = listed('Jcollier0120/Steward', 21, shas[21]);
  q = await keepVersionQueues(ctx, { projects: [], self, now: () => later(120) });
  assert.equal(q.repos.find((x) => x.id === 'steward')?.held, undefined);
  assert.deepEqual(heldQueues(loadVersionQueues()), []);
});
