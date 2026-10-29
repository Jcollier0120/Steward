import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { sharedLicenseFolder } from './everyone.ts';
import { isThisPc, LICENSE_FILE, licenseCheckOn, readHeldFile, trustedKeys, verifyLicense } from './license.ts';
import { manorHome } from './manor.ts';

/**
 * Workshop Pro (kit 2.49.0, named Developer Pro until kit 2.144.1): the work the Wright and the Bailiff do with the
 * rest of the staff, as other agents show it. The Assayer testing the Wright's drafts the Bailiff approved, a failure
 * filed for the Wright, the Aletaster's work orders sent to the Wright's queue, the Surveyor's findings handed to the
 * Wright, the Steward's look at the Wright's drafts. None of it is shown or done on a PC without Workshop Pro, whether
 * or not a Wright happens to be there: an agent asks developerPro() before showing a setting, a line or a button that
 * names them, and before doing the work.
 *
 * The Seneschal comes with it too (kit 2.78.1): the agent that hands out the staff's work on a PC in order, as the PC
 * has room. Without Workshop Pro it hands out no work, and each agent runs its own as before.
 *
 * Which PCs have it: the maker's laptop (its firmware's (SMBIOS) UUID, hashed with a salt, the same check as the
 * Steward's maker.ts and Manor's customer view; no file, setting or environment variable makes another PC the maker's),
 * and, from kit 2.144.1, a PC holding a Workshop Pro license (tier `workshop-pro`: workshopProLicense). Every agent that
 * asks follows without a change of its own. A trial doesn't turn it on yet: Workshop Pro isn't on sale, and a trial
 * mustn't show its staff. Once it is on sale, a running trial joins (a trial holds every tier): in workshopProLicense.
 */

/** The maker's laptop: SHA-256 of MAKERS_SALT and its firmware UUID (upper case, no braces). The Steward's and Manor's, the same. */
const MAKERS_PC = 'e0a67cec8c84f4f7fedd7e4ed4c24b89082f23354687f7b1e0c32f444bb6ccca';
const MAKERS_SALT = 'castellan-makers-pc:';
const REG = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');

/** The firmware UUID in `reg query HKLM\SYSTEM\HardwareConfig /v LastConfig`'s answer ("{4C4C4544-…}"), upper case; null when there's none. */
export function uuidIn(regOutput: string): string | null {
  const m = /\{?([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\}?/i.exec(regOutput);
  return m ? m[1].toUpperCase() : null;
}

let firmware: string | null = null;
let failedAt = 0;
/** After a read that failed, the next try waits this long. */
const RETRY_MS = 60_000;

/**
 * This PC's firmware UUID, which Windows keeps as HardwareConfig's LastConfig: read once (about 20 ms) and kept; null
 * when it can't be read. A read that failed isn't kept: it is tried again a minute later.
 */
function firmwareUuid(now = Date.now()): string | null {
  if (firmware) return firmware;
  if (failedAt && now - failedAt < RETRY_MS) return null;
  try {
    firmware = uuidIn(execFileSync(REG, ['query', 'HKLM\\SYSTEM\\HardwareConfig', '/v', 'LastConfig'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    firmware = null;
  }
  failedAt = firmware ? 0 : now;
  return firmware;
}

/** Whether a firmware UUID is the maker's laptop's: its salted hash is MAKERS_PC (`expected`, for tests). */
export function isMakersUuid(uuid: string | null, expected = MAKERS_PC): boolean {
  return !!uuid && createHash('sha256').update(MAKERS_SALT + uuid).digest('hex') === expected;
}

/** How long a reading of the license is kept, unless licence.json changes first (license-check.ts' LICENSE_CHECK_MS). */
const LOOK_AGAIN_MS = 60 * 60_000;

let license: { home: string; stamp: string; at: number; on: boolean } | null = null;

function stampOf(file: string): string {
  try {
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch (e) {
    return `none:${(e as NodeJS.ErrnoException).code ?? ''}`;
  }
}

/** Whether Manor's licence.json in `home` is a Workshop Pro license made for this PC, verified as license-check.ts verifies it. */
function holdsWorkshopPro(home: string, env: NodeJS.ProcessEnv): boolean {
  const file = readHeldFile(home);
  if (!('held' in file)) return false;
  const v = verifyLicense(file.held.licence, trustedKeys(env));
  // Not a trial yet: Workshop Pro's staff aren't on sale. Once they are, `|| v.payload.tier === 'trial'` (a trial
  // still running: license-check.ts' judgeLicense says whether its runsUntil has passed) turns it on for a trial too.
  if ('error' in v || v.payload.tier !== 'workshop-pro') return false;
  const shared = sharedLicenseFolder(env);
  return isThisPc(v.payload.sub, shared ? [home, shared] : [home]);
}

/**
 * Whether this PC holds a Workshop Pro license (kit 2.144.1): Manor's licence.json, verified offline, of tier
 * `workshop-pro`, made for this PC. Paid, waiting for its first payment, or lapsed, as such a license runs every agent
 * (license-check.ts). Read again only when licence.json changes (its size or time), or an hour on: a stat per call.
 * Under node --test it reads none unless MANOR_LICENSE_CHECK=on (licenseCheckOn), so no agent's tests read this PC's.
 */
export function workshopProLicense(env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  if (!licenseCheckOn(env)) return false;
  try {
    const home = manorHome();
    const stamp = stampOf(path.join(home, LICENSE_FILE));
    if (!license || license.home !== home || license.stamp !== stamp || Math.abs(now - license.at) >= LOOK_AGAIN_MS) {
      license = { home, stamp, at: now, on: holdsWorkshopPro(home, env) };
    }
    return license.on;
  } catch {
    return false;
  }
}

/** Forgets the license last read, so the next workshopProLicense() reads it again: for tests. */
export function forgetWorkshopProLicense(): void {
  license = null;
}

let given: (() => boolean) | null = null;

/**
 * Stands in for the PC in a test: `() => true`, Workshop Pro; `() => false`, a PC without it; null, this PC again. Only
 * code in the same process can call it.
 */
export function developerProForTests(f: (() => boolean) | null): void {
  given = f;
}

/**
 * Whether the Wright's and the Bailiff's work with the rest of the staff is shown and done here (Workshop Pro): the
 * maker's laptop, or a PC holding a Workshop Pro license. CASTELLAN_CUSTOMER=1 makes even the maker's laptop answer no
 * (to see an agent as a customer has it, and for a test's child process), its license included. Cheap after the first
 * call: ask it per request.
 */
export function developerPro(): boolean {
  if (process.env.CASTELLAN_CUSTOMER === '1') return false;
  if (given) return given();
  return isMakersUuid(firmwareUuid()) || workshopProLicense();
}
