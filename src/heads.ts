import { EventEmitter } from 'node:events';
import { clock, gate, GithubLimited, loadBudget, noteLimited, noteReading, readingFrom, saveBudget, type BudgetState } from './budget.ts';
import { apiAsk, moreHeads, moreHeadsQuery, headsFromGraph, type Glance, type GlanceAsk } from './glance.ts';
import { duty } from './kit/duty.ts';
import { readRemoteHeads, remoteHeadsFile, remoteKey, shareRemoteHeads } from './kit/remote-heads.ts';
import { stewardActs } from './maker.ts';
import { hostOf, loadScm } from './scm.ts';
import { loadSettings, selfRepoOf, type Settings } from './settings.ts';

/**
 * The manor's branch heads kept fresh between rounds (Steward 0.36.25): remote-heads.json in Manor's folder (the kit's
 * remote-heads.ts), which other agents read rather than ask GitHub themselves. Reeve brings each clone's main up to
 * GitHub's as soon as it moves there, from these heads.
 *
 * The round's glance shares them as it starts. A round can take hours (a kit trial's checks on a busy PC: on
 * 2026-10-14 none ended between 17:38 and 19:48), and the heads went stale after 20 minutes (FRESH_MS), so the agents
 * asked GitHub themselves again, and Reeve couldn't tell a clone was behind. So, beside the rounds, the Steward's page
 * reads every branch head of its repositories on GitHub on its own: every HEADS_EVERY_MS, unless a round's glance just
 * did; and HEADS_AFTER_MERGE_MS after each merge it makes, the merged repository's. Only the heads: one GraphQL query
 * for all of them (about a point of GitHub's 5,000 an hour), no PRs, no releases, nothing of the round's.
 *
 * Only while the Steward builds and releases by itself (Settings), on duty: a Steward that only keeps the staff's pages
 * up asks GitHub nothing, and neither does this. Never into the budget's spare tenth (budget.ts).
 */

/** How often the heads are read between rounds. */
export const HEADS_EVERY_MS = 5 * 60_000;
/** How long after a merge its repository's heads are read: GitHub deletes the merged branch a moment after. */
export const HEADS_AFTER_MERGE_MS = 10_000;
/** How many repositories one query reads: a page of 100 heads each, a point for the lot. */
const PER_QUERY = 50;

/** The GitHub repositories (owner/name) whose heads are shared: the employees' on GitHub, and the Steward's own. */
export function githubRepos(s: Settings, look = loadScm()): string[] {
  const seen = new Set<string>();
  const all = [...s.employees.filter((e) => hostOf(e, s, look) === 'github').map((e) => e.repo), selfRepoOf(s)];
  return all.filter((r) => !!r && /^[^/\s]+\/[^/\s]+$/.test(r) && !seen.has(r.toLowerCase()) && !!seen.add(r.toLowerCase()));
}

/**
 * Every branch head of these repositories on GitHub, as a glance reads them (headsFromGraph, and moreHeads for one
 * with more than a page). A repository GitHub gives no answer for is in `errors`. Throws when GitHub can't be asked.
 */
export async function readHeads(repos: string[], ask: GlanceAsk, now: () => Date = () => new Date()): Promise<Glance> {
  const glance: Glance = { at: now().toISOString(), stewardReleases: null, repos: {}, errors: {}, heads: {} };
  const more = new Map<string, string>();
  for (let i = 0; i < repos.length; i += PER_QUERY) {
    const chunk = repos.slice(i, i + PER_QUERY);
    const data = JSON.parse(await ask(moreHeadsQuery(chunk.map((repo) => ({ repo })))))?.data;
    const rate = readingFrom(data?.rateLimit, now());
    if (rate) glance.rates = [...(glance.rates ?? []), rate];
    if (typeof data?.rateLimit?.cost === 'number') glance.cost = (glance.cost ?? 0) + data.rateLimit.cost;
    chunk.forEach((repo, j) => {
      const h = headsFromGraph(data?.[`h${j}`]);
      if (!h) {
        glance.errors[repo] = 'GitHub gave no branches';
        return;
      }
      glance.heads![repo] = { heads: h.heads, complete: h.complete };
      if (h.after) more.set(repo, h.after);
    });
  }
  await moreHeads(ask, glance, more, now);
  return glance;
}

/** Whether every one of these repositories' shared heads was read within `ms`. */
export function sharedWithin(repos: string[], ms: number, now: Date, file = remoteHeadsFile()): boolean {
  const all = readRemoteHeads(file);
  return repos.every((r) => {
    const at = Date.parse(all[remoteKey(r) ?? '']?.at ?? '');
    return Number.isFinite(at) && now.getTime() - at < ms;
  });
}

export interface HeadsLook {
  /** The repositories whose heads were shared. */
  shared: string[];
  /** Why none were read: fresh enough, GitHub's budget, GitHub refusing the account. */
  skipped?: string;
  /** Repositories GitHub gave no answer for. */
  errors?: Record<string, string>;
}

