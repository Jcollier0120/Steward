import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The stamp at a build (stages/stamp.ts): main's unstamped entries in changes/ made one version and one changelog entry,
// above every version released or claimed, on a branch of the Steward's own, through a PR it opens and merges itself;
// what covered main's head covers the stamp. A data folder of its own, a fake employee's git, gh standing in for GitHub.
// By its real path, as git and the work folder (workRootOf) spell it.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-stamp-main-')));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { CHANGES_README, changesReadme, fragmentFor } = await import('../src/entries.ts');
const { stampAll, stampBranch, stampDirOf, stampMain, stampTree } = await import('../src/stages/stamp.ts');
const { mainGate } = await import('../src/stages/mainbuild.ts');
const { releaseUnreleased } = await import('../src/stages/round.ts');
const { TAG_RELEASE } = await import('../src/settings.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { claimsFile } = await import('../src/claims.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const REPO = 'Jcollier0120/Fake';
const PR_URL = 'https://github.com/Jcollier0120/Fake/pull/41';
const ENTRY = (line: string) => `**${line}**\n\n### What changed\n\n- ${line}\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n`;
const CHANGELOG = (...versions: [string, string][]) => `# Fake's changelog\n\n${versions.map(([v, line]) => `## ${v}\n\n**${line}**\n`).join('\n')}`;
const headings = (text: string) => text.split(/\r?\n/).filter((l) => l.startsWith('## '));
const byTeam = { context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } };

/** A folder as a stamp's worktree is: the version files at `version`, CHANGELOG.md, changes/README.md, and `files`. */
function folder(name: string, version: string, files: Record<string, string>, changelog = CHANGELOG([version, 'Something else.'], ['0.4.0', 'First.'])) {
  const dir = path.join(tmp, name);
  const all: Record<string, string> = {
    'package.json': `{\n  "name": "fake",\n  "version": "${version}"\n}\n`,
    'package-lock.json': `{\n  "name": "fake",\n  "version": "${version}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "fake",\n      "version": "${version}"\n    }\n  }\n}\n`,
    'src/app.ts': `export const APP = {\n  id: 'fake',\n  version: '${version}',\n};\n`,
    'CHANGELOG.md': changelog,
    [CHANGES_README]: changesReadme('Fake'),
    ...files,
  };
  for (const [f, t] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), t);
  }
  const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
  const versions = () => {
    const lock = JSON.parse(read('package-lock.json'));
    return [JSON.parse(read('package.json')).version, lock.version, lock.packages[''].version, /version: '([^']+)'/.exec(read('src/app.ts'))?.[1]];
  };
  return { dir, e: employee(dir), read, versions, changes: () => readdirSync(path.join(dir, 'changes')) };
}

/** What stampTree did, when it did (and not an error). */
function stamped(s: ReturnType<typeof stampTree>) {
  assert.ok(s && !('error' in s), JSON.stringify(s));
  return s as { changed: string[]; did: string[]; version: string };
}

