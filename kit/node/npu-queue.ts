// The NPU queue (the kit's spec/NPU-QUEUE.md): the original, which Reeve's src/npu-queue.ts copies until
// Reeve takes the kit. Every NPU user on the PC must order the line the same way, so a change here is a
// change to the spec and its vectors too. Its tests are the Steward's kit/test/npu-queue.test.ts.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The NPU queue: first come, first served turns on the machine-wide NPU lock. Every NPU user on this
 * PC takes part: Reeve (here), npu-embed (npu_lock.py), Heiward (HEI.Core/AI/NpuLock.cs) and Manor's
 * agents. The protocol, which all of them implement, is docs/NPU-QUEUE.md.
 *
 * In short: the lock is still the `mkdir` of the lock folder (src/lock.ts), so a program that predates
 * the queue still can't run alongside anyone. To queue, a waiter drops a ticket file into
 * `<lock>.queue`, keeps it fresh (a heartbeat), and tries the lock only when its ticket heads the line.
 * When the holder lets go, the head of the line takes it within ~50 ms.
 *
 * Every accelerator (the NPU, each graphics card, the processor) has its own lock and line, by the
 * same rules (Manor's docs/ACCELERATORS.md). One with several slots serves that many requests at once:
 * its lock folders are `<id>`, `<id>.2` … `<id>.<slots>`, its line is `<id>.queue`, and the head of
 * the line takes any free slot (withAcceleratorTurn). The NPU has one slot, its folder `npu` as before.
 */

export type Lane = 'interactive' | 'background';

/** No turn came within the wait. */
export class LockTimeout extends Error {}

/** The line was longer than the caller was willing to join (`maxAhead`). */
export class QueueFull extends Error {}

/** Timings every implementation shares: a ticket is fresh, late or dead by the same clock everywhere. */
export const QUEUE = {
  /** A waiter touches its ticket at least this often. */
  heartbeatMs: 2_000,
  /** A ticket this stale is late: its process is checked, and the ticket is dead if that's gone. */
  lateMs: 5_000,
  /** A ticket this stale is dead whatever its pid says (pids get reused). */
  deadMs: 15_000,
  /** A background ticket this old is served as if it were interactive, so nothing waits forever. */
  ageMs: 120_000,
  /** How often the head of the line tries the lock, and how often the rest look. */
  headPollMs: 50,
  pollMs: 100,
};

export interface Ticket {
  name: string;
  /** 0 = interactive (a person is waiting), 1 = background. */
  lane: 0 | 1;
  /** When it joined, in microseconds since the Unix epoch. */
  timeUs: number;
  pid: number;
  nonce: string;
}

const TICKET = /^([01])-(\d{17})-(\d+)-([0-9a-z]+)\.ticket$/;

export function parseTicket(name: string): Ticket | null {
  const m = TICKET.exec(name);
  return m ? { name, lane: Number(m[1]) as 0 | 1, timeUs: Number(m[2]), pid: Number(m[3]), nonce: m[4] } : null;
}

/** The order of the line: interactive first, then by arrival; a background ticket that waited `ageMs` counts as interactive. */
export function compareTickets(a: Ticket, b: Ticket, nowUs: number): number {
  const lane = (t: Ticket) => (t.lane === 0 || nowUs - t.timeUs >= QUEUE.ageMs * 1000 ? 0 : 1);
  return lane(a) - lane(b) || a.timeUs - b.timeUs || a.pid - b.pid || (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0);
}

/** Whether a ticket's waiter is gone: no heartbeat for `deadMs`, or a late heartbeat and no such process. */
export function isDeadTicket(ageMs: number, pidAlive: () => boolean): boolean {
  return ageMs > QUEUE.deadMs || (ageMs > QUEUE.lateMs && !pidAlive());
}

export const queueDirFor = (lockDir: string) => `${lockDir}.queue`;

let lastUs = 0;
/** Wall-clock microseconds, strictly increasing within this process. */
function nowUs(): number {
  const t = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  lastUs = t > lastUs ? t : lastUs + 1;
  return lastUs;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks; on Windows libuv opens the process and reads its exit code
    return true;
  } catch (e: any) {
    return e?.code !== 'ESRCH';
  }
}

