import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { freePort } from './free-port.ts';
import { until } from './until.ts';

// An agent's work status (work-status.ts, kit 2.75.0): its tasks, the PC's lines, its results, at GET /api/peer/work.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-work-status-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.FIXTURE_PORT = String(await freePort());
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { APP, port } = await import('./fixture/src/app.ts');
const { currentWork, inWork, resetWorkTasks, startWork, withWork, workTasks } = await import('./fixture/src/kit/work-tasks.ts');
const { RESULTS_SHOWN, codeAt, pcLines, pcLoad, recentResults, recordResult, resetResults, resultFor, resultKey, taskView, workStatus } = await import('./fixture/src/kit/work-status.ts');
const { CHECKS_RUNS_ENV, CHECKS_WHO_ENV, checksLimits, checksMemory, checksPaceExe, checksRuns, checksRunsDir, checksWho, pacedCommand, parseChecksRun } = await import('./fixture/src/kit/checks-pace.ts');
const { inWorkTurn, workLockDir } = await import('./fixture/src/kit/pace.ts');
const { withAcceleratorTurn } = await import('./fixture/src/kit/npu-queue.ts');
const { every } = await import('./fixture/src/kit/schedule.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');
const { serve } = await import('./fixture/src/kit/server.ts');

type ChecksRun = NonNullable<ReturnType<typeof parseChecksRun>>;

const run = (o: Partial<ChecksRun>): ChecksRun => ({ pid: process.pid, state: 'turn', slot: 0, since: Date.now(), agent: APP.id, work: '', what: 'node --test', ...o });

test('a task: running from its start, or waiting in a line until it runs; what it works on said as it becomes known; gone once done', () => {
  resetWorkTasks();
  let now = 1_000;
  const clock = () => now;
  const h = startWork({ kind: 'check', what: "Reeve#212's   checks", repo: 'me/reeve', pr: 212 }, clock);
  assert.deepEqual(workTasks(), [{ id: h.id, kind: 'check', what: "Reeve#212's checks", repo: 'me/reeve', pr: 212, parent: null, since: 1_000, runningSince: 1_000, line: null, inLineSince: null }]);
  now = 2_000;
  h.waitIn('stages');
  assert.deepEqual([workTasks()[0].line, workTasks()[0].inLineSince, workTasks()[0].runningSince], ['stages', 2_000, null]);
  now = 3_000;
  h.waitIn('stages');
  assert.equal(workTasks()[0].inLineSince, 2_000, 'the same line again: still since it joined');
  h.running();
  h.set({ commit: 'abc', tree: 'def', pr: -1 });
  assert.deepEqual([workTasks()[0].line, workTasks()[0].runningSince, workTasks()[0].commit, workTasks()[0].tree, workTasks()[0].pr], [null, 3_000, 'abc', 'def', 212]);
  h.done();
  h.running();
  assert.deepEqual(workTasks(), [], 'done: gone, and nothing it says after brings it back');
  const waits = startWork({ kind: 'round', what: 'round', line: 'work' }, clock);
  assert.deepEqual([workTasks()[0].line, workTasks()[0].inLineSince, workTasks()[0].runningSince], ['work', 3_000, null], 'started in a line');
  waits.done();
});

test('withWork: the task current while it runs (its checks and the tasks it starts are its), ended however it ends', async () => {
  resetWorkTasks();
  assert.equal(currentWork(), null);
  let inner = '';
  await withWork({ kind: 'stage', what: 'round' }, async (outer) => {
    assert.equal(currentWork(), outer.id);
    await withWork({ kind: 'check', what: 'checks' }, async (h) => {
      inner = h.id;
      assert.equal(currentWork(), h.id);
      assert.equal(workTasks().find((t) => t.id === h.id)?.parent, outer.id, "the outer task's part");
      assert.match(checksWho('C:\\Program Files\\nodejs\\node.exe', ['--test', 'C:\\work\\a long folder name\\test\\x.test.ts']), new RegExp(`^${APP.id}\\t${h.id}\\tnode --test x\\.test\\.ts$`));
    });
    assert.equal(currentWork(), outer.id);
  });
  assert.ok(inner);
  await assert.rejects(withWork({ kind: 'check', what: 'fails' }, async () => Promise.reject(new Error('no'))), /no/);
  assert.deepEqual(workTasks(), [], 'every one ended');
  const h = startWork({ kind: 'trial', what: 'trial' });
  assert.equal(inWork(h, () => currentWork()), h.id);
  h.done();
  assert.equal(checksWho('npm', ['test'], 'Reeve\'s\tchecks\n'), `${APP.id}\t\tReeve's checks`, 'no task: none named; tabs and lines never break the line');
});

