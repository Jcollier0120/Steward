import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Entries written as changes/<version>.md, and the stamp that moves them into CHANGELOG.md and the version files on main
// at a build, through a PR of the Steward's own it merges itself: two pieces of work side by side never meet in the same lines.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-entries-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { changeFiles, changeVersion, CHANGES_README, changesReadme, entryBody, foldEntries, stampVersions } = await import('../src/entries.ts');
const { stampAll, stampBranch, stampDirOf, stampMain, stampTree, usesChanges } = await import('../src/stages/stamp.ts');
const { ctxFor, employee, fakeEmployee, mergesOf, ok, runner, sh } = await import('./helpers.ts');

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
 * An employee that writes its entries in changes/: main at 0.4.1 (stamped already, its entry in CHANGELOG.md), and on
 * it a piece of work merged as its author wrote it: changes/<version>.md beside a feature, no version file touched.
 */
function onMain(name: string, o: { entry?: string; file?: string; leftover?: boolean } = {}) {
  const dir = path.join(home, name);
  const { checkout, origin } = fakeEmployee(dir, { version: '0.4.0', files: { [CHANGES_README]: changesReadme('Fake'), 'CHANGELOG.md': "# Fake's changelog\n\n## 0.4.0\n\n**First.**\n" } });
  const write = (f: string, t: string) => (mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true }), writeFileSync(path.join(checkout, f), t));
  const read = (f: string) => readFileSync(path.join(checkout, f), 'utf8');
  // Another piece of work, stamped as 0.4.1.
  for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) write(f, read(f).split('0.4.0').join('0.4.1'));
  write('CHANGELOG.md', read('CHANGELOG.md').replace('## 0.4.0', `## 0.4.1\n\n${ENTRY('Something else.')}\n## 0.4.0`));
  write('src/other.ts', 'export const other = 1;\n');
  if (o.leftover) write('changes/0.4.1.md', ENTRY('Merged by an older Steward.'));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Fake 0.4.1: something else');
  // The feature, merged with its entry unstamped.
  write('src/feature.ts', 'export const feature = 1;\n');
  write(o.file ?? 'changes/0.4.2.md', o.entry ?? ENTRY('A feature.'));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'A feature');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  return { dir, checkout, origin, main: sh(checkout, 'rev-parse', 'HEAD') };
}

