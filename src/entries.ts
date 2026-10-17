import { compareVersions } from './kitfiles.ts';
import { headingVersion, withEntry } from './kit/notes.ts';
import { bumpPatch } from './versions.ts';

/**
 * Changelog entries written as files of their own, so that two pull requests side by side never touch the same lines.
 * In a repository with `changes/README.md` on its branch, a piece of work leaves the version files and CHANGELOG.md
 * alone and writes its entry as `changes/<version>.md`, named by the version claimed for it (claims.ts): the entry as
 * spec/RELEASE-NOTES.md has it, without its `## ` heading. The Steward stamps it just before it merges the pull request
 * (stages/stamp.ts): the version set in the version files, the entry folded into CHANGELOG.md under `## <version>`, and
 * the file deleted, in a commit on the pull request's own branch. Nothing is ever pushed to the branch itself.
 *
 * In the Steward's own repository the kit has the same: `kit/changes/<kit version>.md` for kit/VERSION and
 * kit/CHANGELOG.md. A repository without `changes/README.md` keeps today's way. A build puts main's
 * entries together into one version and entry (stages/stamp.ts).
 */

/** The folder, and the file whose presence on a repository's branch says it writes its entries there. */
export const CHANGES_DIR = 'changes';
export const CHANGES_README = 'changes/README.md';
export const KIT_CHANGES_DIR = 'kit/changes';

/** What changes/README.md says, for a repository starting the folder. */
export const changesReadme = (name: string) =>
  `# ${name}'s changes waiting to be released\n\n` +
  'Each piece of work writes its changelog entry here and leaves the version files and CHANGELOG.md alone: as `<branch>.md` (its branch as one word, `claude/build-pipeline` → `claude-build-pipeline.md`) when the Steward builds at set times, which picks no version (a first line `minor: true` asks for a minor step); ' +
  'else as `<version>.md`, named by the version the Steward handed out for it (`claim-version`). ' +
  "The entry is what the Steward's kit spec/RELEASE-NOTES.md describes (a bold line, What's new and/or What changed, Before you update), without its `## ` heading. " +
  'When the Steward merges the work, it sets the version, moves the entry into CHANGELOG.md (each `<branch>.md` merged before the next release into that release\'s one entry) and deletes the file, so two pieces of work never meet in the same lines.\n';

const VERSION_FILE = /^(?:kit\/)?changes\/(\d+\.\d+\.\d+)\.md$/;

/** The version a changes file is named by ("changes/0.16.32.md" → "0.16.32"), or null for any other path. */
export function changeVersion(file: string, dir = CHANGES_DIR): string | null {
  const f = file.replace(/\\/g, '/');
  if (!f.startsWith(`${dir}/`)) return null;
  return VERSION_FILE.exec(f)?.[1] ?? null;
}

/** The changes files among some paths, in a folder, lowest version first. */
export const changeFiles = (files: string[], dir = CHANGES_DIR): string[] =>
  files
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => changeVersion(f, dir) !== null)
    .sort((a, b) => compareVersions(changeVersion(a, dir)!, changeVersion(b, dir)!));

/**
 * A changes file's entry, as it goes under its `## ` heading: its text trimmed, with a `## ` heading of its own left
 * out when it names the same version (or none). Null when it says nothing, or names another version in its heading:
 * that needs a person.
 */
export function entryBody(text: string, version: string): string | null {
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return null;
  if (lines[first].startsWith('## ')) {
    const named = headingVersion(lines[first]);
    if (named && named !== version) return null;
    lines.splice(first, 1);
  }
  const body = lines.join('\n').trim();
  return body || null;
}

/**
 * Fragments (the build pipeline, pipeline.ts): a piece of work that doesn't pick its version writes its entry as
 * `changes/<branch-slug>.md`, any name but a version's or the README's. The stamp gives every fragment merged before the
 * next release the same version, one above the last released (a minor step when one says `minor: true` on its first
 * line), and composes them into that version's one entry: so a build releases each repository once, with one entry.
 */
