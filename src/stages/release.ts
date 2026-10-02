import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { commitOf, fetchBranch, gh, git, removeWorktree, showFile } from '../git.ts';
import { runLine, tail } from '../run.ts';
import type { Employee } from '../settings.ts';
import { agreedVersion } from '../versions.ts';
import { appReleasesIn, readPin } from './staff.ts';
import { checkoutOf, NOT_ON_KIT, releaseDirOf, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';

/**
 * Stage 4, `steward release`: for each employee whose branch on origin carries the kit and a version with
 * no GitHub release yet, a worktree at that very commit, and its release command run there. Releases come
 * from the branch, never from a PR's, so a release and its branch never drift apart.
 */

export interface ReleaseCandidate {
  usesKit: boolean;
  /** The kit its branch pins, and its version there. */
  kit: string | null;
  version: string | null;
  /** The versions it has released. */
  released: string[];
}

/** Whether to release an employee now, or why not. */
export function releaseDecision(c: ReleaseCandidate, kit: string): { release: true } | { release: false; why: string } {
  if (!c.usesKit) return { release: false, why: NOT_ON_KIT };
  if (!c.kit) return { release: false, why: 'its branch has no kit.json' };
  if (c.kit !== kit) return { release: false, why: `its branch pins kit ${c.kit}, not ${kit}: merge the bump first` };
  if (!c.version) return { release: false, why: 'no version found on its branch' };
  if (c.released.includes(c.version)) return { release: false, why: `v${c.version} is already released` };
  return { release: true };
}

export async function releaseOne(ctx: Ctx, e: Employee, o: { kit: string }): Promise<EmployeeResult> {
  const { run } = ctx;
  if (!e.usesKit) return result(e, 'skipped', NOT_ON_KIT);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  await fetchBranch(run, repo, e.branch);
  const remote = `origin/${e.branch}`;
  const commit = await commitOf(run, repo, remote);
  if (!commit) return result(e, 'refused', `no ${remote}`);
  const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, remote, f)] as [string, string | null])));
  const released = appReleasesIn(await gh(run, ctx.neutralDir, 'release', 'list', '--repo', e.repo, '--limit', '100', '--json', 'tagName,isDraft,publishedAt')).map((r) => r.version);
  const decision = releaseDecision({ usesKit: e.usesKit, kit: readPin(await showFile(run, repo, remote, 'kit.json'))?.kit ?? null, version: 'version' in v ? v.version : null, released }, o.kit);
  if (!decision.release) return result(e, 'skipped', 'error' in v ? v.error : decision.why);
  const version = (v as { version: string }).version;

  const dir = releaseDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, commit);
  ctx.log(`[${e.id}] releasing v${version} from ${remote} (${commit.slice(0, 7)}) in ${dir}`);
  try {
    const r = await runLine(run, e.release, { cwd: dir, timeoutMs: 30 * 60_000 });
    for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${line}`);
    if (r.code !== 0) return result(e, 'failed', `${e.release} failed (exit ${r.code})`, { version, commit: commit.slice(0, 7) });
    return result(e, 'done', `released v${version} from ${remote} (${commit.slice(0, 7)}), with kit ${o.kit}`, { version, commit: commit.slice(0, 7), url: `https://github.com/${e.repo}/releases/tag/v${version}` });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

export async function release(ctx: Ctx, employees: Employee[], o: { kit: string }): Promise<EmployeeResult[]> {
  const out: EmployeeResult[] = [];
  for (const e of employees) {
    try {
      out.push(await releaseOne(ctx, e, o));
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      out.push(result(e, 'failed', (err as Error).message));
    }
  }
  return out;
}
