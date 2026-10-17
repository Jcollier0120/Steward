import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aheadOf, fetchBranch, fetchFor, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { compareVersions, KIT_VERSION, pinText } from '../kitfiles.ts';
import { readPin } from './staff.ts';
import type { Employee, Settings } from '../settings.ts';
import { agreedVersion, bumpPatch, readVersion, setVersion } from '../versions.ts';
import { runChecks } from './bump.ts';
import { bumpDirOf, checkoutOf, freshWorktree, workRootOf, type Ctx } from './common.ts';
import type { PrInfo } from './staff.ts';
import { recordTested } from '../tested.ts';
import { carryVouched } from './prtest.ts';
import { isKitChangelog, isKitVersionFile, KIT_CHANGELOG, KIT_VERSION_FILE, kitVersionText, renameKitInTopEntry, repinKit } from './kitpart.ts';
import { hostFor } from '../hosts/index.ts';

/**
 * Catching a team PR up, so it doesn't wait on its branch moving under it: the Steward merges the branch into it
 * (a merge commit on top: nothing of the PR's is rewritten) and, where its version is no longer new, gives it the
 * next free one. It pushes that to the PR's branch, says so on the PR, and the next round tests it at its new head
 * and merges it as any team PR.
 *
 * Only what needs no judgement: a conflict is resolved only in a version file (package-lock.json beside a package.json
 * among them too: npm keeps its version lines with package.json's), and only where one side changed nothing but
 * versions (diff3's common ancestor says which); in the changelog, where the PR added one entry at its top and each
 * older entry changed on one side at most (mergeChangelogs); or in kit.json, where the newer kit of the two is pinned
 * with every part either takes, and nothing else in it changed on both sides (mergeKitPins). Any other conflict is
 * left untouched, and goes back to the PR's author (kickback.ts).
 * In the Steward's own repository the kit is a second version (stages/kitpart.ts): kit/VERSION and kit/CHANGELOG.md are
 * settled by the same rules, against the kit's releases and the kit versions other PRs and claims hold, and the PR's own
 * changelog entry, its kit.json pin of its own kit and its title follow the kit's new version. A kit version it shares
 * with the open PR that sets it (one is stacked on the other: the same commit raises the kit in both) isn't another
 * PR's to it: it keeps it, and claims nothing.
 * Only the team's PRs from the repository itself (never a fork's, never a draft), and the Steward's own kit PRs
 * (steward/kit-…).
 *
 * A team PR vouched for at its head, or whose checks passed here there, keeps that standing through a catch-up that
 * resolved nothing but version lines and changelogs (keepsStanding): its new head merges without its checks run again,
 * the same trust a PR only behind its branch already gets. Before this, every merge cost each other open PR a catch-up
 * and a full test run, since two PRs side by side always meet in the version lines.
 *
 * A kit PR of the Steward's is caught up by the same rules, and, since no one else tests it, its checks run (its kit
 * filled again, then the employee's tests, as its bump ran them) before it is pushed. A kit PR that conflicts beyond
 * its version files isn't left waiting for a person: the Steward closes it and deletes its branch, and the next round's
 * rollout bumps the employee again, from its branch's head as it is then. So does one whose branch already pins its
 * kit or a newer one: another PR got there first, and it has nothing left to do.
 */

/** One of the Steward's own kit PRs (a bump's), which it catches up as the team's. */
export const isKitPr = (pr: PrInfo) => pr.whose === 'steward' && pr.head.startsWith('steward/kit-');

