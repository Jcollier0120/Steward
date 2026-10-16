import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A build's batch (stages/build.ts): a repository's ready PRs that write fragments, stacked in the order they went ready
// behind the kit's PR, stamped and tested once; when the batch fails, tried once more, halved to find the PR that broke
// it, that PR dropped back to a draft (or the kit's PR left out), and the rest shipped or kept for the next build.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-build-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { mergeOne } = await import('../src/stages/merge.ts');
const { bisect, buildCars, buildLeftFile, canBoard, loadBuildLeft, noteReady, readySinceFile } = await import('../src/stages/build.ts');
const { kickbacksFile } = await import('../src/stages/kickback.ts');
const { rolloutFailedFile } = await import('../src/stages/rollout.ts');
const { checksOf } = await import('../src/stages/staff.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { DEFAULT_PIPELINE } = await import('../src/pipeline.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;
type Glance = import('../src/glance.ts').Glance;

const log = (...entries: [string, string][]) => ['# Changelog', '', 'Newest first.', '', ...entries.flatMap(([v, t]) => [`## ${v}`, '', t, ''])].join('\n');
const fragment = (i: number) => [`**Feature ${i}.**`, '', "### What's new", '', `- Feature ${i}.`, '', '### Before you update', '', '- Nothing: it updates itself as usual.', ''].join('\n');

/** The checks: they fail where every file of one of bad.json's sets is there together. */
const CHECK = "const fs = require('fs');\nconst bad = JSON.parse(fs.readFileSync('bad.json', 'utf8'));\nprocess.exit(bad.some((set) => set.every((f) => fs.existsSync(f))) ? 1 : 0);\n";

/**
 * Fake at 0.4.0 (released), writing its entries in changes/, and PRs #31, #32, … from its main, each adding src/f<i>.ts
 * and its fragment changes/claude-f<i>.md, opened (and gone ready) in that order. `bad`: the sets of files whose
 * meeting breaks the checks. `kit`: the Steward's kit PR #30 first (steward/kit-2.70.0), raising Fake to 0.4.1 and adding kit.flag.
 */
function batch(name: string, n: number, o: { bad?: string[][]; kit?: boolean } = {}) {
  // What an earlier test's build left out of Fake's batch isn't this one's.
  rmSync(buildLeftFile(), { force: true });
  const dir = path.join(home, name);
  const { origin, checkout } = fakeEmployee(dir, { version: '0.4.0', files: { 'CHANGELOG.md': log(['0.4.0', 'The first.']), 'changes/README.md': 'Entries go here.\n', 'check.cjs': CHECK, 'bad.json': JSON.stringify(o.bad ?? []) } });
  const write = (f: string, t: string) => (mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true }), writeFileSync(path.join(checkout, f), t));
  const read = (f: string) => readFileSync(path.join(checkout, f), 'utf8');
  const prs: { number: number; head: string; oid: string; files: string[]; whose: 'team' | 'steward' }[] = [];
  const open = (number: number, head: string, files: Record<string, string>, whose: 'team' | 'steward') => {
    sh(checkout, 'switch', '--quiet', '-c', head, 'main');
    for (const [f, t] of Object.entries(files)) write(f, t);
    sh(checkout, 'add', '-A');
    sh(checkout, 'commit', '--quiet', '-m', `#${number}`);
    sh(checkout, 'push', '--quiet', 'origin', head);
    const oid = sh(checkout, 'rev-parse', 'HEAD');
    sh(origin, 'update-ref', `refs/pull/${number}/head`, oid);
    prs.push({ number, head, oid, files: Object.keys(files), whose });
    sh(checkout, 'switch', '--quiet', 'main');
  };
  if (o.kit) {
    const files: Record<string, string> = { 'kit.flag': 'kit 2.70.0\n', 'CHANGELOG.md': log(['0.4.1', 'Kit 2.70.0.'], ['0.4.0', 'The first.']) };
    for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) files[f] = read(f).split('0.4.0').join('0.4.1');
    open(30, 'steward/kit-2.70.0', files, 'steward');
  }
  for (let i = 1; i <= n; i++) open(30 + i, `claude/f${i}`, { [`src/f${i}.ts`]: `export const f${i} = ${i};\n`, [`changes/claude-f${i}.md`]: fragment(i) }, 'team');
  const listed = () =>
    prs.map((p) => ({ number: p.number, title: p.whose === 'steward' ? 'Fake 0.4.1: kit 2.70.0' : `Feature ${p.number - 30}`, url: `https://github.com/Jcollier0120/Fake/pull/${p.number}`, body: '', createdAt: `2026-10-13T0${p.number - 29}:00:00Z`, headRefName: p.head, headRefOid: p.oid, baseRefName: 'main', isCrossRepository: false, author: { login: p.whose === 'steward' ? 'app/steward' : 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], labels: [], additions: 5, deletions: 0, files: p.files.map((f) => ({ path: f })) }));
  return { dir, origin, checkout, prs, listed };
}

