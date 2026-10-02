import { existsSync } from 'node:fs';
import { gh, removeWorktree } from '../git.ts';
import type { Employee } from '../settings.ts';
import { bumpDirOf, checkoutOf, NOT_ON_KIT, result, type Ctx, type EmployeeResult } from './common.ts';
import { parsePrs, prListArgs, type PrInfo } from './staff.ts';

/**
 * Stage 3, `steward merge [--yes]`: the Steward's open PRs (head steward/…), each with its checks and
 * whether it merges. With --yes (the page's button asks first), those that merge cleanly and have no
 * failing or running checks are merged with a merge commit, and their branch deleted. The rest wait, and
 * say why.
 */

/** Why a PR waits, or null when it can be merged: mergeable, not a draft, and its checks passing (or none). */
export function holdReason(pr: PrInfo): string | null {
  if (pr.draft) return 'a draft';
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return 'conflicts with its branch';
  if (pr.mergeable !== 'MERGEABLE') return 'GitHub is still working out whether it merges: try again in a minute';
  if (pr.checks === 'failing') return 'checks failing';
  if (pr.checks === 'pending') return 'checks still running';
  if (pr.mergeState === 'BLOCKED') return 'blocked: a required review or check';
  if (pr.mergeState === 'BEHIND') return 'behind its branch, which must be up to date to merge';
  return null;
}

/** The PRs to merge, and the ones that wait with their reasons. */
export function mergeSelection(prs: PrInfo[]): { merge: PrInfo[]; hold: { pr: PrInfo; why: string }[] } {
  const merge: PrInfo[] = [];
  const hold: { pr: PrInfo; why: string }[] = [];
  for (const pr of prs) {
    const why = holdReason(pr);
    if (why) hold.push({ pr, why });
    else merge.push(pr);
  }
  return { merge, hold };
}

const describe = (pr: PrInfo) => `#${pr.number} (${pr.head}; checks ${pr.checks}; ${pr.mergeable.toLowerCase()})`;

export async function mergeOne(ctx: Ctx, e: Employee, o: { yes: boolean }): Promise<EmployeeResult & { merged: PrInfo[] }> {
  const { run } = ctx;
  if (!e.usesKit) return { ...result(e, 'skipped', NOT_ON_KIT), merged: [] };
  const prs = parsePrs(await gh(run, ctx.neutralDir, ...prListArgs(e.repo)));
  if (!prs.length) return { ...result(e, 'skipped', 'no open Steward PRs'), merged: [] };
  const { merge, hold } = mergeSelection(prs);
  const waits = hold.map((h) => `${describe(h.pr)} waits: ${h.why}`);
  if (!o.yes) {
    const would = merge.map((pr) => `${describe(pr)} would be merged`);
    return { ...result(e, 'skipped', [...would, ...waits].join('; ') + (merge.length ? ' (merge --yes merges them)' : ''), { url: prs[0].url }), merged: [] };
  }
  const merged: PrInfo[] = [];
  const failed: string[] = [];
  for (const pr of merge) {
    const r = await run('gh', ['pr', 'merge', String(pr.number), '--repo', e.repo, '--merge', '--delete-branch'], { cwd: ctx.neutralDir, timeoutMs: 5 * 60_000 });
    if (r.code !== 0) {
      failed.push(`#${pr.number}: ${(r.err || r.out).trim().split('\n').pop()}`);
      continue;
    }
    merged.push(pr);
    ctx.log(`[${e.id}] merged #${pr.number} (${pr.head})`);
    // The Steward's own worktree and branch for it are done with.
    const repo = checkoutOf(e);
    if (pr.head.startsWith('steward/kit-') && existsSync(repo)) {
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

export async function merge(ctx: Ctx, employees: Employee[], o: { yes: boolean }): Promise<(EmployeeResult & { merged: PrInfo[] })[]> {
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
