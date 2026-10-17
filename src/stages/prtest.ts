import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf, fetchBranch, fetchFor, git, removeWorktree, showFile } from '../git.ts';
import { compareVersions, KIT_VERSION } from '../kitfiles.ts';
import { latestKit } from '../kitsource.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee, Settings } from '../settings.ts';
import { runChecks, type AffectedScope, type FailedChecks } from './bump.ts';
import { checkoutOf, freshWorktree, interrupted, workRootOf, type Ctx } from './common.ts';
import { authorOf, type Author } from './kickback.ts';
import { deadKitIn, KIT_VERSION_FILE, kitTitleVersions, NEVER_RELEASED } from './kitpart.ts';
import { openPrs, parsePrs, readPin, VOUCH_CONTEXT, type PrInfo } from './staff.ts';
import { setVouch, stoodInDescription, vouchDescription } from './vouch.ts';
import type { StoodIn } from './standin.ts';
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

/** How the hold of a PR whose kit isn't released begins when no open PR of the Steward's brings it. */
const PINS_KIT = 'pins kit ';

/** Whether a PR waits for its kit's release (kitReleaseHold), whether or not an open PR of the Steward's brings that kit. */
export const waitsForKit = (why: string) => why.startsWith(KIT_WAIT) || why.startsWith(PINS_KIT);

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
            await fetchFor(ctx.run, checkout, p.headOid, `refs/pull/${p.number}/head`);
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
 * (a PR made beside the Steward's own that raises the kit), so its fill would fail. A vouched PR is held too (merge.ts):
 * a vouch is for its checks, not its kit. It isn't tested, so nothing is held
 * against its commit (no "failed twice"), and it keeps its place in the version line. Its hold names the open Steward
 * PR that brings that kit ("waits for kit 2.42.0, which Steward#126 brings: it merges once that's released"), and
 * whether it passed with that kit in the kit's trial (trial.ts's pairs); or says that none brings it, a real problem.
 * None bringing it, while a release or the Steward's main is past it already (kitPast), it says that kit will never be
 * released, and what to do (NEVER_RELEASED): an alarm at once (alarms.ts), and a word on the PR to its author
 * (tellDeadKit). It is tested once that kit is released (the round releases the Steward's kit before the agents' merges,
 * or in a build beside them, then looks at those that waited for it again: steward.ts).
 * Null when the kit's releases couldn't be read, or its pin can't: then it is tested as before.
 */
export async function kitReleaseHold(ctx: Ctx, e: Employee, pr: PrInfo): Promise<string | null> {
  if (!e.usesKit || !e.fill || !pr.headOid || !ctx.kit?.released.length) return null;
  const repo = checkoutOf(e);
  await fetchFor(ctx.run, repo, pr.headOid, hostFor(ctx, e).prRef(pr));
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
  if (!brings) {
    const past = await kitPast(ctx, pin.kit, where);
    if (past) return `${PINS_KIT}${pin.kit}${NEVER_RELEASED}${past}, and no open ${where} PR brings it. Keep ${e.branch}'s pin in kit.json: once a build releases its kit, the rollout pins it on ${e.branch}, and the Steward's catch-up brings it to this PR`;
    return `${PINS_KIT}${pin.kit}, which isn't released, and no open ${where} PR brings it: release that kit, or pin a released one`;
  }
  const pair = readJson<Record<string, KitTrial>>(kitTrialsFile(), {})[`${brings.number}@${brings.headOid}`]?.pairs?.find((p) => p.id === e.id && p.number === pr.number && p.head === pr.headOid);
  const tried = pair?.ok ? ' (it passes with that kit here)' : '';
  const draft = brings.draft ? ` (#${brings.number} is a draft)` : '';
  return `${KIT_WAIT}${pin.kit}, which ${where}#${brings.number} brings: it merges once that's released${tried}${draft}`;
}

const mainKitLooked = new WeakMap<Ctx, Promise<string | null>>();

