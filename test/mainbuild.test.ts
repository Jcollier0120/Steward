import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Ran, Runner } from '../src/run.ts';

// Builds release main (stages/mainbuild.ts): main's head is tested once before its release, unless a team member's vouch
// covers that very commit, or the PR head a merge commit brought in unchanged; and a PR the Steward opened itself is
// merged by it. A data folder of its own, a fake employee's git, gh standing in for GitHub.
// By its real path, as git and the work folder (workRootOf) spell it.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-mainbuild-')));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { coveredBy, mainDirOf, mainGate, mainTestedFile, mergeOwn, OWN_MERGE_WAITS_MS, prNumberOf } = await import('../src/stages/mainbuild.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { loadTested } = await import('../src/tested.ts');
const { readJson, writeJson } = await import('../src/kit/store.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const REPO = 'Jcollier0120/Fake';
const byTeam = { context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } };
const statusesOf = (sha: string) => `repos/${REPO}/commits/${sha}/statuses?per_page=100`;

/** gh standing in: each commit's statuses as `statuses` give them (none by default); a status set is taken. */
function github(statuses: Record<string, unknown[]> = {}) {
  return runner((a) => {
    const read = /^repos\/Jcollier0120\/Fake\/commits\/([0-9a-f]{40})\/statuses\?per_page=100$/.exec(a[1] ?? '');
    if (a[0] === 'api' && read) return ok(statuses[read[1]] ?? []);
    if (a[0] === 'api' && a[2] === 'POST') return ok('{}');
  });
}

/** A commit of `file` on the checkout's current branch: its sha. */
function commit(checkout: string, file: string): string {
  mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
  writeFileSync(path.join(checkout, file), `${file}\n`);
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', file);
  return sh(checkout, 'rev-parse', 'HEAD');
}

/**
 * A fake employee whose main has no lockfile (so its checks need no npm here), and a build's context for it: its checks
 * are `fake-checks`, a stand-in that notes where it ran (the folder, and the commit checked out there) and exits with
 * each of `answers` in turn, then 0.
 */
function gateOf(name: string, statuses: Record<string, unknown[]> = {}) {
  const f = fakeEmployee(path.join(tmp, name));
  sh(f.checkout, 'rm', '--quiet', 'package-lock.json');
  sh(f.checkout, 'commit', '--quiet', '-m', 'no lockfile');
  const r = github(statuses);
  const checks: { dir: string; at: string }[] = [];
  const answers: number[] = [];
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== 'fake-checks') return r.run(cmd, args, opts);
    checks.push({ dir: opts!.cwd!, at: sh(opts!.cwd!, 'rev-parse', 'HEAD') });
    const code = answers.shift() ?? 0;
    return code ? { code, out: '', err: 'a test failed' } : ok('all passed');
  };
  const e = employee(f.checkout, { fill: '', test: ['fake-checks'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, name, 'work'), run, neutralDir: tmp });
  const kept = (sha: string) => readJson<Record<string, { ok: boolean; note: string }>>(mainTestedFile(), {})[`fake@${sha}`];
  return { ...f, e, ctx, r, checks, answers, kept, gate: (sha: string, since: string | null = null) => mainGate(ctx, e, sha, since) };
}

test("a PR's number is read from its URL, GitHub's or GitLab's (and Gitea's, Azure DevOps', Bitbucket's); anything else gives none", () => {
  assert.equal(prNumberOf('https://github.com/Jcollier0120/Fake/pull/12'), 12);
  assert.equal(prNumberOf('https://gitlab.com/castellan/fake/-/merge_requests/12'), 12);
  assert.equal(prNumberOf('https://gitea.example.com/castellan/fake/pulls/7'), 7);
  assert.equal(prNumberOf('https://dev.azure.com/castellan/fake/_git/fake/pullrequest/9'), 9);
  assert.equal(prNumberOf('https://bitbucket.org/castellan/fake/pull-requests/5'), 5, "Bitbucket's, as its createPr answers");
  for (const junk of ['', 'https://github.com/Jcollier0120/Fake', 'https://github.com/Jcollier0120/Fake/pull/', 'https://github.com/Jcollier0120/Fake/pull/abc', 'https://github.com/Jcollier0120/Fake/pull/12abc', 'https://github.com/Jcollier0120/Fake/issues/12', 'pull/12', 'no PR was opened']) {
    assert.equal(prNumberOf(junk), null, junk);
  }
});

