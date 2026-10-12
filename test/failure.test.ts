import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Why a step failed, from its kept output, in the alarm that says it failed.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-failure-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { failureDetail, keepFailure, keptFailure, reasonLines } = await import('../src/failure.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');
const { releaseDirOf, workRootOf } = await import('../src/stages/common.ts');
const { refreshDirOf } = await import('../src/stages/refresh.ts');
const { STAFF } = await import('./fixtures/staff.ts');

// A release that couldn't sign: tried three times, each ending on the same error, then npm's own wrap-up.
const SIGNING = [
  '> manor@0.16.105 release',
  '> node tools/kit.ts && node tools/release.ts --publish',
  '',
  'Building the setup (dotnet publish, win-arm64 and win-x64)...',
  'Signing Castellan-Setup-0.16.105-arm64.exe...',
  '',
  '  signing Castellan-Setup-0.16.105-arm64.exe failed (try 1 of 3), trying again in 15 s: SignTool Error: No certificates were found that met all the given criteria.',
  '  signing Castellan-Setup-0.16.105-arm64.exe failed (try 2 of 3), trying again in 15 s: SignTool Error: No certificates were found that met all the given criteria.',
  "release: couldn't sign Castellan-Setup-0.16.105-arm64.exe: SignTool Error: No certificates were found that met all the given criteria.",
  'npm error Lifecycle script `release` failed with error:',
  'npm error code 1',
  '',
].join('\r\n');

// A site's check: notes first, then the problem that failed it, after a blank line.
const CHECK = [
  '> castellan-site@0.1.49 test',
  '> node scripts/check-site.mts',
  '',
  'Docs to review (their product has moved on a minor version or more):',
  '- content/docs/assayer-overview.md (assayer 0.2.4, now 0.3.5)',
  '',
  '- The Steward: the chart gives Gaming Butler, but the setup doesn\'t tick it for "gaming" (Manor\'s staff.json uses)',
].join('\n');

test("a failed step's reason: the end of its last paragraph, each try's same error once, npm's wrap-up and banners left out", () => {
  assert.deepEqual(reasonLines(SIGNING), ["release: couldn't sign Castellan-Setup-0.16.105-arm64.exe: SignTool Error: No certificates were found that met all the given criteria."]);
  assert.deepEqual(reasonLines(CHECK), ['- The Steward: the chart gives Gaming Butler, but the setup doesn\'t tick it for "gaming" (Manor\'s staff.json uses)']);
  assert.deepEqual(reasonLines('a\nb\nc\nd\ne'), ['c', 'd', 'e'], 'at most three');
  assert.deepEqual(reasonLines('npm error code 1\n\n'), [], 'nothing telling: nothing');
  assert.equal(reasonLines('x'.repeat(400))[0].length, 300, 'cut to a line');
  assert.ok(!reasonLines(`token ghp_${'A1b2C3d4'.repeat(5)} refused`)[0].includes('A1b2C3d4A1b2'), 'secrets taken out');
});

test("a kept failure says what it said, what to do when the Steward knows, and where the whole of it is", () => {
  const dir = path.join(home, 'x-release');
  assert.equal(keptFailure(dir), null, 'nothing kept: nothing said');
  assert.deepEqual(failureDetail(null), []);
  keepFailure(dir, 'npm run release -- --publish', 1, SIGNING);
  const kept = keptFailure(dir)!;
  assert.equal(kept.log, `${dir}.log`);
  const lines = failureDetail(kept);
  assert.match(lines[0], /^It ended with: “release: couldn't sign .*No certificates were found/);
  assert.match(lines[1], /sign in, then release it/);
  assert.equal(lines[2], `Its whole output is in ${dir}.log`);
  assert.equal(failureDetail(kept, `see ${dir}.log`).length, 2, 'not named twice when the message names it');
});

test("the release and refresh alarms carry the reason from the kept output, round after round", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const porter = { ...STAFF.find((e) => e.id === 'porter')!, refresh: 'npm run sync' };
  mkdirSync(workRootOf(settings), { recursive: true });
  keepFailure(releaseDirOf(settings, porter), 'npm run release -- --publish', 1, SIGNING);
  keepFailure(refreshDirOf(settings, porter), 'npm test', 1, CHECK);
  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const c = roundConditions({ round, held: [], failedReleases: { porter: 'abc1234' }, failedRefreshes: { porter: { after: 'Farrier 0.1.0', commit: 'def5678', message: 'npm run sync changed lib/staff.generated.json, but npm test failed (exit 1), so nothing was pushed' } }, employees: [porter], settings } as any);
  const rel = c.find((x) => x.id === 'release:porter:abc1234')!;
  assert.match(rel.detail.join('\n'), /It ended with: “release: couldn't sign/);
  assert.match(rel.detail.join('\n'), /SimplySign/);
  assert.ok(rel.detail.includes(`Its whole output is in ${releaseDirOf(settings, porter)}.log`));
  const ref = c.find((x) => x.id.startsWith('refresh:porter:'))!;
  assert.match(ref.detail.join('\n'), /It ended with: “- The Steward: the chart gives Gaming Butler/);
});
