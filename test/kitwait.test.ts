import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// An agent's PR that takes a kit not yet released (Manor#135, kit 2.42.0): it waits for that kit, untested and not held
// against its commit, its hold naming the Steward PR that brings it; and a failure at its kit's fill is tried again once
// a newer kit is released.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-kitwait-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { deadKitComment, kitMayClear, kitReleaseHold, KIT_WAIT, tellDeadKit } = await import('../src/stages/prtest.ts');
const { deadKitIn, NEVER_RELEASED } = await import('../src/stages/kitpart.ts');
const { lookAtDraftKits } = await import('../src/stages/merge.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { ctxFor, ok } = await import('./helpers.ts');

const e = { id: 'manor', name: 'Manor', usesKit: true, fill: 'node tools/kit.ts', checkout: home } as unknown as import('../src/settings.ts').Employee;

test('a failure at its kit fill is tried again once a newer kit is released; any other failure, or a pass, is not', () => {
  const failed = { ok: false, note: 'its checks failed here at 3635fec, twice: node tools/kit.ts failed (exit 1)', at: '' };
  assert.equal(kitMayClear(e, failed, '2.42.0'), true, 'tested before a kit was kept: once more');
  assert.equal(kitMayClear(e, { ...failed, kit: '2.41.0' }, '2.42.0'), true, 'a newer kit since');
  assert.equal(kitMayClear(e, { ...failed, kit: '2.42.0' }, '2.42.0'), false, 'the same kit: it stands');
  assert.equal(kitMayClear(e, { ...failed, note: 'its checks failed here at 3635fec, twice: npm test failed (exit 1)' }, '2.42.0'), false, 'not its fill');
  assert.equal(kitMayClear(e, { ok: true, note: 'checks passed here at 3635fec', at: '' }, '2.42.0'), false);
  assert.equal(kitMayClear(e, failed, null), false, "the kit's releases unknown");
});

// The Steward's open PRs, as gh pr list gives them: #126 raises the kit to 2.42.0 (its title says so).
const stewardPrs = [{ number: 126, title: 'Steward 0.27.39, kit 2.42.0: one list of tracked repositories, in Manor', url: '', body: '', headRefName: 'claude/kit-tracked-repos', headRefOid: 'aaaa1111', baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], labels: [], additions: 1, deletions: 1, files: [{ path: 'kit/VERSION' }] }];

test("a PR whose kit.json pins a kit with no release waits for it, untested, naming the Steward PR that brings it; one whose kit is released doesn't", async () => {
  const pr = { number: 135, headOid: '3635fec939a0c67033f4cada00b94c457014781e' } as unknown as import('../src/stages/staff.ts').PrInfo;
  const pinned =
    (kit: string, open: unknown[] | null): import('../src/run.ts').Runner =>
    async (cmd, args) => {
      if (cmd === 'git' && args.includes('show')) return ok(JSON.stringify({ kit }));
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return open ? ok(open) : { code: 1, out: '', err: 'HTTP 502' };
      return ok('');
    };
  const ctx = (kit: string, released: string[], open: unknown[] | null = stewardPrs) => ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: pinned(kit, open), neutralDir: home, released });

  const waits = await kitReleaseHold(ctx('2.42.0', ['2.41.0', '2.40.0']), e, pr);
  assert.ok(waits?.startsWith(KIT_WAIT), String(waits));
  assert.equal(waits, "waits for kit 2.42.0, which Steward#126 brings: it merges once that's released");

  // No open Steward PR brings it: a real problem, said in plain words.
  assert.equal(await kitReleaseHold(ctx('2.42.0', ['2.41.0'], []), e, pr), "pins kit 2.42.0, which isn't released, and no open Steward PR brings it: release that kit, or pin a released one");
  assert.equal(await kitReleaseHold(ctx('2.43.0', ['2.41.0']), e, pr), "pins kit 2.43.0, which isn't released, and no open Steward PR brings it: release that kit, or pin a released one", 'another kit version is no help');
  // The Steward's PRs couldn't be listed: it still waits, untested.
  assert.equal(await kitReleaseHold(ctx('2.42.0', ['2.41.0'], null), e, pr), "waits for kit 2.42.0, which isn't released yet: it is tested here once it is");

  assert.equal(await kitReleaseHold(ctx('2.42.0', ['2.42.0', '2.41.0']), e, pr), null);
  assert.equal(await kitReleaseHold(ctx('2.42.0', []), e, pr), null, "the kit's releases unread: tested as before");
});

