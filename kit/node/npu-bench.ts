import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { type Accelerator, type AcceleratorEntry, type Quirk, readAccelerator, toolsHome } from './accelerator-config.ts';
import { type Detection, detect, runPowerShell } from './detect.ts';
import { routeOnDevice } from './npu-check.ts';
import { processMemory, type RunningServer, serverClient, setUpRoute, startServer, type Streamed } from './npu-server.ts';
import { expandRoute, NPU_CATALOG, type NpuCatalog, type NpuModel, type NpuRoute, type NpuSupport, type NpuVendor, NPU_VENDORS, pciDevice, planNpu, routeFor, sha256File } from './npu-vendors.ts';
import { mb, type NpuIo, saysReady } from './setup.ts';
import { mixSummary, readTally } from './token-tally.ts';

/**
 * The NPU benchmark (spec/NPU-BENCHMARK.md): a fixed, versioned suite (spec/npu-bench-suite.json), the same on every
 * PC, that measures how fast and how well a chip does Castellan's work with a model, for the website's boards. It sets
 * the route up as the NPU check does (without writing config.json), streams every request so reading and writing are
 * timed apart, grades the answers, records the conditions it ran in, and writes one report in a fixed format
 * (spec/npu-bench.schema.json). A run that doesn't meet the conditions is still reported, with marks saying why it
 * isn't ranked.
 *
 *   node <agent>\src\kit\npu-bench.ts [--profile quick|full] [--device NPU|GPU|CPU] [--model <id>] [--candidate <id> [--vision]]
 *                                     [--cap <tokens>] [--energy] [--yes] [--no-setup] [--out <file>]
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
  quiet: { cpuBusyMax: number; samples: number; everyMs: number };
  gate: { score: number; calibrated: boolean };
  holding: { minutes: number; job: string };
  energy: { restSeconds: number; loadMinutes: number; job: string };
  short: { prompt: string; maxTokens: number; grade: Grade };
  write: { prompt: string; maxTokens: number };
  read: { sizes: number[]; capShare: number; maxTokens: number; question: string };
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

export function measure(tries: number[], maxSpread: number): Measure {
  const xs = tries.filter((x) => Number.isFinite(x));
  if (!xs.length) return { tries, median: null, spread: null, steady: false };
  const s = [...xs].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const spread = median > 0 ? Number(((s[s.length - 1] - s[0]) / median).toFixed(3)) : 0;
  return { tries, median: Number(median.toFixed(2)), spread, steady: xs.length === tries.length && spread <= maxSpread };
}

export interface Mark {
  /** quick, rehearsal, battery, busy, not-streamed, no-usage, noisy, gate, job-failed, setup, start */
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
}

