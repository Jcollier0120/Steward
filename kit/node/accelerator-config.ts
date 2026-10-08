import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceleratorConfigFile, acceleratorId, acceleratorsHome, type Hardware, legacyConfigFile, readableConfigFile, readHardware, slug } from './accelerators.ts';
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
/** What a request asks of a model server: the work the core routes. */
export type ServeKind = 'chat' | 'vision' | 'embed';
export const SERVE_KINDS: readonly ServeKind[] = ['chat', 'vision', 'embed'];

/**
 * Every endpoint an accelerator may have: the routed work, and `rerank` (kit 2.41.0), a reranker's /v1/rerank (llama.cpp's
 * --reranking), an add-on only the agents that ask for it use (Reeve's search). Kept apart from ServeKind so an agent's
 * code that handles each routed kind needs no change for it.
 */
export type EndpointKind = ServeKind | 'rerank';
export const ENDPOINT_KINDS: readonly EndpointKind[] = [...SERVE_KINDS, 'rerank'];

/**
 * Per server: `prefix-leak` (GenieX v0.7.0 leaks state between requests that share a prompt prefix,
 * so each request starts with a nonce), `image-path` (the server reads a local image path; otherwise
 * images go as data: URLs).
 */
export const QUIRKS = ['prefix-leak', 'image-path'] as const;
export type Quirk = (typeof QUIRKS)[number];

/** One OpenAI-compatible endpoint: /v1/chat/completions, /v1/embeddings, or a reranker's /v1/rerank. */
export interface Endpoint {
  /** e.g. http://127.0.0.1:18191. A vision endpoint without one uses its chat endpoint's server. */
  baseUrl?: string;
  model: string;
  /** Starts the server when it isn't running (detached, hidden). `%NAME%` is expanded from the environment. */
  startCommand?: string[];
  /** This kind's own request cap, when it differs from its accelerator's (the core's capFor). */
  maxContextTokens?: number;
  /** What its server's environment needs besides the starter's (OpenVINO Model Server's PYTHONHOME and PATH); `%NAME%` is expanded. */
  env?: Record<string, string>;
}

/** An accelerator's own request timings, over rules.json's (the core's requestTimeoutMs): a slower NPU's. */
export interface Timeouts {
  requestBaseMs?: number;
  requestPerTokenMs?: number;
  coldLoadMs?: number;
}
export const TIMEOUT_KEYS = ['requestBaseMs', 'requestPerTokenMs', 'coldLoadMs'] as const;

export interface Accelerator {
  /** `npu`, `cpu`, or `gpu-` and the card's name (acceleratorId). */
  id: string;
  kind: AcceleratorKind;
  /**
   * What this PC calls it (hardware.json, the core's acceleratorName): the NPU's name as Windows lists it, a card's
   * as DXGI describes it (`… #2` for a second card of the same name), the processor's own. Never read from
   * config.json nor written to it: a `name` an older file carries is ignored, and dropped when the file is next
   * written (withoutNames).
   */
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
  /** A reranker (kit 2.41.0), set up only when asked for (accelerators setup --serve rerank). */
  rerank?: Endpoint;
  quirks: Quirk[];
  /** false keeps it in the list but sends it nothing. */
  enabled?: boolean;
  /** Its own request timings, when its server needs other than the rules' (setup writes an NPU's from npu-vendors.json). */
  timeouts?: Timeouts;
}

/** An accelerator as config.json keeps it: everything but its name, which comes from the PC. */
export type AcceleratorEntry = Omit<Accelerator, 'name'>;

/** An accelerator as config.json keeps it: without its name. */
export function entryOf(a: Accelerator | AcceleratorEntry): AcceleratorEntry {
  const { name: _name, ...entry } = a as Accelerator;
  return entry;
}

/**
 * config.json's content with no `name` in any of its accelerators: a name isn't kept there (it comes from the PC), so
 * an older file's are dropped when it's next written. Everything else is as it was.
 */
