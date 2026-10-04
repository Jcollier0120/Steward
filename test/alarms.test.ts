import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// What needs the person: conditions from the round, Manor and the Surveyor; an alarm once one lasts its while,
// raised once with one toast, kept until it clears; dismissed until it clears and comes back.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-alarms-'));
process.env.STEWARD_HOME = home;
// The Wright is installed on the PC these tests run on, or not: neither may decide the defaults here.
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
after(() => rmSync(home, { recursive: true, force: true }));

const alarmsModule = await import('../src/alarms.ts');
const { alarmsFile, dismiss, loadAlarms, manorConditions, reconcile, roundConditions, surveyorConditions, toastWords, watchAlarms, wrightConditions } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS, DEFAULT_EMPLOYEES, normalizeSettings } = await import('../src/settings.ts');
const { alarmsCard } = await import('../src/view.ts');

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-04T08:00:00Z');
const at = (h: number) => new Date(T0 + h * HOUR);
const empty = () => ({ at: null, watching: {}, open: [], cleared: [] });
const cond = (id: string, afterMs: number, more = {}) => ({ id, who: 'porter', title: `Title of ${id}`, detail: ['a fact'], afterMs, ...more });
const settings = structuredClone(DEFAULT_SETTINGS);
const porter = DEFAULT_EMPLOYEES.find((e) => e.id === 'porter')!;
const roundResult = (more = {}) => ({ stage: 'round' as const, started: at(0).toISOString(), finished: at(0).toISOString(), kit: null, asked: {}, results: [], log: [], ...more });

test('a condition is an alarm once it has lasted its while, raised once, and cleared when it goes', () => {
  let r = reconcile(empty(), [cond('a', 2 * HOUR)], at(0));
  assert.deepEqual([r.state.open.length, r.raised.length, r.state.watching.a], [0, 0, at(0).toISOString()], 'seen, not yet an alarm');
  r = reconcile(r.state, [cond('a', 2 * HOUR)], at(1));
  assert.equal(r.state.open.length, 0);
  r = reconcile(r.state, [cond('a', 2 * HOUR)], at(2));
  assert.deepEqual(r.raised.map((x) => x.id), ['a']);
  assert.equal(r.state.open[0].since, at(0).toISOString(), 'since it was first seen');
  r = reconcile(r.state, [cond('a', 2 * HOUR, { title: 'Its words changed' })], at(3));
  assert.deepEqual(r.raised, [], 'not raised again');
  assert.deepEqual([r.state.open[0].title, r.state.open[0].raisedAt], ['Its words changed', at(2).toISOString()]);
  r = reconcile(r.state, [], at(4));
  assert.deepEqual([r.state.open.length, r.state.cleared[0].id, r.state.cleared[0].clearedAt, Object.keys(r.state.watching).length], [0, 'a', at(4).toISOString(), 0]);
  r = reconcile(r.state, [cond('a', 2 * HOUR)], at(5));
  assert.equal(r.state.open.length, 0, 'back again: its while starts over');
});

test("a source's own since counts, and an alarm with no wait is raised at once", () => {
  const r = reconcile(empty(), [cond('found', 6 * HOUR, { since: at(-7).toISOString() }), cond('now', 0)], at(0));
  assert.deepEqual(r.raised.map((x) => x.id).sort(), ['found', 'now']);
});

test('dismissed, an alarm stays open but quiet until it clears; back again, it is raised anew', () => {
  writeFileSync(alarmsFile(), JSON.stringify(reconcile(empty(), [cond('x', 0)], at(0)).state));
  assert.equal(dismiss('nothing'), false);
  assert.equal(dismiss('x', at(1)), true);
  let r = reconcile(loadAlarms(), [cond('x', 0)], at(2));
  assert.deepEqual([r.raised.length, r.state.open[0].dismissedAt], [0, at(1).toISOString()]);
  r = reconcile(r.state, [], at(3));
  r = reconcile(r.state, [cond('x', 0)], at(4));
  assert.deepEqual([r.raised.length, r.state.open[0].dismissedAt], [1, undefined]);
});

