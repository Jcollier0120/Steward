import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './app.ts';
import type { Field, SettingsSpec } from './kit/settings-kit.ts';
import { dataFile, readJson } from './kit/store.ts';
import { LOCAL_URL as LOCAL_ACTION } from './upkeep.ts';

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
   * Approves one of its jobs in the installed copy, {job} its name: when a merged PR names it (after: approve-jobs),
   * after that PR's install; and in each round, a job whose installed script is the one merged on its branch
   * (stages/jobs.ts). Merging counts as reading the script. %NAME% is expanded. Empty: never.
   */
  approve: string;
  /** Its installed copy (%USERPROFILE%\.<id>\app), laid out as its repository is: its jobs, and its release.json. Empty: none. */
  installed: string;
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
  /** What needs the person, after each round (alarms.ts). */
  alarms: AlarmSettings;
  /** The Steward's look at the Wright's drafts (review.ts). */
  wrightReview: WrightReviewSettings;
  /** In its rounds, a ready team PR that waits only on its branch moving is caught up with it (stages/catchup.ts). */
  catchUp: boolean;
  /** Local pages POSTed after a stage releases something (upkeep.ts): Manor's update check, the Aletaster's Run now. */
  afterRelease: string[];
  /** In its rounds, each employee behind the newest kit release is bumped and its PR pushed (stages/rollout.ts). */
  rollout: boolean;
  /** In its rounds, a kit version or a Steward version on the Steward's own main with no release is released (stages/self.ts). */
  releaseSelf: boolean;
  /** The Steward's own checkout, which those releases are made from (a worktree of it at origin/main). */
  stewardCheckout: string;
}

export interface WrightReviewSettings {
  /** In its rounds, a draft the Wright opened that passes the look is marked ready, then merged as any team PR. */
  on: boolean;
  /** Larger than this (lines added and removed), it stays a draft for the person. */
  maxLines: number;
  /** A changed file matching one of these keeps it a draft for the person (the Wright's own list, checked again). */
  sensitive: string[];
}

/** What a person reviews: the Wright's defaults (its Settings: For a person to review). */
export const DEFAULT_REVIEW_SENSITIVE = ['jobs/**', '**/*.ps1', '**/*install*', 'setup/**', '**/*release*', '.github/**', 'tools/**', 'kit.json', '**/*.csproj'];

export interface AlarmSettings {
  on: boolean;
  /** A Windows toast when one is raised. */
  toast: boolean;
  /** A PR held this long is an alarm. */
  waitingHours: number;
  /** A problem the Surveyor has reported this long is an alarm. */
  problemHours: number;
  /** Manor's page, read for updates it couldn't install; empty: not read. */
  manorUrl: string;
  /** The Surveyor's page, read for its problems; empty: not read. */
  surveyorUrl: string;
  /** The Wright's page, read for the issues it got stuck on and its PRs a person reviews; empty: not read. */
  wrightUrl: string;
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
  installed: `%USERPROFILE%\\.${name.toLowerCase()}\\app`,
});

/**
 * The Wright is ours alone (Manor marks it internal): it isn't among the employees anyone else's Steward has. Where
 * it is installed (%USERPROFILE%\.wright\app, or WRIGHT_HOME's app), and Settings name no employees of their own,
 * the Steward takes it on, and reads its page for alarms.
 */
export const wrightInstalled = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(env.WRIGHT_HOME ?? path.join(os.homedir(), '.wright'), 'app'));
export const WRIGHT_URL = 'http://127.0.0.1:19797';

/**
 * The eight hires, then Reeve and Heiward (the README's "Reeve and Heiward"), then the Surveyor and the Lamplighter, built on
 * the kit from the start as a hire is (they never carried a copy, so they aren't among the old kit's hires). Reeve takes the node and spec parts and
 * fills them with tools/kit.ts, as a hire does. Heiward, in C# on its master branch, takes the spec part and fills
 * kit\ with a PowerShell script of its own; its version is a .csproj's, and it has no npm and no tools/kit.ts.
 */
