import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './app.ts';
import { developerPro } from './kit/developer-pro.ts';
import type { Field, SettingsSpec } from './kit/settings-kit.ts';
import { agentUrl, manorHome, manorLink, manorProjects, originRepo, type ManorProject } from './kit/manor.ts';
import { dataFile, readJson } from './kit/store.ts';
import { makersIds, makersOwn, makersPc } from './maker.ts';
import { takeOntoKit } from './employ.ts';
import { fillMigrationGaps, migrateSettings, migrateToOwnRepos } from './migrate.ts';
import { loadScm, sourceControlField, type SourceControl } from './scm.ts';
import { LOCAL_URL as LOCAL_ACTION } from './upkeep.ts';

/**
 * One of Manor's employees, as the Steward deals with it: where its code is, which kit parts it takes,
 * and the commands that fill its kit, test it and release it. Commands run in the employee's folder;
 * `npm` and `npx` run with the Node that runs the Steward.
 */
/**
 * An employee released only on this PC: its release command builds and installs it from its clone (--install), and
 * never publishes (no --publish or -Publish). Manor's internal staff are, so their releases never reach the public
 * releases repository; a staff table compares their version with the installed copy's, not a GitHub release.
 */
export const releasedHere = (e: Pick<Employee, 'release'>) => /(^|\s)--install\b/.test(e.release ?? '') && !/(^|\s)(--publish|-Publish)\b/.test(e.release ?? '');

/** The local build-and-install a private employee releases with (releasedHere). */
export const RELEASE_HERE = 'npm run release -- --install';

export interface Employee {
  id: string;
  name: string;
  /** owner/name on GitHub. */
  repo: string;
  /** The person's own clone. The Steward only adds and removes worktrees of it, and fetches. */
  checkout: string;
  /** The branch releases come from, and PRs go to. */
  branch: string;
  /**
   * Whether the rounds and Merge merge the team's ready PRs to it: off until the person says yes, repository by
   * repository. Off, its PRs are listed, and nothing more.
   */
  merges: boolean;
  /** Whether it takes the Steward's kit yet. The stages pass over one that doesn't, and say so. */
  usesKit: boolean;
  /** Fills its kit at the version kit.json pins. */
  fill: string;
  /** Its checks, in order; every one must pass. */
  test: string[];
  /** The files that carry its version, all bumped together (package.json, package-lock.json, a .ts, a .csproj). */
  versionFiles: string[];
  /**
   * Publishes the GitHub release of the version on its branch: a command run in a worktree of it, or `tag` (TAG_RELEASE),
   * a GitHub release of the branch's commit that the Steward makes itself. Empty: the Steward never releases it.
   */
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
  /**
   * Run after a stage that released something, anything (stages/refresh.ts): in a fresh worktree of its branch, and when
   * it changed tracked files, its tests run, then the change committed and pushed to its branch. A site's `npm run sync`,
   * which lists every product's release notes and downloads. Empty: nothing is run.
   */
  refresh?: string;
  /**
   * Worked with plain git (scm.ts), where there are no pull requests: run in its clone for each claimed branch that is
   * pushed and tested here, lowest version first, to hand it in (stages/gitevents.ts). {branch} {base} {commit}
   * {version} {title} {notesFile} {repo} {checkout}. Empty or none: claimed branches are left to you.
   */
  whenReady?: string;
  /** Worked with plain git: run in its clone once a release's tag is pushed. {tag} {version} {commit} {notesFile} {base} {repo} {checkout}. Empty or none: nothing. */
  whenReleased?: string;
  /** A word on its row of the page: why its PRs are left to you, say. Empty or none: none. */
  note?: string;
}

export interface Settings {
  employees: Employee[];
  /** The GitHub accounts whose PRs to the employees `merge --team` merges, as well as the Steward's own. Empty: gh's signed-in account (team.ts). */
  team: string[];
  workRoot: string;
  releaseAfterMerge: boolean;
  stewardRepo: string;
  parallel: number;
  /** How many stages run at the same time (stages/slots.ts), each on its own repositories; 1: one at a time. */
  stagesAtOnce: number;
  /** A vouch and a PR tested here run only the tests its change reaches (affected.ts); false: the whole suite. Absent: on. */
  affectedTests?: boolean;
  /** On duty, a round every `roundMinutes`: merge what's ready (the Steward's and the team's), then release what isn't. */
  byItself: boolean;
  roundMinutes: number;
  /** A ready PR merges only once it was opened at least this many minutes ago, so a small fix can still be pushed to it (merge.ts' ageHold). 0: at once. Absent: none. */
  mergeMinAgeMinutes?: number;
  /** What needs the person, after each round (alarms.ts). */
  alarms: AlarmSettings;
  /** The Steward's look at the Wright's drafts (review.ts). */
  wrightReview: WrightReviewSettings;
  /** In its rounds, a ready team PR that waits only on its branch moving is caught up with it (stages/catchup.ts). */
  catchUp: boolean;
  /** In its rounds, a repository's ready PRs in the version queue are stacked, tested once and merged together (stages/train.ts). */
  mergeTrain: boolean;
  /** Local pages POSTed after a stage releases something (upkeep.ts): Manor's update check, the Aletaster's Run now. */
  afterRelease: string[];
  /** In its rounds, each employee behind the newest kit release is bumped and its PR pushed (stages/rollout.ts). */
  rollout: boolean;
  /** In its rounds, a kit version or a Steward version on the Steward's own main with no release is released (stages/self.ts). */
  releaseSelf: boolean;
  /** In its rounds, the team's PRs to the Steward's own repository are merged as an employee's are: tested here first. */
  mergeSelf: boolean;
  /** The Steward's own checkout, which those releases are made from (a worktree of it at origin/main). */
  stewardCheckout: string;
  /** Before it publishes an employee's release, a passing tasting from the Aletaster of that very commit (tasting.ts). */
  tasteBeforeRelease: boolean;
  /**
   * A failed bump or release, and a Reeve alert that is code work, filed as an issue in the Wright's queue, its alarm
   * held back while the Wright works on it (work.ts).
   */
  fileWork: boolean;
  /**
   * In its rounds, each agent Manor employs that is on duty but whose page doesn't answer is opened again through Manor
   * (tend.ts). With no repositories to look after here, this is the whole round.
   */
  tend: boolean;
  /**
   * This PC releases Castellan itself (its makers' PC): the kit's rollout, the Steward's own releases and PRs, and each
   * staff release published to the releases repository too. Off, as on every other PC, the Steward looks after the
   * person's own repositories and nothing of Castellan's (inEffect).
   */
  releasesCastellan: boolean;
  /**
   * Where Castellan's releases are published for every Manor, as well as in each agent's own repository (owner/name):
   * handed to the kit's release as MANOR_RELEASES_REPO. Used only while releasesCastellan is on; empty: each in its own.
   */
  releasesRepo: string;
  /** A .NET with an SDK, for a .NET repository's tests and release. Empty: DOTNET_ROOT's, else Program Files'. */
  dotnetRoot: string;
  /**
   * How the Steward works with the repositories (scm.ts): auto, chosen by itself from what is installed and where each
   * repository is; git, plain git on any host for every one; github, GitHub's for every one.
   */
  sourceControl: SourceControl;
  /** Whether the Wright is installed on this PC (wrightInstalled): read from the PC, never set. Its settings show only then. */
  wrightHere: boolean;
  /**
   * Whether this is the laptop Castellan is made on (maker.ts' makersPc, its firmware): read from the PC, never set.
   * Anywhere else releasesCastellan is off whatever settings.json says, and its switch isn't offered.
   */
  makersPc: boolean;
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
  /** A release the Aletaster's tasting has held this long is an alarm. */
  tastingHours: number;
}

