// Made by kit/test/core-types.ts from accelerators.js's JSDoc: don't edit it, run npm run core-types.
import type { Rules } from './rules.js';
import type { AcceleratorKind } from './ids.js';
import type { AcceleratorRef } from './ids.js';
import type { DxgiAdapter } from './ids.js';
import type { Lane } from './queue.js';
export type Work = 'chat' | 'vision' | 'embed';
export type Endpoint = {
    baseUrl: string;
    model: string;
    startCommand?: string[];
    /**
     * What its server's environment needs besides this one's (OpenVINO Model Server's
     * PYTHONHOME and PATH), set when its startCommand starts it. `%NAME%` is expanded.
     */
    env?: Record<string, string>;
    /**
     * This kind's own request cap, when it differs from its accelerator's (an NPU's
     * vision model may take less than its chat model): capFor.
     */
    maxContextTokens?: number;
    /**
     * The accelerator whose lock and line its requests take, when its server runs on another
     * device than its accelerator's: the NPU 3720's embedding server, on the processor's graphics, takes the graphics'
     * (`gpu-…`), so it answers beside the NPU's chat. A `gpu-…` id or `cpu`; without it, its accelerator's own: turnOf.
     */
    turn?: string;
    /**
     * This kind's own request timings, over its accelerator's, when they differ (vision on
     * a card whose pictures are encoded on the processor): timeoutsFor.
     */
    timeouts?: Timeouts;
    /**
     * Vision's: the most tokens a picture may be on its server, where the server reads a
     * picture at its own size, a token per 32 × 32 px (Qwen3-VL through GenieX's llama.cpp plugin). The kit redraws a larger
     * picture to fit first (the node part's fitPicture) and counts each picture so (pictureTokensFor).
     */
    pictureTokens?: number;
};
export type Timeouts = {
    requestBaseMs?: number;
    requestPerTokenMs?: number;
    coldLoadMs?: number;
};
export type Accelerator = {
    /**
     * `npu`, `cpu`, or `gpu-` and the card's name (acceleratorId).
     */
    id: string;
    kind: AcceleratorKind;
    /**
     * The device's own name, from what this PC is (acceleratorName), never from the config:
     * "Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Hexagon NPU", "NVIDIA GeForce RTX 4090".
     */
    name: string;
    /**
     * A graphics card's own memory, in GB; null when unknown. Under 2 GB, it shares the PC's.
     */
    memoryGb: number | null;
    /**
     * How many requests it serves at once (llama-server's --parallel). The NPU has 1.
     */
    slots: number;
    /**
     * The most a request may be, prompt and answer, by the kit's pessimistic estimate.
     */
    maxContextTokens: number;
    chat?: Endpoint;
    /**
     * A vision endpoint without a server of its own is on the chat endpoint's.
     */
    vision?: Endpoint;
    embed?: Endpoint;
    /**
     * `prefix-leak`, `image-path`, `sides-of-32` (QUIRKS).
     */
    quirks: string[];
    /**
     * false: kept in the list, sent nothing.
     */
    enabled?: boolean;
    /**
     * Its own request timings (requestTimeoutMs), when its server needs other than the rules'.
     */
    timeouts?: Timeouts;
};
export type AcceleratorConfig = {
    /**
     * In the order requests try them: acceleratorOrder's, or auto's.
     */
    accelerators: Accelerator[];
    order: 'auto' | string[];
    requestTimeoutMs: number;
    /**
     * Read from an older config's chatEndpoint and embedEndpoint.
     */
    legacy: boolean;
    /**
     * Entries that couldn't be read, in words.
     */
    problems: string[];
};
export type Failure = {
    since: string;
    reason: string;
    by: string;
};
export type CardUse = {
    busy: boolean;
    percent: number;
    by: string[];
};
export type Games = {
    checkedAt: string;
    cards: Record<string, CardUse>;
};
export type GpuLoad = {
    adapters: DxgiAdapter[];
    counters: string;
    processes: Record<string, string>;
    compositor: number | null;
};
export type Need = {
    work: Work;
    tokens: number;
    lane: Lane;
};
export type Skipped = {
    acc: Accelerator;
    why: 'failed' | 'game' | 'deferred';
    detail: string;
};
export type Look = {
    freeSlot: boolean;
    waiting: number;
};
/** @import { Rules } from './rules.js' */
/** @import { AcceleratorKind } from './ids.js' */
/** @import { AcceleratorRef } from './ids.js' */
/** @import { DxgiAdapter } from './ids.js' */
/** @import { Lane } from './queue.js' */
/** @typedef {'chat' | 'vision' | 'embed'} Work */
/**
 * @typedef {object} Endpoint One OpenAI-compatible server: where it is, its model, and how to start it when it isn't running.
 * @property {string} baseUrl
 * @property {string} model
 * @property {string[]} [startCommand]
 * @property {Record<string, string>} [env] What its server's environment needs besides this one's (OpenVINO Model Server's
 * PYTHONHOME and PATH), set when its startCommand starts it. `%NAME%` is expanded.
 * @property {number} [maxContextTokens] This kind's own request cap, when it differs from its accelerator's (an NPU's
 * vision model may take less than its chat model): capFor.
 * @property {string} [turn] The accelerator whose lock and line its requests take, when its server runs on another
 * device than its accelerator's: the NPU 3720's embedding server, on the processor's graphics, takes the graphics'
 * (`gpu-…`), so it answers beside the NPU's chat. A `gpu-…` id or `cpu`; without it, its accelerator's own: turnOf.
 * @property {Timeouts} [timeouts] This kind's own request timings, over its accelerator's, when they differ (vision on
 * a card whose pictures are encoded on the processor): timeoutsFor.
 * @property {number} [pictureTokens] Vision's: the most tokens a picture may be on its server, where the server reads a
 * picture at its own size, a token per 32 × 32 px (Qwen3-VL through GenieX's llama.cpp plugin). The kit redraws a larger
 * picture to fit first (the node part's fitPicture) and counts each picture so (pictureTokensFor).
 */