test("a launcher's file: where it stands, since when, and who started it; anything else is none", () => {
  const since = '2026-10-15T09:00:00.0000000Z';
  assert.deepEqual(parseChecksRun('1234.run', `turn 2 ${since}\nsteward\tw7\tnpm test\n`), { pid: 1234, state: 'turn', slot: 2, since: Date.parse(since), agent: 'steward', work: 'w7', what: 'npm test' });
  assert.deepEqual(parseChecksRun('9.run', `\uFEFFwaiting -1 ${since}\r\n\r\n`), { pid: 9, state: 'waiting', slot: null, since: Date.parse(since), agent: '', work: '', what: '' });
  assert.equal(parseChecksRun('9.run', `running -1 ${since}\n`)?.state, 'running');
  for (const [name, text] of [['x.run', `turn 0 ${since}`], ['9.run', ''], ['9.run', 'turn 0 yesterday'], ['9.run', `holding 0 ${since}`]]) assert.equal(parseChecksRun(name, text), null, `${name}: ${text}`);
});

test("the PC's check runs: the launchers' files, the longest first; one whose launcher has gone is removed", () => {
  const dir = path.join(home, 'runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '100.run'), 'waiting -1 2026-10-15T09:05:00Z\nreeve\t\tnpm test\n');
  writeFileSync(path.join(dir, '200.run'), 'turn 0 2026-10-15T09:01:00Z\nsteward\tw3\tnode --test\n');
  writeFileSync(path.join(dir, '300.run'), 'turn 1 2026-10-15T09:00:00Z\nassayer\t\tnpm test\n');
  writeFileSync(path.join(dir, '400.run'), '');
  writeFileSync(path.join(dir, 'notes.txt'), 'not one');
  const alive = (pid: number) => pid !== 300;
  assert.deepEqual(checksRuns(dir, alive).map((r) => [r.pid, r.state, r.agent]), [[200, 'turn', 'steward'], [100, 'waiting', 'reeve']], 'one being written reads as nothing, and is kept');
  assert.deepEqual(readdirSync(dir).sort(), ['100.run', '200.run', '400.run', 'notes.txt']);
  assert.deepEqual(checksRuns(path.join(home, 'none')), []);
});

test('a task waits in the checks pace\'s line while every check it started waits for a turn; ahead: those who waited longer', () => {
  resetWorkTasks();
  const h = startWork({ kind: 'check', what: 'checks', repo: 'me/reeve', commit: 'c0ffee' });
  const t = workTasks()[0];
  const lines = [{ id: 'checks', kind: 'checks' as const, name: '', slots: 3, holders: [], waiting: [{ who: 'reeve', since: new Date(t.since - 60_000).toISOString() }, { who: APP.id, since: new Date(t.since + 1_000).toISOString(), work: h.id }] }];
  const waiting = taskView(t, [run({ state: 'waiting', slot: null, work: h.id, since: t.since + 1_000 })], lines);
  assert.deepEqual([waiting.line, waiting.inLineSince, waiting.ahead, waiting.runningSince], ['checks', new Date(t.since + 1_000).toISOString(), 1, undefined]);
  const both = taskView(t, [run({ state: 'waiting', slot: null, work: h.id }), run({ pid: 2, work: h.id })], lines);
  assert.equal(both.line, undefined, 'one of its checks has a turn: it runs');
  assert.equal(both.runningSince, new Date(t.since).toISOString());
  assert.equal(taskView(t, [run({ state: 'waiting', work: 'w999' })], lines).line, undefined, "another task's check is not its own");
  h.done();
});

test("the PC's lines: the checks pace's turns, the work line and the first-round line, with who holds a place and who waits", async () => {
  process.env.MANOR_AGENTS_AT_ONCE = '1';
  try {
    let release!: () => void;
    const held = inWorkTurn('full', () => new Promise<void>((r) => (release = r)), { who: APP.id, doing: 'round', limitMs: 60_000, waitMs: 30_000 });
    await until(() => release, 10_000, 'the slot taken');
    const waiter = withAcceleratorTurn([workLockDir()], async () => {}, { who: 'reeve', doing: 'index', waitMs: 30_000, lane: 'background' });
    let lines: Awaited<ReturnType<typeof pcLines>> = [];
    await until(async () => (lines = await pcLines({ runs: [run({}), run({ pid: 5, state: 'waiting', slot: null, agent: 'reeve' })] })).find((l) => l.id === 'work')!.waiting.length === 1, 10_000, 'the waiter in line');
    const checks = lines.find((l) => l.id === 'checks')!;
    assert.equal(checks.slots, null, 'under node --test the checks pace is off: no turns');
    assert.deepEqual([checks.holders.map((h) => h.who), checks.waiting.map((w) => w.who)], [[APP.id], ['reeve']]);
    const work = lines.find((l) => l.id === 'work')!;
    assert.equal(work.slots, 1);
    assert.deepEqual(work.holders.map((h) => [h.who, h.pid]), [[APP.id, process.pid]], 'its own hold named; another process by its id');
    assert.deepEqual(work.waiting.map((w) => [w.who, w.what, w.lane]), [['reeve', 'index', 'background']]);
    assert.ok(lines.find((l) => l.id === 'first-round'));
    release();
    await held;
    await waiter;
  } finally {
    delete process.env.MANOR_AGENTS_AT_ONCE;
  }
});

test('a scheduled round is a task: in the work line while it waits, running once it has its turn, the work it does its part', async () => {
  resetWorkTasks();
  process.env.MANOR_AGENTS_AT_ONCE = '1';
  setDuty(true);
  let release!: () => void;
  const held = inWorkTurn('full', () => new Promise<void>((r) => (release = r)), { who: 'another agent', limitMs: 60_000, waitMs: 30_000 });
  await until(() => release, 10_000, 'the slot taken');
  let parts: string[] = [];
  let go!: () => void;
  const job = every(
    3_600_000,
    async () => {
      await withWork({ kind: 'check', what: 'its checks' }, async () => {
        parts = workTasks().map((t) => `${t.kind}<${t.parent ?? ''}`);
        await new Promise<void>((r) => (go = r));
      });
    },
    { name: 'tasks', firstDelayMs: 20 },
  );
  try {
    await until(() => workTasks().some((t) => t.kind === 'round' && t.line === 'work'), 10_000, 'the round in the work line');
    const s = await workStatus({}, { lines: [] });
    assert.deepEqual(s.waiting.map((t) => [t.kind, t.what, t.line]), [['round', 'tasks', 'work']]);
    assert.deepEqual(s.running, []);
    release();
    await until(() => go, 10_000, 'the round running');
    const round = workTasks().find((t) => t.kind === 'round')!;
    assert.equal(round.line, null);
    assert.deepEqual(parts, ['round<', `check<${round.id}`], 'its check is its part');
    go();
    await until(() => !job.running, 10_000, 'the round over');
    assert.deepEqual(workTasks(), [], 'done once the round ends');
  } finally {
    job.stop();
    await held;
    delete process.env.MANOR_AGENTS_AT_ONCE;
  }
});

test('results: one per kind, repository and tree, the latest replacing the one before, the newest first', () => {
  resetResults();
  recordResult({ kind: 'checks', repo: 'me/Reeve', tree: 't1', commit: 'c1', ok: false, note: 'a test failed' }, new Date('2026-10-15T09:00:00Z'));
  recordResult({ kind: 'checks', repo: 'me/reeve', tree: 't1', commit: 'c2', ok: true }, new Date('2026-10-15T10:00:00Z'));
  recordResult({ kind: 'whole-suite', repo: 'me/reeve', tree: 't1', ok: true }, new Date('2026-10-15T09:30:00Z'));
  recordResult({ kind: 'checks', repo: 'me/reeve', tree: null, commit: 'c3', ok: true }, new Date('2026-10-15T08:00:00Z'));
  recordResult({ kind: 'checks', repo: 'me/reeve', tree: null, ok: true });
  const got = recentResults();
  assert.deepEqual(got.map((r) => [r.kind, r.tree, r.commit, r.ok]), [['checks', 't1', 'c2', true], ['whole-suite', 't1', undefined, true], ['checks', null, 'c3', true]], "the same code's newer result replaces it; one with no tree or commit isn't kept");
  assert.equal(resultFor({ kind: 'checks', repo: 'ME/REEVE', tree: 't1' })?.commit, 'c2', 'found by its tree, whatever commit asks');
  assert.equal(resultFor({ kind: 'checks', repo: 'me/reeve', tree: 't2' }), null);
  assert.equal(resultKey({ kind: 'checks', repo: 'Me/X', tree: null, commit: 'c' }), 'checks|me/x|c');
  assert.ok(existsSync(path.join(process.env.FIXTURE_HOME!, 'work-results.json')), 'kept in its data folder, which the test gave it');
});

test("a checkout's code: its commit and tree, and whether anything tracked changed; nothing known outside a checkout", async () => {
  const dir = path.join(home, 'checkout');
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile('git', ['-C', dir, ...args], { encoding: 'utf8' }, (e, out) => (e ? reject(e) : resolve(out.trim()))));
  assert.deepEqual(await codeAt(path.join(home, 'nowhere')), { clean: false });
  await git('init', '-q');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await git('add', 'a.txt');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'a');
  const at = await codeAt(dir);
  assert.deepEqual(at, { commit: await git('rev-parse', 'HEAD'), tree: await git('rev-parse', 'HEAD^{tree}'), clean: true });
  writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');
  assert.equal((await codeAt(dir)).clean, true, 'a file git doesn\'t track changes nothing');
  writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  assert.deepEqual(await codeAt(dir), { ...at, clean: false });
});

