import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The release's last step (exchequer.ts): the same files as GitHub's, to the Exchequer, Castellan's release service.
// Nothing here reaches the internet: a fake Exchequer answers on this PC, and every call names its env and home, so the
// publisher's key of the PC the tests run on is never read.
const { EXCHEQUER_URL, KEY_FILE, NEVER_SOLD, NOT_PUBLISHED, exchequerUrl, publishToExchequer, publisherKey, withoutKey } = await import('./fixture/src/kit/exchequer.ts');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fixture-exchequer-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const KEY = 'fake-publisher-key-for-the-tests-0123456789';
const SOLD = [
  { id: 'porter', tier: 'household' },
  { id: 'steward', tier: 'workshop' },
  { id: 'manor', tier: 'free' },
];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Draft {
  assets: { name: string; size: number; sha256: string }[];
  announcement: unknown;
  commit: string;
  notes: string;
  status: 'draft' | 'published';
}

/** A fake Exchequer: the agents list, drafts, signed uploads (to itself), and /done checking every file as the real one does. */
async function fakeExchequer() {
  const drafts = new Map<string, Draft>();
  const stored = new Map<string, Buffer>();
  const seen: { method: string; url: string; auth: string | null }[] = [];
  const o = { down: false, failUploads: 0, doneSaysAlready: false, echoAuth: false };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const auth = req.headers.authorization ?? null;
    seen.push({ method: req.method!, url: req.url!, auth });
    const send = (status: number, j: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(j));
    };
    if (o.down) return send(503, { error: 'unavailable', message: "The Exchequer's database didn't answer." });
    if (req.method === 'GET' && req.url === '/api/v1/agents') return send(200, { agents: SOLD });
    const up = /^\/upload\/([^/]+)\/([^/]+)$/.exec(req.url!);
    if (up && req.method === 'PUT') {
      if (o.failUploads > 0) {
        o.failUploads--;
        return send(500, { error: 'internal', message: 'R2 said no' });
      }
      stored.set(`${up[1]}/${decodeURIComponent(up[2])}`, body);
      res.writeHead(200);
      return res.end();
    }
    const m = /^\/api\/v1\/publish\/([^/]+)\/([^/]+)(\/done)?$/.exec(req.url!);
    if (m && req.method === 'POST') {
      if (auth !== `Bearer ${KEY}`) return send(401, { error: 'unauthorized', message: o.echoAuth ? `Publishing needs the publisher's key, not ${auth}.` : "Publishing needs the publisher's key." });
      if (o.echoAuth) return send(500, { error: 'internal', message: `Something went wrong with ${auth}` });
      const tag = `${m[1]}-v${m[2]}`;
      const d = drafts.get(tag);
      if (!m[3]) {
        if (d?.status === 'published') return send(409, { error: 'already-published', message: `${tag} is published already: a version is never published twice.` });
        const j = JSON.parse(body.toString('utf8'));
        drafts.set(tag, { assets: j.assets, announcement: j.announcement ?? null, commit: j.commit, notes: j.notes, status: 'draft' });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return send(201, { release: { id: m[1], version: m[2], tag, status: 'draft' }, uploads: j.assets.map((a: { name: string }) => ({ name: a.name, url: `${base}/upload/${tag}/${encodeURIComponent(a.name)}`, method: 'PUT', headers: { 'content-type': 'application/octet-stream' } })) });
      }
      if (!d) return send(404, { error: 'not-found', message: `There's no draft of ${tag}.` });
      if (d.status === 'published' || o.doneSaysAlready) return send(200, { release: { tag }, alreadyPublished: true });
      const problems = d.assets.filter((a) => {
        const b = stored.get(`${tag}/${a.name}`);
        return !b || b.length !== a.size || sha(b) !== a.sha256;
      });
      if (problems.length) return send(422, { error: 'upload-mismatch', message: `${problems.map((p) => `${p.name}: not uploaded`).join('; ')}. Upload again, then ask once more.` });
      d.status = 'published';
      return send(200, { release: { tag } });
    }
    send(404, { error: 'not-found', message: 'no such route' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, drafts, stored, seen, o, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A built release's files: the zip, SHA256SUMS.txt and manor-agent.json. */
function releaseFiles(id: string, version: string, announce = true): string[] {
  const dir = path.join(tmp, `${id}-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, `${id[0].toUpperCase()}${id.slice(1)}-${version}.zip`);
  writeFileSync(zip, Buffer.from(`PK zip of ${id} ${version} ${'x'.repeat(5000)}`));
  const files = [zip];
  if (announce) {
    const a = path.join(dir, 'manor-agent.json');
    writeFileSync(a, JSON.stringify({ agent: { id, release: { kind: 'node' } } }));
    files.push(a);
  }
  const sums = path.join(dir, 'SHA256SUMS.txt');
  writeFileSync(sums, 'sums\n');
  return [zip, sums, ...files.slice(1)];
}

/** A home folder, with the publisher's key in it (written as a person would: a newline after it) or none. */
function homeWith(key: string | null): string {
  const home = mkdtempSync(path.join(tmp, 'home-'));
  if (key !== null) {
    mkdirSync(path.join(home, '.steward'), { recursive: true });
    writeFileSync(path.join(home, KEY_FILE), `  ${key}\r\n`);
  }
  return home;
}

const lines: string[] = [];
const run = async (r: Parameters<typeof publishToExchequer>[0], o: Parameters<typeof publishToExchequer>[1]) => {
  const out = await publishToExchequer(r, o);
  lines.push(out.line);
  return out;
};
const release = (id: string, version: string, announce = true) => ({ id, version, commit: 'abc1234', notes: `## ${version}\n\n**Notes.**`, files: releaseFiles(id, version, announce) });

test('a sold agent is published: a draft with each file, each uploaded to its signed URL without the key, then /done', async () => {
  const x = await fakeExchequer();
  try {
    const r = release('porter', '0.4.26');
    const out = await run(r, { env: { EXCHEQUER_URL: `${x.url}/` }, home: homeWith(KEY) });
    assert.deepEqual([out.ok, out.outcome], [true, 'published'], out.line);
    assert.equal(out.line, 'Published to the Exchequer: porter-v0.4.26 (Porter-0.4.26.zip, SHA256SUMS.txt, manor-agent.json).');
    const d = x.drafts.get('porter-v0.4.26')!;
    assert.equal(d.status, 'published');
    assert.equal(d.commit, 'abc1234');
    assert.match(d.notes, /\*\*Notes\.\*\*/);
    assert.deepEqual(d.announcement, { agent: { id: 'porter', release: { kind: 'node' } } }, 'manor-agent.json goes as the announcement too');
    assert.deepEqual(d.assets.map((a) => a.name), ['Porter-0.4.26.zip', 'SHA256SUMS.txt', 'manor-agent.json']);
    for (const a of d.assets) assert.equal(sha(x.stored.get(`porter-v0.4.26/${a.name}`)!), a.sha256);
    assert.deepEqual(x.seen.map((s) => `${s.method} ${s.url.replace(/\/upload\/.*/, '/upload/…')}`), ['GET /api/v1/agents', 'POST /api/v1/publish/porter/0.4.26', 'PUT /upload/…', 'PUT /upload/…', 'PUT /upload/…', 'POST /api/v1/publish/porter/0.4.26/done']);
    assert.ok(x.seen.filter((s) => s.method === 'POST').every((s) => s.auth === `Bearer ${KEY}`), 'the trimmed key, as a Bearer token, to the Exchequer');
    assert.ok(x.seen.filter((s) => s.method !== 'POST').every((s) => s.auth === null), 'never to the agents list or the storage');

    // Again: it is published already, which is done.
    const again = await run(r, { env: { EXCHEQUER_URL: x.url }, home: homeWith(KEY) });
    assert.deepEqual([again.ok, again.outcome], [true, 'already']);
    assert.equal(again.line, 'The Exchequer has porter-v0.4.26 published already.');
  } finally {
    await x.close();
  }
});

test('a publish that broke halfway is finished by running it again; /done saying alreadyPublished is done', async () => {
  const x = await fakeExchequer();
  try {
    const r = release('steward', '0.12.5', false);
    x.o.failUploads = 1;
    const first = await run(r, { env: { EXCHEQUER_URL: x.url, EXCHEQUER_PUBLISHER_KEY: KEY }, home: homeWith(null) });
    assert.deepEqual([first.ok, first.outcome], [false, 'failed']);
    assert.ok(first.line.startsWith(`${NOT_PUBLISHED} uploading Steward-0.12.5.zip failed: R2 said no (500 internal).`), first.line);
    assert.match(first.line, /The GitHub release stands; npm run release -- --exchequer finishes it\.$/);
    assert.equal(x.drafts.get('steward-v0.12.5')!.status, 'draft');

    const second = await run(r, { env: { EXCHEQUER_URL: x.url, EXCHEQUER_PUBLISHER_KEY: KEY }, home: homeWith(null) });
    assert.deepEqual([second.ok, second.outcome], [true, 'published'], second.line);
    assert.equal(x.drafts.get('steward-v0.12.5')!.status, 'published');

    const r2 = release('porter', '0.4.27');
    x.o.doneSaysAlready = true;
    const third = await run(r2, { env: { EXCHEQUER_URL: x.url, EXCHEQUER_PUBLISHER_KEY: KEY }, home: homeWith(null) });
    assert.deepEqual([third.ok, third.outcome], [true, 'already']);
  } finally {
    await x.close();
  }
});

test('no publisher key: a plain note, and nothing asked of the Exchequer', async () => {
  const x = await fakeExchequer();
  try {
    const home = homeWith(null);
    const out = await run(release('porter', '0.4.28'), { env: { EXCHEQUER_URL: x.url }, home });
    assert.deepEqual([out.ok, out.outcome], [true, 'no-key']);
    assert.equal(out.line, `${NOT_PUBLISHED} no publisher key at ${path.join(home, '.steward', 'exchequer-publisher.key')} (or EXCHEQUER_PUBLISHER_KEY).`);
    assert.equal(x.seen.length, 0);
    // A blank key file is no key.
    mkdirSync(path.join(home, '.steward'), { recursive: true });
    writeFileSync(path.join(home, KEY_FILE), ' \n');
    assert.deepEqual(publisherKey({}, home), { missing: path.join(home, KEY_FILE) });
    assert.deepEqual(publisherKey({ EXCHEQUER_PUBLISHER_KEY: ` ${KEY} ` }, home), { key: KEY }, 'the environment, trimmed');
    assert.deepEqual(publisherKey({}, homeWith(KEY)), { key: KEY }, 'the file, trimmed');
  } finally {
    await x.close();
  }
});

test('Heiward and Manor are never published there, nor an agent the Exchequer does not list', async () => {
  const x = await fakeExchequer();
  try {
    assert.deepEqual(NEVER_SOLD, ['manor', 'heiward']);
    for (const id of ['heiward', 'manor']) {
      const out = await run(release(id, '1.7.2'), { env: { EXCHEQUER_URL: x.url, EXCHEQUER_PUBLISHER_KEY: KEY }, home: homeWith(KEY) });
      assert.deepEqual([out.ok, out.outcome], [true, 'not-sold']);
      assert.equal(out.line, `The Exchequer: ${id} isn't sold there, so ${id}-v1.7.2 is on GitHub alone.`);
    }
    assert.equal(x.seen.length, 0, 'not even asked: Heiward is free, and Manor updates from GitHub');

    const out = await run(release('stranger', '0.1.0'), { env: { EXCHEQUER_URL: x.url, EXCHEQUER_PUBLISHER_KEY: KEY }, home: homeWith(KEY) });
    assert.deepEqual([out.ok, out.outcome], [true, 'not-sold']);
    assert.equal(out.line, "The Exchequer: stranger isn't one of the agents it sells, so stranger-v0.1.0 is on GitHub alone.");
    assert.deepEqual(x.seen.map((s) => `${s.method} ${s.url}`), ['GET /api/v1/agents'], 'asked which it sells, and nothing published');
  } finally {
    await x.close();
  }
});

test("the Exchequer down, or refusing, fails nothing: it says so in a line, and the key is never in it", async () => {
  const x = await fakeExchequer();
  const env = { EXCHEQUER_URL: x.url, EXCHEQUER_PUBLISHER_KEY: KEY };
  try {
    x.o.down = true;
    const down = await run(release('porter', '0.4.29'), { env, home: homeWith(null) });
    assert.deepEqual([down.ok, down.outcome], [false, 'failed']);
    assert.equal(down.line, `${NOT_PUBLISHED} couldn't ask ${x.url} which agents it sells: The Exchequer's database didn't answer. (503 unavailable). The GitHub release stands; npm run release -- --exchequer finishes it.`);

    // An Exchequer that says the key back: the line has it taken out.
    x.o.down = false;
    x.o.echoAuth = true;
    const echoed = await run(release('porter', '0.4.30'), { env, home: homeWith(null) });
    assert.equal(echoed.ok, false);
    assert.match(echoed.line, /Something went wrong with Bearer \[the publisher key\]/);
    const wrongKey = await run(release('porter', '0.4.30'), { env: { ...env, EXCHEQUER_PUBLISHER_KEY: 'a-wrong-key-for-the-tests' }, home: homeWith(null) });
    assert.match(wrongKey.line, /Publishing needs the publisher's key, not Bearer \[the publisher key\]/);
    assert.ok(!wrongKey.line.includes('a-wrong-key-for-the-tests'));
  } finally {
    await x.close();
  }
  // Nothing listening at all.
  const gone = await run(release('porter', '0.4.31'), { env, home: homeWith(null) });
  assert.deepEqual([gone.ok, gone.outcome], [false, 'failed']);
  assert.match(gone.line, new RegExp(`^${NOT_PUBLISHED} couldn't reach http://127\\.0\\.0\\.1:\\d+: fetch failed \\((ECONNREFUSED|ECONNRESET)\\)\\.`));
  // A release's files missing is said, not thrown.
  const r = release('porter', '0.4.32');
  rmSync(r.files[0]);
  const x2 = await fakeExchequer();
  try {
    const missing = await run(r, { env: { ...env, EXCHEQUER_URL: x2.url }, home: homeWith(null) });
    assert.deepEqual([missing.ok, missing.outcome], [false, 'failed']);
    assert.match(missing.line, /its files couldn't be read: ENOENT/);
  } finally {
    await x2.close();
  }

  for (const line of lines) assert.ok(!line.includes(KEY), `no line holds the key: ${line}`);
});

test("the Exchequer's address: EXCHEQUER_URL, else Castellan's", () => {
  assert.equal(EXCHEQUER_URL, 'https://api.castellan-software.com');
  assert.equal(exchequerUrl({}), 'https://api.castellan-software.com');
  assert.equal(exchequerUrl({ EXCHEQUER_URL: ' http://127.0.0.1:3000// ' }), 'http://127.0.0.1:3000');
  assert.equal(withoutKey(`a ${KEY} b ${KEY}`, KEY), 'a [the publisher key] b [the publisher key]');
});
