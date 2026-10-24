import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startFailed } from './console.ts';
import { locksDir, LockTimeout, withLock } from './lock.ts';
import { acceleratorTurn, NpuBusy } from './npu.ts';
import { currentLane, type Lane } from './npu-queue.ts';
import { type NpuReport, readNpuReport } from './npu-report.ts';
import { compileHelperScript, prebuiltName, signedHelper } from './prebuilt.ts';
import { powershell, psStart } from './ps.ts';
import { download, type Download } from './setup.ts';

/**
 * The staff's text reader's own model (kit 2.114.0, spec/OCR.md "Our own model"): PP-OCRv6 tiny's text detector and
 * its recognizer fine-tuned on screen and document text (Apache-2.0; tools/ocr-model), read by ocr-npu.cs on the NPU
 * through ONNX Runtime and the NPU maker's plugin for it. ocr.ts reads with it where it can, and with Windows' OCR
 * where it can't, so the staff never wait on it:
 *
 * - What it needs is fetched once for every agent on the PC, in the background, into the reader's shared folder
 *   (ocrHome: %USERPROFILE%\.npu-agent\ocr, beside the NPU's line and the kit's helpers): ONNX Runtime from Microsoft's
 *   release, the NPU maker's plugin from its own NuGet package (Qualcomm's on an Arm PC, Intel's on an Intel NPU of a
 *   generation measured for it: OPENVINO_GENERATIONS), and the model from the manor's releases, each pinned by size and
 *   SHA-256, keeping only the files it uses and their notices. About 226 MB to fetch on a Snapdragon, 242 MB kept
 *   (Qualcomm's compiler alone is 182 MB), and 13 MB of compiled graphs; 199 MB on an Intel Core Ultra, 131 MB kept
 *   (OpenVINO's plugin is 112 MB), and 48 MB of compiled graphs; 81 MB on an AMD or Intel PC that reads on the
 *   processor, 19 MB kept. Until all of it is there, Windows' OCR reads, as before.
 * - The program (a kit helper, signed: prebuilt.ts) loads the model once and stays, reading picture after picture,
 *   until no picture has come for two minutes. It runs in the cache folder, where what a runtime leaves in its working
 *   folder (VitisAI's signature files) belongs, and keeps each NPU's compiled graphs there.
 * - On the NPU, reads take the NPU's turn as any model work does (npu.ts' acceleratorTurn), a few pages a turn, in the
 *   caller's lane: background reads wait their turn, and a background batch the line is too long for is read instead
 *   by a second program on the processor (ON_PROCESSOR, kit 2.126.0), started beside the NPU's and ending itself when
 *   idle as it does; else by Windows' OCR.
 * - Before it reads anything, the program reads a picture it draws itself on the NPU and on the processor; an NPU that
 *   reads it differently isn't used. Where there's no NPU the model can use (AMD's reads worse as VitisAI compiles the
 *   model, and Intel generations other than OPENVINO_GENERATIONS aren't measured yet), or an NPU that fails that check,
 *   it reads on the processor (ON_PROCESSOR).
 *
 * KIT_OCR_ENGINE: `windows` reads with Windows' OCR alone, `model` with the model wherever it can (on the processor
 * too); unset, the model where it's worth it. Under node:test it's Windows' OCR unless KIT_OCR_ENGINE says otherwise,
 * so no test fetches the model. KIT_OCR_NPU: `none` keeps the model off the NPU; `openvino` tries Intel's plugin on any
 * x64 PC (a test, on a generation not measured yet), `vitisai` AMD's (a test, which the program's check refuses: it
 * reads worse).
 */

/** A file the reader fetches: where from, and what it must be. */
export interface Pinned {
  url: string;
  size: number;
  sha256: string;
}

export const ORT_VERSION = '1.27.0';

/** ONNX Runtime, Microsoft's own release for each processor: its two DLLs are kept, and its license and notices. */
export const ORT_ZIPS: Readonly<Record<'arm64' | 'x64', Pinned>> = {
  arm64: {
    url: `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-win-arm64-${ORT_VERSION}.zip`,
    size: 78_593_089,
    sha256: 'a32f2650575b3c20df462e337519fd1cc4105356130d11dba9771c6f374d952f',
  },
  x64: {
    url: `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-win-x64-${ORT_VERSION}.zip`,
    size: 77_086_915,
    sha256: 'c5c81710938e68079ff1a192b04897faabe4b43830d48f39f27ecd4e16138bfc',
  },
};
const ORT_KEEP = ['lib/onnxruntime.dll', 'lib/onnxruntime_providers_shared.dll'];
const ORT_NOTICES = ['LICENSE', 'ThirdPartyNotices.txt'];

/** An NPU maker's plugin for ONNX Runtime, as its NuGet package carries it, and what of it is kept. */
export interface NpuPack {
  id: 'qnn' | 'openvino' | 'vitisai';
  what: string;
  version: string;
  package: Pinned;
  /** The package's folder of native files. */
  native: string;
  keep: readonly string[];
  /** The license and notices, kept in notices\. */
  notices: readonly string[];
  /** Its folder in the reader's, when it isn't <id>-<version>. */
  folder?: string;
}

