import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP, pageUrl } from './app.ts';
import { manorHome } from './kit/manor.ts';
import { isNetworkError, online as kitOnline } from './kit/net.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { failureDetail, keptFailure } from './failure.ts';
import { allowedInstallScripts, installHoldConditions, type InstallHold } from './installscripts.ts';
import { agentPages, reeveInstalled, seneschalInstalled, surveyorInstalled, type AgentPages, type Employee, type Settings } from './settings.ts';
import type { TastingHold } from './tasting.ts';
import type { SigningAhead, SigningWait } from './signing.ts';
import { buildWhen } from './pipeline.ts';
import type { ExchequerPending } from './stages/exchequer.ts';
import type { Migration } from './migrate.ts';
import { bumpDirOf, releaseDirOf, type StageResult } from './stages/common.ts';
import { refreshDirOf } from './stages/refresh.ts';
import type { Runner } from './run.ts';
import { portClashConditions, type PortUse } from './ports.ts';
import { manorKeeps, tendConditions, type TendState } from './tend.ts';
import { unstickConditions, type UnstickState } from './unstick.ts';
import { closeResolved, fileWork, holdForWork, workItems, type WorkItem, type WorkState } from './work.ts';
import type { KitTrial } from './stages/trial.ts';
import type { Glance } from './glance.ts';

/**
 * What needs the person: the few things no one in the manor can see to by themselves. Each round, code (never a
 * model) lists the conditions it sees; one that lasts its while is an alarm, raised once, with a Windows toast,
 * kept on the Steward's page and at GET /api/alarms (where Manor shows it), until the condition clears. Dismissing
 * one hides it until it clears and comes back.
 *
 * The conditions:
 * - main's new kit failing an agent's checks in its trial (stages/trial.ts's heldKit), so the kit isn't released: at
 *   once, naming each agent and what failed. Only the kit waits: every other repository releases as usual. (Before
 *   Steward 0.36.124 the Steward merged PRs, and a PR that waited, conflicted or held its version queue was an alarm
 *   too; the Steward merges none now, so no PR is.)
 * - a release that failed, which the rounds won't try again at that commit (round-failed.json): at once;
 * - a kit's bump or push that failed, which the rounds won't try again until the branch moves (rollout-failed.json),
 *   and one of the Steward's own releases that failed (self-failed.json): at once; a new kit that waits for the
 *   Steward itself to carry it, a day (waitingHours);
 * - a round that couldn't run at all (gh signed out, say) for an hour;
 * - an update Manor couldn't install, for two hours; Manor's update checks failing, for twelve; Manor's page down,
 *   for an hour;
 * - a port two agents claim, or one another program answers on so an agent's page can't start (Manor's summary
 *   "ports"), for a quarter of an hour;
 * - a problem the Surveyor has reported for six hours (Settings: problemHours); the Surveyor's page down, for two;
 * - an issue the Wright got stuck on, or its PR that changes what a person reviews, at once; its page down, for two;
 * - the Bailiff unable to review (Claude Code not signed in), or a review of its failing twice, at once; its page down,
 *   for two (the Wright's drafts wait for it).
 * - a release the Assayer's release check has held a while (tasting-held.json; Settings: tastingHours);
 * - an update of the Steward itself that its install rolled back (unsafe-updates.json), at once;
 * - a package whose install script isn't on Settings' list, which held an install of the Steward's (install-held.json,
 *   installscripts.ts), at once, naming the package, its version, the repository and the script;
 * - an agent on duty whose page doesn't answer, which the round couldn't open again through Manor (tend.ts), at once;
 * - an agent update Manor gave up on that the round couldn't settle: its install would still take an older release, or
 *   the Steward pressed Update for it once already (unstick.ts), at once;
 * - on the PC that releases Castellan, the Steward's PRs merged or its employees released by something that isn't this
 *   Steward, another Steward elsewhere most likely (strangers.ts), at once, for a day after the last one;
 * - each of Reeve's jobs' open alerts (his GET /api/alerts), at once, where Reeve is installed. Reeve raises no toast
 *   of his own when Manor and the Steward are installed: these alarms raise it. One that covers a job the Surveyor
 *   reports as crashed takes that problem's place (withoutReeveDuplicates).
 *
 * Work the team can do is handed to the Wright first (work.ts; Settings: fileWork): an employee's failed bump or
 * release, and Reeve's alerts that are code work in an employee's repository, are filed as manor:work issues, and their
 * alarms wait a day (waitingHours) from when they were filed, or are raised at once when the Wright gets stuck or its
 * PR waits for a person, or when they couldn't be filed (holdForWork).
 *
 * While this PC is offline (the kit's net.ts), what is only the network's is no alarm (withoutOffline): the person
 * knows. And a round while offline asks nothing of GitHub (steward.ts).
 */

export interface Condition {
  /** Stable while the same thing is wrong: "waiting:Jcollier0120/Porter#12". */
  id: string;
  /** An employee's id, or 'manor', 'surveyor', 'steward'. */
  who: string;
  title: string;
  /** The facts it rests on, and what to do. */
  detail: string[];
  url?: string;
  /** When it started, when its source knows (a finding's since); else when the Steward first saw it. */
  since?: string;
  /** How long it must last to be an alarm. */
  afterMs: number;
  /** What the person can have the Steward do about it, in one click (POST /api/alarms/act). */
  action?: AlarmAction;
}

/**
 * What an alarm's button does, in its words, and the question asked before it (Steward 0.36.52). Its page and Manor's
 * Needs you show it beside Dismiss. None has one since the version queues went (Steward 0.36.124).
 */
