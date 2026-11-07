/**
 * Can a LoRA add-on for Qwen3-VL-2B run on the Snapdragon's Hexagon NPU, and at what cost? (kit/spec/ACCELERATORS.md,
 * Add-ons.) It starts llama.cpp's llama-server on the Hexagon the way the kit's NPU embedding server runs (`--device
 * HTP0 -ngl 99`, ADSP_LIBRARY_PATH at the build's folder), with and without add-ons, on a private port, and records:
 *
 * - placement: where every op of the graph runs (llama.cpp's scheduler, GGML_SCHED_DEBUG=2), its splits, the add-on's
 *   tensors' buffers, and the Hexagon's own time for each op (GGML_HEXAGON_PROFILE=1);
 * - speed: prompt and generation tokens a second (llama-server's own timings), with and without the add-on;
 * - memory: the process's working set and private bytes, and what it holds on the NPU (Windows' GPU Process Memory
 *   counters for the NPU's adapter, the one DXGI doesn't list);
 * - switch: the time to turn the add-on on and off between requests (per request, and through POST /lora-adapters);
 * - answers: the Warrener's naming prompt (Warrener src/namer.ts, v3) on documents made up here, greedy, on the NPU and
 *   on the processor (the reference);
 * - odds: the model's own log-probabilities for the name's first token, each add-on off, on and off again, on the NPU
 *   and on the processor: how much of the processor's change the NPU makes, and whether an add-on switched off leaves
 *   anything behind (a Q8_0 add-on does, on b11645: kit/spec/ACCELERATORS.md);
 * - geniex: the kit's chat route (`geniex serve`) against the llama-server route without an add-on: speed, memory, the
 *   kit benchmark's 24 quality items and 4 pictures, and whether GenieX takes a per-request `lora` field;
 * - memory: the llama-server route as the kit runs it (projector and add-ons loaded at the start), with each projector
 *   (`--mmproj` and every `--mmproj-alt`): what it holds loaded, after chat, after pictures, and after each a trim of
 *   its working set (working-set.ts), with the speed and the pictures before and after;
 * - leak: whether llama-server on the Hexagon carries anything from one request to the next that shares its start
 *   (GenieX's `prefix-leak`): the Warrener's names and the quality items asked in a row with the prompt cache on, again
 *   in the other order, and each alone with it off, compared word for word;
 * - cpu: the processor the chat server keeps busy, idle, writing, reading and naming, with llama-server's own threads
 *   and with fewer, not polling: GenieX keeps it near idle;
 * - kit: the route as this kit runs it (kit 2.152.2), from the kit's own code: the X2's chatServer command and
 *   environment (routeFor, npuEntry) with the add-ons loaded, its working set trimmed once loaded, and every request
 *   the kit's (chatBody, visionBody, fitPicture, addonFor): the NPU benchmark's 24 quality items and 4 pictures with
 *   the add-ons held at 0, the speed, the Warrener's names with its add-on applied, and the memory.
 *
 * Each block runs in the NPU's turn (the kit's NPU line, background lane), so the staff's own requests wait for it
 * rather than run beside it. It starts only servers of its own, on its own ports, and stops each one; the installed
 * manor's are left alone. Nothing here is shipped: it is the test behind the findings.
 *
 *   node tools/addon-npu/addon-test.ts --hex <llama.cpp Hexagon folder> --model <2B GGUF> --mmproj <projector GGUF>
 *     --lora r32-f16=<file> [--lora name=<file> ...] --out <folder>
 *     [--phases placement,speed,switch,answers,odds,geniex,memory,leak,cpu,defaults,footprint,crash,kit] [--geniex <geniex.exe>] [--port 28601]
 *     [--threads 8] [--runs 3] [--hex-env NAME=value ...] [--mmproj-alt name=<projector GGUF> ...] [--lora-style init|scaled0]
 *
 * README.md beside this file says how to make the throwaway add-ons (make_lora.py) and run it.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grade, picturePng, promptOf, SUITE } from '../../src/kit/npu-bench.ts';
import { npuLockDir } from '../../src/kit/lock.ts';
import { withNpuTurn } from '../../src/kit/npu-queue.ts';
import { trimWorkingSet } from '../../src/kit/working-set.ts';
import { chatBody, fitPicture, visionBody } from '../../src/kit/accelerators.ts';
import { addonFor } from '../../src/kit/addons.ts';
import { NPU_CATALOG, npuEntry, pinnedRoute, routeFor } from '../../src/kit/npu-vendors.ts';

// ------------------------------------------------------------------------------------------------ options

interface Options {
  hex: string;
  model: string;
  mmproj: string | null;
  /** More projectors for the memory phase, each named (`--mmproj-alt q8=<file>`). */
  mmprojAlts: { name: string; file: string }[];
  /** The crash phase's cases to run, by name (`--only a,b`); all when none. */
  only: string[];
  loras: { name: string; file: string }[];
  out: string;
  phases: Set<string>;
  geniex: string | null;
  port: number;
  threads: number;
  runs: number;
  ctx: number;
  /** More environment for the Hexagon servers (`--hex-env GGML_HEXAGON_MM_SELECT=1`: vector units only). */
  hexEnv: Record<string, string>;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { hex: '', model: '', mmproj: null, mmprojAlts: [], only: [], loras: [], out: '', phases: new Set(['placement', 'speed', 'switch', 'answers', 'odds', 'geniex']), geniex: null, port: 28601, threads: 8, runs: 3, ctx: 2560, hexEnv: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--hex') o.hex = v();
    else if (a === '--model') o.model = v();
    else if (a === '--mmproj') o.mmproj = v();
    else if (a === '--only') o.only = v().split(',').filter(Boolean);
    else if (a === '--lora-style') {
      const st = v();
      if (st !== 'init' && st !== 'scaled0') throw new Error(`--lora-style is init or scaled0, not ${st}`);
      loraStyle = st;
    } else if (a === '--mmproj-alt') {
      const [name, ...rest] = v().split('=');
      o.mmprojAlts.push({ name, file: rest.join('=') });
    } else if (a === '--lora') {
      const [name, ...rest] = v().split('=');
      o.loras.push({ name, file: rest.join('=') });
    } else if (a === '--out') o.out = v();
    else if (a === '--phases') o.phases = new Set(v().split(','));
    else if (a === '--geniex') o.geniex = v();
    else if (a === '--port') o.port = Number(v());
    else if (a === '--threads') o.threads = Math.min(8, Number(v()));
    else if (a === '--runs') o.runs = Number(v());
    else if (a === '--ctx') o.ctx = Number(v());
    else if (a === '--hex-env') {
      const [k, ...rest] = v().split('=');
      o.hexEnv[k] = rest.join('=');
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!o.hex || !o.model || !o.out) throw new Error('--hex, --model and --out are needed');
  return o;
}

// ------------------------------------------------------------------------------------------------ servers

interface Server {
  name: string;
  child: ChildProcess;
  pid: number;
  base: string;
  log: string;
  startedMs: number;
  readyMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for `ok()` to say true, looking every `everyMs`, until `deadlineMs` has passed: then throws `why`. */
async function until(ok: () => Promise<boolean>, deadlineMs: number, why: string, everyMs = 250): Promise<void> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (await ok()) return;
    if (Date.now() >= end) throw new Error(why);
    await sleep(everyMs);
  }
}

async function answers(url: string, ms = 2000): Promise<number | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.status;
  } catch {
    return null;
  }
}

async function start(name: string, exe: string, args: string[], env: Record<string, string>, port: number, log: string, ready: string): Promise<Server> {
  const base = `http://127.0.0.1:${port}`;
  if ((await answers(`${base}/health`, 1000)) !== null) throw new Error(`something already answers on ${base}`);
  const fd = openSync(log, 'w');
  const startedMs = Date.now();
  const child = spawn(exe, args, { cwd: path.dirname(exe), env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], windowsHide: true });
  closeSync(fd);
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));
  await until(async () => {
    if (exited !== null) throw new Error(`${name} exited (${exited}) before it answered: ${log}`);
    return (await answers(`${base}${ready}`)) === 200;
  }, 240_000, `${name} didn't answer within 240 s: ${log}`);
  return { name, child, pid: child.pid!, base, log, startedMs, readyMs: Date.now() - startedMs };
}

async function stop(s: Server): Promise<void> {
  if (s.child.exitCode === null) {
    const gone = new Promise<void>((r) => s.child.once('exit', () => r()));
    try {
      execFileSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      s.child.kill();
    }
    await Promise.race([gone, sleep(20_000)]);
  }
  await until(async () => (await answers(`${s.base}/health`, 500)) === null, 20_000, `${s.name} still answers after it was stopped`);
}

async function withServer<T>(name: string, exe: string, args: string[], env: Record<string, string>, o: Options, ready: string, fn: (s: Server) => Promise<T>): Promise<T> {
  const log = path.join(o.out, `${name}.log`);
  const s = await start(name, exe, args, env, o.port, log, ready);
  try {
    return await fn(s);
  } finally {
    await stop(s);
  }
}

/** One block of work in the NPU's turn: the staff's NPU requests wait for it rather than run beside it. */
const inNpuTurn = <T>(doing: string, fn: () => Promise<T>) =>
  withNpuTurn(npuLockDir, fn, { lane: 'background', who: 'addon-test', doing: doing.slice(0, 80), waitMs: 30 * 60_000, staleMs: 40 * 60_000 });

function hexArgs(o: Options, extra: string[] = []): { exe: string; env: Record<string, string> } & { args: string[] } {
  return {
    exe: path.join(o.hex, 'llama-server.exe'),
    env: { ADSP_LIBRARY_PATH: o.hex, LLAMA_ARG_CACHE_RAM: '0', ...o.hexEnv },
    args: ['--host', '127.0.0.1', '--port', String(o.port), '--device', 'HTP0', '-ngl', '99', '-m', o.model, '-c', String(o.ctx), '--parallel', '1', '-t', String(o.threads), '-tb', String(o.threads), ...extra],
  };
}

function cpuArgs(o: Options, extra: string[] = []): { exe: string; env: Record<string, string>; args: string[] } {
  return {
    exe: path.join(o.hex, 'llama-server.exe'),
    env: { LLAMA_ARG_CACHE_RAM: '0' },
    args: ['--host', '127.0.0.1', '--port', String(o.port), '--device', 'none', '-ngl', '0', '--no-op-offload', '-m', o.model, '-c', String(o.ctx), '--parallel', '1', '-t', String(o.threads), '-tb', String(o.threads), ...extra],
  };
}

/**
 * How a server loads its add-ons (`--lora-style`): `init`, each with --lora and --lora-init-without-apply; `scaled0`,
 * each at scale 0 with --lora-scaled (b11645's --lora-init-without-apply leaves a request without a `lora` field at 1).
 */
let loraStyle: 'init' | 'scaled0' = 'init';
const loraArgs = (files: string[]) =>
  !files.length ? [] : loraStyle === 'scaled0' ? ['--lora-scaled', files.map((f) => `${f}:0`).join(',')] : [...files.flatMap((f) => ['--lora', f]), '--lora-init-without-apply'];

// ------------------------------------------------------------------------------------------------ memory

interface Memory {
  workingSetMb: number;
  privateMb: number;
  cpuSeconds: number;
  /** Per adapter LUID: shared and dedicated MB, as Windows' GPU Process Memory counters say for this process. */
  adapters: Record<string, { sharedMb: number; dedicatedMb: number; name: string }>;
  npuMb: number | null;
  availableMb: number;
}

