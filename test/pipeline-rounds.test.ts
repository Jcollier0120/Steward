import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Whole rounds by a repository's own pipeline (repoconfig.ts, Steward 0.36.266), on a PC with Git alone and no network:
// one on this PC alone, released to a folder by its tags; one on a GitLab that isn't there (its origin a plain git folder
// under that name), tagged by its own format; one whose pipeline can't be read, held while the others carry on; and an
// install from before, whose settings read exactly as they did. Nothing reaches a host, the live ~/.steward or Manor.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-rounds-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { DEFAULT_SETTINGS, loadSettings, normalizeSettings, SETTINGS_SPEC, withPipelines } = await import('../src/settings.ts');
const { fakeEmployee, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');
type ScmLook = import('../src/scm.ts').ScmLook;

// Git, and no host's CLI at all.
const look = (): ScmLook => ({ at: new Date().toISOString(), tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.55.0', supported: true }] });
const base = { workRoot: path.join(home, 'work'), releasesCastellan: false, byItself: true, tasteBeforeRelease: false, afterRelease: [], alarms: { manorUrl: '', surveyorUrl: '', toast: false } };
const hire = (o: Record<string, unknown>) => ({ branch: 'main', usesKit: false, parts: [], fill: '', test: [], versionFiles: [], release: '', install: '', approve: '', ...o });
const writeSettings = (o: Record<string, unknown>) => writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ ...base, ...o }));

/** A runner that runs git for real, and records every host CLI it's asked to run, answering none. */
function offline() {
  const asked: string[] = [];
  const run = async (cmd: string, args: string[], opts?: any) => {
    if (['gh', 'glab', 'az', 'tea'].includes(cmd)) {
      asked.push(`${cmd} ${args.join(' ')}`);
      return { code: 127, out: '', err: `${cmd} isn't installed` };
    }
    return realRun(cmd, args, opts);
  };
  return { run, asked };
}

const released = (r: { results: { message: string }[] }) => r.results.find((x) => x.message.startsWith('release: '))?.message ?? '';
const noAlarm = () => assert.ok(!existsSync(path.join(home, 'alarms.json')) || !JSON.parse(readFileSync(path.join(home, 'alarms.json'), 'utf8')).open.length, 'no alarm');
const commitPipeline = (checkout: string, pipeline: unknown) => {
  writeFileSync(path.join(checkout, '.steward.json'), `${JSON.stringify(pipeline, null, 2)}\n`);
  sh(checkout, 'add', '.steward.json');
  sh(checkout, 'commit', '--quiet', '-m', 'Its pipeline');
};

test('a round on this PC alone: no origin, versioned by its tags, released to a folder and tagged in the clone', async () => {
  const f = fakeEmployee(path.join(home, 'notes'), { version: '0.4.0', kit: null });
  sh(f.checkout, 'remote', 'remove', 'origin');
  const folder = path.join(home, 'releases', 'notes');
  commitPipeline(f.checkout, { host: 'none', test: ['node -e process.exit(0)'], versioning: 'tags', changelog: 'none', releaseTo: { folder }, vouch: false, sharedRefs: false });
  writeSettings({ employees: [hire({ id: 'notes', name: 'Notes', repo: 'local/notes', checkout: f.checkout })] });
  const { run, asked } = offline();
  const round = () => runStage('round', { full: true }, { run, scm: look() });

  // Never released: 0.1.0, its first, copied to <folder>\v0.1.0 and tagged in the clone.
  const first = await round();
  assert.equal(first.error, undefined, first.log.join('\n'));
  assert.match(released(first), new RegExp(`^release: released v0\\.1\\.0 from origin/main \\(.{7}\\) to ${folder.replace(/[\\.]/g, '\\$&')}\\\\v0\\.1\\.0, tagged v0\\.1\\.0 in your clone$`), first.log.join('\n'));
  assert.ok(existsSync(path.join(folder, 'v0.1.0', 'package.json')), 'its files are in the release folder');
  assert.ok(!existsSync(path.join(folder, 'v0.1.0', '.git')), 'without its .git');
  assert.equal(sh(f.checkout, 'rev-parse', 'v0.1.0^{commit}'), sh(f.checkout, 'rev-parse', 'main'));
  assert.ok(first.log.some((l) => /^\[notes\] testing main at .{7} before its release/.test(l)), first.log.join('\n'));

  // Nothing new since: not released again.
  const second = await round();
  assert.match(released(second), /nothing on main since v0\.1\.0, its newest release/, second.log.join('\n'));

  // A commit on main: the patch after it.
  writeFileSync(path.join(f.checkout, 'notes.txt'), 'a note\n');
  sh(f.checkout, 'add', 'notes.txt');
  sh(f.checkout, 'commit', '--quiet', '-m', 'A note');
  const third = await round();
  assert.match(released(third), /^release: released v0\.1\.1 from origin\/main .* tagged v0\.1\.1 in your clone$/, third.log.join('\n'));
  assert.ok(existsSync(path.join(folder, 'v0.1.1', 'notes.txt')));
  assert.equal(sh(f.checkout, 'tag', '-l', '--format=%(contents:subject)', 'v0.1.1'), 'Notes 0.1.1', 'its tag says which; changelog none: no notes');
  assert.deepEqual(asked, [], 'no host CLI was run');
  assert.equal(sh(f.checkout, 'for-each-ref', '--format=%(refname)', 'refs/manor/'), '', 'its turns and claims are kept on this PC, never in its refs');
  noAlarm();
});

