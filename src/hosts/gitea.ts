import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../run.ts';
import type { Answer, PrState, SourceHost } from './host.ts';

const MINUTE = 60_000;
/** Gitea's most a page holds, by default (MAX_RESPONSE_ITEMS). */
const PAGE = 50;

/**
 * Gitea and Forgejo (gitea.com, codeberg.org, or one of your own), through the Gitea CLI (tea) as this PC has it signed
 * in: their REST API (v1, the same on both) by `tea api`, with the tea login for the repository's own server, so the
 * Steward keeps no token. A repository is named as scm.ts's repoFromUrl names it, `<host>/<owner>/<name>`
 * (codeberg.org/acme/app).
 *
 * Its answers are said in GitHub's words (host.ts), which Gitea's API mostly already speaks: a pull request's checks
 * are its head's combined commit status, a draft is Gitea's "WIP:" title mark, a release a Gitea release. `tea api`
 * exits 0 whatever the server answers, so each request asks for the status line too (-i) and an HTTP error is
 * answered as a failure.
 */
export class Gitea implements SourceHost {
  readonly kind = 'gitea' as const;
  readonly name = 'Gitea';
  private readonly run: Runner;
  private readonly cwd: string;
  /** The server asked: the repository's host (codeberg.org). */
  private readonly hostname: string;

  constructor(run: Runner, cwd: string, hostname: string) {
    this.run = run;
    this.cwd = cwd;
    this.hostname = hostname;
  }