test("the status: the agent, the PC, its tasks running and waiting, the lines, its results and what the agent adds", async () => {
  resetWorkTasks();
  resetResults();
  const r = startWork({ kind: 'check', what: 'checks', repo: 'me/reeve' });
  const w = startWork({ kind: 'trial', what: 'trial', line: 'steward:trials' });
  recordResult({ kind: 'checks', repo: 'me/reeve', tree: 't1', ok: true }, new Date('2026-10-15T09:00:00Z'));
  const load = { name: 'pc', processors: 8, memoryMb: 16000, freeMemoryMb: 8000, busy: 0.25, pace: 'gentle' as const, checksCap: 3333 };
  const s = await workStatus(
    {
      slots: [{ kind: 'stage', name: 'Stages at once', of: 2, used: 1 }],
      lines: [{ id: 'steward:trials', kind: 'agent', name: 'Kit trials', slots: 4, holders: [], waiting: [] }],
      results: [{ kind: 'checks', repo: 'me/reeve', tree: 't1', ok: false, at: '2026-10-15T08:00:00Z' }, { kind: 'whole-suite', repo: 'me/steward', tree: 't9', ok: true, at: '2026-10-15T10:00:00Z' }],
      blocked: [{ kind: 'version-queue', what: "Reeve's version queue", by: '#233, a draft', since: '2026-10-15T07:00:00Z', waiting: ['#266'] }],
    },
    { now: Date.parse('2026-10-15T11:00:00Z'), runs: [], lines: [], load },
  );
  assert.equal(s.v, 1);
  assert.deepEqual(s.agent, { id: APP.id, name: APP.name, version: APP.version, pid: process.pid });
  assert.equal(s.at, '2026-10-15T11:00:00.000Z');
  assert.deepEqual(s.pc, load);
  assert.deepEqual(s.running.map((t) => t.id), [r.id]);
  assert.deepEqual(s.waiting.map((t) => [t.id, t.line]), [[w.id, 'steward:trials']]);
  assert.deepEqual(s.lines.map((l) => l.id), ['steward:trials'], "the agent's own line beside the PC's");
  assert.deepEqual(s.results.map((x) => [x.kind, x.tree, x.ok]), [['whole-suite', 't9', true], ['checks', 't1', true]], 'the newer of two for one tree');
  assert.equal(s.slots[0].of, 2);
  assert.equal(s.blocked[0].by, '#233, a draft');
  assert.ok(RESULTS_SHOWN >= 1);
  r.done();
  w.done();
});

