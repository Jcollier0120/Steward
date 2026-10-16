import { APP } from '../app.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { buildWhen, loadPipeline } from '../pipeline.ts';
import type { Employee } from '../settings.ts';
import { glanceOf, type Ctx } from './common.ts';
import { mergeOne } from './merge.ts';
import { apart, withRepo } from './slots.ts';

/**
 * The next build prepared between builds (Steward 0.36.67). Between builds nothing merges, so each branch stays where it
 * is, and so does each ready PR until its author pushes to it: the tests a build would run can run before it, at the
 * checks' gentle pace (below-normal priority, the kit's checks pace), rather than inside it while every agent waits.
 *
 * Beside the rounds between builds, each repository whose branch or ready PRs moved since it was last prepared is looked
 * at as the next build will look at it (merge.ts's mergeOne with ctx.prepare): each ready PR GitHub runs no checks on
 * tested at its head, a version queue stacked as its train and tested once, a build's batch stacked and tested once, a
 * kit PR's trial on every agent started. Nothing on GitHub changes but a PR's test status: nothing is merged, pushed,
 * caught up, retargeted, marked ready or released.
 *
 * At the build, the same look finds those results and only merges: a PR's test is kept by its head (prtest.ts, its
 * status the vouch), a train's or batch's pass by its code (standin.ts: the stack the build makes again is the same tree
 * if nothing moved), a kit's trial by its head (trial.ts). Whatever moved since is tested in the build, as before.
 *
 * The Steward's own repository goes first: its kit's trial on every agent is the longest part of a build. One at a time,
 * one repository after another; none started once the build has begun (a repository's build waits for the one being
 * prepared, as for any stage). What each was prepared at (its glance: its branch's head and its ready PRs' heads, the
 * newest kit and this Steward's version) is kept in build-prepared.json, so a round that finds nothing new prepares
 * nothing. Only on the Steward's page (preparesBeside): a round in a terminal, and the tests, prepare nothing.
 */

export const buildPreparedFile = () => dataFile('build-prepared.json');

/** What a repository was last prepared at, by employee id: its key (prepareKey), for which build, when, and what it came to. */
export interface Prepared {
  key: string;
  due: string;
  at: string;
  line: string;
}

/** A PR as the glance has it (gh pr list's JSON): what says whether it moved. */
export type GlancedPr = { number?: number; headRefOid?: string; isDraft?: boolean };

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

/** Of the repositories with their keys now, those to prepare: each with a key it wasn't prepared at for this build. Pure. */
export function toPrepare<T extends { id: string }>(repos: { e: T; key: string | null }[], kept: Record<string, Prepared>, due: string): T[] {
  return repos.filter((r) => r.key && !(kept[r.e.id]?.key === r.key && kept[r.e.id]?.due === due)).map((r) => r.e);
}

/** Whether employee `id`'s repository was tested at `key` for the build at `due` (build-prepared.json). */
export const preparedFor = (id: string, key: string, due: string): boolean => !toPrepare([{ e: { id }, key }], readJson<Record<string, Prepared>>(buildPreparedFile(), {}), due).length;

/** What employee `id`'s repository was tested at for the build at `due`, kept in build-prepared.json. Never throws. */
export function notePrepared(id: string, o: { key: string; due: string; line: string }): void {
  try {
    const all = readJson<Record<string, Prepared>>(buildPreparedFile(), {});
    all[id] = { key: o.key, due: o.due, at: new Date().toISOString(), line: o.line.slice(0, 500) };
    writeJson(buildPreparedFile(), all);
  } catch {
    // Not kept: it is tested again, its results kept by head.
  }
}

/** Set by the Steward's page (agent.ts): preparing runs beside the rounds there, its lines to `log`. Unset, nothing is prepared. */
let beside: { log?: (line: string) => void } | null = null;
export const preparesBeside = (o: typeof beside): void => void (beside = o);

/** The preparing going on beside the rounds in this process: one at a time. */
type Going = { due: string; started: number; done: Promise<void> };
let going: Going | null = null;

/** Settles once the preparing beside the rounds has ended (at once when none runs). */
export const prepareDone = (): Promise<void> => going?.done ?? Promise.resolve();

/** Whether the build being prepared for has begun: a build is open, or its time has come. */
const begun = (next: Date) => {
  const s = loadPipeline();
  return (!!s.open && !s.open.finished) || Date.now() >= next.getTime();
};

/**
 * The next build's tests started beside the rounds, for the repositories that moved since they were last prepared (the
 * Steward's own first), as the module's comment says. Gives back a line for the round's log: what it started, or what
 * goes on; null when there is nothing to prepare, or this isn't the Steward's page. Never throws.
 */
export function prepareBeside(ctx: Ctx, o: { next: Date; employees: Employee[]; self: Employee | null; kit: string | null; now?: Date }): string | null {
  try {
    if (!beside) return null;
    const now = o.now ?? new Date();
    if (going) return `the next build's tests go on beside the rounds (started ${Math.max(0, Math.round((Date.now() - going.started) / 60_000))} min ago)`;
    if (begun(o.next)) return null;
    const due = o.next.toISOString();
    const name = `the ${buildWhen(o.next, now)} build`;
    const repos = [...(o.self ? [o.self] : []), ...o.employees.filter((e) => e.merges)].map((e) => {
      const g = glanceOf(ctx, e);
      return { e, key: g ? prepareKey({ head: g.head, prs: g.prs as GlancedPr[], kit: o.kit }) : null };
    });
    const kept = readJson<Record<string, Prepared>>(buildPreparedFile(), {});
    const list = toPrepare(repos, kept, due);
    if (!list.length) return null;
    const keys = new Map(repos.map((r) => [r.e.id, r.key]));
    const log = beside.log ?? ctx.log;
    // As the build will look: a ready PR merges at once in a build (merge.ts's ageHold), and nothing releases merge by merge.
    const prep: Ctx = { ...ctx, log, settings: { ...ctx.settings, mergeMinAgeMinutes: 0, releaseAfterMerge: false }, build: null, prepare: { due, name } };
    const g: Going = { due, started: Date.now(), done: Promise.resolve() };
    going = g;
    g.done = apart('build prep', async () => {
      for (const e of list) {
        if (begun(o.next)) {
          log(`${name} has begun: the rest of its tests run in it`);
          break;
        }
        try {
          const r = await withRepo(log, e.id, () => mergeOne(prep, e, { yes: true, team: true }));
          log(`[${e.id}] for ${name}: ${r.message}`);
          notePrepared(e.id, { key: keys.get(e.id)!, due, line: r.message });
        } catch (err) {
          log(`[${e.id}] couldn't prepare it for ${name}: ${(err as Error).message}`);
        }
      }
    })
      .catch((err: Error) => log(`couldn't prepare ${name}: ${err.message}`))
      .finally(() => {
        if (going === g) going = null;
      });
    return `${name}'s tests begin beside the rounds for ${list.map((e) => e.name).join(', ')}: nothing merges until it comes`;
  } catch (err) {
    return `couldn't prepare the next build: ${(err as Error).message}`;
  }
}
