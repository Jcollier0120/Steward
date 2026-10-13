import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// `git ls-remote` over https answered in the agent's own process (kit 2.64.0), and git itself started without Git for
// Windows' launcher.
const { advertisedRefs, lsRemoteText, parseAdvertisement } = await import('./fixture/src/kit/smart-http.ts');
const { signedIn, remoteUrl } = await import('./fixture/src/kit/git-auth.ts');
const { gitExe } = await import('./fixture/src/kit/git-exe.ts');

const home = mkdtempSync(path.join(os.tmpdir(), 'kit-smart-http-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
// Never this PC's own git config: a proxy or rewrite of the person's would send every ask to git.
const ENV = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'none'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

// A repository with branches, an annotated and a plain tag, and a ref of the Steward's own (refs/manor/…), served bare.
const work = path.join(home, 'work');
mkdirSync(work);
git(work, 'init', '-q', '-b', 'main');
writeFileSync(path.join(work, 'a.txt'), 'a\n');
git(work, 'add', '.');
git(work, 'commit', '-q', '-m', 'one');
git(work, 'tag', '-a', '-m', 'v1', 'v1.0.0');
git(work, 'branch', 'claude/x');
writeFileSync(path.join(work, 'a.txt'), 'b\n');
git(work, 'commit', '-q', '-am', 'two');
git(work, 'tag', 'v1.1.0');
git(work, 'update-ref', 'refs/manor/release-pc', 'HEAD~1');
const bare = path.join(home, 'served.git');
git(home, 'clone', '-q', '--mirror', work, bare);
const advertisement = Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), execFileSync('git', ['upload-pack', '--advertise-refs', '--stateless-rpc', bare], { windowsHide: true, env: { ...process.env, GIT_PROTOCOL: '' } })]);

const URL_ = 'https://example.test/served.git';
const HEADER = `Basic ${Buffer.from('someone:s3cret').toString('base64')}`;

