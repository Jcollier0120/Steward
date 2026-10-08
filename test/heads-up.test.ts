import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// An early word about a draft coming up in a version queue (heads-up.ts): a comment on the draft, and the Bailiff woken
// for one of the Wright's, with gh and the Bailiff's page standing in.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-headsup-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { upcomingDrafts, UPCOMING_WITHIN } = await import('../src/version-queue.ts');
const { headsUp, headsUpComment } = await import('../src/heads-up.ts');
const { ctxFor, employee, ok, runner } = await import('./helpers.ts');
type VersionQueue = import('../src/version-queue.ts').VersionQueue;
type QueuedPr = import('../src/version-queue.ts').QueuedPr;

const pr = (number: number, version: string, o: Partial<QueuedPr> = {}): QueuedPr => ({ number, title: `#${number}`, url: `https://github.com/Jcollier0120/Porter/pull/${number}`, version, ready: false, why: 'a draft', head: `h${number}`, draft: false, ...o });
const queue = (id: string, prs: QueuedPr[], repo: string | null = `Jcollier0120/${id}`): VersionQueue => ({ id, name: id[0].toUpperCase() + id.slice(1), kind: 'agent', repo, branch: 'main', version: '0.5.0', head: 'x', files: [], queue: prs, working: prs[0]?.version ?? null, latest: null, note: null, at: 'x' });

test('a draft is coming up near the front of the line, or wherever it holds a ready PR back; front first', () => {
  const ready = { ready: true, why: null };
  const repos = [
    queue('porter', [pr(1, '0.5.1', ready), pr(2, '0.5.2', { draft: true, wright: true }), pr(3, '0.5.3', ready)]),
    queue('herald', [pr(4, '0.5.1', ready), pr(5, '0.5.2', ready), pr(6, '0.5.3', ready), pr(7, '0.5.4', { draft: true })]),
    queue('reeve', [pr(8, '0.5.1', ready), pr(9, '0.5.2', ready), pr(10, '0.5.3', ready), pr(11, '0.5.4', { draft: true }), pr(12, '0.5.5', ready)]),
    queue('wright', [pr(13, '0.5.1', { draft: true })]),
    queue('project', [pr(14, '0.5.1', { draft: true })], null),
  ];
  assert.equal(UPCOMING_WITHIN, 3);
  const up = upcomingDrafts(repos);
  assert.deepEqual(up.map((u) => [u.number, u.position, u.holds, u.wright]), [
    [13, 0, [], false],
    [2, 1, [3], true],
    [11, 3, [12], false],
  ], 'fourth in line with nothing behind it is not yet coming up; a queue with no repository is no one to tell');
});

test('each draft coming up is told once, and again only once it holds ready PRs back; the Bailiff is woken for the Wright\'s; never where the Steward does not merge', async () => {
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'comment' ? ok('') : undefined));
  const porter = employee(tmp, { id: 'porter', name: 'Porter', merges: true });
  const herald = employee(tmp, { id: 'herald', name: 'Herald', merges: false });
  const ctx = ctxFor({ employees: [porter, herald], workRoot: tmp, run: r.run, neutralDir: tmp });
  const pokes: string[] = [];
  const poke = async (url: string) => (pokes.push(url), { ok: true, said: 'HTTP 200' });
  const draft = (holds: number[]) => upcomingDrafts([queue('porter', [pr(20, '0.5.1', { draft: true, wright: true }), ...holds.map((n, i) => pr(n, `0.5.${i + 2}`, { ready: true, why: null }))]), queue('herald', [pr(30, '0.5.1', { draft: true })])]);
  const comments = () => r.gh.filter((a) => a[1] === 'comment');

  const first = await headsUp(ctx, draft([]), { bailiffUrl: 'http://127.0.0.1:19999', poke });
  assert.deepEqual(first, ['Jcollier0120/porter#20: told it is next in line', 'the Bailiff was asked to review the coming drafts now']);
  assert.equal(comments().length, 1, "the Herald's draft isn't told: the Steward doesn't merge its PRs");
  assert.deepEqual(comments()[0].slice(0, 5), ['pr', 'comment', '20', '--repo', 'Jcollier0120/porter']);
  assert.deepEqual(pokes, ['http://127.0.0.1:19999/api/run']);

  assert.deepEqual(await headsUp(ctx, draft([]), { bailiffUrl: 'http://127.0.0.1:19999', poke }), [], 'told once');
  assert.equal(comments().length, 1);

  const holding = await headsUp(ctx, draft([21, 22]), { bailiffUrl: 'http://127.0.0.1:19999', poke });
  assert.deepEqual(holding[0], 'Jcollier0120/porter#20: told it is next in line, holding #21 and #22');
  assert.equal(comments().length, 2);
  assert.equal(pokes.length, 2);
  assert.deepEqual(await headsUp(ctx, draft([21]), { bailiffUrl: 'http://127.0.0.1:19999', poke }), [], 'and then no more');
});

test('the comment says where it stands, what waits on it, and what to do', () => {
  const [wright, other] = upcomingDrafts([
    queue('porter', [pr(1, '0.5.1', { draft: true, wright: true }), pr(2, '0.5.2', { ready: true, why: null })]),
    queue('herald', [pr(3, '0.5.1', { ready: true, why: null }), pr(4, '0.5.2', { draft: true })]),
  ]);
  assert.equal(
    headsUpComment(wright),
    "**Heads-up from the Steward:** this draft is next in line in Porter, for v0.5.1. The Steward merges the lowest version first, and a draft holds its place. #2 is ready and waits on it.\n\nThe Bailiff is asked to review it ahead of the rest. If it needs a person, review it and mark it ready.",
  );
  assert.match(headsUpComment(other), /^\*\*Heads-up from the Steward:\*\* this draft is second in line in Herald, for v0\.5\.2\. .*\n\nMark it ready once it is done, or close it if it won't be: its version is then skipped/);
});
