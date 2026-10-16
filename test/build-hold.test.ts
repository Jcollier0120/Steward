import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Keeping the PC up for its builds (build-hold.ts): held from a few minutes before each build time until the build
// closes, a round at the build time, and the wake task kept in step with Settings, all with a clock and Windows stood in for.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-build-hold-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { AFTER_WINDOW_MS, buildHold, buildsOn, buildWakePlan, holdForBuilds, timesWords } = await import('../src/build-hold.ts');
const { DEFAULT_PIPELINE, endRound, pipelineMode } = await import('../src/pipeline.ts');
const { wakeTimes } = await import('../src/kit/wake.ts');
type PipelineState = import('../src/pipeline.ts').PipelineState;
type WakePlan = import('../src/kit/wake.ts').WakePlan;

const ON = { ...DEFAULT_PIPELINE, on: true };
/** A local time on 2026-10-16 (a Friday), or another day of that month. */
const at = (h: number, m = 0, day = 16) => new Date(2026, 9, day, h, m);
const none: PipelineState = { open: null, builds: [] };
/** The 08:00 build begun at `start`, and the state with it open. */
function opened(start: Date): PipelineState {
  const m = pipelineMode(ON, none, start);
  assert.equal(m.kind, 'build');
  return endRound(none, (m as { run: import('../src/pipeline.ts').BuildRun }).run, { merged: [], released: [], failed: [], closed: false, now: start });
}

test('builds run at set times while the switch is on, and always from Steward 0.36.63, which has none', () => {
  assert.equal(buildsOn(ON), true);
  assert.equal(buildsOn(DEFAULT_PIPELINE), false);
  const { on: _, ...noSwitch } = ON;
  assert.equal(buildsOn(noSwitch as typeof ON), true);
});

test('the PC is held from five minutes before a build time until its build closes, and not between builds', () => {
  assert.equal(buildHold(ON, none, at(7, 54)), null, 'six minutes before: nothing held');
  assert.deepEqual(buildHold(ON, { open: null, builds: [{ due: at(18, 0, 15).toISOString(), by: 'schedule', started: '', rounds: 1, merged: [], released: [], failed: [] }] }, at(7, 55)), { what: 'the 08:00 build', due: null });
  // The build time has come and no round has begun its build: held, and a round is due now.
  assert.deepEqual(buildHold(ON, none, at(8, 0)), { what: 'the 08:00 build', due: at(8).toISOString() });
  // Begun: held while it's open, and its window, then let go however it stands (its closing round holds its own work).
  const open = opened(at(8, 1));
  assert.deepEqual(buildHold(ON, open, at(9, 30)), { what: 'the 08:00 build', due: null });
  assert.equal(buildHold(ON, open, new Date(at(8, 1).getTime() + ON.windowMinutes * 60_000 + AFTER_WINDOW_MS)), null);
  // Closed: nothing held until five minutes before 13:00.
  const closed = endRound(open, open.open!, { merged: [], released: [], failed: [], closed: true, now: at(8, 40) });
  assert.equal(buildHold(ON, closed, at(8, 41)), null);
  assert.equal(buildHold(ON, closed, at(12, 54)), null);
  assert.deepEqual(buildHold(ON, closed, at(12, 56)), { what: 'the 13:00 build', due: null });
  // Slept through by more than a window: no hold for it (it begins at the next round all the same).
  assert.equal(buildHold(ON, none, at(10, 1)), null);
});

