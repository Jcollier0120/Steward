import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * The PC's sleeps, and time limits that count only the time it was awake (kit 2.150.4).
 *
 * On 2026-11-05 the owner's laptop had slept for most of two days (the lid closed; Modern Standby), and Manor's list
 * was full of warnings, none of them true. Node's timers go on counting while the PC sleeps (they run on Windows'
 * performance counter, which does), so a time limit that fell due in the sleep fired at the PC's next wake, however
 * little of it the work had had: a round "ran past its time limit (2 h)" after 913 minutes, nearly all of them asleep,
 * and three of those in a row stopped the Smith's rounds; Reeve's job "timed out after 5400 s" after 22,463 s; a
 * PowerShell script timed out, and "The PC's checks couldn't run". And the Surveyor took a round 44 hours old for an
 * agent that had stopped, when the PC had been awake for a few of them.
 *
 * Two ways of knowing, for two questions:
 * - **How long has this process been able to run?** `awakeTimeout()` is a setTimeout that counts only that. While one
 *   waits, a ticker beats every TICK_MS; a beat that comes GAP_MS or more after the one before means the process was
 *   stopped in between, the PC asleep (in Modern Standby every desktop app is; in screen off the Desktop Activity
 *   Moderator pauses them 5 to 20 s at a time, which stays under GAP_MS: spec/ROUND.md). When its time comes, it beats
 *   once more and waits on for whatever the sleeps took. No call to Windows: it costs nothing, and works elsewhere
 *   too. A loop held GAP_MS or more by the agent's own work counts as sleep as well, which only waits longer.
 * - **How long did the PC sleep between two times?** `readSleeps()`, for times this process didn't see (another
 *   agent's last round): Windows' event log, asked once (wevtutil, tens of ms). Modern Standby's sessions (Kernel-Power
 *   507, written as one ends, with how long it slept: the sleep is the session's end, after the screen-off part that
 *   begins it), S3 and hibernation (Power-Troubleshooter 1: its SleepTime and WakeTime), and the PC off (Kernel-General
 *   13's StopTime to the next 12's StartTime). `sleptIn()` says how much of a stretch they cover. A 506 with no 507
 *   after it is a session not yet ended: the PC is in standby's screen off (a maintenance wake), or woke a moment ago
 *   and Windows hasn't written its 507 yet; `standbySince` says so.
 */

/** How often the ticker beats while an awake timer waits (ms). */
export const TICK_MS = 5_000;
/** A beat this long after the one before (ms) means the process was stopped in between: the PC slept. */
export const GAP_MS = 30_000;

/** The clock and timers awake timers run on: Node's; a test stands in its own (setAwakeClock). */
export interface AwakeClock {
  /** A clock that goes on through sleep and never goes back (ms). */
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (t: unknown) => void;
}

const nodeClock = (): AwakeClock => ({
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
  // The ticker never keeps the process up: a timer that waits does, unless it's unref'd. (A test's mocked setInterval
  // may give one with no unref.)
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    (t as { unref?: () => void } | null)?.unref?.();
    return t;
  },
  clearInterval: (t) => clearInterval(t as NodeJS.Timeout),
});
let clock = nodeClock();

/** The stretches, on the clock, this process was stopped while an awake timer waited: [from, to]. */
let gaps: [number, number][] = [];
let lastBeat = 0;
let ticker: unknown = null;
let waiting = 0;

/** A gap is counted from the beat before it: a timer may wait up to a beat longer, never let go early. */
function beat(): void {
  const now = clock.now();
  if (now - lastBeat >= GAP_MS) gaps.push([lastBeat, now]);
  lastBeat = now;
}

function hold(): void {
  if (waiting++ > 0) return;
  lastBeat = clock.now();
  gaps = [];
  ticker = clock.setInterval(beat, TICK_MS);
}

function release(): void {
  if (--waiting > 0) return;
  waiting = 0;
  clock.clearInterval(ticker);
  ticker = null;
  gaps = [];
}

/** For tests: the clock and timers stood in for; null puts Node's back. Any timer waiting is forgotten. */
export function setAwakeClock(c: AwakeClock | null): void {
  if (ticker !== null) clock.clearInterval(ticker);
  ticker = null;
  waiting = 0;
  gaps = [];
  clock = c ?? nodeClock();
}

/** How long this process was stopped since `start` on the clock (ms): its gaps. */
function stoppedSince(start: number, now: number): number {
  let stopped = 0;
  for (const [a, b] of gaps) stopped += Math.max(0, Math.min(b, now) - Math.max(a, start));
  return stopped;
}

