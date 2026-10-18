import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

// The kit's captures (captures.ts, kit 2.87.0): which game a clip or screenshot is of, and where the capture apps keep
// them. The Chronicler's tests (clips: its own reading of names) and the Scribe's (screenshots: `requireStamp`, and
// Steam's folders with their games), each on made-up folders, as that agent walks them. Then Game Bar's Captures
// folder from the registry (folders.ts).
const { NOT_GAMES, captureKey, capturePlaces, gameFromName, isNvidiaName, walkCaptures } = await import('./fixture/src/kit/captures.ts');
const { foldersFrom } = await import('./fixture/src/kit/folders.ts');
type Entry = import('./fixture/src/kit/captures.ts').Entry;
type CapturePlace = import('./fixture/src/kit/captures.ts').CapturePlace;

// ---------------------------------------------------------------- the Chronicler's clips

const CLIP_EXT = /\.(mp4|mkv|mov|webm)$/i;
const CHRONICLER_NOT_GAMES = new Set(['captures', 'nvidia', 'radeon relive', 'amd', 'game clips', 'desktop', 'desktop.ini']);

test("a clip's game from its name, with the capture app's date and time taken off (the Chronicler's)", () => {
  assert.equal(gameFromName('Halo Infinite 2026-10-08 14-03-22.mp4'), 'Halo Infinite');
  assert.equal(gameFromName('Forza Horizon 5 10_8_2026 2_03_22 PM.mp4'), 'Forza Horizon 5');
  assert.equal(gameFromName('Cyberpunk 2077 2026.10.08 - 14.03.22.01.DVR.mp4'), 'Cyberpunk 2077');
  assert.equal(gameFromName('2026-10-08 14-03-22.mkv'), null, "OBS's: a date only");
  assert.equal(gameFromName('replay_2026.10.08-14.03.mp4'), null);
  assert.equal(gameFromName('Best goal ever.mp4'), 'Best goal ever');
  assert.equal(gameFromName('Gaming PC 2026-10-12 18-04-05.mp4'), 'Gaming PC', "a remote PC's recording, named as Game Bar names one");
});

const V = 'C:\\Users\\pat\\Videos';
const NOW = Date.parse('2026-10-08T12:00:00Z');
const old = NOW - 3_600_000;
const f = (name: string, bytes = 50_000_000, mtimeMs = old): Entry => ({ name, dir: false, bytes, mtimeMs });
const d = (name: string): Entry => ({ name, dir: true, bytes: 0, mtimeMs: old });

/** A made-up PC's Videos folder. */
const TREE: Record<string, Entry[]> = {
  [V]: [d('Captures'), d('NVIDIA'), d('Radeon ReLive'), d('Holidays'), d('Apex Legends'), d('Game clips'), f('Family video.mp4')],
  [path.join(V, 'Captures')]: [f('Halo Infinite 2026-10-08 14-03-22.mp4'), f('Halo Infinite 2026-10-07 20-00-00.mp4', 80_000_000), f('notes.txt'), f('Halo Infinite 2026-10-08 11-58-00.mp4', 10, NOW - 60_000)],
  [path.join(V, 'NVIDIA')]: [d('Cyberpunk 2077')],
  [path.join(V, 'NVIDIA', 'Cyberpunk 2077')]: [f('Cyberpunk 2077 2026.10.08 - 14.03.22.01.DVR.mp4', 200_000_000)],
  [path.join(V, 'Radeon ReLive')]: [d('Elden Ring')],
  [path.join(V, 'Radeon ReLive', 'Elden Ring')]: [f('replay_2026.10.08-14.03.mp4')],
  [path.join(V, 'Holidays')]: [f('Beach.mp4')],
  [path.join(V, 'Apex Legends')]: [f('Apex Legends 2026.10.01 - 21.00.00.01.DVR.mp4'), f('Edited.mp4')],
  [path.join(V, 'Game clips')]: [d('Halo Infinite')],
  'D:\\Medal': [d('Valorant'), f('Loose clip.mp4')],
  [path.join('D:\\Medal', 'Valorant')]: [f('ace.mp4')],
};
const list = (dir: string) => TREE[dir] ?? [];
/** The Chronicler's findClips, on the kit's walk. */
const findClips = (places: CapturePlace[], o: { list: (dir: string) => Entry[]; now: number; skip: string[] }) =>
  walkCaptures(places, { ext: CLIP_EXT, settledMs: 5 * 60_000, notGames: CHRONICLER_NOT_GAMES, ...o });

