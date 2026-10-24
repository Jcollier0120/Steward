import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { releasesRepoEnv, TAG_RELEASE, type Employee } from '../settings.ts';
import { checkoutOf, glanceOf, mapLimit, networkFailure, releasedOf, releaseDirOf, result, type Ctx, type EmployeeResult } from './common.ts';
import { releaseOne } from './release.ts';
import { keptSigningDown, loadSigningAhead, loadSigningWaits, needsSigning, noteSigningAhead, noteSigningWaits, signingProblem, signsWith, type SigningAhead, type SigningWait } from '../signing.ts';
import type { BuildRun } from '../pipeline.ts';
import { commitOf, fetchBranch, showFile } from '../git.ts';
import { agreedVersion } from '../versions.ts';
import { clearTastingHold } from '../tasting.ts';
import { takeFreshStart } from '../fresh-start.ts';
import { withRepo } from './slots.ts';
import { mainGate } from './mainbuild.ts';
import { RETIRED, retiredOf } from '../retired.ts';

/**
 * The Steward's round (`steward round`, and on duty every few minutes when Settings say it releases by itself): at a
 * build (pipeline.ts), the Steward's own new versions (stages/self.ts), a new kit rolled out to each employee behind it
 * (stages/rollout.ts), and a release for every employee whose branch carries a version with no GitHub release yet,
 * whatever kit it pins, its commit tested once first unless a vouch covers it (stages/mainbuild.ts). The Steward merges
 * no one's PRs: their authors do. A round with nothing done or failed is not recorded: last-stage.json and stages.log
 * keep what last happened.
 *
 * A release that fails isn't tried again at the same commit, round after round: the commit is kept in
 * round-failed.json, and the round says so until a person releases it (Release on the page, or `steward
 * release`), or a new commit on the branch is tried afresh. Not one that waits until this PC can sign (signing.ts):
 * nothing failed, and the round after the key can be reached releases it.
 */

export const roundFailuresFile = () => dataFile('round-failed.json');

/**
 * How many of a build's releases run at once (Steward 0.36.67): Settings' parallel, or a third of this PC's processors up
 * to 6, whichever is more. A build's releases are the last thing it waits for, and most of each is GitHub's upload and
 * the release's own build at the checks' pace; two at a time, today's 33 releases took a quarter of an hour. Pure.
 */
export const buildReleaseLimit = (parallel: number, cpus = os.availableParallelism()): number => Math.max(1, parallel, Math.min(6, Math.floor(cpus / 3)));

/**
 * The certificate a release signs what it builds with (signing.ts's signsWith), as its checkout's kit.json and tools/sign.ts
 * say now; null: none. `castellan`: this PC releases Castellan, where a kit that signs its scripts signs with the owner's.
 */
export function signerHere(e: Employee, castellan = false): string | null {
  if (e.release === TAG_RELEASE) return null;
  const dir = checkoutOf(e);
  const read = (f: string) => {
    try {
      return readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return null;
    }
  };
  return signsWith({ kitJson: read('kit.json'), signTs: read(path.join('tools', 'sign.ts')), release: e.release, castellan });
}

/**
 * Whether a release signs what it builds every time, as its checkout says now (signerHere): its native files or Manor's
 * setup. Scripts aren't counted: most releases take their signed copies (the kit's signed-scripts.ts), so their releases
 * needn't wait in the signing lane.
 */
export const signsHere = (e: Employee): boolean => !!signerHere(e);

/** How long after a signing build began its releases wait for another: one that met the key gone again waits this long. */
export const SIGNED_AGAIN_MS = 15 * 60_000;

/**
 * Between builds, the releases that wait until this PC can sign (signing.ts), looked at again (Steward 0.36.161): the
 * ids of those that can be released now, for a build of their own at once (pipeline.ts's `signed`), rather than at the
 * next build time. A waiting version released since (by a person, or another PC) is forgotten, and so is one of an
 * employee Settings no longer have. For the rest, one look per certificate, the timestamped test signature that
 * signingProblem shares within a minute: nothing is built to find out. A wait whose reason changed keeps the new one, for
 * the alarm. Not one whose signing build began within SIGNED_AGAIN_MS. Never throws for one employee.
 */
