import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandEnv } from '../kit/settings-kit.ts';
import { readAfter, type After } from '../after.ts';
import { compareVersions, lf } from '../kitfiles.ts';
import { takesTool, TOOL } from '../kitsource.ts';
import { aheadOf, branchExists, commitOf, fetchBranch, gitMaybe, showFile } from '../git.ts';
import { repoSig } from '../glance.ts';
import { agreedVersion } from '../versions.ts';
import { releasedHere, type Employee } from '../settings.ts';
import { bumpBranch, checkoutOf, glanceOf, hostIs, mapLimit, NOT_ON_KIT, type Ctx } from './common.ts';
import { gitGlance } from '../scm.ts';
import { hostFor, must, type SourceHost } from '../hosts/index.ts';

/**
 * The staff at a glance (`steward staff`, and the page's table): for each employee, its own checkout, its
 * branch on origin (version, pinned kit, whether its tools/kit.ts is the
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
  /** Its head commit. */
  headOid: string;
  /** When it was opened (ISO), as its host says; absent when it doesn't. A younger one than Settings' mergeMinAgeMinutes waits. */
  createdAt?: string;
  /** What its description's steward block asks for after merging (src/after.ts), or why that can't be read. */
  after: After | null;
  afterError: string | null;
  /** GitHub's: MERGEABLE, CONFLICTING or UNKNOWN (still working it out). */
  mergeable: string;
  mergeState: string;
  draft: boolean;
  checks: Checks;
  /** Its labels' names: `wright` on the Wright's PRs, `wright:needs-you` on those a person reviews. */
  labels: string[];
  /** Lines added and removed, and the files it changes (gh pr list's, at most 100). */
  changed: number;
  files: string[];
  /** The issues its description closes ("Closes #12"): the Wright's PR names the issue it was queued as. */
  closes?: number[];
  /** From a fork (gh's isCrossRepository): never pushed to. */
  fork?: boolean;
  /** For one of the Wright's drafts: why the Steward's look (review.ts) leaves it to the person. Not from gh. */
  reviewHold?: string;
  /** For one of the Wright's drafts that passed the look: why it waits for the Bailiff's approval of its head (review.ts). Not from gh. */
  bailiffHold?: string;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  published: string | null;
}

export interface StaffRow {
  /** The Steward's own repository (stages/selfmerge.ts), shown beside the employees: no stage is run on it from the table. */
  self?: boolean;
  id: string;
  name: string;
  repo: string;
  branch: string;
  usesKit: boolean;
  checkout: { path: string; exists: boolean; branch: string | null; changes: number };
  main: {
    commit: string;
    version: string | null;
    versionError: string | null;
    kit: string | null;
    /** The parts its kit.json takes: the one place they're kept. */
    parts: string[] | null;
    /** Its tools/kit.ts against the Steward's: the same, different, missing, or not asked (null). */
    tool: 'current' | 'differs' | 'missing' | null;
  } | null;
  release: (ReleaseInfo & { kit: string | null | 'unknown' }) | null;
  /** The version on its branch has no release yet. */
  releaseNeeded: boolean;
  /** Settings merge its ready PRs (Employee.merges), and name a way to release it. */
  merges?: boolean;
  releases?: boolean;
  prs: PrInfo[];
  /** A bump to the kit made here (steward/kit-<kit>) and how far ahead of origin it is, if there is one. */
  prepared: { branch: string; ahead: number } | null;
  /** Anything worth a word: not using the kit, a version mismatch, a failed lookup. */
  notes: string[];
}

