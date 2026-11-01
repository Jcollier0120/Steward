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
     * npu-call.json not written again for this long is a call that ended without saying so.
     */
    callFreshMs: number;
    /**
     * A driver-work.json entry holding further ahead than this (a clock moved back) doesn't count.
     */
    driverWorkMaxMs: number;
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
    /**
     * How long a look at a server's /v1/models waits. A server that took the connection and gave no
     * answer in that time is busy, not down: GenieX answers nothing while it loads a model or answers a request.
     */
    probeMs: number;
    /**
     * How long a busy server (no answer yet, or a 503 while it loads its model) may take to be ready.
     */
    readyWaitMs: number;
    /**
     * A background chat or vision request's timeout is this, plus requestPerTokenMs per token it may answer.
     */
    requestBaseMs: number;
    /**
     * What each token a background request may answer adds to its timeout.
     */
    requestPerTokenMs: number;
    /**
     * What loading a model may take besides: a server just started, or GenieX swapping models.
     */
    coldLoadMs: number;
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
export type KeeperRules = {
    /**
     * How often the keeper looks at every server it can start again.
     */
    lookEveryMs: number;
    /**
     * config.json's npuIdleStopMinutes when it gives none: the NPU unused this long, its servers stop.
     */
    npuIdleStopMinutes: number;
    /**
     * config.json's gpuIdleStopMinutes when it gives none: a graphics card (or the processor) unused this long, its servers stop.
     */
    gpuIdleStopMinutes: number;
    /**
     * A card nobody has used this long has its servers stopped as soon as a game is using it.
     */
    gameGraceMs: number;
    /**
     * The NPU nobody has used this long has its servers stopped while a call that doesn't need them is on.
     */
    callGraceMs: number;
    /**
     * A card the Watchman is changing the driver of has its servers stopped once its requests under way end, or after this long.
     */
    driverGraceMs: number;
    /**
     * A server that hasn't answered this long, while nobody uses its accelerator, is restarted.
     */
    unansweredMs: number;
    /**
     * GenieX's working set at which it is restarted while nobody uses the NPU: memory kept from earlier loads.
     */
    recycleBytes: number;
    /**
     * How long the keeper's turn waits for its first slot.
     */
    turnWaitMs: number;
    /**
     * The keeper's turn joins a line only with fewer than this many waiting: 1 is "only an empty line" (0 refuses every turn).
     */
    turnMaxAhead: number;
    /**
     * How long it waits for each of a card's other slots, held as plain locks.
     */
    otherSlotsWaitMs: number;
    /**
     * A model server on the manor's ports that no configured accelerator names (an orphan: a test's,
     * a scratch home's, an old config's) is stopped once seen this long, so nothing nobody tracks keeps a card's memory.
     */
    orphanGraceMs: number;
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
export type SpeedRules = {
    /**
     * Each program keeps this many of its latest speeds per boot, accelerator, model and answer size.
     */
    keptPerBoot: number;
    /**
     * Each program keeps its speeds from this many boots, the latest.
     */
    keptBoots: number;
    /**
     * A boot's speed for one answer size counts once there are this many of them.
     */
    samplesNeeded: number;
    /**
     * This boot is slow when its speed is this percent of the usual or less.
     */
    slowPercent: number;
    /**
     * Two boot times this close are the same boot (the clock may be set after the uptime starts).
     */
    bootSlackMs: number;
};
export type NpuPaceRules = {
    /**
     * A look at the PC's room (its power, heat and who else uses the NPU) stands this long for every agent.
     */
    roomFreshMs: number;
    /**
     * A look that takes longer than this is given up: the room is unknown, and the NPU stays gentle.
     */
    lookWaitMs: number;
    /**
     * One stretch of an agent's backlog runs at most this long; the rest waits for its next round.
     */
    stretchMs: number;
    /**
     * Another program using the NPU this much (percent of a second) or more keeps it gentle.
     */
    otherUsePercent: number;
};
export type Rules = {
    queue: QueueRules;
    lock: LockRules;
    accelerators: AcceleratorRules;
    manners: MannersRules;
    keeper: KeeperRules;
    tokens: TokenRules;
    speed: SpeedRules;
    npuPace: NpuPaceRules;
};
/**
 * spec/rules.json's contents as the core takes them: every timing and limit present, a whole number of
 * zero or more. Throws, naming what's wrong, for anything else; keys it doesn't know are left out.
 * @param {unknown} raw The parsed file.
 * @returns {Rules}
 */
export declare function checkRules(raw: unknown): Rules;