const RELEASES = [{ tagName: 'v0.4.1', isDraft: false, publishedAt: '2026-10-04T00:00:00Z' }, { tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' }];

/**
 * GitHub, standing in: main's head vouched for by the team when `vouched`, a stamp's PR opened as #31, and merged by
 * moving origin's main to the head it names (`mainBefore`: where main was when it was asked to).
 */
function github(p: { origin: string; main: string }, o: { vouched?: boolean } = {}) {
  const seen: { mainBefore?: string } = {};
  const r = runner((a) => {
    if (a[0] === 'release' && a[1] === 'list') return ok(RELEASES);
    if (a[0] === 'api' && a[1] === `repos/Jcollier0120/Fake/commits/${p.main}/statuses?per_page=100`) return ok(o.vouched ? [{ context: 'steward/tested', state: 'success', creator: { login: 'Jcollier0120' } }] : []);
    if (a[0] === 'api' && a[1].endsWith('/statuses?per_page=100')) return ok([]);
    if (a[0] === 'pr' && a[1] === 'create') return ok('https://github.com/Jcollier0120/Fake/pull/31\n');
    if (a[0] === 'pr' && a[1] === 'merge') {
      seen.mainBefore = sh(p.origin, 'rev-parse', 'refs/heads/main');
      sh(p.origin, 'update-ref', 'refs/heads/main', a[a.indexOf('--match-head-commit') + 1]);
      return ok('');
    }
    return ok('');
  });
  return { ...r, seen };
}

const ctxOf = (p: { dir: string; checkout: string }, run = runner(() => ok('')).run) => {
  const e = employee(p.checkout);
  return { e, ctx: ctxFor({ employees: [e], workRoot: path.join(p.dir, 'work'), run, neutralDir: p.dir }) };
};

test("a build stamps main's entries through a PR of its own, merged by it: the version set, the entry moved into the changelog", async () => {
  const p = onMain('stamp');
  const g = github(p, { vouched: true });
  const { e, ctx } = ctxOf(p, g.run);
  assert.equal(await usesChanges(ctx, e), true);
  const { results, merged } = await stampAll(ctx, [e]);
  assert.deepEqual(results.map((r) => [r.outcome, r.message, r.version, r.url]), [['done', 'stamp: stamped v0.4.2, and merged it', '0.4.2', 'https://github.com/Jcollier0120/Fake/pull/31']], ctx.lines.join('\n'));
  assert.deepEqual(merged, ['fake #31']);
  const branch = stampBranch(p.main);
  const stamped = sh(p.origin, 'rev-parse', `refs/heads/${branch}`);
  assert.equal(sh(p.origin, 'rev-parse', `${stamped}^`), p.main, "on main's head");
  assert.equal(g.seen.mainBefore, p.main, 'never a push to main: it moves by the PR alone');
  assert.equal(sh(p.origin, 'rev-parse', 'refs/heads/main'), stamped, 'merged');
  const at = (f: string) => sh(p.origin, 'show', `${stamped}:${f}`);
  assert.equal(JSON.parse(at('package.json')).version, '0.4.2');
  const lock = JSON.parse(at('package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version], ['0.4.2', '0.4.2']);
  assert.match(at('src/app.ts'), /version: '0\.4\.2'/);
  assert.deepEqual(at('CHANGELOG.md').split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.2', '## 0.4.1', '## 0.4.0']);
  assert.match(at('CHANGELOG.md'), /## 0\.4\.2\n\n\*\*A feature\.\*\*/);
  assert.equal(sh(p.origin, 'ls-tree', '-r', '--name-only', stamped, 'changes/'), CHANGES_README, 'its file gone, the folder kept');
  assert.deepEqual(sh(p.origin, 'diff', '--name-only', p.main, stamped).split('\n').sort(), ['CHANGELOG.md', 'changes/0.4.2.md', 'package-lock.json', 'package.json', 'src/app.ts'], 'only versions and entries');
  const title = 'Fake 0.4.2: version and changelog, stamped by the Steward';
  assert.equal(sh(p.origin, 'log', '-1', '--format=%s', stamped), title);
  const create = g.gh.find((a) => a[0] === 'pr' && a[1] === 'create')!;
  assert.deepEqual(['--base', '--head', '--title'].map((k) => create[create.indexOf(k) + 1]), ['main', branch, title]);
  assert.match(create[create.indexOf('--body-file') + 1], new RegExp(`The entries main carried at ${p.main.slice(0, 7)}, stamped: v0\\.4\\.2\\.`));
  assert.deepEqual(mergesOf(g.gh), [['pr', 'merge', '31', '--repo', 'Jcollier0120/Fake', '--merge', '--delete-branch']]);
  const merge = g.gh.find((a) => a[1] === 'merge')!;
  assert.equal(merge[merge.indexOf('--match-head-commit') + 1], stamped, 'at the head it pushed');
  // Only versions and entries changed: the vouch that covered main's head covers the stamp, so the build doesn't test it.
  const vouch = g.gh.find((a) => a[0] === 'api' && a.includes('-X'))!;
  assert.ok(vouch.includes(`repos/Jcollier0120/Fake/statuses/${stamped}`), vouch.join(' '));
  assert.ok(vouch.includes(`description=Only versions and changelog changed since ${p.main.slice(0, 7)}: Jcollier0120 vouched for ${p.main.slice(0, 7)}`), vouch.join(' '));
  assert.equal(existsSync(stampDirOf(ctx.settings, e)), false, 'its worktree removed');
});

test('a stamp of main no vouch covers carries none', async () => {
  const p = onMain('stamp-unvouched');
  const g = github(p);
  const { e, ctx } = ctxOf(p, g.run);
  const s = await stampMain(ctx, e, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.equal(s?.done, true, s?.note);
  assert.deepEqual(g.gh.filter((a) => a[0] === 'api' && a.includes('-X')), [], 'no status set: the build tests it');
});

test('a version taken meanwhile: the next free one, and why', () => {
  const p = onMain('stamp-taken');
  const s = stampTree(p.checkout, employee(p.checkout), { released: ['0.4.0', '0.4.1'], taken: ['0.4.2'] });
  if (!s || 'error' in s) return assert.fail(JSON.stringify(s));
  assert.equal(s.version, '0.4.3');
  assert.deepEqual(s.did, ['v0.4.3', 'v0.4.3 for changes/0.4.2.md, since other work holds v0.4.2']);
  assert.equal(JSON.parse(readFileSync(path.join(p.checkout, 'package.json'), 'utf8')).version, '0.4.3');
  assert.equal(existsSync(path.join(p.checkout, 'changes', '0.4.2.md')), false);
  assert.deepEqual([...new Set(s.changed)].sort(), ['CHANGELOG.md', 'changes/0.4.2.md', 'package-lock.json', 'package.json', 'src/app.ts']);
});

test('an entry an older Steward left on main unstamped is stamped with the newer one, below it', () => {
  const p = onMain('stamp-leftover', { leftover: true });
  // main says 0.4.1, released already, so the one left there gets the next free version, and the newer its own above it.
  const s = stampTree(p.checkout, employee(p.checkout), { released: ['0.4.0', '0.4.1'], taken: [] });
  if (!s || 'error' in s) return assert.fail(JSON.stringify(s));
  assert.equal(s.version, '0.4.3');
  assert.equal(s.did[0], 'v0.4.3 (with v0.4.2)');
  const log = readFileSync(path.join(p.checkout, 'CHANGELOG.md'), 'utf8');
  assert.deepEqual(log.split('\n').filter((l) => l.startsWith('## ')), ['## 0.4.3', '## 0.4.2', '## 0.4.1', '## 0.4.0']);
  assert.match(log, /## 0\.4\.3\n\n\*\*A feature\.\*\*[\s\S]*## 0\.4\.2\n\n\*\*Merged by an older Steward\.\*\*/);
});

test('main with no entry has nothing to stamp; an empty entry, or one naming another version, waits for its author', async () => {
  const none = onMain('stamp-none', { file: 'docs/notes.md' });
  const a = github(none);
  const n = ctxOf(none, a.run);
  assert.equal(await stampMain(n.ctx, n.e, { released: ['0.4.0', '0.4.1'], taken: [] }), null);
  assert.deepEqual(a.gh, [], 'nothing asked of GitHub');
  assert.equal(sh(none.origin, 'for-each-ref', 'refs/heads/steward/'), '', 'nothing pushed');
  assert.equal(existsSync(stampDirOf(n.ctx.settings, n.e)), false, 'no worktree made');

  const bad = onMain('stamp-bad', { entry: '## 0.4.9\n\n**Wrong heading.**\n' });
  const b = github(bad);
  const x = ctxOf(bad, b.run);
  const s = await stampMain(x.ctx, x.e, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.equal(s?.done, false);
  assert.equal(s?.note, `its entries on main at ${bad.main.slice(0, 7)} weren't stamped: changes/0.4.2.md says nothing, or its heading names another version: that needs its author`);
  assert.equal(sh(bad.origin, 'for-each-ref', 'refs/heads/steward/'), '', 'nothing pushed');
  assert.equal(sh(bad.origin, 'rev-parse', 'refs/heads/main'), bad.main);
  assert.deepEqual(b.gh.filter((g) => g[0] === 'pr'), [], 'no PR');
  assert.equal(existsSync(stampDirOf(x.ctx.settings, x.e)), false, 'its worktree removed');
});

test("a repository without changes/README.md isn't on the new format", async () => {
  const dir = path.join(home, 'old-format');
  const { checkout } = fakeEmployee(dir);
  const { e, ctx } = ctxOf({ dir, checkout });
  sh(checkout, 'fetch', '--quiet', 'origin');
  assert.equal(await usesChanges(ctx, e), false);
});
