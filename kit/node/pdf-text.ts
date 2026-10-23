import { constants as zlibConstants, inflateRawSync, inflateSync } from 'node:zlib';

/**
 * The text a PDF carries (kit 2.102.0, spec/OCR.md, "PDFs that carry their text"): its pages' text layer, read without
 * rendering anything, so the text reader (ocr.ts) reads such a PDF exactly and cheaply, and renders and OCRs only the
 * pages that have no text (scans). Node's zlib and nothing else: the kit's files are copied into every agent, and
 * pdf.js would bring megabytes to each.
 *
 * What it reads: the file's objects found by scanning (so a damaged cross-reference table doesn't matter), object
 * streams, the page tree, each page's content streams and the forms they draw, and the text they show, through each
 * font's ToUnicode map, else its encoding (WinAnsi, MacRoman, Standard, with Differences by glyph name). Glyphs are put
 * in lines by where they are drawn, in the order the PDF draws them, with a space where there is a gap.
 *
 * What it doesn't: encrypted PDFs (`encrypted`: the reader OCRs them, as before), and fonts with neither ToUnicode nor
 * an encoding it knows (counted in `unmapped`: a page with many is OCRed). `needsOcr` says which pages to OCR.
 */

export interface PdfWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfTextLine {
  text: string;
  words: PdfWord[];
}

export interface PdfTextPage {
  /** 0-based. */
  index: number;
  /** In pixels at `scale` (1: the page's size in 1/96 inch), as Windows.Data.Pdf renders it, rotation applied. */
  width: number;
  height: number;
  lines: PdfTextLine[];
  text: string;
  /** Glyphs drawn that aren't spaces, and those of them no map turned into text. */
  glyphs: number;
  unmapped: number;
  /** How much of the page images cover, 0 to 1 (a scan is one image over all of it). */
  imageCover: number;
  /** Shapes painted (filled or stroked paths): text drawn as outlines has many. */
  shapes: number;
}

export interface PdfText {
  pageCount: number;
  pages: PdfTextPage[];
  encrypted: boolean;
}

/**
 * Whether a page's text layer isn't enough and the page should be OCRed: almost no text beside a picture or many shapes
 * (a scan, or text drawn as outlines), text that is mostly unmapped glyphs, or a page that is mostly a picture with
 * little text on it. A page of a few words and nothing else keeps its words; a blank one is blank.
 */
export function needsOcr(p: PdfTextPage): boolean {
  if (p.glyphs < 20) return p.imageCover > 0.05 || p.shapes > 10;
  if (p.unmapped / p.glyphs > 0.1) return true;
  return p.imageCover > 0.5 && p.glyphs < 100;
}

/** Above this a PDF isn't parsed here: it is read by rendering, as before (a big PDF is mostly scans). */
export const PDF_TEXT_MAX_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------- values

class Name {
  readonly n: string;
  constructor(n: string) {
    this.n = n;
  }
}
class Ref {
  readonly num: number;
  readonly gen: number;
  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }
}
class Op {
  readonly op: string;
  constructor(op: string) {
    this.op = op;
  }
}
class Stream {
  readonly dict: Dict;
  readonly raw: Buffer;
  constructor(dict: Dict, raw: Buffer) {
    this.dict = dict;
    this.raw = raw;
  }
}
type Dict = Map<string, Val>;
type Val = number | boolean | null | Buffer | Name | Ref | Stream | Dict | Val[] | Op;

const isDict = (v: unknown): v is Dict => v instanceof Map;
const nameOf = (v: unknown) => (v instanceof Name ? v.n : null);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------- lexer

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const EOF = Symbol('eof');
type Tok = number | Buffer | Name | Op | '[' | ']' | '<<' | '>>' | '{' | '}' | typeof EOF;

class Lexer {
  readonly b: Buffer;
  readonly end: number;
  p: number;
  constructor(b: Buffer, start = 0, end = b.length) {
    this.b = b;
    this.p = start;
    this.end = end;
  }

  skip() {
    const { b } = this;
    while (this.p < this.end) {
      const c = b[this.p];
      if (WS[c]) this.p++;
      else if (c === 0x25) {
        while (this.p < this.end && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
      } else break;
    }
  }

  next(): Tok {
    this.skip();
    const { b } = this;
    if (this.p >= this.end) return EOF;
    const c = b[this.p];
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (b[this.p + 1] === 0x3c) {
        this.p += 2;
        return '<<';
      }
      return this.hex();
    }
    if (c === 0x3e) {
      this.p += b[this.p + 1] === 0x3e ? 2 : 1;
      return '>>';
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      this.p++;
      return String.fromCharCode(c) as '[' | ']' | '{' | '}';
    }
    if (c === 0x2f) {
      this.p++;
      const s = this.p;
      while (this.p < this.end && !WS[b[this.p]] && !DELIM[b[this.p]]) this.p++;
      // #xx escapes in names
      return new Name(b.toString('latin1', s, this.p).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === 0x29) {
      // a stray ")"
      this.p++;
      return new Op(')');
    }
    const s = this.p;
    while (this.p < this.end && !WS[b[this.p]] && !DELIM[b[this.p]]) this.p++;
    if (this.p === s) {
      this.p++;
      return new Op(String.fromCharCode(c));
    }
    const word = b.toString('latin1', s, this.p);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (/^[+-]?\d*\.?\d*$/.test(word) && /\d/.test(word)) return Number(word.replace(/^([+-]?)\./, '$10.')) || 0;
    return new Op(word);
  }

  private literal(): Buffer {
    const { b } = this;
    this.p++;
    const out: number[] = [];
    let depth = 1;
    while (this.p < this.end) {
      const c = b[this.p++];
      if (c === 0x5c) {
        const e = b[this.p++];
        if (e === 0x6e) out.push(10);
        else if (e === 0x72) out.push(13);
        else if (e === 0x74) out.push(9);
        else if (e === 0x62) out.push(8);
        else if (e === 0x66) out.push(12);
        else if (e === 0x0d) {
          if (b[this.p] === 0x0a) this.p++;
        } else if (e === 0x0a) {
          // a line continued
        } else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && b[this.p] >= 0x30 && b[this.p] <= 0x37; k++) v = v * 8 + (b[this.p++] - 0x30);
          out.push(v & 0xff);
        } else if (e !== undefined) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Buffer.from(out);
  }

  private hex(): Buffer {
    const { b } = this;
    this.p++;
    let digits = '';
    while (this.p < this.end && b[this.p] !== 0x3e) {
      const c = b[this.p++];
      if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) digits += String.fromCharCode(c);
    }
    this.p++;
    if (digits.length % 2) digits += '0';
    return Buffer.from(digits, 'hex');
  }
}

