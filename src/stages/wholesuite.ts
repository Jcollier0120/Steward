import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { APP } from '../app.ts';
import { commitOf, fetchBranch, removeWorktree, showFile } from '../git.ts';
import { STEWARD_BRANCH } from '../glance.ts';
import { alive } from '../kit/apart.ts';
import { endProcesses } from '../kit/native.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Runner } from '../run.ts';
import { treeOf, wholePassOf } from '../whole.ts';
import { onlyFlaky, runChecks, type FailedChecks } from './bump.ts';
import { freshWorktree, interrupted, workRootOf, type Ctx } from './common.ts';
import { stewardEmployee } from './selfmerge.ts';
import { apart } from './slots.ts';
import { phaseOf, timed } from '../buildtimes.ts';
import type { StoodIn } from './standin.ts';

/**
 * The whole suite before a kit's release. A vouch and a PR tested here run only the tests each change reaches
 * (affected.ts), so before the Steward releases a kit from its own main (self.ts), which every agent then takes, its whole
 * suite runs at that commit, unless that very code passed whole on this PC already (whole.ts: a vouch or a PR test whose
 * change reached everything, a train). A test the selection missed then holds the kit's release, as a failed release does
 * (self-failed.json, an alarm at once, tried again once a new commit lands on main), instead of reaching every agent. A
 * failure is run once more first, as a PR's checks are (prtest.ts); one Windows ended isn't held, the next round runs it
 * again; nor are two runs whose failing tests each passed in the other (onlyFlaky).
 *
 * On the Steward's page (agent.ts: wholeSuitesBeside) it runs beside the rounds, never inside one (Steward 0.36.45): run
 * twice inside the round, a slow or paced suite held every merge for 45 minutes to two hours on 2026-10-14 and 15, until
 * the round was let go at its limit with its tests still running and its worktree locked. Asked for a kit's commit, the
 * round starts it as a job of its own, keyed by the kit's tag and that commit, and goes on at once: the kit waits. Later
 * rounds read what it came to: passed (or flaky) releases the kit, failed is held as above, still running waits, and
 * never with a second run beside it. A new commit on main supersedes it (stopped, and one started at that commit); so does
 * a kit no longer waiting for one. It ends when the Steward stops, with everything it started (endWholeSuite), and one a
 * Steward that is gone left running is ended before the next starts (endWholeOrphans): whole-suite.json keeps what it
 * runs. In a terminal round, and under node --test unless a test says otherwise, it runs inside the round as before.
 *
 * The Steward's own release (v<version>), made after every merge, isn't held for it: that would be the whole suite once a
 * PR, more than the affected tests save. The Surveyor runs its whole suite on main once a day (or the Assayer's daily
 * health check does), as every agent's.
 */

/** Whether a package.json's text has a test script to run. Pure. */
export function testScriptAt(packageJson: string | null): boolean {
  try {
    return !!JSON.parse((packageJson ?? '').replace(/^﻿/, '')).scripts?.test;
  } catch {
    return false;
  }
}

/** The worktree the gate runs the whole suite in. */
export const wholeDirOf = (ctx: Ctx) => path.join(workRootOf(ctx.settings), `_${APP.id}-whole`);

/**
 * Why a kit may not be released yet. `retry`: a later round asks again, rather than holding it as a failed release
 * (Windows ended the run, or it runs beside the rounds: `beside`).
 */
export interface WholeHold {
  why: string;
  retry: boolean;
  beside?: boolean;
}

/** A whole suite run beside the rounds, as whole-suite.json keeps it. */
export interface WholeJob {
  tag: string;
  commit: string;
  /** Running, or what it came to: passed, flaky (released all the same), failed (held), ended (by Windows, or stopped). */
  state: 'running' | 'passed' | 'flaky' | 'failed' | 'ended';
  /** What it came to, in words, once it ended. */
  why?: string;
  startedAt: string;
  endedAt?: string;
  /** The Steward process running it. */
  by: number;
  /** The programs it is running now, each of whose trees is ended with it. */
  pids: number[];
}