/** The live tickets in line order. Dead ones are removed on the way (anyone in line may), except `keep`. */
export function readLine(queueDir: string, keep?: string): Ticket[] {
  let names: string[];
  try {
    names = readdirSync(queueDir);
  } catch {
    return [];
  }
  const now = Date.now();
  const live: Ticket[] = [];
  for (const name of names) {
    const t = parseTicket(name);
    if (!t) continue;
    let age: number;
    try {
      age = now - statSync(path.join(queueDir, name)).mtimeMs;
    } catch {
      continue; // left the line just now
    }
    if (name !== keep && isDeadTicket(age, () => pidAlive(t.pid))) {
      try {
        unlinkSync(path.join(queueDir, name));
      } catch {}
      continue;
    }
    live.push(t);
  }
  const us = nowUs();
  return live.sort((a, b) => compareTickets(a, b, us));
}

/** Who holds the NPU and who is waiting, for status pages. Reads only. */
export function queueSnapshot(lockDir: string): {
  holder: { pid: number; since: number } | null;
  waiting: { pid: number; lane: Lane; since: number; who?: string }[];
} {
  let holder: { pid: number; since: number } | null = null;
  try {
    holder = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    if (existsSync(lockDir)) holder = { pid: 0, since: 0 };
  }
  const queueDir = queueDirFor(lockDir);
  const now = Date.now();
  const waiting: { t: Ticket; entry: { pid: number; lane: Lane; since: number; who?: string } }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(queueDir);
  } catch {}
  for (const name of names) {
    const t = parseTicket(name);
    if (!t) continue;
    let who: string | undefined;
    let age: number;
    try {
      age = now - statSync(path.join(queueDir, name)).mtimeMs;
      who = JSON.parse(readFileSync(path.join(queueDir, name), 'utf8'))?.who;
    } catch {
      continue;
    }
    if (isDeadTicket(age, () => pidAlive(t.pid))) continue;
    waiting.push({ t, entry: { pid: t.pid, lane: t.lane === 0 ? 'interactive' : 'background', since: Math.floor(t.timeUs / 1000), who } });
  }
  const us = nowUs();
  return { holder, waiting: waiting.sort((a, b) => compareTickets(a.t, b.t, us)).map((w) => w.entry) };
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
  return Array.from({ length: Math.max(1, slots) }, (_, i) => (i === 0 ? first : `${first}.${i + 1}`));
}

/** How full an accelerator is: its slots, how many are held (by a live holder), and how many wait in its line. */
export interface LineState {
  slots: number;
  held: number;
  waiting: number;
}

export function lineState(lockDirs: string[], staleMs = 600_000): LineState {
  const held = lockDirs.filter((d) => existsSync(d) && !isStaleHolder(d, staleMs)).length;
  return { slots: lockDirs.length, held, waiting: readLine(queueDirFor(lockDirs[0])).length };
}

/** Who holds each slot and who is waiting, for status pages. Reads only. */
export function lineSnapshot(lockDirs: string[]): { holders: ({ pid: number; since: number } | null)[]; waiting: ReturnType<typeof queueSnapshot>['waiting'] } {
  const first = queueSnapshot(lockDirs[0]);
  const holders = lockDirs.map((d, i) => (i === 0 ? first.holder : queueSnapshot(d).holder));
  return { holders, waiting: first.waiting };
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
}

/**
 * Runs `fn` holding the NPU lock, after waiting its turn in the NPU queue. Use it for every request
 * that runs on the NPU; src/lock.ts's withLock stays for locks nobody queues for.
 */
export async function withNpuTurn<T>(lockDir: string, fn: () => Promise<T>, opts: TurnOptions = {}): Promise<T> {
  return withAcceleratorTurn([lockDir], () => fn(), opts);
}

/**
 * Runs `fn` holding one of an accelerator's slots (slotDirs), after waiting its turn in its line. The
 * head of the line takes whichever slot is free; `fn` is told which (0 for the first).
 */
