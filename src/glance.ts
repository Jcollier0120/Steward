import { createHash } from 'node:crypto';
import path from 'node:path';
import { APP } from './app.ts';
import { expandEnv } from './kit/settings-kit.ts';
import { GithubLimited, LIMITED, readingFrom, type RateReading } from './budget.ts';
import { GitHubApi, type GitHubApiError } from './kit/github.ts';
import type { Runner } from './run.ts';
import { gitGlance, type Host } from './scm.ts';
import type { Employee, Settings } from './settings.ts';

/**
 * GitHub at a glance: one `gh api graphql` query for everything a round, the staff's table and the page need from
 * GitHub, for every employee at once. Each employee's repository answers with its branch's head commit, its open
 * PRs (with what merge, catch-up and the look at the Wright's drafts read: the same fields `gh pr list` gave) and
 * its releases (with the commit each tags); and the Steward's own releases, the kit's among them.
 *
 * Before, a round asked GitHub once or twice per employee and ran git a handful of times for each, whether or not
 * anything had changed. Now a round asks this once, and looks again (git fetch, the version files, a release) only
 * at the employees whose repository changed since the last round (stages/changes.ts).
 */

export interface GlanceRelease {
  tagName: string;
  isDraft: boolean;
  publishedAt: string | null;
  /** The commit its tag points at, when GitHub says. */
  commit: string | null;
}

export interface RepoGlance {
  /** The head commit of the employee's branch on GitHub, or null when the branch isn't there. */
  head: string | null;
  /** Its open PRs, newest first, in `gh pr list --json`'s shape (PR_FIELDS, stages/staff.ts), for parsePrs. */
  prs: any[];
  /** Its releases, newest first, in `gh release list --json`'s shape, for appReleasesIn. */
  releases: GlanceRelease[];
}

/** The Steward's own main on GitHub: its head, and the versions there (kit/VERSION, package.json's), for its own releases (stages/self.ts). */
export interface StewardMain {
  head: string | null;
  kit: string | null;
  version: string | null;
}

/** The branch the Steward's own releases come from. */
export const STEWARD_BRANCH = 'main';

export interface Glance {
  at: string;
  /** The Steward's own releases (its v<x.y.z> and the kit's kit-v<x.y.z>), or null when they couldn't be read. */
  stewardReleases: { tagName: string; isDraft: boolean; publishedAt?: string }[] | null;
  /** The Steward's own main, or null when it couldn't be read (left out: an older glance). */
  stewardMain?: StewardMain | null;
  /**
   * By employee id. One GitHub gave no answer for is left out, and `errors` says why. The Steward's own repository is
   * here too, by its own id (APP.id), on a PC that merges its PRs or shows it in the staff's table (stewardPrsAsked).
   */
  repos: Record<string, RepoGlance>;
  errors: Record<string, string>;
  /** What its queries cost, in GraphQL points, and what GitHub said is left: each query's `rateLimit` (budget.ts). */
  cost?: number;
  rates?: RateReading[];
  /**
   * Every branch head of each repository read (owner/name → branch → commit), and whether that's all its branches: for
   * other agents, shared in remote-heads.json (kit/remote-heads.ts) so they need no ls-remote of their own.
   */
  heads?: Record<string, { heads: Record<string, string>; complete: boolean }>;
}

/**
 * How many repositories one query asks about. GitHub allows 500,000 nodes a query, and each takes about 22,000, but it
 * also gives a query 10 seconds: on 2026-10-12, 15 repositories with their PRs' files and checks took longer, GitHub
 * answered 502 and every round asked each employee on its own. 8 took up to 8 seconds, 5 up to 5, at the same cost.
 */
export const PER_QUERY = 5;

/** GitHub giving up on a query that took too long: 502 or 504 from the API, gh's "HTTP 502", or GraphQL's own words. */
export const queryTimedOut = (e: unknown) => [502, 504].includes((e as GitHubApiError)?.status) || /\b(?:HTTP |graphql: )50[24]\b|may be the result of a timeout/i.test(String((e as Error)?.message ?? e));

/**
 * The open PRs a glance reads of each repository. GitHub charges a query by the nodes it may return, and each PR's
 * labels, files and checks are a page each: at 100 PRs a repository cost 4 points, at 25 it costs 1 (budget.ts). One
 * with more open than this is asked on its own (readGlance), as one GitHub gave no answer for is.
 */
export const PR_PAGE = 25;

