import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

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
 * `npx` its own npm (no shell, so no cmd.exe quoting). Everything else, gh too, is found on PATH.
 */
export function resolveCommand(cmd: string, args: string[]): [string, string[]] {
  if (cmd === 'node') return [process.execPath, args];
  if ((cmd === 'npm' || cmd === 'npx') && existsSync(npmCli(cmd))) return [process.execPath, [npmCli(cmd), ...args]];
  return [cmd, args];
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

/**
 * The real runner. The Node running the Steward goes first on PATH, so npm's scripts find the same one; then a
 * .NET with an SDK, as DOTNET_ROOT too, so a .NET employee's commands find one.
 */
export const run: Runner = (cmd, args, opts = {}) => {
  const [file, argv] = resolveCommand(cmd, args);
  const env = { ...process.env, ...opts.env };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  if (dotnetDir === undefined) dotnetDir = dotnetWithSdk();
  env[pathKey] = [nodeDir, dotnetDir, env[pathKey] ?? ''].filter(Boolean).join(path.delimiter);
  if (dotnetDir) env.DOTNET_ROOT = dotnetDir;
  return new Promise((resolve) => {
    execFile(
      file,
      argv,
      { cwd: opts.cwd, env, windowsHide: true, timeout: opts.timeoutMs ?? 20 * 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (e: any, stdout, stderr) => {
        // gh not on PATH: one plain line on what to do, not a spawn error.
        if (e?.code === 'ENOENT' && cmd === 'gh') return resolve({ code: 127, out: '', err: NO_GH });
        const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
        const err = [String(stderr ?? ''), e && typeof e.code !== 'number' ? String(e.message) : ''].filter(Boolean).join('\n');
        resolve({ code, out: String(stdout ?? ''), err });
      },
    );
  });
};

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
