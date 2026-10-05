import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { APP, dataDir, pageUrl, port } from '../app.ts';
import { ago } from './page.ts';
import { duty, setDuty, type Duty } from './duty.ts';
import { dataFile, readJson } from './store.ts';

/**
 * What Manor runs to employ the agent (its agents.json "commands"; Manor's README, "the agent
 * contract"), and what a person runs in a terminal. As with Reeve and Heiward, duty and the page are
 * separate:
 * - start: on duty (its scheduled rounds run), and its page up, since the rounds run in that process;
 * - stop: off duty, so the rounds pause; the page stays up, and Run now still works;
 * - open: the page up, without changing duty;
 * - shutdown: the page process ends (and with it any rounds);
 * - status: whether it's on duty and working, as one line, or as Manor's JSON with --json.
 */

/** Whether a process is still there (signal 0 only checks). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Its /api/ping answer, or null when nothing answers as this app on its port. */
export async function ping(at = port): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${at}/api/ping`, { signal: AbortSignal.timeout(2000) });
    const json = (await res.json()) as Record<string, unknown>;
    return res.ok && json?.app === APP.id ? json : null;
  } catch {
    return null;
  }
}

/**
 * The port its page answers on: this version's, else the one server.json says the running page took (an older
 * version's, before an update moved it). Null when it answers on neither.
 */
export async function pageAt(): Promise<number | null> {
  if (await ping()) return port;
  const was = readJson<{ port?: number } | null>(dataFile('server.json'), null)?.port;
  return typeof was === 'number' && was !== port && (await ping(was)) ? was : null;
}

/** Puts it on duty and makes sure its page (and so its rounds) is running. */
export async function start(cliFile: string): Promise<number> {
  setDuty(true);
  const code = await open(cliFile, { quiet: true });
  if (code === 0) console.log(`${APP.name} is on duty: ${pageUrl}`);
  return code;
}

/** Starts `serve` in the background, its output in serve.log, and waits until the page answers. Duty is unchanged. */
export async function open(cliFile: string, opts: { quiet?: boolean } = {}): Promise<number> {
  if (await ping()) {
    if (!opts.quiet) console.log(`${APP.name}'s page is up: ${pageUrl}`);
    return 0;
  }
  mkdirSync(dataDir, { recursive: true });
  const logFile = dataFile('serve.log');
  if (existsSync(logFile) && statSync(logFile).size > 5_000_000) renameSync(logFile, dataFile('serve.old.log'));
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [cliFile, 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    // The data folder, not the program's: Windows won't move a folder that is a process's current folder
    // (or its children's, like PowerShell's), and an install swaps the program's folder.
    cwd: dataDir,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await ping()) {
      if (!opts.quiet) console.log(`${APP.name}'s page is up: ${pageUrl}`);
      return 0;
    }
  }
  console.error(`${APP.name}'s page didn't start within 10 s; see ${logFile}`);
  return 1;
}

/** Takes it off duty: its scheduled rounds pause. The page, if it's up, stays up. */
export async function stop(): Promise<number> {
  const d = setDuty(false);
  console.log(`${APP.name} is off duty since ${d.since}: its scheduled rounds are paused.${(await ping()) ? ` Its page stays up: ${pageUrl}` : ''}`);
  return 0;
}

/**
 * Ends the page process (with the token from server.json) and waits until it has gone. Duty is unchanged. The page
 * is looked for on the port server.json says it took, when that isn't this version's: an update that moves the
 * agent to a new port stops the old page there (the Chamberlain's 0.1.3 left 0.1.2's on 19898).
 */
export async function shutdown(): Promise<number> {
  const info = readJson<{ token?: string; pid?: number; port?: number } | null>(dataFile('server.json'), null);
  const was = (await pageAt()) ?? port;
  if (!(await ping(was))) {
    console.log(`${APP.name}'s page isn't running.`);
    return 0;
  }
  try {
    await fetch(`http://127.0.0.1:${was}/api/stop`, { method: 'POST', headers: { 'x-token': info?.token ?? '' }, signal: AbortSignal.timeout(5000) });
  } catch {
    // It may close the connection as it exits.
  }
  for (let i = 0; i < 40; i++) {
    if (!(await ping(was))) {
      // The page stops answering a moment before its process is gone, and its files with it.
      for (let j = 0; j < 40 && typeof info?.pid === 'number' && alive(info.pid); j++) await new Promise((r) => setTimeout(r, 250));
      console.log(`${APP.name}'s page has stopped.`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`${APP.name}'s page didn't stop. Its pid is in ${dataFile('server.json')}.`);
  return 1;
}

/**
 * Whether it's running, since when it's stopped, and a line saying so, as Manor reads them: from its status command,
 * and from /api/ping (where the page is up, so running is on duty), so Manor needs no status command for an agent
 * whose page answers.
 */
export function dutyStatus(d: Duty, up: boolean): { running: boolean; stoppedSince: string | null; summary: string } {
  const running = d.onDuty && up;
  const summary = running
    ? 'On duty.'
    : !d.onDuty
      ? `Off duty since ${ago(d.since)}: its scheduled rounds are paused.`
      : "On duty, but its page isn't running, so no rounds run. Start runs it.";
  return { running, stoppedSince: d.onDuty ? null : d.since, summary };
}

/** Manor's status JSON: running means on duty with its rounds actually running (its page is up). */
export async function statusJson(): Promise<{ app: string; running: boolean; stoppedSince: string | null; summary: string; page: { url: string; up: boolean } }> {
  const up = !!(await ping());
  return { app: APP.id, ...dutyStatus(duty(), up), page: { url: pageUrl, up } };
}

/** One line, exit 0 when on duty and running and 3 when not; or with --json, Manor's JSON and exit 0. */
export async function status(json = false): Promise<number> {
  const s = await statusJson();
  if (json) {
    console.log(JSON.stringify(s));
    return 0;
  }
  console.log(`${APP.name}: ${s.summary} Page ${s.page.url} (${s.page.up ? 'up' : 'down'}).`);
  return s.running ? 0 : 3;
}
