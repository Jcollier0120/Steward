import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandEnv } from '../kit/settings-kit.ts';
import { readAfter, type After } from '../after.ts';
import { compareVersions, lf } from '../kitfiles.ts';
import { takesTool, TOOL } from '../kitsource.ts';
import { aheadOf, branchExists, commitOf, fetchBranch, gitMaybe, headBranch, refOnDisk, showFile } from '../git.ts';
import { repoSig } from '../glance.ts';
import { agreedVersion } from '../versions.ts';
import { releasedHere, type Employee } from '../settings.ts';
import { bumpBranch, checkoutOf, glanceOf, hostIs, mapLimit, NOT_ON_KIT, type Ctx } from './common.ts';
import { gitGlance } from '../scm.ts';
import { hostFor, must, type SourceHost } from '../hosts/index.ts';
import { repoBusy } from './slots.ts';

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
  /**
   * What the next build releases: origin's branch since the commit its latest release was built from (nextBuildOf). Null
   * when that can't be said (no release yet, or its commit isn't in the clone); absent in a row made before Steward 0.36.135.
   */
  nextBuild?: NextBuild | null;
  /** Settings merge its ready PRs (Employee.merges), and name a way to release it. */
  merges?: boolean;
  releases?: boolean;
  prs: PrInfo[];
  /** A bump to the kit made here (steward/kit-<kit>) and how far ahead of origin it is, if there is one. */
  prepared: { branch: string; ahead: number } | null;
  /** Anything worth a word: not using the kit, a version mismatch, a failed lookup. */
  notes: string[];
}

/** A commit on an employee's branch since its last release: a merged PR is one, its merge commit (git log --first-parent). */
export interface Unreleased {
  /** Its commit, short. */
  sha: string;
  /** The PR it merged, where its message names one (prOfCommit); null for a commit pushed without one. */
  pr: number | null;
  /** The PR's title, or the commit's subject. */
  title: string;
}

/** What the next build releases (StaffRow.nextBuild). */
export interface NextBuild {
  /** The release it counts from (v<x.y.z>), and the commit that release was built from. */
  tag: string;
  commit: string;
  /** The newest NEXT_BUILD_SHOWN, newest first. */
  commits: Unreleased[];
  /** How many there are in all, these among them. */
  count: number;
}

/** How many of the next build's commits a row keeps: the newest. */
export const NEXT_BUILD_SHOWN = 10;

/**
 * The PR a commit on the branch merged, and its title, from its message as each host writes it: GitHub's merge commit
 * ("Merge pull request #12 from owner/branch", the title on the next line) or squash ("Title (#12)"), Gitea's ("Merge
 * pull request 'Title' (#12) from branch into main"), Azure DevOps' ("Merged PR 12: Title"), Bitbucket's ("Merged in
 * branch (pull request #12)", the title below) and GitLab's ("Merge branch 'x' into 'main'", the title and "See merge
 * request group/repo!12" below). Anything else was pushed without a PR: its subject, and no number. Pure.
 */
