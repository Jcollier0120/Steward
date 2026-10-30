import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The sample repositories of samples/pipelines (tools/samples.ts), spun up in a temporary folder with no host and no
// network: each a clone on main with its own origin (a folder, the fake GitLab's address, or none), its .steward.json
// read without a mistake (but the broken one's, each said), and its dry run (dryrun.ts) as its stack's pipeline says.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-samples-'));
process.env.STEWARD_HOME = path.join(home, 'steward');
process.env.MANOR_HOME = path.join(home, 'no-manor');
after(() => rmSync(home, { recursive: true, force: true }));

const { FAKE_GITLAB, sampleNames, spinUp } = await import('../tools/lib/samples.ts');
const { readPipelineFile, resolvePipeline } = await import('../src/repoconfig.ts');
const { readClone } = await import('../src/found.ts');
const { dryRun } = await import('../src/dryrun.ts');
const { remoteOf } = await import('../src/git.ts');
const { originUrl, repoFromUrl } = await import('../src/scm.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');

const target = path.join(home, 'samples');
const spun = spinUp(target);
const at = (name: string) => path.join(target, name);
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const settings = { ...structuredClone(DEFAULT_SETTINGS), employees: [] };
const dry = (name: string) => dryRun(settings, at(name), { look: null });

test('every sample is spun up: a clone on main with one commit, and the origin its pipeline wants', () => {
  assert.deepEqual(
    spun.map((s) => s.name),
    sampleNames(),
  );
  assert.ok(sampleNames().length >= 9, sampleNames().join(', '));
  for (const s of spun) {
    assert.equal(git(s.dir, 'branch', '--show-current'), 'main', s.name);
    assert.equal(git(s.dir, 'rev-list', '--count', 'HEAD'), '1', s.name);
    assert.equal(git(s.dir, 'status', '--porcelain'), '', `${s.name} has nothing uncommitted`);
  }
  // On this PC alone: no origin at all, its fetches and tags its own (git.ts).
  assert.equal(remoteOf(at('local-only')), '.');
  assert.equal(originUrl(at('local-only')), null);
  // The fake GitLab: GitLab's address, and its pushes went to a folder: no network.
  assert.equal(originUrl(at('gitlab-hello')), `${FAKE_GITLAB}gitlab-hello.git`);
  assert.equal(repoFromUrl(originUrl(at('gitlab-hello'))!), 'gitlab.example.test/samples/gitlab-hello');
  assert.match(git(at('gitlab-hello'), 'ls-remote', 'origin', 'refs/heads/main'), /refs\/heads\/main$/);
  // The rest: a bare repository of its own, as local/<name>.
  assert.equal(repoFromUrl(originUrl(at('node-hello'))!), 'local/node-hello');
  assert.equal(git(at('node-hello'), 'rev-parse', 'origin/main'), git(at('node-hello'), 'rev-parse', 'HEAD'));
});

test('a .steward.json that names a folder names the samples\' own (@SAMPLES@ filled in)', () => {
  for (const name of ['dotnet-hello', 'folder-release', 'local-only']) {
    const text = readFileSync(path.join(at(name), '.steward.json'), 'utf8');
    assert.doesNotMatch(text, /@SAMPLES@/, name);
    const to = readPipelineFile(at(name)).raw?.releaseTo as { folder: string };
    assert.equal(to.folder, path.join(target, 'releases', name), name);
  }
});

