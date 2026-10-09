import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Entries written as changes/<version>.md, and the stamp that moves them into CHANGELOG.md and the version files on the
// pull request's own branch just before it merges: two pieces of work side by side never meet in the same lines.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-entries-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { changeFiles, changeVersion, CHANGES_README, changesReadme, entryBody, foldEntries, stampVersions } = await import('../src/entries.ts');
const { stamp, usesChanges } = await import('../src/stages/stamp.ts');
const { testedBefore } = await import('../src/stages/prtest.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const ENTRY = (line: string) => `**${line}**\n\n### What changed\n\n- ${line}\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n`;

test('a changes file is named by its version, in its own folder only', () => {
  assert.equal(changeVersion('changes/0.16.32.md'), '0.16.32');
  assert.equal(changeVersion('changes\\0.16.32.md'), '0.16.32');
  assert.equal(changeVersion('changes/README.md'), null);
  assert.equal(changeVersion('kit/changes/2.44.0.md'), null, "the kit's folder is another");
  assert.equal(changeVersion('kit/changes/2.44.0.md', 'kit/changes'), '2.44.0');
  assert.deepEqual(changeFiles(['changes/0.4.10.md', 'changes/README.md', 'src/a.ts', 'changes/0.4.9.md']), ['changes/0.4.9.md', 'changes/0.4.10.md'], 'lowest first, by version');
});

test("an entry's own heading is left out when it names its version; one naming another needs its author", () => {
  assert.equal(entryBody('﻿\r\n**A line.**\r\n\r\n### What changed\r\n\r\n- x\r\n', '0.4.2'), '**A line.**\n\n### What changed\n\n- x');
  assert.equal(entryBody('## 0.4.2\n\n**A line.**\n', '0.4.2'), '**A line.**');
  assert.equal(entryBody('## 0.4.3\n\n**A line.**\n', '0.4.2'), null);
  assert.equal(entryBody('  \n\n', '0.4.2'), null);
});

test('each changes file keeps its own version while it is free; else the next free one, a minor step kept minor', () => {
  const v = (files: string[], o: Partial<Parameters<typeof stampVersions>[1]> = {}) => stampVersions(files, { base: '0.4.1', released: ['0.4.0', '0.4.1'], taken: [], ...o }).map((s) => [s.file, s.version, s.why]);
  assert.deepEqual(v(['changes/0.4.2.md']), [['changes/0.4.2.md', '0.4.2', null]]);
  assert.deepEqual(v(['changes/0.4.2.md'], { taken: ['0.4.2'] }), [['changes/0.4.2.md', '0.4.3', 'other work holds v0.4.2']]);
  assert.deepEqual(v(['changes/0.4.1.md']), [['changes/0.4.1.md', '0.4.2', 'v0.4.1 is already released']]);
  assert.deepEqual(v(['changes/0.4.2.md'], { base: '0.4.2', released: [] }), [['changes/0.4.2.md', '0.4.3', 'the branch is at v0.4.2 already']]);
  assert.deepEqual(v(['changes/0.4.1.md'], { base: '0.4.5', released: [] }).map((x) => x[1]), ['0.4.6']);
  assert.deepEqual(v(['changes/0.5.0.md'], { base: '0.5.0', released: ['0.5.0'] }).map((x) => x[1]), ['0.6.0'], 'a minor step stays one');
  // One left on the branch by an older Steward, and the PR's: the lower first, each above the one before.
  assert.deepEqual(v(['changes/0.4.3.md', 'changes/0.4.2.md']).map((x) => x[1]), ['0.4.2', '0.4.3']);
});

test('the entries fold into the changelog, the highest on top, a changelog started where there was none', () => {
  const log = "# Fake's changelog\n\nNewest first.\n\n## 0.4.1\n\n**Old.**\n";
  const out = foldEntries(log, 'Fake', [{ version: '0.4.3', body: '**Three.**' }, { version: '0.4.2', body: '**Two.**' }]);
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.3', '## 0.4.2', '## 0.4.1']);
  assert.match(out, /## 0\.4\.3\n\n\*\*Three\.\*\*\n\n## 0\.4\.2/);
  assert.match(foldEntries(null, 'Fake', [{ version: '0.1.0', body: '**First.**' }]), /^# Fake's changelog[\s\S]*## 0\.1\.0\n\n\*\*First\.\*\*/);
});

/**
 * An employee that writes its entries in changes/: main at 0.4.1 (stamped already, its entry in CHANGELOG.md) under a
 * PR that branched at 0.4.0 and wrote changes/<version>.md beside a feature, touching no version file.
 */
function pending(name: string, o: { entry?: string; file?: string; leftover?: boolean } = {}) {
  const dir = path.join(home, name);
  const { checkout, origin } = fakeEmployee(dir, { version: '0.4.0', files: { [CHANGES_README]: changesReadme('Fake'), 'CHANGELOG.md': "# Fake's changelog\n\n## 0.4.0\n\n**First.**\n" } });
  const write = (f: string, t: string) => (mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true }), writeFileSync(path.join(checkout, f), t));
  const read = (f: string) => readFileSync(path.join(checkout, f), 'utf8');
  sh(checkout, 'switch', '--quiet', '-c', 'claude/feature');
  write('src/feature.ts', 'export const feature = 1;\n');
  write(o.file ?? 'changes/0.4.2.md', o.entry ?? ENTRY('A feature.'));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'A feature');
  sh(checkout, 'push', '--quiet', 'origin', 'claude/feature');
  const headOid = sh(checkout, 'rev-parse', 'HEAD');
  // main: another piece of work, stamped as 0.4.1.
  sh(checkout, 'switch', '--quiet', 'main');
  for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) write(f, read(f).split('0.4.0').join('0.4.1'));
  write('CHANGELOG.md', read('CHANGELOG.md').replace('## 0.4.0', `## 0.4.1\n\n${ENTRY('Something else.')}\n## 0.4.0`));
  write('src/other.ts', 'export const other = 1;\n');
  if (o.leftover) write('changes/0.4.1.md', ENTRY('Merged by an older Steward.'));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Fake 0.4.1: something else');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const main = sh(checkout, 'rev-parse', 'HEAD');
  const pr: PrInfo = { number: 30, title: 'Fake 0.4.2: a feature', url: 'https://github.com/Jcollier0120/Fake/pull/30', head: 'claude/feature', base: 'main', author: 'Jcollier0120', whose: 'team', headOid, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 10, files: [], fork: false };
  return { dir, checkout, origin, pr, main };
}