let dxgi: Record<string, string> | null = null;

/** The adapters DXGI lists (the graphics), by LUID: the NPU is the adapter it doesn't list. */
function dxgiAdapters(): Record<string, string> {
  if (dxgi) return dxgi;
  const ps1 = path.resolve(import.meta.dirname, '../../kit/node/gpu-load.ps1');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, 'adapters'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const j = JSON.parse(out) as { adapters: { name: string; luid: string }[] };
  dxgi = Object.fromEntries(j.adapters.map((a) => [a.luid.toLowerCase(), a.name]));
  return dxgi;
}

function memoryOf(pid: number): Memory {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Get-Process -Id ${pid}
$os = Get-CimInstance Win32_OperatingSystem
$c = Get-Counter '\\GPU Process Memory(pid_${pid}_*)\\Shared Usage','\\GPU Process Memory(pid_${pid}_*)\\Dedicated Usage'
$rows = @($c.CounterSamples | ForEach-Object { '{0}|{1}' -f $_.Path, [int64]$_.RawValue })
[pscustomobject]@{ ws = $p.WorkingSet64; priv = $p.PrivateMemorySize64; cpu = $p.TotalProcessorTime.TotalSeconds; avail = [int64]$os.FreePhysicalMemory * 1024; rows = $rows } | ConvertTo-Json -Compress`;
  const j = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })) as { ws: number; priv: number; cpu: number; avail: number; rows: string[] };
  const known = dxgiAdapters();
  const adapters: Memory['adapters'] = {};
  for (const row of j.rows ?? []) {
    const m = row.match(/luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+\)\\(shared|dedicated) usage\|(\d+)/i);
    if (!m) continue;
    const luid = m[1].toLowerCase();
    const a = (adapters[luid] ??= { sharedMb: 0, dedicatedMb: 0, name: known[luid] ?? 'NPU (no DXGI adapter)' });
    if (m[2].toLowerCase() === 'shared') a.sharedMb = Number(m[3]) / 2 ** 20;
    else a.dedicatedMb = Number(m[3]) / 2 ** 20;
  }
  const npu = Object.entries(adapters).filter(([luid]) => !(luid in known));
  return {
    workingSetMb: j.ws / 2 ** 20,
    privateMb: j.priv / 2 ** 20,
    cpuSeconds: j.cpu,
    adapters,
    npuMb: npu.length ? npu.reduce((s, [, a]) => s + a.sharedMb + a.dedicatedMb, 0) : null,
    availableMb: j.avail / 2 ** 20,
  };
}

// ------------------------------------------------------------------------------------------------ requests

interface Timings {
  promptTokens: number;
  promptMs: number;
  genTokens: number;
  genMs: number;
  wallMs: number;
  firstTokenMs: number | null;
  text: string;
}

const tps = (n: number, ms: number) => (ms > 0 ? (n * 1000) / ms : 0);

/**
 * A turn of the event loop before each request, so a keep-alive socket the server closed meanwhile is seen closed first.
 * llama-server closes one after 5 s idle; the meter's PowerShell (execFileSync) holds this process for longer, and a
 * request sent the moment it returns went out on the closed socket: `fetch failed`, which read as the server dying (the
 * crash phase's name-blocked case: a 4 s execFileSync sleep twice, 3 of 3; the same sleep as a child process, 0 of 3).
 */
const settled = () => new Promise<void>((r) => setTimeout(r, 20));

async function post(url: string, body: unknown, timeoutMs = 300_000): Promise<{ status: number; json: any; text: string; ms: number }> {
  await settled();
  const t0 = performance.now();
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  const ms = performance.now() - t0;
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, json, text, ms };
}

type Lora = { id: number; scale: number }[] | undefined;

/** A chat request to llama-server, greedy, with its own timings. */
async function chat(s: Server, messages: unknown[], maxTokens: number, lora: Lora, extra: Record<string, unknown> = {}): Promise<Timings> {
  const r = await post(`${s.base}/v1/chat/completions`, { messages, max_tokens: maxTokens, temperature: 0, top_k: 1, seed: 1, stream: false, ...(lora ? { lora } : {}), ...extra });
  if (r.status !== 200) throw new Error(`${s.name}: ${r.status} ${r.text.slice(0, 300)}`);
  const t = r.json.timings ?? {};
  return { promptTokens: t.prompt_n ?? 0, promptMs: t.prompt_ms ?? 0, genTokens: t.predicted_n ?? 0, genMs: t.predicted_ms ?? 0, wallMs: r.ms, firstTokenMs: null, text: r.json.choices?.[0]?.message?.content ?? '' };
}

/** A raw completion (no chat template), for steady speed: `n` tokens written whatever the model would stop at. */
async function complete(s: Server, prompt: string, n: number, lora: Lora): Promise<Timings> {
  const r = await post(`${s.base}/completion`, { prompt, n_predict: n, temperature: 0, top_k: 1, seed: 1, ignore_eos: true, cache_prompt: false, ...(lora ? { lora } : {}) });
  if (r.status !== 200) throw new Error(`${s.name}: ${r.status} ${r.text.slice(0, 300)}`);
  const t = r.json.timings ?? {};
  return { promptTokens: t.prompt_n ?? 0, promptMs: t.prompt_ms ?? 0, genTokens: t.predicted_n ?? 0, genMs: t.predicted_ms ?? 0, wallMs: r.ms, firstTokenMs: null, text: r.json.content ?? '' };
}

/** A streamed OpenAI chat request (any server): the time to its first token and to its last, by the clock here. */
async function streamed(base: string, body: Record<string, unknown>): Promise<Timings & { usage: any; raw: string[] }> {
  await settled();
  const t0 = performance.now();
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }), signal: AbortSignal.timeout(300_000) });
  if (r.status !== 200) throw new Error(`${base}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  let first: number | null = null;
  let last = 0;
  let text = '';
  let usage: any = null;
  let timings: any = null;
  let chunks = 0;
  const raw: string[] = [];
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      if (raw.length < 3) raw.push(data.slice(0, 300));
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        const now = performance.now() - t0;
        if (first === null) first = now;
        last = now;
        text += delta;
        chunks++;
      }
      if (j.usage) usage = j.usage;
      if (j.timings) timings = j.timings;
    }
  }
  const wall = performance.now() - t0;
  const gen = usage?.completion_tokens ?? timings?.predicted_n ?? chunks;
  return {
    promptTokens: usage?.prompt_tokens ?? timings?.prompt_n ?? 0,
    promptMs: first ?? wall,
    genTokens: gen,
    genMs: first !== null ? last - first : 0,
    wallMs: wall,
    firstTokenMs: first,
    text,
    usage,
    raw,
  };
}

// ------------------------------------------------------------------------------------------------ the Warrener's prompt

/** Warrener src/namer.ts (PROMPT_VERSION v3), the English defaults' folders (settings.ts). */
const NAME_SYSTEM = 'You name files and choose a folder for each. Reply with exactly two lines and nothing else.';
const FOLDERS: [string, string][] = [
  ['Documents\\Receipts', 'proof of something bought or paid for: receipts, paid invoices, order confirmations'],
  ['Documents\\Insurance', 'insurance policies, renewals, ID cards and claims'],
  ['Documents\\Manuals', 'instructions and guides for products, appliances and software'],
  ['Documents\\Statements', 'periodic account statements: bank, card, utility, investment, payroll'],
  ['Documents\\Letters', 'correspondence to or from someone: letters, notices, official mail'],
  ['Documents\\Contracts', 'agreements and terms to sign or signed: contracts, leases, offers, terms of service'],
  ['Documents\\Other', 'anything that fits none of the folders above'],
];

function namePrompt(fileName: string, how: string, text: string): { role: string; content: string }[] {
  const question = [
    'Folders:',
    ...FOLDERS.map(([label, about], i) => `${i + 1}. ${label}: ${about}`),
    '',
    'Task: suggest a short, descriptive name for this file, at most 8 words, without an extension. If a date is evident in the text, start the name with it as YYYY-MM or YYYY-MM-DD, for example "2026-09 Acme auto insurance renewal". Then choose the ONE folder above for what this document is (a contract, a statement, a receipt...), not for a word it happens to contain.',
    'Reply in exactly this form:',
    'NAME: the name',
    'FOLDER: the number and name of one folder above',
  ].join('\n');
  const body = `Text from the file (${how}; may be partial or contain reading errors):\n<<<\n${text.trim()}\n>>>\n`;
  return [
    { role: 'system', content: NAME_SYSTEM },
    { role: 'user', content: `File name: ${fileName}\n${body}\n${question}` },
  ];
}

/** Made-up documents of the kinds the Warrener files: no real company, person or account. */
const DOCS: { file: string; how: string; text: string }[] = [
  { file: 'scan0042.pdf', how: 'first page, OCR', text: `GREENFIELD HARDWARE CO.\n14 Mill Lane, Ashbury\nReceipt #A-778213\nDate: 2026-08-14 10:42\nCordless drill 18V ........ 89.99\nDrill bit set (24) ........ 14.50\nWood screws 4x40 (200) .... 6.25\nSubtotal 110.74\nVAT 20% 22.15\nTOTAL 132.89\nPaid: VISA ****4471\nThank you for shopping with us. Returns within 30 days with receipt.` },
  { file: 'Renewal_Notice.pdf', how: 'first page', text: `Northgate Mutual Insurance\nPolicy number: HM-5520193\nDear policyholder,\nYour home and contents policy renews on 1 October 2026. Your new annual premium is 412.60, payable in 12 monthly instalments of 34.38. Buildings sum insured: 285,000. Contents sum insured: 45,000. Excess: 250.\nPlease review the enclosed schedule and statement of fact. If anything has changed, call us before the renewal date.\nRenewal date: 2026-10-01` },
  { file: 'statement_09.pdf', how: 'first page', text: `Harbour Savings Bank\nCurrent Account Statement\nStatement period: 1 September 2026 to 30 September 2026\nAccount: 40-11-92 61839027\nOpening balance 2,431.18\n02 Sep  Direct debit  Ashbury Water        -38.20\n05 Sep  Card payment  Greenfield Hardware  -132.89\n15 Sep  Salary        Lindqvist Ltd       +2,850.00\n21 Sep  Standing order Rent               -950.00\nClosing balance 4,160.09` },
  { file: 'lease-final.docx', how: 'its start', text: `ASSURED SHORTHOLD TENANCY AGREEMENT\nThis agreement is made on 3 March 2026 between Mr P. Okafor (the Landlord) and Ms R. Haldane (the Tenant) for the property at Flat 2, 9 Quarry Road, Ashbury.\n1. Term: 12 months from 1 April 2026.\n2. Rent: 950 per calendar month, payable in advance on the 1st.\n3. Deposit: 1,096, protected in a government-approved scheme.\n4. The Tenant shall keep the property in good and clean condition.\nSigned by both parties.` },
  { file: 'KM-300_manual_EN.pdf', how: 'first page', text: `KM-300 Stand Mixer\nInstruction Manual\nRead all instructions before use and keep them for future reference.\nContents: Safety, Parts, Assembly, Speed settings, Cleaning, Troubleshooting.\nAssembly: 1. Place the bowl on the base and turn clockwise until it locks. 2. Fit the beater by pushing up and turning. 3. Lower the head and lock it.\nSpeed 1-2: folding. Speed 3-4: mixing. Speed 5-6: whisking cream and egg whites.` },
  { file: 'council_letter.pdf', how: 'first page, OCR', text: `Ashbury District Council\nRevenue Services\n12 August 2026\nDear Ms Haldane,\nCouncil Tax: change of address\nThank you for telling us you have moved to Flat 2, 9 Quarry Road. We have closed your account at your previous address and opened a new account, reference 7740019. Your first bill will follow within 14 days. If you have any questions please contact us quoting your reference.\nYours sincerely,\nRevenue Team` },
  { file: 'order-confirmation.html', how: 'its start', text: `Thanks for your order!\nOrder number 113-4459201\nPlaced on 22 October 2026\nShipped to: R. Haldane, Flat 2, 9 Quarry Road\n1 x Noise-cancelling headphones, black  119.00\n1 x USB-C charging cable 2 m           9.99\nDelivery: free\nOrder total: 128.99\nPayment: charged to Mastercard ending 0932\nEstimated delivery: 24-25 October.` },
  { file: 'payslip_oct.pdf', how: 'first page', text: `LINDQVIST LTD - PAYSLIP\nEmployee: R. Haldane   Employee no: 0317\nPay date: 31/10/2026   Tax period: 7\nBasic salary         3,500.00\nOvertime               210.00\nGross pay            3,710.00\nIncome tax            -512.40\nNational Insurance    -238.80\nPension (5%)          -185.50\nNet pay              2,773.30\nYear to date gross: 24,970.00` },
];

