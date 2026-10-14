import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitMaybe } from '../git.ts';
import { readJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import type { Runner } from '../run.ts';
import { affectedPick, type AffectedScope, type TestPick } from './bump.ts';

/**
 * The Assayer's word for a clone's HEAD: a session checks its work with the Assayer (its MCP tool `check`: every case,
 * every test, in the working tree), commits exactly that, and vouches. Running the same checks again on the same code
 * only doubles the load on the PC, so `steward vouch` takes the Assayer's passing check instead, when it is of exactly
 * HEAD's tree and nothing git doesn't carry has changed since.
 *
 * The Assayer (0.3.31 on) keeps each repository's last checks in its mcp-checks.json, by the repository's top folder
 * (as git names it, lower case): each with when, its outcome, whether it was the whole of the checks (`full`), the
 * commands its cases ran, the git tree of the code checked (uncommitted and untracked files included), and the size and
 * time of what git doesn't carry (installed dependencies, the Steward's kit) as `marks`.
 *
 * An `affected` check (0.3.35 on: every case, its unit tests only those the change reaches) keeps the same, and by
 * command what each case ran (`ran`): "all", or the test files. It stands in for a vouch that would itself run only the
 * tests the change reaches (bump.ts affectedPick, against origin/<branch>), when its test files take in every one of those.
 */

/** One check as the Assayer keeps it: only what is read here. */
export interface AssayerCheck {
  at: string;
  outcome: 'passed' | 'failed';
  unsure?: boolean;
  full?: boolean;
  affected?: boolean;
  cases?: string[];
  commands?: string[];
  ran?: Record<string, string[] | 'all'>;
  tree?: string;
  marks?: Record<string, string>;
}

/** The Assayer's pass a vouch takes: the check, and for an affected one what it ran of `npm test`, in words. */
export interface Assayed {
  check: AssayerCheck;
  chose?: string;
}

/** How old a pass may be and still stand in for running the checks: the Assayer's own (SAME_CODE_MS), a day. */
export const ASSAYED_MS = 24 * 3600_000;

/** The Assayer's record of checks: ASSAYER_HOME's mcp-checks.json, else %USERPROFILE%\.assayer's. */
export const assayerChecksFile = (env: NodeJS.ProcessEnv = process.env) => path.join(env.ASSAYER_HOME || path.join(os.homedir(), '.assayer'), 'mcp-checks.json');

/** A typecheck, however it is written: the Assayer's typecheck case runs the repository's own (npm run typecheck). */
const isTypecheck = (command: string) => /^(?:npx\s+)?tsc(?:\s|$)/.test(command) || /^npm run typecheck(?:\s|$)/.test(command);

/** Whether the Assayer's check ran each of the employee's checks: the same command, or a typecheck for a typecheck. Pure. */
export function covers(test: string[], c: Pick<AssayerCheck, 'cases' | 'commands'>): boolean {
  const ran = (c.commands ?? []).map((s) => s.trim());
  return test.every((t) => ran.includes(t.trim()) || (isTypecheck(t.trim()) && (c.cases ?? []).includes('typecheck')));
}

const testPath = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Why an affected check's runs don't take in what the vouch would run, or null when they do. `pick`: the vouch's own of
 * `npm test` (affectedPick). Each of the employee's checks must have run as it is ("all", or a typecheck, which is never
 * narrowed), but for `npm test`, whose test files must take in the pick's. Pure.
 */
export function whyShort(test: string[], c: Pick<AssayerCheck, 'cases' | 'ran'>, pick: TestPick): string | null {
  for (const raw of test) {
    const t = raw.trim();
    const r = c.ran?.[t];
    if (r === 'all') continue;
    if (r === undefined) {
      if (isTypecheck(t) && (c.cases ?? []).includes('typecheck')) continue;
      return `it doesn't say which tests ${t} ran`;
    }
    if (t !== 'npm test' || 'whole' in pick) return `it ran only some of ${t}'s tests, and this vouch runs them all`;
    const ran = new Set(r.map(testPath));
    const missing = pick.files.filter((f) => !ran.has(testPath(f)));
    if (missing.length) return `it left out ${missing.length} of the ${pick.files.length} test files this change reaches (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`;
  }
  return null;
}