export interface AlarmAction {
  label: string;
  confirm: string;
}

export interface Alarm {
  id: string;
  who: string;
  title: string;
  detail: string[];
  url?: string;
  since: string;
  raisedAt: string;
  /** When the person dismissed it; it stays dismissed until it clears. */
  dismissedAt?: string;
  action?: AlarmAction;
}

export interface AlarmState {
  at: string | null;
  /** Each condition seen, by id: when it was first seen. */
  watching: Record<string, string>;
  open: Alarm[];
  /** The last ones to clear, newest first. */
  cleared: (Alarm & { clearedAt: string })[];
}

const HOUR = 3_600_000;
const KEEP_CLEARED = 20;

export const alarmsFile = () => dataFile('alarms.json');
export const loadAlarms = (): AlarmState => ({ at: null, watching: {}, open: [], cleared: [], ...readJson<Partial<AlarmState>>(alarmsFile(), {}) });

/** The alarms after this round's conditions, and those newly raised (to toast). Pure. */
export function reconcile(state: AlarmState, conditions: Condition[], now: Date): { state: AlarmState; raised: Alarm[] } {
  const at = now.toISOString();
  const watching: Record<string, string> = {};
  const open: Alarm[] = [];
  const raised: Alarm[] = [];
  for (const c of conditions) {
    if (c.id in watching) continue;
    const since = c.since ?? state.watching[c.id] ?? at;
    watching[c.id] = since;
    if (now.getTime() - Date.parse(since) < c.afterMs) continue;
    const was = state.open.find((a) => a.id === c.id);
    const alarm: Alarm = { id: c.id, who: c.who, title: c.title, detail: c.detail, since, raisedAt: was?.raisedAt ?? at };
    if (c.url) alarm.url = c.url;
    if (c.action) alarm.action = c.action;
    if (was?.dismissedAt) alarm.dismissedAt = was.dismissedAt;
    open.push(alarm);
    if (!was) raised.push(alarm);
  }
  const cleared = [...state.open.filter((a) => !open.some((o) => o.id === a.id)).map((a) => ({ ...a, clearedAt: at })), ...state.cleared].slice(0, KEEP_CLEARED);
  return { state: { at, watching, open, cleared }, raised };
}

/** Dismisses an open alarm until it clears; false when there's no such alarm. */
export function dismiss(id: string, now = new Date()): boolean {
  const s = loadAlarms();
  const a = s.open.find((x) => x.id === id);
  if (!a) return false;
  a.dismissedAt = now.toISOString();
  writeJson(alarmsFile(), s);
  return true;
}

const hours = (h: number) => `${h} hour${h === 1 ? '' : 's'}`;

/** A bump or push of a kit that failed in a round (stages/rollout.ts's rollout-failed.json), as the alarms read it. */
export interface FailedRollout {
  kit: string;
  head: string;
  stage: 'bump' | 'push' | 'build';
  message: string;
}

/** One of the Steward's own releases that failed in a round (stages/self.ts's self-failed.json), by tag. */
export interface FailedSelf {
  commit: string;
  message: string;
}

/**
 * Releases on GitHub that didn't reach the Exchequer (stages/exchequer.ts): no one is offered them until they're there.
 * One the Exchequer refused is raised at once, as only a person can fix that; one the network kept out only once it has
 * waited Settings' waiting hours, as the rounds try it again meanwhile. The Steward's own too (0.36.139), by its id.
 * Either has a button, "Publish it now", that has the next round try it at once (exchequer.ts's askAgain).
 */
export function exchequerConditions(pending: Record<string, ExchequerPending>, employees: Employee[], settings: Settings): Condition[] {
  return Object.entries(pending).flatMap(([id, p]): Condition[] => {
    const name = id === APP.id ? APP.name : employees.find((x) => x.id === id)?.name;
    if (!name) return [];
    const offered = `Manor installs ${name} from the Exchequer alone, so no one is offered v${p.version} until it's there.`;
    const action = { label: 'Publish it now', confirm: `Publish ${name} v${p.version} to the Exchequer now, from its release on GitHub? Nothing is built again.` };
    if (p.passing) {
      return [
        {
          id: `exchequer:${id}:${p.version}:waits`,
          who: id,
          title: `${name} v${p.version} is released on GitHub, but the Exchequer couldn't be reached to publish it for ${hours(settings.alarms.waitingHours)} or more`,
          detail: [`Last try: ${p.why}`, offered, `The rounds keep trying (${p.tries} so far), and this clears by itself once it's there. Publish it now to have the next round try at once.`],
          since: p.since,
          afterMs: settings.alarms.waitingHours * HOUR,
          action,
        },
      ];
    }
    return [
      {
        id: `exchequer:${id}:${p.version}:refused`,
        who: id,
        title: `${name} v${p.version} is released on GitHub, but the Exchequer refused it`,
        detail: [p.why, offered, `Once that's fixed, press Publish it now: a round publishes v${p.version} to the Exchequer from GitHub's own files, without building it again.`],
        since: p.since,
        afterMs: 0,
        action,
      },
    ];
  });
}

/**
 * From the round: main's kit held by its trial, releases the rounds gave up on, releases that wait until this PC can sign, a round
 * that couldn't run; and, while the rounds
 * roll kits out, a bump or push they gave up on, and a new kit waiting a while for the Steward itself to carry it; and,
 * while they release the Steward's own versions, one of those that failed.
 */
