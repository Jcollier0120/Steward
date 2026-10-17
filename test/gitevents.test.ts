import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Plain git's events (stages/gitevents.ts): with no pull requests, Settings say what the Steward does once a release's
// tag is pushed (After a release). When a branch is ready is no longer run (Steward 0.36.124): whoever writes a branch
// lands it, and a build releases what is on the branch. Real git, local origins; nothing reaches GitHub, the live
// ~/.steward or the real checkouts.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-gitevents-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
process.env.WRIGHT_HOME = path.join(tmp, 'no-wright');
process.env.BAILIFF_HOME = path.join(tmp, 'no-bailiff');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { fillCommand } = await import('../src/stages/gitevents.ts');
const { normalizeSettings, SETTINGS_SCHEMA } = await import('../src/settings.ts');
const { runStage } = await import('../src/steward.ts');
const { run: realRun } = await import('../src/run.ts');
const { fakeEmployee, sh } = await import('./helpers.ts');

const FF = 'git push origin {commit}:refs/heads/{base}';

test("a command's placeholders are filled in word by word, after it is split, so a value with spaces or quotes stays one word", () => {
  process.env.STEWARD_TEST_TOOL = 'C:\\Tools';
  const words = fillCommand('%STEWARD_TEST_TOOL%\\hand-in.exe --title "{title}" --to={base} {notesFile} {unknown}', { title: 'Fake 0.4.1: "Quoted", and spaced', base: 'main', notesFile: 'C:\\Temp\\a b\\notes.md' });
  assert.deepEqual(words, ['C:\\Tools\\hand-in.exe', '--title', 'Fake 0.4.1: "Quoted", and spaced', '--to=main', 'C:\\Temp\\a b\\notes.md', '{unknown}']);
  assert.equal(fillCommand('   ', {}), null);
});

test('After a release: run in the clone once the tag is pushed, with the tag and its notes; a failure is a note, and the release stands', async () => {
  const home = process.env.STEWARD_HOME!;
  mkdirSync(home, { recursive: true });
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

test('Settings keep both commands per repository, left out when empty, and show them as optional fields; When a branch is ready hidden, no longer run', () => {
  const base = { id: 'site', name: 'Site', repo: 'gitlab.com/me/site', checkout: 'C:\\x', branch: 'main', test: [], versionFiles: [], release: '', install: '', approve: '' };
  const { settings } = normalizeSettings({ employees: [{ ...base, whenReady: `  ${FF}  `, whenReleased: 'notify {tag}' }, { ...base, id: 'other', whenReady: ' ', whenReleased: 7 }] });
  assert.equal(settings.employees[0].whenReady, FF);
  assert.equal(settings.employees[0].whenReleased, 'notify {tag}');
  assert.ok(!('whenReady' in settings.employees[1]) && !('whenReleased' in settings.employees[1]));
  const fields = (SETTINGS_SCHEMA.find((f) => f.key === 'employees') as any).fields as { key: string; optional?: boolean; label: string; hidden?: boolean; help?: string }[];
  assert.deepEqual(
    fields.filter((f) => f.key === 'whenReady' || f.key === 'whenReleased').map((f) => [f.key, f.label, f.optional, !!f.hidden]),
    [
      ['whenReady', 'When a branch is ready', true, true],
      ['whenReleased', 'After a release', true, false],
    ],
  );
  assert.match(fields.find((f) => f.key === 'whenReady')!.help!, /^No longer run: the Steward lands no branches/);
});
