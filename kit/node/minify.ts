import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * Builds a staged release in place (`stage`, its root): under each of `folders` (src by default; Manor adds web),
 * each .ts becomes a minified .js (ENTRY_STUBS and `stubs` keep a stub), each .js is minified, and each .d.ts goes.
 * Throws, naming the file, when esbuild can't read one.
 */
export async function minifyRelease(stage: string, esbuild: Esbuild, o: { folders?: string[]; stubs?: string[] } = {}): Promise<Minified> {
  const folders = o.folders ?? ['src'];
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