/** Qualcomm's plugin 2.6.0, as Envoy and Heiward pin it: the plugin and its HTP (NPU) files, not its GPU parts. */
export const QNN_PACK: NpuPack = {
  id: 'qnn',
  what: "Qualcomm's NPU runtime",
  version: '2.6.0',
  package: {
    url: 'https://api.nuget.org/v3-flatcontainer/qualcomm.ml.onnxruntime.qnn/2.6.0/qualcomm.ml.onnxruntime.qnn.2.6.0.nupkg',
    size: 143_699_228,
    sha256: 'c2fe66eeaf92a0cb89faef1d4d05c23b939896aeb9dcfa2261d8fe70b54b8103',
  },
  native: 'runtimes/win-arm64/native',
  keep: [
    'onnxruntime_providers_qnn.dll',
    'QnnHtp.dll',
    'QnnHtpPrepare.dll',
    'QnnSystem.dll',
    'QnnHtpV73Stub.dll',
    'QnnHtpV81Stub.dll',
    'libQnnHtpV73Skel.so',
    'libQnnHtpV81Skel.so',
    'libqnnhtpv73.cat',
    'libqnnhtpv81.cat',
  ],
  notices: ['LICENSE', 'Qualcomm_LICENSE.pdf', 'ThirdPartyNotices.txt'],
};

/** Intel's OpenVINO plugin 1.7.0, as Envoy pins it: OpenVINO with its ONNX reader and its NPU plugin and compiler. */
export const OPENVINO_PACK: NpuPack = {
  id: 'openvino',
  what: "Intel's NPU runtime (OpenVINO)",
  version: '1.7.0',
  package: {
    url: 'https://api.nuget.org/v3-flatcontainer/intel.ml.onnxruntime.ep.openvino/1.7.0/intel.ml.onnxruntime.ep.openvino.1.7.0.nupkg',
    size: 117_914_126,
    sha256: '483c6ac2c268f8fc3dcbbd951fdb41ebf053456c6718d60941f50fb392dd794d',
  },
  native: 'runtimes/win-x64/native',
  keep: [
    'onnxruntime_providers_openvino_plugin.dll',
    'openvino.dll',
    'openvino_runtime.manifest',
    'openvino_auto_plugin.dll',
    'openvino_auto_batch_plugin.dll',
    'openvino_hetero_plugin.dll',
    'openvino_intel_npu_plugin.dll',
    'openvino_intel_npu_compiler.dll',
    'openvino_intel_npu_compiler_loader.dll',
    'openvino_intel_npu_vm_runtime.dll',
    'openvino_ir_frontend.dll',
    'openvino_onnx_frontend.dll',
    'tbb12.dll',
    'tbbbind_2_5.dll',
    'tbbmalloc.dll',
    'tbbmalloc_proxy.dll',
  ],
  notices: ['README.md', 'Intel.ML.OnnxRuntime.EP.OpenVINO.nuspec', 'runtimes/win-x64/native/third-party-programs.txt'],
};

/**
 * AMD's: Windows ML's DLL from Microsoft's NuGet package 2.4.89, as Envoy pins it (52 MB fetched, 1 MB kept). The
 * program asks it for AMD's VitisAI plugin, which Windows installs for the PC's NPU and keeps updated (ocr-npu.cs'
 * WindowsMl), so nothing of AMD's is fetched here.
 */
export const VITISAI_PACK: NpuPack = {
  id: 'vitisai',
  what: "Windows ML (for AMD's NPU runtime, VitisAI)",
  version: '2.4.89',
  package: {
    url: 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.ai.machinelearning/2.4.89/microsoft.windows.ai.machinelearning.2.4.89.nupkg',
    size: 51_594_185,
    sha256: '5c68ecfb947223267abf159a023f5192ad42725e4e9cc995e7c1470dd54dff63',
  },
  native: 'runtimes/win-x64/native',
  keep: ['Microsoft.Windows.AI.MachineLearning.dll'],
  notices: ['license.txt', 'ThirdPartyNotices.txt', 'README.md'],
  folder: 'winml-2.4.89',
};

/**
 * The Intel NPU generations (npu-vendors.json's) whose reader reads with the model on the NPU by default, Intel's
 * plugin fetched for it (kit 2.117.0). Measured by ocr-check on an Intel Core Ultra 5 225U (Arrow Lake-U, whose NPU
 * 3720 shows Meteor Lake's 7D1D), 2026-10-24: 1,212 of 1,253 lines exactly against Windows' OCR's 736, no group worse,
 * and 55 ms of processor a picture against 61. It spends more a picture than Windows' OCR (859 mJ against 465 mJ over
 * rest, the package's): the owner chose the model for how much better it reads. Other generations read with the model
 * on the processor until they're measured (ON_PROCESSOR).
 */
export const OPENVINO_GENERATIONS: readonly string[] = ['meteor-lake'];

/** An NPU's maker and generation, as setup's report of it names them (npu-report.ts). */
export type NpuChip = Pick<NpuReport['chip'], 'vendor' | 'generation'>;

/** This PC's NPU as its last setup reported it (npu-report.json's chip), or null when none is kept; none in a test run. */
export const npuChipOutsideTests = (): NpuChip | null => (process.env.NODE_TEST_CONTEXT ? null : (readNpuReport()?.chip ?? null));

/** The model's version: its release in the manor's public releases is ocr-model-v<version>. */
export const MODEL_VERSION = '1';
const MODEL_RELEASE = `https://github.com/Jcollier0120/Manor-releases/releases/download/ocr-model-v${MODEL_VERSION}`;

/**
 * The model's files (tools/ocr-model/export.py makes them), by where each goes in the model's folder: the detector, the
 * recognizer, its characters, and the license and notice that come with them (Apache-2.0, as PaddleOCR's models are).
 */