test("the PC's load: its name, processors and memory, how busy (0 to 1), its paces", async () => {
  const l = await pcLoad();
  assert.equal(l.name, os.hostname());
  assert.ok(l.processors >= 1 && l.memoryMb > 0 && l.freeMemoryMb >= 0);
  assert.ok(l.busy === null || (l.busy >= 0 && l.busy <= 1));
  assert.equal(l.pace, 'full', 'under node --test');
  assert.equal(l.checksCap, 0);
});

test('every agent answers GET /api/peer/work with its status, with what it adds', async () => {
  const { close } = await serve({ port, icon: '<svg/>', work: () => ({ slots: [{ kind: 'stage', name: 'Stages', of: 2, used: 0 }] }) });
  try {
    const body = await new Promise<string>((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port, path: '/api/peer/work', headers: { host: `127.0.0.1:${port}` } }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => (res.statusCode === 200 ? resolve(text) : reject(new Error(`${res.statusCode} ${text}`))));
        })
        .on('error', reject),
    );
    const s = JSON.parse(body);
    assert.equal(s.v, 1);
    assert.equal(s.agent.id, APP.id);
    assert.deepEqual(s.slots, [{ kind: 'stage', name: 'Stages', of: 2, used: 0 }]);
    assert.ok(s.lines.some((l: { id: string }) => l.id === 'checks'));
  } finally {
    await close();
  }
});