/** One value; `refs` reads `n g R` as a reference (files do, content streams don't). */
function parseValue(lx: Lexer, refs: boolean, tok: Tok = lx.next(), depth = 0): Val | typeof EOF {
  if (tok === EOF) return EOF;
  if (depth > 64) return null;
  if (tok === '[') {
    const arr: Val[] = [];
    for (;;) {
      const t = lx.next();
      if (t === ']' || t === EOF) return arr;
      const v = parseValue(lx, refs, t, depth + 1);
      if (v === EOF) return arr;
      arr.push(v);
    }
  }
  if (tok === '<<') {
    const d: Dict = new Map();
    for (;;) {
      const t = lx.next();
      if (t === '>>' || t === EOF) return d;
      if (!(t instanceof Name)) continue;
      const v = parseValue(lx, refs, lx.next(), depth + 1);
      if (v === EOF) return d;
      d.set(t.n, v);
    }
  }
  if (typeof tok === 'number' && refs && Number.isInteger(tok) && tok >= 0) {
    const save = lx.p;
    const g = lx.next();
    if (typeof g === 'number' && Number.isInteger(g)) {
      const r = lx.next();
      if (r instanceof Op && r.op === 'R') return new Ref(tok, g);
    }
    lx.p = save;
    return tok;
  }
  if (tok instanceof Op) {
    if (tok.op === 'true') return true;
    if (tok.op === 'false') return false;
    if (tok.op === 'null') return null;
    return tok;
  }
  if (tok === ']' || tok === '>>' || tok === '{' || tok === '}') return new Op(tok);
  return tok;
}

// ---------------------------------------------------------------- filters

function decodeStream(s: Stream, file: PdfFile): Buffer {
  const f = file.get(s.dict.get('Filter'));
  const filters = (Array.isArray(f) ? f : [f]).map((x) => nameOf(file.get(x))).filter((x): x is string => !!x);
  const p = file.get(s.dict.get('DecodeParms') ?? s.dict.get('DP'));
  const parms = Array.isArray(p) ? p.map((x) => file.get(x)) : [p];
  let data = s.raw;
  filters.forEach((name, i) => {
    const parm = isDict(parms[i]) ? (parms[i] as Dict) : null;
    switch (name) {
      case 'FlateDecode':
      case 'Fl':
        data = predict(inflate(data), parm);
        break;
      case 'LZWDecode':
      case 'LZW':
        data = predict(lzw(data, num(parm?.get('EarlyChange'), 1)), parm);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        data = Buffer.from(data.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '').replace(/^((..)*.)$/, '$10'), 'hex');
        break;
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85(data);
        break;
      case 'RunLengthDecode':
      case 'RL':
        data = runLength(data);
        break;
      case 'Crypt':
        break;
      default:
        // An image's codec (DCT, JPX, CCITT, JBIG2): nothing here reads its pixels.
        throw new Error(`filter ${name}`);
    }
  });
  return data;
}

