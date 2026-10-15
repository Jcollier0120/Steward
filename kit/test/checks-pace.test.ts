import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The checks pace (checks-pace.ts, kit 2.70.0): test runs, type checks, installs and builds held to a share of the processor.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-checks-pace-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { CHECKS_AT_ONCE, CHECKS_TURN_MS, checksCap, checksLimits, checksMemory, checksPaceCap, checksPaceCompileScript, checksPaceExe, pacedCommand, pacedSlower, pacedTestConcurrency, withTestConcurrency } = await import('./fixture/src/kit/checks-pace.ts');

const manorWith = (name: string, settings: unknown) => {
  const dir = path.join(home, name);
  mkdirSync(path.join(dir, 'app'), { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
};

test('the cap by default (kit 2.74.2): a third of the processor, however many processors it has', () => {
  assert.equal(checksCap(), 3333);
});

test("the memory a run may take: each program an eighth of the PC's, 2 to 6 GB; the job a quarter, 4 to 12 GB", () => {
  const gb = 1024 ** 3;
  assert.deepEqual(checksMemory(48 * gb), { processMb: 6144, jobMb: 12288 });
  assert.deepEqual(checksMemory(32 * gb), { processMb: 4096, jobMb: 8192 });
  assert.deepEqual(checksMemory(8 * gb), { processMb: 2048, jobMb: 4096 }, 'a small PC: the floors');
  assert.deepEqual(checksMemory(128 * gb), { processMb: 6144, jobMb: 12288 }, 'a big one: the ceilings');
});

test("the launcher's first word: the cap, memory per program and for the job, runs at once", () => {
  assert.equal(CHECKS_AT_ONCE, 3);
  assert.equal(checksLimits(3333, { processMb: 6144, jobMb: 12288 }), '3333,6144,12288,3');
  assert.equal(checksLimits(5000, { processMb: 1, jobMb: 2 }, 0), '5000,1,2,0');
});

test("the cap now: none when Settings say full, else KIT_CHECKS_PACE, else Manor's checksPace, else the default; full or 100 for none; none under node --test unless said", () => {
  const none = path.join(home, 'no-manor');
  assert.equal(checksPaceCap(none, {}), 3333);
  assert.equal(checksPaceCap(manorWith('m-70', { checksPace: 70 }), {}), 7000);
  assert.equal(checksPaceCap(manorWith('m-full', { checksPace: 'full' }), {}), 0);
  assert.equal(checksPaceCap(manorWith('m-100', { checksPace: 100 }), {}), 0, '100%: no cap');
  assert.equal(checksPaceCap(manorWith('m-low', { checksPace: 2 }), {}), 1000, 'never under a tenth');
  assert.equal(checksPaceCap(manorWith('m-odd', { checksPace: 'lots' }), {}), 3333, 'anything else: as if unsaid');
  assert.equal(checksPaceCap(manorWith('m-bg-full', { backgroundPace: 'full', checksPace: 40 }), {}), 0, "Settings' pace at full lifts it: the one switch");
  assert.equal(checksPaceCap(manorWith('m-bg-gentle', { backgroundPace: 'gentle', checksPace: 40 }), {}), 4000);
  assert.equal(checksPaceCap(manorWith('m-40', { checksPace: 40 }), { KIT_CHECKS_PACE: '60%' }), 6000, 'the variable says instead of Manor');
  assert.equal(checksPaceCap(none, { KIT_CHECKS_PACE: 'full' }), 0);
  assert.equal(checksPaceCap(manorWith('m-t', { checksPace: 70 }), { NODE_TEST_CONTEXT: 'child' }), 0, "a test's commands aren't paced");
  assert.equal(checksPaceCap(none, { NODE_TEST_CONTEXT: 'child', KIT_CHECKS_PACE: '50' }), 5000);
});

test('room to finish at the pace (kit 2.74.2): a time limit stretched as the cap slows the work, and as many test files at once as it has room for', () => {
  assert.equal(pacedSlower(1111), 9, 'two of 18 processors: nine times');
  assert.equal(pacedSlower(2500), 4, 'a quarter: four, as it always was');
  assert.equal(pacedSlower(3333), 4, 'a third, the default: four');
  assert.equal(pacedSlower(5000), 4, 'never under four');
  assert.equal(pacedSlower(0), 1, 'no cap: its own time');
  assert.equal(pacedTestConcurrency(1111, 18), 4, "two of 18 processors' worth: four files at once, not 17");
  assert.equal(pacedTestConcurrency(3333, 18), 12, 'a third of 18 processors, the default: twelve');
  assert.equal(pacedTestConcurrency(2500, 4), 2, 'one processor: two at least');
  assert.equal(pacedTestConcurrency(5000, 16), 16);
  const node = process.execPath;
  assert.deepEqual(withTestConcurrency(node, ['--import=./x.ts', '--test', 'a.test.ts'], 4), ['--import=./x.ts', '--test', '--test-concurrency=4', 'a.test.ts']);
  assert.deepEqual(withTestConcurrency('node', ['--test'], 2), ['--test', '--test-concurrency=2']);
  assert.deepEqual(withTestConcurrency(node, ['--test', '--test-concurrency=8', 'a'], 4), ['--test', '--test-concurrency=8', 'a'], 'its own says');
  assert.deepEqual(withTestConcurrency(node, ['script.js', '--test'], 4), ['script.js', '--test'], "a script's own --test");
  assert.deepEqual(withTestConcurrency(node, ['--import', 'x.ts', '--test'], 4), ['--import', 'x.ts', '--test'], "an option's value apart: left as it is");
  assert.deepEqual(withTestConcurrency(node, ['-e', '0'], 4), ['-e', '0'], 'no --test');
  assert.deepEqual(withTestConcurrency('npm', ['test'], 4), ['test'], "an npm script's node isn't seen");
  assert.deepEqual(withTestConcurrency('C:\\x\\vitest.cmd', ['--test'], 4), ['--test'], 'not node');
});

test('the launcher: one for the PC, beside the gentle DLL, a new one for a new source; compiled to a name of its own', () => {
  assert.match(path.basename(checksPaceExe('a')), /^checks-pace-[0-9a-f]{12}\.exe$/);
  assert.equal(path.basename(path.dirname(checksPaceExe('a'))), 'kit');
  assert.notEqual(checksPaceExe('a'), checksPaceExe('b'), 'a new launcher never overwrites one a check is running');
  const script = checksPaceCompileScript("C:/o'k/checks-pace-1.exe", "class A { // can't }");
  assert.match(script, /Add-Type -TypeDefinition 'class A \{ \/\/ can''t \}' -OutputAssembly \$tmp -OutputType ConsoleApplication/);
  assert.ok(script.includes("'C:/o''k/checks-pace-1.exe'"), 'paths quoted');
  assert.ok(script.includes("'C:/o''k/checks-pace-1' + '.'"), 'built beside it, then moved into place');
});

test("a command with the cap off (Manor's checksPace full: the only way out) runs as it is", async () => {
  const plain = { file: 'node', args: ['a'], env: {} };
  assert.deepEqual(await pacedCommand('node', ['a'], { env: { KIT_CHECKS_PACE: 'full' } }), plain);
  assert.deepEqual(await pacedCommand('node', ['a'], { env: { NODE_TEST_CONTEXT: 'child' } }), plain);
});

const ran = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) =>
    execFile(file, args, { env, windowsHide: true, encoding: 'utf8' }, (e: any, out, err) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out, err })),
  );