/**
 * @typedef {object} Timeouts An accelerator's own request timings, over rules.json's accelerators (a slower NPU, a
 * server that loads its model slowly). Each left out is the rule's.
 * @property {number} [requestBaseMs]
 * @property {number} [requestPerTokenMs]
 * @property {number} [coldLoadMs]
 */
/**
 * @typedef {object} Accelerator
 * @property {string} id `npu`, `cpu`, or `gpu-` and the card's name (acceleratorId).
 * @property {AcceleratorKind} kind
 * @property {string} name The device's own name, from what this PC is (acceleratorName), never from the config:
 * "Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Hexagon NPU", "NVIDIA GeForce RTX 4090".
 * @property {number | null} memoryGb A graphics card's own memory, in GB; null when unknown. Under 2 GB, it shares the PC's.
 * @property {number} slots How many requests it serves at once (llama-server's --parallel). The NPU has 1.
 * @property {number} maxContextTokens The most a request may be, prompt and answer, by the kit's pessimistic estimate.
 * @property {Endpoint} [chat]
 * @property {Endpoint} [vision] A vision endpoint without a server of its own is on the chat endpoint's.
 * @property {Endpoint} [embed]
 * @property {string[]} quirks `prefix-leak`, `image-path`, `sides-of-32` (QUIRKS).
 * @property {boolean} [enabled] false: kept in the list, sent nothing.
 * @property {Timeouts} [timeouts] Its own request timings (requestTimeoutMs), when its server needs other than the rules'.
 */
/**
 * @typedef {object} AcceleratorConfig
 * @property {Accelerator[]} accelerators In the order requests try them: acceleratorOrder's, or auto's.
 * @property {'auto' | string[]} order
 * @property {number} requestTimeoutMs
 * @property {boolean} legacy Read from an older config's chatEndpoint and embedEndpoint.
 * @property {string[]} problems Entries that couldn't be read, in words.
 */
/**
 * @typedef {object} Failure A failure marker that still counts.
 * @property {string} since
 * @property {string} reason
 * @property {string} by
 */
/**
 * @typedef {object} CardUse
 * @property {boolean} busy
 * @property {number} percent
 * @property {string[]} by
 */
/**
 * @typedef {object} Games games.json: which cards a game is using, as last checked.
 * @property {string} checkedAt
 * @property {Record<string, CardUse>} cards
 */
/**
 * @typedef {object} GpuLoad What gpu-load.ps1 prints: the adapters, the counters' lines, the processes by pid, and the compositor's pid.
 * @property {DxgiAdapter[]} adapters
 * @property {string} counters
 * @property {Record<string, string>} processes
 * @property {number | null} compositor
 */
/**
 * @typedef {object} Need A request: its kind, its size (prompt and answer) and its lane.
 * @property {Work} work
 * @property {number} tokens
 * @property {Lane} lane
 */
