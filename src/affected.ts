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
 * A version step (package.json, package-lock.json, src/app.ts and the like changing only in version lines) reaches nothing.
 * Markdown (a changelog, a README) reaches only the code that reads it where it lies: code that names it and finds files
 * from its own place (import.meta.url, __dirname, process.cwd(), a path read from the working folder). Code that names
 * CHANGELOG.md to read the changelog of a worktree or a commit it is given, as most of the Steward's does, isn't reached:
 * every PR's changelog entry would otherwise run two thirds of the Steward's suite. A code file that names a folder of its
 * own (`new URL('../core/', import.meta.url)`) takes in every file in it.
 *
 * In the Steward's own repository, which fills its kit from its own kit\ (`kitFrom`), a file of the kit reaches itself and
 * where the fill puts it (kit/node/store.ts at src/kit/store.ts, in each folder filled: the repository's and its kit
 * tests' fixture), so the tests that import the copy run too; kit/VERSION and kit.json's "kit" pin changing to a version
 * are a version step. In an agent's repository, whose kit comes from a release, kit.json and kit\ run everything.
 *
 * Anything it can't follow runs everything (`all`, with the reason): the TypeScript or npm setup (tsconfig, package.json or
 * its lockfile beyond their versions, .npmrc), the kit's fill (tools/kit.ts), test fixtures and snapshots, a code file
 * deleted or renamed, a non-code file no code names, or more than MAX_CHANGED files. Pure but for reading the
 * repository's files.
 */

export const MAX_CHANGED = 200;

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const isCode = (f: string) => CODE.test(f);
const posix = (f: string) => f.replace(/\\/g, '/');

