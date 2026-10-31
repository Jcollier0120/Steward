import path from 'node:path';
import { APP, appRoot } from '../app.ts';
import { compareVersions, entriesOf, readChangelog } from './notes.ts';
import { dataFile, readJson, writeJson } from './store.ts';

/**
 * What's new, at the top of the About view (react/shell.tsx, kit 2.143.0): the agent's own CHANGELOG.md entries for
 * the versions its latest updates brought, newest first, each under its version.
 *
 * Which versions: the agent keeps a record, versions.json in its data folder, of each version it first started at and
 * when, written as its page starts (server.ts's serve()) and only when the version changed:
 *
 *   { "versions": [{ "version": "0.4.28", "since": "2026-10-20T14:02:11.000Z" }, { "version": "0.4.31", "since": "2026-10-27T14:01:56.000Z" }] }
 *
 * oldest first, at most 30. About shows the entries of every version newer than the one that ran before the latest
 * update, up to the one running, and those of the other updates of the last 30 days; only the newest 5 of them (kit
 * 2.147.1), with how many older ones it leaves out, so the page carries no more than it shows. A copy with no record
 * yet (a fresh install, or the first start on this kit) starts one with its own version, after the one in app.prev
 * when the update kept one there (safeinstall.ts's probation), whose date isn't known: it shows the versions since
 * that, or just its own.
 *
 * The changelog is read once, the first time a page asks (a release carries its newest 20 entries: notes.ts's
 * releaseChangelog), and kept: it doesn't change while the agent runs. A missing or odd CHANGELOG.md or record means
 * no section, never an error.
 */

export const VERSIONS_FILE = 'versions.json';
/** The record keeps the newest 30 versions started at; the older go. */
export const MAX_KEPT = 30;
/** About shows at most 5 versions' entries, the newest (10 before kit 2.147.1). */
export const MAX_SHOWN = 5;
/** Besides the latest update, however old, About shows the updates of the last 30 days. */
export const RECENT_DAYS = 30;
const DAY_MS = 86_400_000;

/** A version the agent started at, and when it first did (ISO); null when it isn't known (app.prev's). */
export interface Started {
  version: string;
  since: string | null;
}

/** A version's entry as About shows it, and when the agent first started at it (null: it was passed through, or not known). */
export interface NewVersion {
  version: string;
  since: string | null;
  entry: string;
}

/** What About's What's new shows, as /api/whats-new gives it (kit 2.147.1). */
export interface WhatsNewAnswer {
  /** At most MAX_SHOWN versions' entries, newest first. */
  versions: NewVersion[];
  /** How many older versions with an entry the same updates brought, past those: 0 when none was left out. */
  older: number;
}

const isVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v);

/** The record in `file`, oldest first; empty when it is missing or isn't one. What isn't a version started at is passed over. */
export function readVersions(file = dataFile(VERSIONS_FILE)): Started[] {
  const r = readJson<unknown>(file, null);
  const list = r && typeof r === 'object' && Array.isArray((r as { versions?: unknown }).versions) ? (r as { versions: unknown[] }).versions : [];
  return list.flatMap((x) => {
    const s = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
    return isVersion(s.version) ? [{ version: s.version, since: typeof s.since === 'string' && Number.isFinite(Date.parse(s.since)) ? s.since : null }] : [];
  });
}

/**
 * The record with `version` started at `now`: itself when its newest is that version already. A record started from
 * nothing begins with `before`, the version that ran before it, when that is known and older.
 */
export function withVersion(record: Started[], version: string, now: Date, before: string | null = null): Started[] {
  if (record.at(-1)?.version === version) return record;
  const start = !record.length && before && compareVersions(before, version) < 0 ? [{ version: before, since: null }] : [];
  return [...start, ...record, { version, since: now.toISOString() }].slice(-MAX_KEPT);
}

/** The version kept in app.prev, beside the installed copy, when it is this agent's: the one that ran before an update. */
function previousCopy(): string | null {
  const r = readJson<Record<string, unknown> | null>(path.join(`${appRoot}.prev`, 'release.json'), null);
  return r && r.id === APP.id && isVersion(r.version) ? r.version : null;
}

