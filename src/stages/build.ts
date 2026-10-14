import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fetchBranch, git, removeWorktree } from '../git.ts';
import { changeFiles, fragmentFiles, KIT_CHANGES_DIR } from '../entries.ts';
import type { Glance } from '../glance.ts';
import { hostFor } from '../hosts/index.ts';
import { compareVersions } from '../kitfiles.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { ownerFirstHold } from '../review.ts';
import type { Employee, Settings } from '../settings.ts';
import { agreedVersion } from '../versions.ts';
import { runChecks } from './bump.ts';
import { isKitPr } from './catchup.ts';
import { checkoutOf, clearWorkDir, interrupted, workRootOf, type Ctx } from './common.ts';
import { dropFromBuild } from './kickback.ts';
import { kitReleaseHold } from './prtest.ts';
import { loadRolloutFailures, rolloutFailedFile, type RolloutHold } from './rollout.ts';
import { BUILD_CONTEXT, type PrInfo } from './staff.ts';
import { stampFragmentsAt } from './stamp.ts';
import { shipStack, stackOn, trainsPassedFile } from './train.ts';
import { raisesKit } from './trial.ts';
import { isWrightPr } from './vouch.ts';

/**
 * A build's batch (the build pipeline, pipeline.ts; its design's 2.2 and 2.4): in one of a build's rounds, each
 * repository's ready PRs that write fragments (changes/<branch>.md: no version of their own) are stacked on its branch
 * as one batch, the newest kit's PR (the kit car) first, then the PRs in the order they went ready (noteReady), the
 * fragments stamped once at the top into one version and one entry, and the repository's checks run once there. A
 * batch that passes merges through its top PR (stages/train.ts shipStack).
 *
 * Every PR on board passed alone at its own head, so a batch that fails was broken by PRs together, or by the branch
 * moving under one. Then:
 * 1. Its checks run once more: a flaky test doesn't break up a batch.
 * 2. It is halved by prefix (the first half of the cars tested; passed, the culprit is in the second half; and so on),
 *    at most Settings' bisectRuns (Build pipeline) more test runs: ⌈log₂ N⌉ finds it among N cars.
 * 3. The first car that fails is dropped, and the rest stacked again without it, tested once and shipped. The dropped PR
 *    goes back to a draft, with a comment naming what failed and the PR it clashed with (kickback.ts dropFromBuild).
 * 4. When no one car is found within those runs, or the rest fails again too, the longest prefix that passed ships, and
 *    the rest wait for the next build (build-left.json), with an alarm. When none passed, nothing ships.
 * 5. The kit car that fails is left out the same way, but not turned into a draft: the agent stays on its old kit, and
 *    the rollout's alarm is raised (rollout-failed.json, stage 'build'). It doesn't board again until its PR moves.
 * Each PR on board gets a steward/build status on its head saying which (BUILD_CONTEXT, which checksOf leaves out).
 */

/** A PR in a build's batch: the newest kit's PR of the Steward's (the kit car), or a PR that writes a fragment. */
export interface BuildCar {
  pr: PrInfo;
  kit: boolean;
}

/** When each open PR went ready, as the rounds saw it: "<employee id>#<n>" → its time (ISO), or null while a draft. */
export type ReadySince = Record<string, string | null>;
export const readySinceFile = () => dataFile('ready-since.json');
export const loadReadySince = (): ReadySince => readJson<ReadySince>(readySinceFile(), {});

/**
 * When each PR in a round's glance went ready, kept in ready-since.json: a draft has none; one seen ready after it was
 * seen a draft went ready now; one first seen ready went ready when it was opened, as far as anyone knows. Closed PRs
 * are forgotten; a repository the glance didn't read keeps what it had.
 */
