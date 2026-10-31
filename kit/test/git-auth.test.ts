import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// git's sign-in for a script's git commands (kit 2.58.0): asked once per host, handed over as a header for that host only.
const { scriptEnv, scriptSignInEnv, signedIn } = await import('./fixture/src/kit/git-auth.ts');

const home = mkdtempSync(path.join(os.tmpdir(), 'kit-git-auth-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const HEADER = `Authorization: Basic ${Buffer.from('someone:s3cret').toString('base64')}`;

/**
 * A runner that answers `git credential fill` for the hosts in `known` (`host` or `host/path`), noting each question,
 * and `git config --get-urlmatch credential.useHttpPath` true for the hosts in `byPath`, noting those apart.
 */
function helper(known: string[], byPath: string[] = []) {
  const asked: string[] = [];
  const config: string[] = [];
  const run = async (_cmd: string, args: string[], opts: { input?: string } = {}) => {
    if (args[0] === 'config') {
      const host = /^https:\/\/([^/]+)/.exec(args.at(-1)!)?.[1] ?? '';
      config.push(args.at(-1)!);
      return byPath.includes(host) ? { code: 0, out: 'true\n', err: '' } : { code: 1, out: '', err: '' };
    }
    const host = /host=(.+)/.exec(opts.input ?? '')?.[1] ?? '';
    const at = [host, /path=(.+)/.exec(opts.input ?? '')?.[1]].filter(Boolean).join('/');
    asked.push(`${args.join(' ')} ${at}`);
    return known.includes(at) ? { code: 0, out: `protocol=https\nhost=${host}\nusername=someone\npassword=s3cret\n`, err: '' } : { code: 1, out: '', err: 'fatal: could not read Username' };
  };
  return { run, asked, config };
}

test("a script's environment: each host's sign-in asked once, as a header for that host, its helpers off for it alone", async () => {
  const { run, asked } = helper(['github.com']);
  const env = await scriptEnv(['https://github.com/a/b.git', 'https://GitHub.com/c/d', 'https://gitlab.example/e/f', 'git@github.com:g/h.git'], run, { already: { GIT_CONFIG_COUNT: '1' } });
  assert.deepEqual(asked, ['credential fill github.com', 'credential fill gitlab.example'], 'once per https host; SSH is left to git');
  assert.deepEqual(
    env,
    {
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_2: HEADER,
      GIT_CONFIG_COUNT: '3',
    },
    'after the entries already set; gitlab.example, whose sign-in could not be read, signs in its own way',
  );
  assert.deepEqual(await scriptEnv(['https://gitlab.example/e/f'], run), {}, 'none read: nothing changes');
  assert.deepEqual(scriptSignInEnv(new Map(), {}), {});
});

test("a script's environment where git asks helpers by path (kit 2.146.6): each repository's own sign-in, for it alone", async () => {
  const A = 'https://dev.azure.com/org/Proj/_git/Repo';
  const B = 'https://dev.azure.com/org/Proj/_git/Other';
  const { run, asked, config } = helper(['dev.azure.com/org/Proj/_git/Repo', 'dev.azure.com/org/Proj/_git/Other'], ['dev.azure.com']);
  const env = await scriptEnv([A, B, 'https://me@dev.azure.com/org/Proj/_git/Repo', 'https://me:t0ken@dev.azure.com/org/Proj/_git/Own'], run, { already: {} });
  assert.deepEqual(asked, [
    'credential fill dev.azure.com',
    'credential fill dev.azure.com/org/Proj/_git/Repo',
    'credential fill dev.azure.com/org/Proj/_git/Other',
    'credential fill dev.azure.com/org/Proj/_git/Repo',
  ], "the host's own, once; then each repository's, and once more for the URL that names its own user; none for the URL with its own password");
  assert.deepEqual(config, [A], 'git asked once whether it asks helpers by path');
  assert.deepEqual(env, {
    GIT_CONFIG_KEY_0: `credential.${A}.helper`,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: `http.${A}.extraHeader`,
    GIT_CONFIG_VALUE_1: HEADER,
    GIT_CONFIG_KEY_2: `credential.${B}.helper`,
    GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: `http.${B}.extraHeader`,
    GIT_CONFIG_VALUE_3: HEADER,
    GIT_CONFIG_COUNT: '4',
  });
  // Where the host gives its own sign-in, git isn't asked how it asks: one fill per host, as before.
  const host = helper(['github.com'], ['github.com']);
  await scriptEnv(['https://github.com/a/b', 'https://github.com/c/d'], host.run, { already: {} });
  assert.deepEqual(host.config, []);
  assert.deepEqual(host.asked, ['credential fill github.com']);
});

test("git itself keeps the other hosts' helpers and asks none for the header's host (no network: git credential fill)", () => {
  // A helper set as a person's would be, in a config of the test's own; it answers for any host it's asked of.
  const global = path.join(home, 'gitconfig');
  writeFileSync(global, '[credential]\n\thelper = "!f() { echo username=from-helper; echo password=p; }; f"\n');
  const base: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const k of Object.keys(base)) if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)) delete base[k];
  const env = { ...base, ...scriptSignInEnv(new Map([['https://github.com', HEADER]]), base) };
  const fill = (host: string) => spawnSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, env, encoding: 'utf8', windowsHide: true, cwd: home });
  const github = fill('github.com');
  assert.notEqual(github.status, 0, 'no helper is asked for github.com: git sends the header and nothing else');
  assert.doesNotMatch(github.stdout, /from-helper/);
  const other = fill('gitlab.example');
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /username=from-helper/, "another host's helper is still asked");
  const header = spawnSync('git', ['config', '--get-urlmatch', 'http.extraHeader', 'https://github.com/a/b'], { env, encoding: 'utf8', windowsHide: true, cwd: home });
  assert.equal(header.stdout.trim(), HEADER, "the header for github.com's URLs");
  const none = spawnSync('git', ['config', '--get-urlmatch', 'http.extraHeader', 'https://gitlab.example/e/f'], { env, encoding: 'utf8', windowsHide: true, cwd: home });
  assert.equal(none.stdout.trim(), '', 'and for no other host');
  const user = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\nusername=me\n\n', env, encoding: 'utf8', windowsHide: true, cwd: home });
  assert.doesNotMatch(user.stdout, /from-helper/, "nor for a URL that names its own user: the host's setting matches any user");
});

