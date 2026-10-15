import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looseObject, objectHere, writeLooseObject } from './git.ts';
import { isNetworkError } from './kit/net.ts';
import type { Runner } from './run.ts';

/**
 * A small JSON file kept in a ref of a repository's own remote (`refs/manor/…`), read and written with plain git, on any
 * host: the meeting place of the PCs that look after the repository (lease.ts, claims.ts). Never the person's clone: all
 * of it happens in a scratch bare repository in the Steward's work folder, against the remote's URL.
 *
 * - Read: `git ls-remote <url> <ref>`, then the commit fetched with an explicit refspec (only when it isn't here yet),
 *   its file read from the scratch repository's objects (git asked only when they're packed).
 * - Write: a tiny orphan commit holding the file, its objects written straight into the scratch repository, pushed by
 *   compare-and-swap:
 *   `git push --force-with-lease=<ref>:<old sha, or empty for none> <url> <new>:<ref>`. A lost race is "stale": someone
 *   else wrote first.
 */

/** Where a repository's refs are: its remote's URL, and the scratch repository the work happens in. */
export interface RemoteRepo {
  /** owner/name, in lower case. */
  key: string;
  url: string;
  scratch: string;
}

/** What reading a ref came to. */
export type RefRead = { kind: 'absent' } | { kind: 'found'; sha: string; text: string | null } | { kind: 'unreachable'; why: string };

/** What a compare-and-swap write came to: written (its commit), someone else's first, the host refusing, or no reach. */
export type RefWrite = { kind: 'ok'; sha: string } | { kind: 'stale' } | { kind: 'refused'; why: string } | { kind: 'unreachable'; why: string };

/** Git never asks a person for anything here: a credential it can't find is a failure, not a prompt. */
const QUIET = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
/** The commits' author: the Steward, never the person's own identity. */
const AUTHOR = { GIT_AUTHOR_NAME: 'Castellan Steward', GIT_AUTHOR_EMAIL: 'steward@manor.invalid', GIT_COMMITTER_NAME: 'Castellan Steward', GIT_COMMITTER_EMAIL: 'steward@manor.invalid' };
const ASK_MS = 30_000;
const PUSH_MS = 60_000;

const lastLine = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').filter(Boolean).pop()?.trim().slice(0, 300) ?? '';

/** The scratch bare repository, made once. */
export async function ensureScratch(run: Runner, dir: string): Promise<void> {
  if (existsSync(path.join(dir, 'HEAD'))) return;
  mkdirSync(dir, { recursive: true });
  const r = await run('git', ['init', '--quiet', '--bare', dir], { cwd: dir, timeoutMs: ASK_MS });
  if (r.code !== 0) throw new Error(`couldn't make ${dir}: ${lastLine(r)}`);
}

/** The commits of some refs of the remote, by ref (a ref it hasn't is left out), or why it couldn't be asked. */
export async function lsRemote(run: Runner, r: RemoteRepo, refs: string[]): Promise<{ ok: true; refs: Record<string, string> } | { ok: false; why: string }> {
  await ensureScratch(run, r.scratch);
  const got = await run('git', ['ls-remote', r.url, ...refs], { cwd: r.scratch, timeoutMs: ASK_MS, env: QUIET });
  if (got.code !== 0) return { ok: false, why: lastLine(got) || `git ls-remote failed (${got.code})` };
  const out: Record<string, string> = {};
  for (const line of got.out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref && /^[0-9a-f]{40,64}$/.test(sha)) out[ref] = sha;
  }
  return { ok: true, refs: out };
}

