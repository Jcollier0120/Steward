import type { BuildPhase } from './buildtimes.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';

/**
 * The build pipeline (Settings: Build pipeline): how the Steward always works, with no switch to turn it off. It merges,
 * tests and releases at set build times a day (four to start with: 00:00, 06:00, 12:00 and 18:00), instead of whenever
 * a PR goes ready. Between builds its rounds only look: no merges, catch-ups, kit rollouts, releases or site refreshes.
 * At a build time, a build begins: its rounds merge every ready PR (a repository's stacked as one train and tested once,
 * stages/train.ts), roll the newest kit out, and once nothing is left that settles in minutes, release each repository
 * once and tell Manor once, so each agent is installed at most once a build.
 *
 * A build that the PC slept through begins at the first round after it wakes, once (a later build time it also missed
 * is the same build), and the page says it was late, and why (lateLine). The Steward wakes the PC for its builds, and
 * holds it until they close (build-hold.ts), so on AC power that happens only when the PC can't be woken. The owner's
 * override, Build now (POST /api/pipeline/build, or `steward build` at a console), begins one at once: for some
 * repositories, or all, and, ticked, lets its releases out to customers at once too. An urgent fix (a ready PR whose
 * changelog entry has a line starting "**Urgent fix:", stages/urgent.ts) begins one at once too, for its repository
 * alone, without the kit.
 *
 * pipeline.json keeps the build that is open, and the last builds, each with what it merged and released.
 */

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = (typeof DAYS)[number];

/**
 * The build pipeline's settings. There is no switch: Steward 0.36.40 to 0.36.62 had one (`on`, off by default), and a
 * settings.json that still keeps it, on or off, builds at its times all the same (normalizePipeline leaves it out).
 */
export interface BuildPipeline {
  /** The build times, local, HH:MM. */
  times: string[];
  /** The days builds run on. */
  days: Day[];
  /** The newest kit goes into every build, or only the day's first. */
  kit: 'every' | 'first';
  /**
   * A build's rounds go on at most this long (15 to 60 minutes; 30 unless Settings say otherwise); then the build releases
   * what it merged, and ends. Its ready PRs merge ahead of it, between builds (stages/prepare.ts), so a build mostly merges
   * what went ready since, and releases.
   */
  windowMinutes: number;
  /**
   * A repository's stack that fails its checks (twice: once more for a flaky test) is halved at most this many times to
   * find the PR that broke it (stages/build.ts). 0: none is looked for, and the stack waits for the next build.
   */
  bisectRuns: number;
}

export const DEFAULT_PIPELINE: BuildPipeline = { times: ['00:00', '06:00', '12:00', '18:00'], days: [...DAYS], kit: 'every', windowMinutes: 30, bisectRuns: 3 };

/** The longest a build may take (Steward 0.36.67): an hour, which the owner already finds too long. */
export const MAX_WINDOW_MINUTES = 60;

/**
 * The default build times before Steward 0.36.63. Settings saves the whole group, so turning the switch on stored them
 * with it: stored as they are, they were never chosen, and read as today's default.
 */
const OLD_DEFAULT_TIMES = ['08:00', '13:00', '18:00'];

/** The window's default before Steward 0.36.67, stored with the times the same way: it reads as today's default too. */
const OLD_DEFAULT_WINDOW = 120;

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * settings.json's buildPipeline over the defaults, each value checked: a bad one falls back to its default. An `on` kept
 * from when there was a switch is left out, whatever it says, and times or a window that are exactly the old default
 * take today's; a window longer than MAX_WINDOW_MINUTES is cut to it.
 */
export function normalizePipeline(raw: unknown): BuildPipeline {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PIPELINE;
  const times = Array.isArray(r.times)
    ? [...new Set(r.times.filter((t): t is string => typeof t === 'string' && TIME.test(t.trim())).map((t) => t.trim().padStart(5, '0')))].sort()
    : d.times;
  const days = Array.isArray(r.days) ? DAYS.filter((x) => (r.days as unknown[]).includes(x)) : d.days;
  const whole = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : Number.NaN);
  const w = whole(r.windowMinutes);
  const b = whole(r.bisectRuns);
  const oldDefault = times.length === OLD_DEFAULT_TIMES.length && times.every((t, i) => t === OLD_DEFAULT_TIMES[i]);
  return {
    times: times.length && !oldDefault ? times : d.times,
    days,
    kit: r.kit === 'first' || r.kit === 'every' ? r.kit : d.kit,
    windowMinutes: Number.isInteger(w) && w !== OLD_DEFAULT_WINDOW ? Math.min(MAX_WINDOW_MINUTES, Math.max(15, w)) : d.windowMinutes,
    bisectRuns: Number.isInteger(b) ? Math.min(6, Math.max(0, b)) : d.bisectRuns,
  };
}