test('git itself keeps a sign-in handed over for one repository to that repository, where it asks helpers by path (kit 2.146.6)', () => {
  const global = path.join(home, 'gitconfig-by-path');
  writeFileSync(global, '[credential]\n\thelper = "!f() { echo username=from-helper; echo password=p; }; f"\n[credential "https://dev.azure.com"]\n\tuseHttpPath = true\n');
  const base: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const k of Object.keys(base)) if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)) delete base[k];
  const A = 'https://dev.azure.com/org/My%20Proj/_git/Repo';
  const env = { ...base, ...scriptSignInEnv(new Map([[A, HEADER]]), base) };
  const fill = (p: string) => spawnSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=dev.azure.com\npath=${p}\n\n`, env, encoding: 'utf8', windowsHide: true, cwd: home });
  assert.doesNotMatch(fill('org/My Proj/_git/Repo').stdout, /from-helper/, 'no helper asked for that repository');
  for (const other of ['org/My Proj/_git/Other', 'org/My Proj/_git/Repo2']) {
    const r = fill(other);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /username=from-helper/, `${other}: its helper still asked`);
  }
  const header = (url: string) => spawnSync('git', ['config', '--get-urlmatch', 'http.extraHeader', url], { env, encoding: 'utf8', windowsHide: true, cwd: home }).stdout.trim();
  assert.equal(header(`${A}/info/refs`), HEADER, "the header for that repository's requests");
  assert.equal(header('https://dev.azure.com/org/My%20Proj/_git/Repo2/info/refs'), '', 'and for no other, however its name begins');
  assert.equal(header('https://dev.azure.com/org/My%20Proj/_git/Other'), '');
});

test("signedIn takes an agent's own runner and gives back one of the same kind", async () => {
  const { run } = helper(['github.com']);
  const seen: Record<string, string | undefined>[] = [];
  const inner = async (cmd: string, args: string[], opts: { input?: string; env?: Record<string, string | undefined>; cwd?: string } = {}) => {
    if (args[0] === 'credential') return { ...(await run(cmd, args, opts)), extra: false };
    seen.push(opts.env ?? {});
    return { code: 0, out: 'done', err: '', extra: true };
  };
  const r = await signedIn(inner)('git', ['ls-remote', 'https://github.com/a/b']);
  assert.equal(r.extra, true);
  assert.ok(Object.values(seen[0]).includes(HEADER));
});
