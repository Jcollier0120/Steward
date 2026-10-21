import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { smartAppControlState, type SacState } from './app-control.ts';
import { checksPaceCompileScript } from './checks-pace.ts';
import { locksDir } from './lock.ts';
import { powershell } from './ps.ts';

/**
 * The agent's name in Task Manager. Task Manager's Processes tab shows a program by its file description, and puts the
 * programs it starts under it. An agent's page was node.exe itself, so every agent showed as one more "Node.js
 * JavaScript Runtime", and its processor and memory couldn't be told from another's. Its page now runs through a small
 * launcher with the agent's name (named.cs), so it shows as "Smith (3)", the page, its PowerShell worker and its git
 * inside, in a Windows job of the agent's own (Local\Castellan-<id>). The job ends nothing: what the page starts
 * detached (an install's watcher, a model server) outlives it, as before.
 *
 * Compiled once per agent and version of named.cs, its name written in, into the folder every agent's launchers share
 * (beside the checks pace's). The page builds it, a while after it starts (server.ts), so open never waits on a
 * compiler while Manor waits on open; open uses it once it's there (service.ts's pageLaunch), from the page's next
 * start (a sign-in, an update). Where it can't be had (not Windows, the compiler refused), the page starts as before:
 * the name is never a reason not to start.
 *
 * The launcher is compiled on the PC, so no one has signed it, and Smart App Control blocks a program it doesn't know
 * unless it's signed. Where Smart App Control is on, or Windows is weighing it, there's no launcher (kit 2.93.1): the
 * page runs as node.exe, which its maker signs, unnamed in Task Manager. On the owner's gaming desktop (2026-10-21) every
 * agent's launcher was blocked at each sign-in, each block a notice of its own, before kit 2.91.0's start as node.
 */

/** The word in named.cs that becomes the agent's name: the launcher's title, which Windows shows as its description. */
export const NAMED_TITLE = 'KIT_NAMED_TITLE';

const namedTemplate = () => readFileSync(new URL('./named.cs', import.meta.url), 'utf8');

/** named.cs with the agent's name written in, as a C# string's contents. Pure. */
export function namedSource(name: string, template = namedTemplate()): string {
  const title = name.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return template.replace(`"${NAMED_TITLE}"`, `"${title}"`);
}

/** An agent's id as the launcher takes it, and its job is named for: letters, digits and hyphens (named.cs's IsId). */
export const namedId = (id: string) => /^[A-Za-z0-9-]{1,64}$/.test(id);

/** The folder every agent's launchers share, beside the checks pace's. */
const kitFolder = () => path.join(path.dirname(locksDir), 'kit');

/** The agent's launcher: in the kit's folder, named for the agent and its source, so a new named.cs is a new exe. */
export function namedExe(id: string, source: string, kitDir = kitFolder()): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return path.join(kitDir, `named-${id.toLowerCase()}-${hash}.exe`);
}

/** Smart App Control's state as the launcher asks it; tests pass their own. */
type NamedOptions = { kitDir?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; sac?: () => SacState | null };

/** Why this PC's launchers are held: Smart App Control, or a block Windows' log showed (another policy, an organization's). */
export type NamedHold = 'smart-app-control' | 'blocked';

/** The file that holds every agent's launcher on this PC, its reason inside, in the folder they share. */
export const namedHoldFile = (kitDir = kitFolder()) => path.join(kitDir, 'named.held');

/** Holds every agent's launcher on this PC, for `reason`. Never throws. */
export function namedHold(reason: NamedHold, kitDir?: string): void {
  try {
    const file = namedHoldFile(kitDir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, reason);
  } catch {
    // Not held: the next start finds out again.
  }
}

/**
 * Whether the launchers are held on this PC: Smart App Control on or in evaluation, or a block of one seen before. A hold
 * for Smart App Control is let go once it's off; one for another policy's block stays. Never throws.
 */
export function namedHeld(o: NamedOptions = {}): boolean {
  const state = (o.sac ?? (() => smartAppControlState(undefined, o.platform)))();
  if (state === 'on' || state === 'evaluation') {
    namedHold('smart-app-control', o.kitDir);
    return true;
  }
  const file = namedHoldFile(o.kitDir);
  let reason: string | null = null;
  try {
    reason = readFileSync(file, 'utf8').trim();
  } catch {
    return false;
  }
  if (reason === 'smart-app-control' && state === 'off') {
    rmSync(file, { force: true });
    return false;
  }
  return true;
}

/**
 * Whether the agent gets a launcher: on Windows, for an id it takes, and under node --test only with KIT_NAMED=1 (a
 * test never builds one in this PC's kit folder).
 */
export function namedWanted(app: { id: string }, o: NamedOptions = {}): boolean {
  const env = o.env ?? process.env;
  return (o.platform ?? process.platform) === 'win32' && namedId(app.id) && (!env.NODE_TEST_CONTEXT || env.KIT_NAMED === '1');
}

/** The agent's launcher when it's been built and isn't held, for open to start the page through; null otherwise. Never throws. */
export function namedBuilt(app: { id: string; name: string }, o: NamedOptions = {}): string | null {
  try {
    if (!namedWanted(app, o)) return null;
    const exe = namedExe(app.id, namedSource(app.name), o.kitDir);
    return existsSync(exe) && !namedHeld(o) ? exe : null;
  } catch {
    return null;
  }
}

/** The launcher being built, once per process; null once it couldn't be (said once in the log). */
let building: Promise<string | null> | null = null;

/**
 * The agent's launcher, built first if this agent's isn't yet; null where it can't be (namedWanted, a hold, or the
 * compiler refused). Never throws.
 */
export function namedLauncher(app: { id: string; name: string }, o: NamedOptions & { log?: (line: string) => void } = {}): Promise<string | null> {
  if (!namedWanted(app, o)) return Promise.resolve(null);
  const log = o.log ?? console.log;
  return (building ??= (async () => {
    try {
      // Nothing is compiled where Smart App Control would block it.
      if (namedHeld(o)) return null;
      const source = namedSource(app.name);
      const exe = namedExe(app.id, source, o.kitDir);
      if (existsSync(exe)) return exe;
      mkdirSync(path.dirname(exe), { recursive: true });
      await powershell(checksPaceCompileScript(exe, source), { timeoutMs: 120_000 });
      if (existsSync(exe)) return exe;
      log(`${new Date().toISOString()} ${app.name}'s named launcher wasn't built: its page runs as node.exe`);
    } catch (e) {
      log(`${new Date().toISOString()} ${app.name}'s named launcher couldn't be built (${(e as Error).message.slice(0, 300)}): its page runs as node.exe`);
    }
    return null;
  })());
}
