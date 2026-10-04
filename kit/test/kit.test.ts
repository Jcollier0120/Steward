import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The house kit: the parts every agent shares. A copy runs on its own port and data folder.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-test-'));
process.env.FIXTURE_HOME = home;
process.env.FIXTURE_PORT = String(40000 + Math.floor(Math.random() * 9000));
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
after(() => rmSync(home, { recursive: true, force: true }));

const { APP, port } = await import('./fixture/src/app.ts');
const { allowedHosts, hostAllowed, postAllowed, serve } = await import('./fixture/src/kit/server.ts');
const { withLock } = await import('./fixture/src/kit/lock.ts');
const { queueDirFor } = await import('./fixture/src/kit/npu-queue.ts');
const { Npu, NpuBusy, NpuError, loadNpuConfig, npuDeferredFor, npuLine, npuLockDir, npuTurn, pieces, resetNpuManners } = await import('./fixture/src/kit/npu.ts');
const { esc, ago } = await import('./fixture/src/kit/page.ts');
const { readJson } = await import('./fixture/src/kit/store.ts');
const { powershell } = await import('./fixture/src/kit/ps.ts');
const { duty, setDuty } = await import('./fixture/src/kit/duty.ts');
const { every, rounds } = await import('./fixture/src/kit/schedule.ts');
const { statusJson } = await import('./fixture/src/kit/service.ts');

/** Waits until `check` holds, a little at a time: never a fixed sleep. */
async function until(check: () => unknown, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the test condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('only its own host names are answered', () => {
  const hosts = allowedHosts(18000);
  assert.ok(hostAllowed(hosts, `${APP.id}.localhost:18000`));
  assert.ok(hostAllowed(hosts, '127.0.0.1:18000'));
  assert.ok(!hostAllowed(hosts, 'evil.example:18000'));
  assert.ok(!hostAllowed(hosts, undefined));
});

test('a POST needs the token, from its own origin or none', () => {
  const hosts = allowedHosts(18000);
  assert.ok(postAllowed(hosts, undefined, 'abc', 'abc'));
  assert.ok(postAllowed(hosts, 'http://127.0.0.1:18000', 'abc', 'abc'));
  assert.ok(!postAllowed(hosts, 'http://evil.example', 'abc', 'abc'));
  assert.ok(!postAllowed(hosts, undefined, 'abd', 'abc'));
  assert.ok(!postAllowed(hosts, undefined, undefined, 'abc'));
});

test('the server pings as this app, guards hosts and actions, and records its token', async () => {
  const { token, close } = await serve({ port, icon: '<svg/>', post: { '/api/echo': ({ body }) => ({ json: body }) } });
  try {
    const base = `http://127.0.0.1:${port}`;
    const ping = await (await fetch(`${base}/api/ping`)).json();
    assert.equal(ping.app, APP.id);
    assert.equal(ping.running, true, 'a new agent is on duty, and its ping says so for Manor');
    assert.deepEqual([ping.stoppedSince, ping.summary], [null, 'On duty.']);
    // Off duty, the ping says since when, and in a line, as the status command does: Manor needn't run that.
    const off = setDuty(false);
    try {
      const stopped = await (await fetch(`${base}/api/ping`)).json();
      assert.equal(stopped.running, false);
      assert.equal(stopped.stoppedSince, off.since);
      assert.match(stopped.summary, /^Off duty since .*: its scheduled rounds are paused.$/);
      const status = await statusJson();
      assert.deepEqual([status.stoppedSince, status.summary], [stopped.stoppedSince, stopped.summary], 'the same words as status --json');
    } finally {
      setDuty(true);
    }
    assert.equal((await fetch(`${base}/favicon.svg`)).headers.get('content-type'), 'image/svg+xml');
    assert.equal((await fetch(`${base}/api/echo`, { method: 'POST', body: '{}' })).status, 403);
    const ok = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'x-token': token }, body: '{"a":1}' });
    assert.deepEqual(await ok.json(), { a: 1 });
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal(readJson<{ token: string }>(path.join(home, 'server.json'), { token: '' }).token, token);
  } finally {
    await close();
  }
});

