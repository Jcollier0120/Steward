import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitMaybe } from '../git.ts';
import type { Runner } from '../run.ts';
import type { Ctx } from './common.ts';
import { releasedTree, stewardClone } from './trialpass.ts';

/**
 * Tests that copied a kit value (Steward 0.36.180). Kits 2.97.1, 2.98.0 and 2.98.1 were held by agents' tests that
 * expected the note label the kit had just reworded, and 2.100.0 by Reeve's, which expected the GenieX model the kit
 * had just renamed: nothing was broken, each agent showed exactly what the new kit says. Such a failure is an assertion
 * that expected a text the kit's diff takes out (a line it removes writes it) and got one the diff puts in (a line it
 * adds writes it), where the expected text is written once, as it is, in the failing assertion. bump.ts writes the new
 * text in its place and runs the checks again: passing, the bump goes on with its test brought up to the kit; failing,
 * the failure stands as before. Anything else is left alone: another kind of assertion (`match`, `ok`), a value the
 * test builds elsewhere, a text node's TAP output can't give exactly (one with a backslash, which it drops, or a line
 * break), or a step whose failures aren't all of this kind. A copied text it can't bring up is named in the failure.
 */

/** A text a kit line writes: as it is, or a template's own parts around what it fills in. */
export type KitText = { text: string } | { re: RegExp };

/** The texts the kit's diff takes out (on the lines it removes) and puts in (on the lines it adds). */
export interface KitChanges {
  removed: KitText[];
  added: KitText[];
}

/** One expected text in a test, brought up to the kit: its file (relative, with /), and where the failing assertion is. */
export interface CopyFix {
  file: string;
  line: number;
  column: number;
  from: string;
  to: string;
}

/** Shorter than this (a template's filled-in parts left out), a text says too little to be the kit's. */
const MIN_TEXT = 6;
/** How far past its first line an assertion is looked through for its closing parenthesis. */
const MAX_LINES = 60;

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
/** A JavaScript string's body as the program sees it: its escapes undone. Pure. */
const unescape = (s: string) =>
  s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, c: string) =>
    c.length > 1 && c[0] === 'u' ? String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16)) : c.length > 1 ? String.fromCharCode(parseInt(c.slice(1), 16)) : (ESCAPES[c] ?? c),
  );
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The texts one line of code writes: its quoted strings ('…', "…"), and its templates (`…`) as their own parts around
 * each ${…}. A template's ${…} may hold strings and braces of its own: they are part of what it fills in. Pure.
 */
export function textsOf(line: string): KitText[] {
  const out: KitText[] = [];
  let rest = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '`') {
      rest += line[i];
      continue;
    }
    const parts = [''];
    let j = i + 1;
    for (; j < line.length && line[j] !== '`'; j++) {
      if (line[j] === '\\') parts[parts.length - 1] += line[j] + (line[++j] ?? '');
      else if (line[j] === '$' && line[j + 1] === '{') {
        let depth = 1;
        for (j += 2; j < line.length && depth; j++) depth += line[j] === '{' ? 1 : line[j] === '}' ? -1 : 0;
        j--;
        parts.push('');
      } else parts[parts.length - 1] += line[j];
    }
    i = j;
    rest += ' ';
    const own = parts.map(unescape);
    if (own.join('').length < MIN_TEXT) continue;
    out.push(own.length === 1 ? { text: own[0] } : { re: new RegExp(`^${own.map(escapeRe).join('[\\s\\S]*?')}$`) });
  }
  for (const m of rest.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
    const text = unescape(m[1] ?? m[2]);
    if (text.length >= MIN_TEXT) out.push({ text });
  }
  return out;
}

/** Whether a kit text is this one. Pure. */
const writes = (k: KitText, s: string) => ('text' in k ? k.text === s : k.re.test(s));

