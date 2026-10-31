import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { claimsOn, titleVersions } from '../claims.ts';
import { fetchBranch, fetchFor, removeWorktree, showFile } from '../git.ts';
import { hostFor } from '../hosts/index.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { compareVersions } from '../kitfiles.ts';
import { heldBy, pipelineOf } from '../repoconfig.ts';
import type { Employee, Settings } from '../settings.ts';
import { agreedVersion } from '../versions.ts';
import { checksLogOf, duration, type FailedChecks, type TimeLimit } from './bump.ts';
import { checkoutOf, freshWorktree, hostIs, interrupted, networkFailure, workRootOf, type Ctx } from './common.ts';
import { withRepo } from './slots.ts';
import { openPrs, parsePrs, VOUCH_CONTEXT, type PrInfo } from './staff.ts';
import { NO_VERDICT, setVouch, versionTrouble, vouchChecks, vouchOn } from './vouch.ts';
import { vouchLimit } from './vouchtime.ts';

/**
 * Round vouches (Steward 0.36.283): between builds, a round vouches for one of the team's open PRs as `steward vouch`
 * would in its clone (vouch.ts' vouchChecks: the same checks, and for a kit PR of the Steward's own the same kit trial),
 * and a pass sets the same status (VOUCH_CONTEXT) on its head: its author merges it, and the build that releases it
 * doesn't test that code again. It never merges, comments on or pushes to a PR. Through Steward 0.36.118 a round tested
 * PRs on its way to merging them (stages/prtest.ts, gone with the merging in 0.36.119); this is that test alone.
 *
 * Which PR: one an account in Settings' team opened, not a draft, not from a fork, into the branch the Steward releases,
 * in a repository worked through its host's pull requests (never plain git) whose pipeline vouches, and that this PC
 * releases (lease.ts' turns): its head without a team member's vouch, and not tried here before (round-vouches.json, by
 * commit: a new push is tried afresh). Lowest version first, as they merge (roundOrder).
 *
 * Gently: one PR a round (a PC's rounds are one at a time, and its checks run at the checks pace, through the
 * Seneschal where it's here), never within ROUND_VOUCH_LEAD_MS of the next build, and stopped for it: its time limit is
 * the vouch's own (vouchtime.ts) or ROUND_VOUCH_ROOM_MS before the build, whichever comes first. A run cut short for the
 * build, ended by Windows or by the network isn't kept: a later round tries it again.
 *
 * Its head is asked of its host again before the run and before the status is set: a PR that moved on (a push, closed,
 * a draft again) is dropped, and nothing is set or kept. A failure sets nothing; it is kept, so it isn't run every round.
 */

export const roundVouchesFile = () => dataFile('round-vouches.json');
export const roundVouchDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-pr`);

/** No PR is vouched for when the next build is closer than this. */
export const ROUND_VOUCH_LEAD_MS = 15 * 60_000;
/** A round's vouch is stopped this long before the next build, at the latest. */
export const ROUND_VOUCH_ROOM_MS = 5 * 60_000;

/** What a round's vouch of a PR's head came to, kept by commit. */
export interface RoundVouched {
  ok: boolean;
  /** "vouched for: npm test passed in the Steward's round at abc1234", or what failed. */
  note: string;
  at: string;
}

const keyOf = (e: Pick<Employee, 'id'>, pr: Pick<PrInfo, 'number'>, head: string) => `${e.id}#${pr.number}@${head}`;

/** A PR a round may vouch for, and the version it sets (its claim, else its title), if any. */
export interface RoundCandidate {
  e: Employee;
  pr: PrInfo;
  version: string | null;
}

/**
 * The PRs in the order a round vouches for them, as they merge: in each repository first those whose version is above
 * main's, lowest first, then the rest by number; across repositories each one's first before any one's second, in the
 * order the repositories are given. Pure.
 */
