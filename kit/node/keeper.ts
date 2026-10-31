import { appendFileSync, existsSync, type FSWatcher, mkdirSync, readFileSync, statSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Accelerator, acceleratorConfigFile, type AcceleratorKind, acceleratorsHome, configuredAccelerators, endpointFor, keeperSettings, kindOfId, readableConfigFile, readConfigFile, ENDPOINT_KINDS, type EndpointKind, serverLogsDir, serves, toolsHome } from './accelerator-config.ts';
import { currentGames, type DriverCard, driverHoldsNow, driverWorkFile, ensureServer, hardwareFile, lockDirsOf as kitLockDirsOf, npuCallNow, probe as kitProbe, readFailure, readGames, readHardware, readStarted, rememberHardware, type StartedServer, type Accelerator as KitAccelerator } from './accelerators.ts';
import { type Detection, detect, hardwareOf } from './detect.ts';
import { expandEnv } from './accelerators.ts';
import { withLock } from './lock.ts';
import * as core from './core/index.js';
import { gpuWithNpu } from './manor.ts';
import { lineSnapshot, lineState, LockTimeout, QueueFull, queueDirFor, slotDirs, withAcceleratorTurn } from './npu-queue.ts';
import { patchNpu } from './npu-patch.ts';
import { refreshNpu, whatAnswers } from './npu-refresh.ts';
import { cardIdleStopMinutes, NPU_CATALOG, npuIdleStopMinutes, smallPc } from './npu-vendors.ts';
import { powershell, psQuote } from './ps.ts';
import { keyInside, pathKey, samePath } from './real-path.ts';
import { removeRetiredModels } from './retired.ts';
import { RULES } from './rules.ts';
import { repairMissing } from './server-repair.ts';
import { AGAIN_LOOK_MS, AGAIN_QUIET_MS, removeReplaced, setUpAgain } from './set-up-again.ts';
import { kitVersion, refreshCardVision, refreshSmallModel, setupCommand, testNpuEmbed, testNpuEntry } from './setup.ts';

/**
 * Keeping the model servers (spec/ACCELERATORS.md, "Keeping the servers"): whoever keeps them (the Smith; Reeve
 * where there is no Smith) looks at them once a minute, and stops the ones nobody uses, restarts the ones that
 * stopped answering, and stops the ones nobody tracks. Every agent still starts a server it needs itself
 * (accelerators.ts's ensureServer); keeping is everything after that. It was Reeve's src/reaper.ts until kit
 * 2.10.0, and behaves as Reeve 0.4.x's did.
 *
 * Measured on GenieX v0.7.0 (2026-10-03): its `--keepalive` unloads the model after 5 idle minutes, but the process
 * keeps some 330-350 MB of committed memory for every model load after its first, chat or vision, until it exits
 * (7 GB after 28 hours here). With about 7 GB kept, the NPU's DSP failed to load the next model (a subsystem
 * restart: the 23rd load in one process) and GenieX exited. A fresh process loads a model in 9 to 15 s.
 *
 * llama.cpp's servers on a graphics card keep their model and its context in the card's memory for as long as they
 * run: a card's chat, vision and embedding servers hold some 10 to 14 GB of it, which a game then doesn't get.
 * Reloading one from the disk cache takes seconds.
 *
 * So, once a minute, for each model server the keeper can start again (an NPU's chat, vision and embedding servers,
 * npu-embed exiting by itself when idle; a graphics card's or the processor's chat, vision, embedding and reranking servers), with "in
 * use" meaning someone holds or waits on its accelerator's lock:
 * - **Idle**: when nobody has used its accelerator for `npuIdleStopMinutes` (the NPU) or `gpuIdleStopMinutes` (a
 *   graphics card, or the processor), both 10 by default (rules.json's keeper), it is stopped. The next request
 *   starts it again (ensureServer). With no `npuIdleStopMinutes` in config.json, a PC with little memory (under
 *   npu-vendors.json's idleStop.smallPcGb) stops each NPU server after its route's own minutes, from its cold start
 *   (npu-vendors.ts' npuIdleStopMinutes: 5 for GenieX and OpenVINO Model Server, 10 for FastFlowLM). With no
 *   `gpuIdleStopMinutes` in config.json, such a PC stops a card that shares its memory (integrated graphics, under 2 GB
 *   of their own) by the same rule, from llama.cpp's cold start (npu-vendors.ts' cardIdleStopMinutes: 5): its models
 *   hold the PC's own memory, as the NPU's do. An idle stop
 *   gives way when the keeper's turn wasn't had at once (TURN_AT_ONCE_MS): someone took the accelerator after the look.
 * - **A game**: when a game is using its graphics card (games.json) and nobody has used the card for 2 minutes, it
 *   is stopped, so the game gets the card's memory.
 * - **Its card's driver changing** (kit 2.148.0): when the Watchman's driver-work.json names its graphics card (a
 *   rollback, from before it changes anything until it's done; or a driver being installed), it is stopped at once:
 *   in its turn when that is had, else once the requests under way there end, within `driverGraceMs` (10 s), and then
 *   whatever holds it, as the guard waits only 20 s before pnputil changes the driver. It isn't started again here; no
 *   request goes there meanwhile, nor does any server start there (accelerators.ts' ensureServer). The file is watched
 *   (watchDriverWork), so this comes within seconds of the guard writing it, not at the next look.
 * - **A call** (kit 2.143.1): when a call is being captioned on the NPU without translating (npu-call.json's
 *   `translating` false: Envoy then asks the NPU's chat model nothing) and nobody has used the NPU for 2 minutes, the
 *   NPU's servers are stopped, so the call's speech models have the NPU and its memory to themselves. A call that
 *   translates keeps them, so its translations don't wait for a model to load.
 * - **The graphics card is kept out**: when Manor's settings say `"gpuWithNpu": false` (kit 2.10.0) and an NPU serves here, a
 *   graphics card's servers for the NPU's own work are stopped as soon as nobody uses the card, and never restarted.
 *   Its servers for work no NPU here serves (vision, beside Intel's NPU: kit 2.69.0, the card on demand) are the
 *   card's like any other: started by a request, stopped after `gpuIdleStopMinutes` unused, never started here.
 * - **Not answering**: when, with nobody using its accelerator, its /v1/models hasn't answered for 3 minutes
 *   (GenieX answers nothing while it loads a model or answers a request, which no idle accelerator takes that long
 *   to do), it is stopped and started again.
 * - **Holding too much** (the NPU's only): when, with nobody using the NPU, its working set is 9 GB or more (a
 *   loaded model is 5 to 6 GB, so that is 3 GB or more kept from earlier loads), it is stopped and started again.
 * Each is done holding every one of the accelerator's slots, the first taken through its line, so never in
 * anyone's turn; when someone is in line, it waits for the next look.
 *
 * And **orphans**: a llama-server or GenieX on the manor's ports (18181-18199, 18282, and every configured
 * server's) that no configured server is (another program, or another port: a test's, a scratch home's, a server
 * an earlier config named) is stopped once seen for 5 minutes (`orphanGraceMs`), so nothing nobody tracks keeps a
 * card's memory. It is said in the log, with the program's path and command line.
 *
 * Not in the keeper's look but in a request's turn, and said in the same log: on a PC with little memory, a chat or
 * vision request on the NPU first stops the NPU's own embedding server when it hasn't answered for 30 s
 * (yieldEmbedServer, below; kit 2.77.5), so the chat has its memory.
 */

// ------------------------------------------------------------------------------------------------
// Who keeps them

/** The Smith's data folder: SMITH_HOME, else %USERPROFILE%\.smith. */
export const smithHome = (env: NodeJS.ProcessEnv = process.env) => env.SMITH_HOME || path.join(os.homedir(), '.smith');

/** The Smith is installed here (its app folder is there): then it keeps the model servers, and Reeve only uses them. */
export const smithInstalled = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(smithHome(env), 'app'));

/** The Smith's page, and its Settings, where the accelerators are set up and changed. */
export const SMITH_URL = 'http://smith.localhost:20202/';
export const SMITH_SETTINGS_URL = `${SMITH_URL}#/settings`;

/** Who keeps the model servers on this PC: the Smith where it is installed, else Reeve. */
export const keeper = (env: NodeJS.ProcessEnv = process.env): 'smith' | 'reeve' => (smithInstalled(env) ? 'smith' : 'reeve');

/**
 * Whether the graphics cards are kept out of model work now, all of it or the NPU's part: Manor's `gpuWithNpu`
 * (manor.ts's gpuWithNpu(), true unless Manor says false) is off and the list has an NPU that serves something, by the
 * core's own rule (withoutGpuBesideNpu, with config.json's work order `order` as the core reads it, core.workOrderIn),
 * the one every agent's requests follow. cardOnDemand says what a card still does.
 */
export const gpuKeptOut = (accs: Accelerator[], withNpu: boolean, order?: core.WorkOrder) => {
  const kept = core.withoutGpuBesideNpu(accs, withNpu, order);
  return kept.length < accs.length || kept.some((a) => !accs.includes(a));
};

/**
 * What the graphics cards still do while they're kept out beside the NPU (gpuKeptOut): the work no NPU here serves,
 * and the work the PC's work order (`order`) puts the card first for (kit 2.135.3), never chat, each card's server
 * started by a request and stopped once unused (kit 2.69.0). Vision beside Intel's NPU, and its reranker when one was
 * ticked (kit 2.135.5: its route's order puts the card first for it); vision beside AMD's XDNA 2 (its order puts the
 * Radeon first for pictures), and its reranker when one was ticked (kit 2.136.3, the same ruling as Intel's); none
 * beside a Snapdragon's. Empty when the cards aren't kept out (they do everything
 * they're set up for).
 */