export function roundConditions(o: {
  round: StageResult;
  /** Main's kit, tried and failing agents, so it isn't released (stages/trial.ts's heldKit); null when none is held. */
  heldKit?: KitTrial | null;
  failedReleases: Record<string, string>;
  failedRollouts?: Record<string, FailedRollout>;
  failedSelf?: Record<string, FailedSelf>;
  rolloutWaits?: { kit: string; own: string } | null;
  /** Releases the Assayer's release check holds (tasting.ts's tasting-held.json), by employee. */
  tastingHolds?: Record<string, TastingHold>;
  /** Releases that wait until this PC can sign (signing.ts's signing-waits.json), by employee. */
  signingWaits?: Record<string, SigningWait>;
  /** What the look ahead of the next build found: it would sign, and this PC can't now (signing.ts's signing-ahead.json). */
  signingAhead?: SigningAhead | null;
  /** Releases on GitHub that didn't reach the Exchequer (stages/exchequer.ts's exchequer-pending.json), by employee. */
  exchequerPending?: Record<string, ExchequerPending>;
  /** Versions of the Steward its install rolled back (safeinstall.ts's unsafe-updates.json), by version. */
  unsafe?: Record<string, { version: string; from: string | null; why: string; at: string; kept: string | null }>;
  /** What the settings migration couldn't fill in (migrate.ts), until it finds it or Settings are saved. */
  migrated?: Migration | null;
  /** Refreshes after a release that failed (stages/refresh.ts's refresh-failed.json), by repository. */
  failedRefreshes?: Record<string, { commit: string; message: string; after: string }>;
  /** The staff's pages as the round's look left them (tend.ts's tending.json); null while Settings switch it off. */
  tending?: TendState | null;
  /** The agent updates Manor gave up on that the Steward couldn't settle (unstick.ts's unstick.json); null while Settings switch it off. */
  unstick?: UnstickState | null;
  /** Merges and releases of this Steward's repositories that it didn't make (strangers.ts), as its alarm. */
  strangers?: Condition[];
  /** Every agent's port, as Manor's lists, the clones and the claims say (ports.ts): two agents on one is an alarm. */
  ports?: PortUse[];
  /** Packages whose install scripts held an install (installscripts.ts's install-held.json), by id. */
  installHolds?: Record<string, InstallHold>;
  employees: Employee[];
  settings: Settings;
}): Condition[] {
  const out: Condition[] = [];
  out.push(...installHoldConditions(o.installHolds ?? {}, allowedInstallScripts(o.settings)));
  if (o.ports) out.push(...portClashConditions(o.ports));
  if (o.tending) out.push(...tendConditions(o.tending));
  if (o.unstick) out.push(...unstickConditions(o.unstick));
  out.push(...(o.strangers ?? []));
  // Main's new kit, failing agents in its trial: it isn't released, and the Steward's own version that carries it waits
  // with it (stages/self.ts). Raised at once, naming each agent and what failed; no other repository waits for it.
  if (o.heldKit) {
    const t = o.heldKit;
    const names = t.failed.map((x) => x.name).join(', ');
    out.push({
      id: `kittrial:${t.kit}`,
      who: 'steward',
      title: `Kit ${t.kit} isn't released: it fails ${names}'s checks in its trial`,
      detail: [
        ...t.failed.flatMap((x) => [`${x.name}${x.main ? ` at ${x.main.slice(0, 7)}` : ''}: ${x.message}`, ...(x.errors ?? []).slice(0, 3).map((line) => `  ${line}`)]),
        "Fix the kit on main, or the agents on theirs: each build tries main's kit again, and releases it once it passes. Every other repository releases as usual meanwhile.",
      ],
      since: t.at,
      afterMs: 0,
    });
  }
  for (const [id, commit] of Object.entries(o.failedReleases)) {
    const e = o.employees.find((x) => x.id === id);
    const said = o.round.results.find((r) => r.id === id && r.outcome === 'failed' && r.message.startsWith('release: '))?.message.slice('release: '.length);
    out.push({
      id: `release:${id}:${commit}`,
      who: id,
      title: `${e?.name ?? id}'s release failed at ${commit}, and the rounds won't try it again`,
      // Why, from its kept output: the round's line says only which command failed, and only in the round it failed.
      detail: [...(said ? [said] : []), ...failureDetail(e ? keptFailure(releaseDirOf(o.settings, e)) : null, said ?? ''), "Release it on the Steward's page once it's fixed, or push a new commit: the next round tries that."],
      afterMs: 0,
    });
  }
  // Releases that wait until this PC can sign (SimplySign Desktop not connected): one alarm for them all, raised at once,
  // so the person connects it; it clears by itself once a round's test signature works and the build of their own
  // releases them (Steward 0.36.161: between builds too, not only at the next build time).
  const signing = Object.entries(o.signingWaits ?? {}).flatMap(([id, w]) => {
    const e = o.employees.find((x) => x.id === id);
    return e ? [{ name: e.name, ...w }] : [];
  });
  if (signing.length) {
    const first = signing.reduce((a, b) => (b.since < a.since ? b : a));
    out.push({
      id: 'signing:waits',
      who: 'steward',
      title: `${signing.map((w) => `${w.name} ${w.version}`).join(', ')} ${signing.length === 1 ? 'waits' : 'wait'} to be released until this PC can sign`,
      detail: [
        `Why: ${first.why}`,
        'Reconnect SimplySign Desktop (your SimplySign ID and the one-time code from the phone app), or fix what the line above says.',
        `Nothing failed, and nothing needs a click or a new commit: each round signs a test file, and once that works the Steward releases ${signing.length === 1 ? 'it' : 'them'} by itself, between builds too, and this alarm clears.`,
      ],
      since: first.since,
      afterMs: 0,
    });
  }
  // Within the hour before a build that would sign a release, this PC can't sign (stages/round.ts's signingAhead): raised
  // at once, so the person reconnects before the build; it clears once a round's test signature works, or the build begins.
  if (o.signingAhead) {
    const a = o.signingAhead;
    out.push({
      id: `signing:ahead:${a.build}`,
      who: 'steward',
      title: `This PC can't sign now, and the ${buildWhen(new Date(a.build), new Date())} build would sign ${a.names.join(', ')}: reconnect SimplySign Desktop before it`,
      detail: [
        `Why: ${a.why}`,
        'Reconnect SimplySign Desktop (your SimplySign ID and the one-time code from the phone app), or fix what the line above says: this alarm clears once a round signs a test file.',
        "If it still can't sign at the build, nothing fails: the release waits, and the Steward releases it by itself once it can.",
      ],
      since: a.since,
      afterMs: 0,
    });
  }
  out.push(...exchequerConditions(o.exchequerPending ?? {}, o.employees, o.settings));
  if (o.settings.rollout) {
    for (const [id, f] of Object.entries(o.failedRollouts ?? {})) {
      const e = o.employees.find((x) => x.id === id);
      if (!e) continue;
      // A kit PR a build left out, before Steward 0.36.124: builds no longer merge PRs, so it is no alarm.
      if (f.stage === 'build') continue;
      out.push({
        id: `rollout:${id}:${f.kit}`,
        who: id,
        title: `${e.name}'s ${f.stage} to kit ${f.kit} failed, and the rounds won't try it again until its branch moves`,
        detail: [
          f.message,
          ...(f.stage === 'bump' ? failureDetail(keptFailure(bumpDirOf(o.settings, e)), f.message) : []),
          f.stage === 'bump'
            ? `Its worktree is left in the Steward's work folder for a look. Once it's fixed, push to ${e.branch} (the next round bumps it again), or press Bump on the Steward's page.`
            : "The bump is ready on its branch here. Press Push on the Steward's page once GitHub takes it, or push a new commit: the next round bumps again.",
        ],
        afterMs: 0,
      });
    }
    if (o.rolloutWaits) {
      const w = o.rolloutWaits;
      out.push({
        id: `rollout:waits:${w.kit}`,
        who: 'steward',
        title: `Kit ${w.kit} isn't rolled out: the Steward carries kit ${w.own}, and waits for a release of itself that carries ${w.kit}`,
        detail: [`A bump hands out the Steward's own tools/kit.ts, the one released with its kit. Release a Steward version whose kit.json pins ${w.kit} (the rounds do when its version on main has no release), and let Manor install it.`],
        afterMs: o.settings.alarms.waitingHours * HOUR,
      });
    }
  }
  if (o.settings.releaseSelf) {
    for (const [tag, f] of Object.entries(o.failedSelf ?? {})) {
      out.push({
        id: `self:${tag}:${f.commit.slice(0, 7)}`,
        who: 'steward',
        title: `The Steward couldn't release ${tag} at ${f.commit.slice(0, 7)}, and the rounds won't try it again`,
        detail: [f.message, `Release it in the Steward's checkout (npm run ${tag.startsWith('kit-') ? 'kit-release' : 'release'} -- --publish) once it's fixed, or push a new commit to main: the next round tries that.`],
        afterMs: 0,
      });
    }
  }
  if (o.settings.tasteBeforeRelease) {
    const h = o.settings.alarms.tastingHours;
    for (const [id, hold] of Object.entries(o.tastingHolds ?? {})) {
      const e = o.employees.find((x) => x.id === id);
      if (!e) continue;
      out.push({
        id: `tasting:${id}:${hold.commit.slice(0, 7)}:${hold.version}`,
        who: id,
        title: `${e.name} v${hold.version} has waited ${hours(h)} or more for the Assayer's release check`,
        detail: [hold.why, `Fix what the check found and push to ${e.branch} (the next round asks again), or switch off "Waits for the Assayer's release check" in the Steward's Settings to release without it.`],
        url: hold.url,
        since: hold.since,
        afterMs: h * HOUR,
      });
    }
  }
  for (const u of Object.values(o.unsafe ?? {})) {
    out.push({
      id: `unsafe:${u.version}`,
      who: 'steward',
      title: `The Steward's update to ${u.version} failed and was rolled back${u.from ? ` to ${u.from}` : ''}: it isn't installed again until you look`,
      detail: [
        u.why,
        `${u.kept ? `Its copy is kept in ${u.kept} for a look. ` : ''}A newer version installs as usual. Dismiss this once you've looked: that allows ${u.version} again (or node src\cli.ts allow-update ${u.version}), and Manor's next update installs it, behind the same fail-safe.`,
      ],
      since: u.at,
      afterMs: 0,
    });
  }
  for (const [id, f] of Object.entries(o.failedRefreshes ?? {})) {
    const e = o.employees.find((x) => x.id === id);
    // One no longer refreshed (Settings changed) has nothing to raise.
    if (!e?.refresh) continue;
    out.push({
      id: `refresh:${id}:${f.commit || 'none'}`,
      who: id,
      title: `${e.name}'s refresh after ${f.after} failed, and nothing was pushed`,
      detail: [f.message, ...failureDetail(keptFailure(refreshDirOf(o.settings, e)), f.message), `Run ${e.refresh} in a clone of ${e.branch} once it's fixed, then commit and push; or the next release tries again.`],
      afterMs: 0,
    });
  }
  if (o.migrated?.notes.length) {
    out.push({
      id: `settings:migrated:${o.migrated.at}`,
      who: 'steward',
      title: "The Steward's employees were written into its Settings from its staff table, and some need you",
      detail: [...o.migrated.notes, 'Or fill them in yourself in Settings, under Employees, and save: that clears this too.'],
      since: o.migrated.at,
      afterMs: 0,
    });
  }
  if (o.round.error) out.push({ id: 'round', who: 'steward', title: "The Steward's rounds can't run", detail: [o.round.error], afterMs: HOUR });
  return out;
}