export const catchUpDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-catchup`);

const VERSION = /\d+\.\d+\.\d+/g;
/** Whether two runs of lines are the same but for the versions in them. Pure. */
export const sameButVersions = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l.replace(VERSION, 'x.y.z').trimEnd() === b[i].replace(VERSION, 'x.y.z').trimEnd());

/**
 * A file's text with each conflict (diff3 markers) resolved where one side differs from their common ancestor only
 * in versions: that side gives way to the other, whose versions are set right afterwards. Null when a conflict
 * changes more than versions on both sides, or has no ancestor to tell by.
 */
export function resolveVersionConflicts(text: string): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) {
      out.push(lines[i]);
      continue;
    }
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let part: string[] | null = ours;
    let j = i + 1;
    let ancestor = false;
    for (; j < lines.length && !lines[j].startsWith('>>>>>>>'); j++) {
      if (lines[j].startsWith('|||||||')) (part = base), (ancestor = true);
      else if (lines[j] === '=======') part = theirs;
      else part.push(lines[j]);
    }
    if (j >= lines.length || !ancestor) return null;
    if (sameButVersions(ours, base)) out.push(...theirs);
    else if (sameButVersions(theirs, base) || sameButVersions(ours, theirs)) out.push(...ours);
    else return null;
    i = j;
  }
  return out.join(eol);
}

/** Whether a conflicted path is the employee's kit pin (kit.json at its root). */
export const isKitPin = (f: string) => f.replace(/\\/g, '/').toLowerCase() === 'kit.json';

/**
 * kit.json from its three sides (ancestor, the PR's, the branch's): the newer kit of the two, and every part either
 * side takes (the PR's order, then the branch's others), since an agent's code needs each part it was written with.
 * Null when anything else in it changed on both sides, or a side can't be read: that needs a person. Pure.
 */
export function mergeKitPins(base: string, ours: string, theirs: string): string | null {
  const parse = (t: string) => {
    try {
      const j = JSON.parse(t.replace(/^﻿/, ''));
      return j && typeof j === 'object' && !Array.isArray(j) && typeof j.kit === 'string' && KIT_VERSION.test(j.kit) ? (j as Record<string, unknown> & { kit: string }) : null;
    } catch {
      return null;
    }
  };
  const [b, o, t] = [parse(base) ?? {}, parse(ours), parse(theirs)];
  if (!o || !t) return null;
  const rest = (j: Record<string, unknown>) => Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'kit' && k !== 'parts'));
  const [rb, ro, rt] = [rest(b), rest(o), rest(t)];
  for (const k of new Set([...Object.keys(ro), ...Object.keys(rt)])) {
    const [vb, vo, vt] = [JSON.stringify(rb[k]), JSON.stringify(ro[k]), JSON.stringify(rt[k])];
    if (vo !== vt && vo !== vb && vt !== vb) return null;
  }
  const merged: Record<string, unknown> = { ...ro };
  for (const k of Object.keys(rt)) if (JSON.stringify(rt[k]) !== JSON.stringify(rb[k])) merged[k] = rt[k];
  for (const k of Object.keys(rb)) if (!(k in ro) || !(k in rt)) delete merged[k];
  const parts = [...new Set([...(Array.isArray(o.parts) ? o.parts : []), ...(Array.isArray(t.parts) ? t.parts : [])].map(String))];
  return pinText({ ...merged, kit: compareVersions(o.kit, t.kit) >= 0 ? o.kit : t.kit, ...(parts.length ? { parts } : {}) });
}

/** Whether a conflicted path is the repository's own changelog (CHANGELOG.md at its root), whose sections are its versions. */
export const isChangelog = (f: string) => f.replace(/\\/g, '/').toLowerCase() === 'changelog.md';

/** A changelog cut at its `## ` headings: what comes before the first, and each section from its heading on. */
function sectionsOf(text: string): { head: string; parts: string[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.map((l, i) => (l.startsWith('## ') ? i : -1)).filter((i) => i >= 0);
  if (!at.length) return { head: lines.join('\n'), parts: [] };
  return { head: lines.slice(0, at[0]).join('\n'), parts: at.map((a, k) => lines.slice(a, at[k + 1] ?? lines.length).join('\n')) };
}

const sameSection = (a: string, b: string) => a.trimEnd() === b.trimEnd();
/** A section that ends with a blank line, so the next heading stands apart. */
const spaced = (s: string) => `${s.trimEnd()}\n`;

/**
 * The changelog both sides added a new top entry to, as two PRs written side by side do: the branch's new entries
 * kept, the PR's entry put above them under `to` (its version once caught up), and each older entry as the side that
 * changed it left it (a spelling swept through the old notes, say). An entry under `## Unreleased` (written before its
 * version was claimed) is released with the next version above it: the PR's own goes above the branch's new entries as
 * it is, and the branch's new ones are folded into the PR's versioned entry (foldUnreleased), as kit 2.74.5 and 2.76.0
 * folded theirs by hand. Null when it needs judgement: the text above the entries, or an older entry, changed
 * differently on both sides; an older entry gone or its heading changed; or the PR added more than one entry, or one
 * whose heading names no version and isn't Unreleased.
 */
export function mergeChangelogs(base: string, ours: string, theirs: string, to: string): string | null {
  const eol = theirs.includes('\r\n') ? '\r\n' : '\n';
  const [b, o, t] = [sectionsOf(base), sectionsOf(ours), sectionsOf(theirs)];
  if (o.head !== b.head && t.head !== b.head && o.head !== t.head) return null;
  const head = o.head === b.head ? t.head : o.head;
  const n = b.parts.length;
  // The older entries, the ancestor's, at the bottom of each side under the same headings: none gone, none moved.
  const heading = (p: string) => p.split('\n', 1)[0].trimEnd();
  const olderOf = (x: { parts: string[] }) => (x.parts.length >= n ? x.parts.slice(x.parts.length - n) : null);
  const [oOld, tOld] = [olderOf(o), olderOf(t)];
  if (!oOld || !tOld || ![oOld, tOld].every((x) => x.every((p, i) => heading(p) === heading(b.parts[i])))) return null;
  const older: string[] = [];
  for (let i = 0; i < n; i++) {
    if (sameSection(oOld[i], b.parts[i])) older.push(tOld[i]);
    else if (sameSection(tOld[i], b.parts[i]) || sameSection(oOld[i], tOld[i])) older.push(oOld[i]);
    else return null;
  }
  const mine = o.parts.slice(0, o.parts.length - n);
  const theirsNew = t.parts.slice(0, t.parts.length - n);
  if (mine.length > 1) return null;
  const renamed = mine.map((p) => {
    const [heading, ...rest] = p.split('\n');
    if (isUnreleased(p)) return p;
    return VERSION_IN.test(heading) ? [heading.replace(VERSION_IN, to), ...rest].join('\n') : null;
  });
  if (renamed.includes(null)) return null;
  // The branch's new Unreleased entries above its newest version, below the PR's once it is above them: released with
  // it, so in its entry. One below a version the branch has since released went out with that one, and stays.
  const released = theirsNew.findIndex((p) => !isUnreleased(p));
  const waiting = renamed.length && !isUnreleased(renamed[0]!) ? theirsNew.slice(0, released < 0 ? theirsNew.length : released) : [];
  const moved = waiting.length ? [foldUnreleased(renamed[0]!, waiting), ...theirsNew.slice(waiting.length)] : [...(renamed as string[]), ...theirsNew];
  // Each section is its lines, joined again with the line breaks between them; one moved above another ends with a blank line.
  const parts = [...moved.map((p, i) => (i < moved.length - 1 || n ? spaced(p) : p)), ...older];
  const text = (head === '' && parts.length ? parts : [head, ...parts]).join('\n');
  return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
}

const VERSION_IN = /\d+\.\d+\.\d+/;

/** Whether a changelog's section is an entry under `## Unreleased` (`## Unreleased (its version needs claiming …)` too). */
export const isUnreleased = (section: string) => /^## +Unreleased\b/i.test(section);

/** An entry cut up: its `## ` heading, its bold headline, the words before its first `### `, and each `### ` section. */
function entryParts(section: string): { heading: string; headline: string | null; intro: string; subs: { heading: string; body: string }[] } {
  const lines = section.replace(/\r\n/g, '\n').split('\n');
  const at = lines.map((l, i) => (i && l.startsWith('### ') ? i : -1)).filter((i) => i >= 0);
  const before = lines.slice(1, at[0] ?? lines.length).join('\n').trim();
  const bold = /^\*\*(.+?)\*\*/s.exec(before);
  return {
    heading: lines[0],
    headline: bold ? bold[1].replace(/\s+/g, ' ').trim() : null,
    intro: (bold ? before.slice(bold[0].length) : before).trim(),
    subs: at.map((a, k) => ({ heading: lines[a].slice(4).trim(), body: lines.slice(a + 1, at[k + 1] ?? lines.length).join('\n').trim() })),
  };
}

/** Where a `### ` section stands in an entry: What's new, What changed, any other, then what to do (Before you update, For an agent). */
const subRank = (h: string) => (/^what'?s new$/i.test(h) ? 0 : /^what changed$/i.test(h) ? 1 : /^(before you update|for an agent)$/i.test(h) ? 3 : 2);

/** What-to-do lines that say only that there is nothing to do: given way to any that say more. */
const NOTHING_ONLY = /^(?:- )?Nothing(?: to do)?(?:: it updates itself as usual)?\.?$/i;

/**
 * A versioned entry with Unreleased ones folded in (newest first, as the changelog has them), for a release that brings
 * them: its headline goes on to say "It also brings what wasn't released before: …" with theirs; each `### ` section's
 * lines go under the entry's section of the same name (a new one in its place: What's new, What changed, then what to
 * do), a line already there once, and "Nothing to do" given way to what says more. Pure.
 */
export function foldUnreleased(entry: string, unreleased: string[]): string {
  const into = entryParts(entry);
  const folded = unreleased.map(entryParts);
  const theirs = folded.map((f) => f.headline).filter((h): h is string => !!h);
  const brings = theirs.length ? `It also brings what wasn't released before: ${theirs.join(' ')}` : '';
  const headline = into.headline ? `**${into.headline}${brings ? `${/[.!?]$/.test(into.headline) ? '' : '.'} ${brings}` : ''}**` : '';
  const intro = [headline, into.intro, ...(into.headline || !brings ? [] : [brings]), ...folded.map((f) => f.intro)].filter(Boolean);
  const subs = into.subs.map((s) => ({ ...s, lines: s.body.split('\n') }));
  for (const s of folded.flatMap((f) => f.subs)) {
    const same = subs.find((x) => x.heading.toLowerCase() === s.heading.toLowerCase());
    const add = s.body.split('\n');
    if (!same) {
      const at = subs.findIndex((x) => subRank(x.heading) > subRank(s.heading));
      subs.splice(at < 0 ? subs.length : at, 0, { ...s, lines: add });
      continue;
    }
    const said = (ls: string[]) => ls.filter((l) => l.trim() && !NOTHING_ONLY.test(l.trim()));
    if (subRank(same.heading) === 3 && !said(add).length) continue;
    if (subRank(same.heading) === 3 && !said(same.lines).length) same.lines = [];
    const fresh = add.filter((l) => !l.trim() || !same.lines.some((m) => m.trim() === l.trim()));
    // Lists run on as one list; anything else stands apart.
    const list = (l: string | undefined) => !!l && /^\s*[-*] /.test(l);
    same.lines = same.lines.length ? [...same.lines, ...(list(same.lines.at(-1)) && list(fresh.find((l) => l.trim())) ? [] : ['']), ...fresh] : fresh;
  }
  return [into.heading, '', ...intro.flatMap((p) => [p, '']), ...subs.flatMap((s) => [`### ${s.heading}`, '', ...s.lines.join('\n').trim().split('\n'), ''])].join('\n');
}

/** The changelog's top section renamed from `from` to `to`, when it is the one that names `from`; null when it isn't. */
export function renumberChangelog(text: string, from: string, to: string): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('## '));
  if (i < 0 || lines[i].match(VERSION_IN)?.[0] !== from) return null;
  lines[i] = lines[i].replace(VERSION_IN, to);
  return lines.join(eol);
}

