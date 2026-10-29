import type { JsonWebKey } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { isDemo } from './demo.ts';
import { sharedLicenseFolder } from './everyone.ts';
import { isThisPc, LICENSE_FILE, licenseCheckOn, readHeldFile, trustedKeys, verifyLicense, type LicensePayload } from './license.ts';
import { MANOR_DEFAULT_NAME, manorHome, manorLink } from './manor.ts';
import { dataFile, readJson, writeJson } from './store.ts';

/**
 * The license, checked by the agent itself (kit 2.45.0; closed when there's none, kit 2.110.0; every agent but Manor
 * and Heiward, kit 2.113.0). Manor takes its staff off duty when a 7-day trial ends or the PC holds no license (its
 * developer.ts settleLicenseDuty); this is the same rule inside each agent, so an agent started by hand (its scheduled
 * task, its CLI, Run now) doesn't run without one either.
 *
 * Who checks: every agent but Manor and Heiward (NEVER_CHECKED), which are free on any PC. No staff member works for
 * free, so nothing else decides it: not whether the Exchequer lists the agent or with what tier, not Manor's staff.json
 * holding it back or marking it internal (the Wright, the Bailiff, the Crier), not its release.json. Before kit
 * 2.113.0 only a sold agent checked, so a missing exchequer.json or a release saying `"sold": false` let one run.
 *
 * What it reads: Manor's licence.json, verified offline against the public keys (license.ts), and this PC's id
 * (device.json, or made again from MachineGuid: license.ts isThisPc). It never asks the Exchequer: Manor fetches the
 * license, and refreshes it every hour.
 *
 * What holds an agent: a trial whose `runsUntil` has passed, or no license for this PC (no licence.json, one that
 * can't be read, one whose signature doesn't verify, or one made for another PC). Then its rounds wait (schedule.ts),
 * Run now with them, its page says "The trial ended: a license brings it back" or "This PC holds no license for it:
 * signing in brings it back", and its ping says it isn't running. Its settings and data are kept, its page stays up,
 * and duty.json isn't touched: once a license is here, the hold lifts by itself, and Manor's Start brings it back on
 * duty as before.
 *
 * Everything else runs as it did: a paid license, one that lapsed (the Freehold license: what was released before
 * its paid time ended keeps running, forever), one of another tier (Manor handles that, by not offering its updates),
 * one still waiting for its first payment.
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

/** What the page says when this PC holds no license for the agent (kit 2.110.0). */
export const NO_LICENSE_TEXT = 'This PC holds no license for it: signing in brings it back';

/** How often it reads the license again, unless licence.json changes first. */
export const LICENSE_CHECK_MS = 60 * 60_000;

/** Never checked: free on any PC. Every other agent needs a license for this PC (kit 2.113.0). */
const NEVER_CHECKED = new Set(['manor', 'heiward']);

/** Whether agent `id` checks the license: every one but Manor and Heiward. */
export const checksLicense = (id: string): boolean => !NEVER_CHECKED.has(id);

/**
 * How the license stands for this agent:
 * - trial: a trial still running; trial-ended: a trial whose runsUntil has passed (it holds);
 * - paid, lapsed (its paid time has passed: it keeps running), pending (its first payment not confirmed yet);
 * - missing, unreadable, bad-signature, another-pc: no license for this PC (it holds), and `problem` says why.
 */
export type LicenseCheckState = 'trial' | 'trial-ended' | 'paid' | 'lapsed' | 'pending' | 'missing' | 'unreadable' | 'bad-signature' | 'another-pc';

export interface LicenseCheck {
  /** Whether this agent checks at all: false only for Manor and Heiward (and under the tests), which never hold. */
  checked: boolean;
  /** null when it isn't checked. */
  state: LicenseCheckState | null;
  /** Its rounds wait: the trial has ended, or this PC holds no license for it (kit 2.110.0). */
  held: boolean;
  /** The trial has ended: true only for a verified trial whose runsUntil has passed (then held is too). */
  ended: boolean;
  /** A trial's end (ISO), or null. */
  runsUntil: string | null;
  /** Why this PC holds no license, in words; null when it does, or isn't checked. */
  problem: string | null;
}

