// The NPU queue (the kit's spec/NPU-QUEUE.md): Node's driver of the kit's core. The rules (the ticket
// order, the late, dead and aged tickets, a holder's eviction, the turn step by step) are the core's
// (src/kit/core/queue.js and turn.js), shared with every other driver; this file does the disk work they
// ask for, with Node's fs, and the waiting, with timers, so a turn never blocks an agent's server. Its
// tests, and the spec's vectors, are the Steward's kit/test.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as core from './core/index.js';
import type { Action, Result, Step } from './core/index.js';
import { RULES } from './rules.ts';

/**
 * The NPU queue: first come, first served turns on the machine-wide NPU lock. Every NPU user on this
 * PC takes part: Reeve, npu-embed (npu_lock.py), Heiward (the kit's dotnet part) and Manor's agents. The
 * protocol, which all of them implement, is the kit's spec/NPU-QUEUE.md.
 *
 * In short: the lock is still the `mkdir` of the lock folder (lock.ts), so a program that predates the
 * queue still can't run alongside anyone. To queue, a waiter drops a ticket file into `<lock>.queue`,
 * keeps it fresh (a heartbeat), and tries the lock only when its ticket heads the line. When the holder
 * lets go, the head of the line takes it within ~50 ms.
 *
 * Every accelerator (the NPU, each graphics card, the processor) has its own lock and line, by the
 * same rules (spec/ACCELERATORS.md). One with several slots serves that many requests at once: its lock
 * folders are `<id>`, `<id>.2` … `<id>.<slots>`, its line is `<id>.queue`, and the head of the line
 * takes any free slot (withAcceleratorTurn). The NPU has one slot, its folder `npu` as before.
 */

export type Lane = core.Lane;

/** No turn came within the wait. */
export class LockTimeout extends Error {}

/** The line was longer than the caller was willing to join (`maxAhead`). */
export class QueueFull extends Error {}

/** Timings every implementation shares (the spec's rules.json): a ticket is fresh, late or dead by the same clock everywhere. */
export const QUEUE: { heartbeatMs: number; lateMs: number; deadMs: number; ageMs: number; headPollMs: number; pollMs: number } = { ...RULES.queue };

export type Ticket = core.Ticket;

export function parseTicket(name: string): Ticket | null {
  return core.parseTicket(name);
}

/** The order of the line: interactive first, then by arrival; a background ticket that waited `ageMs` counts as interactive. */
export function compareTickets(a: Ticket, b: Ticket, nowUs: number): number {
  return core.compareTickets(RULES, a, b, nowUs);
}

/** Whether a ticket's waiter is gone: no heartbeat for `deadMs`, or a late heartbeat and no such process (asked only then). */
export function isDeadTicket(ageMs: number, pidAlive: () => boolean): boolean {
  const s = core.ticketState(RULES, ageMs);
  return s === 'dead' || (s === 'late' && !pidAlive());
}

export const queueDirFor = (lockDir: string) => path.join(path.dirname(lockDir), core.queueName(path.basename(lockDir)));

let lastUs = 0;
/** Wall-clock microseconds, strictly increasing within this process. */
function nowUs(): number {
  return (lastUs = core.nextUs(lastUs, Math.floor((performance.timeOrigin + performance.now()) * 1000)));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks; on Windows libuv opens the process and reads its exit code
    return true;
  } catch (e: any) {
    return e?.code !== 'ESRCH';
  }
}

/** A folder's files with their modification times (null for one gone meanwhile), and, with `texts`, their contents. */
function listFolder(dir: string, texts = false): core.Entry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    let mtimeMs: number | null = null;
    let text: string | undefined;
    try {
      mtimeMs = statSync(file).mtimeMs;
      if (texts) text = readFileSync(file, 'utf8');
    } catch {}
    return { name, mtimeMs, ...(text === undefined ? {} : { text }) };
  });
}

/** The core's verdict on a line, its processes asked about when it needs them. */
function judge(entries: core.Entry[], keep?: string): core.LineVerdict {
  const now = Date.now();
  const v = core.judgeLine(RULES, entries, now, { keep });
  return v.ask ? core.judgeLine(RULES, entries, now, { keep, alive: Object.fromEntries(v.ask.map((pid) => [pid, pidAlive(pid)])) }) : v;
}

/** The live tickets in line order. Dead ones are removed on the way (anyone in line may), except `keep`. */
export function readLine(queueDir: string, keep?: string): Ticket[] {
  const v = judge(listFolder(queueDir), keep);
  for (const name of v.dead) {
    try {
      unlinkSync(path.join(queueDir, name));
    } catch {}
  }
  return v.live;
}

const readText = (file: string) => {
  try {
    return readFileSync(file, 'utf8'); // Node's reads share delete
  } catch {
    return null;
  }
};

