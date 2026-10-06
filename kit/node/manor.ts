import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { themeNamed } from './themes.ts';

/**
 * The manor this agent works at, for the title bar's "Back to <manor>", for its theme (page.ts), and for its
 * developer features, if it has any. Manor's settings say its name, its port, the manor's theme and its Developer
 * options (settings.json in %USERPROFILE%\.manor, or MANOR_HOME, as Manor itself reads it), and Manor's own page
 * serves its icon, the one its banner shows, which this agent serves from its own address as /manor-icon.svg (its page
 * loads images from itself only). Without Manor installed there's nothing to go back to: the title bar says nothing,
 * the agent's own Theme menu chooses its theme, and its own switch its developer features.
 */
export const manorHome = () => process.env.MANOR_HOME || path.join(os.homedir(), '.manor');

export interface ManorLink {
  name: string;
  port: number;
  url: string;
  /**
   * The manor's theme (themes.ts), chosen in Manor's Theme menu: every page in the manor wears it. "system" (Match
   * Windows) when settings.json names none, or names one there isn't.
   */
  theme: string;
  /**
   * The manor's Developer options (settings.json's "developerOptions", the switch on Manor's Settings page): whether
   * its developer roles are held, and so whether an agent shows developer features of its own (developerOptions(),
   * below). Null when Manor hasn't said: no key, or not true or false.
   */
  developerOptions: boolean | null;
  /**
   * The manor's "Use the graphics card for models when there's an NPU" (settings.json's "gpuWithNpu", the switch on
   * Manor's Settings page). False: on a PC with an NPU, no graphics card runs models, not even as a fallback
   * (gpuWithNpu(), below, and the core's withoutGpuBesideNpu). True when Manor hasn't said (no key, or not true or
   * false): an older Manor never set the graphics card aside.
   */
  gpuWithNpu: boolean;
}

const DEFAULT_PORT = 18585;

/** Manor's name, page, theme, Developer options and gpuWithNpu, read afresh; null when Manor isn't installed here (no settings.json, or no app beside it). */
export function manorLink(home = manorHome()): ManorLink | null {
  return readManor(home)?.link ?? null;
}

