import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Main's new kit tried on every agent before it is released (stages/trial.ts, Steward 0.36.124): on fake employees made
// with git in a temporary folder, one whose checks pass with the new kit and one whose checks it breaks.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-trial-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { failsWords, heldKit, kitContentOf, kitTrialAtMain, kitTrialDirOf, kitTrialsFile, mainKeyOf, sameKitTrial, TRIAL_GOING, TRIAL_NO_ROOM, trialParallel, underLoad, UNDER_LOAD } = await import('../src/stages/trial.ts');
type KitTrial = import('../src/stages/trial.ts').KitTrial;
const { APP } = await import('../src/app.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { bumpOne, kitTrialLogOf, trialBranch, trialDirOf } = await import('../src/stages/bump.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');
// An agent's test that relies on what the kit says, as nine agents' tests relied on kit 2.19.0's "note from the NPU".
// It passes on its main as it is (kit 1.0.0), so the failure is the kit's: the trial runs it without the kit too.
// Failing, it says why as a test file that can't load does, from two places: the trial keeps it once.
const CHECK = [
  "import { readFileSync } from 'node:fs';",
  "const kit = JSON.parse(readFileSync('kit.json', 'utf8')).kit;",
  "if (kit !== '1.0.0') for (const at of ['a', 'b']) console.error(`file:///C:/x/${at}.ts:2\\nReferenceError: Cannot access 'APP' before initialization\\n    at file:///C:/x/${at}.ts:2:7`);",
  "process.exit(kit === '1.0.0' ? 0 : 1);",
  '',
].join('\n');

// The Steward: its main, with kit 1.0.1 in kit\ and no release of it.
const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.1\n', 'kit/node/npu.ts': 'export const npu = 2;\n', 'tools/kit.ts': kitTool } });
const head = sh(steward.checkout, 'rev-parse', 'HEAD');

const good = employee(fakeEmployee(path.join(tmp, 'good'), { files: { 'tools/kit.ts': kitTool } }).checkout, { id: 'good', name: 'Good' });
const bad = employee(fakeEmployee(path.join(tmp, 'bad'), { files: { 'tools/kit.ts': kitTool, 'check.mjs': CHECK } }).checkout, { id: 'bad', name: 'Bad', test: ['node check.mjs'] });
const me = employee(steward.checkout, { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward', usesKit: false });

function ctx(employees = [good, bad]) {
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'list' ? ok([]) : undefined));
  const c = ctxFor({ employees, workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
  return { c, r };
}
const at = { commit: head, kit: '1.0.1' };
const kept = () => JSON.parse(readFileSync(kitTrialsFile(), 'utf8'));
/** The agents' tries a run logged. */
const tries = (lines: string[]) => lines.filter((l) => /^\[[\w-]+\] kit [\d.]+ trial: (done|failed|skipped)/.test(l));
/** `files` committed on the Steward's main (not pushed): its commit. */
const commitAt = (message: string, files: Record<string, string>) => {
  for (const [f, t] of Object.entries(files)) writeFileSync(path.join(steward.checkout, f), t);
  sh(steward.checkout, 'add', '-A');
  sh(steward.checkout, 'commit', '--quiet', '-m', message);
  return sh(steward.checkout, 'rev-parse', 'HEAD');
};

test("main's kit fails an agent: it isn't released, the agent named with what it printed, and the verdict kept for that commit", async () => {
  rmSync(kitTrialsFile(), { force: true });
  const { c } = ctx();
  const t = await kitTrialAtMain(c, me, at);
  assert.ok(t.state === 'failed', c.lines.join('\n'));
  assert.equal(t.why, "kit 1.0.1 fails 1 agent's checks here (Bad), so it isn't released: fix the kit on main, or the agents on theirs");
  assert.equal(t.why, failsWords(t.t));
  assert.ok(c.lines.some((l) => l.startsWith('[good] kit 1.0.1 trial: done')), c.lines.join('\n'));
  assert.ok(c.lines.some((l) => l.startsWith('[bad] kit 1.0.1 trial: failed')), c.lines.join('\n'));

  const k = kept()[mainKeyOf(head)];
  assert.deepEqual([k.kit, k.commit, k.passed, k.steward, k.pending, k.retry], ['1.0.1', head, 1, APP.version, undefined, undefined]);
  assert.equal(k.tree, sh(steward.checkout, 'rev-parse', `${head}:kit`));
  assert.equal(typeof k.content, 'string');
  assert.deepEqual(k.mains, { good: sh(good.checkout, 'rev-parse', 'origin/main') }, 'the commit each passing agent was bumped from');
  assert.deepEqual(k.failed.map((f: KitTrial['failed'][number]) => [f.id, f.name, f.main]), [['bad', 'Bad', sh(bad.checkout, 'rev-parse', 'HEAD')]]);
  assert.match(k.failed[0].message, /^node check\.mjs failed \(exit 1\)/);
  // What it printed, once however often it said it; and its whole output, kept apart from its trial's worktree.
  const errors: string[] = k.failed[0].errors ?? [];
  assert.equal(errors.filter((l) => l.includes("ReferenceError: Cannot access 'APP' before initialization")).length, 1, errors.join('\n'));
  const log = kitTrialLogOf(c.settings, bad, '1.0.1');
  assert.match(readFileSync(log, 'utf8'), /ReferenceError/);
  assert.ok(k.failed[0].message.includes(`the failed step's whole output in ${log}`), k.failed[0].message);

  // Nothing left behind: no trial worktree or branch, nothing committed or pushed, the person's checkouts as they were.
  for (const e of [good, bad]) {
    assert.ok(!existsSync(trialDirOf(c.settings, e)), `${e.id}'s trial worktree is removed`);
    assert.equal(sh(e.checkout, 'branch', '--list', trialBranch('1.0.1')), '');
    assert.equal(sh(e.checkout, 'branch', '--list', 'steward/kit-1.0.1'), '');
    assert.equal(sh(e.checkout, 'ls-remote', '--heads', 'origin'), sh(e.checkout, 'ls-remote', '--heads', 'origin', 'main'));
    assert.equal(sh(e.checkout, 'status', '--porcelain'), '');
  }
  assert.ok(!existsSync(kitTrialDirOf(c)));
  assert.ok(existsSync(`${trialDirOf(c.settings, bad)}.log`), "the failed step's output is kept beside it");

  // Asked again at the same commit: the kept verdict, nothing tried again.
  const again = ctx();
  const t2 = await kitTrialAtMain(again.c, me, at);
  assert.deepEqual([t2.state, 'why' in t2 ? t2.why : null], ['failed', t.why]);
  assert.deepEqual(tries(again.c.lines), [], again.c.lines.join('\n'));
});

test("an agent the kit failed is tried again, alone, once its main moves: fixed on its side, the kit passes", async () => {
  const push = (file: string, text: string) => {
    writeFileSync(path.join(bad.checkout, file), text);
    sh(bad.checkout, 'add', '-A');
    sh(bad.checkout, 'commit', '--quiet', '-m', `Change ${file}`);
    sh(bad.checkout, 'push', '--quiet', 'origin', 'main');
    return sh(bad.checkout, 'rev-parse', 'HEAD');
  };
  // Moved, but still failing the same way: tried again, and still failing.
  const moved = push('README.md', 'Bad\n');
  const still = ctx();
  assert.equal((await kitTrialAtMain(still.c, me, at)).state, 'failed');
  assert.match(still.c.lines.join('\n'), /Bad moved on since kit 1\.0\.1 failed their checks: trying it again/);
  assert.deepEqual(tries(still.c.lines).map((l) => l.split(':')[0]), ['[bad] kit 1.0.1 trial'], 'only it is tried');
  assert.equal(kept()[mainKeyOf(head)].failed[0].main, moved);

  // Fixed on its side: only it is tried, and the kit passes.
  push('check.mjs', 'process.exit(0);\n');
  const fixed = ctx();
  const t = await kitTrialAtMain(fixed.c, me, at);
  assert.equal(t.state, 'passed', fixed.c.lines.join('\n'));
  assert.ok(fixed.c.lines.some((l) => l.startsWith('[bad] kit 1.0.1 trial: done')));
  assert.ok(!fixed.c.lines.some((l) => l.startsWith('[good]')), 'one that passed is not tried again');
  const k = kept()[mainKeyOf(head)];
  assert.deepEqual([k.failed, k.passed], [[], 2]);
  assert.deepEqual(Object.keys(k.mains).sort(), ['bad', 'good']);
  for (const e of [good, bad]) assert.ok(!existsSync(trialDirOf(fixed.c.settings, e)));
  assert.ok(!existsSync(kitTrialDirOf(fixed.c)));

  // Then nothing more: no failures left to try again.
  const after = ctx();
  assert.equal((await kitTrialAtMain(after.c, me, at)).state, 'passed');
  assert.deepEqual(after.c.lines, []);
});

test('a failure kept before its commit was is tried again once; one whose commit is unknown waits for a new push', async () => {
  const when = new Date().toISOString();
  writeJson(kitTrialsFile(), { [mainKeyOf(head)]: { kit: '1.0.1', failed: [{ id: 'good', name: 'Good', message: 'an old failure' }], passed: 1, at: when, commit: head } });
  const old = ctx();
  assert.equal((await kitTrialAtMain(old.c, me, at)).state, 'passed', old.c.lines.join('\n'));
  assert.ok(old.c.lines.some((l) => l.startsWith('[good] kit 1.0.1 trial: done')));

  writeJson(kitTrialsFile(), { [mainKeyOf(head)]: { kit: '1.0.1', failed: [{ id: 'good', name: 'Good', message: 'failed', main: null }], passed: 1, at: when, commit: head, steward: APP.version } });
  const unknown = ctx();
  const t = await kitTrialAtMain(unknown.c, me, at);
  assert.ok(t.state === 'failed');
  assert.match(t.why, /\(Good\)/);
  assert.deepEqual(tries(unknown.c.lines), []);
});

test("a failure another Steward kept is tried again, once, whatever its commit: that Steward's way of trying may have been why", async () => {
  writeJson(kitTrialsFile(), { [mainKeyOf(head)]: { kit: '1.0.1', failed: [{ id: 'good', name: 'Good', message: 'Could not resolve "react"', main: null }], passed: 1, at: new Date().toISOString(), commit: head, steward: '0.0.1' } });
  const older = ctx();
  assert.equal((await kitTrialAtMain(older.c, me, at)).state, 'passed', older.c.lines.join('\n'));
  assert.ok(older.c.lines.some((l) => l.includes("Good failed kit 1.0.1's checks as Steward 0.0.1 tried them: trying it again")), older.c.lines.join('\n'));
  assert.equal(kept()[mainKeyOf(head)].steward, APP.version);
});

test('an agent that fails without the kit too is not held against it', async () => {
  rmSync(kitTrialsFile(), { force: true });
  const broken = employee(fakeEmployee(path.join(tmp, 'broken'), { files: { 'tools/kit.ts': kitTool } }).checkout, { id: 'broken', name: 'Broken', test: ['node -e process.exit(1)'] });
  const { c } = ctx([good, broken]);
  assert.equal((await kitTrialAtMain(c, me, at)).state, 'passed', c.lines.join('\n'));
  assert.ok(c.lines.some((l) => l.startsWith("[broken] kit 1.0.1 trial: skipped: fails its checks without kit 1.0.1 too, so not the kit's doing")), c.lines.join('\n'));
  const t = kept()[mainKeyOf(head)];
  assert.deepEqual([t.passed, t.failed.length, t.own.map((f: { id: string }) => f.id)], [1, 0, ['broken']]);
});

test("an agent Manor has retired isn't tried, and a failure of its kept from before no longer holds the kit (retired.ts)", async () => {
  rmSync(kitTrialsFile(), { force: true });
  // As the Bad was before a test above fixed it on its main: the kit fails its checks.
  const sour = employee(fakeEmployee(path.join(tmp, 'sour'), { files: { 'tools/kit.ts': kitTool, 'check.mjs': CHECK } }).checkout, { id: 'sour', name: 'Sour', test: ['node check.mjs'] });
  const left = ctx([good, sour]);
  left.c.retired = new Set(['sour']);
  assert.equal((await kitTrialAtMain(left.c, me, at)).state, 'passed', left.c.lines.join('\n'));
  assert.ok(left.c.lines.some((l) => l.includes('trying it on 1 agents before it is released')), left.c.lines.join('\n'));
  assert.ok(!left.c.lines.some((l) => l.startsWith('[sour]')), 'never tried');
  // It failed the kit, then Manor retired it: the kept verdict no longer holds the kit, and nothing is tried again.
  rmSync(kitTrialsFile(), { force: true });
  const before = ctx([good, sour]);
  assert.equal((await kitTrialAtMain(before.c, me, at)).state, 'failed', before.c.lines.join('\n'));
  const since = ctx([good, sour]);
  since.c.retired = new Set(['sour']);
  assert.equal((await kitTrialAtMain(since.c, me, at)).state, 'passed', since.c.lines.join('\n'));
  assert.ok(since.c.lines.some((l) => l.includes("Sour failed kit 1.0.1's checks, and Manor has retired it since: no longer held against the kit")), since.c.lines.join('\n'));
  assert.deepEqual(tries(since.c.lines), []);
  assert.deepEqual(kept()[mainKeyOf(head)].failed, []);
});

test("a commit of main whose kit and tools/kit.ts are the same takes the kept verdict: nothing is tried again; a change to a kit file is", async () => {
  rmSync(kitTrialsFile(), { force: true });
  try {
    const first = ctx([good]);
    assert.equal((await kitTrialAtMain(first.c, me, at)).state, 'passed', first.c.lines.join('\n'));
    // Main moves on with code of its own, the kit as it was.
    const caught = commitAt('Another change', { 'README.md': 'Steward, moved on\n' });
    const again = ctx([good]);
    assert.equal((await kitTrialAtMain(again.c, me, { commit: caught, kit: '1.0.1' })).state, 'passed', again.c.lines.join('\n'));
    assert.deepEqual(tries(again.c.lines), [], again.c.lines.join('\n'));
    assert.match(again.c.lines.join('\n'), new RegExp(`kit 1\\.0\\.1 at ${caught.slice(0, 7)} is the kit main@${head} tried \\(kit 1\\.0\\.1\\), but for versions and changelogs: not tried again`));
    const k = kept();
    assert.deepEqual(k[mainKeyOf(caught)].mains, k[mainKeyOf(head)].mains);
    assert.equal(k[mainKeyOf(caught)].from, mainKeyOf(head));
    assert.equal(k[mainKeyOf(caught)].content, k[mainKeyOf(head)].content);

    // A new kit version, its changelog and the Steward's version: the same kit an agent gets. The verdict stands, at the
    // version it carries now, with its kit's tree, so the rollout's bump of the released kit finds it (trialpass.ts).
    const versioned = commitAt('Kit 1.0.2, Steward 0.11.1', { 'kit/VERSION': '1.0.2\n', 'kit/CHANGELOG.md': '# Kit\n\n## 1.0.2\n\nIts entry.\n', 'package.json': '{ "version": "0.11.1" }\n' });
    const third = ctx([good]);
    assert.equal((await kitTrialAtMain(third.c, me, { commit: versioned, kit: '1.0.2' })).state, 'passed', third.c.lines.join('\n'));
    assert.deepEqual(tries(third.c.lines), [], third.c.lines.join('\n'));
    const now = kept()[mainKeyOf(versioned)];
    assert.equal(now.kit, '1.0.2', 'kept at the kit version it carries now');
    assert.equal(now.tree, sh(steward.checkout, 'rev-parse', `${versioned}:kit`));
    assert.equal(now.from, mainKeyOf(caught), 'the newest done trial of the same kit');

    // A line added to a kit file changes the kit: tried again.
    const lined = commitAt('Kit 1.0.3: a line more', { 'kit/VERSION': '1.0.3\n', 'kit/node/npu.ts': 'export const npu = 2;\n// Since kit 1.0.3.\n' });
    const fourth = ctx([good]);
    assert.equal((await kitTrialAtMain(fourth.c, me, { commit: lined, kit: '1.0.3' })).state, 'passed', fourth.c.lines.join('\n'));
    assert.ok(fourth.c.lines.some((l) => l.startsWith('[good] kit 1.0.3 trial: done')), fourth.c.lines.join('\n'));
    assert.equal(kept()[mainKeyOf(lined)].from, undefined);
    assert.notEqual(kept()[mainKeyOf(lined)].content, now.content);
  } finally {
    sh(steward.checkout, 'reset', '--quiet', '--hard', head);
  }
});

test("the kit an agent gets, as one key: each part's tree and tools/kit.ts' blob; none without a kit\\", async () => {
  const { c } = ctx();
  const content = await kitContentOf(c, steward.checkout, head);
  const tree = (p: string) => sh(steward.checkout, 'rev-parse', `${head}:${p}`);
  assert.equal(content, `node:${tree('kit/node')} web:- spec:- react:- tool:${tree('tools/kit.ts')}`);
  assert.equal(await kitContentOf(c, good.checkout, 'HEAD'), null, 'no kit\\');
  assert.equal(await kitContentOf(c, steward.checkout, 'f'.repeat(40)), null, "git can't say");
});

test('the same kit tried under another key: a done one, newest first, else one still going; never the key asked for', () => {
  const t = (o: Partial<KitTrial>): KitTrial => ({ kit: '1.0.1', failed: [], passed: 1, at: '2026-10-16T10:00:00Z', content: 'X', ...o });
  const kept = { '7@c': t({}), 'main@a': t({}), 'main@b': t({ pending: ['good'] }), 'main@d': t({ content: 'Y' }) };
  assert.equal(sameKitTrial(kept, 'X', 'main@e')?.[0], 'main@a', 'the newest done one');
  assert.equal(sameKitTrial(kept, 'X', 'main@a')?.[0], '7@c', "one a PR's trial kept before Steward 0.36.124");
  assert.equal(sameKitTrial({ 'main@b': kept['main@b'] }, 'X', 'main@e')?.[0], 'main@b', 'one still going');
  assert.equal(sameKitTrial({ 'main@b': t({ retry: [{ id: 'busy', name: 'Busy', message: 'EBUSY' }] }) }, 'X', 'main@e')?.[0], 'main@b', 'one with an agent to try once more is going too');
  assert.equal(sameKitTrial(kept, 'Z', 'main@e'), undefined);
  assert.equal(sameKitTrial({ 'main@e': t({}) }, 'X', 'main@e'), undefined, 'never the key asked for');
});

test('the kit held: the newest trial of a main commit, done, failing agents, of a kit not released since', () => {
  const failing = [{ id: 'bad', name: 'Bad', message: 'x' }];
  const t = (at: string, o: Partial<KitTrial> = {}): KitTrial => ({ kit: '1.0.2', failed: failing, passed: 1, at, ...o });
  const newer = t('2026-10-16T12:00:00Z');
  // Kept newest first: the time says which is newest, not the order.
  assert.equal(heldKit({ 'main@b': newer, 'main@a': t('2026-10-16T10:00:00Z', { kit: '1.0.1', failed: [] }) }, ['1.0.0']), newer);
  assert.equal(heldKit({ 'main@b': newer }, ['1.0.2']), null, 'released since');
  assert.equal(heldKit({ 'main@a': t('2026-10-16T10:00:00Z'), 'main@b': t('2026-10-16T12:00:00Z', { failed: [] }) }, []), null, 'the newest passed');
  assert.equal(heldKit({ 'main@b': t('2026-10-16T12:00:00Z', { pending: ['good'] }) }, []), null, 'still going');
  assert.equal(heldKit({ 'main@b': t('2026-10-16T12:00:00Z', { retry: failing }) }, []), null, 'an agent to try once more');
  assert.equal(heldKit({ '7@x': t('2026-10-16T12:00:00Z') }, []), null, "a PR's trial from before Steward 0.36.124");
  assert.equal(heldKit({}, []), null);
});

test('a trial goes on in slices: one past its slice says how far it got, and the next call goes on from there', async () => {
  rmSync(kitTrialsFile(), { force: true });
  try {
    const first = ctx();
    const t = await kitTrialAtMain(first.c, me, at, 0);
    assert.deepEqual(t, { state: 'going', why: `${TRIAL_GOING}: 1 of 2 so far` });
    assert.equal(tries(first.c.lines).length, 1, first.c.lines.join('\n'));
    assert.equal(kept()[mainKeyOf(head)].pending.length, 1, 'one still to try');
    assert.ok(!existsSync(kitTrialDirOf(first.c)), "the Steward's worktree is removed between slices");

    // Main moved on meanwhile, the kit as it was: the trial going on at the commit before goes on.
    const moved = commitAt('Another change, mid-trial', { 'README.md': 'Steward, moved on mid-trial\n' });
    const next = ctx();
    assert.equal((await kitTrialAtMain(next.c, me, { commit: moved, kit: '1.0.1' }, 0)).state, 'passed', next.c.lines.join('\n'));
    assert.equal(tries(next.c.lines).length, 1, 'only the one left is tried');
    assert.match(next.c.lines.join('\n'), /kit 1\.0\.1 tried on every agent: 2 passed, 0 failed/);
    const k = kept()[mainKeyOf(head)];
    assert.deepEqual([k.pending, k.passed, k.failed], [undefined, 2, []]);
  } finally {
    sh(steward.checkout, 'reset', '--quiet', '--hard', head);
  }
});

test("the rollout's bump of an agent the trial passed, from the same commit and with the kit as released, doesn't run its checks again; once its branch moved, it does", async () => {
  rmSync(kitTrialsFile(), { force: true });
  const trial = ctx([good, me]);
  assert.equal((await kitTrialAtMain(trial.c, me, at)).state, 'passed', trial.c.lines.join('\n'));
  const k = kept()[mainKeyOf(head)];
  assert.deepEqual(k.mains, { good: sh(good.checkout, 'rev-parse', 'origin/main') }, 'the commit each passing agent was bumped from');
  assert.equal(k.tree, sh(steward.checkout, 'rev-parse', `${head}:kit`));

  // The kit released: kit-v1.0.1 at main's commit tried.
  sh(steward.checkout, 'tag', '-f', 'kit-v1.0.1', head);
  sh(steward.checkout, 'push', '--quiet', '--force', 'origin', 'refs/tags/kit-v1.0.1');
  const tool = path.join(steward.checkout, 'tools', 'kit.ts');
  const rollout = () => {
    const r = runner((a) => (a[0] === 'release' && a[1] === 'list' ? ok([]) : a[0] === 'pr' && a[1] === 'list' ? ok([]) : undefined));
    return ctxFor({ employees: [good, me], workRoot: path.join(tmp, 'work'), run: r.run, released: ['1.0.1'], neutralDir: tmp });
  };
  const ran = (lines: string[]) => lines.filter((l) => /: (ok|exit \d+) \(\d+ s\)$/.test(l));
  const c = rollout();
  const res = await bumpOne(c, good, { kit: '1.0.1', tool });
  assert.equal(res.outcome, 'done', `${res.message}\n${c.lines.join('\n')}`);
  assert.match(res.message, /checks passed in the kit's trial \(kit 1\.0\.1's trial passed it from [0-9a-f]{7}[^)]*\), not run again/);
  assert.deepEqual(ran(c.lines), [], 'no check was run');
  assert.match(sh(good.checkout, 'log', '-1', '--format=%b', 'steward/kit-1.0.1'), /passed in the kit's trial from the same commit/);

  // Another tools/kit.ts handed out than the one tried: run.
  const other = path.join(tmp, 'other-kit.ts');
  writeFileSync(other, `${readFileSync(tool, 'utf8')}\n// changed\n`);
  const c2 = rollout();
  await bumpOne(c2, good, { kit: '1.0.1', tool: other });
  assert.ok(ran(c2.lines).length > 0, c2.lines.join('\n'));

  // Its branch moved since the trial: run.
  writeFileSync(path.join(good.checkout, 'README.md'), 'Good, moved on\n');
  sh(good.checkout, 'add', '-A');
  sh(good.checkout, 'commit', '--quiet', '-m', 'Moved on');
  sh(good.checkout, 'push', '--quiet', 'origin', 'main');
  const c3 = rollout();
  const moved = await bumpOne(c3, good, { kit: '1.0.1', tool });
  assert.ok(!moved.message.includes('not run again'), moved.message);
  assert.ok(ran(c3.lines).length > 0, c3.lines.join('\n'));
});

test("no try starts while more than 85% of the PC's memory is in use (Steward 0.36.68): the trial goes on from the next round", async () => {
  writeJson(kitTrialsFile(), { [mainKeyOf(head)]: { kit: '1.0.1', failed: [], passed: 0, at: new Date().toISOString(), mains: {}, pending: ['good'], commit: head } });
  const full = ctx([good]);
  full.c.memoryInUse = () => 0.9;
  assert.deepEqual(await kitTrialAtMain(full.c, me, at), { state: 'going', why: TRIAL_NO_ROOM }, full.c.lines.join('\n'));
  assert.deepEqual(kept()[mainKeyOf(head)].pending, ['good'], 'still to try');
  assert.deepEqual(tries(full.c.lines), [], full.c.lines.join('\n'));
  const room = ctx([good]);
  room.c.memoryInUse = () => 0.5;
  assert.equal((await kitTrialAtMain(room.c, me, at)).state, 'passed', room.c.lines.join('\n'));
  assert.ok(room.c.lines.some((l) => l.startsWith('[good] kit 1.0.1 trial: done')), room.c.lines.join('\n'));
});

test('what looks like load: a test killed, EBUSY, a run stopped at its time limit; or failing without the kit too, otherwise', () => {
  const failed = (message: string, without?: string) => ({ id: 'x', name: 'X', outcome: 'failed' as const, message, ...(without ? { without } : {}) });
  assert.ok(underLoad(failed('npm test failed (exit 1): "manor fire lamplighter" (Expected values to be strictly equal: null !== 1), twice')));
  assert.ok(underLoad(failed('node --test failed (exit 1): "a run that takes too long" ("EBUSY: resource busy or locked, rmdir \'C:\\\\Temp\\\\x\'")')));
  assert.ok(underLoad(failed('npm test failed (exit null), twice')));
  assert.ok(underLoad(failed('npm test was stopped at its time limit, after 20 min')));
  assert.ok(underLoad(failed('npm test failed (exit 1): "the label" (Expected "NPU" to equal "the NPU")', 'npm test failed (exit 1): "another test"')), 'fails without the kit too, otherwise');
  assert.ok(!underLoad(failed('npm test failed (exit 1): "the label" (Expected "NPU" to equal "the NPU"), twice')), "a test the kit breaks is the kit's");
  assert.ok(!underLoad({ ...failed('EBUSY'), outcome: 'done' as const }));
  assert.ok(!UNDER_LOAD.test('null !== undefined'));
});

test("how many agents a trial tries at once: Settings' parallel or a quarter of the processors up to 4, within free memory above the manor's 15%", () => {
  const GB = 1024 ** 3;
  assert.equal(trialParallel(2, 18, 40 * GB, 48 * GB), 4);
  assert.equal(trialParallel(2, 4, 40 * GB, 48 * GB), 2, 'never fewer than Settings say, memory allowing');
  assert.equal(trialParallel(6, 18, 40 * GB, 48 * GB), 6);
  assert.equal(trialParallel(2, 64, 40 * GB, 48 * GB), 4, 'at most 4 by processors');
  assert.equal(trialParallel(4, 18, 7 * GB, 8 * GB), 1, 'what free memory holds, above the 15% left for the person (1.2 GB of 8)');
  assert.equal(trialParallel(4, 18, 14 * GB, 48 * GB), 2, '14 GB free of 48: 6.8 GB of it the manor may use, two tries');
  assert.equal(trialParallel(4, 18, 7 * GB, 48 * GB), 1, 'free memory under the ceiling: one at least');
  assert.equal(trialParallel(2, 18, 0, 48 * GB), 1, 'at least one');
});