/** The texts a `git diff -U0` of the kit takes out and puts in, its comments left out. Pure. */
export function kitChanges(patch: string): KitChanges {
  const out: KitChanges = { removed: [], added: [] };
  for (const line of patch.replace(/\r/g, '').split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---) /.test(line)) continue;
    const body = line.slice(1);
    if (/^\s*(\*|\/\/|\/\*)/.test(body)) continue;
    (line[0] === '+' ? out.added : out.removed).push(...textsOf(body));
  }
  return out;
}

/**
 * The kit's diff in the Steward's repository `repo` from kit `from` (its release's tag, kit-v<from>) to `to` (a tag or
 * a commit; left out, the files as they are): its code only, not its tests or its notes. Null when git can't say.
 */
export const kitPatch = (run: Runner, repo: string, from: string, to?: string): Promise<string | null> =>
  gitMaybe(run, repo, 'diff', '--no-color', '--no-ext-diff', '-U0', `kit-v${from}`, ...(to ? [to] : []), '--', 'kit', ':(exclude)kit/test', ':(exclude,glob)kit/**/*.md');

/**
 * What the kit changed from the agent's pin `from` to the kit it's bumped to: the tree `kitFrom` fills from (a trial's,
 * the kit as the Steward's main has it), or `kit`'s release. Each release's tag is fetched as releasedTree fetches it.
 * Null when either can't be had.
 */
export async function kitChangesFor(ctx: Ctx, o: { from: string; kit: string; kitFrom?: string | null }): Promise<KitChanges | null> {
  if (!(await releasedTree(ctx, o.from))) return null;
  const repo = o.kitFrom ? path.dirname(path.resolve(o.kitFrom)) : (await releasedTree(ctx, o.kit)) ? stewardClone(ctx) : null;
  const patch = repo ? await kitPatch(ctx.run, repo, o.from, o.kitFrom ? undefined : `kit-v${o.kit}`) : null;
  return patch === null ? null : kitChanges(patch);
}

/** A failed test as node's TAP output gives it: each leaf of what it expected and got, by its path in the value, and where it failed. */
export interface TapFailure {
  name: string;
  /** Its failureType: `subtestsFailed` for a suite whose tests failed. */
  kind?: string;
  error?: string;
  expected?: Map<string, string>;
  actual?: Map<string, string>;
  at?: { file: string; line: number; column: number };
}

const indentOf = (l: string) => l.length - l.trimStart().length;
/** A TAP value's text, when it is a quoted string. Pure. */
const unquote = (raw: string | undefined): string | null => (raw === undefined ? null : (/^'(.*)'$/.exec(raw) ?? /^"(.*)"$/.exec(raw) ?? /^`(.*)`$/.exec(raw))?.[1] ?? null);

/** A TAP field's value, read from its line in `block` on: its leaves by path. Undefined for one written as a block (`|-`). */
function leavesAt(block: string[], at: number, pad: number, value: string | undefined): Map<string, string> | undefined {
  if (value) return /^[|>][-+]?$/.test(value) ? undefined : new Map([['', value]]);
  const leaves = new Map<string, string>();
  const keys: { indent: number; key: string }[] = [];
  for (let k = at + 1; k < block.length && indentOf(block[k]) > pad; k++) {
    const m = /^(\s*)(.+?):(?: (.*))?$/.exec(block[k]);
    if (!m) return undefined;
    while (keys.length && keys[keys.length - 1].indent >= m[1].length) keys.pop();
    if (m[3] === undefined) keys.push({ indent: m[1].length, key: m[2] });
    else if (/^[|>][-+]?$/.test(m[3])) return undefined;
    else leaves.set([...keys.map((x) => x.key), m[2]].join('.'), m[3]);
  }
  return leaves;
}