const freshSystem = (tag: string) => `[${tag}] ${NAME_SYSTEM}`;

// ------------------------------------------------------------------------------------------------ placement

interface Placement {
  graphs: number;
  /** The largest graph (a prompt's): its splits, its nodes by backend, and every node not on the NPU. */
  largest: { nodes: number; splits: string[]; byBackend: Record<string, number>; offNpu: string[] };
  /** The graph sizes seen, and whether every graph had the same splits. */
  splitsSeen: string[];
  offNpuOps: Record<string, number>;
  /** llama_adapter_lora_init's buffer for each add-on weight, counted. */
  loraBuffers: Record<string, number>;
  loraWarnings: string[];
  /** The Hexagon's own time for each op kind over the run (GGML_HEXAGON_PROFILE), and the add-on's share. */
  dspUsecByOp: Record<string, number>;
  dspUsecLora: number;
  dspOpsLora: number;
  /** The same, split into the prompt's graph (more than one token) and the written tokens' (one), all ops and the add-on's. */
  dsp: { prompt: { all: number; lora: number; tokens: number }; gen: { all: number; lora: number; graphs: number } };
  /** The add-on's matmuls by kernel and type ("hvx-tiled f16"), with their time on the prompt. */
  loraKernels: Record<string, { ops: number; usec: number }>;
  /** A line of the server's that says the Hexagon failed, if it did. */
  failed: string | null;
}

const stamp = /^\d+\.\d+\.\d+\.\d+ [A-Z] /;

