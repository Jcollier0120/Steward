import { execFile } from 'node:child_process';
import path from 'node:path';
import { APP, pageUrl } from './app.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { reeveInstalled, type Employee, type Settings } from './settings.ts';
import type { TastingHold } from './tasting.ts';
import type { StageResult } from './stages/common.ts';

/**
 * What needs the person: the few things no one in the manor can see to by themselves. Each round, code (never a
 * model) lists the conditions it sees; one that lasts its while is an alarm, raised once, with a Windows toast,
 * kept on the Steward's page and at GET /api/alarms (where Manor shows it), until the condition clears. Dismissing
 * one hides it until it clears and comes back.
 *
 * The conditions:
 * - a PR to an employee that has waited a day: a draft no one marked ready, conflicts, failing checks, a version
 *   that clashes (Settings: waitingHours);
 * - a release that failed, which the rounds won't try again at that commit (round-failed.json): at once;
 * - a kit's bump or push that failed, which the rounds won't try again until the branch moves (rollout-failed.json),
 *   and one of the Steward's own releases that failed (self-failed.json): at once; a new kit that waits for the
 *   Steward itself to carry it, a day (waitingHours);
 * - a round that couldn't run at all (gh signed out, say) for an hour;
 * - an update Manor couldn't install, for two hours; Manor's update checks failing, for twelve; Manor's page down,
 *   for an hour;
 * - a problem the Surveyor has reported for six hours (Settings: problemHours); the Surveyor's page down, for two;
 * - an issue the Wright got stuck on, or its PR that changes what a person reviews, at once; its page down, for two;
 * - a release the Aletaster's tasting has held a while (tasting-held.json; Settings: tastingHours);
 * - each of Reeve's jobs' open alerts (his GET /api/alerts), at once, where Reeve is installed. Reeve raises no toast
 *   of his own when Manor and the Steward are installed: these alarms raise it. One that covers a job the Surveyor
 *   reports as crashed takes that problem's place (withoutReeveDuplicates).
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

/** A PR the merge stage held, as it said why. */
export interface Held {
  number: number;
  url: string;
  title: string;
  why: string;
  draft: boolean;
}

/** A bump or push of a kit that failed in a round (stages/rollout.ts's rollout-failed.json), as the alarms read it. */
export interface FailedRollout {
  kit: string;
  head: string;
  stage: 'bump' | 'push';
  message: string;
}

/** One of the Steward's own releases that failed in a round (stages/self.ts's self-failed.json), by tag. */
export interface FailedSelf {
  commit: string;
  message: string;
}

/**
 * From the round: PRs held a while, releases the rounds gave up on, a round that couldn't run; and, while the rounds
 * roll kits out, a bump or push they gave up on, and a new kit waiting a while for the Steward itself to carry it; and,
 * while they release the Steward's own versions, one of those that failed.
 */
