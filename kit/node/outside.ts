import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceleratorsHome } from './accelerators.ts';
import { alive } from './apart.ts';
import { powershell } from './ps.ts';

/**
 * Setting up outside a packaged app (kit 2.113.3). The Claude desktop app is an MSIX package, and so is every
 * process a session in it starts: Windows keeps whatever such a process writes under AppData (%LOCALAPPDATA%,
 * %APPDATA%) in the package's own folder (%LOCALAPPDATA%\Packages\<package>\LocalCache), and its HKCU registry writes
 * in the package's own hive. The process that wrote them sees them where it wrote them; nothing outside the package
 * does. %USERPROFILE% itself, %TEMP% and %ProgramData% aren't redirected.
 *
 * On 2026-10-24 that left the Snapdragon X2's NPU unusable for days. GenieX (%LOCALAPPDATA%\GenieX CLI) had been set
 * up from a session, and the kit's build of its plugin put in the same way, so both were in the package alone. The
 * staff, started by Task Scheduler, found no geniex.exe, and every NPU chat failed with ENOENT.
 *
 * So what setup writes runs outside the package. A setup that finds it runs inside one (packagedApp: one of the
 * processes that started it runs from WindowsApps) runs itself again as a one-off Task Scheduler task, as Manor's
 * `manor install` does (Manor's install.ts hop), and follows that run's log (runOutside). The keeper's look at the
 * NPU server's plugin (npu-patch.ts) does the same for its two file moves. Where Task Scheduler won't run it, a step
 * that writes under AppData is refused with a plain message rather than written into the package (setup.ts'
 * writesAppData says which do).
 *
 * The run outside is outside-run.ts, run by Node: `node outside-run.ts <job folder>`. The folder holds job.json (what
 * to run, and the variables of the kit's own it runs with), and the run writes pid.json, log.txt and, when it's done,
 * result.json there.
 */

// ------------------------------------------------------------------------------------------------
// Packaged apps

export interface Proc {
  pid: number;
  parent: number;
  exe: string;
}

/** The processes' table, one `pid|parent|program` line each (Manor's windows.ts insidePackagedApp asks the same). */
export const PROCESS_TABLE_PS = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.ExecutablePath)" }';

/** PROCESS_TABLE_PS's lines as a table by process id. Lines that aren't one are skipped. */
export function parseProcessTable(text: string): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const line of text.split(/\r?\n/)) {
    const [pid, parent, ...exe] = line.trim().split('|');
    if (!pid || !/^\d+$/.test(pid)) continue;
    table.set(Number(pid), { pid: Number(pid), parent: Number(parent), exe: exe.join('|') });
  }
  return table;
}

/** The nearest ancestor (or `pid` itself) running from WindowsApps, a packaged app's folder, or null. Stops at a loop or a gap. */
export function packagedAncestor(table: Map<number, Proc>, pid: number): Proc | null {
  const seen = new Set<number>();
  for (let p = table.get(pid); p && !seen.has(p.pid); p = table.get(p.parent)) {
    seen.add(p.pid);
    if (/\\WindowsApps\\/i.test(p.exe)) return p;
  }
  return null;
}

/** The variable a run outside has (outside-run.ts), so it never looks for a package again. */
export const OUTSIDE_ENV = 'KIT_OUTSIDE';

let asked: Promise<Proc | null> | undefined;

/**
 * The packaged app this process runs inside (its nearest ancestor from WindowsApps), or null: not on Windows, in a run
 * outside (OUTSIDE_ENV), or when the table can't be read. Asked once in the process, unless `table` is given (a test's).
 */
export function packagedApp(o: { pid?: number; table?: () => Promise<string>; env?: NodeJS.ProcessEnv } = {}): Promise<Proc | null> {
  const env = o.env ?? process.env;
  if (process.platform !== 'win32' || env[OUTSIDE_ENV] === '1') return Promise.resolve(null);
  const look = async () => {
    try {
      return packagedAncestor(parseProcessTable(await (o.table ?? (() => powershell(PROCESS_TABLE_PS, { timeoutMs: 30_000 })))()), o.pid ?? process.pid);
    } catch {
      return null;
    }
  };
  if (o.table || o.pid !== undefined) return look();
  return (asked ??= look());
}

/** packagedApp, but none in a test run (node --test): a test says for itself whether it runs inside one. */
export const packagedOutsideTests = (): Promise<Proc | null> => (process.env.NODE_TEST_CONTEXT ? Promise.resolve(null) : packagedApp());

// ------------------------------------------------------------------------------------------------
// AppData

/** The folders a packaged app's writes are redirected from: %LOCALAPPDATA%, %APPDATA%, and the profile's AppData that holds them. */
export function appDataFolders(env: NodeJS.ProcessEnv = process.env, home = env.USERPROFILE || os.homedir()): string[] {
  return [env.LOCALAPPDATA, env.APPDATA, home ? path.win32.join(home, 'AppData') : undefined].filter((d): d is string => !!d && path.win32.isAbsolute(d));
}

