import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Seneschal's work client (kit 2.78.1): an agent asks the Seneschal for its turn before it runs its own work (the
 * Steward's PR checks, its kit trials), so the developer agents' work on a PC runs in one order, never more at once
 * than the PC has room for. The Seneschal is the manor's work manager; it comes with Developer Pro.
 *
 * `seneschalTurn` submits the task (a repository and a commit, never a command), then asks for that task by name every
 * few seconds until its turn comes, and hands back one of:
 *
 * - **null**: run it as before. The Seneschal isn't on this PC (no server.json in its data folder), doesn't answer, is
 *   off duty, or this PC hasn't Developer Pro; or it refused the task, or the turn didn't come in SENESCHAL_WAIT_MS (as
 *   long as a checks pace's turn may take); or this run is already inside another's turn (KIT_CHECKS_TURN, which the
 *   checks pace's launcher sets for what it starts), which asking again would hold twice.
 * - **{ reused }**: the same work on the same code passed already, running exactly these commands: nothing to run.
 * - **{ turn }**: its turn. Run the work inside `turn.hold()`, which sends the lease's heartbeats while it runs and
 *   reports what it came to. Run it without the checks pace's turn (KIT_CHECKS_TURN set for its commands): the lease is
 *   its turn, and the Seneschal counts it.
 *
 * A failure the Seneschal holds is never taken for this run's: it is asked for again (`again`), and run. Never throws:
 * a Seneschal that stops answering midway leaves the agent running its work as before.
 *
 * With other PCs on the licence (Seneschal 0.2.0, kit 2.78.22), a task may run on another of them: while it runs there
 * (`leased`) its wait isn't counted against SENESCHAL_WAIT_MS, only against SENESCHAL_RUN_MS, and the result it comes to
 * names that PC (`pc`). A failure is tried once more on another PC: a pass there is `flaky` (the first failure was the
 * PC's, not the change's), and a failure there too `confirmed`. One confirmed while this agent waited for its turn is
 * handed back as **{ failed }**: the change's failure, not run again here. After a failure its own `hold` reported, the
 * turn's `elsewhere()` waits for the try on another PC. And `seneschalWork` is a worker's side: any task of the kinds
 * and repositories it runs, this PC's or another's, at its turn.
 *
 * A whole suite may be cut into shards by test file (kit 2.78.22): each its own task (`shard`, part of its key), so the
 * PCs whose workers run it (`seneschalSiblings`) each take a part.
 *
 * The Wright's jobs and Reeve's heavy background work ask too (Seneschal 0.3.0, kit 2.80.0): the turn kinds. Only their
 * asker can run them, so the Seneschal hands out a turn and nothing else. Such a task is named by its `job` (an issue,
 * a job, an index), never by code, so it needs no commit, and it says what it `needs` of the room (`light`: no
 * processor slot; `line`: a line of the PC's own, Claude Code's). An asker that can come back later (`defer`) is told
 * so (**{ later }**) when its turn doesn't come in its wait, instead of being told to run as before; and a Wright's job
 * is never skipped for a run that finished. An older Seneschal refuses these tasks, and they run as before.
 */

export type SeneschalLane = 'person' | 'blocking' | 'normal' | 'background';
/** The kinds any worker may run, since they name code (a commit), never a command: the Steward's checks. */
export type SeneschalCheckKind = 'pr-check' | 'kit-trial' | 'full-suite';
/** The turn kinds (Seneschal 0.3.0): work only its asker can run, named by its job. Never leased to any other worker, never moved to another PC. */
export type SeneschalTurnKind = 'wright-job' | 'reeve-job';
export type SeneschalKind = SeneschalCheckKind | SeneschalTurnKind;

/** A line of this PC with a cap of its own, held besides a processor slot (the Seneschal's LINES). */
export type SeneschalLine = 'claude-code';

/** What a task needs of the room it runs in (the Seneschal's tasks.ts Needs). */
export interface SeneschalNeeds {
  /** A clone of the repository. */
  clone?: boolean;
  /** An accelerator by its id ("npu", "gpu-…"), or "any": leased only while that accelerator's line is free. */
  accelerator?: string;
  /** The memory it takes at its peak, in MB: leased only while that much is free. */
  memoryMb?: number;
  /** Takes no processor slot (a turn kind only): held back by its accelerator's line and its memory alone. */
  light?: boolean;
  /** A line of this PC it holds while it runs (a turn kind only): leased only while the line has room. */
  line?: SeneschalLine;
}

interface SeneschalTaskBase {
  /** owner/name. */
  repo: string;
  /** Its code tree's full id, when the checkout has nothing uncommitted: the same code is the same work. */
  tree?: string;
  /** For only the tests a change reaches: the commit they're picked against (part of the key). */
  base?: string;
  pr?: number;
  branch?: string;
  /** A kit trial's kit, or the kit a check runs with when it isn't the repository's own: 2.78.1, or 2.78.1-<commit>. */
  kit?: string;
  /** A kit trial's agent, by its id. */
  agent?: string;
  /** One part of a whole suite (a full-suite task only): its test files dealt out by name (part of the key). */
  shard?: SeneschalShard;
  /** The work a turn kind is about (its key): the Wright's issue "#212", or "pr#41" for a conflict run; Reeve's "repo-sync", "index:…". */
  job?: string;
  /** What it needs of the room. */
  needs?: SeneschalNeeds;
  /** How many runs it gets before it fails for good (a lost lease counts as one): 1 for work that must never start twice. */
  tries?: number;
  lane?: SeneschalLane;
  /** In words: "Reeve#212's checks". The Seneschal makes them up when left out. */
  what?: string;
  /** The agent that asks, by its id. */
  by: string;
}

/**
 * A task as the agent submits it (the Seneschal's tasks.ts Submission): what it's about, never a command. A check names
 * its commit; a turn kind names its job, and a commit only if it has one (it isn't part of its key).
 */
export type SeneschalTask = (SeneschalTaskBase & { kind: SeneschalCheckKind; /** The commit's full id. */ commit: string }) | (SeneschalTaskBase & { kind: SeneschalTurnKind; commit?: string; job: string });

/** One part of a whole suite: the `index`th of `of`, from 1. */
export interface SeneschalShard {
  index: number;
  of: number;
}

/** The most shards a whole suite is cut into (the Seneschal's MOST_SHARDS). */
export const SENESCHAL_MOST_SHARDS = 64;

/** A PC on the licence, as Manor names it. */
export interface SeneschalPc {
  id: string;
  name: string;
}

/** A finished run as the Seneschal keeps it. */
export interface SeneschalResult {
  ok: boolean;
  at: string;
  /** Its worker: "steward", or "steward on LAPTOP" for a run on another PC. */
  by: string;
  ms: number;
  note?: string;
  commands?: string[];
  /** The PC it ran on, when that was another PC on the licence. */
  pc?: SeneschalPc;
  /** A pass after a failure on another PC (`on`, by name, with that failure's note): that failure was the PC's. */
  flaky?: { on: string; note?: string };
  /** A failure after a failure on another PC (`on`, by name): the change's. */
  confirmed?: { on: string };
}

/** What a run came to, for its report. `error`: it couldn't finish (a locked clone, a time limit), and is tried again. */
export interface SeneschalOutcome {
  ok: boolean;
  error?: boolean;
  note?: string;
  commands?: string[];
}

/** A turn: the task leased to this agent. */
export interface SeneschalTurn {
  /** The task's id in the Seneschal's ledger. */
  id: string;
  /** How long its kind usually runs here, in ms. */
  usualMs: number;
  /** How long it waited for its turn, in ms. */
  waitedMs: number;
  /**
   * Runs `work` under the lease: a heartbeat every few seconds while it runs, then the report of `outcome(its value)`
   * and how long it took. A `work` that throws is reported as a run that couldn't finish, and the error thrown on.
   */
  hold<T>(work: () => Promise<T>, outcome: (value: T) => SeneschalOutcome): Promise<T>;
  /**
   * After a failure `hold` reported, the Seneschal may try the task once more on another PC on the licence (its report
   * answered `retry: 'elsewhere'`): this waits for that run and hands back its result, `flaky` (a pass there) or
   * `confirmed` (a failure there too). Null at once when it isn't tried elsewhere; null too when the first failure
   * stands (no other PC took it in time), or the Seneschal stops answering. Never throws.
   */
  elsewhere(): Promise<SeneschalResult | null>;
  /** Hands the task back unstarted (a worker that can't run it now): it spends no try, and waits for another worker. */
  giveBack(note: string): Promise<void>;
}

/**
 * A task that stands done or failed, handed back in place of its turn: a pass that stands in, or a failure confirmed on
 * two PCs. Never for a Wright's job.
 */
type SeneschalSettled = { reused: SeneschalResult; id: string } | { failed: SeneschalResult; id: string };

/**
 * `later`: the turn didn't come in its wait, and the asker said it can come back (`defer`): why it waits, in the
 * Seneschal's words. Only while the Seneschal answers and the PC is busy; never to an asker that didn't say `defer`.
 */
export type SeneschalAnswer = SeneschalSettled | { turn: SeneschalTurn } | { later: string; id: string };

/** Where the Seneschal's page listens, and its token. */
export interface SeneschalAt {
  base: string;
  token: string;
}

/** How often a task is asked for by name while it waits: well inside the Seneschal's ASKING_MS (45 s). */
export const SENESCHAL_POLL_MS = 5_000;
/**
 * Set for a run's commands, the checks pace's launcher takes no turn (checks-pace.cs' TURN_HELD): a run the Seneschal
 * handed out sets it, since its lease is its turn; and a run that finds it set is inside another's turn already.
 */
export const TURN_HELD_ENV = 'KIT_CHECKS_TURN';

/** How long a task waits for its turn before it runs as before: the checks pace's longest wait for a turn. */
export const SENESCHAL_WAIT_MS = 20 * 60_000;
/** How long a task asked for by name may run elsewhere (another worker's, another PC's) before it runs as before. */
export const SENESCHAL_RUN_MS = 2 * 3600_000;
/** How long a worker waits before it asks for work again, when the Seneschal says nothing of when. */
export const SENESCHAL_IDLE_MS = 30_000;
/** A call to the Seneschal that takes longer than this is no answer. */
const CALL_MS = 10_000;
/** Calls in a row with no answer, and the work runs as before. */
const MISSES = 3;
/** Times a task is asked for afresh (let go, or failed) before the work runs as before. */
const AFRESH = 3;

/** The Seneschal's data folder: SENESCHAL_HOME, else .seneschal in the user's home. */
export const seneschalHome = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()) => env.SENESCHAL_HOME || path.join(home, '.seneschal');

/** Its page and token, from the server.json its page writes; null when it isn't there (no Seneschal, or never started). */
export function seneschalAt(dir = seneschalHome()): SeneschalAt | null {
  try {
    const s = JSON.parse(readFileSync(path.join(dir, 'server.json'), 'utf8').replace(/^﻿/, ''));
    return Number.isInteger(s.port) && s.port > 0 && typeof s.token === 'string' && s.token ? { base: `http://127.0.0.1:${s.port}`, token: s.token } : null;
  } catch {
    return null;
  }
}

/** Whether a pass ran exactly the commands this run would (none given: any pass of the work stands). Pure. */
export function sameCommands(ran: string[] | undefined, wanted: string[] | undefined): boolean {
  if (!wanted) return true;
  const norm = (c: string[]) => c.map((x) => x.trim()).filter(Boolean);
  const a = norm(ran ?? []);
  const b = norm(wanted);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface SeneschalTurnOptions {
  /** The agent that runs it, by its id. */
  worker: string;
  /** Which of its slots, in words. */
  slot?: string;
  /** The commands this run runs: a pass stands in only when it ran exactly these. */
  commands?: string[];
  /** A line for the agent's log. */
  say?: (line: string) => void;
  /** Told each new reason it waits (the room is full, a merge goes first), for the agent's work status. */
  waiting?: (why: string) => void;
  /**
   * It can come back later (the Wright's next round, Reeve's): a turn that doesn't come in `waitMs`, counting all the
   * time it asks, answers `{ later }` instead of null, so the work waits rather than runs beside what fills the PC.
   * Only while the Seneschal answers: one that doesn't, or refuses the task, still answers null (run as before).
   */
  defer?: boolean;
  /** Tests: where the Seneschal is (null: none), the environment, the clock, and how often and long it asks. */
  at?: SeneschalAt | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitMs?: number;
  runMs?: number;
}

type Reply = { status: number; body: any } | null;
type Call = (route: string, body: unknown) => Promise<Reply>;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A wait in words: "45 seconds", "20 minutes". */
const howLong = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60_000)} minutes`);

/** The Seneschal these options reach: under node --test, only one the test gave a home of its own (or `at`), never this PC's. */
function seneschalFor(o: { at?: SeneschalAt | null; env?: NodeJS.ProcessEnv }): SeneschalAt | null {
  const env = o.env ?? process.env;
  return o.at !== undefined ? o.at : env.NODE_TEST_CONTEXT && !env.SENESCHAL_HOME ? null : seneschalAt(seneschalHome(env));
}

/** A POST to the Seneschal with its token: null when it doesn't answer within CALL_MS. */
const callerOf =
  (at: SeneschalAt): Call =>
  async (route, body) => {
    try {
      const r = await fetch(new URL(route, at.base), { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': at.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch {
      return null;
    }
  };

/**
 * How long a task asked for by name has waited, apart from how long it ran elsewhere (`leased`: another worker's run,
 * another PC's). Each answer's state is `saw`; the time since the last is counted as that state.
 */
function waitClock(now: () => number) {
  const start = now();
  let ran = 0;
  let since: number | null = null;
  const running = () => ran + (since !== null ? now() - since : 0);
  return {
    saw(state: unknown) {
      if (state === 'leased') since ??= now();
      else if (since !== null) {
        ran += now() - since;
        since = null;
      }
    },
    waited: () => now() - start - running(),
    ran: running,
  };
}

/** Asks the Seneschal for this task's turn: null (run it as before), a pass that stands in, or the turn. Never throws. */
export async function seneschalTurn(task: SeneschalTask, o: SeneschalTurnOptions): Promise<SeneschalAnswer | null> {
  const say = o.say ?? (() => {});
  const asBefore = (why: string): null => {
    say(`${why}: run as before`);
    return null;
  };
  const env = o.env ?? process.env;
  // Already inside another's turn (the checks pace's launcher ran this): a turn of its own would hold the PC twice.
  if (env[TURN_HELD_ENV]) return null;
  const at = seneschalFor(o);
  if (!at) return null;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? pause;
  const call = callerOf(at);
  const pollMs = o.pollMs ?? SENESCHAL_POLL_MS;
  const waitMs = o.waitMs ?? SENESCHAL_WAIT_MS;
  const runMs = o.runMs ?? SENESCHAL_RUN_MS;

  const started = now();
  // Its wait for a turn, apart from the time the task ran elsewhere meanwhile (on another PC, say): that isn't a wait.
  const clock = waitClock(now);
  let afresh = 0;
  let misses = 0;
  let lastWhy = '';
  type Submitted = { task: any } | { asBefore: string };
  const submit = async (again: boolean): Promise<Submitted> => {
    const r = await call('/api/tasks/submit', again ? { ...task, again: true } : task);
    if (!r) return { asBefore: "the Seneschal didn't answer" };
    if (r.status >= 400 || !r.body) return { asBefore: `the Seneschal refused the task: ${r.body?.error ?? `HTTP ${r.status}`}` };
    if (!r.body.task) return { asBefore: r.body.why ?? 'the Seneschal took no task' };
    return { task: r.body.task };
  };
  /**
   * A task that stands done or failed: a pass that ran these commands stands in, and so does a failure of them confirmed
   * on two PCs while this asked (`fresh`): the change's. Anything else is asked for again.
   */
  const settled = (id: string, state: string, result: SeneschalResult | null | undefined, fresh: boolean): SeneschalSettled | 'again' | 'other' => {
    if (state === 'done' && result?.ok) {
      if (sameCommands(result.commands, o.commands)) return { reused: result, id };
      return 'other';
    }
    if (fresh && state === 'done' && result && !result.ok && result.confirmed && sameCommands(result.commands, o.commands)) return { failed: result, id };
    return 'again';
  };
  // A Wright's job is never skipped for a run that finished: its issue is worked again whatever a past job came to. A
  // Seneschal from 0.3.0 never hands one back; an older one keyed by commit could, for a caller that sent a commit.
  const standsIn = (s: SeneschalSettled): SeneschalAnswer | null =>
    task.kind === 'wright-job' ? asBefore(`the Seneschal handed back a run of the Wright's ${task.job} that finished (${s.id}), which never stands in for another`) : s;
  /**
   * The turn didn't come in time: an asker that can come back later is told so while the Seneschal answers (the PC is
   * busy), with why it waits; any other, or one whose last ask went unanswered, runs as before.
   */
  const late = (id: string, why: string): SeneschalAnswer | null => {
    if (!o.defer || misses > 0) return asBefore(why);
    say(`${why}: it asks again later`);
    return { later: lastWhy || 'it waits its turn', id };
  };

  let sub = await submit(false);
  for (;;) {
    if ('asBefore' in sub) return asBefore(sub.asBefore);
    const t = sub.task;
    const id = String(t.id);
    if (t.state === 'done' || t.state === 'failed') {
      const s = settled(id, t.state, t.result, false);
      if (s === 'other') return asBefore('the Seneschal has a pass of this code that ran other checks');
      if (s !== 'again') return standsIn(s);
      if (++afresh > AFRESH) return asBefore('the Seneschal kept handing back a failure');
      sub = await submit(true);
      continue;
    }
    // Waiting (or leased elsewhere): asked for by name until its turn comes, it ends elsewhere, or the wait is too long.
    let next: Submitted | null = null;
    while (!next) {
      const r = await call('/api/tasks/lease', { worker: o.worker, id, ...(o.slot ? { slot: o.slot } : {}) });
      if (!r || r.status >= 500) {
        if (++misses >= MISSES) return asBefore('the Seneschal stopped answering');
      } else if (r.status >= 400 || !r.body) {
        return asBefore(`the Seneschal refused the lease: ${r.body?.error ?? `HTTP ${r.status}`}`);
      } else {
        misses = 0;
        const b = r.body;
        clock.saw(b.state);
        if (b.task && b.lease?.token) return { turn: turnOf({ call, say, now, sleep, pollMs, waitMs, runMs, worker: o.worker, slot: o.slot }, id, b, now() - started) };
        if (b.asBefore) return asBefore(String(b.why ?? 'the Seneschal hands out no work'));
        if (b.gone) {
          if (++afresh > AFRESH) return asBefore('the Seneschal kept letting the task go');
          next = await submit(false);
          break;
        }
        if (b.state === 'done' || b.state === 'failed') {
          const s = settled(id, b.state, b.result, true);
          if (s === 'other') return asBefore('it passed elsewhere running other checks');
          if (s !== 'again') return standsIn(s);
          if (++afresh > AFRESH) return asBefore('the Seneschal kept handing back a failure');
          next = await submit(true);
          break;
        }
        const why = String(b.why ?? 'it waits its turn');
        if (why !== lastWhy) {
          lastWhy = why;
          o.waiting?.(why);
        }
      }
      // A deferring asker's wait counts all the time it asks: it said how long it can wait, whoever runs the task meanwhile.
      if ((o.defer ? now() - started : clock.waited()) >= waitMs) return late(id, `its turn didn't come in ${howLong(waitMs)} (${lastWhy || 'no answer'})`);
      if (clock.ran() >= runMs) return late(id, `it ran elsewhere for more than ${howLong(runMs)} (${lastWhy})`);
      await sleep(pollMs);
    }
    sub = next;
  }
}

