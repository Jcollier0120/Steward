import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { commitOf, fetchBranch, git, removeWorktree, showFile } from '../git.ts';
import { latestKit } from '../kitsource.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee, Settings } from '../settings.ts';
import { runChecks } from './bump.ts';
import { checkoutOf, workRootOf, type Ctx } from './common.ts';
import { readPin, type PrInfo } from './staff.ts';
import { recordTested } from '../tested.ts';

/**
 * A team PR that GitHub runs no checks on is tested here before it's merged: the employee's own checks (Settings,
 * as bump runs them: npm ci for a Node agent, its kit filled, each test command) at the PR's head commit, in a
 * worktree of its own in the work folder. Only the team's PRs come here (strangers' are never touched), so their
 * code runs on this PC as yours would. Each result is kept by commit (pr-checks.json): a round tests a commit
 * once, and a new push is tested afresh. A failure is tried once more at once, so one flaky test doesn't hold a PR
 * (the note says when it passed the second time); one that fails twice waits, and is caught up (catchup.ts) once its
 * branch has moved on, to be tested again with what the branch gained.
 */

export const prChecksFile = () => dataFile('pr-checks.json');
export const prDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-pr`);

export interface Tested {
  ok: boolean;
  /** "checks passed here at abc1234", or what failed. */
  note: string;
  at: string;
  /** The employee's branch on origin when it was tested: the branch moving on since is a reason to try again. */
  branch?: string;
  /** The newest kit released when it was tested: a failure at its kit's fill is tried again once a newer one is (kitMayClear). */
  kit?: string;
}

const keyOf = (e: Employee, pr: PrInfo) => `${e.id}#${pr.number}@${pr.headOid}`;

/** What testing this PR's head here said before, if it has been. */
export const testedBefore = (e: Employee, pr: PrInfo): Tested | null => (pr.headOid ? (readJson<Record<string, Tested>>(prChecksFile(), {})[keyOf(e, pr)] ?? null) : null);

/**
 * Whether a failure here may be cleared by a kit released since: it failed at the kit's fill (tools/kit.ts), and the
 * newest kit released now isn't the one it was tested beside (one tested before 0.27.38 kept none). Manor#135 failed
 * at its fill for a kit not yet released, and waited for ever, with the PRs above it. Pure.
 */
export const kitMayClear = (e: Employee, t: Tested, newest: string | null) => !t.ok && !!e.fill && t.note.includes(`: ${e.fill} failed`) && !!newest && t.kit !== newest;

/** How the hold of a PR whose kit isn't released yet begins. */
export const KIT_WAIT = 'waits for the kit it takes: ';

/**
 * Why a PR on the kit waits before it is tested here, or null: the kit its kit.json pins at its head has no release yet
 * (a PR made beside the Steward's own that raises the kit), so its fill would fail. It is tested once that kit is
 * released (the round releases the Steward's kit before the agents' merges: steward.ts). Null when the kit's releases
 * couldn't be read, or its pin can't: then it is tested as before.
 */
export async function kitReleaseHold(ctx: Ctx, e: Employee, pr: PrInfo): Promise<string | null> {
  if (!e.usesKit || !e.fill || !pr.headOid || !ctx.kit?.released.length) return null;
  const repo = checkoutOf(e);
  await git(ctx.run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
  const pin = readPin(await showFile(ctx.run, repo, pr.headOid, 'kit.json'));
  if (!pin || ctx.kit.released.includes(pin.kit)) return null;
  return `${KIT_WAIT}kit ${pin.kit} isn't released yet, so its kit couldn't be filled: it is tested here once it is`;
}

export async function testAtHead(ctx: Ctx, e: Employee, pr: PrInfo): Promise<Tested> {
  const before = testedBefore(e, pr);
  const newest = latestKit(ctx.kit);
  if (before && kitMayClear(e, before, newest)) ctx.log(`[${e.id}] #${pr.number} failed at its kit's fill before kit ${newest} was released: tested here again`);
  else if (before) return before;
  if (!pr.headOid) return { ok: false, note: "GitHub didn't say its head commit, so it wasn't tested here", at: new Date().toISOString() };
  const tested = { ...(await test(ctx, e, pr)), ...(newest ? { kit: newest } : {}) };
  // Kept by commit, a "can't" too; the oldest go once there are more than 500.
  const kept = readJson<Record<string, Tested>>(prChecksFile(), {});
  kept[keyOf(e, pr)] = tested;
  writeJson(prChecksFile(), Object.fromEntries(Object.entries(kept).slice(-500)));
  // Passed here before it merges: the Surveyor's GET /api/tested (tested.ts).
  if (tested.ok) recordTested(e.id, { commit: pr.headOid, stage: 'merge', branch: pr.head, pr: pr.number, at: tested.at });
  return tested;
}

async function test(ctx: Ctx, e: Employee, pr: PrInfo): Promise<Tested> {
  const now = () => new Date().toISOString();
  if (!e.test.length) return { ok: false, note: `Settings give ${e.name} no checks to test it with`, at: now() };
  const { run } = ctx;
  const repo = checkoutOf(e);
  const sha = pr.headOid.slice(0, 7);
  await git(run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
  await fetchBranch(run, repo, e.branch);
  const branch = (await commitOf(run, repo, `origin/${e.branch}`)) ?? undefined;
  const dir = prDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, pr.headOid);
  ctx.log(`[${e.id}] #${pr.number} has no checks on GitHub: testing it here at ${sha}, in ${dir}`);
  try {
    const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
    const failed = await runChecks(ctx, e, dir, { say });
    if (!failed) return { ok: true, note: `checks passed here at ${sha}`, at: now(), branch };
    say(`#${pr.number}: its checks once more (${failed})`);
    const again = await runChecks(ctx, e, dir, { say });
    return again
      ? { ok: false, note: `its checks failed here at ${sha}, twice: ${again}`, at: now(), branch }
      : { ok: true, note: `checks passed here at ${sha} on a second try (the first: ${failed})`, at: now(), branch };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
