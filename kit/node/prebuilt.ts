import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locksDir } from './lock.ts';

/**
 * The kit's C# helpers, shipped compiled and signed with the manor's certificate (kit 2.91.0): Smart App Control
 * blocks a program it hasn't seen before unless it's signed, and a helper each PC compiles itself is one it has never
 * seen (a checks-pace launcher was blocked eight times in two seconds on 2026-10-19). Each one is in prebuilt\, named
 * for its source; a PC copies it into the shared kit folder and runs that. When a helper's source has changed since it
 * was last signed (tools/sign-helpers.ts), there's no prebuilt copy for it, and the PC compiles it as before.
 */
export const HELPERS = {
  'checks-pace': { ext: 'exe', type: 'ConsoleApplication' },
  awake: { ext: 'exe', type: 'WindowsApplication' },
  gentle: { ext: 'dll', type: 'Library' },
  'working-set': { ext: 'dll', type: 'Library' },
  catalog: { ext: 'exe', type: 'ConsoleApplication' },
} as const;
export type Helper = keyof typeof HELPERS;

/** The certificate the prebuilt helpers are signed with: the owner's, from Certum (CN=Jeremy Collier). */
export const SIGNED_BY = '6B654D9C34800D4307D42ACD63B925EDA5CE8D33';

/** A helper's source and output type, hashed with plain line ends: a checkout's CRLF names the same helper. */
export function helperHash(helper: Helper, source: string): string {
  return createHash('sha256').update(`${HELPERS[helper].type}\n${source.replace(/\r\n/g, '\n')}`).digest('hex').slice(0, 12);
}

/** The prebuilt helper's file name for this source: checks-pace-0123456789ab.exe. */
export const prebuiltName = (helper: Helper, source: string): string => `${helper}-${helperHash(helper, source)}.${HELPERS[helper].ext}`;

/** Where the kit keeps its prebuilt helpers. */
export const PREBUILT_DIR = fileURLToPath(new URL('./prebuilt/', import.meta.url));

/**
 * The signed helper for this source, copied into the shared kit folder (to a name of its own, then moved into place,
 * so two agents copying at once never start a half-written one), where no agent's update can be held up by it running;
 * null when the kit has none for this source, so the caller compiles it. Never throws.
 */
export function signedHelper(helper: Helper, source: string, o: { from?: string; into?: string } = {}): string | null {
  try {
    const name = prebuiltName(helper, source);
    const from = path.join(o.from ?? PREBUILT_DIR, name);
    if (!existsSync(from)) return null;
    const into = o.into ?? path.join(path.dirname(locksDir), 'kit');
    const to = path.join(into, name.replace(/\.(exe|dll)$/, '.signed.$1'));
    if (existsSync(to)) return to;
    mkdirSync(into, { recursive: true });
    const tmp = `${to}.${process.pid}.${Date.now()}.tmp`;
    copyFileSync(from, tmp);
    try {
      renameSync(tmp, to);
    } catch {
      rmSync(tmp, { force: true });
    }
    return existsSync(to) ? to : null;
  } catch {
    return null;
  }
}
