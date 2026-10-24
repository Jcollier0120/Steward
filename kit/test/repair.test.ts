import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from './until.ts';

// Repairs another agent asks for (repair.ts): the kit's `round`, an agent's own, and the asker's side.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'repair-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
const ENV = String(pkg.name).toUpperCase().replace(/-/g, '_');
process.env[`${ENV}_HOME`] = tmp;
process.env.KIT_GENTLE = '0';
after(() => rmSync(tmp, { recursive: true, force: true }));

const { askRepair, onRepair, repair, repairKinds } = await import('./fixture/src/kit/repair.ts');
const { every } = await import('./fixture/src/kit/schedule.ts');

test('the round repair starts a scheduled round now, and says when none could start', async () => {
  let ran = 0;
  let release!: () => void;
  const s = every(3_600_000, () => {
    ran++;
    return new Promise<void>((r) => (release = r));
  }, { firstDelayMs: 3_600_000, name: 'tidy' });
  try {
    const first = await repair({ kind: 'round', finding: 'agent.x.stale' });
    assert.equal(first.ok, true, first.did);
    assert.match(first.did, /started a round \(tidy\)/);
    await until(() => ran === 1, 10_000, 'the round it started');
    assert.equal(ran, 1);
    // One under way: nothing more starts.
    const again = await repair({ kind: 'round' });
    assert.equal(again.ok, false);
    release();
  } finally {
    s.stop();
  }
  assert.deepEqual((await repair({ kind: 'round' })).ok, false, 'a stopped schedule is no longer started');
});

test("an agent's own repairs: listed in its ping, answered, and an unknown or failing one is no repair", async () => {
  onRepair('npu', ({ detail }) => ({ ok: true, did: `restarted its model server (${detail})` }));
  onRepair('boom', () => {
    throw new Error('no');
  });
  assert.deepEqual(repairKinds(), ['boom', 'npu', 'round']);
  assert.deepEqual(await repair({ kind: 'npu', detail: 'hung' }), { ok: true, did: 'restarted its model server (hung)' });
  assert.deepEqual(await repair({ kind: 'boom' }), { ok: false, did: 'the repair failed: no' });
  assert.equal((await repair({ kind: 'paint' })).ok, false);
  assert.equal((await repair(null)).ok, false);
});

test("the asker takes the token from the server.json of the page its address names (kit 2.118.0), never reading its page", async () => {
  const smith = path.join(tmp, 'smith-home');
  mkdirSync(smith, { recursive: true });
  writeFileSync(path.join(smith, 'server.json'), JSON.stringify({ pid: 1, port: 19100, token: 'smith_token_0123456789' }));
  process.env.SMITH_HOME = smith;
  try {
    const seen: { url: string; token?: string }[] = [];
    const fake = (async (url: URL | string, init?: RequestInit) => {
      seen.push({ url: String(url), token: (init?.headers as Record<string, string> | undefined)?.['x-token'] });
      return Response.json({ ok: true, did: 'started a round (round)' });
    }) as typeof fetch;
    assert.deepEqual(await askRepair('http://smith.localhost:19100', { kind: 'round' }, { fetch: fake }), { ok: true, did: 'started a round (round)' });
    assert.deepEqual(seen, [{ url: 'http://smith.localhost:19100/api/repair', token: 'smith_token_0123456789' }], 'no GET /: a strict page gives its token to no one');
  } finally {
    delete process.env.SMITH_HOME;
  }
});

test("the asker reads the page's token from its page, then posts with it; older kits and far pages are no answer", async (t) => {
  process.env.SMITH_HOME = path.join(tmp, 'no-smith');
  t.after(() => delete process.env.SMITH_HOME);
  const seen: { url: string; token?: string; body?: string }[] = [];
  const fake = (async (url: URL | string, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, token: (init?.headers as Record<string, string> | undefined)?.['x-token'], body: init?.body as string | undefined });
    if (u.endsWith('/')) return new Response('<meta name="page-token" content="abcdefabcdefabcdef12">', { status: 200 });
    return Response.json({ ok: true, did: 'started a round (round)' });
  }) as typeof fetch;
  const a = await askRepair('http://smith.localhost:19100', { kind: 'round', finding: 'agent.smith.stale' }, { fetch: fake });
  assert.deepEqual(a, { ok: true, did: 'started a round (round)' });
  assert.equal(seen[1].url, 'http://smith.localhost:19100/api/repair');
  assert.equal(seen[1].token, 'abcdefabcdefabcdef12');
  assert.deepEqual(JSON.parse(seen[1].body!), { kind: 'round', finding: 'agent.smith.stale' });

  const old = (async (url: URL | string) => (String(url).endsWith('/') ? new Response('<meta name="page-token" content="abcdefabcdefabcdef12">') : new Response('{}', { status: 404 }))) as typeof fetch;
  assert.match(String((await askRepair('http://127.0.0.1:19100', { kind: 'round' }, { fetch: old }) as { error: string }).error), /before 2\.51\.0/);
  assert.deepEqual(await askRepair('https://example.com', { kind: 'round' }, { fetch: fake }), { error: 'not a local page' });
});
