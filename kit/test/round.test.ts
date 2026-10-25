import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from './until.ts';

// round.json (spec/ROUND.md): each schedule's last round, in the agent's data folder, for the Surveyor.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-round-'));
const dataDir = path.join(home, 'data');
process.env.FIXTURE_HOME = dataDir;
after(() => rmSync(home, { recursive: true, force: true }));

const { every, roundFile, roundError, roundTimeLimit, STOP_AFTER_FAILURES } = await import('./fixture/src/kit/schedule.ts');
const { readJson } = await import('./fixture/src/kit/store.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');
const { Offline } = await import('./fixture/src/kit/net.ts');

interface Entry {
  started: string;
  finished: string;
  ok: boolean | null;
  error: string | null;
  everyMs: number;
  next: string | null;
  waiting?: string;
  failedInARow?: number;
  stopped?: string;
}
const file = () => readJson<{ rounds?: Record<string, Entry> }>(roundFile(), {});
const isIso = (s: unknown) => typeof s === 'string' && new Date(s).toISOString() === s;

/** Runs one round now and waits for it to end (and be recorded). */
async function oneRound(job: ReturnType<typeof every>) {
  assert.ok(job.runNow());
  await until(() => !job.running, 10_000, 'the round to end');
}

test('round.json is in the data folder', () => {
  assert.equal(roundFile(), path.join(dataDir, 'round.json'));
});

