import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The agents Manor has retired (retired.ts): read from its staff.json, and passed over by the rounds' kit rollout and
// releases, while one held back until its first release still takes every kit. On a data folder of its own; nothing
// reaches GitHub, the live ~/.steward or this PC's Manor.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-retired-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { RETIRED, retiredOf, retiredStaff } = await import('../src/retired.ts');
const { planRollout, rollout, rolloutFailedFile } = await import('../src/stages/rollout.ts');
const { releaseUnreleased, roundFailuresFile } = await import('../src/stages/round.ts');
const { ctxFor, employee, runner } = await import('./helpers.ts');

/** A Manor home whose app\staff.json lists these agents. */
function manorWith(agents: Record<string, unknown>[]): string {
  const m = mkdtempSync(path.join(home, 'manor-'));
  mkdirSync(path.join(m, 'app'), { recursive: true });
  writeFileSync(path.join(m, 'app', 'staff.json'), `\uFEFF${JSON.stringify({ agents })}`);
  return m;
}

const aletaster = employee('C:\\nowhere\\Aletaster', { id: 'aletaster', name: 'Aletaster', repo: 'Jcollier0120/Aletaster' });
const seneschal = employee('C:\\nowhere\\Seneschal', { id: 'seneschal', name: 'Seneschal', repo: 'Jcollier0120/Seneschal' });
const porter = employee('C:\\nowhere\\Porter', { id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter' });
const H1 = 'a'.repeat(40);
const facts = (pin: string) => ({ checkout: true, head: H1, pin, kitPrs: [] as string[] });

test("the retired are those Manor's staff.json marks retired and held back, as Manor reads them; none without a Manor", () => {
  const m = manorWith([
    { id: 'butler', heldBack: true, retired: true },
    { id: 'Aletaster', heldBack: true, retired: true },
    { id: 'auditor', heldBack: true, retired: true },
    { id: 'seneschal', heldBack: true, heldBackNote: 'Coming soon: its first release is on its way.' },
    { id: 'porter' },
    { id: 'odd', retired: true },
    { heldBack: true, retired: true },
  ]);
  assert.deepEqual([...retiredStaff(m)].sort(), ['aletaster', 'auditor', 'butler'], 'held back until its first release is not retired; nor one not held back');
  assert.deepEqual([...retiredStaff(path.join(home, 'no-manor'))], [], 'no Manor here');
  const broken = mkdtempSync(path.join(home, 'broken-'));
  mkdirSync(path.join(broken, 'app'));
  writeFileSync(path.join(broken, 'app', 'staff.json'), '{ not json');
  assert.deepEqual([...retiredStaff(broken)], [], 'unreadable: none');
  // A stage's own stand-in wins; else Manor's (MANOR_HOME), read as it is now.
  assert.deepEqual([...retiredOf({ retired: new Set(['x']) })], ['x']);
  const before = process.env.MANOR_HOME;
  process.env.MANOR_HOME = m;
  try {
    assert.ok(retiredOf({}).has('auditor'));
  } finally {
    process.env.MANOR_HOME = before;
  }
});

test('a new kit is rolled out to every employee behind it but the retired; one held back until its first release takes it', () => {
  const plan = planRollout({
    on: true,
    kit: '2.9.1',
    ownKit: '2.9.1',
    employees: [aletaster, seneschal, porter],
    facts: { aletaster: facts('2.9.0'), seneschal: facts('2.9.0'), porter: facts('2.9.0') },
    failed: { aletaster: { kit: '2.9.1', head: H1, stage: 'bump', message: 'tests failed', at: '2026-10-18T10:00:00Z' } },
    retired: new Set(['aletaster']),
  });
  assert.deepEqual(plan.bump.map((b) => b.employee.id), ['seneschal', 'porter']);
  assert.deepEqual(plan.skip.map((s) => [s.employee.id, s.why, !!s.held]), [['aletaster', RETIRED, false]], 'passed over, not held: its failed bump is no alarm');
  // None retired: as before.
  assert.deepEqual(planRollout({ on: true, kit: '2.9.1', ownKit: '2.9.1', employees: [aletaster], facts: { aletaster: facts('2.9.0') }, failed: {} }).bump.length, 1);
});

test("a round's rollout doesn't look at a retired agent's branch, and lets go of a bump of it that failed", async () => {
  writeFileSync(rolloutFailedFile(), JSON.stringify({ aletaster: { kit: '2.9.0', head: H1, stage: 'bump', message: 'tests failed', at: '2026-10-17T10:00:00Z' } }));
  const r = runner();
  const ctx = { ...ctxFor({ employees: [aletaster, porter], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home }), retired: new Set(['aletaster']), build: { due: '2026-10-18T13:00:00Z', name: 'the 13:00 build' } };
  const { plan, results } = await rollout(ctx, [aletaster, porter], { kit: '2.9.1', ownKit: '2.9.1', changelog: async () => null });
  assert.deepEqual(plan.skip.map((s) => [s.employee.id, s.why]), [['aletaster', RETIRED], ['porter', 'no checkout at C:\\nowhere\\Porter']], 'the retired one passed over before its checkout is looked for');
  assert.deepEqual([plan.bump, results], [[], []]);
  assert.deepEqual(JSON.parse(readFileSync(rolloutFailedFile(), 'utf8')), {}, 'no failed bump of it held, so no alarm');
  assert.deepEqual(r.gh, [], 'GitHub asked nothing');
});

test("a round releases no version of a retired agent, and lets go of a release of it that failed", async () => {
  writeFileSync(roundFailuresFile(), JSON.stringify({ aletaster: 'abc1234', porter: 'def5678' }));
  const r = runner();
  const ctx = { ...ctxFor({ employees: [aletaster], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home }), retired: new Set(['aletaster']) };
  const [out] = await releaseUnreleased(ctx, [aletaster]);
  assert.deepEqual([out.id, out.outcome, out.message], ['aletaster', 'skipped', RETIRED]);
  assert.deepEqual(JSON.parse(readFileSync(roundFailuresFile(), 'utf8')), { porter: 'def5678' }, "its failed release no longer stands; another's does");
  assert.deepEqual(r.gh, [], 'GitHub asked nothing');
});
