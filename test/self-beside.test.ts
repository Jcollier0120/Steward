import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from '../kit/test/until.ts';

// Steward 0.36.69: in a build, the employees' merges go beside the Steward's own (steward.ts's runStage), whose PR tests
// every round ran first before: on 2026-10-16 the 08:00 build's 34 kit PRs, open at 13:44, merged at 14:44, once a round
// had tested the Steward's #291 twice. Whole rounds here, on a data folder of their own, git and gh standing in, and npm
// for the Steward's checks: its `npm test` waits until the test lets it go, while Other's ready PR merges.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-self-beside-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { APP } = await import('../src/app.ts');
const { heldBy } = await import('../src/stages/slots.ts');
const { loadPipeline } = await import('../src/pipeline.ts');
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

// Each release command notes the version it releases, which gh's release list then shows.
const attempts = path.join(home, 'released-other.txt');
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
const settings = (o: { releaseSelf: boolean; fill?: string }) =>
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [{ id: 'other', name: 'Other', repo: OTHER, checkout: other.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: o.fill ?? '', test: ['node -e process.exit(0)'], versionFiles, release: releaseCmd, install: '', approve: '' }],
      team: ['Jcollier0120'],
      workRoot: path.join(home, 'work'),
      afterRelease: [],
      stewardRepo: STEWARD,
      releaseSelf: o.releaseSelf,
      alarms: { manorUrl: '', surveyorUrl: '', toast: false },
    }),
  );

/** The kits released, newest first, and the Steward's own versions. */
const kits = ['1.0.1'];
const stewardReleases = ['0.8.13'];
const released = () => ['0.4.0', ...(existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : [])];
/** The open PRs on each repository, as gh lists them. */
const prs: Record<string, any[]> = { [STEWARD]: [], [OTHER]: [] };
/** What happened, in order: the Steward's tests beginning and ending, and each merge. */
const events: string[] = [];
/** The Steward's `npm test` waits on this while it is set; the test lets it go. */
let gate: Promise<void> | null = null;
let letGo = () => {};
/** Other's merge goes through only once the Steward's tests run: so it is shown to merge while they do. */
let otherWaitsForTests = false;
/** The times Other's PRs were listed while a stage held its repository: its looks. */
let otherLooks = 0;

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

/** A ready PR on `repo` #n raising its version `from` → `to` on a branch of its own, with `more` files written too. */
function openPr(repo: string, n: number, branch: string, from: string, to: string, more: Record<string, string> = {}): void {
  const c = repos[repo].checkout;
  sh(c, 'fetch', '--quiet', 'origin');
  sh(c, 'switch', '--quiet', '-c', branch, 'origin/main');
  for (const file of versionFiles) writeFileSync(path.join(c, file), readFileSync(path.join(c, file), 'utf8').replaceAll(from, to));
  for (const [file, text] of Object.entries(more)) writeFileSync(path.join(c, file), text);
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
    if (args[0] === 'test' && gate) {
      events.push('Steward tests begin');
      await gate;
      events.push('Steward tests end');
    }
    return ok('');
  }
  // The Steward's own releases (stages/self.ts): its kit's, which gh's release list then shows, and its own.
  if (cmd === 'node' && args[0] === 'tools/kit-release.ts') {
    kits.unshift(readFileSync(path.join(opts!.cwd!, 'kit', 'VERSION'), 'utf8').trim());
    events.push(`kit ${kits[0]} released`);
    return ok('');
  }
  if (cmd === 'node' && args[0] === 'tools/kit.ts') return ok('');
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  if (args[0] === 'release' && args[1] === 'list') {
    if (repoOf(args) === STEWARD) return ok([...kits.map((k) => `kit-v${k}`), ...stewardReleases.map((v) => `v${v}`)].map((tagName) => ({ tagName, isDraft: false, publishedAt: '2026-10-16T00:00:00Z' })));
    return ok(released().map((v) => ({ tagName: `v${v}`, isDraft: false })));
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    if (repoOf(args) === OTHER && heldBy('other')) otherLooks++;
    const open = prs[repoOf(args)] ?? [];
    return ok(args.includes('--head') ? open.filter((p) => p.headRefName === args[args.indexOf('--head') + 1]) : open);
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const repo = repoOf(args);
    if (repo === OTHER && otherWaitsForTests) await until(() => events.includes('Steward tests begin'), 120_000, "the Steward's tests to begin");
    const p = prs[repo].find((x) => String(x.number) === args[2])!;
    sh(repos[repo].origin, 'update-ref', 'refs/heads/main', p.headRefOid);
    prs[repo] = prs[repo].filter((x) => x !== p);
    events.push(`${repo.split('/')[1]} #${p.number} merged`);
    return ok('');
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};
const buildNow = () => runStage('round', { buildNow: {} }, { run, ownKit: '9.9.9', self: { checkout: steward.checkout }, pipeline: true });
const done = (out: { results: { outcome: string; message: string }[] }) => out.results.filter((r) => r.outcome !== 'skipped').map((r) => r.message.replace(/\b[0-9a-f]{7}\b/g, '…'));