export const MODEL_FILES: Readonly<Record<'det.onnx' | 'rec.onnx' | 'charset.txt' | 'notices/LICENSE.txt' | 'notices/NOTICE.txt', Pinned>> = {
  'det.onnx': { url: `${MODEL_RELEASE}/det.onnx`, size: 1_744_568, sha256: 'caa7341cf77f0e379a1900874f2ec7bcea0b9ea90028cb075f8f29745ae3330c' },
  'rec.onnx': { url: `${MODEL_RELEASE}/rec.onnx`, size: 2_273_569, sha256: '6dd1d6fa758178f84017c5fd23560318a1e66597dc66bc6c607ea309fa7299c2' },
  'charset.txt': { url: `${MODEL_RELEASE}/charset.txt`, size: 298, sha256: 'ffe49ab5748c825e01a765d3325e945a252067842e839f44e80021385b459ee4' },
  'notices/LICENSE.txt': { url: `${MODEL_RELEASE}/LICENSE.txt`, size: 11_358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  'notices/NOTICE.txt': { url: `${MODEL_RELEASE}/NOTICE.txt`, size: 1_244, sha256: '86b5e941f0d51b8a68aef400ec80650592d0040166b597a2201d6097cc484dab' },
};

/**
 * Whether the model reads on the processor where no NPU can: on an AMD PC, whose NPU reads worse as VitisAI compiles
 * the model (measured in kit 2.127.0), an Intel PC whose NPU isn't of OPENVINO_GENERATIONS or that has none, and a PC
 * whose NPU fails the program's check (kit 2.124.0; AMD's and Intel's since 2.121.0 and 2.122.0). Windows' OCR costs
 * less there, but the owner's rule, 2026-10-24, is never to trade how well it reads for less power. On a Core Ultra 5
 * 225U's processor, and on a Ryzen AI 7 350's, it reads the check's lines as on the NPU, 1,212 of 1,253 against
 * Windows' OCR's 736, at 16 times the processor time a picture; on a Snapdragon X2 Elite's, 20 times (spec/OCR.md, "On
 * the processor").
 */
export const ON_PROCESSOR = true;

/** How many pages are read in one turn of the NPU: about half a second's work, so other model work comes in between. */
export const TURN_PAGES = 8;

/** The reader's shared folder: every agent's on the PC, beside the NPU's line (lock.ts' locksDir) and the kit's helpers. */
export const ocrHome = (env: NodeJS.ProcessEnv = process.env): string => env.KIT_OCR_HOME || path.join(path.dirname(locksDir), 'ocr');

export type OcrArch = 'arm64' | 'x64';

/** Where each piece lives in the reader's folder; each folder holds READY once it's whole. */
export interface ReaderPlace {
  home: string;
  ort: string;
  /** The NPU maker's plugin; null where the model reads on the processor. */
  pack: string | null;
  models: string;
  /** The program's working folder: the NPUs' compiled graphs, and what their runtimes leave. */
  cache: string;
  /** AMD's NPU's graphs compiled ahead (AMD_GRAPHS), where some are pinned for this model; else null. */
  graphs: string | null;
}

const READY = 'ready';

/**
 * AMD's NPU's graphs for this model, compiled ahead on a Ryzen AI PC (the program's --prepare --export, zipped and put
 * in the manor's releases): a PC whose plugin compiled them puts them in its cache instead of compiling for half an
 * hour. Only that plugin's version (the program checks graphs.txt); any other compiles its own. Null: none, while AMD's
 * NPU reads worse.
 */
export const AMD_GRAPHS: { plugin: string; zip: Pinned; files: readonly string[] } | null = null;

export function placeOf(home: string, arch: OcrArch, pack: NpuPack | null): ReaderPlace {
  return {
    home,
    ort: path.join(home, `onnxruntime-${ORT_VERSION}-${arch}`),
    pack: pack ? path.join(home, pack.folder ?? `${pack.id}-${pack.version}`) : null,
    models: path.join(home, `model-${MODEL_VERSION}`),
    cache: path.join(home, 'cache'),
    graphs: pack?.id === 'vitisai' && AMD_GRAPHS ? path.join(home, `amd-graphs-${MODEL_VERSION}-${AMD_GRAPHS.plugin}`) : null,
  };
}

/** The folders of `place` not yet whole. */
export function missingIn(place: ReaderPlace, exists: (p: string) => boolean = existsSync): string[] {
  return [place.models, place.ort, place.pack, place.graphs].filter((d): d is string => !!d && !exists(path.join(d, READY)));
}

/**
 * The NPU maker's plugin this PC's reader takes: Qualcomm's on an Arm PC; Intel's on an x64 PC whose NPU is of a
 * generation measured for it (OPENVINO_GENERATIONS), or on any x64 PC as a test (KIT_OCR_NPU=openvino); AMD's only as
 * a test (KIT_OCR_NPU=vitisai), since it reads worse as VitisAI compiles the model.
 */
export function packFor(arch: string, env: NodeJS.ProcessEnv = process.env, chip: () => NpuChip | null = npuChipOutsideTests): NpuPack | null {
  const want = env.KIT_OCR_NPU?.trim().toLowerCase();
  if (want === 'none') return null;
  if (arch === 'arm64') return QNN_PACK;
  if (arch !== 'x64') return null;
  if (want === 'openvino') return OPENVINO_PACK;
  if (want === 'vitisai') return VITISAI_PACK;
  const c = chip();
  return c?.vendor === 'intel' && !!c.generation && OPENVINO_GENERATIONS.includes(c.generation) ? OPENVINO_PACK : null;
}

/** Which engine reads: Windows' OCR alone, the model wherever it can, or (unset) the model where it's worth it. */
export function engineSetting(env: NodeJS.ProcessEnv = process.env): 'windows' | 'model' | 'auto' {
  const v = env.KIT_OCR_ENGINE?.trim().toLowerCase();
  if (v === 'windows' || v === 'model' || v === 'auto') return v;
  return env.NODE_TEST_CONTEXT ? 'windows' : 'auto';
}

// ------------------------------------------------------------------------------------------------
// Fetching

const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** Errors with which Windows refuses a rename for a moment: an antivirus or the indexer has a file just unpacked open. */
const BRIEFLY_REFUSED = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleepSync = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A rename tried again every 100 ms for up to five seconds while Windows refuses it for a moment (kit 2.126.0): a
 * folder tar.exe has just filled, with an NPU plugin's DLLs in it, is often still being scanned. Any other error, or
 * one that lasts, is thrown.
 */
export function renameSoon(from: string, to: string, o: { rename?: typeof renameSync; sleep?: (ms: number) => void } = {}): void {
  const rename = o.rename ?? renameSync;
  for (let t = 1; ; t++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (t >= 50 || !BRIEFLY_REFUSED.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      (o.sleep ?? sleepSync)(100);
    }
  }
}

/**
 * Takes the members of a zip (a .nupkg is one) into a new folder `into`, each where `as` says, with READY written
 * last: through a folder of its own, put in place in one rename, so a reader never finds half of it.
 */
export function unpackMembers(zip: string, into: string, files: { member: string; as: string }[]): void {
  const tmp = `${into}.unpacking`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    const raw = path.join(tmp, '.raw');
    mkdirSync(raw, { recursive: true });
    const r = spawnSync(tarExe, ['-x', '-f', zip, '-C', raw, ...files.map((f) => f.member)], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${path.basename(zip)} didn't unpack: ${(r.stderr || r.error?.message || `tar.exe exit ${r.status}`).trim().slice(0, 300)}`);
    for (const f of files) {
      mkdirSync(path.dirname(path.join(tmp, f.as)), { recursive: true });
      renameSoon(path.join(raw, f.member), path.join(tmp, f.as));
    }
    rmSync(raw, { recursive: true, force: true });
    writeFileSync(path.join(tmp, READY), `${new Date().toISOString()}\n`);
    rmSync(into, { recursive: true, force: true });
    renameSoon(tmp, into);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface FetchIo {
  download?: (d: Download) => Promise<void>;
  unpack?: typeof unpackMembers;
  log?: (line: string) => void;
}

/** Fetches what `place` is missing, the smallest first: the model, ONNX Runtime, the NPU's plugin. Throws on the first that fails. */
export async function fetchReader(place: ReaderPlace, arch: OcrArch, pack: NpuPack | null, io: FetchIo = {}): Promise<void> {
  const get = io.download ?? ((d: Download) => download(d));
  const unpack = io.unpack ?? unpackMembers;
  const exists = (p: string) => existsSync(path.join(p, READY));
  const downloads = path.join(place.home, 'downloads');
  if (!exists(place.models)) {
    io.log?.(`fetching the text reader's model (${Math.round(Object.values(MODEL_FILES).reduce((n, f) => n + f.size, 0) / 1e6)} MB)`);
    const tmp = `${place.models}.fetching`;
    rmSync(tmp, { recursive: true, force: true });
    for (const [name, f] of Object.entries(MODEL_FILES)) await get({ what: `the text reader's ${name}`, ...f, dest: path.join(tmp, name), have: false });
    writeFileSync(path.join(tmp, READY), `${new Date().toISOString()}\n`);
    rmSync(place.models, { recursive: true, force: true });
    renameSoon(tmp, place.models);
  }
  const fetchZip = async (what: string, f: Pinned, name: string, into: string, files: { member: string; as: string }[]) => {
    io.log?.(`fetching ${what} for the text reader (${Math.round(f.size / 1e6)} MB)`);
    const zip = path.join(downloads, name);
    try {
      await get({ what, ...f, dest: zip, have: false });
      unpack(zip, into, files);
    } finally {
      rmSync(zip, { force: true });
    }
  };
  if (!exists(place.ort)) {
    const top = `onnxruntime-win-${arch}-${ORT_VERSION}`;
    await fetchZip(`ONNX Runtime ${ORT_VERSION}`, ORT_ZIPS[arch], `onnxruntime-${arch}.zip`, place.ort, [
      ...ORT_KEEP.map((f) => ({ member: `${top}/${f}`, as: path.basename(f) })),
      ...ORT_NOTICES.map((f) => ({ member: `${top}/${f}`, as: `notices/${f}` })),
    ]);
  }
  if (pack && place.pack && !exists(place.pack)) {
    await fetchZip(pack.what, pack.package, `${pack.id}.nupkg`, place.pack, [
      ...pack.keep.map((f) => ({ member: `${pack.native}/${f}`, as: f })),
      ...pack.notices.map((f) => ({ member: f, as: `notices/${path.basename(f)}` })),
    ]);
  }
  if (AMD_GRAPHS && place.graphs && !exists(place.graphs)) {
    await fetchZip("AMD's NPU's graphs, compiled ahead", AMD_GRAPHS.zip, 'amd-graphs.zip', place.graphs, AMD_GRAPHS.files.map((f) => ({ member: f, as: f })));
  }
}

/** No second fetch sooner than this after one failed, so an offline PC isn't asked every batch. */
const FETCH_RETRY_MS = 30 * 60_000;
let fetching: Promise<void> | null = null;
let fetchFailedAt = 0;

/**
 * Starts fetching what's missing, unless a fetch is on (this agent's, or another's on the PC: they take turns by a lock
 * beside the NPU's) or one failed lately. Never throws; what happened goes to `log`.
 */
export function fetchInBackground(place: ReaderPlace, arch: OcrArch, pack: NpuPack | null, io: FetchIo = {}, now = Date.now()): void {
  if (fetching || now - fetchFailedAt < FETCH_RETRY_MS) return;
  fetching = withLock(path.join(locksDir, 'ocr-fetch'), () => fetchReader(place, arch, pack, io), { waitMs: 0, staleMs: 60 * 60_000 })
    .then(() => io.log?.("the text reader's model is ready: it reads from the next batch"))
    .catch((e) => {
      if (e instanceof LockTimeout) return;
      fetchFailedAt = Date.now();
      io.log?.(`the text reader's model couldn't be fetched (${String(e?.message ?? e).slice(0, 300)}): Windows' OCR reads meanwhile`);
    })
    .finally(() => {
      fetching = null;
    });
}

// ------------------------------------------------------------------------------------------------
// The program

const sourceFile = () => fileURLToPath(new URL('./ocr-npu.cs', import.meta.url));

/** The program: the kit's signed copy, or one compiled here (into the shared kit folder, under its source's name) when the kit has none. */
async function readerExe(): Promise<string> {
  const source = readFileSync(sourceFile(), 'utf8');
  const signed = signedHelper('ocr-npu', source);
  if (signed) return signed;
  const exe = path.join(path.dirname(locksDir), 'kit', prebuiltName('ocr-npu', source));
  if (existsSync(exe)) return exe;
  mkdirSync(path.dirname(exe), { recursive: true });
  const tmp = exe.replace(/\.exe$/i, `.${process.pid}.${Date.now()}.exe`);
  try {
    await powershell(compileHelperScript('ocr-npu', sourceFile(), tmp), { timeoutMs: 180_000 });
    if (!existsSync(exe)) renameSync(tmp, exe);
  } finally {
    rmSync(tmp, { force: true });
  }
  return exe;
}

/** The program's hello: where it reads, and why not on the NPU when it doesn't. */
export interface Hello {
  hello: 1;
  on?: 'npu' | 'cpu';
  ep?: string;
  why?: string | null;
  runtime?: string;
  loadMs?: number;
  /** The NPU's graphs it compiled, rather than loaded from the cache (a PC's first start). */
  compiled?: number;
  /** AMD's NPU's graphs aren't compiled yet (it was started --compiled-only): prepareReader compiles them. */
  prepare?: boolean;
  error?: string;
}

export interface HostWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A picture read: its size and lines as it is (before the scale), or why not. */
export interface HostAnswer {
  id: number;
  width?: number;
  height?: number;
  ms?: number;
  lines?: { text: string; words: HostWord[] }[];
  error?: string;
}

/** How long the program may take to say hello: the first start on an NPU compiles its graphs (about 20 s on a Snapdragon X2). */
export const HELLO_MS = 5 * 60_000;

/** The running program: one line in per picture, one line back. */
export class ReaderHost {
  private next = 0;
  private readonly waiting = new Map<number, { done: (a: HostAnswer) => void; timer: NodeJS.Timeout }>();
  private gone: string | null = null;
  private readonly proc: ChildProcess;
  readonly hello: Hello;

  private constructor(proc: ChildProcess, hello: Hello) {
    this.proc = proc;
    this.hello = hello;
  }

  get alive(): boolean {
    return !this.gone;
  }

  /** The program's process id, for the check's processor time and memory. */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** Starts the program and waits for its hello; rejects when it ends or says nothing in time. */
  static start(exe: string, args: string[], cwd: string, o: { helloMs?: number; spawnImpl?: typeof spawn } = {}): Promise<ReaderHost> {
    const run = (windowsHide: boolean) =>
      new Promise<ReaderHost>((resolve, reject) => {
        mkdirSync(cwd, { recursive: true });
        const proc = (o.spawnImpl ?? spawn)(exe, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide });
        let host: ReaderHost | null = null;
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error('the text reader said nothing in time'));
        }, o.helloMs ?? HELLO_MS);
        const lines = createInterface({ input: proc.stdout! });
        lines.on('line', (line) => {
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if (!host) {
            clearTimeout(timer);
            if (msg?.hello !== 1) return reject(new Error('the text reader answered something else'));
            if (msg.error) {
              proc.kill();
              return reject(new Error(String(msg.error)));
            }
            host = new ReaderHost(proc, msg as Hello);
            host.idle();
            return resolve(host);
          }
          host.answered(msg as HostAnswer);
        });
        proc.on('error', (e) => {
          clearTimeout(timer);
          if (host) host.ended(e.message);
          else reject(e);
        });
        proc.on('exit', (code) => {
          clearTimeout(timer);
          if (host) return host.ended(`it ended (${code})`);
          const e: any = new Error(`the text reader ended before it was ready (exit ${code})`);
          e.code = code;
          reject(e);
        });
      });
    const hide = psStart().windowsHide;
    return run(hide).catch((e) => (startFailed(e?.code, hide) ? run(true) : Promise.reject(e)));
  }

  /** Reads one picture: scale enlarges (or shrinks) it first, orient turns it the way its EXIF says. */
  read(file: string, scale: number, orient: boolean, timeoutMs = 60_000): Promise<HostAnswer> {
    const id = ++this.next;
    if (this.gone) return Promise.resolve({ id, error: `the text reader stopped: ${this.gone}` });
    this.busy();
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.proc.kill();
        this.ended('it took too long over a picture');
      }, timeoutMs);
      this.waiting.set(id, { done, timer });
      this.proc.stdin!.write(`${id}\t${scale}\t${orient ? 1 : 0}\t${path.resolve(file)}\n`);
    });
  }

  close(): void {
    this.proc.stdin?.end();
    this.ended('closed');
  }

  private answered(a: HostAnswer): void {
    const w = this.waiting.get(a.id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(a.id);
    if (!this.waiting.size) this.idle();
    w.done(a);
  }

  private ended(why: string): void {
    if (this.gone) return;
    this.gone = why;
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.done({ id, error: `the text reader stopped: ${why}` });
    }
    this.waiting.clear();
  }

  // Waiting on nothing, the program doesn't keep the agent's process alive (it ends itself after two idle minutes).
  private idle(): void {
    this.proc.unref();
    (this.proc.stdout as any)?.unref?.();
    (this.proc.stdin as any)?.unref?.();
  }

  private busy(): void {
    this.proc.ref();
    (this.proc.stdout as any)?.ref?.();
    (this.proc.stdin as any)?.ref?.();
  }
}

