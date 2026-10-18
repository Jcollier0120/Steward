import { readFileSync, statSync, type Stats } from 'node:fs';

/**
 * Small files read often, kept by what one stat says of them (kit 2.71.3). An agent answers each of Manor's pings by
 * reading its settings, its duty and Manor's settings; its rounds read round.json and Manor's pace. Those files change
 * seldom, so a read here costs one stat while the file is as it was: the same modified time, change time, size and
 * file id as when it was read. Any change to the file, by this process or another, changes one of them, and the next
 * read reads it again. Callers see exactly what a fresh read would have given them.
 *
 * A file modified within SETTLED_MS of being read is read again each time until it settles: a second change in the
 * same tick of the file system's clock (Windows stamps files by its clock tick, 15.6 ms by default; FAT by two
 * seconds) could leave all four the same (git's "racy" files). Files over MAX_BYTES are read and never kept, and at
 * most MAX_FILES are kept, the least recently read let go first.
 */
export const SETTLED_MS = 2_000;
export const MAX_BYTES = 1 << 20;
export const MAX_FILES = 256;

interface Kept {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  text: string;
  readAt: number;
  /** Its JSON, parsed and frozen once it was asked for (readJsonShared). */
  json?: { value: unknown };
}

const kept = new Map<string, Kept>();

/** What this process has done to files through the kit's store, since it started: for tests and measurements. */
export const fileCounts = { reads: 0, kept: 0, writes: 0, unchanged: 0, parsed: 0 };

/** The file's stat, or null when it isn't there or can't be looked at (as existsSync() says false). */
export function statOf(file: string): Stats | null {
  try {
    return statSync(file, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

const unchanged = (k: Kept, s: Stats) => k.mtimeMs === s.mtimeMs && k.ctimeMs === s.ctimeMs && k.size === s.size && k.ino === s.ino;

/**
 * A file's text, from what was kept when the file is unchanged since; null when it isn't there or isn't a file. A
 * file that is there but can't be read throws, as readFileSync() does. `s` is the file's stat when the caller has it.
 */
export function readText(file: string, s: Stats | null = statOf(file)): string | null {
  if (!s?.isFile()) {
    kept.delete(file);
    return null;
  }
  const k = kept.get(file);
  if (k && unchanged(k, s) && k.readAt - s.mtimeMs >= SETTLED_MS) {
    // Most recently read last: the first in the map is the one let go.
    kept.delete(file);
    kept.set(file, k);
    fileCounts.kept++;
    return k.text;
  }
  kept.delete(file);
  // The earlier of the wall clock and the process's own (which a test's mocked Date, or a clock set back, can't move
  // ahead): a clock running ahead could take a file not yet settled for one that has.
  const readAt = Math.min(Date.now(), performance.timeOrigin + performance.now());
  const text = readFileSync(file, 'utf8');
  fileCounts.reads++;
  if (s.size <= MAX_BYTES) {
    kept.set(file, { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size, ino: s.ino, text, readAt });
    if (kept.size > MAX_FILES) kept.delete(kept.keys().next().value as string);
  }
  return text;
}

/** Whether the file holds exactly `text` now (a read only when its size says it may). */
export function holds(file: string, text: string): boolean {
  const s = statOf(file);
  if (!s?.isFile() || s.size !== Buffer.byteLength(text)) return false;
  try {
    return readText(file, s) === text;
  } catch {
    return false;
  }
}

/** Forgets what was kept of `file`: it has just been written. */
export const forget = (file: string) => void kept.delete(file);

/** A JSON file, or `fallback` when it is missing or unreadable (a byte-order mark is fine). */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const text = readText(file);
    return text === null ? fallback : (JSON.parse(text.replace(/^﻿/, '')) as T);
  } catch {
    return fallback;
  }
}

/** A parsed JSON value, frozen all the way down. */
function frozen<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) frozen(x);
    Object.freeze(v);
  }
  return v;
}

const parsed = (text: string): unknown => {
  fileCounts.parsed++;
  return frozen(JSON.parse(text.replace(/^﻿/, '')));
};

/**
 * A JSON file for a caller that only reads it, parsed once while the file is unchanged (kit 2.83.2): each call gets
 * the same value, frozen all the way down, so no caller can change what the next one gets (a change throws). `fallback`
 * when the file is missing, and `broken` (`fallback` unless said) when it is there but can't be read or isn't JSON. A
 * file not yet settled, or too big to keep, is parsed afresh each time, frozen the same. Manor's app\staff.json (64 KB)
 * and agents.json (20 KB) were parsed on each of the Steward's settings reads, every two seconds, and on each
 * agentUrl(); the Steward's own settings.json (28 KB with 40 employees) three times a read.
 */
export function readJsonShared<T, B = T>(file: string, fallback: T, ...broken: [B?]): T | B {
  try {
    const text = readText(file);
    if (text === null) return fallback;
    const k = kept.get(file);
    if (k?.text !== text) return parsed(text) as T;
    k.json ??= { value: parsed(text) };
    return k.json.value as T;
  } catch {
    return broken.length ? (broken[0] as B) : fallback;
  }
}
