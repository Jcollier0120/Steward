import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { carriedOldKit, compareVersions, lf, oldKitFilesIn, pinText } from '../kitfiles.ts';
import { commitOf, fetchBranch, git, onOrigin, removeWorktree, showFile, trackedAt } from '../git.ts';
import { stewardToolFile, takesTool, TOOL } from '../kitsource.ts';
import { failedTests, runLine, tail } from '../run.ts';
import type { Employee } from '../settings.ts';
import { agreedVersion, bumpPatch, setVersion } from '../versions.ts';
import { bumpBranch, bumpDirOf, checkoutOf, mapLimit, NOT_ON_KIT, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { linkSharedModules } from './modules.ts';
import { readPin } from './staff.ts';

/**
 * Stage 1, `steward bump --kit <version>`: for each employee that takes the kit, a fresh worktree of its
 * branch on origin (never the person's own checkout), on the branch steward/kit-<version>, in the work
 * folder. There kit.json's pin goes to the new kit, tools/kit.ts becomes the Steward's (for an agent that
 * fills its kit with it), and the employee's patch version goes up in every version file; then its kit is
 * filled, with the new tools/kit.ts, its checks run, and, when every one passes, the changes are
 * committed. Checks that fail are run once more; failing again leaves the worktree as it was, for a look, with the
 * failed step's whole output beside it (<worktree>.log) and the failed tests named in its message. An employee that isn't a Node agent
 * (Heiward, in C#) gets the same, but for npm and tools/kit.ts: its own fill command fills its kit, and its
 * version files may be a .csproj's <VersionPrefix>.
 */

export interface BumpOptions {
  kit: string;
  /** What to start from instead of origin/<branch> (a local branch, for a trial). Not fetched. */
  base?: string | null;
  /** A kit tree to fill from (STEWARD_KIT) instead of the kit release: for a kit not released yet. */
  kitFrom?: string | null;
  /** The tools/kit.ts to hand out (default: the Steward's own). */
  tool?: string;
}

/**
 * Whether a fresh worktree needs `npm ci` before its checks: a Node project (package.json and its lockfile) without
 * node_modules. A .NET employee has no package.json, and gets no npm.
 */
export const needsNpmCi = (dir: string) =>
  existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'package-lock.json')) && !existsSync(path.join(dir, 'node_modules'));

/**
 * An employee's checks in a worktree, as a fresh clone would run them: dependencies (npm's, for a Node agent, linked
 * from the set installed once for its lockfile (modules.ts), else `npm ci` there; a .NET one restores its own packages
 * as it builds), the kit, then each test command (Settings). The first that failed, or null when all passed. A bump
 * runs them before its commit, and merge on a team PR GitHub runs no checks on.
 */
export async function runChecks(ctx: Ctx, e: Employee, dir: string, o: { env?: Record<string, string>; say: (line: string) => void }): Promise<string | null> {
  const steps: string[] = [];
  if (needsNpmCi(dir) && !(await linkSharedModules(ctx, dir, o.say))) steps.push('npm ci --no-audit --no-fund');
  if (e.fill) steps.push(e.fill);
  steps.push(...e.test);
  for (const step of steps) {
    const t0 = Date.now();
    const r = await runLine(ctx.run, step, { cwd: dir, env: o.env });
    o.say(`${step}: ${r.code === 0 ? 'ok' : `exit ${r.code}`} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (r.code !== 0) {
      const output = `${r.out}\n${r.err}`;
      const tests = failedTests(output);
      for (const t of tests) o.say(`  failed: ${t.name}${t.error ? ` (${t.error})` : ''}`);
      for (const line of tail(output, 25).split('\n')) o.say(`  ${line}`);
      try {
        writeFileSync(checksLogOf(dir), `${step} (exit ${r.code})\n\n${output}`);
        o.say(`  its whole output: ${checksLogOf(dir)}`);
      } catch (err) {
        o.say(`  couldn't keep its output: ${(err as Error).message}`);
      }
      return `${step} failed (exit ${r.code})${testsLine(tests)}`;
    }
  }
  return null;
}

/** Where runChecks keeps the whole output of the step that failed in a worktree: beside it, as <worktree>.log. */
export const checksLogOf = (dir: string) => `${dir}.log`;

/** `: "name" (its error)`, for the tests that failed, so a failure's message (and its alarm) says which. */
export function testsLine(tests: { name: string; error: string | null }[]): string {
  if (!tests.length) return '';
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const named = tests.slice(0, 2).map((t) => `"${cut(t.name, 100)}"${t.error ? ` (${cut(t.error, 100)})` : ''}`);
  return `: ${named.join('; ')}${tests.length > 2 ? ` and ${tests.length - 2} more` : ''}`;
}

/** kit.json's text with its pin moved to `kit`, everything else as it was. */
export function repin(text: string, kit: string): string {
  return pinText({ ...JSON.parse(text.replace(/^﻿/, '')), kit });
}

