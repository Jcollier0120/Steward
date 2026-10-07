import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Catching a team PR up with its branch: the branch merged into it, a conflict resolved only in its version lines,
// the next free version when its own is taken; anything else left to a person, untouched.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-catchup-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { catchUp, catchUpVersion, mergeChangelogs, mergeKitPins, renumberChangelog, resolveVersionConflicts } = await import('../src/stages/catchup.ts');
const { kickbacksFile } = await import('../src/stages/kickback.ts');
const { mergeOne } = await import('../src/stages/merge.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const conflict = (ours: string[], base: string[], theirs: string[]) => ['{', '<<<<<<< HEAD', ...ours, '||||||| abc1234', ...base, '=======', ...theirs, '>>>>>>> origin/main', '}'].join('\n');

test('a conflict where one side changed only versions gives way to the other; any other conflict is left', () => {
  // Pinder#21's: the PR raised the lock's version, main added a licence beside it.
  const lock = conflict(['      "version": "0.4.11",'], ['      "version": "0.4.10",'], ['      "version": "0.4.10",', '      "license": "UNLICENSED",']);
  assert.equal(resolveVersionConflicts(lock), '{\n      "version": "0.4.10",\n      "license": "UNLICENSED",\n}', "main's side, whose version is set right afterwards");
  // Both raised it: either will do, since the version is set afterwards.
  assert.equal(resolveVersionConflicts(conflict(['  "version": "0.4.11",'], ['  "version": "0.4.10",'], ['  "version": "0.4.11",'])), '{\n  "version": "0.4.11",\n}');
  // The PR changed something else too, on the same lines main changed: a person's call.
  assert.equal(resolveVersionConflicts(conflict(['  "version": "0.4.11",', '  "type": "module",'], ['  "version": "0.4.10",'], ['  "version": "0.4.10",', '  "license": "UNLICENSED",'])), null);
  // No common ancestor in the markers (not diff3): it can't tell, so it doesn't.
  assert.equal(resolveVersionConflicts(['<<<<<<< HEAD', 'a 1.0.1', '=======', 'a 1.0.2', '>>>>>>> main'].join('\n')), null);
  assert.equal(resolveVersionConflicts('no conflicts\r\nhere'), 'no conflicts\r\nhere', 'line endings kept');
});

test("the version: a PR's own stays while it's new; else the next free one above the branch's", () => {
  const v = (o: Partial<Parameters<typeof catchUpVersion>[0]>) => catchUpVersion({ head: '0.4.11', from: '0.4.10', base: '0.4.10', released: ['0.4.10'], taken: [], asksRelease: true, ...o });
  assert.deepEqual(v({}), { version: '0.4.11', why: null }, 'still new');
  assert.deepEqual(v({ base: '0.4.11', released: ['0.4.10', '0.4.11'] }), { version: '0.4.12', why: 'v0.4.11 is already released' });
  assert.deepEqual(v({ base: '0.4.12', released: ['0.4.10'] }), { version: '0.4.13', why: 'the branch is at v0.4.12 already' });
  assert.deepEqual(v({ taken: ['0.4.11', '0.4.12'] }), { version: '0.4.13', why: 'another PR sets v0.4.11' });
  assert.deepEqual(v({ head: '0.3.0', from: '0.2.5', base: '0.2.5', released: ['0.2.5'] }), { version: '0.3.0', why: null }, 'a minor step of its own is kept');
  // One that leaves the version alone keeps the branch's, unless it asks for a release of a released one.
  assert.deepEqual(v({ head: '0.4.10', from: '0.4.10', asksRelease: false }), { version: '0.4.10', why: null });
  assert.deepEqual(v({ head: '0.4.10', from: '0.4.10' }), { version: '0.4.11', why: 'it asks for a release, and v0.4.10 is already released' });
});

/** An employee whose main moved on (0.4.1, released, and a licence in its lock) under a PR that set 0.4.1 too. */
function moved(name: string, prFiles: Record<string, string> = { 'src/feature.ts': 'export const feature = 1;\n' }, o: { base?: Record<string, string>; main?: Record<string, string> } = {}) {
  const dir = path.join(home, name);
  const { checkout } = fakeEmployee(dir, { version: '0.4.0', files: o.base });
  const write = (f: string, t: string) => writeFileSync(path.join(checkout, f), t);
  const read = (f: string) => readFileSync(path.join(checkout, f), 'utf8');
  const bump = (to: string) => {
    for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) write(f, read(f).split('0.4.0').join(to));
  };
  // The PR: 0.4.1 and a feature.
  sh(checkout, 'switch', '--quiet', '-c', 'claude/feature');
  bump('0.4.1');
  for (const [f, t] of Object.entries(prFiles)) write(f, t);
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Fake 0.4.1: a feature');
  sh(checkout, 'push', '--quiet', 'origin', 'claude/feature');
  const headOid = sh(checkout, 'rev-parse', 'HEAD');
  // main: someone else's 0.4.1, released, and a licence beside the lock's version.
  sh(checkout, 'switch', '--quiet', 'main');
  bump('0.4.1');
  write('package-lock.json', read('package-lock.json').replace('      "version": "0.4.1"\n', '      "version": "0.4.1",\n      "license": "UNLICENSED"\n'));
  write('LICENSE', 'All rights reserved.\n');
  for (const [f, t] of Object.entries(o.main ?? {})) write(f, t);
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Fake 0.4.1: all rights reserved');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const pr: PrInfo = { number: 21, title: 'Fake 0.4.1: a feature', url: 'https://github.com/Jcollier0120/Fake/pull/21', head: 'claude/feature', base: 'main', author: 'Jcollier0120', whose: 'team', headOid, after: { steps: ['release', 'install'] } as any, afterError: null, mergeable: 'CONFLICTING', mergeState: 'DIRTY', draft: false, checks: 'none', labels: [], changed: 10, files: [], fork: false };
  return { dir, checkout, pr, read };
}