test('a paced command names its agent and task, and where its launcher says so', { skip: process.platform !== 'win32' }, async () => {
  resetWorkTasks();
  await withWork({ kind: 'check', what: 'checks' }, async (h) => {
    const p = await pacedCommand(process.execPath, ['--test', 'a.test.ts'], { env: { KIT_CHECKS_PACE: '50' }, home: path.join(home, 'no-manor'), what: "Reeve's checks" });
    assert.equal(p.env[CHECKS_RUNS_ENV], checksRunsDir());
    assert.equal(p.env[CHECKS_WHO_ENV], `${APP.id}\t${h.id}\tReeve's checks`);
  });
});

test('on Windows, a launcher says where it stands while it runs (a turn, since when, who), its programs say nothing, and its file goes when it ends', { skip: process.platform !== 'win32' }, async () => {
  const p = await pacedCommand(process.execPath, ['x'], { env: { KIT_CHECKS_PACE: '50' }, home: path.join(home, 'no-manor') });
  assert.equal(p.file, checksPaceExe());
  const dir = path.join(home, 'launcher-runs');
  const env: NodeJS.ProcessEnv = { ...process.env, KIT_CHECKS_TURN_NAME: `kit-test-runs-${process.pid}`, [CHECKS_RUNS_ENV]: dir, [CHECKS_WHO_ENV]: `${APP.id}\tw1\tits checks` };
  delete env.KIT_CHECKS_TURN;
  const script = `const fs = require("fs"), path = require("path"); const d = ${JSON.stringify(dir)}; console.log(JSON.stringify({ files: fs.readdirSync(d).map((f) => [f, fs.readFileSync(path.join(d, f), "utf8")]), runs: process.env.${CHECKS_RUNS_ENV} ?? null }))`;
  const out = await new Promise<{ code: number; out: string; err: string }>((resolve) =>
    execFile(p.file, [checksLimits(5000, checksMemory(), 1), process.execPath, '-e', script], { env, windowsHide: true, encoding: 'utf8' }, (e: any, o, err) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: o, err })),
  );
  assert.equal(out.code, 0, out.err);
  const seen = JSON.parse(out.out) as { files: [string, string][]; runs: string | null };
  assert.equal(seen.runs, null, 'its programs take no turn, so say nothing');
  assert.equal(seen.files.length, 1);
  const r = parseChecksRun(seen.files[0][0], seen.files[0][1]);
  assert.ok(r, seen.files[0][1]);
  assert.deepEqual([r!.state, r!.slot, r!.agent, r!.work, r!.what], ['turn', 0, APP.id, 'w1', 'its checks']);
  assert.ok(Math.abs(r!.since - Date.now()) < 120_000);
  assert.deepEqual(readdirSync(dir), [], 'gone once it ended');
});
