import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Catching a team PR up with its branch: the branch merged into it, a conflict resolved only in its version lines,
// the next free version when its own is taken; anything else left to a person, untouched.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-catchup-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { catchUp, catchUpVersion, resolveVersionConflicts } = await import('../src/stages/catchup.ts');
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
function moved(name: string, prFiles: Record<string, string> = { 'src/feature.ts': 'export const feature = 1;\n' }) {
  const dir = path.join(home, name);
  const { checkout } = fakeEmployee(dir, { version: '0.4.0' });
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
