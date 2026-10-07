import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aheadOf, fetchBranch, gh, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { compareVersions, KIT_VERSION, pinText } from '../kitfiles.ts';
import { readPin } from './staff.ts';
import type { Employee, Settings } from '../settings.ts';
import { agreedVersion, bumpPatch, readVersion, setVersion } from '../versions.ts';
import { runChecks } from './bump.ts';
import { bumpDirOf, checkoutOf, workRootOf, type Ctx } from './common.ts';
import type { PrInfo } from './staff.ts';
import { recordTested } from '../tested.ts';
import { isKitChangelog, isKitVersionFile, KIT_CHANGELOG, KIT_VERSION_FILE, kitVersionText, renameKitInTopEntry, repinKit } from './kitpart.ts';

/**
 * Catching a team PR up, so it doesn't wait on its branch moving under it: the Steward merges the branch into it
 * (a merge commit on top: nothing of the PR's is rewritten) and, where its version is no longer new, gives it the
 * next free one. It pushes that to the PR's branch, says so on the PR, and the next round tests it at its new head
 * and merges it as any team PR.
 *
 * Only what needs no judgement: a conflict is resolved only in a version file, and only where one side changed
 * nothing but versions (diff3's common ancestor says which); in the changelog, where each side only added an entry
 * at its top (mergeChangelogs); or in kit.json, where the newer kit of the two is pinned with every part either takes,
 * and nothing else in it changed on both sides (mergeKitPins). Any other conflict is left untouched, and goes back to
 * the PR's author (kickback.ts).
 * In the Steward's own repository the kit is a second version (stages/kitpart.ts): kit/VERSION and kit/CHANGELOG.md are
 * settled by the same rules, against the kit's releases and the kit versions other PRs and claims hold, and the PR's own
 * changelog entry, its kit.json pin of its own kit and its title follow the kit's new version.
 * Only the team's PRs from the repository itself (never a fork's, never a draft), and the Steward's own kit PRs
 * (steward/kit-…).
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
const sameButVersions = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l.replace(VERSION, 'x.y.z').trimEnd() === b[i].replace(VERSION, 'x.y.z').trimEnd());

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
 * kept, the PR's entry put above them under `to` (its version once caught up), everything older as it was. Null when
 * it needs judgement: the text above the entries changed on both sides, an older entry changed, or the PR added more
 * than one entry, or one whose heading names no version.
 */
export function mergeChangelogs(base: string, ours: string, theirs: string, to: string): string | null {
  const eol = theirs.includes('\r\n') ? '\r\n' : '\n';
  const [b, o, t] = [sectionsOf(base), sectionsOf(ours), sectionsOf(theirs)];
  if (o.head !== b.head && t.head !== b.head && o.head !== t.head) return null;
  const head = o.head === b.head ? t.head : o.head;
  const n = b.parts.length;
  const keeps = (x: { parts: string[] }) => x.parts.length >= n && x.parts.slice(x.parts.length - n).every((p, i) => sameSection(p, b.parts[i]));
  if (!keeps(o) || !keeps(t)) return null;
  const mine = o.parts.slice(0, o.parts.length - n);
  const theirsNew = t.parts.slice(0, t.parts.length - n);
  if (mine.length > 1) return null;
  const renamed = mine.map((p) => {
    const [heading, ...rest] = p.split('\n');
    return VERSION_IN.test(heading) ? [heading.replace(VERSION_IN, to), ...rest].join('\n') : null;
  });
  if (renamed.includes(null)) return null;
  const moved = [...(renamed as string[]), ...theirsNew];
  // Each section is its lines, joined again with the line breaks between them; one moved above another ends with a blank line.
  const parts = [...moved.map((p, i) => (i < moved.length - 1 || n ? spaced(p) : p)), ...b.parts];
  const text = (head === '' && parts.length ? parts : [head, ...parts]).join('\n');
  return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
}

const VERSION_IN = /\d+\.\d+\.\d+/;

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
 * left the version alone keeps the branch's, unless it asks for a release of a version already released.
 */