/** A ref's file at a known commit: fetched first when the commit isn't here yet. Null when it can't be read. */
export async function fileAt(run: Runner, r: RemoteRepo, ref: string, sha: string, file: string): Promise<string | null> {
  // Read from the scratch repository's files first (git.ts looseObject, objectHere): git is asked only when they don't say it plainly.
  const known = looseFile(r.scratch, sha, file);
  if (known !== null) return known;
  const here = objectHere(r.scratch, sha) ?? (await run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: r.scratch, timeoutMs: ASK_MS })).code === 0;
  if (!here) {
    const local = `refs/remotes/manor/${r.key}/${ref.replace(/^refs\//, '')}`;
    const f = await run('git', ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', r.url, `+${ref}:${local}`], { cwd: r.scratch, timeoutMs: ASK_MS, env: QUIET });
    if (f.code !== 0) return null;
    // A fetch of a few objects leaves them loose (fewer than git's unpack limit).
    const fetched = looseFile(r.scratch, sha, file);
    if (fetched !== null) return fetched;
  }
  const show = await run('git', ['show', `${sha}:${file}`], { cwd: r.scratch, timeoutMs: ASK_MS });
  return show.code === 0 ? show.out : null;
}

/** A plain file name: no folder in it, nothing git would take apart. */
const plainName = (file: string) => /^[^/\\\0]+$/.test(file) && file !== '.' && file !== '..';

/**
 * A commit's file as `git show <commit>:<file>` gives it, from the repository's loose objects (git.ts looseObject): the
 * commit's tree, the file's entry in it, its blob. Null when they don't hold it plainly (packed, not a commit, no such
 * file, a link or a folder, a name with a folder in it): then git is asked.
 */
function looseFile(repo: string, sha: string, file: string): string | null {
  if (!plainName(file)) return null;
  const commit = looseObject(repo, sha);
  const treeSha = commit?.type === 'commit' ? /^tree ([0-9a-f]{40})\n/.exec(commit.body.toString('latin1'))?.[1] : undefined;
  const tree = treeSha ? looseObject(repo, treeSha) : null;
  if (tree?.type !== 'tree') return null;
  const b = tree.body;
  // Each entry: `<mode> <name>\0`, then the object's name in 20 bytes.
  for (let at = 0; at < b.length; ) {
    const space = b.indexOf(0x20, at);
    const nul = space < 0 ? -1 : b.indexOf(0, space);
    if (nul < 0 || nul + 21 > b.length) return null;
    const mode = b.toString('latin1', at, space);
    const name = b.toString('utf8', space + 1, nul);
    const id = b.toString('hex', nul + 1, nul + 21);
    at = nul + 21;
    if (name !== file) continue;
    if (mode !== '100644' && mode !== '100755') return null;
    const blob = looseObject(repo, id);
    return blob?.type === 'blob' ? blob.body.toString('utf8') : null;
  }
  return null;
}

/**
 * The commit git's hash-object, update-index, write-tree and commit-tree make for `file`, its three objects written
 * straight into the scratch repository's files (git.ts writeLooseObject) with no git started: the blob, a tree of that
 * one file, and a commit by the Steward dated now in this PC's time zone, its message ended by a newline. Null when git
 * has to make it (objects not plainly SHA-1, a name with a folder in it, files that can't be written).
 */
function orphanCommit(scratch: string, file: string, text: string, message: string): string | null {
  if (!plainName(file) || message.includes('\0')) return null;
  const now = Date.now();
  const blob = writeLooseObject(scratch, 'blob', Buffer.from(text));
  const tree = blob && writeLooseObject(scratch, 'tree', Buffer.concat([Buffer.from(`100644 ${file}\0`), Buffer.from(blob, 'hex')]));
  if (!tree) return null;
  // As git writes a date: seconds since 1970, and the time zone's offset as +hhmm.
  const offset = -new Date(now).getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  const when = `${Math.floor(now / 1000)} ${zone}`;
  const author = `${AUTHOR.GIT_AUTHOR_NAME} <${AUTHOR.GIT_AUTHOR_EMAIL}> ${when}`;
  const committer = `${AUTHOR.GIT_COMMITTER_NAME} <${AUTHOR.GIT_COMMITTER_EMAIL}> ${when}`;
  const body = `tree ${tree}\nauthor ${author}\ncommitter ${committer}\n\n${message}${message.endsWith('\n') ? '' : '\n'}`;
  return writeLooseObject(scratch, 'commit', Buffer.from(body));
}

