import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { gitCommonDir, remoteUrl } from './kit/git-auth.ts';
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
  await git(run, repo, 'fetch', '--quiet', remoteOf(repo), ref);
}

/**
 * Where a clone's branch and tags are read from: `origin`, or the clone itself (`.`) when its config names no remote at
 * all, a local-only repository (Steward 0.36.266). Fetched from `.`, its origin/<branch> is its own branch, so every
 * stage that reads origin/<branch> reads it as it would anyone's; `git ls-remote .` lists its own tags. One whose config
 * can't be read, or includes another file (where an origin may be), is asked of origin, as before. No git started.
 */
export function remoteOf(repo: string): 'origin' | '.' {
  if (remoteUrl(repo, 'origin') !== null) return 'origin';
  try {
    const common = gitCommonDir(repo);
    if (!common) return 'origin';
    const config = readFileSync(path.join(common, 'config'), 'utf8');
    return /^\s*\[\s*(include|includeIf|remote)\b/im.test(config) ? 'origin' : '.';
  } catch {
    return 'origin';
  }
}

/** Fetches one branch from origin (or a local-only clone's own: remoteOf), so origin/<branch> is fresh. */
export const fetchBranch = (run: Runner, repo: string, branch: string) => git(run, repo, 'fetch', '--quiet', remoteOf(repo), `+refs/heads/${branch}:refs/remotes/origin/${branch}`);

/**
 * Fetches several branches in one go, as fetchBranch does one; when that fails (one of them gone since it was listed),
 * each on its own. The branches fetched.
 */
export async function fetchBranches(run: Runner, repo: string, branches: string[]): Promise<string[]> {
  const spec = (b: string) => `+refs/heads/${b}:refs/remotes/origin/${b}`;
  if (!branches.length) return [];
  const from = remoteOf(repo);
  if ((await gitMaybe(run, repo, 'fetch', '--quiet', from, ...branches.map(spec))) !== null) return branches;
  const got: string[] = [];
  for (const b of branches) if ((await gitMaybe(run, repo, 'fetch', '--quiet', from, spec(b))) !== null) got.push(b);
  return got;
}

/** One read waiting for its repository's batch. */
interface Ask {
  spec: string;
  resolve: (text: string | null) => void;
}

/** The reads asked of each repository this turn of the event loop, by runner (a test's runner is its own). */
const waiting = new WeakMap<Runner, Map<string, Ask[]>>();

/**
 * A file at a commit, or null when it has none. Reads asked of one repository in the same turn of the event loop (a
 * stage's `Promise.all` over its version files, kit.json and tools/kit.ts) go to git together, as one `git cat-file
 * --batch`: a round read some 100 files one `git show` each, a process started and ended for every one. A read alone
 * is a `git show`, as before, and anything the batch can't say exactly is asked again that way.
 */
export function showFile(run: Runner, repo: string, ref: string, file: string): Promise<string | null> {
  const spec = `${ref}:${file.replace(/\\/g, '/')}`;
  return new Promise((resolve) => {
    let repos = waiting.get(run);
    if (!repos) waiting.set(run, (repos = new Map()));
    const asks = repos.get(repo);
    if (asks) return void asks.push({ spec, resolve });
    repos.set(repo, [{ spec, resolve }]);
    setImmediate(() => {
      const all = repos.get(repo)!;
      repos.delete(repo);
      void showAll(run, repo, all);
    });
  });
}

const showOne = (run: Runner, repo: string, spec: string) => gitMaybe(run, repo, 'show', spec);

async function showAll(run: Runner, repo: string, asks: Ask[]): Promise<void> {
  const specs = [...new Set(asks.map((a) => a.spec))];
  const said = new Map<string, string | null>();
  try {
    // A name over more than one line can't be asked on cat-file's.
    const batch = specs.length > 1 && !specs.some((s) => /[\r\n]/.test(s)) ? await run('git', ['cat-file', '--batch'], { cwd: repo, timeoutMs: 5 * 60_000, input: `${specs.join('\n')}\n` }) : null;
    const read = batch?.code === 0 ? readBatch(batch.out, specs.length) : null;
    await Promise.all(specs.map(async (s, i) => said.set(s, read && read[i] !== undefined ? read[i] : await showOne(run, repo, s))));
  } catch {
    // A runner that threw: each read on its own, as before.
    await Promise.all(specs.filter((s) => !said.has(s)).map(async (s) => said.set(s, await showOne(run, repo, s).catch(() => null))));
  }
  for (const a of asks) a.resolve(said.get(a.spec) ?? null);
}

/**
 * `git cat-file --batch`'s answers to `n` names, in order: a blob's text, null for a name with nothing there
 * (`missing`), undefined for one to ask `git show` instead (an ambiguous name). The Runner hands output over as UTF-8
 * text, where bytes that aren't UTF-8 (a tree's listing, a file in another encoding) no longer count as cat-file
 * counted them: that answer and every one after it are undefined, asked again with git show. Null when the output
 * says more than n answers. Pure.
 */
export function readBatch(out: string, n: number): (string | null | undefined)[] | null {
  const buf = Buffer.from(out, 'utf8');
  const said: (string | null | undefined)[] = [];
  const rest = () => [...said, ...Array<undefined>(n - said.length).fill(undefined)];
  let at = 0;
  while (said.length < n) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) return rest();
    const head = buf.toString('utf8', at, nl);
    if (/ (missing|ambiguous)$/.test(head)) {
      said.push(head.endsWith(' missing') ? null : undefined);
      at = nl + 1;
      continue;
    }
    const m = /^[0-9a-f]{40,64} ([a-z]+) (\d+)$/.exec(head);
    const end = m ? nl + 1 + Number(m[2]) : -1;
    if (!m || end >= buf.length || buf[end] !== 0x0a) return rest();
    const text = buf.toString('utf8', nl + 1, end);
    if (m[1] !== 'blob' || text.includes('�')) return rest();
    said.push(text);
    at = end + 1;
  }
  return at === buf.length ? said : null;
}

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

