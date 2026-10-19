import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { freePort } from './free-port.ts';

// The kit's own routes, which an agent's own leave alone (kit-routes.ts): serve() refuses one named as the kit's at
// start, and agent-checks.ts finds it in the agent's source first. A copy runs on its own port and data folder.
const id: string = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8')).name;
const ENV = id.toUpperCase().replace(/-/g, '_');
const home = mkdtempSync(path.join(os.tmpdir(), `${id}-routes-test-`));
process.env[`${ENV}_HOME`] = home;
process.env[`${ENV}_PORT`] = String(await freePort());
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor');
process.env.REEVE_HOME = path.join(home, 'reeve');
after(() => rmSync(home, { recursive: true, force: true }));

const { port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const { KIT_ROUTES, SETTINGS_ROUTE, ownRouteClashes, shadowedRoutes } = await import('./fixture/src/kit/kit-routes.ts');
const { SETTINGS_SPEC: spec } = await import('./fixture/src/settings.ts');

const ok = () => ({ json: { ok: true } });

test("an agent's own routes beside the kit's take none of them; one named as the kit's is named back", () => {
  assert.deepEqual(shadowedRoutes({ get: { '/': ok, '/api/page': ok }, post: { '/api/look': ok, '/api/shrink/stop': ok } }, true), []);
  assert.deepEqual(shadowedRoutes({ post: { '/api/look': ok, '/api/stop': ok } }, false), ['POST /api/stop']);
  assert.deepEqual(shadowedRoutes({ get: { '/api/ping': ok, '/page.js': ok }, post: { '/api/duty': ok } }, false), ['GET /api/ping', 'GET /page.js', 'POST /api/duty']);
  // The kit has no GET /api/stop: an own one takes nothing.
  assert.deepEqual(shadowedRoutes({ get: { '/api/stop': ok } }, false), []);
  // The Settings panel's API is the kit's only when serve() is given the settings.
  assert.deepEqual(shadowedRoutes({ get: { [SETTINGS_ROUTE]: ok }, post: { [SETTINGS_ROUTE]: ok } }, false), []);
  assert.deepEqual(shadowedRoutes({ get: { [SETTINGS_ROUTE]: ok }, post: { [SETTINGS_ROUTE]: ok } }, true), [`GET ${SETTINGS_ROUTE}`, `POST ${SETTINGS_ROUTE}`]);
});

test("KIT_ROUTES names every route server.ts answers itself, and only those", () => {
  const source = readFileSync(new URL('../node/server.ts', import.meta.url), 'utf8');
  const table = (name: 'get' | 'post', end: string) => {
    const from = source.indexOf(`const ${name}: Record<string, Handler> = {`);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `server.ts builds its ${name} table, then spreads ${end} over it`);
    return [...source.slice(from, to).matchAll(/^\s*'(\/[^']*)':/gm)].map((m) => m[1]).sort();
  };
  assert.deepEqual(table('get', '...opts.get'), [...KIT_ROUTES.get].sort());
  assert.deepEqual(table('post', '...opts.post'), [...KIT_ROUTES.post].sort());
  assert.match(source, new RegExp(`get\\['${SETTINGS_ROUTE}'\\] =`), "the Settings panel's GET");
  assert.match(source, new RegExp(`post\\['${SETTINGS_ROUTE}'\\] =`), "the Settings panel's POST");
});

/** Whether nothing listens on the port: it can be taken. */
const free = (p: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });

test("serve() refuses an own route named as the kit's before anything starts: nothing listens, no server.json", async () => {
  // The Chronicler's shrinking card until its 0.4.17: its Stop took the kit's, and the page couldn't be ended.
  await assert.rejects(serve({ port, icon: '<svg/>', post: { '/api/stop': ok } }), /own POST \/api\/stop would take the kit's place.*Give it a name of its own/);
  await assert.rejects(serve({ port, icon: '<svg/>', settings: spec, get: { '/api/ping': ok, [SETTINGS_ROUTE]: ok } }), /own GET \/api\/ping, GET \/api\/settings would take the kit's place.*each a name/);
  assert.ok(await free(port), 'nothing listens on its port');
  assert.ok(!existsSync(path.join(home, 'server.json')), 'no server.json, which shutdown would read');

  // Named its own, the route answers beside the kit's.
  const { token, close } = await serve({ port, icon: '<svg/>', settings: spec, post: { '/api/shrink/stop': ok } });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/shrink/stop`, { method: 'POST', headers: { 'x-token': token }, body: '{}' });
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ping`)).status, 200);
  } finally {
    await close();
  }
});

test("agent-checks' look at the source finds an own route named as the kit's, and nothing else", () => {
  const root = path.join(home, 'agent');
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  assert.deepEqual(ownRouteClashes(root), [], 'no src: nothing to find');
  put(
    'src/agent.ts',
    [
      'await serve({',
      '  post: {',
      "    '/api/look': () => round.runNow(),",
      "    '/api/stop': () => shrinker.stop(),",
      '  },',
      '});',
      "const next = busy ? '/api/stop' : '/api/look';",
      "await fetch(`${base}/api/stop`, { method: 'POST' });",
      "const labels = { '/api/stopped': 'Stopped' };",
    ].join('\n'),
  );
  put('src/lib/more.ts', 'export const routes = { "/favicon.svg": icon, \'/api/page\': page };\n');
  // The kit's own copy, and the web page, aren't the agent's routes.
  put('src/kit/server.ts', "const post = { '/api/stop': stop };\n");
  put('src/web/page.tsx', "const titles = { '/api/ping': 'Ping' };\n");
  assert.deepEqual(ownRouteClashes(root), [
    { file: 'src/agent.ts', line: 4, route: '/api/stop' },
    { file: 'src/lib/more.ts', line: 1, route: '/favicon.svg' },
  ]);
});
