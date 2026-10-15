import { APP } from '../app.ts';
import { stayAwake } from './awake.ts';
import { duty } from './duty.ts';
import { trialEnded } from './license-check.ts';
import { isDemo } from './demo.ts';
import { needsSettings } from './required.ts';
import { offlineFailure } from './net.ts';
import { LockTimeout, QueueFull } from './npu-queue.ts';
import { paceProcess } from './gentle.ts';
import { FIRST_ROUND_WAITING, WORK_WAITING, inFirstRoundTurn, inWorkTurn, pace } from './pace.ts';
import { dataFile, readJson, writeJson } from './store.ts';
import { inWork, startWork } from './work-tasks.ts';

/** One schedule's rounds, as /api/ping and the page's status pill give them (ISO times). */
export interface RoundState {
  name: string;
  /** When the last round ended, and whether it went through (null before the first, or unknown). */
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  /** Whether the last round waited for the network: it failed while this PC was offline (net.ts), so it's no failure (lastRunOk null). */
  lastRunOffline: boolean;
  lastError: string | null;
  /** When the next scheduled round is due; null off duty, or once stopped. */
  nextRunAt: string | null;
  /** When the round under way began; null when none is. */
  runningSince: string | null;
  /** What its rounds wait for (required.ts's needsSettings, or license-check.ts's trial's end, in words); null when they wait for nothing. */
  waiting: string | null;
  /**
   * Its first round (kit 2.43.3): `waiting` in the first-round line (pace.ts), `running` while it runs, null once a
   * round has gone through. The page shows the agent settling into the manor.
   */
  firstRound: 'waiting' | 'running' | null;
}

/**
 * One schedule's last round, as round.json keeps it (spec/ROUND.md): when it started and finished (ISO),
 * whether it went through, the error's first line when it didn't, the interval, and when the next is due.
 */
export interface RoundRecord {
  started: string;
  finished: string;
  /** true when it went through, false when it threw, null when it waited for the network (offline). */
  ok: boolean | null;
  /** true when it failed only because this PC was offline (net.ts's offlineFailure): waited out, never a failure. */
  offline?: boolean;
  /** The thrown error's message, its first line, at most 500 characters; null when it went through. */
  error: string | null;
  /** The interval between rounds when the round ended (on the clock since kit 2.72.0; off it, each wait varies by ±10% about it). */
  everyMs: number;
  /** On the clock (kit 2.72.0): how far into each of its slots its rounds fall, in milliseconds (clockPhase). Absent off the clock. */
  phaseMs?: number;
  /** When the next scheduled round is due; null off duty, or once stopped (as /api/ping's nextRunAt). */
  next: string | null;
  /** A round held for the agent's required settings (required.ts), or because the trial has ended (license-check.ts): what it waits for, in words. `ok` is null then. */
  waiting?: string;
  /** true when the round ran past its time limit and was let go (every()'s timeoutMs): `ok` is false then. */
  timedOut?: boolean;
  /** Beside `waiting`, when the round waited its turn in a line (pace.ts: `first`, the first-round line; `work`, the work line) rather than for the person. Since kit 2.56.0. */
  turn?: 'first' | 'work';
  /** How long it waited its turn before it ran (the first-round line, the work line), in milliseconds; absent when it didn't. Since kit 2.56.0. */
  waitedMs?: number;
  /** The processor time the agent's own process used in the round, in milliseconds (the programs it started aren't counted). Since kit 2.56.0. */
  cpuMs?: number;
  /** The most memory the agent's process held in the round, in megabytes, sampled every few seconds. Since kit 2.56.0. */
  memoryMb?: number;
}

/** The manor's shared clock (kit 2.72.0): the agents' rounds fall on its 30-minute slots, or on a divisor or multiple of them. */
export const CLOCK_MS = 30 * 60_000;
const DAY_MS = 24 * 3_600_000;

/**
 * An interval as the scheduler keeps it: to the whole second from a minute up, so one worked out in another unit
 * (29.99999 minutes, 0.4999999 hours) can't drift off the clock. Under a minute, as given.
 */
