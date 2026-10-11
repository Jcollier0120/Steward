import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Developer Pro (kit 2.49.0): the work the Wright and the Bailiff do with the rest of the staff, as other agents show
 * it. The Assayer testing the Wright's drafts the Bailiff approved, a failure filed for the Wright, the Aletaster's work
 * orders sent to the Wright's queue, the Surveyor's findings handed to the Wright, the Steward's look at the Wright's
 * drafts. None of it is sold yet, so none of it is shown or done on a customer's PC, whether or not a Wright happens to
 * be there: an agent asks developerPro() before showing a setting, a line or a button that names them, and before
 * doing the work.
 *
 * Today that is the maker's laptop only: its firmware's (SMBIOS) UUID, hashed with a salt, the same check as the
 * Steward's maker.ts and Manor's customer view. No file, setting or environment variable makes another PC the maker's.
 * When the Exchequer sells a Developer Pro license, its tier turns it on here too (license.ts's LicenseTier gains it),
 * and every agent that asks follows without a change of its own.
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

let given: (() => boolean) | null = null;

/**
 * Stands in for the PC in a test: `() => true`, Developer Pro; `() => false`, a customer's PC; null, this PC again. Only
 * code in the same process can call it.
 */
export function developerProForTests(f: (() => boolean) | null): void {
  given = f;
}

/**
 * Whether the Wright's and the Bailiff's work with the rest of the staff is shown and done here: the maker's laptop,
 * for now. CASTELLAN_CUSTOMER=1 makes even the maker's laptop answer no (to see an agent as a customer has it, and for a
 * test's child process); nothing makes another PC answer yes. Cheap after the first call: ask it per request.
 */
export function developerPro(): boolean {
  if (process.env.CASTELLAN_CUSTOMER === '1') return false;
  if (given) return given();
  return isMakersUuid(firmwareUuid());
}
