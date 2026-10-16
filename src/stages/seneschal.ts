import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf } from '../git.ts';
import type { SeneschalKind, SeneschalLane, SeneschalTask } from '../kit/seneschal.ts';
import type { Employee } from '../settings.ts';
import type { AffectedScope } from './bump.ts';
import type { Ctx } from './common.ts';

/**
 * The Steward's checks as the Seneschal's tasks (Steward 0.36.65, the kit's seneschal.ts): where the Seneschal is on
 * this PC, on duty, with Developer Pro, each run of an employee's checks (runChecks, bump.ts) waits its turn in the one
 * order the Seneschal keeps for the developer agents' work, and a pass of the same checks on the same code that the
 * Seneschal holds stands in for running them. Without it, they run as before, at the checks pace.
 *
 * A run is one task: a PR check (its PR and branch), the whole suite before a kit's release, or a kit trial (one per
 * agent and kit). Its lane says who waits on it:
 *
 * - **person**: a person, now: `steward vouch`, a round started by Run now or Build now;
 * - **blocking**: a merge or a release: a PR's test as the merge stage reaches it (the head of its version queue), the
 *   whole suite before a kit's release;
 * - **normal**: the rest (a catch-up's checks, a train's, a refresh's);
 * - **background**: kit trials.
 *
 * The lane comes from the run's own `task`, else from the code around it (withLane: the merge stage's, a person's
 * round), whichever is the more urgent.
 */

const RANK: Record<SeneschalLane, number> = { person: 0, blocking: 1, normal: 2, background: 3 };
const lanes = new AsyncLocalStorage<SeneschalLane>();

/** The more urgent of two lanes. Pure. */
export const urgentOf = (a: SeneschalLane | undefined, b: SeneschalLane): SeneschalLane => (a && RANK[a] < RANK[b] ? a : b);

/** Runs `fn` with the checks it starts in `lane`, unless the code around it asked for a more urgent one already. */
export function withLane<T>(lane: SeneschalLane, fn: () => Promise<T>): Promise<T> {
  return lanes.run(urgentOf(lanes.getStore(), lane), fn);
}

/** The lane the code around asked for, if any. */
export const laneHere = (): SeneschalLane | undefined => lanes.getStore();

/** What a run of the checks is to the Seneschal: its kind (a PR check unless said), its lane, its PR and branch. */
export interface CheckTask {
  kind?: Exclude<SeneschalKind, 'wright-job'>;
  lane?: SeneschalLane;
  pr?: number;
  branch?: string;
}

/** A kit version, as the Seneschal takes one: 2.78.1, or 2.78.1-<commit>. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A kit under trial, named for the Seneschal: its version and the Steward's commit it comes from (2.78.1-1a2b3c4d5e6f),
 * since a kit PR keeps its version while its code changes from push to push. `kitDir` is that commit's kit folder
 * (STEWARD_KIT). Null when either can't be read.
 */
export async function kitIdOf(ctx: Pick<Ctx, 'run'>, kitDir: string): Promise<string | null> {
  let version: string;
  try {
    version = readFileSync(path.join(kitDir, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
  const commit = await commitOf(ctx.run, path.dirname(kitDir), 'HEAD').catch(() => null);
  const id = commit && OID.test(commit) ? `${version}-${commit.slice(0, 12)}` : null;
  return id && VERSION.test(id) ? id : null;
}

/**
 * The Seneschal's task for a run of `e`'s checks in `dir`, or why it isn't asked (`not`: they run as before). Never for
 * a run whose point is this PC (`here`), one with settings of its own (`env`, but for a kit under trial), one told not
 * to (`task: false`), nor code with something uncommitted (but a kit trial's, named by the agent's commit and the kit's).
 */
export async function checksTask(
  ctx: Pick<Ctx, 'run'>,
  e: Pick<Employee, 'id' | 'repo'>,
  dir: string,
  o: { commit?: string; tree?: string; clean: boolean; env?: Record<string, string>; here?: boolean; affected?: AffectedScope; task?: CheckTask | false },
): Promise<SeneschalTask | { not: string }> {
  if (o.task === false) return { not: 'not asked for this run' };
  if (o.here) return { not: 'it runs on this PC, whatever passed' };
  if (!o.commit) return { not: 'its commit is unknown' };
  const kitDir = o.env?.STEWARD_KIT;
  if (Object.keys(o.env ?? {}).some((k) => k !== 'STEWARD_KIT')) return { not: 'it runs with settings of its own' };
  const kind = kitDir ? 'kit-trial' : (o.task?.kind ?? 'pr-check');
  let kit: string | null = null;
  if (kitDir) {
    kit = await kitIdOf(ctx, kitDir);
    if (!kit) return { not: "the kit under trial couldn't be named" };
  } else if (!o.clean || !o.tree) return { not: 'its checkout has something uncommitted' };
  let base: string | null = null;
  if (o.affected) {
    base = await commitOf(ctx.run, dir, o.affected.base).catch(() => null);
    if (!base || !OID.test(base)) return { not: `${o.affected.base} couldn't be read` };
  }
  return {
    kind,
    repo: e.repo,
    commit: o.commit,
    // A kit trial's checkout has the kit's files in it: named by its commit and the kit, never its tree.
    ...(kitDir ? { kit: kit!, agent: e.id } : { tree: o.tree! }),
    ...(base ? { base } : {}),
    ...(o.task && o.task.pr ? { pr: o.task.pr } : {}),
    ...(o.task && o.task.branch ? { branch: o.task.branch } : {}),
    lane: urgentOf(laneHere(), o.task && o.task.lane ? o.task.lane : kind === 'kit-trial' ? 'background' : 'normal'),
    by: APP.id,
  };
}