function inflate(b: Buffer): Buffer {
  try {
    return inflateSync(b);
  } catch {
    try {
      // A stream cut short, or with junk after its end: what inflated.
      return inflateSync(b, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    } catch {
      return inflateRawSync(b, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    }
  }
}

/** PNG (10 and up) and TIFF (2) predictors, as object and cross-reference streams use them. */
function predict(b: Buffer, parm: Dict | null): Buffer {
  const pred = num(parm?.get('Predictor'), 1);
  if (pred < 2) return b;
  const colors = num(parm?.get('Colors'), 1);
  const bpc = num(parm?.get('BitsPerComponent'), 8);
  const columns = num(parm?.get('Columns'), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) {
    if (bpc !== 8) return b;
    const out = Buffer.from(b);
    for (let r = 0; r + rowLen <= out.length; r += rowLen) for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
    return out;
  }
  const out = Buffer.alloc(Math.floor(b.length / (rowLen + 1)) * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0, o = 0; r + rowLen + 1 <= b.length; r += rowLen + 1, o += rowLen) {
    const type = b[r];
    const row = out.subarray(o, o + rowLen);
    for (let i = 0; i < rowLen; i++) {
      const x = b[r + 1 + i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = x;
      if (type === 1) v = x + a;
      else if (type === 2) v = x + up;
      else if (type === 3) v = x + ((a + up) >> 1);
      else if (type === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      row[i] = v & 0xff;
    }
    prev = row;
  }
  return out;
}

function lzw(b: Buffer, early: number): Buffer {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let width = 9;
  let bits = 0;
  let acc = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < b.length; i++) {
    acc = (acc << 8) | b[i];
    bits += 8;
    while (bits >= width) {
      const code = (acc >> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      if (code === 256) {
        reset();
        width = 9;
        prev = null;
        continue;
      }
      if (code === 257) return Buffer.from(out);
      let entry: number[];
      if (code < dict.length && dict[code].length) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else return Buffer.from(out);
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + early >= 1 << width && width < 12) width++;
    }
  }
  return Buffer.from(out);
}

function ascii85(b: Buffer): Buffer {
  const s = b.toString('latin1').replace(/^<~/, '').replace(/~>.*$/s, '').replace(/\s+/g, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of s) {
    if (ch === 'z' && !group.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
  }
  return Buffer.from(out);
}

function runLength(b: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < b.length; ) {
    const n = b[i++];
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < b.length; k++) out.push(b[i++]);
    } else {
      const v = b[i++];
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------- the file

class PdfFile {
  /** Each object's value and where in the file it was found: a later one (an incremental update) wins. */
  private objects = new Map<number, { at: number; val: Val }>();
  trailer: Dict = new Map();
  readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
    const s = buf.toString('latin1');
    const re = /(\d+)[ \t\r\n\f\0]+(\d+)[ \t\r\n\f\0]+obj\b/g;
    const streams: { at: number; s: Stream }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const at = m.index;
      if (at > 0 && !WS[buf[at - 1]] && !DELIM[buf[at - 1]]) continue;
      const lx = new Lexer(buf, at + m[0].length);
      let val = parseValue(lx, true);
      if (val === EOF) break;
      lx.skip();
      if (isDict(val) && s.startsWith('stream', lx.p)) {
        let start = lx.p + 6;
        if (buf[start] === 0x0d) start++;
        if (buf[start] === 0x0a) start++;
        let end = -1;
        const len = val.get('Length');
        if (typeof len === 'number' && len >= 0 && start + len <= buf.length && /^\s*endstream/.test(s.slice(start + len, start + len + 32))) end = start + len;
        if (end < 0) {
          end = s.indexOf('endstream', start);
          if (end < 0) end = buf.length;
          // the end of line before "endstream" isn't data
          if (buf[end - 1] === 0x0a) end--;
          if (buf[end - 1] === 0x0d) end--;
        }
        const st = new Stream(val, buf.subarray(start, end));
        val = st;
        streams.push({ at, s: st });
        re.lastIndex = end;
      } else re.lastIndex = Math.max(re.lastIndex, lx.p);
      const n = Number(m[1]);
      const had = this.objects.get(n);
      if (!had || had.at <= at) this.objects.set(n, { at, val });
    }
    // Objects packed in object streams (PDF 1.5).
    for (const { at, s: st } of streams) {
      if (nameOf(st.dict.get('Type')) !== 'ObjStm') continue;
      try {
        const data = decodeStream(st, this);
        const n = num(this.get(st.dict.get('N')));
        const first = num(this.get(st.dict.get('First')));
        const head = new Lexer(data, 0, Math.min(first, data.length));
        const pairs: [number, number][] = [];
        for (let k = 0; k < n; k++) {
          const a = head.next();
          const b = head.next();
          if (typeof a !== 'number' || typeof b !== 'number') break;
          pairs.push([a, b]);
        }
        for (const [objNum, off] of pairs) {
          const had = this.objects.get(objNum);
          if (had && had.at > at) continue;
          const v = parseValue(new Lexer(data, first + off), true);
          if (v !== EOF) this.objects.set(objNum, { at, val: v });
        }
      } catch {
        // an object stream that won't decode: its objects are missing, as if the file were damaged there
      }
    }
    // The trailer: the last "trailer" dictionary, else the last cross-reference stream's.
    const t = s.lastIndexOf('trailer');
    if (t >= 0) {
      const v = parseValue(new Lexer(buf, t + 7), true);
      if (isDict(v)) this.trailer = v;
    }
    if (!this.trailer.has('Root')) {
      for (let k = streams.length - 1; k >= 0; k--) {
        if (nameOf(streams[k].s.dict.get('Type')) === 'XRef' && streams[k].s.dict.has('Root')) {
          this.trailer = streams[k].s.dict;
          break;
        }
      }
    }
    if (!this.trailer.has('Root')) {
      for (const [n, o] of this.objects) {
        if (isDict(o.val) && nameOf(o.val.get('Type')) === 'Catalog') {
          this.trailer = new Map([['Root', new Ref(n, 0)]]);
          break;
        }
      }
    }
  }

  /** A value with its references followed. */
  get(v: Val | undefined, depth = 0): Val | undefined {
    while (v instanceof Ref && depth++ < 32) v = this.objects.get(v.num)?.val;
    return v instanceof Ref ? undefined : v;
  }

  dict(v: Val | undefined): Dict | null {
    const d = this.get(v);
    if (isDict(d)) return d;
    if (d instanceof Stream) return d.dict;
    return null;
  }
}

// ---------------------------------------------------------------- fonts and encodings

/** Glyph names with no rule for them (letters, digits and accented letters are worked out in glyphText). */
const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  quoteright: '’', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.',
  slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@',
  bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', quoteleft: '‘',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', exclamdown: '¡', cent: '¢', sterling: '£', fraction: '⁄',
  yen: '¥', florin: 'ƒ', section: '§', currency: '¤', quotedblleft: '“', guillemotleft: '«', guilsinglleft: '‹',
  guilsinglright: '›', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', endash: '–', dagger: '†', daggerdbl: '‡',
  periodcentered: '·', paragraph: '¶', bullet: '•', quotesinglbase: '‚', quotedblbase: '„', quotedblright: '”',
  guillemotright: '»', ellipsis: '…', perthousand: '‰', questiondown: '¿', acute: '´', circumflex: 'ˆ', tilde: '˜',
  macron: '¯', breve: '˘', dotaccent: '˙', dieresis: '¨', ring: '˚', cedilla: '¸', hungarumlaut: '˝', ogonek: '˛',
  caron: 'ˇ', emdash: '—', AE: 'Æ', ae: 'æ', OE: 'Œ', oe: 'œ', ordfeminine: 'ª', ordmasculine: 'º', Lslash: 'Ł',
  lslash: 'ł', Oslash: 'Ø', oslash: 'ø', dotlessi: 'ı', germandbls: 'ß', Euro: '€', trademark: '™', copyright: '©',
  registered: '®', degree: '°', plusminus: '±', mu: 'µ', multiply: '×', divide: '÷', onehalf: '½', onequarter: '¼',
  threequarters: '¾', onesuperior: '¹', twosuperior: '²', threesuperior: '³', logicalnot: '¬', brokenbar: '¦',
  minus: '−', nbspace: ' ', nonbreakingspace: ' ', sfthyphen: '', softhyphen: '', Eth: 'Ð', eth: 'ð', Thorn: 'Þ',
  thorn: 'þ', notequal: '≠', infinity: '∞', lessequal: '≤', greaterequal: '≥', partialdiff: '∂', summation: '∑',
  product: '∏', pi: 'π', integral: '∫', Omega: 'Ω', radical: '√', approxequal: '≈', Delta: '∆', lozenge: '◊',
  arrowright: '→', arrowleft: '←', arrowup: '↑', arrowdown: '↓', checkmark: '✓', figuredash: '‒',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const ACCENTS: Record<string, string> = {
  acute: '́', grave: '̀', circumflex: '̂', tilde: '̃', dieresis: '̈', ring: '̊',
  cedilla: '̧', caron: '̌', macron: '̄', breve: '̆', dotaccent: '̇', ogonek: '̨',
  hungarumlaut: '̋',
};

/** The text of a glyph name (the Adobe Glyph List's rules, for the names Latin text uses), or null. */
export function glyphText(name: string): string | null {
  if (name in GLYPHS) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})+$/.exec(name);
  if (m) {
    const units = name.slice(3).match(/.{4}/g)!.map((h) => parseInt(h, 16));
    return String.fromCharCode(...units);
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  // a.sc, one.oldstyle: the glyph before the dot; f_f_i: its parts
  const dot = name.indexOf('.');
  if (dot > 0) return glyphText(name.slice(0, dot));
  if (name.includes('_')) {
    const parts = name.split('_').map(glyphText);
    return parts.every((p) => p !== null) ? parts.join('') : null;
  }
  m = /^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|ring|cedilla|caron|macron|breve|dotaccent|ogonek|hungarumlaut)$/.exec(name);
  if (m) {
    const c = (m[1] + ACCENTS[m[2]]).normalize('NFC');
    return c.length === 1 ? c : null;
  }
  return null;
}

