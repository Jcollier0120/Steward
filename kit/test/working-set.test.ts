import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'kit-working-set-'));
// The test DLL stays loaded until the PowerShell worker it was loaded in has gone.
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

const { trimmedOnceLoaded, reportsLoaded } = await import('./fixture/src/kit/accelerators.ts');
const { trimScript, trimWorkingSet, workingSetDll } = await import('./fixture/src/kit/working-set.ts');
const { locksDir } = await import('./fixture/src/kit/lock.ts');

test("only FastFlowLM's server is trimmed once loaded: flm, by its program, wherever it is and however it's written", () => {
  assert.equal(trimmedOnceLoaded(['%USERPROFILE%\\.manor\\accelerators\\servers\\fastflowlm-1.0.7\\flm.exe', 'serve', 'qwen3.5:2b']), true);
  assert.equal(trimmedOnceLoaded(['C:\\x\\FLM.EXE', 'serve']), true);
  assert.equal(trimmedOnceLoaded(['flm', 'serve']), true);
  for (const other of [['C:\\x\\llama-server.exe', '--embeddings'], ['C:\\x\\ovms.exe'], ['C:\\x\\geniex.exe'], ['C:\\x\\flmx.exe'], []]) assert.equal(trimmedOnceLoaded(other), false, other.join(' '));
  assert.equal(trimmedOnceLoaded(undefined), false);
  assert.equal(trimmedOnceLoaded(['C:\\x\\flm.exe']), reportsLoaded(['C:\\x\\flm.exe']), 'the same server the loaded check knows');
});

test('the helper is compiled once, beside the accelerators\' locks, named for its source', () => {
  const dll = workingSetDll('class A {}');
  assert.equal(path.dirname(dll), path.join(path.dirname(locksDir), 'kit'));
  assert.match(path.basename(dll), /^working-set-[0-9a-f]{12}\.dll$/);
  assert.notEqual(workingSetDll('class B {}'), dll, 'a changed source is a new DLL');
  assert.equal(workingSetDll(), workingSetDll(readFileSync(new URL('./fixture/src/kit/working-set.cs', import.meta.url), 'utf8')));
});

test('the script compiles the helper only when asked, then empties the process and says what it held', () => {
  const first = trimScript(42, 'C:/x/working-set.dll', 'public static class KitWorkingSet {}');
  assert.match(first, /-OutputAssembly \$tmp -OutputType Library/);
  assert.match(first, /Move-Item -LiteralPath \$tmp -Destination 'C:\/x\/working-set\.dll'/, 'compiled to a name of its own, then moved into place');
  const again = trimScript(42, 'C:/x/working-set.dll', null);
  assert.doesNotMatch(again, /OutputAssembly/);
  assert.match(again, /^Add-Type -LiteralPath 'C:\/x\/working-set\.dll'/);
  assert.match(again, /Get-Process -Id 42 /);
  assert.match(again, /\[KitWorkingSet\]::Empty\(42\) \+ ' ' \+ \$held$/);
});

test('KIT_SERVER_TRIM=0, or a PC that isn\'t Windows: nothing is tried', async () => {
  assert.equal(await trimWorkingSet(process.pid, { KIT_SERVER_TRIM: '0' }), null);
  if (process.platform !== 'win32') assert.equal(await trimWorkingSet(process.pid, {}), null);
});

test('on Windows, a process holding 300 MB it no longer touches is trimmed to a few, and a gone one says so', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = await import('node:child_process');
  const { powershell, stopPowerShellWorker } = await import('./fixture/src/kit/ps.ts');
  const source = readFileSync(new URL('./fixture/src/kit/working-set.cs', import.meta.url), 'utf8');
  const dll = path.join(home, 'working-set-test.dll');
  // 300 MB written (every page touched) whenever it's told to, then only its first byte: a server's table after its model
  // loaded. Alive for longer than the calls can take; ended below.
  const child = spawn(process.execPath, ['-e', 'const b = Buffer.alloc(300 * 1048576, 1); process.stdin.on("data", () => { b.fill(2); process.stdout.write("held"); }); setInterval(() => b[0]++, 1000); setTimeout(() => {}, 900000)'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const workingSetMB = async (pid: number) => Number((await powershell(`[math]::Round((Get-Process -Id ${pid}).WorkingSet64 / 1MB)`, { timeoutMs: 120_000 })).trim());
  try {
    // First the compile, on its own and with time to spare: a minute and more at the checks pace, beside a whole run's
    // other tests (the 12:00 build of 2026-10-17 failed here twice). It's asked to empty a process that doesn't exist.
    assert.match((await powershell(trimScript(2_147_483_000, dll, source), { timeoutMs: 300_000 })).trim(), /^open \d+ -1$/, 'no such process: refused, and nothing held');
    // The 300 MB touched again just before the trim, so a busy PC's own trimming in the meantime can't have taken it.
    const touched = new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    child.stdin!.write('touch\n');
    await touched;
    const said = (await powershell(trimScript(child.pid!, dll, null), { timeoutMs: 120_000 })).trim();
    const held = /^trimmed (\d+)$/.exec(said);
    assert.ok(held && Number(held[1]) >= 250, `it should have held about 300 MB: ${said}`);
    // Read until it's down, for a few seconds: one reading can catch the process faulting its runtime back in.
    let afterMB = await workingSetMB(child.pid!);
    for (let i = 0; i < 10 && afterMB >= 100; i++) {
      await new Promise((r) => setTimeout(r, 500));
      afterMB = await workingSetMB(child.pid!);
    }
    assert.ok(afterMB < 100, `${afterMB} MB after the trim, from ${held![1]}`);
  } finally {
    child.kill();
    stopPowerShellWorker();
  }
});
