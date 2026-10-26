import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuredAccelerators, ENDPOINT_KINDS, OWN_MEMORY_GB, readConfigFile } from './accelerator-config.ts';
import { expandEnv, type Endpoint } from './accelerators.ts';
import { logLine, ownActivityMs, pcReaper, reaperLog, type ReapOutcome, serversToReap } from './keeper.ts';
import { CEILING_WORDS, PACE_CEILING } from './pace.ts';

/**
 * The memory guard (kit 2.138.0): a model loads only under the manor's memory ceiling. Rounds already start nothing new
 * above it (pace.ts' PACE_CEILING, kit 2.78.3), but a round started under it could then load a model that took the PC
 * over: with the whole staff employed, several agents' rounds can start servers on several accelerators together, and a
 * PC with 16 GB could load a second and third model on top of one nobody is using. So before a server starts
 * (accelerators.ts' start()), its model's size (modelBytes: the files its command names) and the ceiling's share of
 * the PC's memory, at least HEADROOM_BYTES, are looked for in the memory Windows has available (os.freemem()).
 *
 * Short of it, the manor's other servers unused for GUARD_IDLE_MS are stopped, the longest unused first, one at a time
 * until there is room: in the keeper's own turn on each accelerator (keeper.ts' Reaper), so none in use, or with
 * someone waiting for it, is ever stopped; one whose idle stop config.json turns off (0) never is, nor the starting
 * server's own accelerator's others (its request holds that turn). Still short while one of them is in use, it looks
 * again every GUARD_LOOK_MS, as that one's work ends: for a person's request up to GUARD_WAIT_MS, and then the server
 * starts anyway, since someone is waiting; for background work up to DEFER_AFTER_MS, and then the work steps back
 * (accelerators.ts' NoRoomToLoad: npu.ts defers it, as for a model still loading) and comes again later, when there's
 * room. It never swaps a model for a smaller one. A card with its own memory (OWN_MEMORY_GB or more) loads its model
 * there, and is left alone. Under node --test, nothing is looked at. What it does goes in the keeper's log.
 */

/** The least a server needs available beyond its model's files, whatever the ceiling: its context's cache, its program, and Windows. */
export const HEADROOM_BYTES = 1.5 * 1024 ** 3;
/** A model whose files its command doesn't name (GenieX's, set up by hand): about the manor's own, 2B parameters. */
export const UNKNOWN_MODEL_BYTES = 2 * 1024 ** 3;
/** Unused this long, another server may be stopped for one starting: as the NPU's embedding server's giving way (keeper.ts' YIELD_GRACE_MS). */
export const GUARD_IDLE_MS = 30_000;
/** How long a person's request waits, at most, for a server in use to be done and give its memory back; then it starts. */
export const GUARD_WAIT_MS = 2 * 60_000;
/** How long background work waits for room, holding its accelerator's turn, before it steps back for later. */
export const DEFER_AFTER_MS = 30_000;
/** How often a waiting start looks again. */
export const GUARD_LOOK_MS = 10_000;

/** What a server's start keeps free beyond its model: the share of memory the manor's ceiling leaves, at least HEADROOM_BYTES. */
export const headroomBytes = (totalBytes = os.totalmem()) => Math.max(HEADROOM_BYTES, Math.round((1 - PACE_CEILING) * totalBytes));

/** The flags whose next argument is a model's file, or folder: llama-server's `-m` and `--mmproj`, OpenVINO's `--model_path`. */
const MODEL_FLAGS = new Set(['-m', '--model', '--mmproj', '--model_path']);

/** A file's size, or a folder's files' (to a few levels down); 0 when there's none or it can't be read. */
export function bytesAt(p: string, depth = 6): number {
  try {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) return 0;
    if (!st.isDirectory()) return st.size;
    if (depth <= 0) return 0;
    let n = 0;
    for (const e of readdirSync(p)) n += bytesAt(path.join(p, e), depth - 1);
    return n;
  } catch {
    return 0;
  }
}

/**
 * The size of the model a server's command loads: the files after its MODEL_FLAGS, and OpenVINO Model Server's
 * `--source_model` folder in its `--model_repository_path`. Null when it names none that are there.
 */
export function modelBytes(command: readonly string[], size: (p: string) => number = bytesAt, env: Record<string, string | undefined> = process.env): number | null {
  const args = command.map((a) => expandEnv(a, env));
  const after = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  let total = 0;
  for (let i = 0; i + 1 < args.length; i++) if (MODEL_FLAGS.has(args[i])) total += size(args[i + 1]);
  const source = after('--source_model');
  const repo = after('--model_repository_path');
  if (source && repo) total += size(path.join(repo, source));
  return total > 0 ? total : null;
}

/** A server the guard may stop for room: where it answers, and its turn's stop when it's unused (or why not). */
export interface GuardServer {
  base: string;
  stop: () => Promise<'stopped' | 'not-running' | 'kept'>;
}

/** The PC, as the guard sees it: swapped in tests. */
export interface GuardDeps {
  freeBytes: () => number;
  /** The manor's other servers, the longest unused first. */
  others: () => GuardServer[] | Promise<GuardServer[]>;
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}

/** What the guard did: found room (having stopped `stopped`), or found none. */
export type GuardOutcome = { did: 'room' | 'short'; stopped: string[]; waitedMs: number; freeBytes: number; needBytes: number };

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Why there's no room, in a few words: for the log, and the deferred work's message. */
export const shortWords = (r: Pick<GuardOutcome, 'freeBytes' | 'needBytes'>) => `${gb(r.freeBytes)} of memory available, where its model needs about ${gb(r.needBytes)} to stay under the manor's ${CEILING_WORDS}`;

