import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimVersion } from '../claims.ts';
import { changelogBetween, compareVersions, lf, pinText } from '../kitfiles.ts';
import { whileAwake } from '../kit/awake.ts';
import { CHANGELOG, HEADINGS, headingVersion, headlineOf, NOTHING_TO_DO, sectionOf, withEntry } from '../kit/notes.ts';
import { unsignedGitVars } from '../kit/unsigned-git.ts';
import { codeAt, recordResult, toolchainHere, withWork } from '../kit/work-status.ts';
import { commitOf, fetchBranch, git, gitMaybe, onOrigin, removeWorktree, showFile } from '../git.ts';
import { affectedTests, filesIn, globRe, kitFromOf, nodeTestScript, scriptsIn, type Changed } from '../affected.ts';
import type { KitReach } from './kitreach.ts';
import { stewardToolFile, takesTool, TOOL } from '../kitsource.ts';
import { errorLines, failedTests, runLine, tail, type Runner } from '../run.ts';
import type { Employee } from '../settings.ts';
import { agreedVersion, bumpPatch, setVersion } from '../versions.ts';
import { bumpBranch, bumpDirOf, checkoutOf, mapLimit, networkNote, NOT_ON_KIT, result, freshWorktree, workRootOf, type Ctx, type EmployeeResult, type KitFold } from './common.ts';
import { installLines } from '../installscripts.ts';
import { guardPackages, linkSharedModules } from './modules.ts';
import { readPin } from './staff.ts';
import { recordTested } from '../tested.ts';
import { keepWhole, ranWhole } from '../whole.ts';
import { trialPassOf } from './trialpass.ts';
import { withRepo } from './slots.ts';
import { standIn, type StoodIn } from './standin.ts';
import { seneschalTurn, TURN_HELD_ENV, type SeneschalAnswer, type SeneschalShard } from '../kit/seneschal.ts';
import { APP } from '../app.ts';
import { checksTask, type CheckTask } from './seneschal.ts';

/**
 * Stage 1, `steward bump --kit <version>`: for each employee that takes the kit, a fresh worktree of its
 * branch on origin (never the person's own checkout), on the branch steward/kit-<version>, in the work
 * folder. There kit.json's pin goes to the new kit, tools/kit.ts becomes the Steward's (for an agent that
 * fills its kit with it), and the employee's version goes up in every version file to the one claimed for the bump's
 * branch (claims.ts: above every open PR's and every live claim, so a bump never takes the version of work open
 * beside it; the same again for the same branch, so a bump made again keeps it); then its kit is
 * filled, with the new tools/kit.ts, its checks run, and, when every one passes, the changes are
 * committed. Checks that fail are run once more; failing again leaves the worktree as it was, for a look, with the
 * failed step's whole output beside it (<worktree>.log) and the failed tests named in its message. An employee that isn't a Node agent
 * (Heiward, in C#) gets the same, but for npm and tools/kit.ts: its own fill command fills its kit, and its
 * version files may be a .csproj's <VersionPrefix>.
 *
 * The new version's entry goes at the top of its CHANGELOG.md (one is started when it has none), so its release's notes
 * say what it brings (the kit's spec/RELEASE-NOTES.md): each kit version's headline since the one it pinned, and those
 * kit entries' own "Before you update", else that updating needs nothing.
 */

export interface BumpOptions {
  kit: string;
  /** What to start from instead of origin/<branch> (a local branch, for a trial). Not fetched. */
  base?: string | null;
  /** A kit tree to fill from (STEWARD_KIT) instead of the kit release: for a kit not released yet. */
  kitFrom?: string | null;
  /** The tools/kit.ts to hand out (default: the Steward's own). */
  tool?: string;
  /** The kit's CHANGELOG.md, for the employee's changelog entry; null when it couldn't be read (the entry names the kit alone). */
  changelog?: string | null;
  /**
   * A trial of a kit not released yet, before its PR merges (stages/trial.ts): a worktree and local branch of their
   * own (never a bump's, which may be left for a look), nothing committed; trial.ts removes them after.
   */
  trial?: boolean;
  /**
   * A trial's and the rollout's: what the kit changes for the employee (kitreach.ts), given its pin and whether its
   * tools/kit.ts changes. Nothing it takes: a trial doesn't try it, and a rollout's bump runs its checks but no tests.
   * Some files: only the tests they reach run.
   */
  reach?: (e: Employee, pin: { kit: string; parts: string[] | null }, toolChanged: boolean) => Promise<KitReach>;
  /**
   * By employee id: its kit PR open for an older kit, which this kit goes onto (the rollout's fold): its branch bumped
   * again, at its version, with its changelog entry written again. Never with `base` or a trial.
   */
  folds?: Record<string, KitFold>;
}

/** Where a trial bumps an employee, and on which local branch. */
export const trialDirOf = (s: Ctx['settings'], e: Employee) => path.join(workRootOf(s), `${e.id}-trial`);
export const trialBranch = (kit: string) => `steward/trial-kit-${kit}`;

/**
 * The employee's changelog entry for a kit bump (`## <version>` and all): the kit it now carries, a "What changed"
 * line for each kit version after `from` up to `kit` (that entry's headline), and "Before you update" from those kit
 * entries' own, or that updating needs nothing.
 */
