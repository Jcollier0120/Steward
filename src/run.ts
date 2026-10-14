import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { signedIn } from './git-auth.ts';
import { pacedCommand, type Paced } from './kit/checks-pace.ts';
import { sharesConsole } from './kit/console.ts';
import { gitExe } from './kit/git-exe.ts';

/** What a command did: its exit code, and what it printed. */
export interface Ran {
  code: number;
  out: string;
  err: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Written to its standard input, which is then closed (git credential fill reads its question there). */
  input?: string;
  /**
   * At the kit's checks pace (kit/checks-pace.ts): it and every program it starts held to a share of the processor, at
   * below-normal priority. For test runs, type checks, installs and builds, so they never peg the processor.
   */
  paced?: boolean;
}

/**
 * Runs a program and waits for it. Everything the Steward does outside itself (git, gh, npm, an
 * employee's own commands) goes through one of these, so a test can stand in for it.
 */
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<Ran>;

/** A command line in words, as a shell would split it: spaces separate, double quotes keep a word whole. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (const c of line.trim()) {
    if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(c) && !quoted) {
      if (any) words.push(cur);
      cur = '';
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any) words.push(cur);
  return words;
}

const nodeDir = path.dirname(process.execPath);
const npmCli = (name: 'npm' | 'npx') => path.join(nodeDir, 'node_modules', 'npm', 'bin', `${name}-cli.js`);

/** Said when a command needs gh and this PC has none on PATH. */
export const NO_GH = "gh isn't installed: install GitHub CLI (https://cli.github.com), then run gh auth login";

/**
 * The program to start for a command's first word: `node` is the Node running the Steward, and `npm` and
 * `npx` its own npm (no shell, so no cmd.exe quoting). `az` on Windows is the Azure CLI's own Python, as its az.cmd
 * starts it. `git` on Windows is Git for Windows' own git.exe (kit/git-exe.ts). Everything else, gh too, is found on PATH.
 */
export function resolveCommand(cmd: string, args: string[]): [string, string[]] {
  if (cmd === 'node') return [process.execPath, args];
  // Git for Windows' own git.exe, not the launcher PATH finds, which would start it and a console host for it (kit/git-exe.ts).
  if (cmd === 'git') return [gitExe(), args];
  if ((cmd === 'npm' || cmd === 'npx') && existsSync(npmCli(cmd))) return [process.execPath, [npmCli(cmd), ...args]];
  if (cmd === 'az' && process.platform === 'win32') {
    const python = azurePython();
    if (python) return [python, ['-IBm', 'azure.cli', ...args]];
  }
  return [cmd, args];
}

/** The Azure CLI's Python on Windows (az.cmd runs `python.exe -IBm azure.cli`), where it installs; null when it isn't. */
function azurePython(): string | null {
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    const python = root ? path.join(root, 'Microsoft SDKs', 'Azure', 'CLI2', 'python.exe') : '';
    if (python && existsSync(python)) return python;
  }
  return null;
}

/** Whether a .NET folder holds an SDK (a runtime alone can't build or test). */
const hasSdk = (dir: string) => {
  try {
    return existsSync(path.join(dir, 'dotnet.exe')) && readdirSync(path.join(dir, 'sdk')).length > 0;
  } catch {
    return false;
  }
};

/**
 * A .NET with an SDK, for a .NET employee's tests and release (`dotnet test`, a release.ps1): Settings' .NET SDK
 * (useDotnet), then DOTNET_ROOT, then
 * Program Files'. A runtime alone can't build or test, so a folder without an SDK is passed over: set DOTNET_ROOT to
 * one that has an SDK.
 */
export function dotnetWithSdk(candidates: (string | undefined)[] = [dotnetSetting || undefined, process.env.DOTNET_ROOT, path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'dotnet')]): string | null {
  for (const dir of candidates) if (dir && hasSdk(dir)) return dir;
  return null;
}

let dotnetDir: string | null | undefined;

/** Settings' .NET SDK folder (dotnetRoot, %NAME% expanded), tried first; empty for none. */
let dotnetSetting = '';
export function useDotnet(dir: string): void {
  if (dir === dotnetSetting) return;
  dotnetSetting = dir;
  dotnetDir = undefined;
}

/** In the background: no terminal, so neither its input nor its output is one. */
const BACKGROUND = process.platform === 'win32' && !process.stdin.isTTY && !process.stdout.isTTY;
/** git and gh, the Steward's most frequent commands, whose own programs (git-remote-https) were seen to open no window. A build's (dotnet, npm) might. */
const SHARING = new Set(['git', 'gh']);

/**
 * How a command is started on Windows. git and gh share the Steward's console when it has one (kit/console.ts, Steward
 * 0.36.14): its page's, which keeps a windowless one from the way the kit starts it (kit 2.72.2), or a terminal's, so
 * Ctrl+C stops what it started. Hidden, each would get a console host (conhost.exe) of its own: a second process for
 * every git, all day. With none to share in the background (a page an older kit started), detached (Steward 0.35.11).
 * Everything else starts hidden, as ever.
 */
export function startOptions(cmd: string, o: { shares: boolean; background: boolean }): { windowsHide: boolean; detached: boolean } {
  const sharing = SHARING.has(cmd);
  return { windowsHide: !(sharing && o.shares), detached: sharing && !o.shares && o.background };
}

/**
 * The real runner. The Node running the Steward goes first on PATH, so npm's scripts find the same one; then a
 * .NET with an SDK, as DOTNET_ROOT too, so a .NET employee's commands find one.
 */
/** How much longer a command run at the checks pace may take than its time limit says, when its kit doesn't say (Paced.slower). */
export const PACED_TIME = 4;

