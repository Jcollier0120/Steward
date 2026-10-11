import { execFile } from 'node:child_process';

/**
 * GitHub's API from Node, signed in as the GitHub CLI is: an agent asks GitHub over HTTPS instead of starting gh for
 * each question. gh is started once per process, for its token (`gh auth token`), and again only when GitHub turns the
 * token down. GH_TOKEN or GITHUB_TOKEN, when set, is used as gh itself would.
 *
 * A GET keeps GitHub's ETag for its URL, and asks again with If-None-Match: an answer that hasn't changed comes back
 * as 304, which costs nothing of the hourly rate limit and carries no body.
 */

export class GitHubApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GitHubApiOptions {
  /** The token; by default GH_TOKEN, GITHUB_TOKEN, then `gh auth token`. */
  token?: () => Promise<string>;
  /** For tests. */
  fetch?: typeof fetch;
  base?: string;
  timeoutMs?: number;
}

const UA = 'castellan-kit';
/** How many GETs keep their ETag and answer, newest first. */
const ETAGS = 1000;

let ghToken: Promise<string> | null = null;

/** The token gh is signed in with: once per process, and again after GitHub turned it down (forget()). */
export function tokenFromGh(): Promise<string> {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return Promise.resolve(env);
  ghToken ??= new Promise<string>((resolve, reject) =>
    execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { windowsHide: true, timeout: 30_000, encoding: 'utf8' }, (e, out) => {
      const t = String(out ?? '').trim();
      if (e || !t) reject(new GitHubApiError(401, `gh isn't signed in to GitHub (gh auth token: ${e?.message.split('\n')[0] ?? 'no token'})`));
      else resolve(t);
    }),
  ).catch((e) => {
    ghToken = null;
    throw e;
  });
  return ghToken;
}

export class GitHubApi {
  private readonly token: () => Promise<string>;
  private readonly fetch: typeof fetch;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly etags = new Map<string, { etag: string; data: unknown; link: string | null }>();

  constructor(o: GitHubApiOptions = {}) {
    this.token = o.token ?? tokenFromGh;
    this.fetch = o.fetch ?? fetch;
    this.base = (o.base ?? 'https://api.github.com').replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? 60_000;
  }

  /** A REST call: its JSON (or text, for a raw Accept), or GitHubApiError. `path` is relative to the API (repos/…). */
  async rest<T = any>(method: string, path: string, o: { body?: unknown; accept?: string } = {}): Promise<T> {
    return (await this.request<T>(method, path, o)).data;
  }

  /** Every page of a GET list (per_page=100, following the Link header), up to `limit` items. */
  async list<T = any>(path: string, limit = Infinity): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}per_page=${Math.min(100, Math.max(1, limit === Infinity ? 100 : limit))}`;
    while (next && out.length < limit) {
      const r: { data: T[]; link: string | null } = await this.request<T[]>('GET', next, {});
      out.push(...r.data);
      next = /<([^>]+)>;\s*rel="next"/.exec(r.link ?? '')?.[1] ?? null;
    }
    return out.slice(0, limit);
  }

  /** A GraphQL query: its data, or GitHubApiError with GitHub's first error. */
  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await this.rest<{ data?: T; errors?: { message: string; type?: string }[] }>('POST', 'graphql', { body: { query, variables } });
    if (r.errors?.length) throw new GitHubApiError(r.errors[0].type === 'NOT_FOUND' ? 404 : 422, `GitHub: ${r.errors[0].message}`);
    return r.data as T;
  }

  private async request<T>(method: string, path: string, o: { body?: unknown; accept?: string }, retried = false): Promise<{ data: T; link: string | null }> {
    const url = /^https:/.test(path) ? path : `${this.base}/${path.replace(/^\/+/, '')}`;
    const cached = method === 'GET' ? this.etags.get(`${o.accept ?? ''} ${url}`) : undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.token()}`,
      accept: o.accept ?? 'application/vnd.github+json',
      'user-agent': UA,
      'x-github-api-version': '2022-11-28',
    };
    if (cached) headers['if-none-match'] = cached.etag;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetch(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 304 && cached) return { data: cached.data as T, link: cached.link };
    if (res.status === 401 && !retried && this.token === tokenFromGh) {
      ghToken = null;
      return this.request(method, path, o, true);
    }
    const text = await res.text();
    const raw = !!o.accept && !/json/.test(o.accept);
    let data: any = text;
    if (!raw && text) {
      try {
        data = JSON.parse(text);
      } catch {
        // GitHub answered with something that isn't JSON (an error page): said below if it failed.
      }
    }
    if (!res.ok) throw new GitHubApiError(res.status, `GitHub ${method} ${path.split('?')[0]}: ${res.status} ${data?.message ?? text.slice(0, 200)}`);
    const link = res.headers.get('link');
    const etag = res.headers.get('etag');
    if (method === 'GET' && etag) {
      const key = `${o.accept ?? ''} ${url}`;
      this.etags.delete(key);
      this.etags.set(key, { etag, data, link });
      if (this.etags.size > ETAGS) this.etags.delete(this.etags.keys().next().value!);
    }
    return { data: (text || raw ? data : null) as T, link };
  }
}
