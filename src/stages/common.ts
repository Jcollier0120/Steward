import path from 'node:path';
import { expandEnv } from '../kit/settings-kit.ts';
import type { KitInfo } from '../kitsource.ts';
import type { Runner } from '../run.ts';
import type { Employee, Settings } from '../settings.ts';

/** What a stage did for one employee. */
export type Outcome = 'done' | 'skipped' | 'refused' | 'failed';

export interface EmployeeResult {
  id: string;
  name: string;
  outcome: Outcome;
  /** One line, for the page's table. */
  message: string;
  /** A PR's URL, a commit, a new version: what the page can link or show. */
  url?: string;
  version?: string;
  commit?: string;
}

export type StageName = 'bump' | 'push' | 'merge' | 'release' | 'round' | 'staff';

export interface StageResult {
  stage: StageName;
  started: string;
  finished: string;
  /** The kit version it worked with, when it had one. */
  kit: string | null;
  /** What it was asked: which employees, which kit, --yes. */
  asked: Record<string, unknown>;
  /** A word for the whole stage, when it couldn't start (no kit, say). */
  error?: string;
  results: EmployeeResult[];
  log: string[];
}

export interface Ctx {
  settings: Settings;
  run: Runner;
  kit: KitInfo;
  /** A line for the stage's log (and the terminal). */
  log: (line: string) => void;
  /** Where gh runs from: no employee's repo, so --repo alone decides. */
  neutralDir: string;
}

/** The employees a stage is asked about: all, or those named (by id, ignoring case). Unknown names are an error. */
export function pick(all: Employee[], only?: string[] | null): { employees: Employee[] } | { error: string } {
  if (!only?.length) return { employees: all };
  const want = only.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = want.filter((w) => !all.some((e) => e.id === w));
  if (unknown.length) return { error: `no employee called ${unknown.join(', ')} (they are ${all.map((e) => e.id).join(', ')})` };
  return { employees: all.filter((e) => want.includes(e.id)) };
}

export const checkoutOf = (e: Employee) => path.resolve(expandEnv(e.checkout));
export const workRootOf = (s: Settings) => path.resolve(expandEnv(s.workRoot));
/** The Steward's worktree for an employee's bump, and the one for its release. */
export const bumpDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), e.id);
export const releaseDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-release`);
/** The branch a bump to a kit version is prepared on. */
export const bumpBranch = (kit: string) => `steward/kit-${kit}`;
export const NOT_ON_KIT = 'not using the kit yet';

/** Runs `fn` on each item, at most `limit` at once, keeping the order of the results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export const result = (e: Employee, outcome: Outcome, message: string, more: Partial<EmployeeResult> = {}): EmployeeResult => ({ id: e.id, name: e.name, outcome, message, ...more });
