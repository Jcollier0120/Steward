import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// The staff's pages kept up (tend.ts): an agent on duty whose page doesn't answer is opened again through Manor, a few
// tries then one an hour, and an alarm once its tries are spent; and a round on a PC with no repositories asks GitHub
// nothing and does just this.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-tend-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { MAX_TRIES, RETRY_MS, SPENT_RETRY_MS, loadTending, staffFromState, tend, tendConditions, tendFile } = await import('../src/tend.ts');
const { reposHere, runStage, lastStageFile } = await import('../src/steward.ts');
const { takeGlance } = await import('../src/glance.ts');
const { normalizeSettings } = await import('../src/settings.ts');
const { loadAlarms } = await import('../src/alarms.ts');
const { fakeEmployee, runner } = await import('./helpers.ts');

/** An agent as Manor's /api/state shows a role's holder. */
const agent = (id: string, o: { up?: boolean; state?: string; since?: string | null; open?: boolean; busy?: string | null; stale?: boolean } = {}) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  state: o.state ?? (o.up === false ? 'stopped' : 'running'),
  since: o.since ?? null,
  page: { up: o.up ?? true, url: `http://${id}.localhost/` },
  can: { start: true, stop: true, open: o.open ?? true },
  busy: o.busy ?? null,
  ...(o.stale ? { stale: true } : {}),
});
const stateOf = (holders: unknown[], o: { behind?: unknown[]; offDuty?: string[] } = {}) => ({
  roles: holders.map((h, i) => ({ id: `r${i}`, holder: h, behind: i === 0 ? (o.behind ?? []) : [] })),
  offDuty: (o.offDuty ?? []).map((id) => ({ id, name: id })),
});

beforeEach(() => rmSync(tendFile(), { force: true }));

test('only an agent on duty whose page is down counts as down', () => {
  const look = staffFromState(
    stateOf(
      [
        agent('porter', { up: false }), // on duty, page gone: down
        agent('clerk', { up: false, since: '2026-10-01T00:00:00Z' }), // a person stopped it: left alone
        agent('herald'), // up
        agent('miller', { up: false, state: 'unknown' }), // Manor can't read its status: left alone
        agent('steward', { up: false }), // itself: never
        agent('pinder', { up: false, stale: true }), // Manor's last look, not this one: left for the next
        null, // a vacant role
      ],
      { behind: [agent('thatcher', { up: false })], offDuty: ['auditor'] },
    ),
  );
  assert.ok(look);
  const byId = Object.fromEntries(look.map((a) => [a.id, a.down]));
  assert.deepEqual(byId, { porter: true, clerk: false, herald: false, miller: false, thatcher: true });
  assert.equal(staffFromState({ error: 'no answer' }), null);
});

test('a down agent is opened again through Manor, and the round says so', async () => {
  const opened: string[] = [];
  const lines: string[] = [];
  const r = await tend({
    manorUrl: 'http://127.0.0.1:18585',
    getJson: async (url) => (assert.equal(url, 'http://127.0.0.1:18585/api/state'), stateOf([agent('porter', { up: false }), agent('herald')])),
    open: async (id) => (opened.push(id), { ok: true, said: 'HTTP 200' }),
    log: (l) => lines.push(l),
  });
  assert.deepEqual(opened, ['porter']);
  assert.equal(r.length, 1);
  assert.equal(r[0].outcome, 'done');
  assert.match(r[0].message, /^tend: /);
  const t = loadTending();
  assert.equal(t.manor, true);
  assert.deepEqual(t.down, {});
  assert.equal(t.revived[0].id, 'porter');
  assert.deepEqual(tendConditions(t), []);
});

