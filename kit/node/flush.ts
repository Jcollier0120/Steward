import { closeSync, fsyncSync, openSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Writes every file under a folder through to the disk (fsync, FlushFileBuffers on Windows), so a folder renamed into
 * place afterwards is whole even if the PC goes down a moment later. Without it Windows can keep the rename, which its
 * journal writes at once, and lose the files' contents, which wait in memory for a few seconds: after a crash an
 * agent's app folder came back with every file the right size and nothing in it (all NUL bytes), and its page couldn't
 * start (kit 2.73.3). A file that can't be opened for writing is counted and left; the rest are flushed all the same.
 * About 0.03 s for an agent's app folder of 130 files.
 */
export function flushTree(dir: string, o: { flush?: (file: string) => void } = {}): { flushed: number; failed: number } {
  const flush = o.flush ?? flushFile;
  const done = { flushed: 0, failed: 0 };
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          flush(p);
          done.flushed++;
        } catch {
          done.failed++;
        }
      }
    }
  };
  walk(dir);
  return done;
}

/** One file written through to the disk. Windows flushes only through a handle that may write, so it opens r+. */
export function flushFile(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
