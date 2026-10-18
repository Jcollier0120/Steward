import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The kit's OCR (ocr.ts, ocr.ps1: the Clerk's and the Scribe's, kit 2.87.0): its batches, then Windows' own OCR on a
// drawn screenshot and a seven-page PDF, in a scratch folder. The Clerk's tests, on the kit's copy.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-ocr-'));
after(() => rmSync(home, { recursive: true, force: true }));

const { batches, ocrFiles } = await import('./fixture/src/kit/ocr.ts');
const { powershell, psQuote } = await import('./fixture/src/kit/ps.ts');

/** A small, valid PDF with one line of Helvetica text per page. */
function makePdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const stream = `BT /F1 28 Tf 60 700 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A PNG of black text on white, drawn by System.Drawing (Windows PowerShell). */
async function makeTextPng(file: string, text: string): Promise<void> {
  await powershell(`Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900, 160
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$font = New-Object System.Drawing.Font 'Segoe UI', 26
$g.DrawString(${psQuote(text)}, $font, [System.Drawing.Brushes]::Black, 20, 50)
$g.Dispose()
$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`);
}

test('OCR batches weigh a PDF as its page limit, in order', () => {
  const jobs = [...Array(3)].map((_, i) => ({ path: `${i}.png`, kind: 'image' as const }));
  const b = batches([...jobs, { path: 'a.pdf', kind: 'pdf' }, ...jobs], 6, 5);
  assert.deepEqual(b.map((x) => x.length), [3, 2, 2]);
  assert.deepEqual(batches([], 40, 5), []);
  assert.deepEqual(batches([{ path: 'big.pdf', kind: 'pdf' }], 3, 5).length, 1, 'a PDF heavier than a batch still gets one of its own');
});

test('Windows OCR reads a screenshot and the first five pages of a PDF, with a thumbnail of page 1', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(home, 'ocr');
  mkdirSync(path.join(dir, 'thumbs'), { recursive: true });
  const png = path.join(dir, 'shot.png');
  const pdf = path.join(dir, 'scan.pdf');
  await makeTextPng(png, 'Error 25006: the printer is offline');
  writeFileSync(pdf, makePdf(['Invoice 4471', 'page two', 'page three', 'page four', 'page five', 'page six SECRETSIX', 'page seven']));
  const batched: number[] = [];
  const res = await ocrFiles(
    [
      { path: png, kind: 'image' },
      { path: pdf, kind: 'pdf', thumb: path.join(dir, 'thumbs', 'scan.png') },
      { path: path.join(dir, 'missing.png'), kind: 'image' },
    ],
    { tmpRoot: path.join(dir, 'tmp'), onBatch: (r) => void batched.push(r.length) },
  );
  assert.ok(res[0].ok, res[0].error);
  assert.match(res[0].text, /25006/);
  assert.ok(res[1].ok, res[1].error);
  assert.match(res[1].text, /Invoice 4471/);
  assert.equal(res[1].pages, 5);
  assert.equal(res[1].pageCount, 7);
  assert.doesNotMatch(res[1].text, /SECRETSIX/);
  assert.ok(readFileSync(path.join(dir, 'thumbs', 'scan.png')).length > 100, 'page 1 rendered for the thumbnail');
  assert.equal(res[2].ok, false, 'a file not there is unread, and says why');
  assert.ok(res[2].error);
  assert.deepEqual(batched, [3]);
  assert.deepEqual(readdirSync(path.join(dir, 'tmp')), [], "each batch's list and page renders are removed");
});

test('a folder with curly quotes in its name reaches PowerShell as text, never as code', { skip: process.platform !== 'win32' }, async () => {
  // Windows PowerShell ends a single-quoted string at ’ and ‘ too: this name would run New-Item if it were code,
  // making the file x-pwned beside it.
  const pwned = path.join(home, 'x-pwned');
  const dir = path.join(home, 'x’; New-Item -ItemType File $ListFile-pwned; ‘y');
  mkdirSync(dir, { recursive: true });
  const png = path.join(dir, 'O’Brien.png');
  // Drawn where the fixture's own PowerShell is safe, then copied in: only the OCR sees the name.
  await makeTextPng(path.join(home, 'obrien.png'), 'Error 25006: the printer is offline');
  copyFileSync(path.join(home, 'obrien.png'), png);
  const out = await ocrFiles([{ path: png, kind: 'image' }], { tmpRoot: path.join(dir, 'tmp') }).catch((e: Error) => e);
  assert.ok(!existsSync(pwned), 'nothing in the name was run');
  assert.ok(!(out instanceof Error), out instanceof Error ? out.message : '');
  assert.ok(out[0].ok, out[0].error);
  assert.match(out[0].text, /25006/);
});
