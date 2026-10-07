import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Accelerator, type AcceleratorKind, configuredAccelerators, endpointFor, keeperSettings, readConfigFile, SERVE_KINDS, type ServeKind, serves, toolsHome } from './accelerator-config.ts';
import { currentGames, ensureServer, hardwareFile, lockDirsOf as kitLockDirsOf, probe as kitProbe, readFailure, readGames, readHardware, rememberHardware, type Accelerator as KitAccelerator } from './accelerators.ts';
import { type Detection, detect, hardwareOf } from './detect.ts';
import { expandEnv } from './accelerators.ts';
import { withLock } from './lock.ts';
import * as core from './core/index.js';
import { gpuWithNpu } from './manor.ts';
import { lineSnapshot, lineState, LockTimeout, QueueFull, queueDirFor, slotDirs, withAcceleratorTurn } from './npu-queue.ts';
import { powershell, psQuote } from './ps.ts';
import { RULES } from './rules.ts';

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
 * So, once a minute, for each model server the keeper can start again (an NPU's chat and vision servers, npu-embed
 * exiting by itself when idle; a graphics card's or the processor's chat, vision and embedding servers), with "in
 * use" meaning someone holds or waits on its accelerator's lock:
 * - **Idle**: when nobody has used its accelerator for `npuIdleStopMinutes` (the NPU) or `gpuIdleStopMinutes` (a
 *   graphics card, or the processor), both 10 by default (rules.json's keeper), it is stopped. The next request
 *   starts it again (ensureServer).
 * - **A game**: when a game is using its graphics card (games.json) and nobody has used the card for 2 minutes, it
 *   is stopped, so the game gets the card's memory.
 * - **The graphics card is kept out**: when Manor's settings say `"gpuWithNpu": false` (kit 2.10.0) and an NPU serves here, a
 *   graphics card's servers are stopped as soon as nobody uses the card, and never restarted.
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
 * Whether the graphics cards are kept out of model work now: Manor's `gpuWithNpu` (manor.ts's gpuWithNpu(), true
 * unless Manor says false) is off and the list has an NPU that serves something, by the core's own rule
 * (withoutGpuBesideNpu), the one every agent's requests follow.
 */
export const gpuKeptOut = (accs: Accelerator[], withNpu: boolean) => core.withoutGpuBesideNpu(accs, withNpu).length < accs.length;

// ------------------------------------------------------------------------------------------------
// The servers, and what a look does

/** How a server is started again. */
export interface ServerSpec {
  base: string;
  startCommand?: string[];
  logFile?: string;
  env?: NodeJS.ProcessEnv;
}

/** How long a server may go without answering, while nobody uses its accelerator, before it is restarted. */
export const UNANSWERED_MS = RULES.keeper.unansweredMs;
/** A server whose working set is this big, while nobody uses the NPU, is restarted: it is holding memory from earlier loads. */
export const RECYCLE_BYTES = RULES.keeper.recycleBytes;
/** How long nobody must have used a graphics card before its servers are stopped for a game. */
export const GAME_GRACE_MS = RULES.keeper.gameGraceMs;
/** How often the keeper looks. */
export const REAP_EVERY_MS = RULES.keeper.lookEveryMs;
/** How long an orphan is seen before it is stopped; 0 never stops one. */
export const ORPHAN_GRACE_MS = RULES.keeper.orphanGraceMs;

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
  /** Kept out (gpuWithNpu false): stopped as soon as nobody uses its accelerator, and never restarted here. */
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
  /** When someone last took or let go of its accelerator's lock, or joined or left its line (ms since the epoch). */
  lastActivityMs: (s: ReapedServer) => number;
  /** Runs `fn` holding all its accelerator's slots; throws when they can't be had at once (someone is in line). */
  withTurn: <T>(s: ReapedServer, fn: () => Promise<T>) => Promise<T>;
  /** The programs of a game using its graphics card now; empty or null when none is (or it isn't a card). */
  gameOn?: (s: ReapedServer) => Promise<string[] | null>;
  start: (spec: ServerSpec) => Promise<unknown>;
  log: (line: string) => void;
  /** Every model server's process on this PC (llama-server, GenieX, and the configured programs), for the orphan check. */
  allProcesses?: () => Promise<SeenProcess[]>;
}

