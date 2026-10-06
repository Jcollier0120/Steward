import { existsSync } from 'node:fs';
import { afterWords } from '../after.ts';
import { commitOf, gh, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { NO_TEAM } from '../team.ts';
import { compareVersions } from '../kitfiles.ts';
import { bailiffInstalled, type Employee } from '../settings.ts';
import { agreedVersion } from '../versions.ts';
import { catchUp, isKitPr, type CaughtUp } from './catchup.ts';
import { bumpDirOf, checkoutOf, forgetGlance, freshBranch, glanceOf, mapLimit, NOT_ON_KIT, releasedOf, result, type Ctx, type EmployeeResult } from './common.ts';
import { testAtHead, testedBefore, type Tested } from './prtest.ts';
import { kickBack } from './kickback.ts';
import { kitTrialHold } from './trial.ts';
import { claimsOn } from '../claims.ts';
import type { Held } from '../alarms.ts';
import { bailiffHold, dependencyHold, isWrightDraft, reviewedComment, reviewHold } from '../review.ts';
import { parsePrs, prListArgs, type PrInfo } from './staff.ts';

/**
 * Stage 3, `steward merge [--yes] [--team]`: the Steward's open PRs (head steward/…), each with its checks
 * and whether it merges; with --team, the team's open PRs too (those the GitHub accounts in Settings'
 * Team opened, from any branch, to any employee, on the kit or not). With --yes (the page's buttons ask
 * first), those that merge cleanly into the employee's branch and have no failing or running checks are
 * merged with a merge commit. The Steward deletes its own branch and worktree after; a team member's
 * branch is theirs, and stays. The rest wait, and say why.
 *
 * A PR can ask for steps after it is merged, in a steward block in its description (src/after.ts): release,
 * install, approve-jobs. One whose block can't be read waits, and so does one whose steps couldn't happen: an
 * approval with no approve command in Settings, or a release of a version that is already released. An install with
 * no install command in Settings doesn't hold it: that employee is installed another way (Heiward, by Manor, from its
 * own installer), so the step is skipped after the merge, and its line says so. With --yes, the steps run after the
 * merge (stages/aftermerge.ts).
 *
 * A team PR is held to more, since no one asked for it here: the version it sets must be new (not released, above
 * its branch's, and no other ready PR's), and one GitHub runs no checks on is tested here first, at its head
 * commit, with the employee's own checks (stages/prtest.ts). The Steward's own PRs were tested by their bump. A team PR
 * to the Steward's own repository that raises the kit waits, too, until the new kit passes every agent's checks
 * (stages/trial.ts), or is labelled to say the agents change with it.
 *
 * With --yes --team, and Settings' catchUp on, a ready team PR that waits only on its branch having moved is caught up
 * (stages/catchup.ts): one that conflicts with its branch or is behind it, whose version is no longer new, or whose
 * checks failed here before the branch moved on. The next round tests it at its new head, and merges it.
 */

/** Why a PR waits, or null when it can be merged: into the employee's branch, mergeable, not a draft, and its checks passing (or none: a team PR with none is then tested here). */
export function holdReason(pr: PrInfo, branch?: string): string | null {
  if (branch && pr.base && pr.base !== branch) return `it merges into ${pr.base}, not ${branch}`;
  if (pr.draft) return pr.reviewHold ? `a draft from the Wright, waiting for you: ${pr.reviewHold}` : pr.bailiffHold ? `a draft from the Wright, with the Bailiff: ${pr.bailiffHold}` : 'a draft';
  if (pr.afterError) return pr.afterError;
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return 'conflicts with its branch';
  if (pr.mergeable !== 'MERGEABLE') return 'GitHub is still working out whether it merges: try again in a minute';
  if (pr.checks === 'failing') return 'checks failing';
  if (pr.checks === 'pending') return 'checks still running';
  if (pr.mergeState === 'BLOCKED') return 'blocked: a required review or check';
  if (pr.mergeState === 'BEHIND') return 'behind its branch, which must be up to date to merge';
  return null;
}

/** The PRs to merge, and the ones that wait with their reasons. */
export function mergeSelection(prs: PrInfo[], branch?: string): { merge: PrInfo[]; hold: { pr: PrInfo; why: string }[] } {
  const merge: PrInfo[] = [];
  const hold: { pr: PrInfo; why: string }[] = [];
  for (const pr of prs) {
    const why = holdReason(pr, branch);
    if (why) hold.push({ pr, why });
    else merge.push(pr);
  }
  return { merge, hold };
}

const describe = (pr: PrInfo) => `#${pr.number} (${pr.head}${pr.whose === 'team' ? `, ${pr.author}'s` : ''}; checks ${pr.checks}; ${pr.mergeable.toLowerCase()}${pr.after ? `; then ${afterWords(pr.after)}` : ''})`;

/** What the checks before a merge need from origin, looked up once per employee (and again after a merge): its released versions, and its branch's version. */
type Lookup = () => Promise<{ released: string[]; base: string | null }>;

/** A PR's version at its head, and where it started (at its merge base with the branch); null where none can be read. */
export async function prVersions(ctx: Ctx, e: Employee, pr: PrInfo): Promise<{ head: string | null; from: string | null }> {
  const { run } = ctx;
  const repo = checkoutOf(e);
  // The PR's head, fetched by its number (a fork's too), read at the commit GitHub named.
  await git(run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
  const at = pr.headOid || 'FETCH_HEAD';
  const read = async (ref: string) => {
    const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, ref, f)] as [string, string | null])));
    return 'version' in v ? v.version : null;
  };
  const start = (await gitMaybe(run, repo, 'merge-base', `origin/${e.branch}`, at))?.trim();
  return { head: await read(at), from: start ? await read(start) : null };
}

