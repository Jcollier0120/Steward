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

/** A runner that answers `git credential fill` for the hosts in `known`, noting each question. */
function helper(known: string[]) {
  const asked: string[] = [];
  const run = async (_cmd: string, args: string[], opts: { input?: string } = {}) => {
    const host = /host=(.+)/.exec(opts.input ?? '')?.[1] ?? '';
    asked.push(`${args.join(' ')} ${host}`);
    return known.includes(host) ? { code: 0, out: `protocol=https\nhost=${host}\nusername=someone\npassword=s3cret\n`, err: '' } : { code: 1, out: '', err: 'fatal: could not read Username' };
  };
  return { run, asked };
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