export function roundOrder<T extends { e: Pick<Employee, 'id'>; pr: Pick<PrInfo, 'number'>; version: string | null }>(cands: T[], main: (id: string) => string | null): T[] {
  const repos = new Map<string, T[]>();
  for (const c of cands) repos.set(c.e.id, [...(repos.get(c.e.id) ?? []), c]);
  const ranked: { c: T; rank: number; repo: number }[] = [];
  [...repos.values()].forEach((list, repo) => {
    const m = main(list[0].e.id);
    const ahead = (c: T) => !!c.version && (!m || compareVersions(c.version, m) > 0);
    const sorted = [...list].sort((a, b) => {
      if (ahead(a) !== ahead(b)) return ahead(a) ? -1 : 1;
      return (ahead(a) ? compareVersions(a.version!, b.version!) : 0) || a.pr.number - b.pr.number;
    });
    sorted.forEach((c, rank) => ranked.push({ c, rank, repo }));
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.repo - b.repo).map((x) => x.c);
}

export interface RoundVouchOptions {
  /** The next build (pipeline.ts), or null when none is planned. */
  next: Date | null;
  /** The Steward's own repository as an employee, where it releases itself here (steward.ts' selfEmployee). */
  self?: Employee | null;
  /** Of these, the employees whose repositories this PC releases (lease.ts' turns, taken by steward.ts); left out, all. */
  acting?: (es: Employee[]) => Promise<Employee[]>;
  now?: () => Date;
  /** The version on an employee's branch; left out, read from its clone's origin/<branch>. */
  mainVersion?: (e: Employee) => Promise<string | null>;
}

/**
 * A round's vouch between builds, as the module's comment says: lines for the round's log, none when there was nothing
 * to do. Never throws.
 */
export async function roundVouch(ctx: Ctx, o: RoundVouchOptions): Promise<string[]> {
  if (ctx.settings.roundVouches !== true) return [];
  const now = () => (o.now?.() ?? new Date()).getTime();
  const left = () => (o.next ? o.next.getTime() - now() : Infinity);
  try {
    const cands = await candidatesOf(ctx, o);
    if (!cands.length) return [];
    if (left() < ROUND_VOUCH_LEAD_MS) return [`round vouches: none started, the next build is in ${duration(left())}`];
    const mains = new Map<string, string | null>();
    for (const e of new Set(cands.map((c) => c.e))) mains.set(e.id, await (o.mainVersion ?? ((x: Employee) => mainVersionOf(ctx, x)))(e).catch(() => null));
    const ordered = roundOrder(cands, (id) => mains.get(id) ?? null);
    // This PC's repositories only: the turns are taken for those with a PR to vouch for, not every one.
    const acting = new Set((await (o.acting ?? (async (es: Employee[]) => es))([...new Set(ordered.map((c) => c.e))])).map((e) => e.id));
    const kept = readJson<Record<string, RoundVouched>>(roundVouchesFile(), {});
    const team = ctx.settings.team;
    for (const c of ordered) {
      if (!acting.has(c.e.id) || kept[keyOf(c.e, c.pr, c.pr.headOid)]) continue;
      const by = await vouchOn(ctx, c.e, c.pr.headOid, team).catch(() => null);
      if (by) {
        keep(c, { ok: true, note: `${by} vouched for ${c.pr.headOid.slice(0, 7)}`, at: new Date().toISOString() });
        continue;
      }
      return [await vouchOne(ctx, c, left)];
    }
    return [];
  } catch (err) {
    return [`round vouches: ${(err as Error).message}`];
  }
}

/** The team's PRs a round may vouch for, from the employees that may be vouched for here. */
async function candidatesOf(ctx: Ctx, o: RoundVouchOptions): Promise<RoundCandidate[]> {
  const out: RoundCandidate[] = [];
  const self = o.self && !ctx.settings.employees.some((e) => e.id === o.self!.id) ? [o.self] : [];
  for (const e of [...ctx.settings.employees, ...self]) {
    if (!e.test.length || !e.checkout || !existsSync(checkoutOf(e)) || hostIs(ctx, e) === 'git') continue;
    const p = pipelineOf(e);
    if (heldBy(p) || !p.vouch) continue;
    const prs = await prsOf(ctx, e);
    for (const pr of prs) {
      if (pr.whose !== 'team' || pr.draft || pr.fork || pr.base !== e.branch || !pr.headOid) continue;
      const claimed = claimsOn(e.repo).find((x) => x.branch === pr.head)?.version;
      out.push({ e, pr, version: claimed ?? titleVersions(e.name, [pr.title])[0] ?? null });
    }
  }
  return out;
}

/**
 * An employee's open PRs: from this round's glance at GitHub where it has them, else from the staff's table as it was
 * last made (staffRow asks the host there), so a round asks nothing more of a host than it did. Either may be a little
 * behind; the PR's head is asked of its host before it's run.
 */
async function prsOf(ctx: Ctx, e: Employee): Promise<PrInfo[]> {
  const g = ctx.glance?.repos[e.id];
  if (g) return parsePrs(JSON.stringify(g.prs), ctx.settings.team);
  const rows = readJson<{ rows?: { id: string; prs?: PrInfo[] }[] } | null>(dataFile('staff.json'), null)?.rows ?? [];
  const row = rows.find((r) => r.id === e.id);
  if (row) return row.prs ?? [];
  return parsePrs(await openPrs(hostFor(ctx, e), e.repo), ctx.settings.team);
}

/** The version its version files agree on at origin/<branch> in its clone, or null. */
async function mainVersionOf(ctx: Ctx, e: Employee): Promise<string | null> {
  if (!e.versionFiles.length) return null;
  const at = await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(ctx.run, checkoutOf(e), `origin/${e.branch}`, f)] as [string, string | null]));
  const v = agreedVersion(at);
  return 'version' in v ? v.version : null;
}