const ctxOf = (p: { dir: string; checkout: string }, run = runner(() => ok('')).run) => {
  const e = employee(p.checkout);
  return { e, ctx: ctxFor({ employees: [e], workRoot: path.join(p.dir, 'work'), run, neutralDir: p.dir }) };
};

test('a pull request is stamped on its own branch: main merged in, its version set, its entry moved into the changelog', async () => {
  const p = pending('stamp');
  const r = runner(() => ok(''));
  const { e, ctx } = ctxOf(p, r.run);
  assert.equal(await usesChanges(ctx, e), true);
  const s = await stamp(ctx, e, p.pr, { released: ['0.4.0', '0.4.1'], taken: [], carry: `checks passed at ${p.pr.headOid.slice(0, 7)} in Jcollier0120's clone, vouched for` });
  assert.equal(s.done, true, s.note);
  assert.equal(s.version, '0.4.2');
  assert.equal(s.note, 'stamped v0.4.2');
  const at = (f: string) => sh(p.origin, 'show', `refs/heads/claude/feature:${f}`);
  assert.equal(JSON.parse(at('package.json')).version, '0.4.2');
  const lock = JSON.parse(at('package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version], ['0.4.2', '0.4.2']);
  assert.match(at('src/app.ts'), /version: '0\.4\.2'/);
  assert.deepEqual(at('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.2', '## 0.4.1', '## 0.4.0']);
  assert.match(at('CHANGELOG.md'), /## 0\.4\.2\n\n\*\*A feature\.\*\*/);
  assert.equal(sh(p.origin, 'ls-tree', '-r', '--name-only', 'refs/heads/claude/feature', 'changes/'), CHANGES_README, 'its file gone, the folder kept');
  assert.equal(at('src/other.ts'), 'export const other = 1;', "main's work in it");
  assert.equal(sh(p.origin, 'rev-parse', 'refs/heads/main'), p.main, 'never a push to main');
  assert.equal(s.head, sh(p.origin, 'rev-parse', 'refs/heads/claude/feature'));
  // What passed at its head holds at the stamped one: it merges untested.
  const t = testedBefore(e, { ...p.pr, headOid: s.head! });
  assert.equal(t?.ok, true);
  assert.equal(t?.carried, p.pr.headOid);
  assert.equal(r.gh.filter((a) => a[1] === 'edit').length, 0, 'its title already says its version');
  assert.equal(existsSync(path.join(p.dir, 'work', 'fake-stamp')), false, 'its worktree removed');
});

test('a version taken meanwhile: the next free one, its title following', async () => {
  const p = pending('stamp-taken');
  const r = runner(() => ok(''));
  const { e, ctx } = ctxOf(p, r.run);
  const s = await stamp(ctx, e, p.pr, { released: ['0.4.0', '0.4.1'], taken: ['0.4.2'], carry: null });
  assert.equal(s.done, true, s.note);
  assert.equal(s.note, 'stamped v0.4.3; v0.4.3 for changes/0.4.2.md, since other work holds v0.4.2');
  assert.equal(JSON.parse(sh(p.origin, 'show', 'refs/heads/claude/feature:package.json')).version, '0.4.3');
  assert.deepEqual(r.gh.find((a) => a[1] === 'edit')?.slice(-2), ['--title', 'Fake 0.4.3: a feature']);
  assert.equal(testedBefore(e, { ...p.pr, headOid: s.head! }), null, 'nothing to carry: it is tested at its new head');
});

test("an entry an older Steward left on main unstamped is stamped with the pull request's, below it", async () => {
  const p = pending('stamp-leftover', { leftover: true });
  const { e, ctx } = ctxOf(p);
  // main says 0.4.1 already, so the one left there gets the next free version, and the PR's its own above it.
  const s = await stamp(ctx, e, p.pr, { released: ['0.4.0', '0.4.1'], taken: [], carry: null });
  assert.equal(s.done, true, s.note);
  assert.deepEqual(s.stamped!.map((x) => [x.file, x.version]), [['changes/0.4.1.md', '0.4.2'], ['changes/0.4.2.md', '0.4.3']]);
  assert.deepEqual(sh(p.origin, 'show', 'refs/heads/claude/feature:CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.3', '## 0.4.2', '## 0.4.1', '## 0.4.0']);
});

test('a pull request with no entry merges as it is; an empty entry, or one naming another version, waits for its author', async () => {
  const none = pending('stamp-none', { file: 'docs/notes.md' });
  const a = ctxOf(none);
  const s = await stamp(a.ctx, a.e, none.pr, { released: [], taken: [], carry: null });
  assert.deepEqual([s.done, s.nothing], [false, true]);
  assert.equal(sh(none.origin, 'rev-parse', 'refs/heads/claude/feature'), none.pr.headOid, 'nothing pushed');

  const bad = pending('stamp-bad', { entry: '## 0.4.9\n\n**Wrong heading.**\n' });
  const b = ctxOf(bad);
  const s2 = await stamp(b.ctx, b.e, bad.pr, { released: [], taken: [], carry: null });
  assert.equal(s2.done, false);
  assert.match(s2.note, /changes\/0\.4\.2\.md says nothing, or its heading names another version/);
  assert.equal(sh(bad.origin, 'rev-parse', 'refs/heads/claude/feature'), bad.pr.headOid, 'nothing pushed');
});

test("a repository without changes/README.md isn't on the new format", async () => {
  const dir = path.join(home, 'old-format');
  const { checkout } = fakeEmployee(dir);
  const { e, ctx } = ctxOf({ dir, checkout });
  sh(checkout, 'fetch', '--quiet', 'origin');
  assert.equal(await usesChanges(ctx, e), false);
});
