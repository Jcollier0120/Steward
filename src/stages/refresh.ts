import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { commitOf, fetchBranch, git, gitMaybe, realOf, unlinkModules } from '../git.ts';
import { runLine, tail, type Ran } from '../run.ts';
import type { Employee } from '../settings.ts';
import { keepFailure } from '../failure.ts';
import { checksLogOf, runChecks } from './bump.ts';
import { checkoutOf, mapLimit, networkNote, result, clearWorkDir, freshWorktree, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { guardPackages, installPackages, linkSharedModules } from './modules.ts';
import { withRepo } from './slots.ts';

/**
 * After a stage released something, each repository whose Settings name a refresh (Refresh after releases) runs it: a
 * site's `npm run sync`, say, which writes every product's release notes and newest downloads into a file the site is
 * built from. In a worktree of its branch on origin, in the work folder (<id>-refresh), never the person's own clone,
 * with its packages (shared where they can be: modules.ts) and gh at hand, as every command the Steward runs. The
 * worktree lasts from one refresh to the next (0.35.68): reset to the branch's head, its packages installed again only
 * when its lockfile changed. A site's are its own (a Next.js build refuses linked ones): 440 packages npm ci unpacked
 * afresh for every refresh, 49 times in a day and a half.
 *
 * While a round asks for the next to come sooner (a rollout's PRs merge and release then), its releases wait for that
 * round's refresh, and one refresh covers them all (refreshStep); never longer than REFRESH_WAIT_MS.
 *
 * When the command changed tracked files, the repository's tests (Settings: Test it) run in that worktree, and only when
 * every one passes is the change committed ("Release notes and downloads after <what was released>") and pushed to the
 * branch, never forced. Nothing changed: nothing pushed. A failure is kept in refresh-failed.json, an alarm until a
 * refresh of that repository goes through (alarms.ts); a stage that released nothing runs none.
 */

export const refreshFailedFile = () => dataFile('refresh-failed.json');

/** A refresh that failed: its branch's commit, why, and what it ran after. */
export interface RefreshHold {
  commit: string;
  message: string;
  after: string;
  at: string;
}

export const loadRefreshFailures = (): Record<string, RefreshHold> => readJson<Record<string, RefreshHold>>(refreshFailedFile(), {});

/** The worktree a repository's refresh runs in. */
export const refreshDirOf = (s: Ctx['settings'], e: Employee) => path.join(workRootOf(s), `${e.id}-refresh`);

/** Beside the worktree: the hash of the lockfile its node_modules was installed (or linked) for. */
export const packagesMarkOf = (dir: string) => `${dir}.packages`;

const spelled = (p: string) => path.resolve(p).replace(/[\\/]+/g, '/').toLowerCase();
/** The same folder, however it is spelled: git lists a worktree by its real path, which a junction changes (0.35.73). */
const sameDir = (a: string, b: string) => spelled(a) === spelled(b) || spelled(realOf(a)) === spelled(realOf(b));

/**
 * The worktree kept from the last refresh, at `commit`: its tracked files as the commit has them, and what the last
 * command left untracked gone; ignored files (its node_modules, a build's cache) stay. False when there's none to keep
 * (none there, not this repository's, or git couldn't reset it), and a new one is made.
 */
async function keptWorktree(ctx: Ctx, repo: string, dir: string, commit: string): Promise<boolean> {
  if (!existsSync(path.join(dir, '.git'))) return false;
  const list = await gitMaybe(ctx.run, repo, 'worktree', 'list', '--porcelain');
  if (!list?.split('\n').some((l) => l.startsWith('worktree ') && sameDir(l.slice('worktree '.length).trim(), dir))) return false;
  if ((await gitMaybe(ctx.run, dir, 'checkout', '--quiet', '--force', '--detach', commit)) === null) return false;
  return (await gitMaybe(ctx.run, dir, 'clean', '--quiet', '-fd')) !== null;
}

/**
 * The worktree's packages, for the command and its tests: kept while its lockfile is the one they were installed for;
 * else the shared set where it can be (modules.ts), else its own install. No package's install script runs unless Settings
 * allow it; one that isn't holds the refresh (installscripts.ts). Why it's held, the install that failed, or null.
 */
async function packagesFor(ctx: Ctx, e: Employee, dir: string, say: (line: string) => void, doing: string): Promise<{ held: string } | { failed: Ran & { line: string } } | null> {
  const lock = path.join(dir, 'package-lock.json');
  if (!existsSync(path.join(dir, 'package.json')) || !existsSync(lock)) return null;
  const hash = createHash('sha256').update(readFileSync(lock)).digest('hex').slice(0, 16);
  const mark = packagesMarkOf(dir);
  const modules = path.join(dir, 'node_modules');
  if (existsSync(modules) && existsSync(mark) && readFileSync(mark, 'utf8').trim() === hash) {
    say(`node_modules: kept from the last refresh, its lockfile unchanged (${hash})`);
    return null;
  }
  const g = await guardPackages(ctx, e, dir, doing);
  if (g.held) return { held: g.held };
  rmSync(mark, { force: true });
  unlinkModules(dir);
  if (!existsSync(modules) && (await linkSharedModules(ctx, dir, say, g.plan))) {
    writeFileSync(mark, hash);
    return null;
  }
  const ci = await installPackages(ctx, dir, g.plan, say);
  if (ci) return { failed: ci };
  writeFileSync(mark, hash);
  return null;
}

/** What a refresh's result says first, so the page and the alarms tell it from a release. */
export const REFRESH = 'refresh: ';

/** What was released, in words for a commit: "Porter 0.4.2", "Porter 0.4.2 and Clerk 0.3.1", "A, B, C and 2 more". */
export function releasedWords(released: Pick<EmployeeResult, 'name' | 'version'>[]): string {
  const names = [...new Set(released.map((r) => (r.version ? `${r.name} ${r.version}` : r.name)))];
  if (!names.length) return 'a release';
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** The commit's title. */
export const refreshTitle = (what: string) => `Release notes and downloads after ${what}`;

/** The tracked files a command changed in a worktree, against its commit. */
async function changedFiles(ctx: Ctx, dir: string): Promise<string[]> {
  return (await git(ctx.run, dir, 'diff', '--name-only', 'HEAD')).split('\n').map((l) => l.trim()).filter(Boolean);
}

/** One repository's refresh, after `what` was released. Never throws for what its own commands do. */
export async function refreshOne(ctx: Ctx, e: Employee, what: string): Promise<EmployeeResult> {
  const { run } = ctx;
  const say = (line: string) => ctx.log(`[${e.id}] refresh: ${line}`);
  const command = e.refresh ?? '';
  const done = (outcome: EmployeeResult['outcome'], message: string, more: Partial<EmployeeResult> = {}) => result(e, outcome, `${REFRESH}${message}`, more);
  if (!command) return done('skipped', 'Settings name none');
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return done('refused', `no checkout at ${repo}, so ${command} wasn't run`);
  await fetchBranch(run, repo, e.branch);
  const remote = `origin/${e.branch}`;
  const commit = await commitOf(run, repo, remote);
  if (!commit) return done('refused', `no ${remote} in ${repo}`);
  const at = commit.slice(0, 7);
  const dir = refreshDirOf(ctx.settings, e);
  rmSync(checksLogOf(dir), { force: true });
  const kept = await keptWorktree(ctx, repo, dir, commit);
  if (!kept) {
    await dropWorktree(ctx, repo, dir);
    rmSync(packagesMarkOf(dir), { force: true });
    await freshWorktree(run, ctx.settings, repo, dir, commit, '--detach');
  }
  say(`${command} in ${dir}${kept ? ' (kept from the last refresh)' : ''}, at ${remote} (${at}), after ${what}`);
  {
    // Its packages first, for the command and its tests.
    const packages = await packagesFor(ctx, e, dir, say, `the refresh after ${what}`);
    if (packages && 'held' in packages) return done('failed', `${packages.held}, so ${command} wasn't run at ${at}, and nothing was pushed`, { commit: at });
    const ci = packages?.failed;
    if (ci) {
      for (const line of tail(`${ci.out}\n${ci.err}`, 15).split('\n')) say(`  ${line}`);
      keepFailure(dir, ci.line, ci.code, `${ci.out}\n${ci.err}`);
      return done('failed', `${ci.line} failed (exit ${ci.code}) at ${at}, so ${command} wasn't run, and nothing was pushed${networkNote(`${ci.out}\n${ci.err}`)}`, { commit: at });
    }
    const r = await runLine(run, command, { cwd: dir, timeoutMs: 20 * 60_000, paced: true });
    for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) say(`  ${line}`);
    if (r.code !== 0) {
      keepFailure(dir, command, r.code, `${r.out}\n${r.err}`);
      return done('failed', `${command} failed (exit ${r.code}) at ${at}, so nothing was pushed${networkNote(`${r.out}\n${r.err}`)}`, { commit: at });
    }
    if ((await commitOf(run, dir, 'HEAD')) !== commit) return done('failed', `${command} made commits of its own at ${at}: nothing was pushed, as the Steward commits a refresh itself`, { commit: at });
    const files = await changedFiles(ctx, dir);
    if (!files.length) return done('skipped', `${command} changed nothing at ${at}: nothing to push`, { commit: at });
    say(`it changed ${files.join(', ')}: its tests, before anything is pushed`);
    // Its tests, as a PR's are here (bump.ts): every one must pass, or nothing is pushed.
    const failed = await runChecks(ctx, e, dir, { say, doing: `the refresh after ${what}` });
    if (failed) return done('failed', `${command} changed ${files.join(', ')}, but ${failed}, so nothing was pushed; the failed step's whole output is in ${checksLogOf(dir)}`, { commit: at });
    await git(run, dir, 'add', '--', ...files);
    const title = refreshTitle(what);
    await git(run, dir, 'commit', '--quiet', '-m', title, '-m', `${command}, run by the Steward after it released ${what}, changed ${files.join(', ')}; ${e.test.length ? `${e.test.join(', ')} passed` : 'Settings name no tests'}. Made from ${remote} at ${at}.`);
    const made = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
    // Another PC's turn here now (lease.ts): it refreshes after its own releases. The commit stays in this worktree only.
    if (ctx.lease && !(await ctx.lease.ok(e))) return done('skipped', `${command} changed ${files.join(', ')}, but another PC publishes ${e.name} now, so nothing was pushed`, { commit: at });
    // A plain push: if the branch moved on meanwhile, git refuses, and so does the Steward. The next release tries again.
    const p = await run('git', ['push', '--quiet', 'origin', `HEAD:refs/heads/${e.branch}`], { cwd: dir, timeoutMs: 5 * 60_000 });
    if (p.code !== 0) return done('failed', `git push to ${e.branch} refused (never forced): ${(p.err || p.out).trim().split('\n').slice(-2).join(' ')}${networkNote(`${p.out}\n${p.err}`)}`, { commit: at });
    say(`pushed ${made.slice(0, 7)} to ${e.branch}: ${title}`);
    return done('done', `pushed ${made.slice(0, 7)} to ${e.branch}: ${title} (${files.join(', ')})`, { commit: made.slice(0, 7), url: `https://github.com/${e.repo}/commit/${made}` });
  }
  // The worktree is kept for the next refresh (keptWorktree), and anything left in it is reset then.
}

/**
 * A refresh's worktree gone: its node_modules link first, alone (never what it points to: git.ts's unlinkModules), then
 * the folder, by Node, which minds no path's length, then git's record of it. A site's own packages (a Next.js build's)
 * go deeper than git for Windows deletes: its `worktree remove` stopped at "Filename too long".
 */
async function dropWorktree(ctx: Ctx, repo: string, dir: string): Promise<void> {
  unlinkModules(dir);
  clearWorkDir(ctx.settings, dir);
  await gitMaybe(ctx.run, repo, 'worktree', 'prune');
}

/** Releases whose refresh waits for the round that comes sooner, and since when. */
export const refreshPendingFile = () => dataFile('refresh-pending.json');

export type Released = Pick<EmployeeResult, 'id' | 'name' | 'version'>;

export interface RefreshPending {
  since: string;
  released: Released[];
}

/** The longest a release's refresh waits for the rounds that come sooner. */
export const REFRESH_WAIT_MS = 60 * 60_000;

/**
 * Whether a stage refreshes now, and after what: its own releases with those waiting (`pending`); or, when the next
 * round comes sooner (`soon`: a rollout's PRs merge and release then), none yet, and they all wait for it, but never
 * longer than REFRESH_WAIT_MS. Pure.
 */
export function refreshStep(o: { released: Released[]; pending: RefreshPending | null; soon: boolean; now: number }): { run: Released[] } | { wait: RefreshPending } {
  const seen = new Set<string>();
  const all = [...(o.pending?.released ?? []), ...o.released.map((r) => ({ id: r.id, name: r.name, ...(r.version ? { version: r.version } : {}) }))].filter((r) => {
    const key = `${r.id}@${r.version ?? ''}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  if (!all.length) return { run: [] };
  const since = o.pending?.since ?? new Date(o.now).toISOString();
  if (o.soon && o.now - Date.parse(since) < REFRESH_WAIT_MS) return { wait: { since, released: all } };
  return { run: all };
}

export const loadRefreshPending = (): RefreshPending | null => {
  const p = readJson<RefreshPending | null>(refreshPendingFile(), null);
  return p && typeof p.since === 'string' && Array.isArray(p.released) ? p : null;
};

/**
 * Each repository with a refresh, after `released` (the releases it covers; none, and nothing runs). What failed is
 * kept by repository, for the alarms; one that went through, or found nothing to change, is let go.
 */
export async function refreshAfterReleases(ctx: Ctx, released: Pick<EmployeeResult, 'name' | 'version'>[]): Promise<EmployeeResult[]> {
  if (!released.length) return [];
  // Not a repository another PC has its turn in (lease.ts): that PC refreshes it after its own releases.
  const which = ctx.settings.employees.filter((e) => e.refresh && !ctx.lease?.skip.has(e.id));
  if (!which.length) return [];
  const what = releasedWords(released);
  ctx.log(`after ${what}: ${which.map((e) => `${e.name}'s ${e.refresh}`).join(', ')}`);
  const out = await mapLimit(which, ctx.settings.parallel, async (e) => {
    try {
      return await withRepo(ctx.log, e.id, () => refreshOne(ctx, e, what));
    } catch (err) {
      ctx.log(`[${e.id}] refresh: ${(err as Error).message}`);
      return result(e, 'failed', `${REFRESH}${(err as Error).message}`);
    }
  });
  const failed = loadRefreshFailures();
  const before = JSON.stringify(failed);
  const now = new Date().toISOString();
  for (const r of out) {
    if (r.outcome === 'failed') failed[r.id] = { commit: r.commit ?? '', message: r.message.slice(REFRESH.length), after: what, at: now };
    else if (r.outcome === 'done' || r.outcome === 'skipped') delete failed[r.id];
  }
  if (JSON.stringify(failed) !== before) writeJson(refreshFailedFile(), failed);
  return out;
}
