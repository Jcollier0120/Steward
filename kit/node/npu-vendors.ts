import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AcceleratorEntry, OWN_MEMORY_GB, type Quirk, type ServeKind } from './accelerator-config.ts';

/**
 * The NPU on every Copilot+ PC (spec/NPU-VENDORS.md): which maker's NPU this is and which generation, whether the
 * manor can run models on it, and the model server, models, port, caps and timeouts for it, all from the spec's
 * npu-vendors.json. Qualcomm's Hexagon runs GenieX; Intel's NPU OpenVINO Model Server; AMD's XDNA 2 FastFlowLM. Each
 * is an OpenAI-compatible server behind the kit's usual contract (ACCELERATORS.md), so nothing past setup knows which.
 *
 * Detection is modelled on Heiward's NpuHardware.cs: the devices Windows lists as Neural processors (the
 * ComputeAccelerator class), told apart by maker and name; the generation by the part number in the name (Qualcomm,
 * else its ACPI device id) or the PCI device id (Intel, AMD). Everything here is pure or takes its outside world as arguments, so tests run on
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
  /**
   * Server arguments it needs beside the route's `serve`, added to the server's command when it is the chat model (the
   * one the server starts with): GenieX 0.8.0's llama.cpp models' `--compute npu --vit-compute GPUOpenCL`, which its
   * QAIRT models mustn't get. A later server version may want others (NpuServerVersion's `serve`).
   */
  serve?: string[];
  /**
   * The most tokens a picture may be, where its server reads a picture at its own size, a token per 32 × 32 px (GenieX's
   * llama.cpp plugin, the X2's Qwen3-VL-2B): written as its vision endpoint's pictureTokens, so the kit redraws a larger
   * picture to fit (fitPicture) and counts each picture so. A model whose server sizes pictures itself has none.
   */
  pictureTokens?: number;
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
  /**
   * The server's version the route pins: what setup installs, with `download`, where its generation pins none of its own
   * (`serverPin`: pinnedRoute). On a PC, the version installed there (atVersion), which routeFor runs as that version runs.
   */
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
  /**
   * How its program says which version of it is installed: its arguments, and a pattern whose first group is the
   * version (installedVersion). GenieX's `geniex version --skip-update` answers in about 60 ms.
   */
  versionCommand?: { args: string[]; pattern: string };
  /** What later versions of its server change, for a PC that runs one (NpuServerVersion). */
  versions?: NpuServerVersion[];
  port: number;
  /** Where its OpenAI routes start, when not at the root (OpenVINO Model Server's /v3). */
  baseUrlPath?: string;
  serve: string[];
  /** What its server's environment needs (OpenVINO Model Server's PYTHONHOME and PATH): {tools} is filled in, `%NAME%` kept for when it starts. */
  env?: Record<string, string>;
  /**
   * The variable its server takes the most tokens a picture may be from, set to its vision model's `pictureTokens`
   * (GenieX's GENIEX_IMAGE_MAX_TOKENS, which only Castellan's patched plugin reads: pluginPatch), so a picture that
   * didn't come through the kit's fitPicture is scaled down too, rather than overflowing the window.
   */
  pictureTokensEnv?: string;
  models: NpuModel[];
  maxContextTokens: number;
  caps: Partial<Record<ServeKind, number>>;
  timeouts: { requestBaseMs?: number; requestPerTokenMs?: number; coldLoadMs?: number };
  /**
   * How many times faster its server reads a prompt than it writes, measured and rounded down: calibrate's estimate of
   * a full-cap read on a generation nobody has measured. CALIBRATION.readPerWrite where the route gives none.
   */
  readPerWrite?: number;
  quirks: Quirk[];
  /** The keeper restarts it when it holds too much (GenieX's kept memory). */
  recycle: boolean;
  /** How soon the keeper stops its servers on a PC with little memory, per kind, and why (npuIdleStopMinutes). */
  idleStop?: NpuRouteIdleStop;
  /** The maker's program its server runs to set the NPU's power mode, checked by setup and npu-check (checkPowerTool). */
  powerTool?: NpuPowerTool;
  embeddings?: string;
  /** Its embeddings' own server, when the route's server serves none (GenieX's): set up and started beside it. */
  embedServer?: NpuEmbedServer;
  vision?: string;
  licence: string;
  notes: string;
}

/** A generation's speed from its owners' reports: on `pcs` PCs that passed, the median writing speed and cold start. */
export interface NpuMeasuredSpeeds {
  pcs: number;
  server: string;
  model: string;
  tokensPerSecond: number;
  coldStartS: number;
  /** The day the Exchequer counted them. */
  at: string;
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
  /**
   * Its embedding server's arguments that differ on it, the same way in `embedServer.serve`: the NPU 3720's runs on the
   * processor's graphics (`--target_device GPU`), which embeds a query in 50 ms against its NPU's 1.1 s.
   */
  embedArgs?: Record<string, string>;
  /** What its models hold of the PC's memory, where it differs from the route's (a shorter compiled prompt holds less). */
  memoryGb?: NpuRoute['memoryGb'];
  /** Why its values are what they are, in a sentence. */
  basis?: string;
  /**
   * The models it runs instead of the route's, on every PC of the generation whatever its memory: the Snapdragon X2's
   * Qwen3-VL-2B, its pictures on the Adreno with GenieX 0.8.0 and on the Hexagon with 0.9, where the first-generation X
   * keeps the route's 4B. routeFor puts them in the route's place.
   */
  models?: NpuModel[];
  /**
   * The models it runs instead of its own (or the route's) on a PC with little memory (smallPc: under
   * idleStop.smallPcGb), and why. routeFor puts them in the route's place when it's told the PC is small. No generation
   * has any now: the X2's 2B, a small X2's alone in kit 2.78.0, is every X2's (`models`).
   */
  smallPc?: { models: NpuModel[]; basis: string };
  /**
   * Its speed as its owners' reports measured it (npu-reports.ts, spec/NPU-REPORTS.md), for the website: the medians
   * of the PCs that passed, on the server and model named. Only while those are the route's does the site show it.
   */
  measured?: NpuMeasuredSpeeds;
  /** A Snapdragon's Hexagon version (`v73`, `v81`): the code llama.cpp's Hexagon backend runs on it (GGML_HEXAGON_ARCH, when played). */
  hexagonArch?: string;
  /** The chip Qualcomm AI Hub builds its models for (`qualcomm-snapdragon-x-elite`): GenieX's config.json chipset, when played. */
  aiHubChipset?: string;
  /**
   * A build of one of its server's own files the kit carries in its place (npu-patch.ts): the X2's GenieX llama.cpp plugin,
   * for the route's pinned version. A later version's is in the route's `versions` (pluginPatchOf).
   */
  pluginPatch?: NpuPluginPatch;
  /**
   * Its own pinned version of the route's server, in the route's place (pinnedRoute): what setup installs on it, and
   * what it runs where the PC's own can't be asked. The Snapdragon X2's GenieX 0.9.1, which reads its pictures on the
   * Hexagon, where the first-generation X keeps the route's 0.8.0. A PC that has another version runs that one.
   */
  serverPin?: { version: string; download: NpuRoute['download']; basis: string };
}

