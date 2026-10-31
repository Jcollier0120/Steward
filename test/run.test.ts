import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { batchFile, batchLine, dotnetWithSdk, errorLines, PACED_TIME, run, startOptions, stoppedForTime, timeLimit } from '../src/run.ts';

// A .NET employee's commands need a dotnet with an SDK: Task Scheduler's PATH finds Program Files' runtime first.
test('dotnetWithSdk: the first folder with dotnet.exe and an SDK, never a runtime alone', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'steward-dotnet-'));
  const runtime = path.join(root, 'runtime');
  const sdk = path.join(root, 'sdk10');
  for (const d of [runtime, sdk]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'dotnet.exe'), '');
  }
  mkdirSync(path.join(sdk, 'sdk', '10.0.100'), { recursive: true });
  assert.equal(dotnetWithSdk([undefined, runtime, sdk]), sdk);
  assert.equal(dotnetWithSdk([runtime, path.join(root, 'missing')]), null);
  rmSync(root, { recursive: true, force: true });
});

// Steward 0.36.14: a hidden git gets a console host of its own, a second process for every git; sharing the page's
// windowless console (kit/console.ts) it gets none.
test('startOptions: git and gh share a console the Steward has; without one, detached in the background; the rest hidden', () => {
  for (const cmd of ['git', 'gh']) {
    assert.deepEqual(startOptions(cmd, { shares: true, background: true }), { windowsHide: false, detached: false });
    assert.deepEqual(startOptions(cmd, { shares: true, background: false }), { windowsHide: false, detached: false });
    assert.deepEqual(startOptions(cmd, { shares: false, background: true }), { windowsHide: true, detached: true });
    assert.deepEqual(startOptions(cmd, { shares: false, background: false }), { windowsHide: true, detached: false });
  }
  for (const cmd of ['npm', 'node', 'dotnet', 'powershell'])
    for (const shares of [true, false]) assert.deepEqual(startOptions(cmd, { shares, background: true }), { windowsHide: true, detached: false }, cmd);
});

// Kit 2.74.2: a paced run's time limit stretched as much as the cap slows it, plus its wait for a turn. A fixed four
// times stopped Reeve's tests at 80 minutes on 2026-10-14, a third of the way through, with only "Command failed".
test("timeLimit: its own at full speed; at the checks pace stretched by the kit's slower, plus its wait for a turn", () => {
  const exe = 'C:\\kit\\checks-pace-1.exe';
  assert.equal(timeLimit(undefined, null, 'node'), 20 * 60_000);
  assert.equal(timeLimit(60_000, { file: 'node', args: [], env: {} }, 'node'), 60_000, 'cap off: as it is');
  assert.equal(timeLimit(20 * 60_000, { file: exe, args: [], env: {}, slower: 9, waitMs: 20 * 60_000 }, 'node'), 200 * 60_000, 'two of 18 processors: nine times, and 20 minutes for a turn');
  assert.equal(timeLimit(60_000, { file: exe, args: [], env: {} }, 'node'), PACED_TIME * 60_000, "a kit that doesn't say: four times");
});

test('a command stopped at its time limit says so, not "Command failed" and its whole command line', async () => {
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 1000 });
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'stopped after 1 s, its time limit: it was still running');
  assert.equal(stoppedForTime(200 * 60_000, true), 'stopped after 200 minutes, its time limit at the checks pace: it was still running');
});

