import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { publisherKey } from './kit/exchequer.ts';
import { manorHome, originRepo } from './kit/manor.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { RELEASE_HERE, type Employee } from './settings.ts';

/**
 * The Steward used to come with a list of employees, a repository and a clone of its own built in. It no longer does:
 * they start empty, and Settings name yours. An install that ran on those defaults has no settings.json, or one without
 * `employees`, and would lose them on update. So the first time the settings are read without `employees`, while the
 * staff table (staff.json) the Steward kept from its last look lists employees whose clones are on this PC, those are
 * written to settings.json once: each row's repository, clone, branch and kit parts, and the rest read from its clone
 * at the tip of its branch (origin/<branch>, as the stages work from it, not whatever the clone has checked out): its
 * package.json scripts, its version files, its kit script. What can't be read is said, and raised as an alarm
 * (migratedCondition); an employee missing a test or release command is left off the kit's stages (usesKit off). Until
 * Settings are saved, the Steward looks again every few minutes (fillMigrationGaps) and writes in what it now finds,
 * so a gap that was only the clone being on an old branch closes by itself. The Steward's own repository and clone are
 * found the same way, when settings.json names neither: a clone beside the employees' whose package.json is the
 * Steward's, and its origin.
 */

/** A staff table row, as much as the migration reads of it. */
export interface StaffRowLike {
  id?: unknown;
  name?: unknown;
  repo?: unknown;
  branch?: unknown;
  usesKit?: unknown;
  parts?: unknown;
  checkout?: { path?: unknown } | null;
}

/** What the migration did: kept in settings-migrated.json for its alarm. */
export interface Migration {
  at: string;
  /** settings.json's mtime right after the migration (or a later fill) wrote it: a later save of Settings clears the alarm. */
  mtimeMs: number;
  employees: string[];
  notes: string[];
  /** Each employee's gaps (Settings' labels), and whether they took it off the kit's stages. */
  gaps?: Record<string, { name: string; missing: string[]; offKit: boolean }>;
  /** When the clones were last looked at for the gaps. */
  checkedAt?: string;
}

/** Each gap: Settings' label, the employee's field, and what was looked for. */
const GAPS: Record<string, { field: 'fill' | 'test' | 'versionFiles' | 'release'; looked: string }> = {
  'Fill its kit': { field: 'fill', looked: 'tools/kit.ts or tools/kit.ps1' },
  'Test it': { field: 'test', looked: 'an npm test script or a .NET test project' },
  'Version files': { field: 'versionFiles', looked: "a package.json or a .csproj with <VersionPrefix>" },
  'Release it': { field: 'release', looked: 'a release script or release.ps1' },
};

/** A gap's note: what wasn't found, where, and what happens next. */
const gapNote = (name: string, branch: string, missing: string[], offKit: boolean) =>
  `${name}: couldn't tell ${missing.map((m) => `${m} (no ${GAPS[m]?.looked ?? '?'})`).join(', ')} from its clone's ${branch}${offKit ? ", so it is off the kit's stages" : ''}. The Steward looks again every few minutes and fills ${missing.length > 1 ? 'them' : 'it'} in once ${missing.length > 1 ? "they're" : "it's"} there.`;

/** How often the clones are looked at again for the gaps. */
const RECHECK_MS = 5 * 60_000;

/** A clone's files, read at a commit or from its folder. */
export interface Tree {
  has(rel: string): boolean;
  read(rel: string): string | null;
  /** The names in a folder (files and folders), or [] when there's none. */
  list(rel: string): string[];
  isDir(rel: string): boolean;
}

/** The files in a folder on disk. */
export function folderTree(root: string): Tree {
  const at = (rel: string) => path.join(root, rel);
  return { has: (rel) => existsSync(at(rel)), read: (rel) => readText(at(rel)), list: (rel) => list(at(rel)), isDir: (rel) => isDir(at(rel)) };
}