export function noteReady(glance: Glance, now: Date): void {
  const was = loadReadySince();
  const next: ReadySince = {};
  for (const [k, v] of Object.entries(was)) if (!(k.slice(0, k.lastIndexOf('#')) in glance.repos)) next[k] = v;
  for (const [id, r] of Object.entries(glance.repos)) {
    for (const p of r.prs ?? []) {
      const key = `${id}#${p?.number}`;
      if (p?.isDraft) next[key] = null;
      else next[key] = was[key] ?? (key in was ? now.toISOString() : typeof p?.createdAt === 'string' && p.createdAt ? p.createdAt : now.toISOString());
    }
  }
  writeJson(readySinceFile(), next);
}

/** A PR that writes a fragment (changes/<branch>.md), and no changes/<version>.md of its own or the kit's. Pure. */
export const writesFragment = (pr: PrInfo) => fragmentFiles(pr.files).length > 0 && !changeFiles(pr.files).length && !changeFiles(pr.files, KIT_CHANGES_DIR).length;

/**
 * Whether a team PR boards a build's batch: the team's, from the repository itself, ready, into its branch, no steps
 * after merging, no checks on GitHub failing, not the Wright's (reviewed on its own), not one that raises the kit (its
 * trial first), not one that needs the owner first (review.ts), and writing a fragment. Pure.
 */
export const canBoard = (pr: PrInfo, branch: string) =>
  pr.whose === 'team' && !pr.fork && !pr.draft && pr.base === branch && !pr.afterError && !pr.after && pr.checks !== 'failing' && (pr.mergeState !== 'BLOCKED' || pr.checks === 'pending') && !!pr.headOid && !raisesKit(pr) && !isWrightPr(pr) && !ownerFirstHold(pr) && writesFragment(pr);

/** Whether the Steward's kit PR rides a build as its kit car: ready, into the branch, no checks failing, and not left out of a build at this head. Pure. */
export const kitCarRides = (pr: PrInfo, branch: string, held?: RolloutHold | null) =>
  isKitPr(pr) && !pr.fork && !pr.draft && pr.base === branch && pr.checks !== 'failing' && !!pr.headOid && !(held?.stage === 'build' && held.head === pr.headOid);

/**
 * A build's batch for one repository: its kit car first (the newest kit's PR, `kitHeld` its rollout hold), then each PR
 * that boards, in the order it went ready (`since`, by "<id>#<n>"; else when it was opened), lowest number first between
 * equals. `left`: PRs this build already dropped or kept for the next. Pure.
 */
export function buildCars(prs: PrInfo[], o: { id: string; branch: string; since: ReadySince; left?: number[]; kitHeld?: RolloutHold | null }): BuildCar[] {
  const left = new Set(o.left ?? []);
  const kit = prs.filter((p) => !left.has(p.number) && kitCarRides(p, o.branch, o.kitHeld)).sort((a, b) => b.number - a.number)[0];
  const when = (p: PrInfo) => o.since[`${o.id}#${p.number}`] ?? p.createdAt ?? '';
  const team = prs.filter((p) => !left.has(p.number) && canBoard(p, o.branch)).sort((a, b) => when(a).localeCompare(when(b)) || a.number - b.number);
  return [...(kit ? [{ pr: kit, kit: true }] : []), ...team.map((pr) => ({ pr, kit: false }))];
}

/**
 * The first of `n` cars that breaks their stack (which fails, `why`), halving by prefix: `test(k)` runs the checks on
 * the first k cars, and says what failed, or null. Below `passed` cars it passed (none: the branch as it is); at
 * `failed` it failed. One car apart, the culprit is car `failed` - 1 (from 0). At most `cap` runs; one Windows ended
 * stops it (`ended`).
 */
export async function bisect(n: number, cap: number, why: string, test: (k: number) => Promise<string | null>): Promise<{ passed: number; failed: number; runs: number; why: string; ended?: string }> {
  let passed = 0;
  let failed = n;
  let runs = 0;
  while (failed - passed > 1 && runs < cap) {
    const mid = Math.floor((passed + failed) / 2);
    runs++;
    const r = await test(mid);
    if (r && interrupted(r)) return { passed, failed, runs, why, ended: r };
    if (r) {
      failed = mid;
      why = r;
    } else passed = mid;
  }
  return { passed, failed, runs, why };
}

