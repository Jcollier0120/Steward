import { employeeFor } from '../claims.ts';
import { gitMaybe } from '../git.ts';
import { originRepo } from '../kit/manor.ts';
import { dataFile, readJson } from '../kit/store.ts';
import { WRIGHT_LABEL } from '../review.ts';
import type { Employee } from '../settings.ts';
import { runChecks } from './bump.ts';
import type { Ctx } from './common.ts';
import { VOUCH_CONTEXT, type PrInfo } from './staff.ts';

/**
 * A team PR whose checks its author ran and saw pass, at its head commit, isn't tested here again before it merges.
 *
 * `steward vouch`, run in the clone a PR was pushed from (a Claude Code session's, a person's), runs the repository's
 * checks as Settings give them (the Steward's own: its kit filled, then npm run typecheck and npm test) at the clone's
 * HEAD, which must be the PR's head, with nothing uncommitted. Once they pass, it sets a commit status on that commit:
 * context VOUCH_CONTEXT, state success. Nothing is set when they fail.
 *
 * The merge stage (merge.ts) trusts it only when a team member's account set it (Settings' team, read from GitHub's
 * record of who created the status), on the PR's current head, for a team PR from the repository itself that isn't the
 * Wright's. A new push, a catch-up's merge commit, or a vouch by anyone else: tested here as before. The status isn't a
 * check GitHub runs (checksOf leaves it out), so it never makes a PR's checks "passing" on its own.
 */

/** The Wright's PRs (labelled wright, or a wright/… branch): reviewed by the Bailiff, and always tested here. */
export const isWrightPr = (pr: PrInfo) => pr.labels.includes(WRIGHT_LABEL) || pr.head.startsWith('wright/');

/**
 * The team member who vouched for this PR's head (the latest VOUCH_CONTEXT status on it says success, and one of `team`'s
 * accounts set it), or null: not a team PR from the repository itself, the Wright's, no vouch, or GitHub couldn't be asked.
 * Never throws.
 */
