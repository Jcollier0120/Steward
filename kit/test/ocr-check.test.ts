import assert from 'node:assert/strict';
import { test } from 'node:test';

// The text reader's check (ocr-check.ts, kit 2.102.0): its scoring, which must stay the bench's so figures compare
// with the baseline in spec/OCR.md, its pages for the browser, and one whole run on Windows.
const { norm, lev, scoreText, browserPage, parseCheckArgs, formatReport, runCheck, checkEngine, ENGINES, SPEC } = await import('./fixture/src/kit/ocr-check.ts');

test('scoring: text compared plain, edits counted, words found once each, lines found whole', () => {
  assert.equal(norm('  “Fix” it’s  — done\n'), '"Fix" it\'s - done');
  assert.equal(lev('kitten', 'sitting'), 3);
  assert.equal(lev('', 'abc'), 3);
  assert.equal(lev('same', 'same'), 0);
  const s = scoreText(['Total due: $1,249.50', 'Error 0x80070005: Access is denied.'], 'Total due: $1\nError 0x80070005: Access is denied.');
  assert.equal(s.chars, 'Total due: $1,249.50 Error 0x80070005: Access is denied.'.length);
  assert.equal(s.edits, 7);
  assert.equal(s.wordsAll, 8);
  assert.equal(s.wordsOk, 7, '"$1" is not "$1,249.50"');
  assert.equal(s.linesOk, 1);
  assert.deepEqual(s.missed, ['Total due: $1,249.50']);
  const twice = scoreText(['Reply Reply all'], 'Reply all');
  assert.equal(twice.wordsOk, 2, 'a word read once counts once');
});

test("the browser's page keeps only the lines that fit, escaped, in the order given", () => {
  const rnd = () => 0;
  const long = 'x'.repeat(200);
  const p = browserPage(['a < b & c', long, 'second line'], ['Segoe UI'], [16], { bg: '#fff', fg: '#000' }, rnd);
  assert.deepEqual(p.lines, ['a < b & c', 'second line']);
  assert.match(p.html, /a &lt; b &amp; c/);
  assert.doesNotMatch(p.html, /xxxxxxxxxx/);
  const many = browserPage(Array.from({ length: 100 }, (_, i) => `line ${i}`), ['Arial'], [16], { bg: '#fff', fg: '#000' }, rnd);
  // 720 px less the margins, 29 px a line
  assert.equal(many.lines.length, Math.floor((720 - 48) / Math.round(16 * 1.8)));
});

test("the check's options", () => {
  assert.deepEqual(parseCheckArgs([]), { engines: ['windows'], scales: [1], runs: 3, browser: true, fixtures: null, out: null, json: false });
  const o = parseCheckArgs(['--scale', '1,2,auto', '--runs', '1', '--no-browser', '--json']);
  assert.deepEqual(o.scales, [1, 2, 'auto']);
  assert.equal(o.runs, 1);
  assert.equal(o.browser, false);
  assert.equal(o.json, true);
  assert.throws(() => parseCheckArgs(['--scale', 'big']), /--scale/);
  assert.throws(() => parseCheckArgs(['--fast']), /unknown option --fast/);
  assert.deepEqual(parseCheckArgs(['--engine', 'windows,model-npu,model-cpu']).engines, ['windows', 'model-npu', 'model-cpu']);
});

test("the check's engines: Windows OCR and the kit's model, on the NPU or the processor", async () => {
  assert.deepEqual(Object.keys(ENGINES), ['windows', 'model-npu', 'model-cpu']);
  await assert.rejects(checkEngine('tesseract', [], { scale: 1, runs: 1, dir: '.' }), /no engine "tesseract" here \(engines: windows, model-npu, model-cpu\)/);
});

test('the held-out set shares no string or font with the rest', () => {
  const seen = new Set([...SPEC.ui, ...SPEC.prose]);
  for (const s of [...SPEC.heldOut.ui, ...SPEC.heldOut.prose]) assert.ok(!seen.has(s), s);
  for (const f of SPEC.heldOut.fonts) assert.ok(!SPEC.screenFonts.includes(f) && !SPEC.pageFonts.includes(f), f);
});

test('a whole check on Windows: every group read and reported, with its costs', { skip: process.platform !== 'win32' }, async () => {
  const logged: string[] = [];
  const [r] = await runCheck({ engines: ['windows'], scales: [1], runs: 1, browser: false, fixtures: null, out: null, json: false }, (s: string) => void logged.push(s));
  assert.equal(r.bench.images, 25, "the bench's 25 pictures");
  assert.equal(r.bench.lines, 718, 'drawn as the baseline was');
  for (const g of ['screen 11px', 'screen 18px', 'page', 'held-out screen', 'held-out page', 'pdf scan', 'pdf text layer']) assert.ok(r.groups[g]?.lines, g);
  assert.equal(r.groups['pdf text layer'].edits, 0, 'a text layer reads exactly');
  assert.ok((r.all.chars - r.all.edits) / r.all.chars > 0.8, 'Windows OCR reads most of it');
  assert.ok(r.cost.peakMB > 0 && r.cost.cpuMs > 0 && r.cost.startMs > 0);
  assert.match(logged.join('\n'), /the bench's 25/);
  assert.match(formatReport(r), /pdf text layer\s+100\.0%/);
});
