import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

// The whole suite cut into shards by test file (stages/wholesuite.ts, bump.ts's shardSteps): where the Seneschal says
// another PC's Steward runs the Steward's whole suite too, each shard is a full-suite task of its own; a shard that PC ran
// comes back as its pass, the rest run here, each in a worktree of its own, and a failure runs again only where it
// failed. The Seneschal here is the test's own; the Steward repository a fake whose tests note what ran.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-shards-'));
process.env.STEWARD_HOME = home;
process.env.MANOR_HOME = path.join(home, 'no-manor');
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
const seneschalHome = path.join(home, 'seneschal');
process.env.SENESCHAL_HOME = seneschalHome;
delete process.env.KIT_CHECKS_TURN;
after(() => rmSync(home, { recursive: true, force: true }));

const { dealt, shardSteps, wholeTestFiles } = await import('../src/stages/bump.ts');
const { checksTask } = await import('../src/stages/seneschal.ts');
const { FILES_PER_SHARD, shardDirOf, shardsFor, wholeDirOf, wholeSuiteBefore } = await import('../src/stages/wholesuite.ts');
const { stewardEmployee } = await import('../src/stages/selfmerge.ts');
const { resetResults } = await import('../src/kit/work-status.ts');
const { ctxFor, employee, runner, sh } = await import('./helpers.ts');

const ran = path.join(home, 'ran.txt');
const failTests = path.join(home, 'fail-tests');
const lines = () => (existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n').map((l) => l.trim()) : []);
const note = (what: string, fail?: string) =>
  `const fs = require('fs');\nfs.appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(what)} + '\\n');\n${fail ? `if (fs.existsSync(${JSON.stringify(fail)})) process.exit(1);\n` : ''}`;

/** A Steward-like repository: `count` test files (test/a01.test.js on), the first failing while failTests is there. */
function files(count: number, scripts: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {
    '.gitignore': 'node_modules/\nsrc/kit/\n',
    'kit/VERSION': '1.1.0\n',
    'package.json': JSON.stringify({ name: 'steward', version: '0.9.0', scripts: { kit: 'node tools/kit.js', typecheck: 'node tools/typecheck.js', test: 'node --test "test/*.test.js"', posttest: 'node tools/post.js', ...scripts } }, null, 2),
    'tools/kit.js': note('fill'),
    'tools/typecheck.js': note('typecheck'),
    'tools/post.js': note('posttest'),
    'README.md': 'not a test\n',
  };
  for (let i = 1; i <= count; i++) {
    const name = `a${String(i).padStart(2, '0')}`;
    out[`test/${name}.test.js`] = note(`test ${name}`, i === 1 ? failTests : undefined);
  }
  return out;
}
const write = (dir: string, f: Record<string, string>) => {
  for (const [p, t] of Object.entries(f)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), t);
  }
};

