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

const { fetchJob, othersDirOf, outcomeOf, workersFor, workForOthers } = await import('../src/stages/others.ts');
const { PACKAGES_HELD } = await import('../src/stages/bump.ts');
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

beforeEach(() => rmSync(RAN, { force: true }));

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
