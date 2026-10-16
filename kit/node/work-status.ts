import { execFile } from 'node:child_process';
import os from 'node:os';
import { APP } from '../app.ts';
import { CHECKS_AT_ONCE, checksPaceCap, checksRuns, type ChecksRun } from './checks-pace.ts';
import { lineSnapshot, slotDirs, type Lane } from './npu-queue.ts';
import { agentsAtOnce, firstRoundLockDir, pace, workLockDir, type Pace } from './pace.ts';
import { passOnOtherPcs } from './manor.ts';
import { dataFile, readJson, writeJson } from './store.ts';
import { workTasks, type Task, type WorkFields } from './work-tasks.ts';

export { currentWork, inWork, outsideWork, startWork, withWork, type WorkFields, type WorkHandle } from './work-tasks.ts';

/**
 * An agent's work status (kit 2.76.0, spec/WORK-STATUS.md): one shape every agent reports at GET /api/peer/work (the
 * kit's server answers it for every agent, server.ts), which Manor's Work page gathers from each agent on this PC, and
 * from each PC on the licence over Manor's link to other PCs. It says
 *
 * - **what the agent may run at once** (`slots`: its own limits, as the agent gives them: the Steward's stages);
 * - **what it runs** and **what waits**, and in which line (`running`, `waiting`: its tasks, work-tasks.ts, the kit's
 *   own scheduled rounds among them, each with its kind, repository, commit and since when);
 * - **the PC's lines** as they stand (`lines`): the checks pace's turns, the work line, the first-round line and each
 *   accelerator's, with who holds a place and who waits, since when. Every agent on a PC sees the same ones;
 * - **its recent results**, one per code tree and kind (`results`), so a pass anywhere can be found by its tree;
 * - **what holds its work up** (`blocked`: a version queue held by a draft, as the agent gives it).
 *
 * Read only, and cheap: a few folders read and the processor's counters. Nothing in it is secret on the PC, and over
 * the link only the licence's own PCs can ask (Manor's peers.ts).
 */

/** The shape's version: a reader takes `v` 1, and ignores fields it doesn't know. */
export const WORK_STATUS_VERSION = 1;

export interface WorkStatus {
  v: typeof WORK_STATUS_VERSION;
  agent: { id: string; name: string; version: string; pid: number };
  /** When it was made. */
  at: string;
  pc: PcLoad;
  slots: WorkSlots[];
  running: WorkTask[];
  waiting: WorkTask[];
  lines: WorkQueue[];
  results: WorkResult[];
  blocked: WorkBlock[];
}

/** The PC as this agent sees it now. */
export interface PcLoad {
  /** Its name on the network (os.hostname()). */
  name: string;
  processors: number;
  memoryMb: number;
  freeMemoryMb: number;
  /** The processor's use over the last moment, 0 to 1; null when it couldn't be measured. */
  busy: number | null;
  /** The manor's pace (pace.ts), and the checks pace's cap in hundredths of a percent (0: none; checks-pace.ts). */
  pace: Pace;
  checksCap: number;
}

/** How many of one kind of work the agent runs at once (`of`, null for no limit), and how many it runs now. */
export interface WorkSlots {
  kind: string;
  name: string;
  of: number | null;
  used: number;
}

/** A task, as the status says it: its times in ISO 8601. */
export interface WorkTask extends WorkFields {
  id: string;
  /** The task it is part of. */
  parent?: string;
  /** When it was started. */
  since: string;
  /** When it began running (a running task). */
  runningSince?: string;
  /** The line it waits in (a WorkQueue's id), since when, and how many wait ahead of it (a waiting task). */
  line?: string;
  inLineSince?: string;
  ahead?: number;
}

/** A place in a line: held (a slot or turn) or waited for. */
export interface WorkPlace {
  /** The agent (or program) holding or waiting, when it says; else empty, and `pid` names its process. */
  who: string;
  /** What for, when it says. */
  what?: string;
  pid?: number;
  /** Since when; null when it can't be told (a lock folder with no owner written yet). */
  since: string | null;
  /** An accelerator's lane. */
  lane?: Lane;
  /** The task it is for (a WorkTask's id, of the agent `who`), when it says. */
  work?: string;
}

