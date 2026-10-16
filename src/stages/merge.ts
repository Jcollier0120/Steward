import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterWords } from '../after.ts';
import { whileAwake } from '../kit/awake.ts';
import { commitOf, fetchFor, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { NO_TEAM } from '../team.ts';
import { compareVersions } from '../kitfiles.ts';
import { bailiffInstalled, type Employee } from '../settings.ts';
import { agreedVersion } from '../versions.ts';
import { changeFiles, changeVersion, CHANGES_DIR, fragmentFiles } from '../entries.ts';
import { stamp, usesChanges, type StampResult } from './stamp.ts';
import { openVouchedBranches } from './branchesin.ts';
import { handInBranches } from './gitevents.ts';
import { catchUp, isKitPr, type CaughtUp } from './catchup.ts';
import { bumpDirOf, checkoutOf, forgetGlance, freshBranch, glanceOf, hostIs, mapLimit, NO_PRS, NOT_ON_KIT, releasedOf, result, type Ctx, type EmployeeResult } from './common.ts';
import { kitReleaseHold, testAtHead, testedBefore, type Tested } from './prtest.ts';
import { kickBack } from './kickback.ts';
import { vouchedBy } from './vouch.ts';
import { runTrain, trainCars, type TrainRun } from './train.ts';
import { buildCars, forgetEarlierBuilds, leftIn, loadReadySince, runBatch, type BuildBatch } from './build.ts';
import { loadRolloutFailures } from './rollout.ts';
import { kitMovedUnder, kitTrialHold, raisesKit, trialFails, trialGivesWay, trialGoingAt, TRIAL_GOING } from './trial.ts';
import { claimsOn, movedTo, reclaim, type Claim } from '../claims.ts';
import { kitInfo } from '../kitsource.ts';
import { kitClaimKey, kitTitleVersions, KIT_VERSION_FILE } from './kitpart.ts';
import type { Held } from '../alarms.ts';
import { BAILIFF_WAIT, bailiffHold, dependencyHold, isWrightDraft, lockfileHold, ownerFirstHold, reviewedComment, reviewHold } from '../review.ts';
import { openPrs, parsePrs, type PrInfo } from './staff.ts';
import { headsMoved } from '../heads.ts';
import { noteMerged } from '../strangers.ts';
import { CONFLICTS, handedOn, noteConflict, type ConflictOutcome } from '../conflicts.ts';
import { hostFor, must } from '../hosts/index.ts';
import { withRepo } from './slots.ts';
import { phaseOf, timed } from '../buildtimes.ts';

/**
 * Stage 3, `steward merge [--yes] [--team]`: the Steward's open PRs (head steward/…), each with its checks
 * and whether it merges; with --team, the team's open PRs too (those the GitHub accounts in Settings'
 * Team opened, from any branch, to any employee, on the kit or not). With --yes (the page's buttons ask
 * first), those that merge cleanly into the employee's branch and have no failing or running checks are
 * merged with a merge commit. The Steward deletes its own branch and worktree after; a team member's
 * branch is theirs, and stays. The rest wait, and say why.
 *
 * A PR can ask for steps after it is merged, in a steward block in its description (src/after.ts): release,
 * install, approve-jobs. One whose block can't be read waits, and so does one whose release couldn't happen: its
 * version, once merged, is already released. An install or approval with no command for it in Settings doesn't hold
 * it: that employee is installed (Heiward, by Manor, from its own installer) or has its jobs approved another way, so
 * the step is skipped after the merge, and its line says so. With --yes, the steps run after the merge
 * (stages/aftermerge.ts).
 *
 * A team PR is held to more, since no one asked for it here: the version it sets must be new (not released, above
 * its branch's, and no other ready PR's), and one GitHub runs no checks on is tested here first, at its head
 * commit, with the employee's own checks (stages/prtest.ts). The Steward's own PRs were tested by their bump. A team PR
 * to the Steward's own repository that raises the kit waits, too, until the new kit passes every agent's checks
 * (stages/trial.ts), each agent it fails moving with it in a ready PR of its own that pins the new kit and passes with
 * it there, or is labelled to say the agents change with it. Kit PRs queued one behind another are tried together, once.
 *
 * With --yes --team, and Settings' catchUp on, a ready team PR that waits only on its branch having moved is caught up
 * (stages/catchup.ts): one that conflicts with its branch or is behind it, whose version is no longer new, or whose
 * checks failed here before the branch moved on. One GitHub runs no checks on is tested here at its new head and merged
 * in the same round (mergeLooks), and so on down the queue until it runs out; one with checks on GitHub, at a round
 * once they pass.
 *
 * A team PR stacked on another's branch (its base is that PR's head, not the employee's branch) waits for that PR. Once
 * that PR has merged into the employee's branch, the stacked one is pointed at the branch itself (retargetStacked), with a
 * comment saying so, and joins the line: the Steward leaves a team member's branch in place after merging its PR, so
 * GitHub never retargets what was stacked on it, and it would wait for ever (Reeve#105, 2026-10-08).
 */

/** Why a PR waits while GitHub hasn't yet said whether it merges. */
export const WORKING_OUT = 'GitHub is still working out whether it merges: try again in a minute';

/**
 * How long the Steward waits before each time it asks GitHub again whether a PR merges, while GitHub is still working
 * it out: about 25 s in all. GitHub works it out lazily, once asked, and usually within seconds; without asking again, a
 * PR waited a whole round for it (every one just caught up or retargeted did).
 */
export const WORKING_OUT_WAITS_MS = [3_000, 7_000, 15_000];

/**
 * Each PR that waits only on GitHub working out whether it merges, asked about again a few times (WORKING_OUT_WAITS_MS)
 * until GitHub says: its mergeable and merge state are then GitHub's answer, so it joins the merges this round. One whose
 * checks are failing or running would wait anyway, and isn't asked about. Never throws: one GitHub still hasn't worked
 * out, or that couldn't be asked about, waits as before. Returns the numbers GitHub has now answered for.
 */
export async function askAgainWhetherMerges(ctx: Ctx, e: Employee, prs: PrInfo[]): Promise<number[]> {
  const pause = ctx.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const unknown = prs.filter((pr) => !stackedOn(pr, prs, e.branch) && holdReason(pr, e.branch) === WORKING_OUT && pr.checks !== 'failing' && pr.checks !== 'pending');
  const answered: number[] = [];
  for (const ms of WORKING_OUT_WAITS_MS) {
    const left = unknown.filter((pr) => !answered.includes(pr.number));
    if (!left.length) break;
    await pause(ms);
    for (const pr of left) {
      const r = await hostFor(ctx, e).viewPr(e.repo, pr.number, 'mergeable,mergeStateStatus');
      if (r.code !== 0) continue;
      let now: { mergeable?: unknown; mergeStateStatus?: unknown };
      try {
        now = JSON.parse(r.out);
      } catch {
        continue;
      }
      if (!now.mergeable || now.mergeable === 'UNKNOWN') continue;
      pr.mergeable = String(now.mergeable);
      pr.mergeState = String(now.mergeStateStatus ?? 'UNKNOWN');
      answered.push(pr.number);
      ctx.log(`[${e.id}] #${pr.number}: asked GitHub again whether it merges: ${pr.mergeable.toLowerCase()}`);
    }
  }
  return answered;
}

/** Why a PR waits while its checks run. */
export const CHECKS_RUNNING = 'checks still running';

/** How a caught-up PR's hold begins (catchUpAll): it waits for its checks at its new head. */
export const CAUGHT_UP = 'caught up by the Steward';

/**
 * Whether a PR waits only on something that settles itself within minutes, so a round soon after can merge it: its checks
 * running, its head just caught up (checks starting there), GitHub working out whether it merges, it being just opened, or
 * its kit being tried on the agents a few each round (trial.ts).
 */
export const waitsBriefly = (why: string) =>
  why === CHECKS_RUNNING || why === WORKING_OUT || why.startsWith(`${CAUGHT_UP} (`) || why.startsWith(JUST_OPENED) || why.startsWith(TRIAL_GOING);

/** How a PR's hold begins while it is younger than Settings' mergeMinAgeMinutes. */
export const JUST_OPENED = 'opened ';

/** How young a PR may be and still merge, and the time now: Settings' mergeMinAgeMinutes, and the round's clock. */
export interface AgeRule {
  minAgeMinutes?: number;
  now?: number;
}

/**
 * Why a PR waits for being too young, or null: one opened less than `minAgeMinutes` ago waits, so a small fix can still
 * be pushed to it before it merges. One whose host doesn't say when it was opened never waits for this, and nor does a
 * kit PR of the Steward's own (steward/kit-…, 0.35.29): nobody pushes fixes to it, and its checks passed here already.
 */
export function ageHold(pr: PrInfo, o: AgeRule = {}): string | null {
  if (pr.whose === 'steward' && pr.head.startsWith('steward/kit-') && !pr.fork) return null;
  const min = o.minAgeMinutes ?? 0;
  const at = Date.parse(pr.createdAt ?? '');
  if (!(min > 0) || !Number.isFinite(at)) return null;
  const age = Math.max(0, (o.now ?? Date.now()) - at);
  if (age >= min * 60_000) return null;
  const ago = Math.floor(age / 60_000);
  return `${JUST_OPENED}${ago < 1 ? 'less than a minute' : `${ago} minute${ago === 1 ? '' : 's'}`} ago: it merges once it is ${min} minutes old, so small fixes can be pushed first`;
}

/** Why a PR waits, or null when it can be merged: into the employee's branch, mergeable, not a draft, its checks passing (or none: a team PR with none is then tested here), and old enough (ageHold). */
export function holdReason(pr: PrInfo, branch?: string, age: AgeRule = {}): string | null {
  if (branch && pr.base && pr.base !== branch) return `it merges into ${pr.base}, not ${branch}`;
  if (pr.draft) return pr.reviewHold ? `a draft from the Wright, waiting for you: ${pr.reviewHold}` : pr.bailiffHold ? `${BAILIFF_WAIT}${pr.bailiffHold}` : 'a draft';
  if (pr.afterError) return pr.afterError;
  // One that needs the owner first (a migration to run): never merged by the Steward until they say (review.ts).
  const owner = ownerFirstHold(pr);
  if (owner) return owner;
  // Its lockfile brings new packages or a new install script: the owner looks first (review.ts's lockfileHold).
  if (pr.lockHold) return pr.lockHold;
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return CONFLICTS;
  if (pr.mergeable !== 'MERGEABLE') return WORKING_OUT;
  if (pr.checks === 'failing') return 'checks failing';
  if (pr.checks === 'pending') return CHECKS_RUNNING;
  if (pr.mergeState === 'BLOCKED') return 'blocked: a required review or check';
  if (pr.mergeState === 'BEHIND') return 'behind its branch, which must be up to date to merge';
  return ageHold(pr, age);
}

/** The open PR whose branch this one is stacked on (its base is that PR's head), if any. */
export const stackedOn = (pr: PrInfo, prs: PrInfo[], branch?: string): PrInfo | undefined =>
  pr.base && pr.base !== branch ? prs.find((p) => p !== pr && p.head === pr.base) : undefined;

/** The PRs to merge, and the ones that wait with their reasons. */
export function mergeSelection(prs: PrInfo[], branch?: string, age: AgeRule = {}): { merge: PrInfo[]; hold: { pr: PrInfo; why: string }[] } {
  const merge: PrInfo[] = [];
  const hold: { pr: PrInfo; why: string }[] = [];
  for (const pr of prs) {
    const under = stackedOn(pr, prs, branch);
    const why = under ? `stacked on #${under.number} (${pr.base}): once #${under.number} has merged, it is pointed at ${branch} and joins the line` : holdReason(pr, branch, age);
    if (why) hold.push({ pr, why });
    else merge.push(pr);
  }
  return { merge, hold };
}

const describe = (pr: PrInfo) => `#${pr.number} (${pr.head}${pr.whose === 'team' ? `, ${pr.author}'s` : ''}; checks ${pr.checks}; ${pr.mergeable.toLowerCase()}${pr.after ? `; then ${afterWords(pr.after)}` : ''})`;

/** What the checks before a merge need from origin, looked up once per employee (and again after a merge): its released versions, and its branch's version. */
type Lookup = () => Promise<{ released: string[]; base: string | null }>;

/**
 * A PR's version at its head, and where it started (at its merge base with the branch); null where none can be read.
 * One that leaves its version files alone and adds changes/<version>.md instead (entries.ts) sets the highest of those,
 * and `entries` lists them: the stamp (stages/stamp.ts) gives it its version as it merges.
 */
export async function prVersions(ctx: Ctx, e: Employee, pr: PrInfo): Promise<{ head: string | null; from: string | null; entries?: string[]; fragments?: string[] }> {
  const { run } = ctx;
  const repo = checkoutOf(e);
  // The PR's head, fetched by its number (a fork's too), read at the commit its host named.
  await fetchFor(run, repo, pr.headOid, hostFor(ctx, e).prRef(pr));
  const at = pr.headOid || 'FETCH_HEAD';
  const read = async (ref: string) => {
    const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, ref, f)] as [string, string | null])));
    return 'version' in v ? v.version : null;
  };
  const start = (await gitMaybe(run, repo, 'merge-base', `origin/${e.branch}`, at))?.trim();
  const head = await read(at);
  const from = start ? await read(start) : null;
  if (start && head === from) {
    const listing = async (ref: string) => ((await gitMaybe(run, repo, 'ls-tree', '--name-only', ref, `${CHANGES_DIR}/`)) ?? '').split('\n').map((l) => l.trim());
    const [before, now] = [await listing(start), await listing(at)];
    const had = new Set(changeFiles(before));
    const added = changeFiles(now).filter((f) => !had.has(f));
    if (added.length) return { head: changeVersion(added.at(-1)!), from, entries: added };
    // A fragment (changes/<branch>.md): no version of its own, the stamp gives it the next release's.
    const hadFragments = new Set(fragmentFiles(before));
    const fragments = fragmentFiles(now).filter((f) => !hadFragments.has(f));
    if (fragments.length) return { head, from, fragments };
  }
  return { head, from };
}