const gitOut = (cwd: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

/**
 * A clone's files at the tip of a branch: origin/<branch>, or the local branch when it has no origin copy. The clone
 * itself may be checked out on anything (an old branch without the kit script, say): the stages work from the branch.
 * Null when the folder isn't a git clone or has no such branch.
 */
export function branchTree(checkout: string, branch: string): Tree | null {
  // Its own clone (or worktree), not a folder inside someone else's.
  if (!existsSync(path.join(checkout, '.git'))) return null;
  const ref = [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`].find((r) => gitOut(checkout, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`])?.trim());
  if (!ref) return null;
  const files = (gitOut(checkout, ['ls-tree', '-r', '--name-only', ref]) ?? '').split('\n').filter(Boolean);
  if (!files.length) return null;
  const dirs = new Map<string, Set<string>>();
  const add = (dir: string, name: string) => (dirs.get(dir) ?? dirs.set(dir, new Set()).get(dir)!).add(name);
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length; i++) add(parts.slice(0, i).join('/'), parts[i]);
  }
  const fileSet = new Set(files);
  const norm = (rel: string) => rel.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  return {
    has: (rel) => fileSet.has(norm(rel)) || dirs.has(norm(rel)),
    read: (rel) => (fileSet.has(norm(rel)) ? (gitOut(checkout, ['show', `${ref}:${norm(rel)}`])?.replace(/^﻿/, '') ?? null) : null),
    list: (rel) => [...(dirs.get(norm(rel)) ?? [])],
    isDir: (rel) => dirs.has(norm(rel)),
  };
}

export const migrationFile = () => dataFile('settings-migrated.json');

const readText = (f: string) => {
  try {
    return readFileSync(f, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
};
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const list = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [] as string[];
  }
};

/**
 * Manor's internal staff ("internal": true): private agents, never offered or published. The Steward builds and
 * installs them from their clones here (RELEASE_HERE). This PC's own are in Manor's staff.local.json (Manor 0.6.4 and
 * later), which Manor never ships; an older Manor marked them in its own staff.json. None without Manor.
 */
export function internalStaff(home = manorHome()): Set<string> {
  const ids = new Set<string>();
  for (const file of [path.join(home, 'staff.local.json'), path.join(home, 'app', 'staff.json')]) {
    const agents = readJson<{ agents?: { id?: unknown; internal?: unknown }[] } | null>(file, null)?.agents;
    for (const a of Array.isArray(agents) ? agents : []) if (a && a.internal === true && typeof a.id === 'string') ids.add(a.id);
  }
  return ids;
}

/** A test project: one that takes a .NET test framework. */
const TEST_SDK = /Microsoft\.NET\.Test\.Sdk|"xunit|"NUnit|"MSTest/i;
/** Slow or needing a desktop: integration, GUI, headless, end-to-end and benchmark tests aren't a round's checks. */
const SLOW_TESTS = /^(integration|integrationtests|gui|ui|headless|headlesstests|e2e|benchmarks?|perf|performance|load|smoke)$/i;

/**
 * A .NET clone's checks: `dotnet test` on its unit tests, a folder down. With several test projects, the one for the
 * project the others build on most (App.Core.Tests for an App.Core that every other project references), its name
 * less ".Tests" naming the project it tests. Integration, GUI and benchmark tests are left out. None: [].
 */
