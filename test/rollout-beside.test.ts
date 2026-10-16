import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from '../kit/test/until.ts';
import type { RolloutRun } from '../src/stages/rollout.ts';

// Steward 0.36.60: a kit's rollout runs beside the rounds on the Steward's page (stages/rollout.ts: rolloutsBeside), never
// inside one. Inside the round, its bumps' checks held every merge until it ended: rounds that rolled a kit out took 20
// to 56 minutes on 2026-10-12 to 15, against 15 to 20 for those that didn't. Whole rounds here, on a data folder of their
// own, two fake employees' git and gh standing in: Fake's bump to the new kit waits on its checks, which wait for the test
// to let them go, while the next round merges and releases Other's ready PR.
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
    const p = prs[repo].find((x) => String(x.number) === args[2])!;
    sh(repos[repo].origin, 'update-ref', 'refs/heads/main', p.headRefOid);
    prs[repo] = prs[repo].filter((x) => x !== p);
    return ok('');
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};
const round = () => runStage('round', {}, { run, ownKit: '9.9.9' });
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

test("a ready PR merges while a kit's rollout runs beside the rounds; the rollout's own PR merges in the round after it ends", async (t) => {
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
  assert.match(first.log.join('\n'), /rollout: kit 1\.0\.1 for Fake, beside the rounds: the rounds go on merging meanwhile/);
  assert.deepEqual(done(first), [], "nothing of the rollout's yet: it goes on beside");
  await until(() => existsSync(started), 60_000, "Fake's bump to start its checks");

  // Other's PR is ready now. While Fake's checks still run, the next round merges and releases it, and leaves Fake alone.
  openOthersPr();
  const second = await round();
  assert.equal(second.error, undefined, second.log.join('\n'));
  assert.deepEqual(done(second), ['merged #7 (checks passed here at …)', 'release: released v0.4.1 from origin/main (…), with kit 1.0.1']);
  assert.deepEqual(released('other'), ['0.4.0', '0.4.1']);
  const log = second.log.join('\n');
  assert.match(log, /Fake: the kit's rollout beside the rounds is bumping it now, so it is looked at next round/);
  assert.match(log, /rollout: kit 1\.0\.1's rollout to Fake goes on beside the rounds \(started .* ago\): the rounds go on merging meanwhile/);
  assert.deepEqual([ended.length, created.length], [0, 0], 'the rollout is still running, its PR not yet opened');

  // Its checks pass: the rollout pushes Fake's kit PR and ends. The round after it reports that, merges the PR and releases.
  writeFileSync(letGo, '');
  await until(() => ended.length === 1, 60_000, 'the rollout to end');
  await rolloutDone();
  assert.deepEqual(created, ['Jcollier0120/Fake#8']);
  assert.match(ended[0].results.map((r) => r.message).join('\n'), /^rollout: kit 1\.0\.1: 0\.4\.1 on steward\/kit-1\.0\.1 \(.{7}\): kit 1\.0\.0 → 1\.0\.1, checks passed; opened "Fake 0\.4\.1: the Steward's kit 1\.0\.1"$/);
  assert.match(lines.join('\n'), /rollout: kit 1\.0\.1's rollout ended beside the rounds after .*: 1 PR opened or updated/);
  const third = await round();
  assert.equal(third.error, undefined, third.log.join('\n'));
  const did = done(third);
  assert.ok(did.includes('merged #8'), did.join('\n'));
  assert.ok(did.some((m) => /^rollout: kit 1\.0\.1: 0\.4\.1 on steward\/kit-1\.0\.1/.test(m)), `the rollout reported by this round: ${did.join('\n')}`);
  assert.ok(did.includes('release: released v0.4.1 from origin/main (…), with kit 1.0.1'), did.join('\n'));
  assert.deepEqual(released('fake'), ['0.4.0', '0.4.1']);

  // On the kit now: the next round starts no rollout, and reports nothing again.
  const fourth = await round();
  assert.doesNotMatch(fourth.log.join('\n'), /rollout: kit/);
  assert.deepEqual(done(fourth), []);
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