export const wholeJobFile = () => dataFile('whole-suite.json');
export const loadWholeJob = (): WholeJob | null => readJson<WholeJob | null>(wholeJobFile(), null);
const saveJob = (job: WholeJob) => writeJson(wholeJobFile(), job);

const keyOf = (o: { tag: string; commit: string }) => `${o.tag}@${o.commit}`;

/** What a whole suite came to. */
interface Verdict {
  verdict: Exclude<WholeJob['state'], 'running'>;
  why: string;
}

/**
 * Set by the Steward's page (agent.ts): the whole suite then runs beside the rounds, `ended` told when one ends (a round
 * then settles it at once) and its lines going to `log`. Unset (a round in a terminal, the tests), it runs inside the round.
 */
let beside: { ended?: (job: WholeJob) => void; log?: (line: string) => void } | null = null;
let exitHooked = false;
export function wholeSuitesBeside(o: typeof beside): void {
  beside = o;
  // However the process ends with one running (POST /api/stop calls endWholeSuite first), it ends with it.
  if (o && !exitHooked) {
    exitHooked = true;
    process.once('exit', () => endWholeSuite());
  }
}

/** The whole suite running beside the rounds in this process: one at a time, in the one worktree. */
let going: { key: string; job: WholeJob; stop: AbortController; done: Promise<void>; why?: string } | null = null;

/** Settles once the whole suite running beside the rounds has ended and left its worktree (at once when none runs). */
export const wholeSuiteDone = (): Promise<void> => going?.done ?? Promise.resolve();

/** How long a round waits for a superseded run to stop and leave its worktree, before it goes on. */
const STOP_WAIT_MS = 60_000;
/** How long a run another Steward process runs (one still alive) is left to it, before it is taken for a stale record. */
const ELSEWHERE_MS = 12 * 3600_000;

