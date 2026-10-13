import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { until } from '../kit/test/until.ts';

// An agent update Manor gave up on (unstick.ts): pressed once more through Manor's page when its install's dry run would
// take that version now, never twice; an alarm in the dry run's words when it would still take an older one.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-unstick-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { GIVEN_UP, RECHECK_MS, dryRunFinds, loadUnstick, pressUpdate, stuckUpdates, unstick, unstickConditions, unstickFile } = await import('../src/unstick.ts');
const { runStage } = await import('../src/steward.ts');
const { loadAlarms } = await import('../src/alarms.ts');
const { runner } = await import('./helpers.ts');
type ManorUpdates = import('../src/unstick.ts').ManorUpdates;
type RolledBack = import('../src/unstick.ts').RolledBack;

const MANOR = 'http://127.0.0.1:18585';
const T0 = Date.parse('2026-10-13T15:50:00Z');

/** Manor's updates.json with Lamplighter given up on at 0.4.38, as on 2026-10-13. */
const updates = (o: { installed?: string; latest?: string; count?: number; running?: boolean; failures?: boolean; more?: ManorUpdates['items'] } = {}): ManorUpdates => {
  const installed = o.installed ?? '0.4.37';
  const latest = o.latest ?? '0.4.38';
  return {
    offline: null,
    exchequerDown: null,
    items: [{ id: 'lamplighter', name: 'Lamplighter', installed, latest, available: installed !== latest }, ...(o.more ?? [])],
    run: { finishedAt: o.running ? null : '2026-10-13T15:00:00Z' },
    failures: o.failures === false || installed === latest ? {} : { lamplighter: { version: '0.4.38', at: '2026-10-13T15:00:00Z', count: o.count ?? GIVEN_UP } },
  };
};

/** Manor's dry run, as it prints each agent: its padded name, what's installed, and where its release would come from. */
const dryLine = (name: string, from: string) => `manor install --dry-run: nothing is changed.\n\n  ${name.padEnd(12)}  ${name} 0.4.37 (built from abc1234) installed; from ${from}\n\nThen each would be employed in C:\\x\\registry.json and each started, then Manor's page.\n`;
const takes = (v: string) => dryLine('Lamplighter', `its latest release in owner/Manor-releases, lamplighter-v${v} in the Exchequer`);

beforeEach(() => rmSync(unstickFile(), { force: true }));

test('only an update Manor gave up on, whose item still offers that version, is stuck', () => {
  assert.deepEqual(stuckUpdates(updates()), [{ id: 'lamplighter', name: 'Lamplighter', version: '0.4.38', installed: '0.4.37' }]);
  assert.deepEqual(stuckUpdates(updates({ count: GIVEN_UP - 1 })), [], 'Manor still tries it itself');
  assert.deepEqual(stuckUpdates(updates({ latest: '0.4.39' })), [], 'a newer release came out: Manor tries that one afresh');
  assert.deepEqual(stuckUpdates(updates({ installed: '0.4.38' })), [], 'on it now');
  assert.deepEqual(stuckUpdates({}), []);
});

test("the dry run's line names the version its install would take, or why it can't", () => {
  const a = { id: 'lamplighter', name: 'Lamplighter' };
  assert.deepEqual(dryRunFinds(takes('0.4.38'), a), { version: '0.4.38', said: 'its latest release in owner/Manor-releases, lamplighter-v0.4.38 in the Exchequer' });
  assert.equal(dryRunFinds(takes('0.4.37'), a).version, '0.4.37');
  // No release found: no tag, the reason.
  assert.deepEqual(dryRunFinds(dryLine('Lamplighter', 'its latest release in owner/Manor-releases: the Exchequer answered HTTP 503.'), a), { version: null, said: 'its latest release in owner/Manor-releases: the Exchequer answered HTTP 503.' });
  // Another agent whose id ends in this one's is never taken for it.
  assert.equal(dryRunFinds(dryLine('Devlamp', 'its latest release, devlamplighter-v0.9.0 in the Exchequer'), a).version, null);
  // Nothing it recognises: its last words.
  assert.deepEqual(dryRunFinds('Manor is a development checkout.\nA real install refuses here.\n', a), { version: null, said: 'Manor is a development checkout. A real install refuses here.' });
});

