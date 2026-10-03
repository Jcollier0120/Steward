import path from 'node:path';
import { dataDir } from './app.ts';
import type { Field, SettingsSpec } from './kit/settings-kit.ts';
import { dataFile, readJson } from './kit/store.ts';

/** The kit's parts an employee can take (node brings core, core brings spec, dotnet brings core: tools/kit.ts adds them). */
export const PART_NAMES = ['node', 'web', 'spec', 'core', 'dotnet'];

/**
 * One of Manor's employees, as the Steward deals with it: where its code is, which kit parts it takes,
 * and the commands that fill its kit, test it and release it. Commands run in the employee's folder;
 * `npm` and `npx` run with the Node that runs the Steward.
 */
export interface Employee {
  id: string;
  name: string;
  /** owner/name on GitHub. */
  repo: string;
  /** The person's own clone. The Steward only adds and removes worktrees of it, and fetches. */
  checkout: string;
  /** The branch releases come from, and PRs go to. */
  branch: string;
  /** Whether it takes the Steward's kit yet. The stages pass over one that doesn't, and say so. */
  usesKit: boolean;
  parts: string[];
  /** Fills its kit at the version kit.json pins. */
  fill: string;
  /** Its checks, in order; every one must pass. */
  test: string[];
  /** The files that carry its version, all bumped together (package.json, package-lock.json, a .ts, a .csproj). */
  versionFiles: string[];
  /** Publishes the GitHub release of the version on its branch. */
  release: string;
  /** Installs it on this PC, run in its release unpacked, when a merged PR asks (after: install). Empty: never. */
  install: string;
  /**
   * Approves one of its jobs in the installed copy, {job} its name, when a merged PR names it (after: approve-jobs),
   * after that PR's install: merging the PR counts as reading the script. %NAME% is expanded. Empty: never.
   */
  approve: string;
}

export interface Settings {
  employees: Employee[];
  /** The GitHub accounts whose PRs to the employees `merge --team` merges, as well as the Steward's own. */
  team: string[];
  workRoot: string;
  releaseAfterMerge: boolean;
  stewardRepo: string;
  parallel: number;
  /** On duty, a round every `roundMinutes`: merge what's ready (the Steward's and the team's), then release what isn't. */
  byItself: boolean;
  roundMinutes: number;
}

const hire = (name: string): Employee => ({
  id: name.toLowerCase(),
  name,
  repo: `Jcollier0120/${name}`,
  checkout: `C:\\Projects\\${name}`,
  branch: 'main',
  usesKit: true,
  parts: ['node', 'web', 'spec'],
  fill: 'node tools/kit.ts',
  test: ['npx tsc -p . --noEmit', 'npm test'],
  versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'],
  release: 'npm run release -- --publish',
  install: 'node src/cli.ts install',
  approve: '',
});

/**
 * The eight hires, then Reeve and Heiward (the README's "Reeve and Heiward"), then the Surveyor, built on the kit from the
 * start as a hire is (it never carried a copy, so it isn't one of the old kit's hires). Reeve takes the node and spec parts and
 * fills them with tools/kit.ts, as a hire does. Heiward, in C# on its master branch, takes the spec part and fills
 * kit\ with a PowerShell script of its own; its version is a .csproj's, and it has no npm and no tools/kit.ts.
 */
export const DEFAULT_EMPLOYEES: Employee[] = [
  ...['Porter', 'Auditor', 'Clerk', 'Herald', 'Warrener', 'Aletaster', 'Miller', 'Pinder'].map(hire),
  {
    ...hire('Reeve'),
    parts: ['node', 'spec'],
    versionFiles: ['package.json', 'package-lock.json', 'src/mcp.ts'],
    // Reeve's jobs run only while their script's sha256 is the approved one: `reeve jobs approve <name>`.
    approve: 'node %USERPROFILE%\\.reeve\\app\\src\\cli.ts jobs approve {job}',
  },
  {
    id: 'heiward',
    name: 'Heiward',
    repo: 'Jcollier0120/Heiward',
    checkout: 'C:\\Projects\\Heiward',
    branch: 'master',
    usesKit: true,
    parts: ['spec'],
    fill: 'powershell -NoProfile -File tools\\kit.ps1',
    test: ['dotnet test HEI.Core.Tests'],
    versionFiles: ['HEI.Agent/HEI.Agent.csproj'],
    release: 'powershell -NoProfile -File HEI.Agent\\release.ps1 -Publish',
    // Heiward installs as a Windows app (Settings > Apps), not from a zip with src\cli.ts: the Steward doesn't install it.
    install: '',
    approve: '',
  },
  hire('Surveyor'),
];

