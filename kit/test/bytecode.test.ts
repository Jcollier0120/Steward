import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A release's code as V8 bytecode (bytecode.ts, kit 2.152.0): no module's source in it, and it runs as it did.
const steward = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bytecode-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const {
  BYTECODE_ARCHES, NODE_PINS, RUNTIME_NODE, buildBytecode, bytecodeNodes, bytecodeRelease, entryStubOf, isServerModule, jscFor, jscNode, keepOwnBytecode, nodeFor, nodeKey, stubOf, withoutTopLevelAwait,
} = await import('../node/bytecode.ts');
const { loadEsbuild } = await import('../node/minify.ts');

const loaded = await loadEsbuild(steward);
if ('error' in loaded) throw new Error(loaded.error);
const esbuild = loaded;
const here = { arch: process.arch, version: process.version, exe: process.execPath };

function write(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
}

test('a published release is built for the Node.js Castellan brings, on Arm64 and x64; each is pinned as Manor\'s setup pins it', async () => {
  assert.equal(RUNTIME_NODE, 'v22.23.3');
  assert.deepEqual([...BYTECODE_ARCHES], ['arm64', 'x64']);
  for (const arch of BYTECODE_ARCHES) {
    const pin = NODE_PINS[`${arch}-${RUNTIME_NODE}`];
    assert.equal(pin.zip, `node-${RUNTIME_NODE}-win-${arch}.zip`);
    assert.match(pin.zipSha256, /^[0-9a-f]{64}$/);
    assert.match(pin.exeSha256, /^[0-9a-f]{64}$/);
  }
  // One not published is built for the Node.js building it, which needs no download.
  assert.deepEqual(await bytecodeNodes(false), [here]);
  assert.deepEqual(await nodeFor(process.arch, process.version), here);
  await assert.rejects(nodeFor('arm64', 'v1.2.3', { cache: tmp }), /no Node\.js v1\.2\.3 for arm64 is pinned/);
});

test("names: a module's bytecode beside it, by processor and Node.js; the server's modules are the .js outside a web folder", () => {
  assert.equal(nodeKey({ arch: 'arm64', version: 'v22.23.3' }), 'arm64-v22.23.3');
  assert.equal(jscFor('src/kit/license.js', { arch: 'x64', version: 'v22.23.3' }), 'src/kit/license.x64-v22.23.3.jsc');
  assert.deepEqual(jscNode('license.x64-v22.23.3.jsc'), { arch: 'x64', version: 'v22.23.3' });
  assert.equal(jscNode('license.js'), null);
  assert.ok(isServerModule('src/cli.js') && isServerModule('src/kit/core/turns.js'));
  assert.ok(!isServerModule('src/web/page.js') && !isServerModule('src/kit/web/settings-panel.js') && !isServerModule('web/app.js') && !isServerModule('src/cli.ts'));
  assert.equal(stubOf('src/cli.js', ''), 'require("./kit/run-bytecode.cjs")(module,require,__filename,__dirname);\n');
  assert.equal(stubOf('src/kit/core/turns.js', '0&&(module.exports={a});'), 'require("../run-bytecode.cjs")(module,require,__filename,__dirname);0&&(module.exports={a});\n');
  assert.equal(entryStubOf("import './cli.js';\n"), "require('./cli.js');\n");
  assert.equal(entryStubOf("import { x } from './cli.js';\n"), null);
  assert.deepEqual(bytecodeRelease({ node: ['v22.23.3'], arch: ['arm64', 'x64'] }), { node: ['v22.23.3'], arch: ['arm64', 'x64'] });
  assert.equal(bytecodeRelease({ node: [], arch: ['x64'] }), undefined);
  assert.equal(bytecodeRelease('bytecode'), undefined);
});

