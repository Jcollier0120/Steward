import { roundSig, type Glance } from '../glance.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Held } from '../alarms.ts';
import type { Employee, Settings } from '../settings.ts';
import type { EmployeeResult } from './common.ts';

/**
 * Which employees a round looks at. Each round asks GitHub once (glance.ts); an employee whose repository and Settings
 * are as they were at the end of the last round that went well for it has nothing new to merge, catch up, look at or
 * release, so the round doesn't fetch, read its version files or list its releases again. Its PRs that waited still
 * wait, for the same reasons: those are kept here, so the alarms go on counting their hours.
 *
 * Every employee is looked at when the round is asked for (Run now, `steward round`), when GitHub couldn't be asked,
 * after a round that failed, and at least once an hour whatever happened, so nothing waits on a change GitHub doesn't
 * show (a check that failed for a reason that has since gone, say), and no rollout of a new kit waits on a glance
 * that missed it.
 */

export const roundSeenFile = () => dataFile('round-seen.json');

/** A full look at every employee at least this often. */
export const FULL_EVERY_MS = 60 * 60_000;

export interface Seen {
  /** When the last full round ended (every employee looked at), or null. */
  full: string | null;
  /** Whether the last round went through (no error for the whole round). */
  ok: boolean;
  /** Each employee the last rounds looked at and that went well: what its round rested on, and its PRs that waited. */
  repos: Record<string, { sig: string; held: Held[] }>;
}

export const loadSeen = (): Seen => ({ full: null, ok: false, repos: {}, ...readJson<Partial<Seen>>(roundSeenFile(), {}) });

export interface RoundPlan {
  /** Every employee, looked at. */
  full: boolean;
  /** Why it is a full round, in a few words, when it is one. */
  why: string | null;
  look: Employee[];
  /** Nothing new since the last round: not looked at again. */
  quiet: Employee[];
  /** Each employee's signature now (none where GitHub gave no answer). */
  sigs: Record<string, string>;
}

/**
 * Which employees this round looks at (see above). `kit` is the kit a rollout would bring (the newest kit release, and
 * the kit this Steward carries: stages/rollout.ts), so a new one is something new for every employee. Pure.
 */
export function planRound(o: { employees: Employee[]; glance: Glance | null | undefined; seen: Seen; settings: Settings; force?: boolean; now?: Date; kit?: { newest: string | null; own: string | null } | null }): RoundPlan {
  const sigs: Record<string, string> = {};
  for (const e of o.employees) {
    const g = o.glance?.repos[e.id];
    if (g) sigs[e.id] = roundSig(e, g, o.settings, o.kit ?? null);
  }
  const now = (o.now ?? new Date()).getTime();
  const why = o.force ? 'asked for' : !o.glance ? "GitHub couldn't be asked at once" : !o.seen.full && !Object.keys(o.seen.repos).length ? 'no round before' : !o.seen.ok ? 'the last round failed' : !o.seen.full || now - Date.parse(o.seen.full) >= FULL_EVERY_MS ? 'a full look, as each hour' : null;
  if (why) return { full: true, why, look: o.employees, quiet: [], sigs };
  const look = o.employees.filter((e) => !sigs[e.id] || o.seen.repos[e.id]?.sig !== sigs[e.id]);
  return { full: false, why: null, look, quiet: o.employees.filter((e) => !look.includes(e)), sigs };
}

/**
 * What the round leaves for the next one: each employee it looked at that went well (nothing failed for it) is kept
 * with its signature and its PRs that waited; one that failed is dropped, so the next round looks at it again.
 */
export function afterRound(seen: Seen, o: { plan: RoundPlan; results: EmployeeResult[]; held: { employee: Employee; prs: Held[] }[]; error?: string; now?: Date }): Seen {
  const repos = { ...seen.repos };
  for (const e of o.plan.look) {
    const sig = o.plan.sigs[e.id];
    const failed = o.results.some((r) => r.id === e.id && r.outcome === 'failed');
    if (!sig || failed || o.error) delete repos[e.id];
    else repos[e.id] = { sig, held: o.held.find((h) => h.employee.id === e.id)?.prs ?? [] };
  }
  // An employee no longer among them is forgotten.
  for (const id of Object.keys(repos)) if (!o.plan.look.some((e) => e.id === id) && !o.plan.quiet.some((e) => e.id === id)) delete repos[id];
  return { full: o.plan.full && !o.error ? (o.now ?? new Date()).toISOString() : seen.full, ok: !o.error, repos };
}

export const saveSeen = (s: Seen) => writeJson(roundSeenFile(), s);

/** The PRs that waited when an employee was last looked at: for the alarms, while nothing has changed. */
export const heldBefore = (seen: Seen, quiet: Employee[]) => quiet.flatMap((employee) => (seen.repos[employee.id]?.held.length ? [{ employee, prs: seen.repos[employee.id].held }] : []));
