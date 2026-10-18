import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { chooseKit, kitReleasesIn } from '../src/kitsource.ts';
import { releaseDecision } from '../src/stages/release.ts';
import { appReleasesIn, checksOf, parseLog, parsePrs, prOfCommit, readPin, staffRow } from '../src/stages/staff.ts';
import { RETIRED } from '../src/retired.ts';
import { ctxFor, employee, fakeEmployee, ok, runner, sh } from './helpers.ts';

// The staff's table from gh's JSON (a stand-in runner) and a fake employee's git; which employees release. (Which PRs
// merge was the Steward's until 0.36.124: whoever writes a PR merges it now.)
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-staff-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const pr = (o: Record<string, unknown>) => ({
  number: 12,
  title: "Porter 0.4.1: the Steward's kit 1.0.1",
  url: 'https://github.com/Jcollier0120/Porter/pull/12',
  headRefName: 'steward/kit-1.0.1',
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'Jcollier0120', is_bot: false },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: [],
  ...o,
});
const stranger = { login: 'someone-else', is_bot: false };

test("a PR's checks in one word: CheckRuns and StatusContexts, failing beats running beats passing", () => {
  assert.equal(checksOf([]), 'none');
  assert.equal(checksOf(null), 'none');
  assert.equal(checksOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'passing');
  assert.equal(checksOf([{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }, { __typename: 'StatusContext', state: 'SUCCESS' }]), 'pending');
  assert.equal(checksOf([{ __typename: 'CheckRun', status: 'IN_PROGRESS' }, { __typename: 'StatusContext', state: 'FAILURE' }]), 'failing');
  assert.equal(checksOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' }]), 'failing');
  assert.equal(checksOf([{ state: 'PENDING' }]), 'pending');
});

test("with no team, only the Steward's PRs (head steward/…) are read from gh pr list", () => {
  const prs = parsePrs(JSON.stringify([pr({ number: 14, headRefName: 'release-0.3.1' }), pr({ number: 13, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] }), pr({ number: 9, headRefName: 'steward/use-kit-1.0.0', mergeable: 'CONFLICTING' })]), []);
  assert.deepEqual(prs.map((p) => [p.number, p.head, p.checks, p.mergeable, p.whose]), [[9, 'steward/use-kit-1.0.0', 'none', 'CONFLICTING', 'steward'], [13, 'steward/kit-1.0.1', 'failing', 'MERGEABLE', 'steward']]);
});

test("the team's PRs are those its accounts opened, from any branch; a stranger's are left out, and a fork's steward/… branch isn't the Steward's", () => {
  const prs = parsePrs(
    JSON.stringify([
      pr({ number: 11, headRefName: 'claude/infallible-tesla-96fcf9', title: 'Encoder: D3D12 falls back from VBR to CBR' }),
      pr({ number: 12, headRefName: 'fix/npu', author: { login: 'jcollier0120' } }),
      pr({ number: 13, headRefName: 'claude/x', author: { login: 'app/claude', is_bot: true } }),
      pr({ number: 14, headRefName: 'patch-1', author: stranger, isCrossRepository: true }),
      pr({ number: 15, headRefName: 'steward/kit-9.9.9', author: stranger, isCrossRepository: true }),
      pr({ number: 16, headRefName: 'steward/kit-1.0.1', author: stranger }),
      pr({ number: 17, headRefName: 'feature', author: { login: 'app/dependabot', is_bot: true } }),
    ]),
    ['Jcollier0120', 'app/claude'],
  );
  assert.deepEqual(
    prs.map((p) => [p.number, p.whose, p.author, p.base]),
    [
      [11, 'team', 'Jcollier0120', 'main'],
      [12, 'team', 'jcollier0120', 'main'],
      [13, 'team', 'app/claude', 'main'],
      [16, 'steward', 'someone-else', 'main'],
    ],
  );
  assert.equal(prs[0].title, 'Encoder: D3D12 falls back from VBR to CBR');
  // The Steward's own pushes, made with your gh: its branch in the repository decides, whoever opened it.
  assert.equal(parsePrs(JSON.stringify([pr({})]), ['Jcollier0120'])[0].whose, 'steward');
  // When it was opened, where the host says.
  assert.equal(parsePrs(JSON.stringify([pr({ createdAt: '2026-10-10T11:58:00Z' })]), [])[0].createdAt, '2026-10-10T11:58:00Z');
  assert.equal('createdAt' in parsePrs(JSON.stringify([pr({})]), [])[0], false);
});

