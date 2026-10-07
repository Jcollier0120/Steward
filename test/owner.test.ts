import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The owner's PC, where the Steward is Castellan's own release machinery: its settings from before this version are
// migrated once, and everything it did it still does, through Settings (never a PC name).
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-owner-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

await import('./helpers.ts');
const { loadSettings, normalizeSettings, releasesRepoEnv, settingsFile } = await import('../src/settings.ts');
const { CASTELLAN_RELEASES_REPO, migrateToOwnRepos } = await import('../src/migrate.ts');
const { STAFF } = await import('./fixtures/staff.ts');

// The owner's settings.json as it is today: the staff, the Steward's repository and clone, nothing else.
const before = { employees: STAFF.map(({ merges: _m, ...e }) => e), stewardRepo: 'Jcollier0120/Steward', stewardCheckout: 'C:\\Projects\\Steward' };

test("the owner's settings: migrated once, and the Steward does all it did before", () => {
  writeFileSync(settingsFile(), JSON.stringify(before));
  const old = normalizeSettings(before).settings;
  const s = loadSettings();
  assert.deepEqual([s.releasesCastellan, s.releasesRepo, s.byItself], [true, CASTELLAN_RELEASES_REPO, true], "Castellan's releases, published where they always were, merged and released by itself");
  assert.ok(s.employees.every((e) => e.merges), 'every repository merges its ready PRs, as before');
  assert.deepEqual(s.employees.map(({ merges: _m, ...e }) => e), old.employees.map(({ merges: _m, ...e }) => e), 'each repository exactly as it was: on the kit, its commands');
  for (const k of ['team', 'workRoot', 'stewardRepo', 'stewardCheckout', 'rollout', 'releaseSelf', 'mergeSelf', 'catchUp', 'tasteBeforeRelease', 'fileWork', 'tend', 'alarms', 'wrightReview', 'afterRelease', 'roundMinutes', 'parallel'] as const)
    assert.deepEqual(s[k], old[k], k);
  assert.deepEqual(releasesRepoEnv(s), { MANOR_RELEASES_REPO: CASTELLAN_RELEASES_REPO }, "each release it runs goes to the releases repository too");
  // Written out, so the kit's release by hand finds it (releasesRepo) and nothing depends on a default again.
  const written = JSON.parse(readFileSync(settingsFile(), 'utf8'));
  assert.deepEqual([written.releasesCastellan, written.releasesRepo, written.byItself], [true, CASTELLAN_RELEASES_REPO, true]);
  // Once: what the owner saves afterwards stands.
  writeFileSync(settingsFile(), JSON.stringify({ ...written, byItself: false }));
  assert.equal(loadSettings().byItself, false);
});

test("a Steward that ran before on a PC without the Exchequer's key: updated with Castellan's work off, waiting for a yes", () => {
  const file = path.join(home, 'elsewhere-settings.json');
  writeFileSync(file, JSON.stringify({ ...before, byItself: true }));
  assert.equal(migrateToOwnRepos({ settingsFile: file, dataDir: home, hasPublisherKey: () => false }), 'elsewhere');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([written.releasesCastellan, written.byItself, written.releasesRepo], [false, false, undefined]);
  const s = normalizeSettings(written).settings;
  assert.ok(s.employees.every((e) => !e.merges), 'no repository merges by itself');
  assert.equal(migrateToOwnRepos({ settingsFile: file, dataDir: home, hasPublisherKey: () => true }), null, 'decided once: a key later changes nothing by itself');
  // With the key, the same settings are the owner's.
  writeFileSync(file, JSON.stringify(before));
  assert.equal(migrateToOwnRepos({ settingsFile: file, dataDir: home, hasPublisherKey: () => true }), 'before');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).releasesCastellan, true);
});

test('the .NET SDK it found in its old place is kept, as a setting; nothing is written where there was none', () => {
  const file = path.join(home, 'dotnet-settings.json');
  writeFileSync(file, JSON.stringify(before));
  const saved = process.env.DOTNET_ROOT;
  delete process.env.DOTNET_ROOT;
  try {
    assert.equal(migrateToOwnRepos({ settingsFile: file, dataDir: home, dotnetHasSdk: () => true }), 'before');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).dotnetRoot, 'C:\\tools\\dotnet10');
    writeFileSync(file, JSON.stringify(before));
    migrateToOwnRepos({ settingsFile: file, dataDir: home, dotnetHasSdk: () => false });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).dotnetRoot, undefined);
    assert.equal(migrateToOwnRepos({ settingsFile: file, dataDir: home }), null, 'decided once');
  } finally {
    if (saved !== undefined) process.env.DOTNET_ROOT = saved;
  }
});
