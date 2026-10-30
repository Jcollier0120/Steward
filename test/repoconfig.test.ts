import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A repository's own pipeline (repoconfig.ts): each option read and checked in a sentence, Settings' and .steward.json's
// over the defaults, what they say together, and an employee as its pipeline makes it. The defaults are today's.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-repoconfig-'));
after(() => rmSync(home, { recursive: true, force: true }));

const R = await import('../src/repoconfig.ts');
const { TAG_RELEASE } = await import('../src/settings.ts');

const record = (o: Partial<{ repo: string; test: string[]; versionFiles: string[]; release: string }> = {}) => ({ repo: 'octo/app', test: ['npm test'], versionFiles: ['package.json'], release: TAG_RELEASE, ...o });
const read = (raw: unknown) => R.readPipeline(raw, '.steward.json');
const errorOf = (raw: unknown) => {
  const r = read(raw);
  assert.equal(r.errors.length, 1, JSON.stringify(r));
  return r.errors[0];
};

test('the defaults are what the fields always said: claimed versions, v<version>, the release as Release it says', () => {
  assert.deepEqual(R.defaultPipeline(record()), {
    host: null,
    build: [],
    test: ['npm test'],
    release: '',
    versioning: 'claim',
    versionFiles: ['package.json'],
    tagFormat: 'v{version}',
    changelog: 'auto',
    releaseTo: { kind: 'auto' },
    mergeMethod: 'merge',
    vouch: true,
    sharedRefs: true,
  });
  assert.deepEqual(R.defaultPipeline(record({ release: 'npm run release' })).releaseTo, { kind: 'command' });
  assert.equal(R.defaultPipeline(record({ release: 'npm run release' })).release, 'npm run release');
  assert.deepEqual(R.defaultPipeline(record({ release: '' })).releaseTo, { kind: 'none' });
  // A record from before test and versionFiles were lists of its own (an old staff row) reads as none.
  assert.deepEqual(R.defaultPipeline({ release: '' } as any).test, []);
  const p = R.pipelineOf(record());
  assert.deepEqual(p.errors, []);
  assert.ok(R.PIPELINE_KEYS.every((k) => p.from[k] === 'default'));
});

