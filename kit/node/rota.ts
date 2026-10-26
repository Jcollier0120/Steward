import path from 'node:path';
import { readJsonShared } from './file-cache.ts';
import { manorHome } from './manor.ts';

/**
 * Manor's rota (kit 2.138.0): `<Manor's folder>\rota.json`, which Manor (its rota.ts, Manor#415) keeps on each PC from the
 * staff's round.json. With every agent employed at once, the clock's own phases (schedule.ts clockPhase: a hash of the
 * agent's id and the schedule's name, under 30 minutes) put several heavy rounds in the same minutes, on every PC alike.
 * Manor spreads them instead: each schedule's phase anywhere in its interval, placed where the day's load is least, the
 * busiest rounds first, salted by the PC so two PCs differ; and each agent's place in the first-round window after a
 * start, so the staff don't all start together after a sign-in or a wake.
 *
 * ```json
 * { "v": 1, "made": "<ISO>", "agents": { "<id>": { "startAt": 0.42, "phases": { "<schedule>": { "everyMs": 1800000, "phaseMs": 780000, "startAt": 0.5 } } } } }
 * ```
 *
 * A phase counts only for the interval it was placed for: one changed in the agent's Settings keeps the clock's phase
 * until Manor's next round places it again. An agent's own `phaseMs` (every()'s) wins over the rota. Read through the
 * file cache, a stat a read while it's unchanged. No rota (an older Manor, none written yet, one that can't be read)
 * keeps the clock's phases and a random place in the window, as before.
 */

export const ROTA_FILE = 'rota.json';
export const ROTA_V = 1;

/** One schedule's place in the rota: its phase at the interval it was placed for, and its place in the start window (0–1). */
export interface RotaPhase {
  everyMs: number;
  phaseMs: number;
  startAt?: number;
}

/** One agent's places: in the start window, and each schedule's. */
export interface RotaEntry {
  startAt?: number;
  phases: Record<string, RotaPhase>;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const fraction = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 1 ? x : undefined);

/**
 * Where the rota is read from: Manor's folder, or `home` when given. Under node --test, none unless a test gives a home:
 * a test's rounds never take the PC's own rota.
 */
const rotaHome = (home?: string): string | null => home ?? (process.env.NODE_TEST_CONTEXT ? null : manorHome());

/** Agent `who`'s places in the rota, read leniently: anything malformed is left out; null when it has none. */
export function rotaEntry(who: string, home?: string): RotaEntry | null {
  const at = rotaHome(home);
  if (!at) return null;
  const doc = readJsonShared<unknown>(path.join(at, ROTA_FILE), null, null);
  if (!isObject(doc) || doc.v !== ROTA_V || !isObject(doc.agents)) return null;
  const a = doc.agents[who];
  if (!isObject(a)) return null;
  const phases: Record<string, RotaPhase> = {};
  for (const [name, p] of Object.entries(isObject(a.phases) ? a.phases : {})) {
    if (!isObject(p)) continue;
    const { everyMs, phaseMs } = p;
    if (typeof everyMs !== 'number' || !Number.isInteger(everyMs) || everyMs < 60_000) continue;
    if (typeof phaseMs !== 'number' || !Number.isInteger(phaseMs) || phaseMs < 0 || phaseMs >= everyMs) continue;
    const startAt = fraction(p.startAt);
    phases[name] = { everyMs, phaseMs, ...(startAt !== undefined ? { startAt } : {}) };
  }
  const startAt = fraction(a.startAt);
  return { ...(startAt !== undefined ? { startAt } : {}), phases };
}

/** Schedule `name`'s phase in the rota at interval `everyMs` (whole, as the scheduler keeps it), or null: none, or placed for another interval. */
export function rotaPhase(who: string, name: string, everyMs: number, home?: string): number | null {
  const p = rotaEntry(who, home)?.phases[name];
  return p && p.everyMs === everyMs ? p.phaseMs : null;
}

/** Where schedule `name` starts in the first-round window (0–1): its own place, else its agent's; null without one. */
export function rotaStartAt(who: string, name: string, home?: string): number | null {
  const e = rotaEntry(who, home);
  return e?.phases[name]?.startAt ?? e?.startAt ?? null;
}
