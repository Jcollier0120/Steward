import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { manorHome, originRepo } from './kit/manor.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { RELEASE_HERE, type Employee } from './settings.ts';

/**
 * The Steward used to come with a list of employees, a repository and a clone of its own built in. It no longer does:
 * they start empty, and Settings name yours. An install that ran on those defaults has no settings.json, or one without
 * `employees`, and would lose them on update. So the first time the settings are read without `employees`, while the
 * staff table (staff.json) the Steward kept from its last look lists employees whose clones are on this PC, those are
 * written to settings.json once: each row's repository, clone, branch and kit parts, and the rest read from its clone
 * (its package.json scripts, its version files, its kit script). What can't be read is said, and raised as an alarm
 * (migratedCondition) until Settings are saved; an employee missing a test or release command is left off the kit's
 * stages (usesKit off) until then. The Steward's own repository and clone are found the same way, when settings.json
 * names neither: a clone beside the employees' whose package.json is the Steward's, and its origin.
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
  /** settings.json's mtime right after the migration wrote it: a later save of Settings clears the alarm. */
  mtimeMs: number;
  employees: string[];
  notes: string[];
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
export function dotnetTests(checkout: string): string[] {
  const projects = new Map<string, string>();
  for (const d of list(checkout).filter((d) => isDir(path.join(checkout, d)))) {
    const f = list(path.join(checkout, d)).find((x) => x.endsWith('.csproj'));
    if (f) projects.set(d, readText(path.join(checkout, d, f)) ?? '');
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
  const has = (rel: string) => existsSync(path.join(checkout, rel));
  const missing: string[] = [];
  let pkg: { version?: string; scripts?: Record<string, string> } | null = null;
  try {
    pkg = JSON.parse(readText(path.join(checkout, 'package.json')) ?? 'null');
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
  if (!pkg) test.push(...dotnetTests(checkout));
  if (!test.length) missing.push('Test it');

  const versionFiles: string[] = [];
  if (pkg) {
    versionFiles.push('package.json');
    if (has('package-lock.json')) versionFiles.push('package-lock.json');
    // The .ts that carries the version as version: 'x.y.z' (src/app.ts, or Reeve's src/mcp.ts).
    if (pkg.version) {
      const ts = list(path.join(checkout, 'src')).filter((f) => f.endsWith('.ts')).sort((a, b) => (a === 'app.ts' ? -1 : b === 'app.ts' ? 1 : a.localeCompare(b)));
      const at = ts.find((f) => new RegExp(`version:\\s*'${pkg!.version!.replaceAll('.', '\\.')}'`).test(readText(path.join(checkout, 'src', f)) ?? ''));
      if (at) versionFiles.push(`src/${at}`);
    }
  } else {
    // A .NET employee: the .csproj that sets <VersionPrefix>, a folder down.
    for (const d of list(checkout).filter((d) => isDir(path.join(checkout, d)))) {
      for (const f of list(path.join(checkout, d)).filter((f) => f.endsWith('.csproj'))) {
        if (/<VersionPrefix>/.test(readText(path.join(checkout, d, f)) ?? '')) versionFiles.push(`${d}/${f}`);
      }
    }
  }
  // Manor's one version is package.json's (its src/app.ts reads it there; its lockfile's needn't agree).
  if (id === 'manor' && versionFiles.includes('package.json')) versionFiles.splice(0, versionFiles.length, 'package.json');
  if (!versionFiles.length) missing.push('Version files');

  let release = '';
  if (scripts.release) release = internal ? RELEASE_HERE : 'npm run release -- --publish';
  else {
    const ps = has('release.ps1') ? 'release.ps1' : list(checkout).map((d) => `${d}\\release.ps1`).find((f) => existsSync(path.join(checkout, f)));
    if (ps) release = `powershell -NoProfile -File ${ps} -Publish`;
  }
  if (!release) missing.push('Release it');

  const node = has('src/cli.ts');
  const employee: Employee = {
    id,
    name,
    repo: typeof row.repo === 'string' ? row.repo : '',
    checkout,
    branch: typeof row.branch === 'string' && row.branch ? row.branch : 'main',
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
    const internal = internalStaff();
    for (const row of rows) {
      const name = typeof row.name === 'string' ? row.name : String(row.id);
      const got = employeeFromClone(row, typeof row.id === 'string' && internal.has(row.id));
      if (!got) {
        notes.push(`${name} was left out: its clone isn't on this PC. Add it in Settings if you still want it looked after.`);
        continue;
      }
      employees.push(got.employee);
      if (got.missing.length) notes.push(`${name}: couldn't tell ${got.missing.join(', ')} from its clone${got.employee.usesKit ? '' : ', so it is off the kit\'s stages'} until you fill ${got.missing.length > 1 ? 'them' : 'it'} in.`);
    }
    if (!employees.length) return null;
    const out: Record<string, unknown> = { ...raw, employees };
    if (!('stewardCheckout' in raw) && !('stewardRepo' in raw)) {
      const self = findStewardClone(employees.map((e) => e.checkout));
      if (self) Object.assign(out, { stewardRepo: self.repo, stewardCheckout: self.checkout });
    }
    writeJson(o.settingsFile, out);
    const m: Migration = { at: (o.now ?? new Date()).toISOString(), mtimeMs: statSync(o.settingsFile).mtimeMs, employees: employees.map((e) => e.id), notes };
    writeJson(migrationFile(), m);
    return m;
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
