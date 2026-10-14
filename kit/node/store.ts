import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../app.ts';
import { fileCounts, forget, holds, readJsonFile } from './file-cache.ts';

/** A file in the agent's data folder. */
export const dataFile = (...parts: string[]) => path.join(dataDir, ...parts);

/**
 * A JSON file, or `fallback` when it is missing or unreadable (a byte-order mark is fine). A file unchanged since this
 * process last read it costs one stat, not a read (file-cache.ts, kit 2.71.3); each call parses afresh, so the caller
 * may change what it gets.
 */
export function readJson<T>(file: string, fallback: T): T {
  return readJsonFile(file, fallback);
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
 * temporary file is removed and the error thrown. A file that holds exactly that JSON already is left as it is (kit
 * 2.71.3): no temporary file and no rename, its modified time as it was; `always` writes it all the same, for a
 * write whose time is read (a person's save of Settings). `rename` and `sleep` are for tests.
 */
export function writeJson(file: string, value: unknown, o: { always?: boolean; rename?: typeof renameSync; sleep?: (ms: number) => void } = {}): void {
  const rename = o.rename ?? renameSync;
  const sleep = o.sleep ?? sleepSync;
  const text = JSON.stringify(value, null, 2) + '\n';
  if (!o.always && holds(file, text)) return void fileCounts.unchanged++;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  forget(file);
  for (let t = 1; ; t++) {
    try {
      rename(tmp, file);
      return void fileCounts.writes++;
    } catch (e) {
      if (t >= RENAME_TRIES || !BRIEFLY_REFUSED.has((e as NodeJS.ErrnoException).code ?? '')) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleep(RENAME_WAIT_MS);
    }
  }
}
