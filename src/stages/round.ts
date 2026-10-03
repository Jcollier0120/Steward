import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { result, type Ctx, type EmployeeResult } from './common.ts';
import { releaseOne } from './release.ts';

/**
 * The Steward's round (`steward round`, and on duty every few minutes when Settings say it merges and releases
 * by itself): the merge stage with --yes --team, each merged PR's steps after it, and then a release for every
 * employee whose branch carries a version with no GitHub release yet, whatever kit it pins. A round with nothing
 * done or failed is not recorded: last-stage.json and stages.log keep what last happened.
 *
 * A release that fails isn't tried again at the same commit, round after round: the commit is kept in
 * round-failed.json, and the round says so until a person releases it (Release on the page, or `steward
 * release`), or a new commit on the branch is tried afresh.
 */

export const roundFailuresFile = () => dataFile('round-failed.json');

/** Each employee's unreleased version, released from its branch; not a commit whose release failed in a round before. */
export async function releaseUnreleased(ctx: Ctx, employees: Employee[]): Promise<EmployeeResult[]> {
  const failed = readJson<Record<string, string>>(roundFailuresFile(), {});
  const out: EmployeeResult[] = [];
  for (const e of employees) {
    let r: EmployeeResult;
    try {
      r = await releaseOne(ctx, e, {
        kit: null,
        unless: (commit, version) => (failed[e.id] === commit.slice(0, 7) ? `v${version} at ${commit.slice(0, 7)} failed to release in an earlier round, so the rounds leave it to you: Release on the page, or a new commit` : null),
      });
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      r = result(e, 'failed', (err as Error).message);
    }
    if (r.outcome === 'failed' && r.commit) failed[e.id] = r.commit;
    else if (r.outcome === 'done') delete failed[e.id];
    out.push(r);
  }
  writeJson(roundFailuresFile(), failed);
  return out;
}

/** A round worth keeping: something merged, released or installed, or something failed. A refusal is a standing state (no checkout, say), which the staff's table shows. */
export const roundDidSomething = (results: EmployeeResult[], error?: string) => !!error || results.some((r) => r.outcome === 'done' || r.outcome === 'failed');
