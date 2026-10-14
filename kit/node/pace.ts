import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockDirFor } from './lock.ts';
import { readJsonFile } from './file-cache.ts';
import { manorHome } from './manor.ts';
import { slotDirs, withAcceleratorTurn } from './npu-queue.ts';

/**
 * The manor's pace (kit 2.43.3, spec/ROUND.md's "Pace"): how the agents' scheduled rounds share this PC, so they never
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
 * - **full**: as before kit 2.43.3: normal priority, and no first-round line.
 *
 * Either way, the agents' scheduled rounds share **the work line** (kit 2.56.0): as many run side by side as Manor's
 * `"agentsAtOnce"` says (2 at a gentle pace, 4 at a full one, unless it says), and only one at a time while the PC is
 * busy or short of memory; the rest wait their turn, first come, first served.
 *
 * A round the person asked for (Run now) never waits in the line, and runs at normal priority: someone is waiting on it.
 * What Heiward adds in the background (Windows' efficiency mode, a very low disk priority, a hard cap on the processor)
 * needs Windows calls Node doesn't have: gentle.ts sets them through the agent's PowerShell worker (kit 2.50.0).
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
 * unless the agent says). Read afresh each time (one stat while the file is unchanged: file-cache.ts), so a change in
 * Manor's Settings applies from the next round. Under
 * node --test, full unless MANOR_PACE says: a test never waits in this PC's real line.
 */
export function pace(own: Pace = 'gentle', home = manorHome(), env: NodeJS.ProcessEnv = process.env): Pace {
  if (env.MANOR_PACE === 'gentle' || env.MANOR_PACE === 'full') return env.MANOR_PACE;
  if (env.NODE_TEST_CONTEXT) return 'full';
  const v = manorSetting(home, 'backgroundPace');
  return v === 'gentle' || v === 'full' ? v : own;
}

/** One key of Manor's settings.json, when Manor is installed and the file can be read; undefined otherwise. */
function manorSetting(home: string, key: string): unknown {
  if (!existsSync(path.join(home, 'app'))) return undefined;
  return readJsonFile<Record<string, unknown> | null>(path.join(home, 'settings.json'), null)?.[key];
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

/**
 * How many agents' scheduled rounds may run side by side on this PC (kit 2.56.0) when Manor doesn't say: two at a
 * gentle pace, four at a full one. Manor's `"agentsAtOnce"` says otherwise, from 1 to `most`; 0 lifts the line.
 */
export const AGENTS_AT_ONCE = { gentle: 2, full: 4, most: 6 } as const;

/** What a round that waited its turn in the work line until its next was due says it waited for (round.json's waiting). */
export const WORK_WAITING = 'its turn: as many agents as the manor allows at once were working already';

/** The work line's lock folder (`<locks>\work`, its other slots `work.2` …), beside the accelerators'. */
export const workLockDir = () => lockDirFor('work');

/**
 * How many slots the work line has now: Manor's settings.json `"agentsAtOnce"` (a whole number, 1 to
 * AGENTS_AT_ONCE.most) when Manor is installed and says, else the pace's default. Null when there is no line: Manor
 * says 0, or `MANOR_AGENTS_AT_ONCE` does (which, when set, says instead of Manor), or under node --test unless it says.
 * Read afresh each round, so a change in Manor's Settings applies from the next one.
 */
export function agentsAtOnce(p: Pace, home = manorHome(), env: NodeJS.ProcessEnv = process.env): number | null {
  const slots = (v: unknown): number | null | undefined => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
    return n < 0.5 ? null : Math.min(AGENTS_AT_ONCE.most, Math.round(n));
  };
  const own = slots(env.MANOR_AGENTS_AT_ONCE);
  if (own !== undefined) return own;
  if (env.NODE_TEST_CONTEXT) return null;
  const said = slots(manorSetting(home, 'agentsAtOnce'));
  return said !== undefined ? said : AGENTS_AT_ONCE[p];
}

/** How busy this PC is: the share of the processor in use (0 to 1) over the last moment, and of memory free. */
export interface Load {
  busy: number;
  freeMemory: number;
}

/**
 * When the work line offers fewer slots than it has: one at a time once the processor is `busy` or memory is short
 * (`lowMemory` free), and half of them (rounded up) once it is `someBusy`.
 */
export const LOAD = { busy: 0.6, someBusy: 0.35, lowMemory: 0.15 };

/** The slots of `slots` a round may take at `load`: all of them on a quiet PC, fewer on a busy one, and one at least. */
export function slotsFor(slots: number, load: Load): number {
  if (slots <= 1 || load.busy >= LOAD.busy || load.freeMemory < LOAD.lowMemory) return 1;
  return load.busy >= LOAD.someBusy ? Math.ceil(slots / 2) : slots;
}

interface CpuTimes {
  idle: number;
  total: number;
}

const cpuTimes = (): CpuTimes => {
  let idle = 0;
  let total = 0;
  for (const { times: t } of os.cpus()) {
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
};

/**
 * This PC's load now, from Node's own counters (no program started): the processor's use over `sampleMs`, and the
 * memory free. Every agent on the PC counts, those in the work line's other slots too, which is the point.
 */
export async function measureLoad(sampleMs = 1000): Promise<Load> {
  const before = cpuTimes();
  await new Promise((r) => setTimeout(r, sampleMs));
  const after = cpuTimes();
  const total = after.total - before.total;
  const busy = total > 0 ? 1 - (after.idle - before.idle) / total : 0;
  return { busy: Math.min(1, Math.max(0, busy)), freeMemory: os.freemem() / Math.max(1, os.totalmem()) };
}

/**
 * Runs a scheduled round in its turn in the work line (kit 2.56.0): at once when one of the slots it may take is free,
 * else when one is, first come, first served with the other agents' rounds. It may take every slot (agentsAtOnce())
 * on a quiet PC, and fewer on a busy one (slotsFor()), so a busy PC runs one round at a time. The holder keeps its slot
 * for its round's time limit (`limitMs`), and one whose process has gone gives it up at once (the kit's lock rules).
 * After `waitMs` in line it throws the line's LockTimeout, which every() takes as a round that waited. `slots` and
 * `load` are for tests.
 */
export async function inWorkTurn<T>(p: Pace, fn: () => Promise<T>, o: { who: string; limitMs: number; waitMs: number; doing?: string; dir?: string; slots?: number | null; load?: () => Promise<Load> }): Promise<T> {
  const slots = o.slots !== undefined ? o.slots : agentsAtOnce(p);
  if (slots === null) return fn();
  const load = slots > 1 ? await (o.load ?? measureLoad)().catch(() => null) : null;
  const offered = load ? slotsFor(slots, load) : slots;
  return withAcceleratorTurn(slotDirs(o.dir ?? workLockDir(), offered), () => fn(), {
    lane: 'background',
    who: o.who,
    ...(o.doing ? { doing: o.doing.slice(0, 80) } : {}),
    waitMs: o.waitMs,
    staleMs: o.limitMs,
  });
}
