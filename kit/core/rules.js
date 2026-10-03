// The kit's timings and limits: spec/rules.json, checked. The core never reads a file, so a driver reads
// that file and hands its contents to checkRules once; every core function that needs a timing takes the
// result as its first argument.

/**
 * @typedef {object} QueueRules
 * @property {number} heartbeatMs A waiter touches its ticket at least this often.
 * @property {number} lateMs A ticket this stale is late: its process is checked, and it is dead if that's gone.
 * @property {number} deadMs A ticket this stale is dead whatever its pid says (pids get reused).
 * @property {number} ageMs A background ticket this old is served as if it were interactive.
 * @property {number} headPollMs How often the head of the line tries the lock.
 * @property {number} pollMs How often the rest of the line looks.
 */

/**
 * @typedef {object} LockRules
 * @property {number} waitMs How long a turn waits by default.
 * @property {number} staleMs When a holder counts as overstayed, by default.
 * @property {number} ownerGraceMs A lock folder with no owner.json this long is a crash leftover.
 * @property {number} pollMs How often the plain lock (no line) tries again.
 * @property {number} takeTries Tries at one lock folder in one go: a stale holder is evicted between them.
 * @property {number} removeTries How many times a removal tries while a file in the folder is open.
 * @property {number} removeRetryMs How long between those tries.
 */

/**
 * @typedef {object} AcceleratorRules
 * @property {number} failedForMs A failed accelerator is skipped for this long after its marker's since.
 * @property {number} reasonMaxChars A failure marker's reason is one line, at most this long.
 * @property {number} gamePercent A card is in use by a game while another program keeps a 3D engine over this.
 * @property {number} gamesFreshMs games.json is checked again when it's older than this.
 * @property {number} maxAhead A background request doesn't join a line with this many already waiting.
 * @property {number} maxSlots The most slots an accelerator other than the NPU may have.
 * @property {number} ownMemoryGb A graphics card with this much memory of its own comes first in auto order.
 * @property {number} defaultMaxContextTokens An accelerator's cap when its entry gives none.
 * @property {number} defaultRequestTimeoutMs The config's requestTimeoutMs when it gives none.
 * @property {number} startWaitMs How long a model server may take to come up after its startCommand.
 */

/**
 * @typedef {object} MannersRules
 * @property {number} maxWaitMs How long an agent's background request waits in a line.
 * @property {number} backOffMs How long an agent leaves an accelerator alone after a line too long or too slow.
 */

/**
 * @typedef {object} TokenRules
 * @property {number} charsPerToken The pessimistic estimate: one token per this many characters.
 * @property {number} messageChars What each chat message adds, in characters.
 * @property {number} quirkRoomChars Room kept for a nonce and /no_think, in characters.
 * @property {number} imageTokens What an image counts for, in tokens.
 * @property {number} minPieceChars The smallest piece long text is split into, in characters.
 */

/**
 * @typedef {object} Rules
 * @property {QueueRules} queue
 * @property {LockRules} lock
 * @property {AcceleratorRules} accelerators
 * @property {MannersRules} manners
 * @property {TokenRules} tokens
 */

/** @type {Record<keyof Rules, string[]>} */
const SHAPE = {
  queue: ['heartbeatMs', 'lateMs', 'deadMs', 'ageMs', 'headPollMs', 'pollMs'],
  lock: ['waitMs', 'staleMs', 'ownerGraceMs', 'pollMs', 'takeTries', 'removeTries', 'removeRetryMs'],
  accelerators: ['failedForMs', 'reasonMaxChars', 'gamePercent', 'gamesFreshMs', 'maxAhead', 'maxSlots', 'ownMemoryGb', 'defaultMaxContextTokens', 'defaultRequestTimeoutMs', 'startWaitMs'],
  manners: ['maxWaitMs', 'backOffMs'],
  tokens: ['charsPerToken', 'messageChars', 'quirkRoomChars', 'imageTokens', 'minPieceChars'],
};

/**
 * spec/rules.json's contents as the core takes them: every timing and limit present, a whole number of
 * zero or more. Throws, naming what's wrong, for anything else; keys it doesn't know are left out.
 * @param {unknown} raw The parsed file.
 * @returns {Rules}
 */
export function checkRules(raw) {
  /** @type {any} */
  const r = raw;
  if (!r || typeof r !== 'object') throw new Error('rules.json holds no object');
  /** @type {any} */
  const out = {};
  for (const [section, keys] of Object.entries(SHAPE)) {
    const s = r[section];
    if (!s || typeof s !== 'object') throw new Error(`rules.json has no "${section}"`);
    /** @type {Record<string, number>} */
    const part = {};
    for (const k of keys) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`rules.json's ${section}.${k} must be a whole number of zero or more`);
      part[k] = v;
    }
    out[section] = Object.freeze(part);
  }
  return Object.freeze(out);
}