test('on Windows, a paced command: through the launcher, its arguments and output as they were, its exit code, below-normal priority', { skip: process.platform !== 'win32' }, async () => {
  const logged: string[] = [];
  const p = await pacedCommand(process.execPath, ['x'], { env: { KIT_CHECKS_PACE: '50' }, home: path.join(home, 'no-manor'), log: (l) => logged.push(l) });
  assert.deepEqual(logged, [], 'the launcher was built');
  assert.equal(p.file, checksPaceExe());
  assert.deepEqual(p.args, [checksLimits(5000), process.execPath, 'x']);
  assert.deepEqual([p.slower, p.waitMs], [4, CHECKS_TURN_MS], 'half the processor: four times its time, and the wait for a turn');
  assert.equal(p.env.MSBUILDDISABLENODEREUSE, '1', ".NET's build servers don't stay behind in the job");
  const tests = await pacedCommand(process.execPath, ['--test', 'a.test.ts'], { env: { KIT_CHECKS_PACE: '25' }, home: path.join(home, 'no-manor'), processors: 16 });
  assert.deepEqual(tests.args, [checksLimits(2500), process.execPath, '--test', '--test-concurrency=8', 'a.test.ts'], 'a test run: as many files at once as the cap has room for');
  const script = 'console.log(JSON.stringify([process.argv.slice(1), require("os").getPriority()])); console.error("e"); process.exit(7)';
  const args = ['a b', '"q"', '', 'C:\\x\\y z\\'];
  const noTurn = checksLimits(5000, checksMemory(), 0);
  const r = await ran(p.file, [noTurn, process.execPath, '-e', script, ...args]);
  assert.equal(r.code, 7);
  assert.equal(r.err.trim(), 'e');
  const [argv, priority] = JSON.parse(r.out);
  assert.deepEqual(argv, args);
  assert.equal(priority, os.constants.priority.PRIORITY_BELOW_NORMAL);
  const missing = await ran(p.file, [noTurn, 'no-such-program-anywhere', '1']);
  assert.equal(missing.code, 127, 'a program that is not there: 127, as a shell says');
  assert.match(missing.err, /couldn't start no-such-program-anywhere/);
  const bad = await ran(p.file, ['lots', process.execPath, '-e', '0']);
  assert.equal(bad.code, 2, "limits it can't read: 2, nothing run");
});

test('on Windows, a program started apart (a model server): detached, its output to the file given, its process id answered', { skip: process.platform !== 'win32' }, async () => {
  process.env.KIT_APART = '1';
  const { startApart, alive } = await import('./fixture/src/kit/apart.ts');
  const log = path.join(home, 'apart.log');
  const fd = openSync(log, 'a');
  let pid: number | null = null;
  try {
    pid = await startApart(process.execPath, ['-e', 'console.log("up " + process.argv[1]); setTimeout(() => {}, 20000)', 'a b'], { out: fd });
  } finally {
    closeSync(fd);
    delete process.env.KIT_APART;
  }
  assert.ok(pid && pid > 0, 'its process id');
  assert.ok(alive(pid), 'running after the launcher has gone');
  for (let i = 0; i < 100 && !readFileSync(log, 'utf8').includes('up'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readFileSync(log, 'utf8').trim(), 'up a b', 'its arguments as they were, its output in the file');
  process.kill(pid);
});

test('on Windows, a paced run takes a turn, and the runs it starts take none (they would wait on their own)', { skip: process.platform !== 'win32' }, async () => {
  const p = await pacedCommand(process.execPath, ['x'], { env: { KIT_CHECKS_PACE: '50' }, home: path.join(home, 'no-manor') });
  const env: NodeJS.ProcessEnv = { ...process.env, KIT_CHECKS_TURN_NAME: `kit-test-turn-${process.pid}` };
  delete env.KIT_CHECKS_TURN;
  const turn = checksLimits(5000, checksMemory(), 1);
  const inner = 'console.log(process.env.KIT_CHECKS_TURN)';
  const nested = `const r = require("child_process").spawnSync(${JSON.stringify(p.file)}, [${JSON.stringify(turn)}, process.execPath, "-e", ${JSON.stringify(inner)}], { encoding: "utf8", timeout: 60000 }); console.log(r.status, r.stdout.trim())`;
  const r = await ran(p.file, [turn, process.execPath, '-e', nested], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), '0 1', "the nested run ran at once, inside the outer run's turn");
});
