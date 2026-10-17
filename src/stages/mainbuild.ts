import { rmSync } from 'node:fs';
import path from 'node:path';
import { fetchFor, gitMaybe, removeWorktree } from '../git.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee, Settings } from '../settings.ts';
import { checksLogOf, runChecks, type AffectedScope, type FailedChecks } from './bump.ts';
import { checkoutOf, freshWorktree, hostIs, interrupted, workRootOf, type Ctx } from './common.ts';
import { setVouch, stoodInDescription, vouchDescription, vouchOn } from './vouch.ts';
import type { StoodIn } from './standin.ts';
import { recordTested } from '../tested.ts';
import { hostFor } from '../hosts/index.ts';
import { noteMerged } from '../strangers.ts';
import { headsMoved } from '../heads.ts';
import { treeOf, wholePassOf } from '../whole.ts';

/**
 * Builds release main (Steward 0.36.121). The Claude sessions and dev managers merge their own pull requests once they are
 * vouched for (`steward vouch`) and GitHub says they merge cleanly; the Steward no longer looks at them. At each build it
 * takes main's latest commit of each repository it looks after and, when that carries a version not released yet, tests
 * it once (mainGate) and releases it once (release.ts, which releases exactly the commit tested).
 *
 * The test is skipped when a vouch already covers that very commit (coveredBy): its own steward/tested status, set by a
 * team account, or, for a merge commit, a parent it brought in unchanged that has one (a PR merged while up to date with
 * main: the merge commit's tree is the PR head's). Else main's head is tested here, in a worktree of its own, against the
 * last release (only the tests the changes since reach, unless Settings say the whole suite), a failure once more, and a
 * pass gets the vouch on that commit, so neither the next build nor the Assayer runs it again. Kept by commit in
 * main-tested.json: a commit is tested once, whatever happens to its release after.
 *
 * What the Steward opens itself (a kit's rollout PRs, a stamp's) it merges itself, at once (mergeOwn): a bump's checks
 * ran before it was pushed, and a stamp changes only versions and changelogs.
 */

export const mainTestedFile = () => dataFile('main-tested.json');
export const mainDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-main`);

interface MainTested {
  ok: boolean;
  /** "checks passed here at abc1234", or what failed. */
  note: string;
  at: string;
}

const keyOf = (e: Employee, commit: string) => `${e.id}@${commit}`;

/**
 * Who vouched for `commit` of the employee's repository, in words, or null: a team account's steward/tested status on
 * it, or on a parent of a merge commit whose tree is the merge's own (one level). None over plain git, which has no
 * statuses to ask (and GitHub is never asked for it). Never throws.
 */
export async function coveredBy(ctx: Ctx, e: Employee, commit: string): Promise<string | null> {
  if (hostIs(ctx, e) === 'git') return null;
  const team = ctx.settings.team;
  const sha = commit.slice(0, 7);
  const direct = await vouchOn(ctx, e.repo, commit, team).catch(() => null);
  if (direct) return `${direct} vouched for ${sha}`;
  const repo = checkoutOf(e);
  const parents = (await gitMaybe(ctx.run, repo, 'rev-list', '--parents', '-n', '1', commit))?.trim().split(/\s+/).slice(1) ?? [];
  if (parents.length < 2) return null;
  const tree = (await gitMaybe(ctx.run, repo, 'rev-parse', `${commit}^{tree}`))?.trim();
  if (!tree) return null;
  for (const p of parents) {
    if ((await gitMaybe(ctx.run, repo, 'rev-parse', `${p}^{tree}`))?.trim() !== tree) continue;
    const by = await vouchOn(ctx, e.repo, p, team).catch(() => null);
    if (by) return `${by} vouched for ${p.slice(0, 7)}, which ${sha} merged unchanged`;
  }
  return null;
}

/**
 * The commit of the release before (its tag v<since>), fetched from origin, for the tests the changes since reach; null
 * when there's none, or it can't be fetched (then the whole suite runs).
 */
async function releasedCommit(ctx: Ctx, e: Employee, since: string | null): Promise<string | null> {
  if (!since) return null;
  const repo = checkoutOf(e);
  const tag = `refs/tags/v${since}`;
  if ((await gitMaybe(ctx.run, repo, 'fetch', '--quiet', 'origin', `+${tag}:${tag}`)) === null) return null;
  return (await gitMaybe(ctx.run, repo, 'rev-parse', '--verify', '--quiet', `${tag}^{commit}`))?.trim() || null;
}

/** main's head tested here, as the module's comment says: what passed, or what failed. */
async function testAt(ctx: Ctx, e: Employee, commit: string, since: string | null): Promise<MainTested> {
  const now = () => new Date().toISOString();
  if (!e.test.length) return { ok: false, note: `Settings give ${e.name} no checks to test main with`, at: now() };
  const { run } = ctx;
  const repo = checkoutOf(e);
  const sha = commit.slice(0, 7);
  await fetchFor(run, repo, commit, `+refs/heads/${e.branch}:refs/remotes/origin/${e.branch}`);
  const base = ctx.settings.affectedTests === false ? null : await releasedCommit(ctx, e, since);
  const dir = mainDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  rmSync(checksLogOf(dir), { force: true });
  await freshWorktree(run, ctx.settings, repo, dir, commit, '--detach');
  ctx.log(`[${e.id}] testing ${e.branch} at ${sha} before its release, in ${dir}${base ? `: the tests the changes since v${since} reach` : ''}`);
  try {
    const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
    const scope: AffectedScope | undefined = base ? { base } : undefined;
    const affected = scope ? { affected: scope } : {};
    const stoodIn: StoodIn = {};
    const seen: FailedChecks = {};
    const task = { branch: e.branch };
    const doing = `${e.branch}'s checks at ${sha}`;
    const passed = async (note: string, description: string): Promise<MainTested> => {
      // Over plain git there's no status to set: the pass is kept here (main-tested.json) alone.
      const refused = hostIs(ctx, e) === 'git' ? null : await setVouch(ctx, e, e.repo, commit, description);
      if (refused) say(refused);
      return { ok: true, note, at: now() };
    };
    const failed = await runChecks(ctx, e, dir, { say, ...affected, doing, stoodIn, task, failed: seen, elsewhere: true });
    if (!failed && stoodIn.by) return passed(`checks passed ${stoodIn.where} at ${sha}, not run again`, stoodInDescription(e, stoodIn, commit));
    const which = scope?.chose && scope.chose !== 'the whole suite' ? ` (${scope.chose})` : '';
    if (!failed) return passed(`checks passed here at ${sha}${which}`, vouchDescription(e, scope, commit, " in the Steward's build"));
    if (seen.confirmed) return { ok: false, note: `its checks failed at ${sha}: ${failed}`, at: now() };
    say(`${e.branch} at ${sha}: its checks once more (${failed})`);
    const again = await runChecks(ctx, e, dir, { say, ...affected, doing, task });
    return again ? { ok: false, note: `its checks failed here at ${sha}, twice: ${again}`, at: now() } : passed(`checks passed here at ${sha} on a second try (the first: ${failed})`, vouchDescription(e, scope, commit, " in the Steward's build"));
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * Whether main's head may be released: null when it may (a vouch covers it, its whole suite passed here at its code, or
 * its checks pass here now, once), else why not, as a failed release says it. `since`: the version released before.
 */