/**
 * An employee of the usual shape, a Node agent on the kit, by its id and name: what a record in settings.json gets for
 * a field it leaves out. No repository or clone: those are yours, and Settings name them.
 */
export const blankEmployee = (id: string, name: string): Employee => ({
  id,
  name,
  repo: '',
  checkout: '',
  branch: 'main',
  merges: false,
  usesKit: true,
  fill: 'node tools/kit.ts',
  test: ['npx tsc -p . --noEmit', 'npm test'],
  versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'],
  release: 'npm run release -- --publish',
  install: 'node src/cli.ts install',
  approve: '',
  installed: `%USERPROFILE%\\.${id}\\app`,
});

/**
 * The Wright, where it is installed (%USERPROFILE%\.wright\app, or WRIGHT_HOME's app) and Developer Pro is here (the
 * kit's developerPro: the maker's laptop, for now): the Steward reads its page for alarms, and looks at its drafts. It
 * looks after the Wright's own code only when Settings name it as an employee, as any other.
 */
export const wrightInstalled = (env: NodeJS.ProcessEnv = process.env) => developerPro() && existsSync(path.join(env.WRIGHT_HOME ?? path.join(os.homedir(), '.wright'), 'app'));

/** Reeve is installed here when his home (%USERPROFILE%\.reeve, or REEVE_HOME) has an app folder: only then are his alerts read. */
export const reeveInstalled = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(env.REEVE_HOME ?? path.join(os.homedir(), '.reeve'), 'app'));
export const REEVE_URL = 'http://127.0.0.1:18383';

/**
 * The Bailiff is ours alone too (Manor marks it internal), and reviews the Wright's drafts. Where it is installed
 * (%USERPROFILE%\.bailiff\app, or BAILIFF_HOME's app) the Steward takes it on as it does the Wright, reads its page for
 * alarms, and marks a draft of the Wright's ready only once the Bailiff has approved its head commit (review.ts). Where
 * it isn't, or Developer Pro isn't here, the Wright's drafts wait for a person: the manor takes on no new work without both.
 */
export const bailiffInstalled = (env: NodeJS.ProcessEnv = process.env) => developerPro() && existsSync(path.join(env.BAILIFF_HOME ?? path.join(os.homedir(), '.bailiff'), 'app'));

/** The other pages the Steward reads; empty: not read. */
export interface AgentPages {
  /** Manor's: updates it couldn't install, the manor-wide alarms, and the staff's pages to keep up. */
  manor: string;
  /** The Surveyor's problems. */
  surveyor: string;
  /** The issues the Wright got stuck on, and its PRs a person reviews: only where the Wright is installed. */
  wright: string;
  /** The reviews the Bailiff can't do: only where the Bailiff is installed. */
  bailiff: string;
  /** Reeve's jobs' open alerts, and the repositories he finds. */
  reeve: string;
}

/**
 * Each page as Manor says it (the kit's manorLink and agentUrl), read afresh: never from settings.json, where an
 * address saved by an older Steward is ignored. An agent Manor doesn't know isn't read, as one that isn't installed.
 */
export function agentPages(): AgentPages {
  return {
    manor: manorLink()?.url ?? '',
    surveyor: agentUrl('surveyor') ?? '',
    wright: wrightInstalled() ? (agentUrl('wright') ?? '') : '',
    bailiff: bailiffInstalled() ? (agentUrl('bailiff') ?? '') : '',
    reeve: agentUrl('reeve') ?? '',
  };
}

/**
 * The Surveyor is installed here when its home (%USERPROFILE%\.surveyor, or SURVEYOR_HOME) has an app folder: only then is
 * its page read for problems, so a PC without it has no standing alarm that its page doesn't answer.
 */
export const surveyorInstalled = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(env.SURVEYOR_HOME ?? path.join(os.homedir(), '.surveyor'), 'app'));

