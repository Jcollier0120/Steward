/**
 * Can a LoRA add-on for Qwen3.5-2B run on AMD's XDNA 2 NPU, and at what cost? (kit/spec/ACCELERATORS.md, Add-ons.) The
 * kit's AMD NPU chat is FastFlowLM (`flm serve qwen3.5:2b`), which takes no add-on in any form (1.0.10 to 1.0.12: no
 * request field, no option, no file; its NPU kernels are AMD's prebuilt DLLs). What it does take is a model of its own
 * format, so the add-on goes in folded into the weights: a merged model (merge_lora.py), converted by AMD's q4nx
 * converter, registered as a model of its own (README.md beside this file says how). This starts FastFlowLM from a
 * scratch copy of the kit's, with the merged models in its model list beside the base, and llama.cpp's llama-server
 * with the base and the add-on itself (applied per request) on the processor (the reference) and the Radeon, and
 * records:
 *
 * - load: whether FastFlowLM loads each merged model and answers from it, on the NPU (its log's device lines);
 * - speed: reading a 1,500-token prompt, writing 128 tokens, and a Warrener name, base and merged, FastFlowLM's own
 *   timings (prefill_speed_tps, decoding_speed_tps); llama-server's base with the add-on off and on, for the same;
 * - switch: a request's time when its model differs from the one before (FastFlowLM releases one model and loads the
 *   other: the add-on's switch, on and back to none), against the same model again, and FastFlowLM's load_duration;
 * - memory: the process's working set and private bytes and what it holds on the NPU (Windows' GPU Process Memory
 *   counters, addon-test's memoryOf), with each model loaded;
 * - answers: the Warrener's names for the 8 made-up documents (addon-test.ts), greedy: base and merged on the NPU,
 *   the add-on off and on on the processor (and the Radeon), word for word; and on the NPU again with FastFlowLM's own
 *   sampling for the model, which the kit's requests get (a presence and a frequency penalty: Variant);
 * - quality: the kit's NPU benchmark (its 24 quality items and 4 pictures) on each model, as the kit asks it;
 * - odds: the model's own log-probabilities for the name's first token, base and merged on the NPU (FastFlowLM 1.0.11
 *   and later return them; 1.0.10 doesn't, and the phase says so), off, on and off again on the processor, as
 *   addon-test's odds phase: how much of the processor's change the NPU's merged model makes.
 *
 * Each NPU block runs in the NPU's turn (the kit's NPU line, background lane), its server started and stopped inside
 * it, so the staff's own NPU requests wait for it rather than run beside it. Every server runs on a private port and is
 * stopped at the end of its block; the installed manor's are left alone. The scratch FastFlowLM and its model folders
 * (hard links to the installed model's files, but for each merged model.q4nx) are made under --out and deleted by
 * --clean.
 *
 *   node tools/addon-npu/amd.ts --flm <the kit's fastflowlm-1.0.10 folder> --model-dir <%USERPROFILE%\.flm\models\Qwen3.5-2B-NPU2>
 *     --merged r32=<merged model.q4nx> [--merged name=<model.q4nx> ...] --out <folder>
 *     [--llama <llama.cpp processor folder> --gguf <Qwen3.5-2B GGUF> --lora r32=<add-on GGUF>] [--vulkan <llama.cpp Vulkan folder>]
 *     [--phases load,speed,switch,answers,quality,odds] [--runs 3] [--threads 4] [--port 28621] [--clean]
 *
 * A --lora's name pairs it with the --merged of the same name: the add-on the merged model was made from.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, cpSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npuLockDir } from '../../src/kit/lock.ts';
import { withNpuTurn } from '../../src/kit/npu-queue.ts';
import { answers as answersAt, DOCS, median, memoryOf, namePrompt, post, qualityAndPictures, readPromptOf, tps, until, type Memory } from './addon-test.ts';

// ------------------------------------------------------------------------------------------------ options

interface Named {
  name: string;
  file: string;
}

interface Options {
  flm: string;
  modelDir: string;
  merged: Named[];
  llama: string | null;
  vulkan: string | null;
  gguf: string | null;
  loras: Named[];
  out: string;
  phases: Set<string>;
  runs: number;
  threads: number;
  port: number;
  clean: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { flm: '', modelDir: '', merged: [], llama: null, vulkan: null, gguf: null, loras: [], out: '', phases: new Set(['load', 'speed', 'switch', 'answers', 'quality', 'odds']), runs: 3, threads: 4, port: 28621, clean: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    const named = (): Named => {
      const [name, ...rest] = v().split('=');
      if (!/^[a-z0-9]+$/.test(name)) throw new Error(`${a}: a name is lower-case letters and digits, not ${name}`);
      return { name, file: path.resolve(rest.join('=')) };
    };
    if (a === '--flm') o.flm = path.resolve(v());
    else if (a === '--model-dir') o.modelDir = path.resolve(v());
    else if (a === '--merged') o.merged.push(named());
    else if (a === '--llama') o.llama = path.resolve(v());
    else if (a === '--vulkan') o.vulkan = path.resolve(v());
    else if (a === '--gguf') o.gguf = path.resolve(v());
    else if (a === '--lora') o.loras.push(named());
    else if (a === '--out') o.out = path.resolve(v());
    else if (a === '--phases') o.phases = new Set(v().split(','));
    else if (a === '--runs') o.runs = Number(v());
    else if (a === '--threads') o.threads = Math.min(8, Number(v()));
    else if (a === '--port') o.port = Number(v());
    else if (a === '--clean') o.clean = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.flm || !o.modelDir || !o.out) throw new Error('--flm, --model-dir and --out are needed');
  return o;
}

// ------------------------------------------------------------------------------------------------ the scratch FastFlowLM

/** FastFlowLM's family and size for the kit's model, and each merged model's tag beside it. */
const FAMILY = 'qwen3.5';
const SIZE = '2b';
const tagOf = (name: string | null) => (name ? `${FAMILY}:${SIZE}-${name}` : `${FAMILY}:${SIZE}`);
const folderOf = (base: string, name: string | null) => (name ? base.replace(/-NPU2$/, `-${name.toUpperCase()}-NPU2`) : base);