test('a shard takes its turn of the test files by name, dealt out; its pretest in each, its posttest in the last', () => {
  const dir = mkdtempSync(path.join(home, 'deal-'));
  write(dir, files(5, { pretest: 'node tools/kit.js' }));
  const t = wholeTestFiles(dir)!;
  assert.deepEqual(t.files, ['test/a01.test.js', 'test/a02.test.js', 'test/a03.test.js', 'test/a04.test.js', 'test/a05.test.js']);
  assert.deepEqual(dealt(t.files, { index: 2, of: 2 }), ['test/a02.test.js', 'test/a04.test.js']);
  assert.deepEqual(shardSteps(dir, { index: 1, of: 2 }), ['npm run pretest', 'node --test "test/a01.test.js" "test/a03.test.js" "test/a05.test.js"']);
  assert.deepEqual(shardSteps(dir, { index: 2, of: 2 }), ['npm run pretest', 'node --test "test/a02.test.js" "test/a04.test.js"', 'npm run posttest']);
  assert.deepEqual(shardSteps(dir, { index: 7, of: 7 }), ['npm run pretest', 'npm run posttest'], 'more shards than files: nothing of its own to test');
  write(dir, { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
  assert.equal(wholeTestFiles(dir), null);
  assert.deepEqual(shardSteps(dir, { index: 2, of: 2 }), ['npm test'], "a script that isn't a plain node --test: the whole suite, more than asked, never less");
});

test('cut for this PC and each other PC whose Steward runs the whole suite, four at most, with enough test files each; not cut without them', async () => {
  const dir = mkdtempSync(path.join(home, 'cut-'));
  write(dir, files(FILES_PER_SHARD * 3));
  const e = employee(dir, { repo: 'Jcollier0120/Steward', test: ['npm run typecheck', 'npm test'] });
  const pcs = (n: number) => async () => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `PC${i}` }));
  const said: string[] = [];
  assert.equal(await shardsFor(e, dir, (l) => said.push(l), pcs(1)), 2);
  assert.match(said[0], /^its whole suite cut into 2 shards of its 30 test files, for this PC and PC0: each runs where there's room first$/);
  assert.equal(await shardsFor(e, dir, () => {}, pcs(5)), 3, 'as many as its test files allow');
  write(dir, files(FILES_PER_SHARD * 6));
  assert.equal(await shardsFor(e, dir, () => {}, pcs(5)), 4, 'four at most');
  assert.equal(await shardsFor(e, dir, () => {}, pcs(0)), 1, 'no other PC runs it');
  assert.equal(await shardsFor(e, dir, () => {}, async () => null), 1, 'no Seneschal');
  assert.equal(await shardsFor({ ...e, test: ['node check.mjs'] }, dir, () => {}, pcs(1)), 1, 'no npm test to cut');
});

// The fake Steward repository the whole suite runs from, its origin, and the Seneschal's page.
const dir = path.join(home, 'steward');
const origin = path.join(dir, 'origin.git');
const checkout = path.join(dir, 'Steward');
const URL = 'https://github.com/Jcollier0120/Steward.git';
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
sh(dir, 'init', '--quiet', '-b', 'main', checkout);
for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false', [`url.${origin.replace(/\\/g, '/')}.insteadOf`]: URL })) sh(checkout, 'config', k, v);
sh(checkout, 'remote', 'add', 'origin', URL);
write(checkout, files(FILES_PER_SHARD * 2));
sh(checkout, 'add', '-A');
sh(checkout, 'commit', '--quiet', '-m', 'Steward 0.9.0, kit 1.1.0');
sh(checkout, 'push', '--quiet', 'origin', 'main');
const head = sh(origin, 'rev-parse', 'main');
const r = runner();
// Its tests' own node --test, not taken for one of this test's (which it would be with NODE_TEST_CONTEXT, running nothing).
const run: typeof r.run = (cmd, args, opts = {}) => r.run(cmd, args, { ...opts, env: { ...opts.env, NODE_TEST_CONTEXT: undefined } });
const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run, neutralDir: home });
const e = stewardEmployee(ctx.settings, checkout);

const TOKEN = 'c'.repeat(48);
const LAPTOP = { id: 'pc-laptop', name: 'LAPTOP' };
type Route = (body: any) => { status?: number; json: unknown };
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
      const got = routes[req.url ?? '']?.(body);
      res.writeHead(got?.status ?? (got ? 200 : 404), { 'content-type': 'application/json' }).end(JSON.stringify(got?.json ?? { error: 'no such route' }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  mkdirSync(seneschalHome, { recursive: true });
  writeFileSync(path.join(seneschalHome, 'server.json'), JSON.stringify({ pid: 1, port: (server.address() as { port: number }).port, token: TOKEN }));
});
after(() => new Promise<void>((done) => server.close(() => done())));
beforeEach(() => {
  asked.length = 0;
  rmSync(ran, { force: true });
  resetResults();
  // LAPTOP's Steward runs the Steward's whole suite; each shard is its own task (t1, t2), and LAPTOP ran shard 2 already.
  routes = {
    '/api/tasks': () => ({ json: { siblings: { on: true, self: null, siblings: [{ id: LAPTOP.id, name: LAPTOP.name, offers: 0, works: { kinds: ['full-suite'], repos: ['Jcollier0120/Steward'] }, room: null, problem: null }], borrowed: [], wants: [] } } }),
    '/api/tasks/submit': (b) => ({ status: 201, json: { task: { id: `t${b.shard?.index ?? 0}`, state: 'waiting' }, existing: false, reused: false } }),
    '/api/tasks/lease': (b) =>
      b.id === 't2'
        ? { json: { task: null, why: 'it passed', state: 'done', result: { ok: true, at: '2026-10-17T01:00:00.000Z', by: 'steward on LAPTOP', ms: 9000, commands: e.test, pc: LAPTOP } } }
        : { json: { task: { id: b.id, state: 'leased' }, lease: { token: 'd'.repeat(24), until: '', heartbeatMs: 15_000 }, usualMs: 60_000 } },
    '/api/tasks/heartbeat': () => ({ json: {} }),
    '/api/tasks/report': (b) => ({ json: { task: { id: b.id, state: 'done' } } }),
  };
});

