import { existsSync } from 'node:fs';
import { carriedOldKit, compareVersions, lf, oldKitFilesIn } from '../kitfiles.ts';
import { takesTool, TOOL } from '../kitsource.ts';
import { aheadOf, branchExists, commitOf, fetchBranch, gh, gitMaybe, showFile, trackedAt } from '../git.ts';
import { agreedVersion } from '../versions.ts';
import type { Employee } from '../settings.ts';
import { bumpBranch, checkoutOf, NOT_ON_KIT, type Ctx } from './common.ts';

/**
 * The staff at a glance (`steward staff`, and the page's table): for each employee, its own checkout, its
 * branch on origin (version, pinned kit, old kit files still tracked, whether its tools/kit.ts is the
 * Steward's), its latest release and the kit that release carries, the open PRs of the Steward and the
 * team, and a bump prepared here but not pushed.
 */

export type Checks = 'none' | 'passing' | 'pending' | 'failing';

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  head: string;
  /** The branch it merges into. */
  base: string;
  /** The GitHub account that opened it (a GitHub App's as app/<name>). */
  author: string;
  /** The Steward's (a bump's PR, from the repository itself), or one a team member opened. */
  whose: 'steward' | 'team';
  /** GitHub's: MERGEABLE, CONFLICTING or UNKNOWN (still working it out). */
  mergeable: string;
  mergeState: string;
  draft: boolean;
  checks: Checks;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  published: string | null;
}

export interface StaffRow {
  id: string;
  name: string;
  repo: string;
  branch: string;
  usesKit: boolean;
  parts: string[];
  checkout: { path: string; exists: boolean; branch: string | null; changes: number };
  main: {
    commit: string;
    version: string | null;
    versionError: string | null;
    kit: string | null;
    parts: string[] | null;
    oldKitFiles: string[];
    /** Its tools/kit.ts against the Steward's: the same, different, missing, or not asked (null). */
    tool: 'current' | 'differs' | 'missing' | null;
  } | null;
  release: (ReleaseInfo & { kit: string | null | 'unknown' }) | null;
  /** The version on its branch has no release yet. */
  releaseNeeded: boolean;
  prs: PrInfo[];
  /** A bump to the kit made here (steward/kit-<kit>) and how far ahead of origin it is, if there is one. */
  prepared: { branch: string; ahead: number } | null;
  /** Anything worth a word: not using the kit, old kit files, a version mismatch, a failed lookup. */
  notes: string[];
}

export interface Staff {
  at: string;
  /** The kit the Steward hands out (the newest release, or this checkout's). */
  kit: string | null;
  kitNote: string | null;
  released: string[];
  local: string | null;
  rows: StaffRow[];
}

