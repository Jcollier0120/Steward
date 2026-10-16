import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The whole suite before a kit's release (stages/wholesuite.ts), and the whole passes kept by tree (whole.ts): from a
// fake Steward repository whose scripts only note what ran, its tests failing while a flag file is there. Nothing reaches
// GitHub, the live ~/.steward or the real checkout.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-whole-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { releaseSelf, loadSelfFailures } = await import('../src/stages/self.ts');
const { endWholeOrphans, endWholeSuite, loadWholeJob, wholeJobFile, wholeSuiteBefore, wholeSuiteDone, wholeSuitesBeside } = await import('../src/stages/wholesuite.ts');
const { stewardEmployee } = await import('../src/stages/selfmerge.ts');
const { apart } = await import('../src/stages/slots.ts');
const { keepWhole, ranWhole, wholePassOf } = await import('../src/whole.ts');
const { alive } = await import('../src/kit/apart.ts');
const { ctxFor, runner, sh } = await import('./helpers.ts');
const { runChecks } = await import('../src/stages/bump.ts');
const { resultFor } = await import('../src/kit/work-status.ts');
const { workTasks } = await import('../src/kit/work-tasks.ts');
const { until } = await import('../kit/test/until.ts');
const { freePort } = await import('../kit/test/free-port.ts');
type WholeJob = import('../src/stages/wholesuite.ts').WholeJob;
type StoodIn = import('../src/stages/standin.ts').StoodIn;

const dir = path.join(home, 'steward');
const origin = path.join(dir, 'origin.git');
const checkout = path.join(dir, 'Steward');
const ran = path.join(home, 'ran.txt');
const failTests = path.join(home, 'fail-tests');
const URL = 'https://github.com/Jcollier0120/Steward.git';
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
sh(dir, 'init', '--quiet', '-b', 'main', checkout);
for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false', [`url.${origin.replace(/\\/g, '/')}.insteadOf`]: URL })) sh(checkout, 'config', k, v);
sh(checkout, 'remote', 'add', 'origin', URL);
const note = (what: string, fail?: string) =>
  `const fs = require('fs');\nfs.appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(what)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n${fail ? `if (fs.existsSync(${JSON.stringify(fail)})) process.exit(1);\n` : ''}`;
const scripts = { kit: 'node tools/kit.ts --from kit', typecheck: 'node tools/typecheck.js', test: 'node tools/test.js', release: 'node tools/release.js' };
const files: Record<string, string> = {
  '.gitignore': 'node_modules/\nartifacts/\nsrc/kit/\n',
  'kit/VERSION': '1.1.0\n',
  'package.json': JSON.stringify({ name: 'steward', version: '0.9.0', type: 'commonjs', scripts }, null, 2),
  'tools/kit.ts': note('fill'),
  'tools/kit-release.ts': note('kit-release'),
  'tools/release.js': note('release'),
  'tools/typecheck.js': note('typecheck'),
  'tools/test.js': note('test', failTests),
};
for (const [f, t] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
  writeFileSync(path.join(checkout, f), t);
}
sh(checkout, 'add', '-A');
sh(checkout, 'commit', '--quiet', '-m', 'Steward 0.9.0, kit 1.1.0');
sh(checkout, 'push', '--quiet', 'origin', 'main');
const head = () => sh(origin, 'rev-parse', 'main');
const commit = (file: string, text: string) => {
  writeFileSync(path.join(checkout, file), text);
  sh(checkout, 'add', file);
  sh(checkout, 'commit', '--quiet', '-m', file);
  sh(checkout, 'push', '--quiet', 'origin', 'main');
};

