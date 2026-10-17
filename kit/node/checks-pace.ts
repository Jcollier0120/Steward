import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locksDir } from './lock.ts';
import { manorHome } from './manor.ts';
import { pidAlive } from './npu-queue.ts';
import { AGENTS_AT_ONCE, CEILING_CAP, CEILING_ENV, ceilingCap } from './pace.ts';
import { powershell, psQuote } from './ps.ts';
import { currentWork } from './work-tasks.ts';

/**
 * The checks pace (kit 2.70.0): test runs, type checks, installs and builds that an agent starts (the Steward's vouch,
 * its kit trials, its merge checks and releases; the Assayer's checks) can't take the whole processor. Node's test
 * runner starts a test file per processor but one, and a type check, an install and a test run side by side kept a PC's
 * processor at 100% for a minute at a time, its fans at full.
 *
 * A paced command runs through a small launcher (checks-pace.cs, compiled once to an exe every agent on the PC shares, as
 * gentle.cs is to a DLL) that starts it, and every program it starts, in a job with
 *
 * - **a hard cap on the processor**: a third of it by default (checksCap()), the manor's ceiling (85%) at a full pace,
 *   however many threads they run;
 * - **a cap on memory**: per program and for the whole job (checksMemory()), so a runaway test fails rather than
 *   pages the PC;
 * - **below-normal priority**: they give way to whatever the person is doing;
 * - **a turn**: at most CHECKS_AT_ONCE runs on the PC at once (CHECKS_AT_ONCE_FULL at a full pace), from whichever
 *   agent or Claude session, the rest wait.
 *
 * and, since it is slower so (kit 2.74.2), **room to finish**: a runner stretches its time limit by as much as the cap
 * slows the work (pacedSlower) plus the wait for a turn, and node's test runner runs as many files at once as the cap
 * has room for (pacedTestConcurrency), not one per processor. The command is told how much slower it runs, too
 * (CHECKS_SLOWER_ENV, kit 2.74.6), so a test's own waits and timeouts stretch as its run's limit does (paced): at the
 * checks pace a test should take longer, never fail.
 *
 * Every paced run says where it stands (kit 2.76.0): its launcher writes a file in checksRunsDir() while it waits for a
 * turn, holds one or runs without, naming the agent and the task it runs for (checksWho), so an agent's work status
 * (work-status.ts) and Manor's Work page show who holds the PC's turns and who waits, since when (checksRuns()).
 *
 * The job is one for the whole PC: check runs side by side (two vouches, a trial's tries) share the cap rather than
 * taking it twice, so together they never peg the processor either. The command leaves the agent's own gentle job first
 * (kit 2.74.6), which lets it: the checks pace is the cap that holds it, not the agent's own tighter one as well.
 *
 * Manor's Settings pace at full raises the cap to the manor's ceiling, 85% of the processor (pace.ts's CEILING_CAP, kit
 * 2.78.3; before, full lifted it altogether), as it raises the agents' own (gentle.ts): one switch for the whole manor,
 * and Windows and the person keep the rest. At full the runs take more turns at once (CHECKS_AT_ONCE_FULL), sharing the
 * one cap. While the pace is gentle, settings.json `"checksPace"` (or KIT_CHECKS_PACE, at either pace) may set the cap:
 * a percentage of the processor from 10 to 85, or "full" (or 100) for the ceiling. Nothing goes past the ceiling, and
 * nothing else changes the cap: a run asked for by hand is paced like any other. Windows only: elsewhere a paced
 * command runs under `nice`. Never fails a command: a launcher that can't be built or started leaves the command to run
 * as it is.
 */

/**
 * The cap by default, in hundredths of a percent: a third of the processor, however many processors it has (kit 2.74.2).
 * Half, as it was first, barely held a test suite back (the Assayer's own suite peaked at 57% of an 18-core laptop's
 * processor, 49% at half). The gentle pace's, from kit 2.73.0 (a quarter, two processors' worth at most: 11% there),
 * held it too far back: the Steward's own suite took over an hour on that laptop, otherwise idle, and on 2026-10-14 six
 * paced runs waited for a turn while the PC was three quarters idle. Four processors' worth (kit 2.74.1, 22% there) was
 * still short of what the PC had to spare. A third keeps two thirds of the processor for the person and the agents.
 */