export const wholeInterval = (ms: number) => (ms >= 60_000 ? Math.round(ms / 1000) * 1000 : ms);

/**
 * Whether an interval fits the shared clock: whole minutes, and a divisor of 30 minutes (1, 2, 3, 5, 6, 10, 15 or 30
 * minutes) or a multiple of it that divides the day (1, 2, 3, 4, 6, 8, 12 or 24 hours, 90 minutes…). One that doesn't
 * (7 minutes, 5 hours) keeps the old way: each wait counted from the last round, varied by ±10%.
 */
export function fitsClock(everyMs: number): boolean {
  const ms = wholeInterval(everyMs);
  if (ms < 60_000 || ms % 60_000 !== 0) return false;
  if (ms <= CLOCK_MS) return CLOCK_MS % ms === 0;
  return ms % CLOCK_MS === 0 && DAY_MS % ms === 0;
}

/** FNV-1a, 32 bits: the same number for the same text on every PC. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * How far into each of its slots a schedule's rounds fall: a whole number of minutes, the same for an agent's schedule
 * on every PC and at every start, under both its interval and the 30-minute clock (a 5-minute round 0–4 minutes into
 * each slot, an hourly or 6-hourly one 0–29). So the staff spread over the clock instead of all reaching for the PC
 * in the same minute.
 */
export function clockPhase(who: string, name: string, everyMs: number): number {
  const minutes = Math.min(wholeInterval(everyMs), CLOCK_MS) / 60_000;
  return (hash(`${who}/${name}`) % minutes) * 60_000;
}

/**
 * A schedule's first slot on the clock at or after `notBefore`: `phaseMs` past a multiple of `everyMs`, counted from
 * local midnight, so a 30-minute round falls at :00 and :30 plus its phase, and a 6-hourly one at 00:00, 06:00, 12:00
 * and 18:00 plus it, in this PC's time.
 */
export function nextOnClock(notBefore: number, everyMs: number, phaseMs: number): number {
  const ms = wholeInterval(everyMs);
  const offset = new Date(notBefore).getTimezoneOffset() * 60_000;
  const local = notBefore - offset;
  return Math.ceil((local - phaseMs) / ms) * ms + phaseMs + offset;
}

/** A round that ran past its time limit: every() lets it go, records it, and the next round tries again. */
export class RoundTimeout extends Error {
  constructor(ms: number) {
    super(`it ran past its time limit (${span(ms)}): let go, and the next round tries again`);
    this.name = 'RoundTimeout';
  }
}

const span = (ms: number) => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** How long a round may run before it is let go, unless the agent says: three intervals, and at least two hours. */
export const roundTimeLimit = (everyMs: number) => Math.max(3 * everyMs, 2 * 3_600_000);

/** round.json, in the agent's data folder: `{ "rounds": { "<name>": RoundRecord } }`, one entry per schedule. */
export const roundFile = () => dataFile('round.json');

/** A thrown thing as round.json says it: the first line of its message, at most 500 characters. */
export function roundError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const line = (message ?? '').split(/\r?\n|\r/)[0].trim();
  return (line || 'it failed').slice(0, 500);
}

let roundFileWarned = false;
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Keeps `record` as schedule `name`'s entry in round.json, the other schedules' entries as they were (read,
 * changed, written whole through a rename). A file that can't be read is started afresh. Never throws: a
 * round.json that can't be written says so once in the log, and the rounds go on.
 */
function recordRound(name: string, record: RoundRecord): void {
  try {
    const file = roundFile();
    const was = readJson<unknown>(file, {});
    const doc = isObject(was) ? was : {};
    const kept = isObject(doc.rounds) ? doc.rounds : {};
    const through = { ...wentThroughIn(doc), ...(record.ok === true ? { [name]: record.finished } : {}) };
    writeJson(file, { ...doc, rounds: { ...kept, [name]: record }, wentThrough: through });
  } catch (e) {
    if (roundFileWarned) return;
    roundFileWarned = true;
    console.error(`${new Date().toISOString()} couldn't keep the round in round.json (said once; the rounds go on): ${roundError(e)}`);
  }
}