export const NOT_CHECKED: LicenseCheck = Object.freeze({ checked: false, state: null, held: false, ended: false, runsUntil: null, problem: null });

/** What licence.json holds, for this agent: read and verified, not yet held against the time. */
export interface LicenseReading {
  /** Whether it checks (checksLicense): false for Manor and Heiward alone. */
  checked: boolean;
  /** The verified payload, this PC's; null when there's none to trust (state says why). */
  payload: LicensePayload | null;
  state: 'ok' | 'missing' | 'unreadable' | 'bad-signature' | 'another-pc';
  problem: string | null;
}

const HOLDS = 'so its rounds wait until this PC holds one';

/**
 * Reads and verifies Manor's licence.json for agent `id`; never throws. `guid` is this PC's MachineGuid (license.ts
 * machineGuid when left out).
 */
export function readLicenseFor(o: { id: string; home: string; guid?: string | null; env?: NodeJS.ProcessEnv; keys?: readonly JsonWebKey[] }): LicenseReading {
  if (!checksLicense(o.id)) return { checked: false, payload: null, state: 'ok', problem: null };
  const file = readHeldFile(o.home);
  if ('missing' in file) return { checked: true, payload: null, state: 'missing', problem: `This PC holds no license, ${HOLDS}.` };
  if ('unreadable' in file) return { checked: true, payload: null, state: 'unreadable', problem: `The license file on this PC can't be used: ${file.unreadable}, ${HOLDS}.` };
  const env = o.env ?? process.env;
  const v = verifyLicense(file.held.licence, o.keys ?? trustedKeys(env));
  if ('error' in v) return { checked: true, payload: null, state: 'bad-signature', problem: `The license on this PC doesn't verify: ${v.error}, ${HOLDS}.` };
  const shared = sharedLicenseFolder(env);
  const folders = shared ? [o.home, shared] : [o.home];
  if (!(o.guid === undefined ? isThisPc(v.payload.sub, folders) : isThisPc(v.payload.sub, folders, o.guid))) {
    return { checked: true, payload: null, state: 'another-pc', problem: `The license on this PC was made for another PC, ${HOLDS}.` };
  }
  return { checked: true, payload: v.payload, state: 'ok', problem: null };
}

/**
 * The reading held against the time: `now` (this PC's clock), the license's `iat` and `latestSeen` (the latest time
 * this agent has seen), whichever is latest, so a clock set back can't bring an ended trial back. Never throws.
 */
export function judgeLicense(r: LicenseReading, now: number, latestSeen = 0): LicenseCheck {
  if (!r.checked) return NOT_CHECKED;
  const base = { checked: true, held: false, ended: false, runsUntil: null, problem: r.problem };
  // No license for this PC: it holds, and problem says why.
  if (r.state !== 'ok' || !r.payload) return { ...base, state: r.state === 'ok' ? 'missing' : r.state, held: true };
  const p = r.payload;
  if (p.tier === 'trial') {
    const runs = Date.parse(p.runsUntil ?? '');
    // A trial with no end to read never holds: only a runsUntil that has passed does.
    if (!Number.isFinite(runs)) return { ...base, state: 'trial', runsUntil: null };
    const time = Math.max(now, Number.isFinite(p.iat) ? p.iat * 1000 : 0, Number.isFinite(latestSeen) ? latestSeen : 0);
    const ended = runs <= time;
    return { ...base, state: ended ? 'trial-ended' : 'trial', held: ended, ended, runsUntil: p.runsUntil ?? null };
  }
  // Household, Workshop or Workshop Pro, of whatever tier this agent is: it runs (Manor holds back the updates a tier
  // doesn't cover).
  if (p.updatesUntil === null) return { ...base, state: 'pending' };
  return { ...base, state: Date.parse(p.updatesUntil) >= now ? 'paid' : 'lapsed' };
}

/** The license checked for agent `id` against Manor's folder `home`, at `now`. */
export function checkLicense(o: { id: string; home: string; now?: number; latestSeen?: number; guid?: string | null; env?: NodeJS.ProcessEnv; keys?: readonly JsonWebKey[] }): LicenseCheck {
  return judgeLicense(readLicenseFor(o), o.now ?? Date.now(), o.latestSeen ?? 0);
}

