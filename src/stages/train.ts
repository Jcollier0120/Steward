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
import { checkoutOf, forgetGlance, freshWorktree, interrupted, workRootOf, type Ctx } from './common.ts';
import { kitReleaseHold } from './prtest.ts';
import { checksOf, type PrInfo } from './staff.ts';
import { raisesKit } from './trial.ts';
import { isWrightPr } from './vouch.ts';
import { ownerFirstHold } from '../review.ts';
import { changeFiles, KIT_CHANGES_DIR } from '../entries.ts';
import { hostFor } from '../hosts/index.ts';

/**
 * A merge train (Settings' mergeTrain): a repository's ready PRs that wait their turn in the version queue, merged
 * together, tested once, where one at a time each was caught up after the one under it merged and tested again at its
 * new head.
 *
 * The cars are the queue's PRs from its lowest version up, while each can ride (canRide: the team's, from the repository
 * itself, ready, no checks on GitHub failing, no steps after merging, not the Wright's, not one that raises the kit, not one that
 * waits for the owner first: review.ts's ownerFirstHold, not one written as changes/<version>.md, which merges alone
 * once stamped: stages/stamp.ts), each above
 * the one under it; the train stops at the first that can't, so a draft still holds its place. In a worktree of the
 * Steward's, each car's head has the stack under it merged in (the employee's branch under the first), its version lines
 * and changelog settled as a catch-up settles them (stages/catchup.ts): the car's own version, its own entry above the
 * entries under it. A car that conflicts beyond those ends the train there, and goes its own way as before.
 *
 * The repository's checks then run once, at the top. Once they pass, the top is pushed to the top car's branch (a fast
 * forward: nothing of the PR's is rewritten) and that PR is merged, at that commit, the usual way: never a push to the
 * branch itself. Where the cars have checks on GitHub (a site's preview build, say), they run once more at the top, on
 * the whole stack, and the train waits for them (TRAIN_CHECKS_MS) before it merges: one wait for the train, where one at a
 * time each PR waited for its own after each catch-up. Still running then, the cars wait for them as one train, and the
 * next round, finding the stack already on the top PR's branch and passed here, merges it once they pass. Every car under it is in the branch then, and GitHub marks its PR merged; one it doesn't is closed with
 * a comment saying which PR brought it in. Each car keeps its version and its changelog entry; the round's release is of
 * the top version.
 *
 * A train whose checks fail, here or on GitHub, is kept (trains.json) so it isn't built again until something in it moves
 * (the branch, a car's head): the PRs merge one at a time meanwhile, as without trains.
 */

export interface Car {
  pr: PrInfo;
  /** The version it sets, from the version queue. */
  version: string;
}

/** A PR written as changes/<version>.md (entries.ts): stamped just before it merges, so it merges alone, untested again. */
const stamped = (pr: PrInfo) => changeFiles(pr.files).length > 0 || changeFiles(pr.files, KIT_CHANGES_DIR).length > 0;

/** Whether a PR can ride in a train. Pure. */
export const canRide = (pr: PrInfo, branch: string) =>
  pr.whose === 'team' && !pr.fork && !pr.draft && pr.base === branch && !pr.afterError && !pr.after && pr.checks !== 'failing' && (pr.mergeState !== 'BLOCKED' || pr.checks === 'pending') && !!pr.headOid && !raisesKit(pr) && !isWrightPr(pr) && !ownerFirstHold(pr) && !stamped(pr);

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
type Failed = Record<string, { key: string; note: string; at: string; stack?: string }>;

/** The stack each employee's last train passed its checks here at, by employee id: not tested again while it waits for GitHub's. */
export const trainsPassedFile = () => dataFile('trains-passed.json');

/** A train as it was built: the branch's commit under it and each car's head. */
export const trainKey = (base: string, cars: Car[]) => [base, ...cars.map((c) => `${c.pr.number}@${c.pr.headOid}`)].join(' ');

export interface TrainRun {
  /** The PRs it merged, lowest first: none when it didn't. */
  merged: PrInfo[];
  /** What it did, or why not. */
  note: string;
  /** It got as far as testing the stack (so a failure is worth a line in the round). */
  tested: boolean;
  /** Pushed to the top PR's branch, and waiting there for GitHub's checks: the cars wait as one train. */
  waiting?: boolean;
}