/** The team: you, and Claude Code, which opens its PRs with your account. */
export const DEFAULT_TEAM = ['Jcollier0120'];

export const DEFAULT_SETTINGS: Settings = {
  employees: DEFAULT_EMPLOYEES,
  team: DEFAULT_TEAM,
  workRoot: path.join(dataDir, 'work'),
  releaseAfterMerge: false,
  stewardRepo: 'Jcollier0120/Steward',
  parallel: 2,
  byItself: true,
  roundMinutes: 10,
};

const REPO = { pattern: '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', patternHint: 'owner/name, like Jcollier0120/Porter' };
const command = { maxLength: 500 };

/** Each setting as the page's Settings panel shows it, and as the kit's settings-kit.ts checks it. */
export const SETTINGS_SCHEMA: Field[] = [
  {
    key: 'employees',
    kind: 'records',
    noun: 'employee',
    title: 'name',
    unique: 'id',
    label: 'Employees',
    help: 'Every agent the Steward looks after: where its code is, which kit parts it takes, and how to fill its kit, test it, bump its version and release it.',
    maxItems: 50,
    blank: { id: '', name: '', repo: '', checkout: '', branch: 'main', usesKit: true, parts: ['node', 'web', 'spec'], fill: 'node tools/kit.ts', test: ['npx tsc -p . --noEmit', 'npm test'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: 'npm run release -- --publish', install: 'node src/cli.ts install', approve: '' },
    fields: [
      { key: 'id', kind: 'text', label: 'Id', maxLength: 40, pattern: '[a-z][a-z0-9-]*', patternHint: 'lowercase letters, digits and dashes, like porter' },
      { key: 'name', kind: 'text', label: 'Name', maxLength: 60 },
      { key: 'repo', kind: 'text', label: 'GitHub repository', maxLength: 140, ...REPO },
      { key: 'checkout', kind: 'text', label: 'Checkout', help: 'Your clone. The Steward adds worktrees of it in the work folder and fetches; it never changes your working tree.', maxLength: 260, path: { is: 'folder', missing: 'warn', env: true } },
      { key: 'branch', kind: 'text', label: 'Branch', help: 'Where releases come from and PRs go.', maxLength: 100, pattern: '[A-Za-z0-9._/-]+', patternHint: 'a branch name, like main' },
      { key: 'usesKit', kind: 'switch', label: "Takes the Steward's kit", help: "Off: listed, but the stages pass over it (\"not using the kit yet\"), except merging the team's PRs." },
      { key: 'parts', kind: 'choices', label: 'Kit parts', options: PART_NAMES.map((p) => ({ value: p, label: p })) },
      { key: 'fill', kind: 'text', label: 'Fill its kit', help: 'The command that fills its kit at the version kit.json pins.', ...command },
      { key: 'test', kind: 'list', label: 'Test it', help: 'Each command must pass before a bump is committed.', item: { label: 'Command', ...command }, maxItems: 10, matchCase: true },
      { key: 'versionFiles', kind: 'list', label: 'Version files', help: 'Bumped together: package.json, package-lock.json, a .ts with version: \'x.y.z\', a .csproj with <VersionPrefix>.', item: { label: 'File', maxLength: 200 }, minItems: 1, maxItems: 10 },
      { key: 'release', kind: 'text', label: 'Release it', help: "The command that publishes the GitHub release of its branch's version.", ...command },
      { key: 'install', kind: 'text', label: 'Install it', help: 'Run in its newest release, downloaded, checked and unpacked, when a merged PR asks for install.', empty: "Not installed by the Steward", ...command },
      { key: 'approve', kind: 'text', label: 'Approve a job', help: 'Run for each job a merged PR names, {job} its name, after that PR\'s install: merging the PR counts as reading the script. %USERPROFILE% and the like are expanded.', empty: "Its jobs aren't approved by the Steward", pattern: '.*\\{job\\}.*', patternHint: 'a command with {job} in it', ...command },
    ],
  },
  {
    key: 'team',
    kind: 'list',
    label: 'Team',
    help: "The GitHub accounts whose PRs to the employees the Steward merges as well as its own, when asked: merge --team, or Merge the team's PRs. Claude Code opens its PRs with your account, so yours covers them. Their branches are left as they are.",
    item: { label: 'GitHub account', maxLength: 60, pattern: '(app/)?[A-Za-z0-9][A-Za-z0-9-]*', patternHint: 'a GitHub account, like Jcollier0120, or app/<name> for a GitHub App' },
    maxItems: 20,
  },
  {
    key: 'workRoot',
    kind: 'text',
    label: 'Work folder',
    help: 'Where the Steward makes its worktrees, one folder per employee.',
    maxLength: 260,
    path: { is: 'folder', missing: 'warn', missingNote: 'The Steward makes it.', env: true },
  },
  { key: 'releaseAfterMerge', kind: 'switch', label: 'Release right after merging', help: 'Off: Release is a stage of its own.' },
  { key: 'stewardRepo', kind: 'text', label: "The Steward's repository", help: 'Where the kit releases (kit-v<version>) are.', maxLength: 140, ...REPO },
  { key: 'parallel', kind: 'whole', min: 1, max: 10, unit: 'employees', label: 'Checked at once', help: 'How many employees a bump tests at the same time.' },
  {
    key: 'byItself',
    kind: 'switch',
    label: 'Merges and releases by itself',
    help: "On duty, a round every few minutes: every PR of the Steward's and the team's that is ready (not a draft, mergeable, no failing or running checks) is merged, with what it asks for after; then every employee whose branch carries a version with no release is released. Off: only when asked.",
  },
  { key: 'roundMinutes', kind: 'whole', min: 2, max: 240, unit: 'minutes', label: 'A round every', help: 'How often it looks, while on duty.' },
];

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const strings = (v: unknown, fallback: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : fallback);

function normalizeEmployee(e: any): Employee | null {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(e.id)) return null;
  const known = DEFAULT_EMPLOYEES.find((d) => d.id === e.id) ?? hire(e.id.charAt(0).toUpperCase() + e.id.slice(1));
  return {
    id: e.id,
    name: str(e.name, known.name),
    repo: str(e.repo, known.repo),
    checkout: str(e.checkout, known.checkout),
    branch: str(e.branch, known.branch),
    usesKit: typeof e.usesKit === 'boolean' ? e.usesKit : known.usesKit,
    parts: Array.isArray(e.parts) ? PART_NAMES.filter((p) => e.parts.includes(p)) : known.parts,
    fill: typeof e.fill === 'string' ? e.fill.trim() : known.fill,
    test: strings(e.test, known.test),
    versionFiles: strings(e.versionFiles, known.versionFiles),
    release: typeof e.release === 'string' ? e.release.trim() : known.release,
    install: typeof e.install === 'string' ? e.install.trim() : known.install,
    approve: typeof e.approve === 'string' ? e.approve.trim() : known.approve,
  };
}

