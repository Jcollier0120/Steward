import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceleratorTurn } from './npu.ts';
import { OCR_ENGINE, OCR_SCRIPT, ocrFiles, parseAnswers } from './ocr.ts';
import { modelReader, resetModelReader, startReader } from './ocr-npu.ts';
import { makePdf, type PdfFontName, type PdfLineSpec } from './pdf-make.ts';
import { powershell, psQuote } from './ps.ts';

/**
 * The text reader's check (kit 2.102.0, spec/OCR.md, "The check"): how well and how cheaply each engine reads text
 * whose words are known, on any PC, so every NPU maker's PC measures the same thing.
 *
 *   node <agent>\src\kit\ocr-check.ts [--engine windows,model-npu,model-cpu] [--scale 1,2|auto] [--runs 3] [--no-browser] [--fixtures <dir>] [--out <file>] [--json]
 *
 * It draws its pictures first, in a scratch folder (or `--fixtures`, kept):
 * - the bench's 25 (ocr-fixtures.ps1, GDI+): 20 screenshots in four themes at 11 to 18 px, and 5 document pages;
 * - the same strings drawn by the real browser engine: Edge, headless, screenshots of local pages at 100, 125, 150 and
 *   200% (DirectWrite, not GDI+);
 * - a PDF with a text layer (read without OCR), and a PDF of a scanned page;
 * - a held-out set of strings and fonts no model is trained on (spec/ocr-check.json).
 * Then each engine reads them, `--runs` times, each run in a process of its own, and the check reports per group:
 * characters right (1 - edits/characters), words found, whole lines read exactly, ms an image, and the engine
 * process's processor time and peak memory, with what a start costs before it reads anything.
 */

export interface Fixture {
  file: string;
  kind: 'image' | 'pdf';
  /** screen, page, browser, pdf, held-out */
  set: string;
  /** What the report sums by: "screen 11px", "browser 125%", "pdf scan". */
  group: string;
  lines: string[];
}

export interface Score {
  chars: number;
  edits: number;
  wordsOk: number;
  wordsAll: number;
  linesOk: number;
  lines: number;
  missed: string[];
}

interface Spec {
  seed: number;
  ui: string[];
  prose: string[];
  screenFonts: string[];
  pageFonts: string[];
  heldOut: { fonts: string[]; ui: string[]; prose: string[] };
}