test('a page that stays down is tried a few times, then an hour apart, and is an alarm until it answers', async () => {
  let now = Date.parse('2026-10-06T12:00:00Z');
  let up = false;
  const opened: number[] = [];
  const look = () =>
    tend({
      manorUrl: 'http://127.0.0.1:18585',
      getJson: async () => stateOf([agent('porter', { up })]),
      open: async () => (opened.push(now), { ok: false, said: "Porter's page didn't start within 20 s" }),
      now: () => new Date(now),
      log: () => {},
    });
  const results = [];
  for (let i = 0; i < MAX_TRIES; i++) {
    results.push(...(await look()));
    if (i < MAX_TRIES - 1) assert.deepEqual(tendConditions(loadTending()), [], 'no alarm while tries are left');
    // A round sooner than RETRY_MS tries nothing.
    now += RETRY_MS / 2;
    assert.deepEqual(await look(), []);
    now += RETRY_MS / 2;
  }
  assert.equal(opened.length, MAX_TRIES);
  assert.deepEqual(results.map((r) => r.outcome), Array(MAX_TRIES).fill('failed'));
  const [c] = tendConditions(loadTending());
  assert.equal(c.id, 'tend:porter');
  assert.equal(c.afterMs, 0);
  assert.match(c.title, /Porter is on duty, but its page doesn't answer/);
  assert.ok(c.detail.some((d) => d.includes("didn't start within 20 s")));

  // Spent: the next try only after an hour, and quietly (the alarm says it).
  assert.deepEqual(await look(), []);
  assert.equal(opened.length, MAX_TRIES);
  now += SPENT_RETRY_MS;
  assert.deepEqual(await look(), []);
  assert.equal(opened.length, MAX_TRIES + 1);

  // Back, however it came back: nothing kept, no alarm.
  up = true;
  await look();
  assert.deepEqual(loadTending().down, {});
  assert.deepEqual(tendConditions(loadTending()), []);
});

test("an agent Manor can't open is an alarm at once; Manor not answering changes nothing", async () => {
  await tend({ manorUrl: 'http://127.0.0.1:18585', getJson: async () => stateOf([agent('porter', { up: false, open: false })]), open: async () => assert.fail('not opened'), log: () => {} });
  assert.equal(tendConditions(loadTending())[0]?.id, 'tend:porter');
  // Manor down: what was seen stays, and no alarm is drawn from it (Manor's page down is its own).
  await tend({ manorUrl: 'http://127.0.0.1:18585', getJson: async () => ({ error: 'ECONNREFUSED' }), log: () => {} });
  const t = loadTending();
  assert.equal(t.manor, false);
  assert.ok(t.down.porter);
  assert.deepEqual(tendConditions(t), []);
});

test('repositories here: an employee with a clone, not one without', () => {
  const s = normalizeSettings({ employees: [{ id: 'porter', checkout: path.join(home, 'no-such-clone') }] }).settings;
  assert.equal(reposHere(s), false);
  assert.equal(reposHere(normalizeSettings({}).settings), false);
  const f = fakeEmployee(path.join(home, 'fake'));
  assert.equal(reposHere({ ...s, employees: [...s.employees, { ...s.employees[0], id: 'fake', checkout: f.checkout }] }), true);
});

test('no employees and no repository of its own: the glance asks GitHub nothing', async () => {
  const r = runner();
  const g = await takeGlance(r.run, home, { employees: [], stewardRepo: '' });
  assert.deepEqual(r.gh, []);
  assert.deepEqual(g.repos, {});
});

test('a round with no repositories here asks GitHub nothing, keeps the staff pages up, and the alarms still look', async () => {
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ employees: [{ id: 'porter', name: 'Porter', repo: 'octocat/porter', checkout: path.join(home, 'gone') }], alarms: { toast: false } }));
  const r = runner();
  const getJson = async (url: string) => (url.endsWith('/api/state') ? stateOf([agent('porter', { up: false }), agent('herald', { up: false })]) : { error: 'not here' });
  const out = await runStage('round', {}, {
    run: r.run,
    tend: { manorUrl: 'http://127.0.0.1:18585', getJson, open: async (id) => (id === 'herald' ? { ok: true, said: 'HTTP 200' } : { ok: false, said: 'no page' }) },
    alarms: { getJson, manorUrl: 'http://127.0.0.1:18585', toast: async () => {} },
    online: async () => true,
  });
  assert.deepEqual(r.gh, [], 'nothing asked of GitHub');
  assert.equal(out.tendOnly, true);
  assert.equal(out.error, undefined);
  assert.ok(out.log.some((l) => l.startsWith('no repositories to look after on this PC')));
  assert.deepEqual(out.results.map((x) => [x.id, x.outcome]), [['porter', 'failed'], ['herald', 'done']]);
  // It did something, so it is the last stage.
  assert.ok(JSON.parse((await import('node:fs')).readFileSync(lastStageFile(), 'utf8')).tendOnly);
  // Porter's tries aren't spent yet: no alarm for it.
  assert.ok(!loadAlarms().open.some((a) => a.id === 'tend:porter'));
});

