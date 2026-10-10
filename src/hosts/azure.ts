import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../run.ts';
import type { Answer, PrState, SourceHost } from './host.ts';

const MINUTE = 60_000;
const API = 'api-version=7.1';
/** Azure DevOps' application id: `az rest --resource` asks Microsoft Entra for a token to it, so no token is kept. */
const DEVOPS = '499b84ac-1321-427f-aa17-267ca6975798';
const NO_COMMIT = '0000000000000000000000000000000000000000';

/**
 * Azure DevOps (Azure Repos), through the Azure CLI (az) as this PC has it signed in (`az login`): its REST API (7.1) by
 * `az rest`, which gets a token for Azure DevOps from the signed-in account, so the Steward keeps none. A repository is
 * named as scm.ts's repoFromUrl names its clone's origin: dev.azure.com/<org>/<project>/_git/<repo>, its SSH form
 * ssh.dev.azure.com/v3/<org>/<project>/<repo>, or the older <org>.visualstudio.com/<project>/_git/<repo>.
 *
 * Its answers are said in GitHub's words (host.ts). A pull request's number is its id, its checks the statuses on it
 * and on its head commit (the vouch among them as "steward/tested": genre steward, name tested), its files those of its
 * last iteration (no line counts: Azure DevOps gives none, so a pull request's size reads as nothing). It is merged by
 * completing it at its head (lastMergeSourceCommit), with a merge commit. Azure DevOps has no releases: a release is an
 * annotated v<version> tag, its message the notes, and the releases listed are those tags. It has issues only as work
 * items, which the Steward doesn't file yet.
 */
export class AzureDevOps implements SourceHost {
  readonly kind = 'azure' as const;
  readonly name = 'Azure DevOps';
  private readonly run: Runner;
  private readonly cwd: string;
  /** The organization asked when a call names no repository (whoAmI): https://dev.azure.com/<org>. */
  private readonly org: string;

  constructor(run: Runner, cwd: string, org: string) {
    this.run = run;
    this.cwd = cwd;
    this.org = org;
  }

