import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceleratorsDir, lockDirFor } from './lock.ts';
import { lineState, queueDirFor, readLine, slotDirs, type Lane } from './npu-queue.ts';
import { powershell } from './ps.ts';

/**
 * The accelerators the manor's models run on: the NPU, one or more graphics cards, or the processor,
 * each behind an OpenAI-compatible model server. The contract every agent follows is Manor's
 * docs/ACCELERATORS.md; this is the kit's side of it, with nothing of any one agent in it. Reeve does
 * the same in its src/accelerators.ts, routing.ts, games.ts and router.ts, and reads the config the
 * same way:
 * - Reeve's config.json lists them (`accelerators`, `acceleratorOrder`); an older config with only a
 *   `chatEndpoint` (and `embedEndpoint`) is read as one accelerator per device, `npu` for the NPU;
 * - each request is offered to the candidates that serve its kind, fit its size, haven't failed in the
 *   last 10 minutes, and (for background work) aren't a graphics card a game is using; it goes to the
 *   first with a free slot and nobody waiting, else to the shortest line;
 * - a server that won't start within 30 s, refuses the connection, answers 5xx or times out marks its
 *   accelerator failed (a file every agent reads), and the request goes once to the next candidate;
 * - the servers' quirks: GenieX's prefix leak (a nonce first), and whether images go as a local path.
 * The turns themselves (locks, lines, this agent's manners) are src/npu.ts's.
 */

export type AcceleratorKind = 'npu' | 'gpu' | 'cpu';
export type Work = 'chat' | 'vision' | 'embed';
const WORKS: Work[] = ['chat', 'vision', 'embed'];

/** `prefix-leak`: each request starts with a nonce (GenieX v0.7.0). `image-path`: the server reads a local image path. */
export const QUIRKS = ['prefix-leak', 'image-path'];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** One OpenAI-compatible server: where it is, its model, and how to start it when it isn't running. */
export interface Endpoint {
  baseUrl: string;
  model: string;
  startCommand?: string[];
}

export interface Accelerator {
  /** `npu`, `cpu`, or `gpu-` and the card's name (acceleratorId). */
  id: string;
  kind: AcceleratorKind;
  /** The device's own name: "Snapdragon X2 Elite NPU", "NVIDIA GeForce RTX 4090". */
  name: string;
  /** A graphics card's own memory, in GB; null when unknown. Under 2 GB, it shares the PC's. */
  memoryGb: number | null;
  /** How many requests it serves at once (llama-server's --parallel). The NPU has 1. */
  slots: number;
  /** The most a request may be, prompt and answer, by the kit's pessimistic estimate. */
  maxContextTokens: number;
  /** A vision endpoint without a server of its own is on the chat endpoint's. */
  chat?: Endpoint;
  vision?: Endpoint;
  embed?: Endpoint;
  /** `prefix-leak`, `image-path` (QUIRKS). */
  quirks: string[];
  /** false: kept in the list, sent nothing. */
  enabled?: boolean;
}

export interface AcceleratorConfig {
  /** In the order requests try them: acceleratorOrder's, or auto's. */
  accelerators: Accelerator[];
  order: 'auto' | string[];
  requestTimeoutMs: number;
  /** Read from an older config's chatEndpoint and embedEndpoint. */
  legacy: boolean;
  /** Entries that couldn't be read, in words. */
  problems: string[];
}

/** Where an answer came from, as answers and notes carry it. */
export interface AcceleratorRef {
  id: string;
  name: string;
}

export const refOf = (a: AcceleratorRef): AcceleratorRef => ({ id: a.id, name: a.name });

/** The NPU an older config, and every note written before accelerators, came from. */
export const LEGACY_NPU: AcceleratorRef = { id: 'npu', name: 'NPU' };

/** "the NPU", "the NVIDIA GeForce RTX 4090", "the graphics card": an accelerator in a sentence. */
export const theAccelerator = (a: AcceleratorRef | null | undefined) => {
  const name = (a ?? LEGACY_NPU).name;
  if (/^the\s/i.test(name)) return name;
  return `the ${name === LEGACY_NAMES.gpu || name === LEGACY_NAMES.cpu ? name.toLowerCase() : name}`;
};

