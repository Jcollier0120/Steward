import { dataFile, readJson, writeJson } from './kit/store.ts';

/**
 * The build pipeline (Settings: Build pipeline): the Steward merges, tests and releases at set build times a day,
 * instead of whenever a PR goes ready. Between builds its rounds only look: no merges, catch-ups, kit rollouts,
 * releases or site refreshes. At a build time, a build begins: its rounds merge every ready PR (a repository's stacked
 * as one train and tested once, stages/train.ts), roll the newest kit out, and once nothing is left that settles in
 * minutes, release each repository once and tell Manor once, so each agent is installed at most once a build.
 *
 * A build that the PC slept through begins at the first round after it wakes, once (a later build time it also missed
 * is the same build). The owner's override, Build now (POST /api/pipeline/build, or `steward build` at a console),
 * begins one at once: for some repositories, or all, and, ticked, lets its releases out to customers at once too.
 *
 * pipeline.json keeps the build that is open, and the last builds, each with what it merged and released.
 */

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = (typeof DAYS)[number];

export interface BuildPipeline {
  /** Off: a round merges and releases whatever is ready, as before. */
  on: boolean;
  /** The build times, local, HH:MM. */
  times: string[];
  /** The days builds run on. */
  days: Day[];
  /** The newest kit goes into every build, or only the day's first. */
  kit: 'every' | 'first';
  /** A build's rounds go on at most this long; then the build releases what it merged, and ends. */
  windowMinutes: number;
}

export const DEFAULT_PIPELINE: BuildPipeline = { on: false, times: ['08:00', '13:00', '18:00'], days: [...DAYS], kit: 'every', windowMinutes: 120 };

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** settings.json's buildPipeline over the defaults, each value checked: a bad one falls back to its default. */
export function normalizePipeline(raw: unknown): BuildPipeline {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PIPELINE;
  const times = Array.isArray(r.times)
    ? [...new Set(r.times.filter((t): t is string => typeof t === 'string' && TIME.test(t.trim())).map((t) => t.trim().padStart(5, '0')))].sort()
    : d.times;
  const days = Array.isArray(r.days) ? DAYS.filter((x) => (r.days as unknown[]).includes(x)) : d.days;
  const w = typeof r.windowMinutes === 'number' ? r.windowMinutes : typeof r.windowMinutes === 'string' && r.windowMinutes.trim() ? Number(r.windowMinutes) : Number.NaN;
  return {
    on: typeof r.on === 'boolean' ? r.on : d.on,
    times: times.length ? times : d.times,
    days,
    kit: r.kit === 'first' || r.kit === 'every' ? r.kit : d.kit,
    windowMinutes: Number.isInteger(w) ? Math.min(360, Math.max(15, w)) : d.windowMinutes,
  };
}

/** One build: when it was due, who began it, and what it did. */
export interface BuildRun {
  /** The build time it is for (ISO); for the owner's Build now, when it was pressed. */
  due: string;
  by: 'schedule' | 'owner';
  started: string;
  finished?: string | null;
  /** The owner's Build now for some repositories only (ids); none: all. */
  employees?: string[] | null;
  /** The owner's Build now: its releases let out to customers at once, not on their release day. */
  toCustomers?: boolean;
  /** The rounds it took. */
  rounds: number;
  /** "<id> #<n>" for each PR it merged. */
  merged: string[];
  /** "<id> v<version>" for each release it made. */
  released: string[];
  /** "<id>: <why>" for each failure. */
  failed: string[];
  /** It ran out of its window before everything settled. */
  cut?: boolean;
}

export interface PipelineState {
  /** The build under way, if one is. */
  open?: BuildRun | null;
  /** The last builds, newest last. */
  builds: BuildRun[];
}

/** How many past builds pipeline.json keeps. */
export const KEEP_BUILDS = 30;

export const pipelineFile = () => dataFile('pipeline.json');
export const loadPipeline = (): PipelineState => {
  const s = readJson<Partial<PipelineState>>(pipelineFile(), {});
  return { open: s.open ?? null, builds: Array.isArray(s.builds) ? s.builds : [] };
};
export const savePipeline = (s: PipelineState) => writeJson(pipelineFile(), { open: s.open ?? null, builds: s.builds.slice(-KEEP_BUILDS) });

/** A build time on a day (local), as a Date. */
function at(day: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The build times of the eight days up to `now`'s, oldest first, on the days builds run. */
function slots(p: BuildPipeline, now: Date, ahead: number): Date[] {
  const out: Date[] = [];
  for (let back = 8; back >= -ahead; back--) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    if (!p.days.includes(DAYS[day.getDay()])) continue;
    for (const t of p.times) out.push(at(day, t));
  }
  return out;
}

/** The last build time at or before `now`, or null when none is in the past eight days. */
export function lastBuildTime(p: BuildPipeline, now: Date): Date | null {
  return slots(p, now, 0).filter((d) => d.getTime() <= now.getTime()).at(-1) ?? null;
}

