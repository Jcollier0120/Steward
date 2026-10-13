import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf, fetchBranch, fetchFor, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { bumpOne, checksLogOf, runChecks, trialBranch, trialDirOf } from './bump.ts';
import { checkoutOf, glanceOf, mapLimit, networkFailure, result, clearWorkDir, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { openPrs, parsePrs, readPin, type PrInfo } from './staff.ts';
import { hostFor } from '../hosts/index.ts';
import { kitReach } from './kitreach.ts';
import { blobOf, kitTrialsFile, type TrialPasses } from './trialpass.ts';
import { apart, withRepo } from './slots.ts';

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
 *
 * What is tried is the PR's kit\ and tools\kit.ts, so a new head that changes neither (the PR caught up with its branch:
 * version lines and changelogs) keeps the trial's verdict, tried again only for its agents whose branch moved. And each
 * agent that passes is kept with the commit it was bumped from: its rollout bump from that same commit, once the kit is
 * released as tried, isn't checked a second time (trialpass.ts).
 *
 * In slices, so the round isn't held for the whole trial: each round tries a few agents (Settings' parallel at a time)
 * for at most TRIAL_SLICE_MS, keeps what it found (KitTrial's `pending`: the ones still to try), and goes on with the
 * rest of its work; the PR waits meanwhile (TRIAL_GOING, a brief wait: the next round comes sooner). And each agent is
 * tried only as far as the kit changes it (kitreach.ts): one none of whose kit files change isn't tried at all, and one
 * whose files change runs only the tests they reach; its rollout's bump runs them all.
 */

/** How long a round tries agents for before it goes on with the rest of its work (the agents in flight finish). */
export const TRIAL_SLICE_MS = 8 * 60_000;

/** How the hold of a PR whose kit is still being tried begins (merge.ts's waitsBriefly). */
export const TRIAL_GOING = 'its kit is being tried on the agents';

export const KIT_BREAKS_LABEL = 'kit:breaks-agents';
export { kitTrialsFile };
/** The Steward's own worktree of the PR's head, whose kit\ the employees are filled from. */
export const kitTrialDirOf = (ctx: Ctx) => path.join(workRootOf(ctx.settings), `_${APP.id}-kit-trial`);

export interface KitTrial extends TrialPasses {
  kit: string;
  /**
   * Each employee whose checks failed with it, what failed, and the commit of its branch on origin it was tried from
   * (null when that isn't known; missing in one kept before Steward 0.27.14).
   */
  failed: { id: string; name: string; message: string; main?: string | null }[];
  /** How many were tried, and passed. */
  passed: number;
  /** The employees (by id) still to try, while the trial goes on over several rounds; gone once all are tried. */
  pending?: string[];
  /** How many weren't tried: nothing they take from the kit changes (kitreach.ts). */
  untouched?: number;
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
  /** While it is tried on its own (trialsOnTheirOwn): the process trying it, and when it last saved. */
  by?: { pid: number; at: string };
}

/**
 * Called when a trial tried on its own ends (`cut`: what cut it short, or null): set by the Steward's page (agent.ts),
 * whose rounds then try a kit PR's agents on their own, beside the rounds, instead of a slice each round. Unset (a round
 * in a terminal, the tests), a trial goes in slices as before.
 */
let onTheirOwn: ((ended: { pr: number; cut: string | null }) => void) | null = null;
export const trialsOnTheirOwn = (ended: typeof onTheirOwn) => void (onTheirOwn = ended);

/** The trial being tried on its own in this process: one at a time, so two never try the same agent's folder. */
let running: { key: string; pr: number; kit: string } | null = null;

/** How long a trial's process may go without saving before another counts it gone: longer than any one agent's try. */
const BY_QUIET_MS = 30 * 60_000;

/** Whether another process is trying `t` on its own now: alive, and saved within BY_QUIET_MS. */
function triedElsewhere(t: KitTrial, now = Date.now()): boolean {
  if (!t.by || t.by.pid === process.pid || now - Date.parse(t.by.at) > BY_QUIET_MS) return false;
  try {
    process.kill(t.by.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The hold of a PR whose trial goes on: how far it got. Pure. */
const goingWords = (t: KitTrial): string => {
  const pending = t.pending?.length ?? 0;
  const total = t.passed + t.failed.length + (t.untouched ?? 0) + pending;
  const failing = t.failed.length ? `, ${t.failed.length} failing (${t.failed.map((f) => f.name).join(', ')})` : '';
  return `${TRIAL_GOING}: ${total - pending} of ${total} so far${failing}; the rounds go on meanwhile`;
};

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
async function tryEach(ctx: Ctx, employees: Employee[], kit: string, dir: string, reachFrom?: { repo: string; head: string }): Promise<EmployeeResult[]> {
  // The PR's own kit changelog, so each trial bump writes the entry its real bump will (its tests read it too).
  const changelogFile = path.join(dir, 'kit', 'CHANGELOG.md');
  const changelog = existsSync(changelogFile) ? readFileSync(changelogFile, 'utf8') : null;
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    let r: EmployeeResult;
    try {
      r = await withRepo(ctx.log, e.id, () =>
        bumpOne(ctx, e, {
          kit,
          kitFrom: path.join(dir, 'kit'),
          tool: path.join(dir, 'tools', 'kit.ts'),
          trial: true,
          changelog,
          ...(reachFrom ? { reach: (_e: Employee, pin: { kit: string; parts: string[] | null }, toolChanged: boolean) => kitReach(ctx, { ...reachFrom, pin, toolChanged }) } : {}),
        }),
      );
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
  clearWorkDir(ctx.settings, dir);
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
  withKitTree(ctx, steward, pr, (dir) => tryEach(ctx, employees, kit, dir, { repo: checkoutOf(steward), head: pr.headOid! }));

/**
 * An employee's open PRs whose kit.json pins exactly `kit` at their head: to its branch, from the repository itself,
 * the team's or the Steward's (a stranger's code never runs here), lowest number first. From the stage's glance when
 * it has them.
 */
export async function pinningPrs(ctx: Ctx, e: Employee, kit: string): Promise<PrInfo[]> {
  const g = glanceOf(ctx, e);
  const prs = parsePrs(g ? JSON.stringify(g.prs) : await openPrs(hostFor(ctx, e), e.repo), ctx.settings.team);
  const repo = checkoutOf(e);
  const out: PrInfo[] = [];
  for (const p of prs) {
    if (p.fork || p.base !== e.branch || !p.headOid) continue;
    await fetchFor(ctx.run, repo, p.headOid, `refs/pull/${p.number}/head`);
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
  clearWorkDir(ctx.settings, dir);
  rmSync(checksLogOf(dir), { force: true });
  await fetchFor(run, repo, p.headOid, `refs/pull/${p.number}/head`);
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
    await fetchFor(ctx.run, checkoutOf(steward), pr.headOid, `refs/pull/${pr.number}/head`);
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
 * Each employee that passed with all its checks, by id: the commit of its branch it was bumped from (TrialPasses'
 * `mains`). One that ran only some of them (`partial`) isn't: its rollout's bump runs them all.
 */
const mainsOf = (results: EmployeeResult[]): Record<string, string> => Object.fromEntries(results.filter((r) => r.outcome === 'done' && r.base && !r.partial).map((r) => [r.id, r.base!]));

/** The memory one agent's try may take at its peak: its install, a type check and a test run side by side. */
const TRY_BYTES = 3 * 1024 ** 3;

/**
 * How many agents a trial tries at once: Settings' parallel, or a quarter of this PC's processors up to 4, whichever is
 * more; never more than the memory free now holds at TRY_BYTES each (at least one). A try is an agent's install, its kit
 * filled and the tests the kit reaches, most of it waiting on its own processes: kit 2.62.0's 34 tries took 21 s each on
 * average, and two at a time left the trial waiting on itself. Their commands run at the kit's checks pace (Steward
 * 0.35.64), in one job for the PC with one processor cap: more tries at once share that cap rather than adding to it, so
 * the processor is held to it whatever this says, and memory stays the limit. Pure.
 */
export const trialParallel = (parallel: number, cpus = os.availableParallelism(), free = os.freemem()): number =>
  Math.max(1, Math.min(Math.max(parallel, Math.min(4, Math.floor(cpus / 4))), Math.floor(free / TRY_BYTES)));

/**
 * A slice of a trial (KitTrial's `pending`): its agents tried trialParallel at a time, each only as far as the kit
 * changes it, the next one started as soon as one ends, until none are left or `sliceMs` has passed (those in flight
 * finish); `save` after each. A try the network cut short leaves its agent to try again, and says so (no more are
 * started).
 */
async function trySlice(ctx: Ctx, steward: Employee, pr: PrInfo, t: KitTrial, sliceMs: number, save: () => void): Promise<string | null> {
  const repo = checkoutOf(steward);
  await fetchFor(ctx.run, repo, pr.headOid, `refs/pull/${pr.number}/head`);
  const t0 = Date.now();
  return withKitTree(ctx, steward, pr, async (dir) => {
    let cut: string | null = null;
    const queue = [...(t.pending ?? [])];
    // The first of each slice always starts, so every round gets on with it.
    let started = 0;
    const next = async (): Promise<void> => {
      while (queue.length && !cut && (!started || Date.now() - t0 < sliceMs)) {
        started++;
        const id = queue.shift()!;
        const e = ctx.settings.employees.find((x) => x.id === id);
        const results = e && e.usesKit && existsSync(checkoutOf(e)) ? await tryEach(ctx, [e], t.kit, dir, { repo, head: pr.headOid! }) : [];
        const counted: EmployeeResult[] = [];
        for (const r of results) {
          if (r.outcome === 'failed' && (await networkFailure(ctx, r.message))) cut ??= `its kit's trial on ${r.name} was cut short by the network: the next round tries again`;
          else counted.push(r);
        }
        // Cut short: still pending. Tried, or gone from the staff meanwhile: no longer.
        if (results.length && !counted.length) continue;
        t.pending = (t.pending ?? []).filter((x) => x !== id);
        t.failed = [...t.failed, ...failuresOf(counted)];
        t.passed += counted.filter((r) => r.outcome === 'done').length;
        t.untouched = (t.untouched ?? 0) + counted.filter((r) => r.outcome === 'skipped' && r.message.includes(': not tried, ')).length;
        t.mains = { ...t.mains, ...mainsOf(counted) };
        save();
      }
    };
    await Promise.all(Array.from({ length: trialParallel(ctx.settings.parallel) }, next));
    return cut;
  });
}

/** What a trial at this head fills the agents with: the git tree of its kit\, and the blob of its tools/kit.ts (null for none). */
async function triedAt(ctx: Ctx, repo: string, head: string): Promise<{ tree?: string; tool?: string | null }> {
  const tree = (await gitMaybe(ctx.run, repo, 'rev-parse', `${head}:kit`))?.trim();
  if (!tree) return {};
  const tool = await showFile(ctx.run, repo, head, 'tools/kit.ts');
  return { tree, tool: tool === null ? null : blobOf(tool) };
}

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
 * A trial's pending agents tried on their own, to the end, beside the rounds (trialsOnTheirOwn): `t` saved after each
 * agent with this process as its `by`, and onTheirOwn told when it ends, so a round then settles the PR at once.
 */
function tryOnItsOwn(ctx: Ctx, steward: Employee, pr: PrInfo, t: KitTrial, save: () => void): void {
  running = { key: keyOf(pr), pr: pr.number, kit: t.kit };
  const saving = () => {
    t.by = { pid: process.pid, at: new Date().toISOString() };
    save();
  };
  saving();
  ctx.log(`[${APP.id}] #${pr.number}: trying kit ${t.kit} on ${t.pending!.length} agents, ${trialParallel(ctx.settings.parallel)} at a time, beside the rounds`);
  let cut: string | null = null;
  void apart('kit trial', () => trySlice(ctx, steward, pr, t, Number.POSITIVE_INFINITY, saving))
    .then(
      (c) => void (cut = c),
      (err: Error) => void (cut = `couldn't try its kit on the agents: ${err.message}`),
    )
    .finally(() => {
      running = null;
      delete t.by;
      save();
      if (cut) ctx.log(`[${APP.id}] #${pr.number}: ${cut}`);
      else ctx.log(`[${APP.id}] #${pr.number}: kit ${t.kit}'s trial ended: a round settles it now`);
      onTheirOwn?.({ pr: pr.number, cut });
    });
}

/**
 * Why a Steward PR that raises the kit waits for its trial, or null when it doesn't (no new kit in it, every employee
 * passing, each one failing moving with it in a PR of its own (pairUp), or labelled KIT_BREAKS_LABEL). `steward`: the
 * Steward as the merge stage's employee. `o.note`: given the pairs' words when they are why it merges, for its line.
 */
export async function kitTrialHold(ctx: Ctx, steward: Employee, pr: PrInfo, o: { note?: (words: string) => void; sliceMs?: number; going?: () => void } = {}): Promise<string | null> {
  if (steward.id !== APP.id || !raisesKit(pr)) return null;
  if (!pr.headOid) return "GitHub didn't say its head commit, so its kit wasn't tried on the agents";
  const kept = readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
  const repo = checkoutOf(steward);
  let t = kept[keyOf(pr)];
  // Tried just now: no branch has moved since.
  let fresh = false;
  if (!t) {
    await fetchFor(ctx.run, repo, pr.headOid, `refs/pull/${pr.number}/head`);
    const kit = (await showFile(ctx.run, repo, pr.headOid, 'kit/VERSION'))?.trim();
    if (!kit || !/^\d+\.\d+\.\d+$/.test(kit)) return `its kit/VERSION at ${pr.headOid.slice(0, 7)} isn't a version, so its kit wasn't tried on the agents`;
    const tried = await triedAt(ctx, repo, pr.headOid);
    // The same kit and tools/kit.ts tried at an earlier head of this PR (it was caught up with its branch since): its
    // verdict stands, and only the agents whose branch moved are tried again, below.
    const before = tried.tree ? Object.entries(kept).reverse().find(([k, x]) => k.startsWith(`${pr.number}@`) && x.kit === kit && x.tree === tried.tree && x.tool === tried.tool) : undefined;
    if (before) {
      ctx.log(`[${APP.id}] #${pr.number}: kit ${kit} was tried at ${before[0].split('@')[1].slice(0, 7)}, and its kit and tools/kit.ts are the same at ${pr.headOid.slice(0, 7)}: not tried again`);
      t = { ...before[1] };
    } else {
      const employees = ctx.settings.employees.filter((e) => e.usesKit && existsSync(checkoutOf(e)));
      ctx.log(`[${APP.id}] #${pr.number} raises the kit to ${kit}: trying it on ${employees.length} agents before it merges, ${onTheirOwn ? `${trialParallel(ctx.settings.parallel)} at a time, beside the rounds` : 'a few each round'}`);
      t = { kit, failed: [], passed: 0, at: new Date().toISOString(), ...tried, mains: {}, pending: employees.map((e) => e.id) };
    }
  }
  const key = keyOf(pr);
  // Written over the file as it is now, not as this round read it: a trial tried on its own saves beside the rounds.
  const saveOf = (x: KitTrial) => () => {
    const all = readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
    all[key] = x;
    writeJson(kitTrialsFile(), Object.fromEntries(Object.entries(all).slice(-100)));
  };
  const save = () => saveOf(t)();
  // Another kit's trial going on its own: this one's tries wait for it, so two trials never fill one agent's folder.
  const otherGoing = () => {
    if (!running || running.key === key) return null;
    o.going?.();
    return `${TRIAL_GOING}: it waits for kit ${running.kit}'s trial (#${running.pr}) to end first; the rounds go on meanwhile`;
  };
  if (t.pending?.length && (running?.key === key || triedElsewhere(t))) {
    // Being tried on its own, here or by another process: how far it got.
    o.going?.();
    return goingWords(t);
  }
  if (t.pending?.length && onTheirOwn) {
    const waits = otherGoing();
    if (waits) return waits;
    tryOnItsOwn(ctx, steward, pr, t, saveOf(t));
    o.going?.();
    return goingWords(t);
  }
  if (t.pending) {
    // Still being tried: this round's slice, kept as it goes. Refused (no kit.json on its main, say) isn't the kit's
    // doing, and isn't held against it; one the network cut short is no verdict on the kit, and is tried again.
    const cut = t.pending.length ? await trySlice(ctx, steward, pr, t, o.sliceMs ?? TRIAL_SLICE_MS, save) : null;
    if (cut || t.pending.length) {
      o.going?.();
      if (cut) return cut;
      return goingWords(t);
    }
    fresh = true;
    delete t.pending;
    // Tried side by side, they ended in any order: named in the staff's.
    const order = (id: string) => ctx.settings.employees.findIndex((e) => e.id === id) >>> 0;
    t.failed = [...t.failed].sort((a, b) => order(a.id) - order(b.id));
    t.at = new Date().toISOString();
    ctx.log(`[${APP.id}] #${pr.number}: kit ${t.kit} tried on every agent: ${t.passed} passed, ${t.failed.length} failed, ${t.untouched ?? 0} not tried (nothing they take from the kit changes)`);
  }
  if (!fresh && t.failed.length) {
    // Fixed on the agents' side: each whose branch moved since is tried again with the same kit.
    const moved = await movedOn(ctx, t);
    if (moved.length) {
      const waits = otherGoing();
      if (waits) return waits;
      ctx.log(`[${APP.id}] #${pr.number}: ${moved.map((e) => e.name).join(', ')} moved on since kit ${t.kit} failed their checks: trying ${moved.length === 1 ? 'it' : 'them'} again`);
      await fetchFor(ctx.run, repo, pr.headOid, `refs/pull/${pr.number}/head`);
      const results = await tryAtHead(ctx, steward, pr, t.kit, moved);
      // Cut short by the network: the kept verdict stands, and the next round tries them again (their main still moved).
      for (const r of results) if (r.outcome === 'failed' && (await networkFailure(ctx, r.message))) return `its kit's trial on ${r.name} was cut short by the network: the next round tries again`;
      const ids = new Set(moved.map((e) => e.id));
      const failed = [...t.failed.filter((f) => !ids.has(f.id)), ...failuresOf(results)];
      // Its pairs kept, by head commit: one tried before isn't tried again (pairUp).
      const mains = { ...Object.fromEntries(Object.entries(t.mains ?? {}).filter(([id]) => !ids.has(id))), ...mainsOf(results) };
      const now: KitTrial = { kit: t.kit, failed, passed: t.passed + results.filter((r) => r.outcome === 'done').length, at: new Date().toISOString(), ...(t.tree ? { tree: t.tree, tool: t.tool } : {}), mains, ...(t.pairs ? { pairs: t.pairs } : {}), ...(t.pairsSaid ? { pairsSaid: t.pairsSaid } : {}) };
      if (sameFailures(t.failed, failed)) now.commented = t.commented;
      else if (!failed.length) {
        const names = results.filter((r) => r.outcome === 'done').map((r) => r.name);
        const body = `The Steward tried kit ${t.kit} again, as this PR has it at ${pr.headOid.slice(0, 7)}, on ${names.join(', ')}, whose main moved on since: every agent passes with it now, so it merges.`;
        const r = await hostFor(ctx, steward).commentPr(steward.repo, pr.number, body);
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
    const waits = otherGoing();
    if (waits) return waits;
    const p = await pairUp(ctx, steward, pr, t);
    t.pairs = p.pairs;
    cut = p.cut;
  } else if (!t.failed.length) delete t.pairs;
  const standing = standingFailures(t);
  const sha = pr.headOid.slice(0, 7);
  if (standing.length && !t.commented) {
    const r = await hostFor(ctx, steward).commentPr(steward.repo, pr.number, trialComment(t, sha));
    t.commented = r.code === 0;
  } else if (t.failed.length && !standing.length && t.pairsSaid !== pairWords(t)) {
    const r = await hostFor(ctx, steward).commentPr(steward.repo, pr.number, pairComment(t, sha));
    if (r.code === 0) t.pairsSaid = pairWords(t);
  }
  // Kept by head commit; the oldest go once there are more than 100.
  save();
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
