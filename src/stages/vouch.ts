import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { claimsOn, employeeFor, highest, pushesHere } from '../claims.ts';
import { identityOf } from '../employ.ts';
import { CHANGES_README } from '../entries.ts';
import { gitMaybe, showFile } from '../git.ts';
import { originRepo } from '../kit/manor.ts';
import { compareVersions } from '../kitfiles.ts';
import { makersPc, makersRepo } from '../maker.ts';
import { employeeFromClone } from '../migrate.ts';
import { originUrl, repoFromUrl, type Host } from '../scm.ts';
import { heldBy, pipelineOf, type MergeMethod } from '../repoconfig.ts';
import type { Employee } from '../settings.ts';
import { agreedVersion, readVersion } from '../versions.ts';
import { checkKind, runChecks, type AffectedScope } from './bump.ts';
import type { StoodIn } from './standin.ts';
import { hostIs, type Ctx } from './common.ts';
import { VOUCH_CONTEXT, type PrInfo } from './staff.ts';
import { kitContentOf, kitTrialOfClone } from './trial.ts';
import { noteVouchTime, vouchLimit } from './vouchtime.ts';
import { hostFor } from '../hosts/index.ts';
import { teaLogin, whereGitea } from '../hosts/gitea.ts';

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
 * five minutes past the vouch's average time are stopped, and nothing is set (vouchtime.ts). Before any of that, HEAD's
 * version files must agree, as a kit's trial needs them to (versionTrouble): a PR whose files disagree is refused, and
 * nothing is run or set. A PR of the Steward's own that changes what the agents take from the kit then has that kit
 * tried on them, as main's trial will try it (vouchTrial), and an agent's test it breaks fails the vouch.
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

/**
 * What to do once vouched: merge it yourself, and the next build releases it. Said as its host takes it (GitHub's gh, as
 * before, unless `o` says), with its pipeline's merge method (repoconfig.ts). tea takes a repository as owner/name and
 * its server as a login (`o.login`, else one named after its host, as tea login add names one), never host/owner/name,
 * which it answers "not found" (Steward 0.36.267, found live). Pure.
 */
export function MERGE_IT_YOURSELF(pr: number | null, repo: string, o: { host?: Host; method?: MergeMethod; login?: string | null } = {}): string {
  const n = pr ?? '<number>';
  const method = o.method ?? 'merge';
  const gitea = whereGitea(repo);
  const how: Record<Exclude<Host, 'git'>, [string, string]> = {
    github: ['GitHub', `gh pr merge ${n} --repo ${repo} --${method}`],
    gitlab: ['GitLab', `glab mr merge ${n} --repo ${repo}${method === 'merge' ? '' : ` --${method}`}`],
    azure: ['Azure DevOps', `az repos pr update --id ${n} --status completed${method === 'squash' ? ' --squash true' : ''}`],
    gitea: ['Gitea', gitea ? `tea pr merge ${n} --repo ${gitea.owner}/${gitea.name} --login ${o.login || gitea.hostname} --style ${method}` : `tea pr merge ${n} --style ${method}, in its clone`],
    bitbucket: ['Bitbucket', `its Merge button on bitbucket.org, ${method === 'merge' ? 'merge commit' : method === 'squash' ? 'squash' : 'fast-forward'}`],
  };
  const [name, command] = how[o.host && o.host !== 'git' ? o.host : 'github'];
  return `merge it yourself now, once ${name} says it merges cleanly (${command}): the Steward merges no one's PRs, and the next build releases main`;
}

/** The tea login a repository worked with Gitea's way is merged with (MERGE_IT_YOURSELF); null for any other. */
const mergeLogin = async (ctx: Ctx, e: Employee, repo: string): Promise<string | null> => {
  const w = hostIs(ctx, e) === 'gitea' ? whereGitea(repo) : null;
  return w ? teaLogin(ctx.run, ctx.neutralDir, w.hostname).catch(() => null) : null;
};