export function checksCap(): number {
  return 3333;
}

/**
 * How many paced runs the PC runs at once (the launcher's turns); the rest wait for one, CHECKS_TURN_MS at most. Three
 * from kit 2.74.2, two before: they share the one cap, so a third run adds no processor, it only stops a short check
 * waiting behind two long ones.
 */
export const CHECKS_AT_ONCE = 3;
/**
 * How many paced runs the PC runs at once at a full pace (kit 2.78.3): as many as the work line's most agents at once,
 * six. Before 2.78.3 a full pace's runs took no turns at all. They share the one job and its ceiling, so more turns
 * add no processor, and three would hold back a build's releases side by side.
 */
export const CHECKS_AT_ONCE_FULL = AGENTS_AT_ONCE.most;

/** The turns now: CHECKS_AT_ONCE, or CHECKS_AT_ONCE_FULL when Manor's Settings pace is full. Read afresh each time. */
export function checksAtOnce(home = manorHome()): number {
  return manorSetting(home, 'backgroundPace') === 'full' ? CHECKS_AT_ONCE_FULL : CHECKS_AT_ONCE;
}

/** How long a paced run may wait for a turn before it runs without one (checks-pace.cs' TURN_WAIT_MS). */
export const CHECKS_TURN_MS = 20 * 60_000;
/** The least a paced run's time limit is stretched by (pacedSlower): what it always was, for a quarter of the processor. */
export const PACED_SLOWER_MIN = 4;

/**
 * How many times longer a command may take at the checks pace than at full speed (kit 2.74.2): the whole processor
 * against the share the cap leaves it, never under PACED_SLOWER_MIN. A quarter: 4. Two of 18 processors: 9, where a
 * fixed 4 stopped Reeve's tests at 80 minutes on 2026-10-14, a third of the way through, nothing failed. A time limit
 * meant for a run at full speed, stretched by this, still means the same work.
 */
export function pacedSlower(cap: number): number {
  return cap > 0 ? Math.max(PACED_SLOWER_MIN, Math.round(10_000 / cap)) : 1;
}

/**
 * The variable a paced command finds its pacedSlower in (kit 2.74.6): how many times longer it may take than at full
 * speed. Unset when it runs as it is.
 */
export const CHECKS_SLOWER_ENV = 'KIT_CHECKS_SLOWER';

/** How many times slower the checks pace runs this process (CHECKS_SLOWER_ENV): 1 when it isn't paced. Pure. */
export function checksSlower(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[CHECKS_SLOWER_ENV]);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 50) : 1;
}

/**
 * `ms` stretched as the checks pace stretches this run (checksSlower): for a test's own wait or timeout, which at full
 * speed is enough and at a third of the processor fails with nothing wrong (the whole suite before kit 2.74.5's release,
 * 2026-10-15). A test that shows something taking *longer* than a timeout stretches both, so the one stays longer than
 * the other. Pure.
 */
export function paced(ms: number, env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(ms * checksSlower(env));
}

/**
 * How many test files node's runner runs at once at the checks pace (kit 2.74.2): twice the processors the cap leaves,
 * two at least (12 at a third of 18 processors), and never more than the processors (kit 2.78.3: 18 at the ceiling,
 * where twice would be 32). Left to itself it starts one per processor but one, 17 on an 18-thread laptop, every one
 * held to the cap's share and the job's memory: at two processors' worth each crawled, and their own timeouts fired for
 * want of a processor. Twice keeps the cap busy while some wait on git or a timer.
 */
export function pacedTestConcurrency(cap: number, processors = os.availableParallelism()): number {
  return Math.max(2, Math.min(processors, 2 * Math.ceil((processors * cap) / 10_000)));
}

