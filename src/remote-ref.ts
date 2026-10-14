import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { hasObject } from './git.ts';
import { isNetworkError } from './kit/net.ts';
import type { Runner } from './run.ts';

/**
 * A small JSON file kept in a ref of a repository's own remote (`refs/manor/…`), read and written with plain git, on any
 * host: the meeting place of the PCs that look after the repository (lease.ts, claims.ts). Never the person's clone: all
 * of it happens in a scratch bare repository in the Steward's work folder, against the remote's URL.
 *
 * - Read: `git ls-remote <url> <ref>`, then the commit fetched with an explicit refspec (only when it isn't here yet).
 * - Write: a tiny orphan commit holding the file, pushed by compare-and-swap:
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
  // Read from the scratch repository's files first (hasObject): git is asked only when they don't say it plainly.
  const here = hasObject(r.scratch, sha) || (await run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: r.scratch, timeoutMs: ASK_MS })).code === 0;
  if (!here) {
    const local = `refs/remotes/manor/${r.key}/${ref.replace(/^refs\//, '')}`;
    const f = await run('git', ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', r.url, `+${ref}:${local}`], { cwd: r.scratch, timeoutMs: ASK_MS, env: QUIET });
    if (f.code !== 0) return null;
  }
  const show = await run('git', ['show', `${sha}:${file}`], { cwd: r.scratch, timeoutMs: ASK_MS });
  return show.code === 0 ? show.out : null;
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
  const sha = commitHere(r.scratch, file, text, message) ?? (await commitByGit(run, r.scratch, file, text, message));
  const push = await run('git', ['push', '--quiet', '--porcelain', `--force-with-lease=${ref}:${old ?? ''}`, r.url, `${sha}:${ref}`], { cwd: r.scratch, timeoutMs: PUSH_MS, env: QUIET });
  if (push.code === 0) return { kind: 'ok', sha };
  const said = `${push.out}\n${push.err}`;
  // Lost to another writer: the lease's check, or the remote's own ref lock when two pushes land together.
  if (/stale info|\[rejected\]|fetch first|non-fast-forward|failed to update ref|cannot lock ref|incorrect old value|but expected/i.test(said) && !/hook|denied|protected|not allowed|forbidden|refus/i.test(said)) return { kind: 'stale' };
  if (isNetworkError(said) || /could not resolve host|unable to access|could not read from remote|connection (timed out|refused|reset)|operation timed out|failed to connect/i.test(said)) return { kind: 'unreachable', why: lastLine(push) };
  return { kind: 'refused', why: lastLine(push) };
}

/** A loose object written into a repository's objects folder, unless it is there already: its id. */
function writeObject(repo: string, type: 'blob' | 'tree' | 'commit', body: Buffer): string {
  const data = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
  const sha = createHash('sha1').update(data).digest('hex');
  const file = path.join(repo, 'objects', sha.slice(0, 2), sha.slice(2));
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, deflateSync(data));
    try {
      renameSync(tmp, file);
    } catch (e) {
      // Another writer put the same object there first: its content is the same.
      rmSync(tmp, { force: true });
      if (!existsSync(file)) throw e;
    }
  }
  return sha;
}

/**
 * The orphan commit holding `file`, made in the scratch repository from Node: a blob, a tree of one entry and a commit,
 * written as loose objects. Each turn's renewal ran four git commands for this (hash-object, update-index, write-tree,
 * commit-tree), about 450 an hour. Null for a repository whose objects aren't SHA-1 (`git init` set to SHA-256): then
 * git makes it, as before.
 */
export function commitHere(scratch: string, file: string, text: string, message: string, now = Date.now()): string | null {
  try {
    if (file.includes('/') || /^\s*objectformat\s*=\s*(?!sha1\b)/im.test(readFileSync(path.join(scratch, 'config'), 'utf8'))) return null;
  } catch {
    return null;
  }
  const blob = writeObject(scratch, 'blob', Buffer.from(text, 'utf8'));
  const tree = writeObject(scratch, 'tree', Buffer.concat([Buffer.from(`100644 ${file}\0`, 'utf8'), Buffer.from(blob, 'hex')]));
  const who = `${AUTHOR.GIT_AUTHOR_NAME} <${AUTHOR.GIT_AUTHOR_EMAIL}> ${Math.floor(now / 1000)} +0000`;
  return writeObject(scratch, 'commit', Buffer.from(`tree ${tree}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`, 'utf8'));
}

/** The same commit made by git: for a repository commitHere can't write to. */
async function commitByGit(run: Runner, scratch: string, file: string, text: string, message: string): Promise<string> {
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

/** Deletes a ref (a test's throwaway one): true when it went. */
export async function deleteRef(run: Runner, r: RemoteRepo, ref: string): Promise<boolean> {
  await ensureScratch(run, r.scratch);
  const d = await run('git', ['push', '--quiet', r.url, `:${ref}`], { cwd: r.scratch, timeoutMs: PUSH_MS, env: QUIET });
  return d.code === 0;
}