function keep(c: RoundCandidate, r: RoundVouched): void {
  const all = readJson<Record<string, RoundVouched>>(roundVouchesFile(), {});
  all[keyOf(c.e, c.pr, c.pr.headOid)] = r;
  writeJson(roundVouchesFile(), Object.fromEntries(Object.entries(all).slice(-500)));
}

/** The PR's state as its host says now, or why it can't be vouched for now (moved on, closed, a draft, a fork). */
async function stillAt(ctx: Ctx, c: RoundCandidate): Promise<string | null> {
  const v = await hostFor(ctx, c.e).viewPr(c.e.repo, String(c.pr.number), 'number,state,headRefOid,isDraft,isCrossRepository');
  if (v.code !== 0) return `its host couldn't say how it is now: ${(v.err || v.out).trim().split('\n').pop()}`;
  let pr: { state?: string; headRefOid?: string; isDraft?: boolean; isCrossRepository?: boolean };
  try {
    pr = JSON.parse(v.out);
  } catch {
    return "its host's answer couldn't be read";
  }
  if (pr.state !== 'OPEN') return `it is ${String(pr.state ?? 'not open').toLowerCase()} now`;
  if (pr.isDraft) return 'it is a draft now';
  if (pr.isCrossRepository) return 'it is from a fork';
  if (pr.headRefOid !== c.pr.headOid) return `its head moved on to ${String(pr.headRefOid ?? '').slice(0, 7)}`;
  return null;
}

