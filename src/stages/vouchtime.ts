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
 *
 * A run of only the affected tests is kept with how many test files it ran (Steward 0.36.61). One that reaches more files
 * than its kind's usual runs gets that much more time, up to the whole suite's limit. On 2026-10-15 a change reaching
 * 89 of the Steward's 152 test files was stopped twice at 8 minutes: its runs averaged 3 minutes with far fewer files,
 * and it needed 12.
 */

export const KEEP = 10;
export const AT_LEAST = 3;
export const OVER_MS = 5 * 60_000;

/** A run kept: its time in ms, or (Steward 0.36.61) its time and how many test files it ran. */
type Run = number | { ms: number; files: number };
type Times = Record<string, Partial<Record<CheckKind, Run[]>>>;

const msOf = (r: Run) => (typeof r === 'number' ? r : r.ms);
const filesOf = (r: Run) => (typeof r === 'number' ? 0 : r.files);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const isRun = (r: unknown): r is Run => positive(r) || (!!r && typeof r === 'object' && positive((r as { ms?: unknown }).ms) && positive((r as { files?: unknown }).files));

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
      if (Array.isArray(runs)) (out[id] ??= {})[kind] = runs.filter(isRun).slice(-KEEP);
    }
  }
  return out;
}

/**
 * The time limit for a vouch of `id` of this kind: the average of its last runs and `overMs`; null under AT_LEAST runs.
 * `files`: how many test files an affected run takes. More than its usual runs took (AT_LEAST of them kept with theirs),
 * their average time is stretched by as much, though never past the whole suite's limit when there is one.
 */
export function vouchLimit(id: string, kind: CheckKind, o: { overMs?: number; times?: Times; files?: number } = {}): TimeLimit | null {
  const times = o.times ?? vouchTimes();
  const runs = times[id]?.[kind] ?? [];
  if (runs.length < AT_LEAST) return null;
  const average = mean(runs.map(msOf));
  const over = o.overMs ?? OVER_MS;
  const words = `its last ${runs.length} ${kind === 'whole' ? 'whole-suite' : 'affected'} vouches' average of ${duration(average)}`;
  const plain = { ms: Math.round(average + over), why: `${duration(Math.round(average + over))}, ${words} and ${duration(over)} more` };
  const counted = runs.filter((r) => filesOf(r) > 0);
  if (kind !== 'affected' || !o.files || counted.length < AT_LEAST) return plain;
  const usual = mean(counted.map(filesOf));
  if (o.files <= usual) return plain;
  const took = mean(counted.map(msOf));
  const stretched = Math.round((took * o.files) / usual + over);
  const whole = vouchLimit(id, 'whole', { overMs: over, times });
  const ms = Math.max(plain.ms, Math.min(stretched, whole?.ms ?? stretched));
  if (ms === plain.ms) return plain;
  if (ms === whole?.ms) return { ms, why: `${whole.why}, as it runs ${o.files} test files, more than the ${Math.round(usual)} its affected vouches usually run` };
  return { ms, why: `${duration(ms)}: its last ${counted.length} affected vouches took ${duration(took)} on average for ${Math.round(usual)} test files, this one runs ${o.files}, and ${duration(over)} more` };
}

/**
 * A passed vouch's time, kept with the last KEEP of its kind, and with how many test files it ran (`files`) when it ran
 * only the affected ones. Never throws: a time not kept only leaves it out of the average.
 */
export function noteVouchTime(id: string, kind: CheckKind, ms: number, files?: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const times = vouchTimes();
  const run: Run = kind === 'affected' && files && files > 0 ? { ms: Math.round(ms), files } : Math.round(ms);
  (times[id] ??= {})[kind] = [...(times[id][kind] ?? []), run].slice(-KEEP);
  try {
    writeJson(vouchTimesFile(), times);
  } catch {
    // Kept next time.
  }
}
