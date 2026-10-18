import { watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';

/**
 * Watches an agent's folders, so a round looks again only at what changed in them instead of walking every folder.
 * Each folder is watched with its subfolders (fs.watch, recursive), and the names changed in it are kept until the
 * round takes them (take()): a name added, removed or renamed (it may be a folder, whose files are then listed
 * again), or a file written to. What the agent never looks at is left out as it changes: each folder's `wants` says
 * (the Chamberlain's hidden and system folders and formats it doesn't read, the Cellarer's backup and leftovers).
 *
 * What the watcher can't vouch for is walked whole: a folder watched only since the last round, one that can't be
 * watched or whose watcher failed, one with more changes than are kept (MAX_CHANGES), or a change the system didn't
 * name. The agent walks them all now and then anyway (its sweep), for a change missed. Nothing here keeps the process
 * alive (no persistent watcher) or throws: a watcher that fails is closed, and opened again at the next refresh().
 *
 * Kit 2.87.0: the Chamberlain's and the Cellarer's watch.ts, the same but for the name of the folder key; each keeps
 * its own watchedFolders (which folders, and what in them it wants).
 */

/**
 * What changed in a folder since it was last taken: each name changed (relative to the folder), with whether it was
 * added, removed or renamed (else only written to); or 'all' when that isn't known, and the folder is walked whole.
 */
export type Changes = Map<string, boolean> | 'all';

export interface WatchedFolder {
  folder: string;
  /** Whether a change to this name (relative to the folder) is kept: `named` when it was added, removed or renamed, else written to. */
  wants: (rel: string, named: boolean) => boolean;
}

export type WatchFn = (folder: string, opts: { recursive: boolean; persistent: boolean }, listener: (event: string, name: string | Buffer | null) => void) => Pick<FSWatcher, 'close' | 'on'>;

export interface FolderWatchOptions {
  /** The folders to watch now (present ones only): asked at each refresh(). */
  folders: () => WatchedFolder[];
  /** fs.watch, or a stand-in for tests. */
  watch?: WatchFn;
  /** A folder's key in take()'s answer, and how two folders are told to be one: folderKey unless given. */
  key?: (folder: string) => string;
}

/** More changes than this in a folder between two rounds (a large copy, say), and the folder is walked whole. */
export const MAX_CHANGES = 20_000;

/** A folder's key: its full path in lower case (the Chamberlain's pathKey, the Cellarer's folderKey). */
export const folderKey = (p: string) => path.resolve(p).toLowerCase();

export class FolderWatch {
  private readonly watchers = new Map<string, { folder: string; wants: WatchedFolder['wants']; watcher: Pick<FSWatcher, 'close' | 'on'>; changes: Changes }>();
  private stopped = false;
  private readonly watchFn: WatchFn;
  private readonly keyOf: (folder: string) => string;
  private readonly o: FolderWatchOptions;

  constructor(o: FolderWatchOptions) {
    this.o = o;
    this.watchFn = o.watch ?? ((folder, opts, listener) => fsWatch(folder, opts, listener));
    this.keyOf = o.key ?? folderKey;
  }

  /** The folders watched now. */
  get watching(): string[] {
    return [...this.watchers.values()].map((w) => w.folder);
  }

  /** Watches the folders as they are now: new ones (a folder added in Settings, a drive plugged in) opened, gone ones closed. */
  refresh(): void {
    if (this.stopped) return;
    let want: WatchedFolder[] = [];
    try {
      want = this.o.folders();
    } catch {
      // The folders can't be worked out now: the watchers stay as they are, and what they miss is walked.
      return;
    }
    const keys = new Map(want.map((w) => [this.keyOf(w.folder), w]));
    for (const [k, w] of this.watchers) {
      if (!keys.has(k)) this.close(k);
      else w.wants = keys.get(k)!.wants;
    }
    for (const [k, w] of keys) if (!this.watchers.has(k)) this.open(k, w);
  }

  /**
   * What changed in each folder watched since the last take() (by its key), and starts again: 'all' for a folder
   * watched only since then. A folder not watched now isn't in it: its changes aren't known.
   */
  take(): Map<string, Changes> {
    const out = new Map<string, Changes>();
    for (const [k, w] of this.watchers) {
      out.set(k, w.changes);
      w.changes = new Map();
    }
    return out;
  }

  stop(): void {
    this.stopped = true;
    for (const k of [...this.watchers.keys()]) this.close(k);
  }

  /** A change in a folder to `name` (relative to it; null when the system didn't say). */
  private changed(key: string, event: string, name: string | null): void {
    const w = this.watchers.get(key);
    if (!w || this.stopped || w.changes === 'all') return;
    if (name === null) {
      w.changes = 'all';
      return;
    }
    const named = event !== 'change';
    if (!w.wants(name, named)) return;
    w.changes.set(name, named || w.changes.get(name) === true);
    if (w.changes.size > MAX_CHANGES) w.changes = 'all';
  }

  private open(key: string, w: WatchedFolder): void {
    try {
      const watcher = this.watchFn(w.folder, { recursive: true, persistent: false }, (event, name) => {
        try {
          this.changed(key, event, name === null || name === undefined ? null : String(name));
        } catch {
          // Never thrown from a watcher.
        }
      });
      // A watcher that fails (its folder deleted, a drive unplugged) is closed; the next refresh() opens it again if it's back.
      watcher.on('error', () => this.close(key));
      // Watched only from now: what changed before isn't known, so the next round walks it.
      this.watchers.set(key, { folder: w.folder, wants: w.wants, watcher, changes: 'all' });
    } catch {
      // Can't be watched now (gone, no access): each round walks it, and the next refresh() tries again.
    }
  }

  private close(key: string): void {
    const w = this.watchers.get(key);
    if (!w) return;
    this.watchers.delete(key);
    try {
      w.watcher.close();
    } catch {
      // Already closed.
    }
  }
}
