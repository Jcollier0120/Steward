import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// An agent's PR that takes a kit not yet released (Manor#135, kit 2.42.0): it waits for that kit, untested and not held
// against its commit, its hold naming the Steward PR that brings it; and a failure at its kit's fill is tried again once
// a newer kit is released.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-kitwait-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { kitMayClear, kitReleaseHold, KIT_WAIT } = await import('../src/stages/prtest.ts');
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
