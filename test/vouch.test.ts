import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { makersClone, MERGE_IT_YOURSELF, passingTrouble, setVouch, STATUS_WAITS_MS, versionFix, vouch, vouchedBy, vouchOn } = await import('../src/stages/vouch.ts');
const { readVersion, setVersion } = await import('../src/versions.ts');
const { makersPcForTests } = await import('../src/maker.ts');
const { noteVouchTime, vouchLimit, vouchTimes, vouchTimesFile } = await import('../src/stages/vouchtime.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
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

test('steward vouch: a branch with no PR that writes its entry in changes/ is vouched for with no version claimed, as claim-version claims none there', async () => {
  const f = fakeEmployee(path.join(tmp, 'changes-clone'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/entry');
  mkdirSync(path.join(f.checkout, 'changes'), { recursive: true });
  writeFileSync(path.join(f.checkout, 'changes', 'README.md'), 'Each piece of work writes its entry here.\n');
  writeFileSync(path.join(f.checkout, 'changes', 'claude-entry.md'), '**A fix.**\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'entry');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  sh(f.checkout, 'config', `url.${f.origin.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/Jcollier0120/Fake.git');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/entry');
  rmSync(claimsFile(), { force: true });
  const r = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'view') return { code: 1, out: '', err: 'no pull requests found for branch "claude/entry"' };
    if (a[0] === 'api') return ok('{}');
  });
  const e = employee(f.checkout, { fill: '', test: ['node -e process.exit(0)'] });
  const v = await vouch(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp }), { dir: f.checkout, say: () => {} });
  assert.equal(v.ok, true, v.message);
  assert.equal(v.message, `claude/entry's checks passed at ${head.slice(0, 7)}, and GitHub has it (${VOUCH_CONTEXT}): open its PR from that commit, and ${MERGE_IT_YOURSELF(null, 'Jcollier0120/Fake')}`);
  assert.equal(r.gh.find((a) => a[0] === 'api')?.[3], `repos/Jcollier0120/Fake/statuses/${head}`);
});

test("steward vouch refuses a PR whose version files disagree before any check runs, in a kit trial's words and with what to set where; files that agree go on as before, and one version file has nothing to disagree with", async () => {
  const f = fakeEmployee(path.join(tmp, 'versions-clone'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/versions');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  /** The files given set to their versions and committed: the new HEAD. */
  const commitVersions = (to: Record<string, string>) => {
    for (const [file, v] of Object.entries(to)) {
      const at = path.join(f.checkout, file);
      const text = readFileSync(at, 'utf8');
      writeFileSync(at, setVersion(file, text, readVersion(file, text)!, v));
    }
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', JSON.stringify(to));
    return sh(f.checkout, 'rev-parse', 'HEAD');
  };
  /** PR #9 at `head` vouched for; a check that fails would say "checks failed". */
  const go = (head: string, more: Parameters<typeof employee>[1] = {}) => {
    const said: string[] = [];
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const e = employee(f.checkout, { fill: '', test: ['node -e process.exit(0)'], ...more });
    return vouch(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp }), { dir: f.checkout, say: (l) => said.push(l) }).then((v) => ({ v, r, said }));
  };
  rmSync(claimsFile(), { force: true });

  // Reeve#207's way: package.json and its lock raised, the code's version left behind. Its checks, which would fail, never run.
  const behind = commitVersions({ 'package.json': '0.4.1', 'package-lock.json': '0.4.1' });
  const refused = await go(behind, { test: ['node -e process.exit(1)'] });
  assert.equal(refused.v.ok, false);
  assert.equal(refused.v.message, `#9 at ${behind.slice(0, 7)}: the version files disagree: package.json 0.4.1, package-lock.json 0.4.1, src/app.ts 0.4.0; set 0.4.1 in src/app.ts, push, and vouch again. Nothing was run or recorded`);
  assert.ok(!refused.said.some((l) => /its checks/.test(l)), refused.said.join('\n'));
  assert.ok(!refused.r.gh.some((a) => a[0] === 'api'), 'nothing set on GitHub');

  // The version claimed for the branch is the one to set, wherever it isn't.
  mkdirSync(path.dirname(claimsFile()), { recursive: true });
  writeFileSync(claimsFile(), JSON.stringify([{ repo: 'Jcollier0120/Fake', version: '0.4.2', branch: 'claude/versions', by: 'claude', for: 'v', at: new Date().toISOString() }]));
  const claimed = await go(behind);
  assert.equal(claimed.v.ok, false);
  assert.match(claimed.v.message, /src\/app\.ts 0\.4\.0; set 0\.4\.2 in package\.json, package-lock\.json, src\/app\.ts, push, and vouch again\. Nothing was run or recorded$/);

  // One version file has nothing to disagree with: tested and vouched for as before.
  const one = await go(behind, { versionFiles: ['package.json'] });
  assert.equal(one.v.ok, true, one.v.message);
  assert.equal(one.r.gh.find((a) => a[0] === 'api')?.[3], `repos/Jcollier0120/Fake/statuses/${behind}`);
  assert.deepEqual(one.said.filter((l) => l.startsWith('warning')), []);

  // Files that agree go on to their checks, as before; a version below the claim's is a warning, not a refusal.
  const agreed = commitVersions({ 'src/app.ts': '0.4.1' });
  const passed = await go(agreed);
  assert.equal(passed.v.ok, true, passed.v.message);
  assert.equal(passed.r.gh.find((a) => a[0] === 'api')?.[3], `repos/Jcollier0120/Fake/statuses/${agreed}`);
  assert.deepEqual(passed.said.filter((l) => l.startsWith('warning')), ['warning: its version 0.4.1 is below 0.4.2, claimed for claude/versions: set 0.4.2 in package.json, package-lock.json, src/app.ts']);
  rmSync(claimsFile(), { force: true });
  assert.deepEqual((await go(agreed)).said.filter((l) => l.startsWith('warning')), [], 'above main, nothing claimed: nothing to say');

  // And one below main's.
  const low = commitVersions({ 'package.json': '0.3.9', 'package-lock.json': '0.3.9', 'src/app.ts': '0.3.9' });
  const below = await go(low);
  assert.equal(below.v.ok, true, below.v.message);
  assert.deepEqual(below.said.filter((l) => l.startsWith('warning')), [`warning: its version 0.3.9 is below main's 0.4.0: claim one (claim-version fake --branch claude/versions --for "<what the work is>") and set it`]);

  // What to set where: a file with no version gets one too; with none to go by, there's nothing to say.
  assert.equal(versionFix([['package.json', '{"version":"0.4.1"}'], ['src/app.ts', null]]), 'set 0.4.1 in src/app.ts');
  assert.equal(versionFix([['package.json', '{}'], ['src/app.ts', null]]), null);
});

