import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from '../kit/test/until.ts';
import type { RolloutRun } from '../src/stages/rollout.ts';

// Steward 0.36.60: a kit's rollout runs beside the rounds on the Steward's page (stages/rollout.ts: rolloutsBeside), never
// inside one. Inside the round, its bumps' checks held every round until it ended: rounds that rolled a kit out took 20
// to 56 minutes on 2026-10-12 to 15, against 15 to 20 for those that didn't. Since Steward 0.36.124 the rollout merges
// the kit PR it opens itself, at once (push.ts's `merge`, mainbuild.ts's mergeOwn), and no one's ready PR is merged by
// the Steward: whoever wrote one merges it, and a round releases main. Whole rounds here, on a data folder of their own,
// two fake employees' git and gh standing in: Fake's bump to the new kit waits on its checks, which wait for the test to
// let them go, while rounds for Other go on, leave its ready PR open, and release its main once its writer merged it.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-rollout-beside-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { rolloutDone, rolloutLock, rolloutsBeside } = await import('../src/stages/rollout.ts');
const { withLock } = await import('../src/kit/lock.ts');
const { fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');

const fake = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0', kit: '1.0.0' });
const other = fakeEmployee(path.join(home, 'other'), { version: '0.4.0', kit: '1.0.1' });
const repos: Record<string, { origin: string; checkout: string }> = { 'Jcollier0120/Fake': fake, 'Jcollier0120/Other': other };

// Fake's checks say they've started, then wait until the test lets them go (with a limit of their own, should it never).
const started = path.join(home, 'checks-started');
const letGo = path.join(home, 'checks-go');
const held = `node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],'');const end=Date.now()+300000;const s=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(process.argv[2])){if(Date.now()-end>0)process.exit(3);Atomics.wait(s,0,0,20)}" ${started} ${letGo}`;
// Each release command notes the version it releases, which gh's release list then shows.
const attempts = (id: string) => path.join(home, `released-${id}.txt`);
const releaseCmd = (id: string) => `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts(id)}`;
const versionFiles = ['package.json', 'package-lock.json', 'src/app.ts'];
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [
      { id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: fake.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: [held], versionFiles, release: releaseCmd('fake'), install: '', approve: '' },
      { id: 'other', name: 'Other', repo: 'Jcollier0120/Other', checkout: other.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles, release: releaseCmd('other'), install: '', approve: '' },
    ],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    afterRelease: [],
    stewardRepo: 'octocat/steward',
    alarms: { manorUrl: '', surveyorUrl: '', toast: false },
  }),
);

