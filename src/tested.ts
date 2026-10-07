import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Settings } from './settings.ts';

/**
 * The commits whose tests the Steward ran and passed, for the Surveyor, which runs every agent's tests again once a day
 * and wants to know what passed here, and when (GET /api/tested). Kept in tested.json, the newest first, the last
 * KEEP_TESTED of each employee's. The stages that run an employee's checks record what passed:
 * - bump: the commit on steward/kit-<version> its checks passed at, before it is pushed (stages/bump.ts);
 * - catch-up: a kit PR of the Steward's, at its new head once its checks passed there (stages/catchup.ts);
 * - merge: a team PR's head, tested here before it is merged (stages/prtest.ts);
 * - release: the commit of the branch a release was built from and published (stages/release.ts), whose release
 *   command ran there; the Steward runs no tests of its own for a release, so this is the commit its checks passed at
 *   on the way in, as merged.
 */

export type TestedStage = 'bump' | 'catch-up' | 'merge' | 'release';

export interface TestedCommit {
  /** The whole commit. */
  commit: string;
  stage: TestedStage;
  at: string;
  /** The branch it was on: steward/kit-<version>, a PR's head, or the employee's own. */
  branch?: string;
  pr?: number;
  version?: string;
}

export const KEEP_TESTED = 20;
export const testedFile = () => dataFile('tested.json');
export const loadTested = (): Record<string, TestedCommit[]> => readJson<Record<string, TestedCommit[]>>(testedFile(), {});

/** Records a commit that passed, for an employee: the newest first, the same commit and stage once, the last KEEP_TESTED kept. */
export function recordTested(id: string, t: Omit<TestedCommit, 'at'> & { at?: string }, now = new Date()): void {
  if (!t.commit) return;
  // Never the live data folder under node --test: a test that wants it sets STEWARD_HOME.
  if (process.env.NODE_TEST_CONTEXT && !process.env.STEWARD_HOME) return;
  const all = loadTested();
  const entry: TestedCommit = { ...t, at: t.at ?? now.toISOString() };
  all[id] = [entry, ...(all[id] ?? []).filter((x) => !(x.commit === t.commit && x.stage === t.stage))].slice(0, KEEP_TESTED);
  writeJson(testedFile(), all);
}

/** GET /api/tested: each employee's tested commits, with its repository. One no longer in Settings is still listed. */
export function testedView(settings: Pick<Settings, 'employees' | 'stewardRepo'>, now = new Date()) {
  const all = loadTested();
  const repoOf = (id: string) => settings.employees.find((e) => e.id === id)?.repo ?? (id === 'steward' ? settings.stewardRepo || null : null);
  return {
    at: now.toISOString(),
    keep: KEEP_TESTED,
    employees: Object.fromEntries(Object.entries(all).map(([id, tested]) => [id, { repo: repoOf(id), tested }])),
  };
}
