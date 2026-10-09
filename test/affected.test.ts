import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Affected tests: the test files a change reaches, for a vouch and a PR tested here; the whole suite where it can't tell.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-affected-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { affectedTests, globRe, nodeTestScript, resolveSpecifier, specifiersOf, versionOnly } = await import('../src/affected.ts');
const { affectedSteps, patchesByFile } = await import('../src/stages/bump.ts');
const { ctxFor, employee, fakeEmployee, runner, sh } = await import('./helpers.ts');

test('the pieces: imports read, specifiers resolved, version steps told apart, test scripts read', () => {
  const text = [
    "import { a } from '../src/a.ts';",
    "export { b } from './b.js';",
    "import './side.ts';",
    "const { c } = await import('../src/c.ts');",
    "const d = require('../lib/d');",
    "import fs from 'node:fs';",
    "import x from 'react';",
  ].join('\n');
  assert.deepEqual(specifiersOf(text), ['../src/a.ts', './b.js', './side.ts', '../src/c.ts', '../lib/d']);
  const known = new Set(['src/a.ts', 'test/b.ts', 'lib/d/index.ts', 'src/e.mts']);
  assert.equal(resolveSpecifier('test/x.test.ts', '../src/a.ts', known), 'src/a.ts');
  assert.equal(resolveSpecifier('test/x.test.ts', './b.js', known), 'test/b.ts', ".js written for a .ts file");
  assert.equal(resolveSpecifier('test/x.test.ts', '../lib/d', known), 'lib/d/index.ts');
  assert.equal(resolveSpecifier('test/x.test.ts', '../src/e.mjs', known), 'src/e.mts');
  assert.equal(resolveSpecifier('test/x.test.ts', '../src/none.ts', known), null);

  assert.equal(versionOnly('--- a/package.json\n+++ b/package.json\n@@ -3 +3 @@\n-  "version": "0.4.0",\n+  "version": "0.4.1",'), true);
  assert.equal(versionOnly("@@ -12 +12 @@\n-  version: '0.4.0',\n+  version: '0.4.1',"), true, "src/app.ts's");
  assert.equal(versionOnly('@@ -3 +3,2 @@\n-  "version": "0.4.0",\n+  "version": "0.4.1",\n+  "type": "module",'), false);
  assert.equal(versionOnly(''), false);

  assert.ok(globRe('test/**/*.test.ts').test('test/a.test.ts'));
  assert.ok(globRe('test/**/*.test.ts').test('test/deep/b.test.ts'));
  assert.ok(!globRe('test/**/*.test.ts').test('test/helpers.ts'));
  assert.deepEqual(nodeTestScript('node --test "test/**/*.test.ts"'), { flags: [], globs: ['test/**/*.test.ts'] });
  assert.deepEqual(nodeTestScript('node --test "test/**/*.test.ts" "kit/test/**/*.test.ts"'), { flags: [], globs: ['test/**/*.test.ts', 'kit/test/**/*.test.ts'] });
  assert.deepEqual(nodeTestScript('node --experimental-strip-types --test --test-concurrency=1 "test/**/*.test.ts"'), { flags: ['--experimental-strip-types', '--test-concurrency=1'], globs: ['test/**/*.test.ts'] });
  assert.equal(nodeTestScript('vitest run'), null);
  assert.equal(nodeTestScript('node --test "test/**/*.test.ts" && node other.js'), null);
  assert.equal(nodeTestScript(undefined), null);

  const parts = patchesByFile('diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.json b/y.json\n@@ -1 +1 @@\n-1\n+2\n');
  assert.deepEqual([...parts.keys()], ['x.ts', 'y.json']);
  assert.match(parts.get('y.json')!, /^diff --git a\/y\.json/);
});

/** A small repository: src/a.ts, src/b.ts (importing a), src/c.ts (naming roles.json), src/cli.ts, and their tests. */
function repo(name: string): string {
  const dir = path.join(home, name);
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "fake",\n  "version": "0.4.1",\n  "scripts": { "test": "node --test \\"test/**/*.test.ts\\"" }\n}\n',
    'tsconfig.json': '{}\n',
    'CHANGELOG.md': '# Changelog\n',
    'roles.json': '[]\n',
    'web/logo.bin': 'x',
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': "import { a } from './a.ts';\nexport const b = a + 1;\n",
    'src/c.ts': "export const file = 'roles.json';\n",
    'src/cli.ts': 'console.log(1);\n',
    'test/helpers.ts': 'export const h = 1;\n',
    'test/a.test.ts': "import { a } from '../src/a.ts';\n",
    'test/b.test.ts': "const { b } = await import('../src/b.ts');\n",
    'test/c.test.ts': "import { file } from '../src/c.ts';\nimport { h } from './helpers.ts';\n",
    'test/run.test.ts': "// runs node src/cli.ts as a child\nconst cli = 'src/cli.ts';\n",
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), t);
  }
  return dir;
}

