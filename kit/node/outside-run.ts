import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OutsideJob, OutsideSetupResult } from './outside.ts';

/**
 * A job run outside the packaged app that asked for it (outside.ts' runOutside, kit 2.113.5): `node outside-run.ts
 * <job folder>`, started by Task Scheduler. Its process id goes in pid.json first, each line it says in log.txt, and
 * its result in result.json last, then it exits.
 *
 * Nothing of the kit is imported until the job's variables are set: the kit's modules read their folders from the
 * environment as they load (the accelerators' home, a scratch REEVE_HOME), and Task Scheduler starts this with the
 * account's own environment, not the one that asked.
 */

const folder = path.resolve(process.argv[2] ?? '.');
const file = (name: string) => path.join(folder, name);

function writeWhole(name: string, value: unknown): void {
  writeFileSync(file(`${name}.tmp`), JSON.stringify(value, null, 2) + '\n');
  renameSync(file(`${name}.tmp`), file(name));
}

const log = (line: string) => appendFileSync(file('log.txt'), `${line}\n`);

async function doJob(job: OutsideJob): Promise<unknown> {
  if (job.kind === 'setup') {
    const { setupCommand } = await import('./setup.ts');
    const r = await setupCommand({ ...job.options, kinds: job.options.kinds as any, cpuKinds: job.options.cpuKinds as any, asked: true, log });
    return { code: r.code, entries: r.entries ?? [], ...(r.busy ? { busy: true } : {}), ...(r.blocked ? { blocked: true } : {}) } satisfies OutsideSetupResult;
  }
  const { putPatchIn, putStockBack } = await import('./npu-patch.ts');
  const { sha256File } = await import('./npu-vendors.ts');
  if (job.kind === 'patch-in') await putPatchIn(job.target, job.from, job.want, job.isStock, sha256File);
  else putStockBack(job.target);
  return null;
}

writeWhole('pid.json', { pid: process.pid });
try {
  const { job, env } = JSON.parse(readFileSync(file('job.json'), 'utf8')) as { job: OutsideJob; env: Record<string, string> };
  Object.assign(process.env, env, { KIT_OUTSIDE: '1' });
  writeWhole('result.json', { ok: true, value: await doJob(job) });
} catch (e: any) {
  log(String(e?.message ?? e));
  writeWhole('result.json', { ok: false, error: String(e?.message ?? e).split(/\r?\n/)[0] });
}
// The PowerShell worker, and anything else setup left waiting on, would hold the process: it's done.
process.exit(0);