test("a round on a GitLab that isn't there: worked with plain git, its build run in its tests, tagged on its origin by its own format", async () => {
  const f = fakeEmployee(path.join(home, 'gitlab'), { version: '0.4.0', kit: null, files: { 'CHANGELOG.md': '# Changelog\n\n## 0.4.0\n\n**First.**\n' } });
  // Its origin is named on a GitLab, and is a plain git folder: git is told so for every command this test starts.
  const url = 'https://gitlab.example.test/team/fake.git';
  sh(f.checkout, 'remote', 'set-url', 'origin', url);
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  Object.assign(process.env, { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: `url.${f.origin.replace(/\\/g, '/')}.insteadOf`, [`GIT_CONFIG_VALUE_${n}`]: url });
  const built = path.join(home, 'gitlab-built.txt');
  commitPipeline(f.checkout, {
    host: { kind: 'gitlab', baseUrl: 'https://gitlab.example.test' },
    build: [`node -e "require('fs').appendFileSync(process.argv[1],'built\\n')" ${built}`],
    test: ['node -e process.exit(0)'],
    versioning: 'files',
    versionFiles: ['package.json'],
    tagFormat: 'fake-{version}',
    releaseTo: 'tag',
  });
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  // Settings' pipeline for it says a tag format too, and squash merges: its .steward.json wins, option by option.
  writeSettings({
    employees: [hire({ id: 'fake', name: 'Fake', repo: 'gitlab.example.test/team/fake', checkout: f.checkout, test: ['node -e process.exit(1)'], versionFiles: ['package.json', 'package-lock.json'], release: 'tag' })],
    pipelines: { 'gitlab.example.test/team/fake': { tagFormat: 'nope-{version}', mergeMethod: 'squash' } },
  });
  const e = loadSettings().employees[0];
  assert.deepEqual([e.test.length, e.versionFiles, e.release, e.resolvedPipeline?.tagFormat, e.resolvedPipeline?.from.tagFormat, e.resolvedPipeline?.mergeMethod, e.resolvedPipeline?.from.mergeMethod], [2, ['package.json'], 'tag', 'fake-{version}', '.steward.json', 'squash', 'Settings']);
  const { run, asked } = offline();
  const round = () => runStage('round', { full: true }, { run, scm: look() });

  const first = await round();
  assert.equal(first.error, undefined, first.log.join('\n'));
  assert.match(released(first), /^release: released v0\.4\.0 from origin\/main \(.{7}\), tagged fake-0\.4\.0 on its origin$/, first.log.join('\n'));
  assert.equal(sh(f.origin, 'rev-parse', 'fake-0.4.0^{commit}'), sh(f.origin, 'rev-parse', 'main'));
  assert.match(sh(f.origin, 'tag', '-l', '--format=%(contents)', 'fake-0.4.0'), /^Fake 0\.4\.0\n\n\*\*First\.\*\*/, 'its CHANGELOG.md entry');
  assert.deepEqual(readFileSync(built, 'utf8').split('\n').filter(Boolean), ['built'], 'its build ran once, before its tests');
  assert.equal(sh(f.origin, 'tag', '-l', 'v*'), '', 'no v<version> tag: its own format');

  const second = await round();
  assert.match(released(second), /v0\.4\.0 is already released/, second.log.join('\n'));
  assert.deepEqual(asked, [], 'neither glab nor gh was run');
  noAlarm();
});

