import type { WorkBlock } from './kit/work-status.ts';
import { loadTurns, type TurnsState } from './lease.ts';
import { loadClaims, type Claim } from './claims.ts';
import { heldQueues, loadVersionQueues, type VersionQueues } from './version-queue.ts';

/**
 * What holds the Steward's work up, for its work status (GET /api/peer/work, the kit's work-status.ts) and Manor's Work
 * page: each version queue a PR that isn't ready holds (version-queue.ts's queueHold), by which PR and since when, with
 * the ready PRs waiting behind it. One whose repository another PC has its turn in is that PC's to say (lease.ts), as
 * its alarm is. One moved past the others since (move-past.ts) holds nothing. Never throws: a queue unread holds nothing up here.
 */
export function workBlocks(queues: () => VersionQueues = loadVersionQueues, turns: () => Pick<TurnsState, 'repos'> = loadTurns, claims: () => Pick<Claim, 'repo' | 'moved'>[] = loadClaims): WorkBlock[] {
  try {
    return heldQueues(queues(), turns(), claims()).map(({ name, repo, hold }) => ({
      kind: 'version-queue',
      what: `${name}'s version queue`,
      by: `#${hold.number} (v${hold.version}), ${hold.why}`,
      since: hold.since,
      repo,
      pr: hold.number,
      url: hold.url,
      waiting: hold.behind.map((n) => `#${n}`),
    }));
  } catch {
    return [];
  }
}
