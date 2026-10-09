import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf, fetchBranch, gh, git, removeWorktree, showFile } from '../git.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { bumpOne, checksLogOf, runChecks, trialBranch, trialDirOf } from './bump.ts';
import { checkoutOf, glanceOf, mapLimit, networkFailure, result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { parsePrs, prListArgs, readPin, type PrInfo } from './staff.ts';

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
 *
 * An agent that changes with the kit in a PR of its own needs no label: when the kit fails its main, its open PRs (to
 * its branch, not from a fork, the team's or the Steward's) whose kit.json pins exactly the kit under trial are looked
 * for, and the first ready one is tried at its head, its kit filled from this PR's kit\ (with its own tools/kit.ts, as it
 * will merge). Passing, it is the agent's pair: the kit PR doesn't wait for that agent, it merges and the kit is
 * released, and the agent's PR, which waited for that kit (prtest.ts's kitReleaseHold), is tested and merged after it.
 * Kit 2.42.0 (Steward#126) and Manor 0.16.24 (Manor#135), two halves of one change, each waited for the other until the
 * owner labelled the kit's PR (2026-10-08). A pair is kept by the agent PR's head commit: a new push there is tried
 * afresh. One that fails, or is a draft, leaves the kit waiting as before, its hold saying so.
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
  /**
   * For each employee in `failed` that has an open PR pinning this kit: that PR, at the head it was tried at, and whether
   * its checks passed with the kit (a draft isn't tried, and doesn't pass). One that passed lets the kit merge without
   * that employee passing on its main.
   */
  pairs?: KitPair[];
  /** The words of the "moves with it" comment (pairWords), once it was left. */
  pairsSaid?: string;
}

export interface KitPair {
  id: string;
  name: string;
  number: number;
  head: string;
  ok: boolean;
  /** "checks passed here …", what failed, or that it is a draft. */
  message: string;
  draft?: boolean;
}

const keyOf = (pr: PrInfo) => `${pr.number}@${pr.headOid}`;

/** Does this PR raise the kit's version (so it is the kit's release once merged)? From gh's files. */
export const raisesKit = (pr: PrInfo) => pr.files.some((f) => f.replace(/\\/g, '/') === 'kit/VERSION');

/** The passing pair of an employee the kit fails, if it has one. Pure. */
export const passingPair = (t: KitTrial, id: string): KitPair | undefined => t.pairs?.find((p) => p.id === id && p.ok);

/** The employees the kit fails that no passing PR of theirs moves with: the ones the kit's PR waits for. Pure. */
export const standingFailures = (t: KitTrial): KitTrial['failed'] => t.failed.filter((f) => !passingPair(t, f.id));

/** "Manor moves with it in #135 (passes with this kit)", for each passing pair; '' for none. Pure. */
export const pairWords = (t: KitTrial): string =>
  t.failed
    .map((f) => passingPair(t, f.id))
    .filter((p): p is KitPair => !!p)
    .map((p) => `${p.name} moves with it in #${p.number} (passes with this kit)`)
    .join('; ');

/** What an employee's pair that doesn't let the kit merge says, after its line in the hold and the comment. Pure. */
const pairNote = (t: KitTrial, id: string): string => {
  const p = t.pairs?.find((x) => x.id === id);
  if (!p || p.ok) return '';
  return p.draft ? ` (its #${p.number} pins this kit, but is a draft: once it's ready, it is tried with this kit)` : ` (its #${p.number}, which pins this kit, fails too: ${p.message.replace(/\r?\n/g, ' ')})`;
};

/** The comment on the PR: the employees the kit breaks, and what to do. Pure. */
export function trialComment(t: KitTrial, sha: string): string {
  const standing = standingFailures(t);
  const lines = standing.map((f) => `- **${f.name}**: ${f.message.replace(/\r?\n/g, ' ')}${pairNote(t, f.id)}`);
  const moves = pairWords(t);
  return [
    `The Steward tried kit ${t.kit}, as this PR has it at ${sha}, on every agent before releasing it: ${standing.length} of ${t.failed.length + t.passed} fail their checks with it.`,
    '',
    ...lines,
    ...(moves ? ['', `Not waited for: ${moves}.`] : []),
    '',
    `Each was bumped as the rollout will bump it once the kit is released: its main, kit.json pinned to ${t.kit}, its kit filled from this PR's kit\\ and tools\\kit.ts, then its own checks, twice.`,
    '',
    `**What to do:** change the kit so they pass as they are (a new push here is tried again), or fix the agents (once an agent's main moves, the next round tries it again), or open a ready PR to the agent that pins kit ${t.kit} and passes with it (the next round tries it, and the kit then merges with it), or, when the agents must change later, add the label \`${KIT_BREAKS_LABEL}\` and say what each must do in the kit's changelog entry. The PR then merges, and each failed bump goes to the Wright.`,
  ].join('\n');
}