test("stampTree: every entry on main is made one version, above every version released or claimed, with one changelog entry", () => {
  const t = folder('tree-fragments', '0.4.1', { [fragmentFor('claude/feature')]: ENTRY('A feature.'), [fragmentFor('claude/fix')]: ENTRY('A fix.') });
  const s = stamped(stampTree(t.dir, t.e, { released: ['0.4.0', '0.4.1'], taken: ['0.4.2'] }));
  assert.equal(s.version, '0.4.3', 'above v0.4.1 released and v0.4.2 claimed');
  assert.deepEqual(s.did, ['v0.4.3']);
  assert.deepEqual(t.versions(), ['0.4.3', '0.4.3', '0.4.3', '0.4.3']);
  assert.deepEqual(headings(t.read('CHANGELOG.md')), ['## 0.4.3', '## 0.4.1', '## 0.4.0']);
  assert.match(t.read('CHANGELOG.md'), /## 0\.4\.3\n\n\*\*Brings 2 changes: A feature; A fix\.\*\*\n\n### What changed\n\n- A feature\.\n- A fix\.\n/);
  assert.deepEqual(t.changes(), ['README.md'], 'the entries gone, the folder kept');
  assert.deepEqual([...new Set(s.changed)].sort(), ['CHANGELOG.md', 'changes/claude-feature.md', 'changes/claude-fix.md', 'package-lock.json', 'package.json', 'src/app.ts']);
});

test('stampTree: an entry named by a version keeps it while it is free, else takes the next free one, and an entry named by its branch joins it', () => {
  const claimed = folder('tree-claimed', '0.4.1', { 'changes/0.4.2.md': ENTRY('A fix.') });
  const s = stamped(stampTree(claimed.dir, claimed.e, { released: ['0.4.0', '0.4.1'], taken: ['0.4.2'] }));
  assert.equal(s.version, '0.4.3');
  assert.deepEqual(s.did, ['v0.4.3', 'v0.4.3 for changes/0.4.2.md, since other work holds v0.4.2']);
  assert.deepEqual(claimed.versions(), ['0.4.3', '0.4.3', '0.4.3', '0.4.3']);

  const both = folder('tree-both', '0.4.1', { 'changes/0.4.2.md': ENTRY('A fix.'), [fragmentFor('claude/feature')]: ENTRY('A feature.') });
  const b = stamped(stampTree(both.dir, both.e, { released: ['0.4.0', '0.4.1'], taken: [] }));
  assert.equal(b.version, '0.4.2');
  assert.deepEqual(b.did, ['v0.4.2', 'v0.4.2, its entry joining the changes that release brings']);
  assert.deepEqual(headings(both.read('CHANGELOG.md')), ['## 0.4.2', '## 0.4.1', '## 0.4.0'], 'one entry for the one version');
  assert.match(both.read('CHANGELOG.md'), /## 0\.4\.2\n\n\*\*Brings 2 changes: A fix; A feature\.\*\*/);
  assert.deepEqual(both.changes(), ['README.md']);
});

test("stampTree: main's version not released yet takes the entries into its own entry, the version files left as they are", () => {
  const t = folder('tree-waiting', '0.4.1', { [fragmentFor('claude/feature')]: ENTRY('A feature.') });
  const s = stamped(stampTree(t.dir, t.e, { released: ['0.4.0'], taken: [] }));
  assert.equal(s.version, '0.4.1');
  assert.deepEqual(s.did, ['v0.4.1, its entry joining the changes that release brings']);
  assert.deepEqual(t.versions(), ['0.4.1', '0.4.1', '0.4.1', '0.4.1']);
  assert.deepEqual(headings(t.read('CHANGELOG.md')), ['## 0.4.1', '## 0.4.0']);
  assert.match(t.read('CHANGELOG.md'), /## 0\.4\.1\n\n\*\*Brings 2 changes: Something else; A feature\.\*\*/);
  assert.deepEqual([...new Set(s.changed)].sort(), ['CHANGELOG.md', 'changes/claude-feature.md'], 'no version file changed');
});

test('stampTree: nothing to stamp is null and touches nothing; an empty entry, or versions that disagree, is an error', () => {
  const none = folder('tree-none', '0.4.1', {});
  const before = none.read('CHANGELOG.md');
  assert.equal(stampTree(none.dir, none.e, { released: ['0.4.0', '0.4.1'], taken: [] }), null);
  assert.equal(none.read('CHANGELOG.md'), before);

  const empty = folder('tree-empty', '0.4.1', { [fragmentFor('claude/empty')]: '\n\n' });
  assert.deepEqual(stampTree(empty.dir, empty.e, { released: ['0.4.0', '0.4.1'], taken: [] }), { error: 'changes/claude-empty.md says nothing: that needs its author' });
  assert.deepEqual(empty.changes().sort(), ['README.md', 'claude-empty.md'], 'left for its author');

  const torn = folder('tree-torn', '0.4.1', { [fragmentFor('claude/feature')]: ENTRY('A feature.'), 'src/app.ts': "export const APP = {\n  version: '0.4.0',\n};\n" });
  const r = stampTree(torn.dir, torn.e, { released: ['0.4.0', '0.4.1'], taken: [] });
  assert.match((r as { error: string }).error, /^its version can't be read: the version files disagree/);
});

/**
 * A repository on changes/: main at 0.4.0 (released), `entries` merged into it unstamped beside a feature. GitHub stands
 * in: statuses kept by commit (a team member's vouch on main's head when `vouched`), PRs opened as #41, #42…, listed
 * while open, merged by moving main to their head and deleting their branch (unless `refuse` says why not; it may be
 * changed between builds), and closed by deleting their branch. A release it is asked to make is kept, with its commit
 * and its notes.
 */
function onMain(name: string, entries: Record<string, string>, o: { vouched?: boolean; refuse?: string } = {}) {
  const dir = path.join(tmp, name);
  const f = fakeEmployee(dir, { version: '0.4.0', files: { [CHANGES_README]: changesReadme('Fake'), 'CHANGELOG.md': CHANGELOG(['0.4.0', 'First.']) } });
  for (const [file, text] of Object.entries({ 'src/feature.ts': 'export const feature = 1;\n', ...entries })) {
    mkdirSync(path.dirname(path.join(f.checkout, file)), { recursive: true });
    writeFileSync(path.join(f.checkout, file), text);
  }
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'A feature');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  const statuses = new Map<string, unknown[]>(o.vouched ? [[head, [byTeam]]] : []);
  const opened: { main: string; branch: string }[] = [];
  const prs: { number: number; branch: string; open: boolean }[] = [];
  const releases: { tag: string; target: string; notes: string | null }[] = [];
  const prOf = (a: string[]) => prs.find((p) => p.number === Number(a[2]))!;
  const r = runner((a) => {
    const read = /^repos\/Jcollier0120\/Fake\/commits\/([0-9a-f]{40})\/statuses\?per_page=100$/.exec(a[1] ?? '');
    if (a[0] === 'api' && read) return ok(statuses.get(read[1]) ?? []);
    if (a[0] === 'api' && a[2] === 'POST') {
      const field = (k: string) => a.find((x) => x.startsWith(`${k}=`))!.slice(k.length + 1);
      const sha = a[3].split('/').pop()!;
      statuses.set(sha, [{ context: field('context'), state: field('state'), description: field('description'), creator: { login: 'Jcollier0120' } }, ...(statuses.get(sha) ?? [])]);
      return ok('{}');
    }
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-01T00:00:00Z' }]);
    if (a[0] === 'release' && a[1] === 'create') {
      const notes = a.indexOf('--notes-file');
      releases.push({ tag: a[2], target: a[a.indexOf('--target') + 1], notes: notes >= 0 ? readFileSync(a[notes + 1], 'utf8') : null });
      return ok(`https://github.com/${REPO}/releases/tag/${a[2]}\n`);
    }
    if (a[0] === 'pr' && a[1] === 'create') {
      const branch = a[a.indexOf('--head') + 1];
      opened.push({ main: sh(f.origin, 'rev-parse', 'refs/heads/main'), branch: sh(f.origin, 'rev-parse', `refs/heads/${branch}`) });
      const number = 41 + prs.length;
      prs.push({ number, branch, open: true });
      return ok(`\nCreating pull request for ${branch} into main in ${REPO}\n\n${PR_URL.replace(/41$/, String(number))}\n`);
    }
    if (a[0] === 'pr' && a[1] === 'list') {
      return ok(prs.filter((p) => p.open).map((p) => ({ number: p.number, headRefName: p.branch, headRefOid: sh(f.origin, 'rev-parse', `refs/heads/${p.branch}`), url: PR_URL.replace(/41$/, String(p.number)) })));
    }
    if (a[0] === 'pr' && a[1] === 'close') {
      const p = prOf(a);
      p.open = false;
      if (a.includes('--delete-branch')) sh(f.origin, 'update-ref', '-d', `refs/heads/${p.branch}`);
      return ok('');
    }
    if (a[0] === 'pr' && a[1] === 'merge') {
      if (o.refuse) return { code: 1, out: '', err: o.refuse };
      const p = prOf(a);
      const ref = `refs/heads/${p.branch}`;
      const at = sh(f.origin, 'rev-parse', ref);
      if (a[a.indexOf('--match-head-commit') + 1] !== at) return { code: 1, out: '', err: 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)' };
      sh(f.origin, 'update-ref', 'refs/heads/main', at);
      if (a.includes('--delete-branch')) sh(f.origin, 'update-ref', '-d', ref);
      p.open = false;
      return ok('');
    }
  });
  // Its checks here would fail: a release that needs no test proves they weren't run.
  const e = employee(f.checkout, { fill: '', test: ['node -e process.exit(1)'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  const at = (rev: string, file: string) => sh(f.origin, 'show', `${rev}:${file}`);
  return { ...f, e, ctx, r, o, head, statuses, opened, releases, at, main: () => sh(f.origin, 'rev-parse', 'refs/heads/main'), stampRefs: () => sh(f.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/steward/') };
}

test('main with nothing unstamped: no stamp, no worktree, no branch, and GitHub not asked', async () => {
  const p = onMain('stamp-nothing', {});
  assert.equal(await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: [] }), null);
  assert.deepEqual(p.r.gh, []);
  assert.equal(p.stampRefs(), '');
  assert.equal(p.main(), p.head);
  assert.equal(existsSync(stampDirOf(p.ctx.settings, p.e)), false);

  // Nor without a clone.
  const gone = employee(path.join(tmp, 'no-such-clone'));
  assert.equal(await stampMain(p.ctx, gone, { released: [], taken: [] }), null);
});

test("main's entries are stamped on steward/stamp-<sha7>, never on main: a PR opened from it, and merged by the Steward at the stamp's head", async () => {
  const p = onMain('stamp-merged', { [fragmentFor('claude/feature')]: ENTRY('A feature.'), [fragmentFor('claude/fix')]: ENTRY('A fix.') });
  const sha = p.head.slice(0, 7);
  const s = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: ['0.4.1'] });
  assert.ok(s, p.ctx.lines.join('\n'));
  assert.deepEqual(s, { done: true, note: 'stamped v0.4.2, and merged it', version: '0.4.2', url: PR_URL }, p.ctx.lines.join('\n'));
  assert.equal(stampBranch(p.head), `steward/stamp-${sha}`);

  // Pushed to its own branch, and the PR opened while main was still at its head.
  const stamp = p.main();
  assert.deepEqual(p.opened, [{ main: p.head, branch: stamp }]);
  const create = p.r.gh.find((a) => a[1] === 'create')!;
  assert.deepEqual(create.slice(0, 11), ['pr', 'create', '--repo', REPO, '--base', 'main', '--head', `steward/stamp-${sha}`, '--title', 'Fake 0.4.2: version and changelog, stamped by the Steward', '--body-file']);
  assert.match(create[11], new RegExp(`^The entries main carried at ${sha}, stamped: v0\\.4\\.2\\.\\n`));
  // Merged by the Steward at the stamp's head, its branch deleted.
  assert.deepEqual(p.r.gh.filter((a) => a[1] === 'merge'), [['pr', 'merge', '41', '--repo', REPO, '--merge', '--match-head-commit', stamp, '--delete-branch']]);
  assert.equal(p.stampRefs(), '');

  // One commit on main's head: the version set everywhere, the entries in one changelog entry, their files gone.
  assert.equal(sh(p.origin, 'rev-parse', `${stamp}^`), p.head);
  assert.deepEqual(sh(p.origin, 'diff', '--name-only', p.head, stamp).split('\n').sort(), ['CHANGELOG.md', 'changes/claude-feature.md', 'changes/claude-fix.md', 'package-lock.json', 'package.json', 'src/app.ts']);
  assert.equal(JSON.parse(p.at(stamp, 'package.json')).version, '0.4.2');
  const lock = JSON.parse(p.at(stamp, 'package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version], ['0.4.2', '0.4.2']);
  assert.match(p.at(stamp, 'src/app.ts'), /version: '0\.4\.2'/);
  assert.deepEqual(headings(p.at(stamp, 'CHANGELOG.md')), ['## 0.4.2', '## 0.4.0']);
  assert.match(p.at(stamp, 'CHANGELOG.md'), /## 0\.4\.2\n\n\*\*Brings 2 changes: A feature; A fix\.\*\*/);
  assert.equal(sh(p.origin, 'ls-tree', '-r', '--name-only', stamp, 'changes/'), CHANGES_README);

  // Nothing covered main's head, so nothing is carried: the build tests the stamp.
  assert.ok(!p.r.gh.some((a) => a[0] === 'api' && a[2] === 'POST'));
  assert.equal(existsSync(stampDirOf(p.ctx.settings, p.e)), false, 'its worktree removed');
});

test("a vouch that covered main's head is carried to the stamp before its PR opens, so the build releases it untested", async () => {
  const p = onMain('stamp-vouched', { [fragmentFor('claude/feature')]: ENTRY('A feature.') }, { vouched: true });
  const sha = p.head.slice(0, 7);
  const s = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: [] });
  assert.deepEqual([s?.done, s?.version], [true, '0.4.1'], s?.note);
  const stamp = p.main();
  const set = p.r.gh.findIndex((a) => a[0] === 'api' && a[2] === 'POST');
  assert.deepEqual(p.r.gh[set], ['api', '-X', 'POST', `repos/${REPO}/statuses/${stamp}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`, '-f', `description=Only versions and changelog changed since ${sha}: Jcollier0120 vouched for ${sha}`]);
  assert.ok(set < p.r.gh.findIndex((a) => a[1] === 'create'), 'before its PR is opened');

  // The build after: the stamp is covered, and its checks (which would fail here) never run.
  assert.equal(await mainGate(p.ctx, p.e, stamp, '0.4.0'), null, p.ctx.lines.join('\n'));
  assert.ok(p.ctx.lines.includes(`[fake] Jcollier0120 vouched for ${stamp.slice(0, 7)}: not tested again before its release`), p.ctx.lines.join('\n'));
});

test("a stamp GitHub won't merge is left open, and said so; an entry that says nothing isn't stamped, and nothing is pushed", async () => {
  const refuse = 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)';
  const p = onMain('stamp-refused', { [fragmentFor('claude/feature')]: ENTRY('A feature.') }, { refuse });
  const s = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: [] });
  assert.deepEqual(s, { done: false, note: `stamped v0.4.1, but its PR is open still (GitHub wouldn't merge #41: ${refuse}): the next build merges it, and then releases it`, version: '0.4.1', url: PR_URL });
  assert.equal(p.main(), p.head, 'main as it was');
  assert.equal(p.stampRefs(), `refs/heads/steward/stamp-${p.head.slice(0, 7)}`);

  const q = onMain('stamp-empty', { [fragmentFor('claude/empty')]: '\n' });
  const e = await stampMain(q.ctx, q.e, { released: ['0.4.0'], taken: [] });
  assert.deepEqual(e, { done: false, note: `its entries on main at ${q.head.slice(0, 7)} weren't stamped: changes/claude-empty.md says nothing: that needs its author` });
  assert.deepEqual(q.r.gh.map((a) => a.slice(0, 2)), [['pr', 'list']], 'only its open stamps looked for: nothing opened');
  assert.equal(q.stampRefs(), '');
  assert.equal(existsSync(stampDirOf(q.ctx.settings, q.e)), false, 'its worktree removed');
});

test("a stamp an earlier build left open is merged by the next while main hasn't moved, never stamped twice; once main has moved, it is closed and main stamped again", async () => {
  const refuse = 'GraphQL: Pull request is not mergeable (mergePullRequest)';
  const p = onMain('stamp-left-open', { [fragmentFor('claude/feature')]: ENTRY('A feature.') }, { refuse });
  const first = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: [] });
  assert.equal(first?.done, false);
  const left = sh(p.origin, 'rev-parse', `refs/heads/steward/stamp-${p.head.slice(0, 7)}`);

  // The next build, GitHub willing now: the stamp left open is merged as it is, with no second commit or push.
  delete p.o.refuse;
  const next = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: [] });
  assert.deepEqual(next, { done: true, note: `merged its stamp #41 of ${p.head.slice(0, 7)}, left open by an earlier build`, url: PR_URL });
  assert.equal(p.main(), left, 'main at the stamp first pushed');
  assert.equal(p.r.gh.filter((a) => a[1] === 'create').length, 1, 'one PR, opened once');
  assert.equal(p.stampRefs(), '');

  // Left open while main moved on: closed, its branch deleted, and main's entries stamped again from its new head.
  const q = onMain('stamp-moved-past', { [fragmentFor('claude/feature')]: ENTRY('A feature.') }, { refuse });
  await stampMain(q.ctx, q.e, { released: ['0.4.0'], taken: [] });
  writeFileSync(path.join(q.checkout, 'src/more.ts'), 'export const more = 1;\n');
  sh(q.checkout, 'add', '-A');
  sh(q.checkout, 'commit', '--quiet', '-m', 'More');
  sh(q.checkout, 'push', '--quiet', 'origin', 'main');
  const moved = sh(q.checkout, 'rev-parse', 'HEAD');
  delete q.o.refuse;
  const again = await stampMain(q.ctx, q.e, { released: ['0.4.0'], taken: [] });
  assert.equal(again?.done, true, again?.note);
  assert.equal(again?.url, PR_URL.replace(/41$/, '42'));
  assert.deepEqual(q.r.gh.filter((a) => a[1] === 'close').map((a) => a.slice(0, 3)), [['pr', 'close', '41']]);
  assert.ok(q.r.gh.find((a) => a[1] === 'close')!.includes(`main has moved on to ${moved.slice(0, 7)}: the Steward stamps it again from there.`));
  assert.equal(sh(q.origin, 'rev-parse', 'refs/heads/main^'), moved, "main's new head, stamped");
  assert.equal(q.stampRefs(), '', 'both stamp branches gone');
});

