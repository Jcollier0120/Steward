import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// An employee released only on this PC (npm run release -- --install) has no release on GitHub: the version its
// installed copy was built as is released too, so the rounds don't build and install it again every time.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-released-here-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { releasedOf, installedRelease } = await import('../src/stages/common.ts');
const { releaseDecision } = await import('../src/stages/release.ts');
const { ctxFor, employee, runner } = await import('./helpers.ts');

const app = path.join(home, 'app');
mkdirSync(app, { recursive: true });
const built = (o: object) => writeFileSync(path.join(app, 'release.json'), JSON.stringify({ id: 'fake', version: '0.3.17', commit: '1e683c7', dirty: false, built: '2026-10-09T00:32:28.067Z', ...o }));
const onGitHub = JSON.stringify([{ tagName: 'v0.2.9', isDraft: false, publishedAt: '2026-10-06T06:11:13Z' }]);
const r = runner((a) => (a[0] === 'release' && a[1] === 'list' ? { code: 0, out: onGitHub, err: '' } : undefined));
const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home });

test("released here: the installed copy's version counts as released, so the round leaves it be", async () => {
  built({});
  const here = employee(path.join(home, 'checkout'), { release: 'npm run release -- --install', installed: app });
  assert.deepEqual(installedRelease(here), { version: '0.3.17', built: '2026-10-09T00:32:28.067Z' });
  const versions = (await releasedOf(ctx, here)).map((x) => x.version);
  assert.deepEqual(versions, ['0.3.17', '0.2.9']);
  assert.deepEqual(releaseDecision({ usesKit: true, kit: '2.41.0', version: '0.3.17', released: versions }, null), { release: false, why: 'v0.3.17 is already released' });
  assert.deepEqual(releaseDecision({ usesKit: true, kit: '2.41.0', version: '0.3.18', released: versions }, null), { release: true }, 'a new version on its branch is released');
});

test('never for one published elsewhere, a development build, or one not installed', async () => {
  built({});
  const published = employee(path.join(home, 'checkout'), { release: 'npm run release -- --publish', installed: app });
  assert.equal(installedRelease(published), null);
  assert.deepEqual((await releasedOf(ctx, published)).map((x) => x.version), ['0.2.9']);
  const here = employee(path.join(home, 'checkout'), { release: 'npm run release -- --install', installed: app });
  built({ dirty: true });
  assert.equal(installedRelease(here), null, 'a development build is no release');
  assert.equal(installedRelease({ ...here, installed: path.join(home, 'nowhere') }), null);
  assert.equal(installedRelease({ ...here, installed: '' }), null);
});
