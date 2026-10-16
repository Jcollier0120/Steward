import { CHANGES_DIR } from '../entries.ts';
import { fetchFor, git } from '../git.ts';
import { hostFor } from '../hosts/index.ts';
import { isUrgent } from '../kit/exchequer.ts';
import { CHANGELOG } from '../kit/notes.ts';
import { urgentKey, type UrgentPr } from '../pipeline.ts';
import type { Employee } from '../settings.ts';
import { checkoutOf, freshBranch, glanceOf, type Ctx } from './common.ts';
import { parsePrs, type PrInfo } from './staff.ts';

/**
 * Urgent fixes between builds (pipeline.ts). The Steward builds only at its build times, so an urgent fix would wait up
 * to six hours: instead, a ready PR of the team's whose changelog entry is marked urgent, a line starting
 * "**Urgent fix:" (the Exchequer's mark, kit/node/exchequer.ts isUrgent and spec/RELEASE-NOTES.md), boards at once, as a
 * build of its own for its repository (pipelineMode's `urgent`). Its release then goes out to customers at once too
 * (release.ts urgentNote), as any urgent release does.
 *
 * The round between builds finds them from its glance at GitHub (each PR's files and head) and the PR's head in the
 * employee's checkout: the lines it adds to CHANGELOG.md or to a file in changes/, from where it left the branch. Only a
 * PR whose files touch those is read, each once per head (the rounds run in one process). A PR boards once at its head
 * (BuildRun.urgent): one its build couldn't merge, its checks failing, waits for a new push or the next build.
 */

/** Whether a file a PR changes may hold its changelog entry: CHANGELOG.md, or a changes/*.md (entries.ts). */
export const entryFile = (f: string) => f === CHANGELOG || (f.startsWith(`${CHANGES_DIR}/`) && f.endsWith('.md'));

/** The lines a diff adds (`git diff`'s "+" lines, without the "+++" of a file's name). Pure. */
export const addedLines = (diff: string): string[] =>
  diff
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));

/** Whether the lines a PR adds to its changelog mark it urgent. Pure. */
export const marksUrgent = (diff: string): boolean => addedLines(diff).some((l) => isUrgent(l));

/** The PRs a glance shows that may board as urgent: the team's, ready, to the branch, touching a changelog. Pure. */
export function candidates(e: Employee, prs: PrInfo[]): PrInfo[] {
  // A PR whose files GitHub didn't list is read all the same.
  return prs.filter((p) => p.whose === 'team' && !p.draft && p.base === e.branch && !!p.headOid && (!p.files.length || p.files.some(entryFile)));
}

/** Each PR read once at its head: "<repo>#<n>@<head>" → urgent. */
const looked = new Map<string, boolean>();
/** How many it keeps before it forgets them all and reads again. */
const LOOKED_MAX = 1000;

/** Whether the PR's changelog entry is marked urgent: the lines it adds to CHANGELOG.md or changes/ since the branch. */
async function readUrgent(ctx: Ctx, e: Employee, pr: PrInfo): Promise<boolean> {
  const repo = checkoutOf(e);
  await freshBranch(ctx, e, repo);
  // The PR's head, fetched by its number (a fork's too), read at the commit its host named.
  await fetchFor(ctx.run, repo, pr.headOid, hostFor(ctx, e).prRef(pr));
  const diff = await git(ctx.run, repo, 'diff', '--no-color', '--no-ext-diff', '--unified=0', `origin/${e.branch}...${pr.headOid}`, '--', CHANGELOG, `${CHANGES_DIR}/`);
  return marksUrgent(diff);
}

/**
 * The ready PRs of these employees whose changelog entry is marked urgent, from the round's glance, leaving out those
 * that boarded a build at their head already (`boarded`, pipeline.ts' boardedUrgent). One that couldn't be read is left
 * for the next round, said in the log. Never throws.
 */
export async function urgentReady(ctx: Ctx, employees: Employee[], boarded: Set<string>): Promise<UrgentPr[]> {
  const out: UrgentPr[] = [];
  for (const e of employees) {
    const g = glanceOf(ctx, e);
    if (!g) continue;
    for (const pr of candidates(e, parsePrs(JSON.stringify(g.prs), ctx.settings.team))) {
      const u: UrgentPr = { id: e.id, number: pr.number, head: pr.headOid };
      if (boarded.has(urgentKey(u))) continue;
      const memo = `${e.repo}#${pr.number}@${pr.headOid}`;
      let urgent = looked.get(memo);
      if (urgent === undefined) {
        try {
          urgent = await readUrgent(ctx, e, pr);
        } catch (err) {
          ctx.log(`[${e.id}] couldn't read #${pr.number}'s changelog entry for an urgent fix: ${(err as Error).message}`);
          continue;
        }
        if (looked.size >= LOOKED_MAX) looked.clear();
        looked.set(memo, urgent);
      }
      if (urgent) out.push(u);
    }
  }
  return out;
}