/** What runs everything, whatever else the change holds. */
const EVERYTHING: [RegExp, string][] = [
  [/^tsconfig[^/]*\.json$/i, 'the TypeScript setup'],
  [/^\.npmrc$/i, "npm's setup"],
  [/^(pnpm-workspace\.yaml|\.yarnrc(\.yml)?)$/i, "the package manager's setup"],
  [/^tools\/kit\.ts$/i, 'the kit fill'],
  [/(^|\/)fixtures?\//i, 'test fixtures'],
  [/(^|\/)__snapshots__\//i, 'test snapshots'],
];

/** What runs everything too where the kit comes from a release (an agent's): its pin, and a kit tree it doesn't fill from. */
const KIT_FROM_RELEASE: [RegExp, string][] = [
  [/^kit\.json$/i, 'the kit pin'],
  [/^kit\//i, 'the kit itself'],
];

/** Where each part of the kit lands in a folder tools/kit.ts fills (its PARTS, under src/kit). */
export const KIT_LANDS: Record<string, string> = { node: 'src/kit', web: 'src/kit/web', spec: 'src/kit/spec', core: 'src/kit/core', dotnet: 'src/kit/dotnet', react: 'src/kit/react' };

/**
 * Where a file of the kit tree lands in an agent taking `parts` (node/npu.ts at src/kit/npu.ts, LICENSE at
 * src/kit/LICENSE), or null for one it doesn't get or that changes with every kit: VERSION, the changelog, the kit's own
 * tests, a part it doesn't take. Pure.
 */
export function landsAt(kitPath: string, parts: string[]): string | null {
  const p = posix(kitPath);
  if (p === 'LICENSE') return 'src/kit/LICENSE';
  const [part, ...rest] = p.split('/');
  if (!rest.length || !parts.includes(part) || !(part in KIT_LANDS)) return null;
  return `${KIT_LANDS[part]}/${rest.join('/')}`;
}

/** What finds files from a code file's own place, or the working folder's. */
const PLACE = /import\.meta\.(url|dirname|filename)|__dirname|__filename|process\.cwd\(\)/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The calls that build a path from another: an expression with any other call reads or runs something there. */
const PATH_CALL = /^(path\.(posix\.|win32\.)?(join|resolve|dirname|normalize|relative)|fileURLToPath|pathToFileURL|URL|String|realpathSync(\.native)?)$/;
const pathOnly = (expr: string) => !/\bawait\b/.test(expr) && [...expr.matchAll(/([A-Za-z_$][\w$.]*)\s*\(/g)].every((m) => PATH_CALL.test(m[1]));

/**
 * Whether code names `name` on a line that finds it where it lies in the repository: beside import.meta.url, __dirname or
 * process.cwd(), or a name holding one (`const root = …import.meta.url…`, `const kitDir = path.join(root, 'kit')`), or
 * read from the working folder (`readFileSync('CHANGELOG.md')`). Comments don't count. Code that names it only to read a
 * folder it is given (`path.join(dir, 'CHANGELOG.md')`) reads another repository's. Pure.
 */
export function readsInPlace(text: string, name: string): boolean {
  if (!text.includes(name)) return false;
  const lines = text.split(/\r?\n/);
  const assigns = lines.map((l) => /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const places: RegExp[] = [];
  const holds = (s: string) => PLACE.test(s) || places.some((p) => p.test(s));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [, id, expr] of assigns) {
      const word = new RegExp(`(^|[^\\w$.])${escapeRe(id)}(?![\\w$])`);
      // A path built from a place holds one; what is read or run there (a package.json's text, a result) doesn't.
      if (!places.some((p) => p.source === word.source) && holds(expr) && pathOnly(expr)) places.push(word), (grew = true);
    }
  }
  const fromCwd = new RegExp(`\\b(readFileSync|readFile|existsSync|statSync|createReadStream)\\(\\s*['"\`](\\./)?([\\w.-]+/)*${escapeRe(name)}['"\`]`);
  return lines.some((l) => l.includes(name) && !/^\s*(\*|\/\/|\/\*)/.test(l) && (holds(l) || fromCwd.test(l)));
}

/** A code file's folders of its own (`new URL('../core/', import.meta.url)`): each file in them is one it reads. */
const FOLDER = /new URL\(\s*(['"])(\.{1,2}\/(?:[^'"]*\/)?|\.{1,2})\1\s*,\s*import\.meta\.url\s*\)/g;

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
  const tries = [base, ...['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.tsx', '/index.js'].map((x) => base + x)];
  for (const t of tries) if (known.has(t)) return t;
  // .js written for a .ts file (TypeScript's own style), and .mjs for .mts.
  const swapped = base.replace(/\.js$/i, '.ts').replace(/\.jsx$/i, '.tsx').replace(/\.mjs$/i, '.mts');
  return known.has(swapped) ? swapped : null;
}

/** The changed lines of a unified diff of one file, its headers left out. Pure. */
const changedLines = (patch: string) => patch.split(/\r?\n/).filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));

/**
 * Whether a unified diff of one file changes only lines that carry a version (a version step): lines naming a version
 * ("version": "0.4.1"), or, for a VERSION file, the version alone. Pure.
 */
export function versionOnly(patch: string, file = ''): boolean {
  const lines = changedLines(patch);
  const bare = /(^|\/)VERSION$/.test(posix(file));
  return lines.length > 0 && lines.every((l) => (bare ? /^[+-]\s*\d+\.\d+\.\d+\S*\s*$/.test(l) : /\bversion\b/i.test(l) && /\d+\.\d+\.\d+/.test(l)));
}

/** Whether a diff of kit.json changes only its "kit" pin, to another version. Pure. */
export const pinOnly = (patch: string) => {
  const lines = changedLines(patch);
  return lines.length > 0 && lines.every((l) => /^[+-]\s*"kit"\s*:\s*"\d+\.\d+\.\d+[^"]*"\s*,?\s*$/.test(l));
};

/**
 * The test files (matching `testGlobs`) a change in `dir` reaches, as the module's comment says. `patchOf` gives a changed
 * file's diff, to tell a version step from any other change. `kitFrom`: the folder the repository fills its kit from
 * (the Steward's own "kit"), where a kit file reaches where the fill puts it.
 */
export function affectedTests(o: { dir: string; changed: Changed[]; testGlobs: string[]; patchOf: (file: string) => string; kitFrom?: string }): Affected {
  const files = filesIn(o.dir);
  const globs = o.testGlobs.map(globRe);
  const tests = files.filter((f) => globs.some((g) => g.test(f))).sort();
  const everything = (why: string): Affected => ({ all: true, why, tests });
  if (o.changed.length > MAX_CHANGED) return everything(`${o.changed.length} files changed`);
  const known = new Set(files);
  const code = files.filter(isCode);
  const kitFrom = o.kitFrom ? posix(o.kitFrom).replace(/\/+$/, '') : null;
  // Each folder the fill has filled (tools/kit.ts leaves src/kit/PARTS in it): the repository's, and its fixtures'.
  const filled = files.filter((f) => /(^|\/)src\/kit\/PARTS$/.test(f)).map((f) => f.slice(0, -'src/kit/PARTS'.length));
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
  const patchOf = (f: string) => {
    try {
      return o.patchOf(f);
    } catch {
      return '';
    }
  };
  const inKit = (f: string) => !!kitFrom && f.startsWith(`${kitFrom}/`);
  // The tests that read a file where it lies: of the own kit's versions, those checking that they agree.
  const readers = (f: string) => {
    const r = tests.filter((t) => readsInPlace(read(t), path.posix.basename(f)));
    for (const t of r) touched.add(t);
    return r.length ? `, and the ${r.length} test file${r.length === 1 ? '' : 's'} reading it` : '';
  };
  // Each code file's folders of its own, the folder it lies in or one below. The repository's root or a folder above its
  // own is where it finds things from (src/app.ts's `new URL('..', import.meta.url)`), not what it reads.
  let folders: { x: string; folder: string }[] | null = null;
  const readFolders = () =>
    (folders ??= code.flatMap((x) => {
      const own = path.posix.dirname(x);
      return [...read(x).matchAll(FOLDER)]
        .map((m) => path.posix.normalize(path.posix.join(own, m[2])).replace(/\/+$/, ''))
        .filter((folder) => folder !== '.' && !folder.startsWith('..') && !(folder !== own && `${own}/`.startsWith(`${folder}/`)))
        .map((folder) => ({ x, folder }));
    }));
  for (const c of o.changed) {
    const f = posix(c.path);
    const hit = EVERYTHING.find(([re]) => re.test(f)) ?? (kitFrom ? undefined : KIT_FROM_RELEASE.find(([re]) => re.test(f)));
    if (hit) return everything(`${f} changed (${hit[1]})`);
    const gone = c.status.startsWith('D') || c.status.startsWith('R') || !known.has(f);
    if (gone) {
      if (isCode(f)) return everything(`${f} was deleted or renamed`);
      continue;
    }
    if (versionOnly(patchOf(f), f)) {
      reasons.push(`${f}: a version step${inKit(f) ? readers(f) : ''}`);
      continue;
    }
    if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(f) && !inKit(f)) return everything(`${f} changed beyond its version`);
    if (kitFrom && /^kit\.json$/i.test(f)) {
      // The repository's own kit, filled from its folder: the pin says which version that is, and the parts what lands.
      if (!pinOnly(patchOf(f))) return everything(`${f} changed beyond its kit's version (the kit pin)`);
      reasons.push(`${f}: the kit's version step${readers(f)}`);
      continue;
    }
    // A file of the kit, filled from here: where the fill puts it, in each folder filled, as it would be changed there.
    const at = inKit(f) ? landsAt(f.slice(kitFrom!.length + 1), Object.keys(KIT_LANDS)) : null;
    const copies = at ? filled.map((root) => `${root}${at}`).filter((x) => known.has(x)) : [];
    if (isCode(f)) {
      touched.add(f);
      for (const x of copies) touched.add(x);
      if (copies.length) reasons.push(`${f}: and its ${copies.length === 1 ? 'copy' : 'copies'} at ${copies.join(', ')}`);
      continue;
    }
    // Not code: it counts through the code that names it; Markdown only through the code that reads it where it lies.
    const name = path.posix.basename(f);
    const markdown = /\.(md|markdown)$/i.test(f);
    const naming = code.filter((x) => (markdown ? readsInPlace(read(x), name) : read(x).includes(name)));
    if (naming.length) {
      for (const x of naming) touched.add(x);
      reasons.push(`${f}: through ${naming.length} file${naming.length === 1 ? '' : 's'} ${markdown ? 'reading' : 'naming'} it`);
    } else if (readFolders().some((r) => r.x !== f && f.startsWith(`${r.folder}/`))) {
      reasons.push(`${f}: in a folder code reads`);
    } else if (markdown || /^(LICENSE|NOTICE)/i.test(name) || /^\.(gitignore|gitattributes|editorconfig)$/i.test(name) || /^\.(github|claude|vscode)\//i.test(f)) {
      reasons.push(`${f}: no code reads it`);
    } else return everything(`${f} changed, and no code names it`);
  }
  // A code file that names a folder of its own reads each file in it: a change in the folder reaches it.
  const changedPaths = [...o.changed.map((c) => posix(c.path)), ...touched];
  for (const { x, folder } of readFolders()) {
    if (touched.has(x) || !changedPaths.some((p) => p !== x && p.startsWith(`${folder}/`))) continue;
    touched.add(x);
    reasons.push(`${x}: reads the folder ${folder}`);
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

/**
 * The folder of its own a repository fills its kit from (`node tools/kit.ts --from kit` in a script, a kit's VERSION in
 * that folder): the Steward's "kit". Null for an agent, whose kit comes from a release. Pure but for one file's existence.
 */
export function kitFromOf(dir: string, scripts: Record<string, string>): string | null {
  for (const s of Object.values(scripts)) {
    const m = /\btools[\\/]kit\.ts\s+--from\s+["']?([^\s"'&|;]+)/.exec(s);
    const from = m ? posix(m[1]).replace(/^\.\//, '').replace(/\/+$/, '') : '';
    if (from && !path.isAbsolute(from) && !from.split('/').includes('..') && existsSync(path.join(dir, from, 'VERSION'))) return from;
  }
  return null;
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
