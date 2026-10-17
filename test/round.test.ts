import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's round, start to finish, on a data folder of its own: a fake employee's git, gh standing in. It merges no
// one's PRs (Steward 0.36.121): what their authors merge, main's head, is tested once unless a vouch covers it, and
// released; a quiet round leaves no trace; and a release that fails isn't tried again at the same commit.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-round-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage, lastStageFile } = await import('../src/steward.ts');
const { roundFailuresFile } = await import('../src/stages/round.ts');
const { mainTestedFile } = await import('../src/stages/mainbuild.ts');
const { fakeEmployee, mergesOf, ok, runner, sh } = await import('./helpers.ts');

const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0' });
/** A version, raised in every version file on the branch `on`, committed; its commit. */
function raise(on: string, from: string, to: string): string {
  sh(f.checkout, 'switch', '--quiet', on);
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll(from, to));
  sh(f.checkout, 'commit', '--quiet', '-am', `Fake ${to}`);
  return sh(f.checkout, 'rev-parse', 'HEAD');
}

// The release command notes each version it's asked to release, and fails on 0.4.3.
const attempts = path.join(home, 'attempts.txt');
const releaseCmd = `node -e "const fs=require('fs');const v=JSON.parse(fs.readFileSync('package.json','utf8')).version;fs.appendFileSync(process.argv[1],v+'\\n');if(v==='0.4.3')process.exit(1)" ${attempts}`;
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
  }),
);

// The team's PR #7 raises the version. Vouched for (`steward vouch`), its author merges it: a merge commit on main whose
// tree is the PR head's.
sh(f.checkout, 'switch', '--quiet', '-c', 'fix/thing');
const prSha = raise('fix/thing', '0.4.0', '0.4.1');
sh(f.checkout, 'switch', '--quiet', 'main');
sh(f.checkout, 'merge', '--quiet', '--no-ff', '-m', 'Merge pull request #7 from Jcollier0120/fix/thing', 'fix/thing');
const mergeSha = sh(f.checkout, 'rev-parse', 'HEAD');
sh(f.checkout, 'push', '--quiet', 'origin', 'main');

/** The commits a team account vouched for (steward/tested): the PR's head, and each the Steward vouches for once it passes here. */
const vouched = new Set([prSha]);
const released = () => (existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter((v) => v && v !== '0.4.3') : []);
const tested = () => (existsSync(mainTestedFile()) ? JSON.parse(readFileSync(mainTestedFile(), 'utf8')) : {}) as Record<string, { ok: boolean; note: string }>;
const r = runner((args) => {
  if (args[0] === 'pr' && args[1] === 'list') return ok([]);
  // A commit's statuses (vouch.ts's vouchOn), and the Steward's own vouch set on one (setVouch).
  const on = args[0] === 'api' ? /^repos\/Jcollier0120\/Fake\/(?:commits\/([0-9a-f]{40})\/statuses|statuses\/([0-9a-f]{40}))/.exec(args.find((a) => a.startsWith('repos/')) ?? '') : null;
  if (on?.[1]) return ok(vouched.has(on[1]) ? [{ context: 'steward/tested', state: 'success', creator: { login: 'Jcollier0120' } }] : []);
  if (on?.[2]) {
    vouched.add(on[2]);
    return ok({});
  }
  if (args[0] === 'release' && args[1] === 'list') return ok([...released().map((v) => ({ tagName: `v${v}`, isDraft: false })), { tagName: 'v0.4.0', isDraft: false }]);
  if (args[0] === 'release' && args[1] === 'view') return ok({ targetCommitish: mergeSha });
});
// Manor's page, which doesn't answer here (settings.ts's agentPages would read this PC's Manor for it).
const round = () => runStage('round', {}, { run: r.run, alarms: { manorUrl: 'http://127.0.0.1:9' } });
const last = () => JSON.parse(readFileSync(lastStageFile(), 'utf8'));
/** How many times main's checks were run here in a round's log (mainbuild.ts's testAt). */
const testsIn = (log: string[]) => log.filter((l) => /^\[fake\] testing main at /.test(l)).length;

