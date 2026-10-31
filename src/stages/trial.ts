import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf, fetchBranch, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { PARTS } from '../kitfiles.ts';
import { TOOL } from '../kitsource.ts';
import { CEILING_WORDS, PACE_CEILING, memoryInUse } from '../kit/pace.ts';
import { readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { bumpOne, trialBranch, trialDirOf, WITHOUT_THE_KIT } from './bump.ts';
import { checkoutOf, mapLimit, networkFailure, result, freshWorktree, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { kitReach } from './kitreach.ts';
import { blobOf, kitTrialsFile, type TrialPasses } from './trialpass.ts';
import { removeProfile, trialProfileOf } from './trialprofile.ts';
import { withRepo } from './slots.ts';
import { phaseOf, timed } from '../buildtimes.ts';
import { retiredOf } from '../retired.ts';

/**
 * A new kit tried on every employee before it is released (Steward 0.36.124: on main, at a build). When the kit on the
 * Steward's main (kit/VERSION) has no kit-v<version> release, the build, before it releases the kit (stages/self.ts),
 * bumps each employee on the kit to it as the rollout will once it's released (stages/bump.ts, in a trial: a worktree of
 * its own, the kit filled from main's kit\ and tools\kit.ts, nothing committed, nothing pushed), and runs its checks.
 *
 * Every one passing, the kit is released and rolled out. One failing holds the kit alone, and one alarm names each agent
 * and the tests that failed (alarms.ts's kitTrialConditions): the other repositories' releases go on, and so does the
 * Steward's own version once the kit isn't on main any more, or passes. Fix the kit on main (a new kit is tried afresh)
 * or the agent on its own main, so it passes with the kit and without it (once an agent's main moves, the next build
 * tries it again).
 *
 * Kept by main's commit (kit-trials.json, "main@<commit>"), and by the kit an agent gets (KitTrial's `content`: its
 * parts' trees and tools/kit.ts): main moving on with the same kit, but for versions and changelogs, keeps the verdict
 * (sameKitTrial), as does a kit a PR's trial tried before Steward 0.36.124. Each agent that passes is kept with the
 * commit it was bumped from: its rollout bump from that same commit, once the kit is released as tried, isn't checked a
 * second time (trialpass.ts).
 *
 * In slices, so a round isn't held for the whole trial: each round tries a few agents (trialParallel at a time) for at
 * most TRIAL_SLICE_MS, keeps what it found (KitTrial's `pending`: the ones still to try), and goes on with the rest of
 * its work. Between builds too, so a build finds its kit tried (stages/self.ts's trialAhead). A build waits for a trial
 * still going until its time runs out; then the kit waits for the next build, and its trial goes on from where it was.
 *
 * An agent that fails the way a PC under load fails (a test killed, EBUSY: underLoad), or fails without the kit too, but
 * otherwise, isn't held against the kit at once: it is tried once more, alone, once the trial's other agents are tried
 * (KitTrial's `retry`), and holds the kit only if it fails then too. And each agent is tried only as far as the kit
 * changes it (kitreach.ts): one none of whose kit files change isn't tried at all, and one whose files change runs only
 * the tests they reach. Its rollout's bump runs the same ones.
 *
 * An agent whose tests expected what the kit said before, where all the kit changed is that text (copied.ts), passes
 * once they are brought up to it, and doesn't hold the kit; its rollout's bump brings them up again, in its commit. Its
 * tests run in a scratch profile of their own (trialprofile.ts), never in what this PC holds.
 *
 * An agent Manor has retired (retired.ts) gets no kit, so it isn't tried: left out of a new trial, dropped from one going
 * on, and a failure of its that a trial kept no longer holds the kit.
 */

/** How long a round tries agents for before it goes on with the rest of its work (the agents in flight finish). */
export const TRIAL_SLICE_MS = 8 * 60_000;

/** How the words of a kit whose trial is still going begin. */
export const TRIAL_GOING = 'its kit is being tried on the agents';

export { kitTrialsFile };
/** The Steward's own worktree of main, whose kit\ the employees are filled from. */
export const kitTrialDirOf = (ctx: Ctx) => path.join(workRootOf(ctx.settings), `_${APP.id}-kit-trial`);

export interface KitTrial extends TrialPasses {
  kit: string;
  /**
   * Each employee whose checks failed with it, what failed, and the commit of its branch on origin it was tried from
   * (null when that isn't known), and the first distinct lines its failed step printed that say what went wrong.
   */
  failed: { id: string; name: string; message: string; main?: string | null; errors?: string[] }[];
  /** How many were tried, and passed. */
  passed: number;
  /** The employees (by id) still to try, while the trial goes on; gone once all are tried. */
  pending?: string[];
  /** How many weren't tried: nothing they take from the kit changes (kitreach.ts). */
  untouched?: number;
  /**
   * The employees that failed with the kit and without it alike (bump.ts's withoutTheKit): not the kit's doing, so not
   * held against it. Their own failure is theirs (or this PC's) to fix; their rollout bump will say so in its turn.
   */
  own?: { id: string; name: string; message: string }[];
  /** The Steward that tried it (APP.version). Failures one older than this one kept are tried again, once. */
  steward?: string;
  at: string;
  /**
   * The agents whose checks failed the way a PC under load fails them, or without the kit too but otherwise (underLoad):
   * tried once more, alone, once the rest are tried, and only then failed. Gone once tried.
   */
  retry?: { id: string; name: string; message: string }[];
  /** main's commit it tried (its kit\ and tools\kit.ts); none in one a PR's trial kept before Steward 0.36.124. */
  commit?: string;
  /** Carried from another trial (its key): the same kit (`content`) at another commit. */
  from?: string;
  /** The kit an agent gets from it (kitContentOf). Another commit with the same takes this trial's verdict (sameKitTrial). */
  content?: string;
}

/** A kept trial's key for main's commit. */
export const mainKeyOf = (commit: string) => `main@${commit}`;

/** The agents a trial has still to try: pending, and to try once more alone. Pure. */
const leftOf = (t: KitTrial): number => (t.pending?.length ?? 0) + (t.retry?.length ?? 0);

/**
 * A failure that may be this PC's load rather than the kit: a test or its process killed (exit null, `null !== 0` where a
 * test expected its child's exit code), a file or folder still busy (EBUSY), a run stopped at its time limit. Pure.
 */
export const UNDER_LOAD = /\bEBUSY\b|\bexit null\b|\bnull !== -?\d+\b|\bSIG(?:KILL|TERM)\b|\bkilled\b|\btimed out\b|stopped at its time limit/i;

/** Whether a trial's failure is tried once more, alone, before it holds the kit: it looks like load, or failed without the kit too. Pure. */
export const underLoad = (r: EmployeeResult): boolean => r.outcome === 'failed' && (!!r.without || UNDER_LOAD.test(r.message));

const linesOf = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** A trial's words while it goes on: how far it got. Pure. */
const goingWords = (t: KitTrial): string => {
  const left = leftOf(t);
  const total = t.passed + t.failed.length + (t.untouched ?? 0) + (t.own?.length ?? 0) + left;
  const failing = t.failed.length ? `, ${t.failed.length} failing (${t.failed.map((f) => f.name).join(', ')})` : '';
  const again = t.retry?.length ? `, ${t.retry.map((f) => f.name).join(', ')} to try once more, alone` : '';
  return `${TRIAL_GOING}: ${total - left} of ${total} so far${failing}${again}`;
};

/**
 * Each employee tried with the kit in `dir` (the Steward's worktree of main, or a kit PR's clone at its vouch), its
 * worktree and branch removed after, while its repository is still held: a vouch's trial (another process) tries the
 * same agents in the same worktrees, and must find nothing of this one's there, nor have its own removed under it.
 */
async function tryEach(ctx: Ctx, employees: Employee[], kit: string, dir: string, reachFrom?: { repo: string; head: string }): Promise<EmployeeResult[]> {
  // main's own kit changelog, so each trial bump writes the entry its real bump will (its tests read it too).
  const changelogFile = path.join(dir, 'kit', 'CHANGELOG.md');
  const changelog = existsSync(changelogFile) ? readFileSync(changelogFile, 'utf8') : null;
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    const tryIt = async (): Promise<EmployeeResult> => {
      let r: EmployeeResult;
      try {
        r = await bumpOne(ctx, e, {
          kit,
          kitFrom: path.join(dir, 'kit'),
          tool: path.join(dir, 'tools', 'kit.ts'),
          trial: true,
          changelog,
          ...(reachFrom ? { reach: (_e: Employee, pin: { kit: string; parts: string[] | null }, toolChanged: boolean) => kitReach(ctx, { ...reachFrom, pin, toolChanged }) } : {}),
        });
      } catch (err) {
        r = result(e, 'failed', (err as Error).message);
      }
      const repo = checkoutOf(e);
      try {
        if (existsSync(repo)) await removeWorktree(ctx.run, repo, trialDirOf(ctx.settings, e), trialBranch(kit));
        removeProfile(trialProfileOf(trialDirOf(ctx.settings, e)));
      } catch (err) {
        ctx.log(`[${e.id}] couldn't remove its trial: ${(err as Error).message}`);
      }
      return r;
    };
    const r = await withRepo(ctx.log, e.id, tryIt).catch((err: Error) => result(e, 'failed', err.message));
    ctx.log(`[${e.id}] kit ${kit} trial: ${r.outcome}: ${r.message}`);
    return r;
  });
}