/**
 * One look: these repositories' heads (default: all of githubRepos) read and shared, unless the shared ones are all
 * younger than half of HEADS_EVERY_MS (a round's glance just read them) or `force` (a merge). Never throws.
 */
export async function lookAtHeads(o: { settings?: Settings; repos?: string[]; force?: boolean; ask?: GlanceAsk; now?: () => Date; file?: string } = {}): Promise<HeadsLook> {
  const now = o.now ?? (() => new Date());
  const all = githubRepos(o.settings ?? loadSettings());
  // Asked for by name (a merge): only those of all, so a repository not on GitHub is never asked of it.
  const repos = o.repos ? all.filter((r) => o.repos!.some((x) => x.toLowerCase() === r.toLowerCase())) : all;
  if (!repos.length) return { shared: [], skipped: 'no repository on GitHub' };
  if (!o.force && sharedWithin(repos, HEADS_EVERY_MS / 2, now(), o.file)) return { shared: [], skipped: 'shared a moment ago' };
  const g = gate(loadBudget(), 1, now(), { paced: true });
  if (!g.go) return { shared: [], skipped: `GitHub's API budget: ${g.why}, until ${clock(g.until)}` };
  let read: Glance;
  try {
    read = await readHeads(repos, o.ask ?? apiAsk(), now);
  } catch (e) {
    if (e instanceof GithubLimited) {
      const s = noteLimited(loadBudget(), { now: now(), secondary: e.secondary, why: `GitHub refused the account (${e.message})` });
      saveBudget(s);
      return { shared: [], skipped: `GitHub's API limit is reached (${e.message}): nothing is asked of GitHub until ${clock(s.limitedUntil!)}` };
    }
    return { shared: [], skipped: `couldn't ask GitHub (${(e as Error).message})` };
  }
  // What GitHub said is left, as a glance's (budget.ts), but not its cost: the round's estimate stays the round's glance's.
  if (read.rates?.length) saveBudget(read.rates.reduce<BudgetState>((s, r) => noteReading(s, r, now()), { ...loadBudget(), limitedUntil: null, limitedWhy: null }));
  try {
    shareRemoteHeads(read.heads ?? {}, { now: now(), file: o.file });
  } catch (e) {
    return { shared: [], skipped: `couldn't share the branch heads (${(e as Error).message})`, errors: read.errors };
  }
  return { shared: Object.keys(read.heads ?? {}), ...(Object.keys(read.errors).length ? { errors: read.errors } : {}) };
}

const merges = new EventEmitter();

/** The Steward merged a PR of this repository (owner/name): its heads are read again HEADS_AFTER_MERGE_MS after. */
export function headsMoved(repo: string): void {
  merges.emit('merged', repo);
}

/**
 * The page's keeping of the heads: a look every `everyMs`, and the merged repositories' a moment after each merge,
 * one look at a time (merges during one are looked at after it). Only on duty, while the Steward acts here and merges
 * by itself (`may`). Returns a stop function.
 */
export function keepHeads(o: { look?: typeof lookAtHeads; may?: () => boolean; log?: (line: string) => void; everyMs?: number; afterMergeMs?: number } = {}): () => void {
  const look = o.look ?? lookAtHeads;
  const may = o.may ?? (() => duty().onDuty && stewardActs() && loadSettings().byItself);
  const log = o.log ?? (() => {});
  const pending = new Set<string>();
  let running = false;
  let soon: NodeJS.Timeout | null = null;
  let lastSkip = '';
  const go = async (repos?: string[]) => {
    if (!may()) return;
    if (running) {
      for (const r of repos ?? []) pending.add(r);
      return;
    }
    running = true;
    try {
      const r = await look(repos ? { repos, force: true } : {});
      // What went wrong, once, not every few minutes; a share after a merge, by name.
      const skip = r.skipped && r.skipped !== 'shared a moment ago' ? r.skipped : '';
      if (skip && skip !== lastSkip) log(`branch heads not read: ${skip}`);
      lastSkip = skip;
      if (repos && r.shared.length) log(`branch heads shared after the merge: ${r.shared.join(', ')}`);
      for (const [repo, why] of Object.entries(r.errors ?? {})) log(`[${repo}] GitHub gave no branch heads (${why})`);
    } catch (e) {
      log(`branch heads not read: ${(e as Error).message}`);
    } finally {
      running = false;
      if (pending.size) later();
    }
  };
  const later = () => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = null;
      const repos = [...pending];
      pending.clear();
      void go(repos);
    }, o.afterMergeMs ?? HEADS_AFTER_MERGE_MS);
    soon.unref();
  };
  const onMerged = (repo: string) => {
    pending.add(repo);
    if (!running) later();
  };
  merges.on('merged', onMerged);
  const timer = setInterval(() => void go(), o.everyMs ?? HEADS_EVERY_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (soon) clearTimeout(soon);
    merges.off('merged', onMerged);
  };
}
