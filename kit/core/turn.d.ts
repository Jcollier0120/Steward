// Made by kit/test/core-types.ts from turn.js's JSDoc: don't edit it, run npm run core-types.
import type { Rules } from './rules.js';
import type { Owner } from './queue.js';
import type { Lane } from './queue.js';
import type { Entry } from './queue.js';
export type Path = string[];
export type Action = {
    op: 'mkdirs';
    path: Path;
} | {
    op: 'write';
    path: Path;
    text: string;
} | {
    op: 'touch';
    path: Path;
} | {
    op: 'list';
    path: Path;
} | {
    op: 'alive';
    pids: number[];
} | {
    op: 'remove';
    path: Path;
} | {
    op: 'mkdir';
    path: Path;
} | {
    op: 'read';
    path: Path;
} | {
    op: 'stat';
    path: Path;
} | {
    op: 'rmdir';
    path: Path;
} | {
    op: 'note';
    text: string;
};
export type Result = null | {
    error: string;
    message?: string;
} | {
    entries: Entry[];
} | {
    alive: boolean[];
} | {
    text: string;
} | {
    mtimeMs: number;
};
export type Observation = {
    /**
     * Wall-clock milliseconds since the Unix epoch.
     */
    nowMs: number;
    results: Result[];
};
export type Done = {
    held: {
        slot: number;
        owner: Owner;
    };
} | {
    error: 'timeout' | 'full' | 'io';
    message: string;
} | {
    released: boolean;
} | {
    aborted: true;
};
export type TurnState = {
    machine: 'turn' | 'lock';
    phase: string;
    rules: {
        queue: Rules['queue'];
        lock: Rules['lock'];
    };
    slots: string[];
    queue: string | null;
    pid: number;
    ticket: string | null;
    body: string | null;
    what: string;
    waitMs: number;
    staleMs: number;
    maxAhead: number | null;
    deadline: number | null;
    beat: number | null;
    tickMs: number;
    joined: boolean;
    head: boolean;
    noted: boolean;
    rejoined: boolean;
    inLine: number;
    line: {
        then: 'count' | 'tick';
        atMs: number;
        entries: Entry[];
        ask: number[];
    } | null;
    check: {
        owner: Owner;
        mtimeMs: number | null;
        atMs: number;
    } | null;
    slot: number;
    tries: number;
    evicting: boolean;
    removeTry: number;
    me: Owner | null;
    tags: string[];
};
export type Step = {
    state: TurnState;
    actions: Action[];
    waitMs: number;
    done?: Done;
};
export type TurnOptions = {
    /**
     * The accelerator's lock folders (slotNames): the first is its lock, and its line is beside it.
     */
    slots: string[];
    /**
     * This process.
     */
    pid: number;
    nowMs: number;
    /**
     * The ticket's time: strictly increasing within the process (nextUs).
     */
    nowUs: number;
    /**
     * Random lowercase hex, 8 characters.
     */
    nonce: string;
    /**
     * Default background.
     */
    lane?: Lane;
    /**
     * Shown to whoever looks at the line.
     */
    who: string;
    /**
     * The accelerator in messages (default: "the NPU", or the folder's name).
     */
    what?: string;
    /**
     * How long to wait in line (default rules.lock.waitMs).
     */
    waitMs?: number;
    /**
     * When a holder counts as overstayed (default rules.lock.staleMs).
     */
    staleMs?: number;
    /**
     * Don't join when this many are already waiting: ends at once as `full`.
     */
    maxAhead?: number;
};
export type LockOptions = {
    /**
     * The lock folder's name, in the base folder.
     */
    folder: string;
    pid: number;
    nowMs: number;
    /**
     * The lock in messages (default the folder's name).
     */
    what?: string;
    waitMs?: number;
    staleMs?: number;
};
export type Tagged = [Action, string?];
/**
 * The turn: join the accelerator's line, wait to head it, take a free slot (evicting a dead or overstayed
 * holder), and leave the line. Its first step.
 * @param {Rules} rules
 * @param {TurnOptions} o
 * @returns {Step}
 */
export declare function startTurn(rules: Rules, o: TurnOptions): Step;
/**
 * The plain lock, for a lock nobody queues for: take its folder (evicting a dead or overstayed holder),
 * trying again every rules.lock.pollMs. Its first step.
 * @param {Rules} rules
 * @param {LockOptions} o
 * @returns {Step}
 */
export declare function startLock(rules: Rules, o: LockOptions): Step;
/**
 * The machine's next step, from what the driver saw after the last.
 * @param {TurnState} state
 * @param {Observation} obs
 * @returns {Step}
 */
export declare function step(state: TurnState, obs: Observation): Step;
/**
 * Lets go of a held lock, only while owner.json still names this holder (pid and since): an evicted
 * holder must never remove the next one's. Its first step; `step` takes it on until `done.released`.
 * @param {TurnState} state The state that ended `held`.
 * @param {number} nowMs
 * @returns {Step}
 */
export declare function release(state: TurnState, nowMs: number): Step;
/**
 * Gives up a machine that hasn't ended, as a driver does when something unexpected stops it: what to
 * undo (the ticket, when it is in line). A held lock is let go with `release` instead.
 * @param {TurnState} state
 * @returns {Step}
 */
export declare function abort(state: TurnState): Step;
