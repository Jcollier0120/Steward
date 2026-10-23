# The text reader

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/OCR.md` in the Steward's repository, and `src/kit/spec/OCR.md` in every agent that takes the part. The reader is the kit's node part: `ocr.ts` (the API), `pdf-text.ts` (PDFs' text layer), `ocr.ps1` (the engine for now), and its check, `ocr-check.ts` with `ocr-fixtures.ps1` and `ocr-check.json`.

The staff that read text in pictures read it through one reader, the kit's, since kit 2.102.0 (decided 2026-10-23):

| Staff | What it reads | Through |
|---|---|---|
| The Clerk | screenshots, scans and PDFs in the folders it files | `ocrFiles` (since kit 2.87.0) |
| The Scribe | the same, for its notes | `ocrFiles` (since kit 2.87.0) |
| Reeve | screenshots, word by word with their boxes, for its screens' checks | `ocrImages` |
| The Warrener | a peek at a picture or a PDF's first page | `ocrFiles`, with `pdfMaxPages: 1` and `scale: 'auto'` |

The engine behind it is Windows' own OCR (Windows.Media.Ocr, on the processor) for now. The next step is our own text-reading model on the NPU (Snapdragon's, Intel's and AMD's), the smallest that reads everything in [the check](#the-check) right, on the processor where there is no NPU. It changes no staff code: the staff never name the engine.

## The API

```ts
import { ocrFiles, ocrImages } from './kit/ocr.ts';

// Files of any kind, in batches (one PowerShell script each), with each one's text.
const results = await ocrFiles(
  [{ path: 'scan.pdf', kind: 'pdf', thumb: 'thumbs/scan.png' }, { path: 'shot.png', kind: 'image' }],
  { tmpRoot: dataDir, boxes: true },
);