test('a stuck update whose install would take it now is pressed once, and never again for that version', async () => {
  let now = T0;
  let u = updates();
  const dryRuns: string[][] = [];
  const pressed: string[][] = [];
  const lines: string[] = [];
  const look = () =>
    unstick({
      manorUrl: MANOR,
      getJson: async (url) => (assert.equal(url, `${MANOR}/api/state`), { roles: [] }),
      readUpdates: () => u,
      dryRun: async (ids) => (dryRuns.push(ids), { code: 0, out: takes('0.4.38') }),
      press: async (ids) => (pressed.push(ids), { ok: true, said: 'HTTP 200' }),
      now: () => new Date(now),
      log: (l) => lines.push(l),
    });
  const r = await look();
  assert.deepEqual(dryRuns, [['lamplighter']]);
  assert.deepEqual(pressed, [['lamplighter']]);
  assert.deepEqual(r.map((x) => [x.id, x.outcome]), [['lamplighter', 'done']]);
  assert.match(r[0].message, /^unstick: /);
  assert.ok(lines.some((l) => /\[lamplighter\] .*pressed Update/.test(l)), 'a line says what it settled');
  assert.deepEqual(unstickConditions(loadUnstick()), []);
  assert.equal(loadUnstick().settled[0].version, '0.4.38');

  // Its install ran, but ended on 0.4.37 again; Manor tried twice more itself, and gave up again.
  now += 2 * RECHECK_MS;
  u = updates({ running: false });
  const again = await look();
  assert.deepEqual(again, []);
  assert.deepEqual(pressed, [['lamplighter']], 'never pressed twice for one version');
  assert.equal(dryRuns.length, 1, 'no dry run for it either: it is the person\'s now');
  const [c] = unstickConditions(loadUnstick());
  assert.equal(c.id, 'unstick:lamplighter');
  assert.equal(c.title, 'Manor gave up updating Lamplighter to 0.4.38');
  assert.match(c.detail.join(' '), /pressed Update for it .* gave up on it again/);
  assert.match(c.detail.join(' '), /only once for each version/);

  // The person pressed Update, and it took: the alarm clears, and what was pressed is let go.
  u = updates({ installed: '0.4.38' });
  await look();
  assert.deepEqual(unstickConditions(loadUnstick()), []);
  assert.deepEqual(loadUnstick().pressed, {});
  assert.ok(lines.some((l) => l.includes('Lamplighter is on 0.4.38 now')));
});

