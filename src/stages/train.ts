import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aheadOf, fetchBranch, git, gitMaybe, removeWorktree } from '../git.ts';
import { compareVersions } from '../kitfiles.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee, Settings } from '../settings.ts';
import { noteMerged } from '../strangers.ts';
import { recordTested } from '../tested.ts';
import { runChecks } from './bump.ts';
import { isChangelog, isKitPin, lockBeside, mergeChangelogs, mergeKitPins, resolveVersionConflicts, settledFiles, settleVersion } from './catchup.ts';
import { checkoutOf, forgetGlance, workRootOf, type Ctx } from './common.ts';
import { kitReleaseHold } from './prtest.ts';
import type { PrInfo } from './staff.ts';
import { raisesKit } from './trial.ts';
import { isWrightPr } from './vouch.ts';
import { ownerFirstHold } from '../review.ts';

/**
 * A merge train (Settings' mergeTrain): a repository's ready PRs that wait their turn in the version queue, merged
 * together, tested once, where one at a time each was caught up after the one under it merged and tested again at its
 * new head.
 *
 * The cars are the queue's PRs from its lowest version up, while each can ride (canRide: the team's, from the repository
 * itself, ready, no checks on GitHub, no steps after merging, not the Wright's, not one that raises the kit, not one that
 * waits for the owner first: review.ts's ownerFirstHold), each above
 * the one under it; the train stops at the first that can't, so a draft still holds its place. In a worktree of the
 * Steward's, each car's head has the stack under it merged in (the employee's branch under the first), its version lines
 * and changelog settled as a catch-up settles them (stages/catchup.ts): the car's own version, its own entry above the
 * entries under it. A car that conflicts beyond those ends the train there, and goes its own way as before.
 *
 * The repository's checks then run once, at the top. Once they pass, the top is pushed to the top car's branch (a fast
 * forward: nothing of the PR's is rewritten) and that PR is merged, at that commit, the usual way: never a push to the
 * branch itself. Every car under it is in the branch then, and GitHub marks its PR merged; one it doesn't is closed with
 * a comment saying which PR brought it in. Each car keeps its version and its changelog entry; the round's release is of
 * the top version.
 *
 * A train whose checks fail is kept (trains.json) so it isn't built again until something in it moves (the branch, a
 * car's head): the PRs merge one at a time meanwhile, as without trains.
 */

export interface Car {
  pr: PrInfo;
  /** The version it sets, from the version queue. */
  version: string;
}

/** Whether a PR can ride in a train. Pure. */
export const canRide = (pr: PrInfo, branch: string) =>
  pr.whose === 'team' && !pr.fork && !pr.draft && pr.base === branch && !pr.afterError && !pr.after && pr.checks === 'none' && pr.mergeState !== 'BLOCKED' && !!pr.headOid && !raisesKit(pr) && !isWrightPr(pr) && !ownerFirstHold(pr);

/**
 * The train the version queue (`pending`: each PR's version, merge.ts's pendingVersions) makes: its PRs from the lowest
 * version up while each can ride and sets a version above the one under it. None unless two or more. Pure.
 */
export function trainCars(prs: PrInfo[], pending: Map<number, string>, branch: string): Car[] {
  const queue = [...pending].sort((a, b) => compareVersions(a[1], b[1]) || a[0] - b[0]);
  const cars: Car[] = [];
  for (const [n, version] of queue) {
    const pr = prs.find((p) => p.number === n);
    if (!pr || !canRide(pr, branch)) break;
    if (cars.length && compareVersions(version, cars.at(-1)!.version) <= 0) break;
    cars.push({ pr, version });
  }
  return cars.length > 1 ? cars : [];
}