export function kitBumpEntry(o: { version: string; from: string; kit: string; changelog: string | null }): string {
  const back = compareVersions(o.kit, o.from) < 0;
  const sections = !back && o.changelog ? changelogBetween(o.changelog, o.from, o.kit).split(/^(?=## )/m).filter((s) => s.startsWith('## ')) : [];
  const changed: string[] = [];
  const care: string[] = [];
  for (const s of sections) {
    const [heading, ...rest] = lf(s).split('\n');
    const v = headingVersion(heading);
    const body = rest.join('\n');
    const headline = headlineOf(body);
    if (v) changed.push(`- The Steward's kit ${v}${headline ? `: ${headline}` : ''}`);
    const c = sectionOf(body, HEADINGS.care);
    if (c && !/^nothing\b/i.test(c)) care.push(c);
  }
  // Without the kit's changelog, a line of its own: never a repository's name, which the agent's notes would ship
  // (they're published, and an agent's tests refuse the owner's account in what it ships).
  if (!changed.length) changed.push(back ? `- A step back to the Steward's kit ${o.kit}, from ${o.from}.` : `- The Steward's kit ${o.kit}, after ${o.from}: the parts every agent of the manor shares.`);
  return [
    `## ${o.version}`,
    '',
    `**It carries the Steward's kit ${o.kit}${back ? ', a step back' : ''}: the parts every agent of the manor shares.**`,
    '',
    `### ${HEADINGS.changed}`,
    '',
    ...changed,
    '',
    `### ${HEADINGS.care}`,
    '',
    care.length ? care.join('\n') : NOTHING_TO_DO,
  ].join('\n');
}

/**
 * The changelog with `entry` in place of the one it has for that version (a fold's: the kit PR's own entry, written
 * again for the newer kit), the rest as it was; as withEntry when it has no entry for that version.
 */
export function replacingEntry(text: string | null, entry: string, name: string): string {
  const version = headingVersion(lf(entry).split('\n')[0]);
  const lines = lf(text ?? '').split('\n');
  const at = version ? lines.findIndex((l) => headingVersion(l) === version) : -1;
  if (text === null || at < 0) return withEntry(text, entry, name);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  const rest = end < 0 ? [] : lines.slice(end);
  return [...lines.slice(0, at), ...lf(entry).trim().split('\n'), '', ...rest].join('\n').replace(/\n/g, eol);
}

/**
 * Whether a fresh worktree needs `npm ci` before its checks: a Node project (package.json and its lockfile) without
 * node_modules. A .NET employee has no package.json, and gets no npm.
 */
export const needsNpmCi = (dir: string) =>
  existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'package-lock.json')) && !existsSync(path.join(dir, 'node_modules'));

/**
 * An employee's checks in a worktree, as a fresh clone would run them: dependencies (npm's, for a Node agent, linked
 * from the set installed once for its lockfile (modules.ts), else `npm ci` there; a .NET one restores its own packages
 * as it builds), the kit, then each test command (Settings). The first that failed, or null when all passed. A bump
 * runs them before its commit, and merge on a team PR GitHub runs no checks on.
 *
 * `timeLimit` (a vouch's, vouchtime.ts) gives the whole run a time limit from its start, asked once it's known whether
 * it runs the whole suite or only the tests a change reaches (and how many test files): at once, unless `npm test` is
 * picked, then as it is. A step still running at the limit is stopped with everything it started, and the run fails
 * saying so.
 *
 * `failed`, when given, is filled with the step that failed and the tests it failed (node --test's TAP), for a caller
 * that weighs a second try against the first (wholesuite.ts).
 *
 * The PC is kept awake while they run (the kit's awake.ts, Steward 0.36.45): on 2026-10-15 it slept on its own for an
 * hour in the middle of a round's checks.
 *
 * Where the Seneschal is on this PC (the kit's seneschal.ts, Steward 0.36.65), they wait their turn in its one order
 * first (stages/seneschal.ts: the task and its lane), then run under its lease without a turn of the checks pace (the
 * lease is their turn), and their result goes back to it; a pass of exactly these checks it holds stands in. Without
 * it, off duty, or on a PC without Developer Pro, they run as before.
 */
