import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf, fetchBranch, git, removeWorktree, showFile } from '../git.ts';
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
 * Tried once per head commit (kit-trials.json): a new push is tried afresh. An employee it failed is tried again, alone,
 * once its branch on origin has moved (fixed on its side, as Porter was for kit 2.40.0). Employees with no checkout
 * here, or not on the kit, aren't tried.
 */

export const KIT_BREAKS_LABEL = 'kit:breaks-agents';
export const kitTrialsFile = () => dataFile('kit-trials.json');
/** The Steward's own worktree of the PR's head, whose kit\ the employees are filled from. */
export const kitTrialDirOf = (ctx: Ctx) => path.join(workRootOf(ctx.settings), `_${APP.id}-kit-trial`);

export interface KitTrial {
  kit: string;
  /**
   * Each employee whose checks failed with it, what failed, and the commit of its branch on origin it was tried from
   * (null when that isn't known; missing in one kept before Steward 0.27.14).
   */
  failed: { id: string; name: string; message: string; main?: string | null }[];
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
    `**What to do:** change the kit so they pass as they are (a new push here is tried again), or fix the agents (once an agent's main moves, the next round tries it again), or, when the agents must change with it, add the label \`${KIT_BREAKS_LABEL}\` and say what each must do in the kit's changelog entry. The PR then merges, and each failed bump goes to the Wright.`,
  ].join('\n');
}