/** Who holds the NPU and who is waiting, for status pages. Reads only. */
export function queueSnapshot(lockDir: string): {
  holder: { pid: number; since: number } | null;
  waiting: { pid: number; lane: Lane; since: number; who?: string }[];
} {
  let holder: { pid: number; since: number } | null = core.readOwner(readText(path.join(lockDir, 'owner.json')));
  if (!holder && existsSync(lockDir)) holder = { pid: 0, since: 0 };
  const entries = listFolder(queueDirFor(lockDir), true);
  const now = Date.now();
  let w = core.waitingOf(RULES, entries, now);
  if ('ask' in w) w = core.waitingOf(RULES, entries, now, Object.fromEntries(w.ask.map((pid) => [pid, pidAlive(pid)])));
  return { holder, waiting: 'waiting' in w ? w.waiting : [] };
}

let defaultLane: Lane = 'background';

/** The lane this process queues in unless a call says otherwise; NPU_QUEUE_LANE in the environment wins. */
export function setDefaultLane(lane: Lane): void {
  defaultLane = lane;
}

function laneFromEnv(): Lane | undefined {
  const v = process.env.NPU_QUEUE_LANE;
  return v === 'interactive' || v === 'background' ? v : undefined;
}

/** The lane a request goes in: the call's, else NPU_QUEUE_LANE, else this process's default. */
export function currentLane(lane?: Lane): Lane {
  return lane ?? laneFromEnv() ?? defaultLane;
}

/**
 * An accelerator's lock folders, one per slot: the first is `first` (`<locks>\<id>`; the NPU's is its
 * lock folder as before), the others `<first>.2` … `<first>.<slots>`. Its line is `<first>.queue`.
 */
export function slotDirs(first: string, slots: number): string[] {
  const base = path.dirname(first);
  return core.slotNames(path.basename(first), slots).map((name, i) => (i === 0 ? first : path.join(base, name)));
}

/** How full an accelerator is: its slots, how many are held (by a live holder), and how many wait in its line. */
export interface LineState {
  slots: number;
  held: number;
  waiting: number;
}

export function lineState(lockDirs: string[], staleMs = RULES.lock.staleMs): LineState {
  const held = lockDirs.filter((d) => existsSync(d) && !isStaleHolder(d, staleMs)).length;
  return { slots: lockDirs.length, held, waiting: readLine(queueDirFor(lockDirs[0])).length };
}

/** Who holds each slot and who is waiting, for status pages. Reads only. */
export function lineSnapshot(lockDirs: string[]): { holders: ({ pid: number; since: number } | null)[]; waiting: ReturnType<typeof queueSnapshot>['waiting'] } {
  const first = queueSnapshot(lockDirs[0]);
  const holders = lockDirs.map((d, i) => (i === 0 ? first.holder : queueSnapshot(d).holder));
  return { holders, waiting: first.waiting };
}

/** The core's stale rules, read from disk now. */
function isStaleHolder(dir: string, staleMs: number): boolean {
  const owner = core.readOwner(readText(path.join(dir, 'owner.json')));
  let folderMtimeMs: number | null = null;
  if (!owner) {
    try {
      folderMtimeMs = statSync(dir).mtimeMs;
    } catch {}
  }
  const o = { owner, folderMtimeMs, nowMs: Date.now(), staleMs };
  const h = core.holderState(RULES, o);
  return (h === 'ask' ? core.holderState(RULES, { ...o, pidAlive: pidAlive(owner!.pid) }) : h) === 'stale';
}

export interface TurnOptions {
  /** How long to wait in line (default 5 min). */
  waitMs?: number;
  /** When a holder counts as overstayed (default 10 min). */
  staleMs?: number;
  lane?: Lane;
  /** Shown to whoever looks at the line ("reeve", "heiward", ...). */
  who?: string;
  /** Don't join when this many are already waiting: throws QueueFull at once. */
  maxAhead?: number;
  /** Told what's worth a line in a log: waiting behind others, taking over from a holder that died. */
  onNote?: (text: string) => void;
}

// ---------------------------------------------------------------- the driver

