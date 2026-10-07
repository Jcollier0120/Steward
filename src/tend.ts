import { APP } from './app.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Condition, GetJson } from './alarms.ts';
import type { EmployeeResult } from './stages/common.ts';
import { pageToken, request, tokenHeaders } from './upkeep.ts';

/**
 * The staff kept answering: in each round, every agent Manor employs that is on duty but whose page doesn't answer
 * (its process ended: a crash, a failed update, a sign-in task that didn't run) has its page opened again through
 * Manor's own Open (POST /api/agents/<id>/open, with Manor's page token), which runs the agent's open command and waits
 * for its page. Its duty is never changed: an agent a person stopped (off duty) is left as it is, as is one Manor keeps
 * off duty for Developer options, one Manor is busy with, and one whose status Manor can't read. The Steward itself is
 * never in it: a round runs in its page.
 *
 * It needs only Manor, never GitHub or a clone, so it is the whole of a round on a PC where the Steward has no
 * repositories to look after (Settings name no employee with a clone here, and no checkout of its own).
 *
 * An agent is tried at most MAX_TRIES times while it stays down, RETRY_MS apart, then once an hour. Once its tries are
 * spent, or Manor has no Open for it, it is an alarm (tendConditions) until its page answers again. What it did is kept
 * in tending.json: the agents down now, and the last few brought back.
 */

export const MAX_TRIES = 3;
/** Between two tries for one agent, at least this long. */
export const RETRY_MS = 5 * 60_000;
/** Once its tries are spent, one more this often, in case what kept it down has gone. */
export const SPENT_RETRY_MS = 60 * 60_000;
/** Manor's Open waits up to 20 seconds for the page; a little more for its answer. */
const OPEN_MS = 30_000;
const KEEP_REVIVED = 20;

/** One agent as Manor's /api/state shows it, as far as tending needs. */
export interface StaffLook {
  id: string;
  name: string;
  /** On duty, but its page doesn't answer: its rounds aren't running. */
  down: boolean;
  /** Manor can open it: its registry entry has an open command whose paths exist here. */
  canOpen: boolean;
  /** Manor is starting, stopping or opening it now. */
  busy: boolean;
}

export interface DownAgent {
  name: string;
  /** When tending first saw it down. */
  since: string;
  tries: number;
  lastTry: string | null;
  /** What Manor said to the last try, or why it couldn't be tried. */
  said: string | null;
  canOpen: boolean;
}

export interface TendState {
  at: string | null;
  /** Whether Manor answered the last look: false, nothing could be seen (and nothing was done). */
  manor: boolean;
  down: Record<string, DownAgent>;
  /** The last agents brought back, newest first. */
  revived: { id: string; name: string; at: string; tries: number }[];
  /** Manor said it keeps the staff's pages up itself (manorKeeps): the Steward left them to it. */
  keptByManor?: boolean;
}

export const tendFile = () => dataFile('tending.json');

/**
 * What Manor says it keeps itself, in its /api/state's `keeps`: 'tend' (the staff's pages kept up) and 'alarms' (the
 * manor-wide alarms: Manor's own updates and page, the ports, the Surveyor's problems, Reeve's alerts, an agent down).
 * Both belong to Manor, which every PC has, whatever agents it holds: once a Manor does them, the Steward leaves them to
 * it, and keeps only the alarms of the repositories it looks after. A Manor that says nothing keeps nothing, and the
 * Steward does them as before.
 */
export function manorKeeps(state: unknown): Set<string> {
  const k = (state as any)?.keeps;
  return new Set(Array.isArray(k) ? k.filter((x: unknown): x is string => typeof x === 'string') : []);
}
export const loadTending = (): TendState => ({ at: null, manor: false, down: {}, revived: [], ...readJson<Partial<TendState>>(tendFile(), {}) });

/**
 * The agents in Manor's /api/state: each role's holder and those on duty behind it, once each, without the Steward.
 * Null when Manor gave no answer. An agent shown from an earlier look (stale) is passed over: its page may be back.
 */
export function staffFromState(state: unknown): StaffLook[] | null {
  const roles = (state as any)?.roles;
  if (!Array.isArray(roles)) return null;
  const offDuty = new Set((Array.isArray((state as any).offDuty) ? (state as any).offDuty : []).map((a: any) => a?.id));
  const out = new Map<string, StaffLook>();
  const add = (a: any) => {
    if (!a || typeof a.id !== 'string' || a.id === APP.id || out.has(a.id) || offDuty.has(a.id) || a.stale === true) return;
    // The kit's status: on duty with its page down is "stopped" with no since (service.ts's dutyStatus). Off duty has a since.
    const down = a.page?.up === false && a.state === 'stopped' && !a.since;
    out.set(a.id, { id: a.id, name: typeof a.name === 'string' ? a.name : a.id, down, canOpen: a.can?.open === true, busy: typeof a.busy === 'string' && a.busy !== '' });
  };
  for (const r of roles) {
    add(r?.holder);
    for (const b of Array.isArray(r?.behind) ? r.behind : []) add(b);
  }
  return [...out.values()];
}

/** Whether tending tries an agent now: it can be opened, isn't busy, and its last try was long enough ago. */
export function dueNow(d: DownAgent, now: number): boolean {
  if (!d.canOpen) return false;
  if (!d.lastTry) return true;
  const since = now - Date.parse(d.lastTry);
  return since >= (d.tries >= MAX_TRIES ? SPENT_RETRY_MS : RETRY_MS);
}

