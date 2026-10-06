import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const { migrationFile, pendingMigration } = await import('../src/migrate.ts');
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
  writeFileSync(path.join(manor, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'porter', internal: true }, { id: 'dotty' }] }));
  const before = process.env.MANOR_HOME;
  process.env.MANOR_HOME = manor;
  writeFileSync(staffFile, JSON.stringify(staff));
  try {
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
