import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

// The settings every agent shares (shared-settings.ts) and the known folders (folders.ts).
const ss = await import('./fixture/src/kit/shared-settings.ts');
const { foldersFrom, parseShellFolders, uniqueFolders } = await import('./fixture/src/kit/folders.ts');
const { checkValues } = await import('./fixture/src/kit/settings-kit.ts');

const ROUND = { min: 5, max: 240, default: 15 };

test('roundEvery: one key, in minutes, always under Advanced; its bounds are the agent’s', () => {
  const f = ss.roundEveryField(ROUND);
  assert.deepEqual({ key: f.key, kind: f.kind, min: (f as any).min, max: (f as any).max, unit: (f as any).unit, advanced: f.advanced }, { key: 'roundEvery', kind: 'whole', min: 5, max: 240, unit: 'minutes', advanced: true });
  assert.deepEqual(checkValues([f], { roundEvery: 300 }).errors.roundEvery !== undefined, true, 'the form refuses one out of bounds');
  assert.throws(() => ss.roundEveryField({ min: 5, max: 10, default: 30 }), /min <= default <= max/);
  assert.throws(() => ss.roundEveryField({ min: 0, max: 10, default: 5 }), /at least a minute/);
});

test('readRoundEvery: roundEvery, else the older key in its unit, else the default; out of bounds, the nearest', () => {
  assert.equal(ss.readRoundEvery({ roundEvery: 30 }, ROUND), 30);
  assert.equal(ss.readRoundEvery({}, ROUND), 15);
  assert.equal(ss.readRoundEvery(null, ROUND), 15);
  assert.equal(ss.readRoundEvery({ intervalMinutes: 20 }, ROUND, { was: { key: 'intervalMinutes' } }), 20, 'taken over from the older key');
  assert.equal(ss.readRoundEvery({ everyHours: 2 }, ROUND, { was: { key: 'everyHours', minutes: 60 } }), 120, 'hours, as minutes');
  assert.equal(ss.readRoundEvery({ roundEvery: 30, intervalMinutes: 20 }, ROUND, { was: { key: 'intervalMinutes' } }), 30, 'roundEvery wins');
  const problems: string[] = [];
  assert.equal(ss.readRoundEvery({ roundEvery: 1000 }, ROUND, { problems }), 240);
  assert.equal(ss.readRoundEvery({ roundEvery: 'ten' }, ROUND, { problems }), 15);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /roundEvery should be a whole number from 5 to 240; using 240\./);
});

test('roundEveryMs: read from the settings each time every() sets a wait', () => {
  let s: object = { roundEvery: 10 };
  const ms = ss.roundEveryMs(() => s, ROUND);
  assert.equal(ms(), 600_000);
  s = { roundEvery: 20 };
  assert.equal(ms(), 1_200_000, 'a change is used from the next wait');
});

test('plainNotes and modelCallsPerRound: the switch on the page, the calls under Advanced', () => {
  const notes = ss.plainNotesField();
  assert.equal(notes.key, 'plainNotes');
  assert.equal(notes.kind, 'switch');
  assert.equal(notes.advanced, undefined);
  assert.equal(ss.readPlainNotes({ plainNotes: false }, true), false);
  assert.equal(ss.readPlainNotes({ summarize: false }, true, { was: 'summarize' }), false, 'taken over from the older switch');
  assert.equal(ss.readPlainNotes({}, true), true);
  assert.equal(ss.readPlainNotes({ plainNotes: 'yes' }, true), true, 'not a switch: the default');

  const calls = ss.modelCallsField({ max: 10, default: 6 }, { unit: 'notes' });
  assert.deepEqual({ key: calls.key, min: (calls as any).min, max: (calls as any).max, unit: (calls as any).unit, advanced: calls.advanced }, { key: 'modelCallsPerRound', min: 0, max: 10, unit: 'notes', advanced: true });
  assert.equal(ss.readModelCalls({ modelCallsPerRound: 0 }, { max: 10, default: 6 }), 0, 'none is allowed');
  assert.equal(ss.readModelCalls({ maxReleasesPerRound: 3 }, { max: 10, default: 6 }, { was: 'maxReleasesPerRound' }), 3);
  assert.equal(ss.readModelCalls({ modelCallsPerRound: 99 }, { max: 10, default: 6 }), 10);
  assert.equal(ss.readModelCalls({}, { max: 10, default: 6 }), 6);
  assert.throws(() => ss.modelCallsField({ max: 3, default: 6 }));
});

const REG = `
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders
    Desktop    REG_EXPAND_SZ    %OneDrive%\Desktop
    Personal    REG_EXPAND_SZ    %ONEDRIVE%\Documents
    My Pictures    REG_EXPAND_SZ    %OneDrive%\Pictures
    My Music    REG_EXPAND_SZ    %USERPROFILE%\Music
    {374DE290-123F-4565-9164-B4428B6E2FCB}    REG_EXPAND_SZ    D:\Downloads
    My Video    REG_EXPAND_SZ    %NOPE%\Videos
`;

test('knownFolders: where Windows has them, OneDrive moves included; the usual places for the rest', () => {
  const home = path.join('C:', 'Users', 'pat');
  const od = path.join(home, 'OneDrive');
  const env = { OneDrive: od, USERPROFILE: home };
  assert.equal(parseShellFolders(REG, env).Personal, `${od}\Documents`, '%NAME% expanded, ignoring case');
  const k = foldersFrom(REG, { home, env });
  assert.equal(k.desktop, path.normalize(`${od}\Desktop`));
  assert.equal(k.documents, path.normalize(`${od}\Documents`));
  assert.equal(k.pictures, path.normalize(`${od}\Pictures`));
  assert.equal(k.screenshots, path.join(k.pictures, 'Screenshots'), "Windows doesn't say: Pictures\Screenshots");
  assert.equal(k.downloads, path.normalize('D:\Downloads'));
  assert.equal(k.videos, path.join(home, 'Videos'), 'a name that did not expand: the usual place');
  assert.equal(k.oneDrive, od);
  const none = foldersFrom(null, { home, env: {} });
  assert.deepEqual([none.documents, none.downloads, none.oneDrive], [path.join(home, 'Documents'), path.join(home, 'Downloads'), null]);
  assert.deepEqual(uniqueFolders(['C:\A', 'c:\a', null, '', 'C:\B']), ['C:\A', 'C:\B']);
});
