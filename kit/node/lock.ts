import os from 'node:os';
import path from 'node:path';
import * as core from './core/index.js';
import { drive, holding, LockTimeout, onDisk } from './npu-queue.ts';
import { RULES } from './rules.ts';

export { LockTimeout };

/**
 * The machine-wide NPU lock, as Reeve resolves it (src/config.ts). It stays at npu-agent's old path,
 * and its override keeps the old name, because Heiward's released builds look exactly there.
 */
export const npuLockDir =
  process.env.NPU_AGENT_NPU_LOCK ??
  (process.env.REEVE_HOME ? path.join(process.env.REEVE_HOME, 'locks', 'npu') : path.join(os.homedir(), '.npu-agent', 'locks', 'npu'));

/** The folder holding every accelerator's lock and line: the NPU lock's folder (spec/ACCELERATORS.md). */
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
 * accelerator's line (npu-queue.ts) shared by every program on this PC that uses it. Its rules (the
 * stale holder, the release only while it is ours) are the core's, as the line's are.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>, opts: { waitMs?: number; staleMs?: number } = {}): Promise<T> {
  const env = onDisk(path.dirname(dir));
  const taken = await drive(core.startLock(RULES, { folder: path.basename(dir), pid: process.pid, nowMs: Date.now(), what: dir, waitMs: opts.waitMs, staleMs: opts.staleMs }), env);
  return holding(taken, env, () => fn());
}