test("over plain git, main's entries aren't stamped: no PR to stamp through, nothing pushed, and gh never run", async () => {
  const p = onMain('stamp-plain-git', { [fragmentFor('claude/feature')]: ENTRY('A feature.') });
  const ctx = { ...p.ctx, host: () => 'git' as const };
  const s = await stampMain(ctx, p.e, { released: ['0.4.0'], taken: [] });
  assert.equal(s?.skipped, true);
  assert.match(s?.note ?? '', /worked with plain git, where the Steward opens no PRs and never pushes to main/);
  assert.deepEqual(p.r.gh, []);
  assert.equal(p.stampRefs(), '');
  assert.equal(p.main(), p.head);
});

test("a build's stamps: each repository against its releases and the versions claimed on it; the stamp PRs merged are named", async () => {
  const p = onMain('stamp-all', { [fragmentFor('claude/feature')]: ENTRY('A feature.') });
  const quiet = onMain('stamp-all-quiet', {});
  const other = employee(quiet.checkout, { id: 'quiet', name: 'Quiet', repo: 'Jcollier0120/Quiet' });
  writeJson(claimsFile(), [{ repo: REPO, version: '0.4.1', branch: 'claude/other', by: 'claude', for: 'other work', at: new Date().toISOString() }]);
  try {
    const { results, merged } = await stampAll(p.ctx, [p.e, other]);
    assert.deepEqual(results, [{ id: 'fake', name: 'Fake', outcome: 'done', message: 'stamp: stamped v0.4.2, and merged it', url: PR_URL, version: '0.4.2' }], p.ctx.lines.join('\n'));
    assert.deepEqual(merged, ['fake #41']);
    assert.equal(JSON.parse(p.at(p.main(), 'package.json')).version, '0.4.2', 'above v0.4.1, claimed');
    assert.equal(quiet.main(), quiet.head, 'nothing to stamp there');
  } finally {
    writeJson(claimsFile(), []);
  }
});

