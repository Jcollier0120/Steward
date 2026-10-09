import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { commitOf, fetchBranch, git, removeWorktree, showFile } from '../git.ts';
import { latestKit } from '../kitsource.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee, Settings } from '../settings.ts';
import { runChecks, type AffectedScope } from './bump.ts';
import { checkoutOf, workRootOf, type Ctx } from './common.ts';
import { KIT_VERSION_FILE, kitTitleVersions } from './kitpart.ts';
import { openPrs, parsePrs, readPin, type PrInfo } from './staff.ts';
import { kitTrialsFile, raisesKit, type KitTrial } from './trial.ts';
import { recordTested } from '../tested.ts';
import { hostFor } from '../hosts/index.ts';

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
  /** The head it was carried from (carryTested): this commit itself wasn't tested, the one before its catch-up was. */
  carried?: string;
}

const keyOf = (e: Employee, pr: PrInfo, head = pr.headOid) => `${e.id}#${pr.number}@${head}`;

/** What testing this PR's head here said before, if it has been. */
export const testedBefore = (e: Employee, pr: PrInfo): Tested | null => (pr.headOid ? (readJson<Record<string, Tested>>(prChecksFile(), {})[keyOf(e, pr)] ?? null) : null);

/**
 * A PR's standing carried to the head its catch-up pushed (catchup.ts), where the catch-up changed nothing of its own
 * but version lines and changelogs (keepsStanding): `why` says what passed at the head before ("checks passed here at
 * abc1234", "… vouched for"), and the new head is then taken as tested (testAtHead returns it), so it merges without
 * its checks run again. The same trust a PR only behind its branch gets: its tested head merged with what the branch
 * gained. Not recorded for the Surveyor (tested.ts): nothing ran at the new head.
 */
export function carryTested(e: Employee, pr: PrInfo, head: string, why: string, now = new Date()): Tested {
  const was = testedBefore(e, pr);
  const tested: Tested = {
    ok: true,
    note: `${why}; carried to ${head.slice(0, 7)}, as its catch-up changed only version lines and the changelog`,
    at: now.toISOString(),
    ...(was?.branch ? { branch: was.branch } : {}),
    ...(was?.kit ? { kit: was.kit } : {}),
    carried: pr.headOid,
  };
  const kept = readJson<Record<string, Tested>>(prChecksFile(), {});
  kept[keyOf(e, pr, head)] = tested;
  writeJson(prChecksFile(), Object.fromEntries(Object.entries(kept).slice(-500)));
  return tested;
}

/**
 * Whether a failure here may be cleared by a kit released since: it failed at the kit's fill (tools/kit.ts), and the
 * newest kit released now isn't the one it was tested beside (one tested before 0.27.38 kept none). Manor#135 failed
 * at its fill for a kit not yet released, and waited for ever, with the PRs above it. A PR whose pinned kit still isn't
 * released isn't tested again yet: kitReleaseHold holds it first, so it is tested again once its kit exists. Pure.
 */
export const kitMayClear = (e: Employee, t: Tested, newest: string | null) => !t.ok && !!e.fill && t.note.includes(`: ${e.fill} failed`) && !!newest && t.kit !== newest;

/** How the hold of a PR whose kit isn't released yet begins, when it waits for it (not when nothing brings it). */
export const KIT_WAIT = 'waits for kit ';

/** An open PR to the Steward's own repository that raises the kit, and the kit version it brings (null when unread). */
export interface KitPr {
  number: number;
  headOid: string;
  draft: boolean;
  kit: string | null;
}

const kitPrsLooked = new WeakMap<Ctx, Promise<KitPr[]>>();

/**
 * The open PRs to the Steward's own repository that raise the kit (kit/VERSION among their files), each with the kit
 * version at its head: from its kit trial (trial.ts, kept by head commit), else the Steward's checkout here, else its
 * title ("Steward 0.27.39, kit 2.42.0: …"). Asked of GitHub once per stage. Throws when they can't be listed.
 */