/** How a hold that a new version would clear ends: such a PR can be caught up. */
export const RAISE = 'raise the version in the PR';

/**
 * Why the steps a mergeable PR asks for couldn't happen, or null: an approval with no approve command in Settings, or
 * a release whose version once merged (the PR's when it sets one, else its branch's) is already released. An install
 * with no install command isn't one: it is skipped after the merge (stages/aftermerge.ts).
 */
export async function afterHold(ctx: Ctx, e: Employee, pr: PrInfo, lookup: Lookup): Promise<string | null> {
  const a = pr.after;
  if (!a) return null;
  if (a.steps.includes('approve-jobs') && !e.approve) return `it asks for approve-jobs, but Settings give ${e.name} no approve command`;
  if (!a.steps.includes('release')) return null;
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return `it asks for a release, but there's no checkout at ${repo} to read its version from`;
  const { released, base } = await lookup();
  const v = await prVersions(ctx, e, pr);
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
export async function teamHold(ctx: Ctx, e: Employee, pr: PrInfo, lookup: Lookup): Promise<{ why: string | null; sets: string | null; raise?: boolean }> {
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return { why: `there's no checkout at ${repo} to read its version from, or test it in`, sets: null };
  const { released, base } = await lookup();
  const v = await prVersions(ctx, e, pr);
  if (!v.head) return { why: `its branch has no version the Steward can read (${e.versionFiles.join(', ')})`, sets: null };
  if (v.head === v.from) return { why: null, sets: null };
  if (released.includes(v.head)) return { why: `it sets v${v.head}, which is already released: raise it`, sets: v.head, raise: true };
  // Claimed up front by other work (claims.ts): that work keeps it, and this one gets a version of its own.
  const claimed = claimsOn(e.repo).find((c) => c.version === v.head && c.branch && c.branch !== pr.head);
  if (claimed) return { why: `it sets v${v.head}, which ${claimed.by} claimed for ${claimed.for} (${claimed.branch}): it needs a version of its own`, sets: v.head, raise: true };
  if (base && compareVersions(v.head, base) <= 0) return { why: `it sets v${v.head}, but ${e.branch} is at v${base} already: raise it above`, sets: v.head, raise: true };
  return { why: null, sets: v.head };
}

const heldOf = (pr: PrInfo, why: string): Held => ({ number: pr.number, url: pr.url, title: pr.title, why, draft: pr.draft });

/**
 * A ready team PR from the repository itself, or a kit PR of the Steward's, that waits only on its branch: conflicting
 * with it, or behind it.
 */
export const behindItsBranch = (pr: PrInfo, branch: string) =>
  (pr.whose === 'team' || isKitPr(pr)) && !pr.fork && !pr.draft && !pr.afterError && pr.base === branch && (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY' || pr.mergeState === 'BEHIND');

/** A team PR GitHub runs no checks on: the Steward tests it here before it merges it (stages/prtest.ts). */
const untested = (pr: PrInfo) => pr.whose === 'team' && pr.checks === 'none';

/**
 * Each of the Wright's drafts, looked at (review.ts): one that passes is marked ready on GitHub, with a comment saying
 * what was looked at, and goes on as any ready team PR (tested here at its head, then merged); one that doesn't keeps
 * the reason, which its hold then says. Where the Bailiff is installed (`bailiff`), one that passes is marked ready
 * only once the Bailiff has approved its current head commit; until then it waits for the Bailiff, and says so.
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
    if (bailiff) {
      const waits = await bailiffHold(ctx, e, pr);
      if (waits) {
        pr.bailiffHold = waits;
        continue;
      }
    }
    const ready = await ctx.run('gh', ['pr', 'ready', String(pr.number), '--repo', e.repo], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
    if (ready.code !== 0) {
      pr.reviewHold = `the Steward couldn't mark it ready: ${(ready.err || ready.out).trim().split('\n').pop()}`;
      continue;
    }
    await ctx.run('gh', ['pr', 'comment', String(pr.number), '--repo', e.repo, '--body', reviewedComment(pr, s, bailiff)], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
    pr.draft = false;
    ctx.log(`[${e.id}] the Wright's #${pr.number}: looked at, and marked ready (${pr.files.length} files, ${pr.changed} lines)`);
  }
}

export async function mergeOne(ctx: Ctx, e: Employee, o: { yes: boolean; team?: boolean }): Promise<EmployeeResult & { merged: PrInfo[]; held: Held[] }> {
  const { run } = ctx;
  // The team's PRs have nothing to do with the kit; the Steward's exist only for an employee on it.
  if (!e.usesKit && !o.team) return { ...result(e, 'skipped', NOT_ON_KIT), merged: [], held: [] };
  // With no team, only the Steward's are read. From the stage's glance at GitHub when it has them (glance.ts).
  const g = glanceOf(ctx, e);
  const prs = parsePrs(g ? JSON.stringify(g.prs) : await gh(run, ctx.neutralDir, ...prListArgs(e.repo)), o.team ? ctx.settings.team : []);
  const none = !o.team ? 'no open Steward PRs' : ctx.settings.team.length ? "no open PRs of the Steward's or the team's" : `no open Steward PRs (${NO_TEAM})`;
  if (!prs.length) return { ...result(e, 'skipped', none), merged: [], held: [] };
  // The Wright's drafts: the Steward looks at each, and marks ready the ones that pass (review.ts).
  if (o.yes && o.team && ctx.settings.wrightReview.on) await lookAtWrightDrafts(ctx, e, prs);
  const { merge: mergeable, hold } = mergeSelection(prs, e.branch);
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
  const check = async (pr: PrInfo): Promise<{ why: string | null; sets: string | null; raise?: boolean }> => {
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
  const failedHere: { pr: PrInfo; t: Tested }[] = [];
  const ready: { pr: PrInfo; sets: string | null }[] = [];
  for (const pr of mergeable) {
    const c = await check(pr);
    if (c.why) {
      hold.push({ pr, why: c.why });
      if (c.raise && pr.whose === 'team') catchable.set(pr.number, pr);
    } else ready.push({ pr, sets: c.sets });
  }
  // Two team PRs that set one version: neither goes first, or the second would conflict, or share its version.
  const merge: PrInfo[] = [];
  for (const r of ready) {
    const same = r.sets ? ready.filter((x) => x.sets === r.sets) : [];
    if (same.length > 1) {
      hold.push({ pr: r.pr, why: `${same.map((x) => `#${x.pr.number}`).join(' and ')} ${same.length === 2 ? 'both' : 'all'} set v${r.sets}: each needs a version of its own` });
      // The first keeps its version; each after it gets one of its own.
      if (r.pr.whose === 'team' && r.pr.number !== Math.min(...same.map((x) => x.pr.number))) catchable.set(r.pr.number, r.pr);
    } else merge.push(r.pr);
  }
  hold.sort((a, b) => a.pr.number - b.pr.number);
  const waits = hold.map((h) => `${describe(h.pr)} waits: ${h.why}`);
  // The same, for the alarms (alarms.ts): each PR that waits, and why.
  const held = hold.map((h) => heldOf(h.pr, h.why));
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
    if (untested(pr)) {
      const before = testedBefore(e, pr);
      let t: Tested;
      try {
        t = await testAtHead(ctx, e, pr);
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
      trial = await kitTrialHold(ctx, e, pr);
    } catch (err) {
      trial = `couldn't try its kit on the agents: ${(err as Error).message}`;
    }
    if (trial) {
      waits.push(`${describe(pr)} waits: ${trial}`);
      held.push(heldOf(pr, trial));
      continue;
    }
    // Only the Steward's own branch is deleted: a team member's may still be checked out somewhere.
    const mine = pr.whose === 'steward';
    const r = await run('gh', ['pr', 'merge', String(pr.number), '--repo', e.repo, '--merge', ...(mine ? ['--delete-branch'] : [])], { cwd: ctx.neutralDir, timeoutMs: 5 * 60_000 });
    if (r.code !== 0) {
      const why = (r.err || r.out).trim().split('\n').pop();
      failed.push(`#${pr.number}: ${why}`);
      held.push(heldOf(pr, `couldn't merge it: ${why}`));
      continue;
    }
    merged.push(pr);
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
  const caught = o.team && ctx.settings.catchUp ? await catchUpAll(ctx, e, { catchable, failedHere, ready, merged, held, lookup: () => ((looked = null), lookup()) }) : [];
  const mergedWords = merged.map((p) => `#${p.number}${notes.has(p.number) ? ` (${notes.get(p.number)})` : ''}`);
  const parts = [...(merged.length ? [`merged ${mergedWords.join(', ')}`] : []), ...failed.map((f) => `didn't merge ${f}`), ...waits, ...caught];
  const outcome = failed.length ? 'failed' : merged.length ? 'done' : 'skipped';
  return { ...result(e, outcome, parts.join('; '), { url: (merged[0] ?? prs[0]).url }), merged, held };
}

/**
 * After the merges: each PR that waits only on its branch, caught up (stages/catchup.ts), lowest number first, each
 * new version then taken; a PR whose checks failed here only when its branch has moved since. Each one's hold then
 * says what happened. One line each, for the stage's result.
 */
async function catchUpAll(ctx: Ctx, e: Employee, o: { catchable: Map<number, PrInfo>; failedHere: { pr: PrInfo; t: Tested }[]; ready: { pr: PrInfo; sets: string | null }[]; merged: PrInfo[]; held: Held[]; lookup: Lookup }): Promise<string[]> {
  for (const { pr, t } of o.failedHere) if (pr.whose === 'team' && !pr.fork) o.catchable.set(pr.number, pr);
  if (!o.catchable.size) return [];
  const { released } = await o.lookup();
  const now = await commitOf(ctx.run, checkoutOf(e), `origin/${e.branch}`);
  for (const { pr, t } of o.failedHere) if (t.branch && t.branch === now) o.catchable.delete(pr.number);
  const merged = new Set(o.merged.map((p) => p.number));
  const taken = o.ready.filter((r) => r.sets && !merged.has(r.pr.number) && !o.catchable.has(r.pr.number)).map((r) => r.sets!);
  const lines: string[] = [];
  for (const pr of [...o.catchable.values()].sort((a, b) => a.number - b.number)) {
    let c: CaughtUp;
    try {
      // Versions claimed up front by other work are taken too (claims.ts); this PR's own branch's claim is its own.
      const claimed = claimsOn(e.repo).filter((x) => x.branch !== pr.head).map((x) => x.version);
      c = await catchUp(ctx, e, pr, { released, taken: [...taken, ...claimed] });
    } catch (err) {
      c = { done: false, note: `couldn't: ${(err as Error).message}` };
    }
    if (c.version) taken.push(c.version);
    // A conflict that needs judgement goes back to whoever wrote the PR (stages/kickback.ts), not to the person.
    if (c.conflicts?.length && pr.whose === 'team') {
      try {
        const k = await kickBack(ctx, e, pr, c.conflicts, now);
        c = { done: false, closed: k.closed, note: k.note };
      } catch (err) {
        c = { ...c, note: `${c.note} (couldn't send it back to its author: ${(err as Error).message})` };
      }
    }
    const h = o.held.find((x) => x.number === pr.number);
    if (h) h.why = c.done ? `caught up by the Steward (${c.note}): it merges once its checks pass at the new head` : c.closed ? `closed by the Steward: ${c.note}` : `${h.why} (not caught up: ${c.note})`;
    // A closed PR waits for nothing: no alarm counts its hours.
    if (h && c.closed) o.held.splice(o.held.indexOf(h), 1);
    lines.push(c.done ? `#${pr.number} caught up: ${c.note}` : c.closed ? `#${pr.number} closed: ${c.note}` : `#${pr.number} not caught up: ${c.note}`);
  }
  return lines;
}

/** Each employee's merges, a few employees at a time (Settings' parallel), each one's PRs in order. */
export async function merge(ctx: Ctx, employees: Employee[], o: { yes: boolean; team?: boolean }): Promise<(EmployeeResult & { merged: PrInfo[]; held: Held[] })[]> {
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await mergeOne(ctx, e, o);
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return { ...result(e, 'failed', (err as Error).message), merged: [], held: [] };
    }
  });
}