/** One check's state from a statusCheckRollup entry: a CheckRun (status, conclusion) or a StatusContext (state). */
function checkState(c: any): Checks {
  if (c?.__typename === 'StatusContext' || ('state' in (c ?? {}) && !('status' in (c ?? {})))) {
    const s = String(c.state ?? '').toUpperCase();
    return s === 'SUCCESS' ? 'passing' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'failing';
  }
  if (String(c?.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending';
  const done = String(c?.conclusion ?? '').toUpperCase();
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(done) ? 'passing' : 'failing';
}

/** A PR's checks as one word: failing if any fails, else pending if any is still running, else passing; none without checks. */
export function checksOf(rollup: unknown): Checks {
  const list = Array.isArray(rollup) ? rollup : [];
  if (!list.length) return 'none';
  const states = list.map(checkState);
  return states.includes('failing') ? 'failing' : states.includes('pending') ? 'pending' : 'passing';
}

/**
 * Whose a PR in a `gh pr list` answer is: the Steward's when its head is a steward/… branch of the
 * repository itself (a fork's branch can be called anything), the team's when one of `team`'s accounts
 * opened it (GitHub's accounts ignore case), or nobody's the Steward deals with (null).
 */
export function whosePr(p: any, team: string[]): PrInfo['whose'] | null {
  if (typeof p?.headRefName !== 'string') return null;
  if (p.headRefName.startsWith('steward/') && p.isCrossRepository === false) return 'steward';
  const author = String(p.author?.login ?? '').toLowerCase();
  return author && team.some((t) => t.toLowerCase() === author) ? 'team' : null;
}

/** The Steward's PRs and the team's in a `gh pr list --json` answer (prListArgs), by number. */
export function parsePrs(json: string, team: string[]): PrInfo[] {
  const list = JSON.parse(json || '[]') as any[];
  return list
    .map((p) => ({ p, whose: whosePr(p, team) }))
    .filter((x): x is { p: any; whose: PrInfo['whose'] } => x.whose !== null)
    .map(({ p, whose }) => ({
      number: Number(p.number),
      title: String(p.title ?? ''),
      url: String(p.url ?? ''),
      head: p.headRefName,
      base: String(p.baseRefName ?? ''),
      author: String(p.author?.login ?? ''),
      whose,
      mergeable: String(p.mergeable ?? 'UNKNOWN'),
      mergeState: String(p.mergeStateStatus ?? 'UNKNOWN'),
      draft: p.isDraft === true,
      checks: checksOf(p.statusCheckRollup),
    }))
    .sort((a, b) => a.number - b.number);
}

/** The app releases (v<x.y.z>, not drafts) in a `gh release list --json tagName,isDraft,publishedAt` answer, newest version first. */
export function appReleasesIn(json: string): ReleaseInfo[] {
  const list = JSON.parse(json || '[]') as any[];
  return list
    .filter((r) => !r?.isDraft && /^v\d+\.\d+\.\d+$/.test(String(r?.tagName ?? '')))
    .map((r) => ({ tag: r.tagName as string, version: (r.tagName as string).slice(1), published: typeof r.publishedAt === 'string' ? r.publishedAt : null }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** kit.json's text as {kit, parts}, or null when it isn't one. */
export function readPin(text: string | null): { kit: string; parts: string[] | null } | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text.replace(/^﻿/, ''));
    return typeof j?.kit === 'string' ? { kit: j.kit, parts: Array.isArray(j.parts) ? j.parts.map(String) : null } : null;
  } catch {
    return null;
  }
}

export const prListArgs = (repo: string) => ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,url,headRefName,baseRefName,isCrossRepository,author,mergeable,mergeStateStatus,isDraft,statusCheckRollup'];

export async function staffRow(ctx: Ctx, e: Employee, opts: { fetch: boolean; kit: string | null; tool?: string | null }): Promise<StaffRow> {
  const { run } = ctx;
  const dir = checkoutOf(e);
  const notes: string[] = [];
  const row: StaffRow = {
    id: e.id,
    name: e.name,
    repo: e.repo,
    branch: e.branch,
    usesKit: e.usesKit,
    parts: e.parts,
    checkout: { path: dir, exists: existsSync(dir), branch: null, changes: 0 },
    main: null,
    release: null,
    releaseNeeded: false,
    prs: [],
    prepared: null,
    notes,
  };
  if (!e.usesKit) notes.push(NOT_ON_KIT);
  const remote = `origin/${e.branch}`;

  const local = (async () => {
    if (!row.checkout.exists) return void notes.push(`no checkout at ${dir}`);
    row.checkout.branch = (await gitMaybe(run, dir, 'branch', '--show-current'))?.trim() || '(detached)';
    row.checkout.changes = ((await gitMaybe(run, dir, '--no-optional-locks', 'status', '--porcelain')) ?? '').split('\n').filter((l) => l.trim()).length;
    if (opts.fetch) {
      try {
        await fetchBranch(run, dir, e.branch);
      } catch (err) {
        notes.push(`couldn't fetch ${remote}: ${(err as Error).message}`);
      }
    }
    const commit = await commitOf(run, dir, remote);
    if (!commit) return void notes.push(`no ${remote} in ${dir}`);
    const texts = await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, dir, remote, f)] as [string, string | null]));
    const v = agreedVersion(texts);
    const pin = readPin(await showFile(run, dir, remote, 'kit.json'));
    // Only a hire that carried the old kit can still track it; Reeve's files at those paths are its own.
    const oldKitFiles = e.usesKit && carriedOldKit(e.id) ? oldKitFilesIn(await trackedAt(run, dir, remote)) : [];
    let tool: 'current' | 'differs' | 'missing' | null = null;
    if (e.usesKit && pin && opts.tool && takesTool(e.fill)) {
      const theirs = await showFile(run, dir, remote, TOOL);
      tool = theirs === null ? 'missing' : lf(theirs) === lf(opts.tool) ? 'current' : 'differs';
      if (tool === 'missing') notes.push(`no ${TOOL} on ${remote}`);
      if (tool === 'differs') notes.push(`${TOOL} on ${remote} isn't the Steward's: the next bump brings it`);
    }
    row.main = { commit: commit.slice(0, 7), version: 'version' in v ? v.version : null, versionError: 'error' in v ? v.error : null, kit: pin?.kit ?? null, parts: pin?.parts ?? null, oldKitFiles, tool };
    if ('error' in v) notes.push(v.error);
    if (e.usesKit && oldKitFiles.length) notes.push(`still tracks ${oldKitFiles.length} old kit files at their old paths (${oldKitFiles.slice(0, 3).join(', ')}${oldKitFiles.length > 3 ? ', …' : ''}): convert it to the Steward's kit`);
    else if (e.usesKit && !pin) notes.push(`no kit.json on ${remote}`);
    if (pin?.parts && pin.parts.join(',') !== e.parts.join(',')) notes.push(`kit.json takes ${pin.parts.join(', ')}; Settings say ${e.parts.join(', ')}`);
    if (opts.kit) {
      const branch = bumpBranch(opts.kit);
      if (await branchExists(run, dir, branch)) row.prepared = { branch, ahead: await aheadOf(run, dir, branch, remote) };
    }
  })().catch((err) => void notes.push((err as Error).message));

  const prs = gh(run, ctx.neutralDir, ...prListArgs(e.repo))
    .then((out) => void (row.prs = parsePrs(out, ctx.settings.team)))
    .catch((err) => void notes.push(`couldn't list its PRs: ${(err as Error).message}`));

  const releases = gh(run, ctx.neutralDir, 'release', 'list', '--repo', e.repo, '--limit', '100', '--json', 'tagName,isDraft,publishedAt')
    .then((out) => appReleasesIn(out))
    .catch((err) => {
      notes.push(`couldn't list its releases: ${(err as Error).message}`);
      return null;
    });

  await Promise.all([local, prs]);
  const list = await releases;
  if (list) {
    const latest = list[0] ?? null;
    if (latest) {
      // The kit a release carries: kit.json at the commit it was built from.
      let kit: string | null | 'unknown' = 'unknown';
      try {
        const target = JSON.parse(await gh(run, ctx.neutralDir, 'release', 'view', latest.tag, '--repo', e.repo, '--json', 'targetCommitish')).targetCommitish as string;
        if (row.checkout.exists && /^[0-9a-f]{40}$/i.test(target ?? '') && (await commitOf(run, dir, target))) kit = readPin(await showFile(run, dir, target, 'kit.json'))?.kit ?? null;
      } catch {
        // unknown
      }
      row.release = { ...latest, kit };
    }
    if (row.main?.version) row.releaseNeeded = !list.some((r) => r.version === row.main!.version);
  }
  return row;
}

/** Every employee's row, a few at a time. */
export async function staff(ctx: Ctx, opts: { fetch: boolean; kit: string | null; kitNote?: string | null; tool?: string | null }): Promise<Staff> {
  const rows: StaffRow[] = [];
  const all = ctx.settings.employees;
  for (let i = 0; i < all.length; i += 5) rows.push(...(await Promise.all(all.slice(i, i + 5).map((e) => staffRow(ctx, e, opts)))));
  return { at: new Date().toISOString(), kit: opts.kit, kitNote: opts.kitNote ?? null, released: ctx.kit.released, local: ctx.kit.local, rows };
}
