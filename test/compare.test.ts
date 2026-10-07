import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareTrees, withoutName, type Tree } from '../tools/lib/compare.ts';
import { relocate, specifier } from '../tools/lib/relocate.ts';

// Working out the kit: which files every hire has the same, and moving them without breaking imports.

const tree = (id: string, files: Record<string, string>): Tree => ({ id, files: new Map(Object.entries(files)) });

test('a file the same in every hire is a kit file; a project file the same everywhere stays the project\'s', () => {
  const c = compareTrees([
    tree('porter', { 'src/npu.ts': 'x', 'tsconfig.json': '{}', 'src/app.ts': "id: 'porter'" }),
    tree('clerk', { 'src/npu.ts': 'x', 'tsconfig.json': '{}', 'src/app.ts': "id: 'clerk'" }),
  ]);
  assert.deepEqual(c.kit, ['src/npu.ts']);
  assert.deepEqual(c.project, ['tsconfig.json']);
});

test("a file the same but for each hire's name (and its PORTER_HOME form) is told apart", () => {
  const t = (id: string) => `const home = mkdtempSync('${id}-test-'); process.env.${id.toUpperCase()}_HOME = home;`;
  const c = compareTrees([tree('porter', { 'test/kit.test.ts': t('porter') }), tree('pinder', { 'test/kit.test.ts': t('pinder') }), tree('some-agent', { 'test/kit.test.ts': t('some-agent').replace('SOME-AGENT', 'SOME_AGENT') })]);
  assert.deepEqual(c.sameButName, ['test/kit.test.ts']);
  assert.deepEqual(c.kit, []);
  assert.equal(withoutName("x('some-agent-'); SOME_AGENT_HOME", 'some-agent'), "x('<id>-'); <ID>_HOME");
});

test('a file the same in most hires is near-identical, naming the ones that differ; one missing anywhere is per-agent', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const c = compareTrees(
    ids.map((id) => tree(id, { 'src/cli.ts': id === 'b' ? 'run, audit' : id === 'c' ? 'run, search' : 'run', ...(id === 'a' ? { 'src/rules.ts': 'r' } : {}) })),
  );
  assert.deepEqual(c.near, [{ path: 'src/cli.ts', same: ['a', 'd', 'e', 'f', 'g', 'h'], differ: ['b', 'c'] }]);
  assert.deepEqual(c.perAgent, ['src/rules.ts']);
});

test('a file different in most hires is per-agent', () => {
  const c = compareTrees([tree('a', { 'src/view.ts': '1' }), tree('b', { 'src/view.ts': '2' }), tree('c', { 'src/view.ts': '3' })]);
  assert.deepEqual(c.perAgent, ['src/view.ts']);
  assert.deepEqual(c.near, []);
});

test('a specifier is written from where the file is to where its target is', () => {
  assert.equal(specifier('src/agent.ts', 'src/kit/npu.ts'), './kit/npu.ts');
  assert.equal(specifier('src/watch/arrivals.ts', 'src/kit/ps.ts'), '../kit/ps.ts');
  assert.equal(specifier('src/kit/npu.ts', 'src/app.ts'), '../app.ts');
  assert.equal(specifier('kit/test/kit.test.ts', 'kit/test/fixture/src/kit/server.ts'), './fixture/src/kit/server.ts');
});

test('relocating rewrites static, dynamic, type and new URL specifiers, and leaves node: and packages alone', () => {
  const text = [
    "import { readFileSync } from 'node:fs';",
    "import { Npu } from './npu.ts';",
    "import type { Field } from './settings-kit.ts';",
    "import { APP } from './app.ts';",
    "const { serve } = await import('./server.ts');",
    "type X = import('./accelerators.ts').Accelerator;",
    "const PANEL = new URL('./settings-panel.js', import.meta.url);",
    "import ts from 'typescript';",
  ].join('\n');
  const kit = ['src/npu.ts', 'src/settings-kit.ts', 'src/server.ts', 'src/accelerators.ts'];
  const move = (p: string) => (kit.includes(p) ? `src/kit/${p.slice(4)}` : p === 'src/settings-panel.js' ? 'src/kit/web/settings-panel.js' : p);
  // An agent's own file stays where it is; what it imports from the kit moved.
  const own = relocate(text, 'src/agent.ts', 'src/agent.ts', move);
  assert.match(own.text, /from '\.\/kit\/npu\.ts'/);
  assert.match(own.text, /import type \{ Field \} from '\.\/kit\/settings-kit\.ts'/);
  assert.match(own.text, /import\('\.\/kit\/server\.ts'\)/);
  assert.match(own.text, /import\('\.\/kit\/accelerators\.ts'\)\.Accelerator/);
  assert.match(own.text, /new URL\('\.\/kit\/web\/settings-panel\.js'/);
  assert.match(own.text, /from '\.\/app\.ts'/);
  assert.match(own.text, /from 'node:fs'/);
  assert.match(own.text, /from 'typescript'/);
  assert.equal(own.changed.length, 5);
  // A kit file moved into src/kit: its kit neighbours stay beside it, the agent's own files are a level up.
  const moved = relocate(text, 'src/server.ts', 'src/kit/server.ts', move);
  assert.match(moved.text, /from '\.\/npu\.ts'/);
  assert.match(moved.text, /from '\.\.\/app\.ts'/);
  assert.match(moved.text, /new URL\('\.\/web\/settings-panel\.js'/);
});