/**
 * The arguments of `node … --test …` with `--test-concurrency=<n>` after `--test`, when every argument before it is an
 * option of node's (so it is node's own, not a script's) and none names a concurrency already; any other command's as
 * they are. An npm script's node isn't seen here: only a command that is node itself (the Steward's chosen tests are).
 */
export function withTestConcurrency(file: string, args: string[], n: number): string[] {
  if (!/^node(\.exe)?$/i.test(path.basename(file))) return args;
  const i = args.indexOf('--test');
  if (i < 0 || args.slice(0, i).some((a) => !a.startsWith('-')) || args.some((a) => a.startsWith('--test-concurrency'))) return args;
  return [...args.slice(0, i + 1), `--test-concurrency=${n}`, ...args.slice(i + 1)];
}

/**
 * The memory a paced run may take, in MB: each program an eighth of the PC's memory, 2 to 6 GB; the whole job (every
 * run sharing it) a quarter, 4 to 12 GB. The Assayer's suite peaked at 0.8 GB, the Steward's trials run several side by
 * side.
 */
export function checksMemory(totalBytes = os.totalmem()): { processMb: number; jobMb: number } {
  const mb = Math.floor(totalBytes / (1024 * 1024));
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)));
  return { processMb: clamp(mb / 8, 2048, 6144), jobMb: clamp(mb / 4, 4096, 12288) };
}

/** The launcher's first word: the cap, memory per program and for the job, and runs at once (checks-pace.cs). */
export function checksLimits(cap: number, memory = checksMemory(), atOnce = CHECKS_AT_ONCE): string {
  return [cap, memory.processMb, memory.jobMb, atOnce].join(',');
}

/**
 * The cap now, in hundredths of a percent: KIT_CHECKS_PACE when it says; else the manor's ceiling (CEILING_CAP, 85%)
 * when Manor's Settings pace (`"backgroundPace"`) is full, the one switch for everything the manor runs; else Manor's
 * settings.json `"checksPace"`, else checksCap(). Either says a percentage (10 to 100) or "full". Nothing goes past the
 * ceiling (kit 2.78.3): "full", "off", 0 and 100 or more are the ceiling, where before they were no cap at all, and a
 * percentage above it is the ceiling too. Read afresh each time, so a change applies from the next command. Under
 * node --test, 0 (no cap: the command runs as it is) unless KIT_CHECKS_PACE says a percentage under 100, as ever: a
 * test's commands never build the launcher in this PC's kit folder.
 */
export function checksPaceCap(home = manorHome(), env: NodeJS.ProcessEnv = process.env): number {
  const tested = !!env.NODE_TEST_CONTEXT;
  if (tested && !env.KIT_CHECKS_PACE) return 0;
  const said = env.KIT_CHECKS_PACE?.trim() || (manorSetting(home, 'backgroundPace') === 'full' ? 'full' : manorSetting(home, 'checksPace'));
  const n = typeof said === 'number' ? said : typeof said === 'string' ? Number(said.replace(/%$/, '')) : NaN;
  if (said === 'full' || said === 'off' || said === '0' || said === 0 || n >= 100) return tested ? 0 : CEILING_CAP;
  if (!Number.isFinite(n)) return checksCap();
  return Math.min(CEILING_CAP, Math.round(Math.max(10, n) * 100));
}

/** One key of Manor's settings.json, when Manor is installed and the file can be read; undefined otherwise. */
function manorSetting(home: string, key: string): unknown {
  const file = path.join(home, 'settings.json');
  if (!existsSync(file) || !existsSync(path.join(home, 'app'))) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))?.[key];
  } catch {
    return undefined;
  }
}

/** The compiled launcher, shared by every agent on the PC: beside the gentle pace's DLL, named for its source. */
export function checksPaceExe(source = checksPaceSource()): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return path.join(path.dirname(locksDir), 'kit', `checks-pace-${hash}.exe`);
}

const checksPaceSource = () => readFileSync(new URL('./checks-pace.cs', import.meta.url), 'utf8');