const isFragment = (f: string, dir: string) => f.startsWith(`${dir}/`) && f.endsWith('.md') && !f.slice(dir.length + 1).includes('/') && f.toLowerCase() !== `${dir}/readme.md` && changeVersion(f, dir) === null;

/** The fragments among some paths, in a folder, by name. */
export const fragmentFiles = (files: string[], dir = CHANGES_DIR): string[] =>
  files
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => isFragment(f, dir))
    .sort();

/** A branch's fragment: changes/<branch, as one lowercase word with dashes>.md. */
export const fragmentFor = (branch: string, dir = CHANGES_DIR) =>
  `${dir}/${
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'change'
  }.md`;

/** A fragment's entry and whether it asks for a minor step; null when it says nothing. A `## ` heading of its own is left out. */
export function fragmentBody(text: string): { body: string; minor: boolean } | null {
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  let minor = false;
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first >= 0 && /^minor:\s*(true|yes)\s*$/i.test(lines[first].trim())) {
    minor = true;
    lines.splice(first, 1);
  }
  const next = lines.findIndex((l) => l.trim() !== '');
  if (next >= 0 && lines[next].startsWith('## ')) lines.splice(next, 1);
  const body = lines.join('\n').trim();
  return body ? { body, minor } : null;
}

const NOTHING = /^[-*]?\s*Nothing: it updates itself as usual\.?\s*$/i;
const ORDER = ["what's new", 'what changed', 'before you update'];

/** An entry's parts: its headline (the bold line), what comes before its first section, and each `### ` section's lines. */
function parts(body: string): { head: string; lead: string[]; sections: [string, string[]][] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  const head = first >= 0 ? lines[first].trim() : '';
  const lead: string[] = [];
  const sections: [string, string[]][] = [];
  for (const l of lines.slice(first + 1)) {
    if (l.startsWith('### ')) sections.push([l.slice(4).trim(), []]);
    else if (sections.length) sections.at(-1)![1].push(l);
    else lead.push(l);
  }
  const trim = (xs: string[]) => {
    const a = xs.findIndex((l) => l.trim() !== '');
    if (a < 0) return [];
    let b = xs.length - 1;
    while (xs[b].trim() === '') b--;
    return xs.slice(a, b + 1);
  };
  return { head, lead: trim(lead), sections: sections.map(([t, ls]) => [t, trim(ls)]) };
}

/** A headline as words: its bold and its last full stop taken off. */
const headWords = (head: string) => head.replace(/^\*\*|\*\*$/g, '').trim().replace(/\.$/, '');
const BRINGS = /^Brings (\d+) changes: (.*)$/;

/**
 * Two entries made one (the first, then the second): headline "Brings N changes: <each headline>", each section's
 * bullets one after the other, and "Before you update" saying "Nothing: it updates itself as usual." only when neither
 * says anything else. Pure.
 */
export function composeEntry(a: string, b: string): string {
  const x = parts(a);
  const y = parts(b);
  const xh = headWords(x.head);
  const was = BRINGS.exec(xh);
  const head = `**Brings ${was ? Number(was[1]) + 1 : 2} changes: ${was ? was[2] : xh}; ${headWords(y.head)}.**`;
  const sections = new Map<string, { title: string; lines: string[] }>();
  for (const [title, lines] of [...x.sections, ...y.sections]) {
    const key = title.toLowerCase();
    const s = sections.get(key);
    if (s) s.lines.push(...lines);
    else sections.set(key, { title, lines: [...lines] });
  }
  const before = sections.get('before you update');
  if (before) {
    const said = before.lines.filter((l) => l.trim() !== '' && !NOTHING.test(l));
    before.lines = said.length ? said : ['- Nothing: it updates itself as usual.'];
  }
  // Sections it doesn't know go before "Before you update", which stays last.
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : 1.5);
  const ordered = [...sections.entries()].sort((p, q) => rank(p[0]) - rank(q[0]));
  const lead = [...x.lead, ...(x.lead.length && y.lead.length ? [''] : []), ...y.lead];
  return [head, ...(lead.length ? ['', ...lead] : []), ...ordered.flatMap(([, s]) => ['', `### ${s.title}`, '', ...s.lines])]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body under `## <version>` in a changelog, with where it starts and ends (lines), or null when it has none. */
