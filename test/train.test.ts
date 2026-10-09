import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Merge trains: a repository's ready PRs in the version queue, stacked lowest version first, tested once at the top and
// merged together through the top PR.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-train-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { mergeOne } = await import('../src/stages/merge.ts');
const { canRide, trainCars, trainsFile } = await import('../src/stages/train.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const log = (...entries: [string, string][]) => ['# Changelog', '', 'Newest first.', '', ...entries.flatMap(([v, t]) => [`## ${v}`, '', t, ''])].join('\n');

/**
 * Fake at 0.4.0 (released), and PRs #31, #32, … written side by side from its main, each raising it one step (0.4.1,
 * 0.4.2, …) with a file and a changelog entry of its own: so each conflicts with the one under it in its version lines
 * and changelog, as PRs opened minutes apart do. `files` adds to one PR's files (by its index).
 */
function queue(name: string, n: number, files: Record<number, Record<string, string>> = {}) {
  const dir = path.join(home, name);
  const { origin, checkout } = fakeEmployee(dir, { version: '0.4.0', files: { 'CHANGELOG.md': log(['0.4.0', 'The first.']) } });
  const write = (f: string, t: string) => (mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true }), writeFileSync(path.join(checkout, f), t));
  const read = (f: string) => readFileSync(path.join(checkout, f), 'utf8');
  const prs: { number: number; head: string; oid: string; version: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const version = `0.4.${i}`;
    const head = `claude/f${i}`;
    sh(checkout, 'switch', '--quiet', '-c', head, 'main');
    for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) write(f, read(f).split('0.4.0').join(version));
    write(`src/f${i}.ts`, `export const f${i} = ${i};\n`);
    write('CHANGELOG.md', log([version, `Feature ${i}.`], ['0.4.0', 'The first.']));
    for (const [f, t] of Object.entries(files[i] ?? {})) write(f, t);
    sh(checkout, 'add', '-A');
    sh(checkout, 'commit', '--quiet', '-m', `Fake ${version}: feature ${i}`);
    sh(checkout, 'push', '--quiet', 'origin', head);
    const oid = sh(checkout, 'rev-parse', 'HEAD');
    sh(origin, 'update-ref', `refs/pull/${30 + i}/head`, oid);
    prs.push({ number: 30 + i, head, oid, version });
  }
  sh(checkout, 'switch', '--quiet', 'main');
  const listed = () =>
    prs.map((p) => ({ number: p.number, title: `Fake ${p.version}: feature`, url: `https://github.com/Jcollier0120/Fake/pull/${p.number}`, body: '', headRefName: p.head, headRefOid: p.oid, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], labels: [], additions: 5, deletions: 1, files: [] }));
  return { dir, origin, checkout, prs, listed };
}

/** GitHub as the train needs it: the PRs, Fake's releases, a merge that moves main to the commit it names, and each PR's state. */
function github(q: ReturnType<typeof queue>, state: (n: number) => string = () => 'MERGED') {
  return runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list') return ok(q.listed());
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' }]);
    if (a[0] === 'pr' && a[1] === 'merge') {
      sh(q.origin, 'update-ref', 'refs/heads/main', a[a.indexOf('--match-head-commit') + 1]);
      return ok('');
    }
    if (a[0] === 'pr' && a[1] === 'view' && a.includes('state')) return ok({ state: state(Number(a[2])) });
    return ok('');
  });
}

const ctxOf = (q: ReturnType<typeof queue>, run: ReturnType<typeof runner>['run'], more: Parameters<typeof employee>[1] = {}) => {
  const e = employee(q.checkout, { fill: '', ...more });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(q.dir, 'work'), run, neutralDir: q.dir });
  ctx.settings.mergeTrain = true;
  return { e, ctx };
};

