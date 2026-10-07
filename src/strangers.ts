import { existsSync } from 'node:fs';
import type { Alarm, AlarmState, Condition } from './alarms.ts';
import type { Glance } from './glance.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { releasedHere, type Employee } from './settings.ts';
import { checkoutOf, freshBranch, type Ctx } from './stages/common.ts';

/**
 * Another Steward at work on this one's repositories: on the PC that releases Castellan (releasesCastellan), an alarm
 * when the Steward's own PRs are merged, or its employees released, by something that isn't this Steward. On
 * 2026-10-07 a second Steward, on another PC signed in to gh as the same account, merged this one's kit PRs seconds
 * after they opened (Porter#65 opened 18:59:20, merged 18:59:39) and released the staff without the Exchequer, all day;
 * this Steward's rounds only said "nothing new on GitHub since the last round".
 *
 * Seen from what a round already has, with nothing more asked of GitHub:
 * - this Steward notes what it does itself, as it does it (acted.json): each PR it opens (stages/push.ts), each it
 *   merges (stages/merge.ts), each release it makes (stages/release.ts), whichever stage or button ran it;
 * - each round's glance lists the Steward's open PRs (steward/…), which are watched with their head commit. One that is
 *   no longer open, and whose head is now in its employee's branch (git, in the checkout here), was merged; if not by
 *   this Steward, by someone else. One closed without merging is let go;
 * - each round's glance lists each employee's releases. A new v<x.y.z> that this Steward didn't make was made by someone
 *   else. The first round that looks only learns what is there: an update raises nothing.
 *
 * What a person does by hand and marks as theirs is never counted: before or after, `steward mine <employee>
 * <#pr | v<x.y.z>>` (cli.ts); or Dismiss on the alarm, which takes everything it names as known, so only a merge or
 * release seen after it raises it again. It clears by itself a day after the last one seen.
 */

export const actedFile = () => dataFile('acted.json');

/** What the alarm names: a merge of one of the Steward's PRs, or a release, that this Steward didn't make. */
export interface Stranger {
  kind: 'merge' | 'release';
  /** The employee's id and name, and its repository. */
  id: string;
  name: string;
  repo: string;
  /** "#65", or "v0.5.13". */
  ref: string;
  url: string;
  /** When a round of this Steward saw it. */
  seen: string;
}

export interface Acted {
  /** The Steward's open PRs, by "<repo>#<n>": whose, their head commit, and when last opened or seen open. */
  watching: Record<string, { id: string; head: string; url: string; seen: string }>;
  /** What this Steward merged ("<repo>#<n>") and released ("<id>:v<x.y.z>") itself, and when. */
  merged: Record<string, string>;
  released: Record<string, string>;
  /** What a person marked as theirs (steward mine), the same keys, and when. */
  mine: Record<string, string>;
  /** Each employee's releases (v<x.y.z>) as the last round saw them: a new one is judged against these. */
  known: Record<string, string[]>;
  strangers: Stranger[];
  /** The alarm was dismissed then: what was seen until then is taken as known. */
  ackedAt: string | null;
}

const DAY = 24 * 3_600_000;
/** How long the alarm stands after the last merge or release seen. */
export const STRANGER_HOURS = 24;
/** How long what was done (merged, released, mine) and what was seen are remembered. */
const KEEP_MS = 30 * DAY;
const VERSION_TAG = /^v\d+\.\d+\.\d+$/;

export const prKey = (repo: string, n: number | string) => `${repo}#${n}`;
export const releaseKey = (id: string, tag: string) => `${id}:${tag}`;
/** A stranger's key, as what this Steward did and what a person marked are kept. */
const keyOf = (s: Stranger) => (s.kind === 'merge' ? prKey(s.repo, s.ref.slice(1)) : releaseKey(s.id, s.ref));

