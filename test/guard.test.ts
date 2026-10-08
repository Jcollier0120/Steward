import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// What holds a team PR back before the Steward merges it, since no one asked for it here: one GitHub runs no
// checks on is tested here at its head first, and the version it sets must be new. On a fake employee's git,
// with gh standing in, and the Steward's data folder one of its own.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-guard-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { mergeOne } = await import('../src/stages/merge.ts');
const { prChecksFile } = await import('../src/stages/prtest.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const VERSION_FILES = ['package.json', 'package-lock.json', 'src/app.ts'];

/** A fake employee at 0.4.0, and PRs made on it: each a branch from `from` (main), pushed as refs/pull/<n>/head. */
function employeeWithPrs(name: string) {
  const f = fakeEmployee(path.join(tmp, name), { version: '0.4.0' });
  const base = sh(f.checkout, 'rev-parse', 'HEAD');
  const make = (n: number, o: { version?: string; files?: Record<string, string>; from?: string } = {}) => {
    sh(f.checkout, 'switch', '--quiet', '--detach', o.from ?? base);
    if (o.version) for (const file of VERSION_FILES) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', o.version));
    for (const [file, text] of Object.entries(o.files ?? { [`change-${n}.txt`]: `#${n}\n` })) {
      mkdirSync(path.dirname(path.join(f.checkout, file)), { recursive: true });
      writeFileSync(path.join(f.checkout, file), text);
    }
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', `#${n}`);
    const sha = sh(f.checkout, 'rev-parse', 'HEAD');
    sh(f.checkout, 'push', '--quiet', '--force', 'origin', `${sha}:refs/pull/${n}/head`);
    sh(f.checkout, 'switch', '--quiet', 'main');
    return sha;
  };
  return { ...f, base, make };
}

const listed = (n: number, sha: string, o: Record<string, unknown> = {}) => ({
  number: n,
  title: `#${n}`,
  url: `https://github.com/Jcollier0120/Fake/pull/${n}`,
  headRefName: `feat/${n}`,
  headRefOid: sha,
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'Jcollier0120' },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: green,
  body: '',
  ...o,
});

test("a team PR GitHub runs no checks on is tested here at its head first: a failure is said once, then it waits quietly; a pass merges it, saying so; a new push is tested afresh", async () => {
  const f = employeeWithPrs('untested');
  const broken = f.make(7, { files: { broken: 'yes\n' } });
  // Its checks, as Settings give them: they fail while the PR carries a file called broken.
  const e = employee(f.checkout, { fill: '', test: [`node -e "process.exit(require('fs').existsSync('broken') ? 1 : 0)"`] });
  let head = broken;
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([listed(7, head, { statusCheckRollup: [] })]);
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'pr' && args[1] === 'merge') return ok('');
  });
  const round = () => {
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-untested'), run: r.run, neutralDir: tmp });
    return mergeOne(ctx, e, { yes: true, team: true }).then((m) => ({ m, lines: ctx.lines.join('\n') }));
  };

  const first = await round();
  assert.equal(first.m.outcome, 'failed', 'failing here for the first time is worth a word');
  assert.match(first.m.message, new RegExp(`^didn't merge #7: its checks failed here at ${broken.slice(0, 7)}, twice: node -e .* failed \\(exit 1\\)$`));
  assert.match(first.lines, /#7 has no checks on GitHub: testing it here at/);
  assert.ok(!r.gh.some((a) => a[1] === 'merge'), 'not merged');

  const again = await round();
  assert.equal(again.m.outcome, 'skipped', 'then it waits quietly');
  assert.match(again.m.message, new RegExp(`#7 \\(.*\\) waits: its checks failed here at ${broken.slice(0, 7)}`));
  assert.doesNotMatch(again.lines, /testing it here/, 'the same commit is not tested twice');

  // The listing says what a round would do.
  const look = await mergeOne(ctxFor({ employees: [e], workRoot: tmp, run: r.run, neutralDir: tmp }), e, { yes: false, team: true });
  assert.match(look.message, /#7 .* waits: its checks failed here at/);

  // A new push (no broken file): tested afresh, passes, merged, saying so.
  head = f.make(7, { files: { fixed: 'yes\n' } });
  const fixed = await round();
  assert.equal(fixed.m.outcome, 'done');
  assert.equal(fixed.m.message, `merged #7 (checks passed here at ${head.slice(0, 7)})`);
  assert.deepEqual(r.gh.filter((a) => a[1] === 'merge'), [['pr', 'merge', '7', '--repo', 'Jcollier0120/Fake', '--merge']]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(prChecksFile(), 'utf8'))), [`fake#7@${broken}`, `fake#7@${head}`], 'kept by commit');
});

