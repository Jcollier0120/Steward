import { APP } from '../app.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { LeaseGuard } from '../lease.ts';
import { buildWhen, loadPipeline } from '../pipeline.ts';
import type { Employee } from '../settings.ts';
import { glanceOf, type Ctx } from './common.ts';
import { mergeOne, waitsBriefly } from './merge.ts';
import { apart, withRepo } from './slots.ts';

/**
 * The merge pass ahead of the next build (Steward 0.36.70; before it, from 0.36.67, the next build's tests alone).
 * Between builds, beside the rounds, each repository with ready PRs is merged as the next build would merge it
 * (merge.ts's mergeOne with Ctx's build `ahead`): its ready PRs into its branch, lowest version first, a version queue
 * as its train and a batch stacked and tested once, halved to find the PR that broke it, a kit PR after its trial on
 * every agent, stamped (changes/ fragments) and caught up as in a build, and the PRs it leaves out tried again by the
 * build itself. Nothing is released and nothing rolled out: the merged versions wait on each branch until the build,
 * which merges whatever is left and releases each repository once, its changelog entry bringing the versions merged
 * ahead (release.ts's combined entry); a new kit merged ahead is released, and rolled out, at the build alone.
 *
 * The tests run at the checks' gentle pace (below-normal priority, the kit's checks pace), rather than inside the build
 * while every agent waits; a PR's test, a train's or batch's pass and a kit's trial are kept as before (prtest.ts,
 * standin.ts, trial.ts), so the build only merges what moved since.
 *
 * Never under a build: none starts once the build has begun (a build open in pipeline.json, its time come, or a build
 * round begun in this process: buildBegins), and a pass going on then merges nothing more (its turn guard says no before
 * each merge, push and stamp: lease.ts), so main never moves under an open build. A repository's build round waits for
 * the one being merged ahead, as for any stage (slots.ts). The repositories another PC has its turn in are left to it.
 *
 * The Steward's own repository goes first: its kit's trial on every agent is the longest part of a build. One at a time,
 * one repository after another. What each was looked at at (its glance: its branch's head and its ready PRs' heads, the
 * newest kit and this Steward's version) is kept in build-prepared.json, so a round that finds nothing new looks at
 * nothing; a repository whose PRs waited on something brief (checks running, a kit's trial going on) is looked at again
 * the next round, and any with ready PRs every AGAIN_MS. Only on the Steward's page (preparesBeside): a round in a
 * terminal, and the tests, merge nothing ahead.
 */

export const buildPreparedFile = () => dataFile('build-prepared.json');

/** What a repository was last merged ahead at, by employee id: its key (prepareKey), for which build, when, and what it came to. */
export interface Prepared {
  key: string;
  due: string;
  at: string;
  line: string;
  /** A PR it left waited only on something that settles within minutes (merge.ts's waitsBriefly): looked at again soon. */
  brief?: boolean;
}

/** A repository with ready PRs is looked at again this long after the last time, whatever moved. */
export const AGAIN_MS = 30 * 60_000;

/** A PR as the glance has it (gh pr list's JSON): what says whether it moved. */
type GlancedPr = { number?: number; headRefOid?: string; isDraft?: boolean };

/**
 * What a repository is prepared at: its branch's head and each ready PR's head, with the newest kit (a PR may wait for
 * its kit's release) and this Steward's version. Null when it has no ready PR: nothing to prepare. Pure.
 */
export function prepareKey(o: { head: string | null; prs: GlancedPr[]; kit: string | null; steward?: string }): string | null {
  const ready = o.prs
    .filter((p) => !p.isDraft && typeof p.number === 'number')
    .map((p) => `${p.number}@${p.headRefOid ?? '?'}`)
    .sort();
  if (!ready.length) return null;
  return [o.head ?? '-', ready.join(','), o.kit ?? '-', o.steward ?? APP.version].join('|');
}

/**
 * Of the repositories with their keys now, those to merge ahead: each with ready PRs and a key it wasn't looked at at for
 * this build, or whose PRs waited on something brief, or last looked at AGAIN_MS ago. Pure.
 */
export function toPrepare<T extends { id: string }>(repos: { e: T; key: string | null }[], kept: Record<string, Prepared>, due: string, now = Date.now()): T[] {
  return repos
    .filter((r) => {
      const k = kept[r.e.id];
      if (!r.key) return false;
      if (!(k?.key === r.key && k?.due === due)) return true;
      return !!k.brief || now - Date.parse(k.at) >= AGAIN_MS;
    })
    .map((r) => r.e);
}

/** Set by the Steward's page (agent.ts): merging ahead runs beside the rounds there, its lines to `log`. Unset, nothing is. */
let beside: { log?: (line: string) => void } | null = null;
export const preparesBeside = (o: typeof beside): void => void (beside = o);

/** The merge pass going on beside the rounds in this process: one at a time. */
type Going = { due: string; started: number; done: Promise<void> };
let going: Going | null = null;

/** Settles once the merge pass beside the rounds has ended (at once when none runs). */
export const prepareDone = (): Promise<void> => going?.done ?? Promise.resolve();