/** What a turn needs of its asker: its calls, clock and log, and how it asks for the task by name afterwards (elsewhere). */
interface TurnDeps {
  call: Call;
  say: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  waitMs: number;
  runMs: number;
  worker: string;
  slot?: string;
}

/** The turn for a lease the Seneschal gave: its heartbeats, its report, and its try on another PC after a failure. */
function turnOf(d: TurnDeps, id: string, b: any, waitedMs: number): SeneschalTurn {
  const token = String(b.lease.token);
  const heartbeatMs = Number(b.lease.heartbeatMs) > 0 ? Number(b.lease.heartbeatMs) : 15_000;
  let retried = false;
  const report = async (out: SeneschalOutcome & { returned?: boolean }, ms: number) => {
    const r = await d.call('/api/tasks/report', { id, token, ms, ...out, ...(out.note ? { note: out.note.slice(0, 500) } : {}) });
    if (!r || r.status >= 400) d.say(`the Seneschal didn't take the result (${r ? (r.body?.error ?? `HTTP ${r.status}`) : 'no answer'}): it lets the task go in a few minutes`);
    else if (r.body?.retry === 'elsewhere') retried = true;
  };
  return {
    id,
    usualMs: Number(b.usualMs) || 0,
    waitedMs,
    async hold(work, outcome) {
      const began = d.now();
      let lost = false;
      const beat = setInterval(() => {
        void d.call('/api/tasks/heartbeat', { id, token }).then((h) => {
          // Its lease ran out (the PC slept, say): the run goes on, and its late report still counts.
          if (h?.status === 409 && !lost) {
            lost = true;
            d.say(`the Seneschal says its lease is gone (${h.body?.gone ?? 'ran out'}): it runs on, and reports when it ends`);
          }
        });
      }, heartbeatMs);
      beat.unref?.();
      let value: Awaited<ReturnType<typeof work>>;
      try {
        value = await work();
      } catch (err) {
        clearInterval(beat);
        await report({ ok: false, error: true, note: (err as Error)?.message ?? String(err) }, d.now() - began);
        throw err;
      }
      clearInterval(beat);
      let out: SeneschalOutcome;
      try {
        out = outcome(value);
      } catch (err) {
        out = { ok: false, error: true, note: (err as Error)?.message ?? String(err) };
      }
      await report(out, d.now() - began);
      return value;
    },
    async elsewhere() {
      if (!retried) return null;
      retried = false;
      d.say('it failed here: the Seneschal tries it once more on another PC, and this waits for what it comes to there');
      const clock = waitClock(d.now);
      let misses = 0;
      for (let first = true; ; first = false) {
        if (!first) await d.sleep(d.pollMs);
        const r = await d.call('/api/tasks/lease', { worker: d.worker, id, ...(d.slot ? { slot: d.slot } : {}) });
        if (!r || r.status >= 500) {
          if (++misses >= MISSES) return null;
        } else if (r.status >= 400 || !r.body) {
          return null;
        } else {
          misses = 0;
          const a = r.body;
          clock.saw(a.state);
          if (a.task && a.lease?.token) {
            // Handed back to this asker (the PC lost its name, say): it waits only for another PC's run, so none of its own.
            await d.call('/api/tasks/report', { id, token: String(a.lease.token), ok: false, returned: true, note: 'its asker waits for its try on another PC' });
            return null;
          }
          if (a.state === 'done') return a.result && (a.result.flaky || a.result.confirmed) ? (a.result as SeneschalResult) : null;
          if (a.gone || a.asBefore || a.state === 'failed') return null;
        }
        if (clock.waited() >= d.waitMs || clock.ran() >= d.runMs) return null;
      }
    },
    async giveBack(note) {
      await report({ ok: false, returned: true, note }, 0);
    },
  };
}

