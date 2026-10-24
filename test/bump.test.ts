import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The bump stage on a fake employee made with git in a temporary folder: a worktree of origin's main,
// kit.json and the version changed there, its kit filled and its checks run, then a commit; and push,
// with gh standing in. The version a bump sets is claimed (claims.ts), in a Steward home of the test's own.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-bump-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
process.env.STEWARD_HOME = path.join(tmp, 'home');

const { bumpBranch } = await import('../src/stages/common.ts');
const { bumpOne, kitBumpEntry, onlyFlaky, repin, replacingEntry, wholeTestSteps } = await import('../src/stages/bump.ts');
const { prBody, push, pushOne } = await import('../src/stages/push.ts');
const { claimsFile, loadClaims } = await import('../src/claims.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type GhScript = Parameters<typeof runner>[0];

/** GitHub as a bump's claim reads it: no release of the agent's yet, and the open PRs `titles` (none by default). */
const claimGh = (titles: { title: string; headRefName: string }[] = []): NonNullable<GhScript> => (a) => {
  if (a[0] === 'release' && a[1] === 'list') return ok([]);
  if (a[0] === 'pr' && a[1] === 'list') return ok(titles);
};
const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');

/** A kit tree at 1.0.1, as a kit release would hold it. */
const kitFrom = path.join(tmp, 'kit-1.0.1');
mkdirSync(path.join(kitFrom, 'node'), { recursive: true });
writeFileSync(path.join(kitFrom, 'node', 'npu.ts'), 'export const npu = 1;\n');
writeFileSync(path.join(kitFrom, 'VERSION'), '1.0.1\n');

let n = 0;
function setup(o: Parameters<typeof fakeEmployee>[1] = {}, more: Parameters<typeof employee>[1] = {}) {
  const dir = path.join(tmp, `case-${++n}`);
  rmSync(claimsFile(), { force: true }); // each case's Fake is a repository of its own
  const f = fakeEmployee(dir, { ...o, files: { 'tools/kit.ts': kitTool, ...o.files } });
  const r = runner(claimGh());
  const e = employee(f.checkout, more);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, released: ['1.0.1'], neutralDir: dir });
  return { ...f, e, ctx, r, dir, work: path.join(dir, 'work', 'fake') };
}

test('a bump: a worktree of origin/main on steward/kit-<version>, kit.json and the version changed, the kit filled, checks run, committed', async () => {
  const s = setup();
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', `${res.message}\n${s.ctx.lines.join('\n')}`);
  assert.equal(res.version, '0.4.1');
  const branch = bumpBranch('1.0.1');
  assert.equal(branch, 'steward/kit-1.0.1');
  // The commit: exactly kit.json, the three version files and the changelog, started with the new version's entry.
  assert.deepEqual(sh(s.checkout, 'diff', '--name-only', 'origin/main', branch).split('\n').sort(), ['CHANGELOG.md', 'kit.json', 'package-lock.json', 'package.json', 'src/app.ts']);
  const log = sh(s.checkout, 'show', `${branch}:CHANGELOG.md`).replace(/\r\n/g, '\n');
  assert.match(log, /^# Fake's changelog\n/);
  assert.match(log, /\n## 0\.4\.1\n\n\*\*It carries the Steward's kit 1\.0\.1: /);
  assert.match(log, /### What changed\n\n- The Steward's kit 1\.0\.1, after 1\.0\.0: the parts every agent of the manor shares\./);
  assert.doesNotMatch(log, /Jcollier0120|Steward\.git|github\.com/i, "no repository's name in notes the agent ships");
  assert.match(log, /### Before you update\n\nNothing: it updates itself as usual\.$/);
  assert.equal(sh(s.checkout, 'show', `${branch}:kit.json`), '{\n  "kit": "1.0.1",\n  "parts": ["node"]\n}');
  assert.match(sh(s.checkout, 'show', `${branch}:src/app.ts`), /version: '0\.4\.1'/);
  assert.equal(JSON.parse(sh(s.checkout, 'show', `${branch}:package-lock.json`)).packages[''].version, '0.4.1');
  assert.equal(sh(s.checkout, 'log', '-1', '--format=%s', branch), "Fake 0.4.1: the Steward's kit 1.0.1");
  // The worktree has the kit it was checked with; the person's checkout is as it was.
  assert.equal(readFileSync(path.join(s.work, 'src', 'kit', 'VERSION'), 'utf8').trim(), '1.0.1');
  assert.equal(sh(s.checkout, 'branch', '--show-current'), 'main');
  assert.equal(sh(s.checkout, 'status', '--porcelain'), '');
  assert.equal(readFileSync(path.join(s.checkout, 'kit.json'), 'utf8').includes('1.0.0'), true);
  // Again, before it's pushed: made afresh, not stacked.
  const again = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(again.outcome, 'done', again.message);
  assert.equal(sh(s.checkout, 'rev-list', '--count', `origin/main..${branch}`), '1');
});

test("a rollout's bump the kit reaches nothing in is still made, its checks but no tests run; a trial's isn't tried", async () => {
  const s = setup();
  const pins: unknown[] = [];
  const reach = async (_e: unknown, pin: { kit: string; parts: string[] | null }) => (pins.push(pin), { none: 'nothing it takes from the kit (node, core, spec) changes from 1.0.0' });
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom, reach });
  assert.equal(res.outcome, 'done', `${res.message}\n${s.ctx.lines.join('\n')}`);
  assert.deepEqual(pins, [{ kit: '1.0.0', parts: ['node'] }], 'asked from the kit its branch pins');
  assert.ok(s.ctx.lines.some((l) => l.includes('no tests for the kit: nothing it takes')), s.ctx.lines.join('\n'));
  const tried = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom, reach, trial: true, base: 'origin/main' });
  assert.equal(tried.outcome, 'skipped');
  assert.match(tried.message, /not tried, nothing it takes/);
});

