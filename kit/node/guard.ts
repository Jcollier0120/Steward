import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { psQuote } from './ps.ts';

/**
 * A guard's agent side (kit 2.87.0): what the Watchman and the Lamplighter each had, for a guard that runs as SYSTEM
 * from its own folder (%ProgramData%\<Agent>) and is turned on and off by its install-guard.ps1, elevated. Here: the
 * release's manifest of the guard's scripts and whether the guard's copies are behind it, whether the guard is there,
 * turning it on or off (through Windows' administrator prompt, or directly when already elevated, or as a dry run),
 * and refusing to uninstall the agent while the guard is on. Each takes the agent's own names and folders; nothing
 * here knows an agent. Its PowerShell side is guard-kit.ps1, beside this file (copyGuardKit).
 *
 * The agent never writes in the guard's folder, and never runs a guard script from it but install-guard.ps1 to turn
 * the guard off when the agent's own copy is gone: scripts reach bin\ only through install-guard.ps1, elevated, which
 * checks each against the release's manifest itself.
 */

/** What a command printed, and how it ended. */
export interface Ran {
  code: number;
  out: string;
  err: string;
}

export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; onLine?: (line: string) => void }) => Promise<Ran>;

/**
 * Runs a program without a shell (nothing in its arguments is interpreted), hidden, and gives back what
 * it printed; `onLine` hears each line as it comes. A program that can't start, or runs out of time, comes
 * back as a code other than 0 with why in `err`; it never throws.
 */
export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let out = '';
    let err = '';
    let partial = '';
    let done = false;
    const finish = (code: number, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (partial) opts.onLine?.(partial);
      resolve({ code, out, err: why ? `${err}${err ? '\n' : ''}${why}` : err });
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out: '', err: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      p.kill();
      finish(-1, `${path.basename(cmd)} timed out after ${Math.round((opts.timeoutMs ?? 60_000) / 1000)} s`);
    }, opts.timeoutMs ?? 60_000);
    p.stdout?.setEncoding('utf8').on('data', (d: string) => {
      out += d;
      if (!opts.onLine) return;
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) opts.onLine(l);
    });
    p.stderr?.setEncoding('utf8').on('data', (d) => (err += d));
    p.on('error', (e) => finish(-1, e.message));
    p.on('close', (code) => finish(code ?? -1));
  });

/** Windows PowerShell 5.1, which every Windows has: the guard's scripts are written for it. */
export const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** A .ps1 file and its arguments, as powershell.exe takes them. */
export const psFile = (file: string, args: string[]) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args];

// ---------------------------------------------------------------- the release's scripts

const readJsonFile = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
};

/**
 * This release's SHA-256 of each of the guard's `scripts` (manifest.json in `source`, which the agent's release build
 * writes): null when there is none, or it lacks one of them.
 */
export function readScriptManifest(source: string, scripts: readonly string[]): Record<string, string> | null {
  const m = readJsonFile<{ files?: Record<string, unknown> }>(path.join(source, 'manifest.json'));
  if (!m?.files || typeof m.files !== 'object') return null;
  const files: Record<string, string> = {};
  for (const f of scripts) {
    const h = m.files[f];
    if (typeof h !== 'string' || !/^[0-9a-f]{64}$/i.test(h)) return null;
    files[f] = h.toLowerCase();
  }
  return files;
}

/** Each file's SHA-256, read again only when its size or time changes: Manor's ping asks every few seconds. */
const hashMemo = new Map<string, { key: string; sha: string }>();
export function sha256Of(file: string): string | null {
  try {
    const st = statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const kept = hashMemo.get(file);
    if (kept?.key === key) return kept.sha;
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    hashMemo.set(file, { key, sha });
    return sha;
  } catch {
    return null;
  }
}

/**
 * The scripts the guard runs (`root`\bin, which every user may read) that differ from this release's manifest, or are
 * missing: [] when they match, when the guard isn't set up (no bin\guard.ps1), or when this copy has no manifest (a
 * checkout). Only read.
 */
export function scriptsBehind(root: string, source: string, scripts: readonly string[]): string[] {
  const bin = path.join(root, 'bin');
  if (!existsSync(path.join(bin, 'guard.ps1'))) return [];
  const want = readScriptManifest(source, scripts);
  if (!want) return [];
  return scripts.filter((f) => sha256Of(path.join(bin, f)) !== want[f]);
}

/** The manifest an agent's release build writes beside its guard's scripts (its tools/guard-manifest.ts): each one's SHA-256. */
export function guardManifest(dir: string, scripts: readonly string[]): { schema: 1; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const f of scripts) files[f] = createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex');
  return { schema: 1, files };
}

