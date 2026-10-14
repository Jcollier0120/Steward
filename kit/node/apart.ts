import { spawn } from 'node:child_process';
import { checksPaceLauncher } from './checks-pace.ts';

/**
 * Starting a program apart from the agent's job (kit 2.73.0): for the model servers every agent shares
 * (accelerators.ts, npu-server.ts). An agent at a gentle pace is in a job capped at a quarter of the processor
 * (gentle.ts), and so is every program it starts, so a model server the first asker started was held to that asker's
 * cap for as long as it ran, serving every other agent at that pace too. Started apart, through the checks pace's
 * launcher (`checks-pace.exe apart`), it leaves the jobs that let it (the agent's gentle job does) and keeps the rest:
 * the sign-in's own, Task Scheduler's or a terminal's.
 *
 * `startApart(cmd, args, o)` starts it detached, its output to `o.out` (a file descriptor) or nowhere, in `o.cwd` with
 * `o.env`, and answers its process id; null where it can't (not Windows, no launcher, it didn't start), and the caller
 * starts it as before. Never throws. Under node --test, null unless KIT_APART=1: a test's servers are its own children,
 * and a test never builds the launcher in this PC's kit folder.
 */
export async function startApart(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; out?: number; log?: (line: string) => void } = {}): Promise<number | null> {
  if (process.platform !== 'win32' || (process.env.NODE_TEST_CONTEXT && process.env.KIT_APART !== '1')) return null;
  const exe = await checksPaceLauncher(o.log ?? (() => {}));
  if (!exe) return null;
  const out = o.out ?? 'ignore';
  return new Promise((resolve) => {
    try {
      const child = spawn(exe, ['apart', cmd, ...args], { stdio: ['ignore', out, out], windowsHide: true, cwd: o.cwd, env: o.env });
      child.on('error', () => resolve(null));
      child.on('exit', (code) => resolve(code && code > 0 ? code : null));
    } catch {
      resolve(null);
    }
  });
}

/** Whether process `pid` is still running (a signal 0 asks without sending anything). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