interface Scratch {
  exe: string;
  env: Record<string, string>;
}

/**
 * A copy of the kit's FastFlowLM folder whose model_list.json names each merged model as a size of its own in the
 * family (`qwen3.5:2b-r32`), with the kit's model's xclbins under its folder name; and a model folder for each
 * (FLM_MODEL_PATH\models\<name>): hard links to the installed model's files, but for model.q4nx. Its download
 * addresses go nowhere, so a model it finds missing fails to load rather than downloading something.
 */
function scratchFlm(o: Options): Scratch {
  const dir = path.join(o.out, 'flm');
  const home = path.join(o.out, 'flm-home');
  const baseName = path.basename(o.modelDir);
  if (!existsSync(path.join(dir, 'flm.exe'))) cpSync(o.flm, dir, { recursive: true });
  const listFile = path.join(dir, 'model_list.json');
  const list = JSON.parse(readFileSync(path.join(o.flm, 'model_list.json'), 'utf8'));
  const base = list.models?.[FAMILY]?.[SIZE];
  if (!base || base.name !== baseName) throw new Error(`${o.flm}'s model list has no ${tagOf(null)} named ${baseName}`);
  const nowhere = 'http://127.0.0.1:9/no-download';
  for (const m of o.merged) {
    const name = folderOf(baseName, m.name);
    list.models[FAMILY][`${SIZE}-${m.name}`] = { ...base, name, url: nowhere, file_url: nowhere, ms_url: nowhere };
    const xcl = path.join(dir, 'xclbins', name);
    if (!existsSync(xcl)) cpSync(path.join(o.flm, 'xclbins', baseName), xcl, { recursive: true });
  }
  writeFileSync(listFile, JSON.stringify(list, null, 2));
  for (const m of [null, ...o.merged]) {
    const folder = path.join(home, 'models', folderOf(baseName, m?.name ?? null));
    mkdirSync(folder, { recursive: true });
    for (const f of readdirSync(o.modelDir)) {
      const to = path.join(folder, f);
      if (existsSync(to)) rmSync(to);
      if (m && f === 'model.q4nx') linkSync(m.file, to);
      else linkSync(path.join(o.modelDir, f), to);
    }
  }
  return { exe: path.join(dir, 'flm.exe'), env: { FLM_DISABLE_UPDATE_CHECK: '1', FLM_MODEL_PATH: home } };
}

// ------------------------------------------------------------------------------------------------ servers

interface Server {
  name: string;
  child: ChildProcess;
  pid: number;
  base: string;
  log: string;
  readyMs: number;
  kind: 'flm' | 'llama';
}

