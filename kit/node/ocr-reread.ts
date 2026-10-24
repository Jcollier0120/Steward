import { powershell } from './ps.ts';

/**
 * Text the kit's model can't read (kit 2.129.0, spec/OCR.md "Other alphabets"): the model knows the Latin alphabet
 * alone, so Cyrillic, Greek, Chinese, Arabic… come out of it as Latin look-alikes ("MapTa" for "марта") or scraps.
 * Where Windows has an OCR language of another alphabet installed for the account, a page the model read so is read
 * again by Windows' own OCR in that language, and its lines replace the model's only where they hold that alphabet's
 * letters: text in the Latin alphabet keeps the model's read, which is the better one.
 */

export interface ReadLine {
  text: string;
  words: { t: string; x: number; y: number; w: number; h: number }[];
}

/** A word's part that reads as text the model knows: lower case, Capitalised or CAPITALS, a number, or a number with a short suffix (12th, 4K, mp3, A4). */
const PLAIN = [/^\p{Lu}?\p{Ll}+$/u, /^\p{Lu}+$/u, /^\p{N}+$/u, /^\p{N}+(\p{Ll}{1,3}|\p{Lu}{1,3})$/u, /^\p{L}+\p{N}+$/u];

/** The word without what surrounds it (quotes, brackets, stops), or '' when it has no letter. */
function core(word: string): string {
  const c = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return /\p{L}/u.test(c) ? c : '';
}

/** Whether a word the model read looks unlike text: case changing inside it (MapTa), or signs among its letters (O/IaTUTb, ö,jli). */
export function oddWord(word: string): boolean {
  const c = core(word);
  return !!c && c.split(/['’\-–./]/).some((p) => p !== '' && !PLAIN.some((re) => re.test(p)));
}

/**
 * Whether the model's read of a page looks like text of an alphabet it doesn't know: a line with two odd words, or
 * whose words are half or more odd (a line of both alphabets has some), or a page mostly in CAPITALS (Cyrillic and
 * Greek capitals read as Latin ones look like plain words). Latin text can look so too (getElementById, iPhone, a
 * poster): it is read again for nothing, as keepBetter keeps the model's read of it.
 */
export function looksUnread(lines: ReadLine[]): boolean {
  let words = 0;
  let caps = 0;
  for (const l of lines) {
    const ws = l.text.split(/\s+/).filter((w) => core(w));
    const odd = ws.filter(oddWord).length;
    if (odd >= 2 || (odd && odd * 2 >= ws.length)) return true;
    words += ws.length;
    caps += ws.filter((w) => /^\p{Lu}{2,}$/u.test(core(w))).length;
  }
  return caps >= 2 && caps * 2 >= words;
}

/** Cyrillic and Greek letters drawn like Latin ones: an engine may give them for Latin text, so they never count as another alphabet. */
const LOOK_ALIKES = new Set('АВЕКМНОРСТУХЅІЈаеорсухѕіјΑΒΕΖΗΙΚΜΝΟΡΤΥΧαικνορυ');

/** Whether a line Windows read holds another alphabet: at least two of its letters, and 15% of them, not Latin nor drawn like Latin. */
export function otherAlphabet(text: string): boolean {
  let letters = 0;
  let other = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (!/\p{Script=Latin}/u.test(ch) && !LOOK_ALIKES.has(ch)) other++;
  }
  return other >= 2 && other >= letters * 0.15;
}

type Box = { x0: number; y0: number; x1: number; y1: number };

function boxOf(l: ReadLine): Box | null {
  if (!l.words.length) return null;
  return {
    x0: Math.min(...l.words.map((w) => w.x)),
    y0: Math.min(...l.words.map((w) => w.y)),
    x1: Math.max(...l.words.map((w) => w.x + w.w)),
    y1: Math.max(...l.words.map((w) => w.y + w.h)),
  };
}

/** Whether two lines are the same text: they share half the smaller one's box. */
function overlap(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return false;
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return false;
  const area = (x: Box) => Math.max(1, (x.x1 - x.x0) * (x.y1 - x.y0));
  return w * h * 2 >= Math.min(area(a), area(b));
}

/**
 * The page's lines, the better read kept line by line: a model line that a line of another alphabet in Windows' read
 * overlaps gives way to Windows' lines there (all of them, so a line of both alphabets reads whole), and a line of
 * another alphabet the model found nothing at goes in by its height. Every other line is the model's. `taken`: how
 * many of Windows' lines are in it.
 */
export function keepBetter(model: ReadLine[], windows: ReadLine[]): { lines: ReadLine[]; taken: number } {
  const other = windows.map((w) => otherAlphabet(w.text));
  if (!other.some(Boolean)) return { lines: model, taken: 0 };
  const mBox = model.map(boxOf);
  const wBox = windows.map(boxOf);
  const out: ReadLine[] = [];
  const placed = new Set<number>();
  model.forEach((m, k) => {
    // Windows may read a line in pieces, not in their order: left to right.
    const near = windows
      .map((_, i) => i)
      .filter((i) => overlap(mBox[k], wBox[i]))
      .sort((a, b) => wBox[a]!.x0 - wBox[b]!.x0);
    if (!near.some((i) => other[i])) {
      out.push(m);
      return;
    }
    for (const i of near) {
      if (placed.has(i)) continue;
      out.push(windows[i]);
      placed.add(i);
    }
  });
  windows.forEach((w, i) => {
    if (!other[i] || placed.has(i)) return;
    const top = wBox[i]?.y0 ?? Infinity;
    const at = out.findIndex((l) => (boxOf(l)?.y0 ?? -Infinity) > top);
    out.splice(at < 0 ? out.length : at, 0, w);
    placed.add(i);
  });
  return { lines: out, taken: placed.size };
}

const LANGUAGES_SCRIPT = `Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
ConvertTo-Json -Compress -InputObject @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object { $_.Script -ne 'Latn' } | ForEach-Object { $_.LanguageTag })`;

const ASK_AGAIN_MS = 60 * 60_000;
let asked: { at: number; languages: Promise<string[]> } | null = null;

/** Windows' OCR languages installed for this account in an alphabet other than Latin ("ru-RU", "ja"), asked again each hour; none when Windows can't say. */
export function otherAlphabetLanguages(now = Date.now()): Promise<string[]> {
  if (!asked || now - asked.at > ASK_AGAIN_MS) {
    const languages = powershell(LANGUAGES_SCRIPT, { timeoutMs: 30_000 })
      .then((out) => {
        const got = JSON.parse(out.trim() || '[]');
        return (Array.isArray(got) ? got : [got]).filter((t): t is string => typeof t === 'string' && !!t);
      })
      .catch(() => {
        asked = null;
        return [];
      });
    asked = { at: now, languages };
  }
  return asked.languages;
}