test('push: the branch goes to origin (never forced) and a PR is opened with the title and the changelog', async () => {
  const s = setup();
  assert.equal((await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom })).outcome, 'done');
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([]);
    if (args[0] === 'pr' && args[1] === 'create') return ok('https://github.com/Jcollier0120/Fake/pull/7\n');
  });
  const ctx = { ...s.ctx, run: r.run };
  const changelog = '## 1.0.1\n\n- the fix\n\n## 1.0.0\n\n- the first\n';
  const res = await pushOne(ctx, s.e, { kit: '1.0.1', changelog });
  assert.equal(res.outcome, 'done', res.message);
  assert.equal(res.url, 'https://github.com/Jcollier0120/Fake/pull/7');
  assert.equal(sh(s.origin, 'rev-parse', 'refs/heads/steward/kit-1.0.1'), sh(s.checkout, 'rev-parse', 'steward/kit-1.0.1'));
  const create = r.gh.find((a) => a[1] === 'create')!;
  assert.equal(create[create.indexOf('--title') + 1], "Fake 0.4.1: the Steward's kit 1.0.1");
  assert.equal(create[create.indexOf('--base') + 1], 'main');
  const body = create[create.indexOf('--body-file') + 1];
  assert.match(body, /## 1\.0\.1\n\n- the fix/);
  assert.doesNotMatch(body, /the first/, 'only the entries after the kit it had');
  // Pushed again with nothing new: no second PR.
  const r2 = runner((args) => (args[1] === 'list' ? ok([{ number: 7, url: 'https://github.com/Jcollier0120/Fake/pull/7' }]) : undefined));
  const again = await pushOne({ ...s.ctx, run: r2.run }, s.e, { kit: '1.0.1', changelog });
  assert.match(again.message, /#7 was already open/);
  assert.ok(!r2.gh.some((a) => a[1] === 'create'));
});

/** GitHub's PRs for a branch, by state (none by default), `create` answering `pr create`; everything else as a bump's claim reads it. */
const prsGh = (byState: Partial<Record<'open' | 'closed' | 'merged', unknown[]>> = {}, create?: (args: string[]) => ReturnType<typeof ok>): NonNullable<GhScript> => (a) => {
  if (a[0] === 'pr' && a[1] === 'list' && a.includes('--head')) return ok(byState[a[a.indexOf('--state') + 1] as 'open'] ?? []);
  if (a[0] === 'pr' && a[1] === 'create' && create) return create(a);
  return claimGh()(a);
};
const cutShort = { code: 1, out: '', err: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com' };
const asked = (gh: string[][]) => gh.filter((a) => a[0] === 'pr' && a[1] === 'list' && a.includes('--head')).map((a) => a[a.indexOf('--state') + 1]);
const BRANCH = 'steward/kit-1.0.1';

/** A bump made and pushed to origin, as the push stage left it when `gh pr create` failed: its commit on origin, no PR for it. */
async function pushedBump(s: ReturnType<typeof setup>): Promise<string> {
  assert.equal((await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom })).outcome, 'done');
  sh(s.checkout, 'push', '--quiet', 'origin', BRANCH);
  return sh(s.checkout, 'rev-parse', BRANCH);
}

