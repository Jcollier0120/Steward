import { spawn } from 'node:child_process';
import { checksPaceLauncher } from './checks-pace.ts';
import { CEILING_CAP, CEILING_ENV, ceilingCap } from './pace.ts';

/**
 * Starting a program apart from the agent's job (kit 2.73.0): for the model servers every agent shares
 * (accelerators.ts, npu-server.ts). An agent at a gentle pace is in a job capped at a quarter of the processor
 * (gentle.ts), and so is every program it starts, so a model server the first asker started was held to that asker's
 * cap for as long as it ran, serving every other agent at that pace too. Started apart, through the checks pace's
 * launcher (`checks-pace.exe apart`), it leaves the jobs that let it (the agent's gentle job does) and keeps the rest:
 * the sign-in's own, Task Scheduler's or a terminal's.
 *
 * Apart is not uncapped (kit 2.78.3): every server started apart joins one job for the PC (`Local\kit-apart-pace`,
 * `checks-pace.exe apart:<cap>`) with a hard cap at the manor's ceiling (pace.ts's CEILING_CAP, 85% of the processor),
 * whatever the asker's pace, so the servers together never take the whole PC. A server already running keeps what it
 * was started with until it next starts. From kit 2.78.7 that job nests in the manor's ceiling (pace.ts ceilingCap()),
 * which the agents and their check runs are in too, so the servers share the 85% with them rather than adding to it.
 *
 * `startApart(cmd, args, o)` starts it detached, its output to `o.out` (a file descriptor) or nowhere, in `o.cwd` with
 * `o.env`, and answers its process id; null where it can't (not Windows, no launcher, it didn't start), and the caller
 * starts it as before. Never throws. Under node --test, null unless KIT_APART=1: a test's servers are its own children,
 * and a test never builds the launcher in this PC's kit folder.
 *
 * `o.cap` 0 (kit 2.144.2) keeps a program that is no model server out of the servers' job: it only leaves the jobs that
 * would end it with the program that started it, as an update's probation watcher must (safeinstall.ts). A program
 * merely detached stays in its starter's jobs, and its starter's gentle job is ended with its starter: the PowerShell
 * worker that joins it (gentle.ts) is in the job Node keeps for its own children, which Windows ends when Node exits.
 */
export async function startApart(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; out?: number; log?: (line: string) => void; cap?: number } = {}): Promise<number | null> {
  if (process.platform !== 'win32' || (process.env.NODE_TEST_CONTEXT && process.env.KIT_APART !== '1')) return null;
  const exe = await checksPaceLauncher(o.log ?? (() => {}));
  if (!exe) return null;
  const out = o.out ?? 'ignore';
  return new Promise((resolve) => {
    try {
      const env = { ...(o.env ?? process.env), [CEILING_ENV]: String(ceilingCap()) };
      const child = spawn(exe, [`apart:${o.cap ?? apartCap()}`, cmd, ...args], { stdio: ['ignore', out, out], windowsHide: true, cwd: o.cwd, env });
      child.on('error', () => resolve(null));
      child.on('exit', (code) => resolve(code && code > 0 ? code : null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * The cap on the servers' job, in hundredths of a percent: the manor's ceiling. Under node --test, KIT_APART_CAP's (a
 * test's servers in a job of their own, KIT_APART_JOB_NAME), else none, as before.
 */
export function apartCap(env: NodeJS.ProcessEnv = process.env): number {
  if (!env.NODE_TEST_CONTEXT) return CEILING_CAP;
  const n = Number(env.KIT_APART_CAP);
  return Number.isInteger(n) && n > 0 ? Math.min(n, CEILING_CAP) : 0;
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
