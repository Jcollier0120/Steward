import { git, gitMaybe, showFile } from './git.ts';
import type { Employee, Settings } from './settings.ts';
import { checkoutOf, type Ctx } from './stages/common.ts';
import type { PrInfo } from './stages/staff.ts';

/**
 * The Steward's look at the Wright's drafts, in code (no model): the Wright opens every pull request as a draft, so
 * nothing it wrote merges unlooked at. A draft the Wright opened (labelled `wright`, by the team) that passes every
 * check below is marked ready, and then merged as any team PR is, tested here at its head first. One that fails a
 * check stays a draft for the person, and says why (after a day, the Steward's alarm says so too).
 *
 * The checks: not labelled wright:needs-you (the Wright's own word that a person reviews it); no changed file a person
 * reviews (Settings: the same patterns as the Wright's, checked here again rather than trusted); no change to its
 * dependencies (package.json's dependencies, devDependencies, optionalDependencies, peerDependencies); and not
 * larger than Settings allow. Its tests come after, as for every team PR.
 *
 * Where the Bailiff is installed (settings.ts's bailiffInstalled), one more: the Bailiff, which reads each draft with
 * Claude Code, has approved its current head commit. It labels the PR bailiff:approved and ends its review comment
 * with a marker naming the commit it reviewed; both must agree with the head the Steward is about to mark ready.
 * Without the Bailiff, nothing changes.
 */

export const WRIGHT_LABEL = 'wright';
export const NEEDS_YOU_LABEL = 'wright:needs-you';
export const BAILIFF_LABELS = { approved: 'bailiff:approved', changes: 'bailiff:changes', waiting: 'bailiff:waiting' } as const;

/** Is it one of the Wright's drafts, for the Steward to look at? */
export const isWrightDraft = (pr: PrInfo) => pr.whose === 'team' && pr.draft && pr.labels.includes(WRIGHT_LABEL);

