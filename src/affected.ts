import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Affected tests: of a Node repository's test files, the ones a change can reach, so a vouch and the Steward's test of a
 * single PR run those rather than the whole suite (stages/bump.ts's runChecks). Where everything comes together (a merge
 * train's stack, a kit PR's catch-up, a bump, a release) the whole suite still runs.
 *
 * A test file is affected when it changed, when its relative imports (`import … from`, `export … from`,
 * `import('…')`, `require('…')`), followed through every file they reach, reach a changed code file, or when it names a
 * changed code file (a test that runs src/cli.ts as a child process imports nothing of it). What isn't code
 * counts through the code that names it: a changed roles.json affects the code files that say "roles.json", and so on.
 * A version step (package.json, package-lock.json, src/app.ts and the like changing only in version lines) reaches nothing, and a
 * Markdown file no code names (a changelog, a README) reaches nothing either.
 *
 * Anything it can't follow runs everything (`all`, with the reason): the TypeScript or npm setup (tsconfig, package.json or
 * its lockfile beyond their versions, .npmrc), the kit (kit.json, tools/kit.ts, the kit's own sources in the Steward's
 * repository), test fixtures, a code file deleted or renamed, a non-code file no code names, or more than MAX_CHANGED
 * files. Pure but for reading the repository's files.
 */

export const MAX_CHANGED = 200;

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const isCode = (f: string) => CODE.test(f);
const posix = (f: string) => f.replace(/\\/g, '/');

