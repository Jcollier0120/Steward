import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { exchequerUrl } from './kit/exchequer.ts';
import { manorHome } from './kit/manor.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Employee, Settings } from './settings.ts';
import { checkoutOf, result, type EmployeeResult } from './stages/common.ts';

/**
 * Taking turns with the other PCs on this licence (the Exchequer's docs/MULTI-PC.md). Every PC of a licence may run a
 * Steward signed in to the same GitHub account; without turns, two of them merge and release the same PRs.
 *
 * Before a stage merges or releases, it takes the Exchequer's lease `steward-round` on each repository it would act
 * in that has a checkout on this PC, all in one call, for three rounds' time. A repository another PC holds is left
 * alone: nothing merged, released, refreshed or rolled out there, and the page says which PC does it, with "Do it
 * here" (a handover). Before each merge and release the lease is checked again, and renewed when it nears its end.
 *
 * - No licence.json (development setups, older installs), or the Exchequer answering 404 (it doesn't coordinate yet)
 *   or 401 (this PC's place was given back): no turns at all; everything is exactly as before.
 * - The Exchequer unreachable (the network, a 5xx, a 429): a lease this PC held is kept until it runs out, less a
 *   margin; no new one is taken. The worst case is a slow round, never a double merge.
 *
 * What the last answer said is kept in leases.json, for that and for the page.
 */

export const SCOPE = 'steward-round';
/** A lease lasts three rounds, and never less than this. */
const MIN_TTL_S = 15 * 60;
const MAX_TTL_S = 24 * 3600;
/** A lease nearer its end than this is renewed before a merge or release. */
const RENEW_MS = 5 * 60_000;
/** Offline, a lease held is trusted only until this long before its end: the Exchequer's clock and this PC's may differ. */
const MARGIN_MS = 2 * 60_000;
const ASK_MS = 15_000;

/** Where the Exchequer is, and this PC's token for it. */
export interface Coord {
  base: string;
  token: string;
  fetch: typeof fetch;
  now?: () => number;
}

/** This PC's licence token (Manor's licence.json), or null when it holds none. */
export function licenceToken(home = manorHome()): string | null {
  const file = path.join(home, 'licence.json');
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as { token?: unknown };
    return typeof j.token === 'string' && j.token.trim() ? j.token.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The Exchequer as this PC reaches it, or null when there are no turns to take: no licence here. Under node --test
 * never the real one: a test gives its own.
 */
export function coordHere(env: NodeJS.ProcessEnv = process.env): Coord | null {
  if (env.NODE_TEST_CONTEXT) return null;
  const token = licenceToken();
  return token ? { base: exchequerUrl(env), token, fetch: globalThis.fetch } : null;
}

/** What one call came to: an answer, no coordination (404, 401), the Exchequer out of reach, or another refusal. */
export type Asked = { kind: 'ok'; body: any } | { kind: 'off'; why: string } | { kind: 'unreachable'; why: string } | { kind: 'refused'; status: number; body: any };

/** One call to the Exchequer's API: never throws, and never says the token. */
export async function ask(c: Coord, method: string, route: string, body?: unknown): Promise<Asked> {
  let res: Response;
  try {
    res = await c.fetch(`${c.base}/api/v1${route}`, {
      method,
      headers: { authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ASK_MS),
    });
  } catch (e) {
    return { kind: 'unreachable', why: `the Exchequer didn't answer (${(e as Error).name === 'TimeoutError' ? 'no answer in 15 s' : (e as Error).message})` };
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.ok) return { kind: 'ok', body: json };
  if (res.status === 404) return { kind: 'off', why: "the Exchequer doesn't take turns between PCs yet" };
  if (res.status === 401) return { kind: 'off', why: "the Exchequer doesn't know this PC's licence any more (its place was given back?)" };
  if (res.status === 429 || res.status >= 500) return { kind: 'unreachable', why: `the Exchequer answered ${res.status}${json?.message ? `: ${String(json.message).slice(0, 200)}` : ''}` };
  return { kind: 'refused', status: res.status, body: json };
}

/** Why an answer that wasn't a lease is none, in a few words. */
const refusal = (r: Asked) => (r.kind === 'refused' ? `${r.status}${r.body?.message ? `: ${String(r.body.message).slice(0, 200)}` : ''}` : 'an answer it could not read');

/** One repository's lease, as the last answer said. */
export interface LeaseSeen {
  repo: string;
  held: boolean;
  until: string;
  since?: string;
  holder?: { deviceId: string; name: string };
}

export interface LeaseState {
  /** When the Exchequer was last asked. */
  at: string | null;
  /** on: turns are taken; off: none (no licence, or the Exchequer doesn't coordinate); unreachable: as on, from what was known. */
  mode: 'on' | 'off' | 'unreachable';
  note: string | null;
  /** By repository, in lower case. */
  leases: Record<string, LeaseSeen>;
}

export const leasesFile = () => dataFile('leases.json');
export const loadLeases = (): LeaseState => ({ at: null, mode: 'off', note: null, leases: {}, ...readJson<Partial<LeaseState>>(leasesFile(), {}) });
const key = (repo: string) => repo.toLowerCase();

/** A lease's length for Settings' rounds: three of them, at least 15 minutes. */
export const ttlFor = (s: Pick<Settings, 'roundMinutes'>) => Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.round(3 * (s.roundMinutes || 10) * 60)));

