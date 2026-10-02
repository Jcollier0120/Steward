import { duty } from './duty.ts';

/**
 * Runs `job` soon after start and then every `everyMs` after the last run ended, never two at once.
 * The agent works only while it is employed (running): there's no Task Scheduler entry to leave behind.
 *
 * Staggered: Manor may start every agent at once, so the first round comes 30 s to 3 min after start
 * (random), and each later wait varies by ±10%, so the staff don't all reach for the NPU together.
 *
 * Off duty (src/duty.ts), scheduled rounds are skipped; runNow() still runs one.
 *
 * `everyMs` may be a function, read each time a wait is set: then an interval changed on the Settings
 * panel takes effect at once, with reschedule() setting the wait under way to the new interval.
 * `lastEndedAt` is when the last run ended before this process started (from the agent's report), so
 * that reschedule() counts from it until a run has ended here.
 */
export function every(everyMs: number | (() => number), job: () => Promise<void>, opts: { firstDelayMs?: number; lastEndedAt?: number } = {}) {
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let lastError: string | null = null;
  let stopped = false;
  /** When the last run ended (null before the first, unless the agent said), and the current wait's jitter. */
  let lastEnded: number | null = opts.lastEndedAt ?? null;
  let jitter = 1;
  const interval = () => (typeof everyMs === 'function' ? everyMs() : everyMs);
  const wait = () => {
    jitter = 0.9 + Math.random() * 0.2;
    timer = setTimeout(tick, interval() * jitter);
  };

  const tick = async (asked = false) => {
    clearTimeout(timer);
    if (running) return;
    if (!asked && !duty().onDuty) {
      if (!stopped) wait();
      return;
    }
    running = true;
    try {
      await job();
      lastError = null;
    } catch (e) {
      lastError = (e as Error).message;
      console.error(`${new Date().toISOString()} run failed: ${(e as Error).stack ?? e}`);
    } finally {
      running = false;
      lastEnded = Date.now();
      // A round still running when stop() was called must not set up the next one.
      if (!stopped) wait();
    }
  };
  timer = setTimeout(tick, opts.firstDelayMs ?? 30_000 + Math.random() * 150_000);

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
      timer = setTimeout(tick, Math.max(0, lastEnded + interval() * jitter - Date.now()));
    },
    get running() {
      return running;
    },
    get lastError() {
      return lastError;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
