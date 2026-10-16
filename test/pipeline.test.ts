import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The build pipeline: rounds that merge and release only at set build times, each repository released once a build, and
// fragments (changes/<branch>.md) that pick no version, given the next release's as they merge.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-pipeline-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { boardedUrgent, DEFAULT_PIPELINE, endRound, kitRides, lastBuildTime, lateLine, nextBuildTime, normalizePipeline, pipelineMode, pipelineView, urgentKey } = await import('../src/pipeline.ts');
const { addToEntry, composeEntry, CHANGES_README, changesReadme, fragmentBody, fragmentFiles, fragmentFor } = await import('../src/entries.ts');
const { stamp } = await import('../src/stages/stamp.ts');
const { prVersions } = await import('../src/stages/merge.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;
type PipelineState = import('../src/pipeline.ts').PipelineState;

/** Three builds a day, as before the defaults were four. */
const THREE = { ...DEFAULT_PIPELINE, times: ['08:00', '13:00', '18:00'] };
/** A local time on 2026-10-13 (a Tuesday), or another day of that month. */
const at = (h: number, m = 0, day = 13) => new Date(2026, 9, day, h, m);
const none: PipelineState = { open: null, builds: [] };

test("the pipeline's settings: no switch, four builds a day to start with, each value checked, a bad one its default", () => {
  assert.deepEqual(normalizePipeline(undefined), DEFAULT_PIPELINE);
  assert.deepEqual(DEFAULT_PIPELINE.times, ['00:00', '06:00', '12:00', '18:00']);
  assert.deepEqual([DEFAULT_PIPELINE.days.length, DEFAULT_PIPELINE.kit, DEFAULT_PIPELINE.windowMinutes], [7, 'every', 120]);
  assert.equal('on' in DEFAULT_PIPELINE, false, 'no switch');
  // A settings.json saved while there was a switch, off or on: it builds at its times all the same.
  assert.deepEqual(normalizePipeline({ on: false }), DEFAULT_PIPELINE);
  assert.deepEqual(normalizePipeline({ on: false, times: ['07:30'] }), { ...DEFAULT_PIPELINE, times: ['07:30'] });
  const p = normalizePipeline({ on: true, times: ['18:00', '8:00', 'noon', '08:00', '24:00'], days: ['mon', 'fri', 'xyz'], kit: 'first', windowMinutes: 9999 });
  assert.deepEqual(p, { times: ['08:00', '18:00'], days: ['mon', 'fri'], kit: 'first', windowMinutes: 360, bisectRuns: 3 });
  assert.deepEqual(normalizePipeline({ times: ['nope'], kit: 'sometimes', windowMinutes: 'x' }).times, DEFAULT_PIPELINE.times);
  assert.equal(normalizePipeline({ windowMinutes: 1 }).windowMinutes, 15);
  assert.equal(DEFAULT_PIPELINE.bisectRuns, 3);
  assert.deepEqual([0, '5', 99, 1.5].map((bisectRuns) => normalizePipeline({ bisectRuns }).bisectRuns), [0, 5, 6, 3]);
});

test("Settings: no switch shown; Manor's save of the group with its old switch, off, is taken, and the switch left out", async () => {
  const { SETTINGS_SPEC, loadSettings } = await import('../src/settings.ts');
  const { saveSettingsReply, schemaFor } = await import('../src/kit/settings-kit.ts');
  const group = SETTINGS_SPEC.schema.find((f) => f.key === 'buildPipeline');
  assert.ok(group && group.kind === 'group');
  const on = group.fields.find((f) => f.key === 'on');
  assert.equal(on?.hidden && on.optional, true, 'kept for older Manors, never drawn');
  assert.doesNotMatch(group.help ?? '', /\bOff\b/);
  assert.ok(schemaFor(SETTINGS_SPEC.schema, true).some((f) => f.key === 'buildPipeline'));
  const r = await saveSettingsReply(SETTINGS_SPEC, { values: { buildPipeline: { on: false, times: ['07:00', '19:00'], days: ['mon', 'tue', 'wed', 'thu', 'fri'], kit: 'every', windowMinutes: 90, bisectRuns: 3 } } }, true);
  assert.equal((r.json as { ok?: boolean }).ok, true, JSON.stringify(r.json));
  const stored = JSON.parse(readFileSync(SETTINGS_SPEC.file(), 'utf8'));
  assert.equal('on' in stored.buildPipeline, false);
  assert.deepEqual(loadSettings().buildPipeline, { times: ['07:00', '19:00'], days: ['mon', 'tue', 'wed', 'thu', 'fri'], kit: 'every', windowMinutes: 90, bisectRuns: 3 });
  rmSync(SETTINGS_SPEC.file(), { force: true });
});

test("the old default times, stored when the switch was turned on, were never chosen: they take today's four; other times stay", async () => {
  const { SETTINGS_SPEC, loadSettings } = await import('../src/settings.ts');
  // As Settings saved the whole group when the owner turned the switch on.
  const saved = { on: true, times: ['08:00', '13:00', '18:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], kit: 'every', windowMinutes: 120, bisectRuns: 3 };
  mkdirSync(path.dirname(SETTINGS_SPEC.file()), { recursive: true });
  writeFileSync(SETTINGS_SPEC.file(), JSON.stringify({ buildPipeline: saved }));
  assert.deepEqual(loadSettings().buildPipeline, DEFAULT_PIPELINE);
  rmSync(SETTINGS_SPEC.file(), { force: true });
  assert.deepEqual(normalizePipeline({ times: ['18:00', '8:00', '13:00'] }).times, DEFAULT_PIPELINE.times, 'the same three, written another way');
  // Any other list is the owner's.
  for (const times of [['08:00', '13:00'], ['08:00', '13:00', '18:00', '21:00'], ['08:00', '12:00', '18:00'], ['07:30']]) {
    assert.deepEqual(normalizePipeline({ ...saved, times }).times, times);
  }
  assert.deepEqual(normalizePipeline({ ...saved, kit: 'first', windowMinutes: 90 }), { ...DEFAULT_PIPELINE, kit: 'first', windowMinutes: 90 }, 'the rest of the group stays');
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
    assert.match(m.line, /ready PRs wait for the next build, at 13:00/);
  }
});

test('a build begins at its time, once, even when the PC slept through it; it goes on until it settles or its time runs out', () => {
  const first = pipelineMode(THREE, none, at(8, 2));
  assert.equal(first.kind, 'build');
  if (first.kind !== 'build') return;
  assert.equal(first.fresh, true);
  assert.equal(first.run.due, at(8).toISOString());
  assert.equal(first.run.by, 'schedule');
  // Its first round ends with something still settling: the build stays open.
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
});

test("an urgent fix between builds begins a build of its own, for its repository; once at its head; a build time's takes it with the rest", () => {
  const done: PipelineState = { open: null, builds: [{ due: at(8).toISOString(), by: 'schedule', started: at(8).toISOString(), finished: at(8, 40).toISOString(), rounds: 3, merged: [], released: [], failed: [] }] };
  const fix = { id: 'porter', number: 12, head: 'a1b2c3' };
  const m = pipelineMode(THREE, done, at(10), { urgent: [fix, { id: 'porter', number: 14, head: 'd4e5f6' }] });
  assert.equal(m.kind, 'build');
  if (m.kind !== 'build') return;
  assert.deepEqual([m.fresh, m.run.by, m.run.due, m.run.employees, m.run.urgent], [true, 'urgent', at(10).toISOString(), ['porter'], ['porter #12 a1b2c3', 'porter #14 d4e5f6']]);
  assert.equal(urgentKey(fix), 'porter #12 a1b2c3');
  // A build time come: its build, for every repository, takes the urgent fix with the rest.
  const due = pipelineMode(THREE, done, at(13, 1), { urgent: [fix] });
  assert.equal(due.kind === 'build' && due.run.by === 'schedule' && !due.run.employees && !due.run.urgent, true);
  // Kept once it ends: that PR at that head never boards again; at a new head it may.
  const state = endRound(done, m.run, { merged: ['porter #12'], released: ['porter v0.4.28'], failed: [], closed: true, now: at(10, 20) });
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

/** A fake repository on changes/, main at 0.4.1, with a PR that adds a fragment. */
function pending(name: string, o: { entry?: string } = {}) {
  const dir = path.join(home, name);
  const { checkout, origin } = fakeEmployee(dir, { version: '0.4.0', files: { [CHANGES_README]: changesReadme('Fake'), 'CHANGELOG.md': "# Fake's changelog\n\n## 0.4.0\n\n**First.**\n" } });
  const write = (f: string, t: string) => (mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true }), writeFileSync(path.join(checkout, f), t));
  const read = (f: string) => readFileSync(path.join(checkout, f), 'utf8');
  sh(checkout, 'switch', '--quiet', '-c', 'claude/feature');
  write('src/feature.ts', 'export const feature = 1;\n');
  write(fragmentFor('claude/feature'), o.entry ?? ENTRY('A feature.'));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'A feature');
  sh(checkout, 'push', '--quiet', 'origin', 'claude/feature');
  const headOid = sh(checkout, 'rev-parse', 'HEAD');
  sh(checkout, 'switch', '--quiet', 'main');
  for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) write(f, read(f).split('0.4.0').join('0.4.1'));
  write('CHANGELOG.md', read('CHANGELOG.md').replace('## 0.4.0', `## 0.4.1\n\n${ENTRY('Something else.')}\n## 0.4.0`));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Fake 0.4.1: something else');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const pr: PrInfo = { number: 31, title: 'Fake: a feature', url: 'https://github.com/Jcollier0120/Fake/pull/31', head: 'claude/feature', base: 'main', author: 'Jcollier0120', whose: 'team', headOid, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 10, files: [], fork: false };
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: runner(() => ok('')).run, neutralDir: dir });
  const at = (f: string) => sh(origin, 'show', `refs/heads/claude/feature:${f}`);
  return { pr, e, ctx, at, origin };
}

