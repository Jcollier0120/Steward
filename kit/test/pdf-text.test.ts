import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

// The text reader's PDF text layer (pdf-text.ts, kit 2.102.0): PDFs made here (pdf-make.ts, or object by object), read
// back exactly, with no rendering and nothing installed.
const { readPdfText, needsOcr, glyphText } = await import('./fixture/src/kit/pdf-text.ts');
const { makePdf } = await import('./fixture/src/kit/pdf-make.ts');

/** A PDF from its objects (1-based, in order): a string is the object, [dict, data] a stream. Then any later objects, an update appended. */
function rawPdf(objs: (string | [string, string | Buffer])[], o: { trailer?: string; update?: Record<number, string | [string, string | Buffer]> } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let at = parts[0].length;
  const write = (s: string | Buffer) => {
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s;
    parts.push(b);
    at += b.length;
  };
  const obj = (n: number, v: string | [string, string | Buffer]) => {
    const off = at;
    if (typeof v === 'string') write(`${n} 0 obj\n${v}\nendobj\n`);
    else {
      const data = typeof v[1] === 'string' ? Buffer.from(v[1], 'latin1') : v[1];
      write(`${n} 0 obj\n${v[0].replace(/>>$/, '')} /Length ${data.length} >>\nstream\n`);
      write(data);
      write('\nendstream\nendobj\n');
    }
    return off;
  };
  const offsets = objs.map((v, i) => obj(i + 1, v));
  const xref = at;
  write(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}`);
  write(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${o.trailer ?? ''} >>\nstartxref\n${xref}\n%%EOF\n`);
  if (o.update) {
    const up = Object.entries(o.update).map(([n, v]) => [Number(n), obj(Number(n), v)] as const);
    const x2 = at;
    write(`xref\n${up.map(([n, off]) => `${n} 1\n${String(off).padStart(10, '0')} 00000 n \n`).join('')}`);
    write(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Prev ${xref} >>\nstartxref\n${x2}\n%%EOF\n`);
  }
  return Buffer.concat(parts);
}

/** One page (object 3) with this content (object 4) and these resources, after a catalog (1) and its pages (2). */
const onePage = (content: string | Buffer, resources: string, more: (string | [string, string | Buffer])[] = [], page = '') => [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << ${resources} >> ${page} >>`,
  ['<<', content] as [string, string | Buffer],
  ...more,
];

const HELV = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

test('a PDF made with text reads back exactly: plain, compressed, and in object streams', () => {
  const lines = [
    'Invoice INV-2026-0451 (overdue)',
    'C:\\Users\\Jordan\\Documents\\Invoices',
    '“Quoted” it’s — 25 € café',
    'Total due: $1,249.50',
  ];
  for (const opts of [{}, { compress: true }, { compress: true, objectStreams: true }]) {
    const pdf = makePdf(
      [{ lines: lines.map((text, k) => ({ text, x: 72, y: 100 + k * 20, size: 12, font: k === 1 ? ('Courier' as const) : ('Helvetica' as const) })) }, { lines: [{ text: 'page two', x: 72, y: 72, size: 12 }] }],
      opts,
    );
    const r = readPdfText(pdf, { scale: 1 });
    assert.equal(r.encrypted, false);
    assert.equal(r.pageCount, 2, JSON.stringify(opts));
    assert.deepEqual(r.pages[0].lines.map((l: any) => l.text), lines, JSON.stringify(opts));
    assert.equal(r.pages[1].text, 'page two');
    assert.equal(r.pages[0].width, 816, 'Letter at 96 dpi');
    assert.equal(r.pages[0].height, 1056);
    assert.equal(needsOcr(r.pages[0]), false);
    assert.equal(needsOcr(r.pages[1]), false, 'a page of two words and nothing else keeps its words');
  }
});

test("words' boxes are in the rendered page's pixels, at the reader's scale", () => {
  const pdf = makePdf([{ lines: [{ text: 'Hello world', x: 72, y: 100, size: 12 }] }]);
  const [p1] = readPdfText(pdf, { scale: 1 }).pages;
  const [p2] = readPdfText(pdf, { scale: 2 }).pages;
  const [hello, world] = p1.lines[0].words;
  assert.equal(hello.t, 'Hello');
  assert.equal(world.t, 'world');
  assert.ok(Math.abs(hello.x - 96) < 2, `x ${hello.x}`);
  // the baseline at 100 pt from the top: the box from about an em above it to below it
  assert.ok(hello.y > 115 && hello.y < 124 && hello.y + hello.h > 133 && hello.y + hello.h < 140, JSON.stringify(hello));
  assert.ok(world.x > hello.x + hello.w, 'the second word after the first');
  assert.equal(p2.width, 1632);
  assert.ok(Math.abs(p2.lines[0].words[0].x - 2 * hello.x) < 0.5);
});

test('TJ: kerning stays inside a word, a wide gap is a space; word spacing and leading too', () => {
  const content = `BT /F1 12 Tf 72 700 Td [(Hel) -20 (lo) -400 (World)] TJ 14 TL T* (next line) Tj ET
BT /F1 12 Tf 72 600 Td 3 Tw (spaced out) Tj ET`;
  const r = readPdfText(rawPdf(onePage(content, '/Font << /F1 5 0 R >>', [HELV])));
  assert.deepEqual(r.pages[0].lines.map((l: any) => l.text), ['Hello World', 'next line', 'spaced out']);
});

test('a Type0 font: Identity-H codes through ToUnicode (bfchar, bfrange, and a bfrange of strings)', () => {
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <0048> <0002> <2022> endbfchar
2 beginbfrange <0010> <0019> <0030> <0020> <0022> [<0041> <00E9> <FB01>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const content = 'BT /F1 12 Tf 72 700 Td <0001 0020 0021 0022 0011 0012 0013 0003> Tj ET';
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Noto /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>';
  const desc = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Noto /DW 500 /W [1 [600 700]] >>';
  const r = readPdfText(rawPdf(onePage(content, '/Font << /F1 5 0 R >>', [font, desc, ['<<', cmap]])));
  // 0003 (last) isn't mapped: counted, not shown
  assert.equal(r.pages[0].text, 'HAéfi123');
  assert.equal(r.pages[0].unmapped, 1);
  const two = readPdfText(rawPdf(onePage('BT /F1 12 Tf 72 700 Td <00010002> Tj ET', '/Font << /F1 5 0 R >>', [font, desc, ['<<', cmap]])));
  assert.equal(two.pages[0].text, 'H•');
});

test("a Type0 font with no ToUnicode is unmapped, and such a page is OCRed", () => {
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /Embedded /Encoding /Identity-H /DescendantFonts [6 0 R] >>';
  const desc = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Embedded >>';
  const codes = Array.from({ length: 30 }, (_, i) => (i + 3).toString(16).padStart(4, '0')).join('');
  const r = readPdfText(rawPdf(onePage(`BT /F1 12 Tf 72 700 Td <${codes}> Tj ET`, '/Font << /F1 5 0 R >>', [font, desc])));
  assert.equal(r.pages[0].glyphs, 30);
  assert.equal(r.pages[0].unmapped, 30);
  assert.equal(needsOcr(r.pages[0]), true);
});

test('Differences by glyph name: uniXXXX, ligatures, accented letters, quotes', () => {
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Custom /FirstChar 65 /LastChar 69 /Widths [500 500 500 500 500] /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /uni2022 /fi /eacute /quoteright /a.sc] >> >>';
  const r = readPdfText(rawPdf(onePage('BT /F1 12 Tf 72 700 Td (ABCDE) Tj ET', '/Font << /F1 5 0 R >>', [font])));
  assert.equal(r.pages[0].text, '•fié’a');
  assert.equal(glyphText('Ccedilla'), 'Ç');
  assert.equal(glyphText('f_f_i'), 'ffi');
  assert.equal(glyphText('u1F600'), '😀');
  assert.equal(glyphText('g123'), null);
});

test('a page turned by /Rotate: its size turned, its text one line', () => {
  const r = readPdfText(rawPdf(onePage('BT /F1 12 Tf 72 700 Td (Turned page) Tj ET', '/Font << /F1 5 0 R >>', [HELV], '/Rotate 90')), { scale: 1 });
  assert.equal(r.pages[0].width, 1056);
  assert.equal(r.pages[0].height, 816);
  assert.equal(r.pages[0].text, 'Turned page');
  const w = r.pages[0].lines[0].words[0];
  assert.ok(w.x >= 0 && w.x + w.w <= 1056 && w.y >= 0 && w.y + w.h <= 816, `inside the turned page: ${JSON.stringify(w)}`);
});

test('bold made by drawing twice reads once, whether glyph by glyph or line over line', () => {
  const content = `BT /F1 12 Tf 72 700 Td (Bold) Tj ET BT /F1 12 Tf 72.3 700 Td (Bold) Tj ET
BT /F1 12 Tf 1 0 0 1 72 650 Tm [(T) 0 (T)] TJ ET`;
  const r = readPdfText(rawPdf(onePage(content, '/Font << /F1 5 0 R >>', [HELV])));
  assert.equal(r.pages[0].lines[0].text, 'Bold');
  assert.equal(r.pages[0].lines.length, 2);
  // two Ts side by side are two letters, not one drawn twice
  assert.equal(r.pages[0].lines[1].text, 'TT');
});

test('text drawn by a form XObject is read, in its place', () => {
  const form = ['<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Matrix [1 0 0 1 0 -100] /Resources << /Font << /F1 5 0 R >> >> >>', 'BT /F1 12 Tf 72 700 Td (From the form) Tj ET'] as [string, string];
  const r = readPdfText(rawPdf(onePage('BT /F1 12 Tf 72 700 Td (On the page) Tj ET /Fm1 Do', '/Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >>', [HELV, form])));
  assert.deepEqual(r.pages[0].lines.map((l: any) => l.text), ['On the page', 'From the form']);
});

test('an incremental update: the later object wins', () => {
  const pdf = rawPdf(onePage('BT /F1 12 Tf 72 700 Td (First draft) Tj ET', '/Font << /F1 5 0 R >>', [HELV]), {
    update: { 4: ['<<', 'BT /F1 12 Tf 72 700 Td (Signed copy) Tj ET'] },
  });
  assert.equal(readPdfText(pdf).pages[0].text, 'Signed copy');
});

test('an encrypted PDF says so and reads nothing (the reader OCRs it)', () => {
  const pdf = rawPdf(onePage('BT /F1 12 Tf 72 700 Td (secret) Tj ET', '/Font << /F1 5 0 R >>', [HELV, '<< /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >>']), { trailer: '/Encrypt 6 0 R' });
  const r = readPdfText(pdf);
  assert.equal(r.encrypted, true);
  assert.equal(r.pageCount, 1);
  assert.deepEqual(r.pages, []);
});

test('which pages need OCR: a scan, a blank page, text as outlines, a picture with a caption', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, ...Array(9).fill(0), 0xff, 0xd9]);
  const scan = readPdfText(makePdf([{ jpeg }, {}, { jpeg, lines: [{ text: 'Figure 1', x: 72, y: 760, size: 9 }] }]));
  assert.equal(scan.pages[0].imageCover, 1);
  assert.equal(needsOcr(scan.pages[0]), true, 'a scan');
  assert.equal(needsOcr(scan.pages[1]), false, 'a blank page is blank');
  assert.equal(needsOcr(scan.pages[2]), true, 'a page that is a picture with a few words on it');
  const outlines = Array.from({ length: 40 }, (_, i) => `${72 + i * 10} 700 m ${76 + i * 10} 710 l ${80 + i * 10} 700 l f`).join('\n');
  const drawn = readPdfText(rawPdf(onePage(outlines, '')));
  assert.equal(drawn.pages[0].shapes, 40);
  assert.equal(needsOcr(drawn.pages[0]), true, 'text drawn as shapes');
  // An OCRed scan (a picture with its text laid over it, invisible): the text is read, nothing more to OCR.
  const words = 'The quick brown fox jumps over the lazy dog and keeps running past the old mill by the river.';
  const sandwich = readPdfText(makePdf([{ jpeg, lines: [{ text: words, x: 72, y: 100, size: 10 }, { text: words, x: 72, y: 120, size: 10 }] }]));
  assert.equal(needsOcr(sandwich.pages[0]), false);
});

