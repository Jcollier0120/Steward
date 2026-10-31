import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Runner } from '../src/run.ts';

// Round vouches (stages/roundvouch.ts): between builds, a round vouches for one of the team's open PRs as steward vouch
// would, and sets nothing else. A data folder of its own, a fake employee's git, gh standing in for GitHub.
// By its real path, as git and the work folder (workRootOf) spell it.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-roundvouch-')));
process.env.STEWARD_HOME = path.join(tmp, 'home');
process.env.WRIGHT_HOME = path.join(tmp, 'no-wright');
process.env.BAILIFF_HOME = path.join(tmp, 'no-bailiff');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { roundOrder, roundVouch, roundVouchesFile } = await import('../src/stages/roundvouch.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { readJson } = await import('../src/kit/store.ts');
const { normalizeSettings } = await import('../src/settings.ts');
const { makersPcForTests } = await import('../src/maker.ts');
const { savePipeline } = await import('../src/pipeline.ts');
const { runStage } = await import('../src/steward.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const REPO = 'Jcollier0120/Fake';
const byTeam = { context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } };
const NOW = new Date(2026, 9, 13, 10, 0);
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

/** A PR as a glance at GitHub gives it (gh pr list's shape, PR_FIELDS). */
const listed = (n: number, head: string, oid: string, more: Record<string, unknown> = {}) => ({
  number: n,
  title: `Fake: PR ${n}`,
  url: `https://github.com/${REPO}/pull/${n}`,
  body: '',
  createdAt: '2026-10-13T08:00:00Z',
  headRefName: head,
  headRefOid: oid,
  baseRefName: 'main',
  isCrossRepository: false,
  isDraft: false,
  author: { login: 'Jcollier0120' },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
  labels: [],
  files: [],
  additions: 1,
  deletions: 0,
  ...more,
});

/**
 * A fake employee whose main has no lockfile (so its checks need no npm here), its PRs in a glance, and gh standing in:
 * `gh pr view` says each PR's head is `heads`' (with `view`'s fields over it), a commit's statuses are `statuses`', and a
 * status set is noted in `set`. Its checks are `fake-checks`, which note the commit they ran at, call `during`, and exit
 * with each of `answers` in turn ('timeout': stopped at the run's time limit), then 0.
 */
function world(name: string, id = 'fake') {
  const f = fakeEmployee(path.join(tmp, name));
  sh(f.checkout, 'rm', '--quiet', 'package-lock.json');
  sh(f.checkout, 'commit', '--quiet', '-m', 'no lockfile');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  const prs: ReturnType<typeof listed>[] = [];
  const heads = new Map<number, string>();
  const view = new Map<number, Record<string, unknown>>();
  const statuses: Record<string, unknown[]> = {};
  const set: { sha: string; description: string }[] = [];
  const checks: string[] = [];
  const answers: (number | 'timeout')[] = [];
  let during: () => void = () => {};
  const r = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'view') return ok({ number: Number(a[2]), state: 'OPEN', headRefOid: heads.get(Number(a[2])), isDraft: false, isCrossRepository: false, ...view.get(Number(a[2])) });
    const read = /^repos\/Jcollier0120\/Fake\/commits\/([0-9a-f]{40})\/statuses\?per_page=100$/.exec(a[1] ?? '');
    if (a[0] === 'api' && read) return ok(statuses[read[1]] ?? []);
    if (a[0] === 'api' && a[2] === 'POST') {
      set.push({ sha: a[3].split('/').pop()!, description: a.find((x) => x.startsWith('description='))!.slice('description='.length) });
      return ok('{}');
    }
  });
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== 'fake-checks') return r.run(cmd, args, opts);
    checks.push(sh(opts!.cwd!, 'rev-parse', 'HEAD'));
    during();
    const code = answers.shift() ?? 0;
    if (code === 'timeout') return { code: 1, out: '', err: 'stopped', timedOut: true };
    return code ? { code, out: '', err: 'a test failed' } : ok('all passed');
  };
  const e = employee(f.checkout, { id, fill: '', test: ['fake-checks'], versionFiles: ['package.json', 'src/app.ts'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, name, 'work'), run, neutralDir: tmp });
  ctx.settings.roundVouches = true;
  ctx.glance = { at: NOW.toISOString(), stewardReleases: null, repos: { [id]: { head: null, prs, releases: [] } }, errors: {} };
  /** A commit on `branch` (made from main the first time), pushed: its sha. `files` are written in it besides its own. */
  const push = (branch: string, files: Record<string, string> = {}) => {
    const has = !!sh(f.checkout, 'branch', '--list', branch);
    sh(f.checkout, 'switch', '--quiet', ...(has ? [branch] : ['-c', branch, 'main']));
    // Its code its own, in this world alone: a pass of the same tree elsewhere would stand in.
    for (const [file, text] of Object.entries({ [`${branch.replace(/\W/g, '-')}.txt`]: `${name} ${branch} ${Date.now()} ${Math.random()}\n`, ...files })) writeFileSync(path.join(f.checkout, file), text);
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', branch);
    sh(f.checkout, 'push', '--quiet', 'origin', branch);
    const oid = sh(f.checkout, 'rev-parse', 'HEAD');
    sh(f.checkout, 'switch', '--quiet', 'main');
    return oid;
  };
  /** A PR from a branch of its own, listed and open: its head. */
  const pr = (n: number, branch: string, more: Record<string, unknown> = {}, files: Record<string, string> = {}) => {
    const oid = push(branch, files);
    prs.push(listed(n, branch, oid, more));
    heads.set(n, oid);
    return oid;
  };
  /** A new push to PR `n`'s branch, as the glance and gh then say: its head. */
  const pushTo = (n: number) => {
    const p = prs.find((x) => x.number === n)!;
    p.headRefOid = push(p.headRefName);
    heads.set(n, p.headRefOid);
    return p.headRefOid;
  };
  const round = (o: Partial<Parameters<typeof roundVouch>[1]> = {}) => roundVouch(ctx, { next: inMinutes(120), now: () => NOW, mainVersion: async () => '0.4.0', ...o });
  const kept = () => readJson<Record<string, { ok: boolean; note: string }>>(roundVouchesFile(), {});
  return { ...f, e, ctx, r, prs, heads, view, statuses, set, checks, answers, pr, pushTo, round, kept, during: (fn: () => void) => (during = fn) };
}