async function start(o: Options, name: string, kind: Server['kind'], exe: string, args: string[], env: Record<string, string>, ready: string): Promise<Server> {
  const base = `http://127.0.0.1:${o.port}`;
  if ((await answersAt(`${base}${ready}`, 1000)) !== null) throw new Error(`something already answers on ${base}`);
  const log = path.join(o.out, `${name}.log`);
  const fd = openSync(log, 'w');
  const t0 = Date.now();
  const child = spawn(exe, args, { cwd: path.dirname(exe), env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], windowsHide: true });
  closeSync(fd);
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));
  await until(async () => {
    if (exited !== null) throw new Error(`${name} exited (${exited}) before it answered: ${log}`);
    return (await answersAt(`${base}${ready}`)) === 200;
  }, 240_000, `${name} didn't answer within 240 s: ${log}`);
  return { name, child, pid: child.pid!, base, log, readyMs: Date.now() - t0, kind };
}

async function stop(s: Server): Promise<void> {
  if (s.child.exitCode === null) {
    const gone = new Promise<void>((r) => s.child.once('exit', () => r()));
    try {
      execFileSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      s.child.kill();
    }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 20_000))]);
  }
  await until(async () => (await answersAt(`${s.base}/v1/models`, 500)) === null, 20_000, `${s.name} still answers after it was stopped`);
}

async function withServer<T>(o: Options, name: string, kind: Server['kind'], exe: string, args: string[], env: Record<string, string>, ready: string, fn: (s: Server) => Promise<T>): Promise<T> {
  const s = await start(o, name, kind, exe, args, env, ready);
  try {
    return await fn(s);
  } finally {
    await stop(s);
  }
}

/** The kit's FastFlowLM command (kit/spec/npu-vendors.json, the AMD route), from the scratch copy, the kit's model first. */
const withFlm = <T>(o: Options, f: Scratch, name: string, fn: (s: Server) => Promise<T>) =>
  withServer(o, name, 'flm', f.exe, ['serve', tagOf(null), '--port', String(o.port), '--ctx-len', '4096'], f.env, '/v1/models', fn);

/** llama-server with the base GGUF and every add-on loaded at 0, on the processor or (`vulkan`) the Radeon. */
function withLlama<T>(o: Options, where: 'cpu' | 'gpu', name: string, fn: (s: Server) => Promise<T>): Promise<T> {
  const dir = where === 'cpu' ? o.llama : o.vulkan;
  if (!dir || !o.gguf) throw new Error('--llama (or --vulkan) and --gguf are needed for the reference');
  const device = where === 'cpu' ? ['--device', 'none', '-ngl', '0', '--no-op-offload'] : ['-ngl', '99'];
  const loras = o.loras.length ? [...o.loras.flatMap((l) => ['--lora', l.file]), '--lora-init-without-apply'] : [];
  const args = ['--host', '127.0.0.1', '--port', String(o.port), ...device, '-m', o.gguf, '-c', '4096', '--parallel', '1', '-t', String(o.threads), '-tb', String(o.threads), '--no-webui', ...loras];
  return withServer(o, name, 'llama', path.join(dir, 'llama-server.exe'), args, { LLAMA_ARG_CACHE_RAM: '0' }, '/health', fn);
}

/** One block of work in the NPU's turn: the staff's NPU requests wait for it rather than run beside it. */
const inNpuTurn = <T>(doing: string, fn: () => Promise<T>) =>
  withNpuTurn(npuLockDir, fn, { lane: 'background', who: 'addon-test', doing: doing.slice(0, 80), waitMs: 30 * 60_000, staleMs: 40 * 60_000 });

// ------------------------------------------------------------------------------------------------ requests

/**
 * Which model a request is for: FastFlowLM's tag, or llama-server's add-on scales (all named, the one on at 1).
 * `kitSampling`: FastFlowLM's own sampling for the model, as the kit's requests get it (they send no penalty), rather
 * than greedy with no penalty, as llama-server's defaults are. FastFlowLM's Qwen3.5 engine sets a presence penalty of
 * 1.5 and a frequency penalty of 1.0 at each load (modeling_qwen3_5vl.cpp), and they reach the prompt's last tokens:
 * a Warrener answer then avoids "NAME:" and "FOLDER:", which the prompt ends with.
 */
interface Variant {
  name: string;
  tag?: string;
  lora?: { id: number; scale: number }[];
  kitSampling?: boolean;
}

/** Greedy with no penalty, as llama-server's defaults are. FastFlowLM keeps a request's settings for the next. */
const NEUTRAL = { presence_penalty: 0, frequency_penalty: 0, repetition_penalty: 1 };

interface Answer {
  text: string;
  promptTokens: number;
  cachedTokens: number;
  genTokens: number;
  readTps: number;
  genTps: number;
  wallMs: number;
  loadMs: number;
  raw: any;
}

