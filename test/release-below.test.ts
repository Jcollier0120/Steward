import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// PRs are merged as their authors merge them (Steward 0.36.124), so main may come to carry a version below one released
// already: it isn't released (release.ts's releaseDecision), and the reason names the newest release. A version above it
// is tested by the build first (ReleaseOptions.gate: mainbuild.ts's mainGate), whose refusal fails the release.
// By its real path, as git and the work folder (workRootOf) spell it.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-release-below-')));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { releaseDecision, releaseOne } = await import('../src/stages/release.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const below = (version: string, newest: string) => `v${version} on its branch is below v${newest}, released already: a version above it (claim-version) releases what is merged`;

test('a version below the newest release is not released, and the reason names the newest; one above every release is', () => {
  const c = { usesKit: true, kit: '1.0.0', version: '0.4.1', released: ['0.4.0', '0.4.2'] };
  assert.deepEqual(releaseDecision(c, null), { release: false, why: below('0.4.1', '0.4.2') });
  assert.deepEqual(releaseDecision(c, '1.0.0'), { release: false, why: below('0.4.1', '0.4.2') }, "the rollout's release too");
  assert.deepEqual(releaseDecision({ ...c, version: '0.4.3' }, null), { release: true });
  assert.deepEqual(releaseDecision({ ...c, released: [] }, null), { release: true }, 'the first release');
  // By version, never as text: 0.4.10 is newer than 0.4.9, and a minor or major step is newer than any patch below it.
  const unsorted = ['0.4.10', '0.4.8', '0.4.9'];
  assert.deepEqual(releaseDecision({ ...c, version: '0.4.9', released: ['0.4.10', '0.4.8'] }, null), { release: false, why: below('0.4.9', '0.4.10') });
  assert.deepEqual(releaseDecision({ ...c, version: '0.4.11', released: unsorted }, null), { release: true });
  assert.deepEqual(unsorted, ['0.4.10', '0.4.8', '0.4.9'], 'the releases given are left as they were');
  assert.deepEqual(releaseDecision({ ...c, version: '0.9.9', released: ['0.4.0', '1.0.0', '0.5.0'] }, null), { release: false, why: below('0.9.9', '1.0.0') });
  // Released already, or no version: said as before.
  assert.deepEqual(releaseDecision({ ...c, version: '0.4.0' }, null), { release: false, why: 'v0.4.0 is already released' });
  assert.deepEqual(releaseDecision({ ...c, version: null }, null), { release: false, why: 'no version found on its branch' });
});

test("main merged below the newest release: the build skips it, saying why, and tests nothing; above it, the build's test is asked, and its refusal fails the release", async () => {
  const f = fakeEmployee(path.join(tmp, 'below'), { version: '0.4.1' });
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  let releases = [{ tagName: 'v0.4.2', isDraft: false }, { tagName: 'v0.4.0', isDraft: false }];
  const r = runner((a) => (a[0] === 'release' && a[1] === 'list' ? ok(releases) : undefined));
  const e = employee(f.checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
  const asked: [string, string | null][] = [];
  const why = (commit: string) => `its checks failed here at ${commit.slice(0, 7)}, twice: npm test failed (exit 1)`;
  const gate = async (commit: string, since: string | null) => (asked.push([commit, since]), why(commit));

  const skipped = await releaseOne(ctx, e, { kit: null, gate });
  assert.equal(skipped.outcome, 'skipped');
  assert.equal(skipped.message, below('0.4.1', '0.4.2'));
  assert.equal(skipped.released, undefined, 'not released already: below a release');
  assert.deepEqual(asked, [], 'nothing tested');

  // Only v0.4.0 released: main's v0.4.1 is tested at its head, against the release before, and fails.
  releases = [{ tagName: 'v0.4.0', isDraft: false }];
  const failed = await releaseOne(ctx, e, { kit: null, gate });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.message, `v0.4.1 wasn't released: ${why(head)}`);
  assert.deepEqual([failed.version, failed.commit], ['0.4.1', head.slice(0, 7)]);
  assert.deepEqual(asked, [[head, '0.4.0']]);
  assert.ok(!r.gh.some((a) => a[0] === 'release' && a[1] !== 'list'), 'nothing released');
});
