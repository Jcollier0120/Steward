import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Versions claimed up front: the next one no one has, above main's, one claim at a time, the same again for the same
// branch; given back when the work lands or goes stale.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-claims-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { after: next, claimVersion, claimsFile, loadClaims, pruneClaims, releaseClaim, stillHeld, titleVersions } = await import('../src/claims.ts');
const { ctxFor, employee, fakeEmployee, ok, runner } = await import('./helpers.ts');
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

/**
 * The test runs as the maker's laptop, which keeps a claim of the maker's repositories here, whatever PC runs it: on
 * the maker's other PCs these tests' claims were refused (Steward 0.36.85). Its own PC again once the test ends.
 */
function onMakersLaptop(t: { after: (f: () => void) => void }): void {
  makersPcForTests(() => true);
  t.after(() => makersPcForTests(null));
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

test("above main's version though it isn't released yet: work merged since the last release waits for the build there", async () => {
  rmSync(claimsFile(), { force: true });
  // main says 0.4.10 (merged, waiting for the next build to release it); 0.4.8 is the last release.
  const s = setup('above-main', { released: ['0.4.7', '0.4.8'] });
  const a = await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix' });
  assert.deepEqual([a.claim.version, a.again], ['0.4.11', false], 'never 0.4.9, below the version main carries');
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

test("a claim an older Steward moved past the others (its version queues, gone since 0.36.124) still reads from the shared claims ref, its mark kept", () => {
  const c = { repo: 'Jcollier0120/Fake', version: '0.4.14', branch: 'claude/draft', by: 'steward', for: '#7 moved past the others', at: new Date(0).toISOString() };
  assert.deepEqual(parseClaims(JSON.stringify([{ ...c, moved: 7 }])), [{ ...c, moved: 7 }]);
  assert.equal(parseClaims(JSON.stringify([{ ...c, moved: 'seven' }]))[0].moved, undefined, 'a mark that is no number: none');
});
