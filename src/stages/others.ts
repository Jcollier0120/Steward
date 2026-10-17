import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { selfFor } from '../claims.ts';
import { fetchBranch, gitMaybe, hasObject, removeWorktree } from '../git.ts';
import { whileAwake } from '../kit/awake.ts';
import { LockTimeout } from '../kit/lock.ts';
import { SENESCHAL_IDLE_MS, seneschalWork, type SeneschalJob, type SeneschalKind, type SeneschalOutcome } from '../kit/seneschal.ts';
import type { Employee, Settings } from '../settings.ts';
import { bumpOne, checksIn, PACKAGES_HELD, trialBranch, trialDirOf, type FailedChecks } from './bump.ts';
import { checkoutOf, freshWorktree, interrupted, NOT_ON_KIT, workRootOf, type Ctx } from './common.ts';
import { kitReach } from './kitreach.ts';
import { kitIdOf } from './seneschal.ts';
import { apart, repoBusy, withRepo } from './slots.ts';

/**
 * The Steward as one of the Seneschal's workers (Steward 0.36.98, Seneschal 0.2.0). Beside the rounds (agent.ts), it
 * asks the Seneschal for any PR check, whole suite or kit trial of the repositories it looks after that waits for room,
 * on this PC or on another PC on the licence, and runs it as its own PR test or trial would: the commit fetched from the
 * repository's origin, a worktree of its own, the employee's checks in Settings, and the result back to the Seneschal,
 * which hands it to the PC that asked. Where both PCs' Settings give the same checks, that PC takes the pass as its own,
 * and doesn't run them.
 *
 * - Only a commit on one of the repository's own branches runs (the task's branch, else the employee's): never a
 *   fork's, nor anything a task names but the repository's own code. A task names a commit, never a command: the
 *   commands are this PC's Settings for that employee.
 * - One at a time, and never for a repository a stage holds now: a round holds an employee's repository while it waits
 *   for its turn, and that very task may be its own. A stage that takes the repository meanwhile keeps it, and the task
 *   goes back to the Seneschal unstarted.
 * - A shard of another PC's whole suite (wholesuite.ts) runs only its part of the test files (bump.ts's shardSteps),
 *   dealt from the same commit as that PC deals them.
 * - A kit trial (Seneschal 0.2.3) names its kit as a trial here names it (stages/seneschal.ts' kitIdOf: its version and
 *   12 digits of the Steward's commit it's made from) and its agent. That commit is fetched from the Steward's origin,
 *   and the kit made from it only when it's on one of the Steward's own branches: a worktree of the Steward's clone,
 *   named again by kitIdOf to be the very kit the PC that asked tried. The agent is tried with it as a trial here tries
 *   it: its main's commit bumped to the kit (bump.ts' bumpOne, as trial.ts' tryEach: kit.json, the kit's tools/kit.ts,
 *   its version and changelog entry, and only the tests the kit's files reach when the task says so); or a PR of its that
 *   pins the kit (the task's `pr`), at its head as it is (trial.ts' tryPair). Its checks run once: the PC that asked
 *   weighs a failure as it does its own trial's.
 * - A run is stopped after OTHERS_LIMIT_MS, and one that couldn't finish (stopped, packages held, Windows ended it) is
 *   reported as such: the Seneschal tries it again, and passes this PC over for that kind a while.
 */

export const OTHERS_KINDS: SeneschalKind[] = ['pr-check', 'kit-trial', 'full-suite'];
/** A run of the checks for another PC is stopped after this long. */
export const OTHERS_LIMIT_MS = 90 * 60_000;
/** How long the worker waits for an employee's repository a stage took just now, before the task goes back. */
const REPO_WAIT_MS = 5_000;
/** How long it waits before it asks again when there's no Seneschal on this PC. */
export const NO_SENESCHAL_MS = 5 * 60_000;

