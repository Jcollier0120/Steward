/**
 * Can a LoRA add-on for Qwen3-VL-2B run on Intel's NPU, and at what cost? (kit/spec/ACCELERATORS.md, Add-ons.) The
 * kit's Intel NPU chat is OpenVINO Model Server, whose LLM graphs take no add-on, so this runs the pipeline it runs on
 * the NPU, OpenVINO GenAI's VLMPipeline, directly (addon_ov.py, one Python process a pipeline), with the kit's model
 * and its NPU settings (routeFor, the PC's generation), and records:
 *
 * - answers: the Warrener's names for the 8 made-up documents (addon-test.ts), greedy, on each device, each add-on off
 *   and on: the NPU's against the processor's (the reference) word for word;
 * - odds: the model's own log-probabilities for the name's first token, each add-on off, on and off again, on the NPU
 *   and the processor, as addon-test's odds phase (GenAI returns each sampled token's raw log-probability, so they are
 *   gathered by sampling among the top few: addon_ov.py);
 * - speed: reading a 1,500-token prompt, writing 128 tokens, and a Warrener name, with no add-on in the pipeline, with
 *   one loaded but off, and on; the processor's seconds for each token written (the add-on's work, were it on the
 *   processor, would show there: NPUW compiles every part of the language model for the NPU alone);
 * - switch: a request's time when its add-on differs from the one before, against the same add-on again;
 * - swap: the base's pipeline alone, as today, and the add-on's in its place only for a batch of add-on jobs: each swap's
 *   time from a full cache, a chat arriving mid-batch, and the base's answers after it, byte for byte;
 * - bank: the base's pipeline and the add-on's side by side in one process, each with its own NPUW weights bank, then
 *   with one bank named for both: memory, and the base's speed and answers beside the other;
 * - cold: making the pipeline with an empty compile cache and with a full one, and its first answer, with and without
 *   an add-on (the kit stops an idle server, and its next request starts it again);
 * - memory: the process's working set and private bytes and what it holds on the NPU (Windows' GPU Process Memory
 *   counters, addon-test's memoryOf), after loading and after chat, with and without an add-on;
 * - ovms: the kit's own server, OpenVINO Model Server with the kit's command for this PC's generation, against GenAI
 *   directly without an add-on: speed, the NPU benchmark's 24 quality items and 4 pictures, its start and memory.
 *
 * Each block runs in the NPU's turn (the kit's NPU line, background lane), its own pipeline or server started and
 * stopped inside it, so the staff's own NPU requests wait for it rather than run beside it, and get the NPU between
 * blocks. OpenVINO Model Server runs on a private port, from a copy of the model's folder made of hard links without
 * its graph.pbtxt (the server writes one at its start). The installed manor's servers are left alone.
 *
 *   node tools/addon-npu/intel.ts --python <venv>\Scripts\python.exe --model <Castellan-AI\Qwen3-VL-2B-Instruct-int8-sym-ov>
 *     --lora warrener=<adapter_model.safetensors>@2 [--lora name=<file>@alpha ...] --out <folder>
 *     [--phases answers,odds,speed,switch,swap,bank,cold,memory,ovms] [--devices NPU,CPU,GPU] [--ovms <ovms.exe>]
 *     [--generation meteor-lake] [--runs 3] [--samples 12] [--top-k 5] [--port 28611] [--prop KEY=VALUE ...]
 *
 * An add-on's alpha (after @) is the whole scale GenAI puts on B @ A: lora_alpha / r for PEFT's own (addon_ov.py).
 * README.md beside this file says what the Python needs.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { grade, picturePng, promptOf, SUITE } from '../../src/kit/npu-bench.ts';
import { npuLockDir } from '../../src/kit/lock.ts';
import { withNpuTurn } from '../../src/kit/npu-queue.ts';
import { NPU_CATALOG, npuEntry, pinnedRoute, routeFor } from '../../src/kit/npu-vendors.ts';
import { answers as answersAt, DOCS, median, memoryOf, namePrompt, post, qualityAndPictures, readPromptOf, routeSpeed, until, type Memory } from './addon-test.ts';

// ------------------------------------------------------------------------------------------------ options

interface Lora {
  name: string;
  file: string;
  alpha: number;
}

interface Options {
  python: string;
  model: string;
  loras: Lora[];
  out: string;
  phases: Set<string>;
  devices: string[];
  ovms: string | null;
  generation: string;
  runs: number;
  samples: number;
  topK: number;
  port: number;
  /** More pipeline properties, for every device (`--prop NPUW_LLM_MAX_LORA_RANK=64`). */
  props: string[];
}

