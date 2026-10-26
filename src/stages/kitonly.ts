import path from 'node:path';
import { FOLDER, landsAt, pinOnly, resolveSpecifier, specifiersOf, versionOnly } from '../affected.ts';
import { CHANGES_README } from '../entries.ts';
import { commitOf, gitMaybe, showFile } from '../git.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { changelogBetween } from '../kitfiles.ts';
import type { Employee } from '../settings.ts';
import type { Ctx } from './common.ts';
import { partsTaken } from './kitreach.ts';
import { urgentIn } from './rollout.ts';
import { readPin } from './staff.ts';
import { releasedTree, stewardClone } from './trialpass.ts';

/**
 * A release for a new kit alone (Steward 0.36.70). Every build rolls the newest kit out to every agent, and each bump is a
 * version of its own (bump.ts), so every build released every agent: 33 releases in the 08:00 build of 2026-10-16, most
 * of them nothing but a kit whose changes the agent never runs (a fix to the release's signing, the NPU's benchmark).
 * Now a version whose only change since the agent's last release is the Steward's kit bump (kit.json's pin, the versions,
 * its changelog entry, tools/kit.ts) is released only when:
 *
 * - the kit's entry, for a kit it brings, says it is urgent (its bold line starts "Urgent", as the rollout reads it), or
 *   names a fix for this agent (a line starting "**Fix for <Agent>", agents by name or id, comma-separated); or
 * - a file the kit changes is one the agent runs (runsReached): reached from the agent's own code, through what each file
 *   imports, the kit files it names (a script it starts, a list it reads) and the folders it reads; at most one such
 *   release an agent a day (kit-only-releases.json), the rest waiting for the next day's first build.
 *
 * Otherwise it waits, merged: its kit goes out with the agent's next release of its own, whose notes bring the bump's
 * entry too (release.ts's `since`). Anything that can't be worked out is released as before.
 */

export const kitOnlyReleasesFile = () => dataFile('kit-only-releases.json');

/** Each agent's last release for a kit alone, by id: its version, and when. */
type KitOnlyReleases = Record<string, { version: string; at: string }>;

export type KitOnly =
  /** Its own change too, or it can't be told: released as before. */
  | { kitOnly: false }
  /** A kit alone, released; `daily`: counted as the agent's kit-only release of the day. */
  | { kitOnly: true; release: true; why: string; daily: boolean }
  | { kitOnly: true; release: false; why: string };

/**
 * The files a kit bump changes in an agent, besides the version files: what bump.ts writes. On the build pipeline its
 * changes/ entry is gone once stamped, and changes/README.md comes with the bump that puts the agent on it.
 */
const BUMPED = new Set(['kit.json', 'CHANGELOG.md', 'tools/kit.ts', CHANGES_README]);

/**
 * Whether an agent's change since its last release is a kit bump alone: kit.json changes in its pin only, each version
 * file (or package.json, package-lock.json) in its versions only, and nothing else but the changelog and tools/kit.ts.
 * `patchOf` gives a file's diff. Pure.
 */
export function bumpAlone(changed: string[], versionFiles: string[], patchOf: (f: string) => string | null): boolean {
  if (!changed.includes('kit.json')) return false;
  for (const f of changed) {
    if (f === 'kit.json') {
      if (!pinOnly(patchOf(f) ?? '')) return false;
    } else if (versionFiles.includes(f) || /^package(-lock)?\.json$/.test(f)) {
      if (!versionOnly(patchOf(f) ?? '', f)) return false;
    } else if (!BUMPED.has(f)) return false;
  }
  return true;
}

