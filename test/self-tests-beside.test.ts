import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from '../kit/test/until.ts';

// Steward 0.36.71: in a build, the Steward's own PRs are tested beside the rounds (stages/selftests.ts), which go on
// without them: a round ends, and the next merges an agent's PR, while a Steward PR's tests still run; once they end, a
// round merges it without testing it again. Whole rounds here, on a data folder of their own, git and gh standing in, and
// npm for the Steward's checks: its `npm test` waits until the test lets it go.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-self-tests-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { APP } = await import('../src/app.ts');
const { heldBy } = await import('../src/stages/slots.ts');
const { loadPipeline } = await import('../src/pipeline.ts');
const { SELF_TESTS, selfTestsBeside, selfTestsDone } = await import('../src/stages/selftests.ts');
const { TESTED_BESIDE, waitsBriefly } = await import('../src/stages/merge.ts');
const { kitComing } = await import('../src/stages/buildkit.ts');
const { fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');

const steward = fakeEmployee(path.join(home, 'steward'), { version: '0.8.13', kit: null, files: { 'kit/VERSION': '1.0.1\n' } });
const other = fakeEmployee(path.join(home, 'other'), { version: '0.4.0', kit: '1.0.1' });
const STEWARD = 'Jcollier0120/Steward';
const OTHER = 'Jcollier0120/Other';
const repos: Record<string, { origin: string; checkout: string }> = { [STEWARD]: steward, [OTHER]: other };
const versionFiles = ['package.json', 'package-lock.json', 'src/app.ts'];
// The Steward's clone names GitHub's URL, which its bare origin stands for (git's insteadOf): it releases only from there.
sh(steward.checkout, 'config', `url.${steward.origin.replace(/\\/g, '/')}.insteadOf`, `https://github.com/${STEWARD}.git`);
sh(steward.checkout, 'remote', 'set-url', 'origin', `https://github.com/${STEWARD}.git`);

const attempts = path.join(home, 'released-other.txt');
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'other', name: 'Other', repo: OTHER, checkout: other.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles, release: releaseCmd, install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    afterRelease: [],
    stewardRepo: STEWARD,
    releaseSelf: false,
    alarms: { manorUrl: '', surveyorUrl: '', toast: false },
  }),
);

const released = () => ['0.4.0', ...(existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : [])];
/** The open PRs on each repository, as gh lists them. */
const prs: Record<string, any[]> = { [STEWARD]: [], [OTHER]: [] };
/** What happened, in order: the Steward's tests beginning and ending, and each merge. */
const events: string[] = [];
/** The Steward's `npm test` waits on this; the test lets it go. */
let letGo = () => {};
const gate = new Promise<void>((r) => (letGo = r));

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

/** A ready PR on `repo` #n raising its version `from` → `to` on a branch of its own. */
function openPr(repo: string, n: number, branch: string, from: string, to: string): void {
  const c = repos[repo].checkout;
  sh(c, 'fetch', '--quiet', 'origin');
  sh(c, 'switch', '--quiet', '-c', branch, 'origin/main');
  for (const file of versionFiles) writeFileSync(path.join(c, file), readFileSync(path.join(c, file), 'utf8').replaceAll(from, to));
  sh(c, 'commit', '--quiet', '-am', `${to}: a change`);
  sh(c, 'push', '--quiet', 'origin', branch, `HEAD:refs/pull/${n}/head`);
  sh(c, 'switch', '--quiet', '--detach', 'origin/main');
  prs[repo].push(pr(repo, n, branch, `${repo.split('/')[1]} ${to}: a change`));
}