/** A note's label: "note from the NVIDIA GeForce RTX 4090, unverified". */
export const noteLabel = (a: AcceleratorRef | null | undefined) => `note from ${theAccelerator(a)}, unverified`;

/** Whether it serves this kind of request. */
export const serves = (a: Accelerator, work: Work) => a.enabled !== false && !!a[work];

// ---------------------------------------------------------------- Reeve's config

/**
 * Reeve's data folder: %USERPROFILE%\.reeve, or REEVE_HOME; the npu-agent folder on a PC where
 * `reeve migrate` hasn't run yet.
 */
export const reeveHome =
  process.env.REEVE_HOME ??
  [path.join(os.homedir(), '.reeve'), path.join(os.homedir(), '.npu-agent')].find((d) => existsSync(path.join(d, 'config.json'))) ??
  path.join(os.homedir(), '.reeve');

/** A card's id part: its name in lowercase, each run of other characters one dash, none at either end (as Reeve). */
export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `npu`, `cpu`, or `gpu-<slug of the name>` ("NVIDIA GeForce RTX 4090 #2" is gpu-nvidia-geforce-rtx-4090-2). */
export const acceleratorId = (kind: AcceleratorKind, name: string) => (kind === 'gpu' ? `gpu-${slug(name) || 'graphics-card'}` : kind);

const ID = /^(npu|cpu|gpu-[a-z0-9]+(-[a-z0-9]+)*)$/;
const kindOfId = (id: string): AcceleratorKind | null => (!ID.test(id) ? null : id === 'npu' ? 'npu' : id === 'cpu' ? 'cpu' : 'gpu');

const LEGACY_NAMES: Record<AcceleratorKind, string> = { npu: 'NPU', gpu: 'Graphics card', cpu: 'Processor' };
const DEFAULT_CAP = 2400;
const DEFAULT_TIMEOUT_MS = 180_000;

const baseUrlOf = (u: unknown) => String(u).replace(/\/(v1\/?)?$/, '');
const positiveInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** One served kind as written; a vision endpoint may leave out its server (it's the chat endpoint's). */
function readEndpoint(v: any): { baseUrl?: string; model: string; startCommand?: string[] } | undefined {
  if (!v || typeof v !== 'object' || typeof v.model !== 'string' || !v.model) return undefined;
  return {
    model: v.model,
    ...(typeof v.baseUrl === 'string' && v.baseUrl ? { baseUrl: baseUrlOf(v.baseUrl) } : {}),
    ...(Array.isArray(v.startCommand) ? { startCommand: v.startCommand.map(String) } : {}),
  };
}

/** Each kind's endpoint with its server: vision without one of its own on the chat endpoint's. */
function withServers(a: Omit<Accelerator, Work>, eps: Partial<Record<Work, ReturnType<typeof readEndpoint>>>): Accelerator {
  const out: Accelerator = { ...a };
  for (const w of WORKS) {
    const ep = eps[w];
    if (!ep) continue;
    if (ep.baseUrl) out[w] = { baseUrl: ep.baseUrl, model: ep.model, ...(ep.startCommand ? { startCommand: ep.startCommand } : {}) };
    else if (w === 'vision' && eps.chat?.baseUrl) out[w] = { baseUrl: eps.chat.baseUrl, model: ep.model, ...(eps.chat.startCommand ? { startCommand: eps.chat.startCommand } : {}) };
  }
  return out;
}

