import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fetchBranch, showFile } from '../git.ts';
import { compareVersions, KIT_VERSION } from '../kitfiles.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { bump } from './bump.ts';
import { checkoutOf, freshBranch, workRootOf, glanceOf, networkFailure, NOT_ON_KIT, passingFailure, result, type Ctx, type EmployeeResult, type KitFold } from './common.ts';
import { push } from './push.ts';
import { openPrs, parsePrs, readPin } from './staff.ts';
import { hostFor } from '../hosts/index.ts';
import { LockTimeout, withLock } from '../kit/lock.ts';
import { apart, STAGE_STALE_MS, withRepo } from './slots.ts';
import { kitReach, type KitReach } from './kitreach.ts';
import { releasedTool, releasedTree, stewardClone } from './trialpass.ts';
import { phaseOf, timed } from '../buildtimes.ts';
import { mergeOwn } from './mainbuild.ts';
import { RETIRED, retiredOf } from '../retired.ts';

/**
 * The rollout, in a round: a new kit reaches every employee without anyone running `steward bump` and `steward push`.
 * When the newest kit release (from the round's glance at GitHub: no call of its own) is newer than the kit an
 * employee's branch pins, and it has no kit PR of the Steward's open (steward/kit-…), no other open PR that pins that
 * kit already (an agent's own work, which brings the kit with it: a kit-only PR beside it took the same version, and
 * was closed or conflicted, 0.27.13), and no bump to that kit that failed at its branch's head, the round bumps it (a
 * worktree of its branch, the new pin and a version claimed for it (claims.ts), its checks run, committed) and pushes
 * the PR, a few employees at a time (Settings' parallel), and merges it at once (push.ts, Steward 0.36.124): its checks
 * passed in the bump, and no one else merges the Steward's PRs. The build releases it. A kit PR of the Steward's left
 * open (one GitHub wouldn't merge at once, or one from before 0.36.124) is merged by the next rollout that finds it at
 * the kit rolled out.
 *
 * An agent Manor has retired (its staff.json: retired.ts) gets no kit: the rounds pass it over, and a bump of it that
 * failed before is let go. A person's Bump or Push naming it still does it.
 *
 * A kit PR of the Steward's still open for an older kit (waiting its turn behind the employee's other PRs, which its
 * version is above) gets the newer kit instead of a second kit PR beside it: the fold. Its branch is bumped again, at
 * the version it already has, its changelog entry rewritten for every kit since the one the employee's branch pins, its
 * checks run, and the commit pushed on top (never forced), with the PR's title and description made the new kit's. One
 * PR to merge and one release, where there would have been two.
 *
 * A bump or a push that fails is kept in rollout-failed.json, with the kit and the branch's head it failed at: an
 * alarm at once, and the rounds don't try that kit again until a new commit lands on the employee's branch, or a
 * person presses Bump or Push (or runs `steward bump` / `steward push`), which clears it.
 *
 * A bump hands out the Steward's own tools/kit.ts, the one released with the kit it carries. While this Steward carries
 * a kit older than the newest release (it released the kit this very round, and Manor hasn't installed it yet), it
 * hands out the tools/kit.ts released with the new kit instead, read from the kit's tag in its own clone (0.35.29): the
 * kit goes out in the round that released it, not after Manor's update and the Steward's restart. Only when that can't
 * be read does the rollout wait for Manor to install the Steward's new release.
 *
 * A new kit settles before it goes out (0.35.68): kits came in bursts, fifteen in a day and a half, and each one was
 * rolled out to every agent (a bump, its checks, a PR, a merge, a release, a Manor install and a site refresh each),
 * though the next kit came an hour later and did it all again. Now only the newest kit goes, once it has gone Settings'
 * rolloutQuietHours without a newer one, and never later than rolloutMaxWaitHours after the oldest kit released since
 * the last one rolled out (rollout-settle.json). A kit whose changelog entry's bold line starts with "Urgent" goes at
 * once. While the newest settles, the kit rolled out last still reaches those behind it, and its folds, as before.
 *
 * On the Steward's page (agent.ts: rolloutsBeside) the bumps and pushes run beside the rounds, never inside one (0.36.60).
 * Inside the round, a rollout to some thirty agents, each bump running its checks at the checks pace, held every merge
 * until it ended: the rounds that rolled a kit out took 20 to 56 minutes from 2026-10-12 to 15, against 15 to 20 for
 * those that didn't, and a ready PR waited all that time. Now the round decides (the kit, and which employees are behind
 * it: a fetch and a read for each) and starts the bumps as a job of its own, then goes on at once; one that reaches an
 * employee the rollout is bumping right now waits for that one bump, as two stages do for a repository (stages/slots.ts).
 * While it runs no round starts another (`going`); one another process runs (a round in a terminal) holds
 * locks\rollout, and leaves this PC's rounds nothing to roll out. When it ends, `ended` is told (a round comes at once,
 * so a build releases what it merged), and that round reports what it did
 * (takeRolloutResults), so stages.log, the round's look at what failed and the alarms see it as before. In a terminal
 * round, and under node --test unless a test says otherwise, it runs inside the round as before.
 */