export const emptyActed = (): Acted => ({ watching: {}, merged: {}, released: {}, mine: {}, known: {}, strangers: [], ackedAt: null });
export const loadActed = (): Acted => ({ ...emptyActed(), ...readJson<Partial<Acted>>(actedFile(), {}) });

/** Notes something this Steward did. Never throws: a note that couldn't be kept never fails what it notes. */
function note(change: (a: Acted, at: string) => void, now = new Date()): void {
  try {
    const a = loadActed();
    change(a, now.toISOString());
    writeJson(actedFile(), a);
  } catch {
    // Only the alarm misses it then.
  }
}

/** A PR this Steward opened (or found open) on its own branch, at this head. */
export function noteOpened(e: Pick<Employee, 'id' | 'repo'>, url: string, head: string, now?: Date): void {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  if (!n || !head) return;
  note((a, at) => void (a.watching[prKey(e.repo, n)] = { id: e.id, head, url, seen: at }), now);
}

/** A PR this Steward merged. */
export const noteMerged = (e: Pick<Employee, 'repo'>, n: number, now?: Date) => note((a, at) => void (a.merged[prKey(e.repo, n)] = at), now);

/** A release this Steward made. */
export const noteReleased = (e: Pick<Employee, 'id'>, version: string, now?: Date) => note((a, at) => void (a.released[releaseKey(e.id, `v${version}`)] = at), now);

/**
 * What a person did, or will do, by hand: "#65" (a PR of the employee's repository) or "v0.5.13" (its release), or
 * an error. It is never counted, and an alarm that named it drops it.
 */
export function markMine(e: Pick<Employee, 'id' | 'repo'>, ref: string, now = new Date()): { key: string } | { error: string } {
  const pr = /^#?(\d+)$/.exec(ref.trim());
  const rel = /^v?(\d+\.\d+\.\d+)$/.exec(ref.trim());
  const key = pr ? prKey(e.repo, pr[1]) : rel ? releaseKey(e.id, `v${rel[1]}`) : null;
  if (!key) return { error: `${ref} is neither a PR (#65) nor a release (v0.5.13)` };
  const a = loadActed();
  a.mine[key] = now.toISOString();
  writeJson(actedFile(), a);
  return { key };
}

/** Whether a PR's head commit is now in its employee's branch: true, false, or null when that can't be told here. */
export type MergedProbe = (e: Employee, head: string) => Promise<boolean | null>;

/**
 * The probe through the checkout here: its branch fetched only when the glance says it moved (common.ts's
 * freshBranch), then `git merge-base --is-ancestor`. No checkout, or a fetch that failed: null, asked again next round.
 */
export function gitProbe(ctx: Ctx): MergedProbe {
  return async (e, head) => {
    const repo = checkoutOf(e);
    if (!existsSync(repo)) return null;
    try {
      if (!(await freshBranch(ctx, e, repo))) return null;
    } catch {
      return null;
    }
    const r = await ctx.run('git', ['merge-base', '--is-ancestor', head, `origin/${e.branch}`], { cwd: repo, timeoutMs: 60_000 });
    // 1: not in it; 128: a commit never fetched here, so never merged into the branch fetched.
    return r.code === 0;
  };
}

/**
 * The round's look (see above): `acted` after this round's glance, with what it newly saw of someone else's. Only the
 * employees the glance still says how they are (one this round merged or released is looked at next round), and only
 * PRs watched before the glance was taken (one opened during this round isn't in it). Pure but for `merged`.
 */
