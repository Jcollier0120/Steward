import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { advertisedRefs, lsRemoteText } from './smart-http.ts';

/**
 * git's sign-in given to git up front, for a fetch, push or ls-remote over https (the Steward's since 0.35.31, the kit's
 * since 2.58.0).
 *
 * Over HTTPS, each fetch or push of a private repository has git ask the credential helper for the sign-in and then
 * store it back: for Git Credential Manager, a shell, a git and the manager itself, twice, so 6 of the 9 processes one
 * fetch starts. An agent that fetches dozens of repositories starts hundreds of them, and on some PCs every process that
 * ends leaves kernel memory behind. Instead, the helper is asked once per host (`git credential fill`, kept 30 minutes in
 * memory, never written anywhere) and the sign-in is handed to git as an Authorization header through git's environment
 * config (GIT_CONFIG_COUNT…), never its command line, where any process could read it.
 *
 * - `signedIn(run)`: a runner whose git commands that talk to a remote carry it. While they do, git's credential helpers
 *   are switched off for that command: otherwise a sign-in that has gone stale would have git fall back to the helper,
 *   fail with both, and have the helper erase the good one it keeps. A command the host refuses is run once more as
 *   before (the helper's own way), and the host's sign-in is asked again only after MISS_MS. A host whose sign-in can't
 *   be read (none kept, a public repository, SSH) is left to git as before.
 * - `scriptEnv(origins, run)`: the same, as an environment for a script (a PowerShell job) whose git commands talk to
 *   these hosts. The helpers are switched off for those hosts only (`credential.<origin>.helper`, empty), so any other
 *   host a script talks to signs in as before.
 */

/** What a command did: its exit code, and what it printed. An agent's own runner's result fits it. */
export interface GitRan {
  code: number | null;
  out: string;
  err: string;
}

export interface GitRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Written to its standard input, which is then closed (git credential fill reads its question there). */
  input?: string;
}

/** Runs a program and waits for it: an agent's own runner, which must take `input` and `env`. */
export type GitRunner<O extends GitRunOptions = GitRunOptions, R extends GitRan = GitRan> = (cmd: string, args: string[], opts?: O) => Promise<R>;

/** The git commands that talk to a remote. */
const TALKS = new Set(['fetch', 'pull', 'push', 'ls-remote', 'clone']);
/** Git and its helpers never ask a person for anything here. */
const QUIET = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
const KEEP_MS = 30 * 60_000;
const MISS_MS = 10 * 60_000;

/** The git command in a git command line, past its global options (-C <dir>, -c <name=value>, --no-pager…). */
export function subcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--config-env') i++;
    else if (!a.startsWith('-')) return a;
  }
  return null;
}