const submitted = () => asked.filter((a) => a.route === '/api/tasks/submit').map((a) => a.body);
const firstShard = Array.from({ length: FILES_PER_SHARD * 2 }, (_, i) => `test a${String(i + 1).padStart(2, '0')}`).filter((_, i) => i % 2 === 0);

test('the task names its shard, only for a whole suite', async () => {
  const tree = sh(checkout, 'rev-parse', 'HEAD^{tree}');
  const t = await checksTask(ctx, e, checkout, { commit: head, tree, clean: true, task: { kind: 'full-suite', lane: 'blocking' }, shard: { index: 2, of: 3 } });
  assert.deepEqual((t as { shard?: unknown }).shard, { index: 2, of: 3 });
  assert.deepEqual(await checksTask(ctx, e, checkout, { commit: head, tree, clean: true, shard: { index: 2, of: 3 } }), { not: 'only a whole suite is cut into shards' });
});

test("with another PC's Steward running it too, the whole suite is cut in two: the shard that PC ran stands, and only the other runs here", async () => {
  assert.equal(await wholeSuiteBefore(ctx, checkout, { tag: 'kit-v1.1.0', commit: head }), null);
  assert.deepEqual(
    submitted()
      .sort((a, b) => a.shard.index - b.shard.index)
      .map((b) => [b.kind, b.lane, b.shard]),
    [
      ['full-suite', 'blocking', { index: 1, of: 2 }],
      ['full-suite', 'blocking', { index: 2, of: 2 }],
    ],
  );
  // Its test files run at once, in no order.
  assert.deepEqual([...lines().slice(0, 2), ...lines().slice(2).sort()], ['fill', 'typecheck', ...firstShard], `shard 1: the typecheck and its test files; shard 2's, and the posttest after them, were LAPTOP's\n${ctx.lines.join('\n')}`);
  const rep = asked.find((a) => a.route === '/api/tasks/report')!.body;
  assert.deepEqual([rep.id, rep.ok, rep.commands], ['t1', true, e.test]);
  assert.ok(ctx.lines.some((l) => /kit-v1\.1\.0: the whole suite passed at [0-9a-f]{7}, cut into 2 shards \(shard 2 of 2 on LAPTOP\)/.test(l)), ctx.lines.join('\n'));
  assert.ok(!existsSync(wholeDirOf(ctx)) && !existsSync(shardDirOf(wholeDirOf(ctx), 2)), 'its worktrees removed');
});

test('a shard that fails runs once more, alone, and failing again holds the kit, saying which shard', async () => {
  writeFileSync(failTests, '');
  try {
    const hold = await wholeSuiteBefore(ctx, checkout, { tag: 'kit-v1.1.0', commit: head });
    assert.equal(hold?.retry, false);
    assert.match(hold!.why, /^its whole suite failed at [0-9a-f]{7}, cut into 2 shards \(shard 2 of 2 on LAPTOP\): shard 1 of 2: node --test .* failed \(exit 1\).*, twice$/s);
  } finally {
    unlinkSync(failTests);
  }
  assert.deepEqual(submitted().map((b) => b.shard.index).sort(), [1, 1, 2], 'only the shard that failed, again');
  assert.equal(lines().filter((l) => l === 'test a01').length, 2);
  assert.ok(!lines().includes('posttest'));
});
