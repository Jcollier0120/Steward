import { createHash } from 'node:crypto';
import type { Runner } from './run.ts';
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
  /** Its open PRs, newest first, in `gh pr list --json`'s shape (prListArgs' fields), for parsePrs. */
  prs: any[];
  /** Its releases, newest first, in `gh release list --json`'s shape, for appReleasesIn. */
  releases: GlanceRelease[];
}

export interface Glance {
  at: string;
  /** The Steward's own releases (its v<x.y.z> and the kit's kit-v<x.y.z>), or null when they couldn't be read. */
  stewardReleases: { tagName: string; isDraft: boolean }[] | null;
  /** By employee id. One GitHub gave no answer for is left out, and `errors` says why. */
  repos: Record<string, RepoGlance>;
  errors: Record<string, string>;
}

/** How many repositories one query asks about: GitHub allows 500,000 nodes a query, and each takes about 22,000. */
export const PER_QUERY = 15;

const PRS = `pullRequests(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
  number title url body headRefName headRefOid baseRefName isCrossRepository isDraft mergeable mergeStateStatus additions deletions
  author { __typename login }
  labels(first: 20) { nodes { name } }
  files(first: 100) { nodes { path } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }
} }`;
const RELEASES = 'releases(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName isDraft publishedAt tagCommit { oid } } }';

const ownerName = (repo: string) => {
  const [owner, name] = repo.split('/');
  return `owner: ${JSON.stringify(owner ?? '')}, name: ${JSON.stringify(name ?? '')}`;
};

/** The query for these employees (aliased e0, e1, …, in order), and the Steward's releases when `stewardRepo` is given. */
export function glanceQuery(employees: Employee[], stewardRepo: string | null): string {
  const parts = employees.map((e, i) => `e${i}: repository(${ownerName(e.repo)}) { ...R ref(qualifiedName: ${JSON.stringify(`refs/heads/${e.branch}`)}) { target { oid } } }`);
  if (stewardRepo) parts.unshift(`steward: repository(${ownerName(stewardRepo)}) { releases(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName isDraft } } }`);
  const fragment = employees.length ? `fragment R on Repository { ${PRS} ${RELEASES} } ` : '';
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
 * GitHub's answer to a glanceQuery, read: `gh api graphql` exits 1 when any part of the query failed (a repository
 * that isn't there, say), but still prints what it could answer, with `errors` for the rest.
 */
export function readGlance(employees: Employee[], answer: string, stewardRepo: string | null, into: Glance): void {
  let j: any;
  try {
    j = JSON.parse(answer);
  } catch {
    throw new Error(`GitHub's answer isn't JSON: ${answer.trim().split('\n').pop()?.slice(0, 200) || 'nothing'}`);
  }
  const data = j?.data;
  if (!data || typeof data !== 'object') throw new Error(String(j?.errors?.[0]?.message ?? j?.message ?? 'GitHub gave no data'));
  const why = (alias: string) => {
    const err = (Array.isArray(j.errors) ? j.errors : []).find((x: any) => Array.isArray(x?.path) && x.path[0] === alias);
    return String(err?.message ?? 'GitHub gave no answer for it');
  };
  if (stewardRepo) into.stewardReleases = data.steward ? (data.steward.releases?.nodes ?? []).map((x: any) => ({ tagName: String(x?.tagName ?? ''), isDraft: x?.isDraft === true })) : null;
  employees.forEach((e, i) => {
    const r = data[`e${i}`];
    if (r) into.repos[e.id] = repoFromGraph(r);
    else into.errors[e.id] = why(`e${i}`);
  });
}

/**
 * Every employee's repository, and the Steward's releases, from GitHub: one query (one more for each 15 employees
 * past the first 15). Throws when GitHub can't be asked at all (gh signed out, no network); an employee GitHub
 * couldn't answer for is in `errors`.
 */
export async function takeGlance(run: Runner, cwd: string, settings: Pick<Settings, 'employees' | 'stewardRepo'>): Promise<Glance> {
  const glance: Glance = { at: new Date().toISOString(), stewardReleases: null, repos: {}, errors: {} };
  const all = settings.employees;
  for (let i = 0; i === 0 || i < all.length; i += PER_QUERY) {
    const chunk = all.slice(i, i + PER_QUERY);
    const stewardRepo = i === 0 ? settings.stewardRepo : null;
    const r = await run('gh', ['api', 'graphql', '-f', `query=${glanceQuery(chunk, stewardRepo)}`], { cwd, timeoutMs: 2 * 60_000 });
    if (!r.out.trim()) throw new Error(`gh api graphql failed (${r.code}): ${(r.err || 'no output').trim().split('\n').slice(-3).join(' / ')}`);
    readGlance(chunk, r.out, stewardRepo, glance);
  }
  return glance;
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** What GitHub says of one employee's repository, as one value that changes when anything in it does. */
export function repoSig(g: RepoGlance): string {
  return sha({ head: g.head, prs: [...g.prs].sort((a, b) => Number(a.number) - Number(b.number)), releases: g.releases.map((r) => [r.tagName, r.isDraft, r.commit]).sort() });
}

/**
 * What a round's work for an employee rests on: its repository on GitHub, and the Settings that decide what a round
 * does with it (the employee's own, the team, the look at the Wright's drafts, catching up, releasing after merging).
 */
export function roundSig(e: Employee, g: RepoGlance, s: Pick<Settings, 'team' | 'wrightReview' | 'catchUp' | 'releaseAfterMerge'>): string {
  return sha({ repo: repoSig(g), employee: e, team: s.team, wrightReview: s.wrightReview, catchUp: s.catchUp, releaseAfterMerge: s.releaseAfterMerge });
}
