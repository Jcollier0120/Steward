import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { stillFor, until } from './until.ts';

// The manor's pace (pace.ts, kit 2.43.3): first rounds one at a time, below-normal priority, and the page settling in.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-pace-'));
// Retried: the gentle test's DLL stays loaded until its PowerShell worker has gone.
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { AGENTS_AT_ONCE, FIRST_ROUND_WAITING, LOAD, WORK_WAITING, agentsAtOnce, inFirstRoundTurn, inWorkTurn, measureLoad, pace, setPriorityFor, slotsFor } = await import('./fixture/src/kit/pace.ts');
const { LockTimeout } = await import('./fixture/src/kit/npu-queue.ts');
const { every, firstRoundDone, roundFile } = await import('./fixture/src/kit/schedule.ts');
const { readJson } = await import('./fixture/src/kit/store.ts');
const { pillOf, settlingText } = await import('./fixture/src/kit/page.ts');
const { lookFor } = await import('./fixture/src/kit/look.ts');

const manorWith = (name: string, settings: unknown) => {
  const dir = path.join(home, name);
  mkdirSync(path.join(dir, 'app'), { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
};

test("the pace: Manor's backgroundPace, gentle unless it says; full under node --test unless MANOR_PACE says", () => {
  assert.equal(pace('gentle', manorWith('m-full', { backgroundPace: 'full' }), {}), 'full');
  assert.equal(pace('gentle', manorWith('m-none', {}), {}), 'gentle', "Manor doesn't say: the agent's own");
  assert.equal(pace('gentle', manorWith('m-odd', { backgroundPace: 'fast' }), {}), 'gentle', 'anything else: as if unsaid');
  assert.equal(pace('gentle', path.join(home, 'no-manor'), {}), 'gentle');
  assert.equal(pace('gentle', manorWith('m-g', { backgroundPace: 'gentle' }), { NODE_TEST_CONTEXT: 'child' }), 'full', 'a test never waits in the real line');
  assert.equal(pace('full', path.join(home, 'no-manor'), { NODE_TEST_CONTEXT: 'child', MANOR_PACE: 'gentle' }), 'gentle');
});

test('priority: below normal at a gentle pace, normal at a full one; the setting alone decides', () => {
  const set: number[] = [];
  const to = (v: number) => void set.push(v);
  const { PRIORITY_BELOW_NORMAL, PRIORITY_NORMAL } = os.constants.priority;
  assert.equal(setPriorityFor('gentle', to), true);
  setPriorityFor('full', to);
  assert.deepEqual(set, [PRIORITY_BELOW_NORMAL, PRIORITY_NORMAL]);
  assert.equal(
    setPriorityFor('gentle', () => {
      throw new Error('refused');
    }),
    false,
    'never throws',
  );
});

test('first rounds, one at a time: the second waits until the first has finished, and says so; later rounds and a full pace never wait', async () => {
  const dir = path.join(home, 'locks', 'first-rounds');
  mkdirSync(path.dirname(dir), { recursive: true });
  const order: string[] = [];
  const waits: boolean[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const a = inFirstRoundTurn('gentle', true, async () => {
    order.push('a starts');
    await held;
    order.push('a ends');
  }, { who: 'a', limitMs: 60_000, dir });
  await until(() => order.includes('a starts'));
  const b = inFirstRoundTurn('gentle', true, async () => void order.push('b starts'), { who: 'b', limitMs: 60_000, dir, onWait: (w) => waits.push(w) });
  await until(() => waits.length === 1, 10_000, 'b to wait in line');
  assert.deepEqual(order, ['a starts'], 'b waits in line');
  assert.deepEqual(waits, [true]);
  // Not a first round, or a full pace: at once, whatever the line.
  await inFirstRoundTurn('gentle', false, async () => void order.push('later round'), { who: 'c', limitMs: 60_000, dir });
  await inFirstRoundTurn('full', true, async () => void order.push('full pace'), { who: 'd', limitMs: 60_000, dir });
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a starts', 'later round', 'full pace', 'a ends', 'b starts']);
  assert.deepEqual(waits, [true, false]);
});

test("a schedule's first round: none until one goes through; a round.json from before 2.43.3 counts every schedule it names as through", () => {
  const file = roundFile();
  assert.equal(firstRoundDone('round'), false, 'a new agent');
  writeFileSync(file, JSON.stringify({ rounds: { round: { started: 'x', finished: '2026-10-01T00:00:00.000Z', ok: false, error: 'it failed', everyMs: 1, next: null } } }));
  assert.equal(firstRoundDone('round'), true, 'an agent that ran before this kit: updating never puts it in the line');
  assert.equal(firstRoundDone('grind'), false);
  writeFileSync(file, JSON.stringify({ rounds: { round: { ok: false } }, wentThrough: {} }));
  assert.equal(firstRoundDone('round'), false, 'since 2.43.3, only a round that went through counts');
  writeFileSync(file, JSON.stringify({ rounds: {}, wentThrough: { round: '2026-10-08T00:00:00.000Z' } }));
  assert.equal(firstRoundDone('round'), true);
  assert.ok(readFileSync(file, 'utf8'));
});

test('the page while it settles in: the pill, and the banner only where its first round waits or is a long one', () => {
  const reeve = lookFor('reeve');
  const plain = { ...reeve, firstRound: undefined };
  const duty = { onDuty: true, since: new Date().toISOString() } as any;
  assert.deepEqual([pillOf({ look: plain, duty, first: 'waiting' }).text, pillOf({ look: plain, duty, first: 'waiting' }).kind], ['Settling in', 'busy']);
  assert.equal(pillOf({ look: reeve, duty, busy: true, first: 'running' }).text, 'Settling in');
  assert.equal(pillOf({ look: plain, duty, busy: true, first: 'running' }).text, reeve.busy, 'a first round like any other: its usual words');
  assert.match(settlingText('Reeve', plain, 'waiting')!, /^Reeve is new to the manor and waits its turn/);
  assert.match(settlingText('Reeve', reeve, 'running')!, /^Reeve's first round is under way: finding every repository .* It takes longer than the rounds after it/);
  assert.equal(settlingText('Reeve', plain, 'running'), null);
  assert.equal(settlingText('Reeve', reeve, null), null);
  assert.match(lookFor('heiward').firstRound!, /every drive/);
  assert.match(FIRST_ROUND_WAITING, /one at a time/);
});

// Heiward's background pace for every agent (gentle.ts, kit 2.50.0): efficiency mode, very low disk priority, a cap.
const { gentleCap, gentleDll, gentleScript } = await import('./fixture/src/kit/gentle.ts');

test('the processor cap at a gentle pace: a quarter, and two processors at most', () => {
  assert.equal(gentleCap(4), 2500, '4 processors: a quarter (one)');
  assert.equal(gentleCap(8), 2500, '8: a quarter (two)');
  assert.equal(gentleCap(18), 1111, '18: two of them');
  assert.equal(gentleCap(1), 2500);
  assert.match(path.basename(gentleDll('a')), /^gentle-[0-9a-f]{12}\.dll$/);
  assert.equal(path.basename(path.dirname(gentleDll('a'))), 'kit');
  assert.notEqual(gentleDll('a'), gentleDll('b'), 'a new helper is a new DLL: an old one loaded by a running agent is never overwritten');
});

test('the gentle script: compiles the helper only when asked to, to a name of its own, then sets the process', () => {
  const only = gentleScript(42, true, 1111, 'C:/x/gentle.dll', null);
  assert.doesNotMatch(only, /Add-Type -TypeDefinition/);
  assert.match(only, /\[KitGentle\]::Set\(42, \$true, 1111\)/);
  const first = gentleScript(42, false, 1111, "C:/o'k/gentle.dll", "class A { // can't }");
  assert.match(first, /Add-Type -TypeDefinition 'class A \{ \/\/ can''t \}' -OutputAssembly \$tmp/);
  assert.ok(first.includes("'C:/o''k/gentle.dll'"), 'paths quoted');
  assert.match(first, /\[KitGentle\]::Set\(42, \$false, 1111\)/);
});

test('on Windows, a process set gentle and back: efficiency mode, disk priority and the cap all take, and the worker joins its job', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = await import('node:child_process');
  const { readFileSync: read } = await import('node:fs');
  const { powershell, stopPowerShellWorker } = await import('./fixture/src/kit/ps.ts');
  const source = read(new URL('./fixture/src/kit/gentle.cs', import.meta.url), 'utf8');
  const dll = path.join(home, 'gentle-test.dll');
  // Alive for longer than the three calls can take: the first compiles the DLL, a minute and more at the checks pace on a
  // busy PC. Ended below.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 900000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.equal((await powershell(gentleScript(child.pid!, true, 2500, dll, source), { timeoutMs: 120_000 })).trim(), 'eco io cap worker');
    assert.equal((await powershell(gentleScript(child.pid!, true, 2500, dll, null))).trim(), 'eco io cap worker', 'again: the same job, the worker in it already');
    assert.equal((await powershell(gentleScript(child.pid!, false, 2500, dll, null))).trim(), 'eco io cap', 'lifted');
  } finally {
    child.kill();
    stopPowerShellWorker();
  }
});

test("agents at once: Manor's agentsAtOnce, else two at a gentle pace and four at a full one; 0 lifts the line", () => {
  const none = path.join(home, 'no-manor');
  assert.deepEqual([agentsAtOnce('gentle', none, {}), agentsAtOnce('full', none, {})], [AGENTS_AT_ONCE.gentle, AGENTS_AT_ONCE.full]);
  assert.deepEqual([AGENTS_AT_ONCE.gentle, AGENTS_AT_ONCE.full], [2, 4]);
  assert.equal(agentsAtOnce('gentle', manorWith('a-3', { agentsAtOnce: 3 }), {}), 3);
  assert.equal(agentsAtOnce('full', manorWith('a-0', { agentsAtOnce: 0 }), {}), null, 'no line, as before kit 2.56.0');
  assert.equal(agentsAtOnce('full', manorWith('a-big', { agentsAtOnce: 40 }), {}), AGENTS_AT_ONCE.most);
  assert.equal(agentsAtOnce('gentle', manorWith('a-odd', { agentsAtOnce: 'lots' }), {}), 2, 'anything else: as if unsaid');
  assert.equal(agentsAtOnce('gentle', manorWith('a-g', { agentsAtOnce: 3 }), { NODE_TEST_CONTEXT: 'child' }), null, 'a test never waits in the real line');
  assert.equal(agentsAtOnce('gentle', none, { NODE_TEST_CONTEXT: 'child', MANOR_AGENTS_AT_ONCE: '1' }), 1);
  assert.equal(agentsAtOnce('gentle', manorWith('a-env', { agentsAtOnce: 3 }), { MANOR_AGENTS_AT_ONCE: '0' }), null, 'the variable says instead of Manor');
});

test('the load: every slot on a quiet PC, half on a fairly busy one, one on a busy one or short of memory', () => {
  const quiet = { busy: 0.1, freeMemory: 0.5 };
  assert.equal(slotsFor(4, quiet), 4);
  assert.equal(slotsFor(4, { ...quiet, busy: LOAD.someBusy }), 2);
  assert.equal(slotsFor(3, { ...quiet, busy: LOAD.someBusy }), 2);
  assert.equal(slotsFor(2, { ...quiet, busy: LOAD.someBusy }), 1);
  assert.equal(slotsFor(4, { ...quiet, busy: LOAD.busy }), 1);
  assert.equal(slotsFor(4, { ...quiet, freeMemory: LOAD.lowMemory / 2 }), 1);
  assert.equal(slotsFor(1, quiet), 1);
});

test("the load is measured from Node's own counters: shares between 0 and 1", async () => {
  const l = await measureLoad(50);
  assert.ok(l.busy >= 0 && l.busy <= 1, String(l.busy));
  assert.ok(l.freeMemory > 0 && l.freeMemory <= 1, String(l.freeMemory));
});

test('the work line: rounds side by side up to its slots, the next when one ends; one at a time on a busy PC; none with no line', async () => {
  const dir = path.join(home, 'locks', 'work');
  mkdirSync(path.dirname(dir), { recursive: true });
  const quiet = async () => ({ busy: 0.05, freeMemory: 0.6 });
  const busy = async () => ({ busy: 0.9, freeMemory: 0.6 });
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const round = (who: string, load = quiet, slots: number | null = 2) =>
    inWorkTurn('gentle', async () => {
      order.push(`${who} starts`);
      await new Promise<void>((r) => gates.set(who, r));
      order.push(`${who} ends`);
    }, { who, limitMs: 60_000, waitMs: 30_000, dir, slots, load });
  const a = round('a');
  await until(() => order.includes('a starts'));
  const b = round('b');
  await until(() => order.includes('b starts'));
  assert.deepEqual(order, ['a starts', 'b starts'], 'two side by side');
  const c = round('c');
  await stillFor();
  assert.deepEqual(order, ['a starts', 'b starts'], 'the third waits its turn');
  gates.get('a')!();
  await until(() => order.includes('c starts'));
  assert.deepEqual(order.slice(2), ['a ends', 'c starts'], 'and takes the slot a gave up');
  gates.get('b')!();
  await until(() => order.includes('b ends'));
  // b's slot is free, but on a busy PC a round may take only the first slot, which c holds.
  const d = round('d', busy);
  // No line: at once, whatever it holds.
  const e = round('e', quiet, null);
  await until(() => order.includes('e starts'));
  await stillFor();
  assert.ok(!order.includes('d starts'), 'a busy PC: one at a time');
  gates.get('e')!();
  gates.get('c')!();
  await until(() => order.includes('d starts'), 10_000, 'd once c has ended');
  gates.get('d')!();
  await Promise.all([a, b, c, d, e]);
});

test("the work line: a round whose turn never comes throws the line's LockTimeout, which every() takes as a round that waited", async () => {
  const dir = path.join(home, 'locks', 'work-timeout');
  mkdirSync(path.dirname(dir), { recursive: true });
  let release!: () => void;
  const held = inWorkTurn('gentle', () => new Promise<void>((r) => (release = r)), { who: 'holder', limitMs: 60_000, waitMs: 30_000, dir, slots: 1 });
  await until(() => release, 10_000, 'the holder to take the slot');
  await assert.rejects(inWorkTurn('gentle', async () => {}, { who: 'late', limitMs: 60_000, waitMs: 400, dir, slots: 1 }), LockTimeout);
  release();
  await held;
});

test("a scheduled round takes its turn in the work line, and round.json says how long it waited; a round asked for doesn't wait", async () => {
  process.env.MANOR_AGENTS_AT_ONCE = '1';
  const { setDuty } = await import('./fixture/src/kit/duty.ts');
  setDuty(true);
  let release!: () => void;
  const held = inWorkTurn('full', () => new Promise<void>((r) => (release = r)), { who: 'another agent', limitMs: 60_000, waitMs: 30_000 });
  const ran: string[] = [];
  const job = every(3_600_000, async () => void ran.push('round'), { name: 'work-line', firstDelayMs: 50 });
  try {
    await until(() => job.state.waiting === WORK_WAITING, 10_000, 'the round to wait for the slot');
    const seenWaiting = Date.now();
    // Held a second at least: round.json notes a wait of a second or more.
    while (Date.now() - seenWaiting < 1_000) await stillFor(50);
    assert.deepEqual([...ran], [], 'the one slot is held: it waits');
    assert.equal(job.state.runningSince, null, 'not running while it waits');
    assert.equal(job.state.waiting, WORK_WAITING, 'and says so: never taken for a schedule with nothing coming');
    const released = Date.now();
    release();
    await until(() => ran.length > 0 && !job.running, 10_000, 'the round, once the slot is free');
    const r = readJson<{ rounds: Record<string, { ok: boolean; waitedMs?: number }> }>(roundFile(), { rounds: {} }).rounds['work-line'];
    assert.equal(r.ok, true);
    assert.equal(job.state.waiting, null);
    assert.ok((r.waitedMs ?? 0) >= released - seenWaiting, `it waited until the slot was free (${r.waitedMs})`);
    // Run now never waits, whoever holds the slot.
    let again: (() => void) | undefined;
    const holding = inWorkTurn('full', () => new Promise<void>((r2) => (again = r2)), { who: 'another agent', limitMs: 60_000, waitMs: 30_000 });
    await until(() => again, 10_000, 'the other agent to take the slot');
    assert.ok(job.runNow());
    await until(() => ran.length === 2 && !job.running, 10_000, 'the round asked for');
    assert.deepEqual([...ran], ['round', 'round']);
    // Nor does a light schedule's round: light always, or as a function says before each round.
    const light = every(3_600_000, async () => void ran.push('light'), { name: 'light', firstDelayMs: 20, light: true });
    const lightNow = every(3_600_000, async () => void ran.push('light now'), { name: 'light-now', firstDelayMs: 20, light: () => true });
    try {
      await until(() => ran.includes('light') && !light.running, 10_000, 'a light round while the slot is held');
      await until(() => ran.includes('light now') && !lightNow.running, 10_000, 'a round light as a function says');
    } finally {
      light.stop();
      lightNow.stop();
    }
    again!();
    await holding;
  } finally {
    job.stop();
    delete process.env.MANOR_AGENTS_AT_ONCE;
    await held;
  }
});
