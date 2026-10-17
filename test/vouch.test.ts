import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A PR its author vouched for (stages/vouch.ts): its checks ran and passed in the author's clone at its head, and a team
// member's account said so on GitHub. Its author merges it, and the build that releases main doesn't test that code
// again (stages/mainbuild.ts); anyone else's word, a newer failure or none, and main is tested at the build. And
// `steward vouch` itself, which says to merge it yourself.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-vouch-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
// The Assayer's record of checks, never the person's own.
process.env.ASSAYER_HOME = path.join(tmp, 'assayer');
mkdirSync(process.env.ASSAYER_HOME, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

const { coveredBy } = await import('../src/stages/mainbuild.ts');
const { checksOf, VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { MERGE_IT_YOURSELF, passingTrouble, setVouch, STATUS_WAITS_MS, vouch, vouchedBy, vouchOn } = await import('../src/stages/vouch.ts');
const { assayerChecksFile, ASSAYED_MS, choseOf, covers, whyShort } = await import('../src/stages/assayed.ts');
const { noteVouchTime, vouchLimit, vouchTimes, vouchTimesFile } = await import('../src/stages/vouchtime.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
const { freePort } = await import('../kit/test/free-port.ts');
const { claimsFile } = await import('../src/claims.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const vouchStatus = { __typename: 'StatusContext', context: VOUCH_CONTEXT, state: 'SUCCESS' };

test("a vouch isn't a check GitHub runs: alone, a PR's checks are none; beside real ones, it changes nothing", () => {
  assert.equal(checksOf([vouchStatus]), 'none');
  assert.equal(checksOf([{ ...vouchStatus, state: 'FAILURE' }]), 'none');
  assert.equal(checksOf([vouchStatus, { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }]), 'pending');
  // Any other status is a check, as before.
  assert.equal(checksOf([{ __typename: 'StatusContext', context: 'ci/build', state: 'SUCCESS' }]), 'passing');
});

test("a build trusts a team member's vouch on main's head, or on the PR head a merge commit brought in unchanged; anyone else's word, a newer failure or none, and it tests main itself", async () => {
  const f = fakeEmployee(path.join(tmp, 'main'), { version: '0.4.0' });
  const commit = (file: string) => {
    writeFileSync(path.join(f.checkout, file), `${file}\n`);
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', file);
    return sh(f.checkout, 'rev-parse', 'HEAD');
  };
  // PR #7, merged by its author while up to date with main: the merge commit's tree is the PR head's.
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/thing');
  const prHead = commit('thing.txt');
  sh(f.checkout, 'switch', '--quiet', 'main');
  sh(f.checkout, 'merge', '--quiet', '--no-ff', '-m', 'Merge #7', 'claude/thing');
  const merge = sh(f.checkout, 'rev-parse', 'HEAD');
  // PR #8, merged after main moved on: the merge commit's code is neither parent's.
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/other');
  const otherHead = commit('other.txt');
  sh(f.checkout, 'switch', '--quiet', 'main');
  commit('beside.txt');
  sh(f.checkout, 'merge', '--quiet', '--no-ff', '-m', 'Merge #8', 'claude/other');
  const moved = sh(f.checkout, 'rev-parse', 'HEAD');
  const e = employee(f.checkout);
  const byTeam = { context: VOUCH_CONTEXT, state: 'success', creator: { login: 'jcollier0120' } };
  /** A ctx whose gh answers each commit's statuses from `statuses` (none for any other); `down`: GitHub doesn't answer. */
  const look = (statuses: Record<string, unknown[]>, down = false) => {
    const r = runner((a) => {
      const at = a[0] === 'api' ? /^repos\/Jcollier0120\/Fake\/commits\/([0-9a-f]{40})\/statuses\?per_page=100$/.exec(a[1]) : null;
      if (at && !down) return ok(statuses[at[1]] ?? []);
    });
    return ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
  };

  assert.equal(await vouchOn(look({ [merge]: [byTeam, { context: 'other', state: 'failure', creator: { login: 'someone' } }] }), e.repo, merge, ['Jcollier0120']), 'jcollier0120');
  assert.equal(await coveredBy(look({ [merge]: [byTeam] }), e, merge), `jcollier0120 vouched for ${merge.slice(0, 7)}`);
  assert.equal(await coveredBy(look({ [prHead]: [byTeam] }), e, merge), `jcollier0120 vouched for ${prHead.slice(0, 7)}, which ${merge.slice(0, 7)} merged unchanged`);
  assert.equal(await coveredBy(look({ [otherHead]: [byTeam] }), e, moved), null, "a PR head's vouch doesn't cover a merge that changed its code");

  // Someone outside the team, a newer failure, no vouch, or no answer from GitHub: main is tested at the build.
  for (const [why, statuses, down] of [
    ['a stranger vouched', [{ ...byTeam, creator: { login: 'stranger' } }], false],
    ['a newer failure', [{ ...byTeam, state: 'failure' }, byTeam], false],
    ['no vouch', [], false],
    ['GitHub not answering', [byTeam], true],
  ] as const) {
    assert.equal(await coveredBy(look({ [merge]: [...statuses], [prHead]: [...statuses] }, down), e, merge), null, why);
  }

  // A PR's own vouch: a team PR's head, never the Wright's (the Bailiff reviews those, and they are always tested).
  const pr: PrInfo = { number: 7, title: 'a thing', url: 'https://github.com/Jcollier0120/Fake/pull/7', head: 'claude/thing', base: 'main', author: 'Jcollier0120', whose: 'team', headOid: prHead, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 1, files: ['thing.txt'], fork: false };
  const ctx = look({ [prHead]: [byTeam] });
  assert.equal(await vouchedBy(ctx, e, pr, ['Jcollier0120']), 'jcollier0120');
  assert.equal(await vouchedBy(ctx, e, { ...pr, head: 'wright/12-thing' }, ['Jcollier0120']), null, "the Wright's");
  assert.equal(await vouchedBy(ctx, e, { ...pr, fork: true }, ['Jcollier0120']), null, "a fork's");
});

test('steward vouch: the checks run at the PR\'s head, and only once they pass is the status set; a dirty clone, another head or a failure sets none', async () => {
  const f = fakeEmployee(path.join(tmp, 'clone'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/vouched');
  writeFileSync(path.join(f.checkout, 'v.txt'), 'v\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'v');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  // The clone of a GitHub repository, as a session's is.
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const go = (o: { test?: string; prHead?: string; noPr?: boolean } = {}) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return o.noPr ? { code: 1, out: '', err: 'no pull requests found for branch "claude/vouched"' } : ok({ number: 9, state: 'OPEN', headRefOid: o.prHead ?? head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const e = employee(f.checkout, { fill: '', test: [o.test ?? 'node -e process.exit(0)'] });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    return vouch(ctx, { dir: f.checkout, say: () => {} }).then((v) => ({ v, r }));
  };

  const passed = await go();
  assert.equal(passed.v.ok, true, passed.v.message);
  assert.deepEqual(passed.r.gh.find((a) => a[0] === 'pr' && a[1] === 'view')?.slice(0, 3), ['pr', 'view', 'claude/vouched'], 'the PR for its branch');
  assert.deepEqual(passed.r.gh.find((a) => a[0] === 'api'), ['api', '-X', 'POST', `repos/Jcollier0120/Fake/statuses/${head}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`, '-f', `description=node -e process.exit(0) passed at ${head.slice(0, 7)}`]);
  // Its author merges it: the Steward merges no one's PRs.
  assert.equal(passed.v.message, `#9's checks passed at ${head.slice(0, 7)}, and GitHub has it (${VOUCH_CONTEXT}): ${MERGE_IT_YOURSELF(9, 'Jcollier0120/Fake')}. Push to it again, and vouch again.`);
  assert.equal(MERGE_IT_YOURSELF(9, 'Jcollier0120/Fake'), "merge it yourself now, once GitHub says it merges cleanly (gh pr merge 9 --repo Jcollier0120/Fake --merge): the Steward merges no one's PRs, and the next build releases main");
  assert.match(MERGE_IT_YOURSELF(null, 'Jcollier0120/Fake'), /gh pr merge <number> --repo Jcollier0120\/Fake --merge/);

  // A branch with no PR yet: vouched for as pushed once a version is claimed for it; its author then opens the PR and
  // merges it. (origin's GitHub address reads the fake origin here.)
  const unclaimed = await go({ noPr: true });
  assert.equal(unclaimed.v.ok, false);
  assert.match(unclaimed.v.message, /^claude\/vouched has no PR, and no version is claimed for it: claim one \(claim-version fake --branch claude\/vouched/);
  assert.ok(!unclaimed.r.gh.some((a) => a[0] === 'api'));
  sh(f.checkout, 'config', `url.${f.origin.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/Jcollier0120/Fake.git');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/vouched');
  mkdirSync(path.dirname(claimsFile()), { recursive: true });
  writeFileSync(claimsFile(), JSON.stringify([{ repo: 'Jcollier0120/Fake', version: '0.4.1', branch: 'claude/vouched', by: 'claude', for: 'v', at: new Date().toISOString() }]));
  const branch = await go({ noPr: true });
  assert.equal(branch.v.ok, true, branch.v.message);
  assert.equal(branch.v.message, `claude/vouched's checks passed at ${head.slice(0, 7)}, and GitHub has it (${VOUCH_CONTEXT}): open its PR (v0.4.1) from that commit, and ${MERGE_IT_YOURSELF(null, 'Jcollier0120/Fake')}`);
  assert.equal(branch.r.gh.find((a) => a[0] === 'api')?.[3], `repos/Jcollier0120/Fake/statuses/${head}`);
  rmSync(claimsFile(), { force: true });

  const failed = await go({ test: 'node -e process.exit(1)' });
  assert.equal(failed.v.ok, false);
  assert.match(failed.v.message, /checks failed at .*Nothing was recorded/);
  assert.ok(!failed.r.gh.some((a) => a[0] === 'api'));

  const moved = await go({ prHead: 'f'.repeat(40) });
  assert.equal(moved.v.ok, false);
  assert.match(moved.v.message, /#9's head is fffffff, this clone's HEAD .*: push/);
  assert.ok(!moved.r.gh.some((a) => a[0] === 'api'));

  writeFileSync(path.join(f.checkout, 'v.txt'), 'changed\n');
  const dirty = await go();
  assert.equal(dirty.v.ok, false);
  assert.match(dirty.v.message, /uncommitted changes/);
  assert.ok(!dirty.r.gh.some((a) => a[0] === 'pr' || a[0] === 'api'));
});

test("the vouch's status is set again after GitHub's passing trouble (an answer cut short, a 5xx, the network), and waits between; a refusal of it, or trouble that lasts, gives up", async () => {
  const e = employee(tmp);
  const post = async (answers: { code: number; out?: string; err?: string }[]) => {
    let i = 0;
    const waited: number[] = [];
    const r = runner((a) => (a[0] === 'api' ? { out: '', err: '', ...answers[Math.min(i++, answers.length - 1)] } : undefined));
    const ctx = { ...ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp }), pause: async (ms: number) => void waited.push(ms) };
    const why = await setVouch(ctx, e, e.repo, 'a'.repeat(40), 'npm test passed at aaaaaaa');
    return { why, tries: r.gh.filter((a) => a[0] === 'api').length, waited, lines: ctx.lines.join('\n') };
  };

  // The vouch of 15 October 2026: GitHub's answer cut short, then set fine the second time.
  const cut = await post([{ code: 1, err: 'unexpected end of JSON input' }, { code: 0, out: '{}' }]);
  assert.equal(cut.why, null);
  assert.equal(cut.tries, 2);
  assert.deepEqual(cut.waited, [STATUS_WAITS_MS[0]]);
  assert.match(cut.lines, /GitHub wouldn't take the status \(unexpected end of JSON input\): trying again in 2 s/);

  const gateway = await post([{ code: 1, err: 'gh: Bad Gateway (HTTP 502)' }, { code: 1, err: 'Post "https://api.github.com/…": read: connection reset by peer' }, { code: 0, out: '{}' }]);
  assert.equal(gateway.why, null);
  assert.equal(gateway.tries, 3);

  // Trouble that lasts: tried once and after each wait, then the last refusal says why.
  const down = await post([{ code: 1, err: 'gh: Service Unavailable (HTTP 503)' }]);
  assert.equal(down.why, "its checks passed, but GitHub wouldn't take the status: gh: Service Unavailable (HTTP 503)");
  assert.equal(down.tries, 1 + STATUS_WAITS_MS.length);
  assert.deepEqual(down.waited, STATUS_WAITS_MS);

  // GitHub refusing the status itself: asked once.
  for (const err of ['gh: Validation Failed (HTTP 422)', 'gh: Not Found (HTTP 404)', 'gh: Bad credentials (HTTP 401)', 'no such thing']) {
    const refused = await post([{ code: 1, err }, { code: 0, out: '{}' }]);
    assert.equal(refused.why, `its checks passed, but GitHub wouldn't take the status: ${err}`, err);
    assert.equal(refused.tries, 1, err);
  }
  assert.equal(passingTrouble('Post "https://api.github.com/repos/x/y/statuses/z": dial tcp: lookup api.github.com: i/o timeout'), true);
  assert.equal(passingTrouble('HTTP 500: Internal Server Error'), true);
  assert.equal(passingTrouble('HTTP 403: Resource not accessible by integration'), false);
});

test("steward vouch is stopped past its average time, with everything its checks started, and sets nothing; a pass is kept toward the average", async () => {
  const f = fakeEmployee(path.join(tmp, 'slow'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/slow');
  writeFileSync(path.join(f.checkout, 's.txt'), 's\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 's');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  // A test run that never ends, and a program it started that would write `marker` 3 s on, were it left running.
  const marker = path.join(tmp, 'slow-left-running.txt');
  const slow = path.join(tmp, 'slow.cjs');
  writeFileSync(slow, `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran on'), 3000)`)}], { stdio: 'ignore' });\nsetTimeout(() => {}, 60_000);\n`);
  const go = (test: string, overMs: number) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 11, state: 'OPEN', headRefOid: sh(f.checkout, 'rev-parse', 'HEAD'), isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const e = employee(f.checkout, { fill: '', test: [test] });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const said: string[] = [];
    return vouch(ctx, { dir: f.checkout, say: (l) => said.push(l), overMs }).then((v) => ({ v, r, e, said }));
  };
  const id = employee(f.checkout).id;
  // Three whole-suite vouches of a tenth of a second: a limit of 1.6 s with 1.5 s over.
  mkdirSync(path.dirname(vouchTimesFile()), { recursive: true });
  writeFileSync(vouchTimesFile(), JSON.stringify({ [id]: { whole: [100, 100, 100], affected: [60_000, 60_000, 60_000] } }));

  const t0 = Date.now();
  const stopped = await go(`node "${slow}"`, 1500);
  assert.equal(stopped.v.ok, false);
  assert.match(stopped.v.message, /#11's checks failed at \w+: node .* was stopped at the run's time limit, 2 s, its last 3 whole-suite vouches' average of 0 s and 2 s more\. Nothing was recorded/);
  assert.ok(Date.now() - t0 < 30_000, `stopped at its limit, not at the test's end (${Date.now() - t0} ms)`);
  assert.ok(stopped.said.some((l) => /^time limit: 2 s, its last 3 whole-suite/.test(l)), stopped.said.join('\n'));
  assert.ok(!stopped.r.gh.some((a) => a[0] === 'api'), 'no status set');
  assert.deepEqual(vouchTimes()[id].whole, [100, 100, 100], 'a stopped run is no part of the average');
  if (process.platform === 'win32') {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.ok(!existsSync(marker), 'what the checks started was ended with them');
  }

  const passed = await go('node -e process.exit(0)', 60_000);
  assert.equal(passed.v.ok, true, passed.v.message);
  assert.equal(vouchTimes()[id].whole?.length, 4, 'a pass is kept toward the average');
  assert.deepEqual(vouchTimes()[id].affected, [60_000, 60_000, 60_000], 'the affected runs apart');
});

test("a vouch's time limit: the average of the kind's last ten passes and five minutes, from the third; whole and affected apart", () => {
  const times = { a: { whole: [10 * 60_000, 20 * 60_000, 30 * 60_000], affected: [60_000, 60_000] } };
  assert.deepEqual(vouchLimit('a', 'whole', { times }), { ms: 25 * 60_000, why: "25 min, its last 3 whole-suite vouches' average of 20 min and 5 min more" });
  assert.equal(vouchLimit('a', 'affected', { times }), null, 'two runs: no limit yet');
  assert.equal(vouchLimit('b', 'whole', { times }), null, 'none yet');
  writeFileSync(vouchTimesFile(), JSON.stringify({ c: { whole: [1, 'x', -5, null], affected: 'odd' }, d: 7 }));
  assert.deepEqual(vouchTimes(), { c: { whole: [1] } }, 'what it can read');
  for (let i = 1; i <= 12; i++) noteVouchTime('c', 'affected', i * 1000);
  assert.deepEqual(vouchTimes().c.affected, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => s * 1000), 'the last ten');
  assert.deepEqual(vouchLimit('c', 'affected'), { ms: 7500 + 5 * 60_000, why: "5 min, its last 10 affected vouches' average of 8 s and 5 min more" });
  noteVouchTime('c', 'whole', 0);
  assert.deepEqual(vouchTimes().c.whole, [1], 'no time, no record');
});

test("an affected vouch reaching more test files than its usual ones gets that much more time, up to the whole suite's limit", () => {
  const min = 60_000;
  // Ten affected runs of 3 min, 20 test files each, kept with their files.
  const times = { s: { affected: Array.from({ length: 10 }, () => ({ ms: 3 * min, files: 20 })) } };
  assert.deepEqual(vouchLimit('s', 'affected', { times, files: 89 }), { ms: Math.round(3 * min * 89 / 20) + 5 * min, why: '18 min: its last 10 affected vouches took 3 min on average for 20 test files, this one runs 89, and 5 min more' });
  assert.equal(vouchLimit('s', 'affected', { times, files: 12 })?.ms, 8 * min, 'fewer files than usual: their average as before');
  assert.equal(vouchLimit('s', 'affected', { times })?.ms, 8 * min, 'files not known: as before');
  // The whole suite's limit known: never past it, nor below its own.
  const withWhole = { s: { ...times.s, whole: [12 * min, 12 * min, 12 * min] } };
  assert.deepEqual(vouchLimit('s', 'affected', { times: withWhole, files: 140 }), { ms: 17 * min, why: "17 min, its last 3 whole-suite vouches' average of 12 min and 5 min more, as it runs 140 test files, more than the 20 its affected vouches usually run" });
  assert.equal(vouchLimit('s', 'affected', { times: { s: { ...times.s, whole: [min, min, min] } }, files: 89 })?.ms, 8 * min, 'a whole suite quicker than its affected runs: their own limit stands');
  // Runs kept before their files were (bare times) count in the average, but stretch nothing until three know theirs.
  const older = { s: { affected: [3 * min, 3 * min, 3 * min, { ms: 3 * min, files: 20 }, { ms: 3 * min, files: 20 }] } };
  assert.equal(vouchLimit('s', 'affected', { times: older, files: 89 })?.ms, 8 * min);
  // Kept with its files when it ran only the affected tests; a whole-suite run as a bare time.
  writeFileSync(vouchTimesFile(), JSON.stringify({ t: { affected: [60_000, { ms: 1, files: 0 }, { ms: 'x', files: 3 }] } }));
  noteVouchTime('t', 'affected', 2 * min, 30);
  noteVouchTime('t', 'whole', 4 * min, 152);
  assert.deepEqual(vouchTimes().t, { affected: [60_000, { ms: 2 * min, files: 30 }], whole: [4 * min] }, 'what it can read, and the new runs');
});

test("steward vouch takes the Assayer's passing check of exactly HEAD's tree, and runs nothing; anything less, and the checks run", async () => {
  const f = fakeEmployee(path.join(tmp, 'assayed'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/assayed');
  writeFileSync(path.join(f.checkout, 'a.txt'), 'a\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const tree = sh(f.checkout, 'rev-parse', 'HEAD^{tree}');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const top = path.resolve(sh(f.checkout, 'rev-parse', '--show-toplevel')).toLowerCase();
  // Its checks here always fail: a vouch that passes proves they weren't run.
  const failing = 'node -e process.exit(1)';
  const passed = { at: new Date().toISOString(), outcome: 'passed', full: true, cases: ['unit-tests', 'typecheck'], commands: [failing, 'npm run typecheck'], tree, marks: { 'node_modules/.package-lock.json': '-', 'src/kit/VERSION': '-' } };
  const go = async (checks: object[], test = [failing]) => {
    writeFileSync(assayerChecksFile(), JSON.stringify({ [top]: checks }));
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const said: string[] = [];
    const e = employee(f.checkout, { fill: '', test });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const v = await vouch(ctx, { dir: f.checkout, say: (l) => said.push(l) });
    return { v, r, said };
  };

  const taken = await go([passed]);
  assert.equal(taken.v.ok, true, taken.v.message);
  assert.match(taken.said.join('\n'), /^the Assayer passed this exact tree at \d\d:\d\d: nothing run again$/m);
  assert.deepEqual(taken.r.gh.find((a) => a[0] === 'api')?.at(-1), `description=${failing}, npm run typecheck passed in the Assayer at ${head.slice(0, 7)}`);
  // The Steward's typecheck is the Assayer's typecheck case, however it is written.
  assert.equal((await go([passed], ['npx tsc -p . --noEmit', failing])).v.ok, true);

  for (const [why, checks, test] of [
    ['no record', [], [failing]],
    ['other code', [{ ...passed, tree: 'f'.repeat(40) }], [failing]],
    ['some tests only', [{ ...passed, full: undefined }], [failing]],
    ['a failure since', [{ ...passed, outcome: 'failed' }, passed], [failing]],
    ['too old', [{ ...passed, at: new Date(Date.now() - ASSAYED_MS - 60_000).toISOString() }], [failing]],
    ['a check it never ran', [passed], [failing, 'npm run build']],
    ['installed since', [{ ...passed, marks: { ...passed.marks, 'a.txt': '-' } }], [failing]],
    ['an Assayer before 0.3.31', [{ at: passed.at, outcome: 'passed', cases: ['unit-tests'] }], [failing]],
  ] as const) {
    const t = await go([...checks], [...test]);
    assert.equal(t.v.ok, false, why);
    assert.match(t.v.message, /checks failed at .*Nothing was recorded/, why);
    assert.doesNotMatch(t.said.join('\n'), /the Assayer passed/, why);
    assert.ok(!t.r.gh.some((a) => a[0] === 'api'), why);
  }
});

test("steward vouch takes a pass of the whole checks on exactly HEAD's tree on another PC on the licence, and its vouch says where it passed", async () => {
  const f = fakeEmployee(path.join(tmp, 'elsewhere'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/elsewhere');
  writeFileSync(path.join(f.checkout, 'b.txt'), 'passed on LAPTOP\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'b');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const tree = sh(f.checkout, 'rev-parse', 'HEAD^{tree}');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  writeFileSync(assayerChecksFile(), '{}');
  // Its checks here always fail: a vouch that passes proves they weren't run.
  const failing = 'node -e process.exit(1)';
  const e = employee(f.checkout, { fill: '', test: [failing] });
  const manor = path.join(tmp, 'manor');
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  const port = await freePort();
  writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ port }));
  const pass = { kind: 'checks', repo: e.repo, tree, commit: head, ok: true, at: new Date().toISOString(), commands: [failing], node: process.versions.node, platform: process.platform, pc: { id: 'pc-2', name: 'LAPTOP' } };
  const fake = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 1, result: pass })));
  await new Promise<void>((resolve) => fake.listen(port, '127.0.0.1', resolve));
  process.env.MANOR_HOME = manor;
  try {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 10, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const said: string[] = [];
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const v = await vouch(ctx, { dir: f.checkout, say: (l) => said.push(l) });
    assert.equal(v.ok, true, `${v.message}\n${said.join('\n')}`);
    assert.match(said.join('\n'), /^its checks passed on LAPTOP at \d\d:\d\d, on exactly this code \(tree [0-9a-f]{7}\): not run again$/m);
    assert.equal(r.gh.find((a) => a[0] === 'api')?.at(-1), `description=${failing} passed on LAPTOP at ${head.slice(0, 7)}`);
  } finally {
    delete process.env.MANOR_HOME;
    await new Promise((resolve) => fake.close(resolve));
  }
});

test("steward vouch takes the Assayer's affected pass of HEAD's tree when its test files take in the ones the change reaches; fewer, unnamed or a whole-suite vouch, and the checks run", async () => {
  // Three test files that fail when run: a vouch that passes proves none ran. The branch changes src/a.mjs, which
  // test/a.test.mjs alone reaches.
  const failing = "import { test } from 'node:test';\ntest('ran', () => { throw new Error('this ran'); });\n";
  const f = fakeEmployee(path.join(tmp, 'assayed-affected'), {
    version: '0.4.0',
    files: {
      'package.json': '{\n  "name": "fake",\n  "version": "0.4.0",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "test": "node --test \\"test/**/*.test.mjs\\""\n  }\n}\n',
      'src/a.mjs': 'export const a = 1;\n',
      'src/b.mjs': 'export const b = 2;\n',
      'test/a.test.mjs': `import '../src/a.mjs';\n${failing}`,
      'test/b.test.mjs': `import '../src/b.mjs';\n${failing}`,
      'test/c.test.mjs': failing,
    },
  });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/assayed-affected');
  writeFileSync(path.join(f.checkout, 'src/a.mjs'), 'export const a = 1; // tidied\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const tree = sh(f.checkout, 'rev-parse', 'HEAD^{tree}');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const top = path.resolve(sh(f.checkout, 'rev-parse', '--show-toplevel')).toLowerCase();
  const steps = ['npm run typecheck', 'npm test'];
  const passed = { at: new Date().toISOString(), outcome: 'passed', affected: true, cases: ['unit-tests', 'typecheck'], commands: ['npm test', 'npm run typecheck'], ran: { 'npm test': ['test/a.test.mjs', 'test/b.test.mjs'], 'npm run typecheck': 'all' }, tree, marks: { 'src/kit/VERSION': '-' } };
  const go = async (checks: object[], o: { whole?: boolean } = {}) => {
    writeFileSync(assayerChecksFile(), JSON.stringify({ [top]: checks }));
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const said: string[] = [];
    const e = employee(f.checkout, { fill: '', test: steps });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    if (o.whole) ctx.settings.affectedTests = false;
    const v = await vouch(ctx, { dir: f.checkout, say: (l) => said.push(l) });
    return { v, r, said, description: r.gh.find((a) => a[0] === 'api')?.at(-1) };
  };

  // Its two test files take in test/a.test.mjs: taken, and the status says it was an affected vouch, the Assayer's.
  const taken = await go([passed]);
  assert.equal(taken.v.ok, true, taken.v.message);
  assert.match(taken.said.join('\n'), /^the Assayer passed this exact tree at \d\d:\d\d \(npm test: affected: 2 of 3 test files, the Assayer's\): nothing run again$/m);
  assert.equal(taken.description, `description=npm run typecheck, npm test (affected: 2 of 3 test files, the Assayer's) passed at ${head.slice(0, 7)}`);
  // Every test, as it is: taken, whether the vouch would run some or (Settings) all of them; and a whole check still is.
  const all = { ...passed, ran: { ...passed.ran, 'npm test': 'all' } };
  assert.equal((await go([all])).description, `description=npm run typecheck, npm test (the whole suite, the Assayer's) passed at ${head.slice(0, 7)}`);
  assert.equal((await go([all], { whole: true })).v.ok, true);
  assert.equal((await go([{ ...passed, affected: undefined, full: true, ran: undefined }])).description, `description=npm test, npm run typecheck passed in the Assayer at ${head.slice(0, 7)}`);
  // A typecheck it doesn't name in what ran is the Assayer's typecheck case, which is never narrowed.
  assert.equal((await go([{ ...passed, ran: { 'npm test': passed.ran['npm test'] } }])).v.ok, true);

  for (const [why, checks, o] of [
    ['it left out the test file the change reaches', [{ ...passed, ran: { ...passed.ran, 'npm test': ['test/b.test.mjs'] } }], {}],
    ['no test ran', [{ ...passed, ran: { ...passed.ran, 'npm test': [] } }], {}],
    ['its runner chose the tests, unnamed', [{ ...passed, ran: { 'npm run typecheck': 'all' } }], {}],
    ['an Assayer that keeps no files', [{ ...passed, ran: undefined }], {}],
    ['Settings say the whole suite', [passed], { whole: true }],
    ['other code', [{ ...passed, tree: 'f'.repeat(40) }], {}],
    ['a failure since', [{ ...passed, outcome: 'failed' }, passed], {}],
    ['a check it never ran', [{ ...passed, commands: ['npm test'], cases: ['unit-tests'] }], {}],
  ] as const) {
    const t = await go([...checks], o);
    assert.equal(t.v.ok, false, why);
    assert.match(t.v.message, /checks failed at .*Nothing was recorded/, why);
    assert.doesNotMatch(t.said.join('\n'), /the Assayer passed/, why);
    assert.equal(t.description, undefined, why);
  }
});

test("an affected Assayer check stands in only when each check ran as it is, but npm test, whose files take in the vouch's own", () => {
  const pick = { files: ['test/a.test.ts'], tests: ['test/a.test.ts', 'test/b.test.ts'], why: '', flags: [], pretest: false };
  const c = { cases: ['unit-tests', 'typecheck'], ran: { 'npm test': ['test/a.test.ts', 'test/c.test.ts'], 'npm run typecheck': 'all' as const } };
  assert.equal(whyShort(['npm run typecheck', 'npm test'], c, pick), null);
  assert.equal(whyShort(['npx tsc -p . --noEmit', 'npm test'], c, pick), null);
  assert.equal(whyShort(['npm test'], c, { ...pick, files: [] }), null);
  assert.equal(whyShort(['npm test'], { ...c, ran: { 'npm test': ['.\\test\\a.test.ts'] } }, pick), null, 'its paths, however written');
  assert.equal(whyShort(['npm test'], c, { ...pick, files: ['test/a.test.ts', 'test/b.test.ts'] }), 'it left out 1 of the 2 test files this change reaches (test/b.test.ts)');
  assert.equal(whyShort(['npm test'], c, { whole: 'tsconfig.json changed' }), "it ran only some of npm test's tests, and this vouch runs them all");
  assert.equal(whyShort(['npm test'], { ...c, ran: { 'npm test': 'all' } }, { whole: 'tsconfig.json changed' }), null);
  assert.equal(whyShort(['npm test', 'npm run lint'], c, pick), "it doesn't say which tests npm run lint ran");
  assert.equal(whyShort(['npm run test:web'], { ...c, ran: { 'npm run test:web': ['test/w.test.ts'] } }, pick), "it ran only some of npm run test:web's tests, and this vouch runs them all");
  assert.equal(choseOf(c, pick), "affected: 2 of 2 test files, the Assayer's");
  assert.equal(choseOf({ ran: { 'npm test': [] } }, pick), "no test reaches the change, the Assayer's");
  assert.equal(choseOf({ ran: {} }, pick), undefined);
});

test('the Assayer check covers a vouch only when it ran each of its checks', () => {
  const c = { cases: ['unit-tests', 'typecheck'], commands: ['npm test', 'npm run typecheck'] };
  assert.equal(covers(['npx tsc -p . --noEmit', 'npm test'], c), true);
  assert.equal(covers(['npm run typecheck', 'npm test'], c), true);
  assert.equal(covers(['npm test', 'npm run build'], c), false);
  assert.equal(covers(['npx tsc -p . --noEmit', 'npm test'], { cases: ['unit-tests'], commands: ['npm test'] }), false);
  assert.equal(covers(['dotnet test HEI.Core.Tests'], { cases: ['unit-tests'], commands: ['dotnet test'] }), false);
});
