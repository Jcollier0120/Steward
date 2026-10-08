import { existsSync } from 'node:fs';
import { commitOf, fetchBranch, gh, gitMaybe, showFile } from './git.ts';
import { compareVersions } from './kitfiles.ts';
import { manorProjects, type ManorProject } from './kit/manor.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Employee } from './settings.ts';
import { checkoutOf, glanceOf, hostIs, type Ctx } from './stages/common.ts';
import { holdReason, prVersions } from './stages/merge.ts';
import { parsePrs, prListArgs, type PrInfo } from './stages/staff.ts';
import { agreedVersion, readVersion } from './versions.ts';

/**
 * Each repository's version queue, for Manor: the version on its branch, and the open PRs that set a version above it,
 * lowest first, the order the merges take them in (stages/merge.ts). Made at the end of each round for every employee
 * and for Manor's non-employee projects (settings.json's "projects", read only: the Steward never merges, releases or
 * changes one). Kept in version-queues.json and served at GET /api/version-queues, which Manor shows.
 *
 * A repository's versions are read again only when its branch or one of its PRs has a new head commit: the round's
 * glance says so for the employees, and a project's are asked of git and GitHub each round.
 */

export interface QueuedPr {
  number: number;
  title: string;
  url: string;
  /** The version it sets. */
  version: string;
  /** Whether it is ready to merge as GitHub has it (mergeable, not a draft, checks passing or none). */
  ready: boolean;
  /** Why it isn't ready, when it isn't. */
  why: string | null;
  /** The commit its version was read at. */
  head: string;
  /** A draft, which holds its place in line: the PRs above it wait until it is marked ready and merges. */
  draft?: boolean;
  /** One of the Wright's drafts (labelled wright), which the Bailiff reviews. */
  wright?: boolean;
}

/**
 * A draft coming up in a version queue: near the front of the line, or already holding ready PRs back. Its reviewer
 * (the Bailiff, for one of the Wright's) or its author is told early, so it is ready before its turn comes.
 */
export interface UpcomingDraft {
  /** The queue's id (an employee's, or project:<name>). */
  id: string;
  name: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  version: string;
  /** Its place in line: 0 is next. */
  position: number;
  /** The ready PRs above it, waiting on it. */
  holds: number[];
  wright: boolean;
  head: string;
}

/** How near the front a draft is told it is coming up: within the first three. */
export const UPCOMING_WITHIN = 3;

/** The drafts coming up in the queues: within UPCOMING_WITHIN of the front, or holding a ready PR back. Front first. Pure. */
export function upcomingDrafts(repos: VersionQueue[]): UpcomingDraft[] {
  const out: UpcomingDraft[] = [];
  for (const r of repos) {
    if (!r.repo) continue;
    r.queue.forEach((q, position) => {
      if (!q.draft) return;
      const holds = r.queue.slice(position + 1).filter((x) => x.ready).map((x) => x.number);
      if (position >= UPCOMING_WITHIN && !holds.length) return;
      out.push({ id: r.id, name: r.name, repo: r.repo!, number: q.number, url: q.url, title: q.title, version: q.version, position, holds, wright: !!q.wright, head: q.head });
    });
  }
  return out.sort((a, b) => a.position - b.position || b.holds.length - a.holds.length || a.repo.localeCompare(b.repo) || a.number - b.number);
}

export interface VersionQueue {
  id: string;
  name: string;
  /** An employee of the Steward's, or one of Manor's non-employee projects. */
  kind: 'agent' | 'project';
  repo: string | null;
  branch: string;
  /** The version on its branch now, or null when it has none the Steward can read (`note` says why). */
  version: string | null;
  /** The commit of its branch that was read. */
  head: string | null;
  /** The files its version was read from (a project's guessed when it names none). */
  files: string[];
  /** The open PRs that set a version above the branch's, lowest first, drafts too: a draft holds its place in line. */
  queue: QueuedPr[];
  /** The version it works on next: the lowest in its queue, or null when the queue is empty. */
  working: string | null;
  /** The highest version among its ready PRs, or null when none is ready. */
  latest: string | null;
  note: string | null;
  at: string;
}

export interface VersionQueues {
  at: string;
  repos: VersionQueue[];
  /** The drafts coming up (upcomingDrafts), front first: the Bailiff reviews these before the rest. */
  upcoming?: UpcomingDraft[];
}

export const versionQueuesFile = () => dataFile('version-queues.json');
export const loadVersionQueues = (): VersionQueues => readJson<VersionQueues>(versionQueuesFile(), { at: '', repos: [] });

/** What a queue is made from: an employee, or a project made to look like one. */
interface Target {
  id: string;
  name: string;
  kind: VersionQueue['kind'];
  repo: string | null;
  branch: string;
  checkout: string;
  versionFiles: string[];
  /** Its PRs can be listed (on GitHub). */
  prs: boolean;
}

/** The files a project with none named carries its version in: the first of these found on its branch. */
const GUESSES = ['package.json', 'VERSION'];

