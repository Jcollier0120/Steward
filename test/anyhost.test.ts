import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A repository on any host, or on none (Steward 0.36.264): its pages, the host worked with, what plain git refuses in
// words, merging by each host's own command, its version in Cargo.toml or pyproject.toml, Look after and Manor's
// Repositories for one with no origin, its refs kept here, and the team named from every host's account.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-anyhost-'));
process.env.STEWARD_HOME = path.join(home, 'steward');
process.env.MANOR_HOME = path.join(home, 'no-manor');
after(() => rmSync(home, { recursive: true, force: true }));

const L = await import('../src/links.ts');
const S = await import('../src/scm.ts');
const { hostFor } = await import('../src/hosts/index.ts');
const { PlainGit } = await import('../src/hosts/plaingit.ts');
const { MERGE_IT_YOURSELF, PLAIN_GIT_VOUCH } = await import('../src/stages/vouch.ts');
const { readVersion, setVersion } = await import('../src/versions.ts');
const { remoteOf } = await import('../src/git.ts');
const { notClaimed } = await import('../src/claims.ts');
const { remoteFor } = await import('../src/lease.ts');
const { resolvePipeline, withPipeline } = await import('../src/repoconfig.ts');
const { addToManor, foundOfFolder, readClone } = await import('../src/found.ts');
const { DEFAULT_SETTINGS, employeeOfProject, TAG_RELEASE } = await import('../src/settings.ts');
const { teamOf } = await import('../src/team.ts');

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const settings = { ...structuredClone(DEFAULT_SETTINGS), employees: [] };
const signedIn = (cmd: string): import('../src/scm.ts').ScmLook => ({ at: new Date().toISOString(), tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.55.0', supported: true }, { cmd, name: cmd, version: `${cmd} 1.0`, signedIn: true, supported: true }] });
const employee = (o: Record<string, unknown> = {}) => ({ id: 'app', name: 'App', repo: 'octo/app', checkout: '', branch: 'main', merges: false, usesKit: false, fill: '', test: [], versionFiles: ['package.json'], release: TAG_RELEASE, install: '', approve: '', installed: '', ...o }) as import('../src/settings.ts').Employee;

/** A clone with a commit and no origin at all: one on this PC alone. */
function localClone(name: string, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const dir = path.join(home, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '-m', 'first');
  return dir;
}

test("a repository's pages on its own host; none for a local one", () => {
  assert.equal(L.repoUrl('octo/app'), 'https://github.com/octo/app');
  assert.equal(L.repoUrl('gitlab.com/group/sub/app'), 'https://gitlab.com/group/sub/app');
  assert.equal(L.repoUrl('local/notes'), null);
  assert.equal(L.repoUrl(''), null);
  const rel = (repo: string, host: any) => L.releaseUrl(repo, host, 'v1.2.0');
  assert.equal(rel('octo/app', 'github'), 'https://github.com/octo/app/releases/tag/v1.2.0');
  assert.equal(rel('octo/app', 'git'), 'https://github.com/octo/app/releases/tag/v1.2.0', 'its name says GitHub: its tag page there');
  assert.equal(rel('gitlab.com/group/app', 'gitlab'), 'https://gitlab.com/group/app/-/releases/v1.2.0');
  assert.equal(rel('code.acme.com/team/app', 'gitlab'), 'https://code.acme.com/team/app/-/releases/v1.2.0', 'a GitLab of your own, worked its way');
  assert.equal(rel('codeberg.org/me/app', 'git'), 'https://codeberg.org/me/app/releases/tag/v1.2.0');
  assert.equal(rel('bitbucket.org/team/app', 'bitbucket'), 'https://bitbucket.org/team/app/src/v1.2.0');
  assert.equal(rel('dev.azure.com/org/proj/_git/app', 'azure'), 'https://dev.azure.com/org/proj/_git/app?version=GTv1.2.0');
  assert.equal(rel('git.acme.com/team/app', 'git'), null, "a server whose kind isn't known: no page guessed");
  assert.equal(rel('local/notes', 'git'), null);
  assert.equal(L.commitUrl('octo/app', 'github', 'abc'), 'https://github.com/octo/app/commit/abc');
  assert.equal(L.commitUrl('gitlab.com/g/app', 'gitlab', 'abc'), 'https://gitlab.com/g/app/-/commit/abc');
  assert.equal(L.commitUrl('bitbucket.org/t/app', 'bitbucket', 'abc'), 'https://bitbucket.org/t/app/commits/abc');
  assert.equal(L.commitUrl('local/notes', 'git', 'abc'), null);
  assert.equal(L.compareUrl('octo/app', 'github', 'v1', 'main'), 'https://github.com/octo/app/compare/v1...main');
  assert.equal(L.compareUrl('gitlab.com/g/app', 'gitlab', 'v1', 'main'), 'https://gitlab.com/g/app/-/compare/v1...main');
  assert.equal(L.compareUrl('bitbucket.org/t/app', 'bitbucket', 'v1', 'main'), null);
  assert.deepEqual(['octo/app', 'gitlab.com/g/a', 'local/x', 'git.acme.com/a/b'].map((r) => L.hostWord(r)), ['GitHub', 'GitLab', 'this PC', 'its host']);
});

test("the host a repository is worked with: its pipeline's, Manor's hint, else its name; plain git where its CLI isn't signed in", () => {
  const s = { sourceControl: 'auto' as const, releasesCastellan: false };
  const gitlabHere = signedIn('glab');
  const p = (file: unknown, repo = 'code.acme.com/team/app') => resolvePipeline({ repo, test: [], versionFiles: [], release: '' }, { file });
  assert.equal(S.hostOf({ repo: 'code.acme.com/team/app' }, s, gitlabHere), 'git', "its name doesn't say");
  assert.equal(S.hostOf({ repo: 'code.acme.com/team/app', resolvedPipeline: p({ host: { kind: 'gitlab', baseUrl: 'https://code.acme.com' } }) }, s, gitlabHere), 'gitlab', 'its pipeline says');
  assert.equal(S.hostOf({ repo: 'code.acme.com/team/app', hostHint: 'gitlab' }, s, gitlabHere), 'gitlab', "Manor's Repositories say");
  assert.equal(S.hostOf({ repo: 'code.acme.com/team/app', hostHint: 'gitlab' }, s, null), 'git', 'glab not signed in: plain git');
  assert.equal(S.hostOf({ repo: 'octo/app', resolvedPipeline: p({ host: 'none' }, 'octo/app') }, s, signedIn('gh')), 'git', 'none is plain git, on GitHub too');
  assert.equal(S.hostOf({ repo: 'octo/app', resolvedPipeline: p({ host: 'git' }, 'octo/app') }, s, signedIn('gh')), 'git');
  assert.equal(S.hostOf({ repo: 'local/notes' }, s, signedIn('gh')), 'git', 'a local one is never GitHub');
  assert.equal(S.hostOf({ repo: 'octo/app' }, { ...s, releasesCastellan: true }, null), 'github', "Castellan's machinery is GitHub's whatever is said");
});

test('plain git refuses in words what it has not, and is never GitHub asked of a repository not on it', async () => {
  const o = { run: async () => assert.fail('nothing is run'), neutralDir: home, host: () => 'git' as const };
  const h = hostFor(o as any, { repo: 'git.acme.com/team/app' });
  assert.ok(h instanceof PlainGit);
  assert.equal(h.kind, 'git');
  for (const a of [await h.listPrs('git.acme.com/team/app', { state: 'open', fields: 'number' }), await h.statuses('x', 'abc'), await h.createRelease('x', { tag: 'v1', target: 'abc', title: 't', notesFile: null }), await h.listIssues('x', { label: 'l', state: 'open', fields: 'number' }), await h.whoAmI()]) {
    assert.equal(a.code, 1);
    assert.match(a.err, /^git\.acme\.com\/team\/app is worked with plain git here, which has no .+: sign in to its host's CLI for the Steward to work with them \(docs\/PIPELINE\.md\)$/);
  }
  assert.equal(h.releaseUrl('x', 'v1'), '');
  assert.equal(hostFor(o as any, { repo: 'local/notes' }).kind, 'git');
  assert.equal(hostFor(o as any, { repo: 'octo/app' }).kind, 'github', 'one on GitHub, worked with plain git, is still answered by GitHub where asked (as before)');
  assert.match(PLAIN_GIT_VOUCH({ name: 'Notes', repo: 'local/notes', branch: 'main' }), /^Notes \(local\/notes\) is worked with plain git on this PC, which has no pull requests .*land your branch in main.*steward build --dry-run local\/notes/);
});

test("merge it yourself: each host's own command, by the pipeline's merge method", () => {
  assert.match(MERGE_IT_YOURSELF(7, 'octo/app'), /\(gh pr merge 7 --repo octo\/app --merge\)/, 'as before');
  assert.match(MERGE_IT_YOURSELF(7, 'octo/app', { method: 'squash' }), /gh pr merge 7 --repo octo\/app --squash/);
  assert.match(MERGE_IT_YOURSELF(7, 'gitlab.com/g/app', { host: 'gitlab' }), /once GitLab says it merges cleanly \(glab mr merge 7 --repo gitlab\.com\/g\/app\)/);
  assert.match(MERGE_IT_YOURSELF(7, 'gitlab.com/g/app', { host: 'gitlab', method: 'squash' }), /glab mr merge 7 --repo gitlab\.com\/g\/app --squash/);
  assert.match(MERGE_IT_YOURSELF(7, 'dev.azure.com/o/p/_git/a', { host: 'azure', method: 'squash' }), /Azure DevOps.*az repos pr update --id 7 --status completed --squash true/);
  assert.match(MERGE_IT_YOURSELF(7, 'codeberg.org/me/app', { host: 'gitea', method: 'rebase' }), /Gitea.*tea pr merge 7 --repo codeberg\.org\/me\/app --style rebase/);
  assert.match(MERGE_IT_YOURSELF(null, 'bitbucket.org/t/a', { host: 'bitbucket', method: 'squash' }), /Bitbucket.*its Merge button on bitbucket\.org, squash/);
  assert.match(MERGE_IT_YOURSELF(null, 'octo/app'), /gh pr merge <number>/);
});

test("a crate's and a Python project's version, read and set in its manifest's own table", () => {
  const cargo = '[package]\nname = "app"\nversion = "0.3.1"\n\n[dependencies]\nserde = { version = "1.0.0" }\n';
  assert.equal(readVersion('Cargo.toml', cargo), '0.3.1');
  assert.equal(setVersion('Cargo.toml', cargo, '0.3.1', '0.3.2'), cargo.replace('version = "0.3.1"', 'version = "0.3.2"'), "a dependency's version is left alone");
  const workspace = '[workspace]\nmembers = ["a"]\n\n[workspace.package]\nversion = "2.0.0"\n';
  assert.equal(readVersion('crates/Cargo.toml', workspace), '2.0.0');
  const py = '[project]\nname = "app"\nversion = "1.4.0"\n\n[tool.other]\nversion = "9.9.9"\n';
  assert.equal(readVersion('pyproject.toml', py), '1.4.0');
  assert.match(setVersion('pyproject.toml', py, '1.4.0', '1.5.0'), /\[project\]\nname = "app"\nversion = "1\.5\.0"\n\n\[tool\.other\]\nversion = "9\.9\.9"/);
  const poetry = '[tool.poetry]\nname = "app"\nversion = "0.1.0"\n';
  assert.equal(readVersion('pyproject.toml', poetry), '0.1.0');
  assert.equal(readVersion('pyproject.toml', '[project]\nname = "app"\ndynamic = ["version"]\n'), null, 'a dynamic version: none to read');
  assert.throws(() => setVersion('Cargo.toml', '[dependencies]\n', '1.0.0', '1.0.1'), /Cargo\.toml has no version = "x\.y\.z" in \[package\] or \[workspace\.package\]/);
});

test('a clone with no origin: its fetches its own, looked after as local/<folder>, and Manor takes it with no repo', () => {
  const dir = localClone('notes', { 'pyproject.toml': '[project]\nname = "notes"\nversion = "0.2.0"\n', 'notes.py': 'x = 1\n' });
  assert.equal(remoteOf(dir), '.');
  git(dir, 'fetch', '--quiet', remoteOf(dir), '+refs/heads/main:refs/remotes/origin/main');
  assert.equal(git(dir, 'rev-parse', 'origin/main'), git(dir, 'rev-parse', 'HEAD'), 'its origin/main is its own main');
  assert.deepEqual(readClone(dir, 'main'), { test: ['python -m pytest'], versionFiles: ['pyproject.toml'], releaseScript: false });
  const r = foundOfFolder(dir, () => 'main')!;
  assert.deepEqual([r.repo, r.branch, r.byGit, r.push], ['local/notes', 'main', true, null]);
  assert.equal(foundOfFolder(path.join(home, 'nowhere')), null);
  assert.equal(foundOfFolder('  '), null);
  // Into Manor's Repositories: with no repo, and none of what needs one.
  const manor = path.join(home, 'manor');
  mkdirSync(manor, { recursive: true });
  writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ projects: [] }));
  const e = employee({ id: 'notes', name: 'notes', repo: 'local/notes', checkout: dir, merges: true, release: TAG_RELEASE, test: ['python -m pytest'], versionFiles: ['pyproject.toml'] });
  assert.equal(addToManor(e, manor), null);
  const projects = JSON.parse(readFileSync(path.join(manor, 'settings.json'), 'utf8')).projects;
  assert.deepEqual(projects, [{ name: 'notes', checkout: dir, test: 'python -m pytest', versionFiles: ['pyproject.toml'] }]);
  // And read back: a Manor project with no repo whose clone is local is looked after, as local/<folder>.
  const back = employeeOfProject({ name: 'notes', checkout: dir, branch: 'main', test: 'python -m pytest', versionFiles: ['pyproject.toml'] } as any)!;
  assert.deepEqual([back.repo, back.checkout, back.test, back.versionFiles, back.release], ['local/notes', dir, ['python -m pytest'], ['pyproject.toml'], '']);
  // One whose clone is on a host but that names no repository is left out, as before; so is one with no clone here.
  const hosted = localClone('hosted');
  git(hosted, 'remote', 'add', 'origin', 'https://gitlab.com/g/hosted.git');
  assert.equal(employeeOfProject({ name: 'hosted', checkout: hosted } as any), null);
  assert.equal(employeeOfProject({ name: 'gone', checkout: path.join(home, 'gone') } as any), null);
  // A project's host goes with it, for one whose name doesn't say.
  assert.equal(employeeOfProject({ name: 'app', repo: 'code.acme.com/team/app', checkout: hosted, host: 'gitlab' } as any)!.hostHint, 'gitlab');
  assert.equal(employeeOfProject({ name: 'app', repo: 'octo/app', checkout: hosted } as any)!.hostHint, undefined);
});