export function prOfCommit(subject: string, body: string): { pr: number | null; title: string } {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  let m = /^Merge pull request #(\d+) from \S+/.exec(subject);
  if (m) return { pr: Number(m[1]), title: first || subject };
  m = /^Merge pull request '(.+)' \(#(\d+)\) from /.exec(subject);
  if (m) return { pr: Number(m[2]), title: m[1] };
  m = /^Merged PR (\d+): (.+)$/.exec(subject);
  if (m) return { pr: Number(m[1]), title: m[2] };
  m = /^Merged in \S+ \(pull request #(\d+)\)/.exec(subject);
  if (m) return { pr: Number(m[1]), title: first || subject };
  m = /^Merge branch '.+' into '.+'/.test(subject) ? /See merge request \S+!(\d+)/.exec(body) : null;
  if (m) return { pr: Number(m[1]), title: first && !first.startsWith('See merge request') ? first : subject };
  m = /^(.+) \(#(\d+)\)$/.exec(subject);
  if (m) return { pr: Number(m[2]), title: m[1] };
  return { pr: null, title: subject };
}

/** git log's answer in LOG_FORMAT (fields split by \x1f, commits ended by \x1e) as Unreleased lines, in its order. Pure. */
export function parseLog(out: string): Unreleased[] {
  return out
    .split('\x1e')
    .map((c) => c.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((c) => {
      const [sha = '', subject = '', body = ''] = c.split('\x1f');
      return { sha: sha.trim().slice(0, 7), ...prOfCommit(subject.trim(), body) };
    });
}

const LOG_FORMAT = '--format=%H%x1f%s%x1f%b%x1e';

/**
 * What the next build releases: `remote` since `from`, the commit a release was built from, as git log --first-parent
 * lists it in the clone (a merged PR is its merge commit, one line). The newest NEXT_BUILD_SHOWN are read; their count
 * is asked of git only when there are more. Null when git can't say.
 */
export async function nextBuildOf(run: Ctx['run'], dir: string, remote: string, from: { tag: string; commit: string }): Promise<NextBuild | null> {
  const range = `${from.commit}..${remote}`;
  const out = await gitMaybe(run, dir, 'log', '--first-parent', `-n${NEXT_BUILD_SHOWN + 1}`, LOG_FORMAT, range);
  if (out === null) return null;
  const read = parseLog(out);
  const commits = read.slice(0, NEXT_BUILD_SHOWN);
  let count = read.length;
  if (read.length > NEXT_BUILD_SHOWN) count = Number((await gitMaybe(run, dir, 'rev-list', '--count', '--first-parent', range))?.trim()) || read.length;
  return { tag: from.tag, commit: from.commit, commits, count };
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
  /** What each row was made from (rowKey), by id, for the rows made without a failure: the same next time, the row stands. */
  keys?: Record<string, string>;
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

/**
 * The commit status a build set on each PR it took, before Steward 0.36.124 (builds no longer take PRs). It said what the
 * build did, and isn't a check either: checksOf leaves it out too.
 */
export const BUILD_CONTEXT = 'steward/build';

/** A PR's checks as one word: failing if any fails, else pending if any is still running, else passing; none without checks. A vouch (VOUCH_CONTEXT) or a build's word (BUILD_CONTEXT) isn't one. */
export function checksOf(rollup: unknown): Checks {
  const list = (Array.isArray(rollup) ? rollup : []).filter((c) => c?.context !== VOUCH_CONTEXT && c?.context !== BUILD_CONTEXT);
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
    nextBuild: null,
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
    Object.assign(row.checkout, await checkoutNow(run, dir));
    // Fetched, unless the glance at GitHub says the checkout has its branch's head already, or a stage running beside
    // this one is working in it (stages/slots.ts): its own fetches bring the branch, and the next look shows it.
    let commit = g?.head ? await commitOf(run, dir, remote) : null;
    if (opts.fetch && (!g?.head || commit !== g.head) && !repoBusy(e.id)) {
      try {
        await fetchBranch(run, dir, e.branch);
      } catch (err) {
        notes.push(`couldn't fetch ${remote}: ${(err as Error).message}`);
        shaky.add(row);
      }
      commit = null;
    }
    commit ??= await commitOf(run, dir, remote);
    if (!commit) return void notes.push(`no ${remote} in ${dir}`);
    // Asked together, so git reads them in one command (showFile).
    const wantsTool = e.usesKit && !!opts.tool && takesTool(e.fill);
    const [texts, pinText, theirs] = await Promise.all([
      Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, dir, remote, f)] as [string, string | null])),
      showFile(run, dir, remote, 'kit.json'),
      wantsTool ? showFile(run, dir, remote, TOOL) : null,
    ]);
    const v = agreedVersion(texts);
    const pin = readPin(pinText);
    let tool: 'current' | 'differs' | 'missing' | null = null;
    if (wantsTool && pin && opts.tool) {
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
  })().catch((err) => void (notes.push((err as Error).message), shaky.add(row)));

  const prs = (g || byGit ? Promise.resolve(JSON.stringify(g?.prs ?? [])) : openPrs(hostFor({ ...ctx, run }, e), e.repo))
    .then((out) => void (row.prs = parsePrs(out, ctx.settings.team)))
    .catch((err) => void (notes.push(`couldn't list its PRs: ${(err as Error).message}`), shaky.add(row)));

  const releases = (g ? Promise.resolve(JSON.stringify(g.releases)) : byGit ? Promise.reject(new Error(gitErr ?? 'no answer from its origin')) : hostFor({ ...ctx, run }, e).listReleases(e.repo, 'tagName,isDraft,publishedAt').then(must))
    .then((out) => appReleasesIn(out))
    .catch((err) => {
      notes.push(`couldn't list its releases: ${(err as Error).message}`);
      shaky.add(row);
      return null;
    });

  await Promise.all([local, prs]);
  const list = await releases;
  // The release the next build counts from, and the commit it was built from, once that commit is in the clone.
  let from: { tag: string; commit: string } | null = null;
  if (list) {
    const latest = list[0] ?? null;
    if (latest) {
      // The kit a release carries: kit.json at the commit it was built from.
      let kit: string | null | 'unknown' = 'unknown';
      try {
        const tagged = g?.releases.find((r) => r.tagName === latest.tag)?.commit;
        const target = tagged ?? (byGit ? null : JSON.parse(must(await hostFor({ ...ctx, run }, e).viewRelease(e.repo, latest.tag, 'targetCommitish'))).targetCommitish as string);
        if (target && row.checkout.exists && /^[0-9a-f]{40}$/i.test(target) && (await commitOf(run, dir, target))) {
          from = { tag: latest.tag, commit: target.toLowerCase() };
          kit = readPin(await showFile(run, dir, target, 'kit.json'))?.kit ?? null;
        }
      } catch {
        // unknown
      }
      // Unknown now, perhaps known once its commit is here: the row is made again next time.
      if (kit === 'unknown') shaky.add(row);
      row.release = { ...latest, kit };
    }
    // Only one the Steward releases (Settings' Release it) is waiting for a release.
    if (row.main?.version && e.release) row.releaseNeeded = !list.some((r) => r.version === row.main!.version);
  }
  // Released here (releasedHere): what counts is the installed copy, which no GitHub release lists.
  if (here) {
    row.releaseNeeded = !!row.main?.version && here.version !== row.main.version;
    const built = here.version && here.commit && row.checkout.exists ? await commitOf(run, dir, here.commit) : null;
    from = built ? { tag: `v${here.version}`, commit: built } : null;
  }
  if (from && row.main) {
    row.nextBuild = await nextBuildOf(run, dir, remote, from);
    // git couldn't say: made again next time.
    if (!row.nextBuild) shaky.add(row);
  }
  return row;
}

