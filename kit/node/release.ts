#!/usr/bin/env node
/**
 * Builds this agent's release, as every Node agent of Manor's does (Manor's docs/INSTALLING.md, "Releases"):
 *
 *   npm run release                  artifacts\<id>\<Name, no spaces>-<version>.zip and artifacts\<id>\SHA256SUMS.txt
 *   npm run release -- --install     builds it, then installs it on this PC (node <unpacked>\src\cli.ts install)
 *   npm run release -- --publish     builds it, then publishes it: <id>-v<version> in the public releases repository
 *                                    (Jcollier0120/Manor-releases), and v<version> in the agent's own as before
 *   npm run release -- --readable    builds it without minifying, to look into on this PC; it can't be published
 *
 * What a release carries is built, never the readable source (minify.ts, spec/RELEASES.md): each .ts file under
 * src\ minified to a .js beside it, src\cli.ts a stub that runs its .js, and the .js and .css minified. The
 * README stays out: it's for the repository. The public repository holds the releases alone, so any PC downloads
 * them with no sign-in; the agent's own repository keeps them too, while Manors that look there are about.
 *
 * An agent that announces itself to every Manor (Manor's src/announced.ts) has manor-agent.json at its root: its
 * entry as Manor's staff.json has it, and the roles it brings. The release copies it beside the zip, lists it in
 * SHA256SUMS.txt (Manor takes it only when it's listed there), and publishes it with the zip; and refuses to
 * build when it names another agent than this one. It names no repository: Manor finds every release in the public
 * releases repository by its id (<id>-v<version>), and a "release.repo" would publish the private repository's name
 * there. One still given must be origin's, until it's taken out.
 *
 * npm run release fills src\kit\ first (tools\kit.ts), at the version kit.json pins. The zip holds what
 * the agent runs from, at its top level: src\ (no tests) with src\kit\ in it, art\, package.json,
 * README.md and release.json, which names the kit; and kit.json and tools\kit.ts, so the copy can fill
 * its kit again (and the Steward, installed, has the tools\kit.ts it hands out). So an installed agent
 * needs neither the Steward nor GitHub.
 *
 * Its notes are the agent's CHANGELOG.md entry for the version (notes.ts, spec/RELEASE-NOTES.md): what's new, what
 * changed, and what to do before updating. A version with no entry is published with its commits instead, and the
 * build warns of it first. The zip is made and opened with Windows' own tar.exe, so there's
 * no dependency. Uncommitted changes in what the zip carries make a release marked dirty, version
 * <version>+dev.<commit>, which installs but doesn't publish.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP } from '../app.ts';
import type { Release } from './install.ts';
import { loadEsbuild, minifyRelease } from './minify.ts';
import { releaseNotes, type Notes } from './notes.ts';
import { PAGE_BUNDLE, PAGE_ENTRY, releasePage } from './react-page.ts';

/** The public repository every release of the manor's is published in, with no source: any PC downloads from it, signed in or not. */
export const RELEASES_REPO = 'Jcollier0120/Manor-releases';
/** An agent's release's tag there: its id and version (porter-v0.4.22), since every agent's releases share it. */
export const releaseTag = (id: string, version: string) => `${id}-v${version}`;

/** The agent's root: this file is its src\kit\release.ts. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** The folders a release carries whole, tests aside (src\ holds the PowerShell scripts an agent runs, too, and src\kit\). */
export const RELEASE_FOLDERS = ['src', 'art'];
/** The files a release carries, when the repo has them. */
export const RELEASE_FILES = ['package.json', 'LICENSE', 'kit.json', 'tools/kit.ts'];

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
 * installed at %USERPROFILE%\.<id>\app; and "roles", when given, a list of objects. "release.repo" is best left out (it
 * would be published); one given must be `repo`, origin's (owner/name).
 */