test('which test files a change reaches, and what runs everything', () => {
  const dir = repo('graph');
  const pick = (changed: [string, string][], patches: Record<string, string> = {}) => {
    const a = affectedTests({ dir, changed: changed.map(([status, p]) => ({ status, path: p })), testGlobs: ['test/**/*.test.ts'], patchOf: (f) => patches[f] ?? '@@\n-x\n+y' });
    return a.all ? `all: ${a.why}` : a.files;
  };
  assert.deepEqual(pick([['M', 'src/a.ts']]), ['test/a.test.ts', 'test/b.test.ts'], 'its own test, and the one that reaches it through b (a dynamic import)');
  assert.deepEqual(pick([['M', 'src/b.ts']]), ['test/b.test.ts']);
  assert.deepEqual(pick([['M', 'test/run.test.ts']]), ['test/run.test.ts'], 'a changed test runs itself');
  assert.deepEqual(pick([['M', 'test/helpers.ts']]), ['test/c.test.ts'], 'a helper: the tests that import it');
  assert.deepEqual(pick([['M', 'src/cli.ts']]), ['test/run.test.ts'], 'a test that names a changed file');
  assert.deepEqual(pick([['M', 'roles.json']]), ['test/c.test.ts'], 'data: through the code that names it');
  // A version step and its changelog entry reach nothing.
  const step = { 'package.json': '@@ -3 +3 @@\n-  "version": "0.4.0",\n+  "version": "0.4.1",' };
  assert.deepEqual(pick([['M', 'package.json'], ['M', 'CHANGELOG.md']], step), []);
  assert.deepEqual(pick([['M', 'package.json'], ['M', 'src/a.ts']], step), ['test/a.test.ts', 'test/b.test.ts']);
  // What it can't follow.
  assert.match(String(pick([['M', 'package.json']])), /^all: package\.json changed beyond its version/);
  assert.match(String(pick([['M', 'tsconfig.json']])), /^all: tsconfig\.json changed \(the TypeScript setup\)/);
  assert.match(String(pick([['M', 'kit.json']])), /^all: kit\.json changed \(the kit pin\)/);
  assert.match(String(pick([['M', 'test/fixtures/x.json']])), /^all: .*test fixtures/);
  assert.match(String(pick([['D', 'src/gone.ts']])), /^all: src\/gone\.ts was deleted or renamed/);
  assert.match(String(pick([['M', 'web/logo.bin']])), /^all: web\/logo\.bin changed, and no code names it/);
  assert.match(String(pick(Array.from({ length: 201 }, (_, i) => ['M', `src/f${i}.ts`] as [string, string]))), /^all: 201 files changed/);
});

test("in a vouch's clone: npm test becomes node --test with only the files the branch's change reaches", async () => {
  const dir = path.join(home, 'clone');
  const { checkout } = fakeEmployee(dir, {
    files: {
      'package.json': '{\n  "name": "fake",\n  "version": "0.4.0",\n  "private": true,\n  "type": "module",\n  "scripts": { "pretest": "node -e 0", "test": "node --test \\"test/**/*.test.ts\\"" }\n}\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'test/a.test.ts': "import { a } from '../src/a.ts';\n",
      'test/b.test.ts': "import { b } from '../src/b.ts';\n",
    },
  });
  sh(checkout, 'switch', '--quiet', '-c', 'claude/a');
  writeFileSync(path.join(checkout, 'src/a.ts'), 'export const a = 2;\n');
  writeFileSync(path.join(checkout, 'package.json'), sh(checkout, 'show', 'HEAD:package.json').replace('"version": "0.4.0"', '"version": "0.4.1"') + '\n');
  sh(checkout, 'commit', '--quiet', '-am', 'a, and 0.4.1');
  const { run } = runner();
  const ctx = ctxFor({ employees: [employee(checkout)], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const said: string[] = [];
  const scope: { base: string; chose?: string } = { base: 'origin/main' };
  const steps = await affectedSteps(ctx, checkout, scope, (l) => said.push(l));
  assert.deepEqual(steps, ['npm run pretest', 'node --test "test/a.test.ts"']);
  assert.equal(scope.chose, 'affected: 1 of 2 test files');
  assert.match(said.join('\n'), /package\.json: a version step/);

  // Only the changelog and the version: no test runs, its pretest still does.
  sh(checkout, 'switch', '--quiet', '-c', 'claude/notes', 'main');
  writeFileSync(path.join(checkout, 'CHANGELOG.md'), '# Changelog\n\n## 0.4.1\n');
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'notes');
  const none: { base: string; chose?: string } = { base: 'origin/main' };
  assert.deepEqual(await affectedSteps(ctx, checkout, none, () => {}), ['npm run pretest']);
  assert.equal(none.chose, 'no test reaches the change');

  // A base git can't find: the whole suite.
  const lost: { base: string; chose?: string } = { base: 'origin/nowhere' };
  assert.deepEqual(await affectedSteps(ctx, checkout, lost, () => {}), ['npm test']);
  assert.equal(lost.chose, 'the whole suite');
});