export const SPEC: Spec = JSON.parse(readFileSync(new URL('./spec/ocr-check.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));

/** Text as the check compares it: curly quotes and dashes plain, whitespace single. */
export const norm = (s: string) =>
  s.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

/** Edits (insert, delete, change) from a to b. */
export function lev(a: string, b: string): number {
  let prev = new Int32Array(b.length + 1).map((_, i) => i);
  let cur = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * The bench's score (2026-10-23), so figures compare with the baseline: characters by edits from all the known lines
 * to all the text read, words found (each once), and lines found whole in the text.
 */
export function scoreText(lines: string[], text: string): Score {
  const want = norm(lines.join(' '));
  const got = norm(text);
  const words = new Map<string, number>();
  for (const w of got.split(' ')) words.set(w, (words.get(w) ?? 0) + 1);
  let wordsOk = 0;
  let wordsAll = 0;
  for (const w of want.split(' ')) {
    if (!w) continue;
    wordsAll++;
    if (words.get(w)) {
      wordsOk++;
      words.set(w, words.get(w)! - 1);
    }
  }
  const missed = lines.filter((l) => !got.includes(norm(l)));
  return { chars: want.length, edits: lev(want, got), wordsOk, wordsAll, linesOk: lines.length - missed.length, lines: lines.length, missed };
}

/** A seeded random sequence (mulberry32), so the browser's pictures are the same on every PC. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const THEMES = [
  { name: 'dark', bg: '#1E1E1E', fg: '#D4D4D4' },
  { name: 'light', bg: '#FFFFFF', fg: '#1F1F1F' },
  { name: 'grey', bg: '#FFFFFF', fg: '#6B7280' },
  { name: 'blue', bg: '#1D4ED8', fg: '#FFFFFF' },
];

const script = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .join('\n');

/** The GDI+ pictures (ocr-fixtures.ps1): the bench's 25, the held-out set's, and the page to scan. */
export async function drawGdi(dir: string): Promise<Fixture[]> {
  const specFile = fileURLToPath(new URL('./spec/ocr-check.json', import.meta.url));
  await powershell(`$SpecFile = ${psQuote(specFile)}\n$Out = ${psQuote(dir)}\n${script('ocr-fixtures.ps1')}`, { timeoutMs: 180_000 });
  const list = JSON.parse(readFileSync(path.join(dir, 'gdi.json'), 'utf8').replace(/^\uFEFF/, ''));
  return (Array.isArray(list) ? list : [list]).map((t: any) => ({ file: path.join(dir, t.file), kind: 'image', set: t.set, group: t.group, lines: [].concat(t.lines ?? []) }));
}

/** Edge, where Windows keeps it (or OCR_CHECK_EDGE). */
export function findEdge(env: NodeJS.ProcessEnv = process.env): string | null {
  const cands = [env.OCR_CHECK_EDGE, path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')];
  return cands.find((c): c is string => !!c && existsSync(c)) ?? null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A page of lines, each in its font and size, that fits a 1280x720 window with no line cut or wrapped. */
export function browserPage(lines: string[], fonts: string[], sizes: number[], theme: { bg: string; fg: string }, rnd: () => number): { html: string; lines: string[] } {
  const kept: string[] = [];
  const rows: string[] = [];
  let y = 24;
  for (const l of lines) {
    const size = sizes[Math.floor(rnd() * sizes.length)];
    const font = fonts[Math.floor(rnd() * fonts.length)];
    const lh = Math.round(size * 1.8);
    if (y + lh > 720 - 24) break;
    // Wide faces run to about 0.62 em a character: a line that might not fit is left out.
    if (l.length * size * 0.62 > 1280 - 48) continue;
    rows.push(`<div style="font-family:'${font}';font-size:${size}px;line-height:${lh}px;height:${lh}px">${esc(l)}</div>`);
    kept.push(l);
    y += lh;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${theme.bg};color:${theme.fg}}main{padding:24px;white-space:pre;overflow:hidden}</style></head><body><main>${rows.join('')}</main></body></html>`;
  return { html, lines: kept };
}

const shuffle = <T>(xs: T[], rnd: () => number) => xs.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One screenshot by Edge, headless, in a profile of its own (deleted after). Edge's launcher can hand over to a browser
 * process and return at once, so this waits for the picture to be written, then for the profile to be let go.
 */
async function edgeShot(edge: string, html: string, png: string, zoom: number): Promise<boolean> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'ocr-check-edge-'));
  rmSync(png, { force: true });
  const args = [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    `--user-data-dir=${profile}`,
    `--force-device-scale-factor=${zoom}`,
    '--window-size=1280,720',
    `--screenshot=${png}`,
    pathToFileURL(html).href,
  ];
  const p = spawn(edge, args, { windowsHide: true, stdio: 'ignore' });
  p.on('error', () => {});
  const deadline = Date.now() + 45_000;
  let size = -1;
  while (Date.now() < deadline) {
    await wait(200);
    if (!existsSync(png)) continue;
    const s = statSync(png).size;
    if (s > 0 && s === size) break;
    size = s;
  }
  while (Date.now() < deadline && existsSync(path.join(profile, 'lockfile'))) await wait(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  return existsSync(png) && statSync(png).size > 0;
}

/** The browser's pictures: the bench's strings at four zooms in two themes, and a held-out page at 125%. */
export async function drawBrowser(dir: string, edge: string): Promise<Fixture[]> {
  const out: Fixture[] = [];
  const rnd = random(SPEC.seed + 10);
  const shots: { name: string; zoom: number; theme: (typeof THEMES)[number]; ui: string[]; fonts: string[]; set: string; group: string }[] = [];
  for (const zoom of [1, 1.25, 1.5, 2]) {
    for (const theme of [THEMES[0], THEMES[1]]) {
      shots.push({ name: `browser-${theme.name}-${zoom * 100}`, zoom, theme, ui: SPEC.ui, fonts: SPEC.screenFonts, set: 'browser', group: `browser ${zoom * 100}%` });
    }
  }
  shots.push({ name: 'heldout-browser-light-125', zoom: 1.25, theme: THEMES[1], ui: SPEC.heldOut.ui, fonts: SPEC.heldOut.fonts, set: 'held-out', group: 'held-out browser' });
  for (const s of shots) {
    const page = browserPage(shuffle(s.ui, rnd), s.fonts, [12, 13, 14, 16], s.theme, rnd);
    const html = path.join(dir, `${s.name}.html`);
    const png = path.join(dir, `${s.name}.png`);
    writeFileSync(html, page.html);
    if (await edgeShot(edge, html, png, s.zoom)) out.push({ file: png, kind: 'image', set: s.set, group: s.group, lines: page.lines });
  }
  return out;
}

/** A three-page PDF with a text layer in the standard fonts, and a PDF of the scanned page. */
export function makePdfs(dir: string, scan: Fixture | undefined): Fixture[] {
  const rnd = random(SPEC.seed + 20);
  const fonts: PdfFontName[] = ['Helvetica', 'Times-Roman', 'Courier'];
  const pages: PdfLineSpec[][] = [];
  const all: string[] = [];
  const pool = shuffle([...SPEC.prose, ...SPEC.ui], rnd);
  for (let p = 0; p < 3; p++) {
    const lines: PdfLineSpec[] = [];
    const font = fonts[p];
    for (let y = 72, k = 0; y < 720 && pool.length; k++) {
      const text = pool.shift()!;
      // Courier at 10 pt is 6 points a character: a line wider than the page is left out.
      if (text.length * (font === 'Courier' ? 6 : 5.5) > 612 - 144) continue;
      lines.push({ text, x: 72, y, size: 10 + (k % 3), font });
      all.push(text);
      y += 18;
    }
    pages.push(lines);
  }
  const out: Fixture[] = [];
  const text = path.join(dir, 'pdf-text.pdf');
  writeFileSync(text, makePdf(pages.map((lines) => ({ lines })), { compress: true, objectStreams: true }));
  out.push({ file: text, kind: 'pdf', set: 'pdf', group: 'pdf text layer', lines: all });
  if (scan) {
    const file = path.join(dir, 'pdf-scan.pdf');
    writeFileSync(file, makePdf([{ jpeg: readFileSync(scan.file) }], { compress: true }));
    out.push({ file, kind: 'pdf', set: 'pdf', group: 'pdf scan', lines: scan.lines });
  }
  return out;
}

export interface EngineRun {
  /** By fixture index: the text, and the engine's own ms. */
  texts: Map<number, { text: string; ms: number; ok: boolean; error?: string }>;
  wallMs: number;
  cpuMs: number;
  peakMB: number;
}

/**
 * Windows' OCR (ocr.ps1) over the pictures, in a powershell.exe of its own that says, at the end, its processor time
 * and peak memory: the engine's cost alone, as the bench measured it.
 */
async function runWindows(images: { i: number; file: string }[], scale: number | 'auto', dir: string): Promise<EngineRun> {
  const listFile = path.join(dir, `list-${images.length}.json`);
  writeFileSync(listFile, JSON.stringify({ scale, boxes: false, orient: true, pdfMaxPages: 5, pdfScale: 2, tmpDir: dir, jobs: images.map(({ i, file }) => ({ i, path: file, kind: 'image', thumb: null, pages: null })) }));
  const ps1 = path.join(dir, 'run-windows.ps1');
  writeFileSync(
    ps1,
    '\ufeff' +
      `$ErrorActionPreference = 'Stop'\n$ListFile = ${psQuote(listFile)}\n${OCR_SCRIPT}\n` +
      `$me = [Diagnostics.Process]::GetCurrentProcess(); $me.Refresh()\n` +
      `'{"stats":true,"cpuMs":' + [int]$me.TotalProcessorTime.TotalMilliseconds + ',"peakMB":' + [int]($me.PeakWorkingSet64 / 1MB) + '}'\n`,
  );
  const t0 = Date.now();
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true });
    let so = '';
    let se = '';
    p.stdout.setEncoding('utf8').on('data', (d) => (so += d));
    p.stderr.setEncoding('utf8').on('data', (d) => (se += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(`Windows OCR exited ${code}: ${se.trim().slice(0, 300)}`))));
  });
  const wallMs = Date.now() - t0;
  const stats = JSON.parse(out.split(/\r?\n/).find((l) => l.startsWith('{"stats"')) ?? '{"cpuMs":0,"peakMB":0}');
  const texts = new Map<number, { text: string; ms: number; ok: boolean; error?: string }>();
  for (const [i, r] of parseAnswers(out)) {
    const read = Array.isArray(r.read) ? r.read : [];
    texts.set(i, { text: read.map((p: any) => String(p?.text ?? '')).join('\n\n'), ms: Number(r.ms ?? 0), ok: !!r.ok, error: r.ok ? undefined : String(r.error ?? '') });
  }
  return { texts, wallMs, cpuMs: Number(stats.cpuMs), peakMB: Number(stats.peakMB) };
}

/** A process's processor time and peak memory so far, as Windows counts them. */
async function processCost(pid: number | undefined): Promise<{ cpuMs: number; peakMB: number }> {
  if (!pid) return { cpuMs: 0, peakMB: 0 };
  const out = await powershell(`$p = Get-Process -Id ${Math.trunc(pid)}; '{"cpuMs":' + [int]$p.TotalProcessorTime.TotalMilliseconds + ',"peakMB":' + [int]($p.PeakWorkingSet64 / 1MB) + '}'`, { timeoutMs: 30_000 });
  const s = JSON.parse(out.trim().split(/\r?\n/).pop() || '{}');
  return { cpuMs: Number(s.cpuMs ?? 0), peakMB: Number(s.peakMB ?? 0) };
}

/**
 * The kit's model (ocr-npu.ts) over the pictures, in a program of its own started for the run, within the NPU's turn
 * when it reads on the NPU; its processor time and peak memory asked of Windows before it's closed. 'auto' reads at 1:
 * the model needs no enlarging.
 */
async function runModel(images: { i: number; file: string }[], scale: number | 'auto', on: 'npu' | 'cpu'): Promise<EngineRun> {
  const run = async (): Promise<EngineRun> => {
    const t0 = Date.now();
    const h = await startReader(on, { log: (l) => console.log(`  ${l}`) });
    try {
      if (h.hello.on !== on) throw new Error(`the model reads on the ${h.hello.on} here: ${h.hello.why ?? ''}`);
      const texts = new Map<number, { text: string; ms: number; ok: boolean; error?: string }>();
      for (const { i, file } of images) {
        const a = await h.read(file, scale === 'auto' ? 1 : scale, true);
        texts.set(i, { text: (a.lines ?? []).map((l) => l.text).join('\n'), ms: Number(a.ms ?? 0), ok: !a.error, error: a.error });
      }
      const wallMs = Date.now() - t0;
      return { texts, wallMs, ...(await processCost(h.pid)) };
    } finally {
      h.close();
    }
  };
  return on === 'npu' ? acceleratorTurn({ id: 'npu', name: 'NPU', slots: 1 }, run, { lane: 'interactive' }) : run();
}

/** The engines this check can run, by name, and what each is. */
export const ENGINES: Record<string, string> = {
  windows: 'Windows.Media.Ocr, on the processor',
  'model-npu': "the kit's model on the NPU, through ONNX Runtime and the NPU maker's plugin",
  'model-cpu': "the kit's model on the processor, through ONNX Runtime",
};

export interface GroupScore extends Omit<Score, 'missed'> {
  images: number;
  /** The engine's ms an image (median). */
  ms: number;
}

export interface EngineReport {
  engine: string;
  about: string;
  scale: number | 'auto';
  runs: number;
  groups: Record<string, GroupScore>;
  /** The bench's 25 pictures, as the baseline counts them; and everything. */
  bench: GroupScore;
  all: GroupScore;
  cost: { startMs: number; startCpuMs: number; startMB: number; wallMs: number; cpuMs: number; peakMB: number; perImageMs: number; perImageCpuMs: number; images: number };
  files: { file: string; group: string; ms: number; ok: boolean; error?: string; text: string; missed: string[] }[];
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

function sumGroup(rows: { s: Score; ms: number }[]): GroupScore {
  const g: GroupScore = { chars: 0, edits: 0, wordsOk: 0, wordsAll: 0, linesOk: 0, lines: 0, images: rows.length, ms: median(rows.map((r) => r.ms)) };
  for (const { s } of rows) for (const k of ['chars', 'edits', 'wordsOk', 'wordsAll', 'linesOk', 'lines'] as const) g[k] += s[k];
  return g;
}

/** Runs one engine over the fixtures: the pictures `runs` times in its own process (and once with nothing), the PDFs through the reader. */
export async function checkEngine(engine: string, fixtures: Fixture[], o: { scale: number | 'auto'; runs: number; dir: string }): Promise<EngineReport> {
  if (!ENGINES[engine]) throw new Error(`no engine "${engine}" here (engines: ${Object.keys(ENGINES).join(', ')})`);
  const on = engine === 'model-npu' ? 'npu' : engine === 'model-cpu' ? 'cpu' : null;
  const images = fixtures.map((f, i) => ({ i, file: f.file, f })).filter((x) => x.f.kind === 'image');
  const runEngine = (list: typeof images) => (on ? runModel(list, o.scale, on) : runWindows(list, o.scale, o.dir));
  // A first start compiles the model's graphs for the NPU (and fetches what's missing): before anything is measured.
  if (on) await runModel([], o.scale, on);
  const empty: EngineRun[] = [];
  const full: EngineRun[] = [];
  for (let r = 0; r < o.runs; r++) {
    empty.push(await runEngine([]));
    full.push(await runEngine(images));
  }
  const last = full[full.length - 1];
  const rows: { f: Fixture; s: Score; ms: number; ok: boolean; error?: string; text: string }[] = [];
  for (const { i, f } of images) {
    const t = last.texts.get(i);
    rows.push({ f, s: scoreText(f.lines, t?.ok ? t.text : ''), ms: median(full.map((run) => run.texts.get(i)?.ms ?? 0)), ok: !!t?.ok, error: t ? t.error : 'no answer', text: t?.text ?? '' });
  }
  // PDFs: through the reader, as the staff read them (the text layer where there is one), by this engine alone.
  resetModelReader();
  const env = { ...process.env, KIT_OCR_ENGINE: 'model', ...(on === 'cpu' ? { KIT_OCR_NPU: 'none' } : {}) };
  const reader = on ? () => modelReader({ env, log: (l) => console.log(`  ${l}`) }) : async () => null;
  for (const f of fixtures.filter((x) => x.kind === 'pdf')) {
    const t0 = Date.now();
    const [r] = await ocrFiles([{ path: f.file, kind: 'pdf' }], { tmpRoot: o.dir, scale: o.scale, lane: 'interactive', modelReader: reader });
    if (on && r.engine && r.engine !== engine) throw new Error(`${path.basename(f.file)} was read by ${r.engine}, not ${engine}`);
    rows.push({ f, s: scoreText(f.lines, r.ok ? r.text : ''), ms: Date.now() - t0, ok: r.ok, error: r.error, text: r.text });
  }
  resetModelReader();
  const groups: Record<string, GroupScore> = {};
  for (const g of [...new Set(rows.map((r) => r.f.group))]) groups[g] = sumGroup(rows.filter((r) => r.f.group === g));
  const startMs = median(empty.map((e) => e.wallMs));
  const startCpuMs = median(empty.map((e) => e.cpuMs));
  const wallMs = median(full.map((e) => e.wallMs));
  const cpuMs = median(full.map((e) => e.cpuMs));
  const n = Math.max(1, images.length);
  return {
    engine,
    about: ENGINES[engine],
    scale: o.scale,
    runs: o.runs,
    groups,
    bench: sumGroup(rows.filter((r) => r.f.set === 'screen' || r.f.set === 'page')),
    all: sumGroup(rows),
    cost: {
      startMs,
      startCpuMs,
      startMB: median(empty.map((e) => e.peakMB)),
      wallMs,
      cpuMs,
      peakMB: median(full.map((e) => e.peakMB)),
      perImageMs: Math.round((wallMs - startMs) / n),
      perImageCpuMs: Math.round((cpuMs - startCpuMs) / n),
      images: images.length,
    },
    files: rows.map((r) => ({ file: path.basename(r.f.file), group: r.f.group, ms: r.ms, ok: r.ok, error: r.error, text: r.text, missed: r.s.missed })),
  };
}

const GROUP_ORDER = ['screen', 'page', 'browser', 'pdf', 'held-out'];
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');

/** The report as the person running the check reads it. */
export function formatReport(r: EngineReport): string {
  const row = (name: string, g: GroupScore) =>
    `  ${name.padEnd(22)} ${pct(g.chars - g.edits, g.chars).padStart(7)} ${pct(g.wordsOk, g.wordsAll).padStart(7)} ${`${g.linesOk}/${g.lines}`.padStart(9)} ${String(g.ms).padStart(7)}`;
  const names = Object.keys(r.groups).sort((a, b) => {
    const ka = GROUP_ORDER.findIndex((p) => a.startsWith(p));
    const kb = GROUP_ORDER.findIndex((p) => b.startsWith(p));
    return ka - kb || (parseFloat(a.replace(/^\D+/, '')) || 0) - (parseFloat(b.replace(/^\D+/, '')) || 0) || a.localeCompare(b);
  });
  const c = r.cost;
  return [
    `${r.engine} (${r.about}), scale ${r.scale}, ${r.runs} run${r.runs === 1 ? '' : 's'}`,
    `  ${'group'.padEnd(22)} ${'chars'.padStart(7)} ${'words'.padStart(7)} ${'lines'.padStart(9)} ${'ms/img'.padStart(7)}`,
    ...names.map((n) => row(n, r.groups[n])),
    row("the bench's 25", r.bench),
    row('all', r.all),
    `  cost: a start with nothing to read ${c.startMs} ms, ${c.startCpuMs} ms processor, ${c.startMB} MB;`,
    `        ${c.images} pictures in one process ${c.wallMs} ms, ${c.cpuMs} ms processor, peak ${c.peakMB} MB;`,
    `        an image beyond the start: ${c.perImageMs} ms, ${c.perImageCpuMs} ms processor.`,
  ].join('\n');
}

export interface CheckOptions {
  engines: string[];
  scales: (number | 'auto')[];
  runs: number;
  browser: boolean;
  fixtures: string | null;
  out: string | null;
  json: boolean;
}

export function parseCheckArgs(argv: string[]): CheckOptions {
  const o: CheckOptions = { engines: [OCR_ENGINE], scales: [1], runs: 3, browser: true, fixtures: null, out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i] ?? '';
    if (a === '--engine') o.engines = v().split(',').filter(Boolean);
    else if (a === '--scale') o.scales = v().split(',').filter(Boolean).map((s) => (s === 'auto' ? 'auto' : Number(s)));
    else if (a === '--runs') o.runs = Math.max(1, Number(v()) || 1);
    else if (a === '--no-browser') o.browser = false;
    else if (a === '--fixtures') o.fixtures = path.resolve(v());
    else if (a === '--out') o.out = path.resolve(v());
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown option ${a}`);
  }
  for (const s of o.scales) if (s !== 'auto' && !(s > 0)) throw new Error(`--scale takes numbers or auto`);
  return o;
}

/** Draws the fixtures (all but the browser's if there's no Edge), runs each engine at each scale, and reports. */
export async function runCheck(o: CheckOptions, log: (s: string) => void = console.log): Promise<EngineReport[]> {
  const dir = o.fixtures ?? mkdtempSync(path.join(os.tmpdir(), 'ocr-check-'));
  mkdirSync(dir, { recursive: true });
  try {
    log(`Drawing the check's pictures in ${dir}`);
    const gdi = await drawGdi(dir);
    const scan = gdi.find((f) => f.group === 'pdf scan');
    const fixtures = gdi.filter((f) => f !== scan);
    if (o.browser) {
      const edge = findEdge();
      if (edge) {
        const b = await drawBrowser(dir, edge);
        fixtures.push(...b);
        if (b.length < 9) log(`  Edge drew ${b.length} of its 9 pictures`);
      } else log('  no Edge here: the browser pictures are left out');
    }
    fixtures.push(...makePdfs(dir, scan));
    log(`  ${fixtures.length} files, ${fixtures.reduce((n, f) => n + f.lines.length, 0)} lines`);
    const reports: EngineReport[] = [];
    for (const engine of o.engines) {
      for (const scale of o.scales) {
        const r = await checkEngine(engine, fixtures, { scale, runs: o.runs, dir });
        reports.push(r);
        if (!o.json) log('\n' + formatReport(r));
      }
    }
    if (o.out) {
      writeFileSync(o.out, JSON.stringify({ at: new Date().toISOString(), pc: { cpu: os.cpus()[0]?.model ?? null, arch: process.arch, ramGb: Math.round(os.totalmem() / 2 ** 30) }, reports }, null, 1));
      if (!o.json) log(`\nThe whole report: ${o.out}`);
    }
    if (o.json) log(JSON.stringify(reports, null, 1));
    return reports;
  } finally {
    if (!o.fixtures) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// Run as itself, compared by real paths (a junction or a Dev Drive spells argv[1] another way).
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    await runCheck(parseCheckArgs(process.argv.slice(2)));
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
