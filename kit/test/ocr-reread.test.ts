import assert from 'node:assert/strict';
import { test } from 'node:test';

// Text the kit's model can't read (ocr-reread.ts, kit 2.129.0): which of its reads look like another alphabet, which
// of Windows' lines hold one, and the page's lines kept line by line. The model's reads here are its own, of pictures
// drawn in each alphabet (Segoe UI, Microsoft YaHei, Yu Gothic) on an Intel Core Ultra's NPU.
const { keepBetter, looksUnread, oddWord, otherAlphabet, otherAlphabetLanguages } = await import('./fixture/src/kit/ocr-reread.ts');

/** A page's lines, one above the other, each word 100 px wide. */
const page = (...texts: string[]) =>
  texts.map((text, n) => ({ text, words: text.split(' ').map((t, k) => ({ t, x: 20 + k * 110, y: 20 + n * 60, w: 100, h: 40 })) }));

/** A line at a place: what Windows read there. */
const line = (text: string, x: number, y: number, w: number, h = 40) => ({ text, words: [{ t: text, x, y, w, h }] });

test('the model reads another alphabet as odd Latin words, or mostly capitals: read again; Latin text mostly not', () => {
  for (const unread of [
    ['CuëT N9 4521 oT 12 MapTa', 'O/IaTUTb AO KOHa MeC9a', 'roro K on/narTe: 18 400 py6.'], // Russian
    ['TIµoÀóyIo api0µÓç 4521', 'IlÀnpuwµÍ éuw tTo É\\Oç TOU µíÍva'], // Greek
    ['S18 4521', '|||', 'Ait#8: —75/\\TB7c'], // Chinese
    ['4521 µä, ö,jli', ',¢¿Jl ä,l4 Jö zòJl'], // Arabic
    ['Order 4521: MocKBa office', 'Ship by Friday, 40cTaBKa KkypbepoM', 'Total: 184 EUR'], // Russian among English
    ['BbIXO/,', 'TOTO K O1/ATE', 'IOAJIYÑCTA, HE KYPMTb'], // Russian capitals
    ['EEOAO2', 'APIOMOE 4521', 'AIAFOPEYETAI TO KAINIEMA'], // Greek capitals, no odd word
  ]) {
    assert.equal(looksUnread(page(...unread)), true, unread.join(' / '));
  }
  for (const read of [
    ['Invoice number 4521 dated 12 March', 'Pay before the end of the month', 'Total due: 18,400 dollars'],
    ["Don't miss the well-known café's 3rd anniversary (U.S.A.), 12th–14th May", 'Größe: 4K, mp3, A4 — “quoted” e.g. and/or'],
    ['Error 25006: the printer is offline', 'SETTINGS', 'Turn it off and on again'],
    [],
  ]) {
    assert.equal(looksUnread(page(...read)), false, read.join(' / '));
  }
  assert.equal(oddWord('getElementById'), true, 'camelCase is odd: Latin read again for nothing, and kept');
  assert.equal(oddWord('(4521),'), false, 'no letter: not a word');
});

test("Windows' line holds another alphabet only with letters not drawn like Latin ones, two at least and 15% of them", () => {
  for (const other of ['Итого к оплате: 18 400 руб.', 'ИТОГО К ОПЛАТЕ', 'Ship by Friday, доставка курьером', 'Τιμολόγιο αριθμός 4521', '发票号码 4521', '請求書番号', 'فاتورة رقم 4521']) {
    assert.equal(otherAlphabet(other), true, other);
  }
  for (const latin of [
    'Total due: 18,400 dollars',
    'Тоtаl duе: 18,400 dоllаrs', // Cyrillic Т, о, а, е: drawn like Latin
    'ΑΒΕ ΚΜΝ ΟΡΤ ΥΧ ok', // Greek capitals drawn like Latin
    'Invoice number 4521 dated 12 March, and one д', // one stray letter
    'Pay before the end of the month, by the 31st of March this year: дж', // two, under 15%
    '4521 — 18,400',
  ]) {
    assert.equal(otherAlphabet(latin), false, latin);
  }
});

test("a page in the Latin alphabet keeps the model's read, however Windows read it", () => {
  const model = page('Invoice number 4521 dated 12 March', 'PowerShell on iPhone: OK');
  const windows = [line('lnvoice number 4521 dated I2 March', 18, 18, 700), line('РоwеrShеll оn iPhоnе: 0K', 18, 78, 500)];
  const kept = keepBetter(model, windows);
  assert.equal(kept.taken, 0);
  assert.equal(kept.lines, model, 'the very same lines');
});

test("lines of another alphabet are Windows'; the rest stay the model's, each in its place", () => {
  const model = page('CuëT N9 4521 oT 12 MapTa', 'Invoice 4521 for Moscow', 'Ship by Friday, 40cTaBKa KkypbepoM', 'Total: 184 EUR');
  const windows = [
    line('Счёт № 4521 от 12 марта', 18, 18, 700),
    line('Invoice 452I for Moscow', 18, 78, 450), // Latin: the model's read stays
    // a line of both alphabets that Windows read in two pieces, the right one first
    line('доставка курьером', 360, 140, 300),
    line('Ship by Friday,', 18, 140, 330),
    line('Итого: 184 евро', 18, 300, 400), // where the model found nothing
  ];
  const kept = keepBetter(model, windows);
  assert.deepEqual(
    kept.lines.map((l: any) => l.text),
    ['Счёт № 4521 от 12 марта', 'Invoice 4521 for Moscow', 'Ship by Friday,', 'доставка курьером', 'Total: 184 EUR', 'Итого: 184 евро'],
  );
  assert.equal(kept.taken, 4);
});

test("Windows' OCR languages of another alphabet: never a Latin one", { skip: process.platform !== 'win32' }, async () => {
  const languages = await otherAlphabetLanguages(0);
  assert.ok(Array.isArray(languages));
  assert.ok(languages.every((l: unknown) => typeof l === 'string' && !/^(en|fr|de|es|it|nl|pt|sv|da|nb|fi|pl|cs|sk|hu|ro|tr)\b/.test(l)), languages.join(', '));
  assert.equal(otherAlphabetLanguages(1), otherAlphabetLanguages(2), 'asked once an hour');
});
