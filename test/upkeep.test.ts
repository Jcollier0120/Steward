import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { appendRotating, pokePage, pruneKits, tellAfterRelease } from '../src/upkeep.ts';

// The Steward's housekeeping: stages.log rotated, kit versions no one pins let go, and pages told of a release.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-upkeep-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('stages.log is rotated past its size: two old ones kept, the oldest let go', () => {
  const log = path.join(tmp, 'stages.log');
  const line = `${'x'.repeat(99)}\n`;
  for (let i = 0; i < 35; i++) appendRotating(log, line, { max: 1000, keep: 2 });
  assert.ok(statSync(log).size <= 1000);
  assert.ok(existsSync(path.join(tmp, 'stages.1.log')));
  assert.ok(existsSync(path.join(tmp, 'stages.2.log')));
  assert.ok(!existsSync(path.join(tmp, 'stages.3.log')));
  assert.equal(readFileSync(path.join(tmp, 'stages.1.log'), 'utf8').length, 1000, 'each full when it was rotated');
});

test('kit versions no one pins are let go, beyond the newest three; a pinned one, or one touched today, stays', () => {
  const kits = path.join(tmp, 'kits');
  const old = new Date(Date.now() - 3 * 24 * 3600_000);
  for (const v of ['1.0.0', '1.2.1', '2.0.0', '2.7.0', '2.8.0', '2.8.1', '2.8.2', '2.9.0']) {
    mkdirSync(path.join(kits, v), { recursive: true });
    writeFileSync(path.join(kits, v, 'VERSION'), `${v}\n`);
    if (v !== '2.0.0') utimesSync(path.join(kits, v), old, old);
  }
  mkdirSync(path.join(kits, 'not-a-version'));
  assert.deepEqual(pruneKits(kits, ['1.2.1', null, undefined, '2.7.0']).sort(), ['1.0.0', '2.8.0']);
  assert.ok(existsSync(path.join(kits, '2.0.0')), 'touched today: a fill may be reading it');
  assert.ok(existsSync(path.join(kits, 'not-a-version')));
  assert.deepEqual(pruneKits(path.join(tmp, 'no-kits'), []), []);
});

/** A page with the kit's and Manor's rules: its token in the page, a POST only with it and from its own origin or none. */
async function fakePage(o: { token?: boolean } = {}) {
  const token = 'f'.repeat(48);
  const posts: { path: string; token: string | undefined; origin: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') return res.end(o.token === false ? '<html>an older page</html>' : `<html><head><meta name="page-token" content="${token}"></head></html>`);
    if (req.method === 'POST') {
      const t = req.headers['x-token'];
      posts.push({ path: req.url ?? '', token: typeof t === 'string' ? t : undefined, origin: req.headers.origin });
      if (t !== token || req.headers.origin !== undefined) return res.writeHead(403).end('{"error":"forbidden"}');
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"started":true}');
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts, close: () => new Promise((r) => server.close(r)) };
}

test("a page is told as its own button would: the token read from the page, the POST with it and no Origin", async () => {
  const page = await fakePage();
  try {
    assert.deepEqual(await pokePage(`${page.base}/api/updates/check`), { ok: true, said: 'HTTP 200' });
    assert.deepEqual(page.posts, [{ path: '/api/updates/check', token: 'f'.repeat(48), origin: undefined }]);
  } finally {
    await page.close();
  }
  assert.deepEqual(await pokePage('https://example.com/api/run'), { ok: false, said: 'not a local address' });
  const older = await fakePage({ token: false });
  try {
    assert.deepEqual(await pokePage(`${older.base}/api/run`), { ok: false, said: 'its page (HTTP 200) carries no token' });
    assert.deepEqual(older.posts, [], 'nothing POSTed without a token');
  } finally {
    await older.close();
  }
});

test("after a release each page is told, and one that doesn't answer is only logged; never the live pages under node --test", async () => {
  const lines: string[] = [];
  const asked: string[] = [];
  await tellAfterRelease(['http://127.0.0.1:18585/api/updates/check', 'http://127.0.0.1:19191/api/run'], (l) => lines.push(l), async (u) => (asked.push(u), u.includes('19191') ? { ok: false, said: 'connect ECONNREFUSED' } : { ok: true, said: 'HTTP 200' }));
  assert.deepEqual(asked, ['http://127.0.0.1:18585/api/updates/check', 'http://127.0.0.1:19191/api/run']);
  assert.deepEqual(lines.sort(), ["couldn't tell http://127.0.0.1:19191/api/run of the release: connect ECONNREFUSED", 'told http://127.0.0.1:18585/api/updates/check of the release (HTTP 200)']);
  const none: string[] = [];
  await tellAfterRelease(['http://127.0.0.1:18585/api/updates/check'], (l) => none.push(l));
  assert.deepEqual(none, [], 'no stand-in under node --test: nothing is told');
});
