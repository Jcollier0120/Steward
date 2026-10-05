import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * The folders Windows keeps for a person (Desktop, Documents, Downloads, Pictures, Music, Videos, Screenshots), where
 * they are on this PC. OneDrive's folder backup moves Desktop, Documents and Pictures into the OneDrive folder, and a
 * person can move any of them, so the usual %USERPROFILE%\Documents is often wrong: the real places are the registry's
 * User Shell Folders, which is what Explorer itself reads. An agent that offers "Automatic: the folders Windows uses"
 * reads them here, instead of asking for a path.
 */
export interface KnownFolders {
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
  pictures: string;
  music: string;
  videos: string;
  /** Where Windows saves screenshots (Win+PrtScn), when it says; Pictures\Screenshots otherwise. */
  screenshots: string;
  /** The OneDrive folder, when OneDrive is set up. */
  oneDrive: string | null;
}

const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

/** The registry's names for them: old names for the old folders, GUIDs for the newer ones. */
const NAMES = {
  desktop: 'Desktop',
  documents: 'Personal',
  downloads: '{374DE290-123F-4565-9164-B4428B6E2FCB}',
  pictures: 'My Pictures',
  music: 'My Music',
  videos: 'My Video',
  screenshots: '{B7BEDE81-DF94-4682-A7D8-57A52620B86F}',
} as const;

/** `reg query`'s lines, name to path, with %NAME% expanded from `env` (ignoring case, as Windows does). */
export function parseShellFolders(out: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const res: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    res[m[1]] = m[2].replace(/%([^%]+)%/g, (all, name: string) => {
      const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? (env[key] ?? all) : all;
    });
  }
  return res;
}

/** The known folders from a `reg query` of User Shell Folders (null: no answer), with the usual places for the rest. */
export function foldersFrom(reg: string | null, o: { home?: string; env?: Record<string, string | undefined> } = {}): KnownFolders {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const shell = reg ? parseShellFolders(reg, env) : {};
  // A value still holding a %NAME% that didn't expand is no place to look.
  const at = (name: string, usual: string) => (shell[name] && !/%[^%]+%/.test(shell[name]) ? path.normalize(shell[name]) : path.join(home, usual));
  const pictures = at(NAMES.pictures, 'Pictures');
  return {
    home,
    desktop: at(NAMES.desktop, 'Desktop'),
    documents: at(NAMES.documents, 'Documents'),
    downloads: at(NAMES.downloads, 'Downloads'),
    pictures,
    music: at(NAMES.music, 'Music'),
    videos: at(NAMES.videos, 'Videos'),
    screenshots: shell[NAMES.screenshots] && !/%[^%]+%/.test(shell[NAMES.screenshots]) ? path.normalize(shell[NAMES.screenshots]) : path.join(pictures, 'Screenshots'),
    oneDrive: env.OneDrive || env.OneDriveConsumer || env.OneDriveCommercial || null,
  };
}

let known: KnownFolders | undefined;

/**
 * This PC's known folders, read once (a folder moved while the agent runs is seen at its next start). Off Windows, or
 * with no registry answer, the usual places in the home folder.
 */
export function knownFolders(): KnownFolders {
  if (known) return known;
  let reg: string | null = null;
  if (process.platform === 'win32') {
    try {
      reg = execFileSync('reg.exe', ['query', SHELL_FOLDERS], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    } catch {
      // No registry answer: the usual places.
    }
  }
  return (known = foldersFrom(reg));
}

/** The paths given, each once (compared as Windows does, ignoring case), the empty ones left out. */
export function uniqueFolders(list: (string | null | undefined | false)[]): string[] {
  const seen = new Set<string>();
  return list.filter((p): p is string => {
    if (!p) return false;
    const k = path.resolve(p).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
