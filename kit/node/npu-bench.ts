import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { type Accelerator, type AcceleratorEntry, type Quirk, readAccelerator, toolsHome } from './accelerator-config.ts';
import { type Detection, detect, type GpuCard, runPowerShell } from './detect.ts';
import { checkSchema } from './json-schema.ts';
import { portFree, routeOnDevice, routeOnFreePorts } from './npu-check.ts';
import { patchTarget } from './npu-patch.ts';
import { longFetch, processMemory, refusedConnection, type RunningServer, serverClient, setUpRoute, startServer, type Streamed } from './npu-server.ts';
import { atVersion, expandRoute, generationOf, installedVersion, NPU_CATALOG, type NpuCatalog, type NpuModel, type NpuRoute, type NpuSupport, type NpuVendor, NPU_VENDORS, pciDevice, pinnedRoute, planNpu, playedRoute, playedSay, playGeneration, pluginPatchOf, routeFor, serverExe, setUpPlayed, sha256File, smallPc } from './npu-vendors.ts';
import { charging, joules, measureSpan, type Meter, type MeterIo, openMeter, partsSay, type Span, watts } from './power-meter.ts';
import { acceleratorEntry, assetName, type Download, download, LLAMA_PIN, listDevices, matchDevice, mb, MODEL_PINS, MODEL_SPECS, type NpuIo, parseListDevices, pinnedModelUrl, saysReady, SIGNED_LLAMA_REPO, unpack, variantFor } from './setup.ts';
import { mixSummary, readTally } from './token-tally.ts';

/**
 * The NPU benchmark (spec/NPU-BENCHMARK.md): a fixed, versioned suite (spec/npu-bench-suite.json), the same on every
 * PC, that measures how fast and how well a chip does Castellan's work with a model, for the website's boards. It sets
 * the route up as the NPU check does (without writing config.json), streams every request so reading and writing are
 * timed apart, grades the answers, records the conditions it ran in, and writes one report in a fixed format
 * (spec/npu-bench.schema.json). A run that doesn't meet the conditions is still reported, with marks saying why it
 * isn't ranked.
 *
 *   node <agent>\src\kit\npu-bench.ts [--profile quick|full] [--device NPU|GPU|CPU[,...]] [--runs <n>] [--model <id>]
 *                                     [--candidate <id> [--vision]] [--cap <tokens>] [--generation <id>] [--small-pc] [--energy]
 *                                     [--meter auto|emi|shelly:<address>|nvidia|battery] [--yes] [--no-setup] [--out <file>]
 *   node <agent>\src\kit\npu-bench.ts --summary <report.json> [<report.json> ...]
 *
 * Off the NPU (--device GPU or CPU), a route whose server has a device to choose (OpenVINO Model Server's) runs there; one
 * whose server runs on the NPU only (GenieX, FastFlowLM) runs the same model on llama.cpp instead (kit 2.99.0: the
 * route's offNpu, npu-vendors.ts' NpuOffNpu), the build setup pins, on the graphics card of the NPU's maker or on the
 * processor. Several devices (--device NPU,GPU,CPU) and --runs run in turn, each device once a round, and end with a
 * summary of each device's medians (benchSummary); --summary makes one from reports already written.
 *
 * It measures the models setup would run on this PC: its generation's own, where it has any (a Snapdragon X2's
 * Qwen3-VL-2B), and on one with little memory (under idleStop.smallPcGb) its generation's smallPc models, where it has
 * any (none now). `--small-pc` measures those on a bigger PC. `--model` measures any of them, or one of the route's own:
 * `--model qualcomm/Qwen3-VL-4B-Instruct:W4A16` the 4B on an X2.
 *
 * `--generation snapdragon-x` on a Snapdragon X2 plays the older chip (npu-vendors.ts' playGeneration): AI Hub's X Elite
 * build and Hexagon v73 code on this NPU. Its report says so (`run.played`), and it is never ranked.
 */

// ------------------------------------------------------------------------------------------------
// The suite

export type Grade = { regex: string; flags?: string } | { number: number } | { json: Record<string, unknown> } | { all: Grade[] } | { any: Grade[] };

export interface SuiteItem {
  id: string;
  prompt: string;
  maxTokens: number;
  grade: Grade;
  kind?: 'instruction' | 'find' | 'json' | 'reasoning';
  mustPass?: boolean;
  doc?: string;
  insert?: { at: 'start' | 'middle' | 'end'; text: string };
}

export interface ImageSpec {
  solid?: [number, number, number];
  halves?: [[number, number, number], [number, number, number]];
  digits?: string;
  dots?: number;
  rgb?: [number, number, number];
  width?: number;
  height?: number;
}

export interface Suite {
  version: string;
  maxTokensAll: number;
  tries: { quick: number; full: number };
  warmups: number;
  steady: { maxSpread: number };
  /** `waitMinutes` (kit 2.99.0): how long a run waits for a busy processor to quiet down before it starts. */
  quiet: { cpuBusyMax: number; samples: number; everyMs: number; waitMinutes?: number };
  gate: { score: number; calibrated: boolean };
  holding: { minutes: number; job: string };
  /** `batch`: how many of each job, read and picture in each energy batch, by profile (kit 2.98.0). */
  energy: { restSeconds: number; settleSeconds?: number; settleMinutes?: number; loadMinutes: number; job: string; batch?: { quick: number; full: number } };
  short: { prompt: string; maxTokens: number; grade: Grade };
  write: { prompt: string; maxTokens: number };
  read: { sizes: number[]; capShare: number; maxTokens: number; question: string };
  /** Embeddings (kit 2.99.0): a query, and requests of `texts` texts of about `chars` characters each; `batch`, how many requests in its energy batch. */
  embed?: { query: string; texts: number; chars: number; batch: { quick: number; full: number } };
  documents: Record<string, string[]>;
  jobs: SuiteItem[];
  quality: SuiteItem[];
  vision: (SuiteItem & { image: ImageSpec })[];
}

