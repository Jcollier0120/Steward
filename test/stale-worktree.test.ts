import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { realOf, removeWorktree, worktrees } from '../src/git.ts';
import { projectsFrom } from '../src/kit/manor.ts';
import { run } from '../src/run.ts';
import { DEFAULT_SETTINGS, type Employee } from '../src/settings.ts';
import { freshWorktree, releaseDirOf, workRootOf } from '../src/stages/common.ts';
import { fakeEmployee, sh } from './helpers.ts';

// On 2026-10-13 git refused the Steward's kit trial and Reeve's release: "is a missing but already registered worktree".
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-stale-wt-'))); // its real path, as git spells it (a Dev Drive mounted in a folder)
after(() => rmSync(tmp, { recursive: true, force: true }));

const registered = async (repo: string, dir: string) => (await worktrees(run, repo)).some((w) => realOf(w.path).toLowerCase() === realOf(dir).toLowerCase());

test('a stage gets its worktree when the last one is gone but still registered with git', async () => {
  const { checkout } = fakeEmployee(path.join(tmp, 'gone'));
  const workRoot = path.join(tmp, 'gone', 'work');
  mkdirSync(workRoot);
  const s = { ...DEFAULT_SETTINGS, workRoot };
  const dir = path.join(workRoot, 'fake-release');
  sh(checkout, 'worktree', 'add', '--quiet', '--detach', dir, 'HEAD');
  rmSync(dir, { recursive: true, force: true });
  assert.ok(await registered(checkout, dir), 'git still has it');

  await freshWorktree(run, s, checkout, dir, 'HEAD', '--detach');
  assert.ok(existsSync(path.join(dir, 'package.json')), 'the worktree is there again');
});

test('a worktree a stage stopped half way left behind is cleared, and git forgets it, before the next is added', async () => {
  const { checkout } = fakeEmployee(path.join(tmp, 'left'));
  const workRoot = path.join(tmp, 'left', 'work');
  mkdirSync(workRoot);
  const s = { ...DEFAULT_SETTINGS, workRoot };
  const dir = path.join(workRoot, 'fake-trial');
  sh(checkout, 'worktree', 'add', '--quiet', '--no-track', '-b', 'steward/trial-kit-1.0.0', dir, 'HEAD');
  writeFileSync(path.join(dir, 'half-done.txt'), 'stopped by a sign-out');

  await freshWorktree(run, s, checkout, dir, 'HEAD', '--detach');
  assert.ok(existsSync(path.join(dir, 'package.json')));
  assert.equal(existsSync(path.join(dir, 'half-done.txt')), false, 'from scratch');
});

test('the work folder behind a junction: its worktrees are still found and removed, never left registered', async () => {
  const { checkout } = fakeEmployee(path.join(tmp, 'junction'));
  const real = path.join(tmp, 'junction', 'elsewhere');
  mkdirSync(real);
  // As ~\.steward\work became on the owner's PC: a junction to a folder on another drive. git records the real path.
  const workRoot = path.join(tmp, 'junction', 'work');
  symlinkSync(real, workRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const s = { ...DEFAULT_SETTINGS, workRoot };
  const dir = path.join(workRoot, 'fake-release');

  await freshWorktree(run, s, checkout, dir, 'HEAD', '--detach');
  assert.ok(await registered(checkout, dir));
  const did = await removeWorktree(run, checkout, dir);
  assert.deepEqual(did, [`removed the worktree ${dir}`], 'found through the junction');
  assert.equal(await registered(checkout, dir), false);
  assert.equal(existsSync(dir), false);

  // And made again, round after round.
  await freshWorktree(run, s, checkout, dir, 'HEAD', '--detach');
  await freshWorktree(run, s, checkout, dir, 'HEAD', '--detach');
  assert.ok(existsSync(path.join(dir, 'package.json')));
});

test('the work folder behind a junction is worked in at its real path, where a script run from it finds itself', () => {
  const real = path.join(tmp, 'mounted', 'drive');
  mkdirSync(real, { recursive: true });
  // As the owner's PC has it: ~\.steward\work a junction to a Dev Drive (C:\DevData is E:\).
  const workRoot = path.join(tmp, 'mounted', 'work');
  symlinkSync(real, workRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const s = { ...DEFAULT_SETTINGS, workRoot };
  assert.equal(workRootOf(s), realpathSync.native(workRoot));
  assert.equal(path.dirname(releaseDirOf(s, { id: 'fake' } as Employee)), realpathSync.native(workRoot));

  // Kit 2.69.1's release.ts starts only when it was run as itself: node gives import.meta.url its real path, and
  // argv[1] as given. Through the junction the two differ and it did nothing, exiting 0: every release, for a day.
  const guard = "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nif (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('ran');\n";
  writeFileSync(path.join(real, 'probe.mjs'), guard);
  const said = (dir: string) => execFileSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(said(workRootOf(s)), 'ran', 'at the real path, as the Steward runs it now');
  assert.equal(said(workRoot), '', 'through the junction: nothing, and no error');
});

test("Manor's projects: one clone named through a junction and by its real path is one checkout, and so is the Steward's", () => {
  const real = path.join(tmp, 'projects-drive');
  mkdirSync(path.join(real, 'App'), { recursive: true });
  mkdirSync(path.join(real, 'Steward'), { recursive: true });
  // As C:\Projects is D:\ on the owner's PC.
  const linked = path.join(tmp, 'Projects');
  symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const problems: string[] = [];
  const projects = projectsFrom(
    [
      { name: 'App', checkout: path.join(linked, 'App') },
      { name: 'App again', checkout: path.join(realpathSync.native(real), 'App') },
      { name: 'Steward', checkout: path.join(real, 'Steward') },
    ],
    { repos: [], checkouts: [path.join(linked, 'Steward')] },
    problems,
  );
  assert.deepEqual(projects.map((p) => p.name), ['App']);
  assert.match(problems[0], /"App again"\) has the checkout of one listed before it/);
  assert.match(problems[1], /"Steward"\) .*one of/);
});

test("no script of the Steward's or its kit's checks it was run as itself by its path's spelling (spec/DEV-DRIVES.md)", () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const bad: string[] = [];
  for (const top of ['src', 'tools', 'kit']) {
    for (const rel of readdirSync(path.join(root, top), { recursive: true }) as string[]) {
      // src\kit is filled from kit\, which is read here itself.
      if (!/\.(ts|mts|mjs|js)$/.test(rel) || rel.split(/[\\/]/).includes('node_modules') || (top === 'src' && /^kit[\\/]/.test(rel))) continue;
      const lines = readFileSync(path.join(root, top, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/process\.argv\[1\]/.test(line) && /import\.meta\.url/.test(line) && !/realpath/i.test(line)) bad.push(`${top}/${rel.replace(/\\/g, '/')}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(bad, [], 'compare realpathSync of both sides, or the script does nothing when started from a linked folder');
});