/** An https URL's origin (`https://host[:port]`), or null for anything else, or a URL that names its own user. */
export function httpsOrigin(url: string): string | null {
  const m = /^https:\/\/([^/?#\s]+)/i.exec(url.trim());
  if (!m || m[1].includes('@')) return null;
  return `https://${m[1].toLowerCase()}`;
}

/** The folder a clone keeps its refs and config in: .git, or for a worktree the main clone's (its gitdir's commondir). */
export function gitCommonDir(repo: string): string | null {
  const dotGit = path.join(repo, '.git');
  if (!existsSync(dotGit)) return null;
  if (lstatSync(dotGit).isDirectory()) return dotGit;
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
  if (!gitdir) return null;
  const own = path.resolve(repo, gitdir);
  const common = path.join(own, 'commondir');
  return existsSync(common) ? path.resolve(own, readFileSync(common, 'utf8').trim()) : own;
}

/** A clone's remotes' URLs, from its config file (no git started); none when it can't be read. */
export function remoteUrls(repo: string): string[] {
  try {
    const common = gitCommonDir(repo);
    const config = common && path.join(common, 'config');
    if (!config || !existsSync(config)) return [];
    const out: string[] = [];
    let inRemote = false;
    for (const line of readFileSync(config, 'utf8').split('\n')) {
      const section = /^\s*\[\s*([^\]\s"]+)/.exec(line);
      if (section) inRemote = section[1].toLowerCase() === 'remote';
      const url = inRemote ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line)?.[1] : undefined;
      if (url) out.push(url.replace(/^"(.*)"$/, '$1'));
    }
    return out;
  } catch {
    return [];
  }
}

/** One remote's URL (its first), from its clone's config file (no git started); null when it has none or can't be read. */
export function remoteUrl(repo: string, name = 'origin'): string | null {
  try {
    const common = gitCommonDir(repo);
    const config = common && path.join(common, 'config');
    if (!config || !existsSync(config)) return null;
    let mine = false;
    for (const line of readFileSync(config, 'utf8').split('\n')) {
      const section = /^\s*\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
      if (section) mine = section[1].toLowerCase() === 'remote' && section[2]?.replace(/\\(.)/g, '$1') === name;
      const url = mine ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line)?.[1] : undefined;
      if (url) return url.replace(/^"(.*)"$/, '$1');
    }
    return null;
  } catch {
    return null;
  }
}

/** The https origins of a clone's remotes; 'named' for an https URL with its own user, 'other' for anything else. */
export function remoteOrigins(repo: string): string[] {
  return remoteUrls(repo).map((u) => (/^https:/i.test(u) ? (httpsOrigin(u) ?? 'named') : 'other'));
}

/**
 * The https origins a git command line talks to: the URLs it names, else its clone's remotes. Null when one of them
 * isn't plain https (SSH, a path, a URL with its own user): then git signs in its own way, as before.
 */
export function originsOf(args: string[], cwd: string | undefined): string[] | null {
  const urls = args.filter((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^[^/\\]+@[^:]+:/.test(a));
  const all = urls.length ? urls.map((u) => httpsOrigin(u) ?? 'other') : cwd ? remoteOrigins(cwd) : [];
  if (!all.length || all.some((o) => !o.startsWith('https://'))) return null;
  return [...new Set(all)];
}

/** `git credential fill`'s answer as an Authorization header's value, or null without a user name and password. Pure. */
export function headerOf(out: string): string | null {
  const field = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out.replace(/\r/g, ''))?.[1] ?? '';
  const username = field('username');
  const password = field('password');
  if (!username || !password) return null;
  return `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** Git config entries as environment, appended to any GIT_CONFIG_COUNT entries already set. Pure. */
function configEnv(entries: [string, string][], already: Record<string, string | undefined>): Record<string, string> {
  let n = Number(already.GIT_CONFIG_COUNT) || 0;
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

/**
 * The environment that hands one git command these headers: the credential helpers switched off first (an empty
 * credential.helper empties the list), and nothing asked of a person. Pure.
 */
export function signInEnv(headers: Map<string, string>, already: Record<string, string | undefined>): Record<string, string> {
  const entries: [string, string][] = [['credential.helper', '']];
  for (const [origin, header] of headers) entries.push([`http.${origin}/.extraHeader`, header]);
  return { ...QUIET, ...configEnv(entries, already) };
}

/**
 * The environment that hands a script's git commands these headers: each host's own credential helpers switched off
 * (`credential.<origin>.helper`, empty), every other host's left as they are. Pure.
 */
export function scriptSignInEnv(headers: Map<string, string>, already: Record<string, string | undefined>): Record<string, string> {
  if (!headers.size) return {};
  const entries: [string, string][] = [];
  for (const [origin, header] of headers) entries.push([`credential.${origin}.helper`, ''], [`http.${origin}/.extraHeader`, header]);
  return configEnv(entries, already);
}

/** The https URL an `ls-remote` command line asks: the one it names, or its clone's remote by name; null for any other. */
function lsRemoteUrl(args: string[], cwd: string | undefined): string | null {
  const repo = args.slice(1).find((a) => !a.startsWith('-'));
  if (!repo) return null;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) ? repo : cwd && /^[\w.-]+$/.test(repo) ? remoteUrl(cwd, repo) : null;
  return url && httpsOrigin(url) ? url : null;
}

/** The git folder whose config a command in `cwd` reads: a clone's (common) one, or a bare repository's own. */
function gitDirAt(cwd: string | undefined): string | null {
  if (!cwd) return null;
  return gitCommonDir(cwd) ?? (existsSync(path.join(cwd, 'HEAD')) && existsSync(path.join(cwd, 'config')) ? cwd : null);
}

/** What a host says when it refuses a sign-in (GitHub says a private repository it won't show you isn't there). */
export const refused = (r: GitRan) => /authentication failed|invalid (username|credentials)|could not read (username|password)|terminal prompts disabled|repository not found|returned error: 40[134]/i.test(`${r.err}\n${r.out}`);

/** Asks git's credential helper for a host's sign-in, without asking a person: the header, or null. */
function askHeader(run: GitRunner, origin: string, cwd: string | undefined): Promise<string | null> {
  return run('git', ['credential', 'fill'], { cwd, input: `protocol=https\nhost=${origin.slice('https://'.length)}\n\n`, env: QUIET, timeoutMs: 30_000 })
    .then((r) => (r.code === 0 ? headerOf(r.out) : null))
    .catch(() => null);
}

/** A sign-in as asked of the helper, kept KEEP_MS (MISS_MS when there was none, or the host refused it). */
interface Kept {
  header: Promise<string | null>;
  until: number;
}

/**
 * A runner whose git fetches, pushes and ls-remotes over https carry the host's sign-in themselves (see the top of this
 * file). Every other command, and git's own way when the sign-in can't be had, goes to `inner` as given.
 */
export function signedIn<O extends GitRunOptions, R extends GitRan>(inner: GitRunner<O, R>, now: () => number = Date.now, o: { fetch?: typeof fetch } = {}): GitRunner<O, R> {
  const byOrigin = new Map<string, Kept>();
  const headerFor = (origin: string, cwd: string | undefined): Promise<string | null> => {
    const k = byOrigin.get(origin);
    if (k && k.until > now()) return k.header;
    const header = askHeader(inner as unknown as GitRunner, origin, cwd);
    const entry: Kept = { header, until: now() + KEEP_MS };
    byOrigin.set(origin, entry);
    void header.then((h) => {
      if (!h && byOrigin.get(origin) === entry) entry.until = now() + MISS_MS;
    });
    return header;
  };
  return async (cmd, args, opts = {} as O) => {
    if (cmd !== 'git' || !TALKS.has(subcommand(args) ?? '')) return inner(cmd, args, opts);
    const origins = originsOf(args, opts.cwd);
    if (!origins) return inner(cmd, args, opts);
    const headers = new Map<string, string>();
    for (const origin of origins) {
      const h = await headerFor(origin, opts.cwd);
      if (!h) return inner(cmd, args, opts);
      headers.set(origin, h);
    }
    // An ls-remote over https is asked in this process with the same sign-in (smart-http.ts, kit 2.64.0): no git. What
    // that can't answer as git would, it leaves to git.
    // Under node --test, only with a test's own fetch: a test's made-up remote is never asked over the network.
    const ask = o.fetch ?? (process.env.NODE_TEST_CONTEXT ? null : fetch);
    if (ask && args[0] === 'ls-remote' && origins.length === 1) {
      const url = lsRemoteUrl(args, opts.cwd);
      const refs = url ? await advertisedRefs(url, { authorization: headers.get(origins[0])!.replace(/^authorization:\s*/i, ''), gitDir: gitDirAt(opts.cwd), env: { ...process.env, ...opts.env }, fetch: ask }) : null;
      const out = refs ? lsRemoteText(args, refs) : null;
      if (out !== null) return { code: 0, out, err: '' } as unknown as R;
    }
    const r = await inner(cmd, args, { ...opts, env: { ...opts.env, ...signInEnv(headers, { ...process.env, ...opts.env }) } } as O);
    if (r.code === 0 || !refused(r)) return r;
    // Refused: the sign-in went stale. Asked again later; this time git signs in its own way.
    for (const origin of origins) byOrigin.set(origin, { header: Promise.resolve(null), until: now() + MISS_MS });
    return inner(cmd, args, opts);
  };
}

/**
 * The environment for a script whose git commands talk to these https origins (a PowerShell job fetching its
 * repositories): each origin's sign-in asked of git's credential helper once (`git credential fill`, one helper chain
 * per host instead of one per git command), handed to git as a header for that host only. An origin whose sign-in
 * can't be read is left out: git signs in there its own way, as before. Empty when none could be read.
 *
 * A sign-in that goes stale while the script runs isn't retried the helper's way, as `signedIn`'s commands are: the
 * script's command fails as it would have, and the next run asks again. Keep a script's run short of KEEP_MS.
 */
export async function scriptEnv(origins: Iterable<string>, run: GitRunner, o: { cwd?: string; already?: Record<string, string | undefined> } = {}): Promise<Record<string, string>> {
  const headers = new Map<string, string>();
  for (const origin of new Set([...origins].map((x) => httpsOrigin(x)).filter((x): x is string => !!x))) {
    const h = await askHeader(run, origin, o.cwd);
    if (h) headers.set(origin, h);
  }
  return scriptSignInEnv(headers, o.already ?? process.env);
}
