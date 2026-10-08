import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chatBody, ensureServer, expandEnv, lockDirsOf, postJson, rememberHardware, serverEnv, visionBody } from './accelerators.ts';
import { type Accelerator, acceleratorConfigFile, type AcceleratorEntry, entryOf, autoOrder, OWN_MEMORY_GB, orderAccelerators, readAccelerator, readAccelerators, readConfigFile, SERVE_KINDS, type ServeKind, serverBase, serves, toolsHome, validateKeeperConfig, writeConfigFile } from './accelerator-config.ts';
import { type Detection, detect, detectedAccelerators, type GpuCard, hardwareOf, noNpu, recommendedCard } from './detect.ts';
import * as core from './core/index.js';
import { withAcceleratorTurn } from './npu-queue.ts';
import { checkPinned, expandRoute, type NpuPlan, npuEntry, planNpu, routeEnv, runProgram, testImage } from './npu-vendors.ts';

/**
 * Accelerator setup (Manor's Set up local AI, `smith accelerators setup`, Reeve's where there is no Smith, and their
 * Settings pages' Set up): the NPU first, then the graphics cards, then the processor. The NPU's own model server for its
 * maker (npu-vendors.ts: GenieX on a Snapdragon, OpenVINO Model Server on an Intel Core Ultra, FastFlowLM on an AMD
 * Ryzen AI 300), downloaded and checked against its pinned SHA-256, installed for this user, its models pulled, and its
 * entry written only once it has answered a test request; llama.cpp's server for each graphics card (and the
 * processor, when there's no card) from ggml-org/llama.cpp's newest build, the models as GGUF files from Hugging
 * Face, and an accelerator entry per card in config.json. It says how much it will download and asks first. An NPU
 * entry a person configured is left as it is; on a PC with no NPU (or one the manor can't use) the one install wrote by
 * default (and only that one) is dropped.
 *
 * Planning is separate from downloading, and every outside answer (the release list, Hugging Face,
 * `llama-server --list-devices`) is parsed by a function of its own, so tests run on fixtures.
 */

export const LLAMA_REPO = 'ggml-org/llama.cpp';
/** The first port a set-up server takes; each takes the next free one. */
export const FIRST_PORT = 18191;

// ------------------------------------------------------------------------------------------------
// Which llama.cpp build

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  /** "sha256:<hex>", when the release publishes it. */
  digest?: string;
}
export interface Release {
  tag: string;
  assets: ReleaseAsset[];
}

/** The release list as GitHub's API (and `gh api`) returns it. */
export function parseReleases(json: any): Release[] {
  return (Array.isArray(json) ? json : [])
    .filter((r) => r && typeof r.tag_name === 'string' && !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      assets: (r.assets ?? []).map((a: any) => ({ name: String(a.name), size: Number(a.size) || 0, url: String(a.browser_download_url ?? ''), digest: typeof a.digest === 'string' ? a.digest : undefined })),
    }));
}

/** llama.cpp's Windows build for an accelerator: its variant (the asset's name between `bin-win-` and `.zip`), and CUDA's runtime. */
export interface Variant {
  variant: string;
  /** The CUDA runtime's asset, unpacked beside the server. */
  cudart?: string;
  /** --device's backend: CUDA, Vulkan, GPUOpenCL; none for the processor. */
  backend: 'CUDA' | 'Vulkan' | 'GPUOpenCL' | null;
}

/**
 * NVIDIA on x64: the CUDA 12.4 build and its runtime; AMD, Intel or any other card on x64: Vulkan;
 * Snapdragon's Adreno on Arm64: OpenCL for Adreno; the processor: the CPU build for its architecture.
 */
export function variantFor(t: { kind: 'gpu' | 'cpu' | 'npu'; vendor?: string; arch: string }): Variant | { none: string } {
  if (t.kind === 'npu') return { none: 'the NPU runs GenieX, not llama.cpp' };
  if (t.kind === 'cpu') {
    if (t.arch === 'arm64' || t.arch === 'x64') return { variant: `cpu-${t.arch}`, backend: null };
    return { none: `no llama.cpp CPU build for ${t.arch}` };
  }
  const vendor = (t.vendor ?? '').toLowerCase();
  if (t.arch === 'x64') {
    if (vendor === 'nvidia') return { variant: 'cuda-12.4-x64', cudart: 'cudart-llama-bin-win-cuda-12.4-x64.zip', backend: 'CUDA' };
    if (vendor === 'qualcomm') return { none: 'an Adreno card on an x64 PC' };
    return { variant: 'vulkan-x64', backend: 'Vulkan' };
  }
  if (t.arch === 'arm64') {
    if (vendor === 'qualcomm') return { variant: 'opencl-adreno-arm64', backend: 'GPUOpenCL' };
    return { none: `no llama.cpp build for a ${t.vendor ?? 'graphics'} card on Arm64` };
  }
  return { none: `no llama.cpp build for ${t.arch}` };
}

export const assetName = (build: string, variant: string) => `llama-${build}-bin-win-${variant}.zip`;

