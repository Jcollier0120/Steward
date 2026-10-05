#!/usr/bin/env node
/**
 * Builds this agent's release, as every Node agent of Manor's does (Manor's docs/INSTALLING.md, "Releases"):
 *
 *   npm run release                  artifacts\<id>\<Name, no spaces>-<version>.zip and artifacts\<id>\SHA256SUMS.txt
 *   npm run release -- --install     builds it, then installs it on this PC (node <unpacked>\src\cli.ts install)
 *   npm run release -- --publish     builds it, then makes the GitHub release v<version> with both files
 *
 * An agent that announces itself to every Manor (Manor's src/announced.ts) has manor-agent.json at its root: its
 * entry as Manor's staff.json has it, and the roles it brings. The release copies it beside the zip, lists it in
 * SHA256SUMS.txt (Manor takes it only when it's listed there), and publishes it with the zip; and refuses to
 * build when it names another repository than origin's, or another agent than this one.
 *
 * npm run release fills src\kit\ first (tools\kit.ts), at the version kit.json pins. The zip holds what
 * the agent runs from, at its top level: src\ (no tests) with src\kit\ in it, art\, package.json,
 * README.md and release.json, which names the kit; and kit.json and tools\kit.ts, so the copy can fill
 * its kit again (and the Steward, installed, has the tools\kit.ts it hands out). So an installed agent
 * needs neither the Steward nor GitHub. The zip is made and opened with Windows' own tar.exe, so there's
 * no dependency. Uncommitted changes in what the zip carries make a release marked dirty, version
 * <version>+dev.<commit>, which installs but doesn't publish.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP } from '../app.ts';
import type { Release } from './install.ts';

/** The agent's root: this file is its src\kit\release.ts. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** The folders a release carries whole, tests aside (src\ holds the PowerShell scripts an agent runs, too, and src\kit\). */
export const RELEASE_FOLDERS = ['src', 'art'];
/** The files a release carries, when the repo has them. */
export const RELEASE_FILES = ['package.json', 'README.md', 'LICENSE', 'kit.json', 'tools/kit.ts'];

/**
 * The kit a release carries: src\kit\VERSION, which must be the version kit.json pins (npm run kit fills
 * it). An error in words when it isn't.
 */
export function kitOf(dir: string): { kit: string } | { error: string } {
  let pin: unknown;
  try {
    pin = JSON.parse(readFileSync(path.join(dir, 'kit.json'), 'utf8').replace(/^\uFEFF/, '')).kit;
  } catch {
    return { error: `${path.join(dir, 'kit.json')} is missing or unreadable: it pins the kit this agent uses` };
  }
  let have = '';
  try {
    have = readFileSync(path.join(dir, 'src', 'kit', 'VERSION'), 'utf8').trim();
  } catch {
    return { error: `src\\kit\\ isn't filled: run npm run kit` };
  }
  if (have !== pin) return { error: `src\\kit\\ holds kit ${have}, but kit.json pins ${String(pin)}: run npm run kit` };
  return { kit: have };
}

/** The release asset an agent announces itself to every Manor with (Manor's src/announced.ts). */
export const ANNOUNCEMENT = 'manor-agent.json';

/**
 * What's wrong with a manor-agent.json, as Manor would refuse it (its src/announced.ts, and install.ts's
 * announcedHire), or null when Manor can take it: an object with an "agent" whose id is this agent's, a Node release
 * from `repo` (origin's, owner/name), installed at %USERPROFILE%\.<id>\app; and "roles", when given, a list of objects.
 */
export function checkAnnouncement(json: unknown, id: string, repo: string | null): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return `${ANNOUNCEMENT} should be an object with an "agent".`;
  const j = json as Record<string, unknown>;
  const agent = j.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return `${ANNOUNCEMENT} should give its "agent": its entry, as Manor's staff.json has one.`;
  if (agent.id !== id) return `${ANNOUNCEMENT}'s agent is ${JSON.stringify(agent.id ?? null)}, but this release is ${JSON.stringify(id)} (release.json's id).`;
  const release = agent.release as Record<string, unknown> | undefined;
  const named = typeof release?.repo === 'string' ? release.repo : null;
  if (!repo) return `${ANNOUNCEMENT} can't be checked: origin isn't a GitHub repository, and its "release.repo" must be the one it's published from.`;
  if (named?.toLowerCase() !== repo.toLowerCase()) return `${ANNOUNCEMENT} names ${named ?? 'no repository'} as its "release.repo", but origin is ${repo}, where it would be published.`;
  if (release?.kind !== 'node') return `${ANNOUNCEMENT}'s "release.kind" is ${JSON.stringify(release?.kind ?? null)}: Manor takes an announced agent only as a Node release ("node").`;
  const where = `%USERPROFILE%\\.${id}\\app`;
  const app = (agent.paths as Record<string, unknown> | undefined)?.app;
  if (!Array.isArray(app) || app.length !== 1 || String(app[0]).toLowerCase() !== where.toLowerCase()) return `${ANNOUNCEMENT}'s "paths.app" should be ${JSON.stringify([where])}, where its installer puts it.`;
  const roles = j.roles;
  if (roles !== undefined && (!Array.isArray(roles) || !roles.every((r) => r && typeof r === 'object' && !Array.isArray(r)))) return `${ANNOUNCEMENT}'s "roles" should be a list of roles, as Manor's roles.json has them.`;
  return null;
}