export async function signedBetween(ctx: Ctx, employees: Employee[], builds: BuildRun[], now = new Date()): Promise<string[]> {
  const waits = loadSigningWaits();
  if (!Object.keys(waits).length) return [];
  const changed: Record<string, Omit<SigningWait, 'since'> | null> = {};
  const byCert = new Map<string, Employee[]>();
  const castellan = !!releasesRepoEnv(ctx.settings).MANOR_RELEASES_REPO;
  for (const [id, w] of Object.entries(waits)) {
    const e = ctx.settings.employees.find((x) => x.id === id);
    if (!e) {
      changed[id] = null;
      continue;
    }
    if (!employees.includes(e)) continue;
    try {
      if ((await releasedOf(ctx, e)).some((r) => r.version === w.version)) {
        ctx.log(`[${e.id}] v${w.version} no longer waits until this PC can sign: it is released`);
        changed[id] = null;
        continue;
      }
    } catch (err) {
      ctx.log(`[${e.id}] couldn't read its releases: ${(err as Error).message}`);
      continue;
    }
    if (builds.some((b) => b.by === 'signing' && (b.employees ?? []).includes(id) && now.getTime() - Date.parse(b.started) < SIGNED_AGAIN_MS)) continue;
    // Its checkout signs nothing now: a build of its own releases it as any other.
    const cert = signerHere(e, castellan) ?? '';
    byCert.set(cert, [...(byCert.get(cert) ?? []), e]);
  }
  const ready: Employee[] = [];
  for (const [cert, who] of byCert) {
    const down = cert ? await signingProblem(ctx.run, cert, { now: now.getTime() }) : null;
    if (!down) {
      ready.push(...who);
      continue;
    }
    for (const e of who) if (waits[e.id].why !== down) changed[e.id] = { version: waits[e.id].version, commit: waits[e.id].commit, why: down };
  }
  if (Object.keys(changed).length) noteSigningWaits(changed, now);
  if (ready.length) ctx.log(`${ready.map((e) => `${e.name} v${waits[e.id].version}`).join(', ')} waited until this PC could sign, and it can now: ${ready.length === 1 ? 'it builds' : 'they build'} at once, a build of ${ready.length === 1 ? 'its' : 'their'} own`);
  return ready.map((e) => e.id);
}

/**
 * A build's releases, side by side (buildReleaseLimit at once): those that sign started first, one after another in a
 * lane of their own, as their signing takes longest and the signing key answers one signtool at a time; the rest beside
 * them. One signtool run for a whole build's files isn't possible: each release builds and signs its own files in its
 * own worktree, with its own tools (the kit's sign.ts already signs a release's files in batches of 40). Results in
 * `employees`' order.
 */
export async function buildReleases<R>(employees: Employee[], parallel: number, one: (e: Employee) => Promise<R>, signs: (e: Employee) => boolean, cpus?: number): Promise<R[]> {
  const signers = employees.filter(signs);
  const rest = employees.filter((e) => !signers.includes(e));
  const limit = buildReleaseLimit(parallel, cpus);
  const [a, b] = await Promise.all([mapLimit(signers, 1, one), mapLimit(rest, Math.max(1, limit - (signers.length ? 1 : 0)), one)]);
  return employees.map((e) => (signers.includes(e) ? a[signers.indexOf(e)] : b[rest.indexOf(e)]));
}

/** How long before a build its releases that sign are looked at, so the person can reconnect SimplySign Desktop in time. */
export const AHEAD_MS = 60 * 60_000;

/** "<build> <id>@<head>" for each head looked at before a build and found to sign nothing, or to sign while this PC can. */
const aheadFine = new Set<string>();

/** Forgets the heads looked at before builds (for a test). */
export const forgetSigningAhead = () => aheadFine.clear();

/**
 * Within AHEAD_MS of the next build (Steward 0.36.161): the releases it would make that sign (an unreleased version at
 * the head of a branch whose release signs, needsSigning), and whether this PC can sign now (signingProblem, a
 * timestamped test signature). What it found is kept for an alarm (noteSigningAhead) while it can't, so the person
 * reconnects SimplySign Desktop before the build rather than after; nothing otherwise, and nothing further from the
 * build. One already waiting (signedBetween's) has its own alarm. A head found fine is not looked at again for that
 * build. Never throws.
 */
