import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Castellan for everyone on a PC (kit 2.95.0; Manor's docs/EVERYONE-INSTALL.md and everyone.ts): installed once by an
 * administrator, each Windows account with its own manor, staff and data. What the accounts share is in
 * %ProgramData%\Castellan, which the setup's machine part makes, every account allowed to write in it. Its everyone.json
 * marks an Everyone install: nothing here applies where it isn't, and removed.json alone (the Everyone install was
 * uninstalled) doesn't count.
 *
 * The kit keeps the model files and the model servers' builds there (accelerator-config.ts' toolsHome), so a second
 * account doesn't download the same few GB again. Each account keeps its own accelerators' config.json and logs.
 *
 * A Manor in a folder of its own (MANOR_HOME without CASTELLAN_SHARED, as a development checkout's) shares none of it:
 * it is another PC, as ever. CASTELLAN_SHARED moves the shared folder (tests).
 */

export const EVERYONE_FILE = 'everyone.json';

/** %ProgramData%\Castellan, or CASTELLAN_SHARED (Manor's everyone.ts sharedRoot). */
export const sharedRoot = (env: NodeJS.ProcessEnv = process.env) =>
  env.CASTELLAN_SHARED ? path.resolve(env.CASTELLAN_SHARED) : path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'Castellan');

/** Whether this PC has an Everyone install: everyone.json in the shared folder (not once it's uninstalled: removed.json). */
export const hasEveryone = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(sharedRoot(env), EVERYONE_FILE));

/**
 * Whether this account's staff keep the model files and the model servers' builds in the PC's shared folder: an Everyone
 * install, and not a Manor in a folder of its own (as Manor's sharesLicense). Under node --test only a test's own
 * CASTELLAN_SHARED counts, so the PC's own install never decides a test.
 */
export function sharesModels(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.CASTELLAN_SHARED && process.env.NODE_TEST_CONTEXT) return false;
  if (env.MANOR_HOME && !env.CASTELLAN_SHARED) return false;
  return hasEveryone(env);
}

/** The accelerators' shared folder (%ProgramData%\Castellan\accelerators): servers\ and models\ in it, as in an account's own. */
export const sharedAcceleratorsHome = (env: NodeJS.ProcessEnv = process.env) => path.join(sharedRoot(env), 'accelerators');