test('a vouch covers the very commit it is on, or the PR head a merge commit brought in unchanged; nothing else', async () => {
  const f = fakeEmployee(path.join(tmp, 'covered'));
  const e = employee(f.checkout);
  const root = sh(f.checkout, 'rev-parse', 'HEAD');
  // A PR up to date with main, merged with a merge commit: its tree is the PR head's.
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/up-to-date');
  const pr = commit(f.checkout, 'up-to-date.txt');
  sh(f.checkout, 'switch', '--quiet', 'main');
  sh(f.checkout, 'merge', '--quiet', '--no-ff', '-m', 'Merge claude/up-to-date', 'claude/up-to-date');
  const merged = sh(f.checkout, 'rev-parse', 'HEAD');
  // A PR behind main, merged: the merge commit's tree is neither parent's.
  sh(f.checkout, 'switch', '--quiet', '-c', 'claude/behind', root);
  const behind = commit(f.checkout, 'behind.txt');
  sh(f.checkout, 'switch', '--quiet', 'main');
  sh(f.checkout, 'merge', '--quiet', '--no-ff', '-m', 'Merge claude/behind', 'claude/behind');
  const mixed = sh(f.checkout, 'rev-parse', 'HEAD');
  // A plain commit on top of a merge.
  const plain = commit(f.checkout, 'plain.txt');
  const covered = async (statuses: Record<string, unknown[]>, sha: string, r = github(statuses)) => {
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'covered', 'work'), run: r.run, neutralDir: tmp });
    return { by: await coveredBy(ctx, e, sha), asked: r.gh.map((a) => a[1]) };
  };
  const sha = (s: string) => s.slice(0, 7);

  // On the commit itself, by a team member, and its latest word.
  assert.equal((await covered({ [root]: [byTeam] }, root)).by, `Jcollier0120 vouched for ${sha(root)}`);
  assert.equal((await covered({ [root]: [{ ...byTeam, creator: { login: 'stranger' } }] }, root)).by, null, "a stranger's");
  assert.equal((await covered({ [root]: [{ ...byTeam, state: 'failure' }, byTeam] }, root)).by, null, 'a newer failure');
  assert.equal((await covered({ [root]: [{ ...byTeam, context: 'ci/build' }] }, root)).by, null, 'another status');

  // A merge commit: the parent with its very tree, and only that one, is asked.
  const viaPr = await covered({ [pr]: [byTeam] }, merged);
  assert.equal(viaPr.by, `Jcollier0120 vouched for ${sha(pr)}, which ${sha(merged)} merged unchanged`);
  assert.deepEqual(viaPr.asked, [statusesOf(merged), statusesOf(pr)]);
  assert.equal((await covered({ [root]: [byTeam] }, merged)).by, null, "main's parent, whose tree the merge changed");
  assert.equal((await covered({ [merged]: [byTeam], [behind]: [byTeam] }, mixed)).by, null, 'a PR merged while behind main: neither parent has its tree');
  assert.equal((await covered({ [mixed]: [byTeam] }, plain)).by, null, 'a commit after a vouched one');

  // GitHub not answering: no vouch, and never a throw.
  assert.equal((await covered({}, merged, runner(() => ({ code: 1, out: '', err: 'HTTP 502' })))).by, null);
  assert.equal((await covered({}, merged, runner(() => ok('not JSON')))).by, null);
});

test("main's head tested before isn't tested again: main-tested.json says how it went, and GitHub isn't asked", async () => {
  const g = gateOf('kept');
  const passed = commit(g.checkout, 'kept-pass.txt');
  const failed = commit(g.checkout, 'kept-fail.txt');
  const note = `its checks failed here at ${failed.slice(0, 7)}, twice: npm test failed (exit 1)`;
  writeJson(mainTestedFile(), {
    ...readJson<Record<string, unknown>>(mainTestedFile(), {}),
    [`fake@${passed}`]: { ok: true, note: `checks passed here at ${passed.slice(0, 7)}`, at: '2026-10-17T08:00:00.000Z' },
    [`fake@${failed}`]: { ok: false, note, at: '2026-10-17T08:00:00.000Z' },
  });
  assert.equal(await g.gate(passed, '0.4.0'), null);
  assert.equal(await g.gate(failed, '0.4.0'), `${note} (tested before its release; a new commit on main is tested afresh)`);
  assert.deepEqual(g.r.gh, []);
  assert.deepEqual(g.checks, []);
});