export const rolloutFailedFile = () => dataFile('rollout-failed.json');

/** Held while a rollout bumps and pushes, here or in another process: one at a time on this PC. */
export const rolloutLock = () => dataFile('locks', 'rollout');

/** What a round says when another process's rollout holds rolloutLock. */
const ELSEWHERE = 'another rollout is bumping and pushing on this PC (a round in a terminal, say): the kit is left to it, and the next round looks again';

/** What a rollout beside the rounds did, as `ended` is told it. */
export interface RolloutRun {
  kit: string;
  results: EmployeeResult[];
}

/**
 * Set by the Steward's page (agent.ts): the rollout's bumps and pushes then run beside the rounds, `ended` told when
 * one ends and its lines going to `log`. Unset (a round in a terminal, the tests), they run inside the round.
 */
let beside: { ended?: (r: RolloutRun) => void; log?: (line: string) => void } | null = null;
export const rolloutsBeside = (o: typeof beside): void => void (beside = o);

/** The rollout running beside the rounds in this process: one at a time. */
let going: { kit: string; names: string[]; started: number; done: Promise<void> } | null = null;

/** What the rollouts beside the rounds did since a round last reported it. */
let unreported: EmployeeResult[] = [];

/** Settles once the rollout running beside the rounds has ended (at once when none runs). */
export const rolloutDone = (): Promise<void> => going?.done ?? Promise.resolve();

/** The kit and the employees (by name) of the rollout running beside the rounds in this process, or null when none runs. */
export const rolloutGoingOn = (): { kit: string; names: string[] } | null => (going ? { kit: going.kit, names: going.names } : null);

/** What the rollouts beside the rounds did since a round last took it: that round's results now. */
export function takeRolloutResults(): EmployeeResult[] {
  const out = unreported;
  unreported = [];
  return out;
}

/** How long ago, in words: "4 minutes". Pure. */
const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? 'less than a minute' : m === 1 ? 'a minute' : `${m} minutes`;
};

/** The kit rolled out last, and when the round chose it: what the next kit's settling counts from. */
export const rolloutSettleFile = () => dataFile('rollout-settle.json');

export interface RolloutSettled {
  kit: string;
  at: string;
}

const loadRolled = (): string | null => {
  const s = readJson<Partial<RolloutSettled> | null>(rolloutSettleFile(), null);
  return typeof s?.kit === 'string' && KIT_VERSION.test(s.kit) ? s.kit : null;
};

