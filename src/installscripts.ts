import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Runner } from './run.ts';

/**
 * Install scripts: the code a package runs on this PC as npm installs it (its preinstall, install or postinstall, or
 * node-gyp for one with a binding.gyp; a git dependency's prepare). Node and npm aren't scanned by Defender on the
 * makers' PC, so a rogue package's script would run, and write what it likes, before anything in the manor looked at
 * it. The Steward installs packages in its own worktrees (the shared sets, bumps, a PR's checks, releases, refreshes),
 * so before each it reads the lockfile: npm records `hasInstallScript` for every package that has one.
 *
 * Every install runs `npm ci --ignore-scripts`, so nothing's script runs by itself. A package on Settings' short list
 * (installScripts: esbuild, and the few others the manor's lockfiles carry) then has its script run by name, `npm
 * rebuild <name>`, and only it. A package with one that isn't on the list holds the work: nothing is installed, the
 * stage says why, and an alarm names the package, its version, the repository and the script it would have run
 * (install-held.json), until it's on the list or no longer seen. A git dependency is held whatever its name: its code
 * isn't the registry's.
 */

/** The packages the manor's own lockfiles run install scripts for (2026-10-13): esbuild everywhere, Next.js's unrs-resolver, and fsevents (macOS only). */
export const DEFAULT_INSTALL_SCRIPTS = ['esbuild', 'unrs-resolver', 'fsevents'];

/** An npm package's name, as Settings' list takes it. */
export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** The list in effect: Settings', or the defaults where Settings say none. */
export const allowedInstallScripts = (s: { installScripts?: string[] }) => s.installScripts ?? DEFAULT_INSTALL_SCRIPTS;

export interface LockPackage {
  name: string;
  version: string;
  /** Where the lockfile puts it: node_modules/esbuild. */
  path: string;
  /** npm recorded an install script for it. */
  script: boolean;
  /** Where it comes from, when that is git: npm runs its prepare as it installs. */
  git?: string;
}

const GIT = /^(?:git\+|git:|github:|gitlab:|bitbucket:)/;
const GIT_SCRIPT = 'a git dependency';

/**
 * The packages a lockfile installs (not the project's own entry, nor its workspaces): null when there's no lockfile or it
 * isn't JSON. One older than `packages` (lockfileVersion 1) says nothing of install scripts: its packages are listed
 * without, and installed with --ignore-scripts all the same. Pure.
 */
