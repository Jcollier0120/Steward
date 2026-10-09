import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './app.ts';
import type { Field, SettingsSpec } from './kit/settings-kit.ts';
import { manorHome, manorProjects, originRepo, type ManorProject } from './kit/manor.ts';
import { dataFile, readJson } from './kit/store.ts';
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
  /** The Bailiff's page, read for reviews it can't do (Claude Code unusable, a review failing); empty: not read. */
  bailiffUrl: string;
  /** Reeve's page, read for his jobs' open alerts (GET /api/alerts) where Reeve is installed; empty: not read. */
  reeveUrl: string;
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
 * The Wright, where it is installed (%USERPROFILE%\.wright\app, or WRIGHT_HOME's app): the Steward reads its page for
 * alarms. It looks after the Wright's own code only when Settings name it as an employee, as any other.
 */
export const wrightInstalled = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(env.WRIGHT_HOME ?? path.join(os.homedir(), '.wright'), 'app'));
export const WRIGHT_URL = 'http://127.0.0.1:19797';

/** Reeve is installed here when his home (%USERPROFILE%\.reeve, or REEVE_HOME) has an app folder: only then are his alerts read. */
export const reeveInstalled = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(env.REEVE_HOME ?? path.join(os.homedir(), '.reeve'), 'app'));
export const REEVE_URL = 'http://127.0.0.1:18383';

/**
 * The Bailiff is ours alone too (Manor marks it internal), and reviews the Wright's drafts. Where it is installed
 * (%USERPROFILE%\.bailiff\app, or BAILIFF_HOME's app) the Steward takes it on as it does the Wright, reads its page for
 * alarms, and marks a draft of the Wright's ready only once the Bailiff has approved its head commit (review.ts). Where
 * it isn't, the Wright's drafts wait for a person: the manor takes on no new work without both.
 */
export const bailiffInstalled = (env: NodeJS.ProcessEnv = process.env) => existsSync(path.join(env.BAILIFF_HOME ?? path.join(os.homedir(), '.bailiff'), 'app'));
export const BAILIFF_URL = 'http://127.0.0.1:19999';

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
  // It merges and releases by itself only once the person says yes: here, and for each repository (Employee.merges).
  byItself: false,
  roundMinutes: 10,
  alarms: { on: true, toast: true, waitingHours: 24, problemHours: 6, manorUrl: 'http://127.0.0.1:18585', surveyorUrl: 'http://127.0.0.1:19595', wrightUrl: '', bailiffUrl: '', reeveUrl: REEVE_URL, tastingHours: 6 },
  wrightReview: { on: true, maxLines: 600, sensitive: DEFAULT_REVIEW_SENSITIVE },
  catchUp: true,
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
};

/** Shown only on the PC that releases Castellan itself (releasesCastellan): the kit, the Steward's own releases, Manor's staff. */
const CASTELLAN = { shownWhen: { key: 'releasesCastellan', is: ['true'] } };
/** Shown only where the Wright is installed (wrightHere): its drafts, and the work handed to it. */
const WRIGHT = { shownWhen: { key: 'wrightHere', is: ['true'] } };

const REPO ={ pattern: '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', patternHint: 'owner/name, like octocat/hello-world' };
const command = { maxLength: 500 };

/** Source control (scm.ts): its options are narrowed to what this PC has, and its help says what was found, as served. */
const SOURCE_CONTROL: Field = {
  key: 'sourceControl',
  kind: 'choice',
  label: 'Source control',
  help: "How the Steward works with your repositories. GitHub: pull requests merged, GitHub releases (needs the GitHub CLI, signed in). Git: any host (GitLab, Azure DevOps, Bitbucket, a server or folder of your own) with plain git: a release is a v<version> tag pushed to the repository, and what lands on the branch is released (there are no pull requests to merge). Automatic: the Steward chooses for each repository from what this PC has.",
  options: [
    { value: 'auto', label: 'Automatic' },
    { value: 'github', label: 'GitHub, for every repository' },
    { value: 'git', label: 'Git, for every repository (any host)' },
  ],
};