/** Whether the kit's changelog entry (its `## <kit>` section, or the whole text when it has none) is marked urgent: its bold line starts with "Urgent". Pure. */
export function urgentIn(changelog: string | null, kit: string): boolean {
  if (!changelog) return false;
  const text = changelog.replace(/\r\n/g, '\n');
  const heads = [...text.matchAll(/^## +\[?v?(\d+\.\d+\.\d+)\]?.*$/gm)];
  const at = heads.findIndex((h) => h[1] === kit);
  const entry = at >= 0 ? text.slice(heads[at].index!, heads[at + 1]?.index ?? text.length) : heads.length ? '' : text;
  const bold = /^\*\*(.+?)\*\*/m.exec(entry);
  return !!bold && /^urgent\b/i.test(bold[1].trim());
}

/** The released kits newer than the one rolled out last, up to the newest, oldest first. Pure. */
export function pendingKits(o: { newest: string; released: string[]; rolled: string | null }): string[] {
  return [...new Set([...o.released, o.newest])]
    .filter((v) => compareVersions(v, o.newest) <= 0 && (!o.rolled || compareVersions(v, o.rolled) > 0))
    .sort(compareVersions);
}

export interface Settle {
  /** The kit the round rolls out: the newest once it has settled, else the one rolled out last (null when there's none). */
  kit: string | null;
  /** The newest kit, while it settles, and when it goes (ms). */
  settling: { kit: string; until: number } | null;
  /** The urgent kit that sends the newest at once, if one does. */
  urgent: string | null;
}

/**
 * Which kit a round rolls out: the newest once it has gone `quietHours` without a newer release, or once `maxWaitHours`
 * have passed since the oldest kit released after the one rolled out last (`rolled`), or at once when one of those is
 * urgent. A kit with no published time counts as old enough. Until then, `rolled`, if it is released. Pure.
 */
export function settleKit(o: { newest: string | null; released: string[]; published: Record<string, string>; rolled: string | null; urgent: string[]; quietHours: number; maxWaitHours: number; now: number }): Settle {
  const go = (kit: string | null, urgent: string | null = null): Settle => ({ kit, settling: null, urgent });
  if (!o.newest) return go(null);
  if (o.rolled && compareVersions(o.rolled, o.newest) >= 0) return go(o.newest);
  const pending = pendingKits({ newest: o.newest, released: o.released, rolled: o.rolled });
  const urgent = pending.find((v) => o.urgent.includes(v));
  if (urgent) return go(o.newest, urgent);
  const time = (v: string) => {
    const t = Date.parse(o.published[v] ?? '');
    return Number.isFinite(t) ? t : -Infinity;
  };
  const quiet = time(o.newest) + o.quietHours * 3600_000;
  const longest = Math.min(...pending.map(time)) + o.maxWaitHours * 3600_000;
  const until = Math.min(quiet, longest);
  if (o.now >= until) return go(o.newest);
  return { kit: o.rolled && o.released.includes(o.rolled) ? o.rolled : null, settling: { kit: o.newest, until }, urgent: null };
}

/** A time of day, as the log writes it (HH:MM, this PC's time). Pure. */
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The one line a round logs while the newest kit settles. Pure. */
export const settlingLine = (s: NonNullable<Settle['settling']>, rolled: string | null) =>
  `kit ${s.kit} settles until ${clock(s.until)}${rolled ? ` (kit ${rolled} still reaches those behind it)` : ''}`;

/**
 * The kit this round rolls out, for `rollout`: settleKit over the kit's releases (ctx.kit) and the kit rolled out last,
 * reading the changelogs of the kits waiting (only while the newest settles) for an urgent one.
 */
async function settledKit(ctx: Ctx, newest: string | null, changelog: (kit: string) => Promise<string | null>, now = Date.now()): Promise<Settle> {
  const rolled = loadRolled();
  const base = {
    newest,
    released: ctx.kit?.released ?? [],
    published: ctx.kit?.published ?? {},
    rolled,
    quietHours: ctx.settings.rolloutQuietHours ?? 2,
    maxWaitHours: ctx.settings.rolloutMaxWaitHours ?? 12,
    now,
  };
  const first = settleKit({ ...base, urgent: [] });
  if (!first.settling || !newest) return first;
  const urgent: string[] = [];
  for (const k of pendingKits({ newest, released: base.released, rolled })) {
    if (urgentIn(await changelog(k).catch(() => null), k)) urgent.push(k);
  }
  return urgent.length ? settleKit({ ...base, urgent }) : first;
}

/**
 * A bump or push that failed in a round: for which kit, at which head of the employee's branch, and what it said. Or,
 * kept from before Steward 0.36.124, a kit PR a build left out (stage 'build'): its head then.
 */
export interface RolloutHold {
  kit: string;
  head: string;
  stage: 'bump' | 'push' | 'build';
  message: string;
  at: string;
}

export const loadRolloutFailures = (): Record<string, RolloutHold> => readJson<Record<string, RolloutHold>>(rolloutFailedFile(), {});

/**
 * What a rollout changed in the holds since it read them (`before` to `after`), written over the file as it is now: a
 * Bump or Push pressed while the round's rollout ran (stages/slots.ts) clears its holds, and keeps them cleared.
 */
function saveRolloutChanges(before: Record<string, RolloutHold>, after: Record<string, RolloutHold>): void {
  const now = loadRolloutFailures();
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[id]) === JSON.stringify(after[id])) continue;
    if (after[id]) now[id] = after[id];
    else delete now[id];
  }
  writeJson(rolloutFailedFile(), now);
}

