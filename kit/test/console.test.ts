import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { hasConsole, sharesConsole } from '../node/console.ts';
import { freePort } from './free-port.ts';

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

test('hasConsole and sharesConsole: false off Windows, and asked once', { skip: process.platform === 'win32' }, () => {
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
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 20; i++) {
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