export function catchUpVersion(o: { head: string; from: string | null; base: string; released: string[]; taken: string[]; asksRelease: boolean }): { version: string; why: string | null } {
  const taken = new Set([...o.released, ...o.taken]);
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

export interface CaughtUp {
  done: boolean;
  /** A kit PR of the Steward's it closed, since it conflicted beyond its versions: the next round bumps again. */
  closed?: boolean;
  /** What it did ("merged main into it; v0.4.12, since v0.4.11 is already released"), or why it couldn't. */
  note: string;
  /** The files it conflicts in that need judgement, when that's why it wasn't caught up: they go back to its author (kickback.ts). */
  conflicts?: string[];
  version?: string;
  /** The kit's version it carries, in the Steward's own repository (stages/kitpart.ts). */
  kitVersion?: string;
}

/** Each version file in a folder set to `version` where it says otherwise; the files changed. */
function settleVersion(dir: string, files: string[], version: string): string[] {
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
  const r = await ctx.run('gh', ['pr', 'close', String(pr.number), '--repo', e.repo, '--delete-branch', '--comment', body], { cwd: ctx.neutralDir, timeoutMs: 120_000 });
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
 * versions, `taken` the versions other open PRs set (which keep theirs).
 */
export async function catchUp(ctx: Ctx, e: Employee, pr: PrInfo, o: { released: string[]; taken: string[]; kit?: { released: string[]; taken: string[] } }): Promise<CaughtUp> {
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
  // Its kit is its branch's name's (steward/kit-<version>).
  const brings = kitPr ? /^steward\/kit-(\d+\.\d+\.\d+)$/.exec(pr.head)?.[1] : undefined;
  if (brings) {
    const theirs = readPin(await showFile(run, repo, branch, 'kit.json'));
    if (theirs && KIT_VERSION.test(theirs.kit) && compareVersions(theirs.kit, brings) >= 0) return await closeKitPr(ctx, e, pr, repo, `${e.branch} already carries kit ${theirs.kit}`, { redundant: true });
  }
  const start = (await gitMaybe(run, repo, 'merge-base', branch, head))?.trim();
  const [headV, fromV, baseV] = [await read(head), start ? await read(start) : null, await read(branch)];
  if (!headV || !baseV) return { done: false, note: `its version can't be read (${e.versionFiles.join(', ')})` };
  const choice = catchUpVersion({ head: headV, from: fromV, base: baseV, released: o.released, taken: o.taken, asksRelease: !!pr.after?.steps.includes('release') });
  // The kit, where the repository carries one (the Steward's own): its version settled the same way.
  const kitAt = async (ref: string) => (/^\s*(\d+\.\d+\.\d+)\s*$/.exec((await showFile(run, repo, ref, KIT_VERSION_FILE)) ?? '')?.[1] ?? null);
  const [kHead, kBase] = [await kitAt(head), await kitAt(branch)];
  const kFrom = start && kHead ? await kitAt(start) : null;
  const kit = kHead && kBase ? catchUpVersion({ head: kHead, from: kFrom, base: kBase, released: o.kit?.released ?? [], taken: o.kit?.taken ?? [], asksRelease: false }) : null;
  const behind = await aheadOf(run, repo, branch, head);
  if (!behind && !choice.why && !kit?.why) return { done: false, note: 'nothing to catch up' };

  const dir = catchUpDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, head);
  try {
    const did: string[] = [];
    if (behind) {
      const m = await run('git', ['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', '-m', `Merge ${e.branch} into ${pr.head}: caught up by the Steward`, branch], { cwd: dir, timeoutMs: 5 * 60_000 });
      if (m.code !== 0) {
        const conflicted = (await gitMaybe(run, dir, 'diff', '--name-only', '--diff-filter=U'))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
        const versionFiles = new Set(e.versionFiles.map((f) => f.replace(/\\/g, '/').toLowerCase()));
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
          if (kitPr && conflicted.length) return await closeKitPr(ctx, e, pr, repo, unresolved.replace(/: that needs a person$/, ''));
          return { done: false, note: unresolved, ...(conflicted.length ? { conflicts: stuck } : {}) };
        }
        settleVersion(dir, e.versionFiles, choice.version);
        await git(run, dir, 'add', '--', ...conflicted, ...e.versionFiles);
        await git(run, dir, 'commit', '--quiet', '--no-edit');
        const what = ['version lines', ...(conflicted.some(isKitPin) ? ['kit pin'] : []), ...(conflicted.some(isChangelog) ? ['changelog'] : []), ...(conflicted.some(isKitVersionFile) ? ['kit version'] : []), ...(conflicted.some(isKitChangelog) ? ["kit's changelog"] : [])];
        did.push(`merged ${e.branch} into it, its ${what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]} resolved`);
      } else did.push(`merged ${e.branch} into it`);
    }
    const changed = settleVersion(dir, e.versionFiles, choice.version);
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
      const failed = await runChecks(ctx, e, dir, { say: (line) => ctx.log(`[${e.id}] #${pr.number}: ${line}`) });
      if (failed) return { done: false, note: `${did.join('; ')}, but then ${failed}, so it wasn't pushed` };
      did.push('its checks passed');
    }
    await git(run, dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.head}`);
    // A kit PR's new head, whose checks passed here: the Surveyor's GET /api/tested (tested.ts).
    if (kitPr) recordTested(e.id, { commit: (await git(run, dir, 'rev-parse', 'HEAD')).trim(), stage: 'catch-up', branch: pr.head, pr: pr.number, version: choice.version });
    const note = did.join('; ');
    ctx.log(`[${e.id}] #${pr.number}: caught up (${note})`);
    // Its title says its version, when it did; the comment says what changed, and that it merges once tested again.
    let title = choice.why && pr.title.includes(headV) ? pr.title.split(headV).join(choice.version) : pr.title;
    if (kit?.why && kHead) title = title.replace(new RegExp(`\\b(kit )${kHead.replace(/\./g, '\\.')}\\b`, 'i'), `$1${kit.version}`);
    if (title !== pr.title) await gh(run, ctx.neutralDir, 'pr', 'edit', String(pr.number), '--repo', e.repo, '--title', title).catch(() => '');
    await gh(run, ctx.neutralDir, 'pr', 'comment', String(pr.number), '--repo', e.repo, '--body', `Caught up by the Steward: ${note}. ${kitPr ? 'The next round merges it.' : 'It merges once its checks pass at the new head.'}`).catch(() => '');
    // A kit version only for a PR that raises the kit: one that leaves it alone carries the branch's, and claims nothing.
    return { done: true, note, version: choice.version, ...(kit && kit.version !== kBase ? { kitVersion: kit.version } : {}) };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
