import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The rollout in a round (stages/rollout.ts): which employees a new kit release reaches, as pure decisions; then whole
// rounds on a data folder of their own, a fake employee's git, and gh standing in. Nothing reaches GitHub, the live
// ~/.steward or the real checkouts.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-rollout-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { planRollout, rolloutGate, loadRolloutFailures } = await import('../src/stages/rollout.ts');
const { planRound } = await import('../src/stages/changes.ts');
const { roundSig } = await import('../src/glance.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS, normalizeSettings } = await import('../src/settings.ts');
const { employee, fakeEmployee, ok, sh } = await import('./helpers.ts');
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
    ['miller', 'its kit PR #12 (steward/kit-2.9.0) is open: the rounds merge it once it is ready'],
    ['manor', 'not using the kit yet'],
  ]);
  // A pin ahead of the newest release (a trial) is left alone, and so is one with no checkout, no kit.json or no branch.
  const odd = planRollout({ on: true, kit: '2.9.1', ownKit: null, employees: [porter, clerk, miller], facts: { porter: facts('3.0.0'), clerk: { checkout: false, head: null, pin: null, kitPrs: [] }, miller: facts(null) }, failed: {} });
  assert.deepEqual(odd.bump, []);
  assert.deepEqual(odd.skip.map((s) => s.why), ['on kit 3.0.0 already', 'no checkout at C:\\nowhere\\Clerk', 'no kit.json on origin/main']);
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

test('a new kit release, or this Steward carrying a new kit, is something new for every employee: the round looks at all', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const repo = { head: H1, prs: [], releases: [] };
  const glance = { at: '', stewardReleases: [], repos: { porter: repo }, errors: {} };
  const now = new Date('2026-10-04T12:00:00Z');
  const before = { newest: '2.9.0', own: '2.9.0' };
  const seen = { full: now.toISOString(), ok: true, repos: { porter: { sig: roundSig(porter, repo, settings, before), held: [] } } };
  assert.deepEqual(planRound({ employees: [porter], glance, seen, settings, now, kit: before }).look, [], 'nothing new');
  assert.deepEqual(planRound({ employees: [porter], glance, seen, settings, now, kit: { newest: '2.9.1', own: '2.9.0' } }).look.map((e) => e.id), ['porter'], 'a new kit release');
  assert.deepEqual(planRound({ employees: [porter], glance, seen, settings, now, kit: { newest: '2.9.0', own: '2.9.1' } }).look.map((e) => e.id), ['porter'], 'the Steward updated');
  const off = { ...settings, rollout: false };
  const seenOff = { ...seen, repos: { porter: { sig: roundSig(porter, repo, off, before), held: [] } } };
  assert.deepEqual(planRound({ employees: [porter], glance, seen: seenOff, settings: off, now, kit: { newest: '2.9.1', own: '2.9.1' } }).look, [], 'rolling out off: a kit release is nothing new');
});

test('a bump or push the rounds gave up on is an alarm at once; a kit waiting on the Steward itself, after a day', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const failedRollouts = { porter: { kit: '2.9.1', head: H1, stage: 'bump' as const, message: 'npm test failed (exit 1)' }, gone: { kit: '2.9.1', head: H1, stage: 'bump' as const, message: 'x' } };
  const c = roundConditions({ round, held: [], failedReleases: {}, failedRollouts, rolloutWaits: { kit: '2.9.1', own: '2.9.0' }, employees: [porter], settings });
  assert.deepEqual(c.map((x) => [x.id, x.afterMs]), [['rollout:porter:2.9.1', 0], ['rollout:waits:2.9.1', 24 * 3_600_000]]);
  assert.match(c[0].title, /^Porter's bump to kit 2\.9\.1 failed, and the rounds won't try it again until its branch moves$/);
  assert.equal(c[0].detail[0], 'npm test failed (exit 1)');
  assert.deepEqual(roundConditions({ round, held: [], failedReleases: {}, failedRollouts, rolloutWaits: { kit: '2.9.1', own: '2.9.0' }, employees: [porter], settings: { ...settings, rollout: false } }), [], 'off: no alarm');
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
    alarms: { manorUrl: '', surveyorUrl: '', toast: false },
  }),
);