/** One entry of `accelerators`, as Reeve reads it: its kind from its id, one slot, the NPU's cap, known quirks only. */
function readOne(v: any): Accelerator | { error: string } {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string') return { error: 'has no id' };
  const kind = kindOfId(v.id);
  if (!kind) return { error: `${v.id}: an id is npu, cpu, or gpu- and the card's name in lowercase with dashes` };
  return withServers(
    {
      id: v.id,
      kind,
      name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : LEGACY_NAMES[kind],
      memoryGb: typeof v.memoryGb === 'number' && v.memoryGb >= 0 ? v.memoryGb : null,
      slots: kind === 'npu' ? 1 : Math.min(16, positiveInt(v.slots) ?? 1),
      maxContextTokens: positiveInt(v.maxContextTokens) ?? DEFAULT_CAP,
      quirks: Array.isArray(v.quirks) ? v.quirks.filter((q: unknown): q is string => QUIRKS.includes(q as string)) : [],
      ...(v.enabled === false ? { enabled: false } : {}),
    },
    { chat: readEndpoint(v.chat), vision: readEndpoint(v.vision), embed: readEndpoint(v.embed) },
  );
}

/**
 * An older config (chatEndpoint, visionModel, embedEndpoint, npuMaxContextTokens) as accelerators, as
 * Reeve reads it: one per device, `npu` when the device is the NPU. The chat endpoint keeps the cap and
 * both GenieX quirks it always had; an embed endpoint on another device is an accelerator of its own.
 */
function fromLegacy(raw: any): Accelerator[] {
  const cap = positiveInt(raw?.npuMaxContextTokens) ?? DEFAULT_CAP;
  const found: { a: Omit<Accelerator, Work>; eps: Partial<Record<Work, ReturnType<typeof readEndpoint>>> }[] = [];
  const forDevice = (device: unknown) => {
    const d = String(device ?? 'Npu').toLowerCase();
    const kind: AcceleratorKind = d === 'gpu' ? 'gpu' : d === 'cpu' ? 'cpu' : 'npu';
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
 * Auto: graphics cards with 2 GB or more of their own memory first, the most memory first; then the
 * NPU; then graphics that share the PC's memory; then the CPU. Ties keep the config's order.
 */
export function autoOrder(list: Accelerator[]): Accelerator[] {
  const rank = (a: Accelerator) => (a.kind === 'gpu' && (a.memoryGb ?? 0) >= 2 ? 0 : a.kind === 'npu' ? 1 : a.kind === 'gpu' ? 2 : 3);
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || (rank(x.a) === 0 ? (y.a.memoryGb ?? 0) - (x.a.memoryGb ?? 0) : 0) || x.i - y.i)
    .map((x) => x.a);
}

/** acceleratorOrder applied: the listed ids first, in its order, then any it leaves out, in auto order. */
export function ordered(list: Accelerator[], order: 'auto' | string[]): Accelerator[] {
  if (order === 'auto') return autoOrder(list);
  const first: Accelerator[] = [];
  for (const id of order) {
    const a = list.find((x) => x.id === id);
    if (a && !first.includes(a)) first.push(a);
  }
  return [...first, ...autoOrder(list.filter((a) => !first.includes(a)))];
}

/** The accelerators in a parsed config.json, or why there are none. */
export function parseAccelerators(raw: any): AcceleratorConfig | { error: string } {
  const problems: string[] = [];
  const list: Accelerator[] = [];
  const legacy = !Array.isArray(raw?.accelerators);
  if (!legacy) {
    raw.accelerators.forEach((v: unknown, i: number) => {
      const r = readOne(v);
      if ('error' in r) problems.push(`accelerators[${i}] ${r.error}`);
      else if (list.some((x) => x.id === r.id)) problems.push(`accelerators[${i}]: ${r.id} is listed twice; the first is used`);
      else list.push(r);
    });
  } else {
    list.push(...fromLegacy(raw));
  }
  if (!list.some((a) => WORKS.some((w) => serves(a, w)))) {
    return {
      error: legacy
        ? 'has no accelerators (nor a chatEndpoint, the GenieX server Reeve used before)'
        : `lists no accelerator that serves anything${problems.length ? ` (${problems.join('; ')})` : ''}`,
    };
  }
  const order = Array.isArray(raw?.acceleratorOrder) ? raw.acceleratorOrder.filter((x: unknown) => typeof x === 'string') : 'auto';
  return { accelerators: ordered(list, order), order, requestTimeoutMs: positiveInt(raw?.requestTimeoutMs) ?? DEFAULT_TIMEOUT_MS, legacy, problems };
}

/** Reeve's config.json (REEVE_HOME, else %USERPROFILE%\.reeve), or why its accelerators can't be used. */
export function loadAccelerators(file = path.join(reeveHome, 'config.json')): AcceleratorConfig | { error: string } {
  if (!existsSync(file)) return { error: `Reeve isn't set up here (${file} is missing)` };
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { error: `${file} couldn't be read: ${(e as Error).message}` };
  }
  const cfg = parseAccelerators(raw);
  return 'error' in cfg ? { error: `${file} ${cfg.error}` } : cfg;
}