/**
 * @typedef {object} Skipped
 * @property {Accelerator} acc
 * @property {'failed' | 'game' | 'deferred'} why
 * @property {string} detail
 */
/**
 * @typedef {object} Look An accelerator's line, as a request sees it: a slot free now, and how many are waiting ahead of it.
 * @property {boolean} freeSlot
 * @property {number} waiting
 */
/** @type {readonly Work[]} */
export declare const WORKS: readonly Work[];
/**
 * `prefix-leak`: each request starts with a nonce (GenieX v0.7.0). `image-path`: the server reads a local image path.
 * `sides-of-32`: a picture's side of a whole number of 32 px, on a picture the server doesn't shrink, is made a pixel
 * longer first (FastFlowLM 1.0.7 misreads it).
 */
export declare const QUIRKS: readonly string[];
/**
 * Whether it serves this kind of request.
 * @param {Accelerator} a
 * @param {Work} work
 * @returns {boolean}
 */
export declare function serves(a: Accelerator, work: Work): boolean;
/**
 * An accelerator's lock folders, one per slot: `npu` for the NPU (one slot, always), `<id>`, `<id>.2` …
 * for the others.
 * @param {{ id: string, slots?: number }} acc
 * @returns {string[]}
 */
export declare function lockFoldersOf(acc: {
    id: string;
    slots?: number;
}): string[];
/**
 * The accelerator whose turn a kind of request takes: its endpoint's `turn` when its server runs on another device
 * (the NPU 3720's embeddings, on the processor's graphics), else its own. Its slots are that accelerator's in `list`
 * when it's there, else one.
 * @param {Pick<Accelerator, 'id' | 'slots'> & Partial<Pick<Accelerator, Work>>} a
 * @param {Work} work
 * @param {ReadonlyArray<Pick<Accelerator, 'id' | 'slots'>>} [list]
 * @returns {{ id: string, slots: number }}
 */
export declare function turnOf(a: Pick<Accelerator, 'id' | 'slots'> & Partial<Pick<Accelerator, Work>>, work: Work, list?: ReadonlyArray<Pick<Accelerator, 'id' | 'slots'>>): {
    id: string;
    slots: number;
};
export type Written = {
    baseUrl?: string;
    model: string;
    startCommand?: string[];
    env?: Record<string, string>;
    maxContextTokens?: number;
    turn?: string;
    timeouts?: Timeouts;
    pictureTokens?: number;
};
/**
 * The cap for one kind of request on an accelerator: its endpoint's own (maxContextTokens on chat, vision or embed)
 * when it has one, else the accelerator's.
 * @param {Pick<Accelerator, 'maxContextTokens'> & Partial<Pick<Accelerator, Work>>} a
 * @param {Work} work
 * @returns {number}
 */
export declare function capFor(a: Pick<Accelerator, 'maxContextTokens'> & Partial<Pick<Accelerator, Work>>, work: Work): number;
/**
 * The timings for one kind of request on an accelerator (requestTimeoutMs): its endpoint's own over the accelerator's,
 * each one it gives; none when neither has any.
 * @param {Pick<Accelerator, 'timeouts'> & Partial<Pick<Accelerator, Work>>} a
 * @param {Work} work
 * @returns {Timeouts | undefined}
 */
export declare function timeoutsFor(a: Pick<Accelerator, 'timeouts'> & Partial<Pick<Accelerator, Work>>, work: Work): Timeouts | undefined;
export type Hardware = {
    npu: boolean;
    /**
     * Each named as DXGI describes it, " #2" on a second card
     * of a name: the name its id is made from (acceleratorId), (R) and (TM) left in.
     */
    cards: {
        name: string;
        memoryGb: number | null;
    }[];
    /**
     * The NPU's name as Windows lists it, (R) and (TM) taken out, when it has one.
     */
    npuName?: string;
    /**
     * The processor's name as Windows gives it, (R), (TM) and (C) taken out.
     */
    cpuName?: string;
};
/**
 * @typedef {object} Hardware What this PC has, as detection found it (hardware.json): whether it has an NPU at all,
 * and its graphics cards. Never inferred from a model or a server: any model can run on any of them.
 * @property {boolean} npu
 * @property {{ name: string, memoryGb: number | null }[]} cards Each named as DXGI describes it, " #2" on a second card
 * of a name: the name its id is made from (acceleratorId), (R) and (TM) left in.
 * @property {string} [npuName] The NPU's name as Windows lists it, (R) and (TM) taken out, when it has one.
 * @property {string} [cpuName] The processor's name as Windows gives it, (R), (TM) and (C) taken out.
 */
