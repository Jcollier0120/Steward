import assert from 'node:assert/strict';
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
const { wholeSuiteBefore } = await import('../src/stages/wholesuite.ts');
const { stewardEmployee } = await import('../src/stages/selfmerge.ts');
const { keepWhole, ranWhole, wholePassOf } = await import('../src/whole.ts');
const { ctxFor, runner, sh } = await import('./helpers.ts');

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