function parseArgs(argv: string[]): Options {
  const o: Options = { python: '', model: '', loras: [], out: '', phases: new Set(['answers', 'odds', 'speed', 'switch', 'swap', 'bank', 'cold', 'memory', 'ovms']), devices: ['NPU', 'CPU', 'GPU'], ovms: null, generation: 'meteor-lake', runs: 3, samples: 12, topK: 5, port: 28611, props: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--python') o.python = v();
    else if (a === '--model') o.model = v();
    else if (a === '--lora') {
      const [name, ...rest] = v().split('=');
      const spec = rest.join('=');
      const at = spec.lastIndexOf('@');
      if (at < 0) throw new Error(`--lora ${name}: give its alpha after @ (lora_alpha / r for PEFT's own)`);
      o.loras.push({ name, file: spec.slice(0, at), alpha: Number(spec.slice(at + 1)) });
    } else if (a === '--out') o.out = v();
    else if (a === '--phases') o.phases = new Set(v().split(','));
    else if (a === '--devices') o.devices = v().split(',').map((d) => d.toUpperCase());
    else if (a === '--ovms') o.ovms = v();
    else if (a === '--generation') o.generation = v();
    else if (a === '--runs') o.runs = Number(v());
    else if (a === '--samples') o.samples = Number(v());
    else if (a === '--top-k') o.topK = Number(v());
    else if (a === '--port') o.port = Number(v());
    else if (a === '--prop') o.props.push(v());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.python || !o.model || !o.out) throw new Error('--python, --model and --out are needed');
  return o;
}

const say = (line: string) => console.log(line);
const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const worker = path.join(import.meta.dirname, 'addon_ov.py');

/** The route as the kit runs it on this PC's generation (npu-vendors.json): its server's command and its NPU settings. */
function kitRoute(o: Options) {
  const route = routeFor(pinnedRoute(NPU_CATALOG.routes.intel, o.generation), o.generation);
  const flag = (name: string) => {
    const i = route.serve.indexOf(name);
    return i >= 0 ? route.serve[i + 1] : null;
  };
  const plugin = JSON.parse(flag('--plugin_config') ?? '{}') as Record<string, string>;
  return { route, maxPromptLen: Number(flag('--max_prompt_len') ?? 1024), plugin };
}

/** The pipeline's properties on a device: on the NPU the kit's own (its prompt size and plugin settings), and a compile cache of the test's own. */
function propsFor(o: Options, device: string, cache: string): string[] {
  const own = [`CACHE_DIR=${cache}`];
  if (device === 'NPU') {
    const k = kitRoute(o);
    return [`MAX_PROMPT_LEN=${k.maxPromptLen}`, ...Object.entries(k.plugin).map(([key, v]) => `${key}=${v}`), ...own, ...o.props];
  }
  // The manor's cap for long processor work: 8 threads.
  if (device === 'CPU') return ['INFERENCE_NUM_THREADS=8', ...o.props];
  return [...own, ...o.props];
}

// ------------------------------------------------------------------------------------------------ the pipeline

interface Pipeline {
  name: string;
  device: string;
  child: ChildProcess;
  /** The Python process's own: a venv's python.exe starts its base interpreter as a child. */
  pid: number;
  loadMs: number;
  startedMs: number;
  ask: (m: Record<string, unknown>) => Promise<any>;
}

async function open(o: Options, name: string, device: string, loras: Lora[], o2: { cache?: string; props?: string[] } = {}): Promise<Pipeline> {
  const cache = o2.cache ?? path.join(o.out, 'ov-cache');
  const args = ['-I', '-X', 'utf8', worker, '--model', o.model, '--device', device, ...loras.flatMap((l) => ['--lora', `${l.name}=${l.file}`]), ...[...propsFor(o, device, cache), ...(o2.props ?? [])].flatMap((p) => ['--prop', p])];
  const log = path.join(o.out, `${name}.log`);
  const startedMs = performance.now();
  const child = spawn(o.python, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const logLines: string[] = [];
  const waiting: ((x: any) => void)[] = [];
  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
    for (const w of waiting.splice(0)) w({ error: `${name} exited (${exited}): ${log}` });
  });
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (l) => {
      if (l.startsWith('@@')) waiting.shift()?.(JSON.parse(l.slice(2)));
      else logLines.push(l);
    });
  }
  const next = () => new Promise<any>((r) => (exited !== null ? r({ error: `${name} exited (${exited})` }) : waiting.push(r)));
  const flush = () => writeFileSync(log, logLines.join('\n') + '\n');
  const ready = await next();
  flush();
  if (!ready.ready) {
    child.kill();
    throw new Error(`${name}: ${ready.error ?? 'no pipeline'}`);
  }
  const ask = async (m: Record<string, unknown>) => {
    const p = next();
    child.stdin!.write(`${JSON.stringify(m)}\n`);
    const r = await p;
    flush();
    if (r.error) throw new Error(`${name}: ${r.error}`);
    return r;
  };
  return { name, device, child, pid: ready.pid, loadMs: ready.loadMs, startedMs, ask };
}

