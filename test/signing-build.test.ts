import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Steward 0.36.161: a release that waits until this PC can sign is released by itself once it can, between builds, a
// build of its own; and within the hour before a build that would sign, a PC that can't sign raises an alarm. Whole
// rounds, on a data folder of their own, a fake employee's git, gh, the certificate store and signtool standing in.
const home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-signing-build-')));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));
// A Windows SDK's signtool where findSignTool looks, whatever this PC has: the rounds' runner answers it.
const kits = path.join(home, 'Program Files (x86)');
mkdirSync(path.join(kits, 'Windows Kits', '10', 'bin', '10.0.26100.0', 'x64'), { recursive: true });
writeFileSync(path.join(kits, 'Windows Kits', '10', 'bin', '10.0.26100.0', 'x64', 'signtool.exe'), '');
process.env['ProgramFiles(x86)'] = kits;

const { loadPipeline, savePipeline } = await import('../src/pipeline.ts');
const { forgetSigningLooks, loadSigningAhead, loadSigningWaits, noteSigningWaits } = await import('../src/signing.ts');
const { runStage } = await import('../src/steward.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');
type Runner = import('../src/run.ts').Runner;

const PRINT = '6B654D9C34800D4307D42ACD63B925EDA5CE8D33';
const kitJson = `${JSON.stringify({ kit: '1.0.0', parts: ['node'], native: { build: 'native/build.ps1', out: 'native/build', thumbprint: PRINT } }, null, 2)}\n`;
const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0', files: { 'kit.json': kitJson, 'native/build.ps1': 'param($Arch)\n' } });
sh(f.checkout, 'tag', 'v0.4.0');
sh(f.checkout, 'push', '--quiet', 'origin', 'v0.4.0');

/** main moved on to version `v`, pushed: its sha. */
function bump(v: string): string {
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replace(/0\.4\.\d+/g, v));
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', `Fake ${v}`);
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  return sh(f.checkout, 'rev-parse', 'HEAD');
}

