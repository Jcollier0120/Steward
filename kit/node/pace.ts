import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lockDirFor } from './lock.ts';
import { readJsonFile } from './file-cache.ts';
import { manorHome } from './manor.ts';
import { LockTimeout, slotDirs, withAcceleratorTurn } from './npu-queue.ts';

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
 * - **full**: normal priority, and no first-round line, but never past the manor's ceiling (PACE_CEILING, kit 2.78.3):
 *   the agent's own work and its check runs are each held to 85% of the processor (gentle.ts, checks-pace.ts), so
 *   Windows and the person always keep the rest. Before kit 2.78.3 full had no ceiling at all.
 *
 * Either way, the agents' scheduled rounds share **the work line** (kit 2.56.0): as many run side by side as Manor's
 * `"agentsAtOnce"` says (2 at a gentle pace, 4 at a full one, unless it says), and only one at a time while the PC is
 * busy or short of memory; the rest wait their turn, first come, first served. Short of memory is more than
 * PACE_CEILING of it in use, and then no round starts at all until there is room again (kit 2.78.3), line or no line.
 *
 * A round the person asked for (Run now) never waits in the line, but runs at the pace like any other (kit 2.73.0): the
 * setting is the only thing that changes the pace.
 * What Heiward adds in the background (Windows' efficiency mode, a very low disk priority, a hard cap on the processor)
 * needs Windows calls Node doesn't have: gentle.ts sets them through the agent's PowerShell worker (kit 2.50.0).
 */

export type Pace = 'gentle' | 'full';

/**
 * The most of this PC the manor's background work may take, whatever the pace (kit 2.78.3): 85% of the processor, and
 * no new work while more than 85% of the memory is in use. The owner's words: "cap it at 85% system resources to leave
 * room for OS and other operations that the user might be doing." A full pace runs up to it; a gentle one stays well
 * under it. Every ceiling in the kit is this one.
 */
export const PACE_CEILING = 0.85;

/** PACE_CEILING as a job's processor cap, in hundredths of a percent (8500), as gentle.cs and checks-pace.cs take it. */
export const CEILING_CAP = Math.round(PACE_CEILING * 10_000);

/** PACE_CEILING in words: "85%". */
export const CEILING_WORDS = `${Math.round(PACE_CEILING * 100)}%`;

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
 * This process's priority for the pace: below normal when gentle, normal when full, whoever is waiting (kit 2.73.0: a
 * round asked for no longer lifts it). Never throws (a PC that refuses keeps its priority); true when it was set.
 */
export function setPriorityFor(p: Pace, set: (priority: number) => void = (v) => os.setPriority(0, v)): boolean {
  try {
    set(p === 'gentle' ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL);
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
 * (shortOfMemory()), and half of them (rounded up) once it is `someBusy`.
 */
export const LOAD = { busy: 0.6, someBusy: 0.35 };

/**
 * Whether `load` is short of memory: more than PACE_CEILING of it in use (kit 2.78.3; before, less than 15% free, the
 * same line), what Windows doesn't have available, as measureLoad() and memoryInUse() read it.
 */
export const shortOfMemory = (load: Pick<Load, 'freeMemory'>): boolean => 1 - load.freeMemory > PACE_CEILING;

/** The share of this PC's memory in use now, 0 to 1: what Windows doesn't have available (os.freemem() is that). */
export const memoryInUse = (): number => 1 - os.freemem() / Math.max(1, os.totalmem());

/** The slots of `slots` a round may take at `load`: all of them on a quiet PC, fewer on a busy one, and one at least. */
export function slotsFor(slots: number, load: Load): number {
  if (slots <= 1 || load.busy >= LOAD.busy || shortOfMemory(load)) return 1;
  return load.busy >= LOAD.someBusy ? Math.ceil(slots / 2) : slots;
}

/** What a round waiting for memory says it waits for (round.json's waiting): nothing new starts above the ceiling. */
export const MEMORY_WAITING = `room: more than ${CEILING_WORDS} of this PC's memory is in use, and the manor starts nothing new above that`;

/** How often a round waiting for memory looks again. */
export const ROOM_LOOK_MS = 10_000;

/** A round's wait for memory outlasted its wait in line: the line's LockTimeout, which every() takes as a round that waited. */
export class NoRoom extends LockTimeout {}

/**
 * Waits until no more than PACE_CEILING of this PC's memory is in use (`inUse`, read now and every `lookMs`), at once
 * when there is room; `onWait` is told once, when it has to wait. Throws NoRoom once `deadline` (epoch ms) comes first.
 */
export async function roomToStart(o: { deadline: number; inUse?: () => number | Promise<number>; lookMs?: number; onWait?: () => void }): Promise<void> {
  const inUse = o.inUse ?? memoryInUse;
  let told = false;
  for (;;) {
    const used = await inUse();
    if (used <= PACE_CEILING) return;
    if (!told) {
      told = true;
      o.onWait?.();
    }
    const left = o.deadline - Date.now();
    if (left <= 0) throw new NoRoom(`no room: ${Math.round(used * 100)}% of this PC's memory was in use, more than ${CEILING_WORDS}`);
    await new Promise((r) => setTimeout(r, Math.min(o.lookMs ?? ROOM_LOOK_MS, left)));
  }
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
 * After `waitMs` in line it throws the line's LockTimeout, which every() takes as a round that waited.
 *
 * Nothing new starts above the ceiling (kit 2.78.3): in its turn, or at once with no line, a round waits while more
 * than PACE_CEILING of the PC's memory is in use (roomToStart()), `onRoom` told when it does, and throws NoRoom if
 * there is still none `waitMs` after it joined. `slots`, `load`, `inUse` (the memory in use, 0 to 1; else what
 * `load` says) and `lookMs` (how often it looks again) are for tests: under node --test a round looks at the memory
 * only when `load` or `inUse` says it.
 */
export async function inWorkTurn<T>(
  p: Pace,
  fn: () => Promise<T>,
  o: { who: string; limitMs: number; waitMs: number; doing?: string; dir?: string; slots?: number | null; load?: () => Promise<Load>; inUse?: () => number | Promise<number>; lookMs?: number; onRoom?: () => void },
): Promise<T> {
  const deadline = Date.now() + o.waitMs;
  const own = o.load;
  const inUse = o.inUse ?? (own ? async () => 1 - (await own()).freeMemory : process.env.NODE_TEST_CONTEXT ? null : memoryInUse);
  const room = async () => {
    if (inUse) await roomToStart({ deadline, inUse, lookMs: o.lookMs, onWait: o.onRoom });
    return fn();
  };
  const slots = o.slots !== undefined ? o.slots : agentsAtOnce(p);
  if (slots === null) return room();
  const load = slots > 1 ? await (own ?? measureLoad)().catch(() => null) : null;
  const offered = load ? slotsFor(slots, load) : slots;
  return withAcceleratorTurn(slotDirs(o.dir ?? workLockDir(), offered), room, {
    lane: 'background',
    who: o.who,
    ...(o.doing ? { doing: o.doing.slice(0, 80) } : {}),
    waitMs: o.waitMs,
    staleMs: o.limitMs,
  });
}