/**
 * Whether `p` is in AppData (appDataFolders), however its case is written: a packaged app's write there lands in its
 * own folder. %TEMP% isn't, though it's usually %LOCALAPPDATA%\Temp: Windows doesn't redirect it.
 */
export function inAppData(p: string, env: NodeJS.ProcessEnv = process.env, home?: string): boolean {
  if (!p || !path.win32.isAbsolute(p)) return false;
  const key = (s: string) => path.win32.resolve(s).replace(/[\\/]+$/, '').toLowerCase();
  const k = key(p);
  const under = (d: string) => k === key(d) || k.startsWith(`${key(d)}\\`);
  const temp = [env.TEMP, env.TMP].filter((d): d is string => !!d && path.win32.isAbsolute(d));
  return appDataFolders(env, home).some(under) && !temp.some(under);
}

// ------------------------------------------------------------------------------------------------
// Running outside

/** What setup is given for its run outside: SetupOptions that are data, nothing that is a function. */
export interface OutsideSetupOptions {
  ids: string[];
  kinds?: string[];
  yes?: boolean;
  configFile?: string;
  home?: string;
  app?: string;
  gpuWithNpu?: boolean;
  noneConfigured?: string;
  npuNoteFile?: string;
  npuReportFile?: string | null;
  blockedFile?: string | null;
  signaturesFile?: string | null;
}

/** What runs outside: a setup (setup.ts' setupCommand), or the keeper's moves of the NPU server's plugin (npu-patch.ts). */
export type OutsideJob =
  | { kind: 'setup'; options: OutsideSetupOptions }
  | { kind: 'patch-in'; target: string; from: string; want: string; isStock: boolean }
  | { kind: 'stock-back'; target: string };

/** A setup's run outside, as it comes back: its exit code and the entries it set up. */
export interface OutsideSetupResult {
  code: number;
  entries: Record<string, any>[];
}

/** Task Scheduler wouldn't run it: the step it was for is refused where it writes under AppData. */
export class OutsideUnavailable extends Error {}

export interface OutsideOptions {
  /** Each line the run writes, as it writes it. */
  log?: (line: string) => void;
  /** Where its job folder goes: the accelerators' folder's `outside` (never AppData, so both sides see the same files). */
  dir?: string;
  /** The Node that runs it: this one. */
  node?: string;
  /** schtasks.exe, as a function (a test's stands in). */
  schtasks?: (args: string[]) => Promise<{ code: number; out: string }>;
  /** How long Task Scheduler may take to start it, and the run to finish. */
  startMs?: number;
  timeoutMs?: number;
  /** How often its folder is looked at. */
  everyMs?: number;
  env?: NodeJS.ProcessEnv;
}

