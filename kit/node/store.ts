import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../app.ts';

/** A file in the agent's data folder. */
export const dataFile = (...parts: string[]) => path.join(dataDir, ...parts);

/** A JSON file, or `fallback` when it is missing or unreadable (a byte-order mark is fine). */
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as T;
  } catch {
    return fallback;
  }
}

/** Writes JSON through a temporary file and a rename, so a reader never sees half a file. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}
