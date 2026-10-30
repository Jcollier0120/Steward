import { showFile } from './git.ts';
import { loadAlarms, sameAlarms, watchAlarms, type Alarm, type AlarmState } from './alarms.ts';
import { gate, LIMITED, loadBudget, noteLimited, saveBudget } from './budget.ts';
import { hostFor, type Answer } from './hosts/index.ts';
import { readJson, writeJson } from './kit/store.ts';
import { OWNER_DONE_LABEL, passedLines } from './passover.ts';
import type { Runner } from './run.ts';
import type { Host } from './scm.ts';
import { releasedHere, selfRepoOf, type Employee, type Settings } from './settings.ts';
import { checkoutOf, mapLimit, type StageResult } from './stages/common.ts';
import { loadRefreshFailures, refreshFailedFile } from './stages/refresh.ts';
import { loadRolloutFailures, rolloutFailedFile } from './stages/rollout.ts';
import { roundFailuresFile } from './stages/round.ts';
import { loadSelfFailures, selfFailedFile } from './stages/self.ts';
import { keptAlarmSources, loadStaff } from './steward.ts';
import { loadActed, strangerConditions, withAck } from './strangers.ts';
import { clearTastingHold, loadTastingHolds } from './tasting.ts';
import { readVersion } from './versions.ts';

/**
 * The alarms looked at again between rounds (POST /api/alarms/recheck): Manor asks when the person comes back to its page
 * or presses one of its buttons, so what the person has just done (released by hand, merged the PR passed over, updated
 * the guard) clears its alarm then, not at the next round, up to ten minutes later. Never a round: nothing is merged,
 * released, filed or tried.
 *
 * - What can be built again without GitHub is (watchAlarms with `rebuilt`): the files the last round's stages left,
 *   and fresh reads of the pages on this PC (the Wright's work, the Bailiff's reviews, and Manor's and its agents' where
 *   the Steward keeps the manor-wide alarms). What only a round can say (it couldn't run, a kit waiting for the Steward,
 *   a kit's trial, the ports) stands as it was.
 * - Each GitHub-backed alarm open and not dismissed gets one cheap look at its subject (lookOf): a release, a PR's state,
 *   a branch's head. One the look settles is let go in its stage's file as the round would let it go, so the next round
 *   doesn't raise it again: a release made since, a branch moved since (what a failed bump or refresh asks for), a PR
 *   passed over that is merged, closed, labelled owner-done or ready now (and the staff's table refreshed).
 * - GitHub is looked at no more than once a minute (LOOK_EVERY_MS), within its API budget (budget.ts), and not while a
 *   stage runs: a round reading those files meanwhile would put back what the look let go.
 *
 * alarms.json is written only when that changed something.
 */

/** At most one look at GitHub this often, however often Manor asks. */
export const LOOK_EVERY_MS = 60_000;

/** How long Manor's ask is held for the answer: a look that takes longer goes on, and the answer says so. */
export const ANSWER_WITHIN_MS = 15_000;

/** The kinds a recheck builds again (alarms.ts asRechecked): all but what only a round can say. */
export const rebuilt = (id: string) => !/^(?:round$|rollout:waits:|kittrial:|port:|port-plan:)/.test(id);

/** A look's answer: settled, still so, or GitHub couldn't say (refused for its limit: no more looks this time). */
type Said = boolean | null | 'limited';

/** One open alarm a look at GitHub can settle: the look, and what is let go once it says settled. */
interface Subject {
  alarm: Alarm;
  look: () => Promise<Said>;
  settle: () => void;
}

interface LookOptions {
  settings: Settings;
  run: Runner;
  neutralDir: string;
  /** How each repository is worked with (scm.ts); not given: GitHub's way. */
  host?: (e: Pick<Employee, 'repo'>) => Host;
}

/** A host's answer, as a look reads it: found (0), not found, or refused for GitHub's limit. */
const found = (a: Answer): Said => (a.code === 0 ? true : LIMITED.test(`${a.err}\n${a.out}`) ? 'limited' : false);

/** The record in a stage's file let go, only while it is still the one the alarm named. */
function letGo<T>(file: string, key: string, still: (v: T) => boolean): void {
  const all = readJson<Record<string, T>>(file, {});
  if (!(key in all) || !still(all[key])) return;
  delete all[key];
  writeJson(file, all);
}

