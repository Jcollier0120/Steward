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
python -I -X utf8 draw.py <repository> data/val.jsonl data/val --seed 2 --workers 6
python -I -X utf8 draw.py <repository> data/train.jsonl data/train --seed 1 --workers 6
node <repository>/tools/ocr-model/fixtures.ts fx
```

`draw.py` draws each line as GDI and GDI+ draw it (ClearType, grey, grid-fitted and black-and-white, through
`render-lines.ps1`, in the fonts that have its every character, as `fonts.ps1` finds them) or as Edge draws it at 100%
to 250%. The check's held-out fonts and their near twins are never used. Drawing 200,000 lines takes about an hour.
`fixtures.ts` draws the check's own pictures, which training only scores against.

```
python -I -X utf8 train.py models data/train data/val fx runs/r2 --steps 24000 --lr 5e-4 --every 2000 --workers 3
python -I -X utf8 export.py models runs/r2/best.pt out/r2
```

`train.py` fine-tunes the recognizer (`recnet.py`: PP-OCRv6 tiny's, with a head over our characters), scoring the
held-back lines and the check's pictures every `--every` steps; about five hours on a Snapdragon X2's processor.
`export.py` writes what the reader takes: `det.onnx`, `rec.onnx` and `charset.txt`, each checked against the model it
came from, with `LICENSE.txt` (Apache-2.0, PaddleOCR's) and `NOTICE.txt` (what the files are and what was changed).

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
node kit/node/ocr-check.ts --engine windows,model-npu,model-cpu --runs 3
```