test("its turns and claims: on its origin, unless its pipeline keeps them here; none for a local one off GitHub", async () => {
  const run = async () => ({ code: 1, out: '', err: '' });
  const dir = localClone('refs-local');
  assert.equal(await remoteFor(run as any, settings, { repo: 'local/refs-local', checkout: dir }), null, 'no origin, not on GitHub: kept here');
  const hosted = localClone('refs-hosted');
  git(hosted, 'remote', 'add', 'origin', 'https://gitlab.com/g/refs.git');
  assert.equal((await remoteFor(run as any, settings, { repo: 'gitlab.com/g/refs', checkout: hosted }))?.url, 'https://gitlab.com/g/refs.git');
  const kept = resolvePipeline({ repo: 'gitlab.com/g/refs', test: [], versionFiles: [], release: '' }, { file: { sharedRefs: false } });
  assert.equal(await remoteFor(run as any, settings, { repo: 'gitlab.com/g/refs', checkout: hosted, resolvedPipeline: kept }), null);
  assert.equal((await remoteFor(run as any, settings, { repo: 'octo/app', checkout: '' }))?.url, 'https://github.com/octo/app.git', 'on GitHub with no clone here: as before');
});

test("versions not claimed: said in words for a pipeline that sets them by hand, by tags, or never", () => {
  const e = employee();
  assert.equal(notClaimed(e), null, 'claimed, as always');
  const by = (file: unknown) => notClaimed(withPipeline(e, resolvePipeline(e, { file })) as any);
  assert.equal(by({ versioning: 'files' }), "App's versions aren't claimed: its pipeline says versioning files (.steward.json), so its version is set by hand in package.json");
  assert.match(by({ versioning: 'tags', releaseTo: 'tag' })!, /versioning tags \(\.steward\.json\), so each release takes the patch after its newest release tag$/);
  assert.match(by({ versioning: 'none' })!, /so it has no versions$/);
});

test("the team with Settings' empty: gh's account, and each other host's, named once", () => {
  assert.deepEqual(teamOf([], () => 'octo', []), { team: ['octo'], from: 'gh', note: 'Team is empty in Settings: the account gh is signed in as (octo).' }, 'as before');
  const t = teamOf([], () => 'octo', [{ login: 'jo', at: 'gitlab.com' }, { login: 'Octo', at: 'codeberg.org' }, { login: 'jo', at: 'code.acme.com' }]);
  assert.deepEqual(t.team, ['octo', 'jo']);
  assert.equal(t.note, 'Team is empty in Settings: the account gh is signed in as (octo), and on gitlab.com jo.');
  const hostsOnly = teamOf([], () => null, [{ login: 'jo', at: 'gitlab.com' }]);
  assert.deepEqual([hostsOnly.team, hostsOnly.from, hostsOnly.note], [['jo'], 'hosts', 'Team is empty in Settings: the accounts signed in on gitlab.com (jo).']);
  assert.deepEqual(teamOf(['me'], () => assert.fail('gh asked'), [{ login: 'jo', at: 'gitlab.com' }]).team, ['me']);
});
