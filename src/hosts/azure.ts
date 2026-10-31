import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../run.ts';
import type { Answer, PrState, SourceHost } from './host.ts';

const MINUTE = 60_000;
/** Azure DevOps' REST API version every `az devops invoke` asks for (each resource it asks has 7.1 released). */
const API = '7.1';
const NO_COMMIT = '0000000000000000000000000000000000000000';

/**
 * Azure DevOps (Azure Repos), through the Azure CLI (az) as this PC has it signed in (`az login`) and its azure-devops
 * extension, which asks Azure DevOps as the signed-in account, so the Steward keeps no token. A repository is named as
 * scm.ts's repoFromUrl names its clone's origin: dev.azure.com/<org>/<project>/_git/<repo>, its SSH form
 * ssh.dev.azure.com/v3/<org>/<project>/<repo>, or the older <org>.visualstudio.com/<project>/_git/<repo>.
 *
 * Pull requests go through `az repos pr` (list, show, create, update); everything else a repository has (a pull
 * request's iterations, statuses, comments and labels, a commit's statuses, refs, annotated tags) through `az devops invoke`,
 * the REST API (7.1) by area and resource. invoke takes a resource's first route, which for a pull request is the
 * organization's, read-only: so pull requests are az repos pr's. `az rest` isn't used: an organization of Microsoft
 * accounts answers it with its sign-in page, never its API (found live, 2026-10-31). A text (a title, a description, a
 * request's body) goes to az in a file, never on its command line.
 *
 * Its answers are said in GitHub's words (host.ts). A pull request's number is its id, which Azure DevOps numbers across
 * the organization: one asked by its number is worked with only when it is this repository's. Its checks are the
 * statuses on it and on its head commit (the vouch among them as "steward/tested": genre steward, name tested), its
 * files those of its last iteration (no line counts: Azure DevOps gives none, so a pull request's size reads as
 * nothing). It is completed with a merge commit, or squashed, at its head as it was read (az repos pr update completes
 * it at the head it reads itself, so the head is checked just before, and again once it is completed); az can't
 * rebase one, nor change its base. Azure DevOps has no releases: a release is an annotated v<version> tag, its message
 * the notes, and the releases listed are those tags. It has issues only as work items, which the Steward doesn't file
 * yet.
 */
export class AzureDevOps implements SourceHost {
  readonly kind = 'azure' as const;
  readonly name = 'Azure DevOps';
  private readonly run: Runner;
  private readonly cwd: string;

  constructor(run: Runner, cwd: string) {
    this.run = run;
    this.cwd = cwd;
  }