test("in a build, an agent's ready PR merges while the Steward's own PR is still being tested", async (t) => {
  settings({ releaseSelf: false });
  t.after(() => letGo());
  openPr(STEWARD, 47, 'claude/a-fix', '0.8.13', '0.8.14');
  openPr(OTHER, 7, 'fix/thing', '0.4.0', '0.4.1');
  gate = new Promise((r) => (letGo = r));
  otherWaitsForTests = true;

  const going = buildNow();
  // Other's #7 merges while the Steward's #47's tests still run: they wait for the test to let them go.
  await until(() => events.includes('Other #7 merged'), 120_000, "Other's #7 to merge");
  assert.deepEqual(events, ['Steward tests begin', 'Other #7 merged'], "Other's merge didn't wait for the Steward's tests");
  assert.equal(heldBy(APP.id), 'self merge', "the Steward's own merges run apart, holding its repository alone");

  letGo();
  const out = await going;
  assert.equal(out.error, undefined, out.log.join('\n'));
  assert.deepEqual(events, ['Steward tests begin', 'Other #7 merged', 'Steward tests end', 'Steward #47 merged']);
  assert.equal(heldBy(APP.id), null);
  // The build waited for both before closing: it released what it merged, the Steward's #47 among its merges.
  assert.deepEqual(done(out), ['merged #7 (checks passed here at …)', 'merged #47 (checks passed here at …)', 'release: released v0.4.1 from origin/main (…), with kit 1.0.1']);
  assert.equal(out.build?.closed, true, out.log.join('\n'));
  assert.deepEqual(new Set(loadPipeline().builds.at(-1)?.merged), new Set(['other #7', `${APP.id} #47`]));
  assert.deepEqual(released(), ['0.4.0', '0.4.1']);
});

test("in a build, a kit released beside the agents' merges: an agent's PR that waited for it is looked at again, and merges in the same round", async (t) => {
  settings({ releaseSelf: true, fill: 'node tools/kit.ts' });
  t.after(() => letGo());
  events.length = 0;
  otherWaitsForTests = false;
  // Main carries kit 1.0.2, not released yet. The Steward's #49 is tested here; Other's #8 takes kit 1.0.2.
  const c = steward.checkout;
  sh(c, 'fetch', '--quiet', 'origin');
  sh(c, 'switch', '--quiet', '--detach', 'origin/main');
  writeFileSync(path.join(c, 'kit', 'VERSION'), '1.0.2\n');
  sh(c, 'commit', '--quiet', '-am', 'Kit 1.0.2');
  sh(c, 'push', '--quiet', 'origin', 'HEAD:main');
  openPr(STEWARD, 49, 'claude/another', '0.8.14', '0.8.15');
  openPr(OTHER, 8, 'claude/kit-1.0.2', '0.4.1', '0.4.2', { 'kit.json': '{\n  "kit": "1.0.2",\n  "parts": ["node"]\n}\n' });
  gate = new Promise((r) => (letGo = r));
  const looked = otherLooks;

  const going = buildNow();
  // Other is looked at while the Steward's #49's tests run: its kit isn't released, so #8 waits.
  await until(() => events.includes('Steward tests begin') && otherLooks > looked && heldBy('other') === null, 120_000, "Other's first look");
  assert.deepEqual(events, ['Steward tests begin']);

  letGo();
  const out = await going;
  assert.equal(out.error, undefined, out.log.join('\n'));
  // The Steward's #49 merged and kit 1.0.2 released; then Other looked at again with it, and #8 merged in this round.
  assert.deepEqual(events, ['Steward tests begin', 'Steward tests end', 'Steward #49 merged', 'kit 1.0.2 released', 'Other #8 merged']);
  const log = out.log.join('\n');
  assert.match(log, /kit 1\.0\.2 released beside the employees' merges: Other looked at with it now/);
  const did = done(out);
  for (const line of ['merged #8 (checks passed here at …)', 'merged #49 (checks passed here at …)', 'release: released v0.4.2 from origin/main (…), with kit 1.0.2']) assert.ok(did.includes(line), `${line}\n${did.join('\n')}`);
  assert.ok(did.some((m) => /released kit-v1\.0\.2 from origin\/main/.test(m)), did.join('\n'));
  assert.equal(out.build?.closed, true, log);
  assert.deepEqual(released(), ['0.4.0', '0.4.1', '0.4.2']);
});
