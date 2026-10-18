import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the capture apps save game clips and screenshots, and which game each capture is of (pure but for the
 * listing, which the tests give it). Kit 2.87.0: the Chronicler (clips, its clips.ts) and the Scribe (screenshots, its
 * shots.ts) each had a copy. The places:
 * - **Xbox Game Bar**: `Captures` under Videos (or wherever Windows says it moved: folders.ts' `captures`), named
 *   "<Game> 2026-10-08 14-03-22.mp4" (older Windows: "<Game> 10_8_2026 2_03_22 PM.mp4").
 * - **NVIDIA**: the NVIDIA app's `Videos\NVIDIA\<Game>`, and GeForce Experience's `Videos\<Game>`, named
 *   "<Game> 2026.10.08 - 14.03.22.01.DVR.mp4".
 * - **AMD**: `Videos\Radeon ReLive\<Game>`.
 * - **Other folders** from an agent's Settings: each subfolder a game, captures loose in it named by their own names.
 * - Any place the agent adds with its game fixed (the Scribe's Steam screenshot folders).
 * Only the top level and one folder down are listed, and nothing is read: a capture's game is its folder or its name.
 */

export type CaptureSource = 'gamebar' | 'nvidia' | 'amd' | 'steam' | 'other';

export interface Entry {
  name: string;
  dir: boolean;
  bytes: number;
  mtimeMs: number;
}

export type List = (dir: string) => Entry[];

/** A folder's entries with their sizes and times; none when it can't be read, and an entry that can't be is left out. */
export const list: List = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      try {
        const st = statSync(path.join(dir, d.name));
        return [{ name: d.name, dir: d.isDirectory(), bytes: st.size, mtimeMs: st.mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/** The capture apps' date and time at the end of a name, as the Scribe reads them: NVIDIA's, Xbox Game Bar's and older Game Bar's. */
const STAMPS = [/\s+\d{4}\.\d{2}\.\d{2}\s+-\s+\d{2}\.\d{2}\.\d{2}(\.\d+)?$/i, /\s+\d{4}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2}$/, /\s+\d{1,2}_\d{1,2}_\d{4}\s+\d{1,2}_\d{2}_\d{2}(\s*[AP]M)?$/i];

/**
 * The game a capture's own name gives, with the date and time the capture app adds taken off; null for none.
 *
 * - As the Chronicler reads a clip's name (the default): each capture app's date and time taken off its end (NVIDIA's
 *   with its ".DVR"), and what's left is the game, unless it is only numbers or "replay", "clip" or "recording" with
 *   numbers (OBS's and others' names). A name with no date at all is its own game ("Best goal ever.mp4").
 * - `requireStamp`, as the Scribe reads a screenshot's: a copy's " (2)" taken off first, then one capture app's date
 *   and time (NVIDIA's without ".DVR"); a name without one gives no game ("Screenshot 2026-10-08.png").
 */
export function gameFromName(name: string, o: { requireStamp?: boolean } = {}): string | null {
  if (o.requireStamp) {
    const s = stem(name).replace(/\s*\(\d+\)$/, '');
    const stamp = STAMPS.find((r) => r.test(s));
    if (!stamp) return null;
    const game = s.replace(stamp, '').trim();
    return game && !/^\d[\d\s._-]*$/.test(game) ? game : null;
  }
  const s = stem(name)
    // NVIDIA: "Game 2026.10.08 - 14.03.22.01.DVR"
    .replace(/\s+\d{4}\.\d{2}\.\d{2}\s+-\s+\d{2}\.\d{2}\.\d{2}(\.\d+)?(\.DVR)?$/i, '')
    // Game Bar: "Game 2026-10-08 14-03-22"
    .replace(/\s+\d{4}-\d{2}-\d{2}\s+\d{2}-\d{2}-\d{2}$/, '')
    // Older Game Bar: "Game 10_8_2026 2_03_22 PM"
    .replace(/\s+\d{1,2}_\d{1,2}_\d{4}\s+\d{1,2}_\d{2}_\d{2}(\s*[AP]M)?$/i, '')
    // OBS and others: "2026-10-08 14-03-22", "replay_2026.10.08-14.03"
    .trim();
  if (!s || /^\d[\d\s._-]*$/.test(s) || /^(replay|clip|recording)[\s_-]*[\d\s._-]*$/i.test(s)) return null;
  return s;
}

/**
 * Folders a capture app keeps that aren't games, in lower case: both agents' lists together (the Chronicler's had
 * "desktop.ini", the Scribe's "thumbnails"). An agent that wants its own passes it to walkCaptures.
 */
export const NOT_GAMES: ReadonlySet<string> = new Set(['captures', 'nvidia', 'radeon relive', 'amd', 'game clips', 'desktop', 'desktop.ini', 'thumbnails']);

export interface CapturePlace<S extends string = CaptureSource> {
  dir: string;
  source: S;
  /** Subfolders are games. */
  byFolder: boolean;
  /** Loose captures only when their names are NVIDIA's (GeForce Experience's, in Videos itself). */
  looseNeedsGame?: boolean;
  /** Every capture here is of this game (a Steam game's screenshot folder). */
  game?: string;
}

/** The capture apps' places, from the Videos folder, Game Bar's Captures folder (null: Videos\Captures) and Settings' other folders. */
export function capturePlaces(o: { videos: string; captures: string | null; more: string[] }): CapturePlace[] {
  const v = o.videos;
  return [
    { dir: o.captures ?? path.join(v, 'Captures'), source: 'gamebar', byFolder: false },
    { dir: path.join(v, 'NVIDIA'), source: 'nvidia', byFolder: true },
    { dir: path.join(v, 'Radeon ReLive'), source: 'amd', byFolder: true },
    // GeForce Experience's game folders sit in Videos itself, beside everything else: only captures named as NVIDIA names them.
    { dir: v, source: 'nvidia', byFolder: true, looseNeedsGame: true },
    ...o.more.map((dir): CapturePlace => ({ dir, source: 'other', byFolder: true })),
  ];
}

/** NVIDIA's date and time in a name ("<Game> 2026.10.08 - 14.03.22"). */
export const isNvidiaName = (name: string) => /\s\d{4}\.\d{2}\.\d{2}\s+-\s+\d{2}\.\d{2}\.\d{2}/.test(name);

export interface Capture<S extends string = CaptureSource> {
  path: string;
  name: string;
  /** null when neither its folder nor its name says (the agent's "Other clips", "Other screenshots"). */
  game: string | null;
  source: S;
  bytes: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** The captures wanted, by name (the Chronicler's videos, the Scribe's pictures). */
  ext: RegExp;
  /** A capture changed this recently may still be being written, and is left for the next look. */
  settledMs: number;
  now: number;
  list?: List;
  /** Folders not to look in, nor in their game folders (the Chronicler's library). */
  skip?: string[];
  /** How a loose capture's name gives its game (gameFromName's). */
  requireStamp?: boolean;
  /** Subfolders that aren't games, in lower case: NOT_GAMES unless given. */
  notGames?: ReadonlySet<string>;
}

/**
 * Every settled capture in the places, each once (the first place it's found in), with its game, newest first. A
 * loose capture's game is its place's, else its name's, else (in an other folder) the folder's own name; a capture in
 * a game folder is that game's.
 */
export function walkCaptures<S extends string>(places: CapturePlace<S>[], o: WalkOptions): Capture<S>[] {
  const ls = o.list ?? list;
  const notGames = o.notGames ?? NOT_GAMES;
  const skip = new Set((o.skip ?? []).map((d) => path.resolve(d).toLowerCase()));
  const seen = new Map<string, Capture<S>>();
  const add = (dir: string, e: Entry, game: string | null, source: S) => {
    const p = path.join(dir, e.name);
    const key = p.toLowerCase();
    if (e.dir || !o.ext.test(e.name) || e.bytes === 0 || o.now - e.mtimeMs < o.settledMs || seen.has(key)) return;
    seen.set(key, { path: p, name: e.name, game, source, bytes: e.bytes, mtimeMs: e.mtimeMs });
  };
  for (const pl of places) {
    if (skip.size && skip.has(path.resolve(pl.dir).toLowerCase())) continue;
    for (const e of ls(pl.dir)) {
      if (!e.dir) {
        if (pl.looseNeedsGame && !isNvidiaName(e.name)) continue;
        add(pl.dir, e, pl.game ?? gameFromName(e.name, o) ?? (pl.byFolder && pl.source === 'other' ? path.basename(pl.dir) : null), pl.source);
        continue;
      }
      if (!pl.byFolder || notGames.has(e.name.toLowerCase())) continue;
      const sub = path.join(pl.dir, e.name);
      if (skip.size && skip.has(path.resolve(sub).toLowerCase())) continue;
      for (const f of ls(sub)) {
        if (pl.looseNeedsGame && !isNvidiaName(f.name)) continue;
        add(sub, f, e.name, pl.source);
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A capture's key: its path, size and time, so one changed since is a new one. */
export const captureKey = (c: Pick<Capture<string>, 'path' | 'bytes' | 'mtimeMs'>) => `${c.path.toLowerCase()}|${c.bytes}|${Math.round(c.mtimeMs)}`;