async function close(p: Pipeline): Promise<void> {
  if (p.child.exitCode !== null) return;
  const gone = new Promise<void>((r) => p.child.once('exit', () => r()));
  p.child.stdin!.write('{"op":"quit"}\n');
  const quit = await Promise.race([gone.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 30_000))]);
  if (!quit) {
    try {
      execFileSync('taskkill', ['/PID', String(p.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      p.child.kill();
    }
    await gone;
  }
  // The pipeline's own process too, should the venv's launcher have gone first.
  await until(async () => !alive(p.pid), 20_000, `${p.name}: its process ${p.pid} is still running`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One block of work in the NPU's turn, its pipeline made and closed inside it. Off the NPU, no turn. */
async function withPipeline<T>(o: Options, name: string, device: string, loras: Lora[], fn: (p: Pipeline) => Promise<T>, o2: { cache?: string; props?: string[] } = {}): Promise<T> {
  const body = async () => {
    const p = await open(o, name, device, loras, o2);
    try {
      return await fn(p);
    } finally {
      await close(p);
    }
  };
  return device === 'NPU' ? withNpuTurn(npuLockDir, body, { lane: 'background', who: 'addon-test', doing: `add-on test: ${name}`.slice(0, 80), waitMs: 30 * 60_000, staleMs: 40 * 60_000 }) : body();
}

const gen = (p: Pipeline, messages: unknown[], maxNewTokens: number, lora: Lora | null, extra: Record<string, unknown> = {}) =>
  p.ask({ op: 'generate', messages, max_new_tokens: maxNewTokens, adapter: lora?.name ?? null, alpha: lora?.alpha ?? 0, ...extra });

/** Another pipeline in the pipeline's process (addon_ov.py's open), which a request names as its `pipe`. */
const openIn = async (p: Pipeline, id: string, loras: Lora[], props: string[] = []) => (await p.ask({ op: 'open', id, lora: loras.map((l) => `${l.name}=${l.file}`), prop: props })).loadMs as number;
const closeIn = async (p: Pipeline, id: string) => (await p.ask({ op: 'close', id })).ms as number;

const mb = (m: Memory) => ({ workingSetMb: Math.round(m.workingSetMb), privateMb: Math.round(m.privateMb), npuMb: m.npuMb === null ? null : Math.round(m.npuMb), availableMb: Math.round(m.availableMb) });

// ------------------------------------------------------------------------------------------------ answers and odds

async function names(p: Pipeline, lora: Lora | null, pipe?: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of DOCS) out.push((await gen(p, namePrompt(d.file, d.how, d.text), 60, lora, { pipe })).text);
  return out;
}

const nameOf = (text: string) => text.match(/NAME:\s*(.+)/)?.[1]?.trim() ?? text.split('\n')[0].trim();
const folderOf = (text: string) => text.match(/FOLDER:\s*(?:\d+\.?\s*)?(.+)/)?.[1]?.trim() ?? '';

async function answersPhase(o: Options, results: any): Promise<void> {
  results.answers = {};
  for (const l of o.loras) {
    const by: Record<string, { off: string[]; on: string[] }> = {};
    for (const device of o.devices) {
      try {
        by[device] = await withPipeline(o, `answers-${l.name}-${device}`, device, [l], async (p) => ({ off: await names(p, null), on: await names(p, l) }));
      } catch (e) {
        by[device] = { error: String(e) } as any;
        say(`answers ${l.name} ${device}: ${String(e)}`);
      }
    }
    const ref = by.CPU;
    const against: Record<string, unknown> = {};
    for (const [device, r] of Object.entries(by)) {
      if (device === 'CPU' || !ref?.on || !r.on) continue;
      const same = (a: string[], b: string[]) => a.filter((x, i) => x === b[i]).length;
      against[device] = {
        offSame: same(r.off, ref.off),
        onSame: same(r.on, ref.on),
        onSameName: same(r.on.map(nameOf), ref.on.map(nameOf)),
        onSameFolder: same(r.on.map(folderOf), ref.on.map(folderOf)),
        changedByAddon: r.on.filter((x, i) => nameOf(x) !== nameOf(r.off[i])).length,
        of: DOCS.length,
      };
    }
    results.answers[l.name] = { by, againstProcessor: against, processorChangedByAddon: ref?.on ? ref.on.filter((x, i) => nameOf(x) !== nameOf(ref.off[i])).length : null };
    say(`answers ${l.name}: ${JSON.stringify(against)}`);
  }
}

type Odds = Record<string, number>;

/**
 * As addon-test's odds phase: `follows` is how much of the processor's change to the name's first token the NPU makes
 * (the least-squares slope over the tokens both saw: 1 is all of it), `apart` the mean gap between their changes against
 * `baseApart` (the two without the add-on: the NPU's own rounding), `offAgain` the largest move of an odds between off
 * before and off after an on (0: an add-on switched off leaves nothing behind).
 */
async function oddsPhase(o: Options, results: any): Promise<void> {
  results.odds = { samples: o.samples, topK: o.topK, loras: {} };
  for (const l of o.loras) {
    const run = (device: string) =>
      withPipeline(o, `odds-${l.name}-${device}`, device, [l], async (p) => {
        const rows: { off: Odds; on: Odds; offAgain: Odds }[] = [];
        const one = async (d: (typeof DOCS)[number], lora: Lora | null) =>
          (await p.ask({ op: 'odds', messages: namePrompt(d.file, d.how, d.text), prefix: 'NAME:', adapter: lora?.name ?? null, alpha: lora?.alpha ?? 0, samples: o.samples, top_k: o.topK })).odds as Odds;
        for (const d of DOCS) {
          const off = await one(d, null);
          const on = await one(d, l);
          rows.push({ off, on, offAgain: await one(d, null) });
        }
        return rows;
      });
    let npu: Awaited<ReturnType<typeof run>>;
    let cpu: Awaited<ReturnType<typeof run>>;
    try {
      npu = await run('NPU');
      cpu = await run('CPU');
    } catch (e) {
      results.odds.loras[l.name] = { error: String(e) };
      say(`odds ${l.name}: ${String(e)}`);
      continue;
    }
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
      for (const tok of Object.keys(n.off)) if (tok in n.offAgain) offAgain = Math.max(offAgain, Math.abs(n.offAgain[tok] - n.off[tok]));
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const top = (x: Odds) => Object.entries(x).sort((a, b) => b[1] - a[1])[0]?.[0];
    const summary = {
      follows: sxx > 0 ? sxy / sxx : null,
      apart: mean(apart),
      baseApart: mean(baseApart),
      processorChange: mean(cpu.flatMap((c) => Object.keys(c.off).filter((t) => t in c.on).map((t) => Math.abs(c.on[t] - c.off[t])))),
      offAgain,
      tokens: apart.length,
      sameTopOn: cpu.filter((c, i) => top(c.on) === top(npu[i].on)).length,
      sameTopOff: cpu.filter((c, i) => top(c.off) === top(npu[i].off)).length,
    };
    results.odds.loras[l.name] = { summary, npu, cpu };
    say(`odds ${l.name}: ${JSON.stringify(summary)}`);
  }
}

// ------------------------------------------------------------------------------------------------ speed and switching

interface SpeedRow {
  variant: string;
  device: string;
  readTps: number;
  genTps: number;
  nameWallMs: number;
  nameTtftMs: number;
  cpuSecondsPerGenToken: number;
  memory: { loaded: ReturnType<typeof mb>; afterChat: ReturnType<typeof mb> };
  loadMs: number;
}

async function speedOf(p: Pipeline, o: Options, variant: string, lora: Lora | null): Promise<SpeedRow> {
  const loaded = mb(memoryOf(p.pid));
  await gen(p, [{ role: 'user', content: 'Hi' }], 2, lora);
  const reads: number[] = [];
  const gens: number[] = [];
  const walls: number[] = [];
  const ttfts: number[] = [];
  let cpu = 0;
  let written = 0;
  for (let r = 0; r < o.runs; r++) {
    const read = await gen(p, [{ role: 'system', content: 'You count lines.' }, { role: 'user', content: readPromptOf(1500, `${variant}-${r}`) }], 8, lora);
    reads.push((read.inputTokens * 1000) / read.ttftMs);
    const c0 = memoryOf(p.pid).cpuSeconds;
    const g = await gen(p, [{ role: 'system', content: 'You write stories.' }, { role: 'user', content: `[${variant}-${r}] Write a long story, at least 400 words, about a steward who keeps a manor's cellar.` }], 128, lora, { ignore_eos: true });
    cpu += memoryOf(p.pid).cpuSeconds - c0;
    written += g.outputTokens;
    gens.push(1000 / g.tpotMs);
    for (const d of DOCS.slice(0, 3)) {
      const t = await gen(p, namePrompt(d.file, d.how, d.text), 60, lora);
      walls.push(t.wallMs);
      ttfts.push(t.ttftMs);
    }
  }
  return { variant, device: p.device, readTps: round(median(reads)), genTps: round(median(gens), 1), nameWallMs: round(median(walls)), nameTtftMs: round(median(ttfts)), cpuSecondsPerGenToken: round(cpu / Math.max(1, written), 4), memory: { loaded, afterChat: mb(memoryOf(p.pid)) }, loadMs: round(p.loadMs) };
}

async function speedPhase(o: Options, results: any): Promise<void> {
  results.speed = results.speed ?? {};
  for (const device of o.devices) {
    const rows: SpeedRow[] = [];
    try {
      rows.push(await withPipeline(o, `speed-none-${device}`, device, [], (p) => speedOf(p, o, 'no add-on', null)));
      for (const l of o.loras) {
        rows.push(
          ...(await withPipeline(o, `speed-${l.name}-${device}`, device, [l], async (p) => [await speedOf(p, o, `${l.name}, loaded and off`, null), await speedOf(p, o, `${l.name}, on`, l)])),
        );
      }
    } catch (e) {
      say(`speed ${device}: ${String(e)}`);
      rows.push({ variant: 'error', device, error: String(e) } as any);
    }
    results.speed[device] = rows;
    for (const r of rows) say(`speed ${device} ${r.variant}: reads ${r.readTps} t/s, writes ${r.genTps} t/s, name ${r.nameWallMs} ms (first token ${r.nameTtftMs} ms), ${r.cpuSecondsPerGenToken} cpu s a token written; WS ${r.memory?.afterChat.workingSetMb} MB, NPU ${r.memory?.afterChat.npuMb} MB`);
  }
}

/** A request's time when its add-on differs from the request before's, against the same again: GenAI applies a request's add-on as it starts (NPUW copies it into the NPU's inputs). */
async function switchPhase(o: Options, results: any): Promise<void> {
  results.switch = {};
  for (const l of o.loras) {
    results.switch[l.name] = await withPipeline(o, `switch-${l.name}-NPU`, 'NPU', [l], async (p) => {
      const rows: { doc: string; step: string; ttftMs: number; wallMs: number; text: string }[] = [];
      const steps: [string, Lora | null][] = [['off', null], ['on, switched', l], ['on, again', l], ['off, switched', null], ['off, again', null]];
      for (const d of DOCS.slice(0, 4)) {
        for (const [step, lora] of steps) {
          const t = await gen(p, namePrompt(d.file, d.how, d.text), 60, lora);
          rows.push({ doc: d.file, step, ttftMs: round(t.ttftMs), wallMs: round(t.wallMs), text: t.text });
        }
      }
      const by = (k: string) => rows.filter((r) => r.step === k);
      const summary = Object.fromEntries(['on, switched', 'on, again', 'off, switched', 'off, again'].map((k) => [k, { ttftMs: round(median(by(k).map((r) => r.ttftMs))), wallMs: round(median(by(k).map((r) => r.wallMs))) }]));
      const sameOff = DOCS.slice(0, 4).filter((d) => new Set(rows.filter((r) => r.doc === d.file && r.step.startsWith('off')).map((r) => r.text)).size === 1).length;
      return { summary, offAnswersAllSame: `${sameOff} of 4`, rows };
    });
    say(`switch ${l.name}: ${JSON.stringify(results.switch[l.name].summary)}; off answers the same before and after: ${results.switch[l.name].offAnswersAllSame}`);
  }
}

// ------------------------------------------------------------------------------------------------ swapping and pairing pipelines

/**
 * A pipeline with an add-on loaded makes every request slower, the add-on on or off (NPUW compiles the add-on's branch in).
 * One way out: the base's pipeline alone, as today, and the add-on's in its place only while the line runs a batch of
 * add-on jobs, then the base's again. In one process, as a server of the kit's own would, from a full compile cache: a
 * batch of the 8 names, with a chat arriving after the fourth (the base's pipeline back for it, then the add-on's again).
 * A swap's time runs from closing the one pipeline to the other's first token.
 */
async function swapPhase(o: Options, results: any): Promise<void> {
  results.swap = {};
  for (const l of o.loras) {
    try {
      results.swap[l.name] = await withPipeline(o, `swap-${l.name}`, 'NPU', [], async (p) => {
        // Both pipelines in the cache first: the add-on's once, made and closed.
        const warmOpenMs = await openIn(p, 'addon', [l]);
        await closeIn(p, 'addon');
        const memory: Record<string, ReturnType<typeof mb>> = { base: mb(memoryOf(p.pid)) };
        const baseBefore = await names(p, null);
        const swaps: { way: string; closeMs: number; openMs: number; firstTokenMs: number; toFirstTokenMs: number }[] = [];
        const swap = async (way: string, from: string, to: string, loras: Lora[], first: () => Promise<{ ttftMs: number }>) => {
          const t = performance.now();
          const closeMs = await closeIn(p, from);
          const openMs = await openIn(p, to, loras);
          const r = await first();
          swaps.push({ way, closeMs: round(closeMs), openMs: round(openMs), firstTokenMs: round(r.ttftMs), toFirstTokenMs: round(closeMs + openMs + r.ttftMs) });
        };
        const jobs: { doc: string; wallMs: number; text: string }[] = [];
        const job = async (d: (typeof DOCS)[number]) => {
          const t = await gen(p, namePrompt(d.file, d.how, d.text), 60, l, { pipe: 'addon' });
          jobs.push({ doc: d.file, wallMs: round(t.wallMs), text: t.text });
          return t;
        };
        await swap('to the add-on', 'main', 'addon', [l], () => job(DOCS[0]));
        memory.addon = mb(memoryOf(p.pid));
        for (const d of DOCS.slice(1, 4)) await job(d);
        let chat: any = null;
        await swap('to the base, for a chat', 'addon', 'main', [], async () => (chat = await gen(p, [{ role: 'user', content: 'Hello! In one sentence, what can you help me with?' }], 32, null)));
        await swap('to the add-on, again', 'main', 'addon', [l], () => job(DOCS[4]));
        for (const d of DOCS.slice(5)) await job(d);
        const after: string[] = [];
        await swap('to the base', 'addon', 'main', [], async () => {
          const t = await gen(p, namePrompt(DOCS[0].file, DOCS[0].how, DOCS[0].text), 60, null);
          after.push(t.text);
          return t;
        });
        for (const d of DOCS.slice(1)) after.push((await gen(p, namePrompt(d.file, d.how, d.text), 60, null)).text);
        memory.baseAgain = mb(memoryOf(p.pid));
        const jobMs = median(jobs.map((j) => j.wallMs));
        const backMs = median(swaps.filter((s) => s.way.startsWith('to the base')).map((s) => s.toFirstTokenMs));
        return {
          warmOpenMs: round(warmOpenMs),
          swaps,
          toAddonMs: round(median(swaps.filter((s) => s.way.startsWith('to the add-on')).map((s) => s.toFirstTokenMs))),
          toBaseMs: round(backMs),
          jobMs: round(jobMs),
          // A chat arriving mid-batch waits for the job under way (none of it to all of it), then the base's pipeline back.
          chatWaitMs: { jobEnding: round(backMs), jobStarting: round(backMs + jobMs), measured: swaps[1].toFirstTokenMs, chatText: chat?.text ?? null },
          baseSameAfter: `${after.filter((x, i) => x === baseBefore[i]).length} of ${DOCS.length}`,
          memory,
          jobs,
          baseBefore,
          baseAfter: after,
        };
      });
      const r = results.swap[l.name];
      say(`swap ${l.name}: to the add-on ${r.toAddonMs} ms, to the base ${r.toBaseMs} ms (to the first token, from the cache); a job ${r.jobMs} ms; a chat mid-batch waits ${r.chatWaitMs.jobEnding}-${r.chatWaitMs.jobStarting} ms; the base the same after: ${r.baseSameAfter}; NPU ${r.memory.base.npuMb} / ${r.memory.addon.npuMb} / ${r.memory.baseAgain.npuMb} MB`);
    } catch (e) {
      results.swap[l.name] = { error: String(e) };
      say(`swap ${l.name}: ${String(e)}`);
    }
  }
}

/**
 * The other way out: the base's pipeline and the add-on's side by side in one process, the add-on's requests to its own.
 * NPUW keeps a model's weights in a bank and shares a tensor between models whose bank has the same name
 * (NPUW_WEIGHTS_BANK; each model gets a name of its own otherwise), so the pair runs twice: own banks, then one shared.
 */
async function bankPhase(o: Options, results: any): Promise<void> {
  results.bank = {};
  const l = o.loras[0];
  for (const shared of [false, true]) {
    const key = shared ? 'shared bank' : 'own banks';
    const props = shared ? ['NPUW_WEIGHTS_BANK=castellan-addon-test'] : [];
    try {
      results.bank[key] = await withPipeline(o, `bank-${shared ? 'shared' : 'own'}`, 'NPU', [], async (p) => {
        const warmOpenMs = await openIn(p, 'addon', [l], props);
        await closeIn(p, 'addon');
        const alone = mb(memoryOf(p.pid));
        const baseAlone = await names(p, null);
        const speedAlone = await speedOf(p, o, 'the base alone', null);
        const openMs = await openIn(p, 'addon', [l], props);
        const paired = mb(memoryOf(p.pid));
        const addonNames = await names(p, l, 'addon');
        const baseBeside = await names(p, null);
        const speedBeside = await speedOf(p, o, 'the base beside the add-on', null);
        return {
          props,
          baseLoadMs: round(p.loadMs),
          warmOpenMs: round(warmOpenMs),
          openMs: round(openMs),
          memory: { alone, paired, afterUse: mb(memoryOf(p.pid)) },
          addedNpuMb: paired.npuMb !== null && alone.npuMb !== null ? paired.npuMb - alone.npuMb : null,
          addedWorkingSetMb: paired.workingSetMb - alone.workingSetMb,
          baseSameBeside: `${baseBeside.filter((x, i) => x === baseAlone[i]).length} of ${DOCS.length}`,
          speedAlone,
          speedBeside,
          addonNames,
          baseAlone,
        };
      }, { props });
      const r = results.bank[key];
      say(`bank, ${key}: the add-on's pipeline beside the base adds NPU ${r.addedNpuMb} MB, WS ${r.addedWorkingSetMb} MB (open ${r.openMs} ms); the base writes ${r.speedAlone.genTps} -> ${r.speedBeside.genTps} t/s beside it, reads ${r.speedAlone.readTps} -> ${r.speedBeside.readTps}; the base's names the same: ${r.baseSameBeside}`);
    } catch (e) {
      results.bank[key] = { error: String(e) };
      say(`bank, ${key}: ${String(e)}`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ cold starts and memory

/** Making the pipeline with an empty compile cache, then again with it full, and each one's first answer: with no add-on, and with each. */
async function coldPhase(o: Options, results: any): Promise<void> {
  results.cold = {};
  const d = DOCS[0];
  for (const set of [[], ...o.loras.map((l) => [l])] as Lora[][]) {
    const name = set[0]?.name ?? 'none';
    const cache = path.join(o.out, `cold-cache-${name}`);
    rmSync(cache, { recursive: true, force: true });
    const row: Record<string, unknown> = {};
    for (const run of ['empty cache', 'full cache']) {
      row[run] = await withPipeline(o, `cold-${name}-${run.replace(' ', '-')}`, 'NPU', set, async (p) => {
        const t = await gen(p, namePrompt(d.file, d.how, d.text), 60, set[0] ?? null);
        return { loadMs: round(p.loadMs), firstAnswerMs: round(t.wallMs), toFirstAnswerMs: round(performance.now() - p.startedMs), memory: mb(memoryOf(p.pid)) };
      }, { cache });
    }
    row.cacheMb = round(dirMb(cache));
    results.cold[name] = row;
    say(`cold ${name}: ${JSON.stringify(row)}`);
  }
}

function dirMb(dir: string): number {
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) bytes += statSync(path.join(e.parentPath, e.name)).size;
  return bytes / 2 ** 20;
}

/** What each pipeline holds on the NPU and of the PC: loaded, after the Warrener's names, after a long prompt. */
async function memoryPhase(o: Options, results: any): Promise<void> {
  results.memory = {};
  for (const set of [[], ...o.loras.map((l) => [l])] as Lora[][]) {
    const name = set[0]?.name ?? 'none';
    results.memory[name] = await withPipeline(o, `memory-${name}`, 'NPU', set, async (p) => {
      const loaded = mb(memoryOf(p.pid));
      await names(p, set[0] ?? null);
      const named = mb(memoryOf(p.pid));
      await gen(p, [{ role: 'user', content: readPromptOf(1800, `memory-${name}`) }], 8, set[0] ?? null);
      return { loaded, named, longPrompt: mb(memoryOf(p.pid)) };
    });
    say(`memory ${name}: ${JSON.stringify(results.memory[name])}`);
  }
}

// ------------------------------------------------------------------------------------------------ against OpenVINO Model Server

/** A copy of the model's folder made of hard links, without its graph.pbtxt: OpenVINO Model Server writes one at its start. */
function linkedRepo(o: Options): { repo: string; id: string } {
  const id = `${path.basename(path.dirname(o.model))}/${path.basename(o.model)}`;
  const repo = path.join(o.out, 'ovms-repo');
  const into = path.join(repo, ...id.split('/'));
  mkdirSync(into, { recursive: true });
  for (const f of readdirSync(o.model)) {
    if (f === 'graph.pbtxt' || !statSync(path.join(o.model, f)).isFile() || existsSync(path.join(into, f))) continue;
    linkSync(path.join(o.model, f), path.join(into, f));
  }
  return { repo, id };
}

/** The 24 quality items and 4 pictures through a pipeline, as qualityAndPictures asks them of a server. */
async function qualityAndPicturesOf(p: Pipeline, dir: string) {
  const quality: { id: string; pass: boolean; mustPass: boolean; answer: string }[] = [];
  for (const q of SUITE.quality) {
    const a = (await gen(p, [{ role: 'user', content: promptOf(SUITE, q) }], q.maxTokens, null)).text;
    quality.push({ id: q.id, pass: grade(q.grade, a), mustPass: !!q.mustPass, answer: a.slice(0, 200) });
  }
  const pictures: { id: string; pass: boolean; ms: number; answer: string }[] = [];
  for (const v of SUITE.vision) {
    const file = path.join(dir, `${v.id}.png`);
    writeFileSync(file, picturePng(v.image));
    const t = await gen(p, [{ role: 'system', content: 'You answer questions about images briefly and literally.' }, { role: 'user', content: `<ov_genai_image_0>${v.prompt}` }], v.maxTokens, null, { images: [file] });
    pictures.push({ id: v.id, pass: grade(v.grade, t.text), ms: round(t.wallMs), answer: t.text.slice(0, 120) });
  }
  return { quality, pictures };
}

async function ovmsPhase(o: Options, results: any): Promise<void> {
  const dir = path.join(o.out, 'pictures');
  mkdirSync(dir, { recursive: true });
  results.routes = {};
  // GenAI directly, no add-on: the pipeline OpenVINO Model Server runs on the NPU, at the same settings.
  results.routes.genai = await withPipeline(o, 'route-genai', 'NPU', [], async (p) => {
    const first = await gen(p, [{ role: 'user', content: 'Hello' }], 4, null);
    const firstAnswerMs = performance.now() - p.startedMs;
    const loaded = mb(memoryOf(p.pid));
    const reads: number[] = [];
    const gens: number[] = [];
    const walls: number[] = [];
    for (let r = 0; r < o.runs; r++) {
      const read = await gen(p, [{ role: 'system', content: 'You count lines.' }, { role: 'user', content: readPromptOf(1500, `route-${r}`) }], 8, null);
      reads.push((read.inputTokens * 1000) / read.ttftMs);
      const g = await gen(p, [{ role: 'system', content: 'You write stories.' }, { role: 'user', content: `[route-${r}] Write a long story, at least 400 words, about a steward who keeps a manor's cellar.` }], 128, null);
      gens.push(1000 / g.tpotMs);
      for (const d of DOCS.slice(0, 3)) walls.push((await gen(p, namePrompt(d.file, d.how, d.text), 60, null)).wallMs);
    }
    const afterChat = mb(memoryOf(p.pid));
    const qp = await qualityAndPicturesOf(p, dir);
    return { loadMs: round(p.loadMs), firstAnswerMs: round(firstAnswerMs), firstText: first.text, readTps: round(median(reads)), genTps: round(median(gens), 1), nameWallMs: round(median(walls)), ...qp, memory: { loaded, afterChat, afterPictures: mb(memoryOf(p.pid)) } };
  });
  report('genai', results.routes.genai);
  if (!o.ovms) return;
  // OpenVINO Model Server with the kit's command for this generation, on a private port, from a linked copy of the model.
  const k = kitRoute(o);
  const { repo, id } = linkedRepo(o);
  const tools = path.join(o.out, 'ovms-tools');
  const e = npuEntry(k.route, { tools, exe: o.ovms, port: o.port });
  const cmd = [...e.chat!.startCommand!].map((a) => a.replace(path.join(tools, 'models', 'openvino', '.npu-cache'), path.join(o.out, 'ovms-cache')).replace(path.join(tools, 'models', 'openvino'), repo));
  cmd[0] = o.ovms;
  const ovmsDir = path.dirname(o.ovms);
  const env = Object.fromEntries(Object.entries(e.chat!.env ?? {}).map(([key, v]) => [key, v.replaceAll(path.join(tools, 'servers', path.basename(ovmsDir)), ovmsDir)]));
  results.routes.ovms = await withNpuTurn(npuLockDir, async () => {
    const base = `http://127.0.0.1:${o.port}`;
    if ((await answersAt(`${base}/v1/config`, 1000)) !== null) throw new Error(`something already answers on ${base}`);
    const log = path.join(o.out, 'route-ovms.log');
    const t0 = performance.now();
    const child = spawn(cmd[0], cmd.slice(1), { cwd: ovmsDir, env: { ...process.env, ...env, PATH: `${env.PATH?.replace('%PATH%', process.env.PATH ?? '') ?? process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const lines: string[] = [];
    child.stdout!.on('data', (b) => lines.push(String(b)));
    child.stderr!.on('data', (b) => lines.push(String(b)));
    try {
      // Up when its REST port answers; loaded when its first chat does (it answers 404 for the model until then).
      await until(async () => {
        if (child.exitCode !== null) throw new Error(`ovms exited (${child.exitCode}): ${log}`);
        return (await answersAt(`${base}/v1/config`, 2000)) !== null;
      }, 300_000, `ovms didn't answer within 300 s: ${log}`);
      const readyMs = performance.now() - t0;
      let first: Awaited<ReturnType<typeof post>> | null = null;
      await until(async () => {
        if (child.exitCode !== null) throw new Error(`ovms exited (${child.exitCode}): ${log}`);
        try {
          first = await post(`${base}/v1/chat/completions`, { model: id, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 4, temperature: 0 }, 300_000);
        } catch {
          return false;
        }
        return first.status === 200;
      }, 300_000, `ovms didn't answer a chat within 300 s: ${log}`, 1000);
      const firstAnswerMs = performance.now() - t0;
      const loaded = mb(memoryOf(child.pid!));
      const sp = await routeSpeed(base, id, false, o.runs);
      const afterChat = mb(memoryOf(child.pid!));
      const qp = await qualityAndPictures(base, id, false, false, dir);
      return { command: cmd, readyMs: round(readyMs), firstAnswerMs: round(firstAnswerMs), firstStatus: (first as { status: number } | null)?.status ?? null, readTps: round(sp.readTps), genTps: round(sp.genTps, 1), nameWallMs: round(sp.nameWallMs), ...qp, memory: { loaded, afterChat, afterPictures: mb(memoryOf(child.pid!)) } };
    } finally {
      writeFileSync(log, lines.join(''));
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // gone already
      }
      await until(async () => (await answersAt(`${base}/v1/config`, 500)) === null, 30_000, 'ovms still answers after it was stopped');
    }
  }, { lane: 'background', who: 'addon-test', doing: 'add-on test: the kit route (OpenVINO Model Server)', waitMs: 30 * 60_000, staleMs: 40 * 60_000 });
  report('ovms', results.routes.ovms);
}

function report(name: string, r: any): void {
  say(`${name} route: reads ${r.readTps} t/s, writes ${r.genTps} t/s, name ${r.nameWallMs} ms; quality ${r.quality.filter((x: any) => x.pass).length}/${r.quality.length}, pictures ${r.pictures.filter((x: any) => x.pass).length}/${r.pictures.length}; first answer ${r.firstAnswerMs} ms; NPU ${r.memory.afterPictures.npuMb} MB, WS ${r.memory.afterPictures.workingSetMb} MB`);
}

// ------------------------------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, 'results.json');
  const results: any = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  results.pc = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: round(os.totalmem() / 2 ** 30, 1), generation: o.generation, at: new Date().toISOString() };
  results.options = { ...o, phases: [...o.phases] };
  results.npuProps = propsFor(o, 'NPU', path.join(o.out, 'ov-cache'));
  const save = () => writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
  const phases: [string, (o: Options, r: any) => Promise<void>][] = [['answers', answersPhase], ['odds', oddsPhase], ['speed', speedPhase], ['switch', switchPhase], ['swap', swapPhase], ['bank', bankPhase], ['cold', coldPhase], ['memory', memoryPhase], ['ovms', ovmsPhase]];
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