/**
 * The kit on the Steward's main (kit/VERSION at origin/main), as its checkout here last fetched it: nothing is fetched
 * for it, and it is read once per stage. Null without a checkout, or where it can't be read.
 */
function stewardMainKit(ctx: Ctx): Promise<string | null> {
  let looked = mainKitLooked.get(ctx);
  if (!looked) {
    const checkout = ctx.settings.stewardCheckout;
    looked =
      checkout && existsSync(path.join(checkout, '.git'))
        ? showFile(ctx.run, checkout, 'origin/main', KIT_VERSION_FILE).then(
            (v) => (v && KIT_VERSION.test(v.trim()) ? v.trim() : null),
            () => null,
          )
        : Promise.resolve(null);
    mainKitLooked.set(ctx, looked);
  }
  return looked;
}

/**
 * How a kit with no release is past already, or null: a newer kit is released, or the Steward's main has a newer one.
 * A kit is released from main, and main's only goes up, so that kit never will be. A build releases one kit, the top of
 * the stack of every kit PR ready then (Steward 0.36.70, trial.ts's combineKits), so most kits main has had are skipped:
 * 2.76.0, 2.77.9 and 2.78.0 to 2.78.3 were. Manor#276 pinned 2.78.3, main's kit then, on 2026-10-16.
 */
async function kitPast(ctx: Ctx, kit: string, where: string): Promise<string | null> {
  const newest = latestKit(ctx.kit);
  if (newest && compareVersions(newest, kit) > 0) return `kit ${newest} is released already`;
  const main = await stewardMainKit(ctx);
  return main && compareVersions(main, kit) > 0 ? `${where}'s main has kit ${main} already` : null;
}

/** The PRs told that their kit.json pins a kit that will never be released (tellDeadKit), by `<repo>#<number>`. */
export const deadKitsFile = () => dataFile('dead-kits.json');

interface ToldDeadKit {
  head: string;
  kit: string;
  at: string;
}

/** The comment on a PR whose kit.json pins a kit that will never be released: `why` is its hold (kitReleaseHold). Pure. */
export function deadKitComment(pr: Pick<PrInfo, 'author' | 'draft'>, branch: string, why: string, author: Author): string {
  const who = author === 'claude' ? 'Over to the Claude Code session that opened it' : `Over to you, @${pr.author}`;
  return [
    `**The Steward can't merge this:** it ${why}.`,
    '',
    `A build releases one kit, the top of the stack of every kit PR ready then, so most kit versions the Steward's main has had are never released. A PR that pins one waits for good${pr.draft ? ', once it is marked ready' : ''}.`,
    '',
    `${who}: put \`kit.json\` back as \`${branch}\` has it, and push (a merge commit, never a force-push). To try a kit that isn't released, fill it from its tree (\`node tools/kit.ts --from <Steward checkout>\\kit\`) and leave the pin uncommitted. The Steward says this once for each commit.`,
  ].join('\n');
}

/**
 * Tells a PR's author, in a comment on it, that its kit.json pins a kit that will never be released (`why`, its hold
 * from kitReleaseHold), once for its head: a hold alone said nothing to them, and its alarm waited a day. A new push
 * that still pins one is told again; one that couldn't be told is tried again next round. The line it logged, or null
 * when this head was told before.
 */
export async function tellDeadKit(ctx: Ctx, e: Employee, pr: PrInfo, why: string): Promise<string | null> {
  const key = `${e.repo}#${pr.number}`;
  const kept = readJson<Record<string, ToldDeadKit>>(deadKitsFile(), {});
  if (kept[key]?.head === pr.headOid) return null;
  const kit = deadKitIn(why) ?? '';
  const r = await hostFor(ctx, e).commentPr(e.repo, pr.number, deadKitComment(pr, e.branch, why, authorOf(pr)));
  const failed = r.code === 0 ? null : (r.err || r.out).trim().split('\n').pop() || `exit ${r.code}`;
  const line = `#${pr.number} pins kit ${kit}, which will never be released: ${failed ? `the Steward couldn't say so on it (${failed})` : 'its author was told, in a comment on it'}`;
  ctx.log(`[${e.id}] ${line}`);
  if (failed) return line;
  kept[key] = { head: pr.headOid, kit, at: new Date().toISOString() };
  writeJson(deadKitsFile(), Object.fromEntries(Object.entries(kept).slice(-300)));
  return line;
}

