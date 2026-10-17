import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addToEntry, changeFiles, CHANGES_DIR, CHANGES_README, entryBody, foldEntries, fragmentBody, fragmentFiles, isMinor, KIT_CHANGES_DIR, nextFree, stampVersions, type Stamped } from '../entries.ts';
import { commitOf, fetchBranch, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { CHANGELOG } from '../kit/notes.ts';
import type { Employee, Settings } from '../settings.ts';
import { agreedVersion, readVersion, setVersion } from '../versions.ts';
import { checkoutOf, freshWorktree, hostIs, releasedOf, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { KIT_CHANGELOG, KIT_VERSION_FILE, kitClaimKey, kitVersionText, repinKit } from './kitpart.ts';
import { claimsOn } from '../claims.ts';
import { withRepo } from './slots.ts';
import { hostFor, must } from '../hosts/index.ts';
import { coveredBy, mergeOwn, prNumberOf } from './mainbuild.ts';
import { setVouch } from './vouch.ts';

/**
 * The stamp (entries.ts), at a build (Steward 0.36.121): a repository that writes its entries in changes/ (Manor, and
 * any whose changes/README.md says so) merges its PRs with their entries unstamped, as changes/<version>.md or
 * changes/<branch>.md, and the version lines left alone. When main carries such files, the build stamps them before it
 * releases: in a worktree of main's head, it sets the version they get in the version files, moves each entry into
 * CHANGELOG.md under its version (every changes/<branch>.md under one version, the next free one), deletes the files,
 * commits that to a branch of its own, opens a PR to main and merges it itself (mainbuild.ts's mergeOwn). Never pushed
 * straight to main. What covered main's head (its vouch: mainbuild.ts's coveredBy) is carried to the stamped commit, as
 * only versions and entries changed, so the build doesn't test it again.
 *
 * The kit's own entries (kit/changes/) in the Steward's repository likewise, its kit/VERSION and kit.json's pin with them.
 */

export const stampDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-stamp`);

/** The branch a stamp of main's `head` goes on. */
export const stampBranch = (head: string) => `steward/stamp-${head.slice(0, 7)}`;

/** Whether an employee's branch on origin says it writes its entries in changes/ (its changes/README.md). */
export async function usesChanges(ctx: Ctx, e: Employee): Promise<boolean> {
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return false;
  return (await showFile(ctx.run, repo, `origin/${e.branch}`, CHANGES_README)) !== null;
}

/** npm's lockfile, which carries package.json's version twice (its own, and its root package's). */
const LOCKFILE = 'package-lock.json';
const named = (files: string[], f: string) => files.some((x) => x.replace(/\\/g, '/').toLowerCase() === f);

/** package-lock.json, when an employee's version files name package.json but not it: npm keeps it in step all the same. */
export const lockBeside = (files: string[]) => (named(files, 'package.json') && !named(files, LOCKFILE) ? [LOCKFILE] : []);

/**
 * The files a stamp settles the version in: the employee's version files, and package-lock.json beside them
 * (lockBeside) when it says, in both its places, the version package.json does in `dir`. A lock left at another
 * version by hand stays as it is.
 */
export function settledFiles(dir: string, files: string[]): string[] {
  const lock = lockBeside(files);
  if (!lock.length || !existsSync(path.join(dir, LOCKFILE)) || !existsSync(path.join(dir, 'package.json'))) return files;
  try {
    const own = readVersion('package.json', readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const j = JSON.parse(readFileSync(path.join(dir, LOCKFILE), 'utf8').replace(/^﻿/, ''));
    return own && j.version === own && j.packages?.['']?.version === own ? [...files, ...lock] : files;
  } catch {
    return files;
  }
}

/** Each version file in a folder set to `version` where it says otherwise; the files changed. */
export function settleVersion(dir: string, files: string[], version: string): string[] {
  const changed: string[] = [];
  for (const f of files) {
    const p = path.join(dir, f);
    if (!existsSync(p)) throw new Error(`${f} is missing`);
    const text = readFileSync(p, 'utf8');
    const now = readVersion(f, text);
    if (!now) throw new Error(`${f} has no version the Steward can read`);
    if (now === version) continue;
    writeFileSync(p, setVersion(f, text, now, version));
    changed.push(f);
  }
  return changed;
}

export interface StampResult {
  /** Stamped, and its PR merged. */
  done: boolean;
  /** What it did, or why it couldn't. */
  note: string;
  /** The version the employee's files carry once stamped. */
  version?: string;
  /** The stamp's PR, once opened. */
  url?: string;
  /** Not this PC's turn (lease.ts): another PC stamps it. */
  skipped?: boolean;
}

/** The changes files (named by a version, not its README) in a folder of a worktree, as repository paths, lowest first. */
const listed = (dir: string, sub: string) => {
  const at = path.join(dir, sub);
  return existsSync(at) ? changeFiles(readdirSync(at).map((f) => `${sub}/${f}`), sub) : [];
};

/** The fragments (changes/<branch>.md: entries.ts) in a folder of a worktree, as repository paths, by name. */
const fragmentsIn = (dir: string, sub: string) => {
  const at = path.join(dir, sub);
  return existsSync(at) ? fragmentFiles(readdirSync(at).map((f) => `${sub}/${f}`), sub) : [];
};

/** Whether repository paths (main's, listed by git) hold anything a stamp takes. Pure. */
export const stampsAny = (files: string[]): boolean =>
  changeFiles(files, CHANGES_DIR).length + fragmentFiles(files, CHANGES_DIR).length + changeFiles(files, KIT_CHANGES_DIR).length > 0;

/**
 * The fragments stamped into `changelog`: every one under one version, the version the branch waits to release when it
 * has one (`base`, not released), else the next free one above it, a minor step when one asks. A minor step asked for
 * while the waiting version is a patch's renames that version's entry. Returns the version, or a note on the first
 * fragment that says nothing.
 */
function stampFragments(dir: string, files: string[], changelog: string, name: string, o: { base: string; released: string[]; taken: string[] }): { version: string; composed: boolean } | { error: string } {
  const read = files.map((f) => ({ f, frag: fragmentBody(readFileSync(path.join(dir, f), 'utf8')) }));
  const empty = read.find((x) => !x.frag);
  if (empty) return { error: `${empty.f} says nothing: that needs its author` };
  const minor = read.some((x) => x.frag!.minor);
  const taken = new Set([...o.released, ...o.taken]);
  const waiting = !o.released.includes(o.base);
  const version = waiting ? (minor && !isMinor(o.base) ? nextFree(o.base, taken, true) : o.base) : nextFree(o.base, taken, minor);
  const at = path.join(dir, changelog);
  let text = existsSync(at) ? readFileSync(at, 'utf8') : null;
  read.forEach((x, i) => {
    text = addToEntry(text, name, version, x.frag!.body, i === 0 && waiting && version !== o.base ? o.base : undefined);
  });
  writeFileSync(at, text ?? '');
  for (const f of files) rmSync(path.join(dir, f));
  return { version, composed: waiting };
}

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
 * Everything to stamp in a worktree (`dir`), stamped there, nothing committed: the files it changed, what it did in
 * words, and the version the employee's files carry. Null when there's nothing to stamp; else why it couldn't.
 */
export function stampTree(dir: string, e: Employee, o: { released: string[]; taken: string[]; kit?: { released: string[]; taken: string[] } }): { changed: string[]; did: string[]; version: string } | { error: string } | null {
  const files = listed(dir, CHANGES_DIR);
  const fragments = fragmentsIn(dir, CHANGES_DIR);
  const kitFiles = existsSync(path.join(dir, KIT_VERSION_FILE)) ? listed(dir, KIT_CHANGES_DIR) : [];
  if (!files.length && !fragments.length && !kitFiles.length) return null;
  const base = agreedVersion(e.versionFiles.map((f) => [f, existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : null] as [string, string | null]));
  if (!('version' in base)) return { error: `its version can't be read: ${base.error}` };
  const changed: string[] = [];
  const did: string[] = [];
  let version = base.version;
  if (files.length) {
    const r = stampFolder(dir, files, CHANGELOG, e.name, { base: base.version, released: o.released, taken: o.taken, folder: CHANGES_DIR });
    if ('error' in r) return r;
    version = r.stamped.at(-1)!.version;
    changed.push(...settleVersion(dir, settledFiles(dir, e.versionFiles), version), CHANGELOG, ...files);
    did.push(`v${version}${r.stamped.length > 1 ? ` (with ${r.stamped.slice(0, -1).map((s) => `v${s.version}`).join(', ')})` : ''}`);
    for (const s of r.stamped) if (s.why) did.push(`v${s.version} for ${s.file}, since ${s.why}`);
  }
  if (fragments.length) {
    const r = stampFragments(dir, fragments, CHANGELOG, e.name, { base: version, released: o.released, taken: o.taken });
    if ('error' in r) return r;
    changed.push(...settleVersion(dir, settledFiles(dir, e.versionFiles), r.version), CHANGELOG, ...fragments);
    did.push(r.composed ? `v${r.version}, its entry joining the changes that release brings${r.version !== version ? ` (a minor step, from v${version})` : ''}` : `v${r.version}`);
    version = r.version;
  }
  if (kitFiles.length) {
    const was = readFileSync(path.join(dir, KIT_VERSION_FILE), 'utf8');
    const r = stampFolder(dir, kitFiles, KIT_CHANGELOG, "The Steward's kit", { base: was.trim(), released: o.kit?.released ?? [], taken: o.kit?.taken ?? [], folder: KIT_CHANGES_DIR });
    if ('error' in r) return r;
    const kit = r.stamped.at(-1)!.version;
    writeFileSync(path.join(dir, KIT_VERSION_FILE), kitVersionText(kit, was));
    // The Steward pins its own kit: the pin follows it.
    const pin = existsSync(path.join(dir, 'kit.json')) ? repinKit(readFileSync(path.join(dir, 'kit.json'), 'utf8'), kit) : null;
    if (pin !== null) writeFileSync(path.join(dir, 'kit.json'), pin), changed.push('kit.json');
    changed.push(KIT_VERSION_FILE, KIT_CHANGELOG, ...kitFiles);
    did.push(`kit ${kit}`);
  }
  return { changed, did, version };
}

type OpenStamp = { number: number; headRefName: string; headRefOid: string; url: string };

/** The stamp PRs of its own still open in an employee's repository (steward/stamp-…): none on plain git. Never throws. */
async function openStamps(ctx: Ctx, e: Employee): Promise<OpenStamp[]> {
  if (hostIs(ctx, e) === 'git') return [];
  try {
    const all = JSON.parse(must(await hostFor(ctx, e).listPrs(e.repo, { state: 'open', limit: 100, fields: 'number,headRefName,headRefOid,url' })) || '[]') as OpenStamp[];
    return all.filter((p) => p.headRefName?.startsWith('steward/stamp-'));
  } catch (err) {
    ctx.log(`[${e.id}] couldn't list its open stamp PRs: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Main's unstamped entries stamped, as the module's comment says: null when main carries none (or there's no clone);
 * else what was done, or why not. `released` are the employee's released versions, `taken` those other work has
 * claimed (claims.ts); `kit` the same for the kit, in the Steward's own repository.
 */
export async function stampMain(ctx: Ctx, e: Employee, o: { released: string[]; taken: string[]; kit?: { released: string[]; taken: string[] } }): Promise<StampResult | null> {
  const { run } = ctx;
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return null;
  await fetchBranch(run, repo, e.branch);
  const head = await commitOf(run, repo, `origin/${e.branch}`);
  if (!head) return null;
  // A look at main's files first: most builds have nothing to stamp, and no worktree is made for them.
  const tree = await gitMaybe(run, repo, 'ls-tree', '-r', '--name-only', head, `${CHANGES_DIR}/`, `${KIT_CHANGES_DIR}/`);
  if (!tree || !stampsAny(tree.split('\n').map((l) => l.trim()).filter(Boolean))) return null;
  const sha = head.slice(0, 7);
  const branch = stampBranch(head);
  // A stamp of its own an earlier build left open (GitHub wouldn't merge it then): merged now while main is where it was
  // stamped from, never stamped twice; else closed, main having moved on, and main stamped again below.
  const own = await openStamps(ctx, e);
  const same = own.find((p) => p.headRefName === branch);
  if (same) {
    const why = await mergeOwn(ctx, e, { number: same.number, head: same.headRefOid });
    const note = why ? `its stamp #${same.number} of ${sha} is open still (${why}): merge it yourself, and the next build releases it` : `merged its stamp #${same.number} of ${sha}, left open by an earlier build`;
    ctx.log(`[${e.id}] ${note}`);
    return { done: !why, note, url: same.url };
  }
  for (const p of own) {
    const closed = await hostFor(ctx, e).closePr(e.repo, p.number, { comment: `${e.branch} has moved on to ${sha}: the Steward stamps it again from there.`, deleteBranch: true }).catch((err: Error) => ({ code: 1, out: '', err: err.message }));
    ctx.log(`[${e.id}] ${closed.code === 0 ? `closed its stamp #${p.number}, which ${e.branch} has moved past` : `couldn't close its stamp #${p.number}: ${(closed.err || closed.out).trim().split('\n').pop()}`}`);
  }
  const dir = stampDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, head, '--detach');
  try {
    const s = stampTree(dir, e, o);
    if (!s) return null;
    if ('error' in s) return { done: false, note: `its entries on ${e.branch} at ${sha} weren't stamped: ${s.error}` };
    await git(run, dir, 'add', '-A', '--', ...new Set(s.changed));
    const title = `${e.name} ${s.version}: version and changelog, stamped by the Steward`;
    await git(run, dir, 'commit', '--quiet', '-m', title);
    // Another PC's turn here now (lease.ts): it stamps this.
    if (ctx.lease && !(await ctx.lease.ok(e))) return { done: false, skipped: true, note: `another PC publishes ${e.name} now, so its entries weren't stamped here` };
    const pushed = await run('git', ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, timeoutMs: 5 * 60_000 });
    if (pushed.code !== 0) {
      // git's own line saying why (rejected, error, fatal), not the hints after it.
      const lines = (pushed.err || pushed.out).trim().split('\n');
      return { done: false, note: `its stamp of ${sha} couldn't be pushed to ${branch} (never forced): ${(lines.find((l) => /rejected|error|fatal/i.test(l)) ?? lines[0]).trim()}` };
    }
    const stamped = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
    // Only versions and entries changed since main's head: what covered it covers the stamp too.
    const by = await coveredBy(ctx, e, head);
    if (by) {
      const refused = await setVouch(ctx, e, e.repo, stamped, `Only versions and changelog changed since ${sha}: ${by}`.slice(0, 140));
      if (refused) ctx.log(`[${e.id}] ${refused}`);
    }
    const body = [`The entries ${e.branch} carried at ${sha}, stamped: ${s.did.join('; ')}.`, '', 'Only version lines, CHANGELOG.md and the changes files they came from change. Opened and merged by the Steward at a build, which then releases it.'].join('\n');
    const url = must(await hostFor(ctx, e).createPr(e.repo, { base: e.branch, head: branch, title, body })).trim().split('\n').pop() ?? '';
    const n = prNumberOf(url);
    const why = n ? await mergeOwn(ctx, e, { number: n, head: stamped }) : `no PR number in ${url}`;
    const note = `stamped ${s.did.join('; ')}${why ? `, but its PR is open still (${why}): merge it yourself, and the next build releases it` : ', and merged it'}`;
    ctx.log(`[${e.id}] ${note}`);
    return { done: !why, note, version: s.version, url };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * A build's stamps (stampMain), for each repository it releases, one at a time under its lock: a result for each it
 * stamped, or couldn't, and "<id> #<n>" for each stamp PR it merged. The versions they may not take: those released, and
 * those claimed (claims.ts); the kit's too, in the Steward's own repository.
 */
export async function stampAll(ctx: Ctx, employees: Employee[]): Promise<{ results: EmployeeResult[]; merged: string[] }> {
  const results: EmployeeResult[] = [];
  const merged: string[] = [];
  for (const e of employees) {
    try {
      const s = await withRepo(ctx.log, e.id, async () => {
        if (!existsSync(checkoutOf(e))) return null;
        const released = (await releasedOf(ctx, e)).map((r) => r.version);
        const taken = claimsOn(e.repo).map((c) => c.version);
        const kit = existsSync(path.join(checkoutOf(e), KIT_VERSION_FILE)) ? { released: ctx.kit.released, taken: claimsOn(kitClaimKey(e.repo)).map((c) => c.version) } : undefined;
        return stampMain(ctx, e, { released, taken, ...(kit ? { kit } : {}) });
      });
      if (!s) continue;
      results.push(result(e, s.done ? 'done' : s.skipped ? 'skipped' : 'failed', `stamp: ${s.note}`, { ...(s.url ? { url: s.url } : {}), ...(s.version ? { version: s.version } : {}) }));
      const n = s.done && s.url ? prNumberOf(s.url) : null;
      if (n) merged.push(`${e.id} #${n}`);
    } catch (err) {
      ctx.log(`[${e.id}] stamp: ${(err as Error).message}`);
      results.push(result(e, 'failed', `stamp: ${(err as Error).message}`));
    }
  }
  return { results, merged };
}