/**
 * The checkout's manor-agent.json, checked (checkAnnouncement): null when it has none, its path when Manor can take
 * it, else an error in words.
 */
export function announcementOf(dir: string, id: string, repo: string | null): { file: string } | { error: string } | null {
  const file = path.join(dir, ANNOUNCEMENT);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { error: `${ANNOUNCEMENT} isn't JSON: ${(e as Error).message}. Fix it, or remove it, and release again.` };
  }
  const wrong = checkAnnouncement(json, id, repo);
  return wrong ? { error: `${wrong} Fix it, or remove it, and release again.` } : { file };
}

/**
 * The release zip's name: its name without spaces, then its version (DeveloperHerald-0.5.3.zip). GitHub stores an
 * asset's space as a dot, so a name with one would no longer match SHA256SUMS.txt, and Manor looks for it this way.
 */
export const zipName = (name: string, version: string) => `${name.replaceAll(' ', '')}-${version}.zip`;

/** SHA256SUMS.txt's text: a line per file, "<sha256>  <name>", as sha256sum writes it. */
export const sumsText = (files: { name: string; hash: string }[]) => files.map((f) => `${f.hash}  ${f.name}\n`).join('');

const isTest = (f: string) => /\.(test|spec)\.[cm]?[jt]s$/.test(f);

/** Picks the release's files from a repo's (paths relative to its root, either slash). */
export function pickReleaseFiles(files: string[]): string[] {
  return files
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => (RELEASE_FILES.includes(f) || RELEASE_FOLDERS.some((d) => f.startsWith(`${d}/`))) && !isTest(f))
    .sort();
}

/** The files under a repo's root that a release could carry: its top-level files, everything in RELEASE_FOLDERS, and the folders of RELEASE_FILES. */
export function repoFiles(dir: string, rel = ''): string[] {
  const files: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (rel || RELEASE_FOLDERS.includes(e.name) || RELEASE_FILES.some((f) => f.startsWith(`${r}/`))) files.push(...repoFiles(dir, r));
    } else if (e.isFile()) files.push(r);
  }
  return files;
}

/** package.json's version, and +dev.<commit> when the tree has uncommitted changes. */
export const releaseVersion = (version: string, commit: string, dirty: boolean) => (dirty ? `${version}+dev.${commit}` : version);