const short = (sha: string) => sha.slice(0, 7);

test("off unless Settings say so: absent from the file, on on the makers' PCs and off on anyone else's", async () => {
  assert.equal(normalizeSettings({}).settings.roundVouches, true, "the makers' PC");
  makersPcForTests(() => false);
  try {
    assert.equal(normalizeSettings({}).settings.roundVouches, false, "a customer's PC");
    assert.equal(normalizeSettings({ roundVouches: true }).settings.roundVouches, true, 'a customer who turned it on');
  } finally {
    makersPcForTests(() => true);
  }
  assert.equal(normalizeSettings({ roundVouches: false }).settings.roundVouches, false, 'the makers, turned off');
  const w = world('off');
  w.pr(5, 'claude/off-a');
  w.ctx.settings.roundVouches = false;
  assert.deepEqual(await w.round(), []);
  assert.deepEqual([w.checks.length, w.set.length, w.r.gh.length], [0, 0, 0], 'nothing run or asked');
});

test("a team member's PR is vouched for at its head, in a worktree of its own, with the status steward vouch sets; nothing else is done to it", async () => {
  const w = world('vouched');
  const head = w.pr(5, 'claude/vouched-a');
  const lines = await w.round();
  assert.deepEqual(w.checks, [head], 'its checks, once, at its head');
  assert.deepEqual(w.set, [{ sha: head, description: `fake-checks passed in the Steward's round at ${short(head)}` }]);
  assert.match(lines.join('\n'), new RegExp(`\\[fake\\] round vouch of #5 at ${short(head)}: fake-checks passed in the Steward's round at ${short(head)}, and GitHub has it \\(${VOUCH_CONTEXT}\\): Jcollier0120 merges it`));
  assert.equal(w.kept()[`fake#5@${head}`]?.ok, true);
  // Never merged, commented on, edited or pushed to; its worktree gone.
  assert.deepEqual(w.r.gh.filter((a) => a[0] === 'pr' && a[1] !== 'view'), []);
  assert.equal(sh(w.origin, 'rev-parse', 'refs/heads/claude/vouched-a'), head);
  assert.equal(sh(w.origin, 'rev-parse', 'refs/heads/main'), sh(w.checkout, 'rev-parse', 'main'));
  assert.equal(existsSync(path.join(tmp, 'vouched', 'work', 'fake-pr')), false);
  // Kept by commit: the next round has nothing to do.
  assert.deepEqual(await w.round(), []);
  assert.deepEqual([w.checks.length, w.set.length], [1, 1]);
});

