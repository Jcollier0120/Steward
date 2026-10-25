import { AsyncLocalStorage } from 'node:async_hooks';
import type { SettingUp } from './server.ts';

/**
 * The work an agent's process has under way (kit 2.76.0, spec/WORK-STATUS.md): each piece of it as a task, running or
 * waiting in a line, for its work status (work-status.ts), which Manor's Work page shows. The kit tracks its own (each
 * scheduled round, schedule.ts); an agent tracks the work it does inside them (the Steward's PR checks, its kit trials),
 * with withWork() around each. A task started inside another's withWork() is that task's part (`parent`), and a check
 * the checks pace runs for it (checks-pace.ts) is said to be its, so its wait for a turn shows as the task's.
 *
 * Only what this process knows: nothing here is written to disk or read from another agent. Never throws.
 */

/** What a task is: its kind, in words, and what it runs on, when that's a repository's code. */
export interface WorkFields {
  /** Its kind: 'round', 'check', 'trial', 'whole-suite', 'merge', 'release', 'index'… one word, for the page to group by. */
  kind: string;
  /** What it is, in words: "Reeve#212's checks", "kit 2.76.0 tried with Reeve". At most 200 characters. */
  what: string;
  /** The repository (owner/name), the commit and its code tree, and the pull request, when it works on one. */
  repo?: string;
  commit?: string;
  tree?: string;
  pr?: number;
}

/** A task as the kit tracks it. Times are epoch milliseconds. */
export interface Task extends WorkFields {
  id: string;
  /** The task it is part of (the one whose withWork() it started in), or null. */
  parent: string | null;
  /** When it was started. */
  since: number;
  /** When it began running; null while it waits. */
  runningSince: number | null;
  /** The line it waits in (a WorkQueue's id: 'work', 'first-round', 'checks', 'accelerator:npu', or an agent's own), or null. */
  line: string | null;
  /** Since when it has waited in that line. */
  inLineSince: number | null;
}

/** A task's handle: say where it stands, and end it. Every call is safe after done(). */
export interface WorkHandle {
  readonly id: string;
  /** It waits in `line` (a WorkQueue's id), from now. */
  waitIn(line: string): void;
  /** It runs, from now (out of any line). */
  running(): void;
  /** What it works on, as it becomes known (a commit fetched, its tree). */
  set(fields: Partial<WorkFields>): void;
  /** It has ended: it leaves the agent's work. */
  done(): void;
}

const tasks = new Map<string, Task>();
const current = new AsyncLocalStorage<string>();
let seq = 0;

const clean = (f: Partial<WorkFields>): Partial<WorkFields> => {
  const out: Partial<WorkFields> = {};
  if (typeof f.kind === 'string' && f.kind) out.kind = f.kind.slice(0, 40);
  if (typeof f.what === 'string' && f.what) out.what = f.what.replace(/\s+/g, ' ').slice(0, 200);
  for (const k of ['repo', 'commit', 'tree'] as const) if (typeof f[k] === 'string' && f[k]) out[k] = f[k]!.slice(0, 200);
  if (Number.isInteger(f.pr) && f.pr! > 0) out.pr = f.pr;
  return out;
};

/**
 * A task started now: running, unless `line` says it waits in one first. Part of the task whose withWork() this runs
 * in, if any. End it with done(), or use withWork(), which does.
 */
export function startWork(f: WorkFields & { line?: string }, now = Date.now): WorkHandle {
  const id = `w${++seq}`;
  const t: Task = { kind: 'work', what: '', ...clean(f), id, parent: current.getStore() ?? null, since: now(), runningSince: f.line ? null : now(), line: f.line ?? null, inLineSince: f.line ? now() : null };
  tasks.set(id, t);
  return {
    id,
    waitIn(line) {
      if (!tasks.has(id) || t.line === line) return;
      Object.assign(t, { line, inLineSince: now(), runningSince: null });
    },
    running() {
      if (!tasks.has(id) || (t.runningSince !== null && t.line === null)) return;
      Object.assign(t, { line: null, inLineSince: null, runningSince: now() });
    },
    set(fields) {
      if (tasks.has(id)) Object.assign(t, clean(fields));
    },
    done() {
      tasks.delete(id);
    },
  };
}

/** Runs `fn` with `h` as the current task: tasks it starts are `h`'s part, and checks it runs are said to be `h`'s. */
export function inWork<T>(h: WorkHandle, fn: () => T): T {
  return current.run(h.id, fn);
}

/** Runs `fn` as a task (startWork(), running), ended when `fn` settles, however it does. */
export async function withWork<T>(f: WorkFields & { line?: string }, fn: (h: WorkHandle) => Promise<T>): Promise<T> {
  const h = startWork(f);
  try {
    return await inWork(h, () => fn(h));
  } finally {
    h.done();
  }
}

/** Runs `fn` in no task: work it starts that outlives the task starting it (a job beside the rounds) is its own. */
export function outsideWork<T>(fn: () => T): T {
  return current.exit(fn);
}

/** The id of the task this runs in (withWork, inWork), or null. */
export const currentWork = (): string | null => current.getStore() ?? null;

/** The tasks under way now, oldest first: copies. */
export const workTasks = (): Task[] => [...tasks.values()].map((t) => ({ ...t }));

/** For tests: forget every task. */
export function resetWorkTasks(): void {
  tasks.clear();
  settingUps.clear();
}

const settingUps = new Map<string, SettingUp>();

/**
 * The kit's own long piece of work done once on a PC (kit 2.137.0: AMD's NPU's reranker compiled, rerank-npu.ts), by
 * `key`, while it runs (null: done). The agent's ping says it as its `settingUp` (server.ts) when the agent's own
 * says none, so Manor's card shows it, calm, as it shows the agent's own.
 */
export function setSettingUp(key: string, s: SettingUp | null): void {
  if (s) settingUps.set(key, s);
  else settingUps.delete(key);
}

/** The kit's setting-up now, the first begun; null when there's none. */
export const kitSettingUp = (): SettingUp | null => settingUps.values().next().value ?? null;
