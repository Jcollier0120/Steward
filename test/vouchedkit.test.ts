import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A vouched team PR whose kit.json pins a kit with no release (Steward#312's follow-up): a vouch is for its checks, run
// in its author's clone, never for the kit it pins. Before, a vouched PR skipped kitReleaseHold (prtest.ts), so one
// pinned to a kit that will never be released could merge. Now it waits for its kit as any PR does, and once that kit
// is released, the vouch spares its checks here as before.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-vouchedkit-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
// The Assayer's record of checks, never the person's own.
process.env.ASSAYER_HOME = path.join(tmp, 'assayer');
mkdirSync(process.env.ASSAYER_HOME, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

const { mergeOne } = await import('../src/stages/merge.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const f = fakeEmployee(path.join(tmp, 'merge'), { version: '0.4.0' });
/** A PR's head that pins `kit` in kit.json, pushed as GitHub keeps a PR's head. */
const pinned = (n: number, kit: string) => {
  sh(f.checkout, 'switch', '--quiet', '-c', `claude/pin-${n}`, 'main');
  writeFileSync(path.join(f.checkout, 'kit.json'), `{\n  "kit": "${kit}",\n  "parts": ["node"]\n}\n`);
  sh(f.checkout, 'commit', '--quiet', '-am', `pin kit ${kit}`);
  const head = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${head}:refs/pull/${n}/head`);
  sh(f.checkout, 'switch', '--quiet', 'main');
  return head;
};
// Its checks here always fail, and its kit's fill too: a merge proves neither ran.
const e = employee(f.checkout, { test: ['node -e process.exit(1)'] });
const byTeam = { context: VOUCH_CONTEXT, state: 'success', creator: { login: 'jcollier0120' } };
const vouchStatus = { __typename: 'StatusContext', context: VOUCH_CONTEXT, state: 'SUCCESS' };
const KEEP = "Keep main's pin in kit.json: once a build releases its kit, the rollout pins it on main, and the Steward's catch-up brings it to this PR";

/** One look at PR `n` (its head `head`), vouched for or not, with `released` kits and the Steward's open PRs `open`. */
const look = async (n: number, head: string, o: { vouched: boolean; released: string[]; open?: unknown[] }) => {
  const listed = [{ number: n, title: `pin ${n}`, url: `https://github.com/Jcollier0120/Fake/pull/${n}`, headRefName: `claude/pin-${n}`, headRefOid: head, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: o.vouched ? [vouchStatus] : [], body: '', labels: [] }];
  const r = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list') return ok(a[3] === 'Jcollier0120/Steward' ? (o.open ?? []) : listed);
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (a[0] === 'api' && a[1] === `repos/Jcollier0120/Fake/commits/${head}/statuses?per_page=100`) return ok(o.vouched ? [byTeam] : []);
    if (a[0] === 'pr' && (a[1] === 'merge' || a[1] === 'comment')) return ok('');
  });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp, released: o.released });
  const m = await mergeOne(ctx, e, { yes: true, team: true });
  return { m, merges: r.gh.filter((a) => a[0] === 'pr' && a[1] === 'merge'), comments: r.gh.filter((a) => a[0] === 'pr' && a[1] === 'comment'), lines: ctx.lines.join('\n') };
};

test('a vouched PR whose kit.json pins a kit that will never be released waits, its author told, and is never merged', async () => {
  const head = pinned(8, '2.78.3');
  const dead = `pins kit 2.78.3, which will never be released: kit 2.78.10 is released already, and no open Steward PR brings it. ${KEEP}`;
  const vouched = await look(8, head, { vouched: true, released: ['2.78.10', '1.0.0'] });
  assert.equal(vouched.merges.length, 0, vouched.m.message);
  assert.equal(vouched.m.outcome, 'skipped', vouched.m.message);
  assert.deepEqual(
    vouched.m.held.map((h) => [h.number, h.why]),
    [[8, dead]],
  );
  assert.doesNotMatch(vouched.m.message, /vouched for/, 'its vouch spares nothing while its kit has no release');
  assert.doesNotMatch(vouched.lines, /testing it here/);
  // Told on the PR, as a PR tested here is (prtest.ts's tellDeadKit), once for its head.
  assert.deepEqual(
    vouched.comments.map((c) => c[2]),
    ['8'],
  );
  assert.ok(vouched.comments[0][vouched.comments[0].indexOf('--body') + 1].startsWith(`**The Steward can't merge this:** it ${dead}.`));

  // Not vouched for: the very same hold, and its author isn't told twice for the same head.
  const plain = await look(8, head, { vouched: false, released: ['2.78.10', '1.0.0'] });
  assert.deepEqual(
    plain.m.held.map((h) => [h.number, h.why]),
    [[8, dead]],
  );
  assert.equal(plain.merges.length + plain.comments.length, 0);
});

test('a vouched PR whose kit an open Steward PR brings waits for its release, then merges on its vouch, untested here', async () => {
  const head = pinned(9, '2.79.0');
  const open = [{ number: 320, title: 'Steward 0.36.85, kit 2.79.0: a thing', url: '', body: '', headRefName: 'claude/kit-thing', headRefOid: 'aaaa1111', baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], labels: [], additions: 1, deletions: 1, files: [{ path: 'kit/VERSION' }] }];
  const waits = await look(9, head, { vouched: true, released: ['2.78.10', '1.0.0'], open });
  assert.equal(waits.merges.length, 0, waits.m.message);
  assert.deepEqual(
    waits.m.held.map((h) => [h.number, h.why]),
    [[9, "waits for kit 2.79.0, which Steward#320 brings: it merges once that's released"]],
  );
  assert.equal(waits.comments.length, 0, 'a kit still to come: nothing to tell its author');

  // Its kit released: the vouch stands for its checks, which fail here, so a merge proves they weren't run.
  const released = await look(9, head, { vouched: true, released: ['2.79.0', '2.78.10', '1.0.0'] });
  assert.equal(released.m.outcome, 'done', released.m.message);
  assert.equal(released.m.message, `merged #9 (checks passed at ${head.slice(0, 7)} in jcollier0120's clone, vouched for)`);
  assert.deepEqual(released.merges, [['pr', 'merge', '9', '--repo', 'Jcollier0120/Fake', '--merge', '--match-head-commit', head]]);
});