/** What the decision needs of one employee: read from its checkout's origin/<branch> and the glance's PRs. */
export interface RolloutFacts {
  /** Its checkout is on this PC. */
  checkout: boolean;
  /** Its branch's head on origin, or null when there's none. */
  head: string | null;
  /** The kit its branch's kit.json pins, or null when it has none. */
  pin: string | null;
  /** Its open kit PRs of the Steward's (#12 steward/kit-2.9.0). */
  kitPrs: string[];
  /** The one of them that pins an older kit than the one rolled out, which takes the new kit (the fold). */
  fold?: KitFold;
  /** The one of them that pins the kit rolled out already, at its head: merged by the rollout (Steward 0.36.124). */
  own?: { number: number; head: string };
  /** Its other open PRs that pin the kit rolled out already, or a newer one (#20 (claude/developer-options, kit 2.39.0)). */
  pinPrs?: string[];
}

export interface RolloutPlan {
  /** The kit rolled out, or null when nothing is (off, no kit release, or the Steward waits for its own update). */
  kit: string | null;
  /** Why nothing is rolled out, when nothing is: one line for the log. */
  why: string | null;
  /** True when it waits only for this Steward to carry the kit: an alarm once that lasts. */
  waitsForSteward: boolean;
  /** While the newest kit settles: one line that says until when (and `kit` is the one rolled out last, or null). */
  settling?: string;
  /** Bumped and pushed now, each with its branch's head; `fold`, onto its kit PR open for an older kit. */
  bump: { employee: Employee; head: string; fold?: KitFold }[];
  /** Its kit PR open at the kit rolled out, merged now (RolloutFacts' `own`). */
  merge?: { employee: Employee; number: number; head: string }[];
  /** Not now, and why; `held` for one whose bump failed at this head. */
  skip: { employee: Employee; why: string; held?: boolean }[];
}

/** Whether a round's rollout can do anything at all: Settings, a kit release, the Steward carrying it. Pure. */
export function rolloutGate(o: { on: boolean; kit: string | null; ownKit: string | null; settling?: string }): { kit: string } | { why: string; waitsForSteward: boolean } {
  if (!o.on) return { why: '"Rolls out a new kit by itself" is off in Settings', waitsForSteward: false };
  if (!o.kit) return { why: o.settling ?? 'no kit release to roll out', waitsForSteward: false };
  if (o.ownKit && compareVersions(o.ownKit, o.kit) < 0) {
    return { why: `kit ${o.kit} waits for this Steward to carry it (it carries ${o.ownKit}, and a bump hands out its tools/kit.ts): Manor installs the Steward's next release`, waitsForSteward: true };
  }
  return { kit: o.kit };
}