export function openKitPrs(ctx: Ctx): Promise<KitPr[]> {
  let looked = kitPrsLooked.get(ctx);
  if (!looked) {
    looked = (async () => {
      const repo = ctx.settings.stewardRepo;
      if (!repo) return [];
      const trials = readJson<Record<string, KitTrial>>(kitTrialsFile(), {});
      const checkout = ctx.settings.stewardCheckout && existsSync(path.join(ctx.settings.stewardCheckout, '.git')) ? ctx.settings.stewardCheckout : null;
      const out: KitPr[] = [];
      for (const p of parsePrs(await openPrs(hostFor(ctx), repo), ctx.settings.team)) {
        if (p.fork || !raisesKit(p)) continue;
        let kit: string | null = trials[`${p.number}@${p.headOid}`]?.kit ?? null;
        if (!kit && checkout && p.headOid) {
          try {
            await git(ctx.run, checkout, 'fetch', '--quiet', 'origin', `refs/pull/${p.number}/head`);
            kit = (await showFile(ctx.run, checkout, p.headOid, KIT_VERSION_FILE))?.trim() || null;
          } catch {
            kit = null;
          }
        }
        kit ??= kitTitleVersions([p.title])[0] ?? null;
        out.push({ number: p.number, headOid: p.headOid, draft: p.draft, kit });
      }
      return out;
    })();
    kitPrsLooked.set(ctx, looked);
  }
  return looked;
}

/**
 * Why a PR on the kit waits before it is tested here, or null: the kit its kit.json pins at its head has no release yet
 * (a PR made beside the Steward's own that raises the kit), so its fill would fail. It isn't tested, so nothing is held
 * against its commit (no "failed twice"), and it keeps its place in the version line. Its hold names the open Steward
 * PR that brings that kit ("waits for kit 2.42.0, which Steward#126 brings: it merges once that's released"), and
 * whether it passed with that kit in the kit's trial (trial.ts's pairs); or says that none brings it, a real problem.
 * It is tested once that kit is released (the round releases the Steward's kit before the agents' merges: steward.ts).
 * Null when the kit's releases couldn't be read, or its pin can't: then it is tested as before.
 */
export async function kitReleaseHold(ctx: Ctx, e: Employee, pr: PrInfo): Promise<string | null> {
  if (!e.usesKit || !e.fill || !pr.headOid || !ctx.kit?.released.length) return null;
  const repo = checkoutOf(e);
  await git(ctx.run, repo, 'fetch', '--quiet', 'origin', hostFor(ctx, e).prRef(pr.number));
  const pin = readPin(await showFile(ctx.run, repo, pr.headOid, 'kit.json'));
  if (!pin || ctx.kit.released.includes(pin.kit)) return null;
  let prs: KitPr[];
  try {
    prs = await openKitPrs(ctx);
  } catch (err) {
    ctx.log(`[${e.id}] #${pr.number} pins kit ${pin.kit}, not released: couldn't list the Steward's open PRs to see which brings it: ${(err as Error).message}`);
    return `${KIT_WAIT}${pin.kit}, which isn't released yet: it is tested here once it is`;
  }
  const where = ctx.settings.stewardRepo.split('/').pop() || 'Steward';
  const brings = prs.find((p) => p.kit === pin.kit);
  if (!brings) return `pins kit ${pin.kit}, which isn't released, and no open ${where} PR brings it: release that kit, or pin a released one`;
  const pair = readJson<Record<string, KitTrial>>(kitTrialsFile(), {})[`${brings.number}@${brings.headOid}`]?.pairs?.find((p) => p.id === e.id && p.number === pr.number && p.head === pr.headOid);
  const tried = pair?.ok ? ' (it passes with that kit here)' : '';
  const draft = brings.draft ? ` (#${brings.number} is a draft)` : '';
  return `${KIT_WAIT}${pin.kit}, which ${where}#${brings.number} brings: it merges once that's released${tried}${draft}`;
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
  await git(run, repo, 'fetch', '--quiet', 'origin', hostFor(ctx, e).prRef(pr.number));
  await fetchBranch(run, repo, e.branch);
  const branch = (await commitOf(run, repo, `origin/${e.branch}`)) ?? undefined;
  const dir = prDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, pr.headOid);
  ctx.log(`[${e.id}] #${pr.number} has no checks on GitHub: testing it here at ${sha}, in ${dir}`);
  try {
    const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
    // Only the tests its change reaches (affected.ts), unless Settings say the whole suite.
    const scope: AffectedScope | undefined = ctx.settings.affectedTests === false ? undefined : { base: `origin/${e.branch}` };
    const affected = scope ? { affected: scope } : {};
    const failed = await runChecks(ctx, e, dir, { say, ...affected });
    const which = scope?.chose && scope.chose !== 'the whole suite' ? ` (${scope.chose})` : '';
    if (!failed) return { ok: true, note: `checks passed here at ${sha}${which}`, at: now(), branch };
    say(`#${pr.number}: its checks once more (${failed})`);
    const again = await runChecks(ctx, e, dir, { say, ...affected });
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