/** Code with no top-level await, run as CommonJS: what it logs, in order. */
function runs(code: string): string[] {
  const cjs = esbuild.transformSync(code, { loader: 'js', format: 'cjs', logLevel: 'silent' }).code;
  const r = spawnSync(process.execPath, ['-e', `const log=[];const say=(x)=>log.push(String(x));const tick=()=>new Promise((r)=>setTimeout(r,5));${cjs};setTimeout(()=>console.log(JSON.stringify(log)),200);`], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('top-level awaits go into async functions, in order, chained; await import() in a declaration is a require; any other await there is refused', () => {
  const plain = 'import{a as b}from"./a.js";const c=b();export{c};';
  assert.deepEqual(withoutTopLevelAwait(esbuild, plain, 'plain.js'), { code: plain, wrapped: 0, required: 0 });

  // A CLI's switch, and what comes after it, run in an async function after the declarations before them.
  const cli = 'const U=`usage:\n  go   do it`;const[c]=["go"];switch(c){case"go":await tick();say("went");break;default:say(U)}say("after");';
  const one = withoutTopLevelAwait(esbuild, cli, 'cli.js');
  assert.equal(one.wrapped, 1);
  assert.match(one.code, /^const U = "usage:\\n {2}go {3}do it";\nconst \[c\] = \["go"\];\nvar __tla=\(async\(\)=>\{\nswitch \(c\) \{/);
  assert.deepEqual(runs(one.code), ['went', 'after']);

  // Two runs, a declaration between them, keep their order: the second waits for the first.
  const two = withoutTopLevelAwait(esbuild, 'await tick();say(1);const x=2;for await(const y of [x])say(y);say(3);', 'two.js');
  assert.equal(two.wrapped, 2);
  assert.match(two.code, /__tla=__tla\.then\(async\(\)=>\{/);
  assert.deepEqual(runs(two.code), ['1', '2', '3']);

  const inner = 'async function f(){await tick()}const h=async()=>{await tick()};f();';
  assert.equal(withoutTopLevelAwait(esbuild, inner, 'inner.js').code, inner);

  const req = withoutTopLevelAwait(esbuild, 'const o=u?(await import(d(u).href)).ONBOARDING??null:null;export{o};', 'required.js');
  assert.equal(req.required, 1);
  assert.match(req.code, /const o = u \? \(?__importSync\(d\(u\)\.href\)\)?\.ONBOARDING \?\? null : null;/);

  assert.throws(() => withoutTopLevelAwait(esbuild, 'const v=await fetch(u);export{v};', 'fetches.js'), /fetches\.js couldn't be built as bytecode: it awaits at its top level in a declaration \(const v = await fetch\(u\)/);
});

/** A small release, minified as minify.ts leaves it: ES modules, an entry stub, a page's script, a module awaiting at its top level. */
function stageOf(name: string, extra: Record<string, string> = {}): string {
  const stage = path.join(tmp, name);
  write(stage, {
    'package.json': '{ "type": "module" }\n',
    'src/cli.ts': "import './cli.js';\n",
    'src/cli.js': [
      '#!/usr/bin/env node\n',
      'import v8 from"node:v8";import{greet as g,Box as B,fail as f,here as h}from"./lib.js";import{m}from"./kit/required.js";',
      'const[c]=process.argv.slice(2);',
      'switch(c){case"go":{v8.setFlagsFromString("--expose-gc");const{late:l}=await import("./late.js");const{dyn:d}=await import("./dyn.js");',
      'console.log(JSON.stringify({late:l,greet:g("you"),box:new B(2).twice(),dyn:d,m,here:h.endsWith("/src/lib.js"),meta:import.meta.url.endsWith("/src/cli.js"),source:g.toString().includes("hello"),name:B.name}));',
      'try{f()}catch(e){console.log("stack:"+/lib\\.js:\\d+:\\d+/.test(e.stack))}break}default:console.log("usage")}',
    ].join(''),
    'src/lib.js': 'export function greet(n){return"hello "+n}export class Box{constructor(n){this.n=n}twice(){return this.n*2}}export function fail(){throw new Error("boom")}export const here=import.meta.url;',
    'src/dyn.js': 'export const dyn=42;',
    // Loaded after the CLI sets a V8 flag, as Reeve's MCP server does: V8's flags' hash is another then.
    'src/late.js': 'export const late=7;',
    'src/kit/required.js': 'import{pathToFileURL as p}from"node:url";const m=(await import(new URL("../dyn.js",import.meta.url).href)).dyn;export{m};',
    'src/web/page.js': 'window.page=1;',
    'src/kit/web/settings-panel.js': 'window.panel=1;',
    ...extra,
  });
  return stage;
}

const cliIn = (stage: string, ...args: string[]) => spawnSync(process.execPath, [path.join(stage, 'src', 'cli.ts'), ...args], { encoding: 'utf8', windowsHide: true });

test('a release built as bytecode carries no module source, and runs as it did: imports, import(), import.meta, a top-level await, names and stack traces', () => {
  const stage = stageOf('whole');
  const built = buildBytecode(stage, { esbuild, nodes: [here], id: 'demo' });
  assert.equal(built.modules, 5);
  assert.deepEqual(built.wrapped.sort(), ['src/cli.js', 'src/kit/required.js']);
  assert.deepEqual(built.nodes.map((n) => nodeKey(n)), [nodeKey(here)]);

  // Each module is a stub with its bytecode beside it; the page's scripts, the browser's, are as they were.
  for (const m of ['src/cli.js', 'src/lib.js', 'src/dyn.js', 'src/late.js', 'src/kit/required.js']) {
    assert.match(readFileSync(path.join(stage, m), 'utf8'), /^require\("(\.\/|\.\.\/)?(kit\/)?run-bytecode\.cjs"\)\(module,require,__filename,__dirname\);/);
    assert.ok(existsSync(path.join(stage, jscFor(m, here))), m);
  }
  assert.equal(readFileSync(path.join(stage, 'src/web/page.js'), 'utf8'), 'window.page=1;');
  assert.equal(readFileSync(path.join(stage, 'src/kit/web/settings-panel.js'), 'utf8'), 'window.panel=1;');
  assert.equal(readFileSync(path.join(stage, 'src/cli.ts'), 'utf8'), "require('./cli.js');\n");
  assert.deepEqual(JSON.parse(readFileSync(path.join(stage, 'src/package.json'), 'utf8')), { type: 'commonjs' });
  assert.ok(existsSync(path.join(stage, 'src/kit/run-bytecode.cjs')));
  // The code is nowhere: its strings are, but not what is done with them; nor this PC's folder.
  const lib = readFileSync(path.join(stage, jscFor('src/lib.js', here)));
  assert.ok(lib.includes('hello '));
  assert.ok(!lib.includes('"hello "+') && !lib.includes('return'), 'no source text in the bytecode');
  assert.ok(!lib.includes(Buffer.from(tmp)), "the build's own folder isn't in it");
  // An import() of a stub still has its named exports: esbuild's note of them is on the stub.
  assert.match(readFileSync(path.join(stage, 'src/dyn.js'), 'utf8'), /0&&\(module\.exports=\{dyn\}\);/);

  const r = cliIn(stage, 'go');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/, 'its import() says nothing of the loader it uses');
  const [line, stack] = r.stdout.trim().split(/\r?\n/);
  assert.deepEqual(JSON.parse(line), { late: 7, greet: 'hello you', box: 4, dyn: 42, m: 42, here: true, meta: true, source: false, name: 'Box' });
  assert.equal(stack, 'stack:true');
  assert.equal(cliIn(stage).stdout.trim(), 'usage');
});

test("installed, it keeps the bytecode for the Node.js running it; for another Node.js, it says which it runs on, and nothing goes", () => {
  const app = path.join(tmp, 'app');
  const files = ['cli.arm64-v22.23.3.jsc', 'cli.x64-v22.23.3.jsc', 'cli.arm64-v24.1.0.jsc', 'kit/x.x64-v22.23.3.jsc', 'cli.js'];
  write(app, Object.fromEntries(files.map((f) => [`src/${f}`, 'x'])));
  const r = { node: ['v22.23.3', 'v24.1.0'], arch: ['arm64', 'x64'] };
  assert.match(keepOwnBytecode(app, r, { arch: 'x64', version: 'v20.0.0' })!, /runs on Node\.js v22\.23\.3 or v24\.1\.0 for arm64 or x64, and this is Node\.js v20\.0\.0 for x64/);
  assert.equal(readdirSync(path.join(app, 'src')).length, 5);
  assert.equal(keepOwnBytecode(app, r, { arch: 'x64', version: 'v22.23.3' }), null);
  assert.deepEqual(readdirSync(path.join(app, 'src')).sort(), ['cli.js', 'cli.x64-v22.23.3.jsc', 'kit']);
  assert.deepEqual(readdirSync(path.join(app, 'src', 'kit')), ['x.x64-v22.23.3.jsc']);
  assert.equal(keepOwnBytecode(app, undefined), null);
});

test("a module whose bytecode isn't this Node.js's stops with words that say which Node.js it runs on", () => {
  const stage = stageOf('other-node');
  buildBytecode(stage, { esbuild, nodes: [here], id: 'demo' });
  const other = { arch: process.arch, version: 'v99.0.0' };
  for (const m of ['src/cli.js', 'src/lib.js', 'src/dyn.js', 'src/kit/required.js']) renameSync(path.join(stage, jscFor(m, here)), path.join(stage, jscFor(m, other)));
  const r = cliIn(stage, 'go');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`cli\\.js can't run here: the release has no bytecode for this Node\\.js\\. It runs on Node\\.js v99\\.0\\.0 for ${process.arch}, and this is Node\\.js ${process.version.replace(/\./g, '\\.')} for ${process.arch}\\. Castellan's setup brings`));
  // Bytecode another V8 made (here, made up) is turned down the same way.
  writeFileSync(path.join(stage, jscFor('src/cli.js', here)), Buffer.alloc(64));
  assert.match(cliIn(stage, 'go').stderr, /cli\.js can't run here: this Node\.js turned its bytecode down/);
});

test("a release isn't built when a module can't load as bytecode, or TypeScript source is left", () => {
  const broken = stageOf('broken', { 'src/bad.js': 'import{nothing}from"./lib.js";nothing();' });
  assert.throws(() => buildBytecode(broken, { esbuild, nodes: [here], id: 'demo' }), /Not built: its bytecode doesn't load on Node\.js .*: src\/bad\.js: TypeError/);
  const source = stageOf('source', { 'src/left.ts': 'export const x: number = 1;\n' });
  assert.throws(() => buildBytecode(source, { esbuild, nodes: [here] }), /src\/left\.ts is TypeScript source, and a release carries none/);
  const meta = stageOf('meta', { 'src/meta.js': 'export const r=import.meta.resolve("./lib.js");' });
  assert.throws(() => buildBytecode(meta, { esbuild, nodes: [here] }), /src\/meta\.js couldn't be built as bytecode: .*import\.meta/);
  // A script that does its work, and ends, whenever it's loaded would end the check with the modules after it unloaded:
  // it isn't built, and what it writes where it runs never lands in the release.
  const script = stageOf('script', { 'src/kit/job.js': 'import{writeFileSync as w}from"node:fs";w("result.json","{}");process.exit(0);' });
  assert.throws(() => buildBytecode(script, { esbuild, nodes: [here], id: 'demo' }), /Not built: its bytecode doesn't load on Node\.js .*: src\/kit\/job\.js: it ends the process as it loads \(process\.exit\(0\)\)/);
  assert.ok(!existsSync(path.join(script, 'result.json')) && !existsSync(path.join(script, 'src', 'result.json')));
});