function parsePlacement(log: string): Placement {
  const lines = readFileSync(log, 'utf8').split(/\r?\n/).map((l) => l.replace(stamp, ''));
  // A graph's print: "## SPLIT #0: <backend> # <n> inputs..." then "node #..." lines, until the next "## SPLIT #0".
  const graphs: { splits: string[]; nodes: string[] }[] = [];
  let g: { splits: string[]; nodes: string[] } | null = null;
  for (const raw of lines) {
    const l = raw.replace(/\d+\.\d+\.\d+\.\d+ D /g, '');
    const sp = l.match(/^## SPLIT #(\d+): (\S+)/);
    if (sp) {
      if (sp[1] === '0') graphs.push((g = { splits: [], nodes: [] }));
      g?.splits.push(sp[2]);
      continue;
    }
    if (g && l.startsWith('node #')) g.nodes.push(l);
  }
  const backendOf = (node: string) => node.match(/\)\s+\[\s*(\S+)\s/)?.[1] ?? '?';
  const largest = graphs.reduce((a, b) => (b.nodes.length > (a?.nodes.length ?? -1) ? b : a), graphs[0]);
  const byBackend: Record<string, number> = {};
  for (const n of largest?.nodes ?? []) byBackend[backendOf(n)] = (byBackend[backendOf(n)] ?? 0) + 1;
  const offNpuOps: Record<string, number> = {};
  for (const gr of graphs)
    for (const n of gr.nodes) {
      if (backendOf(n) === 'HTP0') continue;
      const op = n.match(/^node #\s*\d+ \(\s*([^)]+?)\)/)?.[1] ?? '?';
      const name = n.match(/\):\s+(\S+)/)?.[1] ?? '?';
      const key = `${op} ${name}`;
      offNpuOps[key] = (offNpuOps[key] ?? 0) + 1;
    }
  const loraBuffers: Record<string, number> = {};
  const loraWarnings: string[] = [];
  const dspUsecByOp: Record<string, number> = {};
  let dspUsecLora = 0;
  let dspOpsLora = 0;
  const dsp = { prompt: { all: 0, lora: 0, tokens: 0 }, gen: { all: 0, lora: 0, graphs: 0 } };
  const loraKernels: Record<string, { ops: number; usec: number }> = {};
  let failed: string | null = null;
  // The add-on's own nodes downstream of its matmuls (its SCALE and ADD): named node_N, so found by what they read.
  const loraOut = new Set<string>();
  for (const l of lines) {
    const b = l.match(/lora for '([^']+)' -> '([^']+)'/);
    if (b) loraBuffers[b[2]] = (loraBuffers[b[2]] ?? 0) + 1;
    if (/lora.*(cannot|fallback)/i.test(l)) loraWarnings.push(l.trim());
    if (!failed && /(dsp-error|dsp-rsp [A-Z-]*ERROR|GGML_ASSERT|GGML_ABORT)/.test(l) && !/profile-op/.test(l)) failed = l.trim().slice(0, 240);
    // "profile-op OP|src x src -> dst|dims|types|strides|kernel|usec N ..."
    const p = l.match(/profile-op ([A-Z_0-9+]+)\|([^|]*)\|([^|]*)\|([^|]*)\|[^|]*\|([^|]*)\|usec (\d+)/);
    if (!p || p[1] === 'OPBATCH') continue;
    const [, op, names, dims, types, kernel, us] = p;
    const usec = Number(us);
    dspUsecByOp[op] = (dspUsecByOp[op] ?? 0) + usec;
    const [srcs, dst] = names.split(' -> ');
    const srcList = srcs.split(' x ');
    const isLora = /lora_[ab]/.test(srcs) || (/^(SCALE|ADD)/.test(op) && srcList.some((x) => loraOut.has(x)));
    if (isLora) loraOut.add(dst);
    const tokens = Number(dims.split(' -> ')[1]?.split(':')[1] ?? '1');
    const part = tokens > 1 ? dsp.prompt : dsp.gen;
    part.all += usec;
    if (isLora) {
      part.lora += usec;
      dspUsecLora += usec;
      dspOpsLora++;
      if (/MUL_MAT/.test(op) && tokens > 1) {
        const k = `${kernel.trim().split(' ')[0]} ${types.split(' x ')[0]} ${/lora_a/.test(srcs) ? 'A' : 'B'}`;
        const e = (loraKernels[k] ??= { ops: 0, usec: 0 });
        e.ops++;
        e.usec += usec;
      }
    }
    if (/attn_q\.weight x /.test(srcs) && !isLora) dsp.prompt.tokens = Math.max(dsp.prompt.tokens, tokens);
    if (op === 'MUL_MAT' && /result_output/.test(dst) && tokens <= 1) dsp.gen.graphs++;
  }
  return {
    graphs: graphs.length,
    largest: { nodes: largest?.nodes.length ?? 0, splits: largest?.splits ?? [], byBackend, offNpu: (largest?.nodes ?? []).filter((n) => backendOf(n) !== 'HTP0').map((n) => n.replace(/\s+/g, ' ').slice(0, 160)) },
    splitsSeen: [...new Set(graphs.map((x) => x.splits.join(' > ')))],
    offNpuOps,
    loraBuffers,
    loraWarnings,
    dspUsecByOp,
    dspUsecLora,
    dspOpsLora,
    dsp,
    loraKernels,
    failed,
  };
}

async function placement(o: Options, results: any): Promise<void> {
  const variants = [{ name: 'base', file: null as string | null }, ...o.loras.map((l) => ({ name: l.name, file: l.file }))];
  results.placement = {};
  for (const v of variants) {
    const h = hexArgs(o, [...loraArgs(v.file ? [v.file] : []), '-v']);
    const env = { ...h.env, GGML_SCHED_DEBUG: '2', GGML_HEXAGON_PROFILE: '1' };
    const lora: Lora = v.file ? [{ id: 0, scale: 1 }] : undefined;
    let error: string | null = null;
    let answer: string | null = null;
    try {
      await inNpuTurn(`add-on test: placement, ${v.name}`, () =>
        withServer(`placement-${v.name}`, h.exe, h.args, env, o, '/health', async (s) => {
          const d = DOCS[0];
          answer = (await chat(s, namePrompt(d.file, d.how, d.text), 8, lora)).text;
        }),
      );
    } catch (e) {
      error = String((e as Error).message ?? e).slice(0, 300);
    }
    const p = parsePlacement(path.join(o.out, `placement-${v.name}.log`));
    results.placement[v.name] = { ...p, error, answer };
    const ms = (us: number) => (us / 1000).toFixed(1);
    say(`placement ${v.name}: ${error ? `FAILED (${p.failed ?? error}); ` : ''}${JSON.stringify(p.largest.byBackend)}, splits ${p.splitsSeen.join(' | ')}, lora buffers ${JSON.stringify(p.loraBuffers)}; DSP prompt (${p.dsp.prompt.tokens} tokens) ${ms(p.dsp.prompt.all)} ms, the add-on's ${ms(p.dsp.prompt.lora)}; per written token ${ms(p.dsp.gen.all / Math.max(1, p.dsp.gen.graphs))} ms, the add-on's ${ms(p.dsp.gen.lora / Math.max(1, p.dsp.gen.graphs))}; kernels ${JSON.stringify(p.loraKernels)}`);
  }
}

// ------------------------------------------------------------------------------------------------ speed and memory

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** A prompt of about `tokens` tokens that no request before it started the same way. */
function readPromptOf(tokens: number, tag: string): string {
  const lines: string[] = [`[${tag}]`];
  for (let i = 1, chars = 0; chars < tokens * 4; i++) {
    const line = `Line ${i}: the steward counts the barrels in the cellar and writes the number down.`;
    lines.push(line);
    chars += line.length + 1;
  }
  return `${lines.join('\n')}\n\nHow many lines are there? Answer with the number only.`;
}

interface SpeedRow {
  variant: string;
  lora: boolean;
  promptTps: number;
  genTps: number;
  namePromptTps: number;
  nameWallMs: number;
  cpuSecondsPerGenToken: number;
}

async function speedBlock(o: Options, s: Server, variant: string, lora: Lora): Promise<SpeedRow> {
  const reads: number[] = [];
  const gens: number[] = [];
  const namesTps: number[] = [];
  const namesWall: number[] = [];
  const cpu0 = memoryOf(s.pid).cpuSeconds;
  let genTokens = 0;
  for (let r = 0; r < o.runs; r++) {
    const read = await complete(s, readPromptOf(1500, `${variant}-${lora ? 'on' : 'off'}-${r}`), 1, lora);
    reads.push(tps(read.promptTokens, read.promptMs));
    const gen = await complete(s, `[${variant}-${r}] Write a long story about a steward who keeps a manor's cellar.`, 128, lora);
    gens.push(tps(gen.genTokens, gen.genMs));
    genTokens += gen.genTokens;
    for (const [i, d] of DOCS.slice(0, 3).entries()) {
      const msgs = namePrompt(d.file, d.how, d.text);
      msgs[0].content = freshSystem(`${variant}-${r}-${i}-${lora ? 1 : 0}`);
      const t = await chat(s, msgs, 60, lora);
      namesTps.push(tps(t.promptTokens, t.promptMs));
      namesWall.push(t.wallMs);
      genTokens += t.genTokens;
    }
  }
  const cpu1 = memoryOf(s.pid).cpuSeconds;
  return { variant, lora: !!lora?.some((x) => x.scale > 0), promptTps: median(reads), genTps: median(gens), namePromptTps: median(namesTps), nameWallMs: median(namesWall), cpuSecondsPerGenToken: (cpu1 - cpu0) / Math.max(1, genTokens) };
}

async function speed(o: Options, results: any): Promise<void> {
  results.speed = [];
  results.memory = {};
  // The base alone, no add-on loaded at all.
  {
    const h = hexArgs(o);
    await inNpuTurn('add-on test: speed, base', () =>
      withServer('speed-base', h.exe, h.args, h.env, o, '/health', async (s) => {
        await complete(s, 'Hello', 4, undefined);
        results.memory.base = { loaded: memoryOf(s.pid), readyMs: s.readyMs };
        results.speed.push(await speedBlock(o, s, 'base', undefined));
        results.memory.base.after = memoryOf(s.pid);
      }),
    );
  }
  for (const l of o.loras) {
    const h = hexArgs(o, loraArgs([l.file]));
    await inNpuTurn(`add-on test: speed, ${l.name}`, () =>
      withServer(`speed-${l.name}`, h.exe, h.args, h.env, o, '/health', async (s) => {
        await complete(s, 'Hello', 4, [{ id: 0, scale: 1 }]);
        results.memory[l.name] = { loaded: memoryOf(s.pid), readyMs: s.readyMs };
        results.speed.push(await speedBlock(o, s, l.name, [{ id: 0, scale: 1 }]));
        results.speed.push(await speedBlock(o, s, l.name, [{ id: 0, scale: 0 }]));
        results.memory[l.name].after = memoryOf(s.pid);
      }),
    );
  }
  for (const row of results.speed) say(`speed ${row.variant} ${row.lora ? 'on ' : 'off'}: prompt ${row.promptTps.toFixed(0)} t/s, writes ${row.genTps.toFixed(1)} t/s, name prompt ${row.namePromptTps.toFixed(0)} t/s in ${row.nameWallMs.toFixed(0)} ms, ${(row.cpuSecondsPerGenToken * 1000).toFixed(1)} ms CPU a token`);
}

// ------------------------------------------------------------------------------------------------ switching

async function switching(o: Options, results: any): Promise<void> {
  const l = o.loras[0];
  if (!l) return;
  const h = hexArgs(o, loraArgs([l.file]));
  results.switch = await inNpuTurn(`add-on test: switching, ${l.name}`, () =>
    withServer(`switch-${l.name}`, h.exe, h.args, h.env, o, '/health', async (s) => {
      const d = DOCS[1];
      const msgs = namePrompt(d.file, d.how, d.text);
      const on: Lora = [{ id: 0, scale: 1 }];
      const off: Lora = [{ id: 0, scale: 0 }];
      await chat(s, msgs, 1, on);
      const rows: { step: string; wallMs: number; promptTokens: number; promptMs: number }[] = [];
      const one = async (step: string, lora: Lora) => {
        const t = await chat(s, msgs, 1, lora);
        rows.push({ step, wallMs: t.wallMs, promptTokens: t.promptTokens, promptMs: t.promptMs });
      };
      for (let r = 0; r < 5; r++) {
        await one('on, again', on);
        await one('off, switched', off);
        await one('off, again', off);
        await one('on, switched', on);
      }
      // The same through the server-wide setting (POST /lora-adapters), then a request without a lora field.
      const global: { postMs: number; wallMs: number; promptTokens: number }[] = [];
      for (let r = 0; r < 5; r++) {
        for (const scale of [0, 1]) {
          const p = await post(`${s.base}/lora-adapters`, [{ id: 0, scale }]);
          const t = await chat(s, msgs, 1, undefined);
          global.push({ postMs: p.ms, wallMs: t.wallMs, promptTokens: t.promptTokens });
        }
      }
      const by = (step: string) => rows.filter((x) => x.step === step);
      const summary = Object.fromEntries(['on, again', 'off, switched', 'off, again', 'on, switched'].map((k) => [k, { wallMs: median(by(k).map((x) => x.wallMs)), promptTokens: median(by(k).map((x) => x.promptTokens)) }]));
      // Does a switch leak the cached prompt? Each switched answer (the cache on, as llama-server defaults) against the
      // same request with the cache off, byte for byte: per request, then through POST /lora-adapters.
      const noCache = { cache_prompt: false };
      const leak: Record<string, { same: boolean; promptTokens: number; withCache: string; withoutCache: string }> = {};
      const pair = async (name: string, lora: Lora, before: () => Promise<unknown>) => {
        await before();
        const a = await chat(s, msgs, 60, lora);
        const b = await chat(s, msgs, 60, lora, noCache);
        leak[name] = { same: a.text === b.text, promptTokens: a.promptTokens, withCache: a.text, withoutCache: b.text };
      };
      await post(`${s.base}/lora-adapters`, [{ id: 0, scale: 0 }]);
      await pair('per request: off after on', off, () => chat(s, msgs, 60, on));
      await pair('per request: on after off', on, () => chat(s, msgs, 60, off));
      await pair('lora-adapters: off after on', undefined, async () => {
        await post(`${s.base}/lora-adapters`, [{ id: 0, scale: 1 }]);
        await chat(s, msgs, 60, undefined);
        await post(`${s.base}/lora-adapters`, [{ id: 0, scale: 0 }]);
      });
      await pair('lora-adapters: on after off', undefined, async () => {
        await chat(s, msgs, 60, undefined);
        await post(`${s.base}/lora-adapters`, [{ id: 0, scale: 1 }]);
      });
      await post(`${s.base}/lora-adapters`, [{ id: 0, scale: 0 }]);
      return { rows, summary, global: { postMs: median(global.map((x) => x.postMs)), wallMs: median(global.map((x) => x.wallMs)), promptTokens: median(global.map((x) => x.promptTokens)) }, leak };
    }),
  );
  say(`switch: ${JSON.stringify(results.switch.summary)}; through /lora-adapters ${JSON.stringify(results.switch.global)}`);
  for (const [k, v] of Object.entries(results.switch.leak as Record<string, { same: boolean; promptTokens: number }>)) say(`switch leak, ${k}: same as without the cache ${v.same}, prompt tokens read ${v.promptTokens}`);
}

// ------------------------------------------------------------------------------------------------ answers

async function nameAll(s: Server, lora: Lora): Promise<string[]> {
  const out: string[] = [];
  for (const d of DOCS) out.push((await chat(s, namePrompt(d.file, d.how, d.text), 60, lora)).text.trim());
  return out;
}

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

async function answersPhase(o: Options, results: any): Promise<void> {
  const files = o.loras.map((l) => l.file);
  const on = (i: number): Lora => o.loras.map((_, j) => ({ id: j, scale: j === i ? 1 : 0 }));
  const offAll: Lora = o.loras.map((_, j) => ({ id: j, scale: 0 }));
  const run = async (where: 'npu' | 'cpu') => {
    const h = where === 'npu' ? hexArgs(o, loraArgs(files)) : cpuArgs(o, loraArgs(files));
    const body = async () =>
      withServer(`answers-${where}`, h.exe, h.args, h.env, o, '/health', async (s) => {
        const r: Record<string, string[]> = { base: await nameAll(s, files.length ? offAll : undefined) };
        for (const [i, l] of o.loras.entries()) r[l.name] = await nameAll(s, on(i));
        return r;
      });
    return where === 'npu' ? inNpuTurn('add-on test: answers on the NPU', body) : body();
  };
  const npu = await run('npu');
  const cpu = await run('cpu');
  const compare = Object.fromEntries(
    Object.keys(npu).map((k) => {
      const same = npu[k].filter((a, i) => a === cpu[k][i]).length;
      const prefix = npu[k].map((a, i) => commonPrefix(a, cpu[k][i]) / Math.max(1, Math.max(a.length, cpu[k][i].length)));
      const changed = k === 'base' ? null : npu[k].filter((a, i) => a !== npu.base[i]).length;
      return [k, { sameAsProcessor: same, of: npu[k].length, meanSharedStart: prefix.reduce((x, y) => x + y, 0) / prefix.length, changedFromBaseOnNpu: changed, changedFromBaseOnCpu: k === 'base' ? null : cpu[k].filter((a, i) => a !== cpu.base[i]).length }];
    }),
  );
  results.answers = { docs: DOCS.map((d) => d.file), npu, cpu, compare };
  for (const [k, c] of Object.entries(compare)) say(`answers ${k}: ${JSON.stringify(c)}`);
}

// ------------------------------------------------------------------------------------------------ odds

const ODDS_TOP = 8;
type Odds = Record<string, number>;

/**
 * The model's own log-probabilities (before sampling) for the token after "NAME:" in the Warrener's answer, the first
 * one an add-on for naming would change: the chat template applied by the server, the answer's start given.
 */
async function nameOdds(s: Server, d: (typeof DOCS)[number], lora: Lora): Promise<Odds> {
  const t = await post(`${s.base}/apply-template`, { messages: namePrompt(d.file, d.how, d.text) });
  if (t.status !== 200) throw new Error(`${s.name}: apply-template ${t.status} ${t.text.slice(0, 200)}`);
  const r = await post(`${s.base}/completion`, { prompt: `${t.json.prompt}NAME:`, n_predict: 1, temperature: 0, top_k: 1, n_probs: ODDS_TOP, cache_prompt: false, ...(lora ? { lora } : {}) });
  if (r.status !== 200) throw new Error(`${s.name}: ${r.status} ${r.text.slice(0, 200)}`);
  const top: { token: string; logprob: number }[] = r.json.completion_probabilities?.[0]?.top_logprobs ?? [];
  return Object.fromEntries(top.map((x) => [x.token, x.logprob]));
}

/**
 * Does the NPU change the model's odds as the processor does, add-on by add-on? Each add-on in a server of its own, on
 * each device: every document off, on, then off again. `follows` is how much of the processor's change the NPU makes
 * (the least-squares slope of the NPU's change on the processor's, over the processor's top tokens: 1 is all of it);
 * `apart` the mean gap between their changes, against `baseApart`, the gap between the two without the add-on (the
 * NPU's own rounding); `offAgain` the largest move of an odds between off before and off after an on (0: an add-on
 * switched off leaves nothing behind).
 */
async function oddsPhase(o: Options, results: any): Promise<void> {
  results.odds = { hexEnv: o.hexEnv, loras: {} };
  for (const l of o.loras) {
    const run = async (where: 'npu' | 'cpu') => {
      const h = where === 'npu' ? hexArgs(o, loraArgs([l.file])) : cpuArgs(o, loraArgs([l.file]));
      const body = () =>
        withServer(`odds-${l.name}-${where}`, h.exe, h.args, h.env, o, '/health', async (s) => {
          const rows: { off: Odds; on: Odds; offAgain: Odds }[] = [];
          for (const d of DOCS) {
            const off = await nameOdds(s, d, [{ id: 0, scale: 0 }]);
            const on = await nameOdds(s, d, [{ id: 0, scale: 1 }]);
            rows.push({ off, on, offAgain: await nameOdds(s, d, [{ id: 0, scale: 0 }]) });
          }
          return rows;
        });
      return where === 'npu' ? inNpuTurn(`add-on test: odds, ${l.name}`, body) : body();
    };
    let npu: Awaited<ReturnType<typeof run>>;
    try {
      npu = await run('npu');
    } catch (e) {
      results.odds.loras[l.name] = { error: String(e) };
      say(`odds ${l.name}: ${String(e)}`);
      continue;
    }
    const cpu = await run('cpu');
    let sxy = 0;
    let sxx = 0;
    const apart: number[] = [];
    const baseApart: number[] = [];
    let offAgain = 0;
    for (const [i, c] of cpu.entries()) {
      const n = npu[i];
      for (const tok of Object.keys(c.off)) {
        if (!(tok in c.on) || !(tok in n.off) || !(tok in n.on)) continue;
        const dc = c.on[tok] - c.off[tok];
        const dn = n.on[tok] - n.off[tok];
        sxy += dn * dc;
        sxx += dc * dc;
        apart.push(Math.abs(dn - dc));
        baseApart.push(Math.abs(n.off[tok] - c.off[tok]));
      }
      for (const tok of Object.keys(n.off)) offAgain = Math.max(offAgain, Math.abs((n.offAgain[tok] ?? -99) - n.off[tok]));
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const meanChange = mean(cpu.flatMap((c) => Object.keys(c.off).filter((t) => t in c.on).map((t) => Math.abs(c.on[t] - c.off[t]))));
    const summary = { follows: sxx > 0 ? sxy / sxx : null, apart: mean(apart), baseApart: mean(baseApart), processorChange: meanChange, offAgain, tokens: apart.length };
    results.odds.loras[l.name] = { summary, npu, cpu };
    say(`odds ${l.name}${Object.keys(o.hexEnv).length ? ` (${JSON.stringify(o.hexEnv)})` : ''}: ${JSON.stringify(summary)}`);
  }
}

// ------------------------------------------------------------------------------------------------ GenieX against llama-server

async function qualityAndPictures(base: string, model: string | undefined, pictureAsPath: boolean, nonce: boolean, dir: string): Promise<{ quality: { id: string; pass: boolean; mustPass: boolean; answer: string }[]; pictures: { id: string; pass: boolean; ms: number; answer: string }[] }> {
  const quality: { id: string; pass: boolean; mustPass: boolean; answer: string }[] = [];
  for (const q of SUITE.quality) {
    const sys = nonce ? [{ role: 'system', content: `${Math.random().toString(36).slice(2, 10)}` }] : [];
    const r = await post(`${base}/v1/chat/completions`, { ...(model ? { model } : {}), messages: [...sys, { role: 'user', content: promptOf(SUITE, q) }], max_tokens: q.maxTokens, temperature: 0, stream: false });
    const answer = r.json?.choices?.[0]?.message?.content ?? `(${r.status}) ${r.text.slice(0, 200)}`;
    quality.push({ id: q.id, pass: grade(q.grade, answer), mustPass: !!q.mustPass, answer: answer.slice(0, 200) });
  }
  const pictures: { id: string; pass: boolean; ms: number; answer: string }[] = [];
  for (const v of SUITE.vision) {
    const png = picturePng(v.image);
    const file = path.join(dir, `${v.id}.png`);
    writeFileSync(file, png);
    const url = pictureAsPath ? file.replace(/\\/g, '/') : `data:image/png;base64,${png.toString('base64')}`;
    const system = `${nonce ? `${Math.random().toString(36).slice(2, 10)} ` : ''}You answer questions about images briefly and literally.`;
    const r = await post(`${base}/v1/chat/completions`, { ...(model ? { model } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: v.prompt }] }], max_tokens: v.maxTokens, temperature: 0, stream: false });
    const answer = r.json?.choices?.[0]?.message?.content ?? `(${r.status}) ${r.text.slice(0, 200)}`;
    pictures.push({ id: v.id, pass: grade(v.grade, answer), ms: r.ms, answer: answer.slice(0, 120) });
  }
  return { quality, pictures };
}

