import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// What a PR asks for after merging (its steward block): read, checked before the merge, and run after it,
// against a fake employee's git, gh standing in, and a release zip made here with Windows' tar. The Steward's
// data folder is one of its own (a team PR tested here is kept there).
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-after-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { afterWords, readAfter } = await import('../src/after.ts');
const { afterMerge, approveJobs, installOne, listedSum } = await import('../src/stages/aftermerge.ts');
const { mergeOne } = await import('../src/stages/merge.ts');
const { releaseDecision } = await import('../src/stages/release.ts');
const { parsePrs } = await import('../src/stages/staff.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const block = (json: string) => `Adds a job.\r\n\r\n## After merging (for the Steward)\r\n\r\n\`\`\`steward\r\n${json}\r\n\`\`\`\r\n\r\nMore words.`;
const REEVE13 = '{"after": ["release", "install", "approve-jobs"], "jobs": ["aletaster-orders"]}';

test("a PR's steward block: what it asks for, in the Steward's order; anything it can't do or read is an error, never ignored", () => {
  assert.deepEqual(readAfter('No block here, though it says ```steward in passing.'), { after: null });
  assert.deepEqual(readAfter(undefined), { after: null });
  assert.deepEqual(readAfter(block(REEVE13)), { after: { steps: ['release', 'install', 'approve-jobs'], jobs: ['aletaster-orders'] } });
  assert.deepEqual(readAfter(block('{"after": ["install", "release"]}')), { after: { steps: ['release', 'install'], jobs: [] } });
  const error = (json: string) => (readAfter(block(json)) as { error: string }).error;
  assert.match(error('{"after": ["release", "deploy"]}'), /asks for "deploy", which the Steward doesn't do \(it does release, install, approve-jobs\)/);
  assert.match(error('{"after": ["release"], "run": "rm -rf"}'), /has "run", which the Steward doesn't read/);
  assert.match(error('{"after": ["release",]}'), /isn't JSON/);
  assert.match(error('["release"]'), /isn't a JSON object/);
  assert.match(error('{"after": []}'), /"after" isn't a list of steps/);
  assert.match(error('{"after": ["approve-jobs"]}'), /asks for approve-jobs, but names no jobs/);
  assert.match(error('{"after": ["release"], "jobs": ["x"]}'), /names jobs, but doesn't ask for approve-jobs/);
  assert.match(error('{"after": ["approve-jobs"], "jobs": ["../evil"]}'), /"jobs" isn't a list of job names/);
  assert.match(error('{"after": ["release", "approve-jobs"], "jobs": ["x"]}'), /asks for approve-jobs without install: the scripts approved are the installed copy's/);
  assert.match((readAfter(block(REEVE13) + '\n' + block(REEVE13)) as { error: string }).error, /more than one steward block/);
  assert.equal(afterWords({ steps: ['release', 'install', 'approve-jobs'], jobs: ['aletaster-orders'] }), 'release, install, approve-jobs (aletaster-orders)');
});

test('a release a PR asks for carries whatever kit its branch pins, on the kit or not; the rollout\'s still needs the kit', () => {
  const c = { usesKit: false, kit: null, version: '0.3.2', released: ['0.3.1'] };
  assert.deepEqual(releaseDecision(c, null), { release: true });
  assert.deepEqual(releaseDecision({ ...c, released: ['0.3.2'] }, null), { release: false, why: 'v0.3.2 is already released' });
  assert.deepEqual(releaseDecision(c, '1.2.1'), { release: false, why: 'not using the kit yet' });
});

const listed = (o: Record<string, unknown>) => ({
  number: 7,
  title: 'Jobs: aletaster-orders',
  url: 'https://github.com/Jcollier0120/Fake/pull/7',
  headRefName: 'feat/aletaster-orders',
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'Jcollier0120', is_bot: false },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: [],
  body: block(REEVE13),
  ...o,
});

/** A fake employee with a PR (#7) on origin as refs/pull/7/head, which raises the version to `version` or leaves it. */
function withPr(name: string, version: string | null) {
  const f = fakeEmployee(path.join(tmp, name), { version: '0.4.0' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'feat/aletaster-orders');
  mkdirSync(path.join(f.checkout, 'jobs'), { recursive: true });
  writeFileSync(path.join(f.checkout, 'jobs', 'aletaster-orders.ps1'), "'REEVE_RESULT {}'\n");
  if (version) for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', version));
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'The aletaster-orders job');
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${sha}:refs/pull/7/head`);
  sh(f.checkout, 'switch', '--quiet', 'main');
  return { ...f, sha };
}

test("parsePrs keeps a PR's steward block, or why it can't be read; merge holds a PR whose block it can't read, or whose steps couldn't happen", async () => {
  const [good, bad] = parsePrs(JSON.stringify([listed({ number: 7 }), listed({ number: 8, body: block('{"after": ["deploy"]}') })]), ['Jcollier0120']);
  assert.deepEqual(good.after, { steps: ['release', 'install', 'approve-jobs'], jobs: ['aletaster-orders'] });
  assert.equal(good.afterError, null);
  assert.equal(bad.after, null);
  assert.match(bad.afterError!, /asks for "deploy"/);

  // #7 doesn't raise the version: once merged it would be 0.4.0, already released, so it waits. #8's block can't be read.
  const same = withPr('same-version', null);
  const releases = [{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' }];
  const r = runner((args) => (args[1] === 'list' && args[0] === 'pr' ? ok([listed({ headRefOid: same.sha }), listed({ number: 8, body: block('{"after": ["deploy"]}') })]) : args[0] === 'release' && args[1] === 'list' ? ok(releases) : undefined));
  const e = employee(same.checkout, { approve: 'node -e process.exit(0) {job}' });
  const look = await mergeOne(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-same'), run: r.run, neutralDir: tmp }), e, { yes: true, team: true });
  assert.equal(look.outcome, 'skipped');
  assert.ok(!r.gh.some((a) => a[1] === 'merge'), 'nothing merged');
  assert.match(look.message, /#7 \(.*; then release, install, approve-jobs \(aletaster-orders\)\) waits: it asks for a release, but v0\.4\.0, its version once merged, is already released: raise the version in the PR/);
  assert.match(look.message, /#8 .* waits: its steward block asks for "deploy"/);

  // Install or approve-jobs with no command for it in Settings doesn't hold it (the employee is installed, or its jobs
  // approved, another way, and the step is skipped after the merge): #7 waits only for its version.
  for (const missing of [{ install: '' }, { approve: '' }]) {
    const none = await mergeOne(ctxFor({ employees: [e], workRoot: tmp, run: r.run, neutralDir: tmp }), { ...e, ...missing }, { yes: false, team: true });
    assert.doesNotMatch(none.message, /install command|approve command/);
    assert.match(none.message, /#7 .* waits: it asks for a release, but v0\.4\.0, its version once merged, is already released/);
  }
  const noApprove = await approveJobs(ctxFor({ employees: [e], workRoot: tmp, run: r.run, neutralDir: tmp }), { ...e, approve: '' }, parsePrs(JSON.stringify([listed({ headRefOid: same.sha })]), ['Jcollier0120']));
  assert.deepEqual([noApprove.outcome, noApprove.message], ['skipped', 'Settings give Fake no approve command, so the Steward leaves aletaster-orders to be approved another way']);
});

/** A release zip as an agent's release.ts makes it (flat, release.json at the top), with its SHA256SUMS.txt. */
function releaseZip(dir: string, version: string, marker: string): { zip: string; sums: string } {
  const stage = path.join(dir, 'stage');
  mkdirSync(path.join(stage, 'src'), { recursive: true });
  writeFileSync(path.join(stage, 'release.json'), JSON.stringify({ id: 'fake', version }));
  // Its installer leaves word of how it was run, where it ran.
  writeFileSync(path.join(stage, 'src', 'cli.ts'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + ' in ' + process.cwd());\n`);
  const zip = path.join(dir, `Fake-${version}.zip`);
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', stage, 'release.json', 'src'], { windowsHide: true });
  const sums = `${createHash('sha256').update(readFileSync(zip)).digest('hex')}  Fake-${version}.zip\n`;
  return { zip, sums };
}

/** gh's release download, standing in: the zip and SHA256SUMS.txt into --dir. */
const download = (args: string[], zip: string, sums: string) => {
  const dir = args[args.indexOf('--dir') + 1];
  writeFileSync(path.join(dir, path.basename(zip)), readFileSync(zip));
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums);
  return ok('');
};

test('merge --yes --team, then what the PR asks for: its release from the branch, that release installed from its checked zip, and its job approved in the installed copy', async () => {
  const f = withPr('whole', '0.4.1');
  const work = path.join(tmp, 'work-whole');
  const releasedMarker = path.join(tmp, 'whole-released.txt');
  const installedMarker = path.join(tmp, 'whole-installed.txt');
  const made = releaseZip(path.join(tmp, 'whole-zip'), '0.4.1', installedMarker);
  let merged = false;
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([listed({ headRefOid: f.sha })]);
    if (args[0] === 'pr' && args[1] === 'merge') {
      // GitHub merges it: origin's main moves to the PR's commit.
      sh(f.checkout, 'push', '--quiet', 'origin', `${f.sha}:refs/heads/main`);
      merged = true;
      return ok('');
    }
    if (args[0] === 'pr' && args[1] === 'view') return ok({ files: [{ path: 'jobs/aletaster-orders.ps1' }, { path: 'jobs/other.ps1' }, { path: 'jobs/jobs.json' }] });
    if (args[0] === 'release' && args[1] === 'list') return ok([...(existsSync(releasedMarker) ? [{ tagName: 'v0.4.1', isDraft: false }] : []), { tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'release' && args[1] === 'download') return download(args, made.zip, made.sums);
  });
  // The approve command, as Settings hold it: %NAME% expanded, {job} each job's name.
  const approvedMarker = path.join(tmp, 'whole-approved.txt');
  process.env.STEWARD_TEST_APPROVED = approvedMarker;
  const e = employee(f.checkout, {
    release: `node -e "require('fs').writeFileSync(process.argv[1], process.cwd())" ${releasedMarker}`,
    approve: `node -e "require('fs').appendFileSync(process.argv[1], 'approve ' + process.argv[2] + ' after ' + require('fs').readFileSync(process.argv[3], 'utf8').split(' ')[0])" %STEWARD_TEST_APPROVED% {job} ${installedMarker}`,
    fill: '',
  });
  const ctx = ctxFor({ employees: [e], workRoot: work, run: r.run, neutralDir: tmp });

  const m = await mergeOne(ctx, e, { yes: true, team: true });
  assert.equal(m.outcome, 'done', m.message);
  assert.ok(merged);
  assert.deepEqual(r.gh.find((a) => a[1] === 'merge'), ['pr', 'merge', '7', '--repo', 'Jcollier0120/Fake', '--merge'], "a team member's branch stays");

  const steps = await afterMerge(ctx, [e], [{ id: e.id, merged: m.merged }], { releaseKit: null });
  assert.deepEqual(steps.map((s) => [s.outcome, s.message.split(':')[0]]), [['done', 'release'], ['done', 'install'], ['done', 'approve-jobs']]);
  assert.match(steps[0].message, /^release: released v0\.4\.1 from origin\/main \(.{7}\), with kit 1\.0\.0$/);
  assert.match(readFileSync(releasedMarker, 'utf8'), /fake-release$/, 'released from a worktree of the branch, not the checkout');
  assert.equal(steps[1].message, 'install: installed v0.4.1 on this PC');
  assert.match(readFileSync(installedMarker, 'utf8'), /^install in .*fake-install[\\/]release$/, 'its own installer, run in the unpacked release');
  assert.ok(!existsSync(path.join(work, 'fake-install')), 'the unpacked release is removed once installed');
  assert.equal(steps[2].message, "approve-jobs: approved aletaster-orders, as merging #7 counts as reading its script; #7 also changed jobs/other.ps1, which it doesn't name: not approved, yours to review");
  assert.equal(readFileSync(approvedMarker, 'utf8'), 'approve aletaster-orders after install', 'approved once, by name, after the install; not jobs/other.ps1');
});

test("install refuses a zip that doesn't match its SHA256SUMS.txt, or a release.json of another version; and nothing is installed or approved after a release that wasn't made", async () => {
  const dir = path.join(tmp, 'refuse');
  const marker = path.join(tmp, 'refuse-installed.txt');
  const made = releaseZip(dir, '0.4.1', marker);
  const e = employee(path.join(tmp, 'nowhere'));
  const ctx = (sums: string, tag = 'v0.4.1') =>
    ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-refuse'), neutralDir: tmp, run: runner((args) => (args[1] === 'list' ? ok([{ tagName: tag, isDraft: false }]) : args[1] === 'download' ? download(args, made.zip, sums) : undefined)).run });
  const bad = await installOne(ctx(made.sums.replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0'))), e);
  assert.equal(bad.outcome, 'refused');
  assert.equal(bad.message, "Fake-0.4.1.zip doesn't match its SHA256SUMS.txt, so it isn't installed");
  assert.match((await installOne(ctx(''), e)).message, /has no SHA256SUMS\.txt naming Fake-0\.4\.1\.zip/);
  assert.equal((await installOne(ctx(made.sums, 'v0.4.2'), e)).message, "Fake-0.4.1.zip's release.json says 0.4.1, not 0.4.2");
  assert.ok(!existsSync(marker), 'nothing installed');
  // No install command in Settings: installed another way, so the step is skipped, and nothing is downloaded.
  const elsewhere = await installOne(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-refuse'), neutralDir: tmp, run: runner(() => { throw new Error('nothing asked of gh'); }).run }), { ...e, install: '' });
  assert.deepEqual([elsewhere.outcome, elsewhere.message], ['skipped', "Settings give Fake no install command, so it is installed another way (Manor's updates), not by the Steward"]);
  assert.equal(listedSum('abc  x.zip\n' + 'f'.repeat(64) + ' *Fake.zip\n', 'Fake.zip'), 'f'.repeat(64));

  // A release asked for, and refused (its version is out already): no install after it.
  const f = withPr('no-release', '0.4.1');
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v0.4.0', isDraft: false }]) : args[0] === 'pr' && args[1] === 'view' ? ok({ files: [] }) : undefined));
  const g = employee(f.checkout, { approve: 'node -e process.exit(1) {job}' });
  const pr = parsePrs(JSON.stringify([listed({ headRefOid: f.sha })]), ['Jcollier0120'])[0];
  const steps = await afterMerge(ctxFor({ employees: [g], workRoot: path.join(tmp, 'work-no-release'), run: r.run, neutralDir: tmp }), [g], [{ id: g.id, merged: [pr] }], { releaseKit: null });
  assert.deepEqual(steps.map((s) => s.message), [
    'release: v0.4.0 is already released',
    'install: not without the release #7 asked for',
    'approve-jobs: not without the install #7 asked for',
  ]);
});