/** The newest build (b<number>, newest first as GitHub lists them) that has every asset needed; a build still uploading lacks some. */
export function pickRelease(releases: Release[], variants: Variant[]): { release: Release; assets: ReleaseAsset[] } | null {
  for (const r of releases) {
    if (!/^b\d+$/.test(r.tag)) continue;
    const names = variants.flatMap((v) => [assetName(r.tag, v.variant), ...(v.cudart ? [v.cudart] : [])]);
    const assets = [...new Set(names)].map((n) => r.assets.find((a) => a.name === n));
    if (assets.every((a): a is ReleaseAsset => !!a && !!a.url)) return { release: r, assets };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Which models

/** The models, the same as on the NPU so answers stay comparable: Qwen's own GGUF repos first, then well-known quantizers. */
export const MODEL_SPECS: Record<ServeKind, { model: string; repos: string[]; file: RegExp; mmproj?: RegExp[] }> = {
  chat: {
    model: 'qwen3-4b-instruct-2507',
    repos: ['Qwen/Qwen3-4B-Instruct-2507-GGUF', 'unsloth/Qwen3-4B-Instruct-2507-GGUF', 'bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF', 'lmstudio-community/Qwen3-4B-Instruct-2507-GGUF'],
    file: /(^|\/)(Qwen_)?Qwen3-4B-Instruct-2507-Q4_K_M\.gguf$/i,
  },
  vision: {
    model: 'qwen3-vl-4b-instruct',
    repos: ['Qwen/Qwen3-VL-4B-Instruct-GGUF', 'unsloth/Qwen3-VL-4B-Instruct-GGUF', 'bartowski/Qwen_Qwen3-VL-4B-Instruct-GGUF'],
    file: /(^|\/)(Qwen_)?Qwen3-?VL-4B-Instruct-Q4_K_M\.gguf$/i,
    mmproj: [/(^|\/)mmproj[^/]*Q8_0\.gguf$/i, /(^|\/)mmproj[^/]*(F16|f16)\.gguf$/i],
  },
  embed: {
    // Its own index name: these vectors aren't Foundry Local's qwen3-embedding-0.6b build's.
    model: 'qwen3-embedding-0.6b-gguf',
    repos: ['Qwen/Qwen3-Embedding-0.6B-GGUF'],
    file: /(^|\/)Qwen3-Embedding-0\.6B-Q8_0\.gguf$/i,
  },
  rerank: {
    // llama.cpp's own conversion (ggml-org), which its --reranking reads: Qwen publishes no GGUF of it.
    model: 'qwen3-reranker-0.6b',
    repos: ['ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF'],
    file: /(^|\/)qwen3-reranker-0\.6b-q8_0\.gguf$/i,
  },
};

/**
 * The kinds every graphics card serves unless others are asked for. A reranker isn't one of them: it is an add-on, set
 * up only when asked for (`--serve rerank`), beside whatever its accelerator already serves (runSetup).
 */
export const DEFAULT_KINDS: readonly ServeKind[] = ['chat', 'vision', 'embed'];

export interface ModelFile {
  kind: ServeKind;
  role: 'model' | 'mmproj';
  repo: string;
  file: string;
  url: string;
  size: number;
  sha256?: string;
}

/** Hugging Face's file list for a repo (GET /api/models/<repo>?blobs=true): name, size, and the LFS sha256. */
export function parseHfFiles(json: any): { file: string; size: number; sha256?: string }[] {
  return (json?.siblings ?? []).map((s: any) => ({ file: String(s.rfilename), size: Number(s.size ?? s.lfs?.size) || 0, sha256: s.lfs?.sha256 }));
}

/** The first repo that has the file (and, for vision, a projector): what to download. */
export async function findModels(kinds: ServeKind[], files: (repo: string) => Promise<{ file: string; size: number; sha256?: string }[] | null>): Promise<{ models: ModelFile[]; problems: string[] }> {
  const models: ModelFile[] = [];
  const problems: string[] = [];
  for (const kind of kinds) {
    const spec = MODEL_SPECS[kind];
    let found = false;
    for (const repo of spec.repos) {
      const list = await files(repo).catch(() => null);
      if (!list) continue;
      const main = list.find((f) => spec.file.test(f.file));
      const proj = spec.mmproj ? spec.mmproj.map((re) => list.find((f) => re.test(f.file))).find(Boolean) : undefined;
      if (!main || (spec.mmproj && !proj)) continue;
      const picks: [ModelFile['role'], { file: string; size: number; sha256?: string }][] = [['model', main], ...(proj ? [['mmproj', proj] as [ModelFile['role'], typeof proj]] : [])];
      for (const [role, f] of picks) {
        models.push({ kind, role, repo, file: f.file, url: `https://huggingface.co/${repo}/resolve/main/${f.file}`, size: f.size, sha256: f.sha256 });
      }
      found = true;
      break;
    }
    if (!found) problems.push(`no GGUF for ${spec.model} in ${spec.repos.join(', ')}`);
  }
  return { models, problems };
}

// ------------------------------------------------------------------------------------------------
// Which llama.cpp device

export interface LlamaDevice {
  /** --device's name: CUDA0, Vulkan1, GPUOpenCL. */
  name: string;
  description: string;
}

/**
 * `llama-server --list-devices`: its "  CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, 23008 MiB free)"
 * lines. Windows builds lose those when their output isn't a console, so the backends' own log lines
 * (stderr) are read too: CUDA's "Device 0: <name>, compute capability", Vulkan's "ggml_vulkan: 0 =
 * <name> (<driver>)", OpenCL's "ggml_opencl: device: '<name> (OpenCL …)'" (one device, GPUOpenCL).
 */
export function parseListDevices(text: string): LlamaDevice[] {
  const out: LlamaDevice[] = [];
  const add = (name: string, description: string) => {
    if (!out.some((d) => d.name === name)) out.push({ name, description: description.trim() });
  };
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^\s+([A-Za-z][\w-]*\d*|GPUOpenCL):\s+(.+?)\s+\(\d+ MiB, \d+ MiB free\)\s*$/.exec(line))) add(m[1], m[2]);
    else if ((m = /^\s+Device (\d+): ([^,]+), (compute capability|gfx)/.exec(line))) add(`CUDA${m[1]}`, m[2]);
    else if ((m = /^ggml_vulkan: (\d+) = (.+?) \(/.exec(line))) add(`Vulkan${m[1]}`, m[2]);
    else if ((m = /^ggml_opencl: (default )?device: '(.+?)(\s+\(OpenCL[^']*\))?'/.exec(line))) add('GPUOpenCL', m[2]);
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\((r|tm|c)\)/g, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The llama.cpp device for a card, by name: the devices whose description names it (either way
 * round), and for the second card of a name, the second such device. Null when none does.
 */
export function matchDevice(card: Pick<GpuCard, 'name'>, devices: LlamaDevice[], backend: Variant['backend']): string | null {
  const nth = Number(/ #(\d+)$/.exec(card.name)?.[1] ?? 1);
  const base = norm(card.name.replace(/ #\d+$/, ''));
  const prefix = backend === 'GPUOpenCL' ? 'GPUOpenCL' : backend ?? '';
  const same = devices.filter((d) => (!prefix || d.name.startsWith(prefix)) && (norm(d.description).includes(base) || base.includes(norm(d.description))) && norm(d.description));
  return same[nth - 1]?.name ?? null;
}

// ------------------------------------------------------------------------------------------------
// The entries

/** Each server's context, in tokens, as its startCommand sets it (acceleratorEntry): chat's is cap × slots. */
export function serverContext(kind: ServeKind, s: { slots: number; maxContextTokens: number }): number {
  return kind === 'chat' ? s.maxContextTokens * s.slots : kind === 'vision' ? Math.max(8192, s.maxContextTokens) : 8192;
}

/** A server's own flags after its model, by kind: what it serves, its context and batch, one request at a time but chat's. */
function kindFlags(kind: ServeKind, e: { slots: number; maxContextTokens: number }, mmproj: string | undefined, model: string): string[] {
  switch (kind) {
    case 'chat':
      return ['-c', String(serverContext('chat', e)), '--parallel', String(e.slots), '--jinja', '--alias', model];
    case 'vision':
      return ['--mmproj', portablePath(mmproj ?? ''), '-c', String(serverContext('vision', e)), '--parallel', '1', '--jinja', '--alias', model];
    case 'embed':
      // Each input must fit one micro-batch, and Reeve's are under ~650 tokens (a 1,500-char chunk
      // and its path). At 8192 the compute buffer was one 4.7 GB allocation, which the Adreno X2-90's
      // OpenCL refused ("failed to allocate compute pp buffers"); at 2048 it loads.
      return ['--embeddings', '--pooling', 'last', '-c', String(serverContext('embed', e)), '-b', '2048', '-ub', '2048', '--parallel', '1', '--alias', model];
    case 'rerank':
      // A question and one document a pass, each well under a micro-batch (Reeve sends 1,600 chars of a file): as embed.
      return ['--reranking', '-c', String(serverContext('rerank', e)), '-b', '2048', '-ub', '2048', '--parallel', '1', '--alias', model];
  }
}

/**
 * What each server takes on a card besides its context, in GB: the model and its compute buffers.
 * Qwen3-4B Q4_K_M is 2.5, Qwen3-VL-4B Q4_K_M and its projector 2.95, Qwen3-Embedding-0.6B Q8_0 0.64
 * with a compute buffer of about 1.2 at -ub 2048 (4.7 at 8192 on the Adreno). Estimates from the files
 * and llama.cpp's buffers, not measured on a card of its own.
 */
export const SERVER_GB: Record<ServeKind, number> = { chat: 2.9, vision: 3.45, embed: 1.85, rerank: 1.85 };
/** The KV cache at f16, a token: 36 layers × 8 KV heads × 128 × K and V × 2 bytes for the 4B models, 28 layers for the 0.6B ones. */
const KV_BYTES: Record<ServeKind, number> = { chat: 147_456, vision: 147_456, embed: 114_688, rerank: 114_688 };
/** What a card keeps for the desktop and the programs on it. A game gets the rest back from the reaper, which stops the card's servers while it plays. */
export const DESKTOP_GB = 1.5;
/** The sizes tried on a card of its own, largest first. */
const CARD_SIZES = [
  { slots: 2, maxContextTokens: 16384 },
  { slots: 2, maxContextTokens: 8192 },
  { slots: 1, maxContextTokens: 8192 },
  { slots: 1, maxContextTokens: 4096 },
];

/** The memory a card's servers take at once, by those estimates, in GB. */
export function cardNeedGb(kinds: ServeKind[], s: { slots: number; maxContextTokens: number }): number {
  return kinds.reduce((sum, k) => sum + SERVER_GB[k] + (serverContext(k, s) * KV_BYTES[k]) / 1024 ** 3, 0);
}

export interface Sizing {
  slots: number;
  maxContextTokens: number;
  /** What it serves: those asked for, less any left off. */
  kinds: ServeKind[];
  /** Asked for, but left off: they wouldn't fit on the card beside the others. */
  left?: ServeKind[];
}

/**
 * Slots, the request cap and what it serves, from a card's memory: the largest size at which all its
 * servers (each running at once, every layer on the card) fit with DESKTOP_GB to spare. When none does,
 * vision is left off (the rarest request, and the biggest server after chat), unless it was asked for
 * by name (`keepKinds`); when still none does, the smallest. A card that shares the PC's memory goes by
 * the PC's, and the processor only chats.
 */
export function sizing(t: { kind: 'gpu' | 'cpu'; memoryGb?: number; ramGb?: number; kinds?: ServeKind[]; keepKinds?: boolean }): Sizing {
  const kinds = t.kinds ?? [...DEFAULT_KINDS];
  if (t.kind === 'cpu') return { slots: 1, maxContextTokens: 4096, kinds };
  const own = t.memoryGb ?? 0;
  if (own < OWN_MEMORY_GB) return { ...((t.ramGb ?? 0) >= 32 ? { slots: 1, maxContextTokens: 8192 } : { slots: 1, maxContextTokens: 4096 }), kinds };
  const room = own - DESKTOP_GB;
  const tries = t.keepKinds || !kinds.includes('vision') || kinds.length === 1 ? [kinds] : [kinds, kinds.filter((k) => k !== 'vision')];
  const withLeft = (ks: ServeKind[]) => (ks.length < kinds.length ? { kinds: ks, left: kinds.filter((k) => !ks.includes(k)) } : { kinds: ks });
  for (const ks of tries) {
    const fits = CARD_SIZES.find((s) => cardNeedGb(ks, s) <= room);
    if (fits) return { ...fits, ...withLeft(ks) };
  }
  return { ...CARD_SIZES.at(-1)!, ...withLeft(tries.at(-1)!) };
}

/** A path as %USERPROFILE%\…, so config.json reads the same for whoever's profile it's in. */
export function portablePath(p: string, home = homedir()): string {
  return p.toLowerCase().startsWith(home.toLowerCase() + path.sep) ? `%USERPROFILE%${p.slice(home.length)}` : p;
}

export interface EntryInput {
  id: string;
  kind: 'gpu' | 'cpu';
  memoryGb?: number;
  /** --device's name (none for the processor). */
  device: string | null;
  server: string;
  models: Partial<Record<ServeKind, { path: string; mmproj?: string }>>;
  ports: Partial<Record<ServeKind, number>>;
  slots: number;
  maxContextTokens: number;
}

/**
 * The config.json entry: one llama-server per kind it serves, each on its own port, pinned to its device. No name: an
 * accelerator's name comes from the PC (the core's acceleratorName), never from config.json.
 */
export function acceleratorEntry(e: EntryInput): AcceleratorEntry {
  const a: AcceleratorEntry = { id: e.id, kind: e.kind, slots: e.slots, maxContextTokens: e.maxContextTokens, quirks: [] };
  if (e.memoryGb !== undefined) a.memoryGb = e.memoryGb;
  const server = portablePath(e.server);
  const pin = e.device ? ['--device', e.device, '-ngl', '99'] : ['-ngl', '0'];
  for (const kind of SERVE_KINDS) {
    const m = e.models[kind];
    const port = e.ports[kind];
    if (!m || !port) continue;
    const model = MODEL_SPECS[kind].model;
    const common = ['--host', '127.0.0.1', '--port', String(port), ...pin, '-m', portablePath(m.path)];
    a[kind] = { baseUrl: `http://127.0.0.1:${port}`, model, startCommand: [server, ...common, ...kindFlags(kind, e, m.mmproj, model)] };
  }
  return a;
}

/**
 * An entry just set up, with what its accelerator had that this setup didn't set up kept: a reranker is an add-on, so
 * setting one up keeps the rest of the accelerator's entry (its servers, slots and cap), and setting the others up again
 * keeps its reranker. Anything else is set up afresh, as before.
 */
export function keepingAddOns(made: AcceleratorEntry, had: Accelerator | AcceleratorEntry | undefined, kinds: readonly ServeKind[]): AcceleratorEntry {
  if (!had) return made;
  if (kinds.every((k) => k === 'rerank')) return { ...entryOf(had), ...(made.rerank ? { rerank: made.rerank } : {}) };
  return had.rerank && !made.rerank && !kinds.includes('rerank') ? { ...made, rerank: had.rerank } : made;
}

/** The kinds of an accelerator's entry that a setup of `kinds` keeps (keepingAddOns): their ports stay theirs. */
export function keptKinds(had: Accelerator | undefined, kinds: readonly ServeKind[]): ServeKind[] {
  if (!had) return [];
  if (kinds.every((k) => k === 'rerank')) return SERVE_KINDS.filter((k) => k !== 'rerank' && had[k]?.baseUrl);
  return had.rerank?.baseUrl && !kinds.includes('rerank') ? ['rerank'] : [];
}

/** Ports already taken by configured endpoints. */
export function usedPorts(list: Accelerator[]): Set<number> {
  const out = new Set<number>();
  for (const a of list) {
    for (const ep of SERVE_KINDS.map((k) => a[k])) {
      if (!ep?.baseUrl) continue;
      try {
        const p = Number(new URL(ep.baseUrl).port);
        if (p) out.add(p);
      } catch {}
    }
  }
  return out;
}

/**
 * config.json with the set-up entries in its list: each replaces the one with its id or joins the
 * end. An old config's accelerators (the NPU's GenieX) are put in the list unchanged; nothing else
 * in the file changes, and acceleratorOrder is "auto" unless it says otherwise. No entry keeps a name (it comes
 * from the PC): an older list's names are dropped.
 */
export function mergeEntries(raw: Record<string, any>, entries: (Accelerator | AcceleratorEntry)[]): Record<string, any> {
  const list: any[] = Array.isArray(raw.accelerators)
    ? raw.accelerators.map((x: any) => (x && typeof x === 'object' && !Array.isArray(x) ? entryOf(x) : x))
    : readAccelerators(raw).accelerators.map(entryOf);
  for (const e of entries.map(entryOf)) {
    const i = list.findIndex((x) => x?.id === e.id);
    if (i >= 0) list[i] = e;
    else list.push(e);
  }
  return { ...raw, accelerators: list, acceleratorOrder: raw.acceleratorOrder ?? 'auto' };
}

/**
 * config.json without its `npu` accelerator: out of the list and out of acceleratorOrder, and
 * install's old chatEndpoint gone too, so nothing reads it back as one. For a PC with no NPU whose
 * `npu` is install's GenieX default (planSetup's dropNpu); everything else stays as it is.
 */
export function withoutNpu(raw: Record<string, any>, localAppData: string): Record<string, any> {
  const out = { ...raw };
  if (isDefaultChatEndpoint(out.chatEndpoint, localAppData)) delete out.chatEndpoint;
  if (Array.isArray(out.accelerators)) out.accelerators = out.accelerators.filter((x: any) => x?.id !== 'npu');
  if (Array.isArray(out.acceleratorOrder)) out.acceleratorOrder = out.acceleratorOrder.filter((id: unknown) => id !== 'npu');
  return out;
}

// ------------------------------------------------------------------------------------------------
// The plan

export interface Download {
  what: string;
  url: string;
  size: number;
  sha256?: string;
  /** The file it's saved as (a .zip is unpacked into `unpackTo`). */
  dest: string;
  unpackTo?: string;
  /** Already here (the file, or its unpacked folder): not downloaded again. */
  have: boolean;
}

export interface SetupTarget {
  id: string;
  kind: 'gpu' | 'cpu';
  name: string;
  memoryGb?: number;
  vendor?: string;
  variant?: Variant;
  folder?: string;
  slots: number;
  maxContextTokens: number;
  ports: Partial<Record<ServeKind, number>>;
  kinds: ServeKind[];
  /** Asked for, but left off: they wouldn't fit on the card beside the others (sizing). */
  left?: ServeKind[];
  /** Filled in once its build is here (llama-server --list-devices). */
  device?: string | null;
  problem?: string;
}

export interface SetupPlan {
  /** The NPU's server and models to set up (npu-vendors.ts' planNpu), or null. */
  npu: NpuPlan | null;
  /** Why the NPU isn't set up this time, when this PC has one: unsupported, already configured, or missing something. */
  npuNote?: string;
  build: string | null;
  /** config.json's `npu` is install's GenieX default and this PC has no NPU: setup drops it (withoutNpu). */
  dropNpu: boolean;
  /** The %LOCALAPPDATA% that default was recognised by. */
  localAppData: string;
  targets: SetupTarget[];
  downloads: Download[];
  models: ModelFile[];
  /** Bytes still to download. */
  downloadBytes: number;
  problems: string[];
  serversDir: string;
  modelsDir: string;
}

export interface PlanInput {
  detection: Detection;
  /** Ids asked for; none: every graphics card (the processor too when there's no card and no NPU). */
  ids: string[];
  /** What each card serves (default all three; the processor only chats). */
  kinds?: ServeKind[];
  /** config.json's content now. */
  raw: Record<string, any>;
  releases: Release[];
  hfFiles: (repo: string) => Promise<{ file: string; size: number; sha256?: string }[] | null>;
  /** Where servers and models go (toolsHome: the accelerators' folder, or %USERPROFILE%\.reeve on a PC set up before). */
  home: string;
  /** The environment the NPU route's paths are expanded from (tests give one). */
  env?: Record<string, string | undefined>;
  /** %LOCALAPPDATA%, where install's default GenieX entry starts geniex.exe from. */
  localAppData?: string;
  exists?: (p: string) => boolean;
  fileSize?: (p: string) => number;
}

/** What setup would do: for which accelerators, which build and models, how much to download. Downloads nothing. */
export async function planSetup(o: PlanInput): Promise<SetupPlan> {
  const exists = o.exists ?? existsSync;
  const fileSize = o.fileSize ?? ((p: string) => (existsSync(p) ? statSync(p).size : -1));
  const serversDir = path.join(o.home, 'servers', 'llama.cpp');
  const modelsDir = path.join(o.home, 'models');
  const problems: string[] = [...o.detection.problems];
  const arch = o.detection.cpu?.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  const ramGb = o.detection.ramBytes / 1024 ** 3;
  const kinds = o.kinds?.length ? o.kinds : [...DEFAULT_KINDS];
  const localAppData = o.localAppData ?? process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  const det = o.detection.npu;
  const installDefault = isInstallDefaultNpu(o.raw, localAppData);
  // GenieX's default entry is wrong on a PC without an NPU, and on one whose NPU isn't a Snapdragon the manor can use.
  const dropNpu = installDefault && (noNpu(o.detection) || (!!det && (!det.supported || det.vendor !== 'qualcomm')));

  // The NPU first: its own server, when it's one the manor can use and nobody configured it otherwise.
  const configuredNpu = readAccelerators(o.raw).accelerators.find((a) => a.kind === 'npu');
  const askedNpu = o.ids.includes('npu');
  let npu: NpuPlan | null = null;
  let npuNote: string | undefined;
  if (det && !det.supported) npuNote = `${det.label} (npu): not set up: ${det.why}. The graphics card or the processor takes its work.`;
  // A reranker alone is no reason to set the NPU up: none of its servers reranks.
  else if (det && (askedNpu || (!o.ids.length && (!configuredNpu || installDefault) && kinds.some((k) => k !== 'rerank')))) {
    npu = planNpu({ support: det, tools: o.home, downloadsDir: path.join(o.home, 'servers', 'downloads'), env: o.env, exists });
    if (npu?.missing.length) {
      npuNote = `${det.label} (npu): not set up: ${npu.route.server} needs ${npu.missing.join('; and ')}. Until then the graphics card or the processor takes its work.`;
      npu = null;
    }
  } else if (det && configuredNpu) npuNote = `${det.label} (npu): already set up in config.json; left as it is (accelerators setup npu sets it up again)`;
  if (askedNpu && !det && !dropNpu) problems.push(noNpu(o.detection) ? 'npu: this PC has no NPU' : "npu: couldn't tell whether this PC has an NPU");
  // What the NPU will serve (set up now, or configured before).
  const npuServes = new Set<ServeKind>(npu ? npu.kinds : det?.supported && configuredNpu && !installDefault ? SERVE_KINDS.filter((k) => serves(configuredNpu, k)) : []);

  // Which accelerators. Every graphics card serves all three, as before: the NPU comes first for what it serves, and a
  // card takes it only when the NPU can't (too big, or failed lately). With no card, the processor chats when the NPU
  // doesn't, and makes the embeddings when the NPU chats but serves none (every NPU route but a configured one).
  const cards = o.detection.cards;
  let wanted = (o.ids.length ? o.ids : cards.map((c) => c.id)).filter((id) => id !== 'npu');
  const cpuDefault: ServeKind[] = !npuServes.has('chat') ? ['chat'] : !npuServes.has('embed') ? ['embed'] : [];
  if (!o.ids.length && !cards.length && o.detection.cpu && cpuDefault.length) wanted = ['cpu'];
  const targets: SetupTarget[] = [];
  for (const id of wanted) {
    const card = cards.find((c) => c.id === id);
    if (!card && id !== 'cpu') {
      problems.push(`${id}: no such graphics card on this PC (${cards.map((c) => c.id).join(', ') || 'none found'})`);
      continue;
    }
    const kind = card ? 'gpu' : 'cpu';
    // The processor chats (and reranks, when asked): a 0.6B reranker runs well enough on it, a vision model doesn't.
    const cpuKinds = o.kinds?.length || o.ids.includes('cpu') || !cpuDefault.length ? kinds.filter((k) => k === 'chat' || k === 'rerank') : cpuDefault;
    const size = sizing({ kind, memoryGb: card?.memoryGb, ramGb, kinds: kind === 'cpu' ? cpuKinds : kinds, keepKinds: !!o.kinds?.length });
    const v = variantFor({ kind, vendor: card?.vendor, arch });
    const t: SetupTarget = {
      id,
      kind,
      name: card?.name ?? o.detection.cpu?.name ?? 'Processor',
      memoryGb: card?.memoryGb,
      vendor: card?.vendor,
      ...size,
      ports: {},
    };
    if ('none' in v) t.problem = v.none;
    else t.variant = v;
    targets.push(t);
  }

  // Which build.
  const variants = targets.filter((t) => t.variant).map((t) => t.variant!);
  const picked = variants.length ? pickRelease(o.releases, variants) : null;
  if (variants.length && !picked) problems.push(`no ${LLAMA_REPO} release has ${[...new Set(variants.map((v) => v.variant))].join(', ')} (looked at ${o.releases.length})`);
  const build = picked?.release.tag ?? null;
  const downloads: Download[] = [];
  if (picked) {
    for (const t of targets.filter((t) => t.variant)) {
      t.folder = path.join(serversDir, `${build}-${t.variant!.variant}`);
      for (const name of [assetName(build!, t.variant!.variant), ...(t.variant!.cudart ? [t.variant!.cudart] : [])]) {
        if (downloads.some((d) => d.what === name && d.unpackTo === t.folder)) continue;
        const asset = picked.assets.find((a) => a.name === name)!;
        const marker = name.startsWith('cudart') ? path.join(t.folder, 'cudart64_12.dll') : path.join(t.folder, 'llama-server.exe');
        downloads.push({
          what: name,
          url: asset.url,
          size: asset.size,
          sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined,
          dest: path.join(serversDir, 'downloads', name.replace(/^cudart-llama-bin/, `cudart-${build}`)),
          unpackTo: t.folder,
          have: exists(marker),
        });
      }
    }
  }

  // Which models.
  const needed = [...new Set(targets.filter((t) => t.variant).flatMap((t) => t.kinds))];
  const found = needed.length ? await findModels(needed, o.hfFiles) : { models: [], problems: [] };
  problems.push(...found.problems);
  for (const m of found.models) {
    const dest = path.join(modelsDir, path.basename(m.file));
    downloads.push({ what: `${m.repo}/${m.file}`, url: m.url, size: m.size, sha256: m.sha256, dest, have: fileSize(dest) === m.size && m.size > 0 });
  }

  // Ports: an accelerator keeps its own; a new one takes the next free from 18191.
  const current = readAccelerators(dropNpu ? withoutNpu(o.raw, localAppData) : o.raw).accelerators;
  const taken = usedPorts(current.filter((a) => !targets.some((t) => t.id === a.id)));
  // What a target keeps (a reranker set up alone keeps the rest; the rest set up again keep the reranker) keeps its ports.
  for (const t of targets) {
    const mine = current.find((a) => a.id === t.id);
    for (const k of keptKinds(mine, t.kinds)) taken.add(Number(new URL(serverBase(mine![k]!.baseUrl!)).port));
  }
  let next = FIRST_PORT;
  for (const t of targets.filter((t) => t.variant)) {
    const mine = current.find((a) => a.id === t.id);
    for (const k of t.kinds) {
      const had = mine?.[k]?.baseUrl ? Number(new URL(serverBase(mine[k]!.baseUrl!)).port) : 0;
      if (had && !taken.has(had)) {
        t.ports[k] = had;
      } else {
        while (taken.has(next)) next++;
        t.ports[k] = next;
      }
      taken.add(t.ports[k]!);
    }
  }
  // The NPU's port: its route's, unless a card or the processor already has it.
  if (npu && taken.has(npu.port)) {
    while (taken.has(next)) next++;
    npu.port = next;
  }
  const downloadBytes = downloads.filter((d) => !d.have).reduce((n, d) => n + d.size, 0) + (npu?.downloadBytes ?? 0);
  return { npu, ...(npuNote ? { npuNote } : {}), build, dropNpu, localAppData, targets, downloads, models: found.models, downloadBytes, problems, serversDir, modelsDir };
}

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
export const mb = (bytes: number) => (bytes >= 1e9 ? gb(bytes) : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** The plan in a few lines: what it sets up, what it downloads, how much. */
export function describePlan(p: SetupPlan): string[] {
  const lines: string[] = [];
  if (p.dropNpu) lines.push("NPU (npu): removed from config.json. It's the GenieX server install wrote by default, and this PC has no NPU it can run on, so requests tried it first and failed.");
  if (p.npu) {
    const n = p.npu;
    lines.push(`${n.support.label} (npu): ${n.route.server} ${n.route.version}, ${n.kinds.join(' and ')} on ${n.port}; ${n.models.map((m) => m.id).join(', ')}${n.support.verified ? '' : ' (not yet tried on this kind of NPU)'}`);
    lines.push(`  ${n.installed ? 'have' : 'get '} ${n.route.server} ${n.route.version} (${mb(n.route.download.size)}, SHA-256 pinned)${n.installed ? ` at ${n.exe}` : ''}`);
    for (const m of n.models) lines.push(`  ${m.have ? 'have' : 'get '} ${m.id} (${mb(m.size)})`);
  }
  if (p.npuNote) lines.push(p.npuNote);
  for (const t of p.targets) {
    if (t.problem) {
      lines.push(`${t.name} (${t.id}): skipped, ${t.problem}`);
      continue;
    }
    const serves = t.kinds.map((k) => `${k} on ${t.ports[k]}`).join(', ');
    lines.push(`${t.name} (${t.id}): llama.cpp ${p.build ?? '?'} ${t.variant?.variant}, ${t.slots} slot${t.slots === 1 ? '' : 's'}, ${t.maxContextTokens} tokens a request; ${serves}${t.device ? `; device ${t.device}` : ''}`);
    if (t.left?.length) lines.push(`  ${t.left.join(' and ')} left off: the card's ${t.memoryGb} GB won't hold it beside ${t.kinds.join(' and ')} at once (to have it anyway: accelerators setup --serve chat,vision,embed)`);
  }
  for (const d of p.downloads) lines.push(`  ${d.have ? 'have' : 'get '} ${d.what} (${mb(d.size)})${d.sha256 ? '' : ', no published checksum'}`);
  lines.push(p.downloadBytes ? `Download: ${mb(p.downloadBytes)} into ${path.dirname(p.serversDir)} and ${p.modelsDir}.` : 'Nothing to download.');
  for (const x of p.problems) lines.push(`note: ${x}`);
  return lines;
}

// ------------------------------------------------------------------------------------------------
// Doing it

/** Downloads a file whole (a .part, then a rename), checking its size and published sha256. */
export async function download(d: Download, progress: (done: number, total: number) => void = () => {}, fetchImpl: typeof fetch = fetch): Promise<void> {
  mkdirSync(path.dirname(d.dest), { recursive: true });
  const part = `${d.dest}.part`;
  const res = await fetchImpl(d.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${d.url}: ${res.status} ${res.statusText}`);
  const hash = createHash('sha256');
  let done = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body as any);
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    done += chunk.length;
    if (done - last > 50e6) {
      last = done;
      progress(done, d.size);
    }
  });
  await pipeline(body, createWriteStream(part));
  if (d.size && done !== d.size) {
    rmSync(part, { force: true });
    throw new Error(`${d.what}: got ${done} bytes, expected ${d.size}`);
  }
  const sum = hash.digest('hex');
  if (d.sha256 && sum !== d.sha256.toLowerCase()) {
    rmSync(part, { force: true });
    throw new Error(`${d.what}: sha256 ${sum} isn't the published ${d.sha256}`);
  }
  rmSync(d.dest, { force: true });
  renameSync(part, d.dest);
  progress(done, d.size);
}

const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** Unpacks a release zip with Windows' own tar.exe into a folder (via a temporary one, so a half-unpacked build never looks whole). */
export function unpack(zip: string, into: string): void {
  const tmp = `${into}.unpacking`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const r = spawnSync(tarExe, ['-x', '-f', zip, '-C', tmp], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar couldn't unpack ${zip}: ${r.stderr || r.error?.message}`);
  // Some zips wrap their files in a folder.
  const entries = readdirSync(tmp);
  const from = entries.length === 1 && statSync(path.join(tmp, entries[0])).isDirectory() ? path.join(tmp, entries[0]) : tmp;
  mkdirSync(into, { recursive: true });
  for (const e of readdirSync(from)) {
    rmSync(path.join(into, e), { recursive: true, force: true });
    renameSync(path.join(from, e), path.join(into, e));
  }
  rmSync(tmp, { recursive: true, force: true });
}

/** `llama-server --list-devices`, stdout and stderr (Windows builds lose stdout when it isn't a console). */
export async function listDevices(server: string): Promise<string> {
  const run = (exe: string) =>
    new Promise<string>((resolve) =>
      execFile(exe, ['--list-devices'], { windowsHide: true, timeout: 60_000, cwd: path.dirname(exe) }, (_e, stdout, stderr) => resolve(`${stdout ?? ''}\n${stderr ?? ''}`)),
    );
  const exe = expandEnv(server);
  const text = await run(exe);
  if (parseListDevices(text).length) return text;
  // The Adreno OpenCL build loses llama-server's list (and its logs) when its output isn't a console:
  // Qualcomm's OpenCL driver ends the process before buffered output is written. llama-bench, from the
  // same build and the same backends, logs each backend's devices to stderr unbuffered.
  const bench = path.join(path.dirname(exe), 'llama-bench.exe');
  return existsSync(bench) ? `${text}\n${await run(bench)}` : text;
}

export interface SetupIo extends NpuIo {
  log: (line: string) => void;
  download?: (d: Download, progress: (done: number, total: number) => void) => Promise<void>;
  unpack?: (zip: string, into: string) => void;
  listDevices?: (server: string) => Promise<string>;
}

/**
 * Downloads what the plan lacks, finds each card's llama.cpp device, and returns config.json's new
 * content (mergeEntries) with an entry per accelerator it set up. The caller writes it.
 */
export async function runSetup(plan: SetupPlan, raw: Record<string, any>, io: SetupIo): Promise<{ raw: Record<string, any>; entries: Accelerator[]; problems: string[] }> {
  const problems: string[] = [];
  const entries: Accelerator[] = [];
  // The NPU first: its entry is written only once its server has answered a test request.
  if (plan.npu) {
    const r = await setUpNpu(plan.npu, path.dirname(plan.modelsDir), io);
    problems.push(...r.problems);
    if (r.entry) entries.push({ ...r.entry, name: core.deviceName(plan.npu.support.label) });
  }
  for (const d of plan.downloads.filter((d) => !d.have)) {
    io.log(`downloading ${d.what} (${mb(d.size)})`);
    await (io.download ?? download)(d, (done, total) => io.log(`  ${d.what}: ${mb(done)} of ${mb(total)}`));
    if (d.unpackTo) {
      (io.unpack ?? unpack)(d.dest, d.unpackTo);
      rmSync(d.dest, { force: true });
    }
  }
  const modelPath = (kind: ServeKind, role: 'model' | 'mmproj') => {
    const m = plan.models.find((x) => x.kind === kind && x.role === role);
    return m ? path.join(plan.modelsDir, path.basename(m.file)) : undefined;
  };
  for (const t of plan.targets) {
    if (t.problem || !t.variant || !t.folder) {
      if (t.problem) problems.push(`${t.id}: ${t.problem}`);
      continue;
    }
    const server = path.join(t.folder, 'llama-server.exe');
    let device: string | null = null;
    if (t.variant.backend) {
      const devices = parseListDevices(await (io.listDevices ?? listDevices)(server));
      device = matchDevice({ name: t.name }, devices, t.variant.backend);
      if (!device) {
        problems.push(`${t.id}: llama-server --list-devices names no device for ${t.name} (it lists ${devices.map((d) => `${d.name}: ${d.description}`).join('; ') || 'none'})`);
        continue;
      }
      t.device = device;
    }
    const models: EntryInput['models'] = {};
    for (const k of t.kinds) {
      const p = modelPath(k, 'model');
      if (p) models[k] = { path: p, mmproj: k === 'vision' ? modelPath(k, 'mmproj') : undefined };
    }
    // Named as detection named it, for the caller; config.json gets the entry without it (mergeEntries).
    const made = acceleratorEntry({ id: t.id, kind: t.kind, memoryGb: t.memoryGb, device, server, models, ports: t.ports, slots: t.slots, maxContextTokens: t.maxContextTokens });
    const had = readAccelerators(raw).accelerators.find((a) => a.id === t.id);
    entries.push({ ...keepingAddOns(made, had, t.kinds), name: core.deviceName(t.name) });
    io.log(`${t.name}: ${device ? `device ${device}, ` : ''}${Object.keys(models).join(', ')} on ${Object.values(t.ports).join(', ')}`);
  }
  return { raw: mergeEntries(plan.dropNpu ? withoutNpu(raw, plan.localAppData) : raw, entries), entries, problems };
}

// ------------------------------------------------------------------------------------------------
// The NPU's own server

export interface NpuIo {
  log: (line: string) => void;
  download?: (d: Download, progress: (done: number, total: number) => void) => Promise<void>;
  unpack?: (zip: string, into: string) => void;
  /** Runs a program (the installer, the server's pull): its exit code and output. */
  run?: (exe: string, args: string[], o?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number | null; out: string }>;
  exists?: (p: string) => boolean;
  /** The test request: problems, none when the server answered every kind it serves. */
  testNpu?: (entry: AcceleratorEntry) => Promise<string[]>;
  /** A file's SHA-256 (the pinned model files). */
  hash?: (file: string) => Promise<string>;
}

/** The last lines of a program's output, for a problem's line. */
const tail = (out: string) => out.trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 300);

/**
 * Sets the NPU up on its route: its server downloaded (checked against the pinned SHA-256) and installed for this user
 * unless it's there, each model pulled unless it's there (and, where pinned for this generation, checked file by file),
 * then a test request of each kind it serves. Its entry comes back only when every step worked; otherwise the problems
 * say which step failed, and config.json gets no NPU entry from it.
 */
export async function setUpNpu(n: NpuPlan, tools: string, io: NpuIo): Promise<{ entry?: AcceleratorEntry; problems: string[] }> {
  const exists = io.exists ?? existsSync;
  const run = io.run ?? runProgram;
  const fail = (what: string) => ({ problems: [`npu: ${what}. config.json gets no NPU entry; its work goes to the graphics card or the processor`] });
  if (!n.installed && n.download) {
    const d: Download = { what: n.download.what, url: n.download.url, size: n.download.size, sha256: n.download.sha256, dest: n.download.dest, have: false };
    io.log(`downloading ${n.route.server} ${n.route.version} (${mb(d.size)})`);
    try {
      await (io.download ?? download)(d, (done, total) => io.log(`  ${d.what}: ${mb(done)} of ${mb(total)}`));
    } catch (e: any) {
      return fail(`${n.route.server}'s download failed: ${e?.message ?? e}`);
    }
    const inst = n.route.install;
    if (inst.kind === 'inno') {
      io.log(`installing ${n.route.server} for this user (no administrator)`);
      const r = await run(d.dest, inst.args, { timeoutMs: 15 * 60_000 });
      if (r.code !== 0) return fail(`${n.route.server}'s installer ended with ${r.code}${r.out.trim() ? `: ${tail(r.out)}` : ''}`);
    } else {
      const into = expandRoute(inst.into, { tools });
      io.log(`unpacking ${n.route.server} into ${into}`);
      try {
        (io.unpack ?? unpack)(d.dest, into);
      } catch (e: any) {
        return fail(`${n.route.server} couldn't be unpacked: ${e?.message ?? e}`);
      }
    }
    rmSync(d.dest, { force: true });
    if (!exists(n.exe)) return fail(`${n.route.server} was installed, but ${n.exe} isn't there`);
  }
  const env = serverEnv({ env: routeEnv(n.route, tools) });
  for (const m of n.models) {
    if (!m.have) {
      io.log(`downloading ${m.id} (${mb(m.size)}) with ${n.route.server}; this takes a while`);
      const r = await run(n.exe, m.pull, { timeoutMs: 3 * 3600_000, env });
      if (r.code !== 0) return fail(`${n.route.server} couldn't download ${m.id} (exit ${r.code}${r.out.trim() ? `: ${tail(r.out)}` : ''})`);
    }
    const bad = await checkPinned(m, n.support.generation, { tools, hash: io.hash });
    if (bad.length) return fail(`${m.id} isn't the build that was checked: ${bad.join('; ')}`);
  }
  const entry = npuEntry(n.route, { tools, exe: n.exe, port: n.port, portable: (p) => portablePath(p) });
  io.log(`asking ${n.route.server} a test question on the NPU (its first load can take a minute or more)`);
  const problems = await (io.testNpu ?? ((e: AcceleratorEntry) => testNpuEntry(e)))(entry);
  if (problems.length) return fail(`${n.route.server} didn't answer its test request: ${problems.join('; ')}`);
  io.log(`${n.route.server} answered on the NPU: ${n.kinds.join(', ')}`);
  return { entry, problems: [] };
}

/**
 * The test request: in the NPU's turn (its lock and line, as every request), its server started if it isn't running,
 * then one short chat answer, and one about a picture when it serves vision. Problems in words; none when each
 * answered with text. A model's first load on the NPU (OpenVINO compiles it) may take minutes, so it is given 15.
 */
export async function testNpuEntry(e: AcceleratorEntry, o: { dir?: string } = {}): Promise<string[]> {
  const acc = readAccelerator(e);
  if (!acc?.chat?.baseUrl) return ['the entry has no chat server'];
  const problems: string[] = [];
  const text = (j: any) => j?.choices?.[0]?.message?.content;
  const kitAcc = acc as unknown as Parameters<typeof chatBody>[0];
  await withAcceleratorTurn(
    lockDirsOf({ id: 'npu', slots: 1 }),
    async () => {
      const chat = { baseUrl: acc.chat!.baseUrl!, model: acc.chat!.model, startCommand: acc.chat!.startCommand, ...(acc.chat!.env ? { env: acc.chat!.env } : {}) };
      await ensureServer(chat, { waitMs: 120_000, readyMs: 15 * 60_000 });
      const c = await postJson(chat, '/v1/chat/completions', chatBody(kitAcc, chat, [{ role: 'user', content: 'Reply with the single word: ready' }], 8), 15 * 60_000, { loading: true });
      if (typeof text(c.json) !== 'string') problems.push(`chat gave no answer (${JSON.stringify(c.json).slice(0, 160)})`);
      if (acc.vision?.model) {
        const v = { ...chat, model: acc.vision.model };
        const img = testImage(o.dir ?? path.join(toolsHome(), 'servers', 'downloads'));
        const r = await postJson(v, '/v1/chat/completions', visionBody(kitAcc, v, img, 'What colour is this picture? One word.', 8), 15 * 60_000, { loading: true });
        if (typeof text(r.json) !== 'string') problems.push(`vision gave no answer (${JSON.stringify(r.json).slice(0, 160)})`);
      }
    },
    { who: 'setup', lane: 'interactive', waitMs: 10 * 60_000, staleMs: 40 * 60_000 },
  ).catch((err: any) => problems.push(String(err?.message ?? err).split(/\r?\n/)[0]));
  return problems;
}

// ------------------------------------------------------------------------------------------------
// GenieX, the NPU's server, as an install writes it

/**
 * The GenieX chat server a PC with an NPU is pointed at when config.json has none (the keeper's first look, or
 * Reeve's install). Setup tells this default from an NPU entry a person configured: only the default is ever dropped.
 */
export const GENIEX_BASE_URL = 'http://127.0.0.1:18181';
export const GENIEX_CHAT_MODEL = 'qualcomm/Qwen3-4B-Instruct-2507:W4A16';

/** The config.json written on a PC with an NPU, when there is none. */
export function genieXConfig(localAppData: string) {
  return {
    chatEndpoint: {
      baseUrl: GENIEX_BASE_URL,
      model: GENIEX_CHAT_MODEL,
      device: 'Npu' as const,
      startCommand: [path.win32.join(localAppData, 'GenieX CLI', 'geniex.exe'), 'serve', '--skip-update'],
    },
  };
}

const sameList = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether config.json's `npu` accelerator is exactly what an install wrote by default: GenieX's chat at its
 * address, with its model and start command, and nothing else (no vision, no embeddings). Read either way: the
 * old chatEndpoint, or the entry an earlier setup put in the list from it.
 */
export function isInstallDefaultNpu(raw: Record<string, any>, localAppData: string): boolean {
  const read = readAccelerators(raw);
  const npu = read.accelerators.find((a) => a.id === 'npu');
  if (!npu?.chat || npu.vision || npu.embed) return false;
  if (read.legacy) return isDefaultChatEndpoint(raw.chatEndpoint, localAppData);
  const want = genieXConfig(localAppData).chatEndpoint;
  return npu.chat.baseUrl === want.baseUrl && npu.chat.model === want.model && sameList(npu.chat.startCommand, want.startCommand);
}

/** Whether config.json's old chatEndpoint is the install's default, word for word. */
export function isDefaultChatEndpoint(ep: any, localAppData: string): boolean {
  const want = genieXConfig(localAppData).chatEndpoint;
  return !!ep && typeof ep === 'object' && ep.baseUrl === want.baseUrl && ep.model === want.model && ep.device === want.device && sameList(ep.startCommand, want.startCommand);
}

// ------------------------------------------------------------------------------------------------
// Setup's outside answers

/** gh on PATH, else where this PC keeps it. */
export function ghExe(): string | null {
  for (const candidate of ['gh', 'C:\\tools\\gh\\bin\\gh.exe']) {
    const r = spawnSync(candidate, ['--version'], { windowsHide: true, stdio: 'ignore' });
    if (r.status === 0) return candidate;
  }
  return null;
}

/** ggml-org/llama.cpp's newest releases, through gh (signed in or not), else GitHub's public API. */
export async function llamaReleases(): Promise<Release[]> {
  const gh = ghExe();
  if (gh) {
    const json = await new Promise<string>((resolve, reject) =>
      execFile(gh, ['api', 'repos/ggml-org/llama.cpp/releases?per_page=10'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (e, stdout, stderr) =>
        e ? reject(new Error(`gh api failed: ${String(stderr || e.message).trim()}`)) : resolve(stdout),
      ),
    ).catch(() => '');
    if (json) return parseReleases(JSON.parse(json));
  }
  const res = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10', { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GitHub's release list: ${res.status}`);
  return parseReleases(await res.json());
}

/** A Hugging Face repo's files with sizes and sha256s; null when there's no such repo. */
export async function hfFiles(repo: string): Promise<{ file: string; size: number; sha256?: string }[] | null> {
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return null;
  return parseHfFiles(await res.json());
}

// ------------------------------------------------------------------------------------------------
// The command

export interface SetupOptions {
  ids: string[];
  kinds?: ServeKind[];
  yes?: boolean;
  dryRun?: boolean;
  /** Asked before downloading (unless yes or dry-run); false stops. */
  confirm?: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
  detection?: Detection;
  /** llama.cpp's releases and Hugging Face's file lists (tests give fixtures). */
  releases?: () => Promise<Release[]>;
  hfFiles?: typeof hfFiles;
  /** config.json (acceleratorConfigFile()). */
  configFile?: string;
  /** Where the builds and models go (toolsHome()). */
  home?: string;
  /** Checks config.json before it is written: the keeper's part by default; Reeve checks the whole file. */
  validate?: (raw: unknown) => string[];
  /** How the closing line says no accelerator is left (Reeve's: "none configured (Foundry Local)"). */
  noneConfigured?: string;
  /** Run setup's own download, unpack, device listing, installs, pulls and test requests (tests give fakes). */
  io?: Omit<SetupIo, 'log'>;
  /** The environment the NPU route's paths are expanded from (tests give one). */
  env?: Record<string, string | undefined>;
}

/** Accelerator setup as a command: plan, ask, download, find devices, write config.json. Exit code. */
export async function setupCommand(o: SetupOptions): Promise<{ code: number; plan?: SetupPlan; entries?: Accelerator[] }> {
  const log = o.log ?? console.log;
  const configFile = o.configFile ?? acceleratorConfigFile();
  const file = readConfigFile(configFile);
  if (file.error) {
    log(`${file.error}. Fix or remove it first (or save the Settings page over it).`);
    return { code: 2 };
  }
  const detection = o.detection ?? (await detect());
  // What this PC has, for every program that reads Reeve's config: a model is never called the NPU on a PC without one.
  const hw = o.detection ? null : hardwareOf(detection);
  if (hw) rememberHardware(hw);
  log("Looking up llama.cpp's newest build and the models...");
  const plan = await planSetup({ detection, ids: o.ids, kinds: o.kinds, raw: file.raw, releases: await (o.releases ?? llamaReleases)(), hfFiles: o.hfFiles ?? hfFiles, home: o.home ?? toolsHome(), env: o.env, exists: o.io?.exists });
  for (const l of describePlan(plan)) log(l);
  const settingUp = plan.targets.some((t) => !t.problem) || !!plan.npu;
  if (!settingUp && !plan.dropNpu) {
    log('Nothing to set up.');
    return { code: plan.targets.length || o.ids.length ? 1 : 0, plan };
  }
  if (o.dryRun) {
    log('Dry run: nothing downloaded, config.json unchanged.');
    return { code: 0, plan };
  }
  if (settingUp && plan.downloadBytes && !o.yes) {
    const ok = o.confirm ? await o.confirm(`Download ${mb(plan.downloadBytes)}? [y/N] `) : false;
    if (!ok) {
      log(o.confirm ? 'Not downloading.' : `It would download ${mb(plan.downloadBytes)}: run again with --yes.`);
      return { code: 1, plan };
    }
  }
  const r = await runSetup(plan, file.raw, { log, ...o.io });
  for (const p of r.problems) log(`problem: ${p}`);
  if (!r.entries.length && !plan.dropNpu) return { code: 1, plan };
  const saved = writeConfigFile(configFile, r.raw, o.validate ?? validateKeeperConfig);
  if (saved.problems.length) {
    log(`config.json not written: ${saved.problems.join('; ')}`);
    return { code: 1, plan };
  }
  const read = readAccelerators(r.raw);
  const order = orderAccelerators(read.accelerators, read.order).map((a) => a.id);
  const changed = [...r.entries.map((e) => e.id), ...(plan.dropNpu ? ['npu removed'] : [])];
  log(`Wrote ${configFile}: ${changed.join(', ')}. Order: ${order.join(' > ') || (o.noneConfigured ?? 'none configured')}.`);
  return { code: r.problems.length || (settingUp && !r.entries.length) ? 1 : 0, plan, entries: r.entries };
}

// ------------------------------------------------------------------------------------------------
// The report: what this PC has, and what's configured

/** What `accelerators --json` gives (and the Settings pages show). */
export interface AcceleratorReport {
  detected: Detection;
  /** Detected accelerators in the auto order. */
  recommendedOrder: string[];
  /** Heiward's pick among the cards: the most memory of its own. */
  recommendedCard: string | null;
  configured: Accelerator[];
  /** The order requests try the configured ones in. */
  order: string[];
  acceleratorOrder: 'auto' | string[];
  legacy: boolean;
  configFile: string;
}

export function reportFrom(detection: Detection, raw: Record<string, any>, configFile = acceleratorConfigFile()): AcceleratorReport {
  const read = readAccelerators(raw);
  return {
    detected: detection,
    recommendedOrder: detectedAccelerators(detection).map((a) => a.id),
    recommendedCard: recommendedCard(detection.cards)?.id ?? null,
    configured: read.accelerators,
    order: orderAccelerators(read.accelerators, read.order).map((a) => a.id),
    acceleratorOrder: read.order,
    legacy: read.legacy,
    configFile,
  };
}

/** The report in lines; `setupHint` is the command (or page) that sets the rest up. */
export function printReport(r: AcceleratorReport, out: (s: string) => void = console.log, setupHint = 'accelerators setup, or the Settings page'): void {
  const d = r.detected;
  out('On this PC:');
  for (const c of d.cards) {
    out(`  ${c.name}  (${c.id})`);
    out(`    ${c.vendor}, ${c.memoryGb} GB of its own${c.memoryGb < 2 ? ` (shares the PC's ${Math.round(c.sharedBytes / 1024 ** 3)} GB)` : ''}, DXGI ${c.index}, LUID ${c.luid}${r.recommendedCard === c.id ? ', the card Heiward would pick' : ''}`);
  }
  if (!d.cards.length) out("  no graphics card (DXGI lists none but Windows' own)");
  const n = d.npu;
  const npuServer = n?.vendor === 'qualcomm' ? `; GenieX ${d.geniex ? `at ${d.geniex}` : 'not installed'}` : '';
  out(
    n
      ? `  ${n.name}  (npu)\n    ${n.label}, driver ${n.driver || '?'}${n.driverDate ? ` (${n.driverDate})` : ''}${npuServer}; ${n.supported ? `the manor runs models on it${n.verified ? '' : ' (not yet tried on this kind of NPU)'}` : `not used: ${n.why}`}`
      : "  no NPU (Windows lists no Neural processor)",
  );
  if (d.cpu) out(`  ${d.cpu.name}  (cpu)\n    ${d.cpu.arch}, ${d.cpu.cores} threads, ${Math.round(d.ramBytes / 1024 ** 3)} GB of memory`);
  for (const p of d.problems) out(`  (couldn't ask: ${p})`);
  out(`Recommended order: ${r.recommendedOrder.join(', ') || '(nothing found)'}`);
  out('');
  out(`Configured (${r.configFile}${r.legacy && r.configured.length ? ', the old single endpoint read as an accelerator' : ''}):`);
  if (!r.configured.length) out('  none');
  const byId = new Map(r.configured.map((a) => [a.id, a]));
  for (const id of r.order) {
    const a = byId.get(id)!;
    const what = SERVE_KINDS.filter((k) => serves(a, k)).map((k) => `${k} ${a[k]!.model}`);
    out(`  ${a.name} (${a.id})${a.enabled === false ? ' [disabled]' : ''}: ${what.join(', ') || 'serves nothing yet'}; ${a.slots} slot${a.slots === 1 ? '' : 's'}, cap ${a.maxContextTokens} tokens${a.quirks.length ? `, quirks ${a.quirks.join(', ')}` : ''}`);
  }
  out(`Order: ${r.acceleratorOrder === 'auto' ? 'auto' : r.acceleratorOrder.join(', ')}${r.order.length ? ` (${r.order.join(' > ')})` : ''}`);
  const missing = r.recommendedOrder.filter((id) => id !== 'cpu' && !byId.has(id));
  if (missing.length) out(`Not set up yet: ${missing.join(', ')} (${setupHint})`);
}

/** Auto order of what's configured (for a Settings page's "recommended"). */
export const recommendedOf = (list: Accelerator[]) => autoOrder(list).map((a) => a.id);
