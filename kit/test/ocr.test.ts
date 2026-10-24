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

const { batches, ocrFiles, ocrImages, parseAnswers, readInLanguage, OCR_ENGINE } = await import('./fixture/src/kit/ocr.ts');
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

test("the model reads what it can, in the caller's lane; Windows' OCR reads what it didn't, and each result says which read it", { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(home, 'model');
  mkdirSync(dir, { recursive: true });
  const good = path.join(dir, 'good.png');
  const bad = path.join(dir, 'bad.png');
  await makeTextPng(good, 'Error 25006: the printer is offline');
  copyFileSync(good, bad);
  const jpg = path.join(dir, 'scan.jpg');
  await makeTextPng(jpg, 'Receipt 7731 for the boiler repair', true);
  const scan = path.join(dir, 'scan.pdf');
  writeFileSync(scan, pdfMake.makePdf([{ jpeg: readFileSync(jpg) }]));
  const thumb = path.join(dir, 'scan-thumb.png');
  // The model's reader as ocr-npu.ts gives it, without a model: it can't read bad.png.
  const asked: { pages: any[]; lane?: string }[] = [];
  const model = {
    engine: 'model-npu' as const,
    async read(pages: any[], o: any = {}) {
      asked.push({ pages: pages.map((p) => ({ ...p, there: existsSync(p.file) })), lane: o.lane });
      return pages.map((p, id) =>
        path.basename(p.file) === 'bad.png'
          ? { id, error: "the text reader couldn't open it", engine: 'model-npu' as const }
          : { id, width: 2000, height: 1000, ms: 3, engine: 'model-npu' as const, lines: [{ text: `model read ${path.basename(p.file)}`, words: [{ t: 'model', x: 100, y: 200, w: 300, h: 50 }] }] },
      );
    },
  };
  const tmpRoot = path.join(dir, 'tmp');
  const jobs = [
    { path: good, kind: 'image' as const },
    { path: bad, kind: 'image' as const },
    { path: scan, kind: 'pdf' as const, thumb },
  ];
  const [g, b, s] = await ocrFiles(jobs, { tmpRoot, boxes: true, lane: 'interactive', modelReader: async () => model });
  assert.equal(asked.length, 1, 'one read for the batch');
  assert.equal(asked[0].lane, 'interactive');
  assert.deepEqual(
    asked[0].pages.map((p) => [path.basename(p.file).replace(/^job\d+-/, ''), p.scale, p.orient, p.there]),
    [
      ['good.png', 1, true, true],
      ['bad.png', 1, true, true],
      ['p0.png', 1, false, true],
    ],
    "the pictures as they are; the scan's page rendered for it",
  );
  assert.equal(g.engine, 'model-npu');
  assert.equal(g.text, 'model read good.png');
  assert.deepEqual([g.layout![0].width, g.layout![0].height], [2000, 1000]);
  assert.ok(b.ok, b.error);
  assert.equal(b.engine, OCR_ENGINE, "Windows' OCR read what the model couldn't");
  assert.match(b.text, /25006/);
  assert.ok(s.ok, s.error);
  assert.equal(s.source, 'ocr');
  assert.equal(s.engine, 'model-npu');
  assert.match(s.text, /^model read job\d+-p0\.png$/);
  assert.equal(s.pageCount, 1);
  // the page's size and boxes at pdfScale (Letter at 96 dpi, twice), however wide it was rendered
  assert.deepEqual([s.layout![0].width, s.layout![0].height], [1632, 816]);
  assert.deepEqual(s.layout![0].lines[0].words[0], { t: 'model', x: 81.6, y: 163.2, w: 244.8, h: 40.8 });
  assert.ok(readFileSync(thumb).length > 100, 'page 1 rendered for the thumbnail');
  assert.deepEqual(readdirSync(tmpRoot), [], 'the rendered pages removed with the batch');
});