/**
 * A round held for the person (its trial over, or its required settings still to fill in), kept in round.json when the
 * hold starts or what it waits for changes. While it holds for the same reason its entry stays as it was, `started`
 * and `finished` when the hold began (kit 2.71.3): before, it was written again at each interval, a rename an interval
 * for nothing.
 */
function recordHeld(name: string, waiting: string, everyMs: number): void {
  const was = readJson<unknown>(roundFile(), {});
  const r = isObject(was) && isObject(was.rounds) ? was.rounds[name] : null;
  if (isObject(r) && r.ok === null && r.waiting === waiting && r.everyMs === everyMs && r.error === null && r.next === null && r.turn === undefined) return;
  const now = new Date().toISOString();
  recordRound(name, { started: now, finished: now, ok: null, waiting, error: null, everyMs, next: null });
}

/**
 * round.json's `wentThrough`: each schedule's first round that went through, when (kit 2.43.3). A round.json from before
 * it, with rounds but no `wentThrough`, counts every schedule it names as through: an agent that already ran is never
 * taken for a new one, so updating never puts it in the first-round line.
 */
function wentThroughIn(doc: Record<string, unknown>): Record<string, unknown> {
  if (isObject(doc.wentThrough)) return doc.wentThrough;
  const before = isObject(doc.rounds) ? doc.rounds : {};
  return Object.fromEntries(Object.entries(before).map(([n, r]) => [n, isObject(r) && typeof r.finished === 'string' ? r.finished : true]));
}

/** Whether schedule `name` has had a round that went through, on this PC, ever (round.json's wentThrough). */
export function firstRoundDone(name: string): boolean {
  const was = readJson<unknown>(roundFile(), {});
  return isObject(was) && wentThroughIn(was)[name] !== undefined;
}

/** Every schedule this process runs, each read when asked. */
const schedules = new Set<() => RoundState>();

/** Each schedule's rounds: an agent may run several (the Miller grinds and names on two). */
export const rounds = (): RoundState[] => [...schedules].map((s) => s());

/** Every schedule's runSoon(), by its state: the kit's `round` repair (repair.ts) starts them. */
const soon = new Map<() => RoundState, () => boolean>();

/** Starts a scheduled round now on every schedule that can start one (runSoon); the names of those that did. */
export const runRoundsSoon = (): string[] => [...soon].filter(([, go]) => go()).map(([s]) => s().name);

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const latest = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
const earliest = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort()[0] ?? null;

/**
 * The agent's rounds at a glance, as every agent's /api/ping gives them for Manor's employee cards: the last
 * round to end and whether it went through, the next one due, and since when one has been running.
 */
/** The agent's first round now, over all its schedules: waiting in line while any is, else running while any is. */
export function firstRoundNow(): RoundState['firstRound'] {
  const all = rounds().map((r) => r.firstRound);
  return all.includes('waiting') ? 'waiting' : all.includes('running') ? 'running' : null;
}

export function roundTimes(): Pick<RoundState, 'lastRunAt' | 'lastRunOk' | 'lastRunOffline' | 'nextRunAt' | 'runningSince'> {
  const all = rounds();
  const lastRunAt = latest(all.map((r) => r.lastRunAt));
  const last = all.find((r) => r.lastRunAt === lastRunAt);
  return {
    lastRunAt,
    lastRunOk: last?.lastRunOk ?? null,
    lastRunOffline: last?.lastRunOffline ?? false,
    nextRunAt: earliest(all.map((r) => r.nextRunAt)),
    runningSince: earliest(all.map((r) => r.runningSince)),
  };
}