test('clips are found where Game Bar, NVIDIA and AMD keep them, and in folders added, each named by its game', () => {
  const clips = findClips(capturePlaces({ videos: V, captures: null, more: ['D:\\Medal'] }), { list, now: NOW, skip: [path.join(V, 'Game clips')] });
  assert.deepEqual(clips.map((c) => [c.game, c.name, c.source]).sort(), [
    ['Apex Legends', 'Apex Legends 2026.10.01 - 21.00.00.01.DVR.mp4', 'nvidia'],
    ['Cyberpunk 2077', 'Cyberpunk 2077 2026.10.08 - 14.03.22.01.DVR.mp4', 'nvidia'],
    ['Elden Ring', 'replay_2026.10.08-14.03.mp4', 'amd'],
    ['Halo Infinite', 'Halo Infinite 2026-10-07 20-00-00.mp4', 'gamebar'],
    ['Halo Infinite', 'Halo Infinite 2026-10-08 14-03-22.mp4', 'gamebar'],
    ['Loose clip', 'Loose clip.mp4', 'other'],
    ['Valorant', 'ace.mp4', 'other'],
  ]);
});

test("not taken: a clip still being written, anything not a video, home videos in Videos, and the library's own copies", () => {
  const clips = findClips(capturePlaces({ videos: V, captures: null, more: [] }), { list, now: NOW, skip: [path.join(V, 'Game clips')] });
  const names = clips.map((c) => c.name);
  assert.ok(!names.includes('Halo Infinite 2026-10-08 11-58-00.mp4'), 'changed a minute ago: still being written');
  for (const n of ['notes.txt', 'Family video.mp4', 'Beach.mp4', 'Edited.mp4']) assert.ok(!names.includes(n), n);
});

test('Captures moved elsewhere is looked in where Windows says it is', () => {
  const moved = { 'E:\\Caps': [f('Doom 2026-10-08 14-03-22.mp4')] } as Record<string, Entry[]>;
  const clips = findClips(capturePlaces({ videos: V, captures: 'E:\\Caps', more: [] }), { list: (dir) => moved[dir] ?? [], now: NOW, skip: [] });
  assert.deepEqual(clips.map((c) => c.game), ['Doom']);
});

// ---------------------------------------------------------------- the Scribe's screenshots

const SHOT_EXT = /\.(png|jpe?g|webp)$/i;
const SCRIBE_NOT_GAMES = new Set(['captures', 'nvidia', 'radeon relive', 'amd', 'game clips', 'desktop', 'thumbnails']);
const SNOW = Date.parse('2026-10-08T20:00:00Z');
const OLD = SNOW - 3600_000;
const file = (name: string, o: Partial<Entry> = {}): Entry => ({ name, dir: false, bytes: 1000, mtimeMs: OLD, ...o });
const dir = (name: string): Entry => ({ name, dir: true, bytes: 0, mtimeMs: OLD });
const fakeList = (tree: Record<string, Entry[]>) => (p: string) => tree[path.resolve(p)] ?? [];
/** The Scribe's findShots, on the kit's walk: Steam's folders after the capture apps', each with its game. */
const findShots = (places: CapturePlace[], steam: { dir: string; game: string }[], o: { list: (dir: string) => Entry[]; now: number }) =>
  walkCaptures([...places, ...steam.map((s): CapturePlace => ({ dir: s.dir, source: 'steam', byFolder: false, game: s.game }))], {
    ext: SHOT_EXT,
    settledMs: 10_000,
    requireStamp: true,
    notGames: SCRIBE_NOT_GAMES,
    ...o,
  });

