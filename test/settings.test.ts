import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's settings: the ten employees, and what the schema refuses. (test/agent.test.ts runs the
// kit's own checks of the schema and its defaults, as in every agent.)
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-settings-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { DEFAULT_SETTINGS, SETTINGS_SPEC, loadSettings, normalizeSettings } = await import('../src/settings.ts');
const { saveSettingsReply } = await import('../src/kit/settings-kit.ts');
const { pick } = await import('../src/stages/common.ts');
const save = async (values: Record<string, unknown>) => (await saveSettingsReply(SETTINGS_SPEC, { values })) as { status?: number; json: any };

test('eleven employees, all on the kit: the eight hires, Reeve and Heiward, then the Surveyor, each with the parts and commands of its own', () => {
  const e = DEFAULT_SETTINGS.employees;
  assert.deepEqual(e.map((x) => x.id), ['porter', 'auditor', 'clerk', 'herald', 'warrener', 'aletaster', 'miller', 'pinder', 'reeve', 'heiward', 'surveyor']);
  for (const h of e.slice(0, 8)) {
    assert.equal(h.usesKit, true);
    assert.equal(h.repo, `Jcollier0120/${h.name}`);
    assert.equal(h.checkout, `C:\\Projects\\${h.name}`);
    assert.deepEqual(h.parts, ['node', 'web', 'spec']);
    assert.deepEqual(h.versionFiles, ['package.json', 'package-lock.json', 'src/app.ts']);
  }
  const [reeve, heiward] = e.slice(8);
  assert.equal(reeve.usesKit, true);
  assert.deepEqual(reeve.parts, ['node', 'spec']);
  assert.equal(reeve.fill, 'node tools/kit.ts');
  assert.deepEqual(reeve.versionFiles, ['package.json', 'package-lock.json', 'src/mcp.ts']);
  // After merging: every Node agent installs from its release; only Reeve has jobs to approve; Heiward is a Windows app.
  assert.equal(reeve.install, 'node src/cli.ts install');
  assert.equal(reeve.approve, 'node %USERPROFILE%\\.reeve\\app\\src\\cli.ts jobs approve {job}');
  assert.deepEqual([e[0].approve, heiward.install, heiward.approve], ['', '', '']);
  assert.equal(heiward.usesKit, true);
  assert.equal(heiward.fill, 'powershell -NoProfile -File tools\\kit.ps1');
  assert.equal(heiward.branch, 'master');
  assert.deepEqual(heiward.parts, ['spec']);
  assert.deepEqual(heiward.test, ['dotnet test HEI.Core.Tests']);
  assert.deepEqual(heiward.versionFiles, ['HEI.Agent/HEI.Agent.csproj']);
  assert.match(heiward.release, /HEI\.Agent\\release\.ps1 -Publish/);
  // A settings.json that names them with nothing more takes these defaults; one that turned the kit off keeps it off.
  const saved = normalizeSettings({ employees: [{ id: 'reeve' }, { id: 'heiward' }, { id: 'porter', usesKit: false }] }).settings.employees;
  assert.deepEqual(saved.map((x) => [x.id, x.usesKit, x.branch]), [['reeve', true, 'main'], ['heiward', true, 'master'], ['porter', false, 'main']]);
  assert.equal(DEFAULT_SETTINGS.releaseAfterMerge, false, 'release is a stage of its own, unless Settings say otherwise');
  assert.deepEqual([DEFAULT_SETTINGS.byItself, DEFAULT_SETTINGS.roundMinutes], [true, 10], 'it merges and releases by itself, a round every 10 minutes on duty');
  assert.deepEqual([normalizeSettings({ roundMinutes: 1 }).settings.roundMinutes, normalizeSettings({ byItself: false }).settings.byItself], [2, false]);
  assert.deepEqual(DEFAULT_SETTINGS.team, ['Jcollier0120'], 'you, and Claude Code, which opens its PRs with your account');
  assert.equal(DEFAULT_SETTINGS.workRoot, path.join(home, 'work'));
});

test('a repository not owner/name, an id twice, or an employee with no version file is refused field by field, and nothing is written', async () => {
  const bad = structuredClone(DEFAULT_SETTINGS.employees);
  bad[0].repo = 'Porter';
  bad[1].id = 'porter';
  bad[2].versionFiles = [];
  const r = await save({ employees: bad });
  assert.equal(r.status, 400);
  assert.match(r.json.errors['employees.0.repo'], /owner\/name/);
  assert.match(r.json.errors['employees.1.id'], /Already listed/);
  assert.match(r.json.errors['employees.2.versionFiles'], /at least one/);
  assert.throws(() => readFileSync(SETTINGS_SPEC.file()), /ENOENT/);
});

test('a team account that isn\'t one, or one listed twice in any case, is refused', async () => {
  const r = await save({ team: ['Jcollier0120', 'not an account', 'jcollier0120'] });
  assert.equal(r.status, 400);
  assert.match(r.json.errors['team.1'], /a GitHub account/);
  assert.match(r.json.errors['team.2'], /Listed twice/);
});

test('a good change is saved and read back; release after merge can be switched on, and the team grown', async () => {
  const r = await save({ releaseAfterMerge: true, parallel: 4, team: ['Jcollier0120', 'app/claude'] });
  assert.equal(r.status, undefined);
  assert.equal(r.json.ok, true);
  const s = loadSettings();
  assert.equal(s.releaseAfterMerge, true);
  assert.equal(s.parallel, 4);
  assert.deepEqual(s.team, ['Jcollier0120', 'app/claude']);
  assert.equal(s.employees.length, 11);
  assert.deepEqual(normalizeSettings({}).settings.team, ['Jcollier0120'], 'no team in the file is the default team');
  assert.deepEqual(normalizeSettings({ team: [] }).settings.team, [], 'an empty one stays empty');
});

test('an employee without a usable id is left out, and said so; the stages take only known employees', () => {
  const { settings, problems } = normalizeSettings({ employees: [{ id: 'porter' }, { id: 'Not An Id' }, { name: 'none' }] });
  assert.deepEqual(settings.employees.map((e) => e.id), ['porter']);
  assert.equal(settings.employees[0].repo, 'Jcollier0120/Porter', "a known employee's missing fields are its defaults");
  assert.match(problems.join(' '), /2 employee\(s\) without a usable id/);
  assert.deepEqual((pick(DEFAULT_SETTINGS.employees, ['Pinder', 'porter']) as any).employees.map((e: any) => e.id), ['porter', 'pinder']);
  assert.match((pick(DEFAULT_SETTINGS.employees, ['porter', 'reve']) as { error: string }).error, /no employee called reve/);
});
