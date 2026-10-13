# The NPU on every Copilot+ PC

Since kit 2.31.0, the manor runs its models on the NPU of each Copilot+ PC maker: Qualcomm's Snapdragon, Intel's Core Ultra and AMD's Ryzen AI. Setup installs the NPU's own model server and its models; nobody has to find them by hand. This page says which server each maker gets and why, how the NPU is detected, what setup installs, the caps and timeouts, the licences, and what hasn't run on real hardware yet. The data is in `npu-vendors.json`, beside this file; the code is the node part's `npu-vendors.ts`, `detect.ts` and `setup.ts`.

Every NPU server is an OpenAI-compatible server behind the kit's usual contract (ACCELERATORS.md): an accelerator `npu` with a chat endpoint, and vision or embeddings where the server has them. Past setup, nothing in the kit knows which maker it is.

## One route, or one per maker?

One route for all three makers was looked for first, and none is solid enough today (researched 2026-10-06):

- **Nexa SDK** became Qualcomm's GenieX in 2026. Its last build for Intel and AMD NPUs (v0.2.73, February 2026) is frozen, and its NPU parts needed a commercial licence from Nexa.
- **Microsoft Foundry Local** covers all three on paper, through Windows ML's execution providers (QNN, OpenVINO, VitisAI). Against it: its command line is still a preview, its terms give no right to redistribute it, its NPU providers arrive through Windows Update, its docs ask for administrator rights, and several NPU paths are broken in practice. On the owner's Snapdragon it has run on the processor alone since 2026-09-28, because Windows ML holds two QNN providers at once. It stays what a person can bring themselves ("bring your own server").

So each maker gets its own server, chosen for being OpenAI-compatible, installable for one user without an administrator, unattended, pinned by SHA-256, and licensed for a product's customers:

| Maker | Server | Version | What it serves on the NPU | Install |
|---|---|---|---|---|
| Qualcomm Snapdragon X, X2 | GenieX (Qualcomm, formerly Nexa) | 0.8.0 | chat, vision (one model, Qwen3-VL-4B) | its Inno Setup installer, silent, per user, no administrator |
| Intel Core Ultra (Meteor Lake, Arrow Lake, Lunar Lake, Panther Lake, Wildcat Lake) | OpenVINO Model Server | 2026.4.1 | chat (Qwen3-4B-Instruct-2507, channel-wise INT4) | a zip, unpacked into the accelerators' folder |
| AMD Ryzen AI 300 and later (XDNA 2) | FastFlowLM | 1.0.7 | chat (Qwen3-4B-Instruct-2507), vision (Qwen3-VL-4B) | a portable zip, unpacked into the accelerators' folder |