test("a version stamped but not released, stamped again at a build that then releases it: the release is of that second stamp, its notes with every change", async () => {
  // Steward 0.36.160. On 2026-10-19 the owner's build stamped Manor 0.17.2 again (#321, the Seneschal's entry joining
  // the two it had) and then released v0.17.2 from the commit before that stamp: the round's glance, taken as it began,
  // and the clone both said that commit, so the release fetched nothing, and its CHANGELOG lacked the Seneschal.
  const p = onMain('stamp-again-release', { [fragmentFor('claude/feature')]: ENTRY('A feature.') }, { vouched: true });
  const e = { ...p.e, release: TAG_RELEASE };
  // An earlier build stamped v0.4.1, and didn't release it.
  assert.equal((await stampMain(p.ctx, e, { released: ['0.4.0'], taken: [] }))?.version, '0.4.1', p.ctx.lines.join('\n'));
  // A PR merged since, its entry unstamped, vouched for.
  sh(p.checkout, 'fetch', '--quiet', 'origin');
  sh(p.checkout, 'reset', '--quiet', '--hard', 'origin/main');
  writeFileSync(path.join(p.checkout, 'src/fix.ts'), 'export const fix = 1;\n');
  writeFileSync(path.join(p.checkout, fragmentFor('claude/fix')), ENTRY('A fix.'));
  sh(p.checkout, 'add', '-A');
  sh(p.checkout, 'commit', '--quiet', '-m', 'A fix');
  sh(p.checkout, 'push', '--quiet', 'origin', 'main');
  const before = p.main();
  p.statuses.set(before, [byTeam]);
  // The build's round: its glance says main is at that commit, as the clone does.
  p.ctx.glance = { at: new Date().toISOString(), stewardReleases: null, repos: { fake: { head: before, prs: [], releases: [{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-01T00:00:00Z', commit: null }] } }, errors: {} };
  assert.equal(sh(p.checkout, 'rev-parse', 'refs/remotes/origin/main'), before);

  const { results } = await stampAll(p.ctx, [e]);
  assert.deepEqual(results.map((r) => r.message), ['stamp: stamped v0.4.1, its entry joining the changes that release brings, and merged it'], p.ctx.lines.join('\n'));
  const stamp = p.main();
  assert.equal(sh(p.origin, 'rev-parse', `${stamp}^`), before);

  const [released] = await releaseUnreleased(p.ctx, [e]);
  assert.equal(released.outcome, 'done', `${released.message}\n${p.ctx.lines.join('\n')}`);
  assert.equal(released.commit, stamp.slice(0, 7), 'released from the stamp it merged, not from the commit before');
  assert.deepEqual(p.releases.map((r) => [r.tag, r.target]), [['v0.4.1', stamp]]);
  assert.match(p.releases[0].notes ?? '', /\*\*Brings 2 changes: A feature; A fix\.\*\*/);
});
