import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A release's notes, from the repository's CHANGELOG.md (notes.ts, spec/RELEASE-NOTES.md).
const { combinedEntry, commitLine, commitsSince, entriesBetween, entryOf, entryWarnings, headingVersion, headlineOf, releaseNotes, sectionOf, withEntry, NOTHING_TO_DO } = await import('./fixture/src/kit/notes.ts');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'notes-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const changelog = [
  "# Fake's changelog",
  '',
  'Each version, newest first.',
  '',
  '## 0.4.2',
  '',
  '**Scans twice as fast.** More below.',
  '',
  "### What's new",
  '',
  '- A Pause button.',
  '',
  '### What changed',
  '',
  '- Scans run on the NPU.',
  '',
  '### Before you update',
  '',
  '- Its index is rebuilt on first start (a few minutes).',
  '',
  '## 0.4.1',
  '',
  'A fix.',
  '',
].join('\r\n');

test("a version's entry is what's under its heading, up to the next; any heading style; none for a version it lacks", () => {
  assert.equal(headingVersion('## 0.4.2'), '0.4.2');
  assert.equal(headingVersion('## v0.4.2'), '0.4.2');
  assert.equal(headingVersion('## [0.4.2] - 2026-10-05'), '0.4.2');
  assert.equal(headingVersion('## 0.4.20'), '0.4.20');
  assert.equal(headingVersion('### 0.4.2'), null);
  assert.equal(headingVersion('## Unreleased'), null);
  const e = entryOf(changelog, '0.4.2')!;
  assert.match(e, /^\*\*Scans twice as fast\.\*\*/);
  assert.match(e, /rebuilt on first start \(a few minutes\)\.$/);
  assert.doesNotMatch(e, /A fix/);
  assert.equal(entryOf(changelog, '0.4.1'), 'A fix.');
  assert.equal(entryOf(changelog, '0.4.3'), null);
  assert.equal(entryOf('## 0.4.3\n\n## 0.4.2\n', '0.4.3'), null, 'a heading with nothing under it is no entry');
});

test("an entry's sections and headline; what it lacks, in words", () => {
  const e = entryOf(changelog, '0.4.2')!;
  assert.equal(sectionOf(e, "What's new"), '- A Pause button.');
  assert.equal(sectionOf(e, 'before you update'), '- Its index is rebuilt on first start (a few minutes).');
  assert.equal(sectionOf(e, 'Nope'), null);
  assert.equal(headlineOf(e), 'Scans twice as fast.');
  assert.equal(headlineOf('Fixed a crash. And more.'), 'Fixed a crash.');
  assert.equal(headlineOf('### What changed\n\n- x'), null);
  assert.deepEqual(entryWarnings(e), []);
  const lacking = entryWarnings('A fix.');
  assert.equal(lacking.length, 2);
  assert.match(lacking[0], /neither "### What's new" nor "### What changed"/);
  assert.match(lacking[1], /no "### Before you update".*Nothing: it updates itself as usual\./);
  assert.match(entryWarnings('### What changed\n\n- x\n\n### Before you update\n')[0], /is empty/);
});

