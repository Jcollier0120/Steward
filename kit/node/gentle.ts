import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locksDir } from './lock.ts';
import { pace, setPriorityFor, type Pace } from './pace.ts';
import { powershell, psQuote } from './ps.ts';

/**
 * The rest of Heiward's background pace for every agent (kit 2.50.0; Heiward's Program.cs, Power.SetPace): at a gentle
 * pace, besides below-normal priority (pace.ts), an agent's process gets
 *
 * - **Windows' efficiency mode** (EcoQoS): Windows runs it on the efficient cores, at a low clock;
 * - **a very low disk priority**: its reads and writes wait behind everyone else's;
 * - **a hard cap on the processor**: the agent and every program it starts (git, ffmpeg, PowerShell, its PowerShell
 *   worker too) are in one job that may use at most a quarter of the processor, and two processors' worth at the most
 *   (gentleCap()), however many threads they run. A program that starts its own threads per processor (x265, a
 *   model's runtime) is held to the cap with the rest.
 *
 * The pace is the owner's setting alone (kit 2.73.0): Manor's Settings, gentle or full. Nothing else lifts it, not a
 * round someone asked for (Run now) nor a page being looked at, so what a page shows is what the agent costs in the
 * background. They are set from outside the agent's process, by its PowerShell worker, with gentle.cs compiled once to
 * a DLL every agent shares (gentleDll()), and only when the setting changes: a round at the same pace as the one before
 * costs nothing.
 */

/** The processor cap at a gentle pace, in hundredths of a percent: a quarter, and two processors' worth at most. */
export function gentleCap(processors = os.availableParallelism()): number {
  return Math.round(Math.min(25, 200 / Math.max(1, processors)) * 100);
}

/** The compiled helper, shared by every agent on the PC: beside the accelerators' locks, named for its source. */
export function gentleDll(source = gentleSource()): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return path.join(path.dirname(locksDir), 'kit', `gentle-${hash}.dll`);
}

const gentleSource = () => readFileSync(new URL('./gentle.cs', import.meta.url), 'utf8');

/**
 * The script that sets process `pid` gentle or not. It compiles the helper first when no agent has yet: to a name of
 * its own, then moved into place, so two agents compiling at once never load a half-written DLL. Gentle, the worker
 * running it then joins the agent's job (it was started before the job was made, so isn't in it yet).
 */
export function gentleScript(pid: number, gentle: boolean, cap: number, dll: string, source: string | null): string {
  const compile = source === null
    ? ''
    : `if (-not (Test-Path -LiteralPath ${psQuote(dll)})) {
  $tmp = ${psQuote(dll)} + '.' + [guid]::NewGuid().ToString('n') + '.tmp'
  Add-Type -TypeDefinition ${psQuote(source)} -OutputAssembly $tmp -OutputType Library
  try { Move-Item -LiteralPath $tmp -Destination ${psQuote(dll)} } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
`;
  const set = `[KitGentle]::Set(${pid}, $${gentle}, ${cap})`;
  return `${compile}Add-Type -LiteralPath ${psQuote(dll)}
${gentle ? `${set} + ' ' + [KitGentle]::Join(${pid})` : set}`;
}

/** What this process was last set to: it starts as Windows starts every process, not gentle. */
let applied: string = 'normal';
let pending: Promise<void> = Promise.resolve();
let responsive = false;

/**
 * For a process people wait on (Manor, whose page every Open and every agent's card goes through; kit 2.57.1): its
 * rounds never set it gentle, so it keeps normal priority, no efficiency mode and no processor cap, whatever the pace.
 * At a gentle pace its page sat ready to run for up to half a minute at a time while Windows gave it no processor, and
 * the programs it starts were held to its cap with it. Undoes a gentle pace already set; the agents' own processes keep theirs.
 */
export function keepResponsive(): Promise<void> {
  const back = paceProcess('full');
  responsive = true;
  return back;
}

