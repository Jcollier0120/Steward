// The accelerators' rules (ACCELERATORS.md): reading and checking Reeve's config, the auto order, the
// failure markers, the game check, the candidates for a request and the pick among them, and the size
// of a request. Pure: a driver reads the files and asks the counters, and hands their contents in.

import { acceleratorId, deviceName, keyedCards, kindOfId, LEGACY_NAMES } from './ids.js';
import { REEVE_NOT_SET_UP, say } from './messages.js';
import { slotNames } from './queue.js';

/** @import { Rules } from './rules.js' */
/** @import { AcceleratorKind } from './ids.js' */
/** @import { AcceleratorRef } from './ids.js' */
/** @import { DxgiAdapter } from './ids.js' */
/** @import { Lane } from './queue.js' */

/** @typedef {'chat' | 'vision' | 'embed'} Work */

/**
 * @typedef {Work | 'rerank'} OrderedWork The work the PC's work order may order: the routed work, and a reranker (kit
 * 2.135.5: Intel's, on the graphics card first).
 */

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
 * @typedef {object} WorkOrderOf One kind of work's order on this PC, from its NPU's generation (setup writes it from
 * npu-vendors.json's `order`, kit 2.111.0).
 * @property {AcceleratorKind[]} devices The kinds of device, first preferred; any it leaves out follow, in the auto order.
 * @property {boolean} [runningFirst] A device whose server is running goes before one whose server isn't, the order kept
 * otherwise. No generation's order has it since kit 2.135.1: until then, on AMD's Ryzen AI 300, a picture went to the
 * Radeon unless only FastFlowLM was up.
 * @property {number} [batchAt] With runningFirst: from this many of the work waiting (`waiting`, this request included),
 * the order is kept whoever's server is up, so a batch starts the first device's server (AMD's pictures had 4 until kit
 * 2.135.1).
 */

/** @typedef {Partial<Record<OrderedWork, WorkOrderOf>>} WorkOrder */

/**
 * @typedef {object} AcceleratorConfig
 * @property {Accelerator[]} accelerators In the order requests try them: acceleratorOrder's, or auto's.
 * @property {'auto' | string[]} order
 * @property {WorkOrder} [workOrder] The config's `workOrder` (and `rerankOrder`: workOrderIn), each work's own order over
 * the auto order: only with acceleratorOrder "auto" (a person's list is kept).
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
 * @typedef {object} NpuCall npu-call.json: a call being captioned on the NPU (Envoy's), which the staff's background
 *   work leaves the NPU to while it lasts (kit 2.143.1). Written again every 20 s while the call lasts, removed when it ends.
 * @property {string} by The agent captioning it ("envoy").
 * @property {number} pid Its process.
 * @property {string} since When the call began.
 * @property {string} at When the file was last written.
 * @property {boolean} translating Whether it asks the NPU's chat model during the call (Envoy's translations). While it
 *   doesn't, the keeper stops the NPU's servers once nobody has used them for callGraceMs.
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
 * @property {'failed' | 'game' | 'call' | 'deferred'} why
 * @property {string} detail
 */

/**
 * @typedef {object} Look An accelerator's line, as a request sees it: a slot free now, and how many are waiting ahead of it.
 * @property {boolean} freeSlot
 * @property {number} waiting
 */

/** @type {readonly Work[]} */
export const WORKS = Object.freeze(['chat', 'vision', 'embed']);

/**
 * The work a work order may order (OrderedWork): the routed work, then a reranker (kit 2.135.5). config.json keeps a
 * reranker's order apart, in `rerankOrder` (workOrderIn), so a kit before, whose check refuses any work but the
 * routed work's in `workOrder`, reads config.json as it did and leaves it out.
 * @type {readonly OrderedWork[]}
 */
export const ORDERED_WORKS = Object.freeze([...WORKS, 'rerank']);

/**
 * `prefix-leak`: each request starts with a nonce (GenieX v0.7.0). `image-path`: the server reads a local image path.
 * `sides-of-32`: a picture's side of a whole number of 32 px, on a picture the server doesn't shrink, is made a pixel
 * longer first (FastFlowLM 1.0.7 and 1.0.10 misread it).
 */
export const QUIRKS = Object.freeze(['prefix-leak', 'image-path', 'sides-of-32']);

/**
 * Whether it serves this kind of request.
 * @param {Accelerator} a
 * @param {Work} work
 * @returns {boolean}
 */
export function serves(a, work) {
  return a.enabled !== false && !!a[work];
}

/**
 * An accelerator's lock folders, one per slot: `npu` for the NPU (one slot, always), `<id>`, `<id>.2` …
 * for the others.
 * @param {{ id: string, slots?: number }} acc
 * @returns {string[]}
 */
export function lockFoldersOf(acc) {
  return slotNames(acc.id, acc.id === 'npu' ? 1 : (acc.slots ?? 1));
}

/**
 * The accelerator whose turn a kind of request takes: its endpoint's `turn` when its server runs on another device
 * (the NPU 3720's embeddings, on the processor's graphics), else its own. Its slots are that accelerator's in `list`
 * when it's there, else one.
 * @param {Pick<Accelerator, 'id' | 'slots'> & Partial<Pick<Accelerator, Work>>} a
 * @param {Work} work
 * @param {ReadonlyArray<Pick<Accelerator, 'id' | 'slots'>>} [list]
 * @returns {{ id: string, slots: number }}
 */
export function turnOf(a, work, list = []) {
  const id = a[work]?.turn;
  if (!id || id === a.id) return { id: a.id, slots: a.slots };
  return { id, slots: list.find((x) => x.id === id)?.slots ?? 1 };
}

// ---------------------------------------------------------------- Reeve's config

/** @param {unknown} u */
const baseUrlOf = (u) => String(u).replace(/\/(v1\/?)?$/, '');
/** @param {unknown} v */
const positiveInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** @typedef {{ baseUrl?: string, model: string, startCommand?: string[], env?: Record<string, string>, maxContextTokens?: number, turn?: string, timeouts?: Timeouts, pictureTokens?: number }} Written */

/**
 * A server's own environment as written: names to strings, anything else left out.
 * @param {any} v
 * @returns {Record<string, string> | undefined}
 */
function readEnv(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof x === 'string') out[k] = x;
  return Object.keys(out).length ? out : undefined;
}

/**
 * One served kind as written; a vision endpoint may leave out its server (it's the chat endpoint's).
 * @param {any} v
 * @returns {Written | undefined}
 */
