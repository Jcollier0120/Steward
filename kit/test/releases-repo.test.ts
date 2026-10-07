import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
const { releasesRepo } = await import('./fixture/src/kit/release.ts');

const home = mkdtempSync(path.join(os.tmpdir(), 'releases-repo-'));
after(() => rmSync(home, { recursive: true, force: true }));

function steward(settings: unknown | null): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join(home, 'steward-'));
  if (settings !== null) writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return { STEWARD_HOME: dir };
}

test('MANOR_RELEASES_REPO, when set, decides: a name, or empty for none', () => {
  assert.equal(releasesRepo({ MANOR_RELEASES_REPO: 'Someone/Releases' }, home), 'Someone/Releases');
  assert.equal(releasesRepo({ MANOR_RELEASES_REPO: '' }, home), null);
});

test("a new Steward's settings: releasesCastellan false means none, true means its releasesRepo", () => {
  assert.equal(releasesRepo(steward({ releasesCastellan: false, releasesRepo: 'Someone/Releases' }), home), null);
  assert.equal(releasesRepo(steward({ releasesCastellan: true, releasesRepo: 'Someone/Releases' }), home), 'Someone/Releases');
});

test('a Steward from before 0.19.0 (no releasesCastellan yet) keeps releasing where it always did', () => {
  assert.equal(releasesRepo(steward({ employees: [], stewardRepo: '' }), home), 'Jcollier0120/Manor-releases');
});

test('no Steward on this PC, or settings that are not an object: none', () => {
  assert.equal(releasesRepo(steward(null), home), null);
  assert.equal(releasesRepo(steward([1, 2]), home), null);
});