/** Each setting as the page's Settings panel shows it, and as the kit's settings-kit.ts checks it. */
export const SETTINGS_SCHEMA: Field[] = [
  {
    key: 'employees',
    kind: 'records',
    noun: 'employee',
    title: 'name',
    unique: 'id',
    label: 'Repositories',
    help: "Each repository of yours the Steward looks after: its name (owner/name on GitHub, host/path anywhere else), your clone of it, how to test it, the files that carry its version, and how to release it. None to begin with: the Steward's page lists the ones Reeve finds that you can push to, each with Look after; or add one here.",
    maxItems: 50,
    blank: { id: '', name: '', repo: '', checkout: '', branch: 'main', merges: false, usesKit: false, fill: '', test: [], versionFiles: ['package.json'], release: '', install: '', approve: '', installed: '' },
    fields: [
      { key: 'id', kind: 'text', label: 'Id', maxLength: 40, pattern: '[a-z][a-z0-9-]*', patternHint: 'lowercase letters, digits and dashes, like my-app' },
      { key: 'name', kind: 'text', label: 'Name', maxLength: 60 },
      {
        key: 'repo',
        kind: 'text',
        label: 'Repository',
        help: "owner/name for a repository on GitHub; host/path for one anywhere else (gitlab.com/group/app), as its clone's origin says. Look after fills it in.",
        maxLength: 200,
        pattern: '[A-Za-z0-9_.-]+(/[A-Za-z0-9_.~@-]+)+',
        patternHint: 'owner/name, like octocat/hello-world, or host/path, like gitlab.com/group/app',
      },
      { key: 'checkout', kind: 'text', label: 'Checkout', help: 'Your clone. The Steward adds worktrees of it in the work folder and fetches; it never changes your working tree.', maxLength: 260, path: { is: 'folder', missing: 'warn', env: true } },
      { key: 'branch', kind: 'text', label: 'Branch', help: 'Where releases come from and PRs go.', maxLength: 100, pattern: '[A-Za-z0-9._/-]+', patternHint: 'a branch name, like main' },
      {
        key: 'merges',
        kind: 'switch',
        label: 'Merges your ready PRs',
        help: "Off until you say yes. On: Merge, and the rounds while \"Merges and releases by itself\" is on, merge each PR to it that you (or the team) opened, that isn't a draft, merges cleanly and has no failing or running checks; one with no checks on GitHub is tested here first with the commands below. Off: its PRs are listed, and left to you.",
      },
      { key: 'usesKit', kind: 'switch', label: "Takes the Steward's kit", help: "Off: listed, but the kit's stages pass over it (\"not using the kit yet\"), except merging the team's PRs.", ...CASTELLAN },
      { key: 'fill', kind: 'text', label: 'Fill its kit', help: 'The command that fills its kit at the version kit.json pins.', empty: 'None: it has no kit to fill', ...command, ...CASTELLAN },
      { key: 'test', kind: 'list', label: 'Test it', help: 'Each command must pass, in a worktree of the PR, before a PR with no checks on GitHub is merged. None: such a PR waits for you.', item: { label: 'Command', ...command }, maxItems: 10, matchCase: true },
      { key: 'versionFiles', kind: 'list', label: 'Version files', help: "Where its version is, kept in step: package.json, package-lock.json, a .ts with version: 'x.y.z' or VERSION = 'x.y.z', a .csproj or .props with <VersionPrefix>. Versions are claimed from these, and a release is made of the version they carry. None: no versions, and no releases.", item: { label: 'File', maxLength: 200 }, maxItems: 10 },
      { key: 'release', kind: 'text', label: 'Release it', help: "Off until you say how. A command run in a fresh worktree of the branch, which must make the GitHub release v<version> (npm run release, say); or tag, for a GitHub release of the branch's commit that the Steward makes itself, its notes the version's CHANGELOG.md entry. Released whenever the branch carries a version with no release yet.", empty: 'Never released by the Steward', ...command },
      { key: 'install', kind: 'text', label: 'Install it', help: 'Run in its newest release, downloaded, checked and unpacked, when a merged PR asks for install.', empty: "Not installed by the Steward", ...command, ...CASTELLAN },
      { key: 'approve', kind: 'text', label: 'Approve a job', help: "Run with {job} a job's name, and {sha256} the hash of the script the Steward checked (so only that script is approved): for each job a merged PR names, after its install; and in each round, for a job whose installed script is exactly the one merged on its branch, so an update never leaves its jobs waiting. Merging counts as reading the script. %USERPROFILE% and the like are expanded.", empty: "Its jobs aren't approved by the Steward", pattern: '.*\\{job\\}.*', patternHint: 'a command with {job} in it', ...command, ...CASTELLAN },
      {
        key: 'refresh',
        kind: 'text',
        label: 'Refresh after releases',
        help: "Run after the Steward released anything, any repository's (a site's npm run sync, say, that lists every release's notes and downloads): in a fresh worktree of its branch, with gh at hand. When it changed tracked files, the tests above run, then the change is committed and pushed to the branch, never forced. Nothing changed: nothing pushed. A failure is an alarm, and nothing failing is pushed; the next release tries again.",
        empty: 'Nothing run after releases',
        optional: true,
        ...command,
      },
      { key: 'note', kind: 'text', label: 'Note', help: "A word on its row of the Steward's page: why its PRs are left to you, say.", empty: 'None', optional: true, maxLength: 200 },
      { key: 'installed', kind: 'text', label: 'Installed at', help: 'Its installed copy, laid out as its repository is (jobs\\jobs.json, release.json): where the rounds look for jobs to approve.', empty: 'Not looked at', maxLength: 260, path: { is: 'folder', missing: 'warn', env: true }, ...CASTELLAN },
    ],
  },
  {
    key: 'team',
    kind: 'list',
    label: 'Team',
    help: "The GitHub accounts whose PRs to the employees the Steward merges as well as its own, when asked: merge --team, or Merge the team's PRs. Empty: the account gh is signed in as on this PC, which is yours; Claude Code opens its PRs with it, so it covers them. Accounts named here are the whole team instead, so name yours among them. A team PR that isn't a draft is ready to merge: open one that needs review as a draft. One with no checks on GitHub is tested here first, and the version it sets must be new. Their branches are left as they are.",
    item: { label: 'GitHub account', maxLength: 60, pattern: '(app/)?[A-Za-z0-9][A-Za-z0-9-]*', patternHint: 'a GitHub account, like octocat, or app/<name> for a GitHub App' },
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
  { key: 'stewardRepo', kind: 'text', label: "The Steward's repository", help: "The Steward's own GitHub repository, if you keep one: where its kit releases (kit-v<version>) are, and where it releases itself.", empty: "None: it doesn't release itself, and a kit rollout needs a kit you name", maxLength: 140, ...REPO, ...CASTELLAN },
  { key: 'parallel', kind: 'whole', min: 1, max: 10, unit: 'employees', label: 'Checked at once', help: 'How many employees a bump tests at the same time.' },
  {
    key: 'byItself',
    kind: 'switch',
    label: 'Merges and releases by itself',
    help: "Off until you say yes. On duty, a round every few minutes: in each repository whose \"Merges your ready PRs\" is on, every PR of yours (or the team's) that is ready (not a draft, mergeable, no failing or running checks; one with none tested here first, and with a new version if it sets one) is merged, with what it asks for after; then each repository with a way to release it whose branch carries a version with no release is released. Off: only when you press a button.",
  },
  {
    key: 'catchUp',
    kind: 'switch',
    label: 'Catches PRs up with their branch',
    help: "In its rounds, a ready PR of the team's that waits only because its branch moved on is caught up: the branch merged into it (a conflict resolved only where it is in the version lines, or a new entry at the top of CHANGELOG.md on each side), the next free version given when its own is taken, and pushed, with a comment; the next round tests and merges it. One whose checks failed here is caught up when the branch moves on. Any other conflict goes back to whoever wrote the PR: the Wright's is closed and its issue queued for it again; anyone else's, a Claude Code session's too, gets a comment that names the files.",
  },
  {
    key: 'rollout',
    kind: 'switch',
    label: 'Rolls out a new kit by itself',
    ...CASTELLAN,
    help: "In its rounds, each employee whose branch pins a kit older than the newest kit release is bumped (a worktree of its branch, the new pin and the next patch version, its checks run) and its PR pushed, a few at a time; later rounds merge and release it. Not one with a kit PR already open. A bump whose checks fail is handed to the Wright (or an alarm: Hands failures to the Wright, below), and isn't tried again for that kit until a new commit lands on its branch, or you press Bump or Push. It waits while this Steward carries a kit older than the newest release, since its tools/kit.ts is the one handed out. Off: Bump and Push only when asked.",
  },
  {
    key: 'releaseSelf',
    kind: 'switch',
    label: 'Releases its own new versions',
    ...CASTELLAN,
    help: "In its rounds, when the Steward's own main carries a kit version with no kit-v release, or a Steward version with no v release, it is released from a clean worktree of main, as a person would: npm run kit-release -- --publish, then npm run release -- --publish. Never a version already released; a release that fails is an alarm, and isn't tried again at that commit.",
  },
  {
    key: 'mergeSelf',
    kind: 'switch',
    label: 'Merges its own PRs',
    ...CASTELLAN,
    help: "In its rounds, the team's ready PRs to the Steward's own repository are merged as an employee's are: tested here first (npm run typecheck and npm test, in a worktree of its own), with a new version each, caught up with main or sent back to their author when they conflict. Then it releases itself, and Manor installs it. An update that doesn't come up, or doesn't stay up, is rolled back to the version before it and ignored until you look: its alarm says how to allow it again. Off: its PRs are left to you.",
  },
  {
    key: 'stewardCheckout',
    kind: 'text',
    label: "The Steward's checkout",
    ...CASTELLAN,
    help: 'Your clone of the Steward, if you keep one, which its own releases are made from: a worktree of it at origin/main, in the work folder. Your working tree is never touched.',
    empty: "None: it doesn't release itself or merge its own PRs",
    maxLength: 260,
    path: { is: 'folder', missing: 'warn', missingNote: "Without it, the Steward's own versions are left to you.", env: true },
  },
  {
    key: 'tasteBeforeRelease',
    kind: 'switch',
    label: "Waits for the Aletaster's tasting",
    help: "Before it publishes an employee's release, the Steward asks the Aletaster to taste the very commit it would release (POST /api/taste), and publishes only when the tasting lets it through: a pass, or a warning unless the Aletaster's own settings say warnings hold. Otherwise the release waits, with the tasting's reason, and the next round asks again; one held longer than the alarms' while is an alarm. Never the Aletaster's own release, so a broken Aletaster can always be fixed. Released without a tasting, and said so, when the Aletaster isn't installed, is off duty for Developer options, predates the tasting, or its page doesn't answer.",
  },
  {
    key: 'fileWork',
    kind: 'switch',
    label: 'Hands failures to the Wright',
    ...WRIGHT,
    help: "An employee's bump or release that fails, and one of Reeve's alerts that is code work in an employee's repository (a security advisory, a failing UI test), is filed as an issue in the Wright's queue (manor:work), with what failed, its output (secrets taken out) and what done means: once each, at most a few a day, and only in a repository the Wright's page (The Wright's page, under Alarms) says it works in. Its alarm then waits: it is raised only when the Wright gets stuck or its PR waits for your review, the Wright has no queue for that repository, or nothing has landed after the alarms' while for a PR (a day). The Steward's own releases stay alarms. Off: each is an alarm at once, as before.",
  },
  {
    key: 'tend',
    kind: 'switch',
    label: "Keeps the staff's pages up",
    help: "In its rounds, every agent Manor employs that is on duty but whose page doesn't answer (so its rounds aren't running) has its page opened again, through Manor's own Open: at most three tries while it stays down, then one an hour, and an alarm. Its duty is never changed: an agent you stopped stays stopped. It needs only Manor's page (under Alarms), so it works with no repositories to look after, and then it is all a round does.",
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
      { key: 'manorUrl', kind: 'text', label: "Manor's page", help: "Read for updates it couldn't install, and for the staff's pages to keep up (Keeps the staff's pages up).", empty: 'Not read', maxLength: 100, pattern: 'https?://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/?', patternHint: 'a local address, like http://127.0.0.1:18585' },
      { key: 'surveyorUrl', kind: 'text', label: "The Surveyor's page", help: 'Read for its problems, where the Surveyor is installed.', empty: 'Not read', maxLength: 100, pattern: 'https?://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/?', patternHint: 'a local address, like http://127.0.0.1:19595' },
      { key: 'tastingHours', kind: 'whole', min: 1, max: 168, unit: 'hours', label: "A release the Aletaster's tasting holds for", help: 'With the reason the tasting gave, and a link to it.' },
      { key: 'reeveUrl', kind: 'text', label: "Reeve's page", help: "Read for his jobs' open alerts (GET /api/alerts), where Reeve is installed: each is an alarm at once. An older Reeve without them is passed over quietly.", empty: 'Not read', maxLength: 100, pattern: 'https?://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/?', patternHint: 'a local address, like http://127.0.0.1:18383' },
      { key: 'wrightUrl', kind: 'text', label: "The Wright's page", help: 'Read for the issues it got stuck on, and its PRs that change what a person reviews.', empty: 'Not read', maxLength: 100, pattern: 'https?://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/?', patternHint: 'a local address, like http://127.0.0.1:19797', ...WRIGHT },
      { key: 'bailiffUrl', kind: 'text', label: "The Bailiff's page", help: "Read for the reviews it can't do: Claude Code not signed in, or a review that keeps failing.", empty: 'Not read', maxLength: 100, pattern: 'https?://(127\\.0\\.0\\.1|localhost|[a-z0-9-]+\\.localhost)(:\\d+)?/?', patternHint: 'a local address, like http://127.0.0.1:19999', ...WRIGHT },
    ],
  },
  {
    key: 'wrightReview',
    kind: 'group',
    label: "The Wright's drafts",
    ...WRIGHT,
    help: "The Wright opens every pull request as a draft. In its rounds the Steward looks at each, in code: not labelled wright:needs-you, no changed file a person reviews, no dependency changes, not too large; and where the Bailiff is installed, its approval of the draft's head commit. One that passes is marked ready, then tested here and merged as any team PR; one that doesn't stays a draft, and says why.",
    fields: [
      { key: 'on', kind: 'switch', label: 'Look at the Wright\'s drafts, and merge the ones that pass' },
      { key: 'maxLines', kind: 'whole', min: 10, max: 5000, unit: 'lines', label: 'At most', help: 'Lines added and removed; a larger draft waits for you.' },
      { key: 'sensitive', kind: 'list', label: 'For a person to review', help: "A draft changing a file that matches one of these waits for you. * is any part of a name, ** any folders. Whatever this list says, Claude Code's settings and instructions (.claude, CLAUDE.md, AGENTS.md, .mcp.json), .npmrc, secrets (.env, keys), and the Steward's, the Wright's and the Bailiff's own guards always wait for you too.", item: { label: 'Path pattern', maxLength: 120 }, maxItems: 40 },
    ],
  },
  { key: 'wrightHere', kind: 'switch', label: 'The Wright is on this PC', help: 'Read from this PC: its drafts and the work handed to it are above.', readOnly: true, ...WRIGHT },
  SOURCE_CONTROL,
  {
    key: 'dotnetRoot',
    kind: 'text',
    label: '.NET SDK',
    help: "A folder with dotnet.exe and an SDK, for a .NET repository's tests and release. A runtime alone can't build.",
    empty: "DOTNET_ROOT's, else Program Files'",
    maxLength: 260,
    path: { is: 'folder', missing: 'warn', env: true },
    advanced: true,
  },
  {
    key: 'releasesCastellan',
    kind: 'switch',
    label: 'Releases Castellan itself',
    help: "Only on the PC Castellan is made on. On: the Steward also rolls its kit out to Castellan's agents, releases and merges its own new versions, and publishes each agent's release to the releases repository below as well as to its own. Off, as on every other PC: it looks after your repositories, and nothing of Castellan's.",
    advanced: true,
  },
  { key: 'releasesRepo', kind: 'text', label: 'The releases repository', help: "Where each of Castellan's releases is published for every Manor, as well as in the agent's own repository (the kit's release, as MANOR_RELEASES_REPO).", empty: 'None: each release in its own repository only', maxLength: 140, ...REPO, ...CASTELLAN },
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
    ...(typeof e.note === 'string' && e.note.trim() ? { note: e.note.trim() } : {}),
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
    // Read only where it is installed: a page Settings still name after it's removed would be "down" for ever.
    wrightUrl: !wrightInstalled() ? '' : a.wrightUrl === undefined ? WRIGHT_URL : url(a.wrightUrl, d.wrightUrl),
    // The same for the Bailiff's.
    bailiffUrl: !bailiffInstalled() ? '' : a.bailiffUrl === undefined ? BAILIFF_URL : url(a.bailiffUrl, d.bailiffUrl),
    reeveUrl: url(a.reeveUrl, d.reeveUrl),
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
      mergeSelf: typeof r.mergeSelf === 'boolean' ? r.mergeSelf : d.mergeSelf,
      stewardCheckout: str(r.stewardCheckout, d.stewardCheckout),
      tasteBeforeRelease: typeof r.tasteBeforeRelease === 'boolean' ? r.tasteBeforeRelease : d.tasteBeforeRelease,
      fileWork: typeof r.fileWork === 'boolean' ? r.fileWork : d.fileWork,
      tend: typeof r.tend === 'boolean' ? r.tend : d.tend,
      releasesCastellan: typeof r.releasesCastellan === 'boolean' ? r.releasesCastellan : d.releasesCastellan,
      releasesRepo: typeof r.releasesRepo === 'string' && (r.releasesRepo.trim() === '' || REPO_NAME.test(r.releasesRepo.trim())) ? r.releasesRepo.trim() : d.releasesRepo,
      dotnetRoot: str(r.dotnetRoot, d.dotnetRoot),
      sourceControl: r.sourceControl === 'git' || r.sourceControl === 'github' ? r.sourceControl : d.sourceControl,
      // Never read from the file: whether the Wright is on this PC now.
      wrightHere: wrightInstalled(),
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

/** Manor's tracked repositories as the Steward's employees, each with its own id; those with no GitHub repository left out. */
export function employeesOfProjects(projects: ManorProject[]): Employee[] {
  const out: Employee[] = [];
  for (const p of projects) {
    const e = employeeOfProject(p, out.map((x) => x.id));
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
 * its own from; its own employees are read only where there is no Manor. Where the Wright isn't installed, nothing is
 * handed to it and its drafts aren't looked at. On the PC that does, the Steward's own repository is never an employee
 * as well (one looked after by mistake): it is looked after as itself (stages/selfmerge.ts), and twice would merge it
 * twice. Pure.
 */
export function inEffect(s: Settings, wright = s.wrightHere, tracked: ManorProject[] | null = null): Settings {
  let out = s;
  if (s.releasesCastellan && s.employees.some((e) => isSelf(s, e))) out = { ...out, employees: out.employees.filter((e) => !isSelf(s, e)) };
  if (!wright && (s.fileWork || s.wrightReview.on)) out = { ...out, fileWork: false, wrightReview: { ...out.wrightReview, on: false } };
  if (!s.releasesCastellan)
    out = {
      ...out,
      rollout: false,
      releaseSelf: false,
      mergeSelf: false,
      stewardRepo: '',
      stewardCheckout: '',
      releasesRepo: '',
      employees: tracked ? employeesOfProjects(tracked) : out.employees.map((e) => (e.usesKit ? { ...e, usesKit: false } : e)),
    };
  return out;
}

/**
 * The releases repository a release command is told of (MANOR_RELEASES_REPO, read by the kit's release.ts from kit
 * 2.32.0): Settings' while this PC releases Castellan itself, else none, so a release goes to its own repository only.
 */
export const releasesRepoEnv = (s: Pick<Settings, 'releasesCastellan' | 'releasesRepo'>): Record<string, string> => ({ MANOR_RELEASES_REPO: s.releasesCastellan ? s.releasesRepo : '' });

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
  usedFrom: 'from the next stage on',
};

export function loadSettings(): Settings {
  // Once, for an install that ran on the old built-in employees: they are written out from its staff table (migrate.ts).
  migrateSettings({ settingsFile: settingsFile(), staffFile: dataFile('staff.json') });
  // And until Settings are saved, what it couldn't fill in is looked for again, every few minutes.
  fillMigrationGaps({ settingsFile: settingsFile() });
  // Once, for an install from before the Steward looked after anyone's repositories: today's behaviour, written out.
  migrateToOwnRepos({ settingsFile: settingsFile(), dataDir });
  const s = normalizeSettings(readJson<unknown>(settingsFile(), {})).settings;
  // Off the makers' PC, with Manor here: its Repositories, read afresh (the kit's manorProjects).
  return inEffect(s, s.wrightHere, !s.releasesCastellan && manorTakesOver(s.employees) ? manorProjects() : null);
}