/** The failed tests in node's TAP output (`not ok`, at any depth; not a TODO or SKIP), each as TapFailure. Pure. */
export function tapFailures(output: string): TapFailure[] {
  const lines = output.replace(/\r/g, '').split('\n');
  const out: TapFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m || /#\s*(TODO|SKIP)\b/i.test(m[2])) continue;
    const f: TapFailure = { name: m[2] };
    out.push(f);
    const pad = m[1].length + 2;
    if (lines[i + 1]?.trim() !== '---') continue;
    const block: string[] = [];
    let j = i + 2;
    for (; j < lines.length && !(lines[j].trim() === '...' && indentOf(lines[j]) === pad); j++) block.push(lines[j]);
    i = j;
    for (let k = 0; k < block.length; k++) {
      const fm = /^(\s*)(\w+):(?: (.*))?$/.exec(block[k]);
      if (!fm || fm[1].length !== pad) continue;
      const [, , key, value] = fm;
      if (key === 'failureType') f.kind = unquote(value) ?? value;
      else if (key === 'error' && value && !/^[|>]/.test(value)) f.error = unquote(value) ?? value;
      else if (key === 'expected' || key === 'actual') f[key] = leavesAt(block, k, pad, value);
      else if (key === 'stack') {
        for (let s = k + 1; s < block.length && indentOf(block[s]) > pad && !f.at; s++) {
          const at = /(file:\/\/\/[^\s()]+):(\d+):(\d+)/.exec(block[s]);
          if (at) f.at = { file: fileURLToPath(at[1]), line: Number(at[2]), column: Number(at[3]) };
        }
      }
    }
  }
  return out;
}

/** What the failure's assertion expected and got instead, where each is a text the kit changed: null when any difference isn't. Pure. */
export function copiedPairs(f: TapFailure, kit: KitChanges): { from: string; to: string }[] | null {
  if (!f.expected || !f.actual) return null;
  const pairs: { from: string; to: string }[] = [];
  for (const key of new Set([...f.expected.keys(), ...f.actual.keys()])) {
    const [e, a] = [f.expected.get(key), f.actual.get(key)];
    if (e === a) continue;
    const [from, to] = [unquote(e), unquote(a)];
    if (from === null || to === null || !kit.removed.some((k) => writes(k, from)) || !kit.added.some((k) => writes(k, to))) return null;
    pairs.push({ from, to });
  }
  return pairs.length ? pairs : null;
}

