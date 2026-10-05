import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEsbuild } from '../node/minify.ts';

/**
 * React components rendered in a test, to HTML (react-dom/server): Node can't run .tsx, so `source` (TSX, which
 * imports what it renders by absolute path) is bundled with esbuild for Node, React and all, and imported. The
 * Steward's checkout has esbuild and React (devDependencies); its tests and the kit's use this.
 *
 * `stubs` stand in for the browser's globals a component reads as it renders (location, document), set before
 * the bundle runs.
 */
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function bundleForNode<T>(source: string, stubs: Record<string, unknown> = {}): Promise<T> {
  const esbuild = await loadEsbuild(STEWARD);
  if ('error' in esbuild) throw new Error(esbuild.error);
  const r = await esbuild.build({
    stdin: { contents: source, resolveDir: STEWARD, loader: 'tsx', sourcefile: 'render-entry.tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // react-dom/server is CommonJS, and require()s Node's own modules: an ES module has no require of its own.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'silent',
  });
  const text = r.outputFiles?.[0]?.text;
  if (text === undefined) throw new Error(r.errors[0]?.text ?? 'no output');
  for (const [k, v] of Object.entries(stubs)) (globalThis as Record<string, unknown>)[k] = v;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'react-render-'));
  try {
    const file = path.join(dir, 'entry.mjs');
    writeFileSync(file, text);
    return (await import(pathToFileURL(file).href)) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A path for an import in `source`: absolute, forward slashes. */
export const importPath = (file: string) => path.resolve(file).split(path.sep).join('/');
