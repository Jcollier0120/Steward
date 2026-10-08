#!/usr/bin/env node
/**
 * Builds the kit's release, from the kit as committed:
 *
 *   npm run kit-release                artifacts\kit\kit-<version>.zip and artifacts\kit\SHA256SUMS.txt
 *   npm run kit-release -- --publish   builds it, then makes the GitHub release kit-v<version> with both files
 *
 * The zip holds VERSION, CHANGELOG.md, LICENSE (the kit's MIT license) and the parts (node\, web\, spec\, core\ and
 * dotnet\), as kit\ has them at HEAD (git archive), never the kit's tests. Every agent's tools/kit.ts downloads it, checks
 * it against SHA256SUMS.txt, and fills its src\kit\ with the parts its kit.json names, and LICENSE beside VERSION. The Steward's own releases
 * (v<version>, src/kit/release.ts) are separate: a kit release needs no Steward release.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogBetween, KIT_META, kitVersionOf, PARTS } from '../src/kitfiles.ts';
import { repoFromUrl } from '../src/kit/release.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const kitDir = path.join(root, 'kit');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

/**
 * The kit's parts: the four a Node agent places (src/kitfiles.ts's PARTS: react since 2.21.0), and, from kit 2.0.0, the core,
 * which the node and dotnet parts run, and dotnet, the C# driver (Heiward's). tools/kit.ts fills any of them.
 */
export const KIT_PARTS = [...PARTS, 'core', 'dotnet'];

/** What the zip carries, as paths in the kit tree. */
export const KIT_RELEASE_PATHS = [...KIT_META, ...KIT_PARTS];

/** The changelog's entry for a version, or null when it has none. */
export const entryFor = (changelog: string, version: string) => changelogBetween(changelog, null, version).split(/\n(?=## )/)[0].trim() || null;

function build(): { version: string; zip: string; sums: string; notes: string } {
  const version = kitVersionOf(kitDir);
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('kit\\VERSION must hold one version, x.y.z');
  const notes = entryFor(readFileSync(path.join(kitDir, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes || !notes.startsWith(`## ${version}`)) throw new Error(`kit\\CHANGELOG.md has no "## ${version}" entry: write it first`);
  const dirty = git('status', '--porcelain', '--untracked-files=all', '--', ...KIT_RELEASE_PATHS.map((p) => `kit/${p}`));
  if (dirty) throw new Error(`the kit has uncommitted changes, which a kit release can't carry: commit them first\n${dirty}`);
  const outDir = path.join(root, 'artifacts', 'kit');
  mkdirSync(outDir, { recursive: true });
  const name = `kit-${version}.zip`;
  const zip = path.join(outDir, name);
  git('archive', '--format=zip', '-o', zip, 'HEAD:kit', ...KIT_RELEASE_PATHS);
  const hash = createHash('sha256').update(readFileSync(zip)).digest('hex');
  const sums = path.join(outDir, 'SHA256SUMS.txt');
  writeFileSync(sums, `${hash}  ${name}\n`);
  console.log(`The Steward's kit ${version} (${git('rev-parse', '--short', 'HEAD')}): ${path.relative(root, zip)}`);
  console.log(`  sha256 ${hash} (${path.relative(root, sums)})`);
  return { version, zip, sums, notes };
}

function ghExe(): string {
  return spawnSync('gh', ['--version'], { windowsHide: true }).status === 0 ? 'gh' : 'C:\\tools\\gh\\bin\\gh.exe';
}

/** The GitHub release kit-v<version>, from a pushed HEAD, with the zip and SHA256SUMS.txt; its notes are the changelog's entry. */
function publish(b: ReturnType<typeof build>): number {
  const tag = `kit-v${b.version}`;
  if (git('rev-list', '--count', 'HEAD', '--not', '--remotes=origin') !== '0') {
    console.error(`Not published: HEAD isn't on origin yet. Push it first.`);
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
    console.error(`Not published: ${repo} already has ${tag}. A kit version is released once; raise kit\\VERSION for a change.`);
    return 1;
  }
  if (!/not found/i.test(`${view.stderr}`)) {
    console.error(`Not published: couldn't ask GitHub about ${tag}: ${`${view.stderr}`.trim() || view.error?.message}`);
    return 1;
  }
  const r = spawnSync(gh, ['release', 'create', tag, b.zip, b.sums, '--repo', repo, '--target', git('rev-parse', 'HEAD'), '--title', `Kit ${b.version}`, '--notes', b.notes, '--latest=false'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  return r.status ?? 1;
}

function main(args: string[]): number {
  const unknown = args.filter((a) => a !== '--publish');
  if (unknown.length) {
    console.error(`kit-release: unknown ${unknown.join(' ')}\nUsage: npm run kit-release [-- --publish]`);
    return 2;
  }
  let built: ReturnType<typeof build>;
  try {
    built = build();
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  return args.includes('--publish') ? publish(built) : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
