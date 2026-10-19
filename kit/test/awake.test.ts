import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { stillFor, until } from './until.ts';

// Keeping the PC awake while an agent's work runs (node/awake.ts): with the Windows call stood in for, and on Windows the
// helper itself, compiled and run.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-awake-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
after(() => rmSync(home, { recursive: true, force: true }));

const { awakeCompileScript, awakeFor, setAwakeDeps, stayAwake, whileAwake } = await import('./fixture/src/kit/awake.ts');
const { every } = await import('./fixture/src/kit/schedule.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');
const { powershell } = await import('./fixture/src/kit/ps.ts');
after(() => setAwakeDeps(null));

/** Windows stood in for: each hold had and ended, in order. */
function fakeWindows(platform: NodeJS.Platform = 'win32') {
  const calls: string[] = [];
  let n = 0;
  setAwakeDeps({
    platform,
    hold: async () => {
      const id = ++n;
      calls.push(`hold ${id}`);
      return { end: () => void calls.push(`end ${id}`) };
    },
  });
  return calls;
}

test('holds from anywhere in the process share one hold of Windows, ended once the last is let go', async () => {
  const calls = fakeWindows();
  const checks = stayAwake('checks');
  const release = stayAwake('a release');
  assert.deepEqual(awakeFor(), ['checks', 'a release']);
  checks();
  checks();
  await until(() => calls.length === 1, 10_000, 'the hold had');
  assert.deepEqual(calls, ['hold 1'], 'the release still holds it');
  release();
  await until(() => calls.length === 2, 10_000, 'the hold ended');
  assert.deepEqual(calls, ['hold 1', 'end 1']);
  assert.deepEqual(awakeFor(), []);

  // Work again later is held again, and a failure lets go as well.
  await assert.rejects(
    whileAwake('a merge', async () => {
      assert.deepEqual(awakeFor(), ['a merge']);
      throw new Error('it failed');
    }),
    /it failed/,
  );
  await until(() => calls.length === 4, 10_000, 'held and let go again');
  assert.deepEqual(calls.slice(2), ['hold 2', 'end 2']);
});

test('elsewhere than Windows nothing is held, and a hold Windows refused changes nothing', async () => {
  const calls = fakeWindows('linux');
  stayAwake('checks')();
  assert.equal(await whileAwake('a release', async () => 'done'), 'done');
  assert.deepEqual(calls, []);

  setAwakeDeps({ platform: 'win32', hold: async () => null });
  assert.equal(await whileAwake('checks', async () => 'done'), 'done', 'no helper: the work runs as it is');
  setAwakeDeps({ platform: 'win32', hold: async () => Promise.reject(new Error('no')) });
  assert.equal(await whileAwake('checks', async () => 'done'), 'done', 'a hold that fails never fails the work');
});

test("a round's work holds the PC awake, and every hold it took is let go when the round ends", async () => {
  const calls = fakeWindows();
  setDuty(true);
  let held: string[] = [];
  const job = every(
    3_600_000,
    async ({ awake }) => {
      awake('checks');
      awake('a release')();
      held = awakeFor();
    },
    { firstDelayMs: 3_600_000, name: 'awake-test' },
  );
  try {
    assert.ok(job.runNow());
    await until(() => !job.running, 10_000, 'the round to end');
    assert.deepEqual(held, ['awake-test: checks']);
    await until(() => calls.length === 2, 10_000, 'the hold ended with the round');
    assert.deepEqual(calls, ['hold 1', 'end 1']);
    assert.deepEqual(awakeFor(), []);
  } finally {
    job.stop();
  }
});

test('on Windows the helper compiles, holds Windows awake while its input is open, and ends once it closes', { skip: process.platform !== 'win32' }, async () => {
  const exe = path.join(home, 'awake-test.exe');
  const source = readFileSync(new URL('./fixture/src/kit/awake.cs', import.meta.url), 'utf8');
  assert.equal((await powershell(awakeCompileScript(exe, source), { timeoutMs: 120_000 })).trim(), 'ready');
  assert.ok(existsSync(exe));
  // A Windows application, not a console one, so nothing that starts it opens a terminal (kit 2.88.2): the PE
  // optional header's Subsystem is 2 (Windows GUI), not 3 (console).
  const pe = readFileSync(exe);
  assert.equal(pe.readUInt16LE(pe.readUInt32LE(0x3c) + 24 + 68), 2, 'built for the Windows subsystem, not the console');
  const child = spawn(exe, [String(process.pid)], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  let code: number | null | undefined;
  void exited.then((c) => (code = c));
  // Still holding after a while: it waits for its input to close (exit code 2: Windows refused the request).
  await stillFor(1500);
  assert.equal(code, undefined, 'still running while its input is open');
  child.stdin.end();
  assert.equal(await exited, 0, 'let go, and ended');
});
