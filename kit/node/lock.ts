import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LockTimeout } from './npu-queue.ts';

export { LockTimeout };

/**
 * The machine-wide NPU lock, as Reeve resolves it (src/config.ts). It stays at npu-agent's old path,
 * and its override keeps the old name, because Heiward's released builds look exactly there.
 */
export const npuLockDir =
  process.env.NPU_AGENT_NPU_LOCK ??
  (process.env.REEVE_HOME ? path.join(process.env.REEVE_HOME, 'locks', 'npu') : path.join(os.homedir(), '.npu-agent', 'locks', 'npu'));

/** The folder holding every accelerator's lock and line: the NPU lock's folder (Manor's docs/ACCELERATORS.md). */
export const locksDir = path.dirname(npuLockDir);

/**
 * An accelerator's lock folder, for its first slot: `locks\npu` for the NPU (as before), `locks\<id>`
 * for the others. Its other slots are `<lock>.2` … and its line `<lock>.queue` (npu-queue.ts).
 */
export const lockDirFor = (id: string) => (id === 'npu' ? npuLockDir : path.join(locksDir, id));

/**
 * The accelerators' shared files (failure markers, games.json): `accelerators` beside `locks`, so it
 * moves with NPU_AGENT_NPU_LOCK, and a scratch REEVE_HOME gets its own.
 */
export const acceleratorsDir = path.join(path.dirname(locksDir), 'accelerators');

/**
 * A plain machine-wide mutex on atomic `mkdir`, as Reeve's src/lock.ts: for locks nobody queues for.
 * NOT for an accelerator: model work goes through the kit's npu.ts, which waits its turn in the
 * accelerator's line (npu-queue.ts) shared by every program on this PC that uses it.
 */
export async function withLock<T>(
  dir: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; staleMs?: number } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? 300_000;
  const staleMs = opts.staleMs ?? 600_000;
  const owner = path.join(dir, 'owner.json');
  const deadline = Date.now() + waitMs;
  mkdirSync(path.dirname(dir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, JSON.stringify({ pid: process.pid, since: Date.now() }));
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      if (isStale(owner, staleMs)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new LockTimeout(`timed out after ${waitMs} ms waiting for ${dir}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isStale(owner: string, staleMs: number): boolean {
  let info: { pid: number; since: number };
  try {
    info = JSON.parse(readFileSync(owner, 'utf8'));
  } catch {
    // The owner file is not written yet (give the holder a moment) or was lost in a crash.
    try {
      return Date.now() - statSync(path.dirname(owner)).mtimeMs > 10_000;
    } catch {
      return false;
    }
  }
  if (Date.now() - info.since > staleMs) return true;
  try {
    process.kill(info.pid, 0);
    return false;
  } catch (e: any) {
    return e?.code === 'ESRCH';
  }
}
