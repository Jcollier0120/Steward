import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

// The Steward's checks as the Seneschal's tasks (stages/seneschal.ts, runChecks in bump.ts): each run waits its turn in
// the Seneschal's order and runs under its lease without a turn of the checks pace, a pass of exactly these checks it
// holds stands in, and with no Seneschal, or one off duty, they run as before. The Seneschal here is the test's own.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-seneschal-'));
process.env.STEWARD_HOME = home;
process.env.MANOR_HOME = path.join(home, 'no-manor');
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
const seneschalHome = path.join(home, 'seneschal');
process.env.SENESCHAL_HOME = seneschalHome;
// The Assayer runs these tests inside a turn of its own (KIT_CHECKS_TURN), and the Seneschal is then never asked.
delete process.env.KIT_CHECKS_TURN;
after(() => rmSync(home, { recursive: true, force: true }));

const { runChecks } = await import('../src/stages/bump.ts');
const { checksTask, kitIdOf, laneHere, urgentOf, withLane } = await import('../src/stages/seneschal.ts');
const { resetResults } = await import('../src/kit/work-status.ts');
const { ctxFor, employee, runner, sh } = await import('./helpers.ts');
type StoodIn = import('../src/stages/standin.ts').StoodIn;

const git = (dir: string, ...args: string[]) => sh(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args);

