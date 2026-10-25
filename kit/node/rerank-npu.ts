import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { acceleratorConfigFile, type Endpoint, readConfigFile, serverLogsDir, toolsHome, validateKeeperConfig, writeConfigFile } from './accelerator-config.ts';
import { paceStarted } from './gentle.ts';
import { locksDir, LockTimeout, withLock } from './lock.ts';
import { NPU_CATALOG, NPU_RERANK_HELPER, runsRoute } from './npu-vendors.ts';
import { fetchRuntime, ocrHome, type Pinned, placeOf, VITISAI_PACK } from './ocr-npu.ts';
import { compileHelperScript, prebuiltName, signedHelper } from './prebuilt.ts';
import { powershell } from './ps.ts';
import { exportWeights, graphBytes, MAX_TOKENS, rerankGraph, START_IDS, START_TOKENS, tokenizerFiles } from './rerank-npu-export.ts';
import { download, type Download, portablePath, testNpuRerank } from './setup.ts';
import { setSettingUp, startWork } from './work-tasks.ts';

/**
 * AMD's NPU's reranker (kit 2.137.0, spec/NPU-VENDORS.md "Reranking on AMD's NPU"): Qwen3-Reranker-0.6B on an XDNA 2
 * NPU, beside FastFlowLM's chat, through the kit's own server (rerank-npu.cs: ONNX Runtime and AMD's VitisAI plugin,
 * as the text reader runs them, behind llama.cpp's /v1/rerank), so the staff ask it as they ask a card's reranker and
 * need no change of their own. Each rerank takes the NPU's turn, as FastFlowLM's chat does, so the two never run at
 * once; the keeper starts the server on demand and stops it when idle, as it does the X2's NPU reranker.
 *
 * Set up only where a reranker is ticked (some accelerator in config.json reranks), on a PC whose NPU runs AMD's route,
 * once, in the background, by the keeper's look (startRerankNpu), whichever kit first has it, a PC set up before
 * included: the model fetched from Hugging Face, pinned (2.4 GB; nothing is uploaded, nor any graph shipped), its
 * graphs made here from its weights (rerank-npu-export.ts), and the scoring graph compiled by VitisAI for this NPU at
 * the gentle pace (about 36 minutes on a Ryzen AI 7 350), then checked on the NPU against the processor. Meanwhile, and
 * if any of it fails, the reranker goes where it goes today, and the person sees no error: the agent's card says it's
 * setting up (its job named), as a long first job's does. Once checked, its endpoint is written as the NPU's `rerank`,
 * and the auto order puts it first; the reranker the person ticked stays where it was, behind it. A driver update that
 * wants a compile of its own takes the NPU's reranker out again until it's done.
 *
 * Kept: the model folder (1.8 GB of weights, the 621 MB embedding table, the graphs) and the compile (about 505 MB), in
 * rerankHome; the download is deleted once the model is made from it. KIT_RERANK_NPU=off sets none of it up; nor does a
 * test run.
 */

