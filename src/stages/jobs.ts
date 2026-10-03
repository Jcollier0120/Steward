import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { commitOf, fetchBranch, gitMaybe, showFile } from '../git.ts';
import { expandEnv } from '../kit/settings-kit.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { lf } from '../kitfiles.ts';
import { runLine, tail } from '../run.ts';
import type { Employee } from '../settings.ts';
import { checkoutOf, result, type Ctx, type EmployeeResult } from './common.ts';

/**
 * An employee's jobs, approved as merged (each round, for one with an approve command and an installed copy in
 * Settings: Reeve). A job script runs unattended only while it is approved (Reeve pins its sha256), so an update
 * that changes a script leaves the job waiting until someone approves it again. Merged code counts as reviewed, so
 * the round approves a job when its installed script is exactly the one in the commit the installed release was
 * built from (release.json), and that commit is merged on the employee's branch on origin. Never a development
 * build (release.json says dirty), a release built from a commit that isn't merged, or a script that isn't what
 * was merged: a mismatch is said once, and left to you. What the Steward approved is kept (jobs-approved.json),
 * by script, so each is approved once.
 */

export const jobsApprovedFile = () => dataFile('jobs-approved.json');

/** A job's name, and its script's file name in jobs\: one word each, never a path out of the folder. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SCRIPT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The installed copy's jobs (jobs\jobs.json), or null when it has none. */
function installedJobs(app: string): { name: string; script: string }[] | null {
  try {
    const j = JSON.parse(readFileSync(path.join(app, 'jobs', 'jobs.json'), 'utf8').replace(/^﻿/, ''));
    const list = Array.isArray(j?.jobs) ? j.jobs : [];
    return list
      .map((x: any) => ({ name: String(x?.name ?? ''), script: String(x?.script ?? '') }))
      .filter((x: { name: string; script: string }) => NAME.test(x.name) && SCRIPT.test(x.script) && !x.script.includes('..'));
  } catch {
    return null;
  }
}

/** Notes that the Steward approved a job's installed script as it is now (after a PR's approve-jobs, say), so a round doesn't again. */
export function noteApproved(e: Employee, job: string): void {
  if (!e.installed) return;
  const app = path.resolve(expandEnv(e.installed));
  const script = installedJobs(app)?.find((j) => j.name === job)?.script;
  const file = script ? path.join(app, 'jobs', script) : null;
  if (!file || !existsSync(file)) return;
  const kept = readJson<Record<string, Record<string, string>>>(jobsApprovedFile(), {});
  kept[e.id] = { ...kept[e.id], [job]: sha256(readFileSync(file)) };
  writeJson(jobsApprovedFile(), kept);
}

/** Runs the employee's approve command for one job; its exit code and whether it was approved already. */
export async function runApprove(ctx: Ctx, e: Employee, job: string): Promise<{ code: number; already: boolean; said: string }> {
  // A job's name stays one word (NAME), so it can't add words to the command.
  const line = expandEnv(e.approve).replaceAll('{job}', job);
  ctx.log(`[${e.id}] approving ${job}: ${line}`);
  const r = await runLine(ctx.run, line, { cwd: ctx.neutralDir, timeoutMs: 2 * 60_000 });
  for (const l of tail(`${r.out}\n${r.err}`, 6).split('\n')) ctx.log(`[${e.id}]   ${l}`);
  return { code: r.code, already: /already approved/i.test(r.out), said: (r.err || r.out).trim().split('\n').pop() ?? '' };
}

/**
 * The round's look at an employee's jobs: those whose installed script is the merged one, approved; null when there
 * is nothing new to say (no jobs, nothing changed since the last round, or a standing reason it can't, like a
 * development build).
 */
export async function approveMerged(ctx: Ctx, e: Employee): Promise<EmployeeResult | null> {
  if (!e.approve || !e.installed) return null;
  const app = path.resolve(expandEnv(e.installed));
  const jobs = installedJobs(app);
  if (!jobs?.length) return null;
  const kept = readJson<Record<string, Record<string, string>>>(jobsApprovedFile(), {});
  const mine: Record<string, string> = { ...kept[e.id] };
  // Only the scripts that changed since the Steward last approved (or turned down) them.
  const fresh = jobs
    .map((j) => ({ ...j, file: path.join(app, 'jobs', j.script) }))
    .filter((j) => existsSync(j.file))
    .map((j) => ({ ...j, bytes: readFileSync(j.file) }))
    .map((j) => ({ ...j, hash: sha256(j.bytes) }))
    .filter((j) => mine[j.name] !== j.hash && mine[`!${j.name}`] !== j.hash);
  if (!fresh.length) return null;

  let built: { commit?: unknown; dirty?: unknown } = {};
  try {
    built = JSON.parse(readFileSync(path.join(app, 'release.json'), 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
  // A development build, or no record of what it was built from: its jobs are a person's to approve.
  if (built.dirty !== false || typeof built.commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(built.commit)) return null;
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return null;
  await fetchBranch(ctx.run, repo, e.branch);
  const commit = await commitOf(ctx.run, repo, built.commit);
  const short = built.commit.slice(0, 7);
  // Built from a commit that isn't merged on its branch: not reviewed, so not approved.
  if (!commit || (await gitMaybe(ctx.run, repo, 'merge-base', '--is-ancestor', commit, `origin/${e.branch}`)) === null) return null;

  const approved: string[] = [];
  const turnedDown: string[] = [];
  const failed: string[] = [];
  for (const j of fresh) {
    const merged = await showFile(ctx.run, repo, commit, `jobs/${j.script}`);
    if (merged === null || lf(merged) !== lf(j.bytes.toString('utf8'))) {
      mine[`!${j.name}`] = j.hash;
      turnedDown.push(j.name);
      continue;
    }
    const r = await runApprove(ctx, e, j.name);
    if (r.code !== 0) {
      failed.push(`${j.name} (exit ${r.code}: ${r.said})`);
      continue;
    }
    mine[j.name] = j.hash;
    delete mine[`!${j.name}`];
    if (!r.already) approved.push(j.name);
  }
  kept[e.id] = mine;
  writeJson(jobsApprovedFile(), kept);
  const parts = [
    ...(approved.length ? [`approved ${approved.join(', ')}: ${approved.length === 1 ? 'its installed script is the one' : 'their installed scripts are the ones'} merged on ${e.branch} at ${short}`] : []),
    ...(turnedDown.length ? [`${turnedDown.join(', ')}: the installed ${turnedDown.length === 1 ? "script isn't the one" : "scripts aren't the ones"} merged at ${short}, so not approved: yours to look at`] : []),
    ...(failed.length ? [`couldn't approve ${failed.join(', ')}`] : []),
  ];
  if (!parts.length) return null;
  return result(e, failed.length || turnedDown.length ? 'failed' : 'done', parts.join('; '));
}
