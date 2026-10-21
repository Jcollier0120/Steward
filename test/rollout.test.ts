import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The rollout in a round (stages/rollout.ts): which employees a new kit release reaches, as pure decisions; then whole
// rounds on a data folder of their own, a fake employee's git, and gh standing in. The rollout merges the kit PRs it
// opens itself (Steward 0.36.124: no one else merges the Steward's PRs), and the round releases them. Nothing reaches
// GitHub, the live ~/.steward or the real checkouts.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-rollout-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { planRollout, rollout, rolloutFacts, rolloutGate, loadRolloutFailures, settleKit, settlingLine, urgentIn } = await import('../src/stages/rollout.ts');
const { bumpOne } = await import('../src/stages/bump.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS, normalizeSettings } = await import('../src/settings.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');

const porter = employee('C:\\nowhere\\Porter', { id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter' });
const clerk = employee('C:\\nowhere\\Clerk', { id: 'clerk', name: 'Clerk', repo: 'Jcollier0120/Clerk' });
const miller = employee('C:\\nowhere\\Miller', { id: 'miller', name: 'Miller', repo: 'Jcollier0120/Miller' });
const manor = employee('C:\\nowhere\\Manor', { id: 'manor', name: 'Manor', repo: 'Jcollier0120/Manor', usesKit: false });
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const facts = (pin: string | null, more = {}) => ({ checkout: true, head: H1, pin, kitPrs: [] as string[], ...more });

test('a new kit release: each employee behind it is bumped; not one already on it, nor one with a kit PR open', () => {
  const plan = planRollout({
    on: true,
    kit: '2.9.1',
    ownKit: '2.9.1',
    employees: [porter, clerk, miller, manor],
    facts: { porter: facts('2.9.0'), clerk: facts('2.9.1'), miller: facts('2.8.3', { kitPrs: ['#12 (steward/kit-2.9.0)'] }) },
    failed: {},
  });
  assert.equal(plan.kit, '2.9.1');
  assert.deepEqual(plan.bump.map((b) => [b.employee.id, b.head]), [['porter', H1]]);
  assert.deepEqual(plan.skip.map((s) => [s.employee.id, s.why]), [
    ['clerk', 'on kit 2.9.1 already'],
    ['miller', 'its kit PR #12 (steward/kit-2.9.0) is open: close it, and the next build rolls the kit out afresh'],
    ['manor', 'not using the kit yet'],
  ]);
  // A pin ahead of the newest release (a trial) is left alone, and so is one with no checkout, no kit.json or no branch.
  const odd = planRollout({ on: true, kit: '2.9.1', ownKit: null, employees: [porter, clerk, miller], facts: { porter: facts('3.0.0'), clerk: { checkout: false, head: null, pin: null, kitPrs: [] }, miller: facts(null) }, failed: {} });
  assert.deepEqual(odd.bump, []);
  assert.deepEqual(odd.skip.map((s) => s.why), ['on kit 3.0.0 already', 'no checkout at C:\\nowhere\\Clerk', 'no kit.json on origin/main']);
});

test("a kit PR of the Steward's left open at the kit rolled out is merged by the rollout, not bumped again", () => {
  const plan = planRollout({ on: true, kit: '2.9.1', ownKit: null, employees: [porter, clerk], facts: { porter: facts('2.9.0', { kitPrs: ['#12 (steward/kit-2.9.1)'], own: { number: 12, head: H2 } }), clerk: facts('2.9.0') }, failed: {} });
  assert.deepEqual(plan.merge?.map((m) => [m.employee.id, m.number, m.head]), [['porter', 12, H2]]);
  assert.deepEqual(plan.bump.map((b) => b.employee.id), ['clerk']);
  assert.deepEqual(plan.skip, []);
});

test('a bump that failed is held for that kit until a new commit lands on its branch; a newer kit is tried at once', () => {
  const failed = { porter: { kit: '2.9.1', head: H1, stage: 'bump' as const, message: 'npm test failed (exit 1)', at: '' } };
  const held = planRollout({ on: true, kit: '2.9.1', ownKit: null, employees: [porter], facts: { porter: facts('2.9.0') }, failed });
  assert.deepEqual(held.bump, []);
  assert.equal(held.skip[0].held, true);
  assert.match(held.skip[0].why, /^its bump to kit 2\.9\.1 failed at aaaaaaa \(npm test failed \(exit 1\)\), so the rounds leave it until a new commit lands on main, or you press Bump$/);
  assert.deepEqual(planRollout({ on: true, kit: '2.9.1', ownKit: null, employees: [porter], facts: { porter: facts('2.9.0', { head: H2 }) }, failed }).bump.map((b) => b.head), [H2], 'a new commit');
  assert.equal(planRollout({ on: true, kit: '2.9.2', ownKit: null, employees: [porter], facts: { porter: facts('2.9.0') }, failed }).bump.length, 1, 'a newer kit');
});

test("an employee whose own open PR pins the kit already gets no kit-only PR beside it, which would take that PR's version", async () => {
  const plan = planRollout({ on: true, kit: '2.39.0', ownKit: null, employees: [porter, clerk], facts: { porter: facts('2.38.0', { pinPrs: ['#68 (claude/developer-options, kit 2.39.0)'] }), clerk: facts('2.38.0') }, failed: {} });
  assert.deepEqual(plan.bump.map((b) => b.employee.id), ['clerk']);
  assert.deepEqual(plan.skip.map((s) => s.why), ['its open PR #68 (claude/developer-options, kit 2.39.0) already brings kit 2.39.0, so it gets no kit PR of its own beside it']);

  // Read from the PR's branch on origin: one that pins the kit (or a newer one) counts; one that pins an older kit, or
  // doesn't change kit.json, doesn't.
  const dir = mkdtempSync(path.join(home, 'pins-'));
  const fk = fakeEmployee(dir, { kit: '1.0.0' });
  const branch = (name: string, kit: string | null) => {
    sh(fk.checkout, 'checkout', '--quiet', '-b', name, 'origin/main');
    if (kit) writeFileSync(path.join(fk.checkout, 'kit.json'), `{\n  "kit": "${kit}",\n  "parts": ["node"]\n}\n`);
    writeFileSync(path.join(fk.checkout, `${name.replace(/\//g, '-')}.md`), name);
    sh(fk.checkout, 'add', '-A');
    sh(fk.checkout, 'commit', '--quiet', '-m', name);
    sh(fk.checkout, 'push', '--quiet', 'origin', name);
    sh(fk.checkout, 'checkout', '--quiet', 'main');
  };
  branch('claude/developer-options', '1.0.1');
  branch('claude/older', '1.0.0');
  branch('claude/notes', null);
  const pr = (number: number, head: string, files: string[]) => ({ number, title: `Fake 0.4.${number}: work`, url: `u${number}`, body: '', headRefName: head, headRefOid: '', baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, files: files.map((p) => ({ path: p })) });
  let open = [pr(20, 'claude/developer-options', ['kit.json', 'src/a.ts']), pr(21, 'claude/older', ['kit.json']), pr(22, 'claude/notes', ['claude-notes.md'])];
  const e = employee(fk.checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: runner((a) => (a[0] === 'pr' && a[1] === 'list' ? ok(open) : undefined)).run, neutralDir: dir });
  assert.deepEqual((await rolloutFacts(ctx, e, '1.0.1')).pinPrs, ['#20 (claude/developer-options, kit 1.0.1)']);
  open = open.slice(1);
  assert.deepEqual((await rolloutFacts(ctx, e, '1.0.1')).pinPrs, [], 'with that PR merged or closed, the kit is rolled out as ever');
});

test('a kit PR open for an older kit takes the new kit (the fold), instead of waiting to merge and a second kit PR after it', async () => {
  const fold = { number: 12, head: 'steward/kit-2.9.0', kit: '2.9.0' };
  const plan = planRollout({ on: true, kit: '2.9.1', ownKit: null, employees: [porter, miller], facts: { porter: facts('2.8.3', { kitPrs: ['#12 (steward/kit-2.9.0)'], fold }), miller: facts('2.8.3', { kitPrs: ['#13 (steward/kit-2.9.1)'] }) }, failed: {} });
  assert.deepEqual(plan.bump.map((b) => [b.employee.id, b.fold]), [['porter', fold]]);
  assert.deepEqual(plan.skip.map((s) => s.why), ['its kit PR #13 (steward/kit-2.9.1) is open: close it, and the next build rolls the kit out afresh']);
  // A fold that failed at that head is held like any bump.
  const failed = { porter: { kit: '2.9.1', head: H1, stage: 'bump' as const, message: 'npm test failed (exit 1)', at: '' } };
  assert.deepEqual(planRollout({ on: true, kit: '2.9.1', ownKit: null, employees: [porter], facts: { porter: facts('2.8.3', { kitPrs: ['#12 (steward/kit-2.9.0)'], fold }) }, failed }).bump, []);

  // Read from the kit PR's branch on origin: it folds when that pins an older kit than the one rolled out; not when it
  // pins that kit already, nor when more than one kit PR is open.
  const dir = mkdtempSync(path.join(home, 'folds-'));
  const fk = fakeEmployee(dir, { kit: '1.0.0' });
  const branch = (name: string, kit: string) => {
    sh(fk.checkout, 'checkout', '--quiet', '-b', name, 'origin/main');
    writeFileSync(path.join(fk.checkout, 'kit.json'), `{\n  "kit": "${kit}",\n  "parts": ["node"]\n}\n`);
    sh(fk.checkout, 'commit', '--quiet', '-am', name);
    sh(fk.checkout, 'push', '--quiet', 'origin', name);
    sh(fk.checkout, 'checkout', '--quiet', 'main');
  };
  branch('steward/kit-1.0.1', '1.0.1');
  branch('steward/kit-1.0.2', '1.0.2');
  const pr = (number: number, head: string) => ({ number, title: `Fake 0.4.${number}: the Steward's kit`, url: `u${number}`, body: '', headRefName: head, headRefOid: '', baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, files: [{ path: 'kit.json' }] });
  let open = [pr(30, 'steward/kit-1.0.1')];
  const e = employee(fk.checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: runner((a) => (a[0] === 'pr' && a[1] === 'list' ? ok(open) : undefined)).run, neutralDir: dir });
  assert.deepEqual((await rolloutFacts(ctx, e, '1.0.2')).fold, { number: 30, head: 'steward/kit-1.0.1', kit: '1.0.1' });
  open = [pr(31, 'steward/kit-1.0.2')];
  const on = await rolloutFacts(ctx, e, '1.0.2');
  assert.deepEqual([on.kitPrs, on.fold], [['#31 (steward/kit-1.0.2)'], undefined]);
  open = [pr(30, 'steward/kit-1.0.1'), pr(31, 'steward/kit-1.0.2')];
  assert.equal((await rolloutFacts(ctx, e, '1.0.3')).fold, undefined);
});

test("a round's rollout folds the new kit onto the open kit PR: pushed onto its branch, the PR retitled and merged, none opened", async () => {
  const dir = mkdtempSync(path.join(home, 'fold-round-'));
  const fk = fakeEmployee(dir, { kit: '1.0.0' });
  const e = employee(fk.checkout, { fill: '' });
  let open: any[] = [];
  const r = runner((a) => {
    if (a[0] === 'release' && a[1] === 'list') return ok([]);
    if (a[0] === 'pr' && a[1] === 'list') return ok(open);
    if (a[0] === 'pr' && a[1] === 'view') return ok({ state: 'OPEN', headRefName: 'steward/kit-1.0.1' });
    if (a[0] === 'pr' && a[1] === 'edit') return ok('');
    if (a[0] === 'pr' && a[1] === 'merge') return ok('');
  });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  // Kit 1.0.1's PR, open and waiting.
  assert.equal((await bumpOne(ctx, e, { kit: '1.0.1', changelog: null })).outcome, 'done');
  sh(fk.checkout, 'push', '--quiet', 'origin', 'steward/kit-1.0.1');
  open = [{ number: 30, title: "Fake 0.4.1: the Steward's kit 1.0.1", url: 'u30', body: '', headRefName: 'steward/kit-1.0.1', headRefOid: '', baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, files: [{ path: 'kit.json' }] }];

  const out = await rollout(ctx, [e], { kit: '1.0.2', ownKit: null, changelog: async () => null });
  assert.deepEqual(out.results.map((x) => [x.outcome, x.message.replace(/\(.{7}\)/, '(…)')]), [['done', `rollout: kit 1.0.2: 0.4.1 on steward/kit-1.0.1 (…): kit 1.0.1 → 1.0.2, onto its open PR #30, checks passed; put kit 1.0.2 onto its open PR #30, now "Fake 0.4.1: the Steward's kit 1.0.2"; merged it`]]);
  assert.match(sh(fk.origin, 'show', 'steward/kit-1.0.1:kit.json'), /"kit": "1\.0\.2"/);
  assert.ok(!r.gh.some((a) => a[1] === 'create'), 'no second kit PR');
  assert.ok(r.gh.some((a) => a[1] === 'edit' && a[2] === '30'));
  // Merged at the commit pushed onto it.
  const merge = r.gh.filter((a) => a[1] === 'merge');
  assert.deepEqual(merge.map((a) => [a[2], a[a.indexOf('--match-head-commit') + 1]]), [['30', sh(fk.origin, 'rev-parse', 'steward/kit-1.0.1')]]);
});

test("a rollout merges the Steward's kit PR left open at the kit it rolls out, at its head; one GitHub won't merge says so", async () => {
  const dir = mkdtempSync(path.join(home, 'own-'));
  const fk = fakeEmployee(dir, { kit: '1.0.0' });
  sh(fk.checkout, 'checkout', '--quiet', '-b', 'steward/kit-1.0.1', 'origin/main');
  writeFileSync(path.join(fk.checkout, 'kit.json'), '{\n  "kit": "1.0.1",\n  "parts": ["node"]\n}\n');
  sh(fk.checkout, 'commit', '--quiet', '-am', 'kit 1.0.1');
  sh(fk.checkout, 'push', '--quiet', 'origin', 'steward/kit-1.0.1');
  const sha = sh(fk.checkout, 'rev-parse', 'HEAD');
  sh(fk.checkout, 'checkout', '--quiet', 'main');
  const open = [{ number: 30, title: "Fake 0.4.1: the Steward's kit 1.0.1", url: 'u30', body: '', headRefName: 'steward/kit-1.0.1', headRefOid: sha, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, files: [{ path: 'kit.json' }] }];
  const e = employee(fk.checkout, { fill: '' });
  let merges = true;
  const r = runner((a) => (a[0] === 'pr' && a[1] === 'list' ? ok(open) : a[0] === 'pr' && a[1] === 'merge' ? (merges ? ok('') : { code: 1, out: '', err: 'GraphQL: Pull Request is not mergeable (mergePullRequest)' }) : undefined));
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  assert.deepEqual((await rolloutFacts(ctx, e, '1.0.1')).own, { number: 30, head: sha });

  const out = await rollout(ctx, [e], { kit: '1.0.1', ownKit: null, changelog: async () => null });
  assert.deepEqual(out.results.map((x) => [x.outcome, x.message]), [['done', 'rollout: merged its kit PR #30 (kit 1.0.1)']]);
  const merge = r.gh.filter((a) => a[1] === 'merge');
  assert.deepEqual(merge, [['pr', 'merge', '30', '--repo', 'Jcollier0120/Fake', '--merge', '--match-head-commit', sha, '--delete-branch']]);
  assert.ok(!r.gh.some((a) => a[1] === 'create'), 'no second kit PR');

  merges = false;
  const refused = await rollout(ctx, [e], { kit: '1.0.1', ownKit: null, changelog: async () => null });
  assert.deepEqual(refused.results.map((x) => x.outcome), ['failed']);
  assert.match(refused.results[0].message, /^rollout: its kit PR #30 at kit 1\.0\.1 is open still \(.* wouldn't merge #30: GraphQL: Pull Request is not mergeable \(mergePullRequest\)\): the next build tries again$/);
  assert.equal(r.gh.filter((a) => a[1] === 'merge').length, 1 + 4, 'asked again after each wait');
});

test('nothing is rolled out with the setting off, with no kit release, or while this Steward carries an older kit', () => {
  const all = { employees: [porter], facts: { porter: facts('2.9.0') }, failed: {} };
  const off = planRollout({ on: false, kit: '2.9.1', ownKit: '2.9.1', ...all });
  assert.deepEqual([off.kit, off.bump.length, off.waitsForSteward], [null, 0, false]);
  assert.match(off.why!, /is off in Settings/);
  assert.deepEqual(rolloutGate({ on: true, kit: null, ownKit: '2.9.0' }), { why: 'no kit release to roll out', waitsForSteward: false });
  const waits = planRollout({ on: true, kit: '2.9.1', ownKit: '2.9.0', ...all });
  assert.deepEqual([waits.bump.length, waits.waitsForSteward], [0, true]);
  assert.match(waits.why!, /^kit 2\.9\.1 waits for this Steward to carry it \(it carries 2\.9\.0/);
  assert.equal(normalizeSettings({}).settings.rollout, true, 'on by default');
  assert.equal(normalizeSettings({ rollout: false }).settings.rollout, false);
});

test('a bump or push the rounds gave up on is an alarm at once; a kit waiting on the Steward itself, after a day', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const failedRollouts = { porter: { kit: '2.9.1', head: H1, stage: 'bump' as const, message: 'npm test failed (exit 1)' }, gone: { kit: '2.9.1', head: H1, stage: 'bump' as const, message: 'x' } };
  const c = roundConditions({ round, failedReleases: {}, failedRollouts, rolloutWaits: { kit: '2.9.1', own: '2.9.0' }, employees: [porter], settings });
  assert.deepEqual(c.map((x) => [x.id, x.afterMs]), [['rollout:porter:2.9.1', 0], ['rollout:waits:2.9.1', 24 * 3_600_000]]);
  assert.match(c[0].title, /^Porter's bump to kit 2\.9\.1 failed, and the rounds won't try it again until its branch moves$/);
  assert.equal(c[0].detail[0], 'npm test failed (exit 1)');
  assert.deepEqual(roundConditions({ round, failedReleases: {}, failedRollouts, rolloutWaits: { kit: '2.9.1', own: '2.9.0' }, employees: [porter], settings: { ...settings, rollout: false } }), [], 'off: no alarm');
});

// Whole rounds: a fake employee on kit 1.0.0, and the kit releases GitHub lists.
const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0', kit: '1.0.0' });
const checks = path.join(home, 'checks.txt');
const failFlag = path.join(home, 'fail-checks');
const attempts = path.join(home, 'released.txt');
const check = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],'x');process.exit(fs.existsSync(process.argv[2])?1:0)" ${checks} ${failFlag}`;
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: [check], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    afterRelease: [],
    stewardRepo: 'octocat/steward',
    alarms: { manorUrl: '', surveyorUrl: '', toast: false },
  }),
);