/** One PR's head vouched for here, under its repository's lock: a line for the log. */
async function vouchOne(ctx: Ctx, c: RoundCandidate, left: () => number): Promise<string> {
  const { e, pr } = c;
  const head = pr.headOid;
  const sha = head.slice(0, 7);
  const tag = `[${e.id}] round vouch of #${pr.number} at ${sha}`;
  const moved = await stillAt(ctx, c);
  if (moved) return `${tag}: not started, ${moved}`;
  return withRepo(ctx.log, e.id, async () => {
    const { run } = ctx;
    const repo = checkoutOf(e);
    await fetchBranch(run, repo, e.branch);
    await fetchFor(run, repo, head, `+refs/heads/${pr.head}:refs/remotes/origin/${pr.head}`);
    const dir = roundVouchDirOf(ctx.settings, e);
    await removeWorktree(run, repo, dir);
    rmSync(checksLogOf(dir), { force: true });
    await freshWorktree(run, ctx.settings, repo, dir, head, '--detach');
    const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
    try {
      const versions = await versionTrouble(ctx, e, { dir, head, branch: pr.head, say });
      if (versions) {
        keep(c, { ok: false, note: versions, at: new Date().toISOString() });
        return `${tag}: ${versions}. Nothing was run or set`;
      }
      say(`#${pr.number} at ${sha}: its checks, as steward vouch runs them, in ${dir}`);
      // The vouch's own limit, or the build's, whichever is first; which one cut it says whether it is kept.
      let forBuild = false;
      const timeLimit = (kind: Parameters<typeof vouchLimit>[1], files?: number): TimeLimit | null => {
        const own = vouchLimit(e.id, kind, { files });
        const build = left() - ROUND_VOUCH_ROOM_MS;
        forBuild = Number.isFinite(build) && (!own || build < own.ms);
        return forBuild ? { ms: Math.max(0, build), why: `${duration(ROUND_VOUCH_ROOM_MS)} before the next build` } : own;
      };
      const stop = () => (left() < ROUND_VOUCH_ROOM_MS ? 'stopped for the next build' : null);
      const task = { pr: pr.number, branch: pr.head };
      const where = " in the Steward's round";
      const seen: FailedChecks = {};
      let r = await vouchChecks(ctx, e, { dir, head, say, timeLimit, task, failed: seen, elsewhere: true, where, stop });
      const cut = () => (seen.timedOut && forBuild) || !!stop();
      // Once more, as a build's test of main is (mainbuild.ts): not after a failure two PCs agree on, a time limit, or a kit's trial.
      if ('failed' in r && !cut() && seen.step && !seen.confirmed && !seen.timedOut) {
        say(`#${pr.number} at ${sha}: its checks once more (${r.failed})`);
        const again: FailedChecks = {};
        r = await vouchChecks(ctx, e, { dir, head, say, timeLimit, task, failed: again, where, stop });
        if ('failed' in r) r = { failed: `twice: ${r.failed}` };
        Object.assign(seen, again);
      }
      if ('failed' in r) {
        // Cut short for the build, by Windows, or by the network: no verdict on the PR, so a later round tries it again.
        if (cut()) return `${tag}: stopped for the next build, not kept: a round after it tries again`;
        if (interrupted(r.failed) || r.failed.includes(NO_VERDICT) || (await networkFailure(ctx, r.failed))) return `${tag}: cut short (${r.failed.slice(0, 200)}), not kept: a later round tries again`;
        keep(c, { ok: false, note: r.failed.slice(0, 500), at: new Date().toISOString() });
        return `${tag}: its checks failed: ${r.failed}. Nothing was set; a new push is tried afresh`;
      }
      const gone = await stillAt(ctx, c);
      if (gone) return `${tag}: its checks passed, but ${gone}: nothing was set`;
      // Its turn may have gone to another PC while it ran (lease.ts): that PC vouches for it, then.
      if (ctx.lease && !(await ctx.lease.ok(e))) return `${tag}: its checks passed, but another PC releases ${e.name} now: nothing was set`;
      const refused = await setVouch(ctx, e, e.repo, head, r.description);
      // Not kept: the next round finds the same tree's pass, so it isn't run again, and sets the status then.
      if (refused) return `${tag}: ${refused}`;
      keep(c, { ok: true, note: `vouched for: ${r.description}`, at: new Date().toISOString() });
      return `${tag}: ${r.description}, and ${hostFor(ctx, e).name} has it (${VOUCH_CONTEXT}): ${pr.author} merges it`;
    } finally {
      try {
        await removeWorktree(run, repo, dir);
      } catch (err) {
        ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
      }
    }
  });
}
