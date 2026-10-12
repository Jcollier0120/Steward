import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { changed, entryLine, parseVersions, readSigned, RECALL_KEY_FILE, RECALLS_KIND, sendChange, signRecalls } from '../src/recalls.ts';

const NOW = new Date('2026-10-11T12:00:00.000Z');

test('--versions: one version, a range, or either end open', () => {
  assert.deepEqual(parseVersions('0.4.26'), { from: '0.4.26', to: '0.4.26' });
  assert.deepEqual(parseVersions('0.4.20..0.4.26'), { from: '0.4.20', to: '0.4.26' });
  assert.deepEqual(parseVersions('..0.4.26'), { to: '0.4.26' });
  assert.deepEqual(parseVersions('0.4.20..'), { from: '0.4.20' });
  assert.throws(() => parseVersions('..'), /takes/);
  assert.throws(() => parseVersions('four'), /isn't a version/);
});

test('each change is the list before it with one more number; a why is needed, and ends its sentence', () => {
  const one = changed(null, { kind: 'recall', id: 'porter', why: 'It could delete files it should have kept', versions: { from: '0.4.26', to: '0.4.26' } }, NOW);
  assert.equal(one.seq, 1);
  assert.equal(one.kind, RECALLS_KIND);
  assert.equal(one.entries[0].why, 'It could delete files it should have kept.');
  const two = changed(one, { kind: 'retire', id: 'butler', why: 'The Cellarer backs up game saves now.', instead: 'cellarer' }, NOW);
  assert.equal(two.seq, 2);
  assert.deepEqual(two.entries.map((e) => e.id), ['porter', 'butler']);
  assert.equal(entryLine(two.entries[0]), 'porter: recalled 0.4.26 (since 2026-10-11): It could delete files it should have kept.');
  assert.equal(entryLine(two.entries[1]), 'butler: retired, cellarer instead (since 2026-10-11): The Cellarer backs up game saves now.');
  const three = changed(two, { kind: 'lift', id: 'porter' }, NOW);
  assert.deepEqual(three.entries.map((e) => e.id), ['butler']);
  assert.throws(() => changed(three, { kind: 'lift', id: 'porter' }, NOW), /isn't retired or recalled/);
  assert.throws(() => changed(null, { kind: 'retire', id: 'butler', why: '  ' }, NOW), /--why is needed/);
});

test("a list signed here reads back; one changed, or signed with another key, doesn't", () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const list = changed(null, { kind: 'retire', id: 'butler', why: 'x' }, NOW);
  const jws = signRecalls(list, privateKey);
  assert.deepEqual(readSigned(jws, privateKey), list);
  const other = generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => readSigned(jws, other), /isn't signed with this PC's recall key/);
});

/** A home with the recall key and the publisher's key, and an Exchequer whose list the test holds. */
function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'steward-recalls-'));
  mkdirSync(path.join(home, '.steward'), { recursive: true });
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(path.join(home, RECALL_KEY_FILE), privateKey.export({ format: 'pem', type: 'pkcs8' }));
  writeFileSync(path.join(home, '.steward', 'exchequer-publisher.key'), 'pk-test');
  let held: string | null = null;
  const puts: { auth: string | null; body: { recalls: string } }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { recalls: string };
      puts.push({ auth: new Headers(init.headers).get('authorization'), body });
      held = body.recalls;
      return new Response(JSON.stringify({ seq: 1 }), { status: 200 });
    }
    assert.match(url, /\/api\/v1\/recalls$/);
    return new Response(JSON.stringify({ recalls: held }), { status: 200 });
  }) as typeof fetch;
  return { home, privateKey, puts, fake, env: { EXCHEQUER_URL: 'http://localhost:3999' } };
}

test('a recall is signed here and sent with the publisher key; the next builds on the one the Exchequer holds', async () => {
  const t = setup();
  const first = await sendChange({ kind: 'recall', id: 'porter', why: 'It could delete files.', versions: { from: '0.4.26', to: '0.4.26' } }, { home: t.home, fetch: t.fake, env: t.env, now: () => NOW });
  assert.equal(first.sent, true);
  assert.equal(t.puts[0].auth, 'Bearer pk-test');
  assert.deepEqual(readSigned(t.puts[0].body.recalls, t.privateKey).entries.map((e) => e.id), ['porter']);
  const second = await sendChange({ kind: 'retire', id: 'butler', why: 'Launchers keep saves.' }, { home: t.home, fetch: t.fake, env: t.env, now: () => NOW });
  assert.equal(second.list.seq, 2);
  assert.deepEqual(second.list.entries.map((e) => e.id), ['porter', 'butler']);
});

test('--dry-run sends nothing; no recall key on this PC, nothing is signed', async () => {
  const t = setup();
  const dry = await sendChange({ kind: 'retire', id: 'butler', why: 'x' }, { home: t.home, fetch: t.fake, env: t.env, dryRun: true });
  assert.equal(dry.sent, false);
  assert.equal(t.puts.length, 0);
  const bare = mkdtempSync(path.join(os.tmpdir(), 'steward-recalls-'));
  await assert.rejects(sendChange({ kind: 'retire', id: 'butler', why: 'x' }, { home: bare, fetch: t.fake, env: t.env }), /no recall key on this PC/);
});
