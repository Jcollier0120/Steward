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
  for (const stage of ['bump', 'push', 'merge', 'release', 'merge-team']) assert.match(html, new RegExp(`data-post="/api/stage/${stage}"[^>]*data-confirm=`));
  assert.match(html, /data-confirm="Merge the open PRs the team opened \(Jcollier0120\), and the Steward&#39;s, [^"]*"[^>]*>Merge the team's PRs</);
  assert.match(html, /data-settings-panel/);
  // By itself (Settings' default): its rounds, and Run now, which the kit lifts into the title bar.
  assert.match(html, /By itself, a round every 10 minutes while on duty: it merges every PR of its own and the team&#39;s that is ready/);
  assert.match(html, /data-post="\/api\/run" data-confirm="A round now: [^"]*"[^>]*>Run now</);
  const ping = await (await fetch(`${base()}/api/ping`)).json();
  assert.deepEqual(ping.rounds.map((r: { name: string }) => r.name), ['round'], 'Manor sees its rounds');
  assert.equal(typeof ping.nextRunAt, 'string');
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
  assert.equal(last.asked.team, undefined, "Merge is the Steward's PRs only");
  assert.deepEqual(last.results, []);
  // Merge the team's PRs is merge --yes --team, with the same token.
  assert.equal((await post('/api/stage/merge-team', {})).status, 403);
  const team = await post('/api/stage/merge-team', { 'x-token': token, origin: `http://steward.localhost:${port}` });
  assert.deepEqual(await team.json(), { started: true });
  await served.idle();
  const merged = JSON.parse(readFileSync(path.join(home, 'last-stage.json'), 'utf8'));
  assert.equal(merged.stage, 'merge');
  assert.equal(merged.asked.yes, true);
  assert.equal(merged.asked.team, true);
  // Run now: a round, with the same token. With no employees it does nothing, and leaves no trace.
  assert.equal((await post('/api/run', {})).status, 403);
  const round = await post('/api/run', { 'x-token': token, origin: `http://steward.localhost:${port}` });
  assert.deepEqual(await round.json(), { started: true });
  await served.idle();
  assert.equal(JSON.parse(readFileSync(path.join(home, 'last-stage.json'), 'utf8')).stage, 'merge', 'a round with nothing done is not recorded');
});

test("a stage's POST takes the ticked employees and a well-formed kit only", () => {
  assert.deepEqual(askOf({ employees: ['porter', 'pinder'], kit: '1.0.1' }), { employees: ['porter', 'pinder'], kit: '1.0.1' });
  assert.deepEqual(askOf({ employees: 'porter', kit: '1.0.1; rm' }), { employees: [], kit: null });
});
