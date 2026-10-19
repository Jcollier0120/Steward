# Castellan's builds of GenieX's llama.cpp plugin

`geniex_plugin.dll` here is GenieX's llama.cpp plugin, built by Castellan with the changes in `geniex-castellan-memory.patch`. It goes in place of the plugin GenieX 0.8.0 installs (`%LOCALAPPDATA%\GenieX CLI\llama_cpp\geniex_plugin.dll`), on the Snapdragon X2 only. The keeper does it (`../npu-patch.ts`, `spec/npu-vendors.json`'s `pluginPatch`), until Qualcomm ships these fixes (qualcomm/GenieX#1557).

`0.9.1/` holds the same changes built for GenieX 0.9.1, which the keeper puts in on an X2 whose GenieX is 0.9.1 (the Smith's Use it): below, "GenieX 0.9.1".

GenieX is Qualcomm's, under the BSD 3-Clause license in `LICENSE` beside this file. These binaries are modified builds of it, not Qualcomm's release.

## What changed

The patch applies to qualcomm/GenieX at tag v0.8.0 and touches only `sdk/plugins/llama_cpp` (params.h/.cpp, vlm.h/.cpp, llm.cpp). Each change is on unless its variable is set to `0` in GenieX's environment.

- **GENIEX_PATCH_MMAP:** the model file is mapped on the Windows NPU rather than read into memory.
- **GENIEX_PATCH_TRIM:** after load, the mapped file's pages leave the working set.
- **GENIEX_PATCH_OUTPUTS:** the vision model reserves one logits row, so its compute buffer on the NPU is 128 MiB, not 601.
- **GENIEX_PATCH_LAZY_VISION:** the vision encoder loads with the first picture, not at start.
- **GENIEX_PATCH_VISION_IDLE:** the vision encoder is freed again once no picture has come for GENIEX_VISION_IDLE_SECONDS (60 by default), and the next picture loads it again (about 1 s). A request is never cut short: the encoder is freed only between requests.
- **GENIEX_IMAGE_MAX_TOKENS=n:** a picture over n tokens is scaled down to fit. The kit sets it to the vision model's `pictureTokens`.
- A text-only prompt to the vision model is fed with positions, as a chat model's is.

Measured on the X2 Elite with Qwen3-VL-2B Q4_0, GenieX's own plugin against this build:

| | GenieX's own | This build |
|---|---|---|
| After a chat: working set | 4.0 GB | 1.77 GB |
| After a chat: private | 2.15 GB | 0.21 GB |
| After a picture: working set | 4.08 GB | 3.36 GB |
| Cold load to the first answer | 5.0 s | 2.4 s |

With the encoder freed after a quiet spell (kit 2.82.1, `--nctx 2560`): after a picture, 3.19 GB working set and 1.97 GB private; once the encoder was freed, 2.08 GB and 0.67 GB. The 0.3 to 0.4 GB still held above a chat's is the OpenCL backend's own, in GenieX's ggml-opencl.dll, which isn't built here.

## How it was built

- `build-geniex-plugin.bat`: run in a clone of qualcomm/GenieX at v0.8.0 with the patch applied. Set its SRC and OUT to that clone first.
- The build uses Clang for arm64-pc-windows-msvc from Visual Studio 2022 Build Tools, with Ninja. Hexagon and OpenCL are off; only the `geniex_llama_cpp` target is built.
- It is built against the same llama.cpp commit (94256114) and GenieX patches as the shipped DLLs. It links against GenieX 0.8.0's own llama.dll, llama-common.dll, mtmd.dll, ggml.dll, ggml-base.dll and geniex.dll. The keeper checks each of them is 0.8.0's before it puts this in.
- It is signed with Castellan's code-signing certificate (Certum, timestamped). SHA-256 `f58eb6239500f124a0e5bc88adc92b372861883b6fb2a3df7279ec2abc9c4e0f`, 304,208 bytes.

## Putting GenieX's own back

- GenieX's own file is kept beside it as `geniex_plugin.dll.stock`.
- Set `"npuPatch": false` in the keeper's config.json, and the keeper's next look puts it back.
- The keeper also puts it back by itself if this build fails its test (a picture and a chat), or a later kit stops patching.
- A GenieX update replaces the file. The keeper puts in the build for the new version if the kit has one (0.9.1's, below), and otherwise leaves GenieX's own alone.

## GenieX 0.9.1

`0.9.1/geniex_plugin.dll` is the same patch carried to qualcomm/GenieX at tag v0.9.1 (`0.9.1/geniex-castellan-memory.patch`, four commits, again only `sdk/plugins/llama_cpp`). Each switch above works as it does for 0.8.0. What the port had to keep of 0.9.1's own changes:

- 0.9.1 reads pictures on the NPU's second Hexagon session (HTP1), which it holds for the vision model's whole life. So the encoder loaded with the first picture, or again after the quiet spell, goes there too, and to the processor if that fails, as 0.9.1's own load does.
- 0.9.1's `decide` (a choice among tools, which may carry a picture) loads the encoder when its request has a picture, and holds it while it runs, as a generate does.
- 0.9.1 warms the model up with its own context (4,096 on the NPU unless `--nctx` says less). The picture cap leaves that warm-up as it is: capping it saved nothing.

It links against GenieX 0.9.1's own llama.dll, llama-common.dll, mtmd.dll, ggml.dll, ggml-base.dll and geniex.dll, which carry llama.cpp e467e5b. All 144 functions it takes from them are there. The keeper checks each file is 0.9.1's before it puts this in, so a GenieX 0.9.0 or 0.9.2 keeps its own plugin.

Measured on the X2 Elite with Qwen3-VL-2B Q4_0, `--compute npu --nctx 2560`, pictures at 1,024 tokens, 2026-10-18:

| | 0.8.0 with Castellan's build, pictures on the Adreno | 0.9.1's own plugin | 0.9.1 with this build |
|---|---|---|---|
| The first answer after a start | 3.1 s | 4.7 s | 3.5 s |
| After a chat: working set / private / on the NPU | 1.6 / 0.22 / 1.48 GB | 3.27 / 0.73 / 3.21 GB | 1.62 / 0.25 / 1.50 GB |
| After a picture: on the NPU / on the Adreno | 1.48 / 1.54 GB | 3.21 GB / none | 2.45 GB / none |
| The PC's available memory: after a picture / 75 s later | 3.2 / 2.1 GB lower | 3.6 / 3.6 GB lower | 2.6 / 1.6 GB lower |
| The first picture after a chat | 2.0 s | 0.59 s | 1.0 s |
| A picture after 75 quiet seconds | 634 ms | 167 ms | 988 ms |
| Screen questions | 33 of 35, a median 4.49 s | 34 of 35, 1.50 s | 34 of 35, 1.50 s |
| Questions about ten photos | 21 of 21, 4.42 s | 21 of 21, 1.45 s | 21 of 21, 1.45 s |
| npu-bench's four pictures | 419 ms | 282 ms | 278 ms |
| Chat / quality items | 73.0 t/s, 22 of 24 | 72.6 t/s, 21 of 24 | 72.5 t/s, 21 of 24 |

So 0.9.1 with this build holds what 0.8.0 with its build did at rest, about 1.7 GB less than with its own plugin, and gives its first answer 1.2 s sooner. Its pictures are as quick and as right as 0.9.1's own. The first picture after a chat or a quiet spell takes about 0.4 to 0.8 s more, while the encoder loads.

Built with `0.9.1/build-geniex-plugin.bat`, the same way as 0.8.0's (set its SRC and OUT to a clone of v0.9.1 with the patch applied, and its llama.cpp submodule at e467e5b). Signed with Castellan's certificate (Certum, timestamped). SHA-256 `aa697e55d02300369d1a5917806c920f54b13a7b8e3d3519031ffa9dae457d1b`, 370,768 bytes.
