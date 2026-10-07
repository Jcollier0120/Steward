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
  /** Per generation: the files a pull leaves, each with its size and SHA-256, checked after the pull. */
  pinned?: Record<string, { dir: string; files: Record<string, { size: number; sha256: string }> }>;
}

export interface NpuRoute {
  server: string;
  version: string;
  arch: 'arm64' | 'x64';
  generations: Record<string, { label: string; supported: boolean; verified: boolean; why?: string }>;
  driverMin?: string;
  requires?: string[];
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
  vision?: string;
  licence: string;
  notes: string;
}

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
  if (route.driverMin && dev.driver && compareVersions(dev.driver, route.driverMin) < 0)
    return { ...base, supported: false, why: `${route.server} needs ${MAKERS[vendor]}'s NPU driver ${route.driverMin} or later, and this PC has ${dev.driver}: update the driver from ${MAKERS[vendor]} or the PC's maker, then run setup again` };
  return { ...base, supported: true };
}

// ------------------------------------------------------------------------------------------------
// Its server, as setup installs it

/** Placeholders and %VARS% in a route's paths and arguments: {tools}, {port}, {model}, %LOCALAPPDATA%, %USERPROFILE%. */
export function expandRoute(s: string, v: { tools: string; port?: number; model?: string; env?: Record<string, string | undefined> }): string {
  const env = v.env ?? process.env;
  return s
    .replace(/\{tools\}/g, v.tools)
    .replace(/\{port\}/g, String(v.port ?? ''))
    .replace(/\{model\}/g, v.model ?? '')
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

/** What the NPU serves with this route. */
export const npuKinds = (route: NpuRoute): ServeKind[] => (['chat', 'vision', 'embed'] as ServeKind[]).filter((k) => route.models.some((m) => m.kinds.includes(k)));

/**
 * The config.json entry for the NPU on this route: one server on its port, chat and every other kind it serves, the
 * route's caps (per kind where they differ), its own timeouts, quirks. A kind on the chat model's server shares it
 * (no baseUrl of its own); its startCommand starts it with the chat model. `exe` is written as setup found it.
 */
export function npuEntry(route: NpuRoute, o: { tools: string; exe: string; port?: number; portable?: (p: string) => string }): AcceleratorEntry {
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
  /** Bytes still to download: the server's and the models'. */
  downloadBytes: number;
  /** What this PC lacks that the server needs and setup can't install without an administrator. */
  missing: string[];
}

/** The Visual C++ runtime OpenVINO Model Server needs, by its DLL in System32. */
export function hasVcRedist(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): boolean {
  const sys = path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32');
  return ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'].every((f) => exists(path.join(sys, f)));
}

const REQUIREMENTS: Record<string, { has: (env: Record<string, string | undefined>, exists: (p: string) => boolean) => boolean; say: string }> = {
  'vcredist-x64': {
    has: hasVcRedist,
    say: "the Microsoft Visual C++ Redistributable (x64), which an administrator installs once from Microsoft (https://aka.ms/vs/17/release/vc_redist.x64.exe), then run setup again",
  },
};

/**
 * What setting the NPU up would do on this route: install the server unless it's there, pull the models that aren't,
 * and how much that downloads. Nothing is downloaded.
 */
export function planNpu(o: {
  support: NpuSupport;
  tools: string;
  downloadsDir: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  catalog?: NpuCatalog;
  port?: number;
}): NpuPlan | null {
  if (!o.support.supported || !o.support.vendor) return null;
  const exists = o.exists ?? existsSync;
  const route = (o.catalog ?? NPU_CATALOG).routes[o.support.vendor];
  const exe = serverExe(route, o.tools, o.env);
  const installed = exists(exe);
  const dest = path.join(o.downloadsDir, route.download.file);
  const download = installed ? null : { what: route.download.file, url: route.download.url, size: route.download.size, sha256: route.download.sha256, dest, have: false };
  const models = route.models.map((m) => {
    const present = m.present ? expandRoute(m.present, { tools: o.tools, env: o.env }) : '';
    return { ...m, pull: m.pull.map((a) => expandRoute(a, { tools: o.tools, model: m.id, env: o.env })), have: !!present && exists(present) };
  });
  const missing = (route.requires ?? []).filter((r) => REQUIREMENTS[r] && !REQUIREMENTS[r].has(o.env ?? process.env, exists)).map((r) => REQUIREMENTS[r].say);
  const downloadBytes = (download ? download.size : 0) + models.filter((m) => !m.have).reduce((n, m) => n + m.size, 0);
  return { vendor: o.support.vendor, route, support: o.support, exe, installed, download, models, port: o.port ?? route.port, kinds: npuKinds(route), downloadBytes, missing };
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
 * the NPU is a different build on each). Empty when they all match, or none are pinned for it.
 */
export async function checkPinned(m: NpuModel, generation: string | null, o: { tools: string; env?: Record<string, string | undefined>; hash?: (f: string) => Promise<string> } ): Promise<string[]> {
  const pin = generation ? m.pinned?.[generation] : undefined;
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
