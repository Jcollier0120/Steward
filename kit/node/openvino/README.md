# Castellan's build of OpenVINO GenAI

OpenVINO Model Server 2026.4.1 carries OpenVINO GenAI 2026.4.1.0 as `openvino_genai.dll`. On Intel's NPU, that build can't serve Qwen3-VL, the Intel route's model for chat and pictures (kit 2.103.0). So the kit puts Castellan's build of the same file in its place: the same source with the two changes in `openvino-genai-castellan.patch`. It does this on every Intel NPU, and only over OpenVINO Model Server 2026.4.1's own file (`{tools}\servers\ovms-2026.4.1\openvino_genai.dll`). The route's `pluginPatch` (`spec/npu-vendors.json`) pins it. Once an OpenVINO Model Server release carries a GenAI that fixes both upstream, the kit moves to that release and drops this.

The build is 7.5 MB, and every agent carries the kit, so it isn't kept here. Setup downloads it from Manor-releases, [openvino-genai-2026.4.1.0-castellan.1](https://github.com/Jcollier0120/Manor-releases/releases/tag/openvino-genai-2026.4.1.0-castellan.1), checks its size and SHA-256 against the route's pins, and keeps it in the tools home (`servers\patches`).

OpenVINO GenAI is Intel's, under the Apache License 2.0 in `LICENSE` beside this file. This binary is a modified build of it, not Intel's release; `NOTICE` says what changed. The release carries the same LICENSE, NOTICE and patch, and GenAI's third-party-programs.txt.

## What changed

Both changes are in `src/cpp/src/visual_language/pipeline.cpp`:

- **A prompt without a picture.** On the NPU, a text-only prompt to Qwen3-VL crashed with `roi_end <= max_dim` (make_tensor.cpp). For such a prompt, Qwen3-VL's pipeline gives the language model a `visual_pos_masks` of one element, and NPUW's chunked prefill slices that mask along the prompt. On the NPU, the build widens it to the whole prompt, all false.
- **A failed request.** After one request failed part-way, every later one failed with `prompt_ids.get_size() >= tokenized_history.size()` until the server restarted. The failed request left its prompt's tokens in the embedder's cache state, which only a finished generate clears. The build resets that state at the start of each non-chat generate.

Both are still on openvino.genai's master and OpenVINO's master (NPUW's `llm_infer_request.cpp`) as of 2026-10-23.

A third problem isn't in this file. NPUW's `ReplaceDeepstackScatterWithAdd` recognises Qwen3-VL's DeepStack step only in transformers' form, a `ScatterNDUpdate`. optimum-intel exports it as a masked add, whose mask NPUW never fills, so on the NPU those features were zeroed and clear text was misread. The fix is in the model: Castellan's export has the step rewritten (`scatter_deepstack.py`, in `Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov` on Hugging Face). See ../../spec/NPU-VENDORS.md, Qwen3-VL-2B on Intel's NPU.

## Measured

On the Core Ultra 5 225U (NPU 3720, driver 32.0.100.5540), 2026-10-23, OpenVINO Model Server 2026.4.1, `--max_prompt_len 2048`. Both models were measured with npu-bench's full run (castellan-npu-bench/2, kit 2.99.1) at OpenVINO's own prompt settings, on this build:

| | Qwen3-VL-2B INT8 (Castellan's export) | Qwen3-VL-4B INT4 (OpenVINO's NPU build) |
|---|---|---|
| With the server's own file | every prompt without a picture fails | every prompt without a picture fails |
| Answers | 22 of 24 | 23 of 24 |
| Pictures | 4 of 4, 2.1 to 2.5 s each | 4 of 4, 6.6 to 7.1 s each |
| Writing | 11.0 tokens a second | 8.6 tokens a second |
| First token at 1,024 tokens | 2.0 s | 6.3 s |
| The benchmark's three jobs | 18.7 s | 46.6 s |
| Memory (working set) | 4.4 GB | 6.9 GB |

So the route serves the 2B. Its INT4 export (symmetric, group size 128) answered "Yes" to "Reply with the single word: ready" every time, so the route takes the INT8 one. The route's own prompt settings (`NPUW_LLM_PREFILL_CHUNK_SIZE` 256 and `GENERATE_HINT` BEST_PERF on the NPU 3720) speed the 2B up further: `spec/NPU-VENDORS.md` has those figures.

## How it was built

1. Install OpenVINO 2026.4.1 from pip, which carries the CMake config and import libraries GenAI builds against: `python -m venv venv`, then `venv\Scripts\python -m pip install openvino==2026.4.1`.
2. Clone the tag and apply the patch: `git clone --depth 1 --branch 2026.4.1.0 https://github.com/openvinotoolkit/openvino.genai.git genai`, then `git -C genai apply openvino-genai-castellan.patch`.
3. Run `build-openvino-genai.bat`, with its SRC, OUT and OPENVINO set to those folders first. It needs Visual Studio 2022 Build Tools with the C++ workload, which brings CMake and Ninja. It builds only the library: no Python, samples, tests, tools or tokenizers. That's 207 steps, about 10 minutes on the 225U.
4. Sign `out\openvino_genai\openvino_genai.dll` with Castellan's code-signing certificate (Certum, timestamped).

All 201 functions `ovms.exe` takes from GenAI are in the build. GGUF and XGrammar stay on, as in Intel's build. The signed file Manor-releases carries is 7,499,856 bytes, SHA-256 `3980614fcd89d612607e49335146e1a2864238edd145fe7e850a8f4b0c291067`. A rebuild won't match it byte for byte.

## How the kit puts it in, and takes it out

- **Setup** downloads it and puts it in before it tests the model: OpenVINO Model Server's own file is kept beside it as `openvino_genai.dll.stock`. It's put in only over that very file, and only while `openvino.dll` and `tbb12.dll` are the ones OpenVINO Model Server 2026.4.1 carries. A file that is neither (someone's own build) is left as it is.
- **The keeper's look** (`../npu-patch.ts`) keeps it there, and puts it in again, tested, where the server's own came back (setup unpacking the server again). It never downloads.
- **config.json's `npuPatch: false`** doesn't take it out, as it does GenieX's plugin on the X2: without it, the route's model fails on the NPU.
- **A later kit** that no longer patches this server puts its own file back from `.stock`, at the keeper's next look.
