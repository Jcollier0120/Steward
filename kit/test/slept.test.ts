import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { until } from './until.ts';

// Time limits that count only the PC's awake time, and the PC's sleeps read from Windows' event log (node/slept.ts).
// A clock of the test's own stands in for Node's: awake, time goes on and timers run as they fall due; asleep, time
// goes on and nothing runs, and at the wake what fell due runs in the order it fell due, as Node's timers do.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-slept-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
after(() => rmSync(home, { recursive: true, force: true }));

const S = await import('./fixture/src/kit/slept.ts');
const { every, roundFile } = await import('./fixture/src/kit/schedule.ts');
const { readJson } = await import('./fixture/src/kit/store.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

class FakeClock {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  readonly clock = {
    now: () => this.t,
    setTimeout: (fn: () => void, ms: number) => this.add(fn, ms),
    clearTimeout: (id: unknown) => void this.timers.delete(id as number),
    setInterval: (fn: () => void, ms: number) => this.add(fn, ms, ms),
    clearInterval: (id: unknown) => void this.timers.delete(id as number),
  };
  private add(fn: () => void, ms: number, every?: number) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, every });
    return id;
  }
  /** Awake for `ms`: each timer runs as it falls due; one overdue (after a sleep) runs at once, an interval only once. */
  run(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, x] = next;
      this.t = Math.max(this.t, x.at);
      if (x.every) x.at = this.t + x.every;
      else this.timers.delete(id);
      x.fn();
    }
    this.t = end;
  }
  /** Asleep for `ms`: nothing runs. */
  sleep(ms: number) {
    this.t += ms;
  }
  get waiting() {
    return this.timers.size;
  }
}

let fake = new FakeClock();
const useFake = () => {
  fake = new FakeClock();
  S.setAwakeClock(fake.clock);
  return fake;
};
afterEach(() => S.setAwakeClock(null));

test('with no sleep, an awake timer runs when setTimeout would', () => {
  const c = useFake();
  let ran = 0;
  S.awakeTimeout(() => ran++, 90 * MIN);
  c.run(90 * MIN - 1);
  assert.equal(ran, 0);
  c.run(1);
  assert.equal(ran, 1);
  assert.equal(c.t, 90 * MIN);
  assert.equal(c.waiting, 0, 'the ticker stops once no timer waits');
});

test('a sleep in the middle is left out: the timer waits on after the wake for the awake time it still has', () => {
  const c = useFake();
  let ranAt: number | null = null;
  const t = S.awakeTimeout(() => (ranAt = c.t), HOUR);
  c.run(20 * MIN);
  c.sleep(10 * HOUR);
  c.run(1);
  assert.equal(ranAt, null, 'not at the wake, as setTimeout would');
  const left = t.left();
  assert.ok(left > 40 * MIN - S.TICK_MS - SEC && left <= 40 * MIN, `40 minutes left: ${left / MIN}`);
  c.run(40 * MIN - S.TICK_MS - SEC);
  assert.equal(ranAt, null);
  c.run(S.TICK_MS + SEC);
  assert.ok(ranAt !== null, 'ran once its hour of awake time was up');
  const awake = ranAt! - 10 * HOUR;
  assert.ok(awake >= HOUR - S.TICK_MS && awake <= HOUR, `about an hour awake: ${awake / MIN} min`);
});

test('every sleep is left out, however many come before its time', () => {
  const c = useFake();
  let ranAt: number | null = null;
  S.awakeTimeout(() => (ranAt = c.t), 30 * MIN);
  for (let i = 0; i < 5; i++) {
    c.run(5 * MIN);
    c.sleep(3 * HOUR + i * 7 * MIN);
  }
  assert.equal(ranAt, null, 'not yet: 25 minutes awake');
  c.run(5 * MIN + S.TICK_MS);
  assert.ok(ranAt !== null);
  const slept = 5 * 3 * HOUR + 7 * MIN * (0 + 1 + 2 + 3 + 4);
  const awake = ranAt! - slept;
  assert.ok(awake >= 30 * MIN - 5 * S.TICK_MS && awake <= 30 * MIN, `30 minutes awake: ${awake / SEC} s`);
});

test('a pause under GAP_MS (screen off, the Desktop Activity Moderator) counts as awake', () => {
  const c = useFake();
  let ranAt: number | null = null;
  S.awakeTimeout(() => (ranAt = c.t), 10 * MIN);
  for (let i = 0; i < 10; i++) {
    c.run(10 * SEC);
    c.sleep(S.GAP_MS - S.TICK_MS - SEC);
  }
  c.run(10 * MIN);
  assert.equal(ranAt, 10 * MIN, 'on time');
});