/** A release the Steward makes itself: a GitHub release v<version> of the branch's commit, its notes the CHANGELOG.md entry. */
export const TAG_RELEASE = 'tag';

/**
 * None: the Steward looks after the repositories you give it, each an employee in Settings (its GitHub repository, your
 * clone of it, and how to test and release it). Nobody's list is built in. An install that ran on the defaults, before
 * this, has its staff table's employees written to settings.json once instead (migrate.ts).
 */
export const DEFAULT_EMPLOYEES: Employee[] = [];

/**
 * Told after a release: Manor's update check (so it installs the release within minutes, not at its next look hours
 * away), and the Aletaster's Run now (so it tastes it). Each is its page's own button, POSTed with its page's token.
 */
export const DEFAULT_AFTER_RELEASE = ['http://127.0.0.1:18585/api/updates/check', 'http://127.0.0.1:19191/api/run'];

/**
 * The team: none named, which means the GitHub account gh is signed in as on this PC (team.ts): you, and Claude Code,
 * which opens its PRs with your account. Settings that name accounts are used as they are.
 */
export const DEFAULT_TEAM: string[] = [];

export const DEFAULT_SETTINGS: Settings = {
  employees: DEFAULT_EMPLOYEES,
  team: DEFAULT_TEAM,
  workRoot: path.join(dataDir, 'work'),
  releaseAfterMerge: false,
  stewardRepo: '',
  parallel: 2,
  stagesAtOnce: 2,
  affectedTests: true,
  // It merges and releases by itself only once the person says yes: here, and for each repository (Employee.merges).
  byItself: false,
  roundMinutes: 10,
  mergeMinAgeMinutes: 10,
  alarms: { on: true, toast: true, waitingHours: 24, problemHours: 6, tastingHours: 6 },
  wrightReview: { on: true, maxLines: 600, sensitive: DEFAULT_REVIEW_SENSITIVE },
  catchUp: true,
  mergeTrain: true,
  tasteBeforeRelease: true,
  afterRelease: DEFAULT_AFTER_RELEASE,
  rollout: true,
  releaseSelf: true,
  mergeSelf: true,
  stewardCheckout: '',
  fileWork: true,
  tend: true,
  releasesCastellan: false,
  releasesRepo: '',
  dotnetRoot: '',
  sourceControl: 'auto',
  wrightHere: wrightInstalled(),
  // Read from the PC when asked (as normalizeSettings does), so the defaults read as themselves.
  get makersPc() {
    return makersPc();
  },
};

/** Shown only on the PC that releases Castellan itself (releasesCastellan): the kit, the Steward's own releases, Manor's staff. */
const CASTELLAN = { shownWhen: { key: 'releasesCastellan', is: ['true'] } };
/** Shown only on the laptop Castellan is made on (makersPc): the switch that makes it Castellan's release machinery. */
const MAKERS = { shownWhen: { key: 'makersPc', is: ['true'] } };
/** Shown only where the Wright is installed (wrightHere): its drafts, and the work handed to it. */
const WRIGHT = { shownWhen: { key: 'wrightHere', is: ['true'] } };

const REPO ={ pattern: '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', patternHint: 'owner/name, like octocat/hello-world' };
const command = { maxLength: 500 };

/** Source control (scm.ts): its options are narrowed to what this PC has, and its help says what was found, as served. */
const SOURCE_CONTROL: Field = {
  key: 'sourceControl',
  kind: 'choice',
  label: 'Source control',
  help: "GitHub: pull requests merged, GitHub releases (the GitHub CLI, signed in). Git: any host with plain git, a release a v<version> tag, and each repository says what to do with a ready branch. Automatic: chosen for each repository from what this PC has.",
  options: [
    { value: 'auto', label: 'Automatic' },
    { value: 'github', label: 'GitHub, for every repository' },
    { value: 'git', label: 'Git, for every repository (any host)' },
  ],
};

/**
 * Each setting as the page's Settings panel shows it, and as the kit's settings-kit.ts checks it. In tabs, in this order:
 * Repositories (each one a line saying what it is and does, its Merges switch on that line, and what the Steward finds
 * by itself folded under Found by the Steward), Merging and releasing, General, Alarms, the Wright's drafts, and on the
 * PC that releases it, Castellan. Each one's help is a line: README.md says the rest.
 */
