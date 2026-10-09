// A turn on an accelerator, as a state machine (NPU-QUEUE.md, "Waiting"): the core decides, a driver acts.
//
//   let r = startTurn(rules, { slots, pid, nowMs, nowUs, nonce, lane, who });
//   for (;;) {
//     const results = r.actions.map(perform);       // in order; each gives null, a value, or { error }
//     if (r.done) break;                             // held, or an error ({ error, message })
//     await sleep(r.waitMs);
//     r = step(r.state, { nowMs: Date.now(), results });
//   }
//   ... the work, holding r.done.held.slot ...
//   r = release(r.state, Date.now()); and the same loop again until r.done.
//
// Every path is a list of names below the driver's base folder: the folder that holds the lock folders
// (`<locks>`), so `['npu.queue', '<ticket>']` is `<locks>\npu.queue\<ticket>`. The core never mutates
// a state it is given, and keeps nothing between calls: a state is plain data (JSON), and the same state
// and observation always give the same step.

import { say, whatOf } from './messages.js';
import { holderState, judgeLine, ownerText, queueName, readOwner, ticketName, ticketText } from './queue.js';

/** @import { Rules } from './rules.js' */
/** @import { Owner } from './queue.js' */
/** @import { Lane } from './queue.js' */
/** @import { Entry } from './queue.js' */

/** @typedef {string[]} Path Names below the driver's base folder. */

/**
 * @typedef {{ op: 'mkdirs', path: Path }
 *   | { op: 'write', path: Path, text: string }
 *   | { op: 'touch', path: Path }
 *   | { op: 'list', path: Path }
 *   | { op: 'alive', pids: number[] }
 *   | { op: 'remove', path: Path }
 *   | { op: 'mkdir', path: Path }
 *   | { op: 'read', path: Path }
 *   | { op: 'stat', path: Path }
 *   | { op: 'rmdir', path: Path }
 *   | { op: 'note', text: string }} Action
 * What a driver does for the core, each with the result it gives:
 * - `mkdirs`: create the folder and any above it, if missing. Null.
 * - `write`: write the file whole (UTF-8). Null.
 * - `touch`: set the file's modification time to now. Null.
 * - `list`: the folder's files, `{ entries: [{ name, mtimeMs }] }`; mtimeMs null for one gone meanwhile.
 * - `alive`: whether each process is running, `{ alive: [bool, …] }` in the pids' order.
 * - `remove`: delete the file. Null.
 * - `mkdir`: create the folder, failing with EEXIST when it exists: the atomic test-and-set the lock rests on. Null.
 * - `read`: the file's text, `{ text }`, opened sharing read, write and delete.
 * - `stat`: `{ mtimeMs }`, the modification time.
 * - `rmdir`: remove the folder and everything in it. Null; a folder already gone counts as removed.
 * - `note`: something worth a line in a log (`text`). Null.
 * Any of them may fail instead: `{ error, message? }`, error a Node-style code (ENOENT, EEXIST, EBUSY,
 * EPERM, EACCES, ENOTEMPTY; anything else as the driver names it), message the system's own words.
 */

/**
 * @typedef {null | { error: string, message?: string } | { entries: Entry[] } | { alive: boolean[] } | { text: string } | { mtimeMs: number }} Result
 */

/**
 * @typedef {object} Observation What the driver saw: the clock after the last step's actions and wait, and each action's result in order.
 * @property {number} nowMs Wall-clock milliseconds since the Unix epoch.
 * @property {Result[]} results
 */

/**
 * @typedef {{ held: { slot: number, owner: Owner } }
 *   | { error: 'timeout' | 'full' | 'io', message: string }
 *   | { released: boolean }
 *   | { aborted: true }} Done
 * How a machine ended: the lock held (its slot, and the owner.json written, for the release); no turn
 * (`timeout`: the wait ran out; `full`: the line was longer than `maxAhead`; `io`: the disk refused);
 * the release done (`released` false when the lock was no longer ours, or stayed open); or aborted.
 */

