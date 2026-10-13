import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AcceleratorEntry, Quirk, ServeKind } from './accelerator-config.ts';

/**
 * The NPU on every Copilot+ PC (spec/NPU-VENDORS.md): which maker's NPU this is and which generation, whether the
 * manor can run models on it, and the model server, models, port, caps and timeouts for it, all from the spec's
 * npu-vendors.json. Qualcomm's Hexagon runs GenieX; Intel's NPU OpenVINO Model Server; AMD's XDNA 2 FastFlowLM. Each
 * is an OpenAI-compatible server behind the kit's usual contract (ACCELERATORS.md), so nothing past setup knows which.
 *
 * Detection is modelled on Heiward's NpuHardware.cs: the devices Windows lists as Neural processors (the
 * ComputeAccelerator class), told apart by maker and name; the generation by the part number in the name (Qualcomm)
 * or the PCI device id (Intel, AMD). Everything here is pure or takes its outside world as arguments, so tests run on
 * fixtures; setup.ts does the downloading.
 */

export type NpuVendor = 'qualcomm' | 'intel' | 'amd';
export const NPU_VENDORS: readonly NpuVendor[] = ['qualcomm', 'intel', 'amd'];

export interface NpuModel {
  /** The id requests name (the server's model name), and the one pulled. */
  id: string;
  kinds: ServeKind[];
  /** The server program's arguments that download it (placeholders expanded). */
  pull: string[];
  /** A file that is there once it's downloaded, when the server keeps it in a known place. */
  present?: string;
  /** About how much it downloads, in bytes. */
  size: number;
  licence: string;
  /**
   * Per generation: the files a pull leaves, each with its size and SHA-256, checked after the pull. `*` is every
   * generation the route takes, for a model that is the same file on each (OpenVINO's, compiled on the PC itself).
   */
  pinned?: Record<string, { dir: string; files: Record<string, { size: number; sha256: string }> }>;
}

export interface NpuRoute {
  server: string;
  version: string;
  arch: 'arm64' | 'x64';
  /**
   * Each generation; its own driverMin, where one needs a later driver than the route's, and its own starting values
   * where it differs from the generation the route was measured on (routeFor): timeouts, caps, and server arguments.
   */
  generations: Record<string, NpuGeneration>;
  /**
   * What the NPU's models hold of the PC's memory while they're loaded, in GB, per kind (measured; the NPU shares the
   * PC's memory): setup leaves a kind off the NPU on a PC that hasn't room for it beside everything else (npuMemoryFit).
   */
  memoryGb?: Partial<Record<ServeKind, number>>;
  driverMin?: string;
  /** A runtime its programs need that its download doesn't carry, put beside its program (OpenVINO Model Server's C++ runtime). */
  runtime?: NpuRuntime;
  download: { file: string; url: string; size: number; sha256: string };
  install: { kind: 'inno'; args: string[]; exe: string } | { kind: 'zip'; into: string; exe: string };
  port: number;
  /** Where its OpenAI routes start, when not at the root (OpenVINO Model Server's /v3). */
  baseUrlPath?: string;
  serve: string[];
  /** What its server's environment needs (OpenVINO Model Server's PYTHONHOME and PATH): {tools} is filled in, `%NAME%` kept for when it starts. */
  env?: Record<string, string>;
  models: NpuModel[];
  maxContextTokens: number;
  caps: Partial<Record<ServeKind, number>>;
  timeouts: { requestBaseMs?: number; requestPerTokenMs?: number; coldLoadMs?: number };
  quirks: Quirk[];
  /** The keeper restarts it when it holds too much (GenieX's kept memory). */
  recycle: boolean;
  embeddings?: string;
  /** Its embeddings' own server, when the route's server serves none (GenieX's): set up and started beside it. */
  embedServer?: NpuEmbedServer;
  vision?: string;
  licence: string;
  notes: string;
}