// The release command notes each version it's asked to release, and succeeds: gh lists it released after.
const attempts = path.join(home, 'attempts.txt');
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts} --publish`;
const tried = () => (existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : []);
const releases = () => [...tried().reverse().map((v) => `v${v}`), 'v0.4.0'];

/** Whether this PC can sign: what signtool's test signature says. */
let canSign = false;
const looks: string[] = [];
const graph = () => ({
  data: {
    steward: { releases: { nodes: [{ tagName: 'kit-v1.0.0', isDraft: false }] } },
    e0: {
      ref: { target: { oid: sh(f.origin, 'rev-parse', 'main') } },
      pullRequests: { nodes: [] },
      releases: { nodes: releases().map((tagName) => ({ tagName, isDraft: false, publishedAt: null, tagCommit: null })) },
    },
  },
});
const roundRun: Runner = async (cmd, args, opts) => {
  if (cmd === 'powershell.exe' && args.some((a) => a.includes('Cert:\\CurrentUser\\My'))) return (looks.push('store'), ok('ok\r\n'));
  if (/signtool\.exe$/i.test(cmd)) return (looks.push('signtool'), canSign ? ok('Successfully signed') : { code: 1, out: '', err: 'SignTool Error: The specified CSP could not be found.' });
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  if (args[0] === 'api' && args[1] === 'graphql') return ok(graph());
  if (args[0] === 'release' && args[1] === 'list') return ok(releases().map((tagName) => ({ tagName, isDraft: false })));
  if (args[0] === 'api' && /^repos\/Jcollier0120\/Fake\/commits\/[0-9a-f]{40}\/statuses/.test(args[1])) return ok([{ context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } }]);
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};

test('a release that waited to sign builds by itself once a test signature works, between builds; an hour before a build that would sign, an alarm', async () => {
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '' }],
      team: ['Jcollier0120'],
      workRoot: path.join(home, 'work'),
      afterRelease: [],
      buildPipeline: { times: ['00:00', '06:00', '12:00', '18:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], kit: 'every', windowMinutes: 120 },
    }),
  );
  let now = new Date(2026, 9, 20, 10, 0);
  const round = () => runStage('round', {}, { run: roundRun, now: () => now, pipeline: true, alarms: { manorUrl: 'http://127.0.0.1:9' }, tell: async () => ({ ok: true, said: 'HTTP 200' }) });
  // The 06:00 build's release of 0.4.1 met SimplySign Desktop's session dropped, and waits.
  const six = new Date(2026, 9, 20, 6, 0).toISOString();
  savePipeline({ open: null, builds: [{ due: six, by: 'schedule', started: six, finished: new Date(2026, 9, 20, 6, 40).toISOString(), rounds: 2, merged: [], released: [], failed: [] }] });
  const first = bump('0.4.1');
  noteSigningWaits({ fake: { version: '0.4.1', commit: first.slice(0, 7), why: 'SignTool Error: The specified CSP could not be found.' } }, new Date(2026, 9, 20, 6, 10));

  // Still not connected: a test signature, no build, and the wait says why.
  const still = await round();
  assert.equal(still.error, undefined);
  assert.deepEqual(still.build, { between: true, next: new Date(2026, 9, 20, 12, 0).toISOString() });
  assert.deepEqual(looks, ['store', 'signtool'], 'one test signature');
  assert.deepEqual(tried(), [], 'nothing built');
  assert.match(loadSigningWaits().fake.why, /^signtool can't reach the code-signing key .*connect SimplySign Desktop/);
  assert.equal(loadSigningAhead(), null, 'the next build is more than an hour off');

  // Reconnected: its build begins at once, for its repository alone, and releases it; nothing waits for a click.
  canSign = true;
  now = new Date(2026, 9, 20, 10, 10);
  const signed = await round();
  const log = signed.log.join('\n');
  assert.match(log, /Fake v0\.4\.1 waited until this PC could sign, and it can now: it builds at once, a build of its own/);
  assert.match(log, /the build for the releases that waited to sign \(fake\) begins for fake/);
  assert.match(log, /the newest kit waits for the next build: this one is for the releases that waited to sign/);
  assert.equal(signed.build?.by, 'signing');
  assert.deepEqual(tried(), ['0.4.1'], 'released');
  assert.deepEqual(loadSigningWaits(), {}, 'no longer waits: the alarm clears');
  const run = loadPipeline().open ?? loadPipeline().builds.at(-1)!;
  assert.deepEqual([run.by, run.employees], ['signing', ['fake']]);
  assert.equal(loadPipeline().open, null, 'its build closed once it had released');

  // Main moves on, and the session drops again. Within the hour before the 12:00 build, which would sign 0.4.2: an alarm.
  canSign = false;
  const second = bump('0.4.2');
  now = new Date(2026, 9, 20, 11, 15);
  // The 10:10 release looked at the certificate on the real clock (stages/release.ts passes no time), so its look is
  // stamped later than this round's 11:15 and would stand in: an hour on, it's gone.
  forgetSigningLooks();
  const between = await round();
  assert.equal(between.build?.between, true, JSON.stringify(between.build));
  const ahead = loadSigningAhead();
  assert.deepEqual(ahead && [ahead.build, ahead.names], [new Date(2026, 9, 20, 12, 0).toISOString(), ['Fake 0.4.2']]);
  assert.match(ahead!.why, /can't reach the code-signing key/);
  assert.deepEqual(tried(), ['0.4.1'], 'nothing built between builds');

  // The 12:00 build: the look ahead is done with, and the release waits rather than failing.
  now = new Date(2026, 9, 20, 12, 1);
  const noon = await round();
  assert.equal(noon.build?.by, 'schedule');
  assert.equal(loadSigningAhead(), null);
  assert.deepEqual([loadSigningWaits().fake?.version, loadSigningWaits().fake?.commit], ['0.4.2', second.slice(0, 7)]);
  assert.deepEqual(tried(), ['0.4.1'], 'nothing built while it cannot sign');
  assert.equal(noon.results.find((r) => r.id === 'fake')?.outcome, 'skipped');
});