const decoder = (label: string) => {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
};
const cp1252 = decoder('windows-1252');
const macRoman = decoder('macintosh');
const byteTable = (d: TextDecoder | null): (string | null)[] =>
  Array.from({ length: 256 }, (_, i) => {
    if (i < 32) return null;
    if (!d) return i < 128 ? String.fromCharCode(i) : null;
    const c = d.decode(Uint8Array.of(i));
    return c === '�' || /[\u0080-\u009f]/.test(c) ? null : c;
  });

const WIN_ANSI = byteTable(cp1252);
const MAC_ROMAN = byteTable(macRoman);
const STANDARD: (string | null)[] = (() => {
  const t: (string | null)[] = Array.from({ length: 256 }, (_, i) => (i >= 32 && i < 127 ? String.fromCharCode(i) : null));
  t[0x27] = '’';
  t[0x60] = '‘';
  const hi: [number, string][] = [
    [0o241, '¡'], [0o242, '¢'], [0o243, '£'], [0o244, '⁄'], [0o245, '¥'], [0o246, 'ƒ'], [0o247, '§'], [0o250, '¤'],
    [0o251, "'"], [0o252, '“'], [0o253, '«'], [0o254, '‹'], [0o255, '›'], [0o256, 'fi'], [0o257, 'fl'], [0o261, '–'],
    [0o262, '†'], [0o263, '‡'], [0o264, '·'], [0o266, '¶'], [0o267, '•'], [0o270, '‚'], [0o271, '„'], [0o272, '”'],
    [0o273, '»'], [0o274, '…'], [0o275, '‰'], [0o277, '¿'], [0o301, '`'], [0o302, '´'], [0o303, 'ˆ'], [0o304, '˜'],
    [0o305, '¯'], [0o306, '˘'], [0o307, '˙'], [0o310, '¨'], [0o312, '˚'], [0o313, '¸'], [0o315, '˝'], [0o316, '˛'],
    [0o317, 'ˇ'], [0o320, '—'], [0o341, 'Æ'], [0o343, 'ª'], [0o350, 'Ł'], [0o351, 'Ø'], [0o352, 'Œ'], [0o353, 'º'],
    [0o361, 'æ'], [0o365, 'ı'], [0o370, 'ł'], [0o371, 'ø'], [0o372, 'œ'], [0o373, 'ß'],
  ];
  for (const [c, s] of hi) t[c] = s;
  return t;
})();

/** Advance widths of the standard fonts' printable ASCII (32 to 126), for a PDF that names one without its widths. */
const HELVETICA_W = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const TIMES_W = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500,
  500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500,
  500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

