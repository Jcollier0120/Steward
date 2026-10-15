import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// flushTree: every file under a folder written through to the disk before the folder is renamed into place.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-flush-'));
after(() => rmSync(home, { recursive: true, force: true }));

const { flushFile, flushTree } = await import('./fixture/src/kit/flush.ts');

function tree(name: string): string {
  const dir = path.join(home, name);
  mkdirSync(path.join(dir, 'src', 'kit'), { recursive: true });
  mkdirSync(path.join(dir, 'empty'), { recursive: true });
  writeFileSync(path.join(dir, 'release.json'), '{}');
  writeFileSync(path.join(dir, 'src', 'cli.ts'), '// cli\n');
  writeFileSync(path.join(dir, 'src', 'kit', 'store.js'), '// store\n');
  return dir;
}

test('every file in every folder under it is flushed, and counted', () => {
  const dir = tree('all');
  const seen: string[] = [];
  assert.deepEqual(flushTree(dir, { flush: (f) => seen.push(path.relative(dir, f)) }), { flushed: 3, failed: 0 });
  assert.deepEqual(seen.sort(), ['release.json', path.join('src', 'cli.ts'), path.join('src', 'kit', 'store.js')].sort());
});

test('a file that can\'t be flushed is counted and left; the rest are flushed all the same', () => {
  const dir = tree('one-refused');
  let flushed = 0;
  const done = flushTree(dir, {
    flush: (f) => {
      if (f.endsWith('cli.ts')) throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' });
      flushed++;
    },
  });
  assert.deepEqual(done, { flushed: 2, failed: 1 });
  assert.equal(flushed, 2);
});

test('a real flush leaves the files as they were', () => {
  const dir = tree('real');
  assert.deepEqual(flushTree(dir), { flushed: 3, failed: 0 });
  flushFile(path.join(dir, 'src', 'cli.ts'));
  assert.equal(readFileSync(path.join(dir, 'src', 'cli.ts'), 'utf8'), '// cli\n');
});
