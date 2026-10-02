import { existsSync } from 'node:fs';
import { changelogBetween } from '../kitfiles.ts';
import { aheadOf, branchExists, commitOf, fetchBranch, gh, gitMaybe, showFile } from '../git.ts';
import type { Employee } from '../settings.ts';
import { readVersion } from '../versions.ts';
import { bumpBranch, checkoutOf, NOT_ON_KIT, result, type Ctx, type EmployeeResult } from './common.ts';
import { readPin } from './staff.ts';

/**
 * Stage 2, `steward push`: each bump prepared here (the branch steward/kit-<version>) is pushed, never
 * forced, and gets a PR against the employee's branch: "<Name> <version>: the Steward's kit <kit>", with
 * the kit's changelog entries in its body. One already open is left as it is.
 */

export const prTitle = (e: Employee, version: string, kit: string) => `${e.name} ${version}: the Steward's kit ${kit}`;

export function prBody(o: { kit: string; from: string | null; version: string; changelog: string | null; files: string[]; fill: string }): string {
  const entries = o.changelog ? changelogBetween(o.changelog, o.from, o.kit) : '';
  return [
    `kit.json pins the Steward's kit ${o.kit}${o.from ? ` (it pinned ${o.from})` : ''}, and the version is ${o.version} in ${o.files.join(', ')}. The kit itself isn't in the repo: \`${o.fill}\` fills it from the kit release kit-v${o.kit}, and a release carries it.`,
    '',
    'Made by `steward bump`, which filled the kit and ran the checks in a fresh worktree of the branch before committing.',
    '',
    `## The kit's changes${o.from ? ` since ${o.from}` : ''}`,
    '',
    entries || `See the Steward's kit/CHANGELOG.md for ${o.kit}.`,
  ].join('\n');
}

export async function pushOne(ctx: Ctx, e: Employee, o: { kit: string; changelog: string | null }): Promise<EmployeeResult> {
  const { run } = ctx;
  if (!e.usesKit) return result(e, 'skipped', NOT_ON_KIT);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  const branch = bumpBranch(o.kit);
  if (!(await branchExists(run, repo, branch))) return result(e, 'skipped', `no bump to kit ${o.kit} prepared here (bump first)`);
  await fetchBranch(run, repo, e.branch);
  const remote = `origin/${e.branch}`;
  if ((await aheadOf(run, repo, branch, remote)) === 0) return result(e, 'skipped', `${branch} has nothing ${remote} hasn't`);

  const open = JSON.parse(await gh(run, ctx.neutralDir, 'pr', 'list', '--repo', e.repo, '--head', branch, '--state', 'open', '--json', 'number,url')) as { number: number; url: string }[];
  const pushed = await gitMaybe(run, repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
  const remoteSha = pushed?.trim().split(/\s+/)[0] ?? '';
  const localSha = (await commitOf(run, repo, `refs/heads/${branch}`)) ?? '';
  if (remoteSha !== localSha) {
    // A plain push: if origin's branch has moved on, git refuses, and so does the Steward.
    const r = await run('git', ['push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { cwd: repo, timeoutMs: 5 * 60_000 });
    if (r.code !== 0) return result(e, 'failed', `git push refused (never forced): ${(r.err || r.out).trim().split('\n').slice(-2).join(' ')}`);
    ctx.log(`[${e.id}] pushed ${branch} (${localSha.slice(0, 7)})`);
  }
  if (open.length) return result(e, 'done', `PR #${open[0].number} was already open${remoteSha !== localSha ? '; pushed the new commits to it' : ''}`, { url: open[0].url });

  const versionFile = e.versionFiles[0];
  const version = readVersion(versionFile, (await showFile(run, repo, branch, versionFile)) ?? '') ?? '?';
  const from = readPin(await showFile(run, repo, remote, 'kit.json'))?.kit ?? null;
  const title = prTitle(e, version, o.kit);
  const body = prBody({ kit: o.kit, from, version, changelog: o.changelog, files: ['kit.json', ...e.versionFiles], fill: e.fill });
  const out = await gh(run, ctx.neutralDir, 'pr', 'create', '--repo', e.repo, '--base', e.branch, '--head', branch, '--title', title, '--body', body);
  const url = out.trim().split('\n').pop() ?? '';
  ctx.log(`[${e.id}] opened ${url}`);
  return result(e, 'done', `opened "${title}"`, { url, version });
}

export async function push(ctx: Ctx, employees: Employee[], o: { kit: string; changelog: string | null }): Promise<EmployeeResult[]> {
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
