import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitExe } from '../../src/kit/git-exe.ts';
import { PIPELINE_FILE } from '../../src/repoconfig.ts';

/**
 * The sample repositories of samples/pipelines (hello, world on each stack, each with a .steward.json: docs/PIPELINE.md),
 * spun up as clones the Steward can look after and Reeve can find: each one a git repository on its branch main, with
 * one commit, and the origin its pipeline wants. Nothing is asked of any host: every origin is a folder on this PC.
 */

export const SAMPLES = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'samples', 'pipelines');

/** The address the fake GitLab's clones have as their origin; git's insteadOf sends each fetch and push to a folder. */
export const FAKE_GITLAB = 'https://gitlab.example.test/samples/';

/**
 * Each sample's origin: a bare repository of its own beside them (in .origins), the fake GitLab's address (whose pushes
 * go to one), or none at all (a repository on this PC alone). Any not named here has one of its own.
 */
export const ORIGINS: Record<string, 'gitlab' | 'none'> = { 'local-only': 'none', 'gitlab-hello': 'gitlab' };

export interface Spun {
  name: string;
  dir: string;
  /** Its origin's address, as its clone has it; null for one with none. */
  origin: string | null;
  /** Why it was left as it is: there already. */
  left?: string;
}

/** The sample folders, by name. */
export const sampleNames = (from = SAMPLES) => readdirSync(from).filter((n) => statSync(path.join(from, n)).isDirectory()).sort();

/**
 * Every sample (or `only` these) spun up in `target`: copied, its .steward.json's @SAMPLES@ made `target` (the folder its
 * releases go to), committed, and given its origin. One there already is left as it is, never written over.
 */
export function spinUp(target: string, o: { from?: string; only?: string[]; git?: string } = {}): Spun[] {
  const from = o.from ?? SAMPLES;
  const git = (cwd: string, ...args: string[]) => execFileSync(o.git ?? gitExe(), args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const root = path.resolve(target);
  const origins = path.join(root, '.origins');
  mkdirSync(root, { recursive: true });
  const out: Spun[] = [];
  for (const name of sampleNames(from).filter((n) => !o.only || o.only.includes(n))) {
    const dir = path.join(root, name);
    if (existsSync(dir)) {
      out.push({ name, dir, origin: null, left: `${dir} is there already: left as it is` });
      continue;
    }
    cpSync(path.join(from, name), dir, { recursive: true });
    const file = path.join(dir, PIPELINE_FILE);
    if (existsSync(file)) writeFileSync(file, readFileSync(file, 'utf8').replaceAll('@SAMPLES@', JSON.stringify(root).slice(1, -1)));
    git(dir, 'init', '--quiet', '--initial-branch=main');
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '--message', `${name}: hello, world`);
    const kind = ORIGINS[name];
    if (kind === 'none') {
      out.push({ name, dir, origin: null });
      continue;
    }
    const bare = path.join(origins, `${name}.git`);
    if (!existsSync(bare)) {
      mkdirSync(origins, { recursive: true });
      git(origins, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
    }
    const origin = kind === 'gitlab' ? `${FAKE_GITLAB}${name}.git` : bare;
    git(dir, 'remote', 'add', 'origin', origin);
    // The fake GitLab: its address is GitLab's, and git fetches from and pushes to the folder in its place.
    if (kind === 'gitlab') git(dir, 'config', `url.${origins.replaceAll('\\', '/')}/.insteadOf`, FAKE_GITLAB);
    git(dir, 'push', '--quiet', '--set-upstream', 'origin', 'main');
    out.push({ name, dir, origin });
  }
  return out;
}
