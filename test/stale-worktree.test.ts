import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { realOf, removeWorktree, worktrees } from '../src/git.ts';
import { run } from '../src/run.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { freshWorktree } from '../src/stages/common.ts';
import { fakeEmployee, sh } from './helpers.ts';

// On 2026-10-13 git refused the Steward's kit trial and Reeve's release: "is a missing but already registered worktree".
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-stale-wt-'));
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
