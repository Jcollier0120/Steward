import type { BuildPhase } from './buildtimes.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';

/**
 * The build pipeline (Settings: Build pipeline): how the Steward always works, with no switch to turn it off. It tests
 * and releases at set build times a day (four to start with: 00:00, 06:00, 12:00 and 18:00). It merges no one's PRs
 * (Steward 0.36.124): their authors merge them once vouched, and a build releases each repository's main as it finds it.
 * Between builds its rounds only look (and try a new kit ahead of the build: stages/self.ts's trialAhead). At a build
 * time, a build begins: its rounds stamp main's unstamped entries (stages/stamp.ts), release the Steward's new kit once it
 * passed its trial on every agent, roll it out (its PRs merged by the Steward itself), and once nothing is left that
 * settles in minutes, test main's head of each repository with an unreleased version (unless a vouch covers it:
 * stages/mainbuild.ts), release each once and tell Manor once, so each agent is installed at most once a build.
 *
 * A build that the PC slept through begins at the first round after it wakes, once (a later build time it also missed
 * is the same build), and the page says it was late, and why (lateLine). The Steward wakes the PC for its builds, and
 * holds it until they close (build-hold.ts), so on AC power that happens only when the PC can't be woken. The owner's
 * override, Build now (POST /api/pipeline/build, or `steward build` at a console), begins one at once: for some
 * repositories, or all, and, ticked, lets its releases out to customers at once too. An urgent fix (a commit on main whose
 * changelog entry has a line starting "**Urgent fix:", stages/urgent.ts) begins one at once too, for its repository
 * alone, without the kit (unless the kit is the urgent fix: kitRides); and so do releases that waited until this PC could
 * sign, once a round between builds finds it can (signing.ts's signedBetween, Steward 0.36.161), rather than waiting for
 * the next build time.
 *
 * pipeline.json keeps the build that is open, and the last builds, each with what it merged itself and released.
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
   * A build's rounds go on at most this long (15 to 60 minutes; 30 unless Settings say otherwise), waiting for a new kit's
   * trial and rollout; then the build releases each repository's main as it is, and ends, and the kit waits for the next.
   */
  windowMinutes: number;
  /**
   * No longer used (Steward 0.36.124): how many test runs a build had to find the PR that broke it, among the PRs it
   * merged. Builds merge no PRs now; a value kept from before is kept, as Settings' other unused ones are.
   */
  bisectRuns?: number;
}

export const DEFAULT_PIPELINE: BuildPipeline = { times: ['00:00', '06:00', '12:00', '18:00'], days: [...DAYS], kit: 'every', windowMinutes: 30 };

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
    ...(Number.isInteger(b) ? { bisectRuns: Math.min(6, Math.max(0, b)) } : {}),
  };
}

