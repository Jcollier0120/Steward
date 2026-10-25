import assert from 'node:assert/strict';
import cp, { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

// kit 2.136.1: a release signs ps-worker.ps1 (kit 2.123.0), and the signature block took it from 3.4 to 18 KB. As
// -EncodedCommand that was 48,000 characters, over a command line's 32,767: every worker's start threw spawn
// ENAMETOOLONG, and every script with it (Clerk's rounds, every staff member's pace, Manor's look at the accelerators).
// The kit's ps.ts here runs a worker signed as a release signs it: a signature block of the same size.
const kit = mkdtempSync(path.join(os.tmpdir(), 'ps-worker-'));
for (const f of ['ps.ts', 'console.ts']) copyFileSync(new URL(`../node/${f}`, import.meta.url), path.join(kit, f));
writeFileSync(path.join(kit, 'package.json'), '{"type":"module"}');
const signature = Array.from({ length: 220 }, () => `# ${randomBytes(48).toString('base64')}\r\n`).join('');
const worker = readFileSync(new URL('../node/ps-worker.ps1', import.meta.url), 'utf8') + `\r\n# SIG # Begin signature block\r\n${signature}# SIG # End signature block\r\n`;
writeFileSync(path.join(kit, 'ps-worker.ps1'), worker);
const href = pathToFileURL(path.join(kit, 'ps.ts')).href;
const { powershell, stopPowerShellWorker } = await import(href);
after(() => {
  stopPowerShellWorker();
  rmSync(kit, { recursive: true, force: true });
});

const windows = { skip: process.platform !== 'win32' };

test('on Windows, a signed worker too long for a command line starts, and scripts longer than one run in it and on their own', windows, async () => {
  // The worker as -EncodedCommand, as before: Windows refuses its command line.
  let refused: string | undefined;
  try {
    spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(worker, 'utf16le').toString('base64')], { stdio: 'ignore' }).kill();
  } catch (e) {
    refused = (e as NodeJS.ErrnoException).code;
  }
  assert.equal(refused, 'ENAMETOOLONG');

  const long = '# ' + 'x'.repeat(40_000) + '\n';
  const first = (await powershell(`${long}Write-Output "$PID $([char]0x00e9)"`)).trim();
  assert.match(first, /^\d+ é$/);
  const pid = first.split(' ')[0];
  assert.equal((await powershell('$PID')).trim(), pid, 'both ran in the one worker, not each in a powershell.exe of its own');
  // A script that calls exit never goes to the worker: on its own, from a temporary file, removed after.
  const own = (await powershell(`${long}Write-Output $PID; exit 0`)).trim();
  assert.match(own, /^\d+$/);
  assert.notEqual(own, pid);
  assert.ok(!readdirSync(os.tmpdir()).some((f) => f.startsWith(`ps-${process.pid}-`)), 'the script file is removed');
});

test("on Windows, a worker Windows won't start at all: scripts run on their own, and none fails for it", windows, async () => {
  // A fresh ps.ts, with no worker yet, whose worker's spawn throws as Windows' refusal did.
  const fresh = await import(`${href}?refused`);
  const real = cp.spawn;
  let refusals = 0;
  cp.spawn = ((file: string, args: readonly string[], opts: cp.SpawnOptions) => {
    if (args.at(-1)?.endsWith('ps-worker.ps1')) {
      refusals++;
      throw Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
    }
    return real(file, args, opts);
  }) as typeof cp.spawn;
  syncBuiltinESMExports();
  try {
    assert.match((await fresh.powershell('$PID')).trim(), /^\d+$/);
    assert.equal((await fresh.powershell("Write-Output 'again'")).trim(), 'again');
    assert.equal(refusals, 1, 'tried once, not before every script');
  } finally {
    cp.spawn = real;
    syncBuiltinESMExports();
    fresh.stopPowerShellWorker();
  }
});
