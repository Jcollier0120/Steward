import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceleratorId, type Hardware, readHardware, reeveHome, slug } from './accelerators.ts';
import * as core from './core/index.js';
import { RULES } from './rules.ts';

/**
 * config.json as its owner reads and writes it: the keeper of the model servers (the Smith; Reeve where
 * there is no Smith), and the Settings page that edits it. The manor's accelerators (spec/ACCELERATORS.md)
 * are the NPU, graphics cards and the processor, each behind an OpenAI-compatible model server; this module
 * reads them as written, an old config's single endpoint included, checks them, puts them in the order
 * requests try them, and writes the file.
 *
 * The owner reads config.json as written: a vision endpoint that shares its chat endpoint's server stays
 * without one of its own (endpointFor resolves it), nothing is ordered until asked, and an empty list is just
 * empty, so a Settings page shows and saves what's there. Every other agent reads the same file through
 * accelerators.ts (parseAccelerators), and the kit's tests check the two agree. It was Reeve's
 * src/accelerators.ts and src/settings.ts until kit 2.10.0, when the Smith took the model servers over.
 *
 * **Where the file is.** %USERPROFILE%.reeveconfig.json (REEVE_CONFIG names another; a scratch REEVE_HOME has
 * its own), as before the Smith: every agent's kit already reads it there, so the Smith took over the same
 * file rather than move it. The Smith writes its keys (KEEPER_KEYS), Reeve its own (its repositories, jobs,
 * Foundry Local); each keeps the other's and any it doesn't know, and a save is refused when the file changed
 * since it was read (etagOf).
 */

export { acceleratorId, slug };

export type AcceleratorKind = 'npu' | 'gpu' | 'cpu';
/** What a request asks of a model server. */
export type ServeKind = 'chat' | 'vision' | 'embed';
export const SERVE_KINDS: readonly ServeKind[] = ['chat', 'vision', 'embed'];

/**
 * Per server: `prefix-leak` (GenieX v0.7.0 leaks state between requests that share a prompt prefix,
 * so each request starts with a nonce), `image-path` (the server reads a local image path; otherwise
 * images go as data: URLs).
 */
export const QUIRKS = ['prefix-leak', 'image-path'] as const;
export type Quirk = (typeof QUIRKS)[number];

/** One OpenAI-compatible endpoint: /v1/chat/completions or /v1/embeddings. */
export interface Endpoint {
  /** e.g. http://127.0.0.1:18191. A vision endpoint without one uses its chat endpoint's server. */
  baseUrl?: string;
  model: string;
  /** Starts the server when it isn't running (detached, hidden). `%NAME%` is expanded from the environment. */
  startCommand?: string[];
}

export interface Accelerator {
  /** `npu`, `cpu`, or `gpu-` and the card's name (acceleratorId). */
  id: string;
  kind: AcceleratorKind;
  /** The NPU's or processor's own name; a card's name as DXGI describes it (`… #2` for a second card of the same name). */
  name: string;
  /** A graphics card's own memory; one under 2 GB shares the PC's. */
  memoryGb?: number;
  /** How many requests it serves at once (llama-server's --parallel). The NPU has 1. */
  slots: number;
  /** The most a request may be, prompt and answer, by the pessimistic estimate (chars / 3). */
  maxContextTokens: number;
  chat?: Endpoint;
  vision?: Endpoint;
  embed?: Endpoint;
  quirks: Quirk[];
  /** false keeps it in the list but sends it nothing. */
  enabled?: boolean;
}

export type AcceleratorOrder = 'auto' | string[];

/** The NPU's request cap when config.json names none: an ~8K-token prompt bluescreened the laptop (bug check 0x18B). */
export const DEFAULT_NPU_CAP = 2400;
/** A graphics card counts as having its own memory from this much. */
export const OWN_MEMORY_GB = 2;

const ID = /^(npu|cpu|gpu-[a-z0-9]+(-[a-z0-9]+)*)$/;

