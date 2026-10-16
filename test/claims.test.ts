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
const { CLAIMS_FILE, CLAIMS_REF, parseClaims } = await import('../src/claims.ts');
const { makersPcForTests } = await import('../src/maker.ts');
const { readRef } = await import('../src/remote-ref.ts');

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

test("the kit is claimed as a part of the Steward's repository: its own key, its own releases, the kit versions open PRs name", async () => {
  rmSync(claimsFile(), { force: true });
  const dir = path.join(home, 'kit-claims');
  const { checkout } = fakeEmployee(dir, { version: '0.21.0', files: { 'kit/VERSION': '2.36.0\n' } });
  const r = runner((a) => {
    if (a[0] === 'release' && a[1] === 'list') return ok(['v0.21.0', 'kit-v2.35.0', 'kit-v2.36.0'].map((tagName) => ({ tagName, isDraft: false, publishedAt: '2026-10-07T00:00:00Z' })));
    if (a[0] === 'pr' && a[1] === 'list') return ok([{ title: 'Fake 0.21.1, kit 2.36.1: GenieX 0.8.0', headRefName: 'claude/geniex' }]);
  });
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  const kit = await claimVersion(ctx, e, { branch: 'claude/x', by: 'claude', for: 'a kit change', part: 'kit' });
  assert.deepEqual([kit.claim.repo, kit.claim.version], [`${e.repo}#kit`, '2.36.2'], 'above the open PR that names kit 2.36.1');
  const own = await claimVersion(ctx, e, { branch: 'claude/x', by: 'claude', for: 'a kit change' });
  assert.deepEqual([own.claim.repo, own.claim.version], [e.repo, '0.21.2'], "the Steward's own, counted apart from the kit's");
  const minor = await claimVersion(ctx, e, { branch: 'claude/y', by: 'claude', for: 'a big kit change', part: 'kit', minor: true });
  assert.equal(minor.claim.version, '2.37.0');
});

