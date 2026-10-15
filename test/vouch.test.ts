import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A team PR its author vouched for (stages/vouch.ts): its checks ran and passed in the author's clone at its head, and
// a team member's account said so on GitHub. The Steward merges it without testing it again; anyone else's word, a
// newer failure, the Wright's PR or a head pushed since, and it is tested here as before. And `steward vouch` itself.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-vouch-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
// The Assayer's record of checks, never the person's own.
process.env.ASSAYER_HOME = path.join(tmp, 'assayer');
mkdirSync(process.env.ASSAYER_HOME, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

const { mergeOne } = await import('../src/stages/merge.ts');
const { checksOf, VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { askRoundSoon, vouch } = await import('../src/stages/vouch.ts');
const { assayerChecksFile, ASSAYED_MS, choseOf, covers, whyShort } = await import('../src/stages/assayed.ts');
const { noteVouchTime, vouchLimit, vouchTimes, vouchTimesFile } = await import('../src/stages/vouchtime.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const vouchStatus = { __typename: 'StatusContext', context: VOUCH_CONTEXT, state: 'SUCCESS' };

test("a vouch isn't a check GitHub runs: alone, a PR's checks are none; beside real ones, it changes nothing", () => {
  assert.equal(checksOf([vouchStatus]), 'none');
  assert.equal(checksOf([{ ...vouchStatus, state: 'FAILURE' }]), 'none');
  assert.equal(checksOf([vouchStatus, { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }]), 'pending');
  // Any other status is a check, as before.
  assert.equal(checksOf([{ __typename: 'StatusContext', context: 'ci/build', state: 'SUCCESS' }]), 'passing');
});

test('a team PR vouched for by a team member at its head is merged without being tested here; anything less, and it is tested', async () => {
  const f = fakeEmployee(path.join(tmp, 'merge'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/thing');
  writeFileSync(path.join(f.checkout, 'thing.txt'), 'a thing\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a thing');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${head}:refs/pull/7/head`);
  sh(f.checkout, 'switch', '--quiet', 'main');
  // Its checks here always fail: a merge proves they weren't run.
  const e = employee(f.checkout, { fill: '', test: ['node -e process.exit(1)'] });
  const listed = (o: Record<string, unknown> = {}) => [{ number: 7, title: 'a thing', url: 'https://github.com/Jcollier0120/Fake/pull/7', headRefName: 'claude/thing', headRefOid: head, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [vouchStatus], body: '', labels: [], ...o }];
  const look = async (statuses: unknown[], o: Record<string, unknown> = {}) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'list') return ok(listed(o));
      if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
      if (a[0] === 'api' && a[1] === `repos/Jcollier0120/Fake/commits/${head}/statuses?per_page=100`) return ok(statuses);
      if (a[0] === 'pr' && a[1] === 'merge') return ok('');
    });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const m = await mergeOne(ctx, e, { yes: true, team: true });
    return { m, r, lines: ctx.lines.join('\n') };
  };
  const byTeam = { context: VOUCH_CONTEXT, state: 'success', creator: { login: 'jcollier0120' } };

  const vouched = await look([byTeam, { context: 'other', state: 'failure', creator: { login: 'someone' } }]);
  assert.equal(vouched.m.outcome, 'done', vouched.m.message);
  assert.equal(vouched.m.message, `merged #7 (checks passed at ${head.slice(0, 7)} in jcollier0120's clone, vouched for)`);
  assert.doesNotMatch(vouched.lines, /testing it here/);
  assert.deepEqual(vouched.r.gh.filter((a) => a[1] === 'merge'), [['pr', 'merge', '7', '--repo', 'Jcollier0120/Fake', '--merge', '--match-head-commit', head]]);

  // Someone outside the team, a newer failure, the Wright's PR, or no answer from GitHub: tested here, and so not merged.
  for (const [why, statuses, o] of [
    ['a stranger vouched', [{ ...byTeam, creator: { login: 'stranger' } }], {}],
    ['a newer failure', [{ ...byTeam, state: 'failure' }, byTeam], {}],
    ["the Wright's", [byTeam], { headRefName: 'wright/12-thing' }],
    ['no vouch', [], {}],
  ] as const) {
    const t = await look([...statuses], { ...o });
    // Tested here (the first time; then the same commit's result, kept), so it fails, and waits.
    assert.match(t.m.message, /its checks failed here at/, why);
    assert.ok(!t.r.gh.some((a) => a[1] === 'merge'), why);
  }
});

test('steward vouch: the checks run at the PR\'s head, and only once they pass is the status set; a dirty clone, another head or a failure sets none', async () => {
  const f = fakeEmployee(path.join(tmp, 'clone'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/vouched');
  writeFileSync(path.join(f.checkout, 'v.txt'), 'v\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'v');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  // The clone of a GitHub repository, as a session's is.
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const go = (o: { test?: string; prHead?: string } = {}) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: o.prHead ?? head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const e = employee(f.checkout, { fill: '', test: [o.test ?? 'node -e process.exit(0)'] });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    return vouch(ctx, { dir: f.checkout, say: () => {} }).then((v) => ({ v, r }));
  };

  const passed = await go();
  assert.equal(passed.v.ok, true, passed.v.message);
  assert.deepEqual(passed.r.gh.find((a) => a[0] === 'pr' && a[1] === 'view')?.slice(0, 3), ['pr', 'view', 'claude/vouched'], 'the PR for its branch');
  assert.deepEqual(passed.r.gh.find((a) => a[0] === 'api'), ['api', '-X', 'POST', `repos/Jcollier0120/Fake/statuses/${head}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`, '-f', `description=node -e process.exit(0) passed at ${head.slice(0, 7)}`]);

  const failed = await go({ test: 'node -e process.exit(1)' });
  assert.equal(failed.v.ok, false);
  assert.match(failed.v.message, /checks failed at .*Nothing was recorded/);
  assert.ok(!failed.r.gh.some((a) => a[0] === 'api'));

  const moved = await go({ prHead: 'f'.repeat(40) });
  assert.equal(moved.v.ok, false);
  assert.match(moved.v.message, /#9's head is fffffff, this clone's HEAD .*: push/);
  assert.ok(!moved.r.gh.some((a) => a[0] === 'api'));

  writeFileSync(path.join(f.checkout, 'v.txt'), 'changed\n');
  const dirty = await go();
  assert.equal(dirty.v.ok, false);
  assert.match(dirty.v.message, /uncommitted changes/);
  assert.ok(!dirty.r.gh.some((a) => a[0] === 'pr' || a[0] === 'api'));
});

test("steward vouch is stopped past its average time, with everything its checks started, and sets nothing; a pass is kept toward the average", async () => {
  const f = fakeEmployee(path.join(tmp, 'slow'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/slow');
  writeFileSync(path.join(f.checkout, 's.txt'), 's\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 's');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  // A test run that never ends, and a program it started that would write `marker` 3 s on, were it left running.
  const marker = path.join(tmp, 'slow-left-running.txt');
  const slow = path.join(tmp, 'slow.cjs');
  writeFileSync(slow, `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran on'), 3000)`)}], { stdio: 'ignore' });\nsetTimeout(() => {}, 60_000);\n`);
  const go = (test: string, overMs: number) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 11, state: 'OPEN', headRefOid: sh(f.checkout, 'rev-parse', 'HEAD'), isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const e = employee(f.checkout, { fill: '', test: [test] });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const said: string[] = [];
    return vouch(ctx, { dir: f.checkout, say: (l) => said.push(l), overMs }).then((v) => ({ v, r, e, said }));
  };
  const id = employee(f.checkout).id;
  // Three whole-suite vouches of a tenth of a second: a limit of 1.6 s with 1.5 s over.
  mkdirSync(path.dirname(vouchTimesFile()), { recursive: true });
  writeFileSync(vouchTimesFile(), JSON.stringify({ [id]: { whole: [100, 100, 100], affected: [60_000, 60_000, 60_000] } }));

  const t0 = Date.now();
  const stopped = await go(`node "${slow}"`, 1500);
  assert.equal(stopped.v.ok, false);
  assert.match(stopped.v.message, /#11's checks failed at \w+: node .* was stopped at the run's time limit, 2 s, its last 3 whole-suite vouches' average of 0 s and 2 s more\. Nothing was recorded/);
  assert.ok(Date.now() - t0 < 30_000, `stopped at its limit, not at the test's end (${Date.now() - t0} ms)`);
  assert.ok(stopped.said.some((l) => /^time limit: 2 s, its last 3 whole-suite/.test(l)), stopped.said.join('\n'));
  assert.ok(!stopped.r.gh.some((a) => a[0] === 'api'), 'no status set');
  assert.deepEqual(vouchTimes()[id].whole, [100, 100, 100], 'a stopped run is no part of the average');
  if (process.platform === 'win32') {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.ok(!existsSync(marker), 'what the checks started was ended with them');
  }

  const passed = await go('node -e process.exit(0)', 60_000);
  assert.equal(passed.v.ok, true, passed.v.message);
  assert.equal(vouchTimes()[id].whole?.length, 4, 'a pass is kept toward the average');
  assert.deepEqual(vouchTimes()[id].affected, [60_000, 60_000, 60_000], 'the affected runs apart');
});

test("a vouch's time limit: the average of the kind's last ten passes and five minutes, from the third; whole and affected apart", () => {
  const times = { a: { whole: [10 * 60_000, 20 * 60_000, 30 * 60_000], affected: [60_000, 60_000] } };
  assert.deepEqual(vouchLimit('a', 'whole', { times }), { ms: 25 * 60_000, why: "25 min, its last 3 whole-suite vouches' average of 20 min and 5 min more" });
  assert.equal(vouchLimit('a', 'affected', { times }), null, 'two runs: no limit yet');
  assert.equal(vouchLimit('b', 'whole', { times }), null, 'none yet');
  writeFileSync(vouchTimesFile(), JSON.stringify({ c: { whole: [1, 'x', -5, null], affected: 'odd' }, d: 7 }));
  assert.deepEqual(vouchTimes(), { c: { whole: [1] } }, 'what it can read');
  for (let i = 1; i <= 12; i++) noteVouchTime('c', 'affected', i * 1000);
  assert.deepEqual(vouchTimes().c.affected, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => s * 1000), 'the last ten');
  assert.deepEqual(vouchLimit('c', 'affected'), { ms: 7500 + 5 * 60_000, why: "5 min, its last 10 affected vouches' average of 8 s and 5 min more" });
  noteVouchTime('c', 'whole', 0);
  assert.deepEqual(vouchTimes().c.whole, [1], 'no time, no record');
});

test("after a vouch, the Steward running here is asked for a round now, with its server.json's token; nothing it says fails the vouch", async () => {
  const file = path.join(tmp, 'home', 'server.json');
  rmSync(file, { force: true });
  assert.equal(await askRoundSoon({ fetch: async () => assert.fail('nothing to ask') }), "The Steward's page isn't running on this PC: it merges at its next round instead.");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: 1, port: 21012, token: 'tok', since: '' }));
  const asked: [string, RequestInit][] = [];
  const answer = (status: number, body: unknown) => async (url: any, init: any) => (asked.push([String(url), init]), new Response(JSON.stringify(body), { status }));
  assert.equal(await askRoundSoon({ fetch: answer(200, { started: true, message: "The Steward's round has started." }) as typeof fetch }), "The Steward's round has started.");
  assert.equal(asked[0][0], 'http://127.0.0.1:21012/api/round/soon');
  assert.equal(asked[0][1].method, 'POST');
  assert.equal((asked[0][1].headers as Record<string, string>)['x-token'], 'tok');
  assert.equal(await askRoundSoon({ fetch: answer(403, { error: 'forbidden' }) as typeof fetch }), "The Steward's page answered HTTP 403: it merges at its next round instead.");
  assert.equal(await askRoundSoon({ fetch: (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch }), "The Steward's page didn't answer (connect ECONNREFUSED): it merges at its next round instead.");
});
test("steward vouch takes the Assayer's passing check of exactly HEAD's tree, and runs nothing; anything less, and the checks run", async () => {
  const f = fakeEmployee(path.join(tmp, 'assayed'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/assayed');
  writeFileSync(path.join(f.checkout, 'a.txt'), 'a\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const tree = sh(f.checkout, 'rev-parse', 'HEAD^{tree}');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const top = path.resolve(sh(f.checkout, 'rev-parse', '--show-toplevel')).toLowerCase();
  // Its checks here always fail: a vouch that passes proves they weren't run.
  const failing = 'node -e process.exit(1)';
  const passed = { at: new Date().toISOString(), outcome: 'passed', full: true, cases: ['unit-tests', 'typecheck'], commands: [failing, 'npm run typecheck'], tree, marks: { 'node_modules/.package-lock.json': '-', 'src/kit/VERSION': '-' } };
  const go = async (checks: object[], test = [failing]) => {
    writeFileSync(assayerChecksFile(), JSON.stringify({ [top]: checks }));
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const said: string[] = [];
    const e = employee(f.checkout, { fill: '', test });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const v = await vouch(ctx, { dir: f.checkout, say: (l) => said.push(l) });
    return { v, r, said };
  };

  const taken = await go([passed]);
  assert.equal(taken.v.ok, true, taken.v.message);
  assert.match(taken.said.join('\n'), /^the Assayer passed this exact tree at \d\d:\d\d: nothing run again$/m);
  assert.deepEqual(taken.r.gh.find((a) => a[0] === 'api')?.at(-1), `description=${failing}, npm run typecheck passed in the Assayer at ${head.slice(0, 7)}`);
  // The Steward's typecheck is the Assayer's typecheck case, however it is written.
  assert.equal((await go([passed], ['npx tsc -p . --noEmit', failing])).v.ok, true);

  for (const [why, checks, test] of [
    ['no record', [], [failing]],
    ['other code', [{ ...passed, tree: 'f'.repeat(40) }], [failing]],
    ['some tests only', [{ ...passed, full: undefined }], [failing]],
    ['a failure since', [{ ...passed, outcome: 'failed' }, passed], [failing]],
    ['too old', [{ ...passed, at: new Date(Date.now() - ASSAYED_MS - 60_000).toISOString() }], [failing]],
    ['a check it never ran', [passed], [failing, 'npm run build']],
    ['installed since', [{ ...passed, marks: { ...passed.marks, 'a.txt': '-' } }], [failing]],
    ['an Assayer before 0.3.31', [{ at: passed.at, outcome: 'passed', cases: ['unit-tests'] }], [failing]],
  ] as const) {
    const t = await go([...checks], [...test]);
    assert.equal(t.v.ok, false, why);
    assert.match(t.v.message, /checks failed at .*Nothing was recorded/, why);
    assert.doesNotMatch(t.said.join('\n'), /the Assayer passed/, why);
    assert.ok(!t.r.gh.some((a) => a[0] === 'api'), why);
  }
});

test("steward vouch takes the Assayer's affected pass of HEAD's tree when its test files take in the ones the change reaches; fewer, unnamed or a whole-suite vouch, and the checks run", async () => {
  // Three test files that fail when run: a vouch that passes proves none ran. The branch changes src/a.mjs, which
  // test/a.test.mjs alone reaches.
  const failing = "import { test } from 'node:test';\ntest('ran', () => { throw new Error('this ran'); });\n";
  const f = fakeEmployee(path.join(tmp, 'assayed-affected'), {
    version: '0.4.0',
    files: {
      'package.json': '{\n  "name": "fake",\n  "version": "0.4.0",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "test": "node --test \\"test/**/*.test.mjs\\""\n  }\n}\n',
      'src/a.mjs': 'export const a = 1;\n',
      'src/b.mjs': 'export const b = 2;\n',
      'test/a.test.mjs': `import '../src/a.mjs';\n${failing}`,
      'test/b.test.mjs': `import '../src/b.mjs';\n${failing}`,
      'test/c.test.mjs': failing,
    },
  });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/assayed-affected');
  writeFileSync(path.join(f.checkout, 'src/a.mjs'), 'export const a = 1; // tidied\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const tree = sh(f.checkout, 'rev-parse', 'HEAD^{tree}');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const top = path.resolve(sh(f.checkout, 'rev-parse', '--show-toplevel')).toLowerCase();
  const steps = ['npm run typecheck', 'npm test'];
  const passed = { at: new Date().toISOString(), outcome: 'passed', affected: true, cases: ['unit-tests', 'typecheck'], commands: ['npm test', 'npm run typecheck'], ran: { 'npm test': ['test/a.test.mjs', 'test/b.test.mjs'], 'npm run typecheck': 'all' }, tree, marks: { 'src/kit/VERSION': '-' } };
  const go = async (checks: object[], o: { whole?: boolean } = {}) => {
    writeFileSync(assayerChecksFile(), JSON.stringify({ [top]: checks }));
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const said: string[] = [];
    const e = employee(f.checkout, { fill: '', test: steps });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    if (o.whole) ctx.settings.affectedTests = false;
    const v = await vouch(ctx, { dir: f.checkout, say: (l) => said.push(l) });
    return { v, r, said, description: r.gh.find((a) => a[0] === 'api')?.at(-1) };
  };

  // Its two test files take in test/a.test.mjs: taken, and the status says it was an affected vouch, the Assayer's.
  const taken = await go([passed]);
  assert.equal(taken.v.ok, true, taken.v.message);
  assert.match(taken.said.join('\n'), /^the Assayer passed this exact tree at \d\d:\d\d \(npm test: affected: 2 of 3 test files, the Assayer's\): nothing run again$/m);
  assert.equal(taken.description, `description=npm run typecheck, npm test (affected: 2 of 3 test files, the Assayer's) passed at ${head.slice(0, 7)}`);
  // Every test, as it is: taken, whether the vouch would run some or (Settings) all of them; and a whole check still is.
  const all = { ...passed, ran: { ...passed.ran, 'npm test': 'all' } };
  assert.equal((await go([all])).description, `description=npm run typecheck, npm test (the whole suite, the Assayer's) passed at ${head.slice(0, 7)}`);
  assert.equal((await go([all], { whole: true })).v.ok, true);
  assert.equal((await go([{ ...passed, affected: undefined, full: true, ran: undefined }])).description, `description=npm test, npm run typecheck passed in the Assayer at ${head.slice(0, 7)}`);
  // A typecheck it doesn't name in what ran is the Assayer's typecheck case, which is never narrowed.
  assert.equal((await go([{ ...passed, ran: { 'npm test': passed.ran['npm test'] } }])).v.ok, true);

  for (const [why, checks, o] of [
    ['it left out the test file the change reaches', [{ ...passed, ran: { ...passed.ran, 'npm test': ['test/b.test.mjs'] } }], {}],
    ['no test ran', [{ ...passed, ran: { ...passed.ran, 'npm test': [] } }], {}],
    ['its runner chose the tests, unnamed', [{ ...passed, ran: { 'npm run typecheck': 'all' } }], {}],
    ['an Assayer that keeps no files', [{ ...passed, ran: undefined }], {}],
    ['Settings say the whole suite', [passed], { whole: true }],
    ['other code', [{ ...passed, tree: 'f'.repeat(40) }], {}],
    ['a failure since', [{ ...passed, outcome: 'failed' }, passed], {}],
    ['a check it never ran', [{ ...passed, commands: ['npm test'], cases: ['unit-tests'] }], {}],
  ] as const) {
    const t = await go([...checks], o);
    assert.equal(t.v.ok, false, why);
    assert.match(t.v.message, /checks failed at .*Nothing was recorded/, why);
    assert.doesNotMatch(t.said.join('\n'), /the Assayer passed/, why);
    assert.equal(t.description, undefined, why);
  }
});

test("an affected Assayer check stands in only when each check ran as it is, but npm test, whose files take in the vouch's own", () => {
  const pick = { files: ['test/a.test.ts'], tests: ['test/a.test.ts', 'test/b.test.ts'], why: '', flags: [], pretest: false };
  const c = { cases: ['unit-tests', 'typecheck'], ran: { 'npm test': ['test/a.test.ts', 'test/c.test.ts'], 'npm run typecheck': 'all' as const } };
  assert.equal(whyShort(['npm run typecheck', 'npm test'], c, pick), null);
  assert.equal(whyShort(['npx tsc -p . --noEmit', 'npm test'], c, pick), null);
  assert.equal(whyShort(['npm test'], c, { ...pick, files: [] }), null);
  assert.equal(whyShort(['npm test'], { ...c, ran: { 'npm test': ['.\\test\\a.test.ts'] } }, pick), null, 'its paths, however written');
  assert.equal(whyShort(['npm test'], c, { ...pick, files: ['test/a.test.ts', 'test/b.test.ts'] }), 'it left out 1 of the 2 test files this change reaches (test/b.test.ts)');
  assert.equal(whyShort(['npm test'], c, { whole: 'tsconfig.json changed' }), "it ran only some of npm test's tests, and this vouch runs them all");
  assert.equal(whyShort(['npm test'], { ...c, ran: { 'npm test': 'all' } }, { whole: 'tsconfig.json changed' }), null);
  assert.equal(whyShort(['npm test', 'npm run lint'], c, pick), "it doesn't say which tests npm run lint ran");
  assert.equal(whyShort(['npm run test:web'], { ...c, ran: { 'npm run test:web': ['test/w.test.ts'] } }, pick), "it ran only some of npm run test:web's tests, and this vouch runs them all");
  assert.equal(choseOf(c, pick), "affected: 2 of 2 test files, the Assayer's");
  assert.equal(choseOf({ ran: { 'npm test': [] } }, pick), "no test reaches the change, the Assayer's");
  assert.equal(choseOf({ ran: {} }, pick), undefined);
});

test('the Assayer check covers a vouch only when it ran each of its checks', () => {
  const c = { cases: ['unit-tests', 'typecheck'], commands: ['npm test', 'npm run typecheck'] };
  assert.equal(covers(['npx tsc -p . --noEmit', 'npm test'], c), true);
  assert.equal(covers(['npm run typecheck', 'npm test'], c), true);
  assert.equal(covers(['npm test', 'npm run build'], c), false);
  assert.equal(covers(['npx tsc -p . --noEmit', 'npm test'], { cases: ['unit-tests'], commands: ['npm test'] }), false);
  assert.equal(covers(['dotnet test HEI.Core.Tests'], { cases: ['unit-tests'], commands: ['dotnet test'] }), false);
});