test("a PR whose version lines conflict is caught up: main merged in, the next free version, pushed, its title and a comment", async () => {
  const { dir, checkout, pr } = moved('versions');
  const { run, gh } = runner(() => ok(''));
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.equal(c.done, true, c.note);
  assert.equal(c.version, '0.4.2');
  assert.match(c.note, /merged main into it, its version lines resolved; v0\.4\.2, since v0\.4\.1 is already released/);
  // What origin's branch holds now: main's licence, the PR's feature, and 0.4.2 in every version file.
  sh(checkout, 'fetch', '--quiet', 'origin');
  const at = (f: string) => sh(checkout, 'show', `origin/claude/feature:${f}`);
  assert.equal(JSON.parse(at('package.json')).version, '0.4.2');
  const lock = JSON.parse(at('package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version, lock.packages[''].license], ['0.4.2', '0.4.2', 'UNLICENSED']);
  assert.match(at('src/app.ts'), /version: '0\.4\.2'/);
  assert.equal(at('LICENSE'), 'All rights reserved.');
  assert.match(at('src/feature.ts'), /feature = 1/);
  assert.equal(sh(checkout, 'merge-base', '--is-ancestor', pr.headOid, 'origin/claude/feature'), '', "the PR's commits kept: a merge on top, nothing rewritten");
  assert.equal(sh(checkout, 'merge-base', '--is-ancestor', 'origin/main', 'origin/claude/feature'), '');
  assert.deepEqual(gh.find((a) => a[1] === 'edit')?.slice(-2), ['--title', 'Fake 0.4.2: a feature']);
  assert.match(gh.find((a) => a[1] === 'comment')!.at(-1)!, /^Caught up by the Steward: merged main/);
});

test('a conflict beyond the version lines is left for a person, and the branch untouched', async () => {
  const { dir, checkout, pr } = moved('real-conflict', { LICENSE: 'MIT\n' });
  const { run, gh } = runner(() => ok(''));
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.equal(c.done, false);
  assert.equal(c.note, 'it conflicts with main in LICENSE: that needs a person');
  sh(checkout, 'fetch', '--quiet', 'origin');
  assert.equal(sh(checkout, 'rev-parse', 'origin/claude/feature'), pr.headOid);
  assert.equal(gh.length, 0, 'nothing said on the PR');
});

// Two PRs written side by side each add an entry at the top of the changelog, under the same next version.
const log = (...entries: [string, string][]) => ['# Changelog', '', 'Newest first.', '', ...entries.flatMap(([v, t]) => [`## ${v}`, '', t, ''])].join('\n');

test("the changelog: the PR's new entry goes above the branch's, under the version it ends up with; anything else is left", () => {
  const base = log(['0.4.0', 'The first.']);
  const ours = log(['0.4.1', 'A feature.\n- and its detail'], ['0.4.0', 'The first.']);
  const theirs = log(['0.4.1', 'All rights reserved.'], ['0.4.0', 'The first.']);
  assert.equal(mergeChangelogs(base, ours, theirs, '0.4.2'), log(['0.4.2', 'A feature.\n- and its detail'], ['0.4.1', 'All rights reserved.'], ['0.4.0', 'The first.']));
  assert.ok(mergeChangelogs(base.replace(/\n/g, '\r\n'), ours, theirs.replace(/\n/g, '\r\n'), '0.4.2')!.includes('\r\n## 0.4.2\r\n'), "the branch's line endings");
  // An older entry changed on either side, two entries from the PR, or a heading with no version: a person's call.
  assert.equal(mergeChangelogs(base, ours, log(['0.4.1', 'Theirs.'], ['0.4.0', 'The first, reworded.']), '0.4.2'), null);
  assert.equal(mergeChangelogs(base, log(['0.4.2', 'b'], ['0.4.1', 'a'], ['0.4.0', 'The first.']), theirs, '0.4.3'), null);
  assert.equal(mergeChangelogs(base, log(['Unreleased', 'a'], ['0.4.0', 'The first.']), theirs, '0.4.2'), null);
  // The text above the entries changed on one side only: that side's is kept.
  assert.match(mergeChangelogs(base, ours, theirs.replace('Newest first.', 'Newest first, always.'), '0.4.2')!, /^# Changelog\n\nNewest first, always\.\n\n## 0\.4\.2/);
  // Renamed alone (no conflict): only when the top entry is the one that names the PR's old version.
  assert.equal(renumberChangelog(ours, '0.4.1', '0.4.2'), ours.replace('## 0.4.1', '## 0.4.2'));
  assert.equal(renumberChangelog(theirs, '0.4.3', '0.4.4'), null);
});

test('a PR whose changelog conflicts only in a new top entry is caught up: both entries kept, its own under its new version', async () => {
  const { dir, checkout, pr } = moved(
    'changelog',
    { 'src/feature.ts': 'export const feature = 1;\n', 'CHANGELOG.md': log(['0.4.1', 'A feature.'], ['0.4.0', 'The first.']) },
    { base: { 'CHANGELOG.md': log(['0.4.0', 'The first.']) }, main: { 'CHANGELOG.md': log(['0.4.1', 'All rights reserved.'], ['0.4.0', 'The first.']) } },
  );
  const { run } = runner(() => ok(''));
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.equal(c.done, true, c.note);
  assert.match(c.note, /its version lines and changelog resolved; v0\.4\.2/);
  sh(checkout, 'fetch', '--quiet', 'origin');
  assert.equal(sh(checkout, 'show', 'origin/claude/feature:CHANGELOG.md'), log(['0.4.2', 'A feature.'], ['0.4.1', 'All rights reserved.'], ['0.4.0', 'The first.']).trimEnd());
});

test('a conflict that needs judgement says which files, for its author', async () => {
  const { dir, checkout, pr } = moved('says-files', { LICENSE: 'MIT\n' });
  const { run } = runner(() => ok(''));
  const e = employee(checkout);
  const c = await catchUp(ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir }), e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.deepEqual(c.conflicts, ['LICENSE']);
});

test("the round: a conflict that needs judgement goes back to its author, once for a head; the Wright's is closed and its issue queued again", async () => {
  rmSync(kickbacksFile(), { force: true });
  const { dir, checkout, pr } = moved('kickback', { LICENSE: 'MIT\n' });
  const listed = (o: { head?: string; labels?: string[]; body?: string } = {}) => [
    { number: pr.number, title: pr.title, url: pr.url, body: o.body ?? '', headRefName: o.head ?? pr.head, headRefOid: pr.headOid, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', isDraft: false, statusCheckRollup: [], labels: (o.labels ?? []).map((name) => ({ name })), additions: 5, deletions: 5, files: [] },
  ];
  const e = employee(checkout);
  const round = async (list: unknown) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'list') return ok(list);
      if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.1', isDraft: false, publishedAt: '2026-10-04T00:00:00Z' }]);
      return ok('');
    });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
    ctx.settings.catchUp = true;
    return { out: await mergeOne(ctx, e, { yes: true, team: true }), gh: r.gh };
  };

  // A Claude Code session's: a comment that names the file, and its hold says it's back with the session.
  const first = await round(listed());
  const said = first.gh.find((a) => a[0] === 'pr' && a[1] === 'comment');
  assert.ok(said, `${first.out.message}
${JSON.stringify(first.out.held)}`);
  assert.match(said!.at(-1)!, /conflicts with `main` in `LICENSE`[\s\S]*Over to the Claude Code session that opened it: merge `main` into `claude\/feature`/);
  assert.match(first.out.held[0].why, /back with the Claude Code session that opened it, in a comment on it/);
  // The next round, nothing new: said once.
  const again = await round(listed());
  assert.equal(again.gh.filter((a) => a[1] === 'comment').length, 0);
  assert.match(again.out.held[0].why, /back with the Claude Code session/);

  // The Wright's: closed and its branch deleted (the redo's branch has its name), its issue queued again; it then waits for nothing.
  rmSync(kickbacksFile(), { force: true });
  sh(checkout, 'push', '--quiet', 'origin', `${pr.headOid}:refs/heads/wright/7-a-feature`);
  const wright = await round(listed({ head: 'wright/7-a-feature', labels: ['wright'], body: 'A feature.\n\nCloses #7' }));
  assert.ok(wright.gh.some((a) => a[0] === 'pr' && a[1] === 'close' && a[2] === '21' && a.includes('--delete-branch')), JSON.stringify(wright.gh));
  assert.ok(wright.gh.some((a) => a[0] === 'issue' && a[1] === 'edit' && a[2] === '7' && a.includes('wright:done')));
  assert.ok(wright.gh.some((a) => a[0] === 'issue' && a[1] === 'comment' && a[2] === '7'));
  assert.equal(wright.out.held.length, 0);
  assert.match(wright.out.message, /#21 closed: it conflicts with main in LICENSE, so the Steward closed it and queued #7 for the Wright again/);
});