// ------------------------------------------------------------------------------------------------
// The engine

export type ModelEngine = 'model-npu' | 'model-cpu';

/** A page to read: a picture's file, the scale to read it at, and whether to turn it the way its EXIF says. */
export interface PageAsk {
  file: string;
  scale: number;
  orient: boolean;
}

/** A page read, and by which engine. */
export type PageAnswer = HostAnswer & { engine: ModelEngine };

export interface ModelReader {
  engine: ModelEngine;
  /** Each page's answer in order; null for a page it didn't read (the NPU's line too long, the program gone): Windows' OCR reads those. */
  read(pages: PageAsk[], o?: { lane?: Lane; timeoutMs?: number }): Promise<(PageAnswer | null)[]>;
}

const NPU = { id: 'npu', name: 'NPU', slots: 1 };

/**
 * The program's arguments for the reader's folder: on the NPU with `pack`'s plugin, on the processor without one. On
 * AMD's NPU it never compiles where it's started to read (--compiled-only): prepareReader does that.
 */
export function readerArgs(place: ReaderPlace, pack: NpuPack | null): string[] {
  const args = ['--ort', place.ort, '--models', place.models, '--cache', place.cache, '--on', pack ? 'npu' : 'cpu', '--idle', '120'];
  if (pack?.id === 'qnn') args.push('--qnn', place.pack!);
  if (pack?.id === 'openvino') args.push('--openvino', place.pack!);
  if (pack?.id === 'vitisai') {
    args.push('--vitisai', place.pack!, '--compiled-only');
    if (place.graphs) args.push('--graphs', place.graphs);
  }
  return args;
}