export async function testAtHead(ctx: Ctx, e: Employee, pr: PrInfo): Promise<Tested> {
  const before = testedBefore(e, pr);
  const newest = latestKit(ctx.kit);
  if (before && kitMayClear(e, before, newest)) ctx.log(`[${e.id}] #${pr.number} failed at its kit's fill before kit ${newest} was released: tested here again`);
  // Its checks ended by Windows (the PC shutting down: common.ts's interrupted) didn't fail: tested again.
  else if (before && !before.ok && interrupted(before.note)) ctx.log(`[${e.id}] #${pr.number}'s checks were ended by Windows before: tested here again`);
  else if (before) return before;
  if (!pr.headOid) return { ok: false, note: "GitHub didn't say its head commit, so it wasn't tested here", at: new Date().toISOString() };
  const tested = { ...(await test(ctx, e, pr)), ...(newest ? { kit: newest } : {}) };
  // Ended by Windows: not kept, so the next round tests it again.
  if (!tested.ok && interrupted(tested.note)) return tested;
  // Kept by commit, a "can't" too; the oldest go once there are more than 500.
  const kept = readJson<Record<string, Tested>>(prChecksFile(), {});
  kept[keyOf(e, pr)] = tested;
  writeJson(prChecksFile(), Object.fromEntries(Object.entries(kept).slice(-500)));
  // Passed here before it merges: the Surveyor's GET /api/tested (tested.ts).
  if (tested.ok) recordTested(e.id, { commit: pr.headOid, stage: 'merge', branch: pr.head, pr: pr.number, at: tested.at });
  return tested;
}

/**
 * carryTested, and the vouch set on the new head too (a team PR from the repository itself), as vouchedHere does for a
 * pass here: a catch-up's or a stamp's head that changed only version lines and changelogs carries this PC's standing,
 * and without the vouch on GitHub the Assayer would install and test it again. A status GitHub won't take is only a line
 * in the log.
 */
export async function carryVouched(ctx: Ctx, e: Employee, pr: PrInfo, head: string, why: string): Promise<Tested> {
  const tested = carryTested(e, pr, head, why);
  if (pr.whose !== 'team' || pr.fork) return tested;
  const description = `checks passed at ${pr.headOid.slice(0, 7)}, carried to ${head.slice(0, 7)} (only versions and changelogs changed)`;
  const refused = await setVouch(ctx, e, e.repo, head, description);
  ctx.log(`[${e.id}] #${pr.number}: ${refused ?? `its new head ${head.slice(0, 7)} has the vouch (${VOUCH_CONTEXT}) carried from ${pr.headOid.slice(0, 7)}`}`);
  return tested;
}

/**
 * A team PR from the repository itself that passed here gets the vouch on its head, as `steward vouch` sets it
 * (vouch.ts's setVouch): the Assayer vouches for any team PR head without one, and would otherwise install and test it a
 * second time. A failure sets nothing, and a status GitHub won't take is only a line in the log: the result stands.
 */