// Reeve's: each picture's lines and words with their boxes, and its size.
const pages = await ocrImages(['shot.png']);
```

`ocrFiles(jobs, options)` gives an `OcrResult` per job, in order:

- `ok`, `text` (a line a line, pages apart by a blank line), `ms`, `pages` (read), `pageCount` (in the file), `error`.
- `cloudOnly`: OneDrive's online-only. Opening the file would download it, so it isn't read (PDFs are checked before Node opens them, pictures in `ocr.ps1`).
- `source`: `'text'` (the PDF's own text layer), `'ocr'` (the engine), or `'mixed'` (some pages each).
- `engine`: the engine that read what was OCRed (`'windows'`, `OCR_ENGINE`); none when nothing was.
- `layout`, with `boxes`: each page read (`OcrPage`: `file`, `page`, `width`, `height`, `lines`, `source`), each line's words (`OcrWord`: `t`, `x`, `y`, `w`, `h`) in the picture's own pixels. A PDF page's are in the page as rendered at `pdfScale` (96 dpi times it), whether its text came from the text layer or the engine, so one frame holds both.

Its options:

- `tmpRoot` (required): a folder for each batch's list and page renders, removed after.
- `scale`: enlarges pictures before reading. 1 is the default; `'auto'` is 2 below 1,000 pixels, else 1 (the Warrener's).
- `pdfMaxPages` (5), `pdfScale` (2), `batchWeight` (40: a picture counts 1, a PDF its page limit), `onBatch`.
- `boxes`: fill `layout`.
- `pdfText`: read a PDF's text layer where it has one (the default). `false` renders and OCRs every page, as before 2.102.0.
- `orient`: turn photos the way their EXIF says (the default). `false` reads them as stored, as Reeve's own reader did.

A file that can't be read is a result with `ok: false` and its `error`. A batch whose script fails as a whole (no OCR language installed, PowerShell gone) rejects, as before, so the Clerk and the Scribe keep its files to try again.

`ocrImages(files, { scale, batch, tmpRoot })` gives an `OcrPage` per picture: `{ file (resolved), width, height, lines }`, or `{ file, width: 0, height: 0, lines: [], error }`. It reads with `boxes` on and `orient` off. Its `tmpRoot` defaults to `kit-ocr` in the system's temporary folder.

## PDFs that carry their text

Most PDFs people keep were made by a program (statements, invoices, letters) and carry their text. The reader reads it from the file (`pdf-text.ts`, `readPdfText`), exactly, rendering nothing. Only the pages without text are rendered and OCRed: scans, and text drawn as shapes. A PDF of both is read page by page.

**Why our own reader.** The kit has no npm dependencies, and its node part is copied into every agent's `src/kit`. pdf.js (Apache-2.0, the only library of its kind with a fitting license) would bring megabytes to every agent, MuPDF is AGPL, and Windows.Data.Pdf renders but gives no text. What a text layer needs is small: about 1,300 lines on Node's zlib.

- The file's objects are found by scanning, so a broken cross-reference table doesn't matter. Object streams and incremental updates are read (the later object wins).
- Filters: Flate (with PNG and TIFF predictors), LZW, ASCIIHex, ASCII85, RunLength.
- The page tree, with inherited resources, MediaBox, CropBox and Rotate.
- Content streams and the forms they draw: the text state and every text operator (Tj, TJ, ', ", Td, TD, Tm, T*, Tc, Tw, Tz, TL, Ts).
- Fonts: Type0 (CMaps' codespace ranges, Identity-H, widths), the simple fonts (WinAnsi, MacRoman, Standard, and Differences by glyph name, from the Adobe Glyph List's rules), ToUnicode maps, and the standard 14's widths.
- Lines are made from where glyphs are drawn: a space where there's a gap of more than 0.18 em, and bold made by drawing twice read once.

**Which pages are OCRed** (`needsOcr`):

- A page with fewer than 20 glyphs, when a picture covers more than 5% of it or it paints more than 10 shapes (a scan, text as outlines, a chart with a caption). A page of a few words and nothing else keeps them; a blank page stays blank.
- A page where more than a tenth of the glyphs map to no text (an embedded font with no ToUnicode).
- A page that is mostly a picture (more than half) with fewer than 100 glyphs. A scan that was OCRed before, with its text laid over it, has more, and is read from that text.

A PDF that is encrypted, bigger than 64 MB (`PDF_TEXT_MAX_BYTES`), or has no page found is rendered and OCRed whole, as before.

## Answers in ASCII

Until 2.102.0, a bullet could cost a whole file. `ocr.ps1` printed its answers as JSON lines through PowerShell's console, whose output encoding is the console's code page (437 on an English Windows) wherever the kit's UTF-8 prelude isn't run first. Code page 437 has no "•", and Windows' best-fit mapping turns it into 0x07, the bell: a raw control character inside a JSON string, so the line didn't parse and the file had no answer. The Snapdragon Dev Manager's bench met it on 2026-10-23.

- `ocr.ps1`'s `Out-Answer` writes printable ASCII only: everything else goes as `\uXXXX` (a pair for characters beyond U+FFFF), so no code page can change an answer.
- `parseAnswers` reads a line with a raw control character again with those as spaces. A line that still won't parse is that job's error ("OCR's answer was garbled"), never a job dropped.

`kit/test/ocr.test.ts` runs `Out-Answer` in a powershell.exe of its own, with no prelude, on a bullet, a bell, a euro, an emoji and U+2028.

## The check

```
node <agent>\src\kit\ocr-check.ts [--engine windows] [--scale 1,2|auto] [--runs 3] [--no-browser] [--fixtures <dir>] [--out <file>] [--json]
```

It measures each engine on text whose words are known, the same way on any PC, so each NPU maker's PC is measured on the same pictures. It draws them first, in a scratch folder (or `--fixtures`, kept):

- **The bench's 25** (`ocr-fixtures.ps1`, GDI+, from `ocr-check.json`'s seed): 20 screenshots, 1280×720, in four themes (dark, light, grey text on white, white on blue) at 11, 12, 13, 15 and 18 px, the screen fonts mixed line by line, ClearType; and 5 document pages, 31 px at about 200 dpi in four page fonts, and one at about 100 dpi. They are the Snapdragon Dev Manager's fixtures of 2026-10-23, drawn the same way, so their figures are the baseline's.
- **The browser's**: the same strings drawn by Edge, headless, at 100, 125, 150 and 200% (its device scale factor), dark and light, 12 to 16 CSS px. That's DirectWrite's rendering, as people see the web and Electron apps. Without Edge, these are left out.
- **PDFs**: three pages with a text layer (Helvetica, Times, Courier; read from the layer), and a scanned page (150 dpi, a JPEG) in a PDF.
- **The held-out set**: strings and fonts of its own (Trebuchet MS, Cambria, Courier New, Palatino Linotype, Candara, Lucida Sans Unicode), in screenshots (ClearType at 12 px, grey anti-aliasing at 14 px), a page, and a browser screenshot at 125%. No model may be trained on them: a training set leaves out every string in `ocr-check.json` and the held-out fonts.

Each engine reads the pictures `--runs` times, each run in a process of its own, and once with nothing to read. It reports per group:

- characters right: 1 − edits ÷ characters, all the known text against all the text read, compared plain (curly quotes and dashes straight, whitespace single);
- words found, each once;
- lines found whole in the text read;
- the engine's ms per picture (median of the runs).

It also reports the cost: a start with nothing to read, then all the pictures in one process (wall time, processor time and peak memory), and so a picture's cost beyond the start. The PDFs go through `ocrFiles`, as the staff read them. `--out` writes it all as JSON, with each file's text and the lines it missed.

## The baseline: Windows OCR

The Snapdragon Dev Manager's bench, 2026-10-23, on a Snapdragon X2 Elite Extreme (25 pictures, 718 lines). `ocr-check` gives the same accuracy figures on the same PC:

| | characters | words | exact lines | ms a picture |
|---|---|---|---|---|
| all 25, scale 1 | 91.5% | 84.1% | 368/718 (51.3%) | about 45 (47 ms processor) |
| screens, 11 px | 81.4% | 65.3% | 34/132 | 40 |
| screens, 13 px | 91.7% | 85.0% | 55/108 | 32 |
| screens, 18 px | 96.3% | 96.3% | 63/80 | 25 |
| pages | 96.0% | 92.5% | 123/182 | 74 |
| all 25, scale 2 | 94.2% | 88.1% | 61.0% | about 87 |

A PowerShell with nothing to read costs about 330 ms and 105 MB; 25 pictures peak at 214 MB (432 MB at scale 2). What it misses is misread, not lost: "Enor" for Error, "186 TB" for 1.86 TB, "Total due: $1" for $1,249.50. At 11 px it reads a quarter of the lines exactly.

The whole check on the same PC (kit 2.102.0, 2026-10-23, three runs; characters, words, exact lines, ms a picture):

| group | scale 1 | scale 2 |
|---|---|---|
| screens, 11 px | 81.4%, 65.3%, 34/132, 38 | 88.8%, 75.7%, 50/132, 61 |
| screens, 12 px | 88.1%, 75.3%, 33/120, 36 | 91.8%, 81.2%, 57/120, 58 |
| screens, 13 px | 91.7%, 85.0%, 55/108, 30 | 93.3%, 88.2%, 59/108, 54 |
| screens, 15 px | 96.1%, 91.9%, 60/96, 28 | 96.4%, 94.0%, 74/96, 54 |
| screens, 18 px | 96.3%, 96.3%, 63/80, 24 | 99.4%, 97.4%, 69/80, 51 |
| pages | 96.0%, 92.5%, 123/182, 70 | 96.5%, 93.7%, 129/182, 175 |
| browser, 100% | 94.1%, 89.8%, 34/52, 34 | 95.7%, 91.6%, 36/52, 56 |
| browser, 125% | 95.1%, 92.1%, 37/53, 41 | 95.5%, 93.8%, 39/53, 79 |
| browser, 150% | 98.5%, 95.9%, 43/53, 43 | 99.0%, 96.8%, 45/53, 98 |
| browser, 200% | 98.9%, 96.3%, 46/55, 66 | 99.1%, 97.3%, 48/55, 166 |
| PDF, scanned page | 99.1%, 98.1%, 30/33 | the same (PDFs render at `pdfScale`) |
| PDF, text layer | 100%, 100%, 60/60 | the same |
| held-out screens | 91.3%, 84.3%, 67/165, 35 | 96.0%, 88.8%, 92/165, 61 |
| held-out page | 99.6%, 98.2%, 31/36, 71 | 99.5%, 97.5%, 29/36, 188 |
| held-out browser | 97.3%, 92.9%, 17/28, 39 | 97.6%, 94.4%, 18/28, 75 |
| the bench's 25 | 91.5%, 84.1%, 368/718, 34 | 94.2%, 88.1%, 438/718, 57 |
| all 41 pictures and 2 PDFs | 93.4%, 87.6%, 733/1,253, 36 | 95.6%, 90.7%, 835/1,253, 61 |

- A start with nothing to read: 242 ms, 281 ms of processor, 99 MB.
- The 41 pictures in one process, at scale 1: 2.0 s, 2.1 s of processor, a 225 MB peak, so 43 ms (44 ms of processor) a picture beyond the start. At scale 2: 3.7 s, 3.8 s, 475 MB, and 84 ms (87 ms).
- A PDF through `ocrFiles` takes about 60 ms read from its text layer, and 520 to 680 ms rendered and OCRed (the reader's whole time, its PowerShell's start included).

At scale 1, Windows OCR reads only a quarter to a half of the lines of small screen text (11 to 13 px) exactly, and gets a third of the browser's lines at 100% wrong.

## Next: our own model on the NPU

The engine moves to a text-reading model of our own, run on the NPU (Snapdragon's QNN HTP, Intel's OpenVINO NPU, AMD's VitisAI through Windows ML), through the NPU queue, with the same model on the processor where there's no NPU. It must:

- never read worse than Windows OCR in any of the check's groups;
- read at least 99.5% of lines exactly on screen text from 12 px up, and on document pages.

Its choice, measured on this check, goes in this page.