function standardWidth(baseFont: string, code: number): number | null {
  const f = baseFont.replace(/^[A-Z]{6}\+/, '');
  if (/^Courier/i.test(f)) return 600;
  const table = /^(Helvetica|Arial)/i.test(f) ? HELVETICA_W : /^Times/i.test(f) ? TIMES_W : null;
  if (!table) return null;
  return code >= 32 && code <= 126 ? table[code - 32] : 556;
}

interface Font {
  /** Splits a shown string into codes. */
  codes(s: Buffer): { code: number; bytes: number }[];
  text(code: number): string | null;
  /** Advance in text space units (an em is 1). */
  width(code: number): number;
}

interface CMapLike {
  map: Map<number, string>;
  /** Code lengths in bytes by codespace range: [bytes, low, high]. */
  ranges: [number, number, number][];
}

function parseCMap(data: Buffer): CMapLike {
  const lx = new Lexer(data);
  const map = new Map<number, string>();
  const ranges: [number, number, number][] = [];
  const toInt = (b: Buffer) => b.reduce((v, x) => v * 256 + x, 0);
  const toText = (b: Buffer) => {
    if (b.length === 1) return String.fromCharCode(b[0]);
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  };
  let mode = '';
  let n = 0;
  for (;;) {
    const t = lx.next();
    if (t === EOF) break;
    if (t instanceof Op) {
      if (/^begin(bfchar|bfrange|codespacerange)$/.test(t.op)) mode = t.op.slice(5);
      else if (/^end(bfchar|bfrange|codespacerange)$/.test(t.op)) mode = '';
      if (++n > 2_000_000) break;
      continue;
    }
    if (!Buffer.isBuffer(t) || !mode) continue;
    if (mode === 'codespacerange') {
      const hi = lx.next();
      if (Buffer.isBuffer(hi)) ranges.push([t.length, toInt(t), toInt(hi)]);
    } else if (mode === 'bfchar') {
      const dst = parseValue(lx, false);
      if (Buffer.isBuffer(dst)) map.set(toInt(t), toText(dst));
      else if (dst instanceof Name) map.set(toInt(t), glyphText(dst.n) ?? '');
    } else if (mode === 'bfrange') {
      const hi = lx.next();
      const dst = parseValue(lx, false);
      if (!Buffer.isBuffer(hi)) continue;
      const lo = toInt(t);
      const top = Math.min(toInt(hi), lo + 65535);
      if (Buffer.isBuffer(dst)) {
        const base = toText(dst);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= top; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      } else if (Array.isArray(dst)) {
        dst.forEach((d, k) => {
          if (Buffer.isBuffer(d) && lo + k <= top) map.set(lo + k, toText(d));
        });
      }
      if (!ranges.length && t.length) ranges.push([t.length, 0, 256 ** t.length - 1]);
    }
  }
  if (!ranges.length) {
    // no codespace: the codes' length is the length the map's codes were written in
    const k = data.toString('latin1').match(/<([0-9a-fA-F]+)>/);
    if (k) ranges.push([Math.max(1, k[1].length >> 1), 0, 256 ** Math.max(1, k[1].length >> 1) - 1]);
  }
  return { map, ranges };
}

function splitCodes(s: Buffer, ranges: [number, number, number][]): { code: number; bytes: number }[] {
  const out: { code: number; bytes: number }[] = [];
  for (let i = 0; i < s.length; ) {
    let done = false;
    for (let n = 1; n <= 4 && i + n <= s.length && !done; n++) {
      let v = 0;
      for (let k = 0; k < n; k++) v = v * 256 + s[i + k];
      if (ranges.some(([len, lo, hi]) => len === n && v >= lo && v <= hi)) {
        out.push({ code: v, bytes: n });
        i += n;
        done = true;
      }
    }
    if (!done) {
      // not in any range: the shortest length the ranges use
      const n = Math.min(...ranges.map((r) => r[0]), s.length - i);
      let v = 0;
      for (let k = 0; k < n; k++) v = v * 256 + s[i + k];
      out.push({ code: v, bytes: n });
      i += n;
    }
  }
  return out;
}