/** A task the Seneschal handed a worker that asked for any of its kinds: this PC's (t12) or another PC's (b3, `from`). */
export interface SeneschalJob {
  id: string;
  kind: SeneschalKind;
  repo: string;
  commit: string;
  tree?: string;
  /** For only the tests a change reaches: the commit they're picked against. */
  base?: string;
  pr?: number;
  branch?: string;
  /** One part of a whole suite: run only its test files. */
  shard?: SeneschalShard;
  /** A kit trial's kit: a version, or a version and the Steward's commit it's made from (2.78.1-1a2b3c4d5e6f). */
  kit?: string;
  /** A kit trial's agent, by its id: the agent whose checks are tried with the kit. */
  agent?: string;
  lane: SeneschalLane;
  what: string;
  /** Another PC's task: that PC, and the task's id there. */
  from?: { pc: SeneschalPc; id: string };
  /** Its turn: run it under `hold`, or `giveBack` what this worker can't run now. */
  turn: SeneschalTurn;
}

export interface SeneschalWorkOptions {
  /** The agent that asks, by its id. */
  worker: string;
  /** The kinds it runs. */
  kinds: SeneschalKind[];
  /** The repositories it runs them for, owner/name. */
  repos: string[];
  slot?: string;
  say?: (line: string) => void;
  /** Tests: where the Seneschal is, the environment, the clock, and how its turn's elsewhere() asks. */
  at?: SeneschalAt | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitMs?: number;
  runMs?: number;
}

