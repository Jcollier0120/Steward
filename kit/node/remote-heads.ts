import path from 'node:path';
import { manorHome } from './manor.ts';
import { readJson, writeJson } from './store.ts';

/**
 * Branch heads a remote has, as an agent that just read them shares them (kit 2.58.0): remote-heads.json in Manor's
 * folder (%USERPROFILE%\.manor, or MANOR_HOME).
 *
 * The Steward reads every branch head of its employees' repositories from GitHub in its glance each round (one query
 * for them all). Another agent that only wants to know whether a remote changed (Reeve, before it fetches) reads them
 * here instead of asking the remote itself: a `git ls-remote` over https starts git, a shell and the credential helper,
 * some 9 processes, for each repository. Heads older than FRESH_MS, a remote that isn't here, a list that isn't the
 * whole of the remote's branches, or no file at all: the agent asks the remote as before. Nothing requires GitHub or the
 * Steward; without them the file is never written.
 */

/** One remote's branch heads (branch name → commit), when they were read, and whether they are all of its branches. */
export interface RemoteHeads {
  at: string;
  heads: Record<string, string>;
  complete: boolean;
}

export type RemoteHeadsFile = Record<string, RemoteHeads>;

/** How long shared heads are taken as the remote's own. */
export const FRESH_MS = 20 * 60_000;
/** A remote not read for this long is left out when the file is written again. */
const KEEP_MS = 24 * 60 * 60_000;

export const remoteHeadsFile = (home = manorHome()) => path.join(home, 'remote-heads.json');

/**
 * A remote's URL as one key for every way of writing it: `host/owner/name`, lower case, without .git, a user, a port or the
 * scheme. `https://github.com/Owner/Repo.git`, `git@github.com:owner/repo` and `ssh://git@github.com/owner/repo`
 * are all `github.com/owner/repo`; `owner/repo` alone (a glance's name for it) is GitHub's. Null for a path or anything else that isn't a remote.
 */
export function remoteKey(url: string): string | null {
  let s = url.trim();
  if (/^[a-z0-9][\w-]*\/[\w.-]+$/i.test(s)) s = `github.com/${s}`;
  else {
    const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(s);
    const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::\d+)?\/(.+)$/i.exec(s);
    const m = /^[a-z]:[\\/]/i.test(s) ? null : (full ?? scp);
    if (!m) return null;
    s = `${m[1]}/${m[2]}`;
  }
  const key = s.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return /^[^/]+\/[^/]+\/.+$/.test(key) ? key : null;
}

/** The whole file: empty when it's missing or unreadable. */
export function readRemoteHeads(file = remoteHeadsFile()): RemoteHeadsFile {
  const all = readJson<unknown>(file, {});
  return all && typeof all === 'object' && !Array.isArray(all) ? (all as RemoteHeadsFile) : {};
}

/**
 * A remote's branch heads as shared, when they are fresh (read within `maxAgeMs`) and all of its branches; null
 * otherwise, and then the agent asks the remote itself.
 */
export function freshRemoteHeads(url: string, o: { file?: string; now?: number; maxAgeMs?: number } = {}): Record<string, string> | null {
  const key = remoteKey(url);
  if (!key) return null;
  const e = readRemoteHeads(o.file)[key];
  const at = Date.parse(e?.at ?? '');
  const age = (o.now ?? Date.now()) - at;
  if (!e || e.complete !== true || !e.heads || typeof e.heads !== 'object' || !(age >= -60_000 && age <= (o.maxAgeMs ?? FRESH_MS))) return null;
  const heads: Record<string, string> = {};
  for (const [branch, sha] of Object.entries(e.heads)) if (typeof sha === 'string' && /^[0-9a-f]{40,64}$/i.test(sha)) heads[branch] = sha.toLowerCase();
  return heads;
}

/**
 * Shares remotes' branch heads just read (by URL, or `owner/name` for GitHub): written over what was there for those
 * remotes, the others kept until they're a day old, through a temporary file and a rename.
 */
export function shareRemoteHeads(read: Record<string, { heads: Record<string, string>; complete: boolean }>, o: { file?: string; now?: Date } = {}): void {
  const file = o.file ?? remoteHeadsFile();
  const now = o.now ?? new Date();
  const all: RemoteHeadsFile = {};
  for (const [key, e] of Object.entries(readRemoteHeads(file))) if (now.getTime() - Date.parse(e?.at ?? '') < KEEP_MS) all[key] = e;
  for (const [url, e] of Object.entries(read)) {
    const key = remoteKey(url);
    if (key) all[key] = { at: now.toISOString(), heads: e.heads, complete: e.complete };
  }
  writeJson(file, all);
}
