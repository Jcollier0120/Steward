import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, test } from 'node:test';
import { freePort } from './free-port.ts';

// An open page across its server's restart (react/page-data.ts' post, kit 2.143.3): the server starts with a new token
// each time (an update restarts it), and the tab holds the old one. A POST refused for it reads the new token from the
// page (GET /, signed in by the cookie when strict) and is sent once more; where the page can't get it, it says it is out
// of date, with a Reload. The page's script runs here against the fixture's real server, in a tab made up of its
// <meta name="page-token">, its #page-data and a fetch that sends what a browser sends. Each step waits for the last.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-page-restart-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.FIXTURE_PORT = String(await freePort());
process.env.KIT_GENTLE = '0';
process.env.MANOR_HOME = path.join(home, 'manor');
delete process.env.KIT_STRICT_PAGES;
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { bundleForNode, importPath } = await import('./react-render.ts');
const { APP, port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const A = await import('./fixture/src/kit/page-access.ts');

type Posted = { ok: boolean; json: { error?: string; [k: string]: unknown } };
const page = await bundleForNode<{ post: (path: string, body?: unknown) => Promise<Posted>; form: (data: unknown) => string }>(
  `import { renderToStaticMarkup as r } from 'react-dom/server';
   import { post, SettingsForm } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   export const form = (data) => r(<SettingsForm initial={data} />);
   export { post };`,
);

afterEach(() => {
  delete process.env.KIT_STRICT_PAGES;
});
const strict = () => (process.env.KIT_STRICT_PAGES = '1');

const realFetch = globalThis.fetch;
const base = `http://127.0.0.1:${port}`;
const origin = `http://${APP.id}.localhost:${port}`;

/** The fixture's page as an agent serves it: its token in its HTML, a button at /api/press. */
const agentPage = () =>
  serve({
    port,
    icon: '<svg/>',
    get: { '/': ({ token }) => ({ html: `<!doctype html><meta name="page-token" content="${token}"><div id="root"></div>` }) },
    post: { '/api/press': ({ body }) => ({ json: { pressed: true, body } }) },
  });

/** A launch URL's sign-in, as Manor's Open gives a browser: the cookie it sets. */
async function signIn(token: string): Promise<string> {
  const l = (await (await realFetch(`${base}/api/page-launch`, { method: 'POST', headers: { 'x-token': token, connection: 'close' }, body: '{}' })).json()) as { url: string };
  const u = new URL(l.url);
  const r = await realFetch(`${base}${u.pathname}${u.search}`, { redirect: 'manual', headers: { connection: 'close' } });
  return /^([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1];
}

/**
 * A tab opened while the page's token was `token`, at version `version`: its document as page-data.ts reads it, and its
 * fetch, relative to `at`, with its cookie, a script's Sec-Fetch-Mode and, on a POST, its Origin. `seen` is each
 * request, its token named "old" (the tab's first), "new" or as sent.
 */
function tab(token: string, o: { version?: string; cookie?: string; at?: string } = {}) {
  const meta = { content: token, getAttribute: (k: string) => (k === 'content' ? meta.content : null), setAttribute: (k: string, v: string) => k === 'content' && (meta.content = v) };
  const data = { textContent: JSON.stringify({ shell: { app: { id: APP.id, name: APP.name, role: APP.role, version: o.version ?? APP.version } }, body: {} }) };
  const seen: string[] = [];
  Object.assign(globalThis, {
    location: { hash: '' },
    document: { documentElement: { dataset: {} }, querySelector: (s: string) => (s === 'meta[name="page-token"]' ? meta : null), getElementById: (id: string) => (id === 'page-data' ? data : null) },
    fetch: (p: string, init: RequestInit = {}) => {
      const headers = { ...(init.headers as Record<string, string>) };
      const sent = headers['x-token'];
      seen.push(`${init.method ?? 'GET'} ${p}${sent === undefined ? '' : ` ${sent === token ? 'old' : sent === meta.content ? 'new' : sent}`}`);
      if (init.method === 'POST') headers.origin = origin;
      return realFetch(`${o.at ?? base}${p}`, { ...init, redirect: 'manual', headers: { connection: 'close', 'sec-fetch-mode': 'cors', ...(o.cookie ? { cookie: o.cookie } : {}), ...headers } });
    },
  });
  return { meta, seen };
}
after(() => {
  globalThis.fetch = realFetch;
});

const settings = { schema: [{ key: 'notes', kind: 'switch', label: 'Notes' }], values: { notes: true }, defaults: { notes: false }, problems: [], warnings: {}, file: '' };
const reloadIn = (html: string) => />Reload</.test(html);

test('not strict: a page whose server started again saves with the new token, read from the page once, and keeps it', async () => {
  const first = await agentPage();
  const t = tab(first.token);
  await first.close();
  const second = await agentPage();
  try {
    assert.notEqual(second.token, first.token);
    assert.deepEqual(await page.post('/api/press', { a: 1 }), { ok: true, json: { pressed: true, body: { a: 1 } } });
    assert.deepEqual(t.seen, ['POST /api/press old', 'GET /', 'POST /api/press new'], 'refused, the page read again, the same POST once more');
    assert.equal(t.meta.content, second.token, 'the new token kept in the page');
    t.seen.length = 0;
    assert.equal((await page.post('/api/press')).ok, true);
    assert.deepEqual(t.seen, ['POST /api/press new'], 'the POSTs after send it at once');
    assert.ok(!reloadIn(page.form(settings)), 'nothing out of date: no Reload');
  } finally {
    await second.close();
  }
});

test('strict: signed in by its cookie, a page whose server started again saves with the new token', async () => {
  strict();
  const first = await agentPage();
  const cookie = await signIn(first.token);
  const t = tab(first.token, { cookie });
  await first.close();
  const second = await agentPage();
  try {
    assert.deepEqual(await page.post('/api/press'), { ok: true, json: { pressed: true, body: {} } });
    assert.deepEqual(t.seen, ['POST /api/press old', 'GET /', 'POST /api/press new']);
    assert.equal(t.meta.content, second.token);
  } finally {
    await second.close();
  }
});

test("strict, its cookie no longer taken: no second POST, and the page says it's out of date since its agent updated, with a Reload by Save", async () => {
  strict();
  const first = await agentPage();
  const cookie = await signIn(first.token);
  const t = tab(first.token, { cookie, version: '0.0.0' });
  await first.close();
  // A page key made again (its file gone): the browser's cookie signs nothing in, and GET / is the page that says to
  // open it from Castellan, with no token.
  rmSync(path.join(process.env.FIXTURE_HOME!, A.PAGE_KEY_FILE));
  const second = await agentPage();
  try {
    assert.ok(!reloadIn(page.form(settings)));
    const r = await page.post('/api/settings', { values: { notes: false } });
    assert.deepEqual(r, { ok: false, json: { error: `This page is out of date since ${APP.name} updated. Reload it, then try again.` } });
    assert.deepEqual(t.seen, ['POST /api/settings old', 'GET /', 'GET /api/ping'], 'never sent again without a new token');
    assert.equal(t.meta.content, first.token);
    assert.ok(reloadIn(page.form(settings)), "the Settings form's bar offers a Reload");
    // The same version as the page opened at: restarted, not updated.
    tab(first.token, { cookie });
    assert.equal((await page.post('/api/press')).json.error, `This page is out of date since ${APP.name} restarted. Reload it, then try again.`);
  } finally {
    await second.close();
  }
});

test('never loops: a POST refused again with the new token is sent twice in all, then the page says to reload', async () => {
  const fakePort = await freePort();
  const fresh = 'tok_new_0123456789abcdef';
  // A server that refuses every POST and gives a new token on its page.
  const fake = http.createServer((req, res) => {
    if (req.method === 'POST') return void res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"forbidden"}');
    if (req.url === '/api/ping') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: APP.version }));
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<meta name="page-token" content="${fresh}">`);
  });
  await new Promise<void>((r) => fake.listen(fakePort, '127.0.0.1', r));
  try {
    const t = tab('tok_old_0123456789abcdef', { at: `http://127.0.0.1:${fakePort}` });
    const r = await page.post('/api/press');
    assert.equal(r.ok, false);
    assert.match(r.json.error!, /^This page is out of date since/);
    assert.deepEqual(t.seen, ['POST /api/press old', 'GET /', 'POST /api/press new', 'GET /api/ping']);
  } finally {
    fake.closeAllConnections();
    await new Promise((r) => fake.close(r));
  }
});
