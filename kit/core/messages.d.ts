// Made by kit/test/core-types.ts from messages.js's JSDoc: don't edit it, run npm run core-types.
import type { AcceleratorRef } from './ids.js';
/** @import { AcceleratorRef } from './ids.js' */
/** What an accelerator nobody recorded is called: never "the NPU", which a PC may not have. */
export declare const UNKNOWN_ACCELERATOR = "a local model";
/**
 * "the NPU", "the NVIDIA GeForce RTX 4090", "the graphics card": an accelerator in a sentence. A name that
 * starts with "the" is left as it is. None (a note kept from before accelerators, or one that didn't say) is
 * "a local model": it may have been a graphics card, so it is never guessed to be the NPU.
 * @param {AcceleratorRef | { name: string } | null | undefined} a
 * @returns {string}
 */
export declare function theAccelerator(a: AcceleratorRef | {
    name: string;
} | null | undefined): string;
/**
 * A note's label: "note from the NVIDIA GeForce RTX 4090, unverified".
 * @param {AcceleratorRef | { name: string } | null | undefined} a
 * @returns {string}
 */
export declare function noteLabel(a: AcceleratorRef | {
    name: string;
} | null | undefined): string;
/**
 * What an agent says when no model server is set up here: no accelerators' config.json, an empty list (setup
 * dropped the install's `npu` entry), or a list where nothing serves anything. The same words in each case. Since
 * kit 2.31.0 it points to Manor's own setup (Set up local AI), which every PC has, not to Reeve, which a household
 * may never hire. The old name stays for the agents that import it.
 */
export declare const NOT_SET_UP = "Local AI isn't set up on this PC yet: open Manor and choose Set up local AI";
export declare const REEVE_NOT_SET_UP = "Local AI isn't set up on this PC yet: open Manor and choose Set up local AI";
/**
 * What the lock's folder is called in a message: "the NPU" for the NPU's, else its name.
 * @param {string} folder The lock's first folder name (`npu`, `gpu-…`).
 * @returns {string}
 */
