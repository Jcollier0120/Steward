import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { APP, dataDir, devCheckout, pageUrl, port } from '../app.ts';
import { blockedIn } from './app-control.ts';
import { ago } from './page.ts';
import { duty, setDuty, type Duty } from './duty.ts';
import { licenseNow, licensePing, TRIAL_ENDED_TEXT } from './license-check.ts';
import { namedBuilt, namedId } from './named.ts';
import { CEILING_ENV, ceilingCap } from './pace.ts';
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

/**
 * How open starts the page: the program, its arguments, and how to spawn it (kit 2.72.2).
 *
 * On Windows through cmd's `start /b`, cmd started with a windowless console of its own (windowsHide, not detached).
 * The page keeps that console after cmd has gone, and the git and gh it starts share it (console.ts) instead of each
 * getting a console host (conhost.exe) of its own: one process for every git rather than two, all day. `start` also
 * takes the page out of the job Node puts what it starts in, whose processes end when the process that ran open does.
 *
 * Elsewhere, and on Windows when a path holds a `%` or a `"` (which cmd would read), detached, with no console, as before.
 *
 * With `o.named`, the agent's launcher (named.ts) and the id its job is named for, `start` runs the launcher and the
 * launcher the page, in a job of the agent's own: Task Manager shows the page under the agent's name, its output as it
 * was. The page gets a windowless console of its own there (kit 2.86.1, named.cs), whose host doesn't end with the jobs
 * the page leaves, as cmd's does (Manor's update ends Manor's task); its git and gh share that one.
 *
 * `o.args` are the page's arguments after its entry, `serve` unless said (an agent with a command of its own for its
 * page: Reeve's `dashboard --port <n>`).
 */
export function pageLaunch(
  node: string,
  entry: string,
  o: { platform?: NodeJS.Platform; comspec?: string; named?: { exe: string; id: string } | null; args?: string[] } = {},
): { file: string; args: string[]; options: { windowsHide: true; detached?: true; windowsVerbatimArguments?: true } } {
  const args = o.args ?? ['serve'];
  if ((o.platform ?? process.platform) !== 'win32' || /[%"]/.test(node + entry + args.join(''))) return { file: node, args: [entry, ...args], options: { windowsHide: true, detached: true } };
  // /s: cmd takes what's between the outer quotes as it is; start's first quoted word is a window title, here none.
  const named = o.named && !/[%"]/.test(o.named.exe) && namedId(o.named.id) ? `"${o.named.exe}" ${o.named.id} ` : '';
  const line = `"start "" /b ${named}"${node}" "${entry}" ${args.map((a) => (/^[^\s]+$/.test(a) ? a : `"${a}"`)).join(' ')}"`;
  return { file: o.comspec ?? process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', line], options: { windowsHide: true, windowsVerbatimArguments: true } };
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
  // A built release (kit 2.17.0) runs src\cli.js through the src\cli.ts stub: the page is started as cli.ts, as ever,
  // so its command line says so (Pinder and the Surveyor know the manor's own agents by it).
  const entry = cliFile.endsWith('.js') && existsSync(`${cliFile.slice(0, -3)}.ts`) ? `${cliFile.slice(0, -3)}.ts` : cliFile;
  // Under the agent's name in Task Manager once the page has built its launcher (named.ts); a checkout's job is its own.
  // When Windows blocked that launcher (Smart App Control: a program it hasn't seen, unsigned; kit 2.91.0), as node.
  const exe = namedBuilt(APP);
  for (const named of exe ? [{ exe, id: devCheckout ? `${APP.id}-dev` : APP.id }, null] : [null]) {
    const how = pageLaunch(process.execPath, entry, { named });
    const child = spawn(how.file, how.args, {
      ...how.options,
      stdio: ['ignore', log, log],
      // The data folder, not the program's: Windows won't move a folder that is a process's current folder
      // (or its children's, like PowerShell's), and an install swaps the program's folder.
      cwd: dataDir,
      // The launcher puts the page in the manor's ceiling (kit 2.78.7; named.cs), and gentle.ts an agent it didn't
      // start; Manor's own page stays out of it (gentle.ts keepResponsive()).
      env: { ...process.env, [CEILING_ENV]: String(APP.id === 'manor' ? 0 : ceilingCap()) },
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await ping()) {
        if (!opts.quiet) console.log(`${APP.name}'s page is up: ${pageUrl}`);
        return 0;
      }
    }
    if (!named) break;
    const name = path.win32.basename(named.exe).toLowerCase();
    if (!(await blockedIn(path.dirname(named.exe), 15_000)).some((b) => path.win32.basename(b.file).toLowerCase() === name)) break;
    console.error(`Windows blocked ${path.win32.basename(named.exe)}, which shows ${APP.name} by name in Task Manager: its page starts without it`);
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
 * whose page answers. Once the trial has ended (`trialEnded`, license-check.ts) it isn't running, whatever its duty,
 * and the line says why.
 */
export function dutyStatus(d: Duty, up: boolean, trialEnded = false): { running: boolean; stoppedSince: string | null; summary: string } {
  const running = d.onDuty && up && !trialEnded;
  const summary = trialEnded
    ? `${TRIAL_ENDED_TEXT}. Its rounds wait; its settings and data are kept.`
    : running
      ? 'On duty.'
      : !d.onDuty
        ? `Off duty since ${ago(d.since)}: its scheduled rounds are paused.`
        : "On duty, but its page isn't running, so no rounds run. Start runs it.";
  return { running, stoppedSince: d.onDuty ? null : d.since, summary };
}

/** Manor's status JSON: running means on duty with its rounds actually running (its page is up). */
export async function statusJson(): Promise<{ app: string; running: boolean; stoppedSince: string | null; summary: string; page: { url: string; up: boolean }; license?: unknown }> {
  const up = !!(await ping());
  const license = licenseNow();
  return { app: APP.id, ...dutyStatus(duty(), up, license.ended), page: { url: pageUrl, up }, ...licensePing(license) };
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