export const projectId = (p: ManorProject) => `project:${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

function targetsOf(ctx: Ctx, projects: ManorProject[]): Target[] {
  const agents: Target[] = ctx.settings.employees.map((e) => ({ id: e.id, name: e.name, kind: 'agent', repo: e.repo, branch: e.branch, checkout: checkoutOf(e), versionFiles: e.versionFiles, prs: hostIs(ctx, e) !== 'git' }));
  const own = new Set(agents.map((t) => t.checkout.toLowerCase()));
  const sideCars: Target[] = projects
    .filter((p) => !own.has(p.checkout.toLowerCase()))
    .map((p) => ({ id: projectId(p), name: p.name, kind: 'project', repo: p.repo, branch: p.branch, checkout: p.checkout, versionFiles: p.versionFiles, prs: !!p.repo }));
  return [...agents, ...sideCars];
}

/** The version on `ref`, from the target's files (or the first guess found), or why there is none. */
async function versionAt(ctx: Ctx, t: Target, ref: string): Promise<{ version: string; files: string[] } | { error: string }> {
  let files = t.versionFiles;
  if (!files.length) {
    for (const f of GUESSES) {
      const text = await showFile(ctx.run, t.checkout, ref, f);
      if (text !== null && readVersion(f, text)) {
        files = [f];
        break;
      }
    }
    if (!files.length) return { error: `no version files named, and none of ${GUESSES.join(', ')} with a version` };
  }
  const v = agreedVersion(await Promise.all(files.map(async (f) => [f, await showFile(ctx.run, t.checkout, ref, f)] as [string, string | null])));
  return 'error' in v ? v : { version: v.version, files };
}

/** Its open PRs: from the round's glance for an employee, else asked of GitHub. Everyone's, not only the team's. */
async function openPrs(ctx: Ctx, t: Target): Promise<PrInfo[]> {
  if (!t.prs || !t.repo) return [];
  const g = t.kind === 'agent' ? glanceOf(ctx, { id: t.id } as Employee) : null;
  const raw = g ? g.prs : JSON.parse((await gh(ctx.run, ctx.neutralDir, ...prListArgs(t.repo))) || '[]');
  const authors = [...new Set(raw.map((p: any) => String(p?.author?.login ?? '')).filter(Boolean))] as string[];
  return parsePrs(JSON.stringify(raw), authors);
}

async function queueOf(ctx: Ctx, t: Target, before: VersionQueue | undefined, at: string): Promise<VersionQueue> {
  const base: Omit<VersionQueue, 'version' | 'head' | 'files' | 'queue' | 'working' | 'latest' | 'note'> = { id: t.id, name: t.name, kind: t.kind, repo: t.repo, branch: t.branch, at };
  const empty = (note: string, version: string | null = null, head: string | null = null, files: string[] = []): VersionQueue => ({ ...base, version, head, files, queue: [], working: null, latest: null, note });
  if (!existsSync(t.checkout)) return empty(`no checkout at ${t.checkout}`);
  // Its branch as its origin has it, or the clone's own branch when there is no origin to fetch from.
  let ref = `origin/${t.branch}`;
  try {
    await fetchBranch(ctx.run, t.checkout, t.branch);
  } catch {
    if (!(await commitOf(ctx.run, t.checkout, ref))) ref = t.branch;
  }
  const head = await commitOf(ctx.run, t.checkout, ref);
  if (!head) return empty(`no branch ${t.branch} in ${t.checkout}`);
  const v = before?.head === head && before.version && before.files?.length ? { version: before.version, files: before.files } : await versionAt(ctx, t, ref);
  if ('error' in v) return empty(v.error, null, head);
  let prs: PrInfo[];
  try {
    prs = await openPrs(ctx, t);
  } catch (err) {
    return empty(`couldn't list its PRs: ${(err as Error).message}`, v.version, head, v.files);
  }
  const known = new Map((before?.queue ?? []).map((q) => [q.head, q.version]));
  const queue: QueuedPr[] = [];
  for (const pr of prs) {
    if (pr.base !== t.branch || !pr.headOid) continue;
    let sets = known.get(pr.headOid) ?? null;
    if (!sets) {
      try {
        const p = await prVersions(ctx, { id: t.id, checkout: t.checkout, branch: t.branch, versionFiles: v.files } as Employee, pr);
        sets = p.head && p.head !== p.from ? p.head : null;
      } catch {
        sets = null;
      }
    }
    if (!sets || compareVersions(sets, v.version) <= 0) continue;
    const why = holdReason(pr, t.branch);
    queue.push({ number: pr.number, title: pr.title, url: pr.url, version: sets, ready: why === null, why, head: pr.headOid, draft: pr.draft, wright: pr.labels.includes('wright') });
  }
  queue.sort((a, b) => compareVersions(a.version, b.version) || a.number - b.number);
  const ready = queue.filter((q) => q.ready);
  return { ...base, version: v.version, head, files: v.files, queue, working: queue[0]?.version ?? null, latest: ready.length ? ready[ready.length - 1].version : null, note: null };
}

/**
 * Every repository's queue made again (only what changed is read again), kept, and returned. A repository that can't
 * be read keeps a note saying why; one that fails outright keeps what it had.
 */
export async function keepVersionQueues(ctx: Ctx, o: { projects?: ManorProject[]; now?: () => Date } = {}): Promise<VersionQueues> {
  const at = (o.now?.() ?? new Date()).toISOString();
  const before = new Map(loadVersionQueues().repos.map((r) => [r.id, r]));
  let projects: ManorProject[];
  try {
    projects = o.projects ?? manorProjects();
  } catch {
    projects = [];
  }
  const repos: VersionQueue[] = [];
  for (const t of targetsOf(ctx, projects)) {
    try {
      repos.push(await queueOf(ctx, t, before.get(t.id), at));
    } catch (err) {
      const kept = before.get(t.id);
      ctx.log(`[${t.id}] couldn't read its version queue: ${(err as Error).message}`);
      if (kept) repos.push(kept);
    }
  }
  const out: VersionQueues = { at, repos, upcoming: upcomingDrafts(repos) };
  writeJson(versionQueuesFile(), out);
  return out;
}
