import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// The Steward's page, on a port and data folder of its own, with no employees and gh standing in: it
// pings as Manor expects, renders, and starts a stage only for a POST with the page's token from its own
// origin.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-page-'));
process.env.STEWARD_HOME = home;
process.env.STEWARD_PORT = String(41000 + Math.floor(Math.random() * 8000));
writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ employees: [] }));

const { APP, port } = await import('../src/app.ts');
const { serveSteward, askOf } = await import('../src/agent.ts');
const { runner } = await import('./helpers.ts');

const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? { code: 0, out: JSON.stringify([{ tagName: 'kit-v1.0.0', isDraft: false }]), err: '' } : undefined));
let served: Awaited<ReturnType<typeof serveSteward>>;
before(async () => {
  served = await serveSteward({ run: r.run });
  await served.idle();
});
after(async () => {
  await served.idle();
  await served.close();
  rmSync(home, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;
const post = (route: string, headers: Record<string, string>, body: unknown = { employees: [], kit: '1.0.0' }) =>
  fetch(`${base()}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('it pings as the Steward, on duty and idle', async () => {
  const ping = await (await fetch(`${base()}/api/ping`)).json();
  assert.equal(ping.app, APP.id);
  assert.equal(ping.name, 'Steward');
  assert.equal(ping.version, APP.version);
  assert.equal(ping.running, true);
  assert.equal(ping.busy, false);
  assert.equal(typeof ping.pid, 'number');
  assert.equal((await fetch(`${base()}/favicon.svg`)).headers.get('content-type'), 'image/svg+xml');
});

test('the page shows the kit, the stages and Settings, and carries its token', async () => {
  const html = await (await fetch(`${base()}/`)).text();
  assert.match(html, /<meta name="page-token" content="[0-9a-f]{48}">/);
  assert.match(html, /The kit the Steward hands out: <strong>1\.0\.0<\/strong>/);
  for (const stage of ['bump', 'push', 'merge', 'release']) assert.match(html, new RegExp(`data-post="/api/stage/${stage}"[^>]*data-confirm=`));
  assert.match(html, /data-settings-panel/);
});

test('a stage needs the token, from its own origin or none: without it nothing starts', async () => {
  const token = readFileSync(path.join(home, 'server.json'), 'utf8').match(/"token": "([0-9a-f]+)"/)![1];
  assert.equal((await post('/api/stage/merge', {})).status, 403);
  assert.equal((await post('/api/stage/bump', { 'x-token': 'nope' })).status, 403);
  assert.equal((await post('/api/stage/release', { 'x-token': token, origin: 'http://evil.example' })).status, 403);
  assert.throws(() => readFileSync(path.join(home, 'last-stage.json')), /ENOENT/, 'no stage ran');
  const ok = await post('/api/stage/merge', { 'x-token': token, origin: `http://steward.localhost:${port}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { started: true });
  await served.idle();
  const last = JSON.parse(readFileSync(path.join(home, 'last-stage.json'), 'utf8'));
  assert.equal(last.stage, 'merge');
  assert.equal(last.asked.yes, true, "the page's button asked first: that is merge --yes");
  assert.deepEqual(last.results, []);
});

test("a stage's POST takes the ticked employees and a well-formed kit only", () => {
  assert.deepEqual(askOf({ employees: ['porter', 'pinder'], kit: '1.0.1' }), { employees: ['porter', 'pinder'], kit: '1.0.1' });
  assert.deepEqual(askOf({ employees: 'porter', kit: '1.0.1; rm' }), { employees: [], kit: null });
});