/**
 * Runs `job` soon after start and then every `everyMs` after the last run ended, never two at once.
 * The agent works only while it is employed (running): there's no Task Scheduler entry to leave behind.
 *
 * Staggered: Manor may start every agent at once, so the first round comes a while after start (random: 2 to 15
 * minutes at a gentle pace, kit 2.50.0, so a PC that has just started isn't ground down by every agent at once; 30 s
 * to 3 min at a full pace).
 *
 * On the clock (kit 2.72.0): an interval that fits the manor's shared 30-minute clock (fitsClock: 5, 10, 15 or 30
 * minutes, 1, 3 or 6 hours…) puts each later round on its slots (nextOnClock), at the schedule's own phase (clockPhase:
 * whole minutes from the agent's id and the schedule's name, unless `phaseMs` says), and at least half an interval
 * after the last round ended. So rounds don't drift, and the staff don't all fire in the same minute. Any other
 * interval keeps the old way: each wait counted from when the last round ended, varied by ±10%, so the staff don't
 * all reach for the NPU together.
 *
 * At the manor's pace (pace.ts, kit 2.43.3; gentle unless Manor's Settings say full), the agent runs gentle from
 * the start, and a scheduled round too: below-normal priority, and Heiward's efficiency mode, very low disk priority
 * and processor cap (gentle.ts, kit 2.50.0); a round someone asked for runs at the same pace (kit 2.73.0). A schedule's first
 * round (none has gone through: round.json's wentThrough) waits its
 * turn in one line with the other agents' first rounds, one at a time. While it waits, its state says so (waiting,
 * firstRound), and the page shows the agent settling into the manor. A round the person asks for never waits.
 *
 * Off duty (duty.ts), scheduled rounds are skipped; runNow() still runs one. runSoon() is for the agent's own
 * reasons to start a round early (something changed): a scheduled round, at the pace, now.
 *
 * `everyMs` may be a function, read each time a wait is set: then an interval changed on the Settings
 * panel takes effect at once, with reschedule() setting the wait under way to the new interval.
 * The shared round interval (shared-settings.ts) comes as one: every(roundEveryMs(() => settings, ROUND), round).
 * `lastEndedAt` is when the last run ended before this process started (from the agent's report), so
 * that reschedule() counts from it until a run has ended here. `name` tells an agent's schedules apart
 * in /api/ping's `rounds` ("round" unless said).
 *
 * Each schedule records its rounds (rounds(), roundTimes()): when the last ended and whether it went
 * through, when the next is due, and since when one has been running. Each round that runs also leaves its
 * outcome in the data folder's round.json, under the schedule's name (spec/ROUND.md), for readers outside
 * the agent (the Surveyor); a round.json that can't be written never fails the round.
 *
 * A round that fails because this PC is offline (net.ts's offlineFailure: a network error while no host
 * answers, or an Offline thrown) is no failure: it waited for the network. Its lastRunOk is null and
 * lastRunOffline true, round.json says `"ok": null, "offline": true`, and the log says it waits, never
 * "run failed". The next round comes at its usual time.
 *
 * Its rounds never stop silently (kit 2.34.0):
 * - Held for its required settings (required.ts), a scheduled round runs nothing, but is still recorded: round.json
 *   says `"ok": null, "waiting": "<what>"` from the first round held (written again only when what it waits for
 *   changes, kit 2.71.3), and its state says `waiting`, so a reader sees a reason and a schedule still going, never
 *   silence.
 * - A round that runs past its time limit (`timeoutMs`, a number or a function read at each round; else
 *   roundTimeLimit(), three intervals and at least two hours) is let go: its job's signal is aborted, it is recorded
 *   as failed with `"timedOut": true`, and the next round is scheduled, which tries again. A hung await (a request
 *   that never answers, a child process that never ends) can't stop the rounds after it. The job that was let go
 *   may still finish later: then the log says so, and nothing else changes. A job that can stop when asked takes
 *   the signal (`job({ signal })`); one that can't is simply no longer waited for.
 *
 * A scheduled round takes its turn in the work line (pace.ts's inWorkTurn(), kit 2.56.0): a few agents' rounds at a
 * time on this PC, fewer while it is busy. While it waits, its state's `waiting` says so. A schedule whose rounds are
 * `light` (a few requests, a look at a file: no heavy work) runs them at once, outside the line, as a round asked for
 * (Run now) always does: `true`, or a function asked before each round (light while it has nothing due, say).
 *
 * A round's work keeps the PC awake (awake.ts, kit 2.74.8): the job's `awake(what)` holds Windows from sleeping on its
 * own while it runs checks, merges or a release, until the function it returns is called, or the round ends. Only for
 * work: a round that only looks holds nothing, so the PC still sleeps between rounds.
 */