/** The same commit, made by git's own commands: where orphanCommit can't write it. */
async function orphanCommitByGit(run: Runner, scratch: string, file: string, text: string, message: string): Promise<string> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-ref-'));
  try {
    const body = path.join(tmp, file);
    writeFileSync(body, text);
    const blob = await run('git', ['hash-object', '-w', body], { cwd: scratch, timeoutMs: ASK_MS });
    if (blob.code !== 0) throw new Error(`git hash-object: ${lastLine(blob)}`);
    const index = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    const add = await run('git', ['update-index', '--add', '--cacheinfo', `100644,${blob.out.trim()},${file}`], { cwd: scratch, timeoutMs: ASK_MS, env: index });
    if (add.code !== 0) throw new Error(`git update-index: ${lastLine(add)}`);
    const tree = await run('git', ['write-tree'], { cwd: scratch, timeoutMs: ASK_MS, env: index });
    if (tree.code !== 0) throw new Error(`git write-tree: ${lastLine(tree)}`);
    const commit = await run('git', ['commit-tree', tree.out.trim(), '-m', message], { cwd: scratch, timeoutMs: ASK_MS, env: AUTHOR });
    if (commit.code !== 0) throw new Error(`git commit-tree: ${lastLine(commit)}`);
    return commit.out.trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A ref's file, as the remote has it now. */
export async function readRef(run: Runner, r: RemoteRepo, ref: string, file: string): Promise<RefRead> {
  const ls = await lsRemote(run, r, [ref]);
  if (!ls.ok) return { kind: 'unreachable', why: ls.why };
  const sha = ls.refs[ref];
  if (!sha) return { kind: 'absent' };
  return { kind: 'found', sha, text: await fileAt(run, r, ref, sha, file) };
}

/** Writes the ref to a new orphan commit holding `file`, only if it is still at `old` (null: only if it doesn't exist). */
export async function writeRef(run: Runner, r: RemoteRepo, ref: string, file: string, text: string, old: string | null, message: string): Promise<RefWrite> {
  await ensureScratch(run, r.scratch);
  // Only the push asks git (and the remote): the commit is written from here when the scratch repository's files allow.
  const sha = orphanCommit(r.scratch, file, text, message) ?? (await orphanCommitByGit(run, r.scratch, file, text, message));
  const push = await run('git', ['push', '--quiet', '--porcelain', `--force-with-lease=${ref}:${old ?? ''}`, r.url, `${sha}:${ref}`], { cwd: r.scratch, timeoutMs: PUSH_MS, env: QUIET });
  if (push.code === 0) return { kind: 'ok', sha };
  const said = `${push.out}\n${push.err}`;
  // Lost to another writer: the lease's check, or the remote's own ref lock when two pushes land together.
  if (/stale info|\[rejected\]|fetch first|non-fast-forward|failed to update ref|cannot lock ref|incorrect old value|but expected/i.test(said) && !/hook|denied|protected|not allowed|forbidden|refus/i.test(said)) return { kind: 'stale' };
  if (isNetworkError(said) || /could not resolve host|unable to access|could not read from remote|connection (timed out|refused|reset)|operation timed out|failed to connect/i.test(said)) return { kind: 'unreachable', why: lastLine(push) };
  return { kind: 'refused', why: lastLine(push) };
}

/** Deletes a ref (a test's throwaway one): true when it went. */
export async function deleteRef(run: Runner, r: RemoteRepo, ref: string): Promise<boolean> {
  await ensureScratch(run, r.scratch);
  const d = await run('git', ['push', '--quiet', r.url, `:${ref}`], { cwd: r.scratch, timeoutMs: PUSH_MS, env: QUIET });
  return d.code === 0;
}