/**
 * An accelerator's name: what this PC calls the device, never what a config says (a config's `name` is ignored).
 * The NPU's is Windows' name for it, a card's DXGI's description (" #2" on a second card of a name), found by its
 * id, and the processor's its own, all from hardware.json, each with (R) and (TM) taken out and its spaces collapsed
 * (deviceName), as Manor shows them: "Qualcomm(R) Adreno(TM) X2-90 GPU" is "Qualcomm Adreno X2-90 GPU". Without one
 * (no hardware.json, a card it doesn't list, an NPU on a PC without one) it is the kind's: "NPU", "Graphics card",
 * "Processor" (LEGACY_NAMES). A card's id stays the one its DXGI name gives.
 * @param {AcceleratorKind} kind
 * @param {string} id
 * @param {Hardware | null | undefined} hw
 * @returns {string}
 */
export declare function acceleratorName(kind: AcceleratorKind, id: string, hw: Hardware | null | undefined): string;
/**
 * The device a model runs on when a config says the NPU, or says nothing, on a PC known to have none: its one
 * graphics card, the graphics card when it has several (which one isn't known), or the processor when it has none.
 * A card's name is as hardware.json keeps it, the one its id is made from (notTheNpu shows it by acceleratorName).
 * Null when the PC has an NPU, or isn't known: then the config's word stands.
 * @param {Hardware | null | undefined} hw
 * @returns {{ kind: AcceleratorKind, name: string, memoryGb: number | null } | null}
 */
export declare function instead(hw: Hardware | null | undefined): {
    kind: AcceleratorKind;
    name: string;
    memoryGb: number | null;
} | null;
/**
 * An entry listed as the NPU on a PC known to have none runs on what the PC has instead (instead()): its kind, its
 * id (the processor's is `cpu`) and its name (acceleratorName), whatever the entry carried. Null when the PC has an
 * NPU or isn't known, and for any other entry.
 * @param {Accelerator} a
 * @param {Hardware | null | undefined} hw
 * @returns {Accelerator | null}
 */
export declare function notTheNpu(a: Accelerator, hw: Hardware | null | undefined): Accelerator | null;
/**
 * Auto: the NPU first, since it does model work without the processor or a graphics card; then graphics
 * cards with `ownMemoryGb` (2 GB) or more of their own memory, the most memory first; then graphics that
 * share the PC's memory; then the CPU. Ties keep the given order.
 * @template {{ kind: AcceleratorKind, memoryGb: number | null }} A
 * @param {Rules} rules
 * @param {A[]} list
 * @returns {A[]}
 */
export declare function autoOrder<A extends {
    kind: AcceleratorKind;
    memoryGb: number | null;
}>(rules: Rules, list: A[]): A[];
/**
 * acceleratorOrder applied: the listed ids first, in its order, then any it leaves out, in auto order.
 * @template {{ id: string, kind: AcceleratorKind, memoryGb: number | null }} A
 * @param {Rules} rules
 * @param {A[]} list
 * @param {'auto' | string[]} order
 * @returns {A[]}
 */
export declare function ordered<A extends {
    id: string;
    kind: AcceleratorKind;
    memoryGb: number | null;
}>(rules: Rules, list: A[], order: 'auto' | string[]): A[];
/**
 * The kinds of work an enabled NPU in the list serves (chat, vision, embeddings): none on a PC without one.
 * @param {ReadonlyArray<{ kind: AcceleratorKind, enabled?: boolean, chat?: unknown, vision?: unknown, embed?: unknown }>} list
 * @returns {Work[]}
 */