test("the round: a conflicting team PR is caught up after the merges, and its hold says so", async () => {
  const { dir, checkout, pr } = moved('round');
  const listed = [{ number: pr.number, title: pr.title, url: pr.url, body: '```steward\n{"after": ["release", "install"]}\n```', headRefName: pr.head, headRefOid: pr.headOid, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', isDraft: false, statusCheckRollup: [], labels: [], additions: 5, deletions: 5, files: [] }];
  const { run } = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list') return ok(listed);
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.1', isDraft: false, publishedAt: '2026-10-04T00:00:00Z' }, { tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' }]);
    return ok('');
  });
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  ctx.settings.catchUp = true;
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(r.merged.length, 0);
  assert.match(r.message, /#21 caught up: merged main into it, its version lines resolved; v0\.4\.2/);
  assert.match(r.held[0].why, /^caught up by the Steward \(.*\): it merges once its checks pass at the new head$/);
  // Off in Settings (the tests' default): it only waits.
  const off = runner((a) => (a[1] === 'list' ? ok(a[0] === 'pr' ? listed : []) : ok('')));
  const ctxOff = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: off.run, neutralDir: dir });
  const r2 = await mergeOne(ctxOff, e, { yes: true, team: true });
  assert.equal(r2.held[0].why, 'conflicts with its branch');
});

