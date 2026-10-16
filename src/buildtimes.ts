import { dataFile, readJson, writeJson } from './kit/store.ts';
import { loadPipeline, savePipeline, type BuildRun } from './pipeline.ts';

/**
 * Where a build's time goes (Steward 0.36.67): each phase of a build, with when it started and ended, kept in
 * build-phases.json by the build's time (its `due`) and copied into the build's record in pipeline.json (BuildRun's
 * `phases`), so the Steward's page can say in a line where the last build spent its time.
 *
 * The phases: the tests of a repository's PRs, trains and batches (`tests`, of the repository), a kit's trial on the
 * agents (`trial`), the merges themselves (`merges`), the Steward's whole suite before a kit's release (`whole suite`),
 * the kit's rollout (`rollout`), the releases, signing included (`releases`), and Manor told (`manor`). Some run beside
 * the rounds, so phases overlap: each one's minutes count its own spans once, however many ran at the same time.
 *
 * Work done between builds for the next one (stages/prepare.ts) is kept under the next build's time, marked `ahead`:
 * the build itself then only checks that nothing moved and merges. The Steward's own PRs tested the same way beside a
 * build's rounds (stages/selftests.ts) are that build's own time, not marked.
 */

export type PhaseName = 'tests' | 'trial' | 'merges' | 'whole suite' | 'rollout' | 'releases' | 'manor';

/** The phases in the order a build goes through them, as the page's line names them. */
export const PHASES: PhaseName[] = ['tests', 'trial', 'whole suite', 'merges', 'rollout', 'releases', 'manor'];

export interface BuildPhase {
  phase: PhaseName;
  /** What it was for: a repository's id, "steward #12", a kit's version. */
  of?: string;
  started: string;
  finished: string;
  /** Done between builds, for this build (stages/prepare.ts). */
  ahead?: boolean;
}

/** The build a stage works for: the one under way (ctx.build), or the next one it prepares for (ctx.prepare, `ahead`). */
export interface PhaseOf {
  due: string;
  ahead?: boolean;
}

/**
 * The build a stage's work counts for: the build under way, else the one it merges ahead of (ctx.build `ahead`) or
 * prepares for, else none. A prepare inside the build (`inBuild`: the Steward's own PRs tested beside its rounds) is the build's own time.
 */
export const phaseOf = (ctx: { build?: { due: string; ahead?: boolean } | null; prepare?: { due: string; inBuild?: boolean } | null }): PhaseOf | null =>
  ctx.build ? { due: ctx.build.due, ...(ctx.build.ahead ? { ahead: true } : {}) } : ctx.prepare ? { due: ctx.prepare.due, ...(ctx.prepare.inBuild ? {} : { ahead: true }) } : null;

export const buildPhasesFile = () => dataFile('build-phases.json');

/** How many builds' phases build-phases.json keeps (pipeline.json keeps 30 builds). */
const KEEP = 40;

/** The phases kept for a build, by its due; none when there are none. */
export const phasesOf = (due: string): BuildPhase[] => readJson<Record<string, BuildPhase[]>>(buildPhasesFile(), {})[due] ?? [];

/** One phase of a build kept; the oldest builds' let go. Never throws: the build goes on without its timing. */
export function notePhase(due: string, p: BuildPhase): void {
  try {
    const all = readJson<Record<string, BuildPhase[]>>(buildPhasesFile(), {});
    all[due] = [...(all[due] ?? []), p];
    const dues = Object.keys(all).sort((a, b) => Date.parse(a) - Date.parse(b));
    for (const d of dues.slice(0, Math.max(0, dues.length - KEEP))) delete all[d];
    writeJson(buildPhasesFile(), all);
  } catch {
    // Its timing is lost, nothing more.
  }
}

/** A span shorter than this is no phase: a test whose result was kept, a release with nothing to release. */
const NOTHING_MS = 500;

/**
 * `fn`, kept as a phase of the build `build` is (phaseOf), from when it starts to when it ends, whatever it gives or
 * throws. Without a build, it only runs. `keep` says whether what it gave is worth a phase (a release step that released
 * nothing isn't); one over in under half a second isn't either.
 */
