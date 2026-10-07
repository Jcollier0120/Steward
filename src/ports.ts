import path from 'node:path';
import { showFile } from './git.ts';
import { withLock } from './kit/lock.ts';
import { manorHome } from './kit/manor.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Condition } from './alarms.ts';
import type { Employee } from './settings.ts';
import type { Runner } from './run.ts';
import { checkoutOf } from './stages/common.ts';

/**
 * Ports claimed up front, as versions are (claims.ts). Every agent's page has a port of its own (its src/app.ts, and
 * its Manor entry's home and ping), and Manor never offers an agent whose port another already has. New agents were
 * given one by whoever started them, each looking only at the clones on their PC: the Assayer took the Shepherd's
 * 20707, and its role sat in Manor with no one to hire. Now a worker asks the Steward before it writes one:
 * `node src\cli.ts claim-port <agent id> --branch <b> --for "<what>"`. The Steward knows every port in use (Manor's
 * staff, this PC's own staff, the agents announced on GitHub, each employee's src/app.ts on its branch, Manor's own,
 * and every live claim), and hands out the next free one of the series agents use (19090, 19191, … 20808, 20909,
 * 21010, …), whose development twin (+10000) is free too. An agent that has a port already keeps it; asking again
 * for the same agent returns the same claim. One machine-wide lock makes claims one at a time.
 *
 * A claim lives until the agent's own port shows where Manor or its clone says it (the work landed), until it is
 * given back (`release-port`), or for PORT_CLAIM_DAYS. Each round also raises an alarm for two agents on one port.
 */

export type PortSource = 'manor' | 'staff' | 'this PC' | 'announced' | 'clone' | 'claim';

export interface PortUse {
  port: number;
  /** The agent's id ('manor' for Manor itself). */
  id: string;
  source: PortSource;
}

export interface PortClaim {
  id: string;
  port: number;
  branch: string | null;
  by: string;
  for: string;
  at: string;
}

/** A checkout serves on its port + this (Manor's INSTALLING.md): that twin must be free too. */
export const DEV_OFFSET = 10000;
/** Manor's own page. */
export const MANOR_PORT = 18585;
export const PORT_CLAIM_DAYS = 14;
const DAY = 86_400_000;

export const portClaimsFile = () => dataFile('port-claims.json');
const portClaimsLock = () => dataFile('locks', 'port-claims');
export const loadPortClaims = (): PortClaim[] => readJson<PortClaim[]>(portClaimsFile(), []);

