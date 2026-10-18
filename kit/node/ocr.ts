import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { powershell, psQuote } from './ps.ts';

/**
 * Reads the text in images and PDFs with Windows' built-in OCR (Windows.Media.Ocr, on the CPU), the
 * way npu-agent's screen checks do (its src/screens/ocr.ts and ocr.ps1, adapted here: a copy, not an
 * import across repos). PDF pages are rendered with Windows.Data.Pdf first. Many files go to one
 * PowerShell process, because starting one costs about a second.
 */

export interface OcrJob {
  path: string;
  kind: 'image' | 'pdf';
  /** PDFs: where to save a small render of page 1 (in the data folder), for the page's thumbnail. */
  thumb?: string | null;
}

export interface OcrResult {
  path: string;
  ok: boolean;
  text: string;
  ms: number;
  pages: number;
  pageCount: number;
  error?: string;
  /** OneDrive's "online-only": opening the file would download it, so it was not read. */
  cloudOnly?: boolean;
}

export interface OcrOptions {
  /** A folder of its own for the batch's list and page renders (deleted afterwards). */
  tmpRoot: string;
  /** Enlarges images before reading; 1 reads ordinary screenshots well. */
  scale?: number;
  pdfMaxPages?: number;
  /** PDF pages render at 96 dpi times this. */
  pdfScale?: number;
  /** Work per PowerShell process: an image counts 1, a PDF its page limit. */
  batchWeight?: number;
  /** Called after each batch, so a long round saves as it goes. */
  onBatch?: (results: OcrResult[]) => void | Promise<void>;
}

/** The script without its comment lines: it travels as -EncodedCommand, which has a length limit. */
const SCRIPT = readFileSync(new URL('./ocr.ps1', import.meta.url), 'utf8')
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

let seq = 0;

export async function ocrFiles(jobs: OcrJob[], opts: OcrOptions): Promise<OcrResult[]> {
  const pdfMaxPages = opts.pdfMaxPages ?? 5;
  const all: OcrResult[] = [];
  for (const batch of batches(jobs, opts.batchWeight ?? 40, pdfMaxPages)) {
    const dir = path.join(opts.tmpRoot, `ocr-${process.pid}-${++seq}`);
    mkdirSync(dir, { recursive: true });
    try {
      const listFile = path.join(dir, 'list.json');
      writeFileSync(
        listFile,
        JSON.stringify({
          scale: opts.scale ?? 1,
          pdfMaxPages,
          pdfScale: opts.pdfScale ?? 2,
          tmpDir: dir,
          // WinRT's GetFileFromPathAsync wants backslashes.
          jobs: batch.map((j, i) => ({ i, path: path.resolve(j.path), kind: j.kind, thumb: j.thumb ? path.resolve(j.thumb) : null })),
        }),
      );
      const weight = batch.reduce((n, j) => n + (j.kind === 'pdf' ? pdfMaxPages : 1), 0);
      const out = await powershell(`$ListFile = ${psQuote(listFile)}\n${SCRIPT}`, { timeoutMs: 30_000 + weight * 15_000 });
      const byIndex = new Map<number, any>();
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const r = JSON.parse(line);
          if (typeof r.i === 'number') byIndex.set(r.i, r);
        } catch {
          // A stray line; the job shows up below as unread.
        }
      }
      const results = batch.map((j, i): OcrResult => {
        const r = byIndex.get(i);
        if (!r) return { path: j.path, ok: false, text: '', ms: 0, pages: 0, pageCount: 0, error: 'no answer from OCR' };
        return {
          path: j.path,
          ok: !!r.ok,
          text: typeof r.text === 'string' ? r.text : '',
          ms: Number(r.ms ?? 0),
          pages: Number(r.pages ?? 0),
          pageCount: Number(r.pageCount ?? 0),
          error: r.ok ? undefined : String(r.error ?? 'unreadable'),
          cloudOnly: r.cloudOnly ? true : undefined,
        };
      });
      all.push(...results);
      await opts.onBatch?.(results);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return all;
}