export function roundConditions(o: {
  round: StageResult;
  held: { employee: Employee; prs: Held[] }[];
  failedReleases: Record<string, string>;
  failedRollouts?: Record<string, FailedRollout>;
  failedSelf?: Record<string, FailedSelf>;
  rolloutWaits?: { kit: string; own: string } | null;
  /** Releases the Aletaster's tasting holds (tasting.ts's tasting-held.json), by employee. */
  tastingHolds?: Record<string, TastingHold>;
  employees: Employee[];
  settings: Settings;
}): Condition[] {
  const out: Condition[] = [];
  const wait = o.settings.alarms.waitingHours;
  for (const { employee: e, prs } of o.held) {
    for (const pr of prs) {
      out.push({
        id: `waiting:${e.repo}#${pr.number}`,
        who: e.id,
        title: `${e.name} #${pr.number} has waited ${hours(wait)} or more: ${pr.why}`,
        detail: [pr.title, pr.draft ? 'Review it, then mark it ready: the next round merges it.' : 'The Steward merges it once nothing holds it.'],
        url: pr.url,
        afterMs: wait * HOUR,
      });
    }
  }
  for (const [id, commit] of Object.entries(o.failedReleases)) {
    const e = o.employees.find((x) => x.id === id);
    const said = o.round.results.find((r) => r.id === id && r.outcome === 'failed' && r.message.startsWith('release: '))?.message.slice('release: '.length);
    out.push({
      id: `release:${id}:${commit}`,
      who: id,
      title: `${e?.name ?? id}'s release failed at ${commit}, and the rounds won't try it again`,
      detail: [...(said ? [said] : []), "Release it on the Steward's page once it's fixed, or push a new commit: the next round tries that."],
      afterMs: 0,
    });
  }
  if (o.settings.rollout) {
    for (const [id, f] of Object.entries(o.failedRollouts ?? {})) {
      const e = o.employees.find((x) => x.id === id);
      if (!e) continue;
      out.push({
        id: `rollout:${id}:${f.kit}`,
        who: id,
        title: `${e.name}'s ${f.stage} to kit ${f.kit} failed, and the rounds won't try it again until its branch moves`,
        detail: [
          f.message,
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
        title: `${e.name} v${hold.version} has waited ${hours(h)} or more for the Aletaster's tasting`,
        detail: [hold.why, `Fix what the tasting found and push to ${e.branch} (the next round asks again), or switch off "Waits for the Aletaster's tasting" in the Steward's Settings to release without it.`],
        url: hold.url,
        since: hold.since,
        afterMs: h * HOUR,
      });
    }
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
    return [{ id: 'manor:down', who: 'manor', title: "Manor's page doesn't answer", detail: [why, 'Open Manor from the Start menu, or restart the PC: its sign-in task starts it.'], afterMs: HOUR }];
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
/** Windows PowerShell's own AppUserModelID, so a toast needs no registered app (as Reeve's). */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
// Text arrives in environment variables and is XML-escaped in PowerShell, so nothing is spliced into code.
const TOAST_PS = `$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
function E([string]$s) { [System.Security.SecurityElement]::Escape($s) }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast activationType=""protocol"" launch=""$(E $env:STEWARD_TOAST_LAUNCH)""><visual><binding template=""ToastGeneric""><text>$(E $env:STEWARD_TOAST_TITLE)</text><text>$(E $env:STEWARD_TOAST_BODY)</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:STEWARD_TOAST_APPID).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

export type Toast = (title: string, body: string) => Promise<void>;

/** A Windows toast that opens the Steward's page. Never under node --test. */
export const toast: Toast = (title, body) => {
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile(
      powershellExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(TOAST_PS, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, env: { ...process.env, STEWARD_TOAST_TITLE: title.slice(0, 120), STEWARD_TOAST_BODY: body.slice(0, 400), STEWARD_TOAST_APPID: POWERSHELL_AUMID, STEWARD_TOAST_LAUNCH: `${pageUrl}#alarms` } },
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
  o: Parameters<typeof roundConditions>[0] & { log: (line: string) => void },
  deps: { getJson?: GetJson; toast?: Toast; now?: Date; manorUrl?: string | null; reeveInstalled?: () => boolean } = {},
): Promise<AlarmState> {
  const a = o.settings.alarms;
  if (!a.on) return loadAlarms();
  const get = deps.getJson ?? getJson;
  const conditions = roundConditions(o);
  const manor = deps.manorUrl === undefined ? a.manorUrl : deps.manorUrl;
  if (manor) conditions.push(...manorConditions(await get(new URL('/api/state', manor).href)));
  if (a.surveyorUrl) conditions.push(...surveyorConditions(await get(new URL('/api/survey', a.surveyorUrl).href), o.settings));
  if (a.wrightUrl) conditions.push(...wrightConditions(await get(new URL('/api/work', a.wrightUrl).href)));
  let reeveJobs: Set<string> | null = null;
  if (a.reeveUrl && (deps.reeveInstalled ?? reeveInstalled)()) {
    const r = reeveConditions(await get(new URL('/api/alerts', a.reeveUrl).href));
    conditions.push(...r.conditions);
    reeveJobs = r.jobs;
  }
  const { state, raised } = reconcile(loadAlarms(), withoutReeveDuplicates(conditions, reeveJobs), deps.now ?? new Date());
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