export function kindOfId(id: string): AcceleratorKind | null {
  if (!ID.test(id)) return null;
  return id === 'npu' ? 'npu' : id === 'cpu' ? 'cpu' : 'gpu';
}

/** Whether it serves this kind of request: a vision endpoint needs a server, its own or its chat endpoint's. */
export function serves(a: Accelerator, kind: ServeKind): boolean {
  if (a.enabled === false) return false;
  if (kind === 'vision') return !!a.vision?.model && !!(a.vision.baseUrl ?? a.chat?.baseUrl);
  const ep = a[kind];
  return !!ep?.model && !!ep.baseUrl;
}

/** The endpoint a request of this kind goes to; a vision endpoint without a server of its own is on its chat endpoint's. */
export function endpointFor(a: Accelerator, kind: ServeKind): Required<Pick<Endpoint, 'baseUrl' | 'model'>> & Pick<Endpoint, 'startCommand'> {
  const ep = a[kind];
  if (!ep) throw new Error(`${a.id} serves no ${kind}`);
  if (kind === 'vision' && !ep.baseUrl) {
    if (!a.chat?.baseUrl) throw new Error(`${a.id}: vision has no server`);
    return { baseUrl: a.chat.baseUrl, model: ep.model, startCommand: a.chat.startCommand };
  }
  if (!ep.baseUrl) throw new Error(`${a.id}: ${kind} has no baseUrl`);
  return { baseUrl: ep.baseUrl, model: ep.model, startCommand: ep.startCommand };
}

// ------------------------------------------------------------------------------------------------
// Reading

/** What config.json holds about accelerators, as read. */
export interface AcceleratorConfig {
  accelerators: Accelerator[];
  order: AcceleratorOrder;
  /** Read from the old single-endpoint fields (chatEndpoint, visionModel, embedEndpoint). */
  legacy: boolean;
}

type Device = 'Npu' | 'Gpu' | 'Cpu';
interface LegacyEndpoint {
  baseUrl: string;
  model: string;
  device?: Device;
  startCommand?: string[];
  start?: string[] | false;
}

const LEGACY_NAMES: Record<AcceleratorKind, string> = { npu: 'NPU', gpu: 'Graphics card', cpu: 'Processor' };

function deviceKind(device: unknown): AcceleratorKind {
  const d = String(device ?? 'Npu').toLowerCase();
  return d === 'gpu' ? 'gpu' : d === 'cpu' ? 'cpu' : 'npu';
}

/**
 * An old config (chatEndpoint, visionModel, embedEndpoint, npuMaxContextTokens) as accelerators: one
 * per device, `npu` when the device is the NPU. Every request keeps the cap and both GenieX quirks it
 * had, so nothing changes for it. An embed endpoint on another device is an accelerator of its own.
 */
export function legacyAccelerators(raw: Record<string, any>): Accelerator[] {
  const cap = positiveInt(raw?.npuMaxContextTokens) ?? DEFAULT_NPU_CAP;
  const out: Accelerator[] = [];
  const forDevice = (device: unknown): Accelerator => {
    const kind = deviceKind(device);
    let a = out.find((x) => x.kind === kind);
    if (!a) {
      a = { id: acceleratorId(kind, LEGACY_NAMES[kind]), kind, name: LEGACY_NAMES[kind], slots: 1, maxContextTokens: cap, quirks: [] };
      out.push(a);
    }
    return a;
  };
  const chat = raw?.chatEndpoint as LegacyEndpoint | undefined;
  if (chat && typeof chat === 'object' && chat.baseUrl && chat.model) {
    const a = forDevice(chat.device);
    a.chat = { baseUrl: serverBase(chat.baseUrl), model: chat.model, ...(chat.startCommand ? { startCommand: chat.startCommand } : {}) };
    // The old code sent every request with a nonce and every image as a local path.
    a.quirks = ['prefix-leak', 'image-path'];
    if (typeof raw.visionModel === 'string' && raw.visionModel) a.vision = { model: raw.visionModel };
  }
  const embed = raw?.embedEndpoint as LegacyEndpoint | undefined;
  if (embed && typeof embed === 'object' && embed.baseUrl && embed.model) {
    const a = forDevice(embed.device);
    // `start: false` meant never start one; an empty command says the same.
    const start = embed.start === false ? [] : (embed.startCommand ?? embed.start);
    a.embed = { baseUrl: serverBase(embed.baseUrl), model: embed.model, ...(start ? { startCommand: start } : {}) };
  }
  return out;
}

