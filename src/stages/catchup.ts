import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aheadOf, fetchBranch, gh, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { compareVersions } from '../kitfiles.ts';
import type { Employee, Settings } from '../settings.ts';
import { agreedVersion, bumpPatch, readVersion, setVersion } from '../versions.ts';
import { checkoutOf, workRootOf, type Ctx } from './common.ts';
import type { PrInfo } from './staff.ts';

/**
 * Catching a team PR up, so it doesn't wait on its branch moving under it: the Steward merges the branch into it
 * (a merge commit on top: nothing of the PR's is rewritten) and, where its version is no longer new, gives it the
 * next free one. It pushes that to the PR's branch, says so on the PR, and the next round tests it at its new head
 * and merges it as any team PR.
 *
 * Only what needs no judgement: a conflict is resolved only in a version file, and only where one side changed
 * nothing but versions (diff3's common ancestor says which). Any other conflict is left to a person, untouched.
 * Only the team's PRs from the repository itself (never a fork's, never the Steward's own bumps, never a draft).
 */

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
  /** What it did ("merged main into it; v0.4.12, since v0.4.11 is already released"), or why it couldn't. */
  note: string;
  version?: string;
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
 * One team PR caught up with its branch, as the module's comment says: `released` are the employee's released
 * versions, `taken` the versions other open PRs set (which keep theirs).
 */
export async function catchUp(ctx: Ctx, e: Employee, pr: PrInfo, o: { released: string[]; taken: string[] }): Promise<CaughtUp> {
  const { run } = ctx;
  if (pr.whose !== 'team' || pr.fork || pr.draft) return { done: false, note: 'only a ready team PR from the repository itself is caught up' };
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
  const start = (await gitMaybe(run, repo, 'merge-base', branch, head))?.trim();
  const [headV, fromV, baseV] = [await read(head), start ? await read(start) : null, await read(branch)];
  if (!headV || !baseV) return { done: false, note: `its version can't be read (${e.versionFiles.join(', ')})` };
  const choice = catchUpVersion({ head: headV, from: fromV, base: baseV, released: o.released, taken: o.taken, asksRelease: !!pr.after?.steps.includes('release') });
  const behind = await aheadOf(run, repo, branch, head);
  if (!behind && !choice.why) return { done: false, note: 'nothing to catch up' };

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
        const others = conflicted.filter((f) => !versionFiles.has(f.toLowerCase()));
        const why = !conflicted.length
          ? `merging ${e.branch} into it failed: ${(m.err || m.out).trim().split('\n').pop()}`
          : others.length
            ? `it conflicts with ${e.branch} in ${others.join(', ')}: that needs a person`
            : null;
        let unresolved = why;
        if (!unresolved) {
          for (const f of conflicted) {
            const fixed = resolveVersionConflicts(readFileSync(path.join(dir, f), 'utf8'));
            if (fixed === null) {
              unresolved = `it conflicts with ${e.branch} in ${f} beyond its version: that needs a person`;
              break;
            }
            writeFileSync(path.join(dir, f), fixed);
          }
        }
        if (unresolved) {
          await gitMaybe(run, dir, 'merge', '--abort');
          return { done: false, note: unresolved };
        }
        settleVersion(dir, e.versionFiles, choice.version);
        await git(run, dir, 'add', '--', ...conflicted, ...e.versionFiles);
        await git(run, dir, 'commit', '--quiet', '--no-edit');
        did.push(`merged ${e.branch} into it, its version lines resolved`);
      } else did.push(`merged ${e.branch} into it`);
    }
    const changed = settleVersion(dir, e.versionFiles, choice.version);
    if (changed.length) {
      await git(run, dir, 'add', '--', ...changed);
      await git(run, dir, 'commit', '--quiet', '-m', `${e.name} ${choice.version}: a version of its own (${choice.why ?? `the branch's, after the merge`})`);
    }
    if (choice.why) did.push(`v${choice.version}, since ${choice.why}`);
    await git(run, dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.head}`);
    const note = did.join('; ');
    ctx.log(`[${e.id}] #${pr.number}: caught up (${note})`);
    // Its title says its version, when it did; the comment says what changed, and that it merges once tested again.
    if (choice.why && pr.title.includes(headV)) await gh(run, ctx.neutralDir, 'pr', 'edit', String(pr.number), '--repo', e.repo, '--title', pr.title.split(headV).join(choice.version)).catch(() => '');
    await gh(run, ctx.neutralDir, 'pr', 'comment', String(pr.number), '--repo', e.repo, '--body', `Caught up by the Steward: ${note}. It merges once its checks pass at the new head.`).catch(() => '');
    return { done: true, note, version: choice.version };
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
