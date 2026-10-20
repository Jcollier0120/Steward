import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The build pipeline: rounds that release only at set build times, each repository's main released once a build, and
// fragments (changes/<branch>.md) that pick no version, stamped on main by the build into the next release's.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-pipeline-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { boardedUrgent, DEFAULT_PIPELINE, endRound, kitRides, lastBuildTime, lateLine, loadPipeline, nextBuildTime, normalizePipeline, pipelineMode, pipelineView, savePipeline, urgentKey } = await import('../src/pipeline.ts');
const { addToEntry, composeEntry, CHANGES_README, changesReadme, fragmentBody, fragmentFiles, fragmentFor } = await import('../src/entries.ts');
const { stampBranch, stampMain } = await import('../src/stages/stamp.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { runStage } = await import('../src/steward.ts');
const { ctxFor, employee, fakeEmployee, mergesOf, ok, runner, sh } = await import('./helpers.ts');
type PipelineState = import('../src/pipeline.ts').PipelineState;

/** Three builds a day, as before the defaults were four. */
const THREE = { ...DEFAULT_PIPELINE, times: ['08:00', '13:00', '18:00'] };
/** A local time on 2026-10-13 (a Tuesday), or another day of that month. */
const at = (h: number, m = 0, day = 13) => new Date(2026, 9, day, h, m);
const none: PipelineState = { open: null, builds: [] };

test("the pipeline's settings: no switch, four builds a day to start with, each value checked, a bad one its default", () => {
  assert.deepEqual(normalizePipeline(undefined), DEFAULT_PIPELINE);
  assert.deepEqual(DEFAULT_PIPELINE.times, ['00:00', '06:00', '12:00', '18:00']);
  assert.deepEqual([DEFAULT_PIPELINE.days.length, DEFAULT_PIPELINE.kit, DEFAULT_PIPELINE.windowMinutes], [7, 'every', 30]);
  assert.equal('on' in DEFAULT_PIPELINE, false, 'no switch');
  // A settings.json saved while there was a switch, off or on: it builds at its times all the same.
  assert.deepEqual(normalizePipeline({ on: false }), DEFAULT_PIPELINE);
  assert.deepEqual(normalizePipeline({ on: false, times: ['07:30'] }), { ...DEFAULT_PIPELINE, times: ['07:30'] });
  const p = normalizePipeline({ on: true, times: ['18:00', '8:00', 'noon', '08:00', '24:00'], days: ['mon', 'fri', 'xyz'], kit: 'first', windowMinutes: 9999 });
  assert.deepEqual(p, { times: ['08:00', '18:00'], days: ['mon', 'fri'], kit: 'first', windowMinutes: 60 });
  assert.deepEqual(normalizePipeline({ times: ['nope'], kit: 'sometimes', windowMinutes: 'x' }).times, DEFAULT_PIPELINE.times);
  assert.equal(normalizePipeline({ windowMinutes: 1 }).windowMinutes, 15);
  // A build takes half an hour unless Settings say otherwise, and never more than an hour; the old default of two hours,
  // stored when the pipeline was turned on, was never chosen, and reads as today's.
  assert.equal(DEFAULT_PIPELINE.windowMinutes, 30);
  assert.deepEqual([45, 60, 90, 120, 360].map((windowMinutes) => normalizePipeline({ windowMinutes }).windowMinutes), [45, 60, 60, 30, 60]);
  // Finding the PR that broke a build went with the merges: a settings.json that keeps bisectRuns keeps it, unused,
  // within its old limits (Settings' other unused values are kept too).
  assert.equal('bisectRuns' in DEFAULT_PIPELINE, false);
  assert.deepEqual(normalizePipeline({ bisectRuns: 5 }), { ...DEFAULT_PIPELINE, bisectRuns: 5 });
  assert.deepEqual([-1, 0, 6, 9, 'x'].map((bisectRuns) => normalizePipeline({ bisectRuns }).bisectRuns), [0, 0, 6, 6, undefined]);
});

test("Settings: no switch shown; Manor's save of the group with its old switch, off, and its old bisectRuns, is taken: the switch left out, bisectRuns kept unused", async () => {
  const { SETTINGS_SPEC, loadSettings } = await import('../src/settings.ts');
  const { saveSettingsReply, schemaFor } = await import('../src/kit/settings-kit.ts');
  const group = SETTINGS_SPEC.schema.find((f) => f.key === 'buildPipeline');
  assert.ok(group && group.kind === 'group');
  const on = group.fields.find((f) => f.key === 'on');
  assert.equal(on?.hidden && on.optional, true, 'kept for older Manors, never drawn');
  const bisect = group.fields.find((f) => f.key === 'bisectRuns');
  assert.equal(bisect?.hidden && bisect.optional, true, 'kept for older Manors, never drawn');
  assert.doesNotMatch(group.help ?? '', /\bOff\b/);
  assert.ok(schemaFor(SETTINGS_SPEC.schema, true).some((f) => f.key === 'buildPipeline'));
  const r = await saveSettingsReply(SETTINGS_SPEC, { values: { buildPipeline: { on: false, times: ['07:00', '19:00'], days: ['mon', 'tue', 'wed', 'thu', 'fri'], kit: 'every', windowMinutes: 45, bisectRuns: 3 } } }, true);
  assert.equal((r.json as { ok?: boolean }).ok, true, JSON.stringify(r.json));
  const stored = JSON.parse(readFileSync(SETTINGS_SPEC.file(), 'utf8'));
  assert.equal('on' in stored.buildPipeline, false);
  assert.deepEqual(loadSettings().buildPipeline, { times: ['07:00', '19:00'], days: ['mon', 'tue', 'wed', 'thu', 'fri'], kit: 'every', windowMinutes: 45, bisectRuns: 3 });
  rmSync(SETTINGS_SPEC.file(), { force: true });
});

test("the old default times, stored when the switch was turned on, were never chosen: they take today's four; other times stay", async () => {
  const { SETTINGS_SPEC, loadSettings } = await import('../src/settings.ts');
  // As Settings saved the whole group when the owner turned the switch on.
  const saved = { on: true, times: ['08:00', '13:00', '18:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], kit: 'every', windowMinutes: 120, bisectRuns: 3 };
  mkdirSync(path.dirname(SETTINGS_SPEC.file()), { recursive: true });
  writeFileSync(SETTINGS_SPEC.file(), JSON.stringify({ buildPipeline: saved }));
  assert.deepEqual(loadSettings().buildPipeline, { ...DEFAULT_PIPELINE, bisectRuns: 3 });
  rmSync(SETTINGS_SPEC.file(), { force: true });
  assert.deepEqual(normalizePipeline({ times: ['18:00', '8:00', '13:00'] }).times, DEFAULT_PIPELINE.times, 'the same three, written another way');
  // Any other list is the owner's.
  for (const times of [['08:00', '13:00'], ['08:00', '13:00', '18:00', '21:00'], ['08:00', '12:00', '18:00'], ['07:30']]) {
    assert.deepEqual(normalizePipeline({ ...saved, times }).times, times);
  }
  assert.deepEqual(normalizePipeline({ ...saved, kit: 'first', windowMinutes: 45 }), { ...DEFAULT_PIPELINE, kit: 'first', windowMinutes: 45, bisectRuns: 3 }, 'the rest of the group stays');
});

test('the build times: the last one come and the next, on the days builds run', () => {
  assert.deepEqual(lastBuildTime(THREE, at(9)), at(8));
  assert.deepEqual(nextBuildTime(THREE, at(9)), at(13));
  assert.deepEqual(nextBuildTime(THREE, at(18, 30)), at(8, 0, 14));
  assert.deepEqual(lastBuildTime(THREE, at(7)), at(18, 0, 12), "before the day's first: yesterday's last");
  // Weekdays only: Saturday evening's next is Monday's first.
  const week = { ...THREE, days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const };
  assert.deepEqual(nextBuildTime({ ...week, days: [...week.days] }, at(19, 0, 17)), at(8, 0, 19));
  assert.equal(nextBuildTime({ ...THREE, days: [] }, at(9)), null);
  // The defaults: every six hours from midnight.
  assert.deepEqual(lastBuildTime(DEFAULT_PIPELINE, at(5, 59)), at(0));
  assert.deepEqual(nextBuildTime(DEFAULT_PIPELINE, at(5, 59)), at(6));
  assert.deepEqual(nextBuildTime(DEFAULT_PIPELINE, at(18, 1)), at(0, 0, 14));
});

test('there is no off: a first round builds at once for the build time gone by; between builds a round only looks', () => {
  const fresh = pipelineMode(DEFAULT_PIPELINE, none, at(9));
  assert.equal(fresh.kind === 'build' && fresh.fresh && fresh.run.by === 'schedule' && fresh.run.due === at(6).toISOString(), true, "an update past a build time: the first build begins at once");
  const done: PipelineState = { open: null, builds: [{ due: at(8).toISOString(), by: 'schedule', started: at(8).toISOString(), finished: at(8, 40).toISOString(), rounds: 3, merged: [], released: [], failed: [] }] };
  const m = pipelineMode(THREE, done, at(10));
  assert.equal(m.kind, 'between');
  if (m.kind === 'between') {
    assert.deepEqual(m.next, at(13));
    assert.match(m.line, /between builds: PRs are merged by whoever wrote them once vouched, and the next build, at 13:00,? releases each repository's main/);
  }
  const never = pipelineMode({ ...THREE, days: [] }, done, at(10));
  assert.equal(never.kind === 'between' && never.next, null);
  assert.match((never as { line: string }).line, /Settings name no build time to come/);
});

test('a build begins at its time, once, even when the PC slept through it; it goes on until it settles or its time runs out', () => {
  const first = pipelineMode(THREE, none, at(8, 2));
  assert.equal(first.kind, 'build');
  if (first.kind !== 'build') return;
  assert.equal(first.fresh, true);
  assert.equal(first.run.due, at(8).toISOString());
  assert.equal(first.run.by, 'schedule');
  // Its first round ends with something still settling (a kit's rollout, its own PR merged): the build stays open.
  let state = endRound(none, first.run, { merged: ['porter #12'], released: [], failed: [], closed: false, now: at(8, 10) });
  const again = pipelineMode(THREE, state, at(8, 12));
  assert.equal(again.kind === 'build' && !again.fresh && !again.closing && again.run.rounds === 1, true);
  // Past its window: the round that comes closes it.
  const late = pipelineMode(THREE, state, at(10, 3));
  assert.equal(late.kind === 'build' && late.closing, true);
  state = endRound(state, (late as { run: typeof first.run }).run, { merged: [], released: ['porter v0.4.27'], failed: [], closed: true, cut: true, now: at(10, 5) });
  assert.equal(state.open, null);
  assert.deepEqual(state.builds.at(-1), { ...first.run, rounds: 2, merged: ['porter #12'], released: ['porter v0.4.27'], finished: at(10, 5).toISOString(), cut: true });
  // Done for 08:00: between builds until 13:00, however late it is woken.
  assert.equal(pipelineMode(THREE, state, at(12, 59)).kind, 'between');
  // Asleep from 12:00 to 19:30: the 13:00 and 18:00 builds are one build, begun at once.
  const woke = pipelineMode(THREE, state, at(19, 30));
  assert.equal(woke.kind === 'build' && woke.fresh && woke.run.due === at(18).toISOString(), true);
});

test('a build the PC slept through in standby is late, and the page says until when', () => {
  // In standby from 00:35, woken at 08:39 (fresh-start.ts' lastWoke): the 08:00 build begins then, late.
  const woke = pipelineMode(THREE, none, at(8, 40), { wokeAt: at(8, 39).getTime() });
  assert.equal(woke.kind, 'build');
  if (woke.kind !== 'build') return;
  assert.equal(woke.run.late, at(8, 39).toISOString());
  assert.equal(lateLine(woke.run, at(8, 40)), 'the 08:00 build was late: the PC was in standby until 08:39');
  assert.equal(lateLine(woke.run, at(9, 0, 14)), 'the Tue 08:00 build was late: the PC was in standby until Tue 08:39', 'another day names it');
  // Woken before the build time, or by an earlier wake: on time, and nothing said.
  for (const wokeAt of [at(7, 50).getTime(), null]) {
    const m = pipelineMode(THREE, none, at(8, 2), { wokeAt });
    assert.equal(m.kind === 'build' && m.run.late, undefined);
    assert.equal(lateLine(m.kind === 'build' ? m.run : null, at(8, 2)), null);
  }
  // The owner's Build now is never late.
  const now = pipelineMode(THREE, none, at(10), { buildNow: {}, wokeAt: at(9, 59).getTime() });
  assert.equal(now.kind === 'build' && now.run.late, undefined);
});

test("the owner's Build now begins a build at once, for some repositories, its releases let out to customers when asked", () => {
  const m = pipelineMode(DEFAULT_PIPELINE, none, at(10), { buildNow: { toCustomers: true }, employees: ['porter'] });
  assert.equal(m.kind, 'build');
  if (m.kind !== 'build') return;
  assert.deepEqual([m.run.by, m.run.employees, m.run.toCustomers, m.fresh], ['owner', ['porter'], true, true]);
  // An owner's build doesn't stand for the schedule's: the 13:00 one still comes.
  const state = endRound(none, m.run, { merged: [], released: [], failed: [], closed: true, now: at(10, 30) });
  assert.equal(pipelineMode(THREE, state, at(13, 1)).kind, 'build');
});

test("the kit goes into every build, or only the day's first", () => {
  const run = (h: number) => ({ due: at(h).toISOString(), by: 'schedule' as const, started: at(h).toISOString(), rounds: 0, merged: [], released: [], failed: [] });
  const morning = { ...run(8), finished: at(8, 30).toISOString() };
  const state: PipelineState = { open: null, builds: [morning] };
  assert.equal(kitRides(THREE, state, run(13)), true);
  const first = { ...THREE, kit: 'first' as const };
  assert.equal(kitRides(first, state, run(13)), false);
  assert.equal(kitRides(first, { open: null, builds: [] }, run(8)), true);
  assert.equal(kitRides(first, state, { ...run(13), by: 'owner' }), true, "the owner's build takes it");
  assert.equal(kitRides(THREE, state, { ...run(10), by: 'urgent' }), false, "an urgent fix's doesn't: the next build takes it");
  assert.equal(kitRides(THREE, state, { ...run(10), by: 'signing' }), false, "nor the build for releases that waited to sign");
});

// Steward 0.36.161: releases that waited until this PC could sign build as soon as it can, not at the next build time.
test('releases that waited to sign, and now can, begin a build of their own between builds; an urgent fix or a build time comes first', () => {
  const done: PipelineState = { open: null, builds: [{ due: at(8).toISOString(), by: 'schedule', started: at(8).toISOString(), finished: at(8, 40).toISOString(), rounds: 3, merged: [], released: [], failed: [] }] };
  const m = pipelineMode(THREE, done, at(10), { signed: ['envoy', 'envoy', 'porter'] });
  assert.equal(m.kind, 'build');
  if (m.kind !== 'build') return;
  assert.deepEqual([m.fresh, m.run.by, m.run.due, m.run.employees, m.run.urgent], [true, 'signing', at(10).toISOString(), ['envoy', 'porter'], undefined]);
  assert.equal(pipelineMode(THREE, done, at(10), { signed: [] }).kind, 'between');
  const both = pipelineMode(THREE, done, at(10), { urgent: [{ id: 'reeve', head: 'a1' }], signed: ['envoy'] });
  assert.equal(both.kind === 'build' && both.run.by, 'urgent', 'an urgent fix first: the round after it looks again');
  const due = pipelineMode(THREE, done, at(13, 1), { signed: ['envoy'] });
  assert.equal(due.kind === 'build' && due.run.by === 'schedule' && !due.run.employees, true, 'a build time takes them with the rest');
  // It doesn't stand for the schedule's: the 13:00 build still comes.
  const state = endRound(done, m.run, { merged: [], released: ['envoy v0.1.25'], failed: [], closed: true, now: at(10, 20) });
  assert.equal(pipelineMode(THREE, state, at(10, 30)).kind, 'between');
  assert.equal(pipelineMode(THREE, state, at(13, 1)).kind, 'build');
});

test("an urgent fix on main between builds begins a build of its own, for its repository; once at its head; a build time's takes it with the rest", () => {
  const done: PipelineState = { open: null, builds: [{ due: at(8).toISOString(), by: 'schedule', started: at(8).toISOString(), finished: at(8, 40).toISOString(), rounds: 3, merged: [], released: [], failed: [] }] };
  const fix = { id: 'porter', head: 'a1b2c3' };
  const m = pipelineMode(THREE, done, at(10), { urgent: [fix, { id: 'reeve', head: 'd4e5f6' }] });
  assert.equal(m.kind, 'build');
  if (m.kind !== 'build') return;
  assert.deepEqual([m.fresh, m.run.by, m.run.due, m.run.employees, m.run.urgent], [true, 'urgent', at(10).toISOString(), ['porter', 'reeve'], ['porter a1b2c3', 'reeve d4e5f6']]);
  assert.equal(urgentKey(fix), 'porter a1b2c3');
  // A build time come: its build, for every repository, takes the urgent fix with the rest.
  const due = pipelineMode(THREE, done, at(13, 1), { urgent: [fix] });
  assert.equal(due.kind === 'build' && due.run.by === 'schedule' && !due.run.employees && !due.run.urgent, true);
  // Kept once it ends: main at that head never builds as urgent again; at a new head it may.
  const state = endRound(done, m.run, { merged: [], released: ['porter v0.4.28'], failed: [], closed: true, now: at(10, 20) });
  assert.equal(boardedUrgent(state).has(urgentKey(fix)), true);
  assert.equal(boardedUrgent(state).has(urgentKey({ ...fix, head: 'f00' })), false);
  assert.equal(boardedUrgent({ open: m.run, builds: [] }).has(urgentKey(fix)), true, 'while its build is open too');
  // It doesn't stand for the schedule's: between builds until 13:00, and the 13:00 build still comes.
  assert.equal(pipelineMode(THREE, state, at(10, 30)).kind, 'between');
  assert.equal(pipelineMode(THREE, state, at(13, 1)).kind, 'build');
});

test('what Manor reads: always on, the next build, and whether one is under way', () => {
  const v = pipelineView(THREE, { open: { due: at(8).toISOString(), by: 'schedule', started: at(8).toISOString(), rounds: 1, merged: [], released: [], failed: [] }, builds: [] }, at(8, 5));
  assert.equal(v.on, true);
  assert.equal(v.building, true);
  assert.equal(v.next, at(13).toISOString());
  const plain = pipelineView(DEFAULT_PIPELINE, none, at(8, 5));
  assert.deepEqual([plain.on, plain.next, plain.building], [true, at(12).toISOString(), false]);
  assert.equal(pipelineView({ ...DEFAULT_PIPELINE, days: [] }, none, at(8, 5)).next, null, 'no build time to come');
});

const ENTRY = (line: string, before = 'Nothing: it updates itself as usual.') => `**${line}**\n\n### What changed\n\n- ${line}\n\n### Before you update\n\n- ${before}\n`;

test("a fragment is any changes/*.md but a version's or the README; its branch names it; minor: true asks for a minor step", () => {
  assert.deepEqual(fragmentFiles(['changes/README.md', 'changes/0.4.2.md', 'changes/claude-b.md', 'changes/claude-a.md', 'changes/sub/x.md', 'kit/changes/k.md', 'src/x.md']), ['changes/claude-a.md', 'changes/claude-b.md']);
  assert.equal(fragmentFor('claude/Build_Pipeline'), 'changes/claude-build-pipeline.md');
  assert.deepEqual(fragmentBody(`minor: true\n\n## whatever\n\n${ENTRY('Big.')}`), { body: ENTRY('Big.').trim(), minor: true });
  assert.deepEqual(fragmentBody(ENTRY('Small.')), { body: ENTRY('Small.').trim(), minor: false });
  assert.equal(fragmentBody('\n  \n'), null);
});

test('several fragments make one entry: their headlines, their bullets, and "Before you update" saying nothing only when none does', () => {
  const two = composeEntry(ENTRY('Faster pages.'), `**Fixes a crash.**\n\n### What's new\n\n- A button.\n\n### What changed\n\n- The crash.\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n`);
  assert.equal(two, "**Brings 2 changes: Faster pages; Fixes a crash.**\n\n### What's new\n\n- A button.\n\n### What changed\n\n- Faster pages.\n- The crash.\n\n### Before you update\n\n- Nothing: it updates itself as usual.");
  const three = composeEntry(two, ENTRY('Moves a setting.', 'The setting moved to Pages.'));
  assert.match(three, /^\*\*Brings 3 changes: Faster pages; Fixes a crash; Moves a setting\.\*\*/);
  assert.match(three, /### Before you update\n\n- The setting moved to Pages\.$/);
});

test("a fragment joins the waiting version's entry, or starts the next one; a minor step renames the waiting one", () => {
  const log = "# Fake's changelog\n\n## 0.4.1\n\n**Something else.**\n\n### What changed\n\n- Something else.\n\n## 0.4.0\n\n**First.**\n";
  const joined = addToEntry(log, 'Fake', '0.4.1', ENTRY('A feature.').trim());
  assert.deepEqual(joined.split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.1', '## 0.4.0']);
  assert.match(joined, /## 0\.4\.1\n\n\*\*Brings 2 changes: Something else; A feature\.\*\*/);
  const renamed = addToEntry(log, 'Fake', '0.5.0', ENTRY('Big.').trim(), '0.4.1');
  assert.deepEqual(renamed.split('\n').filter((l) => l.startsWith('## ')), ['## 0.5.0', '## 0.4.0']);
  const fresh = addToEntry(log, 'Fake', '0.4.2', ENTRY('New.').trim());
  assert.deepEqual(fresh.split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.2', '## 0.4.1', '## 0.4.0']);
  assert.equal(addToEntry(log.replace(/\n/g, '\r\n'), 'Fake', '0.4.1', 'x').includes('\r\n'), true, 'its line endings kept');
});

/**
 * A fake repository on changes/: main at 0.4.1 (its entry "Something else."), then a PR its author merged that brings a
 * fragment, unstamped. gh stands in: the stamp's PR is opened as #31, and merging it moves origin's main to its head.
 */
function merged(name: string, o: { entry?: string } = {}) {
  const dir = path.join(home, name);
  const { checkout, origin } = fakeEmployee(dir, { version: '0.4.0', files: { [CHANGES_README]: changesReadme('Fake'), 'CHANGELOG.md': "# Fake's changelog\n\n## 0.4.0\n\n**First.**\n" } });
  const write = (f: string, t: string) => (mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true }), writeFileSync(path.join(checkout, f), t));
  const read = (f: string) => readFileSync(path.join(checkout, f), 'utf8');
  for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) write(f, read(f).split('0.4.0').join('0.4.1'));
  write('CHANGELOG.md', read('CHANGELOG.md').replace('## 0.4.0', `## 0.4.1\n\n${ENTRY('Something else.')}\n## 0.4.0`));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Fake 0.4.1: something else');
  write('src/feature.ts', 'export const feature = 1;\n');
  write(fragmentFor('claude/feature'), o.entry ?? ENTRY('A feature.'));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'A feature (#30)');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const head = sh(checkout, 'rev-parse', 'HEAD');
  const r = runner((args) => {
    if (args[0] === 'api' && /\/statuses\?/.test(args[1])) return ok([]);
    if (args[0] === 'pr' && args[1] === 'create') return ok('https://github.com/Jcollier0120/Fake/pull/31\n');
    if (args[0] === 'pr' && args[1] === 'merge') {
      sh(origin, 'update-ref', 'refs/heads/main', args[args.indexOf('--match-head-commit') + 1]);
      return ok('');
    }
  });
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  const at = (f: string) => sh(origin, 'show', `refs/heads/main:${f}`);
  return { e, ctx, at, origin, head, gh: r.gh };
}

test("main's fragment stamped at a build after a release: the next patch, its entry its own, through a PR the Steward opens and merges itself", async () => {
  const p = merged('frag-released');
  const s = await stampMain(p.ctx, p.e, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.ok(s);
  assert.equal(s.done, true, s.note);
  assert.equal(s.version, '0.4.2');
  assert.equal(s.url, 'https://github.com/Jcollier0120/Fake/pull/31');
  assert.match(s.note, /^stamped v0\.4\.2, and merged it$/);
  assert.equal(JSON.parse(p.at('package.json')).version, '0.4.2');
  assert.deepEqual(p.at('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.2', '## 0.4.1', '## 0.4.0']);
  assert.match(p.at('CHANGELOG.md'), /## 0\.4\.2\n\n\*\*A feature\.\*\*/);
  assert.equal(sh(p.origin, 'ls-tree', '-r', '--name-only', 'refs/heads/main', 'changes/'), CHANGES_README, 'the fragment gone');
  // On a branch of its own, never pushed to main: its PR opened, and merged at the stamp's head.
  assert.equal(sh(p.origin, 'rev-parse', `refs/heads/${stampBranch(p.head)}`), sh(p.origin, 'rev-parse', 'refs/heads/main'));
  const create = p.gh.find((a) => a[0] === 'pr' && a[1] === 'create')!;
  assert.deepEqual(create.slice(0, 10), ['pr', 'create', '--repo', 'Jcollier0120/Fake', '--base', 'main', '--head', stampBranch(p.head), '--title', 'Fake 0.4.2: version and changelog, stamped by the Steward']);
  assert.match(create.at(-1)!, /Only version lines, CHANGELOG\.md and the changes files they came from change\. Opened and merged by the Steward at a build/);
  assert.deepEqual(mergesOf(p.gh), [['pr', 'merge', '31', '--repo', 'Jcollier0120/Fake', '--merge', '--delete-branch']]);
});

test('stamped while main waits to release: it joins that version and its one entry, so the build releases once', async () => {
  const p = merged('frag-waiting');
  const s = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: [] });
  assert.ok(s);
  assert.equal(s.done, true, s.note);
  assert.equal(s.version, '0.4.1');
  assert.match(s.note, /v0\.4\.1, its entry joining the changes that release brings/);
  assert.equal(JSON.parse(p.at('package.json')).version, '0.4.1');
  assert.deepEqual(p.at('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.1', '## 0.4.0']);
  assert.match(p.at('CHANGELOG.md'), /\*\*Brings 2 changes: Something else; A feature\.\*\*/);
});

test('a minor step asked for while main waits on a patch: the waiting version becomes the minor one', async () => {
  const p = merged('frag-minor', { entry: `minor: true\n\n${ENTRY('Big.')}` });
  const s = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: [] });
  assert.ok(s);
  assert.equal(s.done, true, s.note);
  assert.equal(s.version, '0.5.0');
  assert.equal(JSON.parse(p.at('package.json')).version, '0.5.0');
  assert.deepEqual(p.at('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.5.0', '## 0.4.0']);
});

test('main with nothing to stamp: no worktree, no PR', async () => {
  const dir = path.join(home, 'frag-none');
  const { checkout } = fakeEmployee(dir, { version: '0.4.0' });
  const r = runner();
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  assert.equal(await stampMain(ctx, e, { released: ['0.4.0'], taken: [] }), null);
  assert.deepEqual(r.gh, []);
  assert.equal(existsSync(path.join(dir, 'work', 'fake-stamp')), false);
});

test("a round between builds releases nothing; the build's round releases main's unreleased version, once, and tells Manor once", async () => {
  const dir = path.join(home, 'build-round');
  const f = fakeEmployee(dir, { version: '0.4.0' });
  // Main at 0.4.1, merged by its author; 0.4.0 is the newest release.
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', '0.4.1'));
  sh(f.checkout, 'commit', '--quiet', '-am', 'Fake 0.4.1');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  // The release command notes each version it's asked to release.
  const attempts = path.join(home, 'build-attempts.txt');
  const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
  const released = () => (existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : []);
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '' }],
      team: ['Jcollier0120'],
      workRoot: path.join(dir, 'work'),
      // Manor's update check, told of a build's releases (the tell below stands in for it).
      afterRelease: ['http://127.0.0.1:9/api/updates/check'],
      buildPipeline: { times: ['08:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], kit: 'every', windowMinutes: 30 },
    }),
  );
  // The 08:00 build has been and gone.
  savePipeline({ open: null, builds: [{ due: at(8).toISOString(), by: 'schedule', started: at(8).toISOString(), finished: at(8, 30).toISOString(), rounds: 1, merged: [], released: [], failed: [] }] });
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([]);
    if (args[0] === 'release' && args[1] === 'list') return ok([...released().map((v) => ({ tagName: `v${v}`, isDraft: false })), { tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'release' && args[1] === 'view') return ok({ targetCommitish: head });
    // A team member vouched for main's head: the build doesn't test it again.
    if (args[0] === 'api' && args[1] === `repos/Jcollier0120/Fake/commits/${head}/statuses?per_page=100`) return ok([{ context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } }]);
  });
  let told = 0;
  const round = (now: Date) => runStage('round', {}, { run: r.run, now: () => now, pipeline: true, alarms: { manorUrl: 'http://127.0.0.1:9' }, tell: async () => (told++, { ok: true, said: 'HTTP 200' }) });

  const between = await round(at(10));
  assert.equal(between.error, undefined);
  assert.deepEqual(between.build, { between: true, next: at(8, 0, 14).toISOString() });
  assert.match(between.log.join('\n'), /between builds: PRs are merged by whoever wrote them once vouched, and the next build, at Wed 08:00,? releases each repository's main/);
  assert.deepEqual(released(), [], 'nothing released between builds');
  assert.equal(told, 0);
  assert.equal(loadPipeline().open, null);

  const build = await round(at(8, 2, 14));
  assert.equal(build.error, undefined);
  const log = build.log.join('\n');
  assert.match(log, /the 08:00 build begins: each repository's main tested once \(unless a vouch covers it\) and released once it has all settled/);
  assert.match(log, new RegExp(`\\[fake\\] Jcollier0120 vouched for ${head.slice(0, 7)}: not tested again before its release`));
  assert.deepEqual(build.results.filter((x) => x.outcome !== 'skipped').map((x) => [x.outcome, x.message]), [['done', `release: released v0.4.1 from origin/main (${head.slice(0, 7)}), with kit 1.0.0`]]);
  assert.deepEqual(released(), ['0.4.1'], 'released once');
  assert.equal(build.build?.closed, true);
  assert.match(log, /the build ends: 1 release/);
  assert.equal(told, 1, 'Manor told once, as the build ends');
  const state = loadPipeline();
  assert.equal(state.open, null);
  assert.deepEqual([state.builds.at(-1)!.due, state.builds.at(-1)!.released], [at(8, 0, 14).toISOString(), ['fake v0.4.1']]);

  // Between builds again: nothing more released, nothing told.
  const later = await round(at(9, 0, 14));
  assert.equal(later.build?.between, true);
  assert.deepEqual(released(), ['0.4.1']);
  assert.equal(told, 1);
});
