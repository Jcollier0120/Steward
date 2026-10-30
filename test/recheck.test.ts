import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// The alarms looked at again between rounds (recheck.ts, POST /api/alarms/recheck): what the files the stages keep and the
// pages on this PC say now, and one cheap look at GitHub for each alarm it backs. gh stands in for GitHub; a fake
// employee's git for the checkout; nothing reaches the live ~/.steward.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-recheck-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
process.env.MANOR_HOME = path.join(home, 'no-manor');
after(() => rmSync(home, { recursive: true, force: true }));

const { alarmsFile, loadAlarms, reconcile } = await import('../src/alarms.ts');
const { LOOK_EVERY_MS, recheckAlarms, rechecker } = await import('../src/recheck.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');
const { roundFailuresFile } = await import('../src/stages/round.ts');
const { selfFailedFile } = await import('../src/stages/self.ts');
const { rolloutFailedFile } = await import('../src/stages/rollout.ts');
const { budgetFile } = await import('../src/budget.ts');
const { claimsFile } = await import('../src/claims.ts');
const { staffFile } = await import('../src/steward.ts');
const { employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type Condition = import('../src/alarms.ts').Condition;

const NOW = new Date('2026-10-30T14:30:00Z');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const cond = (id: string, more: Partial<Condition> = {}): Condition => ({ id, who: 'fake', title: `Title of ${id}`, detail: ['as the round said it'], afterMs: 0, since: '2026-10-30T10:00:00.000Z', ...more });
/** alarms.json as a round left it, open with these conditions. */
const leave = (conditions: Condition[]) => writeFileSync(alarmsFile(), JSON.stringify(reconcile({ at: null, watching: {}, open: [], cleared: [] }, conditions, new Date('2026-10-30T14:20:00Z')).state));
const ids = () => loadAlarms().open.map((a) => a.id);

beforeEach(() => {
  for (const f of [alarmsFile(), roundFailuresFile(), selfFailedFile(), rolloutFailedFile(), budgetFile(), claimsFile(), staffFile()]) rmSync(f, { force: true });
});

const fake = fakeEmployee(path.join(home, 'fake'));
const e = employee(fake.checkout);
const settings = { ...structuredClone(DEFAULT_SETTINGS), employees: [e], stewardRepo: 'octocat/steward', releaseSelf: true, rollout: true, fileWork: false, releasesCastellan: false };
settings.alarms = { ...settings.alarms, on: true, toast: false };
const base = { settings, neutralDir: home, log: () => {} };
const deps = { getJson: async () => ({ error: 'nothing here' }), manorUrl: null, pages: {}, now: NOW, online: async () => true };

test("between rounds, what the stages' files say now: a release let go since clears, and what only a round can say stands as it was", async () => {
  // The round left: a failed release (since released by hand on the page, so round-failed.json lets it go), the rounds
  // unable to run, and a kit's trial; and a round's condition still within its while.
  writeFileSync(roundFailuresFile(), JSON.stringify({}));
  leave([cond('release:fake:abc1234'), cond('round', { who: 'steward' }), cond('kittrial:2.145.0', { who: 'steward' })]);
  const state = json(alarmsFile());
  state.watching['rollout:waits:2.146.0'] = '2026-10-30T13:00:00.000Z';
  writeFileSync(alarmsFile(), JSON.stringify(state));
  const r = runner();
  const out = await recheckAlarms({ ...base, run: r.run, look: false }, deps);
  assert.equal(out.changed, true);
  assert.deepEqual(ids().sort(), ['kittrial:2.145.0', 'round']);
  assert.equal(loadAlarms().cleared[0].id, 'release:fake:abc1234');
  assert.equal(loadAlarms().watching['rollout:waits:2.146.0'], '2026-10-30T13:00:00.000Z', 'still watched, from when the round first saw it, not raised');
  assert.deepEqual(loadAlarms().open.find((a) => a.id === 'round')?.detail, ['as the round said it']);
  assert.deepEqual(r.gh, [], 'GitHub not asked');

  // Nothing changed since: alarms.json isn't written again.
  const before = readFileSync(alarmsFile(), 'utf8');
  assert.equal((await recheckAlarms({ ...base, run: r.run, look: false }, { ...deps, now: new Date(NOW.getTime() + 60_000) })).changed, false);
  assert.equal(readFileSync(alarmsFile(), 'utf8'), before);
});

test("an alarm still so stands as the round worded it; one new since is raised; the Wright's work is read afresh", async () => {
  writeFileSync(roundFailuresFile(), JSON.stringify({ fake: 'abc1234' }));
  leave([cond('release:fake:abc1234', { detail: ['the release command failed: exit 1'] }), cond('wright:fake#3', { who: 'wright' })]);
  // The Wright has dropped #3, and got stuck on #4.
  const work = { needsYou: [{ id: 'fake#4', kind: 'stuck', repo: e.repo, number: 4, title: 'it fails', url: `https://github.com/${e.repo}/issues/4` }] };
  await recheckAlarms({ ...base, run: runner().run, look: false }, { ...deps, pages: { wright: 'http://wright.localhost:1/' }, getJson: async (url: string) => (url.includes('/api/work') ? work : { error: 'nothing here' }) });
  assert.deepEqual(ids().sort(), ['release:fake:abc1234', 'wright:fake#4']);
  assert.deepEqual(loadAlarms().open.find((a) => a.id === 'release:fake:abc1234')?.detail, ['the release command failed: exit 1'], "the round's words kept");
});

test('one look at GitHub for each alarm it backs: a release made since, a branch moved since; each let go in its file as a round would', async () => {
  const commit = sh(fake.checkout, 'rev-parse', '--short=7', 'HEAD');
  writeFileSync(roundFailuresFile(), JSON.stringify({ fake: commit }));
  writeFileSync(selfFailedFile(), JSON.stringify({ 'v0.36.300': { commit: 'f'.repeat(40), message: 'npm ci failed', at: '2026-10-30T10:00:00Z' }, 'v0.36.301': { commit: 'e'.repeat(40), message: 'npm ci failed', at: '2026-10-30T10:00:00Z' }, 'v0.35.1': { commit: 'c'.repeat(40), message: 'npm ci failed', at: '2026-10-29T10:00:00Z' } }));
  writeFileSync(rolloutFailedFile(), JSON.stringify({ fake: { kit: '2.145.0', head: 'd'.repeat(40), stage: 'bump', message: 'its checks failed', at: '2026-10-30T10:00:00Z' } }));
  leave([cond(`release:fake:${commit}`), cond('self:v0.36.300:fffffff', { who: 'steward' }), cond('self:v0.36.301:eeeeeee', { who: 'steward' }), cond('rollout:fake:2.145.0'), cond('self:v0.35.1:ccccccc', { who: 'steward' })]);
  // One the person dismissed is no look's business.
  const state = json(alarmsFile());
  state.open.find((a: any) => a.id === 'self:v0.35.1:ccccccc').dismissedAt = '2026-10-30T11:00:00.000Z';
  writeFileSync(alarmsFile(), JSON.stringify(state));
  // Released since: Fake v0.4.0 (main's version, at the commit that failed) and the Steward's v0.36.300; not v0.36.301.
  const r = runner((a) => (a[0] === 'release' && a[1] === 'view' && ['v0.4.0', 'v0.36.300'].includes(a[2]) ? ok({ tagName: a[2] }) : a[0] === 'release' && a[1] === 'view' ? { code: 1, out: '', err: 'release not found' } : undefined));
  const out = await recheckAlarms({ ...base, run: r.run, look: true }, deps);
  assert.deepEqual(out.looked.sort(), [`release:fake:${commit}`, 'rollout:fake:2.145.0', 'self:v0.36.300:fffffff', 'self:v0.36.301:eeeeeee'].sort());
  assert.deepEqual(out.settled.sort(), [`release:fake:${commit}`, 'rollout:fake:2.145.0', 'self:v0.36.300:fffffff'].sort());
  assert.deepEqual(json(roundFailuresFile()), {});
  assert.deepEqual(Object.keys(json(selfFailedFile())).sort(), ['v0.35.1', 'v0.36.301']);
  assert.deepEqual(json(rolloutFailedFile()), {}, "origin's main isn't where the bump failed: moved");
  assert.deepEqual(ids().sort(), ['self:v0.35.1:ccccccc', 'self:v0.36.301:eeeeeee']);
  assert.deepEqual(
    r.gh.map((a) => a.slice(0, 3).join(' ')).sort(),
    ['release view v0.36.300', 'release view v0.36.301', 'release view v0.4.0'],
    'a release view each, and nothing else',
  );
});

test("a PR passed over, merged since or labelled owner-done: its alarm clears, and the staff's table is made again", async () => {
  const pr = (n: number) => ({ number: n, head: `claude/work-${n}`, title: `Fake 0.4.${n}: work`, labels: ['owner-first'], files: [], draft: false });
  writeFileSync(staffFile(), JSON.stringify({ rows: [{ id: 'fake', name: 'Fake', repo: e.repo, branch: 'main', main: { commit: 'a'.repeat(40), version: '0.4.0' }, release: { version: '0.4.0' }, prs: [pr(51), pr(52), pr(53)] }] }));
  const passed = (n: number) => ({ repo: e.repo, version: `0.4.${n}`, branch: `claude/work-${n}`, by: 'claude', for: 'work', at: '2026-10-30T09:00:00Z', passed: { pr: n, url: `https://github.com/${e.repo}/pull/${n}`, kind: 'owner', why: 'it waits for the owner first (labelled owner-first)', since: '2026-10-30T09:00:00Z', at: '2026-10-30T10:00:00Z', head: 'b'.repeat(40), from: `0.4.${n}` } });
  writeFileSync(claimsFile(), JSON.stringify([passed(51), passed(52), passed(53)]));
  const key = (n: number) => `passedover:${e.repo.toLowerCase()}#${n}`;
  leave([cond(key(51)), cond(key(52)), cond(key(53))]);
  // #51 merged; #52 labelled owner-done; #53 open still, waiting for the owner.
  const view: Record<string, unknown> = { '51': { state: 'MERGED', isDraft: false, labels: [] }, '52': { state: 'OPEN', isDraft: false, labels: [{ name: 'owner-done' }] }, '53': { state: 'OPEN', isDraft: false, labels: [{ name: 'owner-first' }] } };
  const r = runner((a) => (a[0] === 'pr' && a[1] === 'view' ? ok(view[a[2]]) : undefined));
  let refreshed = 0;
  const out = await recheckAlarms({ ...base, run: r.run, look: true, refreshStaff: () => void refreshed++ }, deps);
  assert.deepEqual(out.settled.sort(), [key(51), key(52)]);
  assert.deepEqual(ids(), [key(53)]);
  assert.equal(refreshed, 1);
});

test("GitHub's API budget: no look while it says wait, and none after GitHub refuses the account", async () => {
  writeFileSync(selfFailedFile(), JSON.stringify({ 'v0.36.300': { commit: 'f'.repeat(40), message: 'x', at: '2026-10-30T10:00:00Z' }, 'v0.36.301': { commit: 'e'.repeat(40), message: 'x', at: '2026-10-30T10:00:00Z' } }));
  leave([cond('self:v0.36.300:fffffff', { who: 'steward' }), cond('self:v0.36.301:eeeeeee', { who: 'steward' })]);
  writeFileSync(budgetFile(), JSON.stringify({ graphql: [], glanceCost: 40, limitedUntil: '2026-10-30T15:00:00.000Z', limitedWhy: 'GitHub said so' }));
  const quiet = runner(() => ok({}));
  assert.deepEqual((await recheckAlarms({ ...base, run: quiet.run, look: true }, deps)).looked, []);
  assert.deepEqual(quiet.gh, []);

  rmSync(budgetFile());
  const refused = runner(() => ({ code: 1, out: '', err: 'GraphQL: API rate limit already exceeded for user ID 1.' }));
  const out = await recheckAlarms({ ...base, run: refused.run, look: true }, deps);
  assert.ok(out.looked.length >= 1 && out.settled.length === 0);
  assert.ok(Date.parse(json(budgetFile()).limitedUntil) > NOW.getTime(), 'kept, so the rounds wait too');
  assert.deepEqual(ids().sort(), ['self:v0.36.300:fffffff', 'self:v0.36.301:eeeeeee']);
});

test('the asks: one at a time, GitHub looked at once a minute at most, never while a stage runs', async () => {
  let clock = 0;
  let busy = false;
  const asked: boolean[] = [];
  let release: () => void = () => {};
  let hold: Promise<void> | null = null;
  const ask = rechecker({
    now: () => clock,
    busy: () => busy,
    recheck: async (look) => {
      asked.push(look);
      if (hold) await hold;
      return { looked: look ? ['self:v1:abc'] : [] };
    },
  });
  assert.equal(await ask(), null);
  assert.deepEqual(asked, [true]);
  clock += 15_000;
  await ask();
  assert.deepEqual(asked, [true, false], 'within the minute: no look');
  clock += LOOK_EVERY_MS;
  busy = true;
  await ask();
  assert.deepEqual(asked, [true, false, false], 'a stage runs: no look');
  busy = false;
  // Two asks while one is under way: the second joins it.
  hold = new Promise((r) => (release = r));
  const first = ask();
  const second = ask();
  assert.equal(first, second);
  release();
  await first;
  assert.deepEqual(asked, [true, false, false, true]);
  hold = null;

  const failing = rechecker({ busy: () => false, recheck: async () => Promise.reject(new Error('disk full')) });
  assert.equal(await failing(), 'disk full', 'said, never thrown');
});