/** What the program's --prepare said: its graphs, how many it compiled and how many at once, and each one's time. */
export interface Prepared {
  prepared: 0 | 1;
  graphs?: number;
  compiled?: number;
  failed?: number;
  atOnce?: number;
  ms?: number;
  bytes?: number;
  /** AMD's plugin's version, as Windows ML installed it. */
  plugin?: string;
  each?: { compiled: string; ms: number; shipped?: boolean; error?: string }[];
  error?: string;
}

/**
 * How long AMD's NPU's graphs may take to compile: the detector alone took 18 minutes, on the one core AMD's compiler
 * uses (measured on a Ryzen AI 7 350), and fewer cores are free on a busy PC.
 */
export const PREPARE_MS = 90 * 60_000;

/**
 * AMD's NPU's graphs compiled (the program's --prepare): each by a program of its own, as many at once as the PC's
 * cores and memory allow, below normal priority, or put in place from the graphs compiled ahead (place.graphs) when
 * they're this PC's plugin's. Processor work, so the NPU's turn isn't taken. Resolves with what it said.
 */
export async function prepareReader(place: ReaderPlace, pack: NpuPack, o: { exe?: string; spawnImpl?: typeof spawn; timeoutMs?: number } = {}): Promise<Prepared> {
  const exe = o.exe ?? (await readerExe());
  mkdirSync(place.cache, { recursive: true });
  return new Promise<Prepared>((resolve, reject) => {
    const proc = (o.spawnImpl ?? spawn)(exe, [...readerArgs(place, pack).filter((a) => a !== '--compiled-only'), '--prepare'], {
      cwd: place.cache,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let said: Prepared | null = null;
    const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? PREPARE_MS);
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg && typeof msg === 'object' && 'prepared' in msg) said = msg as Prepared;
      } catch {
        // not the program's line
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (said) resolve(said);
      else reject(new Error(`the text reader's compile ended without saying (exit ${code})`));
    });
  });
}