/** The next version above `from` that is neither released nor another PR's. */
function nextFree(from: string, taken: Set<string>): string {
  let v = bumpPatch(from);
  while (taken.has(v)) v = bumpPatch(v);
  return v;
}

/**
 * The version a PR caught up with its branch carries, and why when it isn't the PR's own: one it set stays while it is
 * still new (above the branch's, not released, no other PR's); else the next free one above the branch's. One that
 * left the version alone keeps the branch's, unless it asks for a release of a version already released. `own`: the
 * version it was moved to, past the others in its version queue (move-past.ts), which it carries while that is still new.
 */
export function catchUpVersion(o: { head: string; from: string | null; base: string; released: string[]; taken: string[]; asksRelease: boolean; own?: string | null }): { version: string; why: string | null } {
  const taken = new Set([...o.released, ...o.taken]);
  if (o.own && compareVersions(o.own, o.head) > 0 && compareVersions(o.own, o.base) > 0 && !taken.has(o.own)) return { version: o.own, why: `it was moved past the others to v${o.own}` };
  const sets = o.head !== (o.from ?? o.base);
  if (sets) {
    if (o.released.includes(o.head)) return { version: nextFree(o.base, taken), why: `v${o.head} is already released` };
    if (compareVersions(o.head, o.base) <= 0) return { version: nextFree(o.base, taken), why: `the branch is at v${o.base} already` };
    if (o.taken.includes(o.head)) return { version: nextFree(o.base, taken), why: `another PR sets v${o.head}` };
    return { version: o.head, why: null };
  }
  if (o.asksRelease && o.released.includes(o.base)) return { version: nextFree(o.base, taken), why: `it asks for a release, and v${o.base} is already released` };
  return { version: o.base, why: null };
}

