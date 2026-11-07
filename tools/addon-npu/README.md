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
- AMD's NPU, whose FastFlowLM takes no add-on (below): `merge_lora.py` folds an add-on into its base GGUF,
  `q4nx_splice.py` puts the folded weights into a copy of AMD's own model, and `amd.ts` runs FastFlowLM with it beside
  the base, and llama-server with the add-on itself on the processor and the Radeon as the reference.

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

## AMD's NPU (XDNA 2): the add-on folded into the model

The kit's AMD NPU chat is FastFlowLM 1.0.10 with `qwen3.5:2b` (AMD's own NPU2 build of Qwen3.5-2B), and FastFlowLM
takes no add-on in any form: no request field, no option, no file, in 1.0.10 to 1.0.12. What it does load is a model
of its own format, so the add-on goes in folded into the weights, as a model of its own, and a job's request names
that model. `amd.ts` tests that route; the findings are in kit/spec/ACCELERATORS.md (Add-ons, AMD's NPU).

What it needs, besides the kit filled into `src/kit`:

- An AMD Ryzen AI 300 PC with the kit's AMD NPU route set up: FastFlowLM 1.0.10 in the kit's servers folder and
  `qwen3.5:2b` pulled (`%USERPROFILE%\.flm\models\Qwen3.5-2B-NPU2`).
- unsloth/Qwen3.5-2B-GGUF at `f6d5376b`: `Qwen3.5-2B-BF16.gguf` (to make and fold the add-on) and `Qwen3.5-2B-Q4_K_M.gguf`
  (the processor's and the Radeon's reference), with Qwen3.5-2B's `config.json`, `tokenizer.json`,
  `tokenizer_config.json` and `chat_template.jinja` from Qwen's repository in a folder of their own.
- llama.cpp b11734: its source (`convert_lora_to_gguf.py`, `conversion`, `gguf-py`) and the kit's processor and Vulkan
  builds (copies of their folders), whose `llama-quantize` and `llama-server` the steps use.
- AMD's q4nx converter, ROCm/FLM_Q4NX_Converter at `93b8398` (Apache-2.0).
- Python 3.13 in a virtual environment with numpy, PyTorch's CPU build, safetensors, einops, sentencepiece and
  transformers (llama.cpp's and the converter's requirements).

The steps, rank 32 here (`<work>` a folder of your own; every Python line with `-I -X utf8`, run from outside the
download folders as above):

1. Make the add-on and convert it, as above but with Qwen3.5-2B: `make_lora.py <work>/r32-peft --config <qwen>/config.json
   --base-gguf <Qwen3.5-2B-BF16.gguf> --gguf-py <llama.cpp>/gguf-py --rank 32`, then `convert_lora_to_gguf.py --base <qwen>
   --outtype f16`. On Qwen3.5-2B it adapts the 6 full-attention layers' q (its output gate included), k, v and o and the
   18 linear-attention layers' qkv and out projections: 60 weights.
2. Fold it into the BF16 base: `merge_lora.py --base <Qwen3.5-2B-BF16.gguf> --lora <work>/r32-f16.gguf --gguf-py
   <llama.cpp>/gguf-py --type BF16 --out <work>/merged-r32-bf16.gguf`.
3. Quantize the merged model and the base alike to Q4_K throughout, the type AMD's model keeps its projections in:
   `llama-quantize --pure <bf16 GGUF> <q4k GGUF> Q4_K_M 4`, once for each.
4. Convert both with AMD's converter, from its own folder (it reads `configs\` from there), its folder and llama.cpp's
   `gguf-py` put on Python's path by hand as above:
   `python -I -X utf8 -c "import sys,runpy; sys.path[:0]=['.', sys.argv[1]]; sys.argv=['convert.py']+sys.argv[2:]; runpy.run_path('convert.py', run_name='__main__')" <llama.cpp>/gguf-py -i <q4k GGUF> -o <folder>`.
5. Splice the adapted weights into a copy of AMD's own model: `q4nx_splice.py <Qwen3.5-2B-NPU2>/model.q4nx
   <converted>/model.q4nx <work>/merged-r32.q4nx "layers\.(3|7|11|15|19|23)\.self_attn\.(q|k|v|o)_proj\.weight$|linear_attn\.(qkv_proj|ssm_out_proj)\.weight$"`.
   Every other tensor stays AMD's, byte for byte. The same splice from the converted base is the control: the add-on's
   weights requantized without the add-on, which says what requantizing alone moves.

Why the splice: the converter makes a model FastFlowLM loads, but not AMD's. From the same BF16 only 57–66% of a
projection's bytes match AMD's, AMD's has a `.bf16` copy of each linear layer's alpha and beta that this converter no
longer writes, and its lm_head is int8 where a pure Q4_K's would be Q4_K. AMD's source and recipe aren't published.

Then the test, which copies the kit's FastFlowLM folder under `--out`, adds each merged model to its model list as a
size of its own (`qwen3.5:2b-r32`, `qwen3.5:2b-ctl`), and gives each a model folder of hard links to the installed
model's files but for its `model.q4nx`:

```
node tools/addon-npu/amd.ts --flm <the kit's fastflowlm-1.0.10> --model-dir %USERPROFILE%\.flm\models\Qwen3.5-2B-NPU2
    --merged ctl=<work>/base-r32.q4nx --merged r32=<work>/merged-r32.q4nx --out <results folder>
    --llama <processor build's copy> --vulkan <Vulkan build's copy> --gguf <Qwen3.5-2B-Q4_K_M.gguf> --lora r32=<work>/r32-f16.gguf
    [--phases load,speed,switch,answers,quality,odds] [--threads 4] [--clean]
```

- `--flm` can be another FastFlowLM's folder: the odds phase needs 1.0.11 or later, which return log-probabilities and
  continue a partial answer (`continue_final_message`); on 1.0.10 it says so and moves on.
- The add-on itself runs only in the references (llama-server, per request, F16); FastFlowLM gets the merged models.
- `--clean` deletes the scratch FastFlowLM and its model folders at the end.

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
