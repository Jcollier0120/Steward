import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { titleVersions } from '../claims.ts';
import { changeVersion, CHANGES_DIR } from '../entries.ts';
import { aheadOf, fetchBranch, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { hostFor } from '../hosts/index.ts';
import type { Employee, Settings } from '../settings.ts';
import { agreedVersion, readVersion, setVersion } from '../versions.ts';
import { checkoutOf, freshWorktree, workRootOf, type Ctx } from './common.ts';
import type { PrInfo } from './staff.ts';

/**
 * Catching up a PR passed over in its version line (passover.ts), and giving it its new version (Steward 0.36.247). The
 * Steward merges its branch into it (a merge commit on top, so nothing of the PR's is rewritten). Then, where the PR's
 * work names its version, it sets the new one: in its version files, its changelog's top entry, its
 * changes/<version>.md and its title. It pushes that to the PR's branch.
 *
 * Only what needs no judgement, as the catch-ups before Steward 0.36.124 did (this is their code):
 * - a conflict is resolved only in a version file (package-lock.json beside a package.json among them too), and only
 *   where one side changed nothing but versions (diff3's common ancestor says which);
 * - in the changelog, a conflict is resolved where the PR added one entry at its top and each older entry changed on
 *   one side at most (mergeChangelogs).
 * Any other conflict is left untouched, for the PR's author. Only a team PR from the repository itself, never a draft.
 */

/** The Steward's worktree for catching up an employee's PR. */
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

/** npm's lockfile, which carries package.json's version twice (its own, and its root package's). */
const LOCKFILE = 'package-lock.json';
const named = (files: string[], f: string) => files.some((x) => x.replace(/\\/g, '/').toLowerCase() === f);

/** package-lock.json, when an employee's version files name package.json but not it: npm keeps it in step all the same. */
export const lockBeside = (files: string[]) => (named(files, 'package.json') && !named(files, LOCKFILE) ? [LOCKFILE] : []);


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

export interface Reversioned {
  /** Pushed, or there was nothing to do. */
  done: boolean;
  /** What it did ("merged main into it; v0.4.12, from v0.4.10"), or why it couldn't. */
  note: string;
  /** The head it pushed, when it pushed. */
  head?: string;
  /** The version the PR's work named before (its version files, its changes/ file or its title), if any. */
  from?: string | null;
  /** The files it conflicts in that need its author, when that's why it wasn't caught up. */
  conflicts?: string[];
}

const lastLine = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').pop() ?? '';

/**
 * One PR caught up with its branch and given version `to`, as the module's comment says. Its title follows the new
 * version. Says nothing on the PR: passover.ts does that, knowing why. `why` goes in the commit's message.
 */
export async function reversion(ctx: Ctx, e: Employee, pr: PrInfo, to: string, o: { why: string }): Promise<Reversioned> {
  const { run } = ctx;
  if (pr.whose !== 'team' || pr.fork || pr.draft) return { done: false, note: 'only a team PR from the repository itself, not a draft, is caught up' };
  if (pr.base !== e.branch) return { done: false, note: `it merges into ${pr.base}, not ${e.branch}` };
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return { done: false, note: `there's no checkout at ${repo}` };
  await fetchBranch(run, repo, e.branch);
  await fetchBranch(run, repo, pr.head);
  const head = `origin/${pr.head}`;
  const branch = `origin/${e.branch}`;
  // Pushed to since the staff's table listed it: the next round sees it as it is now.
  if (pr.headOid && (await git(run, repo, 'rev-parse', head)) !== pr.headOid) return { done: false, note: "its branch moved since the staff's table listed it" };
  const read = async (ref: string) => {
    const v = agreedVersion(await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, ref, f)] as [string, string | null])));
    return 'version' in v ? v.version : null;
  };
  const start = (await gitMaybe(run, repo, 'merge-base', branch, head))?.trim() || null;
  const [headV, fromV, mainV] = await Promise.all([read(head), start ? read(start) : null, read(branch)]);
  if (!mainV) return { done: false, note: `${e.branch}'s version can't be read (${e.versionFiles.join(', ')})` };
  // What of the PR's work names its version: its version files where it changed them, a changes/<version>.md it adds,
  // else its title.
  const sets = !!headV && headV !== fromV;
  const added = start ? ((await gitMaybe(run, repo, 'diff', '--name-only', '--diff-filter=A', start, head)) ?? '').split('\n').map((l) => l.trim()).filter((f) => changeVersion(f) !== null) : [];
  const own = sets ? headV : added.length ? changeVersion(added[0]) : (titleVersions(e.name, [pr.title])[0] ?? null);
  const behind = await aheadOf(run, repo, branch, head);
  if (!behind && (own === null || own === to)) return { done: true, note: `nothing to do: up to date with ${e.branch}${own ? `, at v${own}` : ''}`, from: own };

  const dir = catchUpDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, head, '--detach');
  try {
    const did: string[] = [];
    if (behind) {
      const m = await run('git', ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', '-m', `Merge ${e.branch} into ${pr.head}: caught up by the Steward`, branch], { cwd: dir, timeoutMs: 5 * 60_000 });
      if (m.code !== 0) {
        const conflicted = ((await gitMaybe(run, dir, 'diff', '--name-only', '--diff-filter=U')) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        const versionFiles = new Set([...e.versionFiles, ...lockBeside(e.versionFiles)].map((f) => f.replace(/\\/g, '/').toLowerCase()));
        const others = conflicted.filter((f) => !versionFiles.has(f.toLowerCase()) && !isChangelog(f));
        let why = !conflicted.length ? `merging ${e.branch} into it failed: ${lastLine(m)}` : others.length ? `it conflicts with ${e.branch} in ${others.join(', ')}` : null;
        let stuck = others;
        if (!why) {
          for (const f of conflicted) {
            // The changelog, from its three sides: the PR's new entry above the branch's, under its new version.
            const side = async (n: number) => (await gitMaybe(run, dir, 'show', `:${n}:${f}`)) ?? '';
            const fixed = isChangelog(f) ? mergeChangelogs(await side(1), await side(2), await side(3), to) : resolveVersionConflicts(readFileSync(path.join(dir, f), 'utf8'));
            if (fixed === null) {
              why = `it conflicts with ${e.branch} in ${f} beyond ${isChangelog(f) ? 'a new entry at its top' : 'its version'}`;
              stuck = [f];
              break;
            }
            writeFileSync(path.join(dir, f), fixed);
          }
        }
        if (why) {
          await gitMaybe(run, dir, 'merge', '--abort');
          return { done: false, note: `${why}: that needs its author`, from: own, ...(stuck.length ? { conflicts: stuck } : {}) };
        }
        // A lock resolved here had its version lines changed on both sides: it is kept in step, as npm keeps it.
        const lockToo = lockBeside(e.versionFiles).filter((f) => named(conflicted, f));
        settleVersion(dir, [...e.versionFiles, ...lockToo], sets ? to : mainV);
        await git(run, dir, 'add', '--', ...conflicted, ...e.versionFiles);
        await git(run, dir, 'commit', '--quiet', '--no-edit');
        did.push(`merged ${e.branch} into it, its ${conflicted.some(isChangelog) ? (conflicted.length > 1 ? 'version lines and changelog' : 'changelog') : 'version lines'} resolved`);
      } else did.push(`merged ${e.branch} into it`);
    }
    const changed = sets ? settleVersion(dir, settledFiles(dir, e.versionFiles), to) : [];
    // Its entry under its old version says the new one: the changelog's top entry (one main's version names is main's),
    // and a changes/<version>.md it adds, renamed.
    const log = path.join(dir, 'CHANGELOG.md');
    if (sets && own && own !== to && own !== mainV && existsSync(log)) {
      const renamed = renumberChangelog(readFileSync(log, 'utf8'), own, to);
      if (renamed !== null) {
        writeFileSync(log, renamed);
        changed.push('CHANGELOG.md');
      }
    }
    for (const f of added) {
      const into = `${CHANGES_DIR}/${to}.md`;
      if (changeVersion(f) === to || existsSync(path.join(dir, into))) continue;
      await git(run, dir, 'mv', '--', f, into);
      changed.push(f, into);
    }
    if (changed.length) {
      await git(run, dir, 'add', '-A', '--', ...changed);
      await git(run, dir, 'commit', '--quiet', '-m', `${e.name} ${to}: re-versioned by the Steward`, '-m', `${o.why}.`);
    }
    if (own && own !== to) did.push(`v${to}, from v${own}`);
    if (!did.length) return { done: true, note: `nothing to do: up to date with ${e.branch}`, from: own };
    // Another PC's turn here now (lease.ts): it does this.
    if (ctx.lease?.has(e.id) && !(await ctx.lease.ok(e))) return { done: false, note: `${did.join('; ')}, but another PC publishes ${e.name} now, so it wasn't pushed`, from: own };
    await git(run, dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.head}`);
    const pushed = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
    const title = own && own !== to && pr.title.includes(own) ? pr.title.split(own).join(to) : pr.title;
    if (title !== pr.title) await hostFor(ctx, e).editPr(e.repo, pr.number, { title }).catch(() => null);
    const note = did.join('; ');
    ctx.log(`[${e.id}] #${pr.number}: ${note}`);
    return { done: true, note, head: pushed, from: own };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