Second choices, if a route fails on hardware: Foundry Local for Snapdragon and Intel; Lemonade Server (AMD's, Apache-2.0, which itself runs FastFlowLM) for AMD.

**Embeddings** stay off the NPU everywhere for now. GenieX serves none. OpenVINO Model Server 2026 serves them on the NPU as a preview (Qwen3-Embedding-0.6B), not yet tried here: the Intel hardware decides. FastFlowLM's embedding model is EmbeddingGemma, under Gemma's terms. So embeddings go to the graphics card, or to the processor on a PC without one: setup sets the processor up for embeddings when the NPU chats and there is no card.

## Detection

Detection asks Windows for the devices it lists as **Neural processors** (the `ComputeAccelerator` device class, as Heiward's `NpuHardware.cs` reads it), with their maker, PnP device id and driver (`DETECT_PS`, its `npu2|…` line). A PC whose Windows lists none is asked for a Hexagon driver as before.

- **Maker**: Qualcomm (or a Hexagon name), Intel, or AMD ("Advanced Micro Devices", or AMD as a word), from the maker and the name.
- **Generation**: a Snapdragon by its part number or name (`X1E`/`X1P`, "X Elite", "X Plus": `snapdragon-x`; `X2E`/`X2P`, "X2 Elite", "X2 Plus": `snapdragon-x2`); Intel and AMD by the PCI device id (`npu-vendors.json`'s `devices`: Intel `7D1D` Meteor Lake (Arrow Lake H and U, the same NPU 3720, likely show this id too), `AD1D` Arrow Lake-S, `643E` Lunar Lake, `B03E` Panther Lake, `FD3E` Wildcat Lake, as Linux's ivpu driver lists them; AMD `1502` XDNA, the Ryzen 7040 and 8040, `17F0` XDNA 2).
- **Supported** or not, and why, in plain words: a maker setup doesn't know, a generation no server runs language models on (AMD's first XDNA: no NPU server supports it, and AMD's own Lemonade says none plans to), an NPU driver older than the server needs (Intel 32.0.100.4023, as Intel's NPU model cards for OpenVINO 2026 state, and 32.0.100.5540 on Panther Lake and Wildcat Lake, where OpenVINO 2026.2–2026.4 may crash with older drivers (its known issue CVS-233822); AMD 32.0.203.311; a generation's own `driverMin` comes first), or a server built for the other processor (GenieX is Arm64 only; OpenVINO Model Server and FastFlowLM are x64 only).

An NPU the manor can't use is still recorded in `hardware.json` as an NPU (so a model is never called the NPU on it falsely), and setup says why it isn't set up; its work goes to the graphics card or the processor. `accelerators` (the report) shows the maker, generation, driver and the reason.

## What setup does (NPU first, then graphics cards, then the processor)

Manor's **Set up local AI**, `smith accelerators setup` and the Settings pages' Set up all run the kit's `setupCommand`:

1. **Plan, and ask.** It lists what it would install for the NPU (its server and each model, and whether they're already here), then each graphics card's llama.cpp build and models, then the total download, and asks before downloading anything (`--yes` skips the question; `--dry-run` only plans).
2. **The server**: downloaded whole, its size and SHA-256 checked against the pinned ones in `npu-vendors.json` (a mismatch deletes the file and stops), then installed for this user: GenieX's installer with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER`, the others unpacked into the tools home's `servers\` (`%USERPROFILE%\.manor\accelerators\servers\`). Nothing needs an administrator. A server already installed is used as it is.
   - **Its runtime**, where the route names one (`runtime` in `npu-vendors.json`): OpenVINO Model Server needs the Microsoft Visual C++ runtime, which a PC may not have and which only an administrator can install for everyone. So setup downloads Microsoft's own package of those DLLs (the Visual Studio catalog's CRT redist, 3 MB, size and SHA-256 pinned) and copies its five DLLs beside `ovms.exe`, where Windows looks first. A server that has them all beside it isn't given them again. Until kit 2.61.0 the route was refused on a PC without the runtime, with "administrator installs once": nothing the person could act on, and the NPU never showed.
3. **The models**: each pulled with the server's own command, unless it is already there. Where `npu-vendors.json` pins a model's files for this generation (GenieX's Qwen3-VL-4B on the X2 Elite, measured on the owner's laptop), each file's size and SHA-256 are checked after the pull.
4. **A test request** in the NPU's turn (its lock and line): the server started if it isn't running, one short chat answer, which must say "ready" as asked (a model that doesn't run properly on an NPU answers fast, with nonsense: kit 2.61.0), and one about a small picture when it serves vision. The first load may take minutes (OpenVINO compiles the model for the NPU), so it is given 15.
5. **Only then** is the `npu` entry written into config.json, beside the cards'. Any failure (download, installer, pull, checksum, test) leaves no NPU entry, says which step failed, and the rest of setup goes on.

An NPU entry a person configured is left alone unless `npu` is asked for by name; the GenieX entry an older install wrote by default is replaced by a set-up one, and dropped on a PC whose NPU the manor can't use.

The entry carries everything an agent and the keeper need: the server's `startCommand` (with its port), its `env` where the server needs one (OpenVINO Model Server's `PYTHONHOME` and `PATH`, as its `setupvars` script sets them), the caps, the timeouts and the quirks.

## Ports

GenieX 18181 (its default, as before), OpenVINO Model Server 18183, FastFlowLM 18184; the next free one from 18191 when a card already has it. All on 127.0.0.1.

## Caps and timeouts

Conservative where nothing has been measured. The NPU always has one slot.

| Maker | Cap (prompt and answer) | Background request | Cold load | Why |
|---|---|---|---|---|
| Qualcomm | 2,400 tokens, chat and vision | the rules' 15 s + 0.3 s a token | the rules' 90 s | measured on the X2 Elite: an ~8K prompt bluescreened it; GenieX writes ~34 tokens a second |
| Intel | 1,536 tokens | 15 s + 0.3 s a token | 120 s | OpenVINO's NPU pipeline is compiled for a prompt length (`--max_prompt_len 1536`); measured on a Lunar Lake: about 25 tokens a second, a first load with its compile 31 s; room left for Meteor Lake's slower NPU, unmeasured |
| AMD | 4,096 tokens, chat and vision | 20 s + 0.4 s a token | 120 s | FastFlowLM takes long contexts, but unmeasured here |

A cap can differ per kind (`maxContextTokens` on an endpoint: the core's `capFor`), and an accelerator's own `timeouts` take the rules' place (the core's `requestTimeoutMs`). Only GenieX is restarted for holding too much memory (the keeper's 9 GB recycle); the others aren't known to leak.

## The keeper

OpenVINO Model Server opens its port within a second of starting and answers `/v1/models` with an empty list while it loads (on the NPU, compiles) its model, refusing requests until then: a server started from `ovms.exe` is ready only once it lists a model (accelerators.ts' `listsWhenLoaded`), and a request waits for it as long as the accelerator's `coldLoadMs` allows. Found by the NPU check's rehearsal, 2026-10-12.

The keeper (the Smith, else Reeve) starts and restarts each server from its entry, as it does llama.cpp's: it reads each server's address from its command line (GenieX's `--host`, OpenVINO Model Server's `--rest_port`, FastFlowLM's `--port`). It stops an orphan only when it is the manor's own: its program is in the manor's servers folders, or a record says the manor started that very process (`started.<pid>.json` beside the failure markers, written whenever a server is started). A program on one of the manor's ports for any other reason (a person's own GenieX on its default 18181, Ollama, a server whose program Windows won't name) is never stopped.

## Models and sizes

| Maker | Model | Kinds | Download |
|---|---|---|---|
| Qualcomm | `qualcomm/Qwen3-VL-4B-Instruct:W4A16` (Qualcomm AI Hub's NPU build) | chat, vision | 4.4 GB |
| Intel | `Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov` (Castellan's channel-wise INT4 export, the kind the NPU runs properly; its files pinned) | chat | 2.2 GB |
| AMD | `qwen3-it:4b` (Qwen3-4B-Instruct-2507), `qwen3vl-it:4b` (Qwen3-VL-4B-Instruct) | chat, vision | about 3.3 GB and 4.1 GB |

Plus the server: GenieX 65 MB, OpenVINO Model Server 140 MB (and its Visual C++ runtime, 3 MB), FastFlowLM 40 MB.

## Licences

| What | Licence | Note |
|---|---|---|
| GenieX | BSD-3-Clause, and Qualcomm's Terms of Use | Its bundled QAIRT runtime's terms aren't stated in its NOTICE: **have it reviewed**. The installer isn't code-signed. |
| Qualcomm AI Hub's W4A16 builds | the base model's licence (Apache-2.0 for Qwen3), with AI Hub's "Usage and Limitations" | Those limitations exclude some uses (among them education, employment, law enforcement, biometrics, critical infrastructure): **have them reviewed** against Castellan's terms. |
| OpenVINO Model Server | Apache-2.0 | Its zip carries its third-party licences. |
| The Microsoft Visual C++ runtime DLLs beside it | Visual Studio's "Distributable Code" terms | Microsoft lets an application carry these DLLs in its own folder; here each PC downloads them from Microsoft, so Castellan doesn't redistribute them either: **have it reviewed**. |
| OpenVINO's model exports | the base model's (Apache-2.0 for Qwen3) | |
| FastFlowLM | MIT (its code and CLI); its NPU kernels free for any use, including commercial | It asks for "Powered by FastFlowLM" in the product's notices: add it to the third-party notices. |
| Qwen3-4B-Instruct-2507, Qwen3-VL-4B-Instruct, Qwen3-Embedding-0.6B | Apache-2.0 | |
| Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov, on Hugging Face | Apache-2.0, the base model's | Castellan's own export, so Castellan publishes this one: with the base model's LICENSE, and a model card saying what was changed (the weights converted and compressed, nothing else) and how, as Apache-2.0 asks. |
| Avoided | Llama 3.2 (community licence), Gemma and EmbeddingGemma (Gemma's terms flow down to users), AMD's Ryzen AI ONNX runtime (AMD's software licence) | Not installed by setup. |

Each customer's PC downloads the servers, runtimes and models from their makers (GitHub releases, Microsoft, Hugging Face, Qualcomm AI Hub); Castellan doesn't redistribute them, except Intel's NPU model, its own export, which it publishes on Hugging Face as Castellan-AI.

## The NPU check (on a new maker's hardware)

`node <agent>\src\kit\npu-check.ts --yes` (kit 2.60.0; the kit as an agent carries it, e.g. Manor's `%USERPROFILE%\.manor\app\src\kit\npu-check.ts`) runs everything below that hasn't run on real hardware, on the PC's own NPU, and measures it. It writes no config.json and leaves nothing running:

1. **detect**: the NPU's name, maker, generation, PCI device id and driver, and whether the manor can use it (an unknown PCI id is printed, ready to add to `devices`).
2. **requirements**: what the route needs besides itself, and that setup brings it (the Visual C++ runtime beside OpenVINO Model Server).
3. **setup**: the server downloaded, checked and installed, and its models pulled, as setup does them, each step timed.
4. **start**: the server started from its entry, and the time until it answers `/v1/models`.
5. **first-answer**: the first chat answer, and the whole first load (OpenVINO's compile for the NPU) from the start.
6. **warm**: three short answers.
7. **speed**: an answer of about 120 tokens: tokens written a second.
8. **read**: a prompt of 80% of the cap: tokens read a second.
9. **cap**: a prompt just under the cap must be answered; one past it must be refused plainly, with the server still answering.
10. **two-at-once**: two requests together both answered.
11. **memory**: the server's working set and private bytes.
12. **restart**: stopped and started again: the cold load from its compile cache, against the route's `coldLoadMs`.
13. **kit-test**: the kit's own test request, the server started as every agent starts it, in the NPU's turn.

It ends with the caps and timeouts the numbers suggest for the route (`requestBaseMs` twice a full-cap read and a warm answer, `requestPerTokenMs` twice the time a token took, `coldLoadMs` half again the slowest start), and keeps the whole report as `npu-check-<maker>-<time>.json` in the tools home. `--no-setup` checks only what's installed.

`--route intel --device CPU` rehearses Intel's route off the NPU (OpenVINO on the processor), on any PC that runs x64 programs, Windows on Arm included: its download, layout, environment, pull, serve and routes, all but the NPU. A rehearsal runs only with REEVE_HOME set to a scratch folder, so this PC's servers, models and locks are left alone. GenieX and FastFlowLM run on the NPU only, so they can't be rehearsed.

## Verified, and not

**Run on real hardware** (the owner's Snapdragon X2 Elite Extreme, X2E94100, Hexagon driver 30.0.228.10000, 2026-10-07):
- detection through the Neural processor class: maker, generation, driver;
- the plan with GenieX 0.7.0 and the model already there (nothing to download);
- the pinned SHA-256 of GenieX 0.7.0's installer (downloaded to a scratch folder) and of every Qwen3-VL-4B model file;
- GenieX 0.8.0 (2026-10-07, the Smith's scout's first try): its installer's SHA-256 as GitHub publishes it, the silent per-user install over 0.7.0, the test request (chat and vision) on the route's own arguments and on the PC's configured entry, and every pinned Qwen3-VL-4B file unchanged under it;
- the test request, chat and vision, through the kit, in the NPU's turn: answered in 14 s;
- the keeper's GenieX handling (measured since kit 2.6.0).

**Run on an Intel Lunar Lake** (Core Ultra 7 256V, PCI `643E`, NPU driver 32.0.100.4512, 2026-10-12), the NPU check passing every step:
- setup from nothing: OpenVINO Model Server 2026.4.1's zip, the Visual C++ runtime beside it (the PC had it in System32 too, from Office; Windows loaded the copies beside `ovms.exe`), the model's pull;
- `Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov` on the NPU, downloaded by setup from Hugging Face into an empty folder, its pinned files checked: a first load with its compile 31 s, 5 s from its cache; about 24–26 tokens written and 650–670 read a second; a short answer warm in 0.7 s; 1,395 tokens answered and 1,792 refused plainly at the 1,536 cap; two at once; 3.6 GB working set; the kit's test request in the NPU's turn;
- OpenVINO's `Qwen3-8B-int4-cw-ov` there too, before Castellan's 4B was made: right, at 14.8 tokens a second, a 51 s first load and 5.5 GB;
- `OpenVINO/Qwen3-4B-int4-ov`, the route's first model, answering nonsense on the NPU (right on the processor and the Arc 140V): why setup's test request now checks its answer says "ready".

**Checked from source or the release, not run**: OpenVINO Model Server 2026.4.1's zip (its SHA-256, its layout, its `/v1/models` and `/v1/chat/completions` routes in its source at that tag); FastFlowLM 1.0.7's zip (SHA-256, `flm.exe` at its root).

**Unverified on hardware**, each needing a run on a real PC:
- GenieX's silent install on a clean PC (the flags are Inno Setup's standard ones), and on a first-generation Snapdragon X (its model build and its speed);
- Intel beyond Lunar Lake: Meteor Lake, Arrow Lake, Panther Lake and Wildcat Lake (their PCI ids, speed, and the driver minimum);
- everything on AMD: FastFlowLM on XDNA 2, its models' names and sizes, the 4,096-token cap and timeouts, the PCI ids, the driver minimum;
- that AMD's XDNA (Phoenix, Hawk Point) is refused with the right words on a real PC;
- the keeper's restarts and idle stops of OpenVINO Model Server and FastFlowLM.