/** One of the PC's lines, or an agent's own. */
export interface WorkQueue {
  /** 'checks', 'work', 'first-round', 'accelerator:<id>', or `<agent>:<name>` for an agent's own. */
  id: string;
  kind: 'checks' | 'work' | 'first-round' | 'accelerator' | 'agent';
  name: string;
  /** How many hold a place at once; null for no limit now (the pace at full lifts the checks' turns and the first-round line). */
  slots: number | null;
  holders: WorkPlace[];
  waiting: WorkPlace[];
}

/** A result: what a kind of work on a code tree came to. One per kind, repository and tree, the latest. */
export interface WorkResult {
  kind: string;
  repo?: string;
  /** The code tree it ran on (git's tree id): the same code has the same tree, whatever its commit. Null when not known. */
  tree: string | null;
  commit?: string;
  ok: boolean;
  at: string;
  what?: string;
  /** What failed, or anything else worth a line. */
  note?: string;
  /** The commands it ran (a repository's checks: kit 2.77.0), so a pass stands in only for the checks it ran. */
  commands?: string[];
  /** The Node.js it ran on (process.versions.node) and the OS (process.platform), kit 2.77.0: toolchainHere(). */
  node?: string;
  platform?: string;
  /** The PC that ran it, for a pass taken from another PC on the licence (passFor, kit 2.77.0): this PC didn't. */
  from?: { id: string; name: string };
}

/** Something that holds the agent's work up: what is held, by what, and since when. */
export interface WorkBlock {
  /** 'version-queue', 'conflict', …: one word. */
  kind: string;
  /** What is held, in words: "Reeve's version queue". */
  what: string;
  /** What holds it, in words: "#233 (v0.36.41), a draft". */
  by: string;
  since: string;
  repo?: string;
  pr?: number;
  url?: string;
  /** What waits behind it, in words ("#266", "#268"). */
  waiting?: string[];
}