/** A repository whose one check writes down whether it ran inside a turn (KIT_CHECKS_TURN), each time it runs. */
function repo(): string {
  const dir = mkdtempSync(path.join(home, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'check.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync('ran.txt', (process.env.KIT_CHECKS_TURN ?? 'none') + '\\n');\nprocess.exit(process.env.FAIL_CHECK ? 1 : 0);\n");
  writeFileSync(path.join(dir, '.gitignore'), 'ran.txt\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}
const ran = (dir: string) => (existsSync(path.join(dir, 'ran.txt')) ? readFileSync(path.join(dir, 'ran.txt'), 'utf8').trim().split('\n') : []);

const { run } = runner();
const dir = repo();
const head = sh(dir, 'rev-parse', 'HEAD');
const tree = sh(dir, 'rev-parse', 'HEAD^{tree}');
const e = employee(dir, { fill: '', test: ['node check.mjs'] });
const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run, neutralDir: home });

// The Seneschal: a page on a free port, its server.json in its data folder, answering as each test says.
const TOKEN = 'c'.repeat(48);
type Route = (body: any, n: number) => { status?: number; json: unknown };
let routes: Record<string, Route> = {};
const asked: { route: string; body: any }[] = [];
let server: http.Server;
before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.headers['x-token'] !== TOKEN) return void res.writeHead(403).end('{}');
      const body = raw ? JSON.parse(raw) : null;
      asked.push({ route: req.url ?? '', body });
      const r = routes[req.url ?? '']?.(body, asked.filter((a) => a.route === req.url).length);
      res.writeHead(r?.status ?? (r ? 200 : 404), { 'content-type': 'application/json' }).end(JSON.stringify(r?.json ?? { error: 'no such route' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mkdirSync(seneschalHome, { recursive: true });
  writeFileSync(path.join(seneschalHome, 'server.json'), JSON.stringify({ pid: 1, port: (server.address() as { port: number }).port, token: TOKEN }));
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  routes = {};
  asked.length = 0;
  rmSync(path.join(dir, 'ran.txt'), { force: true });
  // A pass kept here would stand in before the Seneschal is asked (standin.ts): each test starts with none.
  resetResults();
});

const leaseNow = (id = 't1') => {
  routes['/api/tasks/submit'] = () => ({ status: 201, json: { task: { id, state: 'waiting' }, existing: false, reused: false } });
  routes['/api/tasks/lease'] = () => ({ json: { task: { id, state: 'leased' }, lease: { token: 'd'.repeat(24), until: '', heartbeatMs: 15_000 }, usualMs: 60_000 } });
  routes['/api/tasks/report'] = () => ({ json: { task: { id, state: 'done' } } });
};
const reportOf = () => asked.find((a) => a.route === '/api/tasks/report')?.body;

test('the task: a PR check of this code by its tree, with its PR and branch, in the normal lane; asked by the Steward', async () => {
  const t = await checksTask(ctx, e, dir, { commit: head, tree, clean: true, task: { pr: 212, branch: 'claude/x' } });
  assert.deepEqual(t, { kind: 'pr-check', repo: 'Jcollier0120/Fake', commit: head, tree, pr: 212, branch: 'claude/x', lane: 'normal', by: 'steward' });
  const affected = await checksTask(ctx, e, dir, { commit: head, tree, clean: true, affected: { base: 'HEAD' } });
  assert.equal((affected as { base?: string }).base, head, 'only the tests a change reaches: the commit they are picked against');
  const whole = await checksTask(ctx, e, dir, { commit: head, tree, clean: true, task: { kind: 'full-suite', lane: 'blocking' } });
  assert.deepEqual([(whole as { kind: string }).kind, (whole as { lane: string }).lane], ['full-suite', 'blocking']);
});

test("not asked: a run whose point is this PC, one with settings of its own, uncommitted code, an unknown commit, or told not to", async () => {
  const base = { commit: head, tree, clean: true };
  assert.match((await checksTask(ctx, e, dir, { ...base, here: true }) as { not: string }).not, /runs on this PC/);
  assert.match((await checksTask(ctx, e, dir, { ...base, env: { FOO: '1' } }) as { not: string }).not, /settings of its own/);
  assert.match((await checksTask(ctx, e, dir, { ...base, clean: false }) as { not: string }).not, /uncommitted/);
  assert.match((await checksTask(ctx, e, dir, { clean: true }) as { not: string }).not, /commit is unknown/);
  assert.match((await checksTask(ctx, e, dir, { ...base, task: false }) as { not: string }).not, /not asked/);
  assert.match((await checksTask(ctx, e, dir, { ...base, affected: { base: 'origin/nowhere' } }) as { not: string }).not, /origin\/nowhere couldn't be read/);
});

test("a kit trial: named by the agent's commit and the kit's own (its version and the Steward commit it comes from), never its tree", async () => {
  const steward = mkdtempSync(path.join(home, 'steward-'));
  git(steward, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(steward, 'kit'));
  writeFileSync(path.join(steward, 'kit', 'VERSION'), '2.78.1\r\n');
  git(steward, 'add', '.');
  git(steward, 'commit', '-qm', 'kit');
  const kitCommit = sh(steward, 'rev-parse', 'HEAD');
  const kitDir = path.join(steward, 'kit');
  assert.equal(await kitIdOf(ctx, kitDir), `2.78.1-${kitCommit.slice(0, 12)}`);
  const t = await checksTask(ctx, e, dir, { commit: head, tree, clean: false, env: { STEWARD_KIT: kitDir }, task: { kind: 'kit-trial' } });
  assert.deepEqual(t, { kind: 'kit-trial', repo: 'Jcollier0120/Fake', commit: head, kit: `2.78.1-${kitCommit.slice(0, 12)}`, agent: 'fake', lane: 'background', by: 'steward' });
  assert.equal(await kitIdOf(ctx, path.join(home, 'no-kit')), null);
});

test('the lane: the run\'s own, or the code around it, whichever is the more urgent', async () => {
  assert.equal(laneHere(), undefined);
  assert.equal(urgentOf('blocking', 'normal'), 'blocking');
  assert.equal(urgentOf(undefined, 'background'), 'background');
  const base = { commit: head, tree, clean: true };
  const lane = async (o: object = {}) => ((await checksTask(ctx, e, dir, { ...base, ...o })) as { lane: string }).lane;
  assert.equal(await withLane('blocking', () => lane()), 'blocking', 'a merge waits on it');
  assert.equal(await withLane('person', () => withLane('blocking', () => lane())), 'person', 'a merge in a round a person started');
  assert.equal(await withLane('blocking', () => lane({ task: { lane: 'person' } })), 'person', 'a vouch');
  assert.ok('not' in (await checksTask(ctx, e, dir, { ...base, env: { STEWARD_KIT: path.join(home, 'none') } })), "a kit that can't be named isn't asked");
});

test('its turn: the checks run under the lease without a turn of the checks pace, and the result goes back with the commands', async () => {
  leaseNow();
  const said: string[] = [];
  const failed = await runChecks(ctx, e, dir, { say: (l) => said.push(l), task: { pr: 212 } });
  assert.equal(failed, null);
  assert.deepEqual(ran(dir), ['1'], 'KIT_CHECKS_TURN set for its commands: the lease is its turn');
  assert.deepEqual(asked[0], { route: '/api/tasks/submit', body: { kind: 'pr-check', repo: 'Jcollier0120/Fake', commit: head, tree, pr: 212, lane: 'normal', by: 'steward' } });
  assert.deepEqual(asked[1].body, { worker: 'steward', id: 't1' });
  const rep = reportOf();
  assert.deepEqual([rep.ok, rep.commands, rep.error], [true, ['node check.mjs'], undefined]);
  assert.ok(said.some((l) => /its turn from the Seneschal \(t1\)/.test(l)), said.join('\n'));
});

test('a failure under the lease is reported as one, with its note; the second try asks again', async () => {
  process.env.FAIL_CHECK = '1';
  try {
    leaseNow('t2');
    const f = await runChecks(ctx, e, dir, { say: () => {} });
    assert.match(f!, /node check\.mjs failed \(exit 1\)/);
    const rep = reportOf();
    assert.deepEqual([rep.id, rep.ok, rep.error], ['t2', false, undefined]);
    assert.match(rep.note, /node check\.mjs failed/);
  } finally {
    delete process.env.FAIL_CHECK;
  }
});

test('a pass of exactly these checks on this code stands in: nothing runs, and it is said as the Seneschal\'s', async () => {
  routes['/api/tasks/submit'] = () => ({ json: { task: { id: 't9', state: 'done', result: { ok: true, at: '2026-10-16T03:00:00.000Z', by: 'assayer', ms: 9000, commands: ['node check.mjs'] } }, existing: true, reused: true } });
  const stoodIn: StoodIn = {};
  const said: string[] = [];
  assert.equal(await runChecks(ctx, e, dir, { say: (l) => said.push(l), stoodIn }), null);
  assert.deepEqual(ran(dir), [], 'not run');
  assert.deepEqual([stoodIn.by, stoodIn.where, stoodIn.at], ['seneschal', "here, in the Assayer's run", '2026-10-16T03:00:00.000Z']);
  assert.ok(said.some((l) => /a pass of exactly these checks on this code, here, in the Assayer's run \(the Seneschal's t9\): not run again/.test(l)));
});

test('a pass of other checks does not stand in: they run as before, at the checks pace', async () => {
  routes['/api/tasks/submit'] = () => ({ json: { task: { id: 't9', state: 'done', result: { ok: true, at: '', by: 'assayer', ms: 9000, commands: ['npm test'] } }, existing: true, reused: true } });
  assert.equal(await runChecks(ctx, e, dir, { say: () => {} }), null);
  assert.deepEqual(ran(dir), ['none']);
});

test('the Seneschal off duty, on a PC without Developer Pro, or not there at all: they run as before', async () => {
  routes['/api/tasks/submit'] = () => ({ json: { task: null, why: 'the Seneschal is off duty: it hands out no work, so run it as before', asBefore: true } });
  assert.equal(await runChecks(ctx, e, dir, { say: () => {} }), null);
  assert.deepEqual(ran(dir), ['none']);
  rmSync(path.join(dir, 'ran.txt'));
  resetResults(); // its pass, kept here, would stand in
  const json = readFileSync(path.join(seneschalHome, 'server.json'), 'utf8');
  rmSync(path.join(seneschalHome, 'server.json'));
  try {
    assert.equal(await runChecks(ctx, e, dir, { say: () => {} }), null);
    assert.deepEqual(ran(dir), ['none']);
    assert.equal(asked.length, 1, 'nothing asked with no Seneschal');
  } finally {
    writeFileSync(path.join(seneschalHome, 'server.json'), json);
  }
});

test("a lease that runs out while the checks run: they run on, and the result is still reported", async () => {
  leaseNow();
  routes['/api/tasks/lease'] = () => ({ json: { task: { id: 't1', state: 'leased' }, lease: { token: 'd'.repeat(24), until: '', heartbeatMs: 5 }, usualMs: 60_000 } });
  routes['/api/tasks/heartbeat'] = () => ({ status: 409, json: { ok: false, gone: 'its lease ran out' } });
  const said: string[] = [];
  assert.equal(await runChecks(ctx, e, dir, { say: (l) => said.push(l) }), null);
  assert.deepEqual(ran(dir), ['1']);
  assert.ok(said.some((l) => /lease is gone \(its lease ran out\): it runs on/.test(l)), said.join('\n'));
  assert.equal(reportOf().ok, true);
});