function entryAt(lines: string[], version: string): { at: number; end: number; body: string } | null {
  const heading = new RegExp(`^## \\[?v?${escape(version)}\\]?(\\s|$)`);
  const at = lines.findIndex((l) => heading.test(l));
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { at, end, body: lines.slice(at + 1, end).join('\n').trim() };
}

/**
 * The changelog with `body` in `version`'s entry: composed with what that entry has (composeEntry), or a new entry on
 * top when it has none. `from`: the entry is that version's until now, its heading renamed (a minor step asked for). Pure.
 */
export function addToEntry(changelog: string | null, name: string, version: string, body: string, from?: string): string {
  const eol = changelog?.includes('\r\n') ? '\r\n' : '\n';
  const lines = (changelog ?? '').replace(/\r\n/g, '\n').split('\n');
  const found = entryAt(lines, from ?? version) ?? (from ? entryAt(lines, version) : null);
  if (!found) return foldEntries(changelog, name, [{ version, body }]);
  const composed = found.body ? composeEntry(found.body, body) : body;
  const out = [...lines.slice(0, found.at), `## ${version}`, '', ...composed.split('\n'), '', ...lines.slice(found.end)];
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n/g, eol);
}

/** The next version above `from` that is neither released nor taken, a minor step when `minor`. */
export function nextFree(from: string, taken: Set<string>, minor: boolean): string {
  const step = (v: string) => {
    if (!minor) return bumpPatch(v);
    const [x, y] = v.split('.').map(Number);
    return `${x}.${y + 1}.0`;
  };
  let v = step(from);
  while (taken.has(v)) v = bumpPatch(v);
  return v;
}

/** Whether a version is a minor step (x.y.0): it keeps being one when the stamp has to give it another number. */
export const isMinor = (v: string) => /\.0$/.test(v) && !/^0\.0\./.test(v);

export interface Stamped {
  /** The changes file. */
  file: string;
  /** The version it was named by. */
  wanted: string;
  /** The version it gets: its own while still free, else the next free one of the same step. */
  version: string;
  /** Why not its own, when it isn't. */
  why: string | null;
}

/**
 * The versions some changes files get, lowest first, above the branch's (`base`): each its own while it is above the one
 * before, not released, and not `taken` (other open work's); else the next free one, a minor step for one named x.y.0.
 * The version files then carry the last one. Pure.
 */
export function stampVersions(files: string[], o: { base: string; released: string[]; taken: string[]; dir?: string }): Stamped[] {
  const taken = new Set([...o.released, ...o.taken]);
  let below = o.base;
  const out: Stamped[] = [];
  for (const file of changeFiles(files, o.dir)) {
    const wanted = changeVersion(file, o.dir)!;
    const why = o.released.includes(wanted)
      ? `v${wanted} is already released`
      : compareVersions(wanted, below) <= 0
        ? `the branch is at v${below} already`
        : o.taken.includes(wanted)
          ? `other work holds v${wanted}`
          : null;
    const version = why ? nextFree(below, taken, isMinor(wanted)) : wanted;
    taken.add(version);
    out.push({ file, wanted, version, why });
    below = version;
  }
  return out;
}

/**
 * The changelog with each stamped entry under its `## <version>` heading, the highest on top, above what it had: one
 * started from nothing (named `name`) when there was none. Unchanged for a version it has an entry for already. Pure.
 */
export function foldEntries(changelog: string | null, name: string, entries: { version: string; body: string }[]): string {
  let text = changelog;
  for (const x of [...entries].sort((a, b) => compareVersions(a.version, b.version))) text = withEntry(text, `## ${x.version}\n\n${x.body}\n`, name);
  return text ?? '';
}
