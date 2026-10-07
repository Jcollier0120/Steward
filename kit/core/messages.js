// Every message the kit's rules give, worded once. Each is a clause with no full stop of its own: an
// agent puts it into its own sentence ("No notes: …." or "Busy: notes deferred to a later round (…)")
// and ends that as it needs.

import { LEGACY_NAMES } from './ids.js';

/** @import { AcceleratorRef } from './ids.js' */

/** What an accelerator nobody recorded is called: never "the NPU", which a PC may not have. */
export const UNKNOWN_ACCELERATOR = 'a local model';

/**
 * "the NPU", "the NVIDIA GeForce RTX 4090", "the graphics card": an accelerator in a sentence. A name that
 * starts with "the" is left as it is. None (a note kept from before accelerators, or one that didn't say) is
 * "a local model": it may have been a graphics card, so it is never guessed to be the NPU.
 * @param {AcceleratorRef | { name: string } | null | undefined} a
 * @returns {string}
 */
export function theAccelerator(a) {
  if (!a || !a.name) return UNKNOWN_ACCELERATOR;
  const name = a.name;
  if (/^(the|a|an)\s/i.test(name)) return name;
  return `the ${name === LEGACY_NAMES.gpu || name === LEGACY_NAMES.cpu ? name.toLowerCase() : name}`;
}

/**
 * A note's label: "note from the NVIDIA GeForce RTX 4090, unverified".
 * @param {AcceleratorRef | { name: string } | null | undefined} a
 * @returns {string}
 */
export function noteLabel(a) {
  return `note from ${theAccelerator(a)}, unverified`;
}

/**
 * What an agent says when no model server is set up here: no accelerators' config.json, an empty list (setup
 * dropped the install's `npu` entry), or a list where nothing serves anything. The same words in each case. Since
 * kit 2.31.0 it points to the app's own setup (Set up local AI), which every PC has, not to Reeve, which a household
 * may never hire; since 2.32.1 it names the app as the person bought it, Castellan. The old name stays for the agents that import it.
 */
export const NOT_SET_UP = "Local AI isn't set up on this PC yet: open Castellan and choose Set up local AI";
export const REEVE_NOT_SET_UP = NOT_SET_UP;

/**
 * What the lock's folder is called in a message: "the NPU" for the NPU's, else its name.
 * @param {string} folder The lock's first folder name (`npu`, `gpu-…`).
 * @returns {string}
 */
export function whatOf(folder) {
  return folder === 'npu' ? 'the NPU' : folder;
}