/**
 * The installed copy of an employee released here: its release.json's version, and the commit it was built from (none
 * for a development build). Null for one released on GitHub.
 */
function releasedHereRow(e: Employee, row: StaffRow): { version: string | null; commit: string | null } | null {
  if (!releasedHere(e)) return null;
  try {
    const r = JSON.parse(readFileSync(path.join(expandEnv(e.installed), 'release.json'), 'utf8').replace(/^﻿/, '')) as { version?: unknown; commit?: unknown; dirty?: unknown };
    const commit = r.dirty === false && typeof r.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(r.commit) ? r.commit : null;
    return { version: typeof r.version === 'string' ? r.version : null, commit };
  } catch {
    row.notes.push(`released on this PC, and not installed yet (${e.installed || 'no install folder set'})`);
    return { version: null, commit: null };
  }
}

/**
 * Every employee's row, a few at a time, then the Steward's own (`self`) when it has one; with what GitHub said of each
 * employee (glance.ts's repoSig), so a round can tell when the table is out of date.
 */
export async function staff(ctx: Ctx, opts: { fetch: boolean; kit: string | null; kitNote?: string | null; tool?: string | null; self?: Employee | null; before?: Staff | null }): Promise<Staff> {
  const keys: Record<string, string> = {};
  // Made again only where what it rests on moved (rowKey); else the row the table had, its checkout looked at again.
  const rowOf = async (e: Employee, o: { kit: string | null; tool?: string | null }, self: boolean): Promise<StaffRow> => {
    const key = rowKey(ctx, e, { ...o, self });
    const had = key && opts.before?.keys?.[e.id] === key ? opts.before.rows.find((r) => r.id === e.id && !!r.self === self) : undefined;
    let row: StaffRow;
    if (had) {
      const exists = existsSync(had.checkout.path);
      row = { ...had, checkout: { ...had.checkout, exists, ...(exists ? await checkoutNow(ctx.run, had.checkout.path) : {}) } };
    } else row = await staffRow(ctx, e, { ...opts, ...o });
    if (key && !shaky.has(row)) keys[e.id] = key;
    return self ? { ...row, self: true } : row;
  };
  const rows = await mapLimit(ctx.settings.employees, 5, (e) => rowOf(e, opts, false));
  if (opts.self) rows.push(await rowOf(opts.self, { kit: null, tool: null }, true));
  const at = new Date().toISOString();
  const seen = ctx.glance ? Object.fromEntries(Object.entries(ctx.glance.repos).map(([id, g]) => [id, repoSig(g)])) : undefined;
  return { at, checked: at, kit: opts.kit, kitNote: opts.kitNote ?? null, released: ctx.kit.released, local: ctx.kit.local, rows, ...(seen ? { seen } : {}), keys };
}

