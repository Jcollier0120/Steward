import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AfterStep } from '../after.ts';
import { gh } from '../git.ts';
import { runLine, tail } from '../run.ts';
import type { Employee, Settings } from '../settings.ts';
import { result, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
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
  if (!e.install) return result(e, 'skipped', `Settings give ${e.name} no install command`);
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

/** The jobs a merged PR asks you to approve, and the command; with any job script it changed but didn't name. */
async function approveJobs(ctx: Ctx, e: Employee, prs: PrInfo[]): Promise<EmployeeResult> {
  const asking = prs.filter((p) => p.after?.steps.includes('approve-jobs'));
  const jobs = [...new Set(asking.flatMap((p) => p.after!.jobs))];
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
  const commands = jobs.map((j) => `${e.id} jobs approve ${j}`).join(', then ');
  const also = unnamed.length ? `; ${asking.map((p) => `#${p.number}`).join(', ')} also changed ${unnamed.map((u) => `jobs/${u}.ps1`).join(', ')}, which ${unnamed.length === 1 ? "it doesn't" : "they don't"} name` : '';
  return result(e, 'skipped', `yours to do, once you've read each script: ${commands}, in the installed copy${also}`);
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
    if (asking('install').length) {
      if (release && release.outcome !== 'done') out.push(result(e, 'skipped', `install: not without the release ${by(asking('install'))} asked for`));
      else {
        ctx.log(`[${e.id}] install, as ${by(asking('install'))} asks`);
        await step('install', () => installOne(ctx, e));
      }
    }
    if (asking('approve-jobs').length) await step('approve-jobs', () => approveJobs(ctx, e, m.merged));
  }
  return out;
}
