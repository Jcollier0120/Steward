/**
 * A release's notes, from the repository's CHANGELOG.md (spec/RELEASE-NOTES.md): its entry for the version, under
 * `## <version>`, says what's new, what changed and what to do before updating. The notes are that entry, between a
 * first line Manor reads ("built from <commit>") and how to install it. A version nobody wrote an entry for still says
 * what changed: its commits since the release before, marked as such, so a release never goes out with nothing in it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The changelog, at the repository's root. */
export const CHANGELOG = 'CHANGELOG.md';

/** An entry's headings, in the order an entry gives them (spec/RELEASE-NOTES.md). */
export const HEADINGS = { added: "What's new", changed: 'What changed', care: 'Before you update' } as const;

/** What an entry says when updating needs nothing of anyone. */
export const NOTHING_TO_DO = 'Nothing: it updates itself as usual.';

/** At most this many commits are listed for a version with no entry. */
const MAX_COMMITS = 30;

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The version a `## ` heading names: "## 0.4.50", "## v0.4.50", "## [0.4.50] - 2026-10-05". */
export function headingVersion(line: string): string | null {
  return /^## +\[?v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\]?(?=\s|$|[^\w.])/.exec(line)?.[1] ?? null;
}

/** The changelog's entry for `version`: what is under its `## ` heading, up to the next, trimmed; null when it has none, or nothing under it. */
export function entryOf(changelog: string, version: string): string | null {
  const lines = lf(changelog).split('\n');
  const at = lines.findIndex((l) => headingVersion(l) === version);
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  if (end < 0) end = lines.length;
  const body = lines.slice(at + 1, end).join('\n').trim();
  return body || null;
}

/** The `### ` headings an entry gives, as written. */
export const headingsOf = (entry: string) => lf(entry).split('\n').filter((l) => l.startsWith('### ')).map((l) => l.slice(4).trim());

