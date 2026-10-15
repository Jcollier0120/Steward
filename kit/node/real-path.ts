import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Paths as the file system has them, for comparing (spec/DEV-DRIVES.md). One folder has two spellings on a PC with a
 * junction, a link or a drive mounted in a folder: C:\DevData mounted from E:, so C:\DevData\Temp is E:\Temp, and
 * the Steward's work folder %USERPROFILE%\.steward\work a junction to E:\steward-work. Git, import.meta.url and a
 * process's path as Windows started it give one spelling, settings and os.homedir() the other; compared as spelled,
 * the same folder is two. Every key and comparison of folders, and of files in them, goes through realPath.
 *
 * realpathSync.native, not realpathSync: on Windows the latter follows a junction but stops at a mounted folder.
 */

const KEEP_MS = 60_000;
const known = new Map<string, { real: string; at: number }>();

/**
 * `p` resolved, with its junctions, links and mounted folders followed: the real path of the deepest part of it that
 * exists, the rest appended as given (a folder not made yet, a worktree removed since); a share as it is. Answers are
 * kept a minute.
 */
export function realPath(p: string): string {
  const full = path.resolve(p);
  // A share (\\wsl.localhost\..., \\server\...) is taken as it is: asking would wake WSL or wait on the network.
  if (full.startsWith('\\\\')) return full;
  const now = Date.now();
  const had = known.get(full);
  if (had && now - had.at < KEEP_MS) return had.real;
  let real = full;
  const rest: string[] = [];
  for (let at = full; ; ) {
    try {
      real = rest.length ? path.join(realpathSync.native(at), ...rest) : realpathSync.native(at);
      break;
    } catch {
      const up = path.dirname(at);
      if (up === at) break;
      rest.unshift(path.basename(at));
      at = up;
    }
  }
  if (known.size >= 10_000) known.clear();
  known.set(full, { real, at: now });
  return real;
}

/** Forgets the answers kept (a test that makes or moves a junction). */
export function forgetRealPaths(): void {
  known.clear();
}

const win = process.platform === 'win32';

/** A path as a key: its real path, without a separator at the end (a drive's root keeps its own), in one case on Windows. */
export function pathKey(p: string): string {
  const real = realPath(p);
  const trimmed = real.length > path.parse(real).root.length ? real.replace(/[\\/]+$/, '') : real;
  return win ? trimmed.toLowerCase() : trimmed;
}

/** The same folder or file, however each is spelled. */
export const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);

/** Whether the path with key `key` is the folder with key `dirKey` or inside it (both from pathKey). */
export const keyInside = (key: string, dirKey: string) => key === dirKey || key.startsWith(dirKey.endsWith(path.sep) ? dirKey : dirKey + path.sep);

/** `p` is `dir` or inside it, however each is spelled. */
export const inside = (p: string, dir: string) => keyInside(pathKey(p), pathKey(dir));
