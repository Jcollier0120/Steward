import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The merge pass ahead of the next build (stages/prepare.ts): which repositories it looks at, and when it stops.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-prepare-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { AGAIN_MS, aheadGuard, aheadStops, buildBegins, toPrepare } = await import('../src/stages/prepare.ts');
const { savePipeline } = await import('../src/pipeline.ts');

const due = '2026-10-16T22:00:00.000Z';
const at = (ms: number) => new Date(Date.parse('2026-10-16T19:00:00.000Z') + ms).toISOString();
const now = Date.parse(at(0));

test('the pass ahead looks at a repository whose ready PRs or branch moved, whose PRs waited on something brief, or every AGAIN_MS', () => {
  const repos = [
    { e: { id: 'moved' }, key: 'b|1@b|k|v' },
    { e: { id: 'same' }, key: 'a|1@a|k|v' },
    { e: { id: 'brief' }, key: 'a|1@a|k|v' },
    { e: { id: 'stale' }, key: 'a|1@a|k|v' },
    { e: { id: 'none' }, key: null },
    { e: { id: 'other build' }, key: 'a|1@a|k|v' },
  ];
  const kept = {
    moved: { key: 'a|1@a|k|v', due, at: at(-60_000), line: '' },
    same: { key: 'a|1@a|k|v', due, at: at(-60_000), line: '' },
    brief: { key: 'a|1@a|k|v', due, at: at(-60_000), line: '', brief: true },
    stale: { key: 'a|1@a|k|v', due, at: at(-AGAIN_MS), line: '' },
    'other build': { key: 'a|1@a|k|v', due: '2026-10-16T16:00:00.000Z', at: at(-60_000), line: '' },
  };
  assert.deepEqual(toPrepare(repos, kept, due, now).map((e) => e.id), ['moved', 'brief', 'stale', 'other build']);
});

test('the pass ahead stops once a build round begins in this process, or a build is open, or its time has come', () => {
  savePipeline({ open: null, builds: [] });
  const started = Date.now();
  const next = new Date(started + 60 * 60_000);
  assert.equal(aheadStops(started, next), false);
  buildBegins(started - 1);
  assert.equal(aheadStops(started, next), false, 'a build round that began before this pass did is no reason to stop');
  buildBegins(started + 1);
  assert.equal(aheadStops(started, next), true, 'a build round began since it started');
  assert.equal(aheadStops(started + 2, new Date(started - 1)), true, "the build's time has come");
  savePipeline({ open: { due: next.toISOString(), by: 'owner', started: new Date(started).toISOString(), rounds: 1, merged: [], released: [], failed: [] }, builds: [] });
  assert.equal(aheadStops(started + 2, next), true, 'a build is open (Build now)');
  savePipeline({ open: null, builds: [] });
});

test("the pass ahead's guard says no once it stops, and otherwise asks the turns it took", async () => {
  let stop = false;
  const turns = { ok: async (e: { id: string }) => e.id !== 'elsewhere', skip: new Set(['elsewhere']), has: (id: string) => id !== 'nobody' };
  const g = aheadGuard(turns, () => stop);
  assert.equal(await g.ok({ id: 'here', repo: 'o/here' }), true);
  assert.equal(await g.ok({ id: 'elsewhere', repo: 'o/elsewhere' }), false);
  assert.deepEqual([...g.skip], ['elsewhere']);
  stop = true;
  assert.equal(await g.ok({ id: 'here', repo: 'o/here' }), false);
  const none = aheadGuard(null, () => false);
  assert.equal(await none.ok({ id: 'here', repo: 'o/here' }), true, 'no turns to take: every repository is this PC’s');
  assert.equal(none.has('here'), true);
});