/** A server's address without a trailing `/` or `/v1`: the routes (/v1/chat/completions …) go after it. */
export function serverBase(url: string): string {
  return url.replace(/\/(v1\/?)?$/, '');
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function readEndpoint(v: any): Endpoint | undefined {
  if (!v || typeof v !== 'object' || typeof v.model !== 'string' || !v.model) return undefined;
  const ep: Endpoint = { model: v.model };
  if (typeof v.baseUrl === 'string' && v.baseUrl) ep.baseUrl = serverBase(v.baseUrl);
  if (Array.isArray(v.startCommand)) ep.startCommand = v.startCommand.map(String);
  return ep;
}

/** One entry of `accelerators`, with defaults: one slot, the NPU's cap, no quirks. Unusable entries give null (validateAccelerators says why). */
export function readAccelerator(v: any): Accelerator | null {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string') return null;
  const kind = kindOfId(v.id);
  if (!kind) return null;
  const a: Accelerator = {
    id: v.id,
    kind,
    name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : LEGACY_NAMES[kind],
    slots: kind === 'npu' ? 1 : Math.min(16, positiveInt(v.slots) ?? 1),
    maxContextTokens: positiveInt(v.maxContextTokens) ?? DEFAULT_NPU_CAP,
    quirks: Array.isArray(v.quirks) ? v.quirks.filter((q: unknown): q is Quirk => (QUIRKS as readonly unknown[]).includes(q)) : [],
  };
  if (typeof v.memoryGb === 'number' && v.memoryGb >= 0) a.memoryGb = v.memoryGb;
  for (const k of SERVE_KINDS) {
    const ep = readEndpoint(v[k]);
    if (ep) a[k] = ep;
  }
  if (v.enabled === false) a.enabled = false;
  return a;
}

/**
 * config.json's accelerators and their order. With no `accelerators` list, the old single-endpoint
 * fields are read as accelerators (legacyAccelerators), so an old config keeps working unchanged.
 * Entries that aren't usable are left out (validateAccelerators says what's wrong with them).
 *
 * On a PC known to have no NPU (`hw`, hardware.json), an entry said to be the NPU is read as what the PC has instead,
 * the core's rule (notTheNpu): so the keeper, setup and Settings never call a model on a graphics card the NPU, and
 * the next save writes it as the card's.
 */
export function readAccelerators(raw: Record<string, any> | null | undefined, hw: Hardware | null = readHardware()): AcceleratorConfig {
  const r = raw && typeof raw === 'object' ? raw : {};
  const order: AcceleratorOrder = Array.isArray(r.acceleratorOrder) ? r.acceleratorOrder.filter((x: unknown) => typeof x === 'string') : 'auto';
  if (!Array.isArray(r.accelerators)) return { ...onThisPc(legacyAccelerators(r), order, hw, true), legacy: true };
  const seen = new Set<string>();
  const accelerators: Accelerator[] = [];
  for (const v of r.accelerators) {
    const a = readAccelerator(v);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    accelerators.push(a);
  }
  return { ...onThisPc(accelerators, order, hw, false), legacy: false };
}

/**
 * The list on this PC: an entry said to be the NPU, on a PC known to have none, becomes what it has instead (its one
 * card, the graphics card, or the processor), after the others, merged into a card's own entry of the same id. An
 * old config's GenieX quirks go with it: GenieX runs only on an NPU.
 */
function onThisPc(list: Accelerator[], order: AcceleratorOrder, hw: Hardware | null, legacy: boolean): { accelerators: Accelerator[]; order: AcceleratorOrder } {
  const other = core.instead(hw);
  if (!other || !list.some((a) => a.kind === 'npu')) return { accelerators: list, order };
  const kept = list.filter((a) => a.kind !== 'npu');
  const renamed = new Map<string, string>();
  for (const a of list.filter((x) => x.kind === 'npu')) {
    const name = /^(the\s+)?npu$/i.test(a.name) ? other.name : a.name;
    const id = acceleratorId(other.kind, name);
    renamed.set(a.id, id);
    const memoryGb = a.memoryGb ?? other.memoryGb ?? undefined;
    const moved: Accelerator = { ...a, id, kind: other.kind, name, ...(memoryGb !== undefined ? { memoryGb } : {}), ...(legacy ? { quirks: [] } : {}) };
    const same = kept.find((x) => x.id === id);
    if (same) for (const w of SERVE_KINDS) same[w] ??= moved[w];
    else kept.push(moved);
  }
  return { accelerators: kept, order: order === 'auto' ? order : order.map((id) => renamed.get(id) ?? id) };
}

/**
 * Replaces who serves one kind (REEVE_CHAT_URL, REEVE_EMBED_URL): the kind is taken from every
 * accelerator, then given to the old-style endpoint's accelerator (merged by id, or added first).
 * `null` takes it from all of them (REEVE_EMBED_URL=foundry: Foundry Local's embeddings).
 */
export function overrideEndpoint(list: Accelerator[], kind: 'chat' | 'embed', ep: LegacyEndpoint | null, cap = DEFAULT_NPU_CAP): Accelerator[] {
  const out = list.map((a) => {
    const c = { ...a };
    delete c[kind];
    if (kind === 'chat' && c.vision && !c.vision.baseUrl) delete c.vision; // it was on that chat server
    return c;
  });
  if (!ep) return out;
  const [from] = legacyAccelerators({ [kind === 'chat' ? 'chatEndpoint' : 'embedEndpoint']: ep, npuMaxContextTokens: cap });
  const same = out.find((a) => a.id === from.id);
  if (same) {
    same[kind] = from[kind];
    if (kind === 'chat') same.quirks = [...new Set([...same.quirks, ...from.quirks])];
    return out;
  }
  return [from, ...out];
}

// ------------------------------------------------------------------------------------------------
// Order

/** Ranks for the auto order: the NPU, cards with their own memory, cards that share the PC's memory, the processor (the core's autoOrder). */
function autoRank(a: Accelerator): number {
  if (a.kind === 'gpu') return (a.memoryGb ?? 0) >= OWN_MEMORY_GB ? 1 : 2;
  return a.kind === 'npu' ? 0 : 3;
}

/**
 * The auto order, as the core's: the NPU first, since it does model work without the processor or a graphics
 * card; then graphics cards with 2 GB or more of their own memory, by memory (most first); then graphics that
 * share the PC's memory; then the processor. Ties keep the list's order.
 */
export function autoOrder<T extends Accelerator>(list: T[]): T[] {
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => autoRank(x.a) - autoRank(y.a) || (autoRank(x.a) === 1 ? (y.a.memoryGb ?? 0) - (x.a.memoryGb ?? 0) : 0) || x.i - y.i)
    .map((x) => x.a);
}

