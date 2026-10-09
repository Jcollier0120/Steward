import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Two halves of one change: a Steward PR that raises the kit, and an agent's PR that pins that kit and changes with it
// (kit 2.42.0 in Steward#126, Manor 0.16.24 in Manor#135, 2026-10-08). The kit's trial fails the agent's main, but the
// agent's PR passes with the kit: the kit merges (stages/trial.ts), and the agent's PR waits for its release, untested,
// saying which Steward PR brings it (stages/prtest.ts); once the kit is released it is tested and merged, even where an
// old result said its checks failed twice at the kit's fill.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-kitpair-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { kitTrialHold, kitTrialsFile, kitTrialDirOf } = await import('../src/stages/trial.ts');
const { prChecksFile, testedBefore } = await import('../src/stages/prtest.ts');
const { mergeOne } = await import('../src/stages/merge.ts');
const { trialDirOf } = await import('../src/stages/bump.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;
type Employee = import('../src/settings.ts').Employee;

const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');
// An agent's test that relies on what the kit says: its main expects npu = 1, its PR kit 1.0.1's npu = 2 (the node part fills src/kit itself).
const check = (n: number) => `import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('src/kit/npu.ts', 'utf8').includes('npu = ${n}') ? 0 : 1);\n`;

// The Steward: kit 1.0.1 in kit\ (npu = 2), as PR #7's head.
const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.1\n', 'kit/node/npu.ts': 'export const npu = 2;\n', 'tools/kit.ts': kitTool } });
sh(steward.checkout, 'push', '--quiet', 'origin', 'HEAD:refs/pull/7/head');
const kitHead = sh(steward.checkout, 'rev-parse', 'HEAD');
const me = employee(steward.checkout, { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward', usesKit: false });
const kitPr = (o: Partial<PrInfo> = {}): PrInfo => ({ number: 7, title: 'Steward 0.11.0, kit 1.0.1: something new', url: 'https://github.com/Jcollier0120/Steward/pull/7', head: 'claude/kit', base: 'main', author: 'Jcollier0120', whose: 'team', headOid: kitHead, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 10, files: ['kit/VERSION', 'kit/node/npu.ts', 'kit/CHANGELOG.md'], ...o });

/** An agent whose main expects npu = 1, with PR `n` that pins kit 1.0.1 and expects `expects` (0.4.0 → 0.4.1). */
function agent(id: string, name: string, n: number, expects: number, o: { draft?: boolean } = {}) {
  const { checkout } = fakeEmployee(path.join(tmp, id), { files: { 'tools/kit.ts': kitTool, 'check.mjs': check(1) } });
  const e = employee(checkout, { id, name, repo: `Jcollier0120/${name}`, test: ['node check.mjs'] });
  sh(checkout, 'switch', '--quiet', '-c', `claude/kit-1.0.1`);
  writeFileSync(path.join(checkout, 'kit.json'), '{\n  "kit": "1.0.1",\n  "parts": ["node"]\n}\n');
  writeFileSync(path.join(checkout, 'check.mjs'), check(expects));
  for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(checkout, f), readFileSync(path.join(checkout, f), 'utf8').split('0.4.0').join('0.4.1'));
  sh(checkout, 'commit', '--quiet', '-am', `${name} 0.4.1: the kit 1.0.1`);
  sh(checkout, 'push', '--quiet', 'origin', 'claude/kit-1.0.1', `HEAD:refs/pull/${n}/head`);
  const headOid = sh(checkout, 'rev-parse', 'HEAD');
  sh(checkout, 'switch', '--quiet', 'main');
  const listed = { number: n, title: `${name} 0.4.1: the kit 1.0.1`, url: `https://github.com/Jcollier0120/${name}/pull/${n}`, body: '', headRefName: 'claude/kit-1.0.1', headRefOid: headOid, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: !!o.draft, statusCheckRollup: [], labels: [], additions: 5, deletions: 5, files: [{ path: 'kit.json' }] };
  return { e, headOid, listed };
}

const stewardListed = { number: 7, title: kitPr().title, url: kitPr().url, body: '', headRefName: 'claude/kit', headRefOid: kitHead, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], labels: [], additions: 5, deletions: 5, files: [{ path: 'kit/VERSION' }] };

/** gh as GitHub would answer: each repository's open PRs, no releases of the agents, comments and merges taken. */
function ctx(employees: Employee[], open: Record<string, unknown[]>, released: string[] = []) {
  const r = runner((a) => {
    const repo = a[a.indexOf('--repo') + 1];
    if (a[0] === 'pr' && a[1] === 'list') return ok(open[repo] ?? []);
    if (a[0] === 'pr' && (a[1] === 'comment' || a[1] === 'merge')) return ok('');
    if (a[0] === 'release' && a[1] === 'list') return ok([]);
    return undefined;
  });
  const c = ctxFor({ employees, workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp, released });
  return { c, r, comments: () => r.gh.filter((a) => a[1] === 'comment').map((a) => a[a.indexOf('--body') + 1]), merges: () => r.gh.filter((a) => a[1] === 'merge').map((a) => a[2]) };
}

test("the kit merges when the agent it fails moves with it in a PR that passes; that PR waits for the kit's release, then is tested and merges", async () => {
  const manor = agent('manor', 'Manor', 135, 2);
  const open = { 'Jcollier0120/Manor': [manor.listed], 'Jcollier0120/Steward': [stewardListed] };

  // The Steward's round: Manor's main fails with kit 1.0.1, but its #135, which pins 1.0.1, passes with it.
  const kit = ctx([manor.e], open);
  const said: string[] = [];
  const why = await kitTrialHold(kit.c, me, kitPr(), { note: (w) => said.push(w) });
  assert.equal(why, null, kit.c.lines.join('\n'));
  assert.deepEqual(said, ['Manor moves with it in #135 (passes with this kit)']);
  assert.ok(kit.c.lines.some((l) => l.startsWith('[manor] kit 1.0.1 trial: failed')), 'its main was tried, and failed');
  assert.ok(kit.c.lines.some((l) => l.startsWith('[manor] #135 with kit 1.0.1: passed')), kit.c.lines.join('\n'));
  const comments = kit.comments();
  assert.equal(comments.length, 1, 'one comment: why it merges, not a list of failures');
  assert.match(comments[0], /Manor fails its checks with it on main, but Manor moves with it in #135 \(passes with this kit\)\. So this PR merges/);
  const kept = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`7@${kitHead}`];
  assert.deepEqual(kept.pairs.map((p: { id: string; number: number; head: string; ok: boolean }) => [p.id, p.number, p.head, p.ok]), [['manor', 135, manor.headOid, true]]);
  assert.ok(!existsSync(trialDirOf(kit.c.settings, manor.e)) && !existsSync(kitTrialDirOf(kit.c)), 'nothing left behind');
  assert.equal(sh(manor.e.checkout, 'status', '--porcelain'), '');

  // Looked at again (its merge failed, say): the pair is kept by head commit, so nothing runs again or is said again.
  const again = ctx([manor.e], open);
  assert.equal(await kitTrialHold(again.c, me, kitPr()), null);
  assert.equal(again.comments().length, 0);
  assert.ok(!again.c.lines.some((l) => l.includes('with kit 1.0.1: ')), again.c.lines.join('\n'));

  // Manor's round while kit 1.0.1 isn't released: #135 waits for it, untested, and says which Steward PR brings it.
  const before = ctx([manor.e], open, ['1.0.0']);
  const waiting = await mergeOne(before.c, manor.e, { yes: true, team: true });
  assert.deepEqual(waiting.merged, []);
  assert.equal(waiting.held.find((h) => h.number === 135)?.why, "waits for kit 1.0.1, which Steward#7 brings: it merges once that's released (it passes with that kit here)");
  assert.equal(waiting.outcome, 'skipped', 'waiting for the kit is no failure');
  assert.equal(testedBefore(manor.e, { number: 135, headOid: manor.headOid } as PrInfo), null, 'not tested, so nothing is held against its commit');

  // A result kept before the Steward knew better: its checks "failed twice" at the kit's fill, the kit not yet released.
  writeJson(prChecksFile(), { [`manor#135@${manor.headOid}`]: { ok: false, note: `its checks failed here at ${manor.headOid.slice(0, 7)}, twice: node tools/kit.ts failed (exit 1)`, at: new Date().toISOString() } });

  // Kit 1.0.1 released (its release is what tools/kit.ts fetches; here, the Steward's kit tree stands in for it): #135
  // is tested again, passes, and merges.
  process.env.STEWARD_KIT = path.join(steward.checkout, 'kit');
  try {
    const released = ctx([manor.e], { ...open, 'Jcollier0120/Steward': [] }, ['1.0.1', '1.0.0']);
    const out = await mergeOne(released.c, manor.e, { yes: true, team: true });
    assert.deepEqual(out.merged.map((p) => p.number), [135], `${out.message}\n${released.c.lines.join('\n')}`);
    assert.match(out.message, /merged #135 \(checks passed here at .{7}\)/);
    assert.ok(released.c.lines.some((l) => l.includes('#135 failed at its kit\'s fill before kit 1.0.1 was released: tested here again')));
    assert.deepEqual(released.merges(), ['135']);
    assert.equal(testedBefore(manor.e, { number: 135, headOid: manor.headOid } as PrInfo)?.ok, true);
  } finally {
    delete process.env.STEWARD_KIT;
  }
});

test("the kit waits as before when the agent's PR that pins it fails too, or is a draft; and an agent PR with no Steward PR bringing its kit says so", async () => {
  // A second kit PR head, so this trial is its own.
  sh(steward.checkout, 'commit', '--quiet', '--allow-empty', '-m', 'Kit 1.0.1 again');
  sh(steward.checkout, 'push', '--quiet', 'origin', 'HEAD:refs/pull/8/head');
  const head8 = sh(steward.checkout, 'rev-parse', 'HEAD');
  const pr8 = kitPr({ number: 8, headOid: head8, url: 'https://github.com/Jcollier0120/Steward/pull/8' });

  const weigher = agent('weigher', 'Weigher', 20, 1);
  const drafty = agent('drafty', 'Drafty', 31, 2, { draft: true });
  const open = { 'Jcollier0120/Weigher': [weigher.listed], 'Jcollier0120/Drafty': [drafty.listed] };
  const kit = ctx([weigher.e, drafty.e], open);
  const why = await kitTrialHold(kit.c, me, pr8);
  assert.match(why ?? '', /^kit 1\.0\.1 fails 2 agents' checks here \(Weigher, Drafty\); Weigher's #20, which pins it, fails too; Drafty's #31 pins it, but is a draft: once it's ready, it is tried with this kit: .*label it kit:breaks-agents$/, kit.c.lines.join('\n'));
  assert.ok(kit.c.lines.some((l) => l.startsWith('[weigher] #20 with kit 1.0.1: failed')), 'the ready one was tried');
  assert.ok(!kit.c.lines.some((l) => l.startsWith('[drafty] #31 with kit')), 'a draft is not tried');
  const comments = kit.comments();
  assert.equal(comments.length, 1);
  assert.match(comments[0], /2 of 2 fail their checks with it/);
  assert.match(comments[0], /- \*\*Weigher\*\*: node check\.mjs failed \(exit 1\).*\(its #20, which pins this kit, fails too: its checks failed at .{7}, twice: node check\.mjs failed \(exit 1\)/);
  assert.match(comments[0], /- \*\*Drafty\*\*: .*\(its #31 pins this kit, but is a draft/);

  // Labelled: it merges as before, without trying the agents' PRs again.
  const labelled = ctx([weigher.e, drafty.e], open);
  assert.equal(await kitTrialHold(labelled.c, me, kitPr({ number: 8, headOid: head8, labels: ['kit:breaks-agents'] })), null);
  assert.ok(!labelled.c.lines.some((l) => l.includes('with kit 1.0.1: ')));

  // Weigher's PR waits for a kit no open Steward PR brings: a real problem, said so.
  const none = ctx([weigher.e], { ...open, 'Jcollier0120/Steward': [] }, ['1.0.0']);
  const out = await mergeOne(none.c, weigher.e, { yes: true, team: true });
  assert.equal(out.held.find((h) => h.number === 20)?.why, "pins kit 1.0.1, which isn't released, and no open Steward PR brings it: release that kit, or pin a released one");
  assert.deepEqual(none.merges(), []);
  assert.equal(testedBefore(weigher.e, { number: 20, headOid: weigher.headOid } as PrInfo), null, 'not tested either');
});