  /**
   * One az command, each of `texts` written to a file of its own and named in `args` as {file:<name>}; said as
   * refused() says it. `json`: whether it prints JSON, so anything else (a sign-in page) is a refusal.
   */
  private async az(args: string[], what: string, o: { org: string | null; texts?: Record<string, string>; timeoutMs?: number; json?: boolean }): Promise<Answer> {
    const texts = Object.entries(o.texts ?? {});
    const dir = texts.length ? mkdtempSync(path.join(os.tmpdir(), 'steward-body-')) : null;
    try {
      for (const [name, text] of texts) writeFileSync(path.join(dir!, name), text);
      const argv = args.map((a) => a.replace(/\{file:([\w.]+)\}/, (_, name: string) => path.join(dir!, name)));
      return refused({ ...(await this.run('az', argv, { cwd: this.cwd, timeoutMs: o.timeoutMs ?? 2 * MINUTE })), what }, o.org, o.json ?? true);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** `az repos pr <verb>` in the repository's organization; list and create name its project and repository too. */
  private pr(repo: string, verb: 'list' | 'show' | 'create' | 'update', args: string[], texts?: Record<string, string>, timeoutMs?: number): Promise<Answer> {
    const w = where(repo);
    const scoped = verb === 'list' || verb === 'create' ? ['--project', w.project, '--repository', w.repo] : [];
    const what = `az repos pr ${verb}${args[0] === '--id' ? ` --id ${args[1]}` : ''} (${w.base}/${w.project}/_git/${w.repo})`;
    return this.az(['repos', 'pr', verb, ...args, ...scoped, '--org', w.base, '--detect', 'false', '--output', 'json'], what, { org: w.base, texts, timeoutMs });
  }

  /**
   * A request to a repository's resource in the git area, by `az devops invoke`: its route the repository's project and
   * id (its name) and `route`, its query `query`, a body as JSON from a file.
   */
  private invoke(repo: string, method: 'GET' | 'POST', resource: string, route: Record<string, string | number> = {}, query: Record<string, string | number> = {}, body?: unknown, timeoutMs?: number): Promise<Answer> {
    const w = where(repo);
    const pairs = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${v}`);
    const args = ['devops', 'invoke', '--org', w.base, '--area', 'git', '--resource', resource, '--route-parameters', `project=${w.project}`, `repositoryId=${w.repo}`, ...pairs(route), '--http-method', method, '--api-version', API, '--detect', 'false', '--output', 'json'];
    if (Object.keys(query).length) args.push('--query-parameters', ...pairs(query));
    if (body !== undefined) args.push('--in-file', '{file:body.json}', '--encoding', 'utf-8');
    const what = `az devops invoke ${method} ${resource} ${pairs(route).join(' ')} (${w.base}/${w.project}/_git/${w.repo})`.replace(/ {2,}/g, ' ');
    return this.az(args, what, { org: w.base, texts: body === undefined ? {} : { 'body.json': JSON.stringify(body) }, timeoutMs });
  }

  /** A pull request by its number, only when it is this repository's: Azure DevOps numbers them across the organization. */
  private async shown(repo: string, n: number): Promise<Answer & { pr?: any }> {
    const a = await this.pr(repo, 'show', ['--id', String(n)]);
    if (a.code !== 0) return a;
    const pr = parsed<any>(a.out);
    const w = where(repo);
    const r = pr?.repository;
    if (!same(r?.name, w.repo) && !same(r?.id, w.repo)) return { ...a, code: 1, out: '', err: `pull request ${n} isn't ${w.project}/${w.repo}'s: it is ${r?.project?.name ?? '?'}/${r?.name ?? '?'}'s` };
    if (!same(r?.project?.name, w.project) && !same(r?.project?.id, w.project)) return { ...a, code: 1, out: '', err: `pull request ${n} isn't ${w.project}/${w.repo}'s: it is ${r?.project?.name ?? '?'}/${r?.name ?? '?'}'s` };
    return { ...a, pr };
  }

  async listPrs(repo: string, q: { state: PrState; head?: string; limit?: number; fields: string }): Promise<Answer> {
    const a = await this.pr(repo, 'list', ['--status', PR_STATUS[q.state], '--top', String(Math.min(q.limit ?? 30, 100)), ...(q.head ? ['--source-branch', `refs/heads/${q.head}`] : [])]);
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
      const a = await this.pr(repo, 'list', ['--status', 'active', '--source-branch', `refs/heads/${which}`, '--top', '1']);
      if (a.code !== 0) return a;
      const [pr] = valueOf(a.out);
      if (!pr) return { ...a, code: 1, out: '', err: `no pull requests found for branch "${which}"` };
      which = Number(pr.pullRequestId);
    }
    const a = await this.shown(repo, Number(which));
    if (a.code !== 0) return a;
    const more = await this.details(repo, a.pr, fields, true);
    if ('code' in more) return more;
    return { ...a, out: JSON.stringify(prOf(repo, a.pr, more)) };
  }

  /**
   * What a pull request's list entry hasn't, asked only when `fields` wants it: its files, its checks. For one az repos
   * pr show gave (`shown`), its labels too: show leaves them out, null even on a labelled one, where list gives them
   * (found live, 2026-10-31).
   */
  private async details(repo: string, pr: any, fields: string, shown = false): Promise<Answer | { files?: string[]; statuses?: any[]; labels?: any[] }> {
    const want = new Set(fields.split(','));
    const out: { files?: string[]; statuses?: any[]; labels?: any[] } = {};
    const pullRequestId = Number(pr?.pullRequestId);
    if (shown && want.has('labels')) {
      const l = await this.invoke(repo, 'GET', 'pullRequestLabels', { pullRequestId });
      if (l.code !== 0) return l;
      out.labels = valueOf(l.out);
    }
    if (want.has('files')) {
      const its = await this.invoke(repo, 'GET', 'pullRequestIterations', { pullRequestId });
      if (its.code !== 0) return its;
      const last = valueOf(its.out).at(-1)?.id;
      out.files = [];
      if (last) {
        const c = await this.invoke(repo, 'GET', 'pullRequestIterationChanges', { pullRequestId, iterationId: last }, { $top: 1000 });
        if (c.code !== 0) return c;
        out.files = ((parsed<any>(c.out)?.changeEntries ?? []) as any[]).map((x) => String(x?.item?.path ?? '').replace(/^\//, '')).filter(Boolean);
      }
    }
    if (want.has('statusCheckRollup')) {
      const s = await this.invoke(repo, 'GET', 'pullRequestStatuses', { pullRequestId });
      if (s.code !== 0) return s;
      out.statuses = valueOf(s.out);
      const head = pr?.lastMergeSourceCommit?.commitId;
      if (head) {
        const c = await this.invoke(repo, 'GET', 'statuses', { commitId: head }, { latestOnly: 'true' });
        if (c.code !== 0) return c;
        out.statuses.push(...valueOf(c.out));
      }
    }
    return out;
  }

  async createPr(repo: string, p: { base: string; head: string; title: string; body: string }): Promise<Answer> {
    const a = await this.pr(repo, 'create', ['--source-branch', `refs/heads/${p.head}`, '--target-branch', `refs/heads/${p.base}`, '--title', '@{file:title.txt}', '--description', '@{file:body.md}'], { 'title.txt': p.title, 'body.md': p.body }, 5 * MINUTE);
    return a.code === 0 ? { ...a, out: `${webUrl(repo, Number(parsed<any>(a.out)?.pullRequestId))}\n` } : a;
  }

  /** Its title and description; not its base, which az can't change (on its page, Edit). */
  async editPr(repo: string, n: number, p: { title?: string; body?: string; base?: string }): Promise<Answer> {
    if (p.base !== undefined) return unsupported(`${NO_BASE} (pull request ${n} to ${p.base})`, 'az repos pr update');
    const s = await this.shown(repo, n);
    if (s.code !== 0) return s;
    const texts = { ...(p.title !== undefined ? { 'title.txt': p.title } : {}), ...(p.body !== undefined ? { 'body.md': p.body } : {}) };
    return this.pr(repo, 'update', ['--id', String(n), ...('title.txt' in texts ? ['--title', '@{file:title.txt}'] : []), ...('body.md' in texts ? ['--description', '@{file:body.md}'] : [])], texts);
  }

  commentPr(repo: string, n: number, body: string): Promise<Answer> {
    return this.invoke(repo, 'POST', 'pullRequestThreads', { pullRequestId: n }, {}, { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 'closed' });
  }

  async closePr(repo: string, n: number, p: { comment?: string; deleteBranch?: boolean } = {}): Promise<Answer> {
    const s = await this.shown(repo, n);
    if (s.code !== 0) return s;
    if (p.comment !== undefined) {
      const c = await this.commentPr(repo, n, p.comment);
      if (c.code !== 0) return c;
    }
    const a = await this.pr(repo, 'update', ['--id', String(n), '--status', 'abandoned']);
    if (a.code !== 0 || !p.deleteBranch) return a;
    const pr = parsed<any>(a.out);
    const branch = String(pr?.sourceRefName ?? '');
    const at = pr?.lastMergeSourceCommit?.commitId;
    return branch && at ? this.invoke(repo, 'POST', 'refs', {}, {}, [{ name: branch, oldObjectId: at, newObjectId: NO_COMMIT }]) : a;
  }

  /**
   * Completed with a merge commit (or squashed), at `matchHead`: az repos pr update completes a pull request at the head
   * it reads itself, so its head is checked just before, and one pushed to since is refused; with none given, its head
   * as it is now. Azure DevOps completes it in the background: it is asked again (a minute at most) until it is, so what
   * follows finds the merge on the branch; one a policy holds, or still not completed, is answered as a failure, and so
   * is one completed at another head (pushed to in the moment between). az can't rebase one.
   */
  async mergePr(repo: string, n: number, p: { matchHead?: string; deleteBranch?: boolean; method?: 'merge' | 'squash' | 'rebase' } = {}, waitMs = 5_000): Promise<Answer> {
    if (p.method === 'rebase') return unsupported(`${NO_REBASE} (pull request ${n})`, 'az repos pr update');
    const s = await this.shown(repo, n);
    if (s.code !== 0) return s;
    const head = String(s.pr?.lastMergeSourceCommit?.commitId ?? '');
    if (p.matchHead && head !== p.matchHead) return { ...s, code: 1, out: '', err: `pull request ${n}'s head is ${head || 'unknown'}, not ${p.matchHead}: it was pushed to since` };
    let a: Answer = await this.pr(repo, 'update', ['--id', String(n), '--status', 'completed', '--squash', String(p.method === 'squash'), '--delete-source-branch', String(!!p.deleteBranch)], undefined, 5 * MINUTE);
    for (let i = 0; a.code === 0 && i < 12; i++) {
      const pr = parsed<any>(a.out);
      if (pr?.status === 'completed') {
        const at = pr?.lastMergeSourceCommit?.commitId;
        return at && head && at !== head ? { ...a, code: 1, err: `pull request ${n} was completed at ${at}, not at ${head}, the head that was checked: it was pushed to as it was completed` } : a;
      }
      if (pr?.status === 'abandoned' || pr?.mergeStatus === 'conflicts' || pr?.mergeStatus === 'rejectedByPolicy' || pr?.mergeStatus === 'failure') return { ...a, code: 1, err: `pull request ${n} wasn't completed: ${pr?.mergeFailureMessage ?? pr?.mergeStatus ?? pr?.status}` };
      await new Promise((r) => setTimeout(r, waitMs));
      a = await this.pr(repo, 'show', ['--id', String(n)]);
    }
    return a.code === 0 ? { ...a, code: 1, err: `pull request ${n} is still being completed on Azure DevOps` } : a;
  }

  async statuses(repo: string, commit: string): Promise<Answer> {
    const a = await this.invoke(repo, 'GET', 'statuses', { commitId: commit });
    return a.code === 0 ? { ...a, out: JSON.stringify(valueOf(a.out).map(statusOf).sort(newestFirst)) } : a;
  }

  /** A context "genre/name" is Azure DevOps' genre and name: steward/tested is genre steward, name tested. */
  setStatus(repo: string, commit: string, s: { state: 'success' | 'failure' | 'pending'; context: string; description: string }): Promise<Answer> {
    const i = s.context.lastIndexOf('/');
    const context = i > 0 ? { genre: s.context.slice(0, i), name: s.context.slice(i + 1) } : { name: s.context };
    return this.invoke(repo, 'POST', 'statuses', { commitId: commit }, {}, { state: s.state === 'failure' ? 'failed' : s.state === 'success' ? 'succeeded' : 'pending', description: s.description, context });
  }

  /** Its releases are its v<version> tags (Azure DevOps has no releases of its own). */
  async listReleases(repo: string, _fields: string, limit = 100): Promise<Answer> {
    const a = await this.invoke(repo, 'GET', 'refs', {}, { filter: 'tags/v', peelTags: 'true' });
    return a.code === 0 ? { ...a, out: JSON.stringify(valueOf(a.out).map(tagOf).slice(0, limit)) } : a;
  }

  async viewRelease(repo: string, tag: string, _fields: string): Promise<Answer> {
    const a = await this.invoke(repo, 'GET', 'refs', {}, { filter: `tags/${tag}`, peelTags: 'true' });
    if (a.code !== 0) return a;
    const ref = valueOf(a.out).find((r) => r?.name === `refs/tags/${tag}`);
    return ref ? { ...a, out: JSON.stringify(tagOf(ref)) } : { ...a, code: 1, out: '', err: `release not found: no tag ${tag}` };
  }

  /** A release is an annotated tag at `target`, its message the title and the notes. */
  createRelease(repo: string, r: { tag: string; target: string; title: string; notesFile: string | null }): Promise<Answer> {
    const notes = r.notesFile ? readFileSync(r.notesFile, 'utf8') : '';
    return this.invoke(repo, 'POST', 'annotatedTags', {}, {}, { name: r.tag, taggedObject: { objectId: r.target }, message: notes ? `${r.title}\n\n${notes}` : r.title }, 5 * MINUTE);
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

  /**
   * The account az is signed in as (`az account show`, read on this PC): Azure DevOps names a pull request's author by
   * that account's uniqueName, the same name in another case perhaps, which the Steward compares ignoring case.
   */
  async whoAmI(): Promise<Answer> {
    const a = await this.az(['account', 'show', '--query', 'user.name', '--output', 'tsv'], 'az account show', { org: null, json: false });
    return a.code === 0 ? { ...a, out: `${a.out.trim()}\n` } : a;
  }

  releaseUrl(repo: string, tag: string): string {
    const w = where(repo);
    return `${w.base}/${encodeURIComponent(w.project)}/_git/${encodeURIComponent(w.repo)}?version=GT${encodeURIComponent(tag)}`;
  }
}

const PR_STATUS: Record<PrState, string> = { open: 'active', closed: 'abandoned', merged: 'completed' };
const NO_ISSUES = "the Steward doesn't file work items in Azure DevOps yet";
const NO_BASE = "the Azure CLI can't change a pull request's base branch: change it on its page in Azure DevOps";
const NO_REBASE = "the Azure CLI can't complete a pull request by rebasing: it merges or squashes";
export const NO_EXTENSION = "the Azure CLI's azure-devops extension isn't installed: az extension add --name azure-devops";
const unsupported = (err: string, what = 'az boards'): Answer => ({ code: 1, out: '', err, what });
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** What says az's sign-in wasn't let in: Azure DevOps' 401 or TF400813, Entra's AADSTS, the extension's or az's "log in". */
const SIGN_IN = /\b401\b|TF400813|AADSTS\d+|Response is not json|you need to run the login command|\baz login\b/i;

/**
 * An az answer as the Steward says it, in one sentence the person can act on where it can: the azure-devops extension
 * missing (az never installs it here: run.ts sets AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no), or a sign-in Azure DevOps
 * doesn't let in, an error or a page where JSON was asked (an organization of Microsoft accounts answered az rest with
 * its sign-in page); with no organization (az account show), az not signed in. Anything else as az said it. Pure.
 */
export function refused(a: Answer, org: string | null, json = true): Answer {
  const text = `${a.err}\n${a.code === 0 ? '' : a.out}`;
  if (a.code !== 0 && (/\bazure-devops\b[\s\S]*\bextension\b|\bextension\b[\s\S]*\bazure-devops\b/i.test(text) || /'(?:repos|devops)' is (?:misspelled|not in)/i.test(text))) return { ...a, err: NO_EXTENSION };
  const page = a.code === 0 && json && a.out.trim() !== '' && parsed(a.out) === null;
  if (!page && !(a.code !== 0 && SIGN_IN.test(text))) return a;
  const line = page ? 'it answered with a page, not JSON' : (text.split(/\r?\n/).map((l) => l.replace(/^ERROR:\s*/, '').trim()).find(Boolean) ?? '').slice(0, 300);
  return { ...a, code: 1, out: '', err: org ? `az's sign-in isn't let into ${org} through Azure DevOps' API (az login, as an account the organization has): ${line}` : `az isn't signed in (az login): ${line}` };
}


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
export function prOf(repo: string, pr: any, more: { files?: string[]; statuses?: any[]; labels?: any[] } = {}): Record<string, unknown> {
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
    labels: (more.labels ?? (Array.isArray(pr?.labels) ? pr.labels : [])).filter((l: any) => l?.active !== false).map((l: any) => ({ name: String(l?.name ?? '') })),
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
