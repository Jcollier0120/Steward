import { readFileSync } from 'node:fs';
import path from 'node:path';
import { claimsOn, employeeFor, pushesHere } from '../claims.ts';
import { identityOf } from '../employ.ts';
import { gitMaybe } from '../git.ts';
import { originRepo } from '../kit/manor.ts';
import { makersPc, makersRepo } from '../maker.ts';
import { employeeFromClone } from '../migrate.ts';
import { originUrl, repoFromUrl } from '../scm.ts';
import type { Employee } from '../settings.ts';
import { checkKind, runChecks, type AffectedScope } from './bump.ts';
import type { StoodIn } from './standin.ts';
import type { Ctx } from './common.ts';
import { VOUCH_CONTEXT, type PrInfo } from './staff.ts';
import { noteVouchTime, vouchLimit } from './vouchtime.ts';
import { hostFor } from '../hosts/index.ts';

/**
 * A PR whose checks its author ran and saw pass, at its head commit: its author merges it (Steward 0.36.124: the Steward
 * merges no one's PRs), and the build that releases it doesn't test that code again.
 *
 * `steward vouch`, run in the clone a PR was pushed from (a Claude Code session's, a person's), runs the repository's
 * checks as Settings give them (the Steward's own: its kit filled, then npm run typecheck and npm test) at the clone's
 * HEAD, which must be the PR's head, with nothing uncommitted. Once they pass, it sets a commit status on that commit:
 * context VOUCH_CONTEXT, state success. Nothing is set when they fail. When the Assayer already passed the whole of the
 * checks on exactly HEAD's tree, with the same dependencies and kit (assayed.ts), nothing is run again: its pass is taken;
 * and so is its affected pass, when the test files it ran take in every one the vouch would run itself; and so is a pass
 * of the whole checks on exactly that tree, on this PC or another on the licence (standin.ts). Checks that run
 * five minutes past the vouch's average time are stopped, and nothing is set (vouchtime.ts).
 *
 * A build (stages/mainbuild.ts) trusts it only when a team member's account set it (Settings' team, read from GitHub's
 * record of who created the status), on main's head itself, or on the PR head a merge commit brought in unchanged (a PR
 * merged while up to date with main). Anything else on main is tested there before it is released. The status isn't a
 * check GitHub runs (checksOf leaves it out), so it never makes a PR's checks "passing" on its own.
 *
 * On a maker's other PC, a clone of one of Castellan's own repositories, which only the maker's laptop looks after, is
 * vouched for with the checks the clone itself gives (makersClone), when GitHub says this PC's account can push there.
 */

/** The label the Wright puts on its PRs. */
export const WRIGHT_LABEL = 'wright';

/** The Wright's PRs (labelled wright, or a wright/… branch): reviewed by the Bailiff, and always tested here. */
export const isWrightPr = (pr: PrInfo) => pr.labels.includes(WRIGHT_LABEL) || pr.head.startsWith('wright/');

/**
 * The team member who vouched for this PR's head (the latest VOUCH_CONTEXT status on it says success, and one of `team`'s
 * accounts set it), or null: not a team PR from the repository itself, the Wright's, no vouch, or GitHub couldn't be asked.
 * Never throws.
 */
export async function vouchedBy(ctx: Ctx, e: Employee, pr: PrInfo, team: string[]): Promise<string | null> {
  if (pr.whose !== 'team' || pr.fork || !pr.headOid || isWrightPr(pr)) return null;
  return vouchOn(ctx, e.repo, pr.headOid, team);
}

/**
 * The team member who vouched for a commit of `repo` (the latest VOUCH_CONTEXT status on it says success, and one of
 * `team`'s accounts set it), or null. A PR's head (vouchedBy), or main's head at a build (mainbuild.ts).
 * Never throws.
 */