function loadFont(file: PdfFile, d: Dict): Font {
  const sub = nameOf(file.get(d.get('Subtype'))) ?? 'Type1';
  const baseFont = nameOf(file.get(d.get('BaseFont'))) ?? '';
  const tu = file.get(d.get('ToUnicode'));
  let toUnicode: CMapLike | null = null;
  if (tu instanceof Stream) {
    try {
      toUnicode = parseCMap(decodeStream(tu, file));
    } catch {
      toUnicode = null;
    }
  }

  if (sub === 'Type0') {
    const enc = file.get(d.get('Encoding'));
    let ranges: [number, number, number][] = [[2, 0, 0xffff]];
    if (enc instanceof Stream) {
      try {
        const cm = parseCMap(decodeStream(enc, file));
        if (cm.ranges.length) ranges = cm.ranges;
      } catch {
        // Identity's
      }
    } else if (!/^Identity-[HV]$/.test(nameOf(enc) ?? 'Identity-H') && toUnicode?.ranges.length) ranges = toUnicode.ranges;
    const kids = file.get(d.get('DescendantFonts'));
    const desc = file.dict(Array.isArray(kids) ? kids[0] : undefined);
    const dw = num(file.get(desc?.get('DW')), 1000);
    const widths = new Map<number, number>();
    const w = file.get(desc?.get('W'));
    if (Array.isArray(w)) {
      for (let i = 0; i < w.length; ) {
        const c = num(file.get(w[i]));
        const next = file.get(w[i + 1]);
        if (Array.isArray(next)) {
          next.forEach((x, k) => widths.set(c + k, num(file.get(x))));
          i += 2;
        } else {
          const c2 = num(next);
          const wv = num(file.get(w[i + 2]));
          for (let k = c; k <= c2 && k - c < 65536; k++) widths.set(k, wv);
          i += 3;
        }
      }
    }
    return {
      codes: (s) => splitCodes(s, ranges),
      text: (code) => toUnicode?.map.get(code) ?? null,
      width: (code) => (widths.get(code) ?? dw) / 1000,
    };
  }

  // Simple fonts: one byte a code.
  const fd = file.dict(d.get('FontDescriptor'));
  const flags = num(file.get(fd?.get('Flags')));
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
  const encVal = file.get(d.get('Encoding'));
  const encDict = isDict(encVal) ? encVal : null;
  const baseName = nameOf(encVal) ?? nameOf(file.get(encDict?.get('BaseEncoding')));
  const std = /^(Symbol|ZapfDingbats)/.test(baseFont.replace(/^[A-Z]{6}\+/, ''));
  let table: (string | null)[] =
    baseName === 'WinAnsiEncoding' ? WIN_ANSI
    : baseName === 'MacRomanEncoding' ? MAC_ROMAN
    : baseName === 'StandardEncoding' ? STANDARD
    : sub === 'TrueType' || symbolic ? WIN_ANSI
    : sub === 'Type3' || std ? Array(256).fill(null)
    : STANDARD;
  const diffs = file.get(encDict?.get('Differences'));
  if (Array.isArray(diffs)) {
    table = [...table];
    let code = 0;
    for (const x of diffs) {
      const v = file.get(x);
      if (typeof v === 'number') code = v;
      else if (v instanceof Name) {
        if (code >= 0 && code < 256) table[code] = glyphText(v.n);
        code++;
      }
    }
  }
  const first = num(file.get(d.get('FirstChar')));
  const ws = file.get(d.get('Widths'));
  const missing = num(file.get(fd?.get('MissingWidth')), 0);
  const fm = file.get(d.get('FontMatrix'));
  // Type 3 widths are in its own glyph space; an em is taken as 1 in text space, as for the others.
  const fmx = sub === 'Type3' && Array.isArray(fm) ? num(file.get(fm[0]), 0.001) : 0.001;
  return {
    codes: (s) => Array.from(s, (code) => ({ code, bytes: 1 })),
    text: (code) => toUnicode?.map.get(code) ?? table[code] ?? null,
    width: (code) => {
      if (Array.isArray(ws) && code >= first && code - first < ws.length) return num(file.get(ws[code - first])) * fmx;
      const sw = standardWidth(baseFont, code);
      return (sw ?? (missing || 500)) * 0.001;
    },
  };
}

// ---------------------------------------------------------------- content streams

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface GState {
  ctm: M;
  font: Font | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
}

interface Glyph {
  ch: string;
  /** Origin and end, in the page's displayed frame (points, y down). */
  x: number;
  y: number;
  ex: number;
  ey: number;
  /** The em's up vector there. */
  ux: number;
  uy: number;
  size: number;
}

interface PageCtx {
  file: PdfFile;
  /** user space -> the displayed page, in points with y down */
  view: M;
  glyphs: Glyph[];
  fonts: Map<Dict, Font>;
  imageArea: number;
  mapped: number;
  unmapped: number;
  shapes: number;
  ops: number;
}

const MAX_OPS = 3_000_000;