export async function mainGate(ctx: Ctx, e: Employee, commit: string, since: string | null): Promise<string | null> {
  const sha = commit.slice(0, 7);
  const kept = readJson<Record<string, MainTested>>(mainTestedFile(), {});
  const before = kept[keyOf(e, commit)];
  if (before) return before.ok ? null : `${before.note} (tested before its release; a new commit on ${e.branch} is tested afresh)`;
  const covered = await coveredBy(ctx, e, commit);
  if (covered) {
    ctx.log(`[${e.id}] ${covered}: not tested again before its release`);
    return null;
  }
  const whole = wholePassOf(await treeOf(ctx.run, checkoutOf(e), commit).catch(() => null));
  if (whole) {
    ctx.log(`[${e.id}] its whole suite passed here at ${whole.commit.slice(0, 7)}, the same code as ${sha}: not tested again before its release`);
    return null;
  }
  // No checks to run (Settings give it none): released as it was before builds tested main, untested.
  if (!e.test.length) {
    ctx.log(`[${e.id}] Settings give ${e.name} no checks, so ${sha} is released untested`);
    return null;
  }
  const tested = await testAt(ctx, e, commit, since);
  ctx.log(`[${e.id}] ${tested.note}`);
  // Ended by Windows (the PC shutting down), or no checks to run: not kept, so the next build tests it again (with the
  // checks Settings give it by then).
  if (!tested.ok && (interrupted(tested.note) || !e.test.length)) return tested.note;
  const now = readJson<Record<string, MainTested>>(mainTestedFile(), {});
  now[keyOf(e, commit)] = tested;
  writeJson(mainTestedFile(), Object.fromEntries(Object.entries(now).slice(-500)));
  if (!tested.ok) return tested.note;
  // Passed here before its release: the Surveyor's GET /api/tested (tested.ts).
  recordTested(e.id, { commit, stage: 'build', branch: e.branch, at: tested.at });
  return null;
}

/** How long the Steward waits before asking GitHub again to merge a PR of its own it has just opened. */
export const OWN_MERGE_WAITS_MS = [5_000, 15_000, 30_000];

/**
 * A PR the Steward opened itself (a kit's rollout, a stamp), merged by it at `head`, its branch deleted: GitHub may need
 * a moment to tell whether a PR just opened merges, so a refusal is asked again after each of OWN_MERGE_WAITS_MS. Null
 * once merged, else why not. Never throws.
 */
export async function mergeOwn(ctx: Ctx, e: Pick<Employee, 'id' | 'repo'>, pr: { number: number; head: string }): Promise<string | null> {
  const host = hostFor(ctx, e);
  const pause = ctx.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let why = '';
  for (const ms of [0, ...OWN_MERGE_WAITS_MS]) {
    if (ms) await pause(ms);
    const r = await host.mergePr(e.repo, pr.number, { matchHead: pr.head, deleteBranch: true }).catch((err: Error) => ({ code: 1, out: '', err: err.message }));
    if (r.code === 0) {
      // This Steward's merge, not a stranger's (strangers.ts).
      noteMerged(e, pr.number);
      // And the repository's heads read again in a moment (heads.ts), so Reeve brings its clones up to the merge.
      headsMoved(e.repo);
      ctx.log(`[${e.id}] merged its own #${pr.number} (${pr.head.slice(0, 7)})`);
      return null;
    }
    why = (r.err || r.out).trim().split('\n').pop() ?? '';
    // Its head moved: someone pushed to it, and it is theirs to merge now.
    if (/head.*(changed|modified|out of date)|expected head sha/i.test(why)) break;
  }
  return `${host.name} wouldn't merge #${pr.number}: ${why}`;
}

/** The PR's number in its URL (…/pull/12, GitLab's …/merge_requests/12, Bitbucket's …/pull-requests/12), or null. Pure. */
export const prNumberOf = (url: string): number | null => {
  const m = /\/(?:pull|pulls|pull-requests|merge_requests|pullrequest)\/(\d+)\b/.exec(url);
  return m ? Number(m[1]) : null;
};
