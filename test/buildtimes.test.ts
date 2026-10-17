import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Faster builds (Steward 0.36.67): where a build's time goes (buildtimes.ts), and a build's releases side by side
// (stages/round.ts). Nothing is done between builds for the next one now (Steward 0.36.121), but the records of builds
// from before, whose tests ran ahead of them, still read. On a data folder of its own; nothing reaches GitHub.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-buildtimes-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { buildTimeLine, keepPhases, minutesWords, phaseOf, phasesOf, spanMs, timed } = await import('../src/buildtimes.ts');
const { loadPipeline, savePipeline } = await import('../src/pipeline.ts');
const { buildReleaseLimit, buildReleases } = await import('../src/stages/round.ts');
const { employee } = await import('./helpers.ts');
type Ctx = import('../src/stages/common.ts').Ctx;

const T0 = Date.parse('2026-10-16T12:50:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const span = (from: number, to: number) => ({ started: at(from), finished: at(to) });

test('a set of spans counts each minute once, however many ran at it', () => {
  assert.equal(spanMs([]), 0);
  assert.equal(spanMs([span(0, 10)]), 10 * 60_000);
  assert.equal(spanMs([span(0, 10), span(5, 15), span(20, 25)]), 20 * 60_000, 'overlapping and apart');
  assert.equal(spanMs([span(20, 25), span(0, 30)]), 30 * 60_000, 'one inside another, in any order');
  assert.equal(spanMs([span(5, 5), { started: 'never', finished: at(3) }]), 0, 'empty and unreadable spans count nothing');
  assert.deepEqual([minutesWords(59_000), minutesWords(60_000), minutesWords(23.4 * 60_000)], ['under a minute', '1 min', '23 min']);
});

test("the page's line says how long the last build took, and where its time went; a record from before, with tests ahead of it, still reads", () => {
  const run = {
    due: new Date(2026, 9, 16, 8, 0).toISOString(),
    by: 'schedule' as const,
    started: at(0),
    finished: at(40),
    cut: false,
    phases: [
      { phase: 'tests' as const, of: 'porter', ...span(0, 10) },
      { phase: 'tests' as const, of: 'steward', ...span(5, 20) },
      { phase: 'trial' as const, of: 'kit 2.78.1', ...span(0, 30) },
      { phase: 'merges' as const, of: 'porter', ...span(30, 31) },
      { phase: 'releases' as const, ...span(31, 40) },
      // Manor told comes after the build is recorded as finished: the build took until then.
      { phase: 'manor' as const, ...span(40, 42) },
      // Done between builds, for this one, as builds before Steward 0.36.121 were prepared.
      { phase: 'tests' as const, of: 'clerk', ahead: true, ...span(-120, -100) },
    ],
  };
  assert.equal(buildTimeLine(run), 'The 08:00 build took 42 min: tests 20 min, kit trial 30 min, merges 1 min, releases 9 min, Manor told 2 min; 20 min of its tests ran ahead of it, between builds.');
  assert.equal(buildTimeLine({ ...run, cut: true, phases: [] }), 'The 08:00 build took 40 min (it ran out of time).');
  assert.match(buildTimeLine({ ...run, by: 'owner', phases: undefined })!, /^The owner's Build now took 40 min\.$/);
  assert.equal(buildTimeLine({ ...run, finished: null }), null, 'still open');
  // As pipeline.json kept it.
  savePipeline({ open: null, builds: [{ ...run, rounds: 3, merged: [], released: [], failed: [] }] });
  assert.equal(buildTimeLine(loadPipeline().builds[0]), buildTimeLine(run));
  savePipeline({ open: null, builds: [] });
  // A build of today's, none of its time ahead of it: no such words.
  assert.equal(buildTimeLine({ ...run, phases: run.phases.filter((p) => !('ahead' in p)) }), 'The 08:00 build took 42 min: tests 20 min, kit trial 30 min, merges 1 min, releases 9 min, Manor told 2 min.');
});

test("a phase is kept under its build's time, whatever its work gave, and copied into the build's record; none is ahead of it", async () => {
  const due = at(0);
  // A clock that moves a minute each time it is read: no waiting.
  let tick = 0;
  const clock = () => T0 + tick++ * 60_000;
  assert.equal(await timed(null, 'tests', 'porter', async () => 7), 7, 'no build: it only runs');
  // Between builds a round has no build (common.ts' Ctx.build): its work counts for none.
  const between: Pick<Ctx, 'build'> = { build: null };
  assert.equal(phaseOf(between), null);
  // A build's round: its build time and name, and its work is that build's own time.
  const building: Pick<Ctx, 'build'> = { build: { due, name: 'the 12:50 build' } };
  assert.deepEqual(phaseOf(building), { due });
  assert.equal(await timed(phaseOf(building), 'tests', 'porter', async () => 'passed', undefined, clock), 'passed');
  await assert.rejects(timed(phaseOf(building), 'merges', 'clerk', async () => Promise.reject(new Error('no')), undefined, clock), /no/);
  await timed(phaseOf(between), 'tests', 'miller', async () => 1, undefined, clock);
  await timed({ due }, 'releases', null, async () => [], (r) => r.length > 0, clock);
  await timed({ due }, 'manor', null, async () => 1, undefined, () => T0);
  assert.deepEqual(
    phasesOf(due).map((p) => [p.phase, p.of ?? null, p.ahead ?? false]),
    [
      ['tests', 'porter', false],
      ['merges', 'clerk', false],
    ],
    'between builds no phase; a release that released nothing, and a span under half a second, are no phase',
  );
  assert.equal(phasesOf(at(60)).length, 0, 'another build has none');

  savePipeline({ open: { due, by: 'schedule', started: at(0), rounds: 1, merged: [], released: [], failed: [] }, builds: [] });
  keepPhases(due);
  assert.equal(loadPipeline().open?.phases?.length, 2);
  const s = loadPipeline();
  savePipeline({ open: null, builds: [{ ...s.open!, phases: undefined, finished: at(30) }] });
  keepPhases(due);
  assert.equal(loadPipeline().builds[0].phases?.length, 2, 'a build that ended has them too');
});

test("a build's releases run side by side, those that sign one after another in a lane of their own", async () => {
  assert.equal(buildReleaseLimit(1, 18), 6, 'eighteen cores: six at once');
  assert.equal(buildReleaseLimit(1, 2), 1);
  assert.equal(buildReleaseLimit(8, 18), 8, "Settings' parallel, when higher");
  assert.equal(buildReleaseLimit(0, 4), 1);

  const es = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => employee(`C:\\nowhere\\${id}`, { id, name: id }));
  const signs = (e: { id: string }) => e.id === 'b' || e.id === 'e' || e.id === 'g';
  const started: string[] = [];
  let signing = 0;
  let most = 0;
  let mostSigning = 0;
  let running = 0;
  const one = async (e: (typeof es)[number]) => {
    started.push(e.id);
    running++;
    if (signs(e)) signing++;
    most = Math.max(most, running);
    mostSigning = Math.max(mostSigning, signing);
    // Each takes a few turns of the event loop, so the others start beside it.
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    running--;
    if (signs(e)) signing--;
    return `${e.id} released`;
  };
  const out = await buildReleases(es, 1, one, signs, 12);
  assert.deepEqual(out, es.map((e) => `${e.id} released`), "results in the employees' order");
  assert.equal(started[0], 'b', 'the first that signs starts first');
  assert.equal(mostSigning, 1, 'one signs at a time');
  assert.equal(most, 4, 'four at once on twelve cores: one signing, three beside it');

  started.length = 0;
  most = 0;
  await buildReleases(es.filter((e) => !signs(e)), 1, one, signs, 12);
  assert.equal(most, 4, 'none signs: all four lanes release the rest');
});