/** Whether what git doesn't carry is as the check found it: each mark's size and time now, the same. */
export function marksHold(top: string, marks: Record<string, string>): boolean {
  return Object.entries(marks).every(([m, was]) => {
    let now = '-';
    try {
      const st = statSync(path.join(top, m));
      now = `${st.size}:${st.mtimeMs}`;
    } catch {
      // not there
    }
    return now === was;
  });
}

/**
 * Why a check doesn't stand in for this one, or null when it does. An affected check stands in only beside `pick`, what
 * the vouch itself would run of `npm test` (affectedPick). Pure but for reading the marks' files.
 */
export function whyNot(c: AssayerCheck, o: { tree: string; top: string; test: string[]; now: number; pick?: TestPick }): string | null {
  if (c.outcome !== 'passed' || c.unsure) return 'it failed';
  if (!c.full && !(c.affected && o.pick)) return 'it ran only some of the checks';
  if (c.tree !== o.tree) return 'it checked other code';
  const age = o.now - Date.parse(c.at);
  if (!(age >= 0 && age < ASSAYED_MS)) return 'it is more than a day old';
  if (!covers(o.test, c)) return "it didn't run all of these checks";
  if (!c.marks || !marksHold(o.top, c.marks)) return 'dependencies or the kit changed since';
  return c.full || !o.pick ? null : whyShort(o.test, c, o.pick);
}

/** What an affected pass ran of `npm test`, for the vouch's status: "affected: 12 of 126 test files, the Assayer's". Pure. */
export function choseOf(c: Pick<AssayerCheck, 'ran'>, pick: TestPick): string | undefined {
  const r = c.ran?.['npm test'];
  if (!r) return undefined;
  if (r === 'all') return "the whole suite, the Assayer's";
  if (!r.length) return "no test reaches the change, the Assayer's";
  return `affected: ${r.length}${'tests' in pick ? ` of ${pick.tests.length}` : ''} test files, the Assayer's`;
}

/**
 * The Assayer's latest passing check of exactly the clone's HEAD tree that stands in for the vouch (whole, or affected
 * and taking in what `scope` picks; under a day old, of the employee's checks, with the same dependencies and kit), or
 * null: then the checks run as before. No `scope`: the vouch runs the whole suite, which only a check that ran each case
 * as it is stands in for. Never throws.
 */
export async function assayedHead(run: Runner, dir: string, e: Pick<Employee, 'test'>, o: { now?: number; file?: string; scope?: AffectedScope } = {}): Promise<Assayed | null> {
  try {
    const top = (await gitMaybe(run, dir, 'rev-parse', '--show-toplevel'))?.trim();
    const tree = (await gitMaybe(run, dir, 'rev-parse', 'HEAD^{tree}'))?.trim();
    if (!top || !tree) return null;
    const key = path.resolve(top).replace(/[\\/]+$/, '').toLowerCase();
    const checks = readJson<Record<string, AssayerCheck[]>>(o.file ?? assayerChecksFile(), {})[key];
    if (!Array.isArray(checks)) return null;
    const now = o.now ?? Date.now();
    // What the vouch itself would run of npm test: worked out once, and only for an affected check of this tree.
    let pick: TestPick | undefined;
    // Newest first: the latest check of this tree says how it stands, a failure after a pass included.
    for (const c of checks.filter((x) => x?.tree === tree && (x.full || x.affected))) {
      if (c.outcome !== 'passed' || c.unsure) return null;
      if (c.full) {
        if (!whyNot(c, { tree, top: path.resolve(top), test: e.test, now })) return { check: c };
        continue;
      }
      pick ??= o.scope ? await affectedPick(run, path.resolve(top), o.scope) : { whole: 'Settings say the whole suite' };
      if (!whyNot(c, { tree, top: path.resolve(top), test: e.test, now, pick })) return { check: c, chose: choseOf(c, pick) };
    }
    return null;
  } catch {
    return null;
  }
}