/** "12 minutes", "1 h 5 min": how long ago `iso` was, in words. Pure. */
export function agoWords(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (m < 1) return 'less than a minute';
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The hold of a kit whose whole suite runs beside the rounds now. */
const runningHold = (job: WholeJob, now = Date.now()): WholeHold => ({
  why: `its whole suite runs beside the rounds at ${job.commit.slice(0, 7)}, started ${agoWords(job.startedAt, now)} ago: the rounds go on merging meanwhile, and the first after it passes releases it`,
  retry: true,
  beside: true,
});

/** What a verdict means for the kit: null to release it, else why not and whether a later round tries again. Pure. */
const holdOf = (v: Verdict): WholeHold | null => (v.verdict === 'passed' || v.verdict === 'flaky' ? null : { why: v.why, retry: v.verdict === 'ended' });

/**
 * The whole suite run in `dir`, once more after a failure: what it came to. `stopped` says why it was stopped, once it
 * was (beside the rounds), so a run cut short is never taken for a failure.
 */
async function runWhole(ctx: Ctx, repo: string, dir: string, o: { tag: string; commit: string }, say: (line: string) => void, stopped: () => string | null = () => null): Promise<Verdict> {
  const at = o.commit.slice(0, 7);
  say(`${o.tag}: the whole suite first, at ${at} in ${dir}, as its PRs ran only the tests each change reached`);
  const e = stewardEmployee(ctx.settings, repo);
  const firstFailed: FailedChecks = {};
  const againFailed: FailedChecks = {};
  const cut = (): Verdict | null => {
    const why = stopped();
    return why ? { verdict: 'ended', why: `its whole suite at ${at} was stopped: ${why}` } : null;
  };
  const stoodIn: StoodIn = {};
  const first = await runChecks(ctx, e, dir, { say, failed: firstFailed, stoodIn });
  // The whole checks already passed on exactly this code (standin.ts): here, in the Assayer, or on another PC.
  if (!first && stoodIn.by) {
    const why = `the whole suite passed ${stoodIn.where} at ${at}, not run again`;
    say(`${o.tag}: ${why}`);
    return { verdict: 'passed', why };
  }
  const ended = (failed: string): Verdict => ({ verdict: 'ended', why: `Windows ended its whole suite at ${at} (${failed})` });
  if (first) {
    const c = cut();
    if (c) return c;
  }
  if (first && interrupted(first)) return ended(first);
  if (first) say(`its whole suite once more (${first})`);
  const again = first ? await runChecks(ctx, e, dir, { say, failed: againFailed }) : null;
  if (again) {
    const c = cut();
    if (c) return c;
  }
  if (again && interrupted(again)) return ended(again);
  // Each failing test passed in the other run: flaky, not a test the selection missed, so the kit isn't held for it (on
  // 2026-10-15 kit 2.74.5 was, a test of the console the first time, a timeout's the second, each passing in the other).
  if (again && onlyFlaky(firstFailed, againFailed)) {
    const why = `its whole suite failed twice at ${at}, but no test failed both times, each passing in the other run: flaky, released all the same (the first time: ${first}; the second: ${again})`;
    say(`${o.tag}: ${why}`);
    return { verdict: 'flaky', why };
  }
  if (again) return { verdict: 'failed', why: `its whole suite failed at ${at}${again === first ? ', twice' : ` (the first time: ${first})`}: ${again}` };
  const why = `the whole suite passed at ${at}${first ? ` on a second try (the first: ${first})` : ''}`;
  say(`${o.tag}: ${why}`);
  return { verdict: 'passed', why };
}

/** The worktree removed, saying so when it can't be. */
async function tidy(run: Runner, repo: string, dir: string, say: (line: string) => void): Promise<void> {
  try {
    await removeWorktree(run, repo, dir);
  } catch (err) {
    say(`couldn't remove ${dir}: ${(err as Error).message}`);
  }
}

/**
 * The whole suite running beside the rounds stopped, unless it is the one for `key`: superseded (`why`), its programs
 * ended with everything they started, and waited for (STOP_WAIT_MS at most) while it leaves its worktree.
 */
async function stopUnless(key: string | null, why: string, say: (line: string) => void): Promise<void> {
  const g = going;
  if (!g || g.key === key) return;
  if (g.job.state === 'running') {
    say(`${g.job.tag}'s whole suite at ${g.job.commit.slice(0, 7)} stopped: ${why}`);
    g.why = why;
    g.stop.abort();
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([g.done, new Promise<void>((r) => (timer = setTimeout(r, STOP_WAIT_MS)))]);
  clearTimeout(timer);
}

/**
 * The round's look at the whole suite beside it, for a kit's planned release (self.ts): stopped when main moved on from
 * it (`step` at another commit) or no kit waits for one any more (`step` null), so it never runs for code nobody releases;
 * and when the Steward's own turn is another PC's (steward.ts, self.ts: `why`), whose Steward runs it there.
 */
export async function settleWholeSuite(ctx: Ctx, step: { tag: string; commit: string } | null, why?: string): Promise<void> {
  const say = (line: string) => ctx.log(`[${APP.id}] ${line}`);
  await stopUnless(step ? keyOf(step) : null, why ?? (step ? `${STEWARD_BRANCH} moved on to ${step.commit.slice(0, 7)} (${step.tag})` : `no kit on ${STEWARD_BRANCH} waits for it any more`), say);
}

/**
 * The whole suite beside the rounds ended now, with everything it started, as the Steward stops (agent.ts): its record
 * says so, and the next Steward's first round starts it again. Synchronous, so it holds in an exit handler too.
 */
export function endWholeSuite(why = 'the Steward stopped'): void {
  const g = going;
  if (!g || g.job.state !== 'running') return;
  g.why = why;
  const pids = [...g.job.pids];
  // Each program's own stop ends its tree (run.ts), at once; any that slipped past it, here.
  g.stop.abort();
  const left = pids.filter(alive);
  if (left.length) endProcesses(left);
  g.job = { ...g.job, state: 'ended', why: `its whole suite at ${g.job.commit.slice(0, 7)} was stopped: ${why}`, endedAt: new Date().toISOString(), pids: [] };
  saveJob(g.job);
}

/** The program a process id runs on Windows (tasklist's image name), or null when there's none or it can't be told. */
function imageOf(pid: number): string | null {
  if (process.platform !== 'win32') return null;
  const r = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return /^"([^"]+)"/.exec(`${r.stdout ?? ''}`.trim())?.[1] ?? null;
}