const PRS = `pullRequests(states: OPEN, first: ${PR_PAGE}, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes {
  number title url body createdAt headRefName headRefOid baseRefName isCrossRepository isDraft mergeable mergeStateStatus additions deletions
  author { __typename login }
  labels(first: 20) { nodes { name } }
  files(first: 100) { nodes { path } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state context } } } } } } }
} }`;
const RELEASES = 'releases(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName isDraft publishedAt tagCommit { oid } } }';
/**
 * How many branch heads a glance reads of each repository at once, for kit 2.58.0's remote-heads.json (GitHub's most for
 * a page). A repository with more has the rest read after (moreHeads), up to MORE_HEADS pages more.
 */
export const HEADS_PAGE = 100;
export const MORE_HEADS = 9;
const headsPage = (after?: string) => `refs(refPrefix: "refs/heads/", first: ${HEADS_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ''}) { totalCount pageInfo { hasNextPage endCursor } nodes { name target { oid } } }`;
const HEADS = headsPage();

const ownerName = (repo: string) => {
  const [owner, name] = repo.split('/');
  return `owner: ${JSON.stringify(owner ?? '')}, name: ${JSON.stringify(name ?? '')}`;
};

/**
 * Whether the glance reads the Steward's own open PRs, as an employee's: on a PC that merges them (Settings' mergeSelf,
 * selfmerge.ts) or shows its repository in the staff's table (releasesCastellan), with its clone named. Its merge asked
 * `gh pr list` of it every round, and its row in the table three gh calls each time the table was made. One point more a
 * round (GitHub's cost of a query of 5 repositories and the Steward's went from 5 to 6, 2026-10-13), and no process.
 */
export const stewardPrsAsked = (s: Partial<Pick<Settings, 'stewardRepo' | 'stewardCheckout' | 'mergeSelf' | 'releasesCastellan'>>): boolean =>
  !!s.stewardRepo && !!s.stewardCheckout && (!!s.mergeSelf || !!s.releasesCastellan);

/**
 * The query for these employees (aliased e0, e1, …, in order), and the Steward's releases when `stewardRepo` is given:
 * with its open PRs too when `stewardPrs` (stewardPrsAsked).
 */
export function glanceQuery(employees: Employee[], stewardRepo: string | null, stewardPrs = false): string {
  const parts = employees.map((e, i) => `e${i}: repository(${ownerName(e.repo)}) { ...R ref(qualifiedName: ${JSON.stringify(`refs/heads/${e.branch}`)}) { target { oid } } }`);
  if (stewardRepo) {
    const main = (file: string) => `object(expression: ${JSON.stringify(`${STEWARD_BRANCH}:${file}`)}) { ... on Blob { text } }`;
    const releases = stewardPrs ? `${PRS} ${RELEASES}` : 'releases(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName isDraft publishedAt } }';
    parts.unshift(
      `steward: repository(${ownerName(stewardRepo)}) { ${releases} ` +
        `main: ref(qualifiedName: ${JSON.stringify(`refs/heads/${STEWARD_BRANCH}`)}) { target { oid } } kitVersion: ${main('kit/VERSION')} packageJson: ${main('package.json')} ${HEADS} }`,
    );
  }
  // What it costs and what's left (budget.ts), asked in the query itself: free.
  parts.unshift('rateLimit { cost limit remaining used resetAt }');
  const fragment = employees.length ? `fragment R on Repository { ${PRS} ${RELEASES} ${HEADS} } ` : '';
  return `${fragment}query { ${parts.join(' ')} }`.replace(/\s+/g, ' ');
}

/** A PR as GraphQL gives it, in `gh pr list --json`'s shape: a GitHub App's author as app/<name>, the checks as one list. */
export function prFromGraph(n: any): any {
  const login = typeof n?.author?.login === 'string' ? n.author.login : '';
  return {
    number: n?.number,
    title: n?.title,
    url: n?.url,
    body: n?.body,
    headRefName: n?.headRefName,
    headRefOid: n?.headRefOid,
    createdAt: n?.createdAt,
    baseRefName: n?.baseRefName,
    isCrossRepository: n?.isCrossRepository,
    isDraft: n?.isDraft,
    mergeable: n?.mergeable,
    mergeStateStatus: n?.mergeStateStatus,
    additions: n?.additions,
    deletions: n?.deletions,
    author: { login: n?.author?.__typename === 'Bot' && login ? `app/${login}` : login },
    labels: Array.isArray(n?.labels?.nodes) ? n.labels.nodes : [],
    files: Array.isArray(n?.files?.nodes) ? n.files.nodes : [],
    statusCheckRollup: n?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [],
  };
}

