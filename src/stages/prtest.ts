import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { git, removeWorktree } from '../git.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee, Settings } from '../settings.ts';
import { runChecks } from './bump.ts';
import { checkoutOf, workRootOf, type Ctx } from './common.ts';
import type { PrInfo } from './staff.ts';

/**
 * A team PR that GitHub runs no checks on is tested here before it's merged: the employee's own checks (Settings,
 * as bump runs them: npm ci for a Node agent, its kit filled, each test command) at the PR's head commit, in a
 * worktree of its own in the work folder. Only the team's PRs come here (strangers' are never touched), so their
 * code runs on this PC as yours would. Each result is kept by commit (pr-checks.json): a round tests a commit
 * once, and a new push is tested afresh.
 */

export const prChecksFile = () => dataFile('pr-checks.json');
export const prDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-pr`);

export interface Tested {
  ok: boolean;
  /** "checks passed here at abc1234", or what failed. */
  note: string;
  at: string;
}

const keyOf = (e: Employee, pr: PrInfo) => `${e.id}#${pr.number}@${pr.headOid}`;

/** What testing this PR's head here said before, if it has been. */
export const testedBefore = (e: Employee, pr: PrInfo): Tested | null => (pr.headOid ? (readJson<Record<string, Tested>>(prChecksFile(), {})[keyOf(e, pr)] ?? null) : null);

export async function testAtHead(ctx: Ctx, e: Employee, pr: PrInfo): Promise<Tested> {
  const before = testedBefore(e, pr);
  if (before) return before;
  if (!pr.headOid) return { ok: false, note: "GitHub didn't say its head commit, so it wasn't tested here", at: new Date().toISOString() };
  const tested = await test(ctx, e, pr);
  // Kept by commit, a "can't" too; the oldest go once there are more than 500.
  const kept = readJson<Record<string, Tested>>(prChecksFile(), {});
  kept[keyOf(e, pr)] = tested;
  writeJson(prChecksFile(), Object.fromEntries(Object.entries(kept).slice(-500)));
  return tested;
}

async function test(ctx: Ctx, e: Employee, pr: PrInfo): Promise<Tested> {
  const now = () => new Date().toISOString();
  if (!e.test.length) return { ok: false, note: `Settings give ${e.name} no checks to test it with`, at: now() };
  const { run } = ctx;
  const repo = checkoutOf(e);
  const sha = pr.headOid.slice(0, 7);
  await git(run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
  const dir = prDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, pr.headOid);
  ctx.log(`[${e.id}] #${pr.number} has no checks on GitHub: testing it here at ${sha}, in ${dir}`);
  try {
    const failed = await runChecks(ctx, e, dir, { say: (line) => ctx.log(`[${e.id}] ${line}`) });
    return failed ? { ok: false, note: `its checks failed here at ${sha}: ${failed}`, at: now() } : { ok: true, note: `checks passed here at ${sha}`, at: now() };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
