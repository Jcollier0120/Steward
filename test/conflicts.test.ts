import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The page's record of each conflicting PR a round looked at (conflicts.ts): the last look, new only when it says
// something new, and gone after two weeks.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-conflicts-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { loadConflicts, noteConflict } = await import('../src/conflicts.ts');

const look = (number: number, o: Partial<Parameters<typeof noteConflict>[0]> = {}) => ({
  id: 'fake',
  name: 'Fake',
  repo: 'octocat/fake',
  number,
  url: `https://github.com/octocat/fake/pull/${number}`,
  title: `#${number}`,
  head: `claude/f${number}`,
  author: 'octocat',
  headOid: 'a1',
  outcome: 'sent-back' as const,
  note: 'it conflicts with main in LICENSE: back with octocat, in a comment on it',
  files: ['LICENSE'],
  needs: ['LICENSE'],
  ...o,
});
const at = (iso: string) => new Date(iso);

test('a look said again moves only when it was looked at; a new outcome, or a new head, is new', () => {
  noteConflict(look(1), at('2026-10-01T10:00:00Z'));
  const again = noteConflict(look(1), at('2026-10-01T10:10:00Z'));
  assert.deepEqual([again.firstAt, again.at, again.lookedAt], ['2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', '2026-10-01T10:10:00.000Z']);
  const pushed = noteConflict(look(1, { headOid: 'b2' }), at('2026-10-01T11:00:00Z'));
  assert.equal(pushed.at, '2026-10-01T11:00:00.000Z');
  const caught = noteConflict(look(1, { headOid: 'b2', outcome: 'caught-up', note: 'merged main into it, its version lines resolved', needs: [] }), at('2026-10-01T12:00:00Z'));
  assert.deepEqual([caught.firstAt, caught.at, caught.outcome], ['2026-10-01T10:00:00.000Z', '2026-10-01T12:00:00.000Z', 'caught-up']);
  assert.equal(loadConflicts(Date.parse('2026-10-01T12:00:00Z')).length, 1, 'one record a PR');
});

test('the newest outcome first; looks older than two weeks go', () => {
  noteConflict(look(2), at('2026-10-02T09:00:00Z'));
  noteConflict(look(3, { outcome: 'couldnt', note: "couldn't: offline" }), at('2026-10-03T09:00:00Z'));
  assert.deepEqual(loadConflicts(Date.parse('2026-10-03T09:00:00Z')).map((l) => l.number), [3, 2, 1]);
  assert.deepEqual(loadConflicts(Date.parse('2026-10-15T13:00:00Z')).map((l) => l.number), [3, 2], 'the first, last looked at on the 1st at noon, is gone');
  noteConflict(look(4), at('2026-10-20T09:00:00Z'));
  assert.deepEqual(loadConflicts(Date.parse('2026-10-20T09:00:00Z')).map((l) => l.number), [4], 'and dropped from the file once one is noted');
});
