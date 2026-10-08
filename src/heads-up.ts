import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Ctx } from './stages/common.ts';
import { pokePage, type Poke } from './upkeep.ts';
import type { UpcomingDraft } from './version-queue.ts';

/**
 * An early word about a draft coming up in a version queue (version-queue.ts upcomingDrafts): the merges take the
 * lowest version first and a draft holds its place, so a draft near the front holds up every ready PR above it until
 * it is marked ready. Told before its turn comes, its reviewer or author has time to finish it.
 *
 * Each such draft gets one comment on its PR: when it comes up, and again only if it then starts holding ready PRs
 * back. One of the Wright's drafts is the Bailiff's to review: the Bailiff reads the same list (GET /api/version-queues,
 * `upcoming`) and reviews those first, and is woken (POST /api/run) when one newly comes up, rather than at its next
 * round. Only in repositories whose PRs the Steward merges (Settings): elsewhere the order is the person's.
 */

/** How far along a draft has been told it is: coming up, or already holding ready PRs back. */
type Stage = 'coming' | 'holding';
interface Told {
  stage: Stage;
  at: string;
}

export const headsUpFile = () => dataFile('heads-up.json');
const keyOf = (u: UpcomingDraft) => `${u.repo}#${u.number}`;
const stageOf = (u: UpcomingDraft): Stage => (u.holds.length ? 'holding' : 'coming');
const ordinal = (n: number) => (n === 1 ? 'next' : n === 2 ? 'second' : n === 3 ? 'third' : `number ${n}`);
const list = (ns: number[]) => {
  const xs = ns.map((n) => `#${n}`);
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

/** The comment on the draft. Pure. */
export function headsUpComment(u: UpcomingDraft): string {
  const where = `${ordinal(u.position + 1)} in line in ${u.name}, for v${u.version}`;
  const waiting = u.holds.length ? ` ${list(u.holds)} ${u.holds.length === 1 ? 'is' : 'are'} ready and ${u.holds.length === 1 ? 'waits' : 'wait'} on it.` : '';
  const ask = u.wright
    ? 'The Bailiff is asked to review it ahead of the rest. If it needs a person, review it and mark it ready.'
    : 'Mark it ready once it is done, or close it if it won\'t be: its version is then skipped, and the next in line goes on.';
  return `**Heads-up from the Steward:** this draft is ${where}. The Steward merges the lowest version first, and a draft holds its place.${waiting}\n\n${ask}`;
}

/**
 * Tells each draft coming up that hasn't been told at its stage yet (a comment on its PR), and wakes the Bailiff when
 * one of the Wright's is among them. One line each for the log.
 */
export async function headsUp(ctx: Ctx, upcoming: UpcomingDraft[], o: { bailiffUrl: string; poke?: Poke; now?: () => Date }): Promise<string[]> {
  const told = readJson<Record<string, Told>>(headsUpFile(), {});
  const at = (o.now?.() ?? new Date()).toISOString();
  const merged = new Set(ctx.settings.employees.filter((e) => e.merges).map((e) => e.id));
  const lines: string[] = [];
  let wakeBailiff = false;
  for (const u of upcoming) {
    if (!merged.has(u.id)) continue;
    const stage = stageOf(u);
    const before = told[keyOf(u)];
    if (before && (before.stage === stage || before.stage === 'holding')) continue;
    const r = await ctx.run('gh', ['pr', 'comment', String(u.number), '--repo', u.repo, '--body', headsUpComment(u)], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
    if (r.code !== 0) {
      lines.push(`${u.repo}#${u.number}: couldn't leave its heads-up: ${(r.err || r.out).trim().split('\n').pop()}`);
      continue;
    }
    told[keyOf(u)] = { stage, at };
    lines.push(`${u.repo}#${u.number}: told it is ${ordinal(u.position + 1)} in line${u.holds.length ? `, holding ${list(u.holds)}` : ''}`);
    if (u.wright) wakeBailiff = true;
  }
  if (wakeBailiff && o.bailiffUrl) {
    const r = await (o.poke ?? pokePage)(new URL('/api/run', o.bailiffUrl).href);
    lines.push(r.ok ? 'the Bailiff was asked to review the coming drafts now' : `the Bailiff couldn't be woken (${r.said}): it reviews them at its next round`);
  }
  // The oldest go once there are more than 500.
  writeJson(headsUpFile(), Object.fromEntries(Object.entries(told).slice(-500)));
  return lines;
}