export type OpenAgent = (id: string) => Promise<{ ok: boolean; said: string }>;

/** Opens an agent's page through Manor, as its Open button does: Manor's token from its page, then the POST. */
export function openThroughManor(manorUrl: string): OpenAgent {
  return async (id) => {
    const origin = new URL(manorUrl);
    const t = await pageToken(origin, { timeoutMs: 5000 });
    if ('error' in t) return { ok: false, said: `Manor's page didn't answer: ${t.error}` };
    if (!('token' in t)) return { ok: false, said: `Manor's page (HTTP ${t.status}) carries no token` };
    const r = await request(new URL(`/api/agents/${encodeURIComponent(id)}/open`, origin), { method: 'POST', headers: tokenHeaders(t.token), body: '{}', timeoutMs: OPEN_MS });
    if ('error' in r) return { ok: false, said: r.error };
    let error: string | null = null;
    try {
      error = (JSON.parse(r.body) as { error?: string | null })?.error ?? null;
    } catch {
      // Not JSON: the status says it.
    }
    return r.status >= 200 && r.status < 300 && !error ? { ok: true, said: `HTTP ${r.status}` } : { ok: false, said: error ?? `HTTP ${r.status}` };
  };
}

/**
 * One look at the staff, and each agent that is down and due opened through Manor. A line for the round for each one
 * tried (done when its page is back, failed when not); none when nothing was down. Manor not answering changes nothing:
 * its page down is an alarm of its own (alarms.ts).
 */
export async function tend(o: { manorUrl: string; getJson: GetJson; open?: OpenAgent; now?: () => Date; log: (line: string) => void }): Promise<EmployeeResult[]> {
  const was = loadTending();
  const now = o.now ?? (() => new Date());
  const state = await o.getJson(new URL('/api/state', o.manorUrl).href);
  // Manor keeps its staff's pages up itself: nothing for the Steward to do, and nothing of its own to raise.
  if (manorKeeps(state).has('tend')) {
    writeJson(tendFile(), { at: now().toISOString(), manor: true, down: {}, revived: was.revived, keptByManor: true } satisfies TendState);
    return [];
  }
  const staff = staffFromState(state);
  if (!staff) {
    writeJson(tendFile(), { ...was, at: now().toISOString(), manor: false });
    return [];
  }
  const open = o.open ?? openThroughManor(o.manorUrl);
  const down: Record<string, DownAgent> = {};
  const revived = [...was.revived];
  const results: EmployeeResult[] = [];
  for (const a of staff) {
    const before = was.down[a.id];
    if (!a.down) {
      // Back by itself, or by a person, since the last look: nothing to keep.
      continue;
    }
    const d: DownAgent = before ? { ...before, name: a.name, canOpen: a.canOpen } : { name: a.name, since: now().toISOString(), tries: 0, lastTry: null, said: null, canOpen: a.canOpen };
    if (!a.canOpen) d.said = "Manor has no Open for it here: its entry has no open command, or the paths it needs aren't on this PC";
    if (a.busy || !dueNow(d, now().getTime())) {
      down[a.id] = d;
      continue;
    }
    const r = await open(a.id).catch((e: Error) => ({ ok: false, said: e.message }));
    d.tries += 1;
    d.lastTry = now().toISOString();
    d.said = r.said;
    if (r.ok) {
      revived.unshift({ id: a.id, name: a.name, at: d.lastTry, tries: d.tries });
      o.log(`[${a.id}] its page wasn't answering while on duty: opened it again through Manor`);
      results.push({ id: a.id, name: a.name, outcome: 'done', message: "tend: its page wasn't answering while on duty, so the Steward opened it again through Manor" });
      continue;
    }
    down[a.id] = d;
    o.log(`[${a.id}] its page doesn't answer while on duty, and opening it through Manor failed (try ${d.tries}): ${r.said}`);
    // Each try is said while there are tries left; after that, the alarm says it, and the round stays quiet.
    if (d.tries <= MAX_TRIES) results.push({ id: a.id, name: a.name, outcome: 'failed', message: `tend: its page doesn't answer while on duty, and opening it through Manor failed (try ${d.tries} of ${MAX_TRIES}): ${r.said}` });
  }
  writeJson(tendFile(), { at: now().toISOString(), manor: true, down, revived: revived.slice(0, KEEP_REVIVED) } satisfies TendState);
  return results;
}

/** The alarms tending raises: an agent down whose tries are spent, or that Manor can't open. At once. */
export function tendConditions(state: TendState): Condition[] {
  if (!state.manor) return [];
  return Object.entries(state.down)
    .filter(([, d]) => !d.canOpen || d.tries >= MAX_TRIES)
    .map(([id, d]) => ({
      id: `tend:${id}`,
      who: id,
      title: `${d.name} is on duty, but its page doesn't answer and the Steward couldn't open it again`,
      detail: [
        ...(d.said ? [d.said] : []),
        d.canOpen ? `Tried ${d.tries} times; it tries again once an hour.` : 'It can only be started by hand.',
        "Open it from Manor, or look at the end of serve.log in its data folder (%USERPROFILE%\\.<its id>) for why it stopped.",
      ],
      since: d.since,
      afterMs: 0,
    }));
}