test('from the round: a PR held a while, a release the rounds gave up on, a round that cannot run', () => {
  const held = [{ employee: porter, prs: [{ number: 12, url: 'https://github.com/Jcollier0120/Porter/pull/12', title: 'Porter 0.4.11: a thing', why: 'a draft', draft: true }] }];
  const round = roundResult({ error: 'gh: not signed in', results: [{ id: 'porter', name: 'Porter', outcome: 'failed', message: 'release: npm run release failed: no network' }] });
  const c = roundConditions({ round, held, failedReleases: { porter: 'abc1234' }, employees: DEFAULT_EMPLOYEES, settings });
  const by = (id: string) => c.find((x) => x.id === id)!;
  const w = by('waiting:Jcollier0120/Porter#12');
  assert.deepEqual([w.afterMs, w.url, w.title], [24 * HOUR, 'https://github.com/Jcollier0120/Porter/pull/12', 'Porter #12 has waited 24 hours or more: a draft']);
  assert.match(w.detail.join('\n'), /mark it ready/);
  const rel = by('release:porter:abc1234');
  assert.deepEqual([rel.afterMs, rel.detail[0]], [0, 'npm run release failed: no network']);
  assert.equal(by('round').afterMs, HOUR);
});

test("from Manor: an update it couldn't install, its checks failing, its page down", () => {
  const c = manorConditions({ updates: { problem: 'GitHub said 503', items: [{ id: 'miller', name: 'Miller', installed: '0.4.9', latest: '0.4.10', error: 'EBUSY: the folder is open', url: 'u' }, { id: 'porter', name: 'Porter', error: null }] } });
  assert.deepEqual(c.map((x) => [x.id, x.afterMs / HOUR]), [['install:miller', 2], ['manor:updates', 12]]);
  assert.equal(c[0].title, "Manor couldn't update Miller");
  assert.deepEqual(manorConditions({ error: 'ECONNREFUSED' }).map((x) => [x.id, x.detail[0]]), [['manor:down', 'ECONNREFUSED']]);
});

test("from the Surveyor: its problems from when it first saw them, never its warnings; its page down", () => {
  const c = surveyorConditions({ findings: [
    { id: 'pc.disk.C', subject: 'pc', severity: 'problem', title: 'Drive C: has 4.0 GB free (1%)', evidence: ['C: 4.0 GB free of 476.0 GB'], fix: 'Start-Process ms-settings:storagesense', since: at(-1).toISOString() },
    { id: 'pc.claude-idle', subject: 'pc', severity: 'warning', title: '8 idle Claude Code sessions hold 1.6 GB', evidence: [] },
  ] }, settings);
  assert.deepEqual(c.map((x) => [x.id, x.since, x.afterMs / HOUR]), [['survey:pc.disk.C', at(-1).toISOString(), 6]]);
  assert.deepEqual(c[0].detail, ['C: 4.0 GB free of 476.0 GB', 'Fix: Start-Process ms-settings:storagesense']);
  assert.equal(surveyorConditions({ error: 'timeout' }, settings)[0].id, 'surveyor:down');
});

test('after a round: everything reconciled into alarms.json, and one toast for what was raised', async () => {
  rmSync(alarmsFile(), { force: true });
  const toasts: [string, string][] = [];
  const pages = { 'http://m/api/state': { updates: { items: [{ id: 'miller', name: 'Miller', error: 'EBUSY' }] } }, 'http://127.0.0.1:19595/api/survey': { findings: [] }, 'http://127.0.0.1:19797/api/work': { needsYou: [] } } as Record<string, unknown>;
  const s = structuredClone(settings);
  const deps = (h: number) => ({ getJson: async (u: string) => pages[u] ?? { error: 'none' }, toast: async (t: string, b: string) => void toasts.push([t, b]), now: at(h), manorUrl: 'http://m' });
  const run = (h: number) => watchAlarms({ settings: s, round: roundResult(), held: [], failedReleases: { porter: 'abc1234' }, employees: DEFAULT_EMPLOYEES, log: () => {} }, deps(h));
  await run(0);
  assert.deepEqual(toasts, [['Steward: this needs you', "Porter's release failed at abc1234, and the rounds won't try it again"]], 'the release at once; the install waits two hours');
  await run(1);
  assert.equal(toasts.length, 1);
  const st = await run(2);
  assert.deepEqual(toasts[1], ['Steward: this needs you', "Manor couldn't update Miller"]);
  assert.deepEqual(st.open.map((a) => a.id).sort(), ['install:miller', 'release:porter:abc1234']);
  assert.deepEqual(loadAlarms().open.length, 2, 'kept in alarms.json');
  s.alarms.toast = false;
  pages['http://127.0.0.1:19595/api/survey'] = { error: 'x' };
  await run(5);
  assert.equal(toasts.length, 2, 'no toast when Settings say none');
  s.alarms.on = false;
  rmSync(alarmsFile());
  await run(6);
  assert.ok(!existsSync(alarmsFile()), 'off: nothing watched');
  assert.deepEqual(toastWords([{ title: 'A' }, { title: 'B' }] as any), { title: 'Steward: 2 things need you', body: 'A\nB' });
});

