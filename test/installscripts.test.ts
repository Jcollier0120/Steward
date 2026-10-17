import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A rogue package's install script runs, unscanned, the moment npm installs it. The Steward's installs run none but the
// ones Settings allow, and hold the work for any other.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-install-scripts-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const scripts = await import('../src/installscripts.ts');
const { DEFAULT_INSTALL_SCRIPTS, guardInstall, installHoldConditions, installLines, installPlan, keepHolds, loadInstallHolds, lockPackages, HOLD_SEEN_MS } = scripts;
const { runChecks } = await import('../src/stages/bump.ts');
const { normalizeSettings } = await import('../src/settings.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { ctxFor, employee, ok, runner } = await import('./helpers.ts');
type Runner = import('../src/run.ts').Runner;

const lock = (packages: Record<string, object>) =>
  JSON.stringify({ name: 'fake', version: '0.4.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fake', version: '0.4.0' }, ...packages } }, null, 2);

const ESBUILD = { 'node_modules/esbuild': { version: '0.28.2', hasInstallScript: true }, 'node_modules/@esbuild/win32-x64': { version: '0.28.2', optional: true } };
const ROGUE = { 'node_modules/left-padd': { version: '1.0.0', hasInstallScript: true } };

test("a lockfile's packages: their names, versions, install scripts and git sources; never the project's own or its workspaces", () => {
  const pkgs = lockPackages(
    lock({
      ...ESBUILD,
      'node_modules/a/node_modules/@scope/b': { version: '2.0.0', hasInstallScript: true },
      'node_modules/aliased': { name: 'real-name', version: '1.0.0' },
      'node_modules/from-git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/from-git.git#abc' },
      'packages/own': { name: 'own', version: '0.0.1', hasInstallScript: true },
      'node_modules/own': { resolved: 'packages/own', link: true },
    }),
  )!;
  assert.deepEqual(
    pkgs.map((p) => [p.name, p.version, p.script, !!p.git]),
    [
      ['esbuild', '0.28.2', true, false],
      ['@esbuild/win32-x64', '0.28.2', false, false],
      ['@scope/b', '2.0.0', true, false],
      ['real-name', '1.0.0', false, false],
      ['from-git', '1.0.0', false, true],
    ],
  );
  assert.equal(lockPackages(null), null);
  assert.equal(lockPackages('not json'), null);
  // A lockfile before `packages` says nothing of scripts: listed, nested too, and installed with --ignore-scripts.
  const v1 = lockPackages(JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } } }))!;
  assert.deepEqual(v1.map((p) => p.path), ['node_modules/a', 'node_modules/a/node_modules/b']);
});