/**
 * Room for a server at `base` that needs `needBytes` available: at once when there is; else the idle others stopped,
 * one at a time, until there is; else looked at again while one of them is in use, up to `waitMs`. `then` says what
 * comes of no room, for the log: the server starts anyway, or the work is deferred. Never throws.
 */
export async function roomFor(base: string, needBytes: number, d: GuardDeps, o: { waitMs?: number; lookMs?: number; then?: 'start' | 'defer' } = {}): Promise<GuardOutcome> {
  const t0 = d.now();
  const stopped: string[] = [];
  const waitMs = o.waitMs ?? GUARD_WAIT_MS;
  const done = (did: 'room' | 'short'): GuardOutcome => ({ did, stopped, waitedMs: Math.round(d.now() - t0), freeBytes: d.freeBytes(), needBytes });
  const then = o.then === 'defer' ? `left ${base} for later` : `started ${base} anyway`;
  try {
    for (;;) {
      if (d.freeBytes() >= needBytes) return done('room');
      let running = false;
      for (const s of await d.others()) {
        const r = await s.stop().catch(() => 'kept' as const);
        if (r === 'stopped') {
          stopped.push(s.base);
          if (d.freeBytes() >= needBytes) {
            d.log(`stopped ${stopped.join(', ')}, unused, for room to start ${base}: it needs about ${gb(needBytes)} available, and has ${gb(d.freeBytes())}`);
            return done('room');
          }
        } else if (r === 'kept') running = true;
      }
      const waited = d.now() - t0;
      if (!running || waited >= waitMs) {
        const out = done('short');
        const did = stopped.length ? `stopped ${stopped.join(', ')}, unused, and ` : '';
        d.log(`${did}${then}: ${shortWords(out)}; ${running ? `the manor's other servers were still in use after ${Math.round(waited / 1000)} s` : "none of the manor's other servers could be stopped for it"}`);
        return out;
      }
      await d.sleep(Math.min(o.lookMs ?? GUARD_LOOK_MS, waitMs - waited));
    }
  } catch (e: any) {
    d.log(`started ${base} without looking for room: ${e?.message ?? e}`);
    return done('room');
  }
}

/**
 * What a server's start needs available (its model's size and headroomBytes), and its accelerator's id; null when its
 * accelerator is a card with its own memory, which the guard leaves alone.
 */
export function needOf(ep: Pick<Endpoint, 'baseUrl' | 'startCommand'>, raw: Record<string, any>, o: { size?: (p: string) => number; totalBytes?: number } = {}): { needBytes: number; accId: string | null } | null {
  const acc = configuredAccelerators(raw).find((a) => ENDPOINT_KINDS.some((k) => a[k]?.baseUrl === ep.baseUrl));
  if (acc?.kind === 'gpu' && (acc.memoryGb ?? 0) >= OWN_MEMORY_GB) return null;
  return { needBytes: (modelBytes(ep.startCommand ?? [], o.size) ?? UNKNOWN_MODEL_BYTES) + headroomBytes(o.totalBytes), accId: acc?.id ?? null };
}

const STOPPED: ReadonlySet<ReapOutcome['did']> = new Set(['stopped', 'stopped-kept-out', 'stopped-for-game']);

/**
 * This PC's guard for a server starting at `ep`: its memory, the manor's other servers in config.json, and the keeper's
 * log. `then` 'defer' (background work) waits DEFER_AFTER_MS; else a person's request, GUARD_WAIT_MS. Null when it
 * has nothing to look at (a card with its own memory) or couldn't look.
 */
export async function makeRoom(ep: Pick<Endpoint, 'baseUrl' | 'startCommand'>, o: { then?: 'start' | 'defer' } = {}): Promise<GuardOutcome | null> {
  try {
    const raw = readConfigFile().raw;
    const need = needOf(ep, raw);
    if (!need) return null;
    const log = (line: string) => logLine(reaperLog(), `memory guard: ${line}`);
    // A reaper of its own: unused GUARD_IDLE_MS is idle here, and it neither recycles nor restarts anything.
    const reaper = pcReaper({ who: 'memory guard', log, options: { idleMs: GUARD_IDLE_MS, recycleBytes: 0, unansweredMs: Number.MAX_SAFE_INTEGER, gameGraceMs: Number.MAX_SAFE_INTEGER } });
    const others = () =>
      serversToReap(readConfigFile().raw)
        .filter((s) => s.base !== ep.baseUrl && s.acc.id !== need.accId && s.idleMs !== 0)
        .map((s) => ({ s: { ...s, idleMs: GUARD_IDLE_MS }, used: ownActivityMs(s.lockDirs) }))
        .sort((a, b) => a.used - b.used)
        .map(({ s }) => ({
          base: s.base,
          stop: async () => {
            const [r] = await reaper.look([s]);
            return STOPPED.has(r.did) ? ('stopped' as const) : r.did === 'not-running' ? ('not-running' as const) : ('kept' as const);
          },
        }));
    const deps: GuardDeps = { freeBytes: os.freemem, others, log, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    return await roomFor(ep.baseUrl, need.needBytes, deps, { waitMs: o.then === 'defer' ? DEFER_AFTER_MS : GUARD_WAIT_MS, then: o.then });
  } catch {
    return null;
  }
}