/**
 * Once did something (kit 2.57.1 to 2.69): a browser asking for the page lifted the agent to a normal pace for a minute,
 * its round children with it, so nobody looking at a page ever saw its real background rates. From kit 2.73.0 the pace
 * is the owner's setting alone (Manor's Settings, gentle or full), and this does nothing. Kept so an agent that calls
 * it (Chronicler) still builds.
 */
export function pageInUse(_now = Date.now()): void {}

/** The pace its rounds last asked for (none yet: as Windows started it). */
let wanted: Pace | null = null;
/** What the process is set to: 'normal', or 'gentle <cap>' (also where Windows' calls are off: KIT_GENTLE=0, not Windows). */
let setTo = 'normal';

/** What the process is set to now: 'normal', or 'gentle <cap>' with its job's cap in hundredths of a percent. */
export const paceSet = () => setTo;

/**
 * Sets this process for the pace, the owner's setting (Manor's Settings, pace.ts pace()), and nothing else. Windows only
 * beyond priority; KIT_GENTLE=0 leaves it to priority alone. Priority is set at once (pace.ts); the rest through the
 * worker, in order, and only when it changes, so a round at the same pace as the one before starts no PowerShell.
 * Never throws: a PC that refuses keeps its priority, and the log says once what didn't take. Nothing, once
 * keepResponsive() was called.
 */
export function paceProcess(p: Pace): Promise<void> {
  if (responsive) return pending;
  wanted = p;
  return applyPace();
}

function applyPace(): Promise<void> {
  const p = wanted ?? 'full';
  setPriorityFor(p);
  const gentle = p === 'gentle';
  const cap = gentleCap();
  const want = gentle ? `gentle ${cap}` : 'normal';
  setTo = want;
  if (process.platform !== 'win32' || process.env.KIT_GENTLE === '0') return pending;
  pending = pending.then(async () => {
    if (want === applied) return;
    applied = want;
    try {
      const source = gentleSource();
      const dll = gentleDll(source);
      let first: string | null = null;
      if (!existsSync(dll)) {
        mkdirSync(path.dirname(dll), { recursive: true });
        first = source;
      }
      const took = (await powershell(gentleScript(process.pid, gentle, cap, dll, first), { timeoutMs: 120_000 })).trim();
      if (took !== (gentle ? 'eco io cap worker' : 'eco io cap')) console.log(`${new Date().toISOString()} the ${gentle ? 'gentle' : 'normal'} pace took only in part (${took}): what didn't take stays as it was`);
    } catch (e) {
      console.log(`${new Date().toISOString()} the ${gentle ? 'gentle' : 'normal'} pace couldn't be set beyond priority: ${(e as Error).message.slice(0, 300)}`);
    }
  });
  return pending;
}

/** How often a process that contains itself reads the pace again: a file read, PowerShell only when it changed. */
export const CONTAIN_CHECK_MS = 5 * 60_000;
let containTimer: NodeJS.Timeout | null = null;

/**
 * For a long-lived process that doesn't run its work with every() (an MCP server, a page of its own, a scheduled job;
 * kit 2.73.0): sets it at the owner's pace now (Manor's Settings; `own` when Manor doesn't say), gentle in a job with
 * the gentle cap that every program it starts afterwards is in too, and reads the setting again every
 * CONTAIN_CHECK_MS so a change applies without a restart. Call it first, before the process starts anything. Model
 * servers it starts leave its job (accelerators.ts, apart.ts): they serve every agent, and an asker's cap isn't theirs.
 */
export function containSelf(own: Pace = 'gentle', read: () => Pace = () => pace(own)): Promise<void> {
  const done = paceProcess(read());
  if (!containTimer) {
    containTimer = setInterval(() => {
      const p = read();
      if (p !== wanted) void paceProcess(p);
    }, CONTAIN_CHECK_MS);
    containTimer.unref?.();
  }
  return done;
}