/**
 * @typedef {object} TurnState A machine's state: plain data, the core's own (drivers only carry it).
 * @property {'turn' | 'lock'} machine
 * @property {string} phase
 * @property {{ queue: Rules['queue'], lock: Rules['lock'] }} rules
 * @property {string[]} slots
 * @property {string | null} queue
 * @property {number} pid
 * @property {string | null} ticket
 * @property {string | null} body
 * @property {string} what
 * @property {number} waitMs
 * @property {number} staleMs
 * @property {number | null} maxAhead
 * @property {number | null} deadline
 * @property {number | null} beat
 * @property {number} tickMs
 * @property {boolean} joined
 * @property {boolean} head
 * @property {boolean} noted
 * @property {boolean} rejoined
 * @property {number} inLine
 * @property {{ then: 'count' | 'tick', atMs: number, entries: Entry[], ask: number[] } | null} line
 * @property {{ owner: Owner, mtimeMs: number | null, atMs: number } | null} check
 * @property {number} slot
 * @property {number} tries
 * @property {boolean} evicting
 * @property {number} removeTry
 * @property {Owner | null} me
 * @property {string[]} tags
 */

/**
 * @typedef {object} Step What the core decided: the next state, what to do now (in order), how long to
 * wait after, and, once the machine has ended, how.
 * @property {TurnState} state
 * @property {Action[]} actions
 * @property {number} waitMs
 * @property {Done} [done]
 */

/**
 * @typedef {object} TurnOptions
 * @property {string[]} slots The accelerator's lock folders (slotNames): the first is its lock, and its line is beside it.
 * @property {number} pid This process.
 * @property {number} nowMs
 * @property {number} nowUs The ticket's time: strictly increasing within the process (nextUs).
 * @property {string} nonce Random lowercase hex, 8 characters.
 * @property {Lane} [lane] Default background.
 * @property {string} who Shown to whoever looks at the line.
 * @property {string} [doing] What this request is for, shown beside `who` ("search index: Heiward (17 of 673 files)"): informational, at most DOING_MAX characters.
 * @property {string} [what] The accelerator in messages (default: "the NPU", or the folder's name).
 * @property {number} [waitMs] How long to wait in line (default rules.lock.waitMs).
 * @property {number} [staleMs] When a holder counts as overstayed (default rules.lock.staleMs).
 * @property {number} [maxAhead] Don't join when this many are already waiting: ends at once as `full`.
 */

/**
 * @typedef {object} LockOptions
 * @property {string} folder The lock folder's name, in the base folder.
 * @property {number} pid
 * @property {number} nowMs
 * @property {string} [what] The lock in messages (default the folder's name).
 * @property {number} [waitMs]
 * @property {number} [staleMs]
 */

/** What a removal fails with while a file in the folder is open (EBUSY, usually) or half removed. */
const BUSY = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'];

/**
 * @param {Result | undefined} r
 * @returns {string | null}
 */
const errorOf = (r) => (r && typeof r === 'object' && 'error' in r ? String(r.error) : null);

/**
 * @param {Result | undefined} r
 * @returns {string}
 */
const detailOf = (r) => (r && typeof r === 'object' && 'error' in r ? String(r.message || r.error) : 'it failed');

/** @typedef {[Action, string?]} Tagged */

/**
 * @param {TurnState} s
 * @param {string} phase
 * @param {Tagged[]} list
 * @param {number} [waitMs]
 * @param {Done} [done]
 * @returns {Step}
 */
function emit(s, phase, list, waitMs = 0, done) {
  const state = { ...s, phase, tags: list.map((x) => x[1] ?? '') };
  return { state, actions: list.map((x) => x[0]), waitMs, ...(done ? { done } : {}) };
}

/**
 * @param {TurnState} s
 * @param {Observation} obs
 * @param {string} tag
 * @returns {Result | undefined}
 */
function resultOf(s, obs, tag) {
  const i = s.tags.indexOf(tag);
  return i < 0 ? undefined : (obs.results ?? [])[i];
}

/**
 * The turn: join the accelerator's line, wait to head it, take a free slot (evicting a dead or overstayed
 * holder), and leave the line. Its first step.
 * @param {Rules} rules
 * @param {TurnOptions} o
 * @returns {Step}
 */
