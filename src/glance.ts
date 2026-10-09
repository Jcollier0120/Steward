import { createHash } from 'node:crypto';
import path from 'node:path';
import { expandEnv } from './kit/settings-kit.ts';
import { GithubLimited, LIMITED, readingFrom, type RateReading } from './budget.ts';
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
  stewardReleases: { tagName: string; isDraft: boolean }[] | null;
  /** The Steward's own main, or null when it couldn't be read (left out: an older glance). */
  stewardMain?: StewardMain | null;
  /** By employee id. One GitHub gave no answer for is left out, and `errors` says why. */
  repos: Record<string, RepoGlance>;
  errors: Record<string, string>;
  /** What its queries cost, in GraphQL points, and what GitHub said is left: each query's `rateLimit` (budget.ts). */
  cost?: number;
  rates?: RateReading[];
}

/** How many repositories one query asks about: GitHub allows 500,000 nodes a query, and each takes about 22,000. */
export const PER_QUERY = 15;

/**
 * The open PRs a glance reads of each repository. GitHub charges a query by the nodes it may return, and each PR's
 * labels, files and checks are a page each: at 100 PRs a repository cost 4 points, at 25 it costs 1 (budget.ts). One
 * with more open than this is asked on its own (readGlance), as one GitHub gave no answer for is.
 */
export const PR_PAGE = 25;

const PRS = `pullRequests(states: OPEN, first: ${PR_PAGE}, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes {
  number title url body headRefName headRefOid baseRefName isCrossRepository isDraft mergeable mergeStateStatus additions deletions
  author { __typename login }
  labels(first: 20) { nodes { name } }
  files(first: 100) { nodes { path } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state context } } } } } } }
} }`;
const RELEASES = 'releases(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName isDraft publishedAt tagCommit { oid } } }';

const ownerName = (repo: string) => {
  const [owner, name] = repo.split('/');
  return `owner: ${JSON.stringify(owner ?? '')}, name: ${JSON.stringify(name ?? '')}`;
};

/** The query for these employees (aliased e0, e1, …, in order), and the Steward's releases when `stewardRepo` is given. */
export function glanceQuery(employees: Employee[], stewardRepo: string | null): string {
  const parts = employees.map((e, i) => `e${i}: repository(${ownerName(e.repo)}) { ...R ref(qualifiedName: ${JSON.stringify(`refs/heads/${e.branch}`)}) { target { oid } } }`);
  if (stewardRepo) {
    const main = (file: string) => `object(expression: ${JSON.stringify(`${STEWARD_BRANCH}:${file}`)}) { ... on Blob { text } }`;
    parts.unshift(
      `steward: repository(${ownerName(stewardRepo)}) { releases(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName isDraft } } ` +
        `main: ref(qualifiedName: ${JSON.stringify(`refs/heads/${STEWARD_BRANCH}`)}) { target { oid } } kitVersion: ${main('kit/VERSION')} packageJson: ${main('package.json')} }`,
    );
  }
  // What it costs and what's left (budget.ts), asked in the query itself: free.
  parts.unshift('rateLimit { cost limit remaining used resetAt }');
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
 * that isn't there, say), but still prints what it could answer, with `errors` for the rest.
 */
export function readGlance(employees: Employee[], answer: string, stewardRepo: string | null, into: Glance, now = new Date()): void {
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
  if (stewardRepo) {
    into.stewardReleases = data.steward ? (data.steward.releases?.nodes ?? []).map((x: any) => ({ tagName: String(x?.tagName ?? ''), isDraft: x?.isDraft === true })) : null;
    into.stewardMain = data.steward ? stewardMainFrom(data.steward) : null;
  }
  employees.forEach((e, i) => {
    const r = data[`e${i}`];
    const open = Number(r?.pullRequests?.totalCount ?? 0);
    if (r && open > PR_PAGE) into.errors[e.id] = `${open} open PRs, more than a glance reads (${PR_PAGE})`;
    else if (r) into.repos[e.id] = repoFromGraph(r);
    else into.errors[e.id] = why(`e${i}`);
  });
}

/**
 * Every employee's repository, and the Steward's releases, from GitHub: one query (one more for each 15 employees
 * past the first 15). Throws when GitHub can't be asked at all (gh signed out, no network); an employee GitHub
 * couldn't answer for is in `errors`.
 *
 * A repository worked with plain git (`host`, scm.ts) isn't asked of GitHub: its branch head and its v<x.y.z> tags come
 * from one `git ls-remote` of its origin, in its clone, and it has no PRs. With none on GitHub (and no repository of
 * the Steward's own), gh isn't run at all. One worked with GitLab's way has no glance: each stage asks GitLab of it on
 * its own (hosts/gitlab.ts).
 */
export async function takeGlance(run: Runner, cwd: string, settings: Pick<Settings, 'employees' | 'stewardRepo'>, host: (e: Employee) => Host = () => 'github'): Promise<Glance> {
  const glance: Glance = { at: new Date().toISOString(), stewardReleases: null, stewardMain: null, repos: {}, errors: {} };
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
  for (let i = 0; i === 0 || i < all.length; i += PER_QUERY) {
    const chunk = all.slice(i, i + PER_QUERY);
    const stewardRepo = i === 0 ? settings.stewardRepo : null;
    const r = await run('gh', ['api', 'graphql', '-f', `query=${glanceQuery(chunk, stewardRepo)}`], { cwd, timeoutMs: 2 * 60_000 });
    if (!r.out.trim()) {
      const why = (r.err || 'no output').trim().split('\n').slice(-3).join(' / ');
      throw LIMITED.test(why) ? new GithubLimited(why) : new Error(`gh api graphql failed (${r.code}): ${why}`);
    }
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
 * does with it (the employee's own, the team, the look at the Wright's drafts, catching up, releasing after merging,
 * rolling a kit out); and, while it rolls kits out, the kit it would roll out: the newest kit release, and the kit this
 * Steward carries (stages/rollout.ts). So a new kit release, or the Steward updated to one, is something new for everyone.
 */
export function roundSig(e: Employee, g: RepoGlance, s: Pick<Settings, 'team' | 'wrightReview' | 'catchUp' | 'releaseAfterMerge' | 'rollout'>, kit: { newest: string | null; own: string | null } | null = null): string {
  return sha({ repo: repoSig(g), employee: e, team: s.team, wrightReview: s.wrightReview, catchUp: s.catchUp, releaseAfterMerge: s.releaseAfterMerge, ...(s.rollout ? { rollout: kit } : {}) });
}
