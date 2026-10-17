import { existsSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { selfFor } from '../claims.ts';
import { fetchBranch, gitMaybe, hasObject, removeWorktree } from '../git.ts';
import { whileAwake } from '../kit/awake.ts';
import { LockTimeout } from '../kit/lock.ts';
import { SENESCHAL_IDLE_MS, seneschalWork, type SeneschalJob, type SeneschalKind, type SeneschalOutcome } from '../kit/seneschal.ts';
import type { Employee, Settings } from '../settings.ts';
import { checksIn, PACKAGES_HELD, type FailedChecks } from './bump.ts';
import { checkoutOf, freshWorktree, interrupted, workRootOf, type Ctx } from './common.ts';
import { apart, repoBusy, withRepo } from './slots.ts';

/**
 * The Steward as one of the Seneschal's workers (Steward 0.36.98, Seneschal 0.2.0). Beside the rounds (agent.ts), it
 * asks the Seneschal for any PR check or whole suite of the repositories it looks after that waits for room, on this PC
 * or on another PC on the licence, and runs it as its own PR test would: the commit fetched from the repository's origin,
 * a worktree of its own, the employee's checks in Settings, and the result back to the Seneschal, which hands it to the
 * PC that asked. Where both PCs' Settings give the same checks, that PC takes the pass as its own, and doesn't run them.
 *
 * - Only a commit on one of the repository's own branches runs (the task's branch, else the employee's): never a
 *   fork's, nor anything a task names but the repository's own code. A task names a commit, never a command: the
 *   commands are this PC's Settings for that employee.
 * - One at a time, and never for a repository a stage holds now: a round holds an employee's repository while it waits
 *   for its turn, and that very task may be its own. A stage that takes the repository meanwhile keeps it, and the task
 *   goes back to the Seneschal unstarted.
 * - A shard of another PC's whole suite (wholesuite.ts) runs only its part of the test files (bump.ts's shardSteps),
 *   dealt from the same commit as that PC deals them.
 * - A run is stopped after OTHERS_LIMIT_MS, and one that couldn't finish (stopped, packages held, Windows ended it) is
 *   reported as such: the Seneschal tries it again, and passes this PC over for that kind a while.
 */

export const OTHERS_KINDS: SeneschalKind[] = ['pr-check', 'full-suite'];
/** A run of the checks for another PC is stopped after this long. */
export const OTHERS_LIMIT_MS = 90 * 60_000;
/** How long the worker waits for an employee's repository a stage took just now, before the task goes back. */
const REPO_WAIT_MS = 5_000;
/** How long it waits before it asks again when there's no Seneschal on this PC. */
export const NO_SENESCHAL_MS = 5 * 60_000;

/** The worktree a task for the Seneschal runs in: one per employee, beside its PR test's. */
export const othersDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-others`);

/**
 * The employees whose checks it can run for the Seneschal: the Steward's own repository too, each with checks in Settings
 * and its clone on this PC.
 */
export function workersFor(s: Settings): Employee[] {
  const self = selfFor(s);
  const all = [...s.employees, ...(self && !s.employees.some((e) => e.repo.toLowerCase() === self.repo.toLowerCase()) ? [self] : [])];
  return all.filter((e) => e.repo && e.test.length && existsSync(path.join(checkoutOf(e), '.git')));
}

/**
 * Fetches the job's commit into `e`'s clone (`repo`), from its origin, and says why it may not run when it isn't on the
 * task's branch or the employee's there; null when it may. Its base, for only the tests a change reaches, comes too.
 */
export async function fetchJob(ctx: Pick<Ctx, 'run'>, e: Pick<Employee, 'repo' | 'branch'>, repo: string, job: Pick<SeneschalJob, 'commit' | 'branch' | 'base'>): Promise<string | null> {
  const branches = [...new Set([job.branch, e.branch].filter((b): b is string => !!b))];
  for (const b of branches) {
    if (!(await fetchBranch(ctx.run, repo, b).then(() => true, () => false))) continue;
    if ((await gitMaybe(ctx.run, repo, 'merge-base', '--is-ancestor', job.commit, `refs/remotes/origin/${b}`)) === null) continue;
    // Without it, the run picks the whole suite (affected.ts): more than asked, never less.
    if (job.base && !hasObject(repo, job.base)) await gitMaybe(ctx.run, repo, 'fetch', '--quiet', 'origin', job.base);
    return null;
  }
  return `${job.commit.slice(0, 7)} isn't on ${branches.map((b) => `origin/${b}`).join(' or ')} of ${e.repo}: only a commit on the repository's own branches is run for another PC`;
}

/** What a run for the Seneschal came to, for its report: a failure that says the run couldn't finish is an error. Pure. */
export function outcomeOf(failed: string | null, seen: FailedChecks, commands: string[]): SeneschalOutcome {
  if (!failed) return { ok: true, commands };
  const error = !!seen.timedOut || failed.startsWith(PACKAGES_HELD) || interrupted(failed);
  return { ok: false, ...(error ? { error: true } : {}), note: failed.slice(0, 500), commands };
}

export interface OthersRound {
  /** The task it ran (its id in the Seneschal's ledger), or null when it ran none. */
  ran: string | null;
  /** What it came to, or why it ran none, in words. */
  why: string;
  /** When to ask again. */
  retryMs: number;
}

/**
 * One ask of the Seneschal for a task this Steward may run (the repositories in `settings`), and the run of the one it
 * hands out, in the context `ctxOf` makes once there is one. `ask` is the tests' (the kit's seneschalWork).
 */
export async function workForOthers(o: { settings: Settings; ctxOf: () => Promise<Ctx>; say: (line: string) => void; ask?: typeof seneschalWork }): Promise<OthersRound> {
  const say = o.say;
  const free = workersFor(o.settings).filter((e) => !repoBusy(e.id));
  const got = await (o.ask ?? seneschalWork)({ worker: APP.id, kinds: OTHERS_KINDS, repos: [...new Set(free.map((e) => e.repo))], slot: 'others', say: (line) => say(`the Seneschal: ${line}`) });
  if (!got) return { ran: null, why: 'no Seneschal on this PC', retryMs: NO_SENESCHAL_MS };
  if ('idle' in got) return { ran: null, why: got.idle, retryMs: got.retryMs };
  const job = got.job;
  const whose = job.from ? `${job.from.pc.name}'s` : "this PC's";
  const e = free.find((x) => x.repo.toLowerCase() === job.repo.toLowerCase());
  if (!e) {
    await job.turn.giveBack(`the Steward here doesn't run ${job.repo}'s checks now`);
    return { ran: null, why: `handed ${job.what} back: no employee of ${job.repo} free here`, retryMs: SENESCHAL_IDLE_MS };
  }
  const ctx = await o.ctxOf();
  const tag = `[${e.id}] for ${whose} Seneschal (${job.id}${job.from ? `, ${job.from.id} there` : ''})`;
  const line = (s: string) => say(`${tag}: ${s}`);
  const repo = checkoutOf(e);
  const dir = othersDirOf(ctx.settings, e);
  line(`${job.what}, at ${job.commit.slice(0, 7)}`);
  // The clone, briefly: the commit fetched and a worktree made. A stage that holds it now keeps it, and the task goes back.
  let not: string | null;
  try {
    not = await withRepo(
      line,
      e.id,
      async () => {
        const off = await fetchJob(ctx, e, repo, job);
        if (off) return off;
        await removeWorktree(ctx.run, repo, dir);
        await freshWorktree(ctx.run, ctx.settings, repo, dir, job.commit, '--detach');
        return null;
      },
      { waitMs: REPO_WAIT_MS },
    );
  } catch (err) {
    if (err instanceof LockTimeout) {
      await job.turn.giveBack(`${e.name}'s clone is in use here`);
      return { ran: null, why: `handed ${job.what} back: ${e.name}'s clone is in use here`, retryMs: SENESCHAL_IDLE_MS };
    }
    not = `its worktree couldn't be made: ${(err as Error).message}`;
  }
  if (not) {
    line(not);
    await job.turn.hold(async () => null, () => ({ ok: false, error: true, note: not! }));
    return { ran: job.id, why: not, retryMs: SENESCHAL_IDLE_MS };
  }
  const seen: FailedChecks = {};
  const limit = { ms: OTHERS_LIMIT_MS, why: `${OTHERS_LIMIT_MS / 60_000} minutes, the most a run for the Seneschal takes here` };
  // Only the tests the change reaches, against the base the task names; one shard of the whole suite; else all of it.
  const scope = job.shard ? { shard: job.shard } : job.base ? { affected: { base: job.base } } : {};
  try {
    const failed = await apart('checks for the Seneschal', () =>
      whileAwake(
        `${e.name}'s checks for ${whose} Seneschal`,
        () => job.turn.hold(
          () => checksIn(ctx, e, dir, { say: line, ...scope, doing: job.what, timeLimit: () => limit, failed: seen }, true),
          (f) => outcomeOf(f, seen, e.test),
        ),
        ctx.log,
      ),
    );
    const why = failed ? `failed: ${failed}` : 'passed';
    line(why);
    return { ran: job.id, why, retryMs: 0 };
  } catch (err) {
    // hold reported it as a run that couldn't finish.
    const why = `couldn't run: ${(err as Error).message}`;
    line(why);
    return { ran: job.id, why, retryMs: SENESCHAL_IDLE_MS };
  } finally {
    try {
      // Left for the next run's to clear when a stage holds the clone a long while.
      await withRepo(line, e.id, () => removeWorktree(ctx.run, repo, dir), { waitMs: 60_000 });
    } catch (err) {
      line(`couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