const kits = ['1.0.1', '1.0.0'];
const released = (id: string) => ['0.4.0', ...(existsSync(attempts(id)) ? readFileSync(attempts(id), 'utf8').split('\n').filter(Boolean) : [])];
/** The open PRs on each repository, as gh lists them. */
const prs: Record<string, any[]> = { 'Jcollier0120/Fake': [], 'Jcollier0120/Other': [] };
/** #7 is Other's, opened by hand below: those the Steward opens come after it. */
let prNumber = 7;
const created: string[] = [];
/** Each PR merged through gh (the Steward's own merges): "<repo>#<n>". */
const merged: string[] = [];
const repoOf = (args: string[]) => args[args.indexOf('--repo') + 1];
const pr = (repo: string, n: number, head: string, title: string) => ({
  number: n,
  title,
  url: `https://github.com/${repo}/pull/${n}`,
  body: '',
  headRefName: head,
  headRefOid: sh(repos[repo].origin, 'rev-parse', head),
  baseRefName: 'main',
  isCrossRepository: false,
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  author: { login: 'Jcollier0120' },
  labels: [],
  files: [],
  statusCheckRollup: [],
});
// GitHub's GraphQL isn't answered: each round asks of every employee on its own (no glance), so each looks at both.
const run = async (cmd: string, args: string[], opts?: any) => {
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  if (args[0] === 'release' && args[1] === 'list') {
    if (repoOf(args) === 'octocat/steward') return ok(kits.map((k) => ({ tagName: `kit-v${k}`, isDraft: false })));
    return ok(released(repoOf(args) === 'Jcollier0120/Fake' ? 'fake' : 'other').map((v) => ({ tagName: `v${v}`, isDraft: false })));
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    const open = prs[repoOf(args)] ?? [];
    return ok(args.includes('--head') ? open.filter((p) => p.headRefName === args[args.indexOf('--head') + 1]) : open);
  }
  if (args[0] === 'pr' && args[1] === 'create') {
    const repo = repoOf(args);
    const n = ++prNumber;
    prs[repo].push(pr(repo, n, args[args.indexOf('--head') + 1], args[args.indexOf('--title') + 1]));
    created.push(`${repo}#${n}`);
    return ok(`https://github.com/${repo}/pull/${n}\n`);
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const repo = repoOf(args);
    const p = prs[repo].find((x) => String(x.number) === args[2]);
    if (!p) return { code: 1, out: '', err: `no open PR #${args[2]}` };
    const head = args.includes('--match-head-commit') ? args[args.indexOf('--match-head-commit') + 1] : null;
    if (head && head !== p.headRefOid) return { code: 1, out: '', err: 'Head branch was modified. Review and try the merge again.' };
    mergeOnGitHub(repo, p);
    merged.push(`${repo}#${p.number}`);
    return ok('');
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};
/** A PR merged on GitHub: its head becomes main, and it is no longer open. */
function mergeOnGitHub(repo: string, p: { headRefOid: string }): void {
  sh(repos[repo].origin, 'update-ref', 'refs/heads/main', p.headRefOid);
  prs[repo] = prs[repo].filter((x) => x !== p);
}
const round = (employees?: string[]) => runStage('round', employees ? { employees } : {}, { run, ownKit: '9.9.9' });
const done = (out: { results: { outcome: string; message: string }[] }) => out.results.filter((r) => r.outcome !== 'skipped').map((r) => r.message.replace(/\b[0-9a-f]{7}\b/g, '…'));

/** Other's ready PR #7: a fix that raises its version to 0.4.1, on a branch of its own. */
function openOthersPr(): void {
  const c = other.checkout;
  sh(c, 'switch', '--quiet', '-c', 'fix/thing');
  for (const file of versionFiles) writeFileSync(path.join(c, file), readFileSync(path.join(c, file), 'utf8').replaceAll('0.4.0', '0.4.1'));
  sh(c, 'commit', '--quiet', '-am', 'Other 0.4.1: a fix');
  sh(c, 'push', '--quiet', 'origin', 'fix/thing', 'HEAD:refs/pull/7/head');
  sh(c, 'switch', '--quiet', 'main');
  prs['Jcollier0120/Other'].push(pr('Jcollier0120/Other', 7, 'fix/thing', 'Other 0.4.1: a fix'));
}

test("rounds go on while a kit's rollout runs beside them, and merge no one's ready PR; the rollout merges its own kit PR at once, and the round after it ends releases it", async (t) => {
  const ended: RolloutRun[] = [];
  const lines: string[] = [];
  rolloutsBeside({ ended: (r) => ended.push(r), log: (l) => lines.push(l) });
  t.after(async () => {
    // Whatever happened, its checks are let go and the rollout ends before the next test (or the folder's removal).
    writeFileSync(letGo, '');
    await rolloutDone();
    rolloutsBeside(null);
  });

  // Kit 1.0.1 is out; Fake pins 1.0.0, Other 1.0.1 already. The round starts Fake's bump beside it and ends.
  const first = await round();
  assert.equal(first.error, undefined, first.log.join('\n'));
  assert.match(first.log.join('\n'), /rollout: kit 1\.0\.1 for Fake, beside the rounds: the rounds go on/);
  assert.deepEqual(done(first), [], "nothing of the rollout's yet: it goes on beside");
  await until(() => existsSync(started), 60_000, "Fake's bump to start its checks");

  // Other's PR is ready now. While Fake's checks still run, a round for Other goes on: it leaves the ready PR to whoever
  // wrote it, and the rollout to itself.
  openOthersPr();
  const second = await round(['other']);
  assert.equal(second.error, undefined, second.log.join('\n'));
  assert.deepEqual(done(second), [], 'nothing merged, nothing new on main to release');
  assert.match(second.log.join('\n'), /rollout: kit 1\.0\.1's rollout to Fake goes on beside the rounds \(started .* ago\)/);
  assert.deepEqual(prs['Jcollier0120/Other'].map((p) => p.number), [7], 'the ready PR left open');
  assert.deepEqual(released('other'), ['0.4.0']);

  // Its writer merges it: the next round releases Other's main, Fake's checks still running beside it.
  mergeOnGitHub('Jcollier0120/Other', prs['Jcollier0120/Other'][0]);
  const third = await round(['other']);
  assert.equal(third.error, undefined, third.log.join('\n'));
  assert.deepEqual(done(third), ['release: released v0.4.1 from origin/main (…), with kit 1.0.1']);
  assert.deepEqual(released('other'), ['0.4.0', '0.4.1']);
  assert.deepEqual([ended.length, created.length, merged.length], [0, 0, 0], 'the rollout is still running, its PR not yet opened; nothing merged by the Steward');

  // Its checks pass: the rollout pushes Fake's kit PR, merges it itself at once, and ends. The round after it reports
  // that and releases Fake's main.
  writeFileSync(letGo, '');
  await until(() => ended.length === 1, 60_000, 'the rollout to end');
  await rolloutDone();
  assert.deepEqual(created, ['Jcollier0120/Fake#8']);
  assert.deepEqual(merged, ['Jcollier0120/Fake#8'], 'merged by the rollout, before any round');
  assert.deepEqual(prs['Jcollier0120/Fake'], []);
  assert.match(ended[0].results.map((r) => r.message).join('\n'), /^rollout: kit 1\.0\.1: 0\.4\.1 on steward\/kit-1\.0\.1 \(.{7}\): kit 1\.0\.0 → 1\.0\.1, checks passed; opened "Fake 0\.4\.1: the Steward's kit 1\.0\.1"; merged it$/);
  assert.match(lines.join('\n'), /rollout: kit 1\.0\.1's rollout ended beside the rounds after .*: 1 PR opened or updated/);
  assert.match(sh(fake.origin, 'show', 'main:kit.json'), /"kit": "1\.0\.1"/, "Fake's main on the kit now");
  const fourth = await round();
  assert.equal(fourth.error, undefined, fourth.log.join('\n'));
  const did = done(fourth);
  assert.ok(did.some((m) => /^rollout: kit 1\.0\.1: 0\.4\.1 on steward\/kit-1\.0\.1 .*; merged it$/.test(m)), `the rollout reported by this round: ${did.join('\n')}`);
  assert.ok(did.includes('release: released v0.4.1 from origin/main (…), with kit 1.0.1'), did.join('\n'));
  assert.ok(!did.some((m) => /^merged #/.test(m)), `the round merges nothing itself: ${did.join('\n')}`);
  assert.deepEqual(released('fake'), ['0.4.0', '0.4.1']);
  assert.deepEqual(merged, ['Jcollier0120/Fake#8']);

  // On the kit now: the next round starts no rollout, and reports nothing again.
  const fifth = await round();
  assert.doesNotMatch(fifth.log.join('\n'), /rollout: kit/);
  assert.deepEqual(done(fifth), []);
});

test('a rollout another process runs (a round in a terminal) holds the kit: a round leaves it to it, and bumps nothing', async () => {
  kits.unshift('1.0.2');
  const before = created.length;
  await withLock(rolloutLock(), async () => {
    const out = await round();
    assert.equal(out.error, undefined, out.log.join('\n'));
    assert.match(out.log.join('\n'), /rollout: another rollout is bumping and pushing on this PC \(a round in a terminal, say\): the kit is left to it/);
  });
  assert.equal(created.length, before, 'no kit PR opened');
  // Once it's let go, the next round rolls kit 1.0.2 out, inside the round as before (nothing set beside, as in a terminal).
  const out = await round();
  assert.equal(out.error, undefined, out.log.join('\n'));
  assert.ok(done(out).some((m) => /^rollout: kit 1\.0\.2: /.test(m)), out.log.join('\n'));
  assert.ok(created.length > before, 'its kit PRs opened');
});
