import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Versions claimed up front: the next one no one has, one claim at a time, the same again for the same branch;
// given back when the work lands or goes stale; and honoured by the merge stage.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-claims-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { after: next, claimVersion, claimsFile, loadClaims, pruneClaims, releaseClaim, stillHeld, titleVersions } = await import('../src/claims.ts');
const { teamHold } = await import('../src/stages/merge.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const DAY = 86_400_000;

/** A fake employee at 0.4.10, released up to `released`, with open PRs titled `titles`. */
function setup(name: string, o: { released?: string[]; titles?: { title: string; headRefName: string }[] } = {}) {
  const dir = path.join(home, name);
  const { checkout } = fakeEmployee(dir, { version: '0.4.10' });
  const r = runner((a) => {
    if (a[0] === 'release' && a[1] === 'list') return ok((o.released ?? ['0.4.10']).map((v) => ({ tagName: `v${v}`, isDraft: false, publishedAt: '2026-10-05T00:00:00Z' })));
    if (a[0] === 'pr' && a[1] === 'list') return ok(o.titles ?? []);
  });
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  return { e, ctx, checkout };
}

test('the next version: above the branch, every release, every open PR and every live claim; the same again for the same branch', async () => {
  rmSync(claimsFile(), { force: true });
  const s = setup('next', { released: ['0.4.10', '0.4.11'], titles: [{ title: 'Fake 0.4.12: something open', headRefName: 'claude/open' }] });
  const a = await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix' });
  assert.deepEqual([a.claim.version, a.again], ['0.4.13', false], 'above the open PR');
  const b = await claimVersion(s.ctx, s.e, { branch: 'wright/7-x', by: 'wright', for: '#7' });
  assert.equal(b.claim.version, '0.4.14', 'above the live claim');
  const again = await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix' });
  assert.deepEqual([again.claim.version, again.again], ['0.4.13', true]);
  const minor = await claimVersion(s.ctx, s.e, { branch: 'claude/big', by: 'claude', for: 'a big one', minor: true });
  assert.equal(minor.claim.version, '0.5.0');
  assert.equal(loadClaims().length, 3);
});

test('workers asking at the same moment each get a version of their own', async () => {
  rmSync(claimsFile(), { force: true });
  const s = setup('together');
  const got = await Promise.all(Array.from({ length: 5 }, (_, i) => claimVersion(s.ctx, s.e, { branch: `claude/w${i}`, by: 'claude', for: `worker ${i}` })));
  assert.deepEqual(got.map((g) => g.claim.version).sort(), ['0.4.11', '0.4.12', '0.4.13', '0.4.14', '0.4.15']);
});

test('a claim lives until its work lands, it is given back, or it goes stale with no PR', async () => {
  const c = { repo: 'Jcollier0120/Fake', version: '0.4.12', branch: 'claude/a', by: 'claude', for: 'x', at: new Date(0).toISOString() };
  const facts = { branchVersion: '0.4.10', released: ['0.4.10'], openBranches: [] as string[], openVersions: [] as string[], now: DAY };
  assert.equal(stillHeld(c, facts), true, 'young');
  assert.equal(stillHeld(c, { ...facts, branchVersion: '0.4.12' }), false, 'on the branch');
  assert.equal(stillHeld(c, { ...facts, released: ['0.4.13'] }), false, 'overtaken by a release');
  assert.equal(stillHeld(c, { ...facts, now: 4 * DAY }), false, 'stale');
  assert.equal(stillHeld(c, { ...facts, now: 4 * DAY, openBranches: ['claude/a'] }), true, 'old, but its PR is open');
  assert.equal(stillHeld(c, { ...facts, now: 4 * DAY, openVersions: ['0.4.12'] }), true, 'old, but a PR sets it');
  assert.deepEqual(titleVersions('Developer Herald', ['Developer Herald 0.5.3: a fix', 'Herald 0.5.9: no', 'Kit 2.1.0 (Developer Herald 0.5.4)']), ['0.5.3']);
  assert.deepEqual([next('0.4.9'), next('0.4.9', true)], ['0.4.10', '0.5.0']);

  writeFileSync(claimsFile(), JSON.stringify([c, { ...c, version: '0.4.13', branch: 'claude/b' }]));
  await pruneClaims([{ repo: 'Jcollier0120/Fake', name: 'Fake', main: { version: '0.4.12' }, release: { version: '0.4.10' }, prs: [] }], DAY);
  assert.deepEqual(loadClaims().map((x) => x.version), ['0.4.13'], 'the landed one given back');
  assert.equal(await releaseClaim('jcollier0120/fake', '0.4.13'), true);
  assert.equal(await releaseClaim('Jcollier0120/Fake', '0.4.13'), false);
  assert.deepEqual(JSON.parse(readFileSync(claimsFile(), 'utf8')), []);
});

test("a PR that sets a version other work claimed waits for a version of its own, which a catch-up gives it", async () => {
  rmSync(claimsFile(), { force: true });
  const s = setup('held');
  // The PR sets 0.4.11, claimed up front by the Wright's work on another branch.
  sh(s.checkout, 'switch', '--quiet', '-c', 'claude/late');
  for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(s.checkout, f), readFileSync(path.join(s.checkout, f), 'utf8').split('0.4.10').join('0.4.11'));
  sh(s.checkout, 'commit', '--quiet', '-am', 'Fake 0.4.11: late');
  sh(s.checkout, 'push', '--quiet', 'origin', 'claude/late', 'HEAD:refs/pull/3/head');
  const headOid = sh(s.checkout, 'rev-parse', 'HEAD');
  sh(s.checkout, 'switch', '--quiet', 'main');
  writeFileSync(claimsFile(), JSON.stringify([{ repo: 'Jcollier0120/Fake', version: '0.4.11', branch: 'wright/7-x', by: 'wright', for: '#7', at: new Date().toISOString() }]));
  const pr = { number: 3, title: 'Fake 0.4.11: late', url: '', head: 'claude/late', base: 'main', author: 'Jcollier0120', whose: 'team' as const, headOid, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none' as const, labels: [], changed: 2, files: [] };
  const lookup = async () => ({ released: ['0.4.10'], base: '0.4.10' });
  const held = await teamHold(s.ctx, s.e, pr, lookup);
  assert.equal(held.why, 'it sets v0.4.11, which wright claimed for #7 (wright/7-x): it needs a version of its own');
  assert.equal(held.raise, true, 'one a catch-up clears');
  // Its own branch's claim is no hold.
  writeFileSync(claimsFile(), JSON.stringify([{ repo: 'Jcollier0120/Fake', version: '0.4.11', branch: 'claude/late', by: 'claude', for: 'late', at: new Date().toISOString() }]));
  assert.equal((await teamHold(s.ctx, s.e, pr, lookup)).why, null);
});
