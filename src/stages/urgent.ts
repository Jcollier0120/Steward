import { CHANGES_DIR } from '../entries.ts';
import { commitOf, fetchBranch, git, gitMaybe } from '../git.ts';
import { isUrgent } from '../kit/exchequer.ts';
import { CHANGELOG } from '../kit/notes.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { urgentKey, type UrgentPr } from '../pipeline.ts';
import type { Employee } from '../settings.ts';
import { checkoutOf, glanceOf, mapLimit, type Ctx } from './common.ts';
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

/**
 * What each head said, kept between the Steward's restarts (Manor updates it often), which read every repository again,
 * fetching each (Steward 0.36.142): "<repo>@<head>..<tag>" → urgent. Not under node --test unless the test gives a data
 * folder of its own.
 */
export const urgentLookedFile = () => dataFile('urgent-looked.json');
const keepsLooked = () => !process.env.NODE_TEST_CONTEXT || !!process.env.STEWARD_HOME;
/** Each head read once: "<repo>@<head>..<tag>" → urgent; read from urgentLookedFile at first. */
let looked: Map<string, boolean> | null = null;
/** How many it keeps before it forgets them all and reads again. */
const LOOKED_MAX = 1000;

/**
 * Whether main at `head` adds an urgent entry since the release `tag` (its commit `tagged`, when the glance says): the
 * lines it adds to CHANGELOG.md or changes/. Only what the clone lacks is fetched: main's head, the release's commit.
 */
async function readUrgent(ctx: Ctx, e: Employee, head: string, tag: string, tagged: string | null): Promise<boolean> {
  const repo = checkoutOf(e);
  if (!(await commitOf(ctx.run, repo, head))) await fetchBranch(ctx.run, repo, e.branch);
  const ref = `refs/tags/${tag}`;
  let from = tagged && (await commitOf(ctx.run, repo, tagged)) ? tagged : (await commitOf(ctx.run, repo, ref)) ? ref : null;
  if (!from) {
    if ((await gitMaybe(ctx.run, repo, 'fetch', '--quiet', 'origin', `+${ref}:${ref}`)) === null) return false;
    from = ref;
  }
  const diff = await git(ctx.run, repo, 'diff', '--no-color', '--no-ext-diff', '--unified=0', `${from}..${head}`, '--', CHANGELOG, `${CHANGES_DIR}/`);
  return marksUrgent(diff);
}

export async function urgentReady(ctx: Ctx, employees: Employee[], boarded: Set<string>, heads: Record<string, { head: string | null; tags: string[] }> = {}): Promise<UrgentPr[]> {
  looked ??= new Map(keepsLooked() ? Object.entries(readJson<Record<string, boolean>>(urgentLookedFile(), {})) : []);
  const seen = looked;
  let learnt = false;
  // A few at once: after a restart with nothing kept, each repository may have its head to fetch.
  const found = await mapLimit(employees, 4, async (e): Promise<UrgentPr | null> => {
    // The Steward's own from `heads`; an employee's from the glance, with the commit its newest release tags.
    const glance = heads[e.id] ? null : glanceOf(ctx, e);
    const g = heads[e.id] ?? (glance ? { head: glance.head, tags: appReleasesIn(JSON.stringify(glance.releases)).map((r) => r.tag) } : null);
    const tagged = glance?.releases.find((r) => r.tagName === g?.tags[0])?.commit ?? null;
    if (!g?.head) return null;
    const u: UrgentPr = { id: e.id, head: g.head };
    if (boarded.has(urgentKey(u))) return null;
    // Never released: its first release isn't an urgent fix's.
    const tag = g.tags[0];
    if (!tag) return null;
    // Main is its newest release: nothing on it since.
    if (tagged === g.head) return null;
    const memo = `${e.repo}@${g.head}..${tag}`;
    let urgent = seen.get(memo);
    if (urgent === undefined) {
      try {
        urgent = await readUrgent(ctx, e, g.head, tag, tagged);
      } catch (err) {
        ctx.log(`[${e.id}] couldn't read ${e.branch}'s changelog for an urgent fix: ${(err as Error).message}`);
        return null;
      }
      if (seen.size >= LOOKED_MAX) seen.clear();
      seen.set(memo, urgent);
      learnt = true;
    }
    return urgent ? u : null;
  });
  if (learnt && keepsLooked()) {
    try {
      writeJson(urgentLookedFile(), Object.fromEntries(seen));
    } catch {
      // Kept in memory still: read again after the next restart.
    }
  }
  return found.filter((u): u is UrgentPr => u !== null);
}
