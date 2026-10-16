import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Waking the PC for work due at set times (node/wake.ts): the task's times and definition, kept in step with Task Scheduler
// stood in for; and on Windows, the awake helper's timed hold that the task runs.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-wake-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
after(() => rmSync(home, { recursive: true, force: true }));

const { WAKE_RETRY_MS, keepWakeTask, setWakeDeps, wakesPc, wakeTaskXml, wakeTimes } = await import('./fixture/src/kit/wake.ts');
const { WAKE_TASK_NAME } = await import('./fixture/src/kit/install.ts');
const { awakeCompileScript } = await import('./fixture/src/kit/awake.ts');
const { powershell } = await import('./fixture/src/kit/ps.ts');
after(() => setWakeDeps(null));
type WakePlan = import('./fixture/src/kit/wake.ts').WakePlan;

const PLAN: WakePlan = { times: ['00:00', '08:00'], days: ['mon', 'tue', 'wed', 'thu', 'fri'], beforeMinutes: 5, holdMinutes: 15, why: 'the 00:00 and 08:00 builds' };

test('the wake times: each time a few minutes early, on the day that makes, grouped by time', () => {
  assert.deepEqual(wakeTimes(PLAN), [
    { time: '07:55', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
    { time: '23:55', days: ['sun', 'mon', 'tue', 'wed', 'thu'] },
  ]);
  assert.deepEqual(wakeTimes({ times: ['12:03', 'noon'], days: ['sat', 'nope' as 'sat'], beforeMinutes: 5 }), [{ time: '11:58', days: ['sat'] }]);
});

test('the task wakes the PC on AC only, runs the helper for its hold, and never outlives it by much', () => {
  const xml = wakeTaskXml(PLAN, { exe: 'C:\\Users\\pat\\.fixture\\kit\\awake-0123.exe', user: 'PC\\pat' });
  for (const part of [
    '<WakeToRun>true</WakeToRun>',
    '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>',
    '<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>',
    '<StartWhenAvailable>false</StartWhenAvailable>',
    '<ExecutionTimeLimit>PT20M</ExecutionTimeLimit>',
    '<LogonType>InteractiveToken</LogonType>',
    '<Command>C:\\Users\\pat\\.fixture\\kit\\awake-0123.exe</Command>',
    '<Arguments>--for 900</Arguments>',
    `<URI>${WAKE_TASK_NAME}</URI>`,
    '<StartBoundary>2020-01-01T07:55:00</StartBoundary>',
    '<StartBoundary>2020-01-01T23:55:00</StartBoundary>',
    '<DaysOfWeek><Monday /><Tuesday /><Wednesday /><Thursday /><Friday /></DaysOfWeek>',
    '<DaysOfWeek><Sunday /><Monday /><Tuesday /><Wednesday /><Thursday /></DaysOfWeek>',
  ])
    assert.ok(xml.includes(part), part);
  assert.equal((xml.match(/<CalendarTrigger>/g) ?? []).length, 2);
  assert.ok(wakeTaskXml({ ...PLAN, days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }, { exe: 'x.exe', user: 'u' }).includes('<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>'), 'every day: daily');
  assert.ok(!xml.includes('DisplayRequired'));
});

/** Task Scheduler stood in for: the tasks registered, and every call made. */
function fakeScheduler(o: { failCreate?: boolean } = {}) {
  const calls: string[][] = [];
  const tasks = new Set<string>();
  let now = Date.parse('2026-10-16T12:00:00Z');
  const deps = {
    registers: true,
    user: 'PC\\pat',
    exe: async () => 'C:\\kit\\awake-0123.exe',
    xmlFile: path.join(home, 'wake.task.xml'),
    now: () => now,
    schtasks: async (args: string[]) => {
      calls.push(args);
      const [verb, , name] = args;
      if (verb === '/Query') return tasks.has(name) ? { code: 0, out: name } : { code: 1, out: 'ERROR: The system cannot find the file specified.' };
      if (verb === '/Create') {
        if (o.failCreate) return { code: 1, out: 'ERROR: Access is denied.' };
        tasks.add(name);
      }
      if (verb === '/Delete') tasks.delete(name);
      return { code: 0, out: 'SUCCESS' };
    },
  };
  setWakeDeps(deps);
  return { calls, tasks, deps, later: (ms: number) => (now += ms) };
}
const verbs = (calls: string[][]) => calls.map((c) => c[0]);

test('kept in step: registered once, asked again only when the plan changes, and removed when there is nothing to wake for', async () => {
  const f = fakeScheduler();
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  assert.equal(await keepWakeTask(PLAN, log), 'set');
  assert.deepEqual(verbs(f.calls), ['/Create']);
  assert.deepEqual(f.calls[0], ['/Create', '/TN', WAKE_TASK_NAME, '/XML', path.join(home, 'wake.task.xml'), '/F']);
  assert.ok(readFileSync(path.join(home, 'wake.task.xml')).subarray(0, 2).equals(Buffer.from([0xff, 0xfe])), 'UTF-16, as schtasks reads it');
  assert.match(lines.join('\n'), /the PC, plugged in, wakes at 07:55, 23:55 for the 00:00 and 08:00 builds/);
  assert.equal(wakesPc(), true);
  assert.equal(await keepWakeTask(PLAN, log), 'same');
  assert.equal(f.calls.length, 1, 'the same plan asks Task Scheduler nothing');

  // A new process with the same plan: it looks once that the task is still there.
  setWakeDeps(f.deps);
  assert.equal(await keepWakeTask(PLAN, log), 'same');
  assert.deepEqual(verbs(f.calls), ['/Create', '/Query']);

  // Settings' build times changed: replaced.
  assert.equal(await keepWakeTask({ ...PLAN, times: ['06:00'] }, log), 'set');
  assert.deepEqual(verbs(f.calls), ['/Create', '/Query', '/Create']);

  // Nothing to wake for (off duty, say): removed, once.
  assert.equal(await keepWakeTask(null, log), 'removed');
  assert.equal(await keepWakeTask(null, log), 'same');
  assert.deepEqual(verbs(f.calls), ['/Create', '/Query', '/Create', '/Delete']);
  assert.deepEqual([...f.tasks], []);
  assert.equal(wakesPc(), false);
  assert.match(lines.join('\n'), /removed the task that woke the PC/);
});

test("a task Task Scheduler refuses is said once, and tried again an hour later; where nothing registers, nothing is asked", async () => {
  const f = fakeScheduler({ failCreate: true });
  const lines: string[] = [];
  assert.equal(await keepWakeTask(PLAN, (l) => lines.push(l)), 'failed');
  assert.equal(await keepWakeTask(PLAN, (l) => lines.push(l)), 'failed');
  assert.equal(f.calls.length, 1, 'not asked again at once');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /couldn't register the task that wakes the PC for the 00:00 and 08:00 builds .*Access is denied/);
  f.later(WAKE_RETRY_MS);
  assert.equal(await keepWakeTask(PLAN, () => {}), 'failed');
  assert.equal(f.calls.length, 2, 'an hour later, asked again');

  setWakeDeps({ registers: false, schtasks: async () => assert.fail('nothing asked') });
  assert.equal(await keepWakeTask(PLAN), 'none');
  assert.equal(await keepWakeTask(null), 'none');
});

test("on Windows the helper's timed hold, as the wake task runs it, holds and ends by itself", { skip: process.platform !== 'win32' }, async () => {
  const exe = path.join(home, 'awake-wake-test.exe');
  const source = readFileSync(new URL('./fixture/src/kit/awake.cs', import.meta.url), 'utf8');
  assert.equal((await powershell(awakeCompileScript(exe, source), { timeoutMs: 120_000 })).trim(), 'ready');
  assert.ok(existsSync(exe));
  const started = Date.now();
  const child = spawn(exe, ['--for', '1'], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  assert.equal(code, 0, 'held (exit 2: Windows refused), then let go');
  assert.ok(Date.now() - started >= 900, 'it held for its time, with no input to wait on');
});