/** A fetch standing in for the host: the advertisement, or the answer given, noting each request. */
function host(answer: () => Response = () => new Response(advertisement, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })) {
  const asked: { url: string; auth: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

/** An agent's runner: git's credential helper answers for example.test; any other git command is noted, as git's. */
function runner() {
  const ran: string[][] = [];
  const run = async (_cmd: string, args: string[], opts: { input?: string; env?: Record<string, string | undefined>; cwd?: string } = {}) => {
    if (args[0] === 'credential') return /host=example\.test/.test(opts.input ?? '') ? { code: 0, out: 'username=someone\npassword=s3cret\n', err: '' } : { code: 1, out: '', err: '' };
    ran.push(args);
    return { code: 0, out: 'from git', err: '' };
  };
  return { run, ran };
}

test('an advertisement read in this process says what git ls-remote says, for every option and pattern read here', async () => {
  const cases = [
    [],
    ['refs/manor/release-pc', 'refs/manor/claims'],
    ['--heads', 'refs/heads/claude/x'],
    ['--heads'],
    ['--tags'],
    ['-t', '--refs'],
    ['--refs'],
    ['refs/tags/v1.0.0', 'refs/tags/v1.0.0^{}'],
    ['main'],
    ['-q', 'HEAD'],
    ['refs/heads/nowhere'],
  ];
  for (const c of cases) {
    const opts = c.filter((a) => a.startsWith('-'));
    const patterns = c.filter((a) => !a.startsWith('-'));
    const theirs = git(home, 'ls-remote', ...opts, bare, ...patterns);
    const { fetch, asked } = host();
    const { run, ran } = runner();
    const r = await signedIn(run, Date.now, { fetch })('git', ['ls-remote', ...opts, URL_, ...patterns], { env: ENV });
    assert.deepEqual(ran, [], `${c.join(' ')}: no git`);
    assert.equal(r.out, theirs, c.join(' ') || '(everything)');
    assert.deepEqual(asked, [{ url: `${URL_}/info/refs?service=git-upload-pack`, auth: HEADER }], 'one request, signed in as git would have been');
  }
});

test("a clone's remote by name is asked at its URL, read from the clone's config", async () => {
  const clone = path.join(home, 'clone');
  git(home, 'clone', '-q', work, clone);
  git(clone, 'remote', 'set-url', 'origin', URL_);
  git(clone, 'remote', 'add', 'other.one', 'https://example.test/other.git');
  assert.equal(remoteUrl(clone), URL_);
  assert.equal(remoteUrl(clone, 'other.one'), 'https://example.test/other.git');
  assert.equal(remoteUrl(clone, 'nowhere'), null);
  const { fetch, asked } = host();
  const { run, ran } = runner();
  const r = await signedIn(run, Date.now, { fetch })('git', ['ls-remote', '--heads', 'origin', 'refs/heads/main'], { cwd: clone, env: ENV });
  assert.deepEqual(ran, []);
  assert.equal(r.out, git(home, 'ls-remote', '--heads', bare, 'refs/heads/main'));
  assert.equal(asked[0].url, `${URL_}/info/refs?service=git-upload-pack`);
});

test("whatever isn't answered as git would is git's: other options, globs, refusals, redirects, odd answers, proxies, rewrites", async () => {
  const fellBack = async (args: string[], o: { answer?: () => Response; env?: Record<string, string>; cwd?: string } = {}) => {
    const { fetch } = host(o.answer);
    const { run, ran } = runner();
    const r = await signedIn(run, Date.now, { fetch })('git', args, { env: { ...ENV, ...o.env }, cwd: o.cwd });
    return r.out === 'from git' && ran.length === 1;
  };
  assert.ok(await fellBack(['ls-remote', '--symref', URL_, 'HEAD']), 'an option not read here');
  assert.ok(await fellBack(['ls-remote', URL_, 'refs/tags/v*']), 'a glob');
  assert.ok(await fellBack(['-C', home, 'ls-remote', URL_]), 'global options');
  assert.ok(await fellBack(['ls-remote', URL_], { answer: () => new Response('no', { status: 401 }) }), 'refused');
  assert.ok(await fellBack(['ls-remote', URL_], { answer: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }) }), 'a redirect');
  assert.ok(await fellBack(['ls-remote', URL_], { answer: () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) }), 'not an advertisement');
  assert.ok(await fellBack(['ls-remote', URL_], { answer: () => new Response('garbled', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }) }), 'garbled');
  assert.ok(await fellBack(['ls-remote', URL_], { env: { HTTPS_PROXY: 'http://proxy.test:8080' } }), 'a proxy');
  assert.ok(await fellBack(['ls-remote', URL_], { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.https://mirror.test/.insteadOf', GIT_CONFIG_VALUE_0: 'https://example.test/' } }), 'a rewrite');
  assert.ok(await fellBack(['ls-remote', URL_], { env: { KIT_SMART_HTTP: '0' } }), 'turned off');
  const quirky = path.join(home, 'quirky');
  git(home, 'clone', '-q', work, quirky);
  git(quirky, 'remote', 'set-url', 'origin', URL_);
  git(quirky, 'config', 'http.sslVerify', 'false');
  assert.ok(await fellBack(['ls-remote', 'origin'], { cwd: quirky }), "own certificates in the clone's config");
  assert.equal(await advertedOrNull('git@example.test:served.git'), null, 'SSH');
  assert.equal(await advertedOrNull('http://example.test/served.git'), null, 'plain http');
});

const advertedOrNull = (url: string) => advertisedRefs(url, { env: ENV, fetch: host().fetch });

test('an advertisement: refs in order, peeled tags kept; protocol v2, another service or noise is none', () => {
  const refs = parseAdvertisement(advertisement)!;
  assert.equal(refs[0][1], 'HEAD');
  assert.ok(refs.some(([, n]) => n === 'refs/tags/v1.0.0^{}'));
  assert.deepEqual(parseAdvertisement(Buffer.from('001e# service=git-upload-pack\n0000000eversion 2\n0000')), null);
  assert.deepEqual(parseAdvertisement(Buffer.from('001f# service=git-receive-pack\n0000')), null);
  assert.deepEqual(parseAdvertisement(Buffer.from('hello')), null);
  const pkt = (s: string) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, '0')}${s}`;
  const empty = Buffer.from(`${pkt('# service=git-upload-pack\n')}0000${pkt(`${'0'.repeat(40)} capabilities^{}\0agent=x\n`)}0000`);
  assert.deepEqual(parseAdvertisement(empty), [], 'an empty repository');
  assert.equal(lsRemoteText(['ls-remote', '--symref', URL_], refs), null);
  assert.equal(lsRemoteText(['ls-remote'], refs), null, 'no repository');
});

test("git is Git for Windows' own git.exe behind its launcher; anything else stays git", () => {
  const files = (...have: string[]) => (p: string) => have.includes(p.toLowerCase());
  const env = (p: string) => ({ Path: p });
  const top = 'c:\\program files\\git';
  assert.equal(gitExe(env(`C:\\Windows\\system32;${top}\\cmd`), { platform: 'win32', arch: 'arm64', exists: files(`${top}\\cmd\\git.exe`, `${top}\\clangarm64\\bin\\git.exe`, `${top}\\mingw64\\bin\\git.exe`) }).toLowerCase(), `${top}\\clangarm64\\bin\\git.exe`);
  assert.equal(gitExe(env(`${top}\\cmd`), { platform: 'win32', arch: 'x64', exists: files(`${top}\\cmd\\git.exe`, `${top}\\mingw64\\bin\\git.exe`) }).toLowerCase(), `${top}\\mingw64\\bin\\git.exe`);
  assert.equal(gitExe(env(`c:\\tools\\git\\bin;${top}\\cmd`), { platform: 'win32', arch: 'x64', exists: files('c:\\tools\\git\\bin\\git.exe', `${top}\\cmd\\git.exe`, `${top}\\mingw64\\bin\\git.exe`) }), 'git', 'a git earlier on PATH that is no launcher');
  assert.equal(gitExe(env(`${top}\\cmd`), { platform: 'win32', arch: 'x64', exists: files(`${top}\\cmd\\git.exe`) }), 'git', 'a launcher with nothing behind it');
  assert.equal(gitExe(env('/usr/bin'), { platform: 'linux', exists: () => true }), 'git');
  if (process.platform === 'win32') {
    const real = gitExe();
    assert.equal(execFileSync(real, ['--version'], { encoding: 'utf8', windowsHide: true }).startsWith('git version'), true, `${real} runs`);
  }
});