test("a stranger's PR, a draft, a fork's and one into another branch are left alone", async () => {
  const w = world('left-alone');
  w.pr(1, 'claude/left-stranger', { author: { login: 'someone-else' } });
  w.pr(2, 'claude/left-draft', { isDraft: true });
  w.pr(3, 'claude/left-fork', { isCrossRepository: true });
  w.pr(4, 'claude/left-other', { baseRefName: 'dev' });
  assert.deepEqual(await w.round(), []);
  assert.deepEqual([w.checks.length, w.set.length, w.r.gh.length], [0, 0, 0]);
});

test('a head a team member vouched for is not run again, nor one whose very code passed here already', async () => {
  const w = world('covered');
  const vouched = w.pr(1, 'claude/covered-a');
  w.statuses[vouched] = [byTeam];
  const head = w.pr(2, 'claude/covered-b');
  await w.round();
  assert.deepEqual(w.checks, [head], "the vouched one passed over, the next one's run");
  assert.match(w.kept()[`fake#1@${vouched}`]?.note ?? '', /^Jcollier0120 vouched for/);
  // The same code as #2's head, in another commit: its pass here stands in, and the status is set without a run.
  sh(w.checkout, 'switch', '--quiet', '-c', 'claude/covered-same', head);
  sh(w.checkout, 'commit', '--quiet', '--amend', '-m', 'the same code again');
  sh(w.checkout, 'push', '--quiet', 'origin', 'claude/covered-same');
  const same = sh(w.checkout, 'rev-parse', 'HEAD');
  sh(w.checkout, 'switch', '--quiet', 'main');
  w.prs.push(listed(3, 'claude/covered-same', same));
  w.heads.set(3, same);
  await w.round();
  assert.equal(w.checks.length, 1, 'not run again');
  assert.deepEqual(w.set.at(-1), { sha: same, description: `fake-checks passed at ${short(same)}` });
  assert.match(w.ctx.lines.join('\n'), /on exactly this code .*: not run again/);
});

test("a head that moves on while its checks run is dropped: nothing set or kept; and a PR closed by its turn isn't started", async () => {
  const w = world('moved');
  const head = w.pr(5, 'claude/moved-a');
  w.during(() => w.heads.set(5, 'f'.repeat(40)));
  const lines = await w.round();
  assert.deepEqual([w.checks.length, w.set.length], [1, 0]);
  assert.match(lines.join('\n'), /its checks passed, but its head moved on to fffffff: nothing was set/);
  assert.equal(w.kept()[`fake#5@${head}`], undefined, 'not kept: tried again if it comes back');
  w.during(() => {});
  w.heads.set(5, head);
  w.view.set(5, { state: 'CLOSED' });
  assert.match((await w.round()).join('\n'), /not started, it is closed now/);
  assert.equal(w.checks.length, 1);
});

