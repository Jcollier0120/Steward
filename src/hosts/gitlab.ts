import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../run.ts';
import type { Answer, PrState, SourceHost } from './host.ts';

const MINUTE = 60_000;

/**
 * GitLab (gitlab.com, or a GitLab of your own), through the GitLab CLI (glab) as this PC has it signed in: its REST API
 * (v4) by `glab api`, so the Steward keeps no token. A repository is named as scm.ts's repoFromUrl names it,
 * `<host>/<group>/<project>` (gitlab.com/acme/app, gitlab.example.com/team/sub/app).
 *
 * Its answers are said in GitHub's words (host.ts): a merge request is a pull request (its iid its number, its source
 * branch its head), its commit statuses are GitHub's statuses (a CI job's too: GitLab lists each job as one), a release
 * GitHub's release, an issue GitHub's issue. What GitLab has no word for is said as GitHub would leave it: a release
 * is never a draft; a merge request's "files" and line counts come from its diffs, and its checks from its head's
 * commit statuses, asked of each one only when those fields are wanted.
 */
export class GitLab implements SourceHost {
  readonly kind = 'gitlab' as const;
  readonly name = 'GitLab';
  private readonly run: Runner;
  private readonly cwd: string;
  /** The GitLab asked when a call names no repository (whoAmI). */
  private readonly hostname: string;

  constructor(run: Runner, cwd: string, hostname = 'gitlab.com') {
    this.run = run;
    this.cwd = cwd;
    this.hostname = hostname;
  }

