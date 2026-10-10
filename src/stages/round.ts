import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { mapLimit, networkFailure, result, type Ctx, type EmployeeResult } from './common.ts';
import { releaseOne } from './release.ts';
import { clearTastingHold } from '../tasting.ts';
import { takeFreshStart } from '../fresh-start.ts';

/**
 * The Steward's round (`steward round`, and on duty every few minutes when Settings say it merges and releases
 * by itself): the merge stage with --yes --team, each merged PR's steps after it, and then a release for every
 * employee whose branch carries a version with no GitHub release yet, whatever kit it pins; then the Steward's own new
 * versions (stages/self.ts) and a new kit rolled out to each employee behind it (stages/rollout.ts). A round with
 * nothing done or failed is not recorded: last-stage.json and stages.log keep what last happened.
 *
 * A release that fails isn't tried again at the same commit, round after round: the commit is kept in
 * round-failed.json, and the round says so until a person releases it (Release on the page, or `steward
 * release`), or a new commit on the branch is tried afresh.
 */

export const roundFailuresFile = () => dataFile('round-failed.json');

/** Each employee's unreleased version, released from its branch; not a commit whose release failed in a round before. */
export async function releaseUnreleased(ctx: Ctx, employees: Employee[]): Promise<EmployeeResult[]> {
  const failed = readJson<Record<string, string>>(roundFailuresFile(), {});
  if (!employees.length) return [];
  // After a fresh start (fresh-start.ts), each release that failed before is tried once more: it may have failed only
  // because the PC was going to sleep, shutting down or offline. Failing again, it stands as before.
  const retry = takeFreshStart('releases') ? new Set(Object.keys(failed)) : new Set<string>();
  // A few employees at a time (Settings' parallel); what failed is kept once all are done.
  const out = await mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await releaseOne(ctx, e, {
        kit: null,
        unless: (commit, version) => (failed[e.id] === commit.slice(0, 7) && !retry.has(e.id) ? `v${version} at ${commit.slice(0, 7)} failed to release in an earlier round, so the rounds leave it to you: Release on the page, or a new commit` : null),
      });
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return result(e, 'failed', (err as Error).message);
    }
  });
  for (const r of out) {
    // A release the network cut short (common.ts's networkFailure) isn't that commit's fault: the next round tries it again.
    if (r.outcome === 'failed' && r.commit && !(await networkFailure(ctx, r.message))) failed[r.id] = r.commit;
    // Released, by this round or another way (a person, or a run that beat this one to it): nothing failed stands.
    else if (r.outcome === 'done' || r.released) delete failed[r.id];
    // Looked at, and not held by the tasting (released, or nothing to release): no hold to count hours for.
    if (!r.again) clearTastingHold(r.id);
  }
  writeJson(roundFailuresFile(), failed);
  return out;
}

/** A round worth keeping: something merged, released or installed, or something failed. A refusal is a standing state (no checkout, say), which the staff's table shows. */
export const roundDidSomething = (results: EmployeeResult[], error?: string) => !!error || results.some((r) => r.outcome === 'done' || r.outcome === 'failed');