// Manor#276 (2026-10-16): a draft that pinned kit 2.78.3, Steward main's kit then. A build releases one kit, the top of
// the stack of every kit PR ready then, so most kits main has had are skipped (2.76.0, 2.77.9 and 2.78.0 to 2.78.3
// were), and a PR that pins one waits for good, its author told nothing.
const onMain = { ...e, repo: 'Jcollier0120/Manor', branch: 'main' } as typeof e;
const stewardHome = path.join(home, 'Steward');
mkdirSync(path.join(stewardHome, '.git'), { recursive: true });
type Comment = { n: string; body: string };
/** git and gh as the Steward's checkout and GitHub answer: the PR's kit.json pins `pin`, main's kit is `main`. */
const deadRun =
  (o: { pin: string; main: string | null; open?: unknown[]; comments?: Comment[]; refuse?: boolean }): import('../src/run.ts').Runner =>
  async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'show' && args[1] === 'origin/main:kit/VERSION') return o.main ? ok(`${o.main}\n`) : { code: 128, out: '', err: 'fatal: invalid object name' };
    if (cmd === 'git' && args[0] === 'show' && args[1]?.endsWith(':kit/VERSION')) return { code: 128, out: '', err: 'fatal: not here' };
    if (cmd === 'git' && args[0] === 'show') return ok(JSON.stringify({ kit: o.pin }));
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok(o.open ?? []);
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'comment') {
      if (o.refuse) return { code: 1, out: '', err: 'HTTP 502: Bad Gateway' };
      o.comments?.push({ n: args[2], body: args[args.indexOf('--body') + 1] });
      return ok('');
    }
    return ok('');
  };
const deadCtx = (o: Parameters<typeof deadRun>[0], released: string[]) => {
  const c = ctxFor({ employees: [onMain], workRoot: path.join(home, 'work'), run: deadRun(o), neutralDir: home, released });
  c.settings.stewardCheckout = stewardHome;
  return c;
};
const KEEP = "Keep main's pin in kit.json: once a build releases its kit, the rollout pins it on main, and the Steward's catch-up brings it to this PR";
const team = (number: number, more: Partial<import('../src/stages/staff.ts').PrInfo> = {}) =>
  ({ number, headOid: `c0ffee${String(number).padStart(34, '0')}`, head: `claude/pin-${number}`, base: 'main', author: 'Jcollier0120', labels: [], draft: false, whose: 'team', fork: false, title: `Manor #${number}`, url: `https://github.com/Jcollier0120/Manor/pull/${number}`, ...more }) as unknown as import('../src/stages/staff.ts').PrInfo;

test("a kit that will never be released is said so: a newer one is released, or the Steward's main is past it, and no open Steward PR brings it", async () => {
  const pr = team(276);
  assert.equal(await kitReleaseHold(deadCtx({ pin: '2.78.3', main: '2.78.10' }, ['2.78.10', '2.77.6']), onMain, pr), `pins kit 2.78.3, which will never be released: kit 2.78.10 is released already, and no open Steward PR brings it. ${KEEP}`);
  assert.equal(await kitReleaseHold(deadCtx({ pin: '2.78.3', main: '2.78.10' }, ['2.77.6']), onMain, pr), `pins kit 2.78.3, which will never be released: Steward's main has kit 2.78.10 already, and no open Steward PR brings it. ${KEEP}`);
  // Main's kit itself, not released yet: the next build may still release it, so it is as before.
  const before = "pins kit 2.78.3, which isn't released, and no open Steward PR brings it: release that kit, or pin a released one";
  assert.equal(await kitReleaseHold(deadCtx({ pin: '2.78.3', main: '2.78.3' }, ['2.77.6']), onMain, pr), before);
  assert.equal(await kitReleaseHold(deadCtx({ pin: '2.78.3', main: null }, ['2.77.6']), onMain, pr), before, "main's kit unread: as before");
  // An open Steward PR brings it: it waits for that one, whatever main has.
  const brings = [{ ...stewardPrs[0], number: 300, title: 'Kit 2.78.3: the stack' }];
  assert.equal(await kitReleaseHold(deadCtx({ pin: '2.78.3', main: '2.78.10', open: brings }, ['2.77.6']), onMain, pr), "waits for kit 2.78.3, which Steward#300 brings: it merges once that's released");

  assert.equal(deadKitIn(`a draft; it pins kit 2.78.3${NEVER_RELEASED}kit 2.78.10 is released already`), '2.78.3', "after a draft's own words");
  assert.equal(deadKitIn(before), null);
  assert.equal(deadKitIn("waits for kit 2.42.0, which Steward#126 brings: it merges once that's released"), null);
});