export declare function npuServes(list: ReadonlyArray<{
    kind: AcceleratorKind;
    enabled?: boolean;
    chat?: unknown;
    vision?: unknown;
    embed?: unknown;
}>): Work[];
/**
 * Manor's "Use the graphics card for models when there's an NPU" (settings.json's `gpuWithNpu`) applied: when it's
 * false and the list has an NPU that serves something, a graphics card keeps only the work no enabled NPU here serves
 * (kit 2.69.0: the card on demand), so it is never a candidate for the NPU's own work, not even the fallback when the
 * NPU fails or is busy. On a PC whose NPU serves chat, vision and embeddings (a Snapdragon) every card is left out, as
 * before; on one whose NPU can't see (Intel's), the card keeps vision alone: its server is started by the first vision
 * request and stopped by the keeper once unused (gpuIdleStopMinutes). A card's reranker, an add-on, is left out with
 * the rest, as before: the NPU reranks where it can (a Snapdragon X2's, kit 2.100.0), else the processor. The processor stays. A card left with nothing is dropped; one
 * left with part of its work is a copy (a vision endpoint on its chat endpoint's server keeps that server). With the
 * switch true, or no NPU serving anything, the list is unchanged: on a PC without an NPU the switch means nothing.
 * @template {{ kind: AcceleratorKind, enabled?: boolean, chat?: unknown, vision?: unknown, embed?: unknown }} A
 * @param {A[]} list
 * @param {boolean} gpuWithNpu
 * @returns {A[]}
 */
export declare function withoutGpuBesideNpu<A extends {
    kind: AcceleratorKind;
    enabled?: boolean;
    chat?: unknown;
    vision?: unknown;
    embed?: unknown;
}>(list: A[], gpuWithNpu: boolean): A[];
/**
 * Of a graphics card's kinds, those it does beside an NPU that serves `npu`, with Manor's gpuWithNpu off: the routed
 * work (chat, vision, embeddings) no NPU serves. The one rule requests (withoutGpuBesideNpu), the keeper and setup
 * follow; a reranker is never among them.
 * @template {string} K
 * @param {readonly K[]} kinds
 * @param {readonly string[]} npu
 * @returns {K[]}
 */
export declare function cardWorkBesideNpu<K extends string>(kinds: readonly K[], npu: readonly string[]): K[];
/**
 * The accelerators in a parsed config.json, or why there are none: REEVE_NOT_SET_UP when nothing serves
 * anything, unless some entries couldn't be read (then the config needs fixing, and they're named).
 * On a PC known to have no NPU (`hw`, hardware.json), an entry said to be the NPU is read as what the PC has
 * instead (notTheNpu): a model is never called the NPU, or routed as one, on a PC without one.
 * @param {Rules} rules
 * @param {any} raw
 * @param {Hardware | null} [hw]
 * @returns {AcceleratorConfig | { error: string }}
 */
export declare function parseAccelerators(rules: Rules, raw: any, hw?: Hardware | null): AcceleratorConfig | {
    error: string;
};
/**
 * Reeve's config.json as read from its file: its text (null when there is none), checked. A file's
 * errors name the file; Reeve not set up reads the same whichever way.
 * @param {Rules} rules
 * @param {string} file The file's path, for messages.
 * @param {string | null} text
 * @param {Hardware | null} [hw] What this PC has (hardware.json), when known.
 * @returns {AcceleratorConfig | { error: string }}
 */
export declare function readConfig(rules: Rules, file: string, text: string | null, hw?: Hardware | null): AcceleratorConfig | {
    error: string;
};
/**
 * An ISO 8601 time with its zone ("2026-10-02T12:00:00.000Z", "…+02:00") in milliseconds since the Unix
 * epoch, or NaN for anything else: the shared files' times, read the same by every program.
 * @param {unknown} text
 * @returns {number}
 */
export declare function parseIsoMs(text: unknown): number;
/**
 * A time as the shared files write it: "2026-10-02T12:00:00.000Z".
 * @param {number} ms
 * @returns {string}
 */
export declare function isoTime(ms: number): string;
/**
 * A failure's reason as a marker keeps it: the first line, trimmed, at most reasonMaxChars ("it failed"
 * when there's nothing).
 * @param {Rules} rules
 * @param {unknown} text
 * @returns {string}
 */
export declare function oneLine(rules: Rules, text: unknown): string;
/**
 * A marker's contents (`<id>.failed.json`, its text or null when there is none) while it counts: until
 * failedForMs after its since (a marker exactly that old has expired). Null when it's absent,
 * unreadable (which counts the same) or expired.
 * @param {Rules} rules
 * @param {string | null} text
 * @param {number} nowMs
 * @returns {Failure | null}
 */
export declare function failureOf(rules: Rules, text: string | null, nowMs: number): Failure | null;
/**
 * A new marker: `{ since, reason, by }`, the reason one line.
 * @param {Rules} rules
 * @param {unknown} reason
 * @param {string} by
 * @param {number} nowMs
 * @returns {Failure}
 */
export declare function failureRecord(rules: Rules, reason: unknown, by: string, nowMs: number): Failure;
/**
 * When a marker stops counting, in milliseconds since the epoch (NaN when its since can't be read).
 * @param {Rules} rules
 * @param {Failure} f
 * @returns {number}
 */