/** The model: tomaarsen's seq-cls conversion of Qwen3-Reranker-0.6B (Apache-2.0), at this commit. */
export const RERANK_REPO = 'tomaarsen/Qwen3-Reranker-0.6B-seq-cls';
export const RERANK_COMMIT = '6a5829f5079c66e78d911e06fe21931cc00232f7';
const RERANK_URL = `https://huggingface.co/${RERANK_REPO}/resolve/${RERANK_COMMIT}`;
export const RERANK_FILES: Readonly<Record<'model.safetensors' | 'tokenizer.json', Pinned>> = {
  'model.safetensors': { url: `${RERANK_URL}/model.safetensors`, size: 2_383_145_520, sha256: '2b223e576dc70d8832372a538d4c8458dc25ce9daf209ac47cec4799c85e4da7' },
  'tokenizer.json': { url: `${RERANK_URL}/tokenizer.json`, size: 11_422_654, sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4' },
};

/** Its name in requests and answers: the card's and the processor's reranker's (setup.ts' MODEL_SPECS.rerank). */
export const RERANK_ALIAS = 'qwen3-reranker-0.6b';

/** Its server's port: the NPU's own servers are 18181 to 18186. */
export const NPU_RERANK_PORT = 18187;

/**
 * The NPU's check (rerank-npu.cs' CheckTolerance): its answer to this question for these documents, against the
 * processor's: the NPU's isn't used unless it orders them as the processor does, each score within a tenth.
 */
export const RERANK_CHECK = {
  query: 'wait for a turn on the NPU so only one request runs on it at a time',
  documents: [
    'File: src/kit/npu-queue.ts\nDeclares: acquire, release, queueDirFor\nA queue of requests waiting for the NPU: each takes a ticket and waits until it is first, so only one request runs on the NPU at a time.',
    'File: src/cluster.ts\nDeclares: cluster\nGroups crash logs whose messages say the same thing.',
    'The capital of France is Paris.',
  ],
};

/** The reranker's shared folder, every agent's on the PC, beside the text reader's (ocrHome). */
export const rerankHome = (env: NodeJS.ProcessEnv = process.env): string => env.KIT_RERANK_HOME || path.join(path.dirname(locksDir), 'rerank');

/** Where each piece lives: the model made here (READY once whole), the compiles, the downloads, and the runtime the text reader's folder has. */
export interface RerankPlace {
  home: string;
  model: string;
  cache: string;
  downloads: string;
  ort: string;
  winml: string;
  /** The program's own lines (rerank-npu.cs' stderr) as it prepares. */
  log: string;
}

const READY = 'ready';

export function rerankPlace(env: NodeJS.ProcessEnv = process.env): RerankPlace {
  const home = rerankHome(env);
  const runtime = placeOf(ocrHome(env), 'x64', VITISAI_PACK);
  return {
    home,
    model: path.join(home, `model-${RERANK_COMMIT.slice(0, 12)}-${MAX_TOKENS}`),
    cache: path.join(home, 'cache'),
    downloads: path.join(home, 'downloads'),
    ort: runtime.ort,
    winml: runtime.pack!,
    log: path.join(serverLogsDir(env), 'npu.rerank-prepare.log'),
  };
}

/** The program's arguments before its mode: its model, the runtime, the compiles. */
const placeArgs = (p: RerankPlace, keep: (s: string) => string = (s) => s): string[] => ['--dir', keep(p.model), '--ort', keep(p.ort), '--vitisai', keep(p.winml), '--cache', keep(p.cache)];

/**
 * The NPU's reranker endpoint, as config.json gets it: the program at `exe` serving the model on NPU_RERANK_PORT, its
 * paths as %USERPROFILE%\… (setup's portablePath).
 */
export function rerankEndpoint(p: RerankPlace, exe: string, port = NPU_RERANK_PORT): Endpoint {
  const keep = (s: string) => portablePath(s);
  return { baseUrl: `http://127.0.0.1:${port}`, model: RERANK_ALIAS, startCommand: [keep(exe), ...placeArgs(p, keep), '--serve', '--host', '127.0.0.1', '--port', String(port), '--alias', RERANK_ALIAS] };
}

/** Whether an endpoint is the kit's NPU reranker: its program is rerank-npu.cs' (NPU_RERANK_HELPER). */
export const isNpuRerank = (ep: Endpoint | undefined): boolean => NPU_RERANK_HELPER.test(path.win32.basename(ep?.startCommand?.[0] ?? ''));

// ------------------------------------------------------------------------------------------------
// The program

const sourceFile = () => fileURLToPath(new URL('./rerank-npu.cs', import.meta.url));

/** The program: the kit's signed copy, or one compiled here (into the shared kit folder, under its source's name) when the kit has none. */
export async function rerankExe(): Promise<string> {
  const source = readFileSync(sourceFile(), 'utf8');
  const signed = signedHelper('rerank-npu', source);
  if (signed) return signed;
  const exe = path.join(path.dirname(locksDir), 'kit', prebuiltName('rerank-npu', source));
  if (existsSync(exe)) return exe;
  mkdirSync(path.dirname(exe), { recursive: true });
  const tmp = exe.replace(/\.exe$/i, `.${process.pid}.${Date.now()}.exe`);
  try {
    await powershell(compileHelperScript('rerank-npu', sourceFile(), tmp), { timeoutMs: 180_000 });
    if (!existsSync(exe)) renameSync(tmp, exe);
  } finally {
    rmSync(tmp, { force: true });
  }
  return exe;
}

/** A line the program says on stdout (JSON), with the field that marks it. */
type Said = Record<string, any>;

/**
 * Runs the program in one of its modes, its stderr appended to `log`, and resolves with its last line carrying `field`
 * (or rejects when it ends without one, or runs past `timeoutMs`). `onLine` sees each of its lines as it comes.
 */
export function runRerankProgram(exe: string, args: string[], field: string, o: { log?: string; timeoutMs: number; onStart?: (pid: number | undefined) => void; onLine?: (msg: Said) => void; spawnImpl?: typeof spawn; cwd?: string }): Promise<Said> {
  return new Promise<Said>((resolve, reject) => {
    if (o.log) mkdirSync(path.dirname(o.log), { recursive: true });
    if (o.cwd) mkdirSync(o.cwd, { recursive: true });
    const proc = (o.spawnImpl ?? spawn)(exe, args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    o.onStart?.(proc.pid);
    let said: Said | null = null;
    const timer = setTimeout(() => proc.kill(), o.timeoutMs);
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== 'object') return;
        o.onLine?.(msg);
        if (field in msg) said = msg;
      } catch {
        // not the program's line
      }
    });
    if (o.log) {
      const log = o.log;
      createInterface({ input: proc.stderr! }).on('line', (line) => {
        try {
          writeFileSync(log, `${line}\n`, { flag: 'a' });
        } catch {}
      });
    } else proc.stderr?.resume();
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (said) resolve(said);
      else reject(new Error(`AMD's NPU's reranker's program ended without saying (exit ${code})`));
    });
  });
}

