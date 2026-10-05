import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A release's code, built: what the manor publishes is never its readable source (spec/RELEASES.md). Every
 * TypeScript file a release carries is minified on its own with esbuild and written beside where it was, as .js,
 * with its imports of other .ts files pointing at their .js; the .ts files go. Each file stays in its folder, so
 * whatever a module finds next to itself (`import.meta.url`, `import.meta.dirname`: the kit's web part, a
 * PowerShell script, rules.json) is where it was. A few .ts files stay, as one-line stubs that import their .js:
 * those started by name (`node src\cli.ts install`, Task Scheduler's tasks, Manor's staff list). Plain .js and .css
 * files are minified where they are; .d.ts files go. Everything else (PowerShell, JSON, SVG, icons) is as it was.
 *
 * Names are kept (esbuild's keepNames), so an error's name, a class's, and a function's read as they did.
 *
 * esbuild is each agent's devDependency: `loadEsbuild(root)` finds it in the agent's node_modules.
 */

/** The parts of esbuild's API a build uses. */
export interface Esbuild {
  transformSync(code: string, options: Record<string, unknown>): { code: string };
  version: string;
}

/** The .ts files started by name, kept as stubs: relative to the release's root, forward slashes. */
export const ENTRY_STUBS = ['src/cli.ts'];

/** esbuild from the agent's own node_modules, or what's wrong in words. */
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
  if (!file) return { error: "esbuild isn't installed here, and a release is built with it: run npm install (it's a devDependency since kit 2.16.0)" };
  try {
    const m = (await import(pathToFileURL(file).href)) as Esbuild & { default?: Esbuild };
    return typeof m.transformSync === 'function' ? m : (m.default as Esbuild);
  } catch (e) {
    return { error: `esbuild couldn't be loaded from ${file}: ${(e as Error).message}` };
  }
}

/**
 * The code with every relative .ts it imports pointing at its .js: `from './x.ts'`, `import './x.ts'`,
 * `import('./x.ts')` and `new URL('./x.ts', import.meta.url)`, quoted either way. Anything else is left as it is.
 */
export function toJsSpecifiers(code: string): string {
  return code
    .replace(/(\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]*?)\.ts\2/g, '$1$2$3.js$2')
    .replace(/(\bnew\s+URL\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]*?)\.ts\2(\s*,\s*import\.meta\.url)/g, '$1$2$3.js$2$4');
}

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
  css: number;
  before: number;
  after: number;
}

/**
 * Builds a staged release in place (`stage`, its root): under each of `folders` (src by default; Manor adds web),
 * each .ts becomes a minified .js (ENTRY_STUBS and `stubs` keep a stub), each .js and .css is minified, and each
 * .d.ts goes. Throws, naming the file, when esbuild can't read one.
 */
export function minifyRelease(stage: string, esbuild: Esbuild, o: { folders?: string[]; stubs?: string[] } = {}): Minified {
  const folders = o.folders ?? ['src'];
  const stubs = new Set([...ENTRY_STUBS, ...(o.stubs ?? [])]);
  const out: Minified = { ts: 0, js: 0, css: 0, before: 0, after: 0 };
  const common = { minify: true, keepNames: true, legalComments: 'none', charset: 'utf8' };
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
      const build = (loader: string, extra: Record<string, unknown> = {}) => {
        const source = readFileSync(file, 'utf8').replace(/^﻿/, '');
        out.before += Buffer.byteLength(source);
        let code: string;
        try {
          code = esbuild.transformSync(loader === 'css' ? source : toJsSpecifiers(source), { loader, ...common, ...extra }).code;
        } catch (e) {
          throw new Error(`${rel} couldn't be built: ${(e as Error).message.split(/\r?\n/)[0]}`);
        }
        out.after += Buffer.byteLength(code);
        return code;
      };
      if (rel.endsWith('.d.ts')) rmSync(file);
      else if (rel.endsWith('.ts')) {
        const code = build('ts', { format: 'esm', target: 'node22', platform: 'node' });
        writeFileSync(file.slice(0, -3) + '.js', code);
        if (stubs.has(rel)) writeFileSync(file, stubFor(rel));
        else rmSync(file);
        out.ts++;
      } else if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
        writeFileSync(file, build('js', { format: 'esm', target: 'es2022' }));
        out.js++;
      } else if (rel.endsWith('.css')) {
        writeFileSync(file, build('css'));
        out.css++;
      }
    }
  }
  return out;
}
