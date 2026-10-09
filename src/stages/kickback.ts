import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { WRIGHT_LABEL } from '../review.ts';
import { wrightInstalled, type Employee } from '../settings.ts';
import type { Ctx } from './common.ts';
import type { PrInfo } from './staff.ts';
import { hostFor, type Answer } from '../hosts/index.ts';

/**
 * A team PR that conflicts with its branch beyond what a catch-up resolves (stages/catchup.ts: version lines, and a
 * new entry at the top of the changelog) goes back to whoever wrote it, rather than waiting for a person:
 * - **The Wright's** (labelled `wright`, or a wright/… branch): closed, with a comment, and the issue it closes
 *   queued for the Wright again (its `wright:done` label removed), so the Wright does the work afresh from the branch
 *   as it is now. As the Steward does with a kit PR of its own that conflicts, its branch is deleted: the Wright names
 *   the redo's branch as it named this one (wright/<issue>-<words>), and couldn't push the redo over the old one.
 * - **A Claude Code session's** (a claude/… branch): a comment on the PR that names the files. The desktop app's
 *   Auto-fix, where it is on for that session, wakes it on the conflict itself.
 * - **Anyone else's**: the same comment, to its author.
 * Each is done once for a PR's head and its branch's: a round after that says the same, quietly. A new push to either
 * is a new conflict, and goes back again.
 */

export const kickbacksFile = () => dataFile('kickbacks.json');

export type Author = 'wright' | 'claude' | 'person';

/** Whose work a PR is, by its label and branch. The Wright's only where the Wright is installed: elsewhere a wright label is anyone's. */
export const authorOf = (pr: PrInfo, wright = wrightInstalled()): Author => (wright && (pr.labels.includes(WRIGHT_LABEL) || pr.head.startsWith('wright/')) ? 'wright' : pr.head.startsWith('claude/') ? 'claude' : 'person');

/** The issue the Wright's PR was its work for: the one its description closes, else its branch's number (wright/42-…). */
export function wrightIssueOf(pr: PrInfo): number | null {
  const n = pr.closes?.[0] ?? Number(/^wright\/(\d+)-/.exec(pr.head)?.[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface Kicked {
  head: string;
  branch: string;
  note: string;
  closed: boolean;
  at: string;
}

const code = (s: string) => `\`${s}\``;
const listOf = (files: string[]) => files.map(code).join(', ');

/** The comment on a PR that goes back to its author. */
export function kickBackComment(pr: PrInfo, branch: string, files: string[], author: Author): string {
  const who = author === 'claude' ? 'Over to the Claude Code session that opened it' : `Over to you, @${pr.author}`;
  return [
    `The Steward can't merge this yet: it conflicts with ${code(branch)} in ${listOf(files)}, beyond what it resolves by itself (version lines, and a new entry at the top of CHANGELOG.md).`,
    '',
    `${who}: merge ${code(branch)} into ${code(pr.head)}, resolve ${files.length === 1 ? 'it' : 'them'}, and push (a merge commit, never a force-push). The Steward's next round tests it again and merges it.`,
  ].join('\n');
}

/** Why a request to the host failed, or null when it did as asked. */
async function failure(answer: Promise<Answer>): Promise<string | null> {
  const r = await answer;
  return r.code === 0 ? null : (r.err || r.out).trim().split('\n').pop() || `exit ${r.code}`;
}

/**
 * Sends a conflicting PR back to its author, as the module's comment says; `branchAt` is its branch's head now. What
 * happened, for its hold and the round's line; `closed` when the Wright's PR was closed (it then waits for nothing),
 * `sent` when it went back (closed, or a comment left on it), not when the Steward couldn't say so.
 */
export async function kickBack(ctx: Ctx, e: Employee, pr: PrInfo, files: string[], branchAt: string | null): Promise<{ note: string; closed: boolean; sent: boolean }> {
  const key = `${e.repo}#${pr.number}`;
  const kept = readJson<Record<string, Kicked>>(kickbacksFile(), {});
  const was = kept[key];
  if (was && was.head === pr.headOid && was.branch === (branchAt ?? '')) return { note: was.note, closed: was.closed, sent: true };
  const where = `it conflicts with ${e.branch} in ${files.join(', ')}`;
  const author = authorOf(pr);
  let done: { note: string; closed: boolean } | null = null;
  let said = true;

  const issue = author === 'wright' ? wrightIssueOf(pr) : null;
  if (issue) {
    const body = `Closed by the Steward: ${where.replace(/^it /, 'this ')}, beyond what it resolves by itself. #${issue} is queued for the Wright again, to be done afresh from ${e.branch} as it is now.`;
    const host = hostFor(ctx, e);
    const closeFailed = await failure(host.closePr(e.repo, pr.number, { deleteBranch: true, comment: body }));
    if (!closeFailed) {
      const relabel = await failure(host.editIssue(e.repo, issue, { removeLabel: 'wright:done' }));
      await failure(host.commentIssue(e.repo, issue, `#${pr.number} conflicted with ${code(e.branch)} in ${listOf(files)}, so the Steward closed it${relabel ? `; removing ${code('wright:done')} failed (${relabel}), so remove it to queue this again` : ', and this is queued for the Wright again'}.`));
      done = { note: `${where}, so the Steward closed it and ${relabel ? `couldn't queue #${issue} again (${relabel})` : `queued #${issue} for the Wright again`}`, closed: true };
    }
  }
  if (!done) {
    const failed = await failure(hostFor(ctx, e).commentPr(e.repo, pr.number, kickBackComment(pr, e.branch, files, author)));
    const to = author === 'claude' ? 'the Claude Code session that opened it' : author === 'wright' ? 'the Wright (no issue to queue again, so a comment)' : pr.author;
    done = { note: failed ? `${where}, and the Steward couldn't say so on it (${failed}): that needs a person` : `${where}: back with ${to}, in a comment on it`, closed: false };
    said = !failed;
  }
  ctx.log(`[${e.id}] #${pr.number}: ${done.note}`);
  // One that couldn't be said is tried again next round.
  if (!said) return { ...done, sent: false };
  kept[key] = { head: pr.headOid, branch: branchAt ?? '', ...done, at: new Date().toISOString() };
  writeJson(kickbacksFile(), Object.fromEntries(Object.entries(kept).slice(-300)));
  return { ...done, sent: true };
}