/** What a worker that doesn't say runs: the checks. The turn kinds are only ever their asker's, never a worker's. */
const CHECK_KINDS: readonly SeneschalKind[] = ['pr-check', 'kit-trial', 'full-suite'];
const LANES: readonly SeneschalLane[] = ['person', 'blocking', 'normal', 'background'];
/** owner/name, neither of them "." or "..". */
const REPO = /^(?!\.\.?\/)[A-Za-z0-9_.-]{1,100}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A branch git takes as one: no leading dash or dot, no "..", no "//", not ending in "/" or ".lock". */
const BRANCH = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9_./-]{1,200}$/;
/** A kit trial's kit: a version, or a version and 12 hex digits of the Steward's commit it's made from. */
const KIT = /^\d+\.\d+\.\d+(?:-[0-9a-f]{12})?$/;
const AGENT = /^[a-z][a-z0-9-]{0,40}$/;

/** A shard as the Seneschal names one, checked: whole numbers, 1 <= index <= of <= SENESCHAL_MOST_SHARDS. Pure. */
export function shardOf(v: any): SeneschalShard | null {
  if (!v || typeof v !== 'object' || !Number.isInteger(v.index) || !Number.isInteger(v.of)) return null;
  return v.of >= 1 && v.of <= SENESCHAL_MOST_SHARDS && v.index >= 1 && v.index <= v.of ? { index: v.index, of: v.of } : null;
}

