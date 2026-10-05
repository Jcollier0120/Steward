import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A release's code, built (minify.ts): each .ts minified to a .js where it was, the entry kept as a stub.
const steward = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'minify-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const { ENTRY_STUBS, builtSpecifier, loadEsbuild, minifyRelease, stubFor } = await import('./fixture/src/kit/minify.ts');

test('an import of a relative .ts points at its .js; a package, node:, .d.ts or anything else is as it was', () => {
  assert.equal(builtSpecifier('./a.ts'), './a.js');
  assert.equal(builtSpecifier('../kit/b.ts'), '../kit/b.js');
  assert.equal(builtSpecifier('node:fs'), 'node:fs');
  assert.equal(builtSpecifier('some-package/x.ts'), 'some-package/x.ts');
  assert.equal(builtSpecifier('./core/index.js'), './core/index.js');
  assert.equal(builtSpecifier('./types.d.ts'), './types.d.ts');
  assert.deepEqual(ENTRY_STUBS, ['src/cli.ts']);
  assert.equal(stubFor('src/cli.ts'), "import './cli.js';\n");
});

test('esbuild is found in the agent, or where STEWARD_ESBUILD says; else what to do', async () => {
  const none = path.join(tmp, 'no-esbuild');
  mkdirSync(none, { recursive: true });
  writeFileSync(path.join(none, 'package.json'), '{}');
  const was = process.env.STEWARD_ESBUILD;
  delete process.env.STEWARD_ESBUILD;
  try {
    assert.match((await loadEsbuild(none) as { error: string }).error, /esbuild isn't installed here.*npm install/);
    process.env.STEWARD_ESBUILD = steward;
    const e = await loadEsbuild(none);
    assert.ok(!('error' in e) && typeof e.build === 'function');
  } finally {
    if (was === undefined) delete process.env.STEWARD_ESBUILD;
    else process.env.STEWARD_ESBUILD = was;
  }
});

test('a release built: a minified .js beside each .ts, the entry a stub, .d.ts gone; and it runs as before', async () => {
  const esbuild = await loadEsbuild(steward);
  assert.ok(!('error' in esbuild));
  const stage = path.join(tmp, 'stage');
  const put = (f: string, text: string) => {
    mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    writeFileSync(path.join(stage, f), text);
  };
  put('package.json', '{ "type": "module" }');
  put('src/cli.ts', [
    "import { greet } from './greet.ts';",
    "import { readNext } from './kit/next.ts';",
    "import { rules } from './kit/core/rules.js';",
    "import type { Unused } from './types.ts';",
    "import './side.ts';",
    '// A comment that never ships.',
    'class Keeper { kept = true }',
    "const later = await import('./later.ts');",
    "const written = \"import '../src/kit/agent-checks.ts';\";",
    "console.log(greet('manor'), readNext(), new Keeper().constructor.name, rules.waitMs, later.word, (globalThis as any).sideRan, written);",
  ].join('\n'));
  put('src/greet.ts', "export const greet = (who: string): string => `hello, ${who}`;\n");
  put('src/types.ts', 'export interface Unused { x: number }\n');
  put('src/side.ts', '(globalThis as any).sideRan = "side";\n');
  put('src/later.ts', "export const word = 'later';\n");
  put('src/kit/next.ts', [
    "import { readFileSync } from 'node:fs';",
    "import path from 'node:path';",
    '/** Reads a file beside itself, as the kit reads rules.json. */',
    "export const readNext = (): string => readFileSync(path.join(import.meta.dirname, 'beside.txt'), 'utf8').trim();",
  ].join('\n'));
  put('src/kit/beside.txt', 'found\n');
  put('src/kit/core/rules.js', 'export const rules = { waitMs: 1000 }; // the core is JavaScript\n');
  put('src/kit/core/rules.d.ts', 'export declare const rules: { waitMs: number };\n');
  put('src/kit/web/themes.css', ':root[data-theme="dark"] {\n  --bg: #000;\n}\n');
  put('src/kit/web/panel.js', 'const panelName = "settings"; function openPanel() { return panelName; }\n');
  put('src/run.ps1', "Write-Output 'left as it is'\n");

  const m = await minifyRelease(stage, esbuild as never);
  assert.deepEqual({ ts: m.ts, js: m.js }, { ts: 6, js: 2 });
  assert.equal(readFileSync(path.join(stage, 'src/cli.ts'), 'utf8'), "import './cli.js';\n", 'the entry is a stub');
  for (const gone of ['src/greet.ts', 'src/types.ts', 'src/kit/next.ts', 'src/kit/core/rules.d.ts']) assert.ok(!existsSync(path.join(stage, gone)), gone);
  const cli = readFileSync(path.join(stage, 'src/cli.js'), 'utf8');
  assert.doesNotMatch(cli, /A comment that never ships/);
  assert.match(cli, /"\.\/greet\.js"/);
  assert.match(cli, /import"\.\/side\.js"/, 'an import kept for what loading it does stays');
  assert.match(cli, /import\("\.\/later\.js"\)/, 'a dynamic import too');
  assert.match(cli, /import '\.\.\/src\/kit\/agent-checks\.ts';/, 'an import written in a string is a string: left as it is');
  assert.equal(readFileSync(path.join(stage, 'src/kit/web/themes.css'), 'utf8'), ':root[data-theme="dark"] {\n  --bg: #000;\n}\n', 'CSS as it was: Manor reads themes.css as text');
  assert.match(readFileSync(path.join(stage, 'src/kit/web/panel.js'), 'utf8'), /panelName.*function openPanel/, 'a classic script keeps its global names');
  assert.equal(readFileSync(path.join(stage, 'src/run.ps1'), 'utf8'), "Write-Output 'left as it is'\n");

  const r = spawnSync(process.execPath, [path.join(stage, 'src', 'cli.ts')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "hello, manor found Keeper 1000 later side import '../src/kit/agent-checks.ts';", 'runs from the stub; finds what is beside it; keeps names');
});

test("a file esbuild can't read stops the build, naming it", async () => {
  const esbuild = await loadEsbuild(steward);
  const stage = path.join(tmp, 'broken');
  mkdirSync(path.join(stage, 'src'), { recursive: true });
  writeFileSync(path.join(stage, 'src', 'cli.ts'), 'export const = ;\n');
  await assert.rejects(minifyRelease(stage, esbuild as never), /^Error: src\/cli\.ts couldn't be built: /);
});