test('cleared, it never runs, and the ticker stops; cleared after a sleep too', () => {
  const c = useFake();
  let ran = 0;
  const a = S.awakeTimeout(() => ran++, MIN);
  const b = S.awakeTimeout(() => ran++, HOUR);
  a.clear();
  a.clear();
  c.run(30 * SEC);
  c.sleep(5 * HOUR);
  c.run(1);
  b.clear();
  assert.equal(b.left(), 0);
  c.run(2 * HOUR);
  assert.equal(ran, 0);
  assert.equal(c.waiting, 0);
});

test('a timer that comes first after a wake, before the ticker beats, still sees the sleep', () => {
  const c = useFake();
  const long = S.awakeTimeout(() => {}, 10 * HOUR);
  c.run(2 * SEC);
  let ranAt: number | null = null;
  // Due at 62 s: after the beat at 60 s, before the one at 65 s.
  S.awakeTimeout(() => (ranAt = c.t), MIN);
  c.run(58 * SEC + 500);
  c.sleep(4 * HOUR);
  c.run(1);
  assert.equal(ranAt, null, 'not at the wake');
  c.run(MIN);
  assert.ok(ranAt !== null && ranAt - 4 * HOUR < 2 * MIN + S.TICK_MS);
  long.clear();
});

test('awakeDelay waits awake time', async () => {
  const c = useFake();
  let done = false;
  const p = S.awakeDelay(10 * MIN).then(() => (done = true));
  c.run(MIN);
  c.sleep(HOUR);
  c.run(8 * MIN);
  await Promise.resolve();
  assert.equal(done, false);
  c.run(MIN + S.TICK_MS);
  await p;
  assert.equal(done, true);
});

test("under Node's own timers it is a setTimeout", async () => {
  S.setAwakeClock(null);
  const t0 = performance.now();
  await new Promise<void>((resolve) => S.awakeTimeout(resolve, 50));
  assert.ok(performance.now() - t0 >= 45);
  const t = S.awakeTimeout(() => assert.fail('cleared'), 20).unref();
  assert.ok(t.left() > 0 && t.left() <= 20);
  t.clear();
  await new Promise((r) => setTimeout(r, 40));
});

test("a round a sleep caught isn't let go at the wake; one that runs past its awake time still is", async () => {
  setDuty(true);
  const c = useFake();
  let finish!: () => void;
  const job = every(HOUR, () => new Promise<void>((r) => (finish = r)), { firstDelayMs: 10 * HOUR, name: 'slept', timeoutMs: 2 * HOUR });
  try {
    assert.ok(job.runNow());
    await until(() => typeof finish === 'function', 5_000, 'the round started');
    c.run(HOUR);
    c.sleep(14 * HOUR);
    c.run(SEC);
    await new Promise((r) => setImmediate(r));
    assert.ok(job.state.runningSince, 'still running after the wake');
    finish();
    await until(() => job.state.runningSince === null, 5_000, 'the round ended');
    const r = readJson<any>(roundFile(), null).rounds.slept;
    assert.equal(r.ok, true);
    assert.equal(r.timedOut, undefined);

    finish = undefined as unknown as () => void;
    assert.ok(job.runNow());
    await until(() => typeof finish === 'function', 5_000, 'the second round started');
    c.run(HOUR);
    c.sleep(3 * HOUR);
    c.run(HOUR + S.TICK_MS + SEC);
    await until(() => job.state.runningSince === null, 5_000, 'let go at two hours awake');
    const r2 = readJson<any>(roundFile(), null).rounds.slept;
    assert.equal(r2.ok, false);
    assert.equal(r2.timedOut, true);
    assert.match(r2.error, /ran past its time limit \(2 h\)/);
    finish();
  } finally {
    job.stop();
  }
});

