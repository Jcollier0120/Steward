/**
 * A fresh start: the Steward's page has just started, or the PC has just woken from sleep. What failed before may have
 * failed only because the PC was going down, asleep or offline, so each part that holds a failure until a person acts
 * gives it one more try at the next round: a release that failed (stages/round.ts), an agent down whose tries were
 * spent (tend.ts). If it fails again, it stands as before, alarm and all; if it goes through, its alarm clears at that
 * round, rather than waiting for a person or the hourly try.
 */

/** The parts that retry after a fresh start, each taking its turn once. */
export type FreshPart = 'releases' | 'tend';

/** Empty until the page notes its start (agent.ts): a stage run from a terminal, or a test, is no fresh start. */
const pending = new Set<FreshPart>();

/** A fresh start: every part retries once, at its next turn. */
export function noteFreshStart(): void {
  pending.add('releases');
  pending.add('tend');
}

/** Whether this part retries this time: true once after each fresh start. */
export function takeFreshStart(part: FreshPart): boolean {
  return pending.delete(part);
}

/** The ticks of a wake watch further apart than this: the PC slept between them (timers don't run while it sleeps). */
export const WOKE_AFTER_MS = 3 * 60_000;

/**
 * Watches for the PC waking from sleep: a tick every `everyMs`, and one that comes over WOKE_AFTER_MS after the last
 * means the PC slept between. Then a fresh start, and `onWake` (a round now). Returns the function that stops it.
 */
export function watchWake(onWake: () => void, everyMs = 30_000, now: () => number = Date.now): () => void {
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const gap = t - last;
    last = t;
    if (gap > WOKE_AFTER_MS) {
      console.log(`${new Date(t).toISOString()} the PC woke after ${Math.round(gap / 60_000)} min: what failed before is tried again`);
      noteFreshStart();
      onWake();
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
