import * as kit from './kit/safeinstall.ts';

/**
 * The Steward's install, behind the kit's fail-safe (kit/safeinstall.ts, every agent's since kit 2.51.0; the Steward's
 * own since 0.9). The rounds merge the Steward's own PRs and release them (stages/selfmerge.ts, stages/self.ts), and
 * Manor installs each release. A version that was rolled back is allowed again by Dismiss on its alarm
 * (unsafeAlarmId, agent.ts), or `node src\cli.ts allow-update <version>`.
 */

export { allowUpdate, loadUnsafe, MISSES_ALLOWED, PROBATION_MS, probation, unsafeAlarmId, unsafeFile } from './kit/safeinstall.ts';
export type { SafeDeps, Unsafe } from './kit/safeinstall.ts';

const allowHint = (version: string) => `Dismiss its alarm on the Steward's page, or node src\\cli.ts allow-update ${version}`;

export const safeDeps = (): kit.SafeDeps => ({ ...kit.safeDeps(), allowHint });

export const safeInstall = (opts: Parameters<typeof kit.safeInstall>[0] = {}, d: kit.SafeDeps = safeDeps()) => kit.safeInstall(opts, { allowHint, ...d });

export const safeInstallCli = (args: string[]) => kit.safeInstallCli(args, { allowHint });
