import { existsSync, mkdirSync } from 'node:fs';
import { watchAlarms, type Held } from './alarms.ts';
import { dataDir } from './app.ts';
import { repoSig, takeGlance, type Glance } from './glance.ts';
import { kitInfo, kitInfoFrom, chooseKit, latestKit, localChangelog, ownKit, stewardTool, type KitInfo } from './kitsource.ts';
import { withLock } from './kit/lock.ts';
import { online as kitOnline } from './kit/net.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { gh } from './git.ts';
import { run as realRun, type Runner } from './run.ts';
import { loadSettings, type Employee, type Settings } from './settings.ts';
import { bump } from './stages/bump.ts';
import { afterRound, heldBefore, loadSeen, planRound, saveSeen, type RoundPlan } from './stages/changes.ts';
import { pick, result, type Ctx, type EmployeeResult, type StageName, type StageResult } from './stages/common.ts';
import { afterMerge } from './stages/aftermerge.ts';
import { merge } from './stages/merge.ts';
import { stewardEmployee } from './stages/selfmerge.ts';
import { loadUnsafe } from './safeinstall.ts';
import { pruneClaims } from './claims.ts';
import { push } from './stages/push.ts';
import { release } from './stages/release.ts';
import { approveMerged } from './stages/jobs.ts';
import { releaseUnreleased, roundDidSomething, roundFailuresFile } from './stages/round.ts';
import { clearRolloutHolds, loadRolloutFailures, rollout } from './stages/rollout.ts';
import { loadSelfFailures, releaseSelf, selfFactsAlone } from './stages/self.ts';
import { staff, type Staff } from './stages/staff.ts';
import { appendRotating, kitsDir, pruneKits, tellAfterRelease, type Poke } from './upkeep.ts';
import { loadTastingHolds, type TastingDeps } from './tasting.ts';

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
  /** round: every employee looked at, whatever has changed (Run now, and `steward round`). */
  full?: boolean;
}

export const lastStageFile = () => dataFile('last-stage.json');
export const staffFile = () => dataFile('staff.json');
const stageLock = () => dataFile('locks', 'stage');
const kitsPrunedFile = () => dataFile('kits-pruned.json');

export const loadLastStage = () => readJson<StageResult | null>(lastStageFile(), null);
export const loadStaff = () => readJson<Staff | null>(staffFile(), null);

/** One glance at GitHub for every employee (glance.ts), or null, said in the log, when GitHub can't be asked that way. */
export async function tryGlance(run: Runner, settings: Settings, log: (line: string) => void = () => {}): Promise<Glance | null> {
  try {
    const g = await takeGlance(run, dataDir, settings);
    for (const [id, why] of Object.entries(g.errors)) log(`[${id}] GitHub said nothing of ${settings.employees.find((e) => e.id === id)?.repo ?? id} at a glance (${why}): it is asked on its own`);
    return g;
  } catch (e) {
    log(`couldn't ask GitHub about everyone at once (${(e as Error).message}): each is asked on its own`);
    return null;
  }
}

export async function context(o: { settings?: Settings; run?: Runner; log?: (line: string) => void; glance?: boolean; offline?: boolean } = {}): Promise<Ctx> {
  const settings = o.settings ?? loadSettings();
  const run = o.run ?? realRun;
  const log = o.log ?? (() => {});
  mkdirSync(dataDir, { recursive: true });
  const glance = o.glance === false ? null : await tryGlance(run, settings, log);
  // Offline, the kit's releases aren't asked for either: what's known here (its cache, this checkout) is all there is.
  const kitRun: Runner = o.offline ? async (cmd, args, opts) => (cmd === 'gh' ? { code: 1, out: '', err: 'this PC is offline' } : run(cmd, args, opts)) : run;
  const kit = glance?.stewardReleases ? kitInfoFrom(glance.stewardReleases) : await kitInfo(kitRun, dataDir, settings.stewardRepo);
  return { settings, run, kit, log, neutralDir: dataDir, glance };
}