export declare function failureUntil(rules: Rules, f: Failure): number;
/**
 * A shared file's text as every program writes it: JSON, two spaces, a newline at the end.
 * @param {unknown} value
 * @returns {string}
 */
export declare function sharedText(value: unknown): string;
/**
 * games.json's contents, or null when it's absent or unreadable (which count the same).
 * @param {string | null} text
 * @returns {Games | null}
 */
export declare function gamesOf(text: string | null): Games | null;
/**
 * Whether games.json needs checking again: none, older than gamesFreshMs, or from a clock that far ahead.
 * @param {Rules} rules
 * @param {Games | null} g
 * @param {number} nowMs
 * @returns {boolean}
 */
export declare function gamesStale(rules: Rules, g: Games | null, nowMs: number): boolean;
/**
 * What doesn't count as a game: the desktop's compositor, and the manor's own model servers (their
 * startCommands', and the usual ones).
 * @param {Accelerator[]} accs
 * @returns {string[]}
 */
export declare function serverNames(accs: Accelerator[]): string[];
/**
 * Which configured graphics cards a game is using, from one reading of the counters: per card (by its
 * LUID), each other program's busiest 3D engine; a card is busy while one is over gamePercent. The
 * desktop's compositor, the checking process (`self`) and the manor's own model servers don't count.
 * Cards are matched to accelerators by name (Heiward's), or by the id that name gives.
 * @param {Rules} rules
 * @param {GpuLoad} load
 * @param {Accelerator[]} accs
 * @param {{ self: number, exclude?: string[] }} opts
 * @returns {Record<string, CardUse>}
 */
export declare function gameCards(rules: Rules, load: GpuLoad, accs: Accelerator[], opts: {
    self: number;
    exclude?: string[];
}): Record<string, CardUse>;
/**
 * The candidates for a request, in order: they serve its kind, its size fits their cap, they haven't
 * failed in the last failedForMs (unless every one that would do has: then they all may, as a last
 * resort), a game isn't using them (background work only), and the agent isn't leaving them alone after
 * a line that was too long (`deferredMs`).
 *
 * **The NPU first:** when the first that would do, in order, is the NPU and it hasn't failed, it is the only
 * candidate (`npuFirst`). The NPU does model work without the processor or a graphics card, so they take it
 * only when the NPU can't: it doesn't serve the work, the request is too big for it, or it failed lately.
 * Busy, resting after a long line, or loading its model, it is waited for, never passed over. An
 * acceleratorOrder that puts something else first is the person's choice, and kept.
 * @param {Rules} rules
 * @param {Accelerator[]} accs
 * @param {Need} need
 * @param {{ failures?: Record<string, Failure | null>, games?: Games | null, deferredMs?: Record<string, number>, nowMs?: number }} [state]
 * @returns {{ list: Accelerator[], skipped: Skipped[], npuFirst: boolean }}
 */
export declare function candidates(rules: Rules, accs: Accelerator[], need: Need, state?: {
    failures?: Record<string, Failure | null>;
    games?: Games | null;
    deferredMs?: Record<string, number>;
    nowMs?: number;
}): {
    list: Accelerator[];
    skipped: Skipped[];
    npuFirst: boolean;
};
/**
 * The pick: the first candidate with a free slot and nobody waiting; else the one whose line is shortest,
 * ties by order. A background request that would be behind maxAhead or more in every line is deferred;
 * an interactive one always joins. A candidate `looks` doesn't describe counts as full and empty.
 * @param {Rules} rules
 * @param {Accelerator[]} list
 * @param {Lane} lane
 * @param {Record<string, Look>} looks By id.
 * @returns {{ acc: Accelerator } | { deferred: string }}
 */
export declare function pick(rules: Rules, list: Accelerator[], lane: Lane, looks: Record<string, Look>): {
    acc: Accelerator;
} | {
    deferred: string;
};
/**
 * Why no accelerator could take a request: `busy` (defer it, it isn't a fault) while any was only resting
 * or held by a game; an error when they all failed, or when the one tried first failed and none could
 * take it after.
 * @param {Skipped[]} skipped
 * @param {{ acc: AcceleratorRef, reason: string } | null} first The accelerator tried first, when it failed.
 * @returns {{ busy: boolean, message: string }}
 */