  /** One request: `glab api <endpoint> --hostname <host>`, a body as JSON from a file (--input), never inline. */
  private async api(hostname: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', endpoint: string, body?: Record<string, unknown>, timeoutMs = 2 * MINUTE): Promise<Answer> {
    const args = ['api', endpoint, '--hostname', hostname, ...(method === 'GET' ? [] : ['-X', method])];
    const what = `glab api ${method} ${endpoint}`;
    if (!body) return { ...(await this.run('glab', args, { cwd: this.cwd, timeoutMs })), what };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'steward-body-'));
    try {
      const file = path.join(dir, 'body.json');
      writeFileSync(file, JSON.stringify(body));
      return { ...(await this.run('glab', [...args, '--input', file, '-H', 'Content-Type: application/json'], { cwd: this.cwd, timeoutMs })), what };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A repository's request to its own GitLab, at `projects/<its path>/…`. */
  private project(repo: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', rest: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<Answer> {
    const { hostname, project } = whereIs(repo);
    return this.api(hostname, method, `projects/${encodeURIComponent(project)}${rest}`, body, timeoutMs);
  }

  async listPrs(repo: string, q: { state: PrState; head?: string; limit?: number; fields: string }): Promise<Answer> {
    const query = `state=${MR_STATE[q.state]}&per_page=${Math.min(q.limit ?? 30, 100)}${q.head ? `&source_branch=${encodeURIComponent(q.head)}` : ''}`;
    const a = await this.project(repo, 'GET', `/merge_requests?${query}`);
    if (a.code !== 0) return a;
    const mrs = parsed<any[]>(a.out) ?? [];
    const prs = [];
    for (const mr of mrs) {
      const more = await this.details(repo, mr, q.fields);
      if ('code' in more) return more;
      prs.push(prOf(mr, more));
    }
    return { ...a, out: JSON.stringify(prs) };
  }

  async viewPr(repo: string, which: number | string, fields: string): Promise<Answer> {
    if (typeof which === 'string' && !/^\d+$/.test(which)) {
      // By its branch: the open one from it, as gh pr view <branch> finds it.
      const a = await this.project(repo, 'GET', `/merge_requests?state=opened&source_branch=${encodeURIComponent(which)}&per_page=1`);
      if (a.code !== 0) return a;
      const [mr] = parsed<any[]>(a.out) ?? [];
      if (!mr) return { ...a, code: 1, out: '', err: `no pull requests found for branch "${which}"` };
      which = Number(mr.iid);
    }
    const a = await this.project(repo, 'GET', `/merge_requests/${which}`);
    if (a.code !== 0) return a;
    const mr = parsed<any>(a.out);
    const more = await this.details(repo, mr, fields);
    if ('code' in more) return more;
    return { ...a, out: JSON.stringify(prOf(mr, more)) };
  }

  /** What a merge request's list entry hasn't, asked only when `fields` wants it: its diffs, its head's statuses. */
  private async details(repo: string, mr: any, fields: string): Promise<Answer | { diffs?: any[]; statuses?: any[] }> {
    const want = new Set(fields.split(','));
    const out: { diffs?: any[]; statuses?: any[] } = {};
    if (want.has('files') || want.has('additions') || want.has('deletions')) {
      const d = await this.project(repo, 'GET', `/merge_requests/${mr.iid}/diffs?per_page=100`);
      if (d.code !== 0) return d;
      out.diffs = parsed<any[]>(d.out) ?? [];
    }
    if (want.has('statusCheckRollup') && mr.sha) {
      const s = await this.project(repo, 'GET', `/repository/commits/${mr.sha}/statuses?per_page=100`);
      if (s.code !== 0) return s;
      out.statuses = parsed<any[]>(s.out) ?? [];
    }
    return out;
  }

  async createPr(repo: string, p: { base: string; head: string; title: string; body: string }): Promise<Answer> {
    const a = await this.project(repo, 'POST', '/merge_requests', { source_branch: p.head, target_branch: p.base, title: p.title, description: p.body }, 5 * MINUTE);
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.web_url ?? ''}\n` } : a;
  }

  editPr(repo: string, n: number, p: { title?: string; body?: string; base?: string }): Promise<Answer> {
    return this.project(repo, 'PUT', `/merge_requests/${n}`, { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.body !== undefined ? { description: p.body } : {}), ...(p.base !== undefined ? { target_branch: p.base } : {}) });
  }

  commentPr(repo: string, n: number, body: string): Promise<Answer> {
    return this.project(repo, 'POST', `/merge_requests/${n}/notes`, { body });
  }

  /** Out of draft: GitLab's draft is its title's "Draft:" mark, taken off. */
  async readyPr(repo: string, n: number): Promise<Answer> {
    const a = await this.project(repo, 'GET', `/merge_requests/${n}`);
    if (a.code !== 0) return a;
    const title = String(parsed<any>(a.out)?.title ?? '');
    const ready = undraft(title);
    return ready === title ? a : this.project(repo, 'PUT', `/merge_requests/${n}`, { title: ready });
  }

  async closePr(repo: string, n: number, p: { comment?: string; deleteBranch?: boolean } = {}): Promise<Answer> {
    if (p.comment !== undefined) {
      const c = await this.commentPr(repo, n, p.comment);
      if (c.code !== 0) return c;
    }
    const a = await this.project(repo, 'PUT', `/merge_requests/${n}`, { state_event: 'close' });
    if (a.code !== 0 || !p.deleteBranch) return a;
    const branch = parsed<any>(a.out)?.source_branch;
    return branch ? this.project(repo, 'DELETE', `/repository/branches/${encodeURIComponent(branch)}`) : a;
  }

  /** Merged as the project merges (a merge commit, unless it says otherwise); only at `matchHead` (GitLab's sha), when given. */
  mergePr(repo: string, n: number, p: { matchHead?: string; deleteBranch?: boolean } = {}): Promise<Answer> {
    return this.project(repo, 'PUT', `/merge_requests/${n}/merge`, { ...(p.matchHead ? { sha: p.matchHead } : {}), ...(p.deleteBranch ? { should_remove_source_branch: true } : {}) }, 5 * MINUTE);
  }

  async statuses(repo: string, commit: string): Promise<Answer> {
    const a = await this.project(repo, 'GET', `/repository/commits/${commit}/statuses?per_page=100`);
    return a.code === 0 ? { ...a, out: JSON.stringify((parsed<any[]>(a.out) ?? []).map(statusOf).sort(newestFirst)) } : a;
  }

  setStatus(repo: string, commit: string, s: { state: 'success' | 'failure' | 'pending'; context: string; description: string }): Promise<Answer> {
    return this.project(repo, 'POST', `/statuses/${commit}`, { state: s.state === 'failure' ? 'failed' : s.state, name: s.context, description: s.description });
  }

  async listReleases(repo: string, _fields: string, limit = 100): Promise<Answer> {
    const a = await this.project(repo, 'GET', `/releases?per_page=${Math.min(limit, 100)}`);
    return a.code === 0 ? { ...a, out: JSON.stringify((parsed<any[]>(a.out) ?? []).map(releaseOf)) } : a;
  }

  async viewRelease(repo: string, tag: string, _fields: string): Promise<Answer> {
    const a = await this.project(repo, 'GET', `/releases/${encodeURIComponent(tag)}`);
    return a.code === 0 ? { ...a, out: JSON.stringify(releaseOf(parsed<any>(a.out))) } : a;
  }

  /** A release of `target`, tagged there; its notes the file's, else just its title (GitLab writes none of its own). */
  createRelease(repo: string, r: { tag: string; target: string; title: string; notesFile: string | null }): Promise<Answer> {
    const description = r.notesFile ? readFileSync(r.notesFile, 'utf8') : r.title;
    return this.project(repo, 'POST', '/releases', { tag_name: r.tag, ref: r.target, name: r.title, description }, 5 * MINUTE);
  }

  async downloadRelease(repo: string, tag: string, _d: { patterns: string[]; dir: string }): Promise<Answer> {
    return { code: 1, out: '', err: `a release's files can't be downloaded from GitLab yet (${repo} ${tag})`, what: `glab release download ${tag}` };
  }

  async listIssues(repo: string, q: { label: string; state: 'open' | 'closed'; limit?: number; fields: string }): Promise<Answer> {
    const a = await this.project(repo, 'GET', `/issues?labels=${encodeURIComponent(q.label)}&state=${q.state === 'open' ? 'opened' : 'closed'}&per_page=${Math.min(q.limit ?? 100, 100)}`);
    return a.code === 0 ? { ...a, out: JSON.stringify((parsed<any[]>(a.out) ?? []).map(issueOf)) } : a;
  }

  async createIssue(repo: string, i: { title: string; body: string; label: string }): Promise<Answer> {
    const a = await this.project(repo, 'POST', '/issues', { title: i.title, description: i.body, labels: i.label });
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.web_url ?? ''}\n` } : a;
  }

  editIssue(repo: string, n: number, p: { title?: string; body?: string; removeLabel?: string }): Promise<Answer> {
    return this.project(repo, 'PUT', `/issues/${n}`, { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.body !== undefined ? { description: p.body } : {}), ...(p.removeLabel !== undefined ? { remove_labels: p.removeLabel } : {}) });
  }

  commentIssue(repo: string, n: number, body: string): Promise<Answer> {
    return this.project(repo, 'POST', `/issues/${n}/notes`, { body });
  }

  /** Closed with its comment; GitLab keeps no reason, so "not planned" and "completed" close alike. */
  async closeIssue(repo: string, n: number, p: { reason: 'completed' | 'not planned'; comment: string }): Promise<Answer> {
    const c = await this.commentIssue(repo, n, p.comment);
    if (c.code !== 0) return c;
    return this.project(repo, 'PUT', `/issues/${n}`, { state_event: 'close' });
  }

  createLabel(repo: string, label: string, l: { color: string; description: string }): Promise<Answer> {
    return this.project(repo, 'POST', '/labels', { name: label, color: `#${l.color.replace(/^#/, '')}`, description: l.description });
  }

  async whoAmI(): Promise<Answer> {
    const a = await this.api(this.hostname, 'GET', 'user');
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.username ?? ''}\n` } : a;
  }

  prRef(pr: { number: number }): string {
    return `refs/merge-requests/${pr.number}/head`;
  }

  releaseUrl(repo: string, tag: string): string {
    return `https://${repo}/-/releases/${encodeURIComponent(tag)}`;
  }
}

