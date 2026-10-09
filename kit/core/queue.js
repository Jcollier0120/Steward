// The NPU queue's rules (NPU-QUEUE.md): tickets and their order, the late, dead and aged rules, a lock
// holder's eviction, and each accelerator's folders. Pure: what a driver read from disk comes in, and
// what it should do goes out. The turn itself, step by step, is turn.js.

/** @import { Rules } from './rules.js' */

/** @typedef {'interactive' | 'background'} Lane */

/**
 * @typedef {object} Ticket A waiter's ticket, from its file name `<lane>-<time>-<pid>-<nonce>.ticket`.
 * @property {string} name
 * @property {0 | 1} lane 0 = interactive (a person is waiting), 1 = background.
 * @property {number} timeUs When it joined, in microseconds since the Unix epoch.
 * @property {number} pid
 * @property {string} nonce
 */

/**
 * @typedef {object} Owner A lock's owner.json.
 * @property {number} pid
 * @property {number} since When it took the lock, in milliseconds since the Unix epoch.
 */

/**
 * @typedef {object} Entry A file in the line's folder, as a driver lists it.
 * @property {string} name
 * @property {number | null} mtimeMs Its modification time; null when it went before it could be read.
 * @property {string} [text] Its contents, when the driver read them (for a snapshot).
 */

/**
 * @typedef {object} Waiting A live ticket, as a status page shows it.
 * @property {number} pid
 * @property {Lane} lane
 * @property {number} since When it joined, in milliseconds.
 * @property {string} [who] Who it is, from the ticket's contents.
 * @property {string} [doing] What the request is for, from the ticket's contents, when it says.
 */

const TICKET = /^([01])-(\d{17})-(\d+)-([0-9a-z]+)\.ticket$/;

/**
 * A ticket from its file name, or null for anything that isn't one.
 * @param {string} name
 * @returns {Ticket | null}
 */
export function parseTicket(name) {
  const m = TICKET.exec(name);
  return m ? { name, lane: m[1] === '0' ? 0 : 1, timeUs: Number(m[2]), pid: Number(m[3]), nonce: m[4] } : null;
}

/**
 * A ticket's file name: its lane, the time as 17 digits, the pid and the nonce (random lowercase hex).
 * @param {Lane} lane
 * @param {number} timeUs
 * @param {number} pid
 * @param {string} nonce
 * @returns {string}
 */
export function ticketName(lane, timeUs, pid, nonce) {
  return `${lane === 'interactive' ? 0 : 1}-${String(timeUs).padStart(17, '0')}-${pid}-${nonce}.ticket`;
}

/** The longest `doing` a ticket carries: a longer one is cut, ending in an ellipsis. */
export const DOING_MAX = 80;

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
export function ticketText(lane, timeUs, pid, who, doing) {
  const d = typeof doing === 'string' ? doing.trim() : '';
  const said = d.length > DOING_MAX ? `${d.slice(0, DOING_MAX - 1)}…` : d;
  return JSON.stringify({ pid, since: Math.floor(timeUs / 1000), lane, who, ...(said ? { doing: said } : {}) });
}

/**
 * A clock's next reading in microseconds, strictly increasing within a process: the wall clock's, or one
 * past the last when the wall clock hasn't moved on. The driver keeps the last.
 * @param {number} lastUs
 * @param {number} wallUs
 * @returns {number}
 */
export function nextUs(lastUs, wallUs) {
  return wallUs > lastUs ? wallUs : lastUs + 1;
}

/**
 * The order of the line: interactive first, then by arrival, then pid, then nonce; a background ticket
 * that has waited `ageMs` counts as interactive.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {Ticket} a
 * @param {Ticket} b
 * @param {number} nowUs
 * @returns {number}
 */
export function compareTickets(rules, a, b, nowUs) {
  /** @param {Ticket} t */
  const lane = (t) => (t.lane === 0 || nowUs - t.timeUs >= rules.queue.ageMs * 1000 ? 0 : 1);
  return lane(a) - lane(b) || a.timeUs - b.timeUs || a.pid - b.pid || (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0);
}

/**
 * How stale a ticket's heartbeat is: `fresh`; `late`, when its process decides (gone: dead); or `dead`,
 * whatever its pid says.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {number} ageMs Now less its modification time.
 * @returns {'fresh' | 'late' | 'dead'}
 */
export function ticketState(rules, ageMs) {
  return ageMs > rules.queue.deadMs ? 'dead' : ageMs > rules.queue.lateMs ? 'late' : 'fresh';
}

/**
 * Whether a ticket's waiter is gone: no heartbeat for `deadMs`, or a late heartbeat and no such process.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {number} ageMs
 * @param {boolean} pidAlive
 * @returns {boolean}
 */