test('only the first pages asked for are read; all are counted', () => {
  const pdf = makePdf(Array.from({ length: 7 }, (_, i) => ({ lines: [{ text: `page ${i + 1}`, x: 72, y: 72, size: 12 }] })));
  const r = readPdfText(pdf, { maxPages: 5 });
  assert.equal(r.pageCount, 7);
  assert.deepEqual(r.pages.map((p: any) => p.text), ['page 1', 'page 2', 'page 3', 'page 4', 'page 5']);
});

test('not a PDF throws; a damaged one gives what it can', () => {
  assert.throws(() => readPdfText(Buffer.from('PK\x03\x04 not a pdf')), /not a PDF/);
  const pdf = makePdf([1, 2, 3].map((n) => ({ lines: [{ text: `page ${n} text`, x: 72, y: 72, size: 12 }] })), { compress: true });
  // cut off in page 3's content (object 8): no page 3, no cross-reference table, no trailer
  const cut = pdf.subarray(0, pdf.indexOf('8 0 obj') + 40);
  const r = readPdfText(cut);
  assert.deepEqual(r.pages.slice(0, 2).map((p: any) => p.text), ['page 1 text', 'page 2 text']);
  // a stream that won't inflate doesn't stop the page's other streams
  const bad = rawPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 6 0 R] /Resources << /Font << /F1 5 0 R >> >> >>',
      ['<< /Filter /FlateDecode >>', Buffer.from('not deflate data')],
      HELV,
      ['<< /Filter /FlateDecode >>', deflateSync(Buffer.from('BT /F1 12 Tf 72 700 Td (still here) Tj ET'))],
    ],
  );
  assert.equal(readPdfText(bad).pages[0].text, 'still here');
});
