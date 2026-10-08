import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's round, start to finish, on a data folder of its own: a fake employee's git, gh standing in.
// What a team member's PR asks for is done; a quiet round leaves no trace; a version pushed straight to the
// branch is released; and a release that fails isn't tried again at the same commit.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-round-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage, lastStageFile } = await import('../src/steward.ts');
const { roundFailuresFile } = await import('../src/stages/round.ts');
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

// The team's PR #7 raises the version and asks for a release.
sh(f.checkout, 'switch', '--quiet', '-c', 'fix/thing');
const prSha = raise('fix/thing', '0.4.0', '0.4.1');
sh(f.checkout, 'push', '--quiet', 'origin', `${prSha}:refs/pull/7/head`);
sh(f.checkout, 'switch', '--quiet', 'main');

let open = true;
const released = () => (existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter((v) => v && v !== '0.4.3') : []);
const r = runner((args) => {
  if (args[0] === 'pr' && args[1] === 'list') {
    if (!args.includes('Jcollier0120/Fake') || !open) return ok([]);
    return ok([{ number: 7, title: 'Fake 0.4.1: a fix', url: 'https://github.com/Jcollier0120/Fake/pull/7', headRefName: 'fix/thing', headRefOid: prSha, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], body: 'A fix.\n\n```steward\n{"after": ["release"]}\n```\n' }]);
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    sh(f.checkout, 'push', '--quiet', 'origin', `${prSha}:refs/heads/main`);
    open = false;
    return ok('');
  }
  if (args[0] === 'release' && args[1] === 'list') return ok([...released().map((v) => ({ tagName: `v${v}`, isDraft: false })), { tagName: 'v0.4.0', isDraft: false }]);
  if (args[0] === 'release' && args[1] === 'view') return ok({ targetCommitish: prSha });
});
const round = () => runStage('round', {}, { run: r.run });
const last = () => JSON.parse(readFileSync(lastStageFile(), 'utf8'));

test("a round merges the team's ready PR and does what it asks: its release", async () => {
  const out = await round();
  assert.equal(out.error, undefined);
  assert.deepEqual(mergesOf(r.gh), [['pr', 'merge', '7', '--repo', 'Jcollier0120/Fake', '--merge']]);
  assert.deepEqual(out.results.map((x) => [x.outcome, x.message.replace(/\(.{7}\)/, '(…)')]), [
    ['done', `merged #7 (checks passed here at ${prSha.slice(0, 7)})`],
    ['done', 'release: released v0.4.1 from origin/main (…), with kit 1.0.0'],
  ]);
  assert.deepEqual(released(), ['0.4.1'], 'released once: the round adds no second release of what the PR asked for');
  assert.equal(last().stage, 'round');
});

test('a round with nothing to do leaves no trace: the last stage stays what last happened', async () => {
  const before = readFileSync(lastStageFile(), 'utf8');
  const out = await round();
  assert.ok(out.results.every((x) => x.outcome === 'skipped'), JSON.stringify(out.results));
  assert.equal(readFileSync(lastStageFile(), 'utf8'), before);
});

test('a version on the branch with no release, pushed with no PR, is released by the next round', async () => {
  sh(f.checkout, 'pull', '--quiet', '--ff-only', 'origin', 'main');
  sh(f.checkout, 'push', '--quiet', 'origin', `${raise('main', '0.4.1', '0.4.2')}:refs/heads/main`);
  const out = await round();
  assert.deepEqual(out.results.filter((x) => x.outcome !== 'skipped').map((x) => x.message.replace(/\(.{7}\)/, '(…)')), ['release: released v0.4.2 from origin/main (…), with kit 1.0.0']);
  assert.deepEqual(released(), ['0.4.1', '0.4.2']);
});

test("a release that fails is tried once at its commit; later rounds leave it to a person, and say so quietly", async () => {
  const sha = raise('main', '0.4.2', '0.4.3');
  sh(f.checkout, 'push', '--quiet', 'origin', `${sha}:refs/heads/main`);
  const failed = await round();
  assert.match(failed.results.find((x) => x.outcome === 'failed')!.message, /^release: .* failed \(exit 1\)/);
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

test('a round that leaves a PR waiting only on its checks running asks for the next round sooner; one that leaves none waiting so, not', async () => {
  const running = [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }];
  const listing = (checks: unknown[]) =>
    runner((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return ok(args.includes('Jcollier0120/Fake') ? [{ number: 8, title: 'Fake 0.4.9: more', url: 'https://github.com/Jcollier0120/Fake/pull/8', headRefName: 'fix/more', headRefOid: prSha, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: checks, body: '' }] : []);
      if (args[0] === 'release' && args[1] === 'list') return ok([...released().map((v) => ({ tagName: `v${v}`, isDraft: false })), { tagName: 'v0.4.0', isDraft: false }]);
      if (args[0] === 'release' && args[1] === 'view') return ok({ targetCommitish: prSha });
    });
  const lines: string[] = [];
  const soon = await runStage('round', { full: true }, { run: listing(running).run, log: (l) => lines.push(l) });
  assert.equal(soon.soon, true);
  assert.match(lines.join('\n'), /the next round comes sooner: Fake #8 waits only on checks running/);
  const failing = await runStage('round', { full: true }, { run: listing([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }]).run });
  assert.equal(failing.soon, undefined, 'failing checks wait for a person, not a few minutes');
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