/** The accelerators in the order requests try them: `acceleratorOrder`'s ids first, then any it leaves out, in the auto order. */
export function orderAccelerators<T extends Accelerator>(list: T[], order: AcceleratorOrder): T[] {
  if (order === 'auto' || !Array.isArray(order)) return autoOrder(list);
  const byId = new Map(list.map((a) => [a.id, a]));
  const first = [...new Set(order)].map((id) => byId.get(id)).filter((a): a is T => !!a);
  return [...first, ...autoOrder(list.filter((a) => !first.includes(a)))];
}

// ------------------------------------------------------------------------------------------------
// Checking

const isHttpUrl = (s: unknown) => {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** What's wrong with config.json's accelerators and acceleratorOrder, one line each; empty when nothing is. */
export function validateAccelerators(raw: Record<string, any> | null | undefined): string[] {
  const problems: string[] = [];
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = r.accelerators;
  const ids: string[] = [];
  if (list !== undefined && !Array.isArray(list)) problems.push('accelerators must be a list');
  if (Array.isArray(list)) {
    const servers = new Map<string, string>();
    list.forEach((v: any, i: number) => {
      const at = `accelerators[${i}]${v && typeof v.id === 'string' ? ` (${v.id})` : ''}`;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return void problems.push(`${at} must be an object`);
      const kind = typeof v.id === 'string' ? kindOfId(v.id) : null;
      if (!kind) problems.push(`${at}: id must be npu, cpu, or gpu- and the card's name in lowercase with dashes (e.g. gpu-nvidia-geforce-rtx-4090)`);
      else if (ids.includes(v.id)) problems.push(`${at}: id ${v.id} is listed twice`);
      else ids.push(v.id);
      if (v.kind !== undefined && kind && v.kind !== kind) problems.push(`${at}: kind must be ${kind} for id ${v.id}`);
      if (typeof v.name !== 'string' || !v.name.trim()) problems.push(`${at}: name is missing`);
      if (v.slots !== undefined && !(Number.isInteger(v.slots) && v.slots >= 1 && v.slots <= 16)) problems.push(`${at}: slots must be a whole number from 1 to 16`);
      if (kind === 'npu' && v.slots !== undefined && v.slots !== 1) problems.push(`${at}: the NPU serves one request at a time (slots 1)`);
      if (v.maxContextTokens !== undefined && !(Number.isInteger(v.maxContextTokens) && v.maxContextTokens >= 512 && v.maxContextTokens <= 1_048_576))
        problems.push(`${at}: maxContextTokens must be a whole number from 512 to 1048576`);
      if (v.memoryGb !== undefined && !(typeof v.memoryGb === 'number' && v.memoryGb >= 0)) problems.push(`${at}: memoryGb must be a number of GB`);
      if (v.enabled !== undefined && typeof v.enabled !== 'boolean') problems.push(`${at}: enabled must be true or false`);
      if (v.quirks !== undefined && (!Array.isArray(v.quirks) || v.quirks.some((q: unknown) => !(QUIRKS as readonly unknown[]).includes(q))))
        problems.push(`${at}: quirks may only be ${QUIRKS.join(', ')}`);
      for (const k of SERVE_KINDS) {
        const ep = v[k];
        if (ep === undefined || ep === null) continue;
        const where = `${at}.${k}`;
        if (typeof ep !== 'object' || Array.isArray(ep)) {
          problems.push(`${where} must be an object`);
          continue;
        }
        if (typeof ep.model !== 'string' || !ep.model.trim()) problems.push(`${where}: model is missing`);
        if (ep.baseUrl !== undefined && !isHttpUrl(ep.baseUrl)) problems.push(`${where}: baseUrl must be an http:// address, e.g. http://127.0.0.1:18191`);
        if (ep.baseUrl === undefined && k !== 'vision') problems.push(`${where}: baseUrl is missing`);
        if (ep.baseUrl === undefined && k === 'vision' && !v.chat?.baseUrl) problems.push(`${where}: needs a baseUrl, or a chat endpoint whose server it shares`);
        if (ep.startCommand !== undefined && (!Array.isArray(ep.startCommand) || ep.startCommand.some((s: unknown) => typeof s !== 'string' || !s)))
          problems.push(`${where}: startCommand must be a list of words (the program, then its arguments)`);
        if (typeof ep.baseUrl === 'string' && isHttpUrl(ep.baseUrl)) {
          const base = serverBase(ep.baseUrl);
          const other = servers.get(base);
          if (other && !other.startsWith(`${v.id}.`)) problems.push(`${where}: ${base} is also ${other}'s server`);
          servers.set(base, `${v.id}.${k}`);
        }
      }
    });
  }
  const order = r.acceleratorOrder;
  if (order !== undefined && order !== 'auto') {
    if (!Array.isArray(order) || order.some((x: unknown) => typeof x !== 'string')) problems.push('acceleratorOrder must be "auto" or a list of accelerator ids');
    else {
      const known = Array.isArray(list) ? ids : readAccelerators(r).accelerators.map((a) => a.id);
      for (const id of order) if (!known.includes(id)) problems.push(`acceleratorOrder names ${id}, which isn't an accelerator`);
      if (new Set(order).size !== order.length) problems.push('acceleratorOrder names an accelerator twice');
    }
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------
// The file

/** config.json: REEVE_CONFIG, else Reeve's data folder's (REEVE_HOME, else %USERPROFILE%\.reeve), as every agent reads it. */
export const acceleratorConfigFile = (env: NodeJS.ProcessEnv = process.env) => env.REEVE_CONFIG || path.join(env.REEVE_HOME || reeveHome, 'config.json');

/**
 * Where setup puts llama.cpp's servers and the GGUF models, and the keeper its servers' logs: %USERPROFILE%\.reeve
 * (servers\, models\), one per PC whoever keeps them. A scratch REEVE_HOME gets its own.
 */
export const toolsHome = (env: NodeJS.ProcessEnv = process.env) => env.REEVE_HOME || path.join(os.homedir(), '.reeve');

/** config.json's content: {} when there is none, an error when it isn't readable JSON. */
export function readConfigFile(file = acceleratorConfigFile()): { raw: Record<string, any>; exists: boolean; error?: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { raw: {}, exists: false };
  }
  try {
    const raw = JSON.parse(text.replace(/^﻿/, ''));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw: {}, exists: true, error: `${file} doesn't hold a JSON object` };
    return { raw, exists: true };
  } catch (e: any) {
    return { raw: {}, exists: true, error: `${file} isn't valid JSON: ${e?.message ?? e}` };
  }
}

/** The keeper's own settings in config.json, besides the accelerators: how long each may go unused before its servers stop. */
export interface KeeperSettings {
  /** Minutes the NPU may go unused (nobody holding or waiting on its lock) before its servers stop; 0 never. */
  npuIdleStopMinutes: number;
  /** Minutes a graphics card or the processor may go unused before its llama.cpp servers stop; 0 never. */
  gpuIdleStopMinutes: number;
}

/** The keys the keeper owns in config.json: its Settings page writes these and no others. */
export const KEEPER_KEYS = ['accelerators', 'acceleratorOrder', 'npuIdleStopMinutes', 'gpuIdleStopMinutes'] as const;

/** The keeper's numbers, with what each may be. */
export const KEEPER_NUMBERS: Record<keyof KeeperSettings, { min: number; max: number; what: string }> = {
  npuIdleStopMinutes: { min: 0, max: 1440, what: 'minutes the NPU may go unused before its model servers stop (GenieX, and npu-embed exits), to free its memory (0: never)' },
  gpuIdleStopMinutes: { min: 0, max: 1440, what: 'minutes a graphics card or the processor may go unused before its llama.cpp servers stop, to free their memory (0: never)' },
};

/** The keeper's settings in a config.json's content, with the kit's defaults (rules.json's keeper) for any it leaves out or has wrong. */
export function keeperSettings(raw: Record<string, any> | null | undefined): KeeperSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const pick = (k: keyof KeeperSettings) => {
    const v = r[k];
    const rule = KEEPER_NUMBERS[k];
    return Number.isInteger(v) && v >= rule.min && v <= rule.max ? (v as number) : RULES.keeper[k];
  };
  return { npuIdleStopMinutes: pick('npuIdleStopMinutes'), gpuIdleStopMinutes: pick('gpuIdleStopMinutes') };
}

