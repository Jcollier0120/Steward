import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Esbuild } from './minify.ts';

/**
 * A release's code as V8 bytecode, never as source (kit 2.152.0, spec/RELEASES.md "Bytecode"). After minify.ts has
 * built each module to a minified .js, each one the server runs (every .js but a `web` folder's, which the browser
 * runs) is compiled by V8 itself, as Node.js would compile it, and what V8 keeps of it (its code cache) is written
 * beside it for each processor and Node.js it runs on: `cli.arm64-v22.23.3.jsc`, `cli.x64-v22.23.3.jsc`. The .js
 * becomes a one-line stub that hands its module to the kit's loader (run-bytecode.cjs), which has V8 take that cache
 * in place of the source. No module's source, minified or not, is in the release.
 *
 * - **CommonJS, so V8 can take it:** each module is turned from an ES module into CommonJS by esbuild first, with
 *   `import.meta.url`, `.dirname` and `.filename` as the stub's own, and its exports' names noted on the stub as
 *   esbuild notes them (`0&&(module.exports={...})`), so an `import()` of it still has its named exports. `src\` is
 *   CommonJS from then on (its package.json says so), and the entry stubs (src\cli.ts) `require` their module.
 * - **Top-level await** (a CLI's switch, a module's run-as-a-script block), which CommonJS doesn't have: each run of
 *   statements from one that awaits goes into an async function of its own, chained after the one before, in order
 *   (withoutTopLevelAwait, with esbuild as its parser). An `await import(x)` in a declaration is a plain `require` of
 *   x. Any other await in a declaration isn't built: it says where.
 * - **Every function compiled at once** (`--no-lazy`), with its source positions (`--no-enable-lazy-source-positions`),
 *   so V8 never needs the source later: a stack trace still has each file, line and column.
 * - **For each Node.js and processor:** V8's cache is good only for the V8 that made it, on its processor. A published
 *   release is built for Node.js RUNTIME_NODE, the one Castellan's setup brings, for Arm64 and x64; an Arm PC runs both
 *   (x64's emulated), an x64 PC only x64's. A release that isn't published is built for the Node.js building it.
 * - **Checked before it's zipped:** each Node.js loads every module it was built for (smokeTest), in a process whose
 *   home is a temporary folder, so a module that can't load as bytecode stops the release, not an installed agent.
 *
 * esbuild, each agent's devDependency, is all it needs.
 */

/** The Node.js Castellan's setup brings and the staff run on: Manor's setup/Manor.Setup/NodeRuntime.cs, Version. */
export const RUNTIME_NODE = 'v22.23.3';
/** The processors a published release's bytecode is built for. */
export const BYTECODE_ARCHES = ['arm64', 'x64'] as const;

/** nodejs.org's Node.js for Windows, per processor and version: its zip, and the SHA-256s SHASUMS256.txt gives it and its node.exe (as Manor's setup pins them). */
export const NODE_PINS: Record<string, { zip: string; zipSha256: string; exeSha256: string }> = {
  'arm64-v22.23.3': {
    zip: 'node-v22.23.3-win-arm64.zip',
    zipSha256: '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535',
    exeSha256: 'b5a3165ec6f24c0b1fe2a10fed58e03f6c1d7d141beb3b225ff030ceac6c5eb5',
  },
  'x64-v22.23.3': {
    zip: 'node-v22.23.3-win-x64.zip',
    zipSha256: '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71',
    exeSha256: '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e',
  },
};

/** The loader every stub calls, relative to a release's root. */
export const LOADER = 'src/kit/run-bytecode.cjs';

/** A Node.js a release's bytecode is built by and for. */
export interface BytecodeNode {
  /** As Node names it: arm64, x64. */
  arch: string;
  /** As process.version says it: v22.23.3. */
  version: string;
  /** Its node.exe. */
  exe: string;
}

/** How a Node.js is named in its bytecode's file names: arm64-v22.23.3. */
export const nodeKey = (n: { arch: string; version: string }) => `${n.arch}-${n.version}`;