/** A text as each kind of JavaScript string writes it. Pure. */
const quoted = (s: string): Record<string, string> => {
  const body = (q: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(new RegExp(q, 'g'), `\\${q}`);
  return { "'": `'${body("'")}'`, '"': `"${body('"')}"`, '`': `\`${body('`').replace(/\$\{/g, '\\${')}\`` };
};

/**
 * Where the call at (line, column) (1-based: node's stack frame for an assertion names its method) ends: the offset in
 * `text` past its closing parenthesis, strings and comments skipped. Null when it doesn't close within MAX_LINES. Pure.
 */
function callAt(text: string, line: number, column: number): { start: number; end: number } | null {
  const starts = [0];
  for (let i = 0; i < text.length && starts.length < line + MAX_LINES; i++) if (text[i] === '\n') starts.push(i + 1);
  if (line > starts.length) return null;
  const start = starts[line - 1] + column - 1;
  const limit = starts[line - 1 + MAX_LINES] ?? text.length;
  let depth = 0;
  for (let i = start; i < limit; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) return null;
      i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { start, end: i + 1 };
  }
  return null;
}

/**
 * `text` with the one place the call at (line, column) writes `from` (as any kind of string) writing `to` instead, in
 * the same kind; null when the call writes it nowhere, or more than once. Pure.
 */
export function fixedText(text: string, fix: Pick<CopyFix, 'line' | 'column' | 'from' | 'to'>): string | null {
  const call = callAt(text, fix.line, fix.column);
  if (!call) return null;
  const span = text.slice(call.start, call.end);
  const forms = quoted(fix.from);
  const found = Object.entries(forms).flatMap(([q, form]) => [...span.matchAll(new RegExp(escapeRe(form), 'g'))].map((m) => ({ q, at: m.index })));
  if (found.length !== 1) return null;
  const [{ q, at }] = found;
  const begin = call.start + at;
  return text.slice(0, begin) + quoted(fix.to)[q] + text.slice(begin + forms[q].length);
}

const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/**
 * A file the stack names, relative to the worktree (with /), when it is one of the agent's own: in its worktree, not
 * in its kit or its packages. Node names a module by its real path, so a worktree reached through a link is followed.
 */
const ownFile = (dir: string, file: string): string | null => {
  for (const [d, f] of [[dir, file], [real(dir), real(file)]]) {
    const rel = path.relative(d, f);
    const parts = rel.split(/[\\/]/);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return parts.includes('node_modules') || (parts[0] === 'src' && parts[1] === 'kit') ? null : parts.join('/');
  }
  return null;
};

/** A failure TAP adds for others: a suite's (its subtests failed) or a test file's own. Pure. */
const forOthers = (f: TapFailure) => f.kind === 'subtestsFailed' || /^(test failed|\d+ subtests? failed)$/.test(f.error ?? '');

/** A text a failed test expected, which the kit changed: where its assertion is, when the stack names one of the agent's own files. */
export interface Copied {
  from: string;
  to: string;
  file?: string;
  line?: number;
}

/**
 * What a failed step's tests expected that the kit changed (see above): every such text (`seen`), and the fixes that
 * bring them up to the kit, or null when any failure in its output isn't one a fix makes pass. Reads the test files,
 * writes nothing.
 */
export function copiedKitValues(output: string, kit: KitChanges, dir: string): { seen: Copied[]; fixes: CopyFix[] | null } {
  const failures = tapFailures(output).filter((f) => !forOthers(f));
  const seen: Copied[] = [];
  const fixes = new Map<string, CopyFix>();
  let fixable = failures.length > 0;
  for (const f of failures) {
    const pairs = copiedPairs(f, kit);
    if (!pairs) {
      fixable = false;
      continue;
    }
    const file = f.at ? ownFile(dir, f.at.file) : null;
    for (const p of pairs) seen.push({ ...p, ...(file ? { file, line: f.at!.line } : {}) });
    let text: string | null = null;
    try {
      if (file) text = readFileSync(path.join(dir, file), 'utf8');
    } catch {
      text = null;
    }
    for (const p of pairs) {
      const fix = text !== null ? { file: file!, line: f.at!.line, column: f.at!.column, ...p } : null;
      if (!fix || fixedText(text!, fix) === null) fixable = false;
      else fixes.set(JSON.stringify(fix), fix);
    }
  }
  return { seen, fixes: fixable && fixes.size ? [...fixes.values()] : null };
}

/**
 * The fixes written into the worktree, the last place in each file first (so each one's line and column still hold).
 * Returns the files changed. A fix that no longer finds its text is skipped.
 */
export function applyFixes(dir: string, fixes: CopyFix[]): string[] {
  const files = [...new Set(fixes.map((f) => f.file))];
  for (const file of files) {
    const at = path.join(dir, file);
    let text = readFileSync(at, 'utf8');
    for (const fix of fixes.filter((f) => f.file === file).sort((a, b) => b.line - a.line || b.column - a.column)) text = fixedText(text, fix) ?? text;
    writeFileSync(at, text);
  }
  return files;
}

/** Copied texts or their fixes in a line, for a log, an alarm and a commit: `test/a.test.ts:241: 'old' → 'new'`, three at most. Pure. */
export function fixesLine(fixes: Copied[]): string {
  const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
  const named = fixes.slice(0, 3).map((f) => `${f.file ? `${f.file}:${f.line}: ` : ''}'${cut(f.from)}' → '${cut(f.to)}'`);
  return `${named.join('; ')}${fixes.length > 3 ? ` and ${fixes.length - 3} more` : ''}`;
}