function runContent(ctx: PageCtx, data: Buffer, resources: Dict | null, ctm: M, depth: number, seen: Set<Val>) {
  const { file } = ctx;
  const fontsDict = file.dict(resources?.get('Font'));
  const xobjects = file.dict(resources?.get('XObject'));
  const stack: GState[] = [];
  let gs: GState = { ctm, font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  let tm: M = ID;
  let tlm: M = ID;
  const lx = new Lexer(data);
  const args: Val[] = [];

  const fontFor = (name: string): Font | null => {
    const d = file.dict(fontsDict?.get(name));
    if (!d) return null;
    let f = ctx.fonts.get(d);
    if (!f) {
      f = loadFont(file, d);
      ctx.fonts.set(d, f);
    }
    return f;
  };

  const show = (s: Buffer) => {
    const f = gs.font;
    if (!f) return;
    for (const { code, bytes } of f.codes(s)) {
      const w0 = f.width(code);
      const text = f.text(code);
      const trm = mul(mul([gs.size * gs.th, 0, 0, gs.size, 0, gs.rise], tm), gs.ctm);
      const full = mul(trm, ctx.view);
      const [x, y] = apply(full, 0, 0);
      const [ex, ey] = apply(full, w0, 0);
      const [ax, ay] = apply(full, 0, 1);
      const ux = ax - x;
      const uy = ay - y;
      const size = Math.hypot(ux, uy);
      const isSpace = (text !== null && text !== '' && !text.trim()) || (text === null && bytes === 1 && code === 32);
      if (!isSpace) {
        if (text === null || text === '' || /^[\u0000-\u001f�]+$/.test(text)) {
          if (text !== '') ctx.unmapped++;
        } else {
          ctx.mapped++;
          ctx.glyphs.push({ ch: text, x, y, ex, ey, ux, uy, size });
        }
      } else ctx.glyphs.push({ ch: ' ', x, y, ex, ey, ux, uy, size });
      const tx = (w0 * gs.size + gs.tc + (bytes === 1 && code === 32 ? gs.tw : 0)) * gs.th;
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
  };

  for (;;) {
    const t = lx.next();
    if (t === EOF) break;
    if (!(t instanceof Op)) {
      const v = parseValue(lx, false, t);
      if (v !== EOF) args.push(v);
      if (args.length > 64) args.shift();
      continue;
    }
    if (++ctx.ops > MAX_OPS) break;
    const a = args.splice(0);
    const n = (i: number) => num(a[i]);
    switch (t.op) {
      case 'q':
        if (stack.length < 64) stack.push({ ...gs });
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm':
        if (a.length >= 6) gs.ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm);
        break;
      case 'BT':
        tm = ID;
        tlm = ID;
        break;
      case 'Tf': {
        gs.font = fontFor(nameOf(a[0]) ?? '');
        gs.size = n(1);
        break;
      }
      case 'Tc':
        gs.tc = n(0);
        break;
      case 'Tw':
        gs.tw = n(0);
        break;
      case 'Tz':
        gs.th = n(0) / 100;
        break;
      case 'TL':
        gs.tl = n(0);
        break;
      case 'Ts':
        gs.rise = n(0);
        break;
      case 'Td':
        tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        gs.tl = -n(1);
        tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
        tm = tlm;
        break;
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        break;
      case 'Tj':
        if (Buffer.isBuffer(a[0])) show(a[0]);
        break;
      case "'":
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        if (Buffer.isBuffer(a[0])) show(a[0]);
        break;
      case '"':
        gs.tw = n(0);
        gs.tc = n(1);
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        if (Buffer.isBuffer(a[2])) show(a[2]);
        break;
      case 'TJ':
        if (Array.isArray(a[0])) {
          for (const x of a[0]) {
            if (Buffer.isBuffer(x)) show(x);
            else if (typeof x === 'number') tm = mul([1, 0, 0, 1, (-x / 1000) * gs.size * gs.th, 0], tm);
          }
        }
        break;
      case 'Do': {
        const xo = file.get(xobjects?.get(nameOf(a[0]) ?? ''));
        if (!(xo instanceof Stream)) break;
        const kind = nameOf(file.get(xo.dict.get('Subtype')));
        if (kind === 'Image') ctx.imageArea += unitArea(gs.ctm, ctx.view);
        else if (kind === 'Form' && depth < 8 && !seen.has(xo)) {
          const fm = file.get(xo.dict.get('Matrix'));
          const m: M = Array.isArray(fm) && fm.length >= 6 ? (fm.slice(0, 6).map((v) => num(file.get(v))) as M) : ID;
          let body: Buffer;
          try {
            body = decodeStream(xo, file);
          } catch {
            break;
          }
          seen.add(xo);
          runContent(ctx, body, file.dict(xo.dict.get('Resources')) ?? resources, mul(m, gs.ctm), depth + 1, seen);
          seen.delete(xo);
        }
        break;
      }
      case 'BI': {
        // An inline image: its dictionary up to ID, then its bytes up to EI.
        let k = lx.p;
        const s = data;
        const id = s.indexOf('ID', k, 'latin1');
        if (id < 0) return;
        k = id + 3;
        for (;;) {
          const e = s.indexOf('EI', k, 'latin1');
          if (e < 0) return;
          const after = s[e + 2];
          if (WS[s[e - 1]] && (after === undefined || WS[after] || DELIM[after])) {
            lx.p = e + 2;
            break;
          }
          k = e + 2;
        }
        ctx.imageArea += unitArea(gs.ctm, ctx.view);
        break;
      }
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
      case 'S':
      case 's':
        ctx.shapes++;
        break;
      default:
        break;
    }
  }
}

/** The area, in the displayed page's square points, of the unit square an image is drawn into. */
function unitArea(ctm: M, view: M): number {
  const m = mul(ctm, view);
  return Math.abs(m[0] * m[3] - m[1] * m[2]);
}

// ---------------------------------------------------------------- lines

function toLines(glyphs: Glyph[], px: number): PdfTextLine[] {
  const lines: { glyphs: Glyph[] }[] = [];
  let cur: Glyph[] = [];
  let dir: [number, number] = [1, 0];
  const close = () => {
    if (cur.some((g) => g.ch !== ' ')) lines.push({ glyphs: cur });
    cur = [];
  };
  for (const g of glyphs) {
    const prev = cur[cur.length - 1];
    if (!prev) {
      if (g.ch !== ' ') cur.push(g);
      continue;
    }
    const adv = Math.hypot(prev.ex - prev.x, prev.ey - prev.y);
    if (adv > 1e-6) dir = [(prev.ex - prev.x) / adv, (prev.ey - prev.y) / adv];
    const rx = g.x - prev.ex;
    const ry = g.y - prev.ey;
    const along = rx * dir[0] + ry * dir[1];
    const across = rx * -dir[1] + ry * dir[0];
    const size = Math.max(prev.size, g.size, 0.01);
    // The same glyph drawn again almost where it was (a bold made by drawing twice): once.
    if (g.ch === prev.ch && Math.hypot(g.x - prev.x, g.y - prev.y) < Math.max(0.05 * size, 0.3 * adv)) continue;
    const sameLine = Math.abs(across) <= 0.45 * size && along > -0.75 * size;
    if (!sameLine) {
      close();
      if (g.ch !== ' ') cur.push(g);
      continue;
    }
    if (g.ch === ' ') {
      if (prev.ch !== ' ') cur.push(g);
      continue;
    }
    if (prev.ch !== ' ' && along > 0.18 * size) cur.push({ ...prev, ch: ' ', x: prev.ex, y: prev.ey });
    cur.push(g);
  }
  close();

  const out: PdfTextLine[] = [];
  let last: { text: string; x: number; y: number } | null = null;
  for (const l of lines) {
    const words: PdfWord[] = [];
    let w: Glyph[] = [];
    const flush = () => {
      if (!w.length) return;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const g of w) {
        // the glyph's box: from below the baseline (descent) to above (ascent)
        for (const [x, y] of [
          [g.x - g.ux * 0.22, g.y - g.uy * 0.22],
          [g.ex - g.ux * 0.22, g.ey - g.uy * 0.22],
          [g.x + g.ux * 0.78, g.y + g.uy * 0.78],
          [g.ex + g.ux * 0.78, g.ey + g.uy * 0.78],
        ]) {
          xs.push(x);
          ys.push(y);
        }
      }
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const r = (v: number) => Math.round(v * px * 10) / 10;
      words.push({ t: tidy(w.map((g) => g.ch).join('')), x: r(x0), y: r(y0), w: r(Math.max(...xs) - x0), h: r(Math.max(...ys) - y0) });
      w = [];
    };
    for (const g of l.glyphs) {
      if (g.ch === ' ') flush();
      else w.push(g);
    }
    flush();
    const kept = words.filter((x) => x.t);
    if (!kept.length) continue;
    const text = kept.map((x) => x.t).join(' ');
    const first = l.glyphs.find((g) => g.ch !== ' ')!;
    // A line drawn twice over itself (the other way to make bold): once.
    if (last && last.text === text && Math.hypot(last.x - first.x, last.y - first.y) < 0.3 * first.size) continue;
    last = { text, x: first.x, y: first.y };
    out.push({ text, words: kept });
  }
  return out;
}

