import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Folders compared by their real paths (real-path.ts, spec/DEV-DRIVES.md), with a real junction: `link` names `target`,
// as %USERPROFILE%\.steward\work names E:\steward-work on a PC whose folders moved onto a Dev Drive. Every comparison
// here fails when the two are compared as spelled.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'kit-real-path-')));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(tmp, 'own-home');
process.env.REEVE_HOME = path.join(tmp, 'no-reeve');
process.env.MANOR_HOME = path.join(tmp, 'no-manor');
process.env.SMITH_HOME = path.join(tmp, 'no-smith');
after(() => rmSync(tmp, { recursive: true, force: true }));

const target = path.join(tmp, 'real');
const link = path.join(tmp, 'link');
mkdirSync(path.join(target, 'inside'), { recursive: true });
symlinkSync(target, link, 'junction');

const { forgetRealPaths, inside, keyInside, pathKey, realPath, samePath } = await import('./fixture/src/kit/real-path.ts');
const win = process.platform === 'win32';

test('a folder reached through a junction is the folder itself, and so is what is in it, made yet or not', () => {
  assert.notEqual(path.resolve(link).toLowerCase(), path.resolve(target).toLowerCase(), 'two spellings');
  assert.equal(realPath(link), target);
  assert.equal(realPath(path.join(link, 'inside')), path.join(target, 'inside'));
  assert.equal(realPath(path.join(link, 'not', 'made', 'yet.txt')), path.join(target, 'not', 'made', 'yet.txt'), 'the deepest part that exists, the rest as given');
  assert.ok(samePath(link, target));
  assert.ok(samePath(`${link}${path.sep}`, win ? target.toUpperCase() : target), 'a separator at the end, and the case on Windows, make no difference');
  assert.ok(inside(path.join(link, 'inside', 'file.txt'), target));
  assert.ok(inside(path.join(target, 'inside'), link));
  assert.ok(inside(link, target), 'a folder is inside itself');
  assert.ok(!inside(path.join(tmp, 'link-other'), link), 'a folder that only starts the same');
  assert.ok(!samePath(link, path.join(tmp, 'elsewhere')));
  assert.equal(pathKey(path.join(link, 'inside')), pathKey(path.join(target, 'inside')));
});

test("a drive's root keeps its separator, and a share is taken as it is: never asked, so WSL and the network stay asleep", () => {
  const root = path.parse(tmp).root;
  assert.ok(pathKey(root).endsWith(path.sep), pathKey(root));
  assert.ok(keyInside(pathKey(tmp), pathKey(root)));
  if (!win) return;
  assert.equal(realPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), '\\\\wsl.localhost\\Ubuntu\\home\\me');
  assert.equal(realPath('\\\\nowhere.invalid\\share\\x'), '\\\\nowhere.invalid\\share\\x');
});

test('answers are kept a minute, and forgotten on asking', () => {
  const later = path.join(tmp, 'later');
  assert.equal(realPath(later), later, 'not there yet');
  symlinkSync(target, later, 'junction');
  assert.equal(realPath(later), later, 'the kept answer');
  forgetRealPaths();
  assert.equal(realPath(later), target);
});

test("a project's checkout through the junction is the Steward's own checkout, or inside it (manor.ts)", async () => {
  const { projectsFrom } = await import('./fixture/src/kit/manor.ts');
  const own = { repos: [], checkouts: [target] };
  for (const checkout of [link, path.join(link, 'inside')]) {
    const problems: string[] = [];
    assert.deepEqual(projectsFrom([{ name: 'Mine', checkout }], own, problems), [], checkout);
    assert.match(problems.join('\n'), /the manor's own checkouts/);
  }
  const problems: string[] = [];
  const twice = [{ name: 'One', checkout: path.join(target, 'inside') }, { name: 'Two', checkout: path.join(link, 'inside') }];
  assert.deepEqual(projectsFrom(twice, { repos: [], checkouts: [] }, problems).map((p) => p.name), ['One']);
  assert.match(problems.join('\n'), /has the checkout of one listed before it/);
});

test('--purge refuses a folder holding the profile when it names it through the junction (install.ts)', async () => {
  const { APP } = await import('./fixture/src/app.ts');
  const { purgeRefusal } = await import('./fixture/src/kit/install.ts');
  // A data folder named for the agent, which holds the profile: spelled the other way, it looked like the agent's own.
  const profile = path.join(target, APP.id, 'Users', 'jo');
  mkdirSync(profile, { recursive: true });
  assert.match(String(purgeRefusal(path.join(link, APP.id), profile, { USERPROFILE: profile })), /it holds /);
  assert.match(String(purgeRefusal(path.join(link, APP.id, 'Users', 'jo'), profile, { USERPROFILE: profile })), /it is /);
});

test("a model server's program and folders, however Windows started it (keeper.ts)", async () => {
  const { manorOwns, manorServerDirs, sameProgram } = await import('./fixture/src/kit/keeper.ts');
  const program = (base: string) => path.join(base, 'servers', 'llama.cpp', 'llama-server.exe');
  assert.ok(sameProgram(program(link), program(target)));
  assert.ok(!sameProgram(program(link), path.join(tmp, 'elsewhere', 'llama-server.exe')));
  assert.ok(manorOwns({ pid: 1, path: program(link), startedMs: 0 }, { dirs: [path.join(target, 'servers')] }), 'in the servers folder, named through the junction');
  const started = [{ pid: 9, program: program(target), base: 'http://127.0.0.1:18181', atMs: 1_000 }];
  assert.ok(manorOwns({ pid: 9, path: program(link), startedMs: 1_000 }, { dirs: [], started }), 'the very process the manor started');
  // The accelerators' folder a junction to Reeve's: one servers folder, listed once.
  const home = path.join(tmp, 'profile');
  const manor = path.join(tmp, 'manor');
  mkdirSync(path.join(home, '.reeve', 'servers'), { recursive: true });
  mkdirSync(manor, { recursive: true });
  symlinkSync(path.join(home, '.reeve'), path.join(manor, 'accelerators'), 'junction');
  assert.deepEqual(manorServerDirs({ MANOR_HOME: manor }, home), [path.join(home, '.reeve', 'servers')]);
});

test("Reeve's older config.json is no other file when the accelerators' folder is a junction to it (accelerators.ts)", async () => {
  const { legacyConfigFile } = await import('./fixture/src/kit/accelerators.ts');
  const home = path.join(tmp, 'profile-config');
  const manor = path.join(tmp, 'manor-config');
  mkdirSync(path.join(home, '.reeve'), { recursive: true });
  mkdirSync(manor, { recursive: true });
  writeFileSync(path.join(home, '.reeve', 'config.json'), '{}');
  assert.equal(legacyConfigFile({ MANOR_HOME: manor }, home), path.join(home, '.reeve', 'config.json'), 'another file: moved once');
  symlinkSync(path.join(home, '.reeve'), path.join(manor, 'accelerators'), 'junction');
  forgetRealPaths();
  assert.equal(legacyConfigFile({ MANOR_HOME: manor }, home), null, 'the same file: nothing to move onto itself');
});

test("a person's folders listed once, and an installed copy's programs found under either spelling (folders.ts, native.ts)", async () => {
  const { uniqueFolders } = await import('./fixture/src/kit/folders.ts');
  const { spellingsOf } = await import('./fixture/src/kit/native.ts');
  assert.deepEqual(uniqueFolders([target, link, path.join(link, 'inside')]), [target, path.join(link, 'inside')]);
  assert.deepEqual(spellingsOf(link), [link, target]);
  assert.deepEqual(spellingsOf(target), [target]);
});