test("rounds are recorded: the last to end and whether it went through, the next due, one under way; ping gives them", async () => {
  setDuty(true);
  let fail = false;
  let release: () => void = () => {};
  const job = every(60_000, async () => {
    await new Promise<void>((r) => (release = r));
    if (fail) throw new Error('no network');
  }, { firstDelayMs: 50_000, name: 'mill' });
  try {
    let s = job.state;
    assert.equal(s.name, 'mill');
    assert.equal(s.lastRunAt, null);
    assert.equal(s.lastRunOk, null);
    assert.ok(s.nextRunAt && Date.parse(s.nextRunAt) > Date.now() + 40_000, 'the first round is due in its first delay');
    assert.equal(s.runningSince, null);

    assert.ok(job.runNow());
    await until(() => job.state.runningSince);
    s = job.state;
    assert.ok(s.runningSince, 'a round under way says since when');
    assert.equal(s.nextRunAt, null, 'no next while one runs');
    release();
    await until(() => job.state.lastRunAt);
    s = job.state;
    assert.ok(s.lastRunAt && Date.now() - Date.parse(s.lastRunAt) < 5_000);
    assert.equal(s.lastRunOk, true);
    assert.ok(s.nextRunAt && Date.parse(s.nextRunAt) > Date.now() + 50_000, 'the next is about an interval on');

    fail = true;
    job.runNow();
    await until(() => job.state.runningSince);
    release();
    await until(() => job.state.lastRunOk === false);
    assert.equal(job.state.lastRunOk, false);
    assert.equal(job.state.lastError, 'no network');

    setDuty(false);
    assert.equal(job.state.nextRunAt, null, 'off duty, no round is coming');
    setDuty(true);

    const { close } = await serve({ port, icon: '<svg/>' });
    try {
      const ping = await (await fetch(`http://127.0.0.1:${port}/api/ping`)).json();
      assert.equal(ping.lastRunAt, job.state.lastRunAt);
      assert.equal(ping.lastRunOk, false);
      assert.equal(ping.nextRunAt, job.state.nextRunAt);
      assert.equal(ping.runningSince, null);
      assert.deepEqual(ping.rounds.map((r: { name: string }) => r.name), ['mill']);
    } finally {
      await close();
    }
  } finally {
    job.stop();
    setDuty(true);
  }
  assert.ok(!rounds().some((r) => r.name === 'mill'), 'a stopped schedule leaves the record');
});

test('the NPU lock lets one holder in at a time', async () => {
  const dir = path.join(home, 'locks', 'test');
  let inside = 0;
  let most = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      withLock(dir, async () => {
        inside++;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 30));
        inside--;
      }),
    ),
  );
  assert.equal(most, 1);
  assert.ok(!existsSync(dir));
});

test('an oversized NPU request is refused before anything is sent', async () => {
  const npu = new Npu({ baseUrl: 'http://127.0.0.1:9', model: 'm', device: 'Npu', maxContextTokens: 2400, requestTimeoutMs: 1000 });
  await assert.rejects(npu.chat([{ role: 'user', content: 'x'.repeat(9000) }], { maxTokens: 100 }), NpuError);
});

test('without Reeve set up, the NPU says why instead of failing later', () => {
  const missing = loadNpuConfig(path.join(home, 'nope.json'));
  assert.ok('error' in missing);
  const npu = new Npu(missing);
  assert.match(npu.problem ?? '', /isn't set up/);
  const cfgDir = path.join(home, 'npu');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path.join(cfgDir, 'config.json'), '﻿{"chatEndpoint":{"baseUrl":"http://127.0.0.1:18181/v1","model":"q"}}');
  const cfg = loadNpuConfig(path.join(cfgDir, 'config.json'));
  assert.ok(!('error' in cfg) && cfg.accelerators[0].id === 'npu' && cfg.accelerators[0].chat?.baseUrl === 'http://127.0.0.1:18181' && cfg.accelerators[0].maxContextTokens === 2400);
});