/** Whether this process checks: license.ts' licenseCheckOn (off under node --test unless MANOR_LICENSE_CHECK=on). */
export { licenseCheckOn };

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

/** What holds the agent, in the page's words: an ended trial, no license for this PC, or nothing. */
export const holdText = (c: LicenseCheck): string | null => (c.ended ? TRIAL_ENDED_TEXT : c.held ? NO_LICENSE_TEXT : null);

/** A line in the agent's log when how the license stands changes: never an alarm. */
function sayOnce(c: LicenseCheck): void {
  const held = holdText(c);
  const line = !c.checked ? null : held ? `${held}${c.problem ? ` (${c.problem})` : ''}. Its rounds wait until then; its settings and data are kept.` : null;
  if (line === said) return;
  said = line;
  if (line) console.log(`${new Date().toISOString()} ${line}`);
  else if (c.checked) console.log(`${new Date().toISOString()} the license on this PC lets it run (${c.state}).`);
}

/**
 * How the license stands for this agent now. Read again once an hour, or as soon as licence.json changes; the trial's
 * end is held against the time at every call. An error of its own holds it too (kit 2.113.0), as a license it can't
 * read does: Manor and Heiward alone never hold.
 */
export function licenseNow(o: { now?: number; env?: NodeJS.ProcessEnv } = {}): LicenseCheck {
  if (!licenseCheckOn(o.env) || !checksLicense(APP.id)) return NOT_CHECKED;
  try {
    const home = manorHome();
    const now = o.now ?? Date.now();
    const stamp = stampOf(path.join(home, LICENSE_FILE));
    if (!kept || kept.home !== home || kept.stamp !== stamp || Math.abs(now - kept.at) >= LICENSE_CHECK_MS) kept = refresh(home, stamp, now);
    kept.latestSeen = Math.max(kept.latestSeen, now);
    const c = judgeLicense(kept.reading, now, kept.latestSeen);
    sayOnce(c);
    return c;
  } catch (e) {
    const c: LicenseCheck = { checked: true, state: 'unreadable', held: true, ended: false, runsUntil: null, problem: `The license on this PC couldn't be checked: ${(e as Error).message}, ${HOLDS}.` };
    sayOnce(c);
    return c;
  }
}

/** What holds this agent now, in words (holdText); null when nothing does. */
export const licenseHeld = (): string | null => holdText(licenseNow());

/**
 * The hold the page shows (licenseHeld), but none in demo mode (kit 2.142.1): a demo's pictures (Manor's hero pictures)
 * show the page as it is on a licensed PC. Only what the page shows: its rounds still hold, and a demo runs none anyway.
 */
export const shownHold = (): string | null => (isDemo() ? null : licenseHeld());

/** Kit 2.45.0's name for licenseHeld, kept for an agent that calls it: since kit 2.110.0, no license holds it too. */
export const trialEnded = licenseHeld;

/** The status pill's words for a hold (holdText's). */
export const holdPill = (text: string): string => (text === TRIAL_ENDED_TEXT ? 'Trial ended' : 'No license');

/** The page's words for a hold: what happened, what brings it back, and that nothing was lost. */
export function heldNote(text = licenseHeld() ?? TRIAL_ENDED_TEXT): string {
  let manor = MANOR_DEFAULT_NAME;
  try {
    manor = manorLink()?.name ?? MANOR_DEFAULT_NAME;
  } catch {
    // Manor's settings can't be read: its default name.
  }
  return `${text}. Its settings and data are kept, and it starts again as soon as this PC holds a license (${manor}'s Settings, License).`;
}

/** Kit 2.45.0's name for heldNote. */
export const trialEndedNote = heldNote;

/** What /api/ping and the status command say of the license: nothing for an agent that doesn't check. */
export function licensePing(c: LicenseCheck): Record<string, unknown> {
  return c.checked ? { license: { state: c.state, held: c.held, ended: c.ended, runsUntil: c.runsUntil, problem: c.problem } } : {};
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
