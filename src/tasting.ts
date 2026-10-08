import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandEnv } from './kit/settings-kit.ts';
import { manorHome, manorLink } from './kit/manor.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Employee, Settings } from './settings.ts';
import { pageToken, request, tokenHeaders, type HttpRequest } from './upkeep.ts';

/**
 * The Aletaster's release gate: before the Steward publishes an employee's release, it asks the Aletaster to taste the
 * very commit it would release from (POST /api/taste, with the page's token, as upkeep.ts's pokePage does), and waits
 * for the verdict (GET /api/taste?id=…). It publishes only when the tasting is done and lets the release through
 * (`release: true`); otherwise the release waits, with the tasting's reason, and the next round asks again.
 *
 * So that the gate can never stall the manor, it stands aside, and the release says so, when:
 * - the Aletaster isn't installed here (its home has no app folder), or is off duty for Developer options (Manor's
 *   Developer options off, and the Aletaster one of its developer roles): "released without a tasting: the Aletaster
 *   isn't here";
 * - the Aletaster's own Developer options are off (no Manor to decide, and its own switch off, as it is unless set):
 *   it tastes nothing then, as with its role vacant, and its /api/ping says `developer: false`;
 * - the Aletaster installed here predates the tasting (POST /api/taste answers 404 for the route itself, which carries
 *   no verdict, as against the 404 for a repository it doesn't know, which does), or its page doesn't answer at all;
 * - the release is the Aletaster's own, so a broken Aletaster can always be fixed.
 * A release held longer than the alarms' tastingHours is an alarm (alarms.ts), with the reason and a link.
 */

export const ALETASTER_URL = 'http://127.0.0.1:19191';
/** Where a person reads a tasting: the Aletaster's own host name (its guard answers to it). */
export const ALETASTER_PAGE = 'http://aletaster.localhost:19191/';

export const aletasterInstalled = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(env.ALETASTER_HOME ?? path.join(os.homedir(), '.aletaster'), 'app'));

/**
 * Whether the Aletaster's role is left vacant by Manor's Developer options: they are off (Manor's settings.json says
 * false), and Manor's staff.json counts the Aletaster among its developer roles (it does, unless that file says otherwise).
 */
export function aletasterVacant(home = manorHome()): boolean {
  const m = manorLink(home);
  if (!m || m.developerOptions !== false) return false;
  try {
    const staff = JSON.parse(readFileSync(path.join(home, 'app', 'staff.json'), 'utf8').replace(/^﻿/, ''));
    const a = Array.isArray(staff?.agents) ? staff.agents.find((x: any) => x?.id === 'aletaster') : null;
    if (a && a.developer === false) return false;
  } catch {
    // No staff.json to read: the Aletaster is a developer role.
  }
  return true;
}

/** The Aletaster's own release is never held by its tasting. */
export const isAletaster = (e: Employee) => e.id === 'aletaster' || /\/aletaster$/i.test(e.repo);

export interface TastingDeps {
  installed?: () => boolean;
  vacant?: () => boolean;
  http?: HttpRequest;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a tasting under way before leaving it to the next round (default 90 s). */
  waitMs?: number;
  /** How often to ask about it meanwhile (default 2 s). */
  pollMs?: number;
  now?: () => Date;
}

/** Go: release, with a note for its message (null for none). Hold: why, and where to read the tasting. */
export type Gate = { go: true; note: string | null } | { go: false; why: string; url: string };

/** A release the tasting holds, as tasting-held.json keeps it for the alarms. */
export interface TastingHold {
  commit: string;
  version: string;
  /** When this commit and version were first held. */
  since: string;
  why: string;
  url: string;
}

export const tastingHoldsFile = () => dataFile('tasting-held.json');
export const loadTastingHolds = () => readJson<Record<string, TastingHold>>(tastingHoldsFile(), {});

function noteHold(id: string, h: Omit<TastingHold, 'since'>, now: Date): void {
  const all = loadTastingHolds();
  const was = all[id];
  all[id] = { ...h, since: was && was.commit === h.commit && was.version === h.version ? was.since : now.toISOString() };
  writeJson(tastingHoldsFile(), all);
}

/** Forgets an employee's hold (its release went, or it no longer waits on a tasting); writes only when there was one. */
export function clearTastingHold(id: string): void {
  const all = loadTastingHolds();
  if (!(id in all)) return;
  delete all[id];
  writeJson(tastingHoldsFile(), all);
}

const without = (why: string): Gate => ({ go: true, note: `released without a tasting: ${why}` });
const parse = (body: string): any => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

/**
 * Asks the Aletaster about an employee's release of `version` from `commit` (all 40 hex). Under node --test, without
 * `deps`, it stands aside and says nothing, so no test reaches the live Aletaster.
 */
