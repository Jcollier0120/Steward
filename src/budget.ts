import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Runner } from './run.ts';

/**
 * GitHub's API budget: the Steward keeps at least a tenth of GitHub's rate limit spare, and spreads what it spends over
 * the hour, so its rounds never meet "API rate limit already exceeded" and the person's own gh, their sessions and the
 * other agents on the same account always have room.
 *
 * GitHub gives a user's token 5,000 GraphQL points an hour (a query costs by how many nodes it may return; `gh pr list`
 * and `gh release list` are GraphQL too), and 5,000 REST requests. The limit and what is left are never assumed: each
 * glance asks for GraphQL's own `rateLimit` (glance.ts), and what it says is kept here, in github-budget.json.
 *
 * GitHub's REST `rate_limit` and GraphQL's `rateLimit` have been seen to disagree (two counts, one window apart), so the
 * readings of every window not yet over are kept and the one with the least left is believed.
 */

/** The share of GitHub's limit the Steward lets the account reach: the rest stays spare. */
export const SHARE = 0.9;
/** Of that, the share it may spend at any time in the hour; beyond it, only as the hour goes by (pacing). */
export const OPEN_SHARE = 0.25;
/** GitHub's window: an hour from the first request after the last reset. */
export const WINDOW_MS = 60 * 60_000;
/** The wait after GitHub's secondary limits (too many at once), when GitHub gives no time. */
export const SECONDARY_WAIT_MS = 5 * 60_000;
/** The wait after a limit when nothing says when it resets. */
export const UNKNOWN_WAIT_MS = 15 * 60_000;

/** What GitHub said of the account's GraphQL points: its `rateLimit`. */
export interface RateReading {
  limit: number;
  remaining: number;
  used: number;
  /** When the window resets (ISO). */
  resetAt: string;
  /** When it was read (ISO). */
  at: string;
}

export interface BudgetState {
  /** The latest reading of each window not yet over. */
  graphql: RateReading[];
  /** What the last glance cost, in points: what the next round's will. Null before the first. */
  glanceCost: number | null;
  /** GitHub refused the account: nothing is asked of it until then (ISO). */
  limitedUntil: string | null;
  limitedWhy?: string | null;
}

export const emptyBudget = (): BudgetState => ({ graphql: [], glanceCost: null, limitedUntil: null, limitedWhy: null });

export const budgetFile = () => dataFile('github-budget.json');
export const loadBudget = (): BudgetState => ({ ...emptyBudget(), ...readJson<Partial<BudgetState>>(budgetFile(), {}) });
export const saveBudget = (s: BudgetState) => writeJson(budgetFile(), s);

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);

/** A `rateLimit { limit remaining used resetAt }` as GraphQL gives it, read; null when it isn't one. */
export function readingFrom(raw: any, now: Date): RateReading | null {
  const limit = num(raw?.limit);
  const remaining = num(raw?.remaining);
  const reset = typeof raw?.resetAt === 'string' ? Date.parse(raw.resetAt) : NaN;
  if (!limit || remaining === null || !Number.isFinite(reset)) return null;
  const used = num(raw?.used) ?? Math.max(0, limit - remaining);
  return { limit, remaining, used, resetAt: new Date(reset).toISOString(), at: now.toISOString() };
}

/** The state with this reading kept: the newer of each window's, and no window that is over. */
export function noteReading(s: BudgetState, r: RateReading, now: Date): BudgetState {
  const live = s.graphql.filter((x) => Date.parse(x.resetAt) > now.getTime() && x.resetAt !== r.resetAt);
  const kept = Date.parse(r.resetAt) > now.getTime() ? [...live, r] : live;
  return { ...s, graphql: kept.sort((a, b) => a.resetAt.localeCompare(b.resetAt)).slice(-4) };
}

/** The reading believed now: the one with the least left of the windows not yet over; null when there is none. */
export function believed(s: BudgetState, now: Date): RateReading | null {
  const live = s.graphql.filter((x) => Date.parse(x.resetAt) > now.getTime());
  return live.length ? live.reduce((a, b) => (b.remaining < a.remaining ? b : a)) : null;
}

/**
 * The state after a glance GitHub answered: what each of its queries said is left, and what it cost (the next round's
 * glance will cost about the same). An answer means the account isn't refused, whatever was thought.
 */
export function noteGlance(s: BudgetState, g: { cost?: number; rates?: RateReading[] }, now: Date): BudgetState {
  let out: BudgetState = g.rates?.length ? { ...s, limitedUntil: null, limitedWhy: null } : s;
  for (const r of g.rates ?? []) out = noteReading(out, r, now);
  return typeof g.cost === 'number' ? { ...out, glanceCost: g.cost } : out;
}