// ---------------------------------------------------------------- shared files

/** Written whole: a temporary file, then a rename, so a reader never sees half of it. */
function writeWhole(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e: any) {
      // Windows refuses a rename over a file another process has open for a moment.
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

/** A JSON file, or null when it's absent or unreadable (which count the same). */
function readWhole(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** A failed accelerator is skipped for this long, then tried again. */
export const FAILED_FOR_MS = 10 * 60_000;

export interface Failure {
  since: string;
  reason: string;
  by: string;
}

export const failedFile = (id: string) => path.join(acceleratorsDir, `${id}.failed.json`);

/** Its failure in the last 10 minutes, or null (none, expired, or unreadable). */
export function readFailure(id: string, now = Date.now()): Failure | null {
  const f = readWhole(failedFile(id));
  if (!f || typeof f.since !== 'string' || typeof f.reason !== 'string') return null;
  const since = Date.parse(f.since);
  if (!Number.isFinite(since) || now - since >= FAILED_FOR_MS) return null;
  return { since: f.since, reason: f.reason, by: typeof f.by === 'string' ? f.by : '' };
}

/** Marks it failed, for every agent: `{since, reason, by}`, the reason's first line. */
export function markFailed(id: string, reason: string, by: string, now = Date.now()): void {
  try {
    writeWhole(failedFile(id), { since: new Date(now).toISOString(), reason: reason.replace(/\s*\n[\s\S]*$/, '').slice(0, 300), by });
  } catch {
    // The marker is a courtesy to the others; the request's own error still goes back to the caller.
  }
}

/** A success on it: the marker goes. */
export function clearFailure(id: string): void {
  const f = failedFile(id);
  try {
    if (existsSync(f)) rmSync(f, { force: true });
  } catch {}
}

// ---------------------------------------------------------------- games

/** A card counts as in use by a game while another program keeps one of its 3D engines over this. */
export const GAME_PERCENT = 25;
/** games.json is checked again when it's older than this. */
export const GAMES_FRESH_MS = 15_000;

export interface CardUse {
  busy: boolean;
  percent: number;
  by: string[];
}

export interface Games {
  checkedAt: string;
  cards: Record<string, CardUse>;
}

/** One adapter as DXGI describes it (src/gpu-load.ps1). `luid` is "0x<high>_0x<low>", as the counters name it. */
export interface DxgiAdapter {
  index: number;
  name: string;
  luid: string;
  dedicatedMemory: number;
  vendorId: number;
  software: boolean;
}

/** What src/gpu-load.ps1 prints. */
export interface GpuLoad {
  adapters: DxgiAdapter[];
  /** "<instance>\t<percent>" lines of "GPU Engine(*engtype_3D)\Utilization Percentage". */
  counters: string;
  /** Process names by pid. */
  processes: Record<string, string>;
  /** The desktop window manager's pid. */
  compositor: number | null;
}

export const gamesFile = () => path.join(acceleratorsDir, 'games.json');

/** Windows' own adapters: the Basic Render Driver, the Remote Display Adapter, Hyper-V's. */
const MICROSOFT_VENDOR = 0x1414;

/**
 * The graphics cards as Heiward names them (GpuAdapters.Keyed): Windows' software adapters left out,
 * and a second card of the same name "name #2", in DXGI's order.
 */
export function keyedCards(adapters: DxgiAdapter[]): (DxgiAdapter & { key: string })[] {
  const seen = new Map<string, number>();
  const out: (DxgiAdapter & { key: string })[] = [];
  for (const a of adapters) {
    if (a.software || a.vendorId === MICROSOFT_VENDOR) continue;
    const name = a.name?.trim() ? a.name.trim() : `Graphics card ${a.index + 1}`;
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    out.push({ ...a, name, key: n === 1 ? name : `${name} #${n}` });
  }
  return out;
}

/** What doesn't count as a game: the desktop's compositor, and the manor's own model servers (their startCommands', and the usual ones). */
export function serverNames(accs: Accelerator[]): string[] {
  const names = new Set(['dwm', 'llama-server', 'geniex', 'ollama', 'ollama_llama_server']);
  for (const a of accs) {
    for (const ep of [a.chat, a.vision, a.embed]) {
      const exe = ep?.startCommand?.[0];
      if (exe) names.add(path.win32.basename(exe).replace(/\.exe$/i, '').toLowerCase());
    }
  }
  return [...names];
}

const ENGINE = /^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+_eng_\d+_engtype_3d\s+(-?[\d.]+)\s*$/i;

/**
 * Which configured graphics cards a game is using, from one reading of the counters: per card (by its
 * LUID), each other program's busiest 3D engine; a card is busy while one is over GAME_PERCENT. The
 * desktop's compositor, this process and the manor's own model servers don't count. Cards are matched
 * to accelerators by name (Heiward's), or by the id that name gives.
 */
export function gameCards(load: GpuLoad, accs: Accelerator[], opts: { self?: number; exclude?: string[] } = {}): Record<string, CardUse> {
  const exclude = new Set((opts.exclude ?? serverNames(accs)).map((n) => n.toLowerCase()));
  const self = opts.self ?? process.pid;
  const byLuid = new Map<string, Map<number, number>>();
  for (const line of load.counters.split(/\r?\n/)) {
    const m = ENGINE.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[1]);
    const percent = Number(m[3]);
    if (!pid || pid === self || pid === load.compositor) continue;
    const name = (load.processes[String(pid)] ?? '').replace(/\.exe$/i, '').toLowerCase();
    if (name && exclude.has(name)) continue;
    const luid = m[2].toLowerCase();
    const perPid = byLuid.get(luid) ?? new Map<number, number>();
    perPid.set(pid, Math.max(perPid.get(pid) ?? 0, percent));
    byLuid.set(luid, perPid);
  }
  const cards = keyedCards(load.adapters);
  const out: Record<string, CardUse> = {};
  for (const acc of accs) {
    if (acc.kind !== 'gpu') continue;
    const card = cards.find((c) => c.key.toLowerCase() === acc.name.toLowerCase() || acceleratorId('gpu', c.key) === acc.id);
    if (!card) continue;
    const perPid = [...(byLuid.get(card.luid.toLowerCase()) ?? new Map<number, number>())].sort((a, b) => b[1] - a[1]);
    const over = perPid.filter(([, p]) => p > GAME_PERCENT);
    const exe = (pid: number) => {
      const n = load.processes[String(pid)];
      return n ? (/\.exe$/i.test(n) ? n : `${n}.exe`) : `pid ${pid}`;
    };
    out[acc.id] = { busy: over.length > 0, percent: Math.round(perPid[0]?.[1] ?? 0), by: over.map(([pid]) => exe(pid)) };
  }
  return out;
}

/** games.json, or null when it's absent or unreadable. */
export function readGames(): Games | null {
  const g = readWhole(gamesFile());
  return typeof g?.checkedAt === 'string' && g.cards && typeof g.cards === 'object' ? g : null;
}

/** Whether games.json needs checking again: none, older than 15 s, or from a clock ahead of ours. */
export function gamesStale(g: Games | null, now = Date.now()): boolean {
  if (!g) return true;
  const at = Date.parse(g.checkedAt);
  return !Number.isFinite(at) || now - at > GAMES_FRESH_MS || at - now > GAMES_FRESH_MS;
}

/** Reads the counters with src/gpu-load.ps1 (about 2 s, one of them the sample). */
export async function probeGpuLoad(): Promise<string> {
  return powershell(readFileSync(new URL('./gpu-load.ps1', import.meta.url), 'utf8'), { timeoutMs: 30_000 });
}

let pendingGames: Promise<Games | null> | undefined;

/**
 * Which graphics cards games are using now: games.json while it's under 15 s old, else the counters
 * read again (once, however many requests ask) and games.json rewritten for everyone. Null without a
 * graphics card in the config; a failed check leaves the file as it was.
 */
export async function currentGames(accs: Accelerator[], opts: { now?: number; probe?: () => Promise<string> } = {}): Promise<Games | null> {
  const now = opts.now ?? Date.now();
  const known = readGames();
  if (!accs.some((a) => a.kind === 'gpu' && a.enabled !== false)) return null;
  if (!gamesStale(known, now)) return known;
  pendingGames ??= (opts.probe ?? probeGpuLoad)()
    .then((text) => {
      const load = JSON.parse(text.trim()) as GpuLoad;
      const games: Games = {
        checkedAt: new Date(now).toISOString(),
        cards: gameCards({ adapters: load.adapters ?? [], counters: load.counters ?? '', processes: load.processes ?? {}, compositor: load.compositor ?? null }, accs),
      };
      writeWhole(gamesFile(), games);
      return games;
    })
    .catch(() => known)
    .finally(() => (pendingGames = undefined));
  return pendingGames;
}

// ---------------------------------------------------------------- choosing

/** A background request doesn't join a line with this many already waiting. */
export const MAX_AHEAD = 4;

export interface Need {
  work: Work;
  /** Prompt plus answer, by the kit's pessimistic estimate. */
  tokens: number;
  lane: Lane;
}

export interface Skipped {
  acc: Accelerator;
  why: 'failed' | 'game' | 'deferred';
  detail: string;
}

/**
 * The candidates for a request, in order: they serve its kind, its size fits their cap, they haven't
 * failed in the last 10 minutes (unless every one that would do has: then they all may, as a last
 * resort), a game isn't using them (background work only), and this agent isn't leaving them alone
 * after a line that was too long (`deferredMs`).
 */
export function candidates(
  accs: Accelerator[],
  need: Need,
  state: { failure?: (id: string) => Failure | null; games?: Games | null; deferredMs?: (id: string) => number } = {},
): { list: Accelerator[]; skipped: Skipped[] } {
  const list: Accelerator[] = [];
  const skipped: Skipped[] = [];
  const fitting = accs.filter((acc) => serves(acc, need.work) && need.tokens <= acc.maxContextTokens);
  const failures = new Map(fitting.map((acc) => [acc.id, state.failure?.(acc.id) ?? null]));
  // When every one that would do has failed, they're tried anyway (the last resort, as Reeve does), rather
  // than leaving a PC with only the NPU without model work for ten minutes after one hiccup.
  const lastResort = fitting.length > 0 && fitting.every((acc) => failures.get(acc.id));
  for (const acc of fitting) {
    const failed = lastResort ? null : failures.get(acc.id);
    if (failed) {
      const min = Math.max(1, Math.ceil((Date.parse(failed.since) + FAILED_FOR_MS - Date.now()) / 60_000));
      skipped.push({ acc, why: 'failed', detail: `${theAccelerator(acc)} failed (${failed.reason}); it is tried again in ${min} min` });
      continue;
    }
    const card = acc.kind === 'gpu' && need.lane === 'background' ? state.games?.cards?.[acc.id] : undefined;
    if (card?.busy) {
      skipped.push({ acc, why: 'game', detail: `${theAccelerator(acc)} is in use by ${card.by.join(', ') || 'a game'}` });
      continue;
    }
    const wait = state.deferredMs?.(acc.id) ?? 0;
    if (wait > 0) {
      skipped.push({ acc, why: 'deferred', detail: `work on ${theAccelerator(acc)} resumes in ${Math.ceil(wait / 60_000)} min` });
      continue;
    }
    list.push(acc);
  }
  return { list, skipped };
}

/** An accelerator's lock folders, one per slot: `locks\npu` for the NPU, `locks\<id>`, `<id>.2` … for the others. */
export const lockDirsOf = (acc: { id: string; slots?: number }) => slotDirs(lockDirFor(acc.id), acc.id === 'npu' ? 1 : (acc.slots ?? 1));

/** An accelerator's line, as a request sees it: a slot free now, and how many are waiting ahead of it. */
export interface Look {
  freeSlot: boolean;
  waiting: number;
}

/**
 * Its line on disk (Reeve's lineState), with this process's own tickets replaced by `localWaiting`:
 * its requests already headed there, whether they hold a ticket yet or not.
 */
export function lineLook(acc: Accelerator, localWaiting = 0): Look {
  const dirs = lockDirsOf(acc);
  const s = lineState(dirs);
  const others = readLine(queueDirFor(dirs[0])).filter((t) => t.pid !== process.pid).length;
  return { freeSlot: s.held < s.slots, waiting: others + localWaiting };
}

/**
 * The pick: the first candidate with a free slot and nobody waiting; else the one whose line is
 * shortest, ties by order. A background request that would be fifth or later in every line is
 * deferred; an interactive one always joins.
 */
export function pick(list: Accelerator[], lane: Lane, look: (a: Accelerator) => Look): { acc: Accelerator } | { deferred: string } {
  const looks = list.map((a) => ({ a, l: look(a) }));
  const free = looks.find((x) => x.l.freeSlot && x.l.waiting === 0);
  if (free) return { acc: free.a };
  const shortest = looks.reduce((best, x) => (x.l.waiting < best.l.waiting ? x : best));
  if (lane === 'background' && shortest.l.waiting >= MAX_AHEAD) {
    return { deferred: looks.length === 1 ? `${shortest.l.waiting} already waiting for ${theAccelerator(shortest.a)}` : `every line is full (${looks.map((x) => `${x.l.waiting} waiting for ${theAccelerator(x.a)}`).join(', ')})` };
  }
  return { acc: shortest.a };
}

// ---------------------------------------------------------------- servers

/**
 * The accelerator failed this request: its server won't start within 30 s, refuses the connection,
 * answers 5xx or times out. It is marked failed, and the request goes once to the next candidate.
 */
export class AcceleratorDown extends Error {}

/** The server isn't running and the caller asked not to start it. Not a failure: nothing is marked. */
export class ServerNotRunning extends Error {}

/** How long a server may take to come up after its startCommand. */
export const START_WAIT_MS = 30_000;

/** Whether an endpoint answers, without starting it. */
export async function ping(baseUrl: string, ms = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(ms) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/** %NAME% expanded from the environment, as Windows does (any case); an unknown name stays as it is. */
export function expandEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key && env[key] !== undefined ? env[key]! : whole;
  });
}

