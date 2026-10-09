import { dataFile, readJson, writeJson } from './kit/store.ts';

/**
 * Each PR that conflicts with its branch that the Steward looked at, and what it did (stages/merge.ts catchUpAll): it
 * caught it up (its version lines, changelog or kit pin resolved, a merge commit pushed), sent it back to its author
 * (stages/kickback.ts), closed it (one of the Wright's, queued again, or a kit PR of its own), or couldn't. For the
 * page: what it does with conflicts, as well as what the round's lines say.
 *
 * A PR's look is kept as one record, the last: a round that finds it as it was (same outcome, same words, same head)
 * moves only `lookedAt`, so `at` says when it last did something new. Looks older than two weeks go.
 */

export type ConflictOutcome = 'caught-up' | 'sent-back' | 'closed' | 'couldnt';

export interface ConflictLook {
  /** The employee's id and name, and its GitHub repository. */
  id: string;
  name: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  /** Its branch, its author, and its head commit when looked at. */
  head: string;
  author: string;
  headOid: string;
  outcome: ConflictOutcome;
  /** What the Steward did, or why it couldn't, in the round's words. */
  note: string;
  /** The files it conflicted in, and of those the ones that needed judgement (it resolves none of those). */
  files: string[];
  needs: string[];
  /** When it was first looked at, when the outcome last changed, and when it was last looked at. */
  firstAt: string;
  at: string;
  lookedAt: string;
}

export const conflictsFile = () => dataFile('conflicts.json');

const KEEP_MS = 14 * 24 * 3600_000;
const keyOf = (l: { repo: string; number: number }) => `${l.repo}#${l.number}`;
const fresh = (l: ConflictLook, now: number) => now - Date.parse(l.lookedAt) < KEEP_MS;

/** Notes what a round did with a conflicting PR. */
export function noteConflict(look: Omit<ConflictLook, 'firstAt' | 'at' | 'lookedAt'>, now = new Date()): ConflictLook {
  const kept = readJson<Record<string, ConflictLook>>(conflictsFile(), {});
  const t = now.toISOString();
  const was = kept[keyOf(look)];
  const same = was && was.outcome === look.outcome && was.note === look.note && was.headOid === look.headOid;
  const next: ConflictLook = { ...look, firstAt: was?.firstAt ?? t, at: same ? was.at : t, lookedAt: t };
  delete kept[keyOf(look)];
  kept[keyOf(look)] = next;
  const ms = now.getTime();
  writeJson(conflictsFile(), Object.fromEntries(Object.entries(kept).filter(([, l]) => fresh(l, ms)).slice(-300)));
  return next;
}

/** The looks of the last two weeks, the newest outcome first. */
export function loadConflicts(now = Date.now()): ConflictLook[] {
  return Object.values(readJson<Record<string, ConflictLook>>(conflictsFile(), {}))
    .filter((l) => fresh(l, now))
    .sort((a, b) => b.at.localeCompare(a.at));
}
