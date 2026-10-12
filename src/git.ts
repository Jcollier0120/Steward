import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Ran, Runner } from './run.ts';

/** A git or gh command that failed: its words and what it said. */
export class CommandFailed extends Error {
  ran: Ran;
  constructor(what: string, ran: Ran) {
    super(`${what} failed (${ran.code}): ${(ran.err || ran.out).trim().split('\n').slice(-6).join(' / ') || 'no output'}`);
    this.ran = ran;
  }
}

/** git in a folder; its output, trimmed, or CommandFailed. */
export async function git(run: Runner, cwd: string, ...args: string[]): Promise<string> {
  const r = await run('git', args, { cwd, timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new CommandFailed(`git ${args.join(' ')}`, r);
  return r.out.trim();
}

/** git that may fail: its output, or null. */
export async function gitMaybe(run: Runner, cwd: string, ...args: string[]): Promise<string | null> {
  const r = await run('git', args, { cwd, timeoutMs: 5 * 60_000 });
  return r.code === 0 ? r.out : null;
}

/** gh, from a folder that is no repo of an employee's, so --repo alone says where; its output, or CommandFailed. */
export async function gh(run: Runner, cwd: string, ...args: string[]): Promise<string> {
  const r = await run('gh', args, { cwd, timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new CommandFailed(`gh ${args.join(' ')}`, r);
  return r.out;
}

/**
 * Fetches a ref from origin to read the commit `sha` it names, unless that commit is already in the clone (hasObject):
 * a PR's head is fetched round after round to read it at the commit its host named, and each fetch started several
 * processes and asked the network for nothing new (Steward 0.35.31). Without a commit to look for, it always fetches.
 */
export async function fetchFor(run: Runner, repo: string, sha: string | null | undefined, ref: string): Promise<void> {
  if (sha && hasObject(repo, sha)) return;
  await git(run, repo, 'fetch', '--quiet', 'origin', ref);
}

/** Fetches one branch from origin, so origin/<branch> is fresh. */
export const fetchBranch = (run: Runner, repo: string, branch: string) => git(run, repo, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);

/** A file at a commit, or null when it has none. */
export const showFile = (run: Runner, repo: string, ref: string, file: string) => gitMaybe(run, repo, 'show', `${ref}:${file.replace(/\\/g, '/')}`);

/** The files tracked at a commit. */
export async function trackedAt(run: Runner, repo: string, ref: string): Promise<string[]> {
  return (await git(run, repo, 'ls-tree', '-r', '--name-only', ref)).split('\n').filter(Boolean);
}

/**
 * A ref's commit, or null when there's no such ref. A branch's or origin's (refs/heads/…, refs/remotes/…, origin/…) is
 * read from the clone's files when they say it plainly (refOnDisk, Steward 0.35.11): a round asks this of every
 * employee, and each `git rev-parse` was a process started and ended. Anything else is git's to say.
 */
export async function commitOf(run: Runner, repo: string, ref: string): Promise<string | null> {
  const known = refOnDisk(repo, ref);
  if (known) return known;
  return (await gitMaybe(run, repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`))?.trim() || null;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * A branch's commit as the clone's files say it: its loose ref, else packed-refs, in the clone's common folder (a
 * worktree's branches are its main clone's). Only for a full refs/heads/… or refs/remotes/… name, or origin/<branch>
 * when no ref git would take before refs/remotes/origin/<branch> exists. Null when the files don't say it plainly
 * (no such ref, a symbolic one, a reftable clone, anything unreadable): then git is asked, as before.
 */
export function refOnDisk(repo: string, ref: string): string | null {
  try {
    const full = /^refs\/(heads|remotes)\//.test(ref) ? ref : /^origin\/[^\^~:@{}\s]+$/.test(ref) ? `refs/remotes/${ref}` : null;
    if (!full || /\.\.|[\^~:?*[\\\s]|@\{/.test(ref)) return null;
    const common = commonDir(repo);
    if (!common || existsSync(path.join(common, 'reftable'))) return null;
    const packed = readPacked(common);
    const at = (name: string) => {
      const loose = path.join(common, ...name.split('/'));
      if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
      return packed.get(name) ?? null;
    };
    // git takes refs/<name>, refs/tags/<name> and refs/heads/<name> before refs/remotes/<name>.
    if (full !== ref && [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`].some((n) => at(n) !== null)) return null;
    const sha = at(full);
    return sha && SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The folder a clone keeps its refs in: .git, or for a worktree the main clone's (its gitdir's commondir). */
export function commonDir(repo: string): string | null {
  const dotGit = path.join(repo, '.git');
  if (!existsSync(dotGit)) return null;
  if (lstatSync(dotGit).isDirectory()) return dotGit;
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
  if (!gitdir) return null;
  const own = path.resolve(repo, gitdir);
  const common = path.join(own, 'commondir');
  return existsSync(common) ? path.resolve(own, readFileSync(common, 'utf8').trim()) : own;
}

/** packed-refs' names and commits (a peeled line, `^…`, belongs to the tag above it and isn't a ref). */
function readPacked(common: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = path.join(common, 'packed-refs');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{40}) (\S+)\r?$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * Whether the clone has an object, from its files alone (no git started): a loose object, or a name in a pack's index
 * (version 2: a fan-out table of 256 counts, then the sorted names, searched by halves with small reads). False when
 * the files don't say it plainly (another object format, an older index, alternates, anything unreadable): then the
 * caller fetches, as before.
 */
export function hasObject(repo: string, sha: string): boolean {
  try {
    if (!SHA.test(sha)) return false;
    const common = commonDir(repo);
    if (!common) return false;
    const objects = path.join(common, 'objects');
    if (existsSync(path.join(objects, sha.slice(0, 2), sha.slice(2)))) return true;
    const packs = path.join(objects, 'pack');
    if (!existsSync(packs)) return false;
    const want = Buffer.from(sha, 'hex');
    return readdirSync(packs).some((f) => f.endsWith('.idx') && inPackIndex(path.join(packs, f), want));
  } catch {
    return false;
  }
}

function inPackIndex(file: string, want: Buffer): boolean {
  const fd = openSync(file, 'r');
  try {
    const at = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      return readSync(fd, b, 0, len, pos) === len ? b : null;
    };
    const head = at(0, 8);
    if (!head || head.readUInt32BE(0) !== 0xff744f63 || head.readUInt32BE(4) !== 2) return false;
    const first = want[0];
    const fan = at(8 + Math.max(0, first - 1) * 4, first ? 8 : 4);
    if (!fan) return false;
    let lo = first ? fan.readUInt32BE(0) : 0;
    let hi = first ? fan.readUInt32BE(4) : fan.readUInt32BE(0);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const name = at(8 + 256 * 4 + mid * 20, 20);
      if (!name) return false;
      const c = name.compare(want);
      if (c === 0) return true;
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

export const branchExists = async (run: Runner, repo: string, branch: string) => (await commitOf(run, repo, `refs/heads/${branch}`)) !== null;

/** How many commits `ref` has that `base` hasn't. */
export async function aheadOf(run: Runner, repo: string, ref: string, base: string): Promise<number> {
  return Number(await git(run, repo, 'rev-list', '--count', `${base}..${ref}`)) || 0;
}

export interface Worktree {
  path: string;
  branch: string | null;
}

/** The repo's worktrees (its main one first). */
export async function worktrees(run: Runner, repo: string): Promise<Worktree[]> {
  const out = await git(run, repo, 'worktree', 'list', '--porcelain');
  const list: Worktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const p = /^worktree (.+)$/m.exec(block)?.[1];
    if (!p) continue;
    list.push({ path: p.trim(), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null });
  }
  return list;
}

/** Whether a branch exists on origin (asks origin itself). */
export async function onOrigin(run: Runner, repo: string, branch: string): Promise<boolean> {
  return ((await gitMaybe(run, repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) ?? '').trim() !== '';
}

/** A worktree's node_modules when it is a link (a junction): removed, and never what it points to. */
export function unlinkModules(dir: string): void {
  const at = path.join(dir, 'node_modules');
  try {
    if (lstatSync(at).isSymbolicLink()) rmSync(at);
  } catch {
    // None there.
  }
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();

/**
 * Removes the Steward's worktree at `dir` and its branch, when there are any: only a worktree that is the
 * repo's, at that folder, and only a branch under steward/. Never the person's own.
 */
export async function removeWorktree(run: Runner, repo: string, dir: string, branch?: string): Promise<string[]> {
  const did: string[] = [];
  const wt = (await worktrees(run, repo)).find((w) => samePath(w.path, dir));
  // Its node_modules may be a junction to packages other worktrees share (stages/modules.ts): the link goes first, alone.
  unlinkModules(dir);
  if (wt) {
    await git(run, repo, 'worktree', 'remove', '--force', dir);
    did.push(`removed the worktree ${dir}`);
  }
  await gitMaybe(run, repo, 'worktree', 'prune');
  if (branch?.startsWith('steward/') && (await branchExists(run, repo, branch))) {
    await git(run, repo, 'branch', '-D', branch);
    did.push(`deleted the branch ${branch}`);
  }
  return did;
}