test('batchFile: a .cmd or .bat named, or one found by its name alone in the folder or on PATH; never a program', () => {
  // As Windows' file system: any case.
  const files = new Set(['C:\\repo\\gradlew.bat', 'C:\\repo\\test.cmd', 'C:\\npm\\pnpm.cmd', 'C:\\npm\\pnpm', 'C:\\tools\\tea.exe', 'C:\\later\\tea.cmd', 'C:\\repo\\gh.exe'].map((f) => f.toLowerCase()));
  const there = (p: string) => files.has(p.toLowerCase());
  const env = { Path: 'C:\\npm;C:\\tools;C:\\later', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(batchFile('test.cmd', 'C:\\repo', env, there), 'C:\\repo\\test.cmd', "named, in the folder: by its path there, whether or not cmd looks in its folder");
  assert.equal(batchFile('Build.BAT', 'C:\\repo', env, there), 'Build.BAT', 'named, not in the folder: cmd finds it on PATH');
  assert.equal(batchFile('gradlew', 'C:\\repo', env, there), 'C:\\repo\\gradlew.BAT', 'in the folder it runs in first, as cmd looks');
  assert.equal(batchFile('pnpm', 'C:\\repo', env, there), 'C:\\npm\\pnpm.CMD', "npm's shim: its .cmd, not the sh script beside it");
  assert.equal(batchFile('tea', 'C:\\repo', env, there), null, 'a program first on PATH: as it is, though a .cmd is later');
  assert.equal(batchFile('gh', 'C:\\repo', env, there), null, 'a program in the folder: as it is');
  assert.equal(batchFile('missing', 'C:\\repo', env, there), null);
  assert.equal(batchFile('C:\\tools\\tea.exe', 'C:\\repo', env, there), null, 'a path to a program');
  assert.equal(batchFile('node', 'C:\\repo', {}, () => false), null);
  assert.deepEqual(batchLine('C:\\Program Files\\x\\run.cmd', ['a b', 'say "hi"', '--plain=1']), ['/d', '/s', '/c', '""C:\\Program Files\\x\\run.cmd" "a b" "say ""hi""" --plain=1"']);
});

test('a batch file a pipeline names runs, through cmd.exe, with its arguments and its exit code (found live: spawn EINVAL)', { skip: process.platform !== 'win32' && 'batch files are Windows only' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'steward-batch-'));
  try {
    writeFileSync(path.join(dir, 'test.cmd'), '@echo off\r\necho tested %1 %~2\r\nexit /b 3\r\n');
    writeFileSync(path.join(dir, 'hello.cmd'), '@echo off\r\necho hello, world\r\n');
    const named = await run('test.cmd', ['one', 'two words'], { cwd: dir });
    assert.deepEqual([named.code, named.out.trim()], [3, 'tested one two words']);
    const byName = await run('hello', [], { cwd: dir });
    assert.deepEqual([byName.code, byName.out.trim()], [0, 'hello, world'], 'by its name alone, as cmd would find it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed step's error lines: the first few that say what went wrong, each once however many files said it, never TAP's 'test failed'", () => {
  // Kit 2.76.0's trial on Reeve: forty-one test files that couldn't load, each saying so from its own path.
  const files = ['alerts', 'branches', 'cluster'].map((f) => [
    `# Subtest: test\\${f}.test.ts`,
    `# file:///E:/steward-work/reeve-trial/src/app.ts:14`,
    `# ReferenceError: Cannot access 'appRoot' before initialization`,
    `#     at file:///E:/steward-work/reeve-trial/test/${f}.test.ts:3:9`,
    `not ok 1 - test\\${f}.test.ts`,
    '  ---',
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...',
  ]);
  const tap = [
    ...files.flat(),
    'not ok 4 - the sum',
    '  ---',
    '  error: |-',
    '    Expected values to be strictly equal:',
    '',
    '    1 !== 2',
    "  error: '1 subtest failed'",
    '  ...',
    "src/x.ts(3,1): error TS2304: Cannot find name 'y'.",
  ].join('\r\n');
  assert.deepEqual(errorLines(tap), ["ReferenceError: Cannot access 'appRoot' before initialization", 'Expected values to be strictly equal:', "src/x.ts(3,1): error TS2304: Cannot find name 'y'."]);
  assert.deepEqual(errorLines(tap, 1), ["ReferenceError: Cannot access 'appRoot' before initialization"]);
  // The same error at another file and line is one; another error is another.
  assert.deepEqual(errorLines('Error [ERR_MODULE_NOT_FOUND]: Cannot find module C:\\a\\b.ts\nError [ERR_MODULE_NOT_FOUND]: Cannot find module C:\\a\\c.ts\nTypeError: x is not a function'), ['Error [ERR_MODULE_NOT_FOUND]: Cannot find module C:\\a\\b.ts', 'TypeError: x is not a function']);
  assert.deepEqual(errorLines('npm ERR! code 1\n> node --test\nall is well'), []);
  assert.equal(errorLines(`Error: ${'x'.repeat(400)}`)[0].length, 200);
});