/**
 * For the check (ocr-check.ts): the program on its own, on the NPU (this PC's plugin, as packFor gives it) or the
 * processor, from the reader's folder, fetched first if it isn't whole. Throws when it can't start.
 */
export async function startReader(on: 'npu' | 'cpu', o: { env?: NodeJS.ProcessEnv; arch?: string; home?: string; log?: (line: string) => void } = {}): Promise<ReaderHost> {
  const env = o.env ?? process.env;
  const arch = o.arch ?? process.arch;
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`the text reader's model doesn't run on ${arch}`);
  const pack = on === 'npu' ? packFor(arch, env) : null;
  if (on === 'npu' && !pack) throw new Error("no NPU plugin for this PC's reader (KIT_OCR_NPU=openvino tries Intel's, vitisai AMD's)");
  const place = placeOf(o.home ?? ocrHome(env), arch, pack);
  if (missingIn(place).length) await fetchReader(place, arch, pack, { log: o.log });
  if (pack?.id === 'vitisai') {
    // AMD's NPU's graphs compiled first (a PC's first time: the better part of half an hour), then the program loads them.
    const p = await prepareReader(place, pack);
    o.log?.(`AMD's NPU's graphs: ${p.compiled ?? 0} of ${p.graphs ?? '?'} compiled (${p.atOnce ?? 0} at once) in ${Math.round((p.ms ?? 0) / 1000)} s; plugin ${p.plugin ?? '?'}`);
    if (!p.prepared) throw new Error(`AMD's NPU couldn't compile the text reader's model: ${p.error ?? JSON.stringify(p.each)}`);
  }
  return ReaderHost.start(await readerExe(), readerArgs(place, pack), place.cache);
}

