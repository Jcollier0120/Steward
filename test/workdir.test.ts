import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { clearWorkDir } from '../src/stages/common.ts';

// A work folder Settings point at the person's own projects: the Steward clears only the worktrees it made there.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-workdir-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("clearWorkDir removes only a worktree in the work folder, never a clone of someone's own or a folder outside", () => {
  const s = { ...DEFAULT_SETTINGS, workRoot: tmp };
  const dir = (name: string, git: 'file' | 'folder' | null) => {
    const d = path.join(tmp, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'work.txt'), 'mine');
    if (git === 'file') writeFileSync(path.join(d, '.git'), 'gitdir: C:/somewhere/.git/worktrees/x');
    if (git === 'folder') mkdirSync(path.join(d, '.git'));
    return d;
  };
  const worktree = dir('porter', 'file');
  clearWorkDir(s, worktree);
  assert.equal(existsSync(worktree), false, "the Steward's worktree goes");

  const clone = dir('manor', 'folder');
  clearWorkDir(s, clone);
  assert.ok(existsSync(path.join(clone, 'work.txt')), 'a clone stays');

  const plain = dir('notes', null);
  clearWorkDir(s, plain);
  assert.ok(existsSync(path.join(plain, 'work.txt')), "a folder that isn't a worktree stays, outside the Steward's own work folder");

  const deeper = dir(path.join('a', 'b'), 'file');
  clearWorkDir(s, deeper);
  assert.ok(existsSync(deeper), 'only a folder in the work folder itself');
});
