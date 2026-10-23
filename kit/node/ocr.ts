import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsOcr, PDF_TEXT_MAX_BYTES, readPdfText, type PdfTextPage } from './pdf-text.ts';
import { powershell, psQuote } from './ps.ts';

/**
 * The staff's one text reader (kit 2.102.0, spec/OCR.md): the text in pictures (screenshots, scans, photos of pages)
 * and in PDFs, for the Clerk, the Scribe, Reeve and the Warrener.
 * - Pictures, and PDF pages that have no text of their own (scans), are read by the engine: Windows' built-in OCR
 *   (Windows.Media.Ocr, on the processor) through ocr.ps1, for now. The engine sits behind this API: the staff never
 *   name it.
 * - A PDF that carries its text is read from its text layer (pdf-text.ts): exact, and nothing is rendered.
 * Many files go to one PowerShell script (in the kit's PowerShell worker, ps.ts): starting one costs about a second.
 */

/** A word and its box, in the picture's own pixels (a PDF page's: as rendered at pdfScale). */
export interface OcrWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
}

/** A page read: a picture, or one page of a PDF. */
export interface OcrPage {
  file: string;
  /** A PDF's page, 0-based; a picture's is 0. */
  page?: number;
  width: number;
  height: number;
  lines: OcrLine[];
  /** Where the text came from: the PDF's own text layer, or the engine. */
  source?: 'text' | 'ocr';
  error?: string;
}

export interface OcrJob {
  path: string;
  kind: 'image' | 'pdf';
  /** PDFs: where to save a small render of page 1 (in the data folder), for the page's thumbnail. */
  thumb?: string | null;
}

export interface OcrResult {
  path: string;
  ok: boolean;
  /** The pages' text, a line a line, pages apart by a blank line. */
  text: string;
  ms: number;
  pages: number;
  pageCount: number;
  error?: string;
  /** OneDrive's "online-only": opening the file would download it, so it was not read. */
  cloudOnly?: boolean;
  /** A PDF's text from its own text layer (`text`), the engine (`ocr`), or some pages each (`mixed`). */
  source?: 'text' | 'ocr' | 'mixed';
  /** The engine that read what was OCRed ('windows': Windows.Media.Ocr). */
  engine?: string;
  /** With `boxes`: each page read, its lines with their words' boxes. */
  layout?: OcrPage[];
}

export interface OcrOptions {
  /** A folder of its own for the batch's list and page renders (deleted afterwards). */
  tmpRoot: string;
  /** Enlarges pictures before reading; 1 reads ordinary screenshots well. 'auto': twice under 1,000 pixels, else 1. */
  scale?: number | 'auto';
  pdfMaxPages?: number;
  /** PDF pages render at 96 dpi times this. */
  pdfScale?: number;
  /** Work per PowerShell process: an image counts 1, a PDF its page limit. */
  batchWeight?: number;
  /** Called after each batch, so a long round saves as it goes. */
  onBatch?: (results: OcrResult[]) => void | Promise<void>;
  /** Each page's lines and words with their boxes, in `layout`. */
  boxes?: boolean;
  /** Read a PDF's own text where it has it (the default); false renders and OCRs every page, as before 2.102.0. */
  pdfText?: boolean;
  /** Turn photos the way their EXIF says (the default); false reads them as stored. */
  orient?: boolean;
}

/** The engine's name in results: Windows' own OCR, for now (PR 2 of spec/OCR.md brings the NPU's). */
export const OCR_ENGINE = 'windows';