test("main's head a team member vouched for is released untested, and nothing is kept for it", async () => {
  const statuses: Record<string, unknown[]> = {};
  const g = gateOf('covered-head', statuses);
  const head = commit(g.checkout, 'covered-head.txt');
  statuses[head] = [byTeam];
  assert.equal(await g.gate(head, '0.4.0'), null);
  assert.deepEqual(g.checks, [], 'its checks never ran');
  assert.ok(g.ctx.lines.includes(`[fake] Jcollier0120 vouched for ${head.slice(0, 7)}: not tested again before its release`), g.ctx.lines.join('\n'));
  assert.equal(g.kept(head), undefined, 'nothing kept for it');
  assert.equal(existsSync(mainDirOf(g.ctx.settings, g.e)), false, 'no worktree made');
  assert.ok(!g.r.gh.some((a) => a[2] === 'POST'), 'no status set');
});

test("main's head no vouch covers is tested once, in a worktree of its own at that commit; a pass is kept, vouched for and recorded", async () => {
  const g = gateOf('pass');
  const head = commit(g.checkout, 'pass.txt');
  const sha = head.slice(0, 7);
  assert.equal(await g.gate(head), null, g.ctx.lines.join('\n'));
  assert.deepEqual(g.checks, [{ dir: mainDirOf(g.ctx.settings, g.e), at: head }]);
  assert.equal(existsSync(mainDirOf(g.ctx.settings, g.e)), false, 'its worktree removed');
  assert.deepEqual([g.kept(head)?.ok, g.kept(head)?.note], [true, `checks passed here at ${sha}`]);
  // Its vouch, so the Assayer doesn't test it again either.
  assert.deepEqual(g.r.gh.find((a) => a[2] === 'POST'), ['api', '-X', 'POST', `repos/${REPO}/statuses/${head}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`, '-f', `description=fake-checks passed in the Steward's build at ${sha}`]);
  // The Surveyor's record of what passed here (tested.ts).
  const t = loadTested().fake?.find((x) => x.commit === head);
  assert.deepEqual([t?.stage, t?.branch], ['build', 'main']);

  // The next build: kept, so neither GitHub nor the checks are asked again.
  const asked = g.r.gh.length;
  assert.equal(await g.gate(head), null);
  assert.equal(g.checks.length, 1);
  assert.equal(g.r.gh.length, asked);
});

test("main's head whose checks fail here twice isn't released: the failure is the reason, kept for that commit; a new commit is tested afresh", async () => {
  const g = gateOf('fail');
  const head = commit(g.checkout, 'fail.txt');
  const sha = head.slice(0, 7);
  g.answers.push(1, 1);
  const why = await g.gate(head);
  assert.equal(why, `its checks failed here at ${sha}, twice: fake-checks failed (exit 1)`);
  assert.equal(g.checks.length, 2, 'once more after a failure, and no more');
  assert.ok(!g.r.gh.some((a) => a[2] === 'POST'), 'no vouch for what failed');
  assert.deepEqual([g.kept(head)?.ok, g.kept(head)?.note], [false, why]);
  assert.equal(loadTested().fake?.find((x) => x.commit === head), undefined);

  // The next build: the same reason, nothing run.
  assert.equal(await g.gate(head), `${why} (tested before its release; a new commit on main is tested afresh)`);
  assert.equal(g.checks.length, 2);

  // Fixed on main: its new head is tested, and passes.
  const fixed = commit(g.checkout, 'fixed.txt');
  assert.equal(await g.gate(fixed), null);
  assert.deepEqual(g.checks.map((c) => c.at), [head, head, fixed]);

  // A failure, then a pass: released, the first failure said.
  const flaky = commit(g.checkout, 'flaky.txt');
  g.answers.push(1);
  assert.equal(await g.gate(flaky), null);
  assert.equal(g.kept(flaky)?.note, `checks passed here at ${flaky.slice(0, 7)} on a second try (the first: fake-checks failed (exit 1))`);
});

test("checks Windows ended (the PC shutting down) fail this build's release, but aren't kept: the next build tests that commit again", async () => {
  const g = gateOf('interrupted');
  const head = commit(g.checkout, 'interrupted.txt');
  g.answers.push(1073807364, 1073807364);
  assert.match((await g.gate(head)) ?? '', /^its checks failed here at [0-9a-f]{7}, twice: fake-checks failed \(exit 1073807364\)$/);
  assert.equal(g.kept(head), undefined);
  assert.equal(await g.gate(head), null);
  assert.equal(g.checks.length, 3);
});