test("the wake task's plan: five minutes before each build time, on its days, the day before for a midnight build", () => {
  const plan = buildWakePlan(ON);
  assert.deepEqual(plan, { times: ON.times, days: ON.days, beforeMinutes: 5, holdMinutes: 15, why: 'the 08:00, 13:00 and 18:00 builds' });
  assert.deepEqual(wakeTimes(plan), [
    { time: '07:55', days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
    { time: '12:55', days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
    { time: '17:55', days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
  ]);
  assert.deepEqual(wakeTimes({ times: ['00:00', '00:30'], days: ['mon', 'sun'], beforeMinutes: 5 }), [
    { time: '00:25', days: ['sun', 'mon'] },
    { time: '23:55', days: ['sun', 'sat'] },
  ]);
  assert.equal(timesWords(['18:00']), '18:00');
  assert.equal(buildWakePlan({ ...ON, times: ['18:00'] }).why, 'the 18:00 build');
});

test('the watch holds the PC for each build, starts a round at its time once, lets go when it closes, and keeps the wake task in step', async () => {
  let now = at(7, 50);
  let state: PipelineState = none;
  let pipeline: typeof ON | null = ON;
  const calls: string[] = [];
  const plans: (WakePlan | null)[] = [];
  let rounds = 0;
  const lines: string[] = [];
  const watch = holdForBuilds({
    pipeline: () => pipeline,
    state: () => state,
    onDue: () => void rounds++,
    log: (line) => lines.push(line),
    now: () => now,
    hold: (what) => {
      calls.push(`hold ${what}`);
      return () => void calls.push(`let go ${what}`);
    },
    wake: async (plan) => void plans.push(plan),
    everyMs: 3_600_000,
  });
  try {
    watch.look();
    assert.deepEqual(calls, [], 'ten minutes before: nothing held');
    now = at(7, 56);
    watch.look();
    assert.deepEqual(calls, ['hold the 08:00 build']);
    assert.equal(watch.holding(), 'the 08:00 build');
    assert.equal(rounds, 0, 'no round before its time');
    now = at(8, 0);
    watch.look();
    watch.look();
    assert.equal(rounds, 1, 'a round at the build time, once');
    assert.deepEqual(calls, ['hold the 08:00 build'], 'one hold all along');
    state = opened(at(8, 0));
    now = at(8, 30);
    watch.look();
    assert.deepEqual(calls, ['hold the 08:00 build']);
    state = endRound(state, state.open!, { merged: [], released: [], failed: [], closed: true, now: at(8, 45) });
    now = at(8, 45);
    watch.look();
    assert.deepEqual(calls, ['hold the 08:00 build', 'let go the 08:00 build']);
    assert.equal(watch.holding(), null);
    assert.equal(rounds, 1);
    assert.match(lines.join('\n'), /held up for the 08:00 build[\s\S]*let go after the 08:00 build/);

    // Off duty (or Settings that don't build here): nothing held, and the wake task goes.
    now = at(12, 56);
    pipeline = null;
    watch.look();
    assert.deepEqual(calls.slice(2), []);
    await until(() => plans.length === 7);
    assert.deepEqual(plans.slice(0, 6), Array(6).fill(buildWakePlan(ON)), 'in step at every look');
    assert.equal(plans[6], null);
    // Back on duty inside a hold's time: held at once.
    pipeline = ON;
    watch.look();
    assert.deepEqual(calls.slice(2), ['hold the 13:00 build']);
  } finally {
    watch.stop();
  }
  assert.deepEqual(calls.slice(2), ['hold the 13:00 build', 'let go the 13:00 build'], 'stopping lets go');
});

test('a watch that fails to read its state says so, and holds nothing', () => {
  const lines: string[] = [];
  const watch = holdForBuilds({
    pipeline: () => ON,
    state: () => {
      throw new Error('pipeline.json is unreadable');
    },
    onDue: () => assert.fail('no round'),
    log: (line) => lines.push(line),
    now: () => at(8, 0),
    hold: () => assert.fail('nothing held'),
    wake: async () => {},
    everyMs: 3_600_000,
  });
  try {
    watch.look();
    assert.match(lines.join('\n'), /holding the PC for the builds: pipeline\.json is unreadable/);
  } finally {
    watch.stop();
  }
});

/** Waits for a condition the watch's promises settle, at most a few seconds. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(ok(), 'the condition never held');
}