const SCHTASKS = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');
/** conhost --headless gives node its console without a window (install.ts' CONHOST). */
const CONHOST = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe');
/** The run outside (outside-run.ts): beside this file, as .ts or, in a release, as .js. */
const RUNNER = fileURLToPath(new URL(`./outside-run${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));

/** How long Task Scheduler gets to start the run, and the run to finish: setup's model pulls may take hours. */
export const OUTSIDE_START_MS = 2 * 60_000;
export const OUTSIDE_TIMEOUT_MS = 8 * 3600_000;

const schtasksExe = (args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(SCHTASKS, args, { windowsHide: true, timeout: 60_000 }, (e, stdout, stderr) => resolve({ code: e ? (typeof (e as any).code === 'number' ? (e as any).code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() })),
  );

/**
 * The kit's own variables a run outside keeps (its folders, its pace, the accelerators' and agents' homes): Task
 * Scheduler starts it with the account's own environment, which lacks what a session or a test set. Nothing that
 * names a token, a key, a secret or a password: job.json is a file.
 */
export function carriedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const ours = /^(MANOR|REEVE|ACCELERATORS|KIT|SMITH|CASTELLAN|SENESCHAL|STEWARD|NPU)_/i;
  const secret = /TOKEN|SECRET|KEYS?$|KEY_|PASSWORD|LICEN[CS]E/i;
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && ours.test(e[0]) && !secret.test(e[0]) && e[0] !== OUTSIDE_ENV));
}

/** The task's name: in Castellan's Task Scheduler folder for this account (install.ts' taskName), one of its own for each run. */
export function outsideTaskName(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.USERPROFILE ? path.win32.basename(env.USERPROFILE.replace(/[\\/]+$/, '')) : '';
  const account = (profile || env.USERNAME || 'user').replace(/[\\/:*?"<>|]/g, '_');
  return `\\Castellan (${account})\\Outside the app ${id}`;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quote = (s: string) => `"${s}"`;

/**
 * The one-off task: no trigger (it runs when asked), as this user while signed in (an interactive token, no password
 * or administrator), hidden, on battery too, below-normal priority, at most OUTSIDE_TIMEOUT_MS. It runs `node
 * outside-run.ts <folder>` in the folder.
 */
export function outsideTaskXml(o: { name: string; user: string; node: string; folder: string; what: string }): string {
  const hours = Math.ceil(OUTSIDE_TIMEOUT_MS / 3600_000);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`${o.what}, run by Task Scheduler outside the app that started it (a packaged app keeps what it writes to AppData to itself). It is deleted when it is done.`)}</Description>
    <URI>${xmlEscape(o.name)}</URI>
  </RegistrationInfo>
  <Triggers />
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
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT${hours}H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(CONHOST)}</Command>
      <Arguments>${xmlEscape(['--headless', quote(o.node), quote(RUNNER), quote(o.folder)].join(' '))}</Arguments>
      <WorkingDirectory>${xmlEscape(o.folder)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** What each job is, in a line: the task's description, and the line said before it runs. */
const jobWhat = (job: OutsideJob) => (job.kind === 'setup' ? 'Local AI setup' : `${path.win32.basename(job.target)} put in place`);

/** The run's lines written since `from` (bytes), whole lines only, and where the next read starts. */
function newLines(file: string, from: number): { lines: string[]; next: number } {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { lines: [], next: from };
  }
  if (size <= from) return { lines: [], next: from };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return { lines: [], next: from };
    return { lines: text.slice(0, end).split(/\r?\n/), next: from + Buffer.byteLength(text.slice(0, end + 1)) };
  } finally {
    closeSync(fd);
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeWhole(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

/**
 * Runs `job` outside the packaged app this process is in: as a one-off task Task Scheduler starts (outsideTaskXml),
 * each line it writes passed to `log` as it comes, until its result is written. The task is deleted after; its folder
 * too, unless it ran and failed (its log stays, for whoever looks). Its result, or the error it ended with.
 * OutsideUnavailable when Task Scheduler wouldn't take or start it.
 */
export async function runOutside<T>(job: OutsideJob, o: OutsideOptions = {}): Promise<T> {
  const env = o.env ?? process.env;
  const schtasks = o.schtasks ?? schtasksExe;
  const id = randomBytes(4).toString('hex');
  const folder = path.join(o.dir ?? path.join(acceleratorsHome(env), 'outside'), id);
  const name = outsideTaskName(id, env);
  const files = { job: path.join(folder, 'job.json'), pid: path.join(folder, 'pid.json'), log: path.join(folder, 'log.txt'), result: path.join(folder, 'result.json'), xml: path.join(folder, 'task.xml') };
  mkdirSync(folder, { recursive: true });
  writeWhole(files.job, { job, env: carriedEnv(env) });
  const user = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME ?? ''}` : (env.USERNAME ?? '');
  const xml = outsideTaskXml({ name, user, node: o.node ?? process.execPath, folder, what: jobWhat(job) });
  writeFileSync(files.xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  let ok = false;
  try {
    const created = await schtasks(['/Create', '/XML', files.xml, '/TN', name, '/F']);
    if (created.code !== 0) throw new OutsideUnavailable(`Task Scheduler wouldn't take the task (${created.out || `exit ${created.code}`})`);
    const ran = await schtasks(['/Run', '/TN', name]);
    if (ran.code !== 0) throw new OutsideUnavailable(`Task Scheduler wouldn't start the task (${ran.out || `exit ${ran.code}`})`);
    const started = Date.now();
    const deadline = started + (o.timeoutMs ?? OUTSIDE_TIMEOUT_MS);
    let read = 0;
    const pass = () => {
      const got = newLines(files.log, read);
      read = got.next;
      for (const l of got.lines) o.log?.(l);
    };
    for (;;) {
      const result = readJson(files.result);
      if (result) {
        pass();
        if (result.ok) {
          ok = true;
          return result.value as T;
        }
        throw new Error(String(result.error ?? 'the run outside failed'));
      }
      pass();
      const pid = readJson(files.pid)?.pid;
      if (typeof pid !== 'number' && Date.now() - started > (o.startMs ?? OUTSIDE_START_MS)) throw new OutsideUnavailable(`Task Scheduler didn't start it within ${Math.round((o.startMs ?? OUTSIDE_START_MS) / 1000)} s`);
      // Its result is written before it exits, and looked for first: gone without one, it stopped part-way.
      if (typeof pid === 'number' && !alive(pid) && !readJson(files.result)) throw new Error(`it stopped without finishing (its log: ${files.log})`);
      if (Date.now() > deadline) throw new Error(`it was still running after ${Math.round((o.timeoutMs ?? OUTSIDE_TIMEOUT_MS) / 60_000)} minutes (its log: ${files.log})`);
      await new Promise((r) => setTimeout(r, o.everyMs ?? 500));
    }
  } finally {
    await schtasks(['/Delete', '/TN', name, '/F']).catch(() => null);
    if (ok || !readJson(files.pid)) rmSync(folder, { recursive: true, force: true });
  }
}