export interface Staff {
  /** When the table was made. */
  at: string;
  /** When GitHub was last seen to say nothing new for it (a round's glance), or when it was made. */
  checked?: string;
  /** What GitHub said of each employee's repository when the table was made (glance.ts's repoSig), by id. */
  seen?: Record<string, string>;
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

/**
 * The commit status `steward vouch` sets on a PR's head once its checks passed in its author's clone (stages/vouch.ts).
 * It isn't a check GitHub runs: checksOf leaves it out, and the merge stage decides whether to trust it.
 */
export const VOUCH_CONTEXT = 'steward/tested';

/** A PR's checks as one word: failing if any fails, else pending if any is still running, else passing; none without checks. A vouch (VOUCH_CONTEXT) isn't one. */
export function checksOf(rollup: unknown): Checks {
  const list = (Array.isArray(rollup) ? rollup : []).filter((c) => c?.context !== VOUCH_CONTEXT);
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

/** The issues a PR's description closes, as GitHub reads it: "Closes #12", "fixes #3", "Resolved #7". */
export const closedIssues = (body: string): number[] => [...new Set([...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((m) => Number(m[1])))];

/** The Steward's PRs and the team's in a `gh pr list --json` answer (openPrs), by number. */
export function parsePrs(json: string, team: string[]): PrInfo[] {
  const list = JSON.parse(json || '[]') as any[];
  return list
    .map((p) => ({ p, whose: whosePr(p, team) }))
    .filter((x): x is { p: any; whose: PrInfo['whose'] } => x.whose !== null)
    .map(({ p, whose }) => {
      const after = readAfter(p.body);
      return {
        number: Number(p.number),
        title: String(p.title ?? ''),
        url: String(p.url ?? ''),
        head: p.headRefName,
        base: String(p.baseRefName ?? ''),
        author: String(p.author?.login ?? ''),
        whose,
        headOid: String(p.headRefOid ?? ''),
        ...(typeof p.createdAt === 'string' && p.createdAt ? { createdAt: p.createdAt } : {}),
        after: 'after' in after ? after.after : null,
        afterError: 'error' in after ? after.error : null,
        mergeable: String(p.mergeable ?? 'UNKNOWN'),
        mergeState: String(p.mergeStateStatus ?? 'UNKNOWN'),
        draft: p.isDraft === true,
        checks: checksOf(p.statusCheckRollup),
        labels: Array.isArray(p.labels) ? p.labels.map((l: any) => String(l?.name ?? '')).filter(Boolean) : [],
        changed: (Number(p.additions) || 0) + (Number(p.deletions) || 0),
        files: Array.isArray(p.files) ? p.files.map((f: any) => String(f?.path ?? '')).filter(Boolean) : [],
        closes: closedIssues(String(p.body ?? '')),
      };
    })
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

/** The PR fields parsePrs reads, as GitHub names them. */
export const PR_FIELDS = 'number,title,url,body,createdAt,headRefName,headRefOid,baseRefName,isCrossRepository,author,mergeable,mergeStateStatus,isDraft,statusCheckRollup,labels,additions,deletions,files';

/** A repository's open PRs as its host lists them (PR_FIELDS), for parsePrs; CommandFailed when it can't. */
export const openPrs = async (host: SourceHost, repo: string) => must(await host.listPrs(repo, { state: 'open', limit: 100, fields: PR_FIELDS }));

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
    checkout: { path: dir, exists: existsSync(dir), branch: null, changes: 0 },
    main: null,
    release: null,
    releaseNeeded: false,
    merges: e.merges,
    releases: !!e.release,
    prs: [],
    prepared: null,
    notes,
  };
  // Settings' own word on it first (why its PRs are left to you, say).
  if (e.note) notes.push(e.note);
  if (e.refresh) notes.push(`after each release: ${e.refresh}, pushed to ${e.branch} when it changes anything`);
  if (!e.usesKit) notes.push(NOT_ON_KIT);
  const remote = `origin/${e.branch}`;
  const here = releasedHereRow(e, row);
  // GitHub's side, from the glance when there is one (glance.ts): its PRs, its releases, the commit each release tags.
  // Worked with plain git (scm.ts): its origin's branch and tags, and no PRs; GitHub isn't asked.
  const byGit = hostIs(ctx, e) === 'git';
  let gitErr: string | null = null;
  const g = glanceOf(ctx, e) ?? (byGit ? await gitGlance(run, { branch: e.branch, checkout: dir }).catch((err) => ((gitErr = (err as Error).message), null)) : null);

  const local = (async () => {
    if (!row.checkout.exists) return void notes.push(`no checkout at ${dir}`);
    row.checkout.branch = (await gitMaybe(run, dir, 'branch', '--show-current'))?.trim() || '(detached)';
    row.checkout.changes = ((await gitMaybe(run, dir, '--no-optional-locks', 'status', '--porcelain')) ?? '').split('\n').filter((l) => l.trim()).length;
    // Fetched, unless the glance at GitHub says the checkout has its branch's head already.
    let commit = g?.head ? await commitOf(run, dir, remote) : null;
    if (opts.fetch && (!g?.head || commit !== g.head)) {
      try {
        await fetchBranch(run, dir, e.branch);
      } catch (err) {
        notes.push(`couldn't fetch ${remote}: ${(err as Error).message}`);
      }
      commit = null;
    }
    commit ??= await commitOf(run, dir, remote);
    if (!commit) return void notes.push(`no ${remote} in ${dir}`);
    const texts = await Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, dir, remote, f)] as [string, string | null]));
    const v = agreedVersion(texts);
    const pin = readPin(await showFile(run, dir, remote, 'kit.json'));
    let tool: 'current' | 'differs' | 'missing' | null = null;
    if (e.usesKit && pin && opts.tool && takesTool(e.fill)) {
      const theirs = await showFile(run, dir, remote, TOOL);
      tool = theirs === null ? 'missing' : lf(theirs) === lf(opts.tool) ? 'current' : 'differs';
      if (tool === 'missing') notes.push(`no ${TOOL} on ${remote}`);
      if (tool === 'differs') notes.push(`${TOOL} on ${remote} isn't the Steward's: the next bump brings it`);
    }
    row.main = { commit: commit.slice(0, 7), version: 'version' in v ? v.version : null, versionError: 'error' in v ? v.error : null, kit: pin?.kit ?? null, parts: pin?.parts ?? null, tool };
    if ('error' in v) notes.push(v.error);
    if (e.usesKit && !pin) notes.push(`no kit.json on ${remote}`);
    if (opts.kit) {
      const branch = bumpBranch(opts.kit);
      if (await branchExists(run, dir, branch)) row.prepared = { branch, ahead: await aheadOf(run, dir, branch, remote) };
    }
  })().catch((err) => void notes.push((err as Error).message));

  const prs = (g || byGit ? Promise.resolve(JSON.stringify(g?.prs ?? [])) : openPrs(hostFor({ ...ctx, run }, e), e.repo))
    .then((out) => void (row.prs = parsePrs(out, ctx.settings.team)))
    .catch((err) => void notes.push(`couldn't list its PRs: ${(err as Error).message}`));

  const releases = (g ? Promise.resolve(JSON.stringify(g.releases)) : byGit ? Promise.reject(new Error(gitErr ?? 'no answer from its origin')) : hostFor({ ...ctx, run }, e).listReleases(e.repo, 'tagName,isDraft,publishedAt').then(must))
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
        const tagged = g?.releases.find((r) => r.tagName === latest.tag)?.commit;
        const target = tagged ?? (byGit ? null : JSON.parse(must(await hostFor({ ...ctx, run }, e).viewRelease(e.repo, latest.tag, 'targetCommitish'))).targetCommitish as string);
        if (target && row.checkout.exists && /^[0-9a-f]{40}$/i.test(target) && (await commitOf(run, dir, target))) kit = readPin(await showFile(run, dir, target, 'kit.json'))?.kit ?? null;
      } catch {
        // unknown
      }
      row.release = { ...latest, kit };
    }
    // Only one the Steward releases (Settings' Release it) is waiting for a release.
    if (row.main?.version && e.release) row.releaseNeeded = !list.some((r) => r.version === row.main!.version);
  }
  // Released here (releasedHere): what counts is the installed copy, which no GitHub release lists.
  if (here) row.releaseNeeded = !!row.main?.version && here.version !== row.main.version;
  return row;
}