test("the alarms' settings: on with a toast by default, and what they refuse", () => {
  assert.deepEqual(normalizeSettings({}).settings.alarms, DEFAULT_SETTINGS.alarms);
  const a = normalizeSettings({ alarms: { on: false, waitingHours: 1000, problemHours: 'many', manorUrl: 'https://example.com', surveyorUrl: '' } }).settings.alarms;
  assert.deepEqual([a.on, a.toast, a.waitingHours, a.problemHours, a.manorUrl, a.surveyorUrl], [false, true, 168, 6, 'http://127.0.0.1:18585', '']);
});

test('the page: what needs you at the top, each with Dismiss; the dismissed and the cleared folded away', () => {
  const st = reconcile(empty(), [cond('waiting:x#1', 0, { title: 'Porter #1 <waits>', url: 'https://github.com/x/pull/1' }), cond('quiet', 0)], at(0)).state;
  st.open[1].dismissedAt = at(0).toISOString();
  const html = alarmsCard(st);
  assert.match(html, /<h2>Needs you<\/h2>/);
  assert.match(html, /Porter #1 &lt;waits&gt;/);
  assert.match(html, /data-post="\/api\/alarms\/dismiss"/);
  assert.match(html, /1 dismissed/);
  assert.equal(alarmsCard({ ...empty() }), '', 'nothing to say');
});

test("from the Wright: an issue it got stuck on and a PR a person reviews, at once; its page down, after two hours", () => {
  const c = wrightConditions({ needsYou: [
    { id: 'stuck:Jcollier0120/Porter#28', kind: 'stuck', repo: 'Jcollier0120/Porter', number: 28, title: 'Drop the dead feed', url: 'https://github.com/Jcollier0120/Porter/issues/28' },
    { id: 'review:Jcollier0120/Reeve#33', kind: 'review', repo: 'Jcollier0120/Reeve', number: 33, title: 'Reeve 0.4.6: fast-forward release branches too', url: 'https://github.com/Jcollier0120/Reeve/pull/33' },
    { not: 'one' },
  ] });
  assert.deepEqual(c.map((x) => [x.id, x.afterMs, x.url]), [
    ['wright:stuck:Jcollier0120/Porter#28', 0, 'https://github.com/Jcollier0120/Porter/issues/28'],
    ['wright:review:Jcollier0120/Reeve#33', 0, 'https://github.com/Jcollier0120/Reeve/pull/33'],
  ]);
  assert.equal(c[0].title, 'The Wright got stuck on Porter #28: Drop the dead feed');
  assert.equal(c[1].title, 'Reeve #33 needs your review: the Wright changed what a person reviews');
  assert.equal(wrightConditions({ needsYou: [{ id: 'claude:blocked', kind: 'blocked', repo: '', number: 0, title: "Claude Code isn't signed in", url: 'http://wright.localhost:19797/' }] })[0].title, "The Wright can't work: Claude Code isn't signed in");
  assert.deepEqual(wrightConditions({ error: 'ECONNREFUSED' }).map((x) => [x.id, x.afterMs / HOUR]), [['wright:down', 2]]);
});

test("an answer with an error field of its own is still an answer: only getJson's { error } is no answer", () => {
  const { noAnswer } = alarmsModule;
  assert.equal(noAnswer({ error: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(noAnswer(null), 'no answer');
  assert.equal(noAnswer({ at: 'x', needsYou: [], error: null }), null, "the Wright's work, all well");
  assert.equal(noAnswer({ at: 'x', needsYou: [], error: "Couldn't read the queue" }), null, 'up, though it could not read something');
  assert.deepEqual(wrightConditions({ at: 'x', needsYou: [], error: null }), [], 'nothing needs you, and it answers');
  assert.equal(wrightConditions({ needsYou: [{ id: 'claude:blocked', kind: 'blocked', repo: '', number: 0, title: 'not signed in', url: 'u' }], error: null })[0].id, 'wright:claude:blocked');
});