/** The kit's guard helpers' file name: one of the guard's scripts once an agent's install-guard.ps1 dot-sources it. */
export const GUARD_KIT = 'guard-kit.ps1';

/**
 * Copies guard-kit.ps1 from the kit into `dir` (the agent's src\guard, beside install-guard.ps1), before its release
 * build hashes the scripts and before its tests run them. Whether it changed anything.
 */
export function copyGuardKit(dir: string): boolean {
  const from = new URL(`./${GUARD_KIT}`, import.meta.url);
  const to = path.join(dir, GUARD_KIT);
  const want = readFileSync(from);
  if (existsSync(to) && readFileSync(to).equals(want)) return false;
  copyFileSync(from, to);
  return true;
}

// ---------------------------------------------------------------- turning it on and off

export const DEV_GUARD = "This is a development checkout. The guard runs from the installed copy's scripts: install the release (npm run release -- --install), then turn the guard on there. --dry-run shows every step from here.";

/**
 * Whether the guard is there at all: its scripts, its state or its settings in its folder. While it is, the agent
 * mustn't be uninstalled alone: the guard would go on running as SYSTEM with nothing to turn it off.
 */
export const guardPresent = (root: string) => ['bin/guard.ps1', 'bin/install-guard.ps1', 'state.json', 'config.json'].some((f) => existsSync(path.join(root, f)));

/** This process runs as an administrator (elevated), so the guard can be turned off without asking Windows again. */
export async function isElevated(runner: Runner = run): Promise<boolean> {
  const r = await runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { timeoutMs: 30_000 });
  return r.code === 0 && r.out.trim() === 'True';
}

/**
 * Runs a guard script elevated, through Windows' administrator prompt (UAC: Start-Process -Verb RunAs), which waits
 * for the person; its window can't print here, so the script writes `log` (made afresh: any file there is removed
 * first), printed when it ends. The script's path and arguments go to Start-Process as one single-quoted string
 * (psQuote), so nothing in them is ever a command. Exit 1223: the person said no to the prompt, or it couldn't open.
 * (The Watchman's 30 minutes, the Lamplighter's 15, as `timeoutMs`.)
 */
