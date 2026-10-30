import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A repository's origin on any host (node/manor.ts, kit 2.146.0): the host matrix, Manor's projects on any host or
// none, and today's projects and staff read exactly as before. Nothing here reads the real Manor's or Steward's files.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-origin-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(tmp, 'agent');
process.env.MANOR_HOME = path.join(tmp, 'no-manor');
process.env.STEWARD_HOME = path.join(tmp, 'no-steward');

const { HOST_KINDS, githubRepo, kindOfHost, manorOwn, manorProjects, originName, originOf, originOfName, originRepo, parseOrigin, projectOrigin, projectsFrom, repoNameOk } = await import('./fixture/src/kit/manor.ts');

const NO_OWN = { repos: [], checkouts: [] };

type Row = [url: string, kind: string, hostName: string, path: string, webUrl: string | null];

/** Every host and every way a remote's URL is written: what each one reads as. */
const MATRIX: Row[] = [
  // github.com
  ['https://github.com/Owner/App.git', 'github', 'github.com', 'Owner/App', 'https://github.com/Owner/App'],
  ['https://user@github.com/Owner/App.git', 'github', 'github.com', 'Owner/App', 'https://github.com/Owner/App'],
  ['http://www.github.com/Owner/App', 'github', 'github.com', 'Owner/App', 'https://github.com/Owner/App'],
  ['git@github.com:Owner/App.git', 'github', 'github.com', 'Owner/App', 'https://github.com/Owner/App'],
  ['ssh://git@github.com/Owner/App.git', 'github', 'github.com', 'Owner/App', 'https://github.com/Owner/App'],
  ['ssh://git@ssh.github.com:443/Owner/App.git', 'github', 'github.com', 'Owner/App', 'https://github.com/Owner/App'],
  ['git://github.com/Owner/App.git', 'github', 'github.com', 'Owner/App', 'https://github.com/Owner/App'],
  ['https://github.com/Owner/App/tree/main', 'github', 'github.com', 'Owner/App', 'https://github.com/Owner/App'],
  // GitHub Enterprise Server and ghe.com
  ['https://github.acme.com/team/app.git', 'github', 'github.acme.com', 'team/app', 'https://github.acme.com/team/app'],
  ['https://github.acme.com:8443/team/app.git', 'github', 'github.acme.com', 'team/app', 'https://github.acme.com:8443/team/app'],
  ['git@github.acme.com:team/app.git', 'github', 'github.acme.com', 'team/app', 'https://github.acme.com/team/app'],
  ['ssh://git@github-eu.acme.com/team/app.git', 'github', 'github-eu.acme.com', 'team/app', 'https://github-eu.acme.com/team/app'],
  ['https://acme.ghe.com/team/app.git', 'github', 'acme.ghe.com', 'team/app', 'https://acme.ghe.com/team/app'],
  // gitlab.com and self-hosted GitLab, with subgroups
  ['https://gitlab.com/group/app.git', 'gitlab', 'gitlab.com', 'group/app', 'https://gitlab.com/group/app'],
  ['https://gitlab.com/group/sub/app.git', 'gitlab', 'gitlab.com', 'group/sub/app', 'https://gitlab.com/group/sub/app'],
  ['git@gitlab.com:group/sub/deeper/app.git', 'gitlab', 'gitlab.com', 'group/sub/deeper/app', 'https://gitlab.com/group/sub/deeper/app'],
  ['ssh://git@gitlab.com:2222/group/app.git', 'gitlab', 'gitlab.com', 'group/app', 'https://gitlab.com/group/app'],
  ['https://oauth2@gitlab.com/group/app.git', 'gitlab', 'gitlab.com', 'group/app', 'https://gitlab.com/group/app'],
  ['https://gitlab.com/group/app/-/tree/main', 'gitlab', 'gitlab.com', 'group/app', 'https://gitlab.com/group/app'],
  ['https://gitlab.acme.io/platform/tools/app.git', 'gitlab', 'gitlab.acme.io', 'platform/tools/app', 'https://gitlab.acme.io/platform/tools/app'],
  ['http://gitlab.lan:8080/platform/tools/app.git', 'gitlab', 'gitlab.lan', 'platform/tools/app', 'http://gitlab.lan:8080/platform/tools/app'],
  ['git@code-gitlab.acme.io:platform/app.git', 'gitlab', 'code-gitlab.acme.io', 'platform/app', 'https://code-gitlab.acme.io/platform/app'],
  // Bitbucket Cloud, and Bitbucket Data Center
  ['https://bitbucket.org/team/app.git', 'bitbucket', 'bitbucket.org', 'team/app', 'https://bitbucket.org/team/app'],
  ['https://jo@bitbucket.org/team/app.git', 'bitbucket', 'bitbucket.org', 'team/app', 'https://bitbucket.org/team/app'],
  ['git@bitbucket.org:team/app.git', 'bitbucket', 'bitbucket.org', 'team/app', 'https://bitbucket.org/team/app'],
  ['ssh://git@altssh.bitbucket.org:443/team/app.git', 'bitbucket', 'bitbucket.org', 'team/app', 'https://bitbucket.org/team/app'],
  ['https://bitbucket.acme.com/scm/plat/app.git', 'bitbucket', 'bitbucket.acme.com', 'plat/app', 'https://bitbucket.acme.com/projects/PLAT/repos/app'],
  ['ssh://git@bitbucket.acme.com:7999/plat/app.git', 'bitbucket', 'bitbucket.acme.com', 'plat/app', 'https://bitbucket.acme.com/projects/PLAT/repos/app'],
  ['https://bitbucket.acme.com/scm/~jo/app.git', 'bitbucket', 'bitbucket.acme.com', '~jo/app', 'https://bitbucket.acme.com/users/jo/repos/app'],
  // Azure DevOps: dev.azure.com, its ssh form, and the older org.visualstudio.com
  ['https://dev.azure.com/acme/Platform/_git/app', 'azure', 'dev.azure.com', 'acme/Platform/_git/app', 'https://dev.azure.com/acme/Platform/_git/app'],
  ['https://acme@dev.azure.com/acme/Platform/_git/app', 'azure', 'dev.azure.com', 'acme/Platform/_git/app', 'https://dev.azure.com/acme/Platform/_git/app'],
  ['https://dev.azure.com/acme/My%20Project/_git/app', 'azure', 'dev.azure.com', 'acme/My%20Project/_git/app', 'https://dev.azure.com/acme/My%20Project/_git/app'],
  ['https://dev.azure.com/acme/_git/app', 'azure', 'dev.azure.com', 'acme/app/_git/app', 'https://dev.azure.com/acme/app/_git/app'],
  ['git@ssh.dev.azure.com:v3/acme/Platform/app', 'azure', 'dev.azure.com', 'acme/Platform/_git/app', 'https://dev.azure.com/acme/Platform/_git/app'],
  ['ssh://git@ssh.dev.azure.com/v3/acme/Platform/app', 'azure', 'dev.azure.com', 'acme/Platform/_git/app', 'https://dev.azure.com/acme/Platform/_git/app'],
  ['https://acme.visualstudio.com/Platform/_git/app', 'azure', 'acme.visualstudio.com', 'Platform/_git/app', 'https://acme.visualstudio.com/Platform/_git/app'],
  ['https://acme.visualstudio.com/DefaultCollection/Platform/_git/app', 'azure', 'acme.visualstudio.com', 'Platform/_git/app', 'https://acme.visualstudio.com/Platform/_git/app'],
  ['https://acme.visualstudio.com/_git/app', 'azure', 'acme.visualstudio.com', 'app/_git/app', 'https://acme.visualstudio.com/app/_git/app'],
  ['acme@vs-ssh.visualstudio.com:v3/acme/Platform/app', 'azure', 'acme.visualstudio.com', 'Platform/_git/app', 'https://acme.visualstudio.com/Platform/_git/app'],
  // Gitea, Forgejo and Codeberg
  ['https://gitea.com/me/app.git', 'gitea', 'gitea.com', 'me/app', 'https://gitea.com/me/app'],
  ['https://codeberg.org/me/app.git', 'gitea', 'codeberg.org', 'me/app', 'https://codeberg.org/me/app'],
  ['git@codeberg.org:me/app.git', 'gitea', 'codeberg.org', 'me/app', 'https://codeberg.org/me/app'],
  ['https://next.forgejo.org/me/app', 'gitea', 'next.forgejo.org', 'me/app', 'https://next.forgejo.org/me/app'],
  ['ssh://git@git.forgejo.example:2222/me/app.git', 'gitea', 'git.forgejo.example', 'me/app', 'https://git.forgejo.example/me/app'],
  ['http://gitea.acme.local:3000/me/app.git', 'gitea', 'gitea.acme.local', 'me/app', 'http://gitea.acme.local:3000/me/app'],
  // Any other server: plain ssh, scp-style, git://, a host whose name says nothing
  ['ssh://git@server.example/srv/git/app.git', 'other', 'server.example', 'srv/git/app', null],
  ['ssh://server.example:2200/~/app.git', 'other', 'server.example', '~/app', null],
  ['git@server.example:repos/app.git', 'other', 'server.example', 'repos/app', null],
  ['server.example:app.git', 'other', 'server.example', 'app', null],
  ['git://git.kernel.org/pub/scm/git/git.git', 'other', 'git.kernel.org', 'pub/scm/git/git', null],
  ['https://code.acme.com/group/sub/app.git', 'other', 'code.acme.com', 'group/sub/app', null],
  ['https://acme.github.io/app.git', 'other', 'acme.github.io', 'app', null],
  // A folder or a share: local
  ['C:\\repos\\app.git', 'local', '', 'C:\\repos\\app.git', null],
  ['C:/repos/app', 'local', '', 'C:/repos/app', null],
  ['D:\\code\\app\\', 'local', '', 'D:\\code\\app', null],
  ['\\\\nas\\git\\app.git', 'local', '', '\\\\nas\\git\\app.git', null],
  ['//nas/git/app.git', 'local', '', '//nas/git/app.git', null],
  ['file:///C:/repos/app.git', 'local', '', 'C:/repos/app.git', null],
  ['file:///srv/git/My%20App.git', 'local', '', '/srv/git/My App.git', null],
  ['file://nas/git/app.git', 'local', '', '//nas/git/app.git', null],
  ['/srv/git/app.git', 'local', '', '/srv/git/app.git', null],
  ['../app.git', 'local', '', '../app.git', null],
  ['~/repos/app.git', 'local', '', '~/repos/app.git', null],
];