/** A chat request, greedy, thinking off, with the server's own timings: FastFlowLM's usage, or llama-server's timings. */
async function ask(s: Server, v: Variant, messages: unknown[], maxTokens: number, extra: Record<string, unknown> = {}): Promise<Answer> {
  const body: Record<string, unknown> =
    s.kind === 'flm'
      ? v.kitSampling
        ? { model: v.tag, messages, max_tokens: maxTokens, temperature: 0, stream: false, ...extra }
        : { model: v.tag, messages, max_tokens: maxTokens, temperature: 0, top_k: 1, stream: false, think: false, ...NEUTRAL, ...extra }
      : { messages, max_tokens: maxTokens, temperature: 0, top_k: 1, seed: 1, stream: false, chat_template_kwargs: { enable_thinking: false }, cache_prompt: false, ...(v.lora ? { lora: v.lora } : {}), ...extra };
  const r = await post(`${s.base}/v1/chat/completions`, body);
  if (r.status !== 200 || r.json?.error) throw new Error(`${s.name} ${v.name}: ${r.status} ${r.text.slice(0, 300)}`);
  const u = r.json.usage ?? {};
  const t = r.json.timings ?? {};
  const text = r.json.choices?.[0]?.message?.content ?? '';
  if (s.kind === 'flm')
    return { text, promptTokens: u.prompt_tokens ?? 0, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0, genTokens: u.completion_tokens ?? 0, readTps: u.prefill_speed_tps ?? 0, genTps: u.decoding_speed_tps ?? 0, wallMs: r.ms, loadMs: (u.load_duration ?? 0) * 1000, raw: r.json };
  return { text, promptTokens: t.prompt_n ?? 0, cachedTokens: t.cache_n ?? 0, genTokens: t.predicted_n ?? 0, readTps: tps(t.prompt_n ?? 0, t.prompt_ms ?? 0), genTps: tps(t.predicted_n ?? 0, t.predicted_ms ?? 0), wallMs: r.ms, loadMs: 0, raw: r.json };
}

const flmVariants = (o: Options): Variant[] => [{ name: 'base', tag: tagOf(null) }, ...o.merged.map((m) => ({ name: m.name, tag: tagOf(m.name) }))];

/** llama-server's variants: every add-on off, then each on alone. */
const llamaVariants = (o: Options): Variant[] => [
  { name: 'base', lora: o.loras.length ? o.loras.map((_, j) => ({ id: j, scale: 0 })) : undefined },
  ...o.loras.map((l, i) => ({ name: l.name, lora: o.loras.map((_, j) => ({ id: j, scale: j === i ? 1 : 0 })) })),
];

const say = (line: string) => console.log(line);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
/** The runs' range, "(12.2–16.3)". */
const spread = (xs: number[], digits: number) => `(${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)})`;
const mb = (m: Memory) => ({ workingSetMb: Math.round(m.workingSetMb), privateMb: Math.round(m.privateMb), npuMb: m.npuMb === null ? null : Math.round(m.npuMb), availableMb: Math.round(m.availableMb) });

/** The lines of a FastFlowLM log that say what it loaded and where, and anything that looks like a failure. */
function flmLogLines(log: string): { device: string[]; failures: string[] } {
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/) : [];
  return {
    device: lines.filter((l) => /npu|xclbin|device|loaded|load time|backend/i.test(l)).slice(0, 40).map((l) => l.trim().slice(0, 200)),
    failures: lines.filter((l) => /error|fail|exception|incompatible|not supported|abort/i.test(l)).slice(0, 20).map((l) => l.trim().slice(0, 200)),
  };
}

// ------------------------------------------------------------------------------------------------ load

async function loadPhase(o: Options, f: Scratch, results: any): Promise<void> {
  results.load = await inNpuTurn('add-on test (AMD): load', () =>
    withFlm(o, f, 'load', async (s) => {
      const rows: Record<string, unknown> = { readyMs: s.readyMs };
      for (const v of flmVariants(o)) {
        try {
          const a = await ask(s, v, [{ role: 'user', content: 'Reply with the word OK and nothing else.' }], 8);
          rows[v.name] = { ok: true, answer: a.text, loadMs: a.loadMs, wallMs: a.wallMs, memory: mb(memoryOf(s.pid)) };
        } catch (e) {
          rows[v.name] = { ok: false, error: String((e as Error).message ?? e).slice(0, 400) };
        }
      }
      return rows;
    }),
  );
  results.load.log = flmLogLines(path.join(o.out, 'load.log'));
  for (const v of flmVariants(o)) say(`load ${v.name}: ${JSON.stringify(results.load[v.name])}`);
}

// ------------------------------------------------------------------------------------------------ speed and memory