let record: Started[] | null = null;

/**
 * Notes the version running, as the page starts: a read of versions.json, and a write only when the version changed
 * (or there was no record). It never throws: without a record, About shows just this version's entry.
 */
export function noteVersion(o: { file?: string; version?: string; now?: Date; before?: () => string | null } = {}): Started[] {
  const file = o.file ?? dataFile(VERSIONS_FILE);
  const version = o.version ?? APP.version;
  let noted: Started[];
  try {
    const had = readVersions(file);
    noted = withVersion(had, version, o.now ?? new Date(), had.length ? null : (o.before ?? previousCopy)());
    if (noted !== had) writeJson(file, { versions: noted });
  } catch {
    noted = [{ version, since: null }];
  }
  // The agent's own record, kept for whatsNew(): it changes only as the page starts.
  if (!o.file) record = noted;
  return noted;
}

/** The lowest version the updates shown came from (chooseVersions), or null when the record can't say. */
function lowestFrom(record: Started[], version: string, now: Date): string | null {
  const at = record.length - 1;
  if (at < 1 || record[at].version !== version) return null;
  const recent = now.getTime() - RECENT_DAYS * DAY_MS;
  let j = at;
  // record[j - 1] was updated to within the window: the update into it, from record[j - 2], is shown too.
  while (j >= 2 && record[j - 1].since && Date.parse(record[j - 1].since!) >= recent) j--;
  return record.slice(j - 1, at).map((s) => s.version).sort(compareVersions)[0];
}

/**
 * What About shows, from `entries` (the changelog's, entriesOf): the entries of the versions after the lowest version
 * the updates shown came from, up to `version`, newest first, the newest MAX_SHOWN of them, and how many older ones
 * that leaves out. The updates shown are the latest (into the record's newest, which must be `version`) and every
 * other of the last RECENT_DAYS days. With nothing to go by (no record, or one that doesn't end at `version`), or
 * nothing in between (a step back), `version`'s own.
 */
export function chooseWhatsNew(entries: { version: string; entry: string }[], record: Started[], version: string, now: Date): WhatsNewAnswer {
  const from = lowestFrom(record, version, now);
  const since = (v: string) => [...record].reverse().find((s) => s.version === v)?.since ?? null;
  const own = (x: { version: string }) => compareVersions(x.version, version) <= 0;
  const after = from ? entries.filter((x) => own(x) && compareVersions(x.version, from) > 0) : [];
  const brought = (after.length ? after : entries.filter((x) => x.version === version)).sort((a, b) => compareVersions(b.version, a.version));
  return {
    versions: brought.slice(0, MAX_SHOWN).map((x) => ({ version: x.version, since: since(x.version), entry: x.entry })),
    older: Math.max(0, brought.length - MAX_SHOWN),
  };
}

/** The versions whose entries About shows (chooseWhatsNew's), newest first: at most MAX_SHOWN. */
export function chooseVersions(entries: { version: string; entry: string }[], record: Started[], version: string, now: Date): NewVersion[] {
  return chooseWhatsNew(entries, record, version, now).versions;
}

let entries: { version: string; entry: string }[] | null = null;

/** The changelog's entries at the agent's root, read the first time they're asked for and kept; none without a changelog. */
function changelogEntries(): { version: string; entry: string }[] {
  if (!entries) {
    try {
      const text = readChangelog(appRoot);
      entries = text ? entriesOf(text) : [];
    } catch {
      entries = [];
    }
  }
  return entries;
}

/** What's new now, for /api/whats-new: no versions when there's nothing to show. */
export function whatsNewAnswer(now = new Date()): WhatsNewAnswer {
  const list = changelogEntries();
  if (!list.length) return { versions: [], older: 0 };
  record ??= readVersions();
  return chooseWhatsNew(list, record, APP.version, now);
}

/** The versions What's new shows now, for the page's frame (react-page.ts): empty when there's nothing to show. */
export function whatsNew(now = new Date()): NewVersion[] {
  return whatsNewAnswer(now).versions;
}