/**
 * The script that compiles the launcher, when no agent has yet: to a name of its own, then moved into place, so two
 * agents compiling at once never start a half-written exe.
 */
export function checksPaceCompileScript(exe: string, source: string): string {
  return `if (-not (Test-Path -LiteralPath ${psQuote(exe)})) {
  $tmp = ${psQuote(exe.replace(/\.exe$/i, ''))} + '.' + [guid]::NewGuid().ToString('n') + '.exe'
  Add-Type -TypeDefinition ${psQuote(source)} -OutputAssembly $tmp -OutputType ConsoleApplication
  try { Move-Item -LiteralPath $tmp -Destination ${psQuote(exe)} } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
'ready'`;
}

/** The launcher being built, once per process; null once it couldn't be (said once in the log). */
let building: Promise<string | null> | null = null;

/** The launcher, built first if no agent on the PC has yet; null when it can't be. Never throws. */
export function checksPaceLauncher(log: (line: string) => void = console.log): Promise<string | null> {
  return (building ??= (async () => {
    try {
      const source = checksPaceSource();
      const exe = checksPaceExe(source);
      if (existsSync(exe)) return exe;
      mkdirSync(path.dirname(exe), { recursive: true });
      await powershell(checksPaceCompileScript(exe, source), { timeoutMs: 120_000 });
      if (existsSync(exe)) return exe;
      log(`${new Date().toISOString()} the checks pace's launcher wasn't built: checks run at full speed`);
    } catch (e) {
      log(`${new Date().toISOString()} the checks pace's launcher couldn't be built (${(e as Error).message.slice(0, 300)}): checks run at full speed`);
    }
    return null;
  })());
}

/** What to start for a paced command: the program, its arguments, and what to add to its environment. */
export interface Paced {
  file: string;
  args: string[];
  env: Record<string, string>;
  /**
   * How many times its full-speed time limit it may take (pacedSlower; kit 2.74.2), and how long it may first wait for a
   * turn: a runner stretches its limit by both. Left out (or 1 and 0) when it runs as it is.
   */
  slower?: number;
  waitMs?: number;
}

/**
 * The command `file args` at the checks pace: through the launcher with its limits (checksPaceCap(), checksMemory(), a
 * turn of checksAtOnce()), or as it is under node --test (no cap) or when the launcher can't be had. The environment
 * keeps .NET's build servers from staying behind in the job (the job ends what is left in it once its runs are done),
 * and gives the launcher the manor's ceiling (CEILING_ENV, kit 2.78.7), the job the PC's check runs share with the
 * agents and the model servers.
 * A `node --test` runs as many test files at once as the cap has room for (pacedTestConcurrency), and every command is
 * told how much slower it runs (CHECKS_SLOWER_ENV). Never throws.
 */
export async function pacedCommand(file: string, args: string[], o: { home?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void; processors?: number; what?: string } = {}): Promise<Paced> {
  const plain: Paced = { file, args, env: {} };
  const env = o.env ?? process.env;
  const processors = o.processors ?? os.availableParallelism();
  const cap = checksPaceCap(o.home, env);
  if (!cap) return plain;
  if (process.platform !== 'win32') return { file: 'nice', args: ['-n', '10', file, ...args], env: { [CHECKS_SLOWER_ENV]: String(PACED_SLOWER_MIN) }, slower: PACED_SLOWER_MIN, waitMs: 0 };
  const exe = await checksPaceLauncher(o.log);
  if (!exe) return plain;
  const testArgs = withTestConcurrency(file, args, pacedTestConcurrency(cap, processors));
  const slower = pacedSlower(cap);
  // The agent's app.ts, read only now: imported at the top it would close a loop (an agent's app.ts reads its config,
  // whose kit imports reach this file through accelerators.ts and apart.ts), and app.ts would run before its config had.
  const { APP } = await import('../app.ts');
  return {
    file: exe,
    args: [checksLimits(cap, checksMemory(), checksAtOnce(o.home)), file, ...testArgs],
    env: { MSBUILDDISABLENODEREUSE: '1', [CHECKS_SLOWER_ENV]: String(slower), [CHECKS_RUNS_ENV]: checksRunsDir(), [CHECKS_WHO_ENV]: checksWho(file, args, o.what, APP.id), [CEILING_ENV]: String(ceilingCap(env)) },
    slower,
    waitMs: CHECKS_TURN_MS,
  };
}

