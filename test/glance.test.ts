import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP } from '../src/app.ts';
import { GithubLimited } from '../src/budget.ts';
import { glanceQuery, headsFromGraph, PER_QUERY, PR_PAGE, prFromGraph, queryTimedOut, readGlance, repoSig, stewardPrsAsked, takeGlance, type Glance } from '../src/glance.ts';
import type { Runner } from '../src/run.ts';
import { appReleasesIn, parsePrs } from '../src/stages/staff.ts';
import { employee, ok } from './helpers.ts';

// GitHub at a glance: one query for every employee, read into what gh pr list and gh release list gave before.

const porter = employee('C:\\nowhere\\Porter', { id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter' });
const heiward = employee('C:\\nowhere\\Heiward', { id: 'heiward', name: 'Heiward', repo: 'Jcollier0120/Heiward', branch: 'master' });

/** A PR as GitHub's GraphQL gives it. */
const graphPr = (o: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Porter 0.4.2: a fix',
  url: 'https://github.com/Jcollier0120/Porter/pull/7',
  body: 'A fix.\n\n```steward\n{"after": ["release"]}\n```\n',
  headRefName: 'fix/thing',
  headRefOid: 'a'.repeat(40),
  baseRefName: 'main',
  isCrossRepository: false,
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  additions: 10,
  deletions: 2,
  author: { __typename: 'User', login: 'Jcollier0120' },
  labels: { nodes: [{ name: 'wright' }] },
  files: { nodes: [{ path: 'src/a.ts' }, { path: 'package.json' }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', state: 'PENDING' }] } } } }] },
  ...o,
});
const graphRepo = (o: Record<string, unknown> = {}) => ({
  pullRequests: { nodes: [graphPr()] },
  releases: { nodes: [{ tagName: 'v0.4.1', isDraft: false, publishedAt: '2026-10-04T10:00:00Z', tagCommit: { oid: 'b'.repeat(40) } }, { tagName: 'v0.4.2', isDraft: true, publishedAt: null, tagCommit: null }] },
  ref: { target: { oid: 'c'.repeat(40) } },
  ...o,
});
const empty = (): Glance => ({ at: '', stewardReleases: null, repos: {}, errors: {} });

test('one query asks for every employee by an alias of its own, with its branch, and the Steward\'s releases', () => {
  const q = glanceQuery([porter, heiward], 'Jcollier0120/Steward');
  assert.match(q, new RegExp(`^fragment R on Repository \\{ pullRequests\\(states: OPEN, first: ${PR_PAGE}, .*\\) \\{ totalCount nodes`));
  assert.match(q, /query \{ rateLimit \{ cost limit remaining used resetAt \} /, 'what it costs and what is left, asked in the query itself');
  assert.match(q, /steward: repository\(owner: "Jcollier0120", name: "Steward"\) \{ releases\(first: 100/);
  assert.match(q, /e0: repository\(owner: "Jcollier0120", name: "Porter"\) \{ \.\.\.R ref\(qualifiedName: "refs\/heads\/main"\)/);
  assert.match(q, /e1: repository\(owner: "Jcollier0120", name: "Heiward"\) \{ \.\.\.R ref\(qualifiedName: "refs\/heads\/master"\)/);
  assert.doesNotMatch(q, /\n/, 'one line, for the command line');
  assert.doesNotMatch(glanceQuery([], 'Jcollier0120/Steward'), /fragment/, 'no fragment without an employee to use it');
});

test("a PR from GraphQL reads as gh pr list's did: the same PrInfo, a GitHub App's author as app/<name>", () => {
  const fromGh = {
    ...graphPr(),
    author: { login: 'Jcollier0120' },
    labels: [{ name: 'wright' }],
    files: [{ path: 'src/a.ts' }, { path: 'package.json' }],
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', state: 'PENDING' }],
  };
  delete (fromGh as any).commits;
  assert.deepEqual(parsePrs(JSON.stringify([prFromGraph(graphPr())]), ['Jcollier0120']), parsePrs(JSON.stringify([fromGh]), ['Jcollier0120']));
  const [p] = parsePrs(JSON.stringify([prFromGraph(graphPr())]), ['Jcollier0120']);
  assert.deepEqual([p.checks, p.labels, p.files, p.changed, p.after?.steps], ['pending', ['wright'], ['src/a.ts', 'package.json'], 12, ['release']]);
  assert.equal(prFromGraph(graphPr({ author: { __typename: 'Bot', login: 'claude' } })).author.login, 'app/claude');
  assert.deepEqual(prFromGraph(graphPr({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).statusCheckRollup, [], 'no checks: none');
});

test("GitHub's answer is read even when part of it failed: a repository it couldn't find is an error of its own", () => {
  const g = empty();
  const answer = { data: { steward: { releases: { nodes: [{ tagName: 'kit-v2.9.0', isDraft: false }] } }, e0: graphRepo(), e1: null }, errors: [{ type: 'NOT_FOUND', path: ['e1'], message: "Could not resolve to a Repository with the name 'Jcollier0120/Heiward'." }] };
  readGlance([porter, heiward], JSON.stringify(answer), 'Jcollier0120/Steward', g);
  assert.deepEqual(g.stewardReleases, [{ tagName: 'kit-v2.9.0', isDraft: false }]);
  assert.equal(g.repos.porter.head, 'c'.repeat(40));
  assert.deepEqual(appReleasesIn(JSON.stringify(g.repos.porter.releases)).map((r) => r.version), ['0.4.1'], 'a draft is no release');
  assert.equal(g.repos.porter.releases[0].commit, 'b'.repeat(40));
  assert.deepEqual(g.errors, { heiward: "Could not resolve to a Repository with the name 'Jcollier0120/Heiward'." });
  assert.ok(!('heiward' in g.repos));
  assert.throws(() => readGlance([porter], 'gh: not logged in', null, empty()), /isn't JSON/);
  assert.throws(() => readGlance([porter], JSON.stringify({ errors: [{ message: 'Bad credentials' }] }), null, empty()), /Bad credentials/);
});

test(`one gh call for up to ${PER_QUERY} employees, one more for each ${PER_QUERY} after; nothing printed is a failure`, async () => {
  const calls: string[][] = [];
  const many = Array.from({ length: PER_QUERY + 2 }, (_, i) => employee('C:\\nowhere', { id: `e${i}x`, repo: `Jcollier0120/E${i}` }));
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const n = (args[3].match(/ e\d+: repository/g) ?? []).length;
    return ok({ data: { ...(args[3].includes('steward:') ? { steward: { releases: { nodes: [] } } } : {}), ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`e${i}`, graphRepo()])) } });
  };
  const g = await takeGlance(run, '.', { employees: many, stewardRepo: 'Jcollier0120/Steward' });
  assert.deepEqual(calls.map((c) => c.slice(0, 4).map((a) => a.slice(0, 6))), [['gh', 'api', 'graphq', '-f'], ['gh', 'api', 'graphq', '-f']]);
  assert.match(calls[0][4], /steward:/);
  assert.doesNotMatch(calls[1][4], /steward:/, 'the Steward\'s releases once');
  assert.equal(Object.keys(g.repos).length, PER_QUERY + 2);
  assert.deepEqual(g.stewardReleases, []);
  await assert.rejects(takeGlance(async () => ({ code: 1, out: '', err: 'gh: To get started with GitHub CLI, please run: gh auth login' }), '.', { employees: [porter], stewardRepo: 'x/y' }), /gh auth login/);
});

test("on a PC that shows the Steward's own repository in the staff's table, the glance reads it as an employee's, under its own id; elsewhere as before", async () => {
  assert.equal(stewardPrsAsked({ stewardRepo: 'Jcollier0120/Steward', stewardCheckout: 'C:\\Steward', releasesCastellan: true }), true);
  assert.equal(stewardPrsAsked({ stewardRepo: 'Jcollier0120/Steward', stewardCheckout: 'C:\\Steward', releasesCastellan: false }), false);
  assert.equal(stewardPrsAsked({ stewardRepo: 'Jcollier0120/Steward', stewardCheckout: 'C:\\Steward' }), false, 'the Steward merges no PRs (0.36.124): its own are read for its row alone');
  assert.equal(stewardPrsAsked({ stewardRepo: 'Jcollier0120/Steward', stewardCheckout: '', releasesCastellan: true }), false, 'no clone of it: no row for it here');
  assert.doesNotMatch(glanceQuery([porter], 'Jcollier0120/Steward'), /steward: repository\([^{]*\) \{ pullRequests/);
  assert.match(glanceQuery([porter], 'Jcollier0120/Steward', true), /steward: repository\([^{]*\) \{ pullRequests\(states: OPEN, first: 25, .* releases\(first: 100, .*tagCommit \{ oid \} .* main: ref/);
  assert.match(glanceQuery([], 'Jcollier0120/Steward', true), /^query \{ /, 'its PRs asked in its own part: no fragment needed');

  const own = { ...graphRepo(), ref: undefined, main: { target: { oid: 'd'.repeat(40) } }, kitVersion: { text: '2.9.0\n' }, packageJson: { text: '{"version":"0.35.1"}' }, pullRequests: { totalCount: 1, nodes: [graphPr()] } };
  const queries: string[] = [];
  const g = await takeGlance(async (_cmd, args) => (queries.push(args[3]), ok({ data: { steward: own, e0: graphRepo() } })), '.', { employees: [porter], stewardRepo: 'Jcollier0120/Steward', stewardCheckout: 'C:\\Steward', releasesCastellan: true });
  assert.match(queries[0], /steward: repository\([^{]*\) \{ pullRequests/);
  assert.equal(g.repos[APP.id].head, 'd'.repeat(40), "its main's head");
  assert.deepEqual(g.repos[APP.id].prs.map((p) => p.number), [7]);
  assert.equal(g.repos[APP.id].releases[0].commit, 'b'.repeat(40));
  assert.deepEqual(g.stewardReleases, [{ tagName: 'v0.4.1', isDraft: false, publishedAt: '2026-10-04T10:00:00Z' }, { tagName: 'v0.4.2', isDraft: true }], 'its releases as before, with when each was published (0.35.68)');
  assert.deepEqual(g.stewardMain, { head: 'd'.repeat(40), kit: '2.9.0', version: '0.35.1' });
  assert.deepEqual(Object.keys(g.errors), []);

  const many = empty();
  readGlance([], JSON.stringify({ data: { steward: { ...own, pullRequests: { totalCount: PR_PAGE + 1, nodes: [graphPr()] } } } }), 'Jcollier0120/Steward', many, new Date(), APP.id);
  assert.ok(!(APP.id in many.repos), 'more open than a glance reads: asked of GitHub as before');
  const notAsked = empty();
  readGlance([], JSON.stringify({ data: { steward: own } }), 'Jcollier0120/Steward', notAsked);
  assert.ok(!(APP.id in notAsked.repos), 'not asked: not filed');
});

test("each query's rateLimit is kept: what the glance cost, summed, and what GitHub said is left", async () => {
  const many = Array.from({ length: PER_QUERY + 1 }, (_, i) => employee('C:\\nowhere', { id: `e${i}x`, repo: `Jcollier0120/E${i}` }));
  let left = 4000;
  const run: Runner = async (_cmd, args) => {
    const n = (args[3].match(/ e\d+: repository/g) ?? []).length;
    left -= n;
    return ok({ data: { rateLimit: { cost: n, limit: 5000, remaining: left, used: 5000 - left, resetAt: '2026-10-09T22:06:17Z' }, ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`e${i}`, graphRepo()])) } });
  };
  const g = await takeGlance(run, '.', { employees: many, stewardRepo: '' });
  assert.equal(g.cost, PER_QUERY + 1);
  assert.deepEqual(g.rates?.map((r) => [r.limit, r.remaining, r.resetAt]), [[5000, 4000 - PER_QUERY, '2026-10-09T22:06:17.000Z'], [5000, 4000 - PER_QUERY - 1, '2026-10-09T22:06:17.000Z']]);
});

test("only GitHub giving up on a slow query splits it: any other failure, or one repository's alone, is the glance's", async () => {
  assert.ok(queryTimedOut(Object.assign(new Error('GitHub POST graphql: 502 <html>'), { status: 502 })));
  assert.ok(queryTimedOut(new Error('GitHub POST graphql: 504 <!DOCTYPE html>')));
  assert.ok(queryTimedOut(new Error('gh api graphql failed (1): HTTP 502: Bad Gateway (https://api.github.com/graphql)')));
  assert.ok(queryTimedOut(new Error('Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.')));
  assert.ok(!queryTimedOut(new Error('GitHub POST graphql: 401 Bad credentials')));
  assert.ok(!queryTimedOut(new Error('dial tcp 192.168.1.254:443: i/o timeout')), "the network's own failure isn't split: it fails the same in halves");
  const asked: number[] = [];
  const failing = (why: Error) => async (q: string) => {
    asked.push((q.match(/ e\d+: repository/g) ?? []).length);
    throw why;
  };
  await assert.rejects(takeGlance(async () => assert.fail('no gh'), '.', { employees: [porter, heiward], stewardRepo: '' }, undefined, undefined, failing(new Error('GitHub POST graphql: 401 Bad credentials'))), /401/);
  assert.deepEqual(asked.splice(0), [2]);
  await assert.rejects(takeGlance(async () => assert.fail('no gh'), '.', { employees: [porter, heiward], stewardRepo: '' }, undefined, undefined, failing(new Error('GitHub POST graphql: 502 <html>'))), /502/);
  assert.deepEqual(asked.splice(0), [2, 1], 'halves down to one repository, which fails the glance');
});

test(`a repository with more than ${PR_PAGE} open PRs is asked on its own, as one GitHub didn't answer for`, () => {
  const g = empty();
  readGlance([porter, heiward], JSON.stringify({ data: { e0: graphRepo({ pullRequests: { totalCount: PR_PAGE + 3, nodes: [graphPr()] } }), e1: graphRepo({ pullRequests: { totalCount: 1, nodes: [graphPr()] } }) } }), null, g);
  assert.ok(!('porter' in g.repos));
  assert.match(g.errors.porter, new RegExp(`${PR_PAGE + 3} open PRs`));
  assert.equal(g.repos.heiward.prs.length, 1);
});

test("GitHub refusing the account is told apart from any other failure, whether gh printed GitHub's answer or not", async () => {
  const limited = { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit already exceeded for user ID 9358221.' }] };
  assert.throws(() => readGlance([porter], JSON.stringify(limited), null, empty()), GithubLimited);
  await assert.rejects(takeGlance(async () => ({ code: 1, out: '', err: 'GraphQL: API rate limit already exceeded for user ID 9358221.' }), '.', { employees: [porter], stewardRepo: '' }), (e: unknown) => e instanceof GithubLimited && !e.secondary);
  await assert.rejects(takeGlance(async () => ({ code: 1, out: '', err: 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }), '.', { employees: [porter], stewardRepo: '' }), (e: unknown) => e instanceof GithubLimited && e.secondary);
  await assert.rejects(takeGlance(async () => ({ code: 1, out: '', err: 'gh: Bad credentials' }), '.', { employees: [porter], stewardRepo: '' }), (e: unknown) => !(e instanceof GithubLimited));
});

test("a repository's signature changes with anything in it, and not with the order GitHub lists it in", () => {
  const g = empty();
  readGlance([porter], JSON.stringify({ data: { e0: graphRepo({ pullRequests: { nodes: [graphPr(), graphPr({ number: 8 })] } }) } }), null, g);
  const sig = repoSig(g.repos.porter);
  assert.equal(repoSig({ ...g.repos.porter, prs: [...g.repos.porter.prs].reverse() }), sig);
  assert.notEqual(repoSig({ ...g.repos.porter, head: 'd'.repeat(40) }), sig, 'its branch moved');
  assert.notEqual(repoSig({ ...g.repos.porter, prs: g.repos.porter.prs.map((p) => ({ ...p, isDraft: true })) }), sig, 'a PR changed');
  assert.notEqual(repoSig({ ...g.repos.porter, releases: [] }), sig, 'its releases changed');
});

test("every branch head is read at a glance, for other agents to share (kit 2.58.0's remote-heads.json); the rest as before", () => {
  assert.match(glanceQuery([porter], null), /fragment R on Repository \{.*refs\(refPrefix: "refs\/heads\/", first: 100\) \{ totalCount pageInfo \{ hasNextPage endCursor \} nodes \{ name target \{ oid \} \} \}/);
  const g = empty();
  const refs = { totalCount: 2, nodes: [{ name: 'main', target: { oid: 'c'.repeat(40) } }, { name: 'claude/x', target: { oid: 'd'.repeat(40) } }] };
  readGlance([porter, heiward], JSON.stringify({ data: { e0: graphRepo({ refs }), e1: graphRepo({ refs: { ...refs, totalCount: 101 } }) } }), null, g);
  assert.deepEqual(g.heads, {
    'Jcollier0120/Porter': { heads: { main: 'c'.repeat(40), 'claude/x': 'd'.repeat(40) }, complete: true },
    'Jcollier0120/Heiward': { heads: { main: 'c'.repeat(40), 'claude/x': 'd'.repeat(40) }, complete: false },
  }, "one with more branches than a glance reads isn't complete");
  assert.equal(headsFromGraph(graphRepo()), null, 'an answer without them shares nothing');
});

test("the Steward's own repository's branch heads are shared too, though it isn't one of the employees", () => {
  assert.match(glanceQuery([porter], 'Jcollier0120/Steward'), /steward: repository\([^)]*\) \{.*refs\(refPrefix: "refs\/heads\/"/);
  const g = empty();
  const refs = { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: 'x' }, nodes: [{ name: 'main', target: { oid: 'e'.repeat(40) } }] };
  readGlance([porter], JSON.stringify({ data: { steward: { releases: { nodes: [] }, refs }, e0: graphRepo({ refs }) } }), 'Jcollier0120/Steward', g);
  assert.deepEqual(g.heads?.['Jcollier0120/Steward'], { heads: { main: 'e'.repeat(40) }, complete: true });
  assert.ok(g.heads?.['Jcollier0120/Porter']);
});

test('a repository with more branches than a page has the rest read after, all such repositories in one query a page', async () => {
  const page = (from: number, n: number, total: number, next: string | null) => ({
    totalCount: total,
    pageInfo: { hasNextPage: !!next, endCursor: next },
    nodes: Array.from({ length: n }, (_, i) => ({ name: `b${from + i}`, target: { oid: `${from + i}`.padEnd(40, 'f') } })),
  });
  const asked: string[] = [];
  // Porter: 250 branches, three pages; Heiward: 120, two; the Steward's own: 1.
  const ask = async (q: string) => {
    asked.push(q);
    if (q.startsWith('fragment')) return JSON.stringify({ data: { steward: { releases: { nodes: [] }, refs: page(0, 1, 1, null) }, e0: graphRepo({ refs: page(0, 100, 250, 'p1') }), e1: graphRepo({ refs: page(0, 100, 120, 'h1') }) } });
    const h = (alias: string, cursor: string) => new RegExp(`${alias}: repository\\([^)]*\\) \\{ refs\\(refPrefix: "refs/heads/", first: 100, after: "${cursor}"\\)`).test(q);
    if (h('h0', 'p1') && h('h1', 'h1')) return JSON.stringify({ data: { h0: { refs: page(100, 100, 250, 'p2') }, h1: { refs: page(100, 20, 120, null) } } });
    if (h('h0', 'p2') && !q.includes('h1:')) return JSON.stringify({ data: { h0: { refs: page(200, 50, 250, null) } } });
    return JSON.stringify({ data: null, errors: [{ message: `not asked here: ${q.slice(0, 80)}` }] });
  };
  const g = await takeGlance(async () => assert.fail('no gh'), '.', { employees: [porter, heiward], stewardRepo: 'Jcollier0120/Steward' }, undefined, undefined, ask);
  assert.equal(asked.length, 3, 'the glance, then one query a page for both');
  assert.deepEqual([g.heads?.['Jcollier0120/Porter'].complete, Object.keys(g.heads?.['Jcollier0120/Porter'].heads ?? {}).length], [true, 250]);
  assert.deepEqual([g.heads?.['Jcollier0120/Heiward'].complete, Object.keys(g.heads?.['Jcollier0120/Heiward'].heads ?? {}).length], [true, 120]);
  assert.equal(g.heads?.['Jcollier0120/Steward'].complete, true);

  // A page GitHub can't give: that repository stays incomplete, and the glance stands.
  const down = async (q: string) => (q.startsWith('fragment') ? ask(q) : Promise.reject(new Error('GitHub POST graphql: 502')));
  const h = await takeGlance(async () => assert.fail('no gh'), '.', { employees: [porter, heiward], stewardRepo: 'Jcollier0120/Steward' }, undefined, undefined, down);
  assert.equal(h.heads?.['Jcollier0120/Porter'].complete, false);
  assert.equal(Object.keys(h.repos).length, 2);
});
