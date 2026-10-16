import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A build is under way from its first round's start (steward.ts): pipeline.json's open build is saved as the round
// begins it, so GET /api/pipeline says building, and Manor holds its installs, through what is often the build's
// longest round, not only after it. On a data folder of its own, a fake employee's git, and gh standing in.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-build-begins-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { loadPipeline, normalizePipeline, pipelineView } = await import('../src/pipeline.ts');
const { fakeEmployee, ok, runner } = await import('./helpers.ts');
type BuildRun = import('../src/pipeline.ts').BuildRun;

const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0' });
const pipeline = normalizePipeline({ on: true, times: ['08:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], kit: 'every', windowMinutes: 120 });
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: 'node -e process.exit(0)', install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    afterRelease: [],
    buildPipeline: pipeline,
  }),
);

/** The open build as pipeline.json had it at each question the round asked GitHub. */
const seen: (BuildRun | null)[] = [];
const r = runner((args) => {
  seen.push(loadPipeline().open ?? null);
  if (args[0] === 'pr' && args[1] === 'list') return ok([]);
  if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
});

test("a build is under way from its first round's start: pipeline.json has it open, at round 0, while that round runs", async () => {
  const now = new Date(2026, 9, 16, 8, 2);
  assert.equal(loadPipeline().open, null);
  const out = await runStage('round', {}, { run: r.run, now: () => now, alarms: { manorUrl: 'http://127.0.0.1:9' } });
  assert.equal(out.error, undefined);
  assert.match(out.log.join('\n'), /the 08:00 build begins/);
  assert.ok(seen.length > 0, 'the round asked GitHub something');
  const during = seen.find((o) => o !== null);
  assert.ok(during, 'the build was open in pipeline.json during its first round');
  assert.deepEqual([during.due, during.by, during.rounds, during.finished], [new Date(2026, 9, 16, 8, 0).toISOString(), 'schedule', 0, undefined]);
  assert.equal(pipelineView(pipeline, { open: during, builds: [] }, now).building, true, 'what Manor reads: building');

  // The round's end saves it again: its first round counted, open still or closed.
  const after = loadPipeline();
  const run = after.open ?? after.builds.at(-1)!;
  assert.equal(run.due, during.due);
  assert.equal(run.rounds, 1);
});
