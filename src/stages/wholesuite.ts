import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf, fetchBranch, removeWorktree, showFile } from '../git.ts';
import { STEWARD_BRANCH } from '../glance.ts';
import { treeOf, wholePassOf } from '../whole.ts';
import { onlyFlaky, runChecks, type FailedChecks } from './bump.ts';
import { freshWorktree, interrupted, workRootOf, type Ctx } from './common.ts';
import { stewardEmployee } from './selfmerge.ts';

/**
 * The whole suite before a kit's release. A vouch and a PR tested here run only the tests each change reaches
 * (affected.ts), so before the Steward releases a kit from its own main (self.ts), which every agent then takes, its whole
 * suite runs at that commit, unless that very code passed whole on this PC already (whole.ts: a vouch or a PR test whose
 * change reached everything, a train). A test the selection missed then holds the kit's release, as a failed release does
 * (self-failed.json, an alarm at once, tried again once a new commit lands on main), instead of reaching every agent. A
 * failure is run once more first, as a PR's checks are (prtest.ts); one Windows ended isn't held, the next round runs it
 * again; nor are two runs whose failing tests each passed in the other (onlyFlaky).
 *
 * The Steward's own release (v<version>), made after every merge, isn't held for it: that would be the whole suite once a
 * PR, more than the affected tests save. The Surveyor runs its whole suite on main once a day (or the Assayer's daily
 * health check does), as every agent's.
 */

/** Whether a package.json's text has a test script to run. Pure. */
export function testScriptAt(packageJson: string | null): boolean {
  try {
    return !!JSON.parse((packageJson ?? '').replace(/^﻿/, '')).scripts?.test;
  } catch {
    return false;
  }
}

/** The worktree the gate runs the whole suite in. */
export const wholeDirOf = (ctx: Ctx) => path.join(workRootOf(ctx.settings), `_${APP.id}-whole`);

/**
 * Before a kit is released from `commit` of the Steward's checkout `repo`: null once its whole suite has passed there
 * (now, or kept from before), or when the checkout has no npm test to run; else why it may not be released, and whether
 * the next round should simply try again (`retry`: Windows ended the run).
 */
export async function wholeSuiteBefore(ctx: Ctx, repo: string, o: { tag: string; commit: string }): Promise<{ why: string; retry: boolean } | null> {
  const { run } = ctx;
  const at = o.commit.slice(0, 7);
  const say = (line: string) => ctx.log(`[${APP.id}] ${line}`);
  if (!(await commitOf(run, repo, o.commit))) await fetchBranch(run, repo, STEWARD_BRANCH);
  const before = wholePassOf(await treeOf(run, repo, o.commit));
  if (before) {
    say(`${o.tag}: its whole suite passed here at ${before.commit.slice(0, 7)} (${before.at}), the same code: not run again`);
    return null;
  }
  if (!testScriptAt(await showFile(run, repo, o.commit, 'package.json'))) return null;
  const dir = wholeDirOf(ctx);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, o.commit, '--detach');
  try {
    say(`${o.tag}: the whole suite first, at ${at} in ${dir}, as its PRs ran only the tests each change reached`);
    const e = stewardEmployee(ctx.settings, repo);
    const firstFailed: FailedChecks = {};
    const againFailed: FailedChecks = {};
    const first = await runChecks(ctx, e, dir, { say, failed: firstFailed });
    const ended = (failed: string) => ({ why: `Windows ended its whole suite at ${at} (${failed})`, retry: true });
    if (first && interrupted(first)) return ended(first);
    if (first) say(`its whole suite once more (${first})`);
    const again = first ? await runChecks(ctx, e, dir, { say, failed: againFailed }) : null;
    if (again && interrupted(again)) return ended(again);
    // Each failing test passed in the other run: flaky, not a test the selection missed, so the kit isn't held for it (on
    // 2026-10-15 kit 2.74.5 was, a test of the console the first time, a timeout's the second, each passing in the other).
    if (again && onlyFlaky(firstFailed, againFailed)) {
      say(`${o.tag}: its whole suite failed twice at ${at}, but no test failed both times, each passing in the other run: flaky, released all the same (the first time: ${first}; the second: ${again})`);
      return null;
    }
    if (again) return { why: `its whole suite failed at ${at}${again === first ? ', twice' : ` (the first time: ${first})`}: ${again}`, retry: false };
    say(`${o.tag}: the whole suite passed at ${at}${first ? ` on a second try (the first: ${first})` : ''}`);
    return null;
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      say(`couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