function repoFromGraph(r: any): RepoGlance {
  return {
    head: typeof r?.ref?.target?.oid === 'string' ? r.ref.target.oid : null,
    prs: (Array.isArray(r?.pullRequests?.nodes) ? r.pullRequests.nodes : []).map(prFromGraph),
    releases: (Array.isArray(r?.releases?.nodes) ? r.releases.nodes : []).map((x: any) => ({
      tagName: String(x?.tagName ?? ''),
      isDraft: x?.isDraft === true,
      publishedAt: typeof x?.publishedAt === 'string' ? x.publishedAt : null,
      commit: typeof x?.tagCommit?.oid === 'string' ? x.tagCommit.oid : null,
    })),
  };
}

/**
 * A repository's branch heads as the glance read them (added to `had`, an earlier page's), and whether they're all of
 * them; null when they weren't asked. `after`: where the next page starts, when GitHub has more.
 */
export function headsFromGraph(r: any, had: Record<string, string> = {}): { heads: Record<string, string>; complete: boolean; after?: string } | null {
  if (!Array.isArray(r?.refs?.nodes)) return null;
  const heads: Record<string, string> = { ...had };
  for (const n of r.refs.nodes) if (typeof n?.name === 'string' && typeof n?.target?.oid === 'string') heads[n.name] = n.target.oid;
  const after = r.refs.pageInfo?.hasNextPage === true && typeof r.refs.pageInfo.endCursor === 'string' ? r.refs.pageInfo.endCursor : undefined;
  return { heads, complete: !after && Number(r.refs.totalCount) === Object.keys(heads).length, ...(after ? { after } : {}) };
}

/**
 * The query for these repositories' branch heads (aliased h0, h1, …, in order): the next page of each where `after`
 * says, else the first (heads.ts's look between rounds). Pure.
 */
export function moreHeadsQuery(repos: { repo: string; after?: string }[]): string {
  const parts = repos.map((r, i) => `h${i}: repository(${ownerName(r.repo)}) { ${headsPage(r.after)} }`);
  return `query { rateLimit { cost limit remaining used resetAt } ${parts.join(' ')} }`.replace(/\s+/g, ' ');
}

/**
 * The rest of the branch heads of the repositories with more than a glance's page (`more`: repository → where the next
 * page starts): all of them in one query a page, up to MORE_HEADS pages. So a repository with many branches (Manor's)
 * is shared whole, and other agents needn't ls-remote it. A page GitHub can't give leaves its repository incomplete, as
 * before; it never fails the glance.
 */
export async function moreHeads(ask: GlanceAsk, glance: Glance, more: Map<string, string>, now: () => Date = () => new Date()): Promise<void> {
  for (let page = 0; page < MORE_HEADS && more.size; page++) {
    const repos = [...more].map(([repo, after]) => ({ repo, after }));
    more.clear();
    let data: any;
    try {
      data = JSON.parse(await ask(moreHeadsQuery(repos)))?.data;
    } catch {
      return;
    }
    const rate = readingFrom(data?.rateLimit, now());
    if (rate) glance.rates = [...(glance.rates ?? []), rate];
    if (typeof data?.rateLimit?.cost === 'number') glance.cost = (glance.cost ?? 0) + data.rateLimit.cost;
    repos.forEach((r, i) => {
      const had = glance.heads?.[r.repo];
      const h = had ? headsFromGraph(data?.[`h${i}`], had.heads) : null;
      if (!h) return;
      glance.heads![r.repo] = { heads: h.heads, complete: h.complete };
      if (h.after) more.set(r.repo, h.after);
    });
  }
}

const VERSION = /^\d+\.\d+\.\d+$/;

/** The Steward's main as the glance read it: its head, kit/VERSION and package.json's version (null where it isn't one). */
export function stewardMainFrom(s: any): StewardMain {
  const kit = typeof s?.kitVersion?.text === 'string' ? s.kitVersion.text.trim() : '';
  let version = '';
  try {
    version = String(JSON.parse(String(s?.packageJson?.text ?? '').replace(/^﻿/, ''))?.version ?? '');
  } catch {
    // No package.json, or not JSON: no version.
  }
  return { head: typeof s?.main?.target?.oid === 'string' ? s.main.target.oid : null, kit: VERSION.test(kit) ? kit : null, version: VERSION.test(version) ? version : null };
}

