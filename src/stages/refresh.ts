import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { commitOf, fetchBranch, git, gitMaybe, unlinkModules } from '../git.ts';
import { runLine, tail } from '../run.ts';
import type { Employee } from '../settings.ts';
import { checksLogOf, needsNpmCi, runChecks } from './bump.ts';
import { checkoutOf, mapLimit, networkNote, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { linkSharedModules } from './modules.ts';

/**
 * After a stage released something, each repository whose Settings name a refresh (Refresh after releases) runs it: a
 * site's `npm run sync`, say, which writes every product's release notes and newest downloads into a file the site is
 * built from. In a fresh worktree of its branch on origin, in the work folder (<id>-refresh), never the person's own
 * clone, with its packages (shared where they can be: modules.ts) and gh at hand, as every command the Steward runs.
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
  await dropWorktree(ctx, repo, dir);
  rmSync(checksLogOf(dir), { force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, commit);
  say(`${command} in ${dir}, at ${remote} (${at}), after ${what}`);
  try {
    // Its packages first, for the command and its tests: the shared set where it can be, else its own.
    if (needsNpmCi(dir) && !(await linkSharedModules(ctx, dir, say))) {
      const ci = await runLine(run, 'npm ci --no-audit --no-fund', { cwd: dir, timeoutMs: 20 * 60_000 });
      say(`npm ci: ${ci.code === 0 ? 'ok' : `exit ${ci.code}`}`);
      if (ci.code !== 0) {
        for (const line of tail(`${ci.out}\n${ci.err}`, 15).split('\n')) say(`  ${line}`);
        return done('failed', `npm ci failed (exit ${ci.code}) at ${at}, so ${command} wasn't run, and nothing was pushed${networkNote(`${ci.out}\n${ci.err}`)}`, { commit: at });
      }
    }
    const r = await runLine(run, command, { cwd: dir, timeoutMs: 20 * 60_000 });
    for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) say(`  ${line}`);
    if (r.code !== 0) return done('failed', `${command} failed (exit ${r.code}) at ${at}, so nothing was pushed${networkNote(`${r.out}\n${r.err}`)}`, { commit: at });
    if ((await commitOf(run, dir, 'HEAD')) !== commit) return done('failed', `${command} made commits of its own at ${at}: nothing was pushed, as the Steward commits a refresh itself`, { commit: at });
    const files = await changedFiles(ctx, dir);
    if (!files.length) return done('skipped', `${command} changed nothing at ${at}: nothing to push`, { commit: at });
    say(`it changed ${files.join(', ')}: its tests, before anything is pushed`);
    // Its tests, as a PR's are here (bump.ts): every one must pass, or nothing is pushed.
    const failed = await runChecks(ctx, e, dir, { say });
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
  } finally {
    try {
      await dropWorktree(ctx, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * A refresh's worktree gone: its node_modules link first, alone (never what it points to: git.ts's unlinkModules), then
 * the folder, by Node, which minds no path's length, then git's record of it. A site's own packages (a Next.js build's)
 * go deeper than git for Windows deletes: its `worktree remove` stopped at "Filename too long".
 */
async function dropWorktree(ctx: Ctx, repo: string, dir: string): Promise<void> {
  unlinkModules(dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await gitMaybe(ctx.run, repo, 'worktree', 'prune');
}

/**
 * Each repository with a refresh, after `released` (the stage's results that released something; none, and nothing
 * runs). What failed is kept by repository, for the alarms; one that went through, or found nothing to change, is let go.
 */
export async function refreshAfterReleases(ctx: Ctx, released: EmployeeResult[]): Promise<EmployeeResult[]> {
  if (!released.length) return [];
  // Not a repository another PC has its turn in (lease.ts): that PC refreshes it after its own releases.
  const which = ctx.settings.employees.filter((e) => e.refresh && !ctx.lease?.skip.has(e.id));
  if (!which.length) return [];
  const what = releasedWords(released);
  ctx.log(`after ${what}: ${which.map((e) => `${e.name}'s ${e.refresh}`).join(', ')}`);
  const out = await mapLimit(which, ctx.settings.parallel, async (e) => {
    try {
      return await refreshOne(ctx, e, what);
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