export const SETTINGS_SCHEMA: Field[] = [
  {
    key: 'employees',
    kind: 'records',
    noun: 'repository',
    title: 'name',
    unique: 'id',
    label: 'Repositories',
    tab: 'Repositories',
    help: "The repositories the Steward looks after. They arrive by Hire, or by Look after on the Steward's page, with all of it found from their clones: here you choose whether each merges your PRs and how it is released.",
    maxItems: 50,
    noAdd: true,
    line: ['repo', 'branch', 'note'],
    advancedLabel: 'More',
    blank: { id: '', name: '', repo: '', checkout: '', branch: 'main', merges: false, usesKit: false, fill: '', test: [], versionFiles: ['package.json'], release: '', install: '', approve: '', installed: '' },
    fields: [
      {
        key: 'merges',
        kind: 'switch',
        label: 'Merges PRs',
        inline: true,
        help: "Off until you say yes. On: your (and the team's) ready PRs to it are merged: not a draft, merging cleanly, no failing or running checks.",
      },
      {
        key: 'release',
        kind: 'text',
        label: 'Release it',
        help: "A command run in a fresh worktree of its branch that makes the release v<version> (npm run release, say), or tag for a release the Steward makes itself. Released whenever its branch carries a version with no release.",
        empty: 'Never released by the Steward',
        chip: 'releases',
        chipOff: 'not released',
        ...command,
      },
      { key: 'test', kind: 'list', label: 'Test it', help: 'Each must pass before a PR with no checks on GitHub merges. None: such a PR waits for you.', item: { label: 'Command', ...command }, maxItems: 10, matchCase: true, chipOff: 'no tests', hidden: true },
      {
        key: 'whenReady',
        kind: 'text',
        label: 'When a branch is ready',
        help: 'Plain git has no PRs: run in your clone for a pushed branch that claimed a version and passes its tests, with {branch}, {base}, {commit}, {version}, {title}, {notesFile}, {repo} and {checkout} filled in. Say: git push origin {commit}:refs/heads/{base}.',
        empty: 'Claimed branches are left to you',
        optional: true,
        shownWhen: { key: 'sourceControl', is: ['git'] },
        ...command,
      },
      {
        key: 'whenReleased',
        kind: 'text',
        label: 'After a release',
        help: 'Plain git: run in your clone once a release is tagged, with {tag}, {version}, {commit}, {notesFile}, {base}, {repo} and {checkout} filled in.',
        empty: 'Nothing run after its releases',
        optional: true,
        shownWhen: { key: 'sourceControl', is: ['git'] },
        ...command,
      },
      { key: 'note', kind: 'text', label: 'Note', help: "A word on its line, here and on the Steward's page: why its PRs are left to you, say.", empty: 'None', optional: true, maxLength: 200 },
      // What Look after finds in its clone, and the Steward keeps up: folded, there to fix if it found something wrong.
      {
        key: 'repo',
        kind: 'text',
        label: 'Repository',
        help: "owner/name on GitHub, host/path anywhere else, as its clone's origin says.",
        maxLength: 200,
        pattern: '[A-Za-z0-9_.-]+(/[A-Za-z0-9_.~@-]+)+',
        patternHint: 'owner/name, like octocat/hello-world, or host/path, like gitlab.com/group/app',
        hidden: true,
      },
      { key: 'branch', kind: 'text', label: 'Branch', help: 'Where releases come from and PRs go.', maxLength: 100, pattern: '[A-Za-z0-9._/-]+', patternHint: 'a branch name, like main', hidden: true },
      { key: 'checkout', kind: 'text', label: 'Your clone', help: 'The Steward works in worktrees of it, and never touches your working tree.', maxLength: 260, path: { is: 'folder', missing: 'warn', env: true }, hidden: true },
      { key: 'name', kind: 'text', label: 'Name', maxLength: 60, hidden: true },
      { key: 'id', kind: 'text', label: 'Id', maxLength: 40, pattern: '[a-z][a-z0-9-]*', patternHint: 'lowercase letters, digits and dashes, like my-app', hidden: true },
      { key: 'versionFiles', kind: 'list', label: 'Version files', help: "Where its version is: package.json, package-lock.json, a .ts with version: 'x.y.z', a .csproj or .props with <VersionPrefix>. None: no versions, and no releases.", item: { label: 'File', maxLength: 200 }, maxItems: 10, hidden: true },
      // Whether it takes the kit is the Steward's to decide, from the kit.json on its branch: kept, never shown.
      { key: 'usesKit', kind: 'switch', label: "Takes the Steward's kit", hidden: true },
      { key: 'fill', kind: 'text', label: 'Fill its kit', help: 'Fills its kit at the version kit.json pins.', empty: 'None: it has no kit', chip: 'kit', ...command, ...CASTELLAN, hidden: true },
      { key: 'install', kind: 'text', label: 'Install it', help: 'Run in its newest release, downloaded and checked, when a merged PR asks for install.', empty: 'Not installed by the Steward', ...command, ...CASTELLAN, hidden: true },
      { key: 'approve', kind: 'text', label: 'Approve a job', help: "Approves one of its jobs, with {job} its name and {sha256} the hash of the script merged on its branch.", empty: "Its jobs aren't approved by the Steward", pattern: '.*\\{job\\}.*', patternHint: 'a command with {job} in it', ...command, ...CASTELLAN, hidden: true },
      { key: 'installed', kind: 'text', label: 'Installed at', help: 'Its installed copy, where the rounds look for jobs to approve.', empty: 'Not looked at', maxLength: 260, path: { is: 'folder', missing: 'warn', env: true }, ...CASTELLAN, hidden: true },
      {
        key: 'refresh',
        kind: 'text',
        label: 'Refresh after releases',
        help: "Run in a worktree of its branch after the Steward released anything (a site's npm run sync, say): what it changes is tested, committed and pushed.",
        empty: 'Nothing run after releases',
        optional: true,
        advanced: true,
        ...command,
      },
    ],
  },
  {
    key: 'team',
    kind: 'list',
    label: 'Team',
    tab: 'How it works',
    help: "GitHub accounts whose ready PRs are merged with yours. Empty: the account gh is signed in as, which covers Claude Code's PRs. Named here, they are the whole team, so name yours too.",
    item: { label: 'GitHub account', maxLength: 60, pattern: '(app/)?[A-Za-z0-9][A-Za-z0-9-]*', patternHint: 'a GitHub account, like octocat, or app/<name> for a GitHub App' },
    maxItems: 20,
  },
  {
    key: 'byItself',
    kind: 'switch',
    label: 'Merges and releases by itself',
    tab: 'How it works',
    help: "On duty, a round every few minutes merges each repository's ready PRs (where Merges PRs is on), then releases each new version. Off: only when you press a button.",
  },
  { key: 'roundMinutes', kind: 'whole', min: 2, max: 240, unit: 'minutes', label: 'A round every', tab: 'How it works', help: 'How often it looks, while on duty.' },
  { key: 'mergeMinAgeMinutes', kind: 'whole', min: 0, max: 1440, unit: 'minutes', label: 'A PR merges once it is', tab: 'How it works', help: "Time to push a small fix to a PR before it merges. 0: as soon as it's ready." },
  { key: 'releaseAfterMerge', kind: 'switch', label: 'Release right after merging', tab: 'How it works', help: 'Off: Release is a stage of its own.' },
  {
    key: 'catchUp',
    kind: 'switch',
    label: 'Catches PRs up with their branch',
    tab: 'How it works',
    help: "A ready PR held back only because its branch moved on is caught up (version lines and changelog settled), tested and merged. Any other conflict goes back to whoever wrote it.",
  },
  {
    key: 'mergeTrain',
    kind: 'switch',
    label: 'Merges ready PRs together',
    tab: 'How it works',
    help: "Two or more of a repository's ready PRs are stacked lowest version first, tested once and merged together. Off: one at a time.",
  },
  {
    key: 'affectedTests',
    kind: 'switch',
    label: 'Tests only what a change reaches',
    tab: 'How it works',
    help: "A PR's tests run only the test files its change reaches; a change to the setup runs them all. Off: the whole suite every time.",
  },
  {
    key: 'tasteBeforeRelease',
    kind: 'switch',
    label: "Waits for the Aletaster's tasting",
    tab: 'How it works',
    help: "A release is published once the Aletaster's tasting of its commit lets it through. Released without one where the Aletaster isn't there to ask.",
  },
  {
    key: 'fileWork',
    kind: 'switch',
    label: 'Hands failures to the Wright',
    tab: 'How it works',
    ...WRIGHT,
    help: "A bump or release that fails, or one of Reeve's alerts that is code work, is filed for the Wright to fix. Its alarm is raised only if the Wright can't. Off: an alarm at once.",
  },
  {
    key: 'tend',
    kind: 'switch',
    label: "Keeps the staff's pages up",
    tab: 'How it works',
    help: "An agent on duty whose page doesn't answer is opened again through Manor: three tries, then one an hour and an alarm. One you stopped stays stopped.",
  },
  {
    key: 'afterRelease',
    kind: 'list',
    label: 'Told after a release',
    tab: 'How it works',
    help: "Local addresses POSTed after something is released: Manor's update check, so it installs within minutes.",
    item: { label: 'Address', maxLength: 200, pattern: 'http://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/[A-Za-z0-9/_.-]*', patternHint: 'a local address with its path, like http://127.0.0.1:18585/api/updates/check' },
    maxItems: 10,
  },
  { ...SOURCE_CONTROL, tab: 'How it works' },
  {
    key: 'workRoot',
    tab: 'How it works',
    kind: 'text',
    label: 'Work folder',
    help: 'Where the Steward makes its worktrees, one folder per repository.',
    maxLength: 260,
    path: { is: 'folder', missing: 'made', env: true },
    hidden: true,
  },
  { key: 'parallel', kind: 'whole', tab: 'How it works', min: 1, max: 10, unit: 'repositories', label: 'Checked at once', help: 'How many repositories a bump tests at the same time.' },
  {
    key: 'stagesAtOnce',
    kind: 'whole',
    tab: 'How it works',
    min: 1,
    max: 4,
    unit: 'stages',
    label: 'Stages at once',
    help: 'How many stages run at the same time: a round, and a Release or Bump you press, say. Each works on its own repositories: where two want the same one, the second waits for the first to finish with it. 1: one stage at a time.',
  },
  {
    key: 'dotnetRoot',
    tab: 'How it works',
    kind: 'text',
    label: '.NET SDK',
    help: "A folder with dotnet.exe and an SDK, for a .NET repository's tests and release.",
    empty: "DOTNET_ROOT's, else Program Files'",
    maxLength: 260,
    path: { is: 'folder', missing: 'warn', env: true },
    hidden: true,
  },
  {
    key: 'alarms',
    kind: 'group',
    tab: 'How it works',
    label: 'Alarms',
    help: 'What needs you, raised once, at the top of this page and in Manor until it clears.',
    fields: [
      { key: 'on', kind: 'switch', label: 'Raise alarms' },
      { key: 'toast', kind: 'switch', label: 'A Windows notification for each', help: 'Clicking it opens this page.' },
      { key: 'waitingHours', kind: 'whole', min: 1, max: 168, unit: 'hours', label: 'A PR waiting for', help: 'A draft no one marked ready, conflicts, failing checks, a version that clashes.' },
      { key: 'problemHours', kind: 'whole', min: 1, max: 168, unit: 'hours', label: "A Surveyor's problem lasting", help: 'Its warnings and notes never raise one.' },
      { key: 'tastingHours', kind: 'whole', min: 1, max: 168, unit: 'hours', label: "A release the Aletaster's tasting holds for" },
    ],
  },
  {
    key: 'wrightReview',
    kind: 'group',
    tab: 'How it works',
    label: "The Wright's drafts",
    ...WRIGHT,
    help: "Each of the Wright's drafts the Steward looks at: one that passes (small enough, nothing a person reviews, the Bailiff's approval where it is installed) is marked ready and merged; one that doesn't says why.",
    fields: [
      { key: 'on', kind: 'switch', label: "Look at the Wright's drafts, and merge the ones that pass" },
      { key: 'maxLines', kind: 'whole', min: 10, max: 5000, unit: 'lines', label: 'At most', help: 'Lines added and removed; a larger draft waits for you.' },
      { key: 'sensitive', kind: 'list', label: 'For a person to review', help: "A draft changing a file matching one of these waits for you (* any part of a name, ** any folders). Claude Code's settings, secrets and the guards always wait too.", item: { label: 'Path pattern', maxLength: 120 }, maxItems: 40 },
    ],
  },
  { key: 'wrightHere', kind: 'switch', label: 'The Wright is on this PC', help: 'Read from this PC.', readOnly: true, tab: 'How it works', ...WRIGHT, hidden: true },
  {
    key: 'rollout',
    kind: 'switch',
    label: 'Rolls out a new kit by itself',
    tab: 'Castellan',
    ...CASTELLAN,
    help: "Each repository on an older kit than the newest release is bumped and its PR pushed, a few at a time; later rounds merge and release it. Off: Bump and Push only when asked.",
  },
  {
    key: 'releaseSelf',
    kind: 'switch',
    label: 'Releases its own new versions',
    tab: 'Castellan',
    ...CASTELLAN,
    help: "A new kit or Steward version on the Steward's own main is released from a clean worktree of it.",
  },
  {
    key: 'mergeSelf',
    kind: 'switch',
    label: 'Merges its own PRs',
    tab: 'Castellan',
    ...CASTELLAN,
    help: "The team's ready PRs to the Steward itself are tested here and merged, then it releases itself. An update that doesn't stay up is rolled back.",
  },
  { key: 'stewardRepo', kind: 'text', label: "The Steward's repository", tab: 'Castellan', help: 'Where its kit releases (kit-v<version>) are, and where it releases itself.', empty: "None: it doesn't release itself, and a kit rollout needs a kit you name", maxLength: 140, ...REPO, ...CASTELLAN, hidden: true },
  {
    key: 'stewardCheckout',
    kind: 'text',
    label: "The Steward's clone",
    tab: 'Castellan',
    ...CASTELLAN,
    help: 'Its own releases are made from a worktree of it; your working tree is never touched.',
    empty: "None: it doesn't release itself or merge its own PRs",
    maxLength: 260,
    path: { is: 'folder', missing: 'warn', missingNote: "Without it, the Steward's own versions are left to you.", env: true },
    hidden: true,
  },
  { key: 'releasesRepo', kind: 'text', label: 'The releases repository', tab: 'Castellan', help: "Where each of Castellan's releases is published for every Manor, beside its own repository's.", empty: 'None: each release in its own repository only', maxLength: 140, ...REPO, ...CASTELLAN, hidden: true },
  {
    key: 'releasesCastellan',
    kind: 'switch',
    label: 'Releases Castellan itself',
    tab: 'Castellan',
    help: "Only on the PC Castellan is made on: its kit, its own releases and the releases repository. Off, as on every other PC: your repositories only.",
    advanced: true,
    ...MAKERS,
  },
  { key: 'makersPc', kind: 'switch', label: "Castellan's makers' PC", tab: 'Castellan', help: 'Read from this PC.', readOnly: true, hidden: true, ...MAKERS },
];

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const strings = (v: unknown, fallback: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : fallback);

