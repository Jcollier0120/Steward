import { claimsOn, employeeFor } from '../claims.ts';
import { gitMaybe } from '../git.ts';
import { originRepo } from '../kit/manor.ts';
import { originUrl, repoFromUrl } from '../scm.ts';
import { dataFile, readJson } from '../kit/store.ts';
import { WRIGHT_LABEL } from '../review.ts';
import type { Employee } from '../settings.ts';
import { checkKind, runChecks, type AffectedScope } from './bump.ts';
import type { StoodIn } from './standin.ts';
import type { Ctx } from './common.ts';
import { VOUCH_CONTEXT, type PrInfo } from './staff.ts';
import { noteVouchTime, vouchLimit } from './vouchtime.ts';
import { hostFor } from '../hosts/index.ts';

/**
 * A team PR whose checks its author ran and saw pass, at its head commit, isn't tested here again before it merges.
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
 * The merge stage (merge.ts) trusts it only when a team member's account set it (Settings' team, read from GitHub's
 * record of who created the status), on the PR's current head, for a team PR from the repository itself that isn't the
 * Wright's. A new push, or a vouch by anyone else: tested here as before. A catch-up's merge commit keeps the vouch only
 * where it resolved nothing but version lines and changelogs (catchup.ts keepsStanding, prtest.ts carryTested). The
 * status isn't a check GitHub runs (checksOf leaves it out), so it never makes a PR's checks "passing" on its own. Nor
 * does it stand for the kit its kit.json pins: one not released holds a vouched PR as it holds any (prtest.ts's
 * kitReleaseHold), since its author's clone may have filled a kit from a Steward tree.
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
  return vouchOn(ctx, e.repo, pr.headOid, team);
}

/**
 * The team member who vouched for a commit of `repo` (the latest VOUCH_CONTEXT status on it says success, and one of
 * `team`'s accounts set it), or null. A PR's head (vouchedBy), or a claimed branch's with no PR yet (branchesin.ts).
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

/**
 * After a vouch: the Steward running on this PC asked for a round now (its POST /api/round/soon), so the PR merges in
 * minutes when its turn has come, rather than at the next round. Its port and token from its server.json, as its own
 * stop reads them. What it answered, in a sentence; never throws, and never fails the vouch.
 */