test('three ready PRs in the queue merge as one train: stacked lowest first, tested once, merged through the top one', async () => {
  const q = queue('three', 3);
  const gh = github(q, (n) => (n === 32 ? 'OPEN' : 'MERGED'));
  const { e, ctx } = ctxOf(q, gh.run);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(r.outcome, 'done', r.message);
  assert.deepEqual(r.merged.map((p) => p.number), [31, 32, 33]);
  assert.match(r.message, /^merged #31, #32, #33 as one train \(stacked on main lowest version first and tested once, at [0-9a-f]{7}\)$/);
  assert.equal(r.lookAgain, true, 'the next look takes what is left');

  // One merge, of the top PR, at the stack its branch was moved on to (a fast forward: its own head under it).
  const merges = gh.gh.filter((a) => a[1] === 'merge');
  assert.equal(merges.length, 1);
  const at = merges[0][merges[0].indexOf('--match-head-commit') + 1];
  assert.deepEqual(merges[0].slice(0, 6), ['pr', 'merge', '33', '--repo', 'Jcollier0120/Fake', '--merge']);
  assert.equal(sh(q.origin, 'rev-parse', 'refs/heads/claude/f3'), at);
  for (const p of q.prs) assert.equal(sh(q.origin, 'merge-base', '--is-ancestor', p.oid, 'refs/heads/main'), '', `#${p.number}'s commits are in main`);

  // Main now: every PR's file, the top version, and each PR's changelog entry under its own version, newest first.
  const show = (f: string) => sh(q.origin, 'show', `refs/heads/main:${f}`);
  for (const i of [1, 2, 3]) assert.match(show(`src/f${i}.ts`), new RegExp(`f${i} = ${i}`));
  assert.equal(JSON.parse(show('package.json')).version, '0.4.3');
  const lock = JSON.parse(show('package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version], ['0.4.3', '0.4.3']);
  assert.match(show('src/app.ts'), /version: '0\.4\.3'/);
  assert.equal(show('CHANGELOG.md'), log(['0.4.3', 'Feature 3.'], ['0.4.2', 'Feature 2.'], ['0.4.1', 'Feature 1.'], ['0.4.0', 'The first.']).trimEnd());

  // Tested once, at the top: no PR tested on its own.
  const lines = ctx.lines.join('\n');
  assert.match(lines, /a train of #31, #32, #33 \(v0\.4\.1 to v0\.4\.3\) stacked at [0-9a-f]{7}: its checks, once/);
  assert.doesNotMatch(lines, /has no checks on GitHub: testing it here/);
  // The top PR says what came in with it; #31, marked merged, says so; #32, which GitHub didn't mark, is closed saying why.
  const said = (n: string, verb: string) => gh.gh.find((a) => a[0] === 'pr' && a[1] === verb && a[2] === n);
  assert.match(said('33', 'comment')!.at(-1)!, /^Merged by the Steward as one train with #31, #32: stacked on main/);
  assert.match(said('31', 'comment')!.at(-1)!, /^Merged by the Steward in one train with #33/);
  assert.match(said('32', 'close')!.at(-1)!, /GitHub didn't mark it merged, so the Steward closed it\.$/);
  assert.ok(!existsSync(path.join(q.dir, 'work', 'fake-train')), 'its worktree is gone');
});

test("a train whose checks fail merges nothing as a train, isn't built again for the same heads, and the PRs go one at a time", async () => {
  const q = queue('fails', 2);
  const gh = github(q);
  const { e, ctx } = ctxOf(q, gh.run, { test: ['node -e process.exit(1)'] });
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.deepEqual(r.merged, []);
  assert.match(r.message, /^didn't merge #31, #32 as one train: #31, #32 stacked, but .*: they merge one at a time/);
  assert.deepEqual(gh.gh.filter((a) => a[1] === 'merge'), [], 'nothing merged: #31 failed on its own too');
  assert.match(ctx.lines.join('\n'), /#31 has no checks on GitHub: testing it here/, 'one at a time, as without trains');
  const kept = JSON.parse(readFileSync(trainsFile(), 'utf8')).fake;
  assert.equal(kept.key, [sh(q.origin, 'rev-parse', 'refs/heads/main'), ...q.prs.map((p) => `${p.number}@${p.oid}`)].join(' '));

  // The next look: the same branch and heads, so it isn't built and tested again.
  const again = github(q);
  const next = ctxOf(q, again.run, { test: ['node -e process.exit(1)'] });
  await mergeOne(next.ctx, next.e, { yes: true, team: true });
  assert.match(next.ctx.lines.join('\n'), /no train for #31, #32: the same train failed before/);
  assert.doesNotMatch(next.ctx.lines.join('\n'), /a train of/);
});

test('a PR that conflicts beyond its version lines ends the train: the ones under it merge together, it goes its own way', async () => {
  // #33 writes src/f1.ts too, which #31 brings: a conflict a person must settle.
  const q = queue('cut', 3, { 3: { 'src/f1.ts': 'export const f1 = 100;\n' } });
  const gh = github(q);
  const { e, ctx } = ctxOf(q, gh.run);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.deepEqual(r.merged.map((p) => p.number), [31, 32]);
  assert.match(r.message, /as one train \(.*; #33 goes its own way: it conflicts with #32 in src\/f1\.ts\)$/);
  assert.deepEqual(gh.gh.filter((a) => a[1] === 'merge').map((a) => a[2]), ['32']);
  assert.equal(sh(q.origin, 'rev-parse', 'refs/heads/claude/f3'), q.prs[2].oid, "#33's branch untouched");
  // What was tested and merged is the stack of #31 and #32, not #33's head left checked out when it couldn't ride.
  assert.match(sh(q.origin, 'show', 'refs/heads/main:src/f1.ts'), /f1 = 1;/);
  assert.equal(JSON.parse(sh(q.origin, 'show', 'refs/heads/main:package.json')).version, '0.4.2');
});

test('which PRs ride: the queue from its lowest version up, while each can; a draft, checks on GitHub or steps after merging stop it', () => {
  const pr = (number: number, more: Partial<PrInfo> = {}): PrInfo => ({ number, title: '', url: '', head: `claude/f${number}`, base: 'main', author: 'Jcollier0120', whose: 'team', headOid: `${number}abc`, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 1, files: [], fork: false, ...more }) as PrInfo;
  const pending = new Map([[31, '0.4.1'], [32, '0.4.2'], [33, '0.4.3']]);
  const numbers = (prs: PrInfo[], p = pending) => trainCars(prs, p, 'main').map((c) => c.pr.number);
  assert.deepEqual(numbers([pr(33), pr(31), pr(32)]), [31, 32, 33], 'by version, whatever order GitHub lists them in');
  assert.deepEqual(numbers([pr(31), pr(32, { draft: true }), pr(33)]), [], 'a draft holds its place: only #31 would ride, and one is no train');
  assert.deepEqual(numbers([pr(31), pr(32), pr(33, { checks: 'passing' })]), [31, 32], 'checks on GitHub: not on a train');
  assert.deepEqual(numbers([pr(31), pr(32), pr(33, { after: { steps: ['release'] } } as Partial<PrInfo>)]), [31, 32], 'steps after merging: on its own');
  assert.deepEqual(numbers([pr(31, { draft: true }), pr(32), pr(33)]), [], 'the lowest a draft: nothing rides');
  assert.deepEqual(numbers([pr(31), pr(32)], new Map([[31, '0.4.1'], [32, '0.4.1']])), [], 'two on one version: no train');
  assert.equal(canRide(pr(31, { fork: true }), 'main'), false);
  assert.equal(canRide(pr(31, { labels: ['wright'] }), 'main'), false, "the Wright's is reviewed on its own");
  assert.equal(canRide(pr(31, { files: ['kit/VERSION'] }), 'main'), false, 'one that raises the kit waits for its trial');
  assert.equal(canRide(pr(31, { whose: 'steward' }), 'main'), false);
  // Written as changes/<version>.md: stamped just before it merges (stages/stamp.ts), and merged alone, untested again.
  assert.equal(canRide(pr(31, { files: ['src/a.ts', 'changes/0.4.1.md'] }), 'main'), false, "a stamped PR doesn't ride: it merges alone after its stamp");
  assert.equal(canRide(pr(31, { files: ['kit/changes/2.44.1.md'] }), 'main'), false);
  assert.equal(canRide(pr(31, { files: ['changes/README.md'] }), 'main'), true, 'the folder alone is no entry');
});

test("a PR that needs the owner first (labelled owner-first, or changing a migration) is never merged by the Steward, nor put on a train", async () => {
  const { holdReason } = await import('../src/stages/merge.ts');
  const pr = (more: Partial<PrInfo> = {}): PrInfo => ({ number: 7, title: '', url: '', head: 'claude/x', base: 'main', author: 'Jcollier0120', whose: 'team', headOid: 'abc', after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 1, files: ['src/a.ts'], fork: false, ...more }) as PrInfo;
  assert.equal(holdReason(pr(), 'main'), null);
  assert.match(holdReason(pr({ labels: ['owner-first'] }), 'main')!, /^labelled owner-first: it needs you first/);
  assert.match(holdReason(pr({ files: ['supabase/migrations/20261009_x.sql'] }), 'main')!, /^it changes supabase\/migrations\/20261009_x\.sql, which may need you to run it first/);
  assert.match(holdReason(pr({ files: ['db/fix.sql'] }), 'main')!, /label it owner-done$/);
  assert.equal(holdReason(pr({ files: ['db/fix.sql'], labels: ['owner-done'] }), 'main'), null, 'once the owner has run it');
  assert.match(holdReason(pr({ files: ['db/fix.sql'], labels: ['owner-done', 'owner-first'] }), 'main')!, /^labelled owner-first/, 'owner-first wins');
  assert.equal(canRide(pr({ labels: ['owner-first'] }), 'main'), false);
  assert.equal(canRide(pr({ files: ['supabase/migrations/1.sql'] }), 'main'), false);
  assert.equal(canRide(pr(), 'main'), true);

  // In a round: the queue's lowest needs the owner, so nothing above it merges or rides either.
  const q = queue('owner', 2);
  const gh = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list') return ok(q.listed().map((p) => (p.number === 31 ? { ...p, labels: [{ name: 'owner-first' }] } : p)));
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' }]);
    return ok('');
  });
  const { e, ctx } = ctxOf(q, gh.run);
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.deepEqual(r.merged, []);
  assert.deepEqual(gh.gh.filter((a) => a[1] === 'merge'), []);
  assert.match(r.held.find((h) => h.number === 31)!.why, /^labelled owner-first/);
  assert.match(r.held.find((h) => h.number === 32)!.why, /its turn comes after #31/);
});