export async function runChecks(ctx: Ctx, e: Employee, dir: string, o: ChecksOptions): Promise<string | null> {
  // A task in the Steward's work status (the kit's work-status.ts), with the commit and code tree it runs at; what it
  // came to is kept by that tree, unless a kit under trial filled it (not the tree's own result) or it wasn't clean.
  const { commit, tree, clean } = await codeAt(dir);
  const trial = !!o.env?.STEWARD_KIT;
  const what = `${e.name}: ${o.doing ?? 'its checks'}`;
  return withWork({ kind: trial ? 'trial' : 'checks', what, repo: e.repo, ...(commit ? { commit } : {}), ...(tree ? { tree } : {}) }, async (h) => {
    // Code that already passed these checks, in the Assayer, here or on another PC on the licence, isn't run again
    // (standin.ts): never a trial's, one with settings of its own, nor one whose point is this PC.
    const stood = trial || o.here || Object.keys(o.env ?? {}).length || !clean || !commit || !tree ? null : await standIn(ctx, e, dir, { tree, scope: o.affected });
    if (stood) {
      o.say(stood.line ?? 'a pass of exactly this code: not run again');
      if (o.stoodIn) Object.assign(o.stoodIn, stood);
      return null;
    }
    // Its turn from the Seneschal, where it's on this PC (stages/seneschal.ts); null: as before, at the checks pace.
    const ask = await checksTask(ctx, e, dir, { commit, tree, clean, env: o.env, here: o.here, affected: o.affected, task: o.task, shard: o.shard });
    const answer: SeneschalAnswer | null =
      'not' in ask
        ? null
        : await seneschalTurn(ask, {
            worker: APP.id,
            commands: e.test,
            say: (line) => o.say(`the Seneschal: ${line}`),
            waiting: (why) => {
              h.waitIn(`seneschal:${ask.lane}`);
              o.say(`waits its turn from the Seneschal: ${why}`);
            },
          });
    h.running();
    const seen: FailedChecks = o.failed ?? {};
    if (answer && 'reused' in answer) {
      const r = answer.reused;
      // Another PC's run (Seneschal 0.2.0) is said as that PC's.
      const where = r.pc ? `on ${r.pc.name}` : r.by === APP.id ? 'here' : `here, in the ${r.by.charAt(0).toUpperCase()}${r.by.slice(1)}'s run`;
      const line = `a pass of exactly these checks on this code, ${where} (the Seneschal's ${answer.id}${r.flaky ? `, after failing on ${r.flaky.on}` : ''}): not run again`;
      o.say(line);
      if (o.stoodIn) Object.assign(o.stoodIn, { by: 'seneschal', where, at: r.at, line, ...(r.pc ? { pc: r.pc.name } : {}) } satisfies StoodIn);
      return null;
    }
    // Failed on two PCs while this waited for its turn (Seneschal 0.2.0): the change's failure, not run a third time here.
    if (answer && 'failed' in answer) {
      const r = answer.failed;
      const where = `${r.pc ? `on ${r.pc.name}` : 'here'}, and on ${r.confirmed?.on ?? 'another PC'} before it`;
      o.say(`these checks failed on this code ${where} (the Seneschal's ${answer.id}): the change's failure, not run again here`);
      seen.confirmed = where;
      return `${r.note ?? 'its checks failed'} (${where})`;
    }
    const turn = answer && 'turn' in answer ? answer.turn : null;
    if (turn) o.say(`its turn from the Seneschal (${turn.id}${turn.waitedMs >= 1000 ? `, after ${duration(turn.waitedMs)}` : ''})`);
    // A run that couldn't finish (a time limit, packages held, a locked clone) is the Seneschal's to try again, not a failure.
    const failed = await whileAwake(
      `${e.name}'s checks`,
      () =>
        turn
          ? turn.hold(
              () => checksIn(ctx, e, dir, { ...o, failed: seen }, true),
              (f) => ({ ok: !f, ...(f ? { note: f.slice(0, 500) } : {}), ...(f && (seen.timedOut || f.startsWith(PACKAGES_HELD)) ? { error: true } : {}), commands: e.test }),
            )
          : checksIn(ctx, e, dir, o),
      ctx.log,
    );
    // A shard ran only some of the whole suite, never kept as the tree's checks (wholesuite.ts keeps the whole once all pass).
    const after = trial || !commit || o.shard ? null : await codeAt(dir);
    if (after?.clean && after.commit === commit) recordResult({ kind: ranWhole(o.affected?.chose) ? 'checks' : 'affected checks', repo: e.repo, tree: tree ?? null, commit, ok: !failed, what, commands: e.test, ...toolchainHere(), ...(failed ? { note: failed.slice(0, 500) } : {}) });
    // A failure here the Seneschal tries once more on another PC (Seneschal 0.2.0), where the caller waits for that: a
    // pass there stands in, said as this PC's failure; a failure there too is the change's (`failed.confirmed`).
    if (failed && turn && o.elsewhere) {
      const other = await turn.elsewhere();
      if (other?.ok) {
        const where = `on ${other.pc?.name ?? 'another PC'}`;
        const line = `they failed here and passed ${where} (the Seneschal's ${turn.id}): this PC's failure, not the change's (${failed})`;
        o.say(line);
        if (o.stoodIn) Object.assign(o.stoodIn, { by: 'seneschal', where, at: other.at, line, ...(other.pc ? { pc: other.pc.name } : {}), flaky: failed.slice(0, 300) } satisfies StoodIn);
        return null;
      }
      if (other) {
        const where = `here, and on ${other.pc?.name ?? 'another PC'}`;
        o.say(`they failed ${where} (the Seneschal's ${turn.id}): the change's failure`);
        seen.confirmed = where;
        return `${failed} (${where})`;
      }
    }
    return failed;
  });
}

export type ChecksOptions = {
  env?: Record<string, string>;
  say: (line: string) => void;
  affected?: AffectedScope;
  doing?: string;
  timeLimit?: (kind: CheckKind, files?: number) => TimeLimit | null;
  failed?: FailedChecks;
  /** Run on this PC whatever passed elsewhere: no pass stands in (standin.ts). */
  here?: boolean;
  /** Filled with the pass that stood in, when one did (runChecks then ran nothing, and answers null). */
  stoodIn?: StoodIn;
  /** What the run is to the Seneschal (stages/seneschal.ts): its kind, lane, PR and branch. False: it isn't asked. */
  task?: CheckTask | false;
  /**
   * After a failure here, wait for the Seneschal's try on another PC on the licence (prtest's): a pass there stands in
   * (`stoodIn.flaky`), a failure there too fills `failed.confirmed`. Left out, the try still runs there, unwaited for.
   */
  elsewhere?: boolean;
  /**
   * One part of the whole suite (wholesuite.ts, or another PC's full-suite task): `npm test` runs only its test files
   * (shardSteps), and the employee's other test steps run in the first shard alone.
   */
  shard?: SeneschalShard;
};

/** How a run whose packages Settings held begins its answer. */
export const PACKAGES_HELD = "its packages weren't installed";

