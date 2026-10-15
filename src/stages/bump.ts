import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimVersion } from '../claims.ts';
import { changelogBetween, compareVersions, lf, pinText } from '../kitfiles.ts';
import { CHANGELOG, HEADINGS, headingVersion, headlineOf, NOTHING_TO_DO, sectionOf, withEntry } from '../kit/notes.ts';
import { unsignedGitVars } from '../kit/unsigned-git.ts';
import { commitOf, fetchBranch, git, gitMaybe, onOrigin, removeWorktree, showFile } from '../git.ts';
import { affectedTests, kitFromOf, nodeTestScript, scriptsIn, type Changed } from '../affected.ts';
import type { KitReach } from './kitreach.ts';
import { stewardToolFile, takesTool, TOOL } from '../kitsource.ts';
import { failedTests, runLine, tail, type Runner } from '../run.ts';
import type { Employee } from '../settings.ts';
import { agreedVersion, bumpPatch, setVersion } from '../versions.ts';
import { bumpBranch, bumpDirOf, checkoutOf, mapLimit, networkNote, NOT_ON_KIT, result, freshWorktree, workRootOf, type Ctx, type EmployeeResult, type KitFold } from './common.ts';
import { installLines } from '../installscripts.ts';
import { guardPackages, linkSharedModules } from './modules.ts';
import { readPin } from './staff.ts';
import { recordTested } from '../tested.ts';
import { keepWhole } from '../whole.ts';
import { trialPassOf } from './trialpass.ts';
import { withRepo } from './slots.ts';

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
 * it runs the whole suite or only the tests a change reaches: at once, unless `npm test` is picked, then as it is. A step
 * still running at the limit is stopped with everything it started, and the run fails saying so.
 */
export async function runChecks(ctx: Ctx, e: Employee, dir: string, o: { env?: Record<string, string>; say: (line: string) => void; affected?: AffectedScope; doing?: string; timeLimit?: (kind: CheckKind) => TimeLimit | null }): Promise<string | null> {
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
      return `its packages weren't installed: ${g.held}`;
    }
    if (!(await linkSharedModules(ctx, dir, o.say, g.plan))) before.push(...installLines(g.plan));
  }
  if (e.fill) before.push(e.fill);
  // Each test step worked out once the dependencies and the kit are in place, so the kit's files are there to follow.
  const steps: (string | (() => Promise<string[]>))[] = [...before];
  for (const step of e.test) {
    // Only the tests the change reaches (affected.ts), where the caller asks and `npm test` is a plain node --test.
    if (o.affected && step.trim() === 'npm test') steps.push(() => affectedSteps(ctx, dir, o.affected!, o.say));
    else steps.push(step);
  }
  for (const s of steps) for (const step of typeof s === 'string' ? [s] : await s()) {
    if (!limited && (!picks || o.affected!.chose !== undefined)) {
      limited = true;
      const t = o.timeLimit!(checkKind(picks ? o.affected : undefined));
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
    const r = await runLine(ctx.run, step, { cwd: dir, env: { ...o.env, ...unsignedGitVars({ ...process.env, ...o.env }) }, paced: true, ...(left !== undefined ? { limitMs: left } : {}) });
    o.say(`${step}: ${r.code === 0 ? 'ok' : r.timedOut ? 'stopped at its time limit' : `exit ${r.code}`} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (r.code !== 0) {
      const output = `${r.out}\n${r.err}`;
      const tests = failedTests(output);
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
  await keepWhole(ctx.run, e, { dir, chose: o.affected?.chose, env: o.env });
  return null;
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
    return ['npm test'];
  }
  const pretest = p.pretest ? ['npm run pretest'] : [];
  if (!p.files.length) {
    scope.chose = 'no test reaches the change';
    say(`npm test: skipped, no test reaches the change (${p.why})`);
    return pretest;
  }
  scope.chose = `affected: ${p.files.length} of ${p.tests.length} test files`;
  say(`npm test: ${scope.chose} (${p.why})`);
  return [...pretest, ['node', ...p.flags, '--test', ...p.files.map((f) => `"${f}"`)].join(' ')];
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
  return runChecks(ctx, e, dir, { ...o, doing: 'its checks without the kit' });
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
  const first = tried ? null : await runChecks(ctx, e, dir, { env, say, affected: scope, doing: `the bump to kit ${o.kit}` });
  if (first) {
    say(`its checks once more (${first})`);
    const again = await runChecks(ctx, e, dir, { env, say, affected: scope, doing: `the bump to kit ${o.kit}` });
    // A trial's failure isn't the kit's when the agent fails the very same way without it, on its main as it is. Failing
    // otherwise there (its own kit couldn't be fetched, say) says nothing, and the failure stands.
    const alone = again && o.trial ? await withoutTheKit(ctx, e, dir, { say, affected: scope }) : null;
    if (alone && alone === again) return result(e, 'skipped', `${WITHOUT_THE_KIT} ${o.kit} too, so not the kit's doing: ${alone}`, { base: baseCommit });
    if (alone) say(`without the kit it fails otherwise (${alone}): the failure stands`);
    if (again) return result(e, 'failed', `${again}${again === first ? ', twice' : ` (the first time: ${first})`}; ${o.trial ? '' : `the worktree is left at ${dir}, `}the failed step's whole output in ${checksLogOf(dir)}`, { version: next, base: baseCommit, ...(alone ? { without: alone } : {}) });
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
