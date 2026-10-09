import { existsSync } from 'node:fs';
import { changelogBetween } from '../kitfiles.ts';
import { aheadOf, branchExists, commitOf, fetchBranch, git, gitMaybe, showFile } from '../git.ts';
import { TOOL } from '../kitsource.ts';
import type { Employee } from '../settings.ts';
import { readVersion } from '../versions.ts';
import { bumpBranch, checkoutOf, NOT_ON_KIT, result, type Ctx, type EmployeeResult, type KitFold } from './common.ts';
import { readPin } from './staff.ts';
import { noteOpened } from '../strangers.ts';
import { hostFor, must } from '../hosts/index.ts';

/**
 * Stage 2, `steward push`: each bump prepared here (the branch steward/kit-<version>) is pushed, never
 * forced, and gets a PR against the employee's branch: "<Name> <version>: the Steward's kit <kit>", with
 * the kit's changelog entries in its body. One already open is left as it is.
 *
 * A fold (the rollout's: a newer kit onto the Steward's kit PR still open for an older one) is pushed onto that PR's
 * branch the same way, once GitHub says the PR is still open, and the PR's title and description become the new kit's.
 */

export const prTitle = (e: Employee, version: string, kit: string) => `${e.name} ${version}: the Steward's kit ${kit}`;

export function prBody(o: { kit: string; from: string | null; version: string; changelog: string | null; files: string[]; fill: string; tool?: boolean; folded?: string }): string {
  const entries = o.changelog ? changelogBetween(o.changelog, o.from, o.kit) : '';
  return [
    `kit.json pins the Steward's kit ${o.kit}${o.from ? ` (it pinned ${o.from})` : ''}, and the version is ${o.version} in ${o.files.join(', ')}.${o.tool ? ` ${TOOL} is the Steward's, which changed since this one's.` : ''} The kit itself isn't in the repo: \`${o.fill}\` fills it from the kit release kit-v${o.kit}, and a release carries it.`,
    '',
    ...(o.folded ? [`Opened for kit ${o.folded}; kit ${o.kit} came out while it was open, and went onto it rather than into a second kit PR beside it.`, ''] : []),
    'Made by `steward bump`, which filled the kit and ran the checks in a fresh worktree of the branch before committing.',
    '',
    `## The kit's changes${o.from ? ` since ${o.from}` : ''}`,
    '',
    entries || `See the Steward's kit/CHANGELOG.md for ${o.kit}.`,
  ].join('\n');
}

export interface PushOptions {
  kit: string;
  changelog: string | null;
  /** By employee id: the kit PR its bump went onto (bump.ts's folds). */
  folds?: Record<string, KitFold>;
}

export async function pushOne(ctx: Ctx, e: Employee, o: PushOptions): Promise<EmployeeResult> {
  const { run } = ctx;
  if (!e.usesKit) return result(e, 'skipped', NOT_ON_KIT);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  const fold = o.folds?.[e.id];
  const branch = fold ? fold.head : bumpBranch(o.kit);
  if (!(await branchExists(run, repo, branch))) return result(e, 'skipped', `no bump to kit ${o.kit} prepared here (bump first)`);
  await fetchBranch(run, repo, e.branch);
  const remote = `origin/${e.branch}`;
  if ((await aheadOf(run, repo, branch, remote)) === 0) return result(e, 'skipped', `${branch} has nothing ${remote} hasn't`);
  const host = hostFor({ ...ctx, run }, e);
  // A fold goes only onto a PR still open: pushed to a branch whose PR merged or closed, it would be a branch with no PR.
  if (fold) {
    const pr = JSON.parse(must(await host.viewPr(e.repo, fold.number, 'state,headRefName'))) as { state: string; headRefName: string };
    if (pr.state !== 'OPEN' || pr.headRefName !== fold.head) return result(e, 'skipped', `kit ${o.kit} wasn't put onto PR #${fold.number}: it is ${pr.state.toLowerCase()} now, so the next round bumps ${e.name} afresh`);
  }

  const open = JSON.parse(must(await host.listPrs(e.repo, { state: 'open', head: branch, fields: 'number,url' }))) as { number: number; url: string }[];
  const pushed = await gitMaybe(run, repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
  const remoteSha = pushed?.trim().split(/\s+/)[0] ?? '';
  const localSha = (await commitOf(run, repo, `refs/heads/${branch}`)) ?? '';
  if (remoteSha !== localSha) {
    // Another PC's turn here now (lease.ts): it rolls the kit out there. The bump stays on this PC's branch.
    if (ctx.lease && !(await ctx.lease.ok(e))) return result(e, 'skipped', `${branch} is ready here, but another PC publishes ${e.name} now, so it wasn't pushed`);
    // A plain push: if origin's branch has moved on, git refuses, and so does the Steward.
    const r = await run('git', ['push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { cwd: repo, timeoutMs: 5 * 60_000 });
    if (r.code !== 0) return result(e, 'failed', `git push refused (never forced): ${(r.err || r.out).trim().split('\n').slice(-2).join(' ')}`);
    ctx.log(`[${e.id}] pushed ${branch} (${localSha.slice(0, 7)})`);
  }
  // Watched from now on, so a merge that isn't this Steward's is seen (strangers.ts).
  if (open.length) noteOpened(e, open[0].url, localSha);
  if (open.length && !fold) return result(e, 'done', `PR #${open[0].number} was already open${remoteSha !== localSha ? '; pushed the new commits to it' : ''}`, { url: open[0].url });

  const versionFile = e.versionFiles[0];
  const version = readVersion(versionFile, (await showFile(run, repo, branch, versionFile)) ?? '') ?? '?';
  const from = readPin(await showFile(run, repo, remote, 'kit.json'))?.kit ?? null;
  const title = prTitle(e, version, o.kit);
  const changed = (await git(run, repo, 'diff', '--name-only', `${remote}...${branch}`)).split('\n').filter(Boolean);
  const files = e.versionFiles.filter((f) => changed.includes(f.replace(/\\/g, '/')));
  const folded = fold ? (/^steward\/kit-(.+)$/.exec(fold.head)?.[1] ?? fold.kit) : undefined;
  const body = prBody({ kit: o.kit, from, version, changelog: o.changelog, files: files.length ? files : e.versionFiles, fill: e.fill, tool: changed.includes(TOOL), folded });
  if (fold) {
    must(await host.editPr(e.repo, fold.number, { title, body }));
    const url = open[0]?.url;
    ctx.log(`[${e.id}] kit ${o.kit} onto #${fold.number}`);
    return result(e, 'done', `put kit ${o.kit} onto its open PR #${fold.number}, now "${title}"`, { ...(url ? { url } : {}), version });
  }
  const out = must(await host.createPr(e.repo, { base: e.branch, head: branch, title, body }));
  const url = out.trim().split('\n').pop() ?? '';
  ctx.log(`[${e.id}] opened ${url}`);
  noteOpened(e, url, localSha);
  return result(e, 'done', `opened "${title}"`, { url, version });
}

export async function push(ctx: Ctx, employees: Employee[], o: PushOptions): Promise<EmployeeResult[]> {
  const out: EmployeeResult[] = [];
  for (const e of employees) {
    try {
      out.push(await pushOne(ctx, e, o));
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      out.push(result(e, 'failed', (err as Error).message));
    }
  }
  return out;
}