test("a repository Settings give no checks is released untested, as before builds tested main; one worked with plain git is tested here, and gh never run", async () => {
  const g = gateOf('no-checks');
  const head = commit(g.checkout, 'no-checks.txt');
  assert.equal(await mainGate(g.ctx, { ...g.e, test: [] }, head, '0.4.0'), null);
  assert.deepEqual(g.checks, [], 'nothing run');
  assert.ok(g.ctx.lines.includes(`[fake] Settings give ${g.e.name} no checks, so ${head.slice(0, 7)} is released untested`), g.ctx.lines.join('\n'));
  assert.equal(g.kept(head), undefined, 'nothing kept: checks Settings give it later test it');

  const p = gateOf('plain-git');
  const ctx = { ...p.ctx, host: () => 'git' as const };
  const at = commit(p.checkout, 'plain-git.txt');
  assert.equal(await coveredBy(ctx, p.e, at), null);
  assert.equal(await mainGate(ctx, p.e, at, '0.4.0'), null);
  assert.equal(p.checks.length, 1, 'tested here');
  assert.equal(p.kept(at)?.ok, true);
  assert.deepEqual(p.r.gh, [], 'no status read or set');
});

test('a PR the Steward opened itself is merged by it at its head, its branch deleted; a refusal is asked again after each wait, a head that moved gives up at once', async () => {
  const e = employee(tmp);
  const head = 'a'.repeat(40);
  const go = async (answers: Ran[] | (() => never)) => {
    const r = runner((a) => (a[0] === 'pr' && a[1] === 'merge' ? (typeof answers === 'function' ? answers() : (answers.shift() ?? ok(''))) : undefined));
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'own'), run: r.run, neutralDir: tmp });
    const pauses: number[] = [];
    ctx.pause = async (ms) => void pauses.push(ms);
    const why = await mergeOwn(ctx, e, { number: 12, head });
    return { why, merges: r.gh.filter((a) => a[1] === 'merge'), pauses, lines: ctx.lines };
  };

  const merged = await go([]);
  assert.equal(merged.why, null);
  assert.deepEqual(merged.merges, [['pr', 'merge', '12', '--repo', REPO, '--merge', '--match-head-commit', head, '--delete-branch']]);
  assert.deepEqual(merged.pauses, []);
  assert.ok(merged.lines.includes('[fake] merged its own #12 (aaaaaaa)'), merged.lines.join('\n'));

  // GitHub still working out whether a PR just opened merges: asked again after each wait.
  const notYet = { code: 1, out: '', err: 'GraphQL: Pull Request is not mergeable (mergePullRequest)\n' };
  const later = await go([notYet, notYet]);
  assert.equal(later.why, null);
  assert.equal(later.merges.length, 3);
  assert.deepEqual(later.pauses, OWN_MERGE_WAITS_MS.slice(0, 2));

  const never = await go([notYet, notYet, notYet, notYet, notYet]);
  assert.equal(never.why, "GitHub wouldn't merge #12: GraphQL: Pull Request is not mergeable (mergePullRequest)");
  assert.equal(never.merges.length, 1 + OWN_MERGE_WAITS_MS.length);
  assert.deepEqual(never.pauses, OWN_MERGE_WAITS_MS);

  // Someone pushed to it: theirs to merge now, so no second ask.
  for (const err of ['GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)', "GraphQL: expected head sha didn't match current head ref (mergePullRequest)"]) {
    const moved = await go([{ code: 1, out: '', err }]);
    assert.equal(moved.why, `GitHub wouldn't merge #12: ${err}`);
    assert.equal(moved.merges.length, 1, err);
    assert.deepEqual(moved.pauses, [], err);
  }

  // gh that won't even start: a reason, never a throw.
  const broken = await go(() => {
    throw new Error('spawn gh ENOENT');
  });
  assert.equal(broken.why, "GitHub wouldn't merge #12: spawn gh ENOENT");
});