function normalizeEmployee(e: any): Employee | null {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(e.id)) return null;
  const known = blankEmployee(e.id, e.id.charAt(0).toUpperCase() + e.id.slice(1));
  return {
    id: e.id,
    name: str(e.name, known.name),
    repo: str(e.repo, known.repo),
    checkout: str(e.checkout, known.checkout),
    branch: str(e.branch, known.branch),
    merges: typeof e.merges === 'boolean' ? e.merges : known.merges,
    usesKit: typeof e.usesKit === 'boolean' ? e.usesKit : known.usesKit,
    fill: typeof e.fill === 'string' ? e.fill.trim() : known.fill,
    test: strings(e.test, known.test),
    versionFiles: strings(e.versionFiles, known.versionFiles),
    release: typeof e.release === 'string' ? e.release.trim() : known.release,
    install: typeof e.install === 'string' ? e.install.trim() : known.install,
    approve: typeof e.approve === 'string' ? e.approve.trim() : known.approve,
    installed: typeof e.installed === 'string' ? e.installed.trim() : known.installed,
    // Left out when empty, as the page keeps them (optional), so a record without them reads as it always did.
    ...(typeof e.refresh === 'string' && e.refresh.trim() ? { refresh: e.refresh.trim() } : {}),
    ...(typeof e.whenReady === 'string' && e.whenReady.trim() ? { whenReady: e.whenReady.trim() } : {}),
    ...(typeof e.whenReleased === 'string' && e.whenReleased.trim() ? { whenReleased: e.whenReleased.trim() } : {}),
    ...(typeof e.note === 'string' && e.note.trim() ? { note: e.note.trim() } : {}),
  };
}