/** The same remote written the other ways: without its .git or with one, and with a slash at its end. */
function variants(url: string): string[] {
  if (/^([a-z]:|\\\\|\/|\.|~|file:)/i.test(url) || /\/-\/|\/tree\//.test(url)) return [url];
  const bare = url.replace(/\.git$/, '');
  return [...new Set([url, bare, `${bare}.git`, `${bare}/`, `${bare}.git/`])];
}

test('the host matrix: every host, every way of writing its URL, with and without .git', () => {
  for (const [url, kind, hostName, p, webUrl] of MATRIX) {
    for (const v of variants(url)) {
      assert.deepEqual(parseOrigin(v), { kind, hostName, path: p, webUrl }, v);
      assert.deepEqual(parseOrigin(`  ${v}\n`), { kind, hostName, path: p, webUrl }, `${v}, with space around it`);
    }
  }
  // The kinds cover the brief's hosts: each one is somewhere in the matrix.
  assert.deepEqual([...new Set(MATRIX.map((r) => r[1]))].sort(), ['azure', 'bitbucket', 'gitea', 'github', 'gitlab', 'local', 'other']);
});

test("what isn't a remote at all is null", () => {
  for (const bad of ['', '   ', 'https://', 'ssh://', 'https://github.com/a\nb', '\u0000']) assert.equal(parseOrigin(bad), null, JSON.stringify(bad));
  // A host with no repository on it is another server's, never GitHub's.
  assert.deepEqual(parseOrigin('https://github.com/just-an-owner'), { kind: 'other', hostName: 'github.com', path: 'just-an-owner', webUrl: null });
  assert.deepEqual(parseOrigin('https://gitlab.com/group'), { kind: 'other', hostName: 'gitlab.com', path: 'group', webUrl: null });
  assert.deepEqual(parseOrigin('https://dev.azure.com/acme/Platform'), { kind: 'other', hostName: 'dev.azure.com', path: 'acme/Platform', webUrl: null });
});

test("a host's kind from its name", () => {
  const cases: [string, string][] = [
    ['github.com', 'github'], ['GitHub.com', 'github'], ['github.acme.com', 'github'], ['acme.ghe.com', 'github'], ['github-eu.acme.com', 'github'],
    ['gitlab.com', 'gitlab'], ['gitlab.acme.io', 'gitlab'], ['code-gitlab.acme.io', 'gitlab'],
    ['bitbucket.org', 'bitbucket'], ['bitbucket.acme.com', 'bitbucket'],
    ['dev.azure.com', 'azure'], ['ssh.dev.azure.com', 'azure'], ['acme.visualstudio.com', 'azure'],
    ['gitea.com', 'gitea'], ['codeberg.org', 'gitea'], ['gitea.acme.local', 'gitea'], ['forgejo.acme.local', 'gitea'], ['next.forgejo.org', 'gitea'],
    ['code.acme.com', 'other'], ['acme.github.io', 'other'], ['raw.githubusercontent.com', 'other'], ['server.example', 'other'],
  ];
  for (const [host, kind] of cases) assert.equal(kindOfHost(host), kind, host);
  assert.deepEqual([...HOST_KINDS], ['github', 'gitlab', 'bitbucket', 'azure', 'gitea', 'other']);
});

test("a hint from settings says what a host's name doesn't, and never changes a public host", () => {
  const cases: [string, unknown, unknown][] = [
    ['https://code.acme.com/group/sub/app.git', 'gitlab', { kind: 'gitlab', hostName: 'code.acme.com', path: 'group/sub/app', webUrl: 'https://code.acme.com/group/sub/app' }],
    ['git@code.acme.com:group/sub/app.git', { 'code.acme.com': 'gitlab' }, { kind: 'gitlab', hostName: 'code.acme.com', path: 'group/sub/app', webUrl: 'https://code.acme.com/group/sub/app' }],
    ['https://scm.acme.com/team/app.git', 'github', { kind: 'github', hostName: 'scm.acme.com', path: 'team/app', webUrl: 'https://scm.acme.com/team/app' }],
    ['https://git.acme.com/me/app.git', { 'git.acme.com': 'gitea' }, { kind: 'gitea', hostName: 'git.acme.com', path: 'me/app', webUrl: 'https://git.acme.com/me/app' }],
    ['https://git.acme.com/scm/plat/app.git', 'bitbucket', { kind: 'bitbucket', hostName: 'git.acme.com', path: 'plat/app', webUrl: 'https://git.acme.com/projects/PLAT/repos/app' }],
    ['https://tfs.acme.com/tfs/DefaultCollection/Platform/_git/app', 'azure', { kind: 'azure', hostName: 'tfs.acme.com', path: 'tfs/DefaultCollection/Platform/_git/app', webUrl: 'https://tfs.acme.com/tfs/DefaultCollection/Platform/_git/app' }],
    ['https://gitlab-mirror.acme.com/me/app.git', 'gitea', { kind: 'gitea', hostName: 'gitlab-mirror.acme.com', path: 'me/app', webUrl: 'https://gitlab-mirror.acme.com/me/app' }],
    ['https://github.acme.com/team/app.git', 'other', { kind: 'other', hostName: 'github.acme.com', path: 'team/app', webUrl: null }],
    // A hint for another host, a kind there isn't, or one on a public host: the name decides.
    ['https://code.acme.com/group/app.git', { 'other.acme.com': 'gitlab' }, { kind: 'other', hostName: 'code.acme.com', path: 'group/app', webUrl: null }],
    ['https://code.acme.com/group/app.git', 'svn', { kind: 'other', hostName: 'code.acme.com', path: 'group/app', webUrl: null }],
    ['https://github.com/Owner/App.git', 'gitlab', { kind: 'github', hostName: 'github.com', path: 'Owner/App', webUrl: 'https://github.com/Owner/App' }],
    ['https://gitlab.com/group/app.git', 'github', { kind: 'gitlab', hostName: 'gitlab.com', path: 'group/app', webUrl: 'https://gitlab.com/group/app' }],
    ['https://dev.azure.com/acme/Platform/_git/app', 'gitea', { kind: 'azure', hostName: 'dev.azure.com', path: 'acme/Platform/_git/app', webUrl: 'https://dev.azure.com/acme/Platform/_git/app' }],
    // A hint where the path doesn't fit the kind: another server's.
    ['https://code.acme.com/app.git', 'gitlab', { kind: 'other', hostName: 'code.acme.com', path: 'app', webUrl: null }],
    ['https://code.acme.com/a/b/c', 'azure', { kind: 'other', hostName: 'code.acme.com', path: 'a/b/c', webUrl: null }],
    // A folder is local whatever is said.
    ['C:\\repos\\app', 'github', { kind: 'local', hostName: '', path: 'C:\\repos\\app', webUrl: null }],
  ];
  for (const [url, hint, want] of cases) assert.deepEqual(parseOrigin(url, hint as never), want, `${url} with ${JSON.stringify(hint)}`);
});

test("a repository's name as the manor gives it: owner/name on github.com as always, host/path anywhere else, and back", () => {
  const names: [string, string][] = [
    ['https://github.com/Owner/App.git', 'Owner/App'],
    ['git@github.acme.com:team/app.git', 'github.acme.com/team/app'],
    ['git@gitlab.com:group/sub/app.git', 'gitlab.com/group/sub/app'],
    ['https://bitbucket.org/team/app.git', 'bitbucket.org/team/app'],
    ['git@ssh.dev.azure.com:v3/acme/Platform/app', 'dev.azure.com/acme/Platform/_git/app'],
    ['https://acme.visualstudio.com/DefaultCollection/Platform/_git/app', 'acme.visualstudio.com/Platform/_git/app'],
    ['https://codeberg.org/me/app.git', 'codeberg.org/me/app'],
    ['git@server.example:repos/app.git', 'server.example/repos/app'],
    ['C:\\repos\\app.git', 'local/app'],
    ['\\\\nas\\git\\My App\\', 'local/My App'],
  ];
  for (const [url, name] of names) {
    const o = parseOrigin(url)!;
    assert.equal(originName(o), name, url);
    if (o.kind === 'local') continue;
    // Read back from its name, with a hint where the name doesn't say: the same place.
    const back = originOfName(name, o.kind === 'other' ? undefined : o.kind);
    assert.deepEqual(back && { kind: back.kind, hostName: back.hostName, path: back.path }, { kind: o.kind, hostName: o.hostName, path: o.path }, name);
  }
  assert.deepEqual(originOfName('Owner/App'), { kind: 'github', hostName: 'github.com', path: 'Owner/App', webUrl: 'https://github.com/Owner/App' }, "owner/name is GitHub's, as a project's repo always was");
  assert.deepEqual(originOfName('code.acme.com/group/app', 'gitlab'), { kind: 'gitlab', hostName: 'code.acme.com', path: 'group/app', webUrl: 'https://code.acme.com/group/app' });
  for (const bad of ['', 'no-slash', 'C:\\x', 'https://github.com/a/b', '../a/b']) assert.equal(originOfName(bad), null, bad);
});

test('a name an agent is asked about is owner/name or host/path, plain, with no "." or ".." part', () => {
  const ok = ['Owner/App', 'me/app.js', 'gitlab.com/group/sub/app', 'dev.azure.com/acme/Platform/_git/app', 'dev.azure.com/acme/My%20Project/_git/app', 'bitbucket.acme.com/~jo/app', 'local/app'];
  const bad = ['', 'app', '../app', 'a/..', 'a/./b', '-x/app', 'gitlab.com/-x', 'a/b/--upload-pack=x', 'a/b c', 'a\\b', `a/${'b'.repeat(101)}`, `${'a/'.repeat(10)}b`, 'a/b?x', 'a/b#x'];
  for (const n of ok) assert.equal(repoNameOk(n), true, n);
  for (const n of bad) assert.equal(repoNameOk(n), false, n);
});

/** A clone on disk: its .git/config with this origin (none for null), or a worktree of it (`worktreeOf`). */
function cloneAt(name: string, url: string | null, o: { worktreeOf?: string } = {}): string {
  const dir = path.join(tmp, 'clones', name);
  mkdirSync(dir, { recursive: true });
  if (o.worktreeOf) {
    const gitdir = path.join(o.worktreeOf, '.git', 'worktrees', name);
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    writeFileSync(path.join(dir, '.git'), `gitdir: ${gitdir}\n`);
    return dir;
  }
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  const origin = url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '';
  writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/someone/else.git\n${origin}[branch "main"]\n\tremote = origin\n`);
  return dir;
}

test("a clone's origin on any host: its config's origin, a worktree's through its main clone, local without one, null for no clone", () => {
  const gh = cloneAt('gh', 'https://github.com/Owner/App.git');
  const gl = cloneAt('gl', 'git@gitlab.acme.io:group/sub/app.git');
  const az = cloneAt('az', 'https://acme@dev.azure.com/acme/Platform/_git/app');
  const bb = cloneAt('bb', 'git@bitbucket.org:team/app.git');
  const cb = cloneAt('cb', 'https://codeberg.org/me/app.git');
  const share = cloneAt('share', '\\\\nas\\git\\app.git');
  const none = cloneAt('none', null);
  const wt = cloneAt('wt', null, { worktreeOf: gl });
  const plain = path.join(tmp, 'clones', 'plain');
  mkdirSync(plain, { recursive: true });
  const self = cloneAt('self', 'https://code.acme.com/group/app.git');
  const cases: [string, unknown, unknown?][] = [
    [gh, { kind: 'github', hostName: 'github.com', path: 'Owner/App', webUrl: 'https://github.com/Owner/App' }],
    [gl, { kind: 'gitlab', hostName: 'gitlab.acme.io', path: 'group/sub/app', webUrl: 'https://gitlab.acme.io/group/sub/app' }],
    [az, { kind: 'azure', hostName: 'dev.azure.com', path: 'acme/Platform/_git/app', webUrl: 'https://dev.azure.com/acme/Platform/_git/app' }],
    [bb, { kind: 'bitbucket', hostName: 'bitbucket.org', path: 'team/app', webUrl: 'https://bitbucket.org/team/app' }],
    [cb, { kind: 'gitea', hostName: 'codeberg.org', path: 'me/app', webUrl: 'https://codeberg.org/me/app' }],
    [share, { kind: 'local', hostName: '', path: '\\\\nas\\git\\app.git', webUrl: null }],
    [none, { kind: 'local', hostName: '', path: none, webUrl: null }],
    [wt, { kind: 'gitlab', hostName: 'gitlab.acme.io', path: 'group/sub/app', webUrl: 'https://gitlab.acme.io/group/sub/app' }],
    [plain, null],
    [path.join(tmp, 'clones', 'gone'), null],
    [self, { kind: 'gitlab', hostName: 'code.acme.com', path: 'group/app', webUrl: 'https://code.acme.com/group/app' }, 'gitlab'],
  ];
  for (const [dir, want, hint] of cases) assert.deepEqual(originOf(dir, hint as never), want, dir);
  // originRepo is GitHub's alone, as it always was: owner/name on github.com, null anywhere else.
  assert.deepEqual([gh, gl, az, bb, cb, share, none, wt, plain].map(originRepo), ['Owner/App', null, null, null, null, null, null, null, null]);
});

test('a project on any host: its repo as host/path or a clone URL, its "host" for a host whose name does not say', () => {
  const problems: string[] = [];
  const projects = projectsFrom([
    { name: 'Lab', checkout: 'C:\\code\\lab', repo: 'gitlab.com/group/sub/app' },
    { name: 'Lab URL', checkout: 'C:\\code\\lab-url', repo: 'git@gitlab.com:group/sub/other.git' },
    { name: 'Hub URL', checkout: 'C:\\code\\hub-url', repo: 'https://github.com/Owner/App.git' },
    { name: 'Hub host', checkout: 'C:\\code\\hub-host', repo: 'github.com/Owner/Other' },
    { name: 'Enterprise', checkout: 'C:\\code\\ghe', repo: 'github.acme.com/team/app' },
    { name: 'Azure', checkout: 'C:\\code\\az', repo: 'https://dev.azure.com/acme/Platform/_git/app', versionFiles: ['package.json'], merges: true, release: 'tag' },
    { name: 'Azure old', checkout: 'C:\\code\\vs', repo: 'acme.visualstudio.com/Platform/_git/app' },
    { name: 'Bucket', checkout: 'C:\\code\\bb', repo: 'bitbucket.org/team/app', merges: true },
    { name: 'Berg', checkout: 'C:\\code\\cb', repo: 'codeberg.org/me/app' },
    { name: 'Own GitLab', checkout: 'C:\\code\\own', repo: 'code.acme.com/group/app', host: 'GitLab' },
    { name: 'Own Gitea', checkout: 'C:\\code\\tea', repo: 'git@git.acme.com:me/app.git', host: 'gitea' },
    { name: 'Server', checkout: 'C:\\code\\srv', repo: 'git@server.example:repos/app.git' },
    { name: 'Local', checkout: 'C:\\code\\local' },
    { name: 'Hinted local', checkout: 'C:\\code\\hinted', host: 'other' },
    { name: 'Owner', checkout: 'C:\\code\\owner', repo: 'Owner/Plain', host: 'github' },
  ], NO_OWN, problems);
  assert.deepEqual(problems, []);
  assert.deepEqual(projects.map((p) => [p.name, p.repo, p.host ?? null, p.merges, p.release]), [
    ['Lab', 'gitlab.com/group/sub/app', null, false, ''],
    ['Lab URL', 'gitlab.com/group/sub/other', null, false, ''],
    ['Hub URL', 'Owner/App', null, false, ''],
    ['Hub host', 'Owner/Other', null, false, ''],
    ['Enterprise', 'github.acme.com/team/app', null, false, ''],
    ['Azure', 'dev.azure.com/acme/Platform/_git/app', null, true, 'tag'],
    ['Azure old', 'acme.visualstudio.com/Platform/_git/app', null, false, ''],
    ['Bucket', 'bitbucket.org/team/app', null, true, ''],
    ['Berg', 'codeberg.org/me/app', null, false, ''],
    ['Own GitLab', 'code.acme.com/group/app', 'gitlab', false, ''],
    ['Own Gitea', 'git.acme.com/me/app', 'gitea', false, ''],
    ['Server', 'server.example/repos/app', null, false, ''],
    ['Local', null, null, false, ''],
    ['Hinted local', null, 'other', false, ''],
    ['Owner', 'Owner/Plain', 'github', false, ''],
  ]);
  // Where each one is.
  const where = (name: string) => {
    const o = projectOrigin(projects.find((p) => p.name === name)!);
    return o && `${o.kind} ${o.hostName} ${o.path}`;
  };
  assert.equal(where('Lab'), 'gitlab gitlab.com group/sub/app');
  assert.equal(where('Enterprise'), 'github github.acme.com team/app');
  assert.equal(where('Own GitLab'), 'gitlab code.acme.com group/app');
  assert.equal(where('Own Gitea'), 'gitea git.acme.com me/app');
  assert.equal(where('Server'), 'other server.example repos/app');
  assert.equal(where('Local'), null, 'no repo, and no clone there');
  const local = cloneAt('project-local', null);
  assert.deepEqual(projectOrigin({ repo: null, checkout: local }), { kind: 'local', hostName: '', path: local, webUrl: null }, 'a clone with no origin is local');
  const selfHosted = cloneAt('project-self', 'git@code.acme.com:group/app.git');
  assert.deepEqual(projectOrigin({ repo: null, checkout: selfHosted, host: 'gitlab' }), { kind: 'gitlab', hostName: 'code.acme.com', path: 'group/app', webUrl: 'https://code.acme.com/group/app' }, 'its clone, with its host');
});

test("a project's repo or host that can't be one is said in a sentence, and the rest stand", () => {
  const cases: [unknown, RegExp][] = [
    [{ name: 'A', checkout: 'C:\\x', repo: 'C:\\repos\\app.git' }, /entry 1 \("A"\) gives a folder as its "repo": a repository kept only on this PC, or a share, has none, so leave "repo" out; it's left out\./],
    [{ name: 'A', checkout: 'C:\\x', repo: 'file:///C:/repos/app.git' }, /gives a folder as its "repo"/],
    [{ name: 'A', checkout: 'C:\\x', repo: '\\\\nas\\git\\app' }, /gives a folder as its "repo"/],
    [{ name: 'A', checkout: 'C:\\x', repo: 'Owner/App', host: 'gitlab' }, /says its "host" is gitlab, but gives its "repo" as owner\/name, which is GitHub's: give it as host\/path/],
    [{ name: 'A', checkout: 'C:\\x', repo: 'gitlab.com/g/app', host: 'svn' }, /should give its "host" as one of github, gitlab, bitbucket, azure, gitea, other, or none/],
    [{ name: 'A', checkout: 'C:\\x', host: 7 }, /"host"/],
    [{ name: 'A', checkout: 'C:\\x', host: 'local' }, /"host"/],
    [{ name: 'A', checkout: 'C:\\x', repo: 'gitlab.com/a b' }, /should give its "repo" as owner\/name on GitHub, host\/path anywhere else \(gitlab\.com\/group\/app\), its clone URL, or none/],
    [{ name: 'A', checkout: 'C:\\x', repo: 'https://' }, /"repo" as owner\/name/],
    [{ name: 'A', checkout: 'C:\\x', repo: 'x'.repeat(301) }, /"repo"/],
    [{ name: 'A', checkout: 'C:\\x', repo: 7 }, /"repo"/],
  ];
  for (const [entry, said] of cases) {
    const problems: string[] = [];
    assert.deepEqual(projectsFrom([entry, { name: 'Fine', checkout: 'C:\\fine' }], NO_OWN, problems).map((p) => p.name), ['Fine'], JSON.stringify(entry));
    assert.equal(problems.length, 1, JSON.stringify(entry));
    assert.match(problems[0], said);
  }
  // The manor's own is refused by its GitHub URL as by its name.
  const problems: string[] = [];
  assert.deepEqual(projectsFrom([{ name: 'Mine', checkout: 'D:\\x', repo: 'https://github.com/Jcollier0120/Porter.git' }], { repos: ['Jcollier0120/Porter'], checkouts: [] }, problems), []);
  assert.match(problems[0], /is Jcollier0120\/Porter, one of the manor's own/);
});

test("today's projects read exactly as they always did: every key, its order and its value", () => {
  const problems: string[] = [];
  const today = projectsFrom([
    { name: ' Side Car ', checkout: 'C:\\Projects\\SideCar' },
    { name: 'Full', checkout: 'D:\\code\\full\\', repo: 'someone/full.js', branch: 'release/2.x', test: 'npm test', versionFiles: ['package.json', ' package-lock.json ', 'PACKAGE.JSON'], cleanBranches: false, extra: 'kept out' },
    { name: 'Share', checkout: '\\\\nas\\code\\share', repo: '', branch: '', test: null, versionFiles: [], cleanBranches: null },
    { name: 'Mine', checkout: 'D:\\mine', repo: 'me/mine', versionFiles: ['package.json'], merges: true, release: ' tag ' },
    { name: 'Cmd', checkout: 'D:\\cmd', repo: 'me/cmd', versionFiles: ['package.json'], release: 'npm run release', merges: null },
  ], NO_OWN, problems);
  assert.deepEqual(problems, []);
  assert.equal(
    JSON.stringify(today),
    JSON.stringify([
      { name: 'Side Car', checkout: 'C:\\Projects\\SideCar', repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true, merges: false, release: '' },
      { name: 'Full', checkout: 'D:\\code\\full\\', repo: 'someone/full.js', branch: 'release/2.x', test: 'npm test', versionFiles: ['package.json', 'package-lock.json'], cleanBranches: false, merges: false, release: '' },
      { name: 'Share', checkout: '\\\\nas\\code\\share', repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true, merges: false, release: '' },
      { name: 'Mine', checkout: 'D:\\mine', repo: 'me/mine', branch: 'main', test: null, versionFiles: ['package.json'], cleanBranches: true, merges: true, release: 'tag' },
      { name: 'Cmd', checkout: 'D:\\cmd', repo: 'me/cmd', branch: 'main', test: null, versionFiles: ['package.json'], cleanBranches: true, merges: false, release: 'npm run release' },
    ]),
    'no "host" key unless an entry gives one',
  );
  // Today's wrong entries are still wrong, in today's words.
  const wrong: [unknown, RegExp][] = [
    [{ name: 'A', checkout: 'C:\\x', repo: 'no-slash' }, /"repo" as owner\/name/],
    [{ name: 'A', checkout: 'C:\\x', merges: true }, /says "merges", but has no "repo"/],
    [{ name: 'A', checkout: 'C:\\x', repo: 'me/a', release: 'tag' }, /needs a "repo" and its "versionFiles"/],
    [{ name: 'A', checkout: 'C:\\x', versionFiles: ['package.json'], release: 'tag' }, /needs a "repo"/],
  ];
  for (const [entry, said] of wrong) {
    const p: string[] = [];
    assert.deepEqual(projectsFrom([entry], NO_OWN, p), [], JSON.stringify(entry));
    assert.match(p[0], said);
  }
  // A GitHub remote's owner/name, as always.
  assert.equal(githubRepo('git@github.com:a-b/c.d.git'), 'a-b/c.d');
  assert.equal(githubRepo('https://gitlab.com/a/b'), null);
});

test("today's Manor (settings.json's projects) and its staff.json, and the Steward's, read exactly as they always did", () => {
  const home = path.join(tmp, 'manor-today');
  const steward = path.join(tmp, 'steward-today');
  mkdirSync(path.join(home, 'app'), { recursive: true });
  mkdirSync(steward, { recursive: true });
  writeFileSync(path.join(home, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'porter', release: { repo: 'Jcollier0120/Porter' } }, { id: 'reeve', release: { id: 'reeve' } }, 'junk'] }));
  writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'manor', release: { repo: 'Jcollier0120/Manor' } }] }));
  writeFileSync(path.join(steward, 'settings.json'), JSON.stringify({ stewardCheckout: 'C:\\Projects\\Steward', employees: [{ id: 'heiward', repo: 'Jcollier0120/Heiward', checkout: 'C:\\Projects\\Heiward' }] }));
  writeFileSync(path.join(steward, 'staff.json'), JSON.stringify({ rows: [{ repo: 'Jcollier0120/Old', checkout: { path: 'C:\\Projects\\Old' } }] }));
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({ name: 'Home', projects: [{ name: 'Side car', checkout: 'D:\\side-car' }, { name: 'Tools', checkout: 'D:\\tools', repo: 'me/tools', branch: 'dev', test: 'npm test', versionFiles: ['package.json'], cleanBranches: false, merges: true, release: 'tag' }, { name: 'Porter copy', checkout: 'D:\\porter', repo: 'Jcollier0120/Porter' }] }),
  );
  const own = manorOwn({ home, stewardHome: steward, staffFile: path.join(home, 'app', 'staff.json') });
  assert.equal(JSON.stringify(own), JSON.stringify({ repos: ['Jcollier0120/Porter', 'Jcollier0120/Manor', 'Jcollier0120/Heiward'], checkouts: ['C:\\Projects\\Heiward', 'C:\\Projects\\Steward'] }));
  // Its staff.json read when the Steward's settings name no employees.
  writeFileSync(path.join(steward, 'settings.json'), JSON.stringify({ releasesCastellan: true }));
  assert.equal(JSON.stringify(manorOwn({ home, stewardHome: steward, staffFile: path.join(home, 'app', 'staff.json') })), JSON.stringify({ repos: ['Jcollier0120/Porter', 'Jcollier0120/Manor', 'Jcollier0120/Old'], checkouts: ['C:\\Projects\\Old'] }));
  process.env.STEWARD_HOME = steward;
  try {
    assert.equal(
      JSON.stringify(manorProjects(home)),
      JSON.stringify([
        { name: 'Side car', checkout: 'D:\\side-car', repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true, merges: false, release: '' },
        { name: 'Tools', checkout: 'D:\\tools', repo: 'me/tools', branch: 'dev', test: 'npm test', versionFiles: ['package.json'], cleanBranches: false, merges: true, release: 'tag' },
      ]),
      "the manor's own (Porter) is left out, as before",
    );
  } finally {
    process.env.STEWARD_HOME = path.join(tmp, 'no-steward');
  }
});