/** A module's bytecode for a Node.js, beside its stub: src/cli.js and arm64-v22.23.3 give src/cli.arm64-v22.23.3.jsc. */
export const jscFor = (file: string, n: { arch: string; version: string }) => file.replace(/\.js$/, `.${nodeKey(n)}.jsc`);

/** A bytecode file's Node.js, from its name (`x.arm64-v22.23.3.jsc`), or null. */
export function jscNode(name: string): { arch: string; version: string } | null {
  const m = /\.([a-z0-9]+)-(v\d+\.\d+\.\d+)\.jsc$/i.exec(name);
  return m ? { arch: m[1], version: m[2] } : null;
}

/** What release.json says of a bytecode release (kit 2.152.0): the Node.js versions and processors it runs on. */
export interface BytecodeRelease {
  node: string[];
  arch: string[];
}

/** release.json's "bytecode", when it's one: anything else is none, never an error. */
export function bytecodeRelease(v: unknown): BytecodeRelease | undefined {
  const o = v as Record<string, unknown> | null;
  const list = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === 'string' && /^[\w.-]+$/.test(s));
  if (!o || typeof o !== 'object' || !list(o.node) || !list(o.arch)) return undefined;
  return { node: o.node as string[], arch: o.arch as string[] };
}

/**
 * An installed copy keeps only the bytecode for the Node.js installing it, which its task runs (install.ts): the
 * other processors' and versions' go. Null when that's done, or why it can't run here, with nothing removed.
 */
export function keepOwnBytecode(app: string, r: BytecodeRelease | undefined, own: { arch: string; version: string } = { arch: process.arch, version: process.version }): string | null {
  if (!r) return null;
  if (!r.arch.includes(own.arch) || !r.node.includes(own.version))
    return `This release's code runs on Node.js ${r.node.join(' or ')} for ${r.arch.join(' or ')}, and this is Node.js ${own.version} for ${own.arch}.`;
  const key = nodeKey(own);
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
      } else if (e.name.endsWith('.jsc')) {
        const n = jscNode(e.name);
        if (n && nodeKey(n) !== key) rmSync(p, { force: true });
      }
    }
  })(path.join(app, 'src'));
  return null;
}

/** esbuild's error texts, or the message. */
const errorsOf = (e: unknown): string[] => (e as { errors?: { text: string }[] }).errors?.map((x) => x.text) ?? [String((e as Error).message)];
const TLA = /top-level await/i;
/** What esbuild says of a statement read alone that names what's declared elsewhere: it is whole all the same. */
const ELSEWHERE = /is not declared in this file/;

/** Whether `code` awaits at its top level: esbuild, asked for CommonJS, says so. Throws what else it says is wrong. */
function awaitsAtTop(esbuild: Esbuild, code: string, alone = false): boolean {
  try {
    esbuild.transformSync(code, { loader: 'js', format: 'cjs', target: 'node22', logLevel: 'silent' });
    return false;
  } catch (e) {
    const said = errorsOf(e);
    if (said.some((t) => TLA.test(t))) return true;
    if (alone && said.every((t) => ELSEWHERE.test(t))) return false;
    throw e;
  }
}

/** The code printed one top-level statement to a line or more, strings on one line each (template literals as strings). */
const PRETTY = { loader: 'js', format: 'esm', platform: 'node', target: 'node22', minify: false, legalComments: 'none', charset: 'utf8', logLevel: 'silent', supported: { 'template-literal': false } };

/**
 * A module's top-level statements, from esbuild's own printing of it: each starts a line at its first column, and
 * anything inside one is indented or closes it (`}`, `)`, `]`); no string spans lines. Each is checked whole by esbuild
 * read alone, so a statement that can't be told apart throws rather than being cut.
 */