/** Which employees a round bumps to the newest kit, and why the others aren't: never one Manor has retired (`retired`). Pure. */
export function planRollout(o: { on: boolean; kit: string | null; ownKit: string | null; settling?: string; employees: Employee[]; facts: Record<string, RolloutFacts>; failed: Record<string, RolloutHold>; retired?: ReadonlySet<string> }): RolloutPlan {
  const gate = rolloutGate(o);
  const settling = o.settling ? { settling: o.settling } : {};
  if ('why' in gate) return { kit: null, why: gate.why, waitsForSteward: gate.waitsForSteward, bump: [], skip: [], ...settling };
  const kit = gate.kit;
  const plan: RolloutPlan = { kit, why: null, waitsForSteward: false, bump: [], skip: [], ...settling };
  for (const e of o.employees) {
    const f = o.facts[e.id];
    const skip = (why: string, held?: boolean) => void plan.skip.push({ employee: e, why, ...(held ? { held } : {}) });
    if (o.retired?.has(e.id)) skip(RETIRED);
    else if (!e.usesKit) skip(NOT_ON_KIT);
    else if (!f) skip('not looked at');
    else if (!f.checkout) skip(`no checkout at ${checkoutOf(e)}`);
    else if (!f.head) skip(`no ${e.branch} on origin`);
    else if (!f.pin) skip(`no kit.json on origin/${e.branch}`);
    else if (compareVersions(f.pin, kit) >= 0) skip(`on kit ${f.pin} already`);
    else if (f.kitPrs.length && f.own) (plan.merge ??= []).push({ employee: e, ...f.own });
    else if (f.kitPrs.length && !f.fold) skip(`its kit PR ${f.kitPrs.join(', ')} is open: close it, and the next build rolls the kit out afresh`);
    else if (f.pinPrs?.length) skip(`its open PR ${f.pinPrs.join(', ')} already brings kit ${kit}, so it gets no kit PR of its own beside it`);
    else {
      const h = o.failed[e.id];
      if (h && h.kit === kit && h.head === f.head) skip(`its ${h.stage} to kit ${kit} failed at ${f.head.slice(0, 7)} (${h.message}), so the rounds leave it until a new commit lands on ${e.branch}, or you press ${h.stage === 'bump' ? 'Bump' : 'Push'}`, true);
      else plan.bump.push({ employee: e, head: f.head, ...(f.fold ? { fold: f.fold } : {}) });
    }
  }
  return plan;
}

/**
 * One employee's facts for the decision: its branch fetched only when the glance says it moved (the round's release
 * step has fetched it already); its PRs from the glance, and asked of GitHub only when it is behind `kit` and the
 * glance no longer says (a merge this round).
 */
export async function rolloutFacts(ctx: Ctx, e: Employee, kit: string): Promise<RolloutFacts> {
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return { checkout: false, head: null, pin: null, kitPrs: [] };
  const head = await freshBranch(ctx, e, repo);
  const pin = head ? (readPin(await showFile(ctx.run, repo, `origin/${e.branch}`, 'kit.json'))?.kit ?? null) : null;
  if (!pin || compareVersions(pin, kit) >= 0) return { checkout: true, head, pin, kitPrs: [] };
  const g = glanceOf(ctx, e);
  const prs = parsePrs(g ? JSON.stringify(g.prs) : await openPrs(hostFor(ctx, e), e.repo), ctx.settings.team);
  const open = prs.filter((p) => p.whose === 'steward' && p.head.startsWith('steward/kit-') && !p.fork);
  const kitPrs = open.map((p) => `#${p.number} (${p.head})`);
  if (kitPrs.length) {
    // One kit PR open for an older kit takes this one: what its branch on origin pins now, not its name, says which.
    if (open.length !== 1 || open[0].draft) return { checkout: true, head, pin, kitPrs };
    const p = open[0];
    const at = await fetchBranch(ctx.run, repo, p.head)
      .then(async () => readPin(await showFile(ctx.run, repo, `origin/${p.head}`, 'kit.json'))?.kit ?? null)
      .catch(() => null);
    if (at && KIT_VERSION.test(at) && compareVersions(at, kit) >= 0 && p.headOid) return { checkout: true, head, pin, kitPrs, own: { number: p.number, head: p.headOid } };
    return { checkout: true, head, pin, kitPrs, ...(at && KIT_VERSION.test(at) && compareVersions(at, kit) < 0 ? { fold: { number: p.number, head: p.head, kit: at } } : {}) };
  }
  // Its other open PRs that change kit.json (or say nothing of their files): one that pins this kit, or a newer one, at
  // its head brings the kit with it. Read from origin's branch; a fork's isn't there, and is left out.
  const pinPrs: string[] = [];
  for (const p of prs.filter((x) => !x.files.length || x.files.includes('kit.json'))) {
    const at = await fetchBranch(ctx.run, repo, p.head)
      .then(async () => readPin(await showFile(ctx.run, repo, `origin/${p.head}`, 'kit.json'))?.kit ?? null)
      .catch(() => null);
    if (at && compareVersions(at, kit) >= 0) pinPrs.push(`#${p.number} (${p.head}, kit ${at})`);
  }
  return { checkout: true, head, pin, kitPrs, pinPrs };
}

