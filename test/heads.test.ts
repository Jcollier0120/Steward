import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The manor's branch heads kept fresh between rounds and after a merge (heads.ts): GitHub stood in for by a fake
// `ask`, the Steward's data and the shared file in a folder of their own.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-heads-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { githubRepos, headsMoved, keepHeads, lookAtHeads, readHeads, HEADS_EVERY_MS } = await import('../src/heads.ts');
const { GithubLimited, loadBudget, saveBudget, emptyBudget } = await import('../src/budget.ts');
const { readRemoteHeads } = await import('../src/kit/remote-heads.ts');
const { normalizeSettings } = await import('../src/settings.ts');
const { employee } = await import('./helpers.ts');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const RESET = new Date(Date.now() + 30 * 60_000).toISOString();
const rate = { cost: 1, limit: 5000, remaining: 4990, used: 10, resetAt: RESET };
const refs = (nodes: [string, string][], o: { total?: number; next?: string } = {}) => ({
  refs: { totalCount: o.total ?? nodes.length, pageInfo: { hasNextPage: !!o.next, endCursor: o.next ?? null }, nodes: nodes.map(([name, oid]) => ({ name, target: { oid } })) },
});

const settings = {
  ...normalizeSettings({}).settings,
  byItself: true,
  stewardRepo: 'Jcollier0120/Steward',
  employees: [
    employee('C:\\nowhere\\Porter', { id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter' }),
    employee('C:\\nowhere\\Heiward', { id: 'heiward', name: 'Heiward', repo: 'Jcollier0120/Heiward', branch: 'master' }),
    employee('C:\\nowhere\\Porter2', { id: 'porter2', name: 'Porter again', repo: 'jcollier0120/porter' }),
  ],
};

test('the repositories whose heads are shared: each employee on GitHub once, and the Steward\'s own', () => {
  assert.deepEqual(githubRepos(settings, null), ['Jcollier0120/Porter', 'Jcollier0120/Heiward', 'Jcollier0120/Steward']);
});

test('the heads are read as a glance reads them: a page of each in one query, the rest after, and a repository GitHub says nothing of is an error', async () => {
  const asked: string[] = [];
  const ask = async (q: string) => {
    asked.push(q);
    if (q.includes('after: "c1"')) return JSON.stringify({ data: { rateLimit: rate, h0: refs([['claude/y', C]], { total: 3 }) } });
    return JSON.stringify({ data: { rateLimit: rate, h0: refs([['main', A], ['claude/x', B]], { total: 3, next: 'c1' }), h1: null, h2: refs([['main', B]]) } });
  };
  const g = await readHeads(['Jcollier0120/Porter', 'Jcollier0120/Heiward', 'Jcollier0120/Steward'], ask);
  assert.equal(asked.length, 2);
  assert.match(asked[0], /h0: repository\(owner: "Jcollier0120", name: "Porter"\) \{ refs\(refPrefix: "refs\/heads\/", first: 100\)/);
  assert.doesNotMatch(asked[0], /after:|pullRequests|releases/, 'only the heads: no PRs, no releases');
  assert.deepEqual(g.heads!['Jcollier0120/Porter'], { heads: { main: A, 'claude/x': B, 'claude/y': C }, complete: true });
  assert.deepEqual(g.heads!['Jcollier0120/Steward'], { heads: { main: B }, complete: true });
  assert.deepEqual(Object.keys(g.errors), ['Jcollier0120/Heiward']);
  assert.equal(g.cost, 2);
});

test('a look shares them, waits while a round just did, reads a merged repository at once, and keeps to the budget', async () => {
  const file = path.join(tmp, 'remote-heads.json');
  saveBudget(emptyBudget());
  const asked: string[] = [];
  let reply = (q: string) => JSON.stringify({ data: { rateLimit: rate, ...Object.fromEntries([...q.matchAll(/(h\d+): repository/g)].map((m) => [m[1], refs([['main', A]])])) } });
  const ask = async (q: string) => (asked.push(q), reply(q));
  let now = new Date();
  const look = (o: Parameters<typeof lookAtHeads>[0] = {}) => lookAtHeads({ settings, ask, file, now: () => now, ...o });

  const first = await look();
  assert.deepEqual(first.shared, ['Jcollier0120/Porter', 'Jcollier0120/Heiward', 'Jcollier0120/Steward']);
  assert.deepEqual(Object.keys(readRemoteHeads(file)).sort(), ['github.com/jcollier0120/heiward', 'github.com/jcollier0120/porter', 'github.com/jcollier0120/steward']);
  assert.equal(readRemoteHeads(file)['github.com/jcollier0120/porter'].at, now.toISOString());
  assert.equal(loadBudget().graphql.length, 1, "what GitHub said is left is kept, as a glance's");
  assert.equal(loadBudget().glanceCost, null, "but not as the round's glance's cost");

  // A minute later: a round's glance (or this) shared them a moment ago, so GitHub isn't asked.
  now = new Date(now.getTime() + 60_000);
  assert.deepEqual(await look(), { shared: [], skipped: 'shared a moment ago' });
  assert.equal(asked.length, 1);
  // A merge: only its repository, at once, and never one that isn't an employee's on GitHub.
  const merged = await look({ repos: ['jcollier0120/PORTER', 'someone/else'], force: true });
  assert.deepEqual(merged.shared, ['Jcollier0120/Porter']);
  assert.doesNotMatch(asked[1], /else/);
  // Half the interval on: read again.
  now = new Date(now.getTime() + HEADS_EVERY_MS / 2);
  assert.equal((await look()).shared.length, 3);

  // GitHub refuses the account: noted, and nothing is asked of it until the window resets.
  reply = () => {
    throw new GithubLimited('API rate limit exceeded for user');
  };
  now = new Date(now.getTime() + HEADS_EVERY_MS);
  assert.match((await look()).skipped!, /^GitHub's API limit is reached/);
  const before = asked.length;
  now = new Date(now.getTime() + HEADS_EVERY_MS);
  assert.match((await look()).skipped!, /^GitHub's API budget: /);
  assert.equal(asked.length, before, 'not asked while the account is refused');
  saveBudget(emptyBudget());
});

test('the page keeps them: a merged repository is read a moment after, one look at a time, merges during one after it; only while it may', async () => {
  const looks: Parameters<typeof lookAtHeads>[0][] = [];
  const lines: string[] = [];
  let release = () => {};
  let hold: Promise<void> | null = null;
  let may = true;
  const stop = keepHeads({
    look: async (o) => {
      looks.push(o);
      if (hold) await hold;
      return { shared: o?.repos ?? [] };
    },
    may: () => may,
    log: (l) => lines.push(l),
    everyMs: 60 * 60_000,
    afterMergeMs: 5,
  });
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  try {
    hold = new Promise((r) => (release = () => r()));
    headsMoved('a/one');
    await settle();
    assert.deepEqual(looks, [{ repos: ['a/one'], force: true }]);
    // Two merges while that look runs: one look for both, after it.
    headsMoved('a/two');
    headsMoved('a/three');
    await settle();
    assert.equal(looks.length, 1);
    hold = null;
    release();
    await settle();
    assert.deepEqual(looks[1], { repos: ['a/two', 'a/three'], force: true });
    assert.ok(lines.includes('branch heads shared after the merge: a/two, a/three'), lines.join('\n'));
    // Off duty, Developer options off, or not merging by itself: nothing.
    may = false;
    headsMoved('a/four');
    await settle();
    assert.equal(looks.length, 2);
  } finally {
    stop();
  }
  may = true;
  headsMoved('a/five');
  await settle();
  assert.equal(looks.length, 2, 'stopped: no more looks');
});

test("the page's timer looks every so often, and says why it couldn't once, not at every look", async () => {
  const looks: Parameters<typeof lookAtHeads>[0][] = [];
  const lines: string[] = [];
  const stop = keepHeads({
    look: async (o) => (looks.push(o), { shared: [], skipped: "GitHub's API budget: spent" }),
    may: () => true,
    log: (l) => lines.push(l),
    everyMs: 10,
  });
  // Until it has looked twice: a fixed 100 ms saw one look on a PC busy with the whole suite, its timers running late.
  const until = Date.now() + 10_000;
  while (looks.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  stop();
  assert.ok(looks.length >= 2, String(looks.length));
  assert.deepEqual(looks[0], {});
  assert.deepEqual(lines, ["branch heads not read: GitHub's API budget: spent"]);
});
