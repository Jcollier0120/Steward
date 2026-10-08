import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// An agent's PR that takes a kit not yet released (Manor#135, kit 2.42.0): it waits for that kit, untested and not held
// against its commit, and a failure at its kit's fill is tried again once a newer kit is released.
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

test("a PR whose kit.json pins a kit with no release waits for it, untested; one whose kit is released doesn't", async () => {
  const pr = { number: 135, headOid: '3635fec939a0c67033f4cada00b94c457014781e' } as unknown as import('../src/stages/staff.ts').PrInfo;
  const pinned = (kit: string): import('../src/run.ts').Runner => async (cmd, args) => (cmd === 'git' && args.includes('show') ? ok(JSON.stringify({ kit })) : ok(''));
  const ctx = (kit: string, released: string[]) => ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: pinned(kit), neutralDir: home, released });
  const waits = await kitReleaseHold(ctx('2.42.0', ['2.41.0', '2.40.0']), e, pr);
  assert.ok(waits?.startsWith(KIT_WAIT), String(waits));
  assert.match(waits!, /kit 2\.42\.0 isn't released yet/);
  assert.equal(await kitReleaseHold(ctx('2.42.0', ['2.42.0', '2.41.0']), e, pr), null);
  assert.equal(await kitReleaseHold(ctx('2.42.0', []), e, pr), null, "the kit's releases unread: tested as before");
});