export async function bumpOne(ctx: Ctx, e: Employee, o: BumpOptions): Promise<EmployeeResult> {
  const { run } = ctx;
  const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
  if (!e.usesKit) return result(e, 'skipped', NOT_ON_KIT);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  const base = o.base ?? `origin/${e.branch}`;
  if (!o.base) await fetchBranch(run, repo, e.branch);
  const baseCommit = await commitOf(run, repo, base);
  if (!baseCommit) return result(e, 'refused', `no ${base} in ${repo}`);

  const pinRaw = await showFile(run, repo, base, 'kit.json');
  const pin = readPin(pinRaw);
  if (!pin) {
    const old = carriedOldKit(e.id) ? oldKitFilesIn(await trackedAt(run, repo, base)) : [];
    return result(e, 'refused', old.length ? `${base} still carries the old kit (${old.length} files, ${old[0]} …): convert it to the Steward's kit first` : `${base} has no kit.json`);
  }
  if (pin.kit === o.kit) return result(e, 'skipped', `already on kit ${o.kit}`);

  // The tools/kit.ts it gets: the Steward's, read before anything is made.
  const toolFile = o.tool ?? stewardToolFile();
  const tool = takesTool(e.fill) ? (existsSync(toolFile) ? readFileSync(toolFile, 'utf8') : null) : undefined;
  if (tool === null) return result(e, 'refused', `the Steward has no ${TOOL} to hand out (${toolFile})`);

  const branch = bumpBranch(o.kit);
  if (await onOrigin(run, repo, branch)) return result(e, 'refused', `${branch} is already on origin: merge or close its PR first (a bump is never force-pushed)`);
  // A bump made here before and not pushed is made again, from scratch.
  const dir = bumpDirOf(ctx.settings, e);
  for (const line of await removeWorktree(run, repo, dir, branch)) say(line);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  rmSync(checksLogOf(dir), { force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--no-track', '-b', branch, dir, base);
  say(`worktree ${dir} on ${branch}, from ${base} (${baseCommit.slice(0, 7)})`);

  writeFileSync(path.join(dir, 'kit.json'), repin(pinRaw!, o.kit));
  const toolAt = path.join(dir, ...TOOL.split('/'));
  const toolChanged = tool !== undefined && (!existsSync(toolAt) || lf(readFileSync(toolAt, 'utf8')) !== lf(tool));
  if (toolChanged) {
    mkdirSync(path.dirname(toolAt), { recursive: true });
    writeFileSync(toolAt, lf(tool!));
    say(`${TOOL}: the Steward's`);
  }
  const texts = e.versionFiles.map((f) => [f, existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : null] as [string, string | null]);
  const agreed = agreedVersion(texts);
  if ('error' in agreed) return result(e, 'failed', agreed.error);
  const next = bumpPatch(agreed.version);
  try {
    for (const [f, t] of texts) writeFileSync(path.join(dir, f), setVersion(f, t!, agreed.version, next));
  } catch (err) {
    return result(e, 'failed', (err as Error).message);
  }
  say(`kit.json: ${pin.kit} → ${o.kit}; version ${agreed.version} → ${next} in ${e.versionFiles.join(', ')}`);

  // A failure is tried once more, as a PR's checks are here (prtest.ts): a round bumps several employees at once, and a
  // test that keeps time can fail under that load and pass alone. Failing twice is the bump's failure.
  const env: Record<string, string> = o.kitFrom ?{ STEWARD_KIT: path.resolve(o.kitFrom) } : {};
  const first = await runChecks(ctx, e, dir, { env, say });
  if (first) {
    say(`its checks once more (${first})`);
    const again = await runChecks(ctx, e, dir, { env, say });
    if (again) return result(e, 'failed', `${again}${again === first ? ', twice' : ` (the first time: ${first})`}; the worktree is left at ${dir}, the failed step's whole output in ${checksLogOf(dir)}`, { version: next });
  }
  const secondTry = first ? ` on a second try (the first: ${first}; its output is in ${checksLogOf(dir)})` : '';

  await git(run, dir, 'add', '--', 'kit.json', ...e.versionFiles, ...(toolChanged ? [TOOL] : []));
  const toolLine = toolChanged ? ` ${TOOL} is the Steward's.` : '';
  await git(run, dir, 'commit', '--quiet', '-m', `${e.name} ${next}: the Steward's kit ${o.kit}`, '-m', `kit.json pins the Steward's kit ${o.kit} (it pinned ${pin.kit}); the version is ${next} in ${e.versionFiles.join(', ')}.${toolLine} Made by steward bump.${first ? ` Its checks passed on a second try; the first failed: ${first}.` : ''}`);
  const commit = (await git(run, dir, 'rev-parse', '--short', 'HEAD')).trim();
  const back = compareVersions(o.kit, pin.kit) < 0 ? ' (a step back to an older kit)' : '';
  return result(e, 'done', `${next} on ${branch} (${commit}): kit ${pin.kit} → ${o.kit}${back}${toolChanged ? `, ${TOOL} updated` : ''}, checks passed${secondTry}${o.kitFrom ? ` with the kit from ${o.kitFrom}` : ''}`, { version: next, commit });
}

export async function bump(ctx: Ctx, employees: Employee[], o: BumpOptions): Promise<EmployeeResult[]> {
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await bumpOne(ctx, e, o);
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return result(e, 'failed', (err as Error).message);
    }
  });
}