test("one whose install would still take an older release is an alarm in the dry run's words, looked at again every half hour", async () => {
  let now = T0;
  let release = '0.4.37';
  const dryRuns: number[] = [];
  const pressed: string[][] = [];
  let u = updates();
  const look = () =>
    unstick({
      manorUrl: MANOR,
      getJson: async () => ({ roles: [] }),
      readUpdates: () => u,
      dryRun: async () => (dryRuns.push(now), { code: 0, out: takes(release) }),
      press: async (ids) => (pressed.push(ids), { ok: true, said: 'HTTP 200' }),
      now: () => new Date(now),
      log: () => {},
    });
  await look();
  assert.deepEqual(pressed, []);
  const [c] = unstickConditions(loadUnstick());
  assert.equal(c.id, 'unstick:lamplighter');
  assert.equal(c.who, 'lamplighter');
  assert.equal(c.afterMs, 0);
  assert.match(c.detail[0], /Manor's look found 0\.4\.38, but its install would still take an older release: .*lamplighter-v0\.4\.37 in the Exchequer/);
  assert.match(c.detail[1], /Lamplighter stays on 0\.4\.37/);

  // The next rounds, within half an hour: no dry run, the alarm kept.
  now += RECHECK_MS - 60_000;
  await look();
  assert.equal(dryRuns.length, 1);
  assert.equal(unstickConditions(loadUnstick()).length, 1);
  assert.equal(unstickConditions(loadUnstick())[0].since, new Date(T0).toISOString(), 'since it was first found');

  // Half an hour on, the Exchequer serves 0.4.38: pressed, and the alarm cleared.
  now += 60_000;
  release = '0.4.38';
  await look();
  assert.equal(dryRuns.length, 2);
  assert.deepEqual(pressed, [['lamplighter']]);
  assert.deepEqual(unstickConditions(loadUnstick()), []);

  // And once it is on it, nothing more is done.
  u = updates({ installed: '0.4.38' });
  now += 2 * RECHECK_MS;
  await look();
  assert.equal(dryRuns.length, 2);
});

test('a dry run that names no release, or an Update Manor refuses, is an alarm too', async () => {
  const look = (o: { out: string; press?: { ok: boolean; said: string } }) =>
    unstick({ manorUrl: MANOR, getJson: async () => ({ roles: [] }), readUpdates: () => updates(), dryRun: async () => ({ code: 1, out: o.out }), press: async () => o.press ?? { ok: true, said: 'HTTP 200' }, now: () => new Date(T0), log: () => {} });
  await look({ out: dryLine('Lamplighter', 'its latest release in owner/Manor-releases: Lamplighter 0.4.38 was recalled.') });
  let [c] = unstickConditions(loadUnstick());
  assert.match(c.detail[0], /couldn't name a release for it: .*was recalled\./);

  rmSync(unstickFile(), { force: true });
  await look({ out: takes('0.4.38'), press: { ok: false, said: 'An update is running already: wait for it to finish.' } });
  [c] = unstickConditions(loadUnstick());
  assert.match(c.detail[0], /didn't take the Steward's Update for it: An update is running already/);
  assert.deepEqual(loadUnstick().pressed, {}, 'not pressed, so it may be tried again');
});

test("a version the agent's own install rolled back is left to the person, with no dry run or Update spent on it", async () => {
  let u = updates({ more: [{ id: 'miller', name: 'Miller', installed: '0.6.26', latest: '0.6.27', available: true }] });
  u.failures!.miller = { version: '0.6.27', at: '2026-10-13T15:00:00Z', count: GIVEN_UP };
  const dryRuns: string[][] = [];
  const pressed: string[][] = [];
  const look = () =>
    unstick({
      manorUrl: MANOR,
      getJson: async () => ({ roles: [] }),
      readUpdates: () => u,
      // As on 2026-10-13: Lamplighter 0.4.38 was installed while the Exchequer was away, its page didn't answer, and it was rolled back.
      rolledBack: (id): RolledBack => (id === 'lamplighter' ? { '0.4.38': { version: '0.4.38', why: "its home page didn't answer", at: '2026-10-13T14:17:24.133Z' } } : {}),
      dryRun: async (ids) => (dryRuns.push(ids), { code: 0, out: dryLine('Miller', 'its latest release in owner/Manor-releases, miller-v0.6.27 in the Exchequer') }),
      press: async (ids) => (pressed.push(ids), { ok: true, said: 'HTTP 200' }),
      now: () => new Date(T0),
      log: () => {},
    });
  await look();
  assert.deepEqual(dryRuns, [['miller']], 'Miller alone is dry-run');
  assert.deepEqual(pressed, [['miller']]);
  const [c] = unstickConditions(loadUnstick());
  assert.equal(c.id, 'unstick:lamplighter');
  assert.match(c.detail[0], /^Its own installer refuses 0\.4\.38: Lamplighter 0\.4\.38 was rolled back on 2026-10-13 \(its home page didn't answer\)/);
  assert.match(c.detail[1], /--allow-unsafe/);
  assert.match(c.detail[1], /next version installs as usual/);

  // Its next version came out: Manor tries it afresh, and the alarm goes.
  u = updates({ latest: '0.4.39', failures: false });
  await look();
  assert.deepEqual(unstickConditions(loadUnstick()), []);
});

test('nothing is run while nothing is stuck, an update is running, Manor knows it is offline, or its page is down', async () => {
  const cases: [string, ManorUpdates | null, unknown][] = [
    ['nothing stuck', updates({ failures: false }), { roles: [] }],
    ['still trying itself', updates({ count: 1 }), { roles: [] }],
    ['an update running', updates({ running: true }), { roles: [] }],
    ['offline', { ...updates(), offline: 'no network' }, { roles: [] }],
    ['the Exchequer away', { ...updates(), exchequerDown: '2026-10-13T14:18:00Z' }, { roles: [] }],
    ["Manor's page down", updates(), { error: 'ECONNREFUSED' }],
    ['no updates.json', null, { roles: [] }],
  ];
  for (const [why, u, state] of cases) {
    const r = await unstick({
      manorUrl: MANOR,
      getJson: async () => state,
      readUpdates: () => u,
      dryRun: async () => assert.fail(`no dry run: ${why}`),
      press: async () => assert.fail(`not pressed: ${why}`),
      now: () => new Date(T0),
      log: () => {},
    });
    assert.deepEqual(r, [], why);
  }
});

test("Update is pressed as Manor's page presses it: its token, the ids, and no Origin", async () => {
  const posts: { headers: http.IncomingHttpHeaders; body: string; url: string }[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') return res.end('<html><head><meta name="page-token" content="tok_0123456789abcdef"></head></html>');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push({ headers: req.headers, body, url: req.url ?? '' });
      const busy = JSON.parse(body).ids.includes('busy');
      res.writeHead(busy ? 409 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(busy ? { error: 'An update is running already: wait for it to finish.' } : { items: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.deepEqual(await pressUpdate(url)(['lamplighter', 'miller']), { ok: true, said: 'HTTP 200' });
  await until(() => posts.length === 1, 10_000, 'the POST');
  assert.equal(posts[0].url, '/api/updates/install');
  assert.deepEqual(JSON.parse(posts[0].body), { ids: ['lamplighter', 'miller'] });
  assert.equal(posts[0].headers['x-manor-token'], 'tok_0123456789abcdef');
  assert.equal(posts[0].headers.origin, undefined);
  assert.deepEqual(await pressUpdate(url)(['busy']), { ok: false, said: 'An update is running already: wait for it to finish.' });
});

test("a round settles it beside tending, and one it can't settle is the Steward's alarm", async () => {
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ employees: [], alarms: { toast: false } }));
  const getJson = async (url: string) => (url.endsWith('/api/state') ? { roles: [] } : { error: 'not here' });
  const round = (release: string) =>
    runStage('round', {}, {
      run: runner().run,
      tend: { manorUrl: MANOR, getJson },
      unstick: { manorUrl: MANOR, getJson, readUpdates: () => updates(), dryRun: async () => ({ code: 0, out: takes(release) }), press: async () => ({ ok: true, said: 'HTTP 200' }) },
      alarms: { getJson, manorUrl: MANOR, toast: async () => {} },
      online: async () => true,
    });
  const blocked = await round('0.4.37');
  assert.deepEqual(blocked.results, []);
  assert.ok(loadAlarms().open.some((a) => a.id === 'unstick:lamplighter'));

  rmSync(unstickFile(), { force: true });
  const settled = await round('0.4.38');
  assert.deepEqual(settled.results.map((x) => [x.id, x.outcome]), [['lamplighter', 'done']]);
  assert.ok(!loadAlarms().open.some((a) => a.id === 'unstick:lamplighter'));

  // Switched off with tending: left alone.
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ employees: [], tend: false, alarms: { toast: false } }));
  rmSync(unstickFile(), { force: true });
  const off = await runStage('round', {}, {
    run: runner().run,
    unstick: { manorUrl: MANOR, getJson, readUpdates: () => updates(), dryRun: async () => assert.fail('no dry run'), press: async () => assert.fail('not pressed') },
    alarms: { getJson, manorUrl: null, toast: async () => {} },
  });
  assert.deepEqual(off.results, []);
});