  /**
   * One request: `tea api --login <its login> -i [-X <method>] [-d @<file>] <endpoint>`, the endpoint below /api/v1 (or a
   * whole URL on the same server), a body as JSON from a file, never inline. `out` is set: the response written there.
   */
  private async api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', endpoint: string, body?: unknown, o: { timeoutMs?: number; out?: string } = {}): Promise<Answer> {
    const what = `tea api ${method} ${endpoint}`;
    const login = await loginFor(this.run, this.cwd, this.hostname);
    if (!login) return { code: 1, out: '', err: `the Gitea CLI has no login for ${this.hostname}: tea login add --url https://${this.hostname}`, what };
    const args = ['api', '--login', login, '-i', ...(method === 'GET' ? [] : ['-X', method]), ...(o.out ? ['-o', o.out] : [])];
    const dir = body === undefined ? null : mkdtempSync(path.join(os.tmpdir(), 'steward-body-'));
    try {
      if (dir) writeFileSync(path.join(dir, 'body.json'), JSON.stringify(body));
      const r = await this.run('tea', [...args, ...(dir ? ['-d', `@${path.join(dir, 'body.json')}`] : []), endpoint], { cwd: this.cwd, timeoutMs: o.timeoutMs ?? 2 * MINUTE });
      return { ...answered(r), what };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A repository's request, at repos/<owner>/<name>/…. */
  private repo(repo: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', rest: string, body?: unknown, timeoutMs?: number): Promise<Answer> {
    const w = where(repo);
    return this.api(method, `repos/${encodeURIComponent(w.owner)}/${encodeURIComponent(w.name)}${rest}`, body, { timeoutMs });
  }

  /** Up to `want` items of a list, a page at a time (`rest` has a query already). */
  private async pages(repo: string, rest: string, want: number): Promise<Answer & { items: any[] }> {
    const items: any[] = [];
    let last: Answer = { code: 0, out: '[]', err: '', what: '' };
    for (let page = 1; items.length < want; page++) {
      last = await this.repo(repo, 'GET', `${rest}${rest.endsWith('?') ? '' : '&'}limit=${PAGE}&page=${page}`);
      if (last.code !== 0) return { ...last, items };
      const got = parsed<any[]>(last.out) ?? [];
      items.push(...got);
      if (got.length < PAGE) break;
    }
    return { ...last, items: items.slice(0, want) };
  }

  async listPrs(repo: string, q: { state: PrState; head?: string; limit?: number; fields: string }): Promise<Answer> {
    const limit = q.limit ?? 30;
    // Gitea lists pull requests open or closed (merged among them), and has no branch filter: a branch's are looked
    // for among the most recent.
    const a = await this.pages(repo, `/pulls?state=${q.state === 'open' ? 'open' : 'closed'}&sort=recentupdate`, q.head ? Math.max(limit, 4 * PAGE) : limit);
    if (a.code !== 0) return a;
    const prs = [];
    for (const pr of a.items.filter((p) => (q.state === 'merged' ? p?.merged === true : q.state === 'closed' ? p?.merged !== true : true) && (!q.head || p?.head?.ref === q.head)).slice(0, limit)) {
      const more = await this.details(repo, pr, q.fields);
      if ('code' in more) return more;
      prs.push(prOf(pr, more));
    }
    return { ...a, out: JSON.stringify(prs) };
  }

  async viewPr(repo: string, which: number | string, fields: string): Promise<Answer> {
    let pr: any;
    if (typeof which === 'string' && !/^\d+$/.test(which)) {
      // By its branch: the open one from it, as gh pr view <branch> finds it.
      const a = await this.pages(repo, '/pulls?state=open&sort=recentupdate', 4 * PAGE);
      if (a.code !== 0) return a;
      pr = a.items.find((p) => p?.head?.ref === which);
      if (!pr) return { ...a, code: 1, out: '', err: `no pull requests found for branch "${which}"` };
    } else {
      const a = await this.repo(repo, 'GET', `/pulls/${which}`);
      if (a.code !== 0) return a;
      pr = parsed<any>(a.out);
    }
    const more = await this.details(repo, pr, fields);
    if ('code' in more) return more;
    return { code: 0, out: JSON.stringify(prOf(pr, more)), err: '', what: `tea api GET pulls/${pr?.number}` };
  }

  /** What a pull request's list entry hasn't, asked only when `fields` wants it: its files, its head's checks. */
  private async details(repo: string, pr: any, fields: string): Promise<Answer | { files?: string[]; statuses?: any[] }> {
    const want = new Set(fields.split(','));
    const out: { files?: string[]; statuses?: any[] } = {};
    if (want.has('files')) {
      const f = await this.pages(repo, `/pulls/${pr.number}/files?`, 1000);
      if (f.code !== 0) return f;
      out.files = f.items.map((x) => String(x?.filename ?? '')).filter(Boolean);
    }
    if (want.has('statusCheckRollup') && pr?.head?.sha) {
      const s = await this.repo(repo, 'GET', `/commits/${pr.head.sha}/status`);
      if (s.code !== 0) return s;
      out.statuses = parsed<any>(s.out)?.statuses ?? [];
    }
    return out;
  }

  async createPr(repo: string, p: { base: string; head: string; title: string; body: string }): Promise<Answer> {
    const a = await this.repo(repo, 'POST', '/pulls', { head: p.head, base: p.base, title: p.title, body: p.body }, 5 * MINUTE);
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.html_url ?? ''}\n` } : a;
  }

  editPr(repo: string, n: number, p: { title?: string; body?: string; base?: string }): Promise<Answer> {
    return this.repo(repo, 'PATCH', `/pulls/${n}`, { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.body !== undefined ? { body: p.body } : {}), ...(p.base !== undefined ? { base: p.base } : {}) });
  }

  commentPr(repo: string, n: number, body: string): Promise<Answer> {
    return this.repo(repo, 'POST', `/issues/${n}/comments`, { body });
  }

  /** Out of draft: Gitea's draft is its title's "WIP:" mark, taken off. */
  async readyPr(repo: string, n: number): Promise<Answer> {
    const a = await this.repo(repo, 'GET', `/pulls/${n}`);
    if (a.code !== 0) return a;
    const title = String(parsed<any>(a.out)?.title ?? '');
    const ready = unwip(title);
    return ready === title ? a : this.repo(repo, 'PATCH', `/pulls/${n}`, { title: ready });
  }

  async closePr(repo: string, n: number, p: { comment?: string; deleteBranch?: boolean } = {}): Promise<Answer> {
    if (p.comment !== undefined) {
      const c = await this.commentPr(repo, n, p.comment);
      if (c.code !== 0) return c;
    }
    const a = await this.repo(repo, 'PATCH', `/pulls/${n}`, { state: 'closed' });
    if (a.code !== 0 || !p.deleteBranch) return a;
    const pr = parsed<any>(a.out);
    // A fork's branch is its own to keep.
    const branch = pr?.head?.repo?.full_name && pr?.base?.repo?.full_name && pr.head.repo.full_name !== pr.base.repo.full_name ? null : pr?.head?.ref;
    return branch ? this.repo(repo, 'DELETE', `/branches/${encodeURIComponent(branch)}`) : a;
  }

  /** Merged with a merge commit, only at `matchHead` (Gitea's head_commit_id), when given. */
  mergePr(repo: string, n: number, p: { matchHead?: string; deleteBranch?: boolean } = {}): Promise<Answer> {
    return this.repo(repo, 'POST', `/pulls/${n}/merge`, { Do: 'merge', ...(p.matchHead ? { head_commit_id: p.matchHead } : {}), ...(p.deleteBranch ? { delete_branch_after_merge: true } : {}) }, 5 * MINUTE);
  }

  async statuses(repo: string, commit: string): Promise<Answer> {
    const a = await this.pages(repo, `/commits/${commit}/statuses?sort=newest`, 100);
    return a.code === 0 ? { ...a, out: JSON.stringify(a.items.map(statusOf).sort(newestFirst)) } : a;
  }

  setStatus(repo: string, commit: string, s: { state: 'success' | 'failure' | 'pending'; context: string; description: string }): Promise<Answer> {
    return this.repo(repo, 'POST', `/statuses/${commit}`, { state: s.state, context: s.context, description: s.description });
  }

  async listReleases(repo: string, _fields: string, limit = 100): Promise<Answer> {
    const a = await this.pages(repo, '/releases?', limit);
    return a.code === 0 ? { ...a, out: JSON.stringify(a.items.map(releaseOf)) } : a;
  }

  async viewRelease(repo: string, tag: string, _fields: string): Promise<Answer> {
    const a = await this.repo(repo, 'GET', `/releases/tags/${encodeURIComponent(tag)}`);
    if (a.code !== 0) return /\b404\b/.test(a.err) ? { ...a, err: `release not found: ${tag}` } : a;
    return { ...a, out: JSON.stringify(releaseOf(parsed<any>(a.out))) };
  }

  /** A release of `target`, tagged there; its notes the file's, else just its title (Gitea writes none of its own). */
  createRelease(repo: string, r: { tag: string; target: string; title: string; notesFile: string | null }): Promise<Answer> {
    const body = r.notesFile ? readFileSync(r.notesFile, 'utf8') : r.title;
    return this.repo(repo, 'POST', '/releases', { tag_name: r.tag, target_commitish: r.target, name: r.title, body }, 5 * MINUTE);
  }

  /** A release's files whose names match `patterns` (as gh's --pattern: * and ?), into `dir`, replacing any there. */
  async downloadRelease(repo: string, tag: string, d: { patterns: string[]; dir: string }): Promise<Answer> {
    const a = await this.repo(repo, 'GET', `/releases/tags/${encodeURIComponent(tag)}`);
    if (a.code !== 0) return a;
    const wanted = d.patterns.map(globOf);
    const assets = ((parsed<any>(a.out)?.assets ?? []) as any[]).filter((x) => wanted.some((re) => re.test(String(x?.name ?? ''))));
    if (!assets.length) return { ...a, code: 1, out: '', err: `no assets match the file pattern in ${tag}` };
    mkdirSync(d.dir, { recursive: true });
    for (const x of assets) {
      const file = path.join(d.dir, path.basename(String(x.name)));
      rmSync(file, { force: true });
      const got = await this.api('GET', String(x.browser_download_url), undefined, { out: file, timeoutMs: 10 * MINUTE });
      if (got.code !== 0) return got;
    }
    return { ...a, out: '' };
  }

  async listIssues(repo: string, q: { label: string; state: 'open' | 'closed'; limit?: number; fields: string }): Promise<Answer> {
    const a = await this.pages(repo, `/issues?type=issues&state=${q.state}&labels=${encodeURIComponent(q.label)}`, q.limit ?? 100);
    return a.code === 0 ? { ...a, out: JSON.stringify(a.items.map(issueOf)) } : a;
  }

  /** A label's id, which Gitea's issues are labelled by. */
  private async labelId(repo: string, label: string): Promise<Answer & { id?: number }> {
    const a = await this.pages(repo, '/labels?', 1000);
    const id = a.items.find((l) => String(l?.name ?? '').toLowerCase() === label.toLowerCase())?.id;
    return a.code !== 0 ? a : id === undefined ? { ...a, code: 1, out: '', err: `label "${label}" not found in ${repo}` } : { ...a, id: Number(id) };
  }

  async createIssue(repo: string, i: { title: string; body: string; label: string }): Promise<Answer> {
    const l = await this.labelId(repo, i.label);
    if (l.code !== 0) return l;
    const a = await this.repo(repo, 'POST', '/issues', { title: i.title, body: i.body, labels: [l.id] });
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.html_url ?? ''}\n` } : a;
  }

  async editIssue(repo: string, n: number, p: { title?: string; body?: string; removeLabel?: string }): Promise<Answer> {
    let a: Answer | null = null;
    if (p.title !== undefined || p.body !== undefined) {
      a = await this.repo(repo, 'PATCH', `/issues/${n}`, { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.body !== undefined ? { body: p.body } : {}) });
      if (a.code !== 0) return a;
    }
    if (p.removeLabel !== undefined) {
      const l = await this.labelId(repo, p.removeLabel);
      if (l.code !== 0) return l;
      a = await this.repo(repo, 'DELETE', `/issues/${n}/labels/${l.id}`);
    }
    return a ?? { code: 0, out: '', err: '', what: `tea api PATCH issues/${n}` };
  }

  commentIssue(repo: string, n: number, body: string): Promise<Answer> {
    return this.repo(repo, 'POST', `/issues/${n}/comments`, { body });
  }

  /** Closed with its comment; Gitea keeps no reason, so "not planned" and "completed" close alike. */
  async closeIssue(repo: string, n: number, p: { reason: 'completed' | 'not planned'; comment: string }): Promise<Answer> {
    const c = await this.commentIssue(repo, n, p.comment);
    if (c.code !== 0) return c;
    return this.repo(repo, 'PATCH', `/issues/${n}`, { state: 'closed' });
  }

  createLabel(repo: string, label: string, l: { color: string; description: string }): Promise<Answer> {
    return this.repo(repo, 'POST', '/labels', { name: label, color: `#${l.color.replace(/^#/, '')}`, description: l.description });
  }

  async whoAmI(): Promise<Answer> {
    const a = await this.api('GET', 'user');
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.login ?? ''}\n` } : a;
  }

  prRef(pr: { number: number }): string {
    return `refs/pull/${pr.number}/head`;
  }

  releaseUrl(repo: string, tag: string): string {
    return `https://${repo}/releases/tag/${encodeURIComponent(tag)}`;
  }
}

