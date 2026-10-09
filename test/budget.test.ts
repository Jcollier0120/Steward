import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// GitHub's API budget (budget.ts): the Steward keeps a tenth of the account's limit spare, spreads the rest over the
// hour, and waits for the reset when GitHub refuses it, with one line, not one failure per repository.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-budget-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const b = await import('../src/budget.ts');
type RateReading = import('../src/budget.ts').RateReading;
const { emptyBudget, gate, noteGlance, noteLimited, noteReading, believed, readingFrom, roundCost, spare, loadBudget, saveBudget, OPEN_SHARE, SHARE, WINDOW_MS, SECONDARY_WAIT_MS, UNKNOWN_WAIT_MS } = b;
const { runStage } = await import('../src/steward.ts');
const { fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');

const now = new Date('2026-10-09T21:36:17Z');
const reset = '2026-10-09T22:06:17.000Z'; // the window began at 21:06:17: half an hour in
const reading = (remaining: number, o: Partial<RateReading> = {}): RateReading => ({ limit: 5000, remaining, used: 5000 - remaining, resetAt: reset, at: now.toISOString(), ...o });
const withReading = (r: RateReading) => noteReading(emptyBudget(), r, now);

test("GitHub's rateLimit is read as it says it, not assumed; what isn't one is nothing", () => {
  assert.deepEqual(readingFrom({ cost: 15, limit: 5000, remaining: 3386, used: 1614, resetAt: '2026-10-09T22:06:17Z' }, now), reading(3386));
  assert.equal(readingFrom({ limit: 15000, remaining: 14000, resetAt: reset }, now)?.used, 1000, 'an Enterprise limit, and used worked out when not given');
  assert.equal(readingFrom(null, now), null);
  assert.equal(readingFrom({ limit: 5000, remaining: 10 }, now), null, 'no reset');
  assert.equal(readingFrom({ limit: 0, remaining: 0, resetAt: reset }, now), null);
});

test('readings: the newest of each window kept, windows that are over let go, and the one with least left believed', () => {
  let s = withReading(reading(4000));
  s = noteReading(s, reading(3900), now);
  assert.deepEqual(s.graphql.map((r) => r.remaining), [3900], 'the same window: the newer reading');
  // GitHub's REST and GraphQL counts have been seen a window apart: the gloomier is believed.
  s = noteReading(s, reading(4826, { resetAt: '2026-10-09T21:53:00.000Z' }), now);
  assert.equal(believed(s, now)?.remaining, 3900);
  assert.equal(believed(s, new Date('2026-10-09T22:00:00Z'))?.remaining, 3900);
  assert.equal(believed(s, new Date('2026-10-09T22:10:00Z')), null, 'every window over: nothing known');
  assert.deepEqual(noteReading(s, reading(5000, { resetAt: '2026-10-09T23:10:00.000Z' }), new Date('2026-10-09T22:10:00Z')).graphql.map((r) => r.remaining), [5000]);
});

test('a tenth of the limit is never spent: work that would reach into it waits for the reset', () => {
  assert.equal(spare(5000), 500);
  assert.deepEqual(gate(emptyBudget(), 100, now), { go: true }, 'nothing known yet: the glance will say');
  assert.deepEqual(gate(withReading(reading(700)), 100, now), { go: true });
  const g = gate(withReading(reading(560)), 100, now);
  assert.equal(g.go, false);
  assert.equal(!g.go && g.until, reset);
  assert.match(!g.go ? g.why : '', /560 of GitHub's 5000 points left this hour, and it keeps 500 spare/);
  assert.equal(gate(withReading(reading(560)), 100, new Date('2026-10-09T22:07:00Z')).go, true, 'after the reset');
});

test('paced: no more of the 90% than the hour so far allows, a quarter of it at any time; and until when it waits', () => {
  // Half an hour in, half of 4,500 may have been spent: 2,250.
  assert.equal(gate(withReading(reading(5000 - 2000)), 200, now, { paced: true }).go, true);
  const g = gate(withReading(reading(5000 - 2400)), 150, now, { paced: true });
  assert.equal(g.go, false, '2,550 is more than half the hour allows');
  // 2,550 of 4,500 is allowed 34 minutes in: 21:40:17.
  assert.equal(!g.go && g.until, new Date(Date.parse(reset) - WINDOW_MS + (2550 / (SHARE * 5000)) * WINDOW_MS).toISOString());
  assert.equal(gate(withReading(reading(5000 - 2400)), 150, now).go, true, 'unpaced (Run now): only the spare tenth counts');
  // At the window's start, a quarter may go at once.
  const early = new Date(Date.parse(reset) - WINDOW_MS + 60_000);
  assert.equal(gate(withReading(reading(5000 - 100)), 100, early, { paced: true }).go, true);
  assert.equal(gate(withReading(reading(5000 - OPEN_SHARE * SHARE * 5000)), 100, early, { paced: true }).go, false);
  // Late in the hour, nearly all of it; and a wait is never past the reset.
  const at = new Date('2026-10-09T22:05:00Z');
  assert.equal(gate(withReading(reading(5000 - 4300)), 50, at, { paced: true }).go, true);
  const late = gate(withReading(reading(5000 - 4400)), 50, at, { paced: true });
  assert.ok(!late.go && Date.parse(late.until) > at.getTime() && Date.parse(late.until) <= Date.parse(reset));
});

test('refused: nothing asked until the latest reset known, a few minutes after a secondary limit, a quarter hour when nothing says', () => {
  const s = noteLimited(withReading(reading(3000)), { now, secondary: false, restReset: '2026-10-09T21:53:00.000Z', why: 'refused' });
  assert.equal(s.limitedUntil, reset);
  assert.deepEqual(gate(s, 0, now), { go: false, until: reset, why: 'refused' });
  assert.equal(gate(s, 0, new Date('2026-10-09T22:07:00Z')).go, true);
  assert.equal(noteLimited(emptyBudget(), { now, secondary: false, restReset: reset, why: '' }).limitedUntil, reset, "REST's reset, when the readings have none");
  assert.equal(noteLimited(withReading(reading(3000)), { now, secondary: true, why: '' }).limitedUntil, new Date(now.getTime() + SECONDARY_WAIT_MS).toISOString());
  assert.equal(noteLimited(emptyBudget(), { now, secondary: false, restReset: null, why: '' }).limitedUntil, new Date(now.getTime() + UNKNOWN_WAIT_MS).toISOString());
  assert.equal(noteLimited(emptyBudget(), { now, secondary: false, restReset: '2026-10-10T09:00:00Z', why: '' }).limitedUntil, new Date(now.getTime() + WINDOW_MS + 5 * 60_000).toISOString(), 'never much over an hour');
  // A glance GitHub answered: not refused any more, and what it cost is what the next round's will.
  const after = noteGlance(s, { cost: 38, rates: [reading(2900)] }, now);
  assert.equal(after.limitedUntil, null);
  assert.equal(after.glanceCost, 38);
  assert.equal(roundCost(after, 38), 76);
  assert.equal(roundCost(emptyBudget(), 38), 78, 'before any glance: a point a repository, and the Steward');
});

// A round, on a data folder of its own, a fake employee's git, and gh standing in.
const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0' });
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: '', install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
  }),
);
let refuse = false;
let calls: string[][] = [];
const run = async (cmd: string, args: string[], opts?: any) => {
  calls.push([cmd, ...args]);
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  if (args[0] === 'api' && args[1] === 'rate_limit') return { code: 0, out: `${Date.parse(reset) / 1000}\n`, err: '' };
  if (refuse) return { code: 1, out: '', err: 'GraphQL: API rate limit already exceeded for user ID 9358221.' };
  if (args[0] === 'api' && args[1] === 'graphql') {
    const head = sh(f.origin, 'rev-parse', 'main');
    return ok({ data: { rateLimit: { cost: 2, limit: 5000, remaining: 4000, used: 1000, resetAt: reset }, steward: { releases: { nodes: [] } }, e0: { ref: { target: { oid: head } }, pullRequests: { totalCount: 0, nodes: [] }, releases: { nodes: [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null, tagCommit: { oid: head } }] } } } });
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};
const round = (full = false) => {
  calls = [];
  const lines: string[] = [];
  return runStage('round', full ? { full } : {}, { run, now: () => now, log: (l) => lines.push(l) }).then((out) => ({ out, lines }));
};
const ghCalls = () => calls.filter((c) => c[0] === 'gh' && !(c[1] === 'api' && c[2] === 'rate_limit'));

