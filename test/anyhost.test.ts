import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A repository on any host, or on none (Steward 0.36.266): its pages, the host worked with, what plain git refuses in
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
const { MERGE_IT_YOURSELF, PLAIN_GIT_VOUCH, vouchOn } = await import('../src/stages/vouch.ts');
const { glabHost, glabLogin, glabRepo } = await import('../src/hosts/gitlab.ts');
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

test("a server of your own on another port or on http: its pages at its pipeline's baseUrl (found live)", async () => {
  // A Gitea at http://127.0.0.1:51412 is named 127.0.0.1/me/app, its port gone: its pages were https://127.0.0.1/….
  const site = 'http://127.0.0.1:51412';
  assert.equal(L.repoUrl('127.0.0.1/me/app', site), 'http://127.0.0.1:51412/me/app');
  assert.equal(L.releaseUrl('127.0.0.1/me/app', 'gitea', 'demo-v0.1.1', site), 'http://127.0.0.1:51412/me/app/releases/tag/demo-v0.1.1');
  assert.equal(L.commitUrl('127.0.0.1/me/app', 'gitea', 'abc', site), 'http://127.0.0.1:51412/me/app/commit/abc');
  assert.equal(L.compareUrl('127.0.0.1/me/app', 'gitea', 'v1', 'main', site), 'http://127.0.0.1:51412/me/app/compare/v1...main');
  assert.equal(L.releaseUrl('code.acme.com/team/app', 'gitlab', 'v1', 'https://code.acme.com:8443'), 'https://code.acme.com:8443/team/app/-/releases/v1');
  assert.equal(L.repoUrl('acme.com/git/team/app', 'https://acme.com/git'), 'https://acme.com/git/team/app', 'a server under a path: the path said once');
  assert.equal(L.repoUrl('codeberg.org/me/app', 'https://git.acme.com'), 'https://codeberg.org/me/app', "another host's address: its own host's, as before");
  assert.equal(L.repoUrl('codeberg.org/me/app', null), 'https://codeberg.org/me/app');
  assert.equal(L.repoUrl('octo/app', site), 'https://github.com/octo/app');
  // The host itself says it so: a release's URL in a round's result, and how to sign tea in.
  const p = (baseUrl: string) => resolvePipeline({ repo: '127.0.0.1/me/app', test: [], versionFiles: [], release: '' }, { file: { host: { kind: 'gitea', baseUrl } } });
  const o = { run: async () => ({ code: 0, out: '[]', err: '' }), neutralDir: home, host: () => 'gitea' as const };
  const gitea = hostFor(o as any, { repo: '127.0.0.1/me/app', resolvedPipeline: p(site) });
  assert.equal(gitea.releaseUrl('127.0.0.1/me/app', 'v0.1.1'), 'http://127.0.0.1:51412/me/app/releases/tag/v0.1.1');
  assert.match((await gitea.listReleases('127.0.0.1/me/app', 'tagName')).err, /^the Gitea CLI has no login for 127\.0\.0\.1: tea login add --url http:\/\/127\.0\.0\.1:51412$/);
  assert.equal(hostFor(o as any, { repo: 'codeberg.org/me/app' }).releaseUrl('codeberg.org/me/app', 'v1'), 'https://codeberg.org/me/app/releases/tag/v1', 'no baseUrl: as before');
  const gitlab = hostFor({ ...o, host: () => 'gitlab' as const } as any, { repo: 'code.acme.com/team/app', resolvedPipeline: resolvePipeline({ repo: 'code.acme.com/team/app', test: [], versionFiles: [], release: '' }, { file: { host: { kind: 'gitlab', baseUrl: 'http://code.acme.com:8080' } } }) });
  assert.equal(gitlab.releaseUrl('code.acme.com/team/app', 'v1'), 'http://code.acme.com:8080/team/app/-/releases/v1');
});