const up = new Set<string>();
const starting = new Map<string, Promise<void>>();

/** Forget which servers this process has seen up (tests). */
export function forgetServers(): void {
  up.clear();
}

/**
 * Makes sure an endpoint's server is up: it answers, or it is started from its startCommand (detached,
 * hidden, in the home folder so it never holds an agent's folder, shared by everyone after) and given
 * 30 s to answer. Once per server, however many requests wait on it.
 */
export async function ensureServer(ep: Endpoint, opts: { start?: boolean; waitMs?: number } = {}): Promise<void> {
  if (up.has(ep.baseUrl)) return;
  if (await ping(ep.baseUrl)) {
    up.add(ep.baseUrl);
    return;
  }
  if (opts.start === false) throw new ServerNotRunning(`${ep.baseUrl} isn't running`);
  if (!ep.startCommand?.length) throw new AcceleratorDown(`its server ${ep.baseUrl} isn't running, and Reeve's config has no startCommand for it`);
  let pending = starting.get(ep.baseUrl);
  if (!pending) {
    pending = start(ep, opts.waitMs ?? START_WAIT_MS).finally(() => starting.delete(ep.baseUrl));
    starting.set(ep.baseUrl, pending);
  }
  await pending;
}

async function start(ep: Endpoint, waitMs: number): Promise<void> {
  const [cmd, ...args] = ep.startCommand!.map((a) => expandEnv(a));
  let spawnError: Error | undefined;
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.homedir() });
    child.on('error', (e) => (spawnError = e));
    child.unref();
  } catch (e) {
    spawnError = e as Error;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (spawnError) throw new AcceleratorDown(`couldn't start "${cmd}": ${spawnError.message}`);
    if (await ping(ep.baseUrl, 2000)) {
      up.add(ep.baseUrl);
      return;
    }
  }
  throw new AcceleratorDown(`started "${path.win32.basename(cmd)}" but ${ep.baseUrl} didn't answer within ${Math.round(waitMs / 1000)} s`);
}

