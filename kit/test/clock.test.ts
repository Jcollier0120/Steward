import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from './until.ts';

// The shared clock (kit 2.72.0): rounds on 30-minute slots, or a divisor or multiple of them, each schedule at its own phase.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-clock-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
after(() => rmSync(home, { recursive: true, force: true }));

const id: string = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8')).name;
const { every, roundFile, fitsClock, wholeInterval, clockPhase, nextOnClock, CLOCK_MS } = await import('./fixture/src/kit/schedule.ts');
const { readJson } = await import('./fixture/src/kit/store.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');

const MIN = 60_000;
const HOUR = 3_600_000;
/** Today at hh:mm in this PC's time, in milliseconds. */
const at = (hh: number, mm: number, ss = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, ss).getTime();
};

test('the intervals that fit the clock: divisors of 30 minutes, and multiples of it that divide the day', () => {
  for (const ms of [MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 90 * MIN, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]) assert.ok(fitsClock(ms), `${ms / MIN} min`);
  for (const ms of [20, 30_000, 70_000, 7 * MIN, 45 * MIN, 5 * HOUR, 48 * HOUR]) assert.ok(!fitsClock(ms), `${ms / MIN} min`);
  assert.equal(CLOCK_MS, 30 * MIN);
});

test('an interval worked out in another unit is kept to the whole second, so it stays on the clock', () => {
  assert.equal(wholeInterval(1_799_999.4), 30 * MIN);
  assert.equal(wholeInterval(0.4999999 * HOUR), 30 * MIN);
  assert.ok(fitsClock(1_799_999.4));
  assert.equal(wholeInterval(20), 20, 'under a minute, as given');
});

test("a schedule's phase: whole minutes, under its interval and the 30-minute clock, the same every time, and spread over the staff", () => {
  for (const ms of [MIN, 5 * MIN, 30 * MIN, HOUR, 6 * HOUR]) {
    const p = clockPhase('porter', 'round', ms);
    assert.equal(p % MIN, 0);
    assert.ok(p >= 0 && p < Math.min(ms, CLOCK_MS), `${ms / MIN} min: ${p / MIN}`);
    assert.equal(clockPhase('porter', 'round', ms), p);
  }
  assert.equal(clockPhase('weigher', 'uptime', MIN), 0, 'a 1-minute round falls on every minute');
  const staff = ['assayer', 'auditor', 'crier', 'toller', 'warrener', 'surveyor', 'porter', 'chamberlain', 'clerk', 'miller', 'herald', 'bailiff'];
  const minutes = new Set(staff.map((who) => clockPhase(who, 'round', HOUR)));
  assert.ok(minutes.size >= 7, `twelve hourly agents fall in ${minutes.size} different minutes`);
  const schedules = new Set(['round', 'names', 'assets', 'scout', 'audits'].map((name) => clockPhase('miller', name, HOUR)));
  assert.ok(schedules.size >= 3, "an agent's schedules have phases of their own");
});

test("the next slot: the schedule's phase past a multiple of its interval from local midnight", () => {
  assert.equal(nextOnClock(at(10, 8), 30 * MIN, 7 * MIN), at(10, 37));
  assert.equal(nextOnClock(at(10, 7), 30 * MIN, 7 * MIN), at(10, 7), 'a slot at the moment is that slot');
  assert.equal(nextOnClock(at(10, 7, 1), 30 * MIN, 7 * MIN), at(10, 37));
  assert.equal(nextOnClock(at(13, 0), 6 * HOUR, 12 * MIN), at(18, 12));
  assert.equal(nextOnClock(at(5, 59), 6 * HOUR, 12 * MIN), at(6, 12));
  assert.equal(nextOnClock(at(9, 1), 5 * MIN, 3 * MIN), at(9, 3));
  assert.equal(nextOnClock(at(9, 4), 5 * MIN, 3 * MIN), at(9, 8));
});

