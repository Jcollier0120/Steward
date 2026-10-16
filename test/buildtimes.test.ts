import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Faster builds (Steward 0.36.67): where a build's time goes (buildtimes.ts), what the next build's preparing between
// builds looks at (stages/prepare.ts), the rollout waiting for a kit coming in the same build (stages/buildkit.ts) and a
// build's releases side by side (stages/round.ts). On a data folder of its own; nothing reaches GitHub.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-buildtimes-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { buildTimeLine, keepPhases, minutesWords, phaseOf, phasesOf, spanMs, timed } = await import('../src/buildtimes.ts');
const { loadPipeline, savePipeline } = await import('../src/pipeline.ts');
const { prepareKey, toPrepare } = await import('../src/stages/prepare.ts');
const { kitComing } = await import('../src/stages/buildkit.ts');
const { buildReleaseLimit, buildReleases } = await import('../src/stages/round.ts');
const { CHECKS_RUNNING } = await import('../src/stages/merge.ts');
const { TRIAL_GOING } = await import('../src/stages/trial.ts');
const { employee } = await import('./helpers.ts');

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

test("the page's line says how long the last build took, and where its time went", () => {
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
      // Done between builds, for this one.
      { phase: 'tests' as const, of: 'clerk', ahead: true, ...span(-120, -100) },
    ],
  };
  assert.equal(buildTimeLine(run), 'The 08:00 build took 42 min: tests 20 min, kit trial 30 min, merges 1 min, releases 9 min, Manor told 2 min; 20 min of its tests ran ahead of it, between builds.');
  assert.equal(buildTimeLine({ ...run, cut: true, phases: [] }), 'The 08:00 build took 40 min (it ran out of time).');
  assert.match(buildTimeLine({ ...run, by: 'owner', phases: undefined })!, /^The owner's Build now took 40 min\.$/);
  assert.equal(buildTimeLine({ ...run, finished: null }), null, 'still open');
});

test("a phase is kept under its build's time, whatever its work gave, and copied into the build's record", async () => {
  const due = at(0);
  // A clock that moves a minute each time it is read: no waiting.
  let tick = 0;
  const clock = () => T0 + tick++ * 60_000;
  assert.equal(await timed(null, 'tests', 'porter', async () => 7), 7, 'no build: it only runs');
  assert.equal(phaseOf({ build: null, prepare: null }), null);
  assert.deepEqual(phaseOf({ build: { due, ahead: true } }), { due, ahead: true }, 'merged ahead of the build: counted ahead of it');
  assert.equal(await timed(phaseOf({ build: { due } }), 'tests', 'porter', async () => 'passed', undefined, clock), 'passed');
  await assert.rejects(timed(phaseOf({ build: { due } }), 'merges', 'clerk', async () => Promise.reject(new Error('no')), undefined, clock), /no/);
  await timed(phaseOf({ build: null, prepare: { due } }), 'tests', 'miller', async () => 1, undefined, clock);
  await timed({ due }, 'releases', null, async () => [], (r) => r.length > 0, clock);
  await timed({ due }, 'manor', null, async () => 1, undefined, () => T0);
  assert.deepEqual(
    phasesOf(due).map((p) => [p.phase, p.of ?? null, p.ahead ?? false]),
    [
      ['tests', 'porter', false],
      ['merges', 'clerk', false],
      ['tests', 'miller', true],
    ],
    'a release that released nothing, and a span under half a second, are no phase',
  );
  assert.equal(phasesOf(at(60)).length, 0, 'another build has none');

  savePipeline({ open: { due, by: 'schedule', started: at(0), rounds: 1, merged: [], released: [], failed: [] }, builds: [] });
  keepPhases(due);
  assert.equal(loadPipeline().open?.phases?.length, 3);
  const s = loadPipeline();
  savePipeline({ open: null, builds: [{ ...s.open!, phases: undefined, finished: at(30) }] });
  keepPhases(due);
  assert.equal(loadPipeline().builds[0].phases?.length, 3, 'a build that ended has them too');
});

