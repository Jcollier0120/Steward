import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { git, removeWorktree, showFile } from '../git.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { bumpOne, trialBranch, trialDirOf } from './bump.ts';
import { checkoutOf, mapLimit, networkFailure, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import type { PrInfo } from './staff.ts';

/**
 * A new kit tried on every employee before it is released: when a team PR to the Steward's own repository raises
 * kit/VERSION, the round, before it merges that PR (stages/merge.ts), bumps each employee on the kit to it as the
 * rollout will once it's released (stages/bump.ts, in a trial: a worktree of its own, the kit filled from the PR's
 * kit\ and tools\kit.ts, nothing committed, nothing pushed), and runs its checks.
 *
 * Every one passing, the PR merges as before. One failing holds the PR, with a comment on it naming each employee and
 * the tests that failed: a kit that changes what an agent's tests rely on (kit 2.20.0 renamed "the NPU" in a note's
 * label, and nine agents' bumps failed after its release) is fixed in the kit's own PR, by whoever wrote it, before
 * any agent sees it. When the agents must change with the kit, the PR says so with the label KIT_BREAKS_LABEL: it
 * then merges, and each failed bump goes to the Wright as before (work.ts).
 *
 * Tried once per head commit (kit-trials.json): a new push is tried afresh. Employees with no checkout here, or not
 * on the kit, aren't tried.
 */

export const KIT_BREAKS_LABEL = 'kit:breaks-agents';
export const kitTrialsFile = () => dataFile('kit-trials.json');
/** The Steward's own worktree of the PR's head, whose kit\ the employees are filled from. */
export const kitTrialDirOf = (ctx: Ctx) => path.join(workRootOf(ctx.settings), `_${APP.id}-kit-trial`);

export interface KitTrial {
  kit: string;
  /** Each employee whose checks failed with it, and what failed. */
  failed: { id: string; name: string; message: string }[];
  /** How many were tried, and passed. */
  passed: number;
  at: string;
  /** Whether its comment on the PR was left. */
  commented?: boolean;
}

const keyOf = (pr: PrInfo) => `${pr.number}@${pr.headOid}`;

/** Does this PR raise the kit's version (so it is the kit's release once merged)? From gh's files. */
export const raisesKit = (pr: PrInfo) => pr.files.some((f) => f.replace(/\\/g, '/') === 'kit/VERSION');

/** The comment on the PR: the employees the kit breaks, and what to do. Pure. */
export function trialComment(t: KitTrial, sha: string): string {
  const lines = t.failed.map((f) => `- **${f.name}**: ${f.message.replace(/\r?\n/g, ' ')}`);
  return [
    `The Steward tried kit ${t.kit}, as this PR has it at ${sha}, on every agent before releasing it: ${t.failed.length} of ${t.failed.length + t.passed} fail their checks with it.`,
    '',
    ...lines,
    '',
    `Each was bumped as the rollout will bump it once the kit is released: its main, kit.json pinned to ${t.kit}, its kit filled from this PR's kit\\ and tools\\kit.ts, then its own checks, twice.`,
    '',
    `**What to do:** change the kit so they pass as they are (a new push here is tried again), or, when the agents must change with it, add the label \`${KIT_BREAKS_LABEL}\` and say what each must do in the kit's changelog entry. The PR then merges, and each failed bump goes to the Wright.`,
  ].join('\n');
}

/** Each employee tried with the kit at the PR's head, its worktree and branch removed after. */
async function tryEach(ctx: Ctx, employees: Employee[], kit: string, dir: string): Promise<EmployeeResult[]> {
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    let r: EmployeeResult;
    try {
      r = await bumpOne(ctx, e, { kit, kitFrom: path.join(dir, 'kit'), tool: path.join(dir, 'tools', 'kit.ts'), trial: true, changelog: null });
    } catch (err) {
      r = result(e, 'failed', (err as Error).message);
    }
    const repo = checkoutOf(e);
    try {
      if (existsSync(repo)) await removeWorktree(ctx.run, repo, trialDirOf(ctx.settings, e), trialBranch(kit));
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove its trial: ${(err as Error).message}`);
    }
    ctx.log(`[${e.id}] kit ${kit} trial: ${r.outcome}: ${r.message}`);
    return r;
  });
}

/**
 * Why a Steward PR that raises the kit waits for its trial, or null when it doesn't (no new kit in it, every employee
 * passing, or labelled KIT_BREAKS_LABEL). `steward`: the Steward as the merge stage's employee.
 */
export async function kitTrialHold(ctx: Ctx, steward: Employee, pr: PrInfo): Promise<string | null> {
  if (steward.id !== APP.id || !raisesKit(pr)) return null;
  if (!pr.headOid) return "GitHub didn't say its head commit, so its kit wasn't tried on the agents";
  const kept = readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
  let t = kept[keyOf(pr)];
  if (!t) {
    const repo = checkoutOf(steward);
    await git(ctx.run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
    const kit = (await showFile(ctx.run, repo, pr.headOid, 'kit/VERSION'))?.trim();
    if (!kit || !/^\d+\.\d+\.\d+$/.test(kit)) return `its kit/VERSION at ${pr.headOid.slice(0, 7)} isn't a version, so its kit wasn't tried on the agents`;
    const dir = kitTrialDirOf(ctx);
    await removeWorktree(ctx.run, repo, dir);
    if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
    await git(ctx.run, repo, 'worktree', 'add', '--quiet', '--detach', dir, pr.headOid);
    const employees = ctx.settings.employees.filter((e) => e.usesKit && existsSync(checkoutOf(e)));
    ctx.log(`[${APP.id}] #${pr.number} raises the kit to ${kit}: trying it on ${employees.length} agents before it merges`);
    let results: EmployeeResult[];
    try {
      results = await tryEach(ctx, employees, kit, dir);
    } finally {
      try {
        await removeWorktree(ctx.run, repo, dir);
      } catch (err) {
        ctx.log(`[${APP.id}] couldn't remove ${dir}: ${(err as Error).message}`);
      }
    }
    // Refused (no kit.json on its main, say) isn't the kit's doing, and isn't held against it.
    const failed = results.filter((r) => r.outcome === 'failed');
    // One the network cut short is no verdict on the kit: not kept, so the next round tries it again.
    for (const r of failed) if (await networkFailure(ctx, r.message)) return `its kit's trial on ${r.name} was cut short by the network: the next round tries again`;
    t = { kit, failed: failed.map((r) => ({ id: r.id, name: r.name, message: r.message })), passed: results.filter((r) => r.outcome === 'done').length, at: new Date().toISOString() };
  }
  if (t.failed.length && !t.commented) {
    const r = await ctx.run('gh', ['pr', 'comment', String(pr.number), '--repo', steward.repo, '--body', trialComment(t, pr.headOid.slice(0, 7))], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
    t.commented = r.code === 0;
  }
  // Kept by head commit; the oldest go once there are more than 100.
  kept[keyOf(pr)] = t;
  writeJson(kitTrialsFile(), Object.fromEntries(Object.entries(kept).slice(-100)));
  if (!t.failed.length) return null;
  const names = t.failed.map((f) => f.name).join(', ');
  if (pr.labels.includes(KIT_BREAKS_LABEL)) {
    ctx.log(`[${APP.id}] #${pr.number}: kit ${t.kit} fails ${names}'s checks, and is labelled ${KIT_BREAKS_LABEL}: it merges, and their bumps go to the Wright`);
    return null;
  }
  return `kit ${t.kit} fails ${t.failed.length} agent${t.failed.length === 1 ? "'s" : "s'"} checks here (${names}): its comment says which tests; fix the kit, or label it ${KIT_BREAKS_LABEL}`;
}