export function cardOnDemand(accs: Accelerator[], withNpu: boolean, order?: core.WorkOrder): { id: string; kinds: EndpointKind[] }[] {
  if (!gpuKeptOut(accs, withNpu, order)) return [];
  return core
    .withoutGpuBesideNpu(accs, withNpu, order)
    .filter((a) => a.kind === 'gpu' && a.enabled !== false)
    .map((a) => ({ id: a.id, kinds: ENDPOINT_KINDS.filter((k) => !!a[k]?.model) }))
    .filter((c) => c.kinds.length);
}

// ------------------------------------------------------------------------------------------------
// The servers, and what a look does

/** How a server is started again. */
export interface ServerSpec {
  base: string;
  startCommand?: string[];
  logFile?: string;
  env?: NodeJS.ProcessEnv;
  /** The endpoint's own environment for its server (config.json's `env`), over the starter's. */
  serverEnv?: Record<string, string>;
}

/** How long a server may go without answering, while nobody uses its accelerator, before it is restarted. */
export const UNANSWERED_MS = RULES.keeper.unansweredMs;
/** A server whose working set is this big, while nobody uses the NPU, is restarted: it is holding memory from earlier loads. */
export const RECYCLE_BYTES = RULES.keeper.recycleBytes;
/** How long nobody must have used a graphics card before its servers are stopped for a game. */
export const GAME_GRACE_MS = RULES.keeper.gameGraceMs;
/** How long nobody must have used the NPU before its servers are stopped for a call that doesn't translate. */
export const CALL_GRACE_MS = RULES.keeper.callGraceMs;
/** How long the requests under way on a card whose driver is changing may go on before its servers are stopped anyway. */
export const DRIVER_GRACE_MS = RULES.keeper.driverGraceMs;
/** How often the keeper reads driver-work.json beside watching its folder (watchDriverWork). */
export const DRIVER_LOOK_MS = 2_000;
/** How often the keeper looks. */
export const REAP_EVERY_MS = RULES.keeper.lookEveryMs;
/** How long an orphan is seen before it is stopped; 0 never stops one. */
export const ORPHAN_GRACE_MS = RULES.keeper.orphanGraceMs;
/**
 * An idle stop's turn taken later than this after it was asked for was waited for: someone held the accelerator after
 * the look found it unused, so it was used, and the stop waits for a later look. A free turn is taken in milliseconds.
 */
export const TURN_AT_ONCE_MS = 2_000;

/** A model server this looks after: where it answers, the program that serves it, and the accelerator it runs on. */
export interface ReapedServer {
  base: string;
  program: string;
  spec: ServerSpec;
  acc: { id: string; kind: AcceleratorKind; name: string };
  /** The accelerator's lock folders, one per slot. */
  lockDirs: string[];
  /** Unused this long, it is stopped; 0 never. None: the reaper's own `idleMs`. */
  idleMs?: number;
  /** Restarted when its working set reaches `recycleBytes` (GenieX's kept memory). */
  recycle?: boolean;
  /** Kept out (gpuWithNpu false, and the NPU serves its work): stopped as soon as nobody uses its accelerator, and never restarted here. */
  keptOut?: boolean;
}

export interface ServerProcess {
  pid: number;
  startedMs: number;
  workingSetBytes?: number;
}

/** A model server's process as Windows lists it, for the orphan check. */
export interface SeenProcess extends ServerProcess {
  /** Its program's full path (empty when Windows won't say). */
  path: string;
  /** Its command line. */
  line: string;
}

/** What one look did for one server. */
export type ReapOutcome =
  | { base: string; did: 'not-running' | 'in-use' | 'answering' }
  | { base: string; did: 'not-answering'; forMs: number }
  | { base: string; did: 'stopped'; pids: number[]; idleMs: number }
  | { base: string; did: 'stopped-for-game'; pids: number[]; by: string[] }
  | { base: string; did: 'stopped-for-call'; pids: number[]; by: string }
  | { base: string; did: 'stopped-for-driver'; pids: number[]; why: string }
  | { base: string; did: 'stopped-kept-out'; pids: number[] }
  | { base: string; did: 'restarted'; pids: number[]; silentMs: number }
  | { base: string; did: 'recycled'; pids: number[]; workingSetBytes: number }
  | { base: string; did: 'skipped'; why: string };

/** What the orphan check did for one process. */
export type OrphanOutcome = { pid: number; base: string; path: string; did: 'seen'; forMs: number } | { pid: number; base: string; path: string; did: 'stopped' };

/** The PC, as the reaper sees it: swapped in tests. */
export interface ReaperDeps {
  now: () => number;
  /** The program's processes serving `base`. */
  processes: (program: string, base: string) => Promise<ServerProcess[]>;
  stop: (pid: number) => void;
  probe: (base: string) => Promise<'ready' | 'busy' | 'loading' | 'down'>;
  /** Someone holds its accelerator's lock, or waits in its line. */
  inUse: (s: ReapedServer) => boolean;
  /** When someone last took its accelerator's lock, or joined or left its line: its own folders (ownActivityMs; ms since the epoch). */
  lastActivityMs: (s: ReapedServer) => number;
  /**
   * When anyone last took or let go of any accelerator's lock (locksActivityMs). Letting go leaves no other trace, so the
   * reaper counts this for an accelerator only when that one was in use since its last look. Without it, a request
   * counts from when it took the lock.
   */
  locksActivityMs?: (s: ReapedServer) => number;
  /** Runs `fn` holding all its accelerator's slots; throws when they can't be had at once (someone is in line). */
  withTurn: <T>(s: ReapedServer, fn: () => Promise<T>) => Promise<T>;
  /** The programs of a game using its graphics card now; empty or null when none is (or it isn't a card). */
  gameOn?: (s: ReapedServer) => Promise<string[] | null>;
  /** The call being captioned on the NPU now (npu-call.json, npuCallNow's), or null. */
  callOn?: () => core.NpuCall | null;
  /** What the Watchman is doing to its graphics card's driver now (driver-work.json, driverHoldsNow's), or null. */
  driverOn?: (s: ReapedServer) => DriverCard | null;
  start: (spec: ServerSpec) => Promise<unknown>;
  log: (line: string) => void;
  /** Every model server's process on this PC (llama-server, GenieX, and the configured programs), for the orphan check. */
  allProcesses?: () => Promise<SeenProcess[]>;
  /**
   * Whether a process is the manor's own (manorOwns): only such a process can be an orphan. Without it, none is: a
   * program on one of the manor's ports is never stopped for its port alone.
   */
  owned?: (p: SeenProcess) => boolean;
}

/** "the NPU", or the card's (or processor's) own name: whose lock a message is about. */
const theAcc = (s: ReapedServer) => (s.acc.kind === 'npu' ? 'the NPU' : s.acc.name);

export interface ReaperOptions {
  idleMs?: number;
  unansweredMs?: number;
  recycleBytes?: number;
  gameGraceMs?: number;
  callGraceMs?: number;
  driverGraceMs?: number;
  orphanGraceMs?: number;
  turnAtOnceMs?: number;
}

export class Reaper {
  private lastInUse = new Map<string, number>();
  /** Each accelerator's last look: its own lock folders' time then (0 when held), and whether someone held or waited on it. */
  private looked = new Map<string, { ownMs: number; held: boolean }>();
  private lastSkip = new Map<string, string>();
  private silentSince = new Map<string, number>();
  private orphanSince = new Map<number, number>();
  private deps: ReaperDeps;
  private o: ReaperOptions;

  constructor(deps: ReaperDeps, o: ReaperOptions = {}) {
    this.deps = deps;
    this.o = o;
  }

  /** One look at each server; what it did for each. */
  async look(servers: ReapedServer[]): Promise<ReapOutcome[]> {
    const out: ReapOutcome[] = [];
    for (const s of servers) {
      let r: ReapOutcome;
      try {
        r = await this.lookAt(s);
      } catch (e: any) {
        r = { base: s.base, did: 'skipped', why: String(e?.message ?? e) };
      }
      // A skip is logged once, not every minute it repeats.
      if (r.did === 'skipped') {
        if (this.lastSkip.get(s.base) !== r.why) this.deps.log(`left ${s.base} alone this time: ${r.why}`);
        this.lastSkip.set(s.base, r.why);
      } else this.lastSkip.delete(s.base);
      out.push(r);
    }
    return out;
  }