// The Steward's own kit PRs are caught up by the same rules, with their checks run here before the push; one that
// conflicts beyond its versions is closed, and the next round's rollout bumps again from the branch's head.
/** moved()'s PR, as a kit PR of the Steward's (Reeve#39's case: a team PR took its version on main). */
function kitPr(name: string, prFiles?: Record<string, string>) {
  const m = moved(name, prFiles);
  sh(m.checkout, 'push', '--quiet', 'origin', `${m.pr.headOid}:refs/heads/steward/kit-1.0.1`);
  const pr: PrInfo = { ...m.pr, number: 39, title: "Fake 0.4.1: the Steward's kit 1.0.1", head: 'steward/kit-1.0.1', whose: 'steward', author: 'Jcollier0120', after: null };
  return { ...m, pr };
}

/** gh scripted; npm stands in (its packages "installed"); everything else, git and the checks, runs for real. */
function kitRunner() {
  const r = runner(() => ok(''));
  const ran: string[] = [];
  const run: import('../src/run.ts').Runner = async (cmd, args, opts) => {
    if (cmd === 'npm') {
      mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
      return ok('');
    }
    if (cmd !== 'gh' && cmd !== 'git') ran.push([cmd, ...args].join(' '));
    return r.run(cmd, args, opts);
  };
  return { run, gh: r.gh, ran };
}