async function routeSpeed(base: string, model: string | undefined, nonce: boolean, runs: number, extra: Record<string, unknown> = {}): Promise<{ readTps: number; genTps: number; nameWallMs: number; nameFirstTokenMs: number; raw: string[] }> {
  const reads: number[] = [];
  const gens: number[] = [];
  const walls: number[] = [];
  const firsts: number[] = [];
  let raw: string[] = [];
  for (let r = 0; r < runs; r++) {
    const tag = `${Date.now().toString(36)}-${r}`;
    const sys = (content: string) => ({ role: 'system', content: nonce ? `${tag} ${content}` : content });
    const read = await streamed(base, { ...(model ? { model } : {}), messages: [sys('You count lines.'), { role: 'user', content: readPromptOf(1500, tag) }], max_tokens: 8, temperature: 0, ...extra });
    reads.push(tps(read.promptTokens, read.firstTokenMs ?? read.wallMs));
    const gen = await streamed(base, { ...(model ? { model } : {}), messages: [sys('You write stories.'), { role: 'user', content: `[${tag}] Write a long story, at least 400 words, about a steward who keeps a manor's cellar.` }], max_tokens: 128, temperature: 0, ...extra });
    gens.push(tps(Math.max(0, gen.genTokens - 1), gen.genMs));
    raw = gen.raw;
    for (const d of DOCS.slice(0, 3)) {
      const msgs = namePrompt(d.file, d.how, d.text);
      msgs[0].content = `${tag} ${msgs[0].content}`;
      const t = await streamed(base, { ...(model ? { model } : {}), messages: msgs, max_tokens: 60, temperature: 0, ...extra });
      walls.push(t.wallMs);
      firsts.push(t.firstTokenMs ?? t.wallMs);
    }
  }
  return { readTps: median(reads), genTps: median(gens), nameWallMs: median(walls), nameFirstTokenMs: median(firsts), raw };
}

async function geniexPhase(o: Options, results: any): Promise<void> {
  const dir = path.join(o.out, 'pictures');
  mkdirSync(dir, { recursive: true });
  results.routes = {};
  // llama-server on the Hexagon, no add-on, with the projector: chat and pictures on one server, as GenieX serves both.
  if (o.mmproj) {
    const h = hexArgs(o, ['--mmproj', o.mmproj, '--image-max-tokens', '1024']);
    results.routes.llamaServer = await inNpuTurn('add-on test: llama-server route', () =>
      withServer('route-llama-server', h.exe, h.args, h.env, o, '/health', async (s) => {
        await complete(s, 'Hello', 4, undefined);
        const loaded = memoryOf(s.pid);
        const sp = await routeSpeed(s.base, undefined, false, o.runs);
        const afterChat = memoryOf(s.pid);
        const qp = await qualityAndPictures(s.base, undefined, false, false, dir);
        const afterPictures = memoryOf(s.pid);
        return { readyMs: s.readyMs, ...sp, ...qp, memory: { loaded, afterChat, afterPictures } };
      }),
    );
    const r = results.routes.llamaServer;
    say(`llama-server route: reads ${r.readTps.toFixed(0)} t/s, writes ${r.genTps.toFixed(1)} t/s, name ${r.nameWallMs.toFixed(0)} ms; quality ${r.quality.filter((x: any) => x.pass).length}/${r.quality.length}, pictures ${r.pictures.filter((x: any) => x.pass).length}/${r.pictures.length}; NPU ${r.memory.afterPictures.npuMb?.toFixed(0)} MB, WS ${r.memory.afterPictures.workingSetMb.toFixed(0)} MB`);
  }
  if (o.geniex) {
    const model = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
    const args = ['serve', '--skip-update', '--host', `127.0.0.1:${o.port}`, '--keepalive', '3600', '--compute', 'npu', '--nctx', String(o.ctx)];
    const env = { GENIEX_CLOCK_KEEPER_THREADS: '0', GENIEX_IMAGE_MAX_TOKENS: '1024' };
    results.routes.geniex = await inNpuTurn('add-on test: geniex route', () =>
      withServer('route-geniex', o.geniex!, args, env, o, '/v1/models', async (s) => {
        // GenieX loads its model with the first request.
        const t0 = performance.now();
        const first = await post(`${s.base}/v1/chat/completions`, { model, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 4, temperature: 0 });
        const firstAnswerMs = performance.now() - t0 + s.readyMs;
        const loaded = memoryOf(s.pid);
        // Does it take a per-request add-on? Same question with lora fields of llama-server's form (and others'), compared.
        const probeMsgs = [{ role: 'system', content: 'k3q9' }, { role: 'user', content: 'Name three colours.' }];
        const plain = await post(`${s.base}/v1/chat/completions`, { model, messages: probeMsgs, max_tokens: 16, temperature: 0 });
        const probes: Record<string, { status: number; same: boolean; text: string }> = {};
        for (const [k, extra] of Object.entries({ lora: { lora: [{ id: 0, scale: 1 }] }, lora_path: { lora: [{ path: 'C:/none.gguf', scale: 1 }] }, adapter: { adapter: 'none' }, lora_adapters: { lora_adapters: [{ id: 0, scale: 1 }] } })) {
          const r = await post(`${s.base}/v1/chat/completions`, { model, messages: probeMsgs, max_tokens: 16, temperature: 0, ...extra });
          probes[k] = { status: r.status, same: r.json?.choices?.[0]?.message?.content === plain.json?.choices?.[0]?.message?.content, text: (r.json?.choices?.[0]?.message?.content ?? r.text).slice(0, 160) };
        }
        const loraEndpoint = await post(`${s.base}/lora-adapters`, [{ id: 0, scale: 1 }]);
        const getLora = await answers(`${s.base}/lora-adapters`);
        const sp = await routeSpeed(s.base, model, true, o.runs);
        const afterChat = memoryOf(s.pid);
        const qp = await qualityAndPictures(s.base, model, true, true, dir);
        const afterPictures = memoryOf(s.pid);
        return { readyMs: s.readyMs, firstAnswerMs, firstStatus: first.status, probes, loraEndpoint: { post: loraEndpoint.status, get: getLora }, ...sp, ...qp, memory: { loaded, afterChat, afterPictures } };
      }),
    );
    const r = results.routes.geniex;
    say(`geniex route: reads ${r.readTps.toFixed(0)} t/s, writes ${r.genTps.toFixed(1)} t/s, name ${r.nameWallMs.toFixed(0)} ms; quality ${r.quality.filter((x: any) => x.pass).length}/${r.quality.length}, pictures ${r.pictures.filter((x: any) => x.pass).length}/${r.pictures.length}; NPU ${r.memory.afterPictures.npuMb?.toFixed(0)} MB, WS ${r.memory.afterPictures.workingSetMb.toFixed(0)} MB; lora probes ${JSON.stringify(r.probes)}`);
  }
}

// ------------------------------------------------------------------------------------------------ memory

const mb = (m: Memory) => ({ workingSetMb: Math.round(m.workingSetMb), privateMb: Math.round(m.privateMb), npuMb: m.npuMb === null ? null : Math.round(m.npuMb), availableMb: Math.round(m.availableMb) });

/** Its working set handed back to Windows, as the kit does a server's (working-set.ts), and how long that took. */
async function trimmed(pid: number): Promise<{ said: string | null; ms: number; after: ReturnType<typeof mb> }> {
  const t0 = performance.now();
  const said = await trimWorkingSet(pid);
  const ms = performance.now() - t0;
  return { said, ms: Math.round(ms), after: mb(memoryOf(pid)) };
}

