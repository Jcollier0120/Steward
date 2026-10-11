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
const { demoAnswer, demoDir, DEMO_NO, isDemo, shownDataDir, when } = await import('./fixture/src/kit/demo.ts');
const { isDeveloper } = await import('./fixture/src/kit/developer.ts');

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
  assert.equal(when('@now-300', Date.parse('2026-10-11T12:00:00Z')), '2026-10-11T11:55:00.000Z', 'five minutes before the picture');
  assert.equal(when('@now', 0), '1970-01-01T00:00:00.000Z');
  assert.equal(when('now'), 'now');
});

test('demo mode: the made-up data laid over its own answers, the ping marked, the developer view off, every button refused', async () => {
  process.env.KIT_DEMO = demo;
  let pressed = false;
  const { token, close } = await serve({
    port,
    icon: '<svg/>',
    get: { '/api/state': () => ({ json: { frame: "the kit's", found: ['a real file'] } }), '/api/other': () => ({ json: { own: true } }) },
    post: { '/api/do': () => ((pressed = true), { json: { ok: true } }) },
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(await (await fetch(`${base}/api/state`)).json(), { frame: "the kit's", found: ['a made-up file'] }, 'its own frame kept, its findings made up');
    assert.equal(isDeveloper({ own: true }), false, 'a demo is the page everyone sees');
    writeFileSync(path.join(demo, 'hero.json'), '{"developer":true}');
    assert.equal(isDeveloper({ own: false }), true, "a developer agent's demo, as developers see it");
    rmSync(path.join(demo, 'hero.json'));
    assert.equal(shownDataDir(), 'C:\\Users\\Alex\\.fixture', "no folder of the PC taking the picture, whose path names its owner");
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