/** `held`: the run has its turn already (the Seneschal's lease), so its commands take none of the checks pace's. */
export async function checksIn(ctx: Ctx, e: Employee, dir: string, o: ChecksOptions, held = false): Promise<string | null> {
  const started = Date.now();
  const picks = !!o.affected && e.test.some((s) => s.trim() === 'npm test');
  let limit: (TimeLimit & { at: number }) | null = null;
  let limited = !o.timeLimit;
  const before: string[] = [];
  if (needsNpmCi(dir)) {
    // No package's install script runs unless Settings allow it; one that isn't holds the checks (installscripts.ts).
    const g = await guardPackages(ctx, e, dir, o.doing ?? 'its checks');
    if (g.held) {
      o.say(`packages held: ${g.held}`);
      return `${PACKAGES_HELD}: ${g.held}`;
    }
    if (!(await linkSharedModules(ctx, dir, o.say, g.plan))) before.push(...installLines(g.plan));
  }
  if (e.fill) before.push(e.fill);
  // Each test step worked out once the dependencies and the kit are in place, so the kit's files are there to follow.
  const steps: (string | (() => Promise<string[]>))[] = [...before];
  // A shard of checks without `npm test` to cut runs them all, never none: more than asked, never less.
  const cuts = !!o.shard && e.test.some((s) => s.trim() === 'npm test');
  for (const step of e.test) {
    // One shard of the whole suite: its part of `npm test`; the other steps (a typecheck) in the first shard only.
    if (cuts) {
      if (step.trim() === 'npm test') steps.push(async () => shardSteps(dir, o.shard!, o.say));
      else if (o.shard!.index === 1) steps.push(step);
      continue;
    }
    // Only the tests the change reaches (affected.ts), where the caller asks and `npm test` is a plain node --test.
    if (o.affected && step.trim() === 'npm test') steps.push(() => affectedSteps(ctx, dir, o.affected!, o.say));
    // The whole suite, run as node itself so the checks pace sees its test runner (wholeTestSteps).
    else if (step.trim() === 'npm test') steps.push(async () => wholeTestSteps(dir));
    else steps.push(step);
  }
  for (const s of steps) for (const step of typeof s === 'string' ? [s] : await s()) {
    if (!limited && (!picks || o.affected!.chose !== undefined)) {
      limited = true;
      const t = o.timeLimit!(checkKind(picks ? o.affected : undefined), picks ? o.affected!.files : undefined);
      if (t) {
        limit = { ...t, at: started + t.ms };
        o.say(`time limit: ${t.why}`);
      }
    }
    const left = limit ? limit.at - Date.now() : undefined;
    if (limit && left! <= 0) return `${step} wasn't started: the run was at its time limit, ${limit.why}`;
    const t0 = Date.now();
    // Its tests' throwaway commits signed with nobody's key and no upkeep after them (kit/unsigned-git.ts): never pushed,
    // and each would start ssh-keygen and git maintenance.
    const r = await runLine(ctx.run, step, { cwd: dir, env: { ...o.env, ...(held ? { [TURN_HELD_ENV]: '1' } : {}), ...unsignedGitVars({ ...process.env, ...o.env }) }, paced: true, ...(left !== undefined ? { limitMs: left } : {}) });
    o.say(`${step}: ${r.code === 0 ? 'ok' : r.timedOut ? 'stopped at its time limit' : `exit ${r.code}`} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (r.code !== 0) {
      const output = `${r.out}\n${r.err}`;
      const tests = failedTests(output);
      if (o.failed) Object.assign(o.failed, { step, tests: tests.map((t) => t.name), timedOut: !!r.timedOut });
      for (const t of tests) o.say(`  failed: ${t.name}${t.error ? ` (${t.error})` : ''}`);
      for (const line of tail(output, 25).split('\n')) o.say(`  ${line}`);
      try {
        writeFileSync(checksLogOf(dir), `${step} (${r.timedOut ? 'stopped at its time limit' : `exit ${r.code}`})\n\n${output}`);
        o.say(`  its whole output: ${checksLogOf(dir)}`);
      } catch (err) {
        o.say(`  couldn't keep its output: ${(err as Error).message}`);
      }
      if (r.timedOut) return `${step} was stopped at ${limit ? `the run's time limit, ${limit.why}` : `its time limit, after ${duration(Date.now() - t0)}`}${testsLine(tests)}`;
      return `${step} failed (exit ${r.code})${testsLine(tests)}${networkNote(output)}`;
    }
  }
  // The Steward's own checks passed whole: kept by tree, so a kit released from the same code doesn't run them again (whole.ts).
  if (!o.shard) await keepWhole(ctx.run, e, { dir, chose: o.affected?.chose, env: o.env });
  return null;
}

/** What a failed run of the checks failed (runChecks' `failed`): its step, the tests it failed, and whether it ran out of time. */
export interface FailedChecks {
  step?: string;
  tests?: string[];
  timedOut?: boolean;
  /** Where they failed, when that was on two PCs (the Seneschal's, 0.2.0): "here, and on LAPTOP". The change's failure, then. */
  confirmed?: string;
}

/**
 * Whether two failed runs of the same checks failed only on flaky tests: both in the same test step, each naming the
 * tests it failed, run to the end (not stopped at a time limit, which leaves tests unrun), and no test failing in both.
 * Every test then passed in one run or the other. A failure not told by test (a typecheck, a step that failed outright)
 * never counts. Pure.
 */
export function onlyFlaky(first: FailedChecks, again: FailedChecks): boolean {
  if (!first.step || first.step !== again.step || first.timedOut || again.timedOut) return false;
  if (!first.tests?.length || !again.tests?.length) return false;
  const before = new Set(first.tests);
  return !again.tests.some((t) => before.has(t));
}

/**
 * A run of only the tests a change reaches (affected.ts): the change is the worktree's HEAD against `base` (the employee's
 * branch on origin). `chose` is filled with what was run, for the vouch's status and the PR test's note.
 */
export interface AffectedScope {
  base: string;
  /** The change itself, in place of the worktree's HEAD against `base`: a kit's trial's (kitreach.ts). */
  changed?: Changed[];
  chose?: string;
  /** How many test files it ran, once `chose` says it ran only some: a vouch's time limit allows for them (vouchtime.ts). */
  files?: number;
}

