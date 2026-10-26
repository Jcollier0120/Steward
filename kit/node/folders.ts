import os from 'node:os';
import path from 'node:path';
import { powershellSync } from './ps.ts';
import { pathKey } from './real-path.ts';

/**
 * The folders Windows keeps for a person (Desktop, Documents, Downloads, Pictures, Music, Videos, Screenshots, Captures), where
 * they are on this PC. OneDrive's folder backup moves Desktop, Documents and Pictures into the OneDrive folder, and a
 * person can move any of them, so the usual %USERPROFILE%\Documents is often wrong: the real places are Windows' known
 * folders (the registry's User Shell Folders), which is what Explorer itself reads. An agent that offers "Automatic:
 * the folders Windows uses" reads them here, instead of asking for a path.
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
  /**
   * Where Xbox Game Bar saves its clips and screenshots (Win+Alt+R, Win+Alt+PrtScn), when it says (the Captures known
   * folder, moved); Videos\Captures otherwise. Kit 2.87.0, for Chronicler and Scribe (captures.ts).
   */
  captures: string;
  /** The OneDrive folder, when OneDrive is set up. */
  oneDrive: string | null;
}

const SHELL_FOLDERS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

/**
 * The registry's names for them: old names for the old folders, GUIDs for the newer ones. Downloads' is
 * FOLDERID_Downloads since kit 2.137.2: before, another GUID was here, so a Downloads folder moved elsewhere wasn't found.
 */
const NAMES = {
  desktop: 'Desktop',
  documents: 'Personal',
  downloads: '{374DE290-123F-4565-9164-39C4925E467B}',
  pictures: 'My Pictures',
  music: 'My Music',
  videos: 'My Video',
  screenshots: '{B7BEDE81-DF94-4682-A7D8-57A52620B86F}',
  captures: '{EDC0FE71-98D8-4F4A-B920-C8DC133CB165}',
} as const;

type Folder = keyof typeof NAMES;

/** [Environment]::GetFolderPath's names (SpecialFolder) for the folders it has one for; the rest are read from the registry. */
const SPECIAL: Partial<Record<Folder, string>> = { desktop: 'DesktopDirectory', documents: 'MyDocuments', pictures: 'MyPictures', music: 'MyMusic', videos: 'MyVideos' };

/**
 * Windows' answer in one PowerShell script (kit 2.137.2), as JSON named as KnownFolders: GetFolderPath (DoNotVerify: a
 * folder that isn't there is still named) for the folders it has a name for, and the registry's User Shell Folders,
 * %NAME% expanded, for the rest (Downloads, Screenshots, Captures). Through the kit's PowerShell, which is UTF-8 end to
 * end. Before 2.137.2 this was reg.exe's answer, which comes in the console's code page: a user or folder name in
 * another script (Jürgen, Документы, 書類) came back mangled, and the folder wasn't found (the Clerk and the
 * Chamberlain met the same in their own lookups).
 */
export const KNOWN_FOLDERS_SCRIPT = [
  `$usf = Get-ItemProperty -LiteralPath '${SHELL_FOLDERS}' -ErrorAction SilentlyContinue`,
  "function shellFolder($name) { if ($usf) { [Environment]::ExpandEnvironmentVariables([string]$usf.$name) } else { '' } }",
  'ConvertTo-Json -Compress -InputObject ([ordered]@{',
  ...(Object.keys(NAMES) as Folder[]).map((k) => `  ${k} = ${SPECIAL[k] ? `[Environment]::GetFolderPath('${SPECIAL[k]}', 'DoNotVerify')` : `shellFolder '${NAMES[k]}'`}`),
  '})',
].join('\n');

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

/** Each folder as an answer names it: KNOWN_FOLDERS_SCRIPT's JSON, or a `reg query` of User Shell Folders (before kit 2.137.2). */
function named(answer: string | null, env: Record<string, string | undefined>): Partial<Record<Folder, unknown>> {
  const text = answer?.trim();
  if (!text) return {};
  if (!text.startsWith('{')) {
    const shell = parseShellFolders(text, env);
    return Object.fromEntries((Object.keys(NAMES) as Folder[]).map((k) => [k, shell[NAMES[k]]]));
  }
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    // Not an answer: the usual places.
    return {};
  }
}

/**
 * The known folders from Windows' answer (KNOWN_FOLDERS_SCRIPT's JSON; a `reg query` of User Shell Folders is read too,
 * as before kit 2.137.2), null for none, with the usual places for what it left out.
 */
export function foldersFrom(answer: string | null, o: { home?: string; env?: Record<string, string | undefined> } = {}): KnownFolders {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const said = named(answer, env);
  // A value that is blank, not a full path, or still holds a %NAME% that didn't expand is no place to look.
  const at = (k: Folder): string | null => {
    const v = said[k];
    return typeof v === 'string' && path.win32.isAbsolute(v) && !/%[^%]+%/.test(v) ? path.normalize(v) : null;
  };
  const pictures = at('pictures') ?? path.join(home, 'Pictures');
  const videos = at('videos') ?? path.join(home, 'Videos');
  return {
    home,
    desktop: at('desktop') ?? path.join(home, 'Desktop'),
    documents: at('documents') ?? path.join(home, 'Documents'),
    downloads: at('downloads') ?? path.join(home, 'Downloads'),
    pictures,
    music: at('music') ?? path.join(home, 'Music'),
    videos,
    screenshots: at('screenshots') ?? path.join(pictures, 'Screenshots'),
    captures: at('captures') ?? path.join(videos, 'Captures'),
    oneDrive: env.OneDrive || env.OneDriveConsumer || env.OneDriveCommercial || null,
  };
}

/**
 * Windows' answer, asked now (`ask` runs the script: the kit's PowerShell, a stand-in in tests), and whether it answered.
 * Off Windows, or with no answer, the usual places.
 */
export function readKnownFolders(ask: (script: string) => string = (s) => powershellSync(s, { timeoutMs: 10_000 })): { folders: KnownFolders; answered: boolean } {
  if (process.platform !== 'win32') return { folders: foldersFrom(null), answered: false };
  try {
    const answer = ask(KNOWN_FOLDERS_SCRIPT);
    JSON.parse(answer);
    return { folders: foldersFrom(answer), answered: true };
  } catch {
    return { folders: foldersFrom(null), answered: false };
  }
}

/** How long after Windows didn't answer it is asked again (meanwhile, the usual places): each ask holds the caller. */
const ASK_AGAIN_MS = 10 * 60_000;
let known: KnownFolders | undefined;
let unanswered = -Infinity;

/**
 * This PC's known folders, read once (a folder moved while the agent runs is seen at its next start): about 0.2 s of
 * PowerShell, the first time. Off Windows, or with no answer, the usual places in the home folder, and Windows is asked
 * again after ASK_AGAIN_MS.
 */
export function knownFolders(): KnownFolders {
  if (known) return known;
  if (Date.now() - unanswered < ASK_AGAIN_MS) return foldersFrom(null);
  const r = readKnownFolders();
  if (r.answered) known = r.folders;
  else unanswered = Date.now();
  return r.folders;
}

/**
 * The paths given, each once (compared as Windows does, ignoring case, and by their real paths: a folder reached
 * through a junction or a mounted folder is one folder), the empty ones left out.
 */
export function uniqueFolders(list: (string | null | undefined | false)[]): string[] {
  const seen = new Set<string>();
  return list.filter((p): p is string => {
    if (!p) return false;
    const k = pathKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