test("a round releases what the PR's author merged, once: a team member's vouch covers it, so it isn't tested again; the Steward merges nothing", async () => {
  const out = await round();
  assert.equal(out.error, undefined);
  assert.deepEqual(mergesOf(r.gh), [], "no one's PR merged by the Steward");
  assert.deepEqual(out.results.map((x) => [x.outcome, x.message.replace(/\(.{7}\)/, '(…)')]), [['done', 'release: released v0.4.1 from origin/main (…), with kit 1.0.0']]);
  assert.ok(out.log.includes(`[fake] Jcollier0120 vouched for ${prSha.slice(0, 7)}, which ${mergeSha.slice(0, 7)} merged unchanged: not tested again before its release`), out.log.join('\n'));
  assert.equal(testsIn(out.log), 0);
  assert.equal(tested()[`fake@${mergeSha}`], undefined, 'not tested here, so nothing kept');
  assert.deepEqual(released(), ['0.4.1'], 'released once');
  assert.equal(last().stage, 'round');
});

test('a round with nothing to do leaves no trace: the last stage stays what last happened', async () => {
  const before = readFileSync(lastStageFile(), 'utf8');
  const out = await round();
  assert.ok(out.results.every((x) => x.outcome === 'skipped'), JSON.stringify(out.results));
  assert.equal(readFileSync(lastStageFile(), 'utf8'), before);
});

test('a version pushed straight to main, with no PR and no vouch, is tested here once and released by the next round; its pass is vouched for', async () => {
  sh(f.checkout, 'pull', '--quiet', '--ff-only', 'origin', 'main');
  const sha = raise('main', '0.4.1', '0.4.2');
  sh(f.checkout, 'push', '--quiet', 'origin', `${sha}:refs/heads/main`);
  const out = await round();
  assert.deepEqual(out.results.filter((x) => x.outcome !== 'skipped').map((x) => x.message.replace(/\(.{7}\)/, '(…)')), ['release: released v0.4.2 from origin/main (…), with kit 1.0.0']);
  assert.deepEqual(released(), ['0.4.1', '0.4.2']);
  assert.equal(testsIn(out.log), 1, out.log.join('\n'));
  assert.equal(tested()[`fake@${sha}`]?.ok, true, "main's head tested here before its release, and kept by commit");
  assert.ok(vouched.has(sha), 'its pass vouched for on that commit, so nothing tests it again');
});

test("a release that fails is tried once at its commit; later rounds leave it to a person, and say so quietly", async () => {
  const sha = raise('main', '0.4.2', '0.4.3');
  sh(f.checkout, 'push', '--quiet', 'origin', `${sha}:refs/heads/main`);
  const failed = await round();
  assert.match(failed.results.find((x) => x.outcome === 'failed')!.message, /^release: .* failed \(exit 1\)/);
  assert.equal(testsIn(failed.log), 1, 'its checks passed here first');
  assert.equal(last().results.some((x: any) => x.outcome === 'failed'), true, 'the failure is recorded');
  assert.deepEqual(JSON.parse(readFileSync(roundFailuresFile(), 'utf8')), { fake: sha.slice(0, 7) });
  const before = readFileSync(lastStageFile(), 'utf8');
  const again = await round();
  assert.match(again.results.at(-1)!.message, new RegExp(`^release: v0\\.4\\.3 at ${sha.slice(0, 7)} failed to release in an earlier round, so the rounds leave it to you`));
  assert.equal(readFileSync(lastStageFile(), 'utf8'), before, 'not recorded again');
  assert.equal(readFileSync(attempts, 'utf8').split('\n').filter((v) => v === '0.4.3').length, 1, 'tried once');
  // And it needs the person: an alarm, raised by the round (alarms.ts); Manor and the Surveyor aren't read under node --test.
  const alarms = JSON.parse(readFileSync(path.join(home, 'alarms.json'), 'utf8'));
  assert.deepEqual(alarms.open.map((a: any) => a.id), [`release:fake:${sha.slice(0, 7)}`]);
  assert.ok('manor:down' in alarms.watching && !alarms.open.some((a: any) => a.id === 'manor:down'), 'watched, not yet an hour');

  // A fresh start (the page started again, or the PC woke): it may have failed only because the PC was going down, so
  // it's tried once more, its checks not run again (their pass is kept by commit); failing again, it stands as before.
  const { noteFreshStart } = await import('../src/fresh-start.ts');
  noteFreshStart();
  const retried = await round();
  assert.equal(readFileSync(attempts, 'utf8').split('\n').filter((v) => v === '0.4.3').length, 2, 'tried again after the fresh start');
  assert.equal(testsIn(retried.log), 0, 'tested once per commit');
  assert.deepEqual(JSON.parse(readFileSync(roundFailuresFile(), 'utf8')), { fake: sha.slice(0, 7) }, 'failed again: held as before');
  await round();
  assert.equal(readFileSync(attempts, 'utf8').split('\n').filter((v) => v === '0.4.3').length, 2, 'once per fresh start');
});

