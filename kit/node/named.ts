import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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

/** The agent's launcher: in the kit's folder, named for the agent and its source, so a new named.cs is a new exe. */
export function namedExe(id: string, source: string, kitDir = path.join(path.dirname(locksDir), 'kit')): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  return path.join(kitDir, `named-${id.toLowerCase()}-${hash}.exe`);
}

type NamedOptions = { kitDir?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };

/**
 * Whether the agent gets a launcher: on Windows, for an id it takes, and under node --test only with KIT_NAMED=1 (a
 * test never builds one in this PC's kit folder).
 */
export function namedWanted(app: { id: string }, o: NamedOptions = {}): boolean {
  const env = o.env ?? process.env;
  return (o.platform ?? process.platform) === 'win32' && namedId(app.id) && (!env.NODE_TEST_CONTEXT || env.KIT_NAMED === '1');
}

/** The agent's launcher when it's been built, for open to start the page through; null otherwise. Never throws. */
export function namedBuilt(app: { id: string; name: string }, o: NamedOptions = {}): string | null {
  try {
    if (!namedWanted(app, o)) return null;
    const exe = namedExe(app.id, namedSource(app.name), o.kitDir);
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** The launcher being built, once per process; null once it couldn't be (said once in the log). */
let building: Promise<string | null> | null = null;

/**
 * The agent's launcher, built first if this agent's isn't yet; null where it can't be (namedWanted, or the compiler
 * refused). Never throws.
 */
export function namedLauncher(app: { id: string; name: string }, o: NamedOptions & { log?: (line: string) => void } = {}): Promise<string | null> {
  if (!namedWanted(app, o)) return Promise.resolve(null);
  const log = o.log ?? console.log;
  return (building ??= (async () => {
    try {
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
