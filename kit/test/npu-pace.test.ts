import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The NPU at full speed (npu-pace.ts, kit 2.85.0): the rule, the shared look at the PC's room, and an agent's backlog
// worked through back to back. Everything in a scratch folder, with the look and the requests given: no PowerShell, no NPU.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-pace-'));
process.env.REEVE_HOME = home;
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
after(() => rmSync(home, { recursive: true, force: true }));

const P = await import('./fixture/src/kit/npu-pace.ts');
const { NpuBusy } = await import('./fixture/src/kit/npu.ts');
const { resetWorkTasks, workTasks } = await import('./fixture/src/kit/work-tasks.ts');

const ROOM = { at: 1_000_000, plugged: true, saver: false, batteryPercent: 80, passiveLimit: 100, npuUsers: [] as { pid: number; name: string; percent: number }[] };
const why = (o: Partial<Parameters<typeof P.whyGentle>[0]> = {}) => P.whyGentle({ setting: 'full', room: ROOM, memory: 0.5, busy: 0.2, now: ROOM.at, ...o });

test('full speed needs Manor to allow it, an NPU first, mains power, no saver, no heat, the NPU to itself, memory and a quiet processor', () => {
  assert.equal(why(), null, 'all of it: full');
  assert.match(why({ setting: 'gentle' })!, /Manor's Settings/);
  assert.match(why({ npuFirst: false })!, /no NPU here takes this work first/);
  assert.match(why({ room: { ...ROOM, plugged: false } })!, /on its battery/);
  assert.match(why({ room: { ...ROOM, plugged: null } })!, /isn't known whether the PC is plugged in/);
  assert.match(why({ room: { ...ROOM, saver: true } })!, /energy saver/);
  assert.match(why({ room: { ...ROOM, passiveLimit: 70 } })!, /holding its processor back to cool down \(to 70%\)/);
  assert.equal(why({ room: { ...ROOM, passiveLimit: null } }), null, 'a PC with no thermal zones to say is not held back');
  assert.match(why({ room: { ...ROOM, npuUsers: [{ pid: 9, name: 'svchost', percent: 12 }] } })!, /another program is using the NPU \(svchost\)/);
  assert.equal(why({ room: { ...ROOM, npuUsers: [{ pid: 7, name: 'geniex', percent: 90 }, { pid: 8, name: 'llama-server', percent: 40 }] } }), null, "the manor's own servers on it are its own work");
  assert.equal(why({ room: { ...ROOM, npuUsers: [{ pid: 9, name: 'svchost', percent: 0 }] } }), null, 'a program that used none of it is no one');
  assert.match(why({ memory: 0.9 })!, /more than 85% of the memory/);
  assert.match(why({ busy: 0.6 })!, /the processor is busy \(60%\)/);
  assert.equal(why({ busy: null }), null, "a processor that couldn't be measured holds nothing back");
  assert.match(why({ room: null })!, /haven't been looked at yet/);
  assert.match(why({ room: { ...ROOM, problem: 'PowerShell: no' } })!, /couldn't be looked at \(PowerShell: no\)/);
  assert.match(why({ now: ROOM.at + 6 * P.NPU_ROOM_FRESH_MS })!, /too old/);
});

test("the look's answer is read: mains or battery, a PC with no battery, the saver, the coolest zone's limit, the NPU's users", () => {
  const room = P.roomOf('noise\n{"power":{"supply":"Adequate","battery":"Idle","percent":100,"saver":"Disabled"},"passive":100,"users":[{"pid":5,"name":"geniex","percent":89}]}', 42);
  assert.deepEqual(room, { at: 42, plugged: true, saver: false, batteryPercent: 100, passiveLimit: 100, npuUsers: [{ pid: 5, name: 'geniex', percent: 89 }] });
  assert.equal(P.roomOf('{"power":{"supply":"NotPresent","battery":"Discharging","percent":40,"saver":"On"},"passive":null,"users":null}', 1).plugged, false);
  assert.equal(P.roomOf('{"power":{"supply":"NotPresent","battery":"Discharging","percent":40,"saver":"On"}}', 1).saver, true);
  const desktop = P.roomOf('{"power":{"supply":"NotPresent","battery":"NotPresent","percent":-1,"saver":"Disabled"},"passive":null,"users":{"pid":3,"name":"x","percent":2}}', 1);
  assert.equal(desktop.plugged, true, 'no battery: plugged in');
  assert.equal(desktop.batteryPercent, null);
  assert.deepEqual(desktop.npuUsers, [{ pid: 3, name: 'x', percent: 2 }], 'one user, as ConvertTo-Json gives it, is a list of one');
  assert.equal(P.roomOf('{"power":{"supply":"","battery":"","percent":-1,"saver":""}}', 1).plugged, null, 'Windows saying nothing is unknown');
  const broken = P.roomOf('problem: timed out', 7);
  assert.equal(broken.problem, 'problem: timed out');
  assert.equal(broken.plugged, null);
});

test('one look stands for every agent for a minute; a stale one is looked at again; a look under way is waited on with the last', async () => {
  const dir = path.join(home, 'room');
  let looks = 0;
  let t = 5_000_000;
  const look = async () => {
    looks++;
    return '{"power":{"supply":"Adequate","battery":"Charging","percent":60,"saver":"Disabled"},"passive":100,"users":[]}';
  };
  const first = await P.npuRoom({ dir, now: () => t, look });
  assert.equal(looks, 1);
  assert.equal(first!.at, t);
  assert.deepEqual(JSON.parse(readFileSync(P.npuRoomFile(dir), 'utf8')), first, 'written for the others');
  t += P.NPU_ROOM_FRESH_MS - 1;
  assert.deepEqual(await P.npuRoom({ dir, now: () => t, look }), first, 'still fresh: no look');
  assert.equal(looks, 1);
  t += 2;
  assert.equal((await P.npuRoom({ dir, now: () => t, look }))!.at, t, 'a minute on: looked at again');
  assert.equal(looks, 2);
  // Another agent looking: its lock folder is there, fresh. The last look is taken, however old.
  t += 10 * P.NPU_ROOM_FRESH_MS;
  mkdirSync(path.join(dir, 'npu-room.look'));
  const during = await P.npuRoom({ dir, now: () => t, look });
  assert.equal(looks, 2, 'no second look beside one under way');
  assert.equal(during!.at, t - 10 * P.NPU_ROOM_FRESH_MS);
  // A lock left by a look that died is taken back.
  const old = (Date.now() - 2 * 20_000) / 1000;
  utimesSync(path.join(dir, 'npu-room.look'), old, old);
  await P.npuRoom({ dir, now: () => t, look });
  assert.equal(looks, 3);
  assert.ok(!existsSync(path.join(dir, 'npu-room.look')), 'the lock goes with the look');
  // A look that fails says so, and the NPU stays gentle for it.
  t += P.NPU_ROOM_FRESH_MS;
  const failed = await P.npuRoom({ dir, now: () => t, look: () => Promise.reject(new Error('no PowerShell')) });
  assert.match(failed!.problem!, /no PowerShell/);
  assert.match(P.whyGentle({ setting: 'full', room: failed, memory: 0, busy: 0 })!, /couldn't be looked at/);
});

test('npuPace: Manor gentle never looks; no NPU first never looks; else the room, the memory and the processor decide', async () => {
  let looked = 0;
  const room = async () => (looked++, ROOM);
  assert.deepEqual(await P.npuPace({ setting: 'gentle', room }), { full: false, why: "Manor's Settings keep it at the rounds' pace", room: null });
  assert.equal((await P.npuPace({ setting: 'full', npuFirst: () => false, room })).full, false);
  assert.equal(looked, 0);
  assert.equal((await P.npuPace({ setting: 'full', npuFirst: () => true, room, memory: () => 0.4, busy: async () => 0.1, now: () => ROOM.at })).full, true);
  const busy = await P.npuPace({ setting: 'full', npuFirst: () => true, room, memory: () => 0.4, busy: async () => 0.7, now: () => ROOM.at });
  assert.deepEqual([busy.full, busy.why], [false, 'the processor is busy (70%)']);
  assert.equal(looked, 2);
});

test("the setting: Manor's npuPace gentle keeps it gentle, anything else is full; MANOR_NPU_PACE over both; tests gentle", () => {
  const manor = path.join(home, 'manor');
  mkdirSync(manor, { recursive: true });
  const env = { MANOR_NPU_PACE: undefined } as NodeJS.ProcessEnv;
  assert.equal(P.npuPaceSetting(manor, env), 'full', 'nothing said: full');
  writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ npuPace: 'gentle' }));
  assert.equal(P.npuPaceSetting(manor, env), 'gentle');
  assert.equal(P.npuPaceSetting(manor, { MANOR_NPU_PACE: 'full' }), 'full');
  assert.equal(P.npuPaceSetting(path.join(home, 'none'), { NODE_TEST_CONTEXT: 'child' }), 'gentle', 'under node --test');
});

test('a backlog runs item after item while full, and stops when done, gentle, out of time, busy, failed or stopping', async () => {
  resetWorkTasks();
  const items = (n: number, seen: string[] = []) => async () => (seen.push('item'), n-- > 0);
  const full = async () => ({ full: true, why: null });
  const done = await P.npuBacklog('notes', items(5), { pace: full });
  assert.deepEqual([done.done, done.stopped, done.why], [5, 'done', null]);

  let left = 3;
  const turning = async () => (left-- > 0 ? { full: true, why: null } : { full: false, why: 'the PC is on its battery' });
  const gentle = await P.npuBacklog('notes', items(10), { pace: turning });
  assert.deepEqual([gentle.done, gentle.stopped, gentle.why], [3, 'gentle', 'the PC is on its battery'], 'looked at again before each item');

  let t = 0;
  const budget = await P.npuBacklog('notes', async () => ((t += 400), true), { pace: full, budgetMs: 1000, now: () => t });
  assert.deepEqual([budget.done, budget.stopped], [3, 'budget']);
  assert.match(budget.why!, /the rest waits for its next round/);

  const busy = await P.npuBacklog('notes', async () => { throw new NpuBusy('the line is long'); }, { pace: full });
  assert.deepEqual([busy.done, busy.stopped, busy.why], [0, 'busy', 'the line is long']);
  const failed = await P.npuBacklog('notes', async () => { throw new Error('bad answer'); }, { pace: full });
  assert.deepEqual([failed.stopped, failed.why], ['failed', 'bad answer']);
  const stop = new AbortController();
  stop.abort();
  assert.equal((await P.npuBacklog('notes', items(5), { pace: full, signal: stop.signal })).stopped, 'stopping');
  assert.equal(workTasks().length, 0, 'every stretch left the work status when it ended');
});

test('one backlog by a name at a time, a task while it runs; startNpuBacklog returns at once and says its end in the log', async () => {
  resetWorkTasks();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const full = async () => ({ full: true, why: null });
  let n = 0;
  const lines: string[] = [];
  const running = P.startNpuBacklog('captions', async () => (n++ ? false : (await held, true)), { pace: full, log: (l) => lines.push(l) });
  for (const deadline = Date.now() + 5000; !workTasks().length && Date.now() < deadline; ) await new Promise((r) => setImmediate(r));
  assert.deepEqual(workTasks().map((t) => [t.kind, t.what, t.parent]), [['model-backlog', 'Its captions, on the NPU at full speed', null]]);
  assert.equal((await P.npuBacklog('captions', async () => true, { pace: full })).stopped, 'running', 'the same name again: at once');
  release();
  const r = await running;
  assert.deepEqual([r.done, r.stopped], [1, 'done']);
  assert.match(lines[0], /^1 of its captions on the NPU in \d+ s: nothing left$/);
  assert.equal(workTasks().length, 0);
  // A stretch that found no room and did nothing says nothing: the next round tries again.
  lines.length = 0;
  await P.startNpuBacklog('captions', async () => true, { pace: async () => ({ full: false, why: 'the PC is on its battery' }), log: (l) => lines.push(l) });
  assert.deepEqual(lines, []);
});