// Windows' event log, as wevtutil gives it (/f:xml): only what slept.ts reads of each event.
const ev = (provider: string, id: number, at: string, record: number, data: Record<string, string | number> = {}) =>
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='${provider}' Guid='{00000000-0000-0000-0000-000000000000}'/><EventID>${id}</EventID><Version>0</Version><TimeCreated SystemTime='${at}'/><EventRecordID>${record}</EventRecordID><Channel>System</Channel></System><EventData>${Object.entries(
    data,
  )
    .map(([k, v]) => `<Data Name='${k}'>${v}</Data>`)
    .join('')}</EventData></Event>`;
const KP = 'Microsoft-Windows-Kernel-Power';
const KG = 'Microsoft-Windows-Kernel-General';
const PT = 'Microsoft-Windows-Power-Troubleshooter';
const us = (ms: number) => String(Math.round(ms * 1000));
const T = (iso: string) => Date.parse(iso);

// The owner's laptop, 2026-11-03 to 11-05 (UTC): the lid shut, standby sessions written back to back (a 507 and the
// next 506 in the same instant), one with only screen off (185 s, 1 s asleep), and the lid opened.
const laptop = [
  ev(KP, 507, '2026-11-03T16:47:52.1000000Z', 9001, { Reason: 15, DurationInUs: us(30_486_000), SleepDurationInUs: us(30_485_000), ScreenOffDurationInUs: us(1000) }),
  ev(KP, 506, '2026-11-03T16:47:52.1000000Z', 9002, { Reason: 15 }),
  ev(KP, 507, '2026-11-05T02:39:21.0000000Z', 9003, { Reason: 16777220, DurationInUs: us(22_547_000), SleepDurationInUs: us(22_415_000), ScreenOffDurationInUs: us(132_000) }),
  ev(KP, 506, '2026-11-05T02:39:21.0000000Z', 9004, { Reason: 16777220 }),
  ev(KP, 507, '2026-11-05T02:42:26.0000000Z', 9005, { Reason: 16777220, DurationInUs: us(185_000), SleepDurationInUs: us(1000), ScreenOffDurationInUs: us(184_000) }),
  ev(KP, 506, '2026-11-05T02:42:26.0000000Z', 9006, { Reason: 16777220 }),
  ev(KP, 507, '2026-11-05T15:51:11.1905598Z', 9007, { Reason: 15, DurationInUs: us(47_325_190), SleepDurationInUs: us(47_262_000), ScreenOffDurationInUs: us(63_000) }),
];

test('Modern Standby: each session slept at its end, by its 507; a session awake in screen off counts nothing', () => {
  const s = S.sleepsOf(laptop.join('\r\n'));
  assert.equal(s.standbySince, null, 'woken: the last 507 came after the last 506');
  assert.deepEqual(
    s.spans.map((x) => [new Date(x.from).toISOString(), new Date(x.to).toISOString(), x.kind]),
    [
      ['2026-11-03T08:19:47.100Z', '2026-11-03T16:47:52.100Z', 'standby'],
      ['2026-11-04T20:25:46.000Z', '2026-11-05T02:39:21.000Z', 'standby'],
      ['2026-11-05T02:43:29.190Z', '2026-11-05T15:51:11.190Z', 'standby'],
    ],
  );
  // Reeve's job started at 02:39:34 in the screen-off session and was let go at 04:16:55: of that, 93 minutes asleep.
  const from = T('2026-11-05T02:39:34Z');
  const to = T('2026-11-05T04:16:55Z');
  assert.equal(S.sleptIn(s.spans, from, to), to - T('2026-11-05T02:43:29.190Z'));
});

test('a 506 after the last 507 is a session not yet ended: in standby since then', () => {
  const open = [...laptop.slice(0, 6)].join('');
  assert.equal(S.sleepsOf(open).standbySince, T('2026-11-05T02:42:26Z'));
  // Written in the same instant, the record number orders them: 506 then 507 is a session ended.
  const same = ev(KP, 506, '2026-11-05T02:00:00Z', 1) + ev(KP, 507, '2026-11-05T02:00:00Z', 2, { SleepDurationInUs: 0 });
  assert.equal(S.sleepsOf(same).standbySince, null);
  const sameOpen = ev(KP, 507, '2026-11-05T02:00:00Z', 1, { SleepDurationInUs: 0 }) + ev(KP, 506, '2026-11-05T02:00:00Z', 2);
  assert.equal(S.sleepsOf(sameOpen).standbySince, T('2026-11-05T02:00:00Z'));
  // Newest first, as wevtutil's /rd:true gives them: the same.
  assert.equal(S.sleepsOf([...laptop.slice(0, 6)].reverse().join('')).standbySince, T('2026-11-05T02:42:26Z'));
  assert.equal(S.sleepsOf('').standbySince, null);
});

test('S3 and hibernation (Power-Troubleshooter 1), and the PC off (Kernel-General 13 to 12)', () => {
  const xml = [
    ev(PT, 1, '2026-11-02T07:00:05Z', 1, { SleepTime: '2026-11-01T23:10:00.0000000Z', WakeTime: '2026-11-02T07:00:00.0000000Z' }),
    ev(KG, 13, '2026-11-02T18:07:13.6303820Z', 2, { StopTime: '2026-11-02T18:07:13.6303801Z' }),
    ev(KG, 12, '2026-11-02T18:07:24.9905645Z', 3, { StartTime: '2026-11-02T18:07:24.5000000Z' }),
    // A 12 with no 13 before it (the PC lost power): nothing is known of when it stopped.
    ev(KG, 12, '2026-11-03T09:00:00Z', 4, { StartTime: '2026-11-03T08:59:58Z' }),
    // A sleep with no wake, and a wake before its sleep: neither counts.
    ev(PT, 1, '2026-11-03T10:00:00Z', 5, { SleepTime: '2026-11-03T09:00:00Z' }),
    ev(PT, 1, '2026-11-03T11:00:00Z', 6, { SleepTime: '2026-11-03T11:00:00Z', WakeTime: '2026-11-03T10:00:00Z' }),
  ].join('');
  const s = S.sleepsOf(xml);
  assert.deepEqual(s.spans, [
    { from: T('2026-11-01T23:10:00Z'), to: T('2026-11-02T07:00:00Z'), kind: 'sleep' },
    { from: T('2026-11-02T18:07:13.630Z'), to: T('2026-11-02T18:07:24.500Z'), kind: 'off' },
  ]);
});

test('a shutdown ends a standby session left open', () => {
  const xml = ev(KP, 506, '2026-11-02T17:00:00Z', 1) + ev(KG, 13, '2026-11-02T18:00:00Z', 2, { StopTime: '2026-11-02T18:00:00Z' }) + ev(KG, 12, '2026-11-02T18:01:00Z', 3, { StartTime: '2026-11-02T18:01:00Z' });
  const s = S.sleepsOf(xml);
  assert.equal(s.standbySince, null);
  assert.deepEqual(s.spans, [{ from: T('2026-11-02T18:00:00Z'), to: T('2026-11-02T18:01:00Z'), kind: 'off' }]);
});

test('sleptIn counts each moment once, and only inside the stretch asked', () => {
  const spans = [
    { from: 100, to: 200, kind: 'standby' as const },
    { from: 150, to: 300, kind: 'sleep' as const },
    { from: 500, to: 600, kind: 'off' as const },
  ];
  assert.equal(S.sleptIn(spans, 0, 1000), 300);
  assert.equal(S.sleptIn(spans, 250, 550), 100);
  assert.equal(S.sleptIn(spans, 300, 500), 0);
  assert.equal(S.sleptIn([], 0, 1000), 0);
});

test('readSleeps asks the log for the stretch since, LOOK_BACK_MS at most; null when it cannot be read', async () => {
  const asked: number[] = [];
  const now = T('2026-11-05T16:00:00Z');
  const s = await S.readSleeps(now - 3 * HOUR, { now, query: async (ms) => (asked.push(ms), laptop.join('')) });
  assert.equal(s?.spans.length, 3);
  assert.equal(asked[0], 3 * HOUR + MIN);
  await S.readSleeps(0, { now, query: async (ms) => (asked.push(ms), '') });
  assert.equal(asked[1], S.LOOK_BACK_MS + MIN);
  assert.equal(await S.readSleeps(now - HOUR, { now, query: async () => null }), null);
  assert.equal(await S.readSleeps(now - HOUR, { now, query: async () => Promise.reject(new Error('no')) }), null);
  assert.equal(await S.readSleeps(now - HOUR), null, 'never the real log under node --test');
});

test("this PC's own log reads, when it's Windows", { skip: process.platform !== 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const q = "*[System[((Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=506 or EventID=507)) or (Provider[@Name='Microsoft-Windows-Kernel-General'] and (EventID=12 or EventID=13))) and TimeCreated[timediff(@SystemTime) <= 1209600000]]]";
  const xml = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wevtutil.exe'), ['qe', 'System', `/q:${q}`, '/f:xml', '/rd:true', '/c:2000'], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const s = S.sleepsOf(xml);
  for (const x of s.spans) assert.ok(x.to > x.from && x.to <= Date.now() + MIN, JSON.stringify(x));
  assert.equal(s.standbySince, null, 'this test runs awake, outside any standby session');
});
