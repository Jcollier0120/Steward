import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The whole suite before a kit's release, run beside the rounds as on the Steward's page (wholeSuitesBeside in
// stages/wholesuite.ts), on wholesuite-fake.ts' fake Steward repository: started by a round, waited for, held, stopped,
// and ended when the Steward that ran it is gone. Run in the round: wholesuite.test.ts.
const { home, ran, failTests, note, head, commit, ctx, lines, facts } = await import('./wholesuite-fake.ts');
const { releaseSelf, loadSelfFailures } = await import('../src/stages/self.ts');
const { endWholeOrphans, endWholeSuite, loadWholeJob, wholeJobFile, wholeSuiteDone, wholeSuitesBeside } = await import('../src/stages/wholesuite.ts');
const { apart } = await import('../src/stages/slots.ts');
const { alive } = await import('../src/kit/apart.ts');
const { until } = await import('../kit/test/until.ts');
type WholeJob = import('../src/stages/wholesuite.ts').WholeJob;

// Its tests note their process ids and wait while the hold file is there, so a round that waited for them would never
// come back.
const hold = path.join(home, 'hold');
const pidsFile = path.join(home, 'pids.txt');
const pidsNow = () => (existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const testsRan = () => lines().filter((l) => l === 'test').length;
const ended: WholeJob[] = [];
const besideLines: string[] = [];
const besideOn = () => wholeSuitesBeside({ ended: (j) => ended.push(j), log: (l) => besideLines.push(l) });
const fresh = () => {
  for (const f of [ran, pidsFile]) if (existsSync(f)) unlinkSync(f);
};
const sha = () => head().slice(0, 7);
const waitingTests =
  note('test', failTests) +
  `fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');\n` +
  `while (fs.existsSync(${JSON.stringify(hold)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);\n`;

test('beside the rounds, a round starts the whole suite and goes on at once; later rounds wait for it, with no second run, and the first after it passes releases the kit', async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('tools/test.js', waitingTests);
  writeFileSync(hold, '');
  fresh();
  const first = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(first.map((x) => x.outcome), ['skipped'], first.map((x) => x.message).join('\n'));
  assert.match(first[0].message, new RegExp(`^self: kit-v1\\.1\\.0 waits: its whole suite started beside the rounds at ${sha()}: the rounds go on meanwhile`));
  await until(() => pidsNow().length === 1, 60_000, 'its tests running');
  assert.equal(loadWholeJob()?.state, 'running');
  assert.equal(loadWholeJob()?.commit, head());

  const second = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(second.map((x) => x.outcome), ['skipped']);
  assert.match(second[0].message, new RegExp(`^self: kit-v1\\.1\\.0 waits: its whole suite runs beside the rounds at ${sha()}, started .* ago`));
  assert.equal(testsRan(), 1, 'no second run beside it');
  assert.equal(pidsNow().length, 1);

  unlinkSync(hold);
  await wholeSuiteDone();
  assert.deepEqual(ended.map((j) => j.state), ['passed'], 'told once it ended');
  assert.equal(loadWholeJob()?.state, 'passed');
  assert.ok(!existsSync(path.join(home, 'work', '_steward-whole')), 'its worktree removed');
  const third = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(third.map((x) => x.outcome), ['done', 'done'], third.map((x) => x.message).join('\n'));
  assert.ok(lines().includes('kit-release --publish'), 'the kit released');
  assert.equal(testsRan(), 1, 'not run again');
});

test('beside the rounds, the whole suite never runs beside a kit trial or a rollout: it waits for them to end, and the round after starts it', async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('NOTES.md', 'beside a trial\n');
  fresh();
  for (const work of ['kit trial', 'rollout']) {
    let end!: () => void;
    const ended = new Promise<void>((r) => (end = r));
    const other = apart(work, () => ended);
    const waits = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
    end();
    await other;
    assert.deepEqual(waits.map((x) => x.outcome), ['skipped'], waits.map((x) => x.message).join('\n'));
    assert.equal(waits[0].message, `self: kit-v1.1.0 waits: its whole suite waits for the ${work} running beside the rounds to end, so the two never test at once: the rounds go on meanwhile`);
    assert.equal(testsRan(), 0, 'nothing run');
  }
  const starts = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.match(starts[0].message, new RegExp(`^self: kit-v1\\.1\\.0 waits: its whole suite started beside the rounds at ${sha()}`));
  await wholeSuiteDone();
  const done = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(done.map((x) => x.outcome), ['done', 'done'], done.map((x) => x.message).join('\n'));
  assert.equal(testsRan(), 1);
});