/** The commit `origin` has for the employee's branch, asked of the remote itself (git, no API); null when it can't say. */
async function remoteHead(o: LookOptions, e: Employee): Promise<string | null> {
  const r = await o.run('git', ['ls-remote', 'origin', `refs/heads/${e.branch}`], { cwd: checkoutOf(e), timeoutMs: 30_000 }).catch(() => null);
  return r?.code === 0 ? r.out.trim().split(/\s+/)[0] || null : null;
}

/** The look for one open alarm, by its kind; null for an alarm no look settles. */
export function lookOf(a: Alarm, o: LookOptions): Subject | null {
  const [kind, ...rest] = a.id.split(':');
  const employee = (id: string) => o.settings.employees.find((e) => e.id === id) ?? null;
  const onGithub = (e: Pick<Employee, 'repo'>) => (o.host?.(e) ?? 'github') !== 'git';
  const host = (e: Pick<Employee, 'repo'>) => hostFor({ run: o.run, neutralDir: o.neutralDir, host: o.host }, e);
  const moved = (e: Employee, from: string) => async (): Promise<Said> => {
    const head = await remoteHead(o, e);
    return head === null ? null : !!from && !head.startsWith(from) && !from.startsWith(head);
  };
  if (kind === 'release' && rest.length === 2) {
    // A release the rounds gave up on: made since, by a person or a Release on the page (round.ts lets it go then too).
    const [id, commit] = rest;
    const e = employee(id);
    if (!e || releasedHere(e) || !e.versionFiles.length || !onGithub(e)) return null;
    return {
      alarm: a,
      look: async () => {
        const text = await showFile(o.run, checkoutOf(e), commit, e.versionFiles[0]);
        const v = text === null ? null : readVersion(e.versionFiles[0], text);
        return v ? found(await host(e).viewRelease(e.repo, `v${v}`, 'tagName')) : null;
      },
      settle: () => letGo<string>(roundFailuresFile(), id, (c) => c === commit),
    };
  }
  if (kind === 'tasting' && rest.length === 3) {
    // A release the Assayer's check held: made since.
    const [id, commit, version] = rest;
    const e = employee(id);
    if (!e || !onGithub(e)) return null;
    return {
      alarm: a,
      look: async () => found(await host(e).viewRelease(e.repo, `v${version}`, 'tagName')),
      settle: () => {
        const h = loadTastingHolds()[id];
        if (h && h.version === version && h.commit.startsWith(commit)) clearTastingHold(id);
      },
    };
  }
  if (kind === 'self' && rest.length === 2) {
    // One of the Steward's own releases: made since (self.ts lets a tag released since go too).
    const [tag, commit] = rest;
    const repo = selfRepoOf(o.settings);
    if (!repo || !onGithub({ repo })) return null;
    return {
      alarm: a,
      look: async () => found(await host({ repo }).viewRelease(repo, tag, 'tagName')),
      settle: () => letGo<{ commit: string }>(selfFailedFile(), tag, (f) => f.commit.startsWith(commit)),
    };
  }
  if (kind === 'rollout' && rest.length === 2) {
    // A bump or push to a kit the rounds won't try again until its branch moves: moved (rollout.ts lets it go then too).
    const [id, kit] = rest;
    const e = employee(id);
    const f = loadRolloutFailures()[id];
    if (!e || !f || f.kit !== kit) return null;
    return { alarm: a, look: moved(e, f.head), settle: () => letGo<{ kit: string; head: string }>(rolloutFailedFile(), id, (x) => x.kit === kit && x.head === f.head) };
  }
  if (kind === 'refresh' && rest.length === 2) {
    // A refresh that failed, which asks for the fix to be pushed: pushed since. The next release's refresh tells again.
    const [id] = rest;
    const e = employee(id);
    const f = loadRefreshFailures()[id];
    if (!e || !f?.commit) return null;
    return { alarm: a, look: moved(e, f.commit), settle: () => letGo<{ commit: string }>(refreshFailedFile(), id, (x) => x.commit === f.commit) };
  }
  if (kind === 'passedover') {
    // A PR passed over: merged or closed since, or what held it is gone (labelled owner-done, or ready for review).
    const m = /^passedover:(.+)#(\d+)$/.exec(a.id);
    const line = m ? passedLines(loadStaff()?.rows ?? []).find((l) => l.repo.toLowerCase() === m[1] && l.pr === Number(m[2])) : undefined;
    if (!line || !onGithub(line)) return null;
    return {
      alarm: a,
      look: async () => {
        const r = await host(line).viewPr(line.repo, line.pr, 'state,isDraft,labels');
        if (r.code !== 0) return found(r) === 'limited' ? 'limited' : null;
        const p = JSON.parse(r.out) as { state?: string; isDraft?: boolean; labels?: { name?: string }[] };
        if (p.state !== 'OPEN') return true;
        if (line.kind === 'owner') return (p.labels ?? []).some((l) => l.name === OWNER_DONE_LABEL);
        return line.kind === 'draft' && p.isDraft === false;
      },
      // The staff's table says it is open still until it is made again: the caller has it refreshed.
      settle: () => {},
    };
  }
  return null;
}