export function startTurn(rules, o) {
  const slots = [...o.slots];
  if (!slots.length) throw new Error('startTurn: no lock folders');
  const lane = o.lane === 'interactive' ? 'interactive' : 'background';
  /** @type {TurnState} */
  const s = {
    ...blank(rules, slots, o.pid, o.nowMs),
    machine: 'turn',
    queue: queueName(slots[0]),
    ticket: ticketName(lane, o.nowUs, o.pid, o.nonce),
    body: ticketText(lane, o.nowUs, o.pid, o.who, o.doing),
    what: o.what ?? whatOf(slots[0]),
    waitMs: o.waitMs ?? rules.lock.waitMs,
    staleMs: o.staleMs ?? rules.lock.staleMs,
    maxAhead: typeof o.maxAhead === 'number' ? o.maxAhead : null,
  };
  /** @type {Tagged} */
  const mkdirs = [{ op: 'mkdirs', path: [qOf(s)] }, 'queue'];
  if (s.maxAhead !== null) return readLine(s, 'count', [mkdirs]);
  return emit({ ...s, joined: true }, 'join', [mkdirs, [writeTicket(s), 'write']]);
}

/**
 * The plain lock, for a lock nobody queues for: take its folder (evicting a dead or overstayed holder),
 * trying again every rules.lock.pollMs. Its first step.
 * @param {Rules} rules
 * @param {LockOptions} o
 * @returns {Step}
 */
export function startLock(rules, o) {
  /** @type {TurnState} */
  const s = {
    ...blank(rules, [o.folder], o.pid, o.nowMs),
    machine: 'lock',
    what: o.what ?? o.folder,
    waitMs: o.waitMs ?? rules.lock.waitMs,
    staleMs: o.staleMs ?? rules.lock.staleMs,
  };
  return emit({ ...s, deadline: o.nowMs + s.waitMs }, 'lock-start', [[{ op: 'mkdirs', path: [] }, 'parent']]);
}

/**
 * @param {Rules} rules
 * @param {string[]} slots
 * @param {number} pid
 * @param {number} nowMs
 * @returns {TurnState}
 */
function blank(rules, slots, pid, nowMs) {
  return {
    machine: 'turn',
    phase: '',
    rules: { queue: { ...rules.queue }, lock: { ...rules.lock } },
    slots,
    queue: null,
    pid,
    ticket: null,
    body: null,
    what: slots[0],
    waitMs: rules.lock.waitMs,
    staleMs: rules.lock.staleMs,
    maxAhead: null,
    deadline: null,
    beat: null,
    tickMs: nowMs,
    joined: false,
    head: false,
    noted: false,
    rejoined: false,
    inLine: 0,
    line: null,
    check: null,
    slot: 0,
    tries: 0,
    evicting: false,
    removeTry: 0,
    me: null,
    tags: [],
  };
}

/** @param {TurnState} s */
const qOf = (s) => /** @type {string} */ (s.queue);
/** @param {TurnState} s */
const ticketPath = (s) => [qOf(s), /** @type {string} */ (s.ticket)];
/** @param {TurnState} s @returns {Action} */
const writeTicket = (s) => ({ op: 'write', path: ticketPath(s), text: /** @type {string} */ (s.body) });
/** @param {TurnState} s @returns {Tagged[]} */
const leave = (s) => (s.machine === 'turn' && s.joined ? [[{ op: 'remove', path: ticketPath(s) }]] : []);

/**
 * The machine's next step, from what the driver saw after the last.
 * @param {TurnState} state
 * @param {Observation} obs
 * @returns {Step}
 */
