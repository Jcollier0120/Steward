import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { getJson, loadAlarms, watchAlarms, type GetJson, type Held } from './alarms.ts';
import { portUses } from './ports.ts';
import { APP, dataDir } from './app.ts';
import { clock, gate, GithubLimited, loadBudget, noteGlance, noteLimited, restReset, roundCost, saveBudget, waitLine } from './budget.ts';
import { apiAsk, repoSig, takeGlance, type Glance, type GlanceAsk } from './glance.ts';
import { kitInfo, kitInfoFrom, chooseKit, latestKit, localChangelog, ownKit, stewardTool, type KitInfo } from './kitsource.ts';
import { online as kitOnline } from './kit/net.ts';
import { shareRemoteHeads } from './kit/remote-heads.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { NO_TEAM, teamOf, type Owner } from './team.ts';
import { run as realRun, useDotnet, type Runner } from './run.ts';
import { expandEnv } from './kit/settings-kit.ts';
import { agentPages, loadSettings, selfRepoOf, settingsFile, type Employee, type Settings } from './settings.ts';
import { pendingMigration } from './migrate.ts';
import { DEVELOPER_ONLY, makersPc, stewardActs } from './maker.ts';
import { bump } from './stages/bump.ts';
import { headsUp } from './heads-up.ts';
import { heldQueues, keepVersionQueues, loadVersionQueues } from './version-queue.ts';
import { afterRound, heldBefore, loadSeen, planRound, saveSeen, type RoundPlan } from './stages/changes.ts';
import { checkoutOf, pick, result, type Ctx, type EmployeeResult, type StageName, type StageResult } from './stages/common.ts';
import { afterMerge } from './stages/aftermerge.ts';
import { conflictsWaiting, joinLooks, merge, mergeOne, NO_CONFLICTS, TESTED_BESIDE, waitsBriefly, type MergeLook } from './stages/merge.ts';
import { waitsForKit } from './stages/prtest.ts';
import { stewardEmployee } from './stages/selfmerge.ts';
import { loadUnsafe } from './safeinstall.ts';
import { loadClaims, pruneClaims, shareClaims } from './claims.ts';
import { push } from './stages/push.ts';
import { loadRefreshFailures, loadRefreshPending, refreshAfterReleases, refreshPendingFile, refreshStep, releasedWords } from './stages/refresh.ts';
import { loadInstallHolds } from './installscripts.ts';
import { release } from './stages/release.ts';
import { approveMerged } from './stages/jobs.ts';
import { releaseUnreleased, roundDidSomething, roundFailuresFile } from './stages/round.ts';
import { clearRolloutHolds, loadRolloutFailures, rollout, takeRolloutResults } from './stages/rollout.ts';
import { loadSelfFailures, releaseSelf, selfFactsAlone } from './stages/self.ts';
import { settleWholeSuite } from './stages/wholesuite.ts';
import { staff, type Staff } from './stages/staff.ts';
import { appendRotating, kitsDir, pruneKits, tellAfterRelease, type Poke } from './upkeep.ts';
import { loadTastingHolds, type TastingDeps } from './tasting.ts';
import { loadSigningWaits } from './signing.ts';
import { loadTending, tend, type OpenAgent, type StartManor } from './tend.ts';
import { loadUnstick, manorDryRun, unstick, type DryRun, type ManorUpdates, type AllowAgain, type PressUpdate, type RolledBack } from './unstick.ts';
import { githubTurnRefs, joinGuards, loadTurns, remoteFor, takeTurns, type TurnsDeps } from './lease.ts';
import { lookForStrangers } from './strangers.ts';
import { githubReady, hostOf, scmNow, type Host, type ScmLook } from './scm.ts';
import { hostFor, must } from './hosts/index.ts';
import { whereIs } from './hosts/gitlab.ts';
import { whereAzure } from './hosts/azure.ts';
import { whereGitea } from './hosts/gitea.ts';
import { apart, heldBy, repoBusy, withRepo, withStageSlot } from './stages/slots.ts';
import { boardedUrgent, buildWhen, endRound, kitRides, loadPipeline, pipelineMode, savePipeline, type BuildNow, type PipelineMode, type PipelineState, type UrgentPr } from './pipeline.ts';
import { urgentReady } from './stages/urgent.ts';
import { letOut } from './kit/exchequer.ts';
import { loadBuildLeft, noteReady } from './stages/build.ts';
import { keepPhases, phaseOf, timed } from './buildtimes.ts';
import { kitComing } from './stages/buildkit.ts';
import { prepareBeside } from './stages/prepare.ts';
import { selfTestBeside } from './stages/selftests.ts';

/**
 * The stages, as the command line and the page both run them: Settings' stagesAtOnce at a time on this PC, each
 * working on a repository only while it holds that repository's lock (stages/slots.ts), each recorded in
 * last-stage.json and appended to stages.log, and the staff's table refreshed after each. Each stage begins with one glance at GitHub (glance.ts) for every employee at once.
 */

export interface StageAsk {
  employees?: string[] | null;
  kit?: string | null;
  /** bump: start from this instead of origin/<branch> (a trial). */
  base?: string | null;
  /** bump: fill from this kit tree instead of the kit release. */
  kitFrom?: string | null;
  /** merge: merge, not only list. */
  yes?: boolean;
  /** merge: the team's PRs too, not only the Steward's. */
  team?: boolean;
  /**
   * release: hire the employees named on this PC: the first install of one built here (this PC's own agents, Manor's
   * staff.local.json), which a release otherwise never does for one that isn't installed. Manor's Hire asks for it.
   */
  hire?: boolean;
  /** round: every employee looked at, whatever has changed (Run now, and `steward round`). */
  full?: boolean;
  /** round: these employees (ids) looked at too, whatever GitHub's glance says: a branch just vouched for with no PR (branchesin.ts). */
  look?: string[];
  /**
   * round: only the staff's pages kept up (tend.ts) and the alarms, nothing asked of GitHub: a scheduled round while
   * Settings say it doesn't merge and release by itself. A round on a PC with no repositories to look after is this too.
   */
  tendOnly?: boolean;
  /**
   * round: the owner's Build now (pipeline.ts): a build begins at once, whatever the build times, for the employees asked
   * about (all when none); ticked, its releases go out to customers at once too.
   */
  buildNow?: BuildNow;
}

export const lastStageFile = () => dataFile('last-stage.json');
export const staffFile = () => dataFile('staff.json');
const kitsPrunedFile = () => dataFile('kits-pruned.json');

export const loadLastStage = () => readJson<StageResult | null>(lastStageFile(), null);
export const loadStaff = () => readJson<Staff | null>(staffFile(), null);

/**
 * One glance at GitHub for every employee (glance.ts), or null, said in the log, when GitHub can't be asked that way.
 * What GitHub says of the account's API budget is kept (budget.ts); when GitHub refuses the account, one line says
 * so and until when nothing is asked of it.
 */
export async function tryGlance(run: Runner, settings: Settings, log: (line: string) => void = () => {}, host?: (e: Employee) => Host, now: () => Date = () => new Date(), ask?: GlanceAsk): Promise<Glance | null> {
  try {
    // The Steward's own runner asks GitHub from its process (no gh for each round); a test's runner, through gh, unless
    // the test gives its own `ask` for GitHub's API.
    const real = run === realRun || ask !== undefined;
    const g = await takeGlance(run, dataDir, settings, host, now, ask ?? (run === realRun && process.env.STEWARD_GLANCE_GH !== '1' ? apiAsk() : undefined));
    if (g.rates?.length || g.cost !== undefined) saveBudget(noteGlance(loadBudget(), g, now()));
    // The branch heads it read, for other agents (Reeve) to skip their own ls-remote of these repositories.
    if (g.heads && real) {
      try {
        shareRemoteHeads(g.heads, { now: now() });
      } catch (e) {
        log(`couldn't share the branch heads it read (${(e as Error).message})`);
      }
    }
    for (const [id, why] of Object.entries(g.errors)) {
      const e = settings.employees.find((x) => x.id === id);
      log(e && host?.(e) === 'git' ? `[${id}] git couldn't read ${e.repo}'s origin (${why}): it is asked on its own` : `[${id}] GitHub said nothing of ${e?.repo ?? id} at a glance (${why}): it is asked on its own`);
    }
    return g;
  } catch (e) {
    if (e instanceof GithubLimited) {
      const s = noteLimited(loadBudget(), { now: now(), secondary: e.secondary, restReset: e.secondary ? null : await restReset(run, dataDir), why: `GitHub refused the account (${e.message})` });
      saveBudget(s);
      log(`GitHub's API limit is reached (${e.message}): nothing is asked of GitHub until ${clock(s.limitedUntil!)}`);
      return null;
    }
    log(`couldn't ask GitHub about everyone at once (${(e as Error).message}): each is asked on its own`);
    return null;
  }
}

/**
 * Whether a round may ask GitHub now (budget.ts): never into the spare tenth of the account's limit, and, unless the
 * person asked for it (Run now), no faster than the hour allows. Null: it may.
 */