async function vouchedHere(ctx: Ctx, e: Employee, pr: PrInfo, scope: AffectedScope | undefined, tested: Tested, description?: string): Promise<Tested> {
  if (pr.whose !== 'team' || pr.fork || !pr.headOid) return tested;
  const why = await setVouch(ctx, e, e.repo, pr.headOid, description ?? vouchDescription(e, scope, pr.headOid, " in the Steward's test"));
  ctx.log(`[${e.id}] #${pr.number}: ${why ?? `its head ${pr.headOid.slice(0, 7)} has the vouch (${VOUCH_CONTEXT}), so it isn't tested again elsewhere`}`);
  return tested;
}

/**
 * A PR of the Steward's own that raises its kit, tested between builds for the next one (stages/prepare.ts): its whole
 * suite, not only what its change reaches. A kit PR's change reaches most of the suite anyway, and a whole pass is kept
 * by its tree (whole.ts), so the gate before the kit's release (stages/wholesuite.ts), on the same tree once merged up to
 * date, isn't run again inside the build: on 2026-10-16 that gate took 14 to 35 minutes of the 08:00 build.
 */
export const wholeAhead = (ctx: Pick<Ctx, 'build' | 'prepare'>, e: Pick<Employee, 'id'>, pr: PrInfo): boolean => ((!!ctx.prepare && !ctx.build) || !!ctx.build?.ahead) && e.id === APP.id && raisesKit(pr);

async function test(ctx: Ctx, e: Employee, pr: PrInfo): Promise<Tested> {
  const now = () => new Date().toISOString();
  if (!e.test.length) return { ok: false, note: `Settings give ${e.name} no checks to test it with`, at: now() };
  const { run } = ctx;
  const repo = checkoutOf(e);
  const sha = pr.headOid.slice(0, 7);
  await fetchFor(run, repo, pr.headOid, hostFor(ctx, e).prRef(pr));
  await fetchBranch(run, repo, e.branch);
  const branch = (await commitOf(run, repo, `origin/${e.branch}`)) ?? undefined;
  const dir = prDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, pr.headOid, '--detach');
  ctx.log(`[${e.id}] #${pr.number} has no checks on GitHub: testing it here at ${sha}, in ${dir}`);
  try {
    const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
    // Only the tests its change reaches (affected.ts), unless Settings say the whole suite, or it is wholeAhead.
    const scope: AffectedScope | undefined = ctx.settings.affectedTests === false || wholeAhead(ctx, e, pr) ? undefined : { base: `origin/${e.branch}` };
    const affected = scope ? { affected: scope } : {};
    const stoodIn: StoodIn = {};
    const seen: FailedChecks = {};
    const task = { pr: pr.number, branch: pr.head };
    // A failure here is tried once more on another PC on the licence, where the Seneschal has one (bump.ts' elsewhere).
    const failed = await runChecks(ctx, e, dir, { say, ...affected, doing: `#${pr.number}'s checks at ${sha}`, stoodIn, task, failed: seen, elsewhere: true });
    // A pass of exactly this code stood in (standin.ts): said as whose, and vouched for as such.
    if (!failed && stoodIn.by) {
      const note = stoodIn.flaky ? `checks failed here at ${sha} and passed ${stoodIn.where}: this PC's failure, not the change's (${stoodIn.flaky})` : `checks passed ${stoodIn.where} at ${sha}, not run again`;
      return await vouchedHere(ctx, e, pr, scope, { ok: true, note, at: now(), branch }, stoodInDescription(e, stoodIn, pr.headOid));
    }
    const which = scope?.chose && scope.chose !== 'the whole suite' ? ` (${scope.chose})` : '';
    if (!failed) return await vouchedHere(ctx, e, pr, scope, { ok: true, note: `checks passed here at ${sha}${which}`, at: now(), branch });
    // Failed on two PCs: the change's failure, not tried a third time.
    if (seen.confirmed) return { ok: false, note: `its checks failed at ${sha}: ${failed}`, at: now(), branch };
    say(`#${pr.number}: its checks once more (${failed})`);
    const again = await runChecks(ctx, e, dir, { say, ...affected, doing: `#${pr.number}'s checks at ${sha}`, task });
    return again
      ? { ok: false, note: `its checks failed here at ${sha}, twice: ${again}`, at: now(), branch }
      : await vouchedHere(ctx, e, pr, scope, { ok: true, note: `checks passed here at ${sha} on a second try (the first: ${failed})`, at: now(), branch });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
