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

**Embeddings** run on the Snapdragon's and Intel's NPUs, each through a server of its own (below). AMD's stay off the NPU: FastFlowLM's embedding model is EmbeddingGemma, under Gemma's terms. There they go to the graphics card, or to the processor on a PC without one: setup sets the processor up for embeddings when the NPU chats but makes none and there is no card.

### Embeddings on Intel's NPU

OpenVINO Model Server started from the command line serves one model for one task, so the route's `embedServer` is a second one: the route's own program and environment (no download of its own) on port 18186, `--task embeddings --target_device NPU --pooling LAST --max_length 2048`, sharing the chat server's compile cache. Its model, OpenVINO's channel-wise INT4 Qwen3-Embedding-0.6B (`OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov`, 428 MB), is pulled as the chat model is and its files pinned. The pull writes a graph without pooling, device or length; serving with `--source_model` and those flags rewrites it with them.

- **Last-token pooling** (`--pooling LAST`) is Qwen3-Embedding's. Without it the vectors are wrong.
- **2,048 tokens.** The NPU compiles a fixed shape: every request costs the whole `--max_length`, and a longer one is refused (400; `--truncate` only cuts to the model's own 32k). Reeve's chunks are 1,500 characters, and a dense one runs past 1,024 tokens: UUIDs 1,338, hex 1,184, base64 1,179, JSON 1,100, against 775 for code and 830 for Chinese. At 2,048 every one is taken, for about 15% more time than at 1,024. Its cap (`caps.embed`, 680) is in the kit's estimate of 3 characters a token, so a request under it stays under 2,048 real tokens even at nearly one token a character.
- **Its own index.** Its model's name isn't the graphics card's (`qwen3-embedding-0.6b-gguf`), so Reeve keeps a separate index for it, and each model's vectors stay with their own.

Measured on the Lunar Lake (Core Ultra 7 256V, 2026-10-13), with the same inputs on each:

| | NPU (this server) | Arc 140V, OpenVINO | Arc 140V, llama.cpp Vulkan (setup's card) |
|---|---|---|---|
| A query | 166 ms | 22 ms | 25 ms |
| 16 sentences at once | 2.6 s | 41 ms | 619 ms |
| 16 of Reeve's chunks at once | 2.6 s | 1.2 s | 5.9 s |
| Cat/kitten similarity | 0.748 | 0.748 | 0.705 |
| Memory | 1.7 GB | 1.3 GB | — |

The first load compiles it in 13 s. The NPU's results are the card's for the same model. It indexes faster than the card does as setup gives it, for less power, and it runs beside the chat server on the NPU. A short query is slower than on the card, because it costs the full 2,048 tokens.

### Embeddings on the Hexagon

GenieX serves no `/v1/embeddings` (its issue #1149), but it carries llama.cpp (build b11125 in GenieX 0.8.0) with llama.cpp's Hexagon backend and Qualcomm's signed HTP libraries (`libggml-htp-v73/v75/v79/v81.so` and their catalogue `libggml-htp.cat`), so nothing needs test-signing. The route's `embedServer` runs llama.cpp's own `llama-server` of that very build (its release zip, pinned) over GenieX's libraries (its `overlay`: GenieX's `ggml*.dll`, `llama.dll`, `llama-common.dll`, `mtmd.dll` and the HTP files, copied whenever they differ), on `--device HTP0`, with Qwen3-Embedding-0.6B Q8_0, the graphics card's model. A llama-server of another build doesn't load GenieX's libraries (a missing entry point), so `embedServer.version` moves with GenieX's. The HTP library is loaded through FastRPC, which finds it by `ADSP_LIBRARY_PATH` (the entry's `env`) or the working folder.

Measured on the X2 Elite (2026-10-12), Reeve's search eval on GamerNexus (9 questions), against the Adreno's llama.cpp and npu-embed's nomic-embed-text v1.5 on the NPU:

| | Hexagon (Qwen3-Embedding) | Adreno X2-90 (Qwen3-Embedding) | NPU, nomic v1.5 (npu-embed) |
|---|---|---|---|
| Right file in the top 5 | 9/9 | 9/9 | 8/9 |
| Right file first | 4/9 | 5/9 | 4/9 |
| A query, warm | 45–73 ms | 103–155 ms | 73–88 ms |
| A 1,600-character chunk | 124 ms | 265 ms | (128 tokens at most) |
| Indexing GamerNexus, gentle pace | 31 min | about 65 min | 3 min |

Its vectors match the card's (cosine 0.9990–0.9998 on the same texts), so it keeps the card's model name, `qwen3-embedding-0.6b-gguf`, and an index made by either serves both. Several requests at once are slower on the Hexagon, not faster (`--parallel 4`: 702 ms a chunk), so it takes one at a time. It holds about 2.8 GB of the NPU's memory beside GenieX's model (604 MB model, 896 MB context, 1.3 GB compute) and is stopped when idle, as GenieX is.

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
   - **Its runtime**, where the route names one (`runtime` in `npu-vendors.json`): OpenVINO Model Server needs the Microsoft Visual C++ runtime, which a PC may not have and which only an administrator can install for everyone. So setup downloads Microsoft's own package of those DLLs (the Visual Studio catalog's CRT redist, 3 MB, size and SHA-256 pinned) and copies its five DLLs beside `ovms.exe`, where Windows looks first. A server that has them all beside it isn't given them again. Until kit 2.65.0 the route was refused on a PC without the runtime, with "administrator installs once": nothing the person could act on, and the NPU never showed.
3. **The models**: each pulled with the server's own command, unless it is already there. Where `npu-vendors.json` pins a model's files for this generation (GenieX's Qwen3-VL-4B on the X2 Elite, measured on the owner's laptop), each file's size and SHA-256 are checked after the pull.
4. **Its embedding server**, where the route has one (the Snapdragon's): its zip downloaded and checked against its pinned SHA-256, unpacked into the tools home's `servers\llama.cpp\`, the route's server's files copied over it, and its model downloaded into `models\` (checked the same way) unless it's there. When a graphics card is set up too, the card uses that same file rather than downloading it again.
5. **A test request** in the NPU's turn (its lock and line): the server started if it isn't running, one short chat answer, which must say "ready" as asked and nothing degenerate (a model that doesn't run properly on an NPU answers fast, with nonsense: "?option?option…", kit 2.65.0; the same few characters five times over is refused since kit 2.68.0), and one about a small picture when it serves vision. The first load may take minutes (OpenVINO compiles the model for the NPU), so it is given 15. Then its embedding server, started the same way, embeds three sentences (kit 2.68.0): their vectors must have the model's dimensions where the route names them, be numbers and not all zero, and put "a cat" nearer "a kitten" than "an invoice".
6. **Calibration**, on a generation nobody has run the NPU check on (`verified: false`, kit 2.68.0): two short requests more, a warm "ready" and a count to twenty (which must count), and the entry gets this PC's own timeouts from them and from how long the test request's first load took (Calibration below). One that writes under 2 tokens a second is too slow for the chat model, and isn't used.
7. **Only then** is the `npu` entry written into config.json, beside the cards'. Any failure (download, installer, pull, checksum, test, calibration) leaves no NPU entry, and the rest of setup goes on. A failure of the embedding server alone leaves the entry without embeddings.

**The NPU failing is never an error** (kit 2.68.0). Setup logs what failed as a `note:`, not a `problem:`, and its exit code doesn't count it: Manor shows nothing red, and nothing raises an alarm. Chat and embeddings fall back separately: what the NPU doesn't serve goes to a graphics card set up beside it, else setup sets the processor up for it in the same run (asking first, for its download, unless `--yes`). Why the NPU, or its embeddings, isn't used is kept in plain words (`npu-note.json` in the tools home, cleared once the NPU is set up whole) and shown with the accelerators (`smith accelerators`, the report's `npuNote`), e.g. "The NPU (Core Ultra Series 1, Meteor Lake (NPU 3720)) isn't used: it didn't answer its test in time. The graphics card or the processor does its work instead."

**The graphics card beside the NPU** (kit 2.69.0). With Manor's "Use the graphics card for models when there's an NPU" off (`gpuWithNpu`, read by `setupCommand`), a card is set up only for the work no NPU serves, the rule requests and the keeper follow (ACCELERATORS.md): beside Intel's NPU, vision alone, so the card's chat and embedding models (about 3.1 GB) aren't downloaded; the plan lists the rest as left to the NPU. What the NPU fails at setup goes to that card in the same run (its second pass, before the processor's); an NPU that fails outright leaves the card everything. A card the NPU would leave nothing (a Snapdragon's) is set up whole, as before: Manor offers the switch only beside a configured card. With the switch on, or no Manor, every card is set up for everything; turning it on later, the next Set up fills the card's other kinds in. A card set up before keeps the entries, ports and files it had for the NPU's work: nothing is removed, and the keeper keeps them out.

**Memory first** (kit 2.68.0). The NPU has no memory of its own: its models sit in the PC's, beside Windows, the browser and the manor's agents. Setup gives the NPU at most 40% of the PC's memory (`NPU_MEMORY_SHARE`), against the route's measured sizes (`memoryGb`: on Intel, chat 4.3 GB at the 4,096 cap and embeddings 1.74 GB, measured on the Lunar Lake; chat 3.6 GB at the NPU 3720's 2,048). A 16 GB PC (about 15.6 GB to Windows: 6.2 GB) keeps both, with over 9 GB left; a 12 GB PC (4.6 GB) keeps chat and makes embeddings elsewhere; an 8 GB PC (3 GB) keeps the NPU out. 40% because it lets the common 16 GB laptop keep both models with over 9 GB for everything else, while on an 8 GB PC chat alone (3.6 to 4.3 GB, half the PC) would leave Windows, a browser and the agents under 4 GB and paging. Memory that can't be read never keeps the NPU out.

An NPU entry a person configured is left alone unless `npu` is asked for by name; the GenieX entry an older install wrote by default is replaced by a set-up one, and dropped on a PC whose NPU the manor can't use.

The entry carries everything an agent and the keeper need: the server's `startCommand` (with its port), its `env` where the server needs one (OpenVINO Model Server's `PYTHONHOME` and `PATH`, as its `setupvars` script sets them), the caps, the timeouts and the quirks.

## Ports

GenieX 18181 (its default, as before), the Snapdragon's embedding server 18182, OpenVINO Model Server 18183, FastFlowLM 18184; the next free one from 18191 when a card already has it. All on 127.0.0.1.

## Caps and timeouts

Conservative where nothing has been measured. The NPU always has one slot.

| Maker | Cap (prompt and answer) | Background request | Cold load | Why |
|---|---|---|---|---|
| Qualcomm | 2,400 tokens, chat and vision | the rules' 15 s + 0.3 s a token | the rules' 90 s | measured on the X2 Elite: an ~8K prompt bluescreened it; GenieX writes ~34 tokens a second |
| Intel | 4,096 tokens, chat; 680 for embeddings (by the kit's estimate: 2,048 real tokens) | 30 s + 0.3 s a token | 180 s | OpenVINO's NPU pipeline is compiled for a prompt length (`--max_prompt_len 4096`); measured on a Lunar Lake: about 25–28 tokens a second, a first load with its compile 41 s, 3,492 tokens read in 4.5 s; room left for Meteor Lake's slower NPU, unmeasured. The embedding server is compiled for 2,048 tokens (Embeddings on Intel's NPU) |
| AMD | 4,096 tokens, chat and vision | 20 s + 0.4 s a token | 120 s | FastFlowLM takes long contexts, but unmeasured here |

A cap can differ per kind (`maxContextTokens` on an endpoint: the core's `capFor`), and an accelerator's own `timeouts` take the rules' place (the core's `requestTimeoutMs`). Only GenieX is restarted for holding too much memory (the keeper's 9 GB recycle); the others aren't known to leak.

### Per generation, where nothing has been measured

A generation in `npu-vendors.json` can carry its own `timeouts`, `maxContextTokens`, `caps`, `args` (replacing the value of a flag the route's command already has) and `memoryGb` over the route's (`routeFor`). Intel's, from the Lunar Lake's numbers and how the others compare (kit 2.68.0):

| Generation | NPU | Prompt cap | Background request | Cold load | Why |
|---|---|---|---|---|---|
| Lunar Lake | NPU 4, 48 TOPS | 4,096 | 30 s + 0.3 s a token | 180 s | measured (the route's own values, unchanged) |
| Meteor Lake, Arrow Lake | NPU 3720, about 11 TOPS | 2,048 (`--max_prompt_len 2048`) | 60 s + 0.4 s a token | 360 s | Compile and reading scale with compute, about 4 times slower: a first compile at 4,096 would take 2–3 minutes and a full 4,096 read 20–27 s. At 2,048 the compile, the full-cap read and the KV cache are halved (3.6 GB measured at 2,048 against 4.3 GB at 4,096, which matters on the 16 GB laptops these come in), and Reeve's and the agents' requests fit in it. Writing is held by memory bandwidth more than compute: 10–18 tokens a second expected, 5–8 allowed for (0.4 s a token covers 2.5). |
| Panther Lake, Wildcat Lake | NPU 5 | 4,096 | 30 s + 0.3 s a token | 240 s | Lunar Lake's, the cold load with a third more room for a new compiler. |

Embeddings keep `--max_length 2048` on every generation: the kit's 680-token estimate of a chunk (3 characters a token) undercounts hex, base64 and ids, whose 1,500-character chunks reach about 1,338 real tokens, so a shorter `max_length` would need a pessimistic estimate of about a character a token.

These are starting values only: setup's calibration replaces them on the PC, and the NPU check on one of each verifies them.

### Calibration

On a generation still `verified: false`, setup measures the NPU it has just set up and writes that PC's timeouts into its entry (`calibrate`): a token's time twice what writing one took; the base twice a full-cap read (reading taken as 10 times faster than writing: 27 times on the Lunar Lake, nearer 12 expected on the NPU 3720) and a warm answer; the cold load half again the first load it timed. Never under the generation's starting values (a busy moment doesn't shrink them), never over 1.5 s a token, a 180 s base or a 30-minute cold load. Under 2 tokens a second the NPU isn't used for chat.

## The keeper

OpenVINO Model Server opens its port within a second of starting and answers `/v1/models` with an empty list while it loads (on the NPU, compiles) its model, refusing requests until then: a server started from `ovms.exe` is ready only once it lists a model (accelerators.ts' `listsWhenLoaded`), and a request waits for it as long as the accelerator's `coldLoadMs` allows. Found by the NPU check's rehearsal, 2026-10-12.

The keeper (the Smith, else Reeve) starts and restarts each server from its entry, as it does llama.cpp's: it reads each server's address from its command line (GenieX's `--host`, OpenVINO Model Server's `--rest_port`, FastFlowLM's `--port`). It stops an orphan only when it is the manor's own: its program is in the manor's servers folders, or a record says the manor started that very process (`started.<pid>.json` beside the failure markers, written whenever a server is started). A program on one of the manor's ports for any other reason (a person's own GenieX on its default 18181, Ollama, a server whose program Windows won't name) is never stopped.

### A later kit's command

A route's command changes between kits: Intel's NPU 3720 got its 128-token prompt chunks (`--plugin_config`), and a generation its own `--max_prompt_len`. Setup leaves a configured NPU alone, so before this a PC kept the command it was set up with until someone ran setup again. On the 225U the shipped command answered a short question in 3.1 s and the chunked one in 0.5 s, with the same answers. The keeper now brings the entry up to its kit's command once for each kit version, only when nobody is using the NPU and the new command answers its test, and never takes back a newer kit's ([ACCELERATORS.md](ACCELERATORS.md), the keeper). A command that needs a download, such as a new server version or another model, is still left for setup.

### Resting when unused (kit 2.71.0)

None of the three servers can drop its model and keep running: GenieX's `--keepalive` unloads it, but the process keeps some 340 MB from every load until it exits; OpenVINO Model Server started with `--source_model` can't unload one (only its config-file mode can, by editing the file); FastFlowLM documents no unload. So the keeper stops the server, holding the NPU's turn, and the next request starts it again in its own turn. Intel's embedding server, a second OpenVINO Model Server holding 1.7 GB, is stopped with the chat server now; before 2.71.0 the keeper left every NPU embedding server but llama-server's running.

When, with no `npuIdleStopMinutes` in config.json (`npu-vendors.json`'s `idleStop`):

| PC | Stopped after |
|---|---|
| Under 20 GB of memory (8, 12 and 16 GB laptops; Windows shows 16 GB as 15.3 to 15.9) | its route's own minutes: GenieX and its llama-server 5, OpenVINO Model Server's two 5, FastFlowLM 10 |
| 20 GB or more, or memory unknown | rules.json's `npuIdleStopMinutes`, 10, as before |

A route's minutes are 20 times its cold start (stopped to its first answer), never under 5: waking it costs at most a twentieth of the quiet spell it ends, and a conversation's pauses, or an agent's rounds a minute apart, never pay it. GenieX starts and loads in 9 to 15 s (measured), so 5; OpenVINO Model Server starts from its compile cache in 4 s on a Lunar Lake (measured; the first compile is once per PC), so 5; FastFlowLM isn't measured, taken as 30 s, so 10. `npuIdleStopMinutes` in config.json (the Smith's Settings) overrides the rule on any PC, either way: 240 keeps it longer, 0 never stops it.

An idle stop never races a request: the keeper stops a server only holding the NPU's turn, joining only an empty line, so a request in flight keeps it; a request that took the NPU after the keeper's look makes it give way (its turn wasn't had at once: `TURN_AT_ONCE_MS`), and a request arriving during the stop waits its turn, then starts the server again. That first request waits for the cold start: a server just started is given the cold-load allowance for its model's load, whatever shorter timeout the caller gave (`requestBaseMs` plus the larger of rules.json's and the route's `coldLoadMs`). A caller that passes `onWaking` (the kit's `AskOptions`) is told before it waits, with a line for the person: "Waking the local AI on the NPU: it rests when nobody uses it, so the first answer takes about 4 s longer."

## Models and sizes

| Maker | Model | Kinds | Download |
|---|---|---|---|
| Qualcomm | `qualcomm/Qwen3-VL-4B-Instruct:W4A16` (Qualcomm AI Hub's NPU build) | chat, vision | 4.4 GB |
| Qualcomm | Qwen3-Embedding-0.6B Q8_0 (`Qwen/Qwen3-Embedding-0.6B-GGUF`, the graphics card's) | embeddings | 639 MB |
| Intel | `Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov` (Castellan's channel-wise INT4 export, the kind the NPU runs properly; its files pinned) | chat | 2.2 GB |
| Intel | `OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov` (OpenVINO's channel-wise INT4 export; its files pinned) | embeddings | 428 MB |
| AMD | `qwen3-it:4b` (Qwen3-4B-Instruct-2507), `qwen3vl-it:4b` (Qwen3-VL-4B-Instruct) | chat, vision | about 3.3 GB and 4.1 GB |

Plus the server: GenieX 65 MB (and llama.cpp b11125's zip, 13 MB, for its embeddings), OpenVINO Model Server 140 MB (and its Visual C++ runtime, 3 MB), FastFlowLM 40 MB.

## Licences

| What | Licence | Note |
|---|---|---|
| GenieX | BSD-3-Clause, and Qualcomm's Terms of Use | Its bundled QAIRT runtime's terms aren't stated in its NOTICE: **have it reviewed**. The installer isn't code-signed. |
| Qualcomm AI Hub's W4A16 builds | the base model's licence (Apache-2.0 for Qwen3), with AI Hub's "Usage and Limitations" | Those limitations exclude some uses (among them education, employment, law enforcement, biometrics, critical infrastructure): **have them reviewed** against Castellan's terms. |
| llama.cpp (the Snapdragon's embedding server) | MIT | Run over GenieX's own libraries, under GenieX's terms. |
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
14. **embed** (kit 2.63.0), where the route has an embedding server of its own: the kit's test embedding, the server started as every agent starts it, then a short query and a chunk of code of the size Reeve indexes, timed warm.

It ends with the caps and timeouts the numbers suggest for the route (`requestBaseMs` twice a full-cap read and a warm answer, `requestPerTokenMs` twice the time a token took, `coldLoadMs` half again the slowest start), and keeps the whole report as `npu-check-<maker>-<time>.json` in the tools home. `--no-setup` checks only what's installed.

The report names the NPU's generation (`generation`) and runs it with that generation's starting values. On a generation still `verified: false`, every step passing gives `patch` (kit 2.68.0): the change to `npu-vendors.json` that flips it to `verified: true`, with the suggested timeouts (and cap, where a request under it failed) and what they were measured on, printed and kept in the JSON report, ready to merge into the generation. A verified generation (the Lunar Lake) gets none: its values stay.

`--harden` (kit 2.68.0) checks setup's own handling on the NPU instead of measuring it: after the setup step, four steps, each passing or failing:
- **harden-driver**: a driver minimum above the installed driver: the NPU isn't used, and its note says the driver needs an update;
- **harden-timeout**: setup's test request given 1 s: no NPU entry, and its note says it didn't answer in time;
- **harden-nonsense** (on the NPU only): `OpenVINO/Qwen3-4B-int4-ov`, the group-wise export that answers nonsense on the Lunar Lake's NPU, pulled and set up in the route's model's place: no NPU entry, and its note says the chat model doesn't run properly (where it answers sensibly, nothing was forced, and the step isn't counted);
- **harden-calibrate**: setup's measuring requests, as on a generation nobody has measured: the timeouts it writes must be calibrate's from what it measured, cover what it measured, and stay inside the bounds; too slow fails on the NPU.

`--idle` (kit 2.71.0) runs the NPU's rest and waking for real instead (npu-idle.ts), the keeper given a minute's idle time; after the setup step, four steps, each passing or failing:
- **idle-wake**: a chat, and an embedding where the route has its own embedding server, asked through the kit as an agent asks; what each server holds of the PC's memory;
- **idle-stop**: the keeper's own look, on this PC's processes and the NPU's real line, stops every server once the NPU has gone unused a minute, and their processes are gone (the memory freed is said); and what the rule chooses on this PC;
- **idle-cold-answer**: a person's request after that (the interactive lane, Envoy's 20 s caption timeout) is told the local AI is waking, and answers within the route's cold load; so does an embedding. Its time is this PC's cold start, and the `idleStop` numbers it gives are printed for npu-vendors.json;
- **idle-in-flight**: a keeper's look given 1 ms of idle time, while a request holds the NPU, finds it in use and stops nothing; the request answers.

`--route intel --device CPU` rehearses Intel's route off the NPU (OpenVINO on the processor), on any PC that runs x64 programs, Windows on Arm included: its download, layout, environment, pull, serve and routes, all but the NPU. `--generation <id>` rehearses with a generation's starting values (e.g. `meteor-lake`). A rehearsal runs only with REEVE_HOME set to a scratch folder, so this PC's servers, models and locks are left alone, and never gives a patch. GenieX and FastFlowLM run on the NPU only, so they can't be rehearsed.

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
- the cap at 4,096 (2026-10-13), the NPU check passing every step: a first load 41 s, 3,112 tokens read in 4.6 s, 3,827 answered and 4,352 refused plainly, 4.3 GB;
- `OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov` on the NPU (2026-10-13), pulled by OpenVINO Model Server and served as the route's `embedServer` serves it: the card's results, beside the chat server, at `--max_length` 512, 1,024, 1,536 and 2,048 (refusing plainly what's past it);
- OpenVINO's Qwen3-VL-4B on the NPU failing in OpenVINO Model Server 2026.4.1 (`prompt_ids.get_size() >= tokenized_history.size()`), answering on the Arc: why vision stays off Intel's NPU;
- OpenVINO's `Qwen3-8B-int4-cw-ov` there too, before Castellan's 4B was made: right, at 14.8 tokens a second, a 51 s first load and 5.5 GB;
- `OpenVINO/Qwen3-4B-int4-ov`, the route's first model, answering nonsense on the NPU (right on the processor and the Arc 140V): why setup's test request now checks its answer says "ready".

**Checked from source or the release, not run**: OpenVINO Model Server 2026.4.1's zip (its SHA-256, its layout, its `/v1/models` and `/v1/chat/completions` routes in its source at that tag); FastFlowLM 1.0.7's zip (SHA-256, `flm.exe` at its root).

**Unverified on hardware**, each needing a run on a real PC:
- GenieX's silent install on a clean PC (the flags are Inno Setup's standard ones), and on a first-generation Snapdragon X (its model build and its speed);
- Intel beyond Lunar Lake: Meteor Lake, Arrow Lake, Panther Lake and Wildcat Lake (their PCI ids, speed, the driver minimum, and their starting values: setup calibrates them on each PC until the NPU check's patch verifies them);
- everything on AMD: FastFlowLM on XDNA 2, its models' names and sizes, the 4,096-token cap and timeouts, the PCI ids, the driver minimum;
- that AMD's XDNA (Phoenix, Hawk Point) is refused with the right words on a real PC;
- the keeper's restarts and idle stops of OpenVINO Model Server and FastFlowLM, and their cold starts after one (`npu-check --idle` runs both: on Intel's Lunar Lake, then AMD's XDNA 2).