test("a maker's other PC claims a version of the maker's repositories through its claims ref, or not at all", async () => {
  rmSync(claimsFile(), { force: true });
  const s = setup('dev-pc');
  const remote = { key: 'jcollier0120/fake', url: path.join(home, 'dev-pc', 'origin.git'), scratch: path.join(home, 'dev-pc', 'turns.git') };
  const shared = async () => {
    const r = await readRef(s.ctx.run, remote, CLAIMS_REF, CLAIMS_FILE);
    return parseClaims(r.kind === 'found' ? r.text : '').map((c) => [c.branch, c.version]);
  };
  makersPcForTests(() => false);
  try {
    // GitHub says this PC's account can't push there: refused, nothing claimed anywhere.
    await assert.rejects(claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix', remote, canPush: async () => false }), /is one of Castellan's own repositories.*can push to Jcollier0120\/Fake/);
    assert.deepEqual(await shared(), []);
    // It can: claimed in the repository's claims ref, which every PC that looks after it reads.
    const a = await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix', remote, canPush: async () => true });
    assert.deepEqual([a.claim.version, a.claim.source, a.again], ['0.4.11', 'shared', false]);
    assert.deepEqual(await shared(), [['claude/a', '0.4.11']]);
    // The ref out of reach: nothing claimed, not even here, where no round would ever share it.
    const before = loadClaims();
    await assert.rejects(claimVersion(s.ctx, s.e, { branch: 'claude/b', by: 'claude', for: 'another', remote: null, canPush: async () => true }), /claims on GitHub \(refs\/manor\/claims\) couldn't be read or written from here.*nothing was claimed/);
    assert.deepEqual(loadClaims(), before);
    // Given back there too.
    assert.equal(await releaseClaim(s.e.repo, '0.4.11', { remote, run: s.ctx.run }), true);
    assert.deepEqual(await shared(), []);
  } finally {
    makersPcForTests(null);
  }
  // The maker's laptop with the ref out of reach: kept here, as always, and shared by a later round.
  makersPcForTests(() => true);
  try {
    const c = await claimVersion(s.ctx, s.e, { branch: 'claude/c', by: 'claude', for: 'offline', remote: null });
    assert.deepEqual([c.claim.version, c.claim.source], ['0.4.11', undefined]);
  } finally {
    makersPcForTests(null);
  }
});

test("a PR moved past the others: its branch's claim made again above every version in line, marked, once; shared with its mark", async () => {
  rmSync(claimsFile(), { force: true });
  const { movedTo } = await import('../src/claims.ts');
  const s = setup('moved', { titles: [{ title: 'Fake 0.4.11: a draft', headRefName: 'claude/draft' }] });
  writeFileSync(claimsFile(), JSON.stringify([{ repo: s.e.repo, version: '0.4.11', branch: 'claude/draft', by: 'claude', for: 'the draft', at: new Date().toISOString() }]));
  // The queue's versions too: a ready PR whose title names none sets 0.4.12, another 0.4.13.
  const m = await claimVersion(s.ctx, s.e, { branch: 'claude/draft', by: 'steward', for: '#7 moved past the others', moved: 7, above: ['0.4.11', '0.4.12', '0.4.13'] });
  assert.deepEqual([m.claim.version, m.claim.moved, m.again], ['0.4.14', 7, false]);
  assert.deepEqual(loadClaims().map((c) => [c.branch, c.version, c.moved]), [['claude/draft', '0.4.14', 7]], "in place of its branch's claim: 0.4.11 is no one's now");
  const again = await claimVersion(s.ctx, s.e, { branch: 'claude/draft', by: 'steward', for: '#7 moved past the others', moved: 7, above: ['0.4.11', '0.4.12', '0.4.13', '0.4.14'] });
  assert.deepEqual([again.claim.version, again.again], ['0.4.14', true], 'moved once: asked again, the same');
  const worker = await claimVersion(s.ctx, s.e, { branch: 'claude/draft', by: 'claude', for: 'the draft' });
  assert.deepEqual([worker.claim.version, worker.again], ['0.4.14', true], 'its worker, asking again, is given it');
  assert.equal(movedTo(loadClaims(), { number: 7, head: 'claude/draft' }), '0.4.14');
  assert.equal(movedTo(loadClaims(), { number: 8, head: 'claude/draft' }), null, 'another PR from a branch of that name: not moved');
  assert.equal((await claimVersion(s.ctx, s.e, { branch: 'claude/next', by: 'claude', for: 'new work' })).claim.version, '0.4.15', 'new work counts from it');
  assert.equal(parseClaims(JSON.stringify([{ ...m.claim, moved: 'seven' }]))[0].moved, undefined, 'a mark that is no number: none');

  // Through the repository's claims ref, as every PC that looks after it reads it: the mark goes with it.
  rmSync(claimsFile(), { force: true });
  const t = setup('moved-shared', { titles: [{ title: 'Fake 0.4.11: a draft', headRefName: 'claude/draft' }] });
  const remote = { key: 'jcollier0120/fake', url: path.join(home, 'moved-shared', 'origin.git'), scratch: path.join(home, 'moved-shared', 'turns.git') };
  const shared = async () => {
    const r = await readRef(t.ctx.run, remote, CLAIMS_REF, CLAIMS_FILE);
    return parseClaims(r.kind === 'found' ? r.text : '').map((c) => [c.branch, c.version, c.moved ?? null]);
  };
  makersPcForTests(() => true);
  try {
    const canPush = async () => true;
    assert.equal((await claimVersion(t.ctx, t.e, { branch: 'claude/draft', by: 'claude', for: 'the draft', remote, canPush })).claim.version, '0.4.12');
    const sm = await claimVersion(t.ctx, t.e, { branch: 'claude/draft', by: 'steward', for: '#7 moved', moved: 7, above: ['0.4.12', '0.4.13'], remote, canPush });
    assert.deepEqual([sm.claim.version, sm.claim.moved, sm.claim.source], ['0.4.14', 7, 'shared']);
    assert.deepEqual(await shared(), [['claude/draft', '0.4.14', 7]]);
    assert.deepEqual(loadClaims().map((c) => [c.branch, c.version, c.moved, c.source]), [['claude/draft', '0.4.14', 7, 'shared']]);
  } finally {
    makersPcForTests(null);
  }
});

test("a catch-up's new version moves its branch's claim: the old one is free, the new one held, its worker given it again", async () => {
  rmSync(claimsFile(), { force: true });
  const { reclaim } = await import('../src/claims.ts');
  const s = setup('reclaim', { released: ['0.4.10'] });
  const a = await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix' });
  assert.equal(a.claim.version, '0.4.11');
  await reclaim(s.e.repo, 'claude/a', '0.4.13');
  assert.deepEqual(loadClaims().map((c) => [c.branch, c.version, c.by, c.for]), [['claude/a', '0.4.13', 'claude', 'a fix']], 'who and what kept');
  const again = await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix' });
  assert.deepEqual([again.claim.version, again.again], ['0.4.13', true]);
  // A branch with no claim gets one, as the Steward's.
  await reclaim(s.e.repo, 'claude/b', '0.4.14');
  assert.deepEqual(loadClaims().find((c) => c.branch === 'claude/b')?.by, 'steward');
});
