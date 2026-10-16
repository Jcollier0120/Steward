import { passFor, type PassElsewhere } from '../kit/work-status.ts';
import type { Employee } from '../settings.ts';
import { assayedHead, type Assayed } from './assayed.ts';
import type { AffectedScope } from './bump.ts';
import type { Ctx } from './common.ts';

/**
 * Checks not run again on code that already passed them (Steward 0.36.51): before runChecks (bump.ts) runs an
 * employee's checks in a checkout with nothing uncommitted, a pass of exactly its code stands in. One lookup, for every
 * stage that runs checks (a PR's test, a vouch, a train, a build, a catch-up, the whole suite before a kit's release),
 * from
 *
 * 1. **the Assayer**, its check of that very folder (assayed.ts): a session checked its work with the Assayer, committed
 *    exactly that, and vouches;
 * 2. **this PC**, its own result for that tree (the kit's work-status.ts, work-results.json): the same code passed the
 *    same checks here;
 * 3. **another PC on the licence**, through Manor's link (the kit's manor.ts passOnOtherPcs; Manor 0.16.163 and later,
 *    with Other PCs on): the same code passed there.
 *
 * 2 and 3 are taken by one rule (the kit's whyNotPass): a pass of the whole checks (never only the tests a change
 * reached, whose pick depends on the base it was compared with), of the same repository and tree, under a day old, of
 * every command Settings give the checks, on the same Node.js major and OS. A failure here newer than the pass, and it
 * isn't taken: the newest here says how the code stands on this PC. A failure elsewhere never spares a run here. A pass
 * from another PC is kept here too, as that PC's (`from`), so the Work page and this PC's next look find it.
 *
 * Never for a kit under trial (STEWARD_KIT: not the tree's own kit), a run with settings of its own (`env`), or one
 * whose point is to run on this PC (`here`: a trial's look at the agent without the kit, which asks whether this PC
 * fails it).
 */

/** What stood in for a run of the checks: who passed the code, where, when, and in a line for the log. */
export interface StoodIn {
  /** The Seneschal: a pass it holds of exactly these checks on this code, run here by an agent of this PC (bump.ts). */
  by?: 'assayer' | 'here' | 'pc' | 'seneschal';
  /** "in the Assayer", "here", "on LAPTOP": where the code passed. */
  where?: string;
  /** When it passed (ISO 8601). */
  at?: string;
  /** The Assayer's check, when it was the Assayer's. */
  assayed?: Assayed;
  /** The line said in the round's log. */
  line?: string;
}

/** A time in a few words: its hour and minute today, else its day too. */
export function whenWords(iso: string, now = Date.now()): string {
  const t = new Date(iso);
  const hm = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === t.toDateString() ? hm : `${t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${hm}`;
}

/**
 * The pass that stands in for running `e`'s checks in `dir` at `tree` (the Assayer's, this PC's or another PC's on the
 * licence), or null: then they run. A pass from another PC is kept here as that PC's. Never throws.
 */
export async function standIn(ctx: Ctx, e: Employee, dir: string, o: { tree: string; scope?: AffectedScope; now?: number; elsewhere?: PassElsewhere }): Promise<StoodIn | null> {
  try {
    const now = o.now ?? Date.now();
    // Under node --test, only an Assayer the test gave a home of its own.
    const assayed = process.env.NODE_TEST_CONTEXT && !process.env.ASSAYER_HOME ? null : await assayedHead(ctx.run, dir, e, { scope: o.scope, now });
    if (assayed) {
      const when = whenWords(assayed.check.at, now);
      return { by: 'assayer', where: 'in the Assayer', at: assayed.check.at, assayed, line: `the Assayer passed this exact tree at ${when}${assayed.chose ? ` (npm test: ${assayed.chose})` : ''}: nothing run again` };
    }
    const r = await passFor({ kind: 'checks', repo: e.repo, tree: o.tree, commands: e.test }, { now, ...(o.elsewhere !== undefined ? { elsewhere: o.elsewhere } : {}) });
    if (!r) return null;
    const where = r.from ? `on ${r.from.name}` : 'here';
    return { by: r.from ? 'pc' : 'here', where, at: r.at, line: `its checks passed ${where} at ${whenWords(r.at, now)}, on exactly this code (tree ${o.tree.slice(0, 7)}): not run again` };
  } catch {
    return null;
  }
}