/** A path pattern as a regular expression: * is any part of a name, ** any folders; case doesn't matter (as the Wright's). */
export function patternRe(p: string): RegExp {
  const s = p
    .trim()
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${s}$`, 'i');
}

export const sensitiveFiles = (files: string[], patterns: string[]) => {
  const res = patterns.filter((p) => p.trim()).map(patternRe);
  return files.filter((f) => res.some((r) => r.test(f.replace(/\\/g, '/'))));
};

/** Why the Steward won't mark it ready on its own, from what gh lists: null when nothing does. Pure. */
export function reviewHold(pr: PrInfo, s: Settings['wrightReview']): string | null {
  if (pr.labels.includes(NEEDS_YOU_LABEL)) return `the Wright labelled it ${NEEDS_YOU_LABEL}`;
  if (!pr.files.length) return "gh listed no files it changes, so the Steward can't look";
  if (pr.files.length >= 100) return 'it changes 100 files or more';
  const sensitive = sensitiveFiles(pr.files, s.sensitive);
  if (sensitive.length) return `it changes what a person reviews: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? ', …' : ''}`;
  if (pr.changed > s.maxLines) return `it changes ${pr.changed} lines, over the ${s.maxLines} the Steward takes on its own`;
  return null;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** package.json's dependency fields, as one comparable string; null when there's no such file or it isn't JSON. */
export function dependenciesOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    const j = JSON.parse(text.replace(/^﻿/, ''));
    return JSON.stringify(DEPENDENCY_FIELDS.map((k) => [k, Object.entries(j?.[k] ?? {}).sort(([a], [b]) => a.localeCompare(b))]));
  } catch {
    return null;
  }
}

/** Why its dependencies stop the Steward: package.json's dependencies differ between its head and where it started. */
export async function dependencyHold(ctx: Ctx, e: Employee, pr: PrInfo): Promise<string | null> {
  if (!pr.files.some((f) => /(^|\/)package\.json$/i.test(f))) return null;
  const repo = checkoutOf(e);
  await git(ctx.run, repo, 'fetch', '--quiet', 'origin', `refs/pull/${pr.number}/head`);
  const head = pr.headOid || 'FETCH_HEAD';
  const start = (await gitMaybe(ctx.run, repo, 'merge-base', `origin/${e.branch}`, head))?.trim();
  if (!start) return "the Steward couldn't find where it started, to compare its dependencies";
  for (const f of pr.files.filter((x) => /(^|\/)package\.json$/i.test(x))) {
    if (dependenciesOf(await showFile(ctx.run, repo, head, f)) !== dependenciesOf(await showFile(ctx.run, repo, start, f))) return `it changes the dependencies in ${f}`;
  }
  return null;
}

/** The comment the Steward leaves when it marks one ready: what it looked at (and, with the Bailiff, the commit it approved). */
export const reviewedComment = (pr: PrInfo, s: Settings['wrightReview'], bailiff = false) =>
  `The Steward looked at this draft from the Wright and marked it ready:\n\n- not labelled ${NEEDS_YOU_LABEL};\n- none of its ${pr.files.length} files is one a person reviews;\n- no dependency changes;\n- ${pr.changed} lines changed (it takes up to ${s.maxLines});${bailiff ? `\n- the Bailiff approved its head commit, ${pr.headOid.slice(0, 7)};` : ''}\n\nIts tests run here at its head before it merges.`;

/** The Bailiff's marker, the last thing in its review comment: `<!-- bailiff-review {"head":"<sha>","verdict":"approved"} -->`. */
const BAILIFF_MARK = /<!-- bailiff-review (\{[^<>]*\}) -->\s*$/;

/**
 * The Bailiff's last verdict on a PR, from its comments (gh pr view --json comments): the last one by the team (the
 * Bailiff posts with the team's account) that ends with its marker. Null when there is none. Pure.
 */
export function bailiffVerdict(comments: unknown, team: string[]): { head: string; verdict: string } | null {
  const t = new Set(team.map((x) => x.toLowerCase()));
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i] as { author?: { login?: string }; body?: unknown };
    if (!t.has(String(c?.author?.login ?? '').toLowerCase()) || typeof c.body !== 'string') continue;
    const m = BAILIFF_MARK.exec(c.body);
    if (!m) continue;
    try {
      const j = JSON.parse(m[1]);
      if (typeof j?.head === 'string' && typeof j?.verdict === 'string') return { head: j.head, verdict: j.verdict };
    } catch {
      // not the Bailiff's: look further back
    }
  }
  return null;
}

/**
 * Why the Bailiff's review keeps one of the Wright's drafts, or null when the Bailiff has approved its head commit:
 * the PR is labelled bailiff:approved, and the Bailiff's last review comment approves exactly the head the Steward
 * listed, which is still the PR's head.
 */
export async function bailiffHold(ctx: Ctx, e: Employee, pr: PrInfo): Promise<string | null> {
  if (!pr.labels.includes(BAILIFF_LABELS.approved)) {
    if (pr.labels.includes(BAILIFF_LABELS.changes)) return 'the Bailiff asked for changes (its comment says which)';
    if (pr.labels.includes(BAILIFF_LABELS.waiting)) return "the Bailiff couldn't review it yet (its comment says why)";
    return "waiting for the Bailiff's review";
  }
  if (!pr.headOid) return "gh didn't say its head commit, so the Steward can't match the Bailiff's approval to it";
  const r = await ctx.run('gh', ['pr', 'view', String(pr.number), '--repo', e.repo, '--json', 'headRefOid,comments'], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
  if (r.code !== 0) return `the Steward couldn't read the Bailiff's review: ${(r.err || r.out).trim().split('\n').pop()}`;
  let view: { headRefOid?: unknown; comments?: unknown };
  try {
    view = JSON.parse(r.out);
  } catch {
    return "the Steward couldn't read the Bailiff's review";
  }
  if (view.headRefOid !== pr.headOid) return 'its head moved since the round listed it: the next round looks again';
  const v = bailiffVerdict(view.comments, ctx.settings.team);
  if (!v || v.verdict !== 'approved') return `labelled ${BAILIFF_LABELS.approved}, but the Bailiff's last review doesn't approve it`;
  if (v.head !== pr.headOid) return `the Bailiff approved ${v.head.slice(0, 7)}, not its head ${pr.headOid.slice(0, 7)}: waiting for its review of the new commit`;
  return null;
}
