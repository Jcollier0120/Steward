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

const { GIVEN_UP, RECHECK_MS, dryRunFinds, rollbackCause, loadUnstick, pressUpdate, stuckUpdates, unstick, unstickConditions, unstickFile } = await import('../src/unstick.ts');
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

// 2026-10-13: six agents' kit-2.66.0 updates rolled back in one pass, 14:16–14:18Z, as the PC's network blinked.
const BLIP: [id: string, name: string, from: string, version: string, at: string][] = [
  ['aletaster', 'Aletaster', '0.8.34', '0.8.35', '2026-10-13T14:16:32.830Z'],
  ['miller', 'Miller', '0.6.26', '0.6.27', '2026-10-13T14:16:46.149Z'],
  ['pinder', 'Pinder', '0.5.43', '0.5.44', '2026-10-13T14:16:58.982Z'],
  ['lamplighter', 'Lamplighter', '0.4.37', '0.4.38', '2026-10-13T14:17:24.133Z'],
  ['chamberlain', 'Chamberlain', '0.3.25', '0.3.26', '2026-10-13T14:17:37.125Z'],
  ['assayer', 'Assayer', '0.3.23', '0.3.24', '2026-10-13T14:18:02.172Z'],
];
const MANOR_LOG = [
  '2026-10-13T14:10:00.000Z Looked for new releases: 7 to update.',
  "2026-10-13T14:18:18.697Z This PC is offline: Manor looks for new releases again once it's back (every 5 minutes it looks whether it is).",
  '2026-10-13T14:18:54.729Z This PC is back online (offline since 2026-10-13T14:18:18.697Z): Manor looked for new releases again.',
  "2026-10-13T14:18:54.729Z The Exchequer can't answer now: Manor looks again every 5 minutes until it does, keeping what it knew.",
  "2026-10-13T14:24:05.699Z The Exchequer answers again (it couldn't since 2026-10-13T14:18:54.729Z).",
].join('\r\n');
const flagOf = (from: string, version: string, at: string, why = "its home page didn't answer"): RolledBack => ({ [version]: { version, from, why, at, kept: `C:\\x\\app.unsafe-${version}` } });

