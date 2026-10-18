import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Steward 0.36.141: what the Steward does over and over, made lighter.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-efficiency-'));
process.env.STEWARD_HOME = path.join(home, 'steward');
process.env.MANOR_HOME = path.join(home, 'manor');
mkdirSync(process.env.STEWARD_HOME, { recursive: true });
after(() => rmSync(home, { recursive: true, force: true }));

const { steadyLog } = await import('../src/agent.ts');
const { lapped, lapsLine, SLOW_ROUND_MS, markStaffChecked, staffFile } = await import('../src/steward.ts');
const { repoSig } = await import('../src/glance.ts');
const { loadSettings, settingsFile, inEffect, isSelf, selfTest } = await import('../src/settings.ts');
const { migrateSettings, migrateToOwnRepos } = await import('../src/migrate.ts');
const { fileCounts } = await import('../src/kit/file-cache.ts');

/** Sets a file's times back, as a file written a while ago has them: its reads may then be kept. */
const settle = (file: string) => {
  const then = new Date(Date.now() - 60_000);
  utimesSync(file, then, then);
};

test('steadyLog: a line each quiet round says alike is written once, again when it changes or comes back; others always', () => {
  const written: string[] = [];
  const l = steadyLog((line) => written.push(line), [/^between builds: /]);
  const round = (...lines: string[]) => {
    for (const line of lines) l.say(line);
    l.roundDone();
  };
  round('between builds: the next at 12:00', '[reeve] failed: tests');
  round('between builds: the next at 12:00', '[reeve] failed: tests');
  round('between builds: the next at 12:00');
  round('between builds: the next at 19:30');
  round('the build begins');
  round('between builds: the next at 19:30');
  assert.deepEqual(written, ['between builds: the next at 12:00', '[reeve] failed: tests', '[reeve] failed: tests', 'between builds: the next at 19:30', 'the build begins', 'between builds: the next at 19:30']);
});

test('lapped: a slow run says where its time went, slowest first, steps under a second left out; a quick one says nothing', async () => {
  let t = 0;
  const said: string[] = [];
  const out = await lapped(
    (line) => said.push(line),
    async (lap) => {
      t += 6200;
      lap('glance at GitHub');
      t += 300;
      lap('tending');
      t += 19_000;
      lap("the staff's table");
      t += 2600;
      return 'done';
    },
    () => t,
  );
  assert.equal(out, 'done');
  assert.deepEqual(said, ["took 28.1 s: the staff's table 19.0 s, glance at GitHub 6.2 s, the rest 2.6 s"]);
  t = 0;
  await lapped((line) => said.push(line), async () => void (t += SLOW_ROUND_MS - 1), () => t);
  assert.equal(said.length, 1, 'under SLOW_ROUND_MS: nothing said');
  assert.equal(lapsLine(12_000, new Map([['a', 400]])), 'took 12.0 s');
  // A step that fails still says where the time went.
  t = 0;
  await assert.rejects(lapped((line) => said.push(line), async () => ((t += 15_000), Promise.reject(new Error('no'))), () => t));
  assert.equal(said.at(-1), 'took 15.0 s: the rest 15.0 s');
});

test("loadSettings: settings.json and the migrations' look at it parsed once while it is unchanged, and read afresh once it changes", () => {
  const file = settingsFile();
  writeFileSync(file, JSON.stringify({ releasesCastellan: false, byItself: true, roundMinutes: 15, employees: [] }));
  settle(file);
  loadSettings();
  const parsed = fileCounts.parsed;
  for (let i = 0; i < 20; i++) assert.equal(loadSettings().roundMinutes, 15);
  assert.equal(fileCounts.parsed, parsed, "the migrations' look kept");
  writeFileSync(file, JSON.stringify({ releasesCastellan: false, byItself: true, roundMinutes: 20, employees: [] }));
  assert.equal(loadSettings().roundMinutes, 20);
});

