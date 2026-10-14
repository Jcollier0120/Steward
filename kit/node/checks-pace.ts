import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locksDir } from './lock.ts';
import { manorHome } from './manor.ts';
import { powershell, psQuote } from './ps.ts';

/**
 * The checks pace (kit 2.70.0): test runs, type checks, installs and builds that an agent starts (the Steward's vouch,
 * its kit trials, its merge checks and releases; the Assayer's checks) can't take the whole processor. Node's test
 * runner starts a test file per processor but one, and a type check, an install and a test run side by side kept a PC's
 * processor at 100% for a minute at a time, its fans at full.
 *
 * A paced command runs through a small launcher (checks-pace.cs, compiled once to an exe every agent on the PC shares, as
 * gentle.cs is to a DLL) that starts it, and every program it starts, in a job with
 *
 * - **a hard cap on the processor**: at most half of it by default (checksCap()), however many threads they run;
 * - **below-normal priority**: they give way to whatever the person is doing.
 *
 * The job is one for the whole PC: check runs side by side (two vouches, a trial's tries) share the cap rather than
 * taking it twice, so together they never peg the processor either.
 *
 * Manor's settings.json `"checksPace"` (or KIT_CHECKS_PACE) changes the cap: a percentage of the processor from 10 to
 * 100, or "full" for none. A run the person asked to be fast (vouch --fast) isn't paced at all, as Run now lifts the
 * gentle pace. Windows only: elsewhere a paced command runs under `nice`. Never fails a command: a launcher that can't
 * be built or started leaves the command to run as it is.
 */

/**
 * The cap by default, in hundredths of a percent: half the processor. Measured on an 18-core laptop (Steward 0.35.64):
 * the Steward's checks kept it at 98% or more for 60 s of their 201 s, and at half they never passed 70% with the rest of
 * the PC's work on top, for about a third more time. Two processors' worth at least, so a small PC's checks still move.
 */
export function checksCap(processors = os.availableParallelism()): number {
  return Math.round(Math.min(100, Math.max(50, 200 / Math.max(1, processors))) * 100);
}

/**
 * The cap now, in hundredths of a percent, or 0 for none: KIT_CHECKS_PACE, else Manor's settings.json `"checksPace"`,
 * else checksCap(). Either says a percentage (10 to 100; 100 is none) or "full" (none). Read afresh each time, so a
 * change applies from the next command. Under node --test, none unless KIT_CHECKS_PACE says: a test's commands never
 * build the launcher in this PC's kit folder.
 */
export function checksPaceCap(home = manorHome(), env: NodeJS.ProcessEnv = process.env, processors = os.availableParallelism()): number {
  if (env.NODE_TEST_CONTEXT && !env.KIT_CHECKS_PACE) return 0;
  const said = env.KIT_CHECKS_PACE?.trim() || manorSetting(home, 'checksPace');
  if (said === 'full' || said === 'off' || said === '0' || said === 0) return 0;
  const n = typeof said === 'number' ? said : typeof said === 'string' ? Number(said.replace(/%$/, '')) : NaN;
  if (!Number.isFinite(n)) return checksCap(processors);
  if (n >= 100) return 0;
  return Math.round(Math.max(10, n) * 100);
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
}

/**
 * The command `file args` at the checks pace: through the launcher with the cap (checksPaceCap()), or as it is when the
 * person asked for it fast, the cap is off, or the launcher can't be had. The environment keeps .NET's build servers from
 * staying behind in the job (the job ends what is left in it once its runs are done). Never throws.
 */
export async function pacedCommand(file: string, args: string[], o: { fast?: boolean; home?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}): Promise<Paced> {
  const plain: Paced = { file, args, env: {} };
  const env = o.env ?? process.env;
  if (o.fast) return plain;
  const cap = checksPaceCap(o.home, env);
  if (!cap) return plain;
  if (process.platform !== 'win32') return { file: 'nice', args: ['-n', '10', file, ...args], env: {} };
  const exe = await checksPaceLauncher(o.log);
  if (!exe) return plain;
  return { file: exe, args: [String(cap), file, ...args], env: { MSBUILDDISABLENODEREUSE: '1' } };
}