function normalizeAlarms(raw: unknown): AlarmSettings {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS.alarms;
  const whole = (v: unknown, min: number, max: number, fallback: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
    return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    on: typeof a.on === 'boolean' ? a.on : d.on,
    toast: typeof a.toast === 'boolean' ? a.toast : d.toast,
    waitingHours: whole(a.waitingHours, 1, 168, d.waitingHours),
    problemHours: whole(a.problemHours, 1, 168, d.problemHours),
    tastingHours: whole(a.tastingHours, 1, 168, d.tastingHours),
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
  let employees: Employee[] = [];
  if (Array.isArray(r.employees)) {
    employees = r.employees.map(normalizeEmployee).filter((e): e is Employee => e !== null);
    if (employees.length < r.employees.length) problems.push(`${r.employees.length - employees.length} employee(s) without a usable id were left out.`);
  }
  // Read from the PC, never from the file: only the maker's laptop releases Castellan, whatever settings.json says.
  const makers = makersPc();
  // Off it, the maker's own repositories are kept in the file but never looked after (inEffect): said, so it's known why.
  if (!makers)
    for (const e of employees) {
      const why = makersOwn(e, { makers });
      if (why) problems.push(why);
    }
  const parallel = Number(r.parallel);
  const stagesAtOnce = Number(r.stagesAtOnce);
  const roundMinutes = Number(r.roundMinutes);
  const mergeMinAge = r.mergeMinAgeMinutes == null || r.mergeMinAgeMinutes === '' ? NaN : Number(r.mergeMinAgeMinutes);
  return {
    settings: {
      employees,
      team: strings(r.team, d.team),
      workRoot: str(r.workRoot, d.workRoot),
      releaseAfterMerge: typeof r.releaseAfterMerge === 'boolean' ? r.releaseAfterMerge : d.releaseAfterMerge,
      stewardRepo: str(r.stewardRepo, d.stewardRepo),
      parallel: Number.isInteger(parallel) ? Math.min(10, Math.max(1, parallel)) : d.parallel,
      stagesAtOnce: Number.isInteger(stagesAtOnce) ? Math.min(4, Math.max(1, stagesAtOnce)) : d.stagesAtOnce,
      affectedTests: typeof r.affectedTests === 'boolean' ? r.affectedTests : d.affectedTests,
      byItself: typeof r.byItself === 'boolean' ? r.byItself : d.byItself,
      roundMinutes: Number.isInteger(roundMinutes) ? Math.min(240, Math.max(2, roundMinutes)) : d.roundMinutes,
      mergeMinAgeMinutes: Number.isInteger(mergeMinAge) ? Math.min(1440, Math.max(0, mergeMinAge)) : d.mergeMinAgeMinutes,
      alarms: normalizeAlarms(r.alarms),
      wrightReview: normalizeReview(r.wrightReview),
      catchUp: typeof r.catchUp === 'boolean' ? r.catchUp : d.catchUp,
      mergeTrain: typeof r.mergeTrain === 'boolean' ? r.mergeTrain : d.mergeTrain,
      afterRelease: Array.isArray(r.afterRelease) ? strings(r.afterRelease, []).filter((u) => LOCAL_ACTION.test(u)) : d.afterRelease,
      rollout: typeof r.rollout === 'boolean' ? r.rollout : d.rollout,
      releaseSelf: typeof r.releaseSelf === 'boolean' ? r.releaseSelf : d.releaseSelf,
      mergeSelf: typeof r.mergeSelf === 'boolean' ? r.mergeSelf : d.mergeSelf,
      stewardCheckout: str(r.stewardCheckout, d.stewardCheckout),
      tasteBeforeRelease: typeof r.tasteBeforeRelease === 'boolean' ? r.tasteBeforeRelease : d.tasteBeforeRelease,
      fileWork: typeof r.fileWork === 'boolean' ? r.fileWork : d.fileWork,
      tend: typeof r.tend === 'boolean' ? r.tend : d.tend,
      releasesCastellan: makers && (typeof r.releasesCastellan === 'boolean' ? r.releasesCastellan : d.releasesCastellan),
      releasesRepo: typeof r.releasesRepo === 'string' && (r.releasesRepo.trim() === '' || REPO_NAME.test(r.releasesRepo.trim())) ? r.releasesRepo.trim() : d.releasesRepo,
      dotnetRoot: str(r.dotnetRoot, d.dotnetRoot),
      sourceControl: r.sourceControl === 'git' || r.sourceControl === 'github' ? r.sourceControl : d.sourceControl,
      // Never read from the file: whether the Wright is on this PC now.
      wrightHere: wrightInstalled(),
      makersPc: makers,
    },
    problems,
  };
}

const REPO_NAME = new RegExp(`^${REPO.pattern}$`);

/**
 * One of Manor's tracked repositories (the kit's spec/REPOSITORIES.md) as the Steward looks after it: merged where it
 * says `merges`, released where it says `release`, its version claimed in its `versionFiles`; never on the kit, never
 * installed. Null for one with no repository on GitHub: the Steward works through pull requests. `taken` are the ids
 * already given, so each gets its own.
 */
export function employeeOfProject(p: ManorProject, taken: string[] = []): Employee | null {
  if (!p.repo) return null;
  const base = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return { id, name: p.name, repo: p.repo, checkout: p.checkout, branch: p.branch, merges: p.merges === true, usesKit: false, fill: '', test: p.test ? [p.test] : [], versionFiles: p.versionFiles, release: p.release ?? '', install: '', approve: '', installed: '', note: "from Manor's Repositories" };
}

/**
 * Manor's tracked repositories as the Steward's employees, each with its own id, none of `taken` (off the maker's
 * laptop, the ids of Castellan's agents and repositories); those with no GitHub repository left out.
 */
export function employeesOfProjects(projects: ManorProject[], taken: string[] = []): Employee[] {
  const out: Employee[] = [];
  for (const p of projects) {
    const e = employeeOfProject(p, [...taken, ...out.map((x) => x.id)]);
    if (e) out.push(e);
  }
  return out;
}

/** Manor is installed here (its app folder is there): then, off the makers' PC, its Repositories are the Steward's. */
export const manorInstalled = (home = manorHome()) => existsSync(path.join(home, 'app'));

/**
 * Whether Manor's Repositories are the Steward's list here (off the makers' PC): Manor is installed and has brought in
 * the repositories the Steward had (its settings.json's projectsFromSteward, Manor 0.16.24 on), or the Steward has none
 * of its own to lose. Before that, an older Manor's list would leave out what the person gave the Steward.
 */
export function manorTakesOver(own: Employee[], home = manorHome()): boolean {
  if (!manorInstalled(home)) return false;
  if (!own.length) return true;
  const m = readJson<Record<string, unknown> | null>(path.join(home, 'settings.json'), null);
  return !!m && typeof m === 'object' && m.projectsFromSteward !== undefined;
}

/**
 * The settings as the Steward works by them: on a PC that doesn't release Castellan itself (every PC but its makers'),
 * nothing of Castellan's runs, whatever the file says: no kit rollout, no releases or PRs of the Steward's own, and no
 * repository takes the kit; the releases repository isn't used. There, where Manor is installed, the repositories it
 * looks after are Manor's Repositories (`tracked`, the kit's spec/REPOSITORIES.md), the one list every agent derives
 * its own from; its own employees are read only where there is no Manor. Off the maker's laptop (maker.ts) it never
 * releases Castellan, and none of the maker's own repositories is looked after, even when the file or Manor's list names
 * one (makersOwn): Castellan's, its site's and its Exchequer's are its makers' alone; one of Manor's list that would
 * take the id of one of Castellan's agents gets its own (porter-2). Where the Wright isn't installed, nothing is handed
 * to it and its drafts aren't looked at. On the PC that releases Castellan, the Steward's own repository is never an
 * employee as well (one looked after by mistake): it is looked after as itself (stages/selfmerge.ts), and twice would
 * merge it twice. Pure, but for asking the PC (makersPc, Manor's staff) unless `o` says.
 */
export function inEffect(s: Settings, wright = s.wrightHere, tracked: ManorProject[] | null = null, o: { makers?: boolean; ids?: Set<string> } = {}): Settings {
  let out = s;
  const makers = o.makers ?? makersPc();
  if (s.releasesCastellan && s.employees.some((e) => isSelf(s, e))) out = { ...out, employees: out.employees.filter((e) => !isSelf(s, e)) };
  if (!wright && (s.fileWork || s.wrightReview.on)) out = { ...out, fileWork: false, wrightReview: { ...out.wrightReview, on: false } };
  if (!makers) out = { ...out, releasesCastellan: false, makersPc: false };
  if (!out.releasesCastellan)
    out = {
      ...out,
      rollout: false,
      releaseSelf: false,
      mergeSelf: false,
      stewardRepo: '',
      stewardCheckout: '',
      releasesRepo: '',
      employees: tracked ? employeesOfProjects(tracked, makers ? [] : [...(o.ids ?? makersIds())]) : out.employees.map((e) => (e.usesKit ? { ...e, usesKit: false } : e)),
    };
  if (!makers) {
    const theirs = out.employees.filter((e) => !makersOwn(e, { makers, ids: o.ids }));
    if (theirs.length < out.employees.length) out = { ...out, employees: theirs };
  }
  return out;
}

/**
 * The releases repository a release command is told of (MANOR_RELEASES_REPO, read by the kit's release.ts from kit
 * 2.32.0): Settings' while this PC releases Castellan itself, else none, so a release goes to its own repository only.
 */
export const releasesRepoEnv = (s: Pick<Settings, 'releasesCastellan' | 'releasesRepo'>): Record<string, string> => ({ MANOR_RELEASES_REPO: s.releasesCastellan && makersPc() ? s.releasesRepo : '' });

export const settingsFile = () => dataFile('settings.json');

/** Whether a repository is the Steward's own, as Settings name it: its repository, or its clone. */
export function isSelf(s: Pick<Settings, 'stewardRepo' | 'stewardCheckout'>, e: { repo?: string; checkout?: string; path?: string }): boolean {
  const dir = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const clone = e.checkout ?? e.path;
  return (!!s.stewardRepo && !!e.repo && e.repo.toLowerCase() === s.stewardRepo.toLowerCase()) || (!!s.stewardCheckout && !!clone && dir(clone) === dir(s.stewardCheckout));
}

/** The Steward's own repository: Settings' when they name it, else the origin of the clone they name, else none. */
export const selfRepoOf = (s: Pick<Settings, 'stewardRepo' | 'stewardCheckout'>): string => s.stewardRepo || (s.stewardCheckout ? (originRepo(s.stewardCheckout) ?? '') : '');

/** The Steward's settings, for the kit's Settings panel and its API. */
export const SETTINGS_SPEC: SettingsSpec<Settings> = {
  // Source control offered as this PC has it (scm.ts), from the last look at what is installed.
  get schema() {
    let chosen = DEFAULT_SETTINGS.sourceControl as string;
    try {
      chosen = normalizeSettings(readJson<unknown>(settingsFile(), {})).settings.sourceControl;
    } catch {
      // The default, then.
    }
    return SETTINGS_SCHEMA.map((f) => (f.key === 'sourceControl' ? sourceControlField(f, loadScm(), chosen) : f));
  },
  defaults: DEFAULT_SETTINGS,
  file: settingsFile,
  normalize: normalizeSettings,
  // Off the maker's laptop, a repository of Castellan's own (or one taking the id of one of its agents) is refused, beside it.
  check: (next) => {
    const errors: Record<string, string> = {};
    next.employees.forEach((e, i) => {
      const why = makersOwn(e, { makers: next.makersPc });
      if (why) errors[`employees.${i}.${makersOwn(e, { makers: next.makersPc, byId: false }) ? 'repo' : 'id'}`] = why;
    });
    return { errors, warnings: {} };
  },
  usedFrom: 'from the next stage on',
  // A developer's hire, all about their code: with the manor's Developer options off, no form at all.
  developerOnly: true,
};

export function loadSettings(): Settings {
  // Once, for an install that ran on the old built-in employees: they are written out from its staff table (migrate.ts).
  migrateSettings({ settingsFile: settingsFile(), staffFile: dataFile('staff.json') });
  // And until Settings are saved, what it couldn't fill in is looked for again, every few minutes.
  fillMigrationGaps({ settingsFile: settingsFile() });
  // And every few minutes, an employee that carries the kit but was taken on without it goes onto it (employ.ts).
  takeOntoKit({ settingsFile: settingsFile() });
  // Once, for an install from before the Steward looked after anyone's repositories: today's behaviour, written out.
  migrateToOwnRepos({ settingsFile: settingsFile(), dataDir });
  // Off the maker's laptop releasesCastellan reads as off whatever the file says (normalizeSettings); the file itself is
  // never rewritten for it, so a firmware that couldn't be read for a moment changes nothing that lasts.
  const s = normalizeSettings(readJson<unknown>(settingsFile(), {})).settings;
  // Off the makers' PC, with Manor here: its Repositories, read afresh (the kit's manorProjects).
  return inEffect(s, s.wrightHere, !s.releasesCastellan && manorTakesOver(s.employees) ? manorProjects() : null);
}