/** The tea logins on this PC (`tea logins list --output json`), by server, as each runner last read them (an hour). */
const logins = new WeakMap<Runner, { at: number; byHost: Map<string, string> }>();

/** The tea login for a server: the one whose URL is on its host (the default one first, when there are two). */
async function loginFor(run: Runner, cwd: string, hostname: string): Promise<string | null> {
  let known = logins.get(run);
  if (!known || Date.now() - known.at > 60 * MINUTE) {
    const r = await run('tea', ['logins', 'list', '--output', 'json'], { cwd, timeoutMs: MINUTE }).catch(() => null);
    known = { at: Date.now(), byHost: r?.code === 0 ? teaLogins(r.out) : new Map() };
    if (r?.code === 0) logins.set(run, known);
  }
  return known.byHost.get(hostname.toLowerCase()) ?? null;
}

/** `tea logins list --output json` as each server's login name, the default login first. Pure. */
export function teaLogins(out: string): Map<string, string> {
  const rows = parsed<any[]>(out) ?? [];
  const field = (row: any, name: string) => String(Object.entries(row ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ?? '');
  const byHost = new Map<string, string>();
  for (const row of [...rows].sort((a, b) => Number(field(b, 'default') === 'true') - Number(field(a, 'default') === 'true'))) {
    let host = '';
    try {
      host = new URL(field(row, 'url')).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host && !byHost.has(host)) byHost.set(host, field(row, 'name'));
  }
  return byHost;
}

/**
 * What tea answered, as a command's answer: `tea api -i` writes the status line and headers to stderr and exits 0 on an
 * HTTP error, so a 4xx or 5xx is made a failure, its message (Gitea's {"message"}) the error. Pure.
 */
export function answered(r: { code: number; out: string; err: string }): { code: number; out: string; err: string } {
  const status = /^HTTP\/[\d.]+ (\d{3})(.*)$/m.exec(r.err);
  if (r.code !== 0 || !status) return r;
  if (Number(status[1]) < 400) return { ...r, err: '' };
  const message = parsed<any>(r.out)?.message;
  return { code: 1, out: '', err: `HTTP ${status[1]}${status[2]}${message ? `: ${message}` : r.out.trim() ? `: ${r.out.trim().slice(0, 300)}` : ''}` };
}

/** A repository's server, owner and name: codeberg.org/acme/app. Null when it isn't named so. Pure. */
export function whereGitea(repo: string): { hostname: string; owner: string; name: string } | null {
  const m = /^([^/]+\.[^/]+)\/([^/]+)\/([^/]+)$/.exec(repo);
  return m ? { hostname: m[1].toLowerCase(), owner: m[2], name: m[3] } : null;
}

function where(repo: string) {
  const w = whereGitea(repo);
  if (!w) throw new Error(`${repo} isn't named as a repository on a Gitea (<host>/<owner>/<name>)`);
  return w;
}

const parsed = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** gh's --pattern as a regular expression: * any run, ? any one. Pure. */
const globOf = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** A title without Gitea's draft mark ("WIP:", "[WIP]", as Gitea's settings name them by default). Pure. */
export const unwip = (title: string) => title.replace(/^\s*(?:wip:|\[wip\])\s*/i, '');