export async function askRoundSoon(o: { fetch?: typeof fetch; look?: string } = {}): Promise<string> {
  const later = 'it merges at its next round instead';
  const info = readJson<{ port?: number; token?: string } | null>(dataFile('server.json'), null);
  if (!info?.port || !info.token) return `The Steward's page isn't running on this PC: ${later}.`;
  try {
    // A branch with no PR yet changes nothing GitHub's glance shows: the round is asked to look at its employee anyway.
    const body = JSON.stringify(o.look ? { look: [o.look] } : {});
    const r = await (o.fetch ?? fetch)(`http://127.0.0.1:${info.port}/api/round/soon`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': info.token }, body, signal: AbortSignal.timeout(5000) });
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
  /** A branch vouched for with no PR yet: the employee whose round opens it (branchesin.ts), for the round asked for now. */
  look?: string;
}

/**
 * `steward vouch [<pr>]` in the clone at `dir`: the PR (by number, else the one for the clone's branch) checked against
 * the clone (open, from the repository itself, its head the clone's HEAD, nothing uncommitted), the repository's checks
 * run there, and once they pass, the commit status set. Never vouches for what it didn't test.
 *
 * A branch with no PR at all is vouched for as it is pushed, once a version is claimed for it (claims.ts): the Steward's
 * round then opens its PR (branchesin.ts), and merges it as any vouched one. `overMs` stands in for the time limit's
 * five minutes over the average (a test's).
 */
export async function vouch(ctx: Ctx, o: { dir: string; pr?: number; say: (line: string) => void; overMs?: number }): Promise<Vouched> {
  const { run } = ctx;
  const url = originUrl(o.dir);
  const repo = originRepo(o.dir) ?? (url ? repoFromUrl(url) : null);
  if (!repo) return { ok: false, message: `${o.dir} isn't a clone of a repository (it has no origin)` };
  const e = employeeFor(ctx.settings, repo, o.dir);
  if (!e) return { ok: false, message: `${repo} isn't a repository the Steward looks after (Settings), nor its own: it has no checks to run` };
  const dirty = (await gitMaybe(run, o.dir, 'status', '--porcelain'))?.trim();
  if (dirty === undefined) return { ok: false, message: `git couldn't read ${o.dir}` };
  if (dirty) return { ok: false, message: 'it has uncommitted changes: commit and push them first, as it vouches only for a commit as pushed' };
  const head = (await gitMaybe(run, o.dir, 'rev-parse', 'HEAD'))?.trim() ?? '';
  const branch = (await gitMaybe(run, o.dir, 'branch', '--show-current'))?.trim() ?? '';
  const which = o.pr ? String(o.pr) : branch;
  if (!which) return { ok: false, message: 'name the PR (steward vouch <number>): this clone is on no branch' };
  const v = await hostFor({ ...ctx, run }, e).viewPr(repo, which, 'number,state,headRefOid,isCrossRepository');
  // No PR from its branch: vouched for as pushed, and its PR opened by the Steward (branchesin.ts).
  if (v.code !== 0 && !o.pr && /no pull requests found/i.test(`${v.err}\n${v.out}`)) return vouchBranch(ctx, e, { ...o, repo, branch, head });
  if (v.code !== 0) return { ok: false, message: `no open PR ${o.pr ? `#${o.pr}` : `for ${branch}`} in ${repo}: ${(v.err || v.out).trim().split('\n').pop()}` };
  const pr = JSON.parse(v.out) as { number: number; state: string; headRefOid: string; isCrossRepository: boolean };
  if (pr.state !== 'OPEN') return { ok: false, message: `#${pr.number} is ${pr.state.toLowerCase()}, not open` };
  if (pr.isCrossRepository) return { ok: false, message: `#${pr.number} is from a fork: the Steward tests those itself` };
  if (pr.headRefOid !== head) return { ok: false, message: `#${pr.number}'s head is ${pr.headRefOid.slice(0, 7)}, this clone's HEAD ${head.slice(0, 7)}: push, or check out its head, and vouch again` };
  o.say(`${e.name} #${pr.number} at ${head.slice(0, 7)}: its checks, in ${o.dir}`);
  const failed = await checkAndRecord(ctx, e, { ...o, repo, head });
  if (failed) return { ok: false, message: failed.startsWith('its checks passed') ? failed : `#${pr.number}'s checks failed at ${head.slice(0, 7)}: ${failed}. Nothing was recorded` };
  return { ok: true, message: `#${pr.number}'s checks passed at ${head.slice(0, 7)}, and ${hostFor(ctx, e).name} has it (${VOUCH_CONTEXT}): the Steward merges it without testing it again, unless it is pushed to first` };
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
 * The vouch set on `head` (VOUCH_CONTEXT, success): by `steward vouch` once a clone's checks pass, and by the Steward's
 * own PR test once they pass here (prtest.ts), so the Assayer, which vouches for any team PR head without one, doesn't
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
  if (!claim) return { ok: false, message: `${o.branch} has no PR, and no version is claimed for it: claim one (claim-version ${e.id} --branch ${o.branch} --for "<what the work is>"), push, and vouch again; the Steward then opens its PR` };
  if (o.branch.startsWith('wright/') || o.branch.startsWith('steward/')) return { ok: false, message: `${o.branch} is ${o.branch.startsWith('wright/') ? "the Wright's" : "the Steward's"}: it opens its own PRs` };
  const out = await gitMaybe(ctx.run, o.dir, 'ls-remote', '--heads', 'origin', `refs/heads/${o.branch}`);
  if (out === null) return { ok: false, message: `git couldn't ask origin for ${o.branch}` };
  const pushed = out.trim().split(/\s+/)[0] ?? '';
  if (!pushed) return { ok: false, message: `${o.branch} isn't on origin: push it, and vouch again` };
  if (pushed !== o.head) return { ok: false, message: `origin's ${o.branch} is at ${pushed.slice(0, 7)}, this clone's HEAD ${o.head.slice(0, 7)}: push, or check out its head, and vouch again` };
  o.say(`${e.name} ${o.branch} (v${claim.version}, no PR yet) at ${o.head.slice(0, 7)}: its checks, in ${o.dir}`);
  const failed = await checkAndRecord(ctx, e, o);
  if (failed) return { ok: false, message: failed.startsWith('its checks passed') ? failed : `${o.branch}'s checks failed at ${o.head.slice(0, 7)}: ${failed}. Nothing was recorded` };
  return { ok: true, look: e.id, message: `${o.branch}'s checks passed at ${o.head.slice(0, 7)}, and ${hostFor(ctx, e).name} has it (${VOUCH_CONTEXT}): the Steward opens its PR (v${claim.version}) at its round, and merges it without testing it again, unless it is pushed to first` };
}
