import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { mapLimit, result, type Ctx, type EmployeeResult } from './common.ts';
import { releaseOne } from './release.ts';

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
  // A few employees at a time (Settings' parallel); what failed is kept once all are done.
  const out = await mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await releaseOne(ctx, e, {
        kit: null,
        unless: (commit, version) => (failed[e.id] === commit.slice(0, 7) ? `v${version} at ${commit.slice(0, 7)} failed to release in an earlier round, so the rounds leave it to you: Release on the page, or a new commit` : null),
      });
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return result(e, 'failed', (err as Error).message);
    }
  });
  for (const r of out) {
    if (r.outcome === 'failed' && r.commit) failed[r.id] = r.commit;
    else if (r.outcome === 'done') delete failed[r.id];
  }
  writeJson(roundFailuresFile(), failed);
  return out;
}

/** A round worth keeping: something merged, released or installed, or something failed. A refusal is a standing state (no checkout, say), which the staff's table shows. */
export const roundDidSomething = (results: EmployeeResult[], error?: string) => !!error || results.some((r) => r.outcome === 'done' || r.outcome === 'failed');