/** What a run of the checks ran: the whole suite, or only the tests a change reaches (none, at times). */
export type CheckKind = 'whole' | 'affected';

/** A scope's kind once `npm test` is picked: whole without one, or when the whole suite was picked. */
export const checkKind = (scope?: AffectedScope): CheckKind => (scope?.chose && scope.chose !== 'the whole suite' ? 'affected' : 'whole');

/** A run's time limit, and why it is that, in words. */
export interface TimeLimit {
  ms: number;
  why: string;
}

/** A duration in words: seconds under two minutes, else minutes. */
export const duration = (ms: number) => (ms < 120_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** What an AffectedScope takes of `npm test` (affectedPick): the whole suite and why, or the test files of all of them. */
export type TestPick = { whole: string } | { files: string[]; tests: string[]; why: string; flags: string[]; pretest: boolean };

/**
 * What an AffectedScope takes of `npm test` in `dir`: the test files the change reaches (none when it reaches no test),
 * with the script's flags and whether it has a pretest; or the whole suite, and why: the script isn't a plain node
 * --test, the change can't be read, or it reaches everything. A vouch's own run (affectedSteps), and what an Assayer's
 * affected pass must take in to stand in for it (assayed.ts). Never throws.
 */
export async function affectedPick(run: Runner, dir: string, scope: AffectedScope): Promise<TestPick> {
  try {
    const scripts = scriptsIn(dir);
    const plain = nodeTestScript(scripts.test);
    if (!plain) return { whole: "its test script isn't a plain node --test" };
    let changed = scope.changed;
    let patches = new Map<string, string>();
    if (!changed) {
      const names = await gitMaybe(run, dir, 'diff', '--name-status', '--no-renames', `${scope.base}...HEAD`);
      const patch = await gitMaybe(run, dir, 'diff', '--no-renames', '-U0', `${scope.base}...HEAD`);
      if (names === null || patch === null) return { whole: `git couldn't compare it with ${scope.base}` };
      changed = names
        .split('\n')
        .map((l) => l.trim().split('\t'))
        .filter((p) => p.length >= 2)
        .map(([status, file]) => ({ status, path: file }));
      patches = patchesByFile(patch);
    }
    // The Steward's own repository fills its kit from its kit\: a kit file reaches its copies there.
    const kitFrom = kitFromOf(dir, scripts);
    const a = affectedTests({ dir, changed, testGlobs: plain.globs, patchOf: (f) => patches.get(f) ?? '', ...(kitFrom ? { kitFrom } : {}) });
    if (a.all) return { whole: a.why };
    return { files: a.files, tests: a.tests, why: a.why, flags: plain.flags, pretest: !!scripts.pretest };
  } catch (err) {
    return { whole: `couldn't work out which: ${(err as Error).message}` };
  }
}

/**
 * What runs in place of `npm test` for an AffectedScope (affectedPick): its pretest, then `node <its flags> --test <the
 * affected files>`; nothing when no test reaches the change; `npm test` itself for the whole suite. Never throws.
 */
export async function affectedSteps(ctx: Ctx, dir: string, scope: AffectedScope, say: (line: string) => void): Promise<string[]> {
  const p = await affectedPick(ctx.run, dir, scope);
  if ('whole' in p) {
    scope.chose = 'the whole suite';
    say(`npm test: the whole suite (${p.whole})`);
    return wholeTestSteps(dir);
  }
  const pretest = p.pretest ? ['npm run pretest'] : [];
  if (!p.files.length) {
    scope.chose = 'no test reaches the change';
    say(`npm test: skipped, no test reaches the change (${p.why})`);
    return pretest;
  }
  scope.chose = `affected: ${p.files.length} of ${p.tests.length} test files`;
  scope.files = p.files.length;
  say(`npm test: ${scope.chose} (${p.why})`);
  return [...pretest, ['node', ...p.flags, '--test', ...p.files.map((f) => `"${f}"`)].join(' ')];
}

/**
 * What runs in place of `npm test` for the whole suite: its pretest, then the script's own `node <flags> --test <globs>`
 * run as node itself, as only the tests a change reaches already were (affectedSteps). The checks pace then sees node's
 * test runner and runs as many test files at once as its cap has room for (kit/node/checks-pace.ts,
 * pacedTestConcurrency). Through npm it couldn't: node's runner started a file per processor but one, 17 on an 18-thread
 * laptop, every one held to a third of the processor, and tests with timers of their own failed for want of it (the
 * whole suite before kit 2.74.5's release, twice, on 2026-10-15). Its posttest after, as npm runs it, once the tests
 * pass (the steps stop at the first that fails). `npm test` as it is when the script isn't a plain node --test. Pure but
 * for package.json.
 */
export function wholeTestSteps(dir: string): string[] {
  const scripts = scriptsIn(dir);
  const plain = nodeTestScript(scripts.test);
  if (!plain) return ['npm test'];
  return [
    ...(scripts.pretest ? ['npm run pretest'] : []),
    ['node', ...plain.flags, '--test', ...plain.globs.map((g) => `"${g}"`)].join(' '),
    ...(scripts.posttest ? ['npm run posttest'] : []),
  ];
}

/**
 * The test files `npm test` runs in `dir`, by name (its plain node --test's globs, as affected.ts reads them), with the
 * script's flags and whether it has a pretest and a posttest; null when the script isn't a plain node --test. Pure but for
 * the files in `dir`.
 */
export function wholeTestFiles(dir: string): { files: string[]; flags: string[]; pretest: boolean; posttest: boolean } | null {
  const scripts = scriptsIn(dir);
  const plain = nodeTestScript(scripts.test);
  if (!plain) return null;
  const globs = plain.globs.map(globRe);
  const files = filesIn(dir).filter((f) => globs.some((g) => g.test(f))).sort();
  return { files, flags: plain.flags, pretest: !!scripts.pretest, posttest: !!scripts.posttest };
}

/** A shard's part of `files` (sorted by name): dealt out in turn, so each PC at the same commit deals the same. Pure. */
export const dealt = (files: string[], shard: SeneschalShard): string[] => files.filter((_, i) => i % shard.of === shard.index - 1);

/**
 * What runs in place of `npm test` for one shard of the whole suite (Steward 0.36.92): its pretest (each shard sets the
 * code up), `node <its flags> --test <its part of the test files>` (dealt), and in the last shard its posttest, which npm
 * runs once after the tests. The whole suite (wholeTestSteps) when the script isn't a plain node --test to cut: more than
 * asked, never less. Pure but for the files in `dir`.
 */
export function shardSteps(dir: string, shard: SeneschalShard, say: (line: string) => void = () => {}): string[] {
  const t = wholeTestFiles(dir);
  if (!t) {
    say(`npm test: the whole suite, as its test script isn't a plain node --test to cut into shards`);
    return wholeTestSteps(dir);
  }
  const mine = dealt(t.files, shard);
  say(`npm test: shard ${shard.index} of ${shard.of}, ${mine.length} of ${t.files.length} test files`);
  return [
    ...(t.pretest ? ['npm run pretest'] : []),
    ...(mine.length ? [['node', ...t.flags, '--test', ...mine.map((f) => `"${f}"`)].join(' ')] : []),
    ...(t.posttest && shard.index === shard.of ? ['npm run posttest'] : []),
  ];
}

/** A `git diff` cut into each file's part, by its path (the b/ side; the a/ side for a deletion). Pure. */
export function patchesByFile(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(part);
    if (m) out.set(m[2] === '/dev/null' ? m[1] : m[2], part);
  }
  return out;
}