/** The 4 pictures alone: pass and time, for the before and after of a trim. */
async function picturesOnly(base: string, dir: string): Promise<{ pass: number; ms: number[] }> {
  const ms: number[] = [];
  let pass = 0;
  for (const v of SUITE.vision) {
    const png = picturePng(v.image);
    writeFileSync(path.join(dir, `${v.id}.png`), png);
    const r = await post(`${base}/v1/chat/completions`, { messages: [{ role: 'system', content: 'You answer questions about images briefly and literally.' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }, { type: 'text', text: v.prompt }] }], max_tokens: v.maxTokens, temperature: 0, stream: false });
    ms.push(Math.round(r.ms));
    if (grade(v.grade, r.json?.choices?.[0]?.message?.content ?? '')) pass++;
  }
  return { pass, ms };
}

/** The Warrener's names with the first add-on on: their time and text. */
async function namesWithAddon(s: Server): Promise<{ medianMs: number; texts: string[] }> {
  const ms: number[] = [];
  const texts: string[] = [];
  for (const d of DOCS) {
    const t = await chat(s, namePrompt(d.file, d.how, d.text), 60, [{ id: 0, scale: 1 }]);
    ms.push(t.wallMs);
    texts.push(t.text);
  }
  return { medianMs: Math.round(median(ms)), texts };
}

async function memoryPhase(o: Options, results: any): Promise<void> {
  if (!o.mmproj) throw new Error('the memory phase needs --mmproj');
  const dir = path.join(o.out, 'pictures');
  mkdirSync(dir, { recursive: true });
  results.memory = {};
  for (const p of [{ name: 'f16', file: o.mmproj }, ...o.mmprojAlts]) {
    const h = hexArgs(o, ['--mmproj', p.file, '--image-max-tokens', '1024', ...loraArgs(o.loras.map((l) => l.file))]);
    const r = await inNpuTurn(`add-on test: memory, projector ${p.name}`, () =>
      withServer(`memory-${p.name}`, h.exe, h.args, h.env, o, '/health', async (s) => {
        await complete(s, 'Hello', 4, undefined);
        const loaded = mb(memoryOf(s.pid));
        const loadedTrim = await trimmed(s.pid);
        const speed = await routeSpeed(s.base, undefined, false, o.runs);
        const afterChat = mb(memoryOf(s.pid));
        const afterChatTrim = await trimmed(s.pid);
        const speedAfterTrim = await routeSpeed(s.base, undefined, false, o.runs);
        const afterChatAgain = mb(memoryOf(s.pid));
        const addon = o.loras.length ? await namesWithAddon(s) : null;
        const afterAddon = mb(memoryOf(s.pid));
        const qp = await qualityAndPictures(s.base, undefined, false, false, dir);
        const afterPictures = mb(memoryOf(s.pid));
        const afterPicturesTrim = await trimmed(s.pid);
        const picturesAfterTrim = await picturesOnly(s.base, dir);
        const afterPicturesAgain = mb(memoryOf(s.pid));
        const chatAfterPictures = await routeSpeed(s.base, undefined, false, 1);
        const afterPicturesChat = mb(memoryOf(s.pid));
        return {
          projector: path.basename(p.file),
          readyMs: s.readyMs,
          speed: { readTps: Math.round(speed.readTps), genTps: +speed.genTps.toFixed(1), nameMs: Math.round(speed.nameWallMs) },
          speedAfterTrim: { readTps: Math.round(speedAfterTrim.readTps), genTps: +speedAfterTrim.genTps.toFixed(1), nameMs: Math.round(speedAfterTrim.nameWallMs) },
          speedAfterPictures: { readTps: Math.round(chatAfterPictures.readTps), genTps: +chatAfterPictures.genTps.toFixed(1), nameMs: Math.round(chatAfterPictures.nameWallMs) },
          addon,
          quality: qp.quality.filter((x) => x.pass).length,
          qualityMisses: qp.quality.filter((x) => !x.pass).map((x) => x.id),
          pictures: qp.pictures.filter((x) => x.pass).length,
          picturesMs: qp.pictures.map((x) => Math.round(x.ms)),
          picturesAnswers: qp.pictures.map((x) => x.answer),
          picturesAfterTrim,
          memory: { loaded, loadedTrim, afterChat, afterChatTrim, afterChatAgain, afterAddon, afterPictures, afterPicturesTrim, afterPicturesAgain, afterPicturesChat },
        };
      }),
    );
    results.memory[p.name] = r;
    const m = r.memory;
    say(`memory ${p.name}: ready ${r.readyMs} ms; WS loaded ${m.loaded.workingSetMb} -> trimmed ${m.loadedTrim.after.workingSetMb}; after chat ${m.afterChat.workingSetMb} -> trimmed ${m.afterChatTrim.after.workingSetMb} -> chat again ${m.afterChatAgain.workingSetMb}; with the add-on ${m.afterAddon.workingSetMb}; after pictures ${m.afterPictures.workingSetMb} -> trimmed ${m.afterPicturesTrim.after.workingSetMb} -> pictures again ${m.afterPicturesAgain.workingSetMb} -> chat ${m.afterPicturesChat.workingSetMb}; private ${m.afterPictures.privateMb}; NPU ${m.afterChat.npuMb}/${m.afterPictures.npuMb} MB; speed ${JSON.stringify(r.speed)} after trim ${JSON.stringify(r.speedAfterTrim)}; quality ${r.quality}/24, pictures ${r.pictures}/4 (${r.picturesAfterTrim.pass}/4 after trim, ${r.picturesAfterTrim.ms.join('/')} ms against ${r.picturesMs.join('/')})`);
  }
}

// ------------------------------------------------------------------------------------------------ leak

type Ask = { key: string; messages: { role: string; content: string }[]; maxTokens: number; lora: Lora };

/** Each ask in turn with the prompt cache as `cache` says, the text of each answer by its key. */
async function askAll(s: Server, asks: Ask[], cache: boolean): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const a of asks) out[a.key] = (await chat(s, a.messages, a.maxTokens, a.lora, { cache_prompt: cache })).text;
  return out;
}

async function leakPhase(o: Options, results: any): Promise<void> {
  const asks: Ask[] = [];
  for (const d of DOCS) asks.push({ key: `name:${d.file}`, messages: namePrompt(d.file, d.how, d.text), maxTokens: 60, lora: undefined });
  // The same document asked one more thing: it shares the whole document with the name's request, the strongest case.
  for (const d of DOCS.slice(0, 4)) {
    const base = namePrompt(d.file, d.how, d.text);
    asks.push({ key: `again:${d.file}`, messages: [base[0], { role: 'user', content: `${base[1].content}\nThen say in one line who it is from.` }], maxTokens: 80, lora: undefined });
  }
  for (const q of SUITE.quality) asks.push({ key: `quality:${q.id}`, messages: [{ role: 'user', content: promptOf(SUITE, q) }], maxTokens: q.maxTokens, lora: undefined });
  if (o.loras.length) for (const d of DOCS) asks.push({ key: `addon:${d.file}`, messages: namePrompt(d.file, d.how, d.text), maxTokens: 60, lora: [{ id: 0, scale: 1 }] });
  const h = hexArgs(o, [...(o.mmproj ? ['--mmproj', o.mmproj, '--image-max-tokens', '1024'] : []), ...loraArgs(o.loras.map((l) => l.file))]);
  const r = await inNpuTurn('add-on test: prefix leak', () =>
    withServer('leak', h.exe, h.args, h.env, o, '/health', async (s) => {
      await complete(s, 'Hello', 4, undefined);
      const alone = await askAll(s, asks, false);
      const inRow = await askAll(s, asks, true);
      const reversed = await askAll(s, [...asks].reverse(), true);
      const twice = await askAll(s, asks, true);
      const aloneAgain = await askAll(s, asks, false);
      return { alone, inRow, reversed, twice, aloneAgain };
    }),
  );
  const differ = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((k) => a[k] !== b[k]);
  results.leak = {
    asks: asks.length,
    aloneVsAloneAgain: differ(r.alone, r.aloneAgain),
    inRowVsAlone: differ(r.inRow, r.alone),
    reversedVsAlone: differ(r.reversed, r.alone),
    twiceVsAlone: differ(r.twice, r.alone),
    examples: [...new Set([...differ(r.inRow, r.alone), ...differ(r.reversed, r.alone)])].slice(0, 8).map((k) => ({ key: k, alone: r.alone[k], inRow: r.inRow[k], reversed: r.reversed[k] })),
    raw: r,
  };
  const l = results.leak;
  say(`leak: ${l.asks} asks; alone vs alone again ${l.aloneVsAloneAgain.length} differ; in a row (cache on) vs alone ${l.inRowVsAlone.length}; reversed ${l.reversedVsAlone.length}; twice ${l.twiceVsAlone.length}${l.inRowVsAlone.length ? `: ${l.inRowVsAlone.join(', ')}` : ''}`);
}

// ------------------------------------------------------------------------------------------------ cpu

/** Processor time `pid` used while `fn` ran, as cores busy (its seconds over the wall's). */
async function coresBusy<T>(pid: number, fn: () => Promise<T>): Promise<{ result: T; cores: number; wallMs: number }> {
  const c0 = memoryOf(pid).cpuSeconds;
  const t0 = performance.now();
  const result = await fn();
  const wallMs = performance.now() - t0;
  return { result, cores: +((memoryOf(pid).cpuSeconds - c0) / (wallMs / 1000)).toFixed(2), wallMs: Math.round(wallMs) };
}

/** The chat server as the kit would run it, with each set of processor arguments: its speed and the processor it keeps busy. */
async function cpuPhase(o: Options, results: any): Promise<void> {
  const variants: { name: string; args: string[] }[] = [
    { name: 'default', args: [] },
    { name: 't8', args: ['-t', '8', '-tb', '8'] },
    { name: 't4-poll0', args: ['-t', '4', '-tb', '4', '--poll', '0'] },
    { name: 't2-poll0', args: ['-t', '2', '-tb', '2', '--poll', '0'] },
    { name: 't1-poll0', args: ['-t', '1', '-tb', '1', '--poll', '0'] },
  ];
  results.cpu = {};
  for (const v of variants) {
    const h = hexArgs(o, [...(o.mmproj ? ['--mmproj', o.mmproj, '--image-max-tokens', '1024'] : []), ...loraArgs(o.loras.map((l) => l.file))]);
    // hexArgs sets -t/-tb to --threads: the variant's own in their place, or none for llama-server's default.
    const args = h.args.filter((a, i, all) => !(a === '-t' || a === '-tb' || all[i - 1] === '-t' || all[i - 1] === '-tb'));
    let exitCode: number | null = null;
    const r = await inNpuTurn(`add-on test: processor, ${v.name}`, () =>
      withServer(`cpu-${v.name}`, h.exe, [...args, ...v.args], h.env, o, '/health', async (s) => {
        s.child.once('exit', (code) => (exitCode = code));
        await complete(s, 'Hello', 4, undefined);
        const idle = await coresBusy(s.pid, async () => {
          // An idle stretch, timed: what the server's threads use with nothing asked.
          const end = Date.now() + 10_000;
          while (Date.now() < end) await sleep(500);
        });
        const write = await coresBusy(s.pid, () => complete(s, 'Once upon a time', 256, undefined));
        const read = await coresBusy(s.pid, () => complete(s, readPromptOf(1500, `cpu-${v.name}`), 1, undefined));
        const names = await coresBusy(s.pid, async () => {
          const ms: number[] = [];
          for (const d of DOCS) ms.push((await chat(s, namePrompt(d.file, d.how, d.text), 60, undefined, { cache_prompt: false })).wallMs);
          return median(ms);
        });
        const addon = o.loras.length ? await coresBusy(s.pid, () => namesWithAddon(s)) : null;
        return {
          idleCores: idle.cores,
          writeTps: +tps(write.result.genTokens, write.result.genMs).toFixed(1),
          writeCores: write.cores,
          readTps: Math.round(tps(read.result.promptTokens, read.result.promptMs)),
          readCores: read.cores,
          nameMs: Math.round(names.result),
          namesCores: names.cores,
          ...(addon ? { addonNameMs: addon.result.medianMs, addonCores: addon.cores } : {}),
        };
      }),
    ).catch((e: Error) => {
      // A server that died mid-test: what it was doing, as its log's last lines say, and its exit code.
      const log = readFileSync(path.join(o.out, `cpu-${v.name}.log`), 'utf8').trim().split(/\r?\n/).slice(-4);
      return { crashed: e.message, exitCode, log };
    });
    results.cpu[v.name] = r;
    if ('crashed' in r) {
      say(`cpu ${v.name}: the server died (${r.crashed}; exit ${r.exitCode}): ${r.log.join(' / ').slice(0, 400)}`);
      continue;
    }
    say(`cpu ${v.name}: idle ${r.idleCores} cores; writes ${r.writeTps} t/s at ${r.writeCores} cores; reads ${r.readTps} t/s at ${r.readCores}; a name ${r.nameMs} ms at ${r.namesCores}${r.addonNameMs ? `; with the add-on ${r.addonNameMs} ms at ${r.addonCores}` : ''}`);
  }
}

