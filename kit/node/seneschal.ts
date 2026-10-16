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
 */

export type SeneschalLane = 'person' | 'blocking' | 'normal' | 'background';
export type SeneschalKind = 'pr-check' | 'kit-trial' | 'full-suite' | 'wright-job';

/** A task as the agent submits it (the Seneschal's tasks.ts Submission): what it runs on, never a command. */
export interface SeneschalTask {
  kind: SeneschalKind;
  /** owner/name. */
  repo: string;
  /** The commit's full id. */
  commit: string;
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
  lane?: SeneschalLane;
  /** In words: "Reeve#212's checks". The Seneschal makes them up when left out. */
  what?: string;
  /** The agent that asks, by its id. */
  by: string;
}

/** A finished run as the Seneschal keeps it. */
export interface SeneschalResult {
  ok: boolean;
  at: string;
  by: string;
  ms: number;
  note?: string;
  commands?: string[];
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
}

export type SeneschalAnswer = { reused: SeneschalResult; id: string } | { turn: SeneschalTurn };

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
  /** Tests: where the Seneschal is (null: none), the environment, the clock, and how often and long it asks. */
  at?: SeneschalAt | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitMs?: number;
}

type Reply = { status: number; body: any } | null;

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
  // Under node --test, only a Seneschal the test gave a home of its own (or `at`): never this PC's real one.
  const at = o.at !== undefined ? o.at : env.NODE_TEST_CONTEXT && !env.SENESCHAL_HOME ? null : seneschalAt(seneschalHome(env));
  if (!at) return null;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const call = async (route: string, body: unknown): Promise<Reply> => {
    try {
      const r = await fetch(new URL(route, at.base), { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': at.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch {
      return null;
    }
  };

  const started = now();
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
  /** A task that stands done or failed: a pass that ran these commands stands in; anything else is asked for again. */
  const settled = (id: string, state: string, result: SeneschalResult | null | undefined): SeneschalAnswer | 'again' | 'other' => {
    if (state === 'done' && result?.ok) {
      if (sameCommands(result.commands, o.commands)) return { reused: result, id };
      return 'other';
    }
    return 'again';
  };

  let sub = await submit(false);
  for (;;) {
    if ('asBefore' in sub) return asBefore(sub.asBefore);
    const t = sub.task;
    const id = String(t.id);
    if (t.state === 'done' || t.state === 'failed') {
      const s = settled(id, t.state, t.result);
      if (s === 'other') return asBefore('the Seneschal has a pass of this code that ran other checks');
      if (s !== 'again') return s;
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
        if (b.task && b.lease?.token) return { turn: turnOf(call, say, now, id, b, now() - started) };
        if (b.asBefore) return asBefore(String(b.why ?? 'the Seneschal hands out no work'));
        if (b.gone) {
          if (++afresh > AFRESH) return asBefore('the Seneschal kept letting the task go');
          next = await submit(false);
          break;
        }
        if (b.state === 'done' || b.state === 'failed') {
          const s = settled(id, b.state, b.result);
          if (s === 'other') return asBefore('it passed elsewhere running other checks');
          if (s !== 'again') return s;
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
      if (now() - started >= (o.waitMs ?? SENESCHAL_WAIT_MS)) {
        return asBefore(`its turn didn't come in ${Math.round((o.waitMs ?? SENESCHAL_WAIT_MS) / 60_000)} minutes (${lastWhy || 'no answer'})`);
      }
      await sleep(o.pollMs ?? SENESCHAL_POLL_MS);
    }
    sub = next;
  }
}

/** The turn for a lease the Seneschal gave: its heartbeats and its report. */
function turnOf(call: (route: string, body: unknown) => Promise<Reply>, say: (line: string) => void, now: () => number, id: string, b: any, waitedMs: number): SeneschalTurn {
  const token = String(b.lease.token);
  const heartbeatMs = Number(b.lease.heartbeatMs) > 0 ? Number(b.lease.heartbeatMs) : 15_000;
  const report = async (out: SeneschalOutcome, ms: number) => {
    const r = await call('/api/tasks/report', { id, token, ms, ...out, ...(out.note ? { note: out.note.slice(0, 500) } : {}) });
    if (!r || r.status >= 400) say(`the Seneschal didn't take the result (${r ? (r.body?.error ?? `HTTP ${r.status}`) : 'no answer'}): it lets the task go in a few minutes`);
  };
  return {
    id,
    usualMs: Number(b.usualMs) || 0,
    waitedMs,
    async hold(work, outcome) {
      const began = now();
      let lost = false;
      const beat = setInterval(() => {
        void call('/api/tasks/heartbeat', { id, token }).then((h) => {
          // Its lease ran out (the PC slept, say): the run goes on, and its late report still counts.
          if (h?.status === 409 && !lost) {
            lost = true;
            say(`the Seneschal says its lease is gone (${h.body?.gone ?? 'ran out'}): it runs on, and reports when it ends`);
          }
        });
      }, heartbeatMs);
      beat.unref?.();
      let value: Awaited<ReturnType<typeof work>>;
      try {
        value = await work();
      } catch (err) {
        clearInterval(beat);
        await report({ ok: false, error: true, note: (err as Error)?.message ?? String(err) }, now() - began);
        throw err;
      }
      clearInterval(beat);
      let out: SeneschalOutcome;
      try {
        out = outcome(value);
      } catch (err) {
        out = { ok: false, error: true, note: (err as Error)?.message ?? String(err) };
      }
      await report(out, now() - began);
      return value;
    },
  };
}