test("a round on the clock: the next is on its slot, at least half an interval on, and round.json says its phase", async () => {
  setDuty(true);
  const phaseMs = clockPhase(id, 'on-clock', 30 * MIN);
  const job = every(30 * MIN, async () => {}, { firstDelayMs: HOUR, name: 'on-clock' });
  try {
    assert.ok(job.runNow());
    await until(() => !job.running && job.state.lastRunAt, 10_000, 'the round to end');
    const next = Date.parse(job.state.nextRunAt!);
    const ended = Date.parse(job.state.lastRunAt!);
    assert.ok(next >= ended + 15 * MIN && next <= ended + 45 * MIN, 'between half an interval and an interval and a half on');
    assert.equal(nextOnClock(next, 30 * MIN, phaseMs), next, 'on one of its slots');
    const r = readJson<{ rounds: Record<string, { everyMs: number; phaseMs?: number }> }>(roundFile(), { rounds: {} }).rounds['on-clock'];
    assert.equal(r.everyMs, 30 * MIN);
    assert.equal(r.phaseMs, phaseMs);
  } finally {
    job.stop();
  }
});

test('a phase the agent gives is kept, and an interval off the clock keeps the old way, with no phase', async () => {
  setDuty(true);
  const given = every(HOUR, async () => {}, { firstDelayMs: HOUR, name: 'given', phaseMs: 17 * MIN });
  const off = every(7 * MIN, async () => {}, { firstDelayMs: HOUR, name: 'off-clock' });
  try {
    assert.ok(given.runNow());
    await until(() => !given.running && given.state.lastRunAt, 10_000, 'the round to end');
    const next = Date.parse(given.state.nextRunAt!);
    assert.equal(nextOnClock(next, HOUR, 17 * MIN), next, '17 minutes past the hour');

    assert.ok(off.runNow());
    await until(() => !off.running && off.state.lastRunAt, 10_000, 'the round to end');
    const wait = Date.parse(off.state.nextRunAt!) - Date.parse(off.state.lastRunAt!);
    assert.ok(wait >= 0.9 * 7 * MIN - 1000 && wait <= 1.1 * 7 * MIN + 1000, 'an interval on, ±10%');
    const r = readJson<{ rounds: Record<string, { phaseMs?: number }> }>(roundFile(), { rounds: {} }).rounds;
    assert.equal(r['given'].phaseMs, 17 * MIN);
    assert.ok(!('phaseMs' in r['off-clock']));
  } finally {
    given.stop();
    off.stop();
  }
});

// Manor's rota (rota.ts, kit 2.138.0): each schedule's phase on this PC, anywhere in its interval, and each agent's
// place in the start window. A test's rounds read a rota only from the home they give.
const { rotaEntry, rotaPhase, rotaStartAt, ROTA_FILE } = await import('./fixture/src/kit/rota.ts');
const { startWindow, WOKE_LATE_MS } = await import('./fixture/src/kit/schedule.ts');
const { pace } = await import('./fixture/src/kit/pace.ts');
const { mock } = await import('node:test');
const { mkdirSync, writeFileSync } = await import('node:fs');