// ------------------------------------------------------------------------------------------------ defaults

/**
 * What a request without a `lora` field gets on a server that loaded add-ons with --lora-init-without-apply: the add-ons
 * off (as an explicit scale 0 gives), or on at their file's scale. Its answers and speed against an explicit 0, an
 * explicit 1, and a server with no add-on.
 */
async function defaultsPhase(o: Options, results: any): Promise<void> {
  if (!o.loras.length) throw new Error('the defaults phase needs --lora');
  const run = async (s: Server, lora: Lora) => {
    const texts: string[] = [];
    for (const d of DOCS) texts.push((await chat(s, namePrompt(d.file, d.how, d.text), 60, lora, { cache_prompt: false })).text);
    const w = await complete(s, 'Once upon a time', 128, lora);
    return { texts, writeTps: +tps(w.genTokens, w.genMs).toFixed(1) };
  };
  const zeros = o.loras.map((_, id) => ({ id, scale: 0 }));
  const h = hexArgs(o, loraArgs(o.loras.map((l) => l.file)));
  const withAddons = await inNpuTurn('add-on test: lora defaults', () =>
    withServer('defaults-addons', h.exe, h.args, h.env, o, '/health', async (s) => {
      await complete(s, 'Hello', 4, zeros);
      const listed = await (await fetch(`${s.base}/lora-adapters`)).json();
      const none = await run(s, undefined);
      const off = await run(s, zeros);
      const on = await run(s, [{ id: 0, scale: 1 }, ...zeros.slice(1)]);
      const noneAgain = await run(s, undefined);
      return { listed, none, off, on, noneAgain };
    }),
  );
  const b = hexArgs(o);
  const base = await inNpuTurn('add-on test: lora defaults, base', () =>
    withServer('defaults-base', b.exe, b.args, b.env, o, '/health', async (s) => {
      await complete(s, 'Hello', 4, undefined);
      return run(s, undefined);
    }),
  );
  const same = (a: string[], c: string[]) => a.filter((t, i) => t === c[i]).length;
  results.defaults = {
    listed: withAddons.listed,
    writeTps: { base: base.writeTps, none: withAddons.none.writeTps, off: withAddons.off.writeTps, on: withAddons.on.writeTps },
    sameAsBase: { none: same(withAddons.none.texts, base.texts), off: same(withAddons.off.texts, base.texts), on: same(withAddons.on.texts, base.texts), noneAgain: same(withAddons.noneAgain.texts, base.texts) },
    sameAsOn: { none: same(withAddons.none.texts, withAddons.on.texts) },
    texts: { base: base.texts, none: withAddons.none.texts, off: withAddons.off.texts, on: withAddons.on.texts },
  };
  const r = results.defaults;
  say(`defaults: /lora-adapters ${JSON.stringify(r.listed)}; writes base ${r.writeTps.base}, no field ${r.writeTps.none}, scale 0 ${r.writeTps.off}, scale 1 ${r.writeTps.on} t/s; names like the base's (of ${DOCS.length}): no field ${r.sameAsBase.none}, scale 0 ${r.sameAsBase.off}, scale 1 ${r.sameAsBase.on}; no field like scale 1: ${r.sameAsOn.none}`);
}

// ------------------------------------------------------------------------------------------------ footprint