/** What an agent adds to the kit's own (server.ts's ServeOptions.work): its slots, its own tasks and lines, results, blocks. */
export interface WorkExtra {
  slots?: WorkSlots[];
  running?: WorkTask[];
  waiting?: WorkTask[];
  lines?: WorkQueue[];
  results?: WorkResult[];
  blocked?: WorkBlock[];
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------- results

/** How many results are kept (work-results.json), and how many a status lists. */
export const RESULTS_KEPT = 200;
export const RESULTS_SHOWN = 50;

export const workResultsFile = () => dataFile('work-results.json');

/** A result's key: one per kind, repository and tree (its commit when the tree isn't known). */
export const resultKey = (r: Pick<WorkResult, 'kind' | 'repo' | 'tree' | 'commit'>) => [r.kind, (r.repo ?? '').toLowerCase(), r.tree ?? r.commit ?? ''].join('|');

/** Results kept in memory only: under node --test, unless the test gave the agent a data folder of its own. */
let unkept: Record<string, WorkResult> = {};
const kept = (env: NodeJS.ProcessEnv = process.env) => !env.NODE_TEST_CONTEXT || !!env[`${APP.id.toUpperCase().replace(/-/g, '_')}_HOME`];

/**
 * Keeps what a piece of work came to, by its tree (resultKey): a later result for the same code replaces it. One with
 * neither a tree nor a commit is not kept. Never throws.
 */
export function recordResult(r: Omit<WorkResult, 'at'> & { at?: string }, now = new Date()): void {
  if (!r.kind || (!r.tree && !r.commit)) return;
  const result: WorkResult = { ...r, tree: r.tree ?? null, at: r.at ?? now.toISOString() };
  const key = resultKey(result);
  try {
    const all = kept() ? readJson<Record<string, WorkResult>>(workResultsFile(), {}) : unkept;
    delete all[key];
    all[key] = result;
    const trimmed = Object.fromEntries(Object.entries(all).slice(-RESULTS_KEPT));
    if (kept()) writeJson(workResultsFile(), trimmed);
    else unkept = trimmed;
  } catch {
    // a result not kept is run again, no more
  }
}

/** The results kept, the newest first. */
export function recentResults(limit = RESULTS_SHOWN): WorkResult[] {
  const all = kept() ? readJson<Record<string, WorkResult>>(workResultsFile(), {}) : unkept;
  return Object.values(all)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** The result kept for this kind of work on this tree, or null: a pass here counts wherever it's asked. */
export const resultFor = (q: Pick<WorkResult, 'kind' | 'repo' | 'tree' | 'commit'>): WorkResult | null =>
  (kept() ? readJson<Record<string, WorkResult>>(workResultsFile(), {}) : unkept)[resultKey(q)] ?? null;

/** For tests: forget the results kept, in memory and in the test's data folder. */
export function resetResults(): void {
  unkept = {};
  if (kept()) writeJson(workResultsFile(), {});
}

// ---------------------------------------------------------------- a pass that stands in (kit 2.77.0)

/**
 * How long a pass of a tree stands in for running the same checks again: a day. The tree fixes the code, its lockfile
 * and the kit it pins, but not what the checks reach outside it (the date, the network, a tool on the PC updated since).
 * A day covers the same code tested for its pull request, its vouch, its train and on main once merged, on each PC, and
 * is the window in which the Steward takes the Assayer's check of a folder (the Steward's assayed.ts).
 */
export const PASS_STANDS_MS = 24 * 3600_000;
/** How far ahead of this PC's clock another PC's pass may say it ran: two PCs' clocks differ a little. */
const CLOCK_SKEW_MS = 10 * 60_000;

/** What a result is matched on besides its code: Node.js's version (its major must be the same) and the OS. */
export const toolchainHere = (): { node: string; platform: string } => ({ node: process.versions.node, platform: process.platform });

/** What a pass must be of to stand in for running work again: a kind of work on a repository's tree, of these commands (none asked: any). */
export interface PassQuery {
  kind: string;
  repo: string;
  tree: string;
  commands?: string[];
}

/** Who else is asked for a pass (passFor): another PC's result, with `from` saying which; null for no one. */
export type PassElsewhere = ((q: PassQuery) => Promise<WorkResult | null>) | null;

const major = (v: string | undefined) => (v ?? '').replace(/^v/, '').split('.')[0];

/**
 * Why `r` doesn't stand in for running `q` again, or null when it does. It must have passed, and be of the whole of
 * that kind (only the tests a change reached, picked against some base, never stand in for the whole checks), of the
 * same repository and tree, under PASS_STANDS_MS old, on the same Node.js major and OS as here, and of every command
 * asked. A result recorded before kit 2.77.0 says none of these, and so never stands in.
 */
export function whyNotPass(r: WorkResult, q: PassQuery, o: { now?: number; toolchain?: { node: string; platform: string } } = {}): string | null {
  const now = o.now ?? Date.now();
  const here = o.toolchain ?? toolchainHere();
  if (!r.ok) return 'it failed';
  if (r.kind !== q.kind) return r.kind === `affected ${q.kind}` ? 'only the tests its change reached ran' : `it was ${r.kind}`;
  if ((r.repo ?? '').toLowerCase() !== q.repo.toLowerCase()) return 'another repository';
  if ((r.tree ?? '').toLowerCase() !== q.tree.toLowerCase()) return 'other code';
  const at = Date.parse(r.at);
  if (!Number.isFinite(at) || at > now + CLOCK_SKEW_MS) return 'no time it can be trusted';
  if (now - at > PASS_STANDS_MS) return 'more than a day old';
  if (!r.node) return "it doesn't say which Node.js";
  if (major(r.node) !== major(here.node)) return `on Node.js ${major(r.node)}, not ${major(here.node)}`;
  if (!r.platform) return "it doesn't say which OS";
  if (r.platform !== here.platform) return `on ${r.platform}, not ${here.platform}`;
  if (q.commands?.length) {
    if (!r.commands) return "it doesn't say which checks it ran";
    const missing = q.commands.filter((c) => !r.commands!.includes(c));
    if (missing.length) return `it didn't run ${missing.join(', ')}`;
  }
  return null;
}

/**
 * The pass that stands in for running `q` again, or null: then run it. This PC's own result for the tree first
 * (work-results.json); else another PC's on the licence, asked through Manor (manor.ts passOnOtherPcs: Manor 0.16.163
 * and later, with Other PCs on; nothing when it's off, or older). Either must pass whyNotPass. A failure here newer than
 * the other PC's pass, and that pass isn't taken: this PC's latest says how the code stands here. A failure elsewhere
 * never spares a run. A pass taken from another PC is kept here as that PC's (`from`, at the time it ran there), so the
 * next look here finds it at once and the Work page says where it ran. `elsewhere`: who else to ask (null: no one).
 * Never throws.
 */
export async function passFor(q: PassQuery, o: { now?: number; elsewhere?: PassElsewhere } = {}): Promise<WorkResult | null> {
  const now = o.now ?? Date.now();
  try {
    const here = resultFor(q);
    if (here && !whyNotPass(here, q, { now })) return here;
    const ask = o.elsewhere === undefined ? (x: PassQuery) => passOnOtherPcs(x, { agent: APP.id }) : o.elsewhere;
    const there = ask ? await ask(q) : null;
    if (!there?.from || whyNotPass(there, q, { now })) return null;
    if (here && !here.ok && Date.parse(here.at) >= Date.parse(there.at)) return null;
    recordResult(there);
    return there;
  } catch {
    return null;
  }
}

const KIND = /^[a-z][a-z -]{0,39}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * GET /api/peer/result?kind=checks&repo=<owner/name>&tree=<git tree id> (server.ts): this agent's result for that tree,
 * from all it keeps (work-results.json, not only the recent ones a status lists), for Manor to pass to another PC on the
 * licence whose agent is about to run the same checks. Its own result only: one it took from another PC isn't passed
 * on. Read only; null when it has none.
 */
export function peerResult(query: URLSearchParams): { json: unknown; status?: number } {
  const kind = query.get('kind') || 'checks';
  const repo = query.get('repo') ?? '';
  const tree = (query.get('tree') ?? '').toLowerCase();
  if (!KIND.test(kind) || !REPO.test(repo) || !SHA.test(tree)) return { status: 400, json: { error: 'Ask for kind=<the work>, repo=<owner/name> and tree=<its git tree id>.' } };
  const r = resultFor({ kind, repo, tree });
  return { json: { v: 1, result: r && !r.from ? r : null } };
}

/** A checkout's code as work starts on it, or ends: its HEAD's commit and tree, and whether nothing tracked is changed. */
export interface CodeAt {
  commit?: string;
  tree?: string;
  clean: boolean;
}

const SHA = /^[0-9a-f]{40,64}$/;

/**
 * The commit and tree checked out in `dir`, and whether it's clean (nothing tracked changed): for a task's fields as it
 * starts, and before its result is kept by that tree. Read with git itself, apart from the agent's own runner (and so
 * apart from a test's stand-in for it); nothing known when `dir` isn't a checkout or git isn't there. Never throws.
 */
export async function codeAt(dir: string): Promise<CodeAt> {
  const git = (args: string[]) =>
    new Promise<string | null>((resolve) =>
      execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout: 30_000, encoding: 'utf8' }, (e, out) => resolve(e ? null : String(out ?? ''))),
    );
  const [heads, status] = await Promise.all([git(['rev-parse', 'HEAD', 'HEAD^{tree}']), git(['status', '--porcelain', '--untracked-files=no'])]);
  const [commit, tree] = (heads ?? '').trim().split(/\s+/);
  return { ...(SHA.test(commit ?? '') ? { commit } : {}), ...(SHA.test(tree ?? '') ? { tree } : {}), clean: status !== null && status.trim() === '' };
}