/**
 * The open PRs to the employee's branch that set a new version (above the branch's, not released, not another branch's
 * claim), by number: the queue the merges take lowest first. Drafts hold their place in it too (the owner's rule). A ready
 * team PR's version is the one its check read; every other one's is read from its head.
 */
export async function pendingVersions(ctx: Ctx, e: Employee, prs: PrInfo[], ready: { pr: PrInfo; sets: string | null }[], lookup: Lookup): Promise<Map<number, string>> {
  const { released, base } = await lookup();
  const known = new Map(ready.filter((r) => r.pr.whose === 'team').map((r) => [r.pr.number, r.sets]));
  const claims = claimsOn(e.repo);
  const out = new Map<number, string>();
  for (const pr of prs) {
    if (pr.base !== e.branch) continue;
    let v = known.get(pr.number);
    if (v === undefined) {
      try {
        const p = await prVersions(ctx, e, pr);
        v = p.head && p.head !== p.from ? p.head : null;
      } catch {
        v = null;
      }
    }
    if (!v || released.includes(v) || (base && compareVersions(v, base) <= 0)) continue;
    if (claims.some((c) => c.version === v && c.branch && c.branch !== pr.head)) continue;
    out.set(pr.number, v);
  }
  return out;
}

/** The PR in the queue with the lowest version below `v`, as [number, version], or null when none is below it. */
export function lowestBelow(pending: Map<number, string>, v: string): [number, string] | null {
  const below = [...pending].filter(([, w]) => compareVersions(w, v) < 0).sort((a, b) => compareVersions(a[1], b[1]) || a[0] - b[0]);
  return below[0] ?? null;
}

/** How a hold that a new version would clear ends: such a PR can be caught up. */
export const RAISE = 'raise the version in the PR';

/**
 * Why the steps a mergeable PR asks for couldn't happen, or null: a release whose version once merged (the PR's when
 * it sets one, else its branch's) is already released. An install or approval with no command for it in Settings
 * isn't one: it is skipped after the merge (stages/aftermerge.ts).
 */
export async function afterHold(ctx: Ctx, e: Employee, pr: PrInfo, lookup: Lookup): Promise<string | null> {
  const a = pr.after;
  if (!a) return null;
  if (!a.steps.includes('release')) return null;
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return `it asks for a release, but there's no checkout at ${repo} to read its version from`;
  const { released, base } = await lookup();
  const v = await prVersions(ctx, e, pr);
  // Its version is stamped as it merges: always a new one, or the next release's.
  if (v.entries || v.fragments) return null;
  if (!v.head) return `it asks for a release, but its branch has no version the Steward can read (${e.versionFiles.join(', ')})`;
  const version = v.head !== v.from ? v.head : (base ?? v.head);
  if (released.includes(version)) return `it asks for a release, but v${version}, its version once merged, is already released: ${RAISE}`;
  return null;
}

/**
 * Why a team PR waits for its version, or null; and the version it sets (null when it leaves the version as it found
 * it). A version it sets must be new: not released, and above its branch's, so that two changes never share one
 * version and a merge never leaves a version conflict behind. (The Steward's own bumps raise the patch by one.)
 */
