import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// A kit PR its trial fails doesn't wait for its author (0.35.71): caught up when its branch changed the kit since it
// left it, and each agent it fails handed to the Wright as an issue in the agent's repository, closed once the kit no
// longer waits for it. Steward#214 (kit 2.69.0) held every Steward PR above it for a fix main already had.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-kittrial-work-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const { closeResolved, kitTrialItems, slotOf, workFiledFile, workItems } = await import('../src/work.ts');
const { kitMovedUnder, kitTrialsFile, trialFails, TRIAL_GOING } = await import('../src/stages/trial.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const settings = structuredClone(DEFAULT_SETTINGS);
settings.workRoot = path.join(home, 'work');
const steward = employee(path.join(home, 'no-steward'), { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward' });
const smith = employee(path.join(home, 'no-smith'), { id: 'smith', name: 'Smith', repo: 'Jcollier0120/Smith' });
const reeve = employee(path.join(home, 'no-reeve'), { id: 'reeve', name: 'Reeve', repo: 'Jcollier0120/Reeve' });
const employees = [steward, smith, reeve];

const HOLD = "kit 2.69.0 fails 2 agents' checks here (Smith, Reeve): its comment says which tests; fix the kit or the agents, open a ready PR to the agent that pins kit 2.69.0 and passes with it, or label it kit:breaks-agents";
const held = (more: { why?: string; draft?: boolean } = {}) => [{ employee: steward, prs: [{ number: 214, url: 'https://github.com/Jcollier0120/Steward/pull/214', title: 'Steward 0.35.61, kit 2.69.0: the graphics card on demand', why: more.why ?? HOLD, draft: more.draft ?? false }] }];
const failed = [
  { id: 'smith', name: 'Smith', message: 'npx tsc -p . --noEmit failed (exit 1), twice', main: '2152946f9a3a4c5ecbbf50f5752944aa1def5142' },
  { id: 'reeve', name: 'Reeve', message: 'node --test failed: "off: requests never go to the card"', main: 'abcdef0123456789abcdef0123456789abcdef01' },
];
const trial = (more = {}) => ({ kit: '2.69.0', failed, passed: 32, at: '2026-10-13T22:37:56Z', ...more });
const keep = (trials: Record<string, unknown>) => writeFileSync(kitTrialsFile(), JSON.stringify(trials));

beforeEach(() => {
  rmSync(workFiledFile(), { force: true });
  rmSync(kitTrialsFile(), { force: true });
});

test("a trial's last word names its kit, singular or plural; a trial going on, or any other hold, doesn't", () => {
  assert.equal(trialFails(HOLD), '2.69.0');
  assert.equal(trialFails("kit 2.70.0 fails 1 agent's checks here (Reeve): its comment says which tests"), '2.70.0');
  assert.equal(trialFails(`${TRIAL_GOING}: 3 of 34 so far, 1 failing (Reeve); the rounds go on meanwhile`), null);
  assert.equal(trialFails('its turn comes after #214 (v0.35.61): the lowest version merges first'), null);
});

test("each agent a kit PR's finished trial fails is work in its own repository, the kit's failures one of the day's few; not a draft's, nor while it is tried, nor one that moves with it", () => {
  keep({ '214@old': trial({ at: '2026-10-13T16:00:00Z', failed: [failed[0]] }), '214@03f3d5d': trial() });
  const items = kitTrialItems({ held: held(), employees, settings });
  assert.deepEqual(items.map((i) => [i.id, i.repo, i.condition]), [
    ['kittrial:smith:2.69.0', 'Jcollier0120/Smith', 'waiting:Jcollier0120/Steward#214'],
    ['kittrial:reeve:2.69.0', 'Jcollier0120/Reeve', 'waiting:Jcollier0120/Steward#214'],
  ]);
  assert.match(items[0].title, /^Make Smith pass with kit 2\.69\.0 \(the Steward's #214 waits for it\)$/);
  assert.match(items[1].body, /git fetch origin pull\/214\/head/);
  assert.match(items[1].body, /pins kit 2\.69\.0 in kit\.json/);
  assert.match(items[1].body, /If the kit is at fault/);
  assert.match(items[1].body, /<!-- steward:work:kittrial:reeve:2\.69\.0 -->/);
  assert.equal(slotOf(items[0].id), slotOf(items[1].id), "a kit's failures count as one");
  // Through the round's work, as alarms.ts asks for it.
  assert.deepEqual(workItems({ failedReleases: {}, employees, settings, held: held() }).map((i) => i.id), items.map((i) => i.id));

  assert.deepEqual(kitTrialItems({ held: held({ draft: true }), employees, settings }), [], 'a draft');
  assert.deepEqual(kitTrialItems({ held: held({ why: `${TRIAL_GOING}: 3 of 34 so far` }), employees, settings }), [], 'still being tried');
  keep({ '214@03f3d5d': trial({ pending: ['reeve'] }) });
  assert.deepEqual(kitTrialItems({ held: held(), employees, settings }), [], 'tried again: pending');
  const pairs = [{ id: 'reeve', name: 'Reeve', number: 170, head: 'x', ok: true, message: 'checks passed here' }];
  keep({ '214@03f3d5d': trial({ pairs }) });
  assert.deepEqual(kitTrialItems({ held: held(), employees, settings }).map((i) => i.id), ['kittrial:smith:2.69.0'], 'Reeve moves with it in #170');
  // Another repository's held PR, though worded the same, is no kit PR's.
  assert.deepEqual(kitTrialItems({ held: [{ ...held()[0], employee: reeve }], employees, settings }), []);
});

test("a kit trial's issue closes once the kit no longer waits for the agent, or its PR merged; it stays while the kit is tried again", async () => {
  const entry = (repo: string, n: number) => ({ url: `https://github.com/${repo}/issues/${n}`, number: n, repo, at: '2026-10-13T23:00:00Z', condition: 'waiting:Jcollier0120/Steward#214' });
  const filed = { 'kittrial:smith:2.69.0': entry('Jcollier0120/Smith', 5), 'kittrial:reeve:2.69.0': entry('Jcollier0120/Reeve', 9) };
  // Caught up and tried again: Smith passes now, Reeve still fails.
  writeFileSync(workFiledFile(), JSON.stringify(filed));
  keep({ '214@03f3d5d': trial(), '214@caught': trial({ at: '2026-10-14T03:00:00Z', failed: [failed[1]], passed: 33 }) });
  let state = 'OPEN';
  const r = runner((args) => (args[0] === 'issue' && args[1] === 'close' ? ok('') : args[0] === 'pr' && args[1] === 'view' ? ok({ state }) : undefined));
  const lines: string[] = [];
  await closeResolved({ items: [], employees, run: r.run, cwd: home, log: (l) => lines.push(l) });
  assert.deepEqual(r.gh.filter((a) => a[1] === 'close').map((a) => [a[2], a[4]]), [['5', 'Jcollier0120/Smith']]);
  assert.deepEqual(lines, ["work: closed https://github.com/Jcollier0120/Smith/issues/5: kit 2.69.0's trial on Jcollier0120/Steward#214 no longer waits for Smith"]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(workFiledFile(), 'utf8'))), ['kittrial:reeve:2.69.0']);

  // Tried again after a push: no verdict yet, and the PR open: it stays.
  keep({ '214@pushed': trial({ at: '2026-10-14T04:00:00Z', failed: [], passed: 0, pending: ['reeve'] }) });
  const quiet = runner((args) => (args[0] === 'pr' && args[1] === 'view' ? ok({ state: 'OPEN' }) : undefined));
  await closeResolved({ items: [], employees, run: quiet.run, cwd: home, log: () => {} });
  assert.equal(quiet.gh.filter((a) => a[1] === 'close').length, 0);

  // Merged (labelled kit:breaks-agents, say): nothing left for this issue.
  state = 'MERGED';
  await closeResolved({ items: [], employees, run: r.run, cwd: home, log: (l) => lines.push(l) });
  assert.match(lines.at(-1)!, /Jcollier0120\/Reeve\/issues\/9: Jcollier0120\/Steward#214 has merged/);
  assert.deepEqual(JSON.parse(readFileSync(workFiledFile(), 'utf8')), {});
});

test('a kit PR is caught up only when its branch changed the kit (kit\\ or tools/kit.ts) since it left it', async () => {
  const { checkout } = fakeEmployee(path.join(home, 'moved'), { files: { 'kit/VERSION': '2.68.0\n', 'tools/kit.ts': '// 1\n', 'README.md': 'x\n' } });
  const me = employee(checkout, { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward' });
  sh(checkout, 'checkout', '--quiet', '-b', 'claude/gpu');
  writeFileSync(path.join(checkout, 'kit', 'VERSION'), '2.69.0\n');
  sh(checkout, 'commit', '--quiet', '-am', 'kit 2.69.0');
  const head = sh(checkout, 'rev-parse', 'HEAD');
  sh(checkout, 'push', '--quiet', 'origin', `HEAD:refs/pull/214/head`);
  sh(checkout, 'checkout', '--quiet', 'main');
  const ctx = ctxFor({ employees: [me], workRoot: path.join(home, 'work'), run: runner().run, neutralDir: home });
  const pr = { number: 214, headOid: head } as Parameters<typeof kitMovedUnder>[2];
  const fetched = async () => {
    sh(checkout, 'push', '--quiet', 'origin', 'main');
    sh(checkout, 'fetch', '--quiet', 'origin');
    return kitMovedUnder(ctx, me, pr);
  };
  assert.equal(await fetched(), false, 'nothing new on main');
  writeFileSync(path.join(checkout, 'README.md'), 'y\n');
  sh(checkout, 'commit', '--quiet', '-am', 'docs');
  assert.equal(await fetched(), false, 'main moved, but not the kit');
  writeFileSync(path.join(checkout, 'tools', 'kit.ts'), '// 2\n');
  sh(checkout, 'commit', '--quiet', '-am', 'tools/kit.ts');
  assert.equal(await fetched(), true, "main's tools/kit.ts changed");
});