export function isDeadTicket(rules, ageMs, pidAlive) {
  const s = ticketState(rules, ageMs);
  return s === 'dead' || (s === 'late' && !pidAlive);
}

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
export function judgeLine(rules, entries, nowMs, opts = {}) {
  const alive = opts.alive ?? {};
  /** @type {Ticket[]} */
  const live = [];
  /** @type {string[]} */
  const dead = [];
  /** @type {number[]} */
  const ask = [];
  for (const e of entries) {
    const t = parseTicket(e.name);
    if (!t || typeof e.mtimeMs !== 'number') continue;
    if (e.name === opts.keep) {
      live.push(t);
      continue;
    }
    const s = ticketState(rules, nowMs - e.mtimeMs);
    if (s === 'dead') dead.push(t.name);
    else if (s === 'fresh') live.push(t);
    else if (!(String(t.pid) in alive)) {
      if (!ask.includes(t.pid)) ask.push(t.pid);
    } else if (alive[String(t.pid)]) live.push(t);
    else dead.push(t.name);
  }
  if (ask.length) return { ask, live: [], dead: [] };
  const nowUs = nowMs * 1000;
  live.sort((a, b) => compareTickets(rules, a, b, nowUs));
  return { live, dead };
}

/**
 * Who is waiting, in line order, for a status page: the live tickets, each with `who` and `doing` from its
 * contents when they say. Reads only: the dead are left out, not deleted.
 * @param {Pick<Rules, 'queue'>} rules
 * @param {Entry[]} entries
 * @param {number} nowMs
 * @param {Record<string, boolean>} [alive]
 * @returns {{ ask: number[] } | { waiting: Waiting[] }}
 */
export function waitingOf(rules, entries, nowMs, alive) {
  const v = judgeLine(rules, entries, nowMs, { alive });
  if (v.ask) return { ask: v.ask };
  /** @type {Map<string, string | undefined>} */
  const texts = new Map(entries.map((e) => [e.name, e.text]));
  return {
    waiting: v.live.map((t) => {
      const text = texts.get(t.name);
      const who = fieldOf(text, 'who');
      const doing = fieldOf(text, 'doing');
      return { pid: t.pid, lane: t.lane === 0 ? 'interactive' : 'background', since: Math.floor(t.timeUs / 1000), ...(who === undefined ? {} : { who }), ...(doing === undefined ? {} : { doing }) };
    }),
  };
}

/**
 * One of a ticket's informational fields, when its contents have it as a string. A `doing` longer than
 * DOING_MAX (a writer that didn't cut it) is cut here.
 * @param {string | undefined} text
 * @param {'who' | 'doing'} key
 * @returns {string | undefined}
 */
function fieldOf(text, key) {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text);
    const s = v && typeof v === 'object' && typeof v[key] === 'string' ? v[key] : undefined;
    return key === 'doing' && s !== undefined ? (s.trim() ? (s.length > DOING_MAX ? `${s.slice(0, DOING_MAX - 1)}…` : s) : undefined) : s;
  } catch {
    return undefined;
  }
}

/**
 * A lock's owner.json, or null when it's missing, half written or not one.
 * @param {string | null | undefined} text
 * @returns {Owner | null}
 */
export function readOwner(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''));
    return v && typeof v === 'object' && typeof v.pid === 'number' && typeof v.since === 'number' ? { pid: v.pid, since: v.since } : null;
  } catch {
    return null;
  }
}

/**
 * owner.json's contents: `{"pid", "since"}`.
 * @param {Owner} owner
 * @returns {string}
 */
export function ownerText(owner) {
  return JSON.stringify({ pid: owner.pid, since: owner.since });
}

/**
 * Whether a lock's holder may be evicted: it is gone (no such process) or overstayed `staleMs`; or, with
 * no owner.json, the folder is a crash leftover (`ownerGraceMs` old). `ask` when its process decides and
 * `pidAlive` doesn't say.
 * @param {Pick<Rules, 'lock'>} rules
 * @param {{ owner: Owner | null, folderMtimeMs: number | null, nowMs: number, staleMs?: number, pidAlive?: boolean }} o
 * @returns {'stale' | 'held' | 'ask'}
 */
export function holderState(rules, o) {
  if (!o.owner) return o.folderMtimeMs !== null && o.nowMs - o.folderMtimeMs > rules.lock.ownerGraceMs ? 'stale' : 'held';
  if (o.nowMs - o.owner.since > (o.staleMs ?? rules.lock.staleMs)) return 'stale';
  if (o.pidAlive === undefined) return 'ask';
  return o.pidAlive ? 'held' : 'stale';
}

/**
 * An accelerator's lock folders, one per slot: the first is `first` (the NPU's `npu`, a card's `gpu-…`),
 * the others `<first>.2` … `<first>.<slots>`.
 * @param {string} first
 * @param {number} slots
 * @returns {string[]}
 */
export function slotNames(first, slots) {
  return Array.from({ length: Math.max(1, Math.floor(slots) || 1) }, (_, i) => (i === 0 ? first : `${first}.${i + 1}`));
}

/**
 * The line's folder, beside the first lock folder: `<first>.queue`.
 * @param {string} first
 * @returns {string}
 */
export function queueName(first) {
  return `${first}.queue`;
}
