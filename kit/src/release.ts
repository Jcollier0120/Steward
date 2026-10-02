#!/usr/bin/env node
/**
 * Builds this agent's release, as every Node agent of Manor's does (Manor's docs/INSTALLING.md, "Releases"):
 *
 *   npm run release                  artifacts\<id>\<Name>-<version>.zip and artifacts\<id>\SHA256SUMS.txt
 *   npm run release -- --install     builds it, then installs it on this PC (node <unpacked>\src\cli.ts install)
 *   npm run release -- --publish     builds it, then makes the GitHub release v<version> with both files
 *
 * The zip holds what the agent runs from, at its top level: src\ (no tests), art\, package.json,
 * README.md and release.json. This tool isn't in it. The zip is made and opened with Windows' own
 * tar.exe, so there's no dependency. Uncommitted changes in what the zip carries make a release
 * marked dirty, version <version>+dev.<commit>, which installs but doesn't publish.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP } from '../app.ts';
import type { Release } from './install.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** The folders a release carries whole, tests aside (src\ holds the PowerShell scripts an agent runs, too). */
export const RELEASE_FOLDERS = ['src', 'art'];
/** The top-level files a release carries, when the repo has them. */
export const RELEASE_FILES = ['package.json', 'README.md', 'LICENSE'];

const isTest = (f: string) => /\.(test|spec)\.[cm]?[jt]s$/.test(f);

/** Picks the release's files from a repo's (paths relative to its root, either slash). */
export function pickReleaseFiles(files: string[]): string[] {
  return files
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => (RELEASE_FILES.includes(f) || RELEASE_FOLDERS.some((d) => f.startsWith(`${d}/`))) && !isTest(f))
    .sort();
}

/** The files under a repo's root that a release could carry: its top-level files, and everything in RELEASE_FOLDERS. */
export function repoFiles(dir: string, rel = ''): string[] {
  const files: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (rel || RELEASE_FOLDERS.includes(e.name)) files.push(...repoFiles(dir, r));
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

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Stages the release in a temporary folder, zips it, and writes its SHA256SUMS.txt. */
function build(): { release: Release; zip: string; sums: string } {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== APP.version) throw new Error(`package.json says ${pkg.version} but src/app.ts says ${APP.version}; make them agree first.`);
  const commit = git('rev-parse', '--short', 'HEAD');
  // Dirty means what goes into the zip isn't the commit's: a change or a new file there. Other untracked
  // things in the checkout (a .claude folder, scratch files) don't count.
  const dirty = git('status', '--porcelain', '--untracked-files=all', '--', ...RELEASE_FOLDERS, ...RELEASE_FILES) !== '';
  const release: Release = { id: APP.id, name: APP.name, version: releaseVersion(pkg.version, commit, dirty), commit, dirty, built: new Date().toISOString() };

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
    for (const f of readdirSync(outDir)) if (f.startsWith(`${APP.name}-`) && f.endsWith('.zip')) rmSync(path.join(outDir, f));
    const name = `${APP.name}-${release.version}.zip`;
    const zip = path.join(outDir, name);
    execFileSync(TAR, ['-a', '-c', '-f', zip, '-C', stage, ...readdirSync(stage).sort()], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
    const sums = path.join(outDir, 'SHA256SUMS.txt');
    const hash = sha256(zip);
    writeFileSync(sums, `${hash}  ${name}\n`);
    console.log(`${APP.name} ${release.version} (${commit}${dirty ? ', with uncommitted changes' : ''}): ${path.relative(root, zip)}, ${files.length + 1} files, ${Math.ceil(statSync(zip).size / 1024)} KB`);
    console.log(`  sha256 ${hash} (${path.relative(root, sums)})`);
    return { release, zip, sums };
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

/** Makes the GitHub release v<version> from a clean, pushed HEAD, with the zip and SHA256SUMS.txt. */
function publish(b: { release: Release; zip: string; sums: string }): number {
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
  const repo = repoFromUrl(git('remote', 'get-url', 'origin'));
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
  const notes = `${APP.name} ${release.version}, built from ${release.commit}. Unpack the zip anywhere and run: node src\\cli.ts install (Node 22.18 or later).`;
  const r = spawnSync(gh, ['release', 'create', tag, b.zip, b.sums, '--repo', repo, '--target', git('rev-parse', 'HEAD'), '--title', `${APP.name} ${release.version}`, '--notes', notes], {
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
  let built: ReturnType<typeof build>;
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