/** How a machine of the core's is carried out: its actions, the clock, and the waits. */
export interface DriveEnv {
  perform: (action: Action) => Result | Promise<Result>;
  clock: () => number;
  sleep: (ms: number) => Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One of the core's actions, on disk below `base` (the folder that holds the locks), with Node's fs. */
export function performOnDisk(base: string, a: Action, onNote?: (text: string) => void): Result {
  const at = (p: string[]) => path.join(base, ...p);
  try {
    switch (a.op) {
      case 'mkdirs':
        mkdirSync(at(a.path), { recursive: true });
        return null;
      case 'write':
        writeFileSync(at(a.path), a.text);
        return null;
      case 'touch': {
        const now = new Date();
        utimesSync(at(a.path), now, now);
        return null;
      }
      case 'list': {
        const dir = at(a.path);
        const names = readdirSync(dir);
        return { entries: names.map((name) => ({ name, mtimeMs: mtimeOf(path.join(dir, name)) })) };
      }
      case 'alive':
        return { alive: a.pids.map(pidAlive) };
      case 'remove':
        unlinkSync(at(a.path));
        return null;
      case 'mkdir':
        mkdirSync(at(a.path));
        return null;
      case 'read':
        return { text: readFileSync(at(a.path), 'utf8') }; // Node's reads share delete
      case 'stat':
        return { mtimeMs: statSync(at(a.path)).mtimeMs };
      case 'rmdir':
        rmSync(at(a.path), { recursive: true, force: true });
        return null;
      case 'note':
        onNote?.(a.text);
        return null;
    }
  } catch (e: any) {
    return { error: typeof e?.code === 'string' ? e.code : 'EIO', message: String(e?.message ?? e) };
  }
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null; // left the line just now
  }
}

/** The disk below `base`, the wall clock and timers. */
export function onDisk(base: string, onNote?: (text: string) => void): DriveEnv {
  return { perform: (a) => performOnDisk(base, a, onNote), clock: Date.now, sleep };
}

/**
 * Runs one of the core's machines (a turn, the plain lock, a release) from its first step until it ends:
 * each step's actions in order, its wait, then the next step from what they gave. Its last step is
 * returned: its `done` says how it ended, and its state is what `release` takes. When anything throws on
 * the way, the machine is aborted (its ticket leaves the line) and the error passed on.
 */
export async function drive(first: Step, env: DriveEnv): Promise<Step> {
  let r = first;
  try {
    for (;;) {
      const results: Result[] = [];
      for (const a of r.actions) results.push(await env.perform(a));
      if (r.done) return r;
      if (r.waitMs > 0) await env.sleep(r.waitMs);
      r = core.step(r.state, { nowMs: env.clock(), results });
    }
  } catch (e) {
    for (const a of core.abort(r.state).actions) {
      try {
        await env.perform(a);
      } catch {}
    }
    throw e;
  }
}

/** The error a machine that ended without the lock stands for. */
function noTurn(done: core.Done | undefined): Error {
  if (done && 'error' in done) return done.error === 'timeout' ? new LockTimeout(done.message) : done.error === 'full' ? new QueueFull(done.message) : new Error(done.message);
  return new Error('the turn ended without the lock');
}

/** Holds the lock the machine took while `fn` runs, then lets it go (by the release rule: only while it is still ours). */
export async function holding<T>(taken: Step, env: DriveEnv, fn: (slot: number) => Promise<T>): Promise<T> {
  const done = taken.done;
  if (!done || !('held' in done)) throw noTurn(done);
  try {
    return await fn(done.held.slot);
  } finally {
    try {
      await drive(core.release(taken.state, env.clock()), env);
    } catch {
      // Left for the next taker's stale check.
    }
  }
}

/**
 * Runs `fn` holding the NPU lock, after waiting its turn in the NPU queue. Use it for every request
 * that runs on the NPU; lock.ts's withLock stays for locks nobody queues for.
 */
export async function withNpuTurn<T>(lockDir: string, fn: () => Promise<T>, opts: TurnOptions = {}): Promise<T> {
  return withAcceleratorTurn([lockDir], () => fn(), opts);
}

/**
 * Runs `fn` holding one of an accelerator's slots (slotDirs), after waiting its turn in its line. The
 * head of the line takes whichever slot is free; `fn` is told which (0 for the first).
 */
export async function withAcceleratorTurn<T>(lockDirs: string[], fn: (slot: number) => Promise<T>, opts: TurnOptions = {}): Promise<T> {
  const base = path.dirname(lockDirs[0]);
  if (lockDirs.some((d) => path.dirname(d) !== base)) throw new Error(`an accelerator's lock folders are side by side: ${lockDirs.join(', ')}`);
  const env = onDisk(base, opts.onNote);
  const taken = await drive(
    core.startTurn(RULES, {
      slots: lockDirs.map((d) => path.basename(d)),
      pid: process.pid,
      nowMs: Date.now(),
      nowUs: nowUs(),
      nonce: randomBytes(4).toString('hex'),
      lane: currentLane(opts.lane),
      who: opts.who ?? path.basename(process.argv[1] ?? 'node'),
      waitMs: opts.waitMs,
      staleMs: opts.staleMs,
      maxAhead: opts.maxAhead,
    }),
    env,
  );
  return holding(taken, env, fn);
}