/** One generation of a maker's NPU. */
export interface NpuGeneration {
  label: string;
  supported: boolean;
  /** Its server and models have run on this generation (the NPU check passed on one). */
  verified: boolean;
  why?: string;
  driverMin?: string;
  /** Its own starting timeouts, over the route's (a slower NPU's), until setup measures the PC's own. */
  timeouts?: NpuRoute['timeouts'];
  /** Its own cap (with the server argument that compiles it, in `args`). */
  maxContextTokens?: number;
  caps?: NpuRoute['caps'];
  /** Server arguments that differ on it: each flag's value in the route's `serve` replaced (OpenVINO's --max_prompt_len). */
  args?: Record<string, string>;
  /** What its models hold of the PC's memory, where it differs from the route's (a shorter compiled prompt holds less). */
  memoryGb?: NpuRoute['memoryGb'];
  /** Why its values are what they are, in a sentence. */
  basis?: string;
}

/**
 * A runtime a server's programs import and its download leaves out: a zip of the maker's own (Microsoft's CRT package
 * from Visual Studio's catalog), pinned by size and SHA-256, whose `files` in `from` setup copies beside the server's
 * program. Windows loads a DLL from the program's own folder first, so nothing is installed for the whole PC and no
 * administrator is asked.
 */
export interface NpuRuntime {
  what: string;
  file: string;
  url: string;
  size: number;
  sha256: string;
  /** The folder in the zip that holds `files`. */
  from: string;
  files: string[];
}

/**
 * An NPU's embedding server of its own, on its own port, serving /v1/embeddings in the NPU's turn like every NPU
 * request. Qualcomm's is llama.cpp's llama-server of the very build GenieX carries, over GenieX's own libraries, its
 * Hexagon backend and Qualcomm's signed HTP libraries among them, so nothing unsigned runs on the NPU: its zip is
 * unpacked into `into`, the route's server's `overlay` files are copied over it, and its model is downloaded as a file.
 * Intel's is a second OpenVINO Model Server, the route's own program (no `download`), whose model it pulls as it pulls
 * the chat model: one process serves one task when started from the command line.
 */
export interface NpuEmbedServer {
  server: string;
  version: string;
  /** Its zip; none when it is the route's own program, started a second time (its environment the route's too). */
  download?: { file: string; url: string; size: number; sha256: string };
  /** The folder its zip is unpacked into. */
  into?: string;
  exe?: string;
  /** Files of the route's server copied over the unpacked ones (whenever they differ from what's there). */
  overlay?: { from: string; files: string[] };
  port: number;
  /** Its arguments: {port}, {file} (the model's path), {model} (the model's id) and {tools} filled in. */
  serve: string[];
  /**
   * What its environment needs ({tools} filled in): the Hexagon loads its HTP library through FastRPC, which looks in
   * ADSP_LIBRARY_PATH or the working folder, and the keeper starts servers in the home folder.
   */
  env?: Record<string, string>;
  /** Its model; `dims`, its vectors' length, is checked by setup's test (embedSanity). */
  model: (NpuEmbedFile | NpuEmbedPull) & { dims?: number };
  licence: string;
}

/** An embedding model downloaded as a file into the tools home's models folder (where setup puts the graphics card's): the same file, so the same index. */
export interface NpuEmbedFile {
  id: string;
  file: string;
  url: string;
  size: number;
  sha256: string;
  licence: string;
}

/** An embedding model the route's own program pulls, as it pulls the chat model, checked against its pinned files. */
export type NpuEmbedPull = Omit<NpuModel, 'kinds'>;

/** Whether the embedding server's model is pulled by the route's program (else it's a file downloaded). */
export const isPulled = (m: NpuEmbedServer['model']): m is NpuEmbedPull => 'pull' in m;

export interface NpuCatalog {
  routes: Record<NpuVendor, NpuRoute>;
  /** PCI device ids (4 hex digits, upper case) to generations, for the makers whose name doesn't say it. */
  devices: Partial<Record<NpuVendor, Record<string, string>>>;
}

