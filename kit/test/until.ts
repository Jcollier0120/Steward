/**
 * Waiting in tests. Never `await sleep(n)` and then assert: n is long enough on a quiet PC and too short on one that
 * runs every test file at once beside the manor's own work, so the test fails now and then with nothing wrong. Wait for
 * the thing itself with `until`, or drive timers with node:test's `mock.timers`.
 */

/** Waits until `check` holds, looking every 10 ms, for at most `ms` (10 s); throws saying what it waited for. */
export async function until(check: () => unknown, ms = 10_000, what = 'the test condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A short pause only to show that something has *not* happened, and only after a positive `until` for what should
 * have: a busy PC can make it pass when it shouldn't, never fail when it shouldn't.
 */
export const stillFor = (ms = 200) => new Promise((r) => setTimeout(r, ms));
