import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { commonDir } from './git.ts';
import type { Ran, Runner, RunOptions } from './run.ts';

/**
 * git's sign-in for the Steward's fetches and pushes, given to git up front (Steward 0.35.31).
 *
 * Over HTTPS, each fetch or push of a private repository had git ask the credential helper for the sign-in and then
 * store it back: for Git Credential Manager, a shell, a git and the manager itself, twice, so 6 of the 9 processes
 * one fetch started. A round fetches dozens of times, and on some PCs every process that ends leaves kernel memory
 * behind. Now the Steward asks the helper once per host (`git credential fill`, kept 30 minutes in memory, never
 * written anywhere) and hands it to git as an Authorization header through git's environment config
 * (GIT_CONFIG_COUNT…), never its command line, where any process could read it.
 *
 * While it does, git's credential helpers are switched off for that command. Otherwise a sign-in that has gone stale
 * would have git fall back to the helper, fail with both, and have the helper erase the good one it keeps. A command
 * the host refuses is run once more as before (the helper's own way), and the host's sign-in is asked again only
 * after MISS_MS. A host whose sign-in can't be read (none kept, a public repository, SSH) is left to git as before.
 */

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

/** The https origins of a clone's remotes, from its config file (no git started); none when it can't be read. */
export function remoteOrigins(repo: string): string[] {
  try {
    const common = commonDir(repo);
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
    return out.map((u) => (/^https:/i.test(u) ? (httpsOrigin(u) ?? 'named') : 'other'));
  } catch {
    return [];
  }
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

/**
 * The environment that hands git these headers: appended to any GIT_CONFIG_COUNT entries already set, and the
 * credential helpers switched off first (an empty credential.helper empties the list). Pure.
 */
export function signInEnv(headers: Map<string, string>, already: Record<string, string | undefined>): Record<string, string> {
  let n = Number(already.GIT_CONFIG_COUNT) || 0;
  const env: Record<string, string> = { ...QUIET };
  const add = (key: string, value: string) => {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  };
  add('credential.helper', '');
  for (const [origin, header] of headers) add(`http.${origin}/.extraHeader`, header);
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

/** What a host says when it refuses a sign-in (GitHub says a private repository it won't show you isn't there). */
export const refused = (r: Ran) => /authentication failed|invalid (username|credentials)|could not read (username|password)|terminal prompts disabled|repository not found|returned error: 40[134]/i.test(`${r.err}\n${r.out}`);

/** A sign-in as asked of the helper, kept KEEP_MS (MISS_MS when there was none, or the host refused it). */
interface Kept {
  header: Promise<string | null>;
  until: number;
}

/**
 * A runner whose git fetches, pushes and ls-remotes over https carry the host's sign-in themselves (see the top of this
 * file). Every other command, and git's own way when the sign-in can't be had, goes to `inner` as given.
 */
export function signedIn(inner: Runner, now: () => number = Date.now): Runner {
  const byOrigin = new Map<string, Kept>();
  const headerFor = (origin: string, cwd: string | undefined): Promise<string | null> => {
    const k = byOrigin.get(origin);
    if (k && k.until > now()) return k.header;
    const header = inner('git', ['credential', 'fill'], { cwd, input: `protocol=https\nhost=${origin.slice('https://'.length)}\n\n`, env: QUIET, timeoutMs: 30_000 })
      .then((r) => (r.code === 0 ? headerOf(r.out) : null))
      .catch(() => null);
    const entry: Kept = { header, until: now() + KEEP_MS };
    byOrigin.set(origin, entry);
    void header.then((h) => {
      if (!h && byOrigin.get(origin) === entry) entry.until = now() + MISS_MS;
    });
    return header;
  };
  return async (cmd, args, opts: RunOptions = {}) => {
    if (cmd !== 'git' || !TALKS.has(subcommand(args) ?? '')) return inner(cmd, args, opts);
    const origins = originsOf(args, opts.cwd);
    if (!origins) return inner(cmd, args, opts);
    const headers = new Map<string, string>();
    for (const origin of origins) {
      const h = await headerFor(origin, opts.cwd);
      if (!h) return inner(cmd, args, opts);
      headers.set(origin, h);
    }
    const r = await inner(cmd, args, { ...opts, env: { ...opts.env, ...signInEnv(headers, { ...process.env, ...opts.env }) } });
    if (r.code === 0 || !refused(r)) return r;
    // Refused: the sign-in went stale. Asked again later; this time git signs in its own way.
    for (const origin of origins) byOrigin.set(origin, { header: Promise.resolve(null), until: now() + MISS_MS });
    return inner(cmd, args, opts);
  };
}
