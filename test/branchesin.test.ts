import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// Branches in (stages/branchesin.ts): work claims a version, pushes its branch and vouches for its head, with no PR of
// its own; the Steward's round opens the PR for it, then merges it as any vouched PR.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-branchesin-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { claimsFile } = await import('../src/claims.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { claimedBranches, openVouchedBranches } = await import('../src/stages/branchesin.ts');
const { merge } = await import('../src/stages/merge.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { vouch } = await import('../src/stages/vouch.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type Claim = import('../src/claims.ts').Claim;

const claim = (o: Partial<Claim> = {}): Claim => ({ repo: 'Jcollier0120/Fake', version: '0.4.1', branch: 'claude/feature', by: 'claude', for: 'a feature', at: new Date().toISOString(), ...o });
const ENTRY = '**A feature, at last.**\n\n### What\'s new\n\n- A feature.\n\n### Before you update\n\n- Nothing: it updates itself as usual.';
const byTeam = { context: VOUCH_CONTEXT, state: 'success', creator: { login: 'jcollier0120' } };
beforeEach(() => rmSync(claimsFile(), { force: true }));

test("the branches the Steward would open PRs from: its claims' branches, the highest version each, never its own nor the Wright's", () => {
  const e = employee(path.join(tmp, 'none'));
  const got = claimedBranches(e, [
    claim({ version: '0.4.2', branch: 'claude/b' }),
    claim({ version: '0.4.1', branch: 'claude/a' }),
    claim({ version: '0.4.3', branch: 'claude/a' }),
    claim({ version: '0.4.4', branch: null }),
    claim({ version: '0.4.5', branch: 'steward/kit-2.44.0' }),
    claim({ version: '0.4.6', branch: 'wright/12-thing' }),
    claim({ version: '0.4.7', branch: 'main' }),
  ]);
  assert.deepEqual(got.map((c) => [c.branch, c.version]), [['claude/b', '0.4.2'], ['claude/a', '0.4.3']]);
});

/** A Fake whose claude/feature branch sets v0.4.1 with its entry, pushed to origin; its clone's origin says GitHub. */
function pushed(name: string) {
  const f = fakeEmployee(path.join(tmp, name), { version: '0.4.0', files: { 'CHANGELOG.md': "# Fake's changelog\n\n## 0.4.0\n\n**First.**\n" } });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/feature');
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').split('0.4.0').join('0.4.1'));
  writeFileSync(path.join(f.checkout, 'CHANGELOG.md'), `# Fake's changelog\n\n## 0.4.1\n\n${ENTRY}\n\n## 0.4.0\n\n**First.**\n`);
  writeFileSync(path.join(f.checkout, 'feature.txt'), 'a feature\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'A feature');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  return { ...f, head };
}

/** A clone whose origin says GitHub (what vouch reads), while git reaches the local origin.git. */
function asGitHub(checkout: string, origin: string) {
  sh(checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  sh(checkout, 'config', `url.${origin.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/Jcollier0120/Fake.git');
}

test('steward vouch on a branch with no PR: only once a version is claimed for it and it is pushed as it is; then the round is asked to look at it', async () => {
  const f = pushed('vouch-branch');
  asGitHub(f.checkout, f.origin);
  const go = () => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return { code: 1, out: '', err: 'no pull requests found for branch "claude/feature"' };
      if (a[0] === 'api') return ok('{}');
    });
    const e = employee(f.checkout, { fill: '', test: ['node -e process.exit(0)'] });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    return vouch(ctx, { dir: f.checkout, say: () => {} }).then((v) => ({ v, r }));
  };

  const unclaimed = await go();
  assert.equal(unclaimed.v.ok, false);
  assert.match(unclaimed.v.message, /no version is claimed for it: claim one \(claim-version fake --branch claude\/feature/);
  assert.ok(!unclaimed.r.gh.some((a) => a[0] === 'api'), 'nothing recorded');

  writeJson(claimsFile(), [claim()]);
  const unpushed = await go();
  assert.equal(unpushed.v.ok, false);
  assert.match(unpushed.v.message, /claude\/feature isn't on origin: push it/);

  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/feature');
  const done = await go();
  assert.equal(done.v.ok, true, done.v.message);
  assert.equal(done.v.look, 'fake');
  assert.match(done.v.message, /claude\/feature's checks passed at .*: the Steward opens its PR \(v0\.4\.1\) at its round/);
  assert.deepEqual(done.r.gh.find((a) => a[0] === 'api')?.slice(0, 3), ['api', '-X', 'POST']);

  // Pushed to since: origin's head isn't the clone's.
  writeFileSync(path.join(f.checkout, 'more.txt'), 'more\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'more');
  const behind = await go();
  assert.equal(behind.v.ok, false);
  assert.match(behind.v.message, /origin's claude\/feature is at .*, this clone's HEAD .*: push/);
});

test('the round opens the PR for a claimed, pushed, vouched branch, titled by its entry, and merges it untested', async () => {
  const f = pushed('round');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/feature');
  sh(f.checkout, 'switch', '--quiet', 'main');
  writeJson(claimsFile(), [claim()]);
  let opened = false;
  const pr = () => ({ number: 31, title: 'Fake 0.4.1: A feature, at last', url: 'https://github.com/Jcollier0120/Fake/pull/31', body: '', headRefName: 'claude/feature', headRefOid: f.head, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], labels: [], additions: 5, deletions: 2, files: [] });
  const r = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list' && a.includes('closed')) return ok([]);
    if (a[0] === 'pr' && a[1] === 'list') return ok(opened ? [pr()] : []);
    if (a[0] === 'pr' && a[1] === 'create') {
      opened = true;
      sh(f.origin, 'update-ref', 'refs/pull/31/head', f.head);
      return ok('https://github.com/Jcollier0120/Fake/pull/31\n');
    }
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' }]);
    if (a[0] === 'api' && a[1].includes(`/commits/${f.head}/statuses`)) return ok([byTeam]);
    if (a[0] === 'api') return ok([]);
    return ok('');
  });
  // Checks that would fail, were they run.
  const e = employee(f.checkout, { fill: '', test: ['node -e process.exit(1)'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
  const [m] = await merge(ctx, [e], { yes: true, team: true });
  const create = r.gh.find((a) => a[1] === 'create')!;
  assert.deepEqual(create.slice(0, 9), ['pr', 'create', '--repo', 'Jcollier0120/Fake', '--base', 'main', '--head', 'claude/feature', '--title']);
  assert.equal(create[9], 'Fake 0.4.1: A feature, at last');
  assert.equal(m.outcome, 'done', m.message);
  assert.match(m.message, new RegExp(`^opened #31 from claude/feature \\(v0\\.4\\.1, vouched for by jcollier0120 at ${f.head.slice(0, 7)}\\); merged #31 \\(checks passed at ${f.head.slice(0, 7)} in jcollier0120's clone, vouched for\\)`));
  assert.doesNotMatch(ctx.lines.join('\n'), /testing it here/);
  assert.deepEqual(r.gh.filter((a) => a[1] === 'merge'), [['pr', 'merge', '31', '--repo', 'Jcollier0120/Fake', '--merge', '--match-head-commit', f.head]]);
});

test("a claimed branch isn't opened while unvouched, merged already, closed at its head, or not on origin", async () => {
  const f = pushed('not-yet');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/feature');
  sh(f.checkout, 'switch', '--quiet', 'main');
  const look = async (o: { statuses?: readonly unknown[]; closed?: readonly unknown[]; branch?: string }) => {
    writeJson(claimsFile(), [claim({ branch: o.branch ?? 'claude/feature' })]);
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'list' && a.includes('closed')) return ok(o.closed ?? []);
      if (a[0] === 'pr' && a[1] === 'list') return ok([]);
      if (a[0] === 'api') return ok(o.statuses ?? [byTeam]);
      return ok('');
    });
    const e = employee(f.checkout);
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const out = await openVouchedBranches(ctx, e);
    return { out, r, lines: ctx.lines.join('\n') };
  };
  for (const [why, o] of [
    ['no vouch', { statuses: [] }],
    ["a stranger's vouch", { statuses: [{ ...byTeam, creator: { login: 'stranger' } }] }],
    ['closed at its head', { closed: [{ number: 30, headRefOid: f.head }] }],
    ['not on origin', { branch: 'claude/never-pushed' }],
  ] as const) {
    const t = await look(o);
    assert.deepEqual(t.out.opened, [], why);
    assert.ok(!t.r.gh.some((a) => a[1] === 'create'), why);
  }
  // Merged already: its head in main.
  sh(f.checkout, 'merge', '--quiet', '--ff-only', 'claude/feature');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  const merged = await look({});
  assert.deepEqual(merged.out.opened, []);
  assert.ok(!merged.r.gh.some((a) => a[1] === 'create'));
});