export function checkAnnouncement(json: unknown, id: string, repo: string | null): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return `${ANNOUNCEMENT} should be an object with an "agent".`;
  const j = json as Record<string, unknown>;
  const agent = j.agent as Record<string, unknown> | undefined;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return `${ANNOUNCEMENT} should give its "agent": its entry, as Manor's staff.json has one.`;
  if (agent.id !== id) return `${ANNOUNCEMENT}'s agent is ${JSON.stringify(agent.id ?? null)}, but this release is ${JSON.stringify(id)} (release.json's id).`;
  const release = agent.release as Record<string, unknown> | undefined;
  if (release?.repo !== undefined) {
    const named = typeof release.repo === 'string' ? release.repo : null;
    if (!repo || named?.toLowerCase() !== repo.toLowerCase())
      return `${ANNOUNCEMENT} names ${named ?? 'no repository'} as its "release.repo", but origin is ${repo ?? 'not on GitHub'}. Leave "release.repo" out: Manor finds the release in the releases repository by its id, and the name would be published there.`;
  }
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
  notes: Notes;
}

/** The notes' last section: how to install a hire's release by hand (Manor installs and updates it by itself). */
export const INSTALL_NOTE =
  'Manor installs and updates it by itself. To install it by hand, unpack the zip anywhere and run `node src\\cli.ts install` (Node 22.18 or later). `SHA256SUMS.txt` lists its SHA-256 (PowerShell: `Get-FileHash`).';