/** How long the model is left alone after it couldn't be used here (no program, an NPU that failed its self-check). */
const REFUSED_MS = 6 * 3600_000;
/** How long before looking again when another agent on the PC is compiling AMD's NPU's graphs. */
const PREPARE_WAIT_MS = 10 * 60_000;

interface EngineState {
  host: ReaderHost | null;
  starting: Promise<ReaderHost | null> | null;
  /** The program on the processor beside the NPU's, for what the NPU's line is too long for. */
  cpuHost: ReaderHost | null;
  cpuStarting: Promise<ReaderHost | null> | null;
  refusedUntil: number;
  /** The NPU failed the program's check (or the program found none): the program starts on the processor from then on. */
  npuFailed: boolean;
  /** This agent is compiling AMD's NPU's graphs (prepareReader), in the background. */
  preparing: boolean;
  /**
   * AMD's NPU isn't tried before then (its compile failed, or another agent is compiling): the processor reads meanwhile
   * where the model reads there (ON_PROCESSOR), else Windows' OCR.
   */
  npuWaitUntil: number;
  said: Set<string>;
}
const state: EngineState = { host: null, starting: null, cpuHost: null, cpuStarting: null, refusedUntil: 0, npuFailed: false, preparing: false, npuWaitUntil: 0, said: new Set() };

/** For tests: forget the program and any refusal. */
export function resetModelReader(): void {
  state.host?.close();
  state.host = null;
  state.starting = null;
  state.cpuHost?.close();
  state.cpuHost = null;
  state.cpuStarting = null;
  state.refusedUntil = 0;
  state.npuFailed = false;
  state.preparing = false;
  state.npuWaitUntil = 0;
  state.said.clear();
}

export interface ReaderOptions {
  env?: NodeJS.ProcessEnv;
  arch?: string;
  home?: string;
  log?: (line: string) => void;
  /** Stand-ins for tests: the program's start, the fetch, AMD's compile, and the NPU's turn (npu.ts' acceleratorTurn). */
  start?: (args: string[], cwd: string) => Promise<ReaderHost>;
  fetch?: (place: ReaderPlace, arch: OcrArch, pack: NpuPack | null) => void;
  prepare?: (place: ReaderPlace, pack: NpuPack) => Promise<Prepared>;
  turn?: typeof acceleratorTurn;
  now?: number;
}

/**
 * The model's reader for this PC, or null when Windows' OCR reads instead: set so (KIT_OCR_ENGINE), not fetched yet
 * (the fetch starts here, in the background), or not worth it here (no NPU it can use, and ON_PROCESSOR false).
 */
