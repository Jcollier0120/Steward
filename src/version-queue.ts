import { existsSync } from 'node:fs';
import { commitOf, fetchBranch, gitMaybe, showFile } from './git.ts';
import { compareVersions } from './kitfiles.ts';
import { manorProjects, type ManorProject } from './kit/manor.ts';
import { freshRemoteHeads } from './kit/remote-heads.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Held } from './alarms.ts';
import type { Employee } from './settings.ts';
import { checkoutOf, glanceOf, hostIs, type Ctx } from './stages/common.ts';
import { holdReason, prVersions } from './stages/merge.ts';
import { openPrs as listOpenPrs, parsePrs, type PrInfo } from './stages/staff.ts';
import { agreedVersion, readVersion } from './versions.ts';
import { hostFor } from './hosts/index.ts';

/**
 * Each repository's version queue, for Manor: the version on its branch, and the open PRs that set a version above it,
 * lowest first, the order the merges take them in (stages/merge.ts). Made at the end of each round for every employee
 * and for Manor's non-employee projects (settings.json's "projects", read only: the Steward never merges, releases or
 * changes one). Kept in version-queues.json and served at GET /api/version-queues, which Manor shows.
 *
 * A repository's versions are read again only when its branch or one of its PRs has a new head commit: the round's
 * glance says so for the employees, and a project's are asked of git and GitHub each round. A clone is fetched only when
 * its branch on GitHub moved: a head GitHub gave (the glance's, or remote-heads.json's for a project) that is the one
 * kept, or the clone's own already, needs no fetch. One the stage merged or released to is fetched as before, since its
 * glance was taken before that.
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

/**
 * What holds a version queue (Steward 0.36.45): the lowest PR in it that isn't ready to merge (a draft, untested, its
 * checks failing or running) while ready PRs above it wait their turn behind it, the lowest version merging first. On
 * 2026-10-14 and 15 three drafts held the Steward's own queue for hours with nothing saying so. Said in the round's log
 * and on the Steward's page, with since when; an alarm once it has held an hour (alarms.ts, Settings' blockingHours).
 */
export interface QueueHold {
  number: number;
  title: string;
  url: string;
  version: string;
  /** Why it isn't ready: GitHub's say (a draft, its checks), or the merge stage's when it held it this round. */
  why: string;
  draft: boolean;
  /** The ready PRs above it, waiting their turn behind it. */
  behind: number[];
  /** Since when it has held them: the first round that saw it hold the queue. */
  since: string;
}

/** How a PR waits for its turn in the merge stage's words (merge.ts): ready, behind a lower version. */
const TURN_WAIT = /^its turn comes after #\d+/;
/** A PR that gives up its turn (merge.ts's GAVE_WAY, a kit its trial fails): the PRs above it don't wait for it. */
const GIVES_WAY = /gives up its turn/;

/**
 * What holds `queue` (lowest version first), or null when nothing does: the lowest PR that isn't ready, with at least
 * one ready PR above it. `held`: why the merge stage held each PR this round, by number, which says more than GitHub
 * does (a team PR untested, or failing its checks here). `before`: the hold kept from the last round, whose `since`
 * stands while the same PR holds it. Pure.
 */
export function queueHold(queue: QueuedPr[], at: string, o: { held?: Map<number, string>; before?: QueueHold | null } = {}): QueueHold | null {
  const stage = (q: QueuedPr) => o.held?.get(q.number) ?? null;
  const ready = (q: QueuedPr) => {
    const why = stage(q);
    return q.ready && (!why || TURN_WAIT.test(why));
  };
  for (const [i, q] of queue.entries()) {
    if (ready(q)) continue;
    const why = stage(q) ?? q.why ?? 'not ready';
    if (GIVES_WAY.test(why)) continue;
    const behind = queue.slice(i + 1).filter(ready).map((x) => x.number);
    if (!behind.length) return null;
    const since = o.before?.number === q.number ? o.before.since : at;
    return { number: q.number, title: q.title, url: q.url, version: q.version, why, draft: !!q.draft, behind, since };
  }
  return null;
}