/** How long the compile may take: about 36 minutes on a Ryzen AI 7 350 at normal pace, on one core of AMD's compiler; the gentle pace and a busy PC take longer. */
export const PREPARE_MS = 4 * 3600_000;

// ------------------------------------------------------------------------------------------------
// The model, made here

/**
 * The model folder made from the pinned files: downloaded (tokenizer.json, model.safetensors), then its weights, table
 * and tokenizer files written (rerank-npu-export.ts), the start's keys and values worked out on the processor by the
 * program (--start), and the scoring graph written with them. READY once whole; the download is deleted after. Throws
 * on the first step that fails, leaving the download for the next try.
 */
export async function makeModel(p: RerankPlace, exe: string, io: { download?: (d: Download) => Promise<void>; log?: (line: string) => void; run?: typeof runRerankProgram } = {}): Promise<void> {
  if (existsSync(path.join(p.model, READY))) return;
  const get = io.download ?? ((d: Download) => download(d));
  const files = Object.fromEntries(Object.keys(RERANK_FILES).map((n) => [n, path.join(p.downloads, n)])) as Record<keyof typeof RERANK_FILES, string>;
  for (const [name, f] of Object.entries(RERANK_FILES) as [keyof typeof RERANK_FILES, Pinned][]) {
    if (existsSync(files[name])) continue;
    io.log?.(`fetching the NPU's reranker's ${name} (${Math.round(f.size / 1e6)} MB)`);
    await get({ what: `the NPU's reranker's ${name}`, ...f, dest: files[name], have: false });
  }
  const tmp = `${p.model}.making`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [n, s] of Object.entries(tokenizerFiles(readFileSync(files['tokenizer.json'], 'utf8')))) writeFileSync(path.join(tmp, n), s);
  writeFileSync(path.join(tmp, 'rerank.json'), JSON.stringify({ startIds: START_IDS, tokens: MAX_TOKENS, graph: `model-${MAX_TOKENS}.onnx`, check: RERANK_CHECK }));
  const { small } = exportWeights(files['model.safetensors'], path.join(tmp, 'weights.bin'), path.join(tmp, 'table.f32'));
  writeFileSync(path.join(tmp, 'start.onnx'), graphBytes(rerankGraph({ tokens: START_TOKENS, start: 0, small, weights: 'weights.bin' })));
  const said = await (io.run ?? runRerankProgram)(exe, ['--dir', tmp, '--ort', p.ort, '--start'], 'start', { log: p.log, timeoutMs: 10 * 60_000 });
  if (said.start !== 1) throw new Error(`the start's keys and values weren't worked out: ${said.error ?? 'it said nothing more'}`);
  const kvb = readFileSync(path.join(tmp, 'kv.f32'));
  const kv = new Float32Array(kvb.buffer, kvb.byteOffset, kvb.length / 4);
  writeFileSync(path.join(tmp, `model-${MAX_TOKENS}.onnx`), graphBytes(rerankGraph({ tokens: MAX_TOKENS, start: START_TOKENS, startKv: kv, small, weights: 'weights.bin' })));
  writeFileSync(path.join(tmp, READY), `${new Date().toISOString()}\n`);
  rmSync(p.model, { recursive: true, force: true });
  renameSync(tmp, p.model);
  rmSync(p.downloads, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------
// Where it's wanted, and the keeper's look

/** The NPU's entry in config.json as it is (raw), when it runs AMD's route (FastFlowLM) and is enabled; else null. */
function amdNpuEntry(raw: Record<string, any>, tools: string): Record<string, any> | null {
  const list = Array.isArray(raw?.accelerators) ? raw.accelerators : [];
  const npu = list.find((a: any) => a && typeof a === 'object' && a.id === 'npu');
  const route = NPU_CATALOG.routes.amd;
  return npu && npu.enabled !== false && route && runsRoute(npu, route, tools) ? npu : null;
}

/**
 * What the look does for the NPU's reranker, from config.json as it is: `none` (no AMD NPU here, no reranker ticked —
 * no other accelerator in config.json reranks — or the NPU's entry has a reranker of the person's own), `prepare` (none
 * yet: set it up), `keep` (it's the NPU's already), `drop` (it's the NPU's, but the reranker the person ticked is gone:
 * taken out of config.json, its files kept for when one is ticked again).
 */
export function rerankNpuWanted(raw: Record<string, any>, tools = toolsHome()): 'none' | 'prepare' | 'keep' | 'drop' {
  const npu = amdNpuEntry(raw, tools);
  if (!npu) return 'none';
  const kits = isNpuRerank(npu.rerank);
  if (npu.rerank && !kits) return 'none';
  const list: any[] = Array.isArray(raw.accelerators) ? raw.accelerators : [];
  const ticked = list.some((a) => a && typeof a === 'object' && a !== npu && a.enabled !== false && a.rerank?.model);
  if (kits) return ticked ? 'keep' : 'drop';
  return ticked ? 'prepare' : 'none';
}

/** config.json with the NPU's entry's reranker set to `ep` (or taken out, null); null when its NPU entry isn't AMD's any more. */
export function withNpuRerank(raw: Record<string, any>, ep: Endpoint | null, tools = toolsHome()): Record<string, any> | null {
  const npu = amdNpuEntry(raw, tools);
  if (!npu) return null;
  const { rerank: _had, ...rest } = npu;
  const next = ep ? { ...rest, rerank: ep } : rest;
  return { ...raw, accelerators: raw.accelerators.map((a: any) => (a === npu ? next : a)) };
}

/** What the program's --status says. */
export interface RerankStatus {
  ready: 0 | 1;
  failed?: number;
  giveUp?: 0 | 1;
  plugin?: string;
  error?: string;
}

export interface RerankLookDeps {
  configFile: string;
  tools: string;
  place: RerankPlace;
  exe: () => Promise<string>;
  /** The program's --status. */
  status: (exe: string) => Promise<RerankStatus>;
  /** Fetches ONNX Runtime and Windows ML, as the text reader does (fetchRuntime), and makes the model (makeModel). */
  fetch: (exe: string) => Promise<void>;
  /** The program's --prepare, at the gentle pace. */
  prepare: (exe: string) => Promise<Said>;
  /** setup's testNpuRerank: the endpoint started, in the NPU's turn, and its test question's answer ranked first. */
  test: (ep: Endpoint) => Promise<string[]>;
  log: (line: string) => void;
  /** Whether a server answers at a base URL (default: its /v1/models within 3 s). */
  answers?: (base: string) => Promise<boolean>;
  /** The agent's card says it's setting up while `text` isn't null. */
  settingUp: (text: string | null) => void;
  now: () => number;
}

/** What one look at the NPU's reranker did. */
export type RerankLook = { did: 'none' | 'current' | 'busy' | 'waiting' } | { did: 'prepared' | 'refreshed' | 'taken-out' } | { did: 'failed'; why: string };

/** How long after a set-up that failed the look tries again: the program itself stops trying after two failed compiles, until AMD's driver or plugin changes. */
export const RERANK_RETRY_MS = 6 * 3600_000;
/** How often the look asks the program whether its compile is still this NPU's (a driver update wants a compile of its own). */
export const RERANK_STATUS_MS = 6 * 3600_000;

const SETTING_UP = "Setting up the NPU's reranker: making it from the model's weights and compiling it for this PC's NPU, once, gently, in the background (an hour or so). Until then, search reranks as it did.";

let lastFailedAt = 0;
let lastStatusAt = 0;

/**
 * One look (the keeper's, in the background): where a reranker is ticked on an AMD NPU's PC and the NPU has none, it's
 * set up (fetched, made, compiled, checked, its endpoint tested) and written as the NPU's reranker; where it's the
 * NPU's already, its program is kept current (the kit's helper is named by its source) and its compile this NPU's
 * (else it's taken out of config.json, and set up again). Never throws: what it did, or why not, goes to `log`.
 */
export async function lookRerankNpu(d: RerankLookDeps): Promise<RerankLook> {
  const raw = readConfigFile(d.configFile).raw;
  const wanted = rerankNpuWanted(raw, d.tools);
  if (wanted === 'none') return { did: 'none' };
  try {
    if (wanted === 'drop') {
      const out = withNpuRerank(raw, null, d.tools);
      if (out) writeConfigFile(d.configFile, out, validateKeeperConfig);
      d.log("the NPU's reranker is taken out of config.json, as no reranker is ticked now: its files stay, for when one is");
      return { did: 'taken-out' };
    }
    const exe = await d.exe();
    if (wanted === 'keep') {
      const ep = rerankEndpoint(d.place, exe);
      const had: Endpoint = amdNpuEntry(raw, d.tools)!.rerank;
      // Its model made for another pin, or gone; or its compile not this NPU's driver's (asked now and then): taken out
      // of config.json, so search reranks where it did, and set up again now.
      let gone = existsSync(path.join(d.place.model, READY)) ? null : "its model isn't this kit's";
      if (!gone && d.now() - lastStatusAt >= RERANK_STATUS_MS) {
        lastStatusAt = d.now();
        const s = await d.status(exe);
        if (!s.ready) gone = `it isn't compiled for this NPU's driver as it is now (${s.error ?? `plugin ${s.plugin ?? 'unknown'}`})`;
      }
      if (gone) {
        const out = withNpuRerank(readConfigFile(d.configFile).raw, null, d.tools);
        if (out) writeConfigFile(d.configFile, out, validateKeeperConfig);
        d.log(`the NPU's reranker is taken out of config.json, as ${gone}: search reranks where it did until it's set up again`);
        lastStatusAt = 0;
        return await prepareNow(d, exe);
      }
      if (JSON.stringify(had.startCommand) === JSON.stringify(ep.startCommand) && had.baseUrl === ep.baseUrl) return { did: 'current' };
      // Its server on another program still running: a later look, once the keeper has stopped it for being idle.
      if (await (d.answers ?? answers)(had.baseUrl ?? ep.baseUrl!)) return { did: 'busy' };
      const bad = await d.test(ep);
      if (bad.length) {
        d.log(`the NPU's reranker keeps its program: this kit's didn't answer its test: ${bad.join('; ')}`);
        return { did: 'failed', why: bad.join('; ') };
      }
      const out = withNpuRerank(readConfigFile(d.configFile).raw, ep, d.tools);
      if (!out) return { did: 'busy' };
      const saved = writeConfigFile(d.configFile, out, validateKeeperConfig);
      if (saved.problems.length) return { did: 'failed', why: saved.problems.join('; ') };
      d.log("the NPU's reranker now runs this kit's program");
      return { did: 'refreshed' };
    }
    return await prepareNow(d, exe);
  } catch (e: any) {
    return failed(d, e);
  }
}

function failed(d: RerankLookDeps, e: any): RerankLook {
  if (e instanceof LockTimeout) return { did: 'busy' };
  lastFailedAt = d.now();
  const why = String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 400);
  d.log(`the NPU's reranker couldn't be set up (${why}): search reranks where it did; a look in ${RERANK_RETRY_MS / 3600_000} hours tries again`);
  return { did: 'failed', why };
}

