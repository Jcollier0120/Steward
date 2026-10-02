import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

let ghPath: string | null = null;
/** gh on PATH, or where Manor's PCs keep it. */
function gh(): string {
  if (ghPath) return ghPath;
  ghPath = spawnSync('gh', ['--version'], { windowsHide: true }).status === 0 ? 'gh' : 'C:\\tools\\gh\\bin\\gh.exe';
  return ghPath;
}

/**
 * The program to start for a command's first word: `node` is the Node running the Steward, and `npm` and
 * `npx` its own npm (no shell, so no cmd.exe quoting); `gh` is found on PATH or in C:\tools\gh.
 */
export function resolveCommand(cmd: string, args: string[]): [string, string[]] {
  if (cmd === 'node') return [process.execPath, args];
  if ((cmd === 'npm' || cmd === 'npx') && existsSync(npmCli(cmd))) return [process.execPath, [npmCli(cmd), ...args]];
  if (cmd === 'gh') return [gh(), args];
  return [cmd, args];
}

/** The real runner. The Node running the Steward goes first on PATH, so npm's scripts find the same one. */
export const run: Runner = (cmd, args, opts = {}) => {
  const [file, argv] = resolveCommand(cmd, args);
  const env = { ...process.env, ...opts.env };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${nodeDir}${path.delimiter}${env[pathKey] ?? ''}`;
  return new Promise((resolve) => {
    execFile(
      file,
      argv,
      { cwd: opts.cwd, env, windowsHide: true, timeout: opts.timeoutMs ?? 20 * 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (e: any, stdout, stderr) => {
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