/**
 * One POST to a server. Down (AcceleratorDown): no connection, no answer in time, or a 5xx. Any other
 * refusal (a 4xx: a request it won't take) is a plain Error, and says nothing about the accelerator.
 */
export async function postJson(ep: Endpoint, route: string, body: unknown, timeoutMs: number): Promise<{ json: any; ms: number }> {
  const t0 = performance.now();
  const down = (e: any) => {
    up.delete(ep.baseUrl);
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return new AcceleratorDown(timedOut ? `${route} on ${ep.baseUrl} timed out after ${Math.round(timeoutMs / 1000)} s` : `${route} on ${ep.baseUrl} refused the connection (${e?.cause?.code ?? e?.message ?? e})`);
  };
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${ep.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw down(e);
  }
  const ms = Math.round(performance.now() - t0);
  if (res.status >= 500) {
    up.delete(ep.baseUrl);
    throw new AcceleratorDown(`${route} on ${ep.baseUrl} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`the model server said ${res.status}: ${text.slice(0, 300)}`);
  try {
    return { json: JSON.parse(text), ms };
  } catch {
    throw new Error(`the model server's answer wasn't JSON: ${text.slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------- the servers' quirks

const nonce = () => `[req ${Math.random().toString(36).slice(2, 10)}]`;

/** Room the estimate keeps for a nonce and Qwen3's /no_think, whichever accelerator takes the request. */
export const QUIRK_ROOM_CHARS = 40;

/** Qwen3 thinks by default and spends the output budget on it; the 2507 Instruct models don't. */
const thinks = (model: string) => /(^|\/)qwen3(?!\.5)(?!.*instruct-2507)/i.test(model);

/**
 * A chat request at temperature 0, as this accelerator's server needs it. GenieX v0.7.0 leaks state
 * between requests that share a prompt prefix (`prefix-leak`, measured by npu-agent, 2026-09-26): a
 * unique first token stops the reuse.
 */
export function chatBody(acc: Accelerator, ep: Endpoint, messages: ChatMessage[], maxTokens: number): Record<string, unknown> {
  let msgs = messages;
  if (acc.quirks.includes('prefix-leak')) {
    const n = nonce();
    msgs = msgs[0]?.role === 'system' ? [{ ...msgs[0], content: `${n} ${msgs[0].content}` }, ...msgs.slice(1)] : [{ role: 'system', content: n }, ...msgs];
  }
  if (thinks(ep.model)) msgs = msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, content: `${m.content}\n/no_think` } : m));
  return { model: ep.model, messages: msgs, max_tokens: maxTokens, temperature: 0, stream: false };
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

/** A local image as a `data:` URL; a URL is left as it is. */
export function imageUrl(image: string, asPath: boolean): string {
  if (/^(data|https?):/i.test(image)) return image;
  if (asPath) return image.replace(/\\/g, '/');
  const mime = MIME[path.extname(image).toLowerCase()] ?? 'image/png';
  return `data:${mime};base64,${readFileSync(image).toString('base64')}`;
}

/** One question about one image: a local path the server reads itself (`image-path`), else a `data:` URL. */
export function visionBody(acc: Accelerator, ep: Endpoint, image: string, question: string, maxTokens: number): Record<string, unknown> {
  const system = `${acc.quirks.includes('prefix-leak') ? `${nonce()} ` : ''}You answer questions about images briefly and literally.`;
  return {
    model: ep.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl(image, acc.quirks.includes('image-path')) } }, { type: 'text', text: question }] },
    ],
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };
}
