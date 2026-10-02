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

/** Fetches one branch from origin, so origin/<branch> is fresh. */
export const fetchBranch = (run: Runner, repo: string, branch: string) => git(run, repo, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);

/** A file at a commit, or null when it has none. */
export const showFile = (run: Runner, repo: string, ref: string, file: string) => gitMaybe(run, repo, 'show', `${ref}:${file.replace(/\\/g, '/')}`);

/** The files tracked at a commit. */
export async function trackedAt(run: Runner, repo: string, ref: string): Promise<string[]> {
  return (await git(run, repo, 'ls-tree', '-r', '--name-only', ref)).split('\n').filter(Boolean);
}

/** A ref's commit, or null when there's no such ref. */
export async function commitOf(run: Runner, repo: string, ref: string): Promise<string | null> {
  return (await gitMaybe(run, repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`))?.trim() || null;
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

const samePath = (a: string, b: string) => a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();

/**
 * Removes the Steward's worktree at `dir` and its branch, when there are any: only a worktree that is the
 * repo's, at that folder, and only a branch under steward/. Never the person's own.
 */
export async function removeWorktree(run: Runner, repo: string, dir: string, branch?: string): Promise<string[]> {
  const did: string[] = [];
  const wt = (await worktrees(run, repo)).find((w) => samePath(w.path, dir));
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