// GitHub's GraphQL isn't answered: each round asks of every repository on its own (no glance).
const run = async (cmd: string, args: string[], opts?: any) => {
  if (cmd === 'npm') {
    // The Steward's checks stand in: its packages "installed", its kit filled, its checks passing once let go.
    mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
    if (args[0] === 'test') {
      events.push('Steward tests begin');
      await gate;
      events.push('Steward tests end');
    }
    return ok('');
  }
  if (cmd === 'node' && (args[0] === 'tools/kit-release.ts' || args[0] === 'tools/kit.ts')) return ok('');
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  if (args[0] === 'release' && args[1] === 'list') {
    if (repoOf(args) === STEWARD) return ok(['kit-v1.0.1', 'v0.8.13'].map((tagName) => ({ tagName, isDraft: false, publishedAt: '2026-10-16T00:00:00Z' })));
    return ok(released().map((v) => ({ tagName: `v${v}`, isDraft: false })));
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    const open = prs[repoOf(args)] ?? [];
    return ok(args.includes('--head') ? open.filter((p) => p.headRefName === args[args.indexOf('--head') + 1]) : open);
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const repo = repoOf(args);
    const p = prs[repo].find((x) => String(x.number) === args[2])!;
    sh(repos[repo].origin, 'update-ref', 'refs/heads/main', p.headRefOid);
    prs[repo] = prs[repo].filter((x) => x !== p);
    events.push(`${repo.split('/')[1]} #${p.number} merged`);
    return ok('');
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};
const round = (ask: { buildNow?: object } = {}) => runStage('round', ask, { run, ownKit: '9.9.9', self: { checkout: steward.checkout }, pipeline: true });
const done = (out: { results: { outcome: string; message: string }[] }) => out.results.filter((r) => r.outcome !== 'skipped').map((r) => r.message.replace(/\b[0-9a-f]{7}\b/g, '…'));

test('a Steward PR tested beside the rounds waits briefly, and a kit PR among them is a kit coming in this build', () => {
  const why = `${TESTED_BESIDE} for the 12:00 build: a round merges it once its tests end`;
  assert.equal(waitsBriefly(why), true);
  assert.match(kitComing({ selfHeld: [{ number: 3, url: '', title: '', why, draft: false, kit: true }], selfReleases: [] }) ?? '', /the Steward's #3, whose newer kit merges in this build/);
});

test("in a build, a round ends and the next merges an agent's PR while a Steward PR's tests still run beside them; then a round merges it, not testing it again", async (t) => {
  let ended = 0;
  selfTestsBeside({ log: () => {}, ended: () => ended++ });
  t.after(() => {
    letGo();
    selfTestsBeside(null);
  });
  openPr(STEWARD, 47, 'claude/a-fix', '0.8.13', '0.8.14');
  openPr(OTHER, 7, 'fix/thing', '0.4.0', '0.4.1');

  // The build's first round: the Steward's #47 tested beside it, and Other's #7 merged; it ends without waiting.
  const first = await round({ buildNow: {} });
  assert.equal(first.error, undefined, first.log.join('\n'));
  assert.match(first.log.join('\n'), /#47 tested beside the rounds of the owner's Build now, which go on without waiting/);
  assert.ok(events.includes('Other #7 merged'), events.join(', '));
  assert.ok(!events.includes('Steward tests end'), events.join(', '));
  assert.notEqual(first.build?.closed, true, 'the build stays open for the Steward PR being tested');
  await until(() => events.includes('Steward tests begin') && heldBy(APP.id) === SELF_TESTS, 120_000, "the Steward's tests beside the rounds");

  // The next round merges Other's #8, opened since, while #47's tests still run: it leaves the Steward's repository alone.
  openPr(OTHER, 8, 'fix/another', '0.4.1', '0.4.2');
  const second = await round();
  assert.equal(second.error, undefined, second.log.join('\n'));
  assert.deepEqual(new Set(events), new Set(['Steward tests begin', 'Other #7 merged', 'Other #8 merged']), events.join(', '));
  assert.equal(events.at(-1), 'Other #8 merged');
  assert.match(second.log.join('\n'), /its PRs' tests go on beside the rounds/);
  assert.notEqual(second.build?.closed, true);
  assert.equal(ended, 0);

  // Its tests end: a round is asked for (agent.ts starts it), and it merges #47 at the head that passed, not testing it again.
  letGo();
  await until(() => ended === 1, 120_000, 'the Steward tests beside the rounds to end');
  await selfTestsDone();
  assert.equal(heldBy(APP.id), null);
  const third = await round();
  assert.equal(third.error, undefined, third.log.join('\n'));
  assert.deepEqual(events.slice(-2), ['Steward tests end', 'Steward #47 merged']);
  assert.equal(events.filter((e) => e === 'Steward tests begin').length, 1, "#47's tests ran once");
  assert.ok(done(third).includes('merged #47 (checks passed here at …)'), done(third).join('\n'));
  // Nothing left to wait for: the build closed, and released what it merged.
  assert.equal(third.build?.closed, true, third.log.join('\n'));
  assert.deepEqual(new Set(loadPipeline().builds.at(-1)?.merged), new Set(['other #7', 'other #8', `${APP.id} #47`]));
  assert.deepEqual(released(), ['0.4.0', '0.4.2']);
});