/** One build: when it was due, who began it, and what it did. */
export interface BuildRun {
  /** The build time it is for (ISO); for the owner's Build now, when it was pressed; for an urgent fix, when it was found. */
  due: string;
  by: 'schedule' | 'owner' | 'urgent';
  started: string;
  finished?: string | null;
  /** The owner's Build now, or an urgent fix's build, for some repositories only (ids); none: all. */
  employees?: string[] | null;
  /** An urgent fix's build: "<id> #<n> <head>" for each urgent PR that began it, which boards once at that head (stages/urgent.ts). */
  urgent?: string[];
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
  /** Where its time went (buildtimes.ts): each phase with its start and end, those done between builds for it marked `ahead`. */
  phases?: BuildPhase[];
  /** A build time the PC slept through (standby): when it woke (ISO), and the build began (pipelineMode's `wokeAt`). */
  late?: string;
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
  /**
   * Not a round of the pipeline's: a stage asked for at a console (`steward merge`, `release`), a round that asks GitHub
   * nothing, or a test's round that doesn't test the pipeline (steward.ts' StageOptions.pipeline). pipelineMode never
   * gives it.
   */
  | { kind: 'outside' }
  /** Between builds: it only looks. */
  | { kind: 'between'; next: Date | null; line: string }
  /** A build's round: `closing` once its window has run out, when it releases whatever it merged and ends. */
  | { kind: 'build'; run: BuildRun; fresh: boolean; closing: boolean };

/** An urgent PR that boards at once (stages/urgent.ts): its repository's id, its number and its head commit. */
export interface UrgentPr {
  id: string;
  number: number;
  head: string;
}

/** How an urgent PR is kept in its build's record, so it boards once at that head. */
export const urgentKey = (u: UrgentPr) => `${u.id} #${u.number} ${u.head}`;

/** The urgent PRs that boarded a build already, open or kept, by urgentKey: each boards once at its head. */
export const boardedUrgent = (state: PipelineState): Set<string> => new Set([...state.builds, ...(state.open ? [state.open] : [])].flatMap((b) => b.urgent ?? []));

/**
 * What a round does now: between builds, or a build's round, the one open going on, a new one for a build time that has
 * come (or the owner's Build now, or an urgent fix found between builds: `urgent`, a build for its repositories alone).
 * A build time's build that begins after the PC woke from standby past it (`wokeAt`, fresh-start.ts' lastWoke) is
 * `late`. Pure; the round saves the build it changes (endRound).
 */
export function pipelineMode(p: BuildPipeline, state: PipelineState, now: Date, o: { buildNow?: BuildNow | null; employees?: string[] | null; urgent?: UrgentPr[] | null; wokeAt?: number | null } = {}): PipelineMode {
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
  if (due && (!lastDue || Date.parse(lastDue) < due.getTime())) {
    const woke = o.wokeAt ?? null;
    return fresh(due.toISOString(), 'schedule', woke !== null && woke > due.getTime() && woke <= now.getTime() ? { late: new Date(woke).toISOString() } : {});
  }
  // An urgent fix between builds: a build of its own, for its repository, at once.
  if (o.urgent?.length) return fresh(now.toISOString(), 'urgent', { employees: [...new Set(o.urgent.map((u) => u.id))], urgent: o.urgent.map(urgentKey) });
  const next = nextBuildTime(p, now);
  return { kind: 'between', next, line: `between builds: ready PRs merge ahead of the next build${next ? `, at ${buildWhen(next, now)}` : " (Settings name no build time to come: Build pipeline)"}, and are released at it` };
}

/** "the 08:00 build was late: the PC was in standby until 08:39", for a build the PC slept through; else null. */
export function lateLine(run: BuildRun | null | undefined, now: Date): string | null {
  if (!run?.late || run.by !== 'schedule') return null;
  return `the ${buildWhen(new Date(run.due), now)} build was late: the PC was in standby until ${buildWhen(new Date(run.late), now)}`;
}

/**
 * Whether the newest kit goes into this build: every build, or only the day's first scheduled one. Never an urgent fix's:
 * a kit PR would hold its release until the kit's checks pass, and the next build takes the kit.
 */
export function kitRides(p: BuildPipeline, state: PipelineState, run: BuildRun): boolean {
  if (run.by === 'urgent') return false;
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
  /** Always true: there is no switch. Manor reads it, and shows the next build only while it is. */
  on: true;
  times: string[];
  days: Day[];
  kit: BuildPipeline['kit'];
  /** The next build time (ISO), or null when Settings name none to come. */
  next: string | null;
  /** The build under way: Manor holds its installs until it ends. */
  building: boolean;
  open: BuildRun | null;
  last: BuildRun | null;
}

export function pipelineView(p: BuildPipeline, state: PipelineState, now = new Date()): PipelineView {
  const open = state.open && !state.open.finished ? state.open : null;
  return { on: true, times: p.times, days: p.days, kit: p.kit, next: nextBuildTime(p, now)?.toISOString() ?? null, building: !!open, open, last: state.builds.at(-1) ?? null };
}