/** A timer of awakeTimeout's. */
export interface AwakeTimer {
  /** Stops it: its function never runs. Again, or once it has run, does nothing. */
  clear(): void;
  /** The awake time it has still to wait (ms); 0 once it has run or been cleared. A budget's own clock, too. */
  left(): number;
  /** As a Node timer's: it doesn't keep the process up. */
  unref(): AwakeTimer;
}

/**
 * Runs `fn` once the process has been able to run for `ms`: setTimeout's time, with the time the PC slept left out.
 * Clear it as a setTimeout is cleared, with its `clear()`.
 */
export function awakeTimeout(fn: () => void, ms: number): AwakeTimer {
  hold();
  const start = clock.now();
  let done = false;
  let unref = false;
  let t: unknown;
  const arm = (wait: number) => {
    t = clock.setTimeout(fire, Math.max(1, Math.ceil(wait)));
    if (unref) (t as { unref?: () => void } | null)?.unref?.();
  };
  const end = () => {
    if (done) return;
    done = true;
    clock.clearTimeout(t);
    release();
  };
  function fire() {
    if (done) return;
    // A gap that ended a moment ago, before the ticker's next beat: this timer may come first after a wake.
    beat();
    const now = clock.now();
    const stopped = stoppedSince(start, now);
    const left = ms - (now - start - stopped);
    // Only a sleep makes it wait on: with none, its time is setTimeout's, as it is under a test's mocked timers.
    if (stopped > 0 && left >= 1) return arm(left);
    end();
    fn();
  }
  arm(ms);
  const timer: AwakeTimer = {
    clear: end,
    left: () => {
      if (done) return 0;
      // Asked right at a wake, before the ticker's next beat: the sleep that ended a moment ago counts.
      beat();
      const now = clock.now();
      return Math.max(0, ms - (now - start - stoppedSince(start, now)));
    },
    unref: () => {
      unref = true;
      (t as { unref?: () => void } | null)?.unref?.();
      return timer;
    },
  };
  return timer;
}

/** Waits `ms` of the process's awake time. */
export const awakeDelay = (ms: number): Promise<void> => new Promise((resolve) => awakeTimeout(resolve, ms));

/** A stretch the PC slept (Modern Standby, S3 or hibernation) or was off, in ms since 1970. */
export interface Slept {
  from: number;
  to: number;
  kind: 'standby' | 'sleep' | 'off';
}

export interface Sleeps {
  /** Each stretch, oldest first. */
  spans: Slept[];
  /**
   * When the Modern Standby session the PC is in began (a 506 with no 507 after it), or null when it isn't in one: in
   * a maintenance wake, or at the very moment of waking, before Windows writes the 507. Nothing any agent did since
   * then says anything of it.
   */
  standbySince: number | null;
}

interface LogEvent {
  provider: string;
  id: number;
  at: number;
  record: number;
  data: Record<string, string>;
}

/** The events of wevtutil's XML (/f:xml): provider, id, when, its record number, and its named data. */
function eventsOf(xml: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const ev of xml.match(/<Event[\s>][\s\S]*?<\/Event>/g) ?? []) {
    const provider = /<Provider\s+Name=['"]([^'"]+)['"]/.exec(ev)?.[1] ?? '';
    const id = Number(/<EventID[^>]*>(\d+)<\/EventID>/.exec(ev)?.[1]);
    const at = Date.parse(/<TimeCreated\s+SystemTime=['"]([^'"]+)['"]/.exec(ev)?.[1] ?? '');
    const record = Number(/<EventRecordID>(\d+)<\/EventRecordID>/.exec(ev)?.[1] ?? 0);
    if (!Number.isFinite(id) || !Number.isFinite(at)) continue;
    const data: Record<string, string> = {};
    for (const m of ev.matchAll(/<Data\s+Name=['"]([^'"]+)['"]>([^<]*)<\/Data>/g)) data[m[1]] = m[2];
    out.push({ provider, id, at, record, data });
  }
  // Written in the same instant (a session's 507 and the next one's 506), the record number orders them.
  return out.sort((a, b) => a.at - b.at || a.record - b.record);
}

/** A standby session that slept less than this (ms) was awake in screen off: its second or so asleep isn't counted. */
const MIN_SLEEP_MS = 5_000;

