import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs a Windows PowerShell 5.1 script and returns what it printed. The script goes in as
 * -EncodedCommand (UTF-16LE base64), so nothing in it needs quoting for a command line. 5.1, not
 * pwsh 7: it is on every Windows PC, and only it projects WinRT types (OCR, PDF rendering).
 *
 * A command line holds at most 32,767 characters, and base64 of UTF-16 is 2.7 times the script, so a
 * script over ~11,000 characters goes in as a temporary .ps1 file instead (UTF-8 with a byte-order
 * mark: 5.1 reads a file without one as ANSI).
 */
export function powershell(script: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const prelude = "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; " +
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }\n';
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64');
  let file: string | null = null;
  let how = ['-EncodedCommand', encoded];
  if (encoded.length > 30_000) {
    // The system temp folder, not the agent's: importing app.ts here would fix its data folder before a
    // test points it elsewhere.
    file = path.join(os.tmpdir(), `ps-${process.pid}-${randomBytes(4).toString('hex')}.ps1`);
    writeFileSync(file, '\uFEFF' + prelude + script);
    how = ['-File', file];
  }
  const cleanup = () => file && rmSync(file, { force: true });
  return new Promise<string>((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...how], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`PowerShell timed out after ${opts.timeoutMs ?? 60_000} ms`));
    }, opts.timeoutMs ?? 60_000);
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