test("a round keeps what GitHub said of the budget: what's left, and what its glance cost", async () => {
  saveBudget(emptyBudget());
  await round();
  const s = loadBudget();
  assert.equal(s.glanceCost, 2);
  assert.equal(believed(s, now)?.remaining, 4000);
});

test('a round that would spend the spare tenth waits, asking GitHub nothing, with one line', async () => {
  saveBudget(noteGlance(withReading(reading(520)), { cost: 20 }, now));
  const { out, lines } = await round();
  assert.deepEqual(ghCalls(), [], 'nothing asked of GitHub');
  assert.deepEqual(out.budget, { until: reset, why: "520 of GitHub's 5000 points left this hour, and it keeps 500 spare" });
  assert.equal(lines.filter((l) => /GitHub's API budget/.test(l)).length, 1);
  assert.deepEqual(out.results.filter((r) => r.outcome === 'failed'), []);
  // Run now too: the spare tenth is never spent.
  assert.deepEqual(ghCalls(), []);
  assert.ok((await round(true)).out.budget);
});

test('a scheduled round paces itself through the hour; Run now goes, short of the spare tenth', async () => {
  saveBudget(noteGlance(withReading(reading(5000 - 2240)), { cost: 10 }, now));
  const paced = await round();
  assert.ok(paced.out.budget, 'half an hour in, 2,260 of 2,250 would be past the pace');
  assert.deepEqual(ghCalls(), []);
  const asked = await round(true);
  assert.equal(asked.out.budget, undefined);
  assert.ok(ghCalls().some((c) => c[1] === 'api' && c[2] === 'graphql'));
});

test("GitHub refusing the glance: one line, no repository asked on its own, and nothing asked until the reset", async () => {
  saveBudget(emptyBudget());
  refuse = true;
  try {
    const { out, lines } = await round();
    assert.deepEqual(ghCalls().map((c) => c.slice(1, 3).join(' ')), ['api graphql'], 'the glance alone: no gh pr list or gh release list for each repository');
    assert.equal(out.budget?.until, reset);
    assert.deepEqual(out.results.filter((r) => r.outcome === 'failed'), []);
    assert.equal(lines.filter((l) => /rate limit|API limit|API budget/i.test(l)).length, 2, "the refusal, and the round's wait");
    assert.equal(loadBudget().limitedUntil, reset);
    const next = await round();
    assert.deepEqual(ghCalls(), [], 'the next round asks nothing');
    assert.equal(next.out.budget?.until, reset);
  } finally {
    refuse = false;
  }
});
