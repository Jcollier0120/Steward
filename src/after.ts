/**
 * What a PR asks the Steward to do once it is merged, in a fenced block in its description:
 *
 *   ```steward
 *   {"after": ["release", "install", "approve-jobs"], "jobs": ["aletaster-orders"]}
 *   ```
 *
 * The steps are words the Steward knows, never commands: whoever can edit a PR's description chooses among
 * them, not what runs. Each employee's commands are its own, in Settings.
 *
 * - release: the version on its branch, released from the branch, as the release stage does (whatever kit it
 *   pins). Merge holds a PR that asks for one when its version after merging is already released.
 * - install: its newest release on this PC: the zip downloaded, checked against SHA256SUMS.txt, unpacked, and
 *   its install command (Settings) run in it. After a release it asked for, only when that release was made.
 * - approve-jobs, with jobs: each job approved in the installed copy, with the employee's approve command
 *   (Settings), after the PR's install. Merging the PR counts as reading its scripts (your decision): an
 *   approval pins the script's sha256, so it is the merged script that runs unattended. It needs install,
 *   since the scripts approved are the installed copy's.
 *
 * A block the Steward can't read, or a step it doesn't know, holds the PR: merged without it, what the PR
 * asked for would silently not happen.
 */

export const AFTER_STEPS = ['release', 'install', 'approve-jobs'] as const;
export type AfterStep = (typeof AFTER_STEPS)[number];

export interface After {
  /** In the Steward's order: release, install, approve-jobs. */
  steps: AfterStep[];
  jobs: string[];
}

const BLOCK = /^[ \t]*```steward[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const quoted = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');

/** A PR description's steward block: none (null), what it asks for, or why it can't be read. */
export function readAfter(body: unknown): { after: After | null } | { error: string } {
  const blocks = [...String(body ?? '').matchAll(BLOCK)];
  if (!blocks.length) return { after: null };
  if (blocks.length > 1) return { error: 'it has more than one steward block' };
  let j: any;
  try {
    j = JSON.parse(blocks[0][1]);
  } catch {
    return { error: "its steward block isn't JSON" };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: "its steward block isn't a JSON object" };
  const unknownKeys = Object.keys(j).filter((k) => k !== 'after' && k !== 'jobs');
  if (unknownKeys.length) return { error: `its steward block has ${quoted(unknownKeys)}, which the Steward doesn't read (it reads "after" and "jobs")` };
  if (!Array.isArray(j.after) || !j.after.length || !j.after.every((s: unknown) => typeof s === 'string')) return { error: 'its steward block\'s "after" isn\'t a list of steps' };
  const unknown = (j.after as string[]).filter((s) => !(AFTER_STEPS as readonly string[]).includes(s));
  if (unknown.length) return { error: `its steward block asks for ${quoted(unknown)}, which the Steward doesn't do (it does ${AFTER_STEPS.join(', ')})` };
  const jobs = j.jobs ?? [];
  if (!Array.isArray(jobs) || !jobs.every((x: unknown) => typeof x === 'string' && JOB.test(x))) return { error: 'its steward block\'s "jobs" isn\'t a list of job names' };
  const steps = AFTER_STEPS.filter((s) => j.after.includes(s));
  if (steps.includes('approve-jobs') && !jobs.length) return { error: 'its steward block asks for approve-jobs, but names no jobs' };
  if (jobs.length && !steps.includes('approve-jobs')) return { error: "its steward block names jobs, but doesn't ask for approve-jobs" };
  if (steps.includes('approve-jobs') && !steps.includes('install')) return { error: "its steward block asks for approve-jobs without install: the scripts approved are the installed copy's" };
  return { after: { steps, jobs: [...new Set(jobs as string[])] } };
}

/** "release, install, approve-jobs (aletaster-orders)". */
export const afterWords = (a: After) => a.steps.map((s) => (s === 'approve-jobs' ? `approve-jobs (${a.jobs.join(', ')})` : s)).join(', ');