/** What's wrong with the keeper's part of config.json (the accelerators, their order, the idle times), one line each. */
export function validateKeeperConfig(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['config.json must hold one JSON object'];
  const r = raw as Record<string, any>;
  const problems = validateAccelerators(r);
  for (const [key, rule] of Object.entries(KEEPER_NUMBERS)) {
    const v = r[key];
    if (v !== undefined && !(Number.isInteger(v) && v >= rule.min && v <= rule.max)) problems.push(`${key} (${rule.what}) must be a whole number from ${rule.min} to ${rule.max}`);
  }
  return problems;
}

/** A change to config.json: keys to set, keys to take out, and the version the page read. */
export interface ConfigChange {
  /** Top-level keys to set (an object whose key is in `merged` is merged into the file's, so its other keys stay; a null in it removes that key). */
  set?: Record<string, unknown>;
  /** Top-level keys to take out. */
  remove?: string[];
  /** The version the page read (etagOf); a file changed since is refused rather than overwritten. */
  etag?: string;
}

/** A short hash of the file's bytes: what a page read. "" when there's no file. */
export function etagOf(file: string): string {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

/** The file's content with the change applied: unknown keys kept, the `merged` objects merged into the file's. */
export function applyChange(current: Record<string, any>, change: ConfigChange, merged: ReadonlySet<string> = new Set()): Record<string, any> {
  const next: Record<string, any> = { ...current };
  for (const key of change.remove ?? []) delete next[key];
  for (const [key, value] of Object.entries(change.set ?? {})) {
    if (value === undefined) continue;
    if (merged.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const m: Record<string, any> = { ...(current[key] && typeof current[key] === 'object' && !Array.isArray(current[key]) ? current[key] : {}), ...value };
      for (const k of Object.keys(m)) if (m[k] === null) delete m[k];
      if (Object.keys(m).length) next[key] = m;
      else delete next[key];
    } else next[key] = value;
  }
  return next;
}

/** Written whole: a temporary file, then a rename (tried again while Windows refuses it for a moment), so a reader never sees half of it. */
export function writeJsonWhole(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e: any) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Writes config.json whole when `validate` finds nothing wrong; says what's wrong otherwise and writes nothing. */
export function writeConfigFile(file: string, raw: Record<string, any>, validate: (raw: unknown) => string[] = validateKeeperConfig): { problems: string[] } {
  const problems = validate(raw);
  if (problems.length) return { problems };
  writeJsonWhole(file, raw);
  return { problems: [] };
}

export type SaveResult = { ok: true; etag: string; config: Record<string, any> } | { ok: false; status: 400 | 409; problems: string[] };

/**
 * One save from a Settings page: refused when the file changed since the page read it, isn't readable, or the
 * result doesn't validate. `only` (the keeper's KEEPER_KEYS, say) refuses a change to any other key.
 */
export function saveConfig(file: string, change: ConfigChange, o: { validate?: (raw: unknown) => string[]; merged?: ReadonlySet<string>; only?: readonly string[] } = {}): SaveResult {
  if (!change || typeof change !== 'object' || (change.set !== undefined && (typeof change.set !== 'object' || change.set === null || Array.isArray(change.set))) || (change.remove !== undefined && !Array.isArray(change.remove)))
    return { ok: false, status: 400, problems: ['a change is { set: {...}, remove: [...] }'] };
  if (o.only) {
    const other = [...Object.keys(change.set ?? {}), ...(change.remove ?? [])].filter((k) => !o.only!.includes(k));
    if (other.length) return { ok: false, status: 400, problems: [`only ${o.only.join(', ')} are changed here, not ${other.join(', ')}`] };
  }
  const now = etagOf(file);
  if (change.etag !== undefined && change.etag !== now) return { ok: false, status: 409, problems: ['config.json changed since this page read it: reload the page and make the change again'] };
  const read = readConfigFile(file);
  if (read.error) return { ok: false, status: 409, problems: [`${read.error}; it isn't overwritten. Fix it or move it aside, then reload.`] };
  const next = applyChange(read.raw, change, o.merged);
  const { problems } = writeConfigFile(file, next, o.validate ?? validateKeeperConfig);
  if (problems.length) return { ok: false, status: 400, problems };
  return { ok: true, etag: etagOf(file), config: next };
}

/** The configured accelerators in the order requests try them, as the owner reads them (disabled ones too): the list, or an old config's fields. */
export function configuredAccelerators(raw: Record<string, any>): Accelerator[] {
  const read = readAccelerators(raw);
  return orderAccelerators(read.accelerators, read.order);
}
