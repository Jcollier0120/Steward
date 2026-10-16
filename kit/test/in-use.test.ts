import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { freePort } from './free-port.ts';

// The pace is the owner's setting alone (kit 2.73.0): a page being looked at no longer lifts it (it did from kit
// 2.57.1, gentle.ts pageInUse), so what a page shows is what the agent costs in the background. In a file of its own,
// since the pace is the process's.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-in-use-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.FIXTURE_PORT = String(await freePort()); // never the fixture's own 17979, which every checkout's tests share
process.env.KIT_GENTLE = '0'; // priority alone: no PowerShell worker
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { CONTAIN_CHECK_MS, containSelf, gentleCap, gentleScript, pageInUse, paceCap, paceProcess, paceSet } = await import('./fixture/src/kit/gentle.ts');
const { port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;
const NORMAL = os.constants.priority.PRIORITY_NORMAL;
const capped = `gentle ${gentleCap()}`;
const { CEILING_CAP } = await import('./fixture/src/kit/pace.ts');

test("viewing a page leaves its pace and its job's cap as they are: a browser's requests and Manor's alike", async () => {
  const { close } = await serve({ port, icon: '<svg/>' });
  const ask = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject);
    });
  try {
    await paceProcess('gentle');
    assert.equal(paceSet(), capped);
    assert.equal(os.getPriority(0), BELOW_NORMAL);
    assert.equal(await ask({ 'sec-fetch-site': 'same-origin' }), 200);
    assert.equal(await ask({}), 200);
    pageInUse();
    assert.equal(paceSet(), capped, 'still in its job at the gentle cap');
    assert.equal(os.getPriority(0), BELOW_NORMAL, 'still below normal');
  } finally {
    await paceProcess('full');
    await close();
  }
  assert.equal(paceSet(), 'normal', 'the setting, full, is what lifts it (under node --test, its cap too)');
  assert.equal(os.getPriority(0), NORMAL);
});

test('a process that contains itself: at the setting now, and at a new one within CONTAIN_CHECK_MS, with no restart', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let setting: 'gentle' | 'full' = 'gentle';
  try {
    await containSelf('gentle', () => setting);
    assert.equal(paceSet(), capped);
    setting = 'full';
    t.mock.timers.tick(CONTAIN_CHECK_MS);
    assert.equal(paceSet(), 'normal');
    setting = 'gentle';
    t.mock.timers.tick(CONTAIN_CHECK_MS);
    assert.equal(paceSet(), capped);
  } finally {
    await paceProcess('full');
  }
});

test("the cap on an agent's job (kit 2.78.3): gentle, its own; full, the manor's ceiling, never the whole processor; none at full under node --test", () => {
  assert.equal(paceCap('gentle', {}), gentleCap());
  assert.equal(paceCap('full', {}), CEILING_CAP);
  assert.equal(CEILING_CAP, 8500);
  assert.equal(paceCap('full', { NODE_TEST_CONTEXT: 'child' }), 0, "a round's pace never puts a test's own process in a job");
  assert.equal(paceCap('gentle', { NODE_TEST_CONTEXT: 'child' }), gentleCap());
});

test("the worker that sets a pace with a cap joins the agent's job, gentle or full (kit 2.78.3); with none it leaves it be", () => {
  assert.match(gentleScript(42, true, 1111, 'C:/k/gentle.dll', null), /\[KitGentle\]::Set\(42, \$true, 1111\) \+ ' ' \+ \[KitGentle\]::Join\(42\)$/);
  assert.match(gentleScript(42, false, 8500, 'C:/k/gentle.dll', null), /\[KitGentle\]::Set\(42, \$false, 8500\) \+ ' ' \+ \[KitGentle\]::Join\(42\)$/);
  assert.match(gentleScript(42, false, 0, 'C:/k/gentle.dll', null), /\[KitGentle\]::Set\(42, \$false, 0\)$/);
});
