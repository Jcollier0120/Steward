import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// writeJson: a rename Windows refuses for a moment is tried again; anything else is thrown, the temporary file gone.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-store-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
after(() => rmSync(home, { recursive: true, force: true }));

const { readJson, writeJson, RENAME_TRIES } = await import('./fixture/src/kit/store.ts');

const refused = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

test('a rename refused twice lands on the third try, waiting 25 ms between', () => {
  const file = path.join(home, 'twice.json');
  const waits: number[] = [];
  let tries = 0;
  writeJson(file, { a: 1 }, {
    rename: (from, to) => {
      if (++tries < 3) throw refused('EPERM');
      renameSync(from, to);
    },
    sleep: (ms) => waits.push(ms),
  });
  assert.deepEqual(readJson(file, null), { a: 1 });
  assert.deepEqual(waits, [25, 25]);
});

test('a rename always refused, or refused for another reason, throws: the old file kept, no temporary file left', () => {
  const file = path.join(home, 'kept.json');
  writeFileSync(file, '{"old":true}\n');
  let tries = 0;
  assert.throws(() => writeJson(file, { new: true }, { rename: () => ((tries++, (() => { throw refused('EBUSY'); })())), sleep: () => {} }), /EBUSY/);
  assert.equal(tries, RENAME_TRIES);
  tries = 0;
  assert.throws(() => writeJson(file, { new: true }, { rename: () => ((tries++, (() => { throw refused('ENOSPC'); })())), sleep: () => {} }), /ENOSPC/);
  assert.equal(tries, 1, 'not a refusal for a moment: thrown at once');
  assert.equal(readFileSync(file, 'utf8'), '{"old":true}\n');
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
  // And a plain write still works, making its folder.
  writeJson(path.join(home, 'new', 'plain.json'), [1]);
  assert.ok(existsSync(path.join(home, 'new', 'plain.json')));
});

// Kit 2.71.3: a write that changes nothing writes nothing, and a read of a file unchanged since costs one stat.
const { fileCounts, SETTLED_MS } = await import('./fixture/src/kit/file-cache.ts');

/** Sets a file's times back, as a file written a while ago has them: its reads may then be kept. */
const settle = (file: string) => {
  const then = new Date(Date.now() - 10 * SETTLED_MS);
  utimesSync(file, then, then);
};

test('writeJson leaves a file that holds exactly that JSON as it is: no temporary file, no rename, its time unchanged', () => {
  const file = path.join(home, 'same.json');
  writeJson(file, { a: 1, b: [1, 2] });
  settle(file);
  const before = statSync(file);
  const { writes, unchanged } = fileCounts;
  let renamed = 0;
  for (let i = 0; i < 60; i++) writeJson(file, { a: 1, b: [1, 2] }, { rename: (from, to) => void (renamed++, renameSync(from, to)) });
  assert.equal(renamed, 0);
  assert.deepEqual([fileCounts.writes - writes, fileCounts.unchanged - unchanged], [0, 60]);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  // A change is written, a key order too (other bytes), and `always` writes it all the same.
  writeJson(file, { a: 2, b: [1, 2] });
  assert.deepEqual(readJson(file, null), { a: 2, b: [1, 2] });
  writeJson(file, { b: [1, 2], a: 2 });
  assert.equal(readFileSync(file, 'utf8'), '{\n  "b": [\n    1,\n    2\n  ],\n  "a": 2\n}\n');
  settle(file);
  const settled = statSync(file).mtimeMs;
  writeJson(file, { b: [1, 2], a: 2 }, { always: true });
  assert.notEqual(statSync(file).mtimeMs, settled, 'always: written');
  assert.equal(fileCounts.writes - writes, 3);
  // A file with a byte-order mark, or another's spacing, isn't the same bytes: written as the kit writes it.
  writeFileSync(file, '\uFEFF{"a":1}');
  writeJson(file, { a: 1 });
  assert.equal(readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n');
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
});

test('readJson: a settled file read again costs a stat, gives what a fresh read would, and any change is read', () => {
  const file = path.join(home, 'kept.read.json');
  writeFileSync(file, '{"developerOptions":true,"n":1}');
  settle(file);
  const reads = fileCounts.reads;
  for (let i = 0; i < 100; i++) assert.deepEqual(readJson(file, null), { developerOptions: true, n: 1 });
  assert.equal(fileCounts.reads - reads, 1, 'read once, then kept');
  // Each call parses afresh: changing what one gets changes nothing for the next.
  (readJson(file, {}) as Record<string, unknown>).n = 99;
  assert.deepEqual(readJson(file, null), { developerOptions: true, n: 1 });
  // Changed by someone else, to the same size: read again at once.
  writeFileSync(file, '{"developerOptions":true,"n":2}');
  assert.deepEqual(readJson(file, null), { developerOptions: true, n: 2 });
  // Changed again within the same moment, the same size: a file that hasn't settled is read every time.
  writeFileSync(file, '{"developerOptions":true,"n":3}');
  assert.deepEqual(readJson(file, null), { developerOptions: true, n: 3 });
  writeFileSync(file, '{"developerOptions":true,"n":4}');
  assert.deepEqual(readJson(file, null), { developerOptions: true, n: 4 });
  // Gone, then broken: the fallback, as before.
  rmSync(file);
  assert.equal(readJson(file, 'gone'), 'gone');
  writeFileSync(file, '{not json');
  assert.equal(readJson(file, 'broken'), 'broken');
});