export declare function whyNone(skipped: Skipped[], first: {
    acc: AcceleratorRef;
    reason: string;
} | null): {
    busy: boolean;
    message: string;
};
/**
 * The pessimistic estimate every agent uses for its caps: one token per charsPerToken characters.
 * @param {Rules} rules
 * @param {string} text
 * @returns {number}
 */
export declare function estimateTokens(rules: Rules, text: string): number;
/**
 * A chat request's prompt, by the estimate: each message and a little for its role, and room for the
 * servers' quirks, whichever accelerator takes it.
 * @param {Rules} rules
 * @param {{ content: string }[]} messages
 * @returns {number}
 */
export declare function chatTokens(rules: Rules, messages: {
    content: string;
}[]): number;
/**
 * What a picture counts for on an accelerator: its vision endpoint's pictureTokens, the size the kit fits each picture
 * to there, else imageTokens.
 * @param {Rules} rules
 * @param {Partial<Pick<Accelerator, 'vision'>>} [a]
 * @returns {number}
 */
export declare function pictureTokensFor(rules: Rules, a?: Partial<Pick<Accelerator, 'vision'>>): number;
/**
 * A question about one image, by the estimate: the image counts pictureTokensFor `a`, imageTokens without one.
 * @param {Rules} rules
 * @param {string} question
 * @param {Partial<Pick<Accelerator, 'vision'>>} [a]
 * @returns {number}
 */
export declare function visionTokens(rules: Rules, question: string, a?: Partial<Pick<Accelerator, 'vision'>>): number;
/**
 * Why a request is refused before anything is sent: over every candidate's cap (null when one fits). With `work`,
 * each one's cap for that kind (capFor).
 * @param {(Pick<Accelerator, 'maxContextTokens'> & Partial<Pick<Accelerator, Work>>)[]} serving
 * @param {number} promptTokens
 * @param {number} maxTokens
 * @param {Work} [work]
 * @returns {string | null}
 */
export declare function tooBig(serving: (Pick<Accelerator, 'maxContextTokens'> & Partial<Pick<Accelerator, Work>>)[], promptTokens: number, maxTokens: number, work?: Work): string | null;
/**
 * How long one request may take, in ms. A background chat or vision request gets requestBaseMs plus
 * requestPerTokenMs for each token it may answer (GenieX on the NPU writes about 34 a second, so that is
 * some ten times what it needs), and never more than the config's requestTimeoutMs (`ceilingMs`). A
 * person waiting, and embeddings, get the config's. A request that may load its model on the way
 * (`coldLoad`: its server was just started, or was busy loading) gets coldLoadMs more, and its timeout
 * then is the model loading slowly, not the server failing. An accelerator's own `timeouts` (a slower NPU's), and its
 * endpoint's over those (timeoutsFor), take the rules' place, each one they give.
 * @param {Rules} rules
 * @param {{ lane: 'interactive' | 'background', work: Work, maxTokens: number, ceilingMs: number, coldLoad?: boolean, timeouts?: Timeouts }} r
 * @returns {number}
 */
export declare function requestTimeoutMs(rules: Rules, r: {
    lane: 'interactive' | 'background';
    work: Work;
    maxTokens: number;
    ceilingMs: number;
    coldLoad?: boolean;
    timeouts?: Timeouts;
}): number;
/**
 * Splits text into pieces whose estimated size fits `budgetTokens`, at line breaks where it can, so a long
 * input is asked about piece by piece (map-reduce) and never sent whole.
 * @param {Rules} rules
 * @param {string} text
 * @param {number} budgetTokens
 * @returns {string[]}
 */
export declare function pieces(rules: Rules, text: string, budgetTokens: number): string[];
/**
 * The answer sizes speeds are kept by, each its least tokens: a size runs up to the next one's, and the last has no end. A
 * server's decode speed counts its first token's wait too, so a short answer reads slower than a long one on the same boot,
 * and each size is compared only with itself. An answer under the first isn't kept: too few tokens to say.
 */