/** The versions a kit changelog's text has entries for (`## <version>` headings), newest first. Pure. */
const versionsIn = (text: string) => [...text.matchAll(/^## +\[?v?(\d+\.\d+\.\d+)/gm)].map((m) => m[1]);

/**
 * The kit version among `entries` (a kit changelog's, changelogBetween's) whose entry names a fix for `e`: a line starting
 * "**Fix for " or "**Fixes for ", then agents by name or id, comma-separated (or "and"), up to a colon or the bold's
 * end. Null for none. Pure.
 */
export function fixFor(entries: string, e: Pick<Employee, 'id' | 'name'>): string | null {
  const names = new Set([e.id.toLowerCase(), e.name.toLowerCase()]);
  for (const section of entries.split(/^(?=## )/m)) {
    const v = versionsIn(section)[0];
    if (!v) continue;
    for (const m of section.matchAll(/^\*\*(?:an? )?(?:urgent )?fix(?:es)? for ([^:*\n]+)/gim)) {
      if (m[1].split(/,|\band\b/i).some((n) => names.has(n.trim().replace(/['’]s$/, '').toLowerCase()))) return v;
    }
  }
  return null;
}

/** What an agent's own code may run or read: text a release carries (code, scripts, lists, pages). */
const TEXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|ps1|psm1|cmd|bat|html|css|xml)$/i;
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/**
 * One of the agent's own files a release carries and runs: under src\ but its kit, not a test. Not package.json: its
 * scripts are its maintainer's (a test run, a release), not what an install runs. Pure.
 */
export const ownStart = (f: string): boolean =>
  f.startsWith('src/') && !f.startsWith('src/kit/') && TEXT.test(f) && !/(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?[jt]sx?$/i.test(f);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The files an agent runs, from `starts` (its own, ownStart) over `known` (its own files and its kit's, where they land):
 * each code file's imports, the kit files its text names (a script it starts, a list or page it reads: `npu-server.ts`,
 * `npu-vendors.json`), and every file in a folder of its own it reads (`new URL('./web/', import.meta.url)`), followed
 * through every code file reached. `read` gives many files' texts at once. Pure but for `read`.
 */
export async function runsReached(starts: string[], known: Set<string>, read: (files: string[]) => Promise<Map<string, string>>): Promise<Set<string>> {
  const named = new Map<string, { re: RegExp; paths: string[] }>();
  for (const f of known) {
    if (!f.startsWith('src/kit/')) continue;
    const name = path.posix.basename(f);
    const n = named.get(name) ?? { re: new RegExp(`(^|[^\\w.-])${escapeRe(name)}(?![\\w-])`), paths: [] };
    n.paths.push(f);
    named.set(name, n);
  }
  const reached = new Set<string>(starts);
  let level = [...starts];
  while (level.length) {
    const texts = await read(level.filter((f) => TEXT.test(f)));
    const next: string[] = [];
    const add = (f: string) => {
      if (reached.has(f)) return;
      reached.add(f);
      if (CODE.test(f)) next.push(f);
    };
    for (const [f, text] of texts) {
      if (CODE.test(f)) for (const s of specifiersOf(text)) {
        const g = resolveSpecifier(f, s, known);
        if (g) add(g);
      }
      for (const [name, n] of named) if (text.includes(name) && n.re.test(text)) for (const p of n.paths) add(p);
      if (CODE.test(f)) for (const m of text.matchAll(FOLDER)) {
        const folder = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2])).replace(/\/+$/, '');
        if (folder === '.' || folder.startsWith('..')) continue;
        for (const k of known) if (k.startsWith(`${folder}/`)) add(k);
      }
    }
    level = next;
  }
  return reached;
}

/** The kit files that differ between two kit trees, at the paths they land in an agent taking `parts`; deletions left out. */
async function kitChanges(ctx: Ctx, clone: string, from: string, to: string, parts: string[]): Promise<string[] | null> {
  const names = await gitMaybe(ctx.run, clone, 'diff', '--name-status', '--no-renames', from, to);
  if (names === null) return null;
  const out: string[] = [];
  for (const line of names.split('\n')) {
    const [status, file] = line.trim().split('\t');
    const at = status && file && !status.startsWith('D') ? landsAt(file, parts) : null;
    if (at) out.push(at);
  }
  return out;
}

/** What `analyse` found for an agent's version: kept a process, as the next round asks again. */
type Found = { kitOnly: false } | { kitOnly: true; from: string; to: string; urgent: string | null; fix: string | null; changed: string[] | null; runs: string[] | null };
const found = new Map<string, Promise<Found>>();

async function analyse(ctx: Ctx, e: Employee, o: { repo: string; commit: string; since: string }): Promise<Found> {
  const { run } = ctx;
  const not: Found = { kitOnly: false };
  const tag = `refs/tags/v${o.since}`;
  if (!(await commitOf(run, o.repo, tag))) await gitMaybe(run, o.repo, 'fetch', '--quiet', 'origin', `+${tag}:${tag}`);
  const base = await commitOf(run, o.repo, tag);
  if (!base) return not;
  const names = await gitMaybe(run, o.repo, 'diff', '--name-only', '--no-renames', base, o.commit);
  if (names === null) return not;
  const changed = names.split('\n').map((l) => l.trim()).filter(Boolean);
  const patches = new Map<string, string | null>();
  for (const f of changed) if (!BUMPED.has(f) || f === 'kit.json') patches.set(f, await gitMaybe(run, o.repo, 'diff', base, o.commit, '--', f));
  if (!bumpAlone(changed, e.versionFiles, (f) => patches.get(f) ?? null)) return not;
  const [was, now] = [readPin(await showFile(run, o.repo, base, 'kit.json')), readPin(await showFile(run, o.repo, o.commit, 'kit.json'))];
  if (!was || !now) return not;
  const clone = stewardClone(ctx);
  const [fromTree, toTree] = clone ? await Promise.all([releasedTree(ctx, was.kit), releasedTree(ctx, now.kit)]) : [null, null];
  const changelog = clone && toTree ? await showFile(run, clone, `refs/tags/kit-v${now.kit}`, 'kit/CHANGELOG.md') : null;
  const entries = changelog ? changelogBetween(changelog, was.kit, now.kit) : '';
  const urgent = versionsIn(entries).find((v) => urgentIn(changelog, v)) ?? null;
  const fix = fixFor(entries, e);
  const kitOnly = { kitOnly: true as const, from: was.kit, to: now.kit, urgent, fix };
  if (urgent || fix || !clone || !fromTree || !toTree) return { ...kitOnly, changed: null, runs: null };
  const parts = partsTaken(now.parts);
  const kitChanged = await kitChanges(ctx, clone, fromTree, toTree, parts);
  if (!kitChanged?.length) return { ...kitOnly, changed: kitChanged, runs: kitChanged && [] };
  // Its own files at the commit released, and the kit's where they land: what it runs, read from git.
  const own = await gitMaybe(run, o.repo, 'ls-tree', '-r', '--name-only', o.commit, '--', 'src');
  const kitFiles = await gitMaybe(run, clone, 'ls-tree', '-r', '--name-only', toTree);
  if (own === null || kitFiles === null) return { ...kitOnly, changed: kitChanged, runs: null };
  const landed = new Map<string, string>();
  for (const f of kitFiles.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = landsAt(f, parts);
    if (at) landed.set(at, f);
  }
  const ownFiles = own.split('\n').map((l) => l.trim()).filter((f) => f && !f.startsWith('src/kit/'));
  const known = new Set([...ownFiles, ...landed.keys()]);
  const read = async (files: string[]) => {
    const texts = await Promise.all(files.map((f) => (landed.has(f) ? showFile(run, clone, toTree, landed.get(f)!) : showFile(run, o.repo, o.commit, f))));
    return new Map(files.flatMap((f, i): [string, string][] => (texts[i] === null ? [] : [[f, texts[i]!]])));
  };
  const reached = await runsReached(ownFiles.filter(ownStart), known, read);
  return { ...kitOnly, changed: kitChanged, runs: kitChanged.filter((f) => reached.has(f)) };
}

/** "16:05", this PC's time. Pure. */
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Whether two times fall on the same day, this PC's. Pure. */
export const sameDay = (a: string | number, b: string | number) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * Whether `e`'s version at `commit`, its last release `since`, is a kit alone, and if so whether it is released now and
 * why. Never throws: what can't be read is released as before.
 */
export async function kitOnlyRelease(ctx: Ctx, e: Employee, o: { repo: string; commit: string; version: string; since: string | null; now?: number }): Promise<KitOnly> {
  if (!o.since) return { kitOnly: false };
  const key = `${e.id}@${o.commit}@${o.since}`;
  let f = found.get(key);
  if (!f) found.set(key, (f = analyse(ctx, e, { repo: o.repo, commit: o.commit, since: o.since }).catch((): Found => ({ kitOnly: false }))));
  const a = await f;
  if (!a.kitOnly) return a;
  const kits = a.from === a.to ? `kit ${a.to}` : `kit ${a.from} → ${a.to}`;
  if (a.urgent) return { kitOnly: true, release: true, why: `a new kit alone, released: kit ${a.urgent}'s entry says it is urgent`, daily: false };
  if (a.fix) return { kitOnly: true, release: true, why: `a new kit alone, released: kit ${a.fix}'s entry names a fix for ${e.name}`, daily: false };
  if (a.runs === null) return { kitOnly: true, release: true, why: `a new kit alone (${kits}), released: what the kit changes couldn't be read`, daily: true };
  const rides = `it goes out with ${e.name}'s next release of its own`;
  if (!a.runs.length) {
    const what = a.changed?.length ? `none of the ${a.changed.length} kit file${a.changed.length === 1 ? '' : 's'} it takes that change ${a.changed.length === 1 ? 'is' : 'are'} one it runs` : 'nothing it takes from the kit changes';
    return { kitOnly: true, release: false, why: `waits: a new kit alone (${kits}), and ${what}: ${rides}` };
  }
  const runs = `${a.runs.slice(0, 3).join(', ')}${a.runs.length > 3 ? ` and ${a.runs.length - 3} more` : ''}`;
  const last = readJson<KitOnlyReleases>(kitOnlyReleasesFile(), {})[e.id];
  if (last && last.version !== o.version && sameDay(last.at, o.now ?? Date.now())) {
    return { kitOnly: true, release: false, why: `waits: a new kit alone (${kits}) that changes what it runs (${runs}), but its kit-only release for today went at ${clock(last.at)} (v${last.version}): it goes with the first build tomorrow, or sooner with a release of its own` };
  }
  return { kitOnly: true, release: true, why: `a new kit alone (${kits}), released: it changes what ${e.name} runs (${runs})`, daily: true };
}

/** An agent's release for a kit alone, made now: the day's one (kitOnlyRelease). */
export function noteKitOnlyRelease(id: string, version: string, now = Date.now()): void {
  const all = readJson<KitOnlyReleases>(kitOnlyReleasesFile(), {});
  all[id] = { version, at: new Date(now).toISOString() };
  writeJson(kitOnlyReleasesFile(), all);
}