export async function tasteFirst(e: Employee, a: { commit: string; version: string }, settings: Settings, deps?: TastingDeps): Promise<Gate> {
  if (!deps && process.env.NODE_TEST_CONTEXT) return { go: true, note: null };
  const d = deps ?? {};
  const decided = (g: Gate): Gate => {
    if (g.go) clearTastingHold(e.id);
    else noteHold(e.id, { commit: a.commit, version: a.version, why: g.why, url: g.url }, (d.now ?? (() => new Date()))());
    return g;
  };
  if (!settings.tasteBeforeRelease) return decided({ go: true, note: null });
  if (isAletaster(e)) return decided(without("the Aletaster's own release is never held by its tasting"));
  if (!(d.installed ?? aletasterInstalled)()) return decided(without("the Aletaster isn't here"));
  if ((d.vacant ?? aletasterVacant)()) return decided(without("the Aletaster isn't here (its role is vacant while Manor's Developer options are off)"));

  const http = d.http ?? request;
  const base = new URL(ALETASTER_URL);
  const timeoutMs = 10_000;
  const short = a.commit.slice(0, 7);
  const hold = (why: string, id?: string | null): Gate => ({ go: false, why: `v${a.version} at ${short} waits for the Aletaster's tasting: ${why}`, url: id ? `${ALETASTER_PAGE}api/taste?id=${encodeURIComponent(id)}` : ALETASTER_PAGE });
  const down = (why: string) => decided(without(`the Aletaster's page doesn't answer (${why})`));

  // Its own Developer options off (no Manor to decide, and its own switch, which is off unless set): it tastes nothing,
  // as with its role vacant, so the release goes without a tasting rather than waiting for one that never comes. Its
  // /api/ping says so (kit 2.39.0); an older Aletaster's says nothing, and is asked as ever.
  const pinged = await http(new URL('/api/ping', base), { method: 'GET', timeoutMs });
  if (!('error' in pinged) && pinged.status === 200 && parse(pinged.body)?.developer === false) return decided(without("the Aletaster's Developer options are off, so it tastes nothing"));

  const t = await pageToken(base, { timeoutMs, http });
  if ('error' in t) return down(t.error);
  if (!('token' in t)) return decided(hold(`its page (HTTP ${t.status}) carries no token, so it can't be asked`));
  const body = JSON.stringify({ repo: e.repo, commit: a.commit, version: a.version, name: e.name, versionFiles: e.versionFiles, checkout: path.resolve(expandEnv(e.checkout)) });
  const posted = await http(new URL('/api/taste', base), { method: 'POST', headers: tokenHeaders(t.token), body, timeoutMs });
  if ('error' in posted) return down(posted.error);
  let answer = parse(posted.body);
  if (posted.status === 404 && !(answer && typeof answer === 'object' && 'verdict' in answer)) return decided(without('the Aletaster here predates /api/taste'));
  if (posted.status >= 400 || !answer || typeof answer !== 'object') {
    const said = answer && typeof answer === 'object' ? String(answer.reason ?? answer.error ?? '') : '';
    return decided(hold(said || `the Aletaster answered HTTP ${posted.status}`));
  }

  // Under way: asked about every couple of seconds, for a while; then it's the next round's to ask.
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = d.waitMs ?? 90_000;
  const pollMs = d.pollMs ?? 2000;
  let waited = 0;
  while (answer.state !== 'done') {
    if (waited >= waitMs) return decided(hold(`the tasting is still under way after ${Math.round(waitMs / 1000)} s; the next round asks again`, answer.id));
    await sleep(pollMs);
    waited += pollMs;
    const q = typeof answer.id === 'string' ? `id=${encodeURIComponent(answer.id)}` : `repo=${encodeURIComponent(e.repo)}&commit=${a.commit}`;
    const got = await http(new URL(`/api/taste?${q}`, base), { method: 'GET', timeoutMs });
    if ('error' in got) return down(got.error);
    const next = parse(got.body);
    if (got.status >= 400 || !next || typeof next !== 'object') return decided(hold(String(next?.error ?? `the Aletaster answered HTTP ${got.status}`) + '; the next round asks again', answer.id));
    answer = next;
  }
  const reason = typeof answer.reason === 'string' && answer.reason ? answer.reason : `the verdict is ${answer.verdict}`;
  if (answer.release === true) return decided({ go: true, note: `tasted by the Aletaster: ${answer.verdict}${answer.verdict === 'pass' ? '' : ` (${reason})`}` });
  return decided(hold(`${answer.verdict}: ${reason}`, answer.id));
}