interface SpeedRow {
  where: string;
  variant: string;
  readTps: number;
  genTps: number;
  nameWallMs: number;
  cpuSecondsPerGenToken: number;
  memory: ReturnType<typeof mb>;
}

/** One run of a variant: a 1,500-token prompt read, 128 tokens written, 3 Warrener names, each a prompt no request before it shared. */
async function speedRun(s: Server, v: Variant, tag: string, acc: { reads: number[]; gens: number[]; names: number[]; genTokens: number }): Promise<void> {
  const read = await ask(s, v, [{ role: 'system', content: `${tag} You count lines.` }, { role: 'user', content: readPromptOf(1500, tag) }], 1);
  acc.reads.push(read.readTps);
  const gen = await ask(s, v, [{ role: 'system', content: `${tag} You write stories.` }, { role: 'user', content: `[${tag}] Write a long story, at least 400 words, about a steward who keeps a manor's cellar.` }], 128);
  acc.gens.push(gen.genTps);
  acc.genTokens += gen.genTokens;
  for (const d of DOCS.slice(0, 3)) {
    const msgs = namePrompt(d.file, d.how, d.text);
    msgs[0].content = `${tag} ${msgs[0].content}`;
    const t = await ask(s, v, msgs, 60);
    acc.names.push(t.wallMs);
    acc.genTokens += t.genTokens;
  }
}

/**
 * Each variant's runs interleaved, in turn first, the switch between them outside the measured
 * requests (a short request first): FastFlowLM's in one server in the NPU's turn; llama-server's on the processor and
 * the Radeon, the add-on on and off per request.
 */
async function speedPhase(o: Options, f: Scratch, results: any): Promise<void> {
  results.speed = [];
  const block = async (s: Server, where: string, variants: Variant[]) => {
    const acc = Object.fromEntries(variants.map((v) => [v.name, { reads: [] as number[], gens: [] as number[], names: [] as number[], genTokens: 0, cpu: 0, memory: null as Memory | null }]));
    // Each run starts one variant later (base, merged; merged, base...): a speed that drifts over the block (the NPU's
    // and the processor's did, by a fifth from the first run to the third) falls on every variant alike.
    for (let r = 0; r < o.runs; r++)
      for (const v of [...variants.slice(r % variants.length), ...variants.slice(0, r % variants.length)]) {
        await ask(s, v, [{ role: 'user', content: `[${r}] Reply with OK.` }], 1);
        const a = acc[v.name];
        const cpu0 = memoryOf(s.pid).cpuSeconds;
        await speedRun(s, v, `${where}-${v.name}-${r}-${Date.now().toString(36)}`, a);
        const m = memoryOf(s.pid);
        a.cpu += m.cpuSeconds - cpu0;
        a.memory = m;
      }
    for (const v of variants) {
      const a = acc[v.name];
      const row: SpeedRow = { where, variant: v.name, readTps: mean(a.reads), genTps: mean(a.gens), nameWallMs: mean(a.names), cpuSecondsPerGenToken: a.cpu / Math.max(1, a.genTokens), memory: mb(a.memory!) };
      results.speed.push({ ...row, medians: { readTps: median(a.reads), genTps: median(a.gens), nameWallMs: median(a.names) }, reads: a.reads, gens: a.gens, names: a.names });
      say(`speed ${where} ${v.name}: reads ${row.readTps.toFixed(0)} t/s ${spread(a.reads, 0)}, writes ${row.genTps.toFixed(1)} t/s ${spread(a.gens, 1)}, a name ${row.nameWallMs.toFixed(0)} ms ${spread(a.names, 0)}, ${(row.cpuSecondsPerGenToken * 1000).toFixed(1)} ms processor a token written, ${JSON.stringify(row.memory)}`);
    }
  };
  await inNpuTurn('add-on test (AMD): speed', () => withFlm(o, f, 'speed-npu', (s) => block(s, 'npu (XDNA 2)', flmVariants(o))));
  if (o.llama && o.gguf) await withLlama(o, 'cpu', 'speed-cpu', (s) => block(s, 'processor (Ryzen AI 7 350)', llamaVariants(o)));
  if (o.vulkan && o.gguf) await withLlama(o, 'gpu', 'speed-gpu', (s) => block(s, 'graphics (Radeon 860M)', llamaVariants(o)));
}

// ------------------------------------------------------------------------------------------------ switching

/**
 * The add-on's switch on FastFlowLM is a change of model: the first request after it, against the same request again
 * (its prompt cached or not, the same each time), FastFlowLM's own load_duration, and the memory each leaves; 5 rounds
 * of base, merged (switched on), merged again, base (back to none).
 */