/** The installed copy of an employee released here: its release.json's version. Null for one released on GitHub. */
function releasedHereRow(e: Employee, row: StaffRow): { version: string | null } | null {
  if (!releasedHere(e)) return null;
  try {
    const r = JSON.parse(readFileSync(path.join(expandEnv(e.installed), 'release.json'), 'utf8')) as { version?: unknown };
    return { version: typeof r.version === 'string' ? r.version : null };
  } catch {
    row.notes.push(`released on this PC, and not installed yet (${e.installed || 'no install folder set'})`);
    return { version: null };
  }
}

/**
 * Every employee's row, a few at a time, then the Steward's own (`self`) when it has one; with what GitHub said of each
 * employee (glance.ts's repoSig), so a round can tell when the table is out of date.
 */
export async function staff(ctx: Ctx, opts: { fetch: boolean; kit: string | null; kitNote?: string | null; tool?: string | null; self?: Employee | null }): Promise<Staff> {
  const rows = await mapLimit(ctx.settings.employees, 5, (e) => staffRow(ctx, e, opts));
  if (opts.self) rows.push({ ...(await staffRow(ctx, opts.self, { ...opts, kit: null, tool: null })), self: true });
  const at = new Date().toISOString();
  const seen = ctx.glance ? Object.fromEntries(Object.entries(ctx.glance.repos).map(([id, g]) => [id, repoSig(g)])) : undefined;
  return { at, checked: at, kit: opts.kit, kitNote: opts.kitNote ?? null, released: ctx.kit.released, local: ctx.kit.local, rows, ...(seen ? { seen } : {}) };
}
