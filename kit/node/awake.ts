import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sharesConsole } from './console.ts';
import { locksDir } from './lock.ts';
import { powershell, psQuote } from './ps.ts';

/**
 * Keeping the PC awake while an agent's work runs (kit 2.74.8). On 2026-10-15 a PC sleeping on its own for an hour in
 * the middle of the Steward's checks, and again for 13 minutes, was much of why its round ran out of time. While work is
 * held (stayAwake, whileAwake, a round's `awake` in schedule.ts), Windows doesn't sleep on its own; once the last hold
 * is let go, it may again.
 *
 * Idle sleep only: a sleep the person chooses (Start's Sleep, the power button, closing the lid) still happens, as does
 * one a program brings on by turning the screen off (a vendor's screen saver: sleep-cause.ts), and the display still
 * turns off. Only work holds it, never a round that merely looks: a hold resets Windows' idle timer, so
 * rounds every few minutes holding it would keep the PC up all day.
 *
 * On Windows a small helper holds it (awake.cs, compiled once to an exe every agent on the PC shares, as checks-pace.cs
 * is): started when the first hold begins, its input closed when the last ends. It lets go if the agent ends first, and
 * Windows drops its request when it exits, so a hold never outlives the agent. Elsewhere nothing is done. Never fails the
 * work: a helper that can't be built or started leaves the PC to its own power settings, said once in the log.
 */

/** A hold had of Windows: ended once nothing holds the PC awake. */
export interface WindowsHold {
  end(): void;
}

/** How a hold is had: the helper started on Windows; a test injects its own, and the platform. */
export interface AwakeDeps {
  platform: NodeJS.Platform;
  hold: (log: (line: string) => void) => Promise<WindowsHold | null>;
}

/** Under node --test nothing is held unless a test says how (setAwakeDeps): a test run never builds or starts the helper. */
const defaults = (): AwakeDeps => ({ platform: process.platform, hold: process.env.NODE_TEST_CONTEXT ? async () => null : helperHold });
let deps: AwakeDeps = defaults();

/** For tests: the Windows call and the platform stood in for; null puts the real ones back. */
export function setAwakeDeps(d: Partial<AwakeDeps> | null): void {
  deps = d ? { ...defaults(), ...d } : defaults();
}

/** What holds the PC awake now, by hold. */
const holding = new Map<number, string>();
let nextId = 1;
/** The hold had of Windows while anything holds it, as it is being had. */
let held: Promise<WindowsHold | null> | null = null;

/**
 * Holds the PC awake for `what` (a round's checks, a merge, a release) until the function it returns is called; holds
 * from anywhere in the process share one hold of Windows. Calling the function again does nothing. Never throws.
 */
export function stayAwake(what: string, log: (line: string) => void = console.log): () => void {
  if (deps.platform !== 'win32') return () => {};
  const id = nextId++;
  holding.set(id, what);
  if (!held) held = deps.hold(log).catch(() => null);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holding.delete(id);
    if (holding.size || !held) return;
    const h = held;
    held = null;
    void h.then((x) => x?.end());
  };
}

/** `fn`, with the PC held awake for `what` while it runs. */
export async function whileAwake<T>(what: string, fn: () => Promise<T>, log?: (line: string) => void): Promise<T> {
  const letGo = stayAwake(what, log);
  try {
    return await fn();
  } finally {
    letGo();
  }
}

/** What holds the PC awake now (empty: nothing), for a page or a log. */
export const awakeFor = (): string[] => [...holding.values()];

/** The compiled helper, shared by every agent on the PC: beside the checks pace's launcher, named for its source. */
export function awakeExe(source = awakeSource()): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return path.join(path.dirname(locksDir), 'kit', `awake-${hash}.exe`);
}

const awakeSource = () => readFileSync(new URL('./awake.cs', import.meta.url), 'utf8');

/** The script that compiles the helper when no agent has yet: to a name of its own, then moved into place. */
export function awakeCompileScript(exe: string, source: string): string {
  return `if (-not (Test-Path -LiteralPath ${psQuote(exe)})) {
  $tmp = ${psQuote(exe.replace(/\.exe$/i, ''))} + '.' + [guid]::NewGuid().ToString('n') + '.exe'
  Add-Type -TypeDefinition ${psQuote(source)} -OutputAssembly $tmp -OutputType ConsoleApplication
  try { Move-Item -LiteralPath $tmp -Destination ${psQuote(exe)} } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
'ready'`;
}

/** The helper being built, once per process; null once it couldn't be. */
let building: Promise<string | null> | null = null;

/** The helper's exe, built if no agent on the PC has yet; null when it can't be (said once in the log). */
export function awakeHelperExe(log: (line: string) => void): Promise<string | null> {
  return (building ??= (async () => {
    try {
      const source = awakeSource();
      const exe = awakeExe(source);
      if (existsSync(exe)) return exe;
      mkdirSync(path.dirname(exe), { recursive: true });
      await powershell(awakeCompileScript(exe, source), { timeoutMs: 120_000 });
      if (existsSync(exe)) return exe;
      log(`${new Date().toISOString()} the helper that keeps the PC awake during work wasn't built: the PC's own power settings apply`);
    } catch (e) {
      log(`${new Date().toISOString()} the helper that keeps the PC awake during work couldn't be built (${(e as Error).message.slice(0, 300)}): the PC's own power settings apply`);
    }
    return null;
  })());
}

/** Windows held awake by the helper, started for this process; null when it can't be. */
async function helperHold(log: (line: string) => void): Promise<WindowsHold | null> {
  const exe = await awakeHelperExe(log);
  if (!exe) return null;
  try {
    const child = spawn(exe, [String(process.pid)], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: !sharesConsole() });
    child.on('error', (e) => log(`${new Date().toISOString()} the helper that keeps the PC awake during work couldn't start: ${e.message}`));
    child.stdin.on('error', () => {});
    // Neither the helper nor its input keeps a process that is done from ending: it lets go once this one ends.
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    return {
      end() {
        child.stdin.end();
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }, 10_000).unref();
      },
    };
  } catch (e) {
    log(`${new Date().toISOString()} the helper that keeps the PC awake during work couldn't start: ${(e as Error).message}`);
    return null;
  }
}
