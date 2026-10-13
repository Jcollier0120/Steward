import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// A PR that conflicts with its branch at the lowest version mustn't stall the queue silently (Manor#226 held six ready
// PRs for five hours, 2026-10-12): once its conflict is handed on it gives up its turn; while it holds others up, an
// alarm comes within the hour; its author is told once; and a conflict left an hour goes to the Wright.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-conflict-stall-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
process.env.WRIGHT_HOME = path.join(tmp, 'no-wright');
process.env.BAILIFF_HOME = path.join(tmp, 'no-bailiff');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { GAVE_WAY, lookAgainAfter, mergeOne } = await import('../src/stages/merge.ts');
const { CONFLICTS, conflictsFile, handedOn, noteConflict } = await import('../src/conflicts.ts');
const { kickBack, kickbacksFile } = await import('../src/stages/kickback.ts');
const { reconcile, roundConditions } = await import('../src/alarms.ts');
const { closeResolved, conflictItems, fileWork, workFiledFile } = await import('../src/work.ts');
const { DEFAULT_SETTINGS, normalizeSettings } = await import('../src/settings.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const HOUR = 3_600_000;
const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const VERSION_FILES = ['package.json', 'package-lock.json', 'src/app.ts'];

beforeEach(() => {
  rmSync(conflictsFile(), { force: true });
  rmSync(kickbacksFile(), { force: true });
  rmSync(workFiledFile(), { force: true });
});

/** A fake employee at 0.4.0, and PRs on it, each a branch from main pushed as refs/pull/<n>/head setting a version. */
function employeeWithPrs(name: string) {
  const f = fakeEmployee(path.join(tmp, name), { version: '0.4.0' });
  const base = sh(f.checkout, 'rev-parse', 'HEAD');
  const make = (n: number, version: string) => {
    sh(f.checkout, 'switch', '--quiet', '--detach', base);
    for (const file of VERSION_FILES) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', version));
    mkdirSync(f.checkout, { recursive: true });
    writeFileSync(path.join(f.checkout, `change-${n}.txt`), `#${n}\n`);
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', `#${n}`);
    const sha = sh(f.checkout, 'rev-parse', 'HEAD');
    sh(f.checkout, 'push', '--quiet', '--force', 'origin', `${sha}:refs/pull/${n}/head`);
    sh(f.checkout, 'switch', '--quiet', 'main');
    return sha;
  };
  return { ...f, make };
}

const listed = (n: number, sha: string, o: Record<string, unknown> = {}) => ({
  number: n,
  title: `#${n}`,
  url: `https://github.com/Jcollier0120/Fake/pull/${n}`,
  headRefName: `claude/${n}`,
  headRefOid: sha,
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'Jcollier0120' },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: green,
  body: '',
  ...o,
});

const look = (o: { repo?: string; number: number; headOid: string; head?: string; outcome?: 'sent-back' | 'couldnt' | 'caught-up' | 'closed'; needs?: string[] }) => ({
  id: 'fake',
  name: 'Fake',
  repo: o.repo ?? 'Jcollier0120/Fake',
  number: o.number,
  url: `https://github.com/${o.repo ?? 'Jcollier0120/Fake'}/pull/${o.number}`,
  title: `#${o.number}`,
  head: o.head ?? `claude/${o.number}`,
  author: 'Jcollier0120',
  headOid: o.headOid,
  outcome: o.outcome ?? ('sent-back' as const),
  note: 'it conflicts with main in test/agents.test.ts: back with the Claude Code session that opened it, in a comment on it',
  files: ['package.json', ...(o.needs ?? ['test/agents.test.ts'])],
  needs: o.needs ?? ['test/agents.test.ts'],
});