/** When a build round last began in this process (buildBegins). */
let buildAt = 0;

/** A build round begins (steward.ts, before it merges anything): the merge pass going on ahead merges nothing more. */
export const buildBegins = (now = Date.now()): void => void (buildAt = now);

/** Whether the build being merged ahead of has begun: a build is open, or its time has come. */
const begun = (next: Date) => {
  const s = loadPipeline();
  return (!!s.open && !s.open.finished) || Date.now() >= next.getTime();
};

/** Whether a pass that started at `started` stops merging: a build round began since, or the build it is ahead of has. */
export const aheadStops = (started: number, next: Date): boolean => buildAt >= started || begun(next);

/**
 * The merge pass's guard before each merge, push and stamp (lease.ts's LeaseGuard): no once it stops (aheadStops), and
 * otherwise the turns it took with this PC's others, where it took any. Pure but for the clock and pipeline.json.
 */
export function aheadGuard(turns: LeaseGuard | null | undefined, stops: () => boolean): LeaseGuard {
  return {
    ok: async (e) => !stops() && (turns ? turns.ok(e) : true),
    get skip() {
      return turns?.skip ?? new Set<string>();
    },
    has: (id) => turns?.has(id) ?? true,
  };
}

/** The turns a merge pass takes with this PC's others (steward.ts): the repositories of `list` that are this PC's now, on `ctx.lease`. */
export type AheadTurns = (ctx: Ctx, list: Employee[]) => Promise<Employee[]>;

/**
 * The merge pass ahead of the next build, started beside the rounds for the repositories with ready PRs that moved since
 * they were last looked at (the Steward's own first), as the module's comment says. Gives back a line for the round's
 * log: what it started, or what goes on; null when there is nothing to merge ahead, or this isn't the Steward's page.
 * Never throws.
 */
export function prepareBeside(ctx: Ctx, o: { next: Date; employees: Employee[]; self: Employee | null; kit: string | null; now?: Date; turns?: AheadTurns }): string | null {
  try {
    if (!beside) return null;
    const now = o.now ?? new Date();
    const name = `the ${buildWhen(o.next, now)} build`;
    if (going) return `the merge pass ahead of ${name} goes on beside the rounds (started ${Math.max(0, Math.round((Date.now() - going.started) / 60_000))} min ago)`;
    if (begun(o.next)) return null;
    const due = o.next.toISOString();
    const repos = [...(o.self ? [o.self] : []), ...o.employees.filter((e) => e.merges)].map((e) => {
      const g = glanceOf(ctx, e);
      return { e, key: g ? prepareKey({ head: g.head, prs: g.prs as GlancedPr[], kit: o.kit }) : null };
    });
    const kept = readJson<Record<string, Prepared>>(buildPreparedFile(), {});
    const list = toPrepare(repos, kept, due, now.getTime());
    if (!list.length) return null;
    const keys = new Map(repos.map((r) => [r.e.id, r.key]));
    const log = beside.log ?? ctx.log;
    const g: Going = { due, started: Date.now(), done: Promise.resolve() };
    const stops = () => aheadStops(g.started, o.next);
    // As a build merges: a ready PR merges at once (merge.ts's ageHold), and nothing releases merge by merge.
    const ahead: Ctx = { ...ctx, log, settings: { ...ctx.settings, mergeMinAgeMinutes: 0, releaseAfterMerge: false }, build: { due, name: `the merge pass ahead of ${name}`, ahead: true }, prepare: null, lease: null };
    going = g;
    g.done = apart('build prep', async () => {
      // Turns with this PC's others first (lease.ts): a repository another PC has its turn in is left to it.
      const mine = o.turns ? await o.turns(ahead, list) : list;
      ahead.lease = aheadGuard(ahead.lease, stops);
      for (const e of mine) {
        if (stops()) {
          log(`${name} has begun: the rest merge in it`);
          break;
        }
        try {
          const r = await withRepo(log, e.id, () => mergeOne(ahead, e, { yes: true, team: true }));
          log(`[${e.id}] ahead of ${name}: ${r.message}`);
          const all = readJson<Record<string, Prepared>>(buildPreparedFile(), {});
          const brief = r.held.some((h) => !h.draft && waitsBriefly(h.why));
          all[e.id] = { key: keys.get(e.id)!, due, at: new Date().toISOString(), line: r.message.slice(0, 500), ...(brief ? { brief } : {}) };
          writeJson(buildPreparedFile(), all);
        } catch (err) {
          log(`[${e.id}] couldn't merge it ahead of ${name}: ${(err as Error).message}`);
        }
      }
    })
      .catch((err: Error) => log(`couldn't merge ahead of ${name}: ${err.message}`))
      .finally(() => {
        if (going === g) going = null;
      });
    return `the merge pass ahead of ${name} begins beside the rounds for ${list.map((e) => e.name).join(', ')}: their ready PRs merge now, and are released at the build`;
  } catch (err) {
    return `couldn't merge ahead of the next build: ${(err as Error).message}`;
  }
}