/** The spec's npu-vendors.json, as the node part brings it. */
export const NPU_CATALOG: NpuCatalog = JSON.parse(readFileSync(new URL('./spec/npu-vendors.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));

// ------------------------------------------------------------------------------------------------
// Which NPU

/** One NPU as Windows lists it (DETECT_PS' npu line). */
export interface NpuDevice {
  /** Its name as Windows gives it, (R) and (TM) and all. */
  device: string;
  manufacturer: string;
  /** Its PnP device id: `PCI\VEN_8086&DEV_643E&…`, `ACPI\VEN_QCOM&DEV_0FF0&…`. */
  deviceId: string;
  driver: string;
  driverDate: string;
}

/** What the manor can do with an NPU. */
export interface NpuSupport {
  vendor: NpuVendor | null;
  /** npu-vendors.json's generation id (`snapdragon-x2`, `lunar-lake`, `xdna2`), when known. */
  generation: string | null;
  /** The generation in words ("Core Ultra 200V, Lunar Lake (NPU 4)"), or the maker's name. */
  label: string;
  /** Setup can install its model server, and requests can use it. */
  supported: boolean;
  /** Why not, in a clause, when it isn't. */
  why?: string;
  /** Its server and the generation have run on real hardware (npu-vendors.json's `verified`). */
  verified: boolean;
}

/** The maker an NPU's manufacturer and name point to, as Heiward's NpuHardware.Classify: Qualcomm (or Hexagon), Intel, AMD. */
export function npuVendorOf(manufacturer: string | null | undefined, name: string | null | undefined): NpuVendor | null {
  const s = `${manufacturer ?? ''} ${name ?? ''}`;
  if (/qualcomm|hexagon/i.test(s)) return 'qualcomm';
  if (/intel/i.test(s)) return 'intel';
  if (/advanced micro devices|\bamd\b/i.test(s)) return 'amd';
  return null;
}

/** The PCI device id in a PnP device id (`…&DEV_643E&…`), upper case; null when it has none. */
export const pciDevice = (deviceId: string) => /DEV_([0-9A-F]{4})/i.exec(deviceId)?.[1]?.toUpperCase() ?? null;

/**
 * Which generation: a Snapdragon by its part number or name (X1E/X1P or "X Elite"/"X Plus" are the first, X2E/X2P or
 * "X2 Elite"/"X2 Plus" the second), Intel and AMD by their PCI device id (npu-vendors.json's `devices`). Null when
 * it's none setup knows.
 */
export function npuGeneration(vendor: NpuVendor, dev: Pick<NpuDevice, 'device' | 'deviceId'>, catalog: NpuCatalog = NPU_CATALOG): string | null {
  if (vendor === 'qualcomm') {
    if (/\bX2[EP]\d|\bX2 (Elite|Plus)\b/i.test(dev.device)) return 'snapdragon-x2';
    if (/\bX1[EP]\d|\bX (Elite|Plus)\b/i.test(dev.device)) return 'snapdragon-x';
    return null;
  }
  const id = pciDevice(dev.deviceId);
  return (id && catalog.devices[vendor]?.[id]) || null;
}

/** Compares dotted version numbers (a driver's): negative, 0 or positive, as a before, the same as, or after b. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((n) => Number(n) || 0);
  const y = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const MAKERS: Record<NpuVendor, string> = { qualcomm: 'Qualcomm', intel: 'Intel', amd: 'AMD' };

/**
 * What the manor can do with this NPU on this PC (its processor's `arch`): its maker and generation, and whether its
 * server can be set up here. An NPU it doesn't know, a generation without a server (AMD's first XDNA), a driver older
 * than the server needs, or the wrong processor for the server's build (an Arm64-only server on x64) is unsupported,
 * and says why plainly; its work then goes to the graphics card or the processor.
 */
export function npuSupport(dev: NpuDevice, arch: string, catalog: NpuCatalog = NPU_CATALOG): NpuSupport {
  const vendor = npuVendorOf(dev.manufacturer, dev.device);
  if (!vendor) return { vendor: null, generation: null, label: dev.device || 'NPU', supported: false, verified: false, why: `the NPU "${dev.device || dev.deviceId}" is from a maker setup doesn't know yet (Qualcomm, Intel and AMD are)` };
  const route = catalog.routes[vendor];
  const generation = npuGeneration(vendor, dev, catalog);
  const gen = generation ? route.generations[generation] : undefined;
  const base = { vendor, generation, label: gen?.label ?? `${MAKERS[vendor]} NPU`, verified: !!gen?.verified };
  if (!gen) return { ...base, supported: false, why: `this ${MAKERS[vendor]} NPU ("${dev.device}"${pciDevice(dev.deviceId) ? `, device ${pciDevice(dev.deviceId)}` : ''}) isn't one setup knows yet` };
  if (!gen.supported) return { ...base, supported: false, why: `the ${gen.label} NPU can't run the manor's models: ${gen.why ?? 'no model server supports it'}` };
  if (arch && route.arch !== arch) return { ...base, supported: false, why: `${route.server} runs on ${route.arch} Windows, and this PC is ${arch}` };
  const driverMin = gen.driverMin ?? route.driverMin;
  if (driverMin && dev.driver && compareVersions(dev.driver, driverMin) < 0)
    return { ...base, supported: false, why: `the NPU's driver needs an update: ${route.server} needs ${MAKERS[vendor]}'s NPU driver ${driverMin} or later${gen.driverMin ? ` on the ${gen.label}` : ''}, and this PC has ${dev.driver}: update the driver from ${MAKERS[vendor]} or the PC's maker, then run setup again` };
  return { ...base, supported: true };
}

// ------------------------------------------------------------------------------------------------
// Its server, as setup installs it

/** Placeholders and %VARS% in a route's paths and arguments: {tools}, {port}, {model}, {file}, %LOCALAPPDATA%, %USERPROFILE%. */
export function expandRoute(s: string, v: { tools: string; port?: number; model?: string; file?: string; env?: Record<string, string | undefined> }): string {
  const env = v.env ?? process.env;
  return s
    .replace(/\{tools\}/g, v.tools)
    .replace(/\{port\}/g, String(v.port ?? ''))
    .replace(/\{model\}/g, v.model ?? '')
    .replace(/\{file\}/g, v.file ?? '')
    .replace(/%([^%]+)%/g, (whole, name: string) => {
      const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
      if (key && env[key] !== undefined) return env[key]!;
      if (name.toLowerCase() === 'localappdata') return path.join(os.homedir(), 'AppData', 'Local');
      if (name.toLowerCase() === 'userprofile') return os.homedir();
      return whole;
    });
}

/** A route's server environment with {tools} filled in; each `%NAME%` stays, for the starter to expand (accelerators.ts' serverEnv). */
export function routeEnv(route: NpuRoute, tools: string, keep: (p: string) => string = (p) => p): Record<string, string> | undefined {
  if (!route.env) return undefined;
  return Object.fromEntries(Object.entries(route.env).map(([k, v]) => [k, v.includes('{tools}') ? v.replace(/\{tools\}/g, tools).split(';').map(keep).join(';') : v]));
}

/** The program a route runs, where it is installed (or will be). */
export const serverExe = (route: NpuRoute, tools: string, env?: Record<string, string | undefined>) => expandRoute(route.install.exe, { tools, env });

/** The chat model's id, the one the server starts with. */
const firstModel = (route: NpuRoute, kind: ServeKind) => route.models.find((m) => m.kinds.includes(kind));

/** What the NPU serves with this route: its server's models' kinds, and embed when it has an embedding server of its own. */
export const npuKinds = (route: NpuRoute): ServeKind[] =>
  (['chat', 'vision', 'embed'] as ServeKind[]).filter((k) => route.models.some((m) => m.kinds.includes(k)) || (k === 'embed' && !!route.embedServer));

/**
 * Where a route's embedding server and its model are, once set up: its own folder and program, or the route's when it
 * has no download of its own; its model's file, or the file that is there once its pull is (`present`).
 */
export function embedPaths(route: NpuRoute, tools: string, env?: Record<string, string | undefined>): { folder: string; exe: string; model: string } {
  const es = route.embedServer!;
  const exe = es.download && es.exe ? expandRoute(es.exe, { tools, env }) : serverExe(route, tools, env);
  const folder = es.download && es.into ? expandRoute(es.into, { tools, env }) : path.dirname(exe);
  const m = es.model;
  return { folder, exe, model: isPulled(m) ? (m.present ? expandRoute(m.present, { tools, env }) : '') : path.join(tools, 'models', m.file) };
}

/**
 * The config.json entry for the NPU on this route: one server on its port, chat and every other kind it serves, the
 * route's caps (per kind where they differ), its own timeouts, quirks. A kind on the chat model's server shares it
 * (no baseUrl of its own); its startCommand starts it with the chat model. `exe` is written as setup found it. The
 * route's embedding server, when it has one and `embed` says where setup put it, is the embed endpoint, on its own port.
 */
export function npuEntry(route: NpuRoute, o: { tools: string; exe: string; port?: number; portable?: (p: string) => string; embed?: { exe: string; model: string } }): AcceleratorEntry {
  const port = o.port ?? route.port;
  const keep = o.portable ?? ((p: string) => p);
  const chat = firstModel(route, 'chat');
  if (!chat) throw new Error(`${route.server}: no chat model`);
  const baseUrl = `http://127.0.0.1:${port}${route.baseUrlPath ?? ''}`;
  const startCommand = [keep(o.exe), ...route.serve.map((a) => {
    const x = expandRoute(a, { tools: o.tools, port, model: chat.id });
    return a.includes('{tools}') ? keep(x) : x;
  })];
  const cap = (k: ServeKind) => (route.caps[k] && route.caps[k] !== route.maxContextTokens ? { maxContextTokens: route.caps[k] } : {});
  const env = routeEnv(route, o.tools, keep);
  const server = { startCommand, ...(env ? { env } : {}) };
  const e: AcceleratorEntry = { id: 'npu', kind: 'npu', slots: 1, maxContextTokens: route.maxContextTokens, quirks: [...route.quirks] };
  e.chat = { baseUrl, model: chat.id, ...server, ...cap('chat') };
  for (const k of ['vision', 'embed'] as const) {
    const m = firstModel(route, k);
    if (m) e[k] = { model: m.id, ...cap(k), ...(k === 'embed' ? { baseUrl, ...server } : {}) };
  }
  const es = route.embedServer;
  if (es && o.embed && !e.embed) {
    const args = es.serve.map((a) => {
      const x = expandRoute(a, { tools: o.tools, port: es.port, model: es.model.id, file: o.embed!.model });
      return a.includes('{file}') || a.includes('{tools}') ? keep(x) : x;
    });
    // The route's own program, started a second time, needs the route's environment as the first does.
    const own = es.env ? Object.fromEntries(Object.entries(es.env).map(([k, v]) => [k, v.includes('{tools}') ? keep(v.replace(/\{tools\}/g, o.tools)) : v])) : {};
    const all = { ...(es.download ? {} : env ?? {}), ...own };
    const embedEnv = Object.keys(all).length ? all : undefined;
    e.embed = { baseUrl: `http://127.0.0.1:${es.port}`, model: es.model.id, startCommand: [keep(o.embed.exe), ...args], ...(embedEnv ? { env: embedEnv } : {}), ...cap('embed') };
  }
  if (Object.keys(route.timeouts).length) e.timeouts = { ...route.timeouts };
  return e;
}

/** Whether a configured NPU entry runs this route's server (its chat endpoint's program). */
export function runsRoute(entry: { chat?: { startCommand?: string[] } } | undefined, route: NpuRoute, tools: string): boolean {
  const exe = entry?.chat?.startCommand?.[0];
  if (!exe) return false;
  return path.win32.basename(expandRoute(exe, { tools })).toLowerCase() === path.win32.basename(serverExe(route, tools)).toLowerCase();
}

// ------------------------------------------------------------------------------------------------
// Per generation, memory and calibration

/**
 * The route as it runs on one generation: the generation's own timeouts, caps and server arguments over the route's
 * (Meteor Lake's NPU 3720, about a quarter of Lunar Lake's speed, gets more time and a shorter compiled prompt). The
 * route itself when the generation has none, or isn't known.
 */
export function routeFor(route: NpuRoute, generation: string | null | undefined): NpuRoute {
  const g = generation ? route.generations[generation] : undefined;
  if (!g || (!g.timeouts && !g.caps && !g.maxContextTokens && !g.args && !g.memoryGb)) return route;
  const serve = [...route.serve];
  for (const [flag, value] of Object.entries(g.args ?? {})) {
    const i = serve.indexOf(flag);
    if (i >= 0) serve[i + 1] = value;
  }
  return { ...route, serve, maxContextTokens: g.maxContextTokens ?? route.maxContextTokens, caps: { ...route.caps, ...g.caps }, timeouts: { ...route.timeouts, ...g.timeouts }, ...(route.memoryGb || g.memoryGb ? { memoryGb: { ...route.memoryGb, ...g.memoryGb } } : {}) };
}

/**
 * The share of the PC's memory the NPU's models may hold: the NPU has no memory of its own (Intel's, AMD's and
 * Qualcomm's share the PC's), and Windows, the browser and the manor's agents need the rest. On a 16 GB PC that is
 * 6.4 GB, room for Intel's chat (4.27 GB) and embeddings (1.74 GB) with 9.6 GB left; a 12 GB PC keeps chat alone; an
 * 8 GB PC (some Meteor Lake laptops) keeps the NPU out, and the processor or the card takes its work.
 */
export const NPU_MEMORY_SHARE = 0.4;

/** Whether the route's chat, and its embeddings beside it, fit in this PC's memory (route.memoryGb): yes when unmeasured or unknown. */
export function npuMemoryFit(route: NpuRoute, ramBytes: number | null | undefined): { chat: boolean; embed: boolean; budgetGb: number; why?: string } {
  const ramGb = (ramBytes ?? 0) / 1024 ** 3;
  const budgetGb = Math.round(ramGb * NPU_MEMORY_SHARE * 10) / 10;
  const m = route.memoryGb;
  if (!m || !ramGb) return { chat: true, embed: true, budgetGb };
  const chatGb = m.chat ?? 0;
  const embedGb = m.embed ?? 0;
  const ram = `this PC's ${Math.round(ramGb)} GB of memory`;
  if (chatGb > budgetGb) return { chat: false, embed: false, budgetGb, why: `${ram} hasn't room for the NPU's chat model (${chatGb} GB) beside everything else` };
  if (chatGb + embedGb > budgetGb) return { chat: true, embed: false, budgetGb, why: `${ram} hasn't room for the NPU's embedding model (${embedGb} GB) beside its chat model` };
  return { chat: true, embed: true, budgetGb };
}

/** What setup measured on the NPU: the first start to an answer (its compile included), a short answer warm, and writing speed. */
export interface NpuMeasured {
  coldMs: number;
  warmMs: number;
  tokensPerSecond: number;
}

/**
 * Calibration's bounds: an NPU writing under 2 tokens a second is too slow for the chat model (a 300-token answer
 * would take minutes), and no timeout grows past these, whatever was measured.
 */
export const CALIBRATION = { minTokensPerSecond: 2, maxPerTokenMs: 1_500, maxBaseMs: 180_000, maxColdLoadMs: 30 * 60_000, readPerWrite: 10 };

const roundUpTo = (n: number, step: number) => Math.ceil(n / step) * step;

/**
 * This PC's timeouts from what setup measured on its NPU, for a generation nobody has measured (npu-check's rules,
 * from two requests rather than its dozen): a token's time twice what writing one took; a background request's base
 * twice a full-cap read (reading taken as 10 times writing: about 27 times on the Lunar Lake, 650–750 read and 24–28
 * written a second, and nearer 12 expected on the NPU 3720, whose compute falls further than its memory bandwidth)
 * and a warm answer; a cold load half again the first start's. Never under the route's starting values (a busy moment
 * doesn't shrink them), never over CALIBRATION's bounds; too slow when it writes under minTokensPerSecond.
 */
export function calibrate(m: NpuMeasured, route: Pick<NpuRoute, 'maxContextTokens' | 'timeouts'>): { timeouts: Required<NpuRoute['timeouts']>; tooSlow?: string } {
  const tps = Math.max(0.01, m.tokensPerSecond);
  const guess = route.timeouts;
  const perToken = roundUpTo((1000 / tps) * 2, 50);
  const base = roundUpTo(((route.maxContextTokens / (tps * CALIBRATION.readPerWrite)) * 1000 + m.warmMs) * 2, 5_000);
  const cold = roundUpTo(m.coldMs * 1.5, 30_000);
  const timeouts = {
    requestBaseMs: Math.min(CALIBRATION.maxBaseMs, Math.max(guess.requestBaseMs ?? 0, base)),
    requestPerTokenMs: Math.min(CALIBRATION.maxPerTokenMs, Math.max(guess.requestPerTokenMs ?? 0, perToken)),
    coldLoadMs: Math.min(CALIBRATION.maxColdLoadMs, Math.max(guess.coldLoadMs ?? 0, cold)),
  };
  return m.tokensPerSecond < CALIBRATION.minTokensPerSecond
    ? { timeouts, tooSlow: `it wrote ${m.tokensPerSecond.toFixed(1)} tokens a second, under the ${CALIBRATION.minTokensPerSecond} the chat model needs` }
    : { timeouts };
}

// ------------------------------------------------------------------------------------------------
// The plan for the NPU

export interface NpuDownload {
  what: string;
  url: string;
  size: number;
  sha256: string;
  dest: string;
  have: boolean;
}

export interface NpuPlan {
  vendor: NpuVendor;
  route: NpuRoute;
  support: NpuSupport;
  exe: string;
  /** The server's program is already where it installs. */
  installed: boolean;
  /** Its installer or zip, unless it's installed. */
  download: NpuDownload | null;
  /** Each model it pulls, and whether it is already here (unknown counts as not). */
  models: (NpuModel & { have: boolean })[];
  port: number;
  kinds: ServeKind[];
  /** The runtime to put beside the server's program, when the route needs one and a file of it isn't there yet. */
  runtime: (NpuRuntime & { dest: string; into: string }) | null;
  /**
   * The route's embedding server, when it has one: where it goes, and its zip and model unless they're here (its
   * model downloaded as a file, or pulled by the route's program: the arguments that pull it).
   */
  embed: (ReturnType<typeof embedPaths> & { server: NpuEmbedServer; download: NpuDownload | null; modelDownload: NpuDownload | null; modelPull: string[] | null }) | null;
  /** Bytes still to download: the server's, its runtime's and the models', the embedding server's included. */
  downloadBytes: number;
}

/**
 * What setting the NPU up would do on this route: install the server unless it's there, put its runtime beside it
 * unless every file is there (a server installed before the runtime was carried gets it too), pull the models that
 * aren't, and how much that downloads. Nothing is downloaded.
 */
export function planNpu(o: {
  support: NpuSupport;
  tools: string;
  downloadsDir: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  catalog?: NpuCatalog;
  port?: number;
  /** Leave its embeddings off the NPU (too little memory for them beside its chat: npuMemoryFit). */
  noEmbed?: boolean;
}): NpuPlan | null {
  if (!o.support.supported || !o.support.vendor) return null;
  const exists = o.exists ?? existsSync;
  // The generation's own starting values (routeFor); its embedding server left out when asked.
  const generic = routeFor((o.catalog ?? NPU_CATALOG).routes[o.support.vendor], o.support.generation);
  const route: NpuRoute = o.noEmbed ? { ...generic, embedServer: undefined, models: generic.models.filter((m) => !(m.kinds.length === 1 && m.kinds[0] === 'embed')) } : generic;
  const exe = serverExe(route, o.tools, o.env);
  const installed = exists(exe);
  const dest = path.join(o.downloadsDir, route.download.file);
  const download = installed ? null : { what: route.download.file, url: route.download.url, size: route.download.size, sha256: route.download.sha256, dest, have: false };
  const models = route.models.map((m) => {
    const present = m.present ? expandRoute(m.present, { tools: o.tools, env: o.env }) : '';
    return { ...m, pull: m.pull.map((a) => expandRoute(a, { tools: o.tools, model: m.id, env: o.env })), have: !!present && exists(present) };
  });
  const into = path.dirname(exe);
  const rt = route.runtime;
  const runtime = rt && !(installed && rt.files.every((f) => exists(path.join(into, f)))) ? { ...rt, dest: path.join(o.downloadsDir, rt.file), into } : null;
  const es = route.embedServer;
  let embed: NpuPlan['embed'] = null;
  if (es) {
    const p = embedPaths(route, o.tools, o.env);
    const zip = !es.download || exists(p.exe) ? null : { what: es.download.file, url: es.download.url, size: es.download.size, sha256: es.download.sha256, dest: path.join(o.downloadsDir, es.download.file), have: false };
    const m = es.model;
    const here = !!p.model && exists(p.model);
    const model = isPulled(m) || here ? null : { what: m.file, url: m.url, size: m.size, sha256: m.sha256, dest: p.model, have: false };
    const pull = isPulled(m) && !here ? m.pull.map((a) => expandRoute(a, { tools: o.tools, model: m.id, env: o.env })) : null;
    embed = { ...p, server: es, download: zip, modelDownload: model, modelPull: pull };
  }
  const downloadBytes =
    (download ? download.size : 0) +
    (runtime ? runtime.size : 0) +
    models.filter((m) => !m.have).reduce((n, m) => n + m.size, 0) +
    (embed?.download?.size ?? 0) +
    (embed?.modelDownload?.size ?? 0) +
    (embed?.modelPull ? embed.server.model.size : 0);
  return { vendor: o.support.vendor, route, support: o.support, exe, installed, download, runtime, models, port: o.port ?? route.port, kinds: npuKinds(route), embed, downloadBytes };
}

// ------------------------------------------------------------------------------------------------
// Doing it

/** Runs a program and gives its exit code and output; never throws. `env` is its whole environment. */
export function runProgram(exe: string, args: string[], o: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) =>
    execFile(exe, args, { windowsHide: true, timeout: o.timeoutMs ?? 60 * 60_000, cwd: o.cwd ?? os.homedir(), env: o.env ?? process.env, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) =>
      resolve({ code: e ? (typeof (e as any).code === 'number' ? (e as any).code : null) : 0, out: `${stdout ?? ''}${stderr ?? ''}` }),
    ),
  );
}

/** A file's SHA-256, read in chunks. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Checks a pulled model's files against their pinned sizes and SHA-256s, for this generation (a model compiled for
 * the NPU is a different build on each), else for every generation (`*`). Empty when they all match, or none are
 * pinned for it.
 */
export async function checkPinned(m: Pick<NpuModel, 'id' | 'pinned'>, generation: string | null, o: { tools: string; env?: Record<string, string | undefined>; hash?: (f: string) => Promise<string> } ): Promise<string[]> {
  const pin = (generation ? m.pinned?.[generation] : undefined) ?? m.pinned?.['*'];
  if (!pin) return [];
  const dir = expandRoute(pin.dir, { tools: o.tools, env: o.env });
  const problems: string[] = [];
  for (const [name, want] of Object.entries(pin.files)) {
    const f = path.join(dir, name);
    let size = -1;
    try {
      size = statSync(f).size;
    } catch {}
    if (size !== want.size) {
      problems.push(`${m.id}: ${name} is ${size < 0 ? 'missing' : `${size} bytes, not ${want.size}`}`);
      continue;
    }
    const sum = await (o.hash ?? sha256File)(f);
    if (sum !== want.sha256) problems.push(`${m.id}: ${name}'s SHA-256 ${sum} isn't the pinned ${want.sha256}`);
  }
  return problems;
}

/** A 32×32 red PNG, for the vision test. */
const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IydHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJI2YD1ZaHIvAAAAAElFTkSuQmCC', 'base64');

/** Where setup writes the vision test's picture. */
export function testImage(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'npu-vision-test.png');
  writeFileSync(f, TEST_PNG);
  return f;
}
