import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AfterStep } from '../after.ts';
import { gh } from '../git.ts';
import { runLine, tail } from '../run.ts';
import { releasedHere, type Employee, type Settings } from '../settings.ts';
import { result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { installedHash, noteApproved, runApprove } from './jobs.ts';
import { releaseOne } from './release.ts';
import { appReleasesIn, type PrInfo } from './staff.ts';

/**
 * The steps a merged PR asks for (src/after.ts reads them from its description), run for its employee and
 * reported as lines of the merge stage.
 */

/** Where the Steward unpacks an employee's release to install it. */
export const installDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-install`);

const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** The sha256 SHA256SUMS.txt gives a file, or null. */
export function listedSum(sums: string, file: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === file) return m[1].toLowerCase();
  }
  return null;
}

/** An employee's newest release, installed on this PC from its zip on GitHub, with its install command. */
export async function installOne(ctx: Ctx, e: Employee): Promise<EmployeeResult> {
  const { run } = ctx;
  // Released on this PC (an internal employee): its release built it from its clone and installed it already.
  if (releasedHere(e)) return result(e, 'done', `installed by its release, built here from its clone (${e.release})`);
  // No install command: it is installed another way (Heiward, by Manor, from its own installer), not by the Steward.
  if (!e.install) return result(e, 'skipped', `Settings give ${e.name} no install command, so it is installed another way (Manor's updates), not by the Steward`);
  const latest = appReleasesIn(await gh(run, ctx.neutralDir, 'release', 'list', '--repo', e.repo, '--limit', '100', '--json', 'tagName,isDraft,publishedAt'))[0];
  if (!latest) return result(e, 'refused', 'it has no release to install');
  const dir = installDirOf(ctx.settings, e);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await gh(run, ctx.neutralDir, 'release', 'download', latest.tag, '--repo', e.repo, '--pattern', '*.zip', '--pattern', 'SHA256SUMS.txt', '--dir', dir, '--clobber');
  const zips = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.zip'));
  if (zips.length !== 1) return result(e, 'refused', `${latest.tag} has ${zips.length} zips, where one is expected`);
  const zip = zips[0];
  const sumsFile = path.join(dir, 'SHA256SUMS.txt');
  const listed = existsSync(sumsFile) ? listedSum(readFileSync(sumsFile, 'utf8'), zip) : null;
  if (!listed) return result(e, 'refused', `${latest.tag} has no SHA256SUMS.txt naming ${zip}, so it isn't installed`);
  if (createHash('sha256').update(readFileSync(path.join(dir, zip))).digest('hex') !== listed) return result(e, 'refused', `${zip} doesn't match its SHA256SUMS.txt, so it isn't installed`);
  const app = path.join(dir, 'release');
  mkdirSync(app);
  const t = await run(TAR, ['-x', '-f', path.join(dir, zip), '-C', app], { timeoutMs: 10 * 60_000 });
  if (t.code !== 0) return result(e, 'failed', `couldn't unpack ${zip}: ${(t.err || t.out).trim().split('\n').pop()}`);
  let built: { version?: unknown } = {};
  try {
    built = JSON.parse(readFileSync(path.join(app, 'release.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return result(e, 'refused', `${zip} holds no release.json, so it isn't a release to install`);
  }
  if (built.version !== latest.version) return result(e, 'refused', `${zip}'s release.json says ${String(built.version)}, not ${latest.version}`);
  ctx.log(`[${e.id}] installing ${latest.tag} (${zip}, checked against SHA256SUMS.txt): ${e.install}`);
  const r = await runLine(run, e.install, { cwd: app, timeoutMs: 15 * 60_000 });
  for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${line}`);
  if (r.code !== 0) return result(e, 'failed', `${e.install} failed (exit ${r.code}); the release is left unpacked in ${app}`, { version: latest.version });
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
  }
  return result(e, 'done', `installed ${latest.tag} on this PC`, { version: latest.version, url: `https://github.com/${e.repo}/releases/tag/${latest.tag}` });
}

/**
 * The jobs the merged PRs name, approved in the installed copy with the employee's approve command: merging a PR
 * counts as reading its scripts. A job script a PR changed but didn't name isn't approved; the result says so.
 */
export async function approveJobs(ctx: Ctx, e: Employee, prs: PrInfo[]): Promise<EmployeeResult> {
  const asking = prs.filter((p) => p.after?.steps.includes('approve-jobs'));
  const jobs = [...new Set(asking.flatMap((p) => p.after!.jobs))];
  if (!e.approve) return result(e, 'refused', `Settings give ${e.name} no approve command, so ${jobs.join(', ')} ${jobs.length === 1 ? 'waits' : 'wait'} for you`);
  const unnamed: string[] = [];
  for (const p of asking) {
    try {
      const files = (JSON.parse(await gh(ctx.run, ctx.neutralDir, 'pr', 'view', String(p.number), '--repo', e.repo, '--json', 'files')).files ?? []) as { path?: string }[];
      for (const f of files) {
        const m = /^jobs\/([^/]+)\.ps1$/.exec(String(f.path ?? ''));
        if (m && !jobs.includes(m[1]) && !unnamed.includes(m[1])) unnamed.push(m[1]);
      }
    } catch (err) {
      ctx.log(`[${e.id}] couldn't list #${p.number}'s files: ${(err as Error).message}`);
    }
  }
  const approved: string[] = [];
  const failed: string[] = [];
  for (const job of jobs) {
    // A job's name is letters, digits, dots, dashes and underscores (src/after.ts), so it stays one word.
    // The installed script as it is now: with {sha256} in the approve command, that one or none is approved.
    const hash = installedHash(e, job);
    const r = await runApprove(ctx, e, job, hash);
    if (r.code === 0) {
      approved.push(job);
      // The round's own look at the jobs (stages/jobs.ts) needn't approve it again.
      noteApproved(e, job, r.pinned ?? hash);
    } else failed.push(`${job} (exit ${r.code}: ${r.said})`);
  }
  const by = asking.map((p) => `#${p.number}`).join(', ');
  const parts = [
    ...(approved.length ? [`approved ${approved.join(', ')}, as merging ${by} counts as reading ${approved.length === 1 ? 'its script' : 'their scripts'}`] : []),
    ...(failed.length ? [`couldn't approve ${failed.join(', ')}`] : []),
    ...(unnamed.length ? [`${by} also changed ${unnamed.map((u) => `jobs/${u}.ps1`).join(', ')}, which ${unnamed.length === 1 ? "it doesn't" : "they don't"} name: not approved, yours to review`] : []),
  ];
  return result(e, failed.length ? 'failed' : 'done', parts.join('; '));
}

/**
 * After a merge with --yes: for each employee with PRs merged, the steps those PRs asked for, and a release when
 * Settings release after merging (`releaseKit`, the kit that release must carry). Each step is a line of the
 * stage's results ("release: …", "install: …", "approve-jobs: …").
 */
export async function afterMerge(ctx: Ctx, employees: Employee[], merged: { id: string; merged: PrInfo[] }[], o: { releaseKit: string | null }): Promise<EmployeeResult[]> {
  const out: EmployeeResult[] = [];
  for (const m of merged) {
    const e = employees.find((x) => x.id === m.id);
    if (!e || !m.merged.length) continue;
    const step = async (name: string, fn: () => Promise<EmployeeResult>): Promise<EmployeeResult> => {
      let r: EmployeeResult;
      try {
        r = await fn();
      } catch (err) {
        ctx.log(`[${e.id}] ${name}: ${(err as Error).message}`);
        r = result(e, 'failed', (err as Error).message);
      }
      out.push({ ...r, message: `${name}: ${r.message}` });
      return r;
    };
    const asking = (s: AfterStep) => m.merged.filter((p) => p.after?.steps.includes(s));
    const by = (prs: PrInfo[]) => prs.map((p) => `#${p.number}`).join(', ');
    let release: EmployeeResult | null = null;
    if (asking('release').length) {
      ctx.log(`[${e.id}] release, as ${by(asking('release'))} asks`);
      release = await step('release', () => releaseOne(ctx, e, { kit: null }));
    } else if (o.releaseKit) {
      await step('release', () => releaseOne(ctx, e, { kit: o.releaseKit! }));
    }
    let install: EmployeeResult | null = null;
    if (asking('install').length) {
      if (release && release.outcome !== 'done') out.push(result(e, 'skipped', `install: not without the release ${by(asking('install'))} asked for`));
      else {
        ctx.log(`[${e.id}] install, as ${by(asking('install'))} asks`);
        install = await step('install', () => installOne(ctx, e));
      }
    }
    if (asking('approve-jobs').length) {
      // The approval pins the installed script: only after the install those PRs asked for.
      if (install?.outcome !== 'done') out.push(result(e, 'skipped', `approve-jobs: not without the install ${by(asking('approve-jobs'))} asked for`));
      else await step('approve-jobs', () => approveJobs(ctx, e, m.merged));
    }
  }
  return out;
}
