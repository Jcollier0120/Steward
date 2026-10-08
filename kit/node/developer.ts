import { developerOptions, manorHome, type ManorLink } from './manor.ts';
import { dataFile, readJson } from './store.ts';

/**
 * The manor's Developer options switch, for every agent (kit 2.39.0; the rule is spec/DEVELOPER-OPTIONS.md).
 * Castellan is sold to three audiences, general purpose, gamers and developers, and only developers see developer
 * content: repositories, git and GitHub, pull requests, builds, ports, process ids, the model servers' insides, logs,
 * JSON, file paths and commands. With the switch off, none of it is on an agent's page or in what its API answers.
 *
 * One source of truth. With Manor installed and saying (its settings.json's "developerOptions", the switch on Manor's
 * Settings page), Manor's value wins. Otherwise the agent's own: "developerOptions" in its own settings.json, false
 * unless it says true. Both are read afresh on each call (two small files), so flipping the switch in Manor takes
 * effect at the next request, with no agent restarted: call developer() per request, never once at start.
 */
export interface Developer {
  /** Whether developer content may be shown and served. */
  on: boolean;
  /** Manor, when its switch decides; null when the agent's own does (no Manor, or Manor hasn't said). */
  setBy: ManorLink | null;
}

/** The agent's own switch: "developerOptions": true in its settings.json; off when it says anything else, or nothing. */
export function ownDeveloperOptions(file = dataFile('settings.json')): boolean {
  const raw = readJson<unknown>(file, null);
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).developerOptions === true;
}

/** The switch now: Manor's when it says, else the agent's own (`own`, read from its settings.json unless given). */
export function developer(o: { own?: boolean; home?: string; file?: string } = {}): Developer {
  return developerOptions(o.own ?? ownDeveloperOptions(o.file), o.home ?? manorHome());
}

/** Whether developer content may be shown now (developer().on). */
export const isDeveloper = (o: { own?: boolean; home?: string; file?: string } = {}) => developer(o).on;

/**
 * Developer-only data for an API payload: `value` when the switch is on, else `fallback` (undefined unless given). A
 * function is called only when on, so what a non-developer may not see is never even worked out.
 *
 *   json: { rounds, logTail: developerOnly(() => tail(logFile)), checkout: developerOnly(root, null) }
 */
export function developerOnly<T, F = undefined>(value: T | (() => T), fallback?: F, on = isDeveloper()): T | F {
  if (!on) return fallback as F;
  return typeof value === 'function' ? (value as () => T)() : value;
}

/**
 * A payload with its developer-only fields left out when the switch is off (not blanked: gone, so JSON.stringify
 * never sends them), at any depth: in the payload, in its records, in lists of records. A copy of plain data (what
 * JSON would send); the payload itself is left as it was. `withoutDeveloper({ rows }, ['pid', 'port', 'checkout'])`.
 */
export function withoutDeveloper<T>(payload: T, keys: readonly string[], on = isDeveloper()): T {
  if (on || !keys.length) return payload;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object' || v instanceof Date) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!keys.includes(k)) out[k] = strip(x);
    return out;
  };
  return strip(payload) as T;
}

/**
 * A failure in words fit for whoever is looking: the error itself (its message, which may name files, commands and
 * exit codes) for a developer; `plain`, the agent's own plain words for what didn't happen, for everyone else.
 *
 *   json: { ok: false, error: failureFor(e, "The scan didn't finish. It tries again at the next round.") }
 */
export function failureFor(e: unknown, plain: string, on = isDeveloper()): string {
  if (!on) return plain;
  return e instanceof Error ? e.message : String(e);
}
