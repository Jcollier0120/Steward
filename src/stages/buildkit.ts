import type { Held } from '../alarms.ts';
import type { EmployeeResult } from './common.ts';
import { waitsBriefly } from './merge.ts';

/**
 * A build's kit (pipeline.ts, Steward 0.36.67): the rollout in a build waits for a newer kit coming in that same build,
 * rather than sending the one before it.
 *
 * On 2026-10-16 the 08:00 build rolled kit 2.77.6 out to some thirty agents, each bump running its checks, while the
 * kit PRs that raise it to 2.78.1 were still being tried on those same agents in the same build: the next build would
 * have bumped and tested every agent again, and the trial's passes, which spare a rollout's checks where nothing moved
 * (trialpass.ts), went unused. Now the build stays open for the newer kit (its window still ends it), and its rollout
 * sends that one, once.
 */

/**
 * Why a build's rollout waits for a newer kit, or null when none is on its way: a kit merged whose release waits (its
 * whole suite beside the rounds, stages/self.ts), or a ready kit PR of the Steward's held only by something that settles
 * within minutes (its trial on the agents, its checks running, a head just caught up). A kit PR held for anything else
 * (its trial failing, a conflict, a draft) waits for a later build, and the kit released goes now. Pure.
 */
export function kitComing(o: { selfHeld: Held[]; selfReleases: EmployeeResult[] }): string | null {
  const merged = o.selfReleases.find((r) => r.kitWaits);
  if (merged) return `kit ${merged.kitWaits}, merged in this build, whose release waits for its whole suite`;
  const pr = o.selfHeld.find((p) => p.kit && !p.draft && waitsBriefly(p.why));
  return pr ? `the Steward's #${pr.number}, whose newer kit merges in this build (${pr.why})` : null;
}
