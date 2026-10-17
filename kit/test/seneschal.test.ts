import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { freePort } from './free-port.ts';

// The Seneschal's work client (node/seneschal.ts) against a Seneschal the test plays: a page on a free port that
// answers as each test says, and keeps what it was asked. What matters most: with no Seneschal, one off duty, one on a
// PC without Developer Pro, or one that stops answering, the agent runs its work as before; a pass of exactly these
// checks stands in; a failure is never taken for this run's; and a lease that runs out doesn't stop the run.
const { sameCommands, seneschalAt, seneschalTurn } = await import('./fixture/src/kit/seneschal.ts');

const TOKEN = 'a'.repeat(48);
type Route = (body: any, n: number) => { status?: number; json: unknown } | 'hang';
let routes: Record<string, Route> = {};
const asked: { route: string; body: any }[] = [];
let server: http.Server;
let port = 0;

before(async () => {
  port = await freePort();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.headers['x-token'] !== TOKEN) {
        res.writeHead(403).end('{}');
        return;
      }
      const body = raw ? JSON.parse(raw) : null;
      const route = req.url ?? '';
      asked.push({ route, body });
      const r = routes[route]?.(body, asked.filter((a) => a.route === route).length);
      if (r === 'hang') return; // never answers
      res.writeHead(r?.status ?? (r ? 200 : 404), { 'content-type': 'application/json' }).end(JSON.stringify(r?.json ?? { error: 'no such route' }));
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  routes = {};
  asked.length = 0;
});

const at = () => ({ base: `http://127.0.0.1:${port}`, token: TOKEN });
const task = { kind: 'pr-check' as const, repo: 'Jcollier0120/Reeve', commit: 'c'.repeat(40), tree: 'f'.repeat(40), pr: 212, lane: 'normal' as const, by: 'steward' };
// A getter: the port is only known once the page listens.
const quick = { worker: 'steward', get at() { return at(); }, env: {}, sleep: async () => {}, pollMs: 0 };
const lines: string[] = [];
const say = (l: string) => lines.push(l);
const waitingTask = (o: Record<string, unknown> = {}) => ({ task: { id: 't7', state: 'waiting', ...o }, existing: false, reused: false });
const leased = { task: { id: 't7', state: 'leased' }, lease: { token: 'b'.repeat(24), until: '', heartbeatMs: 20 }, usualMs: 60_000 };