// ---------------------------------------------------------------- the PC's lines

const placeOfRun = (r: ChecksRun): WorkPlace => ({ who: r.agent, ...(r.what ? { what: r.what } : {}), pid: r.pid, since: iso(r.since), ...(r.work ? { work: r.work } : {}) });

const holdersOf = (holders: ({ pid: number; since: number } | null)[]): WorkPlace[] =>
  holders.flatMap((h) => (h ? [{ who: h.pid === process.pid ? APP.id : '', ...(h.pid ? { pid: h.pid } : {}), since: h.since ? iso(h.since) : null }] : []));

const waitersOf = (waiting: { pid: number; lane: Lane; since: number; who?: string; doing?: string }[]): WorkPlace[] =>
  waiting.map((w) => ({ who: w.who ?? '', ...(w.doing ? { what: w.doing } : {}), pid: w.pid, since: iso(w.since), lane: w.lane }));

/**
 * The PC's lines now: the checks pace's turns (checks-pace.ts's runs), the work line and the first-round line (pace.ts),
 * and each accelerator's (accelerators.ts), as every agent on the PC shares them. Read only. `runs`: the check runs
 * already read. Never throws: a line that can't be read is left out.
 */
export async function pcLines(o: { runs?: ChecksRun[] } = {}): Promise<WorkQueue[]> {
  const lines: WorkQueue[] = [];
  const runs = o.runs ?? checksRuns();
  lines.push({
    id: 'checks',
    kind: 'checks',
    name: "The checks pace's turns",
    slots: checksPaceCap() ? CHECKS_AT_ONCE : null,
    holders: runs.filter((r) => r.state !== 'waiting').map(placeOfRun),
    waiting: runs.filter((r) => r.state === 'waiting').map(placeOfRun),
  });
  const p = pace();
  try {
    const slots = agentsAtOnce(p);
    const work = lineSnapshot(slotDirs(workLockDir(), slots ?? 1));
    lines.push({ id: 'work', kind: 'work', name: 'The work line', slots, holders: holdersOf(work.holders), waiting: waitersOf(work.waiting) });
  } catch {}
  try {
    const first = lineSnapshot([firstRoundLockDir()]);
    lines.push({ id: 'first-round', kind: 'first-round', name: 'The first-round line', slots: p === 'gentle' ? 1 : null, holders: holdersOf(first.holders), waiting: waitersOf(first.waiting) });
  } catch {}
  try {
    const { loadAccelerators, lockDirsOf, turnsWithoutEntry } = await import('./accelerators.ts');
    const cfg = loadAccelerators();
    if (!('error' in cfg)) {
      // The entries, then a device whose turn an entry's server takes without an entry of its own (the NPU 3720's graphics).
      for (const a of [...cfg.accelerators.filter((a) => a.enabled !== false), ...turnsWithoutEntry(cfg.accelerators)]) {
        const dirs = lockDirsOf(a);
        const s = lineSnapshot(dirs);
        lines.push({ id: `accelerator:${a.id}`, kind: 'accelerator', name: a.name ?? a.id, slots: dirs.length, holders: holdersOf(s.holders), waiting: waitersOf(s.waiting) });
      }
    }
  } catch {}
  return lines;
}