/**
 * GitHub's answer to a glanceQuery, read: `gh api graphql` exits 1 when any part of the query failed (a repository
 * that isn't there, say), but still prints what it could answer, with `errors` for the rest. `self`: the Steward's own
 * id, when its open PRs were asked (glanceQuery's stewardPrs), to file its repository under.
 */
export function readGlance(employees: Employee[], answer: string, stewardRepo: string | null, into: Glance, now = new Date(), self: string | null = null, more?: Map<string, string>): void {
  let j: any;
  try {
    j = JSON.parse(answer);
  } catch {
    throw new Error(`GitHub's answer isn't JSON: ${answer.trim().split('\n').pop()?.slice(0, 200) || 'nothing'}`);
  }
  const data = j?.data;
  if (!data || typeof data !== 'object') {
    const why = String(j?.errors?.[0]?.message ?? j?.message ?? 'GitHub gave no data');
    throw LIMITED.test(why) || j?.errors?.[0]?.type === 'RATE_LIMITED' ? new GithubLimited(why) : new Error(why);
  }
  const rate = readingFrom(data.rateLimit, now);
  if (rate) into.rates = [...(into.rates ?? []), rate];
  if (typeof data.rateLimit?.cost === 'number') into.cost = (into.cost ?? 0) + data.rateLimit.cost;
  const why = (alias: string) => {
    const err = (Array.isArray(j.errors) ? j.errors : []).find((x: any) => Array.isArray(x?.path) && x.path[0] === alias);
    return String(err?.message ?? 'GitHub gave no answer for it');
  };
  // A repository's branch heads, for remote-heads.json; where it has more than a page, where the rest starts (moreHeads).
  const keepHeads = (repo: string, r: any) => {
    const h = r ? headsFromGraph(r) : null;
    if (!h) return;
    (into.heads ??= {})[repo] = { heads: h.heads, complete: h.complete };
    if (h.after) more?.set(repo, h.after);
  };
  if (stewardRepo) {
    into.stewardReleases = data.steward ? (data.steward.releases?.nodes ?? []).map((x: any) => ({ tagName: String(x?.tagName ?? ''), isDraft: x?.isDraft === true, ...(typeof x?.publishedAt === 'string' ? { publishedAt: x.publishedAt } : {}) })) : null;
    into.stewardMain = data.steward ? stewardMainFrom(data.steward) : null;
    // Its main and open PRs, as an employee's; with more open than a glance reads, left out, and asked of GitHub as before.
    const open = Number(data.steward?.pullRequests?.totalCount ?? 0);
    if (self && Array.isArray(data.steward?.pullRequests?.nodes) && open <= PR_PAGE) into.repos[self] = repoFromGraph({ ...data.steward, ref: data.steward.main });
    // Its own repository's heads too: where it releases Castellan it isn't one of the employees, and was never shared.
    keepHeads(stewardRepo, data.steward);
  }
  employees.forEach((e, i) => {
    const r = data[`e${i}`];
    const open = Number(r?.pullRequests?.totalCount ?? 0);
    if (r && open > PR_PAGE) into.errors[e.id] = `${open} open PRs, more than a glance reads (${PR_PAGE})`;
    else if (r) into.repos[e.id] = repoFromGraph(r);
    else into.errors[e.id] = why(`e${i}`);
    keepHeads(e.repo, r);
  });
}

/**
 * Every employee's repository, and the Steward's releases, from GitHub: one query (one more for each 5 employees
 * past the first 5). Throws when GitHub can't be asked at all (gh signed out, no network); an employee GitHub
 * couldn't answer for is in `errors`.
 *
 * A repository worked with plain git (`host`, scm.ts) isn't asked of GitHub: its branch head and its v<x.y.z> tags come
 * from one `git ls-remote` of its origin, in its clone, and it has no PRs. With none on GitHub (and no repository of
 * the Steward's own), gh isn't run at all. One worked with GitLab's way has no glance: each stage asks GitLab of it on
 * its own (hosts/gitlab.ts).
 */
