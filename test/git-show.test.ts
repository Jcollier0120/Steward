import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { hasObject, readBatch, showFile } from '../src/git.ts';
import { run, type Runner } from '../src/run.ts';
import { gitExe } from '../src/kit/git-exe.ts';

// Files read at a commit together, one `git cat-file --batch` for the reads asked of a repository at once (Steward 0.35.47).
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-show-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const g = (cwd: string, ...args: string[]) => execFileSync(gitExe(), args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const repo = path.join(home, 'repo');
execFileSync(gitExe(), ['init', '-q', '-b', 'main', repo], { windowsHide: true });
g(repo, 'config', 'user.email', 't@example.test');
g(repo, 'config', 'user.name', 't');
g(repo, 'config', 'core.autocrlf', 'false');
const FILES: Record<string, string | Buffer> = {
  'package.json': '{\n  "version": "1.2.3"\n}\n',
  'src/app.ts': "export const APP = { version: '1.2.3' };\n",
  'CHANGELOG.md': '## 1.2.3\n\n**Café, naïve — “quoted” 🎉**\n',
  'bom.json': '﻿{"kit":"2.64.0"}\n',
  'crlf.txt': 'one\r\ntwo\r\n',
  'no-newline.txt': 'last line',
  'empty.txt': '',
  'with space.txt': 'spaced\n',
  'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
};
for (const [f, text] of Object.entries(FILES)) {
  mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  writeFileSync(path.join(repo, f), text);
}
g(repo, 'add', '-A');
g(repo, 'commit', '-q', '-m', 'one');
writeFileSync(path.join(repo, 'package.json'), '{\n  "version": "1.2.4"\n}\n');
g(repo, 'commit', '-q', '-am', 'two');

/** The real runner, noting each git command's first word. */
function counting() {
  const ran: string[] = [];
  const runner: Runner = (cmd, args, opts) => (ran.push(args[0]), run(cmd, args, opts));
  return { runner, ran };
}

const shown = (spec: string) => {
  try {
    return execFileSync(gitExe(), ['show', spec], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

test('reads asked at once are one cat-file, and say exactly what git show says, one by one', async () => {
  const text = Object.keys(FILES).filter((f) => f !== 'latin1.txt');
  const asks: [string, string][] = [...text.map((f) => ['main', f] as [string, string]), ['main~1', 'package.json'], ['main', 'nowhere.txt'], ['no-such-branch', 'package.json'], ['main', 'package.json'], ['main', 'src\\app.ts']];
  const { runner, ran } = counting();
  const got = await Promise.all(asks.map(([ref, f]) => showFile(runner, repo, ref, f)));
  assert.deepEqual(got, asks.map(([ref, f]) => shown(`${ref}:${f.replace(/\\/g, '/')}`)));
  assert.equal(got[0], '{\n  "version": "1.2.4"\n}\n', 'the newer commit');
  assert.equal(got[text.length], '{\n  "version": "1.2.3"\n}\n', 'an older commit');
  assert.deepEqual(ran, ['cat-file'], 'one command for them all');
});

test("a folder, or a file that isn't UTF-8: the reads before it from the batch, it and the rest from git show", async () => {
  const asks: [string, string][] = [['main', 'package.json'], ['main', 'CHANGELOG.md'], ['main', 'latin1.txt'], ['main', 'src/app.ts'], ['main', 'src'], ['main', 'bom.json']];
  const { runner, ran } = counting();
  const got = await Promise.all(asks.map(([ref, f]) => showFile(runner, repo, ref, f)));
  assert.deepEqual(got, asks.map(([ref, f]) => shown(`${ref}:${f}`)));
  assert.deepEqual(ran.sort(), ['cat-file', 'show', 'show', 'show', 'show']);
});

test('a read alone is a git show, as before; reads of different repositories are their own', async () => {
  const other = path.join(home, 'other');
  g(home, 'clone', '-q', repo, other);
  const { runner, ran } = counting();
  assert.equal(await showFile(runner, repo, 'main', 'src/app.ts'), FILES['src/app.ts']);
  assert.deepEqual(ran, ['show']);
  ran.length = 0;
  const [a, b] = await Promise.all([showFile(runner, repo, 'main', 'src/app.ts'), showFile(runner, other, 'origin/main', 'src/app.ts')]);
  assert.deepEqual([a, b], [FILES['src/app.ts'], FILES['src/app.ts']]);
  assert.deepEqual(ran, ['show', 'show']);
});

test("a batch that fails or isn't understood: each read is asked again on its own", async () => {
  for (const answer of [{ code: 1, out: '', err: 'no' }, { code: 0, out: 'garbled', err: '' }]) {
    const ran: string[] = [];
    const runner: Runner = async (cmd, args, opts) => (ran.push(args[0]), args[0] === 'cat-file' ? answer : run(cmd, args, opts));
    const got = await Promise.all([showFile(runner, repo, 'main', 'src/app.ts'), showFile(runner, repo, 'main', 'nowhere')]);
    assert.deepEqual(got, [FILES['src/app.ts'], null]);
    assert.deepEqual(ran.sort(), ['cat-file', 'show', 'show']);
  }
  const throwing: Runner = async (cmd, args, opts) => {
    if (args[0] === 'cat-file') throw new Error('gone');
    return run(cmd, args, opts);
  };
  assert.deepEqual(await Promise.all([showFile(throwing, repo, 'main', 'src/app.ts'), showFile(throwing, repo, 'main', 'empty.txt')]), [FILES['src/app.ts'], '']);
});

test("cat-file's answers read: found, missing, ambiguous, sizes in bytes; from anything it can't count, git show's", () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(readBatch(`${sha} blob 3\nhé\nx:y missing\nab ambiguous\n${sha} blob 0\n\n`, 4), ['hé', null, undefined, '']);
  assert.deepEqual(readBatch(`${sha} blob 3\nhé\n${sha} tree 2\nzz\n${sha} blob 1\nx\n`, 3), ['hé', undefined, undefined], 'a tree, and all after it');
  assert.deepEqual(readBatch(`${sha} blob 3\n�\n${sha} blob 1\nx\n`, 2), [undefined, undefined], "text that wasn't UTF-8");
  assert.deepEqual(readBatch(`${sha} blob 3\nhé\n`, 2), ['hé', undefined], 'fewer answers');
  assert.deepEqual(readBatch(`${sha} blob 9\nhé\n`, 1), [undefined], 'short');
  assert.deepEqual(readBatch('garbled', 2), [undefined, undefined]);
  assert.equal(readBatch(`${sha} blob 3\nhé\nextra`, 1), null, 'more output than asked');
});

test("the scratch repository's commits are read from its files too (bare)", () => {
  const bare = path.join(home, 'bare.git');
  g(home, 'clone', '-q', '--bare', repo, bare);
  const head = g(repo, 'rev-parse', 'main');
  assert.equal(hasObject(bare, head), true);
  assert.equal(hasObject(bare, 'b'.repeat(40)), false);
});