/** The job in a lease's task, checked again here (it may come from another PC); null when any of it isn't as it should be. Pure. */
export function jobOf(t: any, kinds: readonly SeneschalKind[] = CHECK_KINDS): Omit<SeneschalJob, 'turn'> | null {
  if (!t || typeof t !== 'object') return null;
  const id = String(t.id ?? '');
  if (!/^[tb]\d{1,12}$/.test(id) || !kinds.includes(t.kind) || !REPO.test(String(t.repo)) || !OID.test(String(t.commit))) return null;
  if (t.tree != null && !OID.test(String(t.tree))) return null;
  if (t.base != null && !OID.test(String(t.base))) return null;
  if (t.branch != null && !BRANCH.test(String(t.branch))) return null;
  if (t.pr != null && !(Number.isInteger(t.pr) && t.pr > 0)) return null;
  const shard = t.shard == null ? null : shardOf(t.shard);
  if (t.shard != null && (!shard || t.kind !== 'full-suite')) return null;
  // A kit trial names its kit and its agent; no other kind names either (a kit would change what runs).
  if (t.kind === 'kit-trial' ? !KIT.test(String(t.kit ?? '')) || !AGENT.test(String(t.agent ?? '')) : t.kit != null || t.agent != null) return null;
  const from =t.from && typeof t.from === 'object' && t.from.pc && typeof t.from.pc.name === 'string' ? { pc: { id: String(t.from.pc.id ?? ''), name: String(t.from.pc.name).slice(0, 60) }, id: String(t.from.id ?? '') } : undefined;
  return {
    id,
    kind: t.kind,
    repo: t.repo,
    commit: t.commit,
    ...(t.tree ? { tree: t.tree } : {}),
    ...(t.base ? { base: t.base } : {}),
    ...(t.pr ? { pr: t.pr } : {}),
    ...(t.branch ? { branch: t.branch } : {}),
    ...(shard ? { shard } : {}),
    ...(t.kind === 'kit-trial' ? { kit: t.kit, agent: t.agent } : {}),
    lane: LANES.includes(t.lane) ? t.lane : 'normal',
    what: typeof t.what === 'string' && t.what ? t.what.slice(0, 200) : `${t.repo}'s ${t.kind}`,
    ...(from ? { from } : {}),
  };
}

