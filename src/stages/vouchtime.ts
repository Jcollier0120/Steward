import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { duration, type CheckKind, type TimeLimit } from './bump.ts';

/**
 * A vouch's time limit (Steward 0.36.28): its checks are stopped once they have taken five minutes more than its runs
 * took on average, so a stuck run (a test waiting forever, a run held to the checks pace behind others) ends minutes
 * past its usual time, not at the 80 minutes a paced step may otherwise take. Stopped, the vouch sets nothing, and the
 * Steward tests the PR itself before it merges, as for any PR not vouched for.
 *
 * Kept in vouch-times.json, per employee: the time each of its last KEEP vouches took to pass its checks, on the clock
 * (at the checks pace, as they run), whole-suite runs apart from runs of only the tests a change reaches, which take a
 * fraction of the time. No limit until AT_LEAST runs of the kind have passed. A run that failed or was stopped isn't
 * counted: the average is only ever of runs that finished.
 */

export const KEEP = 10;
export const AT_LEAST = 3;
export const OVER_MS = 5 * 60_000;

type Times = Record<string, Partial<Record<CheckKind, number[]>>>;

export const vouchTimesFile = () => dataFile('vouch-times.json');

/** vouch-times.json as it is, anything unreadable in it left out. */
export function vouchTimes(): Times {
  const raw = readJson<unknown>(vouchTimesFile(), {});
  const out: Times = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, kinds] of Object.entries(raw as Record<string, unknown>)) {
    if (!kinds || typeof kinds !== 'object') continue;
    for (const kind of ['whole', 'affected'] as const) {
      const runs = (kinds as Record<string, unknown>)[kind];
      if (Array.isArray(runs)) (out[id] ??= {})[kind] = runs.filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0).slice(-KEEP);
    }
  }
  return out;
}

/** The time limit for a vouch of `id` of this kind: the average of its last runs and `overMs`; null under AT_LEAST runs. */
export function vouchLimit(id: string, kind: CheckKind, o: { overMs?: number; times?: Times } = {}): TimeLimit | null {
  const runs = (o.times ?? vouchTimes())[id]?.[kind] ?? [];
  if (runs.length < AT_LEAST) return null;
  const average = runs.reduce((a, b) => a + b, 0) / runs.length;
  const over = o.overMs ?? OVER_MS;
  const ms = Math.round(average + over);
  return { ms, why: `${duration(ms)}, its last ${runs.length} ${kind === 'whole' ? 'whole-suite' : 'affected'} vouches' average of ${duration(average)} and ${duration(over)} more` };
}

/** A passed vouch's time, kept with the last KEEP of its kind. Never throws: a time not kept only leaves it out of the average. */
export function noteVouchTime(id: string, kind: CheckKind, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const times = vouchTimes();
  (times[id] ??= {})[kind] = [...(times[id][kind] ?? []), Math.round(ms)].slice(-KEEP);
  try {
    writeJson(vouchTimesFile(), times);
  } catch {
    // Kept next time.
  }
}
