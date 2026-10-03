import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { withLock } from './fixture/src/kit/lock.ts';
import {
  LockTimeout,
  queueDirFor,
  queueSnapshot,
  QueueFull,
  readLine,
  withNpuTurn,
} from './fixture/src/kit/npu-queue.ts';

// The node part's turns on a real disk. The spec's vectors run in vectors.test.ts.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scratch = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'fixture-queue-')), 'locks', 'npu');

/** Holds the lock the way any holder does (a live pid), so waiters line up behind it. */
function hold(lockDir: string): () => void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, since: Date.now() }));
  return () => rmSync(lockDir, { recursive: true, force: true });
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the test condition');
    await sleep(20);
  }
}

const tickets = (lockDir: string) => (existsSync(queueDirFor(lockDir)) ? readdirSync(queueDirFor(lockDir)).filter((n) => n.endsWith('.ticket')) : []);

test('waiters in one process are served in the order they joined', async () => {
  const lockDir = scratch();
  const free = hold(lockDir);
  const order: string[] = [];
  const turn = (label: string, lane: 'interactive' | 'background') =>
    withNpuTurn(lockDir, async () => void order.push(label), { lane, who: label });
  const a = turn('a', 'background');
  await until(() => tickets(lockDir).length === 1);
  const b = turn('b', 'background');
  await until(() => tickets(lockDir).length === 2);
  const c = turn('c', 'interactive');
  await until(() => tickets(lockDir).length === 3);
  free();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['c', 'a', 'b'], 'the interactive request goes first, then background by arrival');
  assert.deepEqual(tickets(lockDir), [], 'every ticket leaves the line');
  assert.ok(!existsSync(lockDir), 'the last holder lets go');
});

test('separate processes take their turns first come, first served', async () => {
  const lockDir = scratch();
  const out = path.join(path.dirname(path.dirname(lockDir)), 'order.txt');
  writeFileSync(out, '');
  const free = hold(lockDir);
  const moduleUrl = new URL('./fixture/src/kit/npu-queue.ts', import.meta.url).href;
  const child = (label: string, lane: string) => {
    const code =
      `import { withNpuTurn } from ${JSON.stringify(moduleUrl)}; import { appendFileSync } from 'node:fs';` +
      `await withNpuTurn(${JSON.stringify(lockDir)}, async () => { appendFileSync(${JSON.stringify(out)}, ${JSON.stringify(label)} + '\\n'); await new Promise((r) => setTimeout(r, 30)); }, { lane: ${JSON.stringify(lane)}, who: ${JSON.stringify(label)} });`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
    return new Promise<number | null>((resolve) => p.on('exit', resolve));
  };
  const done: Promise<number | null>[] = [];
  for (const [i, label] of ['first', 'second', 'third'].entries()) {
    done.push(child(label, 'background'));
    await until(() => tickets(lockDir).length === i + 1, 10_000);
  }
  const snap = queueSnapshot(lockDir);
  assert.equal(snap.holder?.pid, process.pid);
  assert.deepEqual(snap.waiting.map((w) => w.who), ['first', 'second', 'third']);
  free();
  assert.deepEqual(await Promise.all(done), [0, 0, 0]);
  assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), ['first', 'second', 'third']);
});

test('a dead waiter is cleared from the line, and the next one is served', async () => {
  const lockDir = scratch();
  const queueDir = queueDirFor(lockDir);
  mkdirSync(queueDir, { recursive: true });
  // An older ticket from a process that no longer exists, whose heartbeat stopped 6 s ago.
  const ghost = path.join(queueDir, `1-${String(Date.now() * 1000 - 60_000_000).padStart(17, '0')}-${2 ** 31 - 3}-deadbeef.ticket`);
  writeFileSync(ghost, '{}');
  const past = new Date(Date.now() - 6000);
  utimesSync(ghost, past, past);
  let ran = false;
  await withNpuTurn(lockDir, async () => void (ran = true), { waitMs: 2000 });
  assert.ok(ran);
  assert.ok(!existsSync(ghost));
});