/** A manual Bump or Push (the page's button, or the command) lets the rounds try those employees again. */
export function clearRolloutHolds(ids: string[]): void {
  const failed = loadRolloutFailures();
  let changed = false;
  for (const id of ids) if (id in failed) (delete failed[id], (changed = true));
  if (changed) writeJson(rolloutFailedFile(), failed);
}

/**
 * The round's rollout, for the employees it looks at: each one's facts, the decision, then bump and push for those
 * behind the newest kit. One result for each employee it did something for (prefixed "rollout: "); a held one says so,
 * skipped. What failed is kept, and what no longer holds is let go. Beside the rounds (rolloutsBeside), the bumps and
 * pushes are started as a job of their own and `beside` is true: their results come in a later round (takeRolloutResults).
 */
export async function rollout(ctx: Ctx, employees: Employee[], o: { kit: string | null; ownKit: string | null; changelog: (kit: string) => Promise<string | null> }): Promise<{ results: EmployeeResult[]; plan: RolloutPlan; beside?: boolean }> {
  // Still bumping beside the rounds: this round leaves the kit to it, and decides nothing.
  if (going) {
    const who = going.names.length === 1 ? going.names[0] : `${going.names.length} employees`;
    const why = `kit ${going.kit}'s rollout to ${who} goes on beside the rounds (started ${ago(Date.now() - going.started)} ago): the rounds go on meanwhile`;
    ctx.log(`rollout: ${why}`);
    return { results: [], plan: { kit: going.kit, why, waitsForSteward: false, bump: [], skip: [] }, beside: true };
  }
  const failed = loadRolloutFailures();
  const before = JSON.stringify(failed);
  // One held for the network or GitHub's own failing (before common.ts's passingFailure knew a 5xx), or for a program
  // missing for a moment that is back (Git updating itself), is let go.
  for (const [id, h] of Object.entries(failed)) if (passingFailure(h.message)) delete failed[id];
  // The newest kit, once it has settled; until then the one rolled out last, to those still behind it. In a build
  // (pipeline.ts), the newest at once: the build is where every kit since the last goes out together, once, and its
  // trial passed the agents as the build finds them, which spares their checks now (trialpass.ts). The kit settling
  // instead, the one before it went to every agent with its checks run, and the next build bumped each one again.
  const settle = ctx.settings.rollout && !ctx.build ? await settledKit(ctx, o.kit, o.changelog) : { kit: o.kit, settling: null, urgent: null };
  const target = settle.kit;
  const settling = settle.settling ? settlingLine(settle.settling, target) : undefined;
  if (settling) ctx.log(`rollout: ${settling}`);
  if (settle.urgent) ctx.log(`rollout: kit ${settle.urgent} is urgent, so kit ${o.kit} goes out now`);
  // A kit newer than this Steward's: its tools/kit.ts read from the kit's release, so nothing waits for the Steward's update.
  let ownKit = o.ownKit;
  let tool: string | undefined;
  if (target && ownKit && ctx.settings.rollout && compareVersions(ownKit, target) < 0) {
    const text = await releasedTool(ctx, target).catch(() => null);
    if (text) {
      tool = path.join(workRootOf(ctx.settings), `_kit-tool-${target}.ts`);
      mkdirSync(path.dirname(tool), { recursive: true });
      writeFileSync(tool, text);
      ctx.log(`rollout: this Steward carries kit ${ownKit}, so each bump hands out the tools/kit.ts released with kit ${target}`);
      ownKit = target;
    }
  }
  const gate = rolloutGate({ on: ctx.settings.rollout, kit: target, ownKit, ...(settling ? { settling } : {}) });
  const facts: Record<string, RolloutFacts> = {};
  // One Manor has retired gets no kit (retired.ts): its branch isn't even looked at.
  const retired = retiredOf(ctx);
  if (!('why' in gate)) {
    for (const e of employees.filter((x) => x.usesKit && !retired.has(x.id))) {
      try {
        facts[e.id] = await withRepo(ctx.log, e.id, () => rolloutFacts(ctx, e, gate.kit));
      } catch (err) {
        ctx.log(`[${e.id}] rollout: couldn't read its branch: ${(err as Error).message}`);
      }
    }
  }
  const plan = planRollout({ on: ctx.settings.rollout, kit: target, ownKit, ...(settling ? { settling } : {}), employees, facts, failed, retired });
  // The newest kit went: the next one settles from here.
  if (plan.kit && plan.kit === o.kit && !settling && loadRolled() !== plan.kit) writeJson(rolloutSettleFile(), { kit: plan.kit, at: new Date().toISOString() } satisfies RolloutSettled);
  if (plan.why) {
    if (plan.waitsForSteward) ctx.log(`rollout: ${plan.why}`);
    if (JSON.stringify(failed) !== before) saveRolloutChanges(JSON.parse(before), failed);
    return { results: [], plan };
  }
  const kit = plan.kit!;
  const results: EmployeeResult[] = [];
  // An employee no longer in Settings is forgotten.
  for (const id of Object.keys(failed)) if (!ctx.settings.employees.some((e) => e.id === id)) delete failed[id];
  // Those it looked at that no longer hold (on the kit now, a newer kit, a new commit): let go.
  for (const s of plan.skip) if (!s.held && s.employee.id in failed) delete failed[s.employee.id];
  for (const s of plan.skip.filter((x) => x.held)) results.push(result(s.employee, 'skipped', `rollout: ${s.why}`));
  if (JSON.stringify(failed) !== before) saveRolloutChanges(JSON.parse(before), failed);
  // The kit PRs left open at this kit, merged now: no one else merges the Steward's PRs.
  for (const m of plan.merge ?? []) {
    const why = await withRepo(ctx.log, m.employee.id, () => mergeOwn(ctx, m.employee, m)).catch((err: Error) => err.message);
    results.push(why ? result(m.employee, 'failed', `rollout: its kit PR #${m.number} at kit ${kit} is open still (${why}): the next build tries again`) : result(m.employee, 'done', `rollout: merged its kit PR #${m.number} (kit ${kit})`));
  }
  if (!plan.bump.length) return { results, plan };
  const names = plan.bump.map((b) => b.employee.name).join(', ');
  // One at a time on this PC: a rollout another process runs (a round in a terminal) has the kit.
  const bumps = (c: Ctx) => withLock(rolloutLock(), () => timed(phaseOf(c), 'rollout', `kit ${kit}`, () => bumpAndPush(c, plan, { kit, changelog: o.changelog, ...(tool ? { tool } : {}) })), { waitMs: 0, staleMs: STAGE_STALE_MS });
  if (beside) {
    ctx.log(`rollout: kit ${kit} for ${names}, beside the rounds: the rounds go on meanwhile`);
    startBeside(ctx, kit, plan.bump.map((b) => b.employee.name), bumps);
    return { results, plan, beside: true };
  }
  ctx.log(`rollout: kit ${kit} for ${names}`);
  try {
    results.push(...(await bumps(ctx)));
  } catch (err) {
    if (!(err instanceof LockTimeout)) throw err;
    ctx.log(`rollout: ${ELSEWHERE}`);
  }
  return { results, plan };
}