  /** One request: `az rest` to a URL, a body as JSON from a file, never inline. */
  private async rest(method: 'get' | 'post' | 'patch', url: string, body?: unknown, timeoutMs = 2 * MINUTE): Promise<Answer> {
    const args = ['rest', '--method', method, '--url', url, '--resource', DEVOPS, '--output', 'json'];
    const what = `az rest ${method.toUpperCase()} ${url}`;
    if (body === undefined) return { ...(await this.run('az', args, { cwd: this.cwd, timeoutMs })), what };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'steward-body-'));
    try {
      const file = path.join(dir, 'body.json');
      writeFileSync(file, JSON.stringify(body));
      return { ...(await this.run('az', [...args, '--body', `@${file}`, '--headers', 'Content-Type=application/json'], { cwd: this.cwd, timeoutMs })), what };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A repository's request, at <org>/<project>/_apis/git/repositories/<repo>/…. */
  private git(repo: string, method: 'get' | 'post' | 'patch', rest: string, body?: unknown, timeoutMs?: number): Promise<Answer> {
    const w = where(repo);
    const sep = rest.includes('?') ? '&' : '?';
    return this.rest(method, `${w.base}/${encodeURIComponent(w.project)}/_apis/git/repositories/${encodeURIComponent(w.repo)}${rest}${sep}${API}`, body, timeoutMs);
  }

  async listPrs(repo: string, q: { state: PrState; head?: string; limit?: number; fields: string }): Promise<Answer> {
    const query = `?searchCriteria.status=${PR_STATUS[q.state]}&$top=${Math.min(q.limit ?? 30, 100)}${q.head ? `&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${q.head}`)}` : ''}`;
    const a = await this.git(repo, 'get', `/pullrequests${query}`);
    if (a.code !== 0) return a;
    const prs = [];
    for (const pr of valueOf(a.out)) {
      const more = await this.details(repo, pr, q.fields);
      if ('code' in more) return more;
      prs.push(prOf(repo, pr, more));
    }
    return { ...a, out: JSON.stringify(prs) };
  }

  async viewPr(repo: string, which: number | string, fields: string): Promise<Answer> {
    if (typeof which === 'string' && !/^\d+$/.test(which)) {
      // By its branch: the active one from it, as gh pr view <branch> finds it.
      const a = await this.git(repo, 'get', `/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${which}`)}&$top=1`);
      if (a.code !== 0) return a;
      const [pr] = valueOf(a.out);
      if (!pr) return { ...a, code: 1, out: '', err: `no pull requests found for branch "${which}"` };
      which = Number(pr.pullRequestId);
    }
    const a = await this.git(repo, 'get', `/pullrequests/${which}`);
    if (a.code !== 0) return a;
    const pr = parsed<any>(a.out);
    const more = await this.details(repo, pr, fields);
    if ('code' in more) return more;
    return { ...a, out: JSON.stringify(prOf(repo, pr, more)) };
  }

  /** What a pull request's list entry hasn't, asked only when `fields` wants it: its files, its checks. */
  private async details(repo: string, pr: any, fields: string): Promise<Answer | { files?: string[]; statuses?: any[] }> {
    const want = new Set(fields.split(','));
    const out: { files?: string[]; statuses?: any[] } = {};
    if (want.has('files')) {
      const its = await this.git(repo, 'get', `/pullrequests/${pr.pullRequestId}/iterations`);
      if (its.code !== 0) return its;
      const last = valueOf(its.out).at(-1)?.id;
      out.files = [];
      if (last) {
        const c = await this.git(repo, 'get', `/pullrequests/${pr.pullRequestId}/iterations/${last}/changes?$top=1000`);
        if (c.code !== 0) return c;
        out.files = ((parsed<any>(c.out)?.changeEntries ?? []) as any[]).map((x) => String(x?.item?.path ?? '').replace(/^\//, '')).filter(Boolean);
      }
    }
    if (want.has('statusCheckRollup')) {
      const s = await this.git(repo, 'get', `/pullrequests/${pr.pullRequestId}/statuses`);
      if (s.code !== 0) return s;
      out.statuses = valueOf(s.out);
      const head = pr?.lastMergeSourceCommit?.commitId;
      if (head) {
        const c = await this.git(repo, 'get', `/commits/${head}/statuses?latestOnly=true`);
        if (c.code !== 0) return c;
        out.statuses.push(...valueOf(c.out));
      }
    }
    return out;
  }

  async createPr(repo: string, p: { base: string; head: string; title: string; body: string }): Promise<Answer> {
    const a = await this.git(repo, 'post', '/pullrequests', { sourceRefName: `refs/heads/${p.head}`, targetRefName: `refs/heads/${p.base}`, title: p.title, description: p.body }, 5 * MINUTE);
    return a.code === 0 ? { ...a, out: `${webUrl(repo, Number(parsed<any>(a.out)?.pullRequestId))}\n` } : a;
  }

  editPr(repo: string, n: number, p: { title?: string; body?: string; base?: string }): Promise<Answer> {
    return this.git(repo, 'patch', `/pullrequests/${n}`, { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.body !== undefined ? { description: p.body } : {}), ...(p.base !== undefined ? { targetRefName: `refs/heads/${p.base}` } : {}) });
  }

  commentPr(repo: string, n: number, body: string): Promise<Answer> {
    return this.git(repo, 'post', `/pullrequests/${n}/threads`, { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 'closed' });
  }

  readyPr(repo: string, n: number): Promise<Answer> {
    return this.git(repo, 'patch', `/pullrequests/${n}`, { isDraft: false });
  }

  async closePr(repo: string, n: number, p: { comment?: string; deleteBranch?: boolean } = {}): Promise<Answer> {
    if (p.comment !== undefined) {
      const c = await this.commentPr(repo, n, p.comment);
      if (c.code !== 0) return c;
    }
    const a = await this.git(repo, 'patch', `/pullrequests/${n}`, { status: 'abandoned' });
    if (a.code !== 0 || !p.deleteBranch) return a;
    const pr = parsed<any>(a.out);
    const branch = String(pr?.sourceRefName ?? '');
    const at = pr?.lastMergeSourceCommit?.commitId;
    return branch && at ? this.git(repo, 'post', '/refs', [{ name: branch, oldObjectId: at, newObjectId: NO_COMMIT }]) : a;
  }

  /**
   * Completed with a merge commit, at `matchHead`: Azure DevOps completes a pull request only at the head it is told
   * (lastMergeSourceCommit), so one pushed to since is refused. With none given, its head as it is now. Azure DevOps
   * completes it in the background: it is asked again (a minute at most) until it is, so what follows finds the merge
   * on the branch; one a policy holds, or still not completed, is answered as a failure.
   */
  async mergePr(repo: string, n: number, p: { matchHead?: string; deleteBranch?: boolean } = {}, waitMs = 5_000): Promise<Answer> {
    let head = p.matchHead;
    if (!head) {
      const a = await this.git(repo, 'get', `/pullrequests/${n}`);
      if (a.code !== 0) return a;
      head = parsed<any>(a.out)?.lastMergeSourceCommit?.commitId;
    }
    let a = await this.git(repo, 'patch', `/pullrequests/${n}`, { status: 'completed', lastMergeSourceCommit: { commitId: head }, completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: !!p.deleteBranch } }, 5 * MINUTE);
    for (let i = 0; a.code === 0 && i < 12; i++) {
      const pr = parsed<any>(a.out);
      if (pr?.status === 'completed') return a;
      if (pr?.status === 'abandoned' || pr?.mergeStatus === 'conflicts' || pr?.mergeStatus === 'rejectedByPolicy' || pr?.mergeStatus === 'failure') return { ...a, code: 1, err: `pull request ${n} wasn't completed: ${pr?.mergeFailureMessage ?? pr?.mergeStatus ?? pr?.status}` };
      await new Promise((r) => setTimeout(r, waitMs));
      a = await this.git(repo, 'get', `/pullrequests/${n}`);
    }
    return a.code === 0 ? { ...a, code: 1, err: `pull request ${n} is still being completed on Azure DevOps` } : a;
  }

  async statuses(repo: string, commit: string): Promise<Answer> {
    const a = await this.git(repo, 'get', `/commits/${commit}/statuses`);
    return a.code === 0 ? { ...a, out: JSON.stringify(valueOf(a.out).map(statusOf).sort(newestFirst)) } : a;
  }

  /** A context "genre/name" is Azure DevOps' genre and name: steward/tested is genre steward, name tested. */
  setStatus(repo: string, commit: string, s: { state: 'success' | 'failure' | 'pending'; context: string; description: string }): Promise<Answer> {
    const i = s.context.lastIndexOf('/');
    const context = i > 0 ? { genre: s.context.slice(0, i), name: s.context.slice(i + 1) } : { name: s.context };
    return this.git(repo, 'post', `/commits/${commit}/statuses`, { state: s.state === 'failure' ? 'failed' : s.state === 'success' ? 'succeeded' : 'pending', description: s.description, context });
  }

  /** Its releases are its v<version> tags (Azure DevOps has no releases of its own). */
  async listReleases(repo: string, _fields: string, limit = 100): Promise<Answer> {
    const a = await this.git(repo, 'get', '/refs?filter=tags/v&peelTags=true');
    return a.code === 0 ? { ...a, out: JSON.stringify(valueOf(a.out).map(tagOf).slice(0, limit)) } : a;
  }

  async viewRelease(repo: string, tag: string, _fields: string): Promise<Answer> {
    const a = await this.git(repo, 'get', `/refs?filter=${encodeURIComponent(`tags/${tag}`)}&peelTags=true`);
    if (a.code !== 0) return a;
    const ref = valueOf(a.out).find((r) => r?.name === `refs/tags/${tag}`);
    return ref ? { ...a, out: JSON.stringify(tagOf(ref)) } : { ...a, code: 1, out: '', err: `release not found: no tag ${tag}` };
  }

  /** A release is an annotated tag at `target`, its message the title and the notes. */
  createRelease(repo: string, r: { tag: string; target: string; title: string; notesFile: string | null }): Promise<Answer> {
    const notes = r.notesFile ? readFileSync(r.notesFile, 'utf8') : '';
    return this.git(repo, 'post', '/annotatedtags', { name: r.tag, taggedObject: { objectId: r.target }, message: notes ? `${r.title}\n\n${notes}` : r.title }, 5 * MINUTE);
  }

  async downloadRelease(repo: string, tag: string): Promise<Answer> {
    return unsupported(`a release's files can't be downloaded from Azure DevOps (${repo} ${tag}): it has no releases, only tags`);
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

  /** The signed-in account as Azure DevOps names a pull request's author (its uniqueName, usually an email address). */
  async whoAmI(): Promise<Answer> {
    const a = await this.rest('get', `${this.org}/_apis/connectionData`);
    return a.code === 0 ? { ...a, out: `${parsed<any>(a.out)?.authenticatedUser?.properties?.Account?.$value ?? ''}\n` } : a;
  }

  /** Azure DevOps has no pull request head ref: the branch is fetched (a fork's isn't worked with). */
  prRef(pr: { number: number; head: string }): string {
    return `refs/heads/${pr.head}`;
  }

  releaseUrl(repo: string, tag: string): string {
    const w = where(repo);
    return `${w.base}/${encodeURIComponent(w.project)}/_git/${encodeURIComponent(w.repo)}?version=GT${encodeURIComponent(tag)}`;
  }
}