const r = runner();
const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home });
const lines = () => (existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n').map((l) => l.trim()) : []);
const facts = (tags: string[]) => ({ checkout, main: { head: head(), kit: '1.1.0', version: '0.9.0' }, tags });
const tree = () => sh(checkout, 'rev-parse', 'HEAD^{tree}');

test("a kit is released once the Steward's whole suite has passed at its commit; the same code isn't run whole again", async () => {
  const out = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(out.map((x) => x.outcome), ['done', 'done'], out.map((x) => x.message).join('\n'));
  assert.deepEqual(lines(), ['fill --from kit', 'typecheck', 'test', 'fill --from kit', 'kit-release --publish', 'release --publish'], 'its checks, as a person runs them before a PR, then the releases');
  assert.ok(!existsSync(path.join(home, 'work', '_steward-whole')), 'its worktree removed');
  assert.equal(wholePassOf(tree())?.commit, head(), 'kept by tree');

  unlinkSync(ran);
  assert.equal(await wholeSuiteBefore(ctx, checkout, { tag: 'kit-v1.1.0', commit: head() }), null);
  assert.deepEqual(lines(), [], 'the same code: not run again');
});

test('a kit whose whole suite fails, twice, is held as a failed release, and the Steward version waits for it', async () => {
  commit('NOTES.md', 'a change\n');
  writeFileSync(failTests, '');
  if (existsSync(ran)) unlinkSync(ran);
  const out = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  unlinkSync(failTests);
  assert.deepEqual(out.map((x) => x.outcome), ['failed', 'skipped']);
  assert.match(out[0].message, /^self: its whole suite failed at [0-9a-f]{7}, twice: npm test failed \(exit 1\).*, so kit-v1\.1\.0 wasn't released$/s);
  assert.equal(out[1].message, "self: v0.9.0 waits for the kit's release, which failed");
  assert.deepEqual(lines().filter((l) => l === 'test').length, 2, 'run once more first');
  assert.ok(!lines().some((l) => l.startsWith('kit-release')), 'nothing published');
  assert.equal(loadSelfFailures()['kit-v1.1.0'].commit, head(), 'held until a new commit lands on main');
  assert.equal(wholePassOf(tree()), null);
});

test('a kit whose whole suite fails twice, but no test both times, is released all the same: flaky, not a test the selection missed', async () => {
  // Its tests as node --test reports them: one test failing the first time, another the second, each passing in the other;
  // and while failTests is there, one failing both times.
  const flaky = path.join(home, 'flaky');
  const runs = path.join(home, 'runs');
  const tap = [
    `if (fs.existsSync(${JSON.stringify(flaky)})) {`,
    `  const n = fs.existsSync(${JSON.stringify(runs)}) ? Number(fs.readFileSync(${JSON.stringify(runs)}, 'utf8')) : 0;`,
    `  fs.writeFileSync(${JSON.stringify(runs)}, String(n + 1));`,
    `  console.log('not ok 1 - ' + (n === 0 ? 'a page started' : 'a slow server'));`,
    `  if (fs.existsSync(${JSON.stringify(failTests)})) console.log('not ok 2 - the same test');`,
    '  process.exit(1);',
    '}',
    '',
  ].join('\n');
  commit('tools/test.js', note('test') + tap);
  writeFileSync(flaky, '');
  if (existsSync(ran)) unlinkSync(ran);
  const out = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(out.map((x) => x.outcome), ['done', 'done'], out.map((x) => x.message).join('\n'));
  assert.equal(lines().filter((l) => l === 'test').length, 2, 'run once more first');
  assert.ok(lines().includes('kit-release --publish'), 'the kit released');
  assert.equal(loadSelfFailures()['kit-v1.1.0'], undefined, "the last round's failure cleared");
  assert.equal(wholePassOf(tree()), null, "not kept as a whole pass: it didn't pass");

  // A test that failed both times holds it, as before.
  commit('NOTES.md', 'flaky again\n');
  unlinkSync(runs);
  writeFileSync(failTests, '');
  unlinkSync(ran);
  const held = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  unlinkSync(failTests);
  unlinkSync(flaky);
  assert.deepEqual(held.map((x) => x.outcome), ['failed', 'skipped']);
  assert.match(held[0].message, /"the same test"/);
  assert.ok(!lines().some((l) => l.startsWith('kit-release')), 'nothing published');
});

test("a whole pass is kept only for the Steward's own checks, run whole, with its own kit, at a clean commit", async () => {
  commit('NOTES.md', 'another change\n');
  const steward = stewardEmployee(ctx.settings, checkout);
  await keepWhole(r.run, steward, { dir: checkout, chose: 'affected: 3 of 126 test files' });
  await keepWhole(r.run, steward, { dir: checkout, env: { STEWARD_KIT: path.join(home, 'trial-kit') } });
  await keepWhole(r.run, { ...steward, id: 'porter' }, { dir: checkout });
  writeFileSync(path.join(checkout, 'NOTES.md'), 'uncommitted\n');
  await keepWhole(r.run, steward, { dir: checkout });
  sh(checkout, 'checkout', '--', 'NOTES.md');
  assert.equal(wholePassOf(tree()), null);
  await keepWhole(r.run, steward, { dir: checkout, chose: 'the whole suite' });
  assert.equal(wholePassOf(tree())?.commit, sh(checkout, 'rev-parse', 'HEAD'));
  assert.deepEqual([ranWhole(undefined), ranWhole('the whole suite'), ranWhole('no test reaches the change')], [true, true, false]);
});

// Beside the rounds, as on the Steward's page (wholeSuitesBeside): its tests note their process ids and wait while the
// hold file is there, so a round that waited for them would never come back.
const hold = path.join(home, 'hold');
const pidsFile = path.join(home, 'pids.txt');
const pidsNow = () => (existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const testsRan = () => lines().filter((l) => l === 'test').length;
const ended: WholeJob[] = [];
const besideLines: string[] = [];
const besideOn = () => wholeSuitesBeside({ ended: (j) => ended.push(j), log: (l) => besideLines.push(l) });
const fresh = () => {
  for (const f of [ran, pidsFile]) if (existsSync(f)) unlinkSync(f);
};
const sha = () => head().slice(0, 7);
const waitingTests =
  note('test', failTests) +
  `fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');\n` +
  `while (fs.existsSync(${JSON.stringify(hold)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);\n`;

test('beside the rounds, a round starts the whole suite and goes on at once; later rounds wait for it, with no second run, and the first after it passes releases the kit', async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('tools/test.js', waitingTests);
  writeFileSync(hold, '');
  fresh();
  const first = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(first.map((x) => x.outcome), ['skipped'], first.map((x) => x.message).join('\n'));
  assert.match(first[0].message, new RegExp(`^self: kit-v1\\.1\\.0 waits: its whole suite started beside the rounds at ${sha()}: the rounds go on merging meanwhile`));
  await until(() => pidsNow().length === 1, 60_000, 'its tests running');
  assert.equal(loadWholeJob()?.state, 'running');
  assert.equal(loadWholeJob()?.commit, head());

  const second = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(second.map((x) => x.outcome), ['skipped']);
  assert.match(second[0].message, new RegExp(`^self: kit-v1\\.1\\.0 waits: its whole suite runs beside the rounds at ${sha()}, started .* ago`));
  assert.equal(testsRan(), 1, 'no second run beside it');
  assert.equal(pidsNow().length, 1);

  unlinkSync(hold);
  await wholeSuiteDone();
  assert.deepEqual(ended.map((j) => j.state), ['passed'], 'told once it ended');
  assert.equal(loadWholeJob()?.state, 'passed');
  assert.ok(!existsSync(path.join(home, 'work', '_steward-whole')), 'its worktree removed');
  const third = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(third.map((x) => x.outcome), ['done', 'done'], third.map((x) => x.message).join('\n'));
  assert.ok(lines().includes('kit-release --publish'), 'the kit released');
  assert.equal(testsRan(), 1, 'not run again');
});

test('beside the rounds, the whole suite never runs beside a kit trial or a rollout: it waits for them to end, and the round after starts it', async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('NOTES.md', 'beside a trial\n');
  fresh();
  for (const work of ['kit trial', 'rollout']) {
    let end!: () => void;
    const ended = new Promise<void>((r) => (end = r));
    const other = apart(work, () => ended);
    const waits = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
    end();
    await other;
    assert.deepEqual(waits.map((x) => x.outcome), ['skipped'], waits.map((x) => x.message).join('\n'));
    assert.equal(waits[0].message, `self: kit-v1.1.0 waits: its whole suite waits for the ${work} running beside the rounds to end, so the two never test at once: the rounds go on merging meanwhile`);
    assert.equal(testsRan(), 0, 'nothing run');
  }
  const starts = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.match(starts[0].message, new RegExp(`^self: kit-v1\\.1\\.0 waits: its whole suite started beside the rounds at ${sha()}`));
  await wholeSuiteDone();
  const done = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(done.map((x) => x.outcome), ['done', 'done'], done.map((x) => x.message).join('\n'));
  assert.equal(testsRan(), 1);
});

test('beside the rounds, a whole suite that fails twice holds the kit as a failed release, which later rounds leave held', async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('NOTES.md', 'beside, failing\n');
  writeFileSync(failTests, '');
  fresh();
  const started = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(started.map((x) => x.outcome), ['skipped']);
  await wholeSuiteDone();
  unlinkSync(failTests);
  assert.equal(ended.at(-1)?.state, 'failed');
  assert.equal(testsRan(), 2, 'run once more first');

  const held = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(held.map((x) => x.outcome), ['failed', 'skipped']);
  assert.match(held[0].message, /^self: its whole suite failed at [0-9a-f]{7}, twice: npm test failed \(exit 1\).*, so kit-v1\.1\.0 wasn't released$/s);
  assert.equal(loadSelfFailures()['kit-v1.1.0'].commit, head(), 'held until a new commit lands on main');
  assert.ok(!lines().some((l) => l.startsWith('kit-release')), 'nothing published');
  await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.equal(testsRan(), 2, 'not run again while held');
});

test('beside the rounds, a new commit on main stops the whole suite for the old one, its tests ended, and starts one at the new; the Steward stopping ends it, and the next round starts it again', async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('NOTES.md', 'beside, superseded\n');
  writeFileSync(hold, '');
  fresh();
  const old = sha();
  await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  await until(() => pidsNow().length === 1, 60_000, 'its tests running');
  const [oldTests] = pidsNow();

  commit('NOTES.md', 'beside, newer\n');
  const told = ended.length;
  const next = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.match(next[0].message, new RegExp(`^self: kit-v1\\.1\\.0 waits: its whole suite started beside the rounds at ${sha()}`));
  await until(() => !alive(oldTests), 30_000, 'the old tests ended');
  assert.ok(ctx.lines.some((l) => l.includes(`kit-v1.1.0's whole suite at ${old} stopped: main moved on to ${sha()}`)), ctx.lines.join('\n'));
  assert.equal(ended.length, told, 'a run stopped is no verdict to settle');
  assert.equal(loadWholeJob()?.commit, head());
  assert.equal(loadWholeJob()?.state, 'running');

  await until(() => pidsNow().length === 2, 60_000, 'the new tests running');
  const newTests = pidsNow()[1];
  endWholeSuite();
  assert.equal(loadWholeJob()?.state, 'ended');
  assert.match(loadWholeJob()?.why ?? '', /was stopped: the Steward stopped$/);
  await until(() => !alive(newTests), 30_000, 'its tests ended with it');
  await wholeSuiteDone();
  assert.equal(ended.length, told, 'nor one the Steward stopped');

  const restarted = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.match(restarted[0].message, /waits: its whole suite started beside the rounds/);
  assert.ok(ctx.lines.some((l) => /kit-v1\.1\.0: its whole suite at [0-9a-f]{7} again \(its whole suite at [0-9a-f]{7} was stopped: the Steward stopped\)/.test(l)));
  unlinkSync(hold);
  await wholeSuiteDone();
  assert.equal(ended.at(-1)?.state, 'passed');
});