export async function signingAhead(ctx: Ctx, employees: Employee[], next: Date | null, now = new Date()): Promise<SigningAhead | null> {
  const keep = (a: SigningAhead | null) => {
    noteSigningAhead(a);
    return a;
  };
  if (!next || next.getTime() - now.getTime() > AHEAD_MS) return keep(null);
  const build = next.toISOString();
  const waits = loadSigningWaits();
  const due: { e: Employee; version: string; cert: string; memo: string }[] = [];
  const castellan = !!releasesRepoEnv(ctx.settings).MANOR_RELEASES_REPO;
  for (const e of employees) {
    const cert = e.release && e.versionFiles.length ? signerHere(e, castellan) : null;
    const head = cert && !waits[e.id] ? glanceOf(ctx, e)?.head : null;
    if (!cert || !head) continue;
    const memo = `${build} ${e.id}@${head}`;
    if (aheadFine.has(memo)) continue;
    try {
      const repo = checkoutOf(e);
      if (!(await commitOf(ctx.run, repo, head))) await fetchBranch(ctx.run, repo, e.branch);
      const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(ctx.run, repo, head, f)] as [string, string | null])));
      const signs = 'version' in v && !(await releasedOf(ctx, e)).some((r) => r.version === v.version) && (await needsSigning(ctx.run, { id: e.id, repo, commit: head, kitJson: await showFile(ctx.run, repo, head, 'kit.json'), castellan, checkout: repo }));
      if (signs) due.push({ e, version: (v as { version: string }).version, cert, memo });
      else aheadFine.add(memo);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't look at its release's signing ahead of the build: ${(err as Error).message}`);
    }
  }
  let why: string | null = null;
  for (const cert of new Set(due.map((d) => d.cert))) {
    const down = await signingProblem(ctx.run, cert, { now: now.getTime() });
    if (down) why ??= down;
    else for (const d of due) if (d.cert === cert) aheadFine.add(d.memo);
  }
  const held = due.filter((d) => !aheadFine.has(d.memo));
  if (!held.length || !why) return keep(null);
  const was = loadSigningAhead();
  ctx.log(`this PC can't sign now, and the next build would sign ${held.map((d) => `${d.e.name} v${d.version}`).join(', ')}: ${why}`);
  return keep({ build, names: held.map((d) => `${d.e.name} ${d.version}`), why, since: was?.build === build ? was.since : now.toISOString() });
}

/**
 * Each employee's unreleased version, released from its branch, that very commit tested first (mainbuild.ts's mainGate);
 * not a commit whose release failed in a round before, nor one of an agent Manor has retired (retired.ts), whose release
 * that failed before is let go.
 */
export async function releaseUnreleased(ctx: Ctx, employees: Employee[]): Promise<EmployeeResult[]> {
  const failed = readJson<Record<string, string>>(roundFailuresFile(), {});
  if (!employees.length) return [];
  const retired = retiredOf(ctx);
  // After a fresh start (fresh-start.ts), each release that failed before is tried once more: it may have failed only
  // because the PC was going to sleep, shutting down or offline. Failing again, it stands as before.
  const retry = takeFreshStart('releases') ? new Set(Object.keys(failed)) : new Set<string>();
  // One that failed only because the code-signing key couldn't be reached (as rounds before 0.36.30 kept those) isn't
  // left to a person: it waits until this PC can sign, as a release that signs does now (signing.ts).
  for (const e of employees) if (failed[e.id] && keptSigningDown(releaseDirOf(ctx.settings, e))) delete failed[e.id];
  // A few employees at a time (Settings' parallel); what failed is kept once all are done.
  const one = async (e: Employee): Promise<EmployeeResult> => {
    if (retired.has(e.id)) return result(e, 'skipped', RETIRED);
    try {
      return await withRepo(ctx.log, e.id, () =>
        releaseOne(ctx, e, {
          kit: null,
          kitOnly: true,
          gate: (commit, since) => mainGate(ctx, e, commit, since),
          unless: (commit, version) => (failed[e.id] === commit.slice(0, 7) && !retry.has(e.id) ? `v${version} at ${commit.slice(0, 7)} failed to release in an earlier round, so the rounds leave it to you: Release on the page, or a new commit` : null),
        }),
      );
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return result(e, 'failed', (err as Error).message);
    }
  };
  const out = ctx.build ? await buildReleases(employees, ctx.settings.parallel, one, signsHere) : await mapLimit(employees, ctx.settings.parallel, one);
  for (const r of out) {
    // A release the network cut short (common.ts's networkFailure) isn't that commit's fault: the next round tries it again.
    if (retired.has(r.id)) delete failed[r.id];
    else if (r.outcome === 'failed' && r.commit && !(await networkFailure(ctx, r.message))) failed[r.id] = r.commit;
    // Released, by this round or another way (a person, or a run that beat this one to it): nothing failed stands.
    else if (r.outcome === 'done' || r.released) delete failed[r.id];
    // Looked at, and not held by the tasting (released, or nothing to release): no hold to count hours for.
    if (!r.again) clearTastingHold(r.id);
  }
  writeJson(roundFailuresFile(), failed);
  // Those waiting until this PC can sign, for one alarm; the rest no longer wait (released, or something else holds them).
  noteSigningWaits(Object.fromEntries(out.map((r) => [r.id, r.signing && r.version && r.commit ? { version: r.version, commit: r.commit, why: r.signing } : null])));
  return out;
}

/** A round worth keeping: something merged, released or installed, or something failed. A refusal is a standing state (no checkout, say), which the staff's table shows. */
export const roundDidSomething = (results: EmployeeResult[], error?: string) => !!error || results.some((r) => r.outcome === 'done' || r.outcome === 'failed');
