# The add-on test: a LoRA on the NPU

Can a LoRA add-on for Qwen3-VL-2B-Instruct (the NPU's chat and vision model) run on a Snapdragon X2's Hexagon NPU,
and at what cost? This folder holds the test behind the answer, in [kit/spec/ACCELERATORS.md](../../kit/spec/ACCELERATORS.md)
(Add-ons). Intel's NPU has a test of its own, `intel.ts` with `addon_ov.py`, at the end ([Intel's NPU](#intels-npu-openvino-genai)).
Nothing here ships.

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

## Intel's NPU (OpenVINO GenAI)

The kit's Intel NPU chat is OpenVINO Model Server, whose LLM graphs take no add-on (only its image generation does), so
`intel.ts` runs the pipeline the server runs on the NPU, OpenVINO GenAI's `VLMPipeline`, directly: `addon_ov.py`, one
Python process holding the pipeline (or two, for the swap and bank phases), driven over its standard input. It uses
the kit's model (Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov) and the kit's NPU settings for the PC's generation
(`routeFor`), and runs the kit's own server beside it to compare. Each block of NPU work waits for the NPU's turn in
the kit's line, as on the Snapdragon.

### What it needs

- An Intel NPU PC with the kit's Intel route set up: OpenVINO Model Server 2026.4.1 and the int8 model, in the manor's
  accelerators folder (setup does both).
- The kit filled into `src/kit` (`npm run kit`).
- Python 3.13 (x64) in a virtual environment at a short path, such as `C:\worktrees\_addon-venv`. PyTorch's install
  passes Windows' 260-character path limit in a deeper folder; leave the system's long-path setting alone. Install:
  - `openvino==2026.4.1`, `openvino-genai==2026.4.1.0`, `openvino-tokenizers==2026.4.1.0`, `pillow` and `numpy`;
  - for `make_lora.py`, also `safetensors`, `gguf` and PyTorch's CPU build from PyTorch's own index.
- The kit's own GenAI build over pip's: copy `openvino_genai.dll` from the kit's server folder
  (`servers\ovms-2026.4.1`, version 2026.4.1.0-1-ab01d1771e4) over the one in the venv's
  `Lib\site-packages\openvino_genai`, keeping pip's beside it.
  - Pip's own fails on the NPU with a text-only prompt at the kit's 2048-token prompt size (`roi_end <= max_dim`,
    openvino.genai#4709). The pipeline then fails every request after (`prompt_ids.get_size() >=
    tokenized_history.size()`, #4708).
  - The kit's build fixes both, and pip's Python bindings load it.
- An add-on in PEFT's layout (`adapter_model.safetensors`). GenAI reads it directly, with no GGUF step. Use
  `make_lora.py`'s throwaway, or the Warrener's trained `warrener-r1-qv` (q and v, rank 32, lora_alpha 64).

### Running it

```
node tools/addon-npu/intel.ts --python <venv>\Scripts\python.exe
    --model %USERPROFILE%\.manor\accelerators\models\openvino\Castellan-AI\Qwen3-VL-2B-Instruct-int8-sym-ov
    --lora warrener=<warrener-r1-qv>\adapter_model.safetensors@2 [--lora r32=<work>\r32-peft\adapter_model.safetensors@2]
    --out <results folder> [--phases answers,odds,speed,switch,swap,bank,cold,memory,ovms] [--devices NPU,CPU,GPU]
    [--ovms %USERPROFILE%\.manor\accelerators\servers\ovms-2026.4.1\ovms.exe] [--runs 3] [--prop KEY=VALUE]
```

- The number after `@` is the add-on's alpha, and GenAI's alpha is the whole scale on B·A. GenAI ignores the file's
  own `lora_alpha`, so PEFT's scale (llama.cpp's scale 1) is **alpha = lora_alpha / r**: 64 / 32 = 2 for the Warrener.
  At alpha 1 an add-on does half of what it was trained to do.
- NPUW pads every add-on to `NPUW_LLM_MAX_LORA_RANK` (32 by default), and refuses a larger one when a request applies
  it. So a rank-64 add-on needs `--prop NPUW_LLM_MAX_LORA_RANK=64`, and the maximum is what changes the cost (the
  spec has the figures).
- The processor (`CPU`) is the reference for the answers and the odds, at 8 threads.
- The kit's server runs on a private port (`--port`, 28611 by default). It runs from a copy of the model's folder made
  of hard links, without its `graph.pbtxt`, and with a compile cache of its own.
- Everything goes into `<results folder>/results.json`, with each pipeline's log beside it.

### Reading the results

- **answers**: `againstProcessor` counts each device's names that match the processor's word for word, off and on
  (`onSameName` and `onSameFolder` count the name and the folder apart). `changedByAddon` counts the names the add-on
  changed.
- **odds**: as on the Snapdragon.
- **speed**: reads, writes and a Warrener name on each device:
  - with no add-on in the pipeline, with one loaded but off, and on;
  - `cpuSecondsPerGenToken` is the processor's time for each written token. On the NPU it stays a few milliseconds
    with the add-on on, so the add-on's work is the NPU's.
- **switch**: a request's first token when its add-on differs from the request before's, against the same again.
- **swap**: the base's pipeline alone, and the add-on's in its place only for a batch of the 8 names:
  - each swap's time, from closing one pipeline to the other's first token, from the cache;
  - what a chat arriving mid-batch waits (`chatWaitMs`);
  - `baseSameAfter`, whether the base answers the same after.
- **bank**: the base's pipeline and the add-on's side by side in one process, each with its own NPUW weights bank,
  then with one bank named for both (`NPUW_WEIGHTS_BANK`). It records what the second pipeline adds on the NPU and of
  the PC, and the base's speed beside it.
- **cold**: the pipeline made with an empty compile cache, then a full one, to its first answer.
- **memory**: the process's working set and what it holds on the NPU (`npuMb`).
- **routes**: GenAI directly against the kit's server: speed, the NPU benchmark's 24 quality items and 4 pictures, the
  first answer, and memory.