test("a screenshot's game is its name with the capture app's date and time taken off (the Scribe's: requireStamp)", () => {
  const g = (name: string) => gameFromName(name, { requireStamp: true });
  assert.equal(g('Ashen Peaks 2026-10-08 20-15-33.png'), 'Ashen Peaks');
  assert.equal(g('Ashen Peaks 2026.10.08 - 20.15.33.04.png'), 'Ashen Peaks');
  assert.equal(g('Racer Pro 10_8_2026 8_15_33 PM.png'), 'Racer Pro');
  assert.equal(g('Ashen Peaks 2026-10-08 20-15-33 (2).png'), 'Ashen Peaks');
  assert.equal(g('20261008201533_1.jpg'), null, "Steam's own names say no game");
  assert.equal(g('Screenshot 2026-10-08.png'), null, 'no capture app named it');
  assert.equal(g('screenshot_12.png'), null);
  // Where the two readings differ: a name with no date is its own game only to the Chronicler.
  assert.equal(g('Best goal ever.mp4'), null);
  assert.equal(gameFromName('Ashen Peaks 2026-10-08 20-15-33 (2).png'), 'Ashen Peaks 2026-10-08 20-15-33 (2)', "a copy's (2) is the Scribe's alone");
});

test('the screenshots in every place, each once, with their games and sources, newest first', () => {
  const v = 'C:\\Users\\me\\Videos';
  const steamDir = 'C:\\Steam\\userdata\\1\\760\\remote\\570\\screenshots';
  const tree = {
    [path.resolve(v, 'Captures')]: [file('Ashen Peaks 2026-10-08 20-15-33.png', { mtimeMs: OLD + 5 }), file('Ashen Peaks 2026-10-08 20-15-33.mp4'), file('Racer Pro 2026-10-07 18-44-01.jpg')],
    [path.resolve(v, 'NVIDIA')]: [dir('Ashen Peaks')],
    [path.resolve(v, 'NVIDIA', 'Ashen Peaks')]: [file('Ashen Peaks 2026.10.08 - 20.40.01.02.png', { mtimeMs: OLD + 9 })],
    [path.resolve(v)]: [dir('Captures'), dir('Holiday'), file('Racer Pro 2026.10.07 - 18.50.00.01.png'), file('me.png')],
    [path.resolve(v, 'Holiday')]: [file('beach.png')],
    [path.resolve(steamDir)]: [file('20261008201533_1.jpg', { mtimeMs: OLD + 1 }), dir('thumbnails'), file('just now.png', { mtimeMs: SNOW - 2000 })],
  };
  const shots = findShots(capturePlaces({ videos: v, captures: null, more: [] }), [{ dir: steamDir, game: 'Dota 2' }], { list: fakeList(tree), now: SNOW });
  assert.deepEqual(
    shots.map((s) => [s.game, s.source, s.name]),
    [
      ['Ashen Peaks', 'nvidia', 'Ashen Peaks 2026.10.08 - 20.40.01.02.png'],
      ['Ashen Peaks', 'gamebar', 'Ashen Peaks 2026-10-08 20-15-33.png'],
      ['Dota 2', 'steam', '20261008201533_1.jpg'],
      ['Racer Pro', 'gamebar', 'Racer Pro 2026-10-07 18-44-01.jpg'],
      ['Racer Pro', 'nvidia', 'Racer Pro 2026.10.07 - 18.50.00.01.png'],
    ],
    "clips, a holiday folder, a loose photo and one still being written aren't taken",
  );
});

test("another folder from Settings: each subfolder a game, and a loose screenshot named by itself or the folder's", () => {
  const more = 'D:\\Shots';
  const tree = {
    [path.resolve(more)]: [dir('Moon Base'), file('Tiny Tanks 2026-01-02 03-04-05.png'), file('random.png')],
    [path.resolve(more, 'Moon Base')]: [file('a.png')],
  };
  const shots = findShots(capturePlaces({ videos: 'C:\\V', captures: null, more: [more] }), [], { list: fakeList(tree), now: SNOW });
  assert.deepEqual(shots.map((s) => [s.game, s.name]).sort(), [
    ['Moon Base', 'a.png'],
    ['Shots', 'random.png'],
    ['Tiny Tanks', 'Tiny Tanks 2026-01-02 03-04-05.png'],
  ]);
});

