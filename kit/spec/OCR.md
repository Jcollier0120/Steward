# The text reader

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/OCR.md` in the Steward's repository, and `src/kit/spec/OCR.md` in every agent that takes the part. The reader is the kit's node part: `ocr.ts` (the API), `pdf-text.ts` (PDFs' text layer), `ocr-npu.ts` with `ocr-npu.cs` (our own model on the NPU), `ocr.ps1` (Windows' OCR, and PDFs' pages rendered), and its check, `ocr-check.ts` with `ocr-fixtures.ps1` and `ocr-check.json`. The model is made by `tools/ocr-model` in the Steward's repository.

The staff that read text in pictures read it through one reader, the kit's, since kit 2.102.0 (decided 2026-10-23):

| Staff | What it reads | Through |
|---|---|---|
| The Clerk | screenshots, scans and PDFs in the folders it files | `ocrFiles` (since kit 2.87.0) |
| The Scribe | the same, for its notes | `ocrFiles` (since kit 2.87.0) |
| Reeve | screenshots, word by word with their boxes, for its screens' checks | `ocrImages` |
| The Warrener | a peek at a picture or a PDF's first page | `ocrFiles`, with `pdfMaxPages: 1` and `scale: 'auto'` |

From kit 2.114.0 the engine is [our own text-reading model](#our-own-model) on the NPU, where the PC has one it runs on (Snapdragon's, for now). Windows' own OCR (Windows.Media.Ocr, on the processor) reads everywhere else, and until the model is in place. The staff never name the engine, so this changes no staff code.

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
- `engine`: the engine that read what was OCRed (`'model-npu'`, `'model-cpu'`, or `'windows'`, `OCR_ENGINE`); none when nothing was.
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

## Our own model

Since kit 2.114.0 (decided 2026-10-23, measured 2026-10-24), the reader reads with a text-reading model of our own, on the NPU. It had to:

- never read worse than Windows OCR in any of the check's groups;
- read at least 99.5% of lines exactly on screen text from 12 px up, and on document pages;
- be the smallest model that does that, under Apache-2.0 or MIT.

The first it does: it reads better than Windows OCR in every group, and as well on PDFs' text layers, which neither engine reads. The second it does for screens at 15 and 18 px and the browser at 100 to 150%. It doesn't at 12 and 13 px, on pages, or on the held-out set: [what's left](#whats-left-and-why) says why.

### The choice: PP-OCRv6 tiny, fine-tuned

PaddleOCR's PP-OCRv6 tiny (Apache-2.0): its text detector as published (0.43 M parameters), and its recognizer (0.56 M) fine-tuned on screen and document text. The two files are 4 MB in all. It was chosen from these, measured on the check's 41 pictures (1,160 lines, the PDFs aside):

| model | recognizer | exact lines | read on |
|---|---|---|---|
| PP-OCRv6 tiny, as published | 4.5 MB (6,906 characters) | 945 | the NPU |
| PP-OCRv5's English recognizer, as published, with v6 tiny's detector | 7.8 MB | 1,046 | the processor |
| v6 tiny, its recognizer fine-tuned (a step every 8 columns) | 2.3 MB (189 characters) | 1,100 | the NPU |
| and a step every 4 columns, and Roman numerals | 2.3 MB | 1,114 | the NPU |
| and the space's output raised by 1: **ocr-model-v1** | 2.3 MB | 1,118 | the NPU |
| Windows OCR | | 643 | the processor |

What made the difference:

- **Our characters, not 6,906.** The recognizer's head covers the 189 characters screens and documents use: Latin with its accents, figures, punctuation, symbols. That halves its file and removes look-alikes from other scripts.
- **Fine-tuning on text drawn as screens draw it.** The training lines were about 200,000 generated strings: prose, interface text, code, paths, URLs, numbers, accented words, capitals, typography, Roman numerals, and random characters. They were drawn by GDI and GDI+ (ClearType, grey and black-and-white) and by Edge at 100 to 250%, from 9 px up, in the installed text fonts. The check's held-out fonts and their near twins were left out, and so was every string in `ocr-check.json`. Each line was cut out with the room the detector's boxes leave, and padded as the reader pads it.
- **A step every 4 columns.** At 8, a run of narrow characters ("...", "ll", a space at 11 px) has fewer steps than it needs: CTC needs a blank between two of the same character. The last pooling now pools the height alone, and the convolution after it is dilated, so the weights are the same and the steps twice as many. It costs nothing measurable on the NPU.
- **The space's output raised by 1.** This was chosen on held-back drawn lines, never on the check (`tools/ocr-model/space_bias.py`), and is built into the model's head.

PP-OCRv5's recognizer read more than v6 tiny's as published. But fine-tuned, the tiny one reads more than v5's as published, at a third of its size, so v5 wasn't fine-tuned. `tools/ocr-model` has the whole recipe: the strings, the drawing, the training, the export, and the scoring.

### How it reads

The check on the same Snapdragon X2 Elite Extreme as [the baseline](#the-baseline-windows-ocr), kit 2.114.0, 2026-10-24, three runs, scale 1. Its processes were held to 8 of the 18 cores, as heavy runs on that PC are, which is why Windows OCR's times are higher than the baseline's. Each cell gives characters, words, exact lines, and ms a picture:

| group | Windows OCR | the model, on the NPU | the model, on the processor |
|---|---|---|---|
| screens, 11 px | 81.4%, 65.3%, 34/132, 64 | 99.8%, 97.7%, 123/132, 112 | 99.8%, 97.7%, 123/132, 465 |
| screens, 12 px | 88.1%, 75.3%, 33/120, 59 | 99.8%, 97.8%, 112/120, 105 | 99.8%, 97.8%, 112/120, 465 |
| screens, 13 px | 91.7%, 85.0%, 55/108, 50 | 99.9%, 99.7%, 105/108, 96 | 99.9%, 99.7%, 105/108, 426 |
| screens, 15 px | 96.1%, 91.9%, 60/96, 45 | 100%, 100%, 96/96, 93 | 100%, 100%, 96/96, 416 |
| screens, 18 px | 96.3%, 96.3%, 63/80, 40 | 100%, 100%, 80/80, 85 | 100%, 100%, 80/80, 382 |
| pages | 96.0%, 92.5%, 123/182, 116 | 99.9%, 99.5%, 178/182, 185 | 99.9%, 99.5%, 178/182, 732 |
| browser, 100% | 94.1%, 89.8%, 34/52, 48 | 100%, 100%, 52/52, 97 | 100%, 100%, 52/52, 446 |
| browser, 125% | 95.1%, 92.1%, 37/53, 37 | 100%, 100%, 53/53, 107 | 100%, 100%, 53/53, 474 |
| browser, 150% | 98.5%, 95.9%, 43/53, 46 | 100%, 100%, 53/53, 128 | 100%, 100%, 53/53, 546 |
| browser, 200% | 98.9%, 96.3%, 46/55, 62 | 100%, 99.7%, 54/55, 189 | 100%, 99.7%, 54/55, 811 |
| PDF, scanned page | 99.1%, 98.1%, 30/33, 666 | 100%, 100%, 33/33, 2,244 | 100%, 100%, 33/33, 2,469 |
| PDF, text layer | 100%, 100%, 60/60, 60 | the same, 96 | the same, 51 |
| held-out screens | 91.3%, 84.3%, 67/165, 57 | 99.7%, 97.9%, 150/165, 98 | 99.8%, 98.1%, 151/165, 437 |
| held-out page | 99.6%, 98.2%, 31/36, 116 | 99.9%, 99.6%, 35/36, 189 | 99.9%, 99.6%, 35/36, 765 |
| held-out browser | 97.3%, 92.9%, 17/28, 37 | 99.9%, 99.5%, 27/28, 112 | 99.9%, 99.5%, 27/28, 473 |
| the bench's 25 | 91.5%, 84.1%, 368/718, 55 | 99.9%, 99.0%, 694/718, 97 | 99.9%, 99.0%, 694/718, 439 |
| all 41 pictures and 2 PDFs | 93.4%, 87.6%, 733/1,253, 55 | 99.9%, 99.1%, 1,211/1,253, 101 | 99.9%, 99.2%, 1,212/1,253, 446 |

What it costs, on the NPU:

- A start with nothing to read: 744 ms, 766 ms of processor and 296 MB, against 353 ms and 100 MB for Windows OCR's PowerShell. The program stays loaded until no picture has come for two minutes, so this is paid once per spell of reading.
- The 41 pictures in one process: 5.5 s, 4.1 s of processor, a 366 MB peak. So a picture beyond the start costs 117 ms and 80 ms of processor, against 65 ms and 71 ms for Windows OCR (226 MB peak).
- A scanned PDF page takes 2.2 s through `ocrFiles`: its PowerShell renders the page, then the model reads it. Windows OCR reads it in that same PowerShell, in 0.7 s.
- The first start on a PC compiles the NPU's nine graphs (the detector's tile, and the recognizer at eight widths), about 17 s, and keeps them in the cache (13 MB).
- The fetch is 226 MB once: ONNX Runtime 79 MB, Qualcomm's runtime 144 MB, the model 4 MB. 242 MB is kept, of which Qualcomm's compiler alone is 182 MB.
- Chat on the NPU, with the reader reading the check's pictures over and over beside it (five chats each, medians):
  - chat alone: 1.44 s;
  - the reader in the background lane: 1.40 s;
  - the reader in the interactive lane: 2.32 s.

  The reader read 3.4 pictures a second either way. In the background it waits for chat's turns, as it should.

### What's left, and why

On the NPU, 42 of the 1,253 lines aren't read exactly. Characters are 99.7% or better in every group:

- **23: a space missing between two words**, in screen text at 11 to 14 px ("Col17", "file or" read as "fileor"). The check draws small screen text with narrower gaps between words than the training lines had. Where the model is unsure, the step goes to a letter beside the gap. Raising the space's output by 1 recovered some. More starts putting spaces inside words: held-back lines fell from 93.67% exact at 1 to 92.55% at 3.
- **13: a narrow mark, or a letter, misread**:
  - five lost a dot, a backslash or a hyphen 1 or 2 pixels wide, at 11 to 13 px ("config.json" read as "configjson");
  - two read a closing double quote as a single one;
  - two read "%" as "8" in a held-out font;
  - three misread letters (a page in Times New Roman, and two held-out lines);
  - one added a stray mark.
- **4: an old-style 0 read as o.** These are Georgia's figures and a held-out font's, which are drawn as a small o.
- **2: a capital I read as l.** In Calibri and a held-out sans they are the same shape.

The last two kinds can't be told apart by shape. Only the words around them tell, and the recognizer reads characters, not words. What would close the rest, none of it done yet:

- training lines drawn with the check's spacing at 11 to 13 px;
- a bigger recognizer (PP-OCRv5's, at 3.4 times the size);
- a word list for 0 and o, and I and l.

### How it runs

`ocr.ts` asks `ocr-npu.ts`' `modelReader` first. It reads what the model can, and Windows OCR reads the rest, so the staff never wait on the model:

- **The fetch.** What the model needs is fetched once for every agent on the PC, in the background, into the reader's shared folder (`%USERPROFILE%\.npu-agent\ocr`, `KIT_OCR_HOME`):
  - ONNX Runtime 1.27.0, from Microsoft's release;
  - the NPU maker's plugin, from its own NuGet package (Qualcomm's QNN 2.6.0 on an Arm PC);
  - the model, from the release `ocr-model-v1` in the manor's public releases.

  Each is pinned by size and SHA-256 (`MODEL_FILES` and the rest), and only the files the reader uses are kept, with their notices. Until all of it is there, Windows OCR reads.
- **The program.** `ocr-npu.cs`, a kit helper shipped signed, runs ONNX Runtime through its C API. It loads the model once and reads picture after picture until no picture has come for two minutes. On an Arm PC it runs as Arm (its manifest), not as x64 under emulation.
- **On Qualcomm's NPU:**
  - static shapes only: the detector reads 640×640 tiles overlapping by 64, and the recognizer reads lines 48 high at eight widths, from 128 to 2,048;
  - fp16, with the CPU fallback forbidden;
  - HTP's power-saver mode, and one thread that never spins;
  - the compiled graphs (EP context) kept in the cache.

  A program that compiled its graphs is started again at once, because Qualcomm's compiler holds about 2 GB until its program ends.
- **The working folder.** The program runs in the cache folder, so whatever a runtime leaves in its working folder stays there, never in a person's folder. VitisAI writes `original-info-signature.txt` and `original-model-signature.txt` there (checked on a Ryzen AI 7 350).
- **The NPU queue** (`npu-queue.ts`). Reading on the NPU takes the NPU's turn as any model work does (`acceleratorTurn`), eight pages a turn (`TURN_PAGES`, about half a second), in the caller's lane. A background read waits its turn. When the NPU's line is too long (four waiting), or no turn comes within 10 minutes, Windows OCR reads the rest instead of waiting.
- **The self-check.** Before it reads anything, the program reads a picture it draws itself, on the NPU and on the processor. An NPU that reads it differently isn't used, and Windows OCR reads for the next six hours (`REFUSED_MS`). So does a program that can't start.
- **The settings:**
  - `KIT_OCR_ENGINE=windows` reads with Windows OCR alone;
  - `KIT_OCR_ENGINE=model` reads with the model wherever it can, the processor included;
  - unset, the model reads where it's worth it;
  - `KIT_OCR_NPU=none` keeps the model off the NPU, `KIT_OCR_NPU=openvino` tries Intel's and `KIT_OCR_NPU=vitisai` AMD's (tests);
  - under `node:test`, Windows OCR reads unless `KIT_OCR_ENGINE` says otherwise, so no test fetches the model.

### On the processor

With no NPU the model runs on, or an NPU that fails the self-check, the model could read on the processor instead. It reads as well there as on the NPU (1,212/1,253). But on the X2's processor a picture beyond the start costs 498 ms and 1,452 ms of processor (four threads), with a 463 MB peak. That is 20 times Windows OCR's processor time, far from gentle in the background. So `ON_PROCESSOR` is false, and Windows OCR reads where the NPU can't.

What could change that: reading a picture in one piece on the processor rather than in the NPU's tiles (a 1280×720 screenshot is six tiles, 2.7 times its pixels), or an int8 copy. Neither is measured yet. `KIT_OCR_ENGINE=model` reads on the processor anyway.

### Intel and AMD

Neither has been measured yet. Both get the same check, `ocr-check --engine windows,model-npu,model-cpu`, sent as test requests:

- **Intel** (OpenVINO's NPU plugin 1.7.0, `KIT_OCR_NPU=openvino`): the route is there, as a test.
- **AMD:** VitisAI through Windows ML is still to be added, as Envoy reaches it. It needs every shape fixed and the CPU fallback off. VitisAI runs an FP32 model as BF16, so the FP32 files are tried first, and an int8 QDQ copy if they read worse.

Each becomes its PC's default if it reads no worse than Windows OCR in any group, at no more processor time a picture than Windows OCR.

### Where the model is published

The release `ocr-model-v1` in the manor's public releases holds `det.onnx`, `rec.onnx`, `charset.txt`, `LICENSE.txt` (Apache-2.0, PaddleOCR's) and `NOTICE.txt`, which says what was changed. No training data is included. A model that reads differently is a new version: a new release with new pins (`MODEL_VERSION`, `MODEL_FILES`), never a changed asset.