test("a fragment PR sets no version of its own: it isn't queued, and merges as one that leaves the version alone", async () => {
  const p = pending('frag-versions');
  const v = await prVersions(p.ctx, p.e, p.pr);
  assert.deepEqual(v.fragments, ['changes/claude-feature.md']);
  assert.equal(v.entries, undefined);
  assert.equal(v.head, v.from);
});

test('stamped after a release: the next patch, its entry its own', async () => {
  const p = pending('frag-released');
  const s = await stamp(p.ctx, p.e, p.pr, { released: ['0.4.0', '0.4.1'], taken: [], carry: null });
  assert.equal(s.done, true, s.note);
  assert.equal(s.version, '0.4.2');
  assert.equal(JSON.parse(p.at('package.json')).version, '0.4.2');
  assert.deepEqual(p.at('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.2', '## 0.4.1', '## 0.4.0']);
  assert.match(p.at('CHANGELOG.md'), /## 0\.4\.2\n\n\*\*A feature\.\*\*/);
  assert.equal(sh(p.origin, 'ls-tree', '-r', '--name-only', 'refs/heads/claude/feature', 'changes/'), CHANGES_README, 'the fragment gone');
});

test('stamped while main waits to release: it joins that version and its one entry, so the build releases once', async () => {
  const p = pending('frag-waiting');
  const s = await stamp(p.ctx, p.e, p.pr, { released: ['0.4.0'], taken: [], carry: null });
  assert.equal(s.done, true, s.note);
  assert.equal(s.version, '0.4.1');
  assert.match(s.note, /v0\.4\.1, its entry joining the changes that release brings/);
  assert.equal(JSON.parse(p.at('package.json')).version, '0.4.1');
  assert.deepEqual(p.at('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.1', '## 0.4.0']);
  assert.match(p.at('CHANGELOG.md'), /\*\*Brings 2 changes: Something else; A feature\.\*\*/);
});

test('a minor step asked for while main waits on a patch: the waiting version becomes the minor one', async () => {
  const p = pending('frag-minor', { entry: `minor: true\n\n${ENTRY('Big.')}` });
  const s = await stamp(p.ctx, p.e, p.pr, { released: ['0.4.0'], taken: [], carry: null });
  assert.equal(s.done, true, s.note);
  assert.equal(s.version, '0.5.0');
  assert.equal(JSON.parse(p.at('package.json')).version, '0.5.0');
  assert.deepEqual(p.at('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.5.0', '## 0.4.0']);
});
