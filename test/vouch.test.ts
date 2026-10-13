import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A team PR its author vouched for (stages/vouch.ts): its checks ran and passed in the author's clone at its head, and
// a team member's account said so on GitHub. The Steward merges it without testing it again; anyone else's word, a
// newer failure, the Wright's PR or a head pushed since, and it is tested here as before. And `steward vouch` itself.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-vouch-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { mergeOne } = await import('../src/stages/merge.ts');
const { checksOf, VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { askRoundSoon, vouch } = await import('../src/stages/vouch.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const vouchStatus = { __typename: 'StatusContext', context: VOUCH_CONTEXT, state: 'SUCCESS' };

test("a vouch isn't a check GitHub runs: alone, a PR's checks are none; beside real ones, it changes nothing", () => {
  assert.equal(checksOf([vouchStatus]), 'none');
  assert.equal(checksOf([{ ...vouchStatus, state: 'FAILURE' }]), 'none');
  assert.equal(checksOf([vouchStatus, { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }]), 'pending');
  // Any other status is a check, as before.
  assert.equal(checksOf([{ __typename: 'StatusContext', context: 'ci/build', state: 'SUCCESS' }]), 'passing');
});

test('a team PR vouched for by a team member at its head is merged without being tested here; anything less, and it is tested', async () => {
  const f = fakeEmployee(path.join(tmp, 'merge'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/thing');
  writeFileSync(path.join(f.checkout, 'thing.txt'), 'a thing\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a thing');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${head}:refs/pull/7/head`);
  sh(f.checkout, 'switch', '--quiet', 'main');
  // Its checks here always fail: a merge proves they weren't run.
  const e = employee(f.checkout, { fill: '', test: ['node -e process.exit(1)'] });
  const listed = (o: Record<string, unknown> = {}) => [{ number: 7, title: 'a thing', url: 'https://github.com/Jcollier0120/Fake/pull/7', headRefName: 'claude/thing', headRefOid: head, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [vouchStatus], body: '', labels: [], ...o }];
  const look = async (statuses: unknown[], o: Record<string, unknown> = {}) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'list') return ok(listed(o));
      if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
      if (a[0] === 'api' && a[1] === `repos/Jcollier0120/Fake/commits/${head}/statuses?per_page=100`) return ok(statuses);
      if (a[0] === 'pr' && a[1] === 'merge') return ok('');
    });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const m = await mergeOne(ctx, e, { yes: true, team: true });
    return { m, r, lines: ctx.lines.join('\n') };
  };
  const byTeam = { context: VOUCH_CONTEXT, state: 'success', creator: { login: 'jcollier0120' } };

  const vouched = await look([byTeam, { context: 'other', state: 'failure', creator: { login: 'someone' } }]);
  assert.equal(vouched.m.outcome, 'done', vouched.m.message);
  assert.equal(vouched.m.message, `merged #7 (checks passed at ${head.slice(0, 7)} in jcollier0120's clone, vouched for)`);
  assert.doesNotMatch(vouched.lines, /testing it here/);
  assert.deepEqual(vouched.r.gh.filter((a) => a[1] === 'merge'), [['pr', 'merge', '7', '--repo', 'Jcollier0120/Fake', '--merge', '--match-head-commit', head]]);

  // Someone outside the team, a newer failure, the Wright's PR, or no answer from GitHub: tested here, and so not merged.
  for (const [why, statuses, o] of [
    ['a stranger vouched', [{ ...byTeam, creator: { login: 'stranger' } }], {}],
    ['a newer failure', [{ ...byTeam, state: 'failure' }, byTeam], {}],
    ["the Wright's", [byTeam], { headRefName: 'wright/12-thing' }],
    ['no vouch', [], {}],
  ] as const) {
    const t = await look([...statuses], { ...o });
    // Tested here (the first time; then the same commit's result, kept), so it fails, and waits.
    assert.match(t.m.message, /its checks failed here at/, why);
    assert.ok(!t.r.gh.some((a) => a[1] === 'merge'), why);
    assert.ok(!t.r.gh.some((a) => a.includes('POST')), `${why}: failed here, so no vouch is set`);
  }
});

test("a team PR whose checks pass here gets this PC's vouch on its head, so the Assayer doesn't test it again; the next look reads its pass, not GitHub", async () => {
  const f = fakeEmployee(path.join(tmp, 'passes'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/passes');
  writeFileSync(path.join(f.checkout, 'thing.txt'), 'a thing\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a thing');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${head}:refs/pull/8/head`);
  sh(f.checkout, 'switch', '--quiet', 'main');
  const e = employee(f.checkout, { id: 'passes', fill: '', test: ['node -e process.exit(0)'] });
  // GitHub turns the merge down, so the PR is looked at again with its head unchanged.
  const look = async (o: Record<string, unknown> = {}) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'list') return ok([{ number: 8, title: 'a thing', url: 'https://github.com/Jcollier0120/Fake/pull/8', headRefName: 'claude/passes', headRefOid: head, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], body: '', labels: [], ...o }]);
      if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
      if (a[0] === 'api' && a[1] === `repos/Jcollier0120/Fake/commits/${head}/statuses?per_page=100`) return ok([]);
      if (a[0] === 'api' && a.includes('POST')) return ok({});
      if (a[0] === 'pr' && a[1] === 'merge') return { code: 1, out: '', err: 'GraphQL: Base branch was modified (mergePullRequest)' };
    });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    const m = await mergeOne(ctx, e, { yes: true, team: true });
    return { m, r, lines: ctx.lines.join('\n') };
  };
  const first = await look();
  assert.match(first.lines, /testing it here/);
  const posts = first.r.gh.filter((a) => a.includes('POST'));
  assert.equal(posts.length, 1, first.lines);
  assert.deepEqual(posts[0].slice(0, 8), ['api', '-X', 'POST', `repos/Jcollier0120/Fake/statuses/${head}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`]);
  assert.match(posts[0][9], /^description=the Steward's round: checks passed here at /);

  const again = await look();
  assert.ok(again.r.gh.some((a) => a[1] === 'merge'), 'looked at again, and merged');
  assert.doesNotMatch(again.lines, /testing it here/);
  assert.ok(!again.r.gh.some((a) => String(a[1]).endsWith('/statuses?per_page=100')), "its pass here is read from pr-checks.json, so GitHub's statuses aren't asked");
  assert.ok(!again.r.gh.some((a) => a.includes('POST')), 'nor set again');
});

test('steward vouch: the checks run at the PR\'s head, and only once they pass is the status set; a dirty clone, another head or a failure sets none', async () => {
  const f = fakeEmployee(path.join(tmp, 'clone'), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/vouched');
  writeFileSync(path.join(f.checkout, 'v.txt'), 'v\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'v');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  // The clone of a GitHub repository, as a session's is.
  sh(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Fake.git');
  const go = (o: { test?: string; prHead?: string } = {}) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: o.prHead ?? head, isCrossRepository: false });
      if (a[0] === 'api') return ok('{}');
    });
    const e = employee(f.checkout, { fill: '', test: [o.test ?? 'node -e process.exit(0)'] });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
    return vouch(ctx, { dir: f.checkout, say: () => {} }).then((v) => ({ v, r }));
  };

  const passed = await go();
  assert.equal(passed.v.ok, true, passed.v.message);
  assert.deepEqual(passed.r.gh.find((a) => a[0] === 'pr' && a[1] === 'view')?.slice(0, 3), ['pr', 'view', 'claude/vouched'], 'the PR for its branch');
  assert.deepEqual(passed.r.gh.find((a) => a[0] === 'api'), ['api', '-X', 'POST', `repos/Jcollier0120/Fake/statuses/${head}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`, '-f', `description=node -e process.exit(0) passed at ${head.slice(0, 7)}`]);

  const failed = await go({ test: 'node -e process.exit(1)' });
  assert.equal(failed.v.ok, false);
  assert.match(failed.v.message, /checks failed at .*Nothing was recorded/);
  assert.ok(!failed.r.gh.some((a) => a[0] === 'api'));

  const moved = await go({ prHead: 'f'.repeat(40) });
  assert.equal(moved.v.ok, false);
  assert.match(moved.v.message, /#9's head is fffffff, this clone's HEAD .*: push/);
  assert.ok(!moved.r.gh.some((a) => a[0] === 'api'));

  writeFileSync(path.join(f.checkout, 'v.txt'), 'changed\n');
  const dirty = await go();
  assert.equal(dirty.v.ok, false);
  assert.match(dirty.v.message, /uncommitted changes/);
  assert.ok(!dirty.r.gh.some((a) => a[0] === 'pr' || a[0] === 'api'));
});

test("after a vouch, the Steward running here is asked for a round now, with its server.json's token; nothing it says fails the vouch", async () => {
  const file = path.join(tmp, 'home', 'server.json');
  rmSync(file, { force: true });
  assert.equal(await askRoundSoon({ fetch: async () => assert.fail('nothing to ask') }), "The Steward's page isn't running on this PC: it merges at its next round instead.");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: 1, port: 21012, token: 'tok', since: '' }));
  const asked: [string, RequestInit][] = [];
  const answer = (status: number, body: unknown) => async (url: any, init: any) => (asked.push([String(url), init]), new Response(JSON.stringify(body), { status }));
  assert.equal(await askRoundSoon({ fetch: answer(200, { started: true, message: "The Steward's round has started." }) as typeof fetch }), "The Steward's round has started.");
  assert.equal(asked[0][0], 'http://127.0.0.1:21012/api/round/soon');
  assert.equal(asked[0][1].method, 'POST');
  assert.equal((asked[0][1].headers as Record<string, string>)['x-token'], 'tok');
  assert.equal(await askRoundSoon({ fetch: answer(403, { error: 'forbidden' }) as typeof fetch }), "The Steward's page answered HTTP 403: it merges at its next round instead.");
  assert.equal(await askRoundSoon({ fetch: (async () => { throw new Error('connect ECONNREFUSED'); }) as typeof fetch }), "The Steward's page didn't answer (connect ECONNREFUSED): it merges at its next round instead.");
});