test('a check that fails once and passes on a second try merges the PR, and says so', async () => {
  const f = employeeWithPrs('flaky');
  const sha = f.make(8, { files: { feature: 'yes\n' } });
  // Fails the first time it runs in a folder, passes the next.
  const e = employee(f.checkout, { fill: '', test: [`node -e "const fs=require('fs');if(fs.existsSync('ran'))process.exit(0);fs.writeFileSync('ran','');process.exit(1)"`] });
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([listed(8, sha, { statusCheckRollup: [] })]);
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'pr' && args[1] === 'merge') return ok('');
  });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-flaky'), run: r.run, neutralDir: tmp });
  const m = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(m.outcome, 'done');
  assert.match(m.message, new RegExp(`^merged #8 \\(checks passed here at ${sha.slice(0, 7)} on a second try \\(the first: node -e .* failed \\(exit 1\\)\\)\\)$`));
});

test("a team PR whose CI passes on GitHub isn't tested here again", async () => {
  const f = employeeWithPrs('with-ci');
  const sha = f.make(8);
  const e = employee(f.checkout, { fill: '', test: ['node -e process.exit(1)'] });
  const r = runner((args) => (args[1] === 'list' ? ok(args[0] === 'pr' ? [listed(8, sha)] : []) : args[1] === 'merge' ? ok('') : undefined));
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-ci'), run: r.run, neutralDir: tmp });
  const m = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(m.message, 'merged #8');
  assert.doesNotMatch(ctx.lines.join('\n'), /testing it here/);
});

test('a version a team PR sets must be new: not released, above its branch, and no other ready PR\'s; a merge before it is counted', async () => {
  const f = employeeWithPrs('versions');
  const shas: Record<number, string> = {
    7: f.make(7, { version: '0.4.1' }),
    8: f.make(8, { version: '0.4.2' }),
    9: f.make(9, { version: '0.4.2' }),
    10: f.make(10, { version: '0.3.9' }),
    11: f.make(11),
  };
  const e = employee(f.checkout, { fill: '' });
  const releases = [{ tagName: 'v0.4.1', isDraft: false }, { tagName: 'v0.4.0', isDraft: false }];
  const prs = Object.entries(shas).map(([n, sha]) => listed(Number(n), sha));
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'list' ? ok(prs) : args[0] === 'release' && args[1] === 'list' ? ok(releases) : args[1] === 'merge' ? ok('') : undefined));
  const ctx = () => ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-versions'), run: r.run, neutralDir: tmp });

  const look = await mergeOne(ctx(), e, { yes: false, team: true });
  // Each PR is said as "#n (head, whose; checks; mergeable) would be merged" or "… waits: why".
  const said = (n: number, what: string) => assert.ok(look.message.includes(`#${n} (feat/${n}, Jcollier0120's; checks passing; mergeable) ${what}`), `#${n} ${what}, in: ${look.message}`);
  said(11, 'would be merged');
  said(7, 'waits: it sets v0.4.1, which is already released: raise it');
  said(8, 'waits: #8 and #9 both set v0.4.2: each needs a version of its own');
  said(9, 'waits: #8 and #9 both set v0.4.2: each needs a version of its own');
  said(10, 'waits: it sets v0.3.9, but main is at v0.4.0 already: raise it above');
  const m = await mergeOne(ctx(), e, { yes: true, team: true });
  assert.deepEqual(m.merged.map((p) => p.number), [11]);

  // #12 sets 0.4.6 and #13 0.4.5, both new: the lowest version merges first, whatever the PR numbers, so #13 goes and
  // #12 waits its turn; at the next round, main at 0.4.5, #12 is still above it and merges.
  const g = employeeWithPrs('after-a-merge');
  const twelve = g.make(12, { version: '0.4.6' });
  const thirteen = g.make(13, { version: '0.4.5' });
  let open = [listed(12, twelve), listed(13, thirteen)];
  const s = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok(open);
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (args[2] === '13') sh(g.checkout, 'push', '--quiet', 'origin', `${thirteen}:refs/heads/main`);
      return ok('');
    }
  });
  const h = employee(g.checkout, { fill: '' });
  const ctxAfter = () => ctxFor({ employees: [h], workRoot: path.join(tmp, 'work-after'), run: s.run, neutralDir: tmp });
  const both = await mergeOne(ctxAfter(), h, { yes: true, team: true });
  assert.deepEqual(both.merged.map((p) => p.number), [13]);
  assert.match(both.message, /^merged #13; #12 .* waits: its turn comes after #13 \(v0\.4\.5\): the lowest version merges first$/);
  open = [listed(12, twelve)];
  const next = await mergeOne(ctxAfter(), h, { yes: true, team: true });
  assert.deepEqual(next.merged.map((p) => p.number), [12]);
});