test('every install runs --ignore-scripts; the allowed packages then have theirs run by name, and any other holds it', () => {
  const none = installPlan(lock({ 'node_modules/typescript': { version: '7.0.2' } }), DEFAULT_INSTALL_SCRIPTS);
  assert.deepEqual(installLines(none), ['npm ci --ignore-scripts --no-audit --no-fund']);
  assert.deepEqual(none.held, []);
  const esbuild = installPlan(lock(ESBUILD), DEFAULT_INSTALL_SCRIPTS);
  assert.deepEqual(installLines(esbuild), ['npm ci --ignore-scripts --no-audit --no-fund', 'npm rebuild esbuild']);
  const rogue = installPlan(lock({ ...ESBUILD, ...ROGUE }), DEFAULT_INSTALL_SCRIPTS);
  assert.deepEqual(rogue.held.map((p) => `${p.name}@${p.version}`), ['left-padd@1.0.0']);
  // A git dependency is held whatever its name: its code isn't the registry's.
  const git = installPlan(lock({ 'node_modules/esbuild': { version: '0.28.2', resolved: 'github:evil/esbuild#main' } }), DEFAULT_INSTALL_SCRIPTS);
  assert.deepEqual(git.held.map((p) => p.name), ['esbuild']);
  // An empty list: even esbuild holds it.
  assert.deepEqual(installPlan(lock(ESBUILD), []).held.map((p) => p.name), ['esbuild']);
  // Names match whatever their case in Settings.
  assert.deepEqual(installPlan(lock(ESBUILD), ['ESBuild']).held, []);
  assert.deepEqual(installPlan(lock(ESBUILD), DEFAULT_INSTALL_SCRIPTS, { preferOffline: true }).ci, ['ci', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund']);
});

test("a hold names the package, its version and the script its registry entry says, and keeps it for the alarm; npm view is all that runs", async () => {
  const dir = path.join(home, 'guard');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package-lock.json'), lock({ ...ESBUILD, ...ROGUE }));
  const ran: string[][] = [];
  const run: Runner = async (cmd, args) => {
    ran.push([cmd, ...args]);
    return ok({ scripts: { postinstall: 'node steal.js', test: 'jest' } });
  };
  const file = path.join(home, 'held.json');
  const now = new Date('2026-10-13T20:00:00Z');
  const g = await guardInstall(run, dir, DEFAULT_INSTALL_SCRIPTS, { who: { id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake' }, doing: 'the bump to kit 2.69.1' }, { file, now });
  assert.match(g.held!, /left-padd@1\.0\.0 \(postinstall: node steal\.js\) runs an install script that is not on "Install scripts allowed"/);
  assert.deepEqual(ran, [['npm', 'view', 'left-padd@1.0.0', 'scripts', 'gypfile', '--json']]);
  const kept = JSON.parse(readFileSync(file, 'utf8'));
  const h = kept['Jcollier0120/Fake:left-padd@1.0.0'];
  assert.equal(h.script, 'postinstall: node steal.js');
  assert.equal(h.doing, 'the bump to kit 2.69.1');
  assert.equal(h.path, 'node_modules/left-padd');

  // The alarm: at once, naming all of it; gone once the package is allowed, or not seen for two days.
  const [c] = installHoldConditions(kept, DEFAULT_INSTALL_SCRIPTS, now.getTime());
  assert.equal(c.id, 'install-script:Jcollier0120/Fake:left-padd@1.0.0');
  assert.equal(c.afterMs, 0);
  assert.match(c.title, /left-padd@1\.0\.0 would run an install script/);
  assert.match(c.detail.join('\n'), /postinstall: node steal\.js[\s\S]*Install scripts allowed/);
  assert.deepEqual(installHoldConditions(kept, [...DEFAULT_INSTALL_SCRIPTS, 'left-padd'], now.getTime()), []);
  assert.deepEqual(installHoldConditions(kept, DEFAULT_INSTALL_SCRIPTS, now.getTime() + HOLD_SEEN_MS + 1), []);
  assert.deepEqual(Object.keys(keepHolds(kept, [], [...DEFAULT_INSTALL_SCRIPTS, 'left-padd'], now)), [], 'allowed since: dropped');
  // Seen again: it keeps when it was first seen.
  const later = new Date(now.getTime() + 3_600_000);
  const again = keepHolds(kept, [{ ...h, since: later.toISOString() }], DEFAULT_INSTALL_SCRIPTS, later);
  assert.equal(again['Jcollier0120/Fake:left-padd@1.0.0'].since, h.since);
  assert.equal(again['Jcollier0120/Fake:left-padd@1.0.0'].lastAt, later.toISOString());

  // Nothing to hold: no npm at all, and nothing kept.
  writeFileSync(path.join(dir, 'package-lock.json'), lock(ESBUILD));
  ran.length = 0;
  const fine = await guardInstall(run, dir, DEFAULT_INSTALL_SCRIPTS, { who: { id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake' }, doing: 'x' }, { file: path.join(home, 'none.json') });
  assert.equal(fine.held, null);
  assert.deepEqual(ran, []);
  assert.ok(!existsSync(path.join(home, 'none.json')));
});

test("a worktree whose lockfile holds: its checks install nothing, run nothing, and say which package; the round's alarm names it", async () => {
  const dir = path.join(home, 'checks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake', version: '0.4.0' }));
  writeFileSync(path.join(dir, 'package-lock.json'), lock(ROGUE));
  const npm: string[][] = [];
  const r = runner();
  const run: Runner = async (cmd, args, opts) => {
    if (cmd === 'npm') {
      npm.push(args);
      return args[0] === 'view' ? ok({ scripts: { install: 'node-gyp rebuild' } }) : ok('');
    }
    return r.run(cmd, args, opts);
  };
  const e = employee(dir, { fill: '', test: ['node -e process.exit(3)'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run, neutralDir: home });
  const said: string[] = [];
  const failed = await runChecks(ctx, e, dir, { say: (l) => said.push(l), doing: '#12\'s checks' });
  assert.match(failed!, /^its packages weren't installed: nothing was installed: left-padd@1\.0\.0 \(install: node-gyp rebuild\)/);
  assert.deepEqual(npm, [['view', 'left-padd@1.0.0', 'scripts', 'gypfile', '--json']], 'no npm ci, no tests');
  assert.ok(!existsSync(path.join(dir, 'node_modules')));
  const holds = loadInstallHolds();
  assert.equal(Object.values(holds)[0].doing, "#12's checks");
  const conditions = roundConditions({ round: { stage: 'round', results: [] } as any, failedReleases: {}, installHolds: holds, employees: [e], settings: ctx.settings });
  assert.ok(conditions.some((c) => c.id === 'install-script:Jcollier0120/Fake:left-padd@1.0.0'), conditions.map((c) => c.id).join(', '));
});

test("Settings' list: npm names, lowercased, once each; an empty list stays empty; absent, the manor's three", () => {
  assert.deepEqual(normalizeSettings({}).settings.installScripts, ['esbuild', 'unrs-resolver', 'fsevents']);
  assert.deepEqual(normalizeSettings({ installScripts: ['ESBuild', 'esbuild', '@napi-rs/canvas', 'not a name', '../x', 7] }).settings.installScripts, ['esbuild', '@napi-rs/canvas']);
  assert.deepEqual(normalizeSettings({ installScripts: [] }).settings.installScripts, []);
});

test('a shared set with esbuild: npm ci --ignore-scripts, then npm rebuild esbuild alone; a rogue package gets no set at all', async () => {
  const { linkSharedModules } = await import('../src/stages/modules.ts');
  const npm: string[][] = [];
  const run: Runner = async (cmd, args, opts) => {
    npm.push([cmd, ...args]);
    mkdirSync(path.join(opts!.cwd!, 'node_modules', 'esbuild'), { recursive: true });
    return ok('');
  };
  const e = employee(home, { fill: '' });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work-sets'), run, neutralDir: home });
  const project = (name: string, packages: Record<string, object>) => {
    const d = path.join(home, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    writeFileSync(path.join(d, 'package-lock.json'), lock(packages));
    return d;
  };
  const said: string[] = [];
  assert.equal(await linkSharedModules(ctx, project('with-esbuild', ESBUILD), (l) => said.push(l)), true, said.join('\n'));
  assert.deepEqual(npm, [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
    ['npm', 'rebuild', 'esbuild'],
  ]);
  npm.length = 0;
  assert.equal(await linkSharedModules(ctx, project('with-rogue', { ...ESBUILD, ...ROGUE }), (l) => said.push(l)), false);
  assert.deepEqual(npm, [], 'nothing installed');
  assert.match(said.at(-1)!, /not shared, as left-padd@1\.0\.0 would run an install script/);
});