/** A bump branch on origin made by hand, with no bump run: one commit on origin/main, kit.json pinned to 1.0.1 unless `edit` makes it otherwise; force-pushed over any before it, none of that name here. */
function handBranch(s: ReturnType<typeof setup>, edit = (dir: string) => writeFileSync(path.join(dir, 'kit.json'), repin(readFileSync(path.join(dir, 'kit.json'), 'utf8'), '1.0.1'))): string {
  sh(s.checkout, 'switch', '--quiet', '-c', 'by-hand', 'origin/main');
  edit(s.checkout);
  sh(s.checkout, 'add', '-A');
  sh(s.checkout, 'commit', '--quiet', '--allow-empty', '-m', 'by hand');
  sh(s.checkout, 'push', '--quiet', '--force', 'origin', `by-hand:refs/heads/${BRANCH}`);
  const head = sh(s.checkout, 'rev-parse', 'by-hand');
  sh(s.checkout, 'switch', '--quiet', 'main');
  sh(s.checkout, 'branch', '--quiet', '-D', 'by-hand');
  return head;
}
/** A commit on top of `parent` with its tree, made without a worktree. */
const onTopOf = (s: ReturnType<typeof setup>, parent: string, message: string) => sh(s.checkout, 'commit-tree', '-p', parent, '-m', message, `${parent}^{tree}`);

test('a branch on origin whose PR exists, open, closed or merged, is never bumped again: its PR comes first', async () => {
  // A branch the Steward would take for its own bump, were it not for its PR.
  const s = setup();
  const head = handBranch(s);
  for (const state of ['open', 'closed', 'merged'] as const) {
    const r = runner(prsGh({ [state]: [{ number: 9 }] }));
    const res = await bumpOne({ ...s.ctx, run: r.run }, s.e, { kit: '1.0.1', kitFrom });
    assert.equal(res.outcome, 'refused', state);
    assert.match(res.message, /already on origin: merge or close its PR first/);
    assert.ok(!r.gh.some((a) => a[1] === 'create'), state);
    assert.equal(sh(s.origin, 'rev-parse', `refs/heads/${BRANCH}`), head, 'left as it was');
  }
});

