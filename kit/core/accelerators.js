// The accelerators' rules (ACCELERATORS.md): reading and checking Reeve's config, the auto order, the
// failure markers, the game check, the candidates for a request and the pick among them, and the size
// of a request. Pure: a driver reads the files and asks the counters, and hands their contents in.

import { acceleratorId, keyedCards, kindOfId, LEGACY_NAMES } from './ids.js';
import { REEVE_NOT_SET_UP, say } from './messages.js';
import { slotNames } from './queue.js';

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
export const WORKS = Object.freeze(['chat', 'vision', 'embed']);

/** `prefix-leak`: each request starts with a nonce (GenieX v0.7.0). `image-path`: the server reads a local image path. */
export const QUIRKS = Object.freeze(['prefix-leak', 'image-path']);

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

// ---------------------------------------------------------------- Reeve's config

/** @param {unknown} u */
const baseUrlOf = (u) => String(u).replace(/\/(v1\/?)?$/, '');
/** @param {unknown} v */
const positiveInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** @typedef {{ baseUrl?: string, model: string, startCommand?: string[] }} Written */

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
  };
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
    if (ep.baseUrl) out[w] = { baseUrl: ep.baseUrl, model: ep.model, ...(ep.startCommand ? { startCommand: ep.startCommand } : {}) };
    else if (w === 'vision' && eps.chat?.baseUrl) out[w] = { baseUrl: eps.chat.baseUrl, model: ep.model, ...(eps.chat.startCommand ? { startCommand: eps.chat.startCommand } : {}) };
  }
  return out;
}

/**
 * One entry of `accelerators`, as Reeve reads it: its kind from its id, one slot, the NPU's cap, known quirks only.
 * @param {Rules} rules
 * @param {any} v
 * @returns {Accelerator | { error: string }}
 */
function readOne(rules, v) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string') return { error: say.noId() };
  const kind = kindOfId(v.id);
  if (!kind) return { error: say.badId(v.id) };
  return withServers(
    {
      id: v.id,
      kind,
      name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : LEGACY_NAMES[kind],
      memoryGb: typeof v.memoryGb === 'number' && v.memoryGb >= 0 ? v.memoryGb : null,
      slots: kind === 'npu' ? 1 : Math.min(rules.accelerators.maxSlots, positiveInt(v.slots) ?? 1),
      maxContextTokens: positiveInt(v.maxContextTokens) ?? rules.accelerators.defaultMaxContextTokens,
      quirks: Array.isArray(v.quirks) ? v.quirks.filter((/** @type {unknown} */ q) => typeof q === 'string' && QUIRKS.includes(q)) : [],
      ...(v.enabled === false ? { enabled: false } : {}),
    },
    { chat: readEndpoint(v.chat), vision: readEndpoint(v.vision), embed: readEndpoint(v.embed) },
  );
}

/**
 * An older config (chatEndpoint, visionModel, embedEndpoint, npuMaxContextTokens) as accelerators, as
 * Reeve reads it: one per device, `npu` when the device is the NPU. The chat endpoint keeps the cap and
 * both GenieX quirks it always had; an embed endpoint on another device is an accelerator of its own.
 * @param {Rules} rules
 * @param {any} raw
 * @returns {Accelerator[]}
 */
