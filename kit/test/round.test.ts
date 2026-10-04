import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// round.json (spec/ROUND.md): each schedule's last round, in the agent's data folder, for the Surveyor.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-round-'));
const dataDir = path.join(home, 'data');
process.env.FIXTURE_HOME = dataDir;
after(() => rmSync(home, { recursive: true, force: true }));

const { every, roundFile, roundError } = await import('./fixture/src/kit/schedule.ts');
const { readJson } = await import('./fixture/src/kit/store.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');

interface Entry {
  started: string;
  finished: string;
  ok: boolean;
  error: string | null;
  everyMs: number;
  next: string | null;
}
const file = () => readJson<{ rounds?: Record<string, Entry> }>(roundFile(), {});
const isIso = (s: unknown) => typeof s === 'string' && new Date(s).toISOString() === s;

/** Runs one round now and waits for it to end (and be recorded). */
async function oneRound(job: ReturnType<typeof every>) {
  assert.ok(job.runNow());
  while (job.running) await new Promise((r) => setTimeout(r, 5));
}

test('round.json is in the data folder', () => {
  assert.equal(roundFile(), path.join(dataDir, 'round.json'));
});

test('a round that goes through is recorded: started, finished, ok, no error, the interval and the next due', async () => {
  setDuty(true);
  const before = Date.now();
  const job = every(60_000, async () => void (await new Promise((r) => setTimeout(r, 20))), { firstDelayMs: 50_000 });
  try {
    await oneRound(job);
    const r = file().rounds?.round;
    assert.ok(r, 'an unnamed schedule is "round"');
    assert.deepEqual(Object.keys(r).sort(), ['error', 'everyMs', 'finished', 'next', 'ok', 'started']);
    assert.ok(isIso(r.started) && isIso(r.finished) && isIso(r.next));
    assert.ok(Date.parse(r.started) >= before - 1);
    assert.ok(Date.parse(r.finished) - Date.parse(r.started) >= 15, 'finished is when the round ended');
    assert.equal(r.ok, true);
    assert.equal(r.error, null);
    assert.equal(r.everyMs, 60_000);
    assert.equal(r.next, job.state.nextRunAt);
    assert.ok(Date.parse(r.next!) > Date.now() + 50_000, 'the next is about an interval on');
  } finally {
    job.stop();
  }
});

test("a round that throws is recorded: ok false, the error's first line; the next ends with what it says", async () => {
  setDuty(true);
  let fail = true;
  const job = every(() => 120_000, async () => {
    if (fail) throw new Error('no network\n    at somewhere (x.ts:1:1)');
  }, { firstDelayMs: 50_000 });
  try {
    await oneRound(job);
    let r = file().rounds!.round;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no network');
    assert.equal(r.everyMs, 120_000, 'an interval given as a function is read');

    fail = false;
    await oneRound(job);
    r = file().rounds!.round;
    assert.equal(r.ok, true);
    assert.equal(r.error, null, 'a round that goes through clears the error');

    setDuty(false);
    await oneRound(job);
    assert.equal(file().rounds!.round.next, null, 'off duty, no round is due');
  } finally {
    job.stop();
    setDuty(true);
  }
});

test('an error is said in one line of at most 500 characters', () => {
  assert.equal(roundError(new Error('x'.repeat(600))).length, 500);
  assert.equal(roundError(new Error('first\r\nsecond')), 'first');
  assert.equal(roundError('a string'), 'a string');
  assert.equal(roundError(new Error('')), 'it failed');
});

test('two named schedules keep their own entries, and other keys are kept', async () => {
  setDuty(true);
  writeFileSync(roundFile(), JSON.stringify({ rounds: { old: { ok: true } }, other: 1 }));
  const grind = every(30_000, async () => {}, { firstDelayMs: 50_000, name: 'grind' });
  const names = every(90_000, async () => {
    throw new Error('no names today');
  }, { firstDelayMs: 50_000, name: 'names' });
  try {
    await oneRound(grind);
    await oneRound(names);
    const f = file() as { rounds: Record<string, Entry>; other?: number };
    assert.deepEqual(Object.keys(f.rounds).sort(), ['grind', 'names', 'old']);
    assert.equal(f.other, 1);
    assert.equal(f.rounds.grind.ok, true);
    assert.equal(f.rounds.grind.everyMs, 30_000);
    assert.equal(f.rounds.names.ok, false);
    assert.equal(f.rounds.names.error, 'no names today');
    assert.equal(f.rounds.names.everyMs, 90_000);

    const grindBefore = f.rounds.grind;
    await oneRound(names);
    assert.deepEqual(file().rounds!.grind, grindBefore, "one schedule's round leaves the other's entry alone");
  } finally {
    grind.stop();
    names.stop();
  }
});

test("a round.json that isn't JSON is started afresh", async () => {
  writeFileSync(roundFile(), 'not json');
  const job = every(60_000, async () => {}, { firstDelayMs: 50_000, name: 'fresh' });
  try {
    await oneRound(job);
    assert.deepEqual(Object.keys(file().rounds!), ['fresh']);
  } finally {
    job.stop();
  }
});

test("a data folder that can't be written doesn't break the round", async () => {
  // The data folder is a file: nothing can be written in it.
  rmSync(dataDir, { recursive: true, force: true });
  writeFileSync(dataDir, 'in the way');
  const errors: string[] = [];
  const logged = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(' '));
  let ran = 0;
  let fail = false;
  const job = every(60_000, async () => {
    ran++;
    if (fail) throw new Error('and it failed');
  }, { firstDelayMs: 50_000, name: 'stuck' });
  try {
    await oneRound(job);
    assert.equal(ran, 1);
    assert.equal(job.state.lastRunOk, true, 'the round went through');
    assert.ok(job.state.nextRunAt, 'and the next is set up');
    fail = true;
    await oneRound(job);
    await oneRound(job);
    assert.equal(ran, 3, 'the rounds go on');
    assert.equal(job.state.lastRunOk, false);
    assert.equal(job.state.lastError, 'and it failed');
    assert.equal(errors.filter((e) => e.includes('round.json')).length, 1, 'said once');
  } finally {
    console.error = logged;
    job.stop();
    rmSync(dataDir, { force: true });
  }
});