function readEndpoint(v) {
  if (!v || typeof v !== 'object' || typeof v.model !== 'string' || !v.model) return undefined;
  return {
    model: v.model,
    ...(typeof v.baseUrl === 'string' && v.baseUrl ? { baseUrl: baseUrlOf(v.baseUrl) } : {}),
    ...(Array.isArray(v.startCommand) ? { startCommand: v.startCommand.map(String) } : {}),
    ...(readEnv(v.env) ? { env: readEnv(v.env) } : {}),
    ...(positiveInt(v.maxContextTokens) ? { maxContextTokens: v.maxContextTokens } : {}),
    // Another device's turn: a graphics card's or the processor's, never the NPU's (an NPU's own servers are in its turn).
    ...(kindOfId(v.turn) && v.turn !== 'npu' ? { turn: v.turn } : {}),
    ...(readTimeouts(v.timeouts) ? { timeouts: readTimeouts(v.timeouts) } : {}),
    ...(positiveInt(v.pictureTokens) ? { pictureTokens: v.pictureTokens } : {}),
  };
}

/**
 * An accelerator's (or one of its kinds') own timings as written: each a whole number of ms, the others left to the rules.
 * @param {any} v
 * @returns {Timeouts | undefined}
 */
function readTimeouts(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of ['requestBaseMs', 'requestPerTokenMs', 'coldLoadMs']) {
    const n = v[k];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * One work's order as written: its devices (npu, gpu, cpu, each at most once), its runningFirst, and its batchAt (a
 * whole number, 2 or more; otherwise left out). Written otherwise, there is none.
 * @param {any} o
 * @returns {WorkOrderOf | undefined}
 */
function readOrderOf(o) {
  const devices = o && typeof o === 'object' && Array.isArray(o.devices) ? o.devices : null;
  if (!devices?.length || devices.some((/** @type {unknown} */ d) => d !== 'npu' && d !== 'gpu' && d !== 'cpu') || new Set(devices).size !== devices.length) return undefined;
  return { devices: [...devices], ...(o.runningFirst === true ? { runningFirst: true } : {}), ...(Number.isInteger(o.batchAt) && o.batchAt >= 2 ? { batchAt: o.batchAt } : {}) };
}

/**
 * config.json's `workOrder` as written: each work's devices (npu, gpu, cpu, each at most once), its runningFirst, and its
 * batchAt (a whole number, 2 or more; otherwise left out). A work written otherwise is left out, and with none left, there
 * is none.
 * @param {any} v
 * @returns {WorkOrder | undefined}
 */
export function readWorkOrder(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  /** @type {WorkOrder} */
  const out = {};
  for (const w of WORKS) {
    const o = readOrderOf(v[w]);
    if (o) out[w] = o;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * config.json's `workOrder` as the core reads it (parseAccelerators): only with `acceleratorOrder` "auto" (or none), so
 * a person's own list of accelerators is kept for every work. With a reranker's, config.json's `rerankOrder` (kit
 * 2.135.5, written as one work's order is), as its `rerank`: kept out of `workOrder` so a kit before reads config.json
 * as it did (ORDERED_WORKS).
 * @param {any} raw config.json, parsed.
 * @returns {WorkOrder | undefined}
 */
export function workOrderIn(raw) {
  if (Array.isArray(raw?.acceleratorOrder)) return undefined;
  const order = readWorkOrder(raw?.workOrder);
  const rerank = readOrderOf(raw?.rerankOrder);
  return rerank ? { ...order, rerank } : order;
}

/**
 * The accelerators in one work's order (`workOrder`'s): the kinds it names first, in its order, the rest after it as
 * given (the auto order); with runningFirst, those whose server `running` says is up before those whose isn't, that order
 * kept otherwise, unless as many of the work wait as its batchAt: then the order is kept as it is. No order for the work:
 * as given.
 * @template {{ id: string, kind: AcceleratorKind }} A
 * @param {A[]} list
 * @param {WorkOrderOf | undefined} order
 * @param {Record<string, boolean>} [running] By id.
 * @param {number} [waiting] How many of the work wait, this request included.
 * @returns {A[]}
 */
export function workOrdered(list, order, running, waiting) {
  if (!order) return list;
  /** @param {A} a */
  const rank = (a) => {
    const i = order.devices.indexOf(a.kind);
    return i < 0 ? order.devices.length : i;
  };
  const byKind = list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a);
  if (!order.runningFirst || !running || isBatch(order, waiting)) return byKind;
  return [...byKind.filter((a) => running[a.id]), ...byKind.filter((a) => !running[a.id])];
}

/**
 * Whether as many of the work wait as its order's batchAt: a batch, which keeps the order whoever's server is up
 * (kit 2.112.1; Reeve's routing reads it too).
 * @param {WorkOrderOf | undefined} order
 * @param {number} [waiting]
 * @returns {boolean}
 */
export function isBatch(order, waiting) {
  return order?.batchAt !== undefined && (waiting ?? 0) >= order.batchAt;
}

/**
 * The cap for one kind of request on an accelerator: its endpoint's own (maxContextTokens on chat, vision or embed)
 * when it has one, else the accelerator's.
 * @param {Pick<Accelerator, 'maxContextTokens'> & Partial<Pick<Accelerator, Work>>} a
 * @param {Work} work
 * @returns {number}
 */
export function capFor(a, work) {
  return a[work]?.maxContextTokens ?? a.maxContextTokens;
}

/**
 * The timings for one kind of request on an accelerator (requestTimeoutMs): its endpoint's own over the accelerator's,
 * each one it gives; none when neither has any.
 * @param {Pick<Accelerator, 'timeouts'> & Partial<Pick<Accelerator, Work>>} a
 * @param {Work} work
 * @returns {Timeouts | undefined}
 */
export function timeoutsFor(a, work) {
  const own = a[work]?.timeouts;
  return own ? { ...a.timeouts, ...own } : a.timeouts;
}

/**
 * Each kind's endpoint with its server: vision without one of its own on the chat endpoint's.
 * @param {Omit<Accelerator, Work>} a
 * @param {Partial<Record<Work, Written | undefined>>} eps
 * @returns {Accelerator}
 */
function withServers(a, eps) {
  /** @type {Accelerator} */
  const out = { ...a };
  for (const w of WORKS) {
    const ep = eps[w];
    if (!ep) continue;
    // Its cap, timings and picture size are its own, on whichever server.
    const own = { ...(ep.maxContextTokens ? { maxContextTokens: ep.maxContextTokens } : {}), ...(ep.timeouts ? { timeouts: ep.timeouts } : {}), ...(ep.pictureTokens ? { pictureTokens: ep.pictureTokens } : {}) };
    if (ep.baseUrl) out[w] = { baseUrl: ep.baseUrl, model: ep.model, ...(ep.startCommand ? { startCommand: ep.startCommand } : {}), ...(ep.env ? { env: ep.env } : {}), ...own, ...(ep.turn ? { turn: ep.turn } : {}) };
    // On the chat endpoint's server, it takes that server's turn.
    else if (w === 'vision' && eps.chat?.baseUrl)
      out[w] = { baseUrl: eps.chat.baseUrl, model: ep.model, ...(eps.chat.startCommand ? { startCommand: eps.chat.startCommand } : {}), ...(eps.chat.env ? { env: eps.chat.env } : {}), ...own, ...(eps.chat.turn ? { turn: eps.chat.turn } : {}) };
  }
  return out;
}

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
export function acceleratorName(kind, id, hw) {
  const known = kind === 'npu' ? (hw?.npu ? hw.npuName : undefined) : kind === 'cpu' ? hw?.cpuName : hw?.cards.find((c) => acceleratorId('gpu', c.name) === id)?.name;
  const name = typeof known === 'string' ? deviceName(known) : '';
  return name || LEGACY_NAMES[kind];
}

/**
 * The device a model runs on when a config says the NPU, or says nothing, on a PC known to have none: its one
 * graphics card, the graphics card when it has several (which one isn't known), or the processor when it has none.
 * A card's name is as hardware.json keeps it, the one its id is made from (notTheNpu shows it by acceleratorName).
 * Null when the PC has an NPU, or isn't known: then the config's word stands.
 * @param {Hardware | null | undefined} hw
 * @returns {{ kind: AcceleratorKind, name: string, memoryGb: number | null } | null}
 */
export function instead(hw) {
  if (!hw || hw.npu) return null;
  if (!hw.cards.length) return { kind: 'cpu', name: acceleratorName('cpu', 'cpu', hw), memoryGb: null };
  const card = hw.cards.length === 1 ? hw.cards[0] : null;
  return { kind: 'gpu', name: card?.name ?? LEGACY_NAMES.gpu, memoryGb: card?.memoryGb ?? null };
}

/**
 * An entry listed as the NPU on a PC known to have none runs on what the PC has instead (instead()): its kind, its
 * id (the processor's is `cpu`) and its name (acceleratorName), whatever the entry carried. Null when the PC has an
 * NPU or isn't known, and for any other entry.
 * @param {Accelerator} a
 * @param {Hardware | null | undefined} hw
 * @returns {Accelerator | null}
 */
export function notTheNpu(a, hw) {
  const other = a.kind === 'npu' ? instead(hw) : null;
  if (!other) return null;
  const id = acceleratorId(other.kind, other.name);
  return { ...a, kind: other.kind, id, name: acceleratorName(other.kind, id, hw), memoryGb: a.memoryGb ?? other.memoryGb };
}

/**
 * One entry of `accelerators`, as Reeve reads it: its kind from its id, its name from this PC (a `name` written in
 * the entry is ignored), one slot, the NPU's cap, known quirks only.
 * @param {Rules} rules
 * @param {any} v
 * @param {Hardware | null | undefined} hw
 * @returns {Accelerator | { error: string }}
 */
function readOne(rules, v, hw) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string') return { error: say.noId() };
  const kind = kindOfId(v.id);
  if (!kind) return { error: say.badId(v.id) };
  return withServers(
    {
      id: v.id,
      kind,
      name: acceleratorName(kind, v.id, hw),
      memoryGb: typeof v.memoryGb === 'number' && v.memoryGb >= 0 ? v.memoryGb : null,
      slots: kind === 'npu' ? 1 : Math.min(rules.accelerators.maxSlots, positiveInt(v.slots) ?? 1),
      maxContextTokens: positiveInt(v.maxContextTokens) ?? rules.accelerators.defaultMaxContextTokens,
      quirks: Array.isArray(v.quirks) ? v.quirks.filter((/** @type {unknown} */ q) => typeof q === 'string' && QUIRKS.includes(q)) : [],
      ...(v.enabled === false ? { enabled: false } : {}),
      ...(readTimeouts(v.timeouts) ? { timeouts: readTimeouts(v.timeouts) } : {}),
    },
    { chat: readEndpoint(v.chat), vision: readEndpoint(v.vision), embed: readEndpoint(v.embed) },
  );
}