/** An open PR, or a claim, that sets a kit version: its branch on origin, and its head when it is a PR's. */
export interface KitSetter {
  version: string;
  branch: string;
  head?: string;
}

export interface CaughtUp {
  done: boolean;
  /** A kit PR of the Steward's it closed, since it conflicted beyond its versions: the next round bumps again. */
  closed?: boolean;
  /** What it did ("merged main into it; v0.4.12, since v0.4.11 is already released"), or why it couldn't. */
  note: string;
  /** The files it conflicts in that need judgement, when that's why it wasn't caught up: they go back to its author (kickback.ts). */
  conflicts?: string[];
  /** Every file merging the branch into it conflicted in, the ones it resolved too: none when it was only behind. */
  conflicted?: string[];
  version?: string;
  /** The kit's version it carries, in the Steward's own repository (stages/kitpart.ts). */
  kitVersion?: string;
  /** The head it pushed. */
  head?: string;
  /** Its standing from before (`carry`) was carried to that head, so it merges without being tested again (keepsStanding). */
  carried?: boolean;
}

/** npm's lockfile, which carries package.json's version twice (its own, and its root package's). */
const LOCKFILE = 'package-lock.json';
const named = (files: string[], f: string) => files.some((x) => x.replace(/\\/g, '/').toLowerCase() === f);

/** package-lock.json, when an employee's version files name package.json but not it: npm keeps it in step all the same. */
export const lockBeside = (files: string[]) => (named(files, 'package.json') && !named(files, LOCKFILE) ? [LOCKFILE] : []);