/**
 * The branch a clone has checked out, from its HEAD file (a worktree's own, in its gitdir), as `git branch
 * --show-current` says it: '' at a commit (detached). Null when the files don't say it plainly (a reftable clone, whose
 * HEAD file only says `refs/heads/.invalid`): then git is asked.
 */
export function headBranch(repo: string): string | null {
  try {
    const dotGit = path.join(repo, '.git');
    if (!existsSync(dotGit)) return null;
    const common = commonDir(repo);
    if (!common || existsSync(path.join(common, 'reftable'))) return null;
    const gitdir = lstatSync(dotGit).isDirectory() ? dotGit : /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!gitdir) return null;
    const head = readFileSync(path.join(path.resolve(repo, gitdir), 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(\S+)$/.exec(head);
    if (ref) return ref[1];
    return SHA.test(head) ? '' : null;
  } catch {
    return null;
  }
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

/** A repository's git folder: a clone's common one (a worktree's is its main clone's), or a bare repository itself. */
const gitFolderOf = (repo: string) => commonDir(repo) ?? (existsSync(path.join(repo, 'HEAD')) && existsSync(path.join(repo, 'objects')) ? repo : null);

/** Whether a git folder's objects are plainly SHA-1: its config names no other object format. */
const plainSha1 = (common: string) => !/objectformat/i.test(readFileSync(path.join(common, 'config'), 'utf8'));

/**
 * Whether the clone has an object, from its files alone (no git started): a loose object, or a name in a pack's index
 * (version 2: a fan-out table of 256 counts, then the sorted names, searched by halves with small reads). False when
 * the files don't say it plainly (another object format, an older index, alternates, anything unreadable): then the
 * caller fetches, as before. A bare repository (the turns' scratch one) is its own git folder.
 */
export const hasObject = (repo: string, sha: string): boolean => objectHere(repo, sha) === true;

/**
 * hasObject, telling "not there" from "the files don't say": false only when they say it plainly (SHA-1 objects, no
 * alternates, every pack's index one it reads), null otherwise. Then git is asked whether it has it.
 */
export function objectHere(repo: string, sha: string): boolean | null {
  try {
    if (!SHA.test(sha)) return null;
    const common = gitFolderOf(repo);
    if (!common) return null;
    const objects = path.join(common, 'objects');
    if (existsSync(path.join(objects, sha.slice(0, 2), sha.slice(2)))) return true;
    let plain = existsSync(objects) && !existsSync(path.join(objects, 'info', 'alternates')) && plainSha1(common);
    const packs = path.join(objects, 'pack');
    if (!existsSync(packs)) return plain ? false : null;
    const want = Buffer.from(sha, 'hex');
    for (const f of readdirSync(packs)) {
      if (!f.endsWith('.idx')) continue;
      const found = inPackIndex(path.join(packs, f), want);
      if (found) return true;
      if (found === null) plain = false;
    }
    return plain ? false : null;
  } catch {
    return null;
  }
}

/**
 * A loose object's type and content, read from the repository's files (no git started), its name checked against what
 * they hold. Null when it isn't loose there, or isn't plainly one (packed, another object format, anything unreadable):
 * then git is asked.
 */
export function looseObject(repo: string, sha: string): { type: string; body: Buffer } | null {
  try {
    if (!SHA.test(sha)) return null;
    const common = gitFolderOf(repo);
    if (!common) return null;
    const file = path.join(common, 'objects', sha.slice(0, 2), sha.slice(2));
    if (!existsSync(file)) return null;
    const raw = inflateSync(readFileSync(file));
    if (createHash('sha1').update(raw).digest('hex') !== sha) return null;
    const nul = raw.indexOf(0);
    const head = nul > 0 ? /^(blob|tree|commit|tag) (\d+)$/.exec(raw.toString('latin1', 0, nul)) : null;
    if (!head || Number(head[2]) !== raw.length - nul - 1) return null;
    return { type: head[1], body: raw.subarray(nul + 1) };
  } catch {
    return null;
  }
}

/**
 * Writes an object into the repository as git writes a loose one, with no git started: `<type> <size>\0<content>`,
 * deflated, named by its SHA-1, written aside and renamed in (one that's there already is only freshened, as git does,
 * so a prune doesn't take it). Its name, or null when the repository's objects aren't plainly SHA-1 or the files
 * can't be written: then git makes it.
 */
export function writeLooseObject(repo: string, type: 'blob' | 'tree' | 'commit', body: Buffer): string | null {
  try {
    const common = gitFolderOf(repo);
    if (!common || !plainSha1(common)) return null;
    const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const sha = createHash('sha1').update(raw).digest('hex');
    const dir = path.join(common, 'objects', sha.slice(0, 2));
    const file = path.join(dir, sha.slice(2));
    if (existsSync(file)) {
      try {
        const now = new Date();
        utimesSync(file, now, now);
      } catch {
        // Still there to push: only a prune weeks from now would miss the newer time.
      }
      return sha;
    }
    mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `tmp_obj_${process.pid}_${randomBytes(4).toString('hex')}`);
    writeFileSync(tmp, deflateSync(raw));
    try {
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      // Another writer's same object got there first: it's the same bytes.
      if (!existsSync(file)) throw err;
    }
    return sha;
  } catch {
    return null;
  }
}

/** Whether a pack's index names the object: null when it isn't an index this reads (not version 2, cut short). */
function inPackIndex(file: string, want: Buffer): boolean | null {
  const fd = openSync(file, 'r');
  try {
    const at = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      return readSync(fd, b, 0, len, pos) === len ? b : null;
    };
    const head = at(0, 8);
    if (!head || head.readUInt32BE(0) !== 0xff744f63 || head.readUInt32BE(4) !== 2) return null;
    const first = want[0];
    const fan = at(8 + Math.max(0, first - 1) * 4, first ? 8 : 4);
    if (!fan) return null;
    let lo = first ? fan.readUInt32BE(0) : 0;
    let hi = first ? fan.readUInt32BE(4) : fan.readUInt32BE(0);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const name = at(8 + 256 * 4 + mid * 20, 20);
      if (!name) return null;
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

/**
 * Git's records of a clone's linked worktrees, read from its files (`<common>/worktrees/<id>/gitdir`) with no git
 * started: each one's folder as `git worktree list` gives it, and whether `git worktree prune` would clear the record
 * (the worktree's .git gone, or a record git can't read). Null when the files don't say it plainly: then git is asked.
 */
export function worktreeRecords(repo: string): { path: string | null; gone: boolean }[] | null {
  try {
    const common = commonDir(repo);
    if (!common) return null;
    const admin = path.join(common, 'worktrees');
    if (!existsSync(admin)) return [];
    const records = readdirSync(admin).map((id) => {
      let file = '';
      try {
        file = readFileSync(path.join(admin, id, 'gitdir'), 'utf8').trim();
      } catch {
        // Not a record git reads: a prune clears it.
      }
      if (!file) return { path: null, gone: true };
      // A relative record (worktree.useRelativePaths) is from the record's own folder.
      const dotGit = path.resolve(admin, id, file);
      return { path: dotGit.replace(/[\\/]\.git$/, ''), gone: !existsSync(dotGit) };
    });
    // Two records of one folder: a prune clears one of them, so git is asked.
    const paths = records.flatMap((w) => (w.path ? [w.path.replace(/[\\/]+/g, '/').toLowerCase()] : []));
    return new Set(paths).size === paths.length ? records : null;
  } catch {
    return null;
  }
}

/**
 * `git worktree prune`, when it has anything to clear: skipped when git's records (worktreeRecords) show every
 * worktree's .git still there, as after a `git worktree remove`, which takes its own record with it.
 */
export async function pruneWorktrees(run: Runner, repo: string): Promise<void> {
  const records = worktreeRecords(repo);
  if (records && !records.some((w) => w.gone)) return;
  await gitMaybe(run, repo, 'worktree', 'prune');
}

/** Whether a branch exists on origin (asks origin itself). */
export async function onOrigin(run: Runner, repo: string, branch: string): Promise<boolean> {
  return ((await gitMaybe(run, repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) ?? '').trim() !== '';
}

/**
 * `git worktree add --quiet <opts> <dir> <commit>`. git refuses a folder that's gone while it's still registered ("is a
 * missing but already registered worktree"): a stage stopped half way by a sign-out, its folder then cleared, or one
 * deleted by hand. On 2026-10-13 that stopped the Steward's kit trial and Reeve's release for hours. On that refusal,
 * git's records of vanished worktrees are pruned and the add tried once more.
 */
export async function addWorktree(run: Runner, repo: string, dir: string, commit: string, ...opts: string[]): Promise<void> {
  const add = () => git(run, repo, 'worktree', 'add', '--quiet', ...opts, dir, commit);
  try {
    await add();
  } catch (err) {
    if (!(err instanceof CommandFailed) || !/missing but already registered worktree/i.test(err.message)) throw err;
    await gitMaybe(run, repo, 'worktree', 'prune');
    await add();
  }
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

/**
 * A path with its links and junctions followed, as git records a worktree's: the deepest part that exists resolved, the
 * rest kept. The Steward's work folder (~\.steward\work) became a junction to another drive on 2026-10-13, and git
 * listed its worktrees there: none matched, so none was removed, and clearWorkDir's deletes left them registered.
 */
export function realOf(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const up = path.dirname(abs);
    return up === abs ? abs : path.join(realOf(up), path.basename(abs));
  }
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();

/**
 * Removes the Steward's worktree at `dir` and its branch, when there are any: only a worktree that is the
 * repo's, at that folder (by its real path, links followed), and only a branch under steward/. Never the person's own.
 */
export async function removeWorktree(run: Runner, repo: string, dir: string, branch?: string): Promise<string[]> {
  const did: string[] = [];
  const real = realOf(dir);
  // Git's records, from its files when they say them plainly (no git started), else from `git worktree list`.
  const listed: { path: string | null }[] = worktreeRecords(repo) ?? (await worktrees(run, repo));
  const wt = listed.find((w) => w.path !== null && (samePath(w.path, dir) || samePath(realOf(w.path), real)));
  // Its node_modules may be a junction to packages other worktrees share (stages/modules.ts): the link goes first, alone.
  unlinkModules(dir);
  if (wt) {
    await git(run, repo, 'worktree', 'remove', '--force', dir);
    did.push(`removed the worktree ${dir}`);
  }
  // Records of worktrees whose folders went some other way: cleared, when there are any.
  await pruneWorktrees(run, repo);
  if (branch?.startsWith('steward/') && (await branchExists(run, repo, branch))) {
    await git(run, repo, 'branch', '-D', branch);
    did.push(`deleted the branch ${branch}`);
  }
  return did;
}
