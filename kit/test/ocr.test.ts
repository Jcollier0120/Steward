import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The kit's text reader (ocr.ts, ocr.ps1: the Clerk's and the Scribe's since kit 2.87.0, all four staff's since
// 2.102.0): its batches and answers, then Windows' own OCR on drawn screenshots and scans, and PDFs read from their
// text layer, in a scratch folder.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-ocr-'));
after(() => rmSync(home, { recursive: true, force: true }));

const { batches, ocrFiles, ocrImages, parseAnswers, OCR_ENGINE } = await import('./fixture/src/kit/ocr.ts');
const { powershell, psQuote } = await import('./fixture/src/kit/ps.ts');
const pdfMake = await import('./fixture/src/kit/pdf-make.ts');

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

/** A PNG of black text on white, drawn by System.Drawing (Windows PowerShell); a JPEG page for a scan with `page`. */
async function makeTextPng(file: string, text: string, page = false): Promise<void> {
  await powershell(`Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap ${page ? '1275, 1650' : '900, 160'}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$font = New-Object System.Drawing.Font 'Segoe UI', 26
$g.DrawString(${psQuote(text)}, $font, [System.Drawing.Brushes]::Black, ${page ? '120, 200' : '20, 50'})
$g.Dispose()
$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::${page ? 'Jpeg' : 'Png'})
$bmp.Dispose()`);
}

test("the engine's answers: a raw control character is read past, a line that won't parse is that job's error", () => {
  const out = [
    'WARNING: something PowerShell said',
    '{"i":0,"ok":true,"ms":5,"read":[{"page":0,"text":"• item"}]}',
    // what a code page 437 console once made of the bullet: a bell, raw, inside the string
    '{"i":1,"ok":true,"ms":5,"read":[{"page":0,"text":"\u0007 item"}]}',
    '{"i":2,"ok":true,"read":[{"text":"cut off',
    '',
  ].join('\r\n');
  const a = parseAnswers(out);
  assert.equal(a.get(0).read[0].text, '• item');
  assert.equal(a.get(1).ok, true);
  assert.equal(a.get(1).read[0].text, '  item');
  assert.deepEqual(a.get(2), { i: 2, ok: false, error: "OCR's answer was garbled" });
  assert.equal(a.size, 3);
});

test("ocr.ps1's answers are ASCII, whatever the console's code page", { skip: process.platform !== 'win32' }, () => {
  // Its own answer writer, in a powershell.exe of its own with no UTF-8 prelude: its output is the console's code page
  // (437 on an English PC), which turned a bullet into a bell and broke the line.
  const ps1 = readFileSync(path.join(import.meta.dirname, 'fixture', 'src', 'kit', 'ocr.ps1'), 'utf8');
  const writer = /function Out-Answer[\s\S]*?\n\}/.exec(ps1)?.[0];
  assert.ok(writer, "ocr.ps1's Out-Answer");
  const script = `${writer}\nOut-Answer ([ordered]@{ i = 0; ok = $true; read = @(@{ text = ([string][char]0x2022) + ' Total ' + [char]0x20AC + ' caf' + [char]0xE9 + [char]7 + ([char]::ConvertFromUtf32(0x1F600)) + [char]0x2028 }) })`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'latin1', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim();
  assert.match(line, /^[\x20-\x7e]+$/, 'printable ASCII only');
  assert.equal(JSON.parse(line).read[0].text, '• Total € café\u0007😀 ');
});

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
  assert.equal(res[1].source, 'text', 'a PDF with a text layer is read from it, not OCRed');
  assert.equal(res[1].engine, undefined);
  assert.equal(res[0].source, 'ocr');
  assert.equal(res[0].engine, OCR_ENGINE);
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

