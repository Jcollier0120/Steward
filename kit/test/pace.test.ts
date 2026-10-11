import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The manor's pace (pace.ts, kit 2.43.3): first rounds one at a time, below-normal priority, and the page settling in.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-pace-'));
// Retried: the gentle test's DLL stays loaded until its PowerShell worker has gone.
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { FIRST_ROUND_WAITING, inFirstRoundTurn, pace, setPriorityFor } = await import('./fixture/src/kit/pace.ts');
const { firstRoundDone, roundFile } = await import('./fixture/src/kit/schedule.ts');
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

test('priority: below normal for a scheduled round at a gentle pace; normal when full, or when someone asked for it', () => {
  const set: number[] = [];
  const to = (v: number) => void set.push(v);
  const { PRIORITY_BELOW_NORMAL, PRIORITY_NORMAL } = os.constants.priority;
  assert.equal(setPriorityFor('gentle', false, to), true);
  setPriorityFor('gentle', true, to);
  setPriorityFor('full', false, to);
  assert.deepEqual(set, [PRIORITY_BELOW_NORMAL, PRIORITY_NORMAL, PRIORITY_NORMAL]);
  assert.equal(
    setPriorityFor('gentle', false, () => {
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
  await new Promise((r) => setTimeout(r, 300));
  const b = inFirstRoundTurn('gentle', true, async () => void order.push('b starts'), { who: 'b', limitMs: 60_000, dir, onWait: (w) => waits.push(w) });
  await new Promise((r) => setTimeout(r, 600));
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

test('on Windows, a process set gentle and back: efficiency mode, disk priority and the cap all take', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = await import('node:child_process');
  const { readFileSync: read } = await import('node:fs');
  const { powershell, stopPowerShellWorker } = await import('./fixture/src/kit/ps.ts');
  const source = read(new URL('./fixture/src/kit/gentle.cs', import.meta.url), 'utf8');
  const dll = path.join(home, 'gentle-test.dll');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.equal((await powershell(gentleScript(child.pid!, true, 2500, dll, source), { timeoutMs: 120_000 })).trim(), 'eco io cap');
    assert.equal((await powershell(gentleScript(child.pid!, true, 2500, dll, null))).trim(), 'eco io cap', 'again: the same job');
    assert.equal((await powershell(gentleScript(child.pid!, false, 2500, dll, null))).trim(), 'eco io cap', 'lifted');
  } finally {
    child.kill();
    stopPowerShellWorker();
  }
});