test('a conflicting lowest version holds the PRs above it, which its hold names; once its conflict is handed on at that head it gives up its turn, a draft never', async () => {
  const f = employeeWithPrs('queue');
  const shas = { 20: f.make(20, '0.4.5'), 21: f.make(21, '0.4.6'), 22: f.make(22, '0.4.7') };
  const e = employee(f.checkout, { fill: '' });
  let prs = [listed(20, shas[20], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), listed(21, shas[21]), listed(22, shas[22])];
  const merged: number[] = [];
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok(prs.filter((p) => !merged.includes(p.number)));
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'pr' && args[1] === 'merge') {
      merged.push(Number(args[2]));
      return ok('');
    }
  });
  const round = () => mergeOne(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-queue'), run: r.run, neutralDir: tmp }), e, { yes: true, team: true });

  // Nobody told yet: it holds its place, and its hold says who waits behind it.
  const first = await round();
  assert.deepEqual(first.merged, [], first.message);
  assert.match(first.message, /#21 .* waits: its turn comes after #20 \(v0\.4\.5\)/);
  const held20 = first.held.find((h) => h.number === 20)!;
  assert.equal(held20.why, CONFLICTS);
  assert.deepEqual(held20.blocks, [21, 22]);
  assert.equal(first.held.find((h) => h.number === 21)!.blocks, undefined, 'a PR nothing waits after holds nothing up');

  // Handed on at another head (an older look): it still holds its place.
  noteConflict(look({ number: 20, headOid: 'f'.repeat(40) }));
  assert.equal(handedOn('Jcollier0120/Fake', 20, shas[20]), null);
  assert.deepEqual((await round()).merged, []);

  // Handed on at the head it has now: it gives up its turn, and the lowest of the rest merges.
  noteConflict(look({ number: 20, headOid: shas[20] }));
  const second = await round();
  assert.deepEqual(second.merged.map((p) => p.number), [21], second.message);
  const gave = second.held.find((h) => h.number === 20)!;
  assert.equal(gave.why, GAVE_WAY);
  assert.equal(gave.blocks, undefined);
  assert.match(second.message, /#22 .* waits: its turn comes after #21 \(v0\.4\.6\)/);

  // A draft keeps its place, handed on or not (the owner's rule).
  merged.length = 0;
  prs = [listed(20, shas[20], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', isDraft: true }), listed(21, shas[21])];
  const draft = await round();
  assert.deepEqual(draft.merged, [], draft.message);
  assert.match(draft.message, /#21 .* waits: its turn comes after #20/);
});

test('handedOn: only a look that sent it back, at that head, with files that need judgement', () => {
  noteConflict(look({ number: 30, headOid: 'a'.repeat(40) }));
  noteConflict(look({ number: 31, headOid: 'b'.repeat(40), outcome: 'couldnt' }));
  noteConflict(look({ number: 32, headOid: 'c'.repeat(40), needs: [] }));
  assert.ok(handedOn('Jcollier0120/Fake', 30, 'a'.repeat(40)));
  assert.equal(handedOn('Jcollier0120/Fake', 30, 'd'.repeat(40)), null);
  assert.equal(handedOn('Jcollier0120/Fake', 31, 'b'.repeat(40)), null, "one the Steward couldn't say holds its place, and its alarm comes");
  assert.equal(handedOn('Jcollier0120/Fake', 32, 'c'.repeat(40)), null);
  assert.equal(handedOn('Jcollier0120/Fake', 30, ''), null);
});

test('a look again follows a conflict handed on while it held others up', () => {
  assert.equal(lookAgainAfter({ merged: 0, held: [], testedHere: false, gaveWay: true }), true);
  assert.equal(lookAgainAfter({ merged: 0, held: [], testedHere: false }), false);
});

test('a conflicting PR holding others up is an alarm within the blocking hours; one holding nothing up, or a draft, waits the day', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  assert.equal(settings.alarms.blockingHours, 1);
  const e = { ...employee(tmp, { fill: '' }), id: 'manor', name: 'Manor', repo: 'Jcollier0120/Manor' };
  const pr = (n: number, o: Record<string, unknown> = {}) => ({ number: n, url: `https://github.com/Jcollier0120/Manor/pull/${n}`, title: `#${n}`, why: CONFLICTS, draft: false, ...o });
  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const held = [pr(226, { blocks: [227, 229], files: ['test/agents.test.ts'] }), pr(240), pr(241, { blocks: [242], draft: true }), pr(243, { why: 'checks failing', blocks: [244] })];
  const conditions = roundConditions({ round, held: [{ employee: e, prs: held }], failedReleases: {}, employees: [e], settings });
  const blocking = conditions.filter((c) => c.id.startsWith('blocking:'));
  assert.deepEqual(blocking.map((c) => c.id), ['blocking:Jcollier0120/Manor#226']);
  assert.equal(blocking[0].title, 'Manor #226 conflicts with main in test/agents.test.ts, and holds up #227, #229');
  assert.equal(blocking[0].afterMs, HOUR);
  assert.ok(blocking[0].detail.some((d) => d.includes('#227, #229 wait their turn after it')));
  assert.equal(conditions.filter((c) => c.id.startsWith('waiting:')).length, 4, 'the day-long wait stands for each');

  // Raised once it has lasted the hour, not before.
  const t0 = Date.parse('2026-10-12T22:05:00Z');
  const s1 = reconcile({ at: null, watching: {}, open: [], cleared: [] }, conditions, new Date(t0));
  const s2 = reconcile(s1.state, conditions, new Date(t0 + HOUR - 60_000));
  assert.deepEqual(s2.raised, []);
  const s3 = reconcile(s2.state, conditions, new Date(t0 + HOUR));
  assert.deepEqual(s3.raised.map((a) => a.id), ['blocking:Jcollier0120/Manor#226']);

  // The setting, kept within its bounds.
  assert.equal(normalizeSettings({ alarms: { blockingHours: 3 } }).settings.alarms.blockingHours, 3);
  assert.equal(normalizeSettings({ alarms: { blockingHours: 0 } }).settings.alarms.blockingHours, 1);
  assert.equal(normalizeSettings({ alarms: {} }).settings.alarms.blockingHours, 1);
});

test("its author is told once: not again as its branch moves on, again when the files it conflicts in change or it is pushed to", async () => {
  const comments: string[] = [];
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'comment') {
      comments.push(args[args.indexOf('--body') + 1]);
      return ok('');
    }
  });
  const e = { ...employee(tmp, { fill: '' }), repo: 'Jcollier0120/Fake' };
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-kick'), run: r.run, neutralDir: tmp });
  const pr = { number: 50, head: 'claude/50', headOid: 'a'.repeat(40), author: 'Jcollier0120', labels: [] as string[] } as any;
  const k1 = await kickBack(ctx, e, pr, ['test/agents.test.ts'], 'b1');
  assert.equal(k1.sent, true);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /Meanwhile it gives up its turn/);
  await kickBack(ctx, e, pr, ['test/agents.test.ts'], 'b2');
  await kickBack(ctx, e, pr, ['test/agents.test.ts'], 'b3');
  assert.equal(comments.length, 1, 'the branch moving on says nothing new');
  await kickBack(ctx, e, pr, ['test/agents.test.ts', 'src/server.ts'], 'b3');
  assert.equal(comments.length, 2, 'a new file in the conflict is said');
  await kickBack(ctx, e, { ...pr, headOid: 'c'.repeat(40) }, ['test/agents.test.ts', 'src/server.ts'], 'b3');
  assert.equal(comments.length, 3, 'a new push is a new conflict');
});