test('each sample\'s .steward.json reads with no mistake; the broken one says each of its own', () => {
  for (const name of sampleNames().filter((n) => n !== 'broken-pipeline')) {
    const file = readPipelineFile(at(name));
    assert.equal(file.error, null, name);
    const e = { id: name, name, repo: `local/${name}`, checkout: at(name), branch: 'main', merges: false, usesKit: false, fill: '', test: [], versionFiles: [], release: '', install: '', approve: '', installed: '' };
    assert.deepEqual(resolvePipeline(e, { settings: null, settingsError: null, file: file.raw, fileError: null }).errors, [], name);
  }
  const r = dry('broken-pipeline');
  assert.equal(r.code, 1);
  const said = r.lines.join('\n');
  assert.match(said, /"versioning" must be one of claim, files, tags, none/);
  assert.match(said, /"tagFormt" isn't a pipeline option \(did you mean "tagFormat"\?\)/);
  assert.match(said, /"releaseTo" is command, and there is no "release" command to run/);
  assert.match(said, /"vouch" must be true or false/);
  assert.match(said, /^held: /m);
  assert.doesNotMatch(said, /Nothing was run/);
});

test('Look after reads each stack from its clone: its tests and the files that carry its version', () => {
  const read = (name: string) => readClone(at(name), 'main');
  assert.deepEqual(read('node-hello'), { test: ['npm test'], versionFiles: ['package.json'], releaseScript: false });
  assert.deepEqual(read('python-hello'), { test: ['python -m pytest'], versionFiles: ['pyproject.toml'], releaseScript: false });
  assert.deepEqual(read('rust-hello'), { test: ['cargo test'], versionFiles: ['Cargo.toml'], releaseScript: false });
  assert.deepEqual(read('go-hello'), { test: ['go test ./...'], versionFiles: [], releaseScript: false });
  assert.deepEqual(read('dotnet-hello').versionFiles, ['Hello.csproj']);
});

test("each stack's dry run: its builds, tests, version, notes and release as its pipeline says, nothing run", () => {
  const lines = (name: string) => {
    const r = dry(name);
    assert.equal(r.code, 0, `${name}:\n${r.lines.join('\n')}`);
    assert.equal(r.lines.at(-1), 'Nothing was run (dry run).', name);
    assert.match(r.lines[1], /^not looked after yet: read from /, name);
    return r.lines.join('\n');
  };
  const node = lines('node-hello');
  assert.match(node, /node-hello \(local\/node-hello\), branch main, worked with plain git/);
  assert.match(node, /test +npm test/);
  assert.match(node, /the version in package\.json, each branch claiming the next free one/);
  assert.match(node, /tags v<version> at the commit and pushes it to its origin/);
  const python = lines('python-hello');
  assert.match(python, /test +python -m pytest/);
  assert.match(python, /the version in pyproject\.toml, as you set it; nothing claimed/);
  assert.match(python, /tags python-hello-<version>/);
  assert.match(python, /CHANGELOG\.md entry, as written by hand/);
  const rust = lines('rust-hello');
  assert.match(rust, /build +cargo build --release/);
  assert.match(rust, /release +cargo run --release .*then tags rust-hello-v<version> on its origin/);
  const dotnet = lines('dotnet-hello');
  assert.match(dotnet, /build +dotnet publish -c Release -o publish/);
  assert.match(dotnet, /copies publish to .*releases\\dotnet-hello\\v<version>/);
  const go = lines('go-hello');
  assert.match(go, /the patch after the newest vx\.y\.z tag, when main has commits since it \(v0\.1\.0 first\)/);
  assert.match(go, /no notes/);
  const local = lines('local-only');
  assert.match(local, /\(no host: local only\)/);
  assert.match(local, /fresh worktree of main;/);
  assert.match(local, /turns and version claims kept on this PC alone/);
  const gitlab = lines('gitlab-hello');
  assert.match(gitlab, /gitlab-hello \(gitlab\.example\.test\/samples\/gitlab-hello\), branch main, worked with plain git/, 'glab not signed in here: plain git');
  assert.match(gitlab, /host from \.steward\.json/);
  const folder = lines('folder-release');
  assert.match(folder, /build +npm run build/);
  assert.match(folder, /copies dist to .*releases\\folder-release\\v<version>/);
});

test('spun up again, every sample there is left as it is', () => {
  const head = git(at('node-hello'), 'rev-parse', 'HEAD');
  const again = spinUp(target);
  assert.ok(again.every((s) => s.left), again.map((s) => s.name).join(', '));
  assert.equal(git(at('node-hello'), 'rev-parse', 'HEAD'), head);
  assert.ok(existsSync(path.join(target, '.origins', 'node-hello.git')));
});