/** A round that did nothing: what the conditions read of the round when there is none. */
const noRound = (at: string): StageResult => ({ stage: 'round', started: at, finished: at, kit: null, asked: {}, results: [], log: [] });

/**
 * The recheck, as the module's comment says: `look`, whether GitHub may be looked at now. What it looked at and let go,
 * and whether alarms.json changed. `deps` stand in for the pages, the toast and the clock (watchAlarms').
 */
export async function recheckAlarms(
  o: LookOptions & { log: (line: string) => void; look: boolean; refreshStaff?: () => void },
  deps: Omit<NonNullable<Parameters<typeof watchAlarms>[1]>, 'rebuilt'> = {},
): Promise<{ looked: string[]; settled: string[]; changed: boolean }> {
  const s = o.settings;
  const none = { looked: [], settled: [], changed: false };
  if (!s.alarms.on) return none;
  const now = deps.now ?? new Date();
  const before: AlarmState = loadAlarms();
  const subjects = o.look ? before.open.filter((a) => !a.dismissedAt).flatMap((a) => lookOf(a, o) ?? []) : [];
  const looked: string[] = [];
  const settled: string[] = [];
  if (subjects.length && gate(loadBudget(), subjects.length, now, { paced: true }).go) {
    let limited = false;
    await mapLimit(subjects, 4, async (x) => {
      if (limited) return;
      looked.push(x.alarm.id);
      const said = await x.look().catch(() => null);
      if (said === 'limited') {
        limited = true;
        saveBudget(noteLimited(loadBudget(), { now, secondary: false, why: 'GitHub said its API limit was reached when the alarms were looked at again' }));
      } else if (said === true) {
        x.settle();
        settled.push(x.alarm.id);
      }
    });
  }
  const sources = keptAlarmSources(s);
  if (settled.some((id) => id.startsWith('passedover:'))) o.refreshStaff?.();
  const after = await watchAlarms(
    {
      ...sources,
      passedOver: sources.passedOver.filter((c) => !settled.includes(c.id)),
      strangers: s.releasesCastellan ? strangerConditions(withAck(loadActed(), before), now) : [],
      round: noRound(now.toISOString()),
      log: o.log,
    },
    { ...deps, now, rebuilt },
  );
  for (const id of settled) o.log(`alarms: ${id} looked at again on GitHub: done`);
  return { looked, settled, changed: !sameAlarms(before, after) };
}

/**
 * Manor's asks, one at a time: one under way is joined. GitHub is looked at no more than once a LOOK_EVERY_MS (a look
 * that found nothing to look at doesn't count), and not while `busy` (a stage runs). Each ask answers null once done,
 * or why it failed; never throws.
 */
export function rechecker(o: { recheck: (look: boolean) => Promise<{ looked: string[] }>; busy: () => boolean; now?: () => number; log?: (line: string) => void }): () => Promise<string | null> {
  const clock = o.now ?? Date.now;
  let under: Promise<string | null> | null = null;
  let lookedAt = -Infinity;
  const once = async (): Promise<string | null> => {
    const start = clock();
    try {
      const r = await o.recheck(!o.busy() && start - lookedAt >= LOOK_EVERY_MS);
      if (r.looked.length) lookedAt = start;
      return null;
    } catch (e) {
      o.log?.(`alarms: the recheck failed: ${(e as Error).message}`);
      return (e as Error).message;
    }
  };
  return () => (under ??= once().finally(() => (under = null)));
}
