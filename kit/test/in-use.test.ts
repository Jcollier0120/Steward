import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// A page someone is using keeps its agent at a normal pace (gentle.ts pageInUse, kit 2.57.1). In a file of its own,
// since the pace is the process's.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-in-use-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.KIT_GENTLE = '0'; // priority alone: no PowerShell worker
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { IN_USE_MS, pageInUse, pageIsInUse, paceProcess } = await import('./fixture/src/kit/gentle.ts');
const { port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;
const NORMAL = os.constants.priority.PRIORITY_NORMAL;

test('in use: a normal pace at once, through gentle rounds, and gentle again a minute after the last request', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    paceProcess('gentle');
    assert.equal(os.getPriority(0), BELOW_NORMAL, 'gentle while nobody looks');
    pageInUse();
    assert.equal(os.getPriority(0), NORMAL, 'lifted at the first request');
    paceProcess('gentle');
    assert.equal(os.getPriority(0), NORMAL, 'a gentle round while it is in use leaves it lifted');
    mock.timers.tick(IN_USE_MS / 2);
    pageInUse(); // still looking: the minute starts again
    mock.timers.tick(IN_USE_MS / 2 + 1);
    assert.equal(os.getPriority(0), NORMAL, 'a minute after the first request, but not after the last');
    mock.timers.tick(IN_USE_MS / 2);
    assert.equal(pageIsInUse(), false);
    assert.equal(os.getPriority(0), BELOW_NORMAL, 'back to its pace once nobody has asked for a minute');
    paceProcess('full');
    assert.equal(os.getPriority(0), NORMAL, 'a full pace is normal, as before');
  } finally {
    mock.timers.reset();
  }
});

test("only a browser's request counts: Manor's pings and the CLI's leave the pace alone", async () => {
  const { close } = await serve({ port, icon: '<svg/>' });
  const ask = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject);
    });
  try {
    // Out of any minute in use left by the test before.
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * IN_USE_MS });
    paceProcess('gentle');
    assert.equal(os.getPriority(0), BELOW_NORMAL);
    assert.equal(await ask({}), 200);
    assert.equal(os.getPriority(0), BELOW_NORMAL, 'a request with no Sec-Fetch-Site (Manor, the CLI) changes nothing');
    assert.equal(await ask({ 'sec-fetch-site': 'same-origin' }), 200);
    assert.equal(os.getPriority(0), NORMAL, "a browser's request lifts it");
  } finally {
    mock.timers.reset();
    paceProcess('full');
    await close();
  }
});
