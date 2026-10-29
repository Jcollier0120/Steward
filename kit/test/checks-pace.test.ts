import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { paced as testsPaced, until } from './until.ts';

// The checks pace (checks-pace.ts, kit 2.70.0): test runs, type checks, installs and builds held to a share of the processor.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-checks-pace-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { CHECKS_AT_ONCE, CHECKS_AT_ONCE_FULL, CHECKS_SLOWER_ENV, CHECKS_TURN_MS, checksAtOnce, checksCap, checksLimits, checksMemory, checksPaceCap, checksPaceCompileScript, checksPaceExe, checksSlower, paced, pacedCommand, pacedSlower, pacedTestConcurrency, TEST_FILE_MS, withTestConcurrency, withTestGuards } = await import('./fixture/src/kit/checks-pace.ts');
const { psPaced } = await import('./fixture/src/kit/ps.ts');
const { signedHelper } = await import('./fixture/src/kit/prebuilt.ts');
/** The launcher a paced command starts: the signed one the kit ships, or the one compiled here (kit 2.91.0). */
const launcher = () => signedHelper('checks-pace', readFileSync(new URL('./fixture/src/kit/checks-pace.cs', import.meta.url), 'utf8')) ?? checksPaceExe();
const { AGENTS_AT_ONCE, CEILING_CAP, CEILING_ENV, PACE_CEILING, ceilingCap } = await import('./fixture/src/kit/pace.ts');
// The launchers these tests run share a job of the test's own, never setting the PC's real check runs' job's limits.
process.env.KIT_CHECKS_JOB_NAME = `kit-test-checks-${process.pid}`;

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

test("the cap now: the manor's ceiling when Settings say full, else KIT_CHECKS_PACE, else Manor's checksPace, else the default; full or 100 for the ceiling, never past it; none under node --test unless said (kit 2.78.3)", () => {
  const none = path.join(home, 'no-manor');
  assert.equal(checksPaceCap(none, {}), 3333);
  assert.equal(checksPaceCap(manorWith('m-70', { checksPace: 70 }), {}), 7000);
  assert.equal(CEILING_CAP, 8500, '85% of the processor: the most the manor takes');
  assert.equal(CEILING_CAP, Math.round(PACE_CEILING * 10_000));
  assert.equal(checksPaceCap(manorWith('m-full', { checksPace: 'full' }), {}), 8500, 'full: the ceiling, not the whole PC');
  assert.equal(checksPaceCap(manorWith('m-100', { checksPace: 100 }), {}), 8500, '100%: the ceiling');
  assert.equal(checksPaceCap(manorWith('m-90', { checksPace: 90 }), {}), 8500, 'never past the ceiling');
  assert.equal(checksPaceCap(manorWith('m-85', { checksPace: '85%' }), {}), 8500);
  assert.equal(checksPaceCap(manorWith('m-low', { checksPace: 2 }), {}), 1000, 'never under a tenth');
  assert.equal(checksPaceCap(manorWith('m-odd', { checksPace: 'lots' }), {}), 3333, 'anything else: as if unsaid');
  assert.equal(checksPaceCap(manorWith('m-bg-full', { backgroundPace: 'full', checksPace: 40 }), {}), 8500, "Settings' pace at full raises it to the ceiling: the one switch");
  assert.equal(checksPaceCap(manorWith('m-bg-gentle', { backgroundPace: 'gentle', checksPace: 40 }), {}), 4000);
  assert.equal(checksPaceCap(manorWith('m-40', { checksPace: 40 }), { KIT_CHECKS_PACE: '60%' }), 6000, 'the variable says instead of Manor');
  assert.equal(checksPaceCap(none, { KIT_CHECKS_PACE: 'full' }), 8500);
  assert.equal(checksPaceCap(none, { KIT_CHECKS_PACE: '95%' }), 8500, 'the variable goes no higher either');
  assert.equal(checksPaceCap(manorWith('m-bg-full-env', { backgroundPace: 'full' }), { KIT_CHECKS_PACE: '50' }), 5000, 'the variable sets a lower cap at full');
  assert.equal(checksPaceCap(manorWith('m-t', { checksPace: 70 }), { NODE_TEST_CONTEXT: 'child' }), 0, "a test's commands aren't paced");
  assert.equal(checksPaceCap(none, { NODE_TEST_CONTEXT: 'child', KIT_CHECKS_PACE: '50' }), 5000);
  assert.equal(checksPaceCap(none, { NODE_TEST_CONTEXT: 'child', KIT_CHECKS_PACE: 'full' }), 0, "a test's commands at full: unpaced, as before");
});