const PR_STATUS: Record<PrState, string> = { open: 'active', closed: 'abandoned', merged: 'completed' };
const NO_ISSUES = "the Steward doesn't file work items in Azure DevOps yet";
const unsupported = (err: string): Answer => ({ code: 1, out: '', err, what: 'az boards' });

/**
 * A repository's organization (https://dev.azure.com/<org>), project and repository, from the name repoFromUrl gives its
 * origin; null when it isn't on Azure DevOps. Pure.
 */
export function whereAzure(repo: string): { base: string; org: string; project: string; repo: string } | null {
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const at = (org: string, project: string, name: string) => ({ base: `https://dev.azure.com/${org}`, org: dec(org), project: dec(project), repo: dec(name) });
  let m = /^dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i.exec(repo);
  if (m) return at(m[1], m[2], m[3]);
  m = /^ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(repo);
  if (m) return at(m[1], m[2], m[3]);
  m = /^([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)$/i.exec(repo);
  if (m) return at(m[1], m[2], m[3]);
  return null;
}

function where(repo: string) {
  const w = whereAzure(repo);
  if (!w) throw new Error(`${repo} isn't a repository on Azure DevOps`);
  return w;
}

const parsed = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};
const valueOf = (text: string): any[] => {
  const v = parsed<any>(text);
  return Array.isArray(v?.value) ? v.value : Array.isArray(v) ? v : [];
};
const branchOf = (ref: unknown) => String(ref ?? '').replace(/^refs\/heads\//, '');

/** A pull request's page. Pure. */
export function webUrl(repo: string, id: number): string {
  const w = whereAzure(repo)!;
  return `${w.base}/${encodeURIComponent(w.project)}/_git/${encodeURIComponent(w.repo)}/pullrequest/${id}`;
}

/** A status's context as one word: genre/name ("steward/tested"), or its name alone. Pure. */
const contextOf = (s: any) => [s?.context?.genre, s?.context?.name].filter(Boolean).join('/');

/** A status's state as GitHub says it in a check rollup. Pure. */
function checkState(state: string): string {
  if (state === 'succeeded' || state === 'notApplicable') return 'SUCCESS';
  if (state === 'pending' || state === 'notSet') return 'PENDING';
  return 'FAILURE';
}

/** Whether Azure DevOps can merge it, as GitHub's mergeable and mergeStateStatus say. Pure. */
export function mergeStatesOf(pr: any): { mergeable: string; mergeStateStatus: string } {
  const s = String(pr?.mergeStatus ?? '');
  if (s === 'conflicts') return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  if (s === 'succeeded') return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  if (s === 'rejectedByPolicy') return { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
  return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' };
}

/** A pull request in `gh pr list --json`'s words, with what details() found. Pure. */
export function prOf(repo: string, pr: any, more: { files?: string[]; statuses?: any[] } = {}): Record<string, unknown> {
  const id = Number(pr?.pullRequestId);
  return {
    number: id,
    title: String(pr?.title ?? ''),
    url: webUrl(repo, id),
    body: String(pr?.description ?? ''),
    state: pr?.status === 'active' ? 'OPEN' : pr?.status === 'completed' ? 'MERGED' : 'CLOSED',
    headRefName: branchOf(pr?.sourceRefName),
    headRefOid: String(pr?.lastMergeSourceCommit?.commitId ?? ''),
    createdAt: pr?.creationDate,
    baseRefName: branchOf(pr?.targetRefName),
    isCrossRepository: !!pr?.forkSource,
    author: { login: String(pr?.createdBy?.uniqueName ?? '') },
    ...mergeStatesOf(pr),
    isDraft: pr?.isDraft === true,
    statusCheckRollup: (more.statuses ?? []).map((s) => ({ __typename: 'StatusContext', context: contextOf(s), state: checkState(String(s?.state ?? '')) })),
    labels: (Array.isArray(pr?.labels) ? pr.labels : []).map((l: any) => ({ name: String(l?.name ?? '') })),
    additions: 0,
    deletions: 0,
    files: (more.files ?? []).map((p) => ({ path: p })),
  };
}

/** A commit status as GitHub's REST API lists one. Pure. */
export function statusOf(s: any): Record<string, unknown> {
  const state = String(s?.state ?? '');
  return { state: state === 'succeeded' ? 'success' : state === 'failed' ? 'failure' : state === 'error' ? 'error' : 'pending', context: contextOf(s), description: s?.description ?? null, creator: { login: String(s?.createdBy?.uniqueName ?? '') }, created_at: s?.creationDate ?? null, id: s?.id ?? null };
}

const newestFirst = (a: any, b: any) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || Number(b.id ?? 0) - Number(a.id ?? 0);

/** A v<version> tag as `gh release list/view --json` says a release. Pure. */
export function tagOf(ref: any): Record<string, unknown> {
  return { tagName: String(ref?.name ?? '').replace(/^refs\/tags\//, ''), isDraft: false, publishedAt: null, body: '', targetCommitish: String(ref?.peeledObjectId ?? ref?.objectId ?? '') };
}