export function step(state, obs) {
  const s = state;
  const now = obs.nowMs;
  switch (s.phase) {
    case 'line': {
      const q = resultOf(s, obs, 'queue');
      if (errorOf(q)) return fail(s, q);
      const listed = resultOf(s, obs, 'list');
      // No folder is an empty line (someone removed it: a ticket write puts it back); any other refusal ends the turn.
      const e = errorOf(listed);
      if (e && e !== 'ENOENT') return fail(s, listed);
      const entries = listed && typeof listed === 'object' && 'entries' in listed ? listed.entries : [];
      return judged(s, now, entries, undefined);
    }
    case 'line-alive': {
      const line = /** @type {NonNullable<TurnState['line']>} */ (s.line);
      const a = resultOf(s, obs, 'alive');
      const flags = a && typeof a === 'object' && 'alive' in a ? a.alive : [];
      /** @type {Record<string, boolean>} */
      const alive = {};
      // A pid the driver couldn't check counts as running: a ticket is never taken for dead on a guess.
      line.ask.forEach((pid, i) => (alive[String(pid)] = flags[i] !== false));
      return judged(s, line.atMs, line.entries, alive);
    }
    case 'join': {
      const w = resultOf(s, obs, 'write');
      if (errorOf(resultOf(s, obs, 'queue')) || errorOf(w)) return fail(s, errorOf(w) ? w : resultOf(s, obs, 'queue'));
      return tick({ ...s, deadline: now + s.waitMs, beat: now }, now);
    }
    case 'beat': {
      if (errorOf(resultOf(s, obs, 'touch'))) {
        // Taken for dead (a long pause): back in, under the same name, which keeps its place.
        return emit(s, 'beat-rewrite', [[{ op: 'mkdirs', path: [qOf(s)] }], [writeTicket(s), 'write']]);
      }
      return readLine(s, 'tick');
    }
    case 'beat-rewrite': {
      const w = resultOf(s, obs, 'write');
      if (errorOf(w)) return fail(s, w);
      return readLine(s, 'tick');
    }
    case 'rejoin': {
      const w = resultOf(s, obs, 'write');
      if (errorOf(w)) return fail(s, w);
      return tick({ ...s, beat: now }, now);
    }
    case 'tick-wait':
      return tick(s, now);
    case 'lock-start': {
      const p = resultOf(s, obs, 'parent');
      if (errorOf(p)) return fail(s, p);
      return take(s, 0);
    }
    case 'lock-wait':
      return take(s, 0);
    case 'take': {
      const r = resultOf(s, obs, 'mkdir');
      const e = errorOf(r);
      if (!e) {
        const me = { pid: s.pid, since: now };
        return emit({ ...s, me }, 'own', [[{ op: 'write', path: [s.slots[s.slot], 'owner.json'], text: ownerText(me) }, 'owner']]);
      }
      if (e === 'EEXIST') return checkHolder(s);
      return fail(s, r);
    }
    case 'own': {
      const w = resultOf(s, obs, 'owner');
      if (errorOf(w)) return fail(s, w, [[{ op: 'rmdir', path: [s.slots[s.slot]] }]]);
      const owner = /** @type {Owner} */ (s.me);
      return emit(s, 'held', leave(s), 0, { held: { slot: s.slot, owner } });
    }
    case 'check': {
      const read = resultOf(s, obs, 'read');
      const stat = resultOf(s, obs, 'stat');
      const owner = readOwner(read && typeof read === 'object' && 'text' in read ? read.text : null);
      // A folder gone since the mkdir isn't stale: it is tried again next time round.
      const mtimeMs = stat && typeof stat === 'object' && 'mtimeMs' in stat ? stat.mtimeMs : null;
      return verdict(s, owner, mtimeMs, now, undefined);
    }
    case 'check-alive': {
      const c = /** @type {NonNullable<TurnState['check']>} */ (s.check);
      const a = resultOf(s, obs, 'alive');
      const flags = a && typeof a === 'object' && 'alive' in a ? a.alive : [];
      return verdict(s, c.owner, c.mtimeMs, c.atMs, flags[0] !== false);
    }
    case 'evict': {
      const r = resultOf(s, obs, 'rmdir');
      const e = errorOf(r);
      if (!e || e === 'ENOENT') {
        const tries = s.tries + 1;
        const next = { ...s, tries, evicting: false };
        if (tries < s.rules.lock.takeTries) return emit(next, 'take', [[{ op: 'mkdir', path: [s.slots[s.slot]] }, 'mkdir']]);
        return nextSlot(next, now);
      }
      if (BUSY.includes(e)) {
        if (s.removeTry >= s.rules.lock.removeTries) return nextSlot({ ...s, evicting: false }, now);
        return emit(s, 'evict-wait', [], s.rules.lock.removeRetryMs);
      }
      return fail(s, r);
    }
    case 'evict-wait':
      return checkHolder(s);
    case 'release-check': {
      const read = resultOf(s, obs, 'read');
      const owner = readOwner(read && typeof read === 'object' && 'text' in read ? read.text : null);
      const me = s.me;
      if (!owner || !me || owner.pid !== me.pid || owner.since !== me.since) return emit(s, 'released', [], 0, { released: false });
      return emit({ ...s, removeTry: s.removeTry + 1 }, 'release-rm', [[{ op: 'rmdir', path: [s.slots[s.slot]] }, 'rmdir']]);
    }
    case 'release-rm': {
      const e = errorOf(resultOf(s, obs, 'rmdir'));
      if (!e || e === 'ENOENT') return emit(s, 'released', [], 0, { released: true });
      if (BUSY.includes(e) && s.removeTry < s.rules.lock.removeTries) return emit(s, 'release-wait', [], s.rules.lock.removeRetryMs);
      // Left for the next taker's stale check.
      return emit(s, 'released', [], 0, { released: false });
    }
    case 'release-wait':
      return emit(s, 'release-check', [[{ op: 'read', path: [s.slots[s.slot], 'owner.json'] }, 'read']]);
    default:
      throw new Error(`step: the machine has ended (${s.phase || 'not started'})`);
  }
}

