import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { TAG_RELEASE, type Employee } from '../settings.ts';
import { checkoutOf, mapLimit, networkFailure, releaseDirOf, result, type Ctx, type EmployeeResult } from './common.ts';
import { releaseOne } from './release.ts';
import { keptSigningDown, noteSigningWaits, signsWith } from '../signing.ts';
import { clearTastingHold } from '../tasting.ts';
import { takeFreshStart } from '../fresh-start.ts';
import { withRepo } from './slots.ts';

/**
 * The Steward's round (`steward round`, and on duty every few minutes when Settings say it merges and releases
 * by itself): the merge stage with --yes --team, each merged PR's steps after it, and then a release for every
 * employee whose branch carries a version with no GitHub release yet, whatever kit it pins; then the Steward's own new
 * versions (stages/self.ts) and a new kit rolled out to each employee behind it (stages/rollout.ts). A round with
 * nothing done or failed is not recorded: last-stage.json and stages.log keep what last happened.
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

/** Whether a release signs what it builds (signing.ts's signsWith), as its checkout's kit.json and tools/sign.ts say now. */
export function signsHere(e: Employee): boolean {
  if (e.release === TAG_RELEASE) return false;
  const dir = checkoutOf(e);
  const read = (f: string) => {
    try {
      return readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return null;
    }
  };
  return !!signsWith({ kitJson: read('kit.json'), signTs: read(path.join('tools', 'sign.ts')), release: e.release });
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

/** Each employee's unreleased version, released from its branch; not a commit whose release failed in a round before. */
export async function releaseUnreleased(ctx: Ctx, employees: Employee[]): Promise<EmployeeResult[]> {
  const failed = readJson<Record<string, string>>(roundFailuresFile(), {});
  if (!employees.length) return [];
  // After a fresh start (fresh-start.ts), each release that failed before is tried once more: it may have failed only
  // because the PC was going to sleep, shutting down or offline. Failing again, it stands as before.
  const retry = takeFreshStart('releases') ? new Set(Object.keys(failed)) : new Set<string>();
  // One that failed only because the code-signing key couldn't be reached (as rounds before 0.36.30 kept those) isn't
  // left to a person: it waits until this PC can sign, as a release that signs does now (signing.ts).
  for (const e of employees) if (failed[e.id] && keptSigningDown(releaseDirOf(ctx.settings, e))) delete failed[e.id];
  // A few employees at a time (Settings' parallel); what failed is kept once all are done.
  const one = async (e: Employee): Promise<EmployeeResult> => {
    try {
      return await withRepo(ctx.log, e.id, () =>
        releaseOne(ctx, e, {
          kit: null,
          kitOnly: true,
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
    if (r.outcome === 'failed' && r.commit && !(await networkFailure(ctx, r.message))) failed[r.id] = r.commit;
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