export declare const SPEED_SIZES: readonly number[];
export type SpeedRow = {
    /**
     * The accelerator's id.
     */
    acc: string;
    model: string;
    /**
     * The answers' size, its least tokens (SPEED_SIZES).
     */
    size: number;
    /**
     * Tokens a second as the server reported them, oldest first: the latest keptPerBoot.
     */
    tps: number[];
};
export type SpeedBoot = {
    /**
     * When the PC started (an ISO time).
     */
    boot: string;
    rows: SpeedRow[];
};
export type Speeds = {
    agent: string;
    boots: SpeedBoot[];
};
export type Speed = {
    /**
     * The accelerator's id.
     */
    acc: string;
    model: string;
    answerTokens: number;
    tokensPerSecond: number;
};
export type BootSpeed = {
    acc: string;
    model: string;
    /**
     * The answer size compared (SPEED_SIZES).
     */
    size: number;
    /**
     * When this boot started (an ISO time).
     */
    since: string;
    /**
     * This boot's median, in tokens a second, to a tenth.
     */
    now: number;
    /**
     * How many answers that's from.
     */
    samples: number;
    /**
     * The fastest earlier boot's median, to a tenth.
     */
    usual: number;
    /**
     * How many earlier boots had enough answers to count.
     */
    boots: number;
    /**
     * `now` as a percentage of `usual`, rounded.
     */
    percent: number;
    /**
     * `percent` is slowPercent or less.
     */
    slow: boolean;
};
/**
 * @typedef {object} SpeedRow One accelerator's speeds on one model, for answers of one size, in one boot.
 * @property {string} acc The accelerator's id.
 * @property {string} model
 * @property {number} size The answers' size, its least tokens (SPEED_SIZES).
 * @property {number[]} tps Tokens a second as the server reported them, oldest first: the latest keptPerBoot.
 */
/**
 * @typedef {object} SpeedBoot
 * @property {string} boot When the PC started (an ISO time).
 * @property {SpeedRow[]} rows
 */
/**
 * @typedef {object} Speeds One program's speeds (`speed\<program>.json`): the latest keptBoots boots, oldest first.
 * @property {string} agent
 * @property {SpeedBoot[]} boots
 */
/**
 * @typedef {object} Speed One answer's speed, as its server reported it.
 * @property {string} acc The accelerator's id.
 * @property {string} model
 * @property {number} answerTokens
 * @property {number} tokensPerSecond
 */
/**
 * @typedef {object} BootSpeed How this boot's speed on an accelerator compares with earlier boots'.
 * @property {string} acc
 * @property {string} model
 * @property {number} size The answer size compared (SPEED_SIZES).
 * @property {string} since When this boot started (an ISO time).
 * @property {number} now This boot's median, in tokens a second, to a tenth.
 * @property {number} samples How many answers that's from.
 * @property {number} usual The fastest earlier boot's median, to a tenth.
 * @property {number} boots How many earlier boots had enough answers to count.
 * @property {number} percent `now` as a percentage of `usual`, rounded.
 * @property {boolean} slow `percent` is slowPercent or less.
 */
/**
 * An answer's size (SPEED_SIZES), or null when it's too short to keep.
 * @param {number} answerTokens
 * @returns {number | null}
 */
export declare function speedSize(answerTokens: number): number | null;
/**
 * A speeds file's contents, or null when it's absent or unreadable (which count the same). A boot or row that can't be
 * read is left out, and so is a speed that isn't one.
 * @param {string | null} text
 * @returns {Speeds | null}
 */
export declare function speedsOf(text: string | null): Speeds | null;
/**
 * A program's speeds with one more answer's: in this boot's row for its accelerator, model and size, which keeps the
 * latest keptPerBoot, and the latest keptBoots boots. An answer too short to keep, or a speed that isn't one, leaves them
 * as they were. A boot within bootSlackMs of one already there is that boot.
 * @param {Rules} rules
 * @param {Speeds | null} file
 * @param {string} agent
 * @param {number} bootMs When this PC started, in milliseconds since the epoch.
 * @param {Speed} s
 * @returns {Speeds}
 */
export declare function addSpeed(rules: Rules, file: Speeds | null, agent: string, bootMs: number, s: Speed): Speeds;
/**
 * How this boot's speed on an accelerator compares with earlier boots', from every program's speeds together: for the
 * model and answer size with the most answers this boot, among those with samplesNeeded this boot and in at least one
 * earlier boot. The usual is the fastest earlier boot's median, so an earlier slow boot doesn't lower it. Null until
 * there's enough of both. A boot after this one (a clock set back) isn't an earlier one.
 * @param {Rules} rules
 * @param {(Speeds | null)[]} files
 * @param {number} bootMs When this PC started, in milliseconds since the epoch.
 * @param {string} acc The accelerator's id.
 * @returns {BootSpeed | null}
 */
export declare function bootSpeed(rules: Rules, files: (Speeds | null)[], bootMs: number, acc: string): BootSpeed | null;