/** Why `steward vouch` can't vouch over plain git (scm.ts), and what happens instead. Pure. */
export const PLAIN_GIT_VOUCH = (e: Pick<Employee, 'name' | 'repo' | 'branch'>) =>
  `${e.name} (${e.repo}) is worked with plain git on this PC, which has no pull requests and no commit statuses, so there is nothing to vouch on: land your branch in ${e.branch}, and the next build runs its checks there and releases it only once they pass (steward build --dry-run ${e.repo} shows the steps)`;

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
  // By its own pipeline (repoconfig.ts): one that can't be read, or says not to vouch, isn't; plain git has nothing to vouch on.
  const p = pipelineOf(e);
  const held = heldBy(p);
  if (held) return { ok: false, message: `${e.name}: ${held}` };
  if (!p.vouch) return { ok: false, message: `${e.name}'s pipeline says its PRs aren't vouched for (vouch: false, in ${p.from.vouch}): nothing was run` };
  if (hostIs(ctx, e) === 'git') return { ok: false, message: PLAIN_GIT_VOUCH(e) };
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
  const versions = await versionTrouble(ctx, e, { dir: o.dir, head, branch, say: o.say });
  if (versions) return { ok: false, message: `#${pr.number} at ${head.slice(0, 7)}: ${versions}. Nothing was run or recorded` };
  o.say(`${e.name} #${pr.number} at ${head.slice(0, 7)}: its checks, in ${o.dir}`);
  const failed = await checkAndRecord(ctx, e, { ...o, repo, head });
  if (failed) return { ok: false, message: failed.startsWith('its checks passed') ? failed : `#${pr.number}'s checks failed at ${head.slice(0, 7)}: ${failed}. Nothing was recorded` };
  return { ok: true, message: `#${pr.number}'s checks passed at ${head.slice(0, 7)}, and ${hostFor(ctx, e).name} has it (${VOUCH_CONTEXT}): ${MERGE_IT_YOURSELF(pr.number, repo, { host: hostIs(ctx, e), method: p.mergeMethod, login: await mergeLogin(ctx, e, repo) })}. Push to it again, and vouch again.` };
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
 * Why the version files at `head` won't do, in the words a kit's trial refuses an employee with (bump.ts' bumpOne,
 * agreedVersion), and what to set where (versionFix); null when they agree, or when there are fewer than two of them,
 * which have nothing to disagree with. Through Steward 0.36.152 a vouch ran only the checks: Reeve#207 merged with
 * src/mcp.ts two patches behind its package.json, and the next two kits' trials refused Reeve, holding their releases,
 * until a PR mended it.
 *
 * A version below main's, or below the one claimed for the branch (claims.ts), is said as a warning, not refused; not
 * where the branch writes its entry in changes/ (entries.ts), whose version the build's stamp gives.
 */
export async function versionTrouble(ctx: Ctx, e: Employee, o: { dir: string; head: string; branch: string; say: (line: string) => void }): Promise<string | null> {
  if (e.versionFiles.length < 2) return null;
  const at = (rev: string) => Promise.all(e.versionFiles.map(async (f) => [f, await showFile(ctx.run, o.dir, rev, f)] as [string, string | null]));
  const claimed = o.branch ? claimsOn(e.repo).find((c) => c.branch === o.branch)?.version : undefined;
  const texts = await at(o.head);
  const agreed = agreedVersion(texts);
  if ('error' in agreed) {
    const fix = versionFix(texts, claimed);
    return fix ? `${agreed.error}; ${fix}, push, and vouch again` : agreed.error;
  }
  if ((await showFile(ctx.run, o.dir, o.head, CHANGES_README)) !== null) return null;
  const main = agreedVersion(await at(`origin/${e.branch}`));
  if ('version' in main && compareVersions(agreed.version, main.version) < 0)
    o.say(`warning: its version ${agreed.version} is below ${e.branch}'s ${main.version}${claimed ? '' : `: claim one (claim-version ${e.id} --branch ${o.branch || '<branch>'} --for "<what the work is>") and set it`}`);
  if (claimed && compareVersions(agreed.version, claimed) < 0) o.say(`warning: its version ${agreed.version} is below ${claimed}, claimed for ${o.branch}: set ${claimed} in ${e.versionFiles.join(', ')}`);
  return null;
}

/**
 * What to set where when version files disagree: `want` (the version claimed for the branch), else the highest any of
 * them carries, in each that doesn't carry it. Null when none carries a version to set. Pure.
 */
export function versionFix(texts: [string, string | null][], want?: string): string | null {
  const found = texts.map(([f, t]) => [f, t === null ? null : readVersion(f, t)] as const);
  const v = want ?? highest(found.map(([, x]) => x));
  const off = found.filter(([, x]) => x !== v).map(([f]) => f);
  return v && off.length ? `set ${v} in ${off.join(', ')}` : null;
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
  const took = Date.now() - started;
  // A kit PR's kit tried on the agents, as main's trial will try it once it's merged.
  const trial = await vouchTrial(ctx, e, o);
  if (trial && 'failed' in trial) return trial.failed;
  const tried = trial ? `; ${trial.passed}` : '';
  if (stoodIn.by) return setVouch(ctx, e, o.repo, o.head, withTrial(stoodInDescription(e, stoodIn, o.head), tried));
  noteVouchTime(e.id, checkKind(scope), took, scope?.files);
  return setVouch(ctx, e, o.repo, o.head, withTrial(vouchDescription(e, scope, o.head), tried));
}

/** A vouch's description and its kit trial's words after it, as far as GitHub keeps (140 characters). Pure. */
const withTrial = (description: string, tried: string) => `${description}${tried}`.slice(0, 140);

/**
 * A PR of the Steward's own that changes the kit an agent gets (kitContentOf: kit\'s parts and tools/kit.ts, at its
 * head against where it left main) has its kit tried on the agents at its vouch, once its own checks pass: each agent
 * main's trial would try, as that trial tries them (trial.ts's kitTrialOfClone), one at a time. Through Steward 0.36.239
 * only main's trial did, after the merge: kit 2.137.2's PR passed its own checks while Reeve's and the Surveyor's tests
 * still expected manor.localhost, and only test-only PRs in their repositories, made by hand first, kept its trial from
 * holding the kit and every Steward PR behind it.
 *
 * Null for any other repository, or a PR whose kit is main's: nothing to try. `failed` names each agent and the tests
 * that broke; a try the network cut short fails it too (vouch again), as no verdict on the kit. `passed`: what it came
 * to, for the vouch's description.
 */