test("releases and kit releases are each picked out by their tags, newest version first, drafts left out", () => {
  const list = JSON.stringify([
    { tagName: 'v0.3.10', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' },
    { tagName: 'v0.3.9', isDraft: false, publishedAt: '2026-10-02T00:00:00Z' },
    { tagName: 'v0.4.0', isDraft: true },
    { tagName: 'kit-v1.0.0', isDraft: false },
    { tagName: 'kit-v1.0.2', isDraft: false },
    { tagName: 'nightly', isDraft: false },
  ]);
  assert.deepEqual(appReleasesIn(list).map((r) => r.version), ['0.3.10', '0.3.9']);
  assert.deepEqual(kitReleasesIn(list), ['1.0.2', '1.0.0']);
});

test('the kit a stage works with: the one asked for, else the newest release, else this checkout\'s', () => {
  const k = { released: ['1.0.2', '1.0.0'], releasesError: null, local: '1.1.0', localDir: 'C:\\x\\kit' };
  assert.deepEqual(chooseKit(k), { version: '1.0.2', note: null });
  assert.deepEqual(chooseKit(k, '1.0.0'), { version: '1.0.0', note: null });
  assert.match((chooseKit(k, '1.1.0') as { note: string }).note, /has no release kit-v1\.1\.0/);
  assert.match((chooseKit({ ...k, released: [] }) as { note: string }).note, /no kit release on GitHub yet; this checkout's kit\\VERSION is 1\.1\.0/);
  assert.match((chooseKit({ ...k, released: [], local: null }) as { error: string }).error, /no kit release found/);
  assert.match((chooseKit(k, 'v1') as { error: string }).error, /x\.y\.z/);
});

test("an employee's row: its checkout, its branch's version and kit, its PRs, its latest release and the kit that release carries", async () => {
  const f = fakeEmployee(path.join(tmp, 'row'), { version: '0.4.0', kit: '1.0.0' });
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([pr({ number: 3 }), pr({ number: 4, headRefName: 'feature/x' }), pr({ number: 5, headRefName: 'patch-1', author: stranger, isCrossRepository: true })]);
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.3.1', isDraft: false, publishedAt: '2026-10-02T22:20:41Z' }]);
    if (args[0] === 'release' && args[1] === 'view') return ok({ targetCommitish: sha });
  });
  const e = employee(f.checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'row', 'work'), run: r.run, neutralDir: tmp });
  const row = await staffRow(ctx, e, { fetch: true, kit: '1.0.0' });
  assert.deepEqual(row.checkout, { path: f.checkout, exists: true, branch: 'main', changes: 0 });
  assert.equal(row.main?.version, '0.4.0');
  assert.equal(row.main?.kit, '1.0.0');
  assert.deepEqual(row.main?.parts, ['node']);
  assert.deepEqual(row.prs.map((p) => [p.number, p.whose]), [[3, 'steward'], [4, 'team']], "the Steward's and the team's; not a stranger's");
  assert.deepEqual(row.release, { tag: 'v0.3.1', version: '0.3.1', published: '2026-10-02T22:20:41Z', kit: '1.0.0' });
  assert.equal(row.releaseNeeded, true, '0.4.0 has no release yet');
  assert.deepEqual(row.notes, []);
  // An employee that doesn't take the kit says so.
  const off = await staffRow(ctx, { ...e, usesKit: false }, { fetch: false, kit: '1.0.0' });
  assert.deepEqual(off.notes, ['not using the kit yet']);
  // One Manor has retired says so, and the next build brings nothing of it (retired.ts).
  assert.notEqual(row.nextBuild, null);
  const retired = await staffRow({ ...ctx, retired: new Set([e.id]) }, e, { fetch: false, kit: '1.0.0' });
  assert.deepEqual(retired.notes, [RETIRED]);
  assert.equal(retired.nextBuild, null);
});