test("a rollback is weighed: no answer at all, with the PC offline or other agents rolled back beside it, is the PC's doing", () => {
  const r = { why: "its home page didn't answer", at: '2026-10-13T14:17:24.133Z' };
  const offline = rollbackCause(r, [], MANOR_LOG);
  assert.equal(offline.environmental, true);
  assert.match(offline.words, /Manor's log says the PC offline at 2026-10-13 14:18Z/);
  assert.match(offline.words, /, and the Exchequer can't answer now at 2026-10-13 14:18Z$/);
  assert.doesNotMatch(offline.words, /back online/);
  const together = rollbackCause(r, [{ name: 'Miller', why: "its home page didn't answer", at: '2026-10-13T14:16:46.149Z' }, { name: 'Surveyor', why: 'its page stopped answering 20 s into its probation', at: '2026-10-13T14:17:11.766Z' }], '');
  assert.equal(together.environmental, true);
  assert.match(together.words, /Miller, Surveyor were rolled back the same way within 10 minutes/);
  // Alone, with the PC online: the release's.
  const alone = rollbackCause(r, [{ name: 'Miller', why: "its home page didn't answer", at: '2026-10-13T11:00:00.000Z' }], '2026-10-13T11:00:00.000Z This PC is offline: x');
  assert.equal(alone.environmental, false);
  assert.match(alone.words, /PC online then, and no other agent was rolled back near it/);
  // An answer that was wrong is never the network's, whatever happened around it.
  assert.equal(rollbackCause({ why: 'its home page answered 500', at: r.at }, [], MANOR_LOG).environmental, false);
  assert.equal(rollbackCause({ why: 'its page answers as 0.4.37, not 0.4.38', at: r.at }, [], MANOR_LOG).environmental, false);
  assert.equal(rollbackCause({ why: 'its install failed (exit 1) once it was in place', at: r.at }, [], MANOR_LOG).environmental, false);
});

/** Manor's updates.json while the blip's six wait: each still offered, each given up on. */
const blipUpdates = (o: { running?: boolean; installed?: Set<string> } = {}): ManorUpdates => ({
  offline: null,
  exchequerDown: null,
  items: BLIP.map(([id, name, from, version]) => ({ id, name, installed: o.installed?.has(id) ? version : from, latest: version, available: !o.installed?.has(id) })),
  run: { finishedAt: o.running ? null : '2026-10-13T14:20:00Z' },
  failures: Object.fromEntries(BLIP.filter(([id]) => !o.installed?.has(id)).map(([id, , , version]) => [id, { version, at: '2026-10-13T15:00:00Z', count: GIVEN_UP }])),
});

/** The blip's six flagged, and an unstick that allows and presses into these lists. */
function blipLook(o: { now: () => number; slots: () => number | null; running: () => boolean; installed?: Set<string> }) {
  const flags = new Map(BLIP.map(([id, , from, version, at]) => [id, flagOf(from, version, at)]));
  const allowed: string[] = [];
  const pressed: string[][] = [];
  const look = () =>
    unstick({
      manorUrl: MANOR,
      getJson: async () => ({ roles: [] }),
      readUpdates: () => blipUpdates({ running: o.running(), installed: o.installed }),
      rolledBack: (id) => flags.get(id) ?? {},
      allow: (id, version) => {
        const f = flags.get(id)!;
        if (!f[version]) return false;
        delete f[version];
        allowed.push(`${id}@${version}`);
        return true;
      },
      manorLog: () => MANOR_LOG,
      slots: o.slots,
      dryRun: async () => assert.fail('no dry run while a rollback waits its turn'),
      press: async (ids) => (pressed.push(ids), { ok: true, said: 'HTTP 200' }),
      now: () => new Date(o.now()),
      log: () => {},
    });
  return { flags, allowed, pressed, look };
}

test("versions a blip rolled back are allowed again as many at a time as the work line has slots, in one Update, once each", async () => {
  let now = Date.parse('2026-10-13T14:30:00Z');
  let running = false;
  const b = blipLook({ now: () => now, slots: () => 2, running: () => running });
  // Too soon after the blip: nothing yet, and no alarm (they wait their turn).
  assert.deepEqual(await b.look(), []);
  assert.deepEqual(b.allowed, []);
  assert.deepEqual(unstickConditions(loadUnstick()), []);

  // Half an hour on: the first two rolled back, together, in one Update.
  now = Date.parse('2026-10-13T15:50:00Z');
  const r = await b.look();
  assert.deepEqual(b.allowed, ['aletaster@0.8.35', 'miller@0.6.27']);
  assert.deepEqual(b.pressed, [['aletaster', 'miller']]);
  assert.deepEqual(r.map((x) => [x.id, x.outcome]), [['aletaster', 'done'], ['miller', 'done']]);
  assert.match(r[0].message, /0\.8\.35 was rolled back at 2026-10-13 14:16Z \(its home page didn't answer\), when Manor's log says the PC offline/);
  assert.equal(loadUnstick().allowed['aletaster@0.8.35'].rolledBackAt, '2026-10-13T14:16:32.830Z');

  // Their install runs: nothing more meanwhile. Once it's done, the next two at once, with no wait between.
  running = true;
  now += 60_000;
  await b.look();
  assert.equal(b.allowed.length, 2);
  running = false;
  await b.look();
  assert.deepEqual(b.pressed, [['aletaster', 'miller'], ['pinder', 'lamplighter']]);
  running = false;
  await b.look();
  // Three rounds for the six.
  assert.deepEqual(b.pressed, [['aletaster', 'miller'], ['pinder', 'lamplighter'], ['chamberlain', 'assayer']]);
  assert.deepEqual(b.allowed, BLIP.map(([id, , , version]) => `${id}@${version}`));
  assert.deepEqual(unstickConditions(loadUnstick()), []);
});

test('with no work line (Manor says 0), as many as the line could ever have', async () => {
  for (const slots of [null, 0]) {
    rmSync(unstickFile(), { force: true });
    const b = blipLook({ now: () => Date.parse('2026-10-13T15:50:00Z'), slots: () => slots, running: () => false });
    await b.look();
    assert.deepEqual(b.pressed, [BLIP.map(([id]) => id)], `slots ${slots}: all six, AGENTS_AT_ONCE.most`);
  }
});

test('of a pair allowed together, one rolled back again is an alarm with the real reason, never allowed twice; the other stands', async () => {
  let now = Date.parse('2026-10-13T15:50:00Z');
  const installed = new Set<string>();
  const b = blipLook({ now: () => now, slots: () => 2, running: () => false, installed });
  // Only Lamplighter and Chamberlain are offered still: the others were settled before.
  for (const id of ['aletaster', 'miller', 'pinder', 'assayer']) {
    installed.add(id);
    b.flags.set(id, {});
  }
  // Their flags gone, Miller's and the others' rollbacks beside them aren't known: Manor's log says the PC was offline.
  await b.look();
  assert.deepEqual(b.pressed, [['lamplighter', 'chamberlain']]);
  // Chamberlain held up; Lamplighter's probation failed again, a little later.
  installed.add('chamberlain');
  b.flags.set('lamplighter', flagOf('0.4.37', '0.4.38', '2026-10-13T15:51:40.000Z', 'its home page answered 500'));
  now += 40 * 60_000;
  await b.look();
  assert.deepEqual(b.pressed, [['lamplighter', 'chamberlain']], 'never twice');
  const conditions = unstickConditions(loadUnstick());
  assert.deepEqual(conditions.map((c) => c.id), ['unstick:lamplighter']);
  const [c] = conditions;
  assert.equal(c.title, 'Lamplighter 0.4.38 was rolled back again, after the Steward allowed it once');
  assert.match(c.detail[0], /allowed 0\.4\.38 again at 2026-10-13 15:50Z.*rolled back again at 2026-10-13 15:51Z: its home page answered 500/);
  assert.match(c.detail[1], /won't allow it again.*--allow-unsafe/);
});

test("a rollback beside others counts as the PC's even after they've moved on to newer versions", async () => {
  const flags: Record<string, RolledBack> = { lamplighter: flagOf('0.4.37', '0.4.38', '2026-10-13T14:17:24.133Z'), miller: flagOf('0.6.26', '0.6.27', '2026-10-13T14:16:46.149Z') };
  const allowed: string[] = [];
  await unstick({
    manorUrl: MANOR,
    getJson: async () => ({ roles: [] }),
    readUpdates: () => updates({ failures: false, more: [{ id: 'miller', name: 'Miller', installed: '0.6.28', latest: '0.6.28', available: false }] }),
    rolledBack: (id) => flags[id] ?? {},
    allow: (id, version) => (allowed.push(id), delete flags[id][version], true),
    manorLog: () => '',
    slots: () => 2,
    dryRun: async () => assert.fail('no dry run'),
    press: async () => ({ ok: true, said: 'HTTP 200' }),
    now: () => new Date(T0),
    log: () => {},
  });
  assert.deepEqual(allowed, ['lamplighter'], "Miller's rollback beside it counts, though Miller has moved on since");
});

test("a rollback that doesn't look like the PC's is an alarm at once with its why and when, and is never allowed", async () => {
  const allowed: string[] = [];
  await unstick({
    manorUrl: MANOR,
    getJson: async () => ({ roles: [] }),
    readUpdates: () => updates(),
    rolledBack: (id): RolledBack => (id === 'lamplighter' ? flagOf('0.4.37', '0.4.38', '2026-10-13T09:02:00.000Z', 'its home page answered 500') : {}),
    allow: (id) => (allowed.push(id), true),
    manorLog: () => MANOR_LOG,
    dryRun: async () => assert.fail('no dry run: it stopped for its rollback'),
    press: async () => assert.fail('not pressed'),
    now: () => new Date(T0),
    log: () => {},
  });
  assert.deepEqual(allowed, []);
  const [c] = unstickConditions(loadUnstick());
  assert.equal(c.title, "Lamplighter 0.4.38 was rolled back, so Manor can't update it");
  assert.match(c.detail[0], /^Lamplighter 0\.4\.38 was rolled back to 0\.4\.37 at 2026-10-13 09:02Z: its home page answered 500\. "its home page answered 500" is the release's own answer/);
  assert.match(c.detail[1], /refuses 0\.4\.38 until it is allowed, so Lamplighter stays on 0\.4\.37\. Its next version installs as usual/);
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
