import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { after, test } from 'node:test';

// Kit PRs queued one behind another, tried together once (stages/trial.ts's combineKits), and an agent whose failure
// looks like this PC's load tried once more, alone, before it holds the PR: on fake employees made with git in a
// temporary folder.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-kit-together-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { kitTrialHold, kitTrialsFile, TOGETHER, triedWith, underLoad, UNDER_LOAD, KIT_BREAKS_LABEL } = await import('../src/stages/trial.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');
const LOG = (...entries: string[]) => `# Kit\n\n${entries.map((e) => `## ${e}\n\nWhat ${e} brings.\n`).join('\n')}`;

// The Steward: main at kit 1.0.0; #7 raises it to 1.0.1 (a.ts), #8 to 1.0.2 (b.ts), both from main.
const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.0\n', 'kit/CHANGELOG.md': LOG('1.0.0'), 'kit/node/a.ts': 'export const a = 1;\n', 'kit/node/b.ts': 'export const b = 1;\n', 'tools/kit.ts': kitTool } });
const S = steward.checkout;
const main0 = sh(S, 'rev-parse', 'HEAD');
const commit = (files: Record<string, string>, message: string) => {
  for (const [f, text] of Object.entries(files)) writeFileSync(path.join(S, f), text);
  sh(S, 'add', '-A');
  sh(S, 'commit', '--quiet', '-m', message);
  return sh(S, 'rev-parse', 'HEAD');
};
sh(S, 'checkout', '--quiet', '-b', 'kit-a', main0);
const head7 = commit({ 'kit/VERSION': '1.0.1\n', 'kit/CHANGELOG.md': LOG('1.0.1', '1.0.0'), 'kit/node/a.ts': 'export const a = 2;\n' }, 'Kit 1.0.1');
sh(S, 'push', '--quiet', 'origin', 'HEAD:refs/pull/7/head');
sh(S, 'checkout', '--quiet', '-b', 'kit-b', main0);
const head8 = commit({ 'kit/VERSION': '1.0.2\n', 'kit/CHANGELOG.md': LOG('1.0.2', '1.0.0'), 'kit/node/b.ts': 'export const b = 2;\n' }, 'Kit 1.0.2');
sh(S, 'push', '--quiet', 'origin', 'HEAD:refs/pull/8/head');
sh(S, 'checkout', '--quiet', 'main');

