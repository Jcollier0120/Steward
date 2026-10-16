import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A new kit tried on every agent before the Steward's PR that raises it merges (stages/trial.ts): on fake employees
// made with git in a temporary folder, one whose checks pass with the new kit and one whose checks it breaks.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-trial-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { KIT_BREAKS_LABEL, kitTrialHold, kitTrialDirOf, kitTrialsFile, NEXT_BUILD_TRIAL, raisesKit, TRIAL_GOING, TRIAL_NO_ROOM, trialGivesWay, trialParallel, trialsOnTheirOwn, trialWaitsForNextBuild } = await import('../src/stages/trial.ts');
const { apart, apartNow } = await import('../src/stages/slots.ts');
const { APP } = await import('../src/app.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { bumpOne, kitTrialLogOf, trialBranch, trialDirOf } = await import('../src/stages/bump.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');
// An agent's test that relies on what the kit says, as nine agents' tests relied on kit 2.19.0's "note from the NPU".
// It passes on its main as it is (kit 1.0.0), so the failure is the kit's: the trial runs it without the kit too.
// Failing, it says why as a test file that can't load does, from two places: the comment says it once.
const CHECK = [
  "import { readFileSync } from 'node:fs';",
  "const kit = JSON.parse(readFileSync('kit.json', 'utf8')).kit;",
  "if (kit !== '1.0.0') for (const at of ['a', 'b']) console.error(`file:///C:/x/${at}.ts:2\\nReferenceError: Cannot access 'APP' before initialization\\n    at file:///C:/x/${at}.ts:2:7`);",
  "process.exit(kit === '1.0.0' ? 0 : 1);",
  '',
].join('\n');

// The Steward: its main, with kit 1.0.1 in kit\ (the PR's head), pushed as refs/pull/7/head.
const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.1\n', 'kit/node/npu.ts': 'export const npu = 2;\n', 'tools/kit.ts': kitTool } });
sh(steward.checkout, 'push', '--quiet', 'origin', 'HEAD:refs/pull/7/head');
const head = sh(steward.checkout, 'rev-parse', 'HEAD');

const good = employee(fakeEmployee(path.join(tmp, 'good'), { files: { 'tools/kit.ts': kitTool } }).checkout, { id: 'good', name: 'Good' });
const bad = employee(fakeEmployee(path.join(tmp, 'bad'), { files: { 'tools/kit.ts': kitTool, 'check.mjs': CHECK } }).checkout, { id: 'bad', name: 'Bad', test: ['node check.mjs'] });
const me = employee(steward.checkout, { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward', usesKit: false });

const pr = (o: Partial<PrInfo> = {}): PrInfo => ({ number: 7, title: 'Steward 0.11.0, kit 1.0.1', url: 'https://github.com/Jcollier0120/Steward/pull/7', head: 'claude/kit', base: 'main', author: 'Jcollier0120', whose: 'team', headOid: head, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 10, files: ['kit/VERSION', 'kit/node/npu.ts', 'kit/CHANGELOG.md'], ...o });

function ctx() {
  // No agent has an open PR that pins the kit (stages/trial.ts's pairs): kitpair.test.ts has those.
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'comment' ? ok('') : args[0] === 'pr' && args[1] === 'list' ? ok([]) : undefined));
  const c = ctxFor({ employees: [good, bad], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
  return { c, r, comments: () => r.gh.filter((a) => a[1] === 'comment') };
}

test('a PR that raises the kit waits while the new kit fails an agent, with a comment naming it; and merges once labelled', async () => {
  const { c, comments } = ctx();
  const why = await kitTrialHold(c, me, pr());
  assert.match(why ?? '', /kit 1\.0\.1 fails 1 agent's checks here \(Bad\).*label it kit:breaks-agents/, c.lines.join('\n'));
  const said = comments();
  assert.equal(said.length, 1);
  const body = said[0][said[0].indexOf('--body') + 1];
  assert.match(body, /1 of 2 fail their checks with it/);
  assert.match(body, /- \*\*Bad\*\*: node check\.mjs failed \(exit 1\)/);
  // What it printed, once however often it said it; and its whole output, kept apart from its trial's worktree.
  assert.match(body, /- \*\*Bad\*\*: [^\n]*\n\n  It printed:\n\n  ```text\n  ReferenceError: Cannot access 'APP' before initialization\n  ```\n/);
  const kept = kitTrialLogOf(c.settings, bad, '1.0.1');
  assert.match(readFileSync(kept, 'utf8'), /ReferenceError/);
  assert.ok(body.includes(`the failed step's whole output in ${kept}`), body);
  assert.match(body, /add the label `kit:breaks-agents`/);
  assert.ok(!/\*\*Good\*\*/.test(body), 'one that passes is not named');

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

  // The next round: tried once per head commit, so nothing runs again and nothing more is said.
  const again = ctx();
  assert.equal(await kitTrialHold(again.c, me, pr()), why);
  assert.equal(again.comments().length, 0);
  assert.ok(!again.c.lines.some((l) => l.includes('trial:')), 'no agent tried again');

  // Labelled: the agents change with the kit, so it merges, and their bumps go to the Wright.
  const labelled = ctx();
  assert.equal(await kitTrialHold(labelled.c, me, pr({ labels: [KIT_BREAKS_LABEL] })), null);
  assert.match(labelled.c.lines.join('\n'), /labelled kit:breaks-agents: it merges/);
  assert.ok(JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${head}`].commented);
});

test('a kit every agent passes merges; a PR that leaves the kit as it is, or to another repository, is never tried', async () => {
  const { c, comments } = ctx();
  c.settings.employees = [good];
  rmSync(kitTrialsFile(), { force: true });
  assert.equal(await kitTrialHold(c, me, pr()), null, c.lines.join('\n'));
  assert.equal(comments().length, 0);
  assert.ok(c.lines.some((l) => l.startsWith('[good] kit 1.0.1 trial: done')));

  const quiet = ctx();
  assert.equal(raisesKit(pr({ files: ['src/app.ts', 'kit/node/npu.ts'] })), false, 'a kit change without a new version is released with the next one, and tried then');
  assert.equal(await kitTrialHold(quiet.c, me, pr({ files: ['src/app.ts'] })), null);
  assert.equal(await kitTrialHold(quiet.c, good, pr()), null, "an agent's own PR with a kit/VERSION is no kit release");
  assert.equal(quiet.c.lines.length, 0);
});

test('an agent the kit failed is tried again, alone, once its main moves: fixed on its side, the PR merges', async () => {
  rmSync(kitTrialsFile(), { force: true });
  const kept = () => JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${head}`];
  const push = (file: string, text: string) => {
    writeFileSync(path.join(bad.checkout, file), text);
    sh(bad.checkout, 'add', '-A');
    sh(bad.checkout, 'commit', '--quiet', '-m', `Change ${file}`);
    sh(bad.checkout, 'push', '--quiet', 'origin', 'main');
    return sh(bad.checkout, 'rev-parse', 'HEAD');
  };
  const first = ctx();
  assert.match((await kitTrialHold(first.c, me, pr())) ?? '', /fails 1 agent's checks here \(Bad\)/);
  assert.equal(kept().failed[0].main, sh(bad.checkout, 'rev-parse', 'HEAD'), 'the commit it was tried from is kept');

  // Its main as it was: nothing is tried again.
  const same = ctx();
  assert.match((await kitTrialHold(same.c, me, pr())) ?? '', /\(Bad\)/);
  assert.ok(!same.c.lines.some((l) => l.includes('trial:')), same.c.lines.join('\n'));

  // Moved, but still failing the same way: tried again, held, and nothing more said.
  const moved = push('README.md', 'Bad\n');
  const still = ctx();
  assert.match((await kitTrialHold(still.c, me, pr())) ?? '', /\(Bad\)/);
  assert.ok(still.c.lines.some((l) => l.startsWith('[bad] kit 1.0.1 trial: failed')), still.c.lines.join('\n'));
  assert.equal(still.comments().length, 0);
  assert.equal(kept().failed[0].main, moved);

  // Fixed on its side: only it is tried, the PR merges, and a comment says so.
  push('check.mjs', 'process.exit(0);\n');
  const fixed = ctx();
  assert.equal(await kitTrialHold(fixed.c, me, pr()), null, fixed.c.lines.join('\n'));
  assert.ok(fixed.c.lines.some((l) => l.startsWith('[bad] kit 1.0.1 trial: done')));
  assert.ok(!fixed.c.lines.some((l) => l.startsWith('[good]')), 'one that passed is not tried again');
  const said = fixed.comments();
  assert.equal(said.length, 1);
  assert.match(said[0][said[0].indexOf('--body') + 1], /tried kit 1\.0\.1 again, .* on Bad, whose main moved on since: every agent passes with it now/);
  assert.deepEqual(kept().failed, []);
  assert.equal(kept().passed, 2);
  for (const e of [good, bad]) assert.ok(!existsSync(trialDirOf(fixed.c.settings, e)));
  assert.ok(!existsSync(kitTrialDirOf(fixed.c)));

  // Then nothing more: no failures left to try again.
  const after = ctx();
  assert.equal(await kitTrialHold(after.c, me, pr()), null);
  assert.equal(after.c.lines.length, 0);
});

test('a failure kept before its commit was is tried again once; one whose commit is unknown waits for a new push', async () => {
  const at = new Date().toISOString();
  writeJson(kitTrialsFile(), { [`7@${head}`]: { kit: '1.0.1', failed: [{ id: 'good', name: 'Good', message: 'an old failure' }], passed: 1, at, commented: true } });
  const old = ctx();
  assert.equal(await kitTrialHold(old.c, me, pr()), null, old.c.lines.join('\n'));
  assert.ok(old.c.lines.some((l) => l.startsWith('[good] kit 1.0.1 trial: done')));

  writeJson(kitTrialsFile(), { [`7@${head}`]: { kit: '1.0.1', failed: [{ id: 'good', name: 'Good', message: 'failed', main: null }], passed: 1, at, commented: true, steward: APP.version } });
  const unknown = ctx();
  assert.match((await kitTrialHold(unknown.c, me, pr())) ?? '', /\(Good\)/);
  assert.equal(unknown.c.lines.length, 0);
});

test("a failure another Steward kept is tried again, once, whatever its commit: that Steward's way of trying may have been why", async () => {
  const at = new Date().toISOString();
  writeJson(kitTrialsFile(), { [`7@${head}`]: { kit: '1.0.1', failed: [{ id: 'good', name: 'Good', message: 'Could not resolve "react"', main: null }], passed: 1, at, commented: true, steward: '0.0.1' } });
  const older = ctx();
  assert.equal(await kitTrialHold(older.c, me, pr()), null, older.c.lines.join('\n'));
  assert.ok(older.c.lines.some((l) => l.includes("Good failed kit 1.0.1's checks as Steward 0.0.1 tried them: trying it again")), older.c.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${head}`].steward, APP.version);
});

test('an agent that fails without the kit too is not held against it; a kit PR its trial fails gives up its turn', async () => {
  rmSync(kitTrialsFile(), { force: true });
  const broken = employee(fakeEmployee(path.join(tmp, 'broken'), { files: { 'tools/kit.ts': kitTool } }).checkout, { id: 'broken', name: 'Broken', test: ['node -e process.exit(1)'] });
  const c = ctx();
  c.c.settings.employees = [good, broken];
  assert.equal(await kitTrialHold(c.c, me, pr()), null, c.c.lines.join('\n'));
  assert.ok(c.c.lines.some((l) => l.startsWith("[broken] kit 1.0.1 trial: skipped: fails its checks without kit 1.0.1 too, so not the kit's doing")), c.c.lines.join('\n'));
  const t = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${head}`];
  assert.deepEqual([t.passed, t.failed.length, t.own.map((f: { id: string }) => f.id)], [1, 0, ['broken']]);
  // Its turn: given up once its trial is done, fails an agent and said so; never for a draft, a labelled PR or another's.
  const kept = { [`7@${head}`]: { kit: '1.0.1', failed: [{ id: 'bad', name: 'Bad', message: 'x' }], passed: 1, at: t.at, commented: true } };
  assert.deepEqual([...trialGivesWay(me, [pr()], kept)], [7]);
  assert.deepEqual([...trialGivesWay(me, [pr({ draft: true })], kept)], []);
  assert.deepEqual([...trialGivesWay(me, [pr({ labels: [KIT_BREAKS_LABEL] })], kept)], []);
  assert.deepEqual([...trialGivesWay(me, [pr()], { [`7@${head}`]: { ...kept[`7@${head}`], commented: false } })], [], 'not until its author was told');
  assert.deepEqual([...trialGivesWay(me, [pr()], { [`7@${head}`]: { ...kept[`7@${head}`], pending: ['bad'] } })], [], 'not while it is tried');
  assert.deepEqual([...trialGivesWay(good, [pr()], kept)], [], "only the Steward's own");
});

test("a new head of the PR whose kit and tools/kit.ts are the same keeps the trial's verdict: nothing is tried again", async () => {
  rmSync(kitTrialsFile(), { force: true });
  const first = ctx();
  first.c.settings.employees = [good];
  assert.equal(await kitTrialHold(first.c, me, pr()), null, first.c.lines.join('\n'));
  // Caught up with its branch: a new head that changes no kit.
  writeFileSync(path.join(steward.checkout, 'README.md'), 'Steward, caught up\n');
  sh(steward.checkout, 'add', '-A');
  sh(steward.checkout, 'commit', '--quiet', '-m', 'Caught up');
  sh(steward.checkout, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/pull/7/head');
  const caught = sh(steward.checkout, 'rev-parse', 'HEAD');
  const again = ctx();
  again.c.settings.employees = [good];
  assert.equal(await kitTrialHold(again.c, me, pr({ headOid: caught })), null, again.c.lines.join('\n'));
  assert.ok(!again.c.lines.some((l) => l.includes('trial:')), again.c.lines.join('\n'));
  assert.match(again.c.lines.join('\n'), /kit 1\.0\.1 was tried at [0-9a-f]{7}, and its kit and tools\/kit\.ts are the same at [0-9a-f]{7} but for versions and changelogs: not tried again/);
  const kept = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'));
  assert.deepEqual(kept[`7@${caught}`].mains, kept[`7@${head}`].mains);

  // A push that adds a line to a kit file changes the kit: tried again.
  writeFileSync(path.join(steward.checkout, 'kit', 'VERSION'), '1.0.2\n');
  writeFileSync(path.join(steward.checkout, 'kit', 'CHANGELOG.md'), '# Kit\n\n## 1.0.2\n\nIts entry.\n');
  writeFileSync(path.join(steward.checkout, 'kit', 'node', 'npu.ts'), "export const npu = 2;\n// Since kit 1.0.2.\n");
  sh(steward.checkout, 'add', '-A');
  sh(steward.checkout, 'commit', '--quiet', '-m', 'Kit 1.0.2: a line more');
  const withLine = sh(steward.checkout, 'rev-parse', 'HEAD');
  sh(steward.checkout, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/pull/7/head');
  const lined = ctx();
  lined.c.settings.employees = [good];
  assert.equal(await kitTrialHold(lined.c, me, pr({ headOid: withLine })), null, lined.c.lines.join('\n'));
  assert.ok(lined.c.lines.some((l) => l.startsWith('[good] kit 1.0.2 trial: done')), 'a line added to a kit file is a change: tried again');
  // Caught up, a kit PR having merged below it: a new kit version, the kit's changelog, the Steward's version line, and
  // the version in a kit file's line. Its verdict stands, at the new kit version.
  writeFileSync(path.join(steward.checkout, 'kit', 'VERSION'), '1.0.3\n');
  writeFileSync(path.join(steward.checkout, 'kit', 'CHANGELOG.md'), '# Kit\n\n## 1.0.3\n\nIts entry, renamed by the catch-up.\n\n## 1.0.2\n\nAnother PR\'s.\n');
  writeFileSync(path.join(steward.checkout, 'kit', 'node', 'npu.ts'), "export const npu = 2;\n// Since kit 1.0.3.\n");
  writeFileSync(path.join(steward.checkout, 'package.json'), '{ "version": "0.11.1" }\n');
  sh(steward.checkout, 'add', '-A');
  sh(steward.checkout, 'commit', '--quiet', '-m', 'Caught up: kit 1.0.3');
  sh(steward.checkout, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/pull/7/head');
  const versioned = sh(steward.checkout, 'rev-parse', 'HEAD');
  const third = ctx();
  third.c.settings.employees = [good];
  assert.equal(await kitTrialHold(third.c, me, pr({ headOid: versioned })), null, third.c.lines.join('\n'));
  assert.ok(!third.c.lines.some((l) => l.includes('trial:')), third.c.lines.join('\n'));
  assert.match(third.c.lines.join('\n'), /kit 1\.0\.2 \(1\.0\.3 now\) was tried at [0-9a-f]{7}, and its kit and tools\/kit\.ts are the same at [0-9a-f]{7} but for versions and changelogs: not tried again/);
  const now = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${versioned}`];
  assert.equal(now.kit, '1.0.3', 'kept at the kit version it carries now');
  assert.equal(now.tree, sh(steward.checkout, 'rev-parse', `${versioned}:kit`), "its rollout's bump of the released kit finds it (trialpass.ts)");
  assert.equal(now.from, `7@${withLine}`);
  sh(steward.checkout, 'reset', '--quiet', '--hard', head);
  sh(steward.checkout, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/pull/7/head');
});

test("the rollout's bump of an agent the trial passed, from the same commit and with the kit as released, doesn't run its checks again; once its branch moved, it does", async () => {
  rmSync(kitTrialsFile(), { force: true });
  const trial = ctx();
  trial.c.settings.employees = [good, me];
  assert.equal(await kitTrialHold(trial.c, me, pr()), null, trial.c.lines.join('\n'));
  const kept = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${head}`];
  assert.deepEqual(kept.mains, { good: sh(good.checkout, 'rev-parse', 'origin/main') }, 'the commit each passing agent was bumped from');
  assert.equal(kept.tree, sh(steward.checkout, 'rev-parse', `${head}:kit`));

  // The PR merged and the kit released: kit-v1.0.1 at its head.
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
  assert.match(res.message, /checks passed in the kit's trial \(kit 1\.0\.1's trial passed it from [0-9a-f]{7}, in #7\), not run again/);
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

test("beside the rounds (the Steward's page): the PR waits at once while its agents are tried, a second kit's waits its turn, and a round is asked for when it ends", async () => {
  rmSync(kitTrialsFile(), { force: true });
  let ended!: (e: { pr: number; cut: string | null }) => void;
  const done = new Promise<{ pr: number; cut: string | null }>((r) => (ended = r));
  trialsOnTheirOwn((e) => ended(e));
  try {
    const first = ctx();
    let going = 0;
    const why = await kitTrialHold(first.c, me, pr(), { going: () => going++ });
    assert.equal(why, `${TRIAL_GOING}: 0 of 2 so far; the rounds go on meanwhile`, first.c.lines.join('\n'));
    assert.equal(going, 1);
    assert.match(first.c.lines.join('\n'), /at a time, beside the rounds/);

    // Asked again while it goes: how far it got, and nothing tried twice.
    const again = ctx();
    assert.match((await kitTrialHold(again.c, me, pr())) ?? '', new RegExp(`^${TRIAL_GOING}: [0-2] of 2 so far`));
    assert.ok(!again.c.lines.some((l) => l.includes('beside the rounds')), again.c.lines.join('\n'));

    // Another kit PR with agents to try: it waits for this one, rather than filling the same agents' folders.
    const other = pr({ number: 8 });
    writeJson(kitTrialsFile(), { ...JSON.parse(readFileSync(kitTrialsFile(), 'utf8')), [`8@${head}`]: { kit: '1.0.1', failed: [], passed: 0, at: new Date().toISOString(), mains: {}, pending: ['good'] } });
    const second = ctx();
    assert.match((await kitTrialHold(second.c, me, other)) ?? '', /waits for kit 1\.0\.1's trial \(#7\) to end first/);

    assert.deepEqual(await done, { pr: 7, cut: null });
    const kept = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${head}`];
    assert.deepEqual(kept.pending, []);
    assert.equal(kept.by, undefined, 'no process holds it once it ended');
    // Bad was fixed on its side by a test above: both pass.
    assert.equal(kept.passed, 2);

    // The round it asked for settles it: every agent passed, so it merges.
    const settled = ctx();
    assert.equal(await kitTrialHold(settled.c, me, pr()), null, settled.c.lines.join('\n'));
    assert.match(settled.c.lines.join('\n'), /kit 1\.0\.1 tried on every agent: 2 passed, 0 failed/);
  } finally {
    trialsOnTheirOwn(null);
  }
});

test("beside the rounds, a kit's trial never runs beside the Steward's whole suite: it waits for it to end, trying nothing", async () => {
  rmSync(kitTrialsFile(), { force: true });
  trialsOnTheirOwn(() => {});
  let end!: () => void;
  const ended = new Promise<void>((r) => (end = r));
  const whole = apart('whole suite', () => ended);
  try {
    const c = ctx();
    let going = 0;
    assert.equal(await kitTrialHold(c.c, me, pr(), { going: () => going++ }), `${TRIAL_GOING}: it waits for the Steward's whole suite running beside the rounds to end first, so the two never test at once; the rounds go on meanwhile`);
    assert.equal(going, 1, 'a brief wait: the next round comes sooner');
    assert.ok(!c.c.lines.some((l) => l.includes('trial:') || l.includes('beside the rounds')), c.c.lines.join('\n'));
  } finally {
    end();
    await whole;
    trialsOnTheirOwn(null);
  }
  assert.equal(apartNow('whole suite'), null);
});

test('a build tries one kit: a head that moved after its trial began in the build waits for the next build; a catch-up of it does not', async () => {
  rmSync(kitTrialsFile(), { force: true });
  const due = '2026-10-16T17:00:00.000Z';
  const inBuild = () => {
    const x = ctx();
    x.c.settings.employees = [good];
    x.c.build = { due, name: 'the 13:00 build' };
    return x;
  };
  const kept = () => JSON.parse(readFileSync(kitTrialsFile(), 'utf8'));
  /** `files` committed in `dir` and pushed as the PR's head: its commit. */
  const commitAt = (dir: string, message: string, files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) writeFileSync(path.join(dir, f), t);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '--quiet', '-m', message);
    sh(dir, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/pull/7/head');
    return sh(dir, 'rev-parse', 'HEAD');
  };
  const first = inBuild();
  assert.equal(await kitTrialHold(first.c, me, pr()), null, first.c.lines.join('\n'));
  assert.equal(kept()[`7@${head}`].build, due, 'the build it began in');

  // Its author pushes a change to the kit while the build goes on.
  const moved = commitAt(steward.checkout, 'Kit 1.0.2', { 'kit/VERSION': '1.0.2\n', 'kit/node/npu.ts': 'export const npu = 3;\n' });
  try {
    const next = inBuild();
    const words = `${NEXT_BUILD_TRIAL}: this build tried kit 1.0.1 already (#7), before it moved to ${moved.slice(0, 7)}, and a build tries one kit`;
    assert.equal(await kitTrialHold(next.c, me, pr({ headOid: moved })), words);
    assert.ok(!next.c.lines.some((l) => l.includes('trial:')), next.c.lines.join('\n'));
    assert.equal(await trialWaitsForNextBuild(next.c, me, pr({ headOid: moved })), words, 'merge.ts asks before its test at head');
    assert.equal(await trialWaitsForNextBuild(next.c, me, pr()), null, 'the head the build tried');
    // A catch-up of the head it tried, changing no kit but its version: the trial's verdict stands, in this build.
    sh(steward.checkout, 'reset', '--quiet', '--hard', head);
    const caught = commitAt(steward.checkout, 'Caught up', { 'README.md': 'Steward, caught up in the build\n' });
    const carried = inBuild();
    assert.equal(await trialWaitsForNextBuild(carried.c, me, pr({ headOid: caught })), null);
    assert.equal(await kitTrialHold(carried.c, me, pr({ headOid: caught })), null, carried.c.lines.join('\n'));
    sh(steward.checkout, 'reset', '--quiet', '--hard', moved);
    sh(steward.checkout, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/pull/7/head');

    // Between builds, it is tried, for the next build.
    const between = ctx();
    between.c.settings.employees = [good];
    assert.equal(await trialWaitsForNextBuild(between.c, me, pr({ headOid: moved })), null);
    assert.equal(await kitTrialHold(between.c, me, pr({ headOid: moved })), null, between.c.lines.join('\n'));
    assert.ok(between.c.lines.some((l) => l.startsWith('[good] kit 1.0.2 trial: done')), between.c.lines.join('\n'));
    assert.equal(kept()[`7@${moved}`].build, undefined);
  } finally {
    sh(steward.checkout, 'reset', '--quiet', '--hard', head);
    sh(steward.checkout, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/pull/7/head');
  }
});

test('a trial another live process is trying on its own is left to it; one whose process went quiet is tried here', async () => {
  const at = (ms: number) => new Date(Date.now() - ms).toISOString();
  const trial = (by: { pid: number; at: string }) => writeJson(kitTrialsFile(), { [`7@${head}`]: { kit: '1.0.1', failed: [], passed: 1, at: at(0), mains: {}, pending: ['good'], by } });
  trial({ pid: process.ppid, at: at(0) });
  const left = ctx();
  assert.equal(await kitTrialHold(left.c, me, pr()), `${TRIAL_GOING}: 1 of 2 so far; the rounds go on meanwhile`);
  assert.equal(left.c.lines.length, 0, left.c.lines.join('\n'));

  trial({ pid: process.ppid, at: at(60 * 60_000) });
  const quiet = ctx();
  assert.equal(await kitTrialHold(quiet.c, me, pr()), null, quiet.c.lines.join('\n'));
  assert.ok(quiet.c.lines.some((l) => l.startsWith('[good] kit 1.0.1 trial: done')), quiet.c.lines.join('\n'));
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

test("no try starts while more than 85% of the PC's memory is in use (Steward 0.36.68): the trial goes on from the next round", async () => {
  rmSync(kitTrialsFile(), { force: true });
  writeJson(kitTrialsFile(), { [`7@${head}`]: { kit: '1.0.1', failed: [], passed: 0, at: new Date().toISOString(), mains: {}, pending: ['good'] } });
  const full = ctx();
  full.c.memoryInUse = () => 0.9;
  assert.equal(await kitTrialHold(full.c, me, pr()), TRIAL_NO_ROOM, full.c.lines.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${head}`].pending, ['good'], 'still to try');
  assert.ok(!full.c.lines.some((l) => l.startsWith('[good] kit 1.0.1 trial')), full.c.lines.join('\n'));
  const room = ctx();
  room.c.memoryInUse = () => 0.5;
  assert.equal(await kitTrialHold(room.c, me, pr()), null, room.c.lines.join('\n'));
  assert.ok(room.c.lines.some((l) => l.startsWith('[good] kit 1.0.1 trial: done')), room.c.lines.join('\n'));
});