export function lockPackages(text: string | null): LockPackage[] | null {
  if (text === null) return null;
  let lock: any;
  try {
    lock = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const out: LockPackage[] = [];
  const add = (p: string, name: string, v: any) => {
    const resolved = typeof v?.resolved === 'string' ? v.resolved : typeof v?.version === 'string' && GIT.test(v.version) ? v.version : '';
    out.push({ name, version: String(v?.version ?? ''), path: p, script: v?.hasInstallScript === true, ...(GIT.test(resolved) ? { git: resolved } : {}) });
  };
  if (lock?.packages && typeof lock.packages === 'object') {
    for (const [p, v] of Object.entries<any>(lock.packages)) {
      const at = p.lastIndexOf('node_modules/');
      // The project's own entry, and its workspaces and links to them: its own code, reviewed with it.
      if (at < 0 || !v || typeof v !== 'object' || v.link) continue;
      add(p, typeof v.name === 'string' ? v.name : p.slice(at + 'node_modules/'.length), v);
    }
  } else if (lock?.dependencies && typeof lock.dependencies === 'object') {
    const walk = (deps: Record<string, any>, under: string) => {
      for (const [name, d] of Object.entries(deps)) {
        const p = `${under}node_modules/${name}`;
        add(p, name, d);
        if (d?.dependencies && typeof d.dependencies === 'object') walk(d.dependencies, `${p}/`);
      }
    };
    walk(lock.dependencies, '');
  }
  return out;
}

/** The packages in a lockfile that run something as they install. Pure. */
export const runsOnInstall = (pkgs: LockPackage[]) => pkgs.filter((p) => p.script || p.git);

const lower = (names: string[]) => new Set(names.map((n) => n.toLowerCase()));

/** Whether a package's script may run: its name on the list, and from the registry. Pure. */
export const allowedToRun = (p: LockPackage, allowed: string[]) => !p.git && lower(allowed).has(p.name.toLowerCase());

export interface InstallPlan {
  /** npm's arguments: always with --ignore-scripts. */
  ci: string[];
  /** The allowed packages whose scripts are run then, by name (npm rebuild). */
  rebuild: string[];
  /** The packages that hold it: a script not on the list. Nothing is installed while there is one. */
  held: LockPackage[];
}

/** How a lockfile's packages are installed, with Settings' list. Pure. */
export function installPlan(lockText: string | null, allowed: string[], o: { preferOffline?: boolean } = {}): InstallPlan {
  const running = runsOnInstall(lockPackages(lockText) ?? []);
  const held = running.filter((p) => !allowedToRun(p, allowed));
  const seen = new Set<string>();
  const unique = held.filter((p) => !seen.has(`${p.name}@${p.version}`) && seen.add(`${p.name}@${p.version}`));
  return {
    ci: ['ci', '--ignore-scripts', ...(o.preferOffline ? ['--prefer-offline'] : []), '--no-audit', '--no-fund'],
    rebuild: [...new Set(running.filter((p) => allowedToRun(p, allowed)).map((p) => p.name))].sort(),
    held: unique,
  };
}

/** The command lines a plan runs, in order. Pure. */
export const installLines = (plan: InstallPlan) => [`npm ${plan.ci.join(' ')}`, ...(plan.rebuild.length ? [`npm rebuild ${plan.rebuild.join(' ')}`] : [])];

/** A package as the hold names it: name@version. */
export const named = (p: Pick<LockPackage, 'name' | 'version'>) => `${p.name}@${p.version}`;

/**
 * The script a held package would have run, as its registry entry says (npm view: no code of the package runs), or
 * what npm couldn't say. A git dependency's is its prepare.
 */
export async function scriptOf(run: Runner, dir: string, p: LockPackage): Promise<string> {
  if (p.git) return `${GIT_SCRIPT} (${p.git}): npm runs its prepare script as it installs`;
  try {
    const r = await run('npm', ['view', named(p), 'scripts', 'gypfile', '--json'], { cwd: dir, timeoutMs: 30_000 });
    if (r.code !== 0) return `npm couldn't say which (npm view: exit ${r.code})`;
    const j = JSON.parse(r.out || '{}');
    const scripts = (j && typeof j === 'object' && (j.scripts ?? j)) || {};
    const lines = ['preinstall', 'install', 'postinstall'].filter((k) => typeof scripts[k] === 'string').map((k) => `${k}: ${scripts[k]}`);
    if (lines.length) return lines.join('; ');
    return j?.gypfile ? 'node-gyp rebuild (it has a binding.gyp)' : 'npm records one, but its registry entry names none (a binding.gyp, most likely: node-gyp rebuild)';
  } catch (err) {
    return `npm couldn't say which (${(err as Error).message})`;
  }
}

/** One package held, as install-held.json keeps it and the alarm reads it. */
export interface InstallHold {
  /** The employee's id, and its name and repository. */
  who: string;
  name: string;
  repo: string;
  package: string;
  version: string;
  path: string;
  script: string;
  /** What the Steward was doing: "a bump to kit 2.69.1", "#12's checks", "the release of v1.2.3". */
  doing: string;
  /** Where (the worktree). */
  dir: string;
  since: string;
  lastAt: string;
}

export const installHeldFile = () => dataFile('install-held.json');
export const loadInstallHolds = (): Record<string, InstallHold> => readJson<Record<string, InstallHold>>(installHeldFile(), {});
export const holdId = (h: Pick<InstallHold, 'who' | 'repo' | 'package' | 'version'>) => `${h.repo || h.who}:${h.package}@${h.version}`;

/** How long a hold stays an alarm after it was last seen: the work that saw it has stopped asking (a PR closed, say). */
export const HOLD_SEEN_MS = 2 * 24 * 3_600_000;

/** Whether a hold still holds: its package not on the list since (a git dependency always), and seen lately. Pure. */
const stillHeld = (h: InstallHold, allowed: string[], now: number) =>
  (h.script.startsWith(GIT_SCRIPT) || !lower(allowed).has(h.package.toLowerCase())) && now - Date.parse(h.lastAt) < HOLD_SEEN_MS;

/** The packages held, as kept: each seen again now updated, each allowed since or not seen a while dropped. Pure. */
export function keepHolds(was: Record<string, InstallHold>, seen: InstallHold[], allowed: string[], now: Date): Record<string, InstallHold> {
  const at = now.toISOString();
  const out: Record<string, InstallHold> = {};
  for (const [id, h] of Object.entries(was)) if (stillHeld(h, allowed, now.getTime())) out[id] = h;
  for (const h of seen) {
    const id = holdId(h);
    out[id] = { ...h, since: out[id]?.since ?? h.since ?? at, lastAt: at };
  }
  return out;
}

/** The alarm for each package held: at once, until it's on the list or not seen for HOLD_SEEN_MS. Pure. */
export function installHoldConditions(holds: Record<string, InstallHold>, allowed: string[], now = Date.now()) {
  return Object.values(holds)
    .filter((h) => stillHeld(h, allowed, now))
    .map((h) => ({
      id: `install-script:${holdId(h)}`,
      who: h.who,
      title: `${h.name}: ${h.package}@${h.version} would run an install script, so the Steward installed nothing (${h.repo || h.who})`,
      detail: [
        `Its script: ${h.script}`,
        `Seen in ${h.repo || h.name}'s package-lock.json (${h.path}) during ${h.doing}, in ${h.dir}.`,
        `If you trust it, add ${h.package} to "Install scripts allowed" in the Steward's Settings: the next round installs it, running its script. If you don't, take it out of ${h.repo || h.name}'s dependencies; the work it held waits until then.`,
      ],
      since: h.since,
      afterMs: 0,
    }));
}

/** Who the install is for, and what it is part of, for the hold's alarm. */
export interface InstallFor {
  who: { id: string; name: string; repo: string };
  doing: string;
}

/**
 * Before an install in `dir`: its plan from the lockfile there and Settings' list, or why it is held (each package held
 * named, with its version and script, and kept for the alarm). `file` stands in for install-held.json in tests.
 */
export async function guardInstall(
  run: Runner,
  dir: string,
  allowed: string[],
  f: InstallFor,
  o: { preferOffline?: boolean; now?: Date; file?: string } = {},
): Promise<{ plan: InstallPlan; held: null } | { plan: InstallPlan; held: string }> {
  let text: string | null = null;
  try {
    text = readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
  } catch {
    // No lockfile: npm ci refuses by itself.
  }
  const plan = installPlan(text, allowed, o);
  if (!plan.held.length) return { plan, held: null };
  const now = o.now ?? new Date();
  const seen: InstallHold[] = [];
  for (const p of plan.held) {
    seen.push({ who: f.who.id, name: f.who.name, repo: f.who.repo, package: p.name, version: p.version, path: p.path, script: await scriptOf(run, dir, p), doing: f.doing, dir, since: now.toISOString(), lastAt: now.toISOString() });
  }
  const file = o.file ?? installHeldFile();
  try {
    writeJson(file, keepHolds(readJson<Record<string, InstallHold>>(file, {}), seen, allowed, now));
  } catch {
    // The hold stands without its alarm: the stage still says why.
  }
  const list = seen.map((h) => `${h.package}@${h.version} (${h.script})`);
  return {
    plan,
    held: `nothing was installed: ${list.slice(0, 3).join(', ')}${list.length > 3 ? `, and ${list.length - 3} more` : ''} ${seen.length === 1 ? 'runs an install script that is' : 'run install scripts that are'} not on "Install scripts allowed" in the Steward's Settings`,
  };
}
