import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// `steward vouch` when a pass of exactly HEAD's tree stands in for its checks (stages/standin.ts, assayed.ts): the
// Assayer's check here, of the whole suite or of the tests the change reaches, or the whole checks on another PC on the
// licence. The rest of `steward vouch` is vouch.test.ts.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-vouch-standin-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
// The Assayer's record of checks, never the person's own.
process.env.ASSAYER_HOME = path.join(tmp, 'assayer');
mkdirSync(process.env.ASSAYER_HOME, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

const { vouch } = await import('../src/stages/vouch.ts');
const { assayerChecksFile, ASSAYED_MS, choseOf, covers, whyShort } = await import('../src/stages/assayed.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
const { freePort } = await import('../kit/test/free-port.ts');

test("steward vouch takes the Assayer's passing check of exactly HEAD's tree, and runs nothing; anything less, and the checks run", async () => {
  const f = fakeEmployee(path.join(tmp, 'assayed'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/assayed');
  writeFileSync(path.join(f.checkout, 'a.txt'), 'a\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const tree = sh(f.checkout, 'rev-parse', 'HEAD^{tree}');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const top = path.resolve(sh(f.checkout, 'rev-parse', '--show-toplevel')).toLowerCase();
  // Its checks here always fail: a vouch that passes proves they weren't run.
  const failing = 'node -e process.exit(1)';
  const passed = { at: new Date().toISOString(), outcome: 'passed', full: true, cases: ['unit-tests', 'typecheck'], commands: [failing, 'npm run typecheck'], tree, marks: { 'node_modules/.package-lock.json': '-', 'src/kit/VERSION': '-' } };
  const go = async (checks: object[], test = [failing]) => {
    writeFileSync(assayerChecksFile(), JSON.stringify({ [top]: checks }));
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const said: string[] = [];
    const e = employee(f.checkout, { fill: '', test });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const v = await vouch(ctx, { dir: f.checkout, say: (l) => said.push(l) });
    return { v, r, said };
  };

  const taken = await go([passed]);
  assert.equal(taken.v.ok, true, taken.v.message);
  assert.match(taken.said.join('\n'), /^the Assayer passed this exact tree at \d\d:\d\d: nothing run again$/m);
  assert.deepEqual(taken.r.gh.find((a) => a[0] === 'api')?.at(-1), `description=${failing}, npm run typecheck passed in the Assayer at ${head.slice(0, 7)}`);
  // The Steward's typecheck is the Assayer's typecheck case, however it is written.
  assert.equal((await go([passed], ['npx tsc -p . --noEmit', failing])).v.ok, true);

  for (const [why, checks, test] of [
    ['no record', [], [failing]],
    ['other code', [{ ...passed, tree: 'f'.repeat(40) }], [failing]],
    ['some tests only', [{ ...passed, full: undefined }], [failing]],
    ['a failure since', [{ ...passed, outcome: 'failed' }, passed], [failing]],
    ['too old', [{ ...passed, at: new Date(Date.now() - ASSAYED_MS - 60_000).toISOString() }], [failing]],
    ['a check it never ran', [passed], [failing, 'npm run build']],
    ['installed since', [{ ...passed, marks: { ...passed.marks, 'a.txt': '-' } }], [failing]],
    ['an Assayer before 0.3.31', [{ at: passed.at, outcome: 'passed', cases: ['unit-tests'] }], [failing]],
  ] as const) {
    const t = await go([...checks], [...test]);
    assert.equal(t.v.ok, false, why);
    assert.match(t.v.message, /checks failed at .*Nothing was recorded/, why);
    assert.doesNotMatch(t.said.join('\n'), /the Assayer passed/, why);
    assert.ok(!t.r.gh.some((a) => a[0] === 'api'), why);
  }
});

test("steward vouch takes a pass of the whole checks on exactly HEAD's tree on another PC on the licence, and its vouch says where it passed", async () => {
  const f = fakeEmployee(path.join(tmp, 'elsewhere'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/elsewhere');
  writeFileSync(path.join(f.checkout, 'b.txt'), 'passed on LAPTOP\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'b');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const tree = sh(f.checkout, 'rev-parse', 'HEAD^{tree}');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  writeFileSync(assayerChecksFile(), '{}');
  // Its checks here always fail: a vouch that passes proves they weren't run.
  const failing = 'node -e process.exit(1)';
  const e = employee(f.checkout, { fill: '', test: [failing] });
  const manor = path.join(tmp, 'manor');
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  const port = await freePort();
  writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ port }));
  const pass = { kind: 'checks', repo: e.repo, tree, commit: head, ok: true, at: new Date().toISOString(), commands: [failing], node: process.versions.node, platform: process.platform, pc: { id: 'pc-2', name: 'LAPTOP' } };
  const fake = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 1, result: pass })));
  await new Promise<void>((resolve) => fake.listen(port, '127.0.0.1', resolve));
  process.env.MANOR_HOME = manor;
  try {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 10, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const said: string[] = [];
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const v = await vouch(ctx, { dir: f.checkout, say: (l) => said.push(l) });
    assert.equal(v.ok, true, `${v.message}\n${said.join('\n')}`);
    assert.match(said.join('\n'), /^its checks passed on LAPTOP at \d\d:\d\d, on exactly this code \(tree [0-9a-f]{7}\): not run again$/m);
    assert.equal(r.gh.find((a) => a[0] === 'api')?.at(-1), `description=${failing} passed on LAPTOP at ${head.slice(0, 7)}`);
  } finally {
    delete process.env.MANOR_HOME;
    await new Promise((resolve) => fake.close(resolve));
  }
});

test("steward vouch takes the Assayer's affected pass of HEAD's tree when its test files take in the ones the change reaches; fewer, unnamed or a whole-suite vouch, and the checks run", async () => {
  // Three test files that fail when run: a vouch that passes proves none ran. The branch changes src/a.mjs, which
  // test/a.test.mjs alone reaches.
  const failing = "import { test } from 'node:test';\ntest('ran', () => { throw new Error('this ran'); });\n";
  const f = fakeEmployee(path.join(tmp, 'assayed-affected'), {
    version: '0.4.0',
    files: {
      'package.json': '{\n  "name": "fake",\n  "version": "0.4.0",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "test": "node --test \\"test/**/*.test.mjs\\""\n  }\n}\n',
      'src/a.mjs': 'export const a = 1;\n',
      'src/b.mjs': 'export const b = 2;\n',
      'test/a.test.mjs': `import '../src/a.mjs';\n${failing}`,
      'test/b.test.mjs': `import '../src/b.mjs';\n${failing}`,
      'test/c.test.mjs': failing,
    },
  });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/assayed-affected');
  writeFileSync(path.join(f.checkout, 'src/a.mjs'), 'export const a = 1; // tidied\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const tree = sh(f.checkout, 'rev-parse', 'HEAD^{tree}');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const top = path.resolve(sh(f.checkout, 'rev-parse', '--show-toplevel')).toLowerCase();
  const steps = ['npm run typecheck', 'npm test'];
  const passed = { at: new Date().toISOString(), outcome: 'passed', affected: true, cases: ['unit-tests', 'typecheck'], commands: ['npm test', 'npm run typecheck'], ran: { 'npm test': ['test/a.test.mjs', 'test/b.test.mjs'], 'npm run typecheck': 'all' }, tree, marks: { 'src/kit/VERSION': '-' } };
  const go = async (checks: object[], o: { whole?: boolean } = {}) => {
    writeFileSync(assayerChecksFile(), JSON.stringify({ [top]: checks }));
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const said: string[] = [];
    const e = employee(f.checkout, { fill: '', test: steps });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    if (o.whole) ctx.settings.affectedTests = false;
    const v = await vouch(ctx, { dir: f.checkout, say: (l) => said.push(l) });
    return { v, r, said, description: r.gh.find((a) => a[0] === 'api')?.at(-1) };
  };

  // Its two test files take in test/a.test.mjs: taken, and the status says it was an affected vouch, the Assayer's.
  const taken = await go([passed]);
  assert.equal(taken.v.ok, true, taken.v.message);
  assert.match(taken.said.join('\n'), /^the Assayer passed this exact tree at \d\d:\d\d \(npm test: affected: 2 of 3 test files, the Assayer's\): nothing run again$/m);
  assert.equal(taken.description, `description=npm run typecheck, npm test (affected: 2 of 3 test files, the Assayer's) passed at ${head.slice(0, 7)}`);
  // Every test, as it is: taken, whether the vouch would run some or (Settings) all of them; and a whole check still is.
  const all = { ...passed, ran: { ...passed.ran, 'npm test': 'all' } };
  assert.equal((await go([all])).description, `description=npm run typecheck, npm test (the whole suite, the Assayer's) passed at ${head.slice(0, 7)}`);
  assert.equal((await go([all], { whole: true })).v.ok, true);
  assert.equal((await go([{ ...passed, affected: undefined, full: true, ran: undefined }])).description, `description=npm test, npm run typecheck passed in the Assayer at ${head.slice(0, 7)}`);
  // A typecheck it doesn't name in what ran is the Assayer's typecheck case, which is never narrowed.
  assert.equal((await go([{ ...passed, ran: { 'npm test': passed.ran['npm test'] } }])).v.ok, true);

  for (const [why, checks, o] of [
    ['it left out the test file the change reaches', [{ ...passed, ran: { ...passed.ran, 'npm test': ['test/b.test.mjs'] } }], {}],
    ['no test ran', [{ ...passed, ran: { ...passed.ran, 'npm test': [] } }], {}],
    ['its runner chose the tests, unnamed', [{ ...passed, ran: { 'npm run typecheck': 'all' } }], {}],
    ['an Assayer that keeps no files', [{ ...passed, ran: undefined }], {}],
    ['Settings say the whole suite', [passed], { whole: true }],
    ['other code', [{ ...passed, tree: 'f'.repeat(40) }], {}],
    ['a failure since', [{ ...passed, outcome: 'failed' }, passed], {}],
    ['a check it never ran', [{ ...passed, commands: ['npm test'], cases: ['unit-tests'] }], {}],
  ] as const) {
    const t = await go([...checks], o);
    assert.equal(t.v.ok, false, why);
    assert.match(t.v.message, /checks failed at .*Nothing was recorded/, why);
    assert.doesNotMatch(t.said.join('\n'), /the Assayer passed/, why);
    assert.equal(t.description, undefined, why);
  }
});

test("an affected Assayer check stands in only when each check ran as it is, but npm test, whose files take in the vouch's own", () => {
  const pick = { files: ['test/a.test.ts'], tests: ['test/a.test.ts', 'test/b.test.ts'], why: '', flags: [], pretest: false };
  const c = { cases: ['unit-tests', 'typecheck'], ran: { 'npm test': ['test/a.test.ts', 'test/c.test.ts'], 'npm run typecheck': 'all' as const } };
  assert.equal(whyShort(['npm run typecheck', 'npm test'], c, pick), null);
  assert.equal(whyShort(['npx tsc -p . --noEmit', 'npm test'], c, pick), null);
  assert.equal(whyShort(['npm test'], c, { ...pick, files: [] }), null);
  assert.equal(whyShort(['npm test'], { ...c, ran: { 'npm test': ['.\\test\\a.test.ts'] } }, pick), null, 'its paths, however written');
  assert.equal(whyShort(['npm test'], c, { ...pick, files: ['test/a.test.ts', 'test/b.test.ts'] }), 'it left out 1 of the 2 test files this change reaches (test/b.test.ts)');
  assert.equal(whyShort(['npm test'], c, { whole: 'tsconfig.json changed' }), "it ran only some of npm test's tests, and this vouch runs them all");
  assert.equal(whyShort(['npm test'], { ...c, ran: { 'npm test': 'all' } }, { whole: 'tsconfig.json changed' }), null);
  assert.equal(whyShort(['npm test', 'npm run lint'], c, pick), "it doesn't say which tests npm run lint ran");
  assert.equal(whyShort(['npm run test:web'], { ...c, ran: { 'npm run test:web': ['test/w.test.ts'] } }, pick), "it ran only some of npm run test:web's tests, and this vouch runs them all");
  assert.equal(choseOf(c, pick), "affected: 2 of 2 test files, the Assayer's");
  assert.equal(choseOf({ ran: { 'npm test': [] } }, pick), "no test reaches the change, the Assayer's");
  assert.equal(choseOf({ ran: {} }, pick), undefined);
});

test('the Assayer check covers a vouch only when it ran each of its checks', () => {
  const c = { cases: ['unit-tests', 'typecheck'], commands: ['npm test', 'npm run typecheck'] };
  assert.equal(covers(['npx tsc -p . --noEmit', 'npm test'], c), true);
  assert.equal(covers(['npm run typecheck', 'npm test'], c), true);
  assert.equal(covers(['npm test', 'npm run build'], c), false);
  assert.equal(covers(['npx tsc -p . --noEmit', 'npm test'], { cases: ['unit-tests'], commands: ['npm test'] }), false);
  assert.equal(covers(['dotnet test HEI.Core.Tests'], { cases: ['unit-tests'], commands: ['dotnet test'] }), false);
});
