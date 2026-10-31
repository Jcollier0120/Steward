import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { headerOf, httpsOrigin, listsTarget, originsOf, refused, remoteOrigins, signedIn, signInEnv, signInOf, subcommand } from '../src/git-auth.ts';
import { fetchFor, hasObject } from '../src/git.ts';
import type { Ran, Runner, RunOptions } from '../src/run.ts';
import { gitExe } from '../src/kit/git-exe.ts';

// Fewer processes (Steward 0.35.31): git's sign-in handed over up front, and a PR's head fetched only when it isn't here.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-auth-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const g = (cwd: string, ...args: string[]) => execFileSync(gitExe(), args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

function repoWith(name: string, url: string): string {
  const repo = path.join(home, name);
  execFileSync(gitExe(), ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  g(repo, 'remote', 'add', 'origin', url);
  return repo;
}

const FILL = 'protocol=https\nhost=github.com\nusername=someone\npassword=s3cret\n';
const HEADER = `Authorization: Basic ${Buffer.from('someone:s3cret').toString('base64')}`;
const FILL2 = 'protocol=https\nhost=github.com\nusername=someone\npassword=renewed\n';
const HEADER2 = `Authorization: Basic ${Buffer.from('someone:renewed').toString('base64')}`;
const REFUSED: Ran = { code: 128, out: '', err: "remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/a/b.git/'" };

/**
 * A runner that answers `git credential fill` with `fill` (or `fill(input, n)`), `git config --get-urlmatch` with
 * `config`, and everything else with `answer`, noting each call.
 */
function fake(o: { fill?: Ran | ((input: string, n: number) => Ran); config?: Ran; answer?: (args: string[], opts: RunOptions, n: number) => Ran } = {}) {
  const calls: { args: string[]; opts: RunOptions }[] = [];
  let n = 0;
  let f = 0;
  const inner: Runner = async (_cmd, args, opts = {}) => {
    calls.push({ args, opts });
    if (args[0] === 'credential' && args[1] === 'fill') return typeof o.fill === 'function' ? o.fill(opts.input ?? '', f++) : (o.fill ?? { code: 0, out: FILL, err: '' });
    if (args[0] === 'credential') return { code: 0, out: '', err: '' };
    if (args[0] === 'config') return o.config ?? { code: 1, out: '', err: '' };
    return o.answer?.(args, opts, n++) ?? { code: 0, out: '', err: '' };
  };
  const of = (...kinds: string[]) => calls.filter((c) => kinds.includes(c.args[0] === 'credential' ? `credential ${c.args[1]}` : c.args[0]));
  return {
    inner,
    calls,
    fills: () => of('credential fill').length,
    fillInputs: () => of('credential fill').map((c) => c.opts.input),
    rejects: () => of('credential reject'),
    approves: () => of('credential approve'),
    configs: () => of('config'),
    gits: () => calls.filter((c) => c.args[0] !== 'credential' && c.args[0] !== 'config'),
  };
}

/** The git settings an environment hands over (GIT_CONFIG_KEY_n = GIT_CONFIG_VALUE_n), past `from`. */
function settings(env: Record<string, string | undefined> | undefined, from = Number(process.env.GIT_CONFIG_COUNT) || 0): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = from; i < Number(env?.GIT_CONFIG_COUNT ?? 0); i++) out[env![`GIT_CONFIG_KEY_${i}`]!] = env![`GIT_CONFIG_VALUE_${i}`]!;
  return out;
}