/** Whether a lease this PC held is still its own, by the clock alone (offline). */
const stillMine = (l: LeaseSeen | undefined, now: number, margin: number) => !!l?.held && Date.parse(l.until) - margin > now;

/** The words for a repository another PC looks after. */
export const doneBy = (e: Pick<Employee, 'name'>, holder: string) => `merging and releasing for ${e.name}: done by ${holder || 'another PC'}`;

/** Before each merge and release: whether this PC may still act in an employee's repository. */
export interface LeaseGuard {
  ok(e: Pick<Employee, 'id' | 'repo'>): Promise<boolean>;
  /** The employees left to other PCs, or to none, this stage. */
  skip: Set<string>;
}

function readAnswer(a: any, now: number): LeaseSeen | null {
  if (!a || typeof a.resource !== 'string' || typeof a.until !== 'string') return null;
  return a.held === true
    ? { repo: a.resource, held: true, until: a.until, since: typeof a.since === 'string' ? a.since : new Date(now).toISOString() }
    : { repo: a.resource, held: false, until: a.until, holder: { deviceId: String(a.holder?.deviceId ?? ''), name: String(a.holder?.name ?? '') } };
}

/**
 * The turns this stage takes: of `employees`, those this PC acts in, and a line for each it leaves to another PC (or,
 * while the Exchequer can't be reached, to none). With no coordination, all of them act, as before.
 */
export async function takeTurns(employees: Employee[], o: { coord: Coord | null; settings: Pick<Settings, 'roundMinutes'>; log?: (line: string) => void }): Promise<{ acting: Employee[]; elsewhere: EmployeeResult[]; guard: LeaseGuard | null; mode: LeaseState['mode'] }> {
  const log = o.log ?? (() => {});
  const c = o.coord;
  const nowOf = () => c?.now?.() ?? Date.now();
  const state = loadLeases();
  if (!c) {
    if (state.mode !== 'off' || Object.keys(state.leases).length) writeJson(leasesFile(), { at: null, mode: 'off', note: null, leases: {} } satisfies LeaseState);
    return { acting: employees, elsewhere: [], guard: null, mode: 'off' };
  }
  const ttlSeconds = ttlFor(o.settings);
  const here = employees.filter((e) => e.checkout && existsSync(checkoutOf(e)));
  const repos = [...new Set(here.map((e) => key(e.repo)))];
  let mode: LeaseState['mode'] = state.mode;
  let note: string | null = state.note;
  const leases: Record<string, LeaseSeen> = { ...state.leases };
  if (repos.length) {
    const r = await ask(c, 'POST', '/lease', { scope: SCOPE, resources: repos, ttlSeconds });
    const now = nowOf();
    if (r.kind === 'ok' && Array.isArray(r.body?.leases)) {
      mode = 'on';
      note = null;
      for (const a of r.body.leases) {
        const seen = readAnswer(a, now);
        if (seen) leases[key(seen.repo)] = seen;
      }
    } else if (r.kind === 'off') {
      mode = 'off';
      note = r.why;
    } else {
      mode = 'unreachable';
      note = r.kind === 'unreachable' ? r.why : `the Exchequer refused the turns (${refusal(r)})`;
      log(`turns: ${note}; a repository this PC held is kept until its turn runs out, and no new one is taken`);
    }
    writeJson(leasesFile(), { at: new Date(now).toISOString(), mode, note, leases } satisfies LeaseState);
  }
  if (mode === 'off') return { acting: employees, elsewhere: [], guard: null, mode };

  const now = nowOf();
  const acting: Employee[] = [];
  const elsewhere: EmployeeResult[] = [];
  const seenIds = new Set<string>();
  for (const e of employees) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    const l = leases[key(e.repo)];
    if (!here.includes(e)) elsewhere.push(result(e, 'skipped', `no checkout of ${e.name} on this PC, so a PC with one merges and releases it`));
    else if (mode === 'on' ? l?.held && Date.parse(l.until) > now : stillMine(l, now, MARGIN_MS)) acting.push(e);
    else if (l && !l.held && Date.parse(l.until) > now) elsewhere.push(result(e, 'skipped', doneBy(e, l.holder?.name ?? '')));
    else elsewhere.push(result(e, 'skipped', `merging and releasing for ${e.name} waits: ${note ?? "the Exchequer can't be reached"}, and this PC holds no turn there`));
  }
  const skip = new Set(elsewhere.map((r) => r.id));
  const given = new Set(acting.map((e) => e.id));
  const guard: LeaseGuard = {
    skip,
    async ok(e) {
      // Only a repository this stage took its turn in.
      if (skip.has(e.id) || !given.has(e.id)) return false;
      const k = key(e.repo);
      const cur = loadLeases();
      const l = cur.leases[k];
      const t = nowOf();
      if (l?.held && Date.parse(l.until) - RENEW_MS > t) return true;
      // Near its end: renewed, or, out of reach, trusted only until its end less the margin.
      const r = await ask(c, 'POST', '/lease', { scope: SCOPE, resource: k, ttlSeconds });
      if (r.kind === 'off') return true;
      if (r.kind === 'ok' && typeof r.body?.until === 'string') {
        const seen = readAnswer({ ...r.body, resource: k }, t)!;
        writeJson(leasesFile(), { ...cur, at: new Date(t).toISOString(), mode: 'on', leases: { ...cur.leases, [k]: seen } } satisfies LeaseState);
        if (!seen.held) skip.add(e.id);
        return seen.held;
      }
      const mine = stillMine(l, t, MARGIN_MS);
      if (!mine) skip.add(e.id);
      return mine;
    },
  };
  return { acting, elsewhere, guard, mode };
}