test("a conflict its author left the blocking hours goes to the Wright, the PR told once; never the Wright's own, a draft, or one told less than that ago", async () => {
  const e = { ...employee(tmp, { fill: '' }), id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter' };
  const t0 = new Date('2026-10-12T22:00:00Z');
  const pr = (n: number, o: Record<string, unknown> = {}) => ({ number: n, url: `https://github.com/Jcollier0120/Porter/pull/${n}`, title: `#${n}`, why: GAVE_WAY, draft: false, ...o });
  const at = (h: number) => new Date(t0.getTime() + h * HOUR).toISOString();
  const looks = [
    { ...look({ repo: 'Jcollier0120/Porter', number: 60, headOid: 'a'.repeat(40) }), firstAt: at(0), at: at(0), lookedAt: at(1) },
    { ...look({ repo: 'Jcollier0120/Porter', number: 61, headOid: 'b'.repeat(40), head: 'wright/12-x' }), firstAt: at(0), at: at(0), lookedAt: at(1) },
    { ...look({ repo: 'Jcollier0120/Porter', number: 62, headOid: 'c'.repeat(40) }), firstAt: at(0), at: at(0), lookedAt: at(1) },
    { ...look({ repo: 'Jcollier0120/Porter', number: 63, headOid: 'd'.repeat(40) }), firstAt: at(0), at: at(0.5), lookedAt: at(1) },
  ];
  const held = [{ employee: e, prs: [pr(60), pr(61), pr(62, { draft: true }), pr(63), pr(64, { why: 'checks failing' })] }];
  assert.deepEqual(conflictItems({ held, hours: 1, now: new Date(t0.getTime() + 59 * 60_000), looks }), []);
  const items = conflictItems({ held, hours: 1, now: new Date(t0.getTime() + HOUR), looks });
  assert.deepEqual(items.map((i) => [i.id, i.condition]), [['conflict:Jcollier0120/Porter#60:aaaaaaa', 'waiting:Jcollier0120/Porter#60']]);
  assert.match(items[0].title, /^Resolve #60's conflict with main \(test\/agents\.test\.ts\)$/);
  assert.match(items[0].body, /git merge --no-ff origin\/claude\/60/);

  // Filed where the Wright works, and the PR told once.
  const commented: string[][] = [];
  const gh = runner((args) => {
    if (args[0] === 'api' && args[1] === 'user') return ok('Jcollier0120\n');
    if (args[0] === 'issue' && args[1] === 'list') return ok([]);
    if (args[0] === 'issue' && args[1] === 'create') return ok('https://github.com/Jcollier0120/Porter/issues/70\n');
    if (args[0] === 'pr' && args[1] === 'comment') return commented.push(args), ok('');
  });
  const work = { takesWork: true, label: 'manor:work', repos: ['Jcollier0120/Porter'], team: ['Jcollier0120'], needsYou: [], recent: [] };
  const s1 = await fileWork({ items, work, employees: [e], run: gh.run, cwd: tmp, now: t0, log: () => {} });
  assert.equal(s1.get(items[0].id)?.state, 'filed');
  assert.equal(commented.length, 1);
  assert.deepEqual(commented[0].slice(0, 4), ['pr', 'comment', '60', '--repo']);
  assert.match(commented[0][commented[0].indexOf('--body') + 1], /handed it to the Wright: https:\/\/github\.com\/Jcollier0120\/Porter\/issues\/70/);
  await fileWork({ items, work, employees: [e], run: gh.run, cwd: tmp, now: t0, log: () => {} });
  assert.equal(commented.length, 1, 'filed already: nothing said again');

  // Its PR still conflicting: the issue stays. Resolved by its author: closed.
  let state = { state: 'OPEN', mergeable: 'CONFLICTING' };
  const closes: string[][] = [];
  const view = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return ok(state);
    if (args[0] === 'issue' && args[1] === 'close') return closes.push(args), ok('');
  });
  await closeResolved({ items: [], employees: [e], run: view.run, cwd: tmp, log: () => {} });
  assert.equal(closes.length, 0);
  await closeResolved({ items, employees: [e], run: view.run, cwd: tmp, log: () => {} });
  assert.equal(closes.length, 0, 'one this round still names stays');
  state = { state: 'OPEN', mergeable: 'MERGEABLE' };
  await closeResolved({ items: [], employees: [e], run: view.run, cwd: tmp, log: () => {} });
  assert.equal(closes.length, 1);
  assert.equal(closes[0][2], '70');
  assert.match(closes[0][closes[0].indexOf('--comment') + 1], /#60 no longer conflicts/);
  await closeResolved({ items: [], employees: [e], run: view.run, cwd: tmp, log: () => {} });
  assert.equal(closes.length, 1, 'forgotten once closed');
});

test('in one round: the lowest conflicts in code, its author is told, it gives up its turn, and the PR above it merges', async () => {
  const f = employeeWithPrs('one-round');
  // main moves on in a file the PR changes too: a conflict a catch-up can't settle.
  const base = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'switch', '--quiet', '--detach', base);
  for (const file of VERSION_FILES) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', '0.4.5'));
  writeFileSync(path.join(f.checkout, 'shared.txt'), 'the PR\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', '#80');
  const eighty = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', '--force', 'origin', `${eighty}:refs/pull/80/head`, `${eighty}:refs/heads/claude/80`);
  sh(f.checkout, 'switch', '--quiet', 'main');
  writeFileSync(path.join(f.checkout, 'shared.txt'), 'main\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'main moves on');
  sh(f.checkout, 'push', '--quiet', 'origin', 'HEAD:main');
  const eightyOne = f.make(81, '0.4.6');
  const e = employee(f.checkout, { fill: '' });
  const merged: number[] = [];
  const comments: string[] = [];
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([listed(80, eighty, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), listed(81, eightyOne)].filter((p) => !merged.includes(p.number)));
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'pr' && args[1] === 'merge') return merged.push(Number(args[2])), ok('');
    if (args[0] === 'pr' && args[1] === 'comment') return comments.push(args[args.indexOf('--body') + 1]), ok('');
  });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-one-round'), run: r.run, neutralDir: tmp });
  ctx.settings.catchUp = true;
  const { mergeLooks } = await import('../src/stages/merge.ts');
  const m = await mergeLooks(ctx, e, { yes: true, team: true });
  assert.deepEqual(merged, [81], m.message);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /conflicts with `main` in `shared\.txt`/);
  assert.equal(m.held.find((h) => h.number === 80)?.why.startsWith(GAVE_WAY), true, m.held.map((h) => h.why).join(' | '));
});
