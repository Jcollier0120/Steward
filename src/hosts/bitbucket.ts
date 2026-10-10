import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../run.ts';
import type { Answer, PrState, SourceHost } from './host.ts';

const MINUTE = 60_000;
const API = 'https://api.bitbucket.org/2.0';
/** Where its API token is kept: this PC's git credential store, as an HTTPS password for this host. */
export const TOKEN_HOST = 'api.bitbucket.org';

/**
 * Bitbucket Cloud (bitbucket.org), through its REST API (2.0) by curl, with an Atlassian API token this PC keeps in its
 * git credential store (Windows' Credential Manager, through Git Credential Manager) for api.bitbucket.org: the account's
 * email as its user name, the token as its password. The Steward reads it with `git credential fill` each time it's
 * needed and hands it to curl in a file of its own, never on a command line, and never keeps it. Bitbucket has no CLI
 * that can merge (Atlassian's twg has none, and no raw API since 1.3.5), so there is none to borrow a sign-in from. A
 * repository is named as scm.ts's repoFromUrl names it, bitbucket.org/<workspace>/<repo>.
 *
 * Its answers are said in GitHub's words (host.ts). Bitbucket names a pull request's head commit by a short hash, so the
 * full one is asked; whether it merges, its files and its line counts come from its diffstat (a file "merge conflict"
 * means it can't); its checks are its head's build statuses. Bitbucket keeps no ref for a pull request's head: its
 * branch is fetched (a fork's isn't worked with). It merges with no head to match, so the head is checked just before.
 * A build status doesn't say who set it, so the vouch's own says so in its name ("steward/tested by <nickname>"); setting
 * one needs write access to the repository. Bitbucket has no releases: a release is a v<version> tag, its message the
 * notes. Its issue tracker is being retired, so the Wright's issues aren't filed here.
 */
export class Bitbucket implements SourceHost {
  readonly kind = 'bitbucket' as const;
  readonly name = 'Bitbucket';
  private readonly run: Runner;
  private readonly cwd: string;
  private me: string | null = null;

  constructor(run: Runner, cwd: string) {
    this.run = run;
    this.cwd = cwd;
  }