export const DEFAULT_EMPLOYEES: Employee[] = [
  ...['Porter', 'Auditor', 'Clerk', 'Herald', 'Warrener', 'Aletaster', 'Miller', 'Pinder'].map(hire),
  {
    ...hire('Reeve'),
    parts: ['node', 'spec'],
    versionFiles: ['package.json', 'package-lock.json', 'src/mcp.ts'],
    // Reeve's jobs run only while their script's sha256 is the approved one: `reeve jobs approve <name>`, and with
    // --sha256 (Reeve 0.4.3 and later) only the script the Steward checked, or none.
    approve: 'node %USERPROFILE%\\.reeve\\app\\src\\cli.ts jobs approve {job} --sha256 {sha256}',
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
    installed: '',
  },
  hire('Surveyor'),
  hire('Lamplighter'),
];

/** The employees when Settings name none: the defaults, and the Wright where it is installed. */
export const defaultEmployees = (env: NodeJS.ProcessEnv = process.env): Employee[] => (wrightInstalled(env) ? [...DEFAULT_EMPLOYEES, hire('Wright')] : DEFAULT_EMPLOYEES);

/**
 * Told after a release: Manor's update check (so it installs the release within minutes, not at its next look hours
 * away), and the Aletaster's Run now (so it tastes it). Each is its page's own button, POSTed with its page's token.
 */
