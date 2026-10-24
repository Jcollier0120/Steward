import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The whole suite before a kit's release (stages/wholesuite.ts), run in the round, the whole passes kept by tree
// (whole.ts) and every check's result kept by its tree (work-status.ts), on wholesuite-fake.ts' fake Steward repository.
// Beside the rounds: wholesuite-beside.test.ts.
const { home, checkout, ran, failTests, note, head, commit, r, ctx, lines, facts, tree } = await import('./wholesuite-fake.ts');
const { releaseSelf, loadSelfFailures } = await import('../src/stages/self.ts');
const { wholeSuiteBefore } = await import('../src/stages/wholesuite.ts');
const { stewardEmployee } = await import('../src/stages/selfmerge.ts');
const { keepWhole, ranWhole, wholePassOf } = await import('../src/whole.ts');
const { sh } = await import('./helpers.ts');
const { runChecks } = await import('../src/stages/bump.ts');
const { resultFor } = await import('../src/kit/work-status.ts');
const { workTasks } = await import('../src/kit/work-tasks.ts');
const { freePort } = await import('../kit/test/free-port.ts');
type StoodIn = import('../src/stages/standin.ts').StoodIn;

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
  assert.equal(out[1].message, "self: v0.9.0 waits for kit-v1.1.0's release");
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
