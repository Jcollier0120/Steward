/**
 * An employee's version, kept in several files that must agree (the kit's release.ts checks package.json
 * against src/app.ts): package.json, both of package-lock.json's own entries, a TypeScript file's
 * `version: 'x.y.z'` (src/app.ts's APP, Reeve's src/mcp.ts), a .csproj's <VersionPrefix>, a Rust crate's
 * Cargo.toml ([package] or [workspace.package]) or a Python project's pyproject.toml ([project] or
 * [tool.poetry]). Each file is changed in place, only at those spots, so the rest of it stays byte for byte.
 */

/** x.y.z with the patch one up. */
export function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`${v} isn't a version of the form x.y.z`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

const base = (file: string) => file.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
const kindOf = (file: string): 'package' | 'lock' | 'csproj' | 'plain' | 'toml' | 'code' => {
  const b = base(file);
  if (b === 'version') return 'plain';
  if (b === 'package.json') return 'package';
  if (b === 'package-lock.json') return 'lock';
  if (/\.(csproj|props)$/.test(b)) return 'csproj';
  if (b === 'cargo.toml' || b === 'pyproject.toml') return 'toml';
  return 'code';
};

/** The TOML tables a version is kept in: a crate's, a workspace's, a Python project's (PEP 621) or Poetry's. */
const TOML_TABLES: Record<string, string[]> = { 'cargo.toml': ['package', 'workspace.package'], 'pyproject.toml': ['project', 'tool.poetry'] };

/** Where a Cargo.toml's or pyproject.toml's version is: its `version = "x.y.z"` line in the first of its tables that has one. */
function tomlVersionAt(file: string, text: string): { start: number; end: number; version: string } | null {
  const lines = text.split('\n');
  let table = '';
  let offset = 0;
  const found: Record<string, { start: number; end: number; version: string }> = {};
  for (const line of lines) {
    const h = /^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(#.*)?\r?$/.exec(line);
    if (h) table = h[1];
    else if (!found[table]) {
      // version = "x.y.z" (or 'x.y.z'), its comment after it kept.
      const m = /^(\s*version\s*=\s*)(["'])(\d+\.\d+\.\d+)\2/.exec(line);
      if (m) found[table] = { start: offset + m[1].length + 1, end: offset + m[1].length + 1 + m[3].length, version: m[3] };
    }
    offset += line.length + 1;
  }
  for (const t of TOML_TABLES[base(file)] ?? []) if (found[t]) return found[t];
  return null;
}

/** `version: 'x.y.z'` (an object's), or `VERSION = 'x.y.z'` (a constant's, as a site's src/version.ts). */
const CODE = /(\b(?:version\s*:|VERSION\s*=)\s*)(['"])(\d+\.\d+\.\d+)\2/;
const CSPROJ = /(<(VersionPrefix|Version)>)(\d+\.\d+\.\d+)(<\/\2>)/;

/** The version a file carries, or null when it has none where it should. */
export function readVersion(file: string, text: string): string | null {
  const kind = kindOf(file);
  if (kind === 'package' || kind === 'lock') {
    try {
      const v = JSON.parse(text.replace(/^﻿/, '')).version;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  // A VERSION file (the kit's) is the version and nothing else.
  if (kind === 'plain') return /^\s*(\d+\.\d+\.\d+)\s*$/.exec(text.replace(/^﻿/, ''))?.[1] ?? null;
  if (kind === 'toml') return tomlVersionAt(file, text)?.version ?? null;
  return (kind === 'csproj' ? CSPROJ.exec(text)?.[3] : CODE.exec(text)?.[3]) ?? null;
}

/** The top-level "version" of a JSON file at 2-space indent, and (for a lockfile) the root package's. */
function setJson(file: string, text: string, from: string, to: string, lock: boolean): string {
  const json = JSON.parse(text.replace(/^﻿/, ''));
  if (json.version !== from) throw new Error(`${file} says ${json.version}, not ${from}`);
  // The top level's "version" is the first key at two spaces' indent.
  const top = /^( {2}|\t)"version"\s*:\s*"([^"]*)"/m;
  let out = text.replace(top, (m, ind: string) => `${ind}"version": "${to}"`);
  if (lock) {
    const i = out.search(/"packages"\s*:\s*\{\s*""\s*:\s*\{/);
    if (i < 0) throw new Error(`${file} has no packages[""]`);
    const head = out.slice(0, i);
    const rest = out.slice(i).replace(new RegExp(`("version"\\s*:\\s*")${from.replace(/\./g, '\\.')}(")`), `$1${to}$2`);
    out = head + rest;
  }
  const check = JSON.parse(out.replace(/^﻿/, ''));
  const want = structuredClone(json);
  want.version = to;
  if (lock && want.packages?.['']) want.packages[''].version = to;
  if (JSON.stringify(check) !== JSON.stringify(want)) throw new Error(`${file}: couldn't change only its version`);
  return out;
}

/** The file's text with its version changed from `from` to `to`, or an error naming the file. */
export function setVersion(file: string, text: string, from: string, to: string): string {
  const kind = kindOf(file);
  if (kind === 'package') return setJson(file, text, from, to, false);
  if (kind === 'lock') {
    const json = JSON.parse(text.replace(/^﻿/, ''));
    if (json.packages?.['']?.version !== from) throw new Error(`${file}'s own package says ${json.packages?.['']?.version}, not ${from}`);
    return setJson(file, text, from, to, true);
  }
  if (kind === 'plain') {
    if (readVersion(file, text) !== from) throw new Error(`${file} says ${text.trim()}, not ${from}`);
    return text.replace(from, to);
  }
  if (kind === 'toml') {
    const at = tomlVersionAt(file, text);
    if (!at) throw new Error(`${file} has no version = "x.y.z" in [${TOML_TABLES[base(file)].join('] or [')}]`);
    if (at.version !== from) throw new Error(`${file} says ${at.version}, not ${from}`);
    return `${text.slice(0, at.start)}${to}${text.slice(at.end)}`;
  }
  const re = kind === 'csproj' ? CSPROJ : CODE;
  const m = re.exec(text);
  if (!m) throw new Error(`${file} has no ${kind === 'csproj' ? '<VersionPrefix>' : "version: 'x.y.z'"}`);
  if (m[3] !== from) throw new Error(`${file} says ${m[3]}, not ${from}`);
  return text.replace(re, kind === 'csproj' ? `$1${to}$4` : `$1$2${to}$2`);
}

/**
 * The version all of an employee's version files agree on, from their texts (file to text, null when
 * missing): {version} or {error} naming each that disagrees.
 */
export function agreedVersion(texts: [string, string | null][]): { version: string } | { error: string } {
  const found = texts.map(([f, t]) => [f, t === null ? null : readVersion(f, t)] as const);
  const missing = found.filter(([, v]) => v === null).map(([f]) => f);
  if (missing.length) return { error: `no version found in ${missing.join(', ')}` };
  const first = found[0][1]!;
  const differ = found.filter(([, v]) => v !== first);
  if (differ.length) return { error: `the version files disagree: ${found.map(([f, v]) => `${f} ${v}`).join(', ')}` };
  return { version: first };
}