export declare function whatOf(folder: string): string;
/** The messages, by what they report. */
export declare const say: Readonly<{
    /** @param {number} ahead @param {string} what */
    queueFull: (ahead: number, what: string) => string;
    /** @param {number} waitMs @param {string} what @param {number} inLine */
    turnTimedOut: (waitMs: number, what: string, inLine: number) => string;
    /** @param {number} waitMs @param {string} what */
    lockTimedOut: (waitMs: number, what: string) => string;
    /** @param {string} what @param {number} ahead */
    waitingInLine: (what: string, ahead: number) => string;
    /** @param {string} what */
    takingOver: (what: string) => string;
    /** @param {string} what @param {string} detail */
    lockFailed: (what: string, detail: string) => string;
    /** @param {string} file @param {string} why */
    configUnreadable: (file: string, why: string) => string;
    /** @param {string} file @param {string} error */
    configError: (file: string, error: string) => string;
    /** @param {string[]} problems */
    nothingUsable: (problems: string[]) => string;
    noId: () => "has no id";
    /** @param {string} id */
    badId: (id: string) => string;
    /** @param {string} id */
    listedTwice: (id: string) => string;
    /** @param {string} id @param {string} instead */
    notTheNpu: (id: string, instead: string) => string;
    /** @param {AcceleratorRef} acc @param {string} reason @param {number} min */
    skippedFailed: (acc: AcceleratorRef, reason: string, min: number) => string;
    /** @param {AcceleratorRef} acc @param {string[]} by */
    skippedGame: (acc: AcceleratorRef, by: string[]) => string;
    /** @param {AcceleratorRef} acc @param {number} min */
    skippedDeferred: (acc: AcceleratorRef, min: number) => string;
    /** @param {AcceleratorRef} acc @param {number} waiting */
    lineFull: (acc: AcceleratorRef, waiting: number) => string;
    /** @param {{ acc: AcceleratorRef, waiting: number }[]} lines */
    everyLineFull: (lines: {
        acc: AcceleratorRef;
        waiting: number;
    }[]) => string;
    /** @param {AcceleratorRef} first @param {string} reason @param {string} why */
    failedNoOther: (first: AcceleratorRef, reason: string, why: string) => string;
    noneCould: () => "no accelerator could take the request";
    /** @param {string} id @param {string} work */
    notServing: (id: string, work: string) => string;
    /** @param {AcceleratorRef} acc */
    gpuSetAside: (acc: AcceleratorRef) => string;
    noVisionModel: () => "no vision model in the accelerators' config.json (an accelerator's \"vision\", or \"visionModel\" in an older config)";
    /** @param {string} work */
    noneServes: (work: string) => string;
    /** @param {number} promptTokens @param {number} maxTokens @param {number} cap @param {boolean} several */
    tooBig: (promptTokens: number, maxTokens: number, cap: number, several: boolean) => string;
    /** @param {AcceleratorRef[]} accs @param {string} also */
    serversNotRunning: (accs: AcceleratorRef[], also: string) => string;
    /** @param {string} why @param {number} min */
    modelWorkDeferred: (why: string, min: number) => string;
    /** @param {AcceleratorRef} first @param {string} firstReason @param {AcceleratorRef} next @param {string} nextReason */
    failedTwice: (first: AcceleratorRef, firstReason: string, next: AcceleratorRef, nextReason: string) => string;
    /** @param {AcceleratorRef} acc @param {string} reason */
    acceleratorFailed: (acc: AcceleratorRef, reason: string) => string;
    /** @param {AcceleratorRef} acc @param {string} message */
    onAccelerator: (acc: AcceleratorRef, message: string) => string;
    /** @param {string} where @param {number} min */
    restingFor: (where: string, min: number) => string;
    /** @param {number} min */
    deferredFor: (min: number) => string;
    /** @param {string} where @param {string} why @param {string} deferred */
    lineTooLong: (where: string, why: string, deferred: string) => string;
    /** @param {string} where @param {number} seconds @param {string} deferred */
    noTurnWithin: (where: string, seconds: number, deferred: string) => string;
    /** @param {string} baseUrl */
    serverNotRunning: (baseUrl: string) => string;
    /** @param {string} baseUrl */
    noStartCommand: (baseUrl: string) => string;
    /** @param {string} command @param {string} why */
    couldNotStart: (command: string, why: string) => string;
    /** @param {string} program @param {string} baseUrl @param {number} seconds */
    didNotAnswer: (program: string, baseUrl: string, seconds: number) => string;
    /** @param {string} program @param {number | null} code @param {string} baseUrl */
    exitedWhileStarting: (program: string, code: number | null, baseUrl: string) => string;
    /** @param {string} baseUrl @param {number} seconds */
    stillBusy: (baseUrl: string, seconds: number) => string;
    /** @param {string} route @param {string} baseUrl @param {number} seconds */
    modelLoadTimedOut: (route: string, baseUrl: string, seconds: number) => string;
    /** @param {string} where @param {string} why @param {string} deferred */
    modelLoading: (where: string, why: string, deferred: string) => string;
    /** @param {string} route @param {string} baseUrl @param {number} seconds */
    requestTimedOut: (route: string, baseUrl: string, seconds: number) => string;
    /** @param {string} route @param {string} baseUrl @param {string} why */
    connectionRefused: (route: string, baseUrl: string, why: string) => string;
    /** @param {string} route @param {string} baseUrl @param {number} status @param {string} text */
    serverFailed: (route: string, baseUrl: string, status: number, text: string) => string;
    /** @param {number} status @param {string} text */
    serverRefused: (status: number, text: string) => string;
    /** @param {string} text */
    notJson: (text: string) => string;
    tooFewVectors: () => "the embedding server returned too few vectors";
}>;