/** The programs a whole suite starts: node (npm too), the checks pace's launcher, git. A process id reused since is none of these, mostly. */
const OURS = /^(node|checks-pace-[0-9a-f]+|git)\.exe$/i;
const oursStill = (pid: number) => alive(pid) && (process.platform !== 'win32' || OURS.test(imageOf(pid) ?? ''));

/**
 * A whole suite a Steward that is gone left running (ended by Windows or a crash before endWholeSuite could run): the
 * programs it was running ended, with everything they started, and its record marked ended. At the page's start, and
 * before each run beside the rounds starts.
 */
export function endWholeOrphans(log: (line: string) => void = () => {}): void {
  const kept = loadWholeJob();
  if (!kept || kept.state !== 'running' || kept.by === process.pid) return;
  if (alive(kept.by) && Date.now() - Date.parse(kept.startedAt) < ELSEWHERE_MS) return;
  const left = kept.pids.filter(oursStill);
  if (left.length) endProcesses(left);
  const why = `the Steward that ran it (process ${kept.by}) ended before it did${left.length ? `, and the ${left.length === 1 ? 'program' : `${left.length} programs`} it left running ${left.length === 1 ? 'was' : 'were'} ended` : ''}`;
  saveJob({ ...kept, state: 'ended', why, endedAt: new Date().toISOString(), pids: [] });
  log(`[${APP.id}] ${kept.tag}'s whole suite at ${kept.commit.slice(0, 7)}: ${why}`);
}

/** The whole suite started beside the rounds in the worktree made for it, its programs' ids kept as they run. */
function startBeside(ctx: Ctx, repo: string, dir: string, o: { tag: string; commit: string }): WholeJob {
  const job: WholeJob = { tag: o.tag, commit: o.commit, state: 'running', startedAt: new Date().toISOString(), by: process.pid, pids: [] };
  saveJob(job);
  const stop = new AbortController();
  const log = beside?.log ?? ctx.log;
  const say = (line: string) => log(`[${APP.id}] ${line}`);
  const g: NonNullable<typeof going> = { key: keyOf(o), job, stop, done: Promise.resolve() };
  const live = () => g.job.state === 'running';
  // Every program it starts stops with it (run.ts's stop), and is kept in its record while it runs.
  const run: Runner = async (cmd, args, opts = {}) => {
    let pid: number | null = null;
    try {
      return await ctx.run(cmd, args, {
        ...opts,
        stop: stop.signal,
        started: (p) => {
          pid = p;
          opts.started?.(p);
          if (!live()) return;
          g.job.pids.push(p);
          saveJob(g.job);
        },
      });
    } finally {
      if (pid !== null && live()) {
        g.job.pids = g.job.pids.filter((p) => p !== pid);
        saveJob(g.job);
      }
    }
  };
  const jobCtx: Ctx = { ...ctx, run, log };
  going = g;
  g.done = apart('whole suite', () => timed(phaseOf(ctx), 'whole suite', o.tag, () => runWhole(jobCtx, repo, dir, o, say, () => (stop.signal.aborted ? (g.why ?? 'stopped') : null))))
    .catch((err: Error): Verdict => ({ verdict: stop.signal.aborted ? 'ended' : 'failed', why: `couldn't run its whole suite at ${o.commit.slice(0, 7)}: ${err.message}` }))
    .then(async (v) => {
      const stopped = stop.signal.aborted;
      // Ended by endWholeSuite already (the Steward stopping): its record stands as that wrote it.
      if (live()) {
        g.job = { ...g.job, state: v.verdict, why: v.why, endedAt: new Date().toISOString(), pids: [] };
        saveJob(g.job);
      }
      await tidy(ctx.run, repo, dir, say);
      if (going === g) going = null;
      if (!stopped) {
        say(`${o.tag}: its whole suite at ${o.commit.slice(0, 7)} ended beside the rounds (${v.verdict}): a round settles it now`);
        beside?.ended?.(g.job);
      }
    })
    .catch((err: Error) => {
      if (going === g) going = null;
      say(`${o.tag}: its whole suite beside the rounds: ${err.message}`);
    });
  return job;
}

