import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Affected tests: the test files a change reaches, for a vouch and a PR tested here; the whole suite where it can't tell.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-affected-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { affectedTests, globRe, kitFromOf, nodeTestScript, pinOnly, readsInPlace, resolveSpecifier, specifiersOf, versionOnly } = await import('../src/affected.ts');
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

test('Markdown reaches only the code that reads it where it lies', () => {
  const here = "const here = path.dirname(fileURLToPath(import.meta.url));\n";
  assert.equal(readsInPlace(`${here}const log = readFileSync(path.join(here, '..', 'CHANGELOG.md'), 'utf8');\n`, 'CHANGELOG.md'), true);
  assert.equal(readsInPlace(`${here}const kit = path.join(here, '..', 'kit');\nconst notes = path.join(kit, 'CHANGELOG.md');\n`, 'CHANGELOG.md'), true, 'through a path built from its place');
  assert.equal(readsInPlace("const log = readFileSync('CHANGELOG.md', 'utf8');\n", 'CHANGELOG.md'), true, 'from the working folder');
  assert.equal(readsInPlace("export const notesOf = (dir: string) => readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');\n", 'CHANGELOG.md'), false, "a folder it is given: another repository's");
  assert.equal(readsInPlace(`${here}// its CHANGELOG.md, beside import.meta.url\n`, 'CHANGELOG.md'), false, 'a comment');
  const pkg = "const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));\n";
  assert.equal(readsInPlace(`${pkg}const notes = path.join(pkg.dir, 'CHANGELOG.md');\n`, 'CHANGELOG.md'), false, 'what was read there holds no place');

  const dir = path.join(home, 'markdown');
  const files: Record<string, string> = {
    'CHANGELOG.md': '# Changelog\n',
    'README.md': '# Fake\n',
    'src/notes.ts': "export const notesOf = (dir: string) => readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');\n",
    'src/core.ts': "export const core = new URL('./core/', import.meta.url);\n",
    'src/core/a.json': '{}\n',
    'src/core/b.md': '# b\n',
    'src/app.ts': "export const root = new URL('..', import.meta.url);\n",
    'test/notes.test.ts': "import { notesOf } from '../src/notes.ts';\n",
    'test/own.test.ts': `${here}const text = readFileSync(path.join(here, '..', 'CHANGELOG.md'), 'utf8');\n`,
    'test/core.test.ts': "import { core } from '../src/core.ts';\n",
    'test/app.test.ts': "import { root } from '../src/app.ts';\n",
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), t);
  }
  const pick = (...changed: string[]) => {
    const a = affectedTests({ dir, changed: changed.map((p) => ({ status: 'M', path: p })), testGlobs: ['test/**/*.test.ts'], patchOf: () => '@@\n-x\n+y' });
    return a.all ? `all: ${a.why}` : a.files;
  };
  assert.deepEqual(pick('CHANGELOG.md'), ['test/own.test.ts'], "the test reading its own changelog, not the code reading a worktree's");
  assert.deepEqual(pick('README.md'), [], 'named by none');
  assert.deepEqual(pick('src/core/a.json'), ['test/core.test.ts'], 'a file in a folder code reads');
  assert.deepEqual(pick('src/core/b.md'), ['test/core.test.ts']);
  assert.deepEqual(pick('src/notes.ts'), ['test/notes.test.ts'], "the repository's root, which src/app.ts finds things from, isn't read whole");
});

