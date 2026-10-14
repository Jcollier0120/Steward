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