test('a waiter whose ticket was cleared by mistake (a long pause) gets back in, in the same place', async () => {
  const lockDir = scratch();
  const free = hold(lockDir);
  const turn = withNpuTurn(lockDir, async () => 'served', { lane: 'background' });
  await until(() => tickets(lockDir).length === 1);
  const [name] = tickets(lockDir);
  unlinkSync(path.join(queueDirFor(lockDir), name));
  await until(() => tickets(lockDir).length === 1);
  assert.deepEqual(tickets(lockDir), [name]);
  free();
  assert.equal(await turn, 'served');
});

test('a waiter that gives up leaves the line', async () => {
  const lockDir = scratch();
  const free = hold(lockDir);
  await assert.rejects(withNpuTurn(lockDir, async () => {}, { waitMs: 300 }), LockTimeout);
  assert.deepEqual(tickets(lockDir), []);
  free();
});

test('maxAhead: a caller can decline to join a long line', async () => {
  const lockDir = scratch();
  const free = hold(lockDir);
  const waiting = [withNpuTurn(lockDir, async () => {}), withNpuTurn(lockDir, async () => {})];
  await until(() => readLine(queueDirFor(lockDir)).length === 2);
  await assert.rejects(withNpuTurn(lockDir, async () => {}, { maxAhead: 2 }), QueueFull);
  free();
  await Promise.all(waiting);
});

test(
  'a release goes through while another program has owner.json open without sharing delete',
  { skip: process.platform !== 'win32' && 'only Windows refuses to delete a file that is open' },
  async () => {
    const lockDir = scratch();
    let exited!: Promise<number | null>;
    await withNpuTurn(lockDir, async () => {
      // Opened the way Python's open() and .NET's File.ReadAllText do (sharing read and write, not
      // delete), as a waiter in another tool checking the holder does, and held across the release.
      const hold =
        "$f = [IO.File]::Open($env:OWNER, 'Open', 'Read', 'ReadWrite'); [Console]::Out.WriteLine('open'); [Console]::Out.Flush();" +
        ' Start-Sleep -Milliseconds 200; $f.Close()';
      const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hold], {
        env: { ...process.env, OWNER: path.join(lockDir, 'owner.json') },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      exited = new Promise((resolve) => reader.on('exit', resolve));
      await Promise.race([new Promise((r) => reader.stdout.once('data', r)), exited.then(() => assert.fail('the reader never opened owner.json'))]);
    });
    assert.ok(!existsSync(lockDir), 'the lock is free when the turn ends, not when it goes stale');
    assert.equal(await exited, 0);
  },
);

test('a waiter puts the queue folder back if it was removed', async () => {
  const lockDir = scratch();
  const free = hold(lockDir);
  const turn = withNpuTurn(lockDir, async () => 'served');
  await until(() => tickets(lockDir).length === 1);
  rmSync(queueDirFor(lockDir), { recursive: true, force: true });
  await until(() => tickets(lockDir).length === 1);
  free();
  assert.equal(await turn, 'served');
});

test('a holder never removes a lock that has passed to someone else', async () => {
  const lockDir = scratch();
  await withNpuTurn(lockDir, async () => {
    // Evicted for overstaying, and someone else took the lock meanwhile.
    writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, since: 1 }));
  });
  assert.ok(existsSync(lockDir), "the other holder's lock stays");
});

test('a program that predates the queue still never runs alongside a queued one', async () => {
  const lockDir = scratch();
  let inside = 0;
  let most = 0;
  const work = async () => {
    inside++;
    most = Math.max(most, inside);
    await sleep(40);
    inside--;
  };
  await Promise.all([withLock(lockDir, work), withNpuTurn(lockDir, work), withLock(lockDir, work), withNpuTurn(lockDir, work)]);
  assert.equal(most, 1);
});