export function roundWaits(settings: Settings, ask: StageAsk, now: Date): { until: string; why: string } | null {
  const s = loadBudget();
  const g = gate(s, roundCost(s, settings.employees.length), now, { paced: !ask.full });
  return g.go ? null : { until: g.until, why: g.why };
}

/**
 * Settings with the team as the stages use it (team.ts): Settings' own, or when they name none the account gh is signed
 * in as. With neither, the log says so and the team is nobody: only the Steward's own PRs are merged.
 */
export function withTeam(settings: Settings, log: (line: string) => void, owner?: Owner): Settings {
  if (settings.team.length) return settings;
  const t = teamOf(settings.team, owner);
  if (t.from === 'none') log(`${NO_TEAM}.`);
  return { ...settings, team: t.team };
}

/** The account signed in on each GitLab, Azure DevOps organization, Gitea and Bitbucket, by its address, as last asked (an hour at most). */
const hostAccounts = new Map<string, { login: string | null; at: number }>();

/** Where an account is its own: a GitLab, a Gitea or Bitbucket by its host name, an Azure DevOps organization by its address. */
const accountsAt = (host: Host, repo: string) => (host === 'gitlab' ? whereIs(repo).hostname : host === 'azure' ? (whereAzure(repo)?.base ?? null) : host === 'gitea' ? (whereGitea(repo)?.hostname ?? null) : host === 'bitbucket' ? 'bitbucket.org' : null);

/**
 * Settings whose team names none, with the account glab, az, tea or the Bitbucket token is signed in as on each
 * GitLab, Azure DevOps organization, Gitea and Bitbucket whose repositories are worked with its way (scm.ts): their
 * accounts are their own, so the person and their sessions are the team there too. Asked once an hour; one that can't
 * say adds nobody.
 */
export async function withHostTeams(settings: Settings, o: { run: Runner; neutralDir: string; host: (e: Pick<Employee, 'repo'>) => Host }): Promise<Settings> {
  const team = [...settings.team];
  for (const e of settings.employees) {
    const name = accountsAt(o.host(e), e.repo);
    if (!name) continue;
    let known = hostAccounts.get(name);
    if (!known || Date.now() - known.at > 60 * 60_000) {
      const who = await hostFor(o, e).whoAmI().catch(() => null);
      known = { login: who?.code === 0 ? who.out.trim() || null : null, at: Date.now() };
      hostAccounts.set(name, known);
    }
    if (known.login && !team.some((t) => t.toLowerCase() === known!.login!.toLowerCase())) team.push(known.login);
  }
  return team.length === settings.team.length ? settings : { ...settings, team };
}

/**
 * The stages' context. `team: false` leaves Settings' team as it is, gh unasked: for what never merges (claims).
 * `owner` stands in for the account gh is signed in as (tests).
 */
export async function context(o: { settings?: Settings; run?: Runner; log?: (line: string) => void; glance?: boolean; offline?: boolean; team?: false; owner?: Owner; scm?: ScmLook | null; now?: () => Date } = {}): Promise<Ctx> {
  const run = o.run ?? realRun;
  const log = o.log ?? (() => {});
  mkdirSync(dataDir, { recursive: true });
  const given = o.settings ?? loadSettings();
  // How each repository is worked with (scm.ts), from what this PC has: looked at once an hour. Under node --test, only
  // what a test says (else GitHub's way, as before), so a test never depends on this PC's tools.
  const look = o.scm !== undefined ? o.scm : process.env.NODE_TEST_CONTEXT ? null : await scmNow(realRun);
  const host = (e: Pick<Employee, 'repo'>) => hostOf(e, given, look);
  // The Steward's own repository: Settings', else its clone's origin; none when Settings name neither (it doesn't release itself).
  const own = { ...given, stewardRepo: selfRepoOf(given) };
  // The team is GitHub's: when every repository is worked with plain git, or (with none) the GitHub CLI isn't signed in
  // here, gh isn't asked who it is.
  const noGithub = own.employees.length ? !own.employees.some((e) => host(e) === 'github') : look !== null && !githubReady(look);
  const fromGithub = o.team === false || noGithub ? own : withTeam(own, log, o.owner);
  const settings = o.team === false || given.team.length ? fromGithub : await withHostTeams(fromGithub, { run, neutralDir: dataDir, host });
  // A .NET repository's commands run with Settings' SDK, when they name one (run.ts).
  useDotnet(settings.dotnetRoot ? expandEnv(settings.dotnetRoot) : '');
  const glance = o.glance === false ? null : await tryGlance(run, settings, log, host, o.now);
  // Offline, or with GitHub refusing the account (budget.ts), the kit's releases aren't asked for either: what's known
  // here (its cache, this checkout) is all there is.
  const refused = glance === null && o.glance !== false && !gate(loadBudget(), 0, new Date()).go;
  const kitRun: Runner = o.offline || refused ? async (cmd, args, opts) => (cmd === 'gh' ? { code: 1, out: '', err: 'this PC is offline' } : run(cmd, args, opts)) : run;
  const kit = glance?.stewardReleases ? kitInfoFrom(glance.stewardReleases) : await kitInfo(kitRun, dataDir, settings.stewardRepo);
  return { settings, run, kit, log, neutralDir: dataDir, glance, host };
}

/** The kit's changelog for a PR's body: this checkout's, or the kit release's notes. */
async function changelogFor(ctx: Ctx, kit: string): Promise<string | null> {
  const local = localChangelog(ctx.kit);
  if (local) return local;
  if (!ctx.settings.stewardRepo) return null;
  try {
    const body = JSON.parse(must(await hostFor(ctx).viewRelease(ctx.settings.stewardRepo, `kit-v${kit}`, 'body'))).body as string;
    return body.startsWith('## ') ? body : `## ${kit}\n\n${body}`;
  } catch {
    return null;
  }
}

/** A result that says a release was made (a release stage's, a round's, or a merged PR's step). */
export const releasedSomething = (r: EmployeeResult) => r.outcome === 'done' && /(^|: )released v\d/.test(r.message);

/**
 * The staff's table, refreshed and kept in staff.json: GitHub's side from `glance` (default: the stage's, ctx.glance),
 * else asked employee by employee; each checkout's side from git, fetching only a branch that has moved, and made again
 * only for the employees whose repository, clone or Settings moved since.
 */
export async function refreshStaff(ctx: Ctx, o: { fetch?: boolean; glance?: Glance | null } = {}): Promise<Staff> {
  const c = o.glance === undefined ? ctx : { ...ctx, glance: o.glance };
  const chosen = chooseKit(c.kit);
  // The table it had: a row whose repository, clone and Settings haven't moved stands (staff.ts's rowKey).
  const s = await staff(c, { fetch: o.fetch ?? true, kit: 'version' in chosen ? chosen.version : null, kitNote: 'error' in chosen ? chosen.error : chosen.note, tool: stewardTool(), self: selfForStaff(c), before: loadStaff() });
  writeJson(staffFile(), s);
  try {
    pruneKitsNow(s, c.kit);
  } catch (e) {
    c.log(`couldn't tidy the kits folder: ${(e as Error).message}`);
  }
  return s;
}

/**
 * The Steward's own repository for the staff's table, on the PC that releases it (Settings name it and its clone is
 * here): its GitHub side shown as an employee's is, its kit the one it pins, released when it releases itself.
 */
function selfForStaff(ctx: Ctx): Employee | null {
  const s = ctx.settings;
  if (!s.releasesCastellan || !s.stewardRepo || !s.stewardCheckout || !existsSync(s.stewardCheckout)) return null;
  return { ...stewardEmployee(s, s.stewardCheckout), usesKit: true, merges: s.mergeSelf, release: s.releaseSelf ? 'its own round' : '' };
}

/**
 * After a quiet round: when GitHub says of every employee what it said when the staff's table was made, the table is
 * still right, and is only marked as checked; true then. False when it needs making again. The Steward's own row too,
 * when the glance reads its repository (glance.ts's stewardPrsAsked).
 */
export function markStaffChecked(glance: Glance, employees: Employee[], now = new Date()): boolean {
  const s = loadStaff();
  if (!s?.seen || s.rows.filter((r) => !r.self).length !== employees.length) return false;
  for (const e of employees) {
    const g = glance.repos[e.id];
    if (!g || !s.rows.some((r) => r.id === e.id) || s.seen[e.id] !== repoSig(g)) return false;
  }
  const own = glance.repos[APP.id];
  if (own && s.rows.some((r) => r.self) && s.seen[APP.id] !== repoSig(own)) return false;
  writeJson(staffFile(), { ...s, checked: now.toISOString() });
  return true;
}

/**
 * The kits folder (tools/kit.ts's downloads, for every agent here), once a day: the versions no employee's branch or
 * release pins, nor the Steward's own kit.json, beyond the newest few, let go (upkeep.ts). Never the live folder under
 * node --test.
 */