/** Ligatures as their letters, no-break spaces as spaces, nothing invisible. */
function tidy(s: string): string {
  return s
    .replace(/[ﬀ-ﬆ]/g, (c) => c.normalize('NFKC'))
    .replace(/[  -  ]/g, ' ')
    .replace(/[\u0000-\u001f\u007f­​-‍⁠﻿]/g, '')
    .trim();
}

// ---------------------------------------------------------------- pages

/**
 * The text of a PDF's first `maxPages` pages (and how many it has). `scale` is the pixels a 1/96 inch for the words'
 * boxes, as the reader renders pages (ocr.ts' pdfScale). Throws only on a file that isn't a PDF at all.
 */
export function readPdfText(buf: Buffer, opts: { maxPages?: number; scale?: number } = {}): PdfText {
  const head = buf.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) throw new Error('not a PDF');
  const file = new PdfFile(buf);
  const encrypted = file.trailer.has('Encrypt');
  const root = file.dict(file.trailer.get('Root'));
  const pages: { dict: Dict; inherit: Map<string, Val> }[] = [];
  const walk = (v: Val | undefined, inherit: Map<string, Val>, depth: number, seen: Set<Dict>) => {
    const d = file.dict(v);
    if (!d || seen.has(d) || depth > 64 || pages.length > 100_000) return;
    seen.add(d);
    const inh = new Map(inherit);
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (d.has(k)) inh.set(k, d.get(k)!);
    const kids = file.get(d.get('Kids'));
    if (Array.isArray(kids) && nameOf(file.get(d.get('Type'))) !== 'Page') for (const k of kids) walk(k, inh, depth + 1, seen);
    else pages.push({ dict: d, inherit: inh });
  };
  walk(root?.get('Pages'), new Map(), 0, new Set());
  const out: PdfText = { pageCount: pages.length, pages: [], encrypted };
  if (encrypted) return out;
  const px = (opts.scale ?? 1) * (96 / 72);
  const fonts = new Map<Dict, Font>();
  for (let i = 0; i < Math.min(pages.length, opts.maxPages ?? pages.length); i++) {
    const { dict, inherit } = pages[i];
    const box = file.get(inherit.get('CropBox')) ?? file.get(inherit.get('MediaBox'));
    const b = Array.isArray(box) && box.length >= 4 ? box.slice(0, 4).map((v) => num(file.get(v))) : [0, 0, 612, 792];
    const [x0, y0, x1, y1] = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
    const rot = ((Math.round(num(file.get(inherit.get('Rotate'))) / 90) % 4) + 4) % 4;
    const W = x1 - x0;
    const H = y1 - y0;
    // user space -> the page as displayed, y down, rotation applied (clockwise, as /Rotate turns it)
    const view: M =
      rot === 0 ? [1, 0, 0, -1, -x0, y1]
      : rot === 1 ? [0, 1, 1, 0, -y0, -x0]
      : rot === 2 ? [-1, 0, 0, 1, x1, -y0]
      : [0, -1, -1, 0, y1, x1];
    const ctx: PageCtx = { file, view, glyphs: [], fonts, imageArea: 0, mapped: 0, unmapped: 0, shapes: 0, ops: 0 };
    const contents = file.get(dict.get('Contents'));
    const parts = (Array.isArray(contents) ? contents.map((c) => file.get(c)) : [contents]).filter((c): c is Stream => c instanceof Stream);
    const bodies: Buffer[] = [];
    for (const s of parts) {
      try {
        bodies.push(decodeStream(s, file), Buffer.from('\n'));
      } catch {
        // a part that won't decode: the rest of the page still reads
      }
    }
    try {
      runContent(ctx, Buffer.concat(bodies), file.dict(inherit.get('Resources')), ID, 0, new Set());
    } catch {
      // what was read before the fault stands
    }
    const lines = toLines(ctx.glyphs, px);
    const [w, h] = rot % 2 ? [H, W] : [W, H];
    out.pages.push({
      index: i,
      width: Math.round(w * px),
      height: Math.round(h * px),
      lines,
      text: lines.map((l) => l.text).join('\n'),
      glyphs: ctx.mapped + ctx.unmapped,
      unmapped: ctx.unmapped,
      imageCover: Math.min(1, ctx.imageArea / Math.max(1, W * H)),
      shapes: ctx.shapes,
    });
  }
  return out;
}
