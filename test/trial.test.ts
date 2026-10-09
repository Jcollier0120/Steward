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

const { KIT_BREAKS_LABEL, kitTrialHold, kitTrialDirOf, kitTrialsFile, raisesKit } = await import('../src/stages/trial.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { trialBranch, trialDirOf } = await import('../src/stages/bump.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');
// An agent's test that relies on what the kit says, as nine agents' tests relied on kit 2.19.0's "note from the NPU".
const CHECK = "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('src/kit/node/npu.ts', 'utf8').includes('npu = 1') ? 0 : 1);\n";

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

  writeJson(kitTrialsFile(), { [`7@${head}`]: { kit: '1.0.1', failed: [{ id: 'good', name: 'Good', message: 'failed', main: null }], passed: 1, at, commented: true } });
  const unknown = ctx();
  assert.match((await kitTrialHold(unknown.c, me, pr())) ?? '', /\(Good\)/);
  assert.equal(unknown.c.lines.length, 0);
});