test("on a maker's other PC, a clone of one of Castellan's own repositories gives its own checks, only where GitHub says this PC's account can push there", async () => {
  // The site: no manor-agent.json, no src/app.ts, no tools/kit.ts; named by its repository.
  const site = path.join(tmp, 'CastellanSite');
  mkdirSync(site, { recursive: true });
  writeFileSync(path.join(site, 'package.json'), JSON.stringify({ name: 'castellan-site', version: '0.1.59', scripts: { test: 'node scripts/check-site.mts' } }));
  writeFileSync(path.join(site, 'tsconfig.json'), '{}');
  const ctx = { run: runner().run, neutralDir: tmp };
  const yes = async () => true;
  const e = (await makersClone(ctx, 'Jcollier0120/CastellanSite', site, { makers: false, canPush: yes }))!;
  assert.deepEqual([e.id, e.name, e.repo, e.checkout, e.fill, e.test], ['castellansite', 'CastellanSite', 'Jcollier0120/CastellanSite', site, '', ['npx tsc -p . --noEmit', 'npm test']]);
  // An agent's clone names itself (its src/app.ts).
  const agent = fakeEmployee(path.join(tmp, 'agent'));
  assert.equal((await makersClone(ctx, 'Jcollier0120/Fake', agent.checkout, { makers: false, canPush: yes }))?.id, 'fake');

  for (const [why, repo, o] of [
    ["on the maker's laptop, Settings look after them", 'Jcollier0120/CastellanSite', { makers: true, canPush: yes }],
    ["a repository that isn't Castellan's", 'someone/Thing', { makers: false, canPush: yes }],
    ["an account that can't push there: the vouch would record a pass for it", 'Jcollier0120/CastellanSite', { makers: false, canPush: async () => false }],
    ["GitHub couldn't be asked", 'Jcollier0120/CastellanSite', { makers: false, canPush: () => Promise.reject(new Error('offline')) }],
  ] as const)
    assert.equal(await makersClone(ctx, repo, site, o), null, why);
});

test("steward vouch on a maker's other PC: a clone of Castellan's own, which Settings here don't have, is tested and vouched for when this account can push there; else it says why not", async (t) => {
  makersPcForTests(() => false);
  t.after(() => makersPcForTests(null));
  const f = fakeEmployee(path.join(tmp, 'other-pc'), { files: { 'package.json': JSON.stringify({ name: 'fake', version: '0.4.0', private: true, scripts: { test: 'node -e process.exit(0)' } }) } });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/elsewhere');
  writeFileSync(path.join(f.checkout, 'e.txt'), 'e\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'e');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const go = (permission: string) => {
    const r = runner((a) => {
      if (a[0] === 'api' && a[1] === 'graphql') return ok({ data: { r0: { viewerPermission: permission } } });
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 12, state: 'OPEN', headRefOid: head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    // Settings here look after nothing of Castellan's.
    const ctx = ctxFor({ employees: [], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    return vouch(ctx, { dir: f.checkout, say: () => {} }).then((v) => ({ v, r }));
  };

  const pushes = await go('WRITE');
  assert.equal(pushes.v.ok, true, pushes.v.message);
  assert.deepEqual(pushes.r.gh.find((a) => a[0] === 'api' && a[1] === '-X'), ['api', '-X', 'POST', `repos/Jcollier0120/Fake/statuses/${head}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`, '-f', `description=npm test (the whole suite) passed at ${head.slice(0, 7)}`]);

  const reads = await go('READ');
  assert.equal(reads.v.ok, false);
  assert.equal(reads.v.message, "Jcollier0120/Fake is one of Castellan's own, and GitHub doesn't say this PC's account can push to it: only those who can vouch for it");
  assert.ok(!reads.r.gh.some((a) => a[0] === 'pr' || (a[0] === 'api' && a[1] === '-X')), 'nothing asked of the PR, nothing set');
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
