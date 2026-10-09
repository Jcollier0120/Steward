import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { changeFiles, CHANGES_DIR, CHANGES_README, entryBody, foldEntries, KIT_CHANGES_DIR, stampVersions, type Stamped } from '../entries.ts';
import { fetchBranch, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { CHANGELOG } from '../kit/notes.ts';
import type { Employee, Settings } from '../settings.ts';
import { agreedVersion } from '../versions.ts';
import { settledFiles, settleVersion } from './catchup.ts';
import { checkoutOf, workRootOf, type Ctx } from './common.ts';
import { KIT_CHANGELOG, KIT_VERSION_FILE, kitVersionText, repinKit } from './kitpart.ts';
import { carryTested } from './prtest.ts';
import type { PrInfo } from './staff.ts';
import { hostFor } from '../hosts/index.ts';

/**
 * The stamp (entries.ts): just before a pull request in a repository that writes its entries in changes/ is merged, the
 * Steward merges the branch into it (clean, since such work never touches the version lines), sets the version its
 * changes files get in the version files, moves each entry into CHANGELOG.md under its version, deletes the files, and
 * pushes that to the pull request's own branch, never to the branch it merges into. What passed at its head before
 * (`carry`: its vouch, or its checks passing here) is carried to the stamped head, as a catch-up's is (prtest.ts
 * carryTested): only versions and entries changed. The merge then names the stamped head.
 *
 * A changes file the branch already has (merged by a Steward too old to stamp it) is stamped with the pull request's,
 * the lower first, so nothing written is ever lost and the next release brings it.
 */

export const stampDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-stamp`);

/** Whether an employee's branch on origin says it writes its entries in changes/ (its changes/README.md). */
export async function usesChanges(ctx: Ctx, e: Employee): Promise<boolean> {
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return false;
  return (await showFile(ctx.run, repo, `origin/${e.branch}`, CHANGES_README)) !== null;
}

export interface StampResult {
  /** Stamped and pushed: the merge goes ahead at `head`. */
  done: boolean;
  /** Nothing to stamp (no changes files): the pull request merges as it is. */
  nothing?: boolean;
  /** What it did, or why it couldn't. */
  note: string;
  head?: string;
  /** The version the employee's files carry once stamped. */
  version?: string;
  stamped?: Stamped[];
}

/** The changes files (named by a version, not its README) in a folder of a worktree, as repository paths, lowest first. */
const listed = (dir: string, sub: string) => {
  const at = path.join(dir, sub);
  return existsSync(at) ? changeFiles(readdirSync(at).map((f) => `${sub}/${f}`), sub) : [];
};

/**
 * Stamps the entries in `files` (one folder's) into `changelog` and returns what it wrote: the stamped versions, or a
 * note on the first file that says nothing (or names another version in its heading).
 */
function stampFolder(dir: string, files: string[], changelog: string, name: string, o: { base: string; released: string[]; taken: string[]; folder: string }): { stamped: Stamped[] } | { error: string } {
  const stamped = stampVersions(files, { base: o.base, released: o.released, taken: o.taken, dir: o.folder });
  const entries: { version: string; body: string }[] = [];
  for (const s of stamped) {
    const body = entryBody(readFileSync(path.join(dir, s.file), 'utf8'), s.wanted);
    if (!body) return { error: `${s.file} says nothing, or its heading names another version: that needs its author` };
    entries.push({ version: s.version, body });
  }
  const at = path.join(dir, changelog);
  writeFileSync(at, foldEntries(existsSync(at) ? readFileSync(at, 'utf8') : null, name, entries));
  for (const s of stamped) rmSync(path.join(dir, s.file));
  return { stamped };
}

/**
 * One pull request stamped before it merges, as the module's comment says. `released` are the employee's released
 * versions, `taken` the versions other open work holds (other PRs and claims); `kit` the same for the kit, in the
 * Steward's own repository. Never pushes to the employee's branch.
 */
export async function stamp(ctx: Ctx, e: Employee, pr: PrInfo, o: { released: string[]; taken: string[]; carry: string | null; kit?: { released: string[]; taken: string[] } }): Promise<StampResult> {
  const { run } = ctx;
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return { done: false, note: `there's no checkout at ${repo}` };
  if (pr.fork) return { done: false, note: "a fork's pull request isn't stamped: its branch isn't the Steward's to push to" };
  await fetchBranch(run, repo, e.branch);
  await fetchBranch(run, repo, pr.head);
  const head = `origin/${pr.head}`;
  if (pr.headOid && (await git(run, repo, 'rev-parse', head)).trim() !== pr.headOid) return { done: false, note: 'its branch moved since this round listed it' };
  const dir = stampDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, head);
  try {
    const kitRepo = existsSync(path.join(dir, KIT_VERSION_FILE));
    const own = listed(dir, CHANGES_DIR);
    const kitOwn = kitRepo ? listed(dir, KIT_CHANGES_DIR) : [];
    // The branch's own, merged by an older Steward unstamped, come in with the merge below.
    const merged = await run('git', ['merge', '--no-ff', '--no-edit', '-m', `Merge ${e.branch} into ${pr.head}: stamped by the Steward`, `origin/${e.branch}`], { cwd: dir, timeoutMs: 5 * 60_000 });
    if (merged.code !== 0) {
      await gitMaybe(run, dir, 'merge', '--abort');
      return { done: false, note: `it conflicts with ${e.branch}, so it wasn't stamped: the catch-up takes it` };
    }
    const files = listed(dir, CHANGES_DIR);
    const kitFiles = kitRepo ? listed(dir, KIT_CHANGES_DIR) : [];
    if (!own.length && !kitOwn.length) return { done: false, nothing: true, note: 'it writes no entry in changes/, so it merges as it is' };
    const read = () => agreedVersion(e.versionFiles.map((f) => [f, existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : null] as [string, string | null]));
    const base = read();
    if (!('version' in base)) return { done: false, note: `its version can't be read once ${e.branch} is merged in: ${base.error}` };
    const changed: string[] = [];
    const did: string[] = [];
    let stamped: Stamped[] = [];
    let version = base.version;
    if (files.length) {
      const r = stampFolder(dir, files, CHANGELOG, e.name, { base: base.version, released: o.released, taken: o.taken, folder: CHANGES_DIR });
      if ('error' in r) return { done: false, note: r.error };
      stamped = r.stamped;
      version = stamped.at(-1)!.version;
      changed.push(...settleVersion(dir, settledFiles(dir, e.versionFiles), version), CHANGELOG, ...files);
      did.push(`v${version}${stamped.length > 1 ? ` (with ${stamped.slice(0, -1).map((s) => `v${s.version}`).join(', ')})` : ''}`);
      for (const s of stamped) if (s.why) did.push(`v${s.version} for ${s.file}, since ${s.why}`);
    }
    if (kitFiles.length) {
      const was = readFileSync(path.join(dir, KIT_VERSION_FILE), 'utf8');
      const r = stampFolder(dir, kitFiles, KIT_CHANGELOG, "The Steward's kit", { base: was.trim(), released: o.kit?.released ?? [], taken: o.kit?.taken ?? [], folder: KIT_CHANGES_DIR });
      if ('error' in r) return { done: false, note: r.error };
      const kit = r.stamped.at(-1)!.version;
      writeFileSync(path.join(dir, KIT_VERSION_FILE), kitVersionText(kit, was));
      // The Steward pins its own kit: the pin follows it.
      const pin = existsSync(path.join(dir, 'kit.json')) ? repinKit(readFileSync(path.join(dir, 'kit.json'), 'utf8'), kit) : null;
      if (pin !== null) writeFileSync(path.join(dir, 'kit.json'), pin), changed.push('kit.json');
      changed.push(KIT_VERSION_FILE, KIT_CHANGELOG, ...kitFiles);
      did.push(`kit ${kit}`);
    }
    await git(run, dir, 'add', '-A', '--', ...new Set(changed));
    await git(run, dir, 'commit', '--quiet', '-m', `${e.name} ${version}: version and changelog, stamped by the Steward`);
    // Another PC's turn here now (lease.ts): it stamps and merges this one.
    if (ctx.lease && !(await ctx.lease.ok(e))) return { done: false, note: 'another PC publishes it now, so it wasn\'t stamped here' };
    await git(run, dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.head}`);
    const pushed = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
    // Only versions and entries changed since the head it stood at: what passed there holds.
    if (o.carry) carryTested(e, pr, pushed, o.carry);
    const note = `stamped ${did.join('; ')}`;
    ctx.log(`[${e.id}] #${pr.number}: ${note}`);
    // Its title says the version it merges with.
    const wanted = stamped.at(-1)?.wanted;
    if (wanted && wanted !== version && pr.title.includes(wanted)) await hostFor({ ...ctx, run }, e).editPr(e.repo, pr.number, { title: pr.title.split(wanted).join(version) }).catch(() => null);
    return { done: true, note, head: pushed, version, stamped };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