test('long text is split into pieces that each fit the budget', () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} `.repeat(8)).join('\n');
  const parts = pieces(text, 500);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 1500));
  assert.equal(parts.join('\n'), text);
});

test('page text is escaped', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(ago(null), 'never');
  assert.equal(ago(new Date(Date.now() - 3 * 3600_000).toISOString()), '3 hours ago');
});

// ---------------------------------------------------------------- manners on a shared NPU

const offline = { baseUrl: 'http://127.0.0.1:9', model: 'm', device: 'Npu', maxContextTokens: 2400, requestTimeoutMs: 1000 };

test('an agent that gets no turn in time leaves the line and defers its NPU work', async () => {
  resetNpuManners();
  mkdirSync(npuLockDir, { recursive: true });
  writeFileSync(path.join(npuLockDir, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  try {
    const npu = new Npu(offline);
    await assert.rejects(npu.chat([{ role: 'user', content: 'hi' }], { maxWaitMs: 400 }), NpuBusy);
    assert.ok(npuDeferredFor() > 4 * 60_000);
    assert.equal(npuLine().waiting.length, 0, 'it left the line');
    const t0 = Date.now();
    await assert.rejects(npu.chat([{ role: 'user', content: 'hi' }]), NpuBusy);
    assert.ok(Date.now() - t0 < 100, 'a deferred call fails at once instead of queueing');
  } finally {
    rmSync(npuLockDir, { recursive: true, force: true });
    resetNpuManners();
  }
});

test('a request over the cap is refused at once, even while the NPU is busy', async () => {
  mkdirSync(npuLockDir, { recursive: true });
  writeFileSync(path.join(npuLockDir, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  try {
    const t0 = Date.now();
    await assert.rejects(new Npu(offline).chat([{ role: 'user', content: 'x'.repeat(9000) }]), (e: Error) => e instanceof NpuError && !(e instanceof NpuBusy));
    assert.ok(Date.now() - t0 < 100);
  } finally {
    rmSync(npuLockDir, { recursive: true, force: true });
  }
});

test("an agent keeps one ticket in line at a time, and queues as background under its own name", async () => {
  resetNpuManners();
  mkdirSync(npuLockDir, { recursive: true });
  writeFileSync(path.join(npuLockDir, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  const ran: number[] = [];
  const turns = [1, 2, 3].map((n) => npuTurn(async () => void ran.push(n)));
  // The second and third wait in this process behind the first from the moment they're asked, so once the first's
  // ticket is in the line, the line is as it will be.
  await until(() => npuLine().waiting.length > 0);
  const line = npuLine();
  assert.equal(line.waiting.length, 1, 'three requests, one ticket');
  assert.equal(line.waiting[0].who, APP.id);
  assert.equal(line.waiting[0].lane, 'background');
  rmSync(npuLockDir, { recursive: true, force: true });
  await Promise.all(turns);
  assert.deepEqual(ran, [1, 2, 3]);
  assert.ok(!existsSync(npuLockDir));
});

test('an agent declines to join a long line, and its NPU work waits for a quieter round', async () => {
  resetNpuManners();
  mkdirSync(npuLockDir, { recursive: true });
  writeFileSync(path.join(npuLockDir, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  const queueDir = queueDirFor(npuLockDir);
  mkdirSync(queueDir, { recursive: true });
  const others = [1, 2, 3, 4].map((i) => path.join(queueDir, `0-${String(Date.now() * 1000 + i).padStart(17, '0')}-${process.pid}-0000000${i}.ticket`));
  for (const t of others) writeFileSync(t, '{}');
  try {
    const t0 = Date.now();
    await assert.rejects(npuTurn(async () => {}), NpuBusy);
    assert.ok(Date.now() - t0 < 200, "it doesn't wait");
    assert.ok(npuDeferredFor() > 0);
  } finally {
    rmSync(npuLockDir, { recursive: true, force: true });
    rmSync(queueDir, { recursive: true, force: true });
    resetNpuManners();
  }
});

test('a PowerShell script too long for a command line runs from a file, and the file is removed', async () => {
  const script = '# ' + 'x'.repeat(15_000) + '\nWrite-Output "ok: $([char]0x00e9)"';
  assert.equal((await powershell(script)).trim(), 'ok: é');
  assert.equal((await powershell('Write-Output short')).trim(), 'short');
  assert.ok(!readdirSync(os.tmpdir()).some((f) => f.startsWith(`ps-${process.pid}-`)), 'the script file is removed');
});

test('off duty, scheduled rounds pause but Run now still runs one; back on duty, they resume', async () => {
  let rounds = 0;
  // Each wait the schedule sets reads the interval: counting those counts its ticks, the skipped ones too.
  let waits = 0;
  setDuty(false);
  const job = every(() => (waits++, 20), async () => void rounds++, { firstDelayMs: 5 });
  try {
    await until(() => waits >= 3);
    assert.equal(rounds, 0, 'two scheduled ticks came and went off duty, and ran nothing');
    assert.ok(job.runNow());
    await until(() => rounds === 1);
    setDuty(true);
    await until(() => rounds > 1);
  } finally {
    job.stop();
    setDuty(true);
  }
});

test("status answers in Manor's format: running means on duty with its page up", async () => {
  setDuty(true);
  let s = await statusJson();
  assert.equal(s.app, APP.id);
  assert.equal(s.running, false, 'on duty, but no page is running in this test');
  assert.equal(s.stoppedSince, null);
  assert.match(s.summary, /isn't running/);
  const off = setDuty(false);
  s = await statusJson();
  assert.equal(s.running, false);
  assert.equal(s.stoppedSince, off.since);
  assert.equal(duty().onDuty, false);
  setDuty(true);
});
