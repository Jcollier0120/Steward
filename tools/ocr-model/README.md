# The text reader's model: how it's made

The kit's text reader (`kit/node/ocr-npu.ts`, its program `kit/node/ocr-npu.cs`) reads pictures with a detector and a
recognizer of our own on the NPU. Both start as PaddleOCR's PP-OCRv6 tiny (Apache-2.0); the recognizer is fine-tuned
here on text drawn as screens and documents draw it. Why this model, and how well it reads, is in
`kit/spec/OCR.md`. This folder makes it again from nothing but the repository and the published models: no data
files are kept, everything is drawn.

## What it needs

- Windows 11, with Edge (the browser drawings) and the fonts that come with Windows.
- Python 3.13 with numpy, scipy, pillow, PyYAML, torch (the CPU build is enough), onnx, onnx2torch and onnxruntime.
  Run every script with `python -I -X utf8`, from a folder of its own outside the repository.
- Node.js 22.18 or later (the check's pictures).

## The steps

```
python -I -X utf8 fetch.py models
python -I -X utf8 strings.py <repository> 204000 data/all.jsonl --seed 1
```

`fetch.py` downloads the candidates, each pinned to a commit and its SHA-256 checked. `strings.py` writes the
training lines; none shares 16 characters in a row with the check's strings (`kit/spec/ocr-check.json`). Split them,
the last 4,000 held back:

```
head -n 200000 data/all.jsonl > data/train.jsonl
tail -n 4000 data/all.jsonl > data/val.jsonl
python -I -X utf8 strings.py <repository> 6000 data/extra.jsonl --seed 3 --kinds roman
python -I -X utf8 draw.py <repository> data/val.jsonl data/val --seed 2 --workers 6
python -I -X utf8 draw.py <repository> data/train.jsonl data/train --seed 1 --workers 6
python -I -X utf8 draw.py <repository> data/extra.jsonl data/extra --seed 3 --workers 6
node <repository>/tools/ocr-model/fixtures.ts fx
```

`data/extra` is Roman numerals among words ("Part II", "Level III"): most sans faces draw a capital I as their l, so
the model must learn from the words around them which it is, and the repository's text has too few.

`draw.py` draws each line as GDI and GDI+ draw it (ClearType, grey, grid-fitted and black-and-white, through
`render-lines.ps1`, in the fonts that have its every character, as `fonts.ps1` finds them) or as Edge draws it at 100%
to 250%. The check's held-out fonts and their near twins are never used. Drawing 200,000 lines takes about an hour.
`fixtures.ts` draws the check's own pictures, which training only scores against (with the kit filled in the
repository: `npm run kit`).

```
python -I -X utf8 train.py models data/train data/val fx runs/r2 --steps 24000 --lr 5e-4 --every 2000 --workers 3
python -I -X utf8 train.py models data/train,data/extra data/val fx runs/r3 --from runs/r2/best.pt --stride 4 --steps 10000 --lr 3e-4 --every 2000 --workers 3
python -I -X utf8 space_bias.py models runs/r3/best.pt data/val fx
python -I -X utf8 export.py models runs/r3/best.pt out/r3 --space-bias 1
```

