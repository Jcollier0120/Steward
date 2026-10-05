import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

// Offline (spec/OFFLINE.md): a failure that is only the network's, while this PC is offline, is waited out.
// Nothing here reaches the internet: every look is a stand-in, or MANOR_OFFLINE.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-net-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
after(() => rmSync(home, { recursive: true, force: true }));

const { Offline, ONLINE_KEEP_MS, OFFLINE_KEEP_MS, forgetOnline, isNetworkError, offlineFailure, offlineSince, online, probeHosts, setOnlineProbe } = await import('./fixture/src/kit/net.ts');
const { every, roundFile, roundTimes } = await import('./fixture/src/kit/schedule.ts');
const { readJson } = await import('./fixture/src/kit/store.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');

afterEach(() => {
  delete process.env.MANOR_OFFLINE;
  setOnlineProbe(async () => true);
});

const coded = (code: string, message = 'x') => Object.assign(new Error(message), { code });

test("the network's failures are told from others, by code (the cause's too) or by words: Node's, git's, gh's", () => {
  for (const e of [
    coded('ENOTFOUND', 'getaddrinfo ENOTFOUND github.com'),
    coded('EAI_AGAIN'),
    coded('ETIMEDOUT'),
    coded('ECONNRESET'),
    coded('ENETUNREACH'),
    new TypeError('fetch failed', { cause: coded('UND_ERR_CONNECT_TIMEOUT') }),
    new Error("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"),
    new Error('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com'),
    new Error('Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host'),
    'socket hang up',
    new Offline(),
  ]) {
    assert.equal(isNetworkError(e), true, String(e instanceof Error ? e.message : e));
  }
  for (const e of [
    coded('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:18181'),
    new Error('gh: Not Found (HTTP 404)'),
    new Error('HTTP 401: Bad credentials'),
    new Error("Cannot read properties of undefined (reading 'x')"),
    new Error('no network'),
    null,
    undefined,
  ]) {
    assert.equal(isNetworkError(e), false, String(e instanceof Error ? e.message : e));
  }
});

test('online() looks once, keeps the answer a minute (20 s while offline), and one look at a time', async () => {
  let looks = 0;
  let answer = true;
  setOnlineProbe(async () => {
    looks++;
    await new Promise((r) => setTimeout(r, 10));
    return answer;
  });
  const [a, b] = await Promise.all([online(), online()]);
  assert.equal(a && b, true);
  assert.equal(looks, 1, 'two asking at once share one look');
  assert.equal(await online(), true);
  assert.equal(looks, 1, 'kept');
  assert.equal(await online(Date.now() + ONLINE_KEEP_MS + 1), true);
  assert.equal(looks, 2, 'looked again after a minute');
  assert.equal(offlineSince(), null);

  answer = false;
  forgetOnline();
  assert.equal(await online(), false);
  const since = offlineSince();
  assert.ok(since && Date.parse(since) <= Date.now());
  assert.equal(await online(Date.now() + OFFLINE_KEEP_MS - 1000), false);
  assert.equal(looks, 3, 'offline is kept too, for less');
  answer = true;
  assert.equal(await online(Date.now() + OFFLINE_KEEP_MS + 1), true, 'back online is seen after 20 s');
  assert.equal(offlineSince(), null);
});

test("a look that throws is offline; MANOR_OFFLINE says without looking", async () => {
  setOnlineProbe(async () => {
    throw new Error('boom');
  });
  assert.equal(await online(), false);
  let looked = false;
  setOnlineProbe(async () => (looked = true));
  process.env.MANOR_OFFLINE = '1';
  assert.equal(await online(), false);
  process.env.MANOR_OFFLINE = '0';
  setOnlineProbe(async () => (looked = false));
  assert.equal(await online(), true);
  assert.equal(looked, false, 'never looked');
});

test("offlineFailure: the network's failure while offline, or an Offline; never a network failure while online, nor another failure offline", async () => {
  setOnlineProbe(async () => false);
  assert.equal(await offlineFailure(coded('ENOTFOUND')), true);
  assert.equal(await offlineFailure(new Error('gh: Not Found (HTTP 404)')), false, "offline, but not the network's");
  assert.equal(await offlineFailure(new Offline('the feed waits')), true);
  setOnlineProbe(async () => true);
  assert.equal(await offlineFailure(coded('ENOTFOUND')), false, 'online: a real failure (GitHub down, a bad host)');
  assert.equal(await offlineFailure(new Offline()), true, 'an Offline thrown on purpose, whatever the look says');
});

test('the real look: any host answering is online; none answering, or none to ask, is offline', async () => {
  // Stand-ins on this PC: a server that answers, and a port nothing listens on. PROBE_HOSTS are never asked.
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    assert.equal(await probeHosts(['no-such-host.invalid', '127.0.0.1'], port, 2000), true, 'one answering is enough');
    assert.equal(await probeHosts(['no-such-host.invalid'], port, 2000), false, 'a name that resolves to nothing');
    assert.equal(await probeHosts([], port), false);
  } finally {
    server.close();
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await probeHosts(['127.0.0.1'], port, 2000), false, 'refused');
});

interface Entry {
  ok: boolean | null;
  offline?: boolean;
  error: string | null;
}
const file = () => readJson<{ rounds?: Record<string, Entry> }>(roundFile(), {});

async function oneRound(job: ReturnType<typeof every>) {
  assert.ok(job.runNow());
  while (job.running) await new Promise((r) => setTimeout(r, 5));
}

test('a round that fails because this PC is offline waited for the network: ok null, offline, never "run failed"; once online it fails as before', async () => {
  setDuty(true);
  let throwing: unknown = coded('ENOTFOUND', 'getaddrinfo ENOTFOUND api.github.com');
  const logged: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => void logged.push(`log ${a.join(' ')}`);
  console.error = (...a: unknown[]) => void logged.push(`error ${a.join(' ')}`);
  const job = every(60_000, async () => {
    if (throwing) throw throwing;
  }, { firstDelayMs: 50_000, name: 'offline-test' });
  try {
    setOnlineProbe(async () => false);
    await oneRound(job);
    let r = file().rounds!['offline-test'];
    assert.deepEqual({ ok: r.ok, offline: r.offline, error: r.error }, { ok: null, offline: true, error: 'getaddrinfo ENOTFOUND api.github.com' });
    assert.equal(job.state.lastRunOk, null);
    assert.equal(job.state.lastRunOffline, true);
    assert.equal(roundTimes().lastRunOffline, true);
    assert.equal(roundTimes().lastRunOk, null);
    assert.ok(logged.some((l) => /^log .*this PC is offline, so the round waits for the network/.test(l)));
    assert.ok(!logged.some((l) => /run failed/.test(l)), 'the Surveyor reads "run failed" as a failure');

    throwing = new Offline('the feeds wait for the network');
    setOnlineProbe(async () => true);
    await oneRound(job);
    r = file().rounds!['offline-test'];
    assert.equal(r.ok, null, 'an Offline thrown is waited out, whatever the look says');

    throwing = coded('ENOTFOUND', 'getaddrinfo ENOTFOUND feeds.example');
    await oneRound(job);
    r = file().rounds!['offline-test'];
    assert.deepEqual({ ok: r.ok, offline: r.offline }, { ok: false, offline: undefined }, 'online, the same error is a failure');
    assert.equal(job.state.lastRunOffline, false);
    assert.ok(logged.some((l) => /^error .*run failed/.test(l)));

    throwing = null;
    await oneRound(job);
    assert.equal(file().rounds!['offline-test'].ok, true);
  } finally {
    console.log = log;
    console.error = err;
    job.stop();
  }
});