/**
 * Why a page gave no answer (getJson's own { error }, and nothing else), or null when it answered. An answer that carries
 * an error field of its own (the Wright's work says error: null) is still an answer.
 */
export function noAnswer(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'no answer';
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === 'error' ? String((v as any).error) : null;
}

/** From Manor's /api/state: updates it couldn't install or check; or no answer at all. */
export function manorConditions(state: unknown): Condition[] {
  const why = noAnswer(state);
  if (why !== null) {
    return [{ id: 'manor:down', who: 'manor', title: "Manor's page doesn't answer", detail: [why, "The Steward starts it again through its sign-in task (three times, five minutes apart, then hourly). If it stays down, open Manor from the Start menu, or look at the end of serve.log in Manor's folder (%USERPROFILE%\\.manor) for why it stopped."], afterMs: HOUR }];
  }
  const u = (state as any).updates;
  const out: Condition[] = [];
  for (const item of Array.isArray(u?.items) ? u.items : []) {
    if (!item?.error) continue;
    out.push({ id: `install:${item.id}`, who: String(item.id), title: `Manor couldn't update ${item.name ?? item.id}`, detail: [String(item.error), `Installed ${item.installed ?? '?'}, latest ${item.latest ?? '?'}.`], url: item.url ?? undefined, afterMs: 2 * HOUR });
  }
  if (u?.problem) out.push({ id: 'manor:updates', who: 'manor', title: "Manor's update checks fail", detail: [String(u.problem)], afterMs: 12 * HOUR });
  return out;
}