  private async lookAt(s: ReapedServer): Promise<ReapOutcome> {
    const d = this.deps;
    const procs = await d.processes(s.program, s.base);
    if (!procs.length) {
      this.silentSince.delete(s.base);
      return { base: s.base, did: 'not-running' };
    }
    // Its card's driver changing: stopped now, in use or not (kit 2.148.0, above).
    const changing = s.acc.kind === 'gpu' && d.driverOn ? d.driverOn(s) : null;
    if (changing) {
      const why = core.say.skippedDriver(s.acc, changing);
      let pids = await this.inTurn(s, false);
      if (!pids) {
        const grace = this.o.driverGraceMs ?? DRIVER_GRACE_MS;
        for (const t0 = Date.now(); d.inUse(s) && Date.now() - t0 < grace; ) await sleep(250);
        pids = (await this.inTurn(s, false)) ?? (await this.stopNow(s));
      }
      this.silentSince.delete(s.base);
      d.log(`stopped ${path.win32.basename(s.program)} (${pids.join(', ')}) at ${s.base}: ${why}`);
      return { base: s.base, did: 'stopped-for-driver', pids, why };
    }
    if (d.inUse(s)) {
      this.lastInUse.set(s.acc.id, d.now());
      this.looked.set(s.acc.id, { ownMs: 0, held: true });
      this.silentSince.delete(s.base);
      return { base: s.base, did: 'in-use' };
    }
    const taken = { base: s.base, did: 'skipped' as const, why: `${theAcc(s)} was taken in the meantime` };
    const program = path.win32.basename(s.program);
    if (s.keptOut) {
      const pids = await this.inTurn(s, false);
      if (!pids) return taken;
      d.log(`stopped ${program} (${pids.join(', ')}) at ${s.base}: Castellan's Settings keep the graphics card out while the NPU serves (gpuWithNpu is off)`);
      return { base: s.base, did: 'stopped-kept-out', pids };
    }
    const own = d.lastActivityMs(s);
    const lastUse = Math.max(this.lastInUse.get(s.acc.id) ?? 0, own, this.letGoMs(s, own), ...procs.map((p) => p.startedMs));
    const idleMs = d.now() - lastUse;
    const idleStopMs = s.idleMs ?? this.o.idleMs ?? 0;
    if (idleStopMs > 0 && idleMs >= idleStopMs) {
      const pids = await this.inTurn(s, false, true);
      if (pids === 'used') {
        this.lastInUse.set(s.acc.id, d.now());
        this.looked.set(s.acc.id, { ownMs: 0, held: true });
        return { base: s.base, did: 'in-use' };
      }
      if (!pids) return taken;
      d.log(`stopped ${program} (${pids.join(', ')}) at ${s.base}: ${theAcc(s)} unused for ${Math.round(idleMs / 60_000)} min`);
      return { base: s.base, did: 'stopped', pids, idleMs };
    }
    if (s.acc.kind === 'gpu' && d.gameOn && idleMs >= (this.o.gameGraceMs ?? GAME_GRACE_MS)) {
      const by = (await d.gameOn(s)) ?? [];
      if (by.length) {
        const pids = await this.inTurn(s, false);
        if (!pids) return taken;
        d.log(`stopped ${program} (${pids.join(', ')}) at ${s.base}: ${by.join(', ')} is using ${theAcc(s)}, and gets its memory back`);
        return { base: s.base, did: 'stopped-for-game', pids, by };
      }
    }
    if (s.acc.kind === 'npu' && d.callOn && idleMs >= (this.o.callGraceMs ?? CALL_GRACE_MS)) {
      const call = d.callOn();
      if (call && !call.translating) {
        const pids = await this.inTurn(s, false);
        if (!pids) return taken;
        d.log(`stopped ${program} (${pids.join(', ')}) at ${s.base}: ${call.by} is captioning a call on the NPU without translating, and has it to itself`);
        return { base: s.base, did: 'stopped-for-call', pids, by: call.by };
      }
    }
    const ws = Math.max(0, ...procs.map((p) => p.workingSetBytes ?? 0));
    const recycleBytes = this.o.recycleBytes ?? RECYCLE_BYTES;
    if (s.recycle && recycleBytes > 0 && ws >= recycleBytes) {
      const pids = await this.inTurn(s, true);
      if (!pids) return taken;
      this.silentSince.delete(s.base);
      d.log(`restarted ${program} (was ${pids.join(', ')}) at ${s.base}: it held ${(ws / 1024 ** 3).toFixed(1)} GB, memory kept from earlier model loads`);
      return { base: s.base, did: 'recycled', pids, workingSetBytes: ws };
    }
    const state = await d.probe(s.base);
    if (state === 'ready') {
      this.silentSince.delete(s.base);
      return { base: s.base, did: 'answering' };
    }
    // Busy or not listening, with nobody using its accelerator: a request someone gave up on may still
    // be running, so it gets a while before it counts.
    const since = this.silentSince.get(s.base) ?? d.now();
    this.silentSince.set(s.base, since);
    const silentMs = d.now() - since;
    if (silentMs < (this.o.unansweredMs ?? UNANSWERED_MS)) return { base: s.base, did: 'not-answering', forMs: silentMs };
    const pids = await this.inTurn(s, true);
    if (!pids) return taken;
    this.silentSince.delete(s.base);
    d.log(`restarted ${program} (was ${pids.join(', ')}) at ${s.base}: running, but ${state === 'down' ? 'not listening' : 'not answering'} for ${Math.round(silentMs / 1000)} s`);
    return { base: s.base, did: 'restarted', pids, silentMs };
  }

  /**
   * When someone last let go of this accelerator, as far as the folder every lock shares tells (`own`: when its lock was
   * last taken): that folder's time, but only when this accelerator was in use since the last look (held or waited on
   * then, or taken since: `own` moved since, one file time against another, never against the clock, as lastUseMs), so
   * another accelerator's lock never counts. At the reaper's first look, no later than a holder may keep a slot after
   * taking it (rules.json's lock.staleMs). 0 when it can't tell. Remembered as use.
   */
  private letGoMs(s: ReapedServer, own: number): number {
    const d = this.deps;
    const now = d.now();
    const was = this.looked.get(s.acc.id);
    this.looked.set(s.acc.id, { ownMs: own, held: false });
    if (!d.locksActivityMs) return 0;
    const shared = d.locksActivityMs(s);
    const ms = was ? (was.held || own > was.ownMs ? Math.min(shared, now) : 0) : own > 0 ? Math.min(shared, own + RULES.lock.staleMs) : 0;
    if (ms > 0) this.lastInUse.set(s.acc.id, Math.max(this.lastInUse.get(s.acc.id) ?? 0, ms));
    return ms;
  }

  /**
   * Stops the server's processes (and starts it again) holding its accelerator's slots. Null when
   * someone took one since the look: then it waits for the next. With `atOnce` (an idle stop), 'used' when the turn
   * wasn't had at once: someone held the accelerator in the meantime, so it isn't idle, and nothing is stopped.
   */
  private async inTurn(s: ReapedServer, restart: false, atOnce: true): Promise<number[] | null | 'used'>;
  private async inTurn(s: ReapedServer, restart: boolean): Promise<number[] | null>;
  private async inTurn(s: ReapedServer, restart: boolean, atOnce = false): Promise<number[] | null | 'used'> {
    const d = this.deps;
    const asked = d.now();
    return d
      .withTurn(s, async (): Promise<number[] | 'used'> => {
        if (atOnce && d.now() - asked > (this.o.turnAtOnceMs ?? TURN_AT_ONCE_MS)) return 'used';
        const procs = await d.processes(s.program, s.base);
        for (const p of procs) d.stop(p.pid);
        for (let i = 0; i < 40 && (await d.processes(s.program, s.base)).length; i++) await sleep(250);
        if (restart) await d.start(s.spec);
        return procs.map((p) => p.pid);
      })
      .catch((e: unknown) => {
        if (e instanceof QueueFull || e instanceof LockTimeout) return null;
        throw e;
      });
  }

  /**
   * Stops the server's processes outside its turn, which someone holds: only for a card whose driver is changing, once
   * the requests under way there had their grace. The pids it stopped.
   */
  private async stopNow(s: ReapedServer): Promise<number[]> {
    const d = this.deps;
    const procs = await d.processes(s.program, s.base);
    for (const p of procs) d.stop(p.pid);
    for (let i = 0; i < 40 && (await d.processes(s.program, s.base)).length; i++) await sleep(250);
    return procs.map((p) => p.pid);
  }

  /**
   * The orphan check: a model server's process that is the manor's own (`owned`: its program is in the manor's
   * servers folders, or the manor started it), on one of the manor's ports, that none of `servers` is (another
   * program, or another port), seen for `orphanGraceMs` in a row, is stopped. Never a process for its port alone: a
   * program someone else runs (their own GenieX on its default 18181, say), or one whose program Windows won't name,
   * is left alone. A process gone, or known again, starts its count afresh.
   */
  async orphans(servers: ReapedServer[]): Promise<OrphanOutcome[]> {
    const d = this.deps;
    const grace = this.o.orphanGraceMs ?? ORPHAN_GRACE_MS;
    if (!d.allProcesses || !d.owned) return [];
    const seen = await d.allProcesses();
    const ports = manorPorts(servers);
    const out: OrphanOutcome[] = [];
    const still = new Set<number>();
    for (const p of seen) {
      const base = baseOf(p.line);
      if (!base || !ports.has(Number(new URL(base).port))) continue;
      if (servers.some((s) => sameProgram(p.path, s.program) && servesBase(p.line, s.base))) continue;
      if (!p.path || !d.owned(p)) continue;
      still.add(p.pid);
      const since = this.orphanSince.get(p.pid) ?? d.now();
      this.orphanSince.set(p.pid, since);
      const forMs = d.now() - since;
      if (grace <= 0 || forMs < grace) {
        if (forMs === 0) d.log(`saw an orphan: ${path.win32.basename(p.path || 'a model server')} (${p.pid}) at ${base}, which no configured server is (${p.path || '?'}: ${p.line.slice(0, 300)})`);
        out.push({ pid: p.pid, base, path: p.path, did: 'seen', forMs });
        continue;
      }
      d.stop(p.pid);
      this.orphanSince.delete(p.pid);
      still.delete(p.pid);
      d.log(`stopped an orphan: ${path.win32.basename(p.path || 'a model server')} (${p.pid}) at ${base}, ${(Math.max(0, p.workingSetBytes ?? 0) / 1024 ** 3).toFixed(1)} GB, seen for ${Math.round(forMs / 60_000)} min with no configured server its own (${p.path || '?'}: ${p.line.slice(0, 300)})`);
      out.push({ pid: p.pid, base, path: p.path, did: 'stopped' });
    }
    for (const pid of [...this.orphanSince.keys()]) if (!still.has(pid)) this.orphanSince.delete(pid);
    return out;
  }
}