/**
 * What a round may cost, in points: its glance, and as much again for the glance after a round that changed something
 * and the odd PR or release asked of on its own. Before any glance, a guess from how many repositories it asks about
 * (a point each, with the Steward's own).
 */
export const roundCost = (s: BudgetState, repos: number) => 2 * (s.glanceCost ?? repos + 1);

/** The points never spent: a tenth of GitHub's limit. */
export const spare = (limit: number) => Math.ceil(limit * (1 - SHARE));

export type Gate = { go: true } | { go: false; until: string; why: string };

/**
 * Whether work costing `cost` points may ask GitHub now. Never below the spare tenth; and when `paced`, no more of the
 * hour's 90% than the hour so far allows (a quarter of it at any time), so a run of rounds can't spend it in a burst.
 * When not, until when it waits: the moment the pace allows it, or the window's reset. Pure.
 */
export function gate(s: BudgetState, cost: number, now: Date, o: { paced?: boolean } = {}): Gate {
  const t = now.getTime();
  if (s.limitedUntil && Date.parse(s.limitedUntil) > t) return { go: false, until: s.limitedUntil, why: s.limitedWhy || "GitHub said the account's API limit was reached" };
  const r = believed(s, now);
  if (!r) return { go: true };
  const reset = Date.parse(r.resetAt);
  if (r.remaining - cost < spare(r.limit)) return { go: false, until: r.resetAt, why: `${r.remaining} of GitHub's ${r.limit} points left this hour, and it keeps ${spare(r.limit)} spare` };
  if (o.paced) {
    const usable = SHARE * r.limit;
    const start = reset - WINDOW_MS;
    const sofar = Math.min(1, Math.max(0, (t - start) / WINDOW_MS));
    const want = r.used + cost;
    if (want > usable * Math.max(sofar, OPEN_SHARE)) {
      const at = Math.min(reset, Math.max(t, start + (want / usable) * WINDOW_MS));
      return { go: false, until: new Date(at).toISOString(), why: `${r.used} of GitHub's ${r.limit} points used ${Math.round((sofar * WINDOW_MS) / 60_000)} minutes into the hour: spread over the hour, it has spent its share for now` };
    }
  }
  return { go: true };
}

/** What GitHub says when it refuses the account (its primary limit, or its secondary limits on bursts). */
export const LIMITED = /rate limit (already )?exceeded|secondary rate limit|RATE_LIMITED|abuse detection/i;

/** GitHub refused the account: its limit is reached. */
export class GithubLimited extends Error {
  readonly secondary: boolean;
  constructor(message: string) {
    super(message);
    this.name = 'GithubLimited';
    this.secondary = /secondary|abuse/i.test(message);
  }
}

/**
 * The state once GitHub refused the account: nothing asked of it until the window resets (the latest reset known, from
 * the readings or `restReset`, REST's word), or for a few minutes after a secondary limit; a quarter of an hour when
 * nothing says. Never more than a little over an hour.
 */
export function noteLimited(s: BudgetState, o: { now: Date; secondary: boolean; restReset?: string | null; why: string }): BudgetState {
  const t = o.now.getTime();
  const known = [...s.graphql.map((x) => x.resetAt), o.restReset ?? '']
    .map((x) => Date.parse(x))
    .filter((x) => Number.isFinite(x) && x > t);
  const until = o.secondary ? t + SECONDARY_WAIT_MS : known.length ? Math.max(...known) : t + UNKNOWN_WAIT_MS;
  return { ...s, limitedUntil: new Date(Math.min(until, t + WINDOW_MS + 5 * 60_000)).toISOString(), limitedWhy: o.why };
}

/** When GraphQL's window resets, as GitHub's REST `rate_limit` says (it costs nothing); null when it can't say. */
export async function restReset(run: Runner, cwd: string): Promise<string | null> {
  try {
    const r = await run('gh', ['api', 'rate_limit', '--jq', '.resources.graphql.reset'], { cwd, timeoutMs: 30_000 });
    const s = Number(r.out.trim());
    return r.code === 0 && Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/** A time for the log: the PC's hours and minutes. */
export const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The one line a round that waits for the budget leaves. */
export const waitLine = (g: { until: string; why: string }) => `GitHub's API budget: ${g.why}, so the round waits until ${clock(g.until)}, asking GitHub nothing (the Steward stays at least 10% under GitHub's limit)`;
