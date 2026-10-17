import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// The Steward as one of the Seneschal's workers (stages/others.ts): a task of a repository it looks after, this PC's or
// another PC's, runs in a worktree of its own at a commit fetched from that repository's origin, and only a commit on one
// of its own branches; what it came to goes back under the task's turn; one it can't take now is given back unstarted.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-others-'));
process.env.STEWARD_HOME = home;
process.env.MANOR_HOME = path.join(home, 'no-manor');
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
process.env.SENESCHAL_HOME = path.join(home, 'no-seneschal');
delete process.env.KIT_CHECKS_TURN;
after(() => rmSync(home, { recursive: true, force: true }));

const { fetchJob, fetchKit, kindsFor, kitCommitOf, othersDirOf, othersKitDirOf, outcomeOf, workersFor, workForOthers } = await import('../src/stages/others.ts');
const { PACKAGES_HELD, trialDirOf } = await import('../src/stages/bump.ts');
const { repoLock } = await import('../src/stages/slots.ts');
const { ctxFor, employee, fakeEmployee, runner, sh } = await import('./helpers.ts');
type SeneschalJob = import('../src/kit/seneschal.ts').SeneschalJob;
type SeneschalOutcome = import('../src/kit/seneschal.ts').SeneschalOutcome;

const RAN = path.join(home, 'ran.txt');
// Its one check writes down where it ran, and fails where the commit says so.
const CHECK = `import { appendFileSync, existsSync } from 'node:fs';\nappendFileSync(${JSON.stringify(RAN)}, process.cwd() + '\\n');\nprocess.exit(existsSync('FAIL') ? 1 : 0);\n`;
const { checkout } = fakeEmployee(path.join(home, 'fake'), { files: { 'check.mjs': CHECK } });
const git = (...args: string[]) => sh(checkout, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args);
const main = git('rev-parse', 'HEAD');
// A PR's branch on the repository itself, a commit on it that fails, and a commit on no branch of it (a fork's PR, say).
git('checkout', '-q', '-b', 'claude/x');
git('commit', '-q', '--allow-empty', '-m', 'on its branch');
const onBranch = git('rev-parse', 'HEAD');
git('push', '-q', 'origin', 'claude/x');
git('checkout', '-q', '-b', 'claude/fails');
writeFileSync(path.join(checkout, 'FAIL'), 'it fails\n');
sh(checkout, 'add', 'FAIL');
git('commit', '-q', '-m', 'it fails');
const fails = git('rev-parse', 'HEAD');
git('push', '-q', 'origin', 'claude/fails');
git('checkout', '-q', '--detach', main);
git('commit', '-q', '--allow-empty', '-m', 'on no branch');
const offBranch = git('rev-parse', 'HEAD');
git('push', '-q', 'origin', 'HEAD:refs/pull/1/head');
git('checkout', '-q', 'main');

const { run } = runner();
const e = employee(checkout, { fill: '', test: ['node check.mjs'] });
const ctx = ctxFor({ employees: [e, employee(path.join(home, 'nowhere'), { id: 'gone', repo: 'Jcollier0120/Gone' }), employee(checkout, { id: 'untested', repo: 'Jcollier0120/Untested', test: [] })], workRoot: path.join(home, 'work'), run, neutralDir: home });

beforeEach(() => {
  rmSync(RAN, { force: true });
  rmSync(TRIED, { force: true });
});

/** A turn as the kit's seneschalWork hands one out, keeping what it was told. */
function turnOf() {
  const told: { outcome?: SeneschalOutcome; giveBack?: string }[] = [];
  const turn: SeneschalJob['turn'] = {
    id: 'b1',
    usualMs: 0,
    waitedMs: 0,
    async hold(work, outcome) {
      let v;
      try {
        v = await work();
      } catch (err) {
        told.push({ outcome: { ok: false, error: true, note: (err as Error).message } });
        throw err;
      }
      told.push({ outcome: outcome(v) });
      return v;
    },
    elsewhere: async () => null,
    async giveBack(note) {
      told.push({ giveBack: note });
    },
  };
  return { turn, told };
}
const jobAt = (commit: string, o: Partial<SeneschalJob> = {}) => {
  const t = turnOf();
  const job: SeneschalJob = { id: 'b1', kind: 'pr-check', repo: 'Jcollier0120/Fake', commit, branch: 'claude/x', lane: 'normal', what: "Fake#3's checks", from: { pc: { id: 'p', name: 'DESKTOP' }, id: 't4' }, ...o, turn: t.turn };
  const asks: unknown[] = [];
  const ask = async (a: unknown) => {
    asks.push(a);
    return { job };
  };
  return { ...t, ask, asks };
};
const lines: string[] = [];
const work = (ask: (a: any) => Promise<any>) => workForOthers({ settings: ctx.settings, ctxOf: async () => ctx, say: (l) => lines.push(l), ask: ask as never });

