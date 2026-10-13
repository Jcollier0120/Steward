import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The checks pace (checks-pace.ts, kit 2.70.0): test runs, type checks, installs and builds held to a share of the processor.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-checks-pace-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { checksCap, checksPaceCap, checksPaceCompileScript, checksPaceExe, pacedCommand } = await import('./fixture/src/kit/checks-pace.ts');

const manorWith = (name: string, settings: unknown) => {
  const dir = path.join(home, name);
  mkdirSync(path.join(dir, 'app'), { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
};

test('the cap by default: half the processor, two processors at least', () => {
  assert.equal(checksCap(18), 5000, '18 processors: half (nine)');
  assert.equal(checksCap(8), 5000);
  assert.equal(checksCap(4), 5000, 'four: two of them');
  assert.equal(checksCap(3), 6667, 'three: two of them');
  assert.equal(checksCap(2), 10000, 'two: no cap at all');
  assert.equal(checksCap(1), 10000);
});

test("the cap now: KIT_CHECKS_PACE, else Manor's checksPace, else the default; full or 100 for none; none under node --test unless said", () => {
  const none = path.join(home, 'no-manor');
  assert.equal(checksPaceCap(none, {}, 18), 5000);
  assert.equal(checksPaceCap(manorWith('m-70', { checksPace: 70 }), {}, 18), 7000);
  assert.equal(checksPaceCap(manorWith('m-full', { checksPace: 'full' }), {}, 18), 0);
  assert.equal(checksPaceCap(manorWith('m-100', { checksPace: 100 }), {}, 18), 0, '100%: no cap');
  assert.equal(checksPaceCap(manorWith('m-low', { checksPace: 2 }), {}, 18), 1000, 'never under a tenth');
  assert.equal(checksPaceCap(manorWith('m-odd', { checksPace: 'lots' }), {}, 18), 5000, 'anything else: as if unsaid');
  assert.equal(checksPaceCap(manorWith('m-40', { checksPace: 40 }), { KIT_CHECKS_PACE: '60%' }, 18), 6000, 'the variable says instead of Manor');
  assert.equal(checksPaceCap(none, { KIT_CHECKS_PACE: 'full' }, 18), 0);
  assert.equal(checksPaceCap(manorWith('m-t', { checksPace: 70 }), { NODE_TEST_CONTEXT: 'child' }, 18), 0, "a test's commands aren't paced");
  assert.equal(checksPaceCap(none, { NODE_TEST_CONTEXT: 'child', KIT_CHECKS_PACE: '50' }, 18), 5000);
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

test('a command the person asked to be fast, or with the cap off, runs as it is', async () => {
  const plain = { file: 'node', args: ['a'], env: {} };
  assert.deepEqual(await pacedCommand('node', ['a'], { fast: true, env: { KIT_CHECKS_PACE: '50' } }), plain);
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
  assert.deepEqual(p.args, ['5000', process.execPath, 'x']);
  assert.equal(p.env.MSBUILDDISABLENODEREUSE, '1', ".NET's build servers don't stay behind in the job");
  const script = 'console.log(JSON.stringify([process.argv.slice(1), require("os").getPriority()])); console.error("e"); process.exit(7)';
  const args = ['a b', '"q"', '', 'C:\\x\\y z\\'];
  const r = await ran(p.file, ['5000', process.execPath, '-e', script, ...args]);
  assert.equal(r.code, 7);
  assert.equal(r.err.trim(), 'e');
  const [argv, priority] = JSON.parse(r.out);
  assert.deepEqual(argv, args);
  assert.equal(priority, os.constants.priority.PRIORITY_BELOW_NORMAL);
  const missing = await ran(p.file, ['5000', 'no-such-program-anywhere', '1']);
  assert.equal(missing.code, 127, 'a program that is not there: 127, as a shell says');
  assert.match(missing.err, /couldn't start no-such-program-anywhere/);
});