/** The manor's model servers' ports: GenieX's 18181, setup's 18191-18199, npu-embed's 18282, and every configured server's. */
export function manorPorts(servers: Pick<ReapedServer, 'base'>[]): Set<number> {
  const ports = new Set<number>([18181, 18282]);
  for (let p = 18191; p <= 18199; p++) ports.add(p);
  for (const s of servers) {
    const p = Number(new URL(s.base).port);
    if (p) ports.add(p);
  }
  return ports;
}

/**
 * The same program, by its real path (spec/DEV-DRIVES.md): Windows names a process's program as it was started, through
 * a junction or a mounted folder if it was, and a setting may name it the other way. A path Windows wouldn't give (an
 * elevated process) is never a match.
 */
export const sameProgram = (a: string, b: string) => !!a && !!b && samePath(a, b);

/**
 * The manor's own servers folders, where setup puts what it installs: the tools home's `servers` (toolsHome: the
 * accelerators' folder, or %USERPROFILE%\.reeve on a PC set up before kit 2.31.0), the accelerators' folder's, and
 * Reeve's, each once, however each is spelled.
 */
export function manorServerDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const dirs = [path.join(toolsHome(env, home), 'servers'), path.join(acceleratorsHome(env), 'servers'), ...(env.REEVE_HOME ? [] : [path.join(home, '.reeve', 'servers')])];
  return [...new Map(dirs.map((d) => [pathKey(d), d])).values()];
}

/** `file` is inside `dir` (not `dir` itself), by their real paths. */
const isUnder = (file: string, dir: string) => {
  const [f, d] = [pathKey(file), pathKey(dir)];
  return f !== d && keyInside(f, d);
};

/**
 * Whether a model server's process is the manor's own, and so may be stopped as an orphan: its program's path is
 * known (an unreadable path is never the manor's) and is in one of the manor's servers folders (`dirs`), or a record
 * says the manor started this very process (`started`, accelerators.ts' noteStarted: the same pid and program,
 * started within a minute of the record). A program on a manor port for any other reason (a person's own GenieX,
 * Ollama, a test's server) is not.
 */
export function manorOwns(p: Pick<SeenProcess, 'pid' | 'path' | 'startedMs'>, o: { dirs: string[]; started?: StartedServer[] }): boolean {
  if (!p.path) return false;
  if (o.dirs.some((d) => isUnder(p.path, d))) return true;
  return (o.started ?? []).some((r) => r.pid === p.pid && sameProgram(p.path, r.program) && Math.abs(p.startedMs - r.atMs) <= 60_000);
}

/** The programs an NPU's own embedding server is run with, which the keeper looks after: llama-server (Qualcomm's, on the Hexagon) and OpenVINO Model Server (Intel's). */
const NPU_EMBED_SERVER = /^(llama-server|ovms)(\.exe)?$/i;

/** An accelerator's lock folders, one per slot: the kit's (the NPU's lock for the NPU; `<locks>\<id>`, `<id>.2` … for the others). */
export const lockDirsOf = (a: Pick<Accelerator, 'id' | 'kind' | 'slots'>): string[] => kitLockDirsOf({ id: a.id, slots: a.kind === 'npu' ? 1 : a.slots });

/**
 * The other device whose turn a kind's server takes (its endpoint's `turn`, a vision endpoint on its chat endpoint's
 * server by that one's): its id, kind, name (its entry's, else this PC's, hardware.json) and slots (its entry's, else
 * one). Null when it takes its own accelerator's.
 */
export function otherTurn(a: Accelerator, kind: EndpointKind, list: Accelerator[]): { id: string; kind: AcceleratorKind; name: string; slots: number } | null {
  const id = kind === 'vision' && !a.vision?.baseUrl ? a.chat?.turn : a[kind]?.turn;
  const k = id && id !== a.id ? kindOfId(id) : null;
  if (!id || !k || k === 'npu') return null;
  const entry = list.find((x) => x.id === id);
  return { id, kind: k, name: entry?.name ?? core.acceleratorName(k, id, readHardware()), slots: entry?.slots ?? 1 };
}

/**
 * The model servers the keeper can start again, each with its accelerator's idle time: an NPU's chat, vision and
 * embedding endpoints (the embedding one when llama-server runs it, Qualcomm's on the Hexagon, or OpenVINO Model
 * Server, Intel's; npu-embed exits by itself), and a graphics card's or the processor's chat, vision, embedding and
 * reranking endpoints, when they have a startCommand. `lockDirs` gives an accelerator's lock folders (or is the NPU's lock
 * folder, the others beside it, as Reeve's reaper took it). `keptOut` marks a card's servers while gpuWithNpu keeps the card out
 * (`keepGpuOut`), all but those for the work no NPU here serves and the work the PC's order (`workOrder`) puts the card
 * first for (the core's withoutGpuBesideNpu): the card on demand.
 * `idle.npuMsFor`, when given, is an NPU server's own idle time by its program and kind, over `idle.npuMs`;
 * `idle.otherMsFor`, a card's or the processor's own by its accelerator, over `idle.otherMs` (undefined: `otherMs`).
 */
export function reapedServers(
  accelerators: Accelerator[],
  logDir = serverLogsDir(),
  idle: { npuMs?: number; otherMs?: number; npuMsFor?: (program: string, kind: EndpointKind) => number; otherMsFor?: (a: Accelerator) => number | undefined } = {},
  lockDirs: ((a: Accelerator) => string[]) | string = lockDirsOf,
  o: { keepGpuOut?: boolean; workOrder?: core.WorkOrder } = {},
): ReapedServer[] {
  const out = new Map<string, ReapedServer>();
  // The card's servers it still runs on demand beside the NPU: the keeper's own idle stop looks after them.
  const onDemand = new Set<string>();
  if (o.keepGpuOut) {
    for (const k of core.withoutGpuBesideNpu(accelerators, false, o.workOrder)) {
      if (k.kind !== 'gpu') continue;
      for (const kind of ENDPOINT_KINDS) {
        try {
          if (k[kind]?.model) onDemand.add(endpointFor(k, kind).baseUrl);
        } catch {
          // no server of its own: nothing to keep
        }
      }
    }
  }
  for (const a of accelerators) {
    if (a.enabled === false) continue;
    // An NPU's embed endpoint is looked after when llama-server (Qualcomm's, on the Hexagon) or OpenVINO Model Server
    // (Intel's: 1.7 GB, kept until it was stopped, before kit 2.71.0) runs it; npu-embed exits by itself.
    const npuEmbed = NPU_EMBED_SERVER.test(path.win32.basename(expandEnv(a.embed?.startCommand?.[0] ?? '')));
    // Its reranker too (kit 2.100.0): that llama-server, started a third time.
    const npuRerank = NPU_EMBED_SERVER.test(path.win32.basename(expandEnv(a.rerank?.startCommand?.[0] ?? '')));
    const kinds: EndpointKind[] = a.kind === 'npu' ? ['chat', 'vision', ...(npuEmbed ? (['embed'] as const) : []), ...(npuRerank ? (['rerank'] as const) : [])] : ['chat', 'vision', 'embed', 'rerank'];
    for (const kind of kinds) {
      if (!a[kind]?.model) continue;
      let ep: ReturnType<typeof endpointFor>;
      try {
        ep = endpointFor(a, kind);
      } catch {
        continue;
      }
      if (!ep.startCommand?.length || out.has(ep.baseUrl)) continue;
      const idleMs = a.kind === 'npu' ? (idle.npuMsFor?.(expandEnv(ep.startCommand[0]), kind) ?? idle.npuMs) : (idle.otherMsFor?.(a) ?? idle.otherMs);
      // A server on another device (its endpoint's `turn`: the NPU 3720's embeddings, on the processor's graphics) is
      // used, and stopped, in that device's turn, not its accelerator's.
      const on = otherTurn(a, kind, accelerators);
      out.set(ep.baseUrl, {
        base: ep.baseUrl,
        program: expandEnv(ep.startCommand[0]),
        spec: { base: ep.baseUrl, startCommand: ep.startCommand, ...(ep.env ? { serverEnv: ep.env } : {}), logFile: path.join(logDir, `${a.id}.${kind === 'vision' && !a.vision?.baseUrl ? 'chat' : kind}.log`) },
        acc: on ? { id: on.id, kind: on.kind, name: on.name } : { id: a.id, kind: a.kind, name: a.name },
        lockDirs: on
          ? typeof lockDirs === 'string'
            ? slotDirs(path.join(path.dirname(lockDirs), on.id), on.slots)
            : lockDirs({ ...a, id: on.id, kind: on.kind, slots: on.slots })
          : typeof lockDirs === 'string'
            ? a.kind === 'npu'
              ? [lockDirs]
              : slotDirs(path.join(path.dirname(lockDirs), a.id), a.slots)
            : lockDirs(a),
        ...(idleMs !== undefined ? { idleMs } : {}),
        // GenieX alone keeps memory from every model load until it exits: the NPU's other servers aren't recycled.
        ...(a.kind === 'npu' && /geniex/i.test(path.win32.basename(expandEnv(ep.startCommand[0]))) ? { recycle: true } : {}),
        ...(o.keepGpuOut && a.kind === 'gpu' && !onDemand.has(ep.baseUrl) ? { keptOut: true } : {}),
      });
    }
  }
  return [...out.values()];
}

const arg = (commandLine: string, name: string) => new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)"?([^\\s"]+)"?`, 'i').exec(commandLine)?.[1];

