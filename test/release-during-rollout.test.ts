import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from '../kit/test/until.ts';

// Steward 0.36.137: a Release for a kit, pressed on the Steward's page while that kit's rollout runs beside the rounds,
// waits for the rollout to end, then releases each employee from the bump it merged. On 2026-10-17 a Release pressed two
// minutes into kit 2.82.4's rollout released the 22 employees the rollout had merged and skipped the 13 it hadn't ("its
// branch pins kit 2.81.0, not 2.82.4: merge the bump first"); a round then held 10 of those as a new kit alone. Here a
// fake employee's bump waits on its checks, which wait for the test to let them go, while the Release is pressed.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-release-during-rollout-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { rolloutDone, rolloutsBeside } = await import('../src/stages/rollout.ts');
const { fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');

const fake = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0', kit: '1.0.0' });

// Fake's checks say they've started, then wait until the test lets them go (with a limit of their own, should it never).
const started = path.join(home, 'checks-started');
const letGo = path.join(home, 'checks-go');
const held = `node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],'');const end=Date.now()+300000;const s=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(process.argv[2])){if(Date.now()-end>0)process.exit(3);Atomics.wait(s,0,0,20)}" ${started} ${letGo}`;
// The release command notes the version it releases, which gh's release list then shows.
const attempts = path.join(home, 'released-fake.txt');
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
const versionFiles = ['package.json', 'package-lock.json', 'src/app.ts'];
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: fake.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: [held], versionFiles, release: releaseCmd, install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    afterRelease: [],
    stewardRepo: 'octocat/steward',
    releasesCastellan: true,
    alarms: { manorUrl: '', surveyorUrl: '', toast: false },
  }),
);

const kits = ['1.0.1', '1.0.0'];
const released = () => ['0.4.0', ...(existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : [])];
const open: any[] = [];
let prNumber = 7;
const merged: number[] = [];
const run = async (cmd: string, args: string[], opts?: any) => {
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  const repo = args[args.indexOf('--repo') + 1];
  if (args[0] === 'release' && args[1] === 'list') {
    if (repo === 'octocat/steward') return ok(kits.map((k) => ({ tagName: `kit-v${k}`, isDraft: false })));
    return ok(released().map((v) => ({ tagName: `v${v}`, isDraft: false })));
  }
  if (args[0] === 'pr' && args[1] === 'list') return ok(args.includes('--head') ? open.filter((p) => p.headRefName === args[args.indexOf('--head') + 1]) : open);
  if (args[0] === 'pr' && args[1] === 'create') {
    const head = args[args.indexOf('--head') + 1];
    const n = ++prNumber;
    open.push({ number: n, title: args[args.indexOf('--title') + 1], url: `https://github.com/${repo}/pull/${n}`, body: '', headRefName: head, headRefOid: sh(fake.origin, 'rev-parse', head), baseRefName: 'main', isCrossRepository: false, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', author: { login: 'Jcollier0120' }, labels: [], files: [], statusCheckRollup: [] });
    return ok(`https://github.com/${repo}/pull/${n}\n`);
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const i = open.findIndex((x) => String(x.number) === args[2]);
    if (i < 0) return { code: 1, out: '', err: `no open PR #${args[2]}` };
    sh(fake.origin, 'update-ref', 'refs/heads/main', open[i].headRefOid);
    merged.push(open[i].number);
    open.splice(i, 1);
    return ok('');
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};

test("a Release for a kit pressed while that kit's rollout runs beside the rounds waits for it to end, then releases from the bump it merged", async (t) => {
  rolloutsBeside({ log: () => {} });
  t.after(async () => {
    writeFileSync(letGo, '');
    await rolloutDone();
    rolloutsBeside(null);
  });

  // Kit 1.0.1 is out and Fake pins 1.0.0: the round starts its bump beside it, whose checks then hold it.
  const first = await runStage('round', {}, { run, ownKit: '9.9.9' });
  assert.equal(first.error, undefined, first.log.join('\n'));
  assert.match(first.log.join('\n'), /rollout: kit 1\.0\.1 for Fake, beside the rounds/);
  await until(() => existsSync(started), 60_000, "Fake's bump to start its checks");

  // The Release, pressed now: Fake's main still pins kit 1.0.0, so it waits for the rollout rather than skip Fake.
  const lines: string[] = [];
  let ended = false;
  const pressed = runStage('release', { employees: ['fake'], kit: '1.0.1' }, { run, ownKit: '9.9.9', log: (l) => lines.push(l) }).finally(() => (ended = true));
  await until(() => lines.some((l) => /waits for kit 1\.0\.1's rollout beside the rounds to end \(1 employee\)/.test(l)), 60_000, 'the Release to wait for the rollout');
  assert.equal(ended, false, 'still waiting while the bump is held');
  assert.deepEqual(released(), ['0.4.0']);

  // Its checks pass: the rollout merges Fake's kit PR and ends, and the Release goes on from the merged bump.
  writeFileSync(letGo, '');
  const out = await pressed;
  assert.equal(out.error, undefined, out.log.join('\n'));
  assert.deepEqual(merged, [8], 'the rollout merged its kit PR');
  const fakes = out.results.filter((r) => r.id === 'fake');
  assert.equal(fakes.length, 1, out.log.join('\n'));
  assert.equal(fakes[0].outcome, 'done', `${fakes[0].message}\n${out.log.join('\n')}`);
  assert.match(fakes[0].message, /^released v0\.4\.1 from origin\/main \(.{7}\), with kit 1\.0\.1/);
  assert.deepEqual(released(), ['0.4.0', '0.4.1']);
});