export async function vouchedBy(ctx: Ctx, e: Employee, pr: PrInfo, team: string[]): Promise<string | null> {
  if (pr.whose !== 'team' || pr.fork || !pr.headOid || isWrightPr(pr)) return null;
  const r = await ctx.run('gh', ['api', `repos/${e.repo}/commits/${pr.headOid}/statuses?per_page=100`], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  let list: any[];
  try {
    list = JSON.parse(r.out);
  } catch {
    return null;
  }
  // GitHub lists a commit's statuses newest first: the latest of the context is what it says now.
  const latest = Array.isArray(list) ? list.find((s) => s?.context === VOUCH_CONTEXT) : null;
  if (!latest || latest.state !== 'success') return null;
  const by = String(latest.creator?.login ?? '');
  return by && team.some((t) => t.toLowerCase() === by.toLowerCase()) ? by : null;
}

/**
 * After a vouch: the Steward running on this PC asked for a round now (its POST /api/round/soon), so the PR merges in
 * minutes when its turn has come, rather than at the next round. Its port and token from its server.json, as its own
 * stop reads them. What it answered, in a sentence; never throws, and never fails the vouch.
 */
export async function askRoundSoon(o: { fetch?: typeof fetch } = {}): Promise<string> {
  const later = 'it merges at its next round instead';
  const info = readJson<{ port?: number; token?: string } | null>(dataFile('server.json'), null);
  if (!info?.port || !info.token) return `The Steward's page isn't running on this PC: ${later}.`;
  try {
    const r = await (o.fetch ?? fetch)(`http://127.0.0.1:${info.port}/api/round/soon`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': info.token }, body: '{}', signal: AbortSignal.timeout(5000) });
    const j = (await r.json().catch(() => null)) as { message?: unknown } | null;
    if (r.ok && typeof j?.message === 'string') return j.message;
    return `The Steward's page answered HTTP ${r.status}: ${later}.`;
  } catch (e) {
    return `The Steward's page didn't answer (${(e as Error).message}): ${later}.`;
  }
}

/** What `steward vouch` did: whether it set the status, and in a sentence what happened. */
export interface Vouched {
  ok: boolean;
  message: string;
}

/**
 * `steward vouch [<pr>]` in the clone at `dir`: the PR (by number, else the one for the clone's branch) checked against
 * the clone (open, from the repository itself, its head the clone's HEAD, nothing uncommitted), the repository's checks
 * run there, and once they pass, the commit status set. Never vouches for what it didn't test.
 */
export async function vouch(ctx: Ctx, o: { dir: string; pr?: number; say: (line: string) => void }): Promise<Vouched> {
  const { run } = ctx;
  const repo = originRepo(o.dir);
  if (!repo) return { ok: false, message: `${o.dir} isn't a clone of a GitHub repository (its origin)` };
  const e = employeeFor(ctx.settings, repo, o.dir);
  if (!e) return { ok: false, message: `${repo} isn't a repository the Steward looks after (Settings), nor its own: it has no checks to run` };
  const dirty = (await gitMaybe(run, o.dir, 'status', '--porcelain'))?.trim();
  if (dirty === undefined) return { ok: false, message: `git couldn't read ${o.dir}` };
  if (dirty) return { ok: false, message: 'it has uncommitted changes: commit and push them first, as it vouches only for a commit as pushed' };
  const head = (await gitMaybe(run, o.dir, 'rev-parse', 'HEAD'))?.trim() ?? '';
  const branch = (await gitMaybe(run, o.dir, 'branch', '--show-current'))?.trim() ?? '';
  const which = o.pr ? String(o.pr) : branch;
  if (!which) return { ok: false, message: 'name the PR (steward vouch <number>): this clone is on no branch' };
  const v = await run('gh', ['pr', 'view', which, '--repo', repo, '--json', 'number,state,headRefOid,isCrossRepository'], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
  if (v.code !== 0) return { ok: false, message: `no open PR ${o.pr ? `#${o.pr}` : `for ${branch}`} in ${repo}: ${(v.err || v.out).trim().split('\n').pop()}` };
  const pr = JSON.parse(v.out) as { number: number; state: string; headRefOid: string; isCrossRepository: boolean };
  if (pr.state !== 'OPEN') return { ok: false, message: `#${pr.number} is ${pr.state.toLowerCase()}, not open` };
  if (pr.isCrossRepository) return { ok: false, message: `#${pr.number} is from a fork: the Steward tests those itself` };
  if (pr.headRefOid !== head) return { ok: false, message: `#${pr.number}'s head is ${pr.headRefOid.slice(0, 7)}, this clone's HEAD ${head.slice(0, 7)}: push, or check out its head, and vouch again` };
  o.say(`${e.name} #${pr.number} at ${head.slice(0, 7)}: its checks, in ${o.dir}`);
  const failed = await runChecks(ctx, e, o.dir, { say: o.say });
  if (failed) return { ok: false, message: `#${pr.number}'s checks failed at ${head.slice(0, 7)}: ${failed}. Nothing was recorded` };
  const description = `${[e.fill, ...e.test].filter(Boolean).join(', ')} passed at ${head.slice(0, 7)}`.slice(0, 140);
  const s = await run('gh', ['api', '-X', 'POST', `repos/${repo}/statuses/${head}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`, '-f', `description=${description}`], { cwd: ctx.neutralDir, timeoutMs: 60_000 });
  if (s.code !== 0) return { ok: false, message: `its checks passed, but GitHub wouldn't take the status: ${(s.err || s.out).trim().split('\n').pop()}` };
  return { ok: true, message: `#${pr.number}'s checks passed at ${head.slice(0, 7)}, and GitHub has it (${VOUCH_CONTEXT}): the Steward merges it without testing it again, unless it is pushed to first` };
}