/** What a build left of a repository's batch: the PRs it dropped or kept for the next build, and why (an alarm while kept). */
export interface BuildLeft {
  /** The build's time (pipeline.json's due), and its name in words. */
  due: string;
  name: string;
  /** The PRs dropped from it (now drafts) and those kept for the next build: neither boards again in this build. */
  dropped: number[];
  kept: { number: number; url: string; title: string }[];
  why: string;
  at: string;
}

export const buildLeftFile = () => dataFile('build-left.json');
export const loadBuildLeft = (): Record<string, BuildLeft> => readJson<Record<string, BuildLeft>>(buildLeftFile(), {});

/** A repository's record from an earlier build is done with once a new build begins: its PRs board again. */
export function forgetEarlierBuilds(id: string, due: string): void {
  const all = loadBuildLeft();
  if (all[id] && all[id].due !== due) {
    delete all[id];
    writeJson(buildLeftFile(), all);
  }
}

/** The PRs this build already left out of a repository's batch. */
export const leftIn = (id: string, due: string): number[] => {
  const l = loadBuildLeft()[id];
  return l && l.due === due ? [...l.dropped, ...l.kept.map((k) => k.number)] : [];
};

function noteLeft(id: string, build: { due: string; name: string }, o: { dropped: number[]; kept: PrInfo[]; why: string }): void {
  const all = loadBuildLeft();
  const was = all[id]?.due === build.due ? all[id] : null;
  all[id] = {
    due: build.due,
    name: build.name,
    dropped: [...new Set([...(was?.dropped ?? []), ...o.dropped])],
    kept: [...(was?.kept ?? []), ...o.kept.map((p) => ({ number: p.number, url: p.url, title: p.title }))],
    why: o.why,
    at: new Date().toISOString(),
  };
  writeJson(buildLeftFile(), all);
}

export interface BuildBatch {
  /** The PRs it merged, bottom first: none when it didn't. */
  merged: PrInfo[];
  /** Dropped from the build (a team PR back to a draft, or the kit car left out), each with why. */
  dropped: { pr: PrInfo; why: string }[];
  /** Kept for the next build. */
  kept: PrInfo[];
  /** What it did, or why not. */
  note: string;
  /** It got as far as testing the stack: when not, its PRs go the usual way, one at a time. */
  tested: boolean;
  /** Pushed to the top PR's branch, and waiting there for GitHub's checks: the cars wait as one batch. */
  waiting?: boolean;
}

/** GitHub's status descriptions are at most 140 characters. */
const brief = (s: string) => (s.length <= 140 ? s : `${s.slice(0, 139)}…`);

const versionIn = (dir: string, e: Employee) => {
  const v = agreedVersion(e.versionFiles.map((f) => [f, existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : null] as [string, string | null]));
  return 'version' in v ? v.version : null;
};

