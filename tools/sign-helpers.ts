#!/usr/bin/env node
/**
 * Compiles and signs the kit's C# helpers (kit 2.91.0):
 *
 *   node tools/sign-helpers.ts   kit\node\prebuilt\: each helper in prebuilt.ts' HELPERS, compiled and signed
 *
 * Each helper is compiled from kit\node\<helper>.cs as a PC compiles it (Windows PowerShell's Add-Type), signed with the
 * owner's Certum certificate (sign-llama.ts' sign: SimplySign Desktop connected), checked, and put in kit\node\prebuilt\
 * under the name its source gives it. One already there for its source, and signed, stays as it is; a file there for a
 * source that has changed since is removed. Run it after changing a helper's source, and commit kit\node\prebuilt\ with
 * the new file's name in the kit's changelog: until then the kit has no prebuilt copy of that helper, and each PC
 * compiles its own, as before.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPERS, prebuiltName, SIGNED_BY, type Helper } from '../src/kit/prebuilt.ts';
import { sign, signatures, type Signature } from './sign-llama.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nodeDir = path.join(root, 'kit', 'node');
const prebuiltDir = path.join(nodeDir, 'prebuilt');

/** Each helper's prebuilt file name for its source in `dir` now. */
export function wanted(dir = nodeDir): Map<string, Helper> {
  return new Map((Object.keys(HELPERS) as Helper[]).map((h) => [prebuiltName(h, readFileSync(path.join(dir, `${h}.cs`), 'utf8')), h]));
}

/** The files among `sigs` not signed by the owner's certificate. */
export const notOurs = (sigs: Signature[]): Signature[] => sigs.filter((s) => s.status !== 'Valid' || s.thumbprint !== SIGNED_BY);

function compile(helper: Helper, out: string): void {
  const ps = `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '${path.join(nodeDir, `${helper}.cs`)}') -OutputAssembly '${out}' -OutputType ${HELPERS[helper].type}`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
}

function main(): void {
  const want = wanted();
  const work = path.join(root, 'artifacts', 'helpers');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(prebuiltDir, { recursive: true });
  const there = [...want.keys()].map((n) => path.join(prebuiltDir, n)).filter((f) => existsSync(f));
  const bad = new Set(notOurs(signatures(there, work)).map((s) => path.basename(s.path)));
  const todo = [...want].filter(([name]) => !there.some((f) => path.basename(f) === name) || bad.has(name));
  const built = todo.map(([name, helper]) => {
    const out = path.join(work, name);
    compile(helper, out);
    return out;
  });
  if (built.length) sign(built);
  const unsigned = notOurs(signatures(built, work));
  if (unsigned.length) throw new Error(`not signed by the owner's certificate after signing: ${unsigned.map((s) => `${path.basename(s.path)} (${s.status})`).join(', ')}`);
  for (const f of built) copyFileSync(f, path.join(prebuiltDir, path.basename(f)));
  const stale = readdirSync(prebuiltDir).filter((f) => !want.has(f));
  for (const f of stale) rmSync(path.join(prebuiltDir, f), { force: true });
  console.log(`kit\\node\\prebuilt: ${built.length} signed (${built.map((f) => path.basename(f)).join(', ') || 'none'}), ${want.size - built.length} as they were, ${stale.length} removed${stale.length ? ` (${stale.join(', ')})` : ''}`);
  rmSync(work, { recursive: true, force: true });
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (e) {
    console.error(process.env.SIGN_HELPERS_DEBUG ? (e as Error)?.stack : String((e as Error)?.message ?? e));
    process.exit(1);
  }
}