/** The next build time after `now`, or null when there is none in the next eight days (no times, or no days). */
export function nextBuildTime(p: BuildPipeline, now: Date): Date | null {
  return slots(p, now, 8).find((d) => d.getTime() > now.getTime()) ?? null;
}

/** "18:00", or "Mon 08:00" when it isn't today. */
export function buildWhen(d: Date, now: Date): string {
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${DAYS[d.getDay()].charAt(0).toUpperCase()}${DAYS[d.getDay()].slice(1)} ${hm}`;
}

/** What the owner's Build now asks of a round. */
export interface BuildNow {
  toCustomers?: boolean;
}

/** What a round does under the pipeline. */
export type PipelineMode =
  /** No pipeline: merges and releases as ever. */
  | { kind: 'off' }
  /** Between builds: it only looks. */
  | { kind: 'between'; next: Date | null; line: string }
  /** A build's round: `closing` once its window has run out, when it releases whatever it merged and ends. */
  | { kind: 'build'; run: BuildRun; fresh: boolean; closing: boolean };

/**
 * What a round does now: off (no pipeline), between builds, or a build's round, the one open going on, a new one for a
 * build time that has come (or the owner's Build now). Pure; the round saves the build it changes (endRound).
 */
export function pipelineMode(p: BuildPipeline, state: PipelineState, now: Date, o: { buildNow?: BuildNow | null; employees?: string[] | null } = {}): PipelineMode {
  if (!p.on && !o.buildNow) return { kind: 'off' };
  const open = state.open;
  if (open && !open.finished) {
    const over = now.getTime() - Date.parse(open.started) >= p.windowMinutes * 60_000;
    // The owner's Build now while one is open: it goes on in that one.
    return { kind: 'build', run: open, fresh: false, closing: over };
  }
  const fresh = (due: string, by: BuildRun['by'], more: Partial<BuildRun> = {}): PipelineMode => ({ kind: 'build', run: { due, by, started: now.toISOString(), rounds: 0, merged: [], released: [], failed: [], ...more }, fresh: true, closing: false });
  if (o.buildNow) return fresh(now.toISOString(), 'owner', { employees: o.employees?.length ? o.employees : null, ...(o.buildNow.toCustomers ? { toCustomers: true } : {}) });
  const due = lastBuildTime(p, now);
  const lastDue = state.builds.filter((b) => b.by === 'schedule').at(-1)?.due;
  if (due && (!lastDue || Date.parse(lastDue) < due.getTime())) return fresh(due.toISOString(), 'schedule');
  const next = nextBuildTime(p, now);
  return { kind: 'between', next, line: `between builds: ready PRs wait for the next build${next ? `, at ${buildWhen(next, now)}` : " (Settings name no build time to come: Build pipeline)"}` };
}

/** Whether the newest kit goes into this build: every build, or only the day's first scheduled one. */
export function kitRides(p: BuildPipeline, state: PipelineState, run: BuildRun): boolean {
  if (p.kit === 'every' || run.by === 'owner') return true;
  const day = new Date(run.due).toDateString();
  return !state.builds.some((b) => b.by === 'schedule' && b !== run && new Date(b.due).toDateString() === day && Date.parse(b.due) < Date.parse(run.due));
}

/**
 * The build after one of its rounds: what it merged, released and failed added; ended (`finished`) when the round
 * closed it. Gives back the state to save.
 */
export function endRound(state: PipelineState, run: BuildRun, o: { merged: string[]; released: string[]; failed: string[]; closed: boolean; cut?: boolean; now: Date }): PipelineState {
  const next: BuildRun = {
    ...run,
    rounds: run.rounds + 1,
    merged: [...run.merged, ...o.merged],
    released: [...run.released, ...o.released],
    failed: [...run.failed, ...o.failed],
    ...(o.closed ? { finished: o.now.toISOString(), ...(o.cut ? { cut: true } : {}) } : {}),
  };
  return o.closed ? { open: null, builds: [...state.builds, next].slice(-KEEP_BUILDS) } : { open: next, builds: state.builds };
}

/** What Manor and the page read of the pipeline (GET /api/pipeline). */
export interface PipelineView {
  on: boolean;
  times: string[];
  days: Day[];
  kit: BuildPipeline['kit'];
  /** The next build time (ISO), when the pipeline is on. */
  next: string | null;
  /** The build under way: Manor holds its installs until it ends. */
  building: boolean;
  open: BuildRun | null;
  last: BuildRun | null;
}

export function pipelineView(p: BuildPipeline, state: PipelineState, now = new Date()): PipelineView {
  const open = state.open && !state.open.finished ? state.open : null;
  return { on: p.on, times: p.times, days: p.days, kit: p.kit, next: p.on ? (nextBuildTime(p, now)?.toISOString() ?? null) : null, building: !!open, open, last: state.builds.at(-1) ?? null };
}