function pruneKitsNow(s: Staff, kit: KitInfo): void {
  if (process.env.NODE_TEST_CONTEXT && !process.env.STEWARD_KITS) return;
  const last = Date.parse(readJson<{ at?: string }>(kitsPrunedFile(), {}).at ?? '') || 0;
  if (Date.now() - last < 24 * 3600_000) return;
  // An installed Steward without kit.json has none: its kit is in src\kit.
  const pinned = [ownKit(), kit.released[0], ...s.rows.flatMap((r) => [r.main?.kit, typeof r.release?.kit === 'string' && r.release.kit !== 'unknown' ? r.release.kit : null])];
  const removed = pruneKits(kitsDir(), pinned);
  writeJson(kitsPrunedFile(), { at: new Date().toISOString(), removed });
}

export interface StageOptions {
  run?: Runner;
  log?: (line: string) => void;
  /** Stands in for the account gh is signed in as, the team when Settings name none (team.ts); tests only. */
  owner?: Owner;
  kitInfo?: KitInfo;
  alarms?: Parameters<typeof watchAlarms>[1];
  tell?: Poke;
  now?: () => Date;
  /** The kit this Steward carries (default: its own kit.json), which a rollout waits for (stages/rollout.ts). */
  ownKit?: string | null;
  /**
   * The Steward's own releases in a round (stages/self.ts): the checkout they're made from, instead of Settings'. Under
   * node --test they're made only when this is given, so a test never touches the real checkout.
   */
  self?: { checkout: string };
  /** Stands in for the Aletaster for the release gate (tasting.ts); tests only. */
  tasting?: TastingDeps;
  /**
   * Whether this PC is online (the kit's net.ts): a round while it's offline waits, and the alarms leave out what's only
   * the network's. Under node --test, online unless this is given, so a test never looks at the real network.
   */
  online?: () => Promise<boolean>;
  /**
   * Stands in for Manor in the round's look at the staff's pages (tend.ts): its page, its /api/state and its Open. Under
   * node --test the staff are looked at only when this is given, so a test never opens a real agent.
   */
  tend?: { manorUrl?: string; getJson?: GetJson; open?: OpenAgent; startManor?: StartManor; wait?: (ms: number) => Promise<void> };
  /**
   * Stands in for Manor and the agents in the round's look at the updates that stopped (unstick.ts): Manor's page, its
   * updates.json, its log, its install's dry run and its Update, and the agents' rolled-back versions. Under node --test
   * they're looked at only when this is given.
   */
  unstick?: { manorUrl?: string; getJson?: GetJson; readUpdates?: () => ManorUpdates | null; rolledBack?: (id: string) => RolledBack; allow?: AllowAgain; manorLog?: () => string; slots?: () => number | null; dryRun?: DryRun; press?: PressUpdate };
  /** Stands in for what this PC has installed (scm.ts): which repositories are worked with plain git. Tests only. */
  scm?: ScmLook | null;
  /**
   * The turns with this PC's others (lease.ts): who this PC is, the clock and the remotes. Null: no turns. Left out, this
   * PC's own; under node --test there are none unless given.
   */
  turns?: TurnsDeps | null;
  /**
   * Whether a round goes by the build pipeline (pipeline.ts), as the Steward's always do. Under node --test only when
   * this is true, so a test's rounds merge and release what is ready unless it tests the pipeline. Tests only.
   */
  pipeline?: boolean;
}

/** Whether this stage's rounds go by the build pipeline: always, but under node --test only when asked (StageOptions.pipeline). */
const pipelineRounds = (o: StageOptions): boolean => o.pipeline ?? !process.env.NODE_TEST_CONTEXT;

/**
 * Whether this PC has a repository for the Steward to look after: an employee's clone, or its own checkout while Settings
 * say it merges or releases itself. Without one, a round asks GitHub nothing: it keeps the staff's pages up (tend.ts),
 * and raises the alarms.
 */
export function reposHere(settings: Settings, o: Pick<StageOptions, 'self'> = {}): boolean {
  if (settings.employees.some((e) => e.checkout && existsSync(checkoutOf(e)))) return true;
  if (!settings.mergeSelf && !settings.releaseSelf) return false;
  if (process.env.NODE_TEST_CONTEXT && !o.self) return false;
  const checkout = o.self?.checkout ?? settings.stewardCheckout;
  return !!checkout && existsSync(checkout);
}

/** The round's look at the staff's pages (tend.ts), through Manor's page; nothing when Settings switch it off. */
async function tendRound(settings: Settings, o: StageOptions, log: (line: string) => void): Promise<EmployeeResult[]> {
  if (!settings.tend) return [];
  if (process.env.NODE_TEST_CONTEXT && !o.tend) return [];
  const manorUrl = o.tend?.manorUrl ?? agentPages().manor;
  if (!manorUrl) return [];
  return tend({ manorUrl, getJson: o.tend?.getJson ?? getJson, open: o.tend?.open, startManor: o.tend?.startManor, wait: o.tend?.wait, now: o.now, log });
}

/**
 * The round's look at the agent updates that stopped (unstick.ts): a version rolled back by a blip of the PC's allowed
 * again, and an update Manor gave up on pressed once its install would take it. Part of keeping the staff going, so under
 * the same switch as tending.
 */
async function unstickRound(settings: Settings, o: StageOptions, run: Runner, log: (line: string) => void): Promise<EmployeeResult[]> {
  if (!settings.tend) return [];
  if (process.env.NODE_TEST_CONTEXT && !o.unstick) return [];
  const manorUrl = o.unstick?.manorUrl ?? agentPages().manor;
  if (!manorUrl) return [];
  return unstick({ manorUrl, getJson: o.unstick?.getJson ?? getJson, readUpdates: o.unstick?.readUpdates, rolledBack: o.unstick?.rolledBack, allow: o.unstick?.allow, manorLog: o.unstick?.manorLog, slots: o.unstick?.slots, dryRun: o.unstick?.dryRun ?? manorDryRun(run), press: o.unstick?.press, now: o.now, log });
}

/** The Steward's own repository for the merge stage, when Settings say it merges its own PRs and it has a checkout. */
function selfEmployee(ctx: Ctx, o: StageOptions): Employee | null {
  if (!ctx.settings.mergeSelf) return null;
  if (process.env.NODE_TEST_CONTEXT && !o.self) return null;
  const checkout = o.self?.checkout ?? ctx.settings.stewardCheckout;
  if (!ctx.settings.stewardRepo || !checkout) return null;
  return existsSync(checkout) ? stewardEmployee(ctx.settings, checkout) : null;
}

/**
 * The urgent fixes ready between builds (stages/urgent.ts) in the repositories the round asks about: all of them and the
 * Steward's own when it names none. Said in the log; none without a glance at GitHub. Never throws: the round goes on
 * between builds.
 */