function statementsOf(esbuild: Esbuild, code: string, file: string): string[] {
  const out: string[] = [];
  for (const line of esbuild.transformSync(code, PRETTY).code.split('\n')) {
    if (out.length && (line === '' || /^[\s})\]]/.test(line))) out[out.length - 1] += `\n${line}`;
    else out.push(line);
  }
  for (const s of out) {
    try {
      esbuild.transformSync(s, { loader: 'js', format: 'esm', target: 'node22', logLevel: 'silent' });
    } catch (e) {
      if (!errorsOf(e).every((t) => ELSEWHERE.test(t)))
        throw new Error(`${file} couldn't be built as bytecode: its top-level statements couldn't be told apart, at ${JSON.stringify(s.slice(0, 80))}`);
    }
  }
  return out;
}

/** A statement that declares, imports or exports something: it stays at the module's top level. */
const DECLARES = /^(?:export[\s{*]|import[\s{*"']|(?:var|let|const|class)\s|(?:async\s+)?function[\s*])/;

/**
 * An ES module's code with no top-level await, for CommonJS, which has none: from each statement that awaits, it and
 * the statements after it up to the next declaration go into an async function, each such run chained after the one
 * before (`var __tla=(async()=>{...})();` then `__tla=__tla.then(async()=>{...});`), so they run in their order; a
 * failure in one is the process's unhandled rejection, as a module's would be. An `await import(x)` in a declaration
 * becomes `__importSync(x)`, a require of x. Any other await in a declaration throws, saying where. Code with no
 * top-level await comes back as it was. esbuild is the parser (statementsOf), so the code needs nothing else.
 */
export function withoutTopLevelAwait(esbuild: Esbuild, code: string, file: string): { code: string; wrapped: number; required: number } {
  if (!awaitsAtTop(esbuild, code)) return { code, wrapped: 0, required: 0 };
  const out: string[] = [];
  let run: string[] | null = null;
  let wrapped = 0;
  let required = 0;
  const close = () => {
    if (run) out.push(`${wrapped ? '__tla=__tla.then(async()=>{' : 'var __tla=(async()=>{'}\n${run.join('\n')}\n})${wrapped ? '' : '()'};`);
    if (run) wrapped++;
    run = null;
  };
  for (const s of statementsOf(esbuild, code, file)) {
    if (DECLARES.test(s)) {
      close();
      if (!awaitsAtTop(esbuild, s, true)) {
        out.push(s);
        continue;
      }
      const imports = s.match(/\bawait import\(/g)?.length ?? 0;
      const sync = s.replace(/\bawait import\(/g, '__importSync(');
      if (!imports || awaitsAtTop(esbuild, sync, true))
        throw new Error(
          `${file} couldn't be built as bytecode: it awaits at its top level in a declaration (${s.slice(0, 80).replace(/\s+/g, ' ')}...), which CommonJS can't. ` +
            'Move the await into a function, or import what it imports with a plain import.',
        );
      required += imports;
      out.push(sync);
    } else if (run) run.push(s);
    else if (awaitsAtTop(esbuild, s, true)) run = [s];
    else out.push(s);
  }
  close();
  return { code: out.join('\n'), wrapped, required };
}

/**
 * What each module starts with, in CommonJS: strict, as an ES module is; `import.meta.url` (esbuild's define) as its
 * stub's; and `__importSync`, a require of a file URL or a specifier (withoutTopLevelAwait).
 */
const PRELUDE =
  '"use strict";var __importMetaUrl=require("node:url").pathToFileURL(__filename).href,' +
  '__importSync=u=>require(/^file:/i.test(u=String(u))?require("node:url").fileURLToPath(u):u);';

const TO_CJS = {
  loader: 'js',
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  // Its format alone changes: minify.ts has minified it, and kept its names (keepNames) as they were.
  minifyWhitespace: true,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'silent',
  define: { 'import.meta.url': '__importMetaUrl', 'import.meta.dirname': '__dirname', 'import.meta.filename': '__filename' },
  banner: PRELUDE,
};

/** esbuild's note of a CommonJS module's export names, which Node reads to give import() of it named exports. */
const EXPORT_NAMES = /0&&\(module\.exports=\{[^}]*\}\);?/;

/** One built module (minify.ts' minified ES module) as CommonJS, and its export names' note for its stub. */
export function toCommonJs(esbuild: Esbuild, code: string, rel: string): { code: string; names: string; wrapped: number; required: number } {
  // A hashbang goes: the module is run by its stub, never as a script.
  let source = code.replace(/^\uFEFF/, '').replace(/^#![^\n]*(?:\n|$)/, '');
  let wrapped = 0;
  let required = 0;
  const transform = (c: string) => esbuild.transformSync(c, TO_CJS) as { code: string; warnings?: { text: string }[] };
  let out: { code: string; warnings?: { text: string }[] };
  try {
    out = transform(source);
  } catch (e) {
    const text = (e as { errors?: { text: string }[] }).errors?.[0]?.text ?? String((e as Error).message);
    if (!/top-level await/i.test(text)) throw new Error(`${rel} couldn't be built as bytecode: ${text.split(/\r?\n/)[0]}`);
    ({ code: source, wrapped, required } = withoutTopLevelAwait(esbuild, source, rel));
    out = transform(source);
  }
  const meta = out.warnings?.find((w) => /import\.meta/.test(w.text));
  if (meta) throw new Error(`${rel} couldn't be built as bytecode: ${meta.text} (only import.meta.url, .dirname and .filename are there)`);
  return { code: out.code, names: EXPORT_NAMES.exec(out.code)?.[0] ?? '', wrapped, required };
}

/** The files under `dir` (relative, forward slashes), node_modules left out. */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...walk(dir, r));
    } else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Whether a built file is one the server runs: a .js outside any `web` folder (the browser's: src\web\page.js, the kit's web part, Manor's web\). */
export const isServerModule = (rel: string) => rel.endsWith('.js') && !rel.split('/').slice(0, -1).includes('web');

/** The stub that stands where a module was: it hands its module to the loader, and notes its export names. */
export function stubOf(rel: string, names: string): string {
  let loader = path.posix.relative(path.posix.dirname(rel), LOADER);
  if (!loader.startsWith('.')) loader = `./${loader}`;
  return `require(${JSON.stringify(loader)})(module,require,__filename,__dirname);${names}\n`;
}

/** An entry stub minify.ts left (`import './cli.js';`) as CommonJS, or null when `text` isn't one. */
export function entryStubOf(text: string): string | null {
  const m = /^import (['"])(\.\/[^'"]+\.js)\1;?\s*$/.exec(text.replace(/^\uFEFF/, ''));
  return m ? `require('${m[2]}');\n` : null;
}

/**
 * What a Node.js runs to compile staged CommonJS modules (`from`) into bytecode beside their stubs (`to`), for itself
 * (`want`, arm64-v22.23.3: anything else stops it): every function compiled at once, with its source positions, each
 * module named by its path in the release, never this PC's. Each cache is taken back once, as a check. Prints
 * {"modules","bytes"}.
 */
const COMPILE = `
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');
const { Module } = require('node:module');
const [from, to, want] = process.argv.slice(1);
const here = process.arch + '-' + process.version;
if (here !== want) { console.error('this is Node.js ' + here + ', not ' + want); process.exit(3); }
v8.setFlagsFromString('--no-lazy');
v8.setFlagsFromString('--no-enable-lazy-source-positions');
let modules = 0, bytes = 0;
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.js')) continue;
    const rel = path.relative(from, p).split(path.sep).join('/');
    let data;
    try { data = new vm.Script(Module.wrap(readFileSync(p, 'utf8')), { filename: rel }).createCachedData(); }
    catch (e) { console.error(rel + ': ' + String(e && e.message || e).split('\\n')[0]); process.exit(5); }
    const back = new vm.Script(' '.repeat(data.readUInt32LE(8) & 0x7fffffff), { filename: rel, cachedData: Buffer.from(data) });
    if (back.cachedDataRejected) { console.error(rel + ': V8 turned down its own bytecode'); process.exit(4); }
    writeFileSync(path.join(to, rel.replace(/\\.js$/, '.' + want + '.jsc')), data);
    modules++;
    bytes += data.length;
  }
})(from);
console.log(JSON.stringify({ modules, bytes }));
`;

/**
 * What a Node.js runs to load each module in a list (a JSON file), as an installed agent would: the first that can't
 * load stops it, saying which and why, and so does one that ends the process as it loads (a script that does its work
 * whenever it's loaded, which would end the check there, its modules after it unloaded). Then it says how many it
 * loaded, and ends, whatever the modules started.
 */
const SMOKE = `
const files = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const exit = process.exit;
let at = null;
const fail = (error) => { console.error(JSON.stringify({ file: at, error })); exit(4); };
process.exit = (code) => fail('it ends the process as it loads (process.exit(' + (code ?? '') + ')): a script that does its work whenever it is loaded, not only when Node starts it');
let loaded = 0;
for (const f of files) {
  at = f;
  try { require(f); loaded++; }
  catch (e) { fail(String((e && e.stack) || e).split('\\n').slice(0, 5).join(' | ')); }
}
process.exit = exit;
console.log(JSON.stringify({ loaded }));
exit(0);
`;

/** What a process said last, for an error: its own last line, or an uncaught error's line. */
function tail(s: string): string {
  const lines = s.trim().split(/\r?\n/).filter((l) => l.trim() && !/^\s+at /.test(l) && !/^Node\.js v/.test(l));
  return lines.find((l) => /^[A-Z]\w*Error\b/.test(l)) ?? lines.at(-1) ?? '';
}

/** Where the Node.js builds downloaded for bytecode are kept: KIT_NODES, else %USERPROFILE%\.steward\node. */
export const nodeCache = (env: NodeJS.ProcessEnv = process.env) => env.KIT_NODES || path.join(os.homedir(), '.steward', 'node');

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** Whether `exe` runs on this PC, and is the Node.js it should be. */
function runsHere(exe: string, want: string): string | null {
  const r = spawnSync(exe, ['-p', "process.arch+'-'+process.version"], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.status === 0 && r.stdout.trim() === want) return null;
  return r.error ? r.error.message : `it says ${tail(`${r.stdout ?? ''}${r.stderr ?? ''}`) || `exit code ${r.status}`}`;
}

/**
 * The node.exe for a processor and version: the one running this when it's that one; else the one kept in `cache`
 * (nodeCache), downloaded from nodejs.org once and checked against nodejs.org's SHASUMS256.txt and NODE_PINS. Throws
 * when it isn't pinned, can't be had, or doesn't run on this PC (Arm64's on an x64 PC).
 */
export async function nodeFor(arch: string, version: string, o: { cache?: string; dist?: string; log?: (line: string) => void } = {}): Promise<BytecodeNode> {
  const want = nodeKey({ arch, version });
  if (process.arch === arch && process.version === version) return { arch, version, exe: process.execPath };
  const pin = NODE_PINS[want];
  if (!pin) throw new Error(`Not built: no Node.js ${version} for ${arch} is pinned in the kit (bytecode.ts NODE_PINS), and its bytecode is built by that Node.js`);
  const folder = path.join(o.cache ?? nodeCache(), pin.zip.replace(/\.zip$/, ''));
  const exe = path.join(folder, 'node.exe');
  if (!(existsSync(exe) && sha256(exe) === pin.exeSha256)) {
    const dist = o.dist ?? `https://nodejs.org/dist/${version}/`;
    (o.log ?? console.log)(`  downloading Node.js ${version} for ${arch} (${dist}${pin.zip}), to build its bytecode`);
    const listed = await (await fetch(`${dist}SHASUMS256.txt`, { signal: AbortSignal.timeout(60_000) })).text();
    const line = listed.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${pin.zip}`));
    if (line?.split(/\s+/)[0] !== pin.zipSha256) throw new Error(`Not built: nodejs.org's SHASUMS256.txt doesn't give ${pin.zip} the SHA-256 the kit pins`);
    // Unpacked beside where it's kept, so it's moved there, never copied across drives (a Dev Drive's temp folder).
    mkdirSync(path.dirname(folder), { recursive: true });
    const tmp = mkdtempSync(path.join(path.dirname(folder), '.download-'));
    try {
      const res = await fetch(`${dist}${pin.zip}`, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok) throw new Error(`Not built: ${pin.zip} couldn't be downloaded (HTTP ${res.status})`);
      const zip = path.join(tmp, pin.zip);
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      if (sha256(zip) !== pin.zipSha256) throw new Error(`Not built: the download of ${pin.zip} isn't the one nodejs.org lists`);
      const top = pin.zip.replace(/\.zip$/, '');
      execFileSync(TAR, ['-x', '-f', zip, '-C', tmp, `${top}/node.exe`], { windowsHide: true, stdio: 'ignore' });
      if (sha256(path.join(tmp, top, 'node.exe')) !== pin.exeSha256) throw new Error(`Not built: node.exe in ${pin.zip} isn't the one nodejs.org lists`);
      rmSync(folder, { recursive: true, force: true });
      renameSync(path.join(tmp, top), folder);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const wrong = runsHere(exe, want);
  if (wrong)
    throw new Error(
      `Not built: its bytecode for ${arch} is made by Node.js ${version} for ${arch}, which doesn't run on this ${process.arch} PC (${wrong}). ` +
        'Release it from a PC that runs both: an Arm PC runs x64 programs too.',
    );
  return { arch, version, exe };
}

/** The Node.js builds a release's bytecode is for: a published one, RUNTIME_NODE for each processor; else the one running this. */
export async function bytecodeNodes(published: boolean, o: { cache?: string; log?: (line: string) => void } = {}): Promise<BytecodeNode[]> {
  if (!published) return [{ arch: process.arch, version: process.version, exe: process.execPath }];
  const out: BytecodeNode[] = [];
  for (const arch of BYTECODE_ARCHES) out.push(await nodeFor(arch, RUNTIME_NODE, o));
  return out;
}

export interface Bytecode {
  /** The modules built as bytecode. */
  modules: number;
  /** Those whose top-level awaits went into async functions, or whose `await import()` became a require. */
  wrapped: string[];
  /** Each Node.js built for, and its bytecode's size. */
  nodes: { arch: string; version: string; bytes: number }[];
}

/**
 * Builds a staged, minified release's server modules (under `folders`) as bytecode for each of `nodes`, in place:
 * each module's .js a stub, its bytecode beside it, the loader at LOADER, each folder's package.json CommonJS, and its
 * entry stubs requiring their modules. Then each Node.js loads every module (smokeTest). Throws, naming the module,
 * when one can't be built or loaded, or a .ts other than an entry stub is left (readable source).
 */
export function buildBytecode(stage: string, o: { esbuild: Esbuild; nodes: BytecodeNode[]; folders?: string[]; id?: string }): Bytecode {
  const folders = o.folders ?? ['src'];
  const files: string[] = [];
  const entries: string[] = [];
  for (const folder of folders) {
    if (!existsSync(path.join(stage, folder)) || !statSync(path.join(stage, folder)).isDirectory()) continue;
    for (const f of walk(path.join(stage, folder))) {
      const rel = `${folder}/${f}`;
      if (isServerModule(rel)) files.push(rel);
      else if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) {
        const stub = entryStubOf(readFileSync(path.join(stage, rel), 'utf8'));
        if (!stub) throw new Error(`${rel} is TypeScript source, and a release carries none: minify.ts builds every .ts but an entry stub`);
        entries.push(rel);
        writeFileSync(path.join(stage, rel), stub);
      }
    }
  }
  const out: Bytecode = { modules: files.length, wrapped: [], nodes: [] };
  if (!files.length) return out;

  mkdirSync(path.dirname(path.join(stage, LOADER)), { recursive: true });
  cpSync(new URL('./run-bytecode.cjs', import.meta.url), path.join(stage, LOADER));
  const staged = mkdtempSync(path.join(os.tmpdir(), 'kit-bytecode-'));
  try {
    const names = new Map<string, string>();
    for (const rel of files) {
      const built = toCommonJs(o.esbuild, readFileSync(path.join(stage, rel), 'utf8'), rel);
      if (built.wrapped || built.required) out.wrapped.push(rel);
      names.set(rel, built.names);
      mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
      writeFileSync(path.join(staged, rel), built.code);
    }
    for (const n of o.nodes) {
      const key = nodeKey(n);
      const r = spawnSync(n.exe, ['-e', COMPILE, staged, stage, key], { encoding: 'utf8', windowsHide: true, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`Not built: Node.js ${n.version} for ${n.arch} couldn't build its bytecode: ${tail(`${r.stderr ?? ''}${r.error?.message ?? ''}`) || `exit code ${r.status}`}`);
      const said = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!) as { modules: number; bytes: number };
      if (said.modules !== files.length) throw new Error(`Not built: Node.js ${n.version} for ${n.arch} built ${said.modules} modules of ${files.length}`);
      out.nodes.push({ arch: n.arch, version: n.version, bytes: said.bytes });
    }
    for (const rel of files) writeFileSync(path.join(stage, rel), stubOf(rel, names.get(rel)!));
    for (const folder of new Set(files.map((f) => f.split('/')[0]))) writeFileSync(path.join(stage, folder, 'package.json'), '{ "type": "commonjs" }\n');
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  // The modules the entry stubs run are started by name, never loaded as a test would: the rest are.
  const started = new Set(entries.map((e) => path.posix.join(path.posix.dirname(e), /require\('\.\/([^']+)'\)/.exec(readFileSync(path.join(stage, e), 'utf8'))![1])));
  smokeTest(stage, files.filter((f) => !started.has(f)), o.nodes, o.id);
  return out;
}

/**
 * Each Node.js loads each module (relative to `stage`) from its bytecode, in a process whose home, AppData and agent
 * data folder are a temporary folder's. Throws, naming the module and what it said, at the first that can't load.
 */
export function smokeTest(stage: string, modules: string[], nodes: BytecodeNode[], id?: string): void {
  if (!modules.length) return;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-smoke-'));
  try {
    const list = path.join(tmp, 'modules.json');
    writeFileSync(list, JSON.stringify(modules.map((m) => path.join(stage, m))));
    const home = path.join(tmp, 'home');
    mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
    mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'), TEMP: tmp, TMP: tmp };
    if (id) env[`${id.toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, `.${id}`);
    // Its own folder, an empty one, so nothing a module writes where it's run lands in the release.
    const cwd = path.join(tmp, 'cwd');
    mkdirSync(cwd, { recursive: true });
    for (const n of nodes) {
      const r = spawnSync(n.exe, ['-e', SMOKE, list], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      if (r.status === 0) {
        let loaded = -1;
        try {
          loaded = (JSON.parse((r.stdout ?? '').trim().split(/\r?\n/).pop()!) as { loaded: number }).loaded;
        } catch {
          // Not its own line: below.
        }
        if (loaded === modules.length) continue;
        throw new Error(`Not built: its bytecode's check on Node.js ${n.version} for ${n.arch} ended before it had loaded every module (${loaded < 0 ? 'it said nothing of them' : `${loaded} of ${modules.length}`}): a module ends the process as it loads`);
      }
      let what = tail(`${r.stderr ?? ''}${r.error?.message ?? ''}`) || `exit code ${r.status}`;
      try {
        const j = JSON.parse((r.stderr ?? '').trim().split(/\r?\n/).pop()!) as { file: string; error: string };
        what = `${path.relative(stage, j.file).replace(/\\/g, '/')}: ${j.error}`;
      } catch {
        // Not its own line: the process's last words.
      }
      throw new Error(`Not built: its bytecode doesn't load on Node.js ${n.version} for ${n.arch}: ${what}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