test("beside the rounds, a whole suite is stopped once the Steward's own turn is another PC's: that PC's Steward runs it", async (t) => {
  besideOn();
  t.after(() => wholeSuitesBeside(null));
  commit('NOTES.md', 'beside, another PC\n');
  writeFileSync(hold, '');
  fresh();
  await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  await until(() => pidsNow().length === 1, 60_000, 'its tests running');
  const [tests] = pidsNow();
  const elsewhere = { ...ctx, lease: { ok: async () => false, skip: new Set<string>(['steward']), has: () => true } };
  const out = await releaseSelf(elsewhere, facts(['v0.8.0', 'kit-v1.0.0']));
  unlinkSync(hold);
  assert.deepEqual(out.map((x) => x.message), ['self: kit-v1.1.0 is left to another PC, whose turn it is now']);
  await until(() => !alive(tests), 30_000, 'its tests ended');
  assert.equal(loadWholeJob()?.state, 'ended');
  assert.match(loadWholeJob()?.why ?? '', /was stopped: the Steward's own turn is another PC's now$/);
});

test("a whole suite a Steward that is gone left running is ended, with the program it left, and its record says so", async () => {
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.ok(left.pid && alive(left.pid));
    writeFileSync(wholeJobFile(), JSON.stringify({ tag: 'kit-v1.1.0', commit: head(), state: 'running', startedAt: new Date().toISOString(), by: gone, pids: [left.pid] }));
    const said: string[] = [];
    endWholeOrphans((l) => said.push(l));
    await until(() => !alive(left.pid!), 30_000, 'the program it left ended');
    const job = loadWholeJob();
    assert.equal(job?.state, 'ended');
    assert.deepEqual(job?.pids, []);
    assert.equal(job?.why, `the Steward that ran it (process ${gone}) ended before it did, and the program it left running was ended`);
    assert.match(said[0], /kit-v1\.1\.0's whole suite at [0-9a-f]{7}: the Steward that ran it/);

    // One this Steward runs, or one a live Steward does, is left alone.
    writeFileSync(wholeJobFile(), JSON.stringify({ tag: 'kit-v1.1.0', commit: head(), state: 'running', startedAt: new Date().toISOString(), by: process.pid, pids: [] }));
    endWholeOrphans();
    assert.equal(loadWholeJob()?.state, 'running');
  } finally {
    left.kill();
    writeFileSync(wholeJobFile(), 'null');
  }
});