test('a lower version holds the ones above it even while it waits itself, a draft too; a PR that sets no version goes first; a closed draft gives up its place', async () => {
  const f = employeeWithPrs('order');
  const shas: Record<number, string> = {
    15: f.make(15, { version: '0.4.7' }),
    16: f.make(16, { version: '0.4.8' }),
    17: f.make(17, { version: '0.4.6' }),
    18: f.make(18),
    19: f.make(19, { version: '0.4.9' }),
  };
  const e = employee(f.checkout, { fill: '' });
  const red = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }];
  let prs = [listed(15, shas[15], { statusCheckRollup: red }), listed(16, shas[16]), listed(17, shas[17], { isDraft: true }), listed(18, shas[18]), listed(19, shas[19])];
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'list' ? ok(prs) : args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v0.4.0', isDraft: false }]) : args[1] === 'merge' ? ok('') : undefined));
  const round = () => mergeOne(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-order'), run: r.run, neutralDir: tmp }), e, { yes: true, team: true });
  const m = await round();
  assert.deepEqual(m.merged.map((p) => p.number), [18], m.message);
  assert.match(m.message, /#17 .* waits: a draft/);
  assert.match(m.message, /#15 .* waits: checks failing/);
  assert.match(m.message, /#16 .* waits: its turn comes after #17 \(v0\.4\.6\): the lowest version merges first/, 'the draft holds its place');
  assert.match(m.message, /#19 .* waits: its turn comes after #17 \(v0\.4\.6\)/);

  // The draft closed, and #15 fixed: 0.4.6 is skipped, and #15 merges at its own version, renumbering nothing.
  prs = [listed(15, shas[15]), listed(16, shas[16]), listed(19, shas[19])];
  const next = await round();
  assert.deepEqual(next.merged.map((p) => p.number), [15], next.message);
  assert.match(next.message, /#16 .* waits: its turn comes after #15 \(v0\.4\.7\)/);
});

test('drafts wait, whatever their checks', async () => {
  const f = employeeWithPrs('drafts');
  const sha = f.make(14);
  const e = employee(f.checkout, { fill: '' });
  const r = runner((args) => (args[1] === 'list' ? ok(args[0] === 'pr' ? [listed(14, sha, { isDraft: true })] : []) : undefined));
  const m = await mergeOne(ctxFor({ employees: [e], workRoot: tmp, run: r.run, neutralDir: tmp }), e, { yes: true, team: true });
  assert.match(m.message, /^#14 .* waits: a draft$/);
  assert.ok(!r.gh.some((a) => a[1] === 'merge'));
});
