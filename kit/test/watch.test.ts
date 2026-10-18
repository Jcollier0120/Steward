import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The kit's folder watcher (watch.ts, kit 2.87.0: the Chamberlain's and the Cellarer's). Their tests on stand-in
// watchers, once with each agent's folders (documents and mail, pictures and documents) and a `wants` like its own;
// then once on a real folder in a scratch folder. No folder of yours is watched.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-watch-'));
after(() => rmSync(home, { recursive: true, force: true }));

const { FolderWatch, MAX_CHANGES, folderKey } = await import('./fixture/src/kit/watch.ts');
type Changes = import('./fixture/src/kit/watch.ts').Changes;
type WatchedFolder = import('./fixture/src/kit/watch.ts').WatchedFolder;

/** Stand-in watchers: `emit(folder, event, name)` is a change there; `fail(folder)` its error. */
function watchers() {
  const open = new Map<string, { listener: (e: string, n: string | null) => void; em: EventEmitter; closed: boolean }>();
  const opened: string[] = [];
  return {
    opened,
    open,
    watch: (folder: string, opts: { recursive: boolean; persistent: boolean }, listener: (e: string, n: string | Buffer | null) => void) => {
      assert.deepEqual(opts, { recursive: true, persistent: false }, 'with subfolders, and never keeping the process alive');
      if (folder.includes('missing')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const em = new EventEmitter();
      const w = { listener: listener as (e: string, n: string | null) => void, em, closed: false };
      open.set(folder, w);
      opened.push(folder);
      return {
        close: () => void (w.closed = true),
        on: (ev: string, fn: (...a: any[]) => void) => {
          em.on(ev, fn);
          return undefined as any;
        },
      };
    },
    emit: (folder: string, event: 'rename' | 'change', name: string | null) => open.get(folder)!.listener(event, name),
    fail: (folder: string) => open.get(folder)!.em.emit('error', new Error('EPERM')),
  };
}

const listOf = (c: Changes | undefined) => (c === undefined || c === 'all' ? c : [...c].sort());
/** Each folder once, as both agents' watchedFolders give them. */
const once = (folders: WatchedFolder[]) => folders.filter((f, i) => folders.findIndex((g) => folderKey(g.folder) === folderKey(f.folder)) === i);

/** Each agent's folders, a `wants` like its own, and the names its tests change. */
const AGENTS = [
  {
    agent: 'the Chamberlain',
    a: path.resolve('/Documents'),
    b: path.resolve('/Saved mail'),
    wants: (rel: string, named: boolean) => !/(^|\\)\.[^\\]+\\/.test(rel) && (named || /\.(txt|docx|pdf|md|eml)$/i.test(rel)),
    names: { file: 'a.txt', other: 'b.docx', folder: 'Letters', unwanted: 'photo.jpg' },
  },
  {
    agent: 'the Cellarer',
    a: path.resolve('/Pictures'),
    b: path.resolve('/Documents'),
    wants: (rel: string, named: boolean) => !/^Backups\\Cellarer(\\|$)/i.test(rel) && (named || !/(^|\\)(Thumbs\.db|~\$[^\\]*)$/i.test(rel)),
    names: { file: 'a.jpg', other: 'b.jpg', folder: '2024', unwanted: 'Thumbs.db' },
  },
];

for (const s of AGENTS) {
  const folders = (list: string[]): WatchedFolder[] => once(list.map((folder) => ({ folder, wants: s.wants })));

  test(`${s.agent}: a folder is walked whole until it has been watched since the last round; then only the names changed in it count`, () => {
    const w = watchers();
    const fw = new FolderWatch({ folders: () => folders([s.a, s.a.toUpperCase()]), watch: w.watch });
    fw.refresh();
    assert.deepEqual(fw.watching, [s.a], 'each folder once');
    w.emit(s.a, 'rename', s.names.file);
    assert.equal(fw.take().get(folderKey(s.a)), 'all', 'watched only since: what changed before is not known');

    const n = s.names;
    w.emit(s.a, 'change', n.file);
    w.emit(s.a, 'rename', n.folder);
    w.emit(s.a, 'change', n.folder);
    w.emit(s.a, 'change', n.other);
    w.emit(s.a, 'rename', n.other);
    w.emit(s.a, 'change', n.unwanted);
    assert.deepEqual(listOf(fw.take().get(folderKey(s.a))), [[n.folder, true], [n.file, false], [n.other, true]].sort(), 'added, removed or renamed (true) or only written to; what it never looks at, left out');
    assert.deepEqual(listOf(fw.take().get(folderKey(s.a))), [], 'taken: it starts again');

    w.emit(s.a, 'rename', null);
    w.emit(s.a, 'rename', 'c.txt');
    assert.equal(fw.take().get(folderKey(s.a)), 'all', "a change the system didn't name");
    for (let i = 0; i <= MAX_CHANGES; i++) w.emit(s.a, 'rename', `copy\\${i}.txt`);
    assert.equal(fw.take().get(folderKey(s.a)), 'all', 'more changes than are kept');
    fw.stop();
  });

  test(`${s.agent}: folders follow the settings: new ones watched, gone ones closed; a failed watcher is closed, and opened again as unknown`, () => {
    const w = watchers();
    let list = [s.a];
    const fw = new FolderWatch({ folders: () => folders(list), watch: w.watch });
    fw.refresh();
    fw.take();
    const missing = path.resolve('/missing');
    list = [s.a, s.b, missing];
    fw.refresh();
    assert.deepEqual(fw.watching, [s.a, s.b], "a folder that can't be watched is walked each round, without throwing");
    const t = fw.take();
    assert.deepEqual([listOf(t.get(folderKey(s.a))), t.get(folderKey(s.b)), t.has(folderKey(missing))], [[], 'all', false]);

    list = [s.b];
    fw.refresh();
    assert.deepEqual(fw.watching, [s.b]);
    assert.equal(w.open.get(s.a)!.closed, true);
    w.emit(s.a, 'rename', 'old.txt');
    assert.equal(fw.take().has(folderKey(s.a)), false, 'a closed folder says nothing');

    w.emit(s.b, 'change', 'letter.docx');
    w.fail(s.b);
    assert.deepEqual(fw.watching, [], 'an error closes it');
    assert.equal(fw.take().has(folderKey(s.b)), false, 'and its changes are not known: the round walks it');
    fw.refresh();
    assert.deepEqual(fw.watching, [s.b], 'the next refresh watches it again');
    assert.equal(fw.take().get(folderKey(s.b)), 'all');
    assert.equal(w.opened.filter((f) => f === s.b).length, 2);

    fw.stop();
    assert.deepEqual(fw.watching, []);
    assert.ok([...w.open.values()].every((x) => x.closed));
    fw.refresh();
    assert.deepEqual(fw.watching, [], 'stopped stays stopped');
    const bad = new FolderWatch({
      folders: () => {
        throw new Error('registry gone');
      },
      watch: w.watch,
    });
    assert.doesNotThrow(() => bad.refresh());
  });
}

test("a folder's wants changed in Settings applies from the next refresh, to the watcher already open; a key of the agent's own", () => {
  const w = watchers();
  const a = path.resolve('/Documents');
  let wants = (rel: string) => rel.endsWith('.txt');
  const fw = new FolderWatch({ folders: () => [{ folder: a, wants: (rel) => wants(rel) }], watch: w.watch, key: (f) => `key:${f}` });
  fw.refresh();
  fw.take();
  w.emit(a, 'change', 'a.md');
  w.emit(a, 'change', 'a.txt');
  assert.deepEqual(listOf(fw.take().get(`key:${a}`)), [['a.txt', false]]);
  const before = fw.take();
  assert.ok(!before.has(folderKey(a)), 'keyed as the agent says');
  wants = (rel) => rel.endsWith('.md');
  fw.refresh();
  w.emit(a, 'change', 'a.md');
  assert.deepEqual(listOf(fw.take().get(`key:${a}`)), [['a.md', false]]);
  assert.equal(w.opened.length, 1, 'not opened again');
  assert.equal(folderKey(`${a.toUpperCase()}${path.sep}`), folderKey(a), 'the same folder in any case, with or without its last separator');
  fw.stop();
});

async function until(ok: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('on a real folder: a new file in a subfolder is a change', async () => {
  const folder = path.join(home, 'Watched');
  mkdirSync(path.join(folder, 'Letters'), { recursive: true });
  writeFileSync(path.join(folder, 'old.txt'), 'x');
  const k = folderKey(folder);
  const fw = new FolderWatch({ folders: () => [{ folder, wants: () => true }] });
  fw.refresh();
  try {
    assert.deepEqual(fw.watching, [folder]);
    assert.equal(fw.take().get(k), 'all');
    const seen = new Map<string, boolean>();
    writeFileSync(path.join(folder, 'Letters', 'new.txt'), 'x');
    await until(() => {
      const c = fw.take().get(k);
      if (c && c !== 'all') for (const [n, v] of c) seen.set(n, v || !!seen.get(n));
      return seen.has(path.join('Letters', 'new.txt'));
    });
    assert.equal(seen.get(path.join('Letters', 'new.txt')), true, 'added');
  } finally {
    fw.stop();
  }
});
