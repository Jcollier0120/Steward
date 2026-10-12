import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locksDir } from './lock.ts';
import { setPriorityFor, type Pace } from './pace.ts';
import { powershell, psQuote } from './ps.ts';

/**
 * The rest of Heiward's background pace for every agent (kit 2.50.0; Heiward's Program.cs, Power.SetPace): at a gentle
 * pace, besides below-normal priority (pace.ts), an agent's process gets
 *
 * - **Windows' efficiency mode** (EcoQoS): Windows runs it on the efficient cores, at a low clock;
 * - **a very low disk priority**: its reads and writes wait behind everyone else's;
 * - **a hard cap on the processor**: the agent and every program it starts (git, ffmpeg, PowerShell) are in one job
 *   that may use at most a quarter of the processor, and two processors' worth at the most (gentleCap()), however
 *   many threads they run. A program that starts its own threads per processor (x265, a model's runtime) is held to
 *   the cap with the rest.
 *
 * A round someone asked for (Run now) lifts all three for as long as it runs, and a full pace (Manor's Settings) never
 * sets them. They are set from outside the agent's process, by its PowerShell worker, with gentle.cs compiled once to a
 * DLL every agent shares (gentleDll()), and only when what's wanted changes: a round at the same pace as the one
 * before costs nothing.
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
 * its own, then moved into place, so two agents compiling at once never load a half-written DLL.
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
  return `${compile}Add-Type -LiteralPath ${psQuote(dll)}
[KitGentle]::Set(${pid}, $${gentle}, ${cap})`;
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
 * Sets this process for the pace (Windows only; KIT_GENTLE=0 leaves it to priority alone): gentle for a scheduled
 * round at a gentle pace, normal for a round someone asked for or a full pace. Priority is set at once (pace.ts);
 * the rest through the worker, in order, and only when it changes. Never throws: a PC that refuses keeps its
 * priority, and the log says once what didn't take. Nothing, once keepResponsive() was called.
 */
export function paceProcess(p: Pace, asked = false): Promise<void> {
  if (responsive) return pending;
  setPriorityFor(p, asked);
  const gentle = p === 'gentle' && !asked;
  if (process.platform !== 'win32' || process.env.KIT_GENTLE === '0') return pending;
  const cap = gentleCap();
  const want = gentle ? `gentle ${cap}` : 'normal';
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
      if (took !== 'eco io cap') console.log(`${new Date().toISOString()} the ${gentle ? 'gentle' : 'normal'} pace took only in part (${took}): what didn't take stays as it was`);
    } catch (e) {
      console.log(`${new Date().toISOString()} the ${gentle ? 'gentle' : 'normal'} pace couldn't be set beyond priority: ${(e as Error).message.slice(0, 300)}`);
    }
  });
  return pending;
}