/**
 * What a later version of a route's server changes, from `version` on until the next one listed. The route's own
 * `version` (or its generation's `serverPin`) is what setup installs; this is how a PC runs a later one: the Smith's try of
 * it, the entry its Use it writes, the keeper's refresh, setup and the checks on a PC where it is installed
 * (installedVersion), and a generation that pins it.
 * routeFor applies the newest at or before the route's version. GenieX 0.9 reads pictures on the Hexagon's second
 * session, so the X2's Qwen3-VL-2B goes without `--vit-compute GPUOpenCL`, and it carries another llama.cpp, whose
 * libraries only that build's llama-server loads.
 */
export interface NpuServerVersion {
  version: string;
  /** Each model's own `serve` in this version, by its id, in place of the model's. */
  serve?: Record<string, string[]>;
  /** Its embedding server's fields in this version, over the route's: the llama.cpp build that loads its libraries, and its folder. */
  embedServer?: Partial<Pick<NpuEmbedServer, 'version' | 'download' | 'into' | 'exe' | 'env'>>;
  /**
   * The kit's build of one of the server's files for this version, by generation (npu-patch.ts): in place of the
   * generation's own `pluginPatch`, which is for the route's pinned version. A generation it doesn't name gets none.
   */
  pluginPatch?: Record<string, NpuPluginPatch>;
  basis: string;
}

/** A file pinned by its size and SHA-256. */
export interface PinnedFile {
  size: number;
  sha256: string;
}

/**
 * A file of the route's server that the keeper replaces with the kit's own build of it (npu-patch.ts), only on its
 * generation, only over the very file the server's pinned version installs, and only while the files it is built against
 * are that version's: Castellan's build of GenieX 0.8.0's llama.cpp plugin on the Snapdragon X2, which holds about 2 GB
 * less (qualcomm/GenieX#1557). The server's own file is kept beside it (`<file>.stock`) and put back whenever the patch
 * fails its test, is switched off (config.json's npuPatch: false), or a later kit drops it. Anything else there (a
 * GenieX update) is left alone.
 */
export interface NpuPluginPatch {
  what: string;
  /** The server version it is built for: applied only over that version (the route's, its generation's pin, or the PC's own). */
  serverVersion: string;
  /** The server's folder that holds the file (%LOCALAPPDATA% expanded). */
  folder: string;
  file: string;
  /** The server's own file. */
  stock: PinnedFile;
  /** The kit's build: `from` is its path in the kit's node part. */
  patched: PinnedFile & { from: string };
  /** The server's files the build links against, by their path in `folder`: all must be these, or it isn't applied. */
  needs: Record<string, PinnedFile>;
  basis: string;
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
 * request; one a generation runs on the processor's graphics (the NPU 3720's), in the graphics' turn (embedTurn), beside
 * the NPU's chat. Qualcomm's is llama.cpp's llama-server of the very build GenieX carries, over GenieX's own libraries, its
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

/**
 * The maker's program a route's server runs to set the NPU's power mode, ignoring what it says: FastFlowLM's `flm serve`
 * runs AMD's xrt-smi.exe at each start. `args` only read (xrt-smi's `examine`). `brokenExit` is the exit of one that
 * can't start, and `broken` says why, in words for the person: the NPU still works, at its default power mode.
 */
export interface NpuPowerTool {
  exe: string;
  args: string[];
  brokenExit: number;
  broken: string;
}

/** A route's cold start per kind (stopped to its first answer, in ms), the minutes it may sit unused on a small PC, and why. */
export interface NpuRouteIdleStop {
  coldStartMs: Partial<Record<ServeKind, number>>;
  minutes: Partial<Record<ServeKind, number>>;
  basis: string;
  /** How to verify the numbers on this maker's hardware, where they aren't yet: npu-check --idle, which passes or fails. */
  verify?: string;
}

/** The rule for every route (npu-vendors.json's idleStop): a PC under `smallPcGb` stops a route's servers after its own minutes. */
export interface NpuIdleStop {
  smallPcGb: number;
  floorMinutes: number;
  coldStartTimes: number;
  /** llama.cpp's start to the first answer on a card that shares the PC's memory, for its servers' idle stop on a small PC (cardIdleStopMinutes). */
  cardColdStartMs: number;
  about: string;
}

export interface NpuCatalog {
  idleStop: NpuIdleStop;
  routes: Record<NpuVendor, NpuRoute>;
  /**
   * Device ids (4 hex digits, upper case) to generations: Intel's and AMD's PCI ids, whose names don't say it; a
   * Snapdragon's ACPI ids (`ACPI\VEN_QCOM&DEV_0FF0`), for a name that doesn't say which Snapdragon ("Hexagon NPU").
   */
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
  /**
   * Its generation isn't one setup knows (UNKNOWN_GENERATION): it is tried on the route's most cautious values
   * (unknownGeneration), and kept only if setup's test request and calibration pass on it.
   */
  guessed?: boolean;
}