/** The PC's available memory, the median of five looks a quarter-second apart (the manor's own work moves it). */
async function availableNow(): Promise<number> {
  const looks: number[] = [];
  for (let i = 0; i < 5; i++) {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[int64](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024'], { encoding: 'utf8' });
    looks.push(Number(out.trim()) / 2 ** 20);
    await sleep(250);
  }
  return Math.round(median(looks));
}

/**
 * What each chat server costs the PC, by the PC's available memory (a second reading beside the process's own
 * counters): before it starts, once it answered, after a chat, after the trim, after pictures and a trim, and once it
 * stopped. llama-server with each projector and the add-on loaded, then GenieX as the kit runs it.
 */
async function footprintPhase(o: Options, results: any): Promise<void> {
  const dir = path.join(o.out, 'pictures');
  mkdirSync(dir, { recursive: true });
  results.footprint = {};
  const zeros = o.loras.map((_, id) => ({ id, scale: 0 }));
  const chatOnce = async (base: string, model?: string) => {
    for (const d of DOCS.slice(0, 3)) await post(`${base}/v1/chat/completions`, { ...(model ? { model } : {}), messages: namePrompt(d.file, d.how, d.text), max_tokens: 60, temperature: 0, ...(model ? {} : { lora: zeros }) });
  };
  const runs: { name: string; start: () => { exe: string; args: string[]; env: Record<string, string>; ready: string; model?: string } }[] = [];
  for (const p of [{ name: 'f16', file: o.mmproj }, ...o.mmprojAlts]) {
    if (!p.file) continue;
    runs.push({ name: `llama-server-${p.name}`, start: () => ({ ...hexArgs(o, ['--mmproj', p.file!, '--image-max-tokens', '1024', ...loraArgs(o.loras.map((l) => l.file))]), ready: '/health' }) });
  }
  if (o.geniex) {
    const model = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
    runs.push({ name: 'geniex', start: () => ({ exe: o.geniex!, args: ['serve', '--skip-update', '--host', `127.0.0.1:${o.port}`, '--keepalive', '3600', '--compute', 'npu', '--nctx', String(o.ctx)], env: { GENIEX_CLOCK_KEEPER_THREADS: '0', GENIEX_IMAGE_MAX_TOKENS: '1024' }, ready: '/v1/models', model }) });
  }
  for (const r of runs) {
    const st = r.start();
    const out = await inNpuTurn(`add-on test: footprint, ${r.name}`, async () => {
      const before = await availableNow();
      const inside = await withServer(`footprint-${r.name}`, st.exe, st.args, st.env, o, st.ready, async (s) => {
        await chatOnce(s.base, st.model);
        const chatted = { available: await availableNow(), ...mb(memoryOf(s.pid)) };
        const trim = st.model ? null : await trimmed(s.pid);
        const chattedTrimmed = trim ? { available: await availableNow(), ...trim.after } : null;
        await qualityAndPictures(s.base, st.model, !!st.model, !!st.model, dir);
        const pictured = { available: await availableNow(), ...mb(memoryOf(s.pid)) };
        const trim2 = st.model ? null : await trimmed(s.pid);
        const picturedTrimmed = trim2 ? { available: await availableNow(), ...trim2.after } : null;
        return { chatted, chattedTrimmed, pictured, picturedTrimmed };
      });
      const after = await availableNow();
      return { before, ...inside, after };
    });
    results.footprint[r.name] = out;
    const cost = (x: { available: number } | null) => (x ? out.before - x.available : null);
    say(`footprint ${r.name}: available ${out.before} MB before; costs after chat ${cost(out.chatted)} MB (WS ${out.chatted.workingSetMb}, NPU ${out.chatted.npuMb}), trimmed ${cost(out.chattedTrimmed)}; after pictures ${cost(out.pictured)} (WS ${out.pictured.workingSetMb}, NPU ${out.pictured.npuMb}), trimmed ${cost(out.picturedTrimmed)}; ${out.before - out.after} MB once stopped`);
  }
}

// ------------------------------------------------------------------------------------------------ kit

/**
 * The route as this kit runs it: the X2's chatServer command from the kit's own routeFor and npuEntry, its program and
 * libraries swapped for --hex's (the same build with the same GenieX libraries over it, as setup lays them out) and its
 * port for --port, with --lora's add-ons loaded. Every request is the kit's own body, so the add-ons it doesn't apply
 * go at 0, and no nonce (its quirks are none).
 */
async function kitPhase(o: Options, results: any): Promise<void> {
  const dir = path.join(o.out, 'pictures');
  mkdirSync(dir, { recursive: true });
  const route = routeFor(pinnedRoute(NPU_CATALOG.routes.qualcomm, 'snapdragon-x2'), 'snapdragon-x2');
  if (!route.chatServer) throw new Error("this kit's X2 route has no chatServer");
  const tools = path.join(os.tmpdir(), 'addon-test-tools');
  const e = npuEntry(route, { tools, exe: 'geniex.exe', port: o.port, addons: o.loras.map((l) => l.file) });
  const cmd = [...e.chat!.startCommand!];
  const own = path.join(tools, 'servers', 'llama.cpp', 'b11645-hexagon');
  if (path.dirname(cmd[0]) !== own) throw new Error(`the kit's chat server isn't the embedding server's build: ${cmd[0]}`);
  cmd[0] = path.join(o.hex, 'llama-server.exe');
  const env = Object.fromEntries(Object.entries(e.chat!.env ?? {}).map(([k, v]) => [k, v === own ? o.hex : v]));
  const acc = { id: 'npu', kind: 'npu', quirks: e.quirks ?? [], vision: e.vision } as any;
  const ep = { baseUrl: `http://127.0.0.1:${o.port}`, model: e.chat!.model, startCommand: cmd } as any;
  const zeros = (chatBody(acc, ep, [{ role: 'user', content: 'Hi' }], 1) as any).lora ?? [];
  const r = await inNpuTurn('add-on test: the kit route', async () => {
    const before = await availableNow();
    const inside = await withServer('kit-route', cmd[0], cmd.slice(1), env, o, '/health', async (s) => {
      const url = `${s.base}/v1/chat/completions`;
      // The kit's warm-up, then its trim once loaded (accelerators.ts' trimmedOnceLoaded).
      await post(url, chatBody(acc, ep, [{ role: 'user', content: 'Hi' }], 1));
      const loaded = mb(memoryOf(s.pid));
      const trim = await trimmed(s.pid);
      const speed = await routeSpeed(s.base, undefined, false, o.runs, { lora: zeros });
      const chatted = { available: await availableNow(), ...mb(memoryOf(s.pid)) };
      const quality: { id: string; pass: boolean; mustPass: boolean; ms: number; answer: string }[] = [];
      for (const q of SUITE.quality) {
        const a = await post(url, chatBody(acc, ep, [{ role: 'user', content: promptOf(SUITE, q) }], q.maxTokens));
        const answer = a.json?.choices?.[0]?.message?.content ?? `(${a.status}) ${a.text.slice(0, 200)}`;
        quality.push({ id: q.id, pass: grade(q.grade, answer), mustPass: !!q.mustPass, ms: Math.round(a.ms), answer: answer.slice(0, 200) });
      }
      const pictures: { id: string; pass: boolean; ms: number; answer: string }[] = [];
      for (const v of SUITE.vision) {
        const file = path.join(dir, `${v.id}.png`);
        writeFileSync(file, picturePng(v.image));
        const a = await post(url, visionBody(acc, ep, await fitPicture(acc, file), v.prompt, v.maxTokens));
        const answer = a.json?.choices?.[0]?.message?.content ?? `(${a.status}) ${a.text.slice(0, 200)}`;
        pictures.push({ id: v.id, pass: grade(v.grade, answer), ms: Math.round(a.ms), answer: answer.slice(0, 120) });
      }
      const pictured = { available: await availableNow(), ...mb(memoryOf(s.pid)) };
      // The Warrener's names with its add-on applied, as the kit applies it for its job.
      const job = addonFor('warrener.name', { startCommand: cmd, onNpu: true, pcHasNpu: true });
      const names: { ms: number; text: string }[] = [];
      if (job?.lora) {
        for (const d of DOCS) {
          const a = await post(url, { ...chatBody(acc, ep, namePrompt(d.file, d.how, d.text) as any, 60), lora: job.lora });
          names.push({ ms: Math.round(a.ms), text: a.json?.choices?.[0]?.message?.content ?? '' });
        }
      }
      const speedOn = job?.lora ? await routeSpeed(s.base, undefined, false, o.runs, { lora: job.lora }) : null;
      return { readyMs: s.readyMs, command: cmd, env, loaded, trim, speed, speedOn, chatted, quality, pictures, pictured, addon: job?.use ?? null, names };
    });
    return { before, ...inside, after: await availableNow() };
  });
  results.kit = r;
  const sp = (x: { readTps: number; genTps: number; nameWallMs: number } | null) => (x ? `reads ${x.readTps.toFixed(0)} t/s, writes ${x.genTps.toFixed(1)} t/s, a name ${x.nameWallMs.toFixed(0)} ms` : 'not run');
  say(`kit route: ready ${r.readyMs} ms; ${sp(r.speed)}; with the add-on ${sp(r.speedOn)}; quality ${r.quality.filter((x) => x.pass).length}/${r.quality.length} (wrong: ${r.quality.filter((x) => !x.pass).map((x) => x.id).join(', ') || 'none'}), pictures ${r.pictures.filter((x) => x.pass).length}/${r.pictures.length} (${r.pictures.map((x) => x.ms).join('/')} ms)`);
  say(`kit route memory: WS loaded ${r.loaded.workingSetMb} -> trimmed ${r.trim.after.workingSetMb}; after chat WS ${r.chatted.workingSetMb}, NPU ${r.chatted.npuMb}, ${r.before - r.chatted.available} MB less available; after pictures WS ${r.pictured.workingSetMb}, NPU ${r.pictured.npuMb}, ${r.before - r.pictured.available} MB less available; ${r.before - r.after} MB once stopped; add-on ${JSON.stringify(r.addon)}, names ${r.names.map((n) => n.text).join(' | ')}`);
}

// ------------------------------------------------------------------------------------------------ crash

/**
 * What "killed" llama-server on the Hexagon after a long read: the processor phase's server died, whatever its threads,
 * at the chat that followed a 1,413-token /completion read (n_predict 1, cache_prompt false). Each case on a fresh
 * server, one thing changed at a time: whether it lives, and its exit code and last log lines where it doesn't. Found
 * (2026-11-06): nothing killed it. This process, held over 5 s by the meter's execFileSync, sent its next request on a
 * keep-alive socket the server had closed (fetch failed), and withServer's stop then ended the server (taskkill: exit
 * 1). The name-blocked and name-ps cases show it; requests now wait a turn of the event loop first (settled).
 */
async function crashPhase(o: Options, results: any): Promise<void> {
  type Step = (s: Server) => Promise<unknown>;
  const longRead = (n: number): Step => (s) => complete(s, readPromptOf(1500, 'crash'), n, undefined);
  const longChat: Step = (s) => chat(s, [{ role: 'user', content: readPromptOf(1500, 'crash') }], 8, undefined);
  const longChatNoCache: Step = (s) => chat(s, [{ role: 'user', content: readPromptOf(1500, 'crash') }], 8, undefined, { cache_prompt: false });
  const name = (cache: boolean): Step => (s) => chat(s, namePrompt(DOCS[0].file, DOCS[0].how, DOCS[0].text), 60, undefined, cache ? {} : { cache_prompt: false });
  const shortRead: Step = (s) => complete(s, readPromptOf(300, 'crash'), 1, undefined);
  const full = [...(o.mmproj ? ['--mmproj', o.mmproj, '--image-max-tokens', '1024'] : []), ...loraArgs(o.loras.map((l) => l.file))];
  const idle: Step = async () => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) await sleep(500);
  };
  const write: Step = (s) => complete(s, 'Once upon a time', 256, undefined);
  const meter: Step = async (s) => memoryOf(s.pid);
  const pause: Step = () => sleep(6_000);
  // The meter's two halves apart: Windows' GPU Process Memory counters for the server's process, and its process figures.
  const counter: Step = async (s) => execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference = 'SilentlyContinue'; (Get-Counter '\\GPU Process Memory(pid_${s.pid}_*)\\Shared Usage','\\GPU Process Memory(pid_${s.pid}_*)\\Dedicated Usage').CounterSamples.Count`], { encoding: 'utf8' });
  const proc: Step = async (s) => execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference = 'SilentlyContinue'; $p = Get-Process -Id ${s.pid}; $os = Get-CimInstance Win32_OperatingSystem; '{0} {1}' -f $p.WorkingSet64, $os.FreePhysicalMemory`], { encoding: 'utf8' });
  // As long as the meter, in a child process that doesn't block this one (execFileSync does).
  const pauseAsync: Step = () => new Promise<void>((r) => { const t = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 4'], { stdio: 'ignore', windowsHide: true }); t.once('exit', () => r()); });
  const blocked: Step = async () => execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 4'], { stdio: 'ignore' });
  const all: { name: string; extra: string[]; steps: Step[] }[] = [
    { name: 'name-counter', extra: full, steps: [name(true), counter, counter, name(true), counter, counter, name(false)] },
    { name: 'name-proc', extra: full, steps: [name(true), proc, proc, name(true), proc, proc, name(false)] },
    { name: 'name-blocked', extra: full, steps: [name(true), blocked, blocked, name(true), blocked, blocked, name(false)] },
    { name: 'name-ps', extra: full, steps: [name(true), pauseAsync, pauseAsync, name(true), pauseAsync, pauseAsync, name(false)] },
    { name: 'read-pause', extra: full, steps: [longRead(1), pause, name(false)] },
    { name: 'chat-pause', extra: full, steps: [longChat, pause, name(true)] },
    { name: 'read-meter', extra: full, steps: [longRead(1), meter, name(false)] },
    { name: 'meter-twice', extra: full, steps: [longRead(1), meter, meter, name(false)] },
    { name: 'chat-meter', extra: full, steps: [longChat, meter, meter, name(true)] },
    { name: 'name-meter', extra: full, steps: [name(true), meter, meter, name(true), meter, meter, name(false)] },
    { name: 'cpu-seq', extra: full, steps: [idle, write, longRead(1), name(false)] },
    { name: 'cpu-seq-meter', extra: full, steps: [meter, idle, meter, meter, write, meter, meter, longRead(1), meter, meter, name(false)] },
    { name: 'write-read', extra: full, steps: [write, longRead(1), name(false)] },
    { name: 'idle-read', extra: full, steps: [idle, longRead(1), name(false)] },
    { name: 'as-cpu', extra: full, steps: [longRead(1), name(false)] },
    { name: 'name-cached', extra: full, steps: [longRead(1), name(true)] },
    { name: 'bare', extra: [], steps: [longRead(1), name(false)] },
    { name: 'mmproj-only', extra: o.mmproj ? ['--mmproj', o.mmproj, '--image-max-tokens', '1024'] : [], steps: [longRead(1), name(false)] },
    { name: 'read-4', extra: full, steps: [longRead(4), name(false)] },
    { name: 'short-read', extra: full, steps: [shortRead, name(false)] },
    { name: 'chat-read', extra: full, steps: [longChat, name(true)] },
    { name: 'chat-read-nocache', extra: full, steps: [longChatNoCache, name(false)] },
    { name: 'chat-read-twice', extra: full, steps: [longChat, longChat, name(true), longChat] },
  ];
  const cases = o.only.length ? all.filter((c) => o.only.includes(c.name)) : all;
  results.crash = {};
  for (const c0 of cases) for (let rep = 0; rep < o.runs; rep++) {
    const c = o.runs > 1 ? { ...c0, name: `${c0.name}-${rep + 1}` } : c0;
    const h = hexArgs(o, c.extra);
    let exitCode: number | null = null;
    const done: number[] = [];
    const r = await inNpuTurn(`add-on test: crash, ${c.name}`, () =>
      withServer(`crash-${c.name}`, h.exe, h.args, h.env, o, '/health', async (s) => {
        s.child.once('exit', (code) => (exitCode = code));
        await complete(s, 'Hello', 4, undefined);
        for (const [i, step] of c.steps.entries()) {
          await step(s);
          done.push(i);
        }
        // Still answering after them?
        await complete(s, 'Hello', 4, undefined);
        return { lived: true, steps: done.length };
      }),
    ).catch((e: Error) => {
      const log = readFileSync(path.join(o.out, `crash-${c.name}.log`), 'utf8').trim().split(/\r?\n/).slice(-3);
      return { lived: false, steps: done.length, error: e.message.slice(0, 200), exitCode, log };
    });
    results.crash[c.name] = r;
    say(`crash ${c.name}: ${r.lived ? 'lived' : `died after step ${r.steps} (exit ${(r as any).exitCode}; ${(r as any).error})`}`);
  }
}

// ------------------------------------------------------------------------------------------------ main

const say = (line: string) => console.log(line);

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, 'results.json');
  const results: any = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  results.pc = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: os.totalmem() / 2 ** 30, at: new Date().toISOString() };
  results.options = { ...o, phases: [...o.phases] };
  const save = () => writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
  const phases: [string, (o: Options, r: any) => Promise<void>][] = [['placement', placement], ['speed', speed], ['switch', switching], ['answers', answersPhase], ['odds', oddsPhase], ['geniex', geniexPhase], ['memory', memoryPhase], ['leak', leakPhase], ['defaults', defaultsPhase], ['footprint', footprintPhase], ['cpu', cpuPhase], ['crash', crashPhase], ['kit', kitPhase]];
  for (const [name, fn] of phases) {
    if (!o.phases.has(name)) continue;
    say(`-- ${name}`);
    await fn(o, results);
    save();
  }
  rmSync(path.join(o.out, 'pictures'), { recursive: true, force: true });
  say(`results: ${file}`);
}

await main();