export function every(
  everyMs: number | (() => number),
  job: (round: { signal: AbortSignal; awake: (what: string) => () => void }) => Promise<void>,
  opts: { firstDelayMs?: number; lastEndedAt?: number; name?: string; timeoutMs?: number | (() => number); light?: boolean | (() => boolean); phaseMs?: number } = {},
) {
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let lastError: string | null = null;
  let stopped = false;
  /** When the last run ended (null before the first, unless the agent said), and the current wait's jitter. */
  let lastEnded: number | null = opts.lastEndedAt ?? null;
  let lastOk: boolean | null = null;
  let lastOffline = false;
  let startedAt: number | null = null;
  /** What the rounds wait for from the person, as the last tick found it. */
  let waiting: string | null = null;
  /** When the wait under way ends. */
  let dueAt: number | null = null;
  /** Its first round now: waiting in line, running, or none (RoundState's firstRound). */
  let firstNow: RoundState['firstRound'] = null;
  let jitter = 1;
  const interval = () => wholeInterval(typeof everyMs === 'function' ? everyMs() : everyMs);
  /** Its phase on the clock at the interval now; null when the interval doesn't fit the clock. */
  const phase = (ms = interval()) => (!fitsClock(ms) ? null : opts.phaseMs !== undefined ? ((opts.phaseMs % ms) + ms) % ms : clockPhase(APP.id, opts.name ?? 'round', ms));
  /** When the round after one that ended at `ended` is due: its next slot on the clock, or an interval on, varied. */
  const dueAfter = (ended: number) => {
    const ms = interval();
    const p = phase(ms);
    return p === null ? ended + ms * jitter : nextOnClock(ended + ms / 2, ms, p);
  };
  /** Waits `ms` from `now`: the same now the wait was worked out from, so a slot on the clock is due on it, not a moment past. */
  const waitFor = (ms: number, now = Date.now()) => {
    dueAt = now + ms;
    timer = setTimeout(tick, ms);
  };
  const wait = () => {
    jitter = 0.9 + Math.random() * 0.2;
    const now = Date.now();
    waitFor(Math.max(0, dueAfter(now) - now), now);
  };

  const tick = async (asked = false) => {
    clearTimeout(timer);
    if (running) return;
    // Off duty, only the rounds asked for run.
    if (!asked && !duty().onDuty) {
      if (!stopped) wait();
      return;
    }
    // A demo (demo.ts) shows made-up work: no round ever runs, so nothing of the PC taking its picture is read.
    if (isDemo()) {
      if (!stopped) wait();
      return;
    }
    // The trial has ended (license-check.ts), or its required settings (required.ts) aren't filled in yet: none run,
    // asked for or not, since it can't work. Said in round.json, never silent, and never a failure.
    const held = trialEnded() ?? needsSettings()?.text ?? null;
    waiting = held;
    if (held) {
      if (stopped) return;
      wait();
      recordHeld(opts.name ?? 'round', held, interval());
      return;
    }
    running = true;
    let started = Date.now();
    let error: string | null = null;
    let offline = false;
    let timedOut = false;
    /** It waited its turn in a line (pace.ts: the first-round line, the work line) until its next round was due, and what for: no failure. */
    let waitedTurn: string | null = null;
    const controller = new AbortController();
    const limit = typeof opts.timeoutMs === 'function' ? opts.timeoutMs() : opts.timeoutMs ?? roundTimeLimit(interval());
    let limitTimer: NodeJS.Timeout | undefined;
    // The manor's pace (pace.ts), the owner's setting: a round, asked for or not, at it (kit 2.73.0); a scheduled
    // agent's first in its turn.
    const p = pace();
    void paceProcess(p);
    const name = opts.name ?? 'round';
    // The heavy first round, asked for or not; only a scheduled one waits its turn.
    const isFirst = !firstRoundDone(name);
    // Which line it waits in (null once it runs), and what the round used: its processor time and its most memory.
    const queuedAt = started;
    let inLine: 'first' | 'work' | null = 'first';
    let used: { cpu: NodeJS.CpuUsage; memory: number; sampler?: NodeJS.Timeout } | null = null;
    // The round as a task in the agent's work status (work-tasks.ts): in a line while it waits, the work it tracks its part.
    const task = startWork({ kind: 'round', what: asked ? `${name}, asked for` : name });
    // The PC held awake for the round's work (awake.ts): every hold it took let go when it ends, at the latest.
    const holds: (() => void)[] = [];
    const awake = (what: string) => {
      const letGo = stayAwake(`${name}: ${what}`);
      holds.push(letGo);
      return letGo;
    };
    try {
      const run = async () => {
        inLine = null;
        task.running();
        if (waiting === WORK_WAITING) waiting = null;
        started = Date.now();
        startedAt = started;
        firstNow = isFirst ? 'running' : null;
        const u = { cpu: process.cpuUsage(), memory: process.memoryUsage.rss(), sampler: undefined as NodeJS.Timeout | undefined };
        u.sampler = setInterval(() => (u.memory = Math.max(u.memory, process.memoryUsage.rss())), 5_000).unref();
        used = u;
        const work = inWork(task, () => job({ signal: controller.signal, awake }));
        const late = new Promise<never>((_, reject) => {
          limitTimer = setTimeout(() => reject(new RoundTimeout(limit)), limit);
        });
        try {
          await Promise.race([work, late]);
        } catch (e) {
          if (!(e instanceof RoundTimeout)) throw e;
          timedOut = true;
          controller.abort(e);
          // The job let go may still end: said in the log, and nothing else changes.
          const ended = () => console.log(`${new Date().toISOString()} a round that was let go at its time limit has ended, after ${span(Date.now() - started)}`);
          work.then(ended, ended);
          throw e;
        }
      };
      // A scheduled round takes its turn in the work line (pace.ts, kit 2.56.0), after its first-round turn if it
      // needs one; a round someone asked for never waits.
      const inTurn = () => {
        if (asked || (typeof opts.light === 'function' ? opts.light() : opts.light)) return run();
        inLine = 'work';
        task.waitIn('work');
        // Said while it waits, so a reader of its state (the Surveyor) never takes it for a schedule with nothing coming.
        waiting = WORK_WAITING;
        return inWorkTurn(p, run, { who: APP.id, doing: name, limitMs: limit, waitMs: Math.max(interval(), 60_000) });
      };
      await inFirstRoundTurn(p, !asked && isFirst, inTurn, {
        who: APP.id,
        limitMs: limit,
        onWait: (inLine) => {
          waiting = inLine ? FIRST_ROUND_WAITING : null;
          if (inLine) {
            firstNow = 'waiting';
            task.waitIn('first-round');
          }
        },
      });
      lastError = null;
      lastOk = true;
    } catch (e) {
      if (e instanceof LockTimeout || e instanceof QueueFull) {
        // Its turn didn't come before its next round was due: it joins the line again then.
        // Set by run() and inTurn() above, which TypeScript can't follow.
        const line = inLine as 'first' | 'work' | null;
        waitedTurn = line === 'work' ? WORK_WAITING : FIRST_ROUND_WAITING;
        lastOk = null;
        console.log(
          `${new Date().toISOString()} ${line === 'work' ? 'its round waited its turn behind the other agents at work' : "its first round waited its turn behind the other agents' first rounds"}; it waits again at its next round`,
        );
      } else {
        lastError = (e as Error).message;
        error = roundError(e);
        offline = await offlineFailure(e).catch(() => false);
        lastOk = offline ? null : false;
        if (offline) console.log(`${new Date().toISOString()} this PC is offline, so the round waits for the network: ${error}`);
        else console.error(`${new Date().toISOString()} run failed: ${(e as Error).stack ?? e}`);
      }
    } finally {
      task.done();
      for (const letGo of holds) letGo();
      firstNow = null;
      if (waiting === WORK_WAITING) waiting = null;
      clearTimeout(limitTimer);
      const u = used as { cpu: NodeJS.CpuUsage; memory: number; sampler?: NodeJS.Timeout } | null;
      if (u) clearInterval(u.sampler);
      const spent = u ? process.cpuUsage(u.cpu) : null;
      const measured = u && spent ? { cpuMs: Math.round((spent.user + spent.system) / 1000), memoryMb: Math.round(Math.max(u.memory, process.memoryUsage.rss()) / 1_048_576) } : {};
      const waitedMs = u ? started - queuedAt : 0;
      lastOffline = offline;
      running = false;
      startedAt = null;
      const ended = Date.now();
      lastEnded = ended;
      // A round still running when stop() was called must not set up the next one.
      if (!stopped) wait();
      recordRound(name, {
        started: new Date(started).toISOString(),
        finished: new Date(ended).toISOString(),
        ok: offline || waitedTurn ? null : error === null,
        ...(offline ? { offline: true } : {}),
        ...(waitedTurn ? { waiting: waitedTurn, turn: waitedTurn === WORK_WAITING ? ('work' as const) : ('first' as const) } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        error,
        everyMs: interval(),
        ...(phase() !== null ? { phaseMs: phase()! } : {}),
        next: state().nextRunAt,
        ...(waitedMs >= 1000 ? { waitedMs } : {}),
        ...measured,
      });
    }
  };
  const startPace = pace();
  void paceProcess(startPace);
  waitFor(opts.firstDelayMs ?? (startPace === 'gentle' ? 120_000 + Math.random() * 780_000 : 30_000 + Math.random() * 150_000));

  const state = (): RoundState => ({
    name: opts.name ?? 'round',
    lastRunAt: iso(lastEnded),
    lastRunOk: lastOk,
    lastRunOffline: lastOffline,
    lastError,
    // A wait is kept off duty too, but no round comes of it until the agent is back on duty.
    nextRunAt: stopped || running || !duty().onDuty || trialEnded() || needsSettings() ? null : iso(dueAt),
    runningSince: iso(startedAt),
    waiting,
    firstRound: firstNow,
  });
  schedules.add(state);

  const handle = {
    /** Starts a run now; false when one is already under way, the trial has ended (license-check.ts), or its required settings are still to be filled in (required.ts). */
    runNow(): boolean {
      if (running || trialEnded() || needsSettings()) return false;
      void tick(true);
      return true;
    },
    /** Starts a scheduled round now, at the pace (the agent's own reason, not the person's); false as runNow() and off duty. */
    runSoon(): boolean {
      if (running || stopped || trialEnded() || needsSettings() || !duty().onDuty) return false;
      void tick(false);
      return true;
    },
    /**
     * The interval changed: the wait under way is set again, counted from when the last run ended.
     * Before the first run, and during a run, there's nothing to do: the next wait reads the interval.
     */
    reschedule(): void {
      if (stopped || running || lastEnded === null) return;
      clearTimeout(timer);
      const now = Date.now();
      waitFor(Math.max(0, dueAfter(lastEnded) - now), now);
    },
    get running() {
      return running;
    },
    get lastError() {
      return lastError;
    },
    /** This schedule's rounds, as /api/ping gives them. */
    get state() {
      return state();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      schedules.delete(state);
      soon.delete(state);
    },
  };
  soon.set(state, () => handle.runSoon());
  return handle;
}
