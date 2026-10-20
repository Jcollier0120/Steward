import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

// Other PCs on the licence (Seneschal 0.2.0, kit 2.78.22): a task runs on another PC, a failure is tried once more on one.
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

const { seneschalSiblings, shardOf } = await import('./fixture/src/kit/seneschal.ts');

test('a shard of a whole suite: handed to a worker with its part, and only for a full-suite task', () => {
  const whole = { id: 'b5', kind: 'full-suite', repo: 'Jcollier0120/Steward', commit: 'c'.repeat(40), lane: 'blocking', what: 'x', shard: { index: 2, of: 3 } };
  assert.deepEqual(jobOf(whole)!.shard, { index: 2, of: 3 });
  for (const bad of [{ index: 0, of: 3 }, { index: 4, of: 3 }, { index: 1, of: 65 }, { index: 1.5, of: 3 }, { index: '1', of: 3 }, 'all']) {
    assert.equal(jobOf({ ...whole, shard: bad }), null, JSON.stringify(bad));
  }
  assert.equal(jobOf({ ...whole, kind: 'pr-check' }), null, 'only a whole suite has shards');
  assert.deepEqual(shardOf({ index: 64, of: 64, extra: 1 }), { index: 64, of: 64 });
});

test('a kit trial: handed to a worker with its kit and its agent, which only a kit trial names', () => {
  const trial = { id: 'b6', kind: 'kit-trial', repo: 'Jcollier0120/Reeve', commit: 'c'.repeat(40), lane: 'background', what: 'x', kit: '2.78.16-1a2b3c4d5e6f', agent: 'reeve' };
  const job = jobOf(trial)!;
  assert.deepEqual([job.kit, job.agent], ['2.78.16-1a2b3c4d5e6f', 'reeve']);
  assert.equal(jobOf({ ...trial, kit: '2.78.16' })!.kit, '2.78.16', 'a released kit, by its version');
  for (const bad of [{ kit: undefined }, { agent: undefined }, { kit: '2.78' }, { kit: '2.78.16-1A2B3C4D5E6F' }, { kit: '2.78.16-1a2b3c' }, { kit: '2.78.16-../x' }, { kit: 2 }, { agent: 'Reeve' }, { agent: '../reeve' }, { agent: '-x' }]) {
    assert.equal(jobOf({ ...trial, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(jobOf({ ...trial, kind: 'pr-check' }), null, 'a PR check with a kit would run something else than it says');
  assert.equal(jobOf({ ...trial, kind: 'pr-check', kit: undefined }), null, 'nor with an agent');
  assert.equal(jobOf(trial, ['pr-check', 'full-suite']), null, "a kit trial, to a worker that doesn't run them");
});

test('the other PCs whose workers run a kind for a repository, as the Seneschal last read them; none while it shares no work', async () => {
  const sibling = (name: string, works: unknown) => ({ id: `pc-${name}`, name, offers: 0, works, room: null, problem: null });
  const siblings = [
    sibling('LAPTOP', { kinds: ['pr-check', 'full-suite'], repos: ['jcollier0120/steward'] }),
    sibling('STUDIO', { kinds: ['full-suite'], repos: null }),
    sibling('DESK', { kinds: ['pr-check'], repos: null }),
    sibling('OLD', null),
    sibling('ELSE', { kinds: ['full-suite'], repos: ['Jcollier0120/Reeve'] }),
  ];
  routes['/api/tasks'] = () => ({ json: { counts: {}, siblings: { on: true, self: null, siblings, borrowed: [], wants: [] } } });
  const ask = { kind: 'full-suite' as const, repo: 'Jcollier0120/Steward', at: at(), env: {} };
  assert.deepEqual(await seneschalSiblings(ask), [{ id: 'pc-LAPTOP', name: 'LAPTOP' }, { id: 'pc-STUDIO', name: 'STUDIO' }]);
  routes['/api/tasks'] = () => ({ json: { counts: {}, siblings: { on: false, self: null, siblings, borrowed: [], wants: [] } } });
  assert.deepEqual(await seneschalSiblings(ask), [], 'Other PCs off: none takes a share');
  routes['/api/tasks'] = () => ({ json: { counts: {}, siblings: null } });
  assert.deepEqual(await seneschalSiblings(ask), [], 'a Seneschal before 0.2.0');
  routes['/api/tasks'] = () => ({ status: 500, json: {} });
  assert.equal(await seneschalSiblings(ask), null);
  assert.equal(await seneschalSiblings({ ...ask, at: null }), null, 'no Seneschal');
  assert.equal(await seneschalSiblings({ ...ask, env: { KIT_CHECKS_TURN: '1' } }), null, "inside another's turn");
});

// The Wright's jobs and Reeve's heavy work (Seneschal 0.3.0, kit 2.80.0): turns only their asker can run, named by job.
const wrightJob = { kind: 'wright-job' as const, repo: 'Jcollier0120/Reeve', job: '#212', lane: 'background' as const, needs: { clone: true, memoryMb: 2048, line: 'claude-code' as const }, tries: 1, what: "the Wright's job #212 in Reeve", by: 'wright' };
const reeveFill = { kind: 'reeve-job' as const, repo: 'Jcollier0120/Heiward', job: 'index:Heiward:1a2b3c4d:embed', lane: 'background' as const, needs: { light: true, accelerator: 'npu', memoryMb: 512 }, tries: 2, by: 'reeve' };
const noRoom = { json: { task: null, why: 'no room: 3 tasks running', state: 'waiting' } };

test("the Wright's and Reeve's work on the wire: its job, what it needs and its tries, and no commit", async () => {
  routes['/api/tasks/submit'] = () => ({ status: 201, json: waitingTask() });
  routes['/api/tasks/lease'] = () => ({ json: leased });
  for (const t of [wrightJob, reeveFill]) {
    asked.length = 0;
    const a = await seneschalTurn(t, { ...quick, worker: t.by, defer: true });
    assert.ok(a && 'turn' in a);
    assert.deepEqual(asked[0], { route: '/api/tasks/submit', body: t });
    assert.ok(!('commit' in asked[0].body), 'a turn kind names no code');
    assert.deepEqual(asked[1].body, { worker: t.by, id: 't7' });
  }
});

test("defer: a turn that doesn't come in its wait answers later, with why it waits; without defer, run as before", async () => {
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => noRoom;
  lines.length = 0;
  assert.deepEqual(await seneschalTurn(wrightJob, { ...quick, ...minutes(), waitMs: 5 * 60_000, defer: true, say }), { later: 'no room: 3 tasks running', id: 't7' });
  assert.match(lines.at(-1)!, /its turn didn't come in 5 minutes \(no room: 3 tasks running\): it asks again later/);
  assert.ok(!asked.some((x) => x.route === '/api/tasks/report'), 'nothing reported: the task just waits');
  lines.length = 0;
  assert.equal(await seneschalTurn(wrightJob, { ...quick, ...minutes(), waitMs: 5 * 60_000, say }), null);
  assert.match(lines.at(-1)!, /: run as before$/);
  // A short wait, said in seconds.
  lines.length = 0;
  assert.deepEqual(await seneschalTurn(reeveFill, { ...quick, ...minutes(), waitMs: 45_000, defer: true, say }), { later: 'no room: 3 tasks running', id: 't7' });
  assert.match(lines.at(-1)!, /didn't come in 45 seconds/);
});

test("defer: its wait counts the time another run of the same work holds it, so it doesn't wait behind that run", async () => {
  const otherRun = { json: { task: null, why: "it runs now, in reeve's other run", state: 'leased' } };
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = () => otherRun;
  assert.deepEqual(await seneschalTurn(reeveFill, { ...quick, ...minutes(), waitMs: 3 * 60_000, defer: true }), { later: "it runs now, in reeve's other run", id: 't7' });
  const asks = asked.filter((x) => x.route === '/api/tasks/lease').length;
  assert.ok(asks <= 4, `asked ${asks} times in its 3 minutes`);
  // Done by that run while it asked: a Reeve job that finished stands in.
  const pass = { ok: true, at: '2026-10-17T12:00:00Z', by: 'reeve', ms: 300_000 };
  routes['/api/tasks/lease'] = (_b, n) => (n <= 2 ? otherRun : { json: { task: null, why: 'it passed', state: 'done', result: pass } });
  asked.length = 0;
  assert.deepEqual(await seneschalTurn(reeveFill, { ...quick, ...minutes(), waitMs: 10 * 60_000, defer: true }), { reused: pass, id: 't7' });
});

test("defer: never later where the Seneschal isn't there, is off duty, refuses the task, or didn't answer its last ask", async () => {
  const deferring = { ...quick, ...minutes(), waitMs: 2 * 60_000, defer: true };
  assert.equal(await seneschalTurn(wrightJob, { ...deferring, at: null }), null, 'no Seneschal');
  routes['/api/tasks/submit'] = () => ({ json: { task: null, why: 'the Seneschal is off duty: it hands out no work, so run it as before', asBefore: true } });
  assert.equal(await seneschalTurn(wrightJob, deferring), null, 'off duty');
  routes['/api/tasks/submit'] = () => ({ status: 400, json: { error: '"job" names the job' } });
  assert.equal(await seneschalTurn(wrightJob, deferring), null, 'refused');
  // It answered, then not at the ask when the wait ran out.
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  routes['/api/tasks/lease'] = (_b, n) => (n < 3 ? noRoom : { status: 503, json: {} });
  lines.length = 0;
  assert.equal(await seneschalTurn(wrightJob, { ...quick, ...minutes(), waitMs: 2 * 60_000, defer: true, say }), null);
  assert.match(lines.at(-1)!, /its turn didn't come in 2 minutes .*: run as before$/);
  // It stopped answering altogether.
  asked.length = 0;
  routes['/api/tasks/lease'] = (_b, n) => (n === 1 ? noRoom : { status: 503, json: {} });
  lines.length = 0;
  assert.equal(await seneschalTurn(wrightJob, { ...quick, waitMs: 60 * 60_000, defer: true, say }), null);
  assert.match(lines.at(-1)!, /stopped answering: run as before/);
});

test("a Wright's job is never skipped for a run that finished, nor for a failure: it runs as before, saying why", async () => {
  const pass = { ok: true, at: '2026-10-16T12:00:00Z', by: 'wright', ms: 1_200_000 };
  const fail = { ok: false, at: '2026-10-16T12:00:00Z', by: 'wright', ms: 1000, note: 'stuck', confirmed: { on: 'DESKTOP' } };
  // Handed back done when it's asked (an older Seneschal's key, for a caller that sent a commit).
  routes['/api/tasks/submit'] = () => ({ json: { task: { id: 't3', state: 'done', result: pass }, existing: true, reused: true } });
  lines.length = 0;
  assert.equal(await seneschalTurn({ ...wrightJob, commit: 'c'.repeat(40) }, { ...quick, say }), null);
  assert.match(lines[0], /handed back a run of the Wright's #212 that finished \(t3\), which never stands in for another: run as before/);
  // Done, or failed on two PCs, while it waited.
  routes['/api/tasks/submit'] = () => ({ json: waitingTask() });
  for (const result of [pass, fail]) {
    routes['/api/tasks/lease'] = () => ({ json: { task: null, why: 'it ended', state: 'done', result } });
    assert.equal(await seneschalTurn(wrightJob, { ...quick, defer: true }), null, JSON.stringify(result));
  }
  // A Reeve job that finished does stand in: another Reeve process just did that work.
  routes['/api/tasks/lease'] = () => ({ json: { task: null, why: 'it ended', state: 'done', result: pass } });
  assert.deepEqual(await seneschalTurn(reeveFill, quick), { reused: pass, id: 't7' });
});

test("an older Seneschal (0.2.x) refuses a Reeve job's kind, and a Wright job with no commit: run as before, deferring or not", async () => {
  // Seneschal 0.2.x's parseSubmission.
  routes['/api/tasks/submit'] = (b) =>
    !['pr-check', 'kit-trial', 'full-suite', 'wright-job'].includes(b.kind)
      ? { status: 400, json: { error: '"kind" is one of pr-check, kit-trial, full-suite, wright-job' } }
      : !/^[0-9a-f]{40}$/.test(String(b.commit ?? ''))
        ? { status: 400, json: { error: "\"commit\" is the exact commit (git's full id)" } }
        : { json: waitingTask() };
  routes['/api/tasks/lease'] = () => noRoom;
  for (const t of [reeveFill, wrightJob]) {
    for (const defer of [false, true]) {
      lines.length = 0;
      assert.equal(await seneschalTurn(t, { ...quick, ...minutes(), waitMs: 2 * 60_000, defer, say }), null, `${t.kind}, defer ${defer}`);
      assert.match(lines[0], /refused the task: "(kind|commit)" is .*: run as before/);
    }
  }
  assert.ok(!asked.some((x) => x.route === '/api/tasks/lease'), 'never waited for a turn it refused');
});

test("a worker is never handed the Wright's or Reeve's work unless it names their kinds", () => {
  const base = { id: 'b4', repo: 'Jcollier0120/Reeve', commit: 'c'.repeat(40), lane: 'normal', what: 'x' };
  assert.equal(jobOf({ ...base, kind: 'wright-job', job: '#212' }), null);
  assert.equal(jobOf({ ...base, kind: 'reeve-job', job: 'repo-sync' }), null);
  assert.ok(jobOf({ ...base, kind: 'pr-check' }), 'a check, by default');
  assert.ok(jobOf({ ...base, kind: 'full-suite' }));
  assert.ok(jobOf({ ...base, kind: 'kit-trial', kit: '2.79.0', agent: 'reeve' }));
});

const { patchOf, remoteOf, SENESCHAL_MOST_PATCH } = await import('./fixture/src/kit/seneschal.ts');

test("a repository's own checks (checks): handed only to a worker that names the kind, with where its code is got from and the tools it needs", () => {
  const checks = { id: 'b8', kind: 'checks', repo: 'acme/shop', commit: 'c'.repeat(40), branch: 'feature/cart', remote: 'https://git.example.com/acme/shop.git', needs: { tools: ['npm', 'node'] }, lane: 'person', what: "acme/shop's checks", from: { pc: { id: 'pc-a', name: 'LAPTOP' }, id: 't3' } };
  assert.equal(jobOf(checks), null, "a worker that doesn't say gets the Steward's checks alone");
  const job = jobOf(checks, ['checks'])!;
  assert.deepEqual([job.kind, job.remote, job.tools, job.branch, job.from?.pc.name], ['checks', 'https://git.example.com/acme/shop.git', ['node', 'npm'], 'feature/cart', 'LAPTOP']);
  assert.equal(jobOf({ ...checks, needs: { tools: ['node', 'rm -rf'] } }, ['checks']), null, 'a tool off the list');
  assert.equal(jobOf({ ...checks, needs: { tools: 'node' } }, ['checks']), null);
  assert.equal(jobOf({ ...checks, remote: 'C:\\Projects\\shop' }, ['checks']), null, 'never a path on a PC');
  assert.equal(jobOf({ ...checks, remote: undefined }, ['checks'])!.remote, undefined, 'with no remote, only a PC with a clone runs it');
});

test('a remote a worker clones from: https, ssh, git or scp-like, with no sign-in in it; never a path, an option or another transport', () => {
  for (const ok of ['https://github.com/acme/shop.git', 'http://git.local/acme/shop', 'ssh://git@git.example.com:2222/acme/shop.git', 'git://example.com/shop', 'git@gitlab.com:acme/shop.git', 'https://dev.azure.com/acme/Shop/_git/shop', 'https://bitbucket.org/acme/shop'])
    assert.equal(remoteOf(ok), ok, ok);
  for (const bad of ['C:\\Projects\\shop','/home/me/shop', 'file:///C:/shop', '../shop', 'ext::sh -c x', '--upload-pack=x', 'https://me:token@github.com/acme/shop', 'https://token@github.com/acme/shop', 'https://github.com/acme/../../x', 'https://github.com/acme/shop x', 'git@host:/etc/passwd', 'https://-x/acme', 'ssh://git@host:99999/x', 12, null])
    assert.equal(remoteOf(bad), null, String(bad));
});

test('a patch on its commit: only on a checks task, only to a worker that applies patches, and checked against its hash and size', () => {
  const lease = (text: string) => ({ sha256: createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text, 'utf8'), text });
  const text = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+néw\n';
  const patch = lease(text);
  const checks = { id: 'b9', kind: 'checks', repo: 'acme/shop', commit: 'c'.repeat(40), remote: 'https://git.example.com/acme/shop.git', patch, lane: 'person', what: 'x' };
  assert.equal(jobOf(checks, ['checks']), null, "a worker that doesn't apply patches would run other code than the task names");
  assert.deepEqual(jobOf(checks, ['checks'], { patches: true })!.patch, patch);
  assert.equal(jobOf({ ...checks, kind: 'pr-check' }, ['pr-check', 'checks'], { patches: true }), null, "only a repository's own checks carry one");
  const big = `diff --git a/x b/x\n${'+'.repeat(SENESCHAL_MOST_PATCH)}\n`;
  for (const bad of [{ ...patch, sha256: 'b'.repeat(64) }, { ...patch, bytes: patch.bytes - 1 }, { ...patch, text: `${text}+more\n` }, lease('not a diff\n'), lease(`${text}\0`), lease(big), { sha256: patch.sha256, bytes: patch.bytes }, text])
    assert.equal(jobOf({ ...checks, patch: bad }, ['checks'], { patches: true }), null, JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(patchOf({ ...patch, extra: 1 }), patch);
});

test('a worker that gets the code itself asks with clones (and patches), naming no repository; one that names none and no clones asks nothing', async () => {
  routes['/api/tasks/lease'] = () => ({ json: { task: null, why: 'nothing waits', retryMs: 4000 } });
  assert.deepEqual(await seneschalWork({ worker: 'assayer', kinds: ['checks'], repos: [], clones: true, patches: true, at: at(), env: {} }), { idle: 'nothing waits', retryMs: 4000 });
  assert.deepEqual(asked[0].body, { worker: 'assayer', kinds: ['checks'], clones: true, patches: true });
  asked.length = 0;
  assert.deepEqual(await seneschalWork({ worker: 'assayer', kinds: ['checks'], repos: [], at: at(), env: {} }), { idle: 'it runs no repository now', retryMs: 30_000 });
  assert.equal(asked.length, 0);
});

test('a run reports what getting the code ready took (prepMs), as part of its time: never more of it, nor less than none', async () => {
  routes['/api/tasks/submit'] = () => ({ status: 201, json: waitingTask() });
  routes['/api/tasks/lease'] = () => ({ json: leased });
  routes['/api/tasks/heartbeat'] = () => ({ json: { ok: true, until: '' } });
  routes['/api/tasks/report'] = () => ({ json: { task: { id: 't7', state: 'done' } } });
  for (const [prepMs, want] of [[1.4, 1], [-5, 0], [10 * 60_000, null], [Number.NaN, undefined]] as const) {
    asked.length = 0;
    let t = 0;
    const a = await seneschalTurn({ ...task, kind: 'checks', remote: 'https://git.example.com/acme/shop.git', needs: { tools: ['node'] } }, { ...quick, now: () => (t += 5_000) });
    assert.ok(a && 'turn' in a);
    assert.deepEqual(asked[0].body.remote, 'https://git.example.com/acme/shop.git');
    await a.turn.hold(async () => true, () => ({ ok: true, prepMs }));
    const rep = asked.find((x) => x.route === '/api/tasks/report')!.body;
    if (want === null) assert.equal(rep.prepMs, rep.ms, 'at most the whole run');
    else assert.equal(rep.prepMs, want);
  }
});
