import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../settings.ts';
import { tail } from '../run.ts';
import { workRootOf, type Ctx } from './common.ts';

/**
 * One node_modules for every worktree whose packages are the same. A bump and a team PR's checks each run in a fresh
 * worktree, and each needed `npm ci` there: the eight hires' packages are the same two (TypeScript and Node's types),
 * yet each worktree installed them again. Now the packages are installed once per set, in the work folder's `_modules`
 * (keyed by the lockfile's packages, the Node they were installed for, and this PC's platform), and each worktree gets
 * a junction to them: Windows' own directory link, which needs no rights and no Developer Mode. Removing the worktree
 * removes the link only (git.ts's removeWorktree unlinks it first; Node's rm never follows one).
 *
 * The checks only read node_modules. A set that can't be installed, or a link that can't be made, leaves the worktree
 * to `npm ci` as before.
 */

export const modulesRootOf = (s: Settings) => path.join(workRootOf(s), '_modules');

/** How many sets are kept, the most lately used. */
export const KEEP_SETS = 6;

/**
 * A lockfile's packages as one key: its own name and version left out (a version bump changes nothing installed, and
 * the hires, whose packages are the same, share a set), with the Node ABI, platform and architecture they're built for.
 */
export function packagesKey(lockText: string): string {
  const lock = JSON.parse(lockText.replace(/^﻿/, ''));
  delete lock.name;
  delete lock.version;
  const root = lock.packages?.[''];
  if (root) {
    delete root.name;
    delete root.version;
  }
  return createHash('sha256').update(JSON.stringify([lock, process.versions.modules, process.platform, process.arch])).digest('hex').slice(0, 16);
}

/** The sets being installed in this process, by key, so two worktrees wanting one set install it once. */
const installing = new Map<string, Promise<string | null>>();

/** The set's node_modules, installed (once) if it isn't yet; null when npm ci failed there. */
async function setFor(ctx: Ctx, dir: string, key: string, say: (line: string) => void): Promise<string | null> {
  const root = modulesRootOf(ctx.settings);
  const set = path.join(root, key);
  if (existsSync(path.join(set, '.ready'))) return path.join(set, 'node_modules');
  const already = installing.get(key);
  if (already) return already;
  const job = (async () => {
    const tmp = `${set}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
    mkdirSync(tmp, { recursive: true });
    try {
      // Its package.json without scripts, so installing runs none of the project's own (its prepare, say).
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, ''));
      delete pkg.scripts;
      writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2));
      writeFileSync(path.join(tmp, 'package-lock.json'), readFileSync(path.join(dir, 'package-lock.json')));
      const t0 = Date.now();
      const r = await ctx.run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: tmp, timeoutMs: 20 * 60_000 });
      say(`npm ci, once for every worktree with these packages (${key}): ${r.code === 0 ? 'ok' : `exit ${r.code}`} (${Math.round((Date.now() - t0) / 1000)} s)`);
      if (r.code !== 0) {
        for (const line of tail(`${r.out}\n${r.err}`, 10).split('\n')) say(`  ${line}`);
        return null;
      }
      mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
      writeFileSync(path.join(tmp, '.ready'), new Date().toISOString());
      try {
        renameSync(tmp, set);
      } catch {
        // Another process made it meanwhile: theirs is as good.
        if (!existsSync(path.join(set, '.ready'))) throw new Error(`couldn't put the packages in ${set}`);
      }
      return path.join(set, 'node_modules');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  })().finally(() => installing.delete(key));
  installing.set(key, job);
  return job;
}

/**
 * Whether a worktree's packages may be linked from a shared set: not a Next.js project's. Its build (Turbopack) refuses
 * a node_modules that is a link leading out of the project ("the symlink target leaves the filesystem root"), so a
 * site's `npm run build` would fail there; it gets its own `npm ci` instead. Anything unreadable shares, as before.
 */
export function sharesModules(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, ''));
    return !(pkg?.dependencies?.next || pkg?.devDependencies?.next);
  } catch {
    return true;
  }
}

/**
 * The worktree's node_modules, linked to its set of packages (installed first if need be); false when that couldn't be
 * done, and the worktree should `npm ci` itself.
 */
export async function linkSharedModules(ctx: Ctx, dir: string, say: (line: string) => void): Promise<boolean> {
  if (!sharesModules(dir)) {
    say("node_modules: its own (npm ci), as a Next.js build refuses packages linked from outside the project");
    return false;
  }
  try {
    const key = packagesKey(readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    const modules = await setFor(ctx, dir, key, say);
    if (!modules) return false;
    symlinkSync(modules, path.join(dir, 'node_modules'), 'junction');
    const now = new Date();
    utimesSync(path.dirname(modules), now, now);
    say(`node_modules: the packages already installed for this lockfile (${key})`);
    pruneSets(modulesRootOf(ctx.settings), key);
    return true;
  } catch (err) {
    say(`couldn't share node_modules (${(err as Error).message}): npm ci here instead`);
    return false;
  }
}

/** The sets beyond the KEEP_SETS most lately used, and installs left half-done a day ago, removed. */
export function pruneSets(root: string, keepKey?: string, now = Date.now()): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, at: statSync(path.join(root, d.name)).mtimeMs }));
  const removed: string[] = [];
  const done = entries.filter((x) => /^[0-9a-f]{16}$/.test(x.name)).sort((a, b) => b.at - a.at);
  const stale = [...done.slice(KEEP_SETS).filter((x) => x.name !== keepKey), ...entries.filter((x) => x.name.includes('.tmp-') && now - x.at > 24 * 3600_000)];
  for (const x of stale) {
    try {
      rmSync(path.join(root, x.name), { recursive: true, force: true });
      removed.push(x.name);
    } catch {
      // In use: the next time.
    }
  }
  return removed;
}