test("each word's box, in the picture's own pixels; Reeve's ocrImages", { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(home, 'boxes');
  mkdirSync(dir, { recursive: true });
  const png = path.join(dir, 'shot.png');
  await makeTextPng(png, 'Error 25006: the printer is offline');
  for (const scale of [1, 2, 'auto' as const]) {
    const [r] = await ocrFiles([{ path: png, kind: 'image' }], { tmpRoot: path.join(dir, 'tmp'), boxes: true, scale });
    assert.ok(r.ok, r.error);
    const page = r.layout![0];
    assert.deepEqual([page.width, page.height], [900, 160], `the stored size at scale ${scale}`);
    const words = page.lines.flatMap((l: any) => l.words);
    const w = words.find((x: any) => x.t.includes('25006'));
    assert.ok(w, JSON.stringify(page.lines));
    assert.ok(w.x > 20 && w.x + w.w < 900 && w.y > 40 && w.y + w.h < 120, `inside the drawn text at scale ${scale}: ${JSON.stringify(w)}`);
  }
  const pages = await ocrImages([png, path.join(dir, 'missing.png')], { tmpRoot: path.join(dir, 'tmp') });
  assert.equal(pages[0].file, path.resolve(png));
  assert.equal(pages[0].width, 900);
  assert.match(pages[0].lines.map((l: any) => l.text).join(' '), /25006/);
  assert.equal(pages[1].lines.length, 0);
  assert.ok(pages[1].error);
});

test('a scanned PDF is OCRed; a PDF with text reads its text unless told to OCR it; a PDF of both, page by page', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(home, 'pdfs');
  mkdirSync(dir, { recursive: true });
  const jpg = path.join(dir, 'scan.jpg');
  await makeTextPng(jpg, 'Receipt 7731 for the boiler repair', true);
  const jpeg = readFileSync(jpg);
  const scan = path.join(dir, 'scan.pdf');
  const text = path.join(dir, 'text.pdf');
  const mixed = path.join(dir, 'mixed.pdf');
  writeFileSync(scan, pdfMake.makePdf([{ jpeg }]));
  writeFileSync(text, pdfMake.makePdf([{ lines: [{ text: 'Statement for account ending 4417', x: 72, y: 100, size: 14 }] }], { compress: true }));
  writeFileSync(mixed, pdfMake.makePdf([{ lines: [{ text: 'Cover letter, page one', x: 72, y: 100, size: 14 }] }, { jpeg }], { compress: true }));
  const tmpRoot = path.join(dir, 'tmp');
  const jobs = [scan, text, mixed].map((p) => ({ path: p, kind: 'pdf' as const }));
  const [s, t, m] = await ocrFiles(jobs, { tmpRoot, boxes: true });
  assert.ok(s.ok, s.error);
  assert.equal(s.source, 'ocr');
  assert.equal(s.engine, OCR_ENGINE);
  assert.match(s.text, /7731/);
  assert.ok(t.ok, t.error);
  assert.equal(t.source, 'text');
  assert.equal(t.text, 'Statement for account ending 4417');
  assert.equal(m.source, 'mixed');
  assert.equal(m.pages, 2);
  assert.match(m.text, /^Cover letter, page one\n\n[\s\S]*7731/);
  assert.deepEqual(m.layout!.map((p: any) => [p.page, p.source]), [[0, 'text'], [1, 'ocr']]);
  // both pages' boxes in one frame: Letter at 96 dpi times pdfScale 2, however Windows scales its renders
  assert.deepEqual(m.layout!.map((p: any) => [p.width, p.height]), [[1632, 2112], [1632, 2112]]);
  const ocrWord = m.layout![1].lines.flatMap((l: any) => l.words).find((w: any) => w.t.includes('7731'));
  assert.ok(ocrWord && ocrWord.x + ocrWord.w < 1632 && ocrWord.y + ocrWord.h < 2112, JSON.stringify(ocrWord));
  const [old] = await ocrFiles([{ path: text, kind: 'pdf' }], { tmpRoot, pdfText: false });
  assert.ok(old.ok, old.error);
  assert.equal(old.source, 'ocr', 'pdfText: false renders and OCRs, as before');
  assert.match(old.text, /4417/);
  assert.deepEqual(readdirSync(tmpRoot), []);
});
