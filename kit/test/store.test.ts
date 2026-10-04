import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