/** The maker an NPU's manufacturer and name point to, as Heiward's NpuHardware.Classify: Qualcomm (or Hexagon), Intel, AMD. */
export function npuVendorOf(manufacturer: string | null | undefined, name: string | null | undefined): NpuVendor | null {
  const s = `${manufacturer ?? ''} ${name ?? ''}`;
  if (/qualcomm|hexagon/i.test(s)) return 'qualcomm';
  if (/intel/i.test(s)) return 'intel';
  if (/advanced micro devices|\bamd\b/i.test(s)) return 'amd';
  return null;
}

/** The device id in a PnP device id (PCI's `…&DEV_643E&…`, or a Snapdragon's ACPI `…&DEV_0FF0&…`), upper case; null when it has none. */
export const pciDevice = (deviceId: string) => /DEV_([0-9A-F]{4})/i.exec(deviceId)?.[1]?.toUpperCase() ?? null;

/**
 * The generation of a known maker's NPU that setup doesn't know (a PCI id not in npu-vendors.json's `devices`, a
 * Snapdragon by another name): tried on the route's most cautious values (unknownGeneration) rather than refused,
 * and decided on the PC by setup's test request and calibration, as any generation nobody has measured.
 */
export const UNKNOWN_GENERATION = 'unknown';

/**
 * The Snapdragons before the X (8cx Gen 1 to 3, 8c, 7c and 7c+, Microsoft's SQ1 to SQ3, 850 and 835), whose Hexagon
 * (v68 or older) no NPU server here runs on: npu-vendors.json's `snapdragon-8cx`, refused with its `why` before
 * anything is downloaded.
 */
export const LEGACY_SNAPDRAGON = 'snapdragon-8cx';

/**
 * Which generation. A Snapdragon by its name first, as Windows gives it: the X2's (X2E/X2P part numbers, "X2 Elite",
 * "X2 Plus"), then the first X's (X1E/X1P, and the plain X's and X Plus's X1 and five digits: "Snapdragon X - X126100";
 * "X Elite", "X Plus", "Snapdragon X -"), then the Snapdragons before it (LEGACY_SNAPDRAGON). A name that doesn't say
 * which Snapdragon ("Qualcomm Hexagon NPU") is told by its ACPI device id (npu-vendors.json's `devices`), and an older
 * Hexagon line's (a Hexagon driver Windows lists no Neural processor for, detect.ts' `npu|`, with no device id) is a
 * Snapdragon before the X: every X and X2 lists its NPU as one. Intel and AMD by their PCI device id. UNKNOWN_GENERATION
 * when it's none setup knows (a newer Snapdragon by a name it doesn't know, say).
 */
export function npuGeneration(vendor: NpuVendor, dev: Pick<NpuDevice, 'device' | 'deviceId'>, catalog: NpuCatalog = NPU_CATALOG): string {
  const id = pciDevice(dev.deviceId);
  if (vendor === 'qualcomm') {
    const name = dev.device;
    if (/\bX2[EP]\d|\bX2 (Elite|Plus)\b/i.test(name)) return 'snapdragon-x2';
    if (/\bX1[EP]\d|\bX1\d{5}\b|\bX (Elite|Plus)\b|\bSnapdragon(\((R|TM)\))? X -/i.test(name)) return 'snapdragon-x';
    if (/\b(8cx|8c|7c|SQ[1-3])\b|\bSnapdragon\b.*\b(850|835)\b/i.test(name)) return LEGACY_SNAPDRAGON;
    if (/\bSnapdragon\b/i.test(name)) return UNKNOWN_GENERATION;
    if (id) return catalog.devices.qualcomm?.[id] || UNKNOWN_GENERATION;
    return dev.deviceId ? UNKNOWN_GENERATION : LEGACY_SNAPDRAGON;
  }
  return (id && catalog.devices[vendor]?.[id]) || UNKNOWN_GENERATION;
}

/**
 * A generation of a maker setup doesn't know: the most cautious of the route's supported generations' values, each
 * as it runs (routeFor). The smallest cap, never over the route's (Qualcomm's 2,400 stays: an ~8K prompt bluescreened
 * the X2 Elite), with the server arguments of the generation it is from (OpenVINO compiles for its prompt length);
 * the longest timeouts and cold load, never under the route's own (its values for a generation nobody measured: AMD's
 * XDNA 2 is measured far quicker than a new generation may be); the most memory; the latest driver minimum. Never
 * verified, so setup's test request and calibration decide on the PC. Null when the route has no supported generation to start from.
 */
export function unknownGeneration(route: NpuRoute): NpuGeneration | null {
  const known = Object.keys(route.generations).filter((id) => route.generations[id].supported);
  if (!known.length) return null;
  const runs = known.map((id) => ({ id, g: route.generations[id], r: routeFor(route, id) }));
  const smallest = runs.reduce((a, b) => (b.r.maxContextTokens < a.r.maxContextTokens ? b : a));
  const maxContextTokens = Math.min(route.maxContextTokens, smallest.r.maxContextTokens);
  const most = <K extends string>(values: Partial<Record<K, number>>[], pick: (...n: number[]) => number) => {
    const out: Partial<Record<K, number>> = {};
    for (const v of values) for (const [k, n] of Object.entries(v) as [K, number | undefined][]) if (typeof n === 'number') out[k] = out[k] === undefined ? n : pick(out[k]!, n);
    return out;
  };
  const caps = most(runs.map((x) => x.r.caps), Math.min);
  for (const k of Object.keys(caps) as ServeKind[]) caps[k] = Math.min(caps[k]!, maxContextTokens);
  const timeouts = most([route.timeouts, ...runs.map((x) => x.r.timeouts)], Math.max);
  const memoryGb = most(runs.map((x) => x.r.memoryGb ?? {}), Math.max);
  const driverMin = runs.map((x) => x.g.driverMin ?? route.driverMin).filter((d): d is string => !!d).sort(compareVersions).pop();
  const args = smallest.r.maxContextTokens === maxContextTokens ? smallest.g.args : undefined;
  return {
    label: "a generation setup doesn't know yet",
    supported: true,
    verified: false,
    ...(driverMin ? { driverMin } : {}),
    timeouts,
    maxContextTokens,
    caps,
    ...(args ? { args } : {}),
    ...(Object.keys(memoryGb).length ? { memoryGb } : {}),
    basis: `Guessed: the most cautious of ${known.join(', ')} (the smallest cap, the longest timeouts and cold load (never under the route's own), the most memory, the latest driver), until setup's test request and calibration decide on the PC.`,
  };
}