// ---------------------------------------------------------------- the PC's load

interface CpuSample {
  idle: number;
  total: number;
  at: number;
}

const cpuSample = (): CpuSample => {
  let idle = 0;
  let total = 0;
  for (const { times: t } of os.cpus()) {
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, at: Date.now() };
};

let lastSample: CpuSample | null = null;

/** The processor's use since the last look (a second to two minutes ago), else over a quarter second now: 0 to 1, or null. */
async function busyNow(): Promise<number | null> {
  try {
    let before = lastSample;
    const age = before ? Date.now() - before.at : Infinity;
    if (!before || age < 1000 || age > 120_000) {
      before = cpuSample();
      await new Promise((r) => setTimeout(r, 250));
    }
    const after = cpuSample();
    lastSample = after;
    const total = after.total - before.total;
    return total > 0 ? Math.min(1, Math.max(0, 1 - (after.idle - before.idle) / total)) : null;
  } catch {
    return null;
  }
}

/** The PC now: its name, processors, memory, how busy, and its paces. */
export async function pcLoad(): Promise<PcLoad> {
  const mb = (bytes: number) => Math.round(bytes / 1_048_576);
  return {
    name: os.hostname(),
    processors: os.availableParallelism(),
    memoryMb: mb(os.totalmem()),
    freeMemoryMb: mb(os.freemem()),
    busy: await busyNow(),
    pace: pace(),
    checksCap: checksPaceCap(),
  };
}

