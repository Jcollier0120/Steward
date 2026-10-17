import { CHANGES_DIR } from '../entries.ts';
import { fetchBranch, git, gitMaybe } from '../git.ts';
import { isUrgent } from '../kit/exchequer.ts';
import { CHANGELOG } from '../kit/notes.ts';
import { urgentKey, type UrgentPr } from '../pipeline.ts';
import type { Employee } from '../settings.ts';
import { checkoutOf, glanceOf, type Ctx } from './common.ts';
import { appReleasesIn } from './staff.ts';

/**
 * Urgent fixes between builds (pipeline.ts). The Steward builds only at its build times, so an urgent fix would wait up
 * to six hours: instead, a commit on main whose changelog entry is marked urgent, a line starting "**Urgent fix:" (the
 * Exchequer's mark, kit/node/exchequer.ts isUrgent and spec/RELEASE-NOTES.md), builds its repository at once, a build of
 * its own (pipelineMode's `urgent`). Its release then goes out to customers at once too (release.ts urgentNote), as any
 * urgent release does.
 *
 * The round between builds finds them from its glance at GitHub (each branch's head, and its releases): the lines main
 * added to CHANGELOG.md or to a file in changes/ since its newest release, read in the employee's checkout, each head
 * once (the rounds run in one process). A head builds once (BuildRun.urgent): one whose release failed waits for a new
 * commit or the next build.
 */

/** The lines a diff adds (`git diff`'s "+" lines, without the "+++" of a file's name). Pure. */
export const addedLines = (diff: string): string[] =>
  diff
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));

/** Whether the lines main adds to its changelog mark it urgent. Pure. */
export const marksUrgent = (diff: string): boolean => addedLines(diff).some((l) => isUrgent(l));

/** Each head read once: "<repo>@<head>" → urgent. */
const looked = new Map<string, boolean>();
/** How many it keeps before it forgets them all and reads again. */
const LOOKED_MAX = 1000;

/** Whether main at `head` adds an urgent entry since the release `tag`: the lines it adds to CHANGELOG.md or changes/. */
async function readUrgent(ctx: Ctx, e: Employee, head: string, tag: string): Promise<boolean> {
  const repo = checkoutOf(e);
  await fetchBranch(ctx.run, repo, e.branch);
  const ref = `refs/tags/${tag}`;
  if ((await gitMaybe(ctx.run, repo, 'fetch', '--quiet', 'origin', `+${ref}:${ref}`)) === null) return false;
  const diff = await git(ctx.run, repo, 'diff', '--no-color', '--no-ext-diff', '--unified=0', `${ref}..${head}`, '--', CHANGELOG, `${CHANGES_DIR}/`);
  return marksUrgent(diff);
}

/**
 * The employees whose main carries an urgent fix not yet released, from the round's glance (`heads` stands in for the
 * Steward's own, which the glance keeps apart), leaving out the heads that built already (`boarded`, pipeline.ts'
 * boardedUrgent). One that couldn't be read is left for the next round, said in the log. Never throws.
 */
export async function urgentReady(ctx: Ctx, employees: Employee[], boarded: Set<string>, heads: Record<string, { head: string | null; tags: string[] }> = {}): Promise<UrgentPr[]> {
  const out: UrgentPr[] = [];
  for (const e of employees) {
    const g = heads[e.id] ?? (() => {
      const glance = glanceOf(ctx, e);
      return glance ? { head: glance.head, tags: appReleasesIn(JSON.stringify(glance.releases)).map((r) => r.tag) } : null;
    })();
    if (!g?.head) continue;
    const u: UrgentPr = { id: e.id, head: g.head };
    if (boarded.has(urgentKey(u))) continue;
    // Never released: its first release isn't an urgent fix's.
    const tag = g.tags[0];
    if (!tag) continue;
    const memo = `${e.repo}@${g.head}`;
    let urgent = looked.get(memo);
    if (urgent === undefined) {
      try {
        urgent = await readUrgent(ctx, e, g.head, tag);
      } catch (err) {
        ctx.log(`[${e.id}] couldn't read ${e.branch}'s changelog for an urgent fix: ${(err as Error).message}`);
        continue;
      }
      if (looked.size >= LOOKED_MAX) looked.clear();
      looked.set(memo, urgent);
    }
    if (urgent) out.push(u);
  }
  return out;
}
