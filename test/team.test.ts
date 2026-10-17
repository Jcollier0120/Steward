import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The team when Settings name none: the account gh is signed in as on this PC (the kit's githubOwner()), and, when gh
// isn't signed in, no team at all, said wherever the team is used.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-team-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { NO_TEAM, realOwner, teamOf } = await import('../src/team.ts');
const { context, withTeam } = await import('../src/steward.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');

test("Settings' own team is used as it is, and gh isn't asked", () => {
  let asked = 0;
  const t = teamOf(['someone', 'app/claude'], () => (asked++, 'owner'));
  assert.deepEqual([t.team, t.from, t.note, asked], [['someone', 'app/claude'], 'settings', null, 0]);
});

test('an empty team is the account gh is signed in as; with none signed in, no team, and the page says why', () => {
  const t = teamOf([], () => 'octo-owner');
  assert.deepEqual([t.team, t.from], [['octo-owner'], 'gh']);
  assert.match(t.note!, /gh is signed in as \(octo-owner\)/);
  const none = teamOf([], () => null);
  assert.deepEqual([none.team, none.from], [[], 'none']);
  assert.match(none.note!, /gh isn't signed in \(gh auth login\)/);
  assert.equal(realOwner(), null, 'under node --test the real gh is never asked');
});

test("the stages' context takes the derived team; with none, the log says so and nothing crashes", async () => {
  const s = { ...structuredClone(DEFAULT_SETTINGS), employees: [] };
  assert.deepEqual((await context({ settings: s, glance: false, offline: true, owner: () => 'octo-owner' })).settings.team, ['octo-owner']);
  const lines: string[] = [];
  const c = await context({ settings: s, glance: false, offline: true, owner: () => null, log: (l) => lines.push(l) });
  assert.deepEqual(c.settings.team, []);
  assert.ok(lines.includes(`${NO_TEAM}.`), lines.join('\n'));
  assert.deepEqual(withTeam({ ...s, team: ['someone'] }, () => assert.fail('nothing to say'), () => assert.fail('gh asked')).team, ['someone']);
  // Claims never merge, so they never ask.
  assert.deepEqual((await context({ settings: s, glance: false, offline: true, team: false, owner: () => assert.fail('gh asked') })).settings.team, []);
});