test("a page the model read as if in another alphabet is read again by Windows' OCR in it; only that alphabet's lines replace the model's", { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(home, 'again');
  mkdirSync(dir, { recursive: true });
  const ru = path.join(dir, 'ru.png');
  const en = path.join(dir, 'en.png');
  await makeTextPng(ru, 'Invoice 4521');
  copyFileSync(ru, en);
  const jpg = path.join(dir, 'scan.jpg');
  await makeTextPng(jpg, 'Receipt 7731', true);
  const scan = path.join(dir, 'scan.pdf');
  writeFileSync(scan, pdfMake.makePdf([{ jpeg: readFileSync(jpg) }]));
  // The model reads Russian as Latin look-alikes; en.png it reads well.
  const word = (t: string, y: number) => ({ t, x: 100, y, w: 300, h: 50 });
  const model = {
    engine: 'model-npu' as const,
    async read(pages: any[]) {
      return pages.map((p, id) => ({
        id,
        width: 2000,
        height: 1000,
        ms: 3,
        engine: 'model-npu' as const,
        lines:
          path.basename(p.file) === 'en.png'
            ? [{ text: 'Invoice 4521 is paid', words: [word('Invoice', 200)] }]
            : [
                { text: 'CuëT N9 4521 oT 12 MapTa', words: [word('CuëT', 200)] },
                { text: 'Total: 184 EUR', words: [word('Total:', 300)] },
              ],
      }));
    },
  };
  const asked: any[] = [];
  const readAgain = async (pages: any[], language: string) => {
    asked.push({ language, pages: pages.map((p) => [path.basename(p.file).replace(/^job\d+-/, ''), p.scale, p.orient]) });
    const read = { page: 0, width: 2000, height: 1000, lines: [{ text: 'Счёт № 4521 от 12 марта', words: [{ t: 'Счёт', x: 100, y: 200, w: 320, h: 50 }] }, { text: 'Tota1: 184 EUR', words: [word('Tota1:', 300)] }] };
    return new Map(pages.map((_, i) => [i, { i, ok: true, ms: 40, pageCount: 1, read: [read] }]));
  };
  const logged: string[] = [];
  const tmpRoot = path.join(dir, 'tmp');
  const [r, e, s] = await ocrFiles([{ path: ru, kind: 'image' }, { path: en, kind: 'image' }, { path: scan, kind: 'pdf' }], {
    tmpRoot,
    boxes: true,
    modelReader: async () => model,
    otherAlphabets: async () => ['ru-RU'],
    readAgain,
    log: (l) => logged.push(l),
  });
  assert.deepEqual(asked, [{ language: 'ru-RU', pages: [['ru.png', 1, true], ['p0.png', 1, false]] }], 'only the pages that look unread, each as the model read it');
  assert.equal(r.engine, 'model-npu+windows');
  assert.equal(r.text, 'Счёт № 4521 от 12 марта\nTotal: 184 EUR', "the Russian line is Windows', the Latin one stays the model's");
  assert.equal(r.ms, 43);
  assert.equal(e.engine, 'model-npu');
  assert.equal(e.text, 'Invoice 4521 is paid');
  assert.equal(s.engine, 'model-npu+windows');
  assert.deepEqual(s.layout![0].lines[0].words[0], { t: 'Счёт', x: 81.6, y: 163.2, w: 261.1, h: 40.8 }, "Windows' boxes at pdfScale, as the model's");
  assert.deepEqual(logged.filter((l) => /again/.test(l)), ["read 2 pages again with Windows' OCR in ru-RU: kept 2 of its lines"]);
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test("Windows' OCR reads again in the language asked, at each picture's scale; Latin text keeps the model's read, and a language that's gone changes nothing", { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(home, 'language');
  mkdirSync(dir, { recursive: true });
  const png = path.join(dir, 'printer.png');
  await makeTextPng(png, 'Error 25006: the printer is offline');
  const got = await readInLanguage([{ file: png, scale: 2, orient: false }], 'en-US', dir);
  const a = got.get(0);
  assert.ok(a?.ok, a?.error);
  assert.match(a.read[0].text, /printer is offline/);
  assert.deepEqual([a.read[0].width, a.read[0].height], [900, 160], "the picture's own size, read twice as big");
  const w = a.read[0].lines[0].words[0];
  assert.ok(w.x >= 0 && w.x + w.w <= 900 && w.y + w.h <= 160, `its boxes in the picture's own pixels: ${JSON.stringify(w)}`);
  await assert.rejects(readInLanguage([{ file: png, scale: 1, orient: true }], 'xx-XX', dir), /no OCR language xx-XX/);

  // The model's read looks like another alphabet; Windows reads it in a Latin one, or can't: the model's read stands.
  const model = {
    engine: 'model-npu' as const,
    async read(pages: any[]) {
      return pages.map((_, id) => ({ id, width: 900, height: 160, ms: 3, engine: 'model-npu' as const, lines: [{ text: 'CuëT N9 25006 oT MapTa', words: [{ t: 'CuëT', x: 20, y: 50, w: 600, h: 40 }] }] }));
    },
  };
  for (const language of ['en-US', 'xx-XX']) {
    const [r] = await ocrFiles([{ path: png, kind: 'image' }], { tmpRoot: path.join(dir, 'tmp'), modelReader: async () => model, otherAlphabets: async () => [language] });
    assert.ok(r.ok, r.error);
    assert.equal(r.engine, 'model-npu', language);
    assert.equal(r.text, 'CuëT N9 25006 oT MapTa', language);
  }
});