/** The script without its comment lines: it travels as -EncodedCommand, which has a length limit. It reads `$ListFile`. */
export const OCR_SCRIPT = readFileSync(new URL('./ocr.ps1', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.trim().startsWith('#'))
  .join('\n');

/** Splits jobs into batches of at most `weight` (an image 1, a PDF `pdfWeight`), in order. */
export function batches(jobs: OcrJob[], weight: number, pdfWeight: number): OcrJob[][] {
  const out: OcrJob[][] = [];
  let cur: OcrJob[] = [];
  let w = 0;
  for (const j of jobs) {
    const jw = j.kind === 'pdf' ? pdfWeight : 1;
    if (cur.length && w + jw > weight) {
      out.push(cur);
      cur = [];
      w = 0;
    }
    cur.push(j);
    w += jw;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * ocr.ps1's answers by job index. A line that won't parse as it is (a raw control character in it, as a console's code
 * page once made of a bullet) is read again with control characters as spaces; one that still won't is that job's
 * error, never a job dropped as unanswered.
 */
export function parseAnswers(out: string): Map<number, any> {
  const byIndex = new Map<number, any>();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      try {
        r = JSON.parse(line.replace(/[\u0000-\u001f\u007f]/g, ' '));
      } catch {
        const i = /^\{"i":(\d+)/.exec(line);
        if (i) byIndex.set(Number(i[1]), { i: Number(i[1]), ok: false, error: "OCR's answer was garbled" });
        continue;
      }
    }
    if (typeof r?.i === 'number') byIndex.set(r.i, r);
  }
  return byIndex;
}

let seq = 0;

export async function ocrFiles(jobs: OcrJob[], opts: OcrOptions): Promise<OcrResult[]> {
  const pdfMaxPages = opts.pdfMaxPages ?? 5;
  const all: OcrResult[] = [];
  for (const batch of batches(jobs, opts.batchWeight ?? 40, pdfMaxPages)) {
    const dir = path.join(opts.tmpRoot, `ocr-${process.pid}-${++seq}`);
    mkdirSync(dir, { recursive: true });
    try {
      const results = await readBatch(batch, dir, { ...opts, pdfMaxPages });
      all.push(...results);
      await opts.onBatch?.(results);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return all;
}

/** A page from the engine's answer. */
function enginePage(file: string, p: any, boxes: boolean): OcrPage {
  const page: OcrPage = { file, page: Number(p?.page ?? 0), width: Number(p?.width ?? 0), height: Number(p?.height ?? 0), lines: [], source: 'ocr' };
  if (boxes && Array.isArray(p?.lines)) {
    page.lines = p.lines.map((l: any) => ({
      text: String(l?.text ?? ''),
      words: Array.isArray(l?.words) ? l.words.map((w: any) => ({ t: String(w?.t ?? ''), x: Number(w?.x), y: Number(w?.y), w: Number(w?.w), h: Number(w?.h) })) : [],
    }));
  }
  return page;
}

const textPage = (file: string, p: PdfTextPage): OcrPage => ({ file, page: p.index, width: p.width, height: p.height, lines: p.lines, source: 'text' });

interface PdfPlan {
  pageCount: number;
  /** Pages read from the text layer. */
  text: Map<number, PdfTextPage>;
  /** Pages to OCR. */
  ocr: number[];
  ms: number;
}

async function readBatch(batch: OcrJob[], dir: string, opts: OcrOptions & { pdfMaxPages: number }): Promise<OcrResult[]> {
  const pdfScale = opts.pdfScale ?? 2;
  const boxes = !!opts.boxes;
  const results: (OcrResult | null)[] = batch.map(() => null);
  const plans = new Map<number, PdfPlan>();

  // PDFs that carry their text: read here, after asking Windows whether opening them would download them.
  const pdfs = opts.pdfText === false ? [] : batch.map((j, i) => ({ j, i })).filter((x) => x.j.kind === 'pdf');
  if (pdfs.length) {
    const cloud = await cloudOnly(pdfs.map((x) => x.j.path));
    pdfs.forEach(({ j, i }, k) => {
      if (cloud[k] === true) results[i] = { path: j.path, ok: false, text: '', ms: 0, pages: 0, pageCount: 0, error: 'online-only (not on this PC)', cloudOnly: true };
      else if (cloud[k] === false) {
        const plan = planPdf(j.path, opts.pdfMaxPages, pdfScale);
        if (plan) plans.set(i, plan);
      }
      // null: not there or unreadable; ocr.ps1 says why
    });
  }

  // The engine: pictures, PDFs without a plan, and the pages a plan leaves to it (and thumbnails).
  const sent = batch
    .map((j, i) => ({ j, i, plan: plans.get(i) }))
    .filter(({ j, i, plan }) => !results[i] && (!plan || plan.ocr.length || (j.kind === 'pdf' && j.thumb)));
  let answers = new Map<number, any>();
  if (sent.length) {
    const listFile = path.join(dir, 'list.json');
    writeFileSync(
      listFile,
      JSON.stringify({
        scale: opts.scale ?? 1,
        boxes,
        orient: opts.orient !== false,
        pdfMaxPages: opts.pdfMaxPages,
        pdfScale,
        // WinRT's folders want a full path.
        tmpDir: path.resolve(dir),
        // WinRT's GetFileFromPathAsync wants backslashes.
        jobs: sent.map(({ j, i, plan }) => ({ i, path: path.resolve(j.path), kind: j.kind, thumb: j.thumb ? path.resolve(j.thumb) : null, pages: plan ? plan.ocr : null })),
      }),
    );
    const weight = sent.reduce((n, { j, plan }) => n + (j.kind === 'pdf' ? (plan ? Math.max(1, plan.ocr.length) : opts.pdfMaxPages) : 1), 0);
    // A script that fails as a whole (no OCR language, PowerShell gone) rejects, as before: the batch stays unread.
    answers = parseAnswers(await powershell(`$ListFile = ${psQuote(listFile)}\n${OCR_SCRIPT}`, { timeoutMs: 30_000 + weight * 15_000 }));
  }

  return batch.map((j, i): OcrResult => {
    if (results[i]) return results[i]!;
    const plan = plans.get(i);
    const r = answers.get(i);
    const asked = sent.some((s) => s.i === i);
    if (plan && !asked) return fromPlan(j.path, plan, [], boxes);
    if (!r) {
      // A planned PDF whose scans couldn't be read still has its text pages.
      if (plan && plan.text.size) return { ...fromPlan(j.path, plan, [], boxes), error: 'no answer from OCR' };
      return { path: j.path, ok: false, text: '', ms: 0, pages: 0, pageCount: 0, error: 'no answer from OCR' };
    }
    if (!r.ok) {
      if (plan && plan.text.size) return { ...fromPlan(j.path, plan, [], boxes), error: String(r.error ?? 'unreadable') };
      return { path: j.path, ok: false, text: '', ms: Number(r.ms ?? 0), pages: 0, pageCount: 0, error: String(r.error ?? 'unreadable'), cloudOnly: r.cloudOnly ? true : undefined };
    }
    const read: any[] = Array.isArray(r.read) ? r.read : [];
    if (plan) return fromPlan(j.path, plan, read, boxes, Number(r.ms ?? 0));
    const pages = read.map((p) => ({ p, page: enginePage(j.path, p, boxes) }));
    return {
      path: j.path,
      ok: true,
      text: pages.map(({ p }) => String(p?.text ?? '')).join('\n\n'),
      ms: Number(r.ms ?? 0),
      pages: j.kind === 'pdf' ? pages.length : 1,
      pageCount: Number(r.pageCount ?? 0),
      source: 'ocr',
      engine: OCR_ENGINE,
      layout: boxes ? pages.map((x) => x.page) : undefined,
    };
  });
}

/** A PDF's result from its text pages and the pages the engine read, in page order. */
function fromPlan(file: string, plan: PdfPlan, read: any[], boxes: boolean, ocrMs = 0): OcrResult {
  const byPage = new Map<number, { text: string; page: OcrPage }>();
  for (const [n, p] of plan.text) byPage.set(n, { text: p.text, page: textPage(file, p) });
  for (const p of read) {
    const n = Number(p?.page ?? -1);
    if (n >= 0) byPage.set(n, { text: String(p?.text ?? ''), page: enginePage(file, p, boxes) });
  }
  const order = [...byPage.keys()].sort((a, b) => a - b);
  const ocred = order.filter((n) => byPage.get(n)!.page.source === 'ocr').length;
  return {
    path: file,
    ok: true,
    text: order.map((n) => byPage.get(n)!.text).join('\n\n'),
    ms: plan.ms + ocrMs,
    pages: order.length,
    pageCount: plan.pageCount,
    source: ocred === 0 ? 'text' : ocred === order.length ? 'ocr' : 'mixed',
    engine: ocred ? OCR_ENGINE : undefined,
    layout: boxes ? order.map((n) => byPage.get(n)!.page) : undefined,
  };
}

/**
 * What a PDF's text layer gives: its pages with text, and the pages to OCR. Null when it can't say (too big, damaged,
 * encrypted, or no pages found): the engine renders and reads the PDF, as before.
 */
function planPdf(file: string, maxPages: number, scale: number): PdfPlan | null {
  const t0 = Date.now();
  try {
    if (statSync(file).size > PDF_TEXT_MAX_BYTES) return null;
    const pdf = readPdfText(readFileSync(file), { maxPages, scale });
    if (pdf.encrypted || !pdf.pageCount) return null;
    const text = new Map<number, PdfTextPage>();
    const ocr: number[] = [];
    for (const p of pdf.pages) {
      if (needsOcr(p)) ocr.push(p.index);
      else text.set(p.index, p);
    }
    return { pageCount: pdf.pageCount, text, ocr, ms: Date.now() - t0 };
  } catch {
    return null;
  }
}

/**
 * Whether opening each file would download it (OneDrive's online-only), as Windows' attributes say: true, false, or
 * null for a file that isn't there. Node can't see those attributes, and reading such a file would fetch it.
 */
async function cloudOnly(paths: string[]): Promise<(boolean | null)[]> {
  const script = `$out = foreach ($p in @(${paths.map((p) => psQuote(path.resolve(p))).join(', ')})) {
  try { $a = [int][System.IO.File]::GetAttributes($p); [bool](($a -band 0x1000) -or ($a -band 0x40000) -or ($a -band 0x400000)) } catch { $null }
}
ConvertTo-Json -Compress -InputObject @($out)`;
  try {
    const got = JSON.parse((await powershell(script, { timeoutMs: 30_000 })).trim() || '[]');
    const list = Array.isArray(got) ? got : [got];
    return paths.map((_, k) => (typeof list[k] === 'boolean' ? list[k] : null));
  } catch {
    // Can't ask: no text layer read here, the engine checks each file itself.
    return paths.map(() => null);
  }
}

/**
 * Reeve's reader (its screens' checks): each picture's lines, with each word's box in the picture's own pixels, and
 * its size. Pictures are read as stored, ignoring EXIF, as Reeve's own reader did.
 */
export async function ocrImages(files: string[], opts: { scale?: number | 'auto'; batch?: number; tmpRoot?: string } = {}): Promise<OcrPage[]> {
  const res = await ocrFiles(
    files.map((f) => ({ path: f, kind: 'image' as const })),
    { tmpRoot: opts.tmpRoot ?? path.join(os.tmpdir(), 'kit-ocr'), scale: opts.scale ?? 1, batchWeight: opts.batch ?? 40, boxes: true, orient: false },
  );
  return res.map((r) => {
    const file = path.resolve(r.path);
    if (!r.ok) return { file, width: 0, height: 0, lines: [], error: r.error ?? 'unreadable' };
    const p = r.layout?.[0];
    return { file, width: p?.width ?? 0, height: p?.height ?? 0, lines: p?.lines ?? [] };
  });
}