async function switchPhase(o: Options, f: Scratch, results: any): Promise<void> {
  const m = o.merged[0];
  if (!m) return;
  const base: Variant = { name: 'base', tag: tagOf(null) };
  const on: Variant = { name: m.name, tag: tagOf(m.name) };
  results.switch = await inNpuTurn('add-on test (AMD): switching', () =>
    withFlm(o, f, 'switch', async (s) => {
      const d = DOCS[1];
      const msgs = namePrompt(d.file, d.how, d.text);
      await ask(s, base, msgs, 1);
      const rows: { step: string; wallMs: number; loadMs: number; promptTokens: number; cachedTokens: number; memory: ReturnType<typeof mb> }[] = [];
      const one = async (step: string, v: Variant) => {
        const a = await ask(s, v, msgs, 1);
        rows.push({ step, wallMs: a.wallMs, loadMs: a.loadMs, promptTokens: a.promptTokens, cachedTokens: a.cachedTokens, memory: mb(memoryOf(s.pid)) });
      };
      for (let r = 0; r < 5; r++) {
        await one('base, again', base);
        await one('on, switched', on);
        await one('on, again', on);
        await one('off, switched', base);
      }
      const by = (step: string) => rows.filter((x) => x.step === step);
      const summary = Object.fromEntries(['base, again', 'on, switched', 'on, again', 'off, switched'].map((k) => [k, { wallMs: median(by(k).map((x) => x.wallMs)), loadMs: median(by(k).map((x) => x.loadMs)), npuMb: median(by(k).map((x) => x.memory.npuMb ?? NaN)), privateMb: median(by(k).map((x) => x.memory.privateMb)) }]));
      return { rows, summary };
    }),
  );
  say(`switch: ${JSON.stringify(results.switch.summary)}`);
}

// ------------------------------------------------------------------------------------------------ answers

async function nameAll(s: Server, v: Variant): Promise<string[]> {
  const out: string[] = [];
  for (const d of DOCS) out.push((await ask(s, v, namePrompt(d.file, d.how, d.text), 60)).text.trim());
  return out;
}

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

async function answersPhase(o: Options, f: Scratch, results: any): Promise<void> {
  const all = async (s: Server, variants: Variant[]) => {
    const r: Record<string, string[]> = {};
    for (const v of variants) r[v.name] = await nameAll(s, v);
    return r;
  };
  const by: Record<string, Record<string, string[]>> = {};
  by.npu = await inNpuTurn('add-on test (AMD): answers', () => withFlm(o, f, 'answers-npu', (s) => all(s, flmVariants(o))));
  // The same with FastFlowLM's own sampling, as the kit's requests get it.
  by['npu-kit'] = await inNpuTurn('add-on test (AMD): answers, kit sampling', () => withFlm(o, f, 'answers-npu-kit', (s) => all(s, flmVariants(o).map((v) => ({ ...v, kitSampling: true })))));
  if (o.llama && o.gguf) by.cpu = await withLlama(o, 'cpu', 'answers-cpu', (s) => all(s, llamaVariants(o)));
  if (o.vulkan && o.gguf) by.gpu = await withLlama(o, 'gpu', 'answers-gpu', (s) => all(s, llamaVariants(o)));
  const compare: Record<string, unknown> = {};
  for (const [where, r] of Object.entries(by))
    for (const k of Object.keys(r)) {
      const ref = by.cpu?.[k];
      compare[`${where} ${k}`] = {
        changedFromBase: k === 'base' ? null : r[k].filter((a, i) => a !== r.base[i]).length,
        sameAsProcessor: ref ? r[k].filter((a, i) => a === ref[i]).length : null,
        meanSharedStartWithProcessor: ref ? r[k].map((a, i) => commonPrefix(a, ref[i]) / Math.max(1, a.length, ref[i].length)).reduce((x, y) => x + y, 0) / r[k].length : null,
        of: r[k].length,
      };
    }
  results.answers = { docs: DOCS.map((d) => d.file), ...by, compare };
  for (const [k, c] of Object.entries(compare)) say(`answers ${k}: ${JSON.stringify(c)}`);
}

// ------------------------------------------------------------------------------------------------ quality

/**
 * The kit's NPU benchmark on each model, as the kit asks it (addon-test's qualityAndPictures: its 24 quality items and
 * 4 pictures, FastFlowLM's own sampling): does a merged model, the control included, still answer as the model does?
 */
