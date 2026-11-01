import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A release's code, built (minify.ts): each .ts minified to a .js where it was, the entry kept as a stub.
const steward = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'minify-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const { ENTRY_STUBS, builtSpecifier, importsLeftOut, loadEsbuild, minifyRelease, stubFor } = await import('./fixture/src/kit/minify.ts');

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

test("a released agent's notes name it: the kit reads its app.js, as it reads app.ts in a checkout", async () => {
  const esbuild = await loadEsbuild(steward);
  assert.ok(!('error' in esbuild));
  const stage = path.join(tmp, 'fixture');
  cpSync(path.join(steward, 'kit', 'test', 'fixture'), stage, { recursive: true, filter: (f) => !f.includes('node_modules') });
  await minifyRelease(stage, esbuild as never);
  assert.ok(!existsSync(path.join(stage, 'src', 'app.ts')) && existsSync(path.join(stage, 'src', 'app.js')));
  const kit = pathToFileURL(path.join(stage, 'src', 'kit', 'accelerators.js')).href;
  const script = `const A = await import(${JSON.stringify(kit)}); console.log([A.noteLabel(null), A.noteLabel({ id: 'npu', name: 'Snapdragon X2 Elite NPU' }, true, 'caption')].join(' | '))`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'summary from the Fixture | caption from the Fixture, written on the Snapdragon X2 Elite NPU');
  assert.equal(r.stderr, '', 'no warning for loading app.js');
});

test("a file esbuild can't read stops the build, naming it", async () => {
  const esbuild = await loadEsbuild(steward);
  const stage = path.join(tmp, 'broken');
  mkdirSync(path.join(stage, 'src'), { recursive: true });
  writeFileSync(path.join(stage, 'src', 'cli.ts'), 'export const = ;\n');
  await assert.rejects(minifyRelease(stage, esbuild as never), /^Error: src\/cli\.ts couldn't be built: /);
});

/** A stage of `files` (relative paths) in a folder of its own. */
function stageOf(name: string, files: Record<string, string>): string {
  const stage = path.join(tmp, name);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    writeFileSync(path.join(stage, f), text);
  }
  return stage;
}

// Each kind of value import, of a file a release leaves out: src/web's files but the page's bundle and the kit's react
// part (react-page.ts' releasePage), and a test (outside src).
const LEFT_OUT: [string, string, string][] = [
  ['an import', "import { quote } from './web/ps-arg.ts';\nconsole.log(quote);\n", 'src/web/ps-arg.ts'],
  ['an import kept for what loading it does', "import './web/ps-arg.ts';\n", 'src/web/ps-arg.ts'],
  ["an import of nothing but a type, inline (Node and the release keep it as import './x.js')", "import { type Arg } from './web/ps-arg.ts';\nexport const a: Arg | null = null;\n", 'src/web/ps-arg.ts'],
  ['an export … from', "export { quote } from './web/ps-arg.ts';\n", 'src/web/ps-arg.ts'],
  ['an export * from', "export * from '../test/helpers.ts';\n", 'test/helpers.ts'],
  ['an import() of a literal', "export const load = () => import('./kit/react/index.ts');\n", 'src/kit/react/index.ts'],
  ['an import() of a template literal', 'export const load = () => import(`./web/ps-arg.ts`);\n', 'src/web/ps-arg.ts'],
];

test('a release whose code imports a file it doesn\'t carry isn\'t built, naming the file and what it imports, for each kind of value import', async () => {
  const esbuild = await loadEsbuild(steward);
  assert.ok(!('error' in esbuild));
  for (const [i, [kind, code, missing]] of LEFT_OUT.entries()) {
    const stage = stageOf(`left-out-${i}`, { 'package.json': '{ "type": "module" }', 'src/cli.ts': "import './assistants.ts';\n", 'src/assistants.ts': code });
    const dynamic = code.includes('import(');
    assert.deepEqual(await importsLeftOut(stage, esbuild as never), [{ file: 'src/assistants.ts', imports: missing, dynamic }], kind);
    await assert.rejects(
      minifyRelease(stage, esbuild as never),
      (e: Error) => {
        assert.ok(e.message.startsWith(`Not built: its code imports what the release doesn't carry, so the installed agent would stop there (ERR_MODULE_NOT_FOUND): src/assistants.ts imports ${missing}${dynamic ? ' (with import())' : ''}. `), `${kind}: ${e.message}`);
        assert.match(e.message, /import its types alone \(import type\)\.$/);
        return true;
      },
      kind,
    );
    assert.equal(readFileSync(path.join(stage, 'src/assistants.ts'), 'utf8'), code, `${kind}: nothing built`);
    assert.ok(!existsSync(path.join(stage, 'src/assistants.js')), kind);
  }
});