test("a repository named with its port (kit 2.146.4): its pages, glab and tea all reach it there, and http only from its baseUrl", async () => {
  assert.deepEqual(L.serverOf('127.0.0.1:8929/group/app'), { hostname: '127.0.0.1', port: '8929' });
  assert.deepEqual(L.serverOf('GitLab.acme.com/team/app'), { hostname: 'gitlab.acme.com', port: '' });
  // Its pages: at https on its port, or at its baseUrl where that says the same host and port (its http with it).
  assert.equal(L.repoUrl('127.0.0.1:8929/group/app'), 'https://127.0.0.1:8929/group/app');
  assert.equal(L.repoUrl('127.0.0.1:8929/group/app', 'http://127.0.0.1:8929'), 'http://127.0.0.1:8929/group/app');
  assert.equal(L.repoUrl('127.0.0.1:8929/group/app', 'http://127.0.0.1:9000'), 'https://127.0.0.1:8929/group/app', 'another port: its own');
  assert.equal(L.releaseUrl('gitea.acme.local:3000/me/app', 'gitea', 'v1'), 'https://gitea.acme.local:3000/me/app/releases/tag/v1');
  assert.equal(L.kindOf('gitlab.acme.com:8443/team/app', 'git'), 'gitlab');
  // glab: never --hostname with a port, which it refuses; GITLAB_HOST at https on it, or at its baseUrl's http.
  assert.deepEqual(glabHost('127.0.0.1:8929', null), { args: [], env: { GITLAB_HOST: 'https://127.0.0.1:8929' } });
  assert.deepEqual(glabHost('127.0.0.1:8929', 'http://127.0.0.1:8929'), { args: [], env: { GITLAB_HOST: 'http://127.0.0.1:8929' } });
  assert.deepEqual(glabHost('gitlab.acme.com:8443', 'https://gitlab.acme.com'), { args: [], env: { GITLAB_HOST: 'https://gitlab.acme.com:8443' } }, "its baseUrl on another port: the name's");
  assert.equal(glabRepo('127.0.0.1:8929/g/sub/app', null), 'https://127.0.0.1:8929/g/sub/app');
  assert.equal(glabRepo('127.0.0.1:8929/g/sub/app', 'http://127.0.0.1:8929'), 'http://127.0.0.1:8929/g/sub/app');
  assert.equal(glabLogin(null, '127.0.0.1:8929/g/app'), 'glab auth login --hostname 127.0.0.1:8929');
  assert.equal(glabLogin('http://127.0.0.1:8929', '127.0.0.1:8929/g/app'), 'glab auth login --hostname 127.0.0.1:8929 --api-protocol http --git-protocol http');
  assert.equal(glabLogin(null, 'gitlab.com/g/app'), 'glab auth login');
  const ran: { args: string[]; env?: Record<string, string> }[] = [];
  const o = { run: async (_cmd: string, args: string[], opts: { env?: Record<string, string> }) => (ran.push({ args, env: opts.env }), { code: 0, out: '[]', err: '' }), neutralDir: home, host: () => 'gitlab' as const };
  await hostFor(o as any, { repo: '127.0.0.1:8929/g/app' }).listPrs('127.0.0.1:8929/g/app', { state: 'open', fields: 'number' });
  assert.deepEqual(ran.map((r) => [r.args.includes('--hostname'), r.env?.GITLAB_HOST, r.args[1]]), [[false, 'https://127.0.0.1:8929', 'projects/g%2Fapp/merge_requests?state=opened&per_page=30']]);
  // tea's logins are by host: a name with its port is worked with Gitea's way where tea has a login on its host.
  const tea: import('../src/scm.ts').ScmLook = { at: new Date().toISOString(), tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.55.0', supported: true }, { cmd: 'tea', name: 'Gitea CLI', version: '0.11.0', signedIn: true, supported: true, hosts: ['127.0.0.1'] }] };
  const s = { sourceControl: 'auto' as const, releasesCastellan: false };
  assert.equal(S.hostOf({ repo: '127.0.0.1:3000/me/app', hostHint: 'gitea' }, s, tea), 'gitea');
  assert.equal(S.isGiteaRepo('127.0.0.1:3000/me/app', tea), true);
  // Manor's project named with its port is the Steward's employee by that name.
  const e = employeeOfProject({ name: 'CE', checkout: 'C:\\code\\ce', repo: '127.0.0.1:8929/group/app', branch: 'main', test: null, versionFiles: [], cleanBranches: true, host: 'gitlab' });
  assert.equal(e?.repo, '127.0.0.1:8929/group/app');
  assert.equal(e?.hostHint, 'gitlab');
});

test("a GitLab of your own on another port or on http: glab told it by GITLAB_HOST, its vouches seen, its merge and sign-in said with its port (found live)", async () => {
  // glab 1.126's api refuses --hostname 127.0.0.1:8929 ("invalid hostname"), and --hostname 127.0.0.1 asks https on 443.
  const ce = 'http://127.0.0.1:8929';
  assert.deepEqual(glabHost('127.0.0.1', ce), { args: [], env: { GITLAB_HOST: 'http://127.0.0.1:8929' } });
  assert.deepEqual(glabHost('code.acme.com', 'https://code.acme.com:8443'), { args: [], env: { GITLAB_HOST: 'https://code.acme.com:8443' } });
  assert.deepEqual(glabHost('code.acme.com', 'http://code.acme.com'), { args: [], env: { GITLAB_HOST: 'http://code.acme.com' } }, 'http on its own port too');
  assert.deepEqual(glabHost('code.acme.com', 'https://code.acme.com'), { args: ['--hostname', 'code.acme.com'] }, 'https on 443: as before');
  assert.deepEqual(glabHost('gitlab.com', null), { args: ['--hostname', 'gitlab.com'] });
  assert.deepEqual(glabHost('gitlab.com', ce), { args: ['--hostname', 'gitlab.com'] }, "another host's address: its own, as before");
  assert.equal(glabLogin(ce), 'glab auth login --hostname 127.0.0.1:8929 --api-protocol http --git-protocol http');
  assert.equal(glabLogin('https://code.acme.com:8443'), 'glab auth login --hostname code.acme.com:8443');
  assert.equal(glabLogin(undefined), 'glab auth login');
  assert.equal(glabRepo('127.0.0.1/g/sub/app', ce), 'http://127.0.0.1:8929/g/sub/app');
  assert.equal(glabRepo('gitlab.com/g/app', null), 'gitlab.com/g/app');
  assert.equal(glabRepo('code.acme.com/g/app', 'https://code.acme.com'), 'code.acme.com/g/app');

  // Its requests, as the host makes them: no --hostname, GITLAB_HOST its address.
  const repo = '127.0.0.1/g/sub/app';
  const e = { repo, resolvedPipeline: resolvePipeline({ repo, test: [], versionFiles: [], release: '' }, { file: { host: { kind: 'gitlab', baseUrl: ce } } }) };
  const asked: { args: string[]; env?: Record<string, string | undefined> }[] = [];
  const statuses = [{ name: 'steward/tested', status: 'success', author: { username: 'steward-live' }, created_at: '2026-10-31T00:00:00Z', id: 1 }];
  const run = async (_cmd: string, args: string[], opts?: { env?: Record<string, string | undefined> }) => (asked.push({ args, env: opts?.env }), { code: 0, out: JSON.stringify(args[1] === 'user' ? { username: 'steward-live' } : statuses), err: '' });
  const ctx = { run, neutralDir: home, host: (x: { repo: string; resolvedPipeline?: unknown }) => S.hostOf(x as any, { sourceControl: 'auto', releasesCastellan: false }, signedIn('glab')) };
  const gl = hostFor(ctx as any, e);
  assert.equal((await gl.whoAmI()).out.trim(), 'steward-live');
  assert.deepEqual(asked.at(-1), { args: ['api', 'user'], env: { GITLAB_HOST: ce } });
  // A vouch on it is seen at a build: asked of its GitLab as its pipeline says, not over plain git by its name alone.
  assert.equal(await vouchOn(ctx as any, e, 'abc123', ['steward-live']), 'steward-live');
  assert.deepEqual(asked.at(-1), { args: ['api', 'projects/g%2Fsub%2Fapp/repository/commits/abc123/statuses?per_page=100'], env: { GITLAB_HOST: ce } });
  assert.equal(await vouchOn(ctx as any, { repo }, 'abc123', ['steward-live']), null, 'by its name alone: plain git, no statuses');
  assert.match(MERGE_IT_YOURSELF(3, repo, { host: 'gitlab', method: 'squash', site: ce }), /\(glab mr merge 3 --repo http:\/\/127\.0\.0\.1:8929\/g\/sub\/app --squash\)/);
  const look = { at: '2026-10-30T23:59:00.000Z', tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.55.0', supported: true }, { cmd: 'glab', name: 'GitLab CLI', version: 'glab 1.126.0', supported: true, signedIn: false }] };
  assert.equal(S.whyPlainGit(e, { sourceControl: 'auto', releasesCastellan: false }, look), "its pipeline names GitLab, but the GitLab CLI isn't signed in (glab auth login --hostname 127.0.0.1:8929 --api-protocol http --git-protocol http), as the Steward last looked (2026-10-30 23:59 UTC): plain git until then");
});

test("why plain git, where a pipeline names its host: the dry run says what would give it its host's way (found live)", () => {
  const s = { sourceControl: 'auto' as const, releasesCastellan: false };
  const e = (host: unknown, repo = '127.0.0.1/me/app') => ({ repo, resolvedPipeline: resolvePipeline({ repo, test: [], versionFiles: [], release: '' }, { file: { host } }) });
  const gitea = e({ kind: 'gitea', baseUrl: 'http://127.0.0.1:51412' });
  const at = '2026-10-30T23:59:00.000Z';
  const look = (tools: import('../src/scm.ts').ScmLook['tools']): import('../src/scm.ts').ScmLook => ({ at, tools: [{ cmd: 'git', name: 'Git', version: 'git version 2.55.0', supported: true }, ...tools] });
  assert.match(S.whyPlainGit(gitea, s, null)!, /^its pipeline names Gitea, but the Steward hasn't looked at this PC's source control yet \(its page and its rounds look\): plain git until it finds Gitea's way here$/);
  assert.equal(S.whyPlainGit(gitea, s, look([{ cmd: 'tea', name: 'Gitea CLI', version: 'Version: 0.16.0', supported: true, hosts: [], signedIn: false }])), "its pipeline names Gitea, but the Gitea CLI has no login for 127.0.0.1 (tea login add --url http://127.0.0.1:51412), as the Steward last looked (2026-10-30 23:59 UTC): plain git until then");
  assert.match(S.whyPlainGit(gitea, s, look([]))!, /but the Gitea CLI \(tea\) isn't installed, as/);
  assert.equal(S.whyPlainGit(gitea, s, look([{ cmd: 'tea', name: 'Gitea CLI', version: 'Version: 0.16.0', supported: true, hosts: ['127.0.0.1'], signedIn: true }])), null, 'signed in there: worked with Gitea');
  assert.match(S.whyPlainGit(e('gitlab', 'gitlab.com/g/app'), s, look([{ cmd: 'glab', name: 'GitLab CLI', version: 'glab 1.126.0', supported: true, signedIn: false }]))!, /names GitLab, but the GitLab CLI isn't signed in \(glab auth login\)/);
  assert.match(S.whyPlainGit(e('azure', 'dev.azure.com/o/p/_git/a'), s, look([]))!, /names Azure DevOps, but the Azure CLI isn't installed/);
  assert.match(S.whyPlainGit(e('bitbucket', 'bitbucket.org/t/a'), s, look([]))!, /names Bitbucket, but no Bitbucket API token is in this PC's credential store/);
  assert.match(S.whyPlainGit(gitea, { ...s, sourceControl: 'git' as const }, null)!, /Settings' Source control is Git: plain git for every repository$/);
  assert.equal(S.whyPlainGit(e('git'), s, null), null, 'plain git asked for: nothing to say');
  assert.equal(S.whyPlainGit(e('none'), s, null), null);
  assert.equal(S.whyPlainGit({ repo: 'code.acme.com/team/app' }, s, null), null, 'no pipeline naming one: nothing said, as before');
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
  // tea takes owner/name and its server's login, never host/owner/name, which it answers "not found" (found live).
  assert.match(MERGE_IT_YOURSELF(7, 'codeberg.org/me/app', { host: 'gitea', method: 'rebase' }), /Gitea.*\(tea pr merge 7 --repo me\/app --login codeberg\.org --style rebase\)/);
  assert.match(MERGE_IT_YOURSELF(1, '127.0.0.1/steward-admin/demo', { host: 'gitea', login: 'sandbox' }), /\(tea pr merge 1 --repo steward-admin\/demo --login sandbox --style merge\)/);
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
