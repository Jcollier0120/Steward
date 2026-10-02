import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { chooseKit, kitReleasesIn } from '../src/kitsource.ts';
import { holdReason, mergeOne, mergeSelection } from '../src/stages/merge.ts';
import { releaseDecision } from '../src/stages/release.ts';
import { appReleasesIn, checksOf, parsePrs, readPin, staffRow, type PrInfo } from '../src/stages/staff.ts';
import { ctxFor, employee, fakeEmployee, ok, runner, sh } from './helpers.ts';

// The staff's table from gh's JSON (a stand-in runner) and a fake employee's git; which PRs merge;
// which employees release.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-staff-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const pr = (o: Record<string, unknown>) => ({
  number: 12,
  title: "Porter 0.4.1: the Steward's kit 1.0.1",
  url: 'https://github.com/Jcollier0120/Porter/pull/12',
  headRefName: 'steward/kit-1.0.1',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: [],
  ...o,
});

test("a PR's checks in one word: CheckRuns and StatusContexts, failing beats running beats passing", () => {
  assert.equal(checksOf([]), 'none');
  assert.equal(checksOf(null), 'none');
  assert.equal(checksOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'passing');
  assert.equal(checksOf([{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }, { __typename: 'StatusContext', state: 'SUCCESS' }]), 'pending');
  assert.equal(checksOf([{ __typename: 'CheckRun', status: 'IN_PROGRESS' }, { __typename: 'StatusContext', state: 'FAILURE' }]), 'failing');
  assert.equal(checksOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' }]), 'failing');
  assert.equal(checksOf([{ state: 'PENDING' }]), 'pending');
});

test("only the Steward's PRs (head steward/…) are read from gh pr list", () => {
  const prs = parsePrs(JSON.stringify([pr({ number: 14, headRefName: 'release-0.3.1' }), pr({ number: 13, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] }), pr({ number: 9, headRefName: 'steward/use-kit-1.0.0', mergeable: 'CONFLICTING' })]));
  assert.deepEqual(prs.map((p) => [p.number, p.head, p.checks, p.mergeable]), [[9, 'steward/use-kit-1.0.0', 'none', 'CONFLICTING'], [13, 'steward/kit-1.0.1', 'failing', 'MERGEABLE']]);
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
    if (args[0] === 'pr' && args[1] === 'list') return ok([pr({ number: 3 }), pr({ number: 4, headRefName: 'feature/x' })]);
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
  assert.deepEqual(row.prs.map((p) => p.number), [3]);
  assert.deepEqual(row.release, { tag: 'v0.3.1', version: '0.3.1', published: '2026-10-02T22:20:41Z', kit: '1.0.0' });
  assert.equal(row.releaseNeeded, true, '0.4.0 has no release yet');
  assert.deepEqual(row.notes, []);
  // An employee that doesn't take the kit says so; one still carrying the old kit is flagged.
  const off = await staffRow(ctx, { ...e, usesKit: false }, { fetch: false, kit: '1.0.0' });
  assert.deepEqual(off.notes, ['not using the kit yet']);
  const g = fakeEmployee(path.join(tmp, 'old'), { kit: null, files: { 'src/npu.ts': '', 'src/server.ts': '', 'test/kit.test.ts': '' } });
  const old = await staffRow(ctx, employee(g.checkout), { fetch: false, kit: '1.0.0' });
  assert.deepEqual(old.main?.oldKitFiles, ['src/npu.ts', 'src/server.ts', 'test/kit.test.ts']);
  assert.match(old.notes.join(' '), /still tracks 3 old kit files at their old paths/);
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

const info = (o: Partial<PrInfo>): PrInfo => ({ number: 1, title: '', url: '', head: 'steward/kit-1.0.1', mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'passing', ...o });

test('merge takes only PRs that merge cleanly with checks passing or none; the rest wait, and say why', () => {
  const { merge, hold } = mergeSelection([
    info({ number: 1 }),
    info({ number: 2, checks: 'none' }),
    info({ number: 3, checks: 'failing' }),
    info({ number: 4, checks: 'pending' }),
    info({ number: 5, mergeable: 'CONFLICTING', mergeState: 'DIRTY' }),
    info({ number: 6, mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' }),
    info({ number: 7, draft: true }),
    info({ number: 8, mergeState: 'BLOCKED' }),
    info({ number: 9, mergeState: 'BEHIND' }),
  ]);
  assert.deepEqual(merge.map((p) => p.number), [1, 2]);
  assert.deepEqual(
    hold.map((h) => [h.pr.number, h.why]),
    [
      [3, 'checks failing'],
      [4, 'checks still running'],
      [5, 'conflicts with its branch'],
      [6, 'GitHub is still working out whether it merges: try again in a minute'],
      [7, 'a draft'],
      [8, 'blocked: a required review or check'],
      [9, 'behind its branch, which must be up to date to merge'],
    ],
  );
  assert.equal(holdReason(info({})), null);
});

test('merge without --yes merges nothing; with it, only the mergeable and green, with merge commits and the branch deleted', async () => {
  const prs = [pr({ number: 21 }), pr({ number: 22, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] })];
  const script = (args: string[]) => (args[1] === 'list' ? ok(prs) : args[1] === 'merge' ? ok('') : undefined);
  const e = employee(path.join(tmp, 'nowhere'), { repo: 'Jcollier0120/Porter' });
  const look = runner(script);
  const listed = await mergeOne(ctxFor({ employees: [e], workRoot: tmp, run: look.run, neutralDir: tmp }), e, { yes: false });
  assert.equal(listed.outcome, 'skipped');
  assert.match(listed.message, /#21 .* would be merged; #22 .* waits: checks failing \(merge --yes merges them\)/);
  assert.ok(!look.gh.some((a) => a[1] === 'merge'));
  const go = runner(script);
  const merged = await mergeOne(ctxFor({ employees: [e], workRoot: tmp, run: go.run, neutralDir: tmp }), e, { yes: true });
  assert.equal(merged.outcome, 'done');
  assert.deepEqual(go.gh.filter((a) => a[1] === 'merge'), [['pr', 'merge', '21', '--repo', 'Jcollier0120/Porter', '--merge', '--delete-branch']]);
  assert.match(merged.message, /merged #21; #22 .* waits: checks failing/);
  const off = await mergeOne(ctxFor({ employees: [e], workRoot: tmp, run: go.run, neutralDir: tmp }), { ...e, usesKit: false }, { yes: true });
  assert.equal(off.message, 'not using the kit yet');
});

test('release takes an employee whose branch has the kit and an unreleased version, and says why for the others', () => {
  const c = { usesKit: true, kit: '1.0.1', version: '0.4.1', released: ['0.4.0'] };
  assert.deepEqual(releaseDecision(c, '1.0.1'), { release: true });
  assert.deepEqual(releaseDecision({ ...c, released: ['0.4.0', '0.4.1'] }, '1.0.1'), { release: false, why: 'v0.4.1 is already released' });
  assert.deepEqual(releaseDecision({ ...c, kit: '1.0.0' }, '1.0.1'), { release: false, why: 'its branch pins kit 1.0.0, not 1.0.1: merge the bump first' });
  assert.deepEqual(releaseDecision({ ...c, kit: null }, '1.0.1'), { release: false, why: 'its branch has no kit.json' });
  assert.deepEqual(releaseDecision({ ...c, usesKit: false }, '1.0.1'), { release: false, why: 'not using the kit yet' });
  assert.deepEqual(releaseDecision({ ...c, version: null }, '1.0.1'), { release: false, why: 'no version found on its branch' });
});
