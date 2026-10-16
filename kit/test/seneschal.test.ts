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