/** "the NPU", or the card's (or processor's) own name: whose lock a message is about. */
const theAcc = (s: ReapedServer) => (s.acc.kind === 'npu' ? 'the NPU' : s.acc.name);

export interface ReaperOptions {
  idleMs?: number;
  unansweredMs?: number;
  recycleBytes?: number;
  gameGraceMs?: number;
  orphanGraceMs?: number;
}

export class Reaper {
  private lastInUse = new Map<string, number>();
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
    if (d.inUse(s)) {
      this.lastInUse.set(s.acc.id, d.now());
      this.silentSince.delete(s.base);
      return { base: s.base, did: 'in-use' };
    }
    const taken = { base: s.base, did: 'skipped' as const, why: `${theAcc(s)} was taken in the meantime` };
    const program = path.win32.basename(s.program);
    if (s.keptOut) {
      const pids = await this.inTurn(s, false);
      if (!pids) return taken;
      d.log(`stopped ${program} (${pids.join(', ')}) at ${s.base}: Manor keeps the graphics card out while the NPU serves (gpuWithNpu is off)`);
      return { base: s.base, did: 'stopped-kept-out', pids };
    }
    const lastUse = Math.max(this.lastInUse.get(s.acc.id) ?? 0, d.lastActivityMs(s), ...procs.map((p) => p.startedMs));
    const idleMs = d.now() - lastUse;
    const idleStopMs = s.idleMs ?? this.o.idleMs ?? 0;
    if (idleStopMs > 0 && idleMs >= idleStopMs) {
      const pids = await this.inTurn(s, false);
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
   * Stops the server's processes (and starts it again) holding its accelerator's slots. Null when
   * someone took one since the look: then it waits for the next.
   */
  private async inTurn(s: ReapedServer, restart: boolean): Promise<number[] | null> {
    const d = this.deps;
    return d
      .withTurn(s, async () => {
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
   * The orphan check: every model server's process on the manor's ports that none of `servers` is (another
   * program, or another port), seen for `orphanGraceMs` in a row, is stopped. A process gone, or known again,
   * starts its count afresh.
   */
  async orphans(servers: ReapedServer[]): Promise<OrphanOutcome[]> {
    const d = this.deps;
    const grace = this.o.orphanGraceMs ?? ORPHAN_GRACE_MS;
    if (!d.allProcesses) return [];
    const seen = await d.allProcesses();
    const ports = manorPorts(servers);
    const out: OrphanOutcome[] = [];
    const still = new Set<number>();
    for (const p of seen) {
      const base = baseOf(p.line);
      if (!base || !ports.has(Number(new URL(base).port))) continue;
      if (servers.some((s) => sameProgram(p.path, s.program) && servesBase(p.line, s.base))) continue;
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

const sameProgram = (a: string, b: string) => !a || a.toLowerCase() === b.toLowerCase();

/** An accelerator's lock folders, one per slot: the kit's (the NPU's lock for the NPU; `<locks>\<id>`, `<id>.2` … for the others). */
export const lockDirsOf = (a: Pick<Accelerator, 'id' | 'kind' | 'slots'>): string[] => kitLockDirsOf({ id: a.id, slots: a.kind === 'npu' ? 1 : a.slots });

/**
 * The model servers the keeper can start again, each with its accelerator's idle time: an NPU's chat and vision
 * endpoints (npu-embed exits by itself), and a graphics card's or the processor's chat, vision and embedding
 * endpoints, when they have a startCommand. `lockDirs` gives an accelerator's lock folders (or is the NPU's lock
 * folder, the others beside it, as Reeve's reaper took it). `keptOut` marks a card's servers while gpuWithNpu keeps the card out.
 */
export function reapedServers(
  accelerators: Accelerator[],
  logDir = path.join(toolsHome(), 'servers', 'logs'),
  idle: { npuMs?: number; otherMs?: number } = {},
  lockDirs: ((a: Accelerator) => string[]) | string = lockDirsOf,
  o: { keepGpuOut?: boolean } = {},
): ReapedServer[] {
  const out = new Map<string, ReapedServer>();
  for (const a of accelerators) {
    if (a.enabled === false) continue;
    const kinds: ServeKind[] = a.kind === 'npu' ? ['chat', 'vision'] : ['chat', 'vision', 'embed'];
    const idleMs = a.kind === 'npu' ? idle.npuMs : idle.otherMs;
    for (const kind of kinds) {
      if (!a[kind]?.model) continue;
      let ep: ReturnType<typeof endpointFor>;
      try {
        ep = endpointFor(a, kind);
      } catch {
        continue;
      }
      if (!ep.startCommand?.length || out.has(ep.baseUrl)) continue;
      out.set(ep.baseUrl, {
        base: ep.baseUrl,
        program: expandEnv(ep.startCommand[0]),
        spec: { base: ep.baseUrl, startCommand: ep.startCommand, logFile: path.join(logDir, `${a.id}.${kind === 'vision' && !a.vision?.baseUrl ? 'chat' : kind}.log`) },
        acc: { id: a.id, kind: a.kind, name: a.name },
        lockDirs: typeof lockDirs === 'string' ? (a.kind === 'npu' ? [lockDirs] : slotDirs(path.join(path.dirname(lockDirs), a.id), a.slots)) : lockDirs(a),
        ...(idleMs !== undefined ? { idleMs } : {}),
        ...(a.kind === 'npu' ? { recycle: true } : {}),
        ...(o.keepGpuOut && a.kind === 'gpu' ? { keptOut: true } : {}),
      });
    }
  }
  return [...out.values()];
}

const arg = (commandLine: string, name: string) => new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)"?([^\\s"]+)"?`, 'i').exec(commandLine)?.[1];

/**
 * The address a server's command line serves: GenieX takes `--host <host:port>` (127.0.0.1:18181 without it),
 * llama.cpp's server `--host <host>` and `--port <port>` (127.0.0.1 and 8080 without them). Null for a command
 * line that is neither.
 */
export function baseOf(commandLine: string): string | null {
  const llama = /llama-server/i.test(commandLine);
  if (!llama && !/geniex/i.test(commandLine)) return null;
  let host = (arg(commandLine, 'host') ?? '127.0.0.1').replace(/^https?:\/\//i, '');
  const port = arg(commandLine, 'port');
  if (port) host = `${host.replace(/:\d+$/, '')}:${port}`;
  else if (!/:\d+$/.test(host)) host = `${host}:${llama ? 8080 : 18181}`;
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
  const want = new URL(base).host;
  let host = (arg(commandLine, 'host') ?? '127.0.0.1').replace(/^https?:\/\//i, '');
  const port = arg(commandLine, 'port');
  if (port) host = `${host.replace(/:\d+$/, '')}:${port}`;
  else if (!/:\d+$/.test(host)) host = `${host}:${/llama-server/i.test(commandLine) ? 8080 : 18181}`;
  return host === want;
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
 * When someone last used an accelerator, from its lock folders' times: taking or letting go of a slot creates or
 * removes its folder (which changes `locks\`), and joining or leaving the line changes its queue folder. Another
 * accelerator's lock in `locks\` counts too, which only ever keeps a server longer.
 */
export function lastActivityMs(lockDirs: string | string[]): number {
  const dirs = [lockDirs].flat();
  return Math.max(mtimeMs(path.dirname(dirs[0])), ...dirs.map(mtimeMs), mtimeMs(queueDirFor(dirs[0])));
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
export function reaperTurn<T>(lockDirs: string | string[], fn: () => Promise<T>, who = 'keeper'): Promise<T> {
  const dirs = [lockDirs].flat();
  return withAcceleratorTurn(dirs, (slot) => holdingAll(dirs.filter((_, i) => i !== slot), fn), { who, lane: 'background', waitMs: RULES.keeper.turnWaitMs, maxAhead: RULES.keeper.turnMaxAhead });
}

/** Appends a line to a log, never throwing. */
export function logLine(file: string, line: string): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** The keeper's log: %USERPROFILE%\.reeve\servers\logs\reaper.log, where Reeve's reaper always wrote it. */
export const reaperLog = (env: NodeJS.ProcessEnv = process.env) => path.join(toolsHome(env), 'servers', 'logs', 'reaper.log');

/** The real PC's reaper. `who` names it in the lines it waits in ("smith", "reeve"). */
export function pcReaper(o: { who?: string; logFile?: string; config?: () => Record<string, any>; options?: ReaperOptions } = {}): Reaper {
  const logFile = o.logFile ?? reaperLog();
  const config = o.config ?? (() => readConfigFile().raw);
  return new Reaper(
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
      lastActivityMs: (s) => lastActivityMs(s.lockDirs),
      withTurn: (s, fn) => reaperTurn(s.lockDirs, fn, o.who),
      gameOn: async (s) => {
        const games = await currentGames(configuredAccelerators(config()) as unknown as KitAccelerator[]);
        const card = games?.cards?.[s.acc.id];
        return card?.busy ? card.by : null;
      },
      start: (spec) => ensureServer({ baseUrl: spec.base, model: '', startCommand: spec.startCommand }, { logFile: spec.logFile, env: spec.env }),
      log: (line) => logLine(logFile, line),
      allProcesses: () => modelServerProcesses(configuredAccelerators(config()).flatMap((a) => SERVE_KINDS.map((k) => a[k]?.startCommand?.[0] ?? '')).filter(Boolean).map((p) => expandEnv(p))),
    },
    o.options,
  );
}

/** The servers as config.json has them now, each with its accelerator's idle time, and the card kept out when Manor says so. */
export function serversToReap(raw: Record<string, any>, o: { withNpu?: boolean; logDir?: string } = {}): ReapedServer[] {
  const k = keeperSettings(raw);
  const accs = configuredAccelerators(raw);
  return reapedServers(accs, o.logDir, { npuMs: k.npuIdleStopMinutes * 60_000, otherMs: k.gpuIdleStopMinutes * 60_000 }, undefined, { keepGpuOut: gpuKeptOut(accs, o.withNpu ?? gpuWithNpu().on) });
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

/** One look: each server, then the orphans. config.json and Manor's switch are read afresh, so a change applies at the next look. */
export async function keeperLook(reaper: Reaper, o: { config?: () => Record<string, any>; withNpu?: () => boolean } = {}): Promise<{ servers: ReapOutcome[]; orphans: OrphanOutcome[] }> {
  if (!o.config) await refreshHardware().catch(() => false); // a test hands its config, and asks no PC
  const servers = serversToReap((o.config ?? (() => readConfigFile().raw))(), { withNpu: (o.withNpu ?? (() => gpuWithNpu().on))() });
  const looked = await reaper.look(servers);
  const orphans = await reaper.orphans(servers);
  return { servers: looked, orphans };
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
  serves: ServeKind[];
  slots: number;
  maxContextTokens: number;
  servers: { kind: ServeKind; baseUrl: string; model: string; state: ServerState }[];
  failed: { since: string; reason: string; by: string } | null;
  game: { busy: boolean; percent: number; by: string[] } | null;
  holders: ({ pid: number; since: number } | null)[];
  waiting: { pid: number; lane: string; since: number; who?: string }[];
}

/** Every configured accelerator, as its servers, failure marker, game and line say now. */
export async function acceleratorStatus(accs: Accelerator[], o: { probe?: (base: string) => Promise<ServerState> } = {}): Promise<AcceleratorStatus[]> {
  const games = readGames();
  const ask = o.probe ?? (async (base: string) => {
    const s = await kitProbe(base, 1500);
    return s === 'busy' ? 'loading' : s;
  });
  return Promise.all(
    accs.map(async (a) => {
      const kinds = SERVE_KINDS.filter((k) => a[k]?.model);
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
        serves: SERVE_KINDS.filter((k) => serves(a, k)),
        slots: a.kind === 'npu' ? 1 : a.slots,
        maxContextTokens: a.maxContextTokens,
        servers: servers.filter((s): s is NonNullable<typeof s> => !!s),
        failed: readFailure(a.id),
        game: g ? { busy: !!g.busy, percent: g.percent ?? 0, by: g.by ?? [] } : null,
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
      `${held}/${s.slots} slot${s.slots === 1 ? '' : 's'} held, ${s.waiting.length} waiting${s.waiting.length ? `: ${s.waiting.map((w) => `${w.who ?? w.pid} (${w.lane})`).join(', ')}` : ''}`,
      `cap ${s.maxContextTokens} tokens a request`,
    ].filter(Boolean);
    return `${s.name} (${s.id}): ${bits.join('; ')}`;
  });
}

const ago = (iso: string) => `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))} min ago`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