/** owner/name from a GitHub remote URL (https or ssh), or null. */
export function repoFromUrl(url: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

/** origin's GitHub repository (owner/name), or null when there's no origin or it isn't GitHub. */
function originRepo(): string | null {
  try {
    return repoFromUrl(git('remote', 'get-url', 'origin'));
  } catch {
    return null;
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

interface Built {
  release: Release;
  zip: string;
  sums: string;
  /** manor-agent.json beside the zip, when the checkout announces the agent. */
  announcement: string | null;
}

/** Stages the release in a temporary folder, zips it, and writes its SHA256SUMS.txt (manor-agent.json's line too, when there is one). */
function build(): Built {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== APP.version) throw new Error(`package.json says ${pkg.version} but src/app.ts says ${APP.version}; make them agree first.`);
  const kit = kitOf(root);
  if ('error' in kit) throw new Error(kit.error);
  const announced = announcementOf(root, APP.id, originRepo());
  if (announced && 'error' in announced) throw new Error(announced.error);
  const commit = git('rev-parse', '--short', 'HEAD');
  // Dirty means what goes into the zip isn't the commit's: a change or a new file there (src\kit\ is
  // git-ignored, and kit.json says what it is). Other untracked things in the checkout (a .claude folder,
  // scratch files) don't count. manor-agent.json, published beside the zip, does.
  const dirty = git('status', '--porcelain', '--untracked-files=all', '--', ...RELEASE_FOLDERS, ...RELEASE_FILES, ANNOUNCEMENT) !== '';
  const release: Release = { id: APP.id, name: APP.name, version: releaseVersion(pkg.version, commit, dirty), commit, dirty, built: new Date().toISOString(), kit: kit.kit };

  const stage = mkdtempSync(path.join(os.tmpdir(), `${APP.id}-release-`));
  try {
    const files = pickReleaseFiles(repoFiles(root));
    for (const f of files) {
      mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
      cpSync(path.join(root, f), path.join(stage, f));
    }
    writeFileSync(path.join(stage, 'release.json'), JSON.stringify(release, null, 2) + '\n');

    const outDir = path.join(root, 'artifacts', APP.id);
    mkdirSync(outDir, { recursive: true });
    const prefix = zipName(APP.name, '');
    for (const f of readdirSync(outDir)) if (f.startsWith(prefix) && f.endsWith('.zip')) rmSync(path.join(outDir, f));
    const name = zipName(APP.name, release.version);
    const zip = path.join(outDir, name);
    execFileSync(TAR, ['-a', '-c', '-f', zip, '-C', stage, ...readdirSync(stage).sort()], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
    const announcement = path.join(outDir, ANNOUNCEMENT);
    rmSync(announcement, { force: true });
    if (announced) cpSync(announced.file, announcement);
    const sums = path.join(outDir, 'SHA256SUMS.txt');
    const hash = sha256(zip);
    const listed = [{ name, hash }, ...(announced ? [{ name: ANNOUNCEMENT, hash: sha256(announcement) }] : [])];
    writeFileSync(sums, sumsText(listed));
    console.log(`${APP.name} ${release.version} (${commit}${dirty ? ', with uncommitted changes' : ''}, kit ${kit.kit}): ${path.relative(root, zip)}, ${files.length + 1} files, ${Math.ceil(statSync(zip).size / 1024)} KB`);
    console.log(`  sha256 ${hash} (${path.relative(root, sums)})`);
    if (announced) console.log(`  ${ANNOUNCEMENT}, announcing ${APP.name} to every Manor: sha256 ${listed[1].hash}`);
    return { release, zip, sums, announcement: announced ? announcement : null };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Unpacks the zip to a temporary folder and runs the release's own installer from there. */
function installRelease(zip: string, args: string[]): number {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${APP.id}-install-`));
  try {
    execFileSync(TAR, ['-x', '-f', zip, '-C', dir], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
    const r = spawnSync(process.execPath, [path.join(dir, 'src', 'cli.ts'), 'install', ...args], { stdio: 'inherit', cwd: root });
    return r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ghExe(): string {
  if (spawnSync('gh', ['--version'], { windowsHide: true }).status === 0) return 'gh';
  return 'C:\\tools\\gh\\bin\\gh.exe';
}

/** Makes the GitHub release v<version> from a clean, pushed HEAD, with the zip and SHA256SUMS.txt (and manor-agent.json, when there is one). */
function publish(b: Built): number {
  const { release } = b;
  const tag = `v${release.version}`;
  if (release.dirty) {
    console.error('Not published: the tree has uncommitted changes. Commit them, push, and release again.');
    return 1;
  }
  if (git('rev-list', '--count', 'HEAD', '--not', '--remotes=origin') !== '0') {
    console.error(`Not published: ${release.commit} isn't on origin yet. Push it first.`);
    return 1;
  }
  const repo = originRepo();
  if (!repo) {
    console.error("Not published: origin isn't a GitHub repository.");
    return 1;
  }
  const gh = ghExe();
  const view = spawnSync(gh, ['release', 'view', tag, '--repo', repo], { encoding: 'utf8', windowsHide: true });
  if (view.status === 0) {
    console.error(`Not published: ${repo} already has ${tag}. Raise the version in package.json and src/app.ts first.`);
    return 1;
  }
  if (!/not found/i.test(`${view.stderr}`)) {
    console.error(`Not published: couldn't ask GitHub about ${tag}: ${`${view.stderr}`.trim() || view.error?.message}`);
    return 1;
  }
  const notes = `${APP.name} ${release.version}, built from ${release.commit}, with the Steward's kit ${release.kit}. Unpack the zip anywhere and run: node src\\cli.ts install (Node 22.18 or later).`;
  const r = spawnSync(gh, ['release', 'create', tag, b.zip, b.sums, ...(b.announcement ? [b.announcement] : []), '--repo', repo, '--target', git('rev-parse', 'HEAD'), '--title', `${APP.name} ${release.version}`, '--notes', notes], {
    stdio: 'inherit',
    windowsHide: true,
  });
  return r.status ?? 1;
}

function main(args: string[]): number {
  const known = ['--install', '--publish', '--no-start', '--dry-run'];
  const unknown = args.filter((a) => !known.includes(a));
  if (unknown.length) {
    console.error(`release: unknown ${unknown.join(' ')}\nUsage: npm run release [-- --install [--no-start] [--dry-run]] [-- --publish]`);
    return 2;
  }
  let built: Built;
  try {
    built = build();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (args.includes('--publish')) {
    const code = publish(built);
    if (code !== 0) return code;
  }
  if (args.includes('--install')) return installRelease(built.zip, args.filter((a) => a === '--no-start' || a === '--dry-run'));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