/** How long a pushed train waits for GitHub's checks at its top, asking every TRAIN_CHECK_EVERY_MS. */
export const TRAIN_CHECKS_MS = 10 * 60_000;
export const TRAIN_CHECK_EVERY_MS = 20_000;
/** GitHub may not have started the checks a push brings for a while: after this long with none, there are none. */
const NO_CHECKS_AFTER_MS = 2 * 60_000;

/**
 * GitHub's checks on PR `n` while its head is `at`: passing (or none at all), failing, still running once
 * TRAIN_CHECKS_MS is up, or its head moved on from `at`.
 */
async function checksAtTop(ctx: Ctx, e: Employee, n: number, at: string, pause: (ms: number) => Promise<void>): Promise<'passing' | 'failing' | 'pending' | 'moved'> {
  const host = hostFor(ctx, e);
  for (let waited = 0; ; waited += TRAIN_CHECK_EVERY_MS) {
    const v = await host.viewPr(e.repo, n, 'headRefOid,statusCheckRollup');
    let o: { headRefOid?: string; statusCheckRollup?: unknown } = {};
    try {
      o = JSON.parse(v.out);
    } catch {
      o = {};
    }
    if (o.headRefOid && o.headRefOid !== at) return 'moved';
    const c = v.code === 0 ? checksOf(o.statusCheckRollup) : 'pending';
    if (c === 'failing') return 'failing';
    if (c === 'passing' || (c === 'none' && waited >= NO_CHECKS_AFTER_MS)) return 'passing';
    if (waited >= TRAIN_CHECKS_MS) return 'pending';
    await pause(TRAIN_CHECK_EVERY_MS);
  }
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
    // The checks it waits for at the top are GitHub's: elsewhere, only cars without any ride.
    if (c.pr.checks !== 'none' && (ctx.host?.(e) ?? 'github') !== 'github') break;
    listed.push(c);
  }
  if (listed.length < 2) return { merged: [], note: 'fewer than two of its PRs can ride as they are now', tested: false };
  const failed = readJson<Failed>(trainsFile(), {});
  // A train whose checks Windows cut short (the PC shutting down) didn't fail: it is tried again.
  if (failed[e.id] && interrupted(failed[e.id].note)) delete failed[e.id];
  const failedBefore = (cars: Car[]) => (failed[e.id]?.key === trainKey(base, cars) ? failed[e.id].note : null);
  if (failedBefore(listed)) return { merged: [], note: `the same train failed before: ${failedBefore(listed)}`, tested: false };

  const dir = trainDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, base, '--detach');
  try {
    const rode: Car[] = [];
    let under = base;
    let label = e.branch;
    let stopped = '';
    const has = async (head: string, commit: string) => (await run('git', ['merge-base', '--is-ancestor', commit, head], { cwd: dir })).code === 0;
    for (const c of listed) {
      await git(run, dir, 'checkout', '--quiet', '--detach', c.pr.headOid);
      // A car whose head has the branch and every car under it already (a stack the Steward pushed to it, still waiting
      // for GitHub's checks, or a PR opened on top of the others): its head is the stack so far, as it is. Stacked again,
      // the merges under it would be new commits, which it would conflict with.
      let contains = rode.length > 0 && (await has(c.pr.headOid, base));
      for (const r of rode) contains = contains && (await has(c.pr.headOid, r.pr.headOid));
      const why = await stackOn(ctx, e, dir, contains ? c.pr.headOid : under, label, c);
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
    if (failed[e.id]?.stack === at) return { merged: [], note: `the same stack failed before: ${failed[e.id].note}`, tested: false };
    // Passed here already (a train still waiting for GitHub's checks at it): not tested again.
    const passed = readJson<Record<string, string>>(trainsPassedFile(), {});
    let checks: string | null = null;
    if (passed[e.id] === at) say(`its checks passed here at ${at.slice(0, 7)} already`);
    else {
      // Once more on a failure, as a PR tested here is (prtest.ts): a flaky test doesn't break up a train.
      checks = await runChecks(ctx, e, dir, { say });
      if (checks) {
        say(`its checks once more (${checks})`);
        checks = await runChecks(ctx, e, dir, { say });
      }
      if (!checks) writeJson(trainsPassedFile(), { ...passed, [e.id]: at });
    }
    if (checks && interrupted(checks)) return { merged: [], note: `${numbers} stacked, but Windows ended its checks (${checks}): the next round tries the train again${stopped}`, tested: false };
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
    const host = hostFor({ ...ctx, run }, e);
    // GitHub's checks, where the cars have any, run once more on the whole stack: it merges once they pass.
    if (rode.some((c) => c.pr.checks !== 'none')) {
      say(`pushed to ${top.pr.head}: waiting for its checks on GitHub at ${at.slice(0, 7)}`);
      const ci = await checksAtTop({ ...ctx, run }, e, top.pr.number, at, pause);
      forgetGlance(ctx, e);
      if (ci === 'pending') return { merged: [], note: `${numbers} stacked and passed here, and pushed to ${top.pr.head}: its checks on GitHub are still running at ${at.slice(0, 7)}, and it merges once they pass`, tested: true, waiting: true };
      if (ci === 'moved') return { merged: [], note: `${numbers} stacked and passed, but ${top.pr.head} moved on while its checks ran`, tested: true };
      if (ci === 'failing') {
        failed[e.id] = { key: trainKey(base, rode), note: `its checks on GitHub failed at ${at.slice(0, 7)}`, at: new Date().toISOString(), stack: at };
        writeJson(trainsFile(), failed);
        return { merged: [], note: `${numbers} stacked and passed here, but its checks on GitHub failed at ${at.slice(0, 7)}: they merge one at a time${stopped}`, tested: true };
      }
    }
    let merge = await host.mergePr(e.repo, top.pr.number, { matchHead: at });
    for (const ms of TRAIN_WAITS_MS) {
      if (merge.code === 0) break;
      await pause(ms);
      merge = await host.mergePr(e.repo, top.pr.number, { matchHead: at });
    }
    forgetGlance(ctx, e);
    if (merge.code !== 0) {
      const why = (merge.err || merge.out).trim().split('\n').pop();
      await host.commentPr(e.repo, top.pr.number, `The Steward stacked ${numbers} on \`${e.branch}\` here (checks passed at ${at.slice(0, 7)}), but couldn't merge it: ${why}. The PRs under it are in this branch now, so it brings them in when it merges.`);
      return { merged: [], note: `${numbers} stacked and passed, pushed to ${top.pr.head}, but #${top.pr.number} couldn't be merged: ${why}`, tested: true };
    }
    delete failed[e.id];
    writeJson(trainsFile(), failed);
    for (const c of rode) noteMerged(e, c.pr.number);
    // Passed here before it merged: the Surveyor's GET /api/tested (tested.ts).
    recordTested(e.id, { commit: at, stage: 'merge', branch: top.pr.head, pr: top.pr.number, version: top.version });
    const words = `stacked on ${e.branch} lowest version first and tested once, at ${at.slice(0, 7)}`;
    await host.commentPr(e.repo, top.pr.number, `Merged by the Steward as one train with ${rode.slice(0, -1).map((c) => `#${c.pr.number}`).join(', ')}: ${words}. Each keeps its own version and changelog entry.`);
    // The cars under it are in the branch now: GitHub marks each merged, once it has taken the merge in.
    for (const c of rode.slice(0, -1)) {
      let state = '';
      for (const ms of [0, ...TRAIN_WAITS_MS]) {
        if (ms) await pause(ms);
        const v = await host.viewPr(e.repo, c.pr.number, 'state');
        try {
          state = String(JSON.parse(v.out).state ?? '');
        } catch {
          state = '';
        }
        if (state === 'MERGED' || state === 'CLOSED') break;
      }
      const body = `Merged by the Steward in one train with #${top.pr.number}: ${words}. Its commits are in \`${e.branch}\`.`;
      if (state === 'MERGED') await host.commentPr(e.repo, c.pr.number, body);
      else if (state === 'OPEN' || state === '') await host.closePr(e.repo, c.pr.number, { comment: `${body} GitHub didn't mark it merged, so the Steward closed it.` });
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
