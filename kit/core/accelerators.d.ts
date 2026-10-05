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
};
export type Accelerator = {
    /**
     * `npu`, `cpu`, or `gpu-` and the card's name (acceleratorId).
     */
    id: string;
    kind: AcceleratorKind;
    /**
     * The device's own name: "Snapdragon X2 Elite NPU", "NVIDIA GeForce RTX 4090".
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
     * `prefix-leak`, `image-path` (QUIRKS).
     */
    quirks: string[];
    /**
     * false: kept in the list, sent nothing.
     */
    enabled?: boolean;
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
 */
/**
 * @typedef {object} Accelerator
 * @property {string} id `npu`, `cpu`, or `gpu-` and the card's name (acceleratorId).
 * @property {AcceleratorKind} kind
 * @property {string} name The device's own name: "Snapdragon X2 Elite NPU", "NVIDIA GeForce RTX 4090".
 * @property {number | null} memoryGb A graphics card's own memory, in GB; null when unknown. Under 2 GB, it shares the PC's.
 * @property {number} slots How many requests it serves at once (llama-server's --parallel). The NPU has 1.
 * @property {number} maxContextTokens The most a request may be, prompt and answer, by the kit's pessimistic estimate.
 * @property {Endpoint} [chat]
 * @property {Endpoint} [vision] A vision endpoint without a server of its own is on the chat endpoint's.
 * @property {Endpoint} [embed]
 * @property {string[]} quirks `prefix-leak`, `image-path` (QUIRKS).
 * @property {boolean} [enabled] false: kept in the list, sent nothing.
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
/** `prefix-leak`: each request starts with a nonce (GenieX v0.7.0). `image-path`: the server reads a local image path. */
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
export type Written = {
    baseUrl?: string;
    model: string;
    startCommand?: string[];
};
export type Hardware = {
    npu: boolean;
    cards: {
        name: string;
        memoryGb: number | null;
    }[];
};
/**
 * @typedef {object} Hardware What this PC has, as detection found it (hardware.json): whether it has an NPU at all,
 * and its graphics cards. Never inferred from a model or a server: any model can run on any of them.
 * @property {boolean} npu
 * @property {{ name: string, memoryGb: number | null }[]} cards
 */
/**
 * The device a model runs on when a config says the NPU, or says nothing, on a PC known to have none: its one
 * graphics card, the graphics card when it has several (which one isn't known), or the processor when it has none.
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
 * id and, when its name only said "NPU", its name. Null when the PC has an NPU or isn't known, and for any other entry.
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
 * Manor's "Use the graphics card for models when there's an NPU" (settings.json's `gpuWithNpu`) applied: when it's
 * false and the list has an NPU that serves something, every graphics card is left out, so none is ever a candidate,
 * not even the fallback when the NPU fails or is busy. The processor stays. With it true, or no NPU serving anything,
 * the list is unchanged: on a PC without an NPU the switch means nothing.
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
 * A question about one image, by the estimate: the image counts imageTokens.
 * @param {Rules} rules
 * @param {string} question
 * @returns {number}
 */
export declare function visionTokens(rules: Rules, question: string): number;
/**
 * Why a request is refused before anything is sent: over every candidate's cap (null when one fits).
 * @param {{ maxContextTokens: number }[]} serving
 * @param {number} promptTokens
 * @param {number} maxTokens
 * @returns {string | null}
 */
export declare function tooBig(serving: {
    maxContextTokens: number;
}[], promptTokens: number, maxTokens: number): string | null;
/**
 * How long one request may take, in ms. A background chat or vision request gets requestBaseMs plus
 * requestPerTokenMs for each token it may answer (GenieX on the NPU writes about 34 a second, so that is
 * some ten times what it needs), and never more than the config's requestTimeoutMs (`ceilingMs`). A
 * person waiting, and embeddings, get the config's. A request that may load its model on the way
 * (`coldLoad`: its server was just started, or was busy loading) gets coldLoadMs more, and its timeout
 * then is the model loading slowly, not the server failing.
 * @param {Rules} rules
 * @param {{ lane: 'interactive' | 'background', work: Work, maxTokens: number, ceilingMs: number, coldLoad?: boolean }} r
 * @returns {number}
 */
export declare function requestTimeoutMs(rules: Rules, r: {
    lane: 'interactive' | 'background';
    work: Work;
    maxTokens: number;
    ceilingMs: number;
    coldLoad?: boolean;
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
