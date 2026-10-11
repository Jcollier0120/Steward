import { runRoundsSoon } from './schedule.ts';

/**
 * Repairs another agent can ask this one for (kit 2.51.0): the Surveyor, finding something this agent can put right
 * itself (its rounds stuck, its model server hung), asks it to, instead of showing the person a fix to follow. Only
 * when the repair fails, or the agent says it needs the person, does the Surveyor show it.
 *
 * - `POST /api/repair` with `{ kind, finding?, detail? }`, behind the page's token as every POST (server.ts). It answers
 *   `{ ok, did, needsYou? }`: whether it is in hand, what it did in a few words, and, when only the person can put it
 *   right, what they must do.
 * - `/api/ping`'s `repairs` lists the kinds it takes, so an asker sends only those.
 * - Every agent takes `round`: its scheduled rounds start now, at the pace (schedule.ts's runSoon), for rounds that
 *   stopped coming or have gone stale. An agent adds its own with onRepair().
 * - askRepair() is the asker's side: the page's token read from its page, as its own script reads it, then the POST.
 */

export interface RepairAsk {
  kind: string;
  /** The finding it answers (the Surveyor's id), for the agent's log. */
  finding?: string;
  detail?: string;
}

export interface RepairAnswer {
  /** In hand: done, or under way. */
  ok: boolean;
  /** What it did, or why it couldn't, in a few words. */
  did: string;
  /** Only the person can put it right: what they must do. */
  needsYou?: string;
}

export type Repairer = (ask: RepairAsk) => RepairAnswer | Promise<RepairAnswer>;

const repairers = new Map<string, Repairer>();

const runRound: Repairer = () => {
  const started = runRoundsSoon();
  return started.length
    ? { ok: true, did: `started ${started.length === 1 ? 'a round' : `${started.length} rounds`} (${started.join(', ')})` }
    : { ok: false, did: 'no round could start now (one is under way, it is off duty, or it waits for its settings)' };
};

/** Takes a repair of this kind from now on; the agent's own replaces the kit's. */
export function onRepair(kind: string, repairer: Repairer): void {
  repairers.set(kind, repairer);
}

/** The kinds it takes, as /api/ping lists them. */
export const repairKinds = (): string[] => [...new Set(['round', ...repairers.keys()])].sort();

/** Does the repair asked for; an unknown kind, or one that throws, is no repair. */
export async function repair(ask: unknown): Promise<RepairAnswer> {
  const a = (ask && typeof ask === 'object' ? ask : {}) as Partial<RepairAsk>;
  const kind = typeof a.kind === 'string' ? a.kind : '';
  const r = repairers.get(kind) ?? (kind === 'round' ? runRound : null);
  if (!r) return { ok: false, did: `it takes no repair "${kind.slice(0, 40)}"` };
  try {
    const out = await r({ kind, finding: typeof a.finding === 'string' ? a.finding.slice(0, 200) : undefined, detail: typeof a.detail === 'string' ? a.detail.slice(0, 2000) : undefined });
    return { ok: !!out.ok, did: String(out.did ?? '').slice(0, 300), ...(out.needsYou ? { needsYou: String(out.needsYou).slice(0, 500) } : {}) };
  } catch (e) {
    return { ok: false, did: `the repair failed: ${(e as Error).message}`.slice(0, 300) };
  }
}

const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost|[\w-]+\.localhost)(:\d+)?(\/|$)/i;

/**
 * Asks the agent whose page is at `origin` for a repair: its token read from its page (`<meta name="page-token">`), then
 * the POST, with no Origin, as a script that read the page. `{ error }` when it couldn't be asked: not a local page, no
 * answer, no token, or an agent older than kit 2.51.0 (404).
 */
export async function askRepair(origin: string, ask: RepairAsk, o: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<RepairAnswer | { error: string }> {
  if (!LOCAL.test(origin)) return { error: 'not a local page' };
  const f = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;
  try {
    const page = await f(new URL('/', origin), { signal: AbortSignal.timeout(timeoutMs) });
    const token = /<meta name="page-token" content="([0-9A-Za-z_-]{16,200})">/.exec(await page.text())?.[1];
    if (!token) return { error: `its page (HTTP ${page.status}) carries no token` };
    const r = await f(new URL('/api/repair', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': token },
      body: JSON.stringify(ask),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 404) return { error: 'it takes no repairs (a kit before 2.51.0)' };
    const j = (await r.json().catch(() => null)) as RepairAnswer | null;
    if (!r.ok || !j || typeof j.ok !== 'boolean') return { error: `HTTP ${r.status}` };
    return { ok: j.ok, did: String(j.did ?? ''), ...(j.needsYou ? { needsYou: String(j.needsYou) } : {}) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