test("every check run is a task in the Steward's work status, and what it came to is kept by its tree, not a trial's", async () => {
  commit('tools/test.js', note('test', failTests));
  const steward = stewardEmployee(ctx.settings, checkout);
  const key = { kind: 'checks', repo: steward.repo, tree: tree() };
  const seen: string[] = [];
  const say = () => seen.push(...workTasks().map((t) => `${t.kind} ${t.what} ${t.tree === key.tree}`));
  await runChecks(ctx, steward, checkout, { say, env: { STEWARD_KIT: path.join(home, 'trial-kit') }, doing: 'a kit trial' });
  assert.equal(resultFor(key), null, "a trial's checks ran with a kit not the tree's own: not that tree's result");
  writeFileSync(failTests, '');
  assert.match((await runChecks(ctx, steward, checkout, { say, doing: 'its checks at main' })) ?? '', /npm test failed/);
  unlinkSync(failTests);
  assert.deepEqual({ ...resultFor(key), at: undefined, note: undefined }, { kind: 'checks', repo: steward.repo, tree: key.tree, commit: head(), ok: false, what: 'Steward: its checks at main', commands: steward.test, node: process.versions.node, platform: process.platform, at: undefined, note: undefined }, 'with the commands it ran, on which Node.js and OS');
  assert.equal(await runChecks(ctx, steward, checkout, { say, doing: 'its checks at main' }), null);
  assert.equal(resultFor(key)?.ok, true, 'the latest for the same code');
  assert.ok(seen.includes('trial Steward: a kit trial true') && seen.includes('checks Steward: its checks at main true'), seen.join('\n'));
  assert.deepEqual(workTasks(), [], 'each ended once it ran');
});

