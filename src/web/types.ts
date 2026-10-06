import type { AlarmState } from '../alarms.ts';
import type { StageResult } from '../stages/common.ts';
import type { PrInfo, Staff, StaffRow } from '../stages/staff.ts';

/**
 * What the Steward's page shows, as /api/page's `body` (agent.ts's viewData()). Types only: the browser's bundle
 * imports nothing of the server's code.
 */

/** Its rounds, as the page says them: merging and releasing by itself, or only when asked. */
export interface RoundView {
  on: boolean;
  minutes: number;
  onDuty: boolean;
  lastRunAt: string | null;
  /** Settings' rollout and releaseSelf. */
  rollout?: boolean;
  releaseSelf?: boolean;
}

/** A PR as the page shows it: with what its steward block asks for once merged, in words (after.ts's afterWords). */
export type PrView = PrInfo & { afterText: string | null };
export type StaffRowView = Omit<StaffRow, 'prs'> & { prs: PrView[] };
export type StaffView = Omit<Staff, 'rows'> & { rows: StaffRowView[] };

export interface StewardView {
  staff: StaffView | null;
  last: StageResult | null;
  running: { stage: string; since: string } | null;
  refreshing: boolean;
  /** The team the stages use: Settings' own, or the account gh is signed in as when they name none (ghuser.ts). */
  team: string[];
  /** Where an empty Team in Settings leaves it: whose account it is, or why there is none. Null: Settings name it. */
  teamNote?: string | null;
  round: RoundView;
  /** Undefined when Settings turn the alarms off. */
  alarms?: AlarmState;
}