/** One build: when it was due, who began it, and what it did. */
export interface BuildRun {
  /**
   * The build time it is for (ISO); for the owner's Build now, when it was pressed; for an urgent fix, when it was found;
   * for releases that waited until this PC could sign (`signing`, Steward 0.36.161), when a round found it could.
   */
  due: string;
  by: 'schedule' | 'owner' | 'urgent' | 'signing';
  started: string;
  finished?: string | null;
  /** The owner's Build now, an urgent fix's build or a signing build, for some repositories only (ids); none: all. */
  employees?: string[] | null;
  /**
   * An urgent fix's build: "<id> <head>" for each main head that began it, which builds once (stages/urgent.ts); "<id>
   * #<n> <head>", an urgent PR's, in a build from before Steward 0.36.124.
   */
  urgent?: string[];
  /** The owner's Build now: its releases let out to customers at once, not on their release day. */
  toCustomers?: boolean;
  /** The rounds it took. */
  rounds: number;
  /** "<id> #<n>" for each PR it merged: the Steward's own (a kit's rollout, a stamp) since 0.36.124, anyone's before. */
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

/** An urgent fix on main that builds at once (stages/urgent.ts): its repository's id and main's head commit. */
export interface UrgentPr {
  id: string;
  head: string;
}

/** How an urgent fix is kept in its build's record, so that head builds once. */
export const urgentKey = (u: UrgentPr) => `${u.id} ${u.head}`;

/** The urgent heads that built already, open or kept, by urgentKey: each builds once. */
export const boardedUrgent = (state: PipelineState): Set<string> => new Set([...state.builds, ...(state.open ? [state.open] : [])].flatMap((b) => b.urgent ?? []));

/**
 * What a round does now: between builds, or a build's round, the one open going on, a new one for a build time that has
 * come (or the owner's Build now, or an urgent fix found between builds: `urgent`, a build for its repositories alone).
 * A build time's build that begins after the PC woke from standby past it (`wokeAt`, fresh-start.ts' lastWoke) is
 * `late`. Pure; the round saves the build it changes (endRound).
 */
export function pipelineMode(p: BuildPipeline, state: PipelineState, now: Date, o: { buildNow?: BuildNow | null; employees?: string[] | null; urgent?: UrgentPr[] | null; signed?: string[] | null; wokeAt?: number | null } = {}): PipelineMode {
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
  // Releases that waited until this PC could sign, and now it can (signing.ts's signedBetween): a build of their own, at once.
  if (o.signed?.length) return fresh(now.toISOString(), 'signing', { employees: [...new Set(o.signed)] });
  const next = nextBuildTime(p, now);
  return { kind: 'between', next, line: `between builds: PRs are merged by whoever wrote them once vouched, and the next build${next ? `, at ${buildWhen(next, now)},` : " (Settings name no build time to come: Build pipeline)"} releases each repository's main` };
}

/** "the 08:00 build was late: the PC was in standby until 08:39", for a build the PC slept through; else null. */
export function lateLine(run: BuildRun | null | undefined, now: Date): string | null {
  if (!run?.late || run.by !== 'schedule') return null;
  return `the ${buildWhen(new Date(run.due), now)} build was late: the PC was in standby until ${buildWhen(new Date(run.late), now)}`;
}

/**
 * Whether the newest kit goes into this build: every build, or only the day's first scheduled one. Never a signing
 * build's, nor an urgent fix's: a kit PR would hold its release until the kit's checks pass, and the next build takes the
 * kit. But for the urgent fix's build of the Steward's own whose kit is itself urgent (`urgentKit`, rollout.ts's
 * urgentKit): it rolls that kit out to every employee, each entry marked urgent, and each employee is built at once
 * after it (stages/urgent.ts), rather than at the next build, up to a night later (Steward 0.36.234).
 */
export function kitRides(p: BuildPipeline, state: PipelineState, run: BuildRun, o: { urgentKit?: boolean } = {}): boolean {
  if (run.by === 'urgent') return !!o.urgentKit;
  if (run.by === 'signing') return false;
  if (p.kit === 'every' || run.by === 'owner') return true;
  const day = new Date(run.due).toDateString();
  return !state.builds.some((b) => b.by === 'schedule' && b !== run && new Date(b.due).toDateString() === day && Date.parse(b.due) < Date.parse(run.due));
}

/**
 * What a build's round does with the newest kit, once the Steward's own releases have had their turn: roll it out
 * ('rollout'), wait for the kit main carries, still being tried or waiting for its whole suite (`waits`, 'wait'), or leave
 * it to the next build ('next'). A build that takes no kit (kitRides: `rides` false) waits for it all the same when it is
 * the urgent fix's build of the Steward's own (`selfUrgent`): the Steward's version waits for its kit's release, and its
 * urgent fix would otherwise wait for the next build, as it did on 2026-10-25 (Steward 0.36.234). Never once the
 * build's time has run out (`closing`). Pure.
 */
export function kitStep(o: { rides: boolean; waits: string | null; closing: boolean; selfUrgent: boolean }): 'rollout' | 'wait' | 'next' {
  if (o.waits && !o.closing && (o.rides || o.selfUrgent)) return 'wait';
  return o.rides ? 'rollout' : 'next';
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