/** The kit's hold while its whole suite runs beside the rounds (wholeSuitesBeside): started, waited for, or what it came to. */
async function besideHold(ctx: Ctx, repo: string, o: { tag: string; commit: string }, say: (line: string) => void): Promise<WholeHold | null> {
  const key = keyOf(o);
  const at = o.commit.slice(0, 7);
  // One for other code (main moved on, another kit): superseded by this commit.
  await stopUnless(key, `${STEWARD_BRANCH} moved on to ${at} (${o.tag})`, say);
  if (going?.key === key) {
    if (going.job.state === 'running') return runningHold(going.job);
    const v = { verdict: going.job.state, why: going.job.why ?? '' } as Verdict;
    say(`${o.tag}: ${v.why}`);
    return holdOf(v);
  }
  // What it came to, kept by a Steward before this one (restarted since it ended): not run again.
  endWholeOrphans(say);
  const kept = loadWholeJob();
  if (kept && keyOf(kept) === key && kept.state !== 'running' && kept.state !== 'ended') {
    say(`${o.tag}: ${kept.why ?? kept.state} (beside the rounds, ended ${agoWords(kept.endedAt ?? kept.startedAt)} ago)`);
    return holdOf({ verdict: kept.state, why: kept.why ?? `its whole suite ${kept.state} at ${at}` });
  }
  // Another Steward process runs it still (the page restarting as it updates): left to it.
  if (kept && keyOf(kept) === key && kept.state === 'running' && kept.by !== process.pid) return { ...runningHold(kept), why: `its whole suite runs beside the rounds of another Steward process (${kept.by}) at ${at}, started ${agoWords(kept.startedAt)} ago` };
  const dir = wholeDirOf(ctx);
  await removeWorktree(ctx.run, repo, dir);
  await freshWorktree(ctx.run, ctx.settings, repo, dir, o.commit, '--detach');
  if (kept?.state === 'ended' && keyOf(kept) === key) say(`${o.tag}: its whole suite at ${at} again (${kept.why})`);
  const job = startBeside(ctx, repo, dir, o);
  say(`${o.tag}: its whole suite started beside the rounds at ${at} in ${dir}: the rounds go on meanwhile`);
  return { ...runningHold(job), why: `its whole suite started beside the rounds at ${at}: the rounds go on merging meanwhile, and the first after it passes releases it` };
}

/**
 * Before a kit is released from `commit` of the Steward's checkout `repo`: null once its whole suite has passed there
 * (now, or kept from before, or beside the rounds), or when the checkout has no npm test to run; else why it may not be
 * released, and whether a later round should simply ask again (`retry`: Windows ended the run, or it runs beside the
 * rounds).
 */
export async function wholeSuiteBefore(ctx: Ctx, repo: string, o: { tag: string; commit: string }): Promise<WholeHold | null> {
  const { run } = ctx;
  const say = (line: string) => ctx.log(`[${APP.id}] ${line}`);
  if (!(await commitOf(run, repo, o.commit))) await fetchBranch(run, repo, STEWARD_BRANCH);
  const before = wholePassOf(await treeOf(run, repo, o.commit));
  if (before) {
    // A run beside the rounds for this or other code is no longer needed.
    await stopUnless(null, `its code passed whole here already`, say);
    say(`${o.tag}: its whole suite passed here at ${before.commit.slice(0, 7)} (${before.at}), the same code: not run again`);
    return null;
  }
  if (!testScriptAt(await showFile(run, repo, o.commit, 'package.json'))) return null;
  if (beside) return besideHold(ctx, repo, o, say);
  const dir = wholeDirOf(ctx);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, o.commit, '--detach');
  try {
    return holdOf(await runWhole(ctx, repo, dir, o, say));
  } finally {
    await tidy(run, repo, dir, say);
  }
}