export const DEFAULT_AFTER_RELEASE = ['http://127.0.0.1:18585/api/updates/check', 'http://127.0.0.1:19191/api/run'];

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
  alarms: { on: true, toast: true, waitingHours: 24, problemHours: 6, manorUrl: 'http://127.0.0.1:18585', surveyorUrl: 'http://127.0.0.1:19595', wrightUrl: '' },
  wrightReview: { on: true, maxLines: 600, sensitive: DEFAULT_REVIEW_SENSITIVE },
  catchUp: true,
  afterRelease: DEFAULT_AFTER_RELEASE,
  rollout: true,
  releaseSelf: true,
  stewardCheckout: 'C:\\Projects\\Steward',
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
    blank: { id: '', name: '', repo: '', checkout: '', branch: 'main', usesKit: true, parts: ['node', 'web', 'spec'], fill: 'node tools/kit.ts', test: ['npx tsc -p . --noEmit', 'npm test'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: 'npm run release -- --publish', install: 'node src/cli.ts install', approve: '', installed: '' },
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
      { key: 'approve', kind: 'text', label: 'Approve a job', help: "Run with {job} a job's name, and {sha256} the hash of the script the Steward checked (so only that script is approved): for each job a merged PR names, after its install; and in each round, for a job whose installed script is exactly the one merged on its branch, so an update never leaves its jobs waiting. Merging counts as reading the script. %USERPROFILE% and the like are expanded.", empty: "Its jobs aren't approved by the Steward", pattern: '.*\\{job\\}.*', patternHint: 'a command with {job} in it', ...command },
      { key: 'installed', kind: 'text', label: 'Installed at', help: 'Its installed copy, laid out as its repository is (jobs\\jobs.json, release.json): where the rounds look for jobs to approve.', empty: 'Not looked at', maxLength: 260, path: { is: 'folder', missing: 'warn', env: true } },
    ],
  },
  {
    key: 'team',
    kind: 'list',
    label: 'Team',
    help: "The GitHub accounts whose PRs to the employees the Steward merges as well as its own, when asked: merge --team, or Merge the team's PRs. Claude Code opens its PRs with your account, so yours covers them. A team PR that isn't a draft is ready to merge: open one that needs review as a draft. One with no checks on GitHub is tested here first, and the version it sets must be new. Their branches are left as they are.",
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
    help: "On duty, a round every few minutes: every PR of the Steward's and the team's that is ready (not a draft, mergeable, no failing or running checks; a team PR with none tested here first, and with a new version if it sets one) is merged, with what it asks for after; then every employee whose branch carries a version with no release is released, and jobs whose installed scripts are the merged ones are approved (Reeve); and, as the two switches below say, a new kit is rolled out and its own new versions released. Off: only when asked.",
  },
  {
    key: 'catchUp',
    kind: 'switch',
    label: 'Catches PRs up with their branch',
    help: "In its rounds, a ready PR of the team's that waits only because its branch moved on is caught up: the branch merged into it (a conflict resolved only where it is in the version lines), the next free version given when its own is taken, and pushed, with a comment; the next round tests and merges it. One whose checks failed here is caught up when the branch moves on. Any other conflict waits for you.",
  },
  {
    key: 'rollout',
    kind: 'switch',
    label: 'Rolls out a new kit by itself',
    help: "In its rounds, each employee whose branch pins a kit older than the newest kit release is bumped (a worktree of its branch, the new pin and the next patch version, its checks run) and its PR pushed, a few at a time; later rounds merge and release it. Not one with a kit PR already open. A bump whose checks fail is an alarm, and isn't tried again for that kit until a new commit lands on its branch, or you press Bump or Push. It waits while this Steward carries a kit older than the newest release, since its tools/kit.ts is the one handed out. Off: Bump and Push only when asked.",
  },
  {
    key: 'releaseSelf',
    kind: 'switch',
    label: 'Releases its own new versions',
    help: "In its rounds, when the Steward's own main carries a kit version with no kit-v release, or a Steward version with no v release, it is released from a clean worktree of main, as a person would: npm run kit-release -- --publish, then npm run release -- --publish. Never a version already released; a release that fails is an alarm, and isn't tried again at that commit.",
  },
  {
    key: 'stewardCheckout',
    kind: 'text',
    label: "The Steward's checkout",
    help: 'Your clone of the Steward, which its own releases are made from: a worktree of it at origin/main, in the work folder. Your working tree is never touched.',
    maxLength: 260,
    path: { is: 'folder', missing: 'warn', missingNote: "Without it, the Steward's own versions are left to you.", env: true },
  },
  { key: 'roundMinutes', kind: 'whole', min: 2, max: 240, unit: 'minutes', label: 'A round every', help: 'How often it looks, while on duty. A round asks GitHub once about every employee, and looks again only at those with something new (and at all of them each hour).' },
  {
    key: 'afterRelease',
    kind: 'list',
    label: 'Told after a release',
    help: "Pages on this PC that hear when a stage or a round has released something: each address is POSTed as its page's own button would be. Manor's update check, so it installs the release within minutes rather than at its next look; the Aletaster's Run now, so it tastes it. One that doesn't answer is only logged.",
    item: { label: 'Address', maxLength: 200, pattern: 'http://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/[A-Za-z0-9/_.-]*', patternHint: 'a local address with its path, like http://127.0.0.1:18585/api/updates/check' },
    maxItems: 10,
  },
  {
    key: 'alarms',
    kind: 'group',
    label: 'Alarms',
    help: "After each round, what needs you: a PR that has waited, a release the rounds gave up on, an update Manor couldn't install, a problem the Surveyor has reported a while. Each is raised once, kept at the top of this page and in Manor until it clears.",
    fields: [
      { key: 'on', kind: 'switch', label: 'Raise alarms' },
      { key: 'toast', kind: 'switch', label: 'A Windows notification for each', help: 'Clicking it opens this page.' },
      { key: 'waitingHours', kind: 'whole', min: 1, max: 168, unit: 'hours', label: 'A PR waiting for', help: 'A draft no one marked ready, conflicts, failing checks, a version that clashes.' },
      { key: 'problemHours', kind: 'whole', min: 1, max: 168, unit: 'hours', label: "A Surveyor's problem lasting", help: 'Its warnings and notes never raise one.' },
      { key: 'manorUrl', kind: 'text', label: "Manor's page", help: "Read for updates it couldn't install.", empty: 'Not read', maxLength: 100, pattern: 'https?://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/?', patternHint: 'a local address, like http://127.0.0.1:18585' },
      { key: 'surveyorUrl', kind: 'text', label: "The Surveyor's page", help: 'Read for its problems.', empty: 'Not read', maxLength: 100, pattern: 'https?://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/?', patternHint: 'a local address, like http://127.0.0.1:19595' },
      { key: 'wrightUrl', kind: 'text', label: "The Wright's page", help: 'Read for the issues it got stuck on, and its PRs that change what a person reviews.', empty: 'Not read', maxLength: 100, pattern: 'https?://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/?', patternHint: 'a local address, like http://127.0.0.1:19797' },
    ],
  },
  {
    key: 'wrightReview',
    kind: 'group',
    label: "The Wright's drafts",
    help: "The Wright opens every pull request as a draft. In its rounds the Steward looks at each, in code: not labelled wright:needs-you, no changed file a person reviews, no dependency changes, not too large. One that passes is marked ready, then tested here and merged as any team PR; one that doesn't stays a draft for you, and says why.",
    fields: [
      { key: 'on', kind: 'switch', label: 'Look at the Wright\'s drafts, and merge the ones that pass' },
      { key: 'maxLines', kind: 'whole', min: 10, max: 5000, unit: 'lines', label: 'At most', help: 'Lines added and removed; a larger draft waits for you.' },
      { key: 'sensitive', kind: 'list', label: 'For a person to review', help: 'A draft changing a file that matches one of these waits for you. * is any part of a name, ** any folders.', item: { label: 'Path pattern', maxLength: 120 }, maxItems: 40 },
    ],
  },
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
    installed: typeof e.installed === 'string' ? e.installed.trim() : known.installed,
  };
}