/** Each employee tried with the kit at the PR's head, its worktree and branch removed after. */
async function tryEach(ctx: Ctx, employees: Employee[], kit: string, dir: string): Promise<EmployeeResult[]> {
  // The PR's own kit changelog, so each trial bump writes the entry its real bump will (its tests read it too).
  const changelogFile = path.join(dir, 'kit', 'CHANGELOG.md');
  const changelog = existsSync(changelogFile) ? readFileSync(changelogFile, 'utf8') : null;
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    let r: EmployeeResult;
    try {
      r = await bumpOne(ctx, e, { kit, kitFrom: path.join(dir, 'kit'), tool: path.join(dir, 'tools', 'kit.ts'), trial: true, changelog });
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

/** `employees` tried with the kit at the PR's head, from the Steward's own worktree of it, removed after. */
async function tryAtHead(ctx: Ctx, steward: Employee, pr: PrInfo, kit: string, employees: Employee[]): Promise<EmployeeResult[]> {
  const repo = checkoutOf(steward);
  const dir = kitTrialDirOf(ctx);
  await removeWorktree(ctx.run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(ctx.run, repo, 'worktree', 'add', '--quiet', '--detach', dir, pr.headOid!);
  try {
    return await tryEach(ctx, employees, kit, dir);
  } finally {
    try {
      await removeWorktree(ctx.run, repo, dir);
    } catch (err) {
      ctx.log(`[${APP.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

const failuresOf = (results: EmployeeResult[]): KitTrial['failed'] =>
  results.filter((r) => r.outcome === 'failed').map((r) => ({ id: r.id, name: r.name, message: r.message, main: r.base ?? null }));

/**
 * The employees a kept trial failed whose branch on origin has moved since (fixed on their side): they are tried again.
 * One kept before their commits were (no `main`) counts as moved, once. One that can't be fetched now waits.
 */
async function movedOn(ctx: Ctx, t: KitTrial): Promise<Employee[]> {
  const moved: Employee[] = [];
  for (const f of t.failed) {
    const e = ctx.settings.employees.find((x) => x.id === f.id);
    if (!e || !e.usesKit || f.main === null || !existsSync(checkoutOf(e))) continue;
    try {
      await fetchBranch(ctx.run, checkoutOf(e), e.branch);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't fetch ${e.branch} to see whether it moved on since kit ${t.kit}'s trial: ${(err as Error).message}`);
      continue;
    }
    const now = await commitOf(ctx.run, checkoutOf(e), `origin/${e.branch}`);
    if (now && now !== f.main) moved.push(e);
  }
  return moved;
}

const sameFailures = (a: KitTrial['failed'], b: KitTrial['failed']) => a.length === b.length && a.every((f) => b.some((g) => g.id === f.id && g.message === f.message));

/**
 * Why a Steward PR that raises the kit waits for its trial, or null when it doesn't (no new kit in it, every employee
 * passing, or labelled KIT_BREAKS_LABEL). `steward`: the Steward as the merge stage's employee.
 */
export async function kitTrialHold(ctx: Ctx, steward: Employee, pr: PrInfo): Promise<string | null> {
  if (steward.id !== APP.id || !raisesKit(pr)) return null;
  if (!pr.headOid) return "GitHub didn't say its head commit, so its kit wasn't tried on the agents";
  const kept = readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
  const repo = checkoutOf(steward);
  let t = kept[keyOf(pr)];
  if (!t) {
    await git(ctx.run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
    const kit = (await showFile(ctx.run, repo, pr.headOid, 'kit/VERSION'))?.trim();
    if (!kit || !/^\d+\.\d+\.\d+$/.test(kit)) return `its kit/VERSION at ${pr.headOid.slice(0, 7)} isn't a version, so its kit wasn't tried on the agents`;
    const employees = ctx.settings.employees.filter((e) => e.usesKit && existsSync(checkoutOf(e)));
    ctx.log(`[${APP.id}] #${pr.number} raises the kit to ${kit}: trying it on ${employees.length} agents before it merges`);
    const results = await tryAtHead(ctx, steward, pr, kit, employees);
    // Refused (no kit.json on its main, say) isn't the kit's doing, and isn't held against it.
    const failed = results.filter((r) => r.outcome === 'failed');
    // One the network cut short is no verdict on the kit: not kept, so the next round tries it again.
    for (const r of failed) if (await networkFailure(ctx, r.message)) return `its kit's trial on ${r.name} was cut short by the network: the next round tries again`;
    t = { kit, failed: failuresOf(results), passed: results.filter((r) => r.outcome === 'done').length, at: new Date().toISOString() };
  } else if (t.failed.length) {
    // Fixed on the agents' side: each whose branch moved since is tried again with the same kit.
    const moved = await movedOn(ctx, t);
    if (moved.length) {
      ctx.log(`[${APP.id}] #${pr.number}: ${moved.map((e) => e.name).join(', ')} moved on since kit ${t.kit} failed their checks: trying ${moved.length === 1 ? 'it' : 'them'} again`);
      await git(ctx.run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
      const results = await tryAtHead(ctx, steward, pr, t.kit, moved);
      // Cut short by the network: the kept verdict stands, and the next round tries them again (their main still moved).
      for (const r of results) if (r.outcome === 'failed' && (await networkFailure(ctx, r.message))) return `its kit's trial on ${r.name} was cut short by the network: the next round tries again`;
      const ids = new Set(moved.map((e) => e.id));
      const failed = [...t.failed.filter((f) => !ids.has(f.id)), ...failuresOf(results)];
      const now: KitTrial = { kit: t.kit, failed, passed: t.passed + results.filter((r) => r.outcome === 'done').length, at: new Date().toISOString() };
      if (sameFailures(t.failed, failed)) now.commented = t.commented;
      else if (!failed.length) {
        const names = results.filter((r) => r.outcome === 'done').map((r) => r.name);
        const body = `The Steward tried kit ${t.kit} again, as this PR has it at ${pr.headOid.slice(0, 7)}, on ${names.join(', ')}, whose main moved on since: every agent passes with it now, so it merges.`;
        const r = await ctx.run('gh', ['pr', 'comment', String(pr.number), '--repo', steward.repo, '--body', body], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
        now.commented = r.code === 0;
      }
      t = now;
    }
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
  return `kit ${t.kit} fails ${t.failed.length} agent${t.failed.length === 1 ? "'s" : "s'"} checks here (${names}): its comment says which tests; fix the kit or the agents, or label it ${KIT_BREAKS_LABEL}`;
}