/**
 * An older config (chatEndpoint, visionModel, embedEndpoint, npuMaxContextTokens) as accelerators, as
 * Reeve reads it: one per device, `npu` when the device is the NPU. The chat endpoint keeps the cap and
 * both GenieX quirks it always had; an embed endpoint on another device is an accelerator of its own. Each is named
 * from this PC, as a listed one is.
 * @param {Rules} rules
 * @param {any} raw
 * @param {Hardware | null | undefined} hw
 * @returns {Accelerator[]}
 */
function fromLegacy(rules, raw, hw) {
  const cap = positiveInt(raw?.npuMaxContextTokens) ?? rules.accelerators.defaultMaxContextTokens;
  /** @type {{ a: Omit<Accelerator, Work>, eps: Partial<Record<Work, Written | undefined>> }[]} */
  const found = [];
  /** @param {unknown} device */
  const forDevice = (device) => {
    const d = String(device ?? 'Npu').toLowerCase();
    /** @type {AcceleratorKind} */
    const kind = d === 'gpu' ? 'gpu' : d === 'cpu' ? 'cpu' : 'npu';
    let f = found.find((x) => x.a.kind === kind);
    if (!f) {
      const id = acceleratorId(kind, LEGACY_NAMES[kind]);
      f = { a: { id, kind, name: acceleratorName(kind, id, hw), memoryGb: null, slots: 1, maxContextTokens: cap, quirks: [] }, eps: {} };
      found.push(f);
    }
    return f;
  };
  const chat = raw?.chatEndpoint;
  if (chat && typeof chat === 'object' && chat.baseUrl && chat.model) {
    const f = forDevice(chat.device);
    f.eps.chat = readEndpoint(chat);
    // The kit sent every request with a nonce and every image as a local path.
    f.a.quirks = ['prefix-leak', 'image-path'];
    if (typeof raw.visionModel === 'string' && raw.visionModel) f.eps.vision = { model: raw.visionModel };
  }
  const embed = raw?.embedEndpoint;
  if (embed && typeof embed === 'object' && embed.baseUrl && embed.model) {
    const f = forDevice(embed.device);
    // `start: false` meant never start one; an empty command says the same.
    const start = embed.start === false ? [] : (embed.startCommand ?? embed.start);
    f.eps.embed = readEndpoint({ baseUrl: embed.baseUrl, model: embed.model, ...(Array.isArray(start) ? { startCommand: start } : {}) });
  }
  return found.map((f) => withServers(f.a, f.eps));
}

/**
 * Auto: the NPU first, since it does model work without the processor or a graphics card; then graphics
 * cards with `ownMemoryGb` (2 GB) or more of their own memory, the most memory first; then graphics that
 * share the PC's memory; then the CPU. Ties keep the given order.
 * @template {{ kind: AcceleratorKind, memoryGb: number | null }} A
 * @param {Rules} rules
 * @param {A[]} list
 * @returns {A[]}
 */