test('the next build is prepared for a repository only once its branch, its ready PRs or the kit moved', () => {
  const pr = (number: number, head: string, isDraft = false) => ({ number, headRefOid: head, isDraft });
  assert.equal(prepareKey({ head: 'h1', prs: [], kit: '2.78.1' }), null, 'no PR: nothing to prepare');
  assert.equal(prepareKey({ head: 'h1', prs: [pr(4, 'x', true)], kit: '2.78.1' }), null, 'a draft is no ready PR');
  const key = prepareKey({ head: 'h1', prs: [pr(5, 'b'), pr(4, 'a'), pr(6, 'c', true)], kit: '2.78.1', steward: '0.36.67' });
  assert.equal(key, 'h1|4@a,5@b|2.78.1|0.36.67');
  assert.equal(prepareKey({ head: 'h1', prs: [pr(4, 'a'), pr(5, 'b')], kit: '2.78.1', steward: '0.36.67' }), key, "the PRs' order doesn't matter");
  assert.notEqual(prepareKey({ head: 'h1', prs: [pr(4, 'a'), pr(5, 'b2')], kit: '2.78.1', steward: '0.36.67' }), key, 'a push to a PR');
  assert.notEqual(prepareKey({ head: 'h2', prs: [pr(4, 'a'), pr(5, 'b')], kit: '2.78.1', steward: '0.36.67' }), key, 'the branch moved');
  assert.notEqual(prepareKey({ head: 'h1', prs: [pr(4, 'a'), pr(5, 'b')], kit: '2.78.2', steward: '0.36.67' }), key, 'a newer kit');

  const due = at(0);
  const e = (id: string) => ({ id });
  const kept = { porter: { key: 'k1', due, at: at(-20), line: '' }, clerk: { key: 'k2', due: at(-1440), at: at(-1500), line: '' } };
  const repos = [
    { e: e('porter'), key: 'k1' },
    { e: e('clerk'), key: 'k2' },
    { e: e('miller'), key: 'k3' },
    { e: e('smith'), key: null },
  ];
  assert.deepEqual(
    toPrepare(repos, kept, due, Date.parse(at(0))).map((r) => r.id),
    ['clerk', 'miller'],
    'porter was prepared at this key for this build; clerk only for an earlier one; smith has nothing',
  );
  assert.deepEqual(toPrepare(repos, kept, due, Date.parse(at(10))).map((r) => r.id), ['porter', 'clerk', 'miller'], 'half an hour on, porter is looked at again');
  assert.deepEqual(toPrepare([{ e: e('porter'), key: 'k9' }], kept, due).map((r) => r.id), ['porter'], 'it moved since');
});

test("a kit PR of the Steward's tested ahead of a build runs its whole suite, so the gate before the kit's release isn't run in the build", async () => {
  const { wholeAhead } = await import('../src/stages/prtest.ts');
  const { APP } = await import('../src/app.ts');
  const pr = (files: string[]) => ({ number: 289, files }) as unknown as import('../src/stages/staff.ts').PrInfo;
  const kit = pr(['kit/VERSION', 'kit/core/run.ts']);
  const prepare = { due: at(0), name: 'the 08:00 build' };
  const steward = { id: APP.id };
  assert.equal(wholeAhead({ build: null, prepare }, steward, kit), true);
  assert.equal(wholeAhead({ build: null, prepare }, steward, pr(['src/agent.ts'])), false, "one that doesn't raise the kit: what its change reaches");
  assert.equal(wholeAhead({ build: prepare, prepare: null }, steward, kit), false, 'in the build: as before');
  assert.equal(wholeAhead({ build: null, prepare: null }, steward, kit), false);
  assert.equal(wholeAhead({ build: null, prepare }, { id: 'porter' }, kit), false, "an agent's: no kit is released from it");
});

test("a build's rollout waits for a newer kit coming in that build, not one held for anything else", () => {
  const held = (number: number, why: string, more: { kit?: boolean; draft?: boolean } = {}) => ({ number, url: '', title: '', why, draft: false, kit: true, ...more });
  const release = (more: object) => ({ id: 'steward', name: 'Steward', outcome: 'skipped' as const, message: '', ...more });
  assert.equal(kitComing({ selfHeld: [], selfReleases: [] }), null);
  assert.equal(kitComing({ selfHeld: [], selfReleases: [release({ kitWaits: '2.78.1' })] }), 'kit 2.78.1, merged in this build, whose release waits for its whole suite');
  assert.equal(kitComing({ selfHeld: [held(289, TRIAL_GOING)], selfReleases: [] }), `the Steward's #289, whose newer kit merges in this build (${TRIAL_GOING})`);
  assert.match(kitComing({ selfHeld: [held(290, CHECKS_RUNNING, { kit: false }), held(289, CHECKS_RUNNING)], selfReleases: [] })!, /#289/, 'only a PR that raises the kit');
  assert.equal(kitComing({ selfHeld: [held(289, 'its kit failed its trial on Porter')], selfReleases: [] }), null, 'held for longer: the kit released goes now');
  assert.equal(kitComing({ selfHeld: [held(289, TRIAL_GOING, { draft: true })], selfReleases: [] }), null, 'a draft waits for a later build');
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
