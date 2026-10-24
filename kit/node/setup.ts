import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Block, blockedExit, blockedExitSay, blockedIn, blockedSay, cpuVariantLoaded, keepCpuVariant, localPath, type SacState, saysBlockedExit, smartAppControlOutsideTests, stoppingBlocks } from './app-control.ts';
export { cpuVariantLoaded, keepCpuVariant } from './app-control.ts';
import { blockedFile, type BlockedServerFile, chatBody, ensureServer, expandEnv, fitPicture, lockDirsOf, npuNoteFile, postJson, readNpuNote, rememberBlocked, rememberHardware, rememberNpuNote, serverEnv, type ServerReady, visionBody, type WorkOrder } from './accelerators.ts';
import { type Accelerator, acceleratorConfigFile, type AcceleratorEntry, type Endpoint, entryOf, autoOrder, OWN_MEMORY_GB, orderAccelerators, isSharedTools, readAccelerator, readAccelerators, readConfigFile, ENDPOINT_KINDS, type EndpointKind, serverBase, serves, toolsHome, validateKeeperConfig, writeConfigFile } from './accelerator-config.ts';
import { type CatalogsDone, catalogsSay, ensureCatalogs } from './catalogs.ts';
import { type Detection, detect, detectedAccelerators, type GpuCard, hardwareOf, noNpu, recommendedCard } from './detect.ts';
import * as core from './core/index.js';
import { LockTimeout, withLock } from './lock.ts';
import { gpuWithNpu } from './manor.ts';
import { withAcceleratorTurn } from './npu-queue.ts';
import { NO_SPEEDS, type NpuFailStep, npuReportFile, npuReportFromSetup, type NpuSpeeds, rememberNpuReport, reporterId, skippedStep } from './npu-report.ts';
import { atVersion, calibrate, checkPinned, checkPowerTool, compareVersions, expandRoute, fallbackDevices, generationOf, installedVersion, isPulled, type MakerTerms, NPU_CATALOG, type NpuCatalog, type NpuMeasured, type NpuOffNpuFile, type NpuPlan, type NpuRoute, type NpuSignedCatalog, npuEntry, npuMemoryFit, npuRerank, npuTerms, pinnedRoute, planNpu, type PowerToolCheck, routeEnv, routeFor, runProgram, runsRoute, sha256File, smallPc, testImage, workOrderFor } from './npu-vendors.ts';
import { inAppData, type OutsideJob, type OutsideSetupResult, OutsideUnavailable, packagedOutsideTests, runOutside } from './outside.ts';
import { RETIRED_GRACE_MS } from './retired.ts';
import { rememberSignatures, signaturesFile } from './signatures.ts';

/**
 * Accelerator setup (Manor's Set up local AI, `smith accelerators setup`, Reeve's where there is no Smith, and their
 * Settings pages' Set up): the NPU first, then the graphics cards, then the processor. The NPU's own model server for its
 * maker (npu-vendors.ts: GenieX on a Snapdragon, OpenVINO Model Server on an Intel Core Ultra, FastFlowLM on an AMD
 * Ryzen AI 300), downloaded and checked against its pinned SHA-256, installed for this user, its models pulled, and its
 * entry written only once it has answered a test request; llama.cpp's server for each graphics card (and the
 * processor, when there's no card) from the build the kit pins (kit 2.97.0: LLAMA_PIN, the manor's signed copy of
 * ggml-org's build, SIGNED_LLAMA_REPO), the models as GGUF files from Hugging Face at the revisions the kit pins
 * (MODEL_PINS), every file checked against its pinned SHA-256, and an accelerator entry per card in config.json. It says
 * how much it will download, and whose terms come with it (Qualcomm's on a Snapdragon: SetupPlan's `terms`), and asks
 * first. An NPU entry a person configured is left as it is; on a PC with no NPU (or one the manor can't use) the one
 * install wrote by default (and only that one) is dropped.
 *
 * Planning is separate from downloading, and every answer it plans from (the pinned build as a release, the pinned
 * models as Hugging Face's file lists, `llama-server --list-devices`) is parsed or made by a function of its own, so
 * tests run on fixtures.
 */

export const LLAMA_REPO = 'ggml-org/llama.cpp';
/**
 * Where llama.cpp's builds come from (kit 2.90.0): ggml-org's own, each .exe and .dll ggml-org left unsigned signed by
 * the manor (the Steward's tools/sign-llama.ts), in the public releases repository as `llama.cpp-<build>`. Windows'
 * Smart App Control blocks unsigned files it doesn't know (app-control.ts): on 2026-10-19 it blocked one of b11734's
 * processor variants on the gaming desktop. Setup takes the one signed build the kit pins (LLAMA_PIN), never the
 * newest one there: a build reaches the PCs once it's signed, after the Smith's checks on it, and a kit pins it.
 */
export const SIGNED_LLAMA_REPO = 'Jcollier0120/Manor-releases';
export const signedLlamaTag = (build: string) => `llama.cpp-${build}`;
/** The builds variantFor names: the ones the manor signs. */
export const LLAMA_VARIANTS = ['cpu-x64', 'cpu-arm64', 'cuda-12.4-x64', 'vulkan-x64', 'opencl-adreno-arm64'];
/**
 * NVIDIA's CUDA runtime beside the CUDA build, taken from ggml-org's release as it is: NVIDIA's files, unsigned as NVIDIA
 * ships them, the same in every build, and not the manor's to sign. Smart App Control let them run on the desktop.
 */
export const CUDART_ZIP = 'cudart-llama-bin-win-cuda-12.4-x64.zip';
/** The first port a set-up server takes; each takes the next free one. */
export const FIRST_PORT = 18191;

// ------------------------------------------------------------------------------------------------
// Which llama.cpp build

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  /** "sha256:<hex>": the kit's pin (pinnedRelease), or what a release publishes. */
  digest?: string;
  /** Other places that serve the very same file, tried in turn when `url` fails: checked against the same size and digest. */
  mirrors?: string[];
}
export interface Release {
  tag: string;
  assets: ReleaseAsset[];
  /** The signed copy's tag in SIGNED_LLAMA_REPO (`llama.cpp-b11734`), where `tag` is its build (kit 2.90.0). */
  signed?: string;
}

/** A file the kit pins (kit 2.97.0): its size and SHA-256, which every download of it is checked against, whatever served it. */
export interface PinnedDownload {
  size: number;
  sha256: string;
  /** Where it's published, when not where its build or repository puts it. */
  url?: string;
  /** Other places that serve the very same file, tried in turn when the first fails: never trusted for their own word. */
  mirrors?: string[];
}

/**
 * The llama.cpp build setup downloads, and nothing else (kit 2.97.0): the manor's signed copy of ggml-org's b11734
 * (SIGNED_LLAMA_REPO's `llama.cpp-b11734`), each zip at the size and SHA-256 below, taken from a download checked on
 * 2026-10-22 against the release's own checksums.sha256 and GitHub's digests. It is the build the manor has tested: the
 * only one signed, the one every PC set up since kit 2.90.0 runs, and the one that ran on an RTX 4080 SUPER with all
 * three models passing the Smith's 13 checks (CUDA, 2026-10-19); its processor build ran on that desktop too, and the
 * Adreno's is past OLDEST_BUILD. NVIDIA's CUDA runtime comes from ggml-org's release of the same build, as it is
 * (CUDART_ZIP). A newer build reaches the PCs only with a kit that pins it: the Steward's tools/sign-llama.ts prints
 * the pin of the build it signs.
 */
export const LLAMA_PIN: { build: string; signed: string; files: Record<string, PinnedDownload> } = {
  build: 'b11734',
  signed: 'llama.cpp-b11734',
  files: {
    'llama-b11734-bin-win-cpu-x64.zip': { size: 20606927, sha256: '2d66250dce46edf0a195d194aa244c751ae9dac053368d7f7258695e98347a58' },
    'llama-b11734-bin-win-cpu-arm64.zip': { size: 13105961, sha256: 'd2d0e82beb311017f26990d95cd4a33e12d44f1dc07e75476a26f9b4ae49b1a7' },
    'llama-b11734-bin-win-cuda-12.4-x64.zip': { size: 273862567, sha256: '70d726e7cd7028ee1a05c5434cc1a5b7b776f9c54eb0039a8b2fa9091c34567b' },
    'llama-b11734-bin-win-vulkan-x64.zip': { size: 33424789, sha256: '283ee8dda415f3d79d366b70e6caf5065e97a58dcfe710d9e9795af6c65ae75e' },
    'llama-b11734-bin-win-opencl-adreno-arm64.zip': { size: 13687227, sha256: '9d11dd805d0d9405f482ed9dde2233c42220e1c3c56efa856e01779952b29e03' },
    'cudart-llama-bin-win-cuda-12.4-x64.zip': {
      size: 391443627,
      sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11734/cudart-llama-bin-win-cuda-12.4-x64.zip',
    },
  },
};

/**
 * Castellan's signed catalogs of what setup takes beside llama.cpp's builds as its maker ships it (catalogs.ts, kit
 * 2.108.0): NVIDIA's CUDA runtime (CUDART_ZIP), which NVIDIA doesn't sign. Installed before a CUDA build first runs,
 * where Smart App Control is on (runSetup).
 */
export const LLAMA_CATALOGS: NpuSignedCatalog[] = [
  { serverVersion: '12.4', file: 'castellan-cuda-cudart-12.4.cat', covers: "NVIDIA's CUDA runtime 12.4's 3 unsigned program files", size: 10889, sha256: 'fa1928dff519d83cccdea138a66f46cde8478c74f17e70779b1907cfd5e25b57' },
];

