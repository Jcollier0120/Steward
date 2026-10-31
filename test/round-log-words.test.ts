import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from '../kit/test/until.ts';
import { roundLine, surveyorWarns } from './surveyor.ts';

// The Steward's lines that only say something is tried again, got round, passed over or planned don't read as a failure
// to the Surveyor (test/surveyor.ts), so they raise no warning on the owner's Manor; a line that says something failed
// still does. Each is as the code writes it, with its values filled in (trial.test.ts checks the trial's as they are written).

test('a line that only says something is tried again or no longer held raises no warning; its old words did', () => {
  const reworded: [string, string][] = [
    // stages/trial.ts: an agent whose main moved since the kit failed it, tried again with the same kit.
    ['[steward] Assayer moved on since kit 2.146.6 failed their checks: trying it again', '[steward] Assayer has changed since kit 2.146.6 didn\'t pass its checks there: trying it again'],
    ['[steward] Assayer, Reeve moved on since kit 2.146.6 failed their checks: trying them again', '[steward] Assayer, Reeve have changed since kit 2.146.6 didn\'t pass their checks there: trying them again'],
    // A verdict another Steward kept, tried again once.
    ["[steward] Assayer failed kit 2.146.6's checks as Steward 0.36.270 tried them: trying it again", "[steward] Assayer didn't pass kit 2.146.6's checks as Steward 0.36.270 tried them: trying it again"],
    // One Manor has retired since: no longer held against the kit.
    ["[steward] Sour failed kit 2.146.6's checks, and Manor has retired it since: no longer held against the kit", "[steward] Sour didn't pass kit 2.146.6's checks, and Manor has retired it since: no longer held against the kit"],
    ["[steward] Sour, Bitter failed kit 2.146.6's checks, and Manor has retired them since: no longer held against the kit", "[steward] Sour, Bitter didn't pass kit 2.146.6's checks, and Manor has retired them since: no longer held against the kit"],
    // A failure that looks like this PC's load, tried once more alone.
    ["[assayer] kit 2.146.6 trial: its failure may be this PC's load, not the kit's: tried once more, alone, once the rest are tried", "[assayer] kit 2.146.6 trial: it didn't pass, which may be this PC's load, not the kit's: tried once more, alone, once the rest are tried"],
  ];
  for (const [before, now] of reworded) {
    assert.ok(surveyorWarns(roundLine(before)), `the old words were a warning: ${before}`);
    assert.ok(!surveyorWarns(roundLine(now)), `no warning: ${now}`);
  }
  // fresh-start.ts, in serve.log as it is (not a round's line).
  assert.ok(surveyorWarns('2026-10-20T07:39:55.876Z the PC woke after 855 min: what failed before is tried again'));
  assert.ok(!surveyorWarns("2026-10-20T07:39:55.876Z the PC woke after 855 min: what didn't go through before is tried again"));
});

test("the PC waking, as fresh-start.ts writes it, raises no warning", async (t) => {
  const { watchWake, takeFreshStart, WOKE_AFTER_MS } = await import('../src/fresh-start.ts');
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => void lines.push(line));
  let now = 0;
  let woke = 0;
  const stop = watchWake(() => woke++, 5, () => now);
  now += WOKE_AFTER_MS + 1;
  await until(() => woke === 1, 10_000, 'the tick that sees the PC woke');
  stop();
  takeFreshStart('releases');
  takeFreshStart('tend');
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /the PC woke after \d+ min: what didn't go through before is tried again$/);
  assert.ok(!surveyorWarns(lines[0]), lines[0]);
});

test('a line that says something failed still raises a warning', () => {
  const failures = [
    // stages/trial.ts: an agent the kit fails, and the trial's count when one does.
    '[assayer] kit 2.146.6 trial: failed: npm test failed (exit 1): "a run that takes too long" (Expected values to be strictly equal)',
    "[steward] kit 2.146.6 tried on every agent: 30 passed, 1 failed, 2 failed without it too (not held against it), 3 not tried (nothing they take from the kit changes)",
    // stages/bump.ts: a step of an agent's checks, the change's failure, and the failure without the kit too.
    '[miller]   failed: "says what failed" (expected 1, got 2)',
    "[miller] they failed here, and on GAMING-010 (the Seneschal's s-12): the change's failure",
    '[miller] without the kit it fails otherwise (npm test failed (exit 1)): the failure stands',
    // stages/self.ts, stages/rollout.ts, steward.ts: a release held by its failure, a rollout's count, a stage that stopped.
    '[steward] v0.36.276 failed to release at abc1234 (npm ci failed (exit 1), so v0.36.276 wasn\'t released), so the rounds leave it until a new commit lands on main',
    "rollout: kit 2.146.6's rollout ended beside the rounds after 12 min: 4 PRs opened or updated, 1 failed",
    'release: git push failed: rejected',
    // tend.ts, recheck.ts: an agent's page that won't open, and a recheck that failed.
    "[miller] its page doesn't answer while on duty, and opening it through Manor failed (try 2): HTTP 500",
    'alarms: the recheck failed: EBUSY: resource busy or locked',
  ];
  for (const line of failures) assert.ok(surveyorWarns(roundLine(line)), `a warning still: ${line}`);
});