/**
 * "Do it here": this PC takes an employee's lease now, whoever held it. The other PC's next round finds it held here,
 * and leaves the repository alone. Says what happened, in words.
 */
export async function handOver(repo: string, o: { coord: Coord | null; settings: Pick<Settings, 'roundMinutes'> }): Promise<{ ok: boolean; message: string }> {
  if (!o.coord) return { ok: false, message: 'This PC holds no licence, so there are no turns to take: it merges and releases everything it looks after.' };
  const k = key(repo);
  const r = await ask(o.coord, 'POST', '/lease/handover', { scope: SCOPE, resource: k, ttlSeconds: ttlFor(o.settings) });
  const now = o.coord.now?.() ?? Date.now();
  if (r.kind === 'ok' && typeof r.body?.until === 'string') {
    const cur = loadLeases();
    writeJson(leasesFile(), { ...cur, at: new Date(now).toISOString(), mode: 'on', leases: { ...cur.leases, [k]: { repo: k, held: true, until: r.body.until, since: r.body.since } } } satisfies LeaseState);
    const from = r.body.from?.name ? ` from ${r.body.from.name}` : '';
    return { ok: true, message: `This PC merges and releases ${repo} now${from}.` };
  }
  if (r.kind === 'off') return { ok: false, message: `There are no turns to take: ${r.why}.` };
  return { ok: false, message: r.kind === 'unreachable' ? `Not now: ${r.why}. Try again in a minute.` : `The Exchequer refused (${refusal(r)}).` };
}

/** The page's view of the turns: the repositories another PC looks after, and why turns are off or out of reach. */
export interface TurnsView {
  mode: LeaseState['mode'];
  note: string | null;
  at: string | null;
  elsewhere: { id: string; name: string; repo: string; holder: string; until: string }[];
  here: number;
}

export function turnsView(employees: Pick<Employee, 'id' | 'name' | 'repo'>[], now = Date.now()): TurnsView | null {
  const s = loadLeases();
  if (s.mode === 'off') return null;
  const elsewhere: TurnsView['elsewhere'] = [];
  let here = 0;
  for (const e of employees) {
    const l = s.leases[key(e.repo)];
    if (!l || Date.parse(l.until) <= now) continue;
    if (l.held) here++;
    else elsewhere.push({ id: e.id, name: e.name, repo: e.repo, holder: l.holder?.name || 'another PC', until: l.until });
  }
  return { mode: s.mode, note: s.note, at: s.at, elsewhere, here };
}