const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|[a-z0-9-]+\.localhost)(:\d+)?\/?$/;

function normalizeAlarms(raw: unknown): AlarmSettings {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS.alarms;
  const whole = (v: unknown, min: number, max: number, fallback: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
    return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const url = (v: unknown, fallback: string) => (typeof v === 'string' && (v.trim() === '' || LOCAL_URL.test(v.trim())) ? v.trim() : fallback);
  return {
    on: typeof a.on === 'boolean' ? a.on : d.on,
    toast: typeof a.toast === 'boolean' ? a.toast : d.toast,
    waitingHours: whole(a.waitingHours, 1, 168, d.waitingHours),
    problemHours: whole(a.problemHours, 1, 168, d.problemHours),
    manorUrl: url(a.manorUrl, d.manorUrl),
    surveyorUrl: url(a.surveyorUrl, d.surveyorUrl),
    // Not named in settings.json: the Wright's page where it is installed, else none (it is ours alone).
    wrightUrl: a.wrightUrl === undefined ? (wrightInstalled() ? WRIGHT_URL : '') : url(a.wrightUrl, d.wrightUrl),
  };
}

function normalizeReview(raw: unknown): WrightReviewSettings {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS.wrightReview;
  const n = typeof a.maxLines === 'number' ? a.maxLines : typeof a.maxLines === 'string' && a.maxLines.trim() ? Number(a.maxLines) : Number.NaN;
  return {
    on: typeof a.on === 'boolean' ? a.on : d.on,
    maxLines: Number.isInteger(n) ? Math.min(5000, Math.max(10, n)) : d.maxLines,
    sensitive: strings(a.sensitive, d.sensitive),
  };
}

/** settings.json over the defaults, each value checked: a bad one falls back to its default. */
export function normalizeSettings(raw: unknown): { settings: Settings; problems: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const problems: string[] = [];
  let employees = defaultEmployees();
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
      alarms: normalizeAlarms(r.alarms),
      wrightReview: normalizeReview(r.wrightReview),
      catchUp: typeof r.catchUp === 'boolean' ? r.catchUp : d.catchUp,
      afterRelease: Array.isArray(r.afterRelease) ? strings(r.afterRelease, []).filter((u) => LOCAL_ACTION.test(u)) : d.afterRelease,
      rollout: typeof r.rollout === 'boolean' ? r.rollout : d.rollout,
      releaseSelf: typeof r.releaseSelf === 'boolean' ? r.releaseSelf : d.releaseSelf,
      stewardCheckout: str(r.stewardCheckout, d.stewardCheckout),
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
