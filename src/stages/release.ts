import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { commitOf, fetchBranch, gh, git, removeWorktree, showFile } from '../git.ts';
import { runLine, tail } from '../run.ts';
import type { Employee } from '../settings.ts';
import { agreedVersion } from '../versions.ts';
import { needsNpmCi } from './bump.ts';
import { appReleasesIn, readPin } from './staff.ts';
import { checkoutOf, NOT_ON_KIT, releaseDirOf, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';

/**
 * Stage 4, `steward release`: for each employee whose branch on origin carries the kit and a version with
 * no GitHub release yet, a worktree at that very commit, and its release command run there. Releases come
 * from the branch, never from a PR's, so a release and its branch never drift apart. A Node agent's worktree
 * gets its packages first (`npm ci`, as bump does): Reeve's release builds its dashboard with them.
 */

export interface ReleaseCandidate {
  usesKit: boolean;
  /** The kit its branch pins, and its version there. */
  kit: string | null;
  version: string | null;
  /** The versions it has released. */
  released: string[];
}

/**
 * Whether to release an employee now, or why not. `kit` is the kit its branch must pin (the rollout's), or null
 * for a release a merged PR asked for, which carries whatever its branch has.
 */
export function releaseDecision(c: ReleaseCandidate, kit: string | null): { release: true } | { release: false; why: string } {
  if (kit !== null) {
    if (!c.usesKit) return { release: false, why: NOT_ON_KIT };
    if (!c.kit) return { release: false, why: 'its branch has no kit.json' };
    if (c.kit !== kit) return { release: false, why: `its branch pins kit ${c.kit}, not ${kit}: merge the bump first` };
  }
  if (!c.version) return { release: false, why: 'no version found on its branch' };
  if (c.released.includes(c.version)) return { release: false, why: `v${c.version} is already released` };
  return { release: true };
}

/**
 * `unless`, given the commit to release and its version, may say why not (a round leaves a commit whose release
 * failed before to a person).
 */
export async function releaseOne(ctx: Ctx, e: Employee, o: { kit: string | null; unless?: (commit: string, version: string) => string | null }): Promise<EmployeeResult> {
  const { run } = ctx;
  if (!e.usesKit && o.kit !== null) return result(e, 'skipped', NOT_ON_KIT);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  await fetchBranch(run, repo, e.branch);
  const remote = `origin/${e.branch}`;
  const commit = await commitOf(run, repo, remote);
  if (!commit) return result(e, 'refused', `no ${remote}`);
  const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, remote, f)] as [string, string | null])));
  const released = appReleasesIn(await gh(run, ctx.neutralDir, 'release', 'list', '--repo', e.repo, '--limit', '100', '--json', 'tagName,isDraft,publishedAt')).map((r) => r.version);
  const pinned = readPin(await showFile(run, repo, remote, 'kit.json'))?.kit ?? null;
  const decision = releaseDecision({ usesKit: e.usesKit, kit: pinned, version: 'version' in v ? v.version : null, released }, o.kit);
  if (!decision.release) return result(e, 'skipped', 'error' in v ? v.error : decision.why);
  const version = (v as { version: string }).version;
  const not = o.unless?.(commit, version);
  if (not) return result(e, 'skipped', not, { version, commit: commit.slice(0, 7) });

  const dir = releaseDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, commit);
  ctx.log(`[${e.id}] releasing v${version} from ${remote} (${commit.slice(0, 7)}) in ${dir}`);
  try {
    if (needsNpmCi(dir)) {
      const ci = await runLine(run, 'npm ci --no-audit --no-fund', { cwd: dir, timeoutMs: 20 * 60_000 });
      ctx.log(`[${e.id}] npm ci: ${ci.code === 0 ? 'ok' : `exit ${ci.code}`}`);
      if (ci.code !== 0) {
        for (const line of tail(`${ci.out}\n${ci.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${line}`);
        return result(e, 'failed', `npm ci failed (exit ${ci.code}), so its release wasn't built`, { version, commit: commit.slice(0, 7) });
      }
    }
    const r = await runLine(run, e.release, { cwd: dir, timeoutMs: 30 * 60_000 });
    for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${line}`);
    if (r.code !== 0) return result(e, 'failed', `${e.release} failed (exit ${r.code})`, { version, commit: commit.slice(0, 7) });
    return result(e, 'done', `released v${version} from ${remote} (${commit.slice(0, 7)})${pinned ? `, with kit ${pinned}` : ''}`, { version, commit: commit.slice(0, 7), url: `https://github.com/${e.repo}/releases/tag/v${version}` });
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