  /**
   * One request: curl with the token from a config file of its own (deleted after), a body as JSON from a file, the
   * HTTP status written after the body; an HTTP error is a failure. `out` is set: the response written there.
   */
  private async api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, o: { timeoutMs?: number; out?: string } = {}): Promise<Answer> {
    const what = `curl ${method} ${url}`;
    const login = await bitbucketLogin(this.run, this.cwd);
    if (!login) return { code: 1, out: '', err: NO_TOKEN, what };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'steward-bitbucket-'));
    try {
      const auth = path.join(dir, 'auth.conf');
      writeFileSync(auth, `user = "${curlQuoted(`${login.username}:${login.password}`)}"\n`, { mode: 0o600 });
      const args = ['--silent', '--show-error', '--config', auth, '--request', method, '--url', url, '--write-out', '\n%{http_code}'];
      if (body !== undefined) {
        writeFileSync(path.join(dir, 'body.json'), JSON.stringify(body));
        args.push('--header', 'Content-Type: application/json', '--data-binary', `@${path.join(dir, 'body.json')}`);
      }
      if (o.out) args.push('--location', '--output', o.out);
      return { ...answered(await this.run('curl', args, { cwd: this.cwd, timeoutMs: o.timeoutMs ?? 2 * MINUTE })), what };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A repository's request, at /2.0/repositories/<workspace>/<repo>/…. */
  private repo(repo: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', rest: string, body?: unknown, timeoutMs?: number): Promise<Answer> {
    const w = where(repo);
    return this.api(method, `${API}/repositories/${encodeURIComponent(w.workspace)}/${encodeURIComponent(w.slug)}${rest}`, body, { timeoutMs });
  }

  /** Up to `want` values of a paged list, following each page's `next`. */
  private async pages(repo: string, rest: string, want: number): Promise<Answer & { items: any[] }> {
    const items: any[] = [];
    let a = await this.repo(repo, 'GET', rest);
    while (a.code === 0) {
      const page = parsed<any>(a.out);
      items.push(...(Array.isArray(page?.values) ? page.values : []));
      if (items.length >= want || typeof page?.next !== 'string') break;
      a = await this.api('GET', page.next);
    }
    return { ...a, items: items.slice(0, want) };
  }

  async listPrs(repo: string, q: { state: PrState; head?: string; limit?: number; fields: string }): Promise<Answer> {
    const limit = q.limit ?? 30;
    const states = PR_STATES[q.state].map((s) => `state=${s}`).join('&');
    const a = await this.pages(repo, `/pullrequests?${states}&pagelen=50${q.head ? `&q=${encodeURIComponent(`source.branch.name="${q.head}"`)}` : ''}`, limit);
    if (a.code !== 0) return a;
    const prs = [];
    for (const pr of a.items) {
      const more = await this.details(repo, pr, q.fields);
      if ('code' in more) return more;
      prs.push(prOf(more.pr ?? pr, more));
    }
    return { ...a, out: JSON.stringify(prs) };
  }

  async viewPr(repo: string, which: number | string, fields: string): Promise<Answer> {
    let pr: any;
    if (typeof which === 'string' && !/^\d+$/.test(which)) {
      // By its branch: the open one from it, as gh pr view <branch> finds it.
      const a = await this.pages(repo, `/pullrequests?state=OPEN&pagelen=50&q=${encodeURIComponent(`source.branch.name="${which}"`)}`, 1);
      if (a.code !== 0) return a;
      pr = a.items[0];
      if (!pr) return { ...a, code: 1, out: '', err: `no pull requests found for branch "${which}"` };
    } else {
      const a = await this.repo(repo, 'GET', `/pullrequests/${which}`);
      if (a.code !== 0) return a;
      pr = parsed<any>(a.out);
    }
    const more = await this.details(repo, pr, fields, true);
    if ('code' in more) return more;
    return { code: 0, out: JSON.stringify(prOf(more.pr ?? pr, more)), err: '', what: `curl GET pullrequests/${pr?.id}` };
  }

  /**
   * What a pull request's list entry hasn't, asked only when `fields` wants it: its description (the list leaves it
   * out), its head's full hash, its diffstat, its head's build statuses.
   */
  private async details(repo: string, pr: any, fields: string, whole = false): Promise<Answer | { pr?: any; head?: string; diffstat?: any[]; statuses?: any[] }> {
    const want = new Set(fields.split(','));
    const out: { pr?: any; head?: string; diffstat?: any[]; statuses?: any[] } = {};
    if (want.has('body') && !whole) {
      const a = await this.repo(repo, 'GET', `/pullrequests/${pr.id}`);
      if (a.code !== 0) return a;
      out.pr = parsed<any>(a.out) ?? pr;
    }
    const short = String(pr?.source?.commit?.hash ?? '');
    if (short && (want.has('headRefOid') || want.has('statusCheckRollup'))) {
      const c = await this.repo(repo, 'GET', `/commit/${short}`);
      if (c.code !== 0) return c;
      out.head = String(parsed<any>(c.out)?.hash ?? short);
    }
    if (['files', 'additions', 'deletions', 'mergeable', 'mergeStateStatus'].some((f) => want.has(f))) {
      const d = await this.pages(repo, `/pullrequests/${pr.id}/diffstat?pagelen=500`, 5000);
      if (d.code !== 0) return d;
      out.diffstat = d.items;
    }
    if (want.has('statusCheckRollup') && out.head) {
      const s = await this.pages(repo, `/commit/${out.head}/statuses?pagelen=100`, 1000);
      if (s.code !== 0) return s;
      out.statuses = s.items;
    }
    return out;
  }

  async createPr(repo: string, p: { base: string; head: string; title: string; body: string }): Promise<Answer> {
    const a = await this.repo(repo, 'POST', '/pullrequests', { title: p.title, description: p.body, source: { branch: { name: p.head } }, destination: { branch: { name: p.base } } }, 5 * MINUTE);
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.links?.html?.href ?? ''}\n` } : a;
  }

  /** Bitbucket's update wants the title whatever changes: the one it has, when none is given. */
  private async update(repo: string, n: number, change: Record<string, unknown>): Promise<Answer> {
    const a = await this.repo(repo, 'GET', `/pullrequests/${n}`);
    if (a.code !== 0) return a;
    return this.repo(repo, 'PUT', `/pullrequests/${n}`, { title: String(parsed<any>(a.out)?.title ?? ''), ...change });
  }

  editPr(repo: string, n: number, p: { title?: string; body?: string; base?: string }): Promise<Answer> {
    return this.update(repo, n, { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.body !== undefined ? { description: p.body } : {}), ...(p.base !== undefined ? { destination: { branch: { name: p.base } } } : {}) });
  }

  commentPr(repo: string, n: number, body: string): Promise<Answer> {
    return this.repo(repo, 'POST', `/pullrequests/${n}/comments`, { content: { raw: body } });
  }

  readyPr(repo: string, n: number): Promise<Answer> {
    return this.update(repo, n, { draft: false });
  }

  async closePr(repo: string, n: number, p: { comment?: string; deleteBranch?: boolean } = {}): Promise<Answer> {
    if (p.comment !== undefined) {
      const c = await this.commentPr(repo, n, p.comment);
      if (c.code !== 0) return c;
    }
    const a = await this.repo(repo, 'POST', `/pullrequests/${n}/decline`);
    if (a.code !== 0 || !p.deleteBranch) return a;
    const pr = parsed<any>(a.out);
    // A fork's branch is its own to keep.
    const own = pr?.source?.repository?.full_name === pr?.destination?.repository?.full_name;
    const branch = own ? pr?.source?.branch?.name : null;
    return branch ? this.repo(repo, 'DELETE', `/refs/branches/${encodeURIComponent(branch)}`) : a;
  }

  /**
   * Merged with a merge commit. Bitbucket merges with no head to match, so its head is checked just before: one that
   * moved from `matchHead` isn't merged. A merge Bitbucket finishes in the background (202) is asked after (a minute at
   * most) until it has.
   */
  async mergePr(repo: string, n: number, p: { matchHead?: string; deleteBranch?: boolean } = {}, waitMs = 5_000): Promise<Answer> {
    if (p.matchHead) {
      const now = await this.viewPr(repo, n, 'headRefOid');
      if (now.code !== 0) return now;
      const head = String(parsed<any>(now.out)?.headRefOid ?? '');
      if (head !== p.matchHead) return { ...now, code: 1, out: '', err: `pull request ${n}'s head moved (${head.slice(0, 7)}, not ${p.matchHead.slice(0, 7)}): not merged` };
    }
    let a = await this.repo(repo, 'POST', `/pullrequests/${n}/merge`, { type: 'pullrequest_merge_parameters', merge_strategy: 'merge_commit', close_source_branch: !!p.deleteBranch }, 5 * MINUTE);
    for (let i = 0; a.code === 0 && parsed<any>(a.out)?.state !== 'MERGED' && i < 12; i++) {
      await new Promise((r) => setTimeout(r, waitMs));
      a = await this.repo(repo, 'GET', `/pullrequests/${n}`);
    }
    return a.code === 0 && parsed<any>(a.out)?.state !== 'MERGED' ? { ...a, code: 1, err: `pull request ${n} is still being merged on Bitbucket` } : a;
  }

  async statuses(repo: string, commit: string): Promise<Answer> {
    const a = await this.pages(repo, `/commit/${commit}/statuses?pagelen=100&sort=-created_on`, 1000);
    return a.code === 0 ? { ...a, out: JSON.stringify(a.items.map(statusOf).sort(newestFirst)) } : a;
  }

  /** A build status keyed by the context; its name says who set it, Bitbucket's own saying nothing of it. */
  async setStatus(repo: string, commit: string, s: { state: 'success' | 'failure' | 'pending'; context: string; description: string }): Promise<Answer> {
    if (this.me === null) {
      const who = await this.whoAmI();
      if (who.code !== 0) return who;
      this.me = who.out.trim();
    }
    const w = where(repo);
    return this.repo(repo, 'POST', `/commit/${commit}/statuses/build`, { key: s.context, state: STATE_OUT[s.state], name: `${s.context} by ${this.me}`, description: s.description.slice(0, 255), url: `https://bitbucket.org/${w.workspace}/${w.slug}/commits/${commit}` });
  }

  /** Its releases are its v<version> tags (Bitbucket has no releases of its own), newest first. */
  async listReleases(repo: string, _fields: string, limit = 100): Promise<Answer> {
    const a = await this.pages(repo, `/refs/tags?pagelen=100&sort=-target.date&q=${encodeURIComponent('name ~ "v"')}`, limit);
    return a.code === 0 ? { ...a, out: JSON.stringify(a.items.map(tagOf)) } : a;
  }

  async viewRelease(repo: string, tag: string, _fields: string): Promise<Answer> {
    const a = await this.repo(repo, 'GET', `/refs/tags/${encodeURIComponent(tag)}`);
    if (a.code !== 0) return /\b404\b/.test(a.err) ? { ...a, err: `release not found: no tag ${tag}` } : a;
    return { ...a, out: JSON.stringify(tagOf(parsed<any>(a.out))) };
  }

  /** A release is an annotated tag at `target`, its message the title and the notes. */
  createRelease(repo: string, r: { tag: string; target: string; title: string; notesFile: string | null }): Promise<Answer> {
    const notes = r.notesFile ? readFileSync(r.notesFile, 'utf8') : '';
    return this.repo(repo, 'POST', '/refs/tags', { name: r.tag, target: { hash: r.target }, message: notes ? `${r.title}\n\n${notes}` : r.title }, 5 * MINUTE);
  }

  async downloadRelease(repo: string, tag: string): Promise<Answer> {
    return unsupported(`a release's files can't be downloaded from Bitbucket (${repo} ${tag}): it has no releases, only tags`);
  }

  async listIssues(): Promise<Answer> {
    return unsupported(NO_ISSUES);
  }
  async createIssue(): Promise<Answer> {
    return unsupported(NO_ISSUES);
  }
  async editIssue(): Promise<Answer> {
    return unsupported(NO_ISSUES);
  }
  async commentIssue(): Promise<Answer> {
    return unsupported(NO_ISSUES);
  }
  async closeIssue(): Promise<Answer> {
    return unsupported(NO_ISSUES);
  }
  async createLabel(): Promise<Answer> {
    return unsupported(NO_ISSUES);
  }

  /** The token's account, by its nickname: as Bitbucket names a pull request's author. */
  async whoAmI(): Promise<Answer> {
    const a = await this.api('GET', `${API}/user`);
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.nickname ?? ''}\n` } : a;
  }

  /** Bitbucket keeps no pull request head ref: the branch is fetched (a fork's isn't worked with). */
  prRef(pr: { number: number; head: string }): string {
    return `refs/heads/${pr.head}`;
  }

  releaseUrl(repo: string, tag: string): string {
    const w = where(repo);
    return `https://bitbucket.org/${w.workspace}/${w.slug}/src/${encodeURIComponent(tag)}`;
  }
}

