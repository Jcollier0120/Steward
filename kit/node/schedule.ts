import { duty } from './duty.ts';

/** One schedule's rounds, as /api/ping and the page's status pill give them (ISO times). */
export interface RoundState {
  name: string;
  /** When the last round ended, and whether it went through (null before the first, or unknown). */
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastError: string | null;
  /** When the next scheduled round is due; null off duty, or once stopped. */
  nextRunAt: string | null;
  /** When the round under way began; null when none is. */
  runningSince: string | null;
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
export function roundTimes(): Pick<RoundState, 'lastRunAt' | 'lastRunOk' | 'nextRunAt' | 'runningSince'> {
  const all = rounds();
  const lastRunAt = latest(all.map((r) => r.lastRunAt));
  return {
    lastRunAt,
    lastRunOk: all.find((r) => r.lastRunAt === lastRunAt)?.lastRunOk ?? null,
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
 * Off duty (duty.ts), scheduled rounds are skipped; runNow() still runs one.
 *
 * `everyMs` may be a function, read each time a wait is set: then an interval changed on the Settings
 * panel takes effect at once, with reschedule() setting the wait under way to the new interval.
 * `lastEndedAt` is when the last run ended before this process started (from the agent's report), so
 * that reschedule() counts from it until a run has ended here. `name` tells an agent's schedules apart
 * in /api/ping's `rounds` ("round" unless said).
 *
 * Each schedule records its rounds (rounds(), roundTimes()): when the last ended and whether it went
 * through, when the next is due, and since when one has been running.
 */
export function every(everyMs: number | (() => number), job: () => Promise<void>, opts: { firstDelayMs?: number; lastEndedAt?: number; name?: string } = {}) {
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let lastError: string | null = null;
  let stopped = false;
  /** When the last run ended (null before the first, unless the agent said), and the current wait's jitter. */
  let lastEnded: number | null = opts.lastEndedAt ?? null;
  let lastOk: boolean | null = null;
  let startedAt: number | null = null;
  /** When the wait under way ends. */
  let dueAt: number | null = null;
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
    if (!asked && !duty().onDuty) {
      if (!stopped) wait();
      return;
    }
    running = true;
    startedAt = Date.now();
    try {
      await job();
      lastError = null;
      lastOk = true;
    } catch (e) {
      lastError = (e as Error).message;
      lastOk = false;
      console.error(`${new Date().toISOString()} run failed: ${(e as Error).stack ?? e}`);
    } finally {
      running = false;
      startedAt = null;
      lastEnded = Date.now();
      // A round still running when stop() was called must not set up the next one.
      if (!stopped) wait();
    }
  };
  waitFor(opts.firstDelayMs ?? 30_000 + Math.random() * 150_000);

  const state = (): RoundState => ({
    name: opts.name ?? 'round',
    lastRunAt: iso(lastEnded),
    lastRunOk: lastOk,
    lastError,
    // A wait is kept off duty too, but no round comes of it until the agent is back on duty.
    nextRunAt: stopped || running || !duty().onDuty ? null : iso(dueAt),
    runningSince: iso(startedAt),
  });
  schedules.add(state);

  return {
    /** Starts a run now; false when one is already under way. */
    runNow(): boolean {
      if (running) return false;
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