/** Stages the release in a temporary folder, builds it (unless `readable`), zips it, and writes its SHA256SUMS.txt (manor-agent.json's line too, when there is one). */
async function build(readable = false): Promise<Built> {
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
  const release: Release = { id: APP.id, name: APP.name, version: releaseVersion(pkg.version, commit, dirty), commit, dirty, built: new Date().toISOString(), kit: kit.kit, form: readable ? 'readable' : 'minified' };
  const esbuild = readable ? null : await loadEsbuild(root);
  if (esbuild && 'error' in esbuild) throw new Error(esbuild.error);

  const stage = mkdtempSync(path.join(os.tmpdir(), `${APP.id}-release-`));
  try {
    const files = pickReleaseFiles(repoFiles(root));
    for (const f of files) {
      mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
      cpSync(path.join(root, f), path.join(stage, f));
    }
    writeFileSync(path.join(stage, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    // A React page (react-page.ts) is bundled first, readable or not: the browser can't run its .tsx.
    const pageEsbuild = existsSync(path.join(stage, PAGE_ENTRY)) ? (esbuild ?? (await loadEsbuild(root))) : null;
    if (pageEsbuild && 'error' in pageEsbuild) throw new Error(pageEsbuild.error);
    const page = pageEsbuild ? await releasePage(stage, root, pageEsbuild, readable) : null;
    const minified = esbuild ? await minifyRelease(stage, esbuild) : null;

    const outDir = path.join(root, 'artifacts', APP.id);
    mkdirSync(outDir, { recursive: true });
    // Every earlier build's zip goes ("Steward-0.8.20.zip"): the name without its version and ".zip".
    const prefix = zipName(APP.name, '').replace(/\.zip$/, '');
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
    if (minified) console.log(`  built with esbuild ${esbuild!.version}: ${minified.ts} TypeScript and ${minified.js} JavaScript files, ${Math.ceil(minified.before / 1024)} KB of code to ${Math.ceil(minified.after / 1024)} KB`);
    else console.log('  readable: not built, so it can be looked into here; it is never published');
    if (page) console.log(`  its page, drawn in the browser: ${PAGE_BUNDLE}, ${page.kb} KB with React`);
    if (announced) console.log(`  ${ANNOUNCEMENT}, announcing ${APP.name} to every Manor: sha256 ${listed[1].hash}`);
    const notes = releaseNotes({ root, name: APP.name, version: pkg.version, commit, kit: kit.kit, install: INSTALL_NOTE });
    console.log(`  notes: ${notes.from === 'changelog' ? `CHANGELOG.md's entry for ${pkg.version}` : 'the commits since the release before'}`);
    for (const w of notes.warnings) console.warn(`  warning: ${w}`);
    return { release, zip, sums, announcement: announced ? announcement : null, notes };
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

/** gh release view: 'there', 'none', or why GitHub couldn't be asked. */
function released(gh: string, tag: string, repo: string): 'there' | 'none' | { error: string } {
  const view = spawnSync(gh, ['release', 'view', tag, '--repo', repo], { encoding: 'utf8', windowsHide: true });
  if (view.status === 0) return 'there';
  if (/not found/i.test(`${view.stderr}`)) return 'none';
  return { error: `${view.stderr}`.trim() || view.error?.message || `gh exited ${view.status}` };
}

/**
 * Publishes a built release from a clean, pushed HEAD, with the zip and SHA256SUMS.txt (and manor-agent.json, when
 * there is one): as <id>-v<version> in RELEASES_REPO, where every Manor looks, and as v<version> in the agent's own
 * repository, where a Manor from before the releases repository looks. Refused when RELEASES_REPO has it already;
 * one already in the agent's own (a version released before the releases repository) is published there alone.
 */
function publish(b: Built): number {
  const { release } = b;
  const tag = releaseTag(release.id, release.version);
  const ownTag = `v${release.version}`;
  if (release.form !== 'minified') {
    console.error('Not published: a readable release stays on this PC. Release again without --readable.');
    return 1;
  }
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
  const there = released(gh, tag, RELEASES_REPO);
  if (there === 'there') {
    console.error(`Not published: ${RELEASES_REPO} already has ${tag}. Raise the version in package.json and src/app.ts first.`);
    return 1;
  }
  if (typeof there === 'object') {
    console.error(`Not published: couldn't ask GitHub about ${tag} in ${RELEASES_REPO}: ${there.error}`);
    return 1;
  }
  const own = released(gh, ownTag, repo);
  if (typeof own === 'object') {
    console.error(`Not published: couldn't ask GitHub about ${ownTag} in ${repo}: ${own.error}`);
    return 1;
  }
  const assets = [b.zip, b.sums, ...(b.announcement ? [b.announcement] : [])];
  // The notes go in a file: a double quote inside an argument can reach gh split on Windows, and an entry has them.
  const notesDir = mkdtempSync(path.join(os.tmpdir(), `${APP.id}-notes-`));
  const notesFile = path.join(notesDir, 'notes.md');
  writeFileSync(notesFile, b.notes.notes);
  try {
    // The releases repository holds no source, so its tag points at its own default branch: the commit is in the notes and release.json.
    const pub = spawnSync(gh, ['release', 'create', tag, ...assets, '--repo', RELEASES_REPO, '--title', `${APP.name} ${release.version}`, '--notes-file', notesFile], { stdio: 'inherit', windowsHide: true });
    if (pub.status !== 0) return pub.status ?? 1;
    if (own === 'there') {
      console.log(`${repo} has ${ownTag} already (released before the releases repository): published in ${RELEASES_REPO} alone.`);
      return 0;
    }
    const r = spawnSync(gh, ['release', 'create', ownTag, ...assets, '--repo', repo, '--target', git('rev-parse', 'HEAD'), '--title', `${APP.name} ${release.version}`, '--notes-file', notesFile], {
      stdio: 'inherit',
      windowsHide: true,
    });
    return r.status ?? 1;
  } finally {
    rmSync(notesDir, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<number> {
  const known = ['--install', '--publish', '--no-start', '--dry-run', '--readable'];
  const unknown = args.filter((a) => !known.includes(a));
  if (unknown.length) {
    console.error(`release: unknown ${unknown.join(' ')}\nUsage: npm run release [-- --install [--no-start] [--dry-run]] [-- --publish] [-- --readable]`);
    return 2;
  }
  if (args.includes('--readable') && args.includes('--publish')) {
    console.error('release: a readable release is never published: give --readable or --publish, not both');
    return 2;
  }
  let built: Built;
  try {
    built = await build(args.includes('--readable'));
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