const MR_STATE: Record<PrState, string> = { open: 'opened', closed: 'closed', merged: 'merged' };

/** A repository's GitLab and its project's path: gitlab.com/acme/app is gitlab.com's acme/app. Pure. */
export function whereIs(repo: string): { hostname: string; project: string } {
  const i = repo.indexOf('/');
  return { hostname: repo.slice(0, i), project: repo.slice(i + 1) };
}

const parsed = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** A title without GitLab's draft mark ("Draft:", "[Draft]", "(Draft)", the older "WIP:"). Pure. */
export const undraft = (title: string) => title.replace(/^\s*(?:\[draft\]|\(draft\)|draft:|\[wip\]|wip:)\s*/i, '');

/** A commit status's state as GitHub says it in a check rollup. Pure. */
function checkState(status: string): string {
  if (status === 'success' || status === 'skipped' || status === 'manual') return 'SUCCESS';
  if (['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'].includes(status)) return 'PENDING';
  return 'FAILURE';
}

/** Whether GitLab can merge it, as GitHub's mergeable and mergeStateStatus say. Pure. */
export function mergeStatesOf(mr: any): { mergeable: string; mergeStateStatus: string } {
  const detailed = String(mr?.detailed_merge_status ?? '');
  const old = String(mr?.merge_status ?? '');
  if (mr?.has_conflicts === true || detailed === 'conflict' || detailed === 'broken_status') return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  if (['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(detailed) || (!detailed && ['unchecked', 'checking', 'cannot_be_merged_recheck'].includes(old))) return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
  const state = detailed === 'mergeable' ? 'CLEAN' : detailed === 'need_rebase' ? 'BEHIND' : detailed === 'draft_status' ? 'DRAFT' : ['ci_still_running', ''].includes(detailed) ? 'UNKNOWN' : 'BLOCKED';
  return { mergeable: 'MERGEABLE', mergeStateStatus: state };
}

/** A merge request as a pull request in `gh pr list --json`'s words, with what details() found. Pure. */
export function prOf(mr: any, more: { diffs?: any[]; statuses?: any[] } = {}): Record<string, unknown> {
  const lines = (sign: '+' | '-') => (more.diffs ?? []).reduce((n, d) => n + String(d?.diff ?? '').split('\n').filter((l) => l.startsWith(sign)).length, 0);
  return {
    number: Number(mr?.iid),
    title: String(mr?.title ?? ''),
    url: String(mr?.web_url ?? ''),
    body: String(mr?.description ?? ''),
    state: mr?.state === 'opened' ? 'OPEN' : mr?.state === 'merged' ? 'MERGED' : 'CLOSED',
    headRefName: String(mr?.source_branch ?? ''),
    headRefOid: String(mr?.sha ?? ''),
    createdAt: mr?.created_at,
    baseRefName: String(mr?.target_branch ?? ''),
    isCrossRepository: mr?.source_project_id !== undefined && mr?.source_project_id !== mr?.target_project_id,
    author: { login: String(mr?.author?.username ?? '') },
    ...mergeStatesOf(mr),
    isDraft: mr?.draft === true || mr?.work_in_progress === true,
    statusCheckRollup: (more.statuses ?? []).map((s) => ({ __typename: 'StatusContext', context: String(s?.name ?? ''), state: checkState(String(s?.status ?? '')) })),
    labels: (Array.isArray(mr?.labels) ? mr.labels : []).map((l: unknown) => ({ name: typeof l === 'string' ? l : String((l as any)?.name ?? '') })),
    additions: lines('+'),
    deletions: lines('-'),
    files: (more.diffs ?? []).map((d) => ({ path: String(d?.new_path ?? d?.old_path ?? '') })),
  };
}

/** A commit status as GitHub's REST API lists one. Pure. */
export function statusOf(s: any): Record<string, unknown> {
  const status = String(s?.status ?? '');
  const state = status === 'success' ? 'success' : status === 'failed' ? 'failure' : status === 'canceled' ? 'error' : 'pending';
  return { state, context: String(s?.name ?? ''), description: s?.description ?? null, creator: { login: String(s?.author?.username ?? '') }, created_at: s?.created_at ?? null, id: s?.id ?? null };
}

const newestFirst = (a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || Number(b.id ?? 0) - Number(a.id ?? 0);

/** A release as `gh release list/view --json` says one: never a draft (GitLab has none). Pure. */
export function releaseOf(r: any): Record<string, unknown> {
  return { tagName: String(r?.tag_name ?? ''), name: String(r?.name ?? ''), isDraft: false, publishedAt: r?.released_at ?? null, body: String(r?.description ?? ''), targetCommitish: String(r?.commit?.id ?? '') };
}

/** An issue as `gh issue list --json` says one. Pure. */
export function issueOf(i: any): Record<string, unknown> {
  return { number: Number(i?.iid), title: String(i?.title ?? ''), url: String(i?.web_url ?? ''), body: String(i?.description ?? '') };
}