export function dotnetTests(checkout: string | Tree): string[] {
  const t = typeof checkout === 'string' ? folderTree(checkout) : checkout;
  const projects = new Map<string, string>();
  for (const d of t.list('').filter((d) => t.isDir(d))) {
    const f = t.list(d).find((x) => x.endsWith('.csproj'));
    if (f) projects.set(d, t.read(`${d}/${f}`) ?? '');
  }
  const refsOf = (text: string) => [...text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map((m) => path.win32.basename(path.win32.dirname(m[1])));
  const usedBy = (dir: string) => [...projects.values()].filter((t) => refsOf(t).includes(dir)).length;
  const tests = [...projects].filter(([d, t]) => TEST_SDK.test(t) && !d.split('.').some((part) => SLOW_TESTS.test(part)));
  if (!tests.length) return [];
  const scored = tests.map(([d, t]) => {
    const subject = d.replace(/\.Tests?$/i, '');
    const refs = refsOf(t);
    return { d, score: refs.includes(subject) ? usedBy(subject) : Math.max(0, ...refs.map(usedBy)) };
  });
  scored.sort((a, b) => b.score - a.score || a.d.localeCompare(b.d));
  return [`dotnet test ${scored[0].d}`];
}

/** An employee rebuilt from its staff row and its clone, and what couldn't be filled in. An internal one is released here. */
export function employeeFromClone(row: StaffRowLike, internal = false): { employee: Employee; missing: string[] } | null {
  const id = typeof row.id === 'string' && /^[a-z][a-z0-9-]*$/.test(row.id) ? row.id : null;
  const checkout = typeof row.checkout?.path === 'string' ? row.checkout.path : '';
  if (!id || !checkout || !isDir(checkout)) return null;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
  const branch = typeof row.branch === 'string' && row.branch ? row.branch : 'main';
  // Its branch's tip, as the stages see it; a folder that isn't a clone (or has no such branch) as it is.
  const t = branchTree(checkout, branch) ?? folderTree(checkout);
  const has = (rel: string) => t.has(rel);
  const missing: string[] = [];
  let pkg: { version?: string; scripts?: Record<string, string> } | null = null;
  try {
    pkg = JSON.parse(t.read('package.json') ?? 'null');
  } catch {
    pkg = null;
  }
  const scripts = pkg?.scripts ?? {};

  const fill = has('tools/kit.ts') ? 'node tools/kit.ts' : has('tools/kit.ps1') ? 'powershell -NoProfile -File tools\\kit.ps1' : '';
  if (!fill) missing.push('Fill its kit');

  const test: string[] = [];
  if (pkg) {
    if (has('tsconfig.json')) test.push('npx tsc -p . --noEmit');
    if (scripts.test) test.push('npm test');
  }
  if (!pkg) test.push(...dotnetTests(t));
  if (!test.length) missing.push('Test it');

  const versionFiles: string[] = [];
  if (pkg) {
    versionFiles.push('package.json');
    if (has('package-lock.json')) versionFiles.push('package-lock.json');
    // The .ts that carries the version as version: 'x.y.z' (src/app.ts, or Reeve's src/mcp.ts).
    if (pkg.version) {
      const ts = t.list('src').filter((f) => f.endsWith('.ts')).sort((a, b) => (a === 'app.ts' ? -1 : b === 'app.ts' ? 1 : a.localeCompare(b)));
      const at = ts.find((f) => new RegExp(`version:\\s*'${pkg!.version!.replaceAll('.', '\\.')}'`).test(t.read(`src/${f}`) ?? ''));
      if (at) versionFiles.push(`src/${at}`);
    }
  } else {
    // A .NET employee: the .csproj that sets <VersionPrefix>, a folder down.
    for (const d of t.list('').filter((d) => t.isDir(d))) {
      for (const f of t.list(d).filter((f) => f.endsWith('.csproj'))) {
        if (/<VersionPrefix>/.test(t.read(`${d}/${f}`) ?? '')) versionFiles.push(`${d}/${f}`);
      }
    }
  }
  // Manor's one version is package.json's (its src/app.ts reads it there; its lockfile's needn't agree).
  if (id === 'manor' && versionFiles.includes('package.json')) versionFiles.splice(0, versionFiles.length, 'package.json');
  if (!versionFiles.length) missing.push('Version files');

  let release = '';
  if (scripts.release) release = internal ? RELEASE_HERE : 'npm run release -- --publish';
  else {
    const under = t.list('').find((d) => t.has(`${d}/release.ps1`));
    const ps = has('release.ps1') ? 'release.ps1' : under ? `${under}\\release.ps1` : '';
    if (ps) release = `powershell -NoProfile -File ${ps} -Publish`;
  }
  if (!release) missing.push('Release it');

  const node = has('src/cli.ts');
  const employee: Employee = {
    id,
    name,
    repo: typeof row.repo === 'string' ? row.repo : '',
    checkout,
    branch,
    // An install that ran on the old built-in employees merged their ready PRs by itself: it still does.
    merges: true,
    // Untested or unreleasable, it waits off the kit's stages until Settings say how.
    usesKit: row.usesKit !== false && !missing.includes('Test it') && !missing.includes('Release it'),
    parts: Array.isArray(row.parts) ? row.parts.filter((p): p is string => typeof p === 'string') : [],
    fill,
    test,
    versionFiles,
    release,
    // Released here, it's installed by its release; else its newest release is downloaded and installed.
    // Manor installs its own releases (Update automatically), told at once by afterRelease's update check.
    install: node && id !== 'manor' && !(internal && scripts.release) ? 'node src/cli.ts install' : '',
    approve: node && has('jobs/jobs.json') ? `node %USERPROFILE%\\.${id}\\app\\src\\cli.ts jobs approve {job} --sha256 {sha256}` : '',
    installed: node ? `%USERPROFILE%\\.${id}\\app` : '',
  };
  return { employee, missing };
}

/** Whether a folder is a clone (or worktree) of the Steward: its package.json is named steward, and it has the kit. */
export function isStewardClone(dir: string): boolean {
  try {
    return JSON.parse(readText(path.join(dir, 'package.json')) ?? 'null')?.name === 'steward' && existsSync(path.join(dir, 'kit', 'VERSION'));
  } catch {
    return false;
  }
}

/** The Steward clone a folder is in (it, or a folder above it), or null. */
export function stewardCloneAt(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.git'))) return isStewardClone(d) ? d : null;
    if (path.dirname(d) === d) return null;
  }
}

