import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's settings: no employees or repository of anyone's built in, and what the schema refuses. (test/agent.test.ts
// runs the kit's own checks of the schema and its defaults, as in every agent.)
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-settings-'));
process.env.STEWARD_HOME = home;
// The Wright is installed on the PC these tests run on, or not: neither may decide the defaults here.
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { DEFAULT_SETTINGS, SETTINGS_SPEC, loadSettings, normalizeSettings, settingsFile } = await import('../src/settings.ts');
const { saveSettingsReply } = await import('../src/kit/settings-kit.ts');
const { pick } = await import('../src/stages/common.ts');
const { fillMigrationGaps, migrateSettings, migrationFile, pendingMigration } = await import('../src/migrate.ts');
const { employeeFor } = await import('../src/claims.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { STAFF } = await import('./fixtures/staff.ts');
const save = async (values: Record<string, unknown>) => (await saveSettingsReply(SETTINGS_SPEC, { values })) as { status?: number; json: any };

test("nobody's employees, repository or clone are built in: they start empty, and Settings name yours", () => {
  assert.deepEqual(DEFAULT_SETTINGS.employees, []);
  assert.deepEqual([DEFAULT_SETTINGS.stewardRepo, DEFAULT_SETTINGS.stewardCheckout], ['', '']);
  assert.deepEqual(normalizeSettings({}).settings.employees, []);
  const text = JSON.stringify([DEFAULT_SETTINGS, SETTINGS_SPEC.schema]);
  assert.doesNotMatch(text, /jcollier|C:\\\\Projects/i, "no one's account or folders in the defaults or the page's hints");
  assert.equal(DEFAULT_SETTINGS.releaseAfterMerge, false, 'release is a stage of its own, unless Settings say otherwise');
  assert.deepEqual([DEFAULT_SETTINGS.byItself, DEFAULT_SETTINGS.roundMinutes], [true, 10], 'it merges and releases by itself, a round every 10 minutes on duty');
  assert.deepEqual([normalizeSettings({ roundMinutes: 1 }).settings.roundMinutes, normalizeSettings({ byItself: false }).settings.byItself], [2, false]);
  assert.deepEqual(DEFAULT_SETTINGS.team, [], 'none named: the account gh is signed in as (team.ts)');
  assert.equal(DEFAULT_SETTINGS.workRoot, path.join(home, 'work'));
});

test('an employee named with nothing more is a Node agent on the kit, with no repository or clone; what a record says is kept', () => {
  const [porter] = normalizeSettings({ employees: [{ id: 'porter' }] }).settings.employees;
  assert.deepEqual([porter.name, porter.repo, porter.checkout, porter.branch, porter.usesKit], ['Porter', '', '', 'main', true]);
  assert.deepEqual([porter.parts, porter.versionFiles, porter.install, porter.installed], [['node', 'web', 'spec'], ['package.json', 'package-lock.json', 'src/app.ts'], 'node src/cli.ts install', '%USERPROFILE%\\.porter\\app']);
  const saved = normalizeSettings({ employees: STAFF }).settings.employees;
  assert.deepEqual(saved, STAFF, 'a full list in settings.json is kept as it is');
  const off = normalizeSettings({ employees: [{ id: 'porter', usesKit: false, branch: 'master' }] }).settings.employees[0];
  assert.deepEqual([off.usesKit, off.branch], [false, 'master']);
});

test("an older settings.json keeps its repository and clone; only missing ones take the new empty defaults", () => {
  const old = normalizeSettings({ stewardRepo: 'octocat/steward', stewardCheckout: 'D:\\code\\steward', parallel: 3 }).settings;
  assert.deepEqual([old.stewardRepo, old.stewardCheckout, old.parallel], ['octocat/steward', 'D:\\code\\steward', 3]);
  assert.deepEqual([normalizeSettings({ parallel: 3 }).settings.stewardRepo, normalizeSettings({ parallel: 3 }).settings.stewardCheckout], ['', '']);
});

test('a repository not owner/name, an id twice, or an employee with no version file is refused field by field, and nothing is written', async () => {
  const bad = structuredClone(STAFF);
  bad[0].repo = 'Porter';
  bad[1].id = 'porter';
  bad[2].versionFiles = [];
  const r = await save({ employees: bad });
  assert.equal(r.status, 400);
  assert.match(r.json.errors['employees.0.repo'], /owner\/name, like octocat\/hello-world/);
  assert.match(r.json.errors['employees.1.id'], /Already listed/);
  assert.match(r.json.errors['employees.2.versionFiles'], /at least one/);
  assert.throws(() => readFileSync(SETTINGS_SPEC.file()), /ENOENT/);
});

test("a team account that isn't one, or one listed twice in any case, is refused", async () => {
  const r = await save({ team: ['octocat', 'not an account', 'OctoCat'] });
  assert.equal(r.status, 400);
  assert.match(r.json.errors['team.1'], /a GitHub account/);
  assert.match(r.json.errors['team.2'], /Listed twice/);
});

test('a good change is saved and read back; release after merge can be switched on, and the team grown', async () => {
  const r = await save({ releaseAfterMerge: true, parallel: 4, team: ['octocat', 'app/claude'] });
  assert.equal(r.status, undefined);
  assert.equal(r.json.ok, true);
  const s = loadSettings();
  assert.equal(s.releaseAfterMerge, true);
  assert.equal(s.parallel, 4);
  assert.deepEqual(s.team, ['octocat', 'app/claude']);
  assert.equal(s.employees.length, 0);
  assert.deepEqual(normalizeSettings({}).settings.team, [], 'no team in the file is none named: gh decides (team.ts)');
  assert.deepEqual(normalizeSettings({ team: [] }).settings.team, [], 'an empty one stays empty');
  rmSync(settingsFile());
});

test("an older settings.json that names its team keeps it; only a missing team takes the new default", () => {
  const old = normalizeSettings({ team: ['octocat'], parallel: 3, byItself: false }).settings;
  assert.deepEqual([old.team, old.parallel, old.byItself], [['octocat'], 3, false]);
  assert.deepEqual(normalizeSettings({ parallel: 3 }).settings.team, []);
});

test('an employee without a usable id is left out, and said so; the stages take only known employees', () => {
  const { settings, problems } = normalizeSettings({ employees: [{ id: 'porter', repo: 'octocat/porter' }, { id: 'Not An Id' }, { name: 'none' }] });
  assert.deepEqual(settings.employees.map((e) => e.id), ['porter']);
  assert.equal(settings.employees[0].repo, 'octocat/porter');
  assert.match(problems.join(' '), /2 employee\(s\) without a usable id/);
  assert.deepEqual((pick(STAFF, ['Pinder', 'porter']) as any).employees.map((e: any) => e.id), ['porter', 'pinder']);
  assert.match((pick(STAFF, ['porter', 'reve']) as { error: string }).error, /no employee called reve/);
});

test("the Wright's and the Bailiff's pages are read for alarms where each is installed, but neither is taken on as an employee by itself", () => {
  assert.deepEqual([normalizeSettings({}).settings.alarms.wrightUrl, normalizeSettings({}).settings.alarms.bailiffUrl], ['', ''], 'not installed: not read');
  mkdirSync(path.join(process.env.WRIGHT_HOME!, 'app'), { recursive: true });
  mkdirSync(path.join(process.env.BAILIFF_HOME!, 'app'), { recursive: true });
  try {
    const s = normalizeSettings({}).settings;
    assert.deepEqual([s.alarms.wrightUrl, s.alarms.bailiffUrl], ['http://127.0.0.1:19797', 'http://127.0.0.1:19999']);
    assert.deepEqual(s.employees, [], 'installed, but not an employee until Settings name it');
    assert.equal(normalizeSettings({ alarms: { wrightUrl: '' } }).settings.alarms.wrightUrl, '', 'Settings still decide when they say');
  } finally {
    rmSync(process.env.WRIGHT_HOME!, { recursive: true, force: true });
    rmSync(process.env.BAILIFF_HOME!, { recursive: true, force: true });
  }
});

// The migration: an install that ran on the old built-in employees keeps them, read from its staff table and its clones.
const clones = path.join(home, 'clones');
const put = (rel: string, text: string) => {
  const f = path.join(clones, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
};
// A Node agent on the kit; a .NET one with no test command to find; and the Steward's own clone beside them.
put('Porter/package.json', JSON.stringify({ name: 'porter', version: '0.4.31', scripts: { test: 'node --test', release: 'node tools/release.ts' } }));
put('Porter/package-lock.json', '{}');
put('Porter/tsconfig.json', '{}');
put('Porter/tools/kit.ts', '');
put('Porter/src/cli.ts', '');
put('Porter/src/app.ts', "export const APP = { id: 'porter', version: '0.4.31' };");
put('Porter/jobs/jobs.json', '[]');
put('Dotty/tools/kit.ps1', '');
put('Dotty/Dotty.Agent/Dotty.Agent.csproj', '<Project><PropertyGroup><VersionPrefix>1.2.3</VersionPrefix></PropertyGroup></Project>');
put('Dotty/Dotty.Agent/release.ps1', '');
put('Steward/package.json', JSON.stringify({ name: 'steward' }));
put('Steward/kit/VERSION', '2.25.0');
put('Steward/.git/config', '[remote "origin"]\n\turl = https://github.com/octocat/steward.git\n');
const row = (id: string, name: string, branch = 'main', parts = ['node', 'web', 'spec']) => ({ id, name, repo: `octocat/${name}`, branch, usesKit: true, parts, checkout: { path: path.join(clones, name), exists: true } });
const staff = { rows: [row('porter', 'Porter'), row('dotty', 'Dotty', 'master', ['spec']), row('gone', 'Gone')] };
const staffFile = path.join(home, 'staff.json');
const clean = () => {
  for (const f of [settingsFile(), migrationFile(), staffFile]) rmSync(f, { force: true });
};

test("with no settings.json at all, the staff table and its clones are written to settings.json once, and what they can't tell is an alarm until Settings are saved", () => {
  writeFileSync(staffFile, JSON.stringify(staff));
  try {
    const s = loadSettings();
    assert.deepEqual(s.employees.map((e) => e.id), ['porter', 'dotty'], 'one whose clone is gone is left out');
    const [porter, dotty] = s.employees;
    assert.deepEqual(porter, {
      id: 'porter', name: 'Porter', repo: 'octocat/Porter', checkout: path.join(clones, 'Porter'), branch: 'main', usesKit: true, parts: ['node', 'web', 'spec'],
      fill: 'node tools/kit.ts', test: ['npx tsc -p . --noEmit', 'npm test'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'],
      release: 'npm run release -- --publish', install: 'node src/cli.ts install',
      approve: 'node %USERPROFILE%\\.porter\\app\\src\\cli.ts jobs approve {job} --sha256 {sha256}', installed: '%USERPROFILE%\\.porter\\app',
    });
    assert.deepEqual([dotty.branch, dotty.fill, dotty.versionFiles, dotty.release, dotty.test, dotty.install, dotty.installed], ['master', 'powershell -NoProfile -File tools\\kit.ps1', ['Dotty.Agent/Dotty.Agent.csproj'], 'powershell -NoProfile -File Dotty.Agent\\release.ps1 -Publish', [], '', '']);
    assert.equal(dotty.usesKit, false, "no test command found: off the kit's stages until Settings name one");
    assert.deepEqual([s.stewardRepo, s.stewardCheckout], ['octocat/steward', path.join(clones, 'Steward')], "the Steward's own clone beside them, and its origin");
    const written = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    assert.deepEqual(written.employees.map((e: any) => e.id), ['porter', 'dotty'], 'written to settings.json');
    const m = pendingMigration(settingsFile())!;
    assert.equal(m.notes.length, 2);
    assert.match(m.notes.join(' '), /Gone was left out: its clone isn't on this PC/);
    assert.match(m.notes.join(' '), /Dotty: couldn't tell Test it/);
    const c = roundConditions({ round: { stage: 'round', at: '', results: [] } as any, held: [], failedReleases: {}, migrated: m, employees: s.employees, settings: s });
    assert.deepEqual(c.map((x) => x.id), [`settings:migrated:${m.at}`]);
    // Once only: settings.json now names its employees, and a later read keeps what's in it.
    writeFileSync(settingsFile(), JSON.stringify({ ...written, employees: [written.employees[0]] }));
    assert.deepEqual(loadSettings().employees.map((e) => e.id), ['porter']);
    // Saved since: the alarm clears.
    const later = new Date(Date.now() + 60_000);
    utimesSync(settingsFile(), later, later);
    assert.equal(pendingMigration(settingsFile()), null);
  } finally {
    clean();
  }
});

test("Manor's internal staff are released here: built and installed from the clone, never published; a GitHub release is none of theirs", async () => {
  const manor = path.join(home, 'manor');
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  // This PC's own (Manor 0.6.4 and later): staff.local.json, which Manor never ships; an older Manor's own staff.json too.
  writeFileSync(path.join(manor, 'staff.local.json'), JSON.stringify({ agents: [{ id: 'porter', internal: true }] }));
  writeFileSync(path.join(manor, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'dotty' }, { id: 'old', internal: true }] }));
  const before = process.env.MANOR_HOME;
  process.env.MANOR_HOME = manor;
  writeFileSync(staffFile, JSON.stringify(staff));
  try {
    const { internalStaff } = await import('../src/migrate.ts');
    assert.deepEqual([...internalStaff(manor)], ['porter', 'old']);
    const { RELEASE_HERE, releasedHere } = await import('../src/settings.ts');
    const [porter, dotty] = loadSettings().employees;
    assert.deepEqual([porter.release, porter.install], [RELEASE_HERE, ''], 'internal: its release builds and installs it here');
    assert.equal(releasedHere(porter), true);
    assert.equal(releasedHere(dotty), false, 'published with -Publish');
    assert.equal(releasedHere({ release: 'npm run release -- --publish' }), false);
    const { installOne } = await import('../src/stages/aftermerge.ts');
    const r = await installOne({ run: async () => { throw new Error('no GitHub look for one released here'); } } as any, porter);
    assert.equal(r.outcome, 'done');
    assert.match(r.message, /installed by its release, built here from its clone/);
  } finally {
    if (before === undefined) delete process.env.MANOR_HOME;
    else process.env.MANOR_HOME = before;
    clean();
  }
});

// A real clone: main carries what the stages need, while the folder may be checked out on anything.
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const cloneOf = (name: string, files: Record<string, string>) => {
  const dir = path.join(clones, name);
  for (const [rel, text] of Object.entries(files)) put(`${name}/${rel}`, text);
  gitIn(clones, 'init', '-q', '-b', 'main', name);
  gitIn(dir, 'add', '-A');
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
  gitIn(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
};
const commitTo = (dir: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) put(`${path.basename(dir)}/${rel}`, text);
  gitIn(dir, 'add', '-A');
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'more');
};
const nodeAgent = (name: string) => ({
  'package.json': JSON.stringify({ name, version: '0.6.5', scripts: { test: 'node --test', release: 'node tools/release.ts' } }),
  'tsconfig.json': '{}',
  'src/cli.ts': '',
});

test("an employee's clone is read at its branch's tip, not whatever it has checked out: one on an old branch still gets its kit script", () => {
  const dir = cloneOf('Mano', { ...nodeAgent('mano'), 'tools/kit.ts': '' });
  // The folder sits on a branch from before the kit script.
  gitIn(dir, 'checkout', '-q', '-b', 'old');
  gitIn(dir, 'rm', '-q', 'tools/kit.ts');
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old');
  writeFileSync(staffFile, JSON.stringify({ rows: [row('mano', 'Mano')] }));
  try {
    const [mano] = loadSettings().employees;
    assert.equal(mano.fill, 'node tools/kit.ts', "main's kit script, though the folder hasn't it");
    assert.equal(pendingMigration(settingsFile()), null, 'nothing missing: no alarm');
  } finally {
    clean();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("what the migration couldn't fill in is looked for again until Settings are saved: found on the branch, it's written in and the alarm clears", () => {
  const dir = cloneOf('Lato', nodeAgent('lato'));
  writeFileSync(staffFile, JSON.stringify({ rows: [row('lato', 'Lato'), row('gone', 'Gone')] }));
  try {
    const at = new Date('2026-10-06T13:35:00Z');
    migrateSettings({ settingsFile: settingsFile(), staffFile, now: at });
    const m = pendingMigration(settingsFile())!;
    assert.deepEqual(m.gaps, { lato: { name: 'Lato', missing: ['Fill its kit'], offKit: false } });
    assert.match(m.notes.join(' '), /Lato: couldn't tell Fill its kit \(no tools\/kit\.ts or tools\/kit\.ps1\) from its clone's main\. The Steward looks again/);
    assert.equal(fillMigrationGaps({ settingsFile: settingsFile(), now: new Date(at.getTime() + 60_000) }), null, 'not again within a few minutes');
    assert.equal(fillMigrationGaps({ settingsFile: settingsFile(), now: new Date(at.getTime() + 10 * 60_000) }), null, 'still not there: nothing changes');
    assert.ok(pendingMigration(settingsFile()), 'and the alarm stays');
    commitTo(dir, { 'tools/kit.ts': '' });
    gitIn(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const later = fillMigrationGaps({ settingsFile: settingsFile(), now: new Date(at.getTime() + 20 * 60_000) })!;
    assert.deepEqual(later.gaps, {});
    assert.equal(JSON.parse(readFileSync(settingsFile(), 'utf8')).employees[0].fill, 'node tools/kit.ts', 'written into settings.json');
    assert.deepEqual(pendingMigration(settingsFile())!.notes.map((n) => n.slice(0, 22)), ['Gone was left out: its'], "only what it can't find itself is left");
  } finally {
    clean();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a migration from before it kept its gaps (0.11.7 to 0.11.9) has them read from its notes and Settings, and filled in the same way', () => {
  const dir = cloneOf('Mano', { ...nodeAgent('mano'), 'tools/kit.ts': '' });
  const employee = { id: 'mano', name: 'Mano', repo: 'octocat/Mano', checkout: dir, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['npm test'], versionFiles: ['package.json'], release: 'npm run release -- --publish', install: '', approve: '', installed: '' };
  writeFileSync(settingsFile(), JSON.stringify({ employees: [employee] }));
  const mtimeMs = statSync(settingsFile()).mtimeMs;
  writeFileSync(migrationFile(), JSON.stringify({ at: '2026-10-06T13:35:12.219Z', mtimeMs, employees: ['mano'], notes: ["Mano: couldn't tell Fill its kit from its clone until you fill it in."] }));
  try {
    assert.equal(loadSettings().employees[0].fill, 'node tools/kit.ts');
    assert.equal(pendingMigration(settingsFile()), null, 'the alarm clears by itself');
  } finally {
    clean();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .NET clone's test command is found: the unit tests of the project the others build on, never the slow ones", async () => {
  const { dotnetTests } = await import('../src/migrate.ts');
  const shop = mkdtempSync(path.join(os.tmpdir(), 'steward-dotnet-'));
  const proj = (dir: string, refs: string[], test = false) => {
    mkdirSync(path.join(shop, dir), { recursive: true });
    const items = refs.map((r) => `<ProjectReference Include="..\\${r}\\${r}.csproj" />`).join('');
    const sdk = test ? '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /><PackageReference Include="xunit" Version="2.9.0" />' : '';
    writeFileSync(path.join(shop, dir, `${dir}.csproj`), `<Project><ItemGroup>${items}${sdk}</ItemGroup></Project>`);
  };
  try {
    assert.deepEqual(dotnetTests(shop), [], 'none in an empty folder');
    proj('Shop.Core', []);
    proj('Shop.Web', ['Shop.Core']);
    proj('Shop.Agent', ['Shop.Core']);
    proj('Shop.Web.Tests', ['Shop.Web', 'Shop.Core'], true);
    assert.deepEqual(dotnetTests(shop), ['dotnet test Shop.Web.Tests'], 'the only unit tests');
    proj('Shop.Core.Tests', ['Shop.Core'], true);
    proj('Shop.IntegrationTests', ['Shop.Core', 'Shop.Web'], true);
    proj('Shop.GUI.Tests', ['Shop.Core'], true);
    assert.deepEqual(dotnetTests(shop), ['dotnet test Shop.Core.Tests'], "the tests of Shop.Core, which every other project builds on; never integration or GUI tests");
  } finally {
    rmSync(shop, { recursive: true, force: true });
  }
});

test('a settings.json with other keys but no employees keeps its keys, and gets the employees from the staff table', () => {
  writeFileSync(staffFile, JSON.stringify(staff));
  writeFileSync(settingsFile(), JSON.stringify({ parallel: 3, stewardRepo: 'octocat/my-steward' }));
  try {
    const s = loadSettings();
    assert.deepEqual([s.parallel, s.stewardRepo, s.stewardCheckout], [3, 'octocat/my-steward', ''], 'a repository it names is kept, and no clone is guessed for it');
    assert.deepEqual(s.employees.map((e) => e.id), ['porter', 'dotty']);
    assert.equal(JSON.parse(readFileSync(settingsFile(), 'utf8')).parallel, 3);
  } finally {
    clean();
  }
});

test('a settings.json that names its employees, even none, is never migrated; nor is a new install with no staff table', () => {
  writeFileSync(staffFile, JSON.stringify(staff));
  writeFileSync(settingsFile(), JSON.stringify({ employees: [] }));
  try {
    assert.deepEqual(loadSettings().employees, []);
    assert.equal(readFileSync(settingsFile(), 'utf8'), JSON.stringify({ employees: [] }));
    clean();
    assert.deepEqual(loadSettings().employees, []);
    assert.throws(() => readFileSync(settingsFile()), /ENOENT/, 'nothing written');
  } finally {
    clean();
  }
});

test("claim-version finds an employee by Settings, and the Steward's own from Settings or from the Steward clone it runs in", () => {
  const s = { ...DEFAULT_SETTINGS, employees: normalizeSettings({ employees: [{ id: 'porter', repo: 'octocat/porter', checkout: 'D:\\porter' }] }).settings.employees };
  assert.equal(employeeFor(s, 'porter', home)?.repo, 'octocat/porter');
  assert.equal(employeeFor(s, 'steward', home), null, 'no repository or clone of its own in Settings, and not run in one');
  const fromClone = employeeFor(s, 'steward', path.join(clones, 'Steward', 'kit'))!;
  assert.deepEqual([fromClone.repo, fromClone.checkout], ['octocat/steward', path.join(clones, 'Steward')]);
  const named = employeeFor({ ...s, stewardRepo: 'octocat/steward', stewardCheckout: 'D:\\steward' }, 'steward', home)!;
  assert.deepEqual([named.repo, named.checkout], ['octocat/steward', 'D:\\steward']);
});