/**
 * Whether a catch-up that conflicted in `conflicted` keeps the PR's standing (prtest.ts carryTested): every file it
 * resolved is a version file (the lock beside them too), the changelog, or, where the repository carries the kit
 * (`kit`), kit/VERSION and the kit's changelog. Such a catch-up writes nothing of its own but versions and entries, so
 * what passed at the PR's head before still says what its code does. kit.json, or any other file, doesn't: a different
 * kit is different code. One with no conflict at all (only behind, or given a new version) keeps it too. Pure.
 */
export function keepsStanding(conflicted: string[], versionFiles: string[], kit: boolean): boolean {
  const versions = new Set([...versionFiles, ...lockBeside(versionFiles)].map((f) => f.replace(/\\/g, '/').toLowerCase()));
  return conflicted.every((f) => versions.has(f.replace(/\\/g, '/').toLowerCase()) || isChangelog(f) || (kit && (isKitVersionFile(f) || isKitChangelog(f))));
}

/**
 * The files a catch-up settles the version in: the employee's version files, and package-lock.json beside them
 * (lockBeside) when it says, in both its places, the version package.json does in `dir`. A lock left at another
 * version by hand stays as it is.
 */
export function settledFiles(dir: string, files: string[]): string[] {
  const lock = lockBeside(files);
  if (!lock.length || !existsSync(path.join(dir, LOCKFILE)) || !existsSync(path.join(dir, 'package.json'))) return files;
  try {
    const own = readVersion('package.json', readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const j = JSON.parse(readFileSync(path.join(dir, LOCKFILE), 'utf8').replace(/^﻿/, ''));
    return own && j.version === own && j.packages?.['']?.version === own ? [...files, ...lock] : files;
  } catch {
    return files;
  }
}

/** Each version file in a folder set to `version` where it says otherwise; the files changed. */
export function settleVersion(dir: string, files: string[], version: string): string[] {
  const changed: string[] = [];
  for (const f of files) {
    const p = path.join(dir, f);
    if (!existsSync(p)) throw new Error(`${f} is missing`);
    const text = readFileSync(p, 'utf8');
    const now = readVersion(f, text);
    if (!now) throw new Error(`${f} has no version the Steward can read`);
    if (now === version) continue;
    writeFileSync(p, setVersion(f, text, now, version));
    changed.push(f);
  }
  return changed;
}

/**
 * A kit PR of the Steward's that conflicts with its branch beyond its versions: closed, with a comment, its branch
 * deleted (a bump refuses while it is on origin) and the Steward's worktree for it removed. The next round's rollout
 * sees the employee still behind the kit, with no kit PR open, and bumps it again from its branch's head.
 */
async function closeKitPr(ctx: Ctx, e: Employee, pr: PrInfo, repo: string, why: string, o: { redundant?: boolean } = {}): Promise<CaughtUp> {
  const note = `${why}, so the Steward closed it: the next round bumps ${e.name} again from ${e.branch}`;
  const body = o.redundant
    ? `Closed by the Steward: ${why}, so this bump has nothing left to do. The next round bumps ${e.name} to the newest kit from ${e.branch} as it is then.`
    : `Closed by the Steward: ${why}, which it doesn't resolve. The next round bumps ${e.name} to the kit again, from ${e.branch} as it is then.`;
  const r = await hostFor(ctx, e).closePr(e.repo, pr.number, { deleteBranch: true, comment: body });
  if (r.code !== 0) return { done: false, note: `${why}, and the Steward couldn't close it: ${(r.err || r.out).trim().split('\n').pop()}` };
  try {
    for (const line of await removeWorktree(ctx.run, repo, bumpDirOf(ctx.settings, e), pr.head)) ctx.log(`[${e.id}] ${line}`);
  } catch (err) {
    ctx.log(`[${e.id}] couldn't remove the bump's worktree for #${pr.number}: ${(err as Error).message}`);
  }
  ctx.log(`[${e.id}] #${pr.number}: ${note}`);
  return { done: false, closed: true, note };
}

/**
 * One team PR (or kit PR of the Steward's) caught up with its branch, as the module's comment says: `released` are the employee's released
 * versions, `taken` the versions other open PRs set (which keep theirs). `carry`: what passed at its head before ("checks
 * passed here at abc1234", or its vouch), carried to the head it pushes where the catch-up touched only versions and
 * changelogs (keepsStanding), so it isn't tested again. `own`: the version it was moved to (catchUpVersion). `kit.setters`:
 * who sets the kit versions `kit.taken` names, so one this PR shares with its setter is kept.
 */
export async function catchUp(ctx: Ctx, e: Employee, pr: PrInfo, o: { released: string[]; taken: string[]; kit?: { released: string[]; taken: string[]; setters?: KitSetter[] }; carry?: string | null; own?: string | null }): Promise<CaughtUp> {
  const { run } = ctx;
  const kitPr = isKitPr(pr);
  if ((pr.whose !== 'team' && !kitPr) || pr.fork || pr.draft) return { done: false, note: "only a ready team PR from the repository itself, or a kit PR of the Steward's, is caught up" };
  if (pr.base !== e.branch) return { done: false, note: `it merges into ${pr.base}, not ${e.branch}` };
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return { done: false, note: `there's no checkout at ${repo}` };
  await fetchBranch(run, repo, e.branch);
  await fetchBranch(run, repo, pr.head);
  const head = `origin/${pr.head}`;
  const branch = `origin/${e.branch}`;
  // Pushed to since it was listed: the next round sees it as it is now.
  if (pr.headOid && (await git(run, repo, 'rev-parse', head)) !== pr.headOid) return { done: false, note: 'its branch moved since this round listed it' };
  const read = async (ref: string) => {
    const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, ref, f)] as [string, string | null])));
    return 'version' in v ? v.version : null;
  };
  // A kit PR whose branch already pins that kit or a newer one (another PR took it there first) has nothing left to do.
  // Its kit is its branch's name's (steward/kit-<version>), or the one its head pins when that is newer: the rollout
  // folded a newer kit onto it.
  const byName = kitPr ? /^steward\/kit-(\d+\.\d+\.\d+)$/.exec(pr.head)?.[1] : undefined;
  const pinned = byName ? readPin(await showFile(run, repo, head, 'kit.json'))?.kit : undefined;
  const brings = byName && pinned && KIT_VERSION.test(pinned) && compareVersions(pinned, byName) > 0 ? pinned : byName;
  if (brings) {
    const theirs = readPin(await showFile(run, repo, branch, 'kit.json'));
    if (theirs && KIT_VERSION.test(theirs.kit) && compareVersions(theirs.kit, brings) >= 0) return await closeKitPr(ctx, e, pr, repo, `${e.branch} already carries kit ${theirs.kit}`, { redundant: true });
  }
  const start = (await gitMaybe(run, repo, 'merge-base', branch, head))?.trim();
  // The three asked at once, the kit's with them, so git reads them in one command (showFile).
  const kitAt = async (ref: string) => (/^\s*(\d+\.\d+\.\d+)\s*$/.exec((await showFile(run, repo, ref, KIT_VERSION_FILE)) ?? '')?.[1] ?? null);
  const [headV, fromV, baseV, kHead, kBase, kStart] = await Promise.all([read(head), start ? read(start) : null, read(branch), kitAt(head), kitAt(branch), start ? kitAt(start) : null]);
  if (!headV || !baseV) return { done: false, note: `its version can't be read (${e.versionFiles.join(', ')})` };
  const choice = catchUpVersion({ head: headV, from: fromV, base: baseV, released: o.released, taken: o.taken, asksRelease: !!pr.after?.steps.includes('release'), own: o.own });
  // A kit version another open PR sets that this one shares with it: the one commit raises the kit in both (this PR is
  // stacked on that one, or that one on this), so it is one claim, not two, and neither is given another. On 2026-10-16
  // a build renumbered the kit entries #299, #301 and #304 carried from #297 and #302 to 2.78.4, 2.78.5 and 2.78.6, which
  // then conflicted with main once #297 merged.
  let shared = false;
  for (const s of kHead && o.kit?.taken.includes(kHead) ? (o.kit.setters ?? []).filter((x) => x.version === kHead && x.branch !== pr.head) : []) {
    try {
      if (s.head) await fetchFor(run, repo, s.head, `refs/heads/${s.branch}`);
      else await fetchBranch(run, repo, s.branch);
    } catch {
      continue;
    }
    const both = (await gitMaybe(run, repo, 'merge-base', head, s.head ?? `origin/${s.branch}`))?.trim();
    if (both && (await kitAt(both)) === kHead) {
      shared = true;
      break;
    }
  }
  // The kit, where the repository carries one (the Steward's own): its version settled the same way.
  const kFrom = kHead ? kStart : null;
  const kTaken = (o.kit?.taken ?? []).filter((v) => !shared || v !== kHead);
  const kit = kHead && kBase ? catchUpVersion({ head: kHead, from: kFrom, base: kBase, released: o.kit?.released ?? [], taken: kTaken, asksRelease: false }) : null;
  // Kept as the other PR sets it: that PR's claim, not this one's.
  const ownKit = !!kit && kit.version !== kBase && !(shared && kit.version === kHead);
  const behind = await aheadOf(run, repo, branch, head);
  if (!behind && !choice.why && !kit?.why) return { done: false, note: 'nothing to catch up' };

  const dir = catchUpDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, head, '--detach');
  let conflictedFiles: string[] = [];
  // What it says once the merge has been tried: with the files it conflicted in, when it did.
  const said = (c: CaughtUp): CaughtUp => (conflictedFiles.length ? { ...c, conflicted: conflictedFiles } : c);
  try {
    const did: string[] = [];
    if (behind) {
      const m = await run('git', ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', '-m', `Merge ${e.branch} into ${pr.head}: caught up by the Steward`, branch], { cwd: dir, timeoutMs: 5 * 60_000 });
      if (m.code !== 0) {
        const conflicted = (await gitMaybe(run, dir, 'diff', '--name-only', '--diff-filter=U'))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
        conflictedFiles = conflicted;
        const versionFiles = new Set([...e.versionFiles, ...lockBeside(e.versionFiles)].map((f) => f.replace(/\\/g, '/').toLowerCase()));
        const others = conflicted.filter((f) => !versionFiles.has(f.toLowerCase()) && !isChangelog(f) && !isKitPin(f) && !(kit && (isKitVersionFile(f) || isKitChangelog(f))));
        const why = !conflicted.length
          ? `merging ${e.branch} into it failed: ${(m.err || m.out).trim().split('\n').pop()}`
          : others.length
            ? `it conflicts with ${e.branch} in ${others.join(', ')}: that needs a person`
            : null;
        let unresolved = why;
        let stuck: string[] = others;
        if (!unresolved) {
          for (const f of conflicted) {
            // The changelog, from its three sides: the PR's new entry above the branch's, under the version it ends up with.
            const side = async (n: number) => (await gitMaybe(run, dir, 'show', `:${n}:${f}`)) ?? '';
            // kit.json: the newer kit, and every part either side takes.
            const fixed = isChangelog(f)
              ? mergeChangelogs(await side(1), await side(2), await side(3), choice.version)
              : kit && isKitVersionFile(f)
                ? kitVersionText(kit.version, await side(3))
                : kit && isKitChangelog(f)
                  ? mergeChangelogs(await side(1), await side(2), await side(3), kit.version)
                  : isKitPin(f)
                ? mergeKitPins(await side(1), await side(2), await side(3))
                : resolveVersionConflicts(readFileSync(path.join(dir, f), 'utf8'));
            if (fixed === null) {
              unresolved = `it conflicts with ${e.branch} in ${f} beyond ${isChangelog(f) || isKitChangelog(f) ? 'a new entry at its top' : isKitPin(f) ? 'its kit and parts' : 'its version'}: that needs a person`;
              stuck = [f];
              break;
            }
            writeFileSync(path.join(dir, f), fixed);
          }
        }
        if (unresolved) {
          await gitMaybe(run, dir, 'merge', '--abort');
          if (kitPr && conflicted.length) return said({ ...(await closeKitPr(ctx, e, pr, repo, unresolved.replace(/: that needs a person$/, ''))), conflicts: stuck });
          return said({ done: false, note: unresolved, ...(conflicted.length ? { conflicts: stuck } : {}) });
        }
        // A lock resolved here had its version lines changed on both sides: it is kept in step, as npm keeps it.
        const lockToo = lockBeside(e.versionFiles).filter((f) => named(conflicted, f));
        settleVersion(dir, [...e.versionFiles, ...lockToo], choice.version);
        await git(run, dir, 'add', '--', ...conflicted, ...e.versionFiles);
        await git(run, dir, 'commit', '--quiet', '--no-edit');
        const what = ['version lines', ...(conflicted.some(isKitPin) ? ['kit pin'] : []), ...(conflicted.some(isChangelog) ? ['changelog'] : []), ...(conflicted.some(isKitVersionFile) ? ['kit version'] : []), ...(conflicted.some(isKitChangelog) ? ["kit's changelog"] : [])];
        did.push(`merged ${e.branch} into it, its ${what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]} resolved`);
      } else did.push(`merged ${e.branch} into it`);
    }
    const changed = settleVersion(dir, settledFiles(dir, e.versionFiles), choice.version);
    // A new version of its own: the changelog's entry the PR wrote under its old one says the new one too.
    const log = path.join(dir, 'CHANGELOG.md');
    if (choice.version !== headV && existsSync(log)) {
      const renamed = renumberChangelog(readFileSync(log, 'utf8'), headV, choice.version);
      if (renamed !== null && headV !== baseV) {
        writeFileSync(log, renamed);
        changed.push('CHANGELOG.md');
      }
    }
    // The kit's: kit/VERSION, its changelog's top entry, the Steward's pin of its own kit, and the Steward's entry that
    // names it, all at the kit's version once caught up.
    if (kit && kHead) {
      const at = (f: string) => path.join(dir, f);
      const was = readFileSync(at(KIT_VERSION_FILE), 'utf8');
      if (was.trim() !== kit.version) {
        writeFileSync(at(KIT_VERSION_FILE), kitVersionText(kit.version, was));
        changed.push(KIT_VERSION_FILE);
      }
      // The Steward pins its own kit: where the PR pinned the kit it raised, the pin follows the kit's version, whichever
      // pin a conflict in kit.json kept.
      if (readPin(await showFile(run, repo, head, 'kit.json'))?.kit === kHead && existsSync(at('kit.json'))) {
        const pin = repinKit(readFileSync(at('kit.json'), 'utf8'), kit.version);
        if (pin !== null) writeFileSync(at('kit.json'), pin), changed.push('kit.json');
      }
      if (kit.version !== kHead && kHead !== kBase) {
        const kLog = existsSync(at(KIT_CHANGELOG)) ? renumberChangelog(readFileSync(at(KIT_CHANGELOG), 'utf8'), kHead, kit.version) : null;
        if (kLog !== null) writeFileSync(at(KIT_CHANGELOG), kLog), changed.push(KIT_CHANGELOG);
        // Only the PR's own entry: the top one, under the version it carries now, which the branch's never is.
        const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
        const topIsOwn = choice.version !== baseV && /^## [^\n]*?(\d+\.\d+\.\d+)/m.exec(text)?.[1] === choice.version;
        const own = topIsOwn ? renameKitInTopEntry(text, kHead, kit.version) : null;
        if (own !== null) writeFileSync(log, own), changed.includes('CHANGELOG.md') || changed.push('CHANGELOG.md');
      }
    }
    if (changed.length) {
      await git(run, dir, 'add', '--', ...changed);
      const kitWords = kit && kit.version !== kHead ? `, kit ${kit.version}` : '';
      await git(run, dir, 'commit', '--quiet', '-m', `${e.name} ${choice.version}${kitWords}: a version of its own (${choice.why ?? kit?.why ?? `the branch's, after the merge`})`);
    }
    if (choice.why) did.push(`v${choice.version}, since ${choice.why}`);
    // Its reason in the kit's words: "kit 2.36.0", never "v2.36.0", which is a Steward's tag.
    if (kit?.why) did.push(`kit ${kit.version}, since ${kit.why.replace(/\bv(\d)/g, 'kit $1')}`);
    if (kitPr) {
      // No one tests the Steward's own PRs on their way in: its bump did, and so does its catch-up, here.
      const failed = await runChecks(ctx, e, dir, { say: (line) => ctx.log(`[${e.id}] #${pr.number}: ${line}`), doing: `#${pr.number}'s checks after its catch-up` });
      if (failed) return said({ done: false, note: `${did.join('; ')}, but then ${failed}, so it wasn't pushed` });
      did.push('its checks passed');
    }
    // Another PC's turn here now (lease.ts): it catches this PR up.
    if (ctx.lease && !(await ctx.lease.ok(e))) return said({ done: false, note: `${did.join('; ')}, but another PC publishes ${e.name} now, so it wasn't pushed` });
    await git(run, dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.head}`);
    const pushed = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
    // A kit PR's new head, whose checks passed here: the Surveyor's GET /api/tested (tested.ts).
    if (kitPr) recordTested(e.id, { commit: pushed, stage: 'catch-up', branch: pr.head, pr: pr.number, version: choice.version });
    // What passed at its head before still holds, where the catch-up wrote only versions and entries.
    const carried = !kitPr && !!o.carry && keepsStanding(conflictedFiles, e.versionFiles, !!kit);
    if (carried) {
      await carryVouched({ ...ctx, run }, e, pr, pushed, o.carry!);
      did.push(`its checks not run again (only version lines and the changelog changed since ${pr.headOid.slice(0, 7)})`);
    }
    const note = did.join('; ');
    ctx.log(`[${e.id}] #${pr.number}: caught up (${note})`);
    // Its title says its version, when it did; the comment says what changed, and that it merges once tested again.
    let title = choice.why && pr.title.includes(headV) ? pr.title.split(headV).join(choice.version) : pr.title;
    if (kit?.why && kHead) title = title.replace(new RegExp(`\\b(kit )${kHead.replace(/\./g, '\\.')}\\b`, 'i'), `$1${kit.version}`);
    const host = hostFor({ ...ctx, run }, e);
    if (title !== pr.title) await host.editPr(e.repo, pr.number, { title }).catch(() => null);
    const next = kitPr ? 'The next round merges it.' : carried ? 'It merges without being tested again.' : 'It merges once its checks pass at the new head.';
    await host.commentPr(e.repo, pr.number, `Caught up by the Steward: ${note}. ${next}`).catch(() => null);
    // A kit version only for a PR that raises the kit: one that leaves it alone carries the branch's, and claims nothing;
    // one that carries another PR's (shared) claims nothing either.
    return said({ done: true, note, version: choice.version, head: pushed, ...(carried ? { carried } : {}), ...(ownKit ? { kitVersion: kit!.version } : {}) });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