/**
 * Lets go of a held lock, only while owner.json still names this holder (pid and since): an evicted
 * holder must never remove the next one's. Its first step; `step` takes it on until `done.released`.
 * @param {TurnState} state The state that ended `held`.
 * @param {number} nowMs
 * @returns {Step}
 */
export function release(state, nowMs) {
  if (state.phase !== 'held') throw new Error(`release: the lock isn't held (${state.phase})`);
  return emit({ ...state, removeTry: 0, tickMs: nowMs }, 'release-check', [[{ op: 'read', path: [state.slots[state.slot], 'owner.json'] }, 'read']]);
}

/**
 * Gives up a machine that hasn't ended, as a driver does when something unexpected stops it: what to
 * undo (the ticket, when it is in line). A held lock is let go with `release` instead.
 * @param {TurnState} state
 * @returns {Step}
 */
export function abort(state) {
  const ended = ['held', 'released', 'ended'].includes(state.phase);
  return emit(state, 'ended', ended ? [] : leave(state), 0, { aborted: true });
}

/**
 * @param {TurnState} s
 * @param {'count' | 'tick'} then
 * @param {Tagged[]} [pre]
 * @returns {Step}
 */
function readLine(s, then, pre = []) {
  return emit({ ...s, line: { then, atMs: 0, entries: [], ask: [] } }, 'line', [...pre, [{ op: 'list', path: [qOf(s)] }, 'list']]);
}

/**
 * The line read: dead tickets go, and the turn goes on as `then` says.
 * @param {TurnState} s
 * @param {number} atMs
 * @param {Entry[]} entries
 * @param {Record<string, boolean> | undefined} alive
 * @returns {Step}
 */
function judged(s, atMs, entries, alive) {
  const line = /** @type {NonNullable<TurnState['line']>} */ (s.line);
  const keep = line.then === 'tick' ? s.ticket : null;
  const v = judgeLine(s.rules, entries, atMs, { keep, alive });
  if (v.ask) return emit({ ...s, line: { ...line, atMs, entries, ask: v.ask } }, 'line-alive', [[{ op: 'alive', pids: v.ask }, 'alive']]);
  /** @type {Tagged[]} */
  const gone = v.dead.map((name) => [{ op: 'remove', path: [qOf(s), name] }]);
  const names = v.live.map((t) => t.name);
  if (line.then === 'count') {
    const max = /** @type {number} */ (s.maxAhead);
    if (names.length >= max) return emit(s, 'ended', gone, 0, { error: 'full', message: say.queueFull(names.length, s.what) });
    return emit({ ...s, joined: true }, 'join', [...gone, [{ op: 'mkdirs', path: [qOf(s)] }, 'queue'], [writeTicket(s), 'write']]);
  }
  const me = /** @type {string} */ (s.ticket);
  const at = { ...s, inLine: names.length };
  if (!names.includes(me)) {
    // Someone took it for dead (a long pause, a suspended laptop): back in, under the same name. Gone
    // again at once, it waits a poll before it looks, rather than spin.
    return emit({ ...at, rejoined: true }, 'rejoin', [...gone, [{ op: 'mkdirs', path: [qOf(s)] }], [writeTicket(s), 'write']], s.rejoined ? s.rules.queue.pollMs : 0);
  }
  if (s.rejoined) at.rejoined = false;
  if (names[0] === me) return take({ ...at, head: true }, 0, gone);
  /** @type {Tagged[]} */
  const note = at.noted ? [] : [[{ op: 'note', text: say.waitingInLine(s.what, names.indexOf(me)) }]];
  return tail({ ...at, head: false, noted: true }, s.tickMs, [...gone, ...note]);
}