test("a merge GitHub carries out from the Steward's ask is its own, whatever it answered; one being merged is looked at, not asked for again (Thatcher#99, 2026-10-30)", async () => {
  const { loadActed } = await import('../src/strangers.ts');
  const inProgress: Ran = { code: 1, out: '', err: 'GraphQL: Merge already in progress (mergePullRequest)\n' };
  const notYet: Ran = { code: 1, out: '', err: 'GraphQL: Pull Request is not mergeable (mergePullRequest)\n' };
  /** A kit PR's head, committed on a branch of the fake's own and pushed there; and on origin's main too when `landed`. */
  const prOf = (name: string, landed: boolean) => {
    const f = fakeEmployee(path.join(tmp, name));
    const e = employee(f.checkout, { repo: `Jcollier0120/${name}` });
    sh(f.checkout, 'switch', '--quiet', '-c', 'steward/kit-2.144.2');
    const head = commit(f.checkout, `${name}.txt`);
    sh(f.checkout, 'push', '--quiet', 'origin', `${head}:refs/heads/steward/kit-2.144.2`, ...(landed ? [`${head}:refs/heads/main`] : []));
    sh(f.checkout, 'switch', '--quiet', 'main');
    return { e, head };
  };
  /** mergeOwn with gh answering each merge from `merges`, each view from `views` (none: gh can't say), in turn. */
  const go = async (e: ReturnType<typeof employee>, head: string, merges: Ran[], views: unknown[] = []) => {
    const r = runner((a) => {
      if (a[0] === 'pr' && a[1] === 'merge') return merges.shift() ?? ok('');
      if (a[0] === 'pr' && a[1] === 'view' && views.length) return ok(views.shift());
    });
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'own'), run: r.run, neutralDir: tmp });
    const pauses: number[] = [];
    ctx.pause = async (ms) => void pauses.push(ms);
    const why = await mergeOwn(ctx, e, { number: 99, head });
    return { why, merges: r.gh.filter((a) => a[1] === 'merge').length, pauses, lines: ctx.lines };
  };
  const key = (e: ReturnType<typeof employee>) => `${e.repo}#99`;

  // Every ask answered "already in progress", while its head is on main already: merged, by this Steward, at the first look.
  const onMain = prOf('Thatcher', true);
  const thatcher = await go(onMain.e, onMain.head, [inProgress, inProgress, inProgress, inProgress]);
  assert.equal(thatcher.why, null);
  assert.equal(thatcher.merges, 1, 'asked once');
  assert.deepEqual(thatcher.pauses, []);
  assert.ok(thatcher.lines.includes(`[fake] merged its own #99 (${onMain.head.slice(0, 7)}): GitHub answered "GraphQL: Merge already in progress (mergePullRequest)", and merged it`), thatcher.lines.join('\n'));
  assert.ok(key(onMain.e) in loadActed().merged, 'noted as merged here');
  assert.deepEqual(loadActed().asked[key(onMain.e)]?.head, onMain.head, 'and as asked, at its head');

  // Being merged, not on main yet: looked at after each wait, not asked again, until GitHub says merged at its head.
  const later = prOf('Later', false);
  const open = { state: 'OPEN', headRefOid: later.head };
  const done = await go(later.e, later.head, [inProgress], [open, open, { state: 'MERGED', headRefOid: later.head }]);
  assert.equal(done.why, null);
  assert.equal(done.merges, 1);
  assert.deepEqual(done.pauses, OWN_MERGE_WAITS_MS.slice(0, 2));
  assert.ok(key(later.e) in loadActed().merged);

  // Still being merged after the last wait: said so, never asked again; the ask kept, for the round that finds it merged.
  const slow = prOf('Slow', false);
  const still = await go(slow.e, slow.head, [inProgress, ok('')]);
  assert.equal(still.why, 'GitHub is merging #99 still: GraphQL: Merge already in progress (mergePullRequest)');
  assert.equal(still.merges, 1, 'never asked again');
  assert.deepEqual(still.pauses, OWN_MERGE_WAITS_MS);
  assert.equal(key(slow.e) in loadActed().merged, false);
  assert.equal(loadActed().asked[key(slow.e)]?.head, slow.head);

  // A refusal, but GitHub says it is merged at the head asked for: merged. Merged at another head: someone else's push.
  const refused = prOf('Refused', false);
  assert.equal((await go(refused.e, refused.head, [notYet], [{ state: 'MERGED', headRefOid: refused.head }])).why, null);
  const pushed = prOf('Pushed', false);
  const other = await go(pushed.e, pushed.head, [notYet, notYet, notYet, notYet], [{ state: 'MERGED', headRefOid: 'b'.repeat(40) }]);
  assert.equal(other.why, "GitHub wouldn't merge #99: GraphQL: Pull Request is not mergeable (mergePullRequest)");
  assert.equal(other.merges, 1 + OWN_MERGE_WAITS_MS.length);
  assert.equal(key(pushed.e) in loadActed().asked, false, 'a refusal is no ask GitHub took up');
});