/** GitHub as a build needs it: the PRs, Fake's releases, a merge that moves main to the commit it names, and each PR's state. */
function github(b: ReturnType<typeof batch>) {
  return runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list') return ok(b.listed());
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' }]);
    if (a[0] === 'pr' && a[1] === 'merge') {
      sh(b.origin, 'update-ref', 'refs/heads/main', a[a.indexOf('--match-head-commit') + 1]);
      return ok('');
    }
    if (a[0] === 'pr' && a[1] === 'view' && a.includes('state')) return ok({ state: 'MERGED' });
    return ok('');
  });
}

const BUILD = { due: '2026-10-13T11:00:00.000Z', name: 'the 13:00 build' };

function ctxOf(b: ReturnType<typeof batch>, run: ReturnType<typeof runner>['run'], bisectRuns = 3) {
  const e = employee(b.checkout, { fill: '', test: ['node check.cjs'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(b.dir, 'work'), run, neutralDir: b.dir });
  ctx.settings.buildPipeline = { ...DEFAULT_PIPELINE, on: true, bisectRuns };
  ctx.settings.mergeMinAgeMinutes = 0;
  ctx.build = BUILD;
  return { e, ctx };
}

const show = (b: ReturnType<typeof batch>, f: string) => sh(b.origin, 'show', `refs/heads/main:${f}`);
const statuses = (gh: string[][]) => gh.filter((a) => a[0] === 'api' && a[2] === 'POST').map((a) => [a[3].split('/').pop()!, a[5], a[9]]);
const runs = (lines: string[]) => lines.filter((l) => /node check\.cjs: /.test(l)).length;

test('a batch that passes: stacked behind the kit PR in the order they went ready, stamped once into one version, tested once, merged through its top', async () => {
  const b = batch('passes', 2, { kit: true });
  const gh = github(b);
  const { e, ctx } = ctxOf(b, gh.run);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(r.outcome, 'done', r.message);
  assert.deepEqual(r.merged.map((p) => p.number), [30, 31, 32]);
  assert.match(r.message, /^merged #30, #31, #32 in the 13:00 build \(stacked on main in the order they went ready and tested once, at [0-9a-f]{7}\)$/);
  assert.equal(runs(ctx.lines), 1, 'one test run');
  // One merge, of the top PR: the kit's version, and the fragments joined to its entry.
  assert.deepEqual(gh.gh.filter((a) => a[1] === 'merge').map((a) => a[2]), ['32']);
  assert.equal(JSON.parse(show(b, 'package.json')).version, '0.4.1');
  const changelog = show(b, 'CHANGELOG.md');
  assert.match(changelog, /## 0\.4\.1/);
  assert.match(changelog, /Feature 1\./);
  assert.match(changelog, /Feature 2\./);
  assert.equal(changelog.match(/^## 0\.4\.1$/gm)?.length, 1, 'one entry for the version');
  assert.equal(sh(b.origin, 'ls-tree', '--name-only', 'refs/heads/main', 'changes/'), 'changes/README.md', 'the fragments are gone');
  assert.deepEqual(statuses(gh.gh).map((s) => [s[0], s[1], s[2]]), b.prs.map((p) => [p.oid, 'state=success', 'description=left in the 13:00 build']));
});

test('a batch prepared between builds is tested then, merges nothing, and the build merges it without testing it again', async () => {
  // Three PRs: a tree of its own, which no other test's pass stands in for.
  const b = batch('prepared', 3, { kit: true });
  const gh = github(b);
  const { e, ctx } = ctxOf(b, gh.run);
  const main = sh(b.origin, 'rev-parse', 'refs/heads/main');
  ctx.build = null;
  ctx.prepare = BUILD;
  const prep = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(prep.outcome, 'skipped', prep.message);
  assert.match(prep.message, /^#30, #31, #32, #33: stacked in the order they went ready and passed here: the 13:00 build merges them without testing them again/);
  assert.equal(runs(ctx.lines), 1, 'tested once, ahead of the build');
  assert.equal(gh.gh.filter((a) => a[1] === 'merge').length, 0, 'nothing merged');
  assert.equal(sh(b.origin, 'rev-parse', 'refs/heads/main'), main, 'nothing pushed to main');
  assert.deepEqual(statuses(gh.gh), [], 'no status on the PRs until the build');

  ctx.lines.length = 0;
  ctx.prepare = null;
  ctx.build = BUILD;
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(r.outcome, 'done', r.message);
  assert.deepEqual(r.merged.map((p) => p.number), [30, 31, 32, 33]);
  assert.equal(runs(ctx.lines), 0, 'the same tree passed ahead of the build: not tested again');
  assert.match(ctx.lines.join('\n'), /on exactly this code \(tree [0-9a-f]{7}\): not run again/);
  assert.equal(JSON.parse(show(b, 'package.json')).version, '0.4.1');
});

test('the PR that clashes with one under it is found by halving, dropped back to a draft with a comment, and the rest leave', async () => {
  // #32 breaks with #31; #33 is fine with both.
  const b = batch('middle', 3, { bad: [['src/f1.ts', 'src/f2.ts']] });
  const gh = github(b);
  const { e, ctx } = ctxOf(b, gh.run);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(r.outcome, 'done', r.message);
  assert.deepEqual(r.merged.map((p) => p.number), [31, 33]);
  assert.match(r.message, /dropped #32 \(node check\.cjs failed \(exit 1\)\)/);
  // The stack twice (once more for a flaky test), the first one and the first two (halving), and #31 and #33 without #32.
  assert.equal(runs(ctx.lines), 5);
  assert.ok(!existsSync(path.join(b.dir, 'work', 'fake-build')), 'its worktree is gone');
  assert.match(show(b, 'src/f3.ts'), /f3 = 3/);
  assert.throws(() => show(b, 'src/f2.ts'), "#32's work isn't in main");
  assert.equal(JSON.parse(show(b, 'package.json')).version, '0.4.1');

  // #32: a draft again, told what failed and whom it clashed with, its status failed; kept beside the conflicts sent back.
  assert.ok(gh.gh.some((a) => a.join(' ') === 'pr ready 32 --repo Jcollier0120/Fake --undo'));
  const comment = gh.gh.find((a) => a[0] === 'pr' && a[1] === 'comment' && a[2] === '32')!.at(-1)!;
  assert.match(comment, /^The Steward took this out of the 13:00 build/);
  assert.match(comment, /It clashed with #31, under it in the build, which passed without it: node check\.cjs failed \(exit 1\)\./);
  assert.match(comment, /Over to the Claude Code session that opened it: merge `main` into `claude\/f2`/);
  assert.deepEqual(statuses(gh.gh).find((s) => s[0] === b.prs[1].oid), [b.prs[1].oid, 'state=failure', 'description=dropped from the 13:00 build: node check.cjs failed (exit 1)']);
  const kicked = JSON.parse(readFileSync(kickbacksFile(), 'utf8'))['Jcollier0120/Fake#32'];
  assert.equal(kicked.build, 'the 13:00 build');
  assert.deepEqual(loadBuildLeft().fake.dropped, [32]);

  // The next look in the same build: #32 (GitHub still lists it ready) doesn't board or merge on its own.
  b.prs.splice(0, b.prs.length, b.prs[1]);
  const again = github(b);
  const next = ctxOf(b, again.run);
  const r2 = await mergeOne(next.ctx, next.e, { yes: true, team: true });
  assert.deepEqual(r2.merged, []);
  assert.match(r2.held.find((h) => h.number === 32)!.why, /^left out of the 13:00 build: it waits for the next build$/);
  assert.equal(again.gh.filter((a) => a[1] === 'merge').length, 0);
});

test('the top PR that breaks the batch: the ones under it leave, already tested; it is dropped, clashing with one of them', async () => {
  const b = batch('top', 3, { bad: [['src/f1.ts', 'src/f3.ts']] });
  const gh = github(b);
  const { e, ctx } = ctxOf(b, gh.run);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.deepEqual(r.merged.map((p) => p.number), [31, 32]);
  assert.equal(runs(ctx.lines), 4, 'the stack twice, then the first one and the first two: nothing left to test without it');
  const comment = gh.gh.find((a) => a[0] === 'pr' && a[1] === 'comment' && a[2] === '33')!.at(-1)!;
  assert.match(comment, /It clashed with one of #31, #32, under it in the build/);
});

test("halving that can't find one PR within bisectRuns: the prefix that passed leaves, the rest wait for the next build, with an alarm", async () => {
  // #33 and #34 break together: with one halving, the first two pass, and the last two can't be told apart.
  const b = batch('cap', 4, { bad: [['src/f3.ts', 'src/f4.ts']] });
  const gh = github(b);
  const { e, ctx } = ctxOf(b, gh.run, 1);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.deepEqual(r.merged.map((p) => p.number), [31, 32]);
  assert.match(r.message, /kept #33, #34 for the next build: they failed together \(node check\.cjs failed \(exit 1\)\), and 1 test run \(Settings: bisectRuns\) didn't find one PR that broke them/);
  assert.equal(runs(ctx.lines), 3);
  assert.ok(!gh.gh.some((a) => a[1] === 'ready'), 'none turned into a draft');
  const left = loadBuildLeft().fake;
  assert.deepEqual(left.kept.map((k) => k.number), [33, 34]);
  for (const p of b.prs.slice(2)) assert.deepEqual(statuses(gh.gh).find((s) => s[0] === p.oid)?.[1], 'state=success');
  const conditions = roundConditions({ round: { stage: 'round', started: '', finished: '', kit: null, asked: {}, results: [], log: [] }, held: [], failedReleases: {}, buildLeft: loadBuildLeft(), employees: [e], settings: ctx.settings });
  const alarm = conditions.find((c) => c.id === `build:fake:${BUILD.due}`)!;
  assert.equal(alarm.title, "Fake #33, #34 didn't leave in the 13:00 build, and wait for the next build");
  assert.equal(alarm.afterMs, 0);

  // A new build: they board again.
  b.prs.splice(0, 2);
  const next = ctxOf(b, github(b).run, 1);
  next.ctx.build = { due: '2026-10-13T16:00:00.000Z', name: 'the 18:00 build' };
  const r2 = await mergeOne(next.ctx, next.e, { yes: true, team: true });
  assert.ok(next.ctx.lines.some((l) => l.includes('the 18:00 build: #33, #34 stacked on main')), [r2.message, ...next.ctx.lines].join('\n'));
  assert.equal(loadBuildLeft().fake?.due, '2026-10-13T16:00:00.000Z', "the 13:00 build's record is gone");
});

test('when nothing at the bottom of the stack passes, nothing leaves', async () => {
  const b = batch('none', 2, { bad: [['src/f1.ts']] });
  const gh = github(b);
  const { e, ctx } = ctxOf(b, gh.run, 0);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.deepEqual(r.merged, []);
  assert.equal(r.outcome, 'failed');
  assert.match(r.message, /no PRs at the bottom of the stack passed: none of them leaves in the 13:00 build/);
  assert.equal(gh.gh.filter((a) => a[1] === 'merge').length, 0);
  assert.equal(runs(ctx.lines), 2, 'bisectRuns 0: no halving');
});

test("the kit's PR that breaks the batch: left out, not a draft, the agent on its old kit with the rollout's alarm; the rest leave", async () => {
  rmSync(rolloutFailedFile(), { force: true });
  const b = batch('kit', 2, { kit: true, bad: [['kit.flag']] });
  const gh = github(b);
  const { e, ctx } = ctxOf(b, gh.run);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.deepEqual(r.merged.map((p) => p.number), [31, 32]);
  assert.equal(JSON.parse(show(b, 'package.json')).version, '0.4.1', `the fragments take the next version: ${[r.message, ...ctx.lines].join('\n')}`);
  assert.throws(() => show(b, 'kit.flag'));
  assert.ok(!gh.gh.some((a) => a[1] === 'ready'), "the kit's PR stays as it is");
  const held = JSON.parse(readFileSync(rolloutFailedFile(), 'utf8')).fake;
  assert.deepEqual([held.kit, held.head, held.stage], ['2.70.0', b.prs[0].oid, 'build']);
  const conditions = roundConditions({ round: { stage: 'round', started: '', finished: '', kit: null, asked: {}, results: [], log: [] }, held: [], failedReleases: {}, failedRollouts: { fake: held }, employees: [e], settings: ctx.settings });
  assert.match(conditions.find((c) => c.id === 'rollout:fake:2.70.0')!.title, /^Fake's kit PR to kit 2\.70\.0 broke its build, so Fake left without it and stays on its old kit$/);

  // A later look, in a build or not: the kit's PR at that head doesn't board or merge.
  b.prs.splice(1);
  const later = ctxOf(b, github(b).run);
  later.ctx.build = null;
  const r2 = await mergeOne(later.ctx, later.e, { yes: true, team: true });
  assert.match(r2.held.find((h) => h.number === 30)!.why, /^it broke a build's checks/);
});

test('which PRs board: the kit PR first, then those that write fragments in the order they went ready', () => {
  const pr = (number: number, more: Partial<PrInfo> = {}): PrInfo => ({ number, title: '', url: '', head: `claude/f${number}`, base: 'main', author: 'Jcollier0120', whose: 'team', headOid: `${number}abc`, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 1, files: [`changes/claude-f${number}.md`], fork: false, createdAt: `2026-10-13T0${number % 10}:00:00Z`, ...more }) as PrInfo;
  const kit = pr(40, { whose: 'steward', head: 'steward/kit-2.70.0', files: ['kit.json'] });
  const order = (prs: PrInfo[], o: Partial<Parameters<typeof buildCars>[1]> = {}) => buildCars(prs, { id: 'fake', branch: 'main', since: {}, ...o }).map((c) => c.pr.number);
  assert.deepEqual(order([pr(33), pr(31), kit, pr(32)]), [40, 31, 32, 33], 'by when each was opened, the kit PR first');
  assert.deepEqual(order([pr(31), pr(32), pr(33)], { since: { 'fake#31': '2026-10-13T09:30:00Z', 'fake#33': '2026-10-13T01:00:00Z' } }), [33, 32, 31], 'by when it went ready, where the rounds saw it');
  assert.deepEqual(order([pr(31), pr(32), pr(33)], { left: [32] }), [31, 33], 'one this build left out');
  assert.deepEqual(order([kit, pr(31)], { kitHeld: { kit: '2.70.0', head: '40abc', stage: 'build', message: '', at: '' } }), [31], 'the kit PR a build left out at that head');
  assert.deepEqual(order([kit, pr(31)], { kitHeld: { kit: '2.70.0', head: 'older', stage: 'build', message: '', at: '' } }), [40, 31], 'moved on since: it rides again');
  assert.equal(canBoard(pr(31), 'main'), true);
  assert.equal(canBoard(pr(31, { files: ['src/a.ts'] }), 'main'), false, 'no fragment: it sets a version, and goes the usual way');
  assert.equal(canBoard(pr(31, { files: ['changes/0.4.1.md'] }), 'main'), false, 'changes/<version>.md is stamped alone');
  assert.equal(canBoard(pr(31, { files: ['changes/a.md', 'changes/0.4.1.md'] }), 'main'), false);
  assert.equal(canBoard(pr(31, { files: ['changes/README.md'] }), 'main'), false);
  assert.equal(canBoard(pr(31, { draft: true }), 'main'), false);
  assert.equal(canBoard(pr(31, { labels: ['wright'] }), 'main'), false);
  assert.equal(canBoard(pr(31, { labels: ['owner-first'] }), 'main'), false);
  assert.equal(canBoard(pr(31, { checks: 'failing' }), 'main'), false);
  assert.equal(canBoard(pr(31, { mergeState: 'BEHIND' }), 'main'), true, 'behind its branch: the stack brings the branch in');
});

test('when each PR went ready: seen ready after a draft, now; first seen ready, when it was opened; closed, forgotten', () => {
  rmSync(readySinceFile(), { force: true });
  const g = (prs: { number: number; isDraft: boolean }[], more: Record<string, unknown> = {}) => ({ at: '', stewardReleases: null, repos: { fake: { head: null, releases: [], prs: prs.map((p) => ({ ...p, createdAt: `2026-10-13T0${p.number % 10}:00:00Z` })) }, ...more }, errors: {} }) as unknown as Glance;
  const read = () => JSON.parse(readFileSync(readySinceFile(), 'utf8'));
  noteReady(g([{ number: 31, isDraft: false }, { number: 32, isDraft: true }]), new Date('2026-10-13T10:00:00Z'));
  assert.deepEqual(read(), { 'fake#31': '2026-10-13T01:00:00Z', 'fake#32': null });
  noteReady(g([{ number: 31, isDraft: false }, { number: 32, isDraft: false }]), new Date('2026-10-13T10:10:00Z'));
  assert.deepEqual(read(), { 'fake#31': '2026-10-13T01:00:00Z', 'fake#32': '2026-10-13T10:10:00.000Z' });
  noteReady(g([{ number: 32, isDraft: false }]), new Date('2026-10-13T10:20:00Z'));
  assert.deepEqual(read(), { 'fake#32': '2026-10-13T10:10:00.000Z' });
});

test('halving by prefix: the first car that breaks the stack, within the runs allowed', async () => {
  // Breaks once the prefix has `bad` cars or more.
  const find = (n: number, bad: number, cap = 3) => {
    const tried: number[] = [];
    return bisect(n, cap, 'stack failed', async (k) => (tried.push(k), k >= bad ? `failed at ${k}` : null)).then((r) => ({ ...r, tried }));
  };
  assert.deepEqual(await find(2, 2), { passed: 1, failed: 2, runs: 1, why: 'stack failed', tried: [1] });
  assert.deepEqual(await find(4, 1), { passed: 0, failed: 1, runs: 2, why: 'failed at 1', tried: [2, 1] });
  assert.deepEqual(await find(8, 6), { passed: 5, failed: 6, runs: 3, why: 'failed at 6', tried: [4, 6, 5] });
  const capped = await find(8, 6, 1);
  assert.deepEqual([capped.passed, capped.failed, capped.runs], [4, 8, 1], 'out of runs: the prefix that passed, and the rest not told apart');
  const ended = await bisect(4, 3, 'x', async () => 'npm test failed (exit 1073807364)');
  assert.equal(ended.ended, 'npm test failed (exit 1073807364)');
});

test("the build's status on a PR isn't one of its checks", () => {
  assert.equal(checksOf([{ __typename: 'StatusContext', context: 'steward/build', state: 'FAILURE' }]), 'none');
  assert.equal(checksOf([{ __typename: 'StatusContext', context: 'steward/build', state: 'SUCCESS' }, { __typename: 'StatusContext', context: 'ci', state: 'PENDING' }]), 'pending');
});