/** A commit status's state as GitHub says it in a check rollup. Pure. */
function checkState(status: string): string {
  if (status === 'success') return 'SUCCESS';
  if (status === 'pending' || status === '') return 'PENDING';
  return 'FAILURE';
}

/** Whether Gitea can merge it, as GitHub's mergeable and mergeStateStatus say: Gitea says only yes or no. Pure. */
export function mergeStatesOf(pr: any): { mergeable: string; mergeStateStatus: string } {
  if (pr?.mergeable === true) return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  if (pr?.mergeable === false) return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
}

/** A pull request in `gh pr list --json`'s words, with what details() found. Pure. */
export function prOf(pr: any, more: { files?: string[]; statuses?: any[] } = {}): Record<string, unknown> {
  const head = pr?.head?.repo?.full_name;
  const base = pr?.base?.repo?.full_name;
  return {
    number: Number(pr?.number),
    title: String(pr?.title ?? ''),
    url: String(pr?.html_url ?? ''),
    body: String(pr?.body ?? ''),
    state: pr?.merged === true ? 'MERGED' : pr?.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: String(pr?.head?.ref ?? ''),
    headRefOid: String(pr?.head?.sha ?? ''),
    baseRefName: String(pr?.base?.ref ?? ''),
    isCrossRepository: !!head && !!base && head !== base,
    author: { login: String(pr?.user?.login ?? '') },
    ...mergeStatesOf(pr),
    isDraft: pr?.draft === true || unwip(String(pr?.title ?? '')) !== String(pr?.title ?? ''),
    statusCheckRollup: (more.statuses ?? []).map((s) => ({ __typename: 'StatusContext', context: String(s?.context ?? ''), state: checkState(String(s?.status ?? s?.state ?? '')) })),
    labels: (Array.isArray(pr?.labels) ? pr.labels : []).map((l: any) => ({ name: String(l?.name ?? '') })),
    additions: Number(pr?.additions ?? 0),
    deletions: Number(pr?.deletions ?? 0),
    files: (more.files ?? []).map((p) => ({ path: p })),
  };
}

/** A commit status as GitHub's REST API lists one (Gitea says its state as "status"). Pure. */
export function statusOf(s: any): Record<string, unknown> {
  const state = String(s?.status ?? s?.state ?? '');
  return { state: ['success', 'failure', 'error', 'pending'].includes(state) ? state : state === 'warning' ? 'failure' : 'pending', context: String(s?.context ?? ''), description: s?.description ?? null, creator: { login: String(s?.creator?.login ?? '') }, created_at: s?.created_at ?? null, id: s?.id ?? null };
}

const newestFirst = (a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || Number(b.id ?? 0) - Number(a.id ?? 0);

/** A release as `gh release list/view --json` says one. Pure. */
export function releaseOf(r: any): Record<string, unknown> {
  return { tagName: String(r?.tag_name ?? ''), name: String(r?.name ?? ''), isDraft: r?.draft === true, publishedAt: r?.published_at ?? null, body: String(r?.body ?? ''), targetCommitish: String(r?.target_commitish ?? '') };
}

/** An issue as `gh issue list --json` says one. Pure. */
export function issueOf(i: any): Record<string, unknown> {
  return { number: Number(i?.number), title: String(i?.title ?? ''), url: String(i?.html_url ?? ''), body: String(i?.body ?? '') };
}
