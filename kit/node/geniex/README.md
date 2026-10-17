# Castellan's build of GenieX 0.8.0's llama.cpp plugin

`geniex_plugin.dll` here is GenieX's llama.cpp plugin, built by Castellan with the changes in `geniex-castellan-memory.patch`. It goes in place of the plugin GenieX 0.8.0 installs (`%LOCALAPPDATA%\GenieX CLI\llama_cpp\geniex_plugin.dll`), on the Snapdragon X2 only. The keeper does it (`../npu-patch.ts`, `spec/npu-vendors.json`'s `pluginPatch`), until Qualcomm ships these fixes (qualcomm/GenieX#1557).

GenieX is Qualcomm's, under the BSD 3-Clause license in `LICENSE` beside this file. This binary is a modified build of it, not Qualcomm's release.

## What changed

The patch applies to qualcomm/GenieX at tag v0.8.0 and touches only `sdk/plugins/llama_cpp` (params.h/.cpp, vlm.h/.cpp, llm.cpp). Each change is on unless its variable is set to `0` in GenieX's environment.

- **GENIEX_PATCH_MMAP:** the model file is mapped on the Windows NPU rather than read into memory.
- **GENIEX_PATCH_TRIM:** after load, the mapped file's pages leave the working set.
- **GENIEX_PATCH_OUTPUTS:** the vision model reserves one logits row, so its compute buffer on the NPU is 128 MiB, not 601.
- **GENIEX_PATCH_LAZY_VISION:** the vision encoder loads with the first picture, not at start.
- **GENIEX_IMAGE_MAX_TOKENS=n:** a picture over n tokens is scaled down to fit. The kit sets it to the vision model's `pictureTokens`.
- A text-only prompt to the vision model is fed with positions, as a chat model's is.

Measured on the X2 Elite with Qwen3-VL-2B Q4_0, GenieX's own plugin against this build:

| | GenieX's own | This build |
|---|---|---|
| After a chat: working set | 4.0 GB | 1.77 GB |
| After a chat: private | 2.15 GB | 0.21 GB |
| After a picture: working set | 4.08 GB | 3.36 GB |
| Cold load to the first answer | 5.0 s | 2.4 s |

## How it was built

- `build-geniex-plugin.bat`: run in a clone of qualcomm/GenieX at v0.8.0 with the patch applied. Set its SRC and OUT to that clone first.
- The build uses Clang for arm64-pc-windows-msvc from Visual Studio 2022 Build Tools, with Ninja. Hexagon and OpenCL are off; only the `geniex_llama_cpp` target is built.
- It is built against the same llama.cpp commit (94256114) and GenieX patches as the shipped DLLs. It links against GenieX 0.8.0's own llama.dll, llama-common.dll, mtmd.dll, ggml.dll, ggml-base.dll and geniex.dll. The keeper checks each of them is 0.8.0's before it puts this in.
- It is signed with Castellan's code-signing certificate (Certum, timestamped). SHA-256 `a167bfbdd3a672caf2e629a5b56f4017e4f1bf4f442200b542ff2d602121f21b`, 301,136 bytes.

## Putting GenieX's own back

- GenieX's own file is kept beside it as `geniex_plugin.dll.stock`.
- Set `"npuPatch": false` in the keeper's config.json, and the keeper's next look puts it back.
- The keeper also puts it back by itself if this build fails its test (a picture and a chat), or a later kit stops patching.
- A GenieX update replaces the file, and the keeper then leaves it alone.