/** The worktree a task for the Seneschal runs in: one per employee, beside its PR test's. */
export const othersDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-others`);
/** The Steward's worktree a kit under trial is made in for another PC's trial: beside its own trials' (trial.ts' kitTrialDirOf). */
export const othersKitDirOf = (s: Settings) => path.join(workRootOf(s), `_${APP.id}-kit-others`);

/**
 * The employees whose checks it can run for the Seneschal: the Steward's own repository too, each with checks in Settings
 * and its clone on this PC.
 */
export function workersFor(s: Settings): Employee[] {
  const self = selfFor(s);
  const all = [...s.employees, ...(self && !s.employees.some((e) => e.repo.toLowerCase() === self.repo.toLowerCase()) ? [self] : [])];
  return all.filter((e) => e.repo && e.test.length && existsSync(path.join(checkoutOf(e), '.git')));
}

/** The Steward's own clone, which a kit under trial for another PC is made from; null when it isn't on this PC. */
export function kitSourceOf(s: Settings): Employee | null {
  const self = selfFor(s);
  return self && existsSync(path.join(checkoutOf(self), '.git')) ? self : null;
}

/** The kinds it asks for: a kit trial only while the Steward's own clone is on this PC and no stage holds it. */
export function kindsFor(s: Settings): SeneschalKind[] {
  const steward = kitSourceOf(s);
  return OTHERS_KINDS.filter((k) => k !== 'kit-trial' || (!!steward && !repoBusy(steward.id)));
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

/** A kit under trial as the Seneschal names it (kitIdOf): its version and 12 hex digits of the Steward's commit. Pure. */
export function kitCommitOf(kit: string): { version: string; commit: string } | null {
  const m = /^(\d+\.\d+\.\d+)-([0-9a-f]{12})$/.exec(kit);
  return m ? { version: m[1], commit: m[2] } : null;
}

/**
 * Fetches every branch of the Steward's origin into its clone `repo`, and finds there the commit the kit under trial
 * `kit` names: its full id, or why it may not be tried (it names none, the repository hasn't it, or it's on none of the
 * Steward's own branches: a fork's PR, say, or a head pushed over since).
 */
export async function fetchKit(ctx: Pick<Ctx, 'run'>, repo: string, kit: string): Promise<{ commit: string } | { not: string }> {
  const named = kitCommitOf(kit);
  if (!named) return { not: `kit ${kit} names no commit of the Steward's: only a kit under trial made from one of its branches is tried for another PC` };
  // A fetch that fails leaves the branches as they were last fetched: the commit is still looked for on them.
  await gitMaybe(ctx.run, repo, 'fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  const commit = (await gitMaybe(ctx.run, repo, 'rev-parse', '--verify', '--quiet', `${named.commit}^{commit}`))?.trim();
  if (!commit) return { not: `kit ${kit}: the Steward's repository has no commit ${named.commit}` };
  const on = await gitMaybe(ctx.run, repo, 'for-each-ref', '--count=1', '--contains', commit, '--format=%(refname)', 'refs/remotes/origin/');
  if (!on?.trim()) return { not: `kit ${kit}: ${named.commit.slice(0, 7)} isn't on any branch of the Steward's origin: only a kit made from one of the Steward's own branches is tried for another PC` };
  return { commit };
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

/** A task as the worker runs it: the job, its employee, the context, and its log line. */
interface Held {
  ctx: Ctx;
  e: Employee;
  job: SeneschalJob;
  line: (s: string) => void;
  /** "DESKTOP's", or "this PC's": whose Seneschal asked. */
  whose: string;
}

/** The time limit of a run for the Seneschal. */
const LIMIT = { ms: OTHERS_LIMIT_MS, why: `${OTHERS_LIMIT_MS / 60_000} minutes, the most a run for the Seneschal takes here` };

/** A task that couldn't run here, reported so (the Seneschal tries it again, and passes this PC over for its kind a while). */
async function couldnt(h: Held, not: string): Promise<OthersRound> {
  h.line(not);
  await h.job.turn.hold(async () => null, () => ({ ok: false, error: true, note: not }));
  return { ran: h.job.id, why: not, retryMs: SENESCHAL_IDLE_MS };
}

/** A task handed back unstarted: a stage holds a clone it needs. */
async function givenBack(h: Held, note: string): Promise<OthersRound> {
  await h.job.turn.giveBack(note);
  return { ran: null, why: `handed ${h.job.what} back: ${note}`, retryMs: SENESCHAL_IDLE_MS };
}

/**
 * One ask of the Seneschal for a task this Steward may run (the repositories in `settings`), and the run of the one it
 * hands out, in the context `ctxOf` makes once there is one. `ask` is the tests' (the kit's seneschalWork).
 */
export async function workForOthers(o: { settings: Settings; ctxOf: () => Promise<Ctx>; say: (line: string) => void; ask?: typeof seneschalWork }): Promise<OthersRound> {
  const say = o.say;
  const free = workersFor(o.settings).filter((e) => !repoBusy(e.id));
  const got = await (o.ask ?? seneschalWork)({ worker: APP.id, kinds: kindsFor(o.settings), repos: [...new Set(free.map((e) => e.repo))], slot: 'others', say: (line) => say(`the Seneschal: ${line}`) });
  if (!got) return { ran: null, why: 'no Seneschal on this PC', retryMs: NO_SENESCHAL_MS };
  if ('idle' in got) return { ran: null, why: got.idle, retryMs: got.retryMs };
  const job = got.job;
  const whose = job.from ? `${job.from.pc.name}'s` : "this PC's";
  const trial = job.kind === 'kit-trial';
  // A kit trial's agent by its id, and the repository it's of.
  const e = free.find((x) => x.repo.toLowerCase() === job.repo.toLowerCase() && (!trial || x.id === job.agent));
  if (!e) {
    await job.turn.giveBack(`the Steward here doesn't run ${trial ? `${job.agent}'s` : `${job.repo}'s`} checks now`);
    return { ran: null, why: `handed ${job.what} back: no employee of ${job.repo} free here`, retryMs: SENESCHAL_IDLE_MS };
  }
  const steward = trial ? kitSourceOf(o.settings) : null;
  if (trial && !steward) {
    await job.turn.giveBack("the Steward's own clone isn't on this PC, to make the kit under trial from");
    return { ran: null, why: `handed ${job.what} back: no clone of the Steward's here`, retryMs: SENESCHAL_IDLE_MS };
  }
  const ctx = await o.ctxOf();
  const tag = `[${e.id}] for ${whose} Seneschal (${job.id}${job.from ? `, ${job.from.id} there` : ''})`;
  const h: Held = { ctx, e, job, whose, line: (s: string) => say(`${tag}: ${s}`) };
  h.line(`${job.what}, at ${job.commit.slice(0, 7)}${trial ? `, with kit ${job.kit}` : ''}`);
  return steward ? kitTrialFor(h, steward) : checksFor(h, {});
}

/**
 * The employee's checks at the job's commit, in its worktree for the Seneschal (othersDirOf), as its PR test runs them:
 * the commit fetched and the worktree made while holding its clone a moment, the checks apart. `env`: a kit under
 * trial's (STEWARD_KIT), for a PR of its that pins the kit.
 */
async function checksFor(h: Held, env: Record<string, string>): Promise<OthersRound> {
  const { ctx, e, job, line, whose } = h;
  const repo = checkoutOf(e);
  const dir = othersDirOf(ctx.settings, e);
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
    if (err instanceof LockTimeout) return givenBack(h, `${e.name}'s clone is in use here`);
    not = `its worktree couldn't be made: ${(err as Error).message}`;
  }
  if (not) return couldnt(h, not);
  const seen: FailedChecks = {};
  // Only the tests the change reaches, against the base the task names; one shard of the whole suite; else all of it.
  const scope = job.shard ? { shard: job.shard } : job.base ? { affected: { base: job.base } } : {};
  try {
    const failed = await apart('checks for the Seneschal', () =>
      whileAwake(
        `${e.name}'s checks for ${whose} Seneschal`,
        () => job.turn.hold(
          () => checksIn(ctx, e, dir, { say: line, ...scope, ...(Object.keys(env).length ? { env } : {}), doing: job.what, timeLimit: () => LIMIT, failed: seen }, true),
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

/**
 * A kit trial for the Seneschal: the kit under trial made from the Steward's commit its kit names (holding the
 * Steward's clone a moment), then the agent tried with it, its PR as it is or its main bumped to the kit, and the kit's
 * worktree removed after.
 */
async function kitTrialFor(h: Held, steward: Employee): Promise<OthersRound> {
  const { ctx, e, job, line } = h;
  if (!e.usesKit) return couldnt(h, `${e.name} is ${NOT_ON_KIT}: no kit to try with it`);
  const kitRepo = checkoutOf(steward);
  const kitDir = othersKitDirOf(ctx.settings);
  let made: { commit: string } | { not: string };
  try {
    made = await withRepo(
      line,
      steward.id,
      async () => {
        const found = await fetchKit(ctx, kitRepo, job.kit!);
        if ('not' in found) return found;
        await removeWorktree(ctx.run, kitRepo, kitDir);
        await freshWorktree(ctx.run, ctx.settings, kitRepo, kitDir, found.commit, '--detach');
        // Named as a trial here names its kit, so it's the very code the PC that asked tried.
        const id = await kitIdOf(ctx, path.join(kitDir, 'kit'));
        return id === job.kit ? found : { not: `the Steward's ${found.commit.slice(0, 7)} makes kit ${id ?? "that couldn't be named"}, not ${job.kit}` };
      },
      { waitMs: REPO_WAIT_MS },
    );
  } catch (err) {
    if (err instanceof LockTimeout) return givenBack(h, "the Steward's clone is in use here");
    made = { not: `the kit under trial couldn't be made: ${(err as Error).message}` };
  }
  try {
    if ('not' in made) return await couldnt(h, made.not);
    line(`kit ${job.kit} made from the Steward's ${made.commit.slice(0, 7)}`);
    // An agent's PR that pins the kit, at its head as it is (tryPair); else its main bumped to the kit (tryEach).
    return job.pr ? await checksFor(h, { STEWARD_KIT: path.resolve(kitDir, 'kit') }) : await bumpedFor(h, { repo: kitRepo, dir: kitDir, commit: made.commit });
  } finally {
    try {
      await withRepo(line, steward.id, () => removeWorktree(ctx.run, kitRepo, kitDir), { waitMs: 60_000 });
    } catch (err) {
      line(`couldn't remove ${kitDir}: ${(err as Error).message}`);
    }
  }
}

/**
 * The agent's main at the job's commit bumped to the kit under trial and its checks run, as a trial here bumps it
 * (bumpOne's trial, from tryEach): holding its clone all the while, as a trial does, since the trial's worktree and
 * branch are the ones a trial here would make. Only the tests the kit's files reach when the task has a base, as the PC
 * that asked worked them out (kitreach.ts); else all of them. Its checks run once, under the task's lease.
 */
async function bumpedFor(h: Held, kit: { repo: string; dir: string; commit: string }): Promise<OthersRound> {
  const { ctx, e, job, line, whose } = h;
  const repo = checkoutOf(e);
  const version = kitCommitOf(job.kit!)!.version;
  const changelogFile = path.join(kit.dir, 'kit', 'CHANGELOG.md');
  const seen: FailedChecks = {};
  let held = false;
  try {
    const r = await apart('checks for the Seneschal', () =>
      withRepo(
        line,
        e.id,
        async () => {
          const off = await fetchJob(ctx, e, repo, job);
          if (off) return off;
          try {
            return await whileAwake(
              `${e.name}'s kit trial for ${whose} Seneschal`,
              () =>
                bumpOne(ctx, e, {
                  kit: version,
                  base: job.commit,
                  kitFrom: path.join(kit.dir, 'kit'),
                  tool: path.join(kit.dir, 'tools', 'kit.ts'),
                  trial: true,
                  changelog: existsSync(changelogFile) ? readFileSync(changelogFile, 'utf8') : null,
                  ...(job.base ? { reach: (_e: Employee, pin: { kit: string; parts: string[] | null }, toolChanged: boolean) => kitReach(ctx, { repo: kit.repo, head: kit.commit, pin, toolChanged }) } : {}),
                  checks: (dir, c) => {
                    held = true;
                    return job.turn.hold(() => checksIn(ctx, e, dir, { ...c, say: line, timeLimit: () => LIMIT, failed: seen }, true), (f) => outcomeOf(f, seen, e.test));
                  },
                }),
              ctx.log,
            );
          } finally {
            try {
              await removeWorktree(ctx.run, repo, trialDirOf(ctx.settings, e), trialBranch(version));
            } catch (err) {
              line(`couldn't remove its trial: ${(err as Error).message}`);
            }
          }
        },
        { waitMs: REPO_WAIT_MS },
      ),
    );
    // Not tried here (its commit isn't on its branch, it's on that kit already, the kit changes nothing it takes): the
    // PC that asked tried what this one can't, so the run couldn't happen here.
    if (typeof r === 'string') return await couldnt(h, r);
    if (!held) return await couldnt(h, `not tried here: ${r.message}`);
    const why = r.outcome === 'done' ? 'passed' : `failed: ${r.message}`;
    line(why);
    return { ran: job.id, why, retryMs: 0 };
  } catch (err) {
    if (err instanceof LockTimeout && !held) return givenBack(h, `${e.name}'s clone is in use here`);
    const why = `couldn't run: ${(err as Error).message}`;
    // hold reported it as a run that couldn't finish once it began; before, it's reported here.
    if (!held) return couldnt(h, why);
    line(why);
    return { ran: job.id, why, retryMs: SENESCHAL_IDLE_MS };
  }
}