/**
 * A worker's ask (Seneschal 0.2.0): any task of `kinds` for `repos` that waits on this PC, or on another PC on the
 * licence while this one has room, at its turn: the job, to run under its turn's `hold`. Or why there's none, and when to
 * ask again (`retryMs`: soon while the Seneschal has asked another PC for a task, else SENESCHAL_IDLE_MS). Null when
 * there's no Seneschal to ask: none on this PC, under node --test, or inside another's turn. Never throws.
 */
export async function seneschalWork(o: SeneschalWorkOptions): Promise<{ job: SeneschalJob } | { idle: string; retryMs: number } | null> {
  const env = o.env ?? process.env;
  if (env[TURN_HELD_ENV]) return null;
  const at = seneschalFor(o);
  if (!at) return null;
  if (!o.kinds.length || !o.repos.length) return { idle: 'it runs no repository now', retryMs: SENESCHAL_IDLE_MS };
  const call = callerOf(at);
  const r = await call('/api/tasks/lease', { worker: o.worker, kinds: o.kinds, repos: o.repos.slice(0, 200), ...(o.slot ? { slot: o.slot } : {}) });
  if (!r || r.status >= 500) return { idle: "the Seneschal didn't answer", retryMs: SENESCHAL_IDLE_MS };
  if (r.status >= 400 || !r.body) return { idle: `the Seneschal refused the ask: ${r.body?.error ?? `HTTP ${r.status}`}`, retryMs: 10 * SENESCHAL_IDLE_MS };
  const b = r.body;
  const asked = Number(b.retryMs);
  const retryMs = Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(asked, 1_000), 10 * SENESCHAL_IDLE_MS) : SENESCHAL_IDLE_MS;
  if (!b.task || !b.lease?.token) return { idle: String(b.why ?? 'nothing waits'), retryMs };
  const say = o.say ?? (() => {});
  const turn = turnOf(
    { call, say, now: o.now ?? Date.now, sleep: o.sleep ?? pause, pollMs: o.pollMs ?? SENESCHAL_POLL_MS, waitMs: o.waitMs ?? SENESCHAL_WAIT_MS, runMs: o.runMs ?? SENESCHAL_RUN_MS, worker: o.worker, slot: o.slot },
    String(b.task.id),
    b,
    0,
  );
  const job = jobOf(b.task, o.kinds);
  if (!job) {
    await turn.giveBack(`${o.worker} couldn't read the task it was handed`);
    return { idle: `the Seneschal handed it a task it couldn't read (${String(b.task.id ?? '?').slice(0, 20)}), given back`, retryMs: SENESCHAL_IDLE_MS };
  }
  return { job: { ...job, turn } };
}