test("a commit on the branch names the PR it merged, in each host's words; one pushed without a PR is its subject", () => {
  assert.deepEqual(prOfCommit('Merge pull request #335 from Jcollier0120/claude/ps-idle-4min', 'Kit 2.82.4: the PowerShell worker stays 4 minutes\n'), { pr: 335, title: 'Kit 2.82.4: the PowerShell worker stays 4 minutes' });
  assert.deepEqual(prOfCommit('Merge pull request #7 from o/b', ''), { pr: 7, title: 'Merge pull request #7 from o/b' }, 'no title below: its subject');
  assert.deepEqual(prOfCommit('Fix the thing (#12)', ''), { pr: 12, title: 'Fix the thing' }, "GitHub's squash");
  assert.deepEqual(prOfCommit("Merge pull request 'Fix the thing' (#4) from fix into main", ''), { pr: 4, title: 'Fix the thing' }, "Gitea's");
  assert.deepEqual(prOfCommit('Merged PR 31: Fix the thing', 'Related work items: #5'), { pr: 31, title: 'Fix the thing' }, "Azure DevOps'");
  assert.deepEqual(prOfCommit('Merged in fix (pull request #9)', '\nFix the thing\n\nApproved-by: someone\n'), { pr: 9, title: 'Fix the thing' }, "Bitbucket's");
  assert.deepEqual(prOfCommit("Merge branch 'fix' into 'main'", 'Fix the thing\n\nSee merge request group/fake!21'), { pr: 21, title: 'Fix the thing' }, "GitLab's");
  assert.deepEqual(prOfCommit("Merge branch 'fix' into 'main'", 'See merge request group/fake!21'), { pr: 21, title: "Merge branch 'fix' into 'main'" });
  assert.deepEqual(prOfCommit('Changelog: a line lost in the merge', 'Merge pull request #3 from o/b'), { pr: null, title: 'Changelog: a line lost in the merge' }, 'a PR named in the body alone is no merge');
  assert.deepEqual(parseLog(`${'a'.repeat(40)}\x1fMerge pull request #2 from o/b\x1fTwo\n\x1e\n${'b'.repeat(40)}\x1fOne\x1f\x1e\n`), [
    { sha: 'aaaaaaa', pr: 2, title: 'Two' },
    { sha: 'bbbbbbb', pr: null, title: 'One' },
  ]);
  assert.deepEqual(parseLog(''), []);
});

