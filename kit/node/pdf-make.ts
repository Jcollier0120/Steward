import { deflateSync } from 'node:zlib';

/**
 * Small PDFs with known text, for the text reader's tests and its check (ocr-check.ts): pages of text in the standard
 * fonts (a text layer, WinAnsi), and pages that are one picture (a scan, from a JPEG), optionally compressed and
 * packed in object streams with a cross-reference stream, as PDF 1.5 writers do.
 */

export type PdfFontName = 'Helvetica' | 'Helvetica-Bold' | 'Times-Roman' | 'Times-Bold' | 'Courier';

export interface PdfLineSpec {
  text: string;
  /** From the page's left and top edges, in points. */
  x: number;
  y: number;
  size: number;
  font?: PdfFontName;
}

export interface PdfPageSpec {
  /** Points; US Letter by default. */
  width?: number;
  height?: number;
  lines?: PdfLineSpec[];
  /** A scan: this JPEG over the whole page. */
  jpeg?: Buffer;
}

export interface MakePdfOptions {
  /** Content streams FlateDecode'd. */
  compress?: boolean;
  /** Objects in an object stream, with a cross-reference stream (PDF 1.5). */
  objectStreams?: boolean;
}

/** A JPEG's size and components, from its frame header. */
export function jpegInfo(b: Buffer): { width: number; height: number; components: number } {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), components: b[i + 9] };
    }
    i += 2 + len;
  }
  throw new Error('not a JPEG');
}

const cp1252 = new Map<string, number>(
  Array.from({ length: 256 }, (_, i) => [new TextDecoder('windows-1252').decode(Uint8Array.of(i)), i] as [string, number]).filter(([c, i]) => i >= 32 && c !== '�'),
);

/** Text as a PDF literal string in WinAnsi; characters it lacks become "?". */
function literal(s: string): string {
  let out = '(';
  for (const ch of s) {
    const c = cp1252.get(ch) ?? 0x3f;
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

export function makePdf(pages: PdfPageSpec[], opts: MakePdfOptions = {}): Buffer {
  // Objects by number (1-based); a stream is [dict, data].
  const objs: (string | [string, Buffer])[] = [];
  const add = (o: string | [string, Buffer]) => objs.push(o) && objs.length;
  const catalog = add('');
  const pagesObj = add('');
  const fonts = new Map<PdfFontName, number>();
  const fontFor = (f: PdfFontName) => {
    if (!fonts.has(f)) fonts.set(f, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
    return fonts.get(f)!;
  };
  const kids: number[] = [];
  for (const p of pages) {
    const W = p.width ?? 612;
    const H = p.height ?? 792;
    let content = '';
    const res: string[] = [];
    if (p.jpeg) {
      const j = jpegInfo(p.jpeg);
      const im = add([`<< /Type /XObject /Subtype /Image /Width ${j.width} /Height ${j.height} /ColorSpace /${j.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg]);
      res.push(`/XObject << /Im1 ${im} 0 R >>`);
      content += `q ${W} 0 0 ${H} 0 0 cm /Im1 Do Q\n`;
    }
    const used = new Map<PdfFontName, string>();
    for (const l of p.lines ?? []) {
      const f = l.font ?? 'Helvetica';
      if (!used.has(f)) used.set(f, `F${used.size + 1}`);
      content += `BT /${used.get(f)} ${l.size} Tf 1 0 0 1 ${l.x} ${(H - l.y).toFixed(2)} Tm ${literal(l.text)} Tj ET\n`;
    }
    if (used.size) res.push(`/Font << ${[...used].map(([f, n]) => `/${n} ${fontFor(f)} 0 R`).join(' ')} >>`);
    const data = Buffer.from(content, 'latin1');
    const c = add(opts.compress ? ['<< /Filter /FlateDecode', deflateSync(data)] : ['<<', data]);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << ${res.join(' ')} >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  const parts: Buffer[] = [Buffer.from(opts.objectStreams ? '%PDF-1.5\n%\xe2\xe3\xcf\xd3\n' : '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let at = parts[0].length;
  const write = (s: string | Buffer) => {
    const b = typeof s === 'string' ? Buffer.from(s, 'latin1') : s;
    parts.push(b);
    at += b.length;
  };
  const streamObj = (n: number, dict: string, data: Buffer) => {
    write(`${n} 0 obj\n${dict} /Length ${data.length} >>\nstream\n`);
    write(data);
    write('\nendstream\nendobj\n');
  };
  // where each object is: [type, a, b] as a cross-reference stream says it (1: at an offset; 2: in an object stream)
  const xref: [number, number, number][] = [[0, 0, 65535]];

  if (!opts.objectStreams) {
    objs.forEach((o, i) => {
      xref.push([1, at, 0]);
      if (typeof o === 'string') write(`${i + 1} 0 obj\n${o}\nendobj\n`);
      else streamObj(i + 1, o[0], o[1]);
    });
    const start = at;
    write(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
    for (const [, off] of xref.slice(1)) write(`${String(off).padStart(10, '0')} 00000 n \n`);
    write(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${start}\n%%EOF\n`);
    return Buffer.concat(parts);
  }

  const packed = objs.map((o, i) => ({ o, n: i + 1 })).filter((x): x is { o: string; n: number } => typeof x.o === 'string');
  const stmNum = objs.length + 1;
  const xrefNum = objs.length + 2;
  let body = '';
  const head: string[] = [];
  packed.forEach(({ o, n }) => {
    head.push(`${n} ${body.length}`);
    body += o + '\n';
  });
  const headStr = head.join(' ') + '\n';
  const where = new Map<number, [number, number, number]>();
  packed.forEach(({ n }, k) => where.set(n, [2, stmNum, k]));
  objs.forEach((o, i) => {
    if (typeof o !== 'string') {
      where.set(i + 1, [1, at, 0]);
      streamObj(i + 1, o[0], o[1]);
    }
  });
  where.set(stmNum, [1, at, 0]);
  streamObj(stmNum, `<< /Type /ObjStm /N ${packed.length} /First ${headStr.length} /Filter /FlateDecode`, deflateSync(Buffer.from(headStr + body, 'latin1')));
  where.set(xrefNum, [1, at, 0]);
  for (let n = 1; n <= xrefNum; n++) xref.push(where.get(n) ?? [0, 0, 0]);
  const rows = Buffer.alloc(xref.length * 7);
  xref.forEach(([t, a, b], k) => {
    rows[k * 7] = t;
    rows.writeUInt32BE(a, k * 7 + 1);
    rows.writeUInt16BE(b & 0xffff, k * 7 + 5);
  });
  const start = at;
  streamObj(xrefNum, `<< /Type /XRef /Size ${xrefNum + 1} /W [1 4 2] /Root ${catalog} 0 R /Filter /FlateDecode`, deflateSync(rows));
  write(`startxref\n${start}\n%%EOF\n`);
  return Buffer.concat(parts);
}
