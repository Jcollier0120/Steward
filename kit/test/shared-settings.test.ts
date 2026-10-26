import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

// The settings every agent shares (shared-settings.ts) and the known folders (folders.ts).
const ss = await import('./fixture/src/kit/shared-settings.ts');
const { foldersFrom, KNOWN_FOLDERS_SCRIPT, parseShellFolders, readKnownFolders, uniqueFolders } = await import('./fixture/src/kit/folders.ts');
const { powershellSync } = await import('./fixture/src/kit/ps.ts');
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

const REG = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders
    Desktop    REG_EXPAND_SZ    %OneDrive%\Desktop
    Personal    REG_EXPAND_SZ    %ONEDRIVE%\Documents
    My Pictures    REG_EXPAND_SZ    %OneDrive%\Pictures
    My Music    REG_EXPAND_SZ    %USERPROFILE%\Music
    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    D:\Downloads
    My Video    REG_EXPAND_SZ    %NOPE%\Videos
`;

test('knownFolders: where Windows has them, OneDrive moves included; the usual places for the rest', () => {
  const home = 'C:\\Users\\pat';
  const od = 'C:\\Users\\pat\\OneDrive';
  const env = { OneDrive: od, USERPROFILE: home };
  assert.equal(parseShellFolders(REG, env).Personal, `${od}\\Documents`, '%NAME% expanded, ignoring case');
  // As reg.exe answered before kit 2.137.2, and as Windows answers now (KNOWN_FOLDERS_SCRIPT's JSON): the same places.
  const answer = JSON.stringify({ desktop: `${od}\\Desktop`, documents: `${od}\\Documents`, downloads: 'D:\\Downloads', pictures: `${od}\\Pictures`, music: `${home}\\Music`, videos: '', screenshots: '', captures: '' });
  for (const k of [foldersFrom(REG, { home, env }), foldersFrom(answer, { home, env })]) {
    assert.equal(k.desktop, path.normalize(`${od}\\Desktop`));
    assert.equal(k.documents, path.normalize(`${od}\\Documents`));
    assert.equal(k.pictures, path.normalize(`${od}\\Pictures`));
    assert.equal(k.screenshots, path.join(k.pictures, 'Screenshots'), "Windows doesn't say: Pictures\\Screenshots");
    assert.equal(k.downloads, path.normalize('D:\\Downloads'), "Downloads by FOLDERID_Downloads' GUID, moved");
    assert.equal(k.videos, path.join(home, 'Videos'), 'a name that did not expand, or none: the usual place');
    assert.equal(k.oneDrive, od);
  }
  const none = foldersFrom(null, { home, env: {} });
  assert.deepEqual([none.documents, none.downloads, none.oneDrive], [path.join(home, 'Documents'), path.join(home, 'Downloads'), null]);
  const odd = foldersFrom(JSON.stringify({ documents: 'Documents', downloads: 'D:Downloads', music: 7 }), { home, env: {} });
  assert.deepEqual([odd.documents, odd.downloads, odd.music], [path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'Music')], 'not a full path: the usual place');
  assert.equal(foldersFrom('{not json', { home, env: {} }).documents, path.join(home, 'Documents'));
  assert.deepEqual(uniqueFolders(['C:\\A', 'c:\\a', null, '', 'C:\\B']), ['C:\\A', 'C:\\B']);
});

test("knownFolders asks Windows in one script, UTF-8 end to end: a user or folder name in another script comes back exact", { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  // A user name and folders in four scripts, made inside PowerShell from their code points: the script stays ASCII, and
  // only the answer carries them, as Windows' own does. reg.exe, writing in the console's code page, mangled these.
  const spell = (s: string) => `(-join [char[]]@(${[...s].map((c) => c.codePointAt(0)).join(',')}))`;
  const documents = 'C:\\Users\\Jürgen 李\\OneDrive - Société\\Документы\\書類';
  const lookup = "[Environment]::GetFolderPath('MyDocuments', 'DoNotVerify')";
  // User Shell Folders as the registry holds them (Get-ItemProperty's object), %USERPROFILE% left for the script to expand.
  const read = KNOWN_FOLDERS_SCRIPT.split('\n')[0];
  const shots = '%USERPROFILE%\\Изображения\\スクリーンショット';
  const usf = `$usf = [pscustomobject]@{ '{B7BEDE81-DF94-4682-A7D8-57A52620B86F}' = ${spell(shots)}; '{374DE290-123F-4565-9164-39C4925E467B}' = ${spell('D:\\Téléchargements')} }`;
  assert.ok(KNOWN_FOLDERS_SCRIPT.includes(lookup) && read.startsWith('$usf = Get-ItemProperty'), KNOWN_FOLDERS_SCRIPT);
  const r = readKnownFolders((script) => powershellSync(script.replace(lookup, spell(documents)).replace(read, usf), { timeoutMs: 60_000 }));
  assert.equal(r.answered, true);
  assert.equal(r.folders.documents, documents);
  assert.equal(r.folders.screenshots, path.normalize(shots.replace('%USERPROFILE%', process.env.USERPROFILE ?? '')));
  assert.equal(r.folders.downloads, 'D:\\Téléchargements');
  // This PC's own answer: full paths, with no stand-in.
  const own = readKnownFolders();
  assert.equal(own.answered, true);
  for (const k of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos', 'screenshots', 'captures'] as const) assert.ok(path.isAbsolute(own.folders[k]), `${k}: ${own.folders[k]}`);
  // No answer (PowerShell failing, or not JSON): the usual places, and knownFolders asks again later.
  assert.deepEqual(readKnownFolders(() => { throw new Error('PowerShell timed out'); }), { folders: foldersFrom(null), answered: false });
  assert.equal(readKnownFolders(() => 'WARNING: something').answered, false);
});

test("a path the agent makes (missing: 'made') is kept with no warning while it's missing; one that's a file is still refused", () => {
  const f = { key: 'work', kind: 'text', label: 'Work', help: 'h', maxLength: 260, path: { is: 'folder', missing: 'made' } } as any;
  const gone = path.join(process.cwd(), 'no-such-folder-' + Date.now());
  assert.deepEqual(checkValues([f], { work: gone }), { errors: {}, warnings: {} });
  assert.match(checkValues([{ ...f, path: { is: 'folder', missing: 'warn' } }], { work: gone }).warnings.work ?? '', /no such folder/);
  assert.match(checkValues([f], { work: path.join(process.cwd(), 'package.json') }).errors.work ?? '', /a file, not a folder/);
});