/** A queue's hold in words, for the round's log: "#233 (v0.36.41, a draft) holds #266, #268 since …". Pure. */
export const holdWords = (h: QueueHold) => `#${h.number} (v${h.version}, ${h.why}) holds its version queue: ${h.behind.map((n) => `#${n}`).join(', ')} ${h.behind.length === 1 ? 'waits' : 'wait'} behind it, since ${h.since}`;

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
  /** What holds it (queueHold), in a repository the Steward merges in; null or left out when nothing does. */
  held?: QueueHold | null;
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
  /** The Steward merges its PRs, lowest version first: what holds its queue is said. */
  merges: boolean;
}

/** The files a project with none named carries its version in: the first of these found on its branch. */
const GUESSES = ['package.json', 'VERSION'];

export const projectId = (p: ManorProject) => `project:${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** The employees', the Steward's own repository's (`self`, where it merges its own PRs), then Manor's other projects. */
function targetsOf(ctx: Ctx, projects: ManorProject[], self: Employee | null = null): Target[] {
  const employees = self && !ctx.settings.employees.some((e) => e.id === self.id) ? [...ctx.settings.employees, self] : ctx.settings.employees;
  const agents: Target[] = employees.map((e) => ({ id: e.id, name: e.name, kind: 'agent', repo: e.repo, branch: e.branch, checkout: checkoutOf(e), versionFiles: e.versionFiles, prs: hostIs(ctx, e) !== 'git', merges: e.merges }));
  const own = new Set(agents.map((t) => t.checkout.toLowerCase()));
  const sideCars: Target[] = projects
    .filter((p) => !own.has(p.checkout.toLowerCase()))
    .map((p) => ({ id: projectId(p), name: p.name, kind: 'project', repo: p.repo, branch: p.branch, checkout: p.checkout, versionFiles: p.versionFiles, prs: !!p.repo, merges: false }));
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
  const raw = g ? g.prs : JSON.parse((await listOpenPrs(hostFor(ctx, { repo: t.repo }), t.repo)) || '[]');
  const authors = [...new Set(raw.map((p: any) => String(p?.author?.login ?? '')).filter(Boolean))] as string[];
  return parsePrs(JSON.stringify(raw), authors);
}

/**
 * What a PR's head sets, as read at a branch head (with the version files read): kept so a PR that sets no version above
 * the branch's, which the queue doesn't keep, isn't read again each round (a fetch and a merge-base each time).
 */
const prsRead = new Map<string, string | null>();
const PRS_READ_MAX = 2000;

/** The head of the target's branch on GitHub as the round already knows it: its glance's, or remote-heads.json's for a project. */
function knownHead(ctx: Ctx, t: Target, moved: Set<string>): string | null {
  if (!t.prs || !t.repo || moved.has(t.id)) return null;
  if (t.kind === 'agent') return glanceOf(ctx, { id: t.id } as Employee)?.head ?? null;
  return freshRemoteHeads(t.repo)?.[t.branch] ?? null;
}

async function queueOf(ctx: Ctx, t: Target, before: VersionQueue | undefined, at: string, moved: Set<string> = new Set(), held?: Map<number, string>): Promise<VersionQueue> {
  const base: Omit<VersionQueue, 'version' | 'head' | 'files' | 'queue' | 'working' | 'latest' | 'note'> = { id: t.id, name: t.name, kind: t.kind, repo: t.repo, branch: t.branch, at };
  const empty = (note: string, version: string | null = null, head: string | null = null, files: string[] = []): VersionQueue => ({ ...base, version, head, files, queue: [], working: null, latest: null, note });
  if (!existsSync(t.checkout)) return empty(`no checkout at ${t.checkout}`);
  // Its branch as its origin has it, or the clone's own branch when there is no origin to fetch from. Fetched only when
  // GitHub's head is neither the one kept (with its version) nor the clone's already.
  let ref = `origin/${t.branch}`;
  const known = knownHead(ctx, t, moved);
  const kept = !!known && before?.head === known && !!before.version && !!before.files?.length;
  if (!kept && (!known || (await commitOf(ctx.run, t.checkout, ref)) !== known)) {
    try {
      await fetchBranch(ctx.run, t.checkout, t.branch);
    } catch {
      if (!(await commitOf(ctx.run, t.checkout, ref))) ref = t.branch;
    }
  }
  const head = kept ? known : await commitOf(ctx.run, t.checkout, ref);
  if (!head) return empty(`no branch ${t.branch} in ${t.checkout}`);
  // Read again only at a new head: a branch with no version found at this head has none still.
  const same = before?.head === head;
  const v = same && before.version && before.files?.length ? { version: before.version, files: before.files } : same && !before.version && before.note ? { error: before.note } : await versionAt(ctx, t, ref);
  if ('error' in v) return empty(v.error, null, head);
  let prs: PrInfo[];
  try {
    prs = await openPrs(ctx, t);
  } catch (err) {
    return empty(`couldn't list its PRs: ${(err as Error).message}`, v.version, head, v.files);
  }
  const read = new Map((before?.queue ?? []).map((q) => [q.head, q.version]));
  const queue: QueuedPr[] = [];
  for (const pr of prs) {
    if (pr.base !== t.branch || !pr.headOid) continue;
    let sets = read.get(pr.headOid) ?? null;
    const asked = `${t.checkout}\n${head}\n${pr.headOid}\n${v.files.join()}`;
    if (!sets && prsRead.has(asked)) sets = prsRead.get(asked)!;
    else if (!sets) {
      try {
        const p = await prVersions(ctx, { id: t.id, checkout: t.checkout, branch: t.branch, versionFiles: v.files } as Employee, pr);
        sets = p.head && p.head !== p.from ? p.head : null;
        if (prsRead.size >= PRS_READ_MAX) prsRead.clear();
        prsRead.set(asked, sets);
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
  // What holds it, where the Steward merges lowest first; elsewhere the order is the person's.
  const hold = t.merges ? queueHold(queue, at, { held, before: before?.held }) : null;
  return { ...base, version: v.version, head, files: v.files, queue, working: queue[0]?.version ?? null, latest: ready.length ? ready[ready.length - 1].version : null, ...(hold ? { held: hold } : {}), note: null };
}

/**
 * Every repository's queue made again (only what changed is read again), kept, and returned. A repository that can't
 * be read keeps a note saying why; one that fails outright keeps what it had. `moved`: the employees the stage merged or
 * released to after its glance, whose clones are fetched whatever the glance said. `held`: the PRs the merge stage held
 * this round and why, by employee, for what holds each queue (queueHold), which the log says. `self`: the Steward's own
 * repository, as the merge stage's employee, where it merges its own PRs.
 */
export async function keepVersionQueues(ctx: Ctx, o: { projects?: ManorProject[]; now?: () => Date; moved?: Iterable<string>; held?: { employee: Pick<Employee, 'id'>; prs: Pick<Held, 'number' | 'why'>[] }[]; self?: Employee | null } = {}): Promise<VersionQueues> {
  const at = (o.now?.() ?? new Date()).toISOString();
  const moved = new Set(o.moved ?? []);
  const before = new Map(loadVersionQueues().repos.map((r) => [r.id, r]));
  const held = new Map<string, Map<number, string>>();
  for (const h of o.held ?? []) {
    const m = held.get(h.employee.id) ?? new Map<number, string>();
    for (const pr of h.prs) if (!m.has(pr.number)) m.set(pr.number, pr.why);
    held.set(h.employee.id, m);
  }
  let projects: ManorProject[];
  try {
    projects = o.projects ?? manorProjects();
  } catch {
    projects = [];
  }
  const repos: VersionQueue[] = [];
  for (const t of targetsOf(ctx, projects, o.self ?? null)) {
    try {
      const q = await queueOf(ctx, t, before.get(t.id), at, moved, held.get(t.id));
      if (q.held) ctx.log(`[${t.id}] ${holdWords(q.held)}`);
      repos.push(q);
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

/** What holds each queue kept (queueHold), with the repository it holds, for the alarms and the page. */
export interface HeldQueue {
  id: string;
  name: string;
  repo: string;
  branch: string;
  hold: QueueHold;
}

export const heldQueues = (v: VersionQueues): HeldQueue[] => v.repos.flatMap((r) => (r.held && r.repo ? [{ id: r.id, name: r.name, repo: r.repo, branch: r.branch, hold: r.held }] : []));