/**
 * One time round the wait: the heartbeat when it's due, then the line.
 * @param {TurnState} s
 * @param {number} now
 * @returns {Step}
 */
function tick(s, now) {
  const t = { ...s, tickMs: now };
  if (now - /** @type {number} */ (s.beat) >= s.rules.queue.heartbeatMs) return emit({ ...t, beat: now }, 'beat', [[{ op: 'touch', path: ticketPath(s) }, 'touch']]);
  return readLine(t, 'tick');
}

/**
 * One try at a slot's folder.
 * @param {TurnState} s
 * @param {number} slot
 * @param {Tagged[]} [pre]
 * @returns {Step}
 */
function take(s, slot, pre = []) {
  return emit({ ...s, slot, tries: 0, evicting: false }, 'take', [...pre, [{ op: 'mkdir', path: [s.slots[slot]] }, 'mkdir']]);
}

/**
 * @param {TurnState} s
 * @returns {Step}
 */
function checkHolder(s) {
  const dir = s.slots[s.slot];
  return emit(s, 'check', [
    [{ op: 'read', path: [dir, 'owner.json'] }, 'read'],
    [{ op: 'stat', path: [dir] }, 'stat'],
  ]);
}

/**
 * The holder judged: evicted when stale, else the next slot.
 * @param {TurnState} s
 * @param {Owner | null} owner
 * @param {number | null} mtimeMs
 * @param {number} atMs
 * @param {boolean | undefined} pidAlive
 * @returns {Step}
 */
function verdict(s, owner, mtimeMs, atMs, pidAlive) {
  const h = holderState(s.rules, { owner, folderMtimeMs: mtimeMs, nowMs: atMs, staleMs: s.staleMs, pidAlive });
  if (h === 'ask' && owner) return emit({ ...s, check: { owner, mtimeMs, atMs } }, 'check-alive', [[{ op: 'alive', pids: [owner.pid] }, 'alive']]);
  if (h !== 'stale') return nextSlot({ ...s, evicting: false }, atMs);
  const first = !s.evicting;
  const what = s.slot === 0 ? s.what : s.slots[s.slot];
  /** @type {Tagged[]} */
  const note = first ? [[{ op: 'note', text: say.takingOver(what) }]] : [];
  return emit({ ...s, evicting: true, removeTry: first ? 1 : s.removeTry + 1 }, 'evict', [...note, [{ op: 'rmdir', path: [s.slots[s.slot]] }, 'rmdir']]);
}

/**
 * The next slot, or, with none left, the end of this time round.
 * @param {TurnState} s
 * @param {number} now
 * @returns {Step}
 */
function nextSlot(s, now) {
  if (s.machine === 'turn' && s.slot + 1 < s.slots.length) return take(s, s.slot + 1);
  return tail(s, s.machine === 'turn' ? s.tickMs : now, []);
}

/**
 * No turn this time round: give up when the wait is over, else wait and look again (the head of the
 * line sooner, so the hand-over is quick).
 * @param {TurnState} s
 * @param {number} now
 * @param {Tagged[]} pre
 * @returns {Step}
 */
function tail(s, now, pre) {
  if (now > /** @type {number} */ (s.deadline)) {
    const message = s.machine === 'turn' ? say.turnTimedOut(s.waitMs, s.what, s.inLine) : say.lockTimedOut(s.waitMs, s.what);
    return emit(s, 'ended', [...pre, ...leave(s)], 0, { error: 'timeout', message });
  }
  if (s.machine === 'lock') return emit(s, 'lock-wait', pre, s.rules.lock.pollMs);
  return emit(s, 'tick-wait', pre, s.head ? s.rules.queue.headPollMs : s.rules.queue.pollMs);
}

/**
 * The disk refused: no turn, and the ticket leaves the line.
 * @param {TurnState} s
 * @param {Result | undefined} r
 * @param {Tagged[]} [undo]
 * @returns {Step}
 */
function fail(s, r, undo = []) {
  return emit(s, 'ended', [...undo, ...leave(s)], 0, { error: 'io', message: say.lockFailed(s.what, detailOf(r)) });
}