/** The Steward's own clone beside the employees' (a folder whose package.json is named steward), and its origin. */
export function findStewardClone(checkouts: string[]): { checkout: string; repo: string } | null {
  for (const parent of [...new Set(checkouts.map((c) => path.dirname(c)))]) {
    for (const d of list(parent)) {
      const dir = path.join(parent, d);
      if (!isStewardClone(dir)) continue;
      const repo = originRepo(dir);
      if (repo) return { checkout: dir, repo };
    }
  }
  return null;
}

/**
 * The migration, once: when settings.json has no `employees` and the staff table lists employees whose clones are here.
 * Returns what it did, or null when there was nothing to do. Never throws: the settings are read either way.
 */
export function migrateSettings(o: { settingsFile: string; staffFile: string; now?: Date }): Migration | null {
  try {
    const raw = existsSync(o.settingsFile) ? JSON.parse(readText(o.settingsFile) ?? '{}') : {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'employees' in raw) return null;
    const rows = (readJson<{ rows?: StaffRowLike[] } | null>(o.staffFile, null)?.rows ?? []).filter((r) => r && typeof r === 'object');
    if (!rows.length) return null;
    const notes: string[] = [];
    const employees: Employee[] = [];
    const gaps: NonNullable<Migration['gaps']> = {};
    const internal = internalStaff();
    for (const row of rows) {
      const name = typeof row.name === 'string' ? row.name : String(row.id);
      const got = employeeFromClone(row, typeof row.id === 'string' && internal.has(row.id));
      if (!got) {
        notes.push(`${name} was left out: its clone isn't on this PC. Add it in Settings if you still want it looked after.`);
        continue;
      }
      employees.push(got.employee);
      if (got.missing.length) {
        const offKit = row.usesKit !== false && !got.employee.usesKit;
        gaps[got.employee.id] = { name: got.employee.name, missing: got.missing, offKit };
        notes.push(gapNote(got.employee.name, got.employee.branch, got.missing, offKit));
      }
    }
    if (!employees.length) return null;
    const out: Record<string, unknown> = { ...raw, employees };
    if (!('stewardCheckout' in raw) && !('stewardRepo' in raw)) {
      const self = findStewardClone(employees.map((e) => e.checkout));
      if (self) Object.assign(out, { stewardRepo: self.repo, stewardCheckout: self.checkout });
    }
    writeJson(o.settingsFile, out);
    const at = (o.now ?? new Date()).toISOString();
    const m: Migration = { at, mtimeMs: statSync(o.settingsFile).mtimeMs, employees: employees.map((e) => e.id), notes, gaps, checkedAt: at };
    writeJson(migrationFile(), m);
    return m;
  } catch {
    return null;
  }
}