/**
 * The rollout's bumps and pushes, for the employees its plan bumps: one result for each (prefixed "rollout: "). What
 * failed is kept in rollout-failed.json, and what went is let go, written over the file as it is when they end.
 */
async function bumpAndPush(ctx: Ctx, plan: RolloutPlan, o: { kit: string; changelog: (kit: string) => Promise<string | null>; tool?: string }): Promise<EmployeeResult[]> {
  const { kit, tool } = o;
  const failed = loadRolloutFailures();
  const before = JSON.stringify(failed);
  const results: EmployeeResult[] = [];
  const heads = new Map(plan.bump.map((b) => [b.employee.id, b.head]));
  const at = new Date().toISOString();
  // The kit's changelog: each bump's entry in the employee's own, and its PR's body.
  let changelog: string | null = null;
  try {
    changelog = await o.changelog(kit);
  } catch {
    // The entry names the kit alone, and the PR's body points at the kit's changelog.
  }
  const folds = Object.fromEntries(plan.bump.filter((b) => b.fold).map((b) => [b.employee.id, b.fold!]));
  // Each bump runs the tests the kit reaches from the kit its branch pins, as the kit's trial did (kitreach.ts), not the
  // whole suite: read from the kit's tag in the Steward's clone. Without the clone, or the tag, each runs them all.
  const clone = stewardClone(ctx);
  const reach = clone
    ? async (_e: Employee, pin: { kit: string; parts: string[] | null }, toolChanged: boolean): Promise<KitReach> =>
        (await releasedTree(ctx, kit)) ? kitReach(ctx, { repo: clone, head: `refs/tags/kit-v${kit}`, pin, toolChanged }) : { all: `kit ${kit}'s release couldn't be read` }
    : undefined;
  const bumped = await bump(ctx, plan.bump.map((b) => b.employee), { kit, changelog, folds, ...(tool ? { tool } : {}), ...(reach ? { reach } : {}) });
  const ready = bumped.filter((r) => r.outcome === 'done');
  for (const r of bumped.filter((x) => x.outcome !== 'done' && x.outcome !== 'skipped')) {
    // One the network cut short (the kit's net.ts) is tried again next round, not held until the branch moves. Held at
    // the commit it was bumped from: a round beside it may have merged into its branch since the plan read its head.
    if (!(await networkFailure(ctx, r.message))) failed[r.id] = { kit, head: (!folds[r.id] && r.base) || heads.get(r.id)!, stage: 'bump', message: r.message, at };
    results.push({ ...r, outcome: 'failed', message: `rollout: bump to kit ${kit}: ${r.message}` });
  }
  for (const r of bumped.filter((x) => x.outcome === 'skipped')) results.push({ ...r, message: `rollout: ${r.message}` });
  if (ready.length) {
    const pushed = await push(ctx, plan.bump.map((b) => b.employee).filter((e) => ready.some((r) => r.id === e.id)), { kit, changelog, folds, merge: true });
    for (const p of pushed) {
      const b = ready.find((r) => r.id === p.id)!;
      if (p.outcome === 'done') {
        delete failed[p.id];
        results.push({ ...p, message: `rollout: kit ${kit}: ${b.message}; ${p.message}`, version: b.version ?? p.version });
      } else if (p.outcome === 'skipped') {
        // A fold whose PR merged or closed meanwhile: nothing failed, and the next round bumps it afresh.
        results.push({ ...p, message: `rollout: ${p.message}` });
      } else {
        if (!(await networkFailure(ctx, p.message))) failed[p.id] = { kit, head: heads.get(p.id)!, stage: 'push', message: p.message, at };
        results.push({ ...p, outcome: 'failed', message: `rollout: push of kit ${kit}: ${p.message} (the bump is ready: ${b.message})` });
      }
    }
  }
  if (JSON.stringify(failed) !== before) saveRolloutChanges(JSON.parse(before), failed);
  return results;
}

