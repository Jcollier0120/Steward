import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DLL_INIT_FAILED, hasConsole, sharesConsole, startFailed } from '../node/console.ts';
import { powershell } from '../node/ps.ts';
import { freePort } from './free-port.ts';
import { paced, until } from './until.ts';

// kit 2.72.2: the page keeps a windowless console its git and gh share, instead of each getting a console host of its own.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'console-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
const ENV = String(pkg.name).toUpperCase().replace(/-/g, '_');
process.env[`${ENV}_HOME`] = path.join(tmp, 'own-home');
process.env[`${ENV}_PORT`] = String(await freePort());
// The pages it starts work in tmp and end on their own, after the test: on a busy PC one still had it (EBUSY), even after
// 5 s of tries at the checks pace. A folder left in the temp folder is no failure of the test: Windows clears it.
after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {}
});
const { pageLaunch } = await import('./fixture/src/kit/service.ts');

test('pageLaunch: on Windows through cmd start /b with a windowless console; elsewhere, or on a path cmd would read, detached as before', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const entry = 'C:\\Users\\a b\\.agent\\app\\src\\cli.ts';
  assert.deepEqual(pageLaunch(node, entry, { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' }), {
    file: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', `"start "" /b "${node}" "${entry}" serve"`],
    options: { windowsHide: true, windowsVerbatimArguments: true },
  });
  const detached = (n: string, e: string) => ({ file: n, args: [e, 'serve'], options: { windowsHide: true, detached: true } });
  assert.deepEqual(pageLaunch('/usr/bin/node', '/home/a/.agent/app/src/cli.ts', { platform: 'linux' }), detached('/usr/bin/node', '/home/a/.agent/app/src/cli.ts'));
  assert.deepEqual(pageLaunch(node, 'C:\\Users\\100%\\cli.ts', { platform: 'win32' }), detached(node, 'C:\\Users\\100%\\cli.ts'), '%NAME% would be expanded');
});

test('hasConsole and sharesConsole: false off Windows', { skip: process.platform === 'win32' }, () => {
  assert.equal(hasConsole(), false);
  assert.equal(sharesConsole(), false);
});

test('a page started as open starts it has a console of its own, and one started detached has none', { skip: process.platform !== 'win32' }, async () => {
  // The page: whether it has a console, and the arguments it was given, written to a file.
  const page = path.join(tmp, 'page.mjs');
  writeFileSync(
    page,
    `import { closeSync, openSync, writeFileSync } from 'node:fs';
let has = false;
try { closeSync(openSync('\\\\\\\\.\\\\CONOUT$', 'w')); has = true; } catch {}
writeFileSync(process.env.CONSOLE_TEST_OUT, JSON.stringify({ has, args: process.argv.slice(2), cwd: process.cwd() }));
`,
  );
  const started = async (how: ReturnType<typeof pageLaunch>, out: string) => {
    spawn(how.file, how.args, { ...how.options, stdio: 'ignore', cwd: tmp, env: { ...process.env, CONSOLE_TEST_OUT: out } }).unref();
    for (let i = 0; i < paced(100) && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < paced(20); i++) {
      try {
        return JSON.parse(readFileSync(out, 'utf8'));
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.fail(`the page wrote nothing to ${out}`);
  };
  const viaCmd = pageLaunch(process.execPath, page);
  assert.ok(viaCmd.options.windowsVerbatimArguments, 'through cmd on Windows');
  assert.deepEqual(await started(viaCmd, path.join(tmp, 'via-cmd.json')), { has: true, args: ['serve'], cwd: tmp });
  const detached = pageLaunch(process.execPath, page, { platform: 'linux' });
  assert.deepEqual(await started(detached, path.join(tmp, 'detached.json')), { has: false, args: ['serve'], cwd: tmp });
});

// kit 2.86.1: a console can go while its process runs on. On 2026-10-17 Manor's update ended its task, and Task Scheduler
// every console host in the task's job: the pages' git and PowerShell failed to start (0xC0000142) for 23 hours.
test("a page whose console's host has ended: sharesConsole says no from then on, and its git and the kit's PowerShell still start", { skip: process.platform !== 'win32' }, async () => {
  const kit = new URL('./fixture/src/kit/', import.meta.url).href;
  const ready = path.join(tmp, 'gone-ready.json');
  const go = path.join(tmp, 'gone-go');
  const out = path.join(tmp, 'gone.json');
  const page = path.join(tmp, 'gone-page.mjs');
  // The page: whether it shares its console, and how a program started as git is (cmd standing in for git) exits; then,
  // once told its console has gone, the same again, and the kit's PowerShell.
  writeFileSync(
    page,
    `import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const { sharesConsole } = await import(${JSON.stringify(kit + 'console.ts')});
const { powershell } = await import(${JSON.stringify(kit + 'ps.ts')});
const git = () => spawnSync('cmd.exe', ['/d', '/c', 'exit 0'], { windowsHide: !sharesConsole() }).status;
writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ shares: sharesConsole(), exit: git() }));
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 50));
const after = { shares: sharesConsole(), exit: git() };
try { after.ps = (await powershell('1 + 1')).trim(); } catch (e) { after.ps = e.message; }
writeFileSync(${JSON.stringify(out)}, JSON.stringify(after));
process.exit(0);
`,
  );
  const read = async (file: string) => {
    await until(() => existsSync(file), paced(20_000), file);
    for (let i = 0; ; i++) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        if (i > paced(50)) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  };
  // As open starts it: cmd's `start /b`, cmd with a windowless console whose host (conhost.exe) the page keeps.
  const how = pageLaunch(process.execPath, page);
  const cmd = spawn(how.file, how.args, { ...how.options, stdio: 'ignore', cwd: tmp });
  cmd.unref();
  assert.deepEqual(await read(ready), { shares: true, exit: 0 }, 'it shares the console cmd gave it');
  const hosts = (await powershell(`@(Get-CimInstance Win32_Process -Filter "Name='conhost.exe' AND ParentProcessId=${cmd.pid}").ProcessId -join ','`, { timeoutMs: paced(60_000) }))
    .trim()
    .split(',')
    .filter(Boolean)
    .map(Number);
  assert.equal(hosts.length, 1, "the console's host, started for cmd");
  // Its host ends, as Task Scheduler ends the processes in a task's job.
  process.kill(hosts[0]);
  writeFileSync(go, '');
  assert.deepEqual(await read(out), { shares: false, exit: 0, ps: '2' }, 'hidden from then on, each with a console of its own');
});

test('startFailed: a program started to share the console that exited 0xC0000142, on Windows; then the console has gone for good', () => {
  assert.equal(DLL_INIT_FAILED, 0xc0000142);
  assert.equal(startFailed(DLL_INIT_FAILED, true, 'win32'), false, 'started hidden: its console was its own');
  assert.equal(startFailed(1, false, 'win32'), false, 'it ran, and failed');
  assert.equal(startFailed(null, false, 'win32'), false);
  assert.equal(startFailed(DLL_INIT_FAILED, false, 'linux'), false);
  assert.equal(startFailed(DLL_INIT_FAILED, false, 'win32'), true);
  assert.equal(sharesConsole(), false, 'what starts next is hidden');
});
