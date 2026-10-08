import { existsSync, mkdirSync } from 'node:fs';
import { getJson, loadAlarms, watchAlarms, type GetJson, type Held } from './alarms.ts';
import { portUses } from './ports.ts';
import { dataDir } from './app.ts';
import { repoSig, takeGlance, type Glance } from './glance.ts';
import { kitInfo, kitInfoFrom, chooseKit, latestKit, localChangelog, ownKit, stewardTool, type KitInfo } from './kitsource.ts';
import { withLock } from './kit/lock.ts';
import { online as kitOnline } from './kit/net.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { gh } from './git.ts';
import { NO_TEAM, teamOf, type Owner } from './team.ts';
import { run as realRun, useDotnet, type Runner } from './run.ts';
import { expandEnv } from './kit/settings-kit.ts';
import { loadSettings, selfRepoOf, settingsFile, type Employee, type Settings } from './settings.ts';
import { pendingMigration } from './migrate.ts';
import { bump } from './stages/bump.ts';
import { headsUp } from './heads-up.ts';
import { keepVersionQueues } from './version-queue.ts';
import { afterRound, heldBefore, loadSeen, planRound, saveSeen, type RoundPlan } from './stages/changes.ts';
import { checkoutOf, pick, result, type Ctx, type EmployeeResult, type StageName, type StageResult } from './stages/common.ts';
import { afterMerge } from './stages/aftermerge.ts';
import { merge, waitsBriefly } from './stages/merge.ts';
import { stewardEmployee } from './stages/selfmerge.ts';
import { loadUnsafe } from './safeinstall.ts';
import { pruneClaims, shareClaims } from './claims.ts';
import { push } from './stages/push.ts';
import { loadRefreshFailures, refreshAfterReleases } from './stages/refresh.ts';
import { release } from './stages/release.ts';
import { approveMerged } from './stages/jobs.ts';
import { releaseUnreleased, roundDidSomething, roundFailuresFile } from './stages/round.ts';
import { clearRolloutHolds, loadRolloutFailures, rollout } from './stages/rollout.ts';
import { loadSelfFailures, releaseSelf, selfFactsAlone } from './stages/self.ts';
import { staff, type Staff } from './stages/staff.ts';
import { appendRotating, kitsDir, pruneKits, tellAfterRelease, type Poke } from './upkeep.ts';
import { loadTastingHolds, type TastingDeps } from './tasting.ts';
import { loadTending, tend, type OpenAgent } from './tend.ts';
import { loadTurns, remoteFor, takeTurns, type TurnsDeps } from './lease.ts';
import { lookForStrangers } from './strangers.ts';
import { githubReady, hostOf, scmNow, type Host, type ScmLook } from './scm.ts';

/**
 * The stages, as the command line and the page both run them: one at a time on this PC (a lock in the data
 * folder), each recorded in last-stage.json and appended to stages.log, and the staff's table refreshed
 * after each. Each stage begins with one glance at GitHub (glance.ts) for every employee at once.
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
  /**
   * round: only the staff's pages kept up (tend.ts) and the alarms, nothing asked of GitHub: a scheduled round while
   * Settings say it doesn't merge and release by itself. A round on a PC with no repositories to look after is this too.
   */
  tendOnly?: boolean;
}

export const lastStageFile = () => dataFile('last-stage.json');
export const staffFile = () => dataFile('staff.json');
const stageLock = () => dataFile('locks', 'stage');
const kitsPrunedFile = () => dataFile('kits-pruned.json');

export const loadLastStage = () => readJson<StageResult | null>(lastStageFile(), null);
export const loadStaff = () => readJson<Staff | null>(staffFile(), null);

