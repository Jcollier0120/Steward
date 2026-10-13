import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The git to start for `git` (kit 2.64.0). On Windows, PATH usually finds Git for Windows' launcher,
 * `<Git>\cmd\git.exe`, which does nothing but start the real `<Git>\<clangarm64|mingw64|mingw32>\bin\git.exe`; and a
 * program started without a console of its own (an agent in the background) gets a console host (conhost.exe) for
 * that second one. So every git was three processes, and on some PCs every process that ends leaves kernel memory
 * behind: on 2026-10-12 the Steward's 688 git commands in 22 minutes started some 600 more git.exe and 535 console hosts.
 * The real git sets up what the launcher would (MSYSTEM, HOME, its own folders on PATH) itself, so it's started directly.
 *
 * Anything else, a git on PATH that isn't the launcher, or another system: `git`, found on PATH as before. Kept per PATH,
 * and looked for again when the one kept is gone (Git for Windows updating itself).
 */
export function gitExe(env: NodeJS.ProcessEnv = process.env, o: { platform?: string; arch?: string; exists?: (p: string) => boolean } = {}): string {
  if ((o.platform ?? process.platform) !== 'win32') return 'git';
  const exists = o.exists ?? existsSync;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const dirs = env[pathKey] ?? '';
  const k = o.exists ? undefined : kept.get(dirs);
  // The real one kept while it's there; `git` (none found) looked for again after a while, as an update may be under way.
  if (k && (k.exe === 'git' ? Date.now() - k.at < LOOK_AGAIN_MS : exists(k.exe))) return k.exe;
  const exe = realGitOn(dirs, o.arch ?? process.arch, exists);
  if (!o.exists) kept.set(dirs, { exe, at: Date.now() });
  return exe;
}

const kept = new Map<string, { exe: string; at: number }>();
const LOOK_AGAIN_MS = 10 * 60_000;

/** The real git.exe behind the first git on these PATH folders, when that one is Git for Windows' launcher; else `git`. */
function realGitOn(dirs: string, arch: string, exists: (p: string) => boolean): string {
  // As Windows looks for `git` without an ending: git.com, then git.exe, in each folder in turn.
  const dir = dirs.split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).find((d) => d && (exists(path.win32.join(d, 'git.com')) || exists(path.win32.join(d, 'git.exe'))));
  if (!dir || path.win32.basename(path.win32.resolve(dir)).toLowerCase() !== 'cmd' || exists(path.win32.join(dir, 'git.com'))) return 'git';
  const top = path.win32.dirname(path.win32.resolve(dir));
  const prefixes = arch === 'arm64' ? ['clangarm64', 'mingw64', 'mingw32'] : arch === 'ia32' ? ['mingw32', 'mingw64', 'clangarm64'] : ['mingw64', 'clangarm64', 'mingw32'];
  for (const p of prefixes) {
    const real = path.win32.join(top, p, 'bin', 'git.exe');
    if (exists(real)) return real;
  }
  return 'git';
}