export function withoutNames(raw: Record<string, any>): Record<string, any> {
  if (!Array.isArray(raw?.accelerators) || !raw.accelerators.some((v: any) => v && typeof v === 'object' && 'name' in v)) return raw;
  return { ...raw, accelerators: raw.accelerators.map((v: any) => (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v ? entryOf(v) : v)) };
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
export function serves(a: Accelerator, kind: EndpointKind): boolean {
  if (a.enabled === false) return false;
  if (kind === 'vision') return !!a.vision?.model && !!(a.vision.baseUrl ?? a.chat?.baseUrl);
  const ep = a[kind];
  return !!ep?.model && !!ep.baseUrl;
}

/** The endpoint a request of this kind goes to; a vision endpoint without a server of its own is on its chat endpoint's. */
export function endpointFor(a: Accelerator, kind: EndpointKind): Required<Pick<Endpoint, 'baseUrl' | 'model'>> & Pick<Endpoint, 'startCommand' | 'env'> {
  const ep = a[kind];
  if (!ep) throw new Error(`${a.id} serves no ${kind}`);
  if (kind === 'vision' && !ep.baseUrl) {
    if (!a.chat?.baseUrl) throw new Error(`${a.id}: vision has no server`);
    return { baseUrl: a.chat.baseUrl, model: ep.model, startCommand: a.chat.startCommand, ...(a.chat.env ? { env: a.chat.env } : {}) };
  }
  if (!ep.baseUrl) throw new Error(`${a.id}: ${kind} has no baseUrl`);
  return { baseUrl: ep.baseUrl, model: ep.model, startCommand: ep.startCommand, ...(ep.env ? { env: ep.env } : {}) };
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

const LEGACY_NAMES: Readonly<Record<AcceleratorKind, string>> = core.LEGACY_NAMES;

function deviceKind(device: unknown): AcceleratorKind {
  const d = String(device ?? 'Npu').toLowerCase();
  return d === 'gpu' ? 'gpu' : d === 'cpu' ? 'cpu' : 'npu';
}

/**
 * An old config (chatEndpoint, visionModel, embedEndpoint, npuMaxContextTokens) as accelerators: one
 * per device, `npu` when the device is the NPU. Every request keeps the cap and both GenieX quirks it
 * had, so nothing changes for it. An embed endpoint on another device is an accelerator of its own. Each is named
 * from this PC (`hw`, hardware.json), as a listed one is: the kind's name without it.
 */
export function legacyAccelerators(raw: Record<string, any>, hw: Hardware | null = null): Accelerator[] {
  const cap = positiveInt(raw?.npuMaxContextTokens) ?? DEFAULT_NPU_CAP;
  const out: Accelerator[] = [];
  const forDevice = (device: unknown): Accelerator => {
    const kind = deviceKind(device);
    let a = out.find((x) => x.kind === kind);
    if (!a) {
      const id = acceleratorId(kind, LEGACY_NAMES[kind]);
      a = { id, kind, name: core.acceleratorName(kind, id, hw), slots: 1, maxContextTokens: cap, quirks: [] };
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
  if (v.env && typeof v.env === 'object' && !Array.isArray(v.env)) {
    const env = Object.fromEntries(Object.entries(v.env).filter(([k, x]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof x === 'string')) as Record<string, string>;
    if (Object.keys(env).length) ep.env = env;
  }
  const cap = positiveInt(v.maxContextTokens);
  if (cap) ep.maxContextTokens = cap;
  return ep;
}

/**
 * One entry of `accelerators`, with defaults: one slot, the NPU's cap, no quirks. Its name is what this PC calls it
 * (`hw`, hardware.json; the kind's name without it), never the entry's own `name`, which is ignored. Unusable entries
 * give null (validateAccelerators says why).
 */
export function readAccelerator(v: any, hw: Hardware | null = null): Accelerator | null {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string') return null;
  const kind = kindOfId(v.id);
  if (!kind) return null;
  const a: Accelerator = {
    id: v.id,
    kind,
    name: core.acceleratorName(kind, v.id, hw),
    slots: kind === 'npu' ? 1 : Math.min(16, positiveInt(v.slots) ?? 1),
    maxContextTokens: positiveInt(v.maxContextTokens) ?? DEFAULT_NPU_CAP,
    quirks: Array.isArray(v.quirks) ? v.quirks.filter((q: unknown): q is Quirk => (QUIRKS as readonly unknown[]).includes(q)) : [],
  };
  if (typeof v.memoryGb === 'number' && v.memoryGb >= 0) a.memoryGb = v.memoryGb;
  for (const k of ENDPOINT_KINDS) {
    const ep = readEndpoint(v[k]);
    if (ep) a[k] = ep;
  }
  if (v.enabled === false) a.enabled = false;
  if (v.timeouts && typeof v.timeouts === 'object' && !Array.isArray(v.timeouts)) {
    const t: Timeouts = {};
    for (const k of TIMEOUT_KEYS) if (Number.isInteger(v.timeouts[k]) && v.timeouts[k] >= 0) t[k] = v.timeouts[k];
    if (Object.keys(t).length) a.timeouts = t;
  }
  return a;
}

/**
 * config.json's accelerators and their order. With no `accelerators` list, the old single-endpoint
 * fields are read as accelerators (legacyAccelerators), so an old config keeps working unchanged.
 * Entries that aren't usable are left out (validateAccelerators says what's wrong with them).
 *
 * On a PC known to have no NPU (`hw`, hardware.json), an entry said to be the NPU is read as what the PC has instead,
 * the core's rule (notTheNpu): so the keeper, setup and Settings never call a model on a graphics card the NPU, and
 * the next save writes it as the card's. Every accelerator is named from `hw` too (readAccelerator).
 */
export function readAccelerators(raw: Record<string, any> | null | undefined, hw: Hardware | null = readHardware()): AcceleratorConfig {
  const r = raw && typeof raw === 'object' ? raw : {};
  const order: AcceleratorOrder = Array.isArray(r.acceleratorOrder) ? r.acceleratorOrder.filter((x: unknown) => typeof x === 'string') : 'auto';
  if (!Array.isArray(r.accelerators)) return { ...onThisPc(legacyAccelerators(r, hw), order, hw, true), legacy: true };
  const seen = new Set<string>();
  const accelerators: Accelerator[] = [];
  for (const v of r.accelerators) {
    const a = readAccelerator(v, hw);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    accelerators.push(a);
  }
  return { ...onThisPc(accelerators, order, hw, false), legacy: false };
}

/**
 * The list on this PC: an entry said to be the NPU, on a PC known to have none, becomes what it has instead (its one
 * card, the graphics card, or the processor), by its name and id, after the others, merged into a card's own entry of
 * the same id. An old config's GenieX quirks go with it: GenieX runs only on an NPU.
 */
function onThisPc(list: Accelerator[], order: AcceleratorOrder, hw: Hardware | null, legacy: boolean): { accelerators: Accelerator[]; order: AcceleratorOrder } {
  const other = core.instead(hw);
  if (!other || !list.some((a) => a.kind === 'npu')) return { accelerators: list, order };
  const kept = list.filter((a) => a.kind !== 'npu');
  const renamed = new Map<string, string>();
  for (const a of list.filter((x) => x.kind === 'npu')) {
    const id = acceleratorId(other.kind, other.name);
    const name = core.acceleratorName(other.kind, id, hw);
    renamed.set(a.id, id);
    const memoryGb = a.memoryGb ?? other.memoryGb ?? undefined;
    const moved: Accelerator = { ...a, id, kind: other.kind, name, ...(memoryGb !== undefined ? { memoryGb } : {}), ...(legacy ? { quirks: [] } : {}) };
    const same = kept.find((x) => x.id === id);
    if (same) for (const w of ENDPOINT_KINDS) same[w] ??= moved[w];
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
      if (v.slots !== undefined && !(Number.isInteger(v.slots) && v.slots >= 1 && v.slots <= 16)) problems.push(`${at}: slots must be a whole number from 1 to 16`);
      if (kind === 'npu' && v.slots !== undefined && v.slots !== 1) problems.push(`${at}: the NPU serves one request at a time (slots 1)`);
      if (v.maxContextTokens !== undefined && !(Number.isInteger(v.maxContextTokens) && v.maxContextTokens >= 512 && v.maxContextTokens <= 1_048_576))
        problems.push(`${at}: maxContextTokens must be a whole number from 512 to 1048576`);
      if (v.memoryGb !== undefined && !(typeof v.memoryGb === 'number' && v.memoryGb >= 0)) problems.push(`${at}: memoryGb must be a number of GB`);
      if (v.enabled !== undefined && typeof v.enabled !== 'boolean') problems.push(`${at}: enabled must be true or false`);
      if (v.quirks !== undefined && (!Array.isArray(v.quirks) || v.quirks.some((q: unknown) => !(QUIRKS as readonly unknown[]).includes(q))))
        problems.push(`${at}: quirks may only be ${QUIRKS.join(', ')}`);
      if (v.timeouts !== undefined) {
        const t = v.timeouts;
        if (!t || typeof t !== 'object' || Array.isArray(t)) problems.push(`${at}: timeouts must be an object (${TIMEOUT_KEYS.join(', ')})`);
        else
          for (const k of Object.keys(t))
            if (!(TIMEOUT_KEYS as readonly string[]).includes(k) || !(Number.isInteger(t[k]) && t[k] >= 0 && t[k] <= 3_600_000)) problems.push(`${at}: timeouts.${k} must be one of ${TIMEOUT_KEYS.join(', ')}, a whole number of ms up to an hour`);
      }
      for (const k of ENDPOINT_KINDS) {
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
        if (ep.env !== undefined && (!ep.env || typeof ep.env !== 'object' || Array.isArray(ep.env) || Object.entries(ep.env).some(([k, x]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof x !== 'string')))
          problems.push(`${where}: env must be an object of names to text (its server's environment)`);
        if (ep.maxContextTokens !== undefined && !(Number.isInteger(ep.maxContextTokens) && ep.maxContextTokens >= 512 && ep.maxContextTokens <= 1_048_576))
          problems.push(`${where}: maxContextTokens must be a whole number from 512 to 1048576`);
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

export { acceleratorConfigFile, acceleratorsHome, legacyConfigFile, readableConfigFile };

/**
 * Where setup puts the model servers (llama.cpp's builds, and an NPU's server where it is installed into a folder of
 * ours) and the models, and the keeper its servers' logs: the accelerators' folder (acceleratorsHome,
 * %USERPROFILE%\.manor\accelerators) since kit 2.31.0, servers\ and models\ in it. A PC set up before keeps
 * %USERPROFILE%\.reeve, where its builds and models already are, so nothing is downloaded twice and its config's
 * startCommands stay right. A scratch REEVE_HOME gets its own, as before.
 */
export function toolsHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.REEVE_HOME) return env.REEVE_HOME;
  if (env.ACCELERATORS_HOME || env.MANOR_HOME) return acceleratorsHome(env);
  const reeve = path.join(home, '.reeve');
  if (existsSync(path.join(reeve, 'servers')) || existsSync(path.join(reeve, 'models'))) return reeve;
  return acceleratorsHome(env);
}

/**
 * The keys that are the accelerators' and move with them to their own config.json: the keeper's (KEEPER_KEYS), an
 * older config's single endpoint and its cap, and the request timeout every agent reads.
 */
export const ACCELERATOR_KEYS = ['accelerators', 'acceleratorOrder', 'npuIdleStopMinutes', 'gpuIdleStopMinutes', 'chatEndpoint', 'visionModel', 'embedEndpoint', 'npuMaxContextTokens', 'requestTimeoutMs'] as const;

/**
 * Moves the accelerators to their own config.json (kit 2.31.0), once: when it doesn't exist yet and Reeve's older
 * config.json has any of their keys (ACCELERATOR_KEYS), it is written with a copy of them, and `movedFrom` saying
 * where from. Reeve's file is never changed, so nothing that works today stops working: an agent with an older kit
 * still reads its accelerators there, and the keeper mirrors each later change back (writeConfigFile). Null when
 * there was nothing to move.
 */
export function migrateAcceleratorConfig(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), now = new Date()): { file: string; from: string; keys: string[] } | null {
  const file = acceleratorConfigFile(env);
  if (existsSync(file)) return null;
  const from = legacyConfigFile(env, home);
  if (!from) return null;
  const old = readJsonObject(from);
  if (!old.raw) return null;
  const keys = ACCELERATOR_KEYS.filter((k) => old.raw![k] !== undefined);
  if (!keys.length) return null;
  const moved: Record<string, any> = Object.fromEntries(keys.map((k) => [k, old.raw![k]]));
  writeJsonWhole(file, withoutNames({ ...moved, movedFrom: from, movedAt: now.toISOString() }));
  return { file, from, keys };
}

/**
 * The keeper's keys written back into Reeve's older config.json, when it is there beside the accelerators' own: an
 * agent with a kit before 2.31.0 (and Reeve before it moves) reads its accelerators there until it updates. Every other
 * key in Reeve's file stays as it is; nothing is written when nothing changed. False when there was nothing to mirror.
 */
export function mirrorToLegacy(raw: Record<string, any>, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): boolean {
  const legacy = legacyConfigFile(env, home);
  if (!legacy) return false;
  const old = readJsonObject(legacy);
  if (!old.raw) return false;
  const next: Record<string, any> = { ...old.raw };
  for (const k of KEEPER_KEYS) {
    if (raw[k] === undefined) delete next[k];
    else next[k] = raw[k];
  }
  const out = withoutNames(next);
  if (JSON.stringify(out) === JSON.stringify(old.raw)) return false;
  writeJsonWhole(legacy, out);
  return true;
}

function readJsonObject(file: string): { raw?: Record<string, any> } {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { raw } : {};
  } catch {
    return {};
  }
}

const isOwnFile = (file: string, env: NodeJS.ProcessEnv = process.env) => path.resolve(file).toLowerCase() === path.resolve(acceleratorConfigFile(env)).toLowerCase();

/**
 * config.json's content: {} when there is none, an error when it isn't readable JSON. The accelerators' own file is
 * first moved from Reeve's older one when it isn't there yet (migrateAcceleratorConfig), so the keeper and its
 * Settings page always read and write the same file.
 */
export function readConfigFile(file = acceleratorConfigFile()): { raw: Record<string, any>; exists: boolean; error?: string } {
  let text: string;
  if (!existsSync(file) && isOwnFile(file)) {
    try {
      migrateAcceleratorConfig();
    } catch {
      // Not moved this time: read as none, and the next read tries again.
    }
  }
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

/**
 * Writes config.json whole when `validate` finds nothing wrong; says what's wrong otherwise and writes nothing. No
 * accelerator's `name` is written (withoutNames): an older file's go at its next write. The accelerators' own file's
 * keeper keys are mirrored into Reeve's older config.json when it is there (mirrorToLegacy), for the agents that
 * still read them there.
 */
export function writeConfigFile(file: string, raw: Record<string, any>, validate: (raw: unknown) => string[] = validateKeeperConfig): { problems: string[] } {
  const problems = validate(raw);
  if (problems.length) return { problems };
  writeJsonWhole(file, withoutNames(raw));
  if (isOwnFile(file)) {
    try {
      mirrorToLegacy(raw);
    } catch {
      // A courtesy to older agents: the accelerators' own file is written either way.
    }
  }
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
  const next = withoutNames(applyChange(read.raw, change, o.merged));
  const { problems } = writeConfigFile(file, next, o.validate ?? validateKeeperConfig);
  if (problems.length) return { ok: false, status: 400, problems };
  return { ok: true, etag: etagOf(file), config: next };
}

/** The configured accelerators in the order requests try them, as the owner reads them (disabled ones too): the list, or an old config's fields. */
export function configuredAccelerators(raw: Record<string, any>): Accelerator[] {
  const read = readAccelerators(raw);
  return orderAccelerators(read.accelerators, read.order);
}
