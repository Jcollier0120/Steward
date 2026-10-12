import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Branch heads one agent read and shares, so another needs no ls-remote of its own (kit 2.58.0).
const { FRESH_MS, freshRemoteHeads, readRemoteHeads, remoteHeadsFile, remoteKey, shareRemoteHeads } = await import('./fixture/src/kit/remote-heads.ts');

const home = mkdtempSync(path.join(os.tmpdir(), 'kit-remote-heads-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('one key for every way of writing a remote', () => {
  for (const url of ['https://github.com/Jcollier0120/Reeve.git', 'https://github.com/jcollier0120/reeve', 'https://someone@github.com/Jcollier0120/Reeve/', 'git@github.com:Jcollier0120/Reeve.git', 'ssh://git@github.com:22/Jcollier0120/Reeve', 'Jcollier0120/Reeve']) {
    assert.equal(remoteKey(url), 'github.com/jcollier0120/reeve', url);
  }
  assert.equal(remoteKey('https://gitlab.example/group/sub/project.git'), 'gitlab.example/group/sub/project');
  for (const url of ['C:\\Projects\\Reeve', 'C:/Projects/Reeve', '/c/Projects/Reeve', '../Reeve', 'file:///c/Projects/Reeve', '']) assert.equal(remoteKey(url), null, url);
});

test('shared heads are read back while fresh and whole; otherwise the agent asks the remote itself', () => {
  const file = path.join(home, 'one', 'remote-heads.json');
  const at = new Date('2026-10-12T12:00:00Z');
  shareRemoteHeads({ 'Jcollier0120/Reeve': { heads: { main: A, 'claude/x': B }, complete: true }, 'Jcollier0120/Big': { heads: { main: A }, complete: false } }, { file, now: at });
  const now = at.getTime() + 60_000;
  assert.deepEqual(freshRemoteHeads('https://github.com/Jcollier0120/Reeve.git', { file, now }), { main: A, 'claude/x': B });
  assert.equal(freshRemoteHeads('https://github.com/Jcollier0120/Big', { file, now }), null, 'not all its branches');
  assert.equal(freshRemoteHeads('https://github.com/Jcollier0120/Other', { file, now }), null, 'not shared');
  assert.equal(freshRemoteHeads('https://github.com/Jcollier0120/Reeve', { file, now: at.getTime() + FRESH_MS + 1 }), null, 'too old');
  assert.equal(freshRemoteHeads('C:\\Projects\\Reeve', { file, now }), null, 'a path');
  // A later share keeps the other remotes until they're a day old.
  shareRemoteHeads({ 'Jcollier0120/Big': { heads: { main: B }, complete: true } }, { file, now: new Date(now) });
  assert.deepEqual(Object.keys(readRemoteHeads(file)).sort(), ['github.com/jcollier0120/big', 'github.com/jcollier0120/reeve']);
  shareRemoteHeads({}, { file, now: new Date(at.getTime() + 25 * 60 * 60_000) });
  assert.deepEqual(readRemoteHeads(file), {}, 'gone after a day');
  assert.deepEqual(readdirSync(path.dirname(file)), ['remote-heads.json'], 'no temporary file left');
});

test('a missing, broken or odd file shares nothing, and nothing throws', () => {
  const file = path.join(home, 'two', 'remote-heads.json');
  assert.equal(freshRemoteHeads('Jcollier0120/Reeve', { file }), null);
  shareRemoteHeads({}, { file });
  for (const text of ['{', '[]', 'null', '{"github.com/jcollier0120/reeve": {"at": "now", "heads": {"main": "nope"}, "complete": true}}']) {
    writeFileSync(file, text);
    assert.equal(freshRemoteHeads('Jcollier0120/Reeve', { file }), null, text);
  }
  writeFileSync(file, JSON.stringify({ 'github.com/jcollier0120/reeve': { at: new Date().toISOString(), heads: { main: A, odd: 'nope' }, complete: true } }));
  assert.deepEqual(freshRemoteHeads('Jcollier0120/Reeve', { file }), { main: A }, 'an odd head is left out');
});

test("Manor's folder holds it", () => {
  assert.equal(remoteHeadsFile(path.join(home, 'manor')), path.join(home, 'manor', 'remote-heads.json'));
  assert.ok(!existsSync(path.join(home, 'manor')));
});