export async function teamHold(ctx: Ctx, e: Employee, pr: PrInfo, lookup: Lookup): Promise<{ why: string | null; sets: string | null; raise?: boolean; stamps?: boolean }> {
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return { why: `there's no checkout at ${repo} to read its version from, or test it in`, sets: null };
  const { released, base } = await lookup();
  const v = await prVersions(ctx, e, pr);
  if (!v.head) return { why: `its branch has no version the Steward can read (${e.versionFiles.join(', ')})`, sets: null };
  if (v.head === v.from) return { why: null, sets: null };
  // Written as changes/<version>.md: the stamp gives it a free version as it merges, so it never waits for one.
  if (v.entries) return { why: null, sets: v.head, stamps: true };
  if (released.includes(v.head)) return { why: `it sets v${v.head}, which is already released: raise it`, sets: v.head, raise: true };
  // Claimed up front by other work (claims.ts): that work keeps it, and this one gets a version of its own.
  const claimed = claimsOn(e.repo).find((c) => c.version === v.head && c.branch && c.branch !== pr.head);
  if (claimed) return { why: `it sets v${v.head}, which ${claimed.by} claimed for ${claimed.for} (${claimed.branch}): it needs a version of its own`, sets: v.head, raise: true };
  if (base && compareVersions(v.head, base) <= 0) return { why: `it sets v${v.head}, but ${e.branch} is at v${base} already: raise it above`, sets: v.head, raise: true };
  return { why: null, sets: v.head };
}

const heldOf = (pr: PrInfo, why: string, blocks: number[] = []): Held => ({ number: pr.number, url: pr.url, title: pr.title, why, draft: pr.draft, ...(blocks.length ? { blocks } : {}), ...(raisesKit(pr) ? { kit: true } : {}) });

/** How the hold of a PR that gave up its turn (givesWay) reads. */
export const GAVE_WAY = `${CONFLICTS}, beyond what the Steward resolves, and was handed on: it gives up its turn, so the PRs above it merge first, and once it is resolved it is caught up to a version of its own`;

/**
 * The PRs held by a conflict with their branch that has been handed on at their head as it is now (sent back to its
 * author: kickback.ts, conflicts.ts handedOn): each gives up its turn in the version queue rather than hold up every
 * PR above it until someone resolves it (Manor#226 held six ready PRs for five hours, 2026-10-12). Its place costs it
 * nothing: once resolved, its version is below its branch's, and its catch-up gives it a new one (catchup.ts), as it
 * does for any PR that a lower one overtook. A draft keeps its place (the owner's rule: it is being worked on); a
 * conflict no one could be told about keeps it too, and its alarm comes within the hour (alarms.ts blockingHours).
 */
export const givesWay = (e: Employee, hold: { pr: PrInfo; why: string }[]): Set<number> =>
  new Set(hold.filter((h) => h.why === CONFLICTS && !h.pr.draft && handedOn(e.repo, h.pr.number, h.pr.headOid)).map((h) => h.pr.number));

/**
 * The PRs moved past the others in the version queue (move-past.ts) that are still below the version they were moved
 * to, by number: that version. Not ready, one gives up its turn, a draft too (the owner moved it); ready, it waits its
 * turn at that version, and is caught up to it once the PRs below it have merged. Pure.
 */
export function movedPast(claims: Claim[], prs: PrInfo[], pending: Map<number, string>): Map<number, string> {
  const out = new Map<number, string>();
  for (const pr of prs) {
    const v = pending.get(pr.number);
    const to = v ? movedTo(claims, pr) : null;
    if (v && to && compareVersions(to, v) > 0) out.set(pr.number, to);
  }
  return out;
}

/** How the hold of a PR moved past the others reads, once it isn't ready (movedPast). */
export const movedWords = (v: string) => `moved past the others to v${v}: it gives up its turn, so the PRs above it merge first, and once it is ready it is caught up to v${v}`;

/**
 * A ready team PR from the repository itself, or a kit PR of the Steward's, that waits only on its branch: conflicting
 * with it, or behind it.
 */