/**
 * The migration's gaps, from a migration written before it kept them (Steward 0.11.7 to 0.11.9): each employee a note
 * names as "couldn't tell", with the fields Settings still have empty.
 */
function gapsOf(m: Migration, employees: Record<string, unknown>[]): NonNullable<Migration['gaps']> {
  if (m.gaps) return m.gaps;
  const gaps: NonNullable<Migration['gaps']> = {};
  for (const e of employees) {
    const id = String(e.id);
    const name = typeof e.name === 'string' ? e.name : id;
    const note = m.notes.find((n) => n.startsWith(`${name}: couldn't tell `));
    if (!note || !m.employees.includes(id)) continue;
    const missing = Object.entries(GAPS).filter(([, g]) => { const v = e[g.field]; return !v || (Array.isArray(v) && !v.length); }).map(([label]) => label);
    if (missing.length) gaps[id] = { name, missing, offKit: note.includes("off the kit's stages") };
  }
  return gaps;
}

/**
 * While Settings haven't been saved since the migration, its gaps are looked for again in each clone (at most every few
 * minutes): what's found now is written into settings.json, an employee it took off the kit's stages goes back on once
 * it has a test and a release command, and the alarm keeps only what's still missing (none: it clears). A clone that
 * was on an old branch when the migration read it, or a script added since, closes its gap by itself. Never throws.
 */