/** One glance at GitHub for every employee (glance.ts), or null, said in the log, when GitHub can't be asked that way. */
export async function tryGlance(run: Runner, settings: Settings, log: (line: string) => void = () => {}, host?: (e: Employee) => Host): Promise<Glance | null> {
  try {
    const g = await takeGlance(run, dataDir, settings, host);
    for (const [id, why] of Object.entries(g.errors)) {
      const e = settings.employees.find((x) => x.id === id);
      log(e && host?.(e) === 'git' ? `[${id}] git couldn't read ${e.repo}'s origin (${why}): it is asked on its own` : `[${id}] GitHub said nothing of ${e?.repo ?? id} at a glance (${why}): it is asked on its own`);
    }
    return g;
  } catch (e) {
    log(`couldn't ask GitHub about everyone at once (${(e as Error).message}): each is asked on its own`);
    return null;
  }
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

/**
 * The stages' context. `team: false` leaves Settings' team as it is, gh unasked: for what never merges (claims).
 * `owner` stands in for the account gh is signed in as (tests).
 */
export async function context(o: { settings?: Settings; run?: Runner; log?: (line: string) => void; glance?: boolean; offline?: boolean; team?: false; owner?: Owner; scm?: ScmLook | null } = {}): Promise<Ctx> {
  const run = o.run ?? realRun;
  const log = o.log ?? (() => {});
  mkdirSync(dataDir, { recursive: true });
  const given = o.settings ?? loadSettings();
  // How each repository is worked with (scm.ts), from what this PC has: looked at once an hour. Under node --test, only
  // what a test says (else GitHub's way, as before), so a test never depends on this PC's tools.
  const look = o.scm !== undefined ? o.scm : process.env.NODE_TEST_CONTEXT ? null : await scmNow(realRun);
  const host = (e: Employee) => hostOf(e, given, look);
  // The Steward's own repository: Settings', else its clone's origin; none when Settings name neither (it doesn't release itself).
  const own = { ...given, stewardRepo: selfRepoOf(given) };
  // The team is GitHub's: when every repository is worked with plain git, or (with none) the GitHub CLI isn't signed in
  // here, gh isn't asked who it is.
  const noGithub = own.employees.length ? !own.employees.some((e) => host(e) === 'github') : look !== null && !githubReady(look);
  const settings = o.team === false || noGithub ? own : withTeam(own, log, o.owner);
  // A .NET repository's commands run with Settings' SDK, when they name one (run.ts).
  useDotnet(settings.dotnetRoot ? expandEnv(settings.dotnetRoot) : '');
  const glance = o.glance === false ? null : await tryGlance(run, settings, log, host);
  // Offline, the kit's releases aren't asked for either: what's known here (its cache, this checkout) is all there is.
  const kitRun: Runner = o.offline ? async (cmd, args, opts) => (cmd === 'gh' ? { code: 1, out: '', err: 'this PC is offline' } : run(cmd, args, opts)) : run;
  const kit = glance?.stewardReleases ? kitInfoFrom(glance.stewardReleases) : await kitInfo(kitRun, dataDir, settings.stewardRepo);
  return { settings, run, kit, log, neutralDir: dataDir, glance, host };
}

/** The kit's changelog for a PR's body: this checkout's, or the kit release's notes. */
async function changelogFor(ctx: Ctx, kit: string): Promise<string | null> {
  const local = localChangelog(ctx.kit);
  if (local) return local;
  if (!ctx.settings.stewardRepo) return null;
  try {
    const body = JSON.parse(await gh(ctx.run, ctx.neutralDir, 'release', 'view', `kit-v${kit}`, '--repo', ctx.settings.stewardRepo, '--json', 'body')).body as string;
    return body.startsWith('## ') ? body : `## ${kit}\n\n${body}`;
  } catch {
    return null;
  }
}

/** A result that says a release was made (a release stage's, a round's, or a merged PR's step). */
export const releasedSomething = (r: EmployeeResult) => r.outcome === 'done' && /(^|: )released v\d/.test(r.message);

/**
 * The staff's table, refreshed and kept in staff.json: GitHub's side from `glance` (default: the stage's, ctx.glance),
 * else asked employee by employee; each checkout's side from git, fetching only a branch that has moved.
 */
export async function refreshStaff(ctx: Ctx, o: { fetch?: boolean; glance?: Glance | null } = {}): Promise<Staff> {
  const c = o.glance === undefined ? ctx : { ...ctx, glance: o.glance };
  const chosen = chooseKit(c.kit);
  const s = await staff(c, { fetch: o.fetch ?? true, kit: 'version' in chosen ? chosen.version : null, kitNote: 'error' in chosen ? chosen.error : chosen.note, tool: stewardTool(), self: selfForStaff(c) });
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
 * still right, and is only marked as checked; true then. False when it needs making again.
 */
export function markStaffChecked(glance: Glance, employees: Employee[], now = new Date()): boolean {
  const s = loadStaff();
  if (!s?.seen || s.rows.filter((r) => !r.self).length !== employees.length) return false;
  for (const e of employees) {
    const g = glance.repos[e.id];
    if (!g || !s.rows.some((r) => r.id === e.id) || s.seen[e.id] !== repoSig(g)) return false;
  }
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
  tend?: { manorUrl?: string; getJson?: GetJson; open?: OpenAgent };
  /** Stands in for what this PC has installed (scm.ts): which repositories are worked with plain git. Tests only. */
  scm?: ScmLook | null;
  /**
   * The turns with this PC's others (lease.ts): who this PC is, the clock and the remotes. Null: no turns. Left out, this
   * PC's own; under node --test there are none unless given.
   */
  turns?: TurnsDeps | null;
}

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

/** The round's look at the staff's pages (tend.ts), through Settings' Manor page; nothing when Settings switch it off. */
async function tendRound(settings: Settings, o: StageOptions, log: (line: string) => void): Promise<EmployeeResult[]> {
  if (!settings.tend) return [];
  if (process.env.NODE_TEST_CONTEXT && !o.tend) return [];
  const manorUrl = o.tend?.manorUrl ?? settings.alarms.manorUrl;
  if (!manorUrl) return [];
  return tend({ manorUrl, getJson: o.tend?.getJson ?? getJson, open: o.tend?.open, now: o.now, log });
}

/** The Steward's own repository for the merge stage, when Settings say it merges its own PRs and it has a checkout. */
function selfEmployee(ctx: Ctx, o: StageOptions): Employee | null {
  if (!ctx.settings.mergeSelf) return null;
  if (process.env.NODE_TEST_CONTEXT && !o.self) return null;
  const checkout = o.self?.checkout ?? ctx.settings.stewardCheckout;
  if (!ctx.settings.stewardRepo || !checkout) return null;
  return existsSync(checkout) ? stewardEmployee(ctx.settings, checkout) : null;
}

/** The turns this stage takes (lease.ts): StageOptions' own, else this PC's; none under node --test unless given. */
const turnsDeps = (o: StageOptions): TurnsDeps | null => (o.turns !== undefined ? o.turns : process.env.NODE_TEST_CONTEXT ? null : {});

/**
 * The turns a merge, release or round takes with this PC's others (lease.ts), before it publishes: on the employees
 * asked about, the repositories refreshed after releases, and the Steward's own while it merges or releases itself.
 * Sets ctx.lease; gives back the employees asked about that are this PC's to publish for, and a line for each that isn't.
 * Only publishing waits on a turn: nothing here stops a build, a test, a tasting or a bump.
 */
async function takeTurnsFor(ctx: Ctx, o: StageOptions, picked: Employee[], self: Employee | null): Promise<{ acting: Employee[]; elsewhere: EmployeeResult[]; selfActs: boolean; on: boolean }> {
  const refreshed = ctx.settings.employees.filter((e) => e.refresh && !picked.includes(e));
  const deps = turnsDeps(o);
  const t = await takeTurns([...picked, ...refreshed, ...(self ? [self] : [])], { run: ctx.run, settings: ctx.settings, log: ctx.log, deps });
  ctx.lease = t.guard;
  const elsewhere = t.elsewhere.filter((r) => picked.some((e) => e.id === r.id) || r.id === self?.id);
  for (const r of elsewhere) ctx.log(`[${r.id}] ${r.message}`);
  return { acting: picked.filter((e) => t.acting.includes(e)), elsewhere, selfActs: !self || t.acting.includes(self), on: !!deps };
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

/** The round's look at the Steward's own versions: from its glance at GitHub, else asked on their own. */
async function selfRound(ctx: Ctx, o: StageOptions): Promise<EmployeeResult[]> {
  if (!ctx.settings.releaseSelf) return [];
  if (process.env.NODE_TEST_CONTEXT && !o.self) return [];
  const checkout = o.self?.checkout ?? ctx.settings.stewardCheckout;
  // No repository or clone of its own in Settings: it doesn't release itself.
  if (!ctx.settings.stewardRepo || !checkout) return [];
  try {
    const facts = ctx.glance ? { main: ctx.glance.stewardMain ?? null, tags: ctx.glance.stewardReleases?.map((r) => r.tagName) ?? null } : await selfFactsAlone(ctx, checkout);
    return await releaseSelf(ctx, { checkout, ...facts });
  } catch (e) {
    ctx.log(`[steward] its own releases: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The employees' jobs approved now, as a round approves them at its end (stages/jobs.ts: only a script that is exactly
 * the merged one), for Manor to ask right after it installs an update (POST /api/jobs/approve), so a job whose script
 * the update changed doesn't wait up to a round to run. `ids`: only these employees, all that approve jobs when empty.
 * Under the stages' lock; nothing is asked of GitHub but each one's branch, fetched. One line for each it approved.
 */
export async function approveJobsNow(ids: string[], o: { run?: Runner; owner?: Owner; log?: (line: string) => void } = {}): Promise<EmployeeResult[]> {
  const log = o.log ?? (() => {});
  return withLock(stageLock(), async () => {
    const ctx = await context({ run: o.run, log, glance: false, owner: o.owner });
    const out: EmployeeResult[] = [];
    for (const e of ctx.settings.employees.filter((x) => x.approve && (!ids.length || ids.includes(x.id)))) {
      try {
        const r = await approveMerged(ctx, e);
        if (r) out.push({ ...r, message: `jobs: ${r.message}` });
      } catch (err) {
        log(`[${e.id}] jobs: ${(err as Error).message}`);
      }
    }
    return out;
  });
}

/** Runs a stage under the lock, records it, and refreshes the staff's table; a round only when it did something. */
export async function runStage(name: Exclude<StageName, 'staff'>, ask: StageAsk, o: StageOptions = {}): Promise<StageResult> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    o.log?.(line);
  };
  return withLock(
    stageLock(),
    async () => {
      // With no repositories to look after here, or Settings saying it doesn't merge and release by itself, a round
      // asks GitHub nothing (no glance, no team): it keeps the staff's pages up, and the alarms look.
      const given = loadSettings();
      const tendOnly = name === 'round' && (!!ask.tendOnly || !reposHere(given, o));
      // Offline (the kit's net.ts), a round asks nothing of GitHub: it would only fail for every employee, every
      // few minutes, and the person knows the PC is offline. It waits for the network; the alarms still look.
      const offline = name === 'round' && !tendOnly && !(await (o.online ?? onlineNow)());
      const quiet = offline || tendOnly;
      const ctx = await context({ settings: given, run: o.run, log, glance: quiet ? false : undefined, offline: quiet, owner: o.owner, team: tendOnly ? false : undefined, scm: o.scm });
      if (o.kitInfo) ctx.kit = o.kitInfo;
      if (o.tasting) ctx.tasting = o.tasting;
      if (o.online) ctx.online = o.online;
      const started = new Date().toISOString();
      const out: StageResult = { stage: name, started, finished: started, kit: null, asked: { ...ask }, results: [], log: lines };
      let held: { employee: Employee; prs: Held[] }[] = [];
      // A round looks only at the employees with something new on GitHub since the last (stages/changes.ts).
      const seen = name === 'round' ? loadSeen() : null;
      let plan: RoundPlan | null = null;
      const own = o.ownKit !== undefined ? o.ownKit : ownKit();
      /** A new kit that waits for this Steward to carry it (stages/rollout.ts), for the alarms. */
      let rolloutWaits: { kit: string; own: string } | null = null;
      /** Whether this round took turns (lease.ts): then each repository's shared claims are looked at too. */
      let turnsOn = false;
      try {
        const picked = pick(ctx.settings.employees, ask.employees);
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
        } else if (name === 'merge' || name === 'round') {
          // A round is merge --yes --team, then a release for every version not yet released (stages/round.ts).
          const round = name === 'round';
          const yes = round || !!ask.yes;
          // Turns with this PC's others first (lease.ts): a repository another PC has its turn in is left to it.
          const whole = !ask.employees?.length;
          const turns = await takeTurnsFor(ctx, o, picked.employees, selfForTurns(ctx, o, (round || !!ask.team) && whole, round && whole));
          turnsOn = turns.on;
          let employees = turns.acting;
          if (round) {
            plan = planRound({ employees, glance: ctx.glance, seen: seen!, settings: ctx.settings, force: !!ask.full, now: o.now?.(), kit: { newest: latestKit(ctx.kit), own } });
            employees = plan.look;
            if (plan.quiet.length) log(`nothing new on GitHub since the last round for ${plan.quiet.map((e) => e.name).join(', ')}: not looked at again`);
          }
          const merged = await merge(ctx, employees, { yes, team: round || !!ask.team });
          out.results = [...turns.elsewhere, ...merged.map(({ merged: _m, held: _h, ...r }) => r)];
          held = merged.flatMap((r) => {
            const employee = employees.find((e) => e.id === r.id);
            return employee && r.held.length ? [{ employee, prs: r.held }] : [];
          });
          // Those not looked at still have the PRs that waited when they last were: the alarms go on counting their hours.
          if (plan) held.push(...heldBefore(seen!, plan.quiet));
          // The team's PRs to the Steward's own repository, as an employee's (stages/selfmerge.ts); not in a stage asked about some of them.
          const self = (round || ask.team) && whole && turns.selfActs ? selfEmployee(ctx, o) : null;
          if (self) {
            const [r] = await merge(ctx, [self], { yes, team: true });
            const { merged: _m, held: prs, ...line } = r;
            out.results.push(line);
            if (prs.length) held.push({ employee: self, prs });
          }
          // A PR that waits only on something settling within minutes: the next round comes sooner (agent.ts).
          const brief = held.flatMap((h) => h.prs.filter((p) => !p.draft && waitsBriefly(p.why)).map((p) => `${h.employee.name} #${p.number}`));
          if (round && brief.length) {
            out.soon = true;
            log(`the next round comes sooner: ${brief.join(', ')} ${brief.length === 1 ? 'waits' : 'wait'} only on checks running, a head just caught up, or GitHub working out whether it merges`);
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
            const releasedNow = new Set(out.results.filter((r) => r.message.startsWith('release: ')).map((r) => r.id));
            const released = await releaseUnreleased(ctx, employees.filter((e) => !releasedNow.has(e.id)));
            out.results.push(...released.map((r) => ({ ...r, message: `release: ${r.message}` })));
            // The Steward's own new versions, apart from the employees' (stages/self.ts); not in a round asked about some of them.
            if (whole && turns.selfActs) out.results.push(...(await selfRound(ctx, o)));
            // A new kit, rolled out to each employee looked at that is behind it (stages/rollout.ts): bumped and pushed now,
            // merged and released by later rounds.
            const newest = latestKit(ctx.kit);
            try {
              const rolled = await rollout(ctx, employees, { kit: newest, ownKit: own, changelog: (k) => changelogFor(ctx, k) });
              out.results.push(...rolled.results);
              if (rolled.plan.waitsForSteward && newest && own) rolloutWaits = { kit: newest, own };
            } catch (err) {
              log(`rollout: ${(err as Error).message}`);
            }
            // Then each employee's jobs whose installed script is the merged one, approved, so an update never leaves them waiting.
            for (const e of picked.employees) {
              let r: EmployeeResult | null;
              try {
                r = await approveMerged(ctx, e);
              } catch (err) {
                log(`[${e.id}] jobs: ${(err as Error).message}`);
                r = null;
              }
              if (r) out.results.push({ ...r, message: `jobs: ${r.message}` });
            }
            if (plan) out.results.push(...plan.quiet.map((e) => result(e, 'skipped', 'nothing new on GitHub since the last round')));
          }
        } else if (name === 'release' && ask.hire) {
          // A hire: the agents named, installed here from their clones, whatever kit is being rolled out, on this PC's own
          // account (no turns with the licence's other PCs: an install is this PC's).
          if (!ask.employees?.length) throw new Error('a hire names the agents to install: release --employees <id> --hire');
          out.results = await release(ctx, picked.employees, { kit: null, hire: true });
        } else if (!ctx.settings.releasesCastellan) {
          // Not the PC that releases Castellan: there is no kit to hand out. Release takes each repository's own version.
          if (name !== 'release') throw new Error(`${name} rolls Castellan's kit out, which only its makers' PC does ("Releases Castellan itself" in Settings)`);
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
      // Something released: each repository with a refresh after releases runs it, and pushes what it changed once its
      // tests pass (stages/refresh.ts). A stage that released nothing runs none.
      const releasedNow = out.results.filter(releasedSomething);
      if (releasedNow.length && !quiet) {
        try {
          out.results.push(...(await refreshAfterReleases(ctx, releasedNow)));
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
      // After every round, done or not: what needs the person (alarms.ts).
      if (name === 'round') {
        try {
          const failedReleases = readJson<Record<string, string>>(roundFailuresFile(), {});
          // Merged or released by something that isn't this Steward (strangers.ts): looked for only in a round that asked GitHub.
          const strangers = await lookForStrangers({ ctx, glance: quiet || out.error ? null : ctx.glance, alarms: loadAlarms(), now: o.now?.() });
          // Every agent's port (ports.ts): two agents on one is an alarm before either is installed. Not in a test,
          // which has no Manor of its own to read.
          const ports = process.env.NODE_TEST_CONTEXT ? undefined : await portUses(ctx.run, ctx.settings.employees).catch(() => undefined);
          await watchAlarms({ settings: ctx.settings, round: out, held, failedReleases, strangers, ports, failedRollouts: loadRolloutFailures(), failedSelf: loadSelfFailures(), rolloutWaits, tastingHolds: loadTastingHolds(), tending: ctx.settings.tend ? loadTending() : null, unsafe: loadUnsafe(), migrated: pendingMigration(settingsFile()), failedRefreshes: loadRefreshFailures(), employees: ctx.settings.employees, log, run: ctx.run, neutralDir: ctx.neutralDir }, { online: o.online ?? onlineNow, ...o.alarms });
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
      // Each repository's version queue, for Manor (version-queue.ts): after the merges, so it says where each one is now.
      // Not in a test, which has no Manor and no projects of its own.
      if ((name === 'round' || name === 'merge') && !out.error && !process.env.NODE_TEST_CONTEXT) {
        try {
          const queues = await keepVersionQueues(ctx);
          // The drafts coming up in them, told early so they're ready before their turn (heads-up.ts).
          for (const line of await headsUp(ctx, queues.upcoming ?? [], { bailiffUrl: ctx.settings.alarms.bailiffUrl })) log(line);
        } catch (e) {
          log(`couldn't keep the version queues: ${(e as Error).message}`);
        }
      }
      // Something released: the pages that want to know are told (Manor installs it within minutes; the Aletaster tastes it).
      if (out.results.some(releasedSomething)) await tellAfterRelease(ctx.settings.afterRelease, log, o.tell);
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
        // The stage changed things on GitHub: a fresh glance for the table.
        await refreshStaff(ctx, { fetch: true, glance: await tryGlance(ctx.run, ctx.settings, undefined, ctx.host) });
      } catch (e) {
        log(`couldn't refresh the staff's table: ${(e as Error).message}`);
      }
      return out;
    },
    // A bump can take a while; a holder whose process is gone is still seen at once.
    { waitMs: 2000, staleMs: 3 * 3600_000 },
  );
}
