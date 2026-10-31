import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { advertisedRefs, lsRemoteText, readsWith } from './smart-http.ts';

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
 *   are switched off for the hosts it is handed to (`credential.<origin>.helper`, empty; every other host's are left as
 *   they are). When a host refuses a sign-in git has the helper erase it, and hosts refuse a good one too: Bitbucket and
 *   Azure DevOps for a repository that isn't there or isn't shared with you. So since kit 2.146.6 a refused command is
 *   never run again git's own way. The helper is asked once more, and the command runs once more only with a sign-in
 *   it renewed (Bitbucket's and Azure DevOps' helpers check theirs when asked). The helper is told to forget the one it
 *   keeps (`git credential reject`) only when it is shown to be stale: the host refuses it on a repository it read in
 *   this process, or on a public one it reads with no sign-in. A refusal of a sign-in the host takes is the
 *   repository's own, and is left as it is. A host whose sign-in can't be read (none kept, a public repository, SSH,
 *   http) is left to git as before.
 * - Git Credential Manager hands back an OAuth access token however old (Codeberg's last an hour), and makes a new one
 *   from its refresh token only once it keeps none. So since kit 2.147.2, a sign-in the host refuses (401) on a private
 *   repository, with nothing else to show why, is forgotten where Windows Credential Manager names its refresh token
 *   (`git:https://refresh_token.<host>`): once a while for each sign-in, the refresh token kept. The helper then makes a
 *   new access token, and the command runs once more with it. Elsewhere (no refresh token, GCM keeping its sign-ins
 *   in another store, not Windows) such a refusal is left as it is.
 * - A URL with its own user (https://me@host/…) is asked for that user's sign-in. One with its own password signs in
 *   with it, and no helper is asked or told to forget one for it. Where git asks helpers by path
 *   (credential.useHttpPath, which Git Credential Manager sets for dev.azure.com), the helper is asked with the
 *   repository's path and the sign-in handed over for that repository alone.
 * - `scriptEnv(urls, run)`: the same, as an environment for a script (a PowerShell job) whose git commands talk to
 *   these repositories or hosts. The helpers are switched off for those hosts only, so any other host a script talks
 *   to signs in as before.
 */

/** What a command did: its exit code, and what it printed. An agent's own runner's result fits it. */
export interface GitRan {
  code: number | null;
  out: string;
  err: string;
}

export interface GitRunOptions {
  cwd?: string;
  /**
   * Added to the command's own environment (this process's, or whatever the runner gives every command), never the
   * whole of it: the kit hands only its own few (`git credential fill`'s QUIET, a sign-in's GIT_CONFIG_* entries). A
   * runner that ran a command with `env` alone would run git with no PATH, home or git settings of the person's, and
   * with the sign-in's GIT_CONFIG_KEY_n numbered after entries it never got: "missing config key GIT_CONFIG_KEY_0",
   * "unable to parse command-line config".
   */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Written to its standard input, which is then closed (git credential fill reads its question there). */
  input?: string;
}

/** Runs a program and waits for it: an agent's own runner, which must take `input`, and `env` laid over its own. */
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

/** Where an https URL signs in (kit 2.146.6). */
export interface SignIn {
  /** `https://host[:port]`, the host in lower case. */
  origin: string;
  /** The user the URL names (https://me@host/…), or null. */
  user: string | null;
  /** Whether it gives its own password too (https://me:secret@host/…). */
  password: boolean;
  /** Its path as the URL writes it, with no slash at either end: git's settings for one repository are keyed by it. */
  rawPath: string;
  /** Its path as git hands it to a credential helper: percent-decoded. */
  path: string;
}

/** Where an https URL signs in: its origin, its own user and password if it names them, its path. Null for anything else. Pure. */
export function signInOf(url: string): SignIn | null {
  const m = /^https:\/\/(?:([^@/?#\s]*)@)?([^@/?#\s]+)(\/[^?#\s]*)?/i.exec(url.trim());
  if (!m) return null;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const userinfo = m[1];
  const colon = userinfo?.indexOf(':') ?? -1;
  const user = userinfo === undefined ? null : decode(colon < 0 ? userinfo : userinfo.slice(0, colon)) || null;
  const rawPath = (m[3] ?? '').replace(/^\/+|\/+$/g, '');
  return { origin: `https://${m[2].toLowerCase()}`, user, password: colon >= 0, rawPath, path: decode(rawPath) };
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

/** A clone's remotes' URLs, from its config file (no git started), with their push URLs when `o.push`; none when it can't be read. */
export function remoteUrls(repo: string, o: { push?: boolean } = {}): string[] {
  try {
    const common = gitCommonDir(repo);
    const config = common && path.join(common, 'config');
    if (!config || !existsSync(config)) return [];
    const out: string[] = [];
    let inRemote = false;
    const key = o.push ? /^\s*(?:push)?url\s*=\s*(.+?)\s*$/i : /^\s*url\s*=\s*(.+?)\s*$/i;
    for (const line of readFileSync(config, 'utf8').split('\n')) {
      const section = /^\s*\[\s*([^\]\s"]+)/.exec(line);
      if (section) inRemote = section[1].toLowerCase() === 'remote';
      const url = inRemote ? key.exec(line)?.[1] : undefined;
      if (url) out.push(url.replace(/^"(.*)"$/, '$1'));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One remote's URL (its first), from its clone's config file (no git started); null when it has none or can't be
 * read. `key` 'pushurl' reads its push URL instead.
 */
export function remoteUrl(repo: string, name = 'origin', key: 'url' | 'pushurl' = 'url'): string | null {
  try {
    const common = gitCommonDir(repo);
    const config = common && path.join(common, 'config');
    if (!config || !existsSync(config)) return null;
    const line$ = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'i');
    let mine = false;
    for (const line of readFileSync(config, 'utf8').split('\n')) {
      const section = /^\s*\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
      if (section) mine = section[1].toLowerCase() === 'remote' && section[2]?.replace(/\\(.)/g, '$1') === name;
      const url = mine ? line$.exec(line)?.[1] : undefined;
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
 * isn't plain https (SSH, a path, a URL with its own user).
 */
export function originsOf(args: string[], cwd: string | undefined): string[] | null {
  const urls = args.filter((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^[^/\\]+@[^:]+:/.test(a));
  const all = urls.length ? urls.map((u) => httpsOrigin(u) ?? 'other') : cwd ? remoteOrigins(cwd) : [];
  if (!all.length || all.some((o) => !o.startsWith('https://'))) return null;
  return [...new Set(all)];
}

/** The URLs a git command line talks to: the ones it names, else every remote of its clone, its push URLs too. */
function urlsOf(args: string[], cwd: string | undefined): string[] {
  const named = args.filter((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^[^/\\]+@[^:]+:/.test(a));
  return [...new Set(named.length ? named : cwd ? remoteUrls(cwd, { push: true }) : [])];
}

/**
 * The one repository a command line names, a URL or a remote of its clone by name (its push URL for a push), or null:
 * what its success shows a sign-in read. A command that names none (`git fetch`, its branch's own remote) shows nothing.
 */
function namedRepo(args: string[], cwd: string | undefined): string | null {
  const sub = subcommand(args);
  const rest = sub ? args.slice(args.indexOf(sub) + 1) : [];
  if (rest.some((a) => a === '--all' || a === '--multiple')) return null;
  for (const a of rest) {
    if (a.startsWith('-')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return a;
    if (!cwd || !/^[\w.-]+$/.test(a)) continue;
    const url = (sub === 'push' ? remoteUrl(cwd, a, 'pushurl') : null) ?? remoteUrl(cwd, a);
    if (url) return url;
  }
  return null;
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

/** The URL a sign-in's git settings are keyed by: its host's origin, or where git asks helpers by path, its repository's. */
const keyOf = (s: SignIn, byPath: boolean) => (byPath && s.rawPath ? `${s.origin}/${s.rawPath}` : s.origin);
const helperKey = (at: string) => `credential.${at}.helper`;
const headerKey = (at: string) => `http.${/^https:\/\/[^/]+$/.test(at) ? `${at}/` : at}.extraHeader`;

/**
 * The environment that hands one git command these headers (keyed by origin, or a repository's URL): the credential
 * helpers switched off for each of them, and for each URL in `off` (one that gives its own password), every other
 * host's left as they are; and nothing asked of a person. Pure.
 */
export function signInEnv(headers: Map<string, string>, already: Record<string, string | undefined>, off: Iterable<string> = []): Record<string, string> {
  const entries: [string, string][] = [];
  for (const at of off) entries.push([helperKey(at), '']);
  for (const [at, header] of headers) entries.push([helperKey(at), ''], [headerKey(at), header]);
  return { ...QUIET, ...configEnv(entries, already) };
}

/**
 * The environment that hands a script's git commands these headers: each host's own credential helpers switched off
 * (`credential.<origin>.helper`, empty), every other host's left as they are. Pure.
 */
export function scriptSignInEnv(headers: Map<string, string>, already: Record<string, string | undefined>): Record<string, string> {
  if (!headers.size) return {};
  const entries: [string, string][] = [];
  for (const [at, header] of headers) entries.push([helperKey(at), ''], [headerKey(at), header]);
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

/**
 * Whether cmdkey's list names this target, ignoring case as Windows does: a line that ends with it after a space or
 * `target=` (`Target: LegacyGeneric:target=git:https://…`, in any language). Pure.
 */
export function listsTarget(out: string, target: string): boolean {
  const want = target.toLowerCase();
  return out.split(/\r?\n/).some((line) => {
    const l = line.trim().toLowerCase();
    return l.endsWith(want) && /(?:\s|target=)$/.test(l.slice(0, l.length - want.length));
  });
}

/** What git's credential helper keeps for a sign-in: the header it makes, and its answer as given (to forget it by). */
interface Fill {
  header: string;
  answer: string;
}

/** Asks git's credential helper for a sign-in, without asking a person: its header and answer, or null. */
function askFill(run: GitRunner, s: SignIn, byPath: boolean, cwd: string | undefined): Promise<Fill | null> {
  const input = `protocol=https\nhost=${s.origin.slice('https://'.length)}\n${byPath && s.path ? `path=${s.path}\n` : ''}${s.user ? `username=${s.user}\n` : ''}\n`;
  return run('git', ['credential', 'fill'], { cwd, input, env: QUIET, timeoutMs: 30_000 })
    .then((r) => {
      const header = r.code === 0 ? headerOf(r.out) : null;
      return header ? { header, answer: r.out } : null;
    })
    .catch(() => null);
}

/** Tells git's credential helpers to forget a sign-in shown to be stale, as git does when a host refuses one. */
function forget(run: GitRunner, f: Fill, cwd: string | undefined): Promise<unknown> {
  return run('git', ['credential', 'reject'], { cwd, input: `${f.answer.replace(/\r/g, '').trimEnd()}\n\n`, env: QUIET, timeoutMs: 30_000 }).catch(() => null);
}

/** Whether git asks credential helpers by path for this URL (credential.useHttpPath, set for dev.azure.com by GCM). */
function asksByPath(run: GitRunner, url: string, cwd: string | undefined): Promise<boolean> {
  return run('git', ['config', '--type=bool', '--get-urlmatch', 'credential.useHttpPath', url], { cwd, env: QUIET, timeoutMs: 10_000 })
    .then((r) => r.code === 0 && r.out.trim() === 'true')
    .catch(() => false);
}

/** A sign-in as asked of the helper, kept KEEP_MS (MISS_MS when there was none). */
interface Kept {
  fill: Promise<Fill | null>;
  until: number;
}

/** One sign-in a command is handed: its key (where it's handed and whose), and the URLs of the command it's for. */
interface Used {
  key: string;
  at: string;
  s: SignIn;
  byPath: boolean;
  fill: Fill;
  urls: string[];
}

/**
 * A runner whose git fetches, pushes and ls-remotes over https carry the host's sign-in themselves (see the top of this
 * file). Every other command, and git's own way when the sign-in can't be had, goes to `inner` as given.
 *
 * `inner` lays `env` over the command's own environment (GitRunOptions.env). The settings the sign-in adds are numbered
 * after the GIT_CONFIG_COUNT of `{...process.env, ...opts.env}`, so an agent whose commands' own environment isn't this
 * process's (a session's, say) hands each git command that environment whole in `env`, GIT_CONFIG_COUNT and all.
 *
 * `o.fetch` asks a host itself (an ls-remote, and whether a refused sign-in is stale). Under node --test only a test's
 * own is used: a test's made-up remote is never asked over the network.
 *
 * `o.windows` looks in Windows Credential Manager for Git Credential Manager's refresh tokens (kit 2.147.2). Under
 * node --test only where a test says so: a test never reads the person's Credential Manager.
 */
export function signedIn<O extends GitRunOptions, R extends GitRan>(inner: GitRunner<O, R>, now: () => number = Date.now, o: { fetch?: typeof fetch; windows?: boolean } = {}): GitRunner<O, R> {
  const ask = inner as unknown as GitRunner;
  const net = o.fetch ?? (process.env.NODE_TEST_CONTEXT ? null : fetch);
  const windows = o.windows ?? (!process.env.NODE_TEST_CONTEXT && process.platform === 'win32');
  const fills = new Map<string, Kept>();
  const paths = new Map<string, { byPath: Promise<boolean>; until: number }>();
  /** Per sign-in: a repository it read, as `origin/path`, and until when that shows the sign-in good. */
  const read = new Map<string, { url: string; until: number }>();
  /** Repositories a host refused with a sign-in it takes (not there, not shared, or not this command's to do). */
  const ownRefusal = new Map<string, number>();
  /** Per sign-in: until when an access token it was told to forget for its refresh token isn't told again. */
  const refreshed = new Map<string, number>();
  const recovering = new Map<string, Promise<Fill | null>>();

  const byPathFor = (s: SignIn, cwd: string | undefined): Promise<boolean> => {
    const k = paths.get(s.origin);
    if (k && k.until > now()) return k.byPath;
    const byPath = asksByPath(ask, `${s.origin}/${s.rawPath}`, cwd);
    paths.set(s.origin, { byPath, until: now() + KEEP_MS });
    return byPath;
  };
  /**
   * A URL's sign-in: its host's, asked once for the host; where git asks helpers by path (found out only when the host
   * gives none, so most hosts start no more processes for it), its repository's.
   */
  const signInFor = async (s: SignIn, cwd: string | undefined): Promise<Omit<Used, 'urls'> | null> => {
    const user = s.user ?? '';
    const known = paths.get(s.origin);
    if (!(s.rawPath && known && known.until > now() && (await known.byPath))) {
      const fill = await fillFor(`${s.origin}|${user}`, s, false, cwd);
      if (fill) return { key: `${s.origin}|${user}`, at: s.origin, s, byPath: false, fill };
      if (!s.rawPath || !(await byPathFor(s, cwd))) return null;
    }
    const at = keyOf(s, true);
    const fill = await fillFor(`${at}|${user}`, s, true, cwd);
    return fill ? { key: `${at}|${user}`, at, s, byPath: true, fill } : null;
  };
  const fillFor = (key: string, s: SignIn, byPath: boolean, cwd: string | undefined): Promise<Fill | null> => {
    const k = fills.get(key);
    if (k && k.until > now()) return k.fill;
    const fill = askFill(ask, s, byPath, cwd);
    const entry: Kept = { fill, until: now() + KEEP_MS };
    fills.set(key, entry);
    void fill.then((f) => {
      if (!f && fills.get(key) === entry) entry.until = now() + MISS_MS;
    });
    return fill;
  };
  const keep = (key: string, f: Fill | null) => fills.set(key, { fill: Promise.resolve(f), until: now() + (f ? KEEP_MS : MISS_MS) });

  /**
   * Whether the host refuses this sign-in itself (true), takes it (false: the refusal was the repository's), refuses
   * it (401) with nothing to show whether the sign-in or the repository is why ('unsure': a private repository, the
   * only one asked), or can't say (null).
   */
  const stale = async (probe: string, u: Used, cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<boolean | 'unsure' | null> => {
    if (!net) return null;
    const reads = (url: string, authorization: string | null) => readsWith(url, { authorization, gitDir: gitDirAt(cwd), env, fetch: net, timeoutMs: 15_000 });
    const before = read.get(u.key);
    const other = before && before.until > now() && before.url !== probe ? before.url : null;
    const withIt = await reads(other ?? probe, u.fill.header.replace(/^authorization:\s*/i, ''));
    if (withIt === 200) return false;
    if (withIt !== 401) return null;
    if (other) return true;
    // No repository it read to ask: a public one that a host reads with no sign-in but refuses with this one shows it stale.
    return (await reads(probe, null)) === 200 ? true : 'unsure';
  };

  /**
   * Whether Git Credential Manager keeps a refresh token beside this sign-in: Windows Credential Manager names
   * `git:https://refresh_token.<host>`, as GCM's OAuth sign-ins keep theirs (Codeberg's, and Gitea's and Forgejo's
   * hosts'). Asked of cmdkey by that name alone, which lists names, never secrets.
   */
  const refreshable = async (u: Used, cwd: string | undefined): Promise<boolean> => {
    if (!windows) return false;
    const target = `git:${u.at.replace(/^https:\/\//, 'https://refresh_token.')}`;
    const r = await ask('cmdkey', [`/list:${target}`], { cwd, env: QUIET, timeoutMs: 10_000 }).catch(() => null);
    return r?.code === 0 && listsTarget(r.out, target);
  };

  /**
   * A sign-in a host refused, looked into once however many commands it refused meanwhile: the renewed sign-in to run
   * the command with once more, or null to leave the refusal as it is.
   */
  const recover = (u: Used, probe: string | null, cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<Fill | null> => {
    let p = recovering.get(u.key);
    if (!p) {
      p = (async () => {
        const again = await askFill(ask, u.s, u.byPath, cwd);
        if (again && again.header !== u.fill.header) {
          keep(u.key, again);
          return again;
        }
        if (!probe || (ownRefusal.get(probe) ?? 0) > now()) return null;
        const verdict = await stale(probe, u, cwd, env);
        if (verdict === false) ownRefusal.set(probe, now() + KEEP_MS);
        if (verdict === false || verdict === null) return null;
        // Refused where nothing shows why. Git Credential Manager hands back an OAuth access token however old (Codeberg's
        // last an hour), and makes a new one from its refresh token only once it keeps none: so where it keeps a refresh
        // token, it is told to forget the access token, once a while for each sign-in. Without one, nothing is forgotten.
        if (verdict === 'unsure') {
          if ((refreshed.get(u.key) ?? 0) > now() || !(await refreshable(u, cwd))) return null;
          refreshed.set(u.key, now() + KEEP_MS);
        }
        await forget(ask, u.fill, cwd);
        const renewed = await askFill(ask, u.s, u.byPath, cwd);
        keep(u.key, renewed);
        return renewed && renewed.header !== u.fill.header ? renewed : null;
      })().finally(() => recovering.delete(u.key));
      recovering.set(u.key, p);
    }
    return p;
  };

  return async (cmd, args, opts = {} as O) => {
    if (cmd !== 'git' || !TALKS.has(subcommand(args) ?? '')) return inner(cmd, args, opts);
    const headers = new Map<string, string>();
    const off: string[] = [];
    const used: Used[] = [];
    for (const url of urlsOf(args, opts.cwd)) {
      const s = signInOf(url);
      if (!s) continue;
      // Its own password: git signs in with it, and no helper is asked for one, or told to forget the one it keeps.
      if (s.password) {
        off.push(keyOf(s, true));
        continue;
      }
      const found = await signInFor(s, opts.cwd);
      if (!found) continue;
      const plain = `${s.origin}/${s.rawPath}`;
      const same = used.find((u) => u.key === found.key);
      if (!same) used.push({ ...found, urls: [plain] });
      else if (!same.urls.includes(plain)) same.urls.push(plain);
    }
    // Two users' sign-ins for one host in one command can't both be handed over: that host signs in git's own way.
    const mine = used.filter((u) => !used.some((v) => v.at === u.at && v.fill.header !== u.fill.header));
    for (const u of mine) headers.set(u.at, u.fill.header);
    if (!headers.size && !off.length) return inner(cmd, args, opts);

    const named = namedRepo(args, opts.cwd);
    const ns = named ? signInOf(named) : null;
    /** The repository `u` is handed for that the command names, as `origin/path`, or null. */
    const namedFor = (u: Used) => (ns && !ns.password && keyOf(ns, u.byPath) === u.at && (ns.user ?? '') === (u.s.user ?? '') ? `${ns.origin}/${ns.rawPath}` : null);
    const wasRead = () => {
      for (const u of mine) {
        const url = namedFor(u);
        if (url) read.set(u.key, { url, until: now() + KEEP_MS });
      }
    };

    // An ls-remote over https is asked in this process with the same sign-in (smart-http.ts, kit 2.64.0): no git. What
    // that can't answer as git would, it leaves to git.
    if (net && args[0] === 'ls-remote' && mine.length === 1 && !off.length) {
      const url = lsRemoteUrl(args, opts.cwd);
      const s = url ? signInOf(url) : null;
      const refs = s && keyOf(s, mine[0].byPath) === mine[0].at ? await advertisedRefs(url!, { authorization: mine[0].fill.header.replace(/^authorization:\s*/i, ''), gitDir: gitDirAt(opts.cwd), env: { ...process.env, ...opts.env }, fetch: net }) : null;
      const out = refs ? lsRemoteText(args, refs) : null;
      if (out !== null) {
        wasRead();
        return { code: 0, out, err: '' } as unknown as R;
      }
    }

    const withSignIn = () => ({ ...opts, env: { ...opts.env, ...signInEnv(headers, { ...process.env, ...opts.env }, off) } }) as O;
    const r = await inner(cmd, args, withSignIn());
    if (r.code === 0) wasRead();
    if (r.code === 0 || !mine.length || !refused(r)) return r;
    // Refused: never run again git's own way, whose helper would erase the sign-in (see the top of this file).
    let renewed = false;
    for (const u of mine) {
      const probe = namedFor(u) ?? (u.urls.length === 1 ? u.urls[0] : null);
      const f = await recover(u, probe, opts.cwd, { ...process.env, ...opts.env });
      if (f) {
        headers.set(u.at, f.header);
        renewed = true;
      }
    }
    if (!renewed) return r;
    const again = await inner(cmd, args, withSignIn());
    if (again.code === 0) wasRead();
    return again;
  };
}

/**
 * The environment for a script whose git commands talk to these repositories or hosts (a PowerShell job fetching its
 * repositories), given as URLs or origins: each sign-in asked of git's credential helper once (`git credential fill`,
 * one helper chain per host instead of one per git command), handed to git as a header for that host only, or for
 * that repository where git asks helpers by path (so give a dev.azure.com repository's whole URL). An origin whose
 * sign-in can't be read is left out: git signs in there its own way, as before. Empty when none could be read.
 *
 * A sign-in that goes stale while the script runs isn't renewed, as `signedIn`'s are: the script's command fails as it
 * would have (and, the helper being off for that host, leaves the helper's sign-in as it is), and the next run asks
 * again. Keep a script's run short of KEEP_MS.
 *
 * It is added to the script's environment, never all of it: its entries are numbered after the GIT_CONFIG_COUNT of
 * `o.already` (this process's environment when not given), so the script runs with `{...already, ...scriptEnv(…)}`.
 * `run` lays `env` over the command's own environment (GitRunOptions.env).
 */
export async function scriptEnv(urls: Iterable<string>, run: GitRunner, o: { cwd?: string; already?: Record<string, string | undefined> } = {}): Promise<Record<string, string>> {
  const headers = new Map<string, string>();
  const clash = new Set<string>();
  const asked = new Set<string>();
  const paths = new Map<string, Promise<boolean>>();
  const fills = new Map<string, Promise<Fill | null>>();
  const fillOnce = (key: string, s: SignIn, byPath: boolean) => {
    if (!fills.has(key)) fills.set(key, askFill(run, s, byPath, o.cwd));
    return fills.get(key)!;
  };
  for (const url of new Set(urls)) {
    const s = signInOf(url);
    if (!s || s.password) continue;
    const user = s.user ?? '';
    // The host's sign-in; where the host gives none and git asks helpers by path, the repository's.
    let at = s.origin;
    let f = paths.get(s.origin) && (await paths.get(s.origin)) ? null : await fillOnce(`${at}|${user}`, s, false);
    if (!f && s.rawPath) {
      if (!paths.has(s.origin)) paths.set(s.origin, asksByPath(run, `${s.origin}/${s.rawPath}`, o.cwd));
      if (await paths.get(s.origin)) {
        at = keyOf(s, true);
        f = await fillOnce(`${at}|${user}`, s, true);
      }
    }
    if (!f || asked.has(`${at}|${user}`)) continue;
    asked.add(`${at}|${user}`);
    if (headers.has(at) && headers.get(at) !== f.header) clash.add(at);
    headers.set(at, f.header);
  }
  for (const at of clash) headers.delete(at);
  return scriptSignInEnv(headers, o.already ?? process.env);
}