// ---------------------------------------------------------------- the PC's check runs in sight (kit 2.76.0)

/** The variables a launcher reads to say where it stands (checks-pace.cs): its folder, and who started it. */
export const CHECKS_RUNS_ENV = 'KIT_CHECKS_RUNS';
export const CHECKS_WHO_ENV = 'KIT_CHECKS_WHO';

/** The folder every launcher on the PC says where it stands in, one `<pid>.run` each: beside the launcher. */
export const checksRunsDir = () => path.join(path.dirname(locksDir), 'kit', 'checks-runs');

/**
 * Who a paced run is, as its launcher writes it: the agent (`agent`, its APP.id), the task it runs for (work-tasks.ts's
 * currentWork(), or nothing), and what it runs (`what`, else the program and its arguments, each path by its name), tab
 * apart. Pure but for the task.
 */
export function checksWho(file: string, args: string[], what: string | undefined, agent: string): string {
  const named = (a: string) => (/[\\/]/.test(a) && a.length > 30 ? path.basename(a) : a);
  const said = (what?.trim() || [path.basename(file).replace(/\.exe$/i, ''), ...args.map(named)].join(' ')).replace(/[\t\r\n]+/g, ' ');
  return [agent, currentWork() ?? '', said.slice(0, 200)].join('\t');
}

/** A check run on this PC as its launcher says: holding a turn (`turn`, its number), waiting for one, or running without. */
export interface ChecksRun {
  /** The launcher's process id. */
  pid: number;
  state: 'turn' | 'waiting' | 'running';
  /** Its turn's number, from 0, while it holds one. */
  slot: number | null;
  /** Since when (epoch ms): it holds its turn, waits, or runs. */
  since: number;
  /** The agent that started it, the task it is for (work-tasks.ts's id), and what it runs; empty when it didn't say. */
  agent: string;
  work: string;
  what: string;
}

/** A launcher's `<pid>.run`, read; null when it isn't one. Pure. */
export function parseChecksRun(name: string, text: string): ChecksRun | null {
  const pid = Number(/^(\d+)\.run$/.exec(name)?.[1]);
  const [head = '', who = ''] = text.replace(/^﻿/, '').split(/\r?\n/);
  const m = /^(turn|waiting|running) (-?\d+) (\S+)$/.exec(head.trim());
  const since = m ? Date.parse(m[3]) : NaN;
  if (!pid || !m || !Number.isFinite(since)) return null;
  const [agent = '', work = '', what = ''] = who.split('\t');
  return { pid, state: m[1] as ChecksRun['state'], slot: m[1] === 'turn' && Number(m[2]) >= 0 ? Number(m[2]) : null, since, agent, work, what };
}

/**
 * The check runs on this PC now (the launchers' files in `dir`), the longest held or waited first. A file whose launcher
 * has gone (stopped, never let go) is removed on the way, or left when it can't be. Never throws.
 */
export function checksRuns(dir = checksRunsDir(), alive: (pid: number) => boolean = pidAlive): ChecksRun[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ChecksRun[] = [];
  for (const name of names) {
    const pid = Number(/^(\d+)\.run$/.exec(name)?.[1]);
    if (!pid) continue;
    const file = path.join(dir, name);
    if (!alive(pid)) {
      try {
        unlinkSync(file);
      } catch {}
      continue;
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // gone meanwhile
    }
    // One being written at this moment reads as nothing: it says again at its next step.
    const run = parseChecksRun(name, text);
    if (run) out.push(run);
  }
  return out.sort((a, b) => a.since - b.since);
}