/** A stand-in host for the kit's own requests: `answer(url, authorization)`'s status, noting each; `challenge` its 401s' WWW-Authenticate. */
function host(answer: (url: string, auth: string | null) => number, challenge: string | null = null) {
  const asked: { url: string; auth: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    asked.push({ url: String(url), auth });
    const status = answer(String(url), auth);
    return status === 200
      ? new Response(Buffer.from('001e# service=git-upload-pack\n0000'), { status, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
      : new Response('no', { status, headers: status === 401 && challenge ? { 'www-authenticate': challenge } : {} });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

test('the git command past its global options, and the https origins a command talks to', () => {
  assert.equal(subcommand(['fetch', '--quiet', 'origin']), 'fetch');
  assert.equal(subcommand(['-C', 'x', '-c', 'a=b', '--no-pager', 'push', 'origin']), 'push');
  assert.equal(subcommand(['--version']), null);
  assert.equal(httpsOrigin('https://GitHub.com/a/b.git'), 'https://github.com');
  assert.equal(httpsOrigin('https://host:8443/x'), 'https://host:8443');
  assert.equal(httpsOrigin('https://me@github.com/a/b'), null, 'a URL with its own user signs in its own way');
  assert.equal(httpsOrigin('git@github.com:a/b.git'), null);
  assert.deepEqual(originsOf(['fetch', '--quiet', 'https://github.com/a/b.git', '+refs/x:refs/y'], undefined), ['https://github.com']);
  assert.equal(originsOf(['push', 'git@github.com:a/b.git', 'HEAD:refs/heads/x'], undefined), null, 'SSH: left to git');
  assert.equal(originsOf(['fetch', 'origin'], undefined), null, 'no URL and no clone: nothing to say');
});

test('where an https URL signs in (kit 2.146.6): its origin, its own user and password, its path as written and as git hands it over', () => {
  assert.deepEqual(signInOf('https://GitHub.COM/a/b.git/'), { origin: 'https://github.com', user: null, password: false, rawPath: 'a/b.git', path: 'a/b.git' }, 'an upper-case host; a trailing slash');
  assert.deepEqual(signInOf('https://me@bitbucket.org/ws/repo.git'), { origin: 'https://bitbucket.org', user: 'me', password: false, rawPath: 'ws/repo.git', path: 'ws/repo.git' });
  assert.deepEqual(signInOf('https://me:t%40ken@host:8443/x'), { origin: 'https://host:8443', user: 'me', password: true, rawPath: 'x', path: 'x' }, 'its own password: never kept here');
  assert.deepEqual(signInOf('https://dev.azure.com/org/My%20Project/_git/My%20Repo'), { origin: 'https://dev.azure.com', user: null, password: false, rawPath: 'org/My%20Project/_git/My%20Repo', path: 'org/My Project/_git/My Repo' });
  assert.equal(signInOf('https://[::1]:8929/group/app')?.origin, 'https://[::1]:8929');
  assert.equal(signInOf('https://host')?.rawPath, '');
  assert.equal(signInOf('http://127.0.0.1:8929/group/app'), null, 'http: git signs in its own way');
  assert.equal(signInOf('git@github.com:a/b.git'), null);
  assert.equal(signInOf('ssh://git@ssh.dev.azure.com/v3/org/p/r'), null);
});

test("a clone's remotes from its config file, a worktree's from its main clone's", () => {
  const repo = repoWith('remotes', 'https://github.com/a/b.git');
  g(repo, 'remote', 'add', 'other', 'https://gitlab.example.test/c/d.git');
  assert.deepEqual(remoteOrigins(repo), ['https://github.com', 'https://gitlab.example.test']);
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  g(repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'add', '.');
  g(repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', 'commit', '-qm', 'one');
  const wt = path.join(home, 'remotes-wt');
  g(repo, 'worktree', 'add', '-q', '--detach', wt);
  assert.deepEqual(originsOf(['fetch', 'origin'], wt), ['https://github.com', 'https://gitlab.example.test']);
  const ssh = repoWith('ssh', 'git@github.com:a/b.git');
  assert.equal(originsOf(['fetch', 'origin'], ssh), null);
});

test("the helper's answer as a header; the environment switches that host's helpers off and keeps entries already there", () => {
  assert.equal(headerOf(FILL), HEADER);
  assert.equal(headerOf('protocol=https\r\nhost=x\r\nusername=u\r\npassword=p\r\n'), `Authorization: Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(headerOf('protocol=https\nhost=x\n'), null);
  const env = signInEnv(new Map([['https://github.com', HEADER]]), { GIT_CONFIG_COUNT: '1' });
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper', "that host's helpers, not every host's (kit 2.146.6)");
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(env.GIT_CONFIG_KEY_2, 'http.https://github.com/.extraHeader');
  assert.equal(env.GIT_CONFIG_VALUE_2, HEADER);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.deepEqual(
    settings(signInEnv(new Map([['https://dev.azure.com/org/p/_git/r', HEADER]]), {}, ['https://host/own']), 0),
    { 'credential.https://host/own.helper': '', 'credential.https://dev.azure.com/org/p/_git/r.helper': '', 'http.https://dev.azure.com/org/p/_git/r.extraHeader': HEADER },
    "a repository's own, where git asks helpers by path; a URL with its own password: its helpers off, no header",
  );
  assert.ok(refused({ code: 128, out: '', err: "remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/a/b.git/'" }));
  assert.ok(refused({ code: 128, out: '', err: 'fatal: unable to access ...: The requested URL returned error: 403' }));
  assert.ok(!refused({ code: 128, out: '', err: "fatal: couldn't find remote ref refs/pull/401/head" }), 'a PR numbered 401 is no refusal');
});

test('a fetch over https carries the sign-in in its environment, asked of the helper once, never on its command line', async () => {
  const repo = repoWith('signed', 'https://github.com/a/b.git');
  const f = fake();
  const run = signedIn(f.inner);
  const args = ['fetch', '--quiet', 'origin', 'refs/pull/7/head'];
  await run('git', args, { cwd: repo });
  await run('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/x'], { cwd: repo });
  assert.equal(f.fills(), 1, 'asked once, kept');
  const fill = f.calls.find((c) => c.args[0] === 'credential')!;
  assert.equal(fill.opts.input, 'protocol=https\nhost=github.com\n\n');
  assert.equal(fill.opts.env?.GCM_INTERACTIVE, 'never');
  // After the settings the environment already gives (the test run's own, kit/node/test-git.ts).
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  assert.equal(f.configs().length, 0, 'a host that gives its sign-in: git is asked nothing more');
  for (const c of f.gits()) {
    assert.equal(c.opts.env?.[`GIT_CONFIG_VALUE_${n + 1}`], HEADER);
    assert.equal(c.opts.env?.[`GIT_CONFIG_KEY_${n}`], 'credential.https://github.com.helper');
    assert.ok(!c.args.join(' ').includes('s3cret') && !c.args.join(' ').includes(HEADER.slice(-10)), 'nothing secret in argv');
  }
  assert.deepEqual(f.gits()[0].args, args, 'the command itself unchanged');
});

test('everything else goes as given: other commands, git that stays local, SSH, a host with no sign-in kept', async () => {
  const repo = repoWith('plain', 'https://github.com/a/b.git');
  const ssh = repoWith('plain-ssh', 'git@github.com:a/b.git');
  let t = 0;
  const f = fake({ fill: { code: 128, out: '', err: 'fatal: no credential' } });
  const run = signedIn(f.inner, () => t);
  const opts = { cwd: repo, env: { A: '1' } };
  await run('gh', ['pr', 'list'], opts);
  await run('git', ['status'], opts);
  await run('git', ['fetch', 'origin'], { cwd: ssh });
  assert.equal(f.fills(), 0);
  await run('git', ['fetch', 'origin'], opts);
  await run('git', ['fetch', 'origin'], opts);
  assert.equal(f.fills(), 1, 'none kept: not asked again for a while');
  assert.equal(f.configs().length, 1, 'whether git asks helpers by path, asked once, when the host gave none');
  for (const c of f.gits()) assert.equal(c.opts.env?.GIT_CONFIG_COUNT, undefined, "git's own way");
  assert.deepEqual(f.gits().at(-1)!.opts, opts);
  t += 11 * 60_000;
  await run('git', ['fetch', 'origin'], opts);
  assert.equal(f.fills(), 2, 'asked again later');
});

test("a sign-in the host refuses is never handed back to git's own way, whose helper would erase it (kit 2.146.6)", async () => {
  const repo = repoWith('refused', 'https://github.com/a/b.git');
  // The host refuses this repository whatever the sign-in: it isn't there, or isn't shared with you (Bitbucket, Azure DevOps).
  const f = fake({ answer: () => REFUSED });
  const run = signedIn(f.inner);
  assert.deepEqual(await run('git', ['fetch', 'origin'], { cwd: repo }), REFUSED, 'the refusal, as it is');
  assert.equal(f.gits().length, 1, "not run again: never git's own way");
  assert.equal(f.fills(), 2, 'the helper asked once more, in case it renews its sign-in');
  assert.equal(f.rejects().length, 0, 'nothing forgotten: nothing shows the sign-in stale');
  await run('git', ['fetch', 'origin'], { cwd: repo });
  assert.equal(settings(f.gits()[1].opts.env)['http.https://github.com/.extraHeader'], HEADER, 'the sign-in kept, still handed over');
  assert.equal(f.gits().length, 2);

  // A helper that renews its sign-in when asked again (Bitbucket's and Azure DevOps' check theirs): run once more with it.
  const renews = fake({ fill: (_input, n) => ({ code: 0, out: n === 0 ? FILL : FILL2, err: '' }), answer: (_a, opts) => (settings(opts.env)['http.https://github.com/.extraHeader'] === HEADER2 ? { code: 0, out: 'ok', err: '' } : REFUSED) });
  const r = await signedIn(renews.inner)('git', ['fetch', 'origin'], { cwd: repo });
  assert.deepEqual(r, { code: 0, out: 'ok', err: '' });
  assert.deepEqual(
    renews.gits().map((c) => settings(c.opts.env)['http.https://github.com/.extraHeader']),
    [HEADER, HEADER2],
    'twice, both with a sign-in: the second the renewed one',
  );
  assert.equal(renews.rejects().length, 0);

  // A failure that isn't a refusal is the command's own: not run twice, the helper not asked again.
  const other = fake({ answer: () => ({ code: 128, out: '', err: "fatal: couldn't find remote ref refs/pull/9/head" }) });
  assert.equal((await signedIn(other.inner)('git', ['fetch', 'origin', 'refs/pull/9/head'], { cwd: repo })).code, 128);
  assert.equal(other.gits().length, 1);
  assert.equal(other.fills(), 1);
});

test('a refused sign-in is forgotten only when shown stale: the host refuses it on a repository it read, or on a public one it reads with none', async () => {
  const read = repoWith('was-read', 'https://github.com/a/read.git');
  const missing = repoWith('missing', 'https://github.com/a/missing.git');
  const READ = 'https://github.com/a/read.git/info/refs?service=git-upload-pack';
  const MISSING = 'https://github.com/a/missing.git/info/refs?service=git-upload-pack';
  const auth = HEADER.replace(/^authorization:\s*/i, '');
  const auth2 = HEADER2.replace(/^authorization:\s*/i, '');
  /**
   * A git that reads a/read.git with the sign-in `git.good` (and nothing of a/missing.git); a helper that renews its
   * sign-in once told to forget it.
   */
  const setUp = (good: string) => {
    let forgotten = false;
    const git = { good };
    const f = fake({
      fill: () => ({ code: 0, out: forgotten ? FILL2 : FILL, err: '' }),
      answer: (args, opts) => (args.includes('origin') && settings(opts.env)['http.https://github.com/.extraHeader'] === git.good && opts.cwd === read ? { code: 0, out: 'ok', err: '' } : REFUSED),
    });
    const inner: Runner = async (cmd, args, opts) => {
      if (args[0] === 'credential' && args[1] === 'reject') forgotten = true;
      return f.inner(cmd, args, opts);
    };
    return { f, inner, git };
  };

  {
    // Stale: a/read.git read with HEADER, then a/missing.git refused, and a/read.git now refuses HEADER too.
    const { f, inner } = setUp(HEADER);
    let stale = false;
    const h = host((url, a) => (url === READ && a === auth && !stale ? 200 : url === READ && a === auth2 ? 200 : 401));
    const run = signedIn(inner, Date.now, { fetch: h.fetch });
    assert.equal((await run('git', ['fetch', 'origin'], { cwd: read })).code, 0);
    stale = true;
    const r = await run('git', ['fetch', 'origin'], { cwd: missing });
    assert.deepEqual(h.asked, [{ url: READ, auth }], 'asked of the repository it read, with it');
    assert.equal(f.rejects().length, 1, 'shown stale: the helper told to forget it, as git would');
    assert.equal(f.rejects()[0].opts.input, `${FILL.trimEnd()}\n\n`, "exactly the helper's own answer");
    assert.equal(f.rejects()[0].opts.env?.GCM_INTERACTIVE, 'never');
    assert.deepEqual(
      f.gits().slice(1).map((c) => settings(c.opts.env)['http.https://github.com/.extraHeader']),
      [HEADER, HEADER2],
      'the refused command run once more, with the renewed sign-in',
    );
    assert.equal(r.code, 128, 'a/missing.git is still refused: it isn’t there');
  }
  {
    // Not stale: the repository it read still reads with it. The refusal is a/missing.git's own: nothing forgotten.
    const { f, inner } = setUp(HEADER);
    const h = host((url, a) => (url === READ && a === auth ? 200 : 401));
    const run = signedIn(inner, Date.now, { fetch: h.fetch });
    await run('git', ['fetch', 'origin'], { cwd: read });
    assert.equal((await run('git', ['fetch', 'origin'], { cwd: missing })).code, 128);
    assert.equal(f.rejects().length, 0);
    assert.deepEqual(h.asked, [{ url: READ, auth }]);
    await run('git', ['fetch', 'origin'], { cwd: missing });
    assert.equal(h.asked.length, 1, 'refused again: known to be its own, the host not asked again');
    assert.equal(f.gits().length, 3, 'each command once');
  }
  {
    // The refused repository is the only one it read: a repository taken away, or no longer shared, is refused as a
    // stale sign-in would be, and the host refuses it with none too. Nothing shows the sign-in stale: nothing forgotten.
    const { f, inner, git } = setUp(HEADER);
    const h = host(() => 401);
    const run = signedIn(inner, Date.now, { fetch: h.fetch });
    await run('git', ['fetch', 'origin'], { cwd: read });
    git.good = 'none';
    assert.equal((await run('git', ['fetch', 'origin'], { cwd: read })).code, 128);
    assert.deepEqual(h.asked, [{ url: READ, auth }, { url: READ, auth: null }]);
    assert.equal(f.rejects().length, 0);
  }
  {
    // Nothing it read to compare with: a public repository the host reads with no sign-in but refuses with this one.
    const { f, inner } = setUp('none');
    const h = host((url, a) => (url === MISSING && a === null ? 200 : a === auth2 ? 200 : 401));
    const run = signedIn(inner, Date.now, { fetch: h.fetch });
    await run('git', ['fetch', 'origin'], { cwd: missing });
    assert.deepEqual(h.asked, [{ url: MISSING, auth }, { url: MISSING, auth: null }]);
    assert.equal(f.rejects().length, 1, 'shown stale');
  }
  {
    // A host that only says 403 or 404 (not shared, not there) shows nothing about the sign-in: nothing forgotten.
    for (const status of [403, 404, 500]) {
      const { f, inner } = setUp('none');
      const h = host(() => status);
      await signedIn(inner, Date.now, { fetch: h.fetch })('git', ['fetch', 'origin'], { cwd: missing });
      assert.equal(f.rejects().length, 0, String(status));
      assert.equal(f.gits().length, 1);
    }
  }
  {
    // Under node --test with no fetch of the test's own, no host is asked: nothing can show it stale.
    const { f, inner } = setUp('none');
    await signedIn(inner)('git', ['fetch', 'origin'], { cwd: missing });
    assert.equal(f.rejects().length, 0);
  }
});

test("cmdkey's list names a target: whole, ignoring case, with or without its type (kit 2.147.4)", () => {
  const T = 'git:https://refresh_token.codeberg.org';
  const listed = (target: string) => `\r\nCurrently stored credentials for ${T}:\r\n\r\n    Target: ${target}\r\n    Type: Generic \r\n    User: someone\r\n    Local machine persistence\r\n`;
  assert.ok(listsTarget(listed(T), T));
  assert.ok(listsTarget(listed('git:https://REFRESH_TOKEN.Codeberg.org'), T), 'Windows ignores case');
  assert.ok(listsTarget(listed(`LegacyGeneric:target=${T}`), T), 'as `cmdkey /list` names it');
  assert.ok(listsTarget(`Ziel: ${T}`, T), 'in another language');
  assert.ok(!listsTarget(`\r\nCurrently stored credentials for ${T}:\r\n\r\n* NONE *\r\n`, T), 'none: the name it was asked for is no target');
  assert.ok(!listsTarget(listed(`${T}.example`), T));
  assert.ok(!listsTarget(listed(`x${T}`), T));
  assert.ok(!listsTarget(listed('git:https://codeberg.org'), T), 'the access token alone');
  assert.ok(!listsTarget(listed('git:https://oauth-refresh-token.gitlab.com'), 'git:https://refresh_token.gitlab.com'), "GitLab's refresh token (GCM's own name) is no refresh_token target: never forgotten");
});

test('an access token Git Credential Manager hands back stale is forgotten where it keeps a refresh token: once a while, the refresh token kept (kit 2.147.4)', async () => {
  const repo = repoWith('oauth', 'https://forge.example.test/me/private.git');
  const PROBE = 'https://forge.example.test/me/private.git/info/refs?service=git-upload-pack';
  const ACCESS = 'git:https://forge.example.test';
  const REFRESH = 'git:https://refresh_token.forge.example.test';
  const auth = HEADER.replace(/^authorization:\s*/i, '');
  const ok: Ran = { code: 0, out: 'ok', err: '' };
  const GITEA = 'Basic realm="Gitea"';
  /**
   * Git Credential Manager 2.9 on Windows, its OAuth access token (FILL) past its hour: it hands that back however old,
   * and once told to forget it (erasing the access token alone), makes a new one (FILL2) from its refresh token, unless
   * `refreshes` is false: only when asked with the host's `wwwauth[]=Basic realm="Gitea"`, its one way of knowing the
   * host, as live on 2026-10-31 (without it: "Cannot prompt because user interactivity has been disabled"). It keeps the
   * new one only when told to (`credential approve`). cmdkey lists the names it keeps. The host takes `good` sign-ins,
   * and refuses (401, with `challenge`) the rest and anyone without one: the repository is private.
   */
  const gcm = (o: { refresh?: boolean; refreshes?: boolean; good?: string[]; challenge?: string | null } = {}) => {
    const store = new Map<string, string>([[ACCESS, FILL]]);
    if (o.refresh !== false) store.set(REFRESH, 'a refresh token');
    const cmdkeys: string[][] = [];
    const f = fake({
      fill: (input) => {
        if (store.has(ACCESS)) return { code: 0, out: store.get(ACCESS)!, err: '' };
        if (store.has(REFRESH) && o.refreshes !== false && input.includes(`wwwauth[]=${GITEA}\n`)) return { code: 0, out: FILL2, err: '' };
        return { code: 128, out: '', err: 'fatal: Cannot prompt because user interactivity has been disabled.' };
      },
      answer: (_a, opts) => ((o.good ?? [HEADER2]).includes(settings(opts.env)['http.https://forge.example.test/.extraHeader']) ? ok : REFUSED),
    });
    const inner: Runner = async (cmd, args, opts) => {
      if (cmd === 'cmdkey') {
        cmdkeys.push(args);
        const asked = args[0].replace(/^\/list:/, '');
        const name = [...store.keys()].find((k) => k.toLowerCase() === asked.toLowerCase());
        return { code: 0, out: `\r\nCurrently stored credentials for ${asked}:\r\n\r\n${name ? `    Target: ${name}\r\n    Type: Generic \r\n    User: someone\r\n` : '* NONE *\r\n'}`, err: '' };
      }
      if (args[0] === 'credential' && args[1] === 'reject') store.delete(ACCESS);
      if (args[0] === 'credential' && args[1] === 'approve') store.set(ACCESS, opts?.input ?? '');
      return f.inner(cmd, args, opts);
    };
    return { f, inner, store, cmdkeys, h: host(() => 401, o.challenge === undefined ? GITEA : o.challenge) };
  };
  const headers = (f: ReturnType<typeof fake>) => f.gits().map((c) => settings(c.opts.env)['http.https://forge.example.test/.extraHeader']);

  {
    // The refresh token is there: the access token forgotten, a new one made, the command run once more with it.
    const { f, inner, store, cmdkeys, h } = gcm();
    const r = await signedIn(inner, Date.now, { fetch: h.fetch, windows: true })('git', ['fetch', 'origin'], { cwd: repo });
    assert.deepEqual(r, ok);
    assert.deepEqual(h.asked, [{ url: PROBE, auth }, { url: PROBE, auth: null }], 'refused with it and without: nothing shows why');
    assert.deepEqual(cmdkeys, [[`/list:${REFRESH}`]], 'its refresh token asked of cmdkey by name alone');
    assert.equal(f.rejects().length, 1);
    assert.equal(f.rejects()[0].opts.input, `${FILL.trimEnd()}\n\n`, "the access token's own answer, nothing of the refresh token's");
    assert.equal(f.rejects()[0].opts.env?.GCM_INTERACTIVE, 'never');
    const plain = 'protocol=https\nhost=forge.example.test\n\n';
    assert.deepEqual(f.fillInputs(), [plain, plain, `protocol=https\nhost=forge.example.test\nwwwauth[]=${GITEA}\n\n`], "asked for a new one with the host's WWW-Authenticate, as git asks after a 401");
    assert.deepEqual(headers(f), [HEADER, HEADER2]);
    assert.deepEqual(f.approves().map((c) => [c.opts.input, c.opts.env?.GCM_INTERACTIVE]), [[`${FILL2.trimEnd()}\n\n`, 'never']], 'the new one kept once the host took it');
    assert.ok(f.calls.indexOf(f.rejects()[0]) < f.calls.indexOf(f.approves()[0]));
    assert.ok(store.has(REFRESH), 'the refresh token kept');
    // The next process asks Credential Manager as before, and is handed the new one.
    const next = gcm();
    next.store.set(ACCESS, store.get(ACCESS)!);
    assert.deepEqual(await signedIn(next.inner, Date.now, { fetch: next.h.fetch, windows: true })('git', ['fetch', 'origin'], { cwd: repo }), ok);
    assert.deepEqual([headers(next.f), next.f.rejects().length, next.f.approves().length, next.h.asked.length], [[HEADER2], 0, 0, 0]);
  }
  {
    // A 401 that names no way to sign in (or GCM's own asking stays silent): no new one made, the refusal stands, nothing kept.
    const { f, inner, store, h } = gcm({ challenge: null });
    assert.deepEqual(await signedIn(inner, Date.now, { fetch: h.fetch, windows: true })('git', ['fetch', 'origin'], { cwd: repo }), REFUSED);
    assert.equal(f.fillInputs().at(-1), 'protocol=https\nhost=forge.example.test\n\n', 'asked as before, with nothing to hand on');
    assert.deepEqual([f.rejects().length, f.approves().length, f.gits().length], [1, 0, 1]);
    assert.ok(store.has(REFRESH) && !store.has(ACCESS));
  }
  {
    // No refresh token: a 401 on a private repository may be the repository's own. Nothing forgotten, run once.
    const { f, inner, cmdkeys, h } = gcm({ refresh: false });
    assert.deepEqual(await signedIn(inner, Date.now, { fetch: h.fetch, windows: true })('git', ['fetch', 'origin'], { cwd: repo }), REFUSED);
    assert.equal(cmdkeys.length, 1);
    assert.equal(f.rejects().length, 0);
    assert.equal(f.gits().length, 1);
  }
  {
    // Not Windows, or under node --test unless a test says so: Credential Manager isn't asked, nothing forgotten.
    for (const windows of [false, undefined]) {
      const { f, inner, cmdkeys, h } = gcm();
      assert.deepEqual(await signedIn(inner, Date.now, { fetch: h.fetch, windows })('git', ['fetch', 'origin'], { cwd: repo }), REFUSED);
      assert.deepEqual([cmdkeys.length, f.rejects().length, f.gits().length], [0, 0, 1], String(windows));
    }
  }
  {
    // The host says something other than 401 (a 404: the sign-in taken, the repository not there or not shared): the
    // sign-in isn't refused, so nothing is forgotten and cmdkey isn't asked.
    const { f, inner, cmdkeys } = gcm();
    const h = host(() => 404);
    await signedIn(inner, Date.now, { fetch: h.fetch, windows: true })('git', ['fetch', 'origin'], { cwd: repo });
    assert.deepEqual([cmdkeys.length, f.rejects().length], [0, 0]);
  }
  {
    // The new access token refused too (the repository taken away, say): forgotten once, not again a while.
    let t = 1_000_000;
    const { f, inner, store, cmdkeys, h } = gcm({ good: [] });
    const run = signedIn(inner, () => t, { fetch: h.fetch, windows: true });
    assert.deepEqual(await run('git', ['fetch', 'origin'], { cwd: repo }), REFUSED);
    assert.deepEqual(headers(f), [HEADER, HEADER2], 'run once more with the new one');
    assert.equal(f.approves().length, 0, 'refused: not kept');
    assert.deepEqual(await run('git', ['fetch', 'origin'], { cwd: repo }), REFUSED);
    assert.deepEqual([f.rejects().length, cmdkeys.length], [1, 1], 'refused again: nothing more forgotten, cmdkey not asked again');
    assert.equal(f.gits().length, 3);
    assert.ok(store.has(REFRESH), 'the refresh token kept');
    t += 31 * 60_000;
    await run('git', ['fetch', 'origin'], { cwd: repo });
    assert.deepEqual([headers(f).at(-1), f.rejects().length], [undefined, 1], 'half an hour on, the refused one never kept: Credential Manager hands over none, so git signs in its own way');
    store.set(ACCESS, FILL);
    t += 11 * 60_000;
    await run('git', ['fetch', 'origin'], { cwd: repo });
    assert.equal(f.rejects().length, 2, 'handed one again, past the time a missing one is remembered: forgotten once more');
    assert.ok(store.has(REFRESH));
  }
  {
    // The refresh token no longer makes one (revoked): the refusal stands, not run again, the refresh token left as it is.
    const { f, inner, store, h } = gcm({ refreshes: false });
    assert.deepEqual(await signedIn(inner, Date.now, { fetch: h.fetch, windows: true })('git', ['fetch', 'origin'], { cwd: repo }), REFUSED);
    assert.deepEqual([f.rejects().length, f.gits().length], [1, 1]);
    assert.ok(store.has(REFRESH));
  }
});

test("on gitlab.com a stale access token is never forgotten: GCM keeps its refresh token by a name of its own and renews it itself, and its erase would take that too", async () => {
  const repo = repoWith('gitlab', 'https://gitlab.com/me/private.git');
  // Git Credential Manager's names for a GitLab sign-in: its access token, and its refresh token as GCM itself names it.
  const store = new Set(['git:https://gitlab.com', 'git:https://oauth-refresh-token.gitlab.com']);
  const cmdkeys: string[][] = [];
  const f = fake({ answer: () => REFUSED });
  const inner: Runner = async (cmd, args, opts) => {
    if (cmd === 'cmdkey') {
      cmdkeys.push(args);
      const asked = args[0].replace(/^\/list:/, '');
      const name = [...store].find((k) => k.toLowerCase() === asked.toLowerCase());
      return { code: 0, out: `\r\nCurrently stored credentials for ${asked}:\r\n\r\n${name ? `    Target: ${name}\r\n    Type: Generic \r\n    User: someone\r\n` : '* NONE *\r\n'}`, err: '' };
    }
    if (args[0] === 'credential' && args[1] === 'reject') store.clear();
    return f.inner(cmd, args, opts);
  };
  // A private repository: refused with the stale token and with none, which shows nothing about why.
  const h = host(() => 401, 'Bearer realm="GitLab"');
  assert.deepEqual(await signedIn(inner, Date.now, { fetch: h.fetch, windows: true })('git', ['fetch', 'origin'], { cwd: repo }), REFUSED);
  assert.deepEqual(cmdkeys, [['/list:git:https://refresh_token.gitlab.com']], 'asked only by the refresh_token name, which GitLab has none of');
  assert.deepEqual([f.rejects().length, f.approves().length, f.gits().length], [0, 0, 1], 'nothing forgotten, nothing kept, run once');
  assert.deepEqual([...store], ['git:https://gitlab.com', 'git:https://oauth-refresh-token.gitlab.com'], 'the whole GitLab sign-in kept');
});

test('a URL with its own user is asked for that user; one with its own password keeps the helpers out; two users of one host go git’s own way', async () => {
  const f = fake();
  const run = signedIn(f.inner);
  await run('git', ['ls-remote', 'https://me@github.com/a/b.git']);
  assert.deepEqual(f.fillInputs(), ['protocol=https\nhost=github.com\nusername=me\n\n']);
  assert.equal(settings(f.gits()[0].opts.env)['http.https://github.com/.extraHeader'], HEADER);
  assert.equal(settings(f.gits()[0].opts.env)['credential.https://github.com.helper'], '');

  const own = fake();
  await signedIn(own.inner)('git', ['push', 'https://me:t0ken@gitlab.example.test/g/p.git', 'HEAD:refs/heads/x']);
  assert.equal(own.fills(), 0, 'its own password: no helper asked');
  assert.deepEqual(settings(own.gits()[0].opts.env), { 'credential.https://gitlab.example.test/g/p.git.helper': '' }, 'and none told to forget the one it keeps when the host refuses it');
  assert.ok(!JSON.stringify(own.gits()[0].opts.env).includes('t0ken'));

  const two = fake({ fill: (input) => ({ code: 0, out: /username=b/.test(input) ? FILL2 : FILL, err: '' }) });
  await signedIn(two.inner)('git', ['fetch', 'https://a@github.com/x/y.git', 'https://b@github.com/x/z.git']);
  assert.equal(two.gits()[0].opts.env?.GIT_CONFIG_COUNT, undefined, "two sign-ins for one host can't both be handed over");
});

test("where git asks helpers by path (Azure DevOps' dev.azure.com), the repository's own sign-in, for that repository", async () => {
  const A = 'https://dev.azure.com/org/Proj/_git/Repo';
  const B = 'https://dev.azure.com/org/Proj/_git/Other';
  const f = fake({ fill: (input) => ({ code: /path=/.test(input) ? 0 : 128, out: /path=/.test(input) ? FILL : '', err: '' }), config: { code: 0, out: 'true\n', err: '' } });
  const run = signedIn(f.inner);
  await run('git', ['ls-remote', A]);
  await run('git', ['ls-remote', B]);
  await run('git', ['ls-remote', A]);
  assert.deepEqual(f.fillInputs(), [
    'protocol=https\nhost=dev.azure.com\n\n',
    'protocol=https\nhost=dev.azure.com\npath=org/Proj/_git/Repo\n\n',
    'protocol=https\nhost=dev.azure.com\npath=org/Proj/_git/Other\n\n',
  ], "the host's own asked once; then each repository's, each kept");
  assert.deepEqual(f.configs().map((c) => c.args), [['config', '--type=bool', '--get-urlmatch', 'credential.useHttpPath', A]], 'git asked once whether it asks by path');
  assert.deepEqual(settings(f.gits()[0].opts.env), { 'credential.https://dev.azure.com/org/Proj/_git/Repo.helper': '', 'http.https://dev.azure.com/org/Proj/_git/Repo.extraHeader': HEADER });
  assert.deepEqual(Object.keys(settings(f.gits()[1].opts.env)), ['credential.https://dev.azure.com/org/Proj/_git/Other.helper', 'http.https://dev.azure.com/org/Proj/_git/Other.extraHeader']);
});

test("a clone's every remote is signed in, push URLs too; one that isn't https is left to git with its host's helpers on", async () => {
  const repo = repoWith('mixed', 'https://github.com/a/b.git');
  g(repo, 'remote', 'set-url', '--push', 'origin', 'https://gitlab.example.test/a/b.git');
  g(repo, 'remote', 'add', 'ssh', 'git@github.com:a/c.git');
  const f = fake({ fill: (input) => ({ code: 0, out: input.includes('gitlab') ? FILL2 : FILL, err: '' }) });
  await signedIn(f.inner)('git', ['push', 'origin', 'HEAD:refs/heads/x'], { cwd: repo });
  assert.deepEqual(settings(f.gits()[0].opts.env), {
    'credential.https://github.com.helper': '',
    'http.https://github.com/.extraHeader': HEADER,
    'credential.https://gitlab.example.test.helper': '',
    'http.https://gitlab.example.test/.extraHeader': HEADER2,
  });
});

test("a commit in the clone, loose or packed, from its files; a PR's head fetched only when it isn't", async () => {
  const repo = repoWith('objects', 'https://github.com/a/b.git');
  const c = (...args: string[]) => g(repo, '-c', 'user.email=t@example.test', '-c', 'user.name=T', ...args);
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  c('add', '.');
  c('commit', '-qm', 'one');
  const one = g(repo, 'rev-parse', 'HEAD');
  const missing = 'f'.repeat(40);
  assert.ok(hasObject(repo, one), 'loose');
  c('gc', '-q');
  assert.ok(hasObject(repo, one), 'packed');
  for (let i = 0; i < 20; i++) {
    writeFileSync(path.join(repo, 'a.txt'), String(i));
    c('commit', '-qam', String(i));
  }
  c('gc', '-q');
  const all = g(repo, 'rev-list', '--all').split('\n');
  assert.ok(all.every((sha) => hasObject(repo, sha)), 'every commit found in the pack, wherever the search lands');
  assert.ok(!hasObject(repo, missing));
  assert.ok(!hasObject(repo, '0'.repeat(40)));
  assert.ok(!hasObject(repo, 'not a sha'));
  const wt = path.join(home, 'objects-wt');
  g(repo, 'worktree', 'add', '-q', '--detach', wt);
  assert.ok(hasObject(wt, one), "a worktree's are its main clone's");

  const fetched: string[][] = [];
  const run: Runner = async (_cmd, args) => (fetched.push(args), { code: 0, out: '', err: '' });
  await fetchFor(run, repo, one, 'refs/pull/1/head');
  assert.equal(fetched.length, 0, 'here already: no fetch');
  await fetchFor(run, repo, missing, 'refs/pull/2/head');
  await fetchFor(run, repo, null, 'refs/pull/3/head');
  assert.deepEqual(fetched, [
    ['fetch', '--quiet', 'origin', 'refs/pull/2/head'],
    ['fetch', '--quiet', 'origin', 'refs/pull/3/head'],
  ]);
});