async function urgentBetween(ctx: Ctx, o: StageOptions, ask: StageAsk, pipeline: PipelineState, log: (line: string) => void): Promise<UrgentPr[]> {
  if (!ctx.glance) return [];
  try {
    const asked = ask.employees?.length ? ask.employees.map((x) => x.trim().toLowerCase()) : null;
    const self = !asked || asked.includes(APP.id) ? selfEmployee(ctx, o) : null;
    const urgent = await urgentReady(ctx, [...ctx.settings.employees.filter((e) => !asked || asked.includes(e.id)), ...(self ? [self] : [])], boardedUrgent(pipeline));
    if (urgent.length) log(`an urgent fix is ready (${urgent.map((u) => `${u.id} #${u.number}`).join(', ')}): it builds at once, for its repository alone, rather than at the next build time`);
    return urgent;
  } catch (e) {
    log(`couldn't look for an urgent fix: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The turns this stage takes (lease.ts): StageOptions' own, else this PC's, their refs read through GitHub's API where
 * they're on GitHub (githubTurnRefs); none under node --test unless given.
 */
const turnsDeps = (o: StageOptions, run: Runner): TurnsDeps | null => (o.turns !== undefined ? o.turns : process.env.NODE_TEST_CONTEXT ? null : { refs: githubTurnRefs(run) });

/**
 * The turns a merge, release or round takes with this PC's others (lease.ts), before it publishes: on the employees
 * asked about, the repositories refreshed after releases, and the Steward's own while it merges or releases itself.
 * Sets ctx.lease; gives back the employees asked about that are this PC's to publish for, and a line for each that isn't.
 * Only publishing waits on a turn: nothing here stops a build, a test, a tasting or a bump.
 *
 * `more`: a round's second look, once its plan says which employees it looks at (the first took the Steward's own and
 * the refreshed repositories'): those alone, added to the turns it has (joinGuards).
 */
async function takeTurnsFor(ctx: Ctx, o: StageOptions, picked: Employee[], self: Employee | null, more = false): Promise<{ acting: Employee[]; elsewhere: EmployeeResult[]; selfActs: boolean; on: boolean }> {
  const refreshed = more ? [] : ctx.settings.employees.filter((e) => e.refresh && !picked.includes(e));
  const deps = turnsDeps(o, ctx.run);
  const t = await takeTurns([...picked, ...refreshed, ...(self ? [self] : [])], { run: ctx.run, settings: ctx.settings, log: ctx.log, deps });
  ctx.lease = more ? joinGuards(ctx.lease, t.guard) : t.guard;
  const elsewhere = t.elsewhere.filter((r) => picked.some((e) => e.id === r.id) || r.id === self?.id);
  for (const r of elsewhere) ctx.log(`[${r.id}] ${r.message}`);
  // takeTurns keeps one entry per id, so a Steward that is also its own employee comes back as that employee: match by id.
  return { acting: picked.filter((e) => t.acting.includes(e)), elsewhere, selfActs: !self || t.acting.some((e) => e.id === self.id), on: !!deps };
}

/**
 * The repositories whose claims ref this round's turns looked at (reachable, and taking the ref), with that ref's commit
 * then: claims.ts's shareClaims reads each that moved.
 */
async function claimRemotes(ctx: Ctx, o: StageOptions): Promise<{ repo: string; remote: import('./remote-ref.ts').RemoteRepo; sha: string | null }[]> {
  const repos = loadTurns().repos;
  const self = ctx.settings.stewardRepo ? [stewardEmployee(ctx.settings, o.self?.checkout ?? ctx.settings.stewardCheckout)] : [];
  const out: { repo: string; remote: import('./remote-ref.ts').RemoteRepo; sha: string | null }[] = [];
  for (const e of [...ctx.settings.employees, ...self]) {
    const t = repos[e.repo.toLowerCase()];
    if (!t || (t.status !== 'here' && t.status !== 'elsewhere') || t.claimsSha === undefined) continue;
    const remote = await (o.turns?.remote ?? ((x: Employee) => remoteFor(ctx.run, ctx.settings, x)))(e).catch(() => null);
    if (remote) out.push({ repo: e.repo, remote, sha: t.claimsSha });
  }
  return out;
}

/** The Steward's own repository as an employee, for its turn: while Settings say it merges or releases itself, with a checkout. */
function selfForTurns(ctx: Ctx, o: StageOptions, merging: boolean, releasing: boolean): Employee | null {
  if (!(merging && ctx.settings.mergeSelf) && !(releasing && ctx.settings.releaseSelf)) return null;
  if (process.env.NODE_TEST_CONTEXT && !o.self) return null;
  const checkout = o.self?.checkout ?? ctx.settings.stewardCheckout;
  if (!ctx.settings.stewardRepo || !checkout || !existsSync(checkout)) return null;
  return stewardEmployee(ctx.settings, checkout);
}

/** Whether this PC is online: the kit's look, or online under node --test (StageOptions.online). */
export const onlineNow = (): Promise<boolean> => (process.env.NODE_TEST_CONTEXT ? Promise.resolve(true) : kitOnline());

/**
 * The round's look at the Steward's own versions: from its glance at GitHub, else asked on their own; asked on their own
 * too once this round has merged into its main (`moved`), which the glance, from before, doesn't show.
 */
async function selfRound(ctx: Ctx, o: StageOptions, moved = false): Promise<EmployeeResult[]> {
  if (!ctx.settings.releaseSelf) return [];
  if (process.env.NODE_TEST_CONTEXT && !o.self) return [];
  const checkout = o.self?.checkout ?? ctx.settings.stewardCheckout;
  // No repository or clone of its own in Settings: it doesn't release itself.
  if (!ctx.settings.stewardRepo || !checkout) return [];
  try {
    const facts = ctx.glance && !moved ? { main: ctx.glance.stewardMain ?? null, tags: ctx.glance.stewardReleases?.map((r) => r.tagName) ?? null } : await selfFactsAlone(ctx, checkout);
    // Holding its own repository, as an employee's release holds its (stages/slots.ts).
    const out = await withRepo(ctx.log, APP.id, () => releaseSelf(ctx, { checkout, ...facts }));
    // Released: the glance no longer says how its repository is (its row in the staff's table reads it).
    if (ctx.glance && out.some((r) => r.outcome === 'done')) delete ctx.glance.repos[APP.id];
    return out;
  } catch (e) {
    ctx.log(`[steward] its own releases: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The employees' jobs approved now, as a round approves them at its end (stages/jobs.ts: only a script that is exactly
 * the merged one), for Manor to ask right after it installs an update (POST /api/jobs/approve), so a job whose script
 * the update changed doesn't wait up to a round to run. `ids`: only these employees, all that approve jobs when empty.
 * In one of the stages' slots, each repository under its lock (stages/slots.ts); nothing is asked of GitHub but each
 * one's branch, fetched. One line for each it approved.
 */
export async function approveJobsNow(ids: string[], o: { run?: Runner; owner?: Owner; log?: (line: string) => void } = {}): Promise<EmployeeResult[]> {
  const log = o.log ?? (() => {});
  return withStageSlot('jobs', loadSettings().stagesAtOnce, async () => {
    const ctx = await context({ run: o.run, log, glance: false, owner: o.owner });
    const out: EmployeeResult[] = [];
    for (const e of ctx.settings.employees.filter((x) => x.approve && (!ids.length || ids.includes(x.id)))) {
      try {
        const r = await withRepo(log, e.id, () => approveMerged(ctx, e));
        if (r) out.push({ ...r, message: `jobs: ${r.message}` });
      } catch (err) {
        log(`[${e.id}] jobs: ${(err as Error).message}`);
      }
    }
    return out;
  });
}

/**
 * The ready PRs that conflict with their branch, caught up now, beside the rounds (merge.ts's mergeOne, conflictsOnly):
 * a round reaches each repository in turn, one round at a time, and a long one (a vouch's tests, a kit trial) left a PR
 * that conflicted waiting for hours. A glance at GitHub first, in no stage slot: a repository with no ready PR in
 * conflict (conflictsWaiting), or one another stage is working on now (repoBusy), is left alone, and with none left
 * nothing more is done. The rest in a stage slot of its own, "conflicts" (stages/slots.ts; none free: LockTimeout at
 * once, and the next look tries again), each where this PC has its turn (lease.ts), under its lock. Nothing is merged,
 * released or tested: the next round does that. Only while Settings say it merges by itself and catches up, online, and
 * within GitHub's API budget at its pace (budget.ts). `begin`: told when it takes a slot, and the end it returns called
 * once it gives the slot back. One line for each repository whose PRs it caught up, or handed a conflict on in.
 */
export async function conflictsNow(o: StageOptions & { begin?: () => () => void } = {}): Promise<EmployeeResult[]> {
  const log = o.log ?? (() => {});
  if (!stewardActs()) return [];
  const given = loadSettings();
  if (!given.byItself || !given.catchUp || !reposHere(given, o)) return [];
  if (!(await (o.online ?? onlineNow)())) return [];
  const b = loadBudget();
  if (!gate(b, b.glanceCost ?? given.employees.length + 1, o.now?.() ?? new Date(), { paced: true }).go) return [];
  const ctx = await context({ settings: given, run: o.run, log, owner: o.owner, scm: o.scm, now: o.now });
  if (!ctx.glance) return [];
  const self = selfEmployee(ctx, o);
  const waiting = [...ctx.settings.employees, ...(self ? [self] : [])].filter((e) => !repoBusy(e.id) && conflictsWaiting(ctx, e).length);
  if (!waiting.length) return [];
  return withStageSlot(
    'conflicts',
    ctx.settings.stagesAtOnce,
    async () => {
      const end = o.begin?.();
      try {
        const t = await takeTurns(waiting, { run: ctx.run, settings: ctx.settings, log: ctx.log, deps: turnsDeps(o, ctx.run) });
        ctx.lease = t.guard;
        const out: EmployeeResult[] = [];
        // takeTurns keeps one entry per id: matched by id, as the Steward may be its own employee.
        for (const e of waiting.filter((x) => t.acting.some((a) => a.id === x.id))) {
          // Taken by another stage since the glance: left to it.
          if (repoBusy(e.id)) continue;
          try {
            const { merged: _m, held: _h, did: _d, waits: _w, lookAgain: _l, ...r } = await withRepo(log, e.id, () => mergeOne(ctx, e, { yes: true, team: true, conflictsOnly: true }));
            if (r.message !== NO_CONFLICTS) out.push(r);
          } catch (err) {
            log(`[${e.id}] ${(err as Error).message}`);
          }
        }
        // Caught up: Manor's version queues and the staff's table say so now, not at the next round.
        if (out.some((r) => r.outcome === 'done') && !process.env.NODE_TEST_CONTEXT) {
          try {
            await keepVersionQueues(ctx);
            await refreshStaff(ctx, { fetch: true });
          } catch (err) {
            log(`couldn't keep the version queues and the staff's table: ${(err as Error).message}`);
          }
        }
        return out;
      } finally {
        end?.();
      }
    },
    { waitMs: 0 },
  );
}

/** Runs a stage in one of the stages' slots (stages/slots.ts), records it, and refreshes the staff's table; a round only when it did something. */
export async function runStage(name: Exclude<StageName, 'staff'>, ask: StageAsk, o: StageOptions = {}): Promise<StageResult> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    o.log?.(line);
  };
  // A developer's work: off the maker's laptop, nothing runs while Developer options are off (maker.ts), and nothing is kept.
  if (!stewardActs()) {
    const at = new Date().toISOString();
    log(DEVELOPER_ONLY);
    return { stage: name, started: at, finished: at, kit: null, asked: { ...ask }, results: [], log: lines, error: DEVELOPER_ONLY };
  }
  return withStageSlot(
    name,
    loadSettings().stagesAtOnce,
    async () => {
      // With no repositories to look after here, or Settings saying it doesn't merge and release by itself, a round
      // asks GitHub nothing (no glance, no team): it keeps the staff's pages up, and the alarms look.
      const given = loadSettings();
      const tendOnly = name === 'round' && (!!ask.tendOnly || !reposHere(given, o));
      // Offline (the kit's net.ts), a round asks nothing of GitHub: it would only fail for every employee, every
      // few minutes, and the person knows the PC is offline. It waits for the network; the alarms still look.
      const offline = name === 'round' && !tendOnly && !(await (o.online ?? onlineNow)());
      const at = () => o.now?.() ?? new Date();
      // GitHub's API budget (budget.ts): a round that would spend the account's spare tenth, or more than the hour so far
      // allows, waits, asking GitHub nothing; the alarms still look.
      let budget = name === 'round' && !tendOnly && !offline ? roundWaits(given, ask, at()) : null;
      let quiet = offline || tendOnly || !!budget;
      const ctx = await context({ settings: given, run: o.run, log, glance: quiet ? false : undefined, offline: quiet, owner: o.owner, team: tendOnly ? false : undefined, scm: o.scm, now: o.now });
      // GitHub refused the glance itself: the round waits too, rather than asking of every repository on its own.
      if (name === 'round' && !quiet && !ctx.glance) {
        const g = gate(loadBudget(), 0, at());
        if (!g.go) {
          budget = { until: g.until, why: g.why };
          quiet = true;
        }
      }
      if (o.kitInfo) ctx.kit = o.kitInfo;
      if (o.tasting) ctx.tasting = o.tasting;
      if (o.online) ctx.online = o.online;
      // When each PR went ready, as the rounds see it: a build stacks its PRs in that order (stages/build.ts).
      if (name === 'round' && ctx.glance) {
        try {
          noteReady(ctx.glance, at());
        } catch (e) {
          log(`couldn't keep when PRs went ready: ${(e as Error).message}`);
        }
      }
      const started = new Date().toISOString();
      const out: StageResult = { stage: name, started, finished: started, kit: null, asked: { ...ask }, results: [], log: lines };
      let held: { employee: Employee; prs: Held[] }[] = [];
      // A round looks only at the employees with something new on GitHub since the last (stages/changes.ts).
      const seen = name === 'round' ? loadSeen() : null;
      let plan: RoundPlan | null = null;
      /** Those a rollout beside the rounds is bumping now, which this round leaves to it (stages/rollout.ts). */
      let bumping: Employee[] = [];
      const own = o.ownKit !== undefined ? o.ownKit : ownKit();
      /** A new kit that waits for this Steward to carry it (stages/rollout.ts), for the alarms. */
      let rolloutWaits: { kit: string; own: string } | null = null;
      /** Whether this round took turns (lease.ts): then each repository's shared claims are looked at too. */
      let turnsOn = false;
      // The build pipeline (pipeline.ts): between builds a round only looks; a build's rounds merge, and its last releases.
      const pipeline = name === 'round' && !quiet && pipelineRounds(o) ? loadPipeline() : null;
      const planned: PipelineMode = pipeline ? pipelineMode(ctx.settings.buildPipeline, pipeline, at(), { buildNow: ask.buildNow, employees: ask.employees }) : { kind: 'outside' };
      // An urgent fix between builds (stages/urgent.ts): a build of its own for its repository, at once.
      const urgent = pipeline && planned.kind === 'between' ? await urgentBetween(ctx, o, ask, pipeline, log) : [];
      const mode: PipelineMode = pipeline && urgent.length ? pipelineMode(ctx.settings.buildPipeline, pipeline, at(), { urgent }) : planned;
      /** This round ends its build: it released what the build merged. */
      let buildCloses = false;
      /** "<id> #<n>" for each PR this round merged, for the build's record. */
      const mergedHere: string[] = [];
      try {
        // The owner's Build now, or an urgent fix's build, for some repositories: each of its rounds looks at those alone.
        const only = ask.employees?.length ? ask.employees : mode.kind === 'build' ? (mode.run.employees ?? null) : null;
        // A merge or round with the Steward's own repository among them (an urgent fix of its own), or with no repository
        // named: it merges and releases its own too.
        const isSelf = (id: string) => (name === 'merge' || name === 'round') && id.trim().toLowerCase() === APP.id;
        const withSelf = !only?.length || only.some(isSelf);
        const agents = only?.filter((id) => !isSelf(id)) ?? null;
        const picked = only?.length && !agents?.length ? { employees: [] as Employee[] } : pick(ctx.settings.employees, agents);
        if ('error' in picked) throw new Error(picked.error);
        if (tendOnly) {
          out.tendOnly = true;
          log(
            ask.tendOnly
              ? "Settings say it doesn't merge and release by itself: the round keeps the staff's pages up, and asks GitHub nothing"
              : "no repositories to look after on this PC (no employee's clone here, and no checkout of its own): the round keeps the staff's pages up, and asks GitHub nothing",
          );
        } else if (offline) {
          out.offline = true;
          log('this PC is offline, so the round waits for the network: nothing is asked of GitHub until it is back');
        } else if (budget) {
          out.budget = budget;
          log(waitLine(budget));
        } else if (mode.kind === 'between') {
          // Between builds: nothing merged, caught up, rolled out or released. The PRs that waited at the last look
          // still wait, so the alarms go on counting their hours.
          out.build = { between: true, next: mode.next?.toISOString() ?? null };
          log(mode.line);
          held.push(...heldBefore(seen!, picked.employees));
          // The next build's tests, run now beside the rounds for what moved (stages/prepare.ts): the build then only merges.
          if (name === 'round' && mode.next && !only?.length) {
            const prepLine = prepareBeside(ctx, { next: mode.next, employees: picked.employees, self: selfEmployee(ctx, o), kit: latestKit(ctx.kit) });
            if (prepLine) log(prepLine);
          }
        } else if (name === 'merge' || name === 'round') {
          if (mode.kind === 'build') {
            const when =
              mode.run.by === 'owner'
                ? "the owner's Build now"
                : mode.run.by === 'urgent'
                  ? `the urgent fix's build (${(mode.run.urgent ?? []).map((k) => k.split(' ').slice(0, 2).join(' ')).join(', ')})`
                  : `the ${buildWhen(new Date(mode.run.due), at())} build`;
            log(
              mode.fresh
                ? `${when} begins${mode.run.employees?.length ? ` for ${mode.run.employees.join(', ')}` : ''}: every ready PR merged, tested once with the others, and released once it has all settled`
                : mode.closing
                  ? `${when} has run out of time (${ctx.settings.buildPipeline.windowMinutes} minutes): it releases what it merged, and the rest waits for the next build`
                  : `${when} goes on (its round ${mode.run.rounds + 1})`,
            );
            // In a build, a ready PR merges at once: the build time was the time to push to it (merge.ts' ageHold). And
            // nothing is released merge by merge: the build releases each repository once, when it closes.
            ctx.settings = { ...ctx.settings, mergeMinAgeMinutes: 0, releaseAfterMerge: false };
            // Each repository's ready PRs stacked as one batch, in the order they went ready (stages/build.ts).
            ctx.build = { due: mode.run.due, name: when };
            out.build = { due: mode.run.due, by: mode.run.by, round: mode.run.rounds + 1 };
          }
          // A round is merge --yes --team, then a release for every version not yet released (stages/round.ts).
          const round = name === 'round';
          const yes = round || !!ask.yes;
          // Turns with this PC's others first (lease.ts): a repository another PC has its turn in is left to it. A round
          // takes the Steward's own and the refreshed repositories' now, and the employees' once its plan says which it
          // looks at (below): it publishes nothing to the rest.
          const turns = await takeTurnsFor(ctx, o, round ? [] : picked.employees, selfForTurns(ctx, o, (round || !!ask.team) && withSelf, round && withSelf));
          turnsOn = turns.on;
          let elsewhere = turns.elsewhere;
          // The team's PRs to the Steward's own repository, as an employee's (stages/selfmerge.ts), first: its kit's PRs at
          // the head of its line (merge.ts), and the new kit released at once (selfRound), so the agents' PRs that take
          // that kit are tested after it is there, in this round. Not in a stage asked about others alone.
          const self = (round || ask.team) && withSelf && turns.selfActs ? selfEmployee(ctx, o) : null;
          /** The Steward's own: its team's PRs merged, its new versions released, and a new kit's releases read again. */
          const selfPart = async (): Promise<{ line: EmployeeResult | null; releases: EmployeeResult[] }> => {
            let line: EmployeeResult | null = null;
            let moved = false;
            if (self) {
              const [r] = await merge(ctx, [self], { yes, team: true });
              const { merged: selfMerged, held: prs, ...rest } = r;
              line = rest;
              if (prs.length) held.push({ employee: self, prs });
              moved = selfMerged.length > 0;
              mergedHere.push(...selfMerged.map((p) => `${APP.id} #${p.number}`));
            }
            // The Steward's own new versions, apart from the employees' (stages/self.ts); not in a round asked about others alone.
            const releases = round && withSelf && turns.selfActs ? await timed(phaseOf(ctx), 'releases', APP.id, () => selfRound(ctx, o, moved), (r) => r.some((x) => x.outcome === 'done' || x.outcome === 'failed')) : [];
            // Its turn another PC's now (lease.ts): a whole suite beside the rounds here is that PC's to run, and is stopped.
            if (round && withSelf && !turns.selfActs) await settleWholeSuite(ctx, null, "the Steward's own turn is another PC's now");
            if (releases.some((r) => r.outcome === 'done' && /\bkit-v\d/.test(r.message))) {
              // A new kit: the kit's releases read again, and every employee looked at, since a new kit is new for each (changes.ts):
              // a PR whose checks failed at its kit's fill, or that waited for its kit's release, is tried again now.
              try {
                ctx.kit = await kitInfo(ctx.run, ctx.neutralDir, ctx.settings.stewardRepo);
                log(`kit ${latestKit(ctx.kit)} released: every employee's PRs looked at again with it`);
              } catch (err) {
                log(`couldn't read the kit's releases again: ${(err as Error).message}`);
              }
            }
            return { line, releases };
          };
          // In a build, the employees' merges go beside the Steward's own (Steward 0.36.69), which may test its PRs pushed
          // since the build was prepared, ten minutes a run, a failing one twice: on 2026-10-16 the 08:00 build's 34 kit
          // PRs, open at 13:44, merged at 14:44, once a round had tested #291 twice. The Steward's own goes apart
          // (slots.ts), holding its own repository only, and the round waits for both before what hangs on it: the
          // rollout, which waits for a kit coming in this build (buildkit.ts) or takes the one just released, and the
          // build's release. Out of a build, the Steward's own first, as before.
          const selfBeside = mode.kind === 'build' && !!self;
          // On the Steward's page, its PRs moved since they were tested for this build are tested beside the rounds
          // instead (stages/selftests.ts, Steward 0.36.71), and the round doesn't wait for them: it, and those after it
          // until they end, leave the Steward's own repository alone, its merges and releases, and its ready PRs wait.
          // Once they end, a round merges what passed (agent.ts).
          const testing = selfBeside && round && self ? await selfTestBeside(ctx, self, { kit: latestKit(ctx.kit) }) : null;
          if (testing) {
            log(`[${APP.id}] ${testing.line.message}`);
            if (testing.held.length) held.push({ employee: self!, prs: testing.held });
          }
          const kitBefore = latestKit(ctx.kit);
          let selfLine: EmployeeResult | null = null;
          let selfReleases: EmployeeResult[] = [];
          if (!selfBeside) ({ line: selfLine, releases: selfReleases } = await selfPart());
          let employees = turns.acting;
          if (round) {
            // A build's first round looks at every repository: the PRs that waited since the last build board now,
            // whether or not GitHub says anything new of them.
            plan = planRound({ employees: picked.employees, glance: ctx.glance, seen: seen!, settings: ctx.settings, force: !!ask.full || (mode.kind === 'build' && mode.fresh), look: ask.look ?? [], now: o.now?.(), kit: { newest: latestKit(ctx.kit), own } });
            // Those another PC has its turn in are left to it, and not kept as seen (afterRound): looked at again next round.
            const looked = await takeTurnsFor(ctx, o, plan.look, null, true);
            plan = { ...plan, look: looked.acting };
            elsewhere = looked.elsewhere;
            if (plan.quiet.length) log(`nothing new on GitHub since the last round for ${plan.quiet.map((e) => e.name).join(', ')}: not looked at again`);
            // Those a rollout beside the rounds is bumping or pushing now (stages/rollout.ts): left to it, rather than this
            // round waiting for that bump's checks, and looked at again next round (kept as they were seen before).
            bumping = plan.look.filter((e) => heldBy(e.id) === 'rollout');
            if (bumping.length) {
              log(`${bumping.map((e) => e.name).join(', ')}: the kit's rollout beside the rounds is bumping ${bumping.length === 1 ? 'it' : 'them'} now, so ${bumping.length === 1 ? 'it is' : 'they are'} looked at next round`);
              plan = { ...plan, look: plan.look.filter((e) => !bumping.includes(e)), quiet: [...plan.quiet, ...bumping] };
            }
            employees = plan.look;
          }
          const theirs = (who: Employee[]) => merge(ctx, who, { yes, team: round || !!ask.team });
          let merged: MergeLook[];
          if (selfBeside) {
            // Both at once, and neither one's failure thrown before the other has ended.
            const [mine, others] = await Promise.allSettled([testing ? Promise.resolve({ line: testing.line, releases: [] }) : apart('self merge', selfPart), theirs(employees)]);
            if (mine.status === 'rejected') throw mine.reason;
            if (others.status === 'rejected') throw others.reason;
            ({ line: selfLine, releases: selfReleases } = mine.value);
            merged = others.value;
            // A kit released beside them: what a round that released it first would have looked at with it, looked at now
            // (changes.ts): those it makes new that this round's plan left out, so the rollout below takes it to them all
            // at once; and those whose PRs waited for its release (prtest.ts), so they merge in this round.
            const kitNow = latestKit(ctx.kit);
            const first = plan;
            if (round && first && kitNow !== kitBefore) {
              const withKit = planRound({ employees: picked.employees, glance: ctx.glance, seen: seen!, settings: ctx.settings, look: ask.look ?? [], now: o.now?.(), kit: { newest: kitNow, own } });
              const more = await takeTurnsFor(ctx, o, withKit.look.filter((e) => !first.look.includes(e) && heldBy(e.id) !== 'rollout'), null, true);
              elsewhere = [...elsewhere, ...more.elsewhere];
              const waited = employees.filter((e) => merged.some((r) => r.id === e.id && r.held.some((h) => waitsForKit(h.why))));
              if (waited.length || more.acting.length) {
                log(`kit ${kitNow} released beside the employees' merges: ${[...waited, ...more.acting].map((e) => e.name).join(', ')} looked at with it now`);
                const again = await theirs([...waited, ...more.acting]);
                merged = [...merged.map((r) => joinLooks([r, ...again.filter((a) => a.id === r.id)])), ...again.filter((a) => !merged.some((r) => r.id === a.id))];
              }
              // Those looked at first keep the kit before as what they were looked at with: the next round looks again.
              plan = { ...first, look: [...first.look, ...more.acting], quiet: first.quiet.filter((e) => !more.acting.includes(e)), sigs: { ...first.sigs, ...Object.fromEntries(more.acting.flatMap((e) => (withKit.sigs[e.id] ? [[e.id, withKit.sigs[e.id]]] : []))) } };
              employees = plan.look;
            }
          } else merged = await theirs(employees);
          mergedHere.push(...merged.flatMap((r) => r.merged.map((p) => `${r.id} #${p.number}`)));
          // And what a rollout beside the rounds did since the last round reported it (stages/rollout.ts): this round's to tell.
          out.results = [...elsewhere, ...merged.map(({ merged: _m, held: _h, ...r }) => r), ...(selfLine ? [selfLine] : []), ...(round ? takeRolloutResults() : [])];
          held.push(
            ...merged.flatMap((r) => {
              const employee = employees.find((e) => e.id === r.id);
              return employee && r.held.length ? [{ employee, prs: r.held }] : [];
            }),
          );
          // Those not looked at still have the PRs that waited when they last were: the alarms go on counting their hours.
          if (plan) held.push(...heldBefore(seen!, plan.quiet));
          // A PR that waits only on something settling within minutes: the next round comes sooner (agent.ts).
          const brief = held.flatMap((h) => h.prs.filter((p) => !p.draft && waitsBriefly(p.why)).map((p) => `${h.employee.name} #${p.number}`));
          // Not for a Steward PR tested beside the rounds alone: a round comes once its tests end (agent.ts).
          const sooner = held.flatMap((h) => h.prs.filter((p) => !p.draft && waitsBriefly(p.why) && !p.why.startsWith(TESTED_BESIDE)).map((p) => `${h.employee.name} #${p.number}`));
          if (round && sooner.length) {
            out.soon = true;
            log(`the next round comes sooner: ${sooner.join(', ')} ${sooner.length === 1 ? 'waits' : 'wait'} only on checks running, a head just caught up, GitHub working out whether it merges, or being just opened`);
          }
          const done = merged.filter((r) => r.merged.length).map((r) => r.id);
          if (yes && done.length) {
            // A release when Settings say so, at the kit the Steward hands out; and whatever each merged PR asks for.
            let releaseKit: string | null = null;
            const releaseAny = ctx.settings.releaseAfterMerge && !ctx.settings.releasesCastellan;
            if (releaseAny) log(`release after merge (Settings): ${done.join(', ')}`);
            else if (ctx.settings.releaseAfterMerge) {
              const chosen = chooseKit(ctx.kit, ask.kit);
              if ('error' in chosen) log(`release after merge: ${chosen.error}`);
              else {
                log(`release after merge (Settings): ${done.join(', ')}`);
                out.kit = chosen.version;
                releaseKit = chosen.version;
              }
            }
            out.results.push(...(await afterMerge(ctx, picked.employees, merged, { releaseKit, releaseAny })));
          }
          if (round) {
            const releaseNow = async (who: Employee[]) => {
              const releasedNow = new Set(out.results.filter((r) => r.message.startsWith('release: ')).map((r) => r.id));
              const released = await releaseUnreleased(ctx, who.filter((e) => !releasedNow.has(e.id)));
              out.results.push(...released.map((r) => ({ ...r, message: `release: ${r.message}` })));
            };
            // A new kit, rolled out to each employee looked at that is behind it (stages/rollout.ts): bumped and pushed now,
            // merged and released by the next round, which comes sooner for them (their checks passed here, and a kit PR
            // of the Steward's doesn't wait to be old enough: merge.ts's ageHold). The kit PRs opened, if any. On the
            // Steward's page the bumps run beside the rounds instead (`beside`): this round goes on at once, and those
            // after it merge meanwhile; a round comes as soon as they end, to merge their PRs (agent.ts).
            const rollOut = async (): Promise<{ opened: EmployeeResult[]; beside: boolean }> => {
              const newest = latestKit(ctx.kit);
              try {
                const rolled = await rollout(ctx, employees, { kit: newest, ownKit: own, changelog: (k) => changelogFor(ctx, k) });
                out.results.push(...rolled.results);
                if (rolled.plan.waitsForSteward && newest && own) rolloutWaits = { kit: newest, own };
                const opened = rolled.results.filter((r) => r.outcome === 'done');
                if (opened.length && !out.soon) {
                  out.soon = true;
                  log(`the next round comes sooner: kit ${rolled.plan.kit ?? newest}'s PRs for ${opened.map((r) => r.name).join(', ')} merge${mode.kind === 'build' ? ' in this build' : ' and release'} then`);
                }
                return { opened, beside: !!rolled.beside };
              } catch (err) {
                log(`rollout: ${(err as Error).message}`);
                return { opened: [], beside: false };
              }
            };
            if (mode.kind === 'build') {
              // A build: the kit's PRs opened first, so they merge in this build too; then, once nothing is left that
              // settles within minutes (checks running, a kit's trial, kit PRs just opened, a rollout beside the rounds),
              // every repository's new version released at once, the one release of this build. Or when the build's time
              // has run out.
              // A newer kit coming in this build (stages/buildkit.ts): the rollout waits for it, and the build stays open
              // meanwhile, rather than sending every agent the kit before it to be bumped again at the next build.
              const coming = kitComing({ selfHeld: self ? (held.find((h) => h.employee.id === self.id)?.prs ?? []) : [], selfReleases });
              const rolled: { opened: EmployeeResult[]; beside: boolean; waits?: string } = !kitRides(ctx.settings.buildPipeline, pipeline!, mode.run)
                ? (log(mode.run.by === 'urgent' ? 'the newest kit waits for the next build: this one is for an urgent fix' : "the newest kit waits for the day's first build (Settings: Build pipeline)"), { opened: [], beside: false })
                : coming
                  ? (log(`rollout: waits for ${coming}${mode.closing ? ', which the next build rolls out' : ''}`), { opened: [], beside: false, waits: coming })
                  : await rollOut();
              const opened = rolled.opened;
              buildCloses = mode.closing || (!brief.length && !opened.length && !rolled.beside && !rolled.waits);
              if (buildCloses) {
                // The build's one release is every repository of the build's, looked at this round or not: their turns
                // taken first, as this round took only those it looked at (above).
                const all = await takeTurnsFor(ctx, o, picked.employees, null, true);
                await timed(phaseOf(ctx), 'releases', null, () => releaseNow(all.acting));
              }
              else {
                // A rollout beside the rounds alone: no round sooner, as the one after it comes once it ends (agent.ts).
                // Nor a kit whose whole suite runs beside them: a round comes once it ends (wholesuite.ts). Nor the Steward's
                // PRs tested beside them (selftests.ts), likewise.
                if (sooner.length || opened.length) out.soon = true;
                log(`the build releases once it has settled${brief.length ? `: ${brief.join(', ')} ${brief.length === 1 ? 'waits' : 'wait'} on something brief` : !opened.length && rolled.beside ? ": the kit's rollout goes on beside the rounds" : rolled.waits ? `: ${rolled.waits}` : ''}`);
              }
              out.results.push(...selfReleases);
            } else {
              await releaseNow(employees);
              // The Steward's own, released before the agents' merges (above).
              out.results.push(...selfReleases);
              await rollOut();
            }
            // Then each employee's jobs whose installed script is the merged one, approved, so an update never leaves them waiting.
            // Not one a rollout beside the rounds is bumping now: the next round approves its jobs, rather than this one waiting.
            for (const e of picked.employees.filter((x) => heldBy(x.id) !== 'rollout')) {
              let r: EmployeeResult | null;
              try {
                r = await withRepo(log, e.id, () => approveMerged(ctx, e));
              } catch (err) {
                log(`[${e.id}] jobs: ${(err as Error).message}`);
                r = null;
              }
              if (r) out.results.push({ ...r, message: `jobs: ${r.message}` });
            }
            if (plan) out.results.push(...plan.quiet.map((e) => result(e, 'skipped', bumping.includes(e) ? "the kit's rollout beside the rounds is bumping it now: looked at next round" : 'nothing new on GitHub since the last round')));
          }
        } else if (name === 'release' && ask.hire) {
          // A hire: the agents named, installed here from their clones, whatever kit is being rolled out, on this PC's own
          // account (no turns with the licence's other PCs: an install is this PC's).
          if (!ask.employees?.length) throw new Error('a hire names the agents to install: release --employees <id> --hire');
          out.results = await release(ctx, picked.employees, { kit: null, hire: true });
        } else if (!ctx.settings.releasesCastellan) {
          // Not the PC that releases Castellan: there is no kit to hand out. Release takes each repository's own version.
          if (name !== 'release') throw new Error(`${name} rolls Castellan's kit out, which only its makers' PC does${makersPc() ? ' ("Releases Castellan itself" in Settings)' : ''}`);
          const turns = await takeTurnsFor(ctx, o, picked.employees, null);
          out.results = [...turns.elsewhere, ...(await release(ctx, turns.acting, { kit: null }))];
        } else {
          const chosen = chooseKit(ctx.kit, ask.kit);
          if ('error' in chosen) throw new Error(chosen.error);
          out.kit = chosen.version;
          if (chosen.note) log(`kit ${chosen.version}: ${chosen.note}`);
          if (name === 'bump') {
            if (!ctx.kit.released.includes(chosen.version) && !ask.kitFrom) {
              throw new Error(`kit ${chosen.version} has no release kit-v${chosen.version}, so the employees couldn't fetch it: publish it first (npm run kit-release -- --publish in the Steward's checkout), or try it with --kit-from <kit folder>`);
            }
            // A person's Bump lets the rounds try these again, whatever failed before (stages/rollout.ts).
            clearRolloutHolds(picked.employees.map((e) => e.id));
            out.results = await bump(ctx, picked.employees, { kit: chosen.version, base: ask.base, kitFrom: ask.kitFrom, changelog: await changelogFor(ctx, chosen.version) });
          } else if (name === 'push') {
            clearRolloutHolds(picked.employees.map((e) => e.id));
            // A push publishes: only where this PC has the turn (lease.ts). The bumps stay prepared here either way.
            const turns = await takeTurnsFor(ctx, o, picked.employees, null);
            out.results = [...turns.elsewhere, ...(await push(ctx, turns.acting, { kit: chosen.version, changelog: await changelogFor(ctx, chosen.version) }))];
          } else {
            const turns = await takeTurnsFor(ctx, o, picked.employees, null);
            out.results = [...turns.elsewhere, ...(await release(ctx, turns.acting, { kit: chosen.version }))];
          }
        }
      } catch (e) {
        out.error = (e as Error).message;
        log(`${name}: ${out.error}`);
      }
      // The build's record (pipeline.json): what this round merged, released and failed; ended when it closed, or when its
      // time ran out whatever happened. The owner's Build now with "to customers" lets each release out at once.
      let buildReleased: string[] = [];
      if (pipeline && mode.kind === 'build') {
        const closed = buildCloses || mode.closing;
        buildReleased = out.results.filter(releasedSomething).map((r) => `${r.id} ${/released (v[\d.]+[^\s,;]*)/.exec(r.message)?.[1] ?? '?'}`);
        if (closed && mode.run.toCustomers) {
          for (const line of [...mode.run.released, ...buildReleased]) {
            const [id, v] = line.split(' ');
            if (!v?.startsWith('v')) continue;
            const freed = await letOut(id, v.slice(1), ctx.exchequer);
            log(freed.ok ? `${id} ${v} let out to customers now (the owner's Build now)` : freed.line);
          }
        }
        try {
          savePipeline(
            endRound(pipeline, mode.run, {
              merged: mergedHere,
              released: buildReleased,
              failed: out.results.filter((r) => r.outcome === 'failed').map((r) => `${r.id}: ${r.message}`),
              closed,
              cut: mode.closing,
              now: at(),
            }),
          );
        } catch (e) {
          log(`couldn't keep the build's record: ${(e as Error).message}`);
        }
        if (closed) {
          const all = mode.run.merged.length + mergedHere.length;
          const rel = mode.run.released.length + buildReleased.length;
          log(`the build ends: ${all} PR${all === 1 ? '' : 's'} merged, ${rel} release${rel === 1 ? '' : 's'}`);
        }
        out.build = { ...out.build, closed };
      }
      // Something released: each repository with a refresh after releases runs it, and pushes what it changed once its
      // tests pass (stages/refresh.ts). A stage that released nothing runs none, unless releases wait for one. While the
      // next round comes sooner (a rollout's PRs merge and release then), this round's releases wait for it: one refresh
      // after them all (refreshStep), never more than an hour late.
      const releasedNow = out.results.filter(releasedSomething);
      const pending = quiet ? null : loadRefreshPending();
      if ((releasedNow.length || pending) && !quiet) {
        try {
          const step = refreshStep({ released: releasedNow, pending, soon: name === 'round' && !!out.soon, now: Date.now() });
          if ('wait' in step) {
            writeJson(refreshPendingFile(), step.wait);
            log(`refresh: after the next round, which comes sooner (${releasedWords(step.wait.released)} so far)`);
          } else {
            if (pending) rmSync(refreshPendingFile(), { force: true });
            if (step.run.length) out.results.push(...(await refreshAfterReleases(ctx, step.run)));
          }
        } catch (e) {
          log(`refresh: ${(e as Error).message}`);
        }
      }
      // Every round, offline or not, with repositories or none: the agents on duty whose pages don't answer, opened again.
      if (name === 'round') {
        try {
          out.results.push(...(await tendRound(ctx.settings, o, log)));
        } catch (e) {
          log(`tend: ${(e as Error).message}`);
        }
        // And the agent updates Manor gave up on, settled once their install would take them.
        try {
          out.results.push(...(await unstickRound(ctx.settings, o, ctx.run, log)));
        } catch (e) {
          log(`unstick: ${(e as Error).message}`);
        }
      }
      out.finished = new Date().toISOString();
      // Claimed versions whose work landed, or went stale with no PR, are given back (claims.ts).
      if (name === 'round') {
        try {
          await pruneClaims(loadStaff()?.rows ?? []);
          // With turns, each repository's claims ref too: every PC's claims copied here, this PC's own shared.
          if (turnsOn) await shareClaims(ctx.run, loadStaff()?.rows ?? [], await claimRemotes(ctx, o));
        } catch (e) {
          log(`claims: ${(e as Error).message}`);
        }
      }
      // Each repository's version queue, for Manor (version-queue.ts): after the merges, so it says where each one is now,
      // and what holds each (the PRs the merge stage held, and why), before the alarms, which raise one held an hour.
      // Not in a test, which has no Manor and no projects of its own.
      // Not in a round that asked GitHub nothing: without a glance, each repository's PRs would be asked of on its own.
      if ((name === 'round' || name === 'merge') && !out.error && !quiet && !process.env.NODE_TEST_CONTEXT) {
        try {
          // Those the stage did something for (or failed partway) moved since its glance: their clones are fetched.
          const queues = await keepVersionQueues(ctx, { moved: out.results.filter((r) => r.outcome === 'done' || r.outcome === 'failed').map((r) => r.id), held, self: selfEmployee(ctx, o) });
          // The drafts coming up in them, told early so they're ready before their turn (heads-up.ts).
          for (const line of await headsUp(ctx, queues.upcoming ?? [], { bailiffUrl: agentPages().bailiff })) log(line);
        } catch (e) {
          log(`couldn't keep the version queues: ${(e as Error).message}`);
        }
      }
      // After every round, done or not: what needs the person (alarms.ts).
      if (name === 'round') {
        try {
          const failedReleases = readJson<Record<string, string>>(roundFailuresFile(), {});
          // Merged or released by something that isn't this Steward (strangers.ts): looked for only in a round that asked GitHub.
          const strangers = await lookForStrangers({ ctx, glance: quiet || out.error ? null : ctx.glance, alarms: loadAlarms(), now: o.now?.() });
          // Every agent's port (ports.ts): two agents on one is an alarm before either is installed. Not in a test,
          // which has no Manor of its own to read, and only on the PC Castellan is made on: its agents' ports are its makers'.
          const ports = process.env.NODE_TEST_CONTEXT || !makersPc() ? undefined : await portUses(ctx.run, ctx.settings.employees).catch(() => undefined);
          await watchAlarms({ settings: ctx.settings, round: out, held, failedReleases, strangers, ports, failedRollouts: loadRolloutFailures(), failedSelf: loadSelfFailures(), rolloutWaits, buildLeft: loadBuildLeft(), tastingHolds: loadTastingHolds(), signingWaits: loadSigningWaits(), tending: ctx.settings.tend ? loadTending() : null, unstick: ctx.settings.tend ? loadUnstick() : null, unsafe: loadUnsafe(), migrated: pendingMigration(settingsFile()), failedRefreshes: loadRefreshFailures(), installHolds: loadInstallHolds(), queueHolds: heldQueues(loadVersionQueues(), loadTurns(), loadClaims()), employees: ctx.settings.employees, log, run: ctx.run, neutralDir: ctx.neutralDir }, { online: o.online ?? onlineNow, ...o.alarms });
        } catch (e) {
          log(`alarms: ${(e as Error).message}`);
        }
      }
      // What the next round needs to tell what's new.
      if (plan && seen) {
        try {
          saveSeen(afterRound(seen, { plan, results: out.results, held, error: out.error, now: o.now?.() }));
        } catch (e) {
          log(`couldn't keep what this round saw: ${(e as Error).message}`);
        }
      }
      // Something released: the pages that want to know are told (Manor installs it within minutes; the Aletaster tastes it).
      // In a build, once: when it ends, for everything it released (the Steward's own, released in its first rounds, too).
      const tellNow = mode.kind === 'build' ? !!out.build?.closed && mode.run.released.length + buildReleased.length > 0 : out.results.some(releasedSomething);
      if (tellNow) await timed(mode.kind === 'build' ? { due: mode.run.due } : null, 'manor', null, () => tellAfterRelease(ctx.settings.afterRelease, log, o.tell));
      // Where the build's time went so far (buildtimes.ts), in its record: the page's line once it ends.
      if (pipeline && mode.kind === 'build') keepPhases(mode.run.due);
      // A round with nothing done or failed leaves no trace: the last stage stays what last happened. The staff's table
      // is made again only when GitHub says something new of anyone, from this round's glance.
      if (name === 'round' && !roundDidSomething(out.results, out.error)) {
        if (ctx.glance && !out.error) {
          try {
            if (!markStaffChecked(ctx.glance, ctx.settings.employees)) await refreshStaff(ctx, { fetch: true });
          } catch (e) {
            log(`couldn't refresh the staff's table: ${(e as Error).message}`);
          }
        }
        return out;
      }
      writeJson(lastStageFile(), out);
      appendRotating(dataFile('stages.log'), `${JSON.stringify({ ...out, log: undefined })}\n`);
      // A round that only kept the staff's pages up changed nothing on GitHub: the table stands.
      if (tendOnly) return out;
      try {
        // The stage changed things on GitHub: a fresh glance for the table, when the budget allows one (budget.ts); else
        // the stage's own, and the next round's glance puts the table right.
        const b = loadBudget();
        const fresh = gate(b, b.glanceCost ?? ctx.settings.employees.length + 1, at(), { paced: true }).go;
        if (!fresh && !ctx.glance) return out;
        await refreshStaff(ctx, { fetch: true, glance: fresh ? await tryGlance(ctx.run, ctx.settings, undefined, ctx.host, at) : ctx.glance });
      } catch (e) {
        log(`couldn't refresh the staff's table: ${(e as Error).message}`);
      }
      return out;
    },
    // All the slots taken: a moment, then it says so (LockTimeout).
    { waitMs: 2000 },
  );
}
