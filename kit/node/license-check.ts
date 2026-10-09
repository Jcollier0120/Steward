import type { JsonWebKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { LICENSE_FILE, readHeldFile, trustedKeys, verifyLicense, type LicensePayload } from './license.ts';
import { MANOR_DEFAULT_NAME, manorHome, manorLink } from './manor.ts';
import { dataFile, readJson, writeJson } from './store.ts';

/**
 * The trial's end, checked by the agent itself (kit 2.45.0). Manor takes the staff it sells off duty when a 7-day trial
 * ends (its developer.ts settleLicenseDuty); this is the same rule inside each agent, so an agent started by hand
 * (its scheduled task, its CLI) doesn't run past the trial either.
 *
 * Who checks: only an agent the Exchequer sells. Manor knows which those are from the Exchequer's GET /agents, which it
 * keeps in its exchequer.json (`agents`: each id with its tier); an agent checks when its own id is there as `household`
 * or `workshop`, and Manor's staff.json doesn't hold it back or mark it internal (as Manor's soldTiers has it). Manor
 * and Heiward, which are free, never check, and nor does an internal agent (the Wright, the Bailiff), which the
 * Exchequer never lists. No exchequer.json, or one that can't be read: it doesn't check. When in doubt, it runs.
 *
 * What it reads: Manor's licence.json, verified offline against the public keys (license.ts). It never asks the
 * Exchequer: Manor fetches the license, and refreshes it every hour.
 *
 * Only one thing holds an agent: a license that verifies, of the trial tier, whose `runsUntil` has passed. Then its
 * rounds wait (schedule.ts), Run now with them, its page says "The trial ended: a license brings it back", and its
 * ping says it isn't running. Its settings and data are kept, its page stays up, and duty.json isn't touched: once
 * a license is here, the hold lifts by itself, and Manor's Start brings it back on duty as before.
 *
 * Everything else runs as it did: a paid license, one that lapsed (the Freehold license: what was released before
 * its paid time ended keeps running, forever), one of another tier (Manor handles that, by not offering its updates),
 * one still waiting for its first payment. And when the license can't be judged (no licence.json, one that can't be
 * read, one whose signature doesn't verify), it runs too, and its ping's `license.problem` says why; never an alarm.
 *
 * The clock: the time is taken as the latest of this PC's clock, the license's own `iat` (the Exchequer's clock when
 * it signed it, which Manor refreshes every hour), and the latest time this agent has seen (kept in its data folder,
 * license-check.json, for a trial only). So setting the clock back doesn't bring an ended trial back.
 *
 * When: as the agent starts (serve() calls startLicenseCheck()), then every hour, and whenever licence.json changes
 * (its size or time), so a new license lifts the hold at once. Whether the trial's end has passed is worked out
 * afresh at each use (a round, a ping, the page), from the license last read.
 */

/** What the page says, in plain words, when the trial has ended. */
export const TRIAL_ENDED_TEXT = 'The trial ended: a license brings it back';

/** How often it reads the license again, unless licence.json changes first. */
export const LICENSE_CHECK_MS = 60 * 60_000;

/** Never checked, whatever exchequer.json says: free on any PC. */
const NEVER_CHECKED = new Set(['manor', 'heiward']);

/**
 * How the license stands for this agent:
 * - trial: a trial still running; trial-ended: a trial whose runsUntil has passed (the only state that holds it);
 * - paid, lapsed (its paid time has passed: it keeps running), pending (its first payment not confirmed yet);
 * - missing, unreadable, bad-signature: it can't be judged, so it runs, and `problem` says why.
 */
export type LicenseCheckState = 'trial' | 'trial-ended' | 'paid' | 'lapsed' | 'pending' | 'missing' | 'unreadable' | 'bad-signature';

export interface LicenseCheck {
  /** Whether this agent checks at all: false for one the Exchequer doesn't sell (free, internal), which never holds. */
  checked: boolean;
  /** null when it isn't checked. */
  state: LicenseCheckState | null;
  /** The trial has ended: its rounds wait. True only for a verified trial whose runsUntil has passed. */
  ended: boolean;
  /** A trial's end (ISO), or null. */
  runsUntil: string | null;
  /** Why the license can't be judged, in words (it runs anyway); null when it can, or isn't checked. */
  problem: string | null;
}

export const NOT_CHECKED: LicenseCheck = Object.freeze({ checked: false, state: null, ended: false, runsUntil: null, problem: null });

const readJsonFile = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

/**
 * Whether the Exchequer sells this agent, as Manor last heard (exchequer.json's `agents`), and Manor's staff.json
 * neither holds it back nor marks it internal. False when either can't say: when in doubt, don't check.
 */
export function soldHere(id: string, home: string): boolean {
  if (NEVER_CHECKED.has(id)) return false;
  let agents: unknown;
  try {
    agents = (readJsonFile(path.join(home, 'exchequer.json')) as { agents?: unknown } | null)?.agents;
  } catch {
    return false;
  }
  if (!Array.isArray(agents)) return false;
  const listed = (agents as { id?: unknown; tier?: unknown }[]).find((a) => a && a.id === id);
  if (!listed || (listed.tier !== 'household' && listed.tier !== 'workshop')) return false;
  // Manor's staff.json, in its app folder: one held back (not offered yet) or internal isn't sold, whatever the Exchequer lists.
  try {
    const staff = (readJsonFile(path.join(home, 'app', 'staff.json')) as { agents?: unknown } | null)?.agents;
    const entry = Array.isArray(staff) ? (staff as Record<string, unknown>[]).find((a) => a?.id === id) : undefined;
    if (entry && (entry.heldBack === true || entry.internal === true)) return false;
  } catch {
    // No staff.json to read (a Manor checkout, or one being updated): the Exchequer's list says.
  }
  return true;
}

/** What licence.json holds, for this agent: read and verified, not yet held against the time. */
export interface LicenseReading {
  sold: boolean;
  /** The verified payload; null when there's none to trust (state says why). */
  payload: LicensePayload | null;
  state: 'ok' | 'missing' | 'unreadable' | 'bad-signature';
  problem: string | null;
}

const RUNS_ANYWAY = 'so the trial\'s end can\'t be checked, and it keeps running';

/** Reads and verifies Manor's licence.json for agent `id`; never throws. */
export function readLicenseFor(o: { id: string; home: string; env?: NodeJS.ProcessEnv; keys?: readonly JsonWebKey[] }): LicenseReading {
  if (!soldHere(o.id, o.home)) return { sold: false, payload: null, state: 'ok', problem: null };
  const file = readHeldFile(o.home);
  if ('missing' in file) return { sold: true, payload: null, state: 'missing', problem: `This PC holds no license file, ${RUNS_ANYWAY}.` };
  if ('unreadable' in file) return { sold: true, payload: null, state: 'unreadable', problem: `The license file on this PC can't be used: ${file.unreadable}, ${RUNS_ANYWAY}.` };
  const v = verifyLicense(file.held.licence, o.keys ?? trustedKeys(o.env ?? process.env));
  if ('error' in v) return { sold: true, payload: null, state: 'bad-signature', problem: `The license on this PC doesn't verify: ${v.error}, ${RUNS_ANYWAY}.` };
  return { sold: true, payload: v.payload, state: 'ok', problem: null };
}

/**
 * The reading held against the time: `now` (this PC's clock), the license's `iat` and `latestSeen` (the latest time
 * this agent has seen), whichever is latest, so a clock set back can't bring an ended trial back. Never throws.
 */
export function judgeLicense(r: LicenseReading, now: number, latestSeen = 0): LicenseCheck {
  if (!r.sold) return NOT_CHECKED;
  const base = { checked: true, ended: false, runsUntil: null, problem: r.problem };
  if (r.state !== 'ok' || !r.payload) return { ...base, state: r.state === 'ok' ? 'missing' : r.state };
  const p = r.payload;
  if (p.tier === 'trial') {
    const runs = Date.parse(p.runsUntil ?? '');
    // A trial with no end to read never holds: only a runsUntil that has passed does.
    if (!Number.isFinite(runs)) return { ...base, state: 'trial', runsUntil: null };
    const time = Math.max(now, Number.isFinite(p.iat) ? p.iat * 1000 : 0, Number.isFinite(latestSeen) ? latestSeen : 0);
    const ended = runs <= time;
    return { ...base, state: ended ? 'trial-ended' : 'trial', ended, runsUntil: p.runsUntil ?? null };
  }
  // Household or Workshop, of whatever tier this agent is: it runs (Manor holds back the updates a tier doesn't cover).
  if (p.updatesUntil === null) return { ...base, state: 'pending' };
  return { ...base, state: Date.parse(p.updatesUntil) >= now ? 'paid' : 'lapsed' };
}

/** The license checked for agent `id` against Manor's folder `home`, at `now`. */
export function checkLicense(o: { id: string; home: string; now?: number; latestSeen?: number; env?: NodeJS.ProcessEnv; keys?: readonly JsonWebKey[] }): LicenseCheck {
  return judgeLicense(readLicenseFor(o), o.now ?? Date.now(), o.latestSeen ?? 0);
}

/**
 * Whether this process checks: always, but under node --test, where it checks only with MANOR_LICENSE_CHECK=on (so no
 * agent's tests read this PC's own license).
 */
export const licenseCheckOn = (env: NodeJS.ProcessEnv = process.env) => !env.NODE_TEST_CONTEXT || env.MANOR_LICENSE_CHECK === 'on';

// ---------------------------------------------------------------- the agent's own check, kept

/** license-check.json, in the agent's data folder: the latest time it has seen while it held a trial (ms). */
const seenFile = () => dataFile('license-check.json');

let kept: { home: string; stamp: string; at: number; reading: LicenseReading; latestSeen: number; savedSeen: number } | null = null;
let said: string | null = null;

function stampOf(file: string): string {
  try {
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch (e) {
    return `none:${(e as NodeJS.ErrnoException).code ?? ''}`;
  }
}

function refresh(home: string, stamp: string, now: number): NonNullable<typeof kept> {
  const reading = readLicenseFor({ id: APP.id, home });
  const stored = readJson<{ latestSeen?: unknown }>(seenFile(), {}).latestSeen;
  const savedSeen = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
  const latestSeen = Math.max(savedSeen, kept?.latestSeen ?? 0, now);
  const next = { home, stamp, at: now, reading, latestSeen, savedSeen };
  // Kept for a trial only, and at most once a minute: a paid license writes nothing.
  if (reading.payload?.tier === 'trial' && latestSeen - savedSeen >= 60_000) {
    try {
      writeJson(seenFile(), { latestSeen });
      next.savedSeen = latestSeen;
    } catch {
      // Not kept this time: the license's iat still stands for the time.
    }
  }
  return next;
}

/** A line in the agent's log when how the license stands changes: never an alarm. */
function sayOnce(c: LicenseCheck): void {
  const line = !c.checked ? null : c.ended ? `${TRIAL_ENDED_TEXT}. Its rounds wait until then; its settings and data are kept.` : c.problem;
  if (line === said) return;
  said = line;
  if (line) console.log(`${new Date().toISOString()} ${line}`);
  else if (c.checked) console.log(`${new Date().toISOString()} the license on this PC lets it run (${c.state}).`);
}

/**
 * How the license stands for this agent now. Read again once an hour, or as soon as licence.json changes; the trial's
 * end is held against the time at every call. Any error of its own is no reason to stop: it says not checked.
 */
export function licenseNow(o: { now?: number; env?: NodeJS.ProcessEnv } = {}): LicenseCheck {
  try {
    if (!licenseCheckOn(o.env)) return NOT_CHECKED;
    const home = manorHome();
    const now = o.now ?? Date.now();
    const stamp = stampOf(path.join(home, LICENSE_FILE));
    if (!kept || kept.home !== home || kept.stamp !== stamp || Math.abs(now - kept.at) >= LICENSE_CHECK_MS) kept = refresh(home, stamp, now);
    kept.latestSeen = Math.max(kept.latestSeen, now);
    const c = judgeLicense(kept.reading, now, kept.latestSeen);
    sayOnce(c);
    return c;
  } catch {
    return NOT_CHECKED;
  }
}

/** The trial's end in words, when it holds this agent; null otherwise. */
export const trialEnded = (): string | null => (licenseNow().ended ? TRIAL_ENDED_TEXT : null);

/** The page's words for an ended trial: what happened, what brings it back, and that nothing was lost. */
export function trialEndedNote(): string {
  let manor = MANOR_DEFAULT_NAME;
  try {
    manor = manorLink()?.name ?? MANOR_DEFAULT_NAME;
  } catch {
    // Manor's settings can't be read: its default name.
  }
  return `${TRIAL_ENDED_TEXT}. Its settings and data are kept, and it starts again as soon as this PC holds a license (${manor}'s Settings, License).`;
}

/** What /api/ping and the status command say of the license: nothing for an agent that doesn't check. */
export function licensePing(c: LicenseCheck): Record<string, unknown> {
  return c.checked ? { license: { state: c.state, ended: c.ended, runsUntil: c.runsUntil, problem: c.problem } } : {};
}

let timer: NodeJS.Timeout | null = null;

/** Checks now, as the agent starts, then every hour (the timer never keeps the process up). */
export function startLicenseCheck(): void {
  licenseNow();
  if (timer) return;
  timer = setInterval(() => licenseNow(), LICENSE_CHECK_MS);
  timer.unref();
}

/** For tests: forget what was read, so the next call reads afresh. */
export function forgetLicenseCheck(): void {
  kept = null;
  said = null;
  if (timer) clearInterval(timer);
  timer = null;
}