test("the migrations leave a settings.json that isn't JSON as it is, and still migrate a missing one", () => {
  const dir = path.join(home, 'migrations');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, '{not json');
  assert.equal(migrateSettings({ settingsFile: file, staffFile: path.join(dir, 'staff.json') }), null);
  assert.equal(migrateToOwnRepos({ settingsFile: file, dataDir: dir }), null);
  assert.equal(readFileSync(file, 'utf8'), '{not json');
  rmSync(file);
  // No file and no sign of an earlier run: a new install, written as one.
  assert.equal(migrateToOwnRepos({ settingsFile: file, dataDir: dir }), 'new');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { releasesCastellan: false });
  // The migrations' frozen look at it doesn't reach what they write.
  writeFileSync(file, JSON.stringify({ employees: [{ id: 'a', repo: 'someone/a', checkout: 'C:\\a' }] }));
  assert.equal(migrateToOwnRepos({ settingsFile: file, dataDir: dir, hasPublisherKey: () => true, dotnetHasSdk: () => false }), 'before');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).employees[0].merges, true);
});

test('selfTest: the same answers as isSelf, by repository or by clone, however the path is written', () => {
  const s = { stewardRepo: 'Someone/Steward', stewardCheckout: 'C:\\Code\\Steward\\' };
  const self = selfTest(s);
  for (const e of [{ repo: 'someone/steward' }, { checkout: 'c:\\code\\steward' }, { path: 'C:/Code/Steward' }, { repo: 'someone/other', checkout: 'C:\\Code\\Other' }, { checkout: 'Steward' }]) {
    assert.equal(self(e), isSelf(s, e), JSON.stringify(e));
  }
  assert.deepEqual([self({ repo: 'someone/steward' }), self({ checkout: 'C:\\Code\\Other' })], [true, false]);
  // inEffect leaves the Steward's own repository out of its employees on the PC that releases Castellan.
  const base = loadSettings();
  const e = (id: string, checkout: string) => ({ ...base.employees[0], id, name: id, repo: `someone/${id}`, checkout, branch: 'main' });
  const settings = { ...base, releasesCastellan: true, ...s, employees: [e('steward', 'C:\\Code\\Steward'), e('reeve', 'C:\\Code\\Reeve')] } as typeof base;
  assert.deepEqual(inEffect(settings, true, null, { makers: true }).employees.map((x) => x.id), ['reeve']);
});

test("markStaffChecked: the staff's table only marked checked while GitHub says nothing new, else why it is made again", () => {
  const g = (head: string) => ({ head, prs: [], releases: [] });
  const glance = (repos: Record<string, ReturnType<typeof g>>) => ({ at: '', stewardReleases: null, repos }) as any;
  const employees = [{ id: 'reeve' }, { id: 'herald' }] as any[];
  const table = { at: 'then', checked: 'then', rows: [{ id: 'reeve' }, { id: 'herald' }], seen: { reeve: repoSig(g('a')), herald: repoSig(g('b')) }, keys: {} };
  writeFileSync(staffFile(), JSON.stringify(table));
  assert.equal(markStaffChecked(glance({ reeve: g('a'), herald: g('b') }), employees, new Date('2026-10-18T12:00:00Z')), true);
  assert.equal(JSON.parse(readFileSync(staffFile(), 'utf8')).checked, '2026-10-18T12:00:00.000Z');
  assert.equal(markStaffChecked(glance({ reeve: g('c'), herald: g('d') }), employees), 'GitHub says something new of reeve, herald');
  assert.equal(markStaffChecked(glance({ reeve: g('a') }), employees), 'the glance says nothing of herald');
  assert.equal(markStaffChecked(glance({ reeve: g('a'), herald: g('b') }), [...employees, { id: 'clerk' }] as any[]), "it has 2 employees' rows, and Settings name 3");
  writeFileSync(staffFile(), JSON.stringify({ ...table, seen: undefined }));
  assert.equal(markStaffChecked(glance({ reeve: g('a'), herald: g('b') }), employees), "it wasn't made from a glance");
});