test('a round that goes through is recorded: started, finished, ok, no error, the interval, the next due, and what it used', async () => {
  setDuty(true);
  const before = Date.now();
  const job = every(70_000, async () => void (await new Promise((r) => setTimeout(r, 20))), { firstDelayMs: 50_000 });
  try {
    await oneRound(job);
    const r = file().rounds?.round;
    assert.ok(r, 'an unnamed schedule is "round"');
    assert.deepEqual(Object.keys(r).sort(), ['cpuMs', 'error', 'everyMs', 'finished', 'memoryMb', 'next', 'ok', 'started'], 'no waitedMs: a round asked for never waits');
    const used = r as unknown as { cpuMs: number; memoryMb: number };
    assert.ok(Number.isInteger(used.cpuMs) && used.cpuMs >= 0, 'its processor time, in milliseconds');
    assert.ok(Number.isInteger(used.memoryMb) && used.memoryMb > 10, 'its most memory, in megabytes');
    assert.ok(isIso(r.started) && isIso(r.finished) && isIso(r.next));
    assert.ok(Date.parse(r.started) >= before - 1);
    assert.ok(Date.parse(r.finished) - Date.parse(r.started) >= 15, 'finished is when the round ended');
    assert.equal(r.ok, true);
    assert.equal(r.error, null);
    assert.equal(r.everyMs, 70_000);
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

test('a round that runs past its time limit is let go: recorded as timed out, its signal aborted, and the next round runs', async () => {
  setDuty(true);
  let calls = 0;
  let firstSignal: AbortSignal | null = null;
  let finishFirst!: () => void;
  const job = every(
    60_000,
    async ({ signal }) => {
      calls++;
      if (calls === 1) {
        firstSignal = signal;
        await new Promise<void>((r) => (finishFirst = r)); // hangs until the test lets it end
      }
    },
    { firstDelayMs: 50_000, name: 'limited', timeoutMs: 40 },
  );
  try {
    await oneRound(job);
    const r = file().rounds?.limited as Entry & { timedOut?: boolean };
    assert.deepEqual([r.ok, r.timedOut], [false, true]);
    assert.match(r.error!, /ran past its time limit \(0 s\): let go, and the next round tries again/);
    assert.equal(firstSignal!.aborted, true, 'a job that can stop is asked to');
    assert.ok(job.state.nextRunAt, 'the next round is scheduled');

    await oneRound(job);
    assert.equal(calls, 2, 'the next round runs, though the first never ended');
    const second = file().rounds?.limited as Entry & { timedOut?: boolean };
    assert.deepEqual([second.ok, second.timedOut], [true, undefined]);

    finishFirst();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(file().rounds?.limited, second, 'the one let go, ending late, changes nothing');
    assert.equal(job.running, false);
  } finally {
    job.stop();
  }
});

test('the time limit, unless an agent gives its own: three intervals, and at least two hours', () => {
  assert.equal(roundTimeLimit(30 * 60_000), 2 * 3_600_000);
  assert.equal(roundTimeLimit(6 * 3_600_000), 18 * 3_600_000);
});

test('after three failed rounds in a row its rounds stop, a restart keeps them stopped, and Run now that goes through starts them again', async () => {
  setDuty(true);
  assert.equal(STOP_AFTER_FAILURES, 3);
  let fail = true;
  let calls = 0;
  const job = async () => {
    calls++;
    if (fail) throw new Error('spawn ENAMETOOLONG');
  };
  const first = every(60_000, job, { firstDelayMs: 50_000, name: 'stops' });
  let again: ReturnType<typeof every> | null = null;
  try {
    await oneRound(first);
    await oneRound(first);
    let r = file().rounds!.stops;
    assert.deepEqual([r.ok, r.failedInARow, r.stopped, r.waiting], [false, 2, undefined, undefined]);
    assert.ok(first.state.nextRunAt, 'two failed: the rounds go on');

    await oneRound(first);
    r = file().rounds!.stops;
    assert.deepEqual([r.ok, r.error, r.failedInARow, r.stopped, r.next], [false, 'spawn ENAMETOOLONG', 3, '0.0.1', null]);
    assert.match(r.waiting!, /stopped after 3 failed in a row: they start again once it's updated, or when Run now goes through/);
    assert.equal(first.state.nextRunAt, null, 'no round is due');
    assert.match(first.state.waiting!, /stopped after 3 failed in a row/);
    assert.equal(first.runSoon(), false, "the agent's own reasons start none");
    first.reschedule();
    assert.equal(first.state.nextRunAt, null, 'a new interval starts none');

    // Started again at the same version: still stopped, with no round due.
    first.stop();
    again = every(60_000, job, { firstDelayMs: 50_000, name: 'stops' });
    assert.equal(again.state.nextRunAt, null);
    assert.match(again.state.waiting!, /stopped after 3 failed in a row/);
    assert.equal(again.runSoon(), false);

    // Run now still runs: one that fails leaves them stopped.
    await oneRound(again);
    r = file().rounds!.stops;
    assert.deepEqual([r.ok, r.failedInARow, r.stopped, r.next], [false, 4, '0.0.1', null]);
    assert.match(again.state.waiting!, /stopped after 4 failed in a row/);

    // One that goes through starts them again.
    fail = false;
    await oneRound(again);
    r = file().rounds!.stops;
    assert.deepEqual([r.ok, r.failedInARow, r.stopped, r.waiting], [true, undefined, undefined, undefined]);
    assert.ok(again.state.nextRunAt, 'the next round is due again');
    assert.equal(again.state.waiting, null);
    assert.equal(calls, 5);
  } finally {
    first.stop();
    again?.stop();
  }
});

test('an update starts stopped rounds again: stopped at another version, they go on, counted afresh', async () => {
  setDuty(true);
  const was = file() as Record<string, unknown> & { rounds?: Record<string, Entry> };
  const at = new Date().toISOString();
  const old: Entry = { started: at, finished: at, ok: false, error: 'it failed', everyMs: 60_000, next: null, failedInARow: 3, stopped: '0.0.0', waiting: 'its rounds stopped after 3 failed in a row' };
  writeFileSync(roundFile(), JSON.stringify({ ...was, rounds: { ...was.rounds, updated: old } }));
  const job = every(
    60_000,
    async () => {
      throw new Error('still failing');
    },
    { firstDelayMs: 50_000, name: 'updated' },
  );
  try {
    assert.ok(job.state.nextRunAt, 'a round is due');
    assert.equal(job.state.waiting, null);
    await oneRound(job);
    const r = file().rounds!.updated;
    assert.deepEqual([r.failedInARow, r.stopped], [1, undefined], 'counted from one again');
  } finally {
    job.stop();
  }
});

test('a round that waits for the network neither counts nor clears the failures; stopAfterFailures 0 never stops', async () => {
  setDuty(true);
  const outcomes: (Error | null)[] = [new Error('a'), new Error('b'), new Offline(), new Error('c')];
  const job = every(
    60_000,
    async () => {
      const e = outcomes.shift();
      if (e) throw e;
    },
    { firstDelayMs: 50_000, name: 'offline-between' },
  );
  const never = every(
    60_000,
    async () => {
      throw new Error('always');
    },
    { firstDelayMs: 50_000, name: 'never-stops', stopAfterFailures: 0 },
  );
  try {
    await oneRound(job);
    await oneRound(job);
    await oneRound(job);
    let r = file().rounds!['offline-between'];
    assert.deepEqual([r.ok, r.failedInARow, r.stopped], [null, undefined, undefined], 'offline: no failure');
    assert.ok(job.state.nextRunAt);
    await oneRound(job);
    r = file().rounds!['offline-between'];
    assert.deepEqual([r.ok, r.failedInARow, r.stopped], [false, 3, '0.0.1'], 'the third failure stops them');

    for (let i = 0; i < 4; i++) await oneRound(never);
    const n = file().rounds!['never-stops'];
    assert.deepEqual([n.failedInARow, n.stopped], [4, undefined]);
    assert.ok(never.state.nextRunAt, 'it never stops');
  } finally {
    job.stop();
    never.stop();
  }
});
