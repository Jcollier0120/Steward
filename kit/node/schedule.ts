import { APP } from '../app.ts';
import { duty } from './duty.ts';
import { needsSettings } from './required.ts';
import { offlineFailure } from './net.ts';
import { LockTimeout, QueueFull } from './npu-queue.ts';
import { FIRST_ROUND_WAITING, inFirstRoundTurn, pace, setPriorityFor } from './pace.ts';
import { dataFile, readJson, writeJson } from './store.ts';

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
  /** What its rounds wait for from the person (required.ts's needsSettings, in words); null when they wait for nothing. */
  waiting: string | null;
  /**
   * Its first round (kit 2.43.0): `waiting` in the first-round line (pace.ts), `running` while it runs, null once a
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
  /** The interval between rounds when the round ended (each wait varies by ±10% about it). */
  everyMs: number;
  /** When the next scheduled round is due; null off duty, or once stopped (as /api/ping's nextRunAt). */
  next: string | null;
  /** A round held for the agent's required settings (required.ts): what it waits for, in words. `ok` is null then. */
  waiting?: string;
  /** true when the round ran past its time limit and was let go (every()'s timeoutMs): `ok` is false then. */
  timedOut?: boolean;
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
 * round.json's `wentThrough`: each schedule's first round that went through, when (kit 2.43.0). A round.json from before
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
 * Staggered: Manor may start every agent at once, so the first round comes 30 s to 3 min after start
 * (random), and each later wait varies by ±10%, so the staff don't all reach for the NPU together.
 *
 * At the manor's pace (pace.ts, kit 2.43.0; gentle unless Manor's Settings say full), a scheduled round runs at
 * below-normal priority, and a schedule's first round (none has gone through: round.json's wentThrough) waits its
 * turn in one line with the other agents' first rounds, one at a time. While it waits, its state says so (waiting,
 * firstRound), and the page shows the agent settling into the manor. A round the person asks for never waits.
 *
 * Off duty (duty.ts), scheduled rounds are skipped; runNow() still runs one.
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
 *   says `"ok": null, "waiting": "<what>"` at each interval, and its state says `waiting`, so a reader sees a reason
 *   and a schedule still going, never silence.
 * - A round that runs past its time limit (`timeoutMs`, a number or a function read at each round; else
 *   roundTimeLimit(), three intervals and at least two hours) is let go: its job's signal is aborted, it is recorded
 *   as failed with `"timedOut": true`, and the next round is scheduled, which tries again. A hung await (a request
 *   that never answers, a child process that never ends) can't stop the rounds after it. The job that was let go
 *   may still finish later: then the log says so, and nothing else changes. A job that can stop when asked takes
 *   the signal (`job({ signal })`); one that can't is simply no longer waited for.
 */
export function every(
  everyMs: number | (() => number),
  job: (round: { signal: AbortSignal }) => Promise<void>,
  opts: { firstDelayMs?: number; lastEndedAt?: number; name?: string; timeoutMs?: number | (() => number) } = {},
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
  const interval = () => (typeof everyMs === 'function' ? everyMs() : everyMs);
  const waitFor = (ms: number) => {
    dueAt = Date.now() + ms;
    timer = setTimeout(tick, ms);
  };
  const wait = () => {
    jitter = 0.9 + Math.random() * 0.2;
    waitFor(interval() * jitter);
  };

  const tick = async (asked = false) => {
    clearTimeout(timer);
    if (running) return;
    // Off duty, only the rounds asked for run.
    if (!asked && !duty().onDuty) {
      if (!stopped) wait();
      return;
    }
    // Waiting for its required settings (required.ts), none do: it can't work yet. Said in round.json, never silent.
    const needs = needsSettings();
    waiting = needs?.text ?? null;
    if (needs) {
      if (stopped) return;
      wait();
      const now = new Date().toISOString();
      recordRound(opts.name ?? 'round', { started: now, finished: now, ok: null, waiting: needs.text, error: null, everyMs: interval(), next: null });
      return;
    }
    running = true;
    let started = Date.now();
    let error: string | null = null;
    let offline = false;
    let timedOut = false;
    /** It waited its turn in the first-round line until its next round was due (pace.ts): no failure. */
    let waitedTurn = false;
    const controller = new AbortController();
    const limit = typeof opts.timeoutMs === 'function' ? opts.timeoutMs() : opts.timeoutMs ?? roundTimeLimit(interval());
    let limitTimer: NodeJS.Timeout | undefined;
    // The manor's pace (pace.ts): a scheduled round at below-normal priority, and an agent's first in its turn.
    const p = pace();
    setPriorityFor(p, asked);
    const name = opts.name ?? 'round';
    // The heavy first round, asked for or not; only a scheduled one waits its turn.
    const isFirst = !firstRoundDone(name);
    try {
      const run = async () => {
        started = Date.now();
        startedAt = started;
        firstNow = isFirst ? 'running' : null;
        const work = job({ signal: controller.signal });
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
      await inFirstRoundTurn(p, !asked && isFirst, run, {
        who: APP.id,
        limitMs: limit,
        onWait: (inLine) => {
          waiting = inLine ? FIRST_ROUND_WAITING : null;
          if (inLine) firstNow = 'waiting';
        },
      });
      lastError = null;
      lastOk = true;
    } catch (e) {
      if (e instanceof LockTimeout || e instanceof QueueFull) {
        // Its turn didn't come before its next round was due: it joins the line again then.
        waitedTurn = true;
        lastOk = null;
        console.log(`${new Date().toISOString()} its first round waited its turn behind the other agents' first rounds; it waits again at its next round`);
      } else {
        lastError = (e as Error).message;
        error = roundError(e);
        offline = await offlineFailure(e).catch(() => false);
        lastOk = offline ? null : false;
        if (offline) console.log(`${new Date().toISOString()} this PC is offline, so the round waits for the network: ${error}`);
        else console.error(`${new Date().toISOString()} run failed: ${(e as Error).stack ?? e}`);
      }
    } finally {
      firstNow = null;
      clearTimeout(limitTimer);
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
        ...(waitedTurn ? { waiting: FIRST_ROUND_WAITING } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        error,
        everyMs: interval(),
        next: state().nextRunAt,
      });
    }
  };
  waitFor(opts.firstDelayMs ?? 30_000 + Math.random() * 150_000);

  const state = (): RoundState => ({
    name: opts.name ?? 'round',
    lastRunAt: iso(lastEnded),
    lastRunOk: lastOk,
    lastRunOffline: lastOffline,
    lastError,
    // A wait is kept off duty too, but no round comes of it until the agent is back on duty.
    nextRunAt: stopped || running || !duty().onDuty || needsSettings() ? null : iso(dueAt),
    runningSince: iso(startedAt),
    waiting,
    firstRound: firstNow,
  });
  schedules.add(state);

  return {
    /** Starts a run now; false when one is already under way, or its required settings are still to be filled in (required.ts). */
    runNow(): boolean {
      if (running || needsSettings()) return false;
      void tick(true);
      return true;
    },
    /**
     * The interval changed: the wait under way is set again, counted from when the last run ended.
     * Before the first run, and during a run, there's nothing to do: the next wait reads the interval.
     */
    reschedule(): void {
      if (stopped || running || lastEnded === null) return;
      clearTimeout(timer);
      waitFor(Math.max(0, lastEnded + interval() * jitter - Date.now()));
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
    },
  };
}