test('a failure sets nothing and is kept by commit: not run again until a new push', async () => {
  const w = world('failed');
  const head = w.pr(5, 'claude/failed-a');
  w.answers.push(1, 1);
  const lines = await w.round();
  assert.deepEqual(w.checks, [head, head], 'once more after the first failure, as a build tests main');
  assert.equal(w.set.length, 0);
  assert.match(lines.join('\n'), /its checks failed: twice: fake-checks failed \(exit 1\)\. Nothing was set; a new push is tried afresh/);
  assert.equal(w.kept()[`fake#5@${head}`]?.ok, false);
  await w.round();
  assert.equal(w.checks.length, 2, 'the same head is not run every round');
  const again = w.pushTo(5);
  await w.round();
  assert.deepEqual(w.checks.slice(2), [again], 'a new push is tried afresh');
  assert.deepEqual(w.set.map((s) => s.sha), [again]);
});

test("version files that disagree at the head: refused as steward vouch refuses them, nothing run, and kept", async () => {
  const w = world('versions');
  const head = w.pr(5, 'claude/versions-a', {}, { 'package.json': '{\n  "name": "fake",\n  "version": "0.4.1",\n  "private": true,\n  "type": "module"\n}\n' });
  const lines = await w.round();
  assert.equal(w.checks.length, 0);
  assert.match(lines.join('\n'), /Nothing was run or set/);
  assert.equal(w.kept()[`fake#5@${head}`]?.ok, false);
});

test("stopped for the next build: not kept, so a round after it tries again; and none is started when it's near", async () => {
  // An employee with no vouch times yet: the build's limit is the one.
  const w = world('build', 'cut');
  const head = w.pr(5, 'claude/build-a');
  w.answers.push('timeout');
  const lines = await w.round({ next: inMinutes(30) });
  assert.match(w.ctx.lines.join('\n'), /time limit: 5 min before the next build/);
  assert.match(lines.join('\n'), /stopped for the next build, not kept: a round after it tries again/);
  assert.equal(w.checks.length, 1, 'not run twice for the build');
  assert.deepEqual([w.set.length, w.kept()[`cut#5@${head}`]], [0, undefined]);
  assert.deepEqual(await w.round({ next: inMinutes(10) }), ['round vouches: none started, the next build is in 10 min']);
  assert.equal(w.checks.length, 1);
  await w.round({ next: null });
  assert.deepEqual(w.set.map((s) => s.sha), [head], 'with no build planned, no limit of its own');
});

test('lowest version first, as they merge: in each repository by the version above main, across them each first before any second', async () => {
  const c = (id: string, n: number, version: string | null) => ({ e: { id }, pr: { number: n }, version });
  const order = roundOrder([c('a', 3, '1.0.2'), c('a', 4, '1.0.1'), c('a', 2, null), c('a', 9, '0.9.0'), c('b', 7, '2.0.0'), c('b', 1, null)], (id) => (id === 'a' ? '1.0.0' : null));
  assert.deepEqual(order.map((x) => `${x.e.id}#${x.pr.number}`), ['a#4', 'b#7', 'a#3', 'b#1', 'a#2', 'a#9']);
  // One a round, from a PR's title: 0.4.1's before 0.4.2's, though it was opened after.
  const w = world('order');
  const later = w.pr(8, 'claude/order-later', { title: 'Fake 0.4.2: later' });
  const sooner = w.pr(9, 'claude/order-sooner', { title: 'Fake 0.4.1: sooner' });
  await w.round();
  assert.deepEqual(w.set.map((s) => s.sha), [sooner], 'one PR a round');
  await w.round();
  assert.deepEqual(w.set.map((s) => s.sha), [sooner, later]);
});