`train.py` fine-tunes the recognizer (`recnet.py`: PP-OCRv6 tiny's, with a head over our characters), scoring the
held-back lines and the check's pictures every `--every` steps. The first run is at the published model's stride (a
step every 8 columns), the second at 4 (`recnet.halve_stride`: the same weights, twice the steps), which a run of
narrow characters needs: at 8, "...", "ll" or a space at 11 px come out one short. Each keeps to 8 cores (5 threads,
3 workers); on a Snapdragon X2's processor the first takes about five hours and the second three and a half. A run that
stops goes on from its last check with the same command and `--resume <out dir>/last.pt`.
`space_bias.py` chooses how much to raise the space's logit, by the held-back lines alone: the check draws small screen
text with narrower spaces than the training lines have, and at 11 and 12 px most of what the model still got wrong was
a missing space. For r3 the best was 1 (93.67% of the held-back lines exact, from 93.56%); lowering the blank as well
gained no more than noise.
`export.py` writes what the reader takes: `det.onnx`, `rec.onnx` (any space bias built into its head) and
`charset.txt`, each checked against the model it came from, with `LICENSE.txt` (Apache-2.0, PaddleOCR's) and
`NOTICE.txt` (what the files are and what was changed).

Model 2 (r4) goes on from r3 with lines of the kinds model 1 still got wrong on the check's small screen text, drawn
mostly at 11 to 13 px:

```
python -I -X utf8 strings.py <repository> 63000 data/r4all.jsonl --seed 31 --kinds spaced:35,marks:25,ui:10,numbers:8,prose:8,code:5,path:4,typography:2,roman:3
head -n 60000 data/r4all.jsonl > data/r4.jsonl
tail -n 3000 data/r4all.jsonl > data/val2.jsonl
python -I -X utf8 draw.py <repository> data/val2.jsonl data/val2 --seed 33 --workers 4 <the mix>
python -I -X utf8 draw.py <repository> data/r4.jsonl data/r4 --seed 32 --workers 4 <the mix>
python -I -X utf8 train.py models data/train,data/extra,data/r4,data/r4 data/val,data/val2 fx runs/r4 --from runs/r3/best.pt --stride 4 --steps 8000 --lr 2e-4 --every 1000 --threads 5 --workers 3
python -I -X utf8 space_bias.py models runs/r4/best.pt data/val,data/val2 fx
python -I -X utf8 export.py models runs/r4/best.pt out/r4
```

where the mix is

```
--edge-share 0.2 --px 9:1,10:3,11:8,12:9,13:8,14:5,15:2,16:2,18:1,22:1,26:1,31:2 --css-px 11:3,12:4,13:4,14:3,16:2,18:1,24:1
--hows gdiplus-cleartype:5,gdiplus-aa-grid:3,gdiplus-aa:1,gdi-cleartype:2,gdi-aa:0.5,gdi-mono:0.5
--boost "Segoe UI:2,Consolas:2,Arial:2,Calibri:3,Verdana:3,Tahoma:3,Georgia:3,Times New Roman:2,Constantia:3,Corbel:3,Sitka Text:3,Sitka Small:3"
```

`spaced` is short words, figures and signs a space apart, as status bars and settings show them ("Col 17", "Time &
language"); `marks` is file names, paths, abbreviations, dashes, quotes, percentages, groups of zeros, and words with a
capital I. `--kinds` takes each kind's weight. Drop from `data/val2.jsonl` any line already in `data/train.jsonl`,
`data/extra.jsonl` or `data/r4.jsonl` before drawing it. `--px`, `--css-px` and `--hows` replace `draw.py`'s weights
for sizes and drawings, and `--boost` multiplies a font's. GDI+ with ClearType is how the check draws its screens, so
model 1's misses came from too few such lines at those sizes, not from a different drawing. `data/r4` is given twice,
so its lines come up twice as often as the first rounds'. Both rounds' held-back lines choose the step: for r4, 7,000
of 8,000 (93.46% exact, from r3's 91.84% without its bias), and `space_bias.py` found 0 best, so it's exported with
none. On a Snapdragon X2's processor, held to 8 cores, it took about three hours.

## Publishing

The five files are the assets of the release `ocr-model-v<version>` in the manor's public releases, where the reader
fetches them (`kit/node/ocr-npu.ts`, `MODEL_VERSION` and `MODEL_FILES`, each pinned by size and SHA-256). A model that
reads differently is a new version: a new release, never a changed asset, so a reader with the old pins never fetches
files that don't match them.

## Scoring outside the kit

`pipeline.py` is the reader in Python (ONNX Runtime on the processor), `run.py` runs a detector and recognizer over the
check's pictures, and `score.py` scores any engine's answers as the check does:

```
python -I -X utf8 run.py fx models v6-tiny-det v6-tiny-rec 1 texts.json
python -I -X utf8 score.py fx texts.json
```

The figures that count are the kit's own check, with the model in place (`kit/spec/OCR.md`):

```
npm run kit
node src/kit/ocr-check.ts --engine windows,model-npu,model-cpu --runs 3
```