export async function vouchTrial(ctx: Ctx, e: Employee, o: { dir: string; head: string; say: (line: string) => void }): Promise<{ failed: string } | { passed: string } | null> {
  if (e.id !== APP.id) return null;
  const base = (await gitMaybe(ctx.run, o.dir, 'merge-base', `origin/${e.branch}`, o.head))?.trim();
  const now = await kitContentOf(ctx, o.dir, o.head);
  if (!now || (base && now === (await kitContentOf(ctx, o.dir, base)))) {
    o.say(`no kit trial: what the agents take from the kit is ${e.branch}'s`);
    return null;
  }
  const kit = (await showFile(ctx.run, o.dir, o.head, 'kit/VERSION'))?.trim();
  if (!kit) return { failed: `its kit changes, and its kit/VERSION can't be read at ${o.head.slice(0, 7)}: the kit can't be tried on the agents` };
  o.say(`its kit ${kit} changes what the agents take from it: tried on each of them, one at a time, as main's trial will try it`);
  const t = await kitTrialOfClone(ctx, { dir: o.dir, head: o.head, kit }, o.say);
  if (t.cut) return { failed: `${t.cut}: no verdict on the kit, so vouch again` };
  const own = t.own.length ? `; ${t.own.map((f) => f.name).join(', ')} failed without it too, so not held against it` : '';
  if (t.failed.length) {
    const each = t.failed.map((f) => `${f.name}: ${f.message}`).join('; ');
    return { failed: `kit ${kit} fails ${t.failed.length} agent${t.failed.length === 1 ? "'s" : "s'"} checks (${t.failed.map((f) => f.name).join(', ')}), as main's trial would: ${each}${own}. Fix the kit, or the agents' tests on their own mains so they pass with the kit and without it` };
  }
  const passed = `kit ${kit} passed ${t.passed} of ${t.staff} agents' checks`;
  o.say(`${passed}${t.staff - t.passed - t.own.length ? ` (the rest not tried: nothing they take from the kit changes)` : ''}${own}`);
  return { passed };
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
 * comes from that, and origin's head of it must be the clone's HEAD. Not where the branch writes its entries in
 * changes/ (entries.ts): there claim-version claims nothing, and the build's stamp gives the work its version.
 */
async function vouchBranch(ctx: Ctx, e: Employee, o: { dir: string; repo: string; branch: string; head: string; say: (line: string) => void; overMs?: number }): Promise<Vouched> {
  const changes = (await showFile(ctx.run, o.dir, o.head, CHANGES_README)) !== null;
  const claim = changes ? null : claimsOn(e.repo).find((c) => c.branch === o.branch);
  if (!changes && !claim) return { ok: false, message: `${o.branch} has no PR, and no version is claimed for it: claim one (claim-version ${e.id} --branch ${o.branch} --for "<what the work is>"), push, open its PR, and vouch again` };
  if (o.branch.startsWith('wright/') || o.branch.startsWith('steward/')) return { ok: false, message: `${o.branch} is ${o.branch.startsWith('wright/') ? "the Wright's" : "the Steward's"}: it opens its own PRs` };
  const out = await gitMaybe(ctx.run, o.dir, 'ls-remote', '--heads', 'origin', `refs/heads/${o.branch}`);
  if (out === null) return { ok: false, message: `git couldn't ask origin for ${o.branch}` };
  const pushed = out.trim().split(/\s+/)[0] ?? '';
  if (!pushed) return { ok: false, message: `${o.branch} isn't on origin: push it, and vouch again` };
  if (pushed !== o.head) return { ok: false, message: `origin's ${o.branch} is at ${pushed.slice(0, 7)}, this clone's HEAD ${o.head.slice(0, 7)}: push, or check out its head, and vouch again` };
  const versions = await versionTrouble(ctx, e, o);
  if (versions) return { ok: false, message: `${o.branch} at ${o.head.slice(0, 7)}: ${versions}. Nothing was run or recorded` };
  o.say(`${e.name} ${o.branch} (${claim ? `v${claim.version}, ` : ''}no PR yet) at ${o.head.slice(0, 7)}: its checks, in ${o.dir}`);
  const failed = await checkAndRecord(ctx, e, o);
  if (failed) return { ok: false, message: failed.startsWith('its checks passed') ? failed : `${o.branch}'s checks failed at ${o.head.slice(0, 7)}: ${failed}. Nothing was recorded` };
  return { ok: true, message: `${o.branch}'s checks passed at ${o.head.slice(0, 7)}, and ${hostFor(ctx, e).name} has it (${VOUCH_CONTEXT}): open its PR${claim ? ` (v${claim.version})` : ''} from that commit, and ${MERGE_IT_YOURSELF(null, o.repo, { host: hostIs(ctx, e), method: pipelineOf(e).mergeMethod, login: await mergeLogin(ctx, e, o.repo) })}` };
}