// ---------------------------------------------------------------- the kit's own

test('each capture once, from the first place it is found in; empty files and skipped folders left out; keys change with the file', () => {
  const tree: Record<string, Entry[]> = {
    [path.join(V, 'Captures')]: [f('Doom 2026-10-08 14-03-22.mp4'), f('Empty 2026-10-08 14-03-22.mp4', 0)],
    'D:\\More': [d('Thumbnails'), d('Quake'), d('Skipped')],
    [path.join('D:\\More', 'Thumbnails')]: [f('t.mp4')],
    [path.join('D:\\More', 'Quake')]: [f('q.mp4')],
    [path.join('D:\\More', 'Skipped')]: [f('s.mp4')],
  };
  // Game Bar's folder added again in Settings, in another case: still once, as Game Bar's.
  const places = capturePlaces({ videos: V, captures: null, more: [path.join(V, 'CAPTURES'), 'D:\\More'] });
  const at = (p: string) => tree[Object.keys(tree).find((k) => k.toLowerCase() === p.toLowerCase()) ?? ''] ?? [];
  const clips = walkCaptures(places, { ext: CLIP_EXT, settledMs: 0, now: NOW, list: at, skip: ['d:\\more\\SKIPPED'] });
  assert.deepEqual(clips.map((c) => [c.game, c.source, c.name]).sort(), [
    ['Doom', 'gamebar', 'Doom 2026-10-08 14-03-22.mp4'],
    ['Quake', 'other', 'q.mp4'],
  ]);
  assert.ok(NOT_GAMES.has('thumbnails') && NOT_GAMES.has('desktop.ini'), "both agents' lists");
  const withThumbs = walkCaptures(places, { ext: CLIP_EXT, settledMs: 0, now: NOW, list: at, notGames: CHRONICLER_NOT_GAMES });
  assert.ok(withThumbs.some((c) => c.game === 'Thumbnails'), "the agent's own list, when given");
  assert.ok(walkCaptures(capturePlaces({ videos: V, captures: null, more: ['D:\\More'] }), { ext: CLIP_EXT, settledMs: 0, now: NOW, list: at, skip: ['D:\\More'] }).every((c) => c.source !== 'other'), 'a place skipped whole');
  const c = clips[0];
  assert.notEqual(captureKey(c), captureKey({ ...c, bytes: c.bytes + 1 }));
  assert.equal(captureKey(c), captureKey({ ...c, path: c.path.toUpperCase() }), 'the same file in any case');
  assert.ok(isNvidiaName('Halo 2026.10.08 - 14.03.22.01.DVR.mp4') && !isNvidiaName('Halo 2026-10-08 14-03-22.mp4'));
});

test("Game Bar's Captures folder: where Windows says (moved, or %USERPROFILE% expanded), else Videos\\Captures", () => {
  const home = path.join('C:', 'Users', 'pat');
  const GUID = '{EDC0FE71-98D8-4F4A-B920-C8DC133CB165}';
  const reg = (value: string) => ['HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', `    My Video    REG_EXPAND_SZ    D:\\Vids`, `    ${GUID}    REG_EXPAND_SZ    ${value}`].join('\r\n');
  assert.equal(foldersFrom(reg('E:\\Game captures'), { home, env: {} }).captures, path.normalize('E:\\Game captures'));
  assert.equal(foldersFrom(reg('%USERPROFILE%\\Caps'), { home, env: { USERPROFILE: home } }).captures, path.normalize(`${home}\\Caps`));
  assert.equal(foldersFrom(reg('%NOPE%\\Caps'), { home, env: {} }).captures, path.join(path.normalize('D:\\Vids'), 'Captures'), "didn't expand: under Videos, wherever that is");
  assert.equal(foldersFrom(null, { home, env: {} }).captures, path.join(home, 'Videos', 'Captures'));
});