/** Conditions that are the network's by nature: Manor's update look, and an update it couldn't download. */
const NETWORK_IDS = /^(?:manor:updates|install:)/;

/**
 * While this PC is offline (the kit's net.ts), the conditions that are only the network's are left out: Manor's
 * update look and its updates, and anything whose words are a network failure (a Surveyor finding of an agent's
 * round, a job's alert, a failed release). The person knows the PC is offline. Left out, an open one clears, and
 * its hours start afresh once the PC is back online and it still fails; everything else is as ever.
 */
export function withoutOffline(conditions: Condition[], offline: boolean): Condition[] {
  if (!offline) return conditions;
  return conditions.filter((c) => !NETWORK_IDS.test(c.id) && !isNetworkError([c.title, ...c.detail].join('\n')));
}

/**
 * From Manor's /api/summary "ports" (Manor 0.4.38 and later): a port two agents claim, one kept for the model
 * servers, or one another program answers on, so an agent's page can't start there (the Chamberlain on the
 * Developer Herald's 19898). One alarm a port, after a quarter of an hour, so a page restarting through an
 * update isn't one. No answer, or an older Manor without "ports": nothing (Manor's page down is manorConditions').
 */
export function portConditions(summary: unknown): Condition[] {
  if (noAnswer(summary) !== null) return [];
  const rows = (summary as any).ports;
  if (!Array.isArray(rows)) return [];
  const byPort = new Map<number, { agent: string; answeredBy: string | null; problem: string }[]>();
  for (const r of rows) {
    if (!r || typeof r.port !== 'number' || typeof r.agent !== 'string' || typeof r.problem !== 'string' || !r.problem) continue;
    const list = byPort.get(r.port) ?? [];
    list.push({ agent: r.agent, answeredBy: typeof r.answeredBy === 'string' ? r.answeredBy : null, problem: r.problem });
    byPort.set(r.port, list);
  }
  return [...byPort].map(([port, list]) => {
    const agents = [...new Set(list.map((r) => r.agent))];
    const by = list.find((r) => r.answeredBy)?.answeredBy ?? null;
    return {
      id: `port:${port}`,
      who: agents[0],
      title: agents.length > 1 ? `Port ${port} is claimed by ${agents.join(' and ')}: only one page can start there` : `Port ${port}: ${list[0].problem}`,
      detail: [
        ...new Set(list.map((r) => r.problem)),
        by ? `${by} answers there now.` : 'Nothing answers there now.',
        "Move one to a free port with a release of its own (each agent's port is in its src/app.ts and Manor entry), or stop the program on it. Manor's GET /api/summary lists every port.",
      ],
      afterMs: 15 * 60_000,
    };
  });
}

/** The port clashes being watched, or open, as the last round saw them: for a round whose summary didn't answer. */
export function portsAsTheyWere(state: AlarmState): Condition[] {
  return Object.entries(state.watching)
    .filter(([id]) => id.startsWith('port:'))
    .map(([id, since]) => {
      const open = state.open.find((a) => a.id === id);
      return { id, who: open?.who ?? 'manor', title: open?.title ?? `Port ${id.slice(5)} is taken`, detail: open?.detail ?? [], since, afterMs: 15 * 60_000 };
    });
}