test("where the Seneschal listens, from its server.json; none there, or one that makes no sense, and there's no Seneschal", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seneschal-at-'));
  try {
    assert.equal(seneschalAt(dir), null);
    writeFileSync(path.join(dir, 'server.json'), '﻿' + JSON.stringify({ pid: 1, port: 40123, token: TOKEN }));
    assert.deepEqual(seneschalAt(dir), { base: 'http://127.0.0.1:40123', token: TOKEN });
    writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ port: 'x', token: TOKEN }));
    assert.equal(seneschalAt(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no Seneschal on this PC: run as before, and nothing is asked', async () => {
  assert.equal(await seneschalTurn(task, { ...quick, at: null }), null);
  const home = mkdtempSync(path.join(os.tmpdir(), 'seneschal-none-'));
  try {
    assert.equal(await seneschalTurn(task, { ...quick, at: undefined, env: { SENESCHAL_HOME: home } }), null, 'its data folder has no server.json');
    writeFileSync(path.join(home, 'server.json'), JSON.stringify({ port, token: TOKEN }));
    assert.equal(await seneschalTurn(task, { ...quick, at: undefined, env: { NODE_TEST_CONTEXT: 'child' } }), null, "under node --test, never this PC's own Seneschal");
    routes['/api/tasks/submit'] = () => ({ json: { task: null, why: 'off duty', asBefore: true } });
    assert.equal(await seneschalTurn(task, { ...quick, at: undefined, env: { NODE_TEST_CONTEXT: 'child', SENESCHAL_HOME: home } }), null);
    assert.equal(asked.length, 1, "one the test gave a home of its own is asked");
    asked.length = 0;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(asked.length, 0);
});

test('inside another run\'s turn (KIT_CHECKS_TURN): run as before, or the PC would be held twice', async () => {
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  assert.equal(await seneschalTurn(task, { ...quick, env: { KIT_CHECKS_TURN: '1' } }), null);
  assert.equal(asked.length, 0);
});

test('off duty, or a PC without Developer Pro: the Seneschal says run as before, and it does', async () => {
  routes['/api/tasks/submit'] = () => ({ json: { task: null, why: "the Seneschal comes with Developer Pro, which this PC doesn't have: it hands out no work, so run it as before", asBefore: true } });
  lines.length = 0;
  assert.equal(await seneschalTurn(task, { ...quick, say }), null);
  assert.match(lines[0], /comes with Developer Pro/);
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => ({ json: { task: null, why: 'the Seneschal is off duty: it hands out no work, so run it as before', asBefore: true } });
  assert.equal(await seneschalTurn(task, quick), null);
});

test("a Seneschal that doesn't answer, or stops answering while it waits: run as before", async () => {
  const closed = await freePort();
  assert.equal(await seneschalTurn(task, { ...quick, at: { base: `http://127.0.0.1:${closed}`, token: TOKEN } }), null);
  let n = 0;
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => (++n === 1 ? { json: { task: null, why: 'no room', state: 'waiting' } } : { status: 503, json: {} });
  lines.length = 0;
  assert.equal(await seneschalTurn(task, { ...quick, say }), null);
  assert.match(lines.at(-1)!, /stopped answering: run as before/);
});

test('a task the Seneschal refuses (a 400): run as before, saying why', async () => {
  routes['/api/tasks/submit'] = () => ({ status: 400, json: { error: '"commit" is a commit' } });
  lines.length = 0;
  assert.equal(await seneschalTurn(task, { ...quick, say }), null);
  assert.match(lines[0], /refused the task: "commit" is a commit: run as before/);
});

test('it asks for its task by name until its turn comes, saying why it waits; then holds the lease and reports', async () => {
  routes['/api/tasks/submit'] = () => ({ status: 201, json: waitingTask() });
  routes['/api/tasks/lease'] = (_b, n) => (n < 3 ? { json: { task: null, why: n === 1 ? 'no room: 3 tasks running' : 'its turn comes after Porter#9 (Blocking)', state: 'waiting' } } : { json: leased });
  routes['/api/tasks/heartbeat'] = () => ({ json: { ok: true, until: '' } });
  routes['/api/tasks/report'] = () => ({ json: { task: { id: 't7', state: 'done' } } });
  const whys: string[] = [];
  const a = await seneschalTurn(task, { ...quick, slot: 'checks', waiting: (w) => whys.push(w) });
  assert.ok(a && 'turn' in a);
  assert.deepEqual(asked[0], { route: '/api/tasks/submit', body: task });
  assert.deepEqual(asked[1].body, { worker: 'steward', id: 't7', slot: 'checks' });
  assert.deepEqual(whys, ['no room: 3 tasks running', 'its turn comes after Porter#9 (Blocking)']);
  assert.equal(a.turn.id, 't7');
  assert.equal(a.turn.usualMs, 60_000);
  const v = await a.turn.hold(async () => {
    await new Promise((r) => setTimeout(r, 90));
    return null;
  }, (failed) => ({ ok: !failed, commands: ['npm test'] }));
  assert.equal(v, null);
  assert.ok(asked.some((x) => x.route === '/api/tasks/heartbeat' && x.body.token === 'b'.repeat(24)), 'a heartbeat while it ran');
  const rep = asked.find((x) => x.route === '/api/tasks/report')!.body;
  assert.deepEqual([rep.id, rep.token, rep.ok, rep.commands], ['t7', 'b'.repeat(24), true, ['npm test']]);
  assert.equal(typeof rep.ms, 'number');
});

test("a lease that runs out while it runs (the PC slept): the run goes on, and its report is still sent", async () => {
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => ({ json: leased });
  routes['/api/tasks/heartbeat'] = () => ({ status: 409, json: { ok: false, gone: 'its lease ran out' } });
  routes['/api/tasks/report'] = () => ({ json: { task: { id: 't7', state: 'done' }, already: false } });
  lines.length = 0;
  const a = await seneschalTurn(task, { ...quick, say });
  assert.ok(a && 'turn' in a);
  const v = await a.turn.hold(async () => {
    await new Promise((r) => setTimeout(r, 80));
    return 'npm test failed (exit 1)';
  }, (failed) => ({ ok: !failed, note: failed ?? undefined }));
  assert.equal(v, 'npm test failed (exit 1)');
  assert.ok(lines.some((l) => /lease is gone \(its lease ran out\): it runs on/.test(l)));
  assert.deepEqual(asked.filter((x) => x.route === '/api/tasks/report').map((x) => [x.body.ok, x.body.note]), [[false, 'npm test failed (exit 1)']]);
});

test("a run that throws is reported as one that couldn't finish, and the error goes on", async () => {
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => ({ json: leased });
  routes['/api/tasks/report'] = () => ({ json: {} });
  const a = await seneschalTurn(task, quick);
  assert.ok(a && 'turn' in a);
  await assert.rejects(a.turn.hold(async () => { throw new Error('the clone is locked'); }, () => ({ ok: true })), /the clone is locked/);
  const rep = asked.find((x) => x.route === '/api/tasks/report')!.body;
  assert.deepEqual([rep.ok, rep.error, rep.note], [false, true, 'the clone is locked']);
});

test('a pass of exactly these checks stands in; one of other checks does not', async () => {
  const pass = { ok: true, at: '2026-10-15T12:00:00Z', by: 'assayer', ms: 42_000, commands: ['npm test', 'npm run typecheck'] };
  routes['/api/tasks/submit'] = () => ({ json: { task: { id: 't3', state: 'done', result: pass }, existing: true, reused: true } });
  assert.deepEqual(await seneschalTurn(task, { ...quick, commands: [' npm test', 'npm run typecheck'] }), { reused: pass, id: 't3' });
  lines.length = 0;
  assert.equal(await seneschalTurn(task, { ...quick, commands: ['npm test'], say }), null);
  assert.match(lines[0], /ran other checks: run as before/);
  // Done while it waited (another agent ran it): the same.
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => ({ json: { task: null, why: 'it passed', state: 'done', result: pass } });
  assert.deepEqual(await seneschalTurn(task, { ...quick, commands: pass.commands }), { reused: pass, id: 't7' });
});

test('a failure the Seneschal holds is never this run\'s: it asks for the task again, and runs it', async () => {
  const fail = { ok: false, at: '2026-10-15T12:00:00Z', by: 'steward', ms: 1000, note: '1 test failed' };
  routes['/api/tasks/submit'] = (b) => (b.again ? { status: 201, json: waitingTask({ id: 't8' }) } : { json: { task: { id: 't7', state: 'done', result: fail }, existing: true, reused: true } });
  routes['/api/tasks/lease'] = (b) => ({ json: { ...leased, task: { id: b.id, state: 'leased' } } });
  const a = await seneschalTurn(task, quick);
  assert.ok(a && 'turn' in a);
  assert.equal(a.turn.id, 't8');
  assert.deepEqual(asked.filter((x) => x.route === '/api/tasks/submit').map((x) => !!x.body.again), [false, true]);
});

test('a task the Seneschal let go while it waited is asked for afresh; one that keeps going, and it runs as before', async () => {
  let id = 0;
  routes['/api/tasks/submit'] = () => ({ json: waitingTask({ id: `t${++id}` }) });
  routes['/api/tasks/lease'] = (b) => (b.id === 't2' ? { json: leased } : { json: { task: null, why: 'no such task: ask for it again', gone: true } });
  const a = await seneschalTurn(task, quick);
  assert.ok(a && 'turn' in a, 'the second ask was leased');
  routes['/api/tasks/lease'] = () => ({ json: { task: null, why: 'no such task: ask for it again', gone: true } });
  assert.equal(await seneschalTurn(task, quick), null);
});

test('its turn not come in the time a checks pace turn may take: run as before', async () => {
  let t = 0;
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => ({ json: { task: null, why: 'no room: 3 tasks running', state: 'waiting' } });
  lines.length = 0;
  const a = await seneschalTurn(task, { ...quick, now: () => (t += 60_000), waitMs: 5 * 60_000, say });
  assert.equal(a, null);
  assert.match(lines.at(-1)!, /its turn didn't come in 5 minutes \(no room: 3 tasks running\): run as before/);
});

test('the same commands: in order, trimmed; none asked for, and any pass stands', () => {
  assert.ok(sameCommands(['npm test', ' npm run typecheck '], ['npm test', 'npm run typecheck']));
  assert.ok(!sameCommands(['npm run typecheck', 'npm test'], ['npm test', 'npm run typecheck']));
  assert.ok(!sameCommands(undefined, ['npm test']));
  assert.ok(sameCommands(undefined, undefined));
});

// Other PCs on the licence (Seneschal 0.2.0, kit 2.78.16): a task runs on another PC, a failure is tried once more on one.
const { jobOf, seneschalWork } = await import('./fixture/src/kit/seneschal.ts');
const LAPTOP = { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'LAPTOP' };
/** A clock that moves only as the client sleeps between asks: a minute a sleep. */
const minutes = () => {
  const c = { t: 0 };
  return { now: () => c.t, sleep: async () => void (c.t += 60_000) };
};
const runsThere = { json: { task: null, why: 'it runs now, on steward on LAPTOP', state: 'leased' } };

test("while its task runs on another PC the wait isn't counted, and that PC's pass stands in", async () => {
  const pass = { ok: true, at: '2026-10-16T12:00:00Z', by: 'steward on LAPTOP', ms: 600_000, commands: ['npm test'], pc: LAPTOP };
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  // Ten minutes running there, twice its wait for a turn.
  routes['/api/tasks/lease'] = (_b, n) => (n <= 10 ? runsThere : { json: { task: null, why: 'it passed', state: 'done', result: pass } });
  assert.deepEqual(await seneschalTurn(task, { ...quick, ...minutes(), waitMs: 5 * 60_000, commands: ['npm test'] }), { reused: pass, id: 't7' });
});

test('one that runs elsewhere past the longest a run may take: run as before', async () => {
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => runsThere;
  lines.length = 0;
  assert.equal(await seneschalTurn(task, { ...quick, ...minutes(), runMs: 30 * 60_000, say }), null);
  assert.match(lines.at(-1)!, /it ran elsewhere for more than 30 minutes \(it runs now, on steward on LAPTOP\): run as before/);
});

test("a failure confirmed on two PCs while it waited is the change's, not run here; one held from before is asked for again", async () => {
  const fail = { ok: false, at: '2026-10-16T12:00:00Z', by: 'steward on LAPTOP', ms: 1000, note: '1 test failed', commands: ['npm test'], pc: LAPTOP, confirmed: { on: 'DESKTOP' } };
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => ({ json: { task: null, why: 'it failed', state: 'done', result: fail } });
  assert.deepEqual(await seneschalTurn(task, { ...quick, commands: ['npm test'] }), { failed: fail, id: 't7' });
  // Of other checks: asked for again, and run.
  routes['/api/tasks/submit'] = (b) => (b.again ? { status: 201, json: waitingTask({ id: 't8' }) } : { json: waitingTask() });
  routes['/api/tasks/lease'] = (b) => (b.id === 't8' ? { json: { ...leased, task: { id: 't8', state: 'leased' } } } : { json: { task: null, why: 'it failed', state: 'done', result: fail } });
  const other = await seneschalTurn(task, { ...quick, commands: ['npm run typecheck', 'npm test'] });
  assert.ok(other && 'turn' in other);
  // Held from before this asked: never taken for this run's.
  asked.length = 0;
  routes['/api/tasks/submit'] = (b) => (b.again ? { status: 201, json: waitingTask({ id: 't8' }) } : { json: { task: { id: 't7', state: 'done', result: fail }, existing: true, reused: true } });
  const held = await seneschalTurn(task, { ...quick, commands: ['npm test'] });
  assert.ok(held && 'turn' in held);
  assert.deepEqual(asked.filter((x) => x.route === '/api/tasks/submit').map((x) => !!x.body.again), [false, true]);
});

test('after a failure its report sends to another PC, elsewhere() waits for that run there and hands back what it came to', async () => {
  const flaky = { ok: true, at: '2026-10-16T12:00:00Z', by: 'steward on LAPTOP', ms: 1000, commands: ['npm test'], pc: LAPTOP, flaky: { on: 'DESKTOP', note: '1 test failed' } };
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = (_b, n) =>
    n === 1 ? { json: leased } : n <= 3 ? { json: { task: null, why: 'it failed here, and waits to be tried once more on another PC', state: 'waiting' } } : n <= 5 ? runsThere : { json: { task: null, why: 'it passed', state: 'done', result: flaky } };
  routes['/api/tasks/report'] = () => ({ json: { task: { id: 't7', state: 'waiting' }, retry: 'elsewhere' } });
  lines.length = 0;
  const a = await seneschalTurn(task, { ...quick, say });
  assert.ok(a && 'turn' in a);
  await a.turn.hold(async () => '1 test failed', (f) => ({ ok: !f, note: f ?? undefined }));
  assert.deepEqual(await a.turn.elsewhere(), flaky);
  assert.ok(lines.some((l) => /tries it once more on another PC/.test(l)));
  assert.equal(await a.turn.elsewhere(), null, 'asked once');
});

test("elsewhere(): null at once when it isn't tried elsewhere, and once the first failure stands", async () => {
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = (_b, n) => (n === 1 ? { json: leased } : { json: { task: null, why: 'it failed', state: 'done', result: { ok: false, at: '', by: 'steward', ms: 1 } } });
  routes['/api/tasks/report'] = () => ({ json: { task: { id: 't7', state: 'done' } } });
  const a = await seneschalTurn(task, quick);
  assert.ok(a && 'turn' in a);
  await a.turn.hold(async () => 'failed', () => ({ ok: false }));
  const before = asked.length;
  assert.equal(await a.turn.elsewhere(), null);
  assert.equal(asked.length, before, 'nothing asked');
  routes['/api/tasks/report'] = () => ({ json: { task: { id: 't7', state: 'waiting' }, retry: 'elsewhere' } });
  asked.length = 0;
  const b = await seneschalTurn(task, quick);
  assert.ok(b && 'turn' in b);
  await b.turn.hold(async () => 'failed', () => ({ ok: false }));
  assert.equal(await b.turn.elsewhere(), null, 'no other PC took it in time: the first failure stands');
});

test("a worker's ask: a task of its kinds and repositories at its turn, this PC's or another's; or when to ask again", async () => {
  const job = { id: 'b4', kind: 'pr-check', repo: 'Jcollier0120/Reeve', commit: 'c'.repeat(40), base: 'd'.repeat(40), branch: 'claude/npu', pr: 212, lane: 'blocking', what: "Reeve#212's checks", from: { pc: { id: 'aaaa', name: 'DESKTOP' }, id: 't9' } };
  routes['/api/tasks/lease'] = (_b, n) =>
    n === 1
      ? { json: { task: null, why: "asked DESKTOP for Reeve#212's checks", asked: { pc: 'DESKTOP', what: "Reeve#212's checks" }, retryMs: 3000 } }
      : { json: { task: job, lease: { token: 'e'.repeat(24), until: '', heartbeatMs: 20 }, usualMs: 1 } };
  routes['/api/tasks/report'] = () => ({ json: { task: job } });
  const ask = { worker: 'steward', kinds: ['pr-check' as const, 'full-suite' as const], repos: ['Jcollier0120/Reeve'], slot: 'others', at: at(), env: {} };
  assert.deepEqual(await seneschalWork(ask), { idle: "asked DESKTOP for Reeve#212's checks", retryMs: 3000 });
  assert.deepEqual(asked[0].body, { worker: 'steward', kinds: ['pr-check', 'full-suite'], repos: ['Jcollier0120/Reeve'], slot: 'others' });
  const got = await seneschalWork(ask);
  assert.ok(got && 'job' in got);
  const { turn, ...rest } = got.job;
  assert.deepEqual(rest, job);
  await turn.giveBack('its clone is in use here');
  const rep = asked.find((x) => x.route === '/api/tasks/report')!.body;
  assert.deepEqual([rep.id, rep.token, rep.ok, rep.returned, rep.note], ['b4', 'e'.repeat(24), false, true, 'its clone is in use here']);
  // No Seneschal, or inside another's turn: nothing to ask.
  assert.equal(await seneschalWork({ ...ask, at: null }), null);
  assert.equal(await seneschalWork({ ...ask, env: { KIT_CHECKS_TURN: '1' } }), null);
});

test("a task a worker is handed is read again: one that names anything but a repository's code is given back", async () => {
  const good = { id: 'b4', kind: 'pr-check', repo: 'Jcollier0120/Reeve', commit: 'c'.repeat(40), lane: 'normal', what: 'x' };
  assert.ok(jobOf(good));
  for (const bad of [{ commit: 'HEAD' }, { repo: '../Reeve' }, { branch: '--upload-pack=x' }, { branch: 'a..b' }, { base: 'main' }, { kind: 'wright-job' }, { id: 'x1' }]) {
    assert.equal(jobOf({ ...good, ...bad }, ['pr-check', 'full-suite']), null, JSON.stringify(bad));
  }
  routes['/api/tasks/lease'] = () => ({ json: { task: { ...good, branch: '-x' }, lease: { token: 'e'.repeat(24), until: '', heartbeatMs: 20 }, usualMs: 1 } });
  routes['/api/tasks/report'] = () => ({ json: {} });
  const got = await seneschalWork({ worker: 'steward', kinds: ['pr-check'], repos: ['Jcollier0120/Reeve'], at: at(), env: {} });
  assert.ok(got && 'idle' in got);
  assert.match(got.idle, /couldn't read \(b4\), given back/);
  assert.equal(asked.find((x) => x.route === '/api/tasks/report')!.body.returned, true);
});