let kits = ['1.0.0'];
let glanceFails = false;
/** What `gh pr create` says while it fails (the network cut it short), or null while it works. */
let createFails: string | null = null;
/** The Steward's open PRs on the fake, as GitHub's GraphQL gives them. */
let prs: any[] = [];
let prNumber = 6;
const released = () => ['0.4.0', ...(existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : [])];
const graph = () => ({
  data: {
    steward: { releases: { nodes: kits.map((k) => ({ tagName: `kit-v${k}`, isDraft: false })) } },
    e0: {
      ref: { target: { oid: sh(f.origin, 'rev-parse', 'main') } },
      pullRequests: { nodes: prs },
      releases: { nodes: released().map((v) => ({ tagName: `v${v}`, isDraft: false, publishedAt: null, tagCommit: null })) },
    },
  },
});
let gh: string[][] = [];
const run = async (cmd: string, args: string[], opts?: any) => {
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  gh.push(args);
  if (args[0] === 'api' && args[1] === 'graphql') return glanceFails ? { code: 1, out: '', err: 'gh: a moment of no network' } : ok(graph());
  if (args[0] === 'release' && args[1] === 'list') {
    if (args.includes('octocat/steward')) return ok(kits.map((k) => ({ tagName: `kit-v${k}`, isDraft: false })));
    return ok(released().map((v) => ({ tagName: `v${v}`, isDraft: false })));
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    const head = args[args.indexOf('--head') + 1];
    const open = prs.filter((p) => !args.includes('--head') || p.headRefName === head);
    return ok(open.map((p) => ({ ...p, author: { login: p.author.login }, labels: [], files: [], statusCheckRollup: [] })));
  }
  if (args[0] === 'pr' && args[1] === 'create') {
    if (createFails) return { code: 1, out: '', err: createFails };
    const head = args[args.indexOf('--head') + 1];
    const n = ++prNumber;
    prs.push({ number: n, title: args[args.indexOf('--title') + 1], url: `https://github.com/Jcollier0120/Fake/pull/${n}`, body: '', headRefName: head, headRefOid: sh(f.origin, 'rev-parse', head), baseRefName: 'main', isCrossRepository: false, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 8, deletions: 8, author: { __typename: 'User', login: 'Jcollier0120' }, labels: { nodes: [] }, files: { nodes: [] }, commits: { nodes: [] } });
    return ok(`https://github.com/Jcollier0120/Fake/pull/${n}\n`);
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const pr = prs.find((p) => String(p.number) === args[2])!;
    sh(f.origin, 'update-ref', 'refs/heads/main', pr.headRefOid);
    sh(f.origin, 'update-ref', '-d', `refs/heads/${pr.headRefName}`);
    prs = prs.filter((p) => p !== pr);
    return ok('');
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};
const round = (full = false) => {
  gh = [];
  return runStage('round', full ? { full: true } : {}, { run, ownKit: '9.9.9' });
};
const checksRun = () => (existsSync(checks) ? readFileSync(checks, 'utf8').length : 0);
const created = () => gh.filter((a) => a[0] === 'pr' && a[1] === 'create');
const openAlarms = () => JSON.parse(readFileSync(path.join(home, 'alarms.json'), 'utf8')).open.map((a: any) => a.id);
/** A commit pushed straight to origin's main, as a person's would be. */
function commit(file: string) {
  sh(f.checkout, 'pull', '--quiet', '--ff-only', 'origin', 'main');
  writeFileSync(path.join(f.checkout, file), `${file}\n`);
  sh(f.checkout, 'add', file);
  sh(f.checkout, 'commit', '--quiet', '-m', file);
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
}

test('a round rolls a new kit out by itself: bumped, its PR opened and merged by the Steward, and released in the same round', async () => {
  const first = await round();
  assert.equal(first.error, undefined);
  assert.deepEqual(created(), [], 'on the newest kit already');

  kits = ['1.0.1', '1.0.0'];
  const out = await round();
  assert.equal(out.error, undefined, out.log.join('\n'));
  const r = out.results.find((x) => x.message.startsWith('rollout: '))!;
  assert.equal(r.outcome, 'done', `${r.message}\n${out.log.join('\n')}`);
  assert.match(r.message, /^rollout: kit 1\.0\.1: 0\.4\.1 on steward\/kit-1\.0\.1 \(.{7}\): kit 1\.0\.0 → 1\.0\.1, checks passed; opened "Fake 0\.4\.1: the Steward's kit 1\.0\.1"; merged it$/);
  assert.equal(created().length, 1);
  // Merged by the Steward at the commit it pushed, its branch deleted: no one else merges the Steward's PRs.
  const merge = gh.filter((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.deepEqual(merge.map((a) => [a[2], a.includes('--delete-branch'), a[a.indexOf('--match-head-commit') + 1]]), [['7', true, sh(f.origin, 'rev-parse', 'main')]]);
  assert.equal(sh(f.origin, 'show', 'main:kit.json'), '{\n  "kit": "1.0.1",\n  "parts": ["node"]\n}');
  // And released in the same round, main's head tested first (no vouch covers it).
  assert.deepEqual(out.results.filter((x) => x.message.startsWith('release: ')).map((x) => x.message.replace(/\(.{7}\)/, '(…)')), ['release: released v0.4.1 from origin/main (…), with kit 1.0.1']);
  assert.deepEqual(released(), ['0.4.0', '0.4.1']);

  // The next round: nothing left to do.
  const next = await round();
  assert.deepEqual(next.results.filter((x) => x.outcome !== 'skipped').map((x) => x.message), []);
  assert.deepEqual(created(), [], 'not bumped again: main pins 1.0.1 now');
});

test("a bump whose checks fail is an alarm, and isn't tried again for that kit until a new commit; Bump lets it go", async () => {
  writeFileSync(failFlag, '');
  kits = ['1.0.2', '1.0.1', '1.0.0'];
  const failed = await round();
  const r = failed.results.find((x) => x.message.startsWith('rollout: '))!;
  assert.equal(r.outcome, 'failed');
  assert.match(r.message, /^rollout: bump to kit 1\.0\.2: node -e .* failed \(exit 1\), twice; the worktree is left at /);
  assert.deepEqual(Object.keys(loadRolloutFailures()), ['fake']);
  assert.deepEqual(openAlarms(), ['rollout:fake:1.0.2']);

  // Run now: every employee looked at, but the bump isn't tried again at the same commit.
  const n = checksRun();
  const again = await round(true);
  assert.equal(checksRun(), n, 'its checks not run again');
  assert.match(again.results.find((x) => x.message.startsWith('rollout: '))!.message, /^rollout: its bump to kit 1\.0\.2 failed at .{7} \(.*\), so the rounds leave it until a new commit lands on main, or you press Bump$/);
  assert.deepEqual(openAlarms(), ['rollout:fake:1.0.2'], 'still open');

  // A new commit on its branch: tried again (and it fails again, at the new head).
  commit('NOTES.md');
  const head = sh(f.origin, 'rev-parse', 'main');
  await round();
  assert.ok(checksRun() > n, 'tried again');
  assert.equal(loadRolloutFailures().fake.head, head);

  // Fixed, and Bump pressed: the hold is let go, and the next round pushes it.
  unlinkSync(failFlag);
  const bumped = await runStage('bump', {}, { run, ownKit: '9.9.9' });
  assert.equal(bumped.results[0].outcome, 'done', bumped.results[0].message);
  assert.deepEqual(loadRolloutFailures(), {});
  const pushed = await round();
  assert.match(pushed.results.find((x) => x.message.startsWith('rollout: '))!.message, /opened "Fake 0\.4\.2: the Steward's kit 1\.0\.2"; merged it$/);
  assert.deepEqual(openAlarms(), [], 'the alarm cleared');
  assert.deepEqual(released().at(-1), '0.4.2', 'released in the same round');
});

test("a glance that misses doesn't stall a rollout: the round asks on its own and rolls the kit out", async () => {
  kits = ['1.0.3', '1.0.2', '1.0.1', '1.0.0'];
  glanceFails = true;
  const out = await round();
  glanceFails = false;
  assert.match(out.log.join('\n'), /couldn't ask GitHub about everyone at once/);
  assert.match(out.results.find((x) => x.message.startsWith('rollout: '))?.message ?? '', /opened "Fake 0\.4\.3: the Steward's kit 1\.0\.3"; merged it$/);
  assert.deepEqual(released().at(-1), '0.4.3');
  // Merged and released: the rounds after have nothing more to roll out.
  await round();
  assert.deepEqual(created(), []);
});

test('the Steward carrying an older kit than the newest: the rollout waits, and says so', async () => {
  kits = ['1.0.4', ...kits];
  gh = [];
  const out = await runStage('round', { full: true }, { run, ownKit: '1.0.3' });
  assert.deepEqual(created(), []);
  assert.match(out.log.join('\n'), /rollout: kit 1\.0\.4 waits for this Steward to carry it \(it carries 1\.0\.3/);
  const watching = JSON.parse(readFileSync(path.join(home, 'alarms.json'), 'utf8')).watching;
  assert.ok('rollout:waits:1.0.4' in watching, 'watched: an alarm after a day');
});

test("the Steward carrying an older kit, with the new kit's tag in its clone: the rollout hands out that kit's tools/kit.ts at once", async () => {
  // The Steward's clone: the kit's release tag carries its kit\ and its tools/kit.ts.
  const steward = fakeEmployee(path.join(home, 'steward-clone'), { kit: null, files: { 'kit/VERSION': '1.0.5\n', 'tools/kit.ts': '// tools/kit.ts as released with kit 1.0.5\n' } });
  sh(steward.checkout, 'tag', 'kit-v1.0.5');
  sh(steward.checkout, 'push', '--quiet', 'origin', 'kit-v1.0.5');
  const file = path.join(home, 'settings.json');
  const before = readFileSync(file, 'utf8');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(before), stewardCheckout: steward.checkout }));
  try {
    kits = ['1.0.5', ...kits];
    gh = [];
    const out = await runStage('round', { full: true }, { run, ownKit: '1.0.4' });
    const log = out.log.join('\n');
    assert.doesNotMatch(log, /waits for this Steward to carry it/);
    assert.match(log, /rollout: this Steward carries kit 1\.0\.4, so each bump hands out the tools\/kit\.ts released with kit 1\.0\.5/);
    assert.equal(readFileSync(path.join(home, 'work', '_kit-tool-1.0.5.ts'), 'utf8'), '// tools/kit.ts as released with kit 1.0.5\n');
    assert.equal(created().length, 1, log);
    assert.match(out.results.find((x) => x.message.startsWith('rollout: '))?.message ?? '', /opened "Fake 0\.4\.4: the Steward's kit 1\.0\.5"; merged it$/, log);
    assert.deepEqual(released().at(-1), '0.4.4', 'merged and released in the same round');
  } finally {
    writeFileSync(file, before);
  }
});

test('a bump whose PR the network kept from opening is a wait, with no failure, hold or alarm; the next round opens the PR of the branch already on origin, and merges it', async () => {
  kits = ['1.0.6', ...kits];
  createFails = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com';
  const cut = await round();
  createFails = null;
  const waited = cut.results.find((x) => x.message.startsWith('rollout: '))!;
  assert.equal(waited.outcome, 'skipped', `${waited.message}\n${cut.log.join('\n')}`);
  assert.match(waited.message, /^rollout: steward\/kit-1\.0\.6 waits for the network \(error connecting to api\.github\.com.*\): the next round tries again$/);
  assert.equal(created().length, 1, 'tried to open it');
  assert.deepEqual(prs, [], 'and could not');
  assert.deepEqual(loadRolloutFailures(), {}, 'nothing is held against the bump');
  assert.deepEqual(openAlarms(), [], 'no alarm');
  assert.match(sh(f.origin, 'show', 'steward/kit-1.0.6:kit.json'), /"kit": "1\.0\.6"/, 'its branch got to origin');

  // The next round finds the branch on origin with no PR, and the Steward's own bump on it: the PR is opened as the push
  // would have, and merged, and nothing is bumped or pushed again.
  const next = await round();
  const opened = next.results.find((x) => x.message.startsWith('rollout: '))!;
  assert.equal(opened.outcome, 'done', `${opened.message}\n${next.log.join('\n')}`);
  assert.match(opened.message, /^rollout: kit 1\.0\.6: steward\/kit-1\.0\.6 \(.{7}\) was on origin with no PR: its PR is opened now; opened "Fake 0\.4\.5: the Steward's kit 1\.0\.6"; merged it$/);
  assert.equal(created().length, 1);
  assert.equal(sh(f.origin, 'show', 'main:kit.json'), '{\n  "kit": "1.0.6",\n  "parts": ["node"]\n}');
  assert.deepEqual(loadRolloutFailures(), {});
  assert.deepEqual(openAlarms(), []);
  assert.deepEqual(released().at(-1), '0.4.5', 'released in the same round');
});

test('a new kit settles: the newest goes once it has gone the quiet hours without a newer one, or the longest wait is up', () => {
  const H = 3600_000;
  const t0 = Date.parse('2026-10-13T08:00:00Z');
  const published = { '2.9.0': new Date(t0 - 48 * H).toISOString(), '2.9.1': new Date(t0).toISOString(), '2.9.2': new Date(t0 + H).toISOString() };
  const base = { newest: '2.9.2', released: ['2.9.2', '2.9.1', '2.9.0'], published, rolled: '2.9.0', urgent: [] as string[], quietHours: 2, maxWaitHours: 12 };
  // 2.9.2 came an hour after 2.9.1: it settles until two hours after its own release, and 2.9.0 still reaches those behind it.
  const quiet = settleKit({ ...base, now: t0 + 2 * H });
  assert.deepEqual([quiet.kit, quiet.settling?.kit, quiet.settling?.until], ['2.9.0', '2.9.2', t0 + 3 * H]);
  assert.match(settlingLine(quiet.settling!, quiet.kit), /^kit 2\.9\.2 settles until \d\d:\d\d \(kit 2\.9\.0 still reaches those behind it\)$/);
  assert.deepEqual(settleKit({ ...base, now: t0 + 3 * H }), { kit: '2.9.2', settling: null, urgent: null }, 'settled');
  // Kits every hour: never later than twelve hours after the oldest one waiting (2.9.1).
  const burst = { ...base, newest: '2.9.9', released: ['2.9.9', ...base.released], published: { ...published, '2.9.9': new Date(t0 + 11.5 * H).toISOString() } };
  assert.equal(settleKit({ ...burst, now: t0 + 11.9 * H }).kit, '2.9.0');
  assert.equal(settleKit({ ...burst, now: t0 + 12 * H }).kit, '2.9.9', 'the longest wait is up');
  // Nothing rolled out yet: nothing goes while it settles; counted from the oldest release, which may be long past.
  assert.equal(settleKit({ ...base, rolled: null, now: t0 + 2 * H }).kit, '2.9.2', "2.9.0's release was two days ago");
  const first = settleKit({ ...base, released: ['2.9.2', '2.9.1'], rolled: null, now: t0 + 2 * H });
  assert.deepEqual([first.kit, first.settling?.kit], [null, '2.9.2']);
  assert.match(settlingLine(first.settling!, null), /^kit 2\.9\.2 settles until \d\d:\d\d$/);
  // The newest is the one rolled out already: it goes on, as before.
  assert.deepEqual(settleKit({ ...base, rolled: '2.9.2', now: t0 + H }).kit, '2.9.2');
  // Quiet hours 0: each kit at once.
  assert.equal(settleKit({ ...base, quietHours: 0, now: t0 + H }).kit, '2.9.2');
});

test('an urgent kit goes at once, and one with no published time counts as old enough', () => {
  const t0 = Date.parse('2026-10-13T08:00:00Z');
  const base = { newest: '2.9.2', released: ['2.9.2', '2.9.1', '2.9.0'], rolled: '2.9.0', quietHours: 2, maxWaitHours: 12, now: t0 };
  const published = { '2.9.1': new Date(t0).toISOString(), '2.9.2': new Date(t0).toISOString() };
  assert.deepEqual(settleKit({ ...base, published, urgent: ['2.9.1'] }), { kit: '2.9.2', settling: null, urgent: '2.9.1' }, 'an urgent kit sends the newest');
  assert.equal(settleKit({ ...base, published, urgent: ['2.9.0'] }).kit, '2.9.0', 'one rolled out already is no reason');
  assert.equal(settleKit({ ...base, published: {}, urgent: [] }).kit, '2.9.2', 'no published times');
  assert.equal(settleKit({ ...base, published: { '2.9.2': new Date(t0).toISOString() }, urgent: [] }).kit, '2.9.2', "2.9.1's time unknown: the longest wait is up");
  // The changelog's mark: the entry's bold line.
  const changelog = '# Kit\n\n## 2.9.2\n\n**Urgent: the release check failed on every agent.**\n\n### What changed\n\n## 2.9.1\n\n**Lighter tests.**\n';
  assert.equal(urgentIn(changelog, '2.9.2'), true);
  assert.equal(urgentIn(changelog, '2.9.1'), false);
  assert.equal(urgentIn(changelog, '2.9.0'), false, 'no entry');
  assert.equal(urgentIn('**urgent fix for the page**\n\n### What changed', '2.9.3'), true, "a release's notes with no heading");
  assert.equal(urgentIn('**Not urgent.**', '2.9.3'), false);
  assert.equal(urgentIn(null, '2.9.3'), false);
  assert.deepEqual([normalizeSettings({}).settings.rolloutQuietHours, normalizeSettings({}).settings.rolloutMaxWaitHours], [2, 12]);
  assert.deepEqual([normalizeSettings({ rolloutQuietHours: 0, rolloutMaxWaitHours: '24' }).settings.rolloutQuietHours, normalizeSettings({ rolloutMaxWaitHours: '24' }).settings.rolloutMaxWaitHours], [0, 24]);
  assert.equal(normalizeSettings({ rolloutQuietHours: '' }).settings.rolloutQuietHours, 2, 'empty: the default');
});