async function qualityPhase(o: Options, f: Scratch, results: any): Promise<void> {
  const dir = path.join(o.out, 'pictures');
  mkdirSync(dir, { recursive: true });
  results.quality = await inNpuTurn('add-on test (AMD): quality', () =>
    withFlm(o, f, 'quality', async (s) => {
      const r: Record<string, Awaited<ReturnType<typeof qualityAndPictures>>> = {};
      for (const v of flmVariants(o)) r[v.name] = await qualityAndPictures(s.base, v.tag, false, true, dir);
      return r;
    }),
  );
  rmSync(dir, { recursive: true, force: true });
  const base = results.quality.base;
  for (const [k, q] of Object.entries(results.quality as Record<string, Awaited<ReturnType<typeof qualityAndPictures>>>)) {
    const passed = q.quality.filter((x) => x.pass).length;
    const mustFailed = q.quality.filter((x) => x.mustPass && !x.pass).map((x) => x.id);
    const differ = k === 'base' ? [] : q.quality.filter((x, i) => x.pass !== base.quality[i].pass).map((x) => `${x.id} ${x.pass ? '+' : '-'}`);
    say(`quality ${k}: ${passed} of ${q.quality.length}${mustFailed.length ? `, must-pass failed: ${mustFailed.join(', ')}` : ''}; pictures ${q.pictures.filter((x) => x.pass).length} of ${q.pictures.length}${differ.length ? `; against the base: ${differ.join(', ')}` : ''}`);
  }
}

// ------------------------------------------------------------------------------------------------ odds

const ODDS_TOP = 8;
type Odds = Record<string, number>;

/**
 * FastFlowLM 1.0.11 and later: a chat request with the answer's start given ("NAME:", continue_final_message) and
 * logprobs on, one token. null when the server returns no log-probabilities (1.0.10).
 */
async function flmOdds(s: Server, v: Variant, d: (typeof DOCS)[number]): Promise<Odds | null> {
  const r = await post(`${s.base}/v1/chat/completions`, { model: v.tag, messages: [...namePrompt(d.file, d.how, d.text), { role: 'assistant', content: 'NAME:' }], continue_final_message: true, add_generation_prompt: false, max_tokens: 1, temperature: 0, top_k: 1, think: false, ...NEUTRAL, logprobs: true, top_logprobs: ODDS_TOP, stream: false });
  if (r.status !== 200 || r.json?.error) throw new Error(`${s.name} ${v.name}: ${r.status} ${r.text.slice(0, 300)}`);
  const top: { token: string; logprob: number }[] | undefined = r.json.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
  return top ? Object.fromEntries(top.map((x) => [x.token, x.logprob])) : null;
}

/** llama-server: the chat template applied with thinking off (as FastFlowLM does), the answer's start given. */
async function llamaOdds(s: Server, v: Variant, d: (typeof DOCS)[number]): Promise<Odds> {
  const t = await post(`${s.base}/apply-template`, { messages: namePrompt(d.file, d.how, d.text), chat_template_kwargs: { enable_thinking: false } });
  if (t.status !== 200) throw new Error(`${s.name}: apply-template ${t.status} ${t.text.slice(0, 200)}`);
  const r = await post(`${s.base}/completion`, { prompt: `${t.json.prompt}NAME:`, n_predict: 1, temperature: 0, top_k: 1, n_probs: ODDS_TOP, cache_prompt: false, ...(v.lora ? { lora: v.lora } : {}) });
  if (r.status !== 200) throw new Error(`${s.name}: ${r.status} ${r.text.slice(0, 200)}`);
  const top: { token: string; logprob: number }[] = r.json.completion_probabilities?.[0]?.top_logprobs ?? [];
  return Object.fromEntries(top.map((x) => [x.token, x.logprob]));
}

/**
 * How much of the processor's change the NPU's merged model makes, add-on by add-on (addon-test's oddsPhase):
 * `follows` the least-squares slope of the NPU's change on the processor's over the tokens both list; `apart` the mean
 * gap between the changes, against `baseApart`, the gap without the add-on (the NPU's own rounding and AMD's
 * quantization); `offAgain` the largest move between off before and off after an on (FastFlowLM: back to the base model).
 */