export function fillMigrationGaps(o: { settingsFile: string; now?: Date }): Migration | null {
  try {
    const m = pendingMigration(o.settingsFile);
    if (!m) return null;
    const now = o.now ?? new Date();
    if (m.checkedAt && now.getTime() - Date.parse(m.checkedAt) < RECHECK_MS) return null;
    const raw = JSON.parse(readText(o.settingsFile) ?? '{}');
    const employees: Record<string, unknown>[] = Array.isArray(raw?.employees) ? raw.employees : [];
    const gaps = gapsOf(m, employees);
    const before = JSON.stringify(gaps);
    const internal = internalStaff();
    let changed = false;
    for (const [id, gap] of Object.entries(gaps)) {
      const e = employees.find((x) => x && x.id === id);
      if (!e) {
        delete gaps[id];
        continue;
      }
      const got = employeeFromClone({ ...e, checkout: { path: e.checkout } }, internal.has(id));
      if (!got) continue;
      for (const label of [...gap.missing]) {
        const field = GAPS[label]?.field;
        if (!field || got.missing.includes(label)) continue;
        e[field] = got.employee[field];
        gap.missing = gap.missing.filter((x) => x !== label);
        changed = true;
      }
      if (gap.offKit && !gap.missing.includes('Test it') && !gap.missing.includes('Release it') && e.usesKit === false) {
        e.usesKit = true;
        changed = true;
      }
      if (!gap.missing.length) delete gaps[id];
    }
    if (changed) writeJson(o.settingsFile, raw);
    const branchOf = (id: string) => String(employees.find((x) => x && x.id === id)?.branch ?? 'main');
    const leftOut = m.notes.filter((n) => !/^.+: couldn't tell /.test(n));
    const next: Migration = {
      ...m,
      mtimeMs: changed ? statSync(o.settingsFile).mtimeMs : m.mtimeMs,
      gaps,
      notes: [...leftOut, ...Object.entries(gaps).map(([id, g]) => gapNote(g.name, branchOf(id), g.missing, g.offKit))],
      checkedAt: now.toISOString(),
    };
    writeJson(migrationFile(), next);
    return changed || JSON.stringify(gaps) !== before ? next : null;
  } catch {
    return null;
  }
}

/**
 * Where Castellan's releases were published for every Manor before the releases repository was a setting (the kit's
 * release.ts named it until kit 2.32.0): an install from before keeps publishing there.
 */
export const CASTELLAN_RELEASES_REPO = 'Jcollier0120/Manor-releases';

/** Where the Steward looked for a .NET SDK before 0.14.0, after DOTNET_ROOT: an install from before that found one there keeps it. */
const LEGACY_DOTNET = 'C:\\tools\\dotnet10';

/** The files only a Steward that has run before leaves in its data folder. */
const RAN_BEFORE = ['settings.json', 'staff.json', 'alarms.json', 'last-stage.json', 'round.json', 'stages.log'];

/**
 * Once, the first time the settings are read without `releasesCastellan`. A Steward that ran before this version (its
 * data folder has its settings or what its rounds leave) worked as Castellan's own release machinery and merged by
 * itself: that is written into settings.json, so nothing changes for it (releasesCastellan on, the releases repository
 * it published to, byItself as it was, every repository's PRs merged as before, and the .NET SDK it found). A new
 * install starts with all of it off, waiting for the person's yes: `releasesCastellan: false` is written, so this never
 * runs again. Returns what it decided, or null when it was decided before. Never throws.
 *
 * Only where the Exchequer's publisher key is (the kit's exchequer.ts): that is the PC that releases Castellan. A Steward
 * that ran before on another PC ('elsewhere') is updated with all of it off, and its rounds wait for the person's yes
 * (byItself off), as a new install. On 2026-10-07 an old Steward on a second PC, signed in to the same GitHub account,
 * merged and released Castellan's repositories beside the owner's; updated, it would have become a second release machine.
 */
export function migrateToOwnRepos(o: { settingsFile: string; dataDir: string; dotnetHasSdk?: (dir: string) => boolean; hasPublisherKey?: () => boolean }): 'before' | 'elsewhere' | 'new' | null {
  try {
    const exists = existsSync(o.settingsFile);
    const raw = exists ? JSON.parse(readText(o.settingsFile) ?? '{}') : {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.releasesCastellan === 'boolean') return null;
    const ranBefore = exists || RAN_BEFORE.some((f) => existsSync(path.join(o.dataDir, f)));
    if (!ranBefore) {
      writeJson(o.settingsFile, { ...raw, releasesCastellan: false });
      return 'new';
    }
    if (!(o.hasPublisherKey ?? (() => 'key' in publisherKey()))()) {
      writeJson(o.settingsFile, { ...raw, releasesCastellan: false, byItself: false });
      return 'elsewhere';
    }
    const out: Record<string, unknown> = { ...raw, releasesCastellan: true };
    if (typeof raw.releasesRepo !== 'string') out.releasesRepo = CASTELLAN_RELEASES_REPO;
    // It merged and released by itself unless Settings said not: the default was on.
    if (typeof raw.byItself !== 'boolean') out.byItself = true;
    // Every repository's ready PRs were merged: each says so now.
    if (Array.isArray(raw.employees)) out.employees = raw.employees.map((e: unknown) => (e && typeof e === 'object' && !Array.isArray(e) && typeof (e as any).merges !== 'boolean' ? { ...(e as object), merges: true } : e));
    const sdk = o.dotnetHasSdk ?? ((dir: string) => existsSync(path.join(dir, 'dotnet.exe')) && list(path.join(dir, 'sdk')).length > 0);
    if (typeof raw.dotnetRoot !== 'string' && !process.env.DOTNET_ROOT && sdk(LEGACY_DOTNET)) out.dotnetRoot = LEGACY_DOTNET;
    // An earlier migration's alarm lasts until a person saves Settings (pendingMigration, by the file's time): this write isn't one.
    const pending = pendingMigration(o.settingsFile);
    writeJson(o.settingsFile, out);
    if (pending) writeJson(migrationFile(), { ...pending, mtimeMs: statSync(o.settingsFile).mtimeMs });
    return 'before';
  } catch {
    return null;
  }
}

/** The migration's notes, while Settings haven't been saved since it wrote them. */
export function pendingMigration(settingsFile: string): Migration | null {
  const m = readJson<Migration | null>(migrationFile(), null);
  if (!m?.notes?.length) return null;
  try {
    return statSync(settingsFile).mtimeMs > m.mtimeMs + 1 ? null : m;
  } catch {
    return null;
  }
}