/** A Manor folder whose rota.json is `doc` (a string as it is). */
const manorWith = (doc: unknown) => {
  const dir = mkdtempSync(path.join(home, 'manor-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ROTA_FILE), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return dir;
};
const rota = (agents: Record<string, unknown>) => ({ v: 1, made: new Date().toISOString(), agents });

test("the rota, read leniently: a phase counts only at the interval it was placed for, and anything malformed is left out", () => {
  const dir = manorWith(
    rota({
      [id]: { startAt: 0.25, phases: { round: { everyMs: HOUR, phaseMs: 47 * MIN, startAt: 0.75 }, bad: { everyMs: HOUR, phaseMs: HOUR }, odd: { everyMs: 'hourly', phaseMs: 1 }, names: { everyMs: 6 * HOUR, phaseMs: 200 * MIN } } },
      other: 'nonsense',
    }),
  );
  assert.deepEqual(Object.keys(rotaEntry(id, dir)!.phases), ['round', 'names']);
  assert.equal(rotaPhase(id, 'round', HOUR, dir), 47 * MIN, 'anywhere in the interval, past the clock\'s 30 minutes');
  assert.equal(rotaPhase(id, 'round', 30 * MIN, dir), null, 'its interval changed since: the clock\'s, until Manor places it again');
  assert.equal(rotaPhase(id, 'names', 6 * HOUR, dir), 200 * MIN);
  assert.equal(rotaStartAt(id, 'round', dir), 0.75, "the schedule's own place");
  assert.equal(rotaStartAt(id, 'names', dir), 0.25, "else its agent's");
  assert.equal(rotaEntry('other', dir), null);
  assert.equal(rotaEntry('nobody', dir), null);
  for (const doc of ['{ not json', JSON.stringify({ v: 2, agents: { [id]: { phases: {} } } }), JSON.stringify([1, 2])]) assert.equal(rotaEntry(id, manorWith(doc)), null, `none from ${doc.slice(0, 20)}`);
  assert.equal(rotaEntry(id, path.join(home, 'no-manor')), null, 'no rota.json: none');
  assert.equal(rotaEntry(id), null, "under node --test, never the PC's own");
});

test("a round in the rota falls on the rota's phase, an agent's own phase wins, and round.json says where each came from", async () => {
  setDuty(true);
  const dir = manorWith(rota({ [id]: { phases: { 'rota-placed': { everyMs: HOUR, phaseMs: 47 * MIN }, 'rota-moved': { everyMs: 30 * MIN, phaseMs: 13 * MIN }, 'rota-own': { everyMs: HOUR, phaseMs: 5 * MIN } } } }));
  const placed = every(HOUR, async () => {}, { firstDelayMs: HOUR, name: 'rota-placed', rotaHome: dir });
  const moved = every(HOUR, async () => {}, { firstDelayMs: HOUR, name: 'rota-moved', rotaHome: dir });
  const own = every(HOUR, async () => {}, { firstDelayMs: HOUR, name: 'rota-own', phaseMs: 17 * MIN, rotaHome: dir });
  try {
    for (const job of [placed, moved, own]) {
      assert.ok(job.runNow());
      await until(() => !job.running && job.state.lastRunAt, 10_000, 'the round to end');
    }
    const next = (job: typeof placed) => Date.parse(job.state.nextRunAt!);
    assert.equal(nextOnClock(next(placed), HOUR, 47 * MIN), next(placed), '47 minutes past the hour');
    assert.equal(nextOnClock(next(moved), HOUR, clockPhase(id, 'rota-moved', HOUR)), next(moved), "placed for 30 minutes, run hourly: the clock's");
    assert.equal(nextOnClock(next(own), HOUR, 17 * MIN), next(own), "the agent's own");
    const r = readJson<{ rounds: Record<string, { phaseMs?: number; phaseFrom?: string }> }>(roundFile(), { rounds: {} }).rounds;
    assert.deepEqual([r['rota-placed'].phaseMs, r['rota-placed'].phaseFrom], [47 * MIN, 'rota']);
    assert.equal(r['rota-moved'].phaseFrom, 'clock');
    assert.deepEqual([r['rota-own'].phaseMs, r['rota-own'].phaseFrom], [17 * MIN, 'agent']);
  } finally {
    for (const job of [placed, moved, own]) job.stop();
  }
});

test("the first round after a start comes at the rota's place in the start window", () => {
  setDuty(true);
  const dir = manorWith(rota({ [id]: { startAt: 0.5, phases: {} } }));
  const w = startWindow(pace());
  const before = Date.now();
  const job = every(HOUR, async () => {}, { name: 'rota-start', rotaHome: dir });
  try {
    const wait = Date.parse(job.state.nextRunAt!) - before;
    const want = w.fromMs + 0.5 * w.spanMs;
    assert.ok(Math.abs(wait - want) < 2_000, `${wait} ms after the start, not ${want}`);
  } finally {
    job.stop();
  }
  assert.deepEqual(startWindow('gentle'), { fromMs: 2 * MIN, spanMs: 13 * MIN });
  assert.deepEqual(startWindow('full'), { fromMs: 30_000, spanMs: 150_000 });
});

test('a round whose time came while the PC slept waits its place in the start window first', async () => {
  setDuty(true);
  const dir = manorWith(rota({ [id]: { startAt: 0.2, phases: {} } }));
  const w = startWindow(pace());
  let ran = 0;
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const job = every(HOUR, async () => void ran++, { firstDelayMs: MIN, name: 'woke', rotaHome: dir });
  try {
    // Asleep through its time: the timer fires 10 minutes late.
    mock.timers.setTime(Date.now() + 10 * MIN);
    mock.timers.tick(MIN);
    await new Promise((r) => setImmediate(r));
    assert.equal(ran, 0, 'not at once');
    const wait = Date.parse(job.state.nextRunAt!) - Date.now();
    assert.ok(Math.abs(wait - (w.fromMs + 0.2 * w.spanMs)) < 1_000, `it waits its place in the window: ${wait} ms`);
    assert.ok(WOKE_LATE_MS >= MIN && WOKE_LATE_MS <= 5 * MIN);
  } finally {
    job.stop();
    mock.timers.reset();
  }
});
