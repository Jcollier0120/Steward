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
 * kit/CHANGELOG.md. A repository without `changes/README.md` keeps today's way, and the catch-up (stages/catchup.ts)
 * as before.
 */

/** The folder, and the file whose presence on a repository's branch says it writes its entries there. */
export const CHANGES_DIR = 'changes';
export const CHANGES_README = 'changes/README.md';
export const KIT_CHANGES_DIR = 'kit/changes';

/** What changes/README.md says, for a repository starting the folder. */
export const changesReadme = (name: string) =>
  `# ${name}'s changes waiting to be released\n\n` +
  'Each piece of work writes its changelog entry here as `<version>.md`, named by the version the Steward handed out for it (`claim-version`), and leaves the version files and CHANGELOG.md alone. ' +
  "The entry is what the Steward's kit spec/RELEASE-NOTES.md describes (a bold line, What's new and/or What changed, Before you update), without its `## ` heading. " +
  'When the Steward merges the work, it sets the version, moves the entry into CHANGELOG.md and deletes the file, so two pieces of work never meet in the same lines.\n';

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

/** The next version above `from` that is neither released nor taken, a minor step when `minor`. */
function nextFree(from: string, taken: Set<string>, minor: boolean): string {
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
const isMinor = (v: string) => /\.0$/.test(v) && !/^0\.0\./.test(v);

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