test("a pipeline that can't be read holds its repository alone, each mistake said; the others are released", async () => {
  const bad = fakeEmployee(path.join(home, 'bad'), { version: '1.0.0', kit: null });
  commitPipeline(bad.checkout, { versioning: 'sometimes', tagFormt: 'x-{version}' });
  const good = fakeEmployee(path.join(home, 'good'), { version: '2.0.0', kit: null });
  writeSettings({
    employees: [
      hire({ id: 'bad', name: 'Bad', repo: 'nas/bad', checkout: bad.checkout, versionFiles: ['package.json'], release: 'tag' }),
      hire({ id: 'good', name: 'Good', repo: 'nas/good', checkout: good.checkout, versionFiles: ['package.json'], release: 'tag' }),
    ],
  });
  const { run } = offline();
  const out = await runStage('release', {}, { run, scm: look() });
  const by = (id: string) => out.results.find((r) => r.id === id)!;
  assert.equal(by('bad').outcome, 'refused');
  assert.equal(by('bad').message, `its pipeline can't be read, so nothing is built or released until it's fixed: .steward.json: "versioning" must be one of claim, files, tags, none, not "sometimes"; .steward.json: "tagFormt" isn't a pipeline option (did you mean "tagFormat"?); the options are host, build, test, release, versioning, versionFiles, tagFormat, changelog, releaseTo, mergeMethod, vouch, sharedRefs`);
  assert.match(by('good').message, /^released v2\.0\.0 from origin\/main \(.{7}\), tagged v2\.0\.0 on its origin$/, out.log.join('\n'));
  assert.equal(sh(bad.origin, 'tag', '-l'), '', 'nothing of the held one released');
});

test('an install from before: its settings, with no pipeline anywhere, read exactly as they did, and raise nothing', () => {
  const raw = {
    ...base,
    employees: [
      hire({ id: 'game', name: 'Game', repo: 'octo/game', checkout: path.join(home, 'no-clone-here'), test: ['npm test'], versionFiles: ['package.json', 'package-lock.json'], release: 'node tools/release.ts' }),
      hire({ id: 'site', name: 'Site', repo: 'gitlab.com/me/site', checkout: '', versionFiles: ['package.json'], release: 'tag' }),
    ],
  };
  const { settings, problems } = normalizeSettings(raw);
  assert.deepEqual(problems, []);
  assert.deepEqual(settings.pipelines, {}, 'no pipelines: none');
  // Each employee comes back as the very object it was: nothing said, nothing changed.
  const read: string[] = [];
  const w = withPipelines(settings, (dir) => (read.push(dir), { raw: null, error: null }));
  assert.ok(w.employees.every((e, i) => e === settings.employees[i]));
  assert.deepEqual(read, [path.join(home, 'no-clone-here')], 'only a clone named is looked in');
  // As loadSettings reads them from the file: the same fields, and no pipeline kept beside them.
  writeSettings({ employees: raw.employees });
  const loaded = loadSettings().employees;
  assert.deepEqual(loaded.map((e) => [e.id, e.test, e.versionFiles, e.release, 'resolvedPipeline' in e]), [['game', ['npm test'], ['package.json', 'package-lock.json'], 'node tools/release.ts', false], ['site', [], ['package.json'], 'tag', false]]);
  // Settings saved with Pipelines empty, or naming one well, are read the same, and saved with no error; one that isn't
  // read as a pipeline is refused beside it, before it is saved.
  assert.deepEqual(normalizeSettings({ ...raw, pipelines: {} }).problems, []);
  assert.deepEqual(normalizeSettings({ ...raw, pipelines: { 'octo/game': '{"tagFormat":"game-{version}"}' } }).settings.pipelines, { 'octo/game': '{"tagFormat":"game-{version}"}' });
  const check = (pipelines: Record<string, string>) => (SETTINGS_SPEC.check!({ ...structuredClone(DEFAULT_SETTINGS), employees: [], pipelines } as any, ['pipelines'], { pipelines }) as { errors: Record<string, string> }).errors;
  assert.deepEqual(check({}), {});
  assert.deepEqual(check({ 'octo/game': '{"tagFormat":"game-{version}"}' }), {});
  assert.deepEqual(Object.keys(check({ 'octo/game': '{"versioning":"sometimes"}', 'octo/site': 'not json' })), ['pipelines.0.value', 'pipelines.1.value']);
  assert.match(check({ 'octo/site': 'not json' })['pipelines.0.value'], /^Not JSON: /);
});