const KERNEL_POWER = 'Microsoft-Windows-Kernel-Power';
const KERNEL_GENERAL = 'Microsoft-Windows-Kernel-General';
const POWER_TROUBLESHOOTER = 'Microsoft-Windows-Power-Troubleshooter';

/** The sleeps and times off in wevtutil's XML of the events readSleeps asks for. */
export function sleepsOf(xml: string): Sleeps {
  const spans: Slept[] = [];
  let stoppedAt: number | null = null;
  // The standby session the PC is in, by when it began: events come in the order they were written (eventsOf).
  let session: number | null = null;
  for (const e of eventsOf(xml)) {
    if (e.provider === KERNEL_POWER && e.id === 506) session = e.at;
    else if (e.provider === KERNEL_POWER && e.id === 507) {
      session = null;
      const sleptMs = Number(e.data.SleepDurationInUs) / 1000;
      if (Number.isFinite(sleptMs) && sleptMs >= MIN_SLEEP_MS) spans.push({ from: e.at - sleptMs, to: e.at, kind: 'standby' });
    } else if (e.provider === POWER_TROUBLESHOOTER && e.id === 1) {
      const from = Date.parse(e.data.SleepTime ?? '');
      const to = Date.parse(e.data.WakeTime ?? '');
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) spans.push({ from, to, kind: 'sleep' });
    } else if (e.provider === KERNEL_GENERAL && e.id === 13) {
      const t = Date.parse(e.data.StopTime ?? '');
      stoppedAt = Number.isFinite(t) ? t : e.at;
    } else if (e.provider === KERNEL_GENERAL && e.id === 12) {
      const t = Date.parse(e.data.StartTime ?? '');
      const startedAt = Number.isFinite(t) ? t : e.at;
      if (stoppedAt !== null && startedAt > stoppedAt) spans.push({ from: stoppedAt, to: startedAt, kind: 'off' });
      stoppedAt = null;
      // A session left open by a shutdown, or a crash, ended with it.
      session = null;
    }
  }
  spans.sort((a, b) => a.from - b.from);
  return { spans, standbySince: session };
}

/** How much of `from` to `to` (ms since 1970) the spans cover, each moment once. */
export function sleptIn(spans: readonly Slept[], from: number, to: number): number {
  const clipped = spans
    .map((s) => [Math.max(s.from, from), Math.min(s.to, to)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let reached = -Infinity;
  for (const [a, b] of clipped) {
    const start = Math.max(a, reached);
    if (b > start) total += b - start;
    reached = Math.max(reached, b);
  }
  return total;
}

/** How far back readSleeps reads at most (ms): older stretches are counted as awake. */
export const LOOK_BACK_MS = 30 * 24 * 3_600_000;

const WEVTUTIL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wevtutil.exe');

/** The events of the last `ms`, newest first and 2000 at most; null when the log can't be read. */
function querySleeps(ms: number): Promise<string | null> {
  const which =
    `(Provider[@Name='${KERNEL_POWER}'] and (EventID=506 or EventID=507)) or ` +
    `(Provider[@Name='${POWER_TROUBLESHOOTER}'] and EventID=1) or ` +
    `(Provider[@Name='${KERNEL_GENERAL}'] and (EventID=12 or EventID=13))`;
  const q = `*[System[(${which}) and TimeCreated[timediff(@SystemTime) <= ${Math.ceil(ms)}]]]`;
  return new Promise((resolve) =>
    execFile(WEVTUTIL, ['qe', 'System', `/q:${q}`, '/f:xml', '/rd:true', '/c:2000'], { windowsHide: true, timeout: 30_000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (e, out) =>
      resolve(e ? null : String(out ?? '')),
    ),
  );
}

/**
 * The PC's sleeps and times off since `since` (ms since 1970; LOOK_BACK_MS at most), from Windows' event log; null
 * when it can't be read (or it isn't Windows, or under node --test without a test's own query). Never throws.
 */
export async function readSleeps(since: number, o: { now?: number; query?: (ms: number) => Promise<string | null> } = {}): Promise<Sleeps | null> {
  try {
    if (!o.query && (process.platform !== 'win32' || process.env.NODE_TEST_CONTEXT)) return null;
    const now = o.now ?? Date.now();
    const xml = await (o.query ?? querySleeps)(Math.min(Math.max(0, now - since), LOOK_BACK_MS) + 60_000);
    return xml === null ? null : sleepsOf(xml);
  } catch {
    return null;
  }
}