export const trainDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-train`);

/** The trains whose checks failed, by employee id: the branch and heads they were built from, and what failed. */
export const trainsFile = () => dataFile('trains.json');
type Failed = Record<string, { key: string; note: string; at: string }>;

/** A train as it was built: the branch's commit under it and each car's head. */
export const trainKey = (base: string, cars: Car[]) => [base, ...cars.map((c) => `${c.pr.number}@${c.pr.headOid}`)].join(' ');

export interface TrainRun {
  /** The PRs it merged, lowest first: none when it didn't. */
  merged: PrInfo[];
  /** What it did, or why not. */
  note: string;
  /** It got as far as testing the stack (so a failure is worth a line in the round). */
  tested: boolean;
}

/** How long it waits before each time it asks again, for GitHub to take in a push (the merge) or a merge (the cars under it). */
export const TRAIN_WAITS_MS = [3_000, 7_000, 15_000];

/**
 * One car's head, checked out in `dir`, with `under` (the stack so far, or the branch) merged in and its version settled:
 * null once it is, else why it can't ride.
 */
async function stackOn(ctx: Ctx, e: Employee, dir: string, under: string, label: string, car: Car): Promise<string | null> {
  const { run } = ctx;
  if (await aheadOf(run, dir, under, 'HEAD')) {
    const m = await run('git', ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', '-m', `Merge ${label} into ${car.pr.head}: stacked by the Steward`, under], { cwd: dir, timeoutMs: 5 * 60_000 });
    if (m.code !== 0) {
      const conflicted = (await gitMaybe(run, dir, 'diff', '--name-only', '--diff-filter=U'))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
      const versionFiles = new Set([...e.versionFiles, ...lockBeside(e.versionFiles)].map((f) => f.replace(/\\/g, '/').toLowerCase()));
      const others = conflicted.filter((f) => !versionFiles.has(f.replace(/\\/g, '/').toLowerCase()) && !isChangelog(f) && !isKitPin(f));
      let why = !conflicted.length ? `merging ${label} into it failed: ${(m.err || m.out).trim().split('\n').pop()}` : others.length ? `it conflicts with ${label} in ${others.join(', ')}` : null;
      if (!why) {
        for (const f of conflicted) {
          const side = async (n: number) => (await gitMaybe(run, dir, 'show', `:${n}:${f}`)) ?? '';
          const fixed = isChangelog(f)
            ? mergeChangelogs(await side(1), await side(2), await side(3), car.version)
            : isKitPin(f)
              ? mergeKitPins(await side(1), await side(2), await side(3))
              : resolveVersionConflicts(readFileSync(path.join(dir, f), 'utf8'));
          if (fixed === null) {
            why = `it conflicts with ${label} in ${f} beyond ${isChangelog(f) ? 'a new entry at its top' : isKitPin(f) ? 'its kit and parts' : 'its version'}`;
            break;
          }
          writeFileSync(path.join(dir, f), fixed);
        }
      }
      if (why) {
        await gitMaybe(run, dir, 'merge', '--abort');
        return why;
      }
      const lockToo = lockBeside(e.versionFiles).filter((f) => conflicted.some((x) => x.replace(/\\/g, '/').toLowerCase() === f.toLowerCase()));
      settleVersion(dir, [...e.versionFiles, ...lockToo], car.version);
      await git(run, dir, 'add', '--', ...conflicted, ...e.versionFiles);
      await git(run, dir, 'commit', '--quiet', '--no-edit');
    }
  }
  // Its own version in every version file, whatever a merge without conflicts left there.
  const changed = settleVersion(dir, settledFiles(dir, e.versionFiles), car.version);
  if (changed.length) {
    await git(run, dir, 'add', '--', ...changed);
    await git(run, dir, 'commit', '--quiet', '-m', `${e.name} ${car.version}: its own version, stacked on ${label}`);
  }
  return null;
}

/** The train run: built, tested once, and merged through its top PR, as the module's comment says. Never merges what it didn't test. */
export async function runTrain(ctx: Ctx, e: Employee, cars: Car[]): Promise<TrainRun> {
  const { run } = ctx;
  const pause = ctx.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return { merged: [], note: `there's no checkout at ${repo}`, tested: false };
  await fetchBranch(run, repo, e.branch);
  const base = (await git(run, repo, 'rev-parse', `origin/${e.branch}`)).trim();
  // Each car as this round listed it, and with its kit released: the train stops at the first that isn't.
  const listed: Car[] = [];
  for (const c of cars) {
    try {
      await fetchBranch(run, repo, c.pr.head);
    } catch {
      break;
    }
    if ((await git(run, repo, 'rev-parse', `origin/${c.pr.head}`)).trim() !== c.pr.headOid) break;
    if (await kitReleaseHold(ctx, e, c.pr).catch(() => null)) break;
    listed.push(c);
  }
  if (listed.length < 2) return { merged: [], note: 'fewer than two of its PRs can ride as they are now', tested: false };
  const failed = readJson<Failed>(trainsFile(), {});
  const failedBefore = (cars: Car[]) => (failed[e.id]?.key === trainKey(base, cars) ? failed[e.id].note : null);
  if (failedBefore(listed)) return { merged: [], note: `the same train failed before: ${failedBefore(listed)}`, tested: false };

  const dir = trainDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, base);
  try {
    const rode: Car[] = [];
    let under = base;
    let label = e.branch;
    let stopped = '';
    for (const c of listed) {
      await git(run, dir, 'checkout', '--quiet', '--detach', c.pr.headOid);
      const why = await stackOn(ctx, e, dir, under, label, c);
      if (why) {
        stopped = `; #${c.pr.number} goes its own way: ${why}`;
        break;
      }
      rode.push(c);
      under = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
      label = `#${c.pr.number}`;
    }
    const numbers = rode.map((c) => `#${c.pr.number}`).join(', ');
    if (rode.length < 2) return { merged: [], note: `no train: fewer than two of its PRs stack${stopped}`, tested: false };
    if (failedBefore(rode)) return { merged: [], note: `the same train failed before: ${failedBefore(rode)}`, tested: false };
    const top = rode.at(-1)!;
    const at = under;
    // The stack's top, whatever a car that couldn't ride left checked out: what is tested is what is pushed.
    await git(run, dir, 'checkout', '--quiet', '--detach', at);
    ctx.log(`[${e.id}] a train of ${numbers} (v${rode[0].version} to v${top.version}) stacked at ${at.slice(0, 7)}: its checks, once${stopped}`);
    const say = (line: string) => ctx.log(`[${e.id}] train: ${line}`);
    // Once more on a failure, as a PR tested here is (prtest.ts): a flaky test doesn't break up a train.
    let checks = await runChecks(ctx, e, dir, { say });
    if (checks) {
      say(`its checks once more (${checks})`);
      checks = await runChecks(ctx, e, dir, { say });
    }
    if (checks) {
      failed[e.id] = { key: trainKey(base, rode), note: checks, at: new Date().toISOString() };
      writeJson(trainsFile(), failed);
      return { merged: [], note: `${numbers} stacked, but ${checks}: they merge one at a time${stopped}`, tested: true };
    }
    // Another PC's turn here now (lease.ts): it merges them.
    if (ctx.lease && !(await ctx.lease.ok(e))) return { merged: [], note: `${numbers} stacked and passed, but another PC publishes ${e.name} now`, tested: true };
    // The top PR's branch moves on to the stack (never forced: it is on top of its head), and that PR merges at it.
    const pushed = await run('git', ['push', '--quiet', 'origin', `${at}:refs/heads/${top.pr.head}`], { cwd: dir, timeoutMs: 5 * 60_000 });
    if (pushed.code !== 0) return { merged: [], note: `${numbers} stacked and passed, but the stack couldn't be pushed to ${top.pr.head}: ${(pushed.err || pushed.out).trim().split('\n').pop()}`, tested: true };
    let merge = await run('gh', ['pr', 'merge', String(top.pr.number), '--repo', e.repo, '--merge', '--match-head-commit', at], { cwd: ctx.neutralDir, timeoutMs: 5 * 60_000 });
    for (const ms of TRAIN_WAITS_MS) {
      if (merge.code === 0) break;
      await pause(ms);
      merge = await run('gh', ['pr', 'merge', String(top.pr.number), '--repo', e.repo, '--merge', '--match-head-commit', at], { cwd: ctx.neutralDir, timeoutMs: 5 * 60_000 });
    }
    forgetGlance(ctx, e);
    if (merge.code !== 0) {
      const why = (merge.err || merge.out).trim().split('\n').pop();
      await run('gh', ['pr', 'comment', String(top.pr.number), '--repo', e.repo, '--body', `The Steward stacked ${numbers} on \`${e.branch}\` here (checks passed at ${at.slice(0, 7)}), but couldn't merge it: ${why}. The PRs under it are in this branch now, so it brings them in when it merges.`], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
      return { merged: [], note: `${numbers} stacked and passed, pushed to ${top.pr.head}, but #${top.pr.number} couldn't be merged: ${why}`, tested: true };
    }
    delete failed[e.id];
    writeJson(trainsFile(), failed);
    for (const c of rode) noteMerged(e, c.pr.number);
    // Passed here before it merged: the Surveyor's GET /api/tested (tested.ts).
    recordTested(e.id, { commit: at, stage: 'merge', branch: top.pr.head, pr: top.pr.number, version: top.version });
    const words = `stacked on ${e.branch} lowest version first and tested once, at ${at.slice(0, 7)}`;
    await run('gh', ['pr', 'comment', String(top.pr.number), '--repo', e.repo, '--body', `Merged by the Steward as one train with ${rode.slice(0, -1).map((c) => `#${c.pr.number}`).join(', ')}: ${words}. Each keeps its own version and changelog entry.`], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
    // The cars under it are in the branch now: GitHub marks each merged, once it has taken the merge in.
    for (const c of rode.slice(0, -1)) {
      let state = '';
      for (const ms of [0, ...TRAIN_WAITS_MS]) {
        if (ms) await pause(ms);
        const v = await run('gh', ['pr', 'view', String(c.pr.number), '--repo', e.repo, '--json', 'state'], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
        try {
          state = String(JSON.parse(v.out).state ?? '');
        } catch {
          state = '';
        }
        if (state === 'MERGED' || state === 'CLOSED') break;
      }
      const body = `Merged by the Steward in one train with #${top.pr.number}: ${words}. Its commits are in \`${e.branch}\`.`;
      if (state === 'MERGED') await run('gh', ['pr', 'comment', String(c.pr.number), '--repo', e.repo, '--body', body], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
      else if (state === 'OPEN' || state === '') await run('gh', ['pr', 'close', String(c.pr.number), '--repo', e.repo, '--comment', `${body} GitHub didn't mark it merged, so the Steward closed it.`], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
    }
    ctx.log(`[${e.id}] merged ${numbers} as one train through #${top.pr.number} (${words})`);
    return { merged: rode.map((c) => c.pr), note: `${words}${stopped}`, tested: true };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
