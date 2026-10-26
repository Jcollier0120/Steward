import type { AlarmState } from '../alarms.ts';
import type { FoundRepo, FoundState } from '../found.ts';
import type { TendState } from '../tend.ts';
import type { TurnsView } from '../lease.ts';
import type { Host } from '../scm.ts';
import type { StageResult } from '../stages/common.ts';
import type { PrInfo, Staff, StaffRow } from '../stages/staff.ts';
import type { WholeJob } from '../stages/wholesuite.ts';

/**
 * What the Steward's page shows, as /api/page's `body` (agent.ts's viewData()). Types only: the browser's bundle
 * imports nothing of the server's code.
 */

/** Its rounds, as the page says them: building and releasing by itself, or only when asked. */
export interface RoundView {
  on: boolean;
  minutes: number;
  onDuty: boolean;
  lastRunAt: string | null;
  /** Settings' rollout and releaseSelf. */
  rollout?: boolean;
  releaseSelf?: boolean;
  /** Settings' tend, with Manor's page named: the rounds keep the staff's pages up (tend.ts). */
  tend?: boolean;
  /** This PC has a repository to look after (steward.ts's reposHere): without one, a round only keeps the staff's pages up. */
  repos?: boolean;
  /** This PC releases Castellan itself: its rounds also approve Reeve's jobs, and as above roll the kit out and release the Steward. */
  castellan?: boolean;
  /**
   * Settings' build pipeline, how the Steward always works (pipeline.ts): its build times, the next, and whether one is
   * under way; `late`, the line for the last build when the PC slept through its time (pipeline.ts' lateLine); `wakes`,
   * the PC is woken for each, plugged in (build-hold.ts); `took`, where the last build's time went (buildtimes.ts).
   */
  build?: { times: string[]; next: string | null; building: boolean; took?: string | null; late?: string | null; wakes?: boolean } | null;
  /** A vendor's screen saver has been putting the PC to sleep, and which setting turns it off (the kit's sleep-cause.ts' line). */
  asleep?: string | null;
}

/** A PR as the page shows it: with what its steward block asks for once merged, in words (after.ts's afterWords). */
export type PrView = PrInfo & { afterText: string | null };
/** A repository as the page shows it, with how the Steward works with it (scm.ts's hostOf): its PRs go by that host's name. */
export type StaffRowView = Omit<StaffRow, 'prs'> & { prs: PrView[]; host?: Host };
export type StaffView = Omit<Staff, 'rows'> & { rows: StaffRowView[] };

/** The repositories Reeve found that could be looked after (found.ts's foundView). */
export interface FoundView {
  at: string | null;
  error: string | null;
  from: FoundState['from'];
  offered: FoundRepo[];
  found: number;
  /** Where Look after puts one: Manor's Repositories (spec/REPOSITORIES.md), or the Steward's own Settings where there is no Manor. */
  into?: 'manor' | 'steward';
}

export interface StewardView {
  /**
   * Developer options are off on a PC that isn't Castellan's makers' (maker.ts): this plain line is the whole page, and
   * the rest is empty. Left out otherwise.
   */
  off?: string;
  /** Turns with this PC's others (lease.ts): the repositories another PC looks after. Null or left out: no turns. */
  turns?: TurnsView | null;
  /** This PC's version claims that another PC claimed too while this one couldn't reach the remote (claims.ts). */
  claimClashes?: string[];
  /** The PRs stuck next in their version lines, passed over (passover.ts): what each waits on and the version it gets. */
  passedOver?: string[];
  /** This PC releases Castellan itself (Settings): the kit, its rollout and the Steward's own releases are shown. */
  castellan?: boolean;
  /** The repositories Reeve found, to look after. */
  found?: FoundView;
  /** A look at them is under way. */
  finding?: boolean;
  staff: StaffView | null;
  last: StageResult | null;
  /** The first of `runs`, or null: for a page from before stages ran side by side. */
  running: { stage: string; since: string } | null;
  /** Every stage running now, side by side (stages/slots.ts). */
  runs?: { stage: string; since: string }[];
  /** Every slot taken (Settings' stagesAtOnce): no other stage can start until one ends. */
  full?: boolean;
  refreshing: boolean;
  /** The team the stages use: Settings' own, or the account gh is signed in as when they name none (ghuser.ts). */
  team: string[];
  /** Where an empty Team in Settings leaves it: whose account it is, or why there is none. Null: Settings name it. */
  teamNote?: string | null;
  round: RoundView;
  /** Undefined when Settings turn the alarms off. */
  alarms?: AlarmState;
  /** The staff's pages as the last round left them (tending.json); undefined when Settings switch it off. */
  tending?: TendState;
  /** The whole suite before a kit's release, beside the rounds (stages/wholesuite.ts): the last one, or null. */
  wholeSuite?: WholeJob | null;
}