export async function vouchOn(ctx: Ctx, repo: string, commit: string, team: string[]): Promise<string | null> {
  const r = await hostFor(ctx, { repo }).statuses(repo, commit);
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

/** What to do once vouched: merge it yourself, and the next build releases it. Pure. */
export const MERGE_IT_YOURSELF = (pr: number | null, repo: string) =>
  `merge it yourself now, once GitHub says it merges cleanly (gh pr merge ${pr ?? '<number>'} --repo ${repo} --merge): the Steward merges no one's PRs, and the next build releases main`;

/** What `steward vouch` did: whether it set the status, and in a sentence what happened. */
export interface Vouched {
  ok: boolean;
  message: string;
}

/**
 * `steward vouch [<pr>]` in the clone at `dir`: the PR (by number, else the one for the clone's branch) checked against
 * the clone (open, from the repository itself, its head the clone's HEAD, nothing uncommitted), the repository's checks
 * run there, and once they pass, the commit status set. Never vouches for what it didn't test.
 *
 * A branch with no PR at all is vouched for as it is pushed, once a version is claimed for it (claims.ts): its author
 * then opens its PR and merges it. `overMs` stands in for the time limit's five minutes over the average (a test's).
 */
export async function vouch(ctx: Ctx, o: { dir: string; pr?: number; say: (line: string) => void; overMs?: number }): Promise<Vouched> {
  const { run } = ctx;
  const url = originUrl(o.dir);
  const repo = originRepo(o.dir) ?? (url ? repoFromUrl(url) : null);
  if (!repo) return { ok: false, message: `${o.dir} isn't a clone of a repository (it has no origin)` };
  const e = employeeFor(ctx.settings, repo, o.dir) ?? (await makersClone(ctx, repo, o.dir));
  if (!e)
    return {
      ok: false,
      message: makersRepo(repo) && !makersPc() ? `${repo} is one of Castellan's own, and GitHub doesn't say this PC's account can push to it: only those who can vouch for it` : `${repo} isn't a repository the Steward looks after (Settings), nor its own: it has no checks to run`,
    };
  const dirty = (await gitMaybe(run, o.dir, 'status', '--porcelain'))?.trim();
  if (dirty === undefined) return { ok: false, message: `git couldn't read ${o.dir}` };
  if (dirty) return { ok: false, message: 'it has uncommitted changes: commit and push them first, as it vouches only for a commit as pushed' };
  const head = (await gitMaybe(run, o.dir, 'rev-parse', 'HEAD'))?.trim() ?? '';
  const branch = (await gitMaybe(run, o.dir, 'branch', '--show-current'))?.trim() ?? '';
  const which = o.pr ? String(o.pr) : branch;
  if (!which) return { ok: false, message: 'name the PR (steward vouch <number>): this clone is on no branch' };
  const v = await hostFor({ ...ctx, run }, e).viewPr(repo, which, 'number,state,headRefOid,isCrossRepository');
  // No PR from its branch: vouched for as pushed, for the PR its author opens.
  if (v.code !== 0 && !o.pr && /no pull requests found/i.test(`${v.err}\n${v.out}`)) return vouchBranch(ctx, e, { ...o, repo, branch, head });
  if (v.code !== 0) return { ok: false, message: `no open PR ${o.pr ? `#${o.pr}` : `for ${branch}`} in ${repo}: ${(v.err || v.out).trim().split('\n').pop()}` };
  const pr = JSON.parse(v.out) as { number: number; state: string; headRefOid: string; isCrossRepository: boolean };
  if (pr.state !== 'OPEN') return { ok: false, message: `#${pr.number} is ${pr.state.toLowerCase()}, not open` };
  if (pr.isCrossRepository) return { ok: false, message: `#${pr.number} is from a fork: the Steward tests those itself` };
  if (pr.headRefOid !== head) return { ok: false, message: `#${pr.number}'s head is ${pr.headRefOid.slice(0, 7)}, this clone's HEAD ${head.slice(0, 7)}: push, or check out its head, and vouch again` };
  o.say(`${e.name} #${pr.number} at ${head.slice(0, 7)}: its checks, in ${o.dir}`);
  const failed = await checkAndRecord(ctx, e, { ...o, repo, head });
  if (failed) return { ok: false, message: failed.startsWith('its checks passed') ? failed : `#${pr.number}'s checks failed at ${head.slice(0, 7)}: ${failed}. Nothing was recorded` };
  return { ok: true, message: `#${pr.number}'s checks passed at ${head.slice(0, 7)}, and ${hostFor(ctx, e).name} has it (${VOUCH_CONTEXT}): ${MERGE_IT_YOURSELF(pr.number, repo)}. Push to it again, and vouch again.` };
}

/**
 * The employee a vouch on a maker's other PC runs a clone's checks as, for one of Castellan's own repositories: those are
 * looked after only on the maker's laptop (maker.ts' makersOwn), so Settings here have none of them, and through Steward
 * 0.36.127 `steward vouch` refused every one ("isn't a repository the Steward looks after"). It is the employee the clone
 * makes (migrate.ts' employeeFromClone: its kit filled when it has tools/kit.ts, then its typecheck and npm test), named
 * as the clone names itself (employ.ts' identityOf) or else by its repository, for this vouch only: never kept in
 * Settings, and no stage runs it.
 *
 * Only where GitHub says this PC's account can push to the repository (pushesHere, the rule claimRefused applies to a
 * version claim there): the vouch records a pass on GitHub, so a clone of a repository the account can't push to gives
 * no checks to take. Null for that, for a repository that isn't Castellan's, on the maker's laptop (whose Settings look
 * after them), or when the clone can't be read as one.
 */
export async function makersClone(ctx: Pick<Ctx, 'run' | 'neutralDir'>, repo: string, dir: string, o: { makers?: boolean; canPush?: (repo: string) => Promise<boolean> } = {}): Promise<Employee | null> {
  if ((o.makers ?? makersPc()) || !makersRepo(repo)) return null;
  if (!(await (o.canPush ?? pushesHere(ctx))(repo).catch(() => false))) return null;
  const read = (rel: string) => {
    try {
      return readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const own = repo.split('/').pop() ?? '';
  const me = identityOf(read) ?? { id: own.toLowerCase().replace(/[^a-z0-9-]/g, ''), name: own };
  return employeeFromClone({ id: me.id, name: me.name, repo, checkout: { path: dir } }, true)?.employee ?? null;
}

/**
 * The repository's checks run in the clone, and once they pass, the vouch set on `head`: null once it is, else why not
 * (their failure, or "its checks passed, but GitHub wouldn't take the status: …").
 */
async function checkAndRecord(ctx: Ctx, e: Employee, o: { dir: string; repo: string; head: string; say: (line: string) => void; overMs?: number }): Promise<string | null> {
  // Only the tests this change reaches (affected.ts), unless Settings say the whole suite.
  const scope: AffectedScope | undefined = ctx.settings.affectedTests === false ? undefined : { base: `origin/${e.branch}` };
  // Stopped five minutes past its usual time for as many test files (vouchtime.ts); a pass is kept toward that average. A pass of exactly
  // this tree stands in (runChecks, standin.ts): the Assayer's (whole, or the tests this change reaches), this PC's or
  // another PC's on the licence. Then nothing is run again, so the PC isn't loaded twice.
  const started = Date.now();
  const stoodIn: StoodIn = {};
  // A person waits on a vouch: the Seneschal's first lane (stages/seneschal.ts).
  const failed = await runChecks(ctx, e, o.dir, { say: o.say, ...(scope ? { affected: scope } : {}), timeLimit: (kind, files) => vouchLimit(e.id, kind, { overMs: o.overMs, files }), stoodIn, task: { lane: 'person' } });
  if (failed) return failed;
  if (stoodIn.by) return setVouch(ctx, e, o.repo, o.head, stoodInDescription(e, stoodIn, o.head));
  noteVouchTime(e.id, checkKind(scope), Date.now() - started, scope?.files);
  return setVouch(ctx, e, o.repo, o.head, vouchDescription(e, scope, o.head));
}

/** The vouch's description when a pass stood in for running the checks: whose, and at which commit. */
export function stoodInDescription(e: Employee, s: StoodIn, head: string): string {
  const a = s.assayed;
  if (a?.check.full) return `${(a.check.commands ?? []).join(', ')} passed in the Assayer at ${head.slice(0, 7)}`.slice(0, 140);
  if (a) return vouchDescription({ ...e, fill: '' }, { base: `origin/${e.branch}`, chose: a.chose }, head);
  return vouchDescription(e, undefined, head, s.by === 'pc' && s.where ? ` ${s.where}` : s.pc ? ` on ${s.pc}` : '');
}

/** The vouch's description: the checks that ran and passed, and at which commit (GitHub keeps 140 characters). */
export function vouchDescription(e: Employee, scope: AffectedScope | undefined, head: string, where = ''): string {
  const ran = e.test.map((s) => (scope?.chose && s.trim() === 'npm test' ? `npm test (${scope.chose})` : s));
  return `${[e.fill, ...ran].filter(Boolean).join(', ')} passed${where} at ${head.slice(0, 7)}`.slice(0, 140);
}

/**
 * The vouch set on `head` (VOUCH_CONTEXT, success): by `steward vouch` once a clone's checks pass, and by a build once
 * main's checks pass here (mainbuild.ts), so the Assayer, which vouches for any team PR head without one, doesn't
 * install and test it a second time. A refusal that reads as the host's passing trouble (passingTrouble) is tried again
 * after each of STATUS_WAITS_MS: setting the same status twice leaves one. Null once it is set, else why not. Never throws.
 */
export async function setVouch(ctx: Ctx, e: Employee, repo: string, head: string, description: string): Promise<string | null> {
  const host = hostFor(ctx, e);
  const pause = ctx.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let why = '';
  for (const ms of [0, ...STATUS_WAITS_MS]) {
    if (ms) {
      ctx.log(`[${e.id}] ${host.name} wouldn't take the status (${why}): trying again in ${ms / 1000} s`);
      await pause(ms);
    }
    const s = await host.setStatus(repo, head, { state: 'success', context: VOUCH_CONTEXT, description }).catch((err: Error) => ({ code: 1, out: '', err: err.message }));
    if (s.code === 0) return null;
    why = (s.err || s.out).trim().split('\n').pop() ?? '';
    if (!passingTrouble(`${s.err}\n${s.out}`)) break;
  }
  return `its checks passed, but ${host.name} wouldn't take the status: ${why}`;
}

/** How long setVouch waits before each time it sets the status again, after the host's passing trouble: 17 s in all. */
export const STATUS_WAITS_MS = [2_000, 5_000, 10_000];

/**
 * Whether a host's refusal reads as passing trouble, worth trying again: an answer cut short or not JSON, a 5xx, a
 * gateway or the network failing, a time-out. A refusal of the request itself (401, 403, 404, 422: no account, no
 * such commit, a bad status) isn't, and nor is anything else. Pure.
 */
export function passingTrouble(text: string): boolean {
  if (/\bHTTP 4\d\d\b|\(HTTP 4\d\d\)/i.test(text)) return false;
  return /unexpected end of JSON|invalid character .* looking for|\bHTTP 5\d\d\b|\(HTTP 5\d\d\)|\b50[0234]\b|bad gateway|service unavailable|gateway time-?out|internal server error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|connection reset|timed? ?out|\bEOF\b|TLS handshake|i\/o timeout|was killed/i.test(text);
}

/**
 * A branch with no PR, vouched for as it is pushed: a version must be claimed for it (claims.ts), since its PR's title
 * and its place in the version queue come from that, and origin's head of it must be the clone's HEAD.
 */
async function vouchBranch(ctx: Ctx, e: Employee, o: { dir: string; repo: string; branch: string; head: string; say: (line: string) => void; overMs?: number }): Promise<Vouched> {
  const claim = claimsOn(e.repo).find((c) => c.branch === o.branch);
  if (!claim) return { ok: false, message: `${o.branch} has no PR, and no version is claimed for it: claim one (claim-version ${e.id} --branch ${o.branch} --for "<what the work is>"), push, open its PR, and vouch again` };
  if (o.branch.startsWith('wright/') || o.branch.startsWith('steward/')) return { ok: false, message: `${o.branch} is ${o.branch.startsWith('wright/') ? "the Wright's" : "the Steward's"}: it opens its own PRs` };
  const out = await gitMaybe(ctx.run, o.dir, 'ls-remote', '--heads', 'origin', `refs/heads/${o.branch}`);
  if (out === null) return { ok: false, message: `git couldn't ask origin for ${o.branch}` };
  const pushed = out.trim().split(/\s+/)[0] ?? '';
  if (!pushed) return { ok: false, message: `${o.branch} isn't on origin: push it, and vouch again` };
  if (pushed !== o.head) return { ok: false, message: `origin's ${o.branch} is at ${pushed.slice(0, 7)}, this clone's HEAD ${o.head.slice(0, 7)}: push, or check out its head, and vouch again` };
  o.say(`${e.name} ${o.branch} (v${claim.version}, no PR yet) at ${o.head.slice(0, 7)}: its checks, in ${o.dir}`);
  const failed = await checkAndRecord(ctx, e, o);
  if (failed) return { ok: false, message: failed.startsWith('its checks passed') ? failed : `${o.branch}'s checks failed at ${o.head.slice(0, 7)}: ${failed}. Nothing was recorded` };
  return { ok: true, message: `${o.branch}'s checks passed at ${o.head.slice(0, 7)}, and ${hostFor(ctx, e).name} has it (${VOUCH_CONTEXT}): open its PR (v${claim.version}) from that commit, and ${MERGE_IT_YOURSELF(null, o.repo)}` };
}
