import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { git, removeWorktree, showFile } from '../git.ts';
import { runLine, splitCommand, tail } from '../run.ts';
import type { Employee } from '../settings.ts';
import { tasteFirst } from '../tasting.ts';
import { agreedVersion } from '../versions.ts';
import { needsNpmCi } from './bump.ts';
import { readPin } from './staff.ts';
import { checkoutOf, forgetGlance, freshBranch, mapLimit, NOT_ON_KIT, releasedOf, releaseDirOf, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';

/**
 * Stage 4, `steward release`: for each employee whose branch on origin carries the kit and a version with
 * no GitHub release yet, a worktree at that very commit, and its release command run there. Releases come
 * from the branch, never from a PR's, so a release and its branch never drift apart. A Node agent whose release
 * builds something gets its packages first (`npm ci`): Reeve's release builds its dashboard with them. The kit's own
 * release (a hire's) only packs files with Node, and needs none (releaseNeedsPackages).
 */

/** A command in an npm script that needs no packages: the kit's own tools, run with Node. */
const KIT_ONLY = /^node\s+(tools[\\/]kit\.ts|src[\\/]kit[\\/]release\.ts)(\s|$)/;

/**
 * Whether an employee's release needs its packages installed (npm ci) in the fresh worktree: a Node project whose
 * release runs anything but the kit's own tools. A hire's `npm run release -- --publish` runs `node tools/kit.ts &&
 * node src/kit/release.ts` (pre and release scripts), which packs src with Node alone: no. Reeve's builds its
 * dashboard with vite: yes. Anything the Steward can't read is taken to need them, as every release did before.
 */
export function releaseNeedsPackages(dir: string, release: string): boolean {
  if (!needsNpmCi(dir)) return false;
  const words = splitCommand(release);
  const commands = (line: string) => line.split('&&').map((c) => c.trim()).filter(Boolean);
  let lines: string[];
  if (words[0] === 'node') lines = [words.join(' ')];
  else if (words[0] === 'npm' && (words[1] === 'run' || words[1] === 'run-script') && words[2]) {
    let scripts: Record<string, unknown>;
    try {
      scripts = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')).scripts ?? {};
    } catch {
      return true;
    }
    const name = words[2];
    if (typeof scripts[name] !== 'string') return true;
    lines = [scripts[`pre${name}`], scripts[name], scripts[`post${name}`]].filter((x): x is string => typeof x === 'string');
  } else return true;
  return !lines.flatMap(commands).every((c) => KIT_ONLY.test(c));
}

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
 * failed before to a person). Then the Aletaster tastes that commit (tasting.ts): a release it holds waits, with its
 * reason, and the next round asks again.
 */
export async function releaseOne(ctx: Ctx, e: Employee, o: { kit: string | null; unless?: (commit: string, version: string) => string | null }): Promise<EmployeeResult> {
  const { run } = ctx;
  if (!e.usesKit && o.kit !== null) return result(e, 'skipped', NOT_ON_KIT);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  const remote = `origin/${e.branch}`;
  const commit = await freshBranch(ctx, e, repo);
  if (!commit) return result(e, 'refused', `no ${remote}`);
  const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, remote, f)] as [string, string | null])));
  const released = (await releasedOf(ctx, e)).map((r) => r.version);
  const pinned = readPin(await showFile(run, repo, remote, 'kit.json'))?.kit ?? null;
  const decision = releaseDecision({ usesKit: e.usesKit, kit: pinned, version: 'version' in v ? v.version : null, released }, o.kit);
  if (!decision.release) return result(e, 'skipped', 'error' in v ? v.error : decision.why);
  const version = (v as { version: string }).version;
  const not = o.unless?.(commit, version);
  if (not) return result(e, 'skipped', not, { version, commit: commit.slice(0, 7) });
  const gate = await tasteFirst(e, { commit, version }, ctx.settings, ctx.tasting);
  if (!gate.go) {
    ctx.log(`[${e.id}] ${gate.why}`);
    return result(e, 'skipped', gate.why, { version, commit: commit.slice(0, 7), url: gate.url, again: true });
  }
  if (gate.note) ctx.log(`[${e.id}] ${gate.note}`);
  const noted = gate.note ? `; ${gate.note}` : '';

  const dir = releaseDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, commit);
  ctx.log(`[${e.id}] releasing v${version} from ${remote} (${commit.slice(0, 7)}) in ${dir}`);
  try {
    if (releaseNeedsPackages(dir, e.release)) {
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
    // Its releases have changed: the glance no longer says how they are.
    forgetGlance(ctx, e);
    return result(e, 'done', `released v${version} from ${remote} (${commit.slice(0, 7)})${pinned ? `, with kit ${pinned}` : ''}${noted}`, { version, commit: commit.slice(0, 7), url: `https://github.com/${e.repo}/releases/tag/v${version}` });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

export async function release(ctx: Ctx, employees: Employee[], o: { kit: string }): Promise<EmployeeResult[]> {
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await releaseOne(ctx, e, o);
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return result(e, 'failed', (err as Error).message);
    }
  });
}