/** From the Surveyor's /api/survey: its problems, from when it first saw each; or no answer at all. */
export function surveyorConditions(survey: unknown, settings: Settings): Condition[] {
  const why = noAnswer(survey);
  if (why !== null) {
    return [{ id: 'surveyor:down', who: 'surveyor', title: "The Surveyor's page doesn't answer, so nothing watches the manor's repair", detail: [why], afterMs: 2 * HOUR }];
  }
  const findings = (survey as any).findings;
  return (Array.isArray(findings) ? findings : [])
    .filter((f: any) => f?.severity === 'problem' && typeof f.id === 'string')
    .map((f: any) => ({
      id: `survey:${f.id}`,
      who: String(f.subject ?? 'surveyor'),
      title: String(f.title),
      detail: [...(Array.isArray(f.evidence) ? f.evidence.slice(-3).map(String) : []), ...(f.fix ? [`Fix: ${f.fix}`] : [])],
      since: typeof f.since === 'string' ? f.since : undefined,
      afterMs: settings.alarms.problemHours * HOUR,
    }));
}

/** From the Wright's /api/work: issues it got stuck on, and its PRs a person reviews, at once; or no answer at all. */
export function wrightConditions(work: unknown): Condition[] {
  const why = noAnswer(work);
  if (why !== null) {
    return [{ id: 'wright:down', who: 'wright', title: "The Wright's page doesn't answer, so the queued work waits", detail: [why], afterMs: 2 * HOUR }];
  }
  const needs = (work as any).needsYou;
  return (Array.isArray(needs) ? needs : [])
    .filter((n: any) => n && typeof n.id === 'string' && typeof n.repo === 'string')
    .map((n: any) => {
      // Claude Code can't be used on this PC (not there, or not signed in): its title says which.
      if (n.kind === 'blocked') return { id: `wright:${n.id}`, who: 'wright', title: `The Wright can't work: ${String(n.title)}`, detail: ['Its queue waits until then; each round tries again.'], url: typeof n.url === 'string' ? n.url : undefined, afterMs: 0 };
      const where = `${String(n.repo).split('/')[1]} #${n.number}`;
      const stuck = n.kind === 'stuck';
      return {
        id: `wright:${n.id}`,
        who: 'wright',
        title: stuck ? `The Wright got stuck on ${where}: ${n.title}` : `${where} needs your review: the Wright changed what a person reviews`,
        detail: stuck ? [`Its comment on the issue says why. Remove the wright:stuck label to have it tried again.`] : [String(n.title), 'Review it, then mark it ready, or close it.'],
        url: typeof n.url === 'string' ? n.url : undefined,
        afterMs: 0,
      };
    });
}

/** From the Bailiff's /api/reviews: reviews it can't do, at once; or no answer at all. */
export function bailiffConditions(reviews: unknown): Condition[] {
  const why = noAnswer(reviews);
  if (why !== null) {
    return [{ id: 'bailiff:down', who: 'bailiff', title: "The Bailiff's page doesn't answer, so the Wright's drafts wait for its review", detail: [why], afterMs: 2 * HOUR }];
  }
  const needs = (reviews as any).needsYou;
  return (Array.isArray(needs) ? needs : [])
    .filter((n: any) => n && typeof n.id === 'string' && typeof n.repo === 'string')
    .map((n: any) => {
      const url = typeof n.url === 'string' ? n.url : undefined;
      // Claude Code can't be used on this PC (not there, or not signed in): its title says which.
      if (n.kind === 'blocked') return { id: `bailiff:${n.id}`, who: 'bailiff', title: `The Bailiff can't review: ${String(n.title)}`, detail: ["The Wright's drafts wait, labelled bailiff:waiting; each round tries again."], url, afterMs: 0 };
      const where = `${String(n.repo).split('/')[1]} #${n.number}`;
      return { id: `bailiff:${n.id}`, who: 'bailiff', title: `The Bailiff's review of ${where} failed twice: ${String(n.title)}`, detail: ['Its request log says why. A new commit is reviewed again; or review it yourself, and mark it ready.'], url, afterMs: 0 };
    });
}

/**
 * From Reeve's GET /api/alerts: one condition per open alert of his jobs, at once, as he gives it; and the jobs they are
 * of. An older Reeve without the endpoint (404), or one whose page doesn't answer, is quiet here: no alarm about the
 * source (the Surveyor's agent.reeve.page problem already says when his page is down), and jobs null.
 */
export function reeveConditions(answer: unknown): { conditions: Condition[]; jobs: Set<string> | null } {
  if (noAnswer(answer) !== null) return { conditions: [], jobs: null };
  const alerts = (answer as any).alerts;
  if (!Array.isArray(alerts)) return { conditions: [], jobs: null };
  const jobs = new Set<string>();
  const conditions: Condition[] = [];
  for (const a of alerts) {
    if (!a || typeof a.id !== 'string' || !a.id || typeof a.title !== 'string') continue;
    if (typeof a.job === 'string') jobs.add(a.job);
    conditions.push({
      id: `reeve:${a.id}`,
      who: 'reeve',
      title: a.title,
      detail: Array.isArray(a.detail) ? a.detail.map(String) : [],
      url: typeof a.url === 'string' ? a.url : undefined,
      since: typeof a.since === 'string' && !Number.isNaN(Date.parse(a.since)) ? a.since : undefined,
      afterMs: 0,
    });
  }
  return { conditions, jobs };
}

/**
 * From the Seneschal's GET /api/alerts (Steward 0.36.65): one condition per jam, a task waiting far past its kind's
 * usual run (four times it, ten minutes at least), at once, as it gives it. A Seneschal without the endpoint, or whose
 * page doesn't answer, is quiet here: its work goes on as before (each agent runs its own), and Manor says when its page
 * is down.
 */