/** settings.json over the defaults, each value checked: a bad one falls back to its default. */
export function normalizeSettings(raw: unknown): { settings: Settings; problems: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const problems: string[] = [];
  let employees = d.employees;
  if (Array.isArray(r.employees)) {
    employees = r.employees.map(normalizeEmployee).filter((e): e is Employee => e !== null);
    if (employees.length < r.employees.length) problems.push(`${r.employees.length - employees.length} employee(s) without a usable id were left out.`);
  }
  const parallel = Number(r.parallel);
  const roundMinutes = Number(r.roundMinutes);
  return {
    settings: {
      employees,
      team: strings(r.team, d.team),
      workRoot: str(r.workRoot, d.workRoot),
      releaseAfterMerge: typeof r.releaseAfterMerge === 'boolean' ? r.releaseAfterMerge : d.releaseAfterMerge,
      stewardRepo: str(r.stewardRepo, d.stewardRepo),
      parallel: Number.isInteger(parallel) ? Math.min(10, Math.max(1, parallel)) : d.parallel,
      byItself: typeof r.byItself === 'boolean' ? r.byItself : d.byItself,
      roundMinutes: Number.isInteger(roundMinutes) ? Math.min(240, Math.max(2, roundMinutes)) : d.roundMinutes,
    },
    problems,
  };
}

export const settingsFile = () => dataFile('settings.json');

/** The Steward's settings, for the kit's Settings panel and its API. */
export const SETTINGS_SPEC: SettingsSpec<Settings> = {
  schema: SETTINGS_SCHEMA,
  defaults: DEFAULT_SETTINGS,
  file: settingsFile,
  normalize: normalizeSettings,
  usedFrom: 'from the next stage on',
};

export function loadSettings(): Settings {
  return normalizeSettings(readJson<unknown>(settingsFile(), {})).settings;
}