/** Manor's link, and whether its settings say gpuWithNpu at all (true or false). */
function readManor(home: string): { link: ManorLink; saysGpuWithNpu: boolean; notify: unknown } | null {
  const file = path.join(home, 'settings.json');
  if (!existsSync(file) || !existsSync(path.join(home, 'app'))) return null;
  let raw: { name?: unknown; port?: unknown; theme?: unknown; developerOptions?: unknown; gpuWithNpu?: unknown; notify?: unknown } = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch {
    // Unreadable settings: Manor uses its defaults, and so does this link.
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : 'Manor';
  const port = Number.isInteger(raw.port) && (raw.port as number) >= 1024 && (raw.port as number) <= 65535 ? (raw.port as number) : DEFAULT_PORT;
  let theme = 'system';
  try {
    theme = themeNamed(raw.theme)?.name ?? 'system';
  } catch {
    // An agent without the kit's web part has no themes: its page isn't the kit's, and Back to Manor still works.
  }
  const developerOptions = typeof raw.developerOptions === 'boolean' ? raw.developerOptions : null;
  const saysGpuWithNpu = typeof raw.gpuWithNpu === 'boolean';
  return { link: { name, port, url: `http://manor.localhost:${port}/`, theme, developerOptions, gpuWithNpu: raw.gpuWithNpu !== false }, saysGpuWithNpu, notify: raw.notify };
}

/** Manor's Settings page, where its Developer options switch is (Manor's page at #/settings). */
export const manorSettingsUrl = (m: ManorLink) => `${m.url}#/settings`;

/**
 * Whether an agent's developer features are on. With Manor installed and saying (its Developer options), Manor's
 * value wins, and `setBy` is Manor: the agent shows developerOptionsNote() (page.ts) in place of its own switch.
 * Otherwise it's the agent's own switch, `own`. Read afresh: call it on each page load and each round, so a change in
 * Manor shows at once.
 */
export function developerOptions(own: boolean, home = manorHome()): { on: boolean; setBy: ManorLink | null } {
  const m = manorLink(home);
  return m && m.developerOptions !== null ? { on: m.developerOptions, setBy: m } : { on: own, setBy: null };
}

/**
 * Whether a graphics card may run models beside an NPU (the core's withoutGpuBesideNpu takes `on`). With Manor
 * installed and saying (settings.json's "gpuWithNpu" true or false), Manor's value wins, and `setBy` is Manor: an
 * agent with a switch of its own shows gpuWithNpuNote() (page.ts) in its place. Otherwise it's the agent's own switch,
 * `own`, true for an agent without one: an older Manor, or none, never set the graphics card aside. Read afresh: call
 * it for each request, so a change in Manor applies at once.
 */
export function gpuWithNpu(own = true, home = manorHome()): { on: boolean; setBy: ManorLink | null } {
  const m = readManor(home);
  return m?.saysGpuWithNpu ? { on: m.link.gpuWithNpu, setBy: m.link } : { on: own, setBy: null };
}

/**
 * The manor's notification preferences (settings.json's "notify", on Manor's Settings page): whether agents notify
 * the owner at all, and the quiet hours when none does. Every agent follows them; none has a switch of its own.
 * Quiet hours are local times, "HH:MM" (24-hour), from `quietFrom` until `quietTo`, and may span midnight; null for
 * both when there are none (equal times, as Manor says, or none given).
 */
export interface NotifyPrefs {
  on: boolean;
  quietFrom: string | null;
  quietTo: string | null;
}

/** Manor's defaults for "notify", which a value it can't use falls back to, field by field, as Manor's panel does. */
export const NOTIFY_DEFAULT: NotifyPrefs = { on: true, quietFrom: '22:00', quietTo: '07:00' };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (t: string) => {
  const m = CLOCK.exec(t)!;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** "notify" as Manor keeps it, checked: each wrong field its default; equal quiet times, no quiet hours. */
export function notifyFrom(raw: unknown): NotifyPrefs {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const clock = (v: unknown, def: string | null) => (typeof v === 'string' && CLOCK.test(v) ? v : def);
  const quietFrom = clock(o.quietFrom, NOTIFY_DEFAULT.quietFrom);
  const quietTo = clock(o.quietTo, NOTIFY_DEFAULT.quietTo);
  const quiet = quietFrom && quietTo && quietFrom !== quietTo;
  return { on: typeof o.on === 'boolean' ? o.on : NOTIFY_DEFAULT.on, quietFrom: quiet ? quietFrom : null, quietTo: quiet ? quietTo : null };
}

/**
 * The manor's notification preferences, read afresh; null without an installed Manor, or one that doesn't say (an
 * older Manor, with no "notify"): then nothing holds an agent back (mayNotify()).
 */
export function notifyPrefs(home = manorHome()): NotifyPrefs | null {
  const m = readManor(home);
  return m && m.notify !== undefined ? notifyFrom(m.notify) : null;
}

/**
 * Whether an agent may notify the owner now: Manor's "notify me" is on and `now` (local time) is outside its quiet
 * hours. Always true without Manor's say (notifyPrefs() null). Call it for each notification, so a change in Manor
 * applies at once; what's held back is the agent's to keep for its page, or drop, never to send later in a burst.
 */
export function mayNotify(now = new Date(), home = manorHome()): boolean {
  return notifyAllowed(notifyPrefs(home), now);
}

/** mayNotify() for preferences in hand. */
export function notifyAllowed(p: NotifyPrefs | null, now = new Date()): boolean {
  if (!p) return true;
  if (!p.on) return false;
  if (!p.quietFrom || !p.quietTo) return true;
  const t = now.getHours() * 60 + now.getMinutes();
  const from = minutesOf(p.quietFrom);
  const to = minutesOf(p.quietTo);
  const quiet = from < to ? t >= from && t < to : t >= from || t < to;
  return !quiet;
}

/** How far above the installed copy's port a development checkout serves, for every agent (each app.ts) and Manor. */
export const DEV_PORT_OFFSET = 10000;

/**
 * Another agent's page in this manor: its "home" in Manor's agents.json (the agents it announces), else in its
 * staff.json (`staffFile`, the installed Manor's app\staff.json unless said). With `dev`, its development checkout's,
 * on its port + DEV_PORT_OFFSET. Null when Manor doesn't know the agent, or says no http(s) address for it. Read
 * afresh, and never written into settings: the address is Manor's to say.
 */
export function agentUrl(id: string, o: { dev?: boolean; home?: string; staffFile?: string } = {}): string | null {
  const home = o.home ?? manorHome();
  for (const a of [...listOf(jsonAt(path.join(home, 'agents.json')), 'agents'), ...listOf(jsonAt(o.staffFile ?? path.join(home, 'app', 'staff.json')), 'agents')]) {
    if (a.id !== id) continue;
    const at = textAt(a, 'home');
    if (!at) continue;
    let url: URL;
    try {
      url = new URL(at);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (o.dev) url.port = String(Number(url.port || (url.protocol === 'https:' ? 443 : 80)) + DEV_PORT_OFFSET);
    return url.href;
  }
  return null;
}

let owner: { login: string | null; at: number } | null = null;
const OWNER_RETRY_MS = 10 * 60_000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * The GitHub account gh is signed in as on this PC (its login, the owner of the owner's repositories), for defaults
 * that would otherwise name someone: settings start empty and mean this. From gh's own config, without the network;
 * else from GitHub, through gh. Kept once known; when not (no gh, or not signed in), asked again after ten minutes.
 * Null when there's none. `run` runs gh with its arguments and returns what it printed (for tests).
 */
export function githubOwner(o: { run?: (args: string[]) => string; now?: number } = {}): string | null {
  const now = o.now ?? Date.now();
  if (owner && (owner.login || now - owner.at < OWNER_RETRY_MS)) return owner.login;
  const run = o.run ?? ghText;
  let login: string | null = null;
  for (const args of [['config', 'get', '-h', 'github.com', 'user'], ['api', 'user', '--jq', '.login']]) {
    const said = run(args).trim();
    if (LOGIN.test(said)) {
      login = said;
      break;
    }
  }
  owner = { login, at: now };
  return login;
}

/** For tests: forget the GitHub owner. */
export const forgetGithubOwner = () => {
  owner = null;
};

/** What gh printed, or nothing when it isn't there or fails: on PATH, else where this PC keeps it. */
function ghText(args: string[]): string {
  for (const gh of ['gh', 'C:\\tools\\gh\\bin\\gh.exe']) {
    try {
      return execFileSync(gh, args, { windowsHide: true, timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return '';
    }
  }
  return '';
}

/**
 * A non-employee project (settings.json's "projects", the Non-employee projects section of Manor's Settings): another
 * repository on this PC that rides along with the manor. The agents that clean up and fix repositories look after it
 * too (Reeve's rounds, the Surveyor's test runs, the Wright's and the Bailiff's fixes), but it is never staff: it takes
 * no kit, the Steward never touches it, it holds no role, and the manor never merges or releases it. Each PC has its own.
 */
export interface ManorProject {
  /** What the page calls it: 1 to 60 characters, one name to a project. */
  name: string;
  /** The clone on this PC: a full path (C:\..., or a share), one project to a clone. */
  checkout: string;
  /** Its repository on GitHub, owner/name, or null when it has none (or none was given). */
  repo: string | null;
  /** The branch its work goes to: "main" unless it says. */
  branch: string;
  /** The command that runs its tests, in its checkout, or null when it has none. */
  test: string | null;
  /**
   * The files the Wright sets the version in (paths inside the checkout, like package.json): its drafts there set the
   * next free version. Empty, as it is unless settings list some: the manor never changes this project's version.
   */
  versionFiles: string[];
  /** Whether Reeve's rounds delete branches already merged into `branch`, in the clone and on GitHub (true unless it says false). */
  cleanBranches: boolean;
}

/** What a project may not be: the manor's own repositories (owner/name) and the checkouts the Steward works from. */
export interface ManorOwn {
  repos: string[];
  checkouts: string[];
}

/** The most projects settings.json may list, and the most version files one may name. */
export const MAX_PROJECTS = 50;
export const MAX_VERSION_FILES = 20;

const FULL_PATH = /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** A branch git would take: no spaces or control characters, none of ~^:?*[\, no "..", not starting with "-" or ending in "/" or ".lock". */
const branchOk = (b: string) => b.length <= 100 && !b.startsWith('-') && !/[\s~^:?*[\\\u0000-\u001f\u007f]|\.\.|\/\/|@\{|^\/|\/$|\.lock$|^@$/.test(b);
/** A file inside the checkout, as a relative path: no drive or leading separator, no "." or ".." part, nothing Windows refuses. */
const insideFile = (f: string) => f.length <= 200 && !/^[\\/]|^[a-z]:/i.test(f) && !/[\u0000-\u001f<>:"|?*]/.test(f) && f.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..');
/** A path as Windows compares them: whole, without a separator at the end, in one case. */
const samePlace = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith('\\') ? outer : outer + '\\');

/** owner/name from a GitHub remote's URL (https or ssh), or null for anything else. */
export function githubRepo(url: string): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/*$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The GitHub repository a clone's origin is (owner/name), read from its git config: a worktree's .git file is followed
 * to the config it shares. Null when it isn't a clone, has no origin, or its origin isn't on GitHub.
 */
export function originRepo(checkout: string): string | null {
  try {
    let git = path.join(checkout, '.git');
    if (statSync(git).isFile()) {
      const to = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'))?.[1]?.trim();
      if (!to) return null;
      git = path.resolve(checkout, to);
      const common = path.join(git, 'commondir');
      if (existsSync(common)) git = path.resolve(git, readFileSync(common, 'utf8').trim());
    }
    const config = readFileSync(path.join(git, 'config'), 'utf8');
    const url = /\[remote "origin"\][^[]*?^\s*url\s*=\s*(.+)$/m.exec(config)?.[1];
    return url ? githubRepo(url) : null;
  } catch {
    return null;
  }
}

/** A JSON file's contents, or null when it's missing or unreadable. */
function jsonAt(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const listOf = (v: unknown, key: string): Record<string, unknown>[] => {
  const list = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : null;
  return Array.isArray(list) ? list.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object') : [];
};
const textAt = (o: unknown, ...keys: string[]): string | null => {
  let v: unknown = o;
  for (const k of keys) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/**
 * The manor's own, which no project may be: every agent's repository that Manor's staff.json (`staffFile`, the installed
 * Manor's app\staff.json unless said) or its agents.json still names (newer ones name none: releases are found in the
 * public releases repository by id); and the Steward's employees, their repositories and checkouts, from its
 * settings.json (or, when that names none, the staff table it keeps, staff.json), with the Steward's own checkout when
 * its settings name one. The Steward's folder is STEWARD_HOME, else %USERPROFILE%\.steward. Nothing here names anyone's
 * account or folder: what runs on someone else's PC knows only what that PC says.
 */
export function manorOwn(o: { home?: string; staffFile?: string; stewardHome?: string } = {}): ManorOwn {
  const home = o.home ?? manorHome();
  const steward = o.stewardHome ?? process.env.STEWARD_HOME ?? path.join(os.homedir(), '.steward');
  const repos = new Set<string>();
  const checkouts = new Set<string>();
  for (const a of [...listOf(jsonAt(o.staffFile ?? path.join(home, 'app', 'staff.json')), 'agents'), ...listOf(jsonAt(path.join(home, 'agents.json')), 'agents')]) {
    const repo = textAt(a, 'release', 'repo');
    if (repo) repos.add(repo);
  }
  const settings = jsonAt(path.join(steward, 'settings.json'));
  const employees = listOf(settings, 'employees');
  for (const e of employees.length ? employees : listOf(jsonAt(path.join(steward, 'staff.json')), 'rows')) {
    const repo = textAt(e, 'repo');
    if (repo) repos.add(repo);
    const checkout = textAt(e, 'checkout') ?? textAt(e, 'checkout', 'path');
    if (checkout && FULL_PATH.test(checkout)) checkouts.add(checkout);
  }
  const own = textAt(settings, 'stewardCheckout');
  if (own && FULL_PATH.test(own)) checkouts.add(own);
  return { repos: [...repos], checkouts: [...checkouts] };
}

/**
 * settings.json's "projects" as the manor uses them: each entry checked, a wrong one left out and said in `problems`
 * (Manor shows them with its other settings' problems). Manor's own settings and every agent read them with this, so
 * the rules are the same everywhere. An entry is { "name", "checkout", "repo"?, "branch"?, "test"?, "versionFiles"?,
 * "cleanBranches"? }; one whose checkout or repository is the manor's own (`own`, manorOwn()) is refused, as is a
 * checkout inside one of the Steward's or holding one: an employee is looked after as staff, never as a project.
 * Whether the checkout is there isn't checked here: a project whose clone has gone stays listed, and the page says so.
 */
export function projectsFrom(raw: unknown, own: ManorOwn, problems: string[] = []): ManorProject[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push('settings.json: "projects" should be a list of { "name", "checkout", "repo", "branch", "test", "versionFiles", "cleanBranches" }.');
    return [];
  }
  const ownRepos = new Set(own.repos.map((r) => r.toLowerCase()));
  const ownCheckouts = own.checkouts.map(samePlace);
  const projects: ManorProject[] = [];
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  raw.forEach((entry: unknown, i) => {
    const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const which = `"projects" entry ${i + 1}${name ? ` ("${name}")` : ''}`;
    const wrong = (why: string) => void problems.push(`settings.json: ${which} ${why}; it's left out.`);
    if (i >= MAX_PROJECTS) return wrong(`is one more than the ${MAX_PROJECTS} the manor looks after`);
    if (!name || name.length > 60) return wrong('should have a "name" of 1 to 60 characters');
    const checkout = typeof e.checkout === 'string' ? e.checkout.trim() : '';
    if (!checkout || checkout.length > 260 || !FULL_PATH.test(checkout) || /[\u0000-\u001f<>"|?*]/.test(checkout.slice(2))) {
      return wrong('should have a "checkout": the full path of its clone, like D:\\Code\\Example');
    }
    let repo: string | null = null;
    if (given(e.repo)) {
      if (typeof e.repo !== 'string' || !REPO.test(e.repo.trim())) return wrong('should give its "repo" as owner/name on GitHub, or none');
      repo = e.repo.trim();
    }
    let branch = 'main';
    if (given(e.branch)) {
      if (typeof e.branch !== 'string' || !branchOk(e.branch.trim())) return wrong('should give its "branch" as a branch\'s name, or none for main');
      branch = e.branch.trim();
    }
    let test: string | null = null;
    if (given(e.test)) {
      if (typeof e.test !== 'string' || !e.test.trim() || e.test.trim().length > 300 || /[\u0000-\u001f]/.test(e.test)) return wrong('should give its "test" as one command of up to 300 characters, or none');
      test = e.test.trim();
    }
    const versionFiles: string[] = [];
    if (given(e.versionFiles)) {
      const files = Array.isArray(e.versionFiles) ? e.versionFiles.map((f) => (typeof f === 'string' ? f.trim() : '')) : null;
      if (!files || files.length > MAX_VERSION_FILES || !files.every(insideFile)) {
        return wrong(`should give its "versionFiles" as a list of up to ${MAX_VERSION_FILES} files inside its checkout, like "package.json", or none`);
      }
      for (const f of files) if (!versionFiles.some((v) => v.toLowerCase() === f.toLowerCase())) versionFiles.push(f);
    }
    let cleanBranches = true;
    if (e.cleanBranches !== undefined && e.cleanBranches !== null) {
      if (typeof e.cleanBranches !== 'boolean') return wrong('should give "cleanBranches" as true or false');
      cleanBranches = e.cleanBranches;
    }
    const place = samePlace(checkout);
    if (projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) return wrong('has the name of one listed before it');
    if (projects.some((p) => samePlace(p.checkout) === place)) return wrong('has the checkout of one listed before it');
    const steward = ownCheckouts.find((c) => within(place, c) || within(c, place));
    if (steward !== undefined) {
      const how = place === steward ? 'one of' : within(place, steward) ? 'inside one of' : 'a folder holding one of';
      return wrong(`is ${how} the Steward's employees' checkouts: an employee is looked after as staff, never as a project`);
    }
    const theirs = [repo, originRepo(checkout)].find((r) => r && ownRepos.has(r.toLowerCase()));
    if (theirs) return wrong(`is ${theirs}, one of the manor's own: an employee is looked after as staff, never as a project`);
    projects.push({ name, checkout, repo, branch, test, versionFiles, cleanBranches });
  });
  return projects;
}

/**
 * The manor's non-employee projects on this PC (projectsFrom, against manorOwn()), read afresh: none when Manor isn't
 * installed here, its settings can't be read, or they list none. An agent that cleans up and fixes repositories works on
 * these as well as on the staff, and never treats one as staff: no kit, no Steward, no merge or release of its own.
 */
export function manorProjects(home = manorHome()): ManorProject[] {
  const file = path.join(home, 'settings.json');
  if (!existsSync(file) || !existsSync(path.join(home, 'app'))) return [];
  const raw = jsonAt(file);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return projectsFrom((raw as Record<string, unknown>).projects, manorOwn({ home }));
}

/** A plain house, for when Manor's own icon can't be had. */
export const HOUSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 7.5 8 2.5l6 5V14H9.8v-4H6.2v4H2z" fill="none" stroke="#5f5f5f" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

/** An SVG fit to serve from this agent's address: an SVG, and nothing in it that runs. */
export const safeSvg = (s: string) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s) && !/<script|\son[a-z]+\s*=|javascript:|<foreignObject/i.test(s);

function getText(url: string, ms: number): Promise<{ status: number; type: string; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 512 * 1024) req.destroy();
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

let kept: { at: number; port: number; svg: string } | null = null;
const KEEP_MS = 10 * 60_000;

/**
 * Manor's icon: as its page serves it (the banner it shows), kept for ten minutes; else the generic one in its
 * app folder; else a plain house. Never anything that runs.
 */
export async function manorIcon(home = manorHome(), now = Date.now()): Promise<string> {
  const link = manorLink(home);
  if (!link) return HOUSE_SVG;
  if (kept && kept.port === link.port && now - kept.at < KEEP_MS) return kept.svg;
  const r = await getText(`http://127.0.0.1:${link.port}/favicon.svg`, 1500);
  if (r && r.status === 200 && safeSvg(r.body)) {
    kept = { at: now, port: link.port, svg: r.body };
    return r.body;
  }
  try {
    const own = readFileSync(path.join(home, 'app', 'art', 'manor-icon.svg'), 'utf8');
    if (safeSvg(own)) return own;
  } catch { /* no art: the house */ }
  return HOUSE_SVG;
}

/** For tests: forget the kept icon. */
export const forgetManorIcon = () => {
  kept = null;
};