export async function judge(o: { acted: Acted; glance: Glance; employees: Employee[]; merged: MergedProbe; now: Date; elsewhere?: Set<string> }): Promise<Acted> {
  const a: Acted = structuredClone(o.acted);
  const at = o.now.toISOString();
  const taken = Date.parse(o.glance.at);
  const ours = (k: string) => k in a.merged || k in a.released || k in a.mine;
  for (const e of o.employees) {
    const g = o.glance.repos[e.id];
    if (!g) continue;
    // Another PC has its turn here (lease.ts): what it merges and releases is its own, never a stranger's.
    // Only learnt, so the round that takes the turn back judges from then on.
    if (o.elsewhere?.has(e.id)) {
      for (const [k, w] of Object.entries(a.watching)) if (w.id === e.id) delete a.watching[k];
      a.known[e.id] = g.releases.filter((r) => !r.isDraft && VERSION_TAG.test(r.tagName)).map((r) => r.tagName);
      continue;
    }
    // The Steward's PRs open now: watched, at their head.
    const open = new Set<string>();
    for (const p of g.prs) {
      if (typeof p?.headRefName !== 'string' || !p.headRefName.startsWith('steward/') || p.isCrossRepository !== false) continue;
      const k = prKey(e.repo, p.number);
      open.add(k);
      a.watching[k] = { id: e.id, head: String(p.headRefOid ?? a.watching[k]?.head ?? ''), url: String(p.url ?? ''), seen: at };
    }
    // Those watched before this glance and no longer open: merged, or closed.
    for (const [k, w] of Object.entries(a.watching)) {
      if (w.id !== e.id || open.has(k) || Date.parse(w.seen) >= taken) continue;
      if (ours(k)) {
        delete a.watching[k];
        continue;
      }
      const merged = w.head ? await o.merged(e, w.head) : false;
      if (merged === null) continue;
      delete a.watching[k];
      if (merged) a.strangers.push({ kind: 'merge', id: e.id, name: e.name, repo: e.repo, ref: `#${k.slice(k.lastIndexOf('#') + 1)}`, url: w.url, seen: at });
    }
    // Its releases: a new one this Steward didn't make. The first look only learns them. Not one the Steward never
    // publishes (no way to release it in Settings, or built and installed here alone): any release of that is a person's.
    if (!e.release || releasedHere(e)) {
      delete a.known[e.id];
      continue;
    }
    const tags = g.releases.filter((r) => !r.isDraft && VERSION_TAG.test(r.tagName)).map((r) => r.tagName);
    const known = a.known[e.id];
    if (known) {
      for (const t of tags) {
        if (known.includes(t) || ours(releaseKey(e.id, t))) continue;
        a.strangers.push({ kind: 'release', id: e.id, name: e.name, repo: e.repo, ref: t, url: `https://github.com/${e.repo}/releases/tag/${t}`, seen: at });
      }
    }
    a.known[e.id] = tags;
  }
  return prune(a, o.employees, o.now);
}

/** What is past keeping let go: an employee no longer looked after, and what is older than a month. Pure. */
export function prune(a: Acted, employees: Pick<Employee, 'id'>[], now: Date): Acted {
  const ids = new Set(employees.map((e) => e.id));
  const fresh = (t: string) => now.getTime() - Date.parse(t) < KEEP_MS;
  const keep = <T>(r: Record<string, T>, when: (v: T) => string) => Object.fromEntries(Object.entries(r).filter(([, v]) => fresh(when(v))));
  return {
    watching: Object.fromEntries(Object.entries(keep(a.watching, (w) => w.seen)).filter(([, w]) => ids.has(w.id))),
    merged: keep(a.merged, (t) => t),
    released: keep(a.released, (t) => t),
    mine: keep(a.mine, (t) => t),
    known: Object.fromEntries(Object.entries(a.known).filter(([id]) => ids.has(id))),
    strangers: a.strangers.filter((s) => fresh(s.seen)),
    ackedAt: a.ackedAt,
  };
}

const ALARM = 'strangers:';

/** The alarm dismissed: what it named is taken as known (Acted.ackedAt). Pure. */
export function withAck(a: Acted, alarms: Pick<AlarmState, 'open'>): Acted {
  const dismissed = alarms.open.filter((x: Alarm) => x.id.startsWith(ALARM) && x.dismissedAt).map((x) => x.dismissedAt!);
  const latest = [a.ackedAt, ...dismissed].filter((t): t is string => !!t).sort().pop() ?? null;
  return latest === a.ackedAt ? a : { ...a, ackedAt: latest };
}