/** The kit's changelog for a PR's body: this checkout's, or the kit release's notes. */
async function changelogFor(ctx: Ctx, kit: string): Promise<string | null> {
  const local = localChangelog(ctx.kit);
  if (local) return local;
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
  const s = await staff(c, { fetch: o.fetch ?? true, kit: 'version' in chosen ? chosen.version : null, kitNote: 'error' in chosen ? chosen.error : chosen.note, tool: stewardTool() });
  writeJson(staffFile(), s);
  try {
    pruneKitsNow(s, c.kit);
  } catch (e) {
    c.log(`couldn't tidy the kits folder: ${(e as Error).message}`);
  }
  return s;
}

/**
 * After a quiet round: when GitHub says of every employee what it said when the staff's table was made, the table is
 * still right, and is only marked as checked; true then. False when it needs making again.
 */
export function markStaffChecked(glance: Glance, employees: Employee[], now = new Date()): boolean {
  const s = loadStaff();
  if (!s?.seen || s.rows.length !== employees.length) return false;
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
}

/** The Steward's own repository for the merge stage, when Settings say it merges its own PRs and it has a checkout. */
function selfEmployee(ctx: Ctx, o: StageOptions): Employee | null {
  if (!ctx.settings.mergeSelf) return null;
  if (process.env.NODE_TEST_CONTEXT && !o.self) return null;
  const checkout = o.self?.checkout ?? ctx.settings.stewardCheckout;
  return existsSync(checkout) ? stewardEmployee(ctx.settings, checkout) : null;
}

/** Whether this PC is online: the kit's look, or online under node --test (StageOptions.online). */
export const onlineNow = (): Promise<boolean> => (process.env.NODE_TEST_CONTEXT ? Promise.resolve(true) : kitOnline());