/** The text under one `### ` heading of an entry (case aside), trimmed; null when it has no such heading. */
export function sectionOf(entry: string, heading: string): string | null {
  const lines = lf(entry).split('\n');
  const at = lines.findIndex((l) => new RegExp(`^### +${escape(heading)}\\s*$`, 'i').test(l));
  if (at < 0) return null;
  let end = lines.findIndex((l, i) => i > at && /^#{1,3} /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(at + 1, end).join('\n').trim();
}

/** What an entry is missing, in words, for the release to say before it publishes: nothing when it has all it should. */
export function entryWarnings(entry: string): string[] {
  const out: string[] = [];
  if (sectionOf(entry, HEADINGS.added) === null && sectionOf(entry, HEADINGS.changed) === null) out.push(`it has neither "### ${HEADINGS.added}" nor "### ${HEADINGS.changed}"`);
  const care = sectionOf(entry, HEADINGS.care);
  if (care === null) out.push(`it has no "### ${HEADINGS.care}" (write "${NOTHING_TO_DO}" when updating needs nothing)`);
  else if (!care) out.push(`its "### ${HEADINGS.care}" is empty (write "${NOTHING_TO_DO}" when updating needs nothing)`);
  return out;
}

/** An entry's headline: its first paragraph's bold opening (`**...**`), else its first sentence; null for an entry that starts with a heading or a list. */
export function headlineOf(entry: string): string | null {
  const first = lf(entry).trim().split(/\n\s*\n/)[0]?.trim() ?? '';
  if (!first || /^(#|[-*] |\d+\. )/.test(first)) return null;
  const bold = /^\*\*(.+?)\*\*/s.exec(first);
  if (bold) return bold[1].replace(/\s+/g, ' ').trim();
  return (/^(.+?[.!?])(\s|$)/s.exec(first)?.[1] ?? first).replace(/\s+/g, ' ').trim();
}

/** A version's place, number by number, for sorting tags: [major, minor, patch]. */
const parts = (v: string) => v.split(/[-+]/)[0].split('.').map(Number);
function compare(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/**
 * A commit's line for the notes: a pull request's merge says its title (the second line of its message), a commit its
 * subject. Merges of a branch into another and work-in-progress commits say nothing (null).
 */
export function commitLine(subject: string, body: string): string | null {
  const s = subject.trim();
  if (/^Merge pull request #\d+ from /.test(s)) return body.trim().split('\n')[0]?.trim() || null;
  if (/^Merge (remote-tracking )?branch /.test(s) || /^Merge commit /.test(s)) return null;
  if (/^(wip|fixup!|squash!)/i.test(s)) return null;
  return s || null;
}

const gitAt = (root: string) => (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

/** The release before `version`: the newest tag v<x.y.z> below it that HEAD carries, or null when it carries none. */
export function tagBefore(root: string, version: string): string | null {
  try {
    const tags = gitAt(root)('tag', '--merged', 'HEAD', '--list', 'v[0-9]*').split('\n').map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
    return tags.filter((t) => compare(t.slice(1), version) < 0).sort((a, b) => compare(b.slice(1), a.slice(1)))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The entries for the versions after `since` (the release before) and below `version`, newest first: versions merged
 * but never released on their own, which this release brings too (the Steward releases once for all it merged in a
 * round). None when `since` is unknown, so a first release never repeats the whole history.
 */
export function entriesBetween(changelog: string, since: string | null, version: string): { version: string; entry: string }[] {
  if (!since) return [];
  const from = since.replace(/^v/, '');
  const out: { version: string; entry: string }[] = [];
  for (const l of lf(changelog).split('\n')) {
    const v = headingVersion(l);
    if (!v || compare(v, from) <= 0 || compare(v, version) >= 0 || out.some((x) => x.version === v)) continue;
    const entry = entryOf(changelog, v);
    if (entry) out.push({ version: v, entry });
  }
  return out.sort((a, b) => compare(b.version, a.version));
}

/**
 * A release's entry with those of the versions it brings too (entriesBetween), each under its own `## ` heading after a
 * line that names them; null when the version has no entry.
 */
export function combinedEntry(changelog: string, version: string, since: string | null): string | null {
  const entry = entryOf(changelog, version);
  if (!entry) return null;
  const earlier = entriesBetween(changelog, since, version);
  if (!earlier.length) return entry;
  const names = earlier.map((x) => `v${x.version}`);
  const said = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return [entry, '', `This release brings ${said} too, never released on ${names.length === 1 ? 'its' : 'their'} own:`, ...earlier.flatMap((x) => ['', `## ${x.version}`, '', x.entry])].join('\n');
}

/**
 * The commits since the release before `version`, for a version with no entry: the newest tag v<x.y.z> below it that
 * HEAD carries (tagBefore), and each commit on the first-parent line since, as commitLine says it (newest first, at most
 * 30). `since` is that tag, or null when HEAD carries none (then the latest 10 commits).
 */
export function commitsSince(root: string, version: string): { since: string | null; lines: string[] } {
  const git = gitAt(root);
  const since = tagBefore(root, version);
  let log = '';
  try {
    log = git('log', '--first-parent', '--format=%s%x1f%b%x1e', ...(since ? [`${since}..HEAD`] : ['-n', '10']));
  } catch {
    return { since, lines: [] };
  }
  const lines = log
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject, body = ''] = c.split('\x1f');
      return commitLine(subject, body);
    })
    .filter((l): l is string => !!l);
  return { since, lines: [...new Set(lines)].slice(0, MAX_COMMITS) };
}

export interface NotesInput {
  /** The repository's root: CHANGELOG.md is there, and its git history for a version with no entry. */
  root: string;
  name: string;
  version: string;
  commit: string;
  /** The Steward's kit it carries, when it carries one. */
  kit?: string | null;
  /** How to install it: the notes' last section, under "Installing". */
  install: string;
  /** The changelog's text, instead of reading it from `root` (tests). */
  changelog?: string | null;
  /** The commits since the release before, instead of asking git (tests). */
  commits?: { since: string | null; lines: string[] };
  /** The release before (v<x.y.z>), instead of asking git: the entries after it are brought too (combinedEntry). */
  since?: string | null;
}

export interface Notes {
  notes: string;
  /** Where what changed came from: the changelog's entry, or the commits since the release before. */
  from: 'changelog' | 'commits';
  /** What the release should say before it publishes: an entry that's missing, or missing a heading. */
  warnings: string[];
}

/** The changelog's text at `root`, or null when it has none. */
export function readChangelog(root: string): string | null {
  try {
    return readFileSync(path.join(root, CHANGELOG), 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

/** The release's notes: its first line ("<name> <version>, built from <commit>..."), what changed, and how to install it. */
export function releaseNotes(o: NotesInput): Notes {
  const changelog = o.changelog !== undefined ? o.changelog : readChangelog(o.root);
  const entry = changelog ? entryOf(changelog, o.version) : null;
  const warnings: string[] = [];
  let body: string;
  if (entry) {
    // The versions merged since the release before and never released on their own come with it.
    const since = o.since !== undefined ? o.since : o.commits ? o.commits.since : tagBefore(o.root, o.version);
    body = combinedEntry(changelog!, o.version, since)!;
    for (const w of entryWarnings(entry)) warnings.push(`${CHANGELOG}'s entry for ${o.version}: ${w}`);
    for (const x of entriesBetween(changelog!, since, o.version)) for (const w of entryWarnings(x.entry)) warnings.push(`${CHANGELOG}'s entry for ${x.version}: ${w}`);
  } else {
    warnings.push(changelog ? `${CHANGELOG} has no "## ${o.version}" entry: the notes list the commits instead` : `there's no ${CHANGELOG}: the notes list the commits instead`);
    const c = o.commits ?? commitsSince(o.root, o.version);
    const said = c.since ? `its commits since ${c.since}` : 'its latest commits';
    body = [
      `### ${HEADINGS.changed}`,
      '',
      c.lines.length ? `No changelog entry was written for this version. These are ${said}:` : 'No changelog entry was written for this version.',
      ...(c.lines.length ? ['', ...c.lines.map((l) => `- ${l}`)] : []),
    ].join('\n');
  }
  // "built from <commit>": Manor reads the commit from it (its releases.ts), since the releases repository's tag is its own.
  const first = `${o.name} ${o.version}, built from ${o.commit}${o.kit ? `, with the Steward's kit ${o.kit}` : ''}.`;
  return { notes: [first, '', body, '', '### Installing', '', o.install.trim(), ''].join('\n'), from: entry ? 'changelog' : 'commits', warnings };
}

/** The changelog's opening, for one started from nothing. */
export const changelogHead = (name: string) =>
  `# ${name}'s changelog\n\nEach version of ${name}, newest first. A version's entry is its release's notes: what's new, what changed, and what to do before updating (the Steward's kit, spec/RELEASE-NOTES.md).\n`;

/**
 * The changelog with `entry` (its `## <version>` heading and all) as its newest: above the first entry, or after the
 * opening of one with none; a changelog started from nothing when `text` is null. Unchanged when it has that version already.
 */
export function withEntry(text: string | null, entry: string, name: string): string {
  const version = headingVersion(lf(entry).split('\n')[0]);
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  const lines = lf(text ?? changelogHead(name)).split('\n');
  if (version && lines.some((l) => headingVersion(l) === version)) return text!;
  const at = lines.findIndex((l) => l.startsWith('## '));
  const add = lf(entry).trim().split('\n');
  let out: string[];
  if (at < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    out = [...lines, '', ...add, ''];
  } else out = [...lines.slice(0, at), ...add, '', ...lines.slice(at)];
  return out.join('\n').replace(/\n/g, eol);
}
