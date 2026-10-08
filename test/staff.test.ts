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

const info = (o: Partial<PrInfo>): PrInfo => ({ number: 1, title: '', url: '', head: 'steward/kit-1.0.1', base: 'main', author: 'Jcollier0120', whose: 'steward', headOid: '', after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'passing', labels: [], changed: 0, files: [], ...o });

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
  // Only into the employee's own branch: a PR stacked on another branch waits for that one.
  assert.equal(holdReason(info({ base: 'claude/accelerators' }), 'main'), 'it merges into claude/accelerators, not main');
  assert.equal(holdReason(info({ base: 'main' }), 'main'), null);
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

test("merge --team takes the team's PRs as well, to any employee, and leaves their branches; without it they aren't touched", async () => {
  // A real checkout: a team PR's version is read there before it merges. #11 has CI passing, so it isn't tested here.
  const f = fakeEmployee(path.join(tmp, 'team-prs'));
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${sha}:refs/pull/11/head`);
  const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const prs = [
    pr({ number: 30 }),
    pr({ number: 11, headRefName: 'claude/infallible-tesla-96fcf9', headRefOid: sha, statusCheckRollup: green }),
    pr({ number: 12, headRefName: 'claude/stacked', baseRefName: 'claude/infallible-tesla-96fcf9' }),
    pr({ number: 13, headRefName: 'patch-1', author: stranger, isCrossRepository: true }),
  ];
  const script = (args: string[]) => (args[1] === 'list' ? ok(prs) : args[1] === 'merge' ? ok('') : undefined);
  const e = employee(f.checkout, { repo: 'Jcollier0120/Miller' });
  const ctx = (run: ReturnType<typeof runner>['run'], team?: string[]) => ctxFor({ employees: [e], workRoot: tmp, run, neutralDir: tmp, team });

  const plain = runner(script);
  const own = await mergeOne(ctx(plain.run), e, { yes: true });
  assert.deepEqual(plain.gh.filter((a) => a[1] === 'merge').map((a) => a[2]), ['30'], "the Steward's only");
  assert.equal(own.message, 'merged #30');

  const look = runner(script);
  const listed = await mergeOne(ctx(look.run), e, { yes: false, team: true });
  assert.match(listed.message, /^#11 \(claude\/infallible-tesla-96fcf9, Jcollier0120's; .*\) would be merged; #30 \(steward\/kit-1\.0\.1; .*\) would be merged; #12 .* waits: stacked on #11 \(claude\/infallible-tesla-96fcf9\): once #11 has merged, it is pointed at main and joins the line \(merge --yes --team merges them\)$/);
  assert.doesNotMatch(listed.message, /#13/, "a stranger's PR isn't even listed");

  const go = runner(script);
  const goCtx = ctx(go.run);
  const merged = await mergeOne(goCtx, e, { yes: true, team: true });
  assert.equal(merged.outcome, 'done');
  assert.deepEqual(go.gh.filter((a) => a[1] === 'merge'), [
    ['pr', 'merge', '11', '--repo', 'Jcollier0120/Miller', '--merge'],
    ['pr', 'merge', '30', '--repo', 'Jcollier0120/Miller', '--merge', '--delete-branch'],
  ]);
  assert.deepEqual(merged.merged.map((p) => p.number), [11, 30]);
  assert.match(goCtx.lines.join('\n'), /\[fake\] merged #11 \(claude\/infallible-tesla-96fcf9, Jcollier0120's\)/);

  // An employee not on the kit: the team's PRs to it are merged all the same.
  const off = runner(script);
  const offKit = await mergeOne(ctx(off.run), { ...e, usesKit: false }, { yes: true, team: true });
  assert.equal(offKit.outcome, 'done');
  assert.deepEqual(off.gh.filter((a) => a[1] === 'merge').map((a) => a[2]), ['11', '30']);

  // No team in Settings: --team is the Steward's alone.
  const none = runner(script);
  await mergeOne(ctx(none.run, []), e, { yes: true, team: true });
  assert.deepEqual(none.gh.filter((a) => a[1] === 'merge').map((a) => a[2]), ['30']);
});

test("a team PR stacked on a branch whose PR has merged is pointed at the employee's branch, with a comment, and joins the line; one stacked on an open PR, or on a branch that never merged, waits", async () => {
  const f = fakeEmployee(path.join(tmp, 'stacked-prs'));
  const prs = [
    // Its base's PR (#40, head claude/first) merged into main without the branch being deleted: Reeve#105's case.
    pr({ number: 41, headRefName: 'claude/second', baseRefName: 'claude/first' }),
    // Stacked on #42, still open.
    pr({ number: 42, headRefName: 'claude/third', baseRefName: 'main', isDraft: true }),
    pr({ number: 43, headRefName: 'claude/fourth', baseRefName: 'claude/third' }),
    // On a branch whose PR merged elsewhere, not into main: left alone.
    pr({ number: 44, headRefName: 'claude/fifth', baseRefName: 'claude/elsewhere' }),
    // A stranger's from a fork is never touched.
    pr({ number: 45, headRefName: 'patch-2', baseRefName: 'claude/first', author: stranger, isCrossRepository: true }),
  ];
  const merged: Record<string, unknown[]> = { 'claude/first': [{ number: 40, baseRefName: 'main' }], 'claude/elsewhere': [{ number: 39, baseRefName: 'claude/other' }] };
  const script = (args: string[]) => {
    if (args[1] === 'list') return args.includes('merged') ? ok(merged[args[args.indexOf('--head') + 1]] ?? []) : ok(prs);
    if (args[1] === 'edit' || args[1] === 'comment' || args[1] === 'merge') return ok('');
    return undefined;
  };
  const e = employee(f.checkout, { repo: 'Jcollier0120/Reeve' });
  const go = runner(script);
  const ctx = ctxFor({ employees: [e], workRoot: tmp, run: go.run, neutralDir: tmp });
  const r = await mergeOne(ctx, e, { yes: true, team: true });
  assert.deepEqual(go.gh.filter((a) => a[1] === 'edit'), [['pr', 'edit', '41', '--repo', 'Jcollier0120/Reeve', '--base', 'main']]);
  const comments = go.gh.filter((a) => a[1] === 'comment');
  assert.deepEqual(comments.map((a) => a[2]), ['41']);
  assert.match(comments[0].at(-1)!, /pointed this pull request at `main`: it was stacked on `claude\/first`, whose #40 has merged into `main`/);
  assert.match(ctx.lines.join('\n'), /#41: pointed at main: it was stacked on claude\/first, whose #40 has merged/);
  // Pointed at main, GitHub is asked again whether it merges; while it hasn't worked that out, it waits a round.
  assert.equal(go.gh.filter((a) => a[1] === 'view' && a[2] === '41').length, 3);
  assert.ok(!go.gh.some((a) => a[1] === 'merge' && a[2] === '41'));
  assert.match(r.message, /#41 .* waits: GitHub is still working out whether it merges/);
  assert.match(r.message, /#43 .* waits: stacked on #42 \(claude\/third\)/);
  assert.match(r.message, /#44 .* waits: it merges into claude\/elsewhere, not main/);
  // Looking, not acting: nothing is retargeted, and GitHub isn't asked again.
  const look = runner(script);
  await mergeOne(ctxFor({ employees: [e], workRoot: tmp, run: look.run, neutralDir: tmp }), e, { yes: false, team: true });
  assert.ok(!look.gh.some((a) => a[1] === 'edit' || a[1] === 'view'));
  // Once GitHub has worked it out (here at the second asking), it goes on in the same round, to the team's checks.
  let asked = 0;
  const answers = runner((args) => (args[1] === 'view' ? ok(++asked < 2 ? { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } : { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }) : script(args)));
  const actx = ctxFor({ employees: [e], workRoot: tmp, run: answers.run, neutralDir: tmp });
  const waited: number[] = [];
  actx.pause = async (ms) => void waited.push(ms);
  const a = await mergeOne(actx, e, { yes: true, team: true });
  assert.deepEqual(waited, [3_000, 7_000]);
  assert.match(actx.lines.join('\n'), /#41: asked GitHub again whether it merges: mergeable/);
  assert.doesNotMatch(a.message, /#41 [^;]* waits: GitHub is still working out/);
  assert.match(a.message, /#41 \([^)]*mergeable\)/);
});

test('GitHub is asked again only about a PR that waits on nothing but its working out', async () => {
  const f = fakeEmployee(path.join(tmp, 'ask-again'));
  const e = employee(f.checkout, { repo: 'Jcollier0120/Reeve' });
  const unknown = { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
  const prs = [
    pr({ number: 50, headRefName: 'claude/a', ...unknown }),
    // Checks failing, or a draft: it would wait anyway.
    pr({ number: 51, headRefName: 'claude/b', ...unknown, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'test' }] }),
    pr({ number: 52, headRefName: 'claude/c', ...unknown, isDraft: true }),
  ];
  const go = runner((args) => (args[1] === 'list' ? ok(prs) : args[1] === 'view' ? ok(unknown) : args[1] === 'merge' ? ok('') : undefined));
  const r = await mergeOne(ctxFor({ employees: [e], workRoot: tmp, run: go.run, neutralDir: tmp }), e, { yes: true, team: true });
  assert.deepEqual([...new Set(go.gh.filter((a) => a[1] === 'view').map((a) => a[2]))], ['50']);
  assert.match(r.message, /#50 .* waits: GitHub is still working out whether it merges/);
  assert.ok(!go.gh.some((a) => a[1] === 'merge'));
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
