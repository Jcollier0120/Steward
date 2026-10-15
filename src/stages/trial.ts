import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf, fetchBranch, fetchFor, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { compareVersions, KIT_VERSION } from '../kitfiles.ts';
import { TOOL } from '../kitsource.ts';
import { readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { bumpOne, checksLogOf, runChecks, trialBranch, trialDirOf, WITHOUT_THE_KIT } from './bump.ts';
import { mergeChangelogs, resolveVersionConflicts, sameButVersions } from './catchup.ts';
import { checkoutOf, glanceOf, mapLimit, networkFailure, result, freshWorktree, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { isKitChangelog, isKitVersionFile, KIT_VERSION_FILE, kitVersionText } from './kitpart.ts';
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
 * What is tried is the PR's kit\ and tools\kit.ts, so a new head that changes neither but for versions and changelogs
 * (the PR caught up with its branch: kit/VERSION, the kit's changelog, a version line) keeps the trial's verdict, at the
 * kit's new version, tried again only for its agents whose branch moved (carriedFrom), as a vouch is carried across such
 * a catch-up (catchup.ts). On 2026-10-14 every catch-up of a kit PR started its 34 agents over. And each agent that
 * passes is kept with the commit it was bumped from: its rollout bump from that same commit, once the kit is released as
 * tried, isn't checked a second time (trialpass.ts).
 *
 * Kit PRs queued one behind another are tried together (combineKits): the first's trial tries the branch with it and
 * each queued after it merged in, in the order they merge, once; passing, each merges in its turn, its kit the one tried
 * but for versions and the files of those still to merge after it (coveredBy). Failing an agent, it holds no one: the
 * first is tried alone, as before, and its failures are its own. On 2026-10-14 eight kit PRs waited for one trial each,
 * one after the other, behind #241's.
 *
 * An agent that fails the way a PC under load fails (a test killed, EBUSY: underLoad), or fails without the kit too, but
 * otherwise, isn't held against the kit at once: it is tried once more, alone, once the trial's other agents are tried
 * (KitTrial's `retry`), and holds the PR only if it fails then too. #241's trial failed Manor (its tests killed, exit
 * null) and the Assayer (EBUSY on a folder it removes) twice, four agents at a time, and held eight PRs for hours.
 *
 * In slices, so the round isn't held for the whole trial: each round tries a few agents (Settings' parallel at a time)
 * for at most TRIAL_SLICE_MS, keeps what it found (KitTrial's `pending`: the ones still to try), and goes on with the
 * rest of its work; the PR waits meanwhile (TRIAL_GOING, a brief wait: the next round comes sooner). And each agent is
 * tried only as far as the kit changes it (kitreach.ts): one none of whose kit files change isn't tried at all, and one
 * whose files change runs only the tests they reach. Its rollout's bump runs the same ones (0.35.68).
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
   * (null when that isn't known; missing in one kept before Steward 0.27.14), and the first distinct lines its failed
   * step printed that say what went wrong (none named, or one kept before Steward 0.36.54: none).
   */
  failed: { id: string; name: string; message: string; main?: string | null; errors?: string[] }[];
  /** How many were tried, and passed. */
  passed: number;
  /** The employees (by id) still to try, while the trial goes on over several rounds; gone once all are tried. */
  pending?: string[];
  /** How many weren't tried: nothing they take from the kit changes (kitreach.ts). */
  untouched?: number;
  /**
   * The employees that failed with the kit and without it alike (bump.ts's withoutTheKit): not the kit's doing, so not
   * held against it. Their own failure is theirs (or this PC's) to fix; their rollout bump will say so in its turn.
   */
  own?: { id: string; name: string; message: string }[];
  /**
   * The Steward that tried it (APP.version). Failures one older than this one kept are tried again, once: the Steward's
   * own way of trying may have been why (Steward 0.35.73's fixes for a work folder on a Dev Drive).
   */
  steward?: string;
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
  /**
   * The agents whose checks failed the way a PC under load fails them, or without the kit too but otherwise (underLoad):
   * tried once more, alone, once the rest are tried, and only then failed. Gone once tried.
   */
  retry?: { id: string; name: string; message: string }[];
  /**
   * Kit PRs tried together (combineKits), in the order they merge, the first the one whose turn it was: kept as
   * "kits:<PR>@<head>+…", its kit the branch at `base` with each merged in, in turn, at `commit` (in the Steward's clone
   * only).
   */
  members?: KitMember[];
  commit?: string;
  base?: string;
  /** Carried from another trial (its key): this PR's at another head, or the kit PRs tried together with it. */
  from?: string;
}

/** A kit PR tried together with others (KitTrial's `members`). */
export interface KitMember {
  number: number;
  /** The head it was merged in at, and its kit/VERSION there. */
  head: string;
  kit: string;
  /** The kit's files it changes since it left the branch: kit\… and tools/kit.ts, as git names them. */
  files: string[];
}

/** How the key of kit PRs tried together begins. */
export const TOGETHER = 'kits:';
const togetherKeyOf = (members: { number: number; head: string }[]) => `${TOGETHER}${members.map((m) => `${m.number}@${m.head}`).join('+')}`;

/** Where the kit PRs tried together are merged into one kit, and the ref that keeps that commit while it is tried. */
const togetherDirOf = (ctx: Ctx) => path.join(workRootOf(ctx.settings), `_${APP.id}-kit-together`);
const TOGETHER_REF = `refs/${APP.id}/kit-together`;

/** The agents a trial has still to try: pending, and to try once more alone. Pure. */
const leftOf = (t: KitTrial): number => (t.pending?.length ?? 0) + (t.retry?.length ?? 0);

/**
 * A failure that may be this PC's load rather than the kit: a test or its process killed (exit null, `null !== 0` where a
 * test expected its child's exit code), a file or folder still busy (EBUSY), a run stopped at its time limit. Pure.
 */
export const UNDER_LOAD = /\bEBUSY\b|\bexit null\b|\bnull !== -?\d+\b|\bSIG(?:KILL|TERM)\b|\bkilled\b|\btimed out\b|stopped at its time limit/i;

/** Whether a trial's failure is tried once more, alone, before it holds the PR: it looks like load, or failed without the kit too. Pure. */
export const underLoad = (r: EmployeeResult): boolean => r.outcome === 'failed' && (!!r.without || UNDER_LOAD.test(r.message));

const linesOf = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

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
  const left = leftOf(t);
  const total = t.passed + t.failed.length + (t.untouched ?? 0) + (t.own?.length ?? 0) + left;
  const failing = t.failed.length ? `, ${t.failed.length} failing (${t.failed.map((f) => f.name).join(', ')})` : '';
  const again = t.retry?.length ? `, ${t.retry.map((f) => f.name).join(', ')} to try once more, alone` : '';
  const together = t.members ? `, together with ${t.members.slice(1).map((m) => `#${m.number}`).join(', ')}` : '';
  return `${TRIAL_GOING}${together}: ${total - left} of ${total} so far${failing}${again}; the rounds go on meanwhile`;
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

/**
 * A kit PR whose trial at its head is still going (agents still to try, or to try once more): its own, or one of kit PRs
 * tried together that has it in at this head. Caught up now, its trial would start again.
 */
export function trialGoingAt(pr: PrInfo, kept?: Record<string, KitTrial>): boolean {
  if (!raisesKit(pr)) return false;
  const all = kept ?? readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
  const own = all[keyOf(pr)];
  if (own && leftOf(own) > 0) return true;
  return togetherWith(all, pr).some(([, c]) => leftOf(c) > 0 && c.members!.some((m) => m.number === pr.number && m.head === pr.headOid));
}

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

/**
 * The Steward's kit PRs whose trial at their head is done and fails agents (its comment on the PR left), not labelled
 * KIT_BREAKS_LABEL: each gives up its turn in the version queue, as a conflict handed on does (merge.ts givesWay), so
 * the PRs above it merge meanwhile; once it passes, its catch-up gives it versions above theirs, and keeps its trial.
 * Steward#214 (kit 2.69.0) held twelve PRs for hours on 2026-10-13, most of them the very fixes for why it failed.
 */
export function trialGivesWay(e: Employee, prs: PrInfo[], kept = readJson<Record<string, KitTrial>>(kitTrialsFile(), {})): Set<number> {
  if (e.id !== APP.id) return new Set();
  const fails = (pr: PrInfo) => {
    const t = kept[keyOf(pr)];
    return !!t && !leftOf(t) && !!t.commented && standingFailures(t).length > 0;
  };
  return new Set(prs.filter((pr) => raisesKit(pr) && !pr.draft && !!pr.headOid && !pr.labels.includes(KIT_BREAKS_LABEL) && fails(pr)).map((pr) => pr.number));
}

/** The comment on the PR: the employees the kit breaks, and what to do. Pure. */
export function trialComment(t: KitTrial, sha: string): string {
  const standing = standingFailures(t);
  // What its failed step said went wrong, under each: the reason is on the PR, without the log on the Steward's PC.
  const said = (f: KitTrial['failed'][number]) => (f.errors?.length ? ['', `  It printed${f.errors.length > 1 ? ', first' : ''}:`, '', '  ```text', ...f.errors.map((l) => `  ${l.replace(/```/g, "'''")}`), '  ```'] : []);
  const lines = standing.flatMap((f) => [`- **${f.name}**: ${f.message.replace(/\r?\n/g, ' ')}${pairNote(t, f.id)}`, ...said(f)]);
  const moves = pairWords(t);
  return [
    `The Steward tried kit ${t.kit}, as this PR has it at ${sha}, on every agent before releasing it: ${standing.length} of ${t.failed.length + t.passed} fail their checks with it.`,
    '',
    ...lines,
    ...(moves ? ['', `Not waited for: ${moves}.`] : []),
    ...(t.own?.length ? ['', `Not held against it: ${t.own.map((f) => f.name).join(', ')} ${t.own.length === 1 ? 'fails' : 'fail'} the same checks without it, on main as it is.`] : []),
    '',
    `Each was bumped as the rollout will bump it once the kit is released: its main, kit.json pinned to ${t.kit}, its kit filled from this PR's kit\\ and tools\\kit.ts, then its own checks, twice.`,
    '',
    `**What to do:** change the kit so they pass as they are (a new push here is tried again), or fix the agents (once an agent's main moves, the next round tries it again), or open a ready PR to the agent that pins kit ${t.kit} and passes with it (the next round tries it, and the kit then merges with it), or, when the agents must change later, add the label \`${KIT_BREAKS_LABEL}\` and say what each must do in the kit's changelog entry. The PR then merges, and each failed bump goes to the Wright.`,
    '',
    `Meanwhile the Steward doesn't wait on you alone: each agent above goes to the Wright as an issue in its own repository, for a ready PR that pins kit ${t.kit} and passes with it; and should the branch change the kit since this PR left it, this PR is caught up and its kit tried again.`,
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

/** `use` given the Steward's own worktree of the commit tried (the PR's head: its kit\ and tools\kit.ts), removed after. */
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

/** `employees` tried with the kit at the PR's head, from the Steward's own worktree of it, removed after. */
const tryAtHead = (ctx: Ctx, steward: Employee, pr: PrInfo, kit: string, employees: Employee[]): Promise<EmployeeResult[]> =>
  withKitTree(ctx, steward, pr.headOid, (dir) => tryEach(ctx, employees, kit, dir, { repo: checkoutOf(steward), head: pr.headOid }));

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
  rmSync(checksLogOf(dir), { force: true });
  await fetchFor(run, repo, p.headOid, `refs/pull/${p.number}/head`);
  await freshWorktree(run, ctx.settings, repo, dir, p.headOid, '--detach');
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
    const tried = await withKitTree(ctx, steward, pr.headOid, (dir) =>
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
  results.filter((r) => r.outcome === 'failed').map((r) => ({ id: r.id, name: r.name, message: r.message, main: r.base ?? null, ...(r.errors?.length ? { errors: r.errors } : {}) }));

/** The ones that failed without the kit too (bump.ts's withoutTheKit): not the kit's doing. */
const ownFailuresOf = (results: EmployeeResult[]): NonNullable<KitTrial['own']> =>
  results.filter((r) => r.outcome === 'skipped' && r.message.startsWith(WITHOUT_THE_KIT)).map((r) => ({ id: r.id, name: r.name, message: r.message }));

/**
 * Each employee that passed its checks, by id: the commit of its branch it was bumped from (TrialPasses' `mains`). One
 * that ran only the tests the kit reaches (`partial`) is kept too: its rollout's bump would run the same ones (0.35.68).
 */
const mainsOf = (results: EmployeeResult[]): Record<string, string> => Object.fromEntries(results.filter((r) => r.outcome === 'done' && r.base).map((r) => [r.id, r.base!]));

/** The memory one agent's try may take at its peak: its install, a type check and a test run side by side. */
const TRY_BYTES = 3 * 1024 ** 3;

/**
 * How many agents a trial tries at once: Settings' parallel, or a quarter of this PC's processors up to 4, whichever is
 * more; never more than the memory free now holds at TRY_BYTES each (at least one). A try is an agent's install, its kit
 * filled and the tests the kit reaches, most of it waiting on its own processes: kit 2.62.0's 34 tries took 21 s each on
 * average, and two at a time left the trial waiting on itself. Their commands run at the kit's checks pace (Steward
 * 0.36.8), in one job for the PC with one processor cap: more tries at once share that cap rather than adding to it, so
 * the processor is held to it whatever this says, and memory stays the limit. Pure.
 */
export const trialParallel = (parallel: number, cpus = os.availableParallelism(), free = os.freemem()): number =>
  Math.max(1, Math.min(Math.max(parallel, Math.min(4, Math.floor(cpus / 4))), Math.floor(free / TRY_BYTES)));

/** What a trial tries: its key in kit-trials.json, the PR whose hold it is, and the commit whose kit\ and tools\kit.ts fill the agents. */
interface TrialAt {
  key: string;
  pr: PrInfo;
  commit: string;
}

/**
 * A slice of a trial (KitTrial's `pending`): its agents tried trialParallel at a time, each only as far as the kit
 * changes it, the next one started as soon as one ends, until none are left or `sliceMs` has passed (those in flight
 * finish); `save` after each. A try the network cut short leaves its agent to try again, and says so (no more are
 * started). One that fails as under load (underLoad) goes to `retry`; once none are pending, those are tried once more,
 * one at a time with nothing of the trial beside them, and what they give then stands.
 */
async function trySlice(ctx: Ctx, steward: Employee, at: TrialAt, t: KitTrial, sliceMs: number, save: () => void): Promise<string | null> {
  const repo = checkoutOf(steward);
  if (at.commit === at.pr.headOid) await fetchFor(ctx.run, repo, at.pr.headOid, `refs/pull/${at.pr.number}/head`);
  const t0 = Date.now();
  return withKitTree(ctx, steward, at.commit, async (dir) => {
    let cut: string | null = null;
    const queue = [...(t.pending ?? [])];
    // The first of each slice always starts, so every round gets on with it.
    let started = 0;
    const goes = () => !cut && (!started || Date.now() - t0 < sliceMs);
    const tryOne = async (id: string, again: boolean): Promise<void> => {
      started++;
      const e = ctx.settings.employees.find((x) => x.id === id);
      const results = e && e.usesKit && existsSync(checkoutOf(e)) ? await tryEach(ctx, [e], t.kit, dir, { repo, head: at.commit }) : [];
      const counted: EmployeeResult[] = [];
      for (const r of results) {
        if (r.outcome === 'failed' && (await networkFailure(ctx, r.message))) cut ??= `its kit's trial on ${r.name} was cut short by the network: the next round tries again`;
        else counted.push(r);
      }
      // Cut short: still to try. Tried, or gone from the staff meanwhile: no longer.
      if (results.length && !counted.length) return;
      if (again) t.retry = (t.retry ?? []).filter((x) => x.id !== id);
      else t.pending = (t.pending ?? []).filter((x) => x !== id);
      const retry = again ? [] : counted.filter(underLoad);
      for (const r of retry) ctx.log(`[${r.id}] kit ${t.kit} trial: its failure may be this PC's load, not the kit's: tried once more, alone, once the rest are tried`);
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
 * One kept before their commits were (no `main`) counts as moved, once. One that can't be fetched now waits. Every one,
 * when another Steward tried them (`steward`, missing before 0.35.73): its way of trying may have been why, as an older
 * one's was on a work folder moved to a Dev Drive (2026-10-13).
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

const sameFailures = (a: KitTrial['failed'], b: KitTrial['failed']) => a.length === b.length && a.every((f) => b.some((g) => g.id === f.id && g.message === f.message));

/** A kit as a trial fills the agents with it: the git tree of its kit\, and the blob of its tools/kit.ts (null for none). */
type KitAt = { tree: string; tool?: string | null };

/**
 * Where kit `b` differs from kit `a`, versions and changelogs aside (kit/VERSION, any CHANGELOG.md, a file whose lines
 * differ only in the versions in them): nowhere, or only in `allowed` (kit\… paths and tools/kit.ts, as git names them),
 * when `later` says so; null when it differs in more, or git can't tell.
 */
async function kitDiffers(ctx: Ctx, repo: string, a: KitAt, b: KitAt, allowed: Set<string> = new Set()): Promise<{ later: boolean } | null> {
  const { run } = ctx;
  const same = (x: string | null, y: string | null) => x !== null && y !== null && sameButVersions(x.split(/\r?\n/), y.split(/\r?\n/));
  let later = false;
  if (a.tree !== b.tree) {
    const names = await gitMaybe(run, repo, 'diff', '--name-only', '--no-renames', a.tree, b.tree);
    if (names === null) return null;
    for (const f of linesOf(names)) {
      if (f === 'VERSION' || /(^|\/)changelog\.md$/i.test(f)) continue;
      if (allowed.has(`kit/${f}`)) {
        later = true;
        continue;
      }
      if (!same(await showFile(run, repo, a.tree, f), await showFile(run, repo, b.tree, f))) return null;
    }
  }
  if ((a.tool ?? null) !== (b.tool ?? null)) {
    const read = (blob: string | null | undefined) => (blob ? gitMaybe(run, repo, 'cat-file', '-p', blob) : Promise.resolve(null));
    if (allowed.has(TOOL)) later = true;
    else if (!same(await read(a.tool), await read(b.tool))) return null;
  }
  return { later };
}

/**
 * The trial kept at an earlier head of this PR (the latest few) whose kit is this head's, but for versions and
 * changelogs (kitDiffers): what a catch-up changes. Its verdict stands at this head, as a vouch is carried (catchup.ts).
 */
async function carriedFrom(ctx: Ctx, repo: string, pr: PrInfo, tried: { tree?: string; tool?: string | null }, kept: Record<string, KitTrial>): Promise<[string, KitTrial] | undefined> {
  if (!tried.tree) return undefined;
  const now = { tree: tried.tree, tool: tried.tool ?? null };
  const earlier = Object.entries(kept)
    .filter(([k, x]) => k.startsWith(`${pr.number}@`) && k !== keyOf(pr) && !!x.tree)
    .reverse()
    .slice(0, 3);
  for (const [k, x] of earlier) if (await kitDiffers(ctx, repo, { tree: x.tree!, tool: x.tool ?? null }, now)) return [k, x];
  return undefined;
}

/**
 * The kit PRs queued after `pr` that are tried with it (combineKits), from `line` (merge.ts's kit queue, in the order
 * they merge): each from the repository itself, ready, raising the kit and not labelled KIT_BREAKS_LABEL, up to the
 * first that isn't. Pure.
 */
export function triedWith(pr: PrInfo, line: PrInfo[]): PrInfo[] {
  const at = line.findIndex((p) => p.number === pr.number);
  if (at < 0) return [];
  const out: PrInfo[] = [];
  for (const p of line.slice(at + 1)) {
    if (p.draft || p.fork || !p.headOid || !raisesKit(p) || p.labels.includes(KIT_BREAKS_LABEL) || p.base !== pr.base) break;
    out.push(p);
  }
  return out;
}

const inKit = (f: string) => f.startsWith('kit/') || f === TOOL;

/**
 * A kit PR merged into the worktree `dir` (combineKits), its conflicts settled where only versions differ or the trial
 * doesn't look: kit/VERSION the higher, the kit's changelog with both sides' entries (else the PR's), a kit file as
 * catchup.ts settles a version file, and anything outside the kit (the Steward's own versions, changelog and code: the
 * trial fills the agents from kit\ and tools/kit.ts alone) as the PR has it. False, the merge undone, where the kit
 * conflicts beyond that.
 */
async function mergeInto(ctx: Ctx, dir: string, p: PrInfo, kit: string): Promise<boolean> {
  const { run } = ctx;
  const m = await run('git', ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', '-m', `Kit trial: #${p.number} merged in`, p.headOid], { cwd: dir, timeoutMs: 5 * 60_000 });
  if (m.code === 0) return true;
  const undo = async () => {
    await gitMaybe(run, dir, 'merge', '--abort');
    return false;
  };
  const conflicted = linesOf((await gitMaybe(run, dir, 'diff', '--name-only', '--diff-filter=U')) ?? '');
  if (!conflicted.length) return undo();
  for (const f of conflicted) {
    const side = (n: 1 | 2 | 3) => gitMaybe(run, dir, 'show', `:${n}:${f}`);
    let text: string | null = null;
    if (isKitVersionFile(f)) {
      const [ours, theirs] = [(await side(2))?.trim(), (await side(3))?.trim()];
      if (ours && theirs && KIT_VERSION.test(ours) && KIT_VERSION.test(theirs)) text = kitVersionText(compareVersions(ours, theirs) >= 0 ? ours : theirs, (await side(3)) ?? '');
    } else if (isKitChangelog(f)) {
      const [base, ours, theirs] = [await side(1), await side(2), await side(3)];
      if (ours !== null && theirs !== null) text = mergeChangelogs(base ?? '', theirs, ours, kit) ?? theirs;
    } else if (inKit(f)) {
      text = existsSync(path.join(dir, f)) ? resolveVersionConflicts(readFileSync(path.join(dir, f), 'utf8')) : null;
    } else if ((await gitMaybe(run, dir, 'checkout', '--theirs', '--', f)) !== null || (await gitMaybe(run, dir, 'rm', '--quiet', '--', f)) !== null) continue;
    if (text === null) return undo();
    writeFileSync(path.join(dir, f), text);
  }
  await git(run, dir, 'add', '-A');
  await git(run, dir, 'commit', '--quiet', '--no-edit');
  return true;
}

/**
 * `pr` and the kit PRs queued after it (triedWith) as one kit to try: the branch as it is now with each merged in, in
 * turn (mergeInto), in a worktree of the Steward's clone, kept as a commit there (TOGETHER_REF keeps it from git's
 * pruning while it is tried). One that won't merge in ends the line there. Null when none joins `pr`, or `pr` itself
 * won't merge in: it is tried alone, as before.
 */
async function combineKits(ctx: Ctx, steward: Employee, pr: PrInfo, kit: string, after: PrInfo[]): Promise<{ key: string; t: KitTrial } | null> {
  const { run } = ctx;
  const repo = checkoutOf(steward);
  await fetchBranch(run, repo, steward.branch);
  const base = await commitOf(run, repo, `origin/${steward.branch}`);
  if (!base) return null;
  const dir = togetherDirOf(ctx);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, base, '--detach');
  try {
    const members: KitMember[] = [];
    for (const p of [pr, ...after]) {
      await fetchFor(run, repo, p.headOid, `refs/pull/${p.number}/head`);
      const v = p === pr ? kit : (await showFile(run, repo, p.headOid, KIT_VERSION_FILE))?.trim();
      const from = (await gitMaybe(run, repo, 'merge-base', base, p.headOid))?.trim();
      const files = v && KIT_VERSION.test(v) && from ? await gitMaybe(run, repo, 'diff', '--name-only', '--no-renames', from, p.headOid, '--', 'kit', TOOL) : null;
      if (files === null || !(await mergeInto(ctx, dir, p, v!))) break;
      members.push({ number: p.number, head: p.headOid, kit: v!, files: linesOf(files) });
    }
    if (members.length < 2) return null;
    const commit = await git(run, dir, 'rev-parse', 'HEAD');
    await git(run, repo, 'update-ref', TOGETHER_REF, commit);
    const tried = await triedAt(ctx, repo, commit);
    if (!tried.tree) return null;
    const employees = ctx.settings.employees.filter((e) => e.usesKit && existsSync(checkoutOf(e)));
    const t: KitTrial = { kit: members.at(-1)!.kit, failed: [], passed: 0, at: new Date().toISOString(), ...tried, mains: {}, pending: employees.map((e) => e.id), steward: APP.version, members, commit, base };
    return { key: togetherKeyOf(members), t };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${APP.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * Whether kit PRs tried together (`c`) cover `pr` at its head now: what its branch gets once it merges there (git
 * merge-tree of the two) has the kit tried, but for versions and changelogs, the files of the PRs tried after it that are
 * still queued after it (`after`), and files the branch changed since that no PR tried there touches (as a trial at a PR's
 * head never had them either). `exact` when it differs in none of those: the kit it releases is the one tried, so its
 * rollout needn't run the agents' checks again (trialpass.ts). Null when it doesn't cover it.
 */
async function coveredBy(ctx: Ctx, repo: string, branch: string, c: KitTrial, pr: PrInfo, after: PrInfo[]): Promise<(KitAt & { exact: boolean }) | null> {
  const at = c.members?.findIndex((m) => m.number === pr.number) ?? -1;
  if (at < 0 || !c.tree || !c.base) return null;
  const r = await ctx.run('git', ['merge-tree', '--write-tree', '--no-messages', `origin/${branch}`, pr.headOid], { cwd: repo, timeoutMs: 5 * 60_000 });
  const merged = r.code === 0 || r.code === 1 ? r.out.split('\n')[0].trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(merged)) return null;
  const now = await triedAt(ctx, repo, merged);
  const moved = await gitMaybe(ctx.run, repo, 'diff', '--name-only', '--no-renames', c.base, `origin/${branch}`, '--', 'kit', TOOL);
  if (!now.tree || moved === null) return null;
  const queued = new Set(after.map((p) => p.number));
  const theirs = new Set(c.members!.flatMap((m) => m.files));
  const allowed = new Set([...c.members!.slice(at + 1).filter((m) => queued.has(m.number)).flatMap((m) => m.files), ...linesOf(moved).filter((f) => !theirs.has(f))]);
  const d = await kitDiffers(ctx, repo, { tree: c.tree, tool: c.tool ?? null }, { tree: now.tree, tool: now.tool ?? null }, allowed);
  return d && { tree: now.tree, tool: now.tool ?? null, exact: !d.later };
}

/** The kit PRs tried together that `pr` is one of, newest first. Pure. */
const togetherWith = (kept: Record<string, KitTrial>, pr: PrInfo) =>
  Object.entries(kept)
    .filter(([k, x]) => k.startsWith(TOGETHER) && !!x.members?.some((m) => m.number === pr.number))
    .reverse();

/**
 * The trial of kit PRs together that covers `pr` at its head now (coveredBy), still going or passing every agent; null
 * for none. One that failed an agent covers no one: the first of them is tried alone.
 */
async function togetherFor(ctx: Ctx, steward: Employee, pr: PrInfo, kept: Record<string, KitTrial>, after: PrInfo[]): Promise<{ key: string; t: KitTrial; cov: KitAt & { exact: boolean } } | null> {
  const mine = togetherWith(kept, pr).filter(([, c]) => leftOf(c) > 0 || !c.failed.length);
  if (!mine.length) return null;
  const repo = checkoutOf(steward);
  await fetchBranch(ctx.run, repo, steward.branch);
  for (const [key, c] of mine) {
    // Still to try, from a commit git no longer has: no use.
    if (leftOf(c) && !(c.commit && (await commitOf(ctx.run, repo, c.commit)))) continue;
    const cov = await coveredBy(ctx, repo, steward.branch, c, pr, after);
    if (cov) return { key, t: c, cov };
  }
  return null;
}

/**
 * Whether `pr` is tried alone, not together again: kit PRs tried together failed an agent with it in (whose doing it
 * was isn't known, so the first is tried alone, and its failures are its own), or were tried with it at this very head. Pure.
 */
const triedTogether = (kept: Record<string, KitTrial>, pr: PrInfo) => togetherWith(kept, pr).some(([, c]) => (!leftOf(c) && c.failed.length > 0) || c.members!.some((m) => m.number === pr.number && m.head === pr.headOid));

/**
 * A trial's pending agents tried on their own, to the end, beside the rounds (trialsOnTheirOwn): `t` saved after each
 * agent with this process as its `by`, and onTheirOwn told when it ends, so a round then settles the PR at once.
 */
function tryOnItsOwn(ctx: Ctx, steward: Employee, at: TrialAt, t: KitTrial, save: () => void): void {
  const { pr } = at;
  running = { key: at.key, pr: pr.number, kit: t.kit };
  const saving = () => {
    t.by = { pid: process.pid, at: new Date().toISOString() };
    save();
  };
  saving();
  ctx.log(`[${APP.id}] #${pr.number}: trying kit ${t.kit} on ${leftOf(t)} agents, ${trialParallel(ctx.settings.parallel)} at a time, beside the rounds`);
  let cut: string | null = null;
  void apart('kit trial', () => trySlice(ctx, steward, at, t, Number.POSITIVE_INFINITY, saving))
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
 * Steward as the merge stage's employee. `o.note`: given the pairs' words when they are why it merges, for its line, or
 * the PRs it was tried together with. `o.line`: the kit PRs in the order they merge (merge.ts's kit queue), so the ones
 * queued after it are tried with it (combineKits).
 */
export async function kitTrialHold(ctx: Ctx, steward: Employee, pr: PrInfo, o: { note?: (words: string) => void; sliceMs?: number; going?: () => void; line?: PrInfo[] } = {}): Promise<string | null> {
  if (steward.id !== APP.id || !raisesKit(pr)) return null;
  if (!pr.headOid) return "GitHub didn't say its head commit, so its kit wasn't tried on the agents";
  const kept = readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
  const repo = checkoutOf(steward);
  let key = keyOf(pr);
  let t = kept[key];
  // Tried just now: no branch has moved since.
  let fresh = false;
  if (!t) {
    await fetchFor(ctx.run, repo, pr.headOid, `refs/pull/${pr.number}/head`);
    const kit = (await showFile(ctx.run, repo, pr.headOid, KIT_VERSION_FILE))?.trim();
    if (!kit || !KIT_VERSION.test(kit)) return `its kit/VERSION at ${pr.headOid.slice(0, 7)} isn't a version, so its kit wasn't tried on the agents`;
    const tried = await triedAt(ctx, repo, pr.headOid);
    const after = triedWith(pr, o.line ?? []);
    const sha = pr.headOid.slice(0, 7);
    // Tried together with the kit PRs queued with it: going on, this PR waits for it; passing, its kit the one tried but
    // for versions and those still to merge after it, it merges.
    const together = await togetherFor(ctx, steward, pr, kept, after).catch((err: Error) => {
      ctx.log(`[${APP.id}] #${pr.number}: couldn't tell whether the kit PRs tried together cover it: ${err.message}`);
      return null;
    });
    // At an earlier head of this PR, the same kit but for versions and changelogs (a catch-up's): its verdict stands, and
    // only the agents whose branch moved are tried again, below.
    const before = together ? undefined : await carriedFrom(ctx, repo, pr, tried, kept);
    if (together && leftOf(together.t)) {
      key = together.key;
      t = together.t;
    } else if (together) {
      const c = together.t;
      const others = c.members!.filter((m) => m.number !== pr.number).map((m) => `#${m.number}`);
      const words = `kit tried on every agent together with ${others.join(', ')}, in one trial`;
      ctx.log(`[${APP.id}] #${pr.number}: ${words}, and its kit at ${sha} is the one tried${together.cov.exact ? '' : ', but for those still to merge after it'}: not tried again`);
      o.note?.(words);
      t = { kit, failed: [], passed: c.passed, at: c.at, tree: together.cov.tree, tool: together.cov.tool, mains: together.cov.exact ? { ...c.mains } : {}, ...(c.untouched ? { untouched: c.untouched } : {}), ...(c.own?.length ? { own: c.own } : {}), steward: c.steward, from: together.key };
    } else if (before) {
      const was = before[1].kit === kit ? `kit ${kit}` : `kit ${before[1].kit} (${kit} now)`;
      ctx.log(`[${APP.id}] #${pr.number}: ${was} was tried at ${before[0].split('@')[1].slice(0, 7)}, and its kit and tools/kit.ts are the same at ${sha} but for versions and changelogs: not tried again`);
      t = { ...before[1], kit, ...tried, from: before[0] };
    } else {
      const employees = ctx.settings.employees.filter((e) => e.usesKit && existsSync(checkoutOf(e)));
      const how = onTheirOwn ? `${trialParallel(ctx.settings.parallel)} at a time, beside the rounds` : 'a few each round';
      // The kit PRs queued after it, tried with it once, unless they were already, or failed an agent together.
      const combined = after.length && !pr.labels.includes(KIT_BREAKS_LABEL) && !triedTogether(kept, pr)
        ? await combineKits(ctx, steward, pr, kit, after).catch((err: Error) => {
            ctx.log(`[${APP.id}] #${pr.number}: couldn't merge the kit PRs queued after it into one kit, so it is tried alone: ${err.message}`);
            return null;
          })
        : null;
      if (combined) {
        key = combined.key;
        t = combined.t;
        const others = t.members!.slice(1).map((m) => `#${m.number}`);
        ctx.log(`[${APP.id}] #${pr.number} raises the kit to ${kit}, and ${others.join(', ')} queued after it to ${t.kit}: trying their kit together (${steward.branch} with each merged in, in turn) on ${employees.length} agents before they merge, ${how}`);
      } else {
        ctx.log(`[${APP.id}] #${pr.number} raises the kit to ${kit}: trying it on ${employees.length} agents before it merges, ${how}`);
        t = { kit, failed: [], passed: 0, at: new Date().toISOString(), ...tried, mains: {}, pending: employees.map((e) => e.id), steward: APP.version };
      }
    }
  }
  const at: TrialAt = { key, pr, commit: t.commit ?? pr.headOid };
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
  if (leftOf(t) && (running?.key === key || triedElsewhere(t))) {
    // Being tried on its own, here or by another process: how far it got.
    o.going?.();
    return goingWords(t);
  }
  if (leftOf(t) && onTheirOwn) {
    const waits = otherGoing();
    if (waits) return waits;
    tryOnItsOwn(ctx, steward, at, t, saveOf(t));
    o.going?.();
    return goingWords(t);
  }
  if (t.pending || t.retry) {
    // Still being tried: this round's slice, kept as it goes. Refused (no kit.json on its main, say) isn't the kit's
    // doing, and isn't held against it; one the network cut short is no verdict on the kit, and is tried again.
    const cut = leftOf(t) ? await trySlice(ctx, steward, at, t, o.sliceMs ?? TRIAL_SLICE_MS, save) : null;
    if (cut || leftOf(t)) {
      o.going?.();
      if (cut) return cut;
      return goingWords(t);
    }
    fresh = true;
    delete t.pending;
    delete t.retry;
    // Tried side by side, they ended in any order: named in the staff's.
    const order = (id: string) => ctx.settings.employees.findIndex((e) => e.id === id) >>> 0;
    t.failed = [...t.failed].sort((a, b) => order(a.id) - order(b.id));
    t.at = new Date().toISOString();
    const together = t.members ? ` and ${t.members.slice(1).map((m) => `#${m.number}`).join(', ')}'s, together,` : '';
    ctx.log(`[${APP.id}] #${pr.number}: kit ${t.kit}${together} tried on every agent: ${t.passed} passed, ${t.failed.length} failed, ${t.own?.length ?? 0} failed without it too (not held against it), ${t.untouched ?? 0} not tried (nothing they take from the kit changes)`);
  }
  if (t.members) {
    // Kit PRs tried together, now done: passing, they cover this PR, and it merges; failing, it is tried alone.
    save();
    return kitTrialHold(ctx, steward, pr, o);
  }
  if (!fresh && t.failed.length) {
    // Fixed on the agents' side: each whose branch moved since is tried again with the same kit.
    const moved = await movedOn(ctx, t);
    if (moved.length) {
      const waits = otherGoing();
      if (waits) return waits;
      const why = t.steward === APP.version ? `moved on since kit ${t.kit} failed their checks` : `failed kit ${t.kit}'s checks as Steward ${t.steward ?? 'before 0.35.73'} tried them`;
      ctx.log(`[${APP.id}] #${pr.number}: ${moved.map((e) => e.name).join(', ')} ${why}: trying ${moved.length === 1 ? 'it' : 'them'} again`);
      await fetchFor(ctx.run, repo, pr.headOid, `refs/pull/${pr.number}/head`);
      const results = await tryAtHead(ctx, steward, pr, t.kit, moved);
      // Cut short by the network: the kept verdict stands, and the next round tries them again (their main still moved).
      for (const r of results) if (r.outcome === 'failed' && (await networkFailure(ctx, r.message))) return `its kit's trial on ${r.name} was cut short by the network: the next round tries again`;
      const ids = new Set(moved.map((e) => e.id));
      const failed = [...t.failed.filter((f) => !ids.has(f.id)), ...failuresOf(results)];
      // Its pairs kept, by head commit: one tried before isn't tried again (pairUp).
      const mains = { ...Object.fromEntries(Object.entries(t.mains ?? {}).filter(([id]) => !ids.has(id))), ...mainsOf(results) };
      const own = [...(t.own ?? []).filter((f) => !ids.has(f.id)), ...ownFailuresOf(results)];
      const now: KitTrial = { kit: t.kit, failed, passed: t.passed + results.filter((r) => r.outcome === 'done').length, at: new Date().toISOString(), ...(t.tree ? { tree: t.tree, tool: t.tool } : {}), mains, ...(t.untouched ? { untouched: t.untouched } : {}), ...(own.length ? { own } : {}), steward: APP.version, ...(t.pairs ? { pairs: t.pairs } : {}), ...(t.pairsSaid ? { pairsSaid: t.pairsSaid } : {}) };
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

/** The kit a hold says fails agents' checks (kitTrialHold's last word, its trial done), or null for any other hold. Pure. */
export const trialFails = (why: string): string | null => /^kit (\d+\.\d+\.\d+) fails \d+ agent(?:'s|s') checks here/.exec(why)?.[1] ?? null;

/**
 * Whether the branch changed the kit (kit\ or tools/kit.ts) since this PR left it: a kit PR its trial fails is then
 * caught up (merge.ts), so it is tried again with what the branch fixed meanwhile. Steward#214 (kit 2.69.0) failed the
 * Smith's typecheck round after round on 2026-10-13, which main had fixed in kit 2.68.0, and held every Steward PR
 * above it.
 * origin/<branch> as the round fetched it. False when it can't be told.
 */
export async function kitMovedUnder(ctx: Ctx, e: Employee, pr: PrInfo): Promise<boolean> {
  if (!pr.headOid) return false;
  const repo = checkoutOf(e);
  await fetchFor(ctx.run, repo, pr.headOid, `refs/pull/${pr.number}/head`);
  const base = (await gitMaybe(ctx.run, repo, 'merge-base', `origin/${e.branch}`, pr.headOid))?.trim();
  if (!base) return false;
  const changed = await gitMaybe(ctx.run, repo, 'diff', '--name-only', base, `origin/${e.branch}`, '--', 'kit', 'tools/kit.ts');
  return !!changed?.trim();
}

/** The latest trial kept for a PR of this kit, at any head (kit-trials.json), or null. */
export function latestTrial(number: number, kit: string, kept = readJson<Record<string, KitTrial>>(kitTrialsFile(), {})): KitTrial | null {
  const mine = Object.entries(kept).filter(([k, t]) => k.startsWith(`${number}@`) && t.kit === kit).map(([, t]) => t);
  return mine.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}
