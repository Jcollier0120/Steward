import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { freePort } from './free-port.ts';

// Who may read a staff member's page and data (page-access.ts, kit 2.96.0): the token or the cookie a launch URL sets.
// Not strict (as every agent runs until Manor and the staff send the token), every GET is answered as before, so a
// newer agent beside an older Manor changes nothing; strict, only a signed-in GET reads anything. A copy runs on its
// own port and data folder, Manor a made-up one in a scratch folder: never the real profile, its tasks or its staff.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-page-access-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.FIXTURE_PORT = String(await freePort());
process.env.KIT_GENTLE = '0';
process.env.MANOR_HOME = path.join(home, 'manor');
delete process.env.KIT_STRICT_PAGES;
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { APP, port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const A = await import('./fixture/src/kit/page-access.ts');
const { pageAddress } = await import('./fixture/src/kit/service.ts');
const { askRepair } = await import('./fixture/src/kit/repair.ts');

afterEach(() => {
  delete process.env.KIT_STRICT_PAGES;
});
const strict = () => (process.env.KIT_STRICT_PAGES = '1');

const base = `http://127.0.0.1:${port}`;
const cookieName = A.cookieName(port);
const DATA = { secret: 'the agent\'s own data' };

/** An agent's page as every agent serves it: the token in its HTML, its data at /api/data, a button at /api/press. */
const agentPage = () =>
  serve({
    port,
    icon: '<svg/>',
    get: { '/': ({ token }) => ({ html: `<meta name="page-token" content="${token}"><p>page</p>` }), '/api/data': () => ({ json: DATA }), '/print': ({ query }) => ({ html: `<p>print ${query.get('x')}</p>` }) },
    post: { '/api/press': () => ({ json: { pressed: true } }) },
  });

// Each test starts the page again on the same port: a kept-alive connection to the last one would fail the next call.
const call = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: 'manual', ...init, headers: { connection: 'close', ...(init.headers as Record<string, string>) } });
const get = (p: string, headers: Record<string, string> = {}) => call(p, { headers });
const launch = async (token: string, body: unknown = {}) => {
  const r = await call('/api/page-launch', { method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as { url?: string; expires?: string; error?: string } };
};
/** The launch URL's path and query, asked of 127.0.0.1 as the browser asks <id>.localhost. */
const local = (url: string) => {
  const u = new URL(url);
  assert.equal(u.host, `${APP.id}.localhost:${port}`, 'a launch URL names the page by its own host name');
  return u.pathname + u.search;
};
const cookieFrom = (r: Response) => /^([^=]+)=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');

// ---------------------------------------------------------------- the pieces

test('cookies, secrets and where a launch URL may lead', () => {
  assert.equal(A.cookieOf('a=1; castellan_80=k; b=2', 'castellan_80'), 'k');
  assert.equal(A.cookieOf(['a=1', 'castellan_80=k2'], 'castellan_80'), 'k2');
  assert.equal(A.cookieOf('xcastellan_80=k', 'castellan_80'), null);
  assert.equal(A.cookieOf(undefined, 'castellan_80'), null);
  assert.equal(A.sameSecret('abc', 'abc'), true);
  assert.equal(A.sameSecret('abd', 'abc'), false);
  assert.equal(A.sameSecret(['abc'], 'abc'), false);
  assert.equal(A.sameSecret('', ''), false, 'nothing is never a secret');
  const set = A.signInCookie(18000, 'k');
  for (const part of ['castellan_18000=k', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=34560000']) assert.ok(set.split('; ').includes(part), part);
  assert.equal(A.launchPath(undefined), '/');
  assert.equal(A.launchPath('/print?x=1&launch=old'), '/print?x=1', 'never a code of its own');
  for (const bad of ['//evil.example/', '/\\evil.example', 'http://evil.example/', 'evil', '/a\nb', '/#/tour', 7, '/'.repeat(501)]) assert.equal(A.launchPath(bad), null, String(bad));
  assert.equal(A.withLaunch('/print?x=1', 'c0de'), '/print?x=1&launch=c0de');
  assert.deepEqual([A.strictPages({}), A.strictPages({ KIT_STRICT_PAGES: '1' }), A.strictPages({ KIT_STRICT_PAGES: 'yes' })], [false, true, false]);
});

test('a launch code works once, while it lasts; the oldest give way past the most outstanding', () => {
  let now = 1_000_000;
  const l = new A.Launches({ now: () => now, ttlMs: 1000, most: 3 });
  const a = l.mint();
  assert.equal(a.expires, now + 1000);
  assert.equal(l.take(a.code), true);
  assert.equal(l.take(a.code), false, 'used up');
  const b = l.mint();
  now += 1000;
  assert.equal(l.take(b.code), false, 'too old');
  const [c, d, e, f] = [l.mint(), l.mint(), l.mint(), l.mint()];
  assert.deepEqual([c, d, e, f].map((x) => l.take(x.code)), [false, true, true, true]);
  assert.equal(l.take('not-one'), false);
});

test('the page key is made once and kept', () => {
  const file = path.join(home, 'key', A.PAGE_KEY_FILE);
  const k = A.pageKey(file);
  assert.match(k, /^[0-9a-f]{48}$/);
  assert.equal(A.pageKey(file), k);
  writeFileSync(file, '{"key":"short"}');
  assert.notEqual(A.pageKey(file), 'short', 'a key that isn\'t one is made again');
  // A data folder that can't be written (here a file where its folder would be): the page starts all the same.
  writeFileSync(path.join(home, 'not-a-folder'), '');
  assert.match(A.pageKey(path.join(home, 'not-a-folder', A.PAGE_KEY_FILE)), /^[0-9a-f]{48}$/);
});

test("another staff member's token, from its server.json in this account's own data folder", () => {
  const fake = path.join(home, 'profile');
  mkdirSync(path.join(fake, '.wright'), { recursive: true });
  writeFileSync(path.join(fake, '.wright', 'server.json'), '\uFEFF{"pid":1,"port":1,"token":"tok_0123456789abcdef"}');
  assert.equal(A.staffHome('wright', {}, fake), path.join(fake, '.wright'));
  assert.equal(A.staffHome('developer-herald', { DEVELOPER_HERALD_HOME: 'D:\\dh' }, fake), 'D:\\dh');
  assert.equal(A.staffToken('wright', { env: {}, home: fake }), 'tok_0123456789abcdef');
  assert.deepEqual(A.staffHeaders('wright', { env: {}, home: fake }), { 'x-token': 'tok_0123456789abcdef' });
  assert.deepEqual(A.staffHeaders('bailiff', { env: {}, home: fake }), {}, 'none there: no header, as before');
  writeFileSync(path.join(fake, '.wright', 'server.json'), '{"token":"x\\r\\nHost: evil"}');
  assert.deepEqual(A.staffHeaders('wright', { env: {}, home: fake }), {}, 'only a token');
});

// ---------------------------------------------------------------- not strict: as before

test('not strict, every GET is answered as before (an older Manor, the Steward, the Surveyor); the token on a GET is welcome and changes nothing', async () => {
  const { token, close } = await agentPage();
  try {
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(token), 'GET / still carries the token, as an older Manor and every scraper read it');
    assert.deepEqual(await (await get('/api/data')).json(), DATA);
    assert.deepEqual(await (await get('/api/data', { 'x-token': token })).json(), DATA, 'a newer caller that sends the token');
    assert.deepEqual(await (await get('/api/data', { 'x-token': 'stale' })).json(), DATA);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  } finally {
    await close();
  }
});

test('not strict, a launch URL still signs the browser in, so pages are ready for strict; its code works once', async () => {
  const { token, close } = await agentPage();
  try {
    const l = await launch(token, { path: '/print?x=1' });
    assert.equal(l.status, 200);
    assert.ok(Date.parse(l.json.expires!) > Date.now());
    const at = local(l.json.url!);
    const r = await get(at);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/print?x=1', 'the address again, without its code: no bookmark keeps one');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const c = cookieFrom(r);
    assert.equal(c?.[1], cookieName);
    assert.equal(c?.[2], JSON.parse(readFileSync(path.join(process.env.FIXTURE_HOME!, A.PAGE_KEY_FILE), 'utf8')).key, 'the page key');
    const again = await get(at);
    assert.equal(again.status, 200, 'used up: the page as before');
    assert.equal(again.headers.get('set-cookie'), null);
    assert.equal((await call('/api/page-launch', { method: 'POST', body: '{}' })).status, 403, 'only with the token');
    assert.equal((await launch(token, { path: '//evil.example/' })).status, 400);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------- strict

test('strict, a GET that is neither the token nor the cookie gets no data and no token: GET / a page that says to open it from Castellan', async () => {
  strict();
  mkdirSync(path.join(process.env.MANOR_HOME!, 'app'), { recursive: true });
  writeFileSync(path.join(process.env.MANOR_HOME!, 'settings.json'), JSON.stringify({ name: 'Hall <&>', port: 18585 }));
  const { token, close } = await agentPage();
  try {
    const page = await get('/');
    assert.equal(page.status, 200, "an update's probation and Manor's look at the page still see it answer");
    const html = await page.text();
    assert.ok(!html.includes(token), 'never the token');
    assert.match(html, new RegExp(`${APP.name} opens from Hall &lt;&amp;&gt;`));
    assert.ok(html.includes('<a href="http://manor.localhost:18585/">Open Hall &lt;&amp;&gt;</a>'));
    const data = await get('/api/data');
    assert.equal(data.status, 401);
    assert.equal(((await data.json()) as { error: string }).error, A.SIGN_IN_FIRST);
    assert.equal((await get('/print?x=1')).status, 401, 'any page of its but /');
    assert.equal((await get('/api/data', { cookie: `${cookieName}=wrong` })).status, 401);
    assert.equal((await get('/api/data', { 'x-token': 'stale' })).status, 401);
    assert.equal((await get('/nope')).status, 401, 'not even whether a route is there');
    for (const open of ['/api/ping', '/favicon.svg']) assert.equal((await get(open)).status, 200, `${open} is open: whether the page is up`);
    assert.equal((await get(`/?launch=${'0'.repeat(36)}`)).status, 200, 'a code that is none: the page that says to open it from Castellan');
  } finally {
    await close();
    rmSync(process.env.MANOR_HOME!, { recursive: true, force: true });
  }
});

test('strict, the token (Manor, the CLI, another staff member) or the cookie (the browser) reads everything; a cookie alone never presses a button', async () => {
  strict();
  const { token, close } = await agentPage();
  try {
    assert.deepEqual(await (await get('/api/data', { 'x-token': token })).json(), DATA);
    const signIn = await get(local((await launch(token)).json.url!));
    assert.equal(signIn.status, 303);
    assert.equal(signIn.headers.get('location'), '/');
    const cookie = `${cookieName}=${cookieFrom(signIn)![2]}`;
    const page = await get('/', { cookie: `other=1; ${cookie}` });
    assert.ok((await page.text()).includes(token), 'signed in: the page as ever, with its token for its buttons');
    assert.deepEqual(await (await get('/api/data', { cookie })).json(), DATA, "the page's own fetches, images and links send it by themselves");
    assert.equal((await get('/print?x=2', { cookie })).status, 200);
    assert.equal((await call('/api/press', { method: 'POST', headers: { cookie }, body: '{}' })).status, 403, 'the cookie is no token');
    assert.equal((await call('/api/press', { method: 'POST', headers: { 'x-token': token }, body: '{}' })).status, 200);
  } finally {
    await close();
  }
});

test('strict, a bookmark still opens after a restart: the cookie is the page key, kept; the old token is not', async () => {
  strict();
  const first = await agentPage();
  let cookie: string;
  try {
    const signIn = await get(local((await launch(first.token)).json.url!));
    cookie = `${cookieName}=${cookieFrom(signIn)![2]}`;
  } finally {
    await first.close();
  }
  const second = await agentPage();
  try {
    assert.notEqual(second.token, first.token, 'a new token with each start, as ever');
    const page = await get('/', { cookie });
    assert.ok((await page.text()).includes(second.token), 'the bookmark opens signed in, with the new token');
    assert.equal((await get('/api/data', { 'x-token': first.token })).status, 401, "the old run's token reads nothing");
  } finally {
    await second.close();
  }
});

test("strict, the CLI's open gives a launch URL; not strict, the page's own address", async () => {
  const { close } = await agentPage();
  try {
    const { pageUrl } = await import('./fixture/src/app.ts');
    assert.equal(await pageAddress(), pageUrl);
    strict();
    const at = await pageAddress();
    assert.match(at, new RegExp(`^http://${APP.id}\\.localhost:${port}/\\?launch=[0-9a-f]{36}$`));
    assert.equal((await get(local(at))).status, 303, 'and it signs the browser in');
  } finally {
    await close();
  }
});

test("askRepair with the agent's token from its server.json never reads its page for it", async () => {
  const asked: string[] = [];
  const fake: typeof fetch = async (url, init) => {
    asked.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname} ${(init?.headers as Record<string, string>)?.['x-token'] ?? ''}`);
    return new Response(JSON.stringify({ ok: true, did: 'started a round' }), { status: 200 });
  };
  assert.deepEqual(await askRepair('http://wright.localhost:19595', { kind: 'round' }, { fetch: fake, token: 'tok_0123456789abcdef' }), { ok: true, did: 'started a round' });
  assert.deepEqual(asked, ['POST /api/repair tok_0123456789abcdef']);
});