test('Settings can switch it off: then the round leaves the staff alone', async () => {
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ employees: [], tend: false, alarms: { toast: false } }));
  const out = await runStage('round', {}, {
    run: runner().run,
    tend: { manorUrl: 'http://127.0.0.1:18585', getJson: async () => assert.fail('not looked at'), open: async () => assert.fail('not opened') },
    alarms: { getJson: async () => ({ error: 'not here' }), manorUrl: null, toast: async () => {} },
  });
  assert.equal(out.tendOnly, true);
  assert.deepEqual(out.results, []);
});

test('after a fresh start (the page started, or the PC woke), a down agent whose tries are spent is tried at once, its alarm kept until it answers', async () => {
  const { noteFreshStart } = await import('../src/fresh-start.ts');
  let now = Date.parse('2026-10-06T12:00:00Z');
  let up = false;
  const opened: number[] = [];
  const look = () =>
    tend({
      manorUrl: 'http://127.0.0.1:18585',
      getJson: async () => stateOf([agent('porter', { up })]),
      open: async () => (opened.push(now), up ? { ok: true, said: 'opened' } : { ok: false, said: 'no' }),
      now: () => new Date(now),
      log: () => {},
    });
  for (let i = 0; i < MAX_TRIES; i++) {
    await look();
    now += RETRY_MS;
  }
  assert.equal(tendConditions(loadTending()).length, 1, 'spent: an alarm');
  await look();
  assert.equal(opened.length, MAX_TRIES, 'spent: the next try is an hour off');

  // The PC slept; the page starts again. Still down: tried at once, and the alarm stays.
  noteFreshStart();
  await look();
  assert.equal(opened.length, MAX_TRIES + 1);
  assert.equal(tendConditions(loadTending()).length, 1, 'still down: the alarm stays');
  await look();
  assert.equal(opened.length, MAX_TRIES + 1, 'once per fresh start');

  // Another fresh start, and this time it opens: no alarm.
  noteFreshStart();
  up = false;
  const opens = async () => ({ ok: true, said: 'opened' });
  await tend({ manorUrl: 'http://127.0.0.1:18585', getJson: async () => stateOf([agent('porter', { up: false })]), open: opens, now: () => new Date(now), log: () => {} });
  assert.deepEqual(tendConditions(loadTending()), []);
});

test('a tick that comes long after the last is the PC waking: a fresh start, and a round now', async () => {
  const { watchWake, takeFreshStart, WOKE_AFTER_MS } = await import('../src/fresh-start.ts');
  takeFreshStart('releases');
  takeFreshStart('tend');
  let t = 0;
  let woke = 0;
  const stop = watchWake(() => woke++, 5, () => t);
  t += 1_000;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(woke, 0, 'ticks close together: awake');
  assert.equal(takeFreshStart('releases'), false);
  t += WOKE_AFTER_MS + 1;
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.equal(woke, 1);
  assert.equal(takeFreshStart('releases'), true);
  assert.equal(takeFreshStart('releases'), false, 'once');
  assert.equal(takeFreshStart('tend'), true);
});
