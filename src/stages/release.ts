import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitOf, git, removeWorktree, showFile } from '../git.ts';
import { readLsRemote } from '../scm.ts';
import { entryOf } from '../kit/notes.ts';
import { runLine, splitCommand, tail } from '../run.ts';
import { releasedHere, releasesRepoEnv, TAG_RELEASE, type Employee } from '../settings.ts';
import { tasteFirst } from '../tasting.ts';
import { agreedVersion } from '../versions.ts';
import { checksLogOf, needsNpmCi } from './bump.ts';
import { recordTested } from '../tested.ts';
import { readPin } from './staff.ts';
import { noteReleased } from '../strangers.ts';
import { checkoutOf, exchequerNote, forgetGlance, freshBranch, hostIs, mapLimit, networkNote, NOT_ON_KIT, notHiredHere, releasedOf, releaseDirOf, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';

/**
 * Stage 4, `steward release`: for each employee whose branch on origin carries the kit and a version with
 * no GitHub release yet, a worktree at that very commit, and its release command run there. Releases come
 * from the branch, never from a PR's, so a release and its branch never drift apart. A Node agent whose release
 * builds something gets its packages first (`npm ci`): Reeve's release builds its dashboard with them, and from kit
 * 2.16.0 every hire's builds its code with esbuild (releaseNeedsPackages).
 */

/** A command in an npm script that needs no packages: the kit's own tools, run with Node. */
const KIT_ONLY = /^node\s+(tools[\\/]kit\.ts|src[\\/]kit[\\/]release\.ts)(\s|$)/;

/**
 * Whether an employee's release needs its packages installed (npm ci) in the fresh worktree: a Node project whose
 * release runs anything but the kit's own tools. A hire's `npm run release -- --publish` runs `node tools/kit.ts &&
 * node src/kit/release.ts` (pre and release scripts), which packs src with Node alone: no. Reeve's builds its
 * dashboard with vite: yes. Anything the Steward can't read is taken to need them, as every release did before.
 * From kit 2.16.0 the kit's release builds what it carries with esbuild (minify.ts), the agent's devDependency: an
 * agent with esbuild in its package.json needs its packages, whatever its scripts.
 */
export function releaseNeedsPackages(dir: string, release: string): boolean {
  if (!needsNpmCi(dir)) return false;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, ''));
    if (pkg?.devDependencies?.esbuild || pkg?.dependencies?.esbuild) return true;
  } catch {
    return true;
  }
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
  // Released only once the person said how (Settings' Release it), and only a repository with a version.
  if (!e.release) return result(e, 'skipped', NO_RELEASE);
  if (!e.versionFiles.length) return result(e, 'skipped', 'no version files in Settings, so no version to release');
  // Released here, its release installs it: not for one that was removed from this PC.
  const away = releasedHere(e) ? notHiredHere(e) : null;
  if (away) return result(e, 'skipped', away);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  const remote = `origin/${e.branch}`;
  const commit = await freshBranch(ctx, e, repo);
  if (!commit) return result(e, 'refused', `no ${remote}`);
  const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, remote, f)] as [string, string | null])));
  const released = (await releasedOf(ctx, e)).map((r) => r.version);
  const pinned = readPin(await showFile(run, repo, remote, 'kit.json'))?.kit ?? null;
  const decision = releaseDecision({ usesKit: e.usesKit, kit: pinned, version: 'version' in v ? v.version : null, released }, o.kit);
  if (!decision.release) {
    const out = 'version' in v && released.includes(v.version);
    return result(e, 'skipped', 'error' in v ? v.error : decision.why, out ? { released: true, version: v.version } : {});
  }
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

  // A GitHub release the Steward makes itself: no worktree, no command of the repository's.
  if (e.release === TAG_RELEASE) return tagRelease(ctx, e, { repo, commit, version, remote, noted });

  const dir = releaseDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  rmSync(checksLogOf(dir), { force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, commit);
  ctx.log(`[${e.id}] releasing v${version} from ${remote} (${commit.slice(0, 7)}) in ${dir}`);
  try {
    if (releaseNeedsPackages(dir, e.release)) {
      const ci = await runLine(run, 'npm ci --no-audit --no-fund', { cwd: dir, timeoutMs: 20 * 60_000 });
      ctx.log(`[${e.id}] npm ci: ${ci.code === 0 ? 'ok' : `exit ${ci.code}`}`);
      if (ci.code !== 0) {
        for (const line of tail(`${ci.out}\n${ci.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${line}`);
        keepOutput(dir, 'npm ci --no-audit --no-fund', ci.code, `${ci.out}\n${ci.err}`);
        return result(e, 'failed', `npm ci failed (exit ${ci.code}), so its release wasn't built${networkNote(`${ci.out}\n${ci.err}`)}`, { version, commit: commit.slice(0, 7) });
      }
    }
    // The kit's release publishes to the releases repository only on the PC that releases Castellan (MANOR_RELEASES_REPO).
    const r = await runLine(run, e.release, { cwd: dir, timeoutMs: 30 * 60_000, env: releasesRepoEnv(ctx.settings) });
    for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${line}`);
    if (r.code !== 0) {
      keepOutput(dir, e.release, r.code, `${r.out}\n${r.err}`);
      return result(e, 'failed', `${e.release} failed (exit ${r.code})${networkNote(`${r.out}\n${r.err}`)}`, { version, commit: commit.slice(0, 7) });
    }
    // Its releases have changed: the glance no longer says how they are.
    forgetGlance(ctx, e);
    const byGit = hostIs(ctx, e) === 'git';
    // Worked with plain git (scm.ts): the release is the v<version> tag on origin, which the Steward pushes once the
    // command has run (or finds the command pushed). One built and installed here alone has nothing to publish.
    if (byGit && !releasedHere(e)) {
      const tagged = await pushReleaseTag(ctx, e, { repo, commit, version });
      if (tagged) return result(e, 'failed', `${e.release} finished, but the tag v${version} couldn't be pushed to its origin: ${tagged}${networkNote(tagged)}`, { version, commit: commit.slice(0, 7) });
    }
    // A repository's own release command must make the GitHub release, or the next round would run it again: one that
    // didn't is a failed release, which the rounds then leave to the person at that commit. (Castellan's own agents, and
    // one released only on this PC, are known to.)
    else if (!byGit && !ctx.settings.releasesCastellan && !releasedHere(e)) {
      const now = await releasedOf(ctx, e).catch(() => null);
      if (now && !now.some((x) => x.version === version)) {
        keepOutput(dir, e.release, r.code, `${r.out}\n${r.err}`);
        return result(e, 'failed', `${e.release} finished, but GitHub has no release v${version} in ${e.repo}: a release command must make it (or set Release it to tag, and the Steward makes it)`, { version, commit: commit.slice(0, 7) });
      }
    }
    // Released from this commit of its branch: the Surveyor's GET /api/tested (tested.ts).
    recordTested(e.id, { commit, stage: 'release', branch: e.branch, version });
    // This Steward's release, not someone else's (strangers.ts).
    noteReleased(e, version);
    // Released on GitHub; when it didn't reach the Exchequer too, the kit's line says why, as a note (never an alarm).
    const exchequer = exchequerNote(`${r.out}\n${r.err}`);
    return result(e, 'done', `released v${version} from ${remote} (${commit.slice(0, 7)})${pinned ? `, with kit ${pinned}` : ''}${byGit && !releasedHere(e) ? `, tagged v${version} on its origin` : ''}${noted}${exchequer}`, { version, commit: commit.slice(0, 7), ...(byGit ? {} : { url: `https://github.com/${e.repo}/releases/tag/v${version}` }) });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * A failed release's whole output, kept beside its worktree (<worktree>.log, as a bump's checks are) once the worktree
 * is gone: for a person's look, and for the issue the Steward files for the Wright (work.ts).
 */
function keepOutput(dir: string, step: string, code: number, output: string): void {
  try {
    writeFileSync(checksLogOf(dir), `${step} (exit ${code})\n\n${output}`);
  } catch {
    // Only the round's log has it then.
  }
}

/** Why a repository isn't released: Settings name no way to. */
export const NO_RELEASE = 'not released by the Steward: Settings name no way to (Release it)';

/**
 * A GitHub release the Steward makes itself (Release it: tag): v<version> in the repository, at the branch's commit, titled
 * "<name> <version>", its notes the version's entry in CHANGELOG.md at that commit (kit/node/notes.ts), else GitHub's own
 * from the commits since the release before.
 */
async function tagRelease(ctx: Ctx, e: Employee, o: { repo: string; commit: string; version: string; remote: string; noted: string }): Promise<EmployeeResult> {
  const tag = `v${o.version}`;
  // Worked with plain git (scm.ts): the release is the tag itself, pushed to origin.
  if (hostIs(ctx, e) === 'git') {
    ctx.log(`[${e.id}] releasing ${tag} from ${o.remote} (${o.commit.slice(0, 7)}): a tag pushed to its origin`);
    const failed = await pushReleaseTag(ctx, e, o);
    if (failed) return result(e, 'failed', `the tag ${tag} couldn't be pushed to its origin: ${failed}${networkNote(failed)}`, { version: o.version, commit: o.commit.slice(0, 7) });
    forgetGlance(ctx, e);
    recordTested(e.id, { commit: o.commit, stage: 'release', branch: e.branch, version: o.version });
    noteReleased(e, o.version);
    return result(e, 'done', `released v${o.version} from ${o.remote} (${o.commit.slice(0, 7)}), tagged ${tag} on its origin${o.noted}`, { version: o.version, commit: o.commit.slice(0, 7) });
  }
  const entry = entryOf((await showFile(ctx.run, o.repo, o.commit, 'CHANGELOG.md')) ?? '', o.version);
  const notesDir = mkdtempSync(path.join(os.tmpdir(), 'steward-notes-'));
  try {
    let notes: string[];
    if (entry) {
      const file = path.join(notesDir, 'notes.md');
      writeFileSync(file, entry);
      notes = ['--notes-file', file];
    } else notes = ['--generate-notes'];
    ctx.log(`[${e.id}] releasing ${tag} from ${o.remote} (${o.commit.slice(0, 7)}): a GitHub release, its notes ${entry ? 'the CHANGELOG.md entry' : "GitHub's, from the commits"}`);
    const r = await ctx.run('gh', ['release', 'create', tag, '--repo', e.repo, '--target', o.commit, '--title', `${e.name} ${o.version}`, ...notes], { cwd: ctx.neutralDir, timeoutMs: 5 * 60_000 });
    if (r.code !== 0) return result(e, 'failed', `gh release create ${tag} failed (exit ${r.code}): ${(r.err || r.out).trim().split('\n').pop()}${networkNote(`${r.out}\n${r.err}`)}`, { version: o.version, commit: o.commit.slice(0, 7) });
  } finally {
    rmSync(notesDir, { recursive: true, force: true });
  }
  forgetGlance(ctx, e);
  recordTested(e.id, { commit: o.commit, stage: 'release', branch: e.branch, version: o.version });
  noteReleased(e, o.version);
  return result(e, 'done', `released v${o.version} from ${o.remote} (${o.commit.slice(0, 7)})${o.noted}`, { version: o.version, commit: o.commit.slice(0, 7), url: `https://github.com/${e.repo}/releases/tag/${tag}` });
}

/**
 * A release worked with plain git (scm.ts): the annotated tag v<version> at the commit, its message "<name> <version>"
 * and the version's CHANGELOG.md entry, pushed to origin, never forced. One already on origin at that commit (the
 * release command pushed it) is left as it is. Null when it is there; else why not.
 */
export async function pushReleaseTag(ctx: Ctx, e: Employee, o: { repo: string; commit: string; version: string }): Promise<string | null> {
  const tag = `v${o.version}`;
  const said = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').pop() || 'no output';
  const there = await ctx.run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: o.repo, timeoutMs: 2 * 60_000 });
  if (there.code !== 0) return `git ls-remote failed: ${said(there)}`;
  const at = readLsRemote(there.out, '').releases.find((r) => r.tagName === tag)?.commit;
  if (at) return at === o.commit ? null : `origin has ${tag} already, at ${at.slice(0, 7)}, not ${o.commit.slice(0, 7)}`;
  const local = await commitOf(ctx.run, o.repo, `refs/tags/${tag}`);
  if (local && local !== o.commit) return `this clone has a tag ${tag} at ${local.slice(0, 7)}, not ${o.commit.slice(0, 7)}: delete it, or raise the version`;
  if (!local) {
    const entry = entryOf((await showFile(ctx.run, o.repo, o.commit, 'CHANGELOG.md')) ?? '', o.version);
    const notesDir = mkdtempSync(path.join(os.tmpdir(), 'steward-notes-'));
    try {
      const file = path.join(notesDir, 'notes.md');
      writeFileSync(file, `${e.name} ${o.version}\n\n${entry ?? ''}`.trimEnd() + '\n');
      let r = await ctx.run('git', ['tag', '-a', tag, o.commit, '-F', file], { cwd: o.repo, timeoutMs: 60_000 });
      // No name or email set for git on this PC: a plain tag needs none.
      if (r.code !== 0 && /user\.(name|email)|identity|tell me who you are/i.test(`${r.out}\n${r.err}`)) r = await ctx.run('git', ['tag', tag, o.commit], { cwd: o.repo, timeoutMs: 60_000 });
      if (r.code !== 0) return `git tag failed: ${said(r)}`;
    } finally {
      rmSync(notesDir, { recursive: true, force: true });
    }
  }
  const pushed = await ctx.run('git', ['push', '--quiet', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { cwd: o.repo, timeoutMs: 5 * 60_000 });
  return pushed.code === 0 ? null : `git push failed: ${said(pushed)}`;
}

export async function release(ctx: Ctx, employees: Employee[], o: { kit: string | null }): Promise<EmployeeResult[]> {
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await releaseOne(ctx, e, o);
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return result(e, 'failed', (err as Error).message);
    }
  });
}