const PR_STATES: Record<PrState, string[]> = { open: ['OPEN'], closed: ['DECLINED', 'SUPERSEDED'], merged: ['MERGED'] };
const STATE_OUT = { success: 'SUCCESSFUL', failure: 'FAILED', pending: 'INPROGRESS' } as const;
const NO_TOKEN = `no Bitbucket API token for ${TOKEN_HOST} in this PC's credential store`;
const NO_ISSUES = "the Steward doesn't file issues on Bitbucket (its issue tracker is being retired)";
const unsupported = (err: string): Answer => ({ code: 1, out: '', err, what: 'bitbucket' });

/** Bitbucket's API token, as each runner last read it from the credential store (ten minutes); never written anywhere. */
const tokens = new WeakMap<Runner, { at: number; login: { username: string; password: string } }>();

/**
 * The Atlassian API token this PC keeps for api.bitbucket.org in its git credential store, from `git credential fill`
 * with every prompt turned off (no window, no terminal question): null when there is none.
 */
export async function bitbucketLogin(run: Runner, cwd?: string): Promise<{ username: string; password: string } | null> {
  const known = tokens.get(run);
  if (known && Date.now() - known.at < 10 * MINUTE) return known.login;
  const r = await run('git', ['credential', 'fill'], { cwd, input: `protocol=https\nhost=${TOKEN_HOST}\n\n`, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' }, timeoutMs: 30_000 }).catch(() => null);
  const login = r?.code === 0 ? credentialOf(r.out) : null;
  if (login) tokens.set(run, { at: Date.now(), login });
  return login;
}

/** `git credential fill`'s answer as a user name and password, or null without both. Pure. */
export function credentialOf(out: string): { username: string; password: string } | null {
  const v = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.replace(/\r$/, '') ?? '';
  return v('username') && v('password') ? { username: v('username'), password: v('password') } : null;
}

/** A value inside double quotes in curl's config file: its backslashes and quotes escaped. Pure. */
export const curlQuoted = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * What curl answered, as a command's answer: the body, then the HTTP status on its own last line (--write-out); a 4xx
 * or 5xx is a failure, its message Bitbucket's error. Pure.
 */
export function answered(r: { code: number; out: string; err: string }): { code: number; out: string; err: string } {
  if (r.code !== 0) return r;
  const i = r.out.lastIndexOf('\n');
  const status = Number(r.out.slice(i + 1).trim());
  const body = i >= 0 ? r.out.slice(0, i) : '';
  if (!status || status < 400) return { code: 0, out: body, err: '' };
  const e = parsed<any>(body)?.error;
  const message = [e?.message, e?.detail].filter((x) => typeof x === 'string' && x).join(': ');
  return { code: 1, out: '', err: `HTTP ${status}${message ? `: ${message}` : body.trim() ? `: ${body.trim().slice(0, 300)}` : ''}` };
}

/** A repository's workspace and slug: bitbucket.org/acme/app. Null when it isn't on Bitbucket Cloud. Pure. */
export function whereBitbucket(repo: string): { workspace: string; slug: string } | null {
  const m = /^bitbucket\.org\/([^/]+)\/([^/]+)$/i.exec(repo);
  return m ? { workspace: m[1], slug: m[2] } : null;
}

function where(repo: string) {
  const w = whereBitbucket(repo);
  if (!w) throw new Error(`${repo} isn't a repository on Bitbucket Cloud (bitbucket.org/<workspace>/<repo>)`);
  return w;
}

const parsed = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** A build status's state as GitHub says it in a check rollup. Pure. */
function checkState(state: string): string {
  if (state === 'SUCCESSFUL') return 'SUCCESS';
  if (state === 'INPROGRESS') return 'PENDING';
  return 'FAILURE';
}

/** Whether Bitbucket can merge it, from its diffstat: a file in "merge conflict" means it can't. Unknown unasked. Pure. */
export function mergeStatesOf(diffstat?: any[]): { mergeable: string; mergeStateStatus: string } {
  if (!diffstat) return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
  if (diffstat.some((d) => String(d?.status ?? '') === 'merge conflict')) return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
}

/** A pull request in `gh pr list --json`'s words, with what details() found. Pure. */
export function prOf(pr: any, more: { head?: string; diffstat?: any[]; statuses?: any[] } = {}): Record<string, unknown> {
  const state = String(pr?.state ?? '');
  const from = pr?.source?.repository?.full_name;
  const to = pr?.destination?.repository?.full_name;
  const sum = (k: string) => (more.diffstat ?? []).reduce((n, d) => n + Number(d?.[k] ?? 0), 0);
  return {
    number: Number(pr?.id),
    title: String(pr?.title ?? ''),
    url: String(pr?.links?.html?.href ?? ''),
    body: String(pr?.description ?? pr?.summary?.raw ?? ''),
    state: state === 'OPEN' ? 'OPEN' : state === 'MERGED' ? 'MERGED' : 'CLOSED',
    headRefName: String(pr?.source?.branch?.name ?? ''),
    headRefOid: more.head ?? String(pr?.source?.commit?.hash ?? ''),
    createdAt: pr?.created_on,
    baseRefName: String(pr?.destination?.branch?.name ?? ''),
    isCrossRepository: !!from && !!to && from !== to,
    author: { login: String(pr?.author?.nickname ?? '') },
    ...mergeStatesOf(more.diffstat),
    isDraft: pr?.draft === true,
    statusCheckRollup: (more.statuses ?? []).map((s) => ({ __typename: 'StatusContext', context: String(s?.key ?? ''), state: checkState(String(s?.state ?? '')) })),
    labels: [],
    additions: sum('lines_added'),
    deletions: sum('lines_removed'),
    files: (more.diffstat ?? []).map((d) => ({ path: String(d?.new?.path ?? d?.old?.path ?? '') })),
  };
}

/** A build status as GitHub's REST API lists a commit status; who set it from its name ("… by <nickname>"). Pure. */
export function statusOf(s: any): Record<string, unknown> {
  const state = String(s?.state ?? '');
  const by = / by (\S+)$/.exec(String(s?.name ?? ''))?.[1] ?? '';
  return { state: state === 'SUCCESSFUL' ? 'success' : state === 'FAILED' ? 'failure' : state === 'STOPPED' ? 'error' : 'pending', context: String(s?.key ?? ''), description: s?.description ?? null, creator: { login: by }, created_at: s?.updated_on ?? s?.created_on ?? null, id: null };
}

const newestFirst = (a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));

/** A v<version> tag as `gh release list/view --json` says a release. Pure. */
export function tagOf(t: any): Record<string, unknown> {
  return { tagName: String(t?.name ?? ''), isDraft: false, publishedAt: t?.date ?? t?.target?.date ?? null, body: String(t?.message ?? ''), targetCommitish: String(t?.target?.hash ?? '') };
}