/** "Porter, Clerk and Smith". */
const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** "Porter #65, Clerk #58", up to `max`, then how many more. */
function listed(list: Stranger[], max = 12): string {
  const words = list.slice(0, max).map((s) => `${s.name} ${s.ref}`);
  return `${words.join(', ')}${list.length > max ? `, and ${list.length - max} more` : ''}`;
}

/**
 * The alarm, at once, or none: the merges and releases of someone else's still counted (not marked as a person's, not
 * seen before a dismissal), in one run of them each less than a day after the one before, the last less than a day
 * ago. Its id is the run's first: the same alarm while the run goes on, and a new one for a run after a dismissal. Pure.
 */
export function strangerConditions(a: Acted, now: Date): Condition[] {
  const counted = a.strangers
    .filter((s) => !(keyOf(s) in a.mine) && (!a.ackedAt || Date.parse(s.seen) > Date.parse(a.ackedAt)))
    .sort((x, y) => Date.parse(x.seen) - Date.parse(y.seen));
  if (!counted.length) return [];
  const last = counted[counted.length - 1];
  if (now.getTime() - Date.parse(last.seen) >= STRANGER_HOURS * 3_600_000) return [];
  let first = counted.length - 1;
  while (first > 0 && Date.parse(counted[first].seen) - Date.parse(counted[first - 1].seen) < STRANGER_HOURS * 3_600_000) first--;
  const run = counted.slice(first);
  const merges = run.filter((s) => s.kind === 'merge');
  const releases = run.filter((s) => s.kind === 'release');
  const repos = [...new Set(run.map((s) => s.name))];
  const doing = merges.length && releases.length ? 'merging and releasing' : merges.length ? 'merging' : 'releasing';
  return [
    {
      id: `${ALARM}${run[0].seen}`,
      who: 'steward',
      title: `Another Steward or person seems to be ${doing} ${names(repos.length > 6 ? [...repos.slice(0, 5), `${repos.length - 5} more`] : repos)}: no round here did`,
      detail: [
        ...(merges.length ? [`The Steward's PRs merged without it: ${listed(merges)}.`] : []),
        ...(releases.length ? [`Released without it: ${listed(releases)}.`] : []),
        'No round of this Steward merged or released these. Most likely another PC runs a Steward signed in to gh as the same GitHub account: switch off its duty there (or uninstall it), since only this PC releases Castellan.',
        `Did you do these yourself? Dismiss this: they are taken as yours, and only a new one raises it again. Before doing one by hand, mark it as yours: node src\\cli.ts mine ${run[0].id} ${run[0].ref}.`,
      ],
      url: run[run.length - 1].url,
      since: run[0].seen,
      afterMs: 0,
    },
  ];
}

/**
 * The round's look, kept (acted.json), and its alarm: the look only on the PC that releases Castellan, in a round that
 * asked GitHub (a glance); the alarm from what is kept, so a round offline doesn't clear it. Never throws.
 */
export async function lookForStrangers(o: { ctx: Ctx; glance: Glance | null | undefined; alarms: Pick<AlarmState, 'open'>; now?: Date; merged?: MergedProbe }): Promise<Condition[]> {
  const { ctx } = o;
  if (!ctx.settings.releasesCastellan) return [];
  const now = o.now ?? new Date();
  try {
    let a = withAck(loadActed(), o.alarms);
    if (o.glance) a = await judge({ acted: a, glance: o.glance, employees: ctx.settings.employees, merged: o.merged ?? gitProbe(ctx), now, elsewhere: ctx.lease?.skip });
    writeJson(actedFile(), a);
    return strangerConditions(a, now);
  } catch (e) {
    ctx.log(`strangers: ${(e as Error).message}`);
    return [];
  }
}