/** The model servers the keeper knows by their command lines, each with how it's given its address and its default port. */
const SERVERS: { program: RegExp; host: string; port: string; defaultPort: number }[] = [
  { program: /llama-server/i, host: 'host', port: 'port', defaultPort: 8080 },
  { program: /geniex/i, host: 'host', port: 'port', defaultPort: 18181 },
  // OpenVINO Model Server (an Intel NPU's): --rest_port, --rest_bind_address (all addresses without it).
  { program: /(^|[\\/"\s])ovms(\.exe)?["\s]/i, host: 'rest_bind_address', port: 'rest_port', defaultPort: 0 },
  // FastFlowLM (an AMD NPU's): flm serve --port, 52625 without it.
  { program: /(^|[\\/"\s])flm(\.exe)?["\s]/i, host: 'host', port: 'port', defaultPort: 52625 },
];

/** The host:port a server's command line serves, by its kind's flags; null when it's none the keeper knows. */
function hostOf(commandLine: string): string | null {
  const s = SERVERS.find((x) => x.program.test(`${commandLine} `));
  if (!s) return null;
  let host = (arg(commandLine, s.host) ?? '127.0.0.1').replace(/^https?:\/\//i, '');
  if (host === '0.0.0.0') host = '127.0.0.1';
  const port = arg(commandLine, s.port);
  if (port) host = `${host.replace(/:\d+$/, '')}:${port}`;
  else if (!/:\d+$/.test(host)) {
    if (!s.defaultPort) return null;
    host = `${host}:${s.defaultPort}`;
  }
  return host;
}

/**
 * The address a server's command line serves: GenieX takes `--host <host:port>` (127.0.0.1:18181 without it),
 * llama.cpp's server `--host <host>` and `--port <port>` (127.0.0.1 and 8080 without them), OpenVINO Model Server
 * `--rest_port`, FastFlowLM `--port` (52625 without it). Null for a command line that is none of them.
 */
export function baseOf(commandLine: string): string | null {
  const host = hostOf(commandLine);
  if (!host) return null;
  try {
    return new URL(`http://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a server's command line serves `base`: GenieX takes `--host <host:port>` (127.0.0.1:18181 without it),
 * llama.cpp's server `--host <host>` and `--port <port>` (127.0.0.1 and 8080 without them), so another server on
 * another port (a test's, say, or another card's) is left alone.
 */
export function servesBase(commandLine: string, base: string): boolean {
  return hostOf(commandLine) === new URL(base).host;
}

/** WQL's `Name='<name>'`: in a WQL string, a backslash and a quote are each escaped with a backslash. */
export const wqlName = (name: string) => `Name='${name.replace(/[\\']/g, (c) => `\\${c}`)}'`;

/** Windows' processes that match a WQL filter, handed to PowerShell as a single-quoted literal, never as code. */
const listProcesses = async (filter: string): Promise<SeenProcess[]> => {
  const out = await powershell(
    `Get-CimInstance Win32_Process -Filter ${psQuote(filter)} |ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; path = [string]$_.ExecutablePath; line = [string]$_.CommandLine; started = $_.CreationDate.ToUniversalTime().ToString('o'); ws = [double]$_.WorkingSetSize } } | ConvertTo-Json -Compress`,
    { timeoutMs: 30_000 },
  );
  const rows = out.trim() ? [JSON.parse(out)].flat() : [];
  return rows.map((r: any) => ({ pid: r.pid, path: r.path ?? '', line: r.line ?? '', startedMs: Date.parse(r.started) || 0, workingSetBytes: Number(r.ws) || 0 }));
};

/** The program's processes serving `base`, from Windows' process list. */
export async function serverProcesses(program: string, base: string): Promise<ServerProcess[]> {
  const rows = await listProcesses(wqlName(path.win32.basename(program)));
  return rows.filter((r) => sameProgram(r.path, program) && servesBase(r.line, base)).map(({ pid, startedMs, workingSetBytes }) => ({ pid, startedMs, workingSetBytes }));
}

/** Stops whatever `program` serves `base`, and waits until it's gone (10 s at most): the NPU's refresh and patch, and setup between its tries of the NPU's models. */
export async function stopServerAt(program: string, base: string): Promise<void> {
  for (const p of await serverProcesses(program, base)) {
    try {
      process.kill(p.pid);
    } catch {}
  }
  for (let i = 0; i < 40 && (await serverProcesses(program, base)).length; i++) await sleep(250);
}

/** Every llama-server's and GenieX's process on this PC, and every other program the servers are started with. */
export async function modelServerProcesses(programs: string[] = []): Promise<SeenProcess[]> {
  const names = [...new Set(['llama-server.exe', 'geniex.exe', ...programs.map((p) => path.win32.basename(p).toLowerCase())])].filter((n) => /\.exe$/i.test(n) && !/^python/i.test(n));
  return listProcesses(names.map(wqlName).join(' OR '));
}

const mtimeMs = (p: string) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * When someone last took an accelerator's lock, from its own folders' times: taking a slot creates its folder, and
 * joining or leaving its line changes its queue folder. Letting go removes the slot's folder, which leaves its time only
 * on the folder every accelerator's lock shares (`locksActivityMs`), so it isn't counted here: another accelerator's
 * lock would count with it. The keeper's idle time is this, and a let-go from the shared folder only when this
 * accelerator was in use since its last look (Reaper). Before kit 2.77.6 it was `lastActivityMs`, and a card busy
 * indexing kept the NPU's servers up, or the NPU a card's.
 */
export function ownActivityMs(lockDirs: string | string[]): number {
  const dirs = [lockDirs].flat();
  return Math.max(...dirs.map(mtimeMs), mtimeMs(queueDirFor(dirs[0])));
}

/** When anyone last took or let go of any accelerator's lock: the time of the folder their lock folders share. */
export function locksActivityMs(lockDirs: string | string[]): number {
  return mtimeMs(path.dirname([lockDirs].flat()[0]));
}

/**
 * When anyone last took or let go of an accelerator's lock, or joined or left this one's line: its own folders and the
 * folder every lock shares, so another accelerator's lock counts too, and the agents' work turns (pace.ts' locks
 * live there as well). For a look at whether anything changed at all (the Smith's quiet look); an accelerator's idle
 * time is `ownActivityMs`, and the NPU refresh's quiet wait `lastUseMs`.
 */
export function lastActivityMs(lockDirs: string | string[]): number {
  return Math.max(locksActivityMs(lockDirs), ownActivityMs(lockDirs));
}

const useLooks = new Map<string, { ownMs: number; held: boolean; usedMs: number }>();

/**
 * When an accelerator was last in use, for a look a process takes again and again (the NPU refresh's quiet wait, at each
 * of the keeper's looks): held or waited on now, when its lock was last taken (`ownActivityMs`), and when it was let go,
 * reckoned as the Reaper does (`letGoMs`): the folder every lock shares, but only when this accelerator was in use since
 * this process's last look, and at its first look no later than a holder may keep a slot. Until kit 2.82.3 the wait
 * counted every change to that folder, and the agents' work turns are there too: on a PC with the Smith's rounds a
 * few minutes apart, the NPU was never quiet for 2 minutes, and the patch look waited for hours.
 *
 * In use since the last look: held then, or its own folders' time has moved since (one file time against another). It
 * was once set against the clock at the last look, and on Windows a folder's time is often a millisecond or two ahead of
 * Date.now() read just after the change: a slot taken just before a look counted as taken after it, and the shared
 * folder's next change, an agent's work turn say, as its let-go.
 */
export function lastUseMs(lockDirs: string | string[], now = Date.now()): number {
  const dirs = [lockDirs].flat();
  const l = lineState(dirs);
  const held = !!(l.held || l.waiting);
  const own = ownActivityMs(dirs);
  const was = useLooks.get(dirs[0]);
  const shared = locksActivityMs(dirs);
  const letGo = was ? (was.held || own > was.ownMs ? Math.min(shared, now) : 0) : own > 0 ? Math.min(shared, own + RULES.lock.staleMs) : 0;
  const usedMs = Math.max(was?.usedMs ?? 0, own, letGo, held ? now : 0);
  useLooks.set(dirs[0], { ownMs: own, held, usedMs });
  return usedMs;
}

/** Holds each folder's lock in turn (a plain mutex, at once or LockTimeout), then runs `fn`. */
function holdingAll<T>(dirs: string[], fn: () => Promise<T>): Promise<T> {
  if (!dirs.length) return fn();
  return withLock(dirs[0], () => holdingAll(dirs.slice(1), fn), { waitMs: RULES.keeper.otherSlotsWaitMs });
}

/**
 * The keeper's turn on an accelerator: background, and only into an empty line (`maxAhead` 1, rules.json's
 * turnMaxAhead: the kit refuses to join when that many already wait; 0 would refuse every turn), so it never
 * makes anyone wait; QueueFull or LockTimeout else. On a card with more than one slot, it then holds the others
 * too (free, since nobody waits), so no request starts on the server it stops.
 */
export function reaperTurn<T>(lockDirs: string | string[], fn: () => Promise<T>, who = 'keeper', staleMs?: number): Promise<T> {
  const dirs = [lockDirs].flat();
  return withAcceleratorTurn(dirs, (slot) => holdingAll(dirs.filter((_, i) => i !== slot), fn), { who, lane: 'background', waitMs: RULES.keeper.turnWaitMs, maxAhead: RULES.keeper.turnMaxAhead, ...(staleMs ? { staleMs } : {}) });
}

/** Appends a line to a log, never throwing. */
export function logLine(file: string, line: string): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** The keeper's log: %USERPROFILE%\.reeve\servers\logs\reaper.log, where Reeve's reaper always wrote it (serverLogsDir's). */
export const reaperLog = (env: NodeJS.ProcessEnv = process.env) => path.join(serverLogsDir(env), 'reaper.log');

/** The reapers pcReaper made: keeperLook asks the PC itself (hardware, the cards', the NPU's commands) only for these. */
const pcReapers = new WeakSet<Reaper>();

/** Whether keeperLook asks the PC itself before its look: only with the PC's own reaper (pcReaper's), never a test's. */
export const asksPc = (reaper: Reaper) => pcReapers.has(reaper);

/** The real PC's reaper. `who` names it in the lines it waits in ("smith", "reeve"); `log` takes its lines in the keeper's log's place. */
export function pcReaper(o: { who?: string; logFile?: string; log?: (line: string) => void; config?: () => Record<string, any>; options?: ReaperOptions } = {}): Reaper {
  const logFile = o.logFile ?? reaperLog();
  const config = o.config ?? (() => readConfigFile().raw);
  const reaper = new Reaper(
    {
      now: Date.now,
      processes: serverProcesses,
      stop: (pid) => {
        try {
          process.kill(pid);
        } catch {}
      },
      probe: (base) => kitProbe(base),
      inUse: (s) => {
        const l = lineState(s.lockDirs);
        return l.held > 0 || l.waiting > 0;
      },
      lastActivityMs: (s) => ownActivityMs(s.lockDirs),
      locksActivityMs: (s) => locksActivityMs(s.lockDirs),
      withTurn: (s, fn) => reaperTurn(s.lockDirs, fn, o.who),
      gameOn: async (s) => {
        const games = await currentGames(configuredAccelerators(config()) as unknown as KitAccelerator[]);
        const card = games?.cards?.[s.acc.id];
        return card?.busy ? card.by : null;
      },
      callOn: () => npuCallNow(),
      driverOn: (s) => driverHoldsNow([s.acc])[s.acc.id] ?? null,
      start: (spec) => ensureServer({ baseUrl: spec.base, model: '', startCommand: spec.startCommand, ...(spec.serverEnv ? { env: spec.serverEnv } : {}) }, { logFile: spec.logFile, env: spec.env }),
      log: o.log ?? ((line) => logLine(logFile, line)),
      allProcesses: () => modelServerProcesses(configuredAccelerators(config()).flatMap((a) => ENDPOINT_KINDS.map((k) => a[k]?.startCommand?.[0] ?? '')).filter(Boolean).map((p) => expandEnv(p))),
      owned: (p) => manorOwns(p, { dirs: manorServerDirs(), started: readStarted() }),
    },
    o.options,
  );
  pcReapers.add(reaper);
  return reaper;
}

/**
 * The servers as config.json has them now, each with its accelerator's idle time, and the card kept out when Manor says so.
 * The NPU's: config.json's npuIdleStopMinutes for every NPU server when it gives one (0 never stops them), on any PC;
 * without it, each server's own by this PC's memory (`ramBytes`, os.totalmem() when not given): its route's minutes on
 * a PC with little memory, rules.json's elsewhere (npu-vendors.ts' npuIdleStopMinutes). A card's and the processor's:
 * config.json's gpuIdleStopMinutes when it gives one, on any PC; without it, on a PC with little memory, a card that
 * shares the PC's memory by the NPU's rule (npu-vendors.ts' cardIdleStopMinutes), rules.json's for every other.
 */
export function serversToReap(raw: Record<string, any>, o: { withNpu?: boolean; logDir?: string; ramBytes?: number | null } = {}): ReapedServer[] {
  const k = keeperSettings(raw);
  const accs = configuredAccelerators(raw);
  const given = raw?.npuIdleStopMinutes === k.npuIdleStopMinutes;
  const gpuGiven = raw?.gpuIdleStopMinutes === k.gpuIdleStopMinutes;
  const ramBytes = o.ramBytes === undefined ? os.totalmem() : o.ramBytes;
  // The NPU's reranker stops as its embedding server does: the same program, as quick to start again.
  const npuMsFor = given ? undefined : (program: string, kind: EndpointKind) => npuIdleStopMinutes({ program, kind: kind === 'rerank' ? 'embed' : kind, ramBytes, otherwise: k.npuIdleStopMinutes }) * 60_000;
  const otherMsFor = gpuGiven ? undefined : (a: Accelerator) => (a.kind === 'gpu' ? cardIdleStopMinutes({ memoryGb: a.memoryGb, ramBytes, otherwise: k.gpuIdleStopMinutes }) * 60_000 : undefined);
  const workOrder = core.workOrderIn(raw);
  return reapedServers(accs, o.logDir, { npuMs: k.npuIdleStopMinutes * 60_000, otherMs: k.gpuIdleStopMinutes * 60_000, npuMsFor, otherMsFor }, undefined, { keepGpuOut: gpuKeptOut(accs, o.withNpu ?? gpuWithNpu().on, workOrder), workOrder });
}

// ------------------------------------------------------------------------------------------------
// The NPU's embedding server gives way to its chat

/** The NPU's own embedding server, when it has one apart from its chat's (Qualcomm's llama-server, Intel's second OpenVINO Model Server): where it answers and its program. */
export function ownEmbedServer(acc: Pick<KitAccelerator, 'kind' | 'chat' | 'vision' | 'embed'>): { base: string; program: string } | null {
  const ep = acc.embed;
  if (acc.kind !== 'npu' || !ep?.model || !ep.baseUrl || !ep.startCommand?.length) return null;
  const program = expandEnv(ep.startCommand[0]);
  if (!NPU_EMBED_SERVER.test(path.win32.basename(program))) return null;
  if (ep.baseUrl === acc.chat?.baseUrl || ep.baseUrl === acc.vision?.baseUrl) return null;
  // One whose requests take another device's turn (an endpoint's `turn`) may be answering beside the chat: its own turn's.
  if ((ep as { turn?: unknown }).turn) return null;
  return { base: ep.baseUrl, program };
}

/** The PC, as the embedding server's giving way sees it: swapped in tests. */
export interface YieldDeps {
  probe: (base: string) => Promise<'ready' | 'busy' | 'loading' | 'down'>;
  processes: (program: string, base: string) => Promise<ServerProcess[]>;
  stop: (pid: number) => void;
  log: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}

/** What giving way did: stopped the embedding server, or why it didn't. */
export type YieldOutcome = { did: 'stopped'; base: string; pids: number[]; ms: number } | { did: 'kept'; why: 'none' | 'big-pc' | 'given' | 'in-use' | 'not-running' | 'busy' | 'not-found' | 'slow' };

/** How long finding the embedding server's processes, then their going, may hold up a chat before it goes on beside them. */
export const YIELD_FIND_MS = 5_000;
export const YIELD_GONE_MS = 10_000;
/**
 * Embeddings answered this recently are in use, and keep their server: a person's search right after a summary, an index
 * being built between chats. On the manor's traffic (2026-10-15, two hours) the embedding server giving way to every chat
 * would have started it again 4 times an hour more; giving way only after 30 s without an embedding, once.
 */
export const YIELD_GRACE_MS = 30_000;

/**
 * The NPU's embedding server gives way to its chat on a PC with little memory (under npu-vendors.json's
 * idleStop.smallPcGb): a chat or vision request that takes the NPU's turn while the NPU's own embedding server
 * (ownEmbedServer) runs stops it first, so the chat has its memory: on a Snapdragon 1,408 MB of the NPU's and a 2.0 GB
 * working set, Intel's 1.7 GB. Only the embedding side yields: it starts again for the next embedding in 2 to 3 s
 * (idleStop.coldStartMs.embed), where GenieX loads its model in 9 to 17 s, so a chat is never stopped for embeddings.
 * It runs in the chat's own turn, so no embedding is in flight, and only when the NPU hasn't answered an embedding for
 * YIELD_GRACE_MS (`embeddedAt`: accelerators.ts' noteEmbedded). When config.json gives npuIdleStopMinutes (`given`),
 * the servers stay as long as it says, and this keeps the embedding server too. Never throws, and gives up rather than
 * hold the chat past YIELD_FIND_MS and YIELD_GONE_MS.
 */
export async function yieldEmbedServer(
  acc: Pick<KitAccelerator, 'kind' | 'chat' | 'vision' | 'embed'>,
  o: { ramBytes: number | null | undefined; given: () => boolean; embeddedAt?: () => number | null; graceMs?: number; findMs?: number; goneMs?: number },
  d: YieldDeps,
): Promise<YieldOutcome> {
  const own = ownEmbedServer(acc);
  if (!own) return { did: 'kept', why: 'none' };
  if (!smallPc(o.ramBytes)) return { did: 'kept', why: 'big-pc' };
  try {
    if (o.given()) return { did: 'kept', why: 'given' };
    const last = o.embeddedAt?.() ?? null;
    if (last !== null && d.now() - last < (o.graceMs ?? YIELD_GRACE_MS)) return { did: 'kept', why: 'in-use' };
    const t0 = d.now();
    const state = await d.probe(own.base);
    if (state === 'down') return { did: 'kept', why: 'not-running' };
    // Loading (OpenVINO compiling its model, say): stopping it would only waste that.
    if (state !== 'ready') return { did: 'kept', why: 'busy' };
    const procs = await within(d.processes(own.program, own.base), o.findMs ?? YIELD_FIND_MS);
    if (!procs) return { did: 'kept', why: 'slow' };
    if (!procs.length) return { did: 'kept', why: 'not-found' };
    for (const p of procs) d.stop(p.pid);
    const deadline = d.now() + (o.goneMs ?? YIELD_GONE_MS);
    while ((await d.probe(own.base)) !== 'down' && d.now() < deadline) await d.sleep(100);
    const ms = Math.round(d.now() - t0);
    const pids = procs.map((p) => p.pid);
    d.log(`stopped ${path.win32.basename(own.program)} (${pids.join(', ')}) at ${own.base} in ${ms} ms: it gives way to the NPU's chat on a PC under ${NPU_CATALOG.idleStop.smallPcGb} GB, and starts again for the next embedding`);
    return { did: 'stopped', base: own.base, pids, ms };
  } catch (e: any) {
    d.log(`left ${own.base} running for the NPU's chat: ${e?.message ?? e}`);
    return { did: 'kept', why: 'slow' };
  }
}

/** `p`'s value, or null when it takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer));
}

/** This PC's: its processes, the agents' readable config.json for npuIdleStopMinutes, and the keeper's log. */
export function pcYield(o: { logFile?: string; configFile?: string } = {}): { given: () => boolean; deps: YieldDeps } {
  const logFile = o.logFile ?? reaperLog();
  return {
    given: () => {
      const raw = readConfigFile(o.configFile ?? readableConfigFile()).raw;
      return raw?.npuIdleStopMinutes === keeperSettings(raw).npuIdleStopMinutes;
    },
    deps: {
      probe: (base) => kitProbe(base, 1_000),
      processes: serverProcesses,
      stop: (pid) => {
        try {
          process.kill(pid);
        } catch {}
      },
      log: (line) => logLine(logFile, line),
      now: Date.now,
      sleep,
    },
  };
}

/** How old hardware.json may get before the keeper asks this PC again: a card or an NPU driver can come and go. */
const HARDWARE_DAYS = 1;
/** How old a hardware.json without the processor's name may get before it's asked again (detection may not have had it). */
const HARDWARE_UNNAMED_MS = 3_600_000;

/**
 * hardware.json afresh when there's none or it's a day old: what this PC has, asked with detection (a few seconds of
 * PowerShell, once a day), so every program knows whether it has an NPU, and a model on a graphics card is never
 * called the NPU. A detection that couldn't tell writes nothing; the next look tries again. One written before the
 * accelerators' names were kept in it (kit 2.27.0) is asked again at once when it says there's an NPU but not its
 * name, and after an hour when it lacks the processor's: every program names the accelerators from it.
 */
export async function refreshHardware(o: { file?: string; detect?: () => Promise<Detection>; nowMs?: number } = {}): Promise<boolean> {
  const file = o.file ?? hardwareFile();
  let age = Infinity;
  try {
    age = (o.nowMs ?? Date.now()) - statSync(file).mtimeMs;
  } catch {
    // none yet
  }
  const had = Number.isFinite(age) ? readHardware(file) : null;
  const unnamed = !!had && ((had.npu && !had.npuName) || (!had.cpuName && age >= HARDWARE_UNNAMED_MS));
  if (age < HARDWARE_DAYS * 86_400_000 && !unnamed) return false;
  const hw = hardwareOf(await (o.detect ?? detect)());
  if (!hw) return false;
  rememberHardware(hw, file);
  return true;
}

/** How long nobody may have used the NPU before its command is changed under it (npu-refresh.ts). */
export const NPU_REFRESH_QUIET_MS = 2 * 60_000;

/**
 * What the NPU refresh's test servers print (npu-refresh.ts), beside the keeper's log, each test after a line naming
 * its command. A server that passes its test goes on printing there until the keeper next stops it.
 */
export const npuRefreshLog = (env: NodeJS.ProcessEnv = process.env) => path.join(serverLogsDir(env), 'npu-refresh.log');

let npuRefresh: Promise<void> | null = null;
let npuDetected: Promise<Detection> | null = null;

/** This PC, asked once in the process however many looks take it (the NPU's refresh, setting up again). */
const detectOnce = (): Promise<Detection> =>
  (npuDetected ??= detect().catch((e) => {
    npuDetected = null;
    throw e;
  }));

/**
 * The NPU's servers brought up to this kit's command (npu-refresh.ts): looked at once for each kit version, in the
 * background, so a look never waits for it; while someone uses the NPU, or after a test that failed for its server, a later
 * look tries again. What it changed, or why it couldn't, goes in the keeper's log, and what its test's servers printed
 * in npuRefreshLog. This PC is asked once in the process, however many looks it takes.
 */
export function startNpuRefresh(o: { who?: string; logFile?: string } = {}): void {
  // Not while the NPU is set up again with this kit's pins (startRepairs): that setup tests its servers.
  if (npuRefresh || againOn === 'npu') return;
  const logFile = o.logFile ?? reaperLog();
  const serverLog = npuRefreshLog();
  const dirs = kitLockDirsOf({ id: 'npu', slots: 1 });
  // The NPU's embedding server on another device (its `turn`: the NPU 3720's, on the processor's graphics) is stopped
  // and tested in that device's turn too, and its use there counts as the NPU's.
  const embedDirs = (): string[] => {
    const accs = configuredAccelerators(readConfigFile().raw);
    const npu = accs.find((a) => a.kind === 'npu');
    const on = npu ? otherTurn(npu, 'embed', accs) : null;
    return on ? kitLockDirsOf({ id: on.id, slots: on.slots }) : [];
  };
  const shared = {
    kit: kitVersion(),
    configFile: acceleratorConfigFile(),
    tools: toolsHome(),
    now: Date.now,
    detect: detectOnce,
    // Each one looked at, so its next look knows whether it was in use since (lastUseMs).
    idle: () =>
      [dirs, embedDirs()]
        .filter((d) => d.length)
        .map((d) => Date.now() - lastUseMs(d) >= NPU_REFRESH_QUIET_MS)
        .every(Boolean),
    // A first compile with a new command can take minutes: the turn isn't taken as a dead holder's meanwhile.
    withTurn: <T>(fn: () => Promise<T>) => {
      const e = embedDirs();
      const who = o.who ?? 'keeper';
      return reaperTurn(dirs, () => (e.length ? reaperTurn(e, fn, who, 40 * 60_000) : fn()), who, 40 * 60_000);
    },
    stopServer: stopServerAt,
    answering: (base: string) => whatAnswers(base),
    log: (line: string) => logLine(logFile, line),
  };
  npuRefresh = refreshNpu({
    ...shared,
    testChat: (e) => {
      logLine(serverLog, `the NPU's refresh (kit ${kitVersion()}) tests ${e.chat?.model}: ${e.chat?.startCommand?.join(' ')}`);
      return testNpuEntry(e, { held: true, logFile: serverLog });
    },
    testEmbed: (e, dims) => {
      logLine(serverLog, `the NPU's refresh (kit ${kitVersion()}) tests embeddings with ${e.embed?.model}: ${e.embed?.startCommand?.join(' ')}`);
      return testNpuEmbed(e, { dims, held: true, logFile: serverLog });
    },
    serverLog,
  })
    .then(() => {})
    .catch((e: any) => logLine(logFile, `the NPU's command couldn't be looked at: ${e?.message ?? e}`))
    // Then its server's patched file (npu-patch.ts), tested with the command the refresh left: its own look, its own record.
    .then(() =>
      patchNpu({
        ...shared,
        test: (e) => {
          logLine(serverLog, `the NPU's patch (kit ${kitVersion()}) tests ${e.chat?.model}: ${e.chat?.startCommand?.join(' ')}`);
          return testNpuEntry(e, { held: true, logFile: serverLog, seeRed: true });
        },
      }),
    )
    .then(() => {})
    .catch((e: any) => logLine(logFile, `the NPU server's patch couldn't be looked at: ${e?.message ?? e}`))
    .finally(() => (npuRefresh = null));
}

/** The cards' vision commands brought up to this kit's (setup.ts' refreshCardVision), once for each kit version: what it changed goes in the keeper's log. */
export function refreshCards(o: { logFile?: string } = {}): void {
  const logFile = o.logFile ?? reaperLog();
  try {
    refreshCardVision({ configFile: acceleratorConfigFile(), kit: kitVersion(), log: (line) => logLine(logFile, line) });
  } catch (e: any) {
    logLine(logFile, `the cards' vision commands couldn't be looked at: ${e?.message ?? e}`);
  }
}

/**
 * One copy of Qwen3-VL-2B where the NPU keeps one (setup.ts' refreshSmallModel), then the model files the NPU's routes
 * have retired, removed once nothing names them (retired.ts' removeRetiredModels), at most one look at a time: what they
 * changed goes in the keeper's log.
 */
let smallModel: Promise<void> | null = null;
export function startSmallModelRefresh(o: { logFile?: string } = {}): void {
  if (smallModel) return;
  const logFile = o.logFile ?? reaperLog();
  const log = (line: string) => logLine(logFile, line);
  smallModel = refreshSmallModel({ configFile: acceleratorConfigFile(), kit: kitVersion(), log })
    .catch((e: any) => logLine(logFile, `the graphics' and the processor's Qwen3-VL-2B file couldn't be looked at: ${e?.message ?? e}`))
    .then(() => removeRetiredModels({ configFile: acceleratorConfigFile(), running: () => modelServerProcesses().then((ps) => ps.map((p) => p.line)), log }))
    .then(() => {})
    .catch((e: any) => logLine(logFile, `the retired model files couldn't be looked at: ${e?.message ?? e}`))
    .finally(() => (smallModel = null));
}

/**
 * A server whose program is gone from where config.json starts it, set up again (server-repair.ts, kit 2.113.5); then,
 * when nothing was, an accelerator behind the kit's pins (set-up-again.ts, kit 2.115.0: another llama.cpp build or model
 * for a card or the processor, another server or model for the NPU), set up again beside its present entry, once nobody
 * has used it for AGAIN_QUIET_MS, looked for every AGAIN_LOOK_MS; then the files such a switch left unused, removed once
 * nothing has named them for three days. In the background, at most one setup at a time, and not while the NPU's
 * refresh tests its servers (the next look tries). What it did goes in the keeper's log, setup's own lines too.
 */
let repairing: Promise<void> | null = null;
/** The accelerator being set up again now (setUpAgain), so the NPU's refresh leaves the NPU to it meanwhile. */
let againOn: string | null = null;
let againLooked = 0;
export function startRepairs(o: { logFile?: string; config?: () => Record<string, any> } = {}): void {
  if (repairing || npuRefresh) return;
  const logFile = o.logFile ?? reaperLog();
  const log = (line: string) => logLine(logFile, line);
  const setup = (x: Parameters<typeof setupCommand>[0]) => setupCommand({ ...x, log: (line) => log(`setup: ${line}`) });
  repairing = repairMissing({ raw: o.config, log, setup })
    .then((r) => {
      if (r.did === 'set-up' || Date.now() - againLooked < AGAIN_LOOK_MS) return;
      againLooked = Date.now();
      return setUpAgain({
        kit: kitVersion(),
        detect: detectOnce,
        // A card whose driver the Watchman is changing isn't set up again meanwhile: its test servers would start there.
        idle: (a) => Date.now() - lastUseMs(lockDirsOf(a)) >= AGAIN_QUIET_MS && !driverHoldsNow([a])[a.id],
        setup: async (x) => {
          againOn = x.ids[0] ?? null;
          try {
            return await setup(x);
          } finally {
            againOn = null;
          }
        },
        log,
      }).catch((e: any) => log(`the accelerators couldn't be looked at against this kit's pins: ${e?.message ?? e}`));
    })
    .then(() => removeReplaced({ running: () => modelServerProcesses().then((ps) => ps.map((p) => p.line)), log }))
    .then(() => {})
    .catch((e: any) => log(`the servers' programs couldn't be looked at: ${e?.message ?? e}`))
    .finally(() => (repairing = null));
}

/**
 * One look: each server, then the orphans. config.json and Manor's switch are read afresh, so a change applies at the
 * next look. With the PC's own reaper (pcReaper's), it first brings hardware.json, the cards' vision commands, the
 * NPU's command and the cards' Qwen3-VL-2B file up to date (and removes the model files the NPU no longer runs, once nothing
 * names them), and sets up again a server whose program is missing or that is behind the kit's pins (startRepairs), whether or not it's handed config.json: the Smith hands the one it read for its round, and
 * until kit 2.78.8 that kept all three from ever running under it (Reeve leaves the looks to the Smith). A test's
 * reaper asks no PC.
 */
export async function keeperLook(reaper: Reaper, o: { config?: () => Record<string, any>; withNpu?: () => boolean } = {}): Promise<{ servers: ReapOutcome[]; orphans: OrphanOutcome[] }> {
  if (asksPc(reaper)) {
    driverWatch ??= watchDriverWork(reaper);
    await refreshHardware().catch(() => false);
    refreshCards();
    startRepairs({ config: o.config });
    startNpuRefresh();
    startSmallModelRefresh();
  }
  const servers = serversToReap((o.config ?? (() => readConfigFile().raw))(), { withNpu: (o.withNpu ?? (() => gpuWithNpu().on))() });
  const looked = await reaper.look(servers);
  const orphans = await reaper.orphans(servers);
  return { servers: looked, orphans };
}

/** The watch the PC's keeper keeps on driver-work.json (watchDriverWork), once a process: its stop. */
let driverWatch: (() => void) | null = null;

/**
 * The keeper's watch on the Watchman's driver-work.json (kit 2.148.0): its folder watched, and the file read every
 * DRIVER_LOOK_MS besides (a watch can miss a change). Each time it changes, the servers this keeper keeps on the cards
 * it names are looked at then (the reaper's look: stopped, as driverOn says), so they stop within seconds of the guard
 * naming their card rather than at the next minute's look. The servers are config.json's as it is then. `file`,
 * `servers` and `everyMs` are for tests. Returns its stop.
 */
export function watchDriverWork(reaper: Reaper, o: { file?: string | null; servers?: () => ReapedServer[]; everyMs?: number } = {}): () => void {
  const file = o.file === undefined ? driverWorkFile() : o.file;
  if (!file) return () => {};
  let last: string | null = null;
  let running = false;
  const check = async () => {
    if (running) return;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {}
    if (text === last) return;
    last = text;
    if (!text) return;
    running = true;
    try {
      const servers = (o.servers ?? (() => serversToReap(readConfigFile().raw, { withNpu: gpuWithNpu().on })))();
      const held = driverHoldsNow(servers.map((s) => s.acc));
      const mine = servers.filter((s) => held[s.acc.id]);
      if (mine.length) await reaper.look(mine);
    } catch {
      // The next change, or the next minute's look, tries again.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void check(), o.everyMs ?? DRIVER_LOOK_MS);
  timer.unref();
  let w: FSWatcher | null = null;
  try {
    w = watch(path.dirname(file), { persistent: false }, (_e, name) => {
      if (!name || String(name).toLowerCase() === path.basename(file).toLowerCase()) void check();
    });
    w.on('error', () => {});
  } catch {}
  void check();
  return () => {
    clearInterval(timer);
    w?.close();
  };
}

/**
 * Looks every minute (REAP_EVERY_MS), with config.json read afresh each time, so a change in Settings applies at
 * the next look: Reeve's home page where there is no Smith. The Smith runs keeperLook() in its rounds instead.
 * Returns a stop function.
 */
export function startReaping(o: { who?: string; logFile?: string; everyMs?: number } = {}): () => void {
  const logFile = o.logFile ?? reaperLog();
  const reaper = pcReaper({ who: o.who, logFile });
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await keeperLook(reaper);
    } catch (e: any) {
      logLine(logFile, `a look failed: ${e?.message ?? e}`); // the next look tries again
    } finally {
      running = false;
    }
  }, o.everyMs ?? REAP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------------------------------------
// Each accelerator now

/** A server as a status shows it: `loading` is the kit's `busy` (loading its model, or answering). */
export type ServerState = 'ready' | 'loading' | 'down';

/** Each accelerator now: its servers, whether it failed (and why), a game holding it back, who holds its slots and who waits. */
export interface AcceleratorStatus {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  serves: EndpointKind[];
  slots: number;
  maxContextTokens: number;
  servers: { kind: EndpointKind; baseUrl: string; model: string; state: ServerState }[];
  failed: { since: string; reason: string; by: string } | null;
  game: { busy: boolean; percent: number; by: string[] } | null;
  /** What the Watchman is doing to its driver now (driver-work.json, kit 2.148.0): no model work goes there meanwhile. */
  driver: DriverCard | null;
  holders: ({ pid: number; since: number } | null)[];
  waiting: { pid: number; lane: string; since: number; who?: string }[];
}

/** Every configured accelerator, as its servers, failure marker, game and line say now. */
export async function acceleratorStatus(accs: Accelerator[], o: { probe?: (base: string) => Promise<ServerState> } = {}): Promise<AcceleratorStatus[]> {
  const games = readGames();
  const driver = driverHoldsNow(accs);
  const ask = o.probe ?? (async (base: string) => {
    const s = await kitProbe(base, 1500);
    return s === 'busy' ? 'loading' : s;
  });
  return Promise.all(
    accs.map(async (a) => {
      const kinds = ENDPOINT_KINDS.filter((k) => a[k]?.model);
      const bases = new Map<string, ServerState>();
      const servers = await Promise.all(
        kinds.map(async (k) => {
          let ep: { baseUrl: string; model: string };
          try {
            ep = endpointFor(a, k);
          } catch {
            return null;
          }
          if (!bases.has(ep.baseUrl)) bases.set(ep.baseUrl, await ask(ep.baseUrl));
          return { kind: k, baseUrl: ep.baseUrl, model: ep.model, state: bases.get(ep.baseUrl)! };
        }),
      );
      const line = lineSnapshot(lockDirsOf(a));
      const g = a.kind === 'gpu' ? games?.cards?.[a.id] : undefined;
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        enabled: a.enabled !== false,
        serves: ENDPOINT_KINDS.filter((k) => serves(a, k)),
        slots: a.kind === 'npu' ? 1 : a.slots,
        maxContextTokens: a.maxContextTokens,
        servers: servers.filter((s): s is NonNullable<typeof s> => !!s),
        failed: readFailure(a.id),
        game: g ? { busy: !!g.busy, percent: g.percent ?? 0, by: g.by ?? [] } : null,
        driver: driver[a.id] ?? null,
        holders: line.holders,
        waiting: line.waiting,
      };
    }),
  );
}

/** One line per accelerator, for a status command. `setupHint` says where to set them up when none are. */
export function describeStatus(list: AcceleratorStatus[], setupHint = 'Settings → Set up'): string[] {
  if (!list.length) return [`accelerators: none configured (set them up: ${setupHint})`];
  return list.map((s) => {
    const up = s.servers.map((x) => `${x.kind} ${x.state === 'down' ? 'not running' : x.state}`).join(', ') || 'serves nothing';
    const held = s.holders.filter(Boolean).length;
    const bits = [
      s.enabled ? up : 'disabled',
      s.failed ? `FAILED ${ago(s.failed.since)}: ${s.failed.reason}` : '',
      s.game?.busy ? `held back for ${s.game.by.join(', ') || 'a game'} (${s.game.percent}%)` : '',
      s.driver ? core.say.driverWaiting(s.driver) : '',
      `${held}/${s.slots} slot${s.slots === 1 ? '' : 's'} held, ${s.waiting.length} waiting${s.waiting.length ? `: ${s.waiting.map((w) => `${w.who ?? w.pid} (${w.lane})`).join(', ')}` : ''}`,
      `cap ${s.maxContextTokens} tokens a request`,
    ].filter(Boolean);
    return `${s.name} (${s.id}): ${bits.join('; ')}`;
  });
}

const ago = (iso: string) => `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))} min ago`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
