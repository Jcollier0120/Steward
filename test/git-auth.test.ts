import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { headerOf, httpsOrigin, originsOf, refused, remoteOrigins, signedIn, signInEnv, subcommand } from '../src/git-auth.ts';
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

/** A runner that answers `git credential fill` with `fill` and everything else with `answer`, noting each call. */
function fake(o: { fill?: Ran; answer?: (args: string[], opts: RunOptions, n: number) => Ran } = {}) {
  const calls: { args: string[]; opts: RunOptions }[] = [];
  let n = 0;
  const inner: Runner = async (_cmd, args, opts = {}) => {
    calls.push({ args, opts });
    if (args[0] === 'credential') return o.fill ?? { code: 0, out: FILL, err: '' };
    return o.answer?.(args, opts, n++) ?? { code: 0, out: '', err: '' };
  };
  return { inner, calls, fills: () => calls.filter((c) => c.args[0] === 'credential').length, gits: () => calls.filter((c) => c.args[0] !== 'credential') };
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

test("the helper's answer as a header; the environment switches the helpers off first and keeps entries already there", () => {
  assert.equal(headerOf(FILL), HEADER);
  assert.equal(headerOf('protocol=https\r\nhost=x\r\nusername=u\r\npassword=p\r\n'), `Authorization: Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(headerOf('protocol=https\nhost=x\n'), null);
  const env = signInEnv(new Map([['https://github.com', HEADER]]), { GIT_CONFIG_COUNT: '1' });
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(env.GIT_CONFIG_KEY_2, 'http.https://github.com/.extraHeader');
  assert.equal(env.GIT_CONFIG_VALUE_2, HEADER);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
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
  for (const c of f.gits()) {
    assert.equal(c.opts.env?.[`GIT_CONFIG_VALUE_${n + 1}`], HEADER);
    assert.equal(c.opts.env?.[`GIT_CONFIG_KEY_${n}`], 'credential.helper');
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
  for (const c of f.gits()) assert.equal(c.opts.env?.GIT_CONFIG_COUNT, undefined, "git's own way");
  assert.deepEqual(f.gits().at(-1)!.opts, opts);
  t += 11 * 60_000;
  await run('git', ['fetch', 'origin'], opts);
  assert.equal(f.fills(), 2, 'asked again later');
});

test('a sign-in the host refuses: the command runs once more as before, and the sign-in is asked again later', async () => {
  const repo = repoWith('stale', 'https://github.com/a/b.git');
  let t = 0;
  const f = fake({ answer: (_a, opts) => (opts.env?.GIT_CONFIG_COUNT ? { code: 128, out: '', err: "remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/a/b.git/'" } : { code: 0, out: 'ok', err: '' }) });
  const run = signedIn(f.inner, () => t);
  const r = await run('git', ['fetch', 'origin'], { cwd: repo });
  assert.deepEqual(r, { code: 0, out: 'ok', err: '' });
  assert.equal(f.gits().length, 2);
  assert.equal(f.gits()[1].opts.env?.GIT_CONFIG_COUNT, undefined, "the second time git's own way");
  await run('git', ['fetch', 'origin'], { cwd: repo });
  assert.equal(f.gits()[2].opts.env?.GIT_CONFIG_COUNT, undefined, 'not handed over again at once');
  assert.equal(f.fills(), 1);
  t += 11 * 60_000;
  await run('git', ['fetch', 'origin'], { cwd: repo });
  assert.equal(f.fills(), 2);
  // A failure that isn't a refusal is the command's own: not run twice.
  const other = fake({ answer: () => ({ code: 128, out: '', err: "fatal: couldn't find remote ref refs/pull/9/head" }) });
  assert.equal((await signedIn(other.inner)('git', ['fetch', 'origin', 'refs/pull/9/head'], { cwd: repo })).code, 128);
  assert.equal(other.gits().length, 1);
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