/** The port of a URL (an entry's home or ping), or null. */
export function portOfUrl(u: unknown): number | null {
  if (typeof u !== 'string') return null;
  try {
    const p = Number(new URL(u).port);
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** The port an agent's src/app.ts gives its page: placeFor({ … port: 19393 … }), or a DEFAULT_PORT constant. */
export function appPort(text: string | null): number | null {
  if (!text) return null;
  const m = /placeFor\(\{[^}]*?\bport:\s*(\d{4,5})\b/.exec(text) ?? /\bDEFAULT_PORT\s*=\s*(\d{4,5})\b/.exec(text);
  return m ? Number(m[1]) : null;
}

const entries = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);

/** The ports of a list of Manor entries (staff.json's agents, staff.local.json's, announced.json's). */
function entryUses(list: Record<string, unknown>[], source: PortSource): PortUse[] {
  const out: PortUse[] = [];
  for (const a of list) {
    if (typeof a.id !== 'string') continue;
    for (const port of new Set([portOfUrl(a.home), portOfUrl(a.ping)].filter((p): p is number => p !== null))) out.push({ port, id: a.id, source });
  }
  return out;
}

/** What Manor knows on this PC: its own port, its staff, this PC's own staff, and the agents announced on GitHub. */
export function manorUses(home = manorHome()): PortUse[] {
  const staff = readJson<{ agents?: unknown } | null>(path.join(home, 'app', 'staff.json'), null);
  const local = readJson<{ agents?: unknown } | null>(path.join(home, 'staff.local.json'), null);
  const announced = readJson<{ agents?: unknown } | null>(path.join(home, 'announced.json'), null);
  return [
    { port: MANOR_PORT, id: 'manor', source: 'manor' },
    ...entryUses(entries(staff?.agents), 'staff'),
    ...entryUses(entries(local?.agents), 'this PC'),
    ...entryUses(entries(announced?.agents).map((a) => (a.agent && typeof a.agent === 'object' ? (a.agent as Record<string, unknown>) : {})), 'announced'),
  ];
}

/** What each employee's clone says on its branch (as origin had it at the last fetch): src/app.ts, else manor-agent.json. */
export async function cloneUses(run: Runner, employees: Employee[]): Promise<PortUse[]> {
  const out: PortUse[] = [];
  for (const e of employees) {
    if (!e.checkout) continue;
    try {
      const repo = checkoutOf(e);
      const ref = `origin/${e.branch}`;
      let port = appPort(await showFile(run, repo, ref, 'src/app.ts'));
      if (port === null) {
        const announce = await showFile(run, repo, ref, 'manor-agent.json');
        port = announce ? portOfUrl((JSON.parse(announce.replace(/^﻿/, '')) as { agent?: { home?: unknown } })?.agent?.home) : null;
      }
      if (port !== null) out.push({ port, id: e.id, source: 'clone' });
    } catch {
      // A clone that can't be read says nothing; Manor's lists still do.
    }
  }
  return out;
}

/** The port after `p` in the agents' series: the last four digits a two-digit number twice (19090, 19191, … 20909, 21010). */
export function seriesAfter(p: number): number {
  let m = Math.floor(p / 10000) * 100 + Math.floor((p % 10000) / 101);
  for (;;) {
    m++;
    const tail = m % 100;
    // x0000 and x0101 are left out, as the series always has: round numbers other programs pick.
    if (tail < 2) continue;
    const port = Math.floor(m / 100) * 10000 + tail * 101;
    if (port + DEV_OFFSET > 65535) throw new Error('No port left in the series');
    if (port > p) return port;
  }
}

/** The next free port: above every agent port in use, free with its development twin. */
export function nextPort(uses: PortUse[]): number {
  const taken = new Set(uses.map((u) => u.port));
  const agentPorts = uses.map((u) => u.port).filter((p) => p >= 19000 && p < 19000 + DEV_OFFSET);
  let p = seriesAfter(Math.max(19000, ...agentPorts));
  while (taken.has(p) || taken.has(p + DEV_OFFSET)) p = seriesAfter(p);
  return p;
}

/** The ports two or more agents use: each with its agents, and where each says so. */
export function clashes(uses: PortUse[]): { port: number; ids: string[]; where: string[] }[] {
  const byPort = new Map<number, PortUse[]>();
  for (const u of uses) byPort.set(u.port, [...(byPort.get(u.port) ?? []), u]);
  // An agent's development twin is its own: two agents meet there only when their ports do.
  return [...byPort]
    .map(([port, list]) => ({ port, ids: [...new Set(list.map((u) => u.id))], where: [...new Set(list.map((u) => `${u.id} (${u.source})`))] }))
    .filter((c) => c.ids.length > 1)
    .sort((a, b) => a.port - b.port);
}

/** The claims still live: not landed (the agent's port shows outside the claims), not older than PORT_CLAIM_DAYS. */
export function liveClaims(claims: PortClaim[], uses: PortUse[], now: number): PortClaim[] {
  return claims.filter((c) => now - Date.parse(c.at) < PORT_CLAIM_DAYS * DAY && !uses.some((u) => u.id === c.id && u.port === c.port));
}

export interface PortAnswer {
  port: number;
  /** It has this port already (Manor or its clone says so): nothing was claimed. */
  already: PortUse | null;
  claim: PortClaim | null;
  /** The same claim as before. */
  again: boolean;
}

/** A port for an agent, claimed: as the module's comment says. `uses` are what the Steward found in use (manorUses, cloneUses). */
export async function claimPort(o: { id: string; branch?: string | null; by: string; for: string; uses: PortUse[]; now?: number }): Promise<PortAnswer> {
  if (!/^[a-z][a-z0-9-]*$/.test(o.id)) throw new Error(`${o.id} isn't an agent id: lowercase letters, digits and dashes`);
  const now = o.now ?? Date.now();
  const own = o.uses.find((u) => u.id === o.id && u.source !== 'claim');
  return withLock(portClaimsLock(), async () => {
    const live = liveClaims(loadPortClaims(), o.uses, now);
    if (own) {
      writeJson(portClaimsFile(), live);
      return { port: own.port, already: own, claim: null, again: false };
    }
    // One port an agent: its claim from any branch is the one it gets.
    const had = live.find((c) => c.id === o.id);
    if (had) {
      writeJson(portClaimsFile(), live);
      return { port: had.port, already: null, claim: had, again: true };
    }
    const port = nextPort([...o.uses, ...live.map((c): PortUse => ({ port: c.port, id: c.id, source: 'claim' }))]);
    const claim: PortClaim = { id: o.id, port, branch: o.branch ?? null, by: o.by, for: o.for, at: new Date(now).toISOString() };
    writeJson(portClaimsFile(), [...live, claim]);
    return { port, already: null, claim, again: false };
  });
}

/** Gives an agent's claim back; false when it had none. */
export async function releasePort(id: string): Promise<boolean> {
  return withLock(portClaimsLock(), async () => {
    const all = loadPortClaims();
    const left = all.filter((c) => c.id !== id);
    if (left.length === all.length) return false;
    writeJson(portClaimsFile(), left);
    return true;
  });
}

/** Every port in use and claimed, for `ports` and the round: Manor's lists, the clones, and the live claims. */
export async function portUses(run: Runner, employees: Employee[], o: { home?: string; now?: number } = {}): Promise<PortUse[]> {
  const found = [...manorUses(o.home), ...(await cloneUses(run, employees))];
  const live = liveClaims(loadPortClaims(), found, o.now ?? Date.now());
  return [...found, ...live.map((c): PortUse => ({ port: c.port, id: c.id, source: 'claim' }))];
}

/**
 * An alarm for each port two agents have, as their own sources say (before either is installed: Manor never offers
 * the second, and its role sits empty). Installed agents that clash are Manor's summary's (alarms.ts's portConditions).
 */
export function portClashConditions(uses: PortUse[]): Condition[] {
  return clashes(uses).map((c) => ({
    id: `port-plan:${c.port}`,
    who: c.ids[0],
    title: `${c.ids.join(' and ')} have the same port, ${c.port}`,
    detail: [
      `Where each says so: ${c.where.join(', ')}.`,
      'Manor offers only one of them for hire, and only one page can start there.',
      `Move one with a release of its own: \`node src\\cli.ts claim-port ${c.ids.at(-1)}\` gives it a free port, for its src/app.ts and its Manor entry's home and ping.`,
    ],
    afterMs: 0,
  }));
}