/**
 * The other PCs on the licence whose workers run `kind` for `repo` now (Seneschal 0.2.0: each sibling's `works`, as
 * this PC's Seneschal last read it): what a whole suite may be cut for (kit 2.78.22). Empty when none does, or the
 * Seneschal shares no work; null when there's no Seneschal to ask, or it doesn't answer. Never throws.
 */
export async function seneschalSiblings(o: { kind: SeneschalKind; repo: string; at?: SeneschalAt | null; env?: NodeJS.ProcessEnv }): Promise<SeneschalPc[] | null> {
  const env = o.env ?? process.env;
  if (env[TURN_HELD_ENV]) return null;
  const at = seneschalFor(o);
  if (!at) return null;
  try {
    const r = await fetch(new URL('/api/tasks', at.base), { headers: { 'x-token': at.token }, signal: AbortSignal.timeout(CALL_MS) });
    if (!r.ok) return null;
    const b: any = await r.json();
    const list = b?.siblings?.on && Array.isArray(b.siblings.siblings) ? b.siblings.siblings : [];
    const repo = o.repo.toLowerCase();
    return list
      .filter((s: any) => s && typeof s.id === 'string' && typeof s.name === 'string' && Array.isArray(s.works?.kinds) && s.works.kinds.includes(o.kind) && (!Array.isArray(s.works.repos) || s.works.repos.some((x: unknown) => String(x).toLowerCase() === repo)))
      .map((s: any) => ({ id: s.id, name: s.name.slice(0, 60) }));
  } catch {
    return null;
  }
}
