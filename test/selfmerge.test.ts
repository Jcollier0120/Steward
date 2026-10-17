import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's own repository, as a build sees an employee's (stages/selfmerge.ts): main tested at its head before its
// release unless a vouch covers it (stages/mainbuild.ts); never a kit rollout, its releases its own (stages/self.ts).
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-selfmerge-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { stewardEmployee } = await import('../src/stages/selfmerge.ts');
const { ctxFor, runner } = await import('./helpers.ts');

test("its own repository as a build sees an employee's: no kit, its own checks, its version files, no release", () => {
  const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: runner().run, neutralDir: home });
  const e = stewardEmployee(ctx.settings);
  assert.equal(e.id, 'steward');
  assert.equal(e.repo, 'Jcollier0120/Steward');
  assert.equal(e.checkout, ctx.settings.stewardCheckout);
  assert.equal(e.branch, 'main');
  assert.equal(e.usesKit, false, 'a rollout passes it over');
  assert.deepEqual([e.fill, ...e.test], ['npm run kit', 'npm run typecheck', 'npm test']);
  assert.deepEqual(e.versionFiles, ['package.json', 'package-lock.json', 'src/app.ts']);
  assert.deepEqual([e.release, e.install], ['', '']);
  assert.equal(stewardEmployee(ctx.settings, path.join(home, 'elsewhere')).checkout, path.join(home, 'elsewhere'), 'the checkout given');
});
