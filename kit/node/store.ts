import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** Errors with which Windows refuses a rename for a moment: something (an antivirus, the search indexer) has the file open. */
const BRIEFLY_REFUSED = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const RENAME_TRIES = 20;
const RENAME_WAIT_MS = 25;
const sleepSync = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Writes JSON through a temporary file and a rename, so a reader never sees half a file. A rename Windows refuses
 * for a moment (EPERM, EACCES or EBUSY: about one in a thousand in %TEMP% or a scanned folder, as the Wright measured
 * for the Miller) is tried again every 25 ms, for up to half a second; after that, or on any other error, the
 * temporary file is removed and the error thrown. `o` is for tests.
 */
export function writeJson(file: string, value: unknown, o: { rename?: typeof renameSync; sleep?: (ms: number) => void } = {}): void {
  const rename = o.rename ?? renameSync;
  const sleep = o.sleep ?? sleepSync;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  for (let t = 1; ; t++) {
    try {
      return rename(tmp, file);
    } catch (e) {
      if (t >= RENAME_TRIES || !BRIEFLY_REFUSED.has((e as NodeJS.ErrnoException).code ?? '')) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleep(RENAME_WAIT_MS);
    }
  }
}
