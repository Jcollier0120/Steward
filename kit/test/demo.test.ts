import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Demo mode (demo.ts): a copy on its own port and an empty data folder, its page answered from made-up data.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-demo-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.FIXTURE_PORT = String(40000 + Math.floor(Math.random() * 9000));
after(() => rmSync(home, { recursive: true, force: true }));

const { port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const { demoAnswer, demoDir, DEMO_NO, isDemo } = await import('./fixture/src/kit/demo.ts');

const demo = path.join(home, 'demo');
mkdirSync(path.join(demo, 'api'), { recursive: true });
writeFileSync(path.join(demo, 'api', 'state.json'), JSON.stringify({ found: ['a made-up file'] }));
writeFileSync(path.join(demo, 'api', 'ping.json'), JSON.stringify({ summary: 'Sorting 12 downloads.' }));
writeFileSync(path.join(home, 'secret.json'), '{"no":1}');

test('demo mode: only where KIT_DEMO says, the agent\'s own demo folder for 1', () => {
  assert.equal(demoDir({}), null);
  assert.equal(demoDir({ KIT_DEMO: '0' }), null);
  assert.equal(isDemo({ KIT_DEMO: demo }), true);
  assert.match(demoDir({ KIT_DEMO: '1' })!, /[\\/]demo$/);
  assert.deepEqual(demoAnswer('/api/state', demo), { found: ['a made-up file'] });
  assert.equal(demoAnswer('/api/none', demo), undefined);
  assert.equal(demoAnswer('/../secret', demo), undefined, 'nothing outside the demo folder');
  assert.equal(demoAnswer('/api/state', null), undefined);
});

test('demo mode: GETs from the made-up data, its own handler otherwise, the ping marked, every button refused', async () => {
  process.env.KIT_DEMO = demo;
  let pressed = false;
  const { token, close } = await serve({
    port,
    icon: '<svg/>',
    get: { '/api/state': () => ({ json: { found: ['a real file'] } }), '/api/other': () => ({ json: { own: true } }) },
    post: { '/api/do': () => ((pressed = true), { json: { ok: true } }) },
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(await (await fetch(`${base}/api/state`)).json(), { found: ['a made-up file'] });
    assert.deepEqual(await (await fetch(`${base}/api/other`)).json(), { own: true });
    const ping = await (await fetch(`${base}/api/ping`)).json();
    assert.equal(ping.demo, true);
    assert.equal(ping.summary, 'Sorting 12 downloads.');
    assert.equal(ping.app, 'fixture', 'its own ping, with the demo laid over it');
    const r = await fetch(`${base}/api/do`, { method: 'POST', headers: { 'x-token': token }, body: '{}' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, DEMO_NO);
    assert.equal(pressed, false);
  } finally {
    delete process.env.KIT_DEMO;
    await close();
  }
});
