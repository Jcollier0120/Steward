// Made by kit/test/core-types.ts from messages.js's JSDoc: don't edit it, run npm run core-types.
import type { AcceleratorRef } from './ids.js';
/** @import { AcceleratorRef } from './ids.js' */
/**
 * "the NPU", "the NVIDIA GeForce RTX 4090", "the graphics card": an accelerator in a sentence. A name that
 * starts with "the" is left as it is; none is the NPU (a note kept from before accelerators).
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
 * What an agent says when Reeve has set up no model server here: no config.json (Reeve writes none on a
 * PC without an NPU), an empty list (its setup dropped the install's `npu` entry), or a list where nothing
 * serves anything. The same words in each case.
 */
export declare const REEVE_NOT_SET_UP = "Reeve isn't set up here: open Reeve's page, Settings \u2192 Set up (or run `reeve accelerators setup`)";
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
    noVisionModel: () => "no vision model in Reeve's config.json (an accelerator's \"vision\", or \"visionModel\" in an older config)";
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
