import { readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A release's code, built: what the manor publishes is never its readable source (spec/RELEASES.md). Every
 * TypeScript file a release carries is minified on its own with esbuild and written beside where it was, as .js;
 * the .ts files go. Each file stays in its folder, so whatever a module finds next to itself (`import.meta.url`,
 * `import.meta.dirname`: the kit's web part, a PowerShell script, rules.json) is where it was.
 *
 * - **One file at a time, its imports rewritten by esbuild's own parser:** each .ts is esbuild's entry point with
 *   every import left outside it (external), and an import of another relative .ts (static, dynamic or
 *   `export ... from`) pointing at its .js. Never a text search, so an import written inside a string (the Steward's
 *   convert.ts writes one into hires' tests) is left as it is.
 * - **Imports as written** (`verbatimModuleSyntax`): an import kept only for what loading it does stays, as Node's
 *   type stripping keeps it; `import type` goes.
 * - **The entry stays a stub:** src\cli.ts is a one-line `import './cli.js';`, since installers, Task Scheduler's
 *   tasks and Manor's staff list start an agent as `node src\cli.ts`. (ENTRY_STUBS, and a caller's own.)
 * - **Plain .js** is minified where it is with no module format, so a page's classic script keeps its global names
 *   (Manor's web/app.js) and a module keeps its imports (the kit's core).
 * - **.d.ts files go. CSS, PowerShell, JSON, SVG and the rest are as they were** (Manor reads themes.css as text).
 * - Names are kept (keepNames), so stack traces in the logs, and an error's or a class's name, read as they did.
 * - **Nothing it imports is left out** (kit 2.146.5, importsLeftOut): a release whose code imports a file the release
 *   doesn't carry isn't built, as the installed agent would stop there at ERR_MODULE_NOT_FOUND.
 *
 * esbuild is each agent's devDependency: `loadEsbuild(root)` finds it in the agent's node_modules.
 */

/** The parts of esbuild's API a build uses. */
export interface Esbuild {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[]; errors: { text: string }[] }>;
  transformSync(code: string, options: Record<string, unknown>): { code: string };
  version: string;
}

/** The .ts files started by name, kept as stubs: relative to the release's root, forward slashes. */
export const ENTRY_STUBS = ['src/cli.ts'];

/** esbuild from the agent's own node_modules, else the folder STEWARD_ESBUILD names; or what's wrong in words. */
export async function loadEsbuild(root: string): Promise<Esbuild | { error: string }> {
  // The agent's own, else the folder STEWARD_ESBUILD names (a checkout whose node_modules has it: the kit's tests).
  let file: string | null = null;
  for (const from of [root, process.env.STEWARD_ESBUILD].filter((x): x is string => !!x)) {
    try {
      file = createRequire(path.join(from, 'package.json')).resolve('esbuild');
      break;
    } catch {
      // Not there: the next.
    }
  }
  if (!file) return { error: "esbuild isn't installed here, and a release is built with it: run npm install (it's a devDependency since kit 2.17.0)" };
  try {
    const m = (await import(pathToFileURL(file).href)) as Esbuild & { default?: Esbuild };
    return typeof m.build === 'function' ? m : (m.default as Esbuild);
  } catch (e) {
    return { error: `esbuild couldn't be loaded from ${file}: ${(e as Error).message}` };
  }
}

/** Where an import inside a built file points: a relative .ts at its .js; anything else as it is. */
export const builtSpecifier = (spec: string) => (/^\.{1,2}\//.test(spec) && spec.endsWith('.ts') && !spec.endsWith('.d.ts') ? `${spec.slice(0, -3)}.js` : spec);

/** The stub that stands where an entry .ts was: it runs its built .js. */
export const stubFor = (file: string) => `import './${path.basename(file, '.ts')}.js';\n`;

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

export interface Minified {
  /** Files built, by kind, and the bytes of code before and after. */
  ts: number;
  js: number;
  before: number;
  after: number;
}

const COMMON = { minify: true, keepNames: true, legalComments: 'none', charset: 'utf8' };

/** One .ts file, minified as an ES module of its own: every import external, a relative .ts pointing at its .js. */
async function buildModule(esbuild: Esbuild, file: string): Promise<string> {
  const r = await esbuild.build({
    ...COMMON,
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    plugins: [
      {
        name: 'one-file',
        setup(b: { onResolve(o: { filter: RegExp }, f: (a: { path: string; importer: string; kind: string }) => unknown): void }) {
          // Nothing is bundled: the entry alone is built, and whatever it imports stays an import.
          b.onResolve({ filter: /.*/ }, (a) => (a.kind === 'entry-point' ? undefined : { path: builtSpecifier(a.path), external: true }));
        },
      },
    ],
  });
  return r.outputFiles![0].text;
}

/** A relative value import in a release's code of a file the release doesn't carry (importsLeftOut). */
export interface LeftOut {
  /** The file that imports it, relative to the release's root, forward slashes. */
  file: string;
  /** The file it imports, the same way. */
  imports: string;
  /** An `import()` of a literal; else a static `import` or `export … from`. */
  dynamic: boolean;
}

/** The files a release's code is read from: its .ts (not .d.ts) and .js, as minifyRelease builds them. */
const isCode = (rel: string) => (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) || rel.endsWith('.js') || rel.endsWith('.mjs');

/** An esbuild failure's first error, naming its file (`what` when esbuild names none), as minifyRelease says one of its own. */
function buildError(e: unknown, what: string): Error {
  const err = e as { errors?: { text: string; location?: { file?: string } | null }[]; message?: string };
  const first = err.errors?.[0];
  return new Error(`${first?.location?.file?.replace(/\\/g, '/') ?? what} couldn't be built: ${first?.text ?? String(err.message).split(/\r?\n/)[0]}`);
}

/**
 * The value imports in a staged release's code (each .ts and .js under `folders`, as minifyRelease would build it) of a
 * file the stage doesn't carry (kit 2.146.5): one the release leaves out (its tests and documents, src/web's files but
 * the page's bundle, and the kit's react part: react-page.ts' releasePage; whatever is outside src and art; the .d.ts
 * files minifyRelease drops), or one that was never there. The installed agent stops at each with ERR_MODULE_NOT_FOUND:
 * Reeve 0.19.10 and 0.19.11 started on no PC, as src/assistants.ts imported src/web/ps-arg.ts, and the checkout's tests
 * passed. Read by esbuild's own parser, in one build, as the release builds the code (`verbatimModuleSyntax`): a static
 * `import`, an `export … from` and an `import()` of a literal count. `import type` and `export type` don't, but
 * `import { type A } from` does: Node and the built release both keep it, as `import './a.js'`. Only relative imports
 * (a package's are npm's). Throws, naming the file, when esbuild can't read one.
 */
export async function importsLeftOut(stage: string, esbuild: Esbuild, folders = ['src']): Promise<LeftOut[]> {
  const all = walk(stage);
  const carried = new Set(all.filter((f) => !f.endsWith('.d.ts')));
  const code = all.filter((f) => folders.some((d) => f.startsWith(`${d}/`)) && isCode(f));
  if (!code.length) return [];
  // esbuild names an importer by its real path: a stage reached through a link (a temp folder on a Dev Drive) is measured from there.
  const real = realpathSync.native(stage);
  const rel = (p: string) => path.relative(real, p).replace(/\\/g, '/');
  const found = new Map<string, LeftOut>();
  await esbuild
    .build({
      // Named apart, so a .ts and a .js of one name don't share an output.
      entryPoints: Object.fromEntries(code.map((f, i) => [`m${i}`, path.join(stage, f)])),
      bundle: true,
      write: false,
      outdir: path.join(stage, '.imports'),
      absWorkingDir: stage,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      plugins: [
        {
          name: 'left-out',
          setup(b: { onResolve(o: { filter: RegExp }, f: (a: { path: string; importer: string; kind: string }) => unknown): void }) {
            b.onResolve({ filter: /.*/ }, (a) => {
              if (a.kind === 'entry-point') return undefined;
              if ((a.kind === 'import-statement' || a.kind === 'dynamic-import') && /^\.{1,2}\//.test(a.path)) {
                const file = rel(a.importer);
                const imports = rel(path.resolve(path.dirname(a.importer), a.path.replace(/[?#].*$/, '')));
                if (!carried.has(imports) && !found.has(`${file}>${imports}`)) found.set(`${file}>${imports}`, { file, imports, dynamic: a.kind === 'dynamic-import' });
              }
              return { path: a.path, external: true };
            });
          },
        },
      ],
    })
    .catch((e) => {
      throw buildError(e, 'its code');
    });
  return [...found.values()].sort((x, y) => (x.file === y.file ? (x.imports < y.imports ? -1 : 1) : x.file < y.file ? -1 : 1));
}

/** Why a release isn't built, in words: importsLeftOut's imports, each file and what it imports, and what to do. */
export function leftOutText(left: LeftOut[]): string {
  const each = left.map((l) => `${l.file} imports ${l.imports}${l.dynamic ? ' (with import())' : ''}`).join('; ');
  return (
    `Not built: its code imports what the release doesn't carry, so the installed agent would stop there (ERR_MODULE_NOT_FOUND): ${each}. ` +
    "A release carries src and art, but not their tests, documents or .d.ts files, and of the page's sources (src/web, the kit's react part) only its bundle, src/web/page.js: " +
    'move what the server imports out of src/web, or import its types alone (import type).'
  );
}

/**
 * Builds a staged release in place (`stage`, its root): under each of `folders` (src by default; Manor adds web),
 * each .ts becomes a minified .js (ENTRY_STUBS and `stubs` keep a stub), each .js is minified, and each .d.ts goes.
 * First, a release whose code imports a file it doesn't carry isn't built (importsLeftOut). Throws, naming the file,
 * when esbuild can't read one.
 */
export async function minifyRelease(stage: string, esbuild: Esbuild, o: { folders?: string[]; stubs?: string[] } = {}): Promise<Minified> {
  const folders = o.folders ?? ['src'];
  const left = await importsLeftOut(stage, esbuild, folders);
  if (left.length) throw new Error(leftOutText(left));
  const stubs = new Set([...ENTRY_STUBS, ...(o.stubs ?? [])]);
  const out: Minified = { ts: 0, js: 0, before: 0, after: 0 };
  for (const folder of folders) {
    let files: string[];
    try {
      if (!statSync(path.join(stage, folder)).isDirectory()) continue;
      files = walk(path.join(stage, folder)).map((f) => `${folder}/${f}`);
    } catch {
      continue;
    }
    for (const rel of files) {
      const file = path.join(stage, rel);
      const fail = (e: unknown): never => {
        const err = e as { errors?: { text: string }[]; message?: string };
        throw new Error(`${rel} couldn't be built: ${err.errors?.[0]?.text ?? String(err.message).split(/\r?\n/)[0]}`);
      };
      if (rel.endsWith('.d.ts')) rmSync(file);
      else if (rel.endsWith('.ts')) {
        out.before += statSync(file).size;
        const code = await buildModule(esbuild, file).catch(fail);
        out.after += Buffer.byteLength(code);
        writeFileSync(file.slice(0, -3) + '.js', code);
        if (stubs.has(rel)) writeFileSync(file, stubFor(rel));
        else rmSync(file);
        out.ts++;
      } else if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
        const source = readFileSync(file, 'utf8').replace(/^﻿/, '');
        out.before += Buffer.byteLength(source);
        let code = '';
        try {
          code = esbuild.transformSync(source, { ...COMMON, loader: 'js', target: 'es2022' }).code;
        } catch (e) {
          fail(e);
        }
        out.after += Buffer.byteLength(code);
        writeFileSync(file, code);
        out.js++;
      }
    }
  }
  return out;
}