test("a bump branch on origin with no PR at all, whose head is the Steward's own bump, gets its PR from the push stage: nothing is made again nor pushed", async () => {
  const s = setup();
  const head = await pushedBump(s);
  const r = runner(prsGh());
  const bumped = await bumpOne({ ...s.ctx, run: r.run }, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(bumped.outcome, 'done', bumped.message);
  assert.match(bumped.message, /^steward\/kit-1\.0\.1 \(.{7}\) was on origin with no PR: its PR is opened now$/);
  assert.equal(bumped.commit, head.slice(0, 7));
  assert.equal(bumped.version, '0.4.1');
  assert.deepEqual(asked(r.gh), ['open', 'closed', 'merged'], 'no PR in any state');
  assert.equal(sh(s.checkout, 'rev-parse', BRANCH), head, 'not made again');
  // The push stage carries on: its PR opened, its branch as origin has it.
  const p = runner(prsGh({}, () => ok('https://github.com/Jcollier0120/Fake/pull/7\n')));
  const pushed = await pushOne({ ...s.ctx, run: p.run }, s.e, { kit: '1.0.1', changelog: null });
  assert.equal(pushed.outcome, 'done', pushed.message);
  assert.equal(pushed.url, 'https://github.com/Jcollier0120/Fake/pull/7');
  assert.equal(p.gh.filter((a) => a[1] === 'create').length, 1);
  assert.equal(sh(s.origin, 'rev-parse', `refs/heads/${BRANCH}`), head);
});

test("a bump branch on origin with no PR that this PC no longer has (its work folder cleared, or another PC's) is put back here at origin's commit, and opened", async () => {
  const s = setup();
  const head = await pushedBump(s);
  sh(s.checkout, 'worktree', 'remove', '--force', s.work);
  sh(s.checkout, 'branch', '-D', BRANCH);
  const r = runner(prsGh());
  const bumped = await bumpOne({ ...s.ctx, run: r.run }, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(bumped.outcome, 'done', bumped.message);
  assert.equal(sh(s.checkout, 'rev-parse', BRANCH), head);
  const p = runner(prsGh({}, () => ok('https://github.com/Jcollier0120/Fake/pull/8\n')));
  const pushed = await pushOne({ ...s.ctx, run: p.run }, s.e, { kit: '1.0.1', changelog: null });
  assert.match(pushed.message, /^opened "Fake 0\.4\.1: the Steward's kit 1\.0\.1"/);
});

test("a bump branch on origin with no PR that has moved past main, or has a commit that isn't the Steward's bump, is still refused", async () => {
  // One fake, its branch on origin made again by hand for each.
  const s = setup();
  const refused = async (why: string) => {
    const r = runner(prsGh());
    const res = await bumpOne({ ...s.ctx, run: r.run }, s.e, { kit: '1.0.1', kitFrom });
    assert.equal(res.outcome, 'refused', why);
    assert.match(res.message, /already on origin: merge or close its PR first/, why);
    assert.deepEqual(asked(r.gh), ['open', 'closed', 'merged'], why);
    assert.ok(!r.gh.some((a) => a[1] === 'create'), why);
  };
  // A commit that isn't a bump: one on top of main, from a person.
  const person = (dir: string) => writeFileSync(path.join(dir, 'extra.txt'), 'a person\n');
  handBranch(s, person);
  await refused("a commit that doesn't pin the kit");
  handBranch(s, (dir) => (person(dir), writeFileSync(path.join(dir, 'kit.json'), repin(readFileSync(path.join(dir, 'kit.json'), 'utf8'), '1.0.1'))));
  await refused('a commit that pins the kit and changes more than a bump does');
  // A commit of someone else's on the bump's (this PC's own branch is as the bump made it).
  const bump = handBranch(s);
  sh(s.checkout, 'branch', '--quiet', BRANCH, bump);
  sh(s.checkout, 'push', '--quiet', '--force', 'origin', `${onTopOf(s, bump, 'a person adds to it')}:refs/heads/${BRANCH}`);
  await refused("someone else's commit on it");
  sh(s.checkout, 'branch', '--quiet', '-D', BRANCH);
  // Main moved on since the bump: the branch isn't on top of it any more.
  handBranch(s);
  sh(s.checkout, 'commit', '--quiet', '--allow-empty', '-m', "someone's commit on main");
  sh(s.checkout, 'push', '--quiet', 'origin', 'main');
  await refused('main moved on');
});

test("GitHub out of reach to ask whether a bump branch on origin has a PR is a wait, not a refusal; any other answer it won't give is told", async () => {
  const s = setup();
  handBranch(s);
  const down = runner((a) => (a[1] === 'list' && a.includes('--head') ? cutShort : claimGh()(a)));
  const res = await bumpOne({ ...s.ctx, run: down.run }, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'skipped', res.message);
  assert.equal(res.again, true);
  assert.match(res.message, /^steward\/kit-1\.0\.1 is on origin, and GitHub couldn't be reached to see whether it has a PR \(.*error connecting to api\.github\.com.*\): the next round looks again$/);
  const odd = runner((a) => (a[1] === 'list' && a.includes('--head') ? { code: 1, out: '', err: 'HTTP 403: Resource not accessible' } : claimGh()(a)));
  const refused = await bumpOne({ ...s.ctx, run: odd.run }, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(refused.outcome, 'refused');
  assert.match(refused.message, /already on origin: merge or close its PR first.*GitHub wouldn't say whether it has one \(.*HTTP 403/);
});

test('a push the network cuts short is a wait the next round tries again, not a failure; another failure still is one', async () => {
  const s = setup();
  assert.equal((await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom })).outcome, 'done');
  // The branch gets to origin, and then gh can't reach GitHub to open its PR: as on 2026-10-21.
  const down = runner(prsGh({}, () => cutShort));
  const [cut] = await push({ ...s.ctx, run: down.run }, [s.e], { kit: '1.0.1', changelog: null });
  assert.equal(cut.outcome, 'skipped', cut.message);
  assert.equal(cut.again, true);
  assert.match(cut.message, /^steward\/kit-1\.0\.1 waits for the network \(.*error connecting to api\.github\.com.*\): the next round tries again$/);
  assert.equal(sh(s.origin, 'rev-parse', `refs/heads/${BRANCH}`), sh(s.checkout, 'rev-parse', BRANCH), 'pushed');
  // Listing the PRs cut short is the same.
  const [list] = await push({ ...s.ctx, run: runner((a) => (a[0] === 'pr' && a[1] === 'list' ? cutShort : undefined)).run }, [s.e], { kit: '1.0.1', changelog: null });
  assert.equal(list.outcome, 'skipped', list.message);
  // GitHub refusing it is no network: a failure, as before.
  const [refused] = await push({ ...s.ctx, run: runner(prsGh({}, () => ({ code: 1, out: '', err: 'HTTP 422: Validation Failed' }))).run }, [s.e], { kit: '1.0.1', changelog: null });
  assert.equal(refused.outcome, 'failed', refused.message);
  assert.match(refused.message, /HTTP 422/);
});

// A test runner's TAP: the failed test is far above the last lines a log keeps.
const tap = [
  'TAP version 13',
  '# Subtest: the first',
  'ok 1 - the first',
  '# Subtest: each request came after its warm-up',
  'not ok 2 - each request came after its warm-up',
  '  ---',
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    each request came after its warm-up',
  '    ',
  '    5 !== 8',
  '    ',
  "  code: 'ERR_ASSERTION'",
  '  ...',
  ...Array.from({ length: 40 }, (_, i) => `ok ${i + 3} - later ${i}`),
  '# fail 1',
].join('\n');

test("a failure's message names the failed tests and their errors, the worktree left for a look and nothing committed; a test that fails once and then passes doesn't stop the bump", async () => {
  const failing = setup({ files: { 'tap.mjs': `console.log(${JSON.stringify(tap)}); process.exit(1);\n` } }, { test: ['node tap.mjs'] });
  const res = await bumpOne(failing.ctx, failing.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'failed');
  assert.match(res.message, /^node tap\.mjs failed \(exit 1\): "each request came after its warm-up" \(each request came after its warm-up: 5 !== 8\), twice; the worktree is left at .*, the failed step's whole output in .*fake\.log$/);
  assert.ok(failing.ctx.lines.some((l) => l.endsWith('failed: each request came after its warm-up (each request came after its warm-up: 5 !== 8)')));
  assert.equal(sh(failing.checkout, 'rev-list', '--count', 'origin/main..steward/kit-1.0.1'), '0', 'nothing committed');
  assert.ok(existsSync(path.join(failing.work, 'kit.json')), 'the worktree is left');
  assert.match(readFileSync(`${failing.work}.log`, 'utf8'), /^node tap\.mjs \(exit 1\)/);

  // Fails the first time it's run in this worktree, then passes.
  const flaky = `import { existsSync, writeFileSync } from 'node:fs';\nif (!existsSync('.ran')) { writeFileSync('.ran', ''); console.log(${JSON.stringify(tap)}); process.exit(1); }\n`;
  const s = setup({ files: { 'flaky.mjs': flaky } }, { test: ['node flaky.mjs'] });
  const ok2 = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(ok2.outcome, 'done', ok2.message);
  assert.match(ok2.message, /checks passed on a second try \(the first: node flaky\.mjs failed \(exit 1\): "each request came after its warm-up"/);
  assert.match(sh(s.checkout, 'log', '-1', '--format=%b', 'steward/kit-1.0.1'), /Its checks passed on a second try; the first failed: node flaky\.mjs/);
  assert.ok(existsSync(`${s.work}.log`), "the first try's output stays");
  // Bumped again from scratch: the old output goes with the old worktree.
  const s2 = await bumpOne(s.ctx, { ...s.e, test: ['node -e 0'] }, { kit: '1.0.1', kitFrom });
  assert.equal(s2.outcome, 'done', s2.message);
  assert.ok(!existsSync(`${s.work}.log`));
});

test('already on the kit: skipped; not taking the kit: skipped; no kit.json: refused', async () => {
  const on = setup({ kit: '1.0.1' });
  assert.deepEqual([(await bumpOne(on.ctx, on.e, { kit: '1.0.1' })).outcome], ['skipped']);
  const reeve = setup({}, { usesKit: false });
  const r = await bumpOne(reeve.ctx, reeve.e, { kit: '1.0.1' });
  assert.equal(r.outcome, 'skipped');
  assert.equal(r.message, 'not using the kit yet');
  const none = setup({ kit: null });
  assert.match((await bumpOne(none.ctx, none.e, { kit: '1.0.1' })).message, /has no kit\.json/);
  // Every hire took the kit long ago: the old kit's files are never looked for, in a hire or anyone else.
  const own = setup({ kit: null, files: { 'src/npu.ts': 'export {}', 'tools/release.ts': '' } }, { id: 'porter', name: 'Porter' });
  const o = await bumpOne(own.ctx, own.e, { kit: '1.0.1' });
  assert.deepEqual([o.outcome, o.message], ['refused', 'origin/main has no kit.json']);
});

test("Reeve's own files at the old kit's paths don't stop its bump", async () => {
  const own = ['src/accelerators.ts', 'src/duty.ts', 'src/install.ts', 'tools/release.ts', 'test/accelerators.test.ts', 'test/install.test.ts'];
  const s = setup(
    { version: '0.3.0', files: { ...Object.fromEntries(own.map((p) => [p, `// Reeve's own ${p}\n`])), 'src/mcp.ts': "export const SERVER = { name: 'reeve', version: '0.3.0' };\n" } },
    { id: 'reeve', name: 'Reeve', versionFiles: ['package.json', 'package-lock.json', 'src/mcp.ts'] },
  );
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', `${res.message}\n${s.ctx.lines.join('\n')}`);
  assert.equal(res.version, '0.3.1');
  assert.deepEqual(sh(s.checkout, 'diff', '--name-only', 'origin/main', 'steward/kit-1.0.1').split('\n').sort(), ['CHANGELOG.md', 'kit.json', 'package-lock.json', 'package.json', 'src/mcp.ts']);
  for (const p of own) assert.equal(sh(s.checkout, 'show', `steward/kit-1.0.1:${p}`), `// Reeve's own ${p}`, `${p} is still there`);
});

test("tools/kit.ts rides with the pin: an agent's old one is replaced with the Steward's before its kit is filled, and committed", async () => {
  // An old tools/kit.ts that can't fill anything: the bump must not run it.
  const s = setup({ files: { 'tools/kit.ts': "console.error('the old tool'); process.exit(9);\n" } });
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', `${res.message}\n${s.ctx.lines.join('\n')}`);
  assert.match(res.message, /tools\/kit\.ts updated/);
  const branch = 'steward/kit-1.0.1';
  assert.deepEqual(sh(s.checkout, 'diff', '--name-only', 'origin/main', branch).split('\n').sort(), ['CHANGELOG.md', 'kit.json', 'package-lock.json', 'package.json', 'src/app.ts', 'tools/kit.ts']);
  assert.equal(sh(s.checkout, 'show', `${branch}:tools/kit.ts`), kitTool.replace(/\r\n/g, '\n').trimEnd(), "the Steward's own, byte for byte (LF)");
  assert.match(sh(s.checkout, 'log', '-1', '--format=%b', branch), /tools\/kit\.ts is the Steward's\./);
  assert.equal(readFileSync(path.join(s.work, 'src', 'kit', 'VERSION'), 'utf8').trim(), '1.0.1', 'the new tool filled the kit');
  // push says so in the PR.
  const r = runner((args) => (args[1] === 'list' ? ok([]) : args[1] === 'create' ? ok('https://github.com/Jcollier0120/Fake/pull/8\n') : undefined));
  assert.equal((await pushOne({ ...s.ctx, run: r.run }, s.e, { kit: '1.0.1', changelog: null })).outcome, 'done');
  const create = r.gh.find((a) => a[1] === 'create')!;
  const body = create[create.indexOf('--body-file') + 1];
  assert.match(body, /the version is 0\.4\.1 in package\.json, package-lock\.json, src\/app\.ts\. tools\/kit\.ts is the Steward's/);
});

test("an agent that doesn't fill with tools/kit.ts gets none; with no tools/kit.ts to hand out, a Node agent is refused", async () => {
  const other = setup({}, { fill: 'node -e process.exit(0)' });
  const res = await bumpOne(other.ctx, other.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', res.message);
  assert.doesNotMatch(res.message, /tools\/kit\.ts/);
  const none = setup();
  const r = await bumpOne(none.ctx, none.e, { kit: '1.0.1', kitFrom, tool: path.join(tmp, 'no-such-kit.ts') });
  assert.equal(r.outcome, 'refused');
  assert.match(r.message, /has no tools\/kit\.ts to hand out/);
});

test("version files that disagree stop a bump before anything is run", async () => {
  const s = setup({ files: { 'src/app.ts': "export const APP = { version: '0.3.9' };\n" } });
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'failed');
  assert.match(res.message, /disagree/);
});

test('kit.json keeps its parts and anything else when its pin moves; the PR body says where the kit comes from', () => {
  assert.equal(repin('{"kit":"1.0.0","parts":["node","spec"],"note":"x"}', '1.1.0'), '{\n  "kit": "1.1.0",\n  "parts": ["node", "spec"],\n  "note": "x"\n}\n');
  const body = prBody({ kit: '1.1.0', from: '1.0.0', version: '0.4.2', changelog: null, files: ['kit.json', 'package.json'], fill: 'node tools/kit.ts' });
  assert.match(body, /`node tools\/kit\.ts` fills it from the kit release kit-v1\.1\.0/);
  assert.match(body, /See the Steward's kit\/CHANGELOG\.md for 1\.1\.0/);
});

test("a bump's changelog entry: each kit version's headline since the one it pinned, and their Before you update", () => {
  const kitLog = [
    '## 1.0.3',
    '',
    '**Pages use the whole window.** More.',
    '',
    '## 1.0.2',
    '',
    '**Offline is waited out.** More.',
    '',
    '### Before you update',
    '',
    '- Close its page first.',
    '',
    '## 1.0.1',
    '',
    '**Already had.**',
    '',
  ].join('\n');
  const e = kitBumpEntry({ version: '0.4.7', from: '1.0.1', kit: '1.0.3', changelog: kitLog });
  assert.equal(
    e,
    [
      '## 0.4.7',
      '',
      "**It carries the Steward's kit 1.0.3: the parts every agent of the manor shares.**",
      '',
      '### What changed',
      '',
      "- The Steward's kit 1.0.3: Pages use the whole window.",
      "- The Steward's kit 1.0.2: Offline is waited out.",
      '',
      '### Before you update',
      '',
      '- Close its page first.',
    ].join('\n'),
  );
  // A kit entry whose Before you update is "Nothing" adds nothing to it.
  assert.match(kitBumpEntry({ version: '0.4.7', from: '1.0.2', kit: '1.0.3', changelog: kitLog.replace('**Pages use the whole window.** More.', '**Pages.**\n\n### Before you update\n\nNothing: it updates itself as usual.') }), /### Before you update\n\nNothing: it updates itself as usual\.$/);
  assert.match(kitBumpEntry({ version: '0.4.7', from: '1.0.3', kit: '1.0.1', changelog: kitLog }), /a step back[\s\S]*- A step back to the Steward's kit 1\.0\.1, from 1\.0\.3\./);
});

test("a bump's version is claimed: above an open PR's (an agent's own work beside it) and every live claim, the same again when made again", async () => {
  rmSync(claimsFile(), { force: true });
  const s = setup();
  const titles = [{ title: 'Fake 0.4.1: Developer options', headRefName: 'claude/developer-options' }];
  const ctx = { ...s.ctx, run: runner(claimGh(titles)).run };
  const res = await bumpOne(ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', res.message);
  assert.equal(res.version, '0.4.2', 'not the open PR\'s 0.4.1');
  assert.match(sh(s.checkout, 'show', 'steward/kit-1.0.1:package.json'), /"version": "0\.4\.2"/);
  assert.deepEqual(loadClaims().map((c) => [c.version, c.branch, c.by]), [['0.4.2', 'steward/kit-1.0.1', 'steward']]);
  const again = await bumpOne(ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(again.version, '0.4.2', 'its own claim again');
  // GitHub out of reach: no version can be claimed, so no bump (the next patch could be another PR's).
  rmSync(claimsFile(), { force: true });
  const offline = await bumpOne({ ...s.ctx, run: runner().run }, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(offline.outcome, 'failed');
  assert.match(offline.message, /^couldn't claim a version for the bump: /);
});

test('a fold whose PR merged or closed meanwhile is pushed nowhere', async () => {
  const s = setup();
  const was = handBranch(s);
  const folds = { fake: { number: 7, head: 'steward/kit-1.0.1', kit: '1.0.1' } };
  // A commit on the PR's branch here, as a fold's bump leaves it.
  sh(s.checkout, 'branch', '--quiet', BRANCH, onTopOf(s, was, 'more'));
  const r = runner((a) => (a[0] === 'pr' && a[1] === 'view' ? ok({ state: 'MERGED', headRefName: 'steward/kit-1.0.1' }) : undefined));
  const res = await pushOne({ ...s.ctx, run: r.run }, s.e, { kit: '1.0.2', changelog: null, folds });
  assert.equal(res.outcome, 'skipped');
  assert.equal(res.message, "kit 1.0.2 wasn't put onto PR #7: it is merged now, so the next round bumps Fake afresh");
  assert.equal(sh(s.origin, 'rev-parse', 'refs/heads/steward/kit-1.0.1'), was);
  assert.ok(!r.gh.some((a) => a[1] === 'edit' || a[1] === 'create'));
});

test("replacingEntry writes a version's entry again, leaving the others; withEntry's when it has none", () => {
  const log = '# Fake\n\n## 0.4.1\n\n**Old.**\n\n## 0.4.0\n\n**First.**\n';
  assert.equal(replacingEntry(log, '## 0.4.1\n\n**New.**', 'Fake'), '# Fake\n\n## 0.4.1\n\n**New.**\n\n## 0.4.0\n\n**First.**\n');
  assert.equal(replacingEntry('# Fake\n\n## 0.4.1\n\n**Old.**\n', '## 0.4.1\n\n**New.**', 'Fake'), '# Fake\n\n## 0.4.1\n\n**New.**\n');
  assert.equal(replacingEntry(log.replace(/\n/g, '\r\n'), '## 0.4.1\n\n**New.**', 'Fake'), '# Fake\r\n\r\n## 0.4.1\r\n\r\n**New.**\r\n\r\n## 0.4.0\r\n\r\n**First.**\r\n');
  assert.equal(replacingEntry(log, '## 0.4.2\n\n**Next.**', 'Fake'), '# Fake\n\n## 0.4.2\n\n**Next.**\n\n## 0.4.1\n\n**Old.**\n\n## 0.4.0\n\n**First.**\n');
});

test("wholeTestSteps: a plain node --test script runs as node itself, between its pretest and posttest, so the checks pace sees node's test runner; any other through npm", () => {
  const at = (scripts: Record<string, string>) => {
    const d = mkdtempSync(path.join(tmp, 'whole-'));
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts }));
    return wholeTestSteps(d);
  };
  const test = 'node --import=./src/kit/test-git.ts --test "test/**/*.test.ts" "kit/test/**/*.test.ts"';
  assert.deepEqual(at({ test, pretest: 'npm run kit', posttest: 'node kit/test/dotnet.ts --if-present' }), [
    'npm run pretest',
    'node --import=./src/kit/test-git.ts --test "test/**/*.test.ts" "kit/test/**/*.test.ts"',
    'npm run posttest',
  ]);
  assert.deepEqual(at({ test: "node --test 'test/*.test.mjs'" }), ['node --test "test/*.test.mjs"']);
  assert.deepEqual(at({ test: 'node --test' }), ['npm test'], 'no files named: node picks its own');
  assert.deepEqual(at({ test: 'vitest run' }), ['npm test']);
  assert.deepEqual(at({ test: 'node --test "a.test.ts" && node other.js' }), ['npm test']);
  assert.deepEqual(wholeTestSteps(path.join(tmp, 'no-such-folder')), ['npm test']);
});

test('onlyFlaky: two failed runs of the same step whose failing tests each passed in the other; not a test failing both times, a run stopped, or one whose tests are unknown', () => {
  const step = 'node --test "test/**/*.test.ts"';
  const run = (tests: string[], more: object = {}) => ({ step, tests, timedOut: false, ...more });
  assert.equal(onlyFlaky(run(['console: a page started as open starts']), run(['fallback: the next accelerator answers'])), true);
  assert.equal(onlyFlaky(run(['a', 'b']), run(['c'])), true);
  assert.equal(onlyFlaky(run(['a', 'b']), run(['b', 'c'])), false, 'b failed both times');
  assert.equal(onlyFlaky(run(['a']), run(['b'], { timedOut: true })), false, 'a run stopped at its time limit');
  assert.equal(onlyFlaky(run(['a'], { timedOut: true }), run(['b'])), false);
  assert.equal(onlyFlaky(run(['a']), run(['b'], { step: 'npm run typecheck' })), false, 'another step');
  assert.equal(onlyFlaky(run([]), run(['b'])), false, 'no test named: something else failed');
  assert.equal(onlyFlaky(run(['a']), run([])), false);
  assert.equal(onlyFlaky({}, run(['b'])), false);
});