export function autoOrder(rules, list) {
  /** @param {A} a */
  const rank = (a) => (a.kind === 'npu' ? 0 : a.kind === 'gpu' && (a.memoryGb ?? 0) >= rules.accelerators.ownMemoryGb ? 1 : a.kind === 'gpu' ? 2 : 3);
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || (rank(x.a) === 1 ? (y.a.memoryGb ?? 0) - (x.a.memoryGb ?? 0) : 0) || x.i - y.i)
    .map((x) => x.a);
}

/**
 * acceleratorOrder applied: the listed ids first, in its order, then any it leaves out, in auto order.
 * @template {{ id: string, kind: AcceleratorKind, memoryGb: number | null }} A
 * @param {Rules} rules
 * @param {A[]} list
 * @param {'auto' | string[]} order
 * @returns {A[]}
 */
export function ordered(rules, list, order) {
  if (order === 'auto') return autoOrder(rules, list);
  /** @type {A[]} */
  const first = [];
  for (const id of order) {
    const a = list.find((x) => x.id === id);
    if (a && !first.includes(a)) first.push(a);
  }
  return [...first, ...autoOrder(rules, list.filter((a) => !first.includes(a)))];
}

/**
 * The kinds of work an enabled NPU in the list serves (chat, vision, embeddings): none on a PC without one.
 * @param {ReadonlyArray<{ kind: AcceleratorKind, enabled?: boolean, chat?: unknown, vision?: unknown, embed?: unknown }>} list
 * @returns {Work[]}
 */
export function npuServes(list) {
  return WORKS.filter((w) => list.some((a) => a.kind === 'npu' && a.enabled !== false && !!a[w]));
}

/**
 * Manor's "Use the graphics card for models when there's an NPU" (settings.json's `gpuWithNpu`) applied: when it's
 * false and the list has an NPU that serves something, a graphics card keeps only the work no enabled NPU here serves
 * (kit 2.69.0: the card on demand), so it is never a candidate for the NPU's own work, not even the fallback when the
 * NPU fails or is busy. With the PC's work order (`order`, config.json's `workOrder` as workOrderIn reads it), it also
 * keeps the work the order puts a graphics card first for, though the NPU serves it, on demand like the rest (kit
 * 2.135.3, cardWorkBesideNpu): AMD XDNA 2's pictures on the Radeon. Never chat. On a PC whose NPU serves chat, vision
 * and embeddings (a Snapdragon) every card is left out, as before; on one whose NPU can't see (Intel's), the card keeps
 * vision: its server is started by the first vision request and stopped by the keeper once unused (gpuIdleStopMinutes).
 * A card's reranker, an add-on, is kept only where the order puts the card first for it (kit 2.135.5: Intel's, whose
 * NPU reranks nowhere; kit 2.136.3: AMD XDNA 2's, whose NPU reranker was parked), on demand as vision is; elsewhere it's left out with the rest, as before: the NPU reranks where
 * it can (a Snapdragon X2's, kit 2.100.0), else the processor. The processor stays. A card left with nothing is
 * dropped; one left with part of its work is a copy (a vision endpoint on its chat endpoint's server keeps that
 * server). With the switch true, or no NPU serving anything, the list is unchanged: on a PC without an NPU the switch
 * means nothing.
 * @template {{ kind: AcceleratorKind, enabled?: boolean, chat?: unknown, vision?: unknown, embed?: unknown, rerank?: unknown }} A
 * @param {A[]} list
 * @param {boolean} gpuWithNpu
 * @param {WorkOrder} [order] The PC's work order: without it, as before kit 2.135.3.
 * @returns {A[]}
 */
export function withoutGpuBesideNpu(list, gpuWithNpu, order) {
  if (gpuWithNpu !== false) return list;
  const npu = npuServes(list);
  if (!npu.length) return list;
  /** @type {A[]} */
  const out = [];
  for (const a of list) {
    if (a.kind !== 'gpu') {
      out.push(a);
      continue;
    }
    const left = cardBesideNpu(a, npu, order);
    if (left) out.push(left);
  }
  return out;
}

/**
 * Of a graphics card's kinds, those it does beside an NPU that serves `npu`, with Manor's gpuWithNpu off: the routed
 * work (chat, vision, embeddings) no NPU serves, and, with the PC's work order, the work it puts a graphics card first
 * for, though the NPU serves it (kit 2.135.3: AMD XDNA 2's pictures). The owner's ruling (2026-10-24): "Yes: on AMD,
 * pictures go to the Radeon on demand even with the graphics-card switch off; chat stays off the card." So chat never
 * is, whatever an order says. A reranker, an add-on, only where the order puts the card first for it (kit 2.135.5),
 * the owner's ruling the same day: "Yes: on Intel, a ticked reranker goes to the graphics card on demand even with the
 * switch off, like AMD's pictures; it stops when idle." The one rule requests (withoutGpuBesideNpu), the keeper and
 * setup follow.
 * @template {string} K
 * @param {readonly K[]} kinds
 * @param {readonly string[]} npu
 * @param {WorkOrder} [order] The PC's work order: without it, only the work no NPU serves, as before kit 2.135.3.
 * @returns {K[]}
 */
export function cardWorkBesideNpu(kinds, npu, order) {
  /** @param {K} k */
  const cardFirst = (k) => k !== 'chat' && ORDERED_WORKS.some((w) => w === k) && order?.[/** @type {OrderedWork} */ (/** @type {string} */ (k))]?.devices[0] === 'gpu';
  return kinds.filter((k) => cardFirst(k) || (WORKS.some((w) => w === k) && !npu.includes(k)));
}

/**
 * A graphics card with only the work it does beside an NPU that serves `npu` (cardWorkBesideNpu, with `order`), its
 * reranker among it; null when that leaves it nothing. The same object when it serves only such work already.
 * @template {{ kind: AcceleratorKind, chat?: unknown, vision?: unknown, embed?: unknown, rerank?: unknown }} A
 * @param {A} a
 * @param {Work[]} npu
 * @param {WorkOrder} [order]
 * @returns {A | null}
 */
