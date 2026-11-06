# The add-on test: a LoRA on the Snapdragon's NPU

Can a LoRA add-on for Qwen3-VL-2B-Instruct (the NPU's chat and vision model) run on a Snapdragon X2's Hexagon NPU,
and at what cost? This folder holds the test behind the answer, in [kit/spec/ACCELERATORS.md](../../kit/spec/ACCELERATORS.md)
(Add-ons). Nothing here ships.

- `make_lora.py` makes a throwaway add-on: Hugging Face PEFT's layout, rank r on the language model's q, k, v and o
  projections, seeded random numbers, each change sized against its own weight in the base GGUF (`--strength`, 5% by
  default). Nothing is trained; a trained add-on has the same shapes, so the same work on the NPU.
- `addon-test.ts` runs llama.cpp's llama-server on the Hexagon the way the kit's NPU embedding server runs, with and
  without the add-ons, and records where each op runs, the speed, the memory, the time to switch an add-on on and off,
  the Warrener's naming answers and the model's own odds against the same add-on on the processor, and the kit's
  `geniex serve` route beside it. Each block of NPU work waits for the NPU's turn in the kit's line (background lane),
  on a private port, and stops every server it starts. The installed manor's servers are left alone.

## What it needs

- A Snapdragon X2 PC with the kit's NPU route set up: GenieX 0.9, and the NPU embedding server's llama.cpp b11645
  Hexagon build with GenieX's llama.cpp libraries copied over it (setup does both). Copy that build's folder for the
  test and pass the copy as `--hex`.
- The kit's pinned Qwen3-VL-2B-Instruct Q4_0 GGUF and its F16 projector (`kit/spec/npu-vendors.json`), in GenieX's model
  cache once GenieX has pulled them.
- The kit filled into `src/kit` (`npm run kit`): the test takes the NPU's line and the NPU benchmark's items from it.
- llama.cpp's source at the build's commit (b11645, `e467e5b`): `convert_lora_to_gguf.py`, its `conversion` folder and
  `gguf-py`.
- Qwen3-VL-2B-Instruct's `config.json`, `tokenizer_config.json` and `generation_config.json` from Qwen's repository, in
  a folder of their own (no weights: the converter reads the base's settings only).
- Python 3.13 for Arm64, in a virtual environment, with llama.cpp's `requirements/requirements-convert_lora_to_gguf.txt`
  and PyTorch's CPU build from PyTorch's own index (its Windows Arm64 wheels start at 2.12).

Run any Python that reads downloaded files with `-I`, from outside the download folders.

## Running it

Make an add-on (rank 32 here) and convert it to GGUF:

```
python -I -X utf8 tools/addon-npu/make_lora.py <work>/r32-peft --config <qwen>/config.json
    --base-gguf <the 2B's Q4_0 GGUF> --gguf-py <llama.cpp>/gguf-py --rank 32
python -I -X utf8 -c "import sys,runpy; L=sys.argv[1]; sys.argv=sys.argv[1:]; sys.argv[0]=L+'/convert_lora_to_gguf.py'; sys.path[:0]=[L, L+'/gguf-py']; runpy.run_path(sys.argv[0], run_name='__main__')"
    <llama.cpp> --base <qwen> --outtype f16 --outfile <work>/r32-f16.gguf <work>/r32-peft
```

(`-I` leaves the converter's own folder off Python's path, so the line puts it back, with `gguf-py`, by hand.)

Then the test:

```
node tools/addon-npu/addon-test.ts --hex <the build's copy> --model <the 2B's Q4_0 GGUF> --mmproj <its projector>
    --lora r32-f16=<work>/r32-f16.gguf [--lora name=<file> ...] --out <results folder>
    [--phases placement,speed,switch,answers,odds,geniex] [--geniex "%LOCALAPPDATA%\GenieX CLI\geniex.exe"]
```

- `--threads` is 8 at most, the manor's cap for long processor work; the processor's reference answers use them.
- `--hex-env NAME=value` adds to the Hexagon servers' environment: `GGML_HEXAGON_MM_SELECT=1` keeps every matmul on
  the vector units (HVX), `GGML_HEXAGON_OPFUSION=0` turns the backend's op fusion off, `GGML_HEXAGON_OPFILTER=<regex>`
  keeps the ops it names off the NPU.
- Everything goes into `<results folder>/results.json` (merged with what a run before left there), with each server's
  log beside it.

## Reading the results

- **placement**: `byBackend` counts the largest graph's nodes by device, `offNpu` names any not on `HTP0` (the two
  embedding lookups, `GET_ROWS`, are the processor's in every run), `loraBuffers` where the add-on's tensors are, and
  `dsp` the Hexagon's own microseconds for the prompt and for each written token, the add-on's share apart.
- **speed**: reads and writes, tokens a second, as llama-server times them; with an add-on on, and loaded but off.
- **switch**: an add-on switched per request makes llama-server read the whole prompt again; the same add-on again
  doesn't. `POST /lora-adapters` changes the add-on but keeps the cached prompt, read with the old one: don't use it.
- **answers**: the Warrener's 8 made-up documents named greedily on the NPU and the processor, without and with each
  add-on.
- **odds**: `follows` is how much of the processor's change to the name's first token the NPU makes (1 is all of it),
  `apart` against `baseApart` the gap the add-on adds over the NPU's own rounding, and `offAgain` what an add-on
  switched off leaves behind (0 is nothing).