/** Where runChecks keeps the whole output of the step that failed in a worktree: beside it, as <worktree>.log. */
export const checksLogOf = (dir: string) => `${dir}.log`;

/** How many failed steps' outputs kit trials keep (kitTrialLogOf), the newest. */
export const KEPT_TRIAL_LOGS = 40;

/**
 * Where a kit's trial keeps an agent's failed step's whole output: a file for each agent and kit, apart from the log
 * beside its trial's worktree, which the agent's next try clears (its checks without the kit, its pair, another kit's
 * trial). The trial's comment and the Wright's issue point to it.
 */
export const kitTrialLogOf = (s: Ctx['settings'], e: Employee, kit: string) => path.join(workRootOf(s), '_kit-trial-logs', `${e.id}-kit-${kit}.log`);

/**
 * The failed step's output beside a trial's worktree, copied to kitTrialLogOf (the oldest beyond KEPT_TRIAL_LOGS
 * removed), and the first distinct lines in it that say what went wrong (errorLines). Null when there is none, or it
 * couldn't be kept. Never throws.
 */
export function keepTrialLog(s: Ctx['settings'], e: Employee, kit: string, dir: string): { log: string; errors: string[] } | null {
  try {
    const text = readFileSync(checksLogOf(dir), 'utf8');
    const log = kitTrialLogOf(s, e, kit);
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log, text);
    const all = readdirSync(path.dirname(log))
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(path.dirname(log), f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const old of all.slice(KEPT_TRIAL_LOGS)) rmSync(old, { force: true });
    // Its first line names the step and its exit, then a blank one: what the step printed follows.
    return { log, errors: errorLines(text.replace(/\r/g, '').split('\n').slice(2).join('\n')) };
  } catch {
    return null;
  }
}

/** `: "name" (its error)`, for the tests that failed, so a failure's message (and its alarm) says which. */
export function testsLine(tests: { name: string; error: string | null }[]): string {
  if (!tests.length) return '';
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const named = tests.slice(0, 2).map((t) => `"${cut(t.name, 100)}"${t.error ? ` (${cut(t.error, 100)})` : ''}`);
  return `: ${named.join('; ')}${tests.length > 2 ? ` and ${tests.length - 2} more` : ''}`;
}

/** kit.json's text with its pin moved to `kit`, everything else as it was. */
export function repin(text: string, kit: string): string {
  return pinText({ ...JSON.parse(text.replace(/^﻿/, '')), kit });
}

/** How a trial's result begins when the agent fails its checks without the kit as well (trial.ts counts it apart). */
export const WITHOUT_THE_KIT = 'fails its checks without kit';

/**
 * A trial's worktree put back as its main has it (nothing was committed: the bump's files and the kit filled from the
 * PR go, its node_modules stays), and the same checks run there, once: the failure they give, or null when they pass.
 * On 2026-10-13 kit 2.69.0 "failed" 22 agents for a reason that was this PC's (its work folder had moved to a drive
 * where esbuild follows no link), and Reeve for 4 tests failing on its main: each held the kit, and every Steward PR
 * behind it, though none was the kit's doing.
 */
async function withoutTheKit(ctx: Ctx, e: Employee, dir: string, o: { say: (line: string) => void; affected?: AffectedScope }): Promise<string | null> {
  try {
    await git(ctx.run, dir, 'reset', '--quiet', '--hard', 'HEAD');
    await git(ctx.run, dir, 'clean', '-fdxq', '-e', 'node_modules');
  } catch (err) {
    o.say(`couldn't put it back as its main has it, to run its checks without the kit: ${(err as Error).message}`);
    return null;
  }
  o.say('its checks without the kit, as its main has it, to see whether the kit is why they fail');
  // Run here, whatever passed elsewhere: the question is whether this PC fails its main.
  return runChecks(ctx, e, dir, { ...o, here: true, doing: 'its checks without the kit' });
}