/**
 * How long a command may run: its own time limit (20 minutes unless it says), and at the checks pace that stretched by
 * as much as the cap slows it, plus the wait for a turn behind other runs (the kit's pacedSlower and CHECKS_TURN_MS,
 * kit 2.74.2). A fixed four times, for a quarter of the processor, stopped Reeve's tests at 80 minutes on 2026-10-14,
 * held to two of the laptop's 18 processors and sharing them with another run: a third of the way through, nothing
 * failed.
 */
export function timeLimit(timeoutMs: number | undefined, paced: Paced | null, resolved: string): number {
  const own = timeoutMs ?? 20 * 60_000;
  if (!paced || paced.file === resolved) return own;
  return own * (paced.slower ?? PACED_TIME) + (paced.waitMs ?? 0);
}

/** What a run stopped at its time limit says, in place of Node's "Command failed: <the whole command line>". */
export function stoppedForTime(ms: number, paced: boolean): string {
  const span = ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} s`;
  return `stopped after ${span}, its time limit${paced ? ' at the checks pace' : ''}: it was still running`;
}

const runPlain: Runner = async (cmd, args, opts = {}) => {
  const [resolved, resolvedArgs] = resolveCommand(cmd, args);
  const paced = opts.paced ? await pacedCommand(resolved, resolvedArgs) : null;
  const [file, argv] = paced ? [paced.file, paced.args] : [resolved, resolvedArgs];
  const env = { ...process.env, ...paced?.env, ...opts.env };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  if (dotnetDir === undefined) dotnetDir = dotnetWithSdk();
  env[pathKey] = [nodeDir, dotnetDir, env[pathKey] ?? ''].filter(Boolean).join(path.delimiter);
  if (dotnetDir) env.DOTNET_ROOT = dotnetDir;
  // gh sends its telemetry from a copy of itself started after each command, with a console host of its own; and asks
  // for a newer version once a day. Neither for the Steward's commands, unless the person set them.
  if (cmd === 'gh') {
    env.GH_TELEMETRY ??= '0';
    env.GH_NO_UPDATE_NOTIFIER ??= '1';
  }
  // At the checks pace a command gets as much more time as the cap slows it, and its wait for a turn (timeLimit): held to
  // the gentle cap below everything else, and waiting its turn behind other runs, it takes longer (the Assayer's suite on
  // a busy PC: 73 s free, 219 s paced), and a run stopped for that would be taken for a failure.
  const timeout = timeLimit(opts.timeoutMs, paced, resolved);
  return new Promise((resolve) => {
    const child = execFile(
      file,
      argv,
      // execFile hands its options to spawn, detached among them, though its type doesn't name it.
      { cwd: opts.cwd, env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', ...startOptions(cmd, { shares: sharesConsole(), background: BACKGROUND }) } as ExecFileOptionsWithStringEncoding,
      (e: any, stdout: string, stderr: string) => {
        // gh not on PATH: one plain line on what to do, not a spawn error.
        if (e?.code === 'ENOENT' && cmd === 'gh') return resolve({ code: 127, out: '', err: NO_GH });
        const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
        // Stopped at its time limit (Node kills it, with no exit code of its own): said so, not as a failure of its own.
        const stopped = !!e?.killed && typeof e.code !== 'number' ? stoppedForTime(timeout, !!paced && paced.file !== resolved) : '';
        const err = [String(stderr ?? ''), stopped || (e && typeof e.code !== 'number' ? String(e.message) : '')].filter(Boolean).join('\n');
        resolve({ code, out: String(stdout ?? ''), err });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
};

/** The real runner, its git fetches and pushes over https carrying their sign-in themselves (git-auth.ts). */
export const run: Runner = signedIn(runPlain);

/** A command line from an employee's settings, run in its folder. */
export const runLine = (runner: Runner, line: string, opts: RunOptions = {}) => {
  const [cmd, ...args] = splitCommand(line);
  if (!cmd) return Promise.resolve({ code: 2, out: '', err: 'no command' });
  return runner(cmd, args, opts);
};

/** The last lines of a command's output, for a log. */
export function tail(text: string, lines = 30): string {
  const all = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
  return (all.length > lines ? [`… ${all.length - lines} lines before`, ...all.slice(-lines)] : all).join('\n');
}

/**
 * The tests a `node --test` run failed (its TAP output: `not ok <n> - <name>` at the margin, not a TODO or SKIP), each
 * with the first lines of its error. A test that fails mid-output is long gone from a tail of the last lines.
 */
export function failedTests(text: string): { name: string; error: string | null }[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: { name: string; error: string | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m || /#\s*(TODO|SKIP)\b/i.test(m[1])) continue;
    let error: string | null = null;
    for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]) && !/^(not )?ok \d+/.test(lines[j]); j++) {
      const em = /^(\s*)error: (.*)$/.exec(lines[j]);
      if (!em) continue;
      // `error: 'one line'`, or `error: |-` and a block indented further: its first two lines that say something.
      const said: string[] = [];
      if (!/^[|>][-+]?$/.test(em[2])) said.push(em[2].replace(/^'(.*)'$/, '$1'));
      else
        for (let k = j + 1; k < lines.length && said.length < 2; k++) {
          if (lines[k].trim() && lines[k].length - lines[k].trimStart().length <= em[1].length) break;
          if (lines[k].trim()) said.push(lines[k].trim());
        }
      error = said.reduce((all, l) => (all ? `${all}${all.endsWith(':') ? ' ' : ': '}${l}` : l), '') || null;
      break;
    }
    out.push({ name: m[1], error });
  }
  return out;
}