export function seneschalConditions(answer: unknown): Condition[] {
  if (noAnswer(answer) !== null) return [];
  const alerts = (answer as any).alerts;
  if (!Array.isArray(alerts)) return [];
  return alerts
    .filter((a) => a && typeof a.id === 'string' && a.id && typeof a.title === 'string')
    .map((a) => ({
      id: `seneschal:${a.id}`,
      who: 'seneschal',
      title: a.title,
      detail: Array.isArray(a.detail) ? a.detail.map(String) : [],
      url: typeof a.url === 'string' ? a.url : undefined,
      since: typeof a.since === 'string' && !Number.isNaN(Date.parse(a.since)) ? a.since : undefined,
      afterMs: 0,
    }));
}

/**
 * One alarm for one crashed job: the Surveyor reports a Reeve job that exited non-zero as the problem
 * agent.reeve.job.<job> (an alarm after problemHours), and Reeve lists the same crash as an open alert of that job. While
 * Reeve's alerts name a job, the Surveyor's condition for it (id survey:agent.reeve.job.<job>) is dropped, and Reeve's
 * stands. With no answer from Reeve (jobs null), the Surveyor's stays.
 */
export function withoutReeveDuplicates(conditions: Condition[], jobs: Set<string> | null): Condition[] {
  if (!jobs?.size) return conditions;
  return conditions.filter((c) => !(c.id.startsWith('survey:agent.reeve.job.') && jobs.has(c.id.slice('survey:agent.reeve.job.'.length))));
}

export type GetJson = (url: string) => Promise<unknown>;

/** GET a local page's JSON; { error } when it doesn't answer. Never under node --test: a test must not read the live manor. */
export const getJson: GetJson = async (url) => {
  if (process.env.NODE_TEST_CONTEXT) return { error: 'not read under node --test' };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const powershellExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** Windows PowerShell's own AppUserModelID: the toast goes under it should Castellan's not take. */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
/** Castellan's AppUserModelID, as Manor's own notifications use it (its needs-you.ts): one name for the manor's. */
export const TOAST_APP_ID = 'Castellan';
/** Manor's castle, as a PNG: the name's icon, and the toast's own picture, since Windows may leave the name's out. */
const toastIcon = () => path.join(manorHome(), 'app', 'art', 'manor-icon.png');
// Text arrives in environment variables and is XML-escaped in PowerShell, so nothing is spliced into code. The app id
// is put in the registry first with Castellan's name and icon (a key, no shortcut, no admin); should that fail, the
// toast goes under Windows PowerShell's own, as before.
const TOAST_PS = `$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
function E([string]$s) { [System.Security.SecurityElement]::Escape($s) }
$icon = $env:STEWARD_TOAST_ICON -and (Test-Path -LiteralPath $env:STEWARD_TOAST_ICON)
$id = $env:STEWARD_TOAST_FALLBACK
try {
  $k = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $env:STEWARD_TOAST_APPID
  if (-not (Test-Path $k)) { [void](New-Item -Path $k -Force) }
  Set-ItemProperty -Path $k -Name DisplayName -Value $env:STEWARD_TOAST_NAME
  if ($icon) { Set-ItemProperty -Path $k -Name IconUri -Value $env:STEWARD_TOAST_ICON }
  $id = $env:STEWARD_TOAST_APPID
} catch { }
$logo = ''
if ($icon) { $logo = "<image placement=""appLogoOverride"" hint-crop=""none"" src=""$(E $env:STEWARD_TOAST_LOGO)""/>" }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast activationType=""protocol"" launch=""$(E $env:STEWARD_TOAST_LAUNCH)""><visual><binding template=""ToastGeneric""><text>$(E $env:STEWARD_TOAST_TITLE)</text><text>$(E $env:STEWARD_TOAST_BODY)</text>$logo</binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

export type Toast = (title: string, body: string) => Promise<void>;

/** A Windows toast that opens the Steward's page. Never under node --test. */
export const toast: Toast = (title, body) => {
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile(
      powershellExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(TOAST_PS, 'utf16le').toString('base64')],
      {
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          STEWARD_TOAST_TITLE: title.slice(0, 120),
          STEWARD_TOAST_BODY: body.slice(0, 400),
          STEWARD_TOAST_APPID: TOAST_APP_ID,
          STEWARD_TOAST_NAME: 'Castellan',
          STEWARD_TOAST_ICON: toastIcon(),
          STEWARD_TOAST_LOGO: pathToFileURL(toastIcon()).href,
          STEWARD_TOAST_FALLBACK: POWERSHELL_AUMID,
          STEWARD_TOAST_LAUNCH: `${pageUrl}#alarms`,
        },
      },
      (err) => (err ? reject(new Error(`toast failed: ${err.message.slice(0, 300)}`)) : resolve()),
    );
  });
};

/** One toast for what was raised this round. */
export function toastWords(raised: Alarm[]): { title: string; body: string } {
  if (raised.length === 1) return { title: `${APP.name}: this needs you`, body: raised[0].title };
  return { title: `${APP.name}: ${raised.length} things need you`, body: raised.map((a) => a.title).join('\n') };
}

/**
 * After a round: every condition seen, reconciled with what was open, kept in alarms.json, and one toast for the
 * new ones. Manor's and the Surveyor's pages are read here; `deps` stands in for them, the toast and the clock.
 */
