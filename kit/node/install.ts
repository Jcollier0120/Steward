import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, appRoot, dataDir, devCheckout, pageUrl } from '../app.ts';
import { duty, setDuty } from './duty.ts';
import { flushTree } from './flush.ts';
import { endProcesses, keepOwnArch, nativeRelease, pagesFrom, processesUnder, type NativeRelease } from './native.ts';
import { inside, realPath, samePath } from './real-path.ts';
import { pageAt, ping, shutdown } from './service.ts';

/**
 * Installing from a release, as each of Manor's agents does on its own (Manor's docs/INSTALLING.md):
 * - install copies the release it runs from to <data folder>\app, and registers one task,
 *   \<Name> (<account>)\Home page, that runs `open`. `open` never changes duty, so an agent stopped in Manor stays
 *   stopped after a restart. It's the only task: the rounds still run inside the page process, so
 *   Stop in Manor still stops the work. It runs at sign-in only where Manor doesn't start its staff: with Castellan in
 *   Windows' Startup apps (MANOR_STARTUP, kit 2.57.0) Manor starts it, and the task runs only when an install asks.
 * - uninstall ends the page process, deletes the task and removes app; --purge also removes the data.
 * A development checkout does neither: its own data is the -dev folder, and code reaches app only
 * through a release.
 */

/**
 * The account a task folder is named for (kit 2.95.0, as Manor's windows.ts taskAccount): the profile folder's name,
 * which renaming the account doesn't change, else the user's name, with what Task Scheduler won't take in a name made `_`.
 */
export function taskAccount(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.USERPROFILE ? path.win32.basename(env.USERPROFILE.replace(/[\\/]+$/, '')) : '';
  return (profile || env.USERNAME || 'user').replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * A task in its program's Task Scheduler folder for this account (kit 2.95.0): taskName('Home page') is
 * \Porter (Jcoll)\Home page, and `program` names another's (taskName('Home page', env, 'Manor') is Manor's). Task
 * Scheduler's names are the PC's, not the account's, so two accounts' \Porter\Home page were one task: the second
 * account's install replaced the first's, or was refused (Castellan for everyone on a PC, Manor's
 * docs/EVERYONE-INSTALL.md). Each account's folder is made by that account.
 */
export const taskName = (task: string, env: NodeJS.ProcessEnv = process.env, program: string = APP.name) => `\\${program} (${taskAccount(env)})\\${task}`;

/** The sign-in task, in the agent's Task Scheduler folder for this account, as Manor's, Reeve's and Heiward's are. */
export const TASK_NAME = taskName('Home page');

/** The task that wakes the PC for work due at set times (wake.ts, kit 2.78.2), beside it; uninstall deletes it too. */
export const WAKE_TASK_NAME = taskName('Wake');

/**
 * Their names before kit 2.95.0, in a folder named after the agent alone. An install or update moves this account's
 * own off them (dropOldTask), and leaves another account's be.
 */
export const OLD_TASK_NAME = `\\${APP.name}\\Home page`;
export const OLD_WAKE_TASK_NAME = `\\${APP.name}\\Wake`;

/** conhost --headless gives node its console without a window; the task's "Hidden" only hides it in the UI. */
export const CONHOST = 'C:\\Windows\\System32\\conhost.exe';
const SCHTASKS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
const REG = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
const WHOAMI = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');

/**
 * Manor's entry in Windows' Startup apps (Manor's install.ts STARTUP_KEY and STARTUP_VALUE, from Manor 0.16.120): there,
 * Castellan starts Manor at sign-in and Manor starts its staff, one at a time, so an agent's own task has no sign-in
 * trigger. Turned off in Startup apps, the value stays (Windows keeps that choice apart), and nothing starts: the
 * person's choice.
 */
