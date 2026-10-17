import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A PR made a draft again between the round's look and its merge (2026-10-17: the owner's build tested #316 while its
// session made it a draft, and GitHub refused the merge, "Pull Request is still a draft"): it waits as a draft does,
// and the round says so, rather than a merge that failed.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-draft-before-merge-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
process.env.WRIGHT_HOME = path.join(tmp, 'no-wright');
process.env.BAILIFF_HOME = path.join(tmp, 'no-bailiff');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { mergeOne } = await import('../src/stages/merge.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];

test('a PR made a draft again before its merge waits as a draft, not a failed merge', async () => {
  const f = fakeEmployee(path.join(tmp, 'fake'), { version: '0.4.0' });
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', '0.4.1'));
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', '#40');
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', '--force', 'origin', `${sha}:refs/pull/40/head`);
  sh(f.checkout, 'reset', '--quiet', '--hard', 'HEAD~1');
  const e = employee(f.checkout, { fill: '' });
  const pr = { number: 40, title: '#40', url: 'https://github.com/Jcollier0120/Fake/pull/40', headRefName: 'claude/40', headRefOid: sha, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: green, body: '' };
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([pr]);
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'pr' && args[1] === 'merge') return { code: 1, out: '', err: 'GraphQL: Pull Request is still a draft (mergePullRequest)' };
  });
  const look = await mergeOne(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp }), e, { yes: true, team: true });
  assert.ok(r.gh.some((a) => a[0] === 'pr' && a[1] === 'merge'), 'it was ready when looked at, so the merge was asked for');
  assert.deepEqual(look.merged, []);
  assert.notEqual(look.outcome, 'failed', look.message);
  assert.doesNotMatch(look.message, /didn't merge/);
  assert.match(look.message, /#40 .* waits: a draft \(made one again before its merge\)/);
  const held = look.held.find((h) => h.number === 40);
  assert.equal(held?.why, 'a draft');
  assert.equal(held?.draft, true);
});