/** What runs everything, whatever else the change holds. */
const EVERYTHING: [RegExp, string][] = [
  [/^tsconfig[^/]*\.json$/i, 'the TypeScript setup'],
  [/^\.npmrc$/i, "npm's setup"],
  [/^kit\.json$/i, 'the kit pin'],
  [/^tools\/kit\.ts$/i, 'the kit fill'],
  [/^kit\//i, 'the kit itself'],
  [/(^|\/)fixtures?\//i, 'test fixtures'],
];

/** A changed file, as git names it: its status (A, M, D, R…) and path. */
export interface Changed {
  status: string;
  path: string;
}

export type Affected = { all: true; why: string; tests: string[] } | { all: false; files: string[]; tests: string[]; why: string };

/** A glob ("test/**\/*.test.ts") as a regular expression over posix paths. */
export function globRe(glob: string): RegExp {
  const s = posix(glob.trim())
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${s}$`, 'i');
}

/** Every file under `dir` (posix, relative), node_modules, .git and the folders git leaves out of a clone skipped. */
export function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(path.join(dir, rel));
    } catch {
      return;
    }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git') continue;
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try {
        st = statSync(path.join(dir, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out;
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;

/** The relative specifiers a code file's text imports. Pure. */
export function specifiersOf(text: string): string[] {
  return [...text.matchAll(SPECIFIER)].map((m) => m[2]);
}

/** A relative specifier from `from` resolved to a file in `known` (posix, relative), or null. Pure. */
export function resolveSpecifier(from: string, spec: string, known: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const tries = [base, ...['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js'].map((x) => base + x)];
  for (const t of tries) if (known.has(t)) return t;
  // .js written for a .ts file (TypeScript's own style), and .mjs for .mts.
  const swapped = base.replace(/\.js$/i, '.ts').replace(/\.mjs$/i, '.mts');
  return known.has(swapped) ? swapped : null;
}

/** Whether a unified diff of one file changes only lines that carry a version (a version step). Pure. */
export function versionOnly(patch: string): boolean {
  const lines = patch.split(/\r?\n/).filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
  return lines.length > 0 && lines.every((l) => /\bversion\b/i.test(l) && /\d+\.\d+\.\d+/.test(l));
}

/**
 * The test files (matching `testGlobs`) a change in `dir` reaches, as the module's comment says. `patchOf` gives a changed
 * file's diff, to tell a version step from any other change.
 */
export function affectedTests(o: { dir: string; changed: Changed[]; testGlobs: string[]; patchOf: (file: string) => string }): Affected {
  const files = filesIn(o.dir);
  const globs = o.testGlobs.map(globRe);
  const tests = files.filter((f) => globs.some((g) => g.test(f))).sort();
  const everything = (why: string): Affected => ({ all: true, why, tests });
  if (o.changed.length > MAX_CHANGED) return everything(`${o.changed.length} files changed`);
  const known = new Set(files);
  const code = files.filter(isCode);
  const text = new Map<string, string>();
  const read = (f: string) => {
    if (!text.has(f)) {
      try {
        text.set(f, readFileSync(path.join(o.dir, f), 'utf8'));
      } catch {
        text.set(f, '');
      }
    }
    return text.get(f)!;
  };
  const touched = new Set<string>();
  const reasons: string[] = [];
  for (const c of o.changed) {
    const f = posix(c.path);
    const hit = EVERYTHING.find(([re]) => re.test(f));
    if (hit) return everything(`${f} changed (${hit[1]})`);
    const gone = c.status.startsWith('D') || c.status.startsWith('R') || !known.has(f);
    if (gone) {
      if (isCode(f)) return everything(`${f} was deleted or renamed`);
      continue;
    }
    const step = (() => {
      try {
        return versionOnly(o.patchOf(f));
      } catch {
        return false;
      }
    })();
    if (step) {
      reasons.push(`${f}: a version step`);
      continue;
    }
    if (/^package(-lock)?\.json$/i.test(f)) return everything(`${f} changed beyond its version`);
    if (isCode(f)) {
      touched.add(f);
      continue;
    }
    // Not code: it counts through the code that names it.
    const name = path.posix.basename(f);
    const naming = code.filter((x) => read(x).includes(name));
    if (naming.length) {
      for (const x of naming) touched.add(x);
      reasons.push(`${f}: through ${naming.length} file${naming.length === 1 ? '' : 's'} naming it`);
    } else if (/\.md$/i.test(f) || /^(LICENSE|NOTICE)/i.test(name) || /^\.(gitignore|gitattributes)$/i.test(name) || /^\.(github|claude)\//i.test(f)) {
      reasons.push(`${f}: no code reads it`);
    } else return everything(`${f} changed, and no code names it`);
  }
  // Each test file, and whether the files it reaches (its imports, theirs, and so on) take in a touched one.
  const importsOf = new Map<string, string[]>();
  const imports = (f: string) => {
    if (!importsOf.has(f)) importsOf.set(f, specifiersOf(read(f)).map((s) => resolveSpecifier(f, s, known)).filter((x): x is string => !!x));
    return importsOf.get(f)!;
  };
  const reaches = (start: string) => {
    const seen = new Set<string>([start]);
    const todo = [start];
    while (todo.length) {
      const f = todo.pop()!;
      if (touched.has(f)) return true;
      for (const g of imports(f)) if (!seen.has(g) && isCode(g)) seen.add(g), todo.push(g);
    }
    return false;
  };
  // A test that names a changed file without importing it (one that runs src/cli.ts as a child process, say) runs too.
  const names = [...touched].map((f) => path.posix.basename(f));
  const picked = tests.filter((t) => touched.has(t) || reaches(t) || names.some((n) => read(t).includes(n)));
  const why = [`${touched.size} code file${touched.size === 1 ? '' : 's'} changed or named`, ...reasons].join('; ');
  return { all: false, files: picked, tests, why };
}

/**
 * The parts of a package.json test script the Steward can run a subset with: `node [flags] --test [flags] "<glob>" …`, as
 * every Node repository of the manor's has it. Null for anything else (vitest, a script of several commands), which then
 * runs whole. Pure.
 */
export function nodeTestScript(script: string | undefined): { flags: string[]; globs: string[] } | null {
  if (!script) return null;
  const m = /^node((?:\s+--[\w-]+(?:=\S+)?)*)\s+--test((?:\s+--[\w-]+(?:=\S+)?)*)((?:\s+"[^"]+"|\s+'[^']+'|\s+[^\s"'&|;<>-][^\s&|;<>]*)+)\s*$/.exec(script.trim());
  if (!m) return null;
  const flags = [...`${m[1]} ${m[2]}`.trim().split(/\s+/).filter(Boolean)];
  const globs = [...m[3].matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map((x) => x[1] ?? x[2] ?? x[3]);
  return { flags, globs };
}

/** package.json's scripts in `dir`, or {} when it has none or can't be read. */
export function scriptsIn(dir: string): Record<string, string> {
  const p = path.join(dir, 'package.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')).scripts ?? {};
  } catch {
    return {};
  }
}