test('code that already passed its checks, here or on another PC on the licence, is not run again: never for a trial nor a run meant for this PC, and a failure elsewhere spares nothing', async () => {
  const steward = stewardEmployee(ctx.settings, checkout);
  const key = { kind: 'checks', repo: steward.repo, tree: tree() };
  const said: string[] = [];
  const say = (l: string) => said.push(l);
  const tests = () => lines().filter((l) => l.startsWith('test')).length;
  assert.equal(resultFor(key)?.ok, true, 'it passed just now (the test before)');
  let n = tests();
  const here: StoodIn = {};
  assert.equal(await runChecks(ctx, steward, checkout, { say, doing: 'its checks at main', stoodIn: here }), null);
  assert.equal(tests(), n, 'nothing run');
  assert.deepEqual([here.by, here.where], ['here', 'here']);
  assert.match(said.join('\n'), /^its checks passed here at \d\d:\d\d, on exactly this code \(tree [0-9a-f]{7}\): not run again$/m);
  await runChecks(ctx, steward, checkout, { say, env: { STEWARD_KIT: path.join(home, 'trial-kit') }, doing: 'a kit trial' });
  assert.equal(tests(), ++n, "a kit under trial isn't the tree's own: run");
  writeFileSync(failTests, '');
  assert.match((await runChecks(ctx, steward, checkout, { say, here: true })) ?? '', /npm test failed/, 'a run meant for this PC: run');
  assert.equal(tests(), ++n);
  assert.equal(resultFor(key)?.ok, false);

  // Another PC on the licence, through Manor here (its GET /api/peers/result, Manor 0.16.163).
  const manor = path.join(home, 'manor');
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  const port = await freePort();
  writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ port }));
  let answer: Record<string, unknown> | null = null;
  const fake = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 1, result: answer })));
  await new Promise<void>((resolve) => fake.listen(port, '127.0.0.1', resolve));
  process.env.MANOR_HOME = manor;
  try {
    const there = (o: Record<string, unknown> = {}) => ({ kind: 'checks', repo: steward.repo, tree: key.tree, commit: head(), ok: true, at: new Date().toISOString(), commands: steward.test, node: process.versions.node, platform: process.platform, pc: { id: 'pc-2', name: 'LAPTOP' }, ...o });
    answer = there({ at: new Date(Date.now() - 3600_000).toISOString() });
    assert.match((await runChecks(ctx, steward, checkout, { say })) ?? '', /npm test failed/, 'a failure here after the pass there: run here');
    assert.equal(tests(), ++n);
    unlinkSync(failTests);

    commit('tools/typecheck.js', `${note('typecheck')}// another tree\n`);
    answer = there({ tree: tree(), ok: false });
    assert.equal(await runChecks(ctx, steward, checkout, { say }), null);
    assert.equal(tests(), ++n, 'a failure elsewhere spares nothing');

    commit('tools/typecheck.js', `${note('typecheck')}// a third tree\n`);
    const key3 = { ...key, tree: tree() };
    answer = there({ tree: key3.tree, commit: head() });
    const pc: StoodIn = {};
    assert.equal(await runChecks(ctx, steward, checkout, { say, stoodIn: pc }), null);
    assert.equal(tests(), n, 'its pass on LAPTOP stands in');
    assert.deepEqual([pc.by, pc.where], ['pc', 'on LAPTOP']);
    assert.match(said.at(-1) ?? '', /^its checks passed on LAPTOP at \d\d:\d\d, on exactly this code \(tree [0-9a-f]{7}\): not run again$/);
    assert.deepEqual(resultFor(key3)?.from, { id: 'pc-2', name: 'LAPTOP' }, "kept here, as LAPTOP's");
  } finally {
    delete process.env.MANOR_HOME;
    await new Promise((resolve) => fake.close(resolve));
  }
});