export async function watchAlarms(
  o: Parameters<typeof roundConditions>[0] & {
    log: (line: string) => void;
    /** gh, for filing work for the Wright (work.ts), and where it runs from; without it nothing is filed. */
    run?: Runner;
    neutralDir?: string;
    /** The round's glance at GitHub, for what closing the work filed would otherwise ask (work.ts closeResolved). */
    glance?: Glance | null;
  },
  deps: { getJson?: GetJson; toast?: Toast; now?: Date; manorUrl?: string | null; pages?: Partial<AgentPages>; reeveInstalled?: () => boolean; surveyorInstalled?: () => boolean; seneschalInstalled?: () => boolean; online?: () => Promise<boolean> } = {},
): Promise<AlarmState> {
  const a = o.settings.alarms;
  // The other agents' pages, as Manor says them.
  const p = { ...agentPages(), ...deps.pages };
  const filing = o.settings.fileWork && !!o.run;
  if (!a.on && !filing) return loadAlarms();
  const given = deps.getJson ?? getJson;
  // A page that throws is one that gave no answer, as getJson says it.
  const get: GetJson = (url) => Promise.resolve().then(() => given(url)).catch((e) => ({ error: (e as Error).message }));
  const now = deps.now ?? new Date();
  const manor = deps.manorUrl === undefined ? p.manor : deps.manorUrl;
  // The pages read every round, asked at once (Steward 0.36.142): each may take up to 8 seconds, and they were asked one
  // after another. Manor's state and the Bailiff's reviews are for the alarms alone.
  const wrightAsked = p.wright ? get(new URL('/api/work', p.wright).href) : null;
  const stateAsked = a.on && manor ? get(new URL('/api/state', manor).href) : null;
  const bailiffAsked = a.on && p.bailiff ? get(new URL('/api/reviews', p.bailiff).href) : null;
  // Reeve's only when something reads them: the work filed, or the manor-wide alarms while they are the Steward's (Steward
  // 0.36.141). Where Manor keeps those and nothing is filed, Reeve was asked every round for nothing.
  const askReeve = async () => (p.reeve && (deps.reeveInstalled ?? reeveInstalled)() ? await get(new URL('/api/alerts', p.reeve).href) : null);
  const reeveAsked = filing ? askReeve() : undefined;
  // The Wright's work and Reeve's alerts are read for the work filed (work.ts) as well as for the alarms.
  const wright = await wrightAsked;
  let reeve = await reeveAsked;
  // Failed bumps and releases, and Reeve's alerts that are code work, filed for the Wright: their alarms wait.
  let items: WorkItem[] = [];
  let states = new Map<string, WorkState>();
  if (filing) {
    try {
      items = workItems({ failedReleases: o.failedReleases, failedRollouts: o.failedRollouts, reeve: reeve !== undefined && reeve !== null && noAnswer(reeve) === null ? reeve : null, round: o.round, employees: o.employees, settings: o.settings });
      if (items.length) states = await fileWork({ items, work: wright, employees: o.employees, run: o.run!, cwd: o.neutralDir ?? process.cwd(), now, log: o.log });
      // And the issues whose failure is gone (a bump, a release, and a conflict or kit trial filed before 0.36.124), closed, so the Wright isn't sent to find nothing to do.
      await closeResolved({ items, employees: o.employees, run: o.run!, cwd: o.neutralDir ?? process.cwd(), log: o.log, glance: o.glance });
    } catch (e) {
      o.log(`work: ${(e as Error).message}`);
    }
  }
  if (!a.on) return loadAlarms();
  const conditions = roundConditions(o);
  // The manor-wide alarms are Manor's once it says it keeps them (tend.ts's manorKeeps): then only the repositories' are the Steward's.
  let manorWide = true;
  if (manor && stateAsked) {
    const state = await stateAsked;
    manorWide = !manorKeeps(state).has('alarms');
    if (manorWide) {
      conditions.push(...manorConditions(state));
      const summary = await get(new URL('/api/summary', manor).href);
      // The summary asks every agent, so it may not answer one round: a port clash it said is kept as it was until it
      // answers again, rather than cleared and raised a second time.
      conditions.push(...(noAnswer(summary) === null ? portConditions(summary) : portsAsTheyWere(loadAlarms())));
    } else o.log("alarms: Manor keeps the manor-wide alarms itself; the Steward raises only its repositories' own");
  }
  // The Surveyor's page only where the Surveyor is installed: without it, there is nothing to watch, and no alarm.
  if (manorWide && p.surveyor && (deps.surveyorInstalled ?? surveyorInstalled)()) conditions.push(...surveyorConditions(await get(new URL('/api/survey', p.surveyor).href), o.settings));
  if (wright !== null) conditions.push(...wrightConditions(wright));
  if (bailiffAsked) conditions.push(...bailiffConditions(await bailiffAsked));
  let reeveJobs: Set<string> | null = null;
  if (manorWide && reeve === undefined) reeve = await askReeve();
  if (reeve !== undefined && reeve !== null && manorWide) {
    const r = reeveConditions(reeve);
    conditions.push(...r.conditions);
    reeveJobs = r.jobs;
  }
  // The Seneschal's jams, where it's installed (it comes with Developer Pro): manor-wide, like Reeve's.
  if (manorWide && p.seneschal && (deps.seneschalInstalled ?? seneschalInstalled)()) conditions.push(...seneschalConditions(await get(new URL('/api/alerts', p.seneschal).href)));
  const offline = !(await (deps.online ?? (process.env.NODE_TEST_CONTEXT ? async () => true : kitOnline))().catch(() => true));
  const kept = holdForWork(withoutReeveDuplicates(conditions, reeveJobs), items, states, a.waitingHours);
  const { state, raised } = reconcile(loadAlarms(), withoutOffline(kept, offline), now);
  writeJson(alarmsFile(), state);
  for (const r of raised) o.log(`alarm: ${r.title}`);
  if (raised.length && a.toast) {
    const w = toastWords(raised);
    try {
      await (deps.toast ?? toast)(w.title, w.body);
    } catch (e) {
      o.log(`alarm: ${(e as Error).message}`);
    }
  }
  return state;
}