/** `use` given the Steward's own worktree of the commit tried (its kit\ and tools\kit.ts), removed after. */
async function withKitTree<T>(ctx: Ctx, steward: Employee, commit: string, use: (dir: string) => Promise<T>): Promise<T> {
  const repo = checkoutOf(steward);
  const dir = kitTrialDirOf(ctx);
  await removeWorktree(ctx.run, repo, dir);
  await freshWorktree(ctx.run, ctx.settings, repo, dir, commit, '--detach');
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

const failuresOf = (results: EmployeeResult[]): KitTrial['failed'] =>
  results.filter((r) => r.outcome === 'failed').map((r) => ({ id: r.id, name: r.name, message: r.message, main: r.base ?? null, ...(r.errors?.length ? { errors: r.errors } : {}) }));

/** The ones that failed without the kit too (bump.ts's withoutTheKit): not the kit's doing. */
const ownFailuresOf = (results: EmployeeResult[]): NonNullable<KitTrial['own']> =>
  results.filter((r) => r.outcome === 'skipped' && r.message.startsWith(WITHOUT_THE_KIT)).map((r) => ({ id: r.id, name: r.name, message: r.message }));

/**
 * Each employee that passed its checks, by id: the commit of its branch it was bumped from (TrialPasses' `mains`). One
 * that ran only the tests the kit reaches (`partial`) is kept too: its rollout's bump would run the same ones. One that
 * passed once its tests were brought up to the kit (`copies`) isn't: its rollout's bump runs its checks, to bring them up again.
 */
const mainsOf = (results: EmployeeResult[]): Record<string, string> => Object.fromEntries(results.filter((r) => r.outcome === 'done' && r.base && !r.copies).map((r) => [r.id, r.base!]));

/** The memory one agent's try may take at its peak: its install, a type check and a test run side by side. */
const TRY_BYTES = 3 * 1024 ** 3;

/**
 * How many agents a trial tries at once: Settings' parallel, or a quarter of this PC's processors up to 4, whichever is
 * more; never more than the memory free now holds at TRY_BYTES each, above the room the manor always leaves (the kit's
 * PACE_CEILING), and at least one. Pure.
 */
export const trialParallel = (parallel: number, cpus = os.availableParallelism(), free = os.freemem(), total = os.totalmem()): number =>
  Math.max(1, Math.min(Math.max(parallel, Math.min(4, Math.floor(cpus / 4))), Math.floor((free - (1 - PACE_CEILING) * total) / TRY_BYTES)));

/** Why a trial starts no try now, while more than the manor's ceiling of this PC's memory is in use: the next round goes on. */
export const TRIAL_NO_ROOM = `${TRIAL_GOING}, and waits for room: more than ${CEILING_WORDS} of this PC's memory is in use, and no agent's try starts above that`;

/**
 * The trial's pending agents tried trialParallel at a time, each only as far as the kit changes it, the next one started
 * as soon as one ends, until none are left or `sliceMs` has passed (those in flight finish); `save` after each. A try the network cut short leaves its agent to try again,
 * and says so (no more are started). One that fails as under load (underLoad) goes to `retry`; once none are pending,
 * those are tried once more, one at a time with nothing of the trial beside them, and what they give then stands. No
 * try starts while more than the manor's ceiling of the PC's memory is in use (TRIAL_NO_ROOM, said as a cut short is).
 */
async function tryAll(ctx: Ctx, steward: Employee, commit: string, t: KitTrial, sliceMs: number, save: () => void, retired: ReadonlySet<string>): Promise<string | null> {
  const repo = checkoutOf(steward);
  return timed(phaseOf(ctx), 'trial', `kit ${t.kit}`, () => withKitTree(ctx, steward, commit, async (dir) => {
    let cut: string | null = null;
    const queue = [...(t.pending ?? [])];
    const t0 = Date.now();
    // The first of each slice always starts, so every round gets on with it, unless the PC has no room for it.
    let started = 0;
    const inUse = ctx.memoryInUse ?? (process.env.NODE_TEST_CONTEXT ? () => 0 : memoryInUse);
    const goes = () => {
      if (cut || (started && Date.now() - t0 >= sliceMs)) return false;
      if (inUse() <= PACE_CEILING) return true;
      cut = TRIAL_NO_ROOM;
      return false;
    };
    const tryOne = async (id: string, again: boolean): Promise<void> => {
      started++;
      const e = ctx.settings.employees.find((x) => x.id === id);
      const results = e && e.usesKit && !retired.has(e.id) && existsSync(checkoutOf(e)) ? await tryEach(ctx, [e], t.kit, dir, { repo, head: commit }) : [];
      const counted: EmployeeResult[] = [];
      for (const r of results) {
        if (r.outcome === 'failed' && (await networkFailure(ctx, r.message))) cut ??= `its kit's trial on ${r.name} was cut short by the network: the next round tries again`;
        else counted.push(r);
      }
      // Cut short: still to try. Tried, or gone from the staff (or retired) meanwhile: no longer.
      if (results.length && !counted.length) return;
      if (again) t.retry = (t.retry ?? []).filter((x) => x.id !== id);
      else t.pending = (t.pending ?? []).filter((x) => x !== id);
      const retry = again ? [] : counted.filter(underLoad);
      for (const r of retry) ctx.log(`[${r.id}] kit ${t.kit} trial: it didn't pass, which may be this PC's load, not the kit's: tried once more, alone, once the rest are tried`);
      if (retry.length) t.retry = [...(t.retry ?? []), ...retry.map((r) => ({ id: r.id, name: r.name, message: r.message }))];
      const settled = counted.filter((r) => !retry.includes(r)).map((r) => (again && r.outcome === 'failed' ? { ...r, message: `${r.message}; tried once more, alone, after the rest: it failed again` } : r));
      t.failed = [...t.failed, ...failuresOf(settled)];
      t.passed += settled.filter((r) => r.outcome === 'done').length;
      t.untouched = (t.untouched ?? 0) + settled.filter((r) => r.outcome === 'skipped' && r.message.includes(': not tried, ')).length;
      const own = ownFailuresOf(settled);
      if (own.length) t.own = [...(t.own ?? []), ...own];
      t.mains = { ...t.mains, ...mainsOf(settled) };
      save();
    };
    const next = async (): Promise<void> => {
      while (queue.length && goes()) await tryOne(queue.shift()!, false);
    };
    await Promise.all(Array.from({ length: trialParallel(ctx.settings.parallel) }, next));
    // A quieter time: the rest tried, the ones that failed as under load are tried again, one at a time.
    if (!t.pending?.length) {
      const again = (t.retry ?? []).map((f) => f.id);
      while (again.length && goes()) await tryOne(again.shift()!, true);
    }
    return cut;
  }));
}

/** What a trial at this commit fills the agents with: the git tree of its kit\, and the blob of its tools/kit.ts (null for none). */
async function triedAt(ctx: Ctx, repo: string, head: string): Promise<{ tree?: string; tool?: string | null }> {
  const tree = (await gitMaybe(ctx.run, repo, 'rev-parse', `${head}:kit`))?.trim();
  if (!tree) return {};
  const tool = await showFile(ctx.run, repo, head, 'tools/kit.ts');
  return { tree, tool: tool === null ? null : blobOf(tool) };
}

/**
 * The kit an agent gets from `commit`, as one key: the git tree of each of the kit's parts (kit\node, web, spec, react:
 * what a release carries) and the blob of tools/kit.ts, "-" for one that isn't there. kit/VERSION, the kit's changelog
 * and its own tests (kit\test, which no agent gets) aren't in it, so a version given anew keeps the key. Null when git
 * can't say, or there's no kit\.
 */
export async function kitContentOf(ctx: Ctx, repo: string, commit: string): Promise<string | null> {
  const out = await gitMaybe(ctx.run, repo, 'ls-tree', commit, 'kit/', TOOL);
  if (out === null) return null;
  const ids = new Map(linesOf(out).flatMap((l): [string, string][] => {
    const m = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(l);
    return m ? [[m[2], m[1]]] : [];
  }));
  if (![...ids.keys()].some((f) => f.startsWith('kit/'))) return null;
  return [...PARTS.map((p) => `${p}:${ids.get(`kit/${p}`) ?? '-'}`), `tool:${ids.get(TOOL) ?? '-'}`].join(' ');
}

/**
 * The trial kept under another key whose kit is `content` (kitContentOf): the same kit an agent gets, whichever commit
 * (or, before Steward 0.36.124, PR) it was tried at. A done one, newest first, else one still going. Pure.
 */
export function sameKitTrial(kept: Record<string, KitTrial>, content: string, except: string): [string, KitTrial] | undefined {
  const same = Object.entries(kept).filter(([k, t]) => k !== except && t.content === content).reverse();
  return same.find(([, t]) => !leftOf(t)) ?? same[0];
}

/**
 * The employees a kept trial failed whose branch on origin has moved since (fixed on their side): they are tried again.
 * One kept before their commits were (no `main`) counts as moved, once. One that can't be fetched now waits. Every one,
 * when another Steward tried them (`steward`): its way of trying may have been why.
 */
async function movedOn(ctx: Ctx, t: KitTrial): Promise<Employee[]> {
  const moved: Employee[] = [];
  const another = t.steward !== APP.version;
  for (const f of t.failed) {
    const e = ctx.settings.employees.find((x) => x.id === f.id);
    if (!e || !e.usesKit || !existsSync(checkoutOf(e))) continue;
    if (another) {
      moved.push(e);
      continue;
    }
    if (f.main === null) continue;
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

/** The agents a kit's trial tries: those on the kit that Manor hasn't retired, with a clone here. */
const trialStaff = (ctx: Ctx, retired: ReadonlySet<string>): Employee[] => ctx.settings.employees.filter((e) => e.usesKit && !retired.has(e.id) && existsSync(checkoutOf(e)));

/** What a kit PR's trial at its vouch came to (kitTrialOfClone). */
export interface CloneTrial {
  kit: string;
  /** How many agents it was to try: every one main's trial would. */
  staff: number;
  passed: number;
  /** Each agent whose checks failed with the kit, what failed (the tests by name), and the first lines that say why. */
  failed: KitTrial['failed'];
  /** The ones that failed without the kit too: not the kit's doing. */
  own: NonNullable<KitTrial['own']>;
  /** Why it stopped short (the network cut a try short): no verdict on the kit. */
  cut: string | null;
}

/**
 * A kit PR's trial at its vouch (vouch.ts, Steward 0.36.240): the kit in the PR's clone at `dir`, at its head (its kit\
 * and tools/kit.ts; `kit` its kit/VERSION), tried on every agent main's trial would try (trialStaff), as main's trial
 * tries them (tryEach: a worktree and branch of each agent's own, only the tests the kit reaches, in a scratch profile,
 * nothing committed or pushed), but one at a time: a person waits on a vouch, on a PC they're working at. One that fails
 * as under load (underLoad) is tried once more, alone, after the rest, as main's trial does. A try the network cut
 * short stops it (`cut`). `say` hears each agent's turn and what it came to.
 */
export async function kitTrialOfClone(ctx: Ctx, at: { dir: string; head: string; kit: string }, say: (line: string) => void): Promise<CloneTrial> {
  const staff = trialStaff(ctx, retiredOf(ctx));
  const t: CloneTrial = { kit: at.kit, staff: staff.length, passed: 0, failed: [], own: [], cut: null };
  const retry: Employee[] = [];
  const tryOne = async (e: Employee, again: boolean): Promise<void> => {
    const [r] = await tryEach(ctx, [e], at.kit, at.dir, { repo: at.dir, head: at.head });
    if (r.outcome === 'failed' && (await networkFailure(ctx, r.message))) {
      t.cut = `kit ${at.kit}'s trial on ${r.name} was cut short by the network (${r.message.split('\n')[0].slice(0, 200)})`;
      return;
    }
    if (!again && underLoad(r)) {
      say(`${r.name}: its failure may be this PC's load, not the kit's: tried once more, alone, after the rest (${r.message.split('\n')[0].slice(0, 200)})`);
      retry.push(e);
      return;
    }
    const settled = again && r.outcome === 'failed' ? { ...r, message: `${r.message}; tried once more, alone, after the rest: it failed again` } : r;
    say(`${r.name}: ${settled.outcome === 'done' ? 'passed' : settled.outcome}: ${settled.message}`);
    t.failed.push(...failuresOf([settled]));
    t.passed += settled.outcome === 'done' ? 1 : 0;
    t.own.push(...ownFailuresOf([settled]));
  };
  for (const [i, e] of staff.entries()) {
    say(`kit ${at.kit} tried on ${e.name} (${i + 1} of ${staff.length})`);
    await tryOne(e, false);
    if (t.cut) return t;
  }
  for (const e of retry) {
    say(`kit ${at.kit} tried on ${e.name} once more, alone`);
    await tryOne(e, true);
    if (t.cut) return t;
  }
  return t;
}

/** What a kit's trial at main came to: passed, failing agents (the kit waits), or still going (the build waits for it). */
export type MainTrial = { state: 'passed'; t: KitTrial } | { state: 'failed'; t: KitTrial; why: string } | { state: 'going'; why: string };

/** The words of a kit that fails agents. Pure. */
export const failsWords = (t: KitTrial): string =>
  `kit ${t.kit} fails ${t.failed.length} agent${t.failed.length === 1 ? "'s" : "s'"} checks here (${t.failed.map((f) => f.name).join(', ')}), so it isn't released: fix the kit on main, or the agents on theirs`;

/**
 * Main's kit (kit/VERSION `kit` at `commit` of the Steward's clone, `steward` as an employee) tried on every agent, as
 * the module's comment says: the verdict kept for that commit, or for the same kit at another (sameKitTrial), its failed
 * agents whose main moved tried again; else every agent tried, a slice of it now (TRIAL_SLICE_MS). Saved after each agent.
 */
export async function kitTrialAtMain(ctx: Ctx, steward: Employee, at: { commit: string; kit: string }, sliceMs = TRIAL_SLICE_MS): Promise<MainTrial> {
  const repo = checkoutOf(steward);
  const sha = at.commit.slice(0, 7);
  const kept = readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
  const retired = retiredOf(ctx);
  let key = mainKeyOf(at.commit);
  let t = kept[key];
  // Tried just now: no branch has moved since.
  let fresh = false;
  if (!t) {
    const tried = await triedAt(ctx, repo, at.commit);
    const content = await kitContentOf(ctx, repo, at.commit);
    const same = content ? sameKitTrial(kept, content, key) : undefined;
    if (same && leftOf(same[1])) {
      key = same[0];
      t = same[1];
    } else if (same) {
      const [k, s] = same;
      ctx.log(`[${APP.id}] kit ${at.kit} at ${sha} is the kit ${k} tried (kit ${s.kit}), but for versions and changelogs: not tried again`);
      t = { kit: at.kit, failed: s.failed, passed: s.passed, at: s.at, ...tried, mains: { ...s.mains }, ...(s.untouched ? { untouched: s.untouched } : {}), ...(s.own?.length ? { own: s.own } : {}), steward: s.steward, commit: at.commit, content: content!, from: k };
    } else {
      const employees = trialStaff(ctx, retired);
      ctx.log(`[${APP.id}] kit ${at.kit} on main (${sha}) has no release: trying it on ${employees.length} agents before it is released, ${trialParallel(ctx.settings.parallel)} at a time`);
      t = { kit: at.kit, failed: [], passed: 0, at: new Date().toISOString(), ...tried, mains: {}, pending: employees.map((e) => e.id), steward: APP.version, commit: at.commit, ...(content ? { content } : {}) };
    }
  }
  const trial = t;
  // Written over the file as it is now: the oldest go once there are more than 100.
  const save = () => {
    const all = readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
    all[key] = trial;
    writeJson(kitTrialsFile(), Object.fromEntries(Object.entries(all).slice(-100)));
  };
  if (leftOf(trial)) {
    // Refused (no kit.json on its main, say) isn't the kit's doing, and isn't held against it; one the network cut short
    // is no verdict on the kit, and is tried again.
    const cut = await tryAll(ctx, steward, at.commit, trial, sliceMs, save, retired);
    if (cut || leftOf(trial)) return { state: 'going', why: cut ?? goingWords(trial) };
    fresh = true;
    delete trial.pending;
    delete trial.retry;
    // Tried side by side, they ended in any order: named in the staff's.
    const order = (id: string) => ctx.settings.employees.findIndex((e) => e.id === id) >>> 0;
    trial.failed = [...trial.failed].sort((a, b) => order(a.id) - order(b.id));
    trial.at = new Date().toISOString();
    ctx.log(`[${APP.id}] kit ${trial.kit} tried on every agent: ${trial.passed} passed, ${trial.failed.length} failed, ${trial.own?.length ?? 0} failed without it too (not held against it), ${trial.untouched ?? 0} not tried (nothing they take from the kit changes)`);
  }
  // Retired since it failed (retired.ts): it gets no kit, so its failure no longer holds it.
  const gone = trial.failed.filter((f) => retired.has(f.id));
  if (gone.length) {
    ctx.log(`[${APP.id}] ${gone.map((f) => f.name).join(', ')} didn't pass kit ${trial.kit}'s checks, and Manor has retired ${gone.length === 1 ? 'it' : 'them'} since: no longer held against the kit`);
    trial.failed = trial.failed.filter((f) => !retired.has(f.id));
  }
  if (!fresh && trial.failed.length) {
    // Fixed on the agents' side: each whose branch moved since is tried again with the same kit.
    const moved = await movedOn(ctx, trial);
    if (moved.length) {
      const one = moved.length === 1;
      const why = trial.steward === APP.version ? `${one ? 'has' : 'have'} changed since kit ${trial.kit} didn't pass ${one ? 'its' : 'their'} checks there` : `didn't pass kit ${trial.kit}'s checks as Steward ${trial.steward ?? 'before 0.35.73'} tried them`;
      ctx.log(`[${APP.id}] ${moved.map((e) => e.name).join(', ')} ${why}: trying ${one ? 'it' : 'them'} again`);
      const results = await withKitTree(ctx, steward, at.commit, (dir) => tryEach(ctx, moved, trial.kit, dir, { repo, head: at.commit }));
      // Cut short by the network: the kept verdict stands, and the next build tries them again (their main still moved).
      for (const r of results) if (r.outcome === 'failed' && (await networkFailure(ctx, r.message))) return { state: 'going', why: `its kit's trial on ${r.name} was cut short by the network: the next round tries again` };
      const ids = new Set(moved.map((e) => e.id));
      trial.failed = [...trial.failed.filter((f) => !ids.has(f.id)), ...failuresOf(results)];
      trial.passed += results.filter((r) => r.outcome === 'done').length;
      trial.mains = { ...Object.fromEntries(Object.entries(trial.mains ?? {}).filter(([id]) => !ids.has(id))), ...mainsOf(results) };
      const own = [...(trial.own ?? []).filter((f) => !ids.has(f.id)), ...ownFailuresOf(results)];
      if (own.length) trial.own = own;
      else delete trial.own;
      trial.steward = APP.version;
      trial.at = new Date().toISOString();
    }
  }
  save();
  if (!trial.failed.length) return { state: 'passed', t: trial };
  const why = failsWords(trial);
  ctx.log(`[${APP.id}] ${why}`);
  return { state: 'failed', t: trial, why };
}

/**
 * The kit main's latest trial holds (kit-trials.json): the newest trial of a main commit, done, failing agents, of a kit
 * not released since (`released`, the kit's releases). Null when none does. Pure.
 */
export function heldKit(kept: Record<string, KitTrial>, released: string[]): KitTrial | null {
  const mains = Object.entries(kept)
    .filter(([k]) => k.startsWith('main@'))
    .map(([, t]) => t)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const t = mains[0];
  return t && !leftOf(t) && t.failed.length && !released.includes(t.kit) ? t : null;
}