test("a kit PR of the Steward's whose version lines conflict is caught up, its checks run before the push", async () => {
  const { dir, checkout, pr } = kitPr('kit-versions');
  const { run, gh, ran } = kitRunner();
  const e = employee(checkout, { fill: '', test: ['node -e process.exit(0)'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.equal(c.done, true, `${c.note}\n${ctx.lines.join('\n')}`);
  assert.equal(c.version, '0.4.2');
  assert.match(c.note, /merged main into it, its version lines resolved; v0\.4\.2, since v0\.4\.1 is already released; its checks passed$/);
  assert.ok(ran.includes('node -e process.exit(0)'), 'its checks ran');
  sh(checkout, 'fetch', '--quiet', 'origin');
  assert.equal(JSON.parse(sh(checkout, 'show', 'origin/steward/kit-1.0.1:package.json')).version, '0.4.2');
  assert.deepEqual(gh.find((a) => a[1] === 'edit')?.slice(-2), ['--title', "Fake 0.4.2: the Steward's kit 1.0.1"]);
  assert.match(gh.find((a) => a[1] === 'comment')!.at(-1)!, /The next round merges it\.$/);
});

test("a kit PR whose checks fail after catching up isn't pushed", async () => {
  const { dir, checkout, pr } = kitPr('kit-failing');
  const { run, gh } = kitRunner();
  const e = employee(checkout, { fill: '', test: ['node -e process.exit(3)'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.equal(c.done, false);
  assert.match(c.note, /but then node -e process\.exit\(3\) failed \(exit 3\), so it wasn't pushed$/);
  sh(checkout, 'fetch', '--quiet', 'origin');
  assert.equal(sh(checkout, 'rev-parse', 'origin/steward/kit-1.0.1'), pr.headOid);
  assert.equal(gh.length, 0);
});

test("kit.json: the newer kit of the two, every part either takes; anything else changed on both sides is left", () => {
  const pin = (kit: string, parts: string[], more = '') => `{\n  "kit": "${kit}",\n  "parts": [${parts.map((p) => JSON.stringify(p)).join(', ')}]${more}\n}\n`;
  // Reeve #70: the PR moved to 2.26.0 and took the react part; main took 2.25.0 by a bump.
  assert.equal(mergeKitPins(pin('2.19.0', ['node', 'spec']), pin('2.26.0', ['node', 'web', 'spec', 'react']), pin('2.25.0', ['node', 'spec'])), pin('2.26.0', ['node', 'web', 'spec', 'react']));
  // Chamberlain #13: the PR at 2.20.0, main bumped on to 2.24.0.
  assert.equal(mergeKitPins(pin('2.19.0', ['node', 'web', 'spec']), pin('2.20.0', ['node', 'web', 'spec']), pin('2.24.0', ['node', 'web', 'spec'])), pin('2.24.0', ['node', 'web', 'spec']));
  // A part only the branch took is kept too.
  assert.equal(mergeKitPins(pin('1.0.0', ['node']), pin('1.1.0', ['node']), pin('1.0.1', ['node', 'core'])), pin('1.1.0', ['node', 'core']));
  // Another key changed on one side is taken; on both, differently, it's a person's.
  assert.equal(mergeKitPins(pin('1.0.0', ['node']), pin('1.1.0', ['node']), pin('1.0.1', ['node'], ',\n  "note": "x"')), pin('1.1.0', ['node'], ',\n  "note": "x"'));
  assert.equal(mergeKitPins(pin('1.0.0', ['node']), pin('1.1.0', ['node'], ',\n  "note": "a"'), pin('1.0.1', ['node'], ',\n  "note": "b"')), null);
  assert.equal(mergeKitPins(pin('1.0.0', ['node']), 'not json', pin('1.0.1', ['node'])), null);
});

test("a team PR whose kit.json conflicts too is caught up: the newer kit, its version lines and changelog as before", async () => {
  const k = (v: string, parts = '"node"') => `{\n  "kit": "${v}",\n  "parts": [${parts}]\n}\n`;
  const { dir, checkout, pr } = moved('kit-pin', { 'src/feature.ts': 'export const feature = 1;\n', 'kit.json': k('1.2.0', '"node", "web"') }, { main: { 'kit.json': k('1.1.0') } });
  const r = runner(() => ok(''));
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.equal(c.done, true, `${c.note}\n${ctx.lines.join('\n')}`);
  assert.match(c.note, /its version lines and kit pin resolved/);
  sh(checkout, 'fetch', '--quiet', 'origin');
  assert.equal(sh(checkout, 'show', 'origin/claude/feature:kit.json'), k('1.2.0', '"node", "web"').trim());
});

test("a kit PR whose branch already carries that kit, or a newer one, is closed: it has nothing left to do", async () => {
  const { dir, checkout, pr } = kitPr('kit-redundant');
  const { run, gh, ran } = kitRunner();
  // main took kit 1.0.1 by another PR.
  writeFileSync(path.join(checkout, 'kit.json'), '{\n  "kit": "1.0.1",\n  "parts": ["node"]\n}\n');
  sh(checkout, 'commit', '--quiet', '-am', 'kit 1.0.1 by hand');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const e = employee(checkout, { fill: '', test: ['node -e process.exit(0)'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.deepEqual([c.done, c.closed], [false, true]);
  assert.equal(c.note, 'main already carries kit 1.0.1, so the Steward closed it: the next round bumps Fake again from main');
  const close = gh.find((a) => a[1] === 'close')!;
  assert.ok(close.includes('--delete-branch'));
  assert.match(close.at(-1)!, /main already carries kit 1\.0\.1, so this bump has nothing left to do/);
  assert.deepEqual(ran, [], 'nothing merged or tested');
});

test('a kit PR that conflicts beyond its versions is closed, its branch deleted, for the next round to bump again', async () => {
  const { dir, checkout, pr } = kitPr('kit-conflict', { LICENSE: 'MIT\n' });
  const { run, gh, ran } = kitRunner();
  const e = employee(checkout, { fill: '', test: ['node -e process.exit(0)'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.deepEqual([c.done, c.closed], [false, true]);
  assert.equal(c.note, 'it conflicts with main in LICENSE, so the Steward closed it: the next round bumps Fake again from main');
  const close = gh.find((a) => a[1] === 'close')!;
  assert.deepEqual(close.slice(0, 5), ['pr', 'close', '39', '--repo', 'Jcollier0120/Fake']);
  assert.ok(close.includes('--delete-branch'), "its branch goes, or the next bump would refuse it");
  assert.match(close.at(-1)!, /^Closed by the Steward: it conflicts with main in LICENSE/);
  assert.deepEqual(ran, [], 'no checks for a PR it closes');
  // A team PR with the same conflict still waits for a person.
  const team = await catchUp(ctx, e, { ...pr, whose: 'team', head: 'claude/feature' }, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.deepEqual([team.done, team.closed, team.note], [false, undefined, 'it conflicts with main in LICENSE: that needs a person']);
});

test("the round: a conflicting kit PR of the Steward's is one a catch-up may clear; any other of its own isn't", async () => {
  const { behindItsBranch } = await import('../src/stages/merge.ts');
  const { isKitPr } = await import('../src/stages/catchup.ts');
  const base = { number: 39, title: 't', url: 'u', head: 'steward/kit-2.9.1', base: 'main', author: 'Jcollier0120', whose: 'steward', headOid: 'x', after: null, afterError: null, mergeable: 'CONFLICTING', mergeState: 'DIRTY', draft: false, checks: 'none', labels: [], changed: 1, files: [], fork: false } as unknown as PrInfo;
  assert.ok(isKitPr(base) && behindItsBranch(base, 'main'));
  assert.ok(!behindItsBranch({ ...base, head: 'steward/other' }, 'main'));
  assert.ok(!behindItsBranch({ ...base, mergeable: 'MERGEABLE', mergeState: 'CLEAN' }, 'main'));
});

test("the Steward's own PR whose kit was overtaken too: both versions caught up, the kit's changelog, pin, entry and title following", async () => {
  // The PR: Fake 0.4.1 with kit 2.1.1 (its claims). main: another PR's 0.4.1 with kit 2.2.0, claimed after and merged first.
  const own = (v: string, k: string, what: string) => log([v, `It hands out the kit ${k}: ${what}.`], ['0.4.0', 'The first.']);
  const { dir, checkout, pr } = moved(
    'kit-overtaken',
    { 'src/feature.ts': 'export const feature = 1;\n', 'kit/VERSION': '2.1.1\n', 'kit/CHANGELOG.md': log(['2.1.1', 'GenieX 0.8.0.'], ['2.1.0', 'The first kit.']), 'CHANGELOG.md': own('0.4.1', '2.1.1', 'GenieX 0.8.0'), 'kit.json': '{\n  "kit": "2.1.1",\n  "parts": ["node"]\n}\n' },
    {
      base: { 'kit/VERSION': '2.1.0\n', 'kit/CHANGELOG.md': log(['2.1.0', 'The first kit.']), 'CHANGELOG.md': log(['0.4.0', 'The first.']), 'kit.json': '{\n  "kit": "2.1.0",\n  "parts": ["node"]\n}\n' },
      main: { 'kit/VERSION': '2.2.0\n', 'kit/CHANGELOG.md': log(['2.2.0', 'Sold agents.'], ['2.1.0', 'The first kit.']), 'CHANGELOG.md': own('0.4.1', '2.2.0', 'sold agents'), 'kit.json': '{\n  "kit": "2.2.0",\n  "parts": ["node"]\n}\n' },
    },
  );
  pr.title = 'Fake 0.4.1, kit 2.1.1: GenieX 0.8.0';
  const { run, gh } = runner(() => ok(''));
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [], kit: { released: ['2.1.0', '2.2.0'], taken: [] } });
  assert.equal(c.done, true, c.note);
  assert.deepEqual([c.version, c.kitVersion], ['0.4.2', '2.2.1']);
  assert.match(c.note, /kit version and kit's changelog resolved; v0\.4\.2, since v0\.4\.1 is already released; kit 2\.2\.1, since the branch is at kit 2\.2\.0 already/);
  sh(checkout, 'fetch', '--quiet', 'origin');
  const at = (f: string) => sh(checkout, 'show', `origin/claude/feature:${f}`);
  assert.equal(at('kit/VERSION'), '2.2.1');
  assert.equal(at('kit/CHANGELOG.md'), log(['2.2.1', 'GenieX 0.8.0.'], ['2.2.0', 'Sold agents.'], ['2.1.0', 'The first kit.']).trimEnd());
  assert.equal(at('CHANGELOG.md'), log(['0.4.2', 'It hands out the kit 2.2.1: GenieX 0.8.0.'], ['0.4.1', 'It hands out the kit 2.2.0: sold agents.'], ['0.4.0', 'The first.']).trimEnd());
  assert.match(at('kit.json'), /"kit": "2\.2\.1"/, "the Steward's pin of its own kit follows it");
  assert.deepEqual(gh.find((a) => a[1] === 'edit')?.slice(-2), ['--title', 'Fake 0.4.2, kit 2.2.1: GenieX 0.8.0']);
});

test("a kit version still new is kept, and the kit's files left as the PR wrote them", async () => {
  const { dir, checkout, pr } = moved(
    'kit-still-new',
    { 'src/feature.ts': 'export const feature = 1;\n', 'kit/VERSION': '2.1.1\n' },
    { base: { 'kit/VERSION': '2.1.0\n' } },
  );
  const { run } = runner(() => ok(''));
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const c = await catchUp(ctx, e, pr, { released: ['0.4.0', '0.4.1'], taken: [], kit: { released: ['2.1.0'], taken: [] } });
  assert.equal(c.done, true, c.note);
  assert.deepEqual([c.version, c.kitVersion], ['0.4.2', '2.1.1']);
  assert.doesNotMatch(c.note, /kit 2/);
  sh(checkout, 'fetch', '--quiet', 'origin');
  assert.equal(sh(checkout, 'show', 'origin/claude/feature:kit/VERSION'), '2.1.1');
});