export const behindItsBranch = (pr: PrInfo, branch: string) =>
  (pr.whose === 'team' || isKitPr(pr)) && !pr.fork && !pr.draft && !pr.afterError && pr.base === branch && (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY' || pr.mergeState === 'BEHIND');

/** GitHub says it conflicts with its branch (not merely behind it). */
export const conflictsWithBranch = (pr: PrInfo) => pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY';

/** Why a look at the conflicts alone (conflictsOnly) left a repository as it was. */
export const NO_CONFLICTS = 'no ready PR conflicts with its branch';

/**
 * Each PR the looks at the conflicts alone tried to catch up, by employee and number: its head and its branch's then.
 * Tried again only once either moves, so a conflict that needs its author isn't tried every few minutes.
 */
const conflictTried = new Map<string, string>();
const triedKey = (e: Employee, pr: PrInfo) => `${e.id}#${pr.number}`;
const triedAt = (pr: PrInfo, branchHead: string | null) => `${pr.headOid}:${branchHead ?? ''}`;

/**
 * The PRs a look at the conflicts alone catches up (mergeOne's conflictsOnly, steward.ts's conflictsNow): ready ones
 * that conflict with their branch (behindItsBranch, and conflictsWithBranch), whose conflict wasn't handed on at this head
 * already (conflicts.ts handedOn), whose kit trial isn't going at this head (caught up, it would start again), and not
 * tried already at this head and this branch head. `branchHead`: the branch's head on GitHub, from the glance.
 */
export const conflictsToCatch = (e: Employee, prs: PrInfo[], branchHead: string | null): PrInfo[] =>
  prs.filter((pr) => behindItsBranch(pr, e.branch) && conflictsWithBranch(pr) && !handedOn(e.repo, pr.number, pr.headOid) && conflictTried.get(triedKey(e, pr)) !== triedAt(pr, branchHead) && !trialGoingAt(pr));

/** An employee's PRs a look at the conflicts alone would catch up, from the stage's glance at GitHub; none without one. */
export function conflictsWaiting(ctx: Ctx, e: Employee): PrInfo[] {
  const g = glanceOf(ctx, e);
  if (!g || !e.merges || hostIs(ctx, e) === 'git') return [];
  return conflictsToCatch(e, parsePrs(JSON.stringify(g.prs), ctx.settings.team), g.head);
}

/** A team PR GitHub runs no checks on: the Steward tests it here before it merges it (stages/prtest.ts). */
const untested = (pr: PrInfo) => pr.whose === 'team' && pr.checks === 'none';

/** Why a repository's ready PRs aren't merged: the person hasn't said yes for it. */
export const NOT_MERGING = "left to you: the Steward merges PRs to it only once you say yes (Merges your ready PRs, in Settings)";

/** Why a draft of the Wright's waits where the Bailiff isn't installed. */
export const NO_BAILIFF = "the Bailiff isn't on this PC to review it: review it yourself and mark it ready, or hire the Bailiff";

/**
 * Each of the Wright's drafts, looked at (review.ts): one that passes is marked ready on GitHub, with a comment saying
 * what was looked at, and goes on as any ready team PR (tested here at its head, then merged); one that doesn't keeps
 * the reason, which its hold then says. One that passes is marked ready only once the Bailiff has approved its current
 * head commit; until then it waits for the Bailiff, and says so. Where the Bailiff isn't installed (`bailiff` false),
 * none is marked ready: the Wright's work waits for a person, as the manor takes on no new work without both.
 */

export async function lookAtWrightDrafts(ctx: Ctx, e: Employee, prs: PrInfo[], bailiff = bailiffInstalled()): Promise<void> {
  const s = ctx.settings.wrightReview;
  for (const pr of prs.filter(isWrightDraft)) {
    let why = reviewHold(pr, s, e.id);
    if (!why) {
      try {
        why = await dependencyHold(ctx, e, pr);
      } catch (err) {
        why = `the Steward couldn't compare its dependencies: ${(err as Error).message}`;
      }
    }
    if (why) {
      pr.reviewHold = why;
      continue;
    }
    // New work needs both: without the Bailiff, a draft of the Wright's waits for a person to review it and mark it ready.
    if (!bailiff) {
      pr.reviewHold = NO_BAILIFF;
      continue;
    }
    const waits = await bailiffHold(ctx, e, pr);
    if (waits) {
      pr.bailiffHold = waits;
      continue;
    }
    const ready = await hostFor(ctx, e).readyPr(e.repo, pr.number);
    if (ready.code !== 0) {
      pr.reviewHold = `the Steward couldn't mark it ready: ${(ready.err || ready.out).trim().split('\n').pop()}`;
      continue;
    }
    await hostFor(ctx, e).commentPr(e.repo, pr.number, reviewedComment(pr, s, bailiff));
    pr.draft = false;
    ctx.log(`[${e.id}] the Wright's #${pr.number}: looked at, and marked ready (${pr.files.length} files, ${pr.changed} lines)`);
  }
}

/**
 * Each PR that isn't a draft, whose package-lock.json changed, looked at (review.ts's lockfileHold): one that brings a
 * package new to the repository, or one with an install script Settings don't allow, keeps why in `lockHold`, and waits
 * for the owner (holdReason), out of any train. One that can't be compared waits too, and says why.
 */
export async function lookAtLockfiles(ctx: Ctx, e: Employee, prs: PrInfo[]): Promise<void> {
  if (!existsSync(checkoutOf(e))) return;
  for (const pr of prs.filter((p) => !p.draft)) {
    try {
      const why = await lockfileHold(ctx, e, pr);
      if (why) pr.lockHold = why;
    } catch (err) {
      pr.lockHold = `the Steward couldn't compare its package-lock.json: ${(err as Error).message}`;
    }
  }
}

/**
 * One look at an employee's PRs (mergeOne): what it merged and what waits, and, apart, the lines of what it did (merged,
 * didn't merge, caught up) and of what waits, so that several looks in one round (merge) say each thing once.
 * `lookAgain`: another look this round can merge more (lookAgainAfter).
 */
export type MergeLook = EmployeeResult & { merged: PrInfo[]; held: Held[]; did?: string[]; waits?: string[]; lookAgain?: boolean };

/**
 * Whether another look this round can merge more, after one that merged `merged` and left `held` waiting: it caught up a
 * PR GitHub runs no checks on (`testedHere`), which the Steward tests itself at its new head, so it needn't wait a round
 * for checks that would never come; or it merged one, and a PR still waits on that merge alone: stacked on it (pointed
 * at the branch at the next look), or GitHub working out whether it merges (asked again at the next look); or it handed on
 * the conflict of a PR that held others up (`gaveWay`), which then gives up its turn, so they merge at the next look. Pure.
 */
export const lookAgainAfter = (o: { merged: number; held: Held[]; testedHere: boolean; gaveWay?: boolean }) =>
  o.testedHere || !!o.gaveWay || (o.merged > 0 && o.held.some((h) => !h.draft && (h.why === WORKING_OUT || h.why.startsWith('stacked on #'))));

/**
 * One look at an employee's PRs. `conflictsOnly` (steward.ts's conflictsNow, beside the rounds): only the ready PRs that
 * conflict with their branch are caught up (conflictsToCatch), with the versions the others set kept free as a round
 * keeps them; nothing is merged, retargeted, reviewed or tested, and the rest waits for the round.
 */
export async function mergeOne(ctx: Ctx, e: Employee, o: { yes: boolean; team?: boolean; conflictsOnly?: boolean }): Promise<MergeLook> {
  const { run } = ctx;
  const only = !!o.conflictsOnly;
  // The branch's head as the glance saw it, before a catch-up forgets the glance: what the PRs were tried against.
  const branchHead = glanceOf(ctx, e)?.head ?? null;
  // The team's PRs have nothing to do with the kit; the Steward's exist only for an employee on it.
  if (!e.usesKit && !o.team) return { ...result(e, 'skipped', NOT_ON_KIT), merged: [], held: [] };
  // Worked with plain git (scm.ts): no pull requests anywhere to merge.
  if (hostIs(ctx, e) === 'git') return { ...result(e, 'skipped', NO_PRS), merged: [], held: [] };
  // With no team, only the Steward's are read. From the stage's glance at GitHub when it has them (glance.ts).
  const g = glanceOf(ctx, e);
  const prs = parsePrs(g ? JSON.stringify(g.prs) : await openPrs(hostFor({ ...ctx, run }, e), e.repo), o.team ? ctx.settings.team : []);
  const none = !o.team ? 'no open Steward PRs' : ctx.settings.team.length ? "no open PRs of the Steward's or the team's" : `no open Steward PRs (${NO_TEAM})`;
  if (!prs.length) return { ...result(e, 'skipped', none), merged: [], held: [] };
  // Merged only where the person said yes, repository by repository; elsewhere listed, nothing tested, and no alarm.
  if (o.yes && !e.merges) return { ...result(e, 'skipped', `${prs.length} open PR${prs.length === 1 ? '' : 's'} (${prs.map((p) => `#${p.number}`).join(', ')}) ${NOT_MERGING}`, { url: prs[0].url }), merged: [], held: [] };
  // Between builds, preparing the next one (stages/prepare.ts): its tests run as the build would run them, and nothing on
  // GitHub is changed but a PR's test status. The build finds those passes, and only merges.
  const prep = !!ctx.prepare && !ctx.build;
  // Stacked on a branch whose PR has merged: pointed at the employee's branch, so it joins the line below.
  if (o.yes && o.team && !only && !prep) await retargetStacked(ctx, e, prs);
  // The Wright's drafts: the Steward looks at each, and marks ready the ones that pass (review.ts).
  if (o.yes && o.team && !only && !prep && ctx.settings.wrightReview.on) await lookAtWrightDrafts(ctx, e, prs);
  // GitHub still working out whether one merges (just retargeted, or pushed to): asked again, so it needn't wait a round.
  if (o.yes && !only && !prep) await askAgainWhetherMerges(ctx, e, prs);
  // Whoever wrote it, one whose lockfile brings new packages or a new install script waits for the owner (review.ts).
  if (o.yes && !only) await lookAtLockfiles(ctx, e, prs);
  const { merge: mergeable, hold } = mergeSelection(prs, e.branch, { minAgeMinutes: ctx.settings.mergeMinAgeMinutes });
  let looked: ReturnType<Lookup> | null = null;
  const lookup: Lookup = () =>
    (looked ??= (async () => {
      const repo = checkoutOf(e);
      await freshBranch(ctx, e, repo);
      const base = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, `origin/${e.branch}`, f)] as [string, string | null])));
      const released = (await releasedOf(ctx, e)).map((r) => r.version);
      return { released, base: 'version' in base ? base.version : null };
    })());
  /** Why it waits, after its steps and, for a team PR, its version; and the version it sets. */
  const check = async (pr: PrInfo): Promise<{ why: string | null; sets: string | null; raise?: boolean; stamps?: boolean }> => {
    try {
      const why = await afterHold(ctx, e, pr, lookup);
      if (why) return { why, sets: null, raise: why.endsWith(RAISE) };
      return pr.whose === 'team' ? await teamHold(ctx, e, pr, lookup) : { why: null, sets: null };
    } catch (err) {
      return { why: `couldn't check it before merging: ${(err as Error).message}`, sets: null };
    }
  };
  // The ones a catch-up (stages/catchup.ts) could clear, after the merges.
  const catchable = new Map<number, PrInfo>(hold.filter((h) => behindItsBranch(h.pr, e.branch)).map((h) => [h.pr.number, h.pr]));
  // Only the conflicts: none, and nothing more is looked at.
  const conflicting = only ? conflictsToCatch(e, [...catchable.values()], branchHead) : [];
  if (only && !(o.yes && o.team && ctx.settings.catchUp && conflicting.length)) return { ...result(e, 'skipped', NO_CONFLICTS), merged: [], held: [] };
  const failedHere: { pr: PrInfo; t: Tested }[] = [];
  const ready: { pr: PrInfo; sets: string | null; stamps?: boolean }[] = [];
  // A kit PR a build left out for breaking its checks (stages/build.ts): never merged at that head, in a build or not.
  const kitHeld = loadRolloutFailures()[e.id];
  // In a build, the PRs it dropped or kept for the next build: not merged on their own meanwhile.
  if (ctx.build) forgetEarlierBuilds(e.id, ctx.build.due);
  const left = ctx.build ? leftIn(e.id, ctx.build.due) : [];
  for (const pr of mergeable) {
    if (kitHeld?.stage === 'build' && isKitPr(pr) && kitHeld.head === pr.headOid) {
      hold.push({ pr, why: `it broke a build's checks (${kitHeld.message}): it waits for a newer kit, or Bump` });
      continue;
    }
    if (left.includes(pr.number)) {
      hold.push({ pr, why: `left out of ${ctx.build!.name}: it waits for the next build` });
      continue;
    }
    const c = await check(pr);
    if (c.why) {
      hold.push({ pr, why: c.why });
      if (c.raise && pr.whose === 'team') catchable.set(pr.number, pr);
    } else ready.push({ pr, sets: c.sets, stamps: c.stamps });
  }
  // A build's batch (stages/build.ts): its kit PR and the PRs that write fragments, stacked in the order they went
  // ready and tested once; one that breaks it is found and dropped, and the rest leave together. Between builds, the
  // next build's batch stacked and tested the same way, and left for the build to ship.
  if ((ctx.build || prep) && o.yes && o.team && existsSync(checkoutOf(e))) {
    const cars = buildCars(prs, { id: e.id, branch: e.branch, since: loadReadySince(), left, kitHeld });
    if (cars.length > 1) {
      const numbers = cars.map((c) => `#${c.pr.number}`).join(', ');
      let b: BuildBatch;
      try {
        const { released } = await lookup();
        // The batch's own cars don't take versions from it: one it leaves out is caught up when it comes back.
        const aboard = new Set(cars.map((c) => c.pr.number));
        const heads = new Set(cars.map((c) => c.pr.head));
        const taken = [...ready.filter((r) => !aboard.has(r.pr.number)).flatMap((r) => (r.sets ? [r.sets] : [])), ...claimsOn(e.repo).filter((c) => !c.branch || !heads.has(c.branch)).map((c) => c.version)];
        b = await runBatch(ctx, e, cars, { released, taken });
      } catch (err) {
        b = { merged: [], dropped: [], kept: [], note: `couldn't stack them: ${(err as Error).message}`, tested: false };
      }
      if (b.prepared) {
        const words = `${numbers}: ${b.note}`;
        ctx.log(`[${e.id}] ${words}`);
        return { ...result(e, b.prepared === 'failed' ? 'failed' : 'skipped', words, { url: cars.at(-1)!.pr.url }), merged: [], held: [], did: [words], waits: [] };
      }
      if (b.merged.length && ctx.build) {
        const words = `merged ${b.merged.map((p) => `#${p.number}`).join(', ')} in ${ctx.build.name} (${b.note})`;
        return { ...result(e, 'done', words, { url: b.merged.at(-1)!.url }), merged: b.merged, held: [], did: [words], waits: [], lookAgain: true };
      }
      // Pushed and waiting for GitHub's checks at the stack: the cars wait as one batch, none merged alone meanwhile.
      if (b.waiting) {
        const words = `${numbers} wait as one batch: ${b.note}`;
        ctx.log(`[${e.id}] ${words}`);
        return { ...result(e, 'skipped', words, { url: cars.at(-1)!.pr.url }), merged: [], held: cars.map((c) => heldOf(c.pr, CHECKS_RUNNING)), did: [], waits: [words], lookAgain: false };
      }
      // Tested, and none of it left: what it dropped and kept wait, and the next look takes the rest of the repository's PRs.
      if (b.tested && ctx.build) {
        const words = `${ctx.build.name} merged none of ${numbers}: ${b.note}`;
        const why = (pr: PrInfo) => b.dropped.find((d) => d.pr.number === pr.number)?.why;
        const held = [...b.dropped.map((d) => d.pr), ...b.kept].map((pr) => heldOf(pr, why(pr) ? `dropped from ${ctx.build!.name}: ${why(pr)}` : `left out of ${ctx.build!.name}: it waits for the next build`));
        return { ...result(e, 'failed', words, { url: cars[0].pr.url }), merged: [], held, did: [words], waits: [], lookAgain: true };
      }
      ctx.log(`[${e.id}] no batch for ${numbers}: ${b.note}`);
    }
  }
  // Two team PRs that set one version: neither goes first, or the second would conflict, or share its version. One
  // stamped as it merges (changes/<version>.md) is given a free version then, so it never clashes.
  let merge: PrInfo[] = [];
  for (const r of ready) {
    const same = r.sets && !r.stamps ? ready.filter((x) => x.sets === r.sets && !x.stamps) : [];
    if (same.length > 1) {
      hold.push({ pr: r.pr, why: `${same.map((x) => `#${x.pr.number}`).join(' and ')} ${same.length === 2 ? 'both' : 'all'} set v${r.sets}: each needs a version of its own` });
      // The first keeps its version; each after it gets one of its own.
      if (r.pr.whose === 'team' && r.pr.number !== Math.min(...same.map((x) => x.pr.number))) catchable.set(r.pr.number, r.pr);
    } else merge.push(r.pr);
  }
  // Only the conflicts: each caught up now, the versions the ready ones set kept free; the merges are the round's.
  if (only) {
    const caught = await catchUpAll(ctx, e, { catchable: new Map(conflicting.map((pr) => [pr.number, pr])), failedHere: [], ready, merged: [], held: [], lookup });
    for (const pr of conflicting) conflictTried.set(triedKey(e, pr), triedAt(pr, branchHead));
    return { ...result(e, caught.done ? 'done' : 'skipped', caught.lines.join('; '), { url: conflicting[0].url }), merged: [], held: [], did: caught.lines, waits: [] };
  }
  // Lowest version first: of the open PRs that set a new version, only the lowest merges; each above it waits its turn.
  // Merged out of order, the lower one would be left below its branch, to be given a new version and caught up. One
  // whose conflict was handed on gives up its turn, as that is what happens to it anyway (givesWay).
  // Only where two or more could merge; where the versions can't be read, the order is the PRs' as before. With merge
  // trains on, also where none can merge yet (the lowest behind its branch, say): the train may take them all.
  const trains = o.yes && !!o.team && ctx.settings.mergeTrain;
  const queued = prs.filter((p) => p.base === e.branch).length > 1 && (merge.length || trains) && existsSync(checkoutOf(e));
  const pending = queued
    ? await pendingVersions(ctx, e, prs, ready, lookup).catch((err) => {
        ctx.log(`[${e.id}] couldn't read the versions its PRs set, so they merge in their own order: ${(err as Error).message}`);
        return new Map<number, string>();
      })
    : new Map<number, string>();
  // A conflict handed on to its author gives up its turn (givesWay): the queue goes on without it.
  const gaveWay = givesWay(e, hold);
  for (const h of hold) if (gaveWay.has(h.pr.number)) h.why = GAVE_WAY;
  // So does a kit PR its trial fails (trialGivesWay): it is still looked at below, and merges once its trial passes.
  const trialWay = trialGivesWay(e, prs);
  // And one moved past the others (movedPast): not ready, it gives up its turn; ready, it waits its turn at the version
  // it was moved to.
  const moves = movedPast(claimsOn(e.repo), prs, pending);
  for (const h of hold) if (moves.has(h.pr.number) && !gaveWay.has(h.pr.number)) h.why = `${h.why}; ${movedWords(moves.get(h.pr.number)!)}`;
  const going = new Set(merge.map((p) => p.number));
  const queue = new Map([...pending].flatMap(([n, v]): [number, string][] => (gaveWay.has(n) || trialWay.has(n) ? [] : moves.has(n) ? (going.has(n) ? [[n, moves.get(n)!]] : []) : [[n, v]])));
  // A merge train (stages/train.ts): the queue's ready PRs from its lowest version up, stacked, tested once and merged
  // together. Once it has merged, the next look takes what is left; where it didn't, they merge one at a time below.
  let trainLine: string[] = [];
  if (trains && queue.size > 1) {
    // One moved past the others rides in no train: its files still say the version it had.
    const cars = trainCars(prs, moves.size ? new Map([...queue].filter(([n]) => !moves.has(n))) : queue, e.branch);
    if (cars.length) {
      let t: TrainRun;
      try {
        t = await runTrain(ctx, e, cars);
      } catch (err) {
        t = { merged: [], note: `couldn't stack them: ${(err as Error).message}`, tested: false };
      }
      // Between builds: stacked and passed as the build will stack them, and left for it to merge. One that failed is
      // kept as failed (train.ts), so the build merges them one at a time: each is tested at its head below, as then.
      if (t.prepared) {
        const words = `${cars.map((c) => `#${c.pr.number}`).join(', ')}: ${t.note}`;
        ctx.log(`[${e.id}] ${words}`);
        return { ...result(e, 'skipped', words, { url: cars.at(-1)!.pr.url }), merged: [], held: [], did: [words], waits: [] };
      }
      if (t.merged.length) {
        const words = `merged ${t.merged.map((p) => `#${p.number}`).join(', ')} as one train (${t.note})`;
        return { ...result(e, 'done', words, { url: t.merged.at(-1)!.url }), merged: t.merged, held: [], did: [words], waits: [], lookAgain: true };
      }
      // Pushed and waiting for GitHub's checks at the stack: the cars wait as one train, none merged alone meanwhile.
      if (t.waiting) {
        const words = `${cars.map((c) => `#${c.pr.number}`).join(', ')} wait as one train: ${t.note}`;
        ctx.log(`[${e.id}] ${words}`);
        return { ...result(e, 'skipped', words, { url: cars.at(-1)!.pr.url }), merged: [], held: cars.map((c) => heldOf(c.pr, CHECKS_RUNNING)), did: [], waits: [words], lookAgain: false };
      }
      ctx.log(`[${e.id}] no train for ${cars.map((c) => `#${c.pr.number}`).join(', ')}: ${t.note}`);
      if (t.tested) trainLine = [`didn't merge ${cars.map((c) => `#${c.pr.number}`).join(', ')} as one train: ${t.note}`];
    }
  }
  const turnAfter = new Map<number, number>();
  // The kit's PRs (in the Steward's own repository) come first: one waits only for a lower one of the kit's, and the rest,
  // merged after it, are caught up to versions above it. The agents' PRs that take the new kit wait for it (prtest.ts).
  const kitQueue = new Map([...queue].filter(([n]) => prs.some((p) => p.number === n && raisesKit(p))));
  // In the order they merge: the first one's trial tries those queued after it with it, once (trial.ts's combineKits).
  const kitLine = [...kitQueue].sort((a, b) => compareVersions(a[1], b[1]) || a[0] - b[0]).flatMap(([n]) => prs.filter((p) => p.number === n));
  merge = merge.filter((pr) => {
    const v = queue.get(pr.number);
    const below = v ? lowestBelow(raisesKit(pr) ? kitQueue : queue, v) : null;
    if (!below) return true;
    hold.push({ pr, why: `its turn comes after #${below[0]} (v${below[1]}): the lowest version merges first` });
    turnAfter.set(pr.number, below[0]);
    return false;
  });
  // The kit's first, then those that change no version, then by version; but one below a kit PR's version goes before
  // it, so it neither waits for the kit's trial on every agent nor is left below the kit's version and caught up
  // (Steward#171 waited for #170's trial). The kit PR is caught up after it, which keeps its trial (trial.ts).
  const kitVersions = merge.filter(raisesKit).map((p) => pending.get(p.number)).filter((v): v is string => !!v);
  const belowKit = (pr: PrInfo) => !raisesKit(pr) && pending.has(pr.number) && kitVersions.some((k) => compareVersions(pending.get(pr.number)!, k) < 0);
  const rank = (pr: PrInfo) => (belowKit(pr) ? -1 : raisesKit(pr) ? 0 : pending.has(pr.number) ? 2 : 1);
  merge.sort((a, b) => rank(a) - rank(b) || (pending.has(a.number) && pending.has(b.number) ? compareVersions(pending.get(a.number)!, pending.get(b.number)!) : 0) || a.number - b.number);
  hold.sort((a, b) => a.pr.number - b.pr.number);
  const waits = hold.map((h) => `${describe(h.pr)} waits: ${h.why}`);
  // The same, for the alarms (alarms.ts): each PR that waits, and why; and the PRs that wait their turn after it.
  const behind = (n: number) => [...turnAfter].filter(([, b]) => b === n).map(([m]) => m).sort((a, b) => a - b);
  const held = hold.map((h) => heldOf(h.pr, h.why, behind(h.pr.number)));
  if (!o.yes) {
    const would = merge.map((pr) => {
      const before = untested(pr) ? testedBefore(e, pr) : null;
      const how = !untested(pr) ? '' : !before ? ', once its checks pass here' : before.ok ? ` (${before.note})` : '';
      return before && !before.ok ? `${describe(pr)} waits: ${before.note}` : `${describe(pr)} would be merged${how}`;
    });
    return { ...result(e, 'skipped', [...would, ...waits].join('; ') + (merge.length ? ` (merge --yes${o.team ? ' --team' : ''} merges them)` : ''), { url: prs[0].url }), merged: [], held };
  }
  const merged: PrInfo[] = [];
  const notes = new Map<number, string>();
  const failed: string[] = [];
  let leftToAnother = false;
  // A kit PR whose trial goes on over the rounds (trial.ts): the next round looks at this repository again.
  let trialGoing = false;
  /** Between builds: the PRs whose tests (and kit's trial) passed for the next build, each with what was said of it. */
  const prepared: string[] = [];
  for (const pr of merge) {
    // A merge before this one moved the branch: what this one sets is checked again, against the branch as it is now.
    if (merged.length && pr.whose === 'team') {
      looked = null;
      const c = await check(pr);
      if (c.why) {
        waits.push(`${describe(pr)} waits: ${c.why}`);
        held.push(heldOf(pr, c.why));
        if (c.raise) catchable.set(pr.number, pr);
        continue;
      }
    }
    // Its author ran its checks and saw them pass at this very head (stages/vouch.ts): not tested here again.
    // Its vouch set here, once its checks passed here (prtest.ts): what this PC's test said.
    const vouched = untested(pr) ? await vouchedBy(ctx, e, pr, ctx.settings.team) : null;
    const here = vouched ? testedBefore(e, pr) : null;
    if (vouched) notes.set(pr.number, here?.ok ? here.note : `checks passed at ${pr.headOid.slice(0, 7)} in ${vouched}'s clone, vouched for`);
    else if (untested(pr)) {
      // Its kit not released yet: not tested, nor held against its commit, until it is; its hold names the Steward PR
      // that brings that kit, or says none does (prtest.ts).
      const kitWaits = await kitReleaseHold(ctx, e, pr).catch(() => null);
      if (kitWaits) {
        waits.push(`${describe(pr)} waits: ${kitWaits}`);
        held.push(heldOf(pr, kitWaits));
        continue;
      }
      const before = testedBefore(e, pr);
      let t: Tested;
      try {
        t = await timed(phaseOf(ctx), 'tests', `${e.id} #${pr.number}`, () => testAtHead(ctx, e, pr));
      } catch (err) {
        t = { ok: false, note: `couldn't test it here: ${(err as Error).message}`, at: new Date().toISOString() };
      }
      if (!t.ok) {
        // Failing here for the first time is worth a word; after that it waits quietly for a new push.
        if (before) waits.push(`${describe(pr)} waits: ${t.note}`);
        else failed.push(`#${pr.number}: ${t.note}`);
        held.push(heldOf(pr, t.note));
        failedHere.push({ pr, t });
        continue;
      }
      notes.set(pr.number, t.note);
    }
    // A PR to the Steward that raises the kit: the new kit tried on every agent first (stages/trial.ts).
    let trial: string | null;
    try {
      // An agent that moves with the kit in a PR of its own doesn't hold it, and its line says so ("Manor moves with it in #135").
      trial = await kitTrialHold(ctx, e, pr, { line: kitLine, going: () => (trialGoing = true), note: (words) => notes.set(pr.number, notes.has(pr.number) ? `${notes.get(pr.number)}; ${words}` : words) });
    } catch (err) {
      trial = `couldn't try its kit on the agents: ${(err as Error).message}`;
    }
    if (trial) {
      if (trialWay.has(pr.number)) trial += '; meanwhile it gives up its turn, so the PRs above it merge first';
      waits.push(`${describe(pr)} waits: ${trial}`);
      held.push(heldOf(pr, trial));
      // A kit its trial fails, while its branch changed the kit since it left it: caught up, so it is tried again with
      // what the branch fixed meanwhile, rather than waiting for its author (trial.ts's kitMovedUnder).
      if (trialFails(trial) && !pr.fork && !pr.draft && (pr.whose === 'team' || isKitPr(pr))) {
        await lookup().catch(() => null);
        if (await kitMovedUnder(ctx, e, pr).catch(() => false)) catchable.set(pr.number, pr);
      }
      continue;
    }
    // Between builds: its test and its kit's trial done, it merges at the build, which finds them.
    if (prep) {
      prepared.push(`#${pr.number}${notes.has(pr.number) ? ` (${notes.get(pr.number)})` : ''}`);
      continue;
    }
    // Another PC took its turn here meanwhile (lease.ts): it merges the rest.
    if (ctx.lease && !(await ctx.lease.ok(e))) {
      waits.push(`${describe(pr)} and the rest are left to another PC, whose turn it is now`);
      leftToAnother = true;
      break;
    }
    // Written as changes/<version>.md (entries.ts): stamped on its own branch now, and merged at the stamped head.
    let head = pr.headOid;
    if (!pr.fork && (await usesChanges(ctx, e).catch(() => false))) {
      const s = await stampBefore(ctx, e, pr, { ready, merged, carry: untested(pr) ? (notes.get(pr.number) ?? null) : null, lookup });
      if (!s.done && !s.nothing) {
        waits.push(`${describe(pr)} waits: ${s.note}`);
        held.push(heldOf(pr, s.note));
        continue;
      }
      if (s.done) {
        notes.set(pr.number, notes.has(pr.number) ? `${notes.get(pr.number)}; ${s.note}` : s.note);
        // Checks on GitHub run again at the stamped head: it merges once they pass, with nothing more to stamp.
        if (!untested(pr) && pr.checks !== 'none') {
          const why = `${s.note}; its checks on GitHub run again at the stamped head`;
          waits.push(`${describe(pr)} waits: ${why}`);
          held.push(heldOf(pr, why));
          continue;
        }
        head = s.head!;
      }
    }
    // Only the Steward's own branch is deleted: a team member's may still be checked out somewhere.
    const mine = pr.whose === 'steward';
    // Only the head commit looked at and tested: one pushed since (a catch-up's, a person's) is refused, and waits.
    // The PC kept awake while it merges (the kit's awake.ts), as while it tests (runChecks).
    const r = await timed(phaseOf(ctx), 'merges', `${e.id} #${pr.number}`, () =>
      whileAwake(`${e.name} #${pr.number}'s merge`, () => hostFor({ ...ctx, run }, e).mergePr(e.repo, pr.number, { ...(head ? { matchHead: head } : {}), deleteBranch: mine }), ctx.log),
    );
    if (r.code !== 0) {
      const why = (r.err || r.out).trim().split('\n').pop();
      failed.push(`#${pr.number}: ${why}`);
      held.push(heldOf(pr, `couldn't merge it: ${why}`));
      continue;
    }
    merged.push(pr);
    // This Steward's merge, not someone else's (strangers.ts).
    noteMerged(e, pr.number);
    // Its new head shared with the other agents a moment from now, not at the next round's glance (heads.ts).
    headsMoved(e.repo);
    // Its branch has moved: from here on it is read afresh, not from the glance.
    forgetGlance(ctx, e);
    ctx.log(`[${e.id}] merged #${pr.number} (${pr.head}${mine ? '' : `, ${pr.author}'s`}${notes.has(pr.number) ? `; ${notes.get(pr.number)}` : ''})`);
    // The Steward's own worktree and branch for it are done with.
    const repo = checkoutOf(e);
    if (mine && pr.head.startsWith('steward/kit-') && existsSync(repo)) {
      try {
        for (const line of await removeWorktree(run, repo, bumpDirOf(ctx.settings, e), pr.head)) ctx.log(`[${e.id}] ${line}`);
      } catch (err) {
        ctx.log(`[${e.id}] couldn't tidy up after #${pr.number}: ${(err as Error).message}`);
      }
    }
  }
  // One whose turn came this round (the PR below it merged) is caught up now, and merges at the next round.
  const mergedNow = new Set(merged.map((p) => p.number));
  for (const [n, below] of turnAfter) {
    const pr = prs.find((p) => p.number === n)!;
    if (mergedNow.has(below) && !pr.fork && (pr.whose === 'team' || isKitPr(pr))) catchable.set(n, pr);
  }
  // Between builds, nothing is caught up (a catch-up pushes): what passed, failed and waits, for prepare.ts's line.
  if (prep) {
    const words = [...(prepared.length ? [`ready for ${ctx.prepare!.name}: ${prepared.join(', ')}`] : []), ...trainLine, ...failed.map((f) => `failed ${f}`), ...waits];
    return { ...result(e, failed.length ? 'failed' : 'skipped', words.join('; ') || 'nothing to prepare', { url: prs[0].url }), merged: [], held, did: words, waits };
  }
  const caught = o.team && ctx.settings.catchUp ? await catchUpAll(ctx, e, { catchable, failedHere, ready, merged, held, lookup: () => ((looked = null), lookup()) }) : { lines: [], testedHere: false, gaveWay: false };
  const mergedWords = merged.map((p) => `#${p.number}${notes.has(p.number) ? ` (${notes.get(p.number)})` : ''}`);
  const did = [...trainLine, ...(merged.length ? [`merged ${mergedWords.join(', ')}`] : []), ...failed.map((f) => `didn't merge ${f}`)];
  const parts = [...did, ...waits, ...caught.lines];
  const outcome = failed.length ? 'failed' : merged.length ? 'done' : 'skipped';
  return { ...result(e, outcome, parts.join('; '), { url: (merged[0] ?? prs[0]).url }), merged, held, did: [...did, ...caught.lines], waits, lookAgain: !leftToAnother && !trialGoing && lookAgainAfter({ merged: merged.length, held, testedHere: caught.testedHere, gaveWay: caught.gaveWay }), ...(trialGoing ? { again: true } : {}) };
}

/**
 * A backstop only: at most this many looks at one employee's PRs in a round. The queue ends the looks long before
 * (mergeLooks); should it not, the next round goes on where this one stopped.
 */
export const MAX_LOOKS = 40;

/**
 * An employee's PRs, looked at again and again in the same round while there is more to merge (MergeLook's
 * `lookAgain`): a PR caught up that the Steward tests itself is tested at its new head and merged, and the next one in
 * the version queue, caught up in turn, goes the same way, until the queue runs out. So a repository's queue of PRs
 * drains in one round, where it took a round each (and, in 0.27.29, five at most). A PR with checks on GitHub waits for
 * them, at the next round (which comes sooner: agent.ts). Every hold and rule of mergeOne's applies at each look. The
 * looks end once one leaves nothing more to merge, or two in a row merge nothing (a PR caught up and then failing here
 * isn't caught up again until its branch moves, so nothing goes round in circles), or at MAX_LOOKS, after which the
 * next round looks at it again whatever GitHub says. One result: everything merged, done and caught up, then what waits
 * after the last look.
 */
export async function mergeLooks(ctx: Ctx, e: Employee, o: { yes: boolean; team?: boolean }): Promise<MergeLook> {
  // The claimed branches pushed and vouched for with no PR: their PRs opened first, so the looks below merge them (branchesin.ts).
  // Worked with plain git, there are none to open: its When a branch is ready command hands them in (gitevents.ts).
  const byGit = hostIs(ctx, e) === 'git';
  const opened = !(o.yes && o.team && e.merges) ? { lines: [], failed: false, handed: 0 } : byGit ? await handInBranches(ctx, e) : await openVouchedBranches(ctx, e).then((r) => ({ ...r, failed: false, handed: r.opened.length }));
  const looks: MergeLook[] = [await mergeOne(ctx, e, o)];
  if (opened.lines.length) {
    const first = looks[0];
    const outcome = opened.failed ? ('failed' as const) : first.outcome === 'skipped' && opened.handed ? ('done' as const) : first.outcome;
    looks[0] = { ...first, message: [...opened.lines, first.message].filter(Boolean).join('; '), did: [...opened.lines, ...(first.did ?? [])], outcome };
  }
  const idle = (l: MergeLook | undefined) => !!l && !l.merged.length;
  while (o.yes && looks.at(-1)!.lookAgain && !(idle(looks.at(-1)) && idle(looks.at(-2))) && looks.length < MAX_LOOKS) {
    const n = looks.reduce((a, l) => a + l.merged.length, 0);
    ctx.log(`[${e.id}] more of its PRs can merge: looking at them again this round (look ${looks.length + 1}; ${n} merged so far)`);
    looks.push(await mergeOne(ctx, e, o));
  }
  const cut = looks.length >= MAX_LOOKS && !!looks.at(-1)!.lookAgain;
  if (cut) ctx.log(`[${e.id}] looked at its PRs ${MAX_LOOKS} times this round: the next round goes on`);
  if (looks.length === 1) return looks[0];
  const last = looks.at(-1)!;
  const merged = looks.flatMap((l) => l.merged);
  const parts = [...looks.flatMap((l) => l.did ?? []), ...(last.waits ?? [])];
  const outcome = looks.some((l) => l.outcome === 'failed') ? 'failed' : merged.length ? 'done' : last.outcome;
  return { ...last, outcome, message: parts.join('; ') || last.message, url: merged[0]?.url ?? last.url, merged, did: looks.flatMap((l) => l.did ?? []), ...(cut ? { again: true } : {}) };
}

/**
 * What passed at a team PR's head as it is now, for its catch-up to carry to the head it pushes (catchup.ts
 * keepsStanding): its author's vouch (vouch.ts), else its checks passing here (prtest.ts); null when neither, or when
 * GitHub runs its checks (they run again at the new head whatever the Steward says). Never throws.
 */
export async function standingOf(ctx: Ctx, e: Employee, pr: PrInfo): Promise<string | null> {
  if (!untested(pr) || pr.fork) return null;
  const vouched = await vouchedBy(ctx, e, pr, ctx.settings.team).catch(() => null);
  if (vouched) return `checks passed at ${pr.headOid.slice(0, 7)} in ${vouched}'s clone, vouched for`;
  const t = testedBefore(e, pr);
  // One carried already says where it came from once: caught up again, it is carried on from there.
  return t?.ok ? t.note.split('; carried to ')[0] : null;
}

/**
 * A PR stamped just before it merges (stages/stamp.ts), with the versions it can't have: those released, those the other
 * PRs still to merge set, and those other work has claimed (claims.ts); the kit's too, in the Steward's own repository.
 * Its claim then follows the version it was given. Never throws.
 */
async function stampBefore(ctx: Ctx, e: Employee, pr: PrInfo, o: { ready: { pr: PrInfo; sets: string | null }[]; merged: PrInfo[]; carry: string | null; lookup: Lookup }): Promise<StampResult> {
  try {
    const { released } = await o.lookup();
    const gone = new Set([pr.number, ...o.merged.map((p) => p.number)]);
    const others = o.ready.filter((r) => !gone.has(r.pr.number));
    const taken = [...others.flatMap((r) => (r.sets ? [r.sets] : [])), ...claimsOn(e.repo).filter((c) => c.branch !== pr.head).map((c) => c.version)];
    const kit = existsSync(path.join(checkoutOf(e), KIT_VERSION_FILE))
      ? { released: (await kitInfo(ctx.run, ctx.neutralDir, e.repo).catch(() => ({ released: [] as string[] }))).released, taken: [...kitTitleVersions(others.map((r) => r.pr.title)), ...claimsOn(kitClaimKey(e.repo)).filter((c) => c.branch !== pr.head).map((c) => c.version)] }
      : undefined;
    const s = await stamp(ctx, e, pr, { released, taken, carry: o.carry, ...(kit ? { kit } : {}) });
    if (s.done) {
      // Its branch has moved: from here on it is read afresh, not from the glance.
      forgetGlance(ctx, e);
      if (s.version) await reclaim(e.repo, pr.head, s.version).catch(() => {});
    }
    return s;
  } catch (err) {
    return { done: false, note: `couldn't stamp its version: ${(err as Error).message}` };
  }
}

/**
 * After the merges: each PR that waits only on its branch, caught up (stages/catchup.ts), lowest number first, each
 * new version then taken; a PR whose checks failed here only when its branch has moved since. Each one's hold then
 * says what happened. One line each, for the stage's result; and whether it caught up a PR GitHub runs no checks on
 * (the Steward tests it itself, so it can be merged this round: mergeLooks); and whether it handed on the conflict of a
 * PR that others waited their turn behind (it gives up its turn at the next look: givesWay).
 */
async function catchUpAll(ctx: Ctx, e: Employee, o: { catchable: Map<number, PrInfo>; failedHere: { pr: PrInfo; t: Tested }[]; ready: { pr: PrInfo; sets: string | null }[]; merged: PrInfo[]; held: Held[]; lookup: Lookup }): Promise<{ lines: string[]; testedHere: boolean; gaveWay: boolean; done: number }> {
  for (const { pr, t } of o.failedHere) if (pr.whose === 'team' && !pr.fork) o.catchable.set(pr.number, pr);
  if (!o.catchable.size) return { lines: [], testedHere: false, gaveWay: false, done: 0 };
  const { released } = await o.lookup();
  const now = await commitOf(ctx.run, checkoutOf(e), `origin/${e.branch}`);
  for (const { pr, t } of o.failedHere) if (t.branch && t.branch === now) o.catchable.delete(pr.number);
  const merged = new Set(o.merged.map((p) => p.number));
  const taken = o.ready.filter((r) => r.sets && !merged.has(r.pr.number) && !o.catchable.has(r.pr.number)).map((r) => r.sets!);
  const lines: string[] = [];
  let testedHere = false;
  let gaveWay = false;
  let done = 0;
  const kitTaken: string[] = [];
  let kitReleases: string[] | null = null;
  const kitReleased = async () => (kitReleases ??= (await kitInfo(ctx.run, ctx.neutralDir, e.repo).catch(() => ({ released: [] as string[] }))).released);
  for (const pr of [...o.catchable.values()].sort((a, b) => a.number - b.number)) {
    let c: CaughtUp;
    try {
      // Versions claimed up front by other work are taken too (claims.ts); this PR's own branch's claim is its own.
      const claimed = claimsOn(e.repo).filter((x) => x.branch !== pr.head).map((x) => x.version);
      // The kit's too, in the Steward's own repository (stages/kitpart.ts): its releases, and the kit versions other
      // PRs name and other work has claimed.
      const kit = existsSync(path.join(checkoutOf(e), KIT_VERSION_FILE))
        ? { released: await kitReleased(), taken: [...kitTaken, ...kitTitleVersions(o.ready.filter((r) => r.pr.number !== pr.number && !merged.has(r.pr.number)).map((r) => r.pr.title)), ...claimsOn(kitClaimKey(e.repo)).filter((x) => x.branch !== pr.head).map((x) => x.version)] }
        : undefined;
      // One moved past the others (move-past.ts) is caught up to the version it was moved to.
      c = await catchUp(ctx, e, pr, { released, taken: [...taken, ...claimed], ...(kit ? { kit } : {}), carry: await standingOf(ctx, e, pr), own: movedTo(claimsOn(e.repo), pr) });
    } catch (err) {
      c = { done: false, note: `couldn't: ${(err as Error).message}` };
    }
    if (c.version) taken.push(c.version);
    if (c.kitVersion) kitTaken.push(c.kitVersion);
    // Its branch's claims follow the versions it now carries, so no one is handed them, and its worker asking again gets them.
    if (c.done && c.version) await reclaim(e.repo, pr.head, c.version).catch(() => {});
    if (c.done && c.kitVersion) await reclaim(kitClaimKey(e.repo), pr.head, c.kitVersion).catch(() => {});
    if (c.done) {
      // Its branch has moved: from here on it is read afresh, not from the glance.
      forgetGlance(ctx, e);
      done++;
      if (pr.checks === 'none') testedHere = true;
    }
    // A conflict that needs judgement goes back to whoever wrote the PR (stages/kickback.ts), not to the person.
    let sent = false;
    if (c.conflicts?.length && pr.whose === 'team') {
      try {
        const k = await kickBack(ctx, e, pr, c.conflicts, now);
        c = { ...c, done: false, closed: k.closed, note: k.note };
        sent = k.sent;
      } catch (err) {
        c = { ...c, note: `${c.note} (couldn't send it back to its author: ${(err as Error).message})` };
      }
    }
    lookedAtConflict(e, pr, c, sent);
    const h = o.held.find((x) => x.number === pr.number);
    if (h && c.conflicts?.length) h.files = c.conflicts;
    // Handed on while others wait their turn behind it: the next look lets it give up its turn (givesWay).
    if (h?.blocks?.length && sent && !c.closed && c.conflicts?.length) gaveWay = true;
    if (h) h.why = c.done ? `${CAUGHT_UP} (${c.note}): ${c.carried ? 'it merges without being tested again' : 'it merges once its checks pass at the new head'}` : c.closed ? `closed by the Steward: ${c.note}` : `${h.why} (not caught up: ${c.note})`;
    // A closed PR waits for nothing: no alarm counts its hours.
    if (h && c.closed) o.held.splice(o.held.indexOf(h), 1);
    lines.push(c.done ? `#${pr.number} caught up: ${c.note}` : c.closed ? `#${pr.number} closed: ${c.note}` : `#${pr.number} not caught up: ${c.note}`);
  }
  return { lines, testedHere, gaveWay, done };
}

/** Why a catch-up didn't try: nothing the page's conflicts need to show. */
const NOT_TRIED = new Set(['nothing to catch up', 'its branch moved since this round listed it']);

/**
 * A PR that conflicts with its branch, as the round left it, for the page (conflicts.ts): one GitHub says conflicts,
 * or whose merge here conflicted. One that was only behind isn't one.
 */
function lookedAtConflict(e: Employee, pr: PrInfo, c: CaughtUp, sent: boolean): void {
  const files = c.conflicted ?? [];
  if (!files.length && pr.mergeable !== 'CONFLICTING' && pr.mergeState !== 'DIRTY') return;
  if (!files.length && NOT_TRIED.has(c.note)) return;
  const outcome: ConflictOutcome = c.done ? 'caught-up' : c.closed ? 'closed' : sent ? 'sent-back' : 'couldnt';
  try {
    noteConflict({ id: e.id, name: e.name, repo: e.repo, number: pr.number, url: pr.url, title: pr.title, head: pr.head, author: pr.author, headOid: pr.headOid, outcome, note: c.note, files, needs: c.conflicts ?? [] });
  } catch {
    // The page's record only: the round goes on without it.
  }
}

/**
 * Each team PR stacked on another branch (its base isn't the employee's branch, nor an open PR's head) whose own PR has
 * merged into the employee's branch, pointed at the branch instead (gh pr edit --base), with one comment on it saying
 * why. Its `base` is then the branch, and GitHub works out afresh whether it merges: asked again (askAgainWhetherMerges),
 * it merges in the same round once GitHub has said, and waits a round only when GitHub hasn't by then. A
 * base still open, or one whose PR merged elsewhere or never was one, is left as it is. Never throws: a PR it couldn't
 * retarget is logged and waits as before. Returns the numbers retargeted.
 */
export async function retargetStacked(ctx: Ctx, e: Employee, prs: PrInfo[]): Promise<number[]> {
  const done: number[] = [];
  for (const pr of prs) {
    if (pr.whose !== 'team' || pr.fork || !pr.base || pr.base === e.branch || stackedOn(pr, prs, e.branch)) continue;
    try {
      const host = hostFor(ctx, e);
      const out = must(await host.listPrs(e.repo, { state: 'merged', head: pr.base, limit: 5, fields: 'number,baseRefName' }));
      const under = (JSON.parse(out || '[]') as { number: number; baseRefName: string }[]).find((m) => m.baseRefName === e.branch);
      if (!under) continue;
      must(await host.editPr(e.repo, pr.number, { base: e.branch }));
      const was = pr.base;
      pr.base = e.branch;
      pr.mergeable = 'UNKNOWN';
      done.push(pr.number);
      ctx.log(`[${e.id}] #${pr.number}: pointed at ${e.branch}: it was stacked on ${was}, whose #${under.number} has merged`);
      const body = `The Steward pointed this pull request at \`${e.branch}\`: it was stacked on \`${was}\`, whose #${under.number} has merged into \`${e.branch}\`. It now waits in ${e.branch}'s line like any other.`;
      await host.commentPr(e.repo, pr.number, body).catch(() => null);
    } catch (err) {
      ctx.log(`[${e.id}] #${pr.number}: couldn't point it at ${e.branch} (stacked on ${pr.base}): ${(err as Error).message}`);
    }
  }
  return done;
}

/** Each employee's merges, a few employees at a time (Settings' parallel), each one's PRs in order, looked at again until its queue runs out (mergeLooks). */
export async function merge(ctx: Ctx, employees: Employee[], o: { yes: boolean; team?: boolean }): Promise<MergeLook[]> {
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await withRepo(ctx.log, e.id, () => mergeLooks(ctx, e, o));
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return { ...result(e, 'failed', (err as Error).message), merged: [], held: [] };
    }
  });
}