/** Rows made with a failure on the way (a fetch, a host's answer, a release's kit unknown): never kept as made (rowKey). */
const shaky = new WeakSet<StaffRow>();

/** A checkout's branch, from its HEAD file (git asked only when that doesn't say), and its changed files, untracked left out. */
async function checkoutNow(run: Ctx['run'], dir: string): Promise<{ branch: string; changes: number }> {
  const branch = (headBranch(dir) ?? (await gitMaybe(run, dir, 'branch', '--show-current'))?.trim()) || '(detached)';
  const changes = ((await gitMaybe(run, dir, '--no-optional-locks', 'status', '--porcelain', '-uno')) ?? '').split('\n').filter((l) => l.trim()).length;
  return { branch, changes };
}

/**
 * What an employee's row rests on, as one value, read from files alone (no git started): GitHub's side from the glance
 * (repoSig), origin's branch and the bump prepared here as the clone's ref files have them, its installed release (one
 * released here), its Settings, the team and the kit and tools/kit.ts the Steward hands out. Null when the row is to be
 * made afresh whatever: no glance for it, or origin's branch here isn't the glance's head (there is something to fetch).
 */
export function rowKey(ctx: Ctx, e: Employee, o: { kit: string | null; tool?: string | null; self?: boolean }): string | null {
  const g = glanceOf(ctx, e);
  const dir = checkoutOf(e);
  const origin = g?.head ? refOnDisk(dir, `refs/remotes/origin/${e.branch}`) : null;
  if (!g?.head || origin !== g.head) return null;
  const prepared = o.kit ? refOnDisk(dir, `refs/heads/${bumpBranch(o.kit)}`) : null;
  let installed: string | null = null;
  if (releasedHere(e)) {
    try {
      installed = readFileSync(path.join(expandEnv(e.installed), 'release.json'), 'utf8');
    } catch {
      installed = null;
    }
  }
  const tool = o.tool ? createHash('sha256').update(o.tool).digest('hex') : null;
  // `made`: what a row holds, raised when it holds more (2: nextBuild, Steward 0.36.135), so a row kept from before is made again.
  const what = { made: 2, e, self: !!o.self, repo: repoSig(g), origin, prepared, installed, team: ctx.settings.team, kit: o.kit, tool };
  return createHash('sha256').update(JSON.stringify(what)).digest('hex').slice(0, 32);
}