export const SUITE: Suite = JSON.parse(readFileSync(new URL('./spec/npu-bench-suite.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
export const REPORT_SCHEMA = JSON.parse(readFileSync(new URL('./spec/npu-bench.schema.json', import.meta.url), 'utf8').replace(/^﻿/, ''));

/** An item's prompt, with its document in place (and the item's sentence inserted into it, where it has one). */
export function promptOf(suite: Suite, item: Pick<SuiteItem, 'prompt' | 'doc' | 'insert'>): string {
  if (!item.doc) return item.prompt;
  const lines = [...(suite.documents[item.doc] ?? [])];
  if (!lines.length) throw new Error(`the suite has no document "${item.doc}"`);
  if (item.insert) {
    const at = item.insert.at === 'start' ? 1 : item.insert.at === 'middle' ? Math.floor(lines.length / 2) : lines.length;
    lines.splice(at, 0, '', item.insert.text);
  }
  return item.prompt.replace('{doc}', lines.join('\n'));
}

/** A prompt of about `tokens` tokens (about four characters a token), numbered lines, then the suite's question. */
export function readPrompt(suite: Suite, tokens: number): string {
  const lines: string[] = [];
  for (let i = 1, chars = 0; chars < tokens * 4; i++) {
    const line = `Line ${i}: the steward counts the barrels in the cellar and writes the number down.`;
    lines.push(line);
    chars += line.length + 1;
  }
  return `${lines.join('\n')}\n\n${suite.read.question}`;
}

/**
 * One embedding request's texts (kit 2.99.0): `suite.embed.texts` of about `chars` characters each, each with the
 * request's tag first and a number of its own, so no two are the same and none was embedded before.
 */
export function embedTexts(suite: Suite, tag: string): string[] {
  const e = suite.embed!;
  return Array.from({ length: e.texts }, (_, t) => {
    const lines = [`[${tag}-${t + 1}]`];
    for (let i = 1, chars = lines[0].length; chars < e.chars; i++) {
      const line = `Note ${t + 1}.${i}: the steward counts the barrels in cellar ${t + 1} and writes the number in ledger ${i}.`;
      lines.push(line);
      chars += line.length + 1;
    }
    return lines.join('\n');
  });
}

/**
 * A prompt that shares no block with any request before it: a line of its own first. OpenVINO Model Server turns the
 * NPU's prefix caching on, which keeps every whole block of a prompt it has read (128 tokens on an NPU 3720), so a
 * prompt asked again, or one that starts as an earlier one did (readPrompt's lines all do), is mostly not read at all:
 * 512 tokens took 0.74 s asked again, against 2.26 s new (Core Ultra 5 225U, 2026-10-14). Every read and job is asked
 * this way, so its time is the whole prompt's, as an agent's new text is; GenieX's requests already start with a nonce.
 */
export function freshPrompt(prompt: string, tag: string): string {
  return `[${tag}]\n${prompt}`;
}

const firstJson = (s: string): any => {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
};
const same = (want: unknown, got: unknown): boolean => {
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => same(w, got[i]));
  if (typeof want === 'string') return typeof got === 'string' && got.trim().toLowerCase() === want.toLowerCase();
  return got === want;
};

/** Whether an answer passes its grade: a regular expression, a number (the first in the answer), JSON fields, all or any. */
export function grade(g: Grade, answer: string): boolean {
  const a = answer.trim();
  if ('all' in g) return g.all.every((x) => grade(x, a));
  if ('any' in g) return g.any.some((x) => grade(x, a));
  if ('regex' in g) return new RegExp(g.regex, g.flags).test(a);
  if ('number' in g) {
    const n = a.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/);
    return !!n && Math.abs(Number(n[0]) - g.number) < 1e-9;
  }
  const j = firstJson(a);
  return !!j && typeof j === 'object' && Object.entries(g.json).every(([k, v]) => same(v, j[k]));
}

// ------------------------------------------------------------------------------------------------
// The pictures, drawn here so the suite needs no files

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w: number, h: number, colour: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colour(x, y);
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Digits as 5×7 bitmaps.
const DIGITS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['10001', '10001', '10001', '11111', '00001', '00001', '00001'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

/** A suite picture as a `data:` URL: one colour, two halves, digits, or dots in a row. */
export function picture(spec: ImageSpec): string {
  return `data:image/png;base64,${picturePng(spec).toString('base64')}`;
}

/** A suite picture as a PNG file's bytes. */
export function picturePng(spec: ImageSpec): Buffer {
  const white: [number, number, number] = [255, 255, 255];
  let buf: Buffer;
  if (spec.digits) {
    const s = 24;
    const text = spec.digits;
    buf = png(text.length * 6 * s + s, 9 * s, (x, y) => {
      const cx = Math.floor((x - s) / s);
      const cy = Math.floor((y - s) / s);
      const d = Math.floor(cx / 6);
      const col = cx % 6;
      return d >= 0 && d < text.length && col < 5 && cy >= 0 && cy < 7 && DIGITS[text[d]]?.[cy][col] === '1' ? [0, 0, 0] : white;
    });
  } else if (spec.dots) {
    const n = spec.dots;
    const w = spec.width ?? 448;
    const h = spec.height ?? 224;
    const r = Math.min(h / 4, w / (n * 3));
    const centres = Array.from({ length: n }, (_, i) => [((i + 0.5) * w) / n, h / 2]);
    buf = png(w, h, (x, y) => (centres.some(([a, b]) => (x - a) ** 2 + (y - b) ** 2 < r * r) ? (spec.rgb ?? [0, 0, 0]) : white));
  } else if (spec.halves) {
    const w = spec.width ?? 320;
    buf = png(w, spec.height ?? 224, (x) => (x < w / 2 ? spec.halves![0] : spec.halves![1]));
  } else {
    buf = png(spec.width ?? 224, spec.height ?? 224, () => spec.solid ?? white);
  }
  return buf;
}

// ------------------------------------------------------------------------------------------------
// Measurements

/** Several tries of one measurement: each, the median, and the spread ((largest − smallest) / median). */
export interface Measure {
  tries: number[];
  median: number | null;
  spread: number | null;
  steady: boolean;
}

const medianOf = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function measure(tries: number[], maxSpread: number): Measure {
  const xs = tries.filter((x) => Number.isFinite(x));
  const median = medianOf(xs);
  if (median === null) return { tries, median: null, spread: null, steady: false };
  const spread = median > 0 ? Number(((Math.max(...xs) - Math.min(...xs)) / median).toFixed(3)) : 0;
  return { tries, median: Number(median.toFixed(2)), spread, steady: xs.length === tries.length && spread <= maxSpread };
}

/**
 * A job's tries. Each is a prompt the server hasn't seen, so each gets an answer of its own length, and a longer answer
 * takes longer to write without the server being any slower: the 4B's summaries on the X2 Elite took 3.3 to 4.3 s on a
 * quiet PC while its writing held within 1%, about 40 tokens' writing apart. So the median is of the whole times, what a person waits, and whether the tries are
 * steady is judged at one answer length (atAnswerLength): spreadAtLength, from each try's answer tokens and first-token time.
 */
export interface JobMeasure extends Measure {
  answerTokens: (number | null)[];
  firstTokenMs: (number | null)[];
  spreadAtLength: number | null;
}

/**
 * Each try's time with its writing (from its first token to its last) scaled to the tries' median answer length, so only
 * the server's speed, reading or writing, differs between them. A try without its token count or first-token time (a
 * server that doesn't stream or count tokens, marked so) or with a one-token answer is taken whole.
 */
export function atAnswerLength(tries: number[], answerTokens: (number | null)[], firstTokenMs: (number | null)[]): number[] {
  const usable = (i: number) => Number.isFinite(tries[i]) && typeof firstTokenMs[i] === 'number' && tries[i] >= firstTokenMs[i]! && (answerTokens[i] ?? 0) > 1;
  const n = medianOf(tries.flatMap((_, i) => (usable(i) ? [answerTokens[i]!] : [])));
  if (n === null) return tries;
  return tries.map((t, i) => (usable(i) ? firstTokenMs[i]! + ((t - firstTokenMs[i]!) * (n - 1)) / (answerTokens[i]! - 1) : t));
}

export function jobMeasure(tries: number[], answerTokens: (number | null)[], firstTokenMs: (number | null)[], maxSpread: number): JobMeasure {
  const atLength = measure(atAnswerLength(tries, answerTokens, firstTokenMs), maxSpread);
  return { ...measure(tries, maxSpread), answerTokens, firstTokenMs, spreadAtLength: atLength.spread, steady: atLength.steady };
}

/** One energy batch (kit 2.98.0): `count` of one job, read or picture, one after another, and what they took. */
export interface EnergyBatch {
  count: number;
  answered: number;
  seconds: number;
  tokens: number;
  /** Each part's energy over the batch, in mJ. */
  millijoules: Record<string, number>;
  /** Each part's, less what it draws at rest over as long: the work's own. */
  extraMillijoules: Record<string, number>;
  /** The whole PC's (the meter's `whole`) over rest, for one of them, and for a token. */
  millijoulesEach: number | null;
  millijoulesPerToken: number | null;
}

export interface Mark {
  /** quick, rehearsal, battery, busy, beside, standby, plugin, not-streamed, no-usage, noisy, gate, job-failed, setup, start */
  code: string;
  say: string;
}

export interface Conditions {
  onBattery: boolean | null;
  batteryPercent: number | null;
  /** Windows' power mode on the power source the run is on: best power efficiency, balanced, best performance, or its GUID. */
  powerMode: string | null;
  brightness: number | null;
  cpuBusyPercent: number | null;
  windowsBuild: string | null;
  make: string | null;
  model: string | null;
  /** The route's ports something else held at the start (kit 2.99.0: the keeper's own server, most likely), so the run took others. */
  beside?: number[];
  /** The run held the PC awake with its screen on (holdAwake: --energy, kit 2.99.0). */
  awake?: boolean;
  /** How many times the PC went into Modern Standby during a run held awake (standbyCount), null where Windows' log couldn't be read. */
  standby?: number | null;
}

export interface BenchReport {
  format: 'castellan-npu-bench-report/1';
  suite: { version: string; kit: string; profile: 'quick' | 'full'; gate: Suite['gate'] };
  at: string;
  pc: { cpu: string | null; chip: string | null; npu: string | null; pciDevice: string | null; driver: string | null; driverDate: string | null; ramGb: number; windowsBuild: string | null; make: string | null; model: string | null };
  conditions: Conditions;
  run: {
    vendor: NpuVendor | null;
    device: string;
    server: string | null;
    model: string | null;
    candidate: boolean;
    cap: number | null;
    files: Record<string, { size: number; sha256: string }> | null;
    streamed: boolean | null;
    usageReported: boolean | null;
    /** The older Snapdragon's generation this NPU played (--generation), only on a played run: never ranked. */
    played?: string;
    /**
     * Which build of the server's plugin ran, where the kit has its own for this PC (kit 2.99.0: npu-vendors.ts'
     * NpuPluginPatch): `kit`, the kit's, in place already; `kit-copy`, the kit's, in a copy of the server (kitPlugin);
     * `server`, the server's own (marked: not what the kit runs); `other`, neither (a server update, left as it is).
     */
    plugin?: 'kit' | 'kit-copy' | 'server' | 'other';
  };
  results: {
    coldLoadMs: number | null;
    cachedLoadMs: number | null;
    short: Measure | null;
    writeTokensPerSecond: Measure | null;
    readFirstTokenMs: Record<string, Measure>;
    readAtCap: { promptTokens: number | null; firstTokenMs: number | null } | null;
    jobs: Record<string, JobMeasure & { passed: number }>;
    jobTimeS: number | null;
    memory: { workingSetBytes: number; privateBytes: number } | null;
    holding: { minutes: number; firstMinuteMs: number | null; lastMinuteMs: number | null; held: number | null } | null;
    /**
     * Embeddings (kit 2.99.0), on their own server once the chat server has stopped: its first vector after a start, a
     * query's time, and a request of the suite's texts (embedTexts): its time, its tokens, and the tokens a second.
     * Absent from reports before it; null where the run had no embedding server (FastFlowLM's NPU route has none).
     */
    embed?: { server: string; model: string; loadMs: number | null; queryMs: Measure; requestMs: Measure; texts: number; tokens: number | null; tokensPerSecond: number | null; dims: number | null } | null;
    energy: {
      restMilliwatts: number;
      loadMilliwatts: number;
      jobs: number;
      tokens: number;
      millijoulesPerToken: number | null;
      /** From kit 2.98.0, with a meter other than the battery: what was read, and the part that is the whole PC (the card, for nvidia's). */
      meter?: { kind: string; say: string; whole: string };
      /** The battery was charging through the energy step: the whole PC's figures carry it, each part's don't. */
      charging?: boolean | null;
      /** Each part's power at rest with no model loaded, then with it loaded (just after the cold load), and what keeping it loaded costs the whole PC. */
      idle?: { unloadedMilliwatts: Record<string, number> | null; loadedMilliwatts: Record<string, number> | null; keepLoadedMilliwatts: number | null };
      /** Each part's power at rest just before the energy step, and through its triage minutes. */
      restParts?: Record<string, number>;
      loadParts?: Record<string, number>;
      /** Fixed batches of each job, of reads and of pictures (and of embedding requests, `embed`): what each took, by part. */
      batches?: Record<string, EnergyBatch>;
      /** The embedding server loaded and at rest (kit 2.99.0), each part's power, and what keeping it loaded costs the whole PC against no model. */
      embed?: { loadedMilliwatts: Record<string, number> | null; keepLoadedMilliwatts: number | null };
    } | null;
  };
  quality: { score: number | null; passed: number; of: number; mustPass: boolean; gate: boolean; items: { id: string; kind: string; ok: boolean; answer: string; ms: number }[] };
  vision: { passed: number; of: number; items: { id: string; ok: boolean; answer: string; ms: number }[] } | null;
  marks: Mark[];
  ranked: boolean;
}

/** The marks that keep a run off the website's boards, each with its reason; none means it's ranked. */
export function marksFor(r: BenchReport, suite: Suite): Mark[] {
  const marks: Mark[] = [];
  const res = r.results;
  if (r.run.played) marks.push({ code: 'played', say: `${r.pc.chip ?? 'this NPU'} played ${r.run.played}: its numbers are that generation's code on this NPU, not that chip's: shown, never ranked` });
  if (r.suite.profile === 'quick') marks.push({ code: 'quick', say: `a quick run tries each measurement ${suite.tries.quick} times, not ${suite.tries.full}: shown, not ranked` });
  if (r.conditions.onBattery) marks.push({ code: 'battery', say: 'it ran on the battery: speed is ranked plugged in (an energy figure from it still counts)' });
  if (r.conditions.cpuBusyPercent !== null && r.conditions.cpuBusyPercent > suite.quiet.cpuBusyMax) marks.push({ code: 'busy', say: `the processor was ${r.conditions.cpuBusyPercent}% busy before the start (no more than ${suite.quiet.cpuBusyMax}% for a ranked run)` });
  if (r.conditions.beside?.length) marks.push({ code: 'beside', say: `the manor's own server ran beside it (port ${r.conditions.beside.join(', ')}), so it ran on other ports: shown, not ranked` });
  if (r.conditions.standby) marks.push({ code: 'standby', say: `the PC went into standby during the run (${r.conditions.standby === 1 ? 'once' : `${r.conditions.standby} times`}), where it rests at a fraction of its awake draw: shown, not ranked` });
  if (r.run.plugin === 'server') marks.push({ code: 'plugin', say: `${r.run.server?.replace(/ [\d.]+$/, '') ?? 'the server'} ran its own plugin, not the kit's build that this PC runs: shown, not ranked` });
  if (r.run.streamed === false) marks.push({ code: 'not-streamed', say: "the server didn't stream, so reading and writing are estimates" });
  if (r.run.usageReported === false) marks.push({ code: 'no-usage', say: "the server didn't report token counts, so they are estimates" });
  const noisy = [['short answer', res.short], ['writing', res.writeTokensPerSecond], ...Object.entries(res.readFirstTokenMs).map(([k, v]) => [`reading ${k} tokens`, v]), ...Object.entries(res.jobs).map(([k, v]) => [`the ${k} job${typeof v.spreadAtLength === 'number' ? ' (at one answer length)' : ''}`, v])].filter(([, m]) => m && !(m as Measure).steady && (m as Measure).median !== null).map(([n]) => n as string);
  if (noisy.length) marks.push({ code: 'noisy', say: `tries varied by more than ${suite.steady.maxSpread * 100}%: ${noisy.join(', ')}` });
  const failedJobs = suite.jobs.filter((j) => !res.jobs[j.id] || res.jobs[j.id].passed < res.jobs[j.id].tries.length).map((j) => j.id);
  if (failedJobs.length) marks.push({ code: 'job-failed', say: `not every try of a job answered correctly: ${failedJobs.join(', ')}` });
  if (!r.quality.gate) marks.push({ code: 'gate', say: !r.quality.mustPass ? 'a must-pass question was answered wrongly: the model doesn’t run properly here' : `the quality score ${r.quality.score} is under the gate ${suite.gate.score}` });
  return marks;
}

// ------------------------------------------------------------------------------------------------
// Conditions

const POWER_MODES: Record<string, string> = {
  '961cc777-2547-4f9d-8174-7d86181b8a7a': 'best power efficiency',
  '00000000-0000-0000-0000-000000000000': 'balanced',
  'ded574b5-45a0-4f42-8737-46345c09c238': 'best performance',
};

const CONDITIONS_PS = `$ErrorActionPreference = 'SilentlyContinue'
$b = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus | Select-Object -First 1
$full = (Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity | Select-Object -First 1).FullChargedCapacity
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$p = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes'
$br = (Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness
"battery|$([int]($null -ne $b))|$($b.PowerOnline)|$($b.RemainingCapacity)|$full"
"pc|$($cs.Manufacturer)|$($cs.Model)|$($os.BuildNumber)"
"power|$($p.ActiveOverlayAcPowerScheme)|$($p.ActiveOverlayDcPowerScheme)"
"brightness|$br"`;

/** Reads the conditions' output (CONDITIONS_PS's lines). */
export function parseConditions(out: string): Omit<Conditions, 'cpuBusyPercent'> {
  const line = (k: string) => out.split(/\r?\n/).find((l) => l.startsWith(`${k}|`))?.split('|').slice(1) ?? [];
  const [hasBattery, online, remaining, full] = line('battery');
  const [make, model, build] = line('pc');
  const [ac, dc] = line('power');
  const [br] = line('brightness');
  const battery = hasBattery === '1';
  const onBattery = battery ? !/^true$/i.test(online ?? '') : false;
  const mode = (onBattery ? dc : ac)?.trim().toLowerCase() || '00000000-0000-0000-0000-000000000000';
  const percent = battery && Number(full) > 0 ? Math.round((Number(remaining) / Number(full)) * 100) : null;
  return {
    onBattery,
    batteryPercent: percent,
    powerMode: POWER_MODES[mode] ?? mode,
    brightness: br ? Number(br) : null,
    windowsBuild: build?.trim() || null,
    make: make?.trim() || null,
    model: model?.trim() || null,
  };
}

/** How busy the processor is, from Windows (not a counter name, which Windows translates). */
async function cpuBusy(): Promise<number | null> {
  try {
    const out = await runPowerShell(`(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime`, 20_000);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, held until its input closes.
const AWAKE_PS = `Add-Type -Name Awake -Namespace Kit -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][Kit.Awake]::SetThreadExecutionState([uint32]2147483651)
[void][Console]::In.ReadToEnd()`;

/**
 * Keeps the PC awake with its screen on until let go (kit 2.99.0), as a video player does: a PowerShell that asks
 * Windows to (SetThreadExecutionState) and holds it until its input closes, when the run lets go or however the run
 * ends. Windows' own settings stay as they are. With the screen off, Windows takes a PC into Modern Standby, where the
 * X2 rested at 5.4 W against 9–10 W awake: a run that crossed into it compared two different PCs.
 */
export function holdAwake(): () => void {
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', AWAKE_PS], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    return () => child.stdin.end();
  } catch {
    return () => {};
  }
}

/** How many times the PC went into Modern Standby since a time (Kernel-Power's event 506 in Windows' System log), null where it couldn't be read. */
async function standbyCount(since: Date): Promise<number | null> {
  try {
    const out = await runPowerShell(`@(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 506; StartTime = [datetime]::Parse('${since.toISOString()}').ToLocalTime() } -ErrorAction SilentlyContinue).Count`, 30_000);
    const n = Number(out.trim());
    return out.trim() && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// A route for the run

/**
 * Renames one model id to another in a route's strings, in one pass: the id, and without its `:tag` where it has one
 * (GenieX keeps qualcomm/Qwen3-VL-4B-Instruct:W4A16 in a folder qualcomm\Qwen3-VL-4B-Instruct), each with / or \.
 */
function renamer(from: string, to: string): (s: string) => string {
  const bare = (x: string) => x.replace(/:[^:/\\]*$/, '');
  const names = new Map<string, string>();
  for (const [a, b] of [[from, to], ...(bare(from) !== from ? [[bare(from), bare(to)]] : [])]) for (const sep of ['/', '\\']) names.set(a.replace(/\//g, sep), b.replace(/\//g, sep));
  const re = new RegExp([...names.keys()].sort((x, y) => y.length - x.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (s) => s.replace(re, (m) => names.get(m)!);
}

/**
 * The route with a model that isn't in npu-vendors.json: pulled the same way as the route's own, its files not pinned.
 * It chats only, unless `vision` says it sees too: it doesn't take the kinds of the model it stands in for, or a text
 * model on GenieX's route (whose one model chats and sees) would be pulled as a vision model and asked the pictures.
 */
export function candidateRoute(route: NpuRoute, id: string, o: { vision?: boolean } = {}): NpuRoute {
  const base = route.models.find((m) => m.kinds.includes('chat')) ?? route.models[0];
  if (o.vision && !route.models.some((m) => m.kinds.includes('vision'))) throw new Error(`${route.server}'s route has no vision, so --vision can't measure a candidate's`);
  const swap = renamer(base.id, id);
  const pull = base.pull.map(swap);
  // GenieX's pull says the model's type (llm or vlm): the candidate's own, not the route's model's.
  const type = pull.indexOf('--model-type');
  if (type >= 0) pull[type + 1] = o.vision ? 'vlm' : 'llm';
  const kinds: NpuModel['kinds'] = o.vision ? ['chat', 'vision'] : ['chat'];
  // A present file whose path doesn't name the model can't say where a candidate is (FastFlowLM's folders are its own
  // names, Qwen3-4B-Instruct-2507-NPU2 for qwen3-it:4b): kept, it would find the route's own model, so the candidate
  // would count as downloaded, never be pulled, and have that model's files measured as its own. Dropped instead.
  const present = base.present && swap(base.present) !== base.present ? swap(base.present) : undefined;
  return { ...route, models: [{ ...base, id, kinds, pull, present, size: 0, licence: `a candidate (${id}): its licence is checked before it ships`, pinned: undefined }] };
}

/** The route with only the model asked for (and its vision model, where the route has one beside it). */
export function routeWithModel(route: NpuRoute, id: string): NpuRoute {
  const m = route.models.find((x) => x.id === id);
  if (!m) throw new Error(`${route.server}'s route has no model ${id} (it has ${route.models.map((x) => x.id).join(', ')}): use --candidate for one it doesn't`);
  return { ...route, models: [m, ...route.models.filter((x) => x !== m && x.kinds.includes('vision') && !m.kinds.includes('vision'))] };
}

/**
 * A candidate's files, measured, as `pinned` would list them: every file in its model's folder (where its `present`
 * file is, GenieX's %USERPROFILE%\.cache\geniex\models\<org>\<name>, say), by its name there, with its size and
 * SHA-256. Null where the route doesn't say where its models are (FastFlowLM's), or the folder has no files; the log
 * says which.
 */
export async function candidateFiles(m: Pick<NpuModel, 'present'>, o: { server: string; tools: string; env?: Record<string, string | undefined>; log: (line: string) => void; hash?: (file: string) => Promise<string> }): Promise<BenchReport['run']['files']> {
  if (!m.present) {
    o.log(`the candidate's files: not measured, as ${o.server}'s route doesn't say where its models are`);
    return null;
  }
  const dir = path.win32.dirname(expandRoute(m.present, { tools: o.tools, env: o.env }));
  let names: string[] = [];
  try {
    names = readdirSync(dir, { encoding: 'utf8', recursive: true }).filter((n) => statSync(path.join(dir, n)).isFile()).sort();
  } catch {}
  if (!names.length) {
    o.log(`the candidate's files: not measured, as ${dir} ${existsSync(dir) ? 'has none' : "isn't there"}`);
    return null;
  }
  const files: NonNullable<BenchReport['run']['files']> = {};
  for (const n of names) files[n.split(path.sep).join('/')] = { size: statSync(path.join(dir, n)).size, sha256: await (o.hash ?? sha256File)(path.join(dir, n)) };
  const bytes = Object.values(files).reduce((a, f) => a + f.size, 0);
  o.log(`the candidate's files: ${names.length} measured (${mb(bytes)}), each one's size and SHA-256 in the report`);
  return files;
}

/**
 * The route's server given its own compile cache for the run (emptied before the first start), and a cap, where it has
 * those. Off the NPU nothing is compiled for a cap (routeOnDevice drops it), so there `cap` is only where the long read
 * goes: the same as an NPU run's, so the two compare.
 */
export function benchServe(route: NpuRoute, o: { device: string; cap?: number }): NpuRoute {
  const serve = [...route.serve];
  const p = serve.indexOf('--max_prompt_len');
  if (o.cap && p < 0 && o.device.toUpperCase() === 'NPU') throw new Error(`${route.server} on the ${o.device} has no prompt cap to set`);
  const compiled = o.cap && p >= 0 ? o.cap : undefined;
  if (compiled) serve[p + 1] = String(compiled);
  const c = serve.indexOf('--cache_dir');
  if (c >= 0) serve[c + 1] = `${path.win32.dirname(serve[c + 1])}\\.bench-cache-${o.device.toLowerCase()}${compiled ? `-${compiled}` : ''}`;
  return { ...route, serve, maxContextTokens: o.cap ?? route.maxContextTokens };
}

/** The suite's pictures as a server takes them: each a file of its own where it reads a path (image-path), else a `data:` URL; `done` removes the files. */
function pictureInputs(asFiles: boolean) {
  const dir = asFiles ? mkdtempSync(path.join(os.tmpdir(), 'npu-bench-pictures-')) : null;
  return {
    imageOf: (v: Suite['vision'][number]) => {
      if (!dir) return picture(v.image);
      const file = path.join(dir, `${v.id}.png`);
      if (!existsSync(file)) writeFileSync(file, picturePng(v.image));
      return file;
    },
    done: () => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** What each of a server's quirks makes the bench's requests do, for its log. */
const QUIRK_SAYS: Record<Quirk, string> = {
  'prefix-leak': 'a nonce first in every request (prefix-leak)',
  'image-path': 'each picture as a file of its own, its path sent (image-path)',
  'sides-of-32': 'a picture 720 px tall or less with a side of a whole number of 32 px, that side a pixel longer (sides-of-32)',
};

/** How much more than at rest working must draw for its energy to count: the battery's rate wobbles by about this much. */
export const ENERGY_MIN_EXTRA = { milliwatts: 1_000, share: 0.1 };

// ------------------------------------------------------------------------------------------------
// Off the NPU: llama.cpp, for a route whose server runs on the NPU only (kit 2.99.0)

/** A graphics or processor run on llama.cpp: the build setup pins, the model's files and the embedding model's, and what isn't here yet. */
export interface OffNpuPlan {
  device: 'GPU' | 'CPU';
  /** `llama.cpp b11734 (opencl-adreno-arm64)`. */
  server: string;
  backend: 'CUDA' | 'Vulkan' | 'GPUOpenCL' | null;
  exe: string;
  model: { id: string; path: string; mmproj?: string; pictureTokens?: number };
  embed: { path: string; model: string };
  context: number;
  serve: string[];
  /** The model's files (and its projector's), by name, as the report's run.files lists them. */
  files: Record<string, { size: number; sha256: string }>;
  /** What isn't here, each checked against its pinned size and SHA-256 as it downloads (llama.cpp's zip unpacked). */
  downloads: Download[];
  /** What is, checked against its pin before it runs. */
  inPlace: { path: string; size: number; sha256: string }[];
  downloadBytes: number;
}

const sizeOf = (p: string): number | null => {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
};

/**
 * What a run of the route's model off the NPU needs, where its server runs on the NPU only: llama.cpp's pinned build
 * for the device (setup's variantFor: the Adreno's OpenCL build, a Radeon's Vulkan one, the processor's), in setup's
 * own folder for it; the model as the route's offNpu has it, from where `present` says (GenieX's cache) or the tools
 * home's models folder; and setup's embedding model, where setup keeps it. Why not, where the route has no llama.cpp
 * form of the model or llama.cpp no build for the device.
 */
export function planOffNpu(route: NpuRoute, model: NpuModel, o: { device: 'GPU' | 'CPU'; vendor: string; arch: string; tools: string; env?: Record<string, string | undefined> }): OffNpuPlan | { why: string } {
  const off = route.offNpu?.models[model.id];
  if (!route.offNpu || !off) return { why: `${route.server} runs ${model.id} on the NPU only, and npu-vendors.json has no llama.cpp form of it (the route's offNpu)` };
  const v = variantFor({ kind: o.device === 'GPU' ? 'gpu' : 'cpu', vendor: o.vendor, arch: o.arch });
  if ('none' in v) return { why: `llama.cpp off the NPU: ${v.none}` };
  const zip = assetName(LLAMA_PIN.build, v.variant);
  const pin = LLAMA_PIN.files[zip];
  if (!pin || v.cudart) return { why: `the kit pins no llama.cpp ${LLAMA_PIN.build} build for ${v.variant} that the benchmark runs` };
  const servers = path.join(o.tools, 'servers', 'llama.cpp');
  const folder = path.join(servers, `${LLAMA_PIN.signed}-${v.variant}`);
  const exe = path.join(folder, 'llama-server.exe');
  const downloads: Download[] = [];
  const inPlace: OffNpuPlan['inPlace'] = [];
  if (!existsSync(exe)) downloads.push({ what: `llama.cpp ${LLAMA_PIN.build} (${v.variant})`, url: pin.url ?? `https://github.com/${SIGNED_LLAMA_REPO}/releases/download/${LLAMA_PIN.signed}/${zip}`, size: pin.size, sha256: pin.sha256, ...(pin.mirrors?.length ? { mirrors: [...pin.mirrors] } : {}), dest: path.join(servers, 'downloads', zip), unpackTo: folder, marker: exe, have: false });
  // A file where `present` says, or the tools home's own copy, when it's there at its size; else downloaded to the latter.
  const take = (f: { file: string; size: number; sha256: string; present?: string }, url: string, own: string) => {
    const present = f.present ? expandRoute(f.present, { tools: o.tools, env: o.env }) : null;
    const where = present && sizeOf(present) === f.size ? present : own;
    if (sizeOf(where) === f.size) inPlace.push({ path: where, size: f.size, sha256: f.sha256 });
    else downloads.push({ what: f.file, url, size: f.size, sha256: f.sha256, dest: where, have: false });
    return where;
  };
  const files: OffNpuPlan['files'] = {};
  const paths: Partial<Record<'model' | 'mmproj', string>> = {};
  for (const f of off.files) {
    files[f.file] = { size: f.size, sha256: f.sha256 };
    paths[f.role] = take(f, pinnedModelUrl(f), path.join(o.tools, 'models', ...f.repo.split('/'), f.file));
  }
  if (!paths.model) return { why: `npu-vendors.json's offNpu for ${model.id} has no model file` };
  const e = MODEL_PINS.find((p) => MODEL_SPECS.embed.repos.includes(p.repo) && MODEL_SPECS.embed.file.test(p.file));
  if (!e) return { why: 'the kit pins no embedding model' };
  const embedPath = take(e, pinnedModelUrl(e), path.join(o.tools, 'models', path.basename(e.file)));
  return {
    device: o.device,
    server: `llama.cpp ${LLAMA_PIN.build} (${v.variant})`,
    backend: v.backend,
    exe,
    model: { id: model.id, path: paths.model, ...(paths.mmproj ? { mmproj: paths.mmproj } : {}), ...(model.pictureTokens ? { pictureTokens: model.pictureTokens } : {}) },
    embed: { path: embedPath, model: MODEL_SPECS.embed.model },
    context: Math.max(route.offNpu.context, route.maxContextTokens),
    serve: off.serve ?? [],
    files,
    downloads,
    inPlace,
    downloadBytes: downloads.reduce((n, d) => n + d.size, 0),
  };
}

/**
 * The plan set up, without writing config.json: what isn't here downloaded (llama.cpp's zip unpacked), what is checked
 * against its pin, the graphics card's llama.cpp device found by its name (matchDevice), and the entry setup would write
 * for that card or the processor (acceleratorEntry: one server for chat and pictures, one for embeddings), at the NPU's
 * context, with the route's own arguments for the model and its vision model's picture cap, so every device is asked the
 * same. Why not, where something failed.
 */
export async function setUpOffNpu(p: OffNpuPlan, o: { ports: { chat: number; embed: number }; card: Pick<GpuCard, 'name'> | null; io?: Partial<Pick<NpuIo, 'download' | 'unpack' | 'hash'>> & { listDevices?: (server: string) => Promise<string> }; log: (line: string) => void }): Promise<{ entry: AcceleratorEntry } | { why: string }> {
  const io = o.io ?? {};
  try {
    for (const d of p.downloads) {
      o.log(`  downloading ${d.what} (${mb(d.size)})`);
      await (io.download ?? download)(d, (done, total) => o.log(`    ${mb(done)} of ${mb(total)}`));
      if (d.unpackTo) {
        (io.unpack ?? unpack)(d.dest, d.unpackTo);
        rmSync(d.dest, { force: true });
      }
    }
    for (const f of p.inPlace) if ((await (io.hash ?? sha256File)(f.path)) !== f.sha256) return { why: `${f.path} isn't the file the kit pins (its SHA-256 differs)` };
  } catch (e: any) {
    return { why: String(e?.message ?? e).split(/\r?\n/)[0] };
  }
  let device: string | null = null;
  if (p.device === 'GPU') {
    const devices = parseListDevices(await (io.listDevices ?? listDevices)(p.exe));
    device = (o.card ? matchDevice(o.card, devices, p.backend) : null) ?? devices.find((x) => x.name.startsWith(p.backend ?? ''))?.name ?? null;
    if (!device) return { why: `${p.server} lists no ${p.backend} device for ${o.card?.name ?? 'the graphics'}${devices.length ? ` (it lists ${devices.map((x) => x.name).join(', ')})` : ''}` };
  }
  const m = { path: p.model.path, model: p.model.id, ...(p.model.mmproj ? { mmproj: p.model.mmproj } : {}) };
  const entry = acceleratorEntry({
    id: p.device === 'GPU' ? 'gpu-bench' : 'cpu',
    kind: p.device === 'GPU' ? 'gpu' : 'cpu',
    device,
    server: p.exe,
    models: { ...(p.model.mmproj ? { vision: m } : { chat: m }), embed: { path: p.embed.path, model: p.embed.model } },
    ports: { chat: o.ports.chat, embed: o.ports.embed },
    slots: 1,
    maxContextTokens: p.context,
    chatOnVision: !!p.model.mmproj,
  });
  const cmd = entry.chat!.startCommand!;
  const c = cmd.indexOf('-c');
  if (c >= 0) cmd[c + 1] = String(p.context);
  cmd.push(...p.serve);
  if (p.model.pictureTokens && entry.vision) entry.vision.pictureTokens = p.model.pictureTokens;
  return { entry };
}

/** `n` ports nothing holds, from `from` up (to 99 past it). */
async function freePorts(from: number, n: number, free: (port: number) => Promise<boolean>): Promise<number[]> {
  const out: number[] = [];
  for (let p = from; p < from + 100 && out.length < n; p++) if (await free(p)) out.push(p);
  if (out.length < n) throw new Error(`no ${n} free ports from ${from} to ${from + 99}`);
  return out;
}

// ------------------------------------------------------------------------------------------------
// The server's plugin as the kit runs it (kit 2.99.0)

/** A copy kitPlugin made, removed: its links first, so nothing they point at is touched, then the rest. */
export function removeCopy(dir: string): void {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    try {
      if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
  // The bench folder too, once it holds no other copy: a run leaves the tools home as it found it.
  try {
    rmdirSync(path.dirname(dir));
  } catch {}
}

/**
 * The route's server with the kit's build of its plugin (npu-vendors.ts' NpuPluginPatch), as this PC runs it once the
 * keeper has put it in (npu-patch.ts): GenieX's llama.cpp plugin on the X2, whose own build keeps 18 of the processor's
 * threads spinning while the NPU writes. Where GenieX's own file is still in place (the keeper hasn't looked since, or
 * config.json's npuPatch is false), the run takes a copy of the server in the tools home's bench folder: its files
 * copied, the plugin's folder too with the kit's build in it, its other folders linked rather than copied (GenieX's
 * QAIRT, 216 MB). The server's own files are never touched, and the copy goes after the run (`done`). Null where the kit
 * has no build for this PC's server or its file isn't there; `server` where the copy can't run the kit's build, and why.
 */
export async function kitPlugin(route: NpuRoute, generation: string | null, o: { tools: string; env?: Record<string, string | undefined>; hash?: (file: string) => Promise<string>; kitDir?: string }): Promise<{ plugin: NonNullable<BenchReport['run']['plugin']>; exe?: string; why?: string; done: () => void } | null> {
  const patch = pluginPatchOf(route, generation);
  if (!patch) return null;
  const target = patchTarget(patch, o.tools, o.env);
  if (!existsSync(target)) return null;
  const hash = o.hash ?? sha256File;
  const none = () => {};
  const sum = await hash(target);
  if (sum === patch.patched.sha256) return { plugin: 'kit', done: none };
  if (sum !== patch.stock.sha256) return { plugin: 'other', done: none };
  for (const [name, want] of Object.entries(patch.needs)) {
    const f = path.join(path.dirname(target), name);
    if (sizeOf(f) !== want.size || (await hash(f)) !== want.sha256) return { plugin: 'server', why: `its ${path.basename(name)} isn't the one the kit's build is made for`, done: none };
  }
  const from = path.resolve(o.kitDir ?? path.dirname(fileURLToPath(import.meta.url)), patch.patched.from);
  if (!existsSync(from)) return { plugin: 'server', why: `the kit has no ${patch.patched.from}`, done: none };
  const exe = serverExe(route, o.tools, o.env);
  const home = path.dirname(exe);
  const dir = path.join(o.tools, 'bench', `${path.basename(home).replace(/\W+/g, '-').toLowerCase()}-${route.version}`);
  removeCopy(dir);
  try {
    mkdirSync(dir, { recursive: true });
    for (const e of readdirSync(home, { withFileTypes: true })) {
      const src = path.join(home, e.name);
      const holds = path.relative(src.toLowerCase(), path.dirname(target).toLowerCase());
      if (e.isFile()) copyFileSync(src, path.join(dir, e.name));
      else if (e.isDirectory()) {
        if (!holds.startsWith('..') && !path.isAbsolute(holds)) cpSync(src, path.join(dir, e.name), { recursive: true });
        else symlinkSync(src, path.join(dir, e.name), 'junction');
      }
    }
    const into = path.join(dir, path.relative(home, target));
    copyFileSync(from, into);
    if ((await hash(into)) !== patch.patched.sha256) throw new Error(`the kit's ${patch.patched.from} isn't the build it pins`);
  } catch (e: any) {
    removeCopy(dir);
    return { plugin: 'server', why: `a copy with the kit's build couldn't be made: ${String(e?.message ?? e).split(/\r?\n/)[0]}`, done: none };
  }
  return { plugin: 'kit-copy', exe: path.join(dir, path.basename(exe)), done: () => removeCopy(dir) };
}

const roundParts = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([p, v]) => [p, Math.round(v)]));

/**
 * A fixed batch of the agents' work as one stretch on the meter (kit 2.98.0), against the PC at rest just before it
 * (`rest`): what it took by part, and over rest, each and a token. Null, and said, when the meter gave no reading.
 */
export async function energyBatch(m: Meter, rest: Span, count: number, one: (i: number) => Promise<{ ok: boolean; tokens: number }>, o: { now: () => number; sleep: (ms: number) => Promise<void>; what: string; log: (line: string) => void }): Promise<EnergyBatch | null> {
  const whole = m.whole;
  let answered = 0;
  let tokens = 0;
  const s = await measureSpan(m, {
    now: o.now,
    sleep: o.sleep,
    work: async () => {
      for (let i = 0; i < count; i++) {
        const r = await one(i);
        if (r.ok) answered++;
        tokens += r.tokens;
      }
    },
  });
  if (!s || !(whole in s.millijoules)) {
    o.log(`energy, ${count} ${o.what}: no reading`);
    return null;
  }
  const extra = Object.fromEntries(Object.entries(s.millijoules).map(([p, mj]) => [p, Math.max(0, mj - (rest.milliwatts[p] ?? 0) * s.seconds)]));
  const each = Object.fromEntries(Object.entries(extra).map(([p, mj]) => [p, mj / count]));
  o.log(`energy, ${count} ${o.what}: ${joules(s.millijoules[whole])} in ${s.seconds.toFixed(1)} s; each over rest ${partsSay(m, each, joules)}`);
  return { count, answered, seconds: Number(s.seconds.toFixed(2)), tokens, millijoules: roundParts(s.millijoules), extraMillijoules: roundParts(extra), millijoulesEach: Math.round(extra[whole] / count), millijoulesPerToken: tokens ? Number((extra[whole] / tokens).toFixed(3)) : null };
}

/** Two stretches' draws agree, for settle: within this share of the first, or these milliwatts, whichever is more. */
export const SETTLED = { share: 0.05, milliwatts: 100 };

/**
 * The PC let settle before a rest is read (kit 2.99.0): the whole PC's draw over stretches of `seconds` until two in a
 * row agree (SETTLED), up to `minutes`. A rest read while the last run's heat, or a burst of something else, still lifts
 * the PC reads high: on the X2, rests read just after another device's run came out up to 7 W over, and a model loaded
 * cost less than none. How long it took, whether it settled, and each stretch's draw (none when the meter gave no reading).
 */
export async function settle(m: Meter, o: { now: () => number; sleep: (ms: number) => Promise<void>; seconds: number; minutes: number }): Promise<{ seconds: number; settled: boolean; draws: number[] }> {
  const t0 = o.now();
  const draws: number[] = [];
  const limit = Math.max(2, Math.ceil((o.minutes * 60) / o.seconds));
  while (draws.length < limit) {
    const s = await measureSpan(m, { now: o.now, sleep: o.sleep, ms: o.seconds * 1000 });
    const w = s?.milliwatts[m.whole];
    if (w === undefined) break;
    draws.push(w);
    const [a, b] = draws.slice(-2);
    if (draws.length > 1 && Math.abs(b - a) <= Math.max(a * SETTLED.share, SETTLED.milliwatts)) return { seconds: (o.now() - t0) / 1000, settled: true, draws };
  }
  return { seconds: (o.now() - t0) / 1000, settled: false, draws };
}

/** One /v1/embeddings request, never throwing: its time, how many vectors and how long, and the tokens the server counted. */
async function embedAsk(http: typeof fetch, ep: { baseUrl: string; model: string }, input: string | string[], timeoutMs: number, now: () => number): Promise<{ ok: boolean; ms: number; vectors: number; dims: number; tokens: number | null; error: string | null }> {
  const t0 = now();
  try {
    const res = await http(`${ep.baseUrl}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: ep.model, input }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const ms = Math.round(now() - t0);
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {}
    const rows: any[] = Array.isArray(j?.data) ? j.data : [];
    const want = Array.isArray(input) ? input.length : 1;
    const ok = res.ok && rows.length === want && rows.every((r) => Array.isArray(r?.embedding) && r.embedding.length > 0);
    return { ok, ms, vectors: rows.length, dims: Array.isArray(rows[0]?.embedding) ? rows[0].embedding.length : 0, tokens: Number(j?.usage?.prompt_tokens ?? j?.usage?.total_tokens) || null, error: ok ? null : text.slice(0, 300) || `answered ${res.status}` };
  } catch (e: any) {
    return { ok: false, ms: Math.round(now() - t0), vectors: 0, dims: 0, tokens: null, error: e?.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : String(e?.cause?.code ?? e?.message ?? e) };
  }
}

// ------------------------------------------------------------------------------------------------
// The run

export interface NpuBenchOptions {
  profile?: 'quick' | 'full';
  /** Print what this PC's agents sent over the last this-many days instead of running (`--mix`). */
  mix?: number;
  vendor?: NpuVendor;
  device?: string;
  /** Several devices, run in turn (`--device NPU,GPU,CPU`): npuBenchSeries. */
  devices?: string[];
  /** How many times each device runs (`--runs 3`), the summary taking each figure's median. */
  runs?: number;
  /** Reports to sum up instead of running (`--summary <report.json>...`). */
  summary?: string[];
  /** An older Snapdragon to play on this one (`--generation snapdragon-x` on an X2: npu-vendors.ts' playGeneration). */
  generation?: string;
  /** The models a PC with little memory runs (its generation's smallPc), whatever this PC's memory. */
  smallPc?: boolean;
  model?: string;
  candidate?: string;
  /** The candidate sees too (`--vision`): pulled as a vision model where the server asks, and asked the pictures. */
  vision?: boolean;
  cap?: number;
  energy?: boolean;
  /** What --energy reads (power-meter.ts): auto (the default), emi, shelly:<address>, nvidia or battery. */
  meter?: string;
  setup?: boolean;
  yes?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  out?: string;
  log?: (line: string) => void;
  detection?: Detection;
  catalog?: NpuCatalog;
  suite?: Suite;
  tools?: string;
  env?: NodeJS.ProcessEnv;
  kitVersion?: string;
  io?: {
    setup?: Partial<NpuIo>;
    start?: (entry: AcceleratorEntry, logFile: string) => Promise<RunningServer>;
    fetch?: typeof fetch;
    memory?: (pid: number) => Promise<{ workingSetBytes: number; privateBytes: number } | null>;
    conditions?: () => Promise<Omit<Conditions, 'cpuBusyPercent'>>;
    cpuBusy?: () => Promise<number | null>;
    /** Holds the PC awake with its screen on (holdAwake): what lets it go. */
    awake?: () => () => void;
    /** How many times the PC went into Modern Standby since a time (standbyCount). */
    standby?: (since: Date) => Promise<number | null>;
    dischargeRate?: () => Promise<number | null>;
    /** The meters' own reading (power-meter.ts' MeterIo): the Energy Meter counters' PowerShell, nvidia-smi, a plug's fetch. */
    meter?: MeterIo;
    charging?: () => Promise<boolean | null>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    clearCache?: (dir: string) => void;
    /** The version of the route's server installed here (npu-vendors.ts' installedVersion by default). */
    serverVersion?: (route: NpuRoute) => Promise<string | null>;
    /** Whether nothing holds a port on 127.0.0.1 (npu-check.ts' portFree). */
    portFree?: (port: number) => Promise<boolean>;
    /** llama-server's --list-devices, for a graphics run off the NPU (setup.ts' listDevices). */
    listDevices?: (server: string) => Promise<string>;
    /** The kit's node part, which holds its build of the server's plugin (kitPlugin). */
    kitDir?: string;
  };
}

const kitVersion = () => {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    try {
      return readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
    } catch {
      return 'unknown';
    }
  }
};

/** Runs the benchmark: the report, and 0 when it ran to the end (ranked or not), 1 when it couldn't, 2 for a bad request. */
export async function npuBench(o: NpuBenchOptions = {}): Promise<{ code: number; report: BenchReport }> {
  const log = o.log ?? console.log;
  const env = o.env ?? process.env;
  const suite = o.suite ?? SUITE;
  const catalog = o.catalog ?? NPU_CATALOG;
  const now = o.io?.now ?? (() => performance.now());
  const sleep = o.io?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const profile = o.profile ?? 'full';
  const tries = suite.tries[profile];
  const device = (o.device ?? 'NPU').toUpperCase();
  const d = o.detection ?? (await detect());
  const npu = d.npu;
  const cond = await (o.io?.conditions ?? (async () => parseConditions(await runPowerShell(CONDITIONS_PS, 60_000).catch(() => ''))))();
  const report: BenchReport = {
    format: 'castellan-npu-bench-report/1',
    suite: { version: suite.version, kit: o.kitVersion ?? kitVersion(), profile, gate: suite.gate },
    at: new Date().toISOString(),
    pc: { cpu: d.cpu?.name ?? null, chip: npu?.label ?? null, npu: npu?.name ?? null, pciDevice: npu ? (pciDevice(npu.deviceId) ?? null) : null, driver: npu?.driver || null, driverDate: npu?.driverDate || null, ramGb: Math.round(d.ramBytes / 1024 ** 3), windowsBuild: cond.windowsBuild, make: cond.make, model: cond.model },
    conditions: { ...cond, cpuBusyPercent: null },
    run: { vendor: null, device, server: null, model: null, candidate: !!o.candidate, cap: null, files: null, streamed: null, usageReported: null },
    results: { coldLoadMs: null, cachedLoadMs: null, short: null, writeTokensPerSecond: null, readFirstTokenMs: {}, readAtCap: null, jobs: {}, jobTimeS: null, memory: null, holding: null, energy: null },
    quality: { score: null, passed: 0, of: suite.quality.length, mustPass: false, gate: false, items: [] },
    vision: null,
    marks: [],
    ranked: false,
  };
  // What a run leaves to be undone however it ends: a copy of the server (kitPlugin).
  const cleanups: (() => void)[] = [];
  const finish = (code: number, mark?: Mark) => {
    for (const c of cleanups.splice(0)) c();
    if (mark) report.marks.push(mark);
    else report.marks = marksFor(report, suite);
    report.ranked = code === 0 && !report.marks.length;
    const problems = checkSchema(report, REPORT_SCHEMA);
    if (problems.length) log(`The report doesn't match its schema: ${problems.join('; ')}`);
    const file = o.out ?? path.join(o.tools ?? toolsHome(env), `npu-bench-${report.run.vendor ?? 'none'}-${device.toLowerCase()}-${report.at.slice(0, 19).replace(/[:T]/g, '-')}.json`);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
      log(`The report: ${file}`);
    } catch (e: any) {
      log(`The report couldn't be written to ${file}: ${e?.message ?? e}`);
    }
    return { code, report };
  };

  // 1. The route, with the model asked for.
  const vendor = o.vendor ?? npu?.vendor ?? null;
  report.run.vendor = vendor;
  if (!vendor || !NPU_VENDORS.includes(vendor)) return finish(1, { code: 'setup', say: npu ? `${npu.name} isn't an NPU the benchmark knows` : 'Windows lists no NPU' });
  const rehearsal = !!o.vendor && o.vendor !== npu?.vendor;
  if (rehearsal) return finish(2, { code: 'rehearsal', say: "the benchmark measures this PC's own NPU route: use the NPU check to rehearse another maker's" });
  if (!npu?.supported) return finish(1, { code: 'setup', say: `the manor can't use this NPU: ${npu?.why ?? 'unknown'}` });
  // An older Snapdragon played on this one (--generation): its AI Hub build and its Hexagon code, never ranked.
  const play = o.generation ? playGeneration(npu, o.generation, catalog) : null;
  if (play?.kind === 'refused') return finish(2, { code: 'played', say: play.why });
  if (play?.kind === 'values') return finish(2, { code: 'played', say: `only a Snapdragon plays another generation in the benchmark (its AI Hub build and its Hexagon code): this ${npu.label} would run ${o.generation}'s starting values alone, which measures nothing of that generation` });
  const played = play?.kind === 'played' ? play.played : null;
  const generation = played ? played.generation : npu.generation;
  let route: NpuRoute;
  // Off the NPU, a server with no device to choose runs its model on llama.cpp (planOffNpu): the route stays as the NPU
  // runs it, for its model, its cap (where the long read goes) and its timeouts.
  let offNpu = false;
  try {
    // As setup runs it on this generation (routeFor): its own cap, timeouts and server arguments, before anything else.
    // The models setup runs on this PC (the generation's own, a small PC's where it has any), or a small PC's when asked.
    // --model takes any of those or the route's own: the 4B on an X2, which runs the 2B. A candidate is pulled and
    // served as the route's own model is (AI Hub's build on a Snapdragon), whatever the generation runs. At the server's
    // version on this PC (a later GenieX the Smith's Use it left), as setup and the keeper run it.
    const version = await (o.io?.serverVersion ?? ((r: NpuRoute) => installedVersion(r, { tools: o.tools ?? toolsHome(env), env })))(catalog.routes[vendor]);
    const generic = atVersion(pinnedRoute(catalog.routes[vendor], generation), version);
    const g = generationOf(generic, generation);
    const runs = routeFor(generic, generation, !!o.smallPc || smallPc(d.ramBytes));
    const offered = [...runs.models, ...(g?.models ?? []), ...(g?.smallPc?.models ?? []), ...generic.models].filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
    const asked = o.candidate ? { ...runs, models: generic.models } : o.model ? { ...runs, models: offered } : runs;
    offNpu = device !== 'NPU' && !asked.serve.includes('--target_device');
    route = offNpu ? asked : routeOnDevice(asked, device);
    if (played) route = playedRoute(route, played);
    if (o.candidate) route = candidateRoute(route, o.candidate, { vision: o.vision });
    else if (o.model) route = routeWithModel(route, o.model);
    route = benchServe(route, { device, cap: o.cap });
  } catch (e: any) {
    return finish(2, { code: 'setup', say: e.message });
  }
  const chatModel = route.models.find((m) => m.kinds.includes('chat')) ?? route.models[0];
  const tools = o.tools ?? toolsHome(env);
  report.run.model = chatModel.id;
  report.run.cap = device === 'NPU' ? route.maxContextTokens : null;
  const pin = chatModel.pinned?.[generation ?? ''] ?? chatModel.pinned?.['*'];
  report.run.files = pin ? pin.files : null;
  // Off the NPU on llama.cpp: its build for the graphics card the NPU's maker makes (the Adreno, a Radeon), or the processor's.
  const card = d.cards.find((c) => c.vendor.toLowerCase() === vendor) ?? null;
  const off = offNpu ? planOffNpu(route, chatModel, { device: device as 'GPU' | 'CPU', vendor: card?.vendor ?? vendor, arch: d.cpu?.arch ?? route.arch, tools, env }) : null;
  if (off && 'why' in off) return finish(2, { code: 'setup', say: off.why });
  report.run.server = off ? off.server : `${route.server} ${route.version}`;
  if (off) report.run.files = off.files;
  log(`The NPU benchmark (${suite.version}, ${profile}): ${chatModel.id} on ${npu.label}'s ${device} with ${report.run.server}${off ? `, as ${route.server} runs on the NPU only` : ''}`);

  // The route's ports, where something else holds them (the keeper's own server, most likely): that server is never
  // stopped, nor measured in the run's place. The run takes ports beside it (routeOnFreePorts), and is marked so.
  const free = o.io?.portFree ?? portFree;
  const held: number[] = [];
  for (const p of [route.port, ...(route.embedServer ? [route.embedServer.port] : [])]) if (!(await free(p))) held.push(p);
  if (held.length) report.conditions.beside = held;
  let offPorts: number[] = [];
  try {
    if (off) offPorts = await freePorts(route.port + 100, 2, free);
    else if (held.length) {
      const moved = await routeOnFreePorts(route, false, free);
      if ('route' in moved) {
        route = moved.route;
        log(`port ${held.join(' and ')} is held (the manor's own server?): this run takes ${moved.moved.join(', ')} beside it, and isn't ranked`);
      }
    }
  } catch (e: any) {
    return finish(1, { code: 'start', say: e.message });
  }

  // 2. Its server and models, as setup does them.
  let entry: AcceleratorEntry;
  if (off) {
    const missing = off.downloads.length > 0;
    if (missing && o.setup === false) return finish(1, { code: 'setup', say: `${off.server} or the model's files aren't here, and --no-setup was given` });
    if (missing && !o.yes) {
      const ok = o.confirm ? await o.confirm(`Download ${mb(off.downloadBytes)} (${off.server} and the model's files)? [y/N] `) : false;
      if (!ok) return finish(1, { code: 'setup', say: `it would download ${mb(off.downloadBytes)}: run again with --yes` });
    }
    const r = await setUpOffNpu(off, { ports: { chat: offPorts[0], embed: offPorts[1] }, card, io: { ...o.io?.setup, ...(o.io?.listDevices ? { listDevices: o.io.listDevices } : {}) }, log });
    if ('why' in r) return finish(1, { code: 'setup', say: r.why });
    entry = r.entry;
    const at = entry.chat!.startCommand!.indexOf('--device');
    log(`  ${off.server} is set up for: chat and pictures, and embeddings beside them, on ${at >= 0 ? entry.chat!.startCommand![at + 1] : 'the processor'}`);
  } else {
    const support: NpuSupport = played ? { ...npu, generation, verified: false } : npu;
    if (played) {
      // Its own GenieX data folder, naming the played chip to AI Hub, before the plan looks for its models there.
      const dir = setUpPlayed(played, tools);
      report.run.played = played.generation;
      log(`Played: ${playedSay(played, dir, catalog)}. Shown, never ranked.`);
    }
    // The route is this generation's already: planned as it is, so the generation's own cap doesn't undo --cap. Its
    // embedding server is set up too, for the suite's embeddings (kit 2.99.0), but never past --no-setup: Intel's
    // Qwen3-Embedding (428 MB, in the route's embedServer, not its models) was pulled past it once (kit 2.62.x).
    const planOf = (noEmbed: boolean) => planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env, catalog: { ...catalog, routes: { ...catalog.routes, [vendor]: { ...route, generations: {} } } }, noEmbed, cards: d.cards })!;
    let plan = planOf(!suite.embed);
    if (o.setup === false && (plan.embed?.download || plan.embed?.modelDownload || plan.embed?.modelPull)) {
      plan = planOf(true);
      log(`embeddings: not measured: ${route.embedServer?.server ?? 'its embedding server'} or its model isn't here, and --no-setup was given`);
    }
    // Everything the plan would fetch, its embedding server's too, so --no-setup and the prompt count it.
    const needs = plan.downloadBytes;
    const missing = !plan.installed || !!plan.runtime || plan.models.some((m) => !m.have) || !!(plan.embed?.download || plan.embed?.modelDownload || plan.embed?.modelPull);
    if (missing && o.setup === false) return finish(1, { code: 'setup', say: `${route.server} or its models aren't here, and --no-setup was given` });
    if (missing && !o.yes) {
      const ok = o.confirm ? await o.confirm(`Download ${needs ? mb(needs) : 'what it needs'} (${route.server} ${route.version} and its models)? [y/N] `) : false;
      if (!ok) return finish(1, { code: 'setup', say: `it would download ${needs ? mb(needs) : 'a candidate model'}: run again with --yes` });
    }
    const set = await setUpRoute(plan, tools, o.io?.setup ?? {}, log, now);
    if (!set.entry) return finish(1, { code: 'setup', say: set.problems.join('; ') || 'setup wrote no entry' });
    entry = set.entry;
    // A candidate has no pinned files to report: its own are measured, now that setup has pulled them.
    if (o.candidate) report.run.files = await candidateFiles(chatModel, { server: route.server, tools, env, log, hash: o.io?.setup?.hash });
    // The server's plugin as this PC runs it: the kit's build, from a copy of the server where its own is still in place.
    const kp = await kitPlugin(route, generation, { tools, env, hash: o.io?.setup?.hash, kitDir: o.io?.kitDir });
    if (kp) {
      report.run.plugin = kp.plugin;
      cleanups.push(kp.done);
      if (kp.exe) entry.chat!.startCommand![0] = kp.exe;
      log(
        kp.plugin === 'kit'
          ? `${route.server} runs the kit's build of its plugin, as this PC does`
          : kp.plugin === 'kit-copy'
            ? `${route.server}'s own plugin is in place, not the kit's build this PC runs once the keeper puts it in: the run takes a copy of ${route.server} with the kit's build (${path.dirname(kp.exe!)}), removed after it`
            : kp.plugin === 'server'
              ? `${route.server} runs its own plugin, as ${kp.why}: shown, not ranked`
              : `${route.server}'s plugin is neither its own nor the kit's build (an update?): it runs as it is`,
      );
    }
  }

  // 3. The conditions. With --energy, the PC is held awake with its screen on from here to the end (holdAwake, kit
  // 2.99.0), so every rest and batch is the awake PC's, and Windows' log says whether it went into standby all the same.
  const awakeSince = new Date();
  if (o.energy) {
    cleanups.push((o.io?.awake ?? holdAwake)());
    report.conditions.awake = true;
  }
  // How busy the processor is before the start. A busy one is waited for, up to the suite's waitMinutes (kit 2.99.0),
  // so a run in a series starts once whatever else ran has finished; then it runs as it is.
  const sampleBusy = async () => {
    const busy: number[] = [];
    for (let i = 0; i < suite.quiet.samples; i++) {
      const b = await (o.io?.cpuBusy ?? cpuBusy)();
      if (b !== null) busy.push(b);
      if (i < suite.quiet.samples - 1) await sleep(suite.quiet.everyMs);
    }
    return busy.length ? Math.round(busy.reduce((a, b) => a + b, 0) / busy.length) : null;
  };
  report.conditions.cpuBusyPercent = await sampleBusy();
  const rounds = Math.ceil(((suite.quiet.waitMinutes ?? 0) * 60_000) / Math.max(1, suite.quiet.samples * suite.quiet.everyMs));
  if (rounds && report.conditions.cpuBusyPercent !== null && report.conditions.cpuBusyPercent > suite.quiet.cpuBusyMax) {
    log(`the processor is ${report.conditions.cpuBusyPercent}% busy: waiting up to ${suite.quiet.waitMinutes} minutes for it to come under ${suite.quiet.cpuBusyMax}%`);
    for (let i = 0; i < rounds && report.conditions.cpuBusyPercent !== null && report.conditions.cpuBusyPercent > suite.quiet.cpuBusyMax; i++) report.conditions.cpuBusyPercent = await sampleBusy();
    log(`the processor is ${report.conditions.cpuBusyPercent ?? '?'}% busy: starting`);
  }

  // A rest, read once the PC has settled (settle, kit 2.99.0), and said where it had to wait or never did. The battery's
  // reading wobbles too much to settle: it is read as it is, as before.
  const atRest = async (m: Meter) => {
    const every = suite.energy.settleSeconds;
    if (every && m.kind !== 'battery') {
      const minutes = suite.energy.settleMinutes ?? 3;
      const st = await settle(m, { now, sleep, seconds: every, minutes });
      const [first, last] = [st.draws[0], st.draws[st.draws.length - 1]];
      if (!st.settled && st.draws.length > 1) log(`energy: the PC's draw didn't settle in ${minutes} minutes (${watts(first)} at first, ${watts(last)} last): read as it is`);
      else if (st.draws.length > 2) log(`energy: waited ${Math.round(st.seconds)} s for the PC to settle (${watts(first)} at first, ${watts(last)} settled)`);
    }
    return measureSpan(m, { now, sleep, ms: suite.energy.restSeconds * 1000 });
  };

  // Energy (--energy): the meter, and the PC at rest with no model loaded, before the server starts. The battery's
  // reading is too coarse for the rests and batches (Energy, in the spec): it measures the triage minutes alone, as before.
  let meter: Meter | null = null;
  let unloaded: Span | null = null;
  if (o.energy) {
    const opened = await openMeter(o.meter, { onBattery: report.conditions.onBattery, io: { now, ...o.io?.meter, dischargeRate: o.io?.dischargeRate ?? o.io?.meter?.dischargeRate } });
    if ('why' in opened) log(`energy: not measured: ${opened.why}`);
    else {
      meter = opened.meter;
      log(`energy: the meter is ${meter.say}`);
      if (meter.kind !== 'battery') {
        unloaded = await atRest(meter);
        log(`energy at rest, no model loaded: ${unloaded ? partsSay(meter, unloaded.milliwatts) : 'no reading'}`);
      }
    }
  }

  // 4. The server, measured.
  // The entry carries the route's quirks, and the client's requests are the kit's own (chatBody, visionBody), so they
  // take them as an agent's do: GenieX's nonce first in every request, which stops it reusing a shared prefix's state
  // across the tries of one prompt (prefix-leak). Its pictures go as files (image-path), below.
  const acc = readAccelerator(entry) as Accelerator;
  if (acc.quirks.length) log(`${route.server}'s requests as the kit sends them: ${acc.quirks.map((q) => QUIRK_SAYS[q] ?? q).join('; ')}`);
  const client = serverClient(acc, { http: o.io?.fetch, now });
  const logFile = path.join(tools, 'servers', 'logs', `npu-bench-${vendor}.log`);
  const start = o.io?.start ?? startServer;
  if (await client.listening(5_000)) return finish(1, { code: 'start', say: `something already answers at ${client.ep.baseUrl} (the keeper's server?): stop it first, so the benchmark has the server to itself` });
  const cacheArg = route.serve.indexOf('--cache_dir');
  if (cacheArg >= 0) {
    const dir = route.serve[cacheArg + 1].replace('{tools}', tools);
    (o.io?.clearCache ?? ((p: string) => existsSync(p) && rmSync(p, { recursive: true, force: true })))(dir);
  }
  const coldMs = route.timeouts.coldLoadMs ?? 180_000;
  const stepMs = Math.max(10 * 60_000, coldMs * 2);
  const startLimit = Math.max(20 * 60_000, coldMs * 5);
  const streamedSeen: boolean[] = [];
  const usageSeen: boolean[] = [];
  const ask = async (q: { prompt: string; maxTokens: number; image?: string }): Promise<Streamed> => {
    const r = await client.askStream(q, stepMs);
    if (r.ok) {
      streamedSeen.push(r.streamed);
      usageSeen.push(!!r.usage?.completion_tokens);
    }
    return r;
  };
  // Every read and job is asked fresh (freshPrompt): this run's tag, then a count, never the same twice.
  type Question = { prompt: string; maxTokens: number };
  const runTag = Math.random().toString(36).slice(2, 8);
  let asked = 0;
  const fresh = (q: Question) => (): Question => ({ ...q, prompt: freshPrompt(q.prompt, `bench ${runTag}-${++asked}`) });
  const loadAndAnswer = async () => {
    const t0 = now();
    const up = await client.untilAnswers(startLimit);
    if (up === null) return null;
    const first = await ask({ prompt: suite.short.prompt, maxTokens: suite.short.maxTokens });
    return first.ok && saysReady(first.raw) ? Math.round(now() - t0) : null;
  };
  let server = await start(entry, logFile);
  try {
    report.results.coldLoadMs = await loadAndAnswer();
    log(`cold load: ${report.results.coldLoadMs === null ? `no correct answer (see ${logFile})` : `${(report.results.coldLoadMs / 1000).toFixed(1)} s to the first answer`}`);
    if (report.results.coldLoadMs === null) return finish(1, { code: 'start', say: `${route.server} didn't load and answer "ready": see ${logFile}` });

    // The model loaded and idle (--energy), just after the cold load: what keeping it loaded costs, against no model.
    let loaded: Span | null = null;
    if (meter && meter.kind !== 'battery') {
      loaded = await atRest(meter);
      const w = meter.whole;
      log(`energy at rest, the model loaded: ${loaded ? partsSay(meter, loaded.milliwatts) : 'no reading'}${loaded && unloaded && w in loaded.milliwatts && w in unloaded.milliwatts ? `; keeping it loaded: ${watts(loaded.milliwatts[w] - unloaded.milliwatts[w])}` : ''}`);
    }

    /** A measurement: warm-ups, then the tries, each one value from its answer (null when it failed); `q` a question, or one fresh each time. */
    const tryTimes = async (q: Question | (() => Question), value: (r: Streamed) => number | null, onEach?: (r: Streamed) => void) => {
      const next = typeof q === 'function' ? q : () => q;
      for (let i = 0; i < suite.warmups; i++) await ask(next());
      const xs: number[] = [];
      for (let i = 0; i < tries; i++) {
        const r = await ask(next());
        onEach?.(r);
        const v = r.ok ? value(r) : null;
        xs.push(v ?? Number.NaN);
      }
      return measure(xs, suite.steady.maxSpread);
    };
    report.results.short = await tryTimes(suite.short, (r) => (grade(suite.short.grade, r.answer) ? r.ms : null));
    log(`short answer: ${report.results.short.median} ms`);
    report.results.writeTokensPerSecond = await tryTimes(suite.write, (r) => r.tokensPerSecond ?? (r.usage?.completion_tokens ? r.usage.completion_tokens / (r.ms / 1000) : null));
    log(`writing: ${report.results.writeTokensPerSecond.median} tokens a second`);
    for (const n of suite.read.sizes) {
      report.results.readFirstTokenMs[String(n)] = await tryTimes(fresh({ prompt: readPrompt(suite, n), maxTokens: suite.read.maxTokens }), (r) => r.firstTokenMs ?? r.ms);
      log(`reading ${n} tokens: ${report.results.readFirstTokenMs[String(n)].median} ms to the first token`);
    }
    if (route.maxContextTokens * suite.read.capShare > Math.max(...suite.read.sizes)) {
      const r = await ask(fresh({ prompt: readPrompt(suite, Math.round(route.maxContextTokens * suite.read.capShare) - suite.read.maxTokens), maxTokens: suite.read.maxTokens })());
      report.results.readAtCap = { promptTokens: Number(r.usage?.prompt_tokens) || null, firstTokenMs: r.ok ? (r.firstTokenMs ?? r.ms) : null };
      log(`reading near the cap (${report.results.readAtCap.promptTokens ?? '?'} of ${route.maxContextTokens} tokens): ${report.results.readAtCap.firstTokenMs ?? 'no answer'} ms to the first token`);
    }
    for (const job of suite.jobs) {
      let passed = 0;
      const answerTokens: (number | null)[] = [];
      const firstTokenMs: (number | null)[] = [];
      const m = await tryTimes(fresh({ prompt: promptOf(suite, job), maxTokens: job.maxTokens }), (r) => r.ms, (r) => {
        if (r.ok && grade(job.grade, r.answer)) passed++;
        answerTokens.push(r.ok ? Number(r.usage?.completion_tokens) || null : null);
        firstTokenMs.push(r.ok ? r.firstTokenMs : null);
      });
      report.results.jobs[job.id] = { ...jobMeasure(m.tries, answerTokens, firstTokenMs, suite.steady.maxSpread), passed };
      log(`the ${job.id} job: ${m.median} ms, ${passed} of ${tries} answered correctly`);
    }
    const jobMedians = suite.jobs.map((j) => report.results.jobs[j.id]?.median);
    report.results.jobTimeS = jobMedians.every((x) => typeof x === 'number') ? Number(((jobMedians as number[]).reduce((a, b) => a + b, 0) / 1000).toFixed(2)) : null;
    log(`job time: ${report.results.jobTimeS ?? '—'} s`);

    for (const item of suite.quality) {
      const r = await ask({ prompt: promptOf(suite, item), maxTokens: item.maxTokens });
      report.quality.items.push({ id: item.id, kind: item.kind ?? 'instruction', ok: r.ok && grade(item.grade, r.answer), answer: (r.ok ? r.answer : `(${r.error})`).slice(0, 120), ms: r.ms });
    }
    report.quality.passed = report.quality.items.filter((x) => x.ok).length;
    report.quality.score = Number((report.quality.passed / report.quality.of).toFixed(3));
    report.quality.mustPass = suite.quality.filter((x) => x.mustPass).every((x) => report.quality.items.find((i) => i.id === x.id)?.ok);
    report.quality.gate = report.quality.mustPass && report.quality.score >= suite.gate.score;
    log(`quality: ${report.quality.passed} of ${report.quality.of}${report.quality.mustPass ? '' : ', a must-pass question wrong'}${report.quality.items.some((x) => !x.ok) ? ` (wrong: ${report.quality.items.filter((x) => !x.ok).map((x) => x.id).join(', ')})` : ''}`);

    if (acc.vision?.model && suite.vision.length) {
      // A server that reads a local path (GenieX: image-path) gets each picture as a file, as an agent's pictures go to
      // it; a `data:` URL is sent as it is, whatever the quirk says (imageUrl), and GenieX doesn't read one. FastFlowLM's
      // (sides-of-32) are fitted as an agent's are (fitPicture, in serverClient): three of the suite's four have such sides.
      const { imageOf, done } = pictureInputs(acc.quirks.includes('image-path'));
      try {
        // A warm-up, as every measurement has: GenieX holds one model at a time, and a server may load its vision part
        // only for the first picture. Neither is a picture's time.
        for (let i = 0; i < suite.warmups; i++) await ask({ prompt: suite.vision[0].prompt, maxTokens: suite.vision[0].maxTokens, image: imageOf(suite.vision[0]) });
        const items: NonNullable<BenchReport['vision']>['items'] = [];
        for (const v of suite.vision) {
          const r = await ask({ prompt: v.prompt, maxTokens: v.maxTokens, image: imageOf(v) });
          items.push({ id: v.id, ok: r.ok && grade(v.grade, r.answer), answer: (r.ok ? r.answer : `(${r.error})`).slice(0, 120), ms: r.ms });
        }
        report.vision = { passed: items.filter((x) => x.ok).length, of: items.length, items };
        log(`vision: ${report.vision.passed} of ${report.vision.of}`);
      } finally {
        done();
      }
    }

    report.results.memory = server.pid ? await (o.io?.memory ?? processMemory)(server.pid) : null;

    // A start again, from the compile cache.
    await server.stop();
    await client.untilGone();
    server = await start(entry, logFile);
    report.results.cachedLoadMs = await loadAndAnswer();
    log(`cached load: ${report.results.cachedLoadMs === null ? 'no correct answer' : `${(report.results.cachedLoadMs / 1000).toFixed(1)} s`}`);

    const jobById = (id: string) => suite.jobs.find((j) => j.id === id) ?? suite.jobs[0];
    if (profile === 'full') {
      // Holding speed: one job back to back, the first minute against the last.
      const job = jobById(suite.holding.job);
      const q = fresh({ prompt: promptOf(suite, job), maxTokens: job.maxTokens });
      const t0 = now();
      const done: { at: number; ms: number }[] = [];
      while (now() - t0 < suite.holding.minutes * 60_000) {
        const r = await ask(q());
        if (!r.ok) break;
        done.push({ at: now() - t0, ms: r.ms });
      }
      const minute = (from: number, to: number) => measure(done.filter((x) => x.at >= from && x.at < to).map((x) => x.ms), 1).median;
      const end = suite.holding.minutes * 60_000;
      const first = minute(0, 60_000);
      const last = minute(end - 60_000, end + 60_000);
      report.results.holding = { minutes: suite.holding.minutes, firstMinuteMs: first, lastMinuteMs: last, held: first && last ? Number((first / last).toFixed(3)) : null };
      log(`holding speed: ${report.results.holding.held === null ? '—' : `${Math.round(report.results.holding.held * 100)}% after ${suite.holding.minutes} minutes`}`);
    }
    if (meter) {
      const m = meter;
      const whole = m.whole;
      const span = (x: { ms?: number; work?: () => Promise<void>; during?: () => Promise<void> }) => measureSpan(m, { now, sleep, ...x });
      const chargingNow = m.kind === 'battery' ? false : await (o.io?.charging ?? charging)();
      if (chargingNow && m.kind !== 'nvidia') log(`energy: the battery is charging, so the whole PC's figures (${whole}) carry its charge, and each part's don't: for whole-PC figures, run it with the battery full`);
      const job = jobById(suite.energy.job);
      const q = fresh({ prompt: promptOf(suite, job), maxTokens: job.maxTokens });
      const tokensOf = (r: Streamed) => (Number(r.usage?.prompt_tokens) || 0) + (Number(r.usage?.completion_tokens) || 0);
      let jobs = 0;
      let tokens = 0;
      const rest = await atRest(m);
      const load = await span({
        ms: suite.energy.loadMinutes * 60_000,
        during: async () => {
          const r = await ask(q());
          if (r.ok) {
            jobs++;
            tokens += tokensOf(r);
          }
        },
      });
      if (rest && load && whole in rest.milliwatts && whole in load.milliwatts) {
        const restMw = rest.milliwatts[whole];
        const loadMw = load.milliwatts[whole];
        const extraJoules = ((loadMw - restMw) / 1000) * load.seconds;
        // Working that draws no clearly more than rest is the battery's reading wobbling, not the model's energy:
        // on the Lunar Lake laptop the rate read 28 W at rest, nearly twice its real drain, and less working (NPU-BENCHMARK.md).
        // A meter that keeps totals, or a plug's or a card's own reading, doesn't wobble so: any more than rest counts.
        const clear = m.kind === 'battery' ? loadMw - restMw >= Math.max(ENERGY_MIN_EXTRA.milliwatts, restMw * ENERGY_MIN_EXTRA.share) : loadMw > restMw;
        const e: NonNullable<BenchReport['results']['energy']> = { restMilliwatts: Math.round(restMw), loadMilliwatts: Math.round(loadMw), jobs, tokens, millijoulesPerToken: clear && tokens ? Number(((extraJoules * 1000) / tokens).toFixed(3)) : null };
        report.results.energy = e;
        if (clear) log(`energy: ${e.millijoulesPerToken} mJ a token (${Math.round(restMw)} mW at rest, ${Math.round(loadMw)} mW working)`);
        else log(`energy: not counted: working read ${Math.round(loadMw)} mW against ${Math.round(restMw)} mW at rest, too little more for ${m.kind === 'battery' ? "the battery's reading" : 'the meter'} to tell the model's share`);
        if (m.kind !== 'battery') {
          const round = roundParts;
          e.meter = { kind: m.kind, say: m.say, whole };
          e.charging = chargingNow;
          e.idle = { unloadedMilliwatts: unloaded ? round(unloaded.milliwatts) : null, loadedMilliwatts: loaded ? round(loaded.milliwatts) : null, keepLoadedMilliwatts: unloaded && loaded && whole in unloaded.milliwatts && whole in loaded.milliwatts ? Math.round(loaded.milliwatts[whole] - unloaded.milliwatts[whole]) : null };
          e.restParts = round(rest.milliwatts);
          e.loadParts = round(load.milliwatts);
          e.batches = {};
          const batches = e.batches;
          // Fixed batches of the agents' work, each a stretch of its own, against the PC at rest just before: what one of
          // each costs, by part. A batch's tries are fresh prompts, as every read and job is.
          const batch = async (id: string, what: string, count: number, one: (i: number) => Promise<{ ok: boolean; tokens: number }>) => {
            const b = await energyBatch(m, rest, count, one, { now, sleep, what, log });
            if (b) batches[id] = b;
          };
          const count = suite.energy.batch?.[profile] ?? 0;
          if (count) {
            for (const j of suite.jobs)
              await batch(j.id, `${j.id} jobs`, count, async () => {
                const r = await ask(fresh({ prompt: promptOf(suite, j), maxTokens: j.maxTokens })());
                return { ok: r.ok && grade(j.grade, r.answer), tokens: r.ok ? tokensOf(r) : 0 };
              });
            const size = Math.max(...suite.read.sizes);
            await batch(`read-${size}`, `reads of ${size} tokens`, count, async () => {
              const r = await ask(fresh({ prompt: readPrompt(suite, size), maxTokens: suite.read.maxTokens })());
              return { ok: r.ok, tokens: r.ok ? tokensOf(r) : 0 };
            });
            if (acc.vision?.model && suite.vision.length) {
              // One picture first, untimed, as for vision above: GenieX loads its vision part for a picture after text.
              // No more than twice the suite's pictures: GenieX's DSP gives out after about a dozen vision loads in one
              // process (ACCELERATORS.md), and a run's second process has sent none before this.
              const pics = pictureInputs(acc.quirks.includes('image-path'));
              try {
                const v0 = suite.vision[0];
                await ask({ prompt: v0.prompt, maxTokens: v0.maxTokens, image: pics.imageOf(v0) });
                await batch('pictures', 'pictures', Math.min(count, suite.vision.length * 2), async (i) => {
                  const v = suite.vision[i % suite.vision.length];
                  const r = await ask({ prompt: v.prompt, maxTokens: v.maxTokens, image: pics.imageOf(v) });
                  return { ok: r.ok && grade(v.grade, r.answer), tokens: r.ok ? tokensOf(r) : 0 };
                });
              } finally {
                pics.done();
              }
            }
          }
        }
      } else log(m.kind === 'battery' ? 'energy: the battery gave no discharge rate' : `energy: ${m.say} gave no reading`);
    }
  } finally {
    await server.stop();
    await client.untilGone();
  }

  // 5. Embeddings (kit 2.99.0), once the chat server has stopped: the route's embedding server (the NPU's own, or on the
  // run's device where it moves with it), or llama.cpp's beside the model off the NPU, started by itself as an agent's
  // first request starts it. A query, and requests of the suite's texts (embedTexts, each request's its own), timed
  // warm; with a meter, the PC at rest with it loaded (what keeping it loaded costs, against no model) and a batch of
  // those requests.
  const ee = entry.embed;
  if (suite.embed && ee?.baseUrl && ee.startCommand?.length && ee.baseUrl !== entry.chat?.baseUrl) {
    const se = suite.embed;
    const ep = { baseUrl: ee.baseUrl, model: ee.model };
    const http = o.io?.fetch ?? longFetch;
    const embedLog = path.join(tools, 'servers', 'logs', `npu-bench-${vendor}-embed.log`);
    const eAsk = (input: string | string[]) => embedAsk(http, ep, input, stepMs, now);
    const texts = () => embedTexts(suite, `embed ${runTag}-${++asked}`);
    // Until it no longer takes connections, or 30 seconds.
    const gone = async () => {
      const t = now();
      while (now() - t < 30_000) {
        try {
          await (await http(`${ep.baseUrl}/v1/models`, { signal: AbortSignal.timeout(1_000) })).text();
        } catch (e) {
          if (refusedConnection(e)) return;
        }
        await sleep(250);
      }
    };
    const eServer = await start({ ...entry, chat: ee }, embedLog);
    try {
      // Until it gives a vector: a server loading its model answers 503, or not at all, meanwhile.
      const t0 = now();
      let first = await eAsk(se.query);
      while (!first.ok && now() - t0 < Math.max(5 * 60_000, coldMs * 2)) {
        await sleep(500);
        first = await eAsk(se.query);
      }
      if (!first.ok) {
        report.results.embed = null;
        log(`embeddings: no vector after a start (${first.error}): see ${embedLog}`);
      } else {
        const loadMs = Math.round(now() - t0);
        const tryEmbed = async (input: () => string | string[]) => {
          for (let i = 0; i < suite.warmups; i++) await eAsk(input());
          const ms: number[] = [];
          const tk: number[] = [];
          for (let i = 0; i < tries; i++) {
            const r = await eAsk(input());
            ms.push(r.ok ? r.ms : Number.NaN);
            if (r.ok && r.tokens) tk.push(r.tokens);
          }
          return { m: measure(ms, suite.steady.maxSpread), tokens: medianOf(tk) };
        };
        const query = await tryEmbed(() => se.query);
        const request = await tryEmbed(texts);
        const perSecond = request.tokens && request.m.median ? Math.round(request.tokens / (request.m.median / 1000)) : null;
        report.results.embed = { server: off ? off.server : `${route.embedServer?.server ?? route.server} ${route.embedServer?.version ?? route.version}`, model: ee.model, loadMs, queryMs: query.m, requestMs: request.m, texts: se.texts, tokens: request.tokens, tokensPerSecond: perSecond, dims: first.dims || null };
        log(`embeddings: ${ee.model}'s first vector ${(loadMs / 1000).toFixed(1)} s after a start; a query ${query.m.median} ms; ${se.texts} texts ${request.m.median} ms (${request.tokens ?? '?'} tokens, ${perSecond ?? '?'} a second)`);
        const energy = report.results.energy;
        if (meter && meter.kind !== 'battery' && energy) {
          const w = meter.whole;
          const idle = await atRest(meter);
          const keep = idle && unloaded && w in idle.milliwatts && w in unloaded.milliwatts ? Math.round(idle.milliwatts[w] - unloaded.milliwatts[w]) : null;
          energy.embed = { loadedMilliwatts: idle ? roundParts(idle.milliwatts) : null, keepLoadedMilliwatts: keep };
          log(`energy at rest, the embedding model loaded: ${idle ? partsSay(meter, idle.milliwatts) : 'no reading'}${keep !== null ? `; keeping it loaded: ${watts(keep)}` : ''}`);
          const count = se.batch[profile];
          if (idle && count) {
            const b = await energyBatch(meter, idle, count, async () => {
              const r = await eAsk(texts());
              return { ok: r.ok, tokens: r.tokens ?? 0 };
            }, { now, sleep, what: `embedding requests of ${se.texts} texts`, log });
            if (b) (energy.batches ??= {}).embed = b;
          }
        }
      }
    } finally {
      await eServer.stop();
      await gone();
    }
  } else if (suite.embed) {
    report.results.embed = null;
    log(`embeddings: not measured: ${!off && !route.embedServer ? `${route.server}'s route has no embedding server${route.embeddings ? ` (${route.embeddings.split(/[:;.]/)[0]})` : ''}` : 'its embedding server wasn\'t set up'}`);
  }

  report.run.streamed = streamedSeen.length ? streamedSeen.every(Boolean) : null;
  report.run.usageReported = usageSeen.length ? usageSeen.every(Boolean) : null;
  if (report.conditions.awake) {
    report.conditions.standby = await (o.io?.standby ?? standbyCount)(awakeSince);
    if (report.conditions.standby) log(`the PC went into standby during the run, held awake as it was (a lid closed, the power button?): its figures aren't the awake PC's`);
  }
  const r = finish(0);
  log(r.report.ranked ? 'Ranked: it met every condition.' : `Not ranked: ${r.report.marks.map((m) => m.say).join('; ')}`);
  return r;
}

// ------------------------------------------------------------------------------------------------
// Several runs, and their summary (kit 2.99.0)

/** One device's runs, each figure their median (the runs that have it): what NPU-BENCHMARK.md's "Reading a summary" reads. */
export interface DeviceSummary {
  runs: number;
  ranked: number;
  server: string | null;
  model: string | null;
  /** Every mark any of its runs had, by code. */
  marks: string[];
  coldLoadMs: number | null;
  shortMs: number | null;
  writeTokensPerSecond: number | null;
  /** Each read size's time to the first token. */
  readFirstTokenMs: Record<string, number | null>;
  jobTimeS: number | null;
  quality: number | null;
  vision: number | null;
  embed: { queryMs: number | null; requestMs: number | null; tokensPerSecond: number | null } | null;
  energy: {
    /** What keeping the model loaded costs the whole PC, against no model: at rest, and over a day. */
    keepLoadedMilliwatts: number | null;
    keepLoadedWhPerDay: number | null;
    /** The same for the embedding model, on its own. */
    embedKeepLoadedMilliwatts: number | null;
    embedKeepLoadedWhPerDay: number | null;
    /** The triage minutes' energy a token over rest (the figure every report since kit 2.62.0 has). */
    millijoulesPerToken: number | null;
    /** Each batch: one job's energy over rest (the whole PC's, and each part's), a token's, and the whole PC's for the batch and its time. */
    batches: Record<string, { count: number | null; millijoulesEach: number | null; millijoulesPerToken: number | null; wholeMillijoules: number | null; seconds: number | null; eachByPart: Record<string, number | null> }>;
  } | null;
}

export interface BenchSummary {
  format: 'castellan-npu-bench-summary/1';
  suite: string;
  kit: string;
  profile: 'quick' | 'full';
  at: string;
  pc: { cpu: string | null; chip: string | null };
  /** The meter's part that is the whole PC, where the runs had a meter. */
  whole: string | null;
  devices: Record<string, DeviceSummary>;
}

const med = (xs: (number | null | undefined)[], digits = 0): number | null => {
  const m = medianOf(xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)));
  return m === null ? null : Number(m.toFixed(digits));
};
const whPerDay = (mw: number | null) => (mw === null ? null : Number(((mw * 24) / 1000).toFixed(1)));

/** Each device's runs summed up: every figure the median of the runs that have it, so one run's hiccup doesn't move it. */
export function benchSummary(reports: BenchReport[]): BenchSummary {
  const first = reports[0];
  const devices: Record<string, DeviceSummary> = {};
  for (const device of [...new Set(reports.map((r) => r.run.device))]) {
    const rs = reports.filter((r) => r.run.device === device);
    const es = rs.map((r) => r.results.energy).filter((e): e is NonNullable<typeof e> => !!e);
    const batchIds = [...new Set(es.flatMap((e) => Object.keys(e.batches ?? {})))];
    const sizes = [...new Set(rs.flatMap((r) => Object.keys(r.results.readFirstTokenMs)))];
    const embeds = rs.map((r) => r.results.embed).filter((x): x is NonNullable<typeof x> => !!x);
    const keep = med(es.map((e) => e.idle?.keepLoadedMilliwatts));
    const embedKeep = med(es.map((e) => e.embed?.keepLoadedMilliwatts));
    devices[device] = {
      runs: rs.length,
      ranked: rs.filter((r) => r.ranked).length,
      server: rs.find((r) => r.run.server)?.run.server ?? null,
      model: rs.find((r) => r.run.model)?.run.model ?? null,
      marks: [...new Set(rs.flatMap((r) => r.marks.map((m) => m.code)))],
      coldLoadMs: med(rs.map((r) => r.results.coldLoadMs)),
      shortMs: med(rs.map((r) => r.results.short?.median)),
      writeTokensPerSecond: med(rs.map((r) => r.results.writeTokensPerSecond?.median), 1),
      readFirstTokenMs: Object.fromEntries(sizes.map((n) => [n, med(rs.map((r) => r.results.readFirstTokenMs[n]?.median))])),
      jobTimeS: med(rs.map((r) => r.results.jobTimeS), 2),
      quality: med(rs.map((r) => (r.quality.score === null ? null : r.quality.passed))),
      vision: med(rs.map((r) => r.vision?.passed)),
      embed: embeds.length ? { queryMs: med(embeds.map((x) => x.queryMs.median)), requestMs: med(embeds.map((x) => x.requestMs.median)), tokensPerSecond: med(embeds.map((x) => x.tokensPerSecond)) } : null,
      energy: es.length
        ? {
            keepLoadedMilliwatts: keep,
            keepLoadedWhPerDay: whPerDay(keep),
            embedKeepLoadedMilliwatts: embedKeep,
            embedKeepLoadedWhPerDay: whPerDay(embedKeep),
            millijoulesPerToken: med(es.map((e) => e.millijoulesPerToken), 3),
            batches: Object.fromEntries(
              batchIds.map((id) => {
                const bs = es.map((e) => ({ b: e.batches?.[id], whole: e.meter?.whole })).filter((x): x is { b: EnergyBatch; whole: string | undefined } => !!x.b);
                const parts = [...new Set(bs.flatMap((x) => Object.keys(x.b.extraMillijoules)))];
                return [
                  id,
                  {
                    count: med(bs.map((x) => x.b.count)),
                    millijoulesEach: med(bs.map((x) => x.b.millijoulesEach)),
                    millijoulesPerToken: med(bs.map((x) => x.b.millijoulesPerToken), 3),
                    wholeMillijoules: med(bs.map((x) => (x.whole ? x.b.millijoules[x.whole] : null))),
                    seconds: med(bs.map((x) => x.b.seconds), 2),
                    eachByPart: Object.fromEntries(parts.map((p) => [p, med(bs.map((x) => (p in x.b.extraMillijoules ? x.b.extraMillijoules[p] / x.b.count : null)))])),
                  },
                ];
              }),
            ),
          }
        : null,
    };
  }
  return {
    format: 'castellan-npu-bench-summary/1',
    suite: first?.suite.version ?? SUITE.version,
    kit: first?.suite.kit ?? 'unknown',
    profile: first?.suite.profile ?? 'quick',
    at: new Date().toISOString(),
    pc: { cpu: first?.pc.cpu ?? null, chip: first?.pc.chip ?? null },
    whole: reports.map((r) => r.results.energy?.meter?.whole).find(Boolean) ?? null,
    devices,
  };
}

/** The summary as a table, a column a device, for the log and the PR. */
export function summarySay(s: BenchSummary): string[] {
  const ds = Object.keys(s.devices);
  const rows: [string, (d: DeviceSummary) => string][] = [];
  const n = (x: number | null, unit = '') => (x === null ? '—' : `${x.toLocaleString('en-GB')}${unit}`);
  const j = (mj: number | null) => (mj === null ? '—' : mj >= 1000 ? `${(mj / 1000).toFixed(mj >= 10_000 ? 1 : 2)} J` : `${mj} mJ`);
  rows.push(['runs (ranked)', (d) => `${d.runs} (${d.ranked})`]);
  rows.push(['server', (d) => (d.server ?? '—').replace(/^llama\.cpp (b\d+) \((.+)\)$/, 'llama.cpp $1 $2')]);
  rows.push(['first answer after a start', (d) => n(d.coldLoadMs === null ? null : Number((d.coldLoadMs / 1000).toFixed(1)), ' s')]);
  rows.push(['short answer', (d) => n(d.shortMs, ' ms')]);
  rows.push(['writing', (d) => n(d.writeTokensPerSecond, ' tokens/s')]);
  for (const size of [...new Set(ds.flatMap((x) => Object.keys(s.devices[x].readFirstTokenMs)))]) rows.push([`reading ${size} tokens`, (d) => n(d.readFirstTokenMs[size] ?? null, ' ms')]);
  rows.push(['job time', (d) => n(d.jobTimeS, ' s')]);
  rows.push(['quality (of 24)', (d) => n(d.quality)]);
  rows.push(['pictures (of 4)', (d) => n(d.vision)]);
  rows.push(['embedding a query', (d) => n(d.embed?.queryMs ?? null, ' ms')]);
  rows.push(['embedding texts', (d) => n(d.embed?.tokensPerSecond ?? null, ' tokens/s')]);
  if (ds.some((x) => s.devices[x].energy)) {
    // Less than nothing is the rests' own wobble, more than what keeping it loaded costs: too small to tell.
    const keep = (mw: number | null | undefined, wh: number | null | undefined) => (mw == null ? '—' : mw < 0 ? `too small to tell (${n(mw, ' mW')})` : `${n(mw, ' mW')} (${n(wh ?? null, ' Wh/day')})`);
    rows.push(['keeping the model loaded', (d) => keep(d.energy?.keepLoadedMilliwatts, d.energy?.keepLoadedWhPerDay)]);
    rows.push(['keeping the embedder loaded', (d) => keep(d.energy?.embedKeepLoadedMilliwatts, d.energy?.embedKeepLoadedWhPerDay)]);
    rows.push(['triage minutes, a token over rest', (d) => n(d.energy?.millijoulesPerToken ?? null, ' mJ')]);
    for (const id of [...new Set(ds.flatMap((x) => Object.keys(s.devices[x].energy?.batches ?? {})))]) {
      rows.push([`${id}: each over rest`, (d) => j(d.energy?.batches[id]?.millijoulesEach ?? null)]);
      rows.push([`${id}: a token over rest`, (d) => n(d.energy?.batches[id]?.millijoulesPerToken ?? null, ' mJ')]);
      rows.push([`${id}: the whole PC, the batch`, (d) => {
        const b = d.energy?.batches[id];
        return b?.wholeMillijoules == null ? '—' : `${j(b.wholeMillijoules)} in ${n(b.seconds, ' s')}`;
      }]);
    }
  }
  const cells = rows.map(([name, f]) => [name, ...ds.map((x) => f(s.devices[x]))]);
  const widths = [0, ...ds].map((_, i) => Math.max(...[['', ...ds], ...cells].map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [`Summary: ${s.suite}, ${s.profile}, each figure the median of its runs${s.whole ? ` (the whole PC is the meter's ${s.whole})` : ''}`, line(['', ...ds]), ...cells.map(line)];
}

/**
 * Several runs: each device in turn, a round at a time (NPU, GPU, CPU, then again), so whatever drifts in the PC (its
 * warmth, what else runs) falls on every device alike, each run waiting for a quiet processor (suite.quiet.waitMinutes).
 * Each run writes its report as one run does; then the summary of them all (benchSummary) is written beside them and
 * printed. A device refused as a bad request (code 2: no llama.cpp form of the model, say) isn't tried again.
 */
export async function npuBenchSeries(o: NpuBenchOptions & { devices: string[]; runs: number }): Promise<{ code: number; reports: BenchReport[]; summary: BenchSummary; file: string | null }> {
  const log = o.log ?? console.log;
  const reports: BenchReport[] = [];
  let devices = [...o.devices];
  let worst = 0;
  for (let round = 1; round <= o.runs && devices.length; round++) {
    for (const device of [...devices]) {
      log(`Run ${round} of ${o.runs}: the ${device}`);
      const out = o.out ? o.out.replace(/(\.json)?$/i, `-${device.toLowerCase()}-${round}.json`) : undefined;
      const r = await npuBench({ ...o, device, out });
      reports.push(r.report);
      worst = Math.max(worst, r.code);
      if (r.code === 2) devices = devices.filter((d) => d !== device);
    }
  }
  const summary = benchSummary(reports);
  for (const l of summarySay(summary)) log(l);
  const vendor = reports[0]?.run.vendor ?? 'none';
  const file = o.out ? o.out.replace(/(\.json)?$/i, '-summary.json') : path.join(o.tools ?? toolsHome(o.env ?? process.env), `npu-bench-summary-${vendor}-${summary.at.slice(0, 19).replace(/[:T]/g, '-')}.json`);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
    log(`The summary: ${file}`);
    return { code: worst, reports, summary, file };
  } catch (e: any) {
    log(`The summary couldn't be written to ${file}: ${e?.message ?? e}`);
    return { code: worst, reports, summary, file: null };
  }
}

// ------------------------------------------------------------------------------------------------
// The report's schema: json-schema.ts's small part of JSON Schema, which the NPU report (npu-report.ts) uses too

export { checkSchema };

// ------------------------------------------------------------------------------------------------
// As a command

export function parseBenchArgs(argv: string[]): NpuBenchOptions | { error: string } {
  const o: NpuBenchOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--no-setup') o.setup = false;
    else if (a === '--energy') o.energy = true;
    else if (a === '--meter') {
      const v = argv[++i];
      if (!v || !/^(auto|emi|nvidia|battery|shelly:.+)$/i.test(v)) return { error: '--meter takes auto, emi, shelly:<address>, nvidia or battery' };
      o.meter = v;
      o.energy = true;
    }
    else if (a === '--profile') {
      const v = argv[++i];
      if (v !== 'quick' && v !== 'full') return { error: '--profile takes quick or full' };
      o.profile = v;
    } else if (a === '--device') {
      const vs = (argv[++i] ?? '').toUpperCase().split(',');
      if (vs.some((v) => !/^(NPU|CPU|GPU)$/.test(v)) || new Set(vs).size < vs.length) return { error: '--device takes NPU, CPU or GPU, or several of them (NPU,GPU,CPU)' };
      if (vs.length > 1) o.devices = vs;
      else o.device = vs[0];
    } else if (a === '--runs') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 20) return { error: '--runs takes how many times each device runs, 1 to 20' };
      o.runs = v;
    } else if (a === '--summary') {
      o.summary = argv.slice(i + 1);
      if (!o.summary.length) return { error: '--summary takes the reports to sum up (npu-bench-*.json)' };
      i = argv.length;
    } else if (a === '--generation') {
      const v = argv[++i];
      if (!v) return { error: '--generation takes an older Snapdragon to play on this one (snapdragon-x)' };
      o.generation = v;
    } else if (a === '--small-pc') o.smallPc = true;
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--candidate') o.candidate = argv[++i];
    else if (a === '--vision') o.vision = true;
    else if (a === '--cap') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 256) return { error: '--cap takes a number of tokens, 256 or more' };
      o.cap = v;
    } else if (a === '--out') o.out = argv[++i];
    else if (a === '--mix') {
      // Optional day count: what this PC's agents sent over the last N days (30 when not given).
      const v = Number(argv[i + 1]);
      o.mix = Number.isInteger(v) && v > 0 ? (i++, v) : 30;
    } else return { error: `unknown argument ${a}` };
  }
  if (o.model && o.candidate) return { error: '--model and --candidate are one or the other' };
  if (o.vision && !o.candidate) return { error: "--vision says a --candidate sees: the route's own models already say what they do" };
  return o;
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const o = parseBenchArgs(process.argv.slice(2));
  if ('error' in o) {
    console.error(`${o.error}\nUsage: node npu-bench.ts [--profile quick|full] [--device NPU|GPU|CPU[,...]] [--runs <n>] [--model <id>] [--candidate <id> [--vision]] [--cap <tokens>] [--generation <id>] [--small-pc] [--energy] [--meter auto|emi|shelly:<address>|nvidia|battery] [--yes] [--no-setup] [--out <file>]\n       node npu-bench.ts --mix [days]\n       node npu-bench.ts --summary <report.json>...`);
    process.exit(2);
  }
  if (o.mix) {
    for (const line of mixSummary(readTally(o.mix))) console.log(line);
    process.exit(0);
  }
  if (o.summary) {
    const reports = o.summary.map((f) => JSON.parse(readFileSync(f, 'utf8')) as BenchReport);
    const summary = benchSummary(reports);
    for (const line of summarySay(summary)) console.log(line);
    const file = o.summary[0].replace(/(\.json)?$/i, '-summary.json');
    writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
    console.log(`The summary: ${file}`);
    process.exit(0);
  }
  const { code } = o.devices || o.runs ? await npuBenchSeries({ ...o, devices: o.devices ?? [o.device ?? 'NPU'], runs: o.runs ?? 1 }) : await npuBench(o);
  process.exit(code);
}