function cardBesideNpu(a, npu, order) {
  /** @type {Record<string, any>} */
  const card = a;
  const keep = cardWorkBesideNpu(ORDERED_WORKS.filter((w) => !!card[w]), npu, order);
  if (!keep.length) return null;
  if (ORDERED_WORKS.every((w) => !card[w] || keep.includes(w))) return a;
  /** @type {Record<string, any>} */
  const copy = { ...card };
  for (const w of ORDERED_WORKS) if (!keep.includes(w)) delete copy[w];
  // A vision endpoint without a server of its own is on its chat endpoint's: it keeps that server when chat goes.
  const chat = card.chat;
  if (copy.vision && !copy.vision.baseUrl && !copy.chat && chat?.baseUrl) {
    copy.vision = { ...copy.vision, baseUrl: chat.baseUrl, ...(chat.startCommand ? { startCommand: chat.startCommand } : {}), ...(chat.env ? { env: chat.env } : {}) };
  }
  return /** @type {A} */ (copy);
}

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
export function parseAccelerators(rules, raw, hw = null) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Accelerator[]} */
  const list = [];
  const legacy = !Array.isArray(raw?.accelerators);
  /** @type {Map<string, string>} */
  const renamed = new Map();
  /** @param {Accelerator} a @returns {Accelerator} */
  const onThisPc = (a) => {
    const other = notTheNpu(a, hw);
    if (!other) return a;
    renamed.set(a.id, other.id);
    problems.push(say.notTheNpu(a.id, other.name));
    // An old config's chat was GenieX's, with its quirks; GenieX runs only on an NPU, so this server isn't it.
    return legacy ? { ...other, quirks: [] } : other;
  };
  /** @type {Accelerator[]} */
  const moved = [];
  if (!legacy) {
    raw.accelerators.forEach((/** @type {unknown} */ v, /** @type {number} */ i) => {
      const read = readOne(rules, v, hw);
      if ('error' in read) problems.push(`accelerators[${i}] ${read.error}`);
      else if (list.some((x) => x.id === read.id)) problems.push(`accelerators[${i}]: ${say.listedTwice(read.id)}`);
      else list.push(read);
    });
  } else {
    list.push(...fromLegacy(rules, raw, hw));
  }
  // An entry said to be the NPU on a PC without one goes after the others: a card's own entry (setup's) comes first.
  for (const a of list.splice(0)) {
    const r = onThisPc(a);
    if (r === a) list.push(a);
    else moved.push(r);
  }
  for (const a of moved) {
    const same = list.find((x) => x.id === a.id);
    // The same card listed twice (its own entry and the one called the NPU): one card, its own entry's servers first.
    if (same) for (const w of WORKS) same[w] ??= a[w];
    else list.push(a);
  }
  if (!list.some((a) => WORKS.some((w) => serves(a, w)))) {
    return { error: problems.length ? say.nothingUsable(problems) : REEVE_NOT_SET_UP };
  }
  /** @type {'auto' | string[]} */
  const order = Array.isArray(raw?.acceleratorOrder)
    ? raw.acceleratorOrder.filter((/** @type {unknown} */ x) => typeof x === 'string').map((/** @type {string} */ id) => renamed.get(id) ?? id)
    : 'auto';
  const workOrder = order === 'auto' ? workOrderIn(raw) : undefined;
  return {
    accelerators: ordered(rules, list, order),
    order,
    ...(workOrder ? { workOrder } : {}),
    requestTimeoutMs: positiveInt(raw?.requestTimeoutMs) ?? rules.accelerators.defaultRequestTimeoutMs,
    legacy,
    problems,
  };
}

/**
 * Reeve's config.json as read from its file: its text (null when there is none), checked. A file's
 * errors name the file; Reeve not set up reads the same whichever way.
 * @param {Rules} rules
 * @param {string} file The file's path, for messages.
 * @param {string | null} text
 * @param {Hardware | null} [hw] What this PC has (hardware.json), when known.
 * @returns {AcceleratorConfig | { error: string }}
 */
export function readConfig(rules, file, text, hw = null) {
  if (text === null) return { error: REEVE_NOT_SET_UP };
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { error: say.configUnreadable(file, /** @type {Error} */ (e).message) };
  }
  const cfg = parseAccelerators(rules, raw, hw);
  if ('error' in cfg) return { error: cfg.error === REEVE_NOT_SET_UP ? cfg.error : say.configError(file, cfg.error) };
  return cfg;
}

// ---------------------------------------------------------------- times

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * An ISO 8601 time with its zone ("2026-10-02T12:00:00.000Z", "…+02:00") in milliseconds since the Unix
 * epoch, or NaN for anything else: the shared files' times, read the same by every program.
 * @param {unknown} text
 * @returns {number}
 */
export function parseIsoMs(text) {
  const m = typeof text === 'string' ? ISO.exec(text) : null;
  if (!m) return NaN;
  const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3));
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return NaN;
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  if (new Date(t).getUTCDate() !== d) return NaN;
  const zone = m[8];
  if (zone === 'Z') return t;
  const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!z) return NaN;
  const offset = (Number(z[2]) * 60 + Number(z[3])) * 60_000;
  return z[1] === '+' ? t - offset : t + offset;
}

/**
 * A time as the shared files write it: "2026-10-02T12:00:00.000Z".
 * @param {number} ms
 * @returns {string}
 */