// Another PC's kit trial (Seneschal 0.2.3). The Steward: kit 1.0.0 released (kit-v1.0.0, npu = 1) on its main, and the
// kit under trial, 1.0.1 (npu = 2), on its branch claude/kit, pushed from another clone, so this PC's clone of it has it
// only once fetched; and a kit made on no branch of it (a fork's PR, say), which its clone has.
const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');
const steward = fakeEmployee(path.join(home, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.0\n', 'kit/node/npu.ts': 'export const npu = 1;\n', 'tools/kit.ts': kitTool } });
const gitIn = (dir: string, ...args: string[]) => sh(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args);
gitIn(steward.checkout, 'tag', 'kit-v1.0.0');
gitIn(steward.checkout, 'push', '-q', 'origin', 'kit-v1.0.0');
const elsewhere = path.join(home, 'steward-elsewhere');
gitIn(home, 'clone', '-q', steward.origin, elsewhere);
gitIn(elsewhere, 'switch', '-q', '-c', 'claude/kit');
writeFileSync(path.join(elsewhere, 'kit', 'VERSION'), '1.0.1\n');
writeFileSync(path.join(elsewhere, 'kit', 'node', 'npu.ts'), 'export const npu = 2;\n');
writeFileSync(path.join(elsewhere, 'kit', 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1\n\n**npu is 2.**\n\n### What changed\n\n- npu is 2.\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n');
gitIn(elsewhere, 'add', '-A');
gitIn(elsewhere, 'commit', '-q', '-m', 'kit 1.0.1');
gitIn(elsewhere, 'push', '-q', 'origin', 'claude/kit');
const kitCommit = sh(elsewhere, 'rev-parse', 'HEAD');
const KIT = `1.0.1-${kitCommit.slice(0, 12)}`;
gitIn(steward.checkout, 'checkout', '-q', '--detach');
writeFileSync(path.join(steward.checkout, 'kit', 'VERSION'), '1.0.1\n');
gitIn(steward.checkout, 'commit', '-q', '-am', 'kit 1.0.1, on no branch');
const offKit = `1.0.1-${sh(steward.checkout, 'rev-parse', 'HEAD').slice(0, 12)}`;
gitIn(steward.checkout, 'push', '-q', 'origin', 'HEAD:refs/pull/9/head');
gitIn(steward.checkout, 'checkout', '-q', 'main');

// An agent on kit 1.0.0, whose check writes down where it ran, the kit it was filled from (STEWARD_KIT), the kit its
// kit.json pins and whether its src\kit has kit 1.0.1's npu; and fails where its commit says so.
const TRIED = path.join(home, 'tried.txt');
const TRY = `import { appendFileSync, existsSync, readFileSync } from 'node:fs';\nconst npu = existsSync('src/kit/npu.ts') ? readFileSync('src/kit/npu.ts', 'utf8') : '';\nappendFileSync(${JSON.stringify(TRIED)}, JSON.stringify({ cwd: process.cwd(), kit: process.env.STEWARD_KIT ?? null, pin: JSON.parse(readFileSync('kit.json', 'utf8')).kit, npu2: npu.includes('npu = 2') }) + '\\n');\nprocess.exit(existsSync('FAIL') ? 1 : 0);\n`;
const agent = fakeEmployee(path.join(home, 'agent'), { files: { 'tools/kit.ts': kitTool, 'try.mjs': TRY } });
const tried = employee(agent.checkout, { id: 'tried', name: 'Tried', repo: 'Jcollier0120/Tried', test: ['node try.mjs'] });
const agentMain = sh(agent.checkout, 'rev-parse', 'HEAD');
// Its PR that pins the kit under trial, and a commit on its main that fails.
gitIn(agent.checkout, 'switch', '-q', '-c', 'claude/kit-1.0.1');
writeFileSync(path.join(agent.checkout, 'kit.json'), '{\n  "kit": "1.0.1",\n  "parts": ["node"]\n}\n');
gitIn(agent.checkout, 'commit', '-q', '-am', 'Tried: the kit 1.0.1');
gitIn(agent.checkout, 'push', '-q', 'origin', 'claude/kit-1.0.1');
const pairHead = sh(agent.checkout, 'rev-parse', 'HEAD');
gitIn(agent.checkout, 'switch', '-q', 'main');
writeFileSync(path.join(agent.checkout, 'FAIL'), 'it fails\n');
gitIn(agent.checkout, 'add', 'FAIL');
gitIn(agent.checkout, 'commit', '-q', '-m', 'it fails');
gitIn(agent.checkout, 'push', '-q', 'origin', 'main');
const agentFails = sh(agent.checkout, 'rev-parse', 'HEAD');

const kitCtx = { ...ctx, settings: { ...ctx.settings, employees: [...ctx.settings.employees, tried], stewardCheckout: steward.checkout } };
const workKit = (ask: (a: any) => Promise<any>, settings = kitCtx.settings) => workForOthers({ settings, ctxOf: async () => ({ ...kitCtx, settings }), say: (l) => lines.push(l), ask: ask as never });
const trialAt = (commit: string, o: Partial<SeneschalJob> = {}) => jobAt(commit, { kind: 'kit-trial', repo: 'Jcollier0120/Tried', branch: undefined, kit: KIT, agent: 'tried', lane: 'background', what: "Tried's trial of kit 1.0.1", ...o });
const triedRuns = () => (existsSync(TRIED) ? readFileSync(TRIED, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cwd: string; kit: string | null; pin: string; npu2: boolean }) : []);
const noWorktrees = () => assert.deepEqual([trialDirOf(kitCtx.settings, tried), othersDirOf(kitCtx.settings, tried), othersKitDirOf(kitCtx.settings)].filter((d) => existsSync(d)), [], 'its worktrees are removed after');

test('the repositories it runs: each with checks in Settings and its clone on this PC', () => {
  assert.deepEqual(workersFor(ctx.settings).map((x) => x.id), ['fake']);
});

test("only a commit on one of the repository's own branches is run: the task's branch, else the employee's", async () => {
  assert.equal(await fetchJob(ctx, e, checkout, { commit: onBranch, branch: 'claude/x' }), null);
  assert.equal(await fetchJob(ctx, e, checkout, { commit: main }), null, 'on main');
  assert.match((await fetchJob(ctx, e, checkout, { commit: offBranch, branch: 'claude/x' }))!, /isn't on origin\/claude\/x or origin\/main of Jcollier0120\/Fake/);
  assert.match((await fetchJob(ctx, e, checkout, { commit: onBranch, branch: 'nowhere' }))!, /isn't on origin\/nowhere or origin\/main/, "a branch the repository hasn't");
});

test("another PC's task runs here in a worktree of its own, and its pass goes back with the commands run", async () => {
  const j = jobAt(onBranch);
  const r = await work(j.ask);
  assert.deepEqual(r, { ran: 'b1', why: 'passed', retryMs: 0 });
  assert.deepEqual(j.told, [{ outcome: { ok: true, commands: ['node check.mjs'] } }]);
  assert.deepEqual(readFileSync(RAN, 'utf8').trim().split('\n').map((d) => path.resolve(d)), [path.resolve(othersDirOf(ctx.settings, e))]);
  assert.ok(!existsSync(othersDirOf(ctx.settings, e)), 'its worktree is removed after');
  assert.deepEqual(j.asks, [{ worker: 'steward', kinds: ['pr-check', 'full-suite'], repos: ['Jcollier0120/Fake'], slot: 'others', say: (j.asks[0] as { say: unknown }).say }]);
  assert.ok(lines.some((l) => /\[fake\] for DESKTOP's Seneschal \(b1, t4 there\): passed/.test(l)), lines.join('\n'));
});

test("a shard of another PC's whole suite, for checks with no npm test to cut, runs them all: never none", async () => {
  const j = jobAt(onBranch, { kind: 'full-suite', shard: { index: 2, of: 2 }, what: "Fake's full suite, shard 2 of 2" });
  const r = await work(j.ask);
  assert.deepEqual(r, { ran: 'b1', why: 'passed', retryMs: 0 });
  assert.equal(readFileSync(RAN, 'utf8').trim().split('\n').length, 1, 'node check.mjs ran');
});

test('a failure goes back as one, with its note', async () => {
  const j = jobAt(fails, { branch: 'claude/fails' });
  const r = await work(j.ask);
  assert.equal(r.ran, 'b1');
  assert.match(r.why, /failed: node check\.mjs failed \(exit 1\)/);
  assert.equal(j.told[0].outcome!.ok, false);
  assert.equal(j.told[0].outcome!.error, undefined);
  assert.match(j.told[0].outcome!.note!, /node check\.mjs failed/);
});

test("a commit on no branch of the repository isn't run: the run couldn't happen here, and the Seneschal is told so", async () => {
  const j = jobAt(offBranch);
  const r = await work(j.ask);
  assert.equal(existsSync(RAN), false, 'nothing ran');
  assert.match(r.why, /isn't on origin\/claude\/x or origin\/main/);
  assert.deepEqual([j.told[0].outcome!.ok, j.told[0].outcome!.error], [false, true]);
});

test("a task of a repository it doesn't run here is given back unstarted; one a stage holds isn't asked for", async () => {
  const j = jobAt(onBranch, { repo: 'Jcollier0120/Other' });
  const r = await work(j.ask);
  assert.equal(r.ran, null);
  assert.deepEqual(j.told, [{ giveBack: "the Steward here doesn't run Jcollier0120/Other's checks now" }]);
  mkdirSync(repoLock('fake'), { recursive: true });
  try {
    const held = jobAt(onBranch);
    await work(held.ask);
    assert.deepEqual((held.asks[0] as { repos: string[] }).repos, [], "a round holds Fake's clone (it may be waiting on this very task)");
  } finally {
    rmSync(repoLock('fake'), { recursive: true, force: true });
  }
});

test("what a run came to, for its report: one that couldn't finish is the Seneschal's to try again", () => {
  assert.deepEqual(outcomeOf(null, {}, ['npm test']), { ok: true, commands: ['npm test'] });
  assert.deepEqual(outcomeOf('npm test failed (exit 1)', {}, ['npm test']), { ok: false, note: 'npm test failed (exit 1)', commands: ['npm test'] });
  assert.equal(outcomeOf('npm test was stopped at its time limit', { timedOut: true }, []).error, true);
  assert.equal(outcomeOf(`${PACKAGES_HELD}: esbuild`, {}, []).error, true);
  assert.equal(outcomeOf('npm test failed (exit 3221225786)', {}, []).error, true, 'Windows ended it');
});

test("another PC's kit trial: the agent's main bumped to the kit made from the Steward's commit, its checks run once with it, both worktrees removed", async () => {
  // A base: the PC that asked ran only the tests the kit's files reach (kitreach.ts), as this one works them out again.
  const j = trialAt(agentMain, { base: agentMain });
  const r = await workKit(j.ask);
  assert.deepEqual(r, { ran: 'b1', why: 'passed', retryMs: 0 }, lines.join('\n'));
  assert.deepEqual(j.told, [{ outcome: { ok: true, commands: ['node try.mjs'] } }]);
  const runs = triedRuns();
  assert.equal(runs.length, 1, 'its checks ran once');
  assert.deepEqual({ ...runs[0], cwd: path.resolve(runs[0].cwd) }, { cwd: path.resolve(trialDirOf(kitCtx.settings, tried)), kit: path.resolve(othersKitDirOf(kitCtx.settings), 'kit'), pin: '1.0.1', npu2: true });
  noWorktrees();
  assert.deepEqual((j.asks[0] as { kinds: string[] }).kinds, ['pr-check', 'kit-trial', 'full-suite']);
  assert.ok(lines.some((l) => l.includes(`[tried] for DESKTOP's Seneschal (b1, t4 there): kit ${KIT} made from the Steward's ${kitCommit.slice(0, 7)}`)), lines.join('\n'));
});

test("a kit trial's failure goes back as one, its checks run once: the PC that asked weighs it as its own trial's", async () => {
  const j = trialAt(agentFails);
  const r = await workKit(j.ask);
  assert.equal(r.ran, 'b1');
  assert.match(r.why, /^failed: node try\.mjs failed \(exit 1\)/);
  assert.deepEqual([j.told.length, j.told[0].outcome!.ok, j.told[0].outcome!.error], [1, false, undefined]);
  assert.match(j.told[0].outcome!.note!, /node try\.mjs failed/);
  assert.equal(triedRuns().length, 1, 'no second try, nor a run without the kit');
  noWorktrees();
});

test("an agent's PR that pins the kit under trial runs at its head as it is, filled from that kit", async () => {
  const j = trialAt(pairHead, { pr: 12, branch: 'claude/kit-1.0.1', what: "Tried#12 with kit 1.0.1" });
  const r = await workKit(j.ask);
  assert.deepEqual(r, { ran: 'b1', why: 'passed', retryMs: 0 }, lines.join('\n'));
  const runs = triedRuns();
  assert.deepEqual({ ...runs[0], cwd: path.resolve(runs[0].cwd) }, { cwd: path.resolve(othersDirOf(kitCtx.settings, tried)), kit: path.resolve(othersKitDirOf(kitCtx.settings), 'kit'), pin: '1.0.1', npu2: true });
  noWorktrees();
});

test("a kit made on no branch of the Steward's origin isn't tried, nor one its commit doesn't make: the Seneschal is told the run couldn't happen here", async () => {
  for (const [kit, why] of [
    [offKit, /isn't on any branch of the Steward's origin/],
    [`1.0.2-${kitCommit.slice(0, 12)}`, new RegExp(`makes kit ${KIT}, not 1\.0\.2-`)],
  ] as const) {
    const j = trialAt(agentMain, { kit });
    const r = await workKit(j.ask);
    assert.match(r.why, why);
    assert.deepEqual([j.told.length, j.told[0].outcome!.ok, j.told[0].outcome!.error], [1, false, true]);
    assert.equal(triedRuns().length, 0, 'nothing ran');
    noWorktrees();
  }
});

test("a kit under trial is made only from a commit on one of the Steward's own branches, fetched from its origin", async () => {
  assert.deepEqual(kitCommitOf(KIT), { version: '1.0.1', commit: kitCommit.slice(0, 12) });
  assert.equal(kitCommitOf('1.0.1'), null, 'a released kit names no commit');
  assert.equal(kitCommitOf(`1.0.1-${kitCommit.slice(0, 11)}`), null);
  assert.deepEqual(await fetchKit(kitCtx, steward.checkout, KIT), { commit: kitCommit });
  assert.match((await fetchKit(kitCtx, steward.checkout, offKit) as { not: string }).not, /isn't on any branch of the Steward's origin/);
  assert.match((await fetchKit(kitCtx, steward.checkout, `1.0.1-${'0'.repeat(12)}`) as { not: string }).not, /has no commit 000000000000/);
  assert.match((await fetchKit(kitCtx, steward.checkout, '1.0.1') as { not: string }).not, /names no commit/);
});

test("a kit trial is asked for only while the Steward's clone is here and no stage holds it; one for an agent not here goes back unstarted", async () => {
  assert.deepEqual(kindsFor(kitCtx.settings), ['pr-check', 'kit-trial', 'full-suite']);
  assert.deepEqual(kindsFor(ctx.settings), ['pr-check', 'full-suite'], 'no clone of the Steward here');
  mkdirSync(repoLock('steward'), { recursive: true });
  try {
    assert.deepEqual(kindsFor(kitCtx.settings), ['pr-check', 'full-suite'], 'a stage holds it');
  } finally {
    rmSync(repoLock('steward'), { recursive: true, force: true });
  }
  const other = trialAt(agentMain, { agent: 'nobody' });
  assert.equal((await workKit(other.ask)).ran, null);
  assert.deepEqual(other.told, [{ giveBack: "the Steward here doesn't run nobody's checks now" }]);
  const none = trialAt(agentMain);
  assert.equal((await workKit(none.ask, { ...kitCtx.settings, stewardCheckout: path.join(home, 'no-steward') })).ran, null);
  assert.deepEqual(none.told, [{ giveBack: "the Steward's own clone isn't on this PC, to make the kit under trial from" }]);
  assert.equal(triedRuns().length, 0);
});
