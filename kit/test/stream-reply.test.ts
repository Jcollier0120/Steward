import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { freePort } from './free-port.ts';

// A handler's reply streamed as it's made (kit 2.61.0), and the signal that tells it the client went away.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-stream-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.FIXTURE_PORT = String(await freePort()); // never the fixture's own 17979, which every checkout's tests share
process.env.KIT_GENTLE = '0';
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');

/** Waits for `ok()`, up to a deadline, never a fixed sleep. */
async function until(ok: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

test('a streamed reply: sent as it comes, with its type and status; its headers reach the handler; HEAD reads none of it', async () => {
  let seen: http.IncomingHttpHeaders | undefined;
  let headDestroyed = false;
  const { close } = await serve({
    port,
    icon: '<svg/>',
    get: {
      '/api/live': (req) => {
        seen = req.headers;
        const s = Readable.from([Buffer.from('one,'), Buffer.from('two,'), Buffer.from('three')]);
        s.once('close', () => (headDestroyed = true));
        return { stream: s, type: 'video/mp2t', status: 206 };
      },
    },
  });
  try {
    const got = await new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/live', headers: { host: `127.0.0.1:${port}`, 'x-castellan-peer': 'pc-1' } }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c) => parts.push(c)).on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body: Buffer.concat(parts).toString() }));
      }).on('error', reject);
    });
    assert.deepEqual(got, { status: 206, type: 'video/mp2t', body: 'one,two,three' });
    assert.equal(seen?.['x-castellan-peer'], 'pc-1', "the request's headers, as Node gives them");
    headDestroyed = false;
    const head = await new Promise<number>((resolve, reject) => {
      http.request({ method: 'HEAD', host: '127.0.0.1', port, path: '/api/live', headers: { host: `127.0.0.1:${port}` } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject).end();
    });
    assert.equal(head, 206);
    await until(() => headDestroyed, 'the HEAD reply to destroy its stream');
  } finally {
    await close();
  }
});

test('a client going away aborts the signal and destroys the stream that never ends', async () => {
  let aborted = false;
  let destroyed = false;
  const { close } = await serve({
    port,
    icon: '<svg/>',
    get: {
      '/api/live': (req) => {
        req.signal?.addEventListener('abort', () => (aborted = true));
        // A stream with no end, as a live recording is: a chunk whenever it's read.
        const s = new Readable({ read() { this.push(Buffer.alloc(1024, 1)); } });
        s.once('close', () => (destroyed = true));
        return { stream: s, type: 'application/octet-stream' };
      },
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/live', headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let got = 0;
        res.on('data', (c: Buffer) => {
          got += c.length;
          // Enough to know it streams; then the client goes away.
          if (got > 64 * 1024) {
            r.destroy();
            resolve();
          }
        });
      });
      r.on('error', (e) => (r.destroyed ? undefined : reject(e)));
    });
    await until(() => aborted && destroyed, 'the signal to abort and the stream to be destroyed');
  } finally {
    await close();
  }
});

test('a JSON reply that ends normally never aborts the signal', async () => {
  let signal: AbortSignal | undefined;
  const { close } = await serve({ port, icon: '<svg/>', get: { '/api/quick': (req) => ((signal = req.signal), { json: { ok: true } }) } });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/quick', headers: { host: `127.0.0.1:${port}` } }, (res) => (res.resume(), res.on('end', () => resolve(res.statusCode ?? 0)))).on('error', reject);
    });
    assert.equal(status, 200);
    assert.ok(signal);
    assert.equal(signal.aborted, false);
  } finally {
    await close();
  }
});