export async function timed<T>(build: PhaseOf | null | undefined, phase: PhaseName, of: string | null, fn: () => Promise<T>, keep?: (r: T) => boolean, now: () => number = Date.now): Promise<T> {
  if (!build) return fn();
  const t0 = now();
  let kept = true;
  try {
    const r = await fn();
    if (keep) kept = keep(r);
    return r;
  } finally {
    const t1 = now();
    if (kept && t1 - t0 >= NOTHING_MS) notePhase(build.due, { phase, ...(of ? { of } : {}), started: new Date(t0).toISOString(), finished: new Date(t1).toISOString(), ...(build.ahead ? { ahead: true } : {}) });
  }
}

/** The time a set of spans covers, each moment once however many ran at it (ms). Pure. */
export function spanMs(spans: { started: string; finished: string }[]): number {
  const parts = spans
    .map((s) => [Date.parse(s.started), Date.parse(s.finished)] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let from = -Infinity;
  let to = -Infinity;
  for (const [a, b] of parts) {
    if (a > to) {
      if (to > from) total += to - from;
      from = a;
      to = b;
    } else to = Math.max(to, b);
  }
  if (to > from) total += to - from;
  return total;
}

/** Minutes in words: "under a minute", "1 min", "23 min". Pure. */
export const minutesWords = (ms: number): string => (ms < 60_000 ? 'under a minute' : `${Math.round(ms / 60_000)} min`);

const LABEL: Record<PhaseName, string> = {
  tests: 'tests',
  trial: 'kit trial',
  'whole suite': 'whole suite',
  merges: 'merges',
  rollout: 'rollout',
  releases: 'releases',
  manor: 'Manor told',
};

/** A build's name in a line: "the 08:00 build" (this PC's time), or "the owner's Build now". Pure but for the time zone. */
export function buildName(run: Pick<BuildRun, 'due' | 'by'>): string {
  if (run.by === 'owner') return "the owner's Build now";
  const d = new Date(run.due);
  return `the ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} build`;
}

/**
 * The line the Steward's page shows for a build that ended: how long it took from its start to its last phase's end
 * (Manor told comes after it is recorded as finished), each phase's own minutes, and what was done ahead of it between
 * builds. Null for a build still open. Pure but for the time zone (buildName).
 */
export function buildTimeLine(run: Pick<BuildRun, 'due' | 'by' | 'started' | 'finished' | 'cut'> & { phases?: BuildPhase[] }): string | null {
  if (!run.finished) return null;
  const phases = run.phases ?? [];
  const inBuild = phases.filter((p) => !p.ahead);
  const end = Math.max(Date.parse(run.finished), ...inBuild.map((p) => Date.parse(p.finished)).filter(Number.isFinite));
  const name = buildName(run);
  const parts = PHASES.flatMap((ph) => {
    const spans = inBuild.filter((p) => p.phase === ph);
    return spans.length ? [`${LABEL[ph]} ${minutesWords(spanMs(spans))}`] : [];
  });
  const ahead = phases.filter((p) => p.ahead);
  const before = ahead.length ? `; ${minutesWords(spanMs(ahead))} of its tests ran ahead of it, between builds` : '';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} took ${minutesWords(end - Date.parse(run.started))}${run.cut ? ' (it ran out of time)' : ''}${parts.length ? `: ${parts.join(', ')}` : ''}${before}.`;
}

/**
 * The phases kept for a build copied into its record in pipeline.json (open or ended), so GET /api/pipeline and the page
 * have them. Never throws.
 */
export function keepPhases(due: string): void {
  try {
    const phases = phasesOf(due);
    if (!phases.length) return;
    const s = loadPipeline();
    const mine = (b: BuildRun | null | undefined) => !!b && b.due === due;
    if (mine(s.open)) s.open = { ...s.open!, phases };
    else {
      const i = s.builds.findLastIndex((b) => mine(b));
      if (i < 0) return;
      s.builds[i] = { ...s.builds[i], phases };
    }
    savePipeline(s);
  } catch {
    // The record keeps what it had.
  }
}
