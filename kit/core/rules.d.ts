// Made by kit/test/core-types.ts from rules.js's JSDoc: don't edit it, run npm run core-types.
export type QueueRules = {
    /**
     * A waiter touches its ticket at least this often.
     */
    heartbeatMs: number;
    /**
     * A ticket this stale is late: its process is checked, and it is dead if that's gone.
     */
    lateMs: number;
    /**
     * A ticket this stale is dead whatever its pid says (pids get reused).
     */
    deadMs: number;
    /**
     * A background ticket this old is served as if it were interactive.
     */
    ageMs: number;
    /**
     * How often the head of the line tries the lock.
     */
    headPollMs: number;
    /**
     * How often the rest of the line looks.
     */
    pollMs: number;
};
export type LockRules = {
    /**
     * How long a turn waits by default.
     */
    waitMs: number;
    /**
     * When a holder counts as overstayed, by default.
     */
    staleMs: number;
    /**
     * A lock folder with no owner.json this long is a crash leftover.
     */
    ownerGraceMs: number;
    /**
     * How often the plain lock (no line) tries again.
     */
    pollMs: number;
    /**
     * Tries at one lock folder in one go: a stale holder is evicted between them.
     */
    takeTries: number;
    /**
     * How many times a removal tries while a file in the folder is open.
     */
    removeTries: number;
    /**
     * How long between those tries.
     */
    removeRetryMs: number;
};
export type AcceleratorRules = {
    /**
     * A failed accelerator is skipped for this long after its marker's since.
     */
    failedForMs: number;
    /**
     * A failure marker's reason is one line, at most this long.
     */
    reasonMaxChars: number;
    /**
     * A card is in use by a game while another program keeps a 3D engine over this.
     */
    gamePercent: number;
    /**
     * games.json is checked again when it's older than this.
     */
    gamesFreshMs: number;
    /**
     * A background request doesn't join a line with this many already waiting.
     */
    maxAhead: number;
    /**
     * The most slots an accelerator other than the NPU may have.
     */
    maxSlots: number;
    /**
     * A graphics card with this much memory of its own comes first in auto order.
     */
    ownMemoryGb: number;
    /**
     * An accelerator's cap when its entry gives none.
     */
    defaultMaxContextTokens: number;
    /**
     * The config's requestTimeoutMs when it gives none.
     */
    defaultRequestTimeoutMs: number;
    /**
     * How long a model server may take to come up after its startCommand.
     */
    startWaitMs: number;
};
export type MannersRules = {
    /**
     * How long an agent's background request waits in a line.
     */
    maxWaitMs: number;
    /**
     * How long an agent leaves an accelerator alone after a line too long or too slow.
     */
    backOffMs: number;
};
export type TokenRules = {
    /**
     * The pessimistic estimate: one token per this many characters.
     */
    charsPerToken: number;
    /**
     * What each chat message adds, in characters.
     */
    messageChars: number;
    /**
     * Room kept for a nonce and /no_think, in characters.
     */
    quirkRoomChars: number;
    /**
     * What an image counts for, in tokens.
     */
    imageTokens: number;
    /**
     * The smallest piece long text is split into, in characters.
     */
    minPieceChars: number;
};
export type Rules = {
    queue: QueueRules;
    lock: LockRules;
    accelerators: AcceleratorRules;
    manners: MannersRules;
    tokens: TokenRules;
};
/**
 * spec/rules.json's contents as the core takes them: every timing and limit present, a whole number of
 * zero or more. Throws, naming what's wrong, for anything else; keys it doesn't know are left out.
 * @param {unknown} raw The parsed file.
 * @returns {Rules}
 */
export declare function checkRules(raw: unknown): Rules;
