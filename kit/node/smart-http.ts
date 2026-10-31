import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `git ls-remote` over https answered in the agent's own process (kit 2.64.0): one request for the remote's ref
 * advertisement (`GET <url>/info/refs?service=git-upload-pack`, smart HTTP, protocol v0), instead of git and its https
 * helper, two processes or more each time, where every process that ends leaves kernel memory behind on some PCs. The
 * Steward's turn check alone ran `ls-remote` for every repository each round: 141 times in 22 minutes on 2026-10-12.
 * Reeve 0.17.38 asks its branches the same way, its answers checked against git's on 40 repositories.
 *
 * Only what a plain request does as git would: plain https, no URL rewrite, proxy or own certificates in git's config
 * or environment, and only the options and patterns read here. Anything else, and any failure (a refusal, a redirect, a
 * timeout, an answer that isn't an advertisement), is null: the caller runs git as before. KIT_SMART_HTTP=0 turns it off.
 */

/** A remote's refs as it advertises them, in its order: HEAD first when it has one, peeled tags as `<tag>^{}`. */
export type AdvertisedRef = [sha: string, name: string];

/** A smart-HTTP ref advertisement's refs, or null when it isn't one (or is protocol v2, not asked for). Pure. */
export function parseAdvertisement(body: Buffer): AdvertisedRef[] | null {
  const refs: AdvertisedRef[] = [];
  let i = 0;
  let service = false;
  let first = true;
  while (i + 4 <= body.length) {
    const len = parseInt(body.toString('latin1', i, i + 4), 16);
    if (Number.isNaN(len)) return null;
    if (len === 0) {
      i += 4;
      if (service && !first) break;
      continue;
    }
    if (len < 4 || i + len > body.length) return null;
    const line = body.toString('utf8', i + 4, i + len).replace(/\n$/, '');
    i += len;
    if (!service) {
      if (line !== '# service=git-upload-pack') return null;
      service = true;
      continue;
    }
    if (first && line.startsWith('version ')) return null;
    first = false;
    const m = /^([0-9a-f]{40,64}) ([^\0]+)/.exec(line);
    if (!m) return null;
    // An empty repository advertises only its capabilities, under a zero id.
    if (m[2] !== 'capabilities^{}') refs.push([m[1], m[2]]);
  }
  return service ? refs : null;
}

/** The options `lsRemoteText` reads; any other is git's. */
const OPTIONS = new Set(['--heads', '-h', '--tags', '-t', '--refs', '-q', '--quiet']);

/**
 * What `git ls-remote <options> <repository> <patterns>` prints for these refs (its standard output), or null for a
 * command line read here differently from git: an option of another kind, a glob pattern, no repository. Pure.
 */
export function lsRemoteText(args: string[], refs: AdvertisedRef[]): string | null {
  if (args[0] !== 'ls-remote') return null;
  const opts = new Set<string>();
  let i = 1;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (!OPTIONS.has(args[i])) return null;
    opts.add(args[i]);
  }
  if (i >= args.length) return null;
  const patterns = args.slice(i + 1);
  if (patterns.some((p) => /[*?[\\]/.test(p) || p.startsWith('-'))) return null;
  const heads = opts.has('--heads') || opts.has('-h');
  const tags = opts.has('--tags') || opts.has('-t');
  const out: string[] = [];
  for (const [sha, name] of refs) {
    if ((heads || tags) && !((heads && name.startsWith('refs/heads/')) || (tags && name.startsWith('refs/tags/')))) continue;
    if (opts.has('--refs') && (name.endsWith('^{}') || name === 'HEAD')) continue;
    // git's own match: the pattern is the ref's whole name or the end of it, after a slash.
    if (patterns.length && !patterns.some((p) => name === p || name.endsWith(`/${p}`))) continue;
    out.push(`${sha}\t${name}\n`);
  }
  return out.join('');
}

const QUIRKS = /^\s*(insteadof|pushinsteadof|proxy|sslcainfo|sslcapath|sslcert|sslkey|sslverify|cookiefile|emptyauth|followredirects|extraheader)\s*=/im;
const QUIRKY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'GIT_SSL_NO_VERIFY', 'GIT_SSL_CAINFO', 'GIT_PROXY_COMMAND', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS'];
let globalQuirks: boolean | null = null;

const readQuirks = (f: string) => {
  try {
    return QUIRKS.test(readFileSync(f, 'utf8'));
  } catch {
    return false;
  }
};

/**
 * Whether git would talk to a remote differently from a plain request: a URL rewrite, a proxy, own certificates or
 * headers in the person's git config (kept per process), the repository's (`gitDir`), or the environment. The only
 * header allowed is the sign-in this kit hands git (git-auth.ts), and the credential helper switched off with it.
 */
export function quirky(gitDir: string | null | undefined, env: NodeJS.ProcessEnv): boolean {
  if (QUIRKY_ENV.some((k) => env[k])) return true;
  if (globalQuirks === null) {
    const home = env.HOME || env.USERPROFILE || '';
    const xdg = env.XDG_CONFIG_HOME || (home && path.join(home, '.config'));
    globalQuirks = (!!home && readQuirks(path.join(home, '.gitconfig'))) || (!!xdg && readQuirks(path.join(xdg, 'git', 'config')));
  }
  if (globalQuirks) return true;
  if (gitDir && (readQuirks(path.join(gitDir, 'config')) || readQuirks(path.join(gitDir, 'config.worktree')))) return true;
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  for (let i = 0; i < n; i++) {
    const key = String(env[`GIT_CONFIG_KEY_${i}`] ?? '').toLowerCase();
    if (/^url\./.test(key)) return true;
    // The sign-in's header, for a host (http.https://host/.extraheader) or, where git asks helpers by path, a repository.
    if (QUIRKS.test(`${key.slice(key.lastIndexOf('.') + 1)}=`) && !/^http\.https:\/\/[^/]+\/.*\.extraheader$/.test(key)) return true;
  }
  return false;
}

/**
 * A remote's refs over https in this process, signed in with `authorization` (an Authorization header's value, as
 * git-auth.ts reads it from git's credential helper) or none (a public repository). Null when the URL isn't plain
 * https, when git would talk to it another way (`quirky`), when KIT_SMART_HTTP=0, or on any failure.
 */
export async function advertisedRefs(url: string, o: InfoRefsOptions = {}): Promise<AdvertisedRef[] | null> {
  const res = await infoRefs(url, o);
  if (!res) return null;
  try {
    if (!advertises(res)) return null;
    return parseAdvertisement(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

/**
 * How a host answers a read of a repository over https, signed in with `authorization` or with none (kit 2.146.6:
 * git-auth.ts asks it of a sign-in a host refused, to tell a stale sign-in from a repository it won't show). 200 when
 * it answers with the refs, else its status: 401 when it refuses the sign-in itself, 404 or 403 for a repository it
 * won't show. Null when it can't be asked as git would ask it (not plain https, `quirky`, KIT_SMART_HTTP=0), on any
 * failure, and for a 200 that isn't refs (a sign-in page).
 */
export async function readsWith(url: string, o: InfoRefsOptions = {}): Promise<number | null> {
  return (await answerTo(url, o)).status;
}

/**
 * readsWith's status, and on a 401 what the host asks a sign-in by: its WWW-Authenticate (several as fetch joins them,
 * with ", "), or null. kit 2.147.2: git hands it to its credential helper after a 401 (`wwwauth[]`), and Git Credential
 * Manager knows a Gitea or Forgejo host (Codeberg) by it alone, so git-auth.ts hands it on when it asks for a new sign-in.
 */
export async function answerTo(url: string, o: InfoRefsOptions = {}): Promise<{ status: number | null; challenge: string | null }> {
  const res = await infoRefs(url, o);
  if (!res) return { status: null, challenge: null };
  const status = res.status === 200 ? (advertises(res) ? 200 : null) : res.status;
  const challenge = res.status === 401 ? res.headers.get('www-authenticate') : null;
  await res.body?.cancel().catch(() => {});
  return { status, challenge };
}

interface InfoRefsOptions {
  authorization?: string | null;
  gitDir?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const advertises = (res: Response) => res.status === 200 && /^application\/x-git-upload-pack-advertisement/i.test(res.headers.get('content-type') ?? '');

/** The remote's ref advertisement asked (GET <url>/info/refs?service=git-upload-pack), or null where it isn't asked. */
async function infoRefs(url: string, o: InfoRefsOptions): Promise<Response | null> {
  const env = o.env ?? process.env;
  if (env.KIT_SMART_HTTP === '0') return null;
  const m = /^https:\/\/([^/?#\s@]+)(\/[^?#\s]*)$/i.exec(url.trim());
  if (!m || m[2] === '/' || quirky(o.gitDir, env)) return null;
  const headers: Record<string, string> = { 'User-Agent': 'git/castellan-kit', Accept: '*/*', Pragma: 'no-cache' };
  if (o.authorization) headers.Authorization = o.authorization;
  try {
    return await (o.fetch ?? fetch)(`https://${m[1].toLowerCase()}${m[2].replace(/\/+$/, '')}/info/refs?service=git-upload-pack`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
  } catch {
    return null;
  }
}