/** Whether a server answers at `base` (its /v1/models, within 3 s). */
async function answers(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The set-up: fetched and made, compiled and checked (--prepare, gently), its server tested, and written as the NPU's reranker. */
async function prepareNow(d: RerankLookDeps, exe: string): Promise<RerankLook> {
  try {
    if (d.now() - lastFailedAt < RERANK_RETRY_MS) return { did: 'waiting' };
    const s = await d.status(exe).catch(() => null);
    if (s?.giveUp) return { did: 'waiting' };
    d.settingUp(SETTING_UP);
    try {
      d.log("setting up the NPU's reranker: the model is made here and compiled for this NPU, in the background, at the gentle pace");
      await d.fetch(exe);
      const said = await d.prepare(exe);
      if (said.busy) return { did: 'busy' };
      if (said.prepared !== 1) throw new Error(said.error ?? 'its compile said nothing more');
      if (said.check) d.log(`the NPU's reranker passed its check against the processor (logits ${JSON.stringify(said.check)}), ${said.compiled ? `compiled in ${Math.round((said.compile?.ms ?? said.ms) / 60_000)} min` : 'compiled before'}`);
      const ep = rerankEndpoint(d.place, exe);
      const bad = await d.test(ep);
      if (bad.length) throw new Error(`its server didn't answer its test: ${bad.join('; ')}`);
      const out = withNpuRerank(readConfigFile(d.configFile).raw, ep, d.tools);
      if (!out) return { did: 'busy' };
      const saved = writeConfigFile(d.configFile, out, validateKeeperConfig);
      if (saved.problems.length) throw new Error(`config.json wasn't written: ${saved.problems.join('; ')}`);
      d.log(`the NPU's reranker is set up: search reranks on the NPU from now (port ${NPU_RERANK_PORT})`);
      return { did: 'prepared' };
    } finally {
      d.settingUp(null);
    }
  } catch (e: any) {
    return failed(d, e);
  }
}

/** For tests: the look's memory of failures and status asks, forgotten. */
export function resetRerankLook(): void {
  lastFailedAt = 0;
  lastStatusAt = 0;
}

/** The deps of the PC's own look: the kit's program, Hugging Face's files, the gentle pace, setup's test. */
export function pcRerankDeps(o: { log: (line: string) => void; configFile?: string; env?: NodeJS.ProcessEnv }): RerankLookDeps {
  const env = o.env ?? process.env;
  const place = rerankPlace(env);
  const runtime = placeOf(ocrHome(env), 'x64', VITISAI_PACK);
  const work = { h: null as ReturnType<typeof startWork> | null };
  return {
    configFile: o.configFile ?? acceleratorConfigFile(env),
    tools: toolsHome(env),
    place,
    exe: rerankExe,
    status: async (exe) => (await runRerankProgram(exe, [...placeArgs(place), '--status'], 'ready', { log: place.log, timeoutMs: 5 * 60_000 })) as RerankStatus,
    fetch: async (exe) => {
      // One fetch of the runtime at a time, the text reader's or this one's (its lock, ocr-npu.ts' fetchInBackground).
      await withLock(path.join(locksDir, 'ocr-fetch'), () => fetchRuntime(runtime, 'x64', VITISAI_PACK, { log: o.log, for: "the NPU's reranker" }), { waitMs: 30 * 60_000, staleMs: 60 * 60_000 });
      await makeModel(place, exe, { log: o.log });
    },
    prepare: (exe) =>
      // Processor work and the NPU's compiler: the NPU's turn isn't taken; one agent's prepare at a time (and the program's own lock besides).
      withLock(
        path.join(locksDir, 'rerank-npu-prepare'),
        () =>
          runRerankProgram(exe, [...placeArgs(place), '--prepare'], 'prepared', {
            log: place.log,
            timeoutMs: PREPARE_MS,
            cwd: place.cache,
            onStart: (pid) => void paceStarted(pid, { pace: 'gentle' }),
            // The compile in a program of its own: set to the gentle pace too, as Windows doesn't give it efficiency mode.
            onLine: (m) => {
              if (typeof m.compiling === 'number') void paceStarted(m.compiling, { pace: 'gentle' });
            },
          }),
        { waitMs: 0, staleMs: PREPARE_MS + 30 * 60_000 },
      ),
    test: (ep) => testNpuRerank(ep, { logFile: path.join(serverLogsDir(env), 'npu.rerank.log') }),
    log: o.log,
    settingUp: (text) => {
      if (text) {
        work.h?.done();
        work.h = startWork({ kind: 'setup', what: "Setting up the NPU's reranker: compiling it for this NPU, once" });
        setSettingUp('rerank-npu', { text, accelerator: 'npu' });
      } else {
        work.h?.done();
        work.h = null;
        setSettingUp('rerank-npu', null);
      }
    },
    now: Date.now,
  };
}

/** Whether this process may set the NPU's reranker up: Windows on x64 (AMD's NPUs), not a test run, not KIT_RERANK_NPU=off. */
export const rerankNpuAllowed = (env: NodeJS.ProcessEnv = process.env, platform = process.platform, arch = process.arch): boolean =>
  platform === 'win32' && arch === 'x64' && !env.NODE_TEST_CONTEXT && env.KIT_RERANK_NPU !== 'off';

let looking: Promise<RerankLook> | null = null;

/**
 * The keeper's look at the NPU's reranker (lookRerankNpu), in the background, at most one at a time: a look never waits
 * for it, and its set-up (an hour or so) runs beside the looks that follow. Its program's path goes in config.json as
 * %USERPROFILE%\…, expanded when it's started (expandEnv).
 */
export function startRerankNpu(o: { log: (line: string) => void; env?: NodeJS.ProcessEnv }): void {
  if (looking || !rerankNpuAllowed(o.env)) return;
  looking = lookRerankNpu(pcRerankDeps(o))
    .catch((e: any): RerankLook => {
      o.log(`the NPU's reranker couldn't be looked at: ${e?.message ?? e}`);
      return { did: 'failed', why: String(e?.message ?? e) };
    })
    .finally(() => (looking = null));
}