test('what the next build brings: the branch since the commit its last release was built from, a merged PR as one line, the newest ten and the count', async () => {
  const f = fakeEmployee(path.join(tmp, 'next'), { version: '0.4.0', kit: '1.0.0' });
  const released = sh(f.checkout, 'rev-parse', 'HEAD');
  const commit = (msg: string) => sh(f.checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', msg);
  commit('Changelog: a line lost in the merge');
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/fix');
  commit('Fix the thing');
  commit('Fix the thing, its test');
  sh(f.checkout, 'switch', '--quiet', 'main');
  sh(f.checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--quiet', '--no-ff', 'claude/fix', '-m', 'Merge pull request #12 from Jcollier0120/claude/fix', '-m', 'Fix the thing');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  // The clone's origin/main is left behind: the row's fetch brings it.
  sh(f.checkout, 'update-ref', 'refs/remotes/origin/main', released);
  let releases = [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null }];
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([]);
    if (args[0] === 'release' && args[1] === 'list') return ok(releases);
    if (args[0] === 'release' && args[1] === 'view') return ok({ targetCommitish: released });
  });
  const e = employee(f.checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'next', 'work'), run: r.run, neutralDir: tmp });
  const row = await staffRow(ctx, e, { fetch: true, kit: '1.0.0' });
  assert.deepEqual(row.nextBuild, {
    tag: 'v0.4.0',
    commit: released,
    commits: [
      { sha: sh(f.checkout, 'rev-parse', '--short=7', 'main'), pr: 12, title: 'Fix the thing' },
      { sha: sh(f.checkout, 'rev-parse', '--short=7', 'main~1'), pr: null, title: 'Changelog: a line lost in the merge' },
    ],
    count: 2,
  });
  assert.equal(row.releaseNeeded, false, 'the same version: the build stamps it (stamp.ts), yet these are what it brings');

  // More than ten: the newest ten, and how many in all.
  for (let i = 1; i <= 11; i++) commit(`Commit ${i}`);
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  const long = (await staffRow(ctx, e, { fetch: true, kit: '1.0.0' })).nextBuild!;
  assert.equal(long.count, 13);
  assert.deepEqual(long.commits.map((c) => c.title), ['Commit 11', 'Commit 10', 'Commit 9', 'Commit 8', 'Commit 7', 'Commit 6', 'Commit 5', 'Commit 4', 'Commit 3', 'Commit 2']);

  // Released at main's head: nothing to bring.
  const head = sh(f.checkout, 'rev-parse', 'main');
  const atHead = runner((args) => (args[0] === 'release' && args[1] === 'view' ? ok({ targetCommitish: head }) : args[0] === 'release' ? ok(releases) : ok([])));
  const none = await staffRow(ctxFor({ employees: [e], workRoot: tmp, run: atHead.run, neutralDir: tmp }), e, { fetch: false, kit: '1.0.0' });
  assert.deepEqual(none.nextBuild, { tag: 'v0.4.0', commit: head, commits: [], count: 0 });

  // No release yet: nothing to count from, rather than the whole history.
  releases = [];
  assert.equal((await staffRow(ctx, e, { fetch: false, kit: '1.0.0' })).nextBuild, null);
});

test("released on this PC, the next build counts from the commit its installed copy was built from; a development build's says nothing", async () => {
  const f = fakeEmployee(path.join(tmp, 'here'), { version: '0.4.0', kit: '1.0.0' });
  const built = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'Merge pull request #5 from o/claude/x', '-m', 'Something new');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  const installed = path.join(tmp, 'here', 'installed');
  mkdirSync(installed, { recursive: true });
  const r = runner(() => ok([]));
  const e = employee(f.checkout, { release: 'npm run release -- --install', installed });
  const ctx = ctxFor({ employees: [e], workRoot: tmp, run: r.run, neutralDir: tmp });
  writeFileSync(path.join(installed, 'release.json'), `﻿${JSON.stringify({ version: '0.4.0', commit: built.slice(0, 12), dirty: false })}`);
  const row = await staffRow(ctx, e, { fetch: true, kit: '1.0.0' });
  assert.deepEqual(row.nextBuild, { tag: 'v0.4.0', commit: built, commits: [{ sha: sh(f.checkout, 'rev-parse', '--short=7', 'main'), pr: 5, title: 'Something new' }], count: 1 });
  writeFileSync(path.join(installed, 'release.json'), JSON.stringify({ version: '0.4.0', commit: built, dirty: true }));
  assert.equal((await staffRow(ctx, e, { fetch: false, kit: '1.0.0' })).nextBuild, null);
});

