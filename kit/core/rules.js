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
 * @property {number} probeMs How long a look at a server's /v1/models waits. A server that took the connection and gave no
 *   answer in that time is busy, not down: GenieX answers nothing while it loads a model or answers a request.
 * @property {number} readyWaitMs How long a busy server (no answer yet, or a 503 while it loads its model) may take to be ready.
 * @property {number} requestBaseMs A background chat or vision request's timeout is this, plus requestPerTokenMs per token it may answer.
 * @property {number} requestPerTokenMs What each token a background request may answer adds to its timeout.
 * @property {number} coldLoadMs What loading a model may take besides: a server just started, or GenieX swapping models.
 */

/**
 * @typedef {object} MannersRules
 * @property {number} maxWaitMs How long an agent's background request waits in a line.
 * @property {number} backOffMs How long an agent leaves an accelerator alone after a line too long or too slow.
 */

/**
 * @typedef {object} KeeperRules How the model servers are kept (ACCELERATORS.md, "Keeping the servers"): what the keeper
 *   (the Smith, else Reeve) does once a minute, and the defaults of config.json's idle times.
 * @property {number} lookEveryMs How often the keeper looks at every server it can start again.
 * @property {number} npuIdleStopMinutes config.json's npuIdleStopMinutes when it gives none: the NPU unused this long, its servers stop.
 * @property {number} gpuIdleStopMinutes config.json's gpuIdleStopMinutes when it gives none: a graphics card (or the processor) unused this long, its servers stop.
 * @property {number} gameGraceMs A card nobody has used this long has its servers stopped as soon as a game is using it.
 * @property {number} unansweredMs A server that hasn't answered this long, while nobody uses its accelerator, is restarted.
 * @property {number} recycleBytes GenieX's working set at which it is restarted while nobody uses the NPU: memory kept from earlier loads.
 * @property {number} turnWaitMs How long the keeper's turn waits for its first slot.
 * @property {number} turnMaxAhead The keeper's turn joins a line only with fewer than this many waiting: 1 is "only an empty line" (0 refuses every turn).
 * @property {number} otherSlotsWaitMs How long it waits for each of a card's other slots, held as plain locks.
 * @property {number} orphanGraceMs A model server on the manor's ports that no configured accelerator names (an orphan: a test's,
 *   a scratch home's, an old config's) is stopped once seen this long, so nothing nobody tracks keeps a card's memory.
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
 * @property {KeeperRules} keeper
 * @property {TokenRules} tokens
 */

/** @type {Record<keyof Rules, string[]>} */
const SHAPE = {
  queue: ['heartbeatMs', 'lateMs', 'deadMs', 'ageMs', 'headPollMs', 'pollMs'],
  lock: ['waitMs', 'staleMs', 'ownerGraceMs', 'pollMs', 'takeTries', 'removeTries', 'removeRetryMs'],
  accelerators: ['failedForMs', 'reasonMaxChars', 'gamePercent', 'gamesFreshMs', 'maxAhead', 'maxSlots', 'ownMemoryGb', 'defaultMaxContextTokens', 'defaultRequestTimeoutMs', 'startWaitMs', 'probeMs', 'readyWaitMs', 'requestBaseMs', 'requestPerTokenMs', 'coldLoadMs'],
  manners: ['maxWaitMs', 'backOffMs'],
  keeper: ['lookEveryMs', 'npuIdleStopMinutes', 'gpuIdleStopMinutes', 'gameGraceMs', 'unansweredMs', 'recycleBytes', 'turnWaitMs', 'turnMaxAhead', 'otherSlotsWaitMs', 'orphanGraceMs'],
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
