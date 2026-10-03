import { existsSync } from 'node:fs';
import { afterWords } from '../after.ts';
import { fetchBranch, gh, git, removeWorktree, showFile } from '../git.ts';
import { compareVersions } from '../kitfiles.ts';
import type { Employee } from '../settings.ts';
import { agreedVersion } from '../versions.ts';
import { bumpDirOf, checkoutOf, NOT_ON_KIT, result, type Ctx, type EmployeeResult } from './common.ts';
import { appReleasesIn, parsePrs, prListArgs, type PrInfo } from './staff.ts';

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
 * install with no install command in Settings, or a release of a version that is already released. With
 * --yes, the steps run after the merge (stages/aftermerge.ts).
 */

/** Why a PR waits, or null when it can be merged: into the employee's branch, mergeable, not a draft, and its checks passing (or none). */
export function holdReason(pr: PrInfo, branch?: string): string | null {
  if (branch && pr.base && pr.base !== branch) return `it merges into ${pr.base}, not ${branch}`;
  if (pr.draft) return 'a draft';
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

/** What the after-merge checks need from origin, looked up once per employee: its released versions, and its branch's version. */
type Lookup = () => Promise<{ released: string[]; base: string | null }>;

/**
 * Why the steps a mergeable PR asks for couldn't happen, or null: an install or approval with no command for it in
 * Settings, or a release whose version (the PR's, or its branch's when that is higher) is already released.
 */
export async function afterHold(ctx: Ctx, e: Employee, pr: PrInfo, lookup: Lookup): Promise<string | null> {
  const a = pr.after;
  if (!a) return null;
  if (a.steps.includes('install') && !e.install) return `it asks for install, but Settings give ${e.name} no install command`;
  if (a.steps.includes('approve-jobs') && !e.approve) return `it asks for approve-jobs, but Settings give ${e.name} no approve command`;
  if (!a.steps.includes('release')) return null;
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return `it asks for a release, but there's no checkout at ${repo} to read its version from`;
  const { released, base } = await lookup();
  // The PR's head, fetched by its number (a fork's too), read at the commit GitHub named.
  await git(ctx.run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
  const at = pr.headOid || 'FETCH_HEAD';
  const head = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(ctx.run, repo, at, f)] as [string, string | null])));
  if ('error' in head) return `it asks for a release, but its branch has ${head.error}`;
  const version = base && compareVersions(base, head.version) > 0 ? base : head.version;
  if (released.includes(version)) return `it asks for a release, but v${version}, its version once merged, is already released: raise the version in the PR`;
  return null;
}

export async function mergeOne(ctx: Ctx, e: Employee, o: { yes: boolean; team?: boolean }): Promise<EmployeeResult & { merged: PrInfo[] }> {
  const { run } = ctx;
  // The team's PRs have nothing to do with the kit; the Steward's exist only for an employee on it.
  if (!e.usesKit && !o.team) return { ...result(e, 'skipped', NOT_ON_KIT), merged: [] };
  // With no team, only the Steward's are read.
  const prs = parsePrs(await gh(run, ctx.neutralDir, ...prListArgs(e.repo)), o.team ? ctx.settings.team : []);
  if (!prs.length) return { ...result(e, 'skipped', o.team ? "no open PRs of the Steward's or the team's" : 'no open Steward PRs'), merged: [] };
  const { merge: mergeable, hold } = mergeSelection(prs, e.branch);
  let looked: ReturnType<Lookup> | null = null;
  const lookup: Lookup = () =>
    (looked ??= (async () => {
      const repo = checkoutOf(e);
      await fetchBranch(run, repo, e.branch);
      const base = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, `origin/${e.branch}`, f)] as [string, string | null])));
      const released = appReleasesIn(await gh(run, ctx.neutralDir, 'release', 'list', '--repo', e.repo, '--limit', '100', '--json', 'tagName,isDraft,publishedAt')).map((r) => r.version);
      return { released, base: 'version' in base ? base.version : null };
    })());
  const merge: PrInfo[] = [];
  for (const pr of mergeable) {
    let why: string | null;
    try {
      why = await afterHold(ctx, e, pr, lookup);
    } catch (err) {
      why = `couldn't check what it asks for after merging: ${(err as Error).message}`;
    }
    if (why) hold.push({ pr, why });
    else merge.push(pr);
  }
  hold.sort((a, b) => a.pr.number - b.pr.number);
  const waits = hold.map((h) => `${describe(h.pr)} waits: ${h.why}`);
  if (!o.yes) {
    const would = merge.map((pr) => `${describe(pr)} would be merged`);
    return { ...result(e, 'skipped', [...would, ...waits].join('; ') + (merge.length ? ` (merge --yes${o.team ? ' --team' : ''} merges them)` : ''), { url: prs[0].url }), merged: [] };
  }
  const merged: PrInfo[] = [];
  const failed: string[] = [];
  for (const pr of merge) {
    // Only the Steward's own branch is deleted: a team member's may still be checked out somewhere.
    const mine = pr.whose === 'steward';
    const r = await run('gh', ['pr', 'merge', String(pr.number), '--repo', e.repo, '--merge', ...(mine ? ['--delete-branch'] : [])], { cwd: ctx.neutralDir, timeoutMs: 5 * 60_000 });
    if (r.code !== 0) {
      failed.push(`#${pr.number}: ${(r.err || r.out).trim().split('\n').pop()}`);
      continue;
    }
    merged.push(pr);
    ctx.log(`[${e.id}] merged #${pr.number} (${pr.head}${mine ? '' : `, ${pr.author}'s`})`);
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
  const parts = [...(merged.length ? [`merged ${merged.map((p) => `#${p.number}`).join(', ')}`] : []), ...failed.map((f) => `couldn't merge ${f}`), ...waits];
  const outcome = failed.length ? 'failed' : merged.length ? 'done' : 'skipped';
  return { ...result(e, outcome, parts.join('; '), { url: (merged[0] ?? prs[0]).url }), merged };
}

export async function merge(ctx: Ctx, employees: Employee[], o: { yes: boolean; team?: boolean }): Promise<(EmployeeResult & { merged: PrInfo[] })[]> {
  const out: (EmployeeResult & { merged: PrInfo[] })[] = [];
  for (const e of employees) {
    try {
      out.push(await mergeOne(ctx, e, o));
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      out.push({ ...result(e, 'failed', (err as Error).message), merged: [] });
    }
  }
  return out;
}