export const buildDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-build`);

/**
 * One repository's batch in a build, as the module's comment says: stacked, stamped and tested once; halved to find
 * the car that broke it when it fails; shipped, dropped and kept. `released` and `taken` are the versions the stamp
 * can't give the fragments. Never merges what it didn't test.
 */
export async function runBatch(ctx: Ctx, e: Employee, cars: BuildCar[], o: { released: string[]; taken: string[] }): Promise<BuildBatch> {
  const { run } = ctx;
  const build = ctx.build ?? { due: new Date().toISOString(), name: 'the build' };
  const none = (note: string): BuildBatch => ({ merged: [], dropped: [], kept: [], note, tested: false });
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return none(`there's no checkout at ${repo}`);
  await fetchBranch(run, repo, e.branch);
  const base = (await git(run, repo, 'rev-parse', `origin/${e.branch}`)).trim();
  // Each car as this round listed it, and with its kit released: one that isn't goes its own way.
  const listed: BuildCar[] = [];
  const aside: string[] = [];
  for (const c of cars) {
    try {
      await fetchBranch(run, repo, c.pr.head);
    } catch {
      aside.push(`#${c.pr.number}'s branch couldn't be fetched`);
      continue;
    }
    if ((await git(run, repo, 'rev-parse', `origin/${c.pr.head}`)).trim() !== c.pr.headOid) aside.push(`#${c.pr.number} moved since this round listed it`);
    else if (!c.kit && (await kitReleaseHold(ctx, e, c.pr).catch(() => null))) aside.push(`#${c.pr.number} waits for its kit's release`);
    // The checks it waits for at the top are GitHub's: elsewhere, only cars without any ride.
    else if (c.pr.checks !== 'none' && (ctx.host?.(e) ?? 'github') !== 'github') aside.push(`#${c.pr.number} has checks only GitHub's batch waits for`);
    else listed.push(c);
  }
  const besides = () => (aside.length ? `; ${aside.join('; ')}` : '');
  if (listed.length < 2) return none(`fewer than two of its PRs can go into one batch as they are now${besides()}`);

  const dir = buildDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  clearWorkDir(ctx.settings, dir);
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, base);
  const say = (line: string) => ctx.log(`[${e.id}] build: ${line}`);
  try {
    const baseVersion = versionIn(dir, e);
    if (!baseVersion) return none(`${e.branch}'s version can't be read`);
    const has = async (head: string, commit: string) => (await run('git', ['merge-base', '--is-ancestor', commit, head], { cwd: dir })).code === 0;

    /** The cars stacked in order, each with the stack's commit once it is on and the version it carries. */
    type Stacked = { car: BuildCar; top: string; version: string };
    /** `more` stacked on `from` (the branch, or a stack so far, at `version`): each that can't stack goes its own way. */
    const stack = async (from: string, version: string, more: BuildCar[], under: Stacked[]): Promise<Stacked[]> => {
      const out: Stacked[] = [];
      let at = from;
      let v = version;
      let label = under.length ? `#${under.at(-1)!.car.pr.number}` : e.branch;
      for (const c of more) {
        await git(run, dir, 'checkout', '--quiet', '--detach', c.pr.headOid);
        // A car whose head has the branch and every car under it already (the stack the Steward pushed to it, still
        // waiting for GitHub's checks): its head is the stack so far, as it is.
        let contains = [...under, ...out].length > 0 && (await has(c.pr.headOid, base));
        for (const r of [...under, ...out]) contains = contains && (await has(c.pr.headOid, r.car.pr.headOid));
        const own = versionIn(dir, e);
        const carries = own && compareVersions(own, v) > 0 ? own : v;
        const why = await stackOn(ctx, e, dir, contains ? c.pr.headOid : at, label, { pr: c.pr, version: carries });
        if (why) {
          aside.push(`#${c.pr.number} goes its own way: ${why}`);
          continue;
        }
        at = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
        v = carries;
        label = `#${c.pr.number}`;
        out.push({ car: c, top: at, version: v });
      }
      return out;
    };

    /** A stack's commit with its fragments stamped on top (once for each), or what stopped it. */
    const stamped = new Map<string, string>();
    const stampOn = async (top: string): Promise<{ at: string } | { error: string }> => {
      const known = stamped.get(top);
      if (known) return { at: known };
      await git(run, dir, 'checkout', '--quiet', '--detach', top);
      const s = await stampFragmentsAt(ctx, e, dir, o);
      if (s && 'error' in s) return s;
      const at = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
      stamped.set(top, at);
      return { at };
    };
    /** The checks at a stack's top, stamped: what failed, or null. */
    const checksAt = async (top: string): Promise<string | null> => {
      const s = await stampOn(top);
      if ('error' in s) return s.error;
      await git(run, dir, 'checkout', '--quiet', '--detach', s.at);
      // Passed here already (a batch pushed to its top PR, waiting for GitHub's checks there): not tested again.
      const passed = readJson<Record<string, string>>(trainsPassedFile(), {});
      if (passed[e.id] === s.at) {
        say(`its checks passed here at ${s.at.slice(0, 7)} already`);
        return null;
      }
      const failed = await runChecks(ctx, e, dir, { say });
      if (!failed) writeJson(trainsPassedFile(), { ...readJson<Record<string, string>>(trainsPassedFile(), {}), [e.id]: s.at });
      return failed;
    };
    const numbers = (list: { car: BuildCar }[]) => list.map((s) => `#${s.car.pr.number}`).join(', ');
    const status = async (pr: PrInfo, state: 'success' | 'failure', description: string) => {
      await hostFor(ctx, e)
        .setStatus(e.repo, pr.headOid, { state, context: BUILD_CONTEXT, description: brief(description) })
        .catch(() => null);
    };

    const all = await stack(base, baseVersion, listed, []);
    if (all.length < 2) return none(`fewer than two of its PRs stack${besides()}`);
    ctx.log(`[${e.id}] ${build.name}: ${numbers(all)} stacked on ${e.branch} in the order they went ready, tested once${besides()}`);
    let why = await checksAt(all.at(-1)!.top);
    if (why && !interrupted(why)) {
      // Once more on a failure, as a PR tested here is (prtest.ts): a flaky test doesn't break up a batch.
      say(`its checks once more (${why})`);
      why = await checksAt(all.at(-1)!.top);
    }
    if (why && interrupted(why)) return { ...none(`${numbers(all)} stacked, but Windows ended its checks (${why}): the next round tries again`), tested: false };

    /** What ships: a stack that passed here, `top` its commit before the stamp. */
    let ship: Stacked[] = all;
    let shipTop = all.at(-1)!.top;
    const dropped: { pr: PrInfo; why: string }[] = [];
    let kept: Stacked[] = [];
    let keptWhy = '';
    if (why) {
      const cap = ctx.settings.buildPipeline.bisectRuns;
      const found = await bisect(all.length, cap, why, (k) => {
        say(`halving: the first ${k} of ${all.length} (${numbers(all.slice(0, k))})`);
        return checksAt(all[k - 1].top);
      });
      if (found.ended) return { ...none(`${numbers(all)} stacked and failed (${why}), but Windows ended its checks while halving (${found.ended}): the next round tries again`), tested: false };
      const prefix = all.slice(0, found.passed);
      if (found.failed - found.passed === 1) {
        const culprit = all[found.passed];
        const clash = prefix.map((s) => s.car.pr.number);
        dropped.push({ pr: culprit.car.pr, why: found.why });
        // The rest, without it: stacked again on the prefix that passed, and tested once.
        const after = await stack(prefix.at(-1)?.top ?? base, prefix.at(-1)?.version ?? baseVersion, all.slice(found.passed + 1).map((s) => s.car), prefix);
        const rest = [...prefix, ...after];
        say(`#${culprit.car.pr.number} broke it (${found.why}): the rest${after.length ? `, ${numbers(rest)},` : ''} without it`);
        const again = after.length ? await checksAt(after.at(-1)!.top) : null;
        if (again && interrupted(again)) return { ...none(`${numbers(all)} failed and #${culprit.car.pr.number} broke it, but Windows ended the checks without it (${again}): the next round tries again`), tested: false };
        if (!again) {
          ship = rest;
          shipTop = rest.at(-1)?.top ?? base;
        } else {
          // The rest failed too: only the prefix that passed leaves, the cars after the culprit wait for the next build.
          ship = prefix;
          shipTop = prefix.at(-1)?.top ?? base;
          kept = after;
          keptWhy = `without #${culprit.car.pr.number} they failed too (${again})`;
        }
        // The kit car: left out, not turned into a draft; the agent stays on its old kit (rollout.ts's alarm).
        if (culprit.car.kit) {
          const failed = loadRolloutFailures();
          failed[e.id] = { kit: culprit.car.pr.head.replace(/^steward\/kit-/, ''), head: culprit.car.pr.headOid, stage: 'build', message: `${build.name} failed with its kit PR #${culprit.car.pr.number} first (${found.why}), and passed without it`, at: new Date().toISOString() };
          writeJson(rolloutFailedFile(), failed);
          ctx.log(`[${e.id}] ${build.name}: the kit PR #${culprit.car.pr.number} broke its checks (${found.why}): ${e.name} leaves without it, on its old kit`);
          await status(culprit.car.pr, 'failure', `left out of ${build.name}: ${found.why}`);
        } else {
          await dropFromBuild(ctx, e, culprit.car.pr, { build: build.name, why: found.why, with: clash });
          await status(culprit.car.pr, 'failure', `dropped from ${build.name}: ${found.why}`);
        }
      } else {
        // No one car found within Settings' runs: the prefix that passed leaves, the rest wait for the next build.
        ship = prefix;
        shipTop = prefix.at(-1)?.top ?? base;
        kept = all.slice(found.passed);
        keptWhy = cap
          ? `they failed together (${found.why}), and ${found.runs} test run${found.runs === 1 ? '' : 's'} (Settings: bisectRuns) didn't find one PR that broke them`
          : `they failed together (${found.why}), and Settings look for no PR that broke them (bisectRuns 0)`;
      }
    }
    for (const k of kept) await status(k.car.pr, 'success', `waits for the next build: ${keptWhy}`);
    if (kept.length || dropped.length) noteLeft(e.id, build, { dropped: dropped.map((d) => d.pr.number), kept: kept.map((k) => k.car.pr), why: keptWhy || dropped.map((d) => `#${d.pr.number}: ${d.why}`).join('; ') });
    const left = [...dropped.map((d) => `dropped #${d.pr.number} (${d.why})`), ...(kept.length ? [`kept ${numbers(kept)} for the next build: ${keptWhy}`] : [])].join('; ');
    const result = (merged: PrInfo[], note: string, more: Partial<BuildBatch> = {}): BuildBatch => ({ merged, dropped, kept: kept.map((k) => k.car.pr), note: `${note}${left ? `; ${left}` : ''}${besides()}`, tested: true, ...more });
    if (!ship.length) return result([], `${numbers(all)} failed together, and no PRs at the bottom of the stack passed: none of them leaves in ${build.name}`);

    const s = await stampOn(shipTop);
    if ('error' in s) return result([], `couldn't stamp ${numbers(ship)}: ${s.error}`);
    await git(run, dir, 'checkout', '--quiet', '--detach', s.at);
    const at = s.at;
    const words = `stacked on ${e.branch} in the order they went ready and tested once, at ${at.slice(0, 7)}`;
    const shipped = await shipStack(ctx, e, dir, ship.map((x) => ({ pr: x.car.pr, version: x.version })), at, {
      say,
      top: (under) => `Merged by the Steward in ${build.name} with ${under}: ${words}.`,
      under: (top) => `Merged by the Steward in ${build.name}, through ${top}: ${words}. Its commits are in \`${e.branch}\`.`,
    });
    if ('note' in shipped) return result([], shipped.note, shipped.waiting ? { waiting: true } : {});
    for (const x of ship) await status(x.car.pr, 'success', `left in ${build.name}`);
    ctx.log(`[${e.id}] ${build.name}: merged ${numbers(ship)} through #${ship.at(-1)!.car.pr.number} (${words})`);
    return result(
      ship.map((x) => x.car.pr),
      words,
    );
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