export const MANOR_STARTUP = { key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', value: 'Castellan' };

export const DEV_CHECKOUT = 'This is a development checkout. Build a release and install that: npm run release -- --install';

/** What a release says about itself: release.json at its root, written by src/kit/release.ts. */
export interface Release {
  id: string;
  name: string;
  version: string;
  commit: string;
  dirty: boolean;
  built: string;
  /** The Steward's kit it carries in src\kit\ (none in a release from before the kit had a version). */
  kit?: string;
  /** Built (minified: minify.ts, kit 2.16.0), or readable (--readable, never published); none before kit 2.16.0. */
  form?: 'minified' | 'readable';
  /** The native files it carries (native.ts, kit 2.62.0): where, for which processors, and whether they're signed. */
  native?: NativeRelease;
  /**
   * Whether the Exchequer sells it, as its list said when it was published (kit 2.110.0). The license check doesn't
   * read it (kit 2.113.0): every agent but Manor and Heiward checks. None in a release from before, one not published,
   * or when it couldn't say.
   */
  sold?: boolean;
}

export interface Ran {
  code: number;
  out: string;
}

/** Everything install and uninstall reach outside themselves, so a test can stand in for each. */
export interface InstallDeps {
  /** The copy that is running: the release to install. */
  root: string;
  /** Whether that copy is a development checkout. */
  dev: boolean;
  /** The installed copy's data folder. Its program goes in <dataDir>\app. */
  dataDir: string;
  /** The Node the sign-in task runs: the one running install. */
  node: string;
  /** DOMAIN\user: the task runs at this user's sign-in, as this user. */
  user: string;
  /** This user's SID (whoami /user), which Task Scheduler keeps a task's principal as; null when it can't be read. Unset: none. */
  userSid?(): Promise<string | null>;
  pageUrl: string;
  /** Where uninstall goes before removing a folder it is in. */
  home: string;
  schtasks(args: string[]): Promise<Ran>;
  /** Whether the installed copy's page answers its ping. */
  ping(): Promise<boolean>;
  /**
   * Whether its page is running at all: on its port, or on the one an older version took (server.json's), so an
   * update that moves the port ends the old page. Unset: ping.
   */
  running?(): Promise<boolean>;
  /** Ends the installed copy's page process (the kit's shutdown). */
  shutdown(): Promise<number>;
  /** Whether Manor starts its staff at sign-in (MANOR_STARTUP is there). Unset: no, and the task starts it as before. */
  manorStarts?(): Promise<boolean>;
  onDuty(): boolean;
  setDuty(on: boolean): void;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
  /** Moves a folder (default: fs.renameSync); a test can make it fail. */
  rename?(from: string, to: string): void;
  /** Writes a folder's files through to the disk before it is swapped in (default: flush.ts flushTree). */
  flush?(dir: string): void;
  /** This PC's processor, as Node names it (default: process.arch): which native files are kept. */
  arch?: string;
  /** The processes running a program from under a folder (default: native.ts processesUnder). */
  programsIn?(dir: string): Promise<number[]>;
  /** Ends processes by id (default: native.ts endProcesses). */
  endPrograms?(ids: number[]): Promise<void>;
  /** The page processes started from an app folder, still running: `serve` and the `open` that starts it (default: native.ts pagesFrom). */
  pagesStarting?(app: string): Promise<number[]>;
}

export const appFolder = (data: string) => path.join(data, 'app');
export const taskXmlFile = (data: string) => path.join(data, 'home-page.task.xml');
const cliIn = (app: string) => path.win32.join(app, 'src', 'cli.ts');

export function taskUser(env: Record<string, string | undefined> = process.env): string {
  const user = env.USERNAME ?? '';
  const domain = env.USERDOMAIN ?? '';
  return domain ? `${domain}\\${user}` : user;
}

/** What looking at a task, and running or ending it, needs: Task Scheduler and who this user is. */
export type TaskDeps = Pick<InstallDeps, 'schtasks' | 'user' | 'userSid'>;

let sidRead: Promise<string | null> | undefined;

/** This user's SID (whoami /user), asked once; null when whoami doesn't answer. */
export function userSid(): Promise<string | null> {
  return (sidRead ??= run(WHOAMI, ['/user', '/fo', 'csv', '/nh']).then((r) => (r.code === 0 ? (/"(S-1-[0-9-]+)"/i.exec(r.out)?.[1] ?? null) : null)));
}

/** Two of Task Scheduler's ways of writing a user (DOMAIN\user, or the name alone) are the same user. */
function sameUser(a: string, b: string): boolean {
  const name = (u: string) => u.slice(u.lastIndexOf('\\') + 1).toLowerCase();
  return a.toLowerCase() === b.toLowerCase() || (!(a.includes('\\') && b.includes('\\')) && name(a) === name(b));
}

/**
 * Whether the task is there and this account's own (kit 2.95.0, as Manor's windows.ts isOwnTask): the user its
 * principal runs as (a SID, as Task Scheduler keeps it, or a name) is this user. Another account's task of the same
 * name, from before each account had a folder of its own, is never this account's to end or delete.
 */
export async function isOwnTask(name: string, d: TaskDeps): Promise<boolean> {
  const q = await d.schtasks(['/Query', '/TN', name, '/XML']);
  if (q.code !== 0) return false;
  // The principal's, not a logon trigger's (which comes first in the XML, and may name someone else).
  const owner = /<Principal\b[^>]*>[\s\S]*?<UserId>\s*([^<]+?)\s*<\/UserId>/i.exec(q.out)?.[1];
  if (!owner) return false;
  return /^S-1-/i.test(owner) ? (await d.userSid?.())?.toLowerCase() === owner.toLowerCase() : sameUser(owner, d.user);
}

/**
 * Moves a task off its old name (kit 2.95.0): ends and deletes it, but only when it's this account's own (isOwnTask),
 * never another account's. True when one was deleted. Task Scheduler leaves the old folder, empty.
 */
export async function dropOldTask(old: string, d: TaskDeps): Promise<boolean> {
  if (!(await isOwnTask(old, d))) return false;
  await d.schtasks(['/End', '/TN', old]);
  return (await d.schtasks(['/Delete', '/TN', old, '/F'])).code === 0;
}

/**
 * Runs one of this account's tasks (kit 2.95.0): by its name in this account's folder, `names[0]`, else by an older
 * name, when that task is this account's own (an install from before kit 2.95.0 registered it, and nothing has moved it
 * yet). Never another account's. The first run's answer when none ran.
 */
export async function runOwnTask(names: string[], d: TaskDeps): Promise<Ran & { name: string }> {
  const [first, ...older] = names;
  const ran = await d.schtasks(['/Run', '/TN', first]);
  if (ran.code === 0) return { ...ran, name: first };
  for (const old of older) {
    if (!(await isOwnTask(old, d))) continue;
    const r = await d.schtasks(['/Run', '/TN', old]);
    if (r.code === 0) return { ...r, name: old };
  }
  return { ...ran, name: first };
}

/** The real Task Scheduler and this user, for runOwnTask, isOwnTask and dropOldTask outside an install. */
export const taskDeps = (): TaskDeps => ({ schtasks: (args) => run(SCHTASKS, args), user: taskUser(), userSid });

export function taskArguments(node: string, app: string): string {
  return `--headless "${node}" "${cliIn(app)}" open`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * How long after sign-in an agent's home page starts (kit 2.51.0): 30 s, and up to 2½ minutes more, the same for an
 * agent each time (from its id), different from one agent to the next. Started in the very second of sign-in, every
 * agent's task failed at once on the owner's PC ("the system cannot find the path specified", 0x80070003), and the
 * whole staff starting together is the heaviest minute the PC has.
 */
export function signInDelaySeconds(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 30 + (h % 151);
}

/**
 * Reeve's task (its src/jobs/schedule.ts), at this user's sign-in: only while the user is logged on
 * (an interactive token needs no stored password or admin), on battery too, one instance at a time,
 * hidden, below-normal priority, and no time limit. It waits signInDelaySeconds after sign-in, and a start that
 * fails is tried again every minute, five times (kit 2.51.0). With `atSignIn: false` (Manor starts its staff,
 * MANOR_STARTUP) it has no trigger: it runs only when asked (schtasks /Run).
 */
export function homePageTaskXml(o: { node: string; app: string; user: string; pageUrl: string; id?: string; atSignIn?: boolean }): string {
  const atSignIn = o.atSignIn ?? true;
  const when = atSignIn ? 'when you sign in' : 'when an install asks (Castellan starts it at sign-in)';
  const trigger = atSignIn
    ? `
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(o.user)}</UserId>
      <Delay>PT${signInDelaySeconds(o.id ?? APP.id)}S</Delay>
    </LogonTrigger>
  `
    : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`Brings ${APP.name}'s home page up at ${o.pageUrl} ${when}. It runs open, which never changes duty. Remove with: node ${cliIn(o.app)} uninstall`)}</Description>
    <URI>${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>${trigger}</Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(o.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(CONHOST)}</Command>
      <Arguments>${xmlEscape(taskArguments(o.node, o.app))}</Arguments>
      <WorkingDirectory>${xmlEscape(o.app)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks reads the encoding from the declaration: UTF-16 LE, with a byte-order mark. */
export const utf16 = (xml: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);

/** A copy's release.json, or null when it has none (a checkout, or not a release at all). */
export function readRelease(root: string): Release | null {
  try {
    const r = JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (!r || typeof r.version !== 'string') return null;
    const native = nativeRelease(r.native);
    const { native: _, ...rest } = r;
    return { ...(rest as Release), ...(native ? { native } : {}) };
  } catch {
    return null;
  }
}

/**
 * Why --purge won't remove `dataDir`, or null when it's the agent's own. `<ID>_HOME` can name any folder, and --purge
 * deletes all it holds, so a mistaken one is refused rather than emptied. Folders are compared by their real paths
 * (spec/DEV-DRIVES.md), so a folder reached through a junction, or a drive mounted in a folder, is refused too:
 * - a whole drive, by its letter or mounted in a folder (C:\DevData, where E: is mounted);
 * - the profile, or one of Windows' own or the person's folders (Documents, Desktop, AppData, Program Files...), or a
 *   folder holding one;
 * - a git repository;
 * - a folder neither named for the agent (`%USERPROFILE%\.<id>`, or a `<ID>_HOME` such as `D:\data\<id>`) nor holding its program.
 */
export function purgeRefusal(dataDir: string, home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = path.resolve(dataDir);
  const real = realPath(dir);
  if (real === path.parse(real).root) return dir === path.parse(dir).root ? 'it is a whole drive' : `it is a whole drive, ${real} mounted there`;
  const profile = env.USERPROFILE || home;
  const shared = [home, profile, env.LOCALAPPDATA, env.APPDATA, env.ProgramData, env.ProgramFiles, env['ProgramFiles(x86)'], env.SystemRoot, env.PUBLIC, env.OneDrive,
    ...['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive', 'source', 'Projects'].map((f) => (profile ? path.join(profile, f) : ''))];
  for (const s of shared) if (s && inside(s, dir)) return samePath(s, dir) ? `it is ${s}` : `it holds ${s}`;
  if (existsSync(path.join(dir, '.git'))) return 'it is a git repository';
  if (!namedForApp(dir) && !holdsOwnCopy(dir)) return `it isn't named for ${APP.name}, and holds no copy of it`;
  return null;
}

/** The environment variable that names the data folder: FIXTURE_HOME, STEWARD_HOME (each agent's placeFor). */
const homeVariable = () => `${APP.id.toUpperCase().replace(/-/g, '_')}_HOME`;

/** Whether a folder's name is the agent's (`.<id>`, `.<id>-dev`, or a `<ID>_HOME` such as `D:\data\<id>`). */
const namedForApp = (dir: string) => path.basename(dir).replace(/^\./, '').toLowerCase().includes(APP.id.toLowerCase());

/**
 * Whether a folder holds a copy of this agent: its app\release.json names it, or the release.json of the copy an
 * update keeps beside it (app.old, where a swap never finished; app.prev, during a probation). Manor's own uninstall asks
 * the same of Manor's folder (Manor's src/purge.ts).
 */
function holdsOwnCopy(dir: string): boolean {
  const app = appFolder(dir);
  return [app, `${app}.old`, `${app}.prev`].some((a) => readRelease(a)?.id === APP.id);
}

/**
 * Why install and uninstall won't touch `dataDir` at all, or null when they may (kit 2.136.6). `<ID>_HOME` can be set to
 * anything, and an empty or relative one made the program's folder `.\app` in whatever folder the command ran from: a
 * plain uninstall deleted it, and an install moved it aside and deleted it. So the data folder must be a full path
 * (`C:\…`, or `\\server\share\…`), and one that holds an `app` must be the agent's: named for it, or that app (or a copy
 * an update keeps beside it) is a release of it. A first install into a folder with no `app` is any full path's.
 * Uninstall asks more (uninstallRefusal).
 */
export function homeRefusal(dataDir: string): string | null {
  if (!dataDir.trim()) return 'it is empty';
  if (!/^([a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(dataDir)) return "it isn't a full path, such as C:\\Users\\you\\." + APP.id;
  const app = appFolder(dataDir);
  if (existsSync(app) && !namedForApp(dataDir) && !holdsOwnCopy(dataDir)) return `its ${app} isn't ${APP.name}'s: it holds no release.json of ${APP.name}'s, and the folder isn't named for it`;
  return null;
}

/**
 * Why uninstall won't touch `dataDir` at all, or null when it may (kit 2.136.6): homeRefusal's, and a folder that isn't
 * the agent's (neither named for it nor holding a copy of it), since uninstall deletes what it finds there. --purge asks
 * purgeRefusal's too.
 */
export function uninstallRefusal(dataDir: string): string | null {
  return homeRefusal(dataDir) ?? (namedForApp(dataDir) || holdsOwnCopy(dataDir) ? null : `it isn't named for ${APP.name}, and holds no copy of it`);
}

/** What install and uninstall say when they won't touch the data folder (homeRefusal, uninstallRefusal), and what to do. */
export function refusedHomeLine(dataDir: string, why: string, cmd: 'install' | 'uninstall'): string {
  const v = homeVariable();
  return `${APP.name}'s data folder${dataDir.trim() ? `, ${dataDir},` : ''} isn't one ${cmd} may touch: ${why}. So nothing was ${cmd === 'install' ? 'installed' : 'removed, and no task deleted'}. Set ${v} to the full path of ${APP.name}'s own folder, or remove ${v} to use %USERPROFILE%\\.${APP.id}, and ${cmd} again.`;
}

const quoted = (args: string[]) => args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function waitFor(ok: () => Promise<boolean>, ms: number, d: InstallDeps): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 500) {
    if (await ok()) return true;
    await d.sleep(500);
  }
  return ok();
}

/** How long an install waits for the page it started, whatever: Task Scheduler may not have started its process yet. */
export const PAGE_FIRST_MS = 20_000;
/** How long it waits in all while the page's process is still starting (kit 2.75.2). */
export const PAGE_START_MS = 5 * 60_000;
/** How often it looks whether the page's process is still there, once PAGE_FIRST_MS has gone by. */
const PAGE_LOOK_MS = 5_000;

/**
 * Waits for a page started from `app` to answer (`ok`), as an install's start and a rollback's do (kit 2.75.2):
 * PAGE_FIRST_MS, then on while its process is still starting (native.ts pagesFrom), up to PAGE_START_MS in all. On a
 * busy PC (a release's checks running beside every agent's rounds) a page can take minutes to come up: the 20 s an
 * install gave it before took a slow start for a broken release, and rolled back releases that were fine (the
 * Steward's 0.36.46 and the Assayer's 0.4.2, on 2026-10-15). A page whose process has ended isn't waited for.
 * `waitedMs`: how long it was waited for, once past PAGE_FIRST_MS (0 within it); `gone`: it didn't answer, and no process of it is left.
 */
export async function waitForPage(ok: () => Promise<boolean>, app: string, d: InstallDeps): Promise<{ up: boolean; waitedMs: number; gone: boolean }> {
  if (await waitFor(ok, PAGE_FIRST_MS, d)) return { up: true, waitedMs: 0, gone: false };
  const starting = d.pagesStarting ?? (async (dir: string) => pagesFrom(dir));
  for (let waited = PAGE_FIRST_MS; waited < PAGE_START_MS; waited += PAGE_LOOK_MS) {
    if (!(await starting(app)).length) {
      const up = await ok();
      return { up, waitedMs: waited, gone: !up };
    }
    if (await waitFor(ok, PAGE_LOOK_MS, d)) return { up: true, waitedMs: waited + PAGE_LOOK_MS, gone: false };
  }
  return { up: false, waitedMs: PAGE_START_MS, gone: false };
}

/** Ends the installed copy's page process, if it's running, and waits until it has gone. `wasUp`: it was running. */
async function endPage(d: InstallDeps): Promise<{ ended: boolean; wasUp: boolean }> {
  const running = () => (d.running ?? d.ping)();
  if (!(await running())) return { ended: true, wasUp: false };
  await d.shutdown();
  return { ended: await waitFor(async () => !(await running()), 10_000, d), wasUp: true };
}

/**
 * Ends the programs an installed copy runs from its app folder (its native files: Envoy's media host), which Windows
 * won't let the folder be moved from under. Its page has ended by now, and a program it started is meant to end with it
 * (an agent's host leaves when its page says bye): it's given 5 seconds to, then ended. Only for a copy whose release
 * carries native files, so every other agent's update asks Windows nothing more.
 */
async function endNative(app: string, before: Release | null, d: InstallDeps): Promise<void> {
  if (!before?.native) return;
  const list = d.programsIn ?? (async (dir: string) => processesUnder(dir));
  let ids = await list(app);
  for (let waited = 0; ids.length && waited < 5000; waited += 500) {
    await d.sleep(500);
    ids = await list(app);
  }
  if (!ids.length) return;
  d.out(`Ending ${ids.length === 1 ? 'a program' : `${ids.length} programs`} still running from ${app} (process ${ids.join(', ')}), so it can be replaced.`);
  await (d.endPrograms ?? (async (x: number[]) => endProcesses(x)))(ids);
  await waitFor(async () => !(await list(app)).length, 10_000, d);
}

/**
 * Moves a folder, trying again for a while when Windows says it's busy: a process that has just ended (or a
 * virus scanner looking at a new file) can hold it for a moment.
 */
async function move(from: string, to: string, d: InstallDeps): Promise<void> {
  const rename = d.rename ?? renameSync;
  for (let tries = 1; ; tries++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (tries >= 30 || !isBusy(e)) throw e;
      await d.sleep(500);
    }
  }
}

/** Windows' answer when something has a folder (or a file in it) open. */
const isBusy = (e: unknown) => ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');

/**
 * The installed copy an install's swap left in app.old, with nothing in app (kit 2.96.2): the PC went off between
 * moving app aside and moving the release in. Every kit's install swaps the same way, so an older one's leaves this
 * too. Null when app is there, or app.old holds no release.
 */
export const unfinishedSwap = (app: string): Release | null => (existsSync(app) ? null : readRelease(`${app}.old`));

/**
 * Puts the copy an unfinished swap left in app.old back in app (kit 2.96.2), so the install that finds it is the update
 * it is: its duty kept, and the version before kept to go back to (safeinstall.ts). Taken for a first install, it put
 * the agent on duty and deleted the only copy of it. True once app holds it again.
 */
export async function finishSwap(app: string, d: InstallDeps): Promise<boolean> {
  const left = unfinishedSwap(app);
  if (!left) return false;
  try {
    await move(`${app}.old`, app, d);
  } catch (e) {
    d.out(`${app} is missing, and ${app}.old (${left.version}, left by an install that never finished) couldn't be put back (${message(e)}).`);
    return false;
  }
  d.out(`${app} was missing: an earlier install never finished its swap. ${left.version}, which it had moved aside to ${app}.old, is back in ${app}.`);
  return true;
}

/**
 * The copies an update keeps beside app (safeinstall.ts): app.prev, the version before, while the new one is on
 * probation; app.unsafe-<version>, a version that was rolled back, for a look. Their names, in the data folder.
 */
export function keptCopies(dataDir: string): string[] {
  try {
    return readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^app\.(prev|unsafe-.+)$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The release copied over a folder that can't be moved (a shell's or a program's current folder can't be,
 * though its contents can be changed), then whatever the release no longer has removed from it.
 */
export function replaceContents(from: string, to: string, flush: (dir: string) => void = flushTree): void {
  cpSync(from, to, { recursive: true, force: true });
  flush(to);
  const prune = (dir: string, ref: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const there = path.join(ref, e.name);
      if (!existsSync(there)) rmSync(path.join(dir, e.name), { recursive: true, force: true });
      else if (e.isDirectory()) prune(path.join(dir, e.name), there);
    }
  };
  prune(to, from);
}

export async function install(opts: { noStart?: boolean; dryRun?: boolean } = {}, d: InstallDeps = defaultDeps()): Promise<number> {
  const { out } = d;
  if (d.dev) {
    out(DEV_CHECKOUT);
    return 2;
  }
  const release = readRelease(d.root);
  if (!release) {
    out(`${d.root} isn't a release: it has no release.json. Build one in a checkout with: npm run release`);
    return 2;
  }
  // An empty or relative data folder, or one whose app isn't this agent's: an update would move that app aside and delete it.
  const badHome = homeRefusal(d.dataDir);
  if (badHome) {
    out(refusedHomeLine(d.dataDir, badHome, 'install'));
    return 2;
  }
  const app = appFolder(d.dataDir);
  if (samePath(d.root, app)) {
    out(`This is the installed copy (${app}). To update it, install a newer release: npm run release -- --install in a checkout, or node src\\cli.ts install in an unpacked release.`);
    return 2;
  }
  // An earlier install's swap that never finished: the installed copy is in app.old, and goes back first (kit 2.96.2).
  const unfinished = unfinishedSwap(app);
  if (unfinished && !opts.dryRun) await finishSwap(app, d);
  const update = existsSync(app) || (!!unfinished && !!opts.dryRun);
  const before = update ? (readRelease(app) ?? unfinished) : null;
  const xmlFile = taskXmlFile(d.dataDir);
  const create = ['/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F'];
  const what = `${APP.name} ${release.version}${release.dirty ? ' (built with uncommitted changes)' : ''}`;

  // Manor starts its staff at sign-in (Castellan in Startup apps): the task then runs only when asked.
  const manorStarts = (await d.manorStarts?.()) ?? false;

  if (opts.dryRun) {
    out(`${what} from ${d.root}: ${update ? `would update the installed copy${before ? ` (${before.version})` : ''}` : 'would install it'}.`);
    if (unfinished) out(`  0. Put ${unfinished.version} back in ${app} from ${app}.old, where an earlier install that never finished its swap left it.`);
    out(`  1. End its page process, if it's running (${d.pageUrl}).`);
    out(`  2. Copy the release to ${app}.new${release.native ? ` (its native files for this PC's processor only)` : ''}, then swap it in for ${app}.`);
    out(`  3. Register the task ${TASK_NAME} for ${d.user}, ${manorStarts ? 'run only when asked: Manor starts it at sign-in (Castellan is in Startup apps)' : 'at sign-in'}: ${SCHTASKS} ${quoted(create)}`);
    out(`     It runs: ${CONHOST} ${taskArguments(d.node, app)}`);
    out(`     In: ${app}`);
    out(`     Its tasks of the old names (${OLD_TASK_NAME}, ${OLD_WAKE_TASK_NAME}) ended and deleted, where they're this account's own.`);
    out(opts.noStart ? '  4. Leave it stopped (--no-start).' : `  4. ${update ? 'Keep its duty' : 'Put it on duty'}, run the task, and wait for its page at ${d.pageUrl}.`);
    out(`Its data folder: ${d.dataDir}`);
    out('--dry-run: nothing changed.');
    return 0;
  }

  // The page process runs from app, so it ends before app is replaced. Duty is in the data folder and stays as it was.
  const page = await endPage(d);
  if (!page.ended) {
    out(`${APP.name}'s page is still running, so nothing was changed. End it (node ${cliIn(app)} shutdown) and install again.`);
    return 1;
  }
  /** When the swap fails: the installed copy is as it was, and its page comes back if it was up. */
  const unchanged = async (why: string): Promise<number> => {
    out(why);
    if (page.wasUp) {
      // An older install's task may be the one there: this account's, by its old name.
      const back = await runOwnTask([TASK_NAME, OLD_TASK_NAME], d);
      out(back.code === 0 && (await waitFor(() => d.ping(), 20_000, d)) ? `Its page is up again: ${d.pageUrl}` : `Its page didn't come back: start it with node ${cliIn(app)} open`);
    }
    return 1;
  };

  await endNative(app, before, d);

  // The release goes in beside app first; until the swap, the installed copy is as it was.
  const next = `${app}.new`;
  const old = `${app}.old`;
  try {
    rmSync(next, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    mkdirSync(d.dataDir, { recursive: true });
    cpSync(d.root, next, { recursive: true });
    const noNative = keepOwnArch(next, release.native, d.arch);
    if (noNative) out(noNative);
    // On the disk before the swap: a crash after it then finds the release whole, not files of NUL bytes (kit 2.73.3).
    (d.flush ?? flushTree)(next);
  } catch (e) {
    rmSync(next, { recursive: true, force: true });
    return unchanged(`Couldn't copy the release to ${next} (${message(e)}). Nothing was changed.`);
  }
  let inPlace = false;
  try {
    if (update) await move(app, old, d);
  } catch (e) {
    if (!isBusy(e)) {
      rmSync(next, { recursive: true, force: true });
      return unchanged(`Couldn't move ${app} aside (${message(e)}). Nothing was changed.`);
    }
    // A shell or another program has it as its current folder: the folder stays, and its contents are replaced.
    try {
      replaceContents(next, app, d.flush ?? flushTree);
      inPlace = true;
      out(`${app} is held open (a shell or another program is in it), so the release was copied into it instead of swapped in.`);
    } catch (e2) {
      return unchanged(`Couldn't copy the release into ${app} (${message(e2)}): it may be partly replaced. Install again once whatever has it open lets go.`);
    } finally {
      rmSync(next, { recursive: true, force: true });
    }
  }
  if (!inPlace) {
    try {
      await move(next, app, d);
    } catch (e) {
      if (update) await move(old, app, d);
      rmSync(next, { recursive: true, force: true });
      return unchanged(`Couldn't put the release in ${app} (${message(e)}). The installed copy is as it was.`);
    }
    try {
      rmSync(old, { recursive: true, force: true });
    } catch {
      // A file in it is still open; the next install clears it.
    }
  }

  writeFileSync(xmlFile, utf16(homePageTaskXml({ node: d.node, app, user: d.user, pageUrl: d.pageUrl, atSignIn: !manorStarts })));
  const created = await d.schtasks(create);
  if (created.code !== 0) {
    out(`${app} is in place, but schtasks couldn't register ${TASK_NAME}:\n${created.out}`);
    return created.code;
  }
  // Off the names from before each account had a folder of its own (kit 2.95.0): this account's own, never another's.
  // The new wake task is registered by the page, as it starts (wake.ts).
  if (await dropOldTask(OLD_TASK_NAME, d)) out(`Its task ${OLD_TASK_NAME} is ${TASK_NAME} now, in this account's own folder.`);
  if (await dropOldTask(OLD_WAKE_TASK_NAME, d)) out(`Its task ${OLD_WAKE_TASK_NAME} is gone: its page registers ${WAKE_TASK_NAME} as it starts.`);

  // Task Scheduler starts the page, outside whatever started install (the Claude desktop app's container, say).
  let up = false;
  let started = '';
  if (opts.noStart) started = 'not started (--no-start)';
  else {
    if (!update) d.setDuty(true);
    const ran = await d.schtasks(['/Run', '/TN', TASK_NAME]);
    if (ran.code !== 0) started = `not started: schtasks /Run failed: ${ran.out}`;
    else {
      // A slow start on a busy PC is waited for while the page's process is there (waitForPage, kit 2.75.2).
      const page = await waitForPage(() => d.ping(), app, d);
      up = page.up;
      const log = path.join(d.dataDir, 'serve.log');
      started = up
        ? page.waitedMs
          ? `up, after ${Math.round(page.waitedMs / 1000)} s: the PC is busy`
          : 'up'
        : page.gone
          ? `didn't answer, and its process has ended; see ${log}`
          : `still starting after ${PAGE_START_MS / 60_000} minutes; see ${log}`;
    }
  }

  out(`${what} ${update ? `updated${before && before.version !== release.version ? ` from ${before.version}` : ''}` : 'installed'}.`);
  out(`  app:  ${app}`);
  out(`  data: ${d.dataDir}`);
  out(`  task: ${TASK_NAME} (${manorStarts ? 'open, when asked: Manor starts it at sign-in' : 'at sign-in: open'})`);
  out(`  page: ${d.pageUrl} (${started})`);
  out(`  duty: ${d.onDuty() ? 'on duty' : 'off duty'}${update ? ', as it was' : ''}`);
  return opts.noStart || up ? 0 : 1;
}

export async function uninstall(opts: { purge?: boolean; dryRun?: boolean } = {}, d: InstallDeps = defaultDeps()): Promise<number> {
  const { out } = d;
  if (d.dev) {
    out(`This is a development checkout; nothing of it is installed. To uninstall ${APP.name}, uninstall from the installed copy: node %USERPROFILE%\\.${APP.id}\\app\\src\\cli.ts uninstall`);
    return 2;
  }
  const app = appFolder(d.dataDir);
  // An empty, relative or someone else's data folder: nothing is touched, its tasks neither (kit 2.136.6).
  const notOurs = uninstallRefusal(d.dataDir);
  if (notOurs) {
    out(refusedHomeLine(d.dataDir, notOurs, 'uninstall'));
    return 2;
  }
  const refused = opts.purge ? purgeRefusal(d.dataDir, d.home) : null;
  if (refused) {
    out(`${d.dataDir} is not a folder of ${APP.name}'s own (${refused}), so --purge won't remove it, nor anything else. Uninstall without --purge, and remove what you no longer want from it yourself.`);
    return 2;
  }
  if (opts.dryRun) {
    const kept = keptCopies(d.dataDir);
    out(`${APP.name}: would end its page process if it's running, end and delete the task ${TASK_NAME} (and ${WAKE_TASK_NAME}, if it has one, and ${OLD_TASK_NAME} and ${OLD_WAKE_TASK_NAME} where they're this account's), and remove ${app}${kept.length ? ` and the copies its updates kept beside it (${kept.join(', ')})` : ''}.`);
    out(opts.purge ? `--purge: would also remove its data folder, ${d.dataDir}.` : `Its data folder would stay: ${d.dataDir}.`);
    out('--dry-run: nothing changed.');
    return 0;
  }

  let code = 0;
  if ((await d.schtasks(['/Query', '/TN', TASK_NAME])).code === 0) {
    await d.schtasks(['/End', '/TN', TASK_NAME]);
    const del = await d.schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
    if (del.code === 0) out(`Deleted the task ${TASK_NAME}.`);
    else {
      out(`Couldn't delete the task ${TASK_NAME}:\n${del.out}`);
      code = del.code;
    }
  } else out(`There's no task ${TASK_NAME}.`);
  // The task that wakes the PC for work at set times (wake.ts), where the agent has one.
  if ((await d.schtasks(['/Query', '/TN', WAKE_TASK_NAME])).code === 0) {
    await d.schtasks(['/End', '/TN', WAKE_TASK_NAME]);
    const del = await d.schtasks(['/Delete', '/TN', WAKE_TASK_NAME, '/F']);
    if (del.code === 0) out(`Deleted the task ${WAKE_TASK_NAME}.`);
    else {
      out(`Couldn't delete the task ${WAKE_TASK_NAME}:\n${del.out}`);
      code ||= del.code;
    }
  }
  // The names from before kit 2.95.0, where an install never moved them: this account's own, never another's.
  for (const old of [OLD_TASK_NAME, OLD_WAKE_TASK_NAME]) if (await dropOldTask(old, d)) out(`Deleted the task ${old}.`);

  if (!(await endPage(d)).ended) {
    out(`${APP.name}'s page is still running, so ${app} was left in place.`);
    return 1;
  }
  await endNative(app, readRelease(app), d);

  const gone = opts.purge ? d.dataDir : app;
  if (inside(process.cwd(), gone)) process.chdir(d.home);
  const had = existsSync(app);
  for (const p of [app, `${app}.new`, `${app}.old`, taskXmlFile(d.dataDir)]) rmSync(p, { recursive: true, force: true });
  out(had ? `Removed ${app}.` : `There's no ${app} to remove.`);
  // The copies its updates kept beside app (app.prev, app.unsafe-<version>) are its program too, not its data (kit 2.96.2).
  const kept = keptCopies(d.dataDir);
  const left = kept.filter((k) => {
    try {
      rmSync(path.join(d.dataDir, k), { recursive: true, force: true });
      return false;
    } catch {
      return true;
    }
  });
  if (kept.length > left.length) out(`Removed the copies its updates kept beside it: ${kept.filter((k) => !left.includes(k)).join(', ')}.`);
  if (left.length) out(`Couldn't remove ${left.join(', ')} (a file in it is open): remove it from ${d.dataDir} yourself once whatever has it lets go.`);
  if (opts.purge) {
    rmSync(d.dataDir, { recursive: true, force: true });
    out(`Removed its data folder, ${d.dataDir}.`);
  } else out(`Its data stays in ${d.dataDir} (uninstall --purge removes it).`);
  return code;
}

/**
 * install and uninstall from the command line. An unknown option is refused, so a mistyped --dry-run never installs.
 * install goes through the fail-safe (safeinstall.ts, kit 2.51.0): an update that doesn't hold up is rolled back.
 */
export async function installCli(cmd: 'install' | 'uninstall', args: string[]): Promise<number> {
  if (cmd === 'install') return (await import('./safeinstall.ts')).safeInstallCli(args);
  const known = ['--purge', '--dry-run'];
  const unknown = args.filter((a) => !known.includes(a));
  if (unknown.length) {
    console.error(`${cmd}: unknown ${unknown.join(' ')} (it takes ${known.join(' ')})`);
    return 2;
  }
  const dryRun = args.includes('--dry-run');
  return uninstall({ purge: args.includes('--purge'), dryRun });
}

function run(file: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (err: any, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: [String(stdout).trim(), String(stderr).trim()].filter(Boolean).join('\n') }),
    ),
  );
}

/** The real things: this copy, its data folder, Task Scheduler, and the installed page. */
export function defaultDeps(): InstallDeps {
  return {
    root: appRoot,
    dev: devCheckout,
    dataDir,
    node: process.execPath,
    user: taskUser(),
    userSid,
    pageUrl,
    home: os.homedir(),
    schtasks: (args) => run(SCHTASKS, args),
    ping: async () => (await ping()) !== null,
    running: async () => (await pageAt()) !== null,
    shutdown,
    manorStarts: async () => (await run(REG, ['query', MANOR_STARTUP.key, '/v', MANOR_STARTUP.value])).code === 0,
    onDuty: () => duty().onDuty,
    setDuty: (on) => void setDuty(on),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => console.log(line),
  };
}
