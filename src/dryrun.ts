import { existsSync } from 'node:fs';
import path from 'node:path';
import { readClone } from './found.ts';
import { originName, originOf } from './kit/manor.ts';
import { expandEnv } from './kit/settings-kit.ts';
import { dryRunLines, PIPELINE_FILE, readPipelineFile, resolvePipeline, withPipeline } from './repoconfig.ts';
import { hostOf, whyPlainGit, type ScmLook } from './scm.ts';
import { settingsPipelineFor, type Employee, type Settings } from './settings.ts';

/**
 * `steward build --dry-run <repo>`: what a build of one repository would do, step by step, by its pipeline
 * (repoconfig.ts), with nothing run, fetched or written. `which` is a repository the Steward looks after (its id, its
 * repository's name, or its clone's folder), or the folder of any clone on this PC, looked after or not: then it is read
 * as Look after would take it (its origin's name, its branch main), so a repository's .steward.json can be tried before
 * it is added. `currentBranch` reads a clone's branch (git, unless a test says). Pure but for reading the clone.
 */
export function dryRun(s: Settings, which: string, o: { look: ScmLook | null; cwd?: string; currentBranch?: (dir: string) => string | null }): { lines: string[]; code: number } {
  const want = which.trim();
  if (!want) return { lines: [`build --dry-run takes a repository: its id, its name (owner/name, host/path) or its clone's folder (they are ${s.employees.map((e) => e.id).join(', ') || 'none yet'})`], code: 2 };
  const key = (p: string) => path.resolve(expandEnv(p)).replace(/[\\/]+$/, '').toLowerCase();
  const asFolder = path.resolve(o.cwd ?? process.cwd(), want);
  const found = s.employees.find((e) => e.id === want.toLowerCase() || (!!e.repo && e.repo.toLowerCase() === want.toLowerCase()) || (!!e.checkout && key(e.checkout) === key(asFolder)));
  const e = found ?? adHoc(s, asFolder, o.currentBranch);
  if (!e) return { lines: [`no repository called ${want} here, and ${asFolder} is no clone (it has no .git): give an id (${s.employees.map((x) => x.id).join(', ') || 'none yet'}), a repository's name, or a clone's folder`], code: 1 };
  const lines = dryRunLines(e, hostOf(e, s, o.look));
  const why = whyPlainGit(e, s, o.look);
  if (why) lines.splice(1, 0, `why plain git: ${why}`);
  if (!found) lines.splice(1, 0, `not looked after yet: read from ${asFolder} as Look after would take it${existsSync(path.join(asFolder, PIPELINE_FILE)) ? '' : ` (it has no ${PIPELINE_FILE})`}`);
  return { lines, code: lines.some((l) => l.startsWith('held: ')) ? 1 : 0 };
}

/**
 * A clone the Steward doesn't look after, as an employee for a dry run: its origin's name, its branch, what its clone
 * says (its tests and version files, as Look after reads them: found.ts), its pipeline.
 */
function adHoc(s: Settings, dir: string, currentBranch?: (dir: string) => string | null): Employee | null {
  if (!existsSync(path.join(dir, '.git'))) return null;
  const origin = originOf(dir);
  const name = path.basename(dir);
  const repo = origin ? originName(origin) : `local/${name}`;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
  const branch = currentBranch?.(dir) || 'main';
  const read = readClone(dir, branch);
  const e: Employee = { id, name, repo, checkout: dir, branch, merges: false, usesKit: false, fill: '', test: read.test, versionFiles: read.versionFiles, release: '', install: '', approve: '', installed: '' };
  const given = settingsPipelineFor(s, e);
  const file = readPipelineFile(dir);
  return withPipeline(e, resolvePipeline(e, { settings: given.raw, settingsError: given.error, file: file.raw, fileError: file.error }));
}