test('the notes: the first line Manor reads, the entry without its heading, then how to install it', () => {
  const n = releaseNotes({ root: tmp, name: 'Fake', version: '0.4.2', commit: 'abc1234', kit: '2.19.0', install: 'Unpack it.', changelog });
  assert.equal(n.from, 'changelog');
  assert.deepEqual(n.warnings, []);
  const lines = n.notes.split('\n');
  assert.equal(lines[0], "Fake 0.4.2, built from abc1234, with the Steward's kit 2.19.0.");
  assert.match(lines[0], /\bbuilt from ([0-9a-f]{7,40})\b/, "Manor's releases.ts reads the commit from it");
  assert.equal(lines[2], '**Scans twice as fast.** More below.');
  assert.doesNotMatch(n.notes, /## 0\.4\.2|\r/);
  assert.match(n.notes, /### Before you update\n\n- Its index is rebuilt/);
  assert.match(n.notes, /### Installing\n\nUnpack it\.\n$/);
  // No kit: the first line says none.
  assert.equal(releaseNotes({ root: tmp, name: 'Fake', version: '0.4.2', commit: 'abc1234', install: 'x', changelog }).notes.split('\n')[0], 'Fake 0.4.2, built from abc1234.');
});

test('a version with no entry: its commits since the release before, said so, and a warning', () => {
  const n = releaseNotes({ root: tmp, name: 'Fake', version: '0.4.3', commit: 'abc1234', install: 'x', changelog, commits: { since: 'v0.4.2', lines: ['Fake 0.4.3: a fix', 'Fake 0.4.3: another'] } });
  assert.equal(n.from, 'commits');
  assert.match(n.warnings[0], /no "## 0\.4\.3" entry/);
  assert.match(n.notes, /### What changed\n\nNo changelog entry was written for this version\. These are its commits since v0\.4\.2:\n\n- Fake 0\.4\.3: a fix\n- Fake 0\.4\.3: another\n/);
  const none = releaseNotes({ root: tmp, name: 'Fake', version: '0.4.3', commit: 'abc1234', install: 'x', changelog: null, commits: { since: null, lines: [] } });
  assert.match(none.warnings[0], /there's no CHANGELOG\.md/);
  assert.match(none.notes, /No changelog entry was written for this version\.\n/);
});

test("a commit's line: a PR's title, a commit's subject; merges of branches and wip say nothing", () => {
  assert.equal(commitLine('Merge pull request #63 from Jcollier0120/claude/x', 'Manor 0.4.49: a setup carries built releases only\n\nmore'), 'Manor 0.4.49: a setup carries built releases only');
  assert.equal(commitLine("Merge remote-tracking branch 'origin/main' into claude/x", ''), null);
  assert.equal(commitLine("Merge branch 'main'", ''), null);
  assert.equal(commitLine('wip', ''), null);
  assert.equal(commitLine('Fake 0.4.3: a fix', 'body'), 'Fake 0.4.3: a fix');
});

test('the commits since the newest tag below the version, on the first-parent line', () => {
  const repo = path.join(tmp, 'repo');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const commit = (msg: string) => {
    writeFileSync(path.join(repo, 'f.txt'), msg);
    git('add', '.');
    git('commit', '--quiet', '-m', msg);
  };
  commit('first');
  git('tag', 'v0.4.0');
  commit('Fake 0.4.1: one');
  git('tag', 'v0.4.1');
  commit('Fake 0.4.2: two');
  commit('wip');
  commit('Fake 0.4.2: three');
  assert.deepEqual(commitsSince(repo, '0.4.2'), { since: 'v0.4.1', lines: ['Fake 0.4.2: three', 'Fake 0.4.2: two'] });
  // A version a tag above it already names doesn't count that tag.
  git('tag', 'v0.4.9');
  assert.equal(commitsSince(repo, '0.4.2').since, 'v0.4.1');
  assert.deepEqual(commitsSince(path.join(tmp, 'nowhere'), '0.4.2'), { since: null, lines: [] });
});

test('an entry goes at the top of the changelog, or starts one; never twice', () => {
  const entry = `## 0.4.3\n\n**A fix.**\n\n### Before you update\n\n${NOTHING_TO_DO}`;
  const added = withEntry(changelog, entry, 'Fake');
  assert.ok(added.includes('\r\n'), 'its line endings kept');
  const lf = added.replace(/\r\n/g, '\n');
  assert.match(lf, /^# Fake's changelog\n\nEach version, newest first\.\n\n## 0\.4\.3\n\n\*\*A fix\.\*\*\n\n### Before you update\n\nNothing: it updates itself as usual\.\n\n## 0\.4\.2\n/);
  assert.equal(withEntry(added, entry, 'Fake'), added);
  const started = withEntry(null, entry, 'Fake');
  assert.match(started, /^# Fake's changelog\n\nEach version of Fake, newest first\..*\n\n## 0\.4\.3\n\n\*\*A fix\.\*\*\n/s);
  assert.ok(started.endsWith(`${NOTHING_TO_DO}\n`));
  assert.equal(entryOf(started, '0.4.3'), `**A fix.**\n\n### Before you update\n\n${NOTHING_TO_DO}`);
});

test('a release brings the entries of the versions merged since the release before and never released on their own', () => {
  const e = (line: string) => `**${line}**\n\n### What changed\n\n- ${line}\n\n### Before you update\n\n- ${NOTHING_TO_DO}`;
  const log = `# Fake's changelog\n\n## 0.4.4\n\n${e('Four.')}\n\n## 0.4.3\n\n${e('Three.')}\n\n## 0.4.2\n\n${e('Two.')}\n\n## 0.4.1\n\n${e('One.')}\n`;
  assert.deepEqual(entriesBetween(log, 'v0.4.1', '0.4.4').map((x) => x.version), ['0.4.3', '0.4.2']);
  assert.deepEqual(entriesBetween(log, null, '0.4.4'), [], 'no release before known: never the whole history');
  assert.equal(combinedEntry(log, '0.4.4', '0.4.3'), e('Four.'), 'released one by one: its own entry alone');
  const both = combinedEntry(log, '0.4.4', '0.4.1')!;
  assert.match(both, /^\*\*Four\.\*\*[\s\S]*This release brings v0\.4\.3 and v0\.4\.2 too, never released on their own:\n\n## 0\.4\.3\n\n\*\*Three\.\*\*[\s\S]*## 0\.4\.2\n\n\*\*Two\.\*\*/);
  assert.doesNotMatch(both, /One\./);
  assert.match(combinedEntry(log, '0.4.3', '0.4.1')!, /brings v0\.4\.2 too, never released on its own:/);
  assert.equal(combinedEntry(log, '0.4.9', '0.4.1'), null);
  const n = releaseNotes({ root: '.', name: 'Fake', version: '0.4.4', commit: 'abc1234', install: 'Run it.', changelog: log, since: 'v0.4.2' });
  assert.equal(n.from, 'changelog');
  assert.match(n.notes, /^Fake 0\.4\.4, built from abc1234\.\n\n\*\*Four\.\*\*[\s\S]*brings v0\.4\.3 too[\s\S]*\*\*Three\.\*\*[\s\S]*### Installing\n\nRun it\.\n$/);
  assert.deepEqual(n.warnings, []);
});