export async function runElevated(script: string, args: string[], o: { log: string; out: (line: string) => void; runner?: Runner; timeoutMs?: number }): Promise<number> {
  const runner = o.runner ?? run;
  rmSync(o.log, { force: true });
  const inner = [...psFile(script, [...args, '-Log', o.log])].map((a) => (/[\s'"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  const outer = `try { $p = Start-Process -FilePath ${psQuote(POWERSHELL)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${psQuote(inner)}; exit $p.ExitCode } catch { Write-Output $_.Exception.Message; exit 1223 }`;
  const r = await runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', outer], { timeoutMs: o.timeoutMs ?? 15 * 60_000 });
  if (existsSync(o.log)) for (const line of readFileSync(o.log, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) if (line.trim()) o.out(line);
  if (r.code === 1223) o.out(`The administrator prompt was turned down or couldn't open, so nothing changed. ${r.out.trim()}`.trim());
  return r.code;
}

export interface GuardCommandOptions {
  dryRun: boolean;
  out: (line: string) => void;
  /** The agent's own copy of the guard's scripts (its src\guard). */
  source: string;
  /** The guard's folder (%ProgramData%\<Agent>): where its own bin\install-guard.ps1 is, to turn it off without the agent's copy. */
  guardRoot: string;
  /** A guard's folder other than the usual, passed on as -Root (tests). */
  root?: string;
  /** Where the elevated run's log goes (the agent's data folder): guard-install.log, guard-uninstall.log. */
  dataDir: string;
  /** The agent's own arguments for install-guard.ps1 (its settings: -Countdown 60, -TurnOnProtection 1). */
  args: string[];
  /** A development checkout: turning the guard on is refused (DEV_GUARD), as it must run from an installed copy. */
  dev: boolean;
  /** This process is already elevated (Manor's uninstaller): the script runs directly, with no prompt. */
  elevated?: boolean;
  runner?: Runner;
  /** How long the elevated run may take: 15 minutes unless given. */
  timeoutMs?: number;
}

/**
 * Turns the guard on or off (install-guard.ps1). Elevated, through Windows' administrator prompt (runElevated); when
 * this process is already elevated, directly. With dryRun, it runs unelevated with -WhatIf and prints every step
 * instead. Turning it off works from a development checkout too, and with the agent's own copy gone it uses the
 * guard's own (its bin\). Exit codes: 0 done, 1 failed, 2 refused here (a checkout), 5 not elevated, 1223 the person
 * said no to the administrator prompt.
 */
export async function guardCommand(action: 'install' | 'uninstall', o: GuardCommandOptions): Promise<number> {
  const runner = o.runner ?? run;
  let source = o.source;
  if (action === 'uninstall' && !existsSync(path.join(source, 'install-guard.ps1'))) {
    const own = path.join(o.root ?? o.guardRoot, 'bin');
    if (existsSync(path.join(own, 'install-guard.ps1'))) source = own;
  }
  const script = path.join(source, 'install-guard.ps1');
  const args = ['-Action', action, '-Source', source, ...o.args];
  if (o.root) args.push('-Root', o.root);
  if (o.dryRun) {
    const r = await runner(POWERSHELL, psFile(script, [...args, '-WhatIf']), { timeoutMs: 60_000, onLine: o.out });
    if (r.err.trim()) o.out(r.err.trim());
    return r.code;
  }
  if (action === 'install' && o.dev) {
    o.out(DEV_GUARD);
    return 2;
  }
  const doing = action === 'install' ? 'Turning on' : 'Turning off';
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;
  if (o.elevated) {
    o.out(`${doing} the guard (already running as an administrator).`);
    const r = await runner(POWERSHELL, psFile(script, args), { timeoutMs, onLine: o.out });
    if (r.err.trim()) o.out(r.err.trim());
    return r.code;
  }
  o.out(`${doing} the guard: Windows asks for an administrator (it may wait in the taskbar).`);
  return runElevated(script, args, { log: path.join(o.dataDir, `guard-${action}.log`), out: o.out, runner, timeoutMs });
}

// ---------------------------------------------------------------- uninstalling the agent

/** The exit code of an uninstall refused while the guard is on. */
export const GUARD_STILL_ON = 3;

/** How an agent's refusal to uninstall names it and its guard. */
export interface GuardWords {
  /** "the Watchman" */
  agent: string;
  /** Its command: "watchman". */
  command: string;
  /** What the guard does, after "it runs as SYSTEM from <root>": ", keeping System Protection on and making restore points". */
  does: string;
  /** What turning it off leaves or puts back: "System Protection and the restore points are left as they are". */
  offLeaves: string;
}

/** Why the agent isn't uninstalled while its guard is on, and how to turn the guard off first. */
export function guardOnWords(root: string, w: GuardWords): string[] {
  return [
    `The guard is still on: it runs as SYSTEM from ${root}${w.does}, so ${w.agent} isn't uninstalled while it is.`,
    `Turn it off first (Windows asks for an administrator once; ${w.offLeaves}), then uninstall:`,
    `  ${w.command} guard off`,
    `  ${w.command} uninstall`,
    `Or both at once: ${w.command} uninstall --guard-off`,
    `Without the agent, as an administrator: powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(root, 'bin', 'install-guard.ps1')}" -Action uninstall`,
  ];
}

export interface UninstallDeps {
  /** The kit's uninstall, with the arguments it takes (--purge, --dry-run). */
  uninstall: (args: string[]) => Promise<number>;
  /** Turns the guard off (guardCommand('uninstall')), with --dry-run's printing when dryRun. */
  guardOff: (dryRun: boolean) => Promise<number>;
  out: (line: string) => void;
  /** The guard's folder. */
  root: string;
  words: GuardWords;
}

/**
 * `<agent> uninstall`: the agent's own uninstall (the kit's), but never while the guard is on: with the agent gone,
 * nothing would show what it does or turn it off. So while it is there, uninstall refuses (GUARD_STILL_ON) and says
 * how to turn it off first; `--guard-off` turns it off and then uninstalls, only when that worked.
 */
export async function uninstallAgent(args: string[], d: UninstallDeps): Promise<number> {
  const root = d.root;
  const dryRun = args.includes('--dry-run');
  const rest = args.filter((a) => a !== '--guard-off');
  if (guardPresent(root)) {
    if (!args.includes('--guard-off')) {
      for (const l of guardOnWords(root, d.words)) d.out(l);
      return GUARD_STILL_ON;
    }
    const code = await d.guardOff(dryRun);
    if (code !== 0) {
      d.out(`The guard couldn't be turned off (exit ${code}), so ${d.words.agent} isn't uninstalled.`);
      return code;
    }
    if (!dryRun && guardPresent(root)) {
      d.out(`The guard is still in ${root}, so ${d.words.agent} isn't uninstalled.`);
      return GUARD_STILL_ON;
    }
  }
  return d.uninstall(rest);
}
