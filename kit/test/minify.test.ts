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

const { ENTRY_STUBS, loadEsbuild, minifyRelease, stubFor, toJsSpecifiers } = await import('./fixture/src/kit/minify.ts');

test("imports of other .ts files point at their .js: static, side-effect, dynamic and new URL; nothing else changes", () => {
  const src = [
    "import { a } from './a.ts';",
    'import b from "../b.ts";',
    "import './side.ts';",
    "export { c } from './dir/c.ts';",
    "const d = await import('./d.ts');",
    "const w = new URL('./worker.ts', import.meta.url);",
    "import fs from 'node:fs';",
    "import { x } from 'some-package/x.ts';",
    "const name = 'cli.ts';",
    "spawn(node, [path.join(app, 'src', 'cli.ts')]);",
  ].join('\n');
  assert.equal(toJsSpecifiers(src), [
    "import { a } from './a.js';",
    'import b from "../b.js";',
    "import './side.js';",
    "export { c } from './dir/c.js';",
    "const d = await import('./d.js');",
    "const w = new URL('./worker.js', import.meta.url);",
    "import fs from 'node:fs';",
    "import { x } from 'some-package/x.ts';",
    "const name = 'cli.ts';",
    "spawn(node, [path.join(app, 'src', 'cli.ts')]);",
  ].join('\n'));
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
    assert.ok(!('error' in e) && typeof e.transformSync === 'function');
  } finally {
    if (was === undefined) delete process.env.STEWARD_ESBUILD;
    else process.env.STEWARD_ESBUILD = was;
  }
});

test('a release built: minified .js beside where each .ts was, the entry a stub, .d.ts gone, .css minified; and it runs as before', async () => {
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
    "import type { Unused } from './types.ts';",
    '// A comment that never ships.',
    'class Keeper { kept = true }',
    "console.log(greet('manor'), readNext(), new Keeper().constructor.name);",
  ].join('\n'));
  put('src/greet.ts', "export const greet = (who: string): string => `hello, ${who}`;\n");
  put('src/types.ts', 'export interface Unused { x: number }\n');
  put('src/kit/next.ts', [
    "import { readFileSync } from 'node:fs';",
    "import path from 'node:path';",
    '/** Reads a file beside itself, as the kit reads rules.json. */',
    "export const readNext = (): string => readFileSync(path.join(import.meta.dirname, 'beside.txt'), 'utf8').trim();",
  ].join('\n'));
  put('src/kit/beside.txt', 'found beside\n');
  put('src/kit/core/rules.js', 'export const rules = { waitMs: 1000 }; // the core is JavaScript\n');
  put('src/kit/core/rules.d.ts', 'export declare const rules: { waitMs: number };\n');
  put('src/kit/web/page.css', '.a {\n  color: red;\n}\n');
  put('src/run.ps1', "Write-Output 'left as it is'\n");

  const m = minifyRelease(stage, esbuild as never);
  assert.deepEqual({ ts: m.ts, js: m.js, css: m.css }, { ts: 4, js: 1, css: 1 });
  assert.ok(m.before > 0 && m.after > 0, "the bytes are counted (tiny files grow by esbuild's keepNames helper; a real release halves)");
  assert.equal(readFileSync(path.join(stage, 'src/cli.ts'), 'utf8'), "import './cli.js';\n", 'the entry is a stub');
  for (const gone of ['src/greet.ts', 'src/types.ts', 'src/kit/next.ts', 'src/kit/core/rules.d.ts']) assert.ok(!existsSync(path.join(stage, gone)), gone);
  const cli = readFileSync(path.join(stage, 'src/cli.js'), 'utf8');
  assert.doesNotMatch(cli, /A comment that never ships|\.ts['"]/);
  assert.match(cli, /from"\.\/greet\.js"/);
  assert.equal(readFileSync(path.join(stage, 'src/kit/web/page.css'), 'utf8').trim(), '.a{color:red}');
  assert.equal(readFileSync(path.join(stage, 'src/run.ps1'), 'utf8'), "Write-Output 'left as it is'\n");

  const r = spawnSync(process.execPath, [path.join(stage, 'src', 'cli.ts')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'hello, manor found beside Keeper', 'runs from the stub; a file beside a module is found; names are kept');
});

test("a file esbuild can't read stops the build, naming it", async () => {
  const esbuild = await loadEsbuild(steward);
  const stage = path.join(tmp, 'broken');
  mkdirSync(path.join(stage, 'src'), { recursive: true });
  writeFileSync(path.join(stage, 'src', 'cli.ts'), 'export const = ;\n');
  assert.throws(() => minifyRelease(stage, esbuild as never), /^Error: src\/cli\.ts couldn't be built: /);
});