test('turns at full (kit 2.78.3): as many check runs at once as agents at full, the cap held for all of them together', () => {
  assert.equal(CHECKS_AT_ONCE_FULL, AGENTS_AT_ONCE.most);
  assert.ok(CHECKS_AT_ONCE_FULL > CHECKS_AT_ONCE);
  assert.equal(checksAtOnce(path.join(home, 'no-manor')), CHECKS_AT_ONCE);
  assert.equal(checksAtOnce(manorWith('t-gentle', { backgroundPace: 'gentle' })), CHECKS_AT_ONCE);
  assert.equal(checksAtOnce(manorWith('t-full', { backgroundPace: 'full' })), CHECKS_AT_ONCE_FULL);
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
  assert.equal(pacedTestConcurrency(8500, 18), 18, 'the ceiling, at full: one file per processor, no more');
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

test("a test run's guards (kit 2.93.3): each file ended once its tests are done, and stopped past its own limit; only node's own --test, and what it says itself stays", () => {
  const node = process.execPath;
  assert.equal(TEST_FILE_MS, 150_000);
  assert.deepEqual(withTestGuards(node, ['--import=./x.ts', '--test', '--test-concurrency=4', 'a.test.ts'], 600_000), ['--import=./x.ts', '--test', '--test-force-exit', '--test-timeout=600000', '--test-concurrency=4', 'a.test.ts']);
  assert.deepEqual(withTestGuards('node', ['--test'], 1500.4), ['--test', '--test-force-exit', '--test-timeout=1500']);
  assert.deepEqual(withTestGuards(node, ['--test', '--test-timeout=5000', 'a'], 600_000), ['--test', '--test-force-exit', '--test-timeout=5000', 'a'], 'its own limit');
  assert.deepEqual(withTestGuards(node, ['--test-force-exit', '--test', 'a'], 600_000), ['--test-force-exit', '--test', '--test-timeout=600000', 'a'], 'its own force-exit, before --test');
  assert.deepEqual(withTestGuards(node, ['script.js', '--test'], 600_000), ['script.js', '--test'], "a script's own --test");
  assert.deepEqual(withTestGuards(node, ['-e', '0'], 600_000), ['-e', '0'], 'no --test');
  assert.deepEqual(withTestGuards('npm', ['test'], 600_000), ['test'], "an npm script's node isn't seen");
});


test("a test's own waits at the pace (kit 2.74.6): stretched as much as its run's time limit, as the paced command says; as they are unpaced", () => {
  assert.equal(CHECKS_SLOWER_ENV, 'KIT_CHECKS_SLOWER');
  assert.equal(checksSlower({ KIT_CHECKS_SLOWER: '4' }), 4);
  assert.equal(checksSlower({ KIT_CHECKS_SLOWER: '9' }), 9);
  assert.equal(checksSlower({}), 1, 'unpaced: its own time');
  assert.equal(checksSlower({ KIT_CHECKS_SLOWER: 'x' }), 1);
  assert.equal(checksSlower({ KIT_CHECKS_SLOWER: '0.5' }), 1, 'never quicker');
  assert.equal(checksSlower({ KIT_CHECKS_SLOWER: '1000' }), 50, 'never past fifty');
  assert.equal(paced(400, { KIT_CHECKS_SLOWER: '4' }), 1600);
  assert.equal(paced(400, {}), 400);
  // The tests' own helper reads the same variable the same way, without loading the kit.
  for (const said of [undefined, '4', '9', '0.5', 'x', '1000']) {
    const env = said === undefined ? {} : { KIT_CHECKS_SLOWER: said };
    assert.equal(testsPaced(400, env), paced(400, env), `KIT_CHECKS_SLOWER=${said}`);
    // And PowerShell's time limits (ps.ts, which checks-pace.ts runs, so it can't load it): the keeper's 30 s query and
    // psQuote's 60 s scripts timed out at the pace on 2026-10-15, as powershell.exe started inside its job.
    assert.equal(psPaced(30_000, env), paced(30_000, env), `ps.ts, KIT_CHECKS_SLOWER=${said}`);
  }
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

test('a command with the cap off (only under node --test, unless KIT_CHECKS_PACE says a percentage under 100) runs as it is', async () => {
  const plain = { file: 'node', args: ['a'], env: {} };
  assert.deepEqual(await pacedCommand('node', ['a'], { env: { NODE_TEST_CONTEXT: 'child', KIT_CHECKS_PACE: 'full' } }), plain);
  assert.deepEqual(await pacedCommand('node', ['a'], { env: { NODE_TEST_CONTEXT: 'child' } }), plain);
});

const ran = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) =>
    execFile(file, args, { env, windowsHide: true, encoding: 'utf8' }, (e: any, out, err) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out, err })),
  );

