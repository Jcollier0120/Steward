import assert from 'node:assert/strict';
import { test } from 'node:test';
import { glanceQuery, PER_QUERY, prFromGraph, readGlance, repoSig, takeGlance, type Glance } from '../src/glance.ts';
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
  assert.match(q, /^fragment R on Repository \{ pullRequests\(states: OPEN, first: 100/);
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

test('one gh call for up to 15 employees, one more for each 15 after; nothing printed is a failure', async () => {
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

test("a repository's signature changes with anything in it, and not with the order GitHub lists it in", () => {
  const g = empty();
  readGlance([porter], JSON.stringify({ data: { e0: graphRepo({ pullRequests: { nodes: [graphPr(), graphPr({ number: 8 })] } }) } }), null, g);
  const sig = repoSig(g.repos.porter);
  assert.equal(repoSig({ ...g.repos.porter, prs: [...g.repos.porter.prs].reverse() }), sig);
  assert.notEqual(repoSig({ ...g.repos.porter, head: 'd'.repeat(40) }), sig, 'its branch moved');
  assert.notEqual(repoSig({ ...g.repos.porter, prs: g.repos.porter.prs.map((p) => ({ ...p, isDraft: true })) }), sig, 'a PR changed');
  assert.notEqual(repoSig({ ...g.repos.porter, releases: [] }), sig, 'its releases changed');
});