export async function takeGlance(
  run: Runner,
  cwd: string,
  settings: Pick<Settings, 'employees' | 'stewardRepo'> & Partial<Pick<Settings, 'stewardCheckout' | 'mergeSelf' | 'releasesCastellan'>>,
  host: (e: Employee) => Host = () => 'github',
  now: () => Date = () => new Date(),
  ask: GlanceAsk = ghAsk(run, cwd),
): Promise<Glance> {
  const glance: Glance = { at: now().toISOString(), stewardReleases: null, stewardMain: null, repos: {}, errors: {} };
  const byGit = settings.employees.filter((e) => host(e) === 'git');
  for (const e of byGit) {
    try {
      glance.repos[e.id] = await gitGlance(run, { branch: e.branch, checkout: path.resolve(expandEnv(e.checkout)) });
    } catch (err) {
      glance.errors[e.id] = (err as Error).message;
    }
  }
  const all = settings.employees.filter((e) => host(e) === 'github');
  // Nothing to ask GitHub about: no employee on it, and no repository of its own.
  if (!all.length && !settings.stewardRepo) return glance;
  // A query GitHub gives up on as too slow is asked again in halves, down to one repository: a busy week's PRs can take
  // a few repositories past GitHub's 10 seconds. A failure of any other kind, or of one repository alone, is the glance's.
  const self = stewardPrsAsked(settings) ? APP.id : null;
  const more = new Map<string, string>();
  const asked = async (chunk: Employee[], stewardRepo: string | null): Promise<void> => {
    try {
      readGlance(chunk, await ask(glanceQuery(chunk, stewardRepo, !!self)), stewardRepo, glance, now(), self, more);
    } catch (e) {
      if (chunk.length < 2 || !queryTimedOut(e)) throw e;
      const half = Math.ceil(chunk.length / 2);
      await asked(chunk.slice(0, half), stewardRepo);
      await asked(chunk.slice(half), null);
    }
  };
  for (let i = 0; i === 0 || i < all.length; i += PER_QUERY) await asked(all.slice(i, i + PER_QUERY), i === 0 ? settings.stewardRepo : null);
  await moreHeads(ask, glance, more, now);
  return glance;
}

/** Asks GitHub a glance's query: its answer as JSON text, partial answers (with `errors`) included. */
export type GlanceAsk = (query: string) => Promise<string>;

/** Through `gh api graphql`, as before Steward 0.35.11: a gh process for each query. */
export const ghAsk = (run: Runner, cwd: string): GlanceAsk => async (query) => {
  const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`], { cwd, timeoutMs: 2 * 60_000 });
  if (!r.out.trim()) {
    const why = (r.err || 'no output').trim().split('\n').slice(-3).join(' / ');
    throw LIMITED.test(why) ? new GithubLimited(why) : new Error(`gh api graphql failed (${r.code}): ${why}`);
  }
  return r.out;
};

let api: GitHubApi | null = null;

/** The Steward's one client of GitHub's API: its token asked of gh once, and each GET's ETag kept (kit/github.ts). */
export const githubApi = (): GitHubApi => (api ??= new GitHubApi());

/**
 * Through GitHub's API from the Steward's own process (kit/github.ts, Steward 0.35.11): no gh process for each round,
 * only once for its token. A partial answer comes back as gh's did, with `errors`; a refusal for the rate limit is
 * GithubLimited, as gh's was.
 */
export const apiAsk = (o?: ConstructorParameters<typeof GitHubApi>[0]): GlanceAsk => async (query) => {
  const client = o ? new GitHubApi(o) : githubApi();
  try {
    return JSON.stringify(await client.rest('POST', 'graphql', { body: { query } }));
  } catch (e) {
    const why = (e as Error).message;
    throw LIMITED.test(why) ? new GithubLimited(why) : e;
  }
};

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** What GitHub says of one employee's repository, as one value that changes when anything in it does. */
export function repoSig(g: RepoGlance): string {
  return sha({ head: g.head, prs: [...g.prs].sort((a, b) => Number(a.number) - Number(b.number)), releases: g.releases.map((r) => [r.tagName, r.isDraft, r.commit]).sort() });
}

/**
 * What a round's work for an employee rests on: its repository on GitHub, and the Settings that decide what a round
 * does with it (the employee's own, the team, the look at the Wright's drafts, catching up, releasing after merging,
 * rolling a kit out); and, while it rolls kits out, the kit it would roll out: the newest kit release, and the kit this
 * Steward carries (stages/rollout.ts). So a new kit release, or the Steward updated to one, is something new for everyone.
 */
export function roundSig(e: Employee, g: RepoGlance, s: Pick<Settings, 'team' | 'wrightReview' | 'catchUp' | 'releaseAfterMerge' | 'rollout'>, kit: { newest: string | null; own: string | null } | null = null): string {
  return sha({ repo: repoSig(g), employee: e, team: s.team, wrightReview: s.wrightReview, catchUp: s.catchUp, releaseAfterMerge: s.releaseAfterMerge, ...(s.rollout ? { rollout: kit } : {}) });
}
