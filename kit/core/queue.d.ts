// Made by kit/test/core-types.ts from queue.js's JSDoc: don't edit it, run npm run core-types.
import type { Rules } from './rules.js';
export type Lane = 'interactive' | 'background';
export type Ticket = {
    name: string;
    /**
     * 0 = interactive (a person is waiting), 1 = background.
     */
    lane: 0 | 1;
    /**
     * When it joined, in microseconds since the Unix epoch.
     */
    timeUs: number;
    pid: number;
    nonce: string;
};
export type Owner = {
    pid: number;
    /**
     * When it took the lock, in milliseconds since the Unix epoch.
     */
    since: number;
};
export type Entry = {
    name: string;
    /**
     * Its modification time; null when it went before it could be read.
     */
    mtimeMs: number | null;
    /**
     * Its contents, when the driver read them (for a snapshot).
     */
    text?: string;
};
export type Waiting = {
    pid: number;
    lane: Lane;
    /**
     * When it joined, in milliseconds.
     */
    since: number;
    /**
     * Who it is, from the ticket's contents.
     */
    who?: string;
    /**
     * What the request is for, from the ticket's contents, when it says.
     */
    doing?: string;
};
/**
 * A ticket from its file name, or null for anything that isn't one.
 * @param {string} name
 * @returns {Ticket | null}
 */
export declare function parseTicket(name: string): Ticket | null;
/**
 * A ticket's file name: its lane, the time as 17 digits, the pid and the nonce (random lowercase hex).
 * @param {Lane} lane
 * @param {number} timeUs
 * @param {number} pid
 * @param {string} nonce
 * @returns {string}
 */
export declare function ticketName(lane: Lane, timeUs: number, pid: number, nonce: string): string;
/** The longest `doing` a ticket carries: a longer one is cut, ending in an ellipsis. */
export declare const DOING_MAX = 80;
/**
 * A ticket's contents, which are only informational: `{"pid", "since", "lane", "who"}`, and `"doing"` when the
 * waiter says what the request is for ("search index: Heiward (17 of 673 files)"), at most DOING_MAX characters.
 * @param {Lane} lane
 * @param {number} timeUs
 * @param {number} pid
 * @param {string} who
 * @param {string} [doing]
 * @returns {string}
 */
export declare function ticketText(lane: Lane, timeUs: number, pid: number, who: string, doing?: string): string;
/**
 * A clock's next reading in microseconds, strictly increasing within a process: the wall clock's, or one
 * past the last when the wall clock hasn't moved on. The driver keeps the last.
 * @param {number} lastUs
 * @param {number} wallUs
 * @returns {number}
 */
export declare function nextUs(lastUs: number, wallUs: number): number;
/**
 * The order of the line: interactive first, then by arrival, then pid, then nonce; a background ticket
 * that has waited `ageMs` counts as interactive.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {Ticket} a
 * @param {Ticket} b
 * @param {number} nowUs
 * @returns {number}
 */
export declare function compareTickets(rules: Pick<Rules, 'queue'>, a: Ticket, b: Ticket, nowUs: number): number;
/**
 * How stale a ticket's heartbeat is: `fresh`; `late`, when its process decides (gone: dead); or `dead`,
 * whatever its pid says.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {number} ageMs Now less its modification time.
 * @returns {'fresh' | 'late' | 'dead'}
 */
export declare function ticketState(rules: Pick<Rules, 'queue'>, ageMs: number): 'fresh' | 'late' | 'dead';
/**
 * Whether a ticket's waiter is gone: no heartbeat for `deadMs`, or a late heartbeat and no such process.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {number} ageMs
 * @param {boolean} pidAlive
 * @returns {boolean}
 */
export declare function isDeadTicket(rules: Pick<Rules, 'queue'>, ageMs: number, pidAlive: boolean): boolean;
export type LineVerdict = {
    ask?: number[];
    live: Ticket[];
    dead: string[];
};
/**
 * @typedef {object} LineVerdict The line as read: either the pids whose processes decide (`ask`), or
 * the live tickets in order and the dead ones, which anyone reading the line may delete.
 * @property {number[]} [ask]
 * @property {Ticket[]} live
 * @property {string[]} dead
 */
/**
 * Reads the line from its folder's files: the tickets in order, the dead ones apart (never `keep`, the
 * reader's own). A late ticket needs its process checked: without an answer in `alive` (by pid) the
 * verdict asks for those pids first.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {Entry[]} entries
 * @param {number} nowMs
 * @param {{ keep?: string | null, alive?: Record<string, boolean> }} [opts]
 * @returns {LineVerdict}
 */
export declare function judgeLine(rules: Pick<Rules, 'queue'>, entries: Entry[], nowMs: number, opts?: {
    keep?: string | null;
    alive?: Record<string, boolean>;
}): LineVerdict;
/**
 * Who is waiting, in line order, for a status page: the live tickets, each with `who` and `doing` from its
 * contents when they say. Reads only: the dead are left out, not deleted.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {Entry[]} entries
 * @param {number} nowMs
 * @param {Record<string, boolean>} [alive]
 * @returns {{ ask: number[] } | { waiting: Waiting[] }}
 */
export declare function waitingOf(rules: Pick<Rules, 'queue'>, entries: Entry[], nowMs: number, alive?: Record<string, boolean>): {
    ask: number[];
} | {
    waiting: Waiting[];
};
/**
 * A lock's owner.json, or null when it's missing, half written or not one.
 * @param {string | null | undefined} text
 * @returns {Owner | null}
 */
export declare function readOwner(text: string | null | undefined): Owner | null;
/**
 * owner.json's contents: `{"pid", "since"}`.
 * @param {Owner} owner
 * @returns {string}
 */
export declare function ownerText(owner: Owner): string;
/**
 * Whether a lock's holder may be evicted: it is gone (no such process) or overstayed `staleMs`; or, with
 * no owner.json, the folder is a crash leftover (`ownerGraceMs` old). `ask` when its process decides and
 * `pidAlive` doesn't say.
 * @param {Pick<Rules, 'lock'>} rules
 * @param {{ owner: Owner | null, folderMtimeMs: number | null, nowMs: number, staleMs?: number, pidAlive?: boolean }} o
 * @returns {'stale' | 'held' | 'ask'}
 */
export declare function holderState(rules: Pick<Rules, 'lock'>, o: {
    owner: Owner | null;
    folderMtimeMs: number | null;
    nowMs: number;
    staleMs?: number;
    pidAlive?: boolean;
}): 'stale' | 'held' | 'ask';
/**
 * An accelerator's lock folders, one per slot: the first is `first` (the NPU's `npu`, a card's `gpu-…`),
 * the others `<first>.2` … `<first>.<slots>`.
 * @param {string} first
 * @param {number} slots
 * @returns {string[]}
 */
export declare function slotNames(first: string, slots: number): string[];
/**
 * The line's folder, beside the first lock folder: `<first>.queue`.
 * @param {string} first
 * @returns {string}
 */
export declare function queueName(first: string): string;