test('its author is told, in a comment on it, once for each commit; one the Steward could not say is tried again', async () => {
  const comments: Comment[] = [];
  const ctx = deadCtx({ pin: '2.78.3', main: '2.78.10', comments }, ['2.77.6']);
  const pr = team(281);
  const why = (await kitReleaseHold(ctx, onMain, pr))!;
  assert.equal(await tellDeadKit(ctx, onMain, pr, why), '#281 pins kit 2.78.3, which will never be released: its author was told, in a comment on it');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].n, '281');
  assert.ok(comments[0].body.startsWith(`**The Steward can't merge this:** it ${why}.`), comments[0].body);
  assert.match(comments[0].body, /Over to the Claude Code session that opened it: put `kit\.json` back as `main` has it/);
  assert.match(comments[0].body, /node tools\/kit\.ts --from <Steward checkout>\\kit/);
  assert.equal(await tellDeadKit(ctx, onMain, pr, why), null, 'the same commit: said once');
  assert.equal(comments.length, 1);

  const pushed = { ...pr, headOid: 'beef'.repeat(10) };
  const refused = deadCtx({ pin: '2.78.3', main: '2.78.10', refuse: true }, ['2.77.6']);
  assert.equal(await tellDeadKit(refused, onMain, pushed, why), "#281 pins kit 2.78.3, which will never be released: the Steward couldn't say so on it (HTTP 502: Bad Gateway)");
  assert.match((await tellDeadKit(ctx, onMain, pushed, why))!, /its author was told/, 'a new commit, and the one not said before: told now');
  assert.equal(comments.length, 2);

  const words = deadKitComment({ author: 'pat', draft: true }, 'main', why, 'person');
  assert.match(words, /Over to you, @pat: put `kit\.json` back/);
  assert.match(words, /waits for good, once it is marked ready\./);
});

test("a draft's kit.json is looked at too, as a ready PR's is: one whose kit will never be released is told, and its hold raises the alarm at once", async () => {
  // A draft never reached kitReleaseHold: holdReason holds it as "a draft" first, so Manor#276 was told nothing.
  const comments: Comment[] = [];
  const ctx = deadCtx({ pin: '2.78.3', main: '2.78.10', comments }, ['2.77.6']);
  const dead = await lookAtDraftKits(ctx, onMain, [team(276, { draft: true }), team(282), team(283, { draft: true, whose: 'steward' }), team(284, { draft: true, base: 'release' })]);
  assert.deepEqual([...dead.keys()], [276], "only the team's drafts into main: a ready PR is the merge's to look at");
  assert.equal(dead.get(276), `pins kit 2.78.3, which will never be released: Steward's main has kit 2.78.10 already, and no open Steward PR brings it. ${KEEP}`);
  assert.deepEqual(
    comments.map((c) => c.n),
    ['276'],
  );
  assert.match(comments[0].body, /waits for good, once it is marked ready\./);
  assert.equal((await lookAtDraftKits(deadCtx({ pin: '2.77.6', main: '2.78.10' }, ['2.77.6']), onMain, [team(285, { draft: true })])).size, 0, 'a released kit: nothing to say');
  assert.equal((await lookAtDraftKits(deadCtx({ pin: '2.78.3', main: '2.78.3' }, ['2.77.6']), onMain, [team(286, { draft: true })])).size, 0, "main's own kit: it may still be released");

  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const held = [
    { number: 276, url: team(276).url, title: team(276).title, why: `a draft; it ${dead.get(276)}`, draft: true },
    { number: 135, url: '', title: 'Manor #135', why: "waits for kit 2.42.0, which Steward#126 brings: it merges once that's released", draft: false },
  ];
  const alarms = roundConditions({ round, held: [{ employee: onMain, prs: held }], failedReleases: {}, employees: [onMain], settings: ctx.settings }).filter((c) => c.id.startsWith('deadkit:'));
  assert.deepEqual(
    alarms.map((c) => [c.id, c.title, c.afterMs, c.url]),
    [['deadkit:Jcollier0120/Manor#276', 'Manor #276 pins kit 2.78.3, which will never be released', 0, team(276).url]],
  );
  assert.equal(alarms[0].detail[1], `Steward's main has kit 2.78.10 already, and no open Steward PR brings it. ${KEEP}.`);
});
