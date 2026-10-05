import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, appRoot, dataDir, devCheckout, pageUrl } from '../app.ts';
import { duty, setDuty } from './duty.ts';
import { pageAt, ping, shutdown } from './service.ts';

/**
 * Installing from a release, as each of Manor's agents does on its own (Manor's docs/INSTALLING.md):
 * - install copies the release it runs from to <data folder>\app, and registers one sign-in task,
 *   \<Name>\Home page, that runs `open`. `open` never changes duty, so an agent stopped in Manor stays
 *   stopped after a restart. It's the only task: the rounds still run inside the page process, so
 *   Stop in Manor still stops the work.
 * - uninstall ends the page process, deletes the task and removes app; --purge also removes the data.
 * A development checkout does neither: its own data is the -dev folder, and code reaches app only
 * through a release.
 */

/** The sign-in task, in a Task Scheduler folder named after the agent, as Reeve's and Heiward's are. */
export const TASK_NAME = `\\${APP.name}\\Home page`;

/** conhost --headless gives node its console without a window; the task's "Hidden" only hides it in the UI. */
export const CONHOST = 'C:\\Windows\\System32\\conhost.exe';
const SCHTASKS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');

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
  onDuty(): boolean;
  setDuty(on: boolean): void;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
  /** Moves a folder (default: fs.renameSync); a test can make it fail. */
  rename?(from: string, to: string): void;
}

export const appFolder = (data: string) => path.join(data, 'app');
export const taskXmlFile = (data: string) => path.join(data, 'home-page.task.xml');
const cliIn = (app: string) => path.win32.join(app, 'src', 'cli.ts');

export function taskUser(env: Record<string, string | undefined> = process.env): string {
  const user = env.USERNAME ?? '';
  const domain = env.USERDOMAIN ?? '';
  return domain ? `${domain}\\${user}` : user;
}

export function taskArguments(node: string, app: string): string {
  return `--headless "${node}" "${cliIn(app)}" open`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Reeve's task (its src/jobs/schedule.ts), at this user's sign-in: only while the user is logged on
 * (an interactive token needs no stored password or admin), on battery too, one instance at a time,
 * hidden, below-normal priority, and no time limit.
 */
export function homePageTaskXml(o: { node: string; app: string; user: string; pageUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`Brings ${APP.name}'s home page up at ${o.pageUrl} when you sign in. It runs open, which never changes duty. Remove with: node ${cliIn(o.app)} uninstall`)}</Description>
    <URI>${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(o.user)}</UserId>
    </LogonTrigger>
  </Triggers>
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
    return r && typeof r.version === 'string' ? (r as Release) : null;
  } catch {
    return null;
  }
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const samePath = (a: string, b: string) => norm(a) === norm(b);
const inside = (p: string, dir: string) => samePath(p, dir) || norm(p).startsWith(norm(dir) + path.sep);
const quoted = (args: string[]) => args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function waitFor(ok: () => Promise<boolean>, ms: number, d: InstallDeps): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 500) {
    if (await ok()) return true;
    await d.sleep(500);
  }
  return ok();
}

/** Ends the installed copy's page process, if it's running, and waits until it has gone. `wasUp`: it was running. */
async function endPage(d: InstallDeps): Promise<{ ended: boolean; wasUp: boolean }> {
  const running = () => (d.running ?? d.ping)();
  if (!(await running())) return { ended: true, wasUp: false };
  await d.shutdown();
  return { ended: await waitFor(async () => !(await running()), 10_000, d), wasUp: true };
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
 * The release copied over a folder that can't be moved (a shell's or a program's current folder can't be,
 * though its contents can be changed), then whatever the release no longer has removed from it.
 */