test("the Steward's own kit, filled from its kit folder: a kit file reaches its copies, its version and pin are a step", () => {
  const dir = path.join(home, 'own-kit');
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "fake",\n  "version": "0.4.1",\n  "scripts": { "kit": "node tools/kit.ts --from kit", "test": "node --test \\"test/**/*.test.ts\\" \\"kit/test/**/*.test.ts\\"" }\n}\n',
    'kit.json': '{\n  "kit": "2.70.0",\n  "parts": ["node"]\n}\n',
    'kit/VERSION': '2.70.0\n',
    'kit/CHANGELOG.md': '# Kit\n',
    'kit/node/store.ts': 'export const store = 1;\n',
    'kit/test/store.test.ts': "import { store } from '../node/store.ts';\n",
    'kit/test/version.test.ts': "const v = readFileSync(new URL('../VERSION', import.meta.url), 'utf8');\n",
    'kit/test/fixture/src/kit/PARTS': 'node\n',
    'kit/test/fixture/src/kit/store.ts': 'export const store = 1;\n',
    'kit/test/fill.test.ts': "import { store } from './fixture/src/kit/store.ts';\n",
    'src/kit/PARTS': 'node\n',
    'src/kit/store.ts': 'export const store = 1;\n',
    'src/a.ts': "import { store } from './kit/store.ts';\nexport const a = store;\n",
    'test/a.test.ts': "import { a } from '../src/a.ts';\n",
    'test/pin.test.ts': "const pin = JSON.parse(readFileSync(new URL('../kit.json', import.meta.url), 'utf8'));\n",
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), t);
  }
  const globs = ['test/**/*.test.ts', 'kit/test/**/*.test.ts'];
  const pick = (changed: [string, string][], kitFrom?: string) => {
    const a = affectedTests({ dir, changed: changed.map(([p]) => ({ status: 'M', path: p })), testGlobs: globs, patchOf: (f) => changed.find(([p]) => p === f)?.[1] ?? '', ...(kitFrom ? { kitFrom } : {}) });
    return a.all ? `all: ${a.why}` : a.files;
  };
  const edit = '@@\n-x\n+y';
  assert.deepEqual(pick([['kit/node/store.ts', edit]], 'kit'), ['kit/test/fill.test.ts', 'kit/test/store.test.ts', 'test/a.test.ts'], 'its own tests, and through each copy the fill made');
  const step: [string, string][] = [
    ['kit/VERSION', '@@ -1 +1 @@\n-2.69.0\n+2.70.0'],
    ['kit.json', '@@ -2 +2 @@\n-  "kit": "2.69.0",\n+  "kit": "2.70.0",'],
    ['kit/CHANGELOG.md', edit],
  ];
  assert.deepEqual(pick(step, 'kit'), ['kit/test/version.test.ts', 'test/pin.test.ts'], 'a kit version step: only the tests reading the version where it lies');
  assert.match(String(pick([['kit.json', '@@ -3 +3 @@\n-  "parts": ["node"]\n+  "parts": ["node", "web"]']], 'kit')), /^all: kit\.json changed beyond its kit's version/);
  assert.match(String(pick([['kit/node/store.ts', edit]])), /^all: kit\/node\/store\.ts changed \(the kit itself\)/, "an agent's kit comes from a release");
  assert.match(String(pick(step.slice(1, 2))), /^all: kit\.json changed \(the kit pin\)/);

  assert.equal(versionOnly('@@ -1 +1 @@\n-2.69.0\n+2.70.0', 'kit/VERSION'), true);
  assert.equal(versionOnly('@@ -1 +1 @@\n-2.69.0\n+2.70.0'), false, 'a bare version, but not in a VERSION file');
  assert.equal(versionOnly('@@ -1 +1,2 @@\n-2.69.0\n+2.70.0\n+next', 'kit/VERSION'), false);
  assert.equal(pinOnly('@@ -2 +2 @@\n-  "kit": "2.69.0",\n+  "kit": "2.70.0-beta.1",'), true);
  assert.equal(pinOnly('@@ -2 +2 @@\n-  "kit": "2.69.0",\n+  "kit": "2.70.0",\n+  "parts": []'), false);
  assert.equal(pinOnly(''), false);

  assert.equal(kitFromOf(dir, { kit: 'node tools/kit.ts --from kit' }), 'kit');
  assert.equal(kitFromOf(dir, { pretest: 'node tools/kit.ts --from ./kit/ && node x.js' }), 'kit');
  assert.equal(kitFromOf(dir, { kit: 'node tools/kit.ts --from ../kit' }), null, 'outside the repository');
  assert.equal(kitFromOf(dir, { kit: 'node tools/kit.ts --from src' }), null, 'no VERSION there');
  assert.equal(kitFromOf(dir, { kit: 'node tools/kit.ts' }), null, 'from a release');
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
  const scope: { base: string; chose?: string; files?: number } = { base: 'origin/main' };
  const steps = await affectedSteps(ctx, checkout, scope, (l) => said.push(l));
  assert.deepEqual(steps, ['npm run pretest', 'node --test "test/a.test.ts"']);
  assert.equal(scope.chose, 'affected: 1 of 2 test files');
  assert.equal(scope.files, 1, "how many, for a vouch's time limit");
  assert.match(said.join('\n'), /package\.json: a version step/);

  // Only the changelog and the version: no test runs, its pretest still does.
  sh(checkout, 'switch', '--quiet', '-c', 'claude/notes', 'main');
  writeFileSync(path.join(checkout, 'CHANGELOG.md'), '# Changelog\n\n## 0.4.1\n');
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'notes');
  const none: { base: string; chose?: string } = { base: 'origin/main' };
  assert.deepEqual(await affectedSteps(ctx, checkout, none, () => {}), ['npm run pretest']);
  assert.equal(none.chose, 'no test reaches the change');

  // A base git can't find: the whole suite, as node itself too, so the checks pace sees its test runner.
  const lost: { base: string; chose?: string } = { base: 'origin/nowhere' };
  assert.deepEqual(await affectedSteps(ctx, checkout, lost, () => {}), ['npm run pretest', 'node --test "test/**/*.test.ts"']);
  assert.equal(lost.chose, 'the whole suite');
});