function fromLegacy(rules, raw) {
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
      f = { a: { id: acceleratorId(kind, LEGACY_NAMES[kind]), kind, name: LEGACY_NAMES[kind], memoryGb: null, slots: 1, maxContextTokens: cap, quirks: [] }, eps: {} };
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
 * Auto: graphics cards with `ownMemoryGb` (2 GB) or more of their own memory first, the most memory
 * first; then the NPU; then graphics that share the PC's memory; then the CPU. Ties keep the given order.
 * @template {{ kind: AcceleratorKind, memoryGb: number | null }} A
 * @param {Rules} rules
 * @param {A[]} list
 * @returns {A[]}
 */
export function autoOrder(rules, list) {
  /** @param {A} a */
  const rank = (a) => (a.kind === 'gpu' && (a.memoryGb ?? 0) >= rules.accelerators.ownMemoryGb ? 0 : a.kind === 'npu' ? 1 : a.kind === 'gpu' ? 2 : 3);
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || (rank(x.a) === 0 ? (y.a.memoryGb ?? 0) - (x.a.memoryGb ?? 0) : 0) || x.i - y.i)
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
 * Manor's "Use the graphics card for models when there's an NPU" (settings.json's `gpuWithNpu`) applied: when it's
 * false and the list has an NPU that serves something, every graphics card is left out, so none is ever a candidate,
 * not even the fallback when the NPU fails or is busy. The processor stays. With it true, or no NPU serving anything,
 * the list is unchanged: on a PC without an NPU the switch means nothing.
 * @template {{ kind: AcceleratorKind, enabled?: boolean, chat?: unknown, vision?: unknown, embed?: unknown }} A
 * @param {A[]} list
 * @param {boolean} gpuWithNpu
 * @returns {A[]}
 */
export function withoutGpuBesideNpu(list, gpuWithNpu) {
  const npu = list.some((a) => a.kind === 'npu' && a.enabled !== false && WORKS.some((w) => !!a[w]));
  return gpuWithNpu === false && npu ? list.filter((a) => a.kind !== 'gpu') : list;
}

/**
 * The accelerators in a parsed config.json, or why there are none: REEVE_NOT_SET_UP when nothing serves
 * anything, unless some entries couldn't be read (then the config needs fixing, and they're named).
 * @param {Rules} rules
 * @param {any} raw
 * @returns {AcceleratorConfig | { error: string }}
 */
export function parseAccelerators(rules, raw) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Accelerator[]} */
  const list = [];
  const legacy = !Array.isArray(raw?.accelerators);
  if (!legacy) {
    raw.accelerators.forEach((/** @type {unknown} */ v, /** @type {number} */ i) => {
      const r = readOne(rules, v);
      if ('error' in r) problems.push(`accelerators[${i}] ${r.error}`);
      else if (list.some((x) => x.id === r.id)) problems.push(`accelerators[${i}]: ${say.listedTwice(r.id)}`);
      else list.push(r);
    });
  } else {
    list.push(...fromLegacy(rules, raw));
  }
  if (!list.some((a) => WORKS.some((w) => serves(a, w)))) {
    return { error: problems.length ? say.nothingUsable(problems) : REEVE_NOT_SET_UP };
  }
  /** @type {'auto' | string[]} */
  const order = Array.isArray(raw?.acceleratorOrder) ? raw.acceleratorOrder.filter((/** @type {unknown} */ x) => typeof x === 'string') : 'auto';
  return {
    accelerators: ordered(rules, list, order),
    order,
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
 * @returns {AcceleratorConfig | { error: string }}
 */
export function readConfig(rules, file, text) {
  if (text === null) return { error: REEVE_NOT_SET_UP };
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { error: say.configUnreadable(file, /** @type {Error} */ (e).message) };
  }
  const cfg = parseAccelerators(rules, raw);
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
 * resort), a game isn't using them (background work only), and the agent isn't leaving them alone after
 * a line that was too long (`deferredMs`).
 * @param {Rules} rules
 * @param {Accelerator[]} accs
 * @param {Need} need
 * @param {{ failures?: Record<string, Failure | null>, games?: Games | null, deferredMs?: Record<string, number>, nowMs?: number }} [state]
 * @returns {{ list: Accelerator[], skipped: Skipped[] }}
 */
export function candidates(rules, accs, need, state = {}) {
  /** @type {Accelerator[]} */
  const list = [];
  /** @type {Skipped[]} */
  const skipped = [];
  const fitting = accs.filter((acc) => serves(acc, need.work) && need.tokens <= acc.maxContextTokens);
  /** @param {Accelerator} acc */
  const failureOfAcc = (acc) => state.failures?.[acc.id] ?? null;
  // When every one that would do has failed, they're tried anyway (the last resort, as Reeve does), rather
  // than leaving a PC with only the NPU without model work for ten minutes after one hiccup.
  const lastResort = fitting.length > 0 && fitting.every((acc) => failureOfAcc(acc));
  for (const acc of fitting) {
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
    const wait = state.deferredMs?.[acc.id] ?? 0;
    if (wait > 0) {
      skipped.push({ acc, why: 'deferred', detail: say.skippedDeferred(acc, Math.ceil(wait / 60_000)) });
      continue;
    }
    list.push(acc);
  }
  return { list, skipped };
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
 * A question about one image, by the estimate: the image counts imageTokens.
 * @param {Rules} rules
 * @param {string} question
 * @returns {number}
 */
export function visionTokens(rules, question) {
  return rules.tokens.imageTokens + estimateTokens(rules, question);
}

/**
 * Why a request is refused before anything is sent: over every candidate's cap (null when one fits).
 * @param {{ maxContextTokens: number }[]} serving
 * @param {number} promptTokens
 * @param {number} maxTokens
 * @returns {string | null}
 */
export function tooBig(serving, promptTokens, maxTokens) {
  if (!serving.length || serving.some((a) => promptTokens + maxTokens <= a.maxContextTokens)) return null;
  const cap = Math.max(...serving.map((a) => a.maxContextTokens));
  return say.tooBig(promptTokens, maxTokens, cap, serving.length > 1);
}

// ---------------------------------------------------------------- how long a request may take

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
export function requestTimeoutMs(rules, r) {
  const a = rules.accelerators;
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