test("the table says whether an employee's tools/kit.ts is the Steward's", async () => {
  const tool = "// the Steward's tools/kit.ts\nconsole.log('fill');\n";
  const current = fakeEmployee(path.join(tmp, 'tool-current'), { files: { 'tools/kit.ts': tool.replace(/\n/g, '\r\n') } });
  const stale = fakeEmployee(path.join(tmp, 'tool-stale'), { files: { 'tools/kit.ts': '// an older one\n' } });
  const missing = fakeEmployee(path.join(tmp, 'tool-missing'));
  const r = runner(() => ok([]));
  const row = async (checkout: string) => {
    const e = employee(checkout);
    return staffRow(ctxFor({ employees: [e], workRoot: tmp, run: r.run, neutralDir: tmp }), e, { fetch: false, kit: '1.0.0', tool });
  };
  const c = await row(current.checkout);
  assert.equal(c.main?.tool, 'current', 'line endings aside');
  assert.deepEqual(c.notes, []);
  const s = await row(stale.checkout);
  assert.equal(s.main?.tool, 'differs');
  assert.match(s.notes.join(' '), /tools\/kit\.ts on origin\/main isn't the Steward's: the next bump brings it/);
  assert.equal((await row(missing.checkout)).main?.tool, 'missing');
});

test("gh failing doesn't lose the row: what git knows is there, and the failure is a note", async () => {
  const f = fakeEmployee(path.join(tmp, 'offline'));
  const r = runner(() => ({ code: 1, out: '', err: 'error connecting to api.github.com' }));
  const e = employee(f.checkout);
  const row = await staffRow(ctxFor({ employees: [e], workRoot: tmp, run: r.run, neutralDir: tmp }), e, { fetch: false, kit: null });
  assert.equal(row.main?.version, '0.4.0');
  assert.match(row.notes.join(' '), /couldn't list its PRs: .*api\.github\.com/);
  assert.match(row.notes.join(' '), /couldn't list its releases/);
  assert.deepEqual(readPin('{"kit":"1.0.0"}'), { kit: '1.0.0', parts: null });
  assert.equal(readPin('not json'), null);
});

test('release takes an employee whose branch has the kit and an unreleased version, and says why for the others', () => {
  const c = { usesKit: true, kit: '1.0.1', version: '0.4.1', released: ['0.4.0'] };
  assert.deepEqual(releaseDecision(c, '1.0.1'), { release: true });
  assert.deepEqual(releaseDecision({ ...c, released: ['0.4.0', '0.4.1'] }, '1.0.1'), { release: false, why: 'v0.4.1 is already released' });
  assert.deepEqual(releaseDecision({ ...c, kit: '1.0.0' }, '1.0.1'), { release: false, why: 'its branch pins kit 1.0.0, not 1.0.1: merge the bump first' });
  assert.deepEqual(releaseDecision({ ...c, kit: null }, '1.0.1'), { release: false, why: 'its branch has no kit.json' });
  assert.deepEqual(releaseDecision({ ...c, usesKit: false }, '1.0.1'), { release: false, why: 'not using the kit yet' });
  assert.deepEqual(releaseDecision({ ...c, version: null }, '1.0.1'), { release: false, why: 'no version found on its branch' });
  // Merged out of order: a version below one released already isn't released.
  assert.deepEqual(releaseDecision({ ...c, version: '0.4.1', released: ['0.4.0', '0.4.2'] }, '1.0.1'), { release: false, why: 'v0.4.1 on its branch is below v0.4.2, released already: a version above it (claim-version) releases what is merged' });
});

test("the table is made again only where something moved: a row that didn't stands, its checkout looked at again (HEAD's file, status without untracked files)", async () => {
  const { staff } = await import('../src/stages/staff.ts');
  const { writeFileSync } = await import('node:fs');
  const f = fakeEmployee(path.join(tmp, 'again'), { version: '0.4.0', kit: '1.0.0' });
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  const git: string[][] = [];
  const r = runner(() => undefined);
  const e = employee(f.checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'again', 'work'), run: (cmd, args, opts) => (cmd === 'git' && git.push(args), r.run(cmd, args, opts)), neutralDir: tmp });
  const g = { head: sha, prs: [] as any[], releases: [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null, commit: sha }] };
  ctx.glance = { at: '', stewardReleases: null, repos: { fake: g }, errors: {} };
  const first = await staff(ctx, { fetch: true, kit: '1.0.0' });
  assert.equal(first.rows[0].main?.version, '0.4.0');
  assert.equal(first.rows[0].release?.kit, '1.0.0');
  assert.ok(first.keys?.fake, 'made without a failure: kept with what it rests on');
  assert.ok(!git.some((a) => a.includes('branch') && a.includes('--show-current')), "its branch read from HEAD's file");

  writeFileSync(path.join(f.checkout, 'untracked.txt'), 'not counted\n');
  writeFileSync(path.join(f.checkout, 'README.md'), 'changed\n');
  sh(f.checkout, 'add', 'README.md');
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/other');
  git.length = 0;
  const second = await staff(ctx, { fetch: true, kit: '1.0.0', before: first });
  assert.deepEqual(second.rows[0].main, first.rows[0].main);
  assert.deepEqual(second.rows[0].release, first.rows[0].release);
  assert.deepEqual([second.rows[0].checkout.branch, second.rows[0].checkout.changes], ['claude/other', 1]);
  assert.deepEqual(git, [['--no-optional-locks', 'status', '--porcelain', '-uno']], 'nothing read again but its status');
  assert.equal(r.gh.length, 0);

  // GitHub says something new of it (a PR): made again.
  ctx.glance.repos.fake = { ...g, prs: [pr({ number: 9, headRefName: 'claude/nine', headRefOid: sha })] };
  git.length = 0;
  const third = await staff(ctx, { fetch: true, kit: '1.0.0', before: second });
  assert.ok(git.length > 1, 'its row made again');
  assert.deepEqual(third.rows[0].prs.map((p) => p.number), [9]);
  assert.notEqual(third.keys?.fake, second.keys?.fake);
});