export async function bumpOne(ctx: Ctx, e: Employee, o: BumpOptions): Promise<EmployeeResult> {
  const { run } = ctx;
  const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
  if (!e.usesKit) return result(e, 'skipped', NOT_ON_KIT);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  // A fold starts from its open kit PR's branch, not the employee's own (the rollout's: rollout.ts).
  const fold = o.trial || o.base ? undefined : o.folds?.[e.id];
  const base = o.base ?? `origin/${fold ? fold.head : e.branch}`;
  if (!o.base) await fetchBranch(run, repo, e.branch);
  if (fold) await fetchBranch(run, repo, fold.head);
  const baseCommit = await commitOf(run, repo, base);
  if (!baseCommit) return result(e, 'refused', `no ${base} in ${repo}`);

  const pinRaw = await showFile(run, repo, base, 'kit.json');
  const pin = readPin(pinRaw);
  if (!pin) return result(e, 'refused', `${base} has no kit.json`);
  if (pin.kit === o.kit) return result(e, 'skipped', `already on kit ${o.kit}`);
  // The kit the employee's branch pins: a fold's changelog entry covers every kit since, not only since its PR's.
  const from = fold ? (readPin(await showFile(run, repo, `origin/${e.branch}`, 'kit.json'))?.kit ?? pin.kit) : pin.kit;

  // The tools/kit.ts it gets: the Steward's, read before anything is made.
  const toolFile = o.tool ?? stewardToolFile();
  const tool = takesTool(e.fill) ? (existsSync(toolFile) ? readFileSync(toolFile, 'utf8') : null) : undefined;
  if (tool === null) return result(e, 'refused', `the Steward has no ${TOOL} to hand out (${toolFile})`);

  // What the kit changes for it (kitreach.ts): a trial's, and the rollout's (0.35.68). A trial of an agent the kit
  // changes nothing for isn't tried: its checks would run its own main's code. The rollout still bumps it, with its fill,
  // typecheck and pretest but no tests; one whose kit files change runs the tests they reach, as its trial did.
  const reach = o.reach ? await o.reach(e, pin, tool !== undefined && lf((await showFile(run, repo, base, TOOL)) ?? '') !== lf(tool)) : null;
  if (reach && 'none' in reach && o.trial) return result(e, 'skipped', `kit ${pin.kit} → ${o.kit}: not tried, ${reach.none}`, { base: baseCommit });
  const scope: AffectedScope | undefined = reach && 'files' in reach ? { base: baseCommit, changed: reach.files } : reach && 'none' in reach ? { base: baseCommit, changed: [] } : undefined;
  if (reach && 'all' in reach) say(`all its checks: ${reach.all}`);
  if (reach && 'none' in reach) say(`no tests for the kit: ${reach.none}`);

  const branch = o.trial ? trialBranch(o.kit) : fold ? fold.head : bumpBranch(o.kit);
  if (!o.trial && !fold && (await onOrigin(run, repo, branch))) return result(e, 'refused', `${branch} is already on origin: merge or close its PR first (a bump is never force-pushed)`);
  // A bump made here before and not pushed is made again, from scratch.
  const dir = o.trial ? trialDirOf(ctx.settings, e) : bumpDirOf(ctx.settings, e);
  for (const line of await removeWorktree(run, repo, dir, branch)) say(line);
  rmSync(checksLogOf(dir), { force: true });
  await freshWorktree(run, ctx.settings, repo, dir, base, '--no-track', '-b', branch);
  say(`worktree ${dir} on ${branch}, from ${base} (${baseCommit.slice(0, 7)})`);

  writeFileSync(path.join(dir, 'kit.json'), repin(pinRaw!, o.kit));
  const toolAt = path.join(dir, ...TOOL.split('/'));
  const toolChanged = tool !== undefined && (!existsSync(toolAt) || lf(readFileSync(toolAt, 'utf8')) !== lf(tool));
  if (toolChanged) {
    mkdirSync(path.dirname(toolAt), { recursive: true });
    writeFileSync(toolAt, lf(tool!));
    say(`${TOOL}: the Steward's`);
  }
  const texts = e.versionFiles.map((f) => [f, existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : null] as [string, string | null]);
  const agreed = agreedVersion(texts);
  if ('error' in agreed) return result(e, 'failed', agreed.error, { base: baseCommit });
  // A trial's branch is never pushed, so it claims nothing. A version that can't be claimed (GitHub out of reach) is no
  // bump: the next patch could be another PR's, and the rounds try again. A fold keeps its PR's version, claimed when
  // that PR was bumped: one PR, one version.
  let next = fold ? agreed.version : bumpPatch(agreed.version);
  if (!o.trial && !fold) {
    try {
      next = (await claimVersion(ctx, e, { branch, by: 'steward', for: `the Steward's kit ${o.kit}` })).claim.version;
    } catch (err) {
      return result(e, 'failed', `couldn't claim a version for the bump: ${(err as Error).message}`);
    }
  }
  try {
    for (const [f, t] of texts) writeFileSync(path.join(dir, f), setVersion(f, t!, agreed.version, next));
  } catch (err) {
    return result(e, 'failed', (err as Error).message, { base: baseCommit });
  }
  say(`kit.json: ${pin.kit} → ${o.kit}; ${fold ? `version ${next} as PR #${fold.number} has it` : `version ${agreed.version} → ${next}`} in ${e.versionFiles.join(', ')}`);
  // The new version's entry, so its release's notes say what it brings: a fold's, its PR's entry written again.
  const logAt = path.join(dir, CHANGELOG);
  const logText = existsSync(logAt) ? readFileSync(logAt, 'utf8') : null;
  const entry = kitBumpEntry({ version: next, from, kit: o.kit, changelog: o.changelog ?? null });
  writeFileSync(logAt, fold ? replacingEntry(logText, entry, e.name) : withEntry(logText, entry, e.name));
  say(`${CHANGELOG}: the entry for ${next}${logText === null ? ' (a new changelog)' : fold ? `, for every kit since ${from}` : ''}`);

  // A failure is tried once more, as a PR's checks are here (prtest.ts): a round bumps several employees at once, and a
  // test that keeps time can fail under that load and pass alone. Failing twice is the bump's failure.
  const env: Record<string, string> = o.kitFrom ?{ STEWARD_KIT: path.resolve(o.kitFrom) } : {};
  // The kit's trial passed it from this very commit, with the kit as released and the same tools/kit.ts (trialpass.ts):
  // the same checks on the same files but for the version, so they aren't run a second time.
  const tried = o.trial || fold || o.kitFrom ? null : await trialPassOf(ctx, e, { kit: o.kit, base: baseCommit, ...(tool !== undefined ? { tool } : {}) }).catch(() => null);
  if (tried) say(`its checks not run again: ${tried}`);
  const task: CheckTask | undefined = o.trial ? { kind: 'kit-trial' } : undefined;
  const first = tried ? null : await runChecks(ctx, e, dir, { env, say, affected: scope, doing: `the bump to kit ${o.kit}`, task });
  if (first) {
    say(`its checks once more (${first})`);
    const again = await runChecks(ctx, e, dir, { env, say, affected: scope, doing: `the bump to kit ${o.kit}`, task });
    // A trial's failed step kept apart, before its checks without the kit write theirs beside the worktree.
    const kept = again && o.trial ? keepTrialLog(ctx.settings, e, o.kit, dir) : null;
    // A trial's failure isn't the kit's when the agent fails the very same way without it, on its main as it is. Failing
    // otherwise there (its own kit couldn't be fetched, say) says nothing, and the failure stands.
    const alone = again && o.trial ? await withoutTheKit(ctx, e, dir, { say, affected: scope }) : null;
    if (alone && alone === again) return result(e, 'skipped', `${WITHOUT_THE_KIT} ${o.kit} too, so not the kit's doing: ${alone}`, { base: baseCommit });
    if (alone) say(`without the kit it fails otherwise (${alone}): the failure stands`);
    if (again) return result(e, 'failed', `${again}${again === first ? ', twice' : ` (the first time: ${first})`}; ${o.trial ? '' : `the worktree is left at ${dir}, `}the failed step's whole output in ${kept?.log ?? checksLogOf(dir)}`, { version: next, base: baseCommit, ...(alone ? { without: alone } : {}), ...(kept?.errors.length ? { errors: kept.errors } : {}) });
  }
  // Only the tests the kit reaches ran: its rollout's bump runs the same ones, so the trial's pass is kept all the same.
  const partial = !!scope?.chose && scope.chose !== 'the whole suite';
  if (o.trial) return result(e, 'done', `kit ${pin.kit} → ${o.kit}: checks passed${partial ? ` (${scope!.chose})` : ''}${first ? ` on a second try (the first: ${first})` : ''}`, { version: next, base: baseCommit, ...(partial ? { partial } : {}) });
  const secondTry = tried ? ` in the kit's trial (${tried}), not run again` : first ? ` on a second try (the first: ${first}; its output is in ${checksLogOf(dir)})` : '';

  await git(run, dir, 'add', '--', 'kit.json', CHANGELOG, ...e.versionFiles, ...(toolChanged ? [TOOL] : []));
  const toolLine = toolChanged ? ` ${TOOL} is the Steward's.` : '';
  const what = fold
    ? `kit.json pins the Steward's kit ${o.kit} (this PR, #${fold.number}, brought ${pin.kit}: the newer kit goes onto it rather than a PR of its own); the version stays ${next}, and ${CHANGELOG}'s entry for it covers every kit since ${from}.`
    : `kit.json pins the Steward's kit ${o.kit} (it pinned ${pin.kit}); the version is ${next} in ${e.versionFiles.join(', ')}, and ${CHANGELOG} has its entry.`;
  await git(run, dir, 'commit', '--quiet', '-m', `${e.name} ${next}: the Steward's kit ${o.kit}`, '-m', `${what}${toolLine} Made by steward bump.${tried ? ` Its checks passed in the kit's trial from the same commit (${tried}), so they weren't run again.` : first ? ` Its checks passed on a second try; the first failed: ${first}.` : ''}`);
  const full = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
  const commit = full.slice(0, 7);
  // Passed with the kit's release, as anyone can fetch it: the Surveyor's GET /api/tested (tested.ts). Not a trial's kit
  // tree, nor one whose checks the trial ran (nothing ran at this commit).
  if (!o.kitFrom && !tried) recordTested(e.id, { commit: full, stage: 'bump', branch, version: next });
  const back =compareVersions(o.kit, pin.kit) < 0 ? ' (a step back to an older kit)' : '';
  return result(e, 'done', `${next} on ${branch} (${commit}): kit ${pin.kit} → ${o.kit}${back}${fold ? `, onto its open PR #${fold.number}` : ''}${toolChanged ? `, ${TOOL} updated` : ''}, checks passed${secondTry}${o.kitFrom ? ` with the kit from ${o.kitFrom}` : ''}`, { version: next, commit });
}

export async function bump(ctx: Ctx, employees: Employee[], o: BumpOptions): Promise<EmployeeResult[]> {
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await withRepo(ctx.log, e.id, () => bumpOne(ctx, e, o));
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return result(e, 'failed', (err as Error).message);
    }
  });
}