export function replaceContents(from: string, to: string): void {
  cpSync(from, to, { recursive: true, force: true });
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
  const app = appFolder(d.dataDir);
  if (samePath(d.root, app)) {
    out(`This is the installed copy (${app}). To update it, install a newer release: npm run release -- --install in a checkout, or node src\\cli.ts install in an unpacked release.`);
    return 2;
  }
  const update = existsSync(app);
  const before = update ? readRelease(app) : null;
  const xmlFile = taskXmlFile(d.dataDir);
  const create = ['/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F'];
  const what = `${APP.name} ${release.version}${release.dirty ? ' (built with uncommitted changes)' : ''}`;

  if (opts.dryRun) {
    out(`${what} from ${d.root}: ${update ? `would update the installed copy${before ? ` (${before.version})` : ''}` : 'would install it'}.`);
    out(`  1. End its page process, if it's running (${d.pageUrl}).`);
    out(`  2. Copy the release to ${app}.new, then swap it in for ${app}.`);
    out(`  3. Register the sign-in task ${TASK_NAME} for ${d.user}: ${SCHTASKS} ${quoted(create)}`);
    out(`     It runs: ${CONHOST} ${taskArguments(d.node, app)}`);
    out(`     In: ${app}`);
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
      const back = await d.schtasks(['/Run', '/TN', TASK_NAME]);
      out(back.code === 0 && (await waitFor(() => d.ping(), 20_000, d)) ? `Its page is up again: ${d.pageUrl}` : `Its page didn't come back: start it with node ${cliIn(app)} open`);
    }
    return 1;
  };

  // The release goes in beside app first; until the swap, the installed copy is as it was.
  const next = `${app}.new`;
  const old = `${app}.old`;
  try {
    rmSync(next, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    mkdirSync(d.dataDir, { recursive: true });
    cpSync(d.root, next, { recursive: true });
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
      replaceContents(next, app);
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

  writeFileSync(xmlFile, utf16(homePageTaskXml({ node: d.node, app, user: d.user, pageUrl: d.pageUrl })));
  const created = await d.schtasks(create);
  if (created.code !== 0) {
    out(`${app} is in place, but schtasks couldn't register ${TASK_NAME}:\n${created.out}`);
    return created.code;
  }

  // Task Scheduler starts the page, outside whatever started install (the Claude desktop app's container, say).
  let up = false;
  let started = '';
  if (opts.noStart) started = 'not started (--no-start)';
  else {
    if (!update) d.setDuty(true);
    const ran = await d.schtasks(['/Run', '/TN', TASK_NAME]);
    if (ran.code !== 0) started = `not started: schtasks /Run failed: ${ran.out}`;
    else {
      up = await waitFor(() => d.ping(), 20_000, d);
      started = up ? 'up' : `didn't answer within 20 s; see ${path.join(d.dataDir, 'serve.log')}`;
    }
  }

  out(`${what} ${update ? `updated${before && before.version !== release.version ? ` from ${before.version}` : ''}` : 'installed'}.`);
  out(`  app:  ${app}`);
  out(`  data: ${d.dataDir}`);
  out(`  task: ${TASK_NAME} (at sign-in: open)`);
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
  if (opts.purge && (samePath(d.dataDir, path.parse(path.resolve(d.dataDir)).root) || samePath(d.dataDir, d.home))) {
    out(`${d.dataDir} is not a folder of ${APP.name}'s own, so --purge won't remove it.`);
    return 2;
  }
  if (opts.dryRun) {
    out(`${APP.name}: would end its page process if it's running, end and delete the task ${TASK_NAME}, and remove ${app}.`);
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

  if (!(await endPage(d)).ended) {
    out(`${APP.name}'s page is still running, so ${app} was left in place.`);
    return 1;
  }

  const gone = opts.purge ? d.dataDir : app;
  if (inside(process.cwd(), gone)) process.chdir(d.home);
  const had = existsSync(app);
  for (const p of [app, `${app}.new`, `${app}.old`, taskXmlFile(d.dataDir)]) rmSync(p, { recursive: true, force: true });
  out(had ? `Removed ${app}.` : `There's no ${app} to remove.`);
  if (opts.purge) {
    rmSync(d.dataDir, { recursive: true, force: true });
    out(`Removed its data folder, ${d.dataDir}.`);
  } else out(`Its data stays in ${d.dataDir} (uninstall --purge removes it).`);
  return code;
}

/** install and uninstall from the command line. An unknown option is refused, so a mistyped --dry-run never installs. */
export async function installCli(cmd: 'install' | 'uninstall', args: string[]): Promise<number> {
  const known = cmd === 'install' ? ['--no-start', '--dry-run'] : ['--purge', '--dry-run'];
  const unknown = args.filter((a) => !known.includes(a));
  if (unknown.length) {
    console.error(`${cmd}: unknown ${unknown.join(' ')} (it takes ${known.join(' ')})`);
    return 2;
  }
  const dryRun = args.includes('--dry-run');
  return cmd === 'install' ? install({ noStart: args.includes('--no-start'), dryRun }) : uninstall({ purge: args.includes('--purge'), dryRun });
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
    pageUrl,
    home: os.homedir(),
    schtasks: (args) => run(SCHTASKS, args),
    ping: async () => (await ping()) !== null,
    running: async () => (await pageAt()) !== null,
    shutdown,
    onDuty: () => duty().onDuty,
    setDuty: (on) => void setDuty(on),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => console.log(line),
  };
}