test('a round while this PC is offline asks GitHub nothing, fails nothing and leaves no trace: it waits for the network', async () => {
  const before = readFileSync(lastStageFile(), 'utf8');
  const asked = runner();
  const out = await runStage('round', {}, { run: asked.run, online: async () => false });
  assert.equal(out.offline, true);
  assert.deepEqual(out.results, []);
  assert.equal(out.error, undefined);
  assert.deepEqual(asked.gh, [], 'not one gh call');
  assert.ok(out.log.some((l) => /this PC is offline, so the round waits for the network/.test(l)));
  assert.equal(readFileSync(lastStageFile(), 'utf8'), before, 'not recorded: nothing happened');
});

test("a release that fails while this PC is offline isn't held against its commit: the next round tries it again", async () => {
  // A new commit at 0.4.3 (whose release command fails): the PC is online as the round starts, offline as it fails.
  writeFileSync(path.join(f.checkout, 'note.txt'), 'again');
  sh(f.checkout, 'switch', '--quiet', 'main');
  sh(f.checkout, 'add', 'note.txt');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a note');
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${sha}:refs/heads/main`);
  const tries = () => readFileSync(attempts, 'utf8').split('\n').filter((v) => v === '0.4.3').length;
  const before = tries();
  let looks = 0;
  const failed = await runStage('round', {}, { run: r.run, online: async () => looks++ === 0 });
  assert.match(failed.results.find((x) => x.outcome === 'failed')!.message, /^release: .* failed \(exit 1\)/);
  assert.notEqual(JSON.parse(readFileSync(roundFailuresFile(), 'utf8')).fake, sha.slice(0, 7), 'no hold on this commit: it failed offline');
  assert.equal(tries(), before + 1);
  await round();
  assert.equal(tries(), before + 2, 'tried again, online');
  assert.equal(JSON.parse(readFileSync(roundFailuresFile(), 'utf8')).fake, sha.slice(0, 7), 'online, a failure is held as before');
});

test('the next round comes sooner at most a few times in a row, and never later than Settings say', async () => {
  const { soonAfter, SOON_MS, SOON_IN_A_ROW } = await import('../src/agent.ts');
  const every = 10 * 60_000;
  let run = 0;
  const waits: (number | null)[] = [];
  for (let i = 0; i < SOON_IN_A_ROW + 2; i++) {
    const next = soonAfter(true, run, every);
    waits.push(next.sooner);
    run = next.run;
  }
  assert.deepEqual(waits, [...Array(SOON_IN_A_ROW).fill(SOON_MS), null, SOON_MS], 'then one at the interval, and sooner again after it');
  assert.deepEqual(soonAfter(false, 2, every), { sooner: null, run: 0 }, 'a round that asks for nothing sooner resets the count');
  assert.deepEqual(soonAfter(true, 0, SOON_MS), { sooner: null, run: 0 }, 'an interval as short already stays');
});

test("the page's staff table names each repository's host, so its PRs go by that host's name", async () => {
  const { staffView } = await import('../src/agent.ts');
  const { hostOf } = await import('../src/scm.ts');
  const row = (repo: string) => ({ id: repo, name: repo, repo, prs: [] }) as any;
  const staff = { at: '', kit: null, kitNote: null, released: [], local: null, rows: [row('alex/recipes'), row('gitlab.com/alex/garden')] };
  const look = { at: '', tools: [{ cmd: 'gh', name: 'GitHub CLI', version: '2', signedIn: true, supported: true }, { cmd: 'glab', name: 'GitLab CLI', version: '1', signedIn: true, supported: true }] } as any;
  const view = staffView(staff, (r) => hostOf(r, { sourceControl: 'auto', releasesCastellan: false }, look));
  assert.deepEqual(view?.rows.map((r) => r.host), ['github', 'gitlab']);
  assert.equal(staffView(staff)?.rows[0].host, undefined, 'none given, none said: the page reads it as GitHub');
});