test('only where this PC releases the repository: another PC has its turn, before the run or by the time it passes', async () => {
  const w = world('turns');
  const head = w.pr(5, 'claude/turns-a');
  assert.deepEqual(await w.round({ acting: async () => [] }), []);
  assert.deepEqual([w.checks.length, w.set.length], [0, 0]);
  w.ctx.lease = { ok: async () => false, skip: new Set(), has: () => true };
  assert.match((await w.round()).join('\n'), /its checks passed, but another PC releases Fake now: nothing was set/);
  assert.deepEqual([w.checks.length, w.set.length, w.kept()[`fake#5@${head}`]], [1, 0, undefined]);
});

test("a round between builds vouches for a team PR, as Settings say; the round before it and its log go on as they did", async () => {
  const dir = path.join(tmp, 'stage');
  const f = fakeEmployee(dir);
  sh(f.checkout, 'rm', '--quiet', 'package-lock.json');
  sh(f.checkout, 'commit', '--quiet', '-m', 'no lockfile');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/stage-a');
  writeFileSync(path.join(f.checkout, 'stage.txt'), `stage ${Date.now()}\n`);
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'stage');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/stage-a');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'switch', '--quiet', 'main');
  mkdirSync(process.env.STEWARD_HOME!, { recursive: true });
  const settings = (roundVouches: boolean) =>
    writeFileSync(
      path.join(process.env.STEWARD_HOME!, 'settings.json'),
      JSON.stringify({
        employees: [{ id: 'fake', name: 'Fake', repo: REPO, checkout: f.checkout, branch: 'main', usesKit: false, parts: ['node'], fill: '', test: ['fake-checks'], versionFiles: ['package.json', 'src/app.ts'], release: '', install: '', approve: '' }],
        team: ['Jcollier0120'],
        workRoot: path.join(dir, 'work'),
        buildPipeline: { times: ['08:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], kit: 'every', windowMinutes: 30 },
        roundVouches,
      }),
    );
  const at = (h: number) => new Date(2026, 9, 13, h, 0);
  savePipeline({ open: null, builds: [{ due: at(8).toISOString(), by: 'schedule', started: at(8).toISOString(), finished: new Date(2026, 9, 13, 8, 30).toISOString(), rounds: 1, merged: [], released: [], failed: [] }] });
  const set: string[] = [];
  let ran = 0;
  const r = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list') return ok([listed(5, 'claude/stage-a', head)]);
    if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 5, state: 'OPEN', headRefOid: head, isDraft: false, isCrossRepository: false });
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (a[0] === 'api' && /\/statuses\?per_page=100$/.test(a[1] ?? '')) return ok([]);
    if (a[0] === 'api' && a[2] === 'POST') return (set.push(a[3]), ok('{}'));
  });
  const run: Runner = async (cmd, args, opts) => (cmd === 'fake-checks' ? (ran++, ok('all passed')) : r.run(cmd, args, opts));
  const round = () => runStage('round', {}, { run, now: () => at(10), pipeline: true });

  settings(false);
  const off = await round();
  assert.equal(off.error, undefined);
  assert.deepEqual(off.build, { between: true, next: new Date(2026, 9, 14, 8, 0).toISOString() });
  assert.deepEqual([ran, set.length], [0, 0], 'off: nothing run or set');

  settings(true);
  const on = await round();
  assert.equal(on.error, undefined);
  const log = on.log.join('\n');
  assert.match(log, /between builds: PRs are merged by whoever wrote them once vouched/);
  assert.match(log, new RegExp(`\\[fake\\] round vouch of #5 at ${short(head)}: fake-checks passed in the Steward's round at ${short(head)}`));
  assert.deepEqual([ran, set], [1, [`repos/${REPO}/statuses/${head}`]]);
  assert.equal(JSON.parse(readFileSync(path.join(process.env.STEWARD_HOME!, 'settings.json'), 'utf8')).roundVouches, true, 'the file as it was written');
});
