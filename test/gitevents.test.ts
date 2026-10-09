import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// Plain git's events (stages/gitevents.ts): with no pull requests, Settings say what the Steward does when a claimed
// branch is ready (When a branch is ready) and once a release's tag is pushed (After a release). Real git, local
// origins; nothing reaches GitHub, the live ~/.steward or the real checkouts.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-gitevents-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
process.env.WRIGHT_HOME = path.join(tmp, 'no-wright');
process.env.BAILIFF_HOME = path.join(tmp, 'no-bailiff');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { claimsFile } = await import('../src/claims.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { fillCommand, handedInFile, handInBranches, HAND_IN_TRIES } = await import('../src/stages/gitevents.ts');
const { merge } = await import('../src/stages/merge.ts');
const { normalizeSettings, SETTINGS_SCHEMA } = await import('../src/settings.ts');
const { runStage } = await import('../src/steward.ts');
const { run: realRun } = await import('../src/run.ts');
const { ctxFor, employee, fakeEmployee, runner, sh } = await import('./helpers.ts');
type Claim = import('../src/claims.ts').Claim;
type Employee = import('../src/settings.ts').Employee;

const claim = (o: Partial<Claim> = {}): Claim => ({ repo: 'gitlab.com/me/fake', version: '0.4.1', branch: 'claude/feature', by: 'claude', for: 'a feature', at: new Date().toISOString(), ...o });
const FF = 'git push origin {commit}:refs/heads/{base}';
const PASS = 'node -e process.exit(0)';
// Fails where the branch has bad.txt.
const NOT_BAD = `node -e "process.exit(require('fs').existsSync('bad.txt')?1:0)"`;
beforeEach(() => {
  rmSync(claimsFile(), { force: true });
  rmSync(handedInFile(), { force: true });
});

/** A plain-git Fake at v0.4.0 on origin's main, with a branch per entry off main, each setting its version and pushed. */
function repoWith(name: string, branches: { branch: string; version: string; bad?: boolean }[]) {
  const f = fakeEmployee(path.join(tmp, name), { version: '0.4.0', kit: null, files: { 'CHANGELOG.md': "# Fake's changelog\n\n## 0.4.0\n\n**First.**\n" } });
  const heads: Record<string, string> = {};
  for (const b of branches) {
    sh(f.checkout, 'switch', '--quiet', '-c', b.branch, 'main');
    for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').split('0.4.0').join(b.version));
    writeFileSync(path.join(f.checkout, 'CHANGELOG.md'), `# Fake's changelog\n\n## ${b.version}\n\n**${b.branch}, at last.**\n\n### What's new\n\n- It.\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n\n## 0.4.0\n\n**First.**\n`);
    if (b.bad) writeFileSync(path.join(f.checkout, 'bad.txt'), 'bad\n');
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', b.branch);
    sh(f.checkout, 'push', '--quiet', 'origin', b.branch);
    heads[b.branch] = sh(f.checkout, 'rev-parse', 'HEAD');
  }
  sh(f.checkout, 'switch', '--quiet', 'main');
  return { ...f, heads };
}

/** A round's merge stage over plain git: gh is never run. */
function plainGit(e: Employee) {
  const r = runner();
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
  return { ctx: { ...ctx, host: () => 'git' as const }, lines: ctx.lines, r };
}
const fake = (checkout: string, more: Partial<Employee> = {}) => employee(checkout, { repo: 'gitlab.com/me/fake', fill: '', usesKit: false, test: [PASS], whenReady: FF, ...more });

test("a command's placeholders are filled in word by word, after it is split, so a value with spaces or quotes stays one word", () => {
  process.env.STEWARD_TEST_TOOL = 'C:\\Tools';
  const words = fillCommand('%STEWARD_TEST_TOOL%\\hand-in.exe --title "{title}" --to={base} {notesFile} {unknown}', { title: 'Fake 0.4.1: "Quoted", and spaced', base: 'main', notesFile: 'C:\\Temp\\a b\\notes.md' });
  assert.deepEqual(words, ['C:\\Tools\\hand-in.exe', '--title', 'Fake 0.4.1: "Quoted", and spaced', '--to=main', 'C:\\Temp\\a b\\notes.md', '{unknown}']);
  assert.equal(fillCommand('   ', {}), null);
});

test('a claimed, pushed branch is tested here, then handed in by the command (a fast-forward), once; gh is never run', async () => {
  const f = repoWith('ff', [{ branch: 'claude/feature', version: '0.4.1' }]);
  writeJson(claimsFile(), [claim()]);
  const e = fake(f.checkout);
  const first = plainGit(e);
  const [m] = await merge(first.ctx, [e], { yes: true, team: true });
  assert.equal(m.outcome, 'done', `${m.message}\n${first.lines.join('\n')}`);
  assert.match(m.message, new RegExp(`^handed in claude/feature \\(v0\\.4\\.1, checks passed here at ${f.heads['claude/feature'].slice(0, 7)}\\); worked with plain git`));
  assert.equal(sh(f.origin, 'rev-parse', 'main'), f.heads['claude/feature'], 'landed on main');
  assert.match(first.lines.join('\n'), /handing it in \(v0\.4\.1, .*\): git push origin [0-9a-f]{40}:refs\/heads\/main/);
  assert.deepEqual(first.r.gh, []);

  // In main now: nothing more to do, and nothing tested again.
  const second = plainGit(e);
  const [again] = await merge(second.ctx, [e], { yes: true, team: true });
  assert.equal(again.outcome, 'skipped', again.message);
  assert.doesNotMatch(second.lines.join('\n'), /testing it here|handing it in/);

  // Off without the command, or without Merges your ready PRs.
  for (const more of [{ whenReady: undefined }, { merges: false }]) {
    const g = repoWith(`off-${Object.keys(more)[0]}`, [{ branch: 'claude/feature', version: '0.4.1' }]);
    const off = plainGit(fake(g.checkout, more));
    await merge(off.ctx, [fake(g.checkout, more)], { yes: true, team: true });
    assert.notEqual(sh(g.origin, 'rev-parse', 'main'), g.heads['claude/feature']);
    assert.doesNotMatch(off.lines.join('\n'), /testing it here/);
  }
});

test("a branch whose checks fail here isn't handed in, nor tested again at that head; it holds the versions above it", async () => {
  const f = repoWith('queue', [
    { branch: 'claude/a', version: '0.4.1', bad: true },
    { branch: 'claude/b', version: '0.4.2' },
  ]);
  writeJson(claimsFile(), [claim({ branch: 'claude/a', version: '0.4.1' }), claim({ branch: 'claude/b', version: '0.4.2' })]);
  const e = fake(f.checkout, { test: [NOT_BAD] });
  const first = plainGit(e);
  const out = await handInBranches(first.ctx, e);
  assert.deepEqual(out.lines, [`claude/a not handed in: its checks failed here at ${f.heads['claude/a'].slice(0, 7)}, twice: ${out.lines[0].split(', twice: ')[1]}`]);
  assert.match(out.lines[0], /tested again once it moves$/);
  assert.equal(out.handed, 0);
  assert.equal(out.failed, false, 'no alarm');
  assert.doesNotMatch(first.lines.join('\n'), /claude\/b: testing/, 'b waits for a');

  const second = plainGit(e);
  const still = await handInBranches(second.ctx, e);
  assert.match(still.lines[0], /^claude\/a not handed in/);
  assert.doesNotMatch(second.lines.join('\n'), /testing it here/, 'not tested again at the same head');

  // Fixed and pushed: tested afresh and handed in. Then b's turn: it is off the old main, so its fast-forward is
  // refused, and it is tried again next round.
  sh(f.checkout, 'switch', '--quiet', 'claude/a');
  sh(f.checkout, 'rm', '--quiet', 'bad.txt');
  sh(f.checkout, 'commit', '--quiet', '-m', 'fixed');
  sh(f.checkout, 'push', '--quiet', 'origin', 'claude/a');
  sh(f.checkout, 'switch', '--quiet', 'main');
  const third = plainGit(e);
  const fixed = await handInBranches(third.ctx, e);
  assert.match(fixed.lines[0], /^handed in claude\/a \(v0\.4\.1, checks passed here at .{7}\)$/);
  assert.match(fixed.lines[1], /^claude\/b not handed in: When a branch is ready failed \(exit 1: .*\), tried again next round$/);
  assert.equal(fixed.handed, 1);
});

test(`a command that fails is tried again each round, ${HAND_IN_TRIES} times at one head; then the stage fails, until the branch moves`, async () => {
  const f = repoWith('fails', [{ branch: 'claude/feature', version: '0.4.1' }]);
  writeJson(claimsFile(), [claim()]);
  const e = fake(f.checkout, { whenReady: 'node -e "console.error(\'the server said no\'); process.exit(3)"' });
  for (let i = 1; i <= HAND_IN_TRIES; i++) {
    const t = plainGit(e);
    const [m] = await merge(t.ctx, [e], { yes: true, team: true });
    assert.match(m.message, /^claude\/feature not handed in: When a branch is ready failed \(exit 3: the server said no\)/);
    assert.equal(m.outcome, i < HAND_IN_TRIES ? 'skipped' : 'failed', `try ${i}: ${m.message}`);
    assert.equal(t.lines.filter((l) => /testing it here/.test(l)).length, i === 1 ? 1 : 0, 'tested once, at the first try');
  }
  const after = plainGit(e);
  const [m] = await merge(after.ctx, [e], { yes: true, team: true });
  assert.equal(m.outcome, 'failed');
  assert.match(m.message, new RegExp(`failed ${HAND_IN_TRIES} times at .{7} \\(exit 3: the server said no\\); it is run again once the branch moves`));
  assert.doesNotMatch(after.lines.join('\n'), /handing it in/, 'not run again');
});

test('After a release: run in the clone once the tag is pushed, with the tag and its notes; a failure is a note, and the release stands', async () => {
  const home = process.env.STEWARD_HOME!;
  const f = fakeEmployee(path.join(tmp, 'site'), { version: '1.2.0', kit: null, files: { 'CHANGELOG.md': "# Site's changelog\n\n## 1.2.0\n\n**Faster pages.**\n\n### What changed\n\n- Pages load faster.\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n" } });
  const said = path.join(tmp, 'after-release.json');
  const script = path.join(tmp, 'after-release.js');
  writeFileSync(script, "const fs = require('fs'); const [tag, version, notes, out, code] = process.argv.slice(2); fs.writeFileSync(out, JSON.stringify({ tag, version, notes: fs.readFileSync(notes, 'utf8'), cwd: process.cwd() })); process.exit(Number(code || 0));\n");
  const settings = (whenReleased: string) =>
    writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({
        employees: [{ id: 'site', name: 'Site', repo: 'gitlab.com/me/site', checkout: f.checkout, branch: 'main', usesKit: false, fill: '', test: [], versionFiles: ['package.json'], release: 'tag', install: '', approve: '', whenReleased }],
        workRoot: path.join(tmp, 'work'),
        releasesCastellan: false,
        tasteBeforeRelease: false,
        afterRelease: [],
        alarms: { manorUrl: '', surveyorUrl: '', toast: false },
      }),
    );
  const run = async (cmd: string, args: string[], opts?: any) => (cmd === 'gh' ? { code: 127, out: '', err: "gh isn't installed" } : realRun(cmd, args, opts));
  const scm = { at: new Date().toISOString(), tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.55.0', supported: true }] };
  settings(`node ${script} {tag} {version} {notesFile} ${said}`);
  const out = await runStage('release', {}, { run, scm });
  assert.match(out.results[0].message, /^released v1\.2\.0 from origin\/main \(.{7}\), tagged v1\.2\.0 on its origin; After a release ran$/, out.log.join('\n'));
  const got = JSON.parse(readFileSync(said, 'utf8'));
  assert.equal(got.tag, 'v1.2.0');
  assert.equal(got.version, '1.2.0');
  assert.match(got.notes, /- Pages load faster\./);
  assert.equal(path.resolve(got.cwd), path.resolve(f.checkout));

  // A failing one: noted, and the release (its tag on origin) stands.
  rmSync(said);
  sh(f.checkout, 'pull', '--quiet', '--ff-only', 'origin', 'main');
  writeFileSync(path.join(f.checkout, 'package.json'), readFileSync(path.join(f.checkout, 'package.json'), 'utf8').replace('1.2.0', '1.2.1'));
  sh(f.checkout, 'commit', '--quiet', '-am', '1.2.1');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  settings(`node ${script} {tag} {version} {notesFile} ${said} 4`);
  const failed = await runStage('release', {}, { run, scm });
  assert.equal(failed.results[0].outcome, 'done');
  assert.match(failed.results[0].message, /tagged v1\.2\.1 on its origin; After a release failed \(exit 4: no output\)$/);
  assert.ok(existsSync(said), 'it ran');
  assert.equal(sh(f.origin, 'cat-file', '-t', 'v1.2.1'), 'tag');
});

test('Settings keep both commands per repository, left out when empty, and show them as optional fields', () => {
  const base = { id: 'site', name: 'Site', repo: 'gitlab.com/me/site', checkout: 'C:\\x', branch: 'main', test: [], versionFiles: [], release: '', install: '', approve: '' };
  const { settings } = normalizeSettings({ employees: [{ ...base, whenReady: `  ${FF}  `, whenReleased: 'notify {tag}' }, { ...base, id: 'other', whenReady: ' ', whenReleased: 7 }] });
  assert.equal(settings.employees[0].whenReady, FF);
  assert.equal(settings.employees[0].whenReleased, 'notify {tag}');
  assert.ok(!('whenReady' in settings.employees[1]) && !('whenReleased' in settings.employees[1]));
  const fields = (SETTINGS_SCHEMA.find((f) => f.key === 'employees') as any).fields as { key: string; optional?: boolean; label: string }[];
  assert.deepEqual(
    fields.filter((f) => f.key === 'whenReady' || f.key === 'whenReleased').map((f) => [f.key, f.label, f.optional]),
    [
      ['whenReady', 'When a branch is ready', true],
      ['whenReleased', 'After a release', true],
    ],
  );
});