export interface BenchReport {
  format: 'castellan-npu-bench-report/1';
  suite: { version: string; kit: string; profile: 'quick' | 'full'; gate: Suite['gate'] };
  at: string;
  pc: { cpu: string | null; chip: string | null; npu: string | null; pciDevice: string | null; driver: string | null; driverDate: string | null; ramGb: number; windowsBuild: string | null; make: string | null; model: string | null };
  conditions: Conditions;
  run: { vendor: NpuVendor | null; device: string; server: string | null; model: string | null; candidate: boolean; cap: number | null; files: Record<string, { size: number; sha256: string }> | null; streamed: boolean | null; usageReported: boolean | null };
  results: {
    coldLoadMs: number | null;
    cachedLoadMs: number | null;
    short: Measure | null;
    writeTokensPerSecond: Measure | null;
    readFirstTokenMs: Record<string, Measure>;
    readAtCap: { promptTokens: number | null; firstTokenMs: number | null } | null;
    jobs: Record<string, Measure & { passed: number }>;
    jobTimeS: number | null;
    memory: { workingSetBytes: number; privateBytes: number } | null;
    holding: { minutes: number; firstMinuteMs: number | null; lastMinuteMs: number | null; held: number | null } | null;
    energy: { restMilliwatts: number; loadMilliwatts: number; jobs: number; tokens: number; millijoulesPerToken: number | null } | null;
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
  if (r.suite.profile === 'quick') marks.push({ code: 'quick', say: `a quick run tries each measurement ${suite.tries.quick} times, not ${suite.tries.full}: shown, not ranked` });
  if (r.conditions.onBattery) marks.push({ code: 'battery', say: 'it ran on the battery: speed is ranked plugged in (an energy figure from it still counts)' });
  if (r.conditions.cpuBusyPercent !== null && r.conditions.cpuBusyPercent > suite.quiet.cpuBusyMax) marks.push({ code: 'busy', say: `the processor was ${r.conditions.cpuBusyPercent}% busy before the start (no more than ${suite.quiet.cpuBusyMax}% for a ranked run)` });
  if (r.run.streamed === false) marks.push({ code: 'not-streamed', say: "the server didn't stream, so reading and writing are estimates" });
  if (r.run.usageReported === false) marks.push({ code: 'no-usage', say: "the server didn't report token counts, so they are estimates" });
  const noisy = [['short answer', res.short], ['writing', res.writeTokensPerSecond], ...Object.entries(res.readFirstTokenMs).map(([k, v]) => [`reading ${k} tokens`, v]), ...Object.entries(res.jobs).map(([k, v]) => [`the ${k} job`, v])].filter(([, m]) => m && !(m as Measure).steady && (m as Measure).median !== null).map(([n]) => n as string);
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

/** The battery's discharge rate in milliwatts (0 when plugged in), or null without a battery. */
async function dischargeRate(): Promise<number | null> {
  try {
    const out = await runPowerShell(`(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1).DischargeRate`, 20_000);
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
  return { ...route, models: [{ ...base, id, kinds, pull, ...(base.present ? { present: swap(base.present) } : {}), size: 0, licence: `a candidate (${id}): its licence is checked before it ships`, pinned: undefined }] };
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

/** What each of a server's quirks makes the bench's requests do, for its log. */
const QUIRK_SAYS: Record<Quirk, string> = {
  'prefix-leak': 'a nonce first in every request (prefix-leak)',
  'image-path': 'each picture as a file of its own, its path sent (image-path)',
};

/** How much more than at rest working must draw for its energy to count: the battery's rate wobbles by about this much. */
export const ENERGY_MIN_EXTRA = { milliwatts: 1_000, share: 0.1 };

// ------------------------------------------------------------------------------------------------
// The run

export interface NpuBenchOptions {
  profile?: 'quick' | 'full';
  /** Print what this PC's agents sent over the last this-many days instead of running (`--mix`). */
  mix?: number;
  vendor?: NpuVendor;
  device?: string;
  model?: string;
  candidate?: string;
  /** The candidate sees too (`--vision`): pulled as a vision model where the server asks, and asked the pictures. */
  vision?: boolean;
  cap?: number;
  energy?: boolean;
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
    dischargeRate?: () => Promise<number | null>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    clearCache?: (dir: string) => void;
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
  const finish = (code: number, mark?: Mark) => {
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
  let route: NpuRoute;
  try {
    // As setup runs it on this generation (routeFor): its own cap, timeouts and server arguments, before anything else.
    route = routeOnDevice(routeFor(catalog.routes[vendor], npu.generation), device);
    if (o.candidate) route = candidateRoute(route, o.candidate, { vision: o.vision });
    else if (o.model) route = routeWithModel(route, o.model);
    route = benchServe(route, { device, cap: o.cap });
  } catch (e: any) {
    return finish(2, { code: 'setup', say: e.message });
  }
  const chatModel = route.models.find((m) => m.kinds.includes('chat')) ?? route.models[0];
  report.run.server = `${route.server} ${route.version}`;
  report.run.model = chatModel.id;
  report.run.cap = device === 'NPU' ? route.maxContextTokens : null;
  const pin = chatModel.pinned?.[npu.generation ?? ''] ?? chatModel.pinned?.['*'];
  report.run.files = pin ? pin.files : null;
  log(`The NPU benchmark (${suite.version}, ${profile}): ${chatModel.id} on ${npu.label}'s ${device} with ${route.server} ${route.version}`);

  // 2. Its server and models, as setup does them.
  const tools = o.tools ?? toolsHome(env);
  const support: NpuSupport = npu;
  // The route is this generation's already: planned as it is, so the generation's own cap doesn't undo --cap.
  const plan = planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env, catalog: { ...catalog, routes: { ...catalog.routes, [vendor]: { ...route, generations: {} } } } })!;
  const needs = (!plan.installed ? (plan.download?.size ?? 0) : 0) + (plan.runtime?.size ?? 0) + plan.models.filter((m) => !m.have).reduce((n, m) => n + m.size, 0);
  const missing = !plan.installed || !!plan.runtime || plan.models.some((m) => !m.have);
  if (missing && o.setup === false) return finish(1, { code: 'setup', say: `${route.server} or its models aren't here, and --no-setup was given` });
  if (missing && !o.yes) {
    const ok = o.confirm ? await o.confirm(`Download ${needs ? mb(needs) : 'what it needs'} (${route.server} ${route.version} and its models)? [y/N] `) : false;
    if (!ok) return finish(1, { code: 'setup', say: `it would download ${needs ? mb(needs) : 'a candidate model'}: run again with --yes` });
  }
  const { entry, problems } = await setUpRoute(plan, tools, o.io?.setup ?? {}, log, now);
  if (!entry) return finish(1, { code: 'setup', say: problems.join('; ') || 'setup wrote no entry' });
  // A candidate has no pinned files to report: its own are measured, now that setup has pulled them.
  if (o.candidate) report.run.files = await candidateFiles(chatModel, { server: route.server, tools, env, log, hash: o.io?.setup?.hash });

  // 3. The conditions: how busy the processor is before the start.
  const busy: number[] = [];
  for (let i = 0; i < suite.quiet.samples; i++) {
    const b = await (o.io?.cpuBusy ?? cpuBusy)();
    if (b !== null) busy.push(b);
    if (i < suite.quiet.samples - 1) await sleep(suite.quiet.everyMs);
  }
  report.conditions.cpuBusyPercent = busy.length ? Math.round(busy.reduce((a, b) => a + b, 0) / busy.length) : null;

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

    /** A measurement: warm-ups, then the tries, each one value from its answer (null when it failed). */
    const tryTimes = async (q: { prompt: string; maxTokens: number }, value: (r: Streamed) => number | null, onEach?: (r: Streamed) => void) => {
      for (let i = 0; i < suite.warmups; i++) await ask(q);
      const xs: number[] = [];
      for (let i = 0; i < tries; i++) {
        const r = await ask(q);
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
      report.results.readFirstTokenMs[String(n)] = await tryTimes({ prompt: readPrompt(suite, n), maxTokens: suite.read.maxTokens }, (r) => r.firstTokenMs ?? r.ms);
      log(`reading ${n} tokens: ${report.results.readFirstTokenMs[String(n)].median} ms to the first token`);
    }
    if (route.maxContextTokens * suite.read.capShare > Math.max(...suite.read.sizes)) {
      const r = await ask({ prompt: readPrompt(suite, Math.round(route.maxContextTokens * suite.read.capShare) - suite.read.maxTokens), maxTokens: suite.read.maxTokens });
      report.results.readAtCap = { promptTokens: Number(r.usage?.prompt_tokens) || null, firstTokenMs: r.ok ? (r.firstTokenMs ?? r.ms) : null };
      log(`reading near the cap (${report.results.readAtCap.promptTokens ?? '?'} of ${route.maxContextTokens} tokens): ${report.results.readAtCap.firstTokenMs ?? 'no answer'} ms to the first token`);
    }
    for (const job of suite.jobs) {
      let passed = 0;
      const m = await tryTimes({ prompt: promptOf(suite, job), maxTokens: job.maxTokens }, (r) => r.ms, (r) => {
        if (r.ok && grade(job.grade, r.answer)) passed++;
      });
      report.results.jobs[job.id] = { ...m, passed };
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
      // it; a `data:` URL is sent as it is, whatever the quirk says (imageUrl), and GenieX doesn't read one.
      const dir = acc.quirks.includes('image-path') ? mkdtempSync(path.join(os.tmpdir(), 'npu-bench-pictures-')) : null;
      const imageOf = (v: Suite['vision'][number]) => {
        if (!dir) return picture(v.image);
        const file = path.join(dir, `${v.id}.png`);
        writeFileSync(file, picturePng(v.image));
        return file;
      };
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
        if (dir) rmSync(dir, { recursive: true, force: true });
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
      const q = { prompt: promptOf(suite, job), maxTokens: job.maxTokens };
      const t0 = now();
      const done: { at: number; ms: number }[] = [];
      while (now() - t0 < suite.holding.minutes * 60_000) {
        const r = await ask(q);
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
    if (o.energy) {
      if (!report.conditions.onBattery) log('energy: not measured, as the PC is plugged in (unplug it and run again with --energy)');
      else {
        const rate = o.io?.dischargeRate ?? dischargeRate;
        const sample = async (ms: number, during?: () => Promise<void>) => {
          const xs: number[] = [];
          const t0 = now();
          let busyWork: Promise<void> | null = null;
          let stop = false;
          if (during)
            busyWork = (async () => {
              while (!stop) await during();
            })();
          while (now() - t0 < ms) {
            const v = await rate();
            if (v !== null && v > 0) xs.push(v);
            await sleep(5_000);
          }
          stop = true;
          await busyWork;
          return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
        };
        const job = jobById(suite.energy.job);
        const q = { prompt: promptOf(suite, job), maxTokens: job.maxTokens };
        let jobs = 0;
        let tokens = 0;
        const rest = await sample(suite.energy.restSeconds * 1000);
        const t0 = now();
        const load = await sample(suite.energy.loadMinutes * 60_000, async () => {
          const r = await ask(q);
          if (r.ok) {
            jobs++;
            tokens += (Number(r.usage?.prompt_tokens) || 0) + (Number(r.usage?.completion_tokens) || 0);
          }
        });
        const seconds = (now() - t0) / 1000;
        if (rest !== null && load !== null) {
          const extraJoules = ((load - rest) / 1000) * seconds;
          // Working that draws no clearly more than rest is the battery's reading wobbling, not the model's energy:
          // on the Lunar Lake laptop the rate read 28 W at rest, nearly twice its real drain, and less working (NPU-BENCHMARK.md).
          const clear = load - rest >= Math.max(ENERGY_MIN_EXTRA.milliwatts, rest * ENERGY_MIN_EXTRA.share);
          report.results.energy = { restMilliwatts: Math.round(rest), loadMilliwatts: Math.round(load), jobs, tokens, millijoulesPerToken: clear && tokens ? Number(((extraJoules * 1000) / tokens).toFixed(3)) : null };
          if (clear) log(`energy: ${report.results.energy.millijoulesPerToken} mJ a token (${Math.round(rest)} mW at rest, ${Math.round(load)} mW working)`);
          else log(`energy: not counted: working read ${Math.round(load)} mW against ${Math.round(rest)} mW at rest, too little more for the battery's reading to tell the model's share`);
        } else log('energy: the battery gave no discharge rate');
      }
    }
  } finally {
    await server.stop();
    await client.untilGone();
  }
  report.run.streamed = streamedSeen.length ? streamedSeen.every(Boolean) : null;
  report.run.usageReported = usageSeen.length ? usageSeen.every(Boolean) : null;
  const r = finish(0);
  log(r.report.ranked ? 'Ranked: it met every condition.' : `Not ranked: ${r.report.marks.map((m) => m.say).join('; ')}`);
  return r;
}

// ------------------------------------------------------------------------------------------------
// The report's schema (the small part of JSON Schema it uses)

export function checkSchema(value: unknown, schema: any, at = 'report'): string[] {
  const problems: string[] = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types) {
    const t = typeOf(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return [`${at} is ${t}, not ${types.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} is ${JSON.stringify(value)}, not one of ${schema.enum.join(', ')}`);
  if (schema.const !== undefined && value !== schema.const) problems.push(`${at} isn't ${JSON.stringify(schema.const)}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in (value as object))) problems.push(`${at}.${k} is missing`);
    for (const [k, v] of Object.entries(value as object)) {
      const sub = schema.properties?.[k] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
      if (sub) problems.push(...checkSchema(v, sub, `${at}.${k}`));
      else if (schema.additionalProperties === false) problems.push(`${at}.${k} isn't in the schema`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => problems.push(...checkSchema(v, schema.items, `${at}[${i}]`)));
  return problems;
}

// ------------------------------------------------------------------------------------------------
// As a command

export function parseBenchArgs(argv: string[]): NpuBenchOptions | { error: string } {
  const o: NpuBenchOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--no-setup') o.setup = false;
    else if (a === '--energy') o.energy = true;
    else if (a === '--profile') {
      const v = argv[++i];
      if (v !== 'quick' && v !== 'full') return { error: '--profile takes quick or full' };
      o.profile = v;
    } else if (a === '--device') {
      const v = (argv[++i] ?? '').toUpperCase();
      if (!/^(NPU|CPU|GPU)$/.test(v)) return { error: '--device takes NPU, CPU or GPU' };
      o.device = v;
    } else if (a === '--model') o.model = argv[++i];
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
    console.error(`${o.error}\nUsage: node npu-bench.ts [--profile quick|full] [--device NPU|GPU|CPU] [--model <id>] [--candidate <id> [--vision]] [--cap <tokens>] [--energy] [--yes] [--no-setup] [--out <file>]\n       node npu-bench.ts --mix [days]`);
    process.exit(2);
  }
  if (o.mix) {
    for (const line of mixSummary(readTally(o.mix))) console.log(line);
    process.exit(0);
  }
  const { code } = await npuBench(o);
  process.exit(code);
}