test('beside the rounds, a whole suite that fails twice holds the kit as a failed release, which later rounds leave held', async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('NOTES.md', 'beside, failing\n');
  writeFileSync(failTests, '');
  fresh();
  const started = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(started.map((x) => x.outcome), ['skipped']);
  await wholeSuiteDone();
  unlinkSync(failTests);
  assert.equal(ended.at(-1)?.state, 'failed');
  assert.equal(testsRan(), 2, 'run once more first');

  const held = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(held.map((x) => x.outcome), ['failed', 'skipped']);
  assert.match(held[0].message, /^self: its whole suite failed at [0-9a-f]{7}, twice: npm test failed \(exit 1\).*, so kit-v1\.1\.0 wasn't released$/s);
  assert.equal(loadSelfFailures()['kit-v1.1.0'].commit, head(), 'held until a new commit lands on main');
  assert.ok(!lines().some((l) => l.startsWith('kit-release')), 'nothing published');
  await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.equal(testsRan(), 2, 'not run again while held');
});

test('beside the rounds, a new commit on main stops the whole suite for the old one, its tests ended, and starts one at the new; the Steward stopping ends it, and the next round starts it again', async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('NOTES.md', 'beside, superseded\n');
  writeFileSync(hold, '');
  fresh();
  const old = sha();
  await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  await until(() => pidsNow().length === 1, 60_000, 'its tests running');
  const [oldTests] = pidsNow();

  commit('NOTES.md', 'beside, newer\n');
  const told = ended.length;
  const next = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.match(next[0].message, new RegExp(`^self: kit-v1\\.1\\.0 waits: its whole suite started beside the rounds at ${sha()}`));
  await until(() => !alive(oldTests), 30_000, 'the old tests ended');
  assert.ok(ctx.lines.some((l) => l.includes(`kit-v1.1.0's whole suite at ${old} stopped: main moved on to ${sha()}`)), ctx.lines.join('\n'));
  assert.equal(ended.length, told, 'a run stopped is no verdict to settle');
  assert.equal(loadWholeJob()?.commit, head());
  assert.equal(loadWholeJob()?.state, 'running');

  await until(() => pidsNow().length === 2, 60_000, 'the new tests running');
  const newTests = pidsNow()[1];
  endWholeSuite();
  assert.equal(loadWholeJob()?.state, 'ended');
  assert.match(loadWholeJob()?.why ?? '', /was stopped: the Steward stopped$/);
  await until(() => !alive(newTests), 30_000, 'its tests ended with it');
  await wholeSuiteDone();
  assert.equal(ended.length, told, 'nor one the Steward stopped');

  const restarted = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.match(restarted[0].message, /waits: its whole suite started beside the rounds/);
  assert.ok(ctx.lines.some((l) => /kit-v1\.1\.0: its whole suite at [0-9a-f]{7} again \(its whole suite at [0-9a-f]{7} was stopped: the Steward stopped\)/.test(l)));
  unlinkSync(hold);
  await wholeSuiteDone();
  assert.equal(ended.at(-1)?.state, 'passed');
});

test("beside the rounds, a whole suite is stopped once the Steward's own turn is another PC's: that PC's Steward runs it", async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('NOTES.md', 'beside, another PC\n');
  writeFileSync(hold, '');
  fresh();
  await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  await until(() => pidsNow().length === 1, 60_000, 'its tests running');
  const [tests] = pidsNow();
  const elsewhere = { ...ctx, lease: { ok: async () => false, skip: new Set<string>(['steward']), has: () => true } };
  const out = await releaseSelf(elsewhere, facts(['v0.8.0', 'kit-v1.0.0']));
  unlinkSync(hold);
  assert.deepEqual(out.map((x) => x.message), ['self: kit-v1.1.0 is left to another PC, whose turn it is now']);
  await until(() => !alive(tests), 30_000, 'its tests ended');
  assert.equal(loadWholeJob()?.state, 'ended');
  assert.match(loadWholeJob()?.why ?? '', /was stopped: the Steward's own turn is another PC's now$/);
});

test("a whole suite a Steward that is gone left running is ended, with the program it left, and its record says so", async () => {
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.ok(left.pid && alive(left.pid));
    writeFileSync(wholeJobFile(), JSON.stringify({ tag: 'kit-v1.1.0', commit: head(), state: 'running', startedAt: new Date().toISOString(), by: gone, pids: [left.pid] }));
    const said: string[] = [];
    endWholeOrphans((l) => said.push(l));
    await until(() => !alive(left.pid!), 30_000, 'the program it left ended');
    const job = loadWholeJob();
    assert.equal(job?.state, 'ended');
    assert.deepEqual(job?.pids, []);
    assert.equal(job?.why, `the Steward that ran it (process ${gone}) ended before it did, and the program it left running was ended`);
    assert.match(said[0], /kit-v1\.1\.0's whole suite at [0-9a-f]{7}: the Steward that ran it/);

    // One this Steward runs, or one a live Steward does, is left alone.
    writeFileSync(wholeJobFile(), JSON.stringify({ tag: 'kit-v1.1.0', commit: head(), state: 'running', startedAt: new Date().toISOString(), by: process.pid, pids: [] }));
    endWholeOrphans();
    assert.equal(loadWholeJob()?.state, 'running');
  } finally {
    left.kill();
    writeFileSync(wholeJobFile(), 'null');
  }
});