/** The messages, by what they report. */
export const say = Object.freeze({
  // ------------------------------------------------------------ the lock and the line
  /** @param {number} ahead @param {string} what */
  queueFull: (ahead, what) => `${ahead} already waiting for ${what}`,
  /** @param {number} waitMs @param {string} what @param {number} inLine */
  turnTimedOut: (waitMs, what, inLine) => `timed out after ${waitMs} ms waiting for ${what} (${inLine} in line)`,
  /** @param {number} waitMs @param {string} what */
  lockTimedOut: (waitMs, what) => `timed out after ${waitMs} ms waiting for ${what}`,
  /** @param {string} what @param {number} ahead */
  waitingInLine: (what, ahead) => `waiting for ${what}: ${ahead} ahead in line`,
  /** @param {string} what */
  takingOver: (what) => `${what} was held by a process that died or overstayed: taking it over`,
  /** @param {string} what @param {string} detail */
  lockFailed: (what, detail) => `couldn't take turns on ${what}: ${detail}`,

  // ------------------------------------------------------------ Reeve's config
  /** @param {string} file @param {string} why */
  configUnreadable: (file, why) => `${file} couldn't be read: ${why}`,
  /** @param {string} file @param {string} error */
  configError: (file, error) => `${file} ${error}`,
  /** @param {string[]} problems */
  nothingUsable: (problems) => `lists no accelerator that can be used (${problems.join('; ')})`,
  noId: () => 'has no id',
  /** @param {string} id */
  badId: (id) => `${id}: an id is npu, cpu, or gpu- and the card's name in lowercase with dashes`,
  /** @param {string} id */
  listedTwice: (id) => `${id} is listed twice; the first is used`,
  /** @param {string} id @param {string} instead */
  notTheNpu: (id, instead) => `${id} is listed as the NPU, but this PC has none: its model runs on ${theAccelerator({ name: instead })}`,

  // ------------------------------------------------------------ choosing
  /** @param {AcceleratorRef} acc @param {string} reason @param {number} min */
  skippedFailed: (acc, reason, min) => `${theAccelerator(acc)} failed (${reason}); it is tried again in ${min} min`,
  /** @param {AcceleratorRef} acc @param {string[]} by */
  skippedGame: (acc, by) => `${theAccelerator(acc)} is in use by ${by.join(', ') || 'a game'}`,
  /** @param {AcceleratorRef} acc @param {number} min */
  skippedDeferred: (acc, min) => `work on ${theAccelerator(acc)} resumes in ${min} min`,
  /** @param {AcceleratorRef} acc @param {number} waiting */
  lineFull: (acc, waiting) => `${waiting} already waiting for ${theAccelerator(acc)}`,
  /** @param {{ acc: AcceleratorRef, waiting: number }[]} lines */
  everyLineFull: (lines) => `every line is full (${lines.map((l) => `${l.waiting} waiting for ${theAccelerator(l.acc)}`).join(', ')})`,
  /** @param {AcceleratorRef} first @param {string} reason @param {string} why */
  failedNoOther: (first, reason, why) => `${theAccelerator(first)} failed (${reason}), and no other accelerator could take the request${why ? `: ${why}` : ''}`,
  noneCould: () => 'no accelerator could take the request',
  /** @param {string} id @param {string} work */
  notServing: (id, work) => `${id} isn't in the accelerators' config, or doesn't serve ${work}`,
  /** @param {AcceleratorRef} acc */
  gpuSetAside: (acc) => `${theAccelerator(acc)} isn't used for models beside the NPU (Castellan's Settings: "Use the graphics card for models when there's an NPU" is off)`,
  noVisionModel: () => 'no vision model in the accelerators\' config.json (an accelerator\'s "vision", or "visionModel" in an older config)',
  /** @param {string} work */
  noneServes: (work) => `no accelerator in the accelerators' config.json serves ${work}`,
  /** @param {number} promptTokens @param {number} maxTokens @param {number} cap @param {boolean} several */
  tooBig: (promptTokens, maxTokens, cap, several) => `refusing a request of ~${promptTokens}+${maxTokens} tokens (${several ? 'the largest cap is' : 'cap'} ${cap}); split the input`,
  /** @param {AcceleratorRef[]} accs @param {string} also */
  serversNotRunning: (accs, also) => `${accs.map((a) => `${theAccelerator(a)}'s server`).join(' and ')} isn't running${also ? `; ${also}` : ''}`,
  /** @param {string} why @param {number} min */
  modelWorkDeferred: (why, min) => `${why}; model work deferred for ${min} min`,
  /** @param {AcceleratorRef} first @param {string} firstReason @param {AcceleratorRef} next @param {string} nextReason */
  failedTwice: (first, firstReason, next, nextReason) => `${theAccelerator(first)} failed (${firstReason}), and then ${theAccelerator(next)} (${nextReason})`,
  /** @param {AcceleratorRef} acc @param {string} reason */
  acceleratorFailed: (acc, reason) => `${theAccelerator(acc)} failed: ${reason}`,
  /** @param {AcceleratorRef} acc @param {string} message */
  onAccelerator: (acc, message) => `${theAccelerator(acc)}: ${message}`,

  // ------------------------------------------------------------ an agent's manners
  /** @param {string} where @param {number} min */
  restingFor: (where, min) => `${where} was busy; work on it resumes in ${min} min`,
  /** @param {number} min */
  deferredFor: (min) => `; work on it deferred for ${min} min`,
  /** @param {string} where @param {string} why @param {string} deferred */
  lineTooLong: (where, why, deferred) => `${where} is busy (${why})${deferred}`,
  /** @param {string} where @param {number} seconds @param {string} deferred */
  noTurnWithin: (where, seconds, deferred) => `no turn on ${where} within ${seconds} s${deferred}`,

  // ------------------------------------------------------------ model servers
  /** @param {string} baseUrl */
  serverNotRunning: (baseUrl) => `${baseUrl} isn't running`,
  /** @param {string} baseUrl */
  noStartCommand: (baseUrl) => `its server ${baseUrl} isn't running, and the accelerators' config has no startCommand for it`,
  /** @param {string} command @param {string} why */
  couldNotStart: (command, why) => `couldn't start "${command}": ${why}`,
  /** @param {string} program @param {string} baseUrl @param {number} seconds */
  didNotAnswer: (program, baseUrl, seconds) => `started "${program}" but ${baseUrl} didn't answer within ${seconds} s`,
  /** @param {string} program @param {number | null} code @param {string} baseUrl */
  exitedWhileStarting: (program, code, baseUrl) => `started "${program}", but it exited (code ${code}) and ${baseUrl} isn't answering`,
  /** @param {string} baseUrl @param {number} seconds */
  stillBusy: (baseUrl, seconds) => `${baseUrl} took the connection but was still busy (loading a model, or answering another request) after ${seconds} s`,
  /** @param {string} route @param {string} baseUrl @param {number} seconds */
  modelLoadTimedOut: (route, baseUrl, seconds) => `${route} on ${baseUrl} timed out after ${seconds} s while its model loaded`,
  /** @param {string} where @param {string} why @param {string} deferred */
  modelLoading: (where, why, deferred) => `${where} was still loading its model (${why}); not counted as a failure${deferred}`,
  /** @param {string} route @param {string} baseUrl @param {number} seconds */
  requestTimedOut: (route, baseUrl, seconds) => `${route} on ${baseUrl} timed out after ${seconds} s`,
  /** @param {string} route @param {string} baseUrl @param {string} why */
  connectionRefused: (route, baseUrl, why) => `${route} on ${baseUrl} refused the connection (${why})`,
  /** @param {string} route @param {string} baseUrl @param {number} status @param {string} text */
  serverFailed: (route, baseUrl, status, text) => `${route} on ${baseUrl} failed (${status}): ${text}`,
  /** @param {number} status @param {string} text */
  serverRefused: (status, text) => `the model server said ${status}: ${text}`,
  /** @param {string} text */
  notJson: (text) => `the model server's answer wasn't JSON: ${text}`,
  tooFewVectors: () => 'the embedding server returned too few vectors',
});
