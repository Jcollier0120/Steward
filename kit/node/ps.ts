import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRELUDE = "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; " +
  'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }\n';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/**
 * Runs a Windows PowerShell 5.1 script and returns what it printed. 5.1, not pwsh 7: it is on every Windows PC, and
 * only it projects WinRT types (OCR, PDF rendering).
 *
 * Scripts run in the agent's PowerShell worker (ps-worker.ps1): one powershell.exe that stays while scripts keep
 * coming, each script in its own runspace, several at once. Starting powershell.exe for each script cost the PC a
 * process and its console host every time, all day: Windows doesn't give all of a process's memory back when it ends.
 * The worker goes after IDLE_MS with nothing to run, and is replaced after MAX_SCRIPTS. A script that calls `exit`, and
 * any script while the worker can't run, gets its own powershell.exe as before (oneShot).
 */
export function powershell(script: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (oneShotOnly || CALLS_EXIT.test(script)) return oneShot(script, timeoutMs);
  return worker().run(script, timeoutMs).catch((e) => (e instanceof WorkerGone ? oneShot(script, e.timeLeft) : Promise.reject(e)));
}

/** `exit`, as a command: in a runspace it would drop the script's output and its exit code. */
export const CALLS_EXIT = /(^|[\s;{(|&])exit(\s|;|$|\))/im;

/** PowerShell from Node without the worker: KIT_PS_WORKER=0, or after the worker couldn't start. */
let oneShotOnly = process.env.KIT_PS_WORKER === '0';

/** How long the worker stays with nothing to run, and how many scripts it runs before a fresh one takes over. */
export const IDLE_MS = 2 * 60_000;
export const MAX_SCRIPTS = 500;

/** The worker went before answering (stopped on another script's timeout, or it failed): the script runs on its own. */
class WorkerGone extends Error {
  timeLeft: number;
  constructor(timeLeft: number) {
    super('the PowerShell worker ended');
    this.timeLeft = timeLeft;
  }
}

interface Pending {
  resolve: (out: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  deadline: number;
}

class Worker {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private buf = '';
  private runs = 0;
  private next = 0;
  private idle: NodeJS.Timeout | null = null;
  gone = false;

  constructor() {
    const source = readFileSync(new URL('./ps-worker.ps1', import.meta.url), 'utf8');
    this.proc = spawn('powershell.exe', [...PS_ARGS, '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true });
    this.proc.stdout.setEncoding('utf8').on('data', (d: string) => this.read(d));
    this.proc.stderr.resume();
    this.proc.stdin.on('error', () => this.end());
    this.proc.on('error', () => {
      // No powershell.exe to start: each script on its own would fail the same way, and say why.
      oneShotOnly = true;
      this.end();
    });
    this.proc.on('close', () => this.end());
  }

  run(script: string, timeoutMs: number): Promise<string> {
    if (this.gone) return Promise.reject(new WorkerGone(timeoutMs));
    const id = String(++this.next);
    this.runs++;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.hold(true);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PowerShell timed out after ${timeoutMs} ms`));
        // Only stopping the worker stops a script that never ends. What else it was running starts again on its own.
        this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, deadline: Date.now() + timeoutMs });
      this.proc.stdin.write(`${id}|${Buffer.from(PRELUDE + script, 'utf8').toString('base64')}\n`);
    });
  }

  private read(data: string) {
    this.buf += data;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      const [id, failed, out, err] = line.split('|');
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const text = (s = '') => Buffer.from(s, 'base64').toString('utf8');
      if (failed === '0') p.resolve(text(out));
      else p.reject(new Error(`PowerShell exited 1: ${(text(err) || text(out)).trim().slice(0, 500)}`));
    }
    if (this.pending.size || this.gone) return;
    if (this.runs >= MAX_SCRIPTS) return this.stop();
    this.hold(false);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref();
  }

  /** While a script runs, the worker keeps Node running for its answer; idle, it never keeps a command from exiting. */
  private hold(on: boolean) {
    for (const h of [this.proc, this.proc.stdin, this.proc.stdout, this.proc.stderr] as { ref?: () => void; unref?: () => void }[]) (on ? h.ref : h.unref)?.call(h);
  }

  stop() {
    if (this.gone) return;
    this.end();
    this.proc.stdin.end();
    this.proc.kill();
  }

  private end() {
    if (this.gone) return;
    this.gone = true;
    if (this.idle) clearTimeout(this.idle);
    if (current === this) current = null;
    this.hold(false);
    const now = Date.now();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new WorkerGone(Math.max(1000, p.deadline - now)));
    }
    this.pending.clear();
  }
}

let current: Worker | null = null;
const worker = () => (current && !current.gone ? current : (current = new Worker()));

/** Stops the worker now (a test, or an agent shutting down); the next script starts another. */
export function stopPowerShellWorker(): void {
  current?.stop();
}

/**
 * A script in its own powershell.exe. The script goes in as -EncodedCommand (UTF-16LE base64), so nothing in it needs
 * quoting for a command line. A command line holds at most 32,767 characters, and base64 of UTF-16 is 2.7 times the
 * script, so a script over ~11,000 characters goes in as a temporary .ps1 file instead (UTF-8 with a byte-order mark:
 * 5.1 reads a file without one as ANSI).
 */
export function oneShot(script: string, timeoutMs: number): Promise<string> {
  const encoded = Buffer.from(PRELUDE + script, 'utf16le').toString('base64');
  let file: string | null = null;
  let how = ['-EncodedCommand', encoded];
  if (encoded.length > 30_000) {
    // The system temp folder, not the agent's: importing app.ts here would fix its data folder before a
    // test points it elsewhere.
    file = path.join(os.tmpdir(), `ps-${process.pid}-${randomBytes(4).toString('hex')}.ps1`);
    writeFileSync(file, '﻿' + PRELUDE + script);
    how = ['-File', file];
  }
  const cleanup = () => file && rmSync(file, { force: true });
  return new Promise<string>((resolve, reject) => {
    const p = spawn('powershell.exe', [...PS_ARGS, ...how], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`PowerShell timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    p.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    p.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`PowerShell exited ${code}: ${(err || out).trim().slice(0, 500)}`));
    });
  }).finally(cleanup);
}

/**
 * A script whose output is JSON (end it with `| ConvertTo-Json -Depth 5 -Compress`). ConvertTo-Json
 * prints one object, not a list of one, and nothing at all for none; this always returns a list.
 */
export async function powershellList<T>(script: string, opts: { timeoutMs?: number } = {}): Promise<T[]> {
  const text = (await powershell(script, opts)).trim();
  if (!text) return [];
  const json = JSON.parse(text);
  return Array.isArray(json) ? json : [json];
}

/** Every character PowerShell ends a single-quoted string at: ' and the curly quotes ‘ ’ ‚ ‛. */
export const PS_SINGLE_QUOTES = /['‘’‚‛]/g;

/**
 * A PowerShell single-quoted string literal: whatever `s` holds, PowerShell reads back exactly `s`, never code.
 * PowerShell takes the curly quotes (U+2018 to U+201B) as single quotes too, so each of those is doubled
 * as well as the ASCII one: a doubled quote is how a single-quoted string holds one.
 */
export const psQuote = (s: string) => `'${s.replace(PS_SINGLE_QUOTES, '$&$&')}'`;