async function oddsPhase(o: Options, f: Scratch, results: any): Promise<void> {
  results.odds = {};
  for (const m of o.merged) {
    const l = o.loras.find((x) => x.name === m.name);
    const base: Variant = { name: 'base', tag: tagOf(null) };
    const on: Variant = { name: m.name, tag: tagOf(m.name) };
    const npu = await inNpuTurn(`add-on test (AMD): odds, ${m.name}`, () =>
      withFlm(o, f, `odds-${m.name}-npu`, async (s) => {
        const rows: { off: Odds; on: Odds; offAgain: Odds }[] = [];
        for (const d of DOCS) {
          const off = await flmOdds(s, base, d);
          if (!off) return null;
          rows.push({ off, on: (await flmOdds(s, on, d))!, offAgain: (await flmOdds(s, base, d))! });
        }
        return rows;
      }),
    );
    if (!npu) {
      results.odds[m.name] = { error: 'FastFlowLM returned no log-probabilities (1.0.10 has none; 1.0.11 added them)' };
      say(`odds ${m.name}: ${results.odds[m.name].error}`);
      continue;
    }
    if (!l || !o.llama || !o.gguf) {
      results.odds[m.name] = { npu };
      continue;
    }
    const i = o.loras.indexOf(l);
    const offL: Variant = { name: 'base', lora: o.loras.map((_, j) => ({ id: j, scale: 0 })) };
    const onL: Variant = { name: l.name, lora: o.loras.map((_, j) => ({ id: j, scale: j === i ? 1 : 0 })) };
    const cpu = await withLlama(o, 'cpu', `odds-${m.name}-cpu`, async (s) => {
      const rows: { off: Odds; on: Odds; offAgain: Odds }[] = [];
      for (const d of DOCS) rows.push({ off: await llamaOdds(s, offL, d), on: await llamaOdds(s, onL, d), offAgain: await llamaOdds(s, offL, d) });
      return rows;
    });
    let sxy = 0;
    let sxx = 0;
    const apart: number[] = [];
    const baseApart: number[] = [];
    let offAgain = 0;
    let cpuOffAgain = 0;
    const changes: number[] = [];
    for (const [k, c] of cpu.entries()) {
      const n = npu[k];
      for (const tok of Object.keys(c.off)) {
        if (tok in c.on) changes.push(Math.abs(c.on[tok] - c.off[tok]));
        if (!(tok in c.on) || !(tok in n.off) || !(tok in n.on)) continue;
        const dc = c.on[tok] - c.off[tok];
        const dn = n.on[tok] - n.off[tok];
        sxy += dn * dc;
        sxx += dc * dc;
        apart.push(Math.abs(dn - dc));
        baseApart.push(Math.abs(n.off[tok] - c.off[tok]));
      }
      for (const tok of Object.keys(n.off)) offAgain = Math.max(offAgain, Math.abs((n.offAgain[tok] ?? -99) - n.off[tok]));
      for (const tok of Object.keys(c.off)) cpuOffAgain = Math.max(cpuOffAgain, Math.abs((c.offAgain[tok] ?? -99) - c.off[tok]));
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const top = (x: Odds) => Object.entries(x).sort((a, b) => b[1] - a[1])[0]?.[0];
    const summary = {
      follows: sxx > 0 ? sxy / sxx : null,
      apart: mean(apart),
      baseApart: mean(baseApart),
      processorChange: mean(changes),
      offAgain,
      processorOffAgain: cpuOffAgain,
      sameTopToken: { off: cpu.filter((c, k) => top(c.off) === top(npu[k].off)).length, on: cpu.filter((c, k) => top(c.on) === top(npu[k].on)).length, of: cpu.length },
      tokens: apart.length,
    };
    results.odds[m.name] = { summary, npu, cpu };
    say(`odds ${m.name}: ${JSON.stringify(summary)}`);
  }
}

// ------------------------------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, 'results.json');
  const results: any = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  results.pc = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: os.totalmem() / 2 ** 30, at: new Date().toISOString() };
  results.options = { ...o, phases: [...o.phases] };
  results.models = { base: { file: path.join(o.modelDir, 'model.q4nx'), bytes: statSync(path.join(o.modelDir, 'model.q4nx')).size }, ...Object.fromEntries(o.merged.map((m) => [m.name, { file: m.file, bytes: statSync(m.file).size }])) };
  const save = () => writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
  const f = scratchFlm(o);
  const phases: [string, (o: Options, f: Scratch, r: any) => Promise<void>][] = [['load', loadPhase], ['speed', speedPhase], ['switch', switchPhase], ['answers', answersPhase], ['quality', qualityPhase], ['odds', oddsPhase]];
  try {
    for (const [name, fn] of phases) {
      if (!o.phases.has(name)) continue;
      say(`-- ${name}`);
      await fn(o, f, results);
      save();
    }
  } finally {
    if (o.clean) {
      rmSync(path.join(o.out, 'flm'), { recursive: true, force: true });
      rmSync(path.join(o.out, 'flm-home'), { recursive: true, force: true });
    }
  }
  say(`results: ${file}`);
}

await main();