/** The round's look at the Steward's own versions: from its glance at GitHub, else asked on their own. */
async function selfRound(ctx: Ctx, o: StageOptions): Promise<EmployeeResult[]> {
  if (!ctx.settings.releaseSelf) return [];
  if (process.env.NODE_TEST_CONTEXT && !o.self) return [];
  const checkout = o.self?.checkout ?? ctx.settings.stewardCheckout;
  try {
    const facts = ctx.glance ? { main: ctx.glance.stewardMain ?? null, tags: ctx.glance.stewardReleases?.map((r) => r.tagName) ?? null } : await selfFactsAlone(ctx, checkout);
    return await releaseSelf(ctx, { checkout, ...facts });
  } catch (e) {
    ctx.log(`[steward] its own releases: ${(e as Error).message}`);
    return [];
  }
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
      // Offline (the kit's net.ts), a round asks nothing of GitHub: it would only fail for every employee, every
      // few minutes, and the person knows the PC is offline. It waits for the network; the alarms still look.
      const offline = name === 'round' && !(await (o.online ?? onlineNow)());
      const ctx = await context({ run: o.run, log, glance: offline ? false : undefined, offline });
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
      try {
        const picked = pick(ctx.settings.employees, ask.employees);
        if ('error' in picked) throw new Error(picked.error);
        if (offline) {
          out.offline = true;
          log('this PC is offline, so the round waits for the network: nothing is asked of GitHub until it is back');
        } else if (name === 'merge' || name === 'round') {
          // A round is merge --yes --team, then a release for every version not yet released (stages/round.ts).
          const round = name === 'round';
          const yes = round || !!ask.yes;
          let employees = picked.employees;
          if (round) {
            plan = planRound({ employees, glance: ctx.glance, seen: seen!, settings: ctx.settings, force: !!ask.full, now: o.now?.(), kit: { newest: latestKit(ctx.kit), own } });
            employees = plan.look;
            if (plan.quiet.length) log(`nothing new on GitHub since the last round for ${plan.quiet.map((e) => e.name).join(', ')}: not looked at again`);
          }
          const merged = await merge(ctx, employees, { yes, team: round || !!ask.team });
          out.results = merged.map(({ merged: _m, held: _h, ...r }) => r);
          held = merged.flatMap((r) => {
            const employee = employees.find((e) => e.id === r.id);
            return employee && r.held.length ? [{ employee, prs: r.held }] : [];
          });
          // Those not looked at still have the PRs that waited when they last were: the alarms go on counting their hours.
          if (plan) held.push(...heldBefore(seen!, plan.quiet));
          // The team's PRs to the Steward's own repository, as an employee's (stages/selfmerge.ts); not in a stage asked about some of them.
          const self = (round || ask.team) && !ask.employees?.length ? selfEmployee(ctx, o) : null;
          if (self) {
            const [r] = await merge(ctx, [self], { yes, team: true });
            const { merged: _m, held: prs, ...line } = r;
            out.results.push(line);
            if (prs.length) held.push({ employee: self, prs });
          }
          const done = merged.filter((r) => r.merged.length).map((r) => r.id);
          if (yes && done.length) {
            // A release when Settings say so, at the kit the Steward hands out; and whatever each merged PR asks for.
            let releaseKit: string | null = null;
            if (ctx.settings.releaseAfterMerge) {
              const chosen = chooseKit(ctx.kit, ask.kit);
              if ('error' in chosen) log(`release after merge: ${chosen.error}`);
              else {
                log(`release after merge (Settings): ${done.join(', ')}`);
                out.kit = chosen.version;
                releaseKit = chosen.version;
              }
            }
            out.results.push(...(await afterMerge(ctx, picked.employees, merged, { releaseKit })));
          }
          if (round) {
            const releasedNow = new Set(out.results.filter((r) => r.message.startsWith('release: ')).map((r) => r.id));
            const released = await releaseUnreleased(ctx, employees.filter((e) => !releasedNow.has(e.id)));
            out.results.push(...released.map((r) => ({ ...r, message: `release: ${r.message}` })));
            // The Steward's own new versions, apart from the employees' (stages/self.ts); not in a round asked about some of them.
            if (!ask.employees?.length) out.results.push(...(await selfRound(ctx, o)));
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
            out.results = await push(ctx, picked.employees, { kit: chosen.version, changelog: await changelogFor(ctx, chosen.version) });
          } else out.results = await release(ctx, picked.employees, { kit: chosen.version });
        }
      } catch (e) {
        out.error = (e as Error).message;
        log(`${name}: ${out.error}`);
      }
      out.finished = new Date().toISOString();
      // Claimed versions whose work landed, or went stale with no PR, are given back (claims.ts).
      if (name === 'round') {
        try {
          await pruneClaims(loadStaff()?.rows ?? []);
        } catch (e) {
          log(`claims: ${(e as Error).message}`);
        }
      }
      // After every round, done or not: what needs the person (alarms.ts).
      if (name === 'round') {
        try {
          const failedReleases = readJson<Record<string, string>>(roundFailuresFile(), {});
          await watchAlarms({ settings: ctx.settings, round: out, held, failedReleases, failedRollouts: loadRolloutFailures(), failedSelf: loadSelfFailures(), rolloutWaits, tastingHolds: loadTastingHolds(), unsafe: loadUnsafe(), employees: ctx.settings.employees, log }, { online: o.online ?? onlineNow, ...o.alarms });
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
      try {
        // The stage changed things on GitHub: a fresh glance for the table.
        await refreshStaff(ctx, { fetch: true, glance: await tryGlance(ctx.run, ctx.settings) });
      } catch (e) {
        log(`couldn't refresh the staff's table: ${(e as Error).message}`);
      }
      return out;
    },
    // A bump can take a while; a holder whose process is gone is still seen at once.
    { waitMs: 2000, staleMs: 3 * 3600_000 },
  );
}