/** A route's generation by its id: npu-vendors.json's, or for UNKNOWN_GENERATION the route's most cautious (unknownGeneration). */
export function generationOf(route: NpuRoute, id: string | null | undefined): NpuGeneration | undefined {
  if (!id) return undefined;
  if (Object.hasOwn(route.generations, id)) return route.generations[id];
  return id === UNKNOWN_GENERATION ? (unknownGeneration(route) ?? undefined) : undefined;
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

export const MAKERS: Record<NpuVendor, string> = { qualcomm: 'Qualcomm', intel: 'Intel', amd: 'AMD' };

/**
 * What the manor can do with this NPU on this PC (its processor's `arch`): its maker and generation, and whether its
 * server can be set up here. A known maker's generation setup doesn't know is tried on the route's most cautious
 * values (`guessed`: unknownGeneration). An NPU of a maker it doesn't know, a generation without a server (AMD's first
 * XDNA), a driver older than the server needs, or the wrong processor for the server's build (an Arm64-only server on
 * x64) is unsupported, and says why plainly; its work then goes to the graphics card or the processor.
 */
export function npuSupport(dev: NpuDevice, arch: string, catalog: NpuCatalog = NPU_CATALOG): NpuSupport {
  const vendor = npuVendorOf(dev.manufacturer, dev.device);
  if (!vendor) return { vendor: null, generation: null, label: dev.device || 'NPU', supported: false, verified: false, why: `the NPU "${dev.device || dev.deviceId}" is from a maker setup doesn't know yet (Qualcomm, Intel and AMD are)` };
  const route = catalog.routes[vendor];
  const id = pciDevice(dev.deviceId);
  const found = npuGeneration(vendor, dev, catalog);
  const gen = generationOf(route, found);
  const generation = gen ? found : null;
  const guessed = generation === UNKNOWN_GENERATION && !Object.hasOwn(route.generations, UNKNOWN_GENERATION);
  const label = guessed ? `${MAKERS[vendor]} NPU of a generation setup doesn't know yet${id ? `, device ${id}` : ''}` : (gen?.label ?? `${MAKERS[vendor]} NPU`);
  const base = { vendor, generation, label, verified: !!gen?.verified, ...(guessed ? { guessed } : {}) };
  if (!gen) return { ...base, supported: false, why: `this ${MAKERS[vendor]} NPU ("${dev.device}"${id ? `, device ${id}` : ''}) isn't one setup knows yet` };
  if (!gen.supported) return { ...base, supported: false, why: `the ${gen.label} NPU can't run the manor's models: ${gen.why ?? 'no model server supports it'}` };
  if (arch && route.arch !== arch) return { ...base, supported: false, why: `${route.server} runs on ${route.arch} Windows, and this PC is ${arch}` };
  const driverMin = gen.driverMin ?? route.driverMin;
  if (driverMin && dev.driver && compareVersions(dev.driver, driverMin) < 0) {
    const on = !gen.driverMin ? '' : !guessed ? ` on the ${gen.label}` : gen.driverMin === route.driverMin ? '' : ` on an NPU setup doesn't know yet (as the newest ${MAKERS[vendor]} NPUs it knows do)`;
    return { ...base, supported: false, why: `the NPU's driver needs an update: ${route.server} needs ${MAKERS[vendor]}'s NPU driver ${driverMin} or later${on}, and this PC has ${dev.driver}: update the driver from ${MAKERS[vendor]} or the PC's maker, then run setup again` };
  }
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
 * route's caps (per kind where they differ), its own timeouts, quirks, and its vision model's pictureTokens where it
 * has one. A kind on the chat model's server shares it
 * (no baseUrl of its own); its startCommand starts it with the chat model, and that model's own arguments after the
 * route's. `exe` is written as setup found it. The route's embedding server, when it has one and `embed` says where
 * setup put it, is the embed endpoint, on its own port.
 */
export function npuEntry(route: NpuRoute, o: { tools: string; exe: string; port?: number; portable?: (p: string) => string; embed?: { exe: string; model: string; turn?: string } }): AcceleratorEntry {
  const port = o.port ?? route.port;
  const keep = o.portable ?? ((p: string) => p);
  const chat = firstModel(route, 'chat');
  if (!chat) throw new Error(`${route.server}: no chat model`);
  const baseUrl = `http://127.0.0.1:${port}${route.baseUrlPath ?? ''}`;
  const startCommand = [keep(o.exe), ...[...route.serve, ...(chat.serve ?? [])].map((a) => {
    const x = expandRoute(a, { tools: o.tools, port, model: chat.id });
    return a.includes('{tools}') ? keep(x) : x;
  })];
  const cap = (k: ServeKind) => (route.caps[k] && route.caps[k] !== route.maxContextTokens ? { maxContextTokens: route.caps[k] } : {});
  // The server's own picture cap, from its vision model's (pictureTokensEnv).
  const pictures = firstModel(route, 'vision')?.pictureTokens;
  const capEnv = route.pictureTokensEnv && pictures ? { [route.pictureTokensEnv]: String(pictures) } : undefined;
  const env = capEnv ? { ...routeEnv(route, o.tools, keep), ...capEnv } : routeEnv(route, o.tools, keep);
  const server = { startCommand, ...(env ? { env } : {}) };
  const e: AcceleratorEntry = { id: 'npu', kind: 'npu', slots: 1, maxContextTokens: route.maxContextTokens, quirks: [...route.quirks] };
  e.chat = { baseUrl, model: chat.id, ...server, ...cap('chat') };
  for (const k of ['vision', 'embed'] as const) {
    const m = firstModel(route, k);
    if (m) e[k] = { model: m.id, ...cap(k), ...(k === 'embed' ? { baseUrl, ...server } : {}), ...(k === 'vision' && m.pictureTokens ? { pictureTokens: m.pictureTokens } : {}) };
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
    // On the processor's graphics (embedTurn), it answers in the graphics' turn, beside the NPU's chat.
    e.embed = { baseUrl: `http://127.0.0.1:${es.port}`, model: es.model.id, startCommand: [keep(o.embed.exe), ...args], ...(embedEnv ? { env: embedEnv } : {}), ...cap('embed'), ...(o.embed.turn ? { turn: o.embed.turn } : {}) };
  }
  if (Object.keys(route.timeouts).length) e.timeouts = { ...route.timeouts };
  return e;
}

/** A graphics card as detection lists it, as far as embedTurn needs it. */
export type GraphicsCard = { id: string; vendorId: number; memoryGb: number };

/** Intel's PCI vendor id: OpenVINO runs on Intel's graphics alone. */
const INTEL_VENDOR = 0x8086;

/**
 * The turn of a route's embedding server that runs on the processor's graphics (`--target_device GPU`: the NPU 3720's,
 * by its generation's `embedArgs`): the id of that graphics among this PC's cards, so its requests take the graphics'
 * turn, beside the NPU's chat, which they don't slow (NPU-VENDORS.md). OpenVINO's GPU is its first Intel graphics: the
 * one sharing the PC's memory (under 2 GB of its own), else the first Intel card. Undefined when it runs on the NPU, or
 * no Intel graphics is known: then it takes the NPU's turn, as before.
 */
export function embedTurn(route: NpuRoute, cards: readonly GraphicsCard[]): string | undefined {
  const serve = route.embedServer?.serve ?? [];
  const i = serve.indexOf('--target_device');
  if (i < 0 || !/^GPU\b/i.test(serve[i + 1] ?? '')) return undefined;
  const intel = cards.filter((c) => c.vendorId === INTEL_VENDOR);
  return (intel.find((c) => c.memoryGb < OWN_MEMORY_GB) ?? intel[0])?.id;
}

/** Whether a configured NPU entry runs this route's server (its chat endpoint's program). */
export function runsRoute(entry: { chat?: { startCommand?: string[] } } | undefined, route: NpuRoute, tools: string): boolean {
  const exe = entry?.chat?.startCommand?.[0];
  if (!exe) return false;
  return path.win32.basename(expandRoute(exe, { tools })).toLowerCase() === path.win32.basename(serverExe(route, tools)).toLowerCase();
}

/**
 * The version of the route's server installed on this PC, as its own program says (the route's versionCommand); null
 * when it isn't installed, the route has no such command, or the answer doesn't say. The Smith's Use it can leave a
 * later version than the route's own in place, which routeFor then runs as that version runs (atVersion).
 */
export async function installedVersion(route: NpuRoute, o: { tools: string; env?: Record<string, string | undefined>; exists?: (p: string) => boolean; run?: typeof runProgram }): Promise<string | null> {
  const vc = route.versionCommand;
  if (!vc) return null;
  const exe = serverExe(route, o.tools, o.env);
  if (!(o.exists ?? existsSync)(exe)) return null;
  try {
    const r = await (o.run ?? runProgram)(exe, vc.args, { timeoutMs: 15_000 });
    return r.code === 0 ? (new RegExp(vc.pattern).exec(r.out)?.[1] ?? null) : null;
  } catch {
    // A file Windows can't start (spawn EFTYPE, thrown before execFile calls back): it says nothing.
    return null;
  }
}

/**
 * The route with its generation's own pinned server (NpuGeneration.serverPin) in place of the route's: the version and
 * installer setup puts on that generation, the Snapdragon X2's GenieX 0.9.1. For the route as the catalog has it, before
 * atVersion, which then gives the PC's own version where it has another: never over a caller's own (a Smith try's
 * server). The route itself when the generation pins none.
 */
export function pinnedRoute(route: NpuRoute, generation: string | null | undefined): NpuRoute {
  const pin = generationOf(route, generation)?.serverPin;
  return pin ? { ...route, version: pin.version, download: { ...pin.download } } : route;
}

/** The route at another version of its server (the PC's own: installedVersion), so routeFor runs it as that version runs; the route itself when none is given. */
export const atVersion =(route: NpuRoute, version: string | null | undefined): NpuRoute => (version && version !== route.version ? { ...route, version } : route);

/** The entry of the route's `versions` its version runs by: the newest at or before it; none for an earlier version. */
export function serverVersionOf(route: NpuRoute): NpuServerVersion | undefined {
  let best: NpuServerVersion | undefined;
  for (const v of route.versions ?? []) if (compareVersions(v.version, route.version) <= 0 && (!best || compareVersions(v.version, best.version) > 0)) best = v;
  return best;
}

/**
 * The kit's build of a server file for a generation at the route's version: its `versions` entry's when one applies (GenieX
 * 0.9's), else the generation's own (for the pinned version).
 */
export function pluginPatchOf(route: NpuRoute, generation: string | null | undefined): NpuPluginPatch | undefined {
  const v = serverVersionOf(route);
  if (v) return generation && v.pluginPatch && Object.hasOwn(v.pluginPatch, generation) ? v.pluginPatch[generation] : undefined;
  return generationOf(route, generation)?.pluginPatch;
}

// ------------------------------------------------------------------------------------------------
// Per generation, memory and calibration

/**
 * Whether a route's models are its own as npu-vendors.json has them (the same ids, in order), not a caller's. A route
 * the catalog doesn't ship (a test's) counts as its own.
 */
function ownModels(route: NpuRoute): boolean {
  const shipped = Object.values(NPU_CATALOG.routes).find((r) => r.server === route.server && r.arch === route.arch);
  return !shipped || (shipped.models.length === route.models.length && shipped.models.every((m, i) => m.id === route.models[i].id));
}

/**
 * The route as it runs on one generation: the generation's own timeouts, caps and server arguments over the route's
 * (Meteor Lake's NPU 3720, about a quarter of Lunar Lake's speed, gets more time and a shorter compiled prompt); on
 * UNKNOWN_GENERATION, the route's most cautious (unknownGeneration). The generation's own models in the route's place
 * (a Snapdragon X2's Qwen3-VL-2B), and on a PC with little memory (`small`: smallPc of its memory) its smallPc models
 * over those. A caller's own models stay (the Smith's try of another model): a generation's go only in place of the
 * route's own, as npu-vendors.json has them (ownModels). Then what the route's server version changes (`versions`, by
 * serverVersionOf): a model's own arguments, its embedding server's build. The route itself when none of these apply.
 */
export function routeFor(route: NpuRoute, generation: string | null | undefined, small = false): NpuRoute {
  const g = generationOf(route, generation);
  const own = ownModels(route);
  if (own && g?.models) route = { ...route, models: g.models };
  if (own && small && g?.smallPc) route = { ...route, models: g.smallPc.models };
  const v = serverVersionOf(route);
  if (v) {
    const models = route.models.map((m) => (v.serve?.[m.id] ? { ...m, serve: [...v.serve[m.id]] } : m));
    route = { ...route, models, ...(route.embedServer && v.embedServer ? { embedServer: { ...route.embedServer, ...v.embedServer } } : {}) };
  }
  if (!g || (!g.timeouts && !g.caps && !g.maxContextTokens && !g.args && !g.embedArgs && !g.memoryGb)) return route;
  const replaced = (args: string[], values: Record<string, string> | undefined) => {
    const serve = [...args];
    for (const [flag, value] of Object.entries(values ?? {})) {
      const i = serve.indexOf(flag);
      if (i >= 0) serve[i + 1] = value;
    }
    return serve;
  };
  const serve = replaced(route.serve, g.args);
  const es = route.embedServer && g.embedArgs ? { embedServer: { ...route.embedServer, serve: replaced(route.embedServer.serve, g.embedArgs) } } : {};
  return { ...route, serve, ...es, maxContextTokens: g.maxContextTokens ?? route.maxContextTokens, caps: { ...route.caps, ...g.caps }, timeouts: { ...route.timeouts, ...g.timeouts }, ...(route.memoryGb || g.memoryGb ? { memoryGb: { ...route.memoryGb, ...g.memoryGb } } : {}) };
}

// ------------------------------------------------------------------------------------------------
// Playing an older Snapdragon on a newer one (npu-check's and npu-bench's --generation)

/** Where GenieX keeps its config.json, its AI Hub cache and its models when nothing says otherwise. */
export const GENIEX_DATA_DIR = '%USERPROFILE%\\.cache\\geniex';

/**
 * An older Snapdragon played on a newer one: GenieX run against a data folder of its own (`GENIEX_DATADIR`, and its
 * `--data-dir` before the command), whose config.json names the older chip to AI Hub, so it pulls and serves that
 * chip's model build, checked against that generation's pins in that folder, never the real cache; and the embedding
 * server's Hexagon code built for the older Hexagon (GGML_HEXAGON_ARCH, which llama.cpp's Hexagon backend reads in
 * place of the one it finds). It runs the older chip's code on this NPU: what it measures is that code, never the older
 * chip's speed or memory.
 */
export interface Played {
  /** The generation played. */
  generation: string;
  /** This NPU's own. */
  on: string;
  /** GenieX's data folder for it, {tools} not yet filled in (playedRoute's; setUpPlayed fills it). */
  dataDir: string;
  aiHubChipset: string;
  hexagonArch: string;
}

/** A played generation's GenieX data folder: {tools}\played\<generation>\geniex, kept apart from the real cache. */
export const playedDataDir = (generation: string) => `{tools}\\played\\${generation}\\geniex`;

/** A Hexagon version's number (`v73` is 73), or null when it isn't one. */
const hexagonOf = (arch: string | undefined) => (arch && /^v\d+$/i.test(arch) ? Number(arch.slice(1)) : null);

/**
 * Whether this NPU can play `generation` (npu-check's and npu-bench's --generation): `own` for its own; `played` when it
 * emulates it, a Snapdragon playing an older Snapdragon whose Hexagon and AI Hub chip npu-vendors.json names; `values`
 * when it can only run that generation's starting values (routeFor), which emulates nothing (an Intel or AMD NPU, whose
 * server builds for the NPU it finds; Qualcomm's `unknown`); `refused`, and why in words, for a generation its route
 * hasn't, one no server runs (LEGACY_SNAPDRAGON), a newer Hexagon on an older one (its code doesn't run there), or a
 * Snapdragon whose own Hexagon isn't known.
 */
export function playGeneration(
  npu: Pick<NpuSupport, 'vendor' | 'generation' | 'label'>,
  generation: string,
  catalog: NpuCatalog = NPU_CATALOG,
): { kind: 'own' } | { kind: 'values' } | { kind: 'played'; played: Played } | { kind: 'refused'; why: string } {
  if (!npu.vendor) return { kind: 'refused', why: 'this NPU is from a maker setup doesn\'t know: nothing can be played on it' };
  if (generation === npu.generation) return { kind: 'own' };
  const route = catalog.routes[npu.vendor];
  const want = generationOf(route, generation);
  if (!want) return { kind: 'refused', why: `${MAKERS[npu.vendor]}'s route has no generation ${generation} (it has ${[...Object.keys(route.generations), UNKNOWN_GENERATION].join(', ')})` };
  if (!want.supported) return { kind: 'refused', why: `the ${want.label} can't be played: ${want.why ?? 'no model server runs on it'}` };
  if (npu.vendor !== 'qualcomm' || generation === UNKNOWN_GENERATION) return { kind: 'values' };
  const own = generationOf(route, npu.generation);
  const ownArch = hexagonOf(own?.hexagonArch);
  const wantArch = hexagonOf(want.hexagonArch);
  if (!want.aiHubChipset || wantArch === null) return { kind: 'refused', why: `npu-vendors.json doesn't name ${generation}'s Hexagon and AI Hub chip, so it can't be played` };
  if (ownArch === null) return { kind: 'refused', why: `this NPU's own Hexagon isn't known (${npu.label}), so whether it runs ${want.hexagonArch} code isn't either` };
  if (wantArch > ownArch) return { kind: 'refused', why: `the ${want.label} is newer than this NPU (${own!.hexagonArch}): its Hexagon code doesn't run on an older one` };
  return { kind: 'played', played: { generation, on: npu.generation!, dataDir: playedDataDir(generation), aiHubChipset: want.aiHubChipset, hexagonArch: want.hexagonArch! } };
}

/**
 * The route as it plays an older Snapdragon (Played): GenieX's serve and pulls with its own data folder (`--data-dir`
 * before the command, and GENIEX_DATADIR), its models found and their pins checked there, and the embedding server
 * given GGML_HEXAGON_ARCH, the played Hexagon (never empty: llama.cpp reads an empty one as arch 0). The route's other
 * values are the played generation's (routeFor, before this).
 */
export function playedRoute(route: NpuRoute, p: Played): NpuRoute {
  const real = GENIEX_DATA_DIR.toLowerCase();
  const move = (s: string) => (s.toLowerCase().startsWith(real) ? p.dataDir + s.slice(real.length) : s);
  const dir = ['--data-dir', p.dataDir];
  const models = route.models.map((m) => ({
    ...m,
    pull: [...dir, ...m.pull],
    ...(m.present ? { present: move(m.present) } : {}),
    ...(m.pinned ? { pinned: Object.fromEntries(Object.entries(m.pinned).map(([g, pin]) => [g, { ...pin, dir: move(pin.dir) }])) } : {}),
  }));
  const es = route.embedServer;
  return {
    ...route,
    serve: [...dir, ...route.serve],
    env: { ...route.env, GENIEX_DATADIR: p.dataDir },
    models,
    ...(es ? { embedServer: { ...es, env: { ...es.env, GGML_HEXAGON_ARCH: p.hexagonArch } } } : {}),
  };
}

/** Writes a played generation's GenieX config.json (its AI Hub chip), so GenieX pulls and serves that chip's build; the folder, filled in. */
export function setUpPlayed(p: Played, tools: string): string {
  const dir = expandRoute(p.dataDir, { tools });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {}
  if (config.chipset !== p.aiHubChipset) writeFileSync(file, JSON.stringify({ ...config, chipset: p.aiHubChipset }, null, 2) + '\n');
  return dir;
}

/** How a run says what it plays, in a sentence: `dir`, its data folder filled in (setUpPlayed's). */
export function playedSay(p: Played, dir: string = p.dataDir, catalog: NpuCatalog = NPU_CATALOG): string {
  const g = catalog.routes.qualcomm.generations;
  return `this ${g[p.on]?.label ?? p.on} plays the ${g[p.generation]?.label ?? p.generation}: GenieX serves AI Hub's ${p.aiHubChipset} build from ${dir}, and the embeddings run Hexagon ${p.hexagonArch} code. Its numbers are that code's on this NPU, not that chip's speed`;
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

// ------------------------------------------------------------------------------------------------
// Stopped when unused (npu-vendors.json's idleStop)

/** The minutes a route's server may sit unused on a small PC, from its cold start: coldStartTimes times it, never under floorMinutes. */
export function idleMinutesFor(coldStartMs: number, rule: NpuIdleStop = NPU_CATALOG.idleStop): number {
  return Math.max(rule.floorMinutes, Math.ceil((rule.coldStartTimes * Math.max(0, coldStartMs)) / 60_000));
}

/** Whether this PC has little memory, for the idle stop: under the rule's smallPcGb. Unknown memory isn't small (as before). */
export const smallPc = (ramBytes: number | null | undefined, rule: NpuIdleStop = NPU_CATALOG.idleStop) => !!ramBytes && ramBytes < rule.smallPcGb * 1024 ** 3;

/**
 * The route a configured NPU server runs, by its program and kind: the route's own program (GenieX, ovms, flm), or for
 * embeddings its embedding server's (llama-server on the Snapdragon; Intel's is ovms again). Null for a program no route
 * runs (npu-embed's Python, a server set up by hand).
 */
export function routeOfServer(program: string, kind: ServeKind, catalog: NpuCatalog = NPU_CATALOG): NpuRoute | null {
  const name = (p: string) => path.win32.basename(p).toLowerCase();
  const wanted = name(program);
  for (const r of Object.values(catalog.routes)) {
    const own = name(r.install.exe);
    if (kind === 'embed' && r.embedServer ? name(r.embedServer.exe ?? r.install.exe) === wanted : own === wanted) return r;
  }
  return null;
}

/** A route's cold start for a kind (its chat's when the kind has none of its own), or null when the route gives none. */
export function coldStartMsOf(route: NpuRoute | null, kind: ServeKind): number | null {
  return route?.idleStop?.coldStartMs[kind] ?? route?.idleStop?.coldStartMs.chat ?? null;
}

/**
 * The minutes an NPU server may sit unused before the keeper stops it, when config.json gives no npuIdleStopMinutes: on a
 * PC with little memory (smallPc), its route's own minutes for its kind (its chat's when the kind has none); on a bigger
 * PC, or for a server no route runs, `otherwise` (rules.json's keeper.npuIdleStopMinutes, as before).
 */
export function npuIdleStopMinutes(o: { program: string; kind: ServeKind; ramBytes: number | null | undefined; otherwise: number; catalog?: NpuCatalog }): number {
  const catalog = o.catalog ?? NPU_CATALOG;
  if (!smallPc(o.ramBytes, catalog.idleStop)) return o.otherwise;
  const stop = routeOfServer(o.program, o.kind, catalog)?.idleStop;
  return stop?.minutes[o.kind] ?? stop?.minutes.chat ?? o.otherwise;
}

/**
 * The minutes a graphics card's llama.cpp servers may sit unused before the keeper stops them, when config.json gives no
 * gpuIdleStopMinutes: on a PC with little memory (smallPc), a card that shares the PC's memory (under OWN_MEMORY_GB of
 * its own: integrated graphics, whose models hold the PC's own memory, as an NPU's do) by the NPU's rule, from llama.cpp's
 * cold start (idleStop.cardColdStartMs); a card with memory of its own, one whose memory isn't known, or any card on a
 * bigger PC, `otherwise` (rules.json's keeper.gpuIdleStopMinutes, as before).
 */
export function cardIdleStopMinutes(o: { memoryGb: number | null | undefined; ramBytes: number | null | undefined; otherwise: number; catalog?: NpuCatalog }): number {
  const rule = (o.catalog ?? NPU_CATALOG).idleStop;
  if (!smallPc(o.ramBytes, rule) || o.memoryGb === null || o.memoryGb === undefined || o.memoryGb >= OWN_MEMORY_GB) return o.otherwise;
  return idleMinutesFor(rule.cardColdStartMs, rule);
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
 * twice a full-cap read and a warm answer, reading taken as the route's readPerWrite times writing, else 10 (about 27
 * times on the Lunar Lake, 650–750 read and 24–28 written a second, and nearer 12 expected on the NPU 3720, whose
 * compute falls further than its memory bandwidth; AMD's route 30, FastFlowLM having read 34 to 36 times faster on a
 * Krackan); a cold load half again the first start's. Never under the route's starting values (a busy moment doesn't
 * shrink them), never over CALIBRATION's bounds; too slow when it writes under minTokensPerSecond.
 */
export function calibrate(m: NpuMeasured, route: Pick<NpuRoute, 'maxContextTokens' | 'timeouts' | 'readPerWrite'>): { timeouts: Required<NpuRoute['timeouts']>; tooSlow?: string } {
  const tps = Math.max(0.01, m.tokensPerSecond);
  const guess = route.timeouts;
  const perToken = roundUpTo((1000 / tps) * 2, 50);
  const base = roundUpTo(((route.maxContextTokens / (tps * (route.readPerWrite ?? CALIBRATION.readPerWrite))) * 1000 + m.warmMs) * 2, 5_000);
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
  embed: (ReturnType<typeof embedPaths> & { server: NpuEmbedServer; download: NpuDownload | null; modelDownload: NpuDownload | null; modelPull: string[] | null; turn?: string }) | null;
  /** The route's power tool, its path expanded, when it has one. */
  powerTool?: NpuPowerTool;
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
  /** This PC's graphics cards (detection's), for the turn of an embedding server that runs on its graphics (embedTurn). */
  cards?: readonly GraphicsCard[];
  /** This PC has little memory (smallPc): its generation's smallPc models, where it has any. */
  small?: boolean;
  /**
   * The version of the route's server this PC has (installedVersion), null when it can't say: run as that version runs,
   * else as its generation pins it (pinnedRoute), and that installed where it isn't. Left out, the route is planned as given.
   */
  serverVersion?: string | null;
}): NpuPlan | null {
  if (!o.support.supported || !o.support.vendor) return null;
  const exists = o.exists ?? existsSync;
  // The generation's own starting values and models (routeFor); its embedding server left out when asked. Told the PC's
  // version (setup, the refresh), the route as this PC runs it: at that version, else its generation's pin, which setup
  // installs (pinnedRoute). Otherwise the route as given: a caller's own, already at its version (npu-check's, a Smith try's).
  const given = (o.catalog ?? NPU_CATALOG).routes[o.support.vendor];
  const generic = routeFor(o.serverVersion === undefined ? given : atVersion(pinnedRoute(given, o.support.generation), o.serverVersion), o.support.generation, o.small);
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
    const turn = embedTurn(route, o.cards ?? []);
    embed = { ...p, server: es, download: zip, modelDownload: model, modelPull: pull, ...(turn ? { turn } : {}) };
  }
  const downloadBytes =
    (download ? download.size : 0) +
    (runtime ? runtime.size : 0) +
    models.filter((m) => !m.have).reduce((n, m) => n + m.size, 0) +
    (embed?.download?.size ?? 0) +
    (embed?.modelDownload?.size ?? 0) +
    (embed?.modelPull ? embed.server.model.size : 0);
  const powerTool = route.powerTool ? { ...route.powerTool, exe: expandRoute(route.powerTool.exe, { tools: o.tools, env: o.env }) } : undefined;
  return { vendor: o.support.vendor, route, support: o.support, exe, installed, download, runtime, models, port: o.port ?? route.port, kinds: npuKinds(route), embed, ...(powerTool ? { powerTool } : {}), downloadBytes };
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

/** What running a route's power tool came to (checkPowerTool). */
export interface PowerToolCheck {
  exe: string;
  /** It isn't on this PC: nothing was run. */
  missing: boolean;
  code: number | null;
  /** It exited with the route's `brokenExit`: the server can't set the NPU's power mode. */
  broken: boolean;
}

/**
 * Runs the plan's power tool once, with its arguments that only read. A program Node starts inherits Node's error mode,
 * so a DLL that lacks what the tool needs fails it silently, with the loader's exit (xrt-smi's 0xC0000139); started
 * from PowerShell's Start-Process, it shows a dialog and waits for a click. Null when the route has no power tool.
 */
export async function checkPowerTool(
  plan: Pick<NpuPlan, 'powerTool'>,
  io: { run?: (exe: string, args: string[], o?: { timeoutMs?: number }) => Promise<{ code: number | null; out: string }>; exists?: (p: string) => boolean } = {},
): Promise<PowerToolCheck | null> {
  const t = plan.powerTool;
  if (!t) return null;
  if (!(io.exists ?? existsSync)(t.exe)) return { exe: t.exe, missing: true, code: null, broken: false };
  const r = await (io.run ?? runProgram)(t.exe, t.args, { timeoutMs: 60_000 });
  return { exe: t.exe, missing: false, code: r.code, broken: r.code === t.brokenExit };
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
