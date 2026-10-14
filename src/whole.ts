import { APP } from './app.ts';
import { gitMaybe } from './git.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Runner } from './run.ts';
import type { Employee } from './settings.ts';

/**
 * The trees of the Steward's own code whose whole suite passed on this PC (whole-passes.json, by tree, the newest
 * WHOLE_KEPT), for the gate before a kit's release (stages/wholesuite.ts): code already run whole isn't run whole again.
 * Kept wherever the Steward's own checks pass with `npm test` run whole, at a clean commit (bump.ts's runChecks): a vouch
 * or a PR tested here whose change reached everything, a train, the gate itself. Not where only the tests a change
 * reaches ran (affected.ts), nor with a kit other than the tree's own (a trial's STEWARD_KIT). An agent's aren't kept: no
 * kit is released from them.
 */

export const wholePassesFile = () => dataFile('whole-passes.json');
export const WHOLE_KEPT = 200;

/** A tree whose whole suite passed here: when, and at which commit. */
export interface WholePass {
  at: string;
  commit: string;
}

/** The whole-suite pass kept for this tree, or null. */
export const wholePassOf = (tree: string | null): WholePass | null => (tree ? (readJson<Record<string, WholePass>>(wholePassesFile(), {})[tree] ?? null) : null);

/** The tree of a commit in `dir` (HEAD by default), or null. */
export async function treeOf(run: Runner, dir: string, rev = 'HEAD'): Promise<string | null> {
  return (await gitMaybe(run, dir, 'rev-parse', `${rev}^{tree}`))?.trim() || null;
}

/** What runChecks ran of `npm test` (bump.ts's AffectedScope.chose): whole, unless only the tests a change reaches. */
export const ranWhole = (chose: string | undefined) => !chose || chose === 'the whole suite';

/**
 * After the Steward's own checks passed in `dir`: its HEAD's tree kept as passed whole, when `npm test` ran whole
 * (`chose`), with the tree's own kit (no `env.STEWARD_KIT`), and nothing uncommitted there. Never throws.
 */
export async function keepWhole(run: Runner, e: Employee, o: { dir: string; chose?: string; env?: Record<string, string> }, now = new Date()): Promise<void> {
  if (e.id !== APP.id || !ranWhole(o.chose) || o.env?.STEWARD_KIT) return;
  // Never the live data folder under node --test: a test that wants it sets STEWARD_HOME.
  if (process.env.NODE_TEST_CONTEXT && !process.env.STEWARD_HOME) return;
  try {
    if ((await gitMaybe(run, o.dir, 'status', '--porcelain', '--untracked-files=no'))?.trim() !== '') return;
    const [commit, tree] = ((await gitMaybe(run, o.dir, 'rev-parse', 'HEAD', 'HEAD^{tree}')) ?? '').trim().split(/\s+/);
    const sha = /^[0-9a-f]{40,64}$/;
    if (!sha.test(commit ?? '') || !sha.test(tree ?? '')) return;
    const kept = readJson<Record<string, WholePass>>(wholePassesFile(), {});
    delete kept[tree];
    kept[tree] = { at: now.toISOString(), commit };
    writeJson(wholePassesFile(), Object.fromEntries(Object.entries(kept).slice(-WHOLE_KEPT)));
  } catch {
    // a pass not kept is run again, no more
  }
}
