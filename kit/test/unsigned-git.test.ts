import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { unsignedGit, unsignedGitVars } from '../node/unsigned-git.ts';

const OFF = { GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'tag.gpgsign', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'maintenance.auto', GIT_CONFIG_VALUE_2: 'false' };

test('commit.gpgsign, tag.gpgsign and maintenance.auto false, after the settings already in the environment, and only once', () => {
  assert.deepEqual(unsignedGitVars({ PATH: 'x' }), { ...OFF, GIT_CONFIG_COUNT: '3' });
  const env = unsignedGit({ PATH: 'x' } as Record<string, string | undefined>);
  assert.deepEqual(unsignedGitVars(env), {}, 'an environment that has them gets nothing more');
  assert.deepEqual(unsignedGit({ ...env }), env);

  const theirs = unsignedGit({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' } as Record<string, string | undefined>);
  assert.equal(theirs.GIT_CONFIG_COUNT, '4');
  assert.deepEqual([theirs.GIT_CONFIG_KEY_0, theirs.GIT_CONFIG_KEY_1, theirs.GIT_CONFIG_KEY_2, theirs.GIT_CONFIG_KEY_3], ['core.autocrlf', 'commit.gpgsign', 'tag.gpgsign', 'maintenance.auto'], "the environment's own setting kept");
  // One already turned off is left; the others are added after it.
  assert.deepEqual(unsignedGitVars({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' }), {
    GIT_CONFIG_KEY_1: 'tag.gpgsign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'maintenance.auto',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_COUNT: '3',
  });
});

test('git reads them: a commit signs nothing and starts no upkeep however git is set up, and the repository says so', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'unsigned-git-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (env: NodeJS.ProcessEnv, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true, env }).trim();
  const plain: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(plain)) if (k.startsWith('GIT_CONFIG_')) delete plain[k];
  git(plain, 'init', '-q');
  // Signing on, with a key that isn't there: a signed commit would fail.
  git(plain, 'config', 'commit.gpgsign', 'true');
  git(plain, 'config', 'gpg.format', 'ssh');
  git(plain, 'config', 'user.signingkey', path.join(dir, 'no-such-key.pub'));
  git(plain, 'config', 'maintenance.auto', 'true');
  const env = unsignedGit({ ...plain });
  assert.equal(git(env, 'config', '--get', 'commit.gpgsign'), 'false');
  assert.equal(git(env, 'config', '--get', 'maintenance.auto'), 'false');
  git(env, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'unsigned');
  assert.equal(git(env, 'log', '-1', '--format=%s'), 'unsigned');
  assert.equal(git(plain, 'config', '--get', 'commit.gpgsign'), 'true', "the repository's own setting is untouched");
  assert.equal(git(plain, 'config', '--get', 'maintenance.auto'), 'true');
});