export async function withAcceleratorTurn<T>(lockDirs: string[], fn: (slot: number) => Promise<T>, opts: TurnOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? 300_000;
  const staleMs = opts.staleMs ?? 600_000;
  const lane = currentLane(opts.lane);
  const lockDir = lockDirs[0];
  const queueDir = queueDirFor(lockDir);
  const what = path.basename(lockDir) === 'npu' ? 'the NPU' : path.basename(lockDir);
  mkdirSync(queueDir, { recursive: true });

  if (opts.maxAhead !== undefined) {
    const ahead = readLine(queueDir).length;
    if (ahead >= opts.maxAhead) throw new QueueFull(`${ahead} already waiting for ${what}`);
  }

  const us = nowUs();
  const name = `${lane === 'interactive' ? 0 : 1}-${String(us).padStart(17, '0')}-${process.pid}-${randomBytes(4).toString('hex')}.ticket`;
  const ticket = path.join(queueDir, name);
  const body = JSON.stringify({ pid: process.pid, since: Math.floor(us / 1000), lane, who: opts.who ?? path.basename(process.argv[1] ?? 'node') });
  /** Writes the ticket, putting the queue folder back if it was removed. */
  const writeTicket = () => {
    try {
      writeFileSync(ticket, body);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(ticket, body);
    }
  };
  writeTicket();

  const deadline = Date.now() + waitMs;
  let beat = Date.now();
  let me: { pid: number; since: number } | null = null;
  let slot = -1;
  /** The head of the line takes any free slot, the first first. */
  const trySlots = async (): Promise<boolean> => {
    for (let i = 0; i < lockDirs.length; i++) {
      if ((me = await tryLock(lockDirs[i], staleMs))) {
        slot = i;
        return true;
      }
    }
    return false;
  };
  try {
    for (;;) {
      const now = Date.now();
      if (now - beat >= QUEUE.heartbeatMs) {
        try {
          utimesSync(ticket, new Date(now), new Date(now));
        } catch {
          writeTicket(); // someone took it for dead (a long pause): back in, in the same place
        }
        beat = now;
      }
      const line = readLine(queueDir, name);
      if (!line.some((t) => t.name === name)) {
        writeTicket();
        beat = Date.now();
        continue;
      }
      const head = line[0].name === name;
      if (head && (await trySlots())) break;
      if (now > deadline) throw new LockTimeout(`timed out after ${waitMs} ms waiting for ${what} (${line.length} in line)`);
      await sleep(head ? QUEUE.headPollMs : QUEUE.pollMs);
    }
  } finally {
    try {
      unlinkSync(ticket);
    } catch {}
  }
  try {
    return await fn(slot);
  } finally {
    await release(lockDirs[slot], me);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One try at the lock folder: ours (with the owner written), or null. Evicts a dead or overstayed holder. */
async function tryLock(dir: string, staleMs: number): Promise<{ pid: number; since: number } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      const me = { pid: process.pid, since: Date.now() };
      writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(me));
      return me;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      if (!(await removeLock(dir, () => isStaleHolder(dir, staleMs)))) return null;
    }
  }
  return null;
}

function readOwner(dir: string): { pid: number; since: number } | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')); // Node's reads share delete
  } catch {
    return null;
  }
}

/** The same stale rules as src/lock.ts. */
function isStaleHolder(dir: string, staleMs: number): boolean {
  const info = readOwner(dir);
  if (!info) {
    try {
      return Date.now() - statSync(dir).mtimeMs > 10_000;
    } catch {
      return false;
    }
  }
  return Date.now() - info.since > staleMs || !pidAlive(info.pid);
}

/** How often, and how many times, a removal of the lock tries again while a file in it is open: about a second in all. */
const REMOVE_TRIES = 40;
const REMOVE_RETRY_MS = 25;
/** What a delete fails with while a file in the folder is open (EBUSY, usually) or half removed. */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/**
 * Removes the lock folder while `still()` holds, checking before every try: true once it's gone.
 * On Windows a delete fails while another process has a file in it open without sharing delete.
 * Node's reads share delete, but other tools' may not (Python's open(), .NET's File.ReadAllText),
 * and a waiter checking the holder has owner.json open at times. So try again for about a second
 * rather than leave the lock taken until it goes stale. False when `still()` stopped holding or the
 * file stayed open.
 */
async function removeLock(dir: string, still: () => boolean): Promise<boolean> {
  for (let attempt = 1; still(); attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e: any) {
      if (!BUSY.has(e?.code)) throw e;
      if (attempt >= REMOVE_TRIES) return false;
    }
    await sleep(REMOVE_RETRY_MS);
  }
  return false;
}

/**
 * Lets go of the lock only while owner.json still names us. A holder that overstayed may have been
 * evicted, and the next holder's folder can exist a moment before its owner.json does: removing on
 * anything less than a match would break someone else's turn.
 */
async function release(dir: string, me: { pid: number; since: number } | null): Promise<void> {
  if (!me) return;
  try {
    await removeLock(dir, () => {
      const owner = readOwner(dir);
      return owner?.pid === me.pid && owner?.since === me.since;
    });
  } catch {
    // Left for the next taker's stale check.
  }
}
