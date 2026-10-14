import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitMaybe } from '../git.ts';
import { readJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import type { Runner } from '../run.ts';

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
 */

/** One check as the Assayer keeps it: only what is read here. */
export interface AssayerCheck {
  at: string;
  outcome: 'passed' | 'failed';
  unsure?: boolean;
  full?: boolean;
  cases?: string[];
  commands?: string[];
  tree?: string;
  marks?: Record<string, string>;
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

/** Why a check doesn't stand in for this one, or null when it does. Pure but for reading the marks' files. */
export function whyNot(c: AssayerCheck, o: { tree: string; top: string; test: string[]; now: number }): string | null {
  if (c.outcome !== 'passed' || c.unsure) return 'it failed';
  if (!c.full) return 'it ran only some of the checks';
  if (c.tree !== o.tree) return 'it checked other code';
  const age = o.now - Date.parse(c.at);
  if (!(age >= 0 && age < ASSAYED_MS)) return 'it is more than a day old';
  if (!covers(o.test, c)) return "it didn't run all of these checks";
  if (!c.marks || !marksHold(o.top, c.marks)) return 'dependencies or the kit changed since';
  return null;
}

/**
 * The Assayer's latest passing check of exactly the clone's HEAD tree (whole, under a day old, of the employee's checks,
 * with the same dependencies and kit), or null: then the checks run as before. Never throws.
 */
export async function assayedHead(run: Runner, dir: string, e: Pick<Employee, 'test'>, o: { now?: number; file?: string } = {}): Promise<AssayerCheck | null> {
  try {
    const top = (await gitMaybe(run, dir, 'rev-parse', '--show-toplevel'))?.trim();
    const tree = (await gitMaybe(run, dir, 'rev-parse', 'HEAD^{tree}'))?.trim();
    if (!top || !tree) return null;
    const key = path.resolve(top).replace(/[\\/]+$/, '').toLowerCase();
    const checks = readJson<Record<string, AssayerCheck[]>>(o.file ?? assayerChecksFile(), {})[key];
    if (!Array.isArray(checks)) return null;
    const now = o.now ?? Date.now();
    // Newest first: the latest check of this tree says how it stands, a failure after a pass included.
    const latest = checks.find((c) => c?.tree === tree && c.full);
    return latest && !whyNot(latest, { tree, top: path.resolve(top), test: e.test, now }) ? latest : null;
  } catch {
    return null;
  }
}