test('host: a kind, a kind with its address, plain git or none; anything else said in words', () => {
  assert.deepEqual(read({ host: 'gitlab' }).given.host, { kind: 'gitlab', baseUrl: null });
  assert.deepEqual(read({ host: 'none' }).given.host, { kind: 'none', baseUrl: null });
  assert.deepEqual(read({ host: { kind: 'gitlab', baseUrl: 'HTTPS://GitLab.Acme.com/' } }).given.host, { kind: 'gitlab', baseUrl: 'https://gitlab.acme.com' });
  assert.deepEqual(read({ host: { kind: 'gitea', baseUrl: 'https://code.acme.com/git' } }).given.host, { kind: 'gitea', baseUrl: 'https://code.acme.com/git' });
  assert.match(errorOf({ host: 'sourceforge' }), /^\.steward\.json: "host" must be one of github, gitlab, .*none, not "sourceforge"$/);
  assert.match(errorOf({ host: 3 }), /"host" must be one of .*or \{ "kind": "gitlab", "baseUrl": "https:\/\/gitlab\.acme\.com" \}/);
  assert.match(errorOf({ host: { kind: 'gitlab', url: 'x' } }), /"host" takes only "kind" and "baseUrl", not "url"/);
  assert.match(errorOf({ host: { kind: 'none', baseUrl: 'https://x.test' } }), /"host" none has no address/);
  assert.match(errorOf({ host: { kind: 'gitlab', baseUrl: 'https://me:secret@gitlab.acme.com' } }), /"baseUrl" must be the host's address.*no user name, password or query/);
  assert.match(errorOf({ host: { kind: 'gitlab', baseUrl: 'ftp://gitlab.acme.com' } }), /"baseUrl" must be the host's address/);
});

test('build, test and release: a command or a list of them, each checked', () => {
  assert.deepEqual(read({ build: 'npm ci' }).given.build, ['npm ci']);
  assert.deepEqual(read({ test: [' npm run typecheck ', 'npm test'] }).given.test, ['npm run typecheck', 'npm test']);
  assert.equal(read({ release: 'npm publish' }).given.release, 'npm publish');
  assert.equal(read({ release: '' }).given.release, '', 'an empty release: none');
  assert.match(errorOf({ build: { run: 'x' } }), /"build" must be a command, or a list of commands run in order/);
  assert.match(errorOf({ test: ['npm test', 3] }), /"test"'s command 2 must be text/);
  assert.match(errorOf({ test: ['  '] }), /"test"'s command 1 is empty: leave it out instead/);
  assert.match(errorOf({ build: 'a\nb' }), /"build" has a line break in it/);
  assert.match(errorOf({ test: ['x'.repeat(501)] }), /is 501 characters long: at most 500/);
  assert.match(errorOf({ build: Array(21).fill('x') }), /"build" has 21 commands: at most 20/);
  assert.match(errorOf({ release: ['npm run build', 'npm publish'] }), /"release" must be one command; put the steps before it in "build"/);
});

test('versioning, changelog and mergeMethod: one of their words', () => {
  for (const v of R.VERSIONINGS) assert.equal(read({ versioning: v }).given.versioning, v);
  for (const c of R.CHANGELOGS) assert.equal(read({ changelog: c }).given.changelog, c);
  for (const m of R.MERGE_METHODS) assert.equal(read({ mergeMethod: m }).given.mergeMethod, m);
  assert.equal(errorOf({ versioning: 'semver' }), '.steward.json: "versioning" must be one of claim, files, tags, none, not "semver"');
  assert.equal(errorOf({ changelog: 1 }), '.steward.json: "changelog" must be one of auto, changes-dir, changelog-md, host, none');
  assert.match(errorOf({ mergeMethod: 'fast-forward' }), /"mergeMethod" must be one of merge, squash, rebase, not "fast-forward"/);
});

test('versionFiles: paths inside the repository, each once', () => {
  assert.deepEqual(read({ versionFiles: ['Cargo.toml', 'crates\\core\\Cargo.toml', 'Cargo.toml'] }).given.versionFiles, ['Cargo.toml', 'crates/core/Cargo.toml']);
  assert.match(errorOf({ versionFiles: 'package.json' }), /"versionFiles" must be a list of files, like \["Cargo\.toml"\]/);
  assert.match(errorOf({ versionFiles: ['C:\\x\\package.json'] }), /must be a path inside the repository \(no drive, leading slash or \.\.\)/);
  assert.match(errorOf({ versionFiles: ['../other/package.json'] }), /no drive, leading slash or \.\./);
  assert.match(errorOf({ versionFiles: ['.'] }), /must name a file/);
  assert.match(errorOf({ versionFiles: Array(21).fill('a') }), /has 21 files: at most 20/);
});

test('tagFormat: {version} once, and a name git takes', () => {
  for (const f of ['v{version}', 'app-{version}', 'release/{version}', '{version}', 'rust-hello-v{version}']) assert.equal(read({ tagFormat: f }).given.tagFormat, f, f);
  assert.match(errorOf({ tagFormat: 'latest' }), /must have \{version\} in it, like v\{version\}/);
  assert.match(errorOf({ tagFormat: '{version}-{version}' }), /once, not 2 times/);
  assert.match(errorOf({ tagFormat: 'v {version}' }), /may have only letters, digits/);
  assert.match(errorOf({ tagFormat: '-{version}' }), /doesn't make a name git takes for a tag/);
  assert.match(errorOf({ tagFormat: 'a..{version}' }), /doesn't make a name git takes/);
  assert.match(errorOf({ tagFormat: '{version}.lock' }), /doesn't make a name git takes/);
  assert.match(errorOf({ tagFormat: 2 }), /"tagFormat" must be text/);
  assert.equal(R.tagFormatProblem('v{version}'), null);
});

test('releaseTo: a word, or a folder with what to copy from', () => {
  for (const k of R.RELEASE_TO) assert.deepEqual(read({ releaseTo: k }).given.releaseTo, { kind: k });
  assert.deepEqual(read({ releaseTo: { folder: 'D:\\Releases\\app', from: 'dist/' } }).given.releaseTo, { kind: 'folder', folder: 'D:\\Releases\\app', from: 'dist' });
  assert.deepEqual(read({ releaseTo: { folder: '%USERPROFILE%\\Releases' } }).given.releaseTo, { kind: 'folder', folder: '%USERPROFILE%\\Releases', from: '.' });
  assert.deepEqual(read({ releaseTo: { folder: '\\\\nas\\drop' } }).given.releaseTo, { kind: 'folder', folder: '\\\\nas\\drop', from: '.' });
  assert.match(errorOf({ releaseTo: 'npm' }), /"releaseTo" must be one of auto, host, tag, command, none, not "npm", or \{ "folder"/);
  assert.match(errorOf({ releaseTo: { folder: 'releases' } }), /"folder" must be a full path, like D:\\Releases\\app .*not "releases"/);
  assert.match(errorOf({ releaseTo: { folder: 'D:\\r', to: 'x' } }), /takes only "folder" and "from", not "to"/);
  assert.match(errorOf({ releaseTo: { folder: 'D:\\r', from: '..\\x' } }), /"from" must be a path inside the repository/);
  assert.match(errorOf({ releaseTo: [] }), /"releaseTo" must be one of/);
});

test('vouch and sharedRefs: true or false, and "true" in quotes said so', () => {
  assert.equal(read({ vouch: false }).given.vouch, false);
  assert.equal(read({ sharedRefs: true }).given.sharedRefs, true);
  assert.equal(errorOf({ vouch: 'false' }), '.steward.json: "vouch" must be true or false (without quotes)');
  assert.equal(errorOf({ sharedRefs: 1 }), '.steward.json: "sharedRefs" must be true or false');
});

test('a word that is no option is named, with the one meant; notes and a schema are left alone', () => {
  assert.match(errorOf({ tagFormt: 'v{version}' }), /"tagFormt" isn't a pipeline option \(did you mean "tagFormat"\?\); the options are host, build/);
  assert.match(errorOf({ 'version-files': ['a'] }), /did you mean "versionFiles"/);
  assert.match(errorOf({ Releaseto: 'tag' }), /did you mean "releaseTo"/);
  assert.doesNotMatch(errorOf({ deploy: 'x' }), /did you mean/);
  assert.deepEqual(read({ $schema: 'x', '//': 'a note', comment: 'c', comments: ['d'] }), { given: {}, errors: [] });
  assert.deepEqual(read(null), { given: {}, errors: [] });
  assert.match(read([]).errors[0], /must be an object of pipeline options/);
  assert.match(R.readPipeline('x', "Settings' pipeline for octo/app").errors[0], /^Settings' pipeline for octo\/app must be an object/);
});

test("Settings' pipeline over the defaults, and the repository's .steward.json over Settings', option by option", () => {
  const p = R.resolvePipeline(record(), { settings: { test: ['npm run ci'], tagFormat: 'app-{version}' }, file: { tagFormat: 'rel-{version}', changelog: 'none' } });
  assert.deepEqual([p.test, p.tagFormat, p.changelog, p.versioning], [['npm run ci'], 'rel-{version}', 'none', 'claim']);
  assert.deepEqual([p.from.test, p.from.tagFormat, p.from.changelog, p.from.versioning], ['Settings', '.steward.json', '.steward.json', 'default']);
  assert.deepEqual(p.errors, []);
  // Errors from either, each said where it is, and a file that couldn't be read.
  const bad = R.resolvePipeline(record(), { settings: { vouch: 'no' }, settingsError: null, file: null, fileError: '.steward.json isn\'t JSON: Unexpected token' });
  assert.deepEqual(bad.errors, ["Settings' pipeline for octo/app: \"vouch\" must be true or false", ".steward.json isn't JSON: Unexpected token"]);
  // A release command said, and nothing said of where: it is the release.
  assert.deepEqual(R.resolvePipeline(record({ release: '' }), { file: { release: 'cargo publish' } }).releaseTo, { kind: 'command' });
});

test('what the options say together, checked only where one was said', () => {
  const errs = (file: unknown, o = record()) => R.resolvePipeline(o, { file }).errors;
  assert.match(errs({ versioning: 'files' }, record({ versionFiles: [] }))[0], /versioning files reads the version from "versionFiles", and it names none/);
  assert.deepEqual(errs({ versioning: 'tags' }, record({ versionFiles: [] })), []);
  assert.match(errs({ releaseTo: 'command' }, record({ release: TAG_RELEASE }))[0], /"releaseTo" is command, and there is no "release" command/);
  assert.match(errs({ versioning: 'tags', versionFiles: ['package.json'] })[0], /versioning tags takes the version from its tags/);
  assert.deepEqual(errs({ versioning: 'tags' }), [], 'versionFiles from the record, not said: no word on them');
  assert.match(errs({ host: 'git', releaseTo: 'host' })[0], /"releaseTo" is host, but host is git, which has no releases/);
  assert.match(errs({ host: 'none', releaseTo: 'tag' })[0], /host is none, so there is no origin to push the tag to/);
  assert.match(errs({ host: 'none', sharedRefs: true, releaseTo: 'none' })[0], /"sharedRefs" is true, but host is none/);
  assert.match(errs({ host: 'gitlab', mergeMethod: 'rebase' })[0], /GitLab takes a merge request's method from the project's own settings/);
  assert.match(errs({ mergeMethod: 'rebase' }, record({ repo: 'gitlab.com/group/app' }))[0], /GitLab/);
  assert.deepEqual(errs({ mergeMethod: 'rebase' }), [], 'on GitHub, rebase is fine');
  // A record that never named version files, saying nothing, is never refused for it.
  assert.deepEqual(R.resolvePipeline(record({ versionFiles: [] })).errors, []);
});

test('an employee as its pipeline makes it: the very object when nothing is said', () => {
  const e = { id: 'app', ...record() };
  assert.equal(R.withPipeline(e, R.resolvePipeline(e)), e, 'the same object: nothing a stage reads changes');
  const held = R.withPipeline(e, R.resolvePipeline(e, { file: { versioning: 'x' } }));
  assert.deepEqual([held.test, held.versionFiles, held.release], [e.test, e.versionFiles, e.release], 'fields kept; held where built');
  assert.match(R.heldBy(R.pipelineOf(held))!, /^its pipeline can't be read, so nothing is built or released until it's fixed: \.steward\.json: "versioning"/);
  const built = R.withPipeline(e, R.resolvePipeline(e, { file: { build: ['npm ci', 'npm run build'] } }));
  assert.deepEqual(built.test, ['npm ci', 'npm run build', 'npm test'], 'its builds first, then its tests');
  assert.equal(built.release, TAG_RELEASE);
  const tags = R.withPipeline(e, R.resolvePipeline(e, { file: { versioning: 'tags', releaseTo: 'tag' } }));
  assert.deepEqual([tags.versionFiles, tags.release, tags.test], [[], TAG_RELEASE, ['npm test']]);
  const command = R.withPipeline(e, R.resolvePipeline(e, { file: { release: 'npm publish' } }));
  assert.equal(command.release, 'npm publish');
  const never = R.withPipeline(e, R.resolvePipeline(e, { file: { versioning: 'none' } }));
  assert.equal(never.release, '');
  const folder = R.withPipeline(e, R.resolvePipeline(e, { file: { releaseTo: { folder: 'D:\\drop' } } }));
  assert.equal(folder.release, TAG_RELEASE, 'released: by the Steward, to its folder');
  assert.equal(R.pipelineOf(folder).releaseTo.kind, 'folder');
});

test('tags by the format: made, read back, globbed; a tag of another kind is no release', () => {
  const p = { tagFormat: 'app-{version}' };
  assert.equal(R.tagOf(p, '1.2.3'), 'app-1.2.3');
  assert.equal(R.versionOfTag('app-{version}', 'app-1.2.3'), '1.2.3');
  assert.equal(R.versionOfTag('v{version}', 'v1.2.3'), '1.2.3');
  assert.equal(R.versionOfTag('release/{version}-final', 'release/2.0.0-final'), '2.0.0');
  assert.equal(R.versionOfTag('v{version}', 'v1.2'), null);
  assert.equal(R.versionOfTag('v{version}', 'kit-v1.2.3'), null);
  assert.equal(R.versionOfTag('app-{version}', 'v1.2.3'), null);
  assert.equal(R.tagGlob('v{version}'), 'refs/tags/v*');
  assert.equal(R.tagGlob('{version}'), 'refs/tags/*');
  assert.equal(R.tagGlob('release/{version}'), 'refs/tags/release/*');
});

test("which stamp changes/ entries, which are released by their tags, and which are held", () => {
  assert.equal(R.stampsChanges({ changelog: 'auto' }), true);
  assert.equal(R.stampsChanges({ changelog: 'changes-dir' }), true);
  for (const c of ['changelog-md', 'host', 'none'] as const) assert.equal(R.stampsChanges({ changelog: c }), false, c);
  const def = R.pipelineOf(record());
  assert.equal(R.tagsRelease(def, 'github'), false, 'GitHub releases, as always');
  assert.equal(R.tagsRelease(def, 'git'), true, 'plain git: tags, as always');
  assert.equal(R.tagsRelease(R.pipelineOf(record({ release: 'npm run release' })), 'github'), false, "a Release it command of the record's: its own GitHub release, as always");
  assert.equal(R.tagsRelease(R.resolvePipeline(record(), { file: { release: 'cargo publish' } }), 'github'), true, 'a command the pipeline says: tagged by the Steward');
  assert.equal(R.tagsRelease(R.resolvePipeline(record(), { file: { releaseTo: 'tag' } }), 'gitlab'), true);
  assert.equal(R.heldBy(def), null);
});

test(".steward.json read from the clone: none, JSON, not JSON, too big; read again once it changed", () => {
  const dir = path.join(home, 'clone');
  const file = path.join(dir, R.PIPELINE_FILE);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(R.readPipelineFile(dir), { raw: null, error: null });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, '\uFEFF{ "test": ["cargo test"] }');
  assert.deepEqual(R.readPipelineFile(dir), { raw: { test: ['cargo test'] }, error: null }, 'a byte-order mark is no matter');
  writeFileSync(file, '{ "test": [cargo test] }');
  const bad = R.readPipelineFile(dir);
  assert.equal(bad.raw, null);
  assert.match(bad.error!, /^\.steward\.json isn't JSON: /);
  writeFileSync(file, JSON.stringify({ comment: 'x'.repeat(70 * 1024) }));
  assert.match(R.readPipelineFile(dir).error!, /^\.steward\.json is \d+ KB: at most 64 KB$/);
});

test('a dry run says each step, and where each option came from; one held says so and runs nothing', () => {
  const e = { id: 'app', name: 'App', branch: 'main', checkout: 'C:\\app', ...record() };
  const def = R.dryRunLines(e, 'github');
  assert.deepEqual(def.slice(0, 2), ['App (octo/app), branch main, worked with github', 'pipeline: the defaults (no .steward.json, nothing in Settings)']);
  assert.ok(def.some((l) => /test +npm test +\(in a fresh worktree of origin\/main; must pass\)/.test(l)), def.join('\n'));
  assert.ok(def.some((l) => /release +a github release v<version> of the commit/.test(l)), def.join('\n'));
  assert.ok(def.some((l) => /merge +its own pull requests merged with merge/.test(l)));
  assert.ok(def.some((l) => /vouch +pull requests tested here and vouched for/.test(l)));
  assert.equal(def.at(-1), 'Nothing was run (dry run).');
  const git = R.dryRunLines(e, 'git');
  assert.ok(git.some((l) => /release +tags v<version> at the commit and pushes it to its origin/.test(l)), git.join('\n'));
  assert.ok(git.some((l) => /merge +none: plain git has no pull requests/.test(l)));
  const said = R.withPipeline(e, R.resolvePipeline(e, { settings: { mergeMethod: 'squash' }, file: { build: ['npm ci'], versioning: 'none' } }));
  const lines = R.dryRunLines(said, 'github');
  assert.equal(lines[1], 'pipeline: build from .steward.json, versioning from .steward.json, mergeMethod from Settings');
  assert.ok(lines.some((l) => /build +npm ci/.test(l)));
  assert.ok(lines.some((l) => /version +none: never released/.test(l)));
  assert.ok(lines.some((l) => /release +never released/.test(l)));
  assert.ok(lines.some((l) => /merged with squash/.test(l)));
  const held = R.dryRunLines(R.withPipeline(e, R.resolvePipeline(e, { file: { vouch: 'yes' } })), 'github');
  assert.deepEqual(held.slice(2), ['error: .steward.json: "vouch" must be true or false', 'held: its pipeline can\'t be read, so nothing is built or released until it\'s fixed: .steward.json: "vouch" must be true or false']);
});