test("Reeve 0.19.10's release: the page's sources left out by releasePage, and the server's import of one refuses the build", async () => {
  const { releasePage } = await import('./fixture/src/kit/react-page.ts');
  const esbuild = await loadEsbuild(steward);
  assert.ok(!('error' in esbuild));
  const stage = stageOf('reeve-0.19.10', {
    'package.json': '{ "type": "module" }',
    'src/cli.ts': "import { start } from './assistants.ts';\nstart();\n",
    'src/assistants.ts': "import { psArg } from './web/ps-arg.ts';\nimport type { Shown } from './web/types.ts';\nexport const start = (s?: Shown) => psArg(String(s));\n",
    'src/web/main.tsx': "import { psArg } from './ps-arg.ts';\ndocument.title = psArg('page');\n",
    'src/web/ps-arg.ts': "export const psArg = (s: string) => `'${s.replace(/'/g, \"''\")}'`;\n",
    'src/web/types.ts': 'export interface Shown { name: string }\n',
  });
  assert.ok(await releasePage(stage, steward, esbuild as never));
  assert.deepEqual(readdirSync(path.join(stage, 'src', 'web')), ['page.js']);
  await assert.rejects(minifyRelease(stage, esbuild as never), /^Error: Not built: .*: src\/assistants\.ts imports src\/web\/ps-arg\.ts\. /);
});

test('a release whose code imports only what it carries, types alone of what it leaves out, and nothing by a literal it can read is built', async () => {
  const esbuild = await loadEsbuild(steward);
  assert.ok(!('error' in esbuild));
  const stage = stageOf('carried', {
    'package.json': '{ "type": "module", "version": "1.0.0" }',
    'src/cli.ts': [
      "import type { Shown } from './web/types.ts';",
      "export type { Shown } from './web/types.ts';",
      "import { type Rule, rules } from './kit/core/rules.js';",
      "import type { Declared } from './kit/core/rules.d.ts';",
      "import { greet } from './greet.ts';",
      "import pkg from '../package.json' with { type: 'json' };",
      "import { readFileSync } from 'node:fs';",
      "import esbuild from 'esbuild';",
      "const name = './web/ps-arg.ts';",
      'export const later = () => import(name);',
      "const written = \"import './web/ps-arg.ts';\";",
      "export const all = (s: Shown, r: Rule, d: Declared) => [greet(s.name), r, d, rules, pkg.version, readFileSync, esbuild, written];",
    ].join('\n'),
    'src/greet.ts': "export const greet = (who: string): string => `hello, ${who}`;\n",
    'src/kit/core/rules.js': 'export const rules = { waitMs: 1000 };\n',
    'src/kit/core/rules.d.ts': 'export type Rule = number;\nexport type Declared = string;\nexport declare const rules: { waitMs: number };\n',
    'src/web/page.js': 'document.title = "the page";\n',
  });
  assert.deepEqual(await importsLeftOut(stage, esbuild as never), []);
  const m = await minifyRelease(stage, esbuild as never);
  assert.deepEqual({ ts: m.ts, js: m.js }, { ts: 2, js: 2 });
});

test('a stage reached through a link (a temp folder on a Dev Drive) names what it leaves out as from its root, and builds what it carries', async () => {
  const esbuild = await loadEsbuild(steward);
  assert.ok(!('error' in esbuild));
  const linked = (name: string, files: Record<string, string>) => {
    const link = path.join(tmp, `${name}-link`);
    symlinkSync(stageOf(name, files), link, 'junction');
    return link;
  };
  const leftOut = linked('linked-left-out', { 'package.json': '{ "type": "module" }', 'src/cli.ts': "import './assistants.ts';\n", 'src/assistants.ts': "import { quote } from './web/ps-arg.ts';\nexport const q = quote;\n" });
  assert.deepEqual(await importsLeftOut(leftOut, esbuild as never), [{ file: 'src/assistants.ts', imports: 'src/web/ps-arg.ts', dynamic: false }]);
  const carried = linked('linked-carried', { 'package.json': '{ "type": "module" }', 'src/cli.ts': "import { greet } from './greet.ts';\nexport const hi = greet;\n", 'src/greet.ts': 'export const greet = (who: string): string => `hello, ${who}`;\n' });
  assert.deepEqual(await importsLeftOut(carried, esbuild as never), []);
});