const good = employee(fakeEmployee(path.join(tmp, 'good'), { files: { 'tools/kit.ts': kitTool } }).checkout, { id: 'good', name: 'Good' });
// Fails with kit 1.0.2 (#8's), passes with 1.0.1 (#7's) and without the kit.
const PICKY = "import { readFileSync } from 'node:fs';\nprocess.exit(JSON.parse(readFileSync('kit.json', 'utf8')).kit === '1.0.2' ? 1 : 0);\n";
const picky = employee(fakeEmployee(path.join(tmp, 'picky'), { files: { 'tools/kit.ts': kitTool, 'check.mjs': PICKY } }).checkout, { id: 'picky', name: 'Picky', test: ['node check.mjs'] });
const me = employee(S, { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward', usesKit: false });

const pr = (number: number, headOid: string, o: Partial<PrInfo> = {}): PrInfo => ({ number, title: `Steward 0.11.${number}, kit 1.0.${number - 6}`, url: `https://github.com/Jcollier0120/Steward/pull/${number}`, head: `claude/kit-${number}`, base: 'main', author: 'Jcollier0120', whose: 'team', headOid, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 3, files: ['kit/VERSION', 'kit/CHANGELOG.md', 'kit/node/x.ts'], ...o });

function ctx(employees = [good]) {
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'comment' ? ok('') : args[0] === 'pr' && args[1] === 'list' ? ok([]) : undefined));
  const c = ctxFor({ employees, workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
  return { c, r, comments: () => r.gh.filter((a) => a[1] === 'comment') };
}
const kept = () => JSON.parse(readFileSync(kitTrialsFile(), 'utf8'));
const tries = (lines: string[]) => lines.filter((l) => / trial: (done|failed|skipped)/.test(l));

test('the kit PRs queued behind the first are tried with it once, and a catch-up after the first merges keeps that trial for the next', async () => {
  rmSync(kitTrialsFile(), { force: true });
  const first = ctx();
  const notes: string[] = [];
  assert.equal(await kitTrialHold(first.c, me, pr(7, head7), { line: [pr(7, head7), pr(8, head8)], note: (w) => notes.push(w) }), null, first.c.lines.join('\n'));
  assert.match(first.c.lines.join('\n'), /#7 raises the kit to 1\.0\.1, and #8 queued after it to 1\.0\.2: trying their kit together \(main with each merged in, in turn\) on 1 agents/);
  assert.deepEqual(tries(first.c.lines).map((l) => l.split(':')[0]), ['[good] kit 1.0.2 trial'], 'each agent tried once, with the kit of both');
  assert.deepEqual(notes, ['kit tried on every agent together with #8, in one trial']);

  const all = kept();
  const key = `${TOGETHER}7@${head7}+8@${head8}`;
  assert.deepEqual(all[key].members.map((m: { number: number; kit: string; files: string[] }) => [m.number, m.kit, m.files]), [[7, '1.0.1', ['kit/CHANGELOG.md', 'kit/VERSION', 'kit/node/a.ts']], [8, '1.0.2', ['kit/CHANGELOG.md', 'kit/VERSION', 'kit/node/b.ts']]]);
  // The kit tried: main with both merged in.
  const tried = all[key].commit;
  assert.equal(sh(S, 'show', `${tried}:kit/node/a.ts`), 'export const a = 2;');
  assert.equal(sh(S, 'show', `${tried}:kit/node/b.ts`), 'export const b = 2;');
  assert.equal(sh(S, 'show', `${tried}:kit/VERSION`), '1.0.2');
  assert.match(sh(S, 'show', `${tried}:kit/CHANGELOG.md`), /## 1\.0\.2[\s\S]*## 1\.0\.1[\s\S]*## 1\.0\.0/, "both entries in the kit's changelog");
  // #7 merges with it, but its own kit is not all that was tried: its rollout runs the checks.
  assert.equal(all[`7@${head7}`].from, key);
  assert.deepEqual(all[`7@${head7}`].mains, {});
  assert.deepEqual(all[key].mains, { good: sh(good.checkout, 'rev-parse', 'origin/main') });

  // #7 merges; #8, its turn come, is caught up: kit/VERSION and the kit's changelog settled, as catchup.ts does.
  sh(S, 'merge', '--quiet', '--no-ff', '-m', 'Merge #7', head7);
  sh(S, 'push', '--quiet', 'origin', 'main');
  sh(S, 'checkout', '--quiet', 'kit-b');
  const m = (() => {
    try {
      sh(S, 'merge', '--quiet', '-m', 'Merge main into kit-b: caught up', 'origin/main');
    } catch {
      // Conflicts in kit/VERSION and the changelog only.
    }
    return commit({ 'kit/VERSION': '1.0.2\n', 'kit/CHANGELOG.md': LOG('1.0.2', '1.0.1', '1.0.0') }, 'Merge main into kit-b: caught up');
  })();
  sh(S, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/pull/8/head');
  sh(S, 'checkout', '--quiet', 'main');
  sh(S, 'fetch', '--quiet', 'origin');

  const next = ctx();
  const said: string[] = [];
  assert.equal(await kitTrialHold(next.c, me, pr(8, m), { line: [pr(8, m)], note: (w) => said.push(w) }), null, next.c.lines.join('\n'));
  assert.deepEqual(tries(next.c.lines), [], 'no agent tried again');
  assert.match(next.c.lines.join('\n'), /#8: kit tried on every agent together with #7, in one trial, and its kit at [0-9a-f]{7} is the one tried: not tried again/);
  assert.deepEqual(said, ['kit tried on every agent together with #7, in one trial']);
  const now = kept()[`8@${m}`];
  assert.deepEqual(now.mains, kept()[key].mains, 'the kit it releases is the one tried: its rollout needs no checks again');
  assert.equal(now.tree, sh(S, 'rev-parse', `${m}:kit`));
  assert.equal(now.kit, '1.0.2');
  assert.deepEqual(next.comments(), []);
});

test('kit PRs tried together that fail an agent hold no one: the first is tried alone, and so is each after it in turn', async () => {
  rmSync(kitTrialsFile(), { force: true });
  // Back to before #7 merged.
  sh(S, 'reset', '--quiet', '--hard', main0);
  sh(S, 'push', '--quiet', '--force', 'origin', 'main');
  sh(S, 'push', '--quiet', '--force', 'origin', `${head8}:refs/pull/8/head`);
  sh(S, 'fetch', '--quiet', 'origin');
  const together = ctx([good, picky]);
  assert.equal(await kitTrialHold(together.c, me, pr(7, head7), { line: [pr(7, head7), pr(8, head8)] }), null, together.c.lines.join('\n'));
  const lines = together.c.lines.join('\n');
  assert.match(lines, /\[picky\] kit 1\.0\.2 trial: failed/, 'the kit of both fails Picky');
  assert.match(lines, /#7 raises the kit to 1\.0\.1: trying it on 2 agents before it merges/, 'then #7 alone');
  assert.match(lines, /\[picky\] kit 1\.0\.1 trial: done/);
  assert.deepEqual(together.comments(), [], 'nothing said on #7: the failure was not its');
  assert.equal(kept()[`7@${head7}`].from, undefined);

  // #8's turn: tried alone too, and its failure is its own.
  const alone = ctx([good, picky]);
  assert.match((await kitTrialHold(alone.c, me, pr(8, head8), { line: [pr(8, head8)] })) ?? '', /kit 1\.0\.2 fails 1 agent's checks here \(Picky\)/, alone.c.lines.join('\n'));
  assert.equal(alone.comments().length, 1);
});

test('which kit PRs are tried with the first: the ready ones queued right after it, up to one that is a draft, labelled or from a fork', () => {
  const [a, b, c, d] = [pr(7, head7), pr(8, head8), pr(9, head8), pr(10, head8)];
  assert.deepEqual(triedWith(a, [a, b, c]).map((p) => p.number), [8, 9]);
  assert.deepEqual(triedWith(b, [a, b, c]).map((p) => p.number), [9], 'only those after it');
  assert.deepEqual(triedWith(a, [a, b, pr(9, head8, { draft: true }), d]).map((p) => p.number), [8], 'a draft ends the line');
  assert.deepEqual(triedWith(a, [a, pr(8, head8, { labels: [KIT_BREAKS_LABEL] }), c]).map((p) => p.number), []);
  assert.deepEqual(triedWith(a, [a, pr(8, head8, { fork: true }), c]).map((p) => p.number), []);
  assert.deepEqual(triedWith(a, [a, pr(8, head8, { files: ['src/app.ts'] })]).map((p) => p.number), [], 'one that raises no kit');
  assert.deepEqual(triedWith(a, [b, c]), [], 'not in the line: alone');
});

test('a failure that looks like load is tried once more, alone: one that passes then lets the kit merge; one that fails again holds it', async () => {
  rmSync(kitTrialsFile(), { force: true });
  // Fails its first two runs (the trial's try and its second) as Manor and the Assayer did under load on 2026-10-14,
  // then passes: without the kit, and once more alone.
  const counter = path.join(tmp, 'busy-runs');
  const BUSY = (fails: number) =>
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst at = ${JSON.stringify(counter)};\nconst n = existsSync(at) ? Number(readFileSync(at, 'utf8')) : 0;\nwriteFileSync(at, String(n + 1));\nconst kit = JSON.parse(readFileSync('kit.json', 'utf8')).kit;\nif (kit !== '1.0.0' && n < ${fails}) {\n  console.log("TAP version 13\\nnot ok 1 - removes its work folder\\n  ---\\n  error: 'EBUSY: resource busy or locked, rmdir work'\\n  ...\\n1..1");\n  process.exit(1);\n}\n`;
  const busy = employee(fakeEmployee(path.join(tmp, 'busy'), { files: { 'tools/kit.ts': kitTool, 'check.mjs': BUSY(2) } }).checkout, { id: 'busy', name: 'Busy', test: ['node check.mjs'] });
  const c = ctx([busy, good]);
  assert.equal(await kitTrialHold(c.c, me, pr(7, head7)), null, c.c.lines.join('\n'));
  const lines = c.c.lines;
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/\[busy\] kit 1\.0\.1 trial: its failure may be this PC's load/) >= 0, lines.join('\n'));
  assert.ok(at(/\[busy\] kit 1\.0\.1 trial: done/) > at(/\[good\] kit 1\.0\.1 trial: done/), 'tried again once the rest were');
  const t = kept()[`7@${head7}`];
  assert.deepEqual([t.passed, t.failed, t.retry], [2, [], undefined]);
  assert.deepEqual(c.comments(), []);

  // Failing every time with the kit: tried once more, and then it holds the PR.
  rmSync(kitTrialsFile(), { force: true });
  rmSync(counter, { force: true });
  const stuck = employee(fakeEmployee(path.join(tmp, 'stuck'), { files: { 'tools/kit.ts': kitTool, 'check.mjs': BUSY(99) } }).checkout, { id: 'stuck', name: 'Stuck', test: ['node check.mjs'] });
  const held = ctx([stuck]);
  assert.match((await kitTrialHold(held.c, me, pr(7, head7))) ?? '', /kit 1\.0\.1 fails 1 agent's checks here \(Stuck\)/, held.c.lines.join('\n'));
  assert.equal(held.c.lines.filter((l) => l.startsWith('[stuck] kit 1.0.1 trial: failed')).length, 2, 'tried twice in all, the second time alone');
  assert.match(kept()[`7@${head7}`].failed[0].message, /EBUSY.*tried once more, alone, after the rest: it failed again/);
});

test('what looks like load: a test killed, EBUSY, a run stopped at its time limit; or failing without the kit too, otherwise', () => {
  const failed = (message: string, without?: string) => ({ id: 'x', name: 'X', outcome: 'failed' as const, message, ...(without ? { without } : {}) });
  assert.ok(underLoad(failed('npm test failed (exit 1): "manor fire lamplighter" (Expected values to be strictly equal: null !== 1), twice')));
  assert.ok(underLoad(failed('node --test failed (exit 1): "a run that takes too long" ("EBUSY: resource busy or locked, rmdir \'C:\\\\Temp\\\\x\'")')));
  assert.ok(underLoad(failed('npm test failed (exit null), twice')));
  assert.ok(underLoad(failed('npm test was stopped at its time limit, after 20 min')));
  assert.ok(underLoad(failed('npm test failed (exit 1): "the label" (Expected "NPU" to equal "the NPU")', 'npm test failed (exit 1): "another test"')), 'fails without the kit too, otherwise');
  assert.ok(!underLoad(failed('npm test failed (exit 1): "the label" (Expected "NPU" to equal "the NPU"), twice')), "a test the kit breaks is the kit's");
  assert.ok(!underLoad({ ...failed('EBUSY'), outcome: 'done' as const }));
  assert.ok(!UNDER_LOAD.test('null !== undefined'));
});