test("a test run with its guards, as node runs it: a file that left a timer an hour long ends with its tests, one that never settles is failed at its limit, the others run on", { timeout: paced(120_000) }, async () => {
  const dir = path.join(home, 'guarded');
  mkdirSync(dir, { recursive: true });
  const file = (name: string, body: string) => {
    writeFileSync(path.join(dir, name), `import { test } from 'node:test';\n${body}\n`);
    return path.join(dir, name);
  };
  // As the Reckoner's test left its schedule on 2026-10-21: its tests done, its next round an hour away.
  const left = file('left.test.mjs', "test('done, an hour-long timer left', () => { setTimeout(() => {}, 3_600_000); });");
  const stuck = file('stuck.test.mjs', "test('never settles', () => new Promise(() => setInterval(() => {}, 1000)));");
  const fine = file('fine.test.mjs', "test('fine', () => {});");
  // Its own run, not this file's: node --test inside a test file's process is told it is a child of the runner.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const started = Date.now();
  const r = await ran(process.execPath, withTestGuards(process.execPath, ['--test', '--test-reporter=tap', left, stuck, fine], paced(3_000)), env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^ok \d+ - done, an hour-long timer left$/m);
  assert.match(r.out, /^ok \d+ - fine$/m);
  assert.match(r.out, /^not ok \d+ - .*stuck\.test\.mjs$/m, 'the file that never settles, failed under its name');
  assert.match(r.out, /test timed out after \d+ms/);
  assert.match(r.out, /^# pass 2$/m);
  assert.ok(Date.now() - started < paced(60_000), `ended in ${Date.now() - started} ms, not at the hour-long timer`);
});

test('on Windows, a paced command: through the launcher, its arguments and output as they were, its exit code, below-normal priority', { skip: process.platform !== 'win32' }, async () => {
  const logged: string[] = [];
  const p = await pacedCommand(process.execPath, ['x'], { env: { KIT_CHECKS_PACE: '50' }, home: path.join(home, 'no-manor'), log: (l) => logged.push(l) });
  assert.deepEqual(logged, [], 'the launcher was built');
  assert.equal(p.file, launcher());
  assert.deepEqual(p.args, [checksLimits(5000), process.execPath, 'x']);
  assert.deepEqual([p.slower, p.waitMs], [4, CHECKS_TURN_MS], 'half the processor: four times its time, and the wait for a turn');
  assert.equal(p.env.MSBUILDDISABLENODEREUSE, '1', ".NET's build servers don't stay behind in the job");
  assert.equal(p.env.KIT_CHECKS_SLOWER, '4', 'told how much slower it runs, for its own waits');
  assert.equal(p.env[CEILING_ENV], String(CEILING_CAP), "the launcher is given the manor's ceiling (kit 2.78.7)");
  const tests = await pacedCommand(process.execPath, ['--test', 'a.test.ts'], { env: { KIT_CHECKS_PACE: '25' }, home: path.join(home, 'no-manor'), processors: 16 });
  assert.deepEqual(tests.args, [checksLimits(2500), process.execPath, '--test', '--test-force-exit', '--test-timeout=600000', '--test-concurrency=8', 'a.test.ts'], 'a test run: as many files at once as the cap has room for, each ended with its tests and stopped at two and a half minutes stretched four times');
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
  await until(() => readFileSync(log, 'utf8').includes('up'), 10_000, 'its output in the file');
  assert.equal(readFileSync(log, 'utf8').trim(), 'up a b', 'its arguments as they were, its output in the file');
  process.kill(pid);
});

test("on Windows, a program started apart outlives a starter in a gentle job, where one merely detached ends with it (an update's probation watcher, kit 2.144.2)", { skip: process.platform !== 'win32' }, async () => {
  const { alive } = await import('./fixture/src/kit/apart.ts');
  // As Manor's install: at the gentle pace (its own job, its PowerShell worker in it), it starts one program detached
  // and one apart, as the probation watcher was and is, and ends.
  const starter = path.join(home, 'starter.mjs');
  writeFileSync(
    starter,
    `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [gentle, apart, out] = process.argv.slice(2);
await (await import(gentle)).containSelf('gentle');
const stay = ['-e', 'setTimeout(() => {}, 120000)'];
const detached = spawn(process.execPath, stay, { detached: true, stdio: 'ignore', windowsHide: true });
detached.unref();
const apartPid = await (await import(apart)).startApart(process.execPath, stay, { cap: 0 });
writeFileSync(out, JSON.stringify({ detached: detached.pid, apart: apartPid }));
`,
  );
  const out = path.join(home, 'started.json');
  const env: NodeJS.ProcessEnv = { ...process.env, KIT_APART: '1' };
  delete env.KIT_GENTLE;
  const code = await new Promise<number | null>((resolve) =>
    execFile(process.execPath, [starter, new URL('./fixture/src/kit/gentle.ts', import.meta.url).href, new URL('./fixture/src/kit/apart.ts', import.meta.url).href, out], { env, windowsHide: true }, (e) => resolve(e ? ((e as { code?: number }).code ?? 1) : 0)),
  );
  assert.equal(code, 0, 'the starter ran');
  const started = JSON.parse(readFileSync(out, 'utf8')) as { detached: number; apart: number | null };
  try {
    assert.ok(started.apart && started.apart > 0, 'started apart');
    await until(() => !alive(started.detached), testsPaced(15_000), 'the one merely detached ends with its starter');
    assert.ok(alive(started.apart), 'the one apart runs on');
  } finally {
    for (const pid of [started.detached, started.apart]) if (pid && alive(pid)) process.kill(pid);
  }
});

test("the servers' cap (kit 2.78.3): the manor's ceiling, whatever the pace; none under node --test unless KIT_APART_CAP says", async () => {
  const { apartCap } = await import('./fixture/src/kit/apart.ts');
  assert.equal(apartCap({}), CEILING_CAP);
  assert.equal(apartCap({ NODE_TEST_CONTEXT: 'child' }), 0, "a test's servers: no job, as before");
  assert.equal(apartCap({ NODE_TEST_CONTEXT: 'child', KIT_APART_CAP: '1000' }), 1000);
  assert.equal(apartCap({ NODE_TEST_CONTEXT: 'child', KIT_APART_CAP: '9900' }), CEILING_CAP, 'never past the ceiling');
});

test("on Windows, programs started apart share one capped job: together, they stay within its cap, after the launcher has gone", { skip: process.platform !== 'win32' }, async () => {
  const { startApart } = await import('./fixture/src/kit/apart.ts');
  // Each keeps every processor busy for 3 s, then writes the processor time it had against the PC's in that time.
  const burn = [
    'const { Worker } = require("worker_threads"); const os = require("os"); const t0 = Date.now(); const n = os.availableParallelism();',
    'const spin = "const end = Date.now() + 3000; let x = 0; while (Date.now() < end) x = (x * 31 + 7) % 1000003;";',
    'let left = n; for (let i = 0; i < n; i++) new Worker(spin, { eval: true }).on("exit", () => { if (--left) return;',
    '  const u = process.cpuUsage(); require("fs").writeFileSync(process.argv[1], String((u.user + u.system) / ((Date.now() - t0) * 1000 * n))); });',
  ].join(' ');
  const said = { KIT_APART: process.env.KIT_APART, KIT_APART_CAP: process.env.KIT_APART_CAP, KIT_APART_JOB_NAME: process.env.KIT_APART_JOB_NAME };
  Object.assign(process.env, { KIT_APART: '1', KIT_APART_CAP: '1000', KIT_APART_JOB_NAME: `kit-test-apart-${process.pid}` });
  const files = [path.join(home, 'burn-a.txt'), path.join(home, 'burn-b.txt')];
  try {
    const pids = await Promise.all(files.map((f) => startApart(process.execPath, ['-e', burn, f])));
    assert.ok(pids.every((p) => p && p > 0), 'both started');
  } finally {
    for (const [k, v] of Object.entries(said)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await until(() => files.every((f) => existsSync(f) && readFileSync(f, 'utf8')), 60_000, 'both to have burned their 3 s');
  const shares = files.map((f) => Number(readFileSync(f, 'utf8')));
  // A tenth of the PC for the two together (each a job of its own would let them take a tenth each); a busy PC can only
  // give them less.
  assert.ok(shares[0] + shares[1] <= 0.14, `together ${(100 * (shares[0] + shares[1])).toFixed(1)}% of the processor, not past the job's 10%`);
});

test("the manor's ceiling (kit 2.78.7): one cap for every family together, and under node --test only a test's own", () => {
  assert.equal(CEILING_ENV, 'KIT_CEILING');
  assert.equal(ceilingCap({}), CEILING_CAP);
  assert.equal(ceilingCap({ NODE_TEST_CONTEXT: 'child' }), 0, "a test's programs: no ceiling, as before");
  assert.equal(ceilingCap({ NODE_TEST_CONTEXT: 'child', KIT_CEILING_CAP: '1000' }), 0, "never the PC's own ceiling at a test's cap");
  assert.equal(ceilingCap({ NODE_TEST_CONTEXT: 'child', KIT_CEILING_CAP: '1000', KIT_CEILING_JOB_NAME: 'kit-test-ceiling' }), 1000);
  assert.equal(ceilingCap({ NODE_TEST_CONTEXT: 'child', KIT_CEILING_CAP: '9900', KIT_CEILING_JOB_NAME: 'kit-test-ceiling' }), CEILING_CAP, 'never past it');
});

test("on Windows, a check run and a server started apart, each in its own family's job, stay within the manor's ceiling together (kit 2.78.7)", { skip: process.platform !== 'win32' }, async () => {
  const { startApart } = await import('./fixture/src/kit/apart.ts');
  const p = await pacedCommand(process.execPath, ['x'], { env: { KIT_CHECKS_PACE: '50' }, home: path.join(home, 'no-manor') });
  // Each says it's ready, waits for the go, then keeps every processor busy for 3 s and writes the processor time it had
  // against the PC's in that time: so the two burn at once.
  const burn = [
    'const fs = require("fs"); const { Worker } = require("worker_threads"); const n = require("os").availableParallelism(); const [out, go] = process.argv.slice(1);',
    'fs.writeFileSync(out + ".ready", ""); const wait = setInterval(() => { if (!fs.existsSync(go)) return; clearInterval(wait); const t0 = Date.now();',
    'const spin = "const end = Date.now() + 3000; let x = 0; while (Date.now() < end) x = (x * 31 + 7) % 1000003;";',
    'let left = n; for (let i = 0; i < n; i++) new Worker(spin, { eval: true }).on("exit", () => { if (--left) return;',
    '  const u = process.cpuUsage(); fs.writeFileSync(out, String((u.user + u.system) / ((Date.now() - t0) * 1000 * n))); }); }, 20);',
  ].join(' ');
  const go = path.join(home, 'ceiling-go');
  const files = [path.join(home, 'ceiling-check.txt'), path.join(home, 'ceiling-server.txt')];
  // The check run's job and the servers' each at 10%, under a ceiling of 10%: apart, they'd take 20% together.
  const keys = ['KIT_APART', 'KIT_APART_CAP', 'KIT_APART_JOB_NAME', 'KIT_CEILING_CAP', 'KIT_CEILING_JOB_NAME'] as const;
  const said = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { KIT_APART: '1', KIT_APART_CAP: '1000', KIT_APART_JOB_NAME: `kit-test-ceiling-apart-${process.pid}`, KIT_CEILING_CAP: '1000', KIT_CEILING_JOB_NAME: `kit-test-ceiling-${process.pid}` });
  let check: ReturnType<typeof ran>;
  try {
    check = ran(p.file, [checksLimits(1000, checksMemory(), 0), process.execPath, '-e', burn, files[0], go], { ...process.env, [CEILING_ENV]: String(ceilingCap()) });
    const pid = await startApart(process.execPath, ['-e', burn, files[1], go]);
    assert.ok(pid && pid > 0, 'the server started');
  } finally {
    for (const [k, v] of Object.entries(said)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await until(() => files.every((f) => existsSync(`${f}.ready`)), testsPaced(60_000), 'both to be ready');
  writeFileSync(go, '');
  const r = await check;
  assert.equal(r.code, 0, r.err);
  await until(() => files.every((f) => existsSync(f) && readFileSync(f, 'utf8')), testsPaced(60_000), 'both to have burned their 3 s');
  const shares = files.map((f) => Number(readFileSync(f, 'utf8')));
  assert.ok(shares[0] + shares[1] <= 0.14, `together ${(100 * (shares[0] + shares[1])).toFixed(1)}% of the processor, not past the ceiling's 10%`);
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
