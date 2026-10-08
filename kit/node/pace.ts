import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockDirFor } from './lock.ts';
import { manorHome } from './manor.ts';
import { withAcceleratorTurn } from './npu-queue.ts';

/**
 * The manor's pace (kit 2.43.0, spec/ROUND.md's "Pace"): how the agents' scheduled rounds share this PC, so they never
 * all do their heavy first work at once and grind it to a halt (a first install, every agent hired together). One
 * setting for every agent, Manor's settings.json `"backgroundPace"`:
 *
 * - **gentle** (the default):
 *   - **First rounds one at a time.** An agent whose scheduled round has never gone through (round.json says none
 *     has) waits in one line with the others in the same state, and does its first round only once the agent before
 *     it has finished its own: the first round is the heavy one (a first index, a first scan, a first look at every
 *     repository), and those that come after only catch up on what changed. The line is the kit's, as the NPU's: first
 *     come, first served, and a holder whose process has gone gives up its place at once.
 *   - **Below-normal priority.** A scheduled round runs at below-normal priority, and so does every program it starts
 *     (Windows gives a below-normal process's children its class), so it gives way to whatever the person is doing.
 * - **full**: as before kit 2.43.0: normal priority, and no line.
 *
 * A round the person asked for (Run now) never waits in the line, and runs at normal priority: someone is waiting on it.
 * What Heiward adds in the background (Windows' efficiency mode, a very low disk priority, a hard cap on the processor)
 * needs Windows calls Node doesn't have; below-normal priority is the part every agent can take.
 */

export type Pace = 'gentle' | 'full';

/** How long an agent waits in the first-round line before it lets its place go (and joins again at its next round). */
export const FIRST_ROUND_WAIT_MS = 6 * 3_600_000;

/**
 * How long a first round keeps its turn before a waiter takes it over, at the least: a first scan of every drive
 * (Heiward's) or a first index takes hours, and a holder whose process has gone gives the turn up at once anyway.
 * Heiward's .NET line allows as long (NpuLock.FirstRoundHold).
 */
export const FIRST_ROUND_HOLD_MS = 12 * 3_600_000;

/** What a round waiting in the first-round line says it waits for (RoundState's waiting). */
export const FIRST_ROUND_WAITING = "its first round: the agents before it are doing theirs, one at a time";

/**
 * The manor's pace now: Manor's settings.json `"backgroundPace"` when Manor is installed and says, else `own` (gentle
 * unless the agent says). Read afresh each time, so a change in Manor's Settings applies from the next round. Under
 * node --test, full unless MANOR_PACE says: a test never waits in this PC's real line.
 */
export function pace(own: Pace = 'gentle', home = manorHome(), env: NodeJS.ProcessEnv = process.env): Pace {
  if (env.MANOR_PACE === 'gentle' || env.MANOR_PACE === 'full') return env.MANOR_PACE;
  if (env.NODE_TEST_CONTEXT) return 'full';
  const file = path.join(home, 'settings.json');
  if (!existsSync(file) || !existsSync(path.join(home, 'app'))) return own;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))?.backgroundPace;
    return v === 'gentle' || v === 'full' ? v : own;
  } catch {
    return own;
  }
}

/** The first-round line's lock folder, beside the accelerators' (`<locks>\first-rounds`): one slot, one agent at a time. */
export const firstRoundLockDir = () => lockDirFor('first-rounds');

/**
 * This process's priority for the pace: below normal when gentle, normal when full or when someone is waiting on the
 * round. Never throws (a PC that refuses keeps its priority); true when it was set.
 */
export function setPriorityFor(p: Pace, asked = false, set: (priority: number) => void = (v) => os.setPriority(0, v)): boolean {
  try {
    set(p === 'gentle' && !asked ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a scheduled round: an agent's first (`first`, none has gone through yet) at a gentle pace in its turn in the
 * first-round line, else at once. `limitMs` is the round's own time limit: the holder keeps its place that long (and
 * FIRST_ROUND_HOLD_MS at the least, as Heiward's first scan needs), and
 * one whose process has gone gives it up at once (the kit's lock rules). `onWait` is told when it starts and stops
 * waiting in line. After FIRST_ROUND_WAIT_MS in line it throws the line's LockTimeout, which every() takes as a round
 * that waited: it joins the line again at its next round.
 */
export async function inFirstRoundTurn<T>(p: Pace, first: boolean, fn: () => Promise<T>, o: { who: string; limitMs: number; waitMs?: number; dir?: string; onWait?: (waiting: boolean) => void }): Promise<T> {
  if (p !== 'gentle' || !first) return fn();
  o.onWait?.(true);
  let inLine = true;
  try {
    return await withAcceleratorTurn(
      [o.dir ?? firstRoundLockDir()],
      () => {
        inLine = false;
        o.onWait?.(false);
        return fn();
      },
      { lane: 'background', who: o.who, waitMs: o.waitMs ?? FIRST_ROUND_WAIT_MS, staleMs: Math.max(o.limitMs, FIRST_ROUND_HOLD_MS) },
    );
  } finally {
    if (inLine) o.onWait?.(false);
  }
}