/**
 * The bumps and pushes started beside the rounds (rolloutsBeside) as a job of their own, `going` while they run: their
 * lines to `beside.log`, their results kept for the next round to report, and `beside.ended` told when they end.
 */
function startBeside(ctx: Ctx, kit: string, names: string[], bumps: (c: Ctx) => Promise<EmployeeResult[]>): void {
  const log = beside?.log ?? ctx.log;
  const ended = beside?.ended;
  const g: NonNullable<typeof going> = { kit, names, started: Date.now(), done: Promise.resolve() };
  going = g;
  g.done = apart('rollout', () => bumps({ ...ctx, log }))
    .catch((err: Error): EmployeeResult[] => {
      log(`rollout: ${err instanceof LockTimeout ? ELSEWHERE : `kit ${kit}: ${err.message}`}`);
      return [];
    })
    .then((results) => {
      if (going === g) going = null;
      unreported.push(...results);
      const opened = results.filter((r) => r.outcome === 'done').length;
      const failedNow = results.filter((r) => r.outcome === 'failed').length;
      log(`rollout: kit ${kit}'s rollout ended beside the rounds after ${ago(Date.now() - g.started)}: ${opened} PR${opened === 1 ? '' : 's'} opened or updated${failedNow ? `, ${failedNow} failed` : ''}`);
      try {
        ended?.({ kit, results });
      } catch (err) {
        log(`rollout: ${(err as Error).message}`);
      }
    });
}