/** The comment once every agent the kit fails on its main moves with it in a PR of its own: the kit merges. Pure. */
export const pairComment = (t: KitTrial, sha: string): string =>
  `The Steward tried kit ${t.kit}, as this PR has it at ${sha}, on every agent: ${t.failed.map((f) => f.name).join(', ')} ${t.failed.length === 1 ? 'fails' : 'fail'} its checks with it on main, but ${pairWords(t)}. So this PR merges and the kit is released; then ${t.failed.length === 1 ? 'that PR is' : 'those PRs are'} tested with the released kit and merged.`;

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

/** `use` given the Steward's own worktree of the PR's head (its kit\ and tools\kit.ts), removed after. */
async function withKitTree<T>(ctx: Ctx, steward: Employee, pr: PrInfo, use: (dir: string) => Promise<T>): Promise<T> {
  const repo = checkoutOf(steward);
  const dir = kitTrialDirOf(ctx);
  await removeWorktree(ctx.run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(ctx.run, repo, 'worktree', 'add', '--quiet', '--detach', dir, pr.headOid!);
  try {
    return await use(dir);
  } finally {
    try {
      await removeWorktree(ctx.run, repo, dir);
    } catch (err) {
      ctx.log(`[${APP.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/** `employees` tried with the kit at the PR's head, from the Steward's own worktree of it, removed after. */
const tryAtHead = (ctx: Ctx, steward: Employee, pr: PrInfo, kit: string, employees: Employee[]): Promise<EmployeeResult[]> =>
  withKitTree(ctx, steward, pr, (dir) => tryEach(ctx, employees, kit, dir));

/**
 * An employee's open PRs whose kit.json pins exactly `kit` at their head: to its branch, from the repository itself,
 * the team's or the Steward's (a stranger's code never runs here), lowest number first. From the stage's glance when
 * it has them.
 */
export async function pinningPrs(ctx: Ctx, e: Employee, kit: string): Promise<PrInfo[]> {
  const g = glanceOf(ctx, e);
  const prs = parsePrs(g ? JSON.stringify(g.prs) : await gh(ctx.run, ctx.neutralDir, ...prListArgs(e.repo)), ctx.settings.team);
  const repo = checkoutOf(e);
  const out: PrInfo[] = [];
  for (const p of prs) {
    if (p.fork || p.base !== e.branch || !p.headOid) continue;
    await git(ctx.run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${p.number}/head`);
    if (readPin(await showFile(ctx.run, repo, p.headOid, 'kit.json'))?.kit === kit) out.push(p);
  }
  return out;
}

/**
 * An agent's PR tried at its head with the kit under trial: a worktree of its own (the trial's), its kit filled from
 * the kit PR's tree (STEWARD_KIT, which its own tools/kit.ts reads), then its checks, twice, as a PR is tested here.
 */
async function tryPair(ctx: Ctx, e: Employee, p: PrInfo, kitDir: string): Promise<{ ok: boolean; message: string }> {
  const { run } = ctx;
  const repo = checkoutOf(e);
  const dir = trialDirOf(ctx.settings, e);
  const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  rmSync(checksLogOf(dir), { force: true });
  await git(run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${p.number}/head`);
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, p.headOid);
  const sha = p.headOid.slice(0, 7);
  try {
    const env = { STEWARD_KIT: path.resolve(kitDir) };
    const first = await runChecks(ctx, e, dir, { env, say });
    if (!first) return { ok: true, message: `checks passed here at ${sha}` };
    say(`#${p.number}: its checks once more (${first})`);
    const again = await runChecks(ctx, e, dir, { env, say });
    return again ? { ok: false, message: `its checks failed at ${sha}, twice: ${again}` } : { ok: true, message: `checks passed here at ${sha} on a second try (the first: ${first})` };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      say(`couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * The pairs of the employees a trial failed (KitTrial's `pairs`): for each, its first ready PR that pins the kit, tried
 * at its head unless the same head was tried before; else its first draft that does, not tried. One whose PRs couldn't
 * be read has none this time. `cut`: a try the network cut short, which isn't kept, so the next round tries again.
 */
async function pairUp(ctx: Ctx, steward: Employee, pr: PrInfo, t: KitTrial): Promise<{ pairs: KitPair[]; cut: string | null }> {
  const found: { e: Employee; p: PrInfo }[] = [];
  const pairs: KitPair[] = [];
  for (const f of t.failed) {
    const e = ctx.settings.employees.find((x) => x.id === f.id);
    if (!e || !e.usesKit || !existsSync(checkoutOf(e))) continue;
    let prs: PrInfo[];
    try {
      prs = await pinningPrs(ctx, e, t.kit);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't look for a PR of its that pins kit ${t.kit}: ${(err as Error).message}`);
      continue;
    }
    const ready = prs.find((p) => !p.draft);
    if (ready) {
      const kept = t.pairs?.find((x) => x.id === e.id && x.number === ready.number && x.head === ready.headOid && !x.draft);
      if (kept) pairs.push(kept);
      else found.push({ e, p: ready });
    } else if (prs[0]) pairs.push({ id: e.id, name: e.name, number: prs[0].number, head: prs[0].headOid, ok: false, message: 'a draft', draft: true });
  }
  let cut: string | null = null;
  if (found.length) {
    ctx.log(`[${APP.id}] #${pr.number}: ${found.map(({ e, p }) => `${e.name}'s #${p.number}`).join(', ')} ${found.length === 1 ? 'pins' : 'pin'} kit ${t.kit}: trying ${found.length === 1 ? 'it' : 'them'} with it`);
    await git(ctx.run, checkoutOf(steward), 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
    const tried = await withKitTree(ctx, steward, pr, (dir) =>
      mapLimit(found, ctx.settings.parallel, async ({ e, p }) => {
        let r: { ok: boolean; message: string };
        try {
          r = await tryPair(ctx, e, p, path.join(dir, 'kit'));
        } catch (err) {
          r = { ok: false, message: (err as Error).message };
        }
        ctx.log(`[${e.id}] #${p.number} with kit ${t.kit}: ${r.ok ? 'passed' : 'failed'}: ${r.message}`);
        return { e, p, r };
      }),
    );
    for (const { e, p, r } of tried) {
      if (!r.ok && (await networkFailure(ctx, r.message))) {
        cut ??= `its kit's try on ${e.name}'s #${p.number} was cut short by the network: the next round tries again`;
        continue;
      }
      pairs.push({ id: e.id, name: e.name, number: p.number, head: p.headOid, ok: r.ok, message: r.message });
    }
  }
  return { pairs, cut };
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
 * passing, each one failing moving with it in a PR of its own (pairUp), or labelled KIT_BREAKS_LABEL). `steward`: the
 * Steward as the merge stage's employee. `o.note`: given the pairs' words when they are why it merges, for its line.
 */
export async function kitTrialHold(ctx: Ctx, steward: Employee, pr: PrInfo, o: { note?: (words: string) => void } = {}): Promise<string | null> {
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
      // Its pairs kept, by head commit: one tried before isn't tried again (pairUp).
      const now: KitTrial = { kit: t.kit, failed, passed: t.passed + results.filter((r) => r.outcome === 'done').length, at: new Date().toISOString(), ...(t.pairs ? { pairs: t.pairs } : {}), ...(t.pairsSaid ? { pairsSaid: t.pairsSaid } : {}) };
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
  const labelled = pr.labels.includes(KIT_BREAKS_LABEL);
  // An agent the kit fails on its main that moves with it in a PR of its own (pairUp): not waited for. Not looked for
  // once the PR is labelled, which merges it anyway.
  let cut: string | null = null;
  if (t.failed.length && !labelled) {
    const p = await pairUp(ctx, steward, pr, t);
    t.pairs = p.pairs;
    cut = p.cut;
  } else if (!t.failed.length) delete t.pairs;
  const standing = standingFailures(t);
  const sha = pr.headOid.slice(0, 7);
  if (standing.length && !t.commented) {
    const r = await ctx.run('gh', ['pr', 'comment', String(pr.number), '--repo', steward.repo, '--body', trialComment(t, sha)], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
    t.commented = r.code === 0;
  } else if (t.failed.length && !standing.length && t.pairsSaid !== pairWords(t)) {
    const r = await ctx.run('gh', ['pr', 'comment', String(pr.number), '--repo', steward.repo, '--body', pairComment(t, sha)], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
    if (r.code === 0) t.pairsSaid = pairWords(t);
  }
  // Kept by head commit; the oldest go once there are more than 100.
  kept[keyOf(pr)] = t;
  writeJson(kitTrialsFile(), Object.fromEntries(Object.entries(kept).slice(-100)));
  if (!t.failed.length) return null;
  if (!standing.length) {
    const words = pairWords(t);
    ctx.log(`[${APP.id}] #${pr.number}: kit ${t.kit} fails ${t.failed.map((f) => f.name).join(', ')} on main, but ${words}: it merges`);
    o.note?.(words);
    return null;
  }
  const names = standing.map((f) => f.name).join(', ');
  if (labelled) {
    ctx.log(`[${APP.id}] #${pr.number}: kit ${t.kit} fails ${names}'s checks, and is labelled ${KIT_BREAKS_LABEL}: it merges, and their bumps go to the Wright`);
    return null;
  }
  if (cut) return cut;
  // Each failing agent's PR that pins the kit but doesn't let it merge, in a few words (the comment has what failed).
  const notes = standing.flatMap((f) => {
    const p = t.pairs?.find((x) => x.id === f.id);
    return !p ? [] : p.draft ? [`${f.name}'s #${p.number} pins it, but is a draft: once it's ready, it is tried with this kit`] : [`${f.name}'s #${p.number}, which pins it, fails too`];
  });
  const moves = pairWords(t);
  return `kit ${t.kit} fails ${standing.length} agent${standing.length === 1 ? "'s" : "s'"} checks here (${names})${notes.length ? `; ${notes.join('; ')}` : ''}${moves ? `; ${moves}` : ''}: its comment says which tests; fix the kit or the agents, open a ready PR to the agent that pins kit ${t.kit} and passes with it, or label it ${KIT_BREAKS_LABEL}`;
}