let kits = ['1.0.0'];
let glanceFails = false;
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
    if (args.includes('Jcollier0120/Steward')) return ok(kits.map((k) => ({ tagName: `kit-v${k}`, isDraft: false })));
    return ok(released().map((v) => ({ tagName: `v${v}`, isDraft: false })));
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    const head = args[args.indexOf('--head') + 1];
    const open = prs.filter((p) => !args.includes('--head') || p.headRefName === head);
    return ok(open.map((p) => ({ ...p, author: { login: p.author.login }, labels: [], files: [], statusCheckRollup: [] })));
  }
  if (args[0] === 'pr' && args[1] === 'create') {
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

test('a round rolls a new kit out by itself: bumped and its PR pushed; the next round merges and releases it', async () => {
  const first = await round();
  assert.equal(first.error, undefined);
  assert.deepEqual(created(), [], 'on the newest kit already');

  kits = ['1.0.1', '1.0.0'];
  const out = await round();
  assert.equal(out.error, undefined, out.log.join('\n'));
  const r = out.results.find((x) => x.message.startsWith('rollout: '))!;
  assert.equal(r.outcome, 'done', `${r.message}\n${out.log.join('\n')}`);
  assert.match(r.message, /^rollout: kit 1\.0\.1: 0\.4\.1 on steward\/kit-1\.0\.1 \(.{7}\): kit 1\.0\.0 → 1\.0\.1, checks passed; opened "Fake 0\.4\.1: the Steward's kit 1\.0\.1"$/);
  assert.equal(created().length, 1);
  assert.equal(sh(f.origin, 'show', 'steward/kit-1.0.1:kit.json'), '{\n  "kit": "1.0.1",\n  "parts": ["node"]\n}');

  // Its PR is open: the next round merges it (a PR of the Steward's, tested by its bump), and releases the version.
  const next = await round();
  assert.deepEqual(next.results.filter((x) => x.outcome !== 'skipped').map((x) => x.message.replace(/\(.{7}\)/, '(…)')), ['merged #7', 'release: released v0.4.1 from origin/main (…), with kit 1.0.1']);
  assert.deepEqual(created(), [], 'not bumped again: its branch pins 1.0.1 now');
});

test("a bump whose checks fail is an alarm, and isn't tried again for that kit until a new commit; Bump lets it go", async () => {
  writeFileSync(failFlag, '');
  kits = ['1.0.2', '1.0.1', '1.0.0'];
  const failed = await round();
  const r = failed.results.find((x) => x.message.startsWith('rollout: '))!;
  assert.equal(r.outcome, 'failed');
  assert.match(r.message, /^rollout: bump to kit 1\.0\.2: node -e .* failed \(exit 1\); the worktree is left at /);
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
  assert.match(pushed.results.find((x) => x.message.startsWith('rollout: '))!.message, /opened "Fake 0\.4\.2: the Steward's kit 1\.0\.2"$/);
  assert.deepEqual(openAlarms(), [], 'the alarm cleared');
  await round(); // merged and released
});

test("a glance that misses doesn't stall a rollout: the round asks on its own and rolls the kit out", async () => {
  kits = ['1.0.3', '1.0.2', '1.0.1', '1.0.0'];
  glanceFails = true;
  const out = await round();
  glanceFails = false;
  assert.match(out.log.join('\n'), /couldn't ask GitHub about everyone at once/);
  assert.match(out.results.find((x) => x.message.startsWith('rollout: '))?.message ?? '', /opened "Fake 0\.4\.3: the Steward's kit 1\.0\.3"$/);
  // With the PR open, the rounds after leave it to merge: no second bump.
  const next = await round();
  assert.deepEqual(created(), []);
  assert.ok(next.results.some((x) => x.message === 'merged #9'), JSON.stringify(next.results));
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