// ---------------------------------------------------------------- the status

/**
 * A task as the status says it: waiting in its own line (`line`), or, when every check it has started waits for a turn
 * (`runs`, this agent's), in the checks pace's line; else running. `ahead`: those waiting longer in the same line.
 */
export function taskView(t: Task, runs: ChecksRun[], lines: WorkQueue[]): WorkTask {
  const base: WorkTask = {
    id: t.id,
    kind: t.kind,
    what: t.what,
    ...(t.repo ? { repo: t.repo } : {}),
    ...(t.commit ? { commit: t.commit } : {}),
    ...(t.tree ? { tree: t.tree } : {}),
    ...(t.pr ? { pr: t.pr } : {}),
    ...(t.parent ? { parent: t.parent } : {}),
    since: iso(t.since),
  };
  const aheadIn = (line: string, since: number) => {
    const q = lines.find((l) => l.id === line);
    return q ? q.waiting.filter((w) => w.since !== null && Date.parse(w.since) < since).length : undefined;
  };
  const inLine = (line: string, since: number): WorkTask => {
    const ahead = aheadIn(line, since);
    return { ...base, line, inLineSince: iso(since), ...(ahead !== undefined ? { ahead } : {}) };
  };
  if (t.line) return inLine(t.line, t.inLineSince ?? t.since);
  const own = runs.filter((r) => r.work === t.id);
  if (own.length && own.every((r) => r.state === 'waiting')) return inLine('checks', Math.min(...own.map((r) => r.since)));
  return { ...base, runningSince: iso(t.runningSince ?? t.since) };
}

/**
 * This agent's work status now: the kit's tasks (its rounds, and whatever the agent tracks with withWork), the PC's
 * lines and load, and its results, with what the agent adds (`extra`: its slots, tasks it tracks another way, lines of
 * its own, results, blocks). `o` is for tests. Never throws for a line or a count it can't read.
 */
export async function workStatus(extra: WorkExtra = {}, o: { now?: number; runs?: ChecksRun[]; lines?: WorkQueue[]; load?: PcLoad } = {}): Promise<WorkStatus> {
  const runs = o.runs ?? checksRuns();
  const lines = [...(o.lines ?? (await pcLines({ runs }))), ...(extra.lines ?? [])];
  const mine = runs.filter((r) => r.agent === APP.id);
  const tasks = workTasks().map((t) => taskView(t, mine, lines));
  const running = [...tasks.filter((t) => !t.line), ...(extra.running ?? [])];
  const waiting = [...tasks.filter((t) => t.line), ...(extra.waiting ?? [])].sort((a, b) => (a.inLineSince ?? a.since).localeCompare(b.inLineSince ?? b.since));
  const results = new Map<string, WorkResult>();
  for (const r of [...(extra.results ?? []), ...recentResults(RESULTS_KEPT)]) {
    const k = resultKey(r);
    const had = results.get(k);
    if (!had || had.at < r.at) results.set(k, r);
  }
  return {
    v: WORK_STATUS_VERSION,
    agent: { id: APP.id, name: APP.name, version: APP.version, pid: process.pid },
    at: iso(o.now ?? Date.now()),
    pc: o.load ?? (await pcLoad()),
    slots: extra.slots ?? [],
    running,
    waiting,
    lines,
    results: [...results.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, RESULTS_SHOWN),
    blocked: extra.blocked ?? [],
  };
}