/** A pinned build as setup plans from it: a release whose assets are its files, each with its pinned digest. Nothing is asked of GitHub. */
export function pinnedRelease(pin: typeof LLAMA_PIN = LLAMA_PIN): Release {
  return {
    tag: pin.build,
    signed: pin.signed,
    assets: Object.entries(pin.files).map(([name, f]) => ({
      name,
      size: f.size,
      url: f.url ?? `https://github.com/${SIGNED_LLAMA_REPO}/releases/download/${pin.signed}/${name}`,
      digest: `sha256:${f.sha256}`,
      ...(f.mirrors?.length ? { mirrors: [...f.mirrors] } : {}),
    })),
  };
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
    if (vendor === 'nvidia') return { variant: 'cuda-12.4-x64', cudart: CUDART_ZIP, backend: 'CUDA' };
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

/**
 * The oldest build a variant may be, where older ones serve SMALL_SPEC wrong. On an Adreno X2-90 (driver 32.0.172.2,
 * 2026-10-17), b11511's OpenCL build turned Qwen3-VL-2B's answers to garbage after their first token or so with flash
 * attention on, llama-server's default: 5 of the Smith's 13 checks right. b11715 got all 13, as b11511 did with flash
 * attention off (about 1.3 GB more of the PC's memory); Qwen3-4B and Qwen3-VL-4B were right on both builds.
 */
export const OLDEST_BUILD: Readonly<Record<string, number>> = { 'opencl-adreno-arm64': 11715 };

/**
 * The newest build (b<number>, newest first as GitHub lists them) that has every asset needed, and is no older than any
 * of its variants' OLDEST_BUILD; a build still uploading lacks some. Setup gives it the pinned build alone
 * (pinnedRelease), so it says whether the pin has what these accelerators need.
 */
export function pickRelease(releases: Release[], variants: Variant[]): { release: Release; assets: ReleaseAsset[] } | null {
  for (const r of releases) {
    if (!/^b\d+$/.test(r.tag)) continue;
    if (variants.some((v) => Number(r.tag.slice(1)) < (OLDEST_BUILD[v.variant] ?? 0))) continue;
    const names = variants.flatMap((v) => [assetName(r.tag, v.variant), ...(v.cudart ? [v.cudart] : [])]);
    const assets = [...new Set(names)].map((n) => r.assets.find((a) => a.name === n));
    if (assets.every((a): a is ReleaseAsset => !!a && !!a.url)) return { release: r, assets };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Which models

/** A model to download: its name (llama-server's alias), the repos it's looked for in, its file, and a projector to see with. */
export interface ModelSpec {
  model: string;
  repos: string[];
  file: RegExp;
  mmproj?: RegExp[];
}

/**
 * Each kind's model, Qwen's own GGUF repos first, then well-known quantizers. Chat's and vision's are what kits before
 * 2.89.0 set up on cards with memory of their own, Qwen3-4B beside Qwen3-VL-4B: setup now gives every accelerator
 * SMALL_SPEC for both (specFor), and the keeper's look knows an older kit's pair by them (withChatOnVision). Setup finds
 * a model only among the files the kit pins (MODEL_PINS, kit 2.97.0), so of these repos only the pinned one answers: the
 * quantizers' files are files of their own, never the same as Qwen's.
 */
export const MODEL_SPECS: Record<EndpointKind, ModelSpec> = {
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
 * Chat's and vision's model on every accelerator llama.cpp runs: Qwen3-VL-2B, one server for both. It was measured
 * against Qwen3-4B and Qwen3-VL-4B (2026-10-17) on 34 of the manor's kind of requests, then pictures and text in turn, on
 * a Core Ultra 5 225U's Intel Graphics and processor, a Radeon 860M and an Adreno X2-90 (shared memory and the processor,
 * from kit 2.83.0); and on an RTX 4080 SUPER, CUDA, b11734 (2026-10-19; cards with memory of their own, from kit 2.89.0).
 * - Its answers were as good: the Smith's 13 checks right, as both 4Bs'; 16 of 18 tasks right (15 on the Adreno), where
 *   Qwen3-4B got 16 and Qwen3-VL-4B 15. Its one slip of its own: it read a command line's `-ngl 99` as its context.
 * - It wrote 1.8 to 2.2 times as fast and read 2.4 to 2.6 times as fast; on the 4080 SUPER, 332 tokens a second against
 *   Qwen3-4B's 180.
 * - Its server held 3.3 to 3.7 GB of the PC's memory, where Qwen3-VL-4B's held 5.0 to 5.5 and Qwen3-4B's another 3.5 to
 *   4.0 beside it; on the 4080 SUPER at -c 16384, 3,932 MiB of the card, where the two 4B servers held 9,780.
 * - Pictures: it read the Smith's check picture (513 × 512) right; at 512 × 512 it misread it, as Qwen3-VL-4B did.
 */
export const SMALL_SPEC: ModelSpec = {
  model: 'qwen3-vl-2b-instruct',
  repos: ['Qwen/Qwen3-VL-2B-Instruct-GGUF', 'unsloth/Qwen3-VL-2B-Instruct-GGUF', 'bartowski/Qwen_Qwen3-VL-2B-Instruct-GGUF'],
  file: /(^|\/)(Qwen_)?Qwen3-?VL-2B-Instruct-Q4_K_M\.gguf$/i,
  mmproj: [/(^|\/)mmproj[^/]*Q8_0\.gguf$/i, /(^|\/)mmproj[^/]*(F16|f16)\.gguf$/i],
};

/**
 * The model setup gives a kind: SMALL_SPEC for chat and vision on every accelerator (cards with memory of their own too,
 * from kit 2.89.0), else MODEL_SPECS'.
 */
export function specFor(kind: EndpointKind): ModelSpec {
  return kind === 'chat' || kind === 'vision' ? SMALL_SPEC : MODEL_SPECS[kind];
}

/** SMALL_SPEC's model at any quantization: the one model its projector reads. */
const SMALL_MODEL_FILE = /(^|[/\\])(Qwen_)?Qwen3-?VL-2B-Instruct-[^/\\]*\.gguf$/i;

/**
 * The NPU's own copy of SMALL_SPEC's model (kit 2.100.0), which a graphics card and the processor run in place of
 * SMALL_SPEC's Q4_K_M, so the PC keeps one copy of Qwen3-VL-2B: on a Snapdragon X2, GenieX's Q4_0 (unsloth's, the very
 * file GenieX serves on the NPU: the route's offNpu), where GenieX's cache has it at its pinned size. SMALL_SPEC's own
 * Q8_0 projector stays beside it: GenieX's F16 one holds 0.35 GB more, and on the processor took 0.77 s a picture where
 * the Q8_0 takes 0.43. Measured on the X2 Elite Extreme (2026-10-23, llama.cpp b11734, setup's flags) against the
 * Q4_K_M: on the Adreno, 66 tokens a second written (67 to 71), 1,024 tokens read in 0.82 s (0.85 to 0.87), a picture in
 * 0.34 s (0.29 to 0.31), the same 3.2 GB of its memory; on the processor, written as fast (64 to 70, against 61 to 70 in
 * turn), read in 1.25 to 1.30 s (1.47 to 1.77), pictures as fast, 0.1 GB less; 22 of 24 answers and 4 of 4 pictures right
 * everywhere, as before. Null where there is no such file, or `home` is the PC's shared folder (an Everyone install),
 * where another account couldn't read the copy in this one's profile. Without `detection` (the keeper's look), any
 * route's copy of it that is there at its pinned size.
 */
export function npuChatFile(o: { detection?: Detection; home: string; env?: Record<string, string | undefined>; fileSize: (p: string) => number; catalog?: NpuCatalog }): (NpuOffNpuFile & { path: string }) | null {
  const catalog = o.catalog ?? NPU_CATALOG;
  if (isSharedTools(o.home, o.env ?? process.env)) return null;
  let files: NpuOffNpuFile[];
  if (o.detection) {
    const det = o.detection.npu;
    const generic = det?.supported && det.vendor ? catalog.routes[det.vendor] : undefined;
    if (!det || !generic?.offNpu) return null;
    const route = routeFor(pinnedRoute(generic, det.generation), det.generation, smallPc(o.detection.ramBytes));
    const chat = route.models.find((m) => m.kinds.includes('chat'));
    files = chat ? (generic.offNpu.models[chat.id]?.files ?? []) : [];
  } else files = Object.values(catalog.routes).flatMap((r) => Object.values(r.offNpu?.models ?? {}).flatMap((m) => m.files));
  for (const f of files) {
    if (f.role !== 'model' || !f.present || !SMALL_MODEL_FILE.test(f.file)) continue;
    const at = expandRoute(f.present, { tools: o.home, env: o.env });
    if (o.fileSize(at) === f.size) return { ...f, path: at };
  }
  return null;
}

/**
 * The kinds every graphics card serves unless others are asked for. A reranker isn't one of them: it is an add-on, set
 * up only when asked for (`--serve rerank`), beside whatever its accelerator already serves (runSetup).
 */
export const DEFAULT_KINDS: readonly EndpointKind[] = ['chat', 'vision', 'embed'];

export interface ModelFile {
  /** Its spec's model (ModelSpec): one file can serve two kinds (SMALL_SPEC's chat and vision). */
  model: string;
  role: 'model' | 'mmproj';
  repo: string;
  file: string;
  url: string;
  size: number;
  sha256?: string;
  /** Other places that serve the very same file (Download's). */
  mirrors?: string[];
  /** Where it already is, used there and never downloaded: the NPU's own copy (npuChatFile). Else the models folder. */
  path?: string;
}

/** A repository's file as setup plans from it: Hugging Face's list, or the kit's pin, which gives where to fetch it. */
export interface HfFile {
  file: string;
  size: number;
  sha256?: string;
  /** Where to fetch it, at a pinned revision; else the repository's main. */
  url?: string;
  mirrors?: string[];
}

/** Hugging Face's file list for a repo (GET /api/models/<repo>?blobs=true): name, size, and the LFS sha256. */
export function parseHfFiles(json: any): HfFile[] {
  return (json?.siblings ?? []).map((s: any) => ({ file: String(s.rfilename), size: Number(s.size ?? s.lfs?.size) || 0, sha256: s.lfs?.sha256 }));
}

/** A model file the kit pins (kit 2.97.0): its repository at one revision (a commit, never a branch), its size and SHA-256. */
export interface ModelPin extends PinnedDownload {
  repo: string;
  revision: string;
  file: string;
}

/**
 * The model files setup downloads, and nothing else (kit 2.97.0): each at a Hugging Face commit, its size and SHA-256
 * taken from a download of that commit checked on 2026-10-22 against Hugging Face's own record of it. They are the files
 * setup took before (the first repository in each spec that had one), so a PC set up already has them. None of the
 * quantizers' repositories holds the very same file (unsloth's, bartowski's, lmstudio-community's and ggml-org's
 * Qwen3-VL-2B are each their own quantization), so none is a mirror.
 */
export const MODEL_PINS: readonly ModelPin[] = [
  { repo: 'Qwen/Qwen3-VL-2B-Instruct-GGUF', revision: '52d6c8ffea26cc873ac5ad116f8631268d7eb503', file: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf', size: 1107409952, sha256: '089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae' },
  { repo: 'Qwen/Qwen3-VL-2B-Instruct-GGUF', revision: '52d6c8ffea26cc873ac5ad116f8631268d7eb503', file: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf', size: 445053216, sha256: 'f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82' },
  { repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF', revision: '370f27d7550e0def9b39c1f16d3fbaa13aa67728', file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', size: 639150592, sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439' },
  { repo: 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF', revision: 'a02f48bb4f057028298c21fa033da2b30d7742d5', file: 'qwen3-reranker-0.6b-q8_0.gguf', size: 639153184, sha256: '22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48' },
];

/** Where a pinned model file is fetched: its repository at its revision. */
export const pinnedModelUrl = (p: ModelPin) => `https://huggingface.co/${p.repo}/resolve/${p.revision}/${p.file}`;

/**
 * The pinned files of a repository as Hugging Face's file list would give them, each with where it's fetched (setup's
 * default, kit 2.97.0: nothing is asked of Hugging Face); null for a repository the kit pins nothing in.
 */
export async function pinnedHfFiles(repo: string, pins: readonly ModelPin[] = MODEL_PINS): Promise<HfFile[] | null> {
  const mine = pins.filter((p) => p.repo === repo);
  return mine.length ? mine.map((p) => ({ file: p.file, size: p.size, sha256: p.sha256, url: p.url ?? pinnedModelUrl(p), ...(p.mirrors?.length ? { mirrors: [...p.mirrors] } : {}) })) : null;
}

/** The first repo that has each model's file (and, for one that sees, a projector): what to download. A kind stands for its MODEL_SPECS'. */
export async function findModels(wanted: (EndpointKind | ModelSpec)[], files: (repo: string) => Promise<HfFile[] | null>): Promise<{ models: ModelFile[]; problems: string[] }> {
  const models: ModelFile[] = [];
  const problems: string[] = [];
  for (const want of wanted) {
    const spec = typeof want === 'string' ? MODEL_SPECS[want] : want;
    let found = false;
    for (const repo of spec.repos) {
      const list = await files(repo).catch(() => null);
      if (!list) continue;
      const main = list.find((f) => spec.file.test(f.file));
      const proj = spec.mmproj ? spec.mmproj.map((re) => list.find((f) => re.test(f.file))).find(Boolean) : undefined;
      if (!main || (spec.mmproj && !proj)) continue;
      const picks: [ModelFile['role'], HfFile][] = [['model', main], ...(proj ? [['mmproj', proj] as [ModelFile['role'], HfFile]] : [])];
      for (const [role, f] of picks) {
        models.push({ model: spec.model, role, repo, file: f.file, url: f.url ?? `https://huggingface.co/${repo}/resolve/main/${f.file}`, size: f.size, sha256: f.sha256, ...(f.mirrors?.length ? { mirrors: f.mirrors } : {}) });
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

/**
 * Each server's context, in tokens, as sizing counts it: chat's is cap × slots. Its startCommand (acceleratorEntry) sets
 * the same, but the embedding server's, which starts at EMBED_CONTEXT: sizing still counts that one at 8192, with
 * SERVER_GB's compute buffer at -ub 2048, so every card is sized as it was before it started smaller.
 */
export function serverContext(kind: EndpointKind, s: { slots: number; maxContextTokens: number }): number {
  return kind === 'chat' ? s.maxContextTokens * s.slots : kind === 'vision' ? Math.max(8192, s.maxContextTokens) : 8192;
}

/** The embedding server's context, in tokens. */
const EMBED_CONTEXT = 4096;
/**
 * The cap on a request to the embedding server, in the kit's estimate (3 characters a token): an input under it is at
 * most 4,095 characters, so it fits EMBED_CONTEXT even at a token a character (code and unusual text come close).
 * The agents' longest is Reeve's cluster item, about 2,060 characters.
 */
export const EMBED_CAP = Math.floor(EMBED_CONTEXT / 3);

/** llama-server's flag that keeps the vision encoder (the projector, `--mmproj`) on the processor. */
export const ENCODER_ON_PROCESSOR = '--no-mmproj-offload';

/**
 * Whether a card's vision server encodes pictures on the processor (ENCODER_ON_PROCESSOR) while its language model
 * stays on the card: Intel's integrated graphics on llama.cpp's Vulkan build. On a Core Ultra 5 225U's Intel Graphics
 * (driver 32.0.101.8831, builds b11624 and b11669, 2026-10-15) the encoder lost the device (`ggml_vulkan: device lost`)
 * at llama.cpp's warm-up, so the server exited as it started. With `--no-warmup` it started, read the Smith's check
 * picture (290 tokens), then lost the device on a 1,920 × 1,200 screenshot (2,309 tokens); so did flash attention off,
 * cooperative matrices off (GGML_VK_DISABLE_COOPMAT) and pictures capped at 1,024 tokens. On the processor it was ready
 * in 5 s and read the check picture in 6 s, the screenshot in 93 s and one twice its size in 228 s, at below-normal
 * priority on a busy PC. A card is Intel's by its id (every Intel adapter's name starts with Intel), and integrated
 * when it has under OWN_MEMORY_GB of its own, as sizing counts it; Intel's cards with memory of their own (Arc A and B)
 * weren't measured, and keep the encoder on the card. Such a card's vision also caps a picture (PICTURE_CAP) and has
 * its own time (VISION_ON_PROCESSOR_TIMEOUTS).
 */
export function encodesOnProcessor(card: { id: string; memoryGb?: number; device: string | null }): boolean {
  return card.id.startsWith('gpu-intel-') && (card.memoryGb ?? 0) < OWN_MEMORY_GB && /^Vulkan\d*$/.test(card.device ?? '');
}

/**
 * llama-server's flag capping the tokens a picture is encoded into, and the cap when the processor encodes them
 * (encodesOnProcessor). Measured there through the kit's own requests (b11669, 2026-10-15, below-normal priority on a
 * busy PC), a picture's first question took: a 720 × 1,600 phone screenshot 27 s uncapped (1,188 tokens), 29 s capped
 * (1,025); a 1,920 × 1,200 desktop one 89 s uncapped (2,318), 31 s capped (1,038); one twice its size 29 s capped.
 * Every answer was the same either way (a heading quoted, a count, a window title, a percentage, a clock), and a
 * question again on the same picture took 1 to 2 s (llama-server keeps it).
 */
export const PICTURE_CAP = '--image-max-tokens';
export const PICTURE_TOKENS = 1024;

/**
 * Vision's own time on those cards: a background request may take 90 s and 0.3 s a token it answers, three times the
 * slowest first question measured (PICTURE_TOKENS), where the rules' 15 s would fail Reeve's screens' 4-token questions
 * and mark the card failed, its chat too, for ten minutes. Their chat keeps the rules'.
 */
export const VISION_ON_PROCESSOR_TIMEOUTS = { requestBaseMs: 90_000 } as const;

/**
 * Whether the processor encodes an accelerator's pictures, so its vision caps them (PICTURE_CAP) and has its own time
 * (VISION_ON_PROCESSOR_TIMEOUTS): a card that encodes on the processor, and the processor itself, which sees with
 * SMALL_SPEC. On the Core Ultra 5 225U's processor (b11669, 2026-10-17), Qwen3-VL-2B read the Smith's check
 * picture in 5.6 s and a small table in 3.2 s.
 */
export function picturesOnProcessor(e: { kind?: 'gpu' | 'cpu'; id: string; memoryGb?: number; device: string | null }): boolean {
  return e.kind === 'cpu' || encodesOnProcessor(e);
}

/**
 * llama-server's RAM cache of earlier prompts' states, turned off. By default it keeps up to 8,192 MiB of them in the PC's
 * memory, for each server, beside what the card holds. On a Core Ultra 5 225U's Intel Graphics (b11669, 2026-10-16), the
 * chat server held 4.54 GB after 34 of the manor's kind of requests with it and 3.59 GB without, with the same answers,
 * in 111 s rather than 118 s. The agents share little more than a short system prompt, and a slot still reuses its own
 * last prompt. It's given in the server's environment (LLAMA_ARG_CACHE_RAM): a build from before the flag ignores that,
 * where it would refuse `--cache-ram` and not start.
 */
export const NO_RAM_CACHE: Readonly<Record<string, string>> = { LLAMA_ARG_CACHE_RAM: '0' };

/** The PC's memory, in GB, from which a card that encodes on the processor keeps its chat on a server of its own (chatsOnVision). */
export const CHAT_ON_VISION_RAM_GB = 32;

/**
 * Whether a card an older kit set up with Qwen3-4B and Qwen3-VL-4B moves its chat onto its vision server
 * (withChatOnVision): one Qwen3-VL-4B for both, on chat's endpoint, with vision's flags, in place of a Qwen3-4B beside
 * it. Setup itself gives every accelerator one SMALL_SPEC server for both (shared memory and the processor from kit
 * 2.83.0, cards from 2.89.0); this moves only a PC that hasn't been set up again since, without a download, until its
 * next setup brings the 2B. That is a card that encodes on the processor
 * (encodesOnProcessor: Intel's integrated graphics, whose memory is the PC's) on a PC with under
 * CHAT_ON_VISION_RAM_GB. On a Core Ultra 5 225U with 15.4 GB
 * (b11669, 2026-10-16), the chat server held 3.5 GB and the vision server 5.0 GB, both of the PC's memory, so the two at
 * once came to 8.5 GB of it and the one server to 5.0. On text the one server wrote as fast (12.5 tokens a second
 * against 11.1 to 12.4) and passed the Smith's golden, determinism and prefix-leak checks (13 of 13, as Qwen3-4B did),
 * but got 15 of 18 of the manor's kind of tasks right against Qwen3-4B's 16: it found the wrong line in a 2,700-token
 * log, and its sum was wrong where Qwen3-4B's was right (but for its working shown). A picture, text, then a picture
 * again all answered on the one server.
 * From kit 2.89.0 it is also every card with memory of its own (OWN_MEMORY_GB), whatever the PC's memory. On an RTX
 * 4080 SUPER (CUDA, b11734, 2026-10-19), with the same harness, Qwen3-VL-4B passed the 13 checks and got 15 of the 18
 * tasks against Qwen3-4B's 16, its wrong answers the ones it gave on the 225U and the Adreno; and at the card's own flags
 * (-c 16384, two slots) the one server held 5,969 MiB of the card where the two held 4,942 and 4,838, and wrote 177
 * tokens a second against Qwen3-4B's 180.
 * `device` may be the build's backend before its device's number is known.
 */
export function chatsOnVision(card: { id: string; memoryGb?: number; device: string | null }, ramGb: number): boolean {
  return (card.memoryGb ?? 0) >= OWN_MEMORY_GB || (encodesOnProcessor(card) && ramGb < CHAT_ON_VISION_RAM_GB);
}

/**
 * A server's own flags after its model, by kind: what it serves, its context and batch, one request at a time but chat's.
 * A vision server that chat runs on too (`withChat`) takes chat's slots, and the larger of the two contexts.
 */
function kindFlags(kind: EndpointKind, e: Pick<EntryInput, 'id' | 'kind' | 'memoryGb' | 'device' | 'slots' | 'maxContextTokens'>, mmproj: string | undefined, model: string, withChat = false): string[] {
  switch (kind) {
    case 'chat':
      return ['-c', String(serverContext('chat', e)), '--parallel', String(e.slots), '--jinja', '--alias', model];
    case 'vision': {
      const context = withChat ? Math.max(serverContext('chat', e), serverContext('vision', e)) : serverContext('vision', e);
      return ['--mmproj', portablePath(mmproj ?? ''), ...(encodesOnProcessor(e) ? [ENCODER_ON_PROCESSOR] : []), ...(picturesOnProcessor(e) ? [PICTURE_CAP, String(PICTURE_TOKENS)] : []), '-c', String(context), '--parallel', String(withChat ? e.slots : 1), '--jinja', '--alias', model];
    }
    case 'embed':
      // The compute buffer grows with -c × -ub: at -c 8192 -ub 8192 it was one 4.7 GB allocation, which the Adreno
      // X2-90's OpenCL refused ("failed to allocate compute pp buffers"). At -c 4096 -ub 512 (b11669, 2026-10-15) a
      // Radeon 860M's server held 1,278 MB of the card's memory against 1,891 at -c 8192 -ub 2048, with the same
      // vectors (cosine 1.000000) and times (28 ms a query, 288 ms Reeve's longest, 2.2 s for 2,694 tokens): an
      // input longer than a micro-batch is split across several.
      return ['--embeddings', '--pooling', 'last', '-c', String(EMBED_CONTEXT), '-b', '2048', '-ub', '512', '--parallel', '1', '--alias', model];
    case 'rerank':
      // A question and one document a pass, each well under a micro-batch (Reeve sends 1,600 chars of a file).
      return ['--reranking', '-c', String(serverContext('rerank', e)), '-b', '2048', '-ub', '2048', '--parallel', '1', '--alias', model];
  }
}

/**
 * What each server takes on a card besides its context, in GB: the model, its compute buffers and its process's share
 * of the card. Chat's and vision's are SMALL_SPEC's, measured on an RTX 4080 SUPER (CUDA, b11734, 2026-10-19) as what
 * the card held with the server up less its KV cache: Qwen3-VL-2B alone 1,387 MiB, with its projector 2,140 MiB, the
 * one server for both (cardNeedGb). The embedding model's and the reranker's are estimates from the files (Q8_0, 0.64
 * GB, with a compute buffer of about 1.2 at -ub 2048), kept although the embedding server held 1,340 MiB there at its
 * smaller -c 4096 -ub 512 (serverContext).
 */
export const SERVER_GB: Record<EndpointKind, number> = { chat: 1.4, vision: 2.1, embed: 1.85, rerank: 1.85 };
/**
 * The KV cache at f16, a token, for every model setup gives a card: 28 layers × 8 KV heads × 128 × K and V × 2 bytes
 * (Qwen3-VL-2B's, and the 0.6B models'). On the 4080 SUPER the 2B's server held 1,800 MiB more at -c 32768 than at 16384.
 */
const KV_BYTES = 114_688;
/** What a card keeps for the desktop and the programs on it. A game gets the rest back from the reaper, which stops the card's servers while it plays. */
export const DESKTOP_GB = 1.5;
/** The sizes tried on a card of its own, largest first. */
const CARD_SIZES = [
  { slots: 2, maxContextTokens: 16384 },
  { slots: 2, maxContextTokens: 8192 },
  { slots: 1, maxContextTokens: 8192 },
  { slots: 1, maxContextTokens: 4096 },
];

/**
 * The memory a card's servers take at once, by those estimates, in GB. Chat and vision together are one server
 * (chatOnVision): vision's, at the larger of their contexts.
 */
export function cardNeedGb(kinds: EndpointKind[], s: { slots: number; maxContextTokens: number }): number {
  const shared = kinds.includes('chat') && kinds.includes('vision');
  const context = (k: EndpointKind) => (shared && k === 'vision' ? Math.max(serverContext('chat', s), serverContext('vision', s)) : serverContext(k, s));
  return kinds.filter((k) => !(shared && k === 'chat')).reduce((sum, k) => sum + SERVER_GB[k] + (context(k) * KV_BYTES) / 1024 ** 3, 0);
}

export interface Sizing {
  slots: number;
  maxContextTokens: number;
  /** What it serves: those asked for, less any left off. */
  kinds: EndpointKind[];
  /** Asked for, but left off: they wouldn't fit on the card beside the others. */
  left?: EndpointKind[];
}

/**
 * Slots, the request cap and what it serves, from a card's memory: the largest size at which all its
 * servers (each running at once, every layer on the card) fit with DESKTOP_GB to spare. When none does,
 * vision is left off (the rarest request: chat's server then runs without the projector, at its own context), unless it was asked for
 * by name (`keepKinds`); when still none does, the smallest. A card that shares the PC's memory goes by
 * the PC's, and the processor serves one request at a time.
 */
export function sizing(t: { kind: 'gpu' | 'cpu'; memoryGb?: number; ramGb?: number; kinds?: EndpointKind[]; keepKinds?: boolean }): Sizing {
  const kinds = t.kinds ?? [...DEFAULT_KINDS];
  if (t.kind === 'cpu') return { slots: 1, maxContextTokens: 4096, kinds };
  const own = t.memoryGb ?? 0;
  if (own < OWN_MEMORY_GB) return { ...((t.ramGb ?? 0) >= 32 ? { slots: 1, maxContextTokens: 8192 } : { slots: 1, maxContextTokens: 4096 }), kinds };
  const room = own - DESKTOP_GB;
  const tries = t.keepKinds || !kinds.includes('vision') || kinds.length === 1 ? [kinds] : [kinds, kinds.filter((k) => k !== 'vision')];
  const withLeft = (ks: EndpointKind[]) => (ks.length < kinds.length ? { kinds: ks, left: kinds.filter((k) => !ks.includes(k)) } : { kinds: ks });
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
  /** Each kind's model file, its projector, and its name (specFor's; MODEL_SPECS' for the kind when not given). */
  models: Partial<Record<EndpointKind, { path: string; mmproj?: string; model?: string }>>;
  ports: Partial<Record<EndpointKind, number>>;
  slots: number;
  maxContextTokens: number;
  /**
   * Chat on the vision server (one SMALL_SPEC server for both): chat's port runs
   * vision's model and flags, with chat's slots and context, and vision has no server of its own.
   */
  chatOnVision?: boolean;
}

/**
 * The config.json entry: one llama-server per kind it serves, each on its own port, pinned to its device; or, chat on
 * the vision server (`chatOnVision`), one for both on chat's port, and vision on it. No name: an accelerator's name
 * comes from the PC (the core's acceleratorName), never from config.json.
 */
export function acceleratorEntry(e: EntryInput): AcceleratorEntry {
  const a: AcceleratorEntry = { id: e.id, kind: e.kind, slots: e.slots, maxContextTokens: e.maxContextTokens, quirks: [] };
  if (e.memoryGb !== undefined) a.memoryGb = e.memoryGb;
  const server = portablePath(e.server);
  const pin = e.device ? ['--device', e.device, '-ngl', '99'] : ['-ngl', '0'];
  const shared = !!(e.chatOnVision && e.models.vision && e.ports.chat);
  for (const kind of ENDPOINT_KINDS) {
    // Vision on chat's server: the core's endpointFor gives it chat's.
    if (shared && kind === 'vision') {
      a.vision = { model: e.models.vision!.model ?? MODEL_SPECS.vision.model, ...(picturesOnProcessor(e) ? { timeouts: { ...VISION_ON_PROCESSOR_TIMEOUTS } } : {}) };
      continue;
    }
    // The server it runs: vision's, for chat on it.
    const runs: EndpointKind = shared && kind === 'chat' ? 'vision' : kind;
    const m = e.models[runs];
    const port = e.ports[kind];
    if (!m || !port) continue;
    const model = m.model ?? MODEL_SPECS[runs].model;
    const common = ['--host', '127.0.0.1', '--port', String(port), ...pin, '-m', portablePath(m.path)];
    a[kind] = { baseUrl: `http://127.0.0.1:${port}`, model, startCommand: [server, ...common, ...kindFlags(runs, e, m.mmproj, model, runs !== kind)], env: { ...NO_RAM_CACHE } };
    if (kind === 'embed') a.embed!.maxContextTokens = Math.min(EMBED_CAP, e.maxContextTokens);
    if (kind === 'vision' && picturesOnProcessor(e)) a.vision!.timeouts = { ...VISION_ON_PROCESSOR_TIMEOUTS };
  }
  return a;
}

/**
 * An entry just set up, with what its accelerator had that this setup didn't set up kept: a reranker is an add-on, so
 * setting one up keeps the rest of the accelerator's entry (its servers, slots and cap), and setting the others up again
 * keeps its reranker. A card's kinds left to the NPU (`leftToNpu`, Manor's gpuWithNpu off) keep what it had for them:
 * an install set up before keeps its servers and files, never removed. Anything else is set up afresh, as before.
 */
export function keepingAddOns(made: AcceleratorEntry, had: Accelerator | AcceleratorEntry | undefined, kinds: readonly EndpointKind[], leftToNpu: readonly EndpointKind[] = []): AcceleratorEntry {
  if (!had) return made;
  if (kinds.every((k) => k === 'rerank')) return { ...entryOf(had), ...(made.rerank ? { rerank: made.rerank } : {}) };
  const out: AcceleratorEntry = had.rerank && !made.rerank && !kinds.includes('rerank') ? { ...made, rerank: had.rerank } : made;
  const keep = leftToNpu.filter((k) => had[k] && !out[k]);
  if (!keep.length) return out;
  const was = entryOf(had);
  return { ...out, ...Object.fromEntries(keep.map((k) => [k, was[k]])) };
}

/** The kinds of an accelerator's entry that a setup of `kinds` keeps (keepingAddOns): their ports stay theirs. */
export function keptKinds(had: Accelerator | undefined, kinds: readonly EndpointKind[], leftToNpu: readonly EndpointKind[] = []): EndpointKind[] {
  if (!had) return [];
  if (kinds.every((k) => k === 'rerank')) return ENDPOINT_KINDS.filter((k) => k !== 'rerank' && had[k]?.baseUrl);
  const rerank: EndpointKind[] = had.rerank?.baseUrl && !kinds.includes('rerank') ? ['rerank'] : [];
  return [...rerank, ...leftToNpu.filter((k) => !kinds.includes(k) && had[k]?.baseUrl)];
}

/** Ports already taken by configured endpoints. */
export function usedPorts(list: Accelerator[]): Set<number> {
  const out = new Set<number>();
  for (const a of list) {
    for (const ep of ENDPOINT_KINDS.map((k) => a[k])) {
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

/**
 * config.json with this PC's `workOrder` (kit 2.111.0): its NPU generation's order for each work (workOrderFor), or
 * none when it records none. Nothing else changes, and nothing at all when it's the same.
 */
export function withWorkOrder(raw: Record<string, any>, order: WorkOrder | null): Record<string, any> {
  if (JSON.stringify(raw.workOrder ?? null) === JSON.stringify(order)) return raw;
  const out = { ...raw };
  if (order) out.workOrder = order;
  else delete out.workOrder;
  return out;
}

// ------------------------------------------------------------------------------------------------
// The plan

export interface Download {
  what: string;
  url: string;
  size: number;
  /** Its pinned SHA-256: download refuses a file without one (kit 2.97.0), and a file that isn't this one. */
  sha256?: string;
  /** Other places that serve the very same file, tried in turn when `url` fails: each checked against the same size and SHA-256. */
  mirrors?: string[];
  /** The file it's saved as (a .zip is unpacked into `unpackTo`). */
  dest: string;
  unpackTo?: string;
  /** The file in `unpackTo` that says it was unpacked there (llama-server.exe, cudart64_12.dll). */
  marker?: string;
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
  ports: Partial<Record<EndpointKind, number>>;
  kinds: EndpointKind[];
  /** Asked for, but left off: they wouldn't fit on the card beside the others (sizing). */
  left?: EndpointKind[];
  /**
   * Left to the NPU beside it (Manor's gpuWithNpu off, kit 2.69.0): the card isn't set up for them, and an entry it
   * had for them is kept as it was (keepingAddOns), never removed.
   */
  leftToNpu?: EndpointKind[];
  /** Its chat runs on its vision server, one model for both (specFor's): vision has no port of its own. */
  chatOnVision?: boolean;
  /** Filled in once its build is here (llama-server --list-devices). */
  device?: string | null;
  problem?: string;
}

export interface SetupPlan {
  /** The NPU's server and models to set up (npu-vendors.ts' planNpu), or null. */
  npu: NpuPlan | null;
  /** Why the NPU isn't set up this time, when this PC has one: unsupported, already configured, or missing something. */
  npuNote?: string;
  /** Why the NPU, or its embeddings, won't be used, in words for the person (npuNoteFor), when the plan already knows. */
  npuPlain?: string;
  /** Why the NPU is left out before anything is set up, as its report's code (npu-report.ts): unsupported, its driver, or memory. */
  npuLeftOut?: NpuFailStep;
  /**
   * The reranker on the NPU (kit 2.100.0): its route's rerankServer, on the port it had or its route's, made from the
   * NPU's embed endpoint once that is written, and tested (runSetup). Absent: a reranker asked for goes to the cards or
   * the processor, as before.
   */
  npuRerank?: { route: NpuRoute; port: number; label: string };
  /** Each graphics card's work left to the NPU (gpuWithNpu off): not set up on it. A card the NPU would leave nothing (a Snapdragon's) is set up whole, as before, so isn't here. */
  leftToNpu?: { id: string; name: string; kinds: EndpointKind[] }[];
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
  /**
   * The makers' terms that come with what it downloads (kit 2.97.0), each once: Qualcomm's on a Snapdragon, when GenieX
   * or an AI Hub model is to be downloaded (npu-vendors.ts' npuTerms). Named, with their links, before anything is
   * downloaded: describePlan's lines, and an app's own page from these. None when nothing it downloads has any.
   */
  terms: MakerTerms[];
  problems: string[];
  serversDir: string;
  modelsDir: string;
}

export interface PlanInput {
  detection: Detection;
  /** Ids asked for; none: every graphics card (the processor too when there's no card and no NPU). */
  ids: string[];
  /** What each card serves (default all three; the processor chats and sees, and reranks when asked). */
  kinds?: EndpointKind[];
  /** config.json's content now. */
  raw: Record<string, any>;
  /** llama.cpp's builds to pick from: the pinned one alone (pinnedRelease), but in tests. */
  releases: Release[];
  /** Each repository's files: the pinned ones (pinnedHfFiles), but in tests. */
  hfFiles: (repo: string) => Promise<HfFile[] | null>;
  /** Where servers and models go (toolsHome: the accelerators' folder, or %USERPROFILE%\.reeve on a PC set up before). */
  home: string;
  /** The environment the NPU route's paths are expanded from (tests give one). */
  env?: Record<string, string | undefined>;
  /** %LOCALAPPDATA%, where install's default GenieX entry starts geniex.exe from. */
  localAppData?: string;
  exists?: (p: string) => boolean;
  fileSize?: (p: string) => number;
  /** Leave the NPU out of this plan (setup's second pass, after the NPU failed: the processor takes its work). */
  skipNpu?: boolean;
  /** Exactly what the processor serves (setup's second pass), over its defaults. */
  cpuKinds?: EndpointKind[];
  /**
   * Manor's "Use the graphics card for models when there's an NPU" (manor.ts's gpuWithNpu(); setupCommand reads it).
   * False: a card beside an NPU is set up only for the work no NPU serves (the core's cardWorkBesideNpu, the rule
   * requests and the keeper follow), unless kinds are asked for by name. Left out, or true: every card as before.
   */
  gpuWithNpu?: boolean;
  /** The version of the NPU route's server installed here (npu-vendors.ts' installedVersion by default): a later one the Smith's Use it left is set up as that version runs. */
  serverVersion?: (route: NpuRoute) => Promise<string | null>;
  /** The keeper's last look at the NPU's entry (`npu-refresh.json`, readNpuRefresh): `needs-setup` has setup set it up again. */
  npuRefresh?: NpuRefreshRecord | null;
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
  let npuPlain: string | undefined;
  let npuLeftOut: NpuFailStep | undefined;
  // An entry the keeper's look left for setup (`needs-setup`, npu-refresh.ts: this kit's command for it needs a download,
  // such as Intel's Qwen3-VL-2B in the Qwen3-4B's place, kit 2.103.0, which a look never makes) is set up again, so
  // Set up local AI makes the change. So is one on its generation's fallback (the first-generation X Elite's
  // Qwen3-VL-4B, where its 2B failed): setup tries the generation's own models again, and failing, sets the fallback up
  // again quietly (setUpNpu), while the keeper's look keeps it as it is. Only an entry on the route's server, as the
  // look's was. Its test failing keeps the old entry (mergeEntries); a new model that doesn't fit beside everything else
  // leaves it as it is.
  const generic0 = det?.supported && det.vendor ? NPU_CATALOG.routes[det.vendor] : undefined;
  const onRoute = !!generic0 && !!configuredNpu && !installDefault && runsRoute(configuredNpu, generic0, o.home);
  const onFallback = onRoute && !!generationOf(generic0!, det!.generation)?.fallback?.models.includes(configuredNpu!.chat?.model ?? '');
  const leftForSetup = onRoute && (o.npuRefresh?.did === 'needs-setup' || onFallback);
  const leftAsIs = `${det?.label} (npu): already set up in config.json; left as it is (accelerators setup npu sets it up again)`;
  if (det && !det.supported) {
    npuNote = `${det.label} (npu): not set up: ${det.why}. The graphics card or the processor takes its work.`;
    npuPlain = npuNoteFor(det.label, 'chat', det.why ?? 'the manor can\'t run its models on it');
    if (!o.skipNpu && (askedNpu || !o.ids.length)) npuLeftOut = skippedStep(det, false) ?? undefined;
  }
  // A reranker alone is no reason to set the NPU up: none of its servers reranks.
  else if (det && !o.skipNpu && (askedNpu || (!o.ids.length && (!configuredNpu || installDefault || leftForSetup) && kinds.some((k) => k !== 'rerank')))) {
    // Only what fits in this PC's memory beside everything else (npuMemoryFit, at this generation's sizes): the rest
    // goes to the card or the processor.
    // Its generation's own models (a Snapdragon X2: Qwen3-VL-2B), and on a PC with little memory its smallPc ones, where it has any.
    // At the server's version on this PC: a later GenieX the Smith's Use it left is set up as that version runs.
    const small = smallPc(o.detection.ramBytes);
    const generic = det.vendor ? NPU_CATALOG.routes[det.vendor] : null;
    const version = generic ? await (o.serverVersion ?? ((r: NpuRoute) => installedVersion(r, { tools: o.home, env: o.env, exists })))(generic) : null;
    const route = generic ? routeFor(atVersion(pinnedRoute(generic, det.generation), version), det.generation, small) : null;
    const fit: { chat: boolean; embed: boolean; why?: string } = route ? npuMemoryFit(route, o.detection.ramBytes) : { chat: true, embed: true };
    if (!askedNpu && leftForSetup && !fit.chat) npuNote = leftAsIs;
    else if (!fit.chat) {
      npuNote = `${det.label} (npu): not set up: ${fit.why}. The graphics card or the processor takes its work.`;
      npuPlain = npuNoteFor(det.label, 'chat', fit.why!);
      npuLeftOut = 'memory';
    } else {
      const plan = (fallback: boolean) => planNpu({ support: det, tools: o.home, downloadsDir: path.join(o.home, 'servers', 'downloads'), env: o.env, exists, noEmbed: !fit.embed, cards: o.detection.cards, small, serverVersion: version, fallback });
      npu = plan(false);
      // Its generation's fallback (the first-generation X Elite's Qwen3-VL-4B), set up only should its own models fail.
      const fallback = npu && generic && generationOf(generic, det.generation)?.fallback ? plan(true) : null;
      if (npu && fallback && npuMemoryFit(fallback.route, o.detection.ramBytes).chat) npu.fallback = fallback;
      if (!fit.embed && route?.embedServer) {
        npuNote = `${det.label} (npu): its embeddings not set up: ${fit.why}. The graphics card or the processor makes them.`;
        npuPlain = npuNoteFor(det.label, 'embed', fit.why!);
      }
    }
  } else if (det && configuredNpu) npuNote = leftAsIs;
  if (askedNpu && !det && !dropNpu) problems.push(noNpu(o.detection) ? 'npu: this PC has no NPU' : "npu: couldn't tell whether this PC has an NPU");
  // What the NPU will serve (set up now, or configured before).
  const npuServes = new Set<EndpointKind>(npu ? npu.kinds : det?.supported && configuredNpu && !installDefault ? ENDPOINT_KINDS.filter((k) => serves(configuredNpu, k)) : []);
  // The reranker on the NPU (kit 2.100.0), where its route runs one on its embedding server's program (a Snapdragon's
  // llama.cpp on the Hexagon, npu-vendors.json's rerankServer) and the NPU has that server, set up now or before: when
  // it's asked for with no accelerator named (or the NPU named), and kept when the NPU is set up again. Not on a PC with
  // little memory (smallPc), whose NPU servers already give way to its chat: the reranker goes where it went before.
  const rerankRoute = det?.supported && det.vendor && !o.skipNpu && !smallPc(o.detection.ramBytes) && (askedNpu || !o.ids.length) ? (npu?.route ?? NPU_CATALOG.routes[det.vendor]) : undefined;
  const hasEmbedServer = !!rerankRoute && (npu ? !!npu.embed : !!configuredNpu && !installDefault && !!npuRerank(rerankRoute, configuredNpu.embed, { tools: o.home, file: '', model: '' }));
  const rerankOnNpu = !!rerankRoute?.rerankServer && hasEmbedServer && (kinds.includes('rerank') || (!!npu && !!configuredNpu?.rerank));
  // What the cards and the processor are asked for: the rest.
  const restKinds = rerankOnNpu ? kinds.filter((k) => k !== 'rerank') : kinds;

  // Which accelerators. Every graphics card serves all three, as before: the NPU comes first for what it serves, and a
  // card takes it only when the NPU can't (too big, or failed lately). With no card, the processor chats and sees (one
  // SMALL_SPEC server) when the NPU doesn't chat, and makes the embeddings when the NPU chats but serves none (Intel's and
  // AMD's routes).
  const cards = o.detection.cards;
  let wanted = (o.ids.length ? o.ids : cards.map((c) => c.id)).filter((id) => id !== 'npu');
  const cpuDefault: EndpointKind[] = !npuServes.has('chat') ? ['chat', ...(npuServes.has('vision') ? [] : ['vision' as const])] : !npuServes.has('embed') ? ['embed'] : [];
  // Beside an NPU, with Manor's switch off, a card is never asked for the NPU's work (the keeper keeps it out): none of it is set up on the card.
  const besideNpu = o.gpuWithNpu === false && npuServes.size > 0 && !o.kinds?.length;
  const leftToNpu: NonNullable<SetupPlan['leftToNpu']> = [];
  if (!o.ids.length && !cards.length && o.detection.cpu && cpuDefault.length) wanted = ['cpu'];
  const targets: SetupTarget[] = [];
  for (const id of wanted) {
    const card = cards.find((c) => c.id === id);
    if (!card && id !== 'cpu') {
      problems.push(`${id}: no such graphics card on this PC (${cards.map((c) => c.id).join(', ') || 'none found'})`);
      continue;
    }
    const kind = card ? 'gpu' : 'cpu';
    // The processor chats and sees, on one SMALL_SPEC server (and reranks, when asked: a 0.6B reranker runs well enough on it).
    const cpuKinds = o.cpuKinds?.length ? o.cpuKinds : o.kinds?.length || o.ids.includes('cpu') || !cpuDefault.length ? restKinds.filter((k) => k === 'chat' || k === 'vision' || k === 'rerank') : cpuDefault;
    // A card the NPU leaves nothing to (a Snapdragon's, whose NPU serves all three) is set up whole, as before: the
    // switch is offered only beside a configured card, and the person can't turn on a card that has no entry.
    const besideKinds = card && besideNpu ? core.cardWorkBesideNpu(restKinds, [...npuServes]) : restKinds;
    const cardKinds = besideKinds.length ? besideKinds : restKinds;
    // Only the reranker asked for, and the NPU takes it: nothing for this one to do.
    if (rerankOnNpu && !(card ? cardKinds : cpuKinds).length) continue;
    const left = card ? restKinds.filter((k) => !cardKinds.includes(k)) : [];
    if (left.length) leftToNpu.push({ id, name: card!.name, kinds: left });
    const size = sizing({ kind, memoryGb: card?.memoryGb, ramGb, kinds: kind === 'cpu' ? cpuKinds : cardKinds, keepKinds: !!o.kinds?.length });
    const v = variantFor({ kind, vendor: card?.vendor, arch });
    const t: SetupTarget = {
      id,
      kind,
      name: card?.name ?? o.detection.cpu?.name ?? 'Processor',
      memoryGb: card?.memoryGb,
      vendor: card?.vendor,
      ...size,
      ports: {},
      ...(left.length ? { leftToNpu: left } : {}),
    };
    if ('none' in v) t.problem = v.none;
    else {
      t.variant = v;
      // One SMALL_SPEC server for chat and vision, on chat's port: on a card with memory of its own too, from kit 2.89.0.
      if (size.kinds.includes('chat') && size.kinds.includes('vision')) t.chatOnVision = true;
    }
    targets.push(t);
  }

  // Which build.
  const variants = targets.filter((t) => t.variant).map((t) => t.variant!);
  const picked = variants.length ? pickRelease(o.releases, variants) : null;
  if (variants.length && !picked) problems.push(`the llama.cpp build this kit pins (${o.releases.map((r) => r.tag).join(', ') || 'none'}) has no ${[...new Set(variants.map((v) => v.variant))].join(', ')}`);
  const build = picked?.release.tag ?? null;
  const downloads: Download[] = [];
  if (picked) {
    for (const t of targets.filter((t) => t.variant)) {
      // A signed build's folder is named by its signed tag, so a PC set up with ggml-org's unsigned copy gets it anew.
      t.folder = path.join(serversDir, `${picked.release.signed ?? build}-${t.variant!.variant}`);
      for (const name of [assetName(build!, t.variant!.variant), ...(t.variant!.cudart ? [t.variant!.cudart] : [])]) {
        if (downloads.some((d) => d.what === name && d.unpackTo === t.folder)) continue;
        const asset = picked.assets.find((a) => a.name === name)!;
        const marker = name.startsWith('cudart') ? path.join(t.folder, 'cudart64_12.dll') : path.join(t.folder, 'llama-server.exe');
        downloads.push({
          what: name,
          url: asset.url,
          size: asset.size,
          sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined,
          ...(asset.mirrors?.length ? { mirrors: asset.mirrors } : {}),
          dest: path.join(serversDir, 'downloads', name.replace(/^cudart-llama-bin/, `cudart-${build}`)),
          unpackTo: t.folder,
          marker,
          have: exists(marker),
        });
      }
    }
  }

  // Which models: each target's (specFor), each once; a projector only where one sees (SMALL_SPEC chatting alone hasn't one).
  const seeing = targets.some((t) => t.variant && t.kinds.includes('vision'));
  const needed = [...new Set([...targets.filter((t) => t.variant).flatMap((t) => t.kinds.map((k) => specFor(k))), ...(rerankOnNpu ? [MODEL_SPECS.rerank] : [])])].map((s) => (s.mmproj && !seeing ? { ...s, mmproj: undefined } : s));
  const found = needed.length ? await findModels(needed, o.hfFiles) : { models: [], problems: [] };
  problems.push(...found.problems);
  // SMALL_SPEC's model where the NPU keeps a copy of it (npuChatFile, kit 2.100.0): that file, in place of the Q4_K_M.
  const own = found.models.some((m) => m.model === SMALL_SPEC.model && m.role === 'model') ? npuChatFile({ detection: o.detection, home: o.home, env: o.env, fileSize }) : null;
  if (own) {
    const i = found.models.findIndex((m) => m.model === SMALL_SPEC.model && m.role === 'model');
    found.models[i] = { model: SMALL_SPEC.model, role: 'model', repo: own.repo, file: own.file, url: pinnedModelUrl(own), size: own.size, sha256: own.sha256, path: own.path };
  }
  for (const m of found.models) {
    if (m.path) continue;
    const dest = path.join(modelsDir, path.basename(m.file));
    // The NPU's embedding server downloads the same file first (it's set up first): once is enough.
    const npuGets = npu?.embed?.modelDownload?.dest.toLowerCase() === dest.toLowerCase();
    downloads.push({ what: `${m.repo}/${m.file}`, url: m.url, size: m.size, sha256: m.sha256, ...(m.mirrors?.length ? { mirrors: m.mirrors } : {}), dest, have: npuGets || (fileSize(dest) === m.size && m.size > 0) });
  }

  // Ports: an accelerator keeps its own; a new one takes the next free from 18191.
  const current = readAccelerators(dropNpu ? withoutNpu(o.raw, localAppData) : o.raw).accelerators;
  const taken = usedPorts(current.filter((a) => !targets.some((t) => t.id === a.id)));
  // What a target keeps (a reranker set up alone keeps the rest; the rest set up again keep the reranker) keeps its ports.
  for (const t of targets) {
    const mine = current.find((a) => a.id === t.id);
    for (const k of keptKinds(mine, t.kinds, t.leftToNpu)) taken.add(Number(new URL(serverBase(mine![k]!.baseUrl!)).port));
  }
  let next = FIRST_PORT;
  for (const t of targets.filter((t) => t.variant)) {
    const mine = current.find((a) => a.id === t.id);
    // The kinds it had first, so one it gains (the switch turned on) never takes the port of one it keeps.
    // Chat on the vision server takes the port its vision server had, where that model already runs (as the keeper's
    // withChatOnVision does), and vision takes none.
    const was = (k: EndpointKind): string | undefined => (t.chatOnVision && k === 'chat' ? (mine?.vision?.baseUrl ?? mine?.chat?.baseUrl) : mine?.[k]?.baseUrl);
    const hadOne = (k: EndpointKind) => (was(k) ? 1 : 0);
    for (const k of [...t.kinds].filter((k) => !(t.chatOnVision && k === 'vision')).sort((a, b) => hadOne(b) - hadOne(a))) {
      const had = was(k) ? Number(new URL(serverBase(was(k)!)).port) : 0;
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
  // Its reranker's: the one it had, else its route's, unless something else already has it.
  let npuRerankPlan: SetupPlan['npuRerank'];
  if (rerankOnNpu && rerankRoute?.rerankServer && det) {
    const had = configuredNpu?.rerank?.baseUrl ? Number(new URL(serverBase(configuredNpu.rerank.baseUrl)).port) : 0;
    let port = had || rerankRoute.rerankServer.port;
    if (!had && (taken.has(port) || port === npu?.port)) {
      while (taken.has(next) || next === npu?.port) next++;
      port = next;
    }
    npuRerankPlan = { route: rerankRoute, port, label: det.label };
  }
  const downloadBytes = downloads.filter((d) => !d.have).reduce((n, d) => n + d.size, 0) + (npu?.downloadBytes ?? 0);
  const terms = npu ? npuTerms(npu) : [];
  return { npu, ...(npuNote ? { npuNote } : {}), ...(npuPlain ? { npuPlain } : {}), ...(npuLeftOut ? { npuLeftOut } : {}), ...(npuRerankPlan ? { npuRerank: npuRerankPlan } : {}), ...(leftToNpu.length ? { leftToNpu } : {}), build, dropNpu, localAppData, targets, downloads, models: found.models, downloadBytes, terms, problems, serversDir, modelsDir };
}

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
export const mb = (bytes: number) => (bytes >= 1e9 ? gb(bytes) : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** The plan in a few lines: what it sets up, what it downloads, how much. */
export function describePlan(p: SetupPlan): string[] {
  const lines: string[] = [];
  if (p.dropNpu) lines.push("NPU (npu): removed from config.json. It's the GenieX server install wrote by default, and this PC has no NPU it can run on, so requests tried it first and failed.");
  if (p.npu) {
    const n = p.npu;
    lines.push(`${n.support.label} (npu): ${n.route.server} ${n.route.version}, ${n.kinds.join(' and ')} on ${n.port}; ${n.models.map((m) => m.id).join(', ')}${untried(n.support)}`);
    if (n.build) lines.push(`  get  ${n.route.server} ${n.route.version} (${mb(n.build.files.size + n.build.signed.size)}, SHA-256 pinned): its maker's files, with Castellan's signed copies of its own; no installer`);
    else lines.push(`  ${n.installed ? 'have' : 'get '} ${n.route.server} ${n.route.version} (${mb(n.route.download.size)}, SHA-256 pinned)${n.installed ? ` at ${n.exe}` : ''}`);
    if (n.runtime) lines.push(`  get  ${n.runtime.what} (${mb(n.runtime.size)}, SHA-256 pinned), beside ${path.win32.basename(n.exe)}: no administrator`);
    if (n.patch) lines.push(`  ${n.patch.have ? 'have' : 'get '} ${n.patch.what.split(':')[0]} (${mb(n.patch.patched.size)}, SHA-256 pinned), in place of the server's own ${n.patch.file}`);
    for (const m of n.models) lines.push(`  ${m.have ? 'have' : 'get '} ${m.id} (${mb(m.size)})`);
    const fb = n.fallback?.models;
    if (fb?.length) lines.push(`  should it not answer properly on this NPU: ${fb.map((m) => `${m.id} (${m.have ? 'here already' : mb(m.size)})`).join(', ')} in its place`);
    if (n.embed) {
      const es = n.embed.server;
      if (es.download) lines.push(`  ${n.embed.download ? 'get ' : 'have'} ${es.server} ${es.version} for embeddings on ${es.port} (${mb(es.download.size)}, SHA-256 pinned)`);
      else lines.push(`  a second ${es.server} for embeddings on ${es.port}`);
      const m = es.model;
      lines.push(`  ${n.embed.modelDownload || n.embed.modelPull ? 'get ' : 'have'} ${isPulled(m) ? m.id : m.file} (${mb(m.size)})`);
    }
  }
  if (p.npuNote) lines.push(p.npuNote);
  if (p.npuRerank) lines.push(`${p.npuRerank.label} (npu): reranks on ${p.npuRerank.port}, ${MODEL_SPECS.rerank.model} on its embedding server's ${p.npuRerank.route.embedServer?.server ?? 'program'}`);
  for (const t of p.targets) {
    if (t.problem) {
      lines.push(`${t.name} (${t.id}): skipped, ${t.problem}`);
      continue;
    }
    const serves = t.kinds
      .filter((k) => !(t.chatOnVision && k === 'vision'))
      .map((k) => (t.chatOnVision && k === 'chat' ? `chat and vision on ${t.ports.chat} (one ${specFor('vision').model} server)` : `${k} on ${t.ports[k]}`))
      .join(', ');
    lines.push(`${t.name} (${t.id}): llama.cpp ${p.build ?? '?'} ${t.variant?.variant}, ${t.slots} slot${t.slots === 1 ? '' : 's'}, ${t.maxContextTokens} tokens a request; ${serves}${t.device ? `; device ${t.device}` : ''}`);
    if (t.left?.length) lines.push(`  ${t.left.join(' and ')} left off: the card's ${t.memoryGb} GB won't hold it beside ${t.kinds.join(' and ')} at once (to have it anyway: accelerators setup --serve chat,vision,embed)`);
  }
  for (const l of p.leftToNpu ?? []) lines.push(`${l.name} (${l.id}): ${l.kinds.join(' and ')} not set up on it: the NPU does ${l.kinds.length === 1 ? 'that' : 'those'}, and "Use the graphics card for models when there's an NPU" is off`);
  for (const d of p.downloads) lines.push(`  ${d.have ? 'have' : 'get '} ${d.what} (${mb(d.size)})${d.sha256 ? '' : ', no pinned SHA-256: it won\'t be downloaded'}`);
  for (const m of p.models.filter((m) => m.path)) lines.push(`  have ${m.file} (${mb(m.size)}): the NPU's own copy, used where it is`);
  lines.push(p.downloadBytes ? `Download: ${mb(p.downloadBytes)} into ${path.dirname(p.serversDir)} and ${p.modelsDir}.` : 'Nothing to download.');
  lines.push(...termsLines(p.terms ?? []));
  for (const x of p.problems) lines.push(`note: ${x}`);
  return lines;
}

/**
 * The makers' terms in a few lines (kit 2.97.0), each maker's under a line of its own: what each covers, what it says,
 * and its link. Shown before anything is downloaded, wherever the plan is (the command, the Smith's page, Manor's welcome).
 */
export function termsLines(terms: readonly MakerTerms[]): string[] {
  const lines: string[] = [];
  for (const maker of [...new Set(terms.map((t) => t.maker))]) {
    lines.push(`${maker}'s terms come with what this downloads for the NPU: setting it up means you accept them, for everyone using this PC and your staff.`);
    for (const t of terms.filter((x) => x.maker === maker)) lines.push(`  ${t.what} (${t.url}): ${t.says}`);
  }
  return lines;
}

// ------------------------------------------------------------------------------------------------
// Doing it

/** A source's host, for saying which one served what. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Downloads a file whole (a .part, then a rename), only as the kit pins it (kit 2.97.0): its size and SHA-256 checked
 * whatever served it, from `url`, then each of its mirrors in turn when one fails or serves another file. A file with
 * no pinned SHA-256 is refused before anything is fetched, and so is one no source serves as pinned, with a plain
 * message; nothing of it is kept, and a file already at `dest` stays as it was.
 */
export async function download(d: Download, progress: (done: number, total: number) => void = () => {}, fetchImpl: typeof fetch = fetch): Promise<void> {
  const want = d.sha256?.toLowerCase();
  if (!want || !/^[0-9a-f]{64}$/.test(want)) throw new Error(`${d.what} wasn't downloaded: this kit pins no SHA-256 for it, and setup downloads only files it pins`);
  mkdirSync(path.dirname(d.dest), { recursive: true });
  const part = `${d.dest}.part`;
  const failed: string[] = [];
  for (const url of [d.url, ...(d.mirrors ?? [])]) {
    const why = await fetchOne(url, part, d, want, progress, fetchImpl).catch((e: any) => `couldn't be reached (${e?.cause?.message ?? e?.message ?? e})`);
    if (!why) {
      rmSync(d.dest, { force: true });
      renameSync(part, d.dest);
      return;
    }
    rmSync(part, { force: true });
    failed.push(`${hostOf(url)} ${why}`);
  }
  throw new Error(`${d.what} wasn't downloaded: ${failed.join('; ')}. Nothing was installed from it; setting up again tries once more`);
}

/** One source's copy into `part`: null once it is the pinned file, else why not (an answer that isn't the file, or another file). */
async function fetchOne(url: string, part: string, d: Download, want: string, progress: (done: number, total: number) => void, fetchImpl: typeof fetch): Promise<string | null> {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) return `answered ${res.status} ${res.statusText}`.trim();
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
  if (d.size && done !== d.size) return `served ${done} bytes where the kit pins ${d.size}: not the pinned file, so it was refused`;
  const sum = hash.digest('hex');
  if (sum !== want) return `served a file whose SHA-256 is ${sum}, not the ${want} the kit pins: refused`;
  progress(done, d.size);
  return null;
}

const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/**
 * Unpacks a release zip with Windows' own tar.exe into a folder (via a temporary one, so a half-unpacked build never
 * looks whole). A new folder is put in place whole, in one rename (kit 2.95.0): a setup ended halfway, or another
 * account's looking meanwhile, never finds its program without the files beside it. Into a folder that is there (a
 * second zip of one build), each file is moved in.
 */
export function unpack(zip: string, into: string): void {
  const tmp = `${into}.unpacking`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const r = spawnSync(tarExe, ['-x', '-f', zip, '-C', tmp], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar couldn't unpack ${zip}: ${r.stderr || r.error?.message}`);
  // Some zips wrap their files in a folder.
  const entries = readdirSync(tmp);
  putInPlace(entries.length === 1 && statSync(path.join(tmp, entries[0])).isDirectory() ? path.join(tmp, entries[0]) : tmp, into);
  rmSync(tmp, { recursive: true, force: true });
}

/** Moves a folder made beside `into` there: whole, in one rename, where nothing is there yet; else each of its files and folders in, in place of the one there. */
function putInPlace(from: string, into: string): void {
  if (!existsSync(into)) {
    mkdirSync(path.dirname(into), { recursive: true });
    renameSync(from, into);
    return;
  }
  for (const e of readdirSync(from)) {
    rmSync(path.join(into, e), { recursive: true, force: true });
    renameSync(path.join(from, e), path.join(into, e));
  }
}

/**
 * Puts Castellan's signed build of the NPU's server in place of its installer (kit 2.108.0, NpuSignedBuild): the
 * maker's zip of the version's files and Castellan's of the signed copies downloaded (each checked against its pinned
 * SHA-256), the server's folder taken from the maker's, the signed copies laid over it file by file, and the folder put
 * where the installer puts the server. Nothing of it runs while it's put together, and no installer runs at all. Null
 * when it's in place, else the step that failed and why.
 */
export async function installSignedBuild(server: string, b: NonNullable<NpuPlan['build']>, io: Pick<NpuIo, 'log' | 'download' | 'unpack' | 'overlay'>): Promise<{ step: 'download' | 'install'; why: string } | null> {
  for (const d of [b.files, b.signed]) {
    io.log(`downloading ${d.what} (${mb(d.size)})`);
    try {
      await (io.download ?? download)({ what: d.what, url: d.url, size: d.size, sha256: d.sha256, dest: d.dest, have: false }, (done, total) => io.log(`  ${d.what}: ${mb(done)} of ${mb(total)}`));
    } catch (e: any) {
      return { step: 'download', why: `${d.what}'s download failed: ${e?.message ?? e}` };
    }
  }
  // Beside where it goes, so a build put together halfway never looks like the server.
  const files = `${b.into}.files`;
  const signed = `${b.into}.signed`;
  const clear = () => {
    for (const f of [files, signed]) rmSync(f, { recursive: true, force: true });
  };
  clear();
  io.log(`putting ${server} together from ${b.files.what}, with Castellan's signed copies of its own files (no installer)`);
  try {
    (io.unpack ?? unpack)(b.files.dest, files);
    (io.unpack ?? unpack)(b.signed.dest, signed);
    const folder = path.join(files, b.files.folder);
    if (!existsSync(folder)) throw new Error(`${b.files.what} has no ${b.files.folder} folder`);
    const ours = readdirSync(signed, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(signed, path.join(e.parentPath, e.name)));
    (io.overlay ?? overlayFiles)(signed, folder, ours);
    putInPlace(folder, b.into);
  } catch (e: any) {
    clear();
    return { step: 'install', why: `${server} couldn't be put together: ${e?.message ?? e}` };
  }
  clear();
  for (const d of [b.files, b.signed]) rmSync(d.dest, { force: true });
  return null;
}

/**
 * How long a setup waits for another account's to finish putting files in the PC's shared folder (kit 2.95.0), and
 * how long that one may hold it before it counts as left behind. A holder whose process has ended is taken over at once.
 */
export const SHARED_SETUP_MS = 6 * 3600_000;

/** The lock taken while files go into the PC's shared tools home: one account's setup at a time. */
export const sharedSetupLock = (tools: string) => path.join(tools, 'locks', 'setup');

/**
 * Runs `fn` as the only one putting files in `tools`, where that is the PC's shared folder (an Everyone install,
 * kit 2.95.0: accelerator-config.ts' isSharedTools). Two accounts' setups started at once would otherwise download the
 * same few GB into one file, and unpack one build over the other. One that finds another's at it says so and waits,
 * then finds in place what that one put there. In an account's own folder `fn` just runs, as it always did.
 */
export async function inSharedTools<T>(tools: string, log: (line: string) => void, fn: (shared: boolean) => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (!isSharedTools(tools, env)) return fn(false);
  const dir = sharedSetupLock(tools);
  let entered = false;
  try {
    return await withLock(dir, () => ((entered = true), fn(true)), { waitMs: 0, staleMs: SHARED_SETUP_MS });
  } catch (e) {
    if (entered || !(e instanceof LockTimeout)) throw e;
  }
  log(`another account on this PC is putting the local AI's files in ${tools}: waiting for it`);
  return withLock(dir, () => fn(true), { waitMs: SHARED_SETUP_MS, staleMs: SHARED_SETUP_MS });
}

/** Whether a download's file (or, for a zip, its unpacked folder) is in place whole, as planSetup judges it. */
function inPlace(d: Download, exists: (p: string) => boolean): boolean {
  if (d.unpackTo) return !!d.marker && exists(d.marker);
  return d.size > 0 && exists(d.dest) && statSync(d.dest).size === d.size;
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
export async function runSetup(plan: SetupPlan, raw: Record<string, any>, io: SetupIo): Promise<{ raw: Record<string, any>; entries: Accelerator[]; problems: string[]; npu?: NpuSetup; rerank?: string[]; blocked?: BlockedServerFile[] }> {
  const problems: string[] = [];
  const entries: Accelerator[] = [];
  // What Windows blocked of the servers tried (the NPU's and each build's), file by file.
  const blocked: BlockedServerFile[] = [];
  // Castellan's catalogs of everything this run may start (kit 2.108.0), before any of it runs: the NPU's server's, and
  // NVIDIA's runtime beside a CUDA build (one the NPU's work may go to too), in one administrator prompt where Smart App
  // Control is on.
  const catalogs = catalogsOnce(io);
  const cuda = plan.targets.some((t) => t.variant?.cudart && t.folder) || (plan.leftToNpu ?? []).some((l) => /nvidia/i.test(l.name));
  const wanted = [...(plan.npu?.catalogs ?? []), ...(cuda ? LLAMA_CATALOGS : [])];
  if (wanted.length) await catalogs(wanted, [...(plan.npu?.catalogs?.length ? [plan.npu.vendor] : []), ...(cuda && LLAMA_CATALOGS.length ? ['cuda'] : [])], (io.smartAppControl ?? smartAppControlOutsideTests)());
  // The NPU first: its entry is written only once its server has answered a test request.
  let npu: NpuSetup | undefined;
  if (plan.npu) {
    npu = await setUpNpu(plan.npu, path.dirname(plan.modelsDir), { ...io, catalogs });
    blocked.push(...(npu.blocked ?? []));
    problems.push(...npu.problems);
    if (npu.entry) entries.push({ ...npu.entry, name: core.deviceName(plan.npu.support.label) });
  }
  // In the PC's shared folder, one account at a time; what another put in place meanwhile isn't downloaded again.
  await inSharedTools(path.dirname(plan.modelsDir), io.log, async (shared) => {
    for (const d of plan.downloads.filter((d) => !d.have)) {
      if (shared && inPlace(d, io.exists ?? existsSync)) {
        io.log(`${d.what}: already in place, from another account's setup`);
        continue;
      }
      io.log(`downloading ${d.what} (${mb(d.size)})`);
      await (io.download ?? download)(d, (done, total) => io.log(`  ${d.what}: ${mb(done)} of ${mb(total)}`));
      if (d.unpackTo) {
        (io.unpack ?? unpack)(d.dest, d.unpackTo);
        rmSync(d.dest, { force: true });
      }
    }
  });
  const modelPath = (spec: ModelSpec, role: 'model' | 'mmproj') => {
    const m = plan.models.find((x) => x.model === spec.model && x.role === role);
    return m ? (m.path ?? path.join(plan.modelsDir, path.basename(m.file))) : undefined;
  };
  for (const t of plan.targets) {
    if (t.problem || !t.variant || !t.folder) {
      if (t.problem) problems.push(`${t.id}: ${t.problem}`);
      continue;
    }
    const server = path.join(t.folder, 'llama-server.exe');
    let device: string | null = null;
    // Each build is asked once: its devices, and the processor variant ggml chose, the only one it keeps.
    const asked = Date.now();
    const listing = await (io.listDevices ?? listDevices)(server);
    // What Windows' application control blocked of the build as it listed its devices (app-control.ts): a processor
    // variant alone leaves it running on another (keepCpuVariant); anything else stops it (stoppingBlocks), and is kept
    // in blocked.json for a round of signing (kit 2.104.0).
    const blocks = await (io.blockedIn ?? blockedIn)(t.folder, Date.now() - asked + 60_000);
    const stopping = stoppingBlocks(blocks);
    const keepStopping = () => blocked.push(...stopping.map((b) => ({ ...b, file: localPath(b.file, t.folder!), server: 'llama.cpp' })));
    const removed = keepCpuVariant(t.folder, cpuVariantLoaded(listing));
    if (removed.length) io.log(`${t.name}: llama.cpp runs ${cpuVariantLoaded(listing)} on this processor; its ${removed.length} other processor variants are removed, so no start loads them again`);
    if (t.variant.backend) {
      const devices = parseListDevices(listing);
      device = matchDevice({ name: t.name }, devices, t.variant.backend);
      if (!device) {
        // Windows' Smart App Control may have blocked part of it (app-control.ts): said first, when its log says so.
        const said = blockedSay(blocks, 'llama.cpp');
        keepStopping();
        problems.push(`${t.id}: ${said ? `${said}. ` : ''}llama-server --list-devices names no device for ${t.name} (it lists ${devices.map((d) => `${d.name}: ${d.description}`).join('; ') || 'none'})`);
        continue;
      }
      t.device = device;
    } else if (stopping.length) {
      // The processor's build lists no device to tell by: the log alone says Windows stopped it.
      keepStopping();
      problems.push(`${t.id}: ${blockedSay(stopping, 'llama.cpp')}. The processor's llama.cpp can't run, so ${t.name} isn't set up`);
      continue;
    }
    const models: EntryInput['models'] = {};
    for (const k of t.kinds) {
      const spec = specFor(k);
      const p = modelPath(spec, 'model');
      if (p) models[k] = { path: p, mmproj: k === 'vision' ? modelPath(spec, 'mmproj') : undefined, model: spec.model };
    }
    // Named as detection named it, for the caller; config.json gets the entry without it (mergeEntries).
    const made = acceleratorEntry({ id: t.id, kind: t.kind, memoryGb: t.memoryGb, device, server, models, ports: t.ports, slots: t.slots, maxContextTokens: t.maxContextTokens, ...(t.chatOnVision ? { chatOnVision: true } : {}) });
    const had = readAccelerators(raw).accelerators.find((a) => a.id === t.id);
    entries.push({ ...keepingAddOns(made, had, t.kinds, t.leftToNpu), name: core.deviceName(t.name) });
    const serving = Object.keys(models).filter((k) => !(t.chatOnVision && k === 'chat')).map((k) => (t.chatOnVision && k === 'vision' ? 'chat and vision' : k));
    io.log(`${t.name}: ${device ? `device ${device}, ` : ''}${serving.join(', ')} on ${Object.values(t.ports).join(', ')}`);
  }
  // The NPU's reranker (kit 2.100.0): made from its embed endpoint as its entry now has it (set up just now, or before),
  // and written only once it has ranked a test question's answer first, in the NPU's turn. Otherwise it's left off,
  // with why (`rerank`), and setupCommand gives the reranker to the processor, as before.
  let rerankLeft: string[] | undefined;
  if (plan.npuRerank) {
    const file = modelPath(MODEL_SPECS.rerank, 'model');
    const at = entries.findIndex((e) => e.kind === 'npu');
    const base = at >= 0 ? entries[at] : readAccelerators(raw).accelerators.find((a) => a.kind === 'npu');
    const rerank = file && base ? npuRerank(plan.npuRerank.route, base.embed, { tools: path.dirname(plan.modelsDir), file, model: MODEL_SPECS.rerank.model, port: plan.npuRerank.port, portable: (p) => portablePath(p) }) : null;
    const bad = rerank ? await (io.testRerank ?? testNpuRerank)(rerank) : ["its embedding server isn't set up"];
    if (rerank && base && !bad.length) {
      // The entry as config.json has it, where setup didn't make it now: only its reranker is added.
      const own = at >= 0 || !Array.isArray(raw.accelerators) ? undefined : raw.accelerators.find((x: any) => x?.id === base.id);
      const e = { ...(own && typeof own === 'object' ? own : base), rerank };
      if (at >= 0) entries[at] = e;
      else entries.push(e);
      io.log(`${plan.npuRerank.label}: reranks on ${plan.npuRerank.port}`);
    } else rerankLeft = bad.map((b) => `${plan.npuRerank!.label}'s reranker: ${b}`);
  }
  return { raw: mergeEntries(plan.dropNpu ? withoutNpu(raw, plan.localAppData) : raw, entries), entries, problems, ...(npu ? { npu } : {}), ...(rerankLeft ? { rerank: rerankLeft } : {}), ...(blocked.length ? { blocked } : {}) };
}

/** What the NPU was set up to serve (chat, embeddings, its reranker) and its entry lacks: its test failed for them. */
export function npuMissing(plan: SetupPlan, entries: Pick<Accelerator, 'id' | 'kind' | EndpointKind>[]): EndpointKind[] {
  const got = entries.find((e) => e.kind === 'npu');
  const served = plan.npu ? (plan.npu.kinds.filter((k) => (k === 'chat' || k === 'embed') && !got?.[k]) as EndpointKind[]) : [];
  return [...served, ...(plan.npuRerank && !got?.rerank ? (['rerank'] as const) : [])];
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
  /**
   * The test request: problems, none when the server answered every kind it serves (and, with `seeRed`, saw its picture
   * red). Its options are testNpuEntry's, so an agent's own io that takes some of them (the Smith's `logFile`) still extends NpuIo.
   */
  testNpu?: (entry: AcceleratorEntry, o?: Parameters<typeof testNpuEntry>[1]) => Promise<string[]>;
  /** Stops whatever `program` serves `base` and waits until it's gone (keeper.ts' stopServerAt): between setup's tries of the NPU's models. */
  stopServer?: (program: string, base: string) => Promise<void>;
  /** The embedding server's test request (testNpuEmbed): problems, none when it gave a vector. */
  testEmbed?: (entry: AcceleratorEntry) => Promise<string[]>;
  /** The NPU's reranker's test request (testNpuRerank): problems, none when it ranked the passage that answers first. */
  testRerank?: (ep: Endpoint) => Promise<string[]>;
  /** Copies the route's server's files over the embedding server's (overlayFiles). */
  overlay?: (from: string, into: string, files: string[]) => number;
  /** Puts a signed build together where its installer would put the server (installSignedBuild). */
  installBuild?: typeof installSignedBuild;
  /** A file's SHA-256 (the pinned model files). */
  hash?: (file: string) => Promise<string>;
  /** Copies one file (the runtime's DLLs beside the server). */
  copy?: (from: string, to: string) => void;
  /**
   * The measuring requests on every NPU set up (measureNpu): its report's numbers, and on a generation nobody has
   * measured its calibration; null skips them (the NPU check measures its own).
   */
  measure?: (entry: AcceleratorEntry) => Promise<NpuMeasuring | { problems: string[] } | null>;
  /** The clock the first start is timed by, in milliseconds. Not `now`: an agent's own io that extends NpuIo may have a `now` of its own (the Smith's trial does, returning a Date). */
  clockMs?: () => number;
  /** Windows' application control's blocks in a folder (app-control.ts blockedIn): the NPU's server's, and each llama.cpp build's. */
  blockedIn?: (folder: string, withinMs: number) => Promise<Block[]>;
  /** Smart App Control's state, for the words a block is said in (smartAppControlOutsideTests: none in a test run). */
  smartAppControl?: () => SacState | null;
  /**
   * Castellan's signed catalogs installed where Smart App Control is on, and `routes`' older ones removed (catalogs.ts
   * ensureCatalogs): the NPU's server's, NVIDIA's runtime's. Setup asks once a run (catalogsOnce).
   */
  catalogs?: (wanted: NpuSignedCatalog[], routes: string[], sac: SacState | null) => Promise<CatalogsDone>;
}

const ONCE = Symbol('catalogsOnce');

/**
 * Setup's catalogs (catalogs.ts, kit 2.108.0): `io.catalogs` (ensureCatalogs where it gives none), with its line logged,
 * asked again only for a catalog it wasn't asked for before. So one run puts up one administrator prompt for everything
 * it starts, and one turned down isn't put up again for the NPU's second models or the card set up in its place.
 */
export function catalogsOnce(io: NpuIo): NonNullable<NpuIo['catalogs']> {
  const had = io.catalogs as (NpuIo['catalogs'] & { [ONCE]?: true }) | undefined;
  if (had?.[ONCE]) return had;
  const asked = new Set<string>();
  let last: CatalogsDone | null = null;
  const once = async (wanted: NpuSignedCatalog[], routes: string[], sac: SacState | null): Promise<CatalogsDone> => {
    if (last && wanted.every((c) => asked.has(c.file.toLowerCase()))) return last;
    for (const c of wanted) asked.add(c.file.toLowerCase());
    last = await (had ?? ((w: NpuSignedCatalog[], r: string[], s: SacState | null) => ensureCatalogs(w, { routes: r, sac: s, log: io.log })))(wanted, routes, sac);
    const said = catalogsSay(last);
    if (said) io.log(said);
    return last;
  };
  return Object.assign(once, { [ONCE]: true as const });
}

/**
 * Puts a route's runtime beside its server's program: its zip downloaded (checked against the pinned size and
 * SHA-256), unpacked into a folder of its own, and each of its files copied over. Problems in words; none when done.
 */
export async function installRuntime(rt: NonNullable<NpuPlan['runtime']>, io: NpuIo): Promise<string | null> {
  const exists = io.exists ?? existsSync;
  const d: Download = { what: rt.file, url: rt.url, size: rt.size, sha256: rt.sha256, dest: rt.dest, have: false };
  io.log(`downloading ${rt.what} (${mb(rt.size)}), to go beside ${rt.into}`);
  try {
    await (io.download ?? download)(d, (done, total) => io.log(`  ${d.what}: ${mb(done)} of ${mb(total)}`));
  } catch (e: any) {
    return `${rt.what}'s download failed: ${e?.message ?? e}`;
  }
  const tmp = `${rt.dest}.unpacked`;
  try {
    (io.unpack ?? unpack)(rt.dest, tmp);
    // unpack drops a zip's one wrapping folder: the files' folder is `from`, or `from` without its first part.
    const from = [rt.from, rt.from.split(/[\\/]/).slice(1).join('\\')].map((f) => path.join(tmp, f)).find((f) => rt.files.every((x) => exists(path.join(f, x))));
    if (!from) return `${rt.what} has no ${rt.files.join(', ')} in ${rt.from}`;
    for (const f of rt.files) (io.copy ?? copyFileSync)(path.join(from, f), path.join(rt.into, f));
  } catch (e: any) {
    return `${rt.what} couldn't be put beside the server: ${e?.message ?? e}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(rt.dest, { force: true });
  }
  return null;
}

/**
 * Puts the kit's build of a server file in place of the server's own (a route's hosted pluginPatch: OpenVINO GenAI's on
 * Intel), before a model is tested on it: downloaded unless it's kept already (checked against its pinned size and
 * SHA-256), then put in over the server's own file, which is kept as `.stock` (npu-patch.ts' putPatchIn). A file that is
 * neither the server's own nor the build (someone's own) is left as it is. The keeper's look keeps it there after, and
 * puts the server's own back when a later kit stops patching. Problems in words; none when done.
 */
export async function installPatch(p: NonNullable<NpuPlan['patch']>, tools: string, io: NpuIo): Promise<string | null> {
  const { patchTarget, putPatchIn } = await import('./npu-patch.ts');
  if (!p.have) {
    const d: Download = { what: path.basename(p.dest), url: p.patched.url!, size: p.patched.size, sha256: p.patched.sha256, dest: p.dest, have: false };
    io.log(`downloading ${p.what.split(':')[0]} (${mb(p.patched.size)})`);
    try {
      mkdirSync(path.dirname(p.dest), { recursive: true });
      await (io.download ?? download)(d, (done, total) => io.log(`  ${d.what}: ${mb(done)} of ${mb(total)}`));
    } catch (e: any) {
      return `${d.what}'s download failed: ${e?.message ?? e}`;
    }
  }
  const target = patchTarget(p, tools);
  const hash = io.hash ?? sha256File;
  if (!(io.exists ?? existsSync)(target)) {
    io.log(`${p.serverVersion} has no ${p.file} at ${target}, so the kit's build isn't put in`);
    return null;
  }
  try {
    const now = await hash(target);
    if (now === p.patched.sha256) return null;
    if (now !== p.stock.sha256) {
      io.log(`${target} is neither ${p.serverVersion}'s own nor the kit's build, so it stays as it is`);
      return null;
    }
    await putPatchIn(target, p.dest, p.patched.sha256, true, hash);
  } catch (e: any) {
    return `${path.basename(target)} couldn't be put in: ${e?.message ?? e}`;
  }
  io.log(`${path.basename(target)} is now the kit's build, its own kept as ${path.basename(target)}.stock`);
  return null;
}

/**
 * Copies `files` from `from` into `into` where what's there differs (missing, another size or time), keeping each
 * file's time so the next look finds them the same; how many it copied. Throws when one isn't in `from`.
 */
export function overlayFiles(from: string, into: string, files: string[]): number {
  let copied = 0;
  mkdirSync(into, { recursive: true });
  for (const f of files) {
    const src = path.join(from, f);
    const dst = path.join(into, f);
    const s = statSync(src, { throwIfNoEntry: false });
    if (!s) throw new Error(`${src} isn't there`);
    const d = statSync(dst, { throwIfNoEntry: false });
    if (d && d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2_000) continue;
    if (!d) mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    utimesSync(dst, s.atime, s.mtime);
    copied++;
  }
  return copied;
}

/**
 * The NPU's own embedding server (the route's embedServer), set up: its zip downloaded (checked against its pinned
 * SHA-256) and unpacked unless it's there, the route's server's files copied over it, its model downloaded unless it's
 * there (checked the same way), or pulled by the route's program (`env`, its environment) unless it's there and its
 * pinned files checked. Null when it's ready, else what failed. In the PC's shared folder (`shared`, inSharedTools), what
 * another account put in place meanwhile isn't downloaded again.
 */
async function setUpNpuEmbed(n: NpuPlan, tools: string, io: NpuIo, env: NodeJS.ProcessEnv, shared = false): Promise<string | null> {
  const e = n.embed!;
  const es = e.server;
  const progress = (what: string) => (done: number, total: number) => io.log(`  ${what}: ${mb(done)} of ${mb(total)}`);
  const here = (p: string) => shared && (io.exists ?? existsSync)(p);
  try {
    if (e.download && !here(e.exe)) {
      io.log(`downloading ${es.server} ${es.version} for the NPU's embeddings (${mb(e.download.size)})`);
      await (io.download ?? download)(e.download, progress(e.download.what));
      (io.unpack ?? unpack)(e.download.dest, e.folder);
      rmSync(e.download.dest, { force: true });
      if (!(io.exists ?? existsSync)(e.exe)) return `${e.exe} isn't there after unpacking`;
    }
    if (es.overlay) {
      const copied = (io.overlay ?? overlayFiles)(expandRoute(es.overlay.from, { tools }), e.folder, es.overlay.files);
      if (copied) io.log(`copied ${copied} of the NPU server's files into ${e.folder}`);
    }
    if (e.modelDownload && !isPulled(es.model) && !here(e.modelDownload.dest)) {
      io.log(`downloading ${es.model.file} (${mb(e.modelDownload.size)})`);
      mkdirSync(path.dirname(e.modelDownload.dest), { recursive: true });
      await (io.download ?? download)(e.modelDownload, progress(e.modelDownload.what));
    }
    if (isPulled(es.model)) {
      if (e.modelPull) {
        io.log(`downloading ${es.model.id} (${mb(es.model.size)}) with ${es.server}`);
        const r = await (io.run ?? runProgram)(e.exe, e.modelPull, { timeoutMs: 3600_000, env });
        if (r.code !== 0) return `${es.server} couldn't download ${es.model.id} (exit ${r.code}${r.out.trim() ? `: ${tail(r.out)}` : ''})`;
      }
      const bad = await checkPinned(es.model, n.support.generation, { tools, hash: io.hash });
      if (bad.length) return `${es.model.id} isn't the build that was checked: ${bad.join('; ')}`;
    }
  } catch (err: any) {
    return String(err?.message ?? err).split(/\r?\n/)[0];
  }
  return null;
}

/** The last lines of a program's output, for a problem's line. */
const tail = (out: string) => out.trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 300);

/** An Inno Setup server installer's log, in the tools home: kept when it fails, so it outlives a try's own folder. */
export const installerLogFile = (tools: string) => path.join(tools, 'npu-installer.log');

const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/**
 * Inno Setup's lines that say nothing about why it stopped: a question it answered Yes to goes on, and an EAbort only
 * follows the line that says why (Setup.MainFunc.pas).
 */
const INNO_ROUTINE = /^(Log (opened|closed)|Deinitializing Setup|Need to restart Windows|RestartManager found no applications|Defaulting to Yes for suppressed message box \(Yes\/No\)|(Caught|Got) EAbort exception)/i;
const INNO_BOX = /^Defaulting to \w+ for suppressed message box \([^)]*\):\s*/i;
const INNO_TELLING = /\b(fail(ed|s|ure)?|errors?|exception|abort(ed|ing)?|cannot|can't|unable|denied|returned False)\b/i;

/**
 * Why an Inno Setup installer stopped, from its log (/LOG), each entry a timestamped line joined with the indented ones
 * below it: the last message box it would have shown (its text alone: the installer's own words, "Uninstall failed
 * (ErrCode: 2)."), then its last telling line ("InitializeSetup returned False; aborting."). Its last two lines when
 * neither is there; empty when there's no log (it stopped before writing one).
 */
export function installerSaid(log: string): string {
  const entries: string[] = [];
  for (const line of log.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(.*)$/.exec(line);
    if (m) entries.push(m[1].trim());
    else if (line.trim() && entries.length) entries[entries.length - 1] += ` ${line.trim()}`;
  }
  const said = entries.filter((e) => !INNO_ROUTINE.test(e));
  const box = said.filter((e) => INNO_BOX.test(e)).at(-1)?.replace(INNO_BOX, '');
  const why = said.filter((e) => !INNO_BOX.test(e) && INNO_TELLING.test(e)).at(-1);
  const parts = box || why ? [box, why].filter((x): x is string => !!x) : said.slice(-2);
  return parts.join(' / ').slice(0, 300);
}

/**
 * Why the NPU, or only its embeddings, isn't used, in words for the person: setup's note, kept beside config.json
 * (rememberNpuNote) and shown with the accelerators. Never an alarm: its work goes to the graphics card or the processor.
 */
export function npuNoteFor(label: string, what: 'chat' | 'embed', reason: string): string {
  return what === 'chat'
    ? `The NPU (${label}) isn't used: ${reason}. The graphics card or the processor does its work instead.`
    : `The NPU (${label}) makes no embeddings: ${reason}. The graphics card or the processor makes them instead.`;
}

/**
 * The note for an NPU of a generation setup doesn't know, kept because it passed its test on guessed values (the
 * route's most cautious: unknownGeneration): the cap it was given, and whether its timeouts are this PC's own.
 */
export function npuGuessedNote(label: string, cap: number, measured: boolean): string {
  return `The NPU (${label}) runs on guessed values: setup gave it the most cautious cap it has (${cap.toLocaleString('en-US')} tokens) and ${measured ? "this PC's own timeouts, measured" : 'the longest timeouts it has'}. It passed its test, so it's used; a kit update that knows this NPU may change them.`;
}

/** The note for an NPU whose server can't set its power mode (its route's power tool broken): used all the same. */
export function npuPowerNote(label: string, why: string): string {
  return `The NPU (${label}) is used, at its default power mode: ${why}.`;
}

/** How a plan or report says an NPU hasn't run on real hardware: its generation unverified, or one setup doesn't know (its label says so). */
const untried = (s: { verified: boolean; guessed?: boolean }) =>
  s.guessed ? ' (tried on guessed values, the most cautious it has, and kept only if it passes its test)' : s.verified ? '' : ' (not yet tried on this kind of NPU)';

/** A failed test's problems as the reason a person reads. */
export function plainReason(problems: string[], what: 'chat' | 'embed'): string {
  const s = problems.join('; ');
  if (/nonsense|dimensions|all zero|not a number|unrelated/i.test(s)) return what === 'chat' ? "its chat model doesn't run properly on it" : "its embedding model doesn't run properly on it";
  if (/timed? ?out|in time|aborted|didn't answer in/i.test(s)) return "it didn't answer its test in time";
  return what === 'chat' ? "its model server didn't pass its test" : "its embedding server didn't pass its test";
}

/** What setting the NPU up came to: its entry (none when it failed), what went wrong, the note for the person, and what was measured. */
export interface NpuSetup {
  entry?: AcceleratorEntry;
  problems: string[];
  /**
   * Why the NPU, or its embeddings, isn't used (npuNote), when it isn't; or that it runs on guessed values
   * (npuGuessedNote), or at its default power mode (npuPowerNote).
   */
  note?: string;
  /** What setup measured, on a generation nobody had (calibrate): its timeouts come from it. */
  measured?: NpuMeasured;
  /** Its route's power tool, run once its server answered (checkPowerTool), when the route has one. */
  power?: PowerToolCheck;
  /** The step that failed, as its report's code (npu-report.ts): the one that kept it out, or `embed` or `measure` beside an entry. */
  failed?: NpuFailStep;
  /** What its report says it measured, on any generation: the first start, the warm answer, writing and reading. */
  speeds?: NpuSpeeds;
  /**
   * Its generation's fallback (NpuPlan.fallback), set up because its own models failed: the route it runs (its report
   * names those models), and what failed first. The entry, note and speeds are the fallback's.
   */
  fellBack?: { route: NpuRoute; models: string[]; failed: NpuFailStep; problems: string[] };
  /**
   * What Windows' application control blocked of its servers as setup started them (kit 2.104.0), file by file: its
   * model server's (then it has no entry, `failed` is `not-supported`, and the note says Windows blocks it), or its
   * embedding server's alone (the entry keeps chat). Kept in blocked.json (rememberBlocked).
   */
  blocked?: BlockedServerFile[];
}

/**
 * The note when Windows blocked the NPU's model server as it started (kit 2.104.0), once setup knows where its work
 * went: Smart App Control by name where it's on, and what the staff use instead; or, when nothing setup tried runs,
 * that Windows blocks the staff's local models on this PC. Never a word on turning Smart App Control off: that's the
 * person's own setting to keep.
 */
export function npuBlockedNote(label: string, sac: SacState | null, instead: string | null): string {
  const who = sac === 'on' ? "Windows' Smart App Control" : "Windows' application control";
  if (!instead) return `${who} blocks the staff's local models on this PC: it stopped each model server setup tried as it started, as their makers don't sign them.`;
  return `The NPU (${label}) isn't used: ${who} blocks its model server, as its maker doesn't sign it. The staff use ${instead} instead.`;
}

/** What chats in the NPU's place, in words (npuBlockedNote): a graphics card by its name, or the processor; null when nothing does. */
export function chatInstead(configured: Pick<Accelerator, 'id' | 'kind' | 'chat'>[], detection: Pick<Detection, 'cards'>): string | null {
  const a = configured.find((x) => x.kind !== 'npu' && serves(x as Accelerator, 'chat'));
  if (!a) return null;
  if (a.kind === 'cpu') return 'the processor';
  const card = detection.cards.find((c) => c.id === a.id);
  return card ? `the graphics card (${core.deviceName(card.name)})` : 'the graphics card';
}

/** The steps whose failure setup meets with the generation's fallback models (NpuPlan.fallback): its server itself was set up. */
const FALLBACK_STEPS: readonly NpuFailStep[] = ['pull', 'checksum', 'test', 'test-nonsense', 'test-timeout', 'measure', 'too-slow'];

/**
 * A plan made before an earlier try put things in place (its server installed, its runtime beside it, a model or the
 * embedding server's files fetched): what is here now isn't fetched again.
 */
function nowHere(n: NpuPlan, tools: string, exists: (p: string) => boolean): NpuPlan {
  const installed = n.installed || exists(n.exe);
  const e = n.embed;
  return {
    ...n,
    installed,
    download: installed ? null : n.download,
    build: installed ? null : n.build,
    runtime: n.runtime && installed && n.runtime.files.every((f) => exists(path.join(n.runtime!.into, f))) ? null : n.runtime,
    models: n.models.map((m) => ({ ...m, have: m.have || (!!m.present && exists(expandRoute(m.present, { tools }))) })),
    embed: e && { ...e, download: e.download && exists(e.exe) ? null : e.download, modelDownload: e.modelDownload && exists(e.modelDownload.dest) ? null : e.modelDownload, modelPull: e.modelPull && e.model && exists(e.model) ? null : e.modelPull },
  };
}

/**
 * Sets the NPU up (setUpNpuOnce), and where its generation has fallback models (the first-generation X Elite's
 * Qwen3-VL-4B, beside its Qwen3-VL-2B) and its own failed once its server was in place, the fallback in their place:
 * the first try's test must see its red picture red too, and its server is stopped before the second's starts. What the
 * first try met goes in the log and in `fellBack`, never in the problems: the NPU still has chat, and nothing to
 * show as an error. The first try's outcome when the fallback fails as well.
 */
export async function setUpNpu(n: NpuPlan, tools: string, given: NpuIo): Promise<NpuSetup> {
  // Its catalogs asked for once, whichever models it tries.
  const io = { ...given, catalogs: catalogsOnce(given) };
  if (!n.fallback) return setUpNpuOnce(n, tools, io);
  const first = await setUpNpuOnce(n, tools, io, { seeRed: true });
  if (first.entry || !first.failed || !FALLBACK_STEPS.includes(first.failed)) return first;
  const was = n.models.map((m) => m.id).join(', ');
  const then = n.fallback.models.map((m) => m.id).join(', ');
  io.log(`${was} didn't work on this NPU (${first.problems.join('; ')}): setting up ${then} in its place`);
  const base = npuEntry(n.route, { tools, exe: n.exe, port: n.port, portable: (p) => portablePath(p) }).chat?.baseUrl;
  try {
    if (base) await inNpuTurn(false, async () => (io.stopServer ?? (async (program: string, at: string) => (await import('./keeper.ts')).stopServerAt(program, at)))(n.exe, base), { who: 'setup', lane: 'interactive', waitMs: 10 * 60_000, staleMs: 40 * 60_000 });
  } catch (e: any) {
    io.log(`${n.route.server}'s server for ${was} couldn't be stopped (${String(e?.message ?? e).split(/\r?\n/)[0]}): the next try starts its own when it can`);
  }
  const second = await setUpNpuOnce(nowHere({ ...n.fallback, port: n.port }, tools, io.exists ?? existsSync), tools, io);
  if (!second.entry) {
    io.log(`${then} didn't work on this NPU either: ${second.problems.join('; ')}`);
    return first;
  }
  io.log(`${then} answered on the NPU in ${was}'s place: the NPU keeps chat${n.kinds.includes('vision') ? ' and pictures' : ''}`);
  return { ...second, fellBack: { route: n.fallback.route, models: n.fallback.models.map((m) => m.id), failed: first.failed, problems: first.problems } };
}

/**
 * Sets the NPU up on its route: its server downloaded (checked against the pinned SHA-256) and installed for this user
 * unless it's there, each model pulled unless it's there (and, where pinned for this generation, checked file by file),
 * then a test request of each kind it serves, whose answers must make sense. On a generation nobody has measured, two
 * short requests more measure it, and its entry gets this PC's timeouts (calibrate); one too slow for the chat model
 * isn't used. Its entry comes back only when every step worked; otherwise the problems say which step failed, the note
 * says why in plain words, and config.json gets no NPU entry from it: its work goes to the graphics card or the processor.
 * `seeRed`: its test's picture must be seen red (setUpNpu's first try of models it can fall back from).
 */
async function setUpNpuOnce(n: NpuPlan, tools: string, io: NpuIo, o: { seeRed?: boolean } = {}): Promise<NpuSetup> {
  const exists = io.exists ?? existsSync;
  const run = io.run ?? runProgram;
  const now = io.clockMs ?? (() => performance.now());
  const label = n.support.label;
  const fail = (what: string, step: NpuFailStep, reason = "its model server couldn't be set up"): NpuSetup => ({
    problems: [`npu: ${what}. config.json gets no NPU entry; its work goes to the graphics card or the processor`],
    note: npuNoteFor(label, 'chat', reason),
    failed: step,
  });
  const sac = (io.smartAppControl ?? smartAppControlOutsideTests)();
  // What Windows' application control blocked in a server's folder since `since` (Date.now()), as files to sign.
  const blocksIn = async (folder: string, since: number, server: string): Promise<BlockedServerFile[]> =>
    stoppingBlocks(await (io.blockedIn ?? blockedIn)(folder, Date.now() - since + 60_000)).map((b) => ({ ...b, file: localPath(b.file, folder), server }));
  /**
   * A step that failed because Windows blocked the model server as it ran (kit 2.104.0: FastFlowLM under Smart App
   * Control, whose unsigned libraries stop flm.exe at once, to serve or to pull): the log's files in its folder since
   * the step began, or its exit of 0xC0E90002. Null when neither says so: the step failed as before.
   */
  const blockedStep = async (since: number, code: number | null, said: string): Promise<NpuSetup | null> => {
    const blocked = await blocksIn(path.dirname(n.exe), since, n.route.server);
    if (!blocked.length && !blockedExit(code) && !saysBlockedExit(said)) return null;
    const why = blockedSay(blocked, n.route.server) ?? blockedExitSay(n.route.server, sac);
    io.log(`${why}: the NPU isn't used, and its work goes to the graphics card or the processor`);
    const reason = `${sac === 'on' ? "Windows' Smart App Control" : "Windows' application control"} blocks its model server, as its maker doesn't sign it`;
    return { ...fail(why, 'not-supported', reason), blocked };
  };
  // Castellan's signed catalog of the server's files (kit 2.108.0), before anything of it runs: where Smart App Control
  // is on, its maker's unsigned files would be blocked, and the catalog lets them run as the maker built them. One
  // administrator prompt at most; turned down, the server is blocked as before, and the step that ran it says so.
  if (n.catalogs?.length) await catalogsOnce(io)(n.catalogs, [n.vendor], sac);
  const env = serverEnv({ env: routeEnv(n.route, tools) });
  // Its files put in place, in the PC's shared folder one account at a time (inSharedTools): a server another account
  // installed meanwhile isn't installed again.
  const placed = await inSharedTools(tools, io.log, async (shared): Promise<NpuSetup | null> => {
    // Castellan's signed build in place of the maker's installer (kit 2.108.0: GenieX's, whose installer and own files
    // aren't signed), so nothing unsigned runs where Smart App Control is on.
    if (!n.installed && n.build && !(shared && exists(n.exe))) {
      const failed = await (io.installBuild ?? installSignedBuild)(n.route.server, n.build, io);
      if (failed) return fail(failed.why, failed.step);
      if (!exists(n.exe)) return fail(`${n.route.server} was put together, but ${n.exe} isn't there`, 'install');
    }
    if (!n.installed && n.download && !(shared && exists(n.exe))) {
      const d: Download = { what: n.download.what, url: n.download.url, size: n.download.size, sha256: n.download.sha256, dest: n.download.dest, have: false };
      io.log(`downloading ${n.route.server} ${n.route.version} (${mb(d.size)})`);
      try {
        await (io.download ?? download)(d, (done, total) => io.log(`  ${d.what}: ${mb(done)} of ${mb(total)}`));
      } catch (e: any) {
        return fail(`${n.route.server}'s download failed: ${e?.message ?? e}`, 'download');
      }
      const inst = n.route.install;
      if (inst.kind === 'inno') {
        io.log(`installing ${n.route.server} for this user (no administrator)`);
        // An Inno Setup installer prints nothing: its log is the only place it says why it stopped.
        const log = installerLogFile(tools);
        mkdirSync(tools, { recursive: true });
        rmSync(log, { force: true });
        const r = await run(d.dest, [...inst.args, `/LOG=${log}`], { timeoutMs: 15 * 60_000 });
        if (r.code !== 0) {
          const said = r.out.trim() ? tail(r.out) : installerSaid(readText(log));
          return fail(`${n.route.server}'s installer ended with ${r.code}${said ? `: ${said}` : ''} (its log: ${log})`, 'install');
        }
        rmSync(log, { force: true });
      } else {
        const into = expandRoute(inst.into, { tools });
        io.log(`unpacking ${n.route.server} into ${into}`);
        try {
          (io.unpack ?? unpack)(d.dest, into);
        } catch (e: any) {
          return fail(`${n.route.server} couldn't be unpacked: ${e?.message ?? e}`, 'install');
        }
      }
      rmSync(d.dest, { force: true });
      if (!exists(n.exe)) return fail(`${n.route.server} was installed, but ${n.exe} isn't there`, 'install');
    }
    // Before the pull: the server's own program pulls its models, and it needs the runtime to start.
    if (n.runtime) {
      const why = await installRuntime(n.runtime, io);
      if (why) return fail(why, 'runtime');
    }
    // The kit's build of a server file, before its model is tested on it: Qwen3-VL needs OpenVINO GenAI's on Intel.
    if (n.patch) {
      const why = await installPatch(n.patch, tools, io);
      if (why) return fail(why, 'install');
    }
    for (const m of n.models) {
      if (!m.have) {
        io.log(`downloading ${m.id} (${mb(m.size)}) with ${n.route.server}; this takes a while`);
        const pulled = Date.now();
        const r = await run(n.exe, m.pull, { timeoutMs: 3 * 3600_000, env });
        if (r.code !== 0) return (await blockedStep(pulled, r.code, r.out)) ?? fail(`${n.route.server} couldn't download ${m.id} (exit ${r.code}${r.out.trim() ? `: ${tail(r.out)}` : ''})`, 'pull', "its model couldn't be downloaded");
      }
      const bad = await checkPinned(m, n.support.generation, { tools, hash: io.hash });
      if (bad.length) return fail(`${m.id} isn't the build that was checked: ${bad.join('; ')}`, 'checksum', "its model couldn't be downloaded whole");
    }
    return null;
  });
  if (placed) return placed;
  // Its own embedding server, where the route has one: a failure there leaves the NPU's chat as it is, and its
  // embeddings go where they went before.
  const later: string[] = [];
  let note: string | undefined;
  const noEmbed = (what: string, reason: string) => {
    later.push(`npu: ${what}. The NPU's entry has no embeddings; they go to the graphics card or the processor`);
    note = npuNoteFor(label, 'embed', reason);
  };
  // The step its report names when something beside the entry failed (its embeddings, or measuring a verified NPU).
  let failed: NpuFailStep | undefined;
  let embedAt: { exe: string; model: string; turn?: string } | undefined;
  if (n.embed) {
    const why = await inSharedTools(tools, io.log, (shared) => setUpNpuEmbed(n, tools, io, env, shared));
    if (why) {
      noEmbed(`${n.embed.server.server} ${n.embed.server.version}, its embedding server, couldn't be set up: ${why}`, "its embedding server couldn't be set up");
      failed = 'embed';
    } else embedAt = { exe: n.embed.exe, model: n.embed.model, ...(n.embed.turn ? { turn: n.embed.turn } : {}) };
  }
  const entry = npuEntry(n.route, { tools, exe: n.exe, port: n.port, portable: (p) => portablePath(p), embed: embedAt });
  io.log(`asking ${n.route.server} a test question on the NPU (its first load can take a minute or more)`);
  // Whether the test started the server: its time to the answers is a cold start only then (the report's coldMs).
  let started = undefined as boolean | undefined;
  const t0 = now();
  const tested = Date.now();
  const problems = await (io.testNpu ?? ((e: AcceleratorEntry, t?: { seeRed?: boolean }) => testNpuEntry(e, { onReady: (r) => (started = r.started), seeRed: t?.seeRed })))(entry, o.seeRed ? { seeRed: true } : undefined);
  const coldMs = Math.round(now() - t0);
  if (problems.length) return (await blockedStep(tested, null, problems.join('; '))) ?? fail(`${n.route.server} didn't answer its test request: ${problems.join('; ')}`, testStep(problems), plainReason(problems, 'chat'));
  // Every NPU is measured for its report; a generation nobody has measured also gets this PC's own timeouts from it,
  // rather than the route's guess, and is kept out when it fails them. A verified one is used as before whatever they say.
  const speeds: NpuSpeeds = { ...NO_SPEEDS, coldMs: started === false ? null : coldMs };
  let measured: NpuMeasured | undefined;
  const verified = n.support.verified;
  io.log(`measuring ${n.route.server} on this NPU${verified ? '' : " (this kind hasn't been measured before)"}: three short requests`);
  const m = await (io.measure ?? ((e: AcceleratorEntry) => measureNpu(e)))(entry);
  if (m && 'problems' in m) {
    if (!verified) return fail(`${n.route.server} failed its measuring requests: ${m.problems.join('; ')}`, 'measure', plainReason(m.problems, 'chat'));
    io.log(`its measuring requests failed (${m.problems.join('; ')}): it's used all the same, as its kind is verified`);
    failed ??= 'measure';
  } else if (m) {
    Object.assign(speeds, { warmMs: m.warmMs, tokensPerSecond: m.tokensPerSecond, readTokens: m.readTokens ?? null, readMs: m.readMs ?? null });
    const read = m.readMs != null && m.readTokens ? `, ${m.readTokens} tokens read in ${(m.readMs / 1000).toFixed(1)} s` : '';
    if (verified) io.log(`measured: the first answer ${(coldMs / 1000).toFixed(0)} s after the start, a short one warm in ${(m.warmMs / 1000).toFixed(1)} s, ${m.tokensPerSecond.toFixed(1)} tokens a second${read}`);
    else {
      measured = { coldMs, warmMs: m.warmMs, tokensPerSecond: m.tokensPerSecond };
      const c = calibrate(measured, n.route);
      if (c.tooSlow) return { ...fail(`${n.route.server} is too slow on this NPU: ${c.tooSlow}`, 'too-slow', 'it is too slow for the chat model'), measured, speeds };
      entry.timeouts = c.timeouts;
      io.log(
        `measured: the first answer ${(coldMs / 1000).toFixed(0)} s after the start, a short one warm in ${(m.warmMs / 1000).toFixed(1)} s, ${m.tokensPerSecond.toFixed(1)} tokens a second${read}; ` +
          `this PC's timeouts: ${c.timeouts.requestBaseMs / 1000} s and ${c.timeouts.requestPerTokenMs} ms a token, a cold load ${c.timeouts.coldLoadMs / 1000} s`,
      );
    }
  }
  let blocked: BlockedServerFile[] = [];
  if (embedAt && n.embed) {
    io.log(`asking ${n.embed.server.server} for a test embedding on the NPU`);
    const asked = Date.now();
    const bad = await (io.testEmbed ?? ((e: AcceleratorEntry) => testNpuEmbed(e, { dims: n.embed!.server.model.dims })))(entry);
    if (bad.length) {
      delete entry.embed;
      // Windows may have blocked the embedding server alone (a Snapdragon's is llama.cpp's Hexagon build): said so, and kept.
      blocked = await blocksIn(path.dirname(n.embed.exe), asked, n.embed.server.server);
      const why = blockedSay(blocked, n.embed.server.server);
      noEmbed(`${n.embed.server.server}, its embedding server, didn't answer its test request: ${why ? `${why}. ` : ''}${bad.join('; ')}`, why ? `${sac === 'on' ? "Windows' Smart App Control" : "Windows' application control"} blocks its embedding server, as its maker doesn't sign it` : plainReason(bad, 'embed'));
      failed = 'embed';
    }
  }
  io.log(`${n.route.server} answered on the NPU: ${n.kinds.filter((k) => entry[k]).join(', ')}`);
  // A generation setup doesn't know passed on guessed values: it's used, and the person is told so (npu-note.json).
  if (n.support.guessed) note = [npuGuessedNote(label, n.route.maxContextTokens, !!measured), note].filter(Boolean).join(' ');
  // The tool its server sets the NPU's power mode with (AMD's xrt-smi, for FastFlowLM), which the server runs without
  // checking: one that can't start leaves the NPU at its default mode. It's used all the same, and the person is told why.
  const power = await checkPowerTool(n, { run, exists });
  if (power?.broken) {
    io.log(`${path.win32.basename(power.exe)} couldn't start (exit ${power.code}): ${n.route.server} can't set the NPU's power mode`);
    note = [note, npuPowerNote(label, n.powerTool!.broken)].filter(Boolean).join(' ');
  }
  return { entry, problems: later, ...(note ? { note } : {}), ...(measured ? { measured } : {}), ...(power ? { power } : {}), ...(failed ? { failed } : {}), speeds, ...(blocked.length ? { blocked } : {}) };
}

/** The test request's failure as its report's code: out of time, nonsense, or anything else. */
export function testStep(problems: string[]): NpuFailStep {
  const s = problems.join('; ');
  if (/nonsense|dimensions|all zero|not a number|unrelated/i.test(s)) return 'test-nonsense';
  if (/timed? ?out|in time|aborted|didn't answer in/i.test(s)) return 'test-timeout';
  return 'test';
}

/** Three sentences, two about the same thing: an embedding model that runs properly puts those two closer. */
export const EMBED_TEST = ['The cat sat on the mat.', 'A kitten was sleeping on the rug.', 'Please pay the attached invoice by Friday.'];

const cosine = (a: number[], b: number[]) => {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb);
};

/**
 * Whether EMBED_TEST's vectors make sense: one each, of one length (`dims`, the model's, when known), numbers, not all
 * zero, and the cat closer to the kitten than to the invoice. Problems in words; none when they do.
 */
export function embedSanity(vectors: unknown, dims?: number): string[] {
  if (!Array.isArray(vectors) || vectors.length !== EMBED_TEST.length || !vectors.every((v) => Array.isArray(v) && v.length)) return [`embeddings gave no vector for each of ${EMBED_TEST.length} sentences`];
  const vs = vectors as number[][];
  const len = vs[0].length;
  if (vs.some((v) => v.length !== len)) return [`embeddings gave vectors of different dimensions (${vs.map((v) => v.length).join(', ')})`];
  if (dims && len !== dims) return [`embeddings gave ${len} dimensions, not the model's ${dims}`];
  if (vs.some((v) => v.some((x) => typeof x !== 'number' || !Number.isFinite(x)))) return ['embeddings gave a vector with something not a number in it'];
  if (vs.some((v) => v.every((x) => x === 0))) return ['embeddings gave a vector of all zero'];
  const near = cosine(vs[0], vs[1]);
  const far = cosine(vs[0], vs[2]);
  if (!(near > far + 0.02)) return [`embeddings put unrelated sentences as close as related ones (cat and kitten ${near.toFixed(3)}, cat and invoice ${far.toFixed(3)}): nonsense`];
  return [];
}

/** `fn` in the NPU's turn, or at once when the caller holds it (`held`). */
function inNpuTurn<T>(held: boolean, fn: (slot: number) => Promise<T>, opts: Parameters<typeof withAcceleratorTurn>[2]): Promise<T> {
  return held ? fn(0) : withAcceleratorTurn(lockDirsOf({ id: 'npu', slots: 1 }), fn, opts);
}

/** This kit's version (its VERSION file: beside this file in an agent's kit, one folder up in the Steward's). */
export function kitVersion(): string {
  for (const f of ['./VERSION', '../VERSION']) {
    try {
      return readFileSync(new URL(f, import.meta.url), 'utf8').trim();
    } catch {}
  }
  return 'unknown';
}

/**
 * Which kit last wrote the NPU's command, or looked at it (npu-refresh.ts): `npu-refresh.json`, beside config.json.
 * Setup writes `set-up` when it writes the NPU's entry; the keeper's look writes what it found.
 */
export interface NpuRefreshRecord {
  kit: string;
  at: string;
  did: 'set-up' | 'current' | 'refreshed' | 'failed' | 'needs-setup' | 'not-route' | 'no-npu';
  problems?: string[];
  /** A `failed` look's: the tests this kit has made of the new command. */
  tries?: number;
  /** A `failed` look whose test failed for its server (npu-refresh.ts' serverFailed): a look from then on tests again. Without it, this kit doesn't. */
  retryAt?: string;
  /** The NPU's own embeddings, offered by a look and refused (kit 2.86.0): kept in every later record until they're taken up. */
  embedOffer?: NpuEmbedOffer;
}

/**
 * Embeddings a look offered to an NPU entry that made none, and their test refused: their server as the route names it
 * (`llama.cpp b11125`), how many kits' looks they failed, the last one's time and problems. At NPU_REFRESH_TRIES they
 * aren't offered again until the route's embedding server is another.
 */
export interface NpuEmbedOffer {
  server: string;
  tries: number;
  at: string;
  problems: string[];
}

export const npuRefreshFile = (configFile: string) => path.join(path.dirname(configFile), 'npu-refresh.json');

export function readNpuRefresh(configFile: string): NpuRefreshRecord | null {
  try {
    const r = JSON.parse(readFileSync(npuRefreshFile(configFile), 'utf8').replace(/^﻿/, ''));
    return r && typeof r.kit === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** Never throws: without the record, the next look only looks again. */
export function rememberNpuRefresh(configFile: string, r: NpuRefreshRecord): void {
  try {
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(npuRefreshFile(configFile), JSON.stringify(r, null, 2) + '\n');
  } catch {}
}

/** Which kit last looked at the cards' vision commands (refreshCardVision): `card-refresh.json`, beside config.json. */
export interface CardRefreshRecord {
  kit: string;
  at: string;
  /** The cards whose command it changed. */
  changed?: string[];
  problems?: string[];
}

export const cardRefreshFile = (configFile: string) => path.join(path.dirname(configFile), 'card-refresh.json');

export function readCardRefresh(configFile: string): CardRefreshRecord | null {
  try {
    const r = JSON.parse(readFileSync(cardRefreshFile(configFile), 'utf8').replace(/^﻿/, ''));
    return r && typeof r.kit === 'string' ? r : null;
  } catch {
    return null;
  }
}

/**
 * config.json with each card's vision brought up to what setup now writes for it (encodesOnProcessor) where an older
 * kit's setup wrote less, and the cards changed: ENCODER_ON_PROCESSOR after its `--mmproj` file, PICTURE_CAP after
 * that, and VISION_ON_PROCESSOR_TIMEOUTS. Each is added only when missing, so a cap or timeouts a person set stay
 * theirs. A command that isn't llama-server's, or that keeps the encoder on the card (`--mmproj-offload`), is left as it is.
 */
export function withEncoderOnProcessor(raw: Record<string, any>): { raw: Record<string, any>; changed: string[] } {
  if (!Array.isArray(raw.accelerators)) return { raw, changed: [] };
  const changed: string[] = [];
  const accelerators = raw.accelerators.map((a: any) => {
    const cmd: unknown = a?.vision?.startCommand;
    if (a?.kind !== 'gpu' || typeof a.id !== 'string' || !Array.isArray(cmd) || !cmd.every((s) => typeof s === 'string')) return a;
    const at = cmd.indexOf('--mmproj');
    const dev = cmd.indexOf('--device');
    if (at < 0 || at + 1 >= cmd.length || !/^llama-server(\.exe)?$/i.test(path.win32.basename(cmd[0] ?? ''))) return a;
    if (cmd.includes('--mmproj-offload')) return a;
    if (!encodesOnProcessor({ id: a.id, memoryGb: typeof a.memoryGb === 'number' ? a.memoryGb : undefined, device: dev >= 0 ? (cmd[dev + 1] ?? null) : null })) return a;
    const on = cmd.indexOf(ENCODER_ON_PROCESSOR);
    const add = [...(on < 0 ? [ENCODER_ON_PROCESSOR] : []), ...(cmd.includes(PICTURE_CAP) ? [] : [PICTURE_CAP, String(PICTURE_TOKENS)])];
    const timeouts = a.vision.timeouts === undefined;
    if (!add.length && !timeouts) return a;
    changed.push(a.id);
    const after = on < 0 ? at + 2 : on + 1;
    return {
      ...a,
      vision: {
        ...a.vision,
        ...(add.length ? { startCommand: [...cmd.slice(0, after), ...add, ...cmd.slice(after)] } : {}),
        ...(timeouts ? { timeouts: { ...VISION_ON_PROCESSOR_TIMEOUTS } } : {}),
      },
    };
  });
  return changed.length ? { raw: { ...raw, accelerators }, changed } : { raw, changed };
}

/** The embedding server's context and micro-batch every kit's setup wrote from 2.11.0 until kindFlags' smaller ones. */
const OLD_EMBED = { context: '8192', microBatch: '2048' } as const;

/**
 * config.json with each card's embedding server brought down to what setup now writes (kindFlags: -c EMBED_CONTEXT,
 * -ub 512) where an older kit's setup wrote -c 8192 -ub 2048, and the cards changed. Its requests are capped at
 * EMBED_CAP too, as setup caps them, so an input still fits the smaller context. Only those exact values change: a
 * context or micro-batch a person set stays theirs, as does a cap already under EMBED_CAP. A command that isn't
 * llama-server's embedding server is left as it is.
 */
export function withSmallerEmbedServer(raw: Record<string, any>): { raw: Record<string, any>; changed: string[] } {
  if (!Array.isArray(raw.accelerators)) return { raw, changed: [] };
  const changed: string[] = [];
  const accelerators = raw.accelerators.map((a: any) => {
    const cmd: unknown = a?.embed?.startCommand;
    if (a?.kind !== 'gpu' || typeof a.id !== 'string' || !Array.isArray(cmd) || !cmd.every((s) => typeof s === 'string')) return a;
    if (!/^llama-server(\.exe)?$/i.test(path.win32.basename(cmd[0] ?? '')) || !cmd.includes('--embeddings')) return a;
    const c = cmd.indexOf('-c');
    const ub = cmd.indexOf('-ub');
    if (c < 0 || ub < 0 || cmd[c + 1] !== OLD_EMBED.context || cmd[ub + 1] !== OLD_EMBED.microBatch) return a;
    changed.push(a.id);
    const startCommand = cmd.map((s, i) => (i === c + 1 ? String(EMBED_CONTEXT) : i === ub + 1 ? '512' : s));
    const had = typeof a.embed.maxContextTokens === 'number' ? a.embed.maxContextTokens : typeof a.maxContextTokens === 'number' ? a.maxContextTokens : EMBED_CAP;
    return { ...a, embed: { ...a.embed, startCommand, maxContextTokens: Math.min(EMBED_CAP, had) } };
  });
  return changed.length ? { raw: { ...raw, accelerators }, changed } : { raw, changed };
}

/**
 * config.json with NO_RAM_CACHE in the environment of each llama-server on the cards and the processor, where an older
 * kit's setup didn't give it. A server whose command or environment already says what it caches (`--cache-ram`,
 * `-cram`, LLAMA_ARG_CACHE_RAM: a person's) is left as it is, and so is a command that isn't llama-server's.
 */
export function withoutRamCache(raw: Record<string, any>): { raw: Record<string, any>; changed: string[] } {
  if (!Array.isArray(raw.accelerators)) return { raw, changed: [] };
  const changed: string[] = [];
  const accelerators = raw.accelerators.map((a: any) => {
    if ((a?.kind !== 'gpu' && a?.kind !== 'cpu') || typeof a.id !== 'string') return a;
    let next = a;
    for (const k of ENDPOINT_KINDS) {
      const ep = a[k];
      const cmd: unknown = ep?.startCommand;
      if (!Array.isArray(cmd) || !cmd.every((s) => typeof s === 'string') || !/^llama-server(\.exe)?$/i.test(path.win32.basename(cmd[0] ?? ''))) continue;
      if (cmd.some((s) => s === '-cram' || s === '--cache-ram' || s.startsWith('--cache-ram='))) continue;
      const env = ep.env && typeof ep.env === 'object' && !Array.isArray(ep.env) ? ep.env : {};
      if (Object.keys(env).some((n) => n.toUpperCase() === 'LLAMA_ARG_CACHE_RAM')) continue;
      next = { ...next, [k]: { ...ep, env: { ...env, ...NO_RAM_CACHE } } };
    }
    if (next !== a) changed.push(a.id);
    return next;
  });
  return changed.length ? { raw: { ...raw, accelerators }, changed } : { raw, changed };
}

/**
 * config.json with each card that now chats on its vision server (chatsOnVision on a PC of `ramGb`) brought to that,
 * where an older kit's setup gave it a Qwen3-4B chat server beside its Qwen3-VL-4B one, and the cards changed. Chat
 * moves onto the vision server's port and command, where that model already runs, with chat's slots (`--parallel`) and
 * the larger of the two contexts (`-c`), as setup writes it now; and vision keeps its model and time, on chat's server
 * (the core's endpointFor). So nothing is started or stopped: a vision server running takes chat as it is (one request
 * at a time, where it had one slot, until its next start), and the Qwen3-4B server left on chat's old port is the keeper's orphan,
 * stopped once it has run 5 minutes with no configured server its own. Only setup's own pair is changed, each
 * llama-server's, with setup's models, on ports of their own, chat with the card's slots and vision with one: a card
 * with another model, other slots or chat and vision on one port already is left as it is.
 */
export function withChatOnVision(raw: Record<string, any>, ramGb: number): { raw: Record<string, any>; changed: string[] } {
  if (!Array.isArray(raw.accelerators)) return { raw, changed: [] };
  const changed: string[] = [];
  const llama = (cmd: unknown): cmd is string[] => Array.isArray(cmd) && cmd.length > 0 && cmd.every((s) => typeof s === 'string') && /^llama-server(\.exe)?$/i.test(path.win32.basename(cmd[0]));
  // A flag's whole number in a command (-c 16384), or NaN.
  const flag = (cmd: string[], name: string) => (cmd.indexOf(name) >= 0 ? Number(cmd[cmd.indexOf(name) + 1]) : NaN);
  const accelerators = raw.accelerators.map((a: any) => {
    const chat = a?.chat;
    const vision = a?.vision;
    if (a?.kind !== 'gpu' || typeof a.id !== 'string' || !chat || !vision) return a;
    if (chat.model !== MODEL_SPECS.chat.model || vision.model !== MODEL_SPECS.vision.model) return a;
    if (typeof chat.baseUrl !== 'string' || typeof vision.baseUrl !== 'string' || chat.baseUrl === vision.baseUrl) return a;
    if (!llama(chat.startCommand) || !llama(vision.startCommand) || !vision.startCommand.includes('--mmproj')) return a;
    // Chat's slots, as its command says (else the card's), and a card that shares the PC's memory has one, as setup gives it.
    const slots: number = a.slots ?? 1;
    const chatSlots = flag(chat.startCommand, '--parallel');
    const visionContext = flag(vision.startCommand, '-c');
    const chatContext = flag(chat.startCommand, '-c');
    if (!Number.isInteger(slots) || slots < 1 || (!Number.isNaN(chatSlots) && chatSlots !== slots) || ((a.memoryGb ?? 0) < OWN_MEMORY_GB && slots !== 1)) return a;
    if (flag(vision.startCommand, '--parallel') !== 1 || !(visionContext > 0)) return a;
    const dev = vision.startCommand.indexOf('--device');
    if (!chatsOnVision({ id: a.id, memoryGb: typeof a.memoryGb === 'number' ? a.memoryGb : undefined, device: dev >= 0 ? (vision.startCommand[dev + 1] ?? null) : null }, ramGb)) return a;
    changed.push(a.id);
    const { baseUrl: _b, startCommand: _s, env: _e, turn: _t, ...visionOwn } = vision;
    const { env: _ce, turn: _ct, ...chatOwn } = chat;
    const context = Math.max(visionContext, chatContext > 0 ? chatContext : 0);
    const startCommand = vision.startCommand.map((s: string, i: number, cmd: string[]) => (cmd[i - 1] === '-c' ? String(context) : cmd[i - 1] === '--parallel' ? String(slots) : s));
    return {
      ...a,
      chat: { ...chatOwn, baseUrl: vision.baseUrl, model: vision.model, startCommand, ...(vision.env ? { env: vision.env } : {}), ...(vision.turn ? { turn: vision.turn } : {}) },
      vision: visionOwn,
    };
  });
  return changed.length ? { raw: { ...raw, accelerators }, changed } : { raw, changed };
}

/**
 * The cards' vision and embedding commands (withEncoderOnProcessor, withSmallerEmbedServer), their chat on the vision
 * server (withChatOnVision) and their servers' RAM cache (withoutRamCache) brought up to this kit's on a PC an older kit
 * set up: setup writes them once, so the keeper's look does it, once for each kit version, as the NPU's refresh does
 * (npu-refresh.ts), and a kit never redoes what a newer one looked at. Nothing is started or stopped: on the cards it's
 * for, a vision command without the flag never stays up, a server running takes the cap, its smaller context or its
 * environment at its next start, chat goes to the vision server already running (its old server is the keeper's
 * orphan), and an agent takes the time or the embedding cap when it next reads config.json. A person who takes the
 * flag, the cap, the time or the environment out again, sets the embedding server's context back or gives chat its own
 * server back, keeps it so until the next kit. The cards and processor changed; none when config.json couldn't be read
 * (the next look tries). `ramGb`: this PC's memory (os.totalmem() when not given).
 */
export function refreshCardVision(o: { configFile: string; kit: string; now?: () => number; ramGb?: number; validate?: (raw: unknown) => string[]; log: (line: string) => void }): string[] {
  const had = readCardRefresh(o.configFile);
  if (had?.kit === o.kit || (had?.kit && compareVersions(had.kit, o.kit) > 0)) return [];
  const file = readConfigFile(o.configFile);
  if (file.error) return [];
  const vision = withEncoderOnProcessor(file.raw);
  const embed = withSmallerEmbedServer(vision.raw);
  const shared = withChatOnVision(embed.raw, o.ramGb ?? totalmem() / 1024 ** 3);
  const cache = withoutRamCache(shared.raw);
  const { raw } = cache;
  const changed = [...new Set([...vision.changed, ...embed.changed, ...shared.changed, ...cache.changed])];
  const saved = changed.length ? writeConfigFile(o.configFile, raw, o.validate ?? validateKeeperConfig) : { problems: [] };
  if (saved.problems.length) {
    const why = `config.json wasn't written: ${saved.problems.join('; ')}`;
    if (vision.changed.length) o.log(`the vision of ${vision.changed.join(', ')} keeps its command and time: ${why}`);
    if (embed.changed.length) o.log(`the embedding server of ${embed.changed.join(', ')} keeps its command: ${why}`);
    if (shared.changed.length) o.log(`the chat of ${shared.changed.join(', ')} keeps its own server: ${why}`);
    if (cache.changed.length) o.log(`the llama-servers of ${cache.changed.join(', ')} keep their environments: ${why}`);
  } else {
    if (vision.changed.length)
      o.log(
        `${vision.changed.join(', ')}: vision now encodes pictures on the processor, at most ${PICTURE_TOKENS} tokens each, with ${VISION_ON_PROCESSOR_TIMEOUTS.requestBaseMs / 1000} s a request (kit ${o.kit}): these graphics lose the device encoding them, and the processor takes about 30 s a picture`,
      );
    if (embed.changed.length)
      o.log(
        `${embed.changed.join(', ')}: the embedding server now starts at -c ${EMBED_CONTEXT} -ub 512, its requests capped at ${EMBED_CAP} tokens (kit ${o.kit}): about 0.6 GB less of the graphics' memory, the same vectors, from its next start`,
      );
    if (shared.changed.length) {
      const own = new Set(shared.changed.filter((id) => (raw.accelerators.find((a: any) => a?.id === id)?.memoryGb ?? 0) >= OWN_MEMORY_GB));
      const pc = shared.changed.filter((id) => !own.has(id));
      if (pc.length) o.log(`${pc.join(', ')}: chat now runs on the vision server, ${MODEL_SPECS.vision.model} for both (kit ${o.kit}): one server in the PC's memory where there were two, about 3.5 GB less while both are used; chat's old server stops as an orphan`);
      if (own.size) o.log(`${[...own].join(', ')}: chat now runs on the vision server, ${MODEL_SPECS.vision.model} for both (kit ${o.kit}): one server on the card where there were two, about 3.7 GB of it free again, and one server fewer to start after a game; chat's old server stops as an orphan`);
    }
    if (cache.changed.length) o.log(`${cache.changed.join(', ')}: llama-server keeps no RAM cache of earlier prompts from its next start (kit ${o.kit}): up to 8 GB a server by default, for little gain here`);
  }
  const record: CardRefreshRecord = { kit: o.kit, at: new Date((o.now ?? Date.now)()).toISOString(), ...(changed.length && !saved.problems.length ? { changed } : {}), ...(saved.problems.length ? { problems: saved.problems } : {}) };
  try {
    writeFileSync(cardRefreshFile(o.configFile), JSON.stringify(record, null, 2) + '\n');
  } catch {}
  return saved.problems.length ? [] : changed;
}

/**
 * config.json with each graphics card's and the processor's llama-server reading `file` (npuChatFile's: the NPU's own
 * copy of SMALL_SPEC's model) where an older kit's setup gave it SMALL_SPEC's Q4_K_M, and the entries changed, with the
 * files they read before. Only `-m` changes: the projector beside it reads either. A command that isn't llama-server's,
 * reads another model, or reads one of `keep` (a person's), is left as it is. With `from`, those that read that file
 * instead (back to a Q4_K_M).
 */
export function withNpuChatFile(raw: Record<string, any>, file: string, o: { from?: string; keep?: string[] } = {}): { raw: Record<string, any>; changed: string[]; was: string[] } {
  if (!Array.isArray(raw.accelerators)) return { raw, changed: [], was: [] };
  const keep = new Set((o.keep ?? []).map((p) => p.toLowerCase()));
  const changed: string[] = [];
  const was = new Set<string>();
  const accelerators = raw.accelerators.map((a: any) => {
    if ((a?.kind !== 'gpu' && a?.kind !== 'cpu') || typeof a.id !== 'string') return a;
    let next = a;
    for (const k of ['chat', 'vision'] as const) {
      const cmd: unknown = a[k]?.startCommand;
      if (!Array.isArray(cmd) || !cmd.every((s) => typeof s === 'string') || !/^llama-server(\.exe)?$/i.test(path.win32.basename(cmd[0] ?? ''))) continue;
      const m = cmd.findIndex((s, i) => i > 0 && (s === '-m' || s === '--model'));
      if (m < 0 || m + 1 >= cmd.length) continue;
      const read = expandEnv(cmd[m + 1]);
      if (o.from ? read.toLowerCase() !== o.from.toLowerCase() : !SMALL_SPEC.file.test(path.win32.basename(read)) || keep.has(read.toLowerCase())) continue;
      was.add(read);
      next = { ...next, [k]: { ...a[k], startCommand: cmd.map((s, i) => (i === m + 1 ? portablePath(file) : s)) } };
    }
    if (next !== a) changed.push(a.id);
    return next;
  });
  return changed.length ? { raw: { ...raw, accelerators }, changed, was: [...was] } : { raw, changed, was: [] };
}

/**
 * The files refreshSmallModel moved the cards and the processor off, and when: `small-model.json`, beside config.json.
 * Each is one the Snapdragon's route has retired (npu-vendors.json's `retired`), removed once nothing has named it for
 * RETIRED_GRACE_MS (retired.ts' removeRetiredModels); until then, they read it again should the NPU's copy go.
 */
export interface SmallModelRecord {
  /** The NPU's copy they read now. */
  file: string;
  retired: { path: string; since: string }[];
  /** Those a person put back in config.json: theirs, never moved off again (nor removed while it names them). */
  kept?: string[];
}

export const smallModelFile = (configFile: string) => path.join(path.dirname(configFile), 'small-model.json');

export function readSmallModel(configFile: string): SmallModelRecord | null {
  try {
    const r = JSON.parse(readFileSync(smallModelFile(configFile), 'utf8').replace(/^﻿/, ''));
    if (!r || typeof r.file !== 'string' || !Array.isArray(r.retired)) return null;
    const kept = Array.isArray(r.kept) ? r.kept.filter((p: unknown) => typeof p === 'string') : [];
    return { file: r.file, retired: r.retired.filter((x: any) => typeof x?.path === 'string' && typeof x?.since === 'string'), ...(kept.length ? { kept } : {}) };
  } catch {
    return null;
  }
}

/** Every argument of every server in config.json, its %VARIABLES% expanded, in lower case. */
function namedFiles(raw: Record<string, any>): Set<string> {
  const accelerators: any[] = Array.isArray(raw.accelerators) ? raw.accelerators : [];
  return new Set(accelerators.flatMap((a) => ENDPOINT_KINDS.flatMap((k) => (Array.isArray(a?.[k]?.startCommand) ? a[k].startCommand.filter((s: unknown) => typeof s === 'string').map((s: string) => expandEnv(s).toLowerCase()) : []))));
}

/**
 * One copy of Qwen3-VL-2B on a PC whose NPU keeps one (kit 2.100.0): the keeper's look, each time. Where npuChatFile
 * finds the NPU's copy, the cards and the processor that read SMALL_SPEC's Q4_K_M read it instead (withNpuChatFile);
 * nothing is started or stopped, and a server running keeps its file until its next start. The Q4_K_M, which the
 * Snapdragon's route has retired, goes once nothing has named it for RETIRED_GRACE_MS (the same look's
 * removeRetiredModels, from kit 2.101.0). A Q4_K_M a person puts back in config.json is theirs: kept, and never moved
 * off again. Should the NPU's copy go while the Q4_K_M is still there, they read the Q4_K_M again. Never in the PC's
 * shared folder (an Everyone install), whose files other accounts read. The entries changed; none when config.json
 * couldn't be read (the next look tries).
 */
export async function refreshSmallModel(o: {
  configFile: string;
  kit: string;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fileSize?: (p: string) => number;
  validate?: (raw: unknown) => string[];
  log: (line: string) => void;
}): Promise<{ changed: string[] }> {
  const env = o.env ?? process.env;
  const home = o.home ?? toolsHome(env as NodeJS.ProcessEnv);
  const now = (o.now ?? Date.now)();
  const size = o.fileSize ?? ((p: string) => (existsSync(p) ? statSync(p).size : -1));
  const days = (ms: number) => Math.floor(ms / 86_400_000);
  const had = readSmallModel(o.configFile);
  const file = readConfigFile(o.configFile);
  if (file.error || isSharedTools(home, env)) return { changed: [] };
  const own = npuChatFile({ home, env, fileSize: size });
  const before = namedFiles(file.raw);
  // A Q4_K_M moved off and named again while the NPU's copy is there: a person's.
  const setBack = own && had ? had.retired.filter((r) => before.has(r.path.toLowerCase())).map((r) => r.path) : [];
  for (const p of setBack) o.log(`${path.win32.basename(p)} is named in config.json again: kept, and read where it is named`);
  const kept = [...new Set([...(had?.kept ?? []), ...setBack])];
  // Where they read now: the NPU's copy, else back to a Q4_K_M still kept, when the copy they read is gone.
  const back = !own && had && size(had.file) < 0 ? had.retired.find((r) => size(r.path) > 0) : undefined;
  let raw = file.raw;
  let record: SmallModelRecord | null = had ? { ...had, ...(kept.length ? { kept } : {}) } : null;
  let changed: string[] = [];
  const next = own ? withNpuChatFile(raw, own.path, { keep: kept }) : back ? withNpuChatFile(raw, back.path, { from: had!.file }) : null;
  if (next?.changed.length) {
    const saved = writeConfigFile(o.configFile, next.raw, o.validate ?? validateKeeperConfig);
    if (saved.problems.length) {
      o.log(`${next.changed.join(', ')} keep the ${SMALL_SPEC.model} file they read: config.json wasn't written: ${saved.problems.join('; ')}`);
      return { changed: [] };
    }
    raw = next.raw;
    changed = next.changed;
    if (own) {
      const since = new Date(now).toISOString();
      const left = (had?.retired ?? []).filter((r) => !next.was.some((w) => w.toLowerCase() === r.path.toLowerCase()));
      record = { file: own.path, retired: [...left, ...next.was.map((p) => ({ path: p, since }))], ...(kept.length ? { kept } : {}) };
      o.log(`${changed.join(', ')}: chat and vision now read the NPU's own copy of ${SMALL_SPEC.model}, ${path.win32.basename(own.path)} (kit ${o.kit}): one copy on this PC where there were two, as fast; each server takes it at its next start, and the Q4_K_M goes once nothing has read it for ${days(RETIRED_GRACE_MS)} days`);
    } else o.log(`${changed.join(', ')}: chat and vision read ${path.win32.basename(back!.path)} again (kit ${o.kit}): the NPU's copy they read, ${path.win32.basename(had!.file)}, is gone`);
  }
  if (record?.retired.length) {
    // One config.json names again (a person's, or read again above) is read, and one removed is gone: neither is counted.
    const named = namedFiles(raw);
    record = { ...record, retired: record.retired.filter((r) => !named.has(r.path.toLowerCase()) && size(r.path) >= 0) };
  }
  if (record && JSON.stringify(record) !== JSON.stringify(had)) {
    try {
      writeFileSync(smallModelFile(o.configFile), JSON.stringify(record, null, 2) + '\n');
    } catch {}
  }
  return { changed };
}

/**
 * The embedding server's test request, as testNpuEntry's: in the NPU's turn, the server started if it isn't running,
 * then EMBED_TEST's three sentences, whose vectors must make sense (embedSanity). Problems in words; none when they do.
 * `held`: the caller holds the NPU's turn already (npu-refresh.ts). `logFile`, as testNpuEntry's.
 */
export async function testNpuEmbed(e: AcceleratorEntry, o: { dims?: number; held?: boolean; logFile?: string } = {}): Promise<string[]> {
  const ep = readAccelerator(e)?.embed;
  if (!ep?.baseUrl) return ['the entry has no embedding server'];
  const problems: string[] = [];
  await inNpuTurn(
    !!o.held,
    async () => {
      const s = { baseUrl: ep.baseUrl!, model: ep.model, startCommand: ep.startCommand, ...(ep.env ? { env: ep.env } : {}) };
      await ensureServer(s, { waitMs: 120_000, readyMs: 5 * 60_000, ...(o.logFile ? { logFile: o.logFile } : {}) });
      const r = await postJson(s, '/v1/embeddings', { model: ep.model, input: EMBED_TEST }, 5 * 60_000, { loading: true });
      const rows = Array.isArray(r.json?.data) ? (r.json.data as { index?: number; embedding?: unknown }[]) : [];
      const vectors: unknown[] = [];
      rows.forEach((row, i) => (vectors[typeof row?.index === 'number' ? row.index : i] = row?.embedding));
      const bad = embedSanity(rows.length ? vectors : null, o.dims);
      if (bad.length) problems.push(...bad.map((b) => (rows.length ? b : `${b} (${JSON.stringify(r.json).slice(0, 160)})`)));
    },
    { who: 'setup', lane: 'interactive', waitMs: 10 * 60_000, staleMs: 40 * 60_000 },
  ).catch((err: any) => problems.push(String(err?.message ?? err).split(/\r?\n/)[0]));
  return problems;
}

/** The reranker's test question, and two passages: one that answers it, then one that doesn't. */
export const RERANK_TEST = {
  query: 'How does the keeper stop a model server that nobody has used for a while?',
  documents: ['Bread rises because yeast turns the sugar in the dough into gas.', 'The keeper stops a model server once it has gone unused for its idle minutes, holding its accelerator\'s turn.'],
};

/**
 * The NPU's reranker's test request (kit 2.100.0), as testNpuEmbed's: in the NPU's turn, its server started if it
 * isn't running, RERANK_TEST asked, and the passage that answers ranked above the one that doesn't. Problems, none
 * when it did. The server is left running, as the embedding server's test leaves it: the keeper stops it once unused.
 */
export async function testNpuRerank(ep: Endpoint, o: { held?: boolean; logFile?: string } = {}): Promise<string[]> {
  if (!ep.baseUrl) return ['it has no server'];
  const problems: string[] = [];
  await inNpuTurn(
    !!o.held,
    async () => {
      const s = { baseUrl: ep.baseUrl!, model: ep.model, startCommand: ep.startCommand, ...(ep.env ? { env: ep.env } : {}) };
      await ensureServer(s, { waitMs: 120_000, readyMs: 5 * 60_000, ...(o.logFile ? { logFile: o.logFile } : {}) });
      const r = await postJson(s, '/v1/rerank', { model: ep.model, ...RERANK_TEST, top_n: RERANK_TEST.documents.length }, 5 * 60_000, { loading: true });
      const rows: { index?: unknown; relevance_score?: unknown }[] = Array.isArray(r.json?.results) ? r.json.results : [];
      const score = (i: number) => rows.find((x) => x?.index === i)?.relevance_score;
      const yes = score(1);
      const no = score(0);
      if (typeof yes !== 'number' || typeof no !== 'number') problems.push(`it gave no scores (${JSON.stringify(r.json).slice(0, 160)})`);
      else if (!(yes > no)) problems.push(`it ranked the passage that doesn't answer first (${no.toFixed(3)} against ${yes.toFixed(3)})`);
    },
    { who: 'setup', lane: 'interactive', waitMs: 10 * 60_000, staleMs: 40 * 60_000 },
  ).catch((err: any) => problems.push(String(err?.message ?? err).split(/\r?\n/)[0]));
  return problems;
}

/** An answer without its think block (a Qwen3 that thinks writes one, empty when told not to think). */
export const withoutThinking = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/** The same few characters over and over ("?option?option?option…"): what a model that doesn't run properly writes. */
export const repetitive = (s: string) => /(\S[\s\S]{0,15}?)\1{4,}/.test(s);

/**
 * Whether an answer to "Reply with the single word: ready" says it, and nothing degenerate. Answering isn't enough:
 * OpenVINO's Qwen3-4B INT4 export on a Lunar Lake NPU answered every question with "?option?option?option…" (2026-10-12).
 */
export const saysReady = (s: string) => {
  const t = withoutThinking(s);
  return /\bready\b/i.test(t) && !repetitive(t);
};

/** setup's measuring request: an answer of a known shape, long enough to time the writing. */
export const COUNT_PROMPT = 'Count from one to twenty in words, separated by commas.';

/** Whether an answer to COUNT_PROMPT counts: the numbers in it, and nothing degenerate. */
export const countsSensibly = (s: string) => {
  const t = withoutThinking(s);
  return /\bthree\b/i.test(t) && /\bseven\b/i.test(t) && !repetitive(t.replace(/[\s,.-]+/g, ' '));
};

/**
 * A prompt of about `tokens` tokens (4 characters a token) a server reads whole and answers in a word: the measuring
 * read, setup's and the NPU check's.
 */
export function fillerPrompt(tokens: number): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = 1; chars < tokens * 4; i++) {
    const line = `Line ${i}: the steward counts the barrels in the cellar and writes the number down.`;
    lines.push(line);
    chars += line.length + 1;
  }
  return `${lines.join('\n')}\n\nHow many lines are above? Reply with the number only.`;
}

/** The measuring read's size, in tokens: under every route's cap (the smallest, 2,048, takes 45% of it). */
export const READ_TOKENS = 1_000;

/** What measureNpu found: the warm answer, writing speed, and the read (null when the read itself failed). */
export interface NpuMeasuring {
  warmMs: number;
  tokensPerSecond: number;
  readTokens?: number | null;
  readMs?: number | null;
}

/**
 * Measures the NPU's chat server, in the NPU's turn, once its test request has loaded it: a short answer warm, then a
 * count to twenty (its tokens over its time: writing speed, taken low), then a prompt of about READ_TOKENS read and
 * answered in a word (the time to read it). The first two must make sense; a read that fails leaves its numbers null.
 * Calibrate takes the first two; the NPU's report takes all three.
 */
export async function measureNpu(e: AcceleratorEntry): Promise<NpuMeasuring | { problems: string[] }> {
  const acc = readAccelerator(e);
  if (!acc?.chat?.baseUrl) return { problems: ['the entry has no chat server'] };
  const problems: string[] = [];
  const text = (j: any): string => (typeof j?.choices?.[0]?.message?.content === 'string' ? j.choices[0].message.content : '');
  const kitAcc = acc as unknown as Parameters<typeof chatBody>[0];
  let out: NpuMeasuring | null = null;
  await withAcceleratorTurn(
    lockDirsOf({ id: 'npu', slots: 1 }),
    async () => {
      const chat = { baseUrl: acc.chat!.baseUrl!, model: acc.chat!.model, startCommand: acc.chat!.startCommand, ...(acc.chat!.env ? { env: acc.chat!.env } : {}) };
      await ensureServer(chat, { waitMs: 120_000, readyMs: 15 * 60_000 });
      const w = await postJson(chat, '/v1/chat/completions', chatBody(kitAcc, chat, [{ role: 'user', content: 'Reply with the single word: ready' }], 16), 5 * 60_000);
      if (!saysReady(text(w.json))) {
        problems.push(`chat answered nonsense ("${withoutThinking(text(w.json)).slice(0, 40)}"), not "ready"`);
        return;
      }
      const c = await postJson(chat, '/v1/chat/completions', chatBody(kitAcc, chat, [{ role: 'user', content: COUNT_PROMPT }], 96), 10 * 60_000);
      const said = withoutThinking(text(c.json));
      if (!countsSensibly(said)) {
        problems.push(`chat answered nonsense ("${said.slice(0, 40)}") when asked to count to twenty`);
        return;
      }
      const tokens = Number(c.json?.usage?.completion_tokens) || Math.max(1, Math.round(said.length / 4));
      out = { warmMs: Math.round(w.ms), tokensPerSecond: Math.round((tokens / (Math.max(1, c.ms) / 1000)) * 100) / 100, readTokens: null, readMs: null };
      const size = Math.min(READ_TOKENS, Math.floor((acc.maxContextTokens || 2_048) * 0.45));
      try {
        const r = await postJson(chat, '/v1/chat/completions', chatBody(kitAcc, chat, [{ role: 'user', content: fillerPrompt(size) }], 4), 10 * 60_000);
        if (typeof r.json?.choices?.[0]?.message?.content === 'string') out = { ...out, readTokens: Number(r.json?.usage?.prompt_tokens) || size, readMs: Math.round(r.ms) };
      } catch {
        // The read is for the report alone: its failure keeps the rest.
      }
    },
    { who: 'setup', lane: 'interactive', waitMs: 10 * 60_000, staleMs: 40 * 60_000 },
  ).catch((err: any) => problems.push(String(err?.message ?? err).split(/\r?\n/)[0]));
  return out && !problems.length ? out : { problems: problems.length ? problems : ['the NPU gave no measurement'] };
}

/**
 * The test request: in the NPU's turn (its lock and line, as every request), its server started if it isn't running,
 * then one answer about a picture when it serves vision, and one short chat answer, which must say "ready" as asked (and
 * nothing degenerate). Chat goes last: a server that holds one model at a time (FastFlowLM) is left holding the chat
 * model, which most work asks for, and setup's measuring after this times it warm, not its switch back (8 to 9 s on an
 * XDNA 2, which kit 2.74.4 and before measured as a short answer, warm, and wrote timeouts five times too long from). Problems in
 * words; none when each answered. A model's first load on the NPU (OpenVINO compiles it) may take minutes, so it is
 * given 15, or `timeoutMs` (the NPU check's forced timeout). `held`: the caller holds the
 * NPU's turn already, and has stopped its servers, so the entry's own command answers (npu-refresh.ts). `logFile` takes
 * what a server it starts prints (ensureServer's): the NPU's refresh keeps one, since its test on WEASELDEV03 (kit
 * 2.78.12, 2026-10-17) was refused and left nothing to say why.
 */
export async function testNpuEntry(
  e: AcceleratorEntry,
  o: { dir?: string; timeoutMs?: number; held?: boolean; onReady?: (r: ServerReady) => void; logFile?: string; /** The picture (red) must be seen: npu-patch.ts' test of a build that changes how pictures load. */ seeRed?: boolean } = {},
): Promise<string[]> {
  const acc = readAccelerator(e);
  if (!acc?.chat?.baseUrl) return ['the entry has no chat server'];
  const problems: string[] = [];
  const text = (j: any) => j?.choices?.[0]?.message?.content;
  const kitAcc = acc as unknown as Parameters<typeof chatBody>[0];
  const limit = o.timeoutMs ?? 15 * 60_000;
  const t0 = Date.now();
  await inNpuTurn(
    !!o.held,
    async () => {
      const chat = { baseUrl: acc.chat!.baseUrl!, model: acc.chat!.model, startCommand: acc.chat!.startCommand, ...(acc.chat!.env ? { env: acc.chat!.env } : {}) };
      if (!o.held) await stopOtherModel(chat);
      // Whether it was started for the test (setup's report times a cold start only then). Started whoever asks: as
      // `o.onReady?.(await ensureServer(…))` (from kit 2.78.9, released in 2.78.12), a caller without onReady never
      // started it, so the NPU's refresh, which stops the servers first, was refused on every PC.
      const ready = await ensureServer(chat, { waitMs: Math.min(120_000, limit), readyMs: limit, ...(o.logFile ? { logFile: o.logFile } : {}) });
      o.onReady?.(ready);
      if (acc.vision?.model) {
        const v = { ...chat, model: acc.vision.model };
        const img = testImage(o.dir ?? path.join(toolsHome(), 'servers', 'downloads'));
        const r = await postJson(v, '/v1/chat/completions', visionBody(kitAcc, v, await fitPicture(kitAcc, img), 'What colour is this picture? One word.', 8), limit, { loading: true });
        if (typeof text(r.json) !== 'string') problems.push(`vision gave no answer (${JSON.stringify(r.json).slice(0, 160)})`);
        else if (o.seeRed && !/\bred\b/i.test(withoutThinking(text(r.json)))) problems.push(`vision answered "${withoutThinking(text(r.json)).slice(0, 40)}" about a red picture`);
      }
      const c = await postJson(chat, '/v1/chat/completions', chatBody(kitAcc, chat, [{ role: 'user', content: 'Reply with the single word: ready' }], 32), limit, { loading: true });
      if (typeof text(c.json) !== 'string') problems.push(`chat gave no answer (${JSON.stringify(c.json).slice(0, 160)})`);
      else if (!saysReady(text(c.json))) problems.push(`chat answered nonsense ("${withoutThinking(text(c.json)).slice(0, 40)}"), not "ready": the model doesn't run properly on this NPU`);
    },
    { who: 'setup', lane: 'interactive', waitMs: 10 * 60_000, staleMs: 40 * 60_000 },
  ).catch((err: any) => {
    const said = String(err?.message ?? err).split(/\r?\n/)[0];
    // Out of time, however the server put it: the note says so plainly (plainReason).
    problems.push(Date.now() - t0 >= limit * 0.9 ? `didn't answer in time (${Math.round(limit / 1000)} s): ${said}` : said);
  });
  return problems;
}

/**
 * Setup's test of a new model, on a PC whose old command still runs (kit 2.103.0: Intel's Qwen3-VL-2B in the 4B's place):
 * OpenVINO Model Server serves only the model it started with, so the old server answered the test's model 404 and the
 * PC kept the old one. A server of the entry's own program that answers on its port without listing the model is
 * stopped, in the NPU's turn the test holds, and the test's own command starts. One that lists it, a person's own
 * program on the port, or nothing there, is left as it is.
 */
export async function stopOtherModel(chat: { baseUrl: string; model: string; startCommand?: string[] }, o: { list?: (base: string) => Promise<string[] | null>; stop?: (program: string, base: string) => Promise<number> } = {}): Promise<boolean> {
  if (!chat.startCommand?.length) return false;
  const listed = await (o.list ?? modelsListed)(chat.baseUrl);
  if (!listed || listed.includes(chat.model)) return false;
  const stopped = await (o.stop ?? stopProgramAt)(expandEnv(chat.startCommand[0]), chat.baseUrl);
  return stopped > 0;
}

/** The ids a server lists at /v1/models; null when nothing answers there, or not with a list. */
async function modelsListed(base: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    return Array.isArray(j?.data) ? j.data.map((m: any) => String(m?.id)) : null;
  } catch {
    return null;
  }
}

/** Stops `program`'s processes serving `base` and waits (10 s at most) until they're gone: how many there were. */
async function stopProgramAt(program: string, base: string): Promise<number> {
  const { serverProcesses } = await import('./keeper.ts');
  const found = await serverProcesses(program, base);
  for (const p of found) {
    try {
      process.kill(p.pid);
    } catch {}
  }
  for (let i = 0; i < 40 && (await serverProcesses(program, base)).length; i++) await new Promise((r) => setTimeout(r, 250));
  return found.length;
}

// ------------------------------------------------------------------------------------------------
// GenieX, the NPU's server, as an install writes it

/**
 * The GenieX chat server a PC with an NPU is pointed at when config.json has none (the keeper's first look, or
 * Reeve's install). Setup tells this default from an NPU entry a person configured: only the default is ever dropped.
 * Its model is the Snapdragon X2's (kit 2.100.0), by GenieX's id for it; earlier kits wrote Qwen3-4B, which no route runs now.
 */
export const GENIEX_BASE_URL = 'http://127.0.0.1:18181';
export const GENIEX_CHAT_MODEL = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
/** The default's model as earlier kits wrote it: still the default, so a config.json an older install wrote is dropped as before. */
export const GENIEX_EARLIER_CHAT_MODELS: readonly string[] = ['qualcomm/Qwen3-4B-Instruct-2507:W4A16'];
const defaultModel = (model: unknown) => model === GENIEX_CHAT_MODEL || GENIEX_EARLIER_CHAT_MODELS.includes(model as string);

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
 * address, with its model (this kit's or an earlier one's) and start command, and nothing else (no vision, no embeddings). Read either way: the
 * old chatEndpoint, or the entry an earlier setup put in the list from it.
 */
export function isInstallDefaultNpu(raw: Record<string, any>, localAppData: string): boolean {
  const read = readAccelerators(raw);
  const npu = read.accelerators.find((a) => a.id === 'npu');
  if (!npu?.chat || npu.vision || npu.embed) return false;
  if (read.legacy) return isDefaultChatEndpoint(raw.chatEndpoint, localAppData);
  const want = genieXConfig(localAppData).chatEndpoint;
  return npu.chat.baseUrl === want.baseUrl && defaultModel(npu.chat.model) && sameList(npu.chat.startCommand, want.startCommand);
}

/** Whether config.json's old chatEndpoint is the install's default, word for word. */
export function isDefaultChatEndpoint(ep: any, localAppData: string): boolean {
  const want = genieXConfig(localAppData).chatEndpoint;
  return !!ep && typeof ep === 'object' && ep.baseUrl === want.baseUrl && defaultModel(ep.model) && ep.device === want.device && sameList(ep.startCommand, want.startCommand);
}

// ------------------------------------------------------------------------------------------------
// What setup plans from

/**
 * llama.cpp's builds setup picks from: the one the kit pins (LLAMA_PIN), as a release, with NVIDIA's runtime beside it
 * (kit 2.97.0). Nothing is asked of GitHub, so the newest build anywhere is never what decides: a kit pins the next one.
 */
export async function llamaReleases(): Promise<Release[]> {
  return [pinnedRelease()];
}

/**
 * A Hugging Face repo's files with sizes and sha256s as Hugging Face lists them now; null when there's no such repo.
 * Setup never plans from it (pinnedHfFiles): it's for checking what a new pin should be.
 */
export async function hfFiles(repo: string): Promise<HfFile[] | null> {
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return null;
  return parseHfFiles(await res.json());
}

// ------------------------------------------------------------------------------------------------
// The command

export interface SetupOptions {
  ids: string[];
  kinds?: EndpointKind[];
  yes?: boolean;
  dryRun?: boolean;
  /** Asked before downloading (unless yes or dry-run); false stops. */
  confirm?: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
  detection?: Detection;
  /** llama.cpp's builds and each repository's files to plan from: the kit's pins (llamaReleases, pinnedHfFiles); tests give fixtures. */
  releases?: () => Promise<Release[]>;
  hfFiles?: (repo: string) => Promise<HfFile[] | null>;
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
  /** Where the NPU's note is kept (npuNoteFile(); tests give their own, and a given detection keeps none). */
  npuNoteFile?: string;
  /**
   * Where the NPU's report is kept (npu-report.ts, spec/NPU-REPORTS.md), for the app to offer to send: npuReportFile()
   * by default; tests give their own, and with a given detection none is kept unless they do.
   */
  npuReportFile?: string | null;
  /** Where what Windows blocked is kept (blockedFile(), kit 2.104.0; tests give their own, and a given detection keeps none). */
  blockedFile?: string | null;
  /** Where who signed the servers' files is kept (signaturesFile(), kit 2.108.0; tests give their own, and a given detection keeps none). */
  signaturesFile?: string | null;
  /** The app running setup, for the NPU's report ("manor 0.16.200"). */
  app?: string;
  /** Manor's "Use the graphics card for models when there's an NPU" (gpuWithNpu() read now, when left out). */
  gpuWithNpu?: boolean;
  /**
   * The person said yes to the download already (kit 2.113.5): setup's own run outside a packaged app (outside-run.ts),
   * which was asked in the app. Its plan isn't said again, and a second download (the card's, the processor's, in the
   * NPU's place) isn't made without `yes`: nobody is there to ask.
   */
  asked?: boolean;
  /**
   * The packaged app setup runs inside (outside.ts' packagedApp), or null; and how it runs outside it (runOutside).
   * Asked only when setup isn't given a detection or io of its own; none in a test run unless the test gives one.
   */
  packaged?: () => Promise<unknown>;
  outside?: (job: OutsideJob) => Promise<OutsideSetupResult>;
}

/**
 * What a plan would write under AppData (outside.ts' inAppData), each in a few words. In a packaged app (the Claude
 * desktop app is one) those writes would land in the app's own folder, which nothing outside it sees: setup runs
 * outside it instead, and refuses them where it can't (setupCommand). From kit 2.113.5:
 * - Qualcomm's route: GenieX itself (its installer installs it for this user in %LOCALAPPDATA%\GenieX CLI, and writes
 *   HKCU; Castellan's signed build is put together there), and the kit's build of its plugin (npu-patch.ts) over its
 *   llama_cpp folder. Its models go in %USERPROFILE%\.cache\geniex, and the Hexagon embedding server (llama.cpp's,
 *   over copies of GenieX's libraries) in the tools home: neither is AppData.
 * - Intel's (OpenVINO Model Server, Castellan's OpenVINO GenAI build, its compile cache, its models) and AMD's
 *   (FastFlowLM and its models in %USERPROFILE%\.flm) are unpacked in the tools home, and llama.cpp's builds and the
 *   models for the graphics and the processor are downloaded there: none of them is AppData, unless the tools home is.
 * Any installer counts, wherever its program goes: an installer's registry writes are redirected too.
 */
export function writesAppData(plan: SetupPlan, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const tools = path.dirname(plan.modelsDir);
  const add = (what: string, p: string | null | undefined) => {
    if (p && inAppData(p, env) && !out.some((x) => x.endsWith(`(${p})`))) out.push(`${what} (${p})`);
  };
  for (const n of [plan.npu, plan.npu?.fallback]) {
    if (!n) continue;
    const server = `${n.route.server} ${n.route.version}`;
    if (!n.installed && n.download && n.route.install.kind === 'inno') out.push(`${server}'s installer, which installs it for this user (${path.dirname(n.exe)})`);
    else if (!n.installed) add(server, path.dirname(n.exe));
    add(`${n.route.server}'s runtime`, n.runtime?.into);
    if (n.patch) add(`Castellan's build of ${n.route.server}'s ${n.patch.file}`, path.join(expandRoute(n.patch.folder, { tools, env }), n.patch.file));
    if (n.embed && (n.embed.download || n.embed.server.overlay)) add(`${n.embed.server.server}, for the NPU's embeddings`, n.embed.folder);
    add(`the NPU's embedding model`, n.embed?.modelDownload?.dest);
    for (const m of n.models.filter((m) => !m.have)) add(m.id, m.present ? expandRoute(m.present, { tools, env }) : null);
  }
  for (const d of plan.downloads.filter((d) => !d.have)) add(d.what, d.unpackTo ?? d.dest);
  return out;
}

/**
 * The rest of setup run outside the packaged app it was started in (kit 2.113.5: outside.ts), once the person has seen
 * the plan and said yes: as a one-off task Task Scheduler starts, its lines passed on as they come. Its exit code and
 * entries; null when Task Scheduler won't run it and nothing it writes is in AppData (setup then runs here, as before).
 * Where something is, it's refused, in plain words.
 */
async function setUpOutside(o: SetupOptions, plan: SetupPlan, x: { configFile: string; home: string; gpuWithNpu: boolean }, log: (line: string) => void): Promise<{ code: number; plan: SetupPlan; entries?: Accelerator[] } | null> {
  log("This runs inside a packaged app (the Claude desktop app is one), where Windows keeps what's written to AppData to that app alone, out of the staff's sight. So setup runs from Task Scheduler instead; its lines follow.");
  const options: Extract<OutsideJob, { kind: 'setup' }>['options'] = {
    ids: o.ids,
    ...(o.kinds?.length ? { kinds: o.kinds } : {}),
    ...(o.yes ? { yes: true } : {}),
    configFile: x.configFile,
    home: x.home,
    gpuWithNpu: x.gpuWithNpu,
    ...(o.app ? { app: o.app } : {}),
    ...(o.noneConfigured ? { noneConfigured: o.noneConfigured } : {}),
    ...(o.npuNoteFile ? { npuNoteFile: o.npuNoteFile } : {}),
    ...(o.npuReportFile !== undefined ? { npuReportFile: o.npuReportFile } : {}),
    ...(o.blockedFile !== undefined ? { blockedFile: o.blockedFile } : {}),
    ...(o.signaturesFile !== undefined ? { signaturesFile: o.signaturesFile } : {}),
  };
  try {
    const r = await (o.outside ?? ((job: OutsideJob) => runOutside<OutsideSetupResult>(job, { log })))({ kind: 'setup', options });
    return { code: r.code, plan, entries: r.entries as Accelerator[] };
  } catch (e: any) {
    const why = String(e?.message ?? e).split(/\r?\n/)[0];
    if (!(e instanceof OutsideUnavailable)) {
      log(`problem: setup outside the app stopped: ${why}`);
      return { code: 1, plan };
    }
    const writes = writesAppData(plan, o.env as NodeJS.ProcessEnv | undefined);
    if (writes.length) {
      log(`problem: setup couldn't run outside the app (${why}), and inside it these would be the app's alone: ${writes.join('; ')}. So nothing is set up. Set up local AI from Manor's page, or run setup from a terminal outside the app.`);
      return { code: 1, plan };
    }
    log(`note: setup couldn't run outside the app (${why}). Nothing it sets up goes in AppData, so it runs here.`);
    return null;
  }
}

/**
 * Keeps the NPU's report of this setup (npu-report.ts): what it set up on the NPU and measured there, or why it left
 * the NPU out. Nothing on a PC without an NPU, or when setup left an NPU it had set up before alone.
 */
function keepNpuReport(o: SetupOptions, detection: Detection, plan: SetupPlan, npu: NpuSetup | undefined, log: (line: string) => void): void {
  const file = o.npuReportFile !== undefined ? o.npuReportFile : o.detection ? null : npuReportFile();
  if (!file || (!plan.npu && !plan.npuLeftOut)) return;
  try {
    const report = npuReportFromSetup({
      detection,
      // The models it runs: its generation's fallback where setup fell back to them.
      route: npu?.fellBack?.route ?? plan.npu?.route ?? null,
      verified: !!plan.npu?.support.verified,
      skipped: plan.npuLeftOut ?? null,
      failed: npu?.failed ?? null,
      speeds: npu?.speeds,
      kit: kitVersion(),
      app: o.app,
      reporter: reporterId(path.join(path.dirname(file), 'npu-reporter.json')),
    });
    if (!report) return;
    const bad = rememberNpuReport(report, file);
    if (bad.length) log(`note: the NPU's report wasn't kept: ${bad.join('; ')}`);
  } catch (e: any) {
    log(`note: the NPU's report couldn't be kept: ${e?.message ?? e}`);
  }
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
  // Setup's own run outside a packaged app (outside-run.ts) was planned, said and asked in the app already.
  if (!o.asked) log(`Looking up what this PC needs (llama.cpp ${LLAMA_PIN.build} and the models, as this kit pins them)...`);
  const releases = await (o.releases ?? llamaReleases)();
  const withNpu = o.gpuWithNpu ?? gpuWithNpu().on;
  const plan = await planSetup({ detection, ids: o.ids, kinds: o.kinds, raw: file.raw, releases, hfFiles: o.hfFiles ?? pinnedHfFiles, home: o.home ?? toolsHome(), env: o.env, exists: o.io?.exists, gpuWithNpu: withNpu, npuRefresh: readNpuRefresh(configFile) });
  if (!o.asked) for (const l of describePlan(plan)) log(l);
  const settingUp = plan.targets.some((t) => !t.problem) || !!plan.npu || !!plan.npuRerank;
  if (!settingUp && !plan.dropNpu) {
    log('Nothing to set up.');
    // An NPU left out is still worth its report (why, and its PCI id when nobody has it in npu-vendors.json yet).
    if (!o.dryRun) keepNpuReport(o, detection, plan, undefined, log);
    return { code: plan.targets.length || o.ids.length ? 1 : 0, plan };
  }
  if (o.dryRun) {
    log('Dry run: nothing downloaded, config.json unchanged.');
    return { code: 0, plan };
  }
  if (settingUp && plan.downloadBytes && !o.yes && !o.asked) {
    const ok = o.confirm ? await o.confirm(`Download ${mb(plan.downloadBytes)}${plan.terms.length ? ', under the terms above' : ''}? [y/N] `) : false;
    if (!ok) {
      log(o.confirm ? 'Not downloading.' : `It would download ${mb(plan.downloadBytes)}: run again with --yes.`);
      return { code: 1, plan };
    }
  }
  // Inside a packaged app (the Claude desktop app), what setup and the servers it tries write to AppData would be that
  // app's alone: the rest runs outside it, from Task Scheduler (kit 2.113.5). Asked only for the PC's own setup, not a test's.
  const packaged = o.asked ? null : (o.packaged ?? (o.io || o.detection ? null : packagedOutsideTests));
  if (settingUp && packaged && (await packaged())) {
    const outside = await setUpOutside(o, plan, { configFile, home: o.home ?? toolsHome(), gpuWithNpu: withNpu }, log);
    if (outside) return outside;
  }
  // One ask for catalogs for the whole command: its runs for the card and the processor too.
  const base = { log, ...o.io };
  const runIo = { ...base, catalogs: catalogsOnce(base) };
  const r = await runSetup(plan, file.raw, runIo);
  // The NPU failing is no error: its work goes to the card or the processor, and its note says why, quietly.
  const npuDetails = new Set(r.npu?.problems ?? []);
  for (const p of r.problems) log(`${npuDetails.has(p) ? 'note' : 'problem'}: ${p}`);
  // The NPU's reranker failing is no error either: the processor reranks, as before.
  for (const p of r.rerank ?? []) log(`note: ${p}`);
  const problems = r.problems.filter((p) => !npuDetails.has(p));
  let raw = r.raw;
  let entries = r.entries;
  // What Windows blocked of the servers tried, file by file: kept in blocked.json below (kit 2.104.0).
  const blocked = [...(r.blocked ?? [])];
  // What the NPU couldn't do after all goes to a card that left it to the NPU: set up again now, for the work the NPU
  // turned out not to serve (the NPU's entry as written decides, as for requests), beside what the card does already.
  const missing = npuMissing(plan, entries);
  // Each goes where its generation's order sends it after the NPU (npu-vendors.json's `order`, kit 2.111.0): a graphics
  // card, then the processor, unless the order puts the processor first. No generation does yet.
  const cpuFirst = missing.filter((k) => k !== 'rerank' && fallbackDevices(plan.npu?.route, plan.npu?.support.generation, k)[0] === 'cpu');
  const toCards = missing.filter((k) => !cpuFirst.includes(k));
  const cardsFor = (plan.leftToNpu ?? []).filter((l) => l.kinds.some((k) => toCards.includes(k))).map((l) => l.id);
  // The NPU's pictures are its chat server's (Intel's Qwen3-VL-2B, kit 2.103.0): the card that takes its chat takes them too.
  const taken = ENDPOINT_KINDS.filter((k) => toCards.includes(k) || (k === 'vision' && toCards.includes('chat') && plan.npu?.kinds.includes('vision')));
  // Windows blocked the card's build too (kit 2.104.0): the processor is tried next, as with no card.
  let cardBlocked = false;
  if (toCards.length && cardsFor.length) {
    const plan2 = await planSetup({ detection, ids: cardsFor, skipNpu: true, raw, releases, hfFiles: o.hfFiles ?? pinnedHfFiles, home: o.home ?? toolsHome(), env: o.env, exists: o.io?.exists, gpuWithNpu: withNpu });
    // An NPU entry kept from before (a 4B whose 2B failed) still chats: the card takes only what it plans.
    const takes = taken.filter((k) => plan2.targets.some((t) => t.kinds.includes(k)));
    log(`The graphics card takes the NPU's ${(takes.length ? takes : taken).join(' and ')} instead: setting it up for that too.`);
    for (const l of describePlan(plan2).filter((l) => !/\(npu\)/.test(l))) log(l);
    const go = !plan2.downloadBytes || o.yes || (o.confirm ? await o.confirm(`Download ${mb(plan2.downloadBytes)} for the graphics card? [y/N] `) : false);
    if (go) {
      const r2 = await runSetup(plan2, raw, runIo);
      for (const p of r2.problems) log(`problem: ${p}`);
      problems.push(...r2.problems);
      blocked.push(...(r2.blocked ?? []));
      cardBlocked = !r2.entries.length && !!r2.blocked?.length;
      raw = r2.raw;
      entries = [...entries.filter((e) => !r2.entries.some((x) => x.id === e.id)), ...r2.entries];
    } else log(`Not downloading for the graphics card: the NPU's ${taken.join(' and ')} stay unserved until setup runs again.`);
  }
  // With no card to take it, what the NPU couldn't do goes to the processor: set up now, beside what it had. Its
  // reranker always does: a card beside the NPU reranks only while Manor's gpuWithNpu is on. So does what a card
  // Windows blocked couldn't take, and what its order sends to the processor first.
  const cardsCant = toCards.length > 0 && (!cardsFor.length || cardBlocked) && (cardBlocked || !entries.some((e) => e.kind === 'gpu') || toCards.every((k) => k === 'rerank'));
  const toCpu = [...cpuFirst, ...(cardsCant ? toCards : [])];
  if (toCpu.length && detection.cpu) {
    const had = readAccelerators(raw).accelerators.find((a) => a.id === 'cpu');
    const cpuKinds = [...new Set([...ENDPOINT_KINDS.filter((k) => k !== 'rerank' && had && serves(had, k)), ...toCpu])];
    log(`The processor takes the NPU's ${toCpu.join(' and ')} instead: setting it up for ${cpuKinds.join(' and ')}.`);
    const plan2 = await planSetup({ detection, ids: ['cpu'], skipNpu: true, cpuKinds, raw, releases, hfFiles: o.hfFiles ?? pinnedHfFiles, home: o.home ?? toolsHome(), env: o.env, exists: o.io?.exists });
    for (const l of describePlan(plan2).filter((l) => !/\(npu\)/.test(l))) log(l);
    const go = !plan2.downloadBytes || o.yes || (o.confirm ? await o.confirm(`Download ${mb(plan2.downloadBytes)} for the processor? [y/N] `) : false);
    if (go) {
      const r2 = await runSetup(plan2, raw, runIo);
      for (const p of r2.problems) log(`problem: ${p}`);
      problems.push(...r2.problems);
      blocked.push(...(r2.blocked ?? []));
      raw = r2.raw;
      entries = [...entries.filter((e) => !r2.entries.some((x) => x.id === e.id)), ...r2.entries];
    } else log(`Not downloading for the processor: the NPU's ${toCpu.join(' and ')} stay unserved until setup runs again.`);
  }
  // Why the NPU, or its embeddings, isn't used, kept for the accelerators' report: cleared once it's set up whole on
  // values setup knows. An NPU kept on guessed values says so, beside the plan's own note (its embeddings left off).
  // One Windows blocked says what the staff use instead, now that setup has tried the rest (kit 2.104.0).
  const said = r.npu?.entry && r.npu.note && plan.npuPlain ? `${r.npu.note} ${plan.npuPlain}` : r.npu?.note;
  const blockedNote = plan.npu && r.npu?.blocked && !r.npu.entry ? npuBlockedNote(plan.npu.support.label, detection.smartAppControl ?? null, chatInstead(readAccelerators(raw).accelerators, detection)) : undefined;
  const plain = plan.npu ? (blockedNote ?? said ?? plan.npuPlain ?? null) : plan.npuPlain;
  const blockedAt = o.blockedFile !== undefined ? o.blockedFile : o.detection ? null : blockedFile();
  if (blockedAt) rememberBlocked(blocked, detection.smartAppControl ?? null, blockedAt);
  const noteFile = o.npuNoteFile ?? (o.detection ? null : npuNoteFile());
  if (plain !== undefined && noteFile) rememberNpuNote(plain, noteFile);
  if (plain) log(`note: ${plain}`);
  keepNpuReport(o, detection, plan, r.npu, log);
  if (!entries.length && !plan.dropNpu) return { code: 1, plan };
  // Each work's order on this PC, from its NPU's generation (kit 2.111.0): written whether or not the NPU could be set up,
  // so requests and the fallback above agree; with none recorded, none (the NPU first).
  raw = withWorkOrder(raw, detection.npu?.supported && detection.npu.vendor ? workOrderFor(NPU_CATALOG.routes[detection.npu.vendor], detection.npu.generation) : null);
  const saved = writeConfigFile(configFile, raw, o.validate ?? validateKeeperConfig);
  if (saved.problems.length) {
    log(`config.json not written: ${saved.problems.join('; ')}`);
    return { code: 1, plan };
  }
  // The NPU's command is this kit's now: a keeper on an older kit leaves it alone (npu-refresh.ts).
  if (entries.some((e) => e.kind === 'npu')) rememberNpuRefresh(configFile, { kit: kitVersion(), at: new Date().toISOString(), did: 'set-up' });
  // Who signed each program file the servers now run, for a round of signing (signatures.ts, kit 2.108.0).
  const signaturesAt = o.signaturesFile !== undefined ? o.signaturesFile : o.detection ? null : signaturesFile();
  if (signaturesAt) await rememberSignatures(raw, signaturesAt, { env: o.env, sac: detection.smartAppControl ?? null });
  const read = readAccelerators(raw);
  const order = orderAccelerators(read.accelerators, read.order).map((a) => a.id);
  const changed = [...entries.map((e) => e.id), ...(plan.dropNpu ? ['npu removed'] : [])];
  log(`Wrote ${configFile}: ${changed.join(', ')}. Order: ${order.join(' > ') || (o.noneConfigured ?? 'none configured')}.`);
  return { code: problems.length || (settingUp && !entries.length) ? 1 : 0, plan, entries };
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
  /** Why the NPU, or its embeddings, isn't used, as setup last found it (npu-note.json): for the person, never an alarm. */
  npuNote?: string;
}

export function reportFrom(detection: Detection, raw: Record<string, any>, configFile = acceleratorConfigFile(), noteFile = npuNoteFile()): AcceleratorReport {
  const read = readAccelerators(raw);
  const note = detection.npu ? readNpuNote(noteFile)?.note : undefined;
  return {
    detected: detection,
    recommendedOrder: detectedAccelerators(detection).map((a) => a.id),
    recommendedCard: recommendedCard(detection.cards)?.id ?? null,
    configured: read.accelerators,
    order: orderAccelerators(read.accelerators, read.order).map((a) => a.id),
    acceleratorOrder: read.order,
    legacy: read.legacy,
    configFile,
    ...(note ? { npuNote: note } : {}),
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
      ? `  ${n.name}  (npu)\n    ${n.label}, driver ${n.driver || '?'}${n.driverDate ? ` (${n.driverDate})` : ''}${npuServer}; ${n.supported ? `the manor runs models on it${untried(n)}` : `not used: ${n.why}`}`
      : "  no NPU (Windows lists no Neural processor)",
  );
  if (r.npuNote) out(`    ${r.npuNote}`);
  if (d.cpu) out(`  ${d.cpu.name}  (cpu)\n    ${d.cpu.arch}, ${d.cpu.cores} threads, ${Math.round(d.ramBytes / 1024 ** 3)} GB of memory`);
  for (const p of d.problems) out(`  (couldn't ask: ${p})`);
  out(`Recommended order: ${r.recommendedOrder.join(', ') || '(nothing found)'}`);
  out('');
  out(`Configured (${r.configFile}${r.legacy && r.configured.length ? ', the old single endpoint read as an accelerator' : ''}):`);
  if (!r.configured.length) out('  none');
  const byId = new Map(r.configured.map((a) => [a.id, a]));
  for (const id of r.order) {
    const a = byId.get(id)!;
    const what = ENDPOINT_KINDS.filter((k) => serves(a, k)).map((k) => `${k} ${a[k]!.model}`);
    out(`  ${a.name} (${a.id})${a.enabled === false ? ' [disabled]' : ''}: ${what.join(', ') || 'serves nothing yet'}; ${a.slots} slot${a.slots === 1 ? '' : 's'}, cap ${a.maxContextTokens} tokens${a.quirks.length ? `, quirks ${a.quirks.join(', ')}` : ''}`);
  }
  out(`Order: ${r.acceleratorOrder === 'auto' ? 'auto' : r.acceleratorOrder.join(', ')}${r.order.length ? ` (${r.order.join(' > ')})` : ''}`);
  const missing = r.recommendedOrder.filter((id) => id !== 'cpu' && !byId.has(id));
  if (missing.length) out(`Not set up yet: ${missing.join(', ')} (${setupHint})`);
}

/** Auto order of what's configured (for a Settings page's "recommended"). */
export const recommendedOf = (list: Accelerator[]) => autoOrder(list).map((a) => a.id);