test("the Steward's own row reads its repository from the glance, as an employee's (no gh), and stands while nothing in it moved", async () => {
  const { staff } = await import('../src/stages/staff.ts');
  const { APP } = await import('../src/app.ts');
  const f = fakeEmployee(path.join(tmp, 'own'), { version: '0.35.1', kit: '1.0.0' });
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  const git: string[][] = [];
  const r = runner(() => undefined);
  const self = employee(f.checkout, { id: APP.id, name: APP.name });
  const ctx = ctxFor({ employees: [], workRoot: path.join(tmp, 'own', 'work'), run: (cmd, args, opts) => (cmd === 'git' && git.push(args), r.run(cmd, args, opts)), neutralDir: tmp });
  ctx.glance = { at: '', stewardReleases: null, repos: { [APP.id]: { head: sha, prs: [pr({ number: 4, headRefOid: sha })], releases: [{ tagName: 'v0.35.1', isDraft: false, publishedAt: null, commit: sha }] } }, errors: {} };
  const first = await staff(ctx, { fetch: true, kit: null, self });
  assert.equal(first.rows.length, 1);
  assert.ok(first.rows[0].self);
  assert.deepEqual(first.rows[0].prs.map((p) => p.number), [4]);
  assert.equal(first.rows[0].release?.version, '0.35.1');
  assert.equal(r.gh.length, 0, 'its PRs and releases from the glance');
  assert.ok(first.keys?.[APP.id]);
  git.length = 0;
  const second = await staff(ctx, { fetch: true, kit: null, self, before: first });
  assert.deepEqual(second.rows[0], first.rows[0]);
  assert.deepEqual(git, [['--no-optional-locks', 'status', '--porcelain', '-uno']], 'nothing read again but its status');
  assert.equal(r.gh.length, 0);
});
