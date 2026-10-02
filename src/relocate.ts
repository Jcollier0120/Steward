import path from 'node:path';

/**
 * Moving files without breaking their imports. A relative specifier ('./npu.ts', '../src/app.ts',
 * new URL('../package.json', import.meta.url)) is resolved where the file used to be, its target is moved
 * by `moveTarget`, and the specifier is written again from where the file is now. Bare and node:
 * specifiers are left alone. Paths are repo-relative, with forward slashes.
 *
 * The Steward uses it twice: to lay the hires' kit files out as the kit (tools/kit-from.ts), and to turn a
 * hire's own files towards src/kit/ (tools/convert.ts).
 */

/** `from '…'`, `import('…')`, a bare `import '…'`, and `new URL('…', import.meta.url)`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)(['"])(\.{1,2}\/[^'"\r\n]*)\2/g;

const posix = path.posix;

/** A repo-relative path, normalised: forward slashes, no ./ or ../ left inside. */
export const norm = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');

/** The specifier that reaches `to` from a file at `from` (both repo-relative): './x.ts', '../app.ts'. */
export function specifier(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(norm(from)), norm(to));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export interface Relocated {
  text: string;
  /** Each specifier changed: [before, after]. */
  changed: [string, string][];
}

/**
 * `text`, a file that was at `wasAt` and is now at `isAt`, with every relative specifier written for its new
 * place. `moveTarget` says where a target (by its old path) is now; return it unchanged for one that stays.
 */
export function relocate(text: string, wasAt: string, isAt: string, moveTarget: (oldPath: string) => string): Relocated {
  const changed: [string, string][] = [];
  const out = text.replace(SPECIFIER, (whole, lead: string, quote: string, spec: string) => {
    const target = norm(posix.join(posix.dirname(norm(wasAt)), spec));
    const next = specifier(isAt, moveTarget(target));
    if (next === spec) return whole;
    changed.push([spec, next]);
    return `${lead}${quote}${next}${quote}`;
  });
  return { text: out, changed };
}