export async function modelReader(o: ReaderOptions = {}): Promise<ModelReader | null> {
  const env = o.env ?? process.env;
  const setting = engineSetting(env);
  if (setting === 'windows') return null;
  const arch = o.arch ?? process.arch;
  if (arch !== 'arm64' && arch !== 'x64') return null;
  const pack = packFor(arch, env);
  const onCpu = setting === 'model' || ON_PROCESSOR;
  if (!pack && !onCpu) return null;
  const clock = () => o.now ?? Date.now();
  if (clock() < state.refusedUntil) return null;
  /** AMD's NPU compiling its graphs, or not tried again yet. */
  const npuWaits = () => state.preparing || clock() < state.npuWaitUntil;
  if (pack && npuWaits() && !onCpu) return null;
  const place = placeOf(o.home ?? ocrHome(env), arch, pack);
  if (missingIn(place).length) {
    (o.fetch ?? ((p, a, k) => fetchInBackground(p, a, k, { log: o.log })))(place, arch, pack);
    return null;
  }
  const say = (line: string) => {
    if (state.said.has(line)) return;
    state.said.add(line);
    o.log?.(line);
  };
  const begin = o.start ?? (async (a: string[], cwd: string) => ReaderHost.start(await readerExe(), a, cwd));
  // Qualcomm's compiler holds about 2 GB until its program ends (317 MB without it, measured on a Snapdragon X2): a
  // program that compiled its graphs is started again, and loads them from the cache.
  const start = (a: string[], cwd: string) =>
    begin(a, cwd).then((h) => {
      if (!h.hello.compiled || h.hello.on !== 'npu') return h;
      h.close();
      return begin(a, cwd);
    });
  const npu = () => !!pack && !state.npuFailed && !npuWaits();
  const meanwhile = onCpu ? 'the model reads on the processor' : "Windows' OCR reads";

  /**
   * AMD's NPU's graphs compiled in the background, once for every agent on the PC (a lock beside the NPU's), while the
   * processor reads (ON_PROCESSOR) or Windows' OCR; the program starts on the NPU from the first batch after.
   */
  const prepareInBackground = (k: NpuPack) => {
    if (state.preparing) return;
    state.preparing = true;
    say(`AMD's NPU is compiling the text reader's model in the background (once, up to half an hour, below normal priority): ${meanwhile} until then`);
    withLock(path.join(locksDir, 'ocr-prepare'), () => (o.prepare ?? ((p, kk) => prepareReader(p, kk)))(place, k), { waitMs: 0, staleMs: PREPARE_MS + 10 * 60_000 })
      .then((p) => {
        if (p.prepared) {
          o.log?.(`AMD's NPU compiled the text reader's model (${p.compiled ?? 0} graphs, ${p.atOnce ?? 0} at once, in ${Math.round((p.ms ?? 0) / 60_000)} min): it reads there from the next batch`);
          return;
        }
        state.npuWaitUntil = Date.now() + REFUSED_MS;
        const why = p.error ?? p.each?.find((e) => e.error)?.error ?? 'it failed';
        o.log?.(`AMD's NPU couldn't compile the text reader's model (${String(why).slice(0, 300)}): ${meanwhile}`);
      })
      .catch((e) => {
        // Another agent on the PC is compiling them: this one looks again in a while.
        if (e instanceof LockTimeout) {
          state.npuWaitUntil = Date.now() + PREPARE_WAIT_MS;
          say(`another agent on this PC is compiling the text reader's model for AMD's NPU: ${meanwhile} until then`);
          return;
        }
        state.npuWaitUntil = Date.now() + REFUSED_MS;
        o.log?.(`AMD's NPU couldn't compile the text reader's model (${String(e?.message ?? e).slice(0, 300)}): ${meanwhile}`);
      })
      .finally(() => {
        state.preparing = false;
      });
  };

  /** The program, started if it isn't running (it ends itself when idle); null when it can't be used here. */
  const ensure = (): Promise<ReaderHost | null> => {
    if (state.host?.alive) {
      // On the processor while AMD's NPU compiled: ended, so the program starts on the NPU now.
      if (!(npu() && state.host.hello.on === 'cpu')) return Promise.resolve(state.host);
      state.host.close();
      state.host = null;
    }
    return (state.starting ??= start(readerArgs(place, npu() ? pack : null), place.cache)
      .then((h) => {
        if (h.hello.prepare && pack && npu()) {
          // AMD's NPU's graphs aren't compiled yet: compiled in the background, and the NPU tried again after; the
          // processor reads meanwhile where the model reads there.
          h.close();
          prepareInBackground(pack);
          return onCpu ? start(readerArgs(place, null), place.cache).then((c) => (state.host = c)) : null;
        }
        if (h.hello.on === 'cpu' && npu()) {
          // Its NPU read the program's own picture differently, or the program found none: not tried again here.
          state.npuFailed = true;
          if (!onCpu) {
            h.close();
            state.refusedUntil = Date.now() + REFUSED_MS;
            say(`the text reader's model isn't used on this NPU (${h.hello.why ?? 'it failed its check'}): Windows' OCR reads`);
            return null;
          }
          say(`the text reader reads on the processor: ${h.hello.why ?? 'the NPU failed its check'}`);
        }
        state.host = h;
        return h;
      })
      .catch((e) => {
        state.refusedUntil = Date.now() + REFUSED_MS;
        say(`the text reader's model couldn't start (${String(e?.message ?? e).slice(0, 300)}): Windows' OCR reads`);
        return null;
      })
      .finally(() => {
        state.starting = null;
      }));
  };

  /**
   * The program on the processor beside the NPU's, started when the NPU's line is first too long for a batch (kit
   * 2.126.0), and ending itself when idle as the NPU's does; null when it can't start, and Windows' OCR reads.
   */
  const processor = (): Promise<ReaderHost | null> => {
    if (state.cpuHost?.alive) return Promise.resolve(state.cpuHost);
    return (state.cpuStarting ??= start(readerArgs(place, null), place.cache)
      .then((h) => (state.cpuHost = h))
      .catch((e) => {
        say(`the text reader couldn't start on the processor (${String(e?.message ?? e).slice(0, 300)}): Windows' OCR reads what the NPU's line is too long for`);
        return null;
      })
      .finally(() => {
        state.cpuStarting = null;
      }));
  };
  /** The NPU's line too long, or no turn in time: the processor reads instead (ON_PROCESSOR), else Windows' OCR. */
  const busyOrNull = (e: unknown): Promise<ReaderHost | null> | null => (e instanceof NpuBusy && onCpu ? processor() : null);

  const turn = o.turn ?? acceleratorTurn;
  /** The program within the NPU's turn when it will start on the NPU (loading its graphs is NPU work). */
  const ready = (lane: Lane): Promise<ReaderHost | null> => ((state.host?.alive && state.host.hello.on === 'npu') || !npu() ? ensure() : turn(NPU, ensure, { lane }));
  const first = await ready(currentLane()).catch(busyOrNull);
  if (!first) return null;
  const engineOf = (h: ReaderHost): ModelEngine => (h.hello.on === 'npu' ? 'model-npu' : 'model-cpu');

  const readAll = async (h: ReaderHost, pages: PageAsk[], into: (PageAnswer | null)[], at: number, timeoutMs?: number) => {
    for (let k = 0; k < pages.length; k++) {
      const a = await h.read(pages[k].file, pages[k].scale, pages[k].orient, timeoutMs);
      into[at + k] = { ...a, engine: engineOf(h) };
      if (!h.alive) break;
    }
  };

  return {
    engine: engineOf(first),
    async read(pages, ro = {}) {
      const out: (PageAnswer | null)[] = pages.map(() => null);
      const lane = currentLane(ro.lane);
      for (let at = 0; at < pages.length; at += TURN_PAGES) {
        const chunk = pages.slice(at, at + TURN_PAGES);
        if (!npu()) {
          const h = await ready(lane);
          if (!h) break;
          await readAll(h, chunk, out, at, ro.timeoutMs);
          if (!h.alive) break;
          continue;
        }
        try {
          const more = await turn(
            NPU,
            async () => {
              const h = await ensure();
              if (!h) return false;
              await readAll(h, chunk, out, at, ro.timeoutMs);
              return h.alive;
            },
            { lane },
          );
          if (!more) break;
        } catch (e) {
          if (!(e instanceof NpuBusy)) throw e;
          const h = await busyOrNull(e);
          if (h) await readAll(h, pages.slice(at), out, at, ro.timeoutMs);
          break;
        }
      }
      return out;
    },
  };
}