export function isoTime(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- failure markers

/**
 * A failure's reason as a marker keeps it: the first line, trimmed, at most reasonMaxChars ("it failed"
 * when there's nothing).
 * @param {Rules} rules
 * @param {unknown} text
 * @returns {string}
 */
export function oneLine(rules, text) {
  let line = String(text ?? '').trim();
  const end = line.search(/[\r\n]/);
  if (end >= 0) line = line.slice(0, end).trimEnd();
  if (!line) line = 'it failed';
  return line.slice(0, rules.accelerators.reasonMaxChars);
}

/**
 * A marker's contents (`<id>.failed.json`, its text or null when there is none) while it counts: until
 * failedForMs after its since (a marker exactly that old has expired). Null when it's absent,
 * unreadable (which counts the same) or expired.
 * @param {Rules} rules
 * @param {string | null} text
 * @param {number} nowMs
 * @returns {Failure | null}
 */
export function failureOf(rules, text, nowMs) {
  if (typeof text !== 'string') return null;
  let f;
  try {
    f = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!f || typeof f !== 'object' || typeof f.since !== 'string' || typeof f.reason !== 'string') return null;
  const since = parseIsoMs(f.since);
  if (!Number.isFinite(since) || nowMs - since >= rules.accelerators.failedForMs) return null;
  return { since: f.since, reason: f.reason, by: typeof f.by === 'string' ? f.by : '' };
}

/**
 * A new marker: `{ since, reason, by }`, the reason one line.
 * @param {Rules} rules
 * @param {unknown} reason
 * @param {string} by
 * @param {number} nowMs
 * @returns {Failure}
 */
export function failureRecord(rules, reason, by, nowMs) {
  return { since: isoTime(nowMs), reason: oneLine(rules, reason), by };
}

/**
 * When a marker stops counting, in milliseconds since the epoch (NaN when its since can't be read).
 * @param {Rules} rules
 * @param {Failure} f
 * @returns {number}
 */
export function failureUntil(rules, f) {
  return parseIsoMs(f.since) + rules.accelerators.failedForMs;
}

/**
 * A shared file's text as every program writes it: JSON, two spaces, a newline at the end.
 * @param {unknown} value
 * @returns {string}
 */
export function sharedText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------- games

/**
 * games.json's contents, or null when it's absent or unreadable (which count the same).
 * @param {string | null} text
 * @returns {Games | null}
 */
export function gamesOf(text) {
  if (typeof text !== 'string') return null;
  try {
    const g = JSON.parse(text.replace(/^﻿/, ''));
    return g && typeof g.checkedAt === 'string' && g.cards && typeof g.cards === 'object' ? g : null;
  } catch {
    return null;
  }
}

/**
 * Whether games.json needs checking again: none, older than gamesFreshMs, or from a clock that far ahead.
 * @param {Rules} rules
 * @param {Games | null} g
 * @param {number} nowMs
 * @returns {boolean}
 */
export function gamesStale(rules, g, nowMs) {
  if (!g) return true;
  const at = parseIsoMs(g.checkedAt);
  const fresh = rules.accelerators.gamesFreshMs;
  return !Number.isFinite(at) || nowMs - at > fresh || at - nowMs > fresh;
}

// ---------------------------------------------------------------- calls

/**
 * npu-call.json's contents, or null when it's absent or unreadable (which count the same: no call).
 * @param {string | null} text
 * @returns {NpuCall | null}
 */
export function callOf(text) {
  if (typeof text !== 'string') return null;
  try {
    const c = JSON.parse(text.replace(/^﻿/, ''));
    return c && typeof c.by === 'string' && c.by && typeof c.at === 'string' && typeof c.translating === 'boolean' ? c : null;
  } catch {
    return null;
  }
}

/**
 * The call on the NPU now, or null: npu-call.json written within callFreshMs. Older (its agent stopped without
 * removing it), or from a clock that far ahead, it's over.
 * @param {Rules} rules
 * @param {NpuCall | null} call
 * @param {number} nowMs
 * @returns {NpuCall | null}
 */
export function callNow(rules, call, nowMs) {
  if (!call) return null;
  const at = parseIsoMs(call.at);
  const fresh = rules.accelerators.callFreshMs;
  return Number.isFinite(at) && nowMs - at <= fresh && at - nowMs <= fresh ? call : null;
}

/**
 * A program's name from a command's first word: its file name, without `.exe`, in lowercase.
 * @param {string} exe
 * @returns {string}
 */
function programOf(exe) {
  const base = exe.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return base.replace(/\.exe$/i, '').toLowerCase();
}

/**
 * What doesn't count as a game: the desktop's compositor, and the manor's own model servers (their
 * startCommands', and the usual ones).
 * @param {Accelerator[]} accs
 * @returns {string[]}
 */
export function serverNames(accs) {
  const names = new Set(['dwm', 'llama-server', 'geniex', 'ollama', 'ollama_llama_server']);
  for (const a of accs) {
    for (const ep of [a.chat, a.vision, a.embed]) {
      const exe = ep?.startCommand?.[0];
      if (exe) names.add(programOf(exe));
    }
  }
  return [...names];
}

const ENGINE = /^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+_eng_\d+_engtype_3d\s+(-?[\d.]+)\s*$/i;

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
export function gameCards(rules, load, accs, opts) {
  const exclude = new Set((opts.exclude ?? serverNames(accs)).map((n) => n.toLowerCase()));
  /** @type {Map<string, Map<number, number>>} */
  const byLuid = new Map();
  for (const line of String(load.counters ?? '').split(/\r?\n/)) {
    const m = ENGINE.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    const percent = Number(m[3]);
    if (!pid || pid === opts.self || pid === load.compositor) continue;
    const name = (load.processes?.[String(pid)] ?? '').replace(/\.exe$/i, '').toLowerCase();
    if (name && exclude.has(name)) continue;
    const luid = m[2].toLowerCase();
    const perPid = byLuid.get(luid) ?? new Map();
    perPid.set(pid, Math.max(perPid.get(pid) ?? 0, percent));
    byLuid.set(luid, perPid);
  }
  const cards = keyedCards(load.adapters ?? []);
  /** @type {Record<string, CardUse>} */
  const out = {};
  for (const acc of accs) {
    if (acc.kind !== 'gpu') continue;
    const card = cards.find((c) => c.key.toLowerCase() === acc.name.toLowerCase() || acceleratorId('gpu', c.key) === acc.id);
    if (!card) continue;
    const perPid = [...(byLuid.get(card.luid.toLowerCase()) ?? new Map())].sort((a, b) => b[1] - a[1]);
    const over = perPid.filter(([, p]) => p > rules.accelerators.gamePercent);
    /** @param {number} pid */
    const exe = (pid) => {
      const n = load.processes?.[String(pid)];
      return n ? (/\.exe$/i.test(n) ? n : `${n}.exe`) : `pid ${pid}`;
    };
    out[acc.id] = { busy: over.length > 0, percent: Math.round(perPid[0]?.[1] ?? 0), by: over.map(([pid]) => exe(pid)) };
  }
  return out;
}

// ---------------------------------------------------------------- choosing

/**
 * The candidates for a request, in order: they serve its kind, its size fits their cap, they haven't
 * failed in the last failedForMs (unless every one that would do has: then they all may, as a last
 * resort), a game isn't using them (background work only), the NPU isn't captioning a call (`call`, callNow's:
 * background work only, kit 2.143.1), and the agent isn't leaving them alone after a line that was too long
 * (`deferredMs`). Skipped for a call, the NPU first leaves background work no candidate: it waits for the call's end
 * (whyNone's busy), and goes to no graphics card or processor meanwhile (the owner's ruling, 2026-10-27).
 *
 * **The NPU first:** when the first that would do, in order, is the NPU and it hasn't failed, it is the only
 * candidate (`npuFirst`). The NPU does model work without the processor or a graphics card, so they take it
 * only when the NPU can't: it doesn't serve the work, the request is too big for it, or it failed lately.
 * Busy, resting after a long line, or loading its model, it is waited for, never passed over. An
 * acceleratorOrder that puts something else first is the person's choice, and kept.
 *
 * **The work's own order** (kit 2.111.0): the config's `workOrder` for the request's kind, when it has one, puts the
 * accelerators in that order first (workOrdered), with `running` saying whose servers are up for its runningFirst. The
 * NPU first then means first in that order: AMD's pictures go to the Radeon (since kit 2.135.1 whoever's server is up,
 * the owner's ruling). With its runningFirst, those whose server is up go first, and with its batchAt, from that many of
 * the work waiting (`waiting`, this request included), the order is kept whoever's server is up. **It waits in one
 * line**: the first in the order that can take the request is the only candidate, as the NPU first is (kit 2.112.1 where
 * a runningFirst or a batch put one first; kit 2.135.1 for any order). A busy Radeon is waited for, not passed over for a
 * free NPU or processor that spends more on the work (AMD's pictures: 26.6 J each on the NPU against the Radeon's 10.4;
 * embeddings: 44.1 mJ a token on the processor against 12.8). The others take it only when that one can't: failed
 * lately, a game's, or rested after a long line.
 * @param {Rules} rules
 * @param {Accelerator[]} accs
 * @param {Need} need
 * @param {{ failures?: Record<string, Failure | null>, games?: Games | null, call?: NpuCall | null, deferredMs?: Record<string, number>, nowMs?: number, workOrder?: WorkOrder | null, running?: Record<string, boolean>, waiting?: number }} [state]
 * @returns {{ list: Accelerator[], skipped: Skipped[], npuFirst: boolean }}
 */
export function candidates(rules, accs, need, state = {}) {
  /** @type {Accelerator[]} */
  const list = [];
  /** @type {Skipped[]} */
  const skipped = [];
  const order = state.workOrder?.[need.work];
  const fitting = workOrdered(
    accs.filter((acc) => serves(acc, need.work) && need.tokens <= capFor(acc, need.work)),
    order,
    state.running,
    state.waiting,
  );
  /** @param {Accelerator} acc */
  const failureOfAcc = (acc) => state.failures?.[acc.id] ?? null;
  // When every one that would do has failed, they're tried anyway (the last resort, as Reeve does), rather
  // than leaving a PC with only the NPU without model work for ten minutes after one hiccup.
  const lastResort = fitting.length > 0 && fitting.every((acc) => failureOfAcc(acc));
  const head = fitting[0];
  const npuFirst = !!head && head.kind === 'npu' && (lastResort || !failureOfAcc(head));
  for (const acc of npuFirst ? [head] : fitting) {
    const failed = lastResort ? null : failureOfAcc(acc);
    if (failed) {
      const min = Math.max(1, Math.ceil((failureUntil(rules, failed) - (state.nowMs ?? 0)) / 60_000));
      skipped.push({ acc, why: 'failed', detail: say.skippedFailed(acc, failed.reason, min) });
      continue;
    }
    const card = acc.kind === 'gpu' && need.lane === 'background' ? state.games?.cards?.[acc.id] : undefined;
    if (card?.busy) {
      skipped.push({ acc, why: 'game', detail: say.skippedGame(acc, card.by ?? []) });
      continue;
    }
    const call = acc.kind === 'npu' && need.lane === 'background' ? state.call : null;
    if (call) {
      skipped.push({ acc, why: 'call', detail: say.skippedCall(acc, call.by) });
      continue;
    }
    const wait = state.deferredMs?.[acc.id] ?? 0;
    if (wait > 0) {
      skipped.push({ acc, why: 'deferred', detail: say.skippedDeferred(acc, Math.ceil(wait / 60_000)) });
      continue;
    }
    list.push(acc);
  }
  // The work has an order: the first in it that can take it, alone (above).
  const first = !npuFirst && !!order;
  return { list: first ? list.slice(0, 1) : list, skipped, npuFirst };
}

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
export function pick(rules, list, lane, looks) {
  if (!list.length) throw new Error('pick: no candidates');
  const seen = list.map((a) => ({ a, l: looks[a.id] ?? { freeSlot: false, waiting: 0 } }));
  const free = seen.find((x) => x.l.freeSlot && x.l.waiting === 0);
  if (free) return { acc: free.a };
  const shortest = seen.reduce((best, x) => (x.l.waiting < best.l.waiting ? x : best));
  if (lane === 'background' && shortest.l.waiting >= rules.accelerators.maxAhead) {
    return { deferred: seen.length === 1 ? say.lineFull(shortest.a, shortest.l.waiting) : say.everyLineFull(seen.map((x) => ({ acc: x.a, waiting: x.l.waiting }))) };
  }
  return { acc: shortest.a };
}

/**
 * Why no accelerator could take a request: `busy` (defer it, it isn't a fault) while any was only resting
 * or held by a game; an error when they all failed, or when the one tried first failed and none could
 * take it after.
 * @param {Skipped[]} skipped
 * @param {{ acc: AcceleratorRef, reason: string } | null} first The accelerator tried first, when it failed.
 * @returns {{ busy: boolean, message: string }}
 */
export function whyNone(skipped, first) {
  const why = skipped.map((s) => s.detail).join('; ');
  if (first) return { busy: false, message: say.failedNoOther(first.acc, first.reason, why) };
  if (skipped.some((s) => s.why !== 'failed')) return { busy: true, message: why };
  return { busy: false, message: why || say.noneCould() };
}

// ---------------------------------------------------------------- the size of a request

/**
 * The pessimistic estimate every agent uses for its caps: one token per charsPerToken characters.
 * @param {Rules} rules
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(rules, text) {
  return Math.ceil(text.length / rules.tokens.charsPerToken);
}

/**
 * A chat request's prompt, by the estimate: each message and a little for its role, and room for the
 * servers' quirks, whichever accelerator takes it.
 * @param {Rules} rules
 * @param {{ content: string }[]} messages
 * @returns {number}
 */
export function chatTokens(rules, messages) {
  const t = rules.tokens;
  return Math.ceil((messages.reduce((n, m) => n + m.content.length + t.messageChars, 0) + t.quirkRoomChars) / t.charsPerToken);
}

/**
 * What a picture counts for on an accelerator: its vision endpoint's pictureTokens, the size the kit fits each picture
 * to there, else imageTokens.
 * @param {Rules} rules
 * @param {Partial<Pick<Accelerator, 'vision'>>} [a]
 * @returns {number}
 */
export function pictureTokensFor(rules, a) {
  return a?.vision?.pictureTokens ?? rules.tokens.imageTokens;
}

/**
 * A question about one image, by the estimate: the image counts pictureTokensFor `a`, imageTokens without one.
 * @param {Rules} rules
 * @param {string} question
 * @param {Partial<Pick<Accelerator, 'vision'>>} [a]
 * @returns {number}
 */
export function visionTokens(rules, question, a) {
  return pictureTokensFor(rules, a) + estimateTokens(rules, question);
}

/**
 * Why a request is refused before anything is sent: over every candidate's cap (null when one fits). With `work`,
 * each one's cap for that kind (capFor).
 * @param {(Pick<Accelerator, 'maxContextTokens'> & Partial<Pick<Accelerator, Work>>)[]} serving
 * @param {number} promptTokens
 * @param {number} maxTokens
 * @param {Work} [work]
 * @returns {string | null}
 */
export function tooBig(serving, promptTokens, maxTokens, work) {
  const capOf = (/** @type {Pick<Accelerator, 'maxContextTokens'> & Partial<Pick<Accelerator, Work>>} */ a) => (work ? capFor(a, work) : a.maxContextTokens);
  if (!serving.length || serving.some((a) => promptTokens + maxTokens <= capOf(a))) return null;
  const cap = Math.max(...serving.map(capOf));
  return say.tooBig(promptTokens, maxTokens, cap, serving.length > 1);
}

// ---------------------------------------------------------------- how long a request may take

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
export function requestTimeoutMs(rules, r) {
  const a = { ...rules.accelerators, ...(r.timeouts ?? {}) };
  const own = r.lane === 'background' && r.work !== 'embed' ? Math.min(r.ceilingMs, a.requestBaseMs + a.requestPerTokenMs * Math.max(0, r.maxTokens)) : r.ceilingMs;
  return own + (r.coldLoad ? a.coldLoadMs : 0);
}

/**
 * Splits text into pieces whose estimated size fits `budgetTokens`, at line breaks where it can, so a long
 * input is asked about piece by piece (map-reduce) and never sent whole.
 * @param {Rules} rules
 * @param {string} text
 * @param {number} budgetTokens
 * @returns {string[]}
 */
export function pieces(rules, text, budgetTokens) {
  const max = Math.max(rules.tokens.minPieceChars, budgetTokens * rules.tokens.charsPerToken);
  /** @type {string[]} */
  const out = [];
  let cur = '';
  for (const line of text.split(/\r?\n/)) {
    for (let rest = line; ; ) {
      const room = max - cur.length - 1;
      if (rest.length <= room) {
        cur += (cur ? '\n' : '') + rest;
        break;
      }
      if (cur) {
        out.push(cur);
        cur = '';
        continue;
      }
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
      if (!rest) break;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- speed

/**
 * The answer sizes speeds are kept by, each its least tokens: a size runs up to the next one's, and the last has no end. A
 * server's decode speed counts its first token's wait too, so a short answer reads slower than a long one on the same boot,
 * and each size is compared only with itself. An answer under the first isn't kept: too few tokens to say.
 */
export const SPEED_SIZES = Object.freeze([16, 32, 64]);

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
export function speedSize(answerTokens) {
  /** @type {number | null} */
  let size = null;
  for (const s of SPEED_SIZES) if (answerTokens >= s) size = s;
  return size;
}

/**
 * @param {number[]} xs
 * @returns {number}
 */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** @param {number} x */
const tenths = (x) => Math.round(x * 10) / 10;

/**
 * A speeds file's contents, or null when it's absent or unreadable (which count the same). A boot or row that can't be
 * read is left out, and so is a speed that isn't one.
 * @param {string | null} text
 * @returns {Speeds | null}
 */
export function speedsOf(text) {
  if (typeof text !== 'string') return null;
  /** @type {any} */
  let f;
  try {
    f = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!f || typeof f !== 'object' || typeof f.agent !== 'string' || !Array.isArray(f.boots)) return null;
  /** @type {SpeedBoot[]} */
  const boots = [];
  for (const b of f.boots) {
    if (!b || typeof b.boot !== 'string' || !Number.isFinite(parseIsoMs(b.boot)) || !Array.isArray(b.rows)) continue;
    /** @type {SpeedRow[]} */
    const rows = [];
    for (const r of b.rows) {
      if (!r || typeof r.acc !== 'string' || typeof r.model !== 'string' || !SPEED_SIZES.includes(r.size) || !Array.isArray(r.tps)) continue;
      rows.push({ acc: r.acc, model: r.model, size: r.size, tps: r.tps.filter((/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x) && x > 0) });
    }
    boots.push({ boot: b.boot, rows });
  }
  return { agent: f.agent, boots };
}

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
export function addSpeed(rules, file, agent, bootMs, s) {
  const boots = (file?.boots ?? []).map((b) => ({ boot: b.boot, rows: b.rows.map((r) => ({ ...r, tps: [...r.tps] })) }));
  const size = speedSize(s.answerTokens);
  if (size === null || !Number.isFinite(s.tokensPerSecond) || s.tokensPerSecond <= 0 || !Number.isFinite(bootMs)) return { agent, boots };
  let boot = boots.find((b) => Math.abs(parseIsoMs(b.boot) - bootMs) <= rules.speed.bootSlackMs);
  if (!boot) {
    boot = { boot: isoTime(bootMs), rows: [] };
    boots.push(boot);
    boots.sort((a, b) => parseIsoMs(a.boot) - parseIsoMs(b.boot));
  }
  let row = boot.rows.find((r) => r.acc === s.acc && r.model === s.model && r.size === size);
  if (!row) {
    row = { acc: s.acc, model: s.model, size, tps: [] };
    boot.rows.push(row);
  }
  row.tps.push(Math.round(s.tokensPerSecond * 100) / 100);
  row.tps.splice(0, Math.max(0, row.tps.length - rules.speed.keptPerBoot));
  return { agent, boots: boots.slice(Math.max(0, boots.length - rules.speed.keptBoots)) };
}

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
export function bootSpeed(rules, files, bootMs, acc) {
  const { bootSlackMs: slack, samplesNeeded: needed } = rules.speed;
  /** @type {Map<string, { model: string, size: number, now: number[], earlier: Map<number, number[]> }>} */
  const kinds = new Map();
  /** @type {number[]} */
  const starts = [];
  for (const f of files) {
    for (const b of f?.boots ?? []) {
      const at = parseIsoMs(b.boot);
      const isNow = Math.abs(at - bootMs) <= slack;
      if (!Number.isFinite(at) || (!isNow && at > bootMs)) continue;
      let start = starts.find((t) => Math.abs(t - at) <= slack);
      if (!isNow && start === undefined) starts.push((start = at));
      for (const r of b.rows) {
        if (r.acc !== acc) continue;
        const key = `${r.model}\n${r.size}`;
        let k = kinds.get(key);
        if (!k) kinds.set(key, (k = { model: r.model, size: r.size, now: [], earlier: new Map() }));
        if (isNow) k.now.push(...r.tps);
        else if (start !== undefined) k.earlier.set(start, [...(k.earlier.get(start) ?? []), ...r.tps]);
      }
    }
  }
  /** @type {BootSpeed | null} */
  let best = null;
  for (const k of kinds.values()) {
    if (k.now.length < needed || (best && best.samples >= k.now.length)) continue;
    const earlier = [...k.earlier.values()].filter((t) => t.length >= needed).map(median);
    if (!earlier.length) continue;
    const now = median(k.now);
    const usual = Math.max(...earlier);
    const percent = Math.round((100 * now) / usual);
    best = { acc, model: k.model, size: k.size, since: isoTime(bootMs), now: tenths(now), samples: k.now.length, usual: tenths(usual), boots: earlier.length, percent, slow: percent <= rules.speed.slowPercent };
  }
  return best;
}
