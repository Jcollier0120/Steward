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

**Embeddings** run on the Snapdragon's and Intel's NPUs, each through a server of its own (below); the NPU 3720's on the processor's graphics beside it. AMD's stay off the NPU: FastFlowLM's embedding model is EmbeddingGemma, under Gemma's terms. There they go to the graphics card, or to the processor on a PC without one: setup sets the processor up for embeddings when the NPU chats but makes none and there is no card.

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

### The NPU 3720's embeddings run on the processor's graphics

On an NPU 3720 (Core Ultra 5 225U, Arrow Lake-U, NPU driver 32.0.100.5540, 2026-10-14) the NPU is about 7 times slower than the Lunar Lake's: a query 1.1 s, a 429-token chunk 1.1 s, 1,664 tokens 2.5 s. So on `meteor-lake` the embedding server runs on the processor's graphics (the generation's `embedArgs`: `--target_device GPU`, with the same model, pooling, `--max_length` and port), which answers a query 23 times as fast and indexes 3.7 times as fast, with the NPU's vectors. Measured on the 225U's Intel Graphics (2026-10-15, two runs of each, their ranges), each server alone and then beside the chat server as the route runs it (128-token chunks, `BEST_PERF`, its prefix cache off):

| | NPU, 2,048 | NPU, 512 | Graphics, OpenVINO | Processor, OpenVINO | Graphics, llama.cpp Vulkan (setup's card) |
|---|---|---|---|---|---|
| A query (27–34 tokens) | 1.13 s | 0.27 s | 49–50 ms | 74–77 ms | 149–152 ms |
| A code chunk (398 tokens) | 1.13–1.14 s | 0.27 s | 210–214 ms | 0.59–0.60 s | 0.72–0.73 s |
| A dense chunk (UUIDs, hex, base64, JSON: 1,098–1,320 tokens) | 2.5 s | refused | 0.73–0.95 s | 2.4–3.2 s | 2.1–2.8 s |
| 16 of Reeve's chunks at once | 18.0 s | 4.0 s | 4.8 s | 13.6 s | 11.3 s |
| The first start, compiling / from the compile cache | 12.7–13.5 s / 2.3 s | 26–27 s / 1.7 s | 4.4–11.7 s / 1.7 s | 3.2 s / 1.9 s | 1.7–27 s / 1.3–1.4 s |
| Its vectors against the NPU's (cosine) | | 0.997–0.999 | 0.997–0.999 | 0.997–0.999 | 0.80–0.89 (another model's) |
| Chat's tokens a second while it indexes (13.0–13.3 alone) | 6.5–6.8 | | 13.1–13.3 | 10.0–10.6 | 12.7 |
| Its chunks a second beside chat | 0.6 | | 3.2–3.5 | 0.7 | 1.3 |
| A query while chat writes | 2.1–2.2 s | | 50–53 ms | 75–85 ms | 147–155 ms |
| The PC's memory it took, warm / its working set | 1.14–1.18 / 1.16 GB | 1.30–1.33 / 1.26–1.32 GB | 1.25–1.26 / 1.26–1.54 GB | 2.27–2.35 / 2.3–2.4 GB | 1.97–1.98 / 2.0 GB |

The same model on the graphics gives the NPU's vectors under the NPU's model name, so Reeve's index stays as it is. Beside the chat server it leaves chat alone: chat wrote as fast while 16 chunks at a time were indexed, where on the NPU the two halved each other. So its requests take the graphics' turn, not the NPU's (below), and neither waits for the other.

The rest don't do as well. A shorter `--max_length` on the NPU: this NPU runs it in 1,024-token blocks, a request of up to 1,024 tokens 1.1 s at 1,024 and at 2,048 alike (1,024 saves 4–6% and refuses Reeve's dense chunks), and 512 answers a query in 0.27 s, but refuses them too, so it would take a second server for queries (1.3 GB more), still in the NPU's turn. The processor slows chat by a fifth while it indexes, and takes twice the memory. On the graphics it takes about what it took on the NPU, inside the route's 1.74 GB (`memoryGb.embed`), and it is still counted in the NPU's share (Memory first, below): the graphics have no memory of their own either. llama.cpp's Vulkan build, setup's for a card, is slower than OpenVINO on the same graphics, with another model's vectors. The prompt-chunk setting that speeds this NPU's chat (Per generation, below) stops this server at its start (`NPUW_LLM_PREFILL_CHUNK_SIZE` 128 or 256 in its `--plugin_config`: OpenVINO Model Server exits 0xC0000409 without listing its model), so the embedding server never gets it.

Arrow Lake-S, the same NPU, keeps its embeddings on the NPU: its F models have no graphics. A PC whose graphics can't run OpenVINO (no Intel graphics driver) fails the embedding server's test request at setup, and its embeddings go to the card or the processor, as any failure of the embedding server's does (Setup, below). The check (`npu-check`) runs the embedding server where the generation has it while it checks the NPU, and moves it with chat only to the processor or the graphics.

### The NPU 3720's embeddings in the graphics' turn

The kit gives an accelerator one request at a time (its turn: ACCELERATORS.md, The lock and the line), and until now the NPU's embeddings took the NPU's, wherever their server ran. On the NPU 3720 that made a search query wait for a whole chat answer, and chat wait for an indexing batch, though the two run on different devices. Setup now writes the embedding endpoint's `turn`: the id of the Intel graphics its server runs on (`embedTurn`: OpenVINO's `GPU` is the first Intel graphics, the one sharing the PC's memory, else the first Intel card; none known, none written, and the NPU's turn as before). Its requests take the graphics' lock and line, beside the NPU's chat; a card entry on the same graphics shares that turn with them. The keeper stops the server in the graphics' turn, after the NPU route's idle minutes, and the NPU's refresh writes the turn into a PC set up before it, after the same test, holding both turns. Its failure marker, its cap and its name in an answer stay the NPU's, and so does its memory, in the NPU's share (Memory first, below). Every other generation's embeddings are on its NPU and keep the NPU's turn.

Measured through the kit's own requests on the 225U (2026-10-15), with the route's commands for `meteor-lake` on ports of their own, five times each: an agent's background chat (98 tokens) or a background batch of 16 of Reeve's chunks in one process, and a person's request (a search query, or a chat whose first token is timed) in another, sent once the background request held its turn. Before is the same entry without `turn`, as every kit until this one wrote it.

| | Before (the NPU's turn) | After (the graphics') |
|---|---|---|
| A search query, alone | 50–77 ms | 60–78 ms |
| A search query while chat writes | 6.9–7.4 s | 52–57 ms |
| Chat's first token, alone | 0.55–0.62 s | 0.54–0.60 s |
| Chat's first token while 16 chunks are indexed | 6.2–6.5 s (5.6–5.9 s of it waiting for the turn) | 0.52–0.60 s (its turn in 1–2 ms) |
| Chat's tokens a second, a 25-token answer, alone / while indexing | 12.2–13.0 / after the batch | 13.2–13.5 / 14.1–14.2 |
| The background chat's 98 tokens, a query sent meanwhile | 8.4–8.8 s | 8.0–8.5 s |
| The 16-chunk batch, chat sent meanwhile | 6.0–6.2 s, alone | 5.2 s, beside chat |

So a person searching while an agent writes is answered at once, and a person chatting while an agent indexes waits for neither; chat writes as fast beside the batch, and the batch, beside chat, isn't slower.

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

Its vectors match the card's (cosine 0.9990–0.9998 on the same texts), so it keeps the card's model name, `qwen3-embedding-0.6b-gguf`, and an index made by either serves both. Several requests at once are slower on the Hexagon, not faster (`--parallel 4`: 702 ms a chunk), so it takes one at a time. It holds 1.4 GB of the NPU's memory beside GenieX's model (604 MB model, 448 MB context, 302 MB compute; 2.9 GB through kit 2.75.0: below) and is stopped when idle, as GenieX is.

### Memory on a 16 GB Snapdragon (kit 2.75.1)

Snapdragon X and X2 PCs start at 16 GB, which Windows shows as about 15.6, and the Hexagon has no memory of its own. Windows lets one device hold about half the PC's memory at once (7.8 GB there). Through kit 2.75.0, GenieX's model and the embedding server held 6.9 GB of that between them, and their processes up to 10 GB of the PC's.

The embedding server's context and micro-batch decide most of what it holds: its compute buffer grows with `-ub` (about 0.65 MB a token, 1.3 GB at 2,048) and its KV cache with `-c` (896 MB at 8,192). Measured on the X2 Elite (2026-10-15, b11125), each setting started fresh in the NPU's turn on a private port, every request with a fresh nonce, then 100 of Reeve's chunks:

| `-c` / `-ub` | On the NPU | Working set | Private | A query | A 432-token chunk | 1,156 dense tokens | 2,707 tokens |
|---|---|---|---|---|---|---|---|
| 8,192 / 2,048 (through kit 2.75.0) | 2,876 MB | 4,383 MB | 1,567 MB | 30 ms | 118–139 ms | 399–488 ms | 1.0–1.2 s |
| 8,192 / 512 | 1,860 MB | 2,449 MB | 635 MB | 31 ms | 136 ms | 417 ms | 1.0 s |
| **4,096 / 512 (now)** | **1,408 MB** | **1,996 MB** | **629 MB** | 30 ms | 131 ms | 397 ms | 1.0 s |
| 3,072 / 512 | 1,294 MB | 1,883 MB | 628 MB | 31 ms | 133–136 ms | 402–410 ms | 1.0 s |
| 2,048 / 512 | 1,182 MB | 1,763 MB | 624 MB | 31 ms | 136–137 ms | 412–421 ms | refused |
| 2,048 / 256 | 1,032 MB | 1,471 MB | 478 MB | 30–37 ms | 139–149 ms | 376–488 ms | refused |

Every setting gave the same vectors (cosine 0.99999 or more to the old setting's, on a query, a code chunk, a dense one and a long one), and every one stayed up through inputs longer than its context, refusing them plainly (400). A smaller `-ub` costs no time: with last-token pooling an input longer than a micro-batch is read in several. The context, 4,096, keeps room for the longest input any agent sends: Reeve's cluster items, 2,000 characters and a prefix (its search chunks are 1,500, Chamberlain's and Clerk's 600). Its cap (`caps.embed`, 1,365 by the kit's estimate of 3 characters a token) keeps a request under 4,096 real tokens at one token a character, as Intel's 680 keeps one under 2,048; through kit 2.75.0 embeddings had the route's 2,400. A context of 3,072 would save another 114 MB for less room. The server starts in 1.3 to 3.0 s alone and in 1.5 to 2.2 s beside a loaded GenieX (healthy, then a first vector in 30 ms more), so `idleStop.coldStartMs.embed` is now 3,000, not the 10,000 assumed.

Beside GenieX, its model loaded and a picture read, measured together (three times, and the old setting twice): 5,646 MB on the NPU and a 7.6 GB working set, against 7,114 MB and 9.1 GB at the old setting. That was after short inputs: once it has read a long one, the embedding server's own working set grows to 4.4 GB at the old setting and to 2.0 GB at the new (the table above). These are Qualcomm's own: the embedding server's arguments, cap and cold start are the route's, and Intel's and AMD's routes, the graphics card's and the processor's llama-server, the keeper and `npuMemoryFit` are as they were.

What stays as it was, and why:
- **GenieX's own 4.2 GB on the NPU and 1.6 GB of private memory.** The private memory is the model's embedding table, 151,936 × 2,560 in float32 (1.56 GB), which GenieX 0.8.0's vision-language path reads whole (its `PrecomputedEmbeddingProvider`; the memory-mapped `QuantizedLut` in its core serves only its text-only models). Written as uint16 in the model's own input encoding it would be 0.78 GB and exact, but GenieX reads no such table: `native`, `ufixed16` and `uint16` as the table's `datatype` in the model's three configs were each ignored (2026-10-15). It needs GenieX to map the table, or take it quantized, for vision-language models.
- **GenieX's context.** AI Hub's NPU builds of Qwen3-VL-4B are compiled for 4,096 tokens only, and their KV cache is 288 MB of it, so a 2,560-token build (compiled with the owner's AI Hub account) would save perhaps 0.1 to 0.2 GB.
- **A smaller chat model.** InternVL3.5-2B (Apache-2.0, AI Hub's only smaller NPU build for X and X2) held 2.7 GB on the NPU and a 4.0 GB working set, wrote 71 tokens a second against 41, and did the benchmark's three jobs in 2.5 s against 6.2. But it answered 19 of the 24 quality items against Qwen3-VL-4B's 22, one that must pass wrong ("Sure, I'm ready." for "ready"), and the pictures as Qwen3-VL-4B did (3 of 4). Screened with the benchmark's suite on a private port, not ranked: not taken.
- **Recycling GenieX sooner on a small PC.** Each `--keepalive` unload and reload keeps 351 MB more on the NPU (4,238, 4,589 and 4,940 MB), but on a PC under 20 GB the keeper stops GenieX after 5 minutes unused, long before its keepalive (3,600 s) unloads anything, so the 9 GB recycle isn't reached there.
- **No `memoryGb` for Qualcomm.** By working set, as Intel's is measured, chat holds 5.7 GB and embeddings 2.0; at the NPU's 40% share a 16 GB PC's budget is 6.2 GB, so `npuMemoryFit` would leave embeddings off the NPU on every 16 GB Snapdragon, the room this change makes for them, and on the processor they'd hold about as much of the same memory.

Not run on a real 16 GB Snapdragon. The figures above were measured on the 48 GB X2 Elite, whose NPU's memory is counted the same way. The X2 Elite was then run with a 16 GB PC's memory (below).

**Under a 16 GB PC's memory** (2026-10-15, the X2 Elite, in a window the owner gave). A ballast process held memory, committed and written, and wrote every page again each 2 s, so that Windows had what a smaller PC has. Nine of the manor's agents were paused and its own GenieX stopped. GenieX and the embedding server then ran together on private ports in the NPU's turn: a chat (the cold load), a picture, the server's start and a query, 100 of Reeve's own chunks (from its index of the Steward), a 2,000-character input (731 tokens), and a chat, a picture and a query with both loaded. Each setting ran once at each level, with memory sampled every 2 s:

| Held, setting (`-c` / `-ub`) | NPU, both | Working set, both | Lowest available | Cold load | Embeddings healthy | A chunk, median / p90 | 2,000 characters | A chat / a picture, both loaded |
|---|---|---|---|---|---|---|---|---|
| None (the 48 GB PC as it is, three runs), 4,096 / 512 | 5,646 MB | 7.8 GB | (the PC's other work) | 8.8–9.9 s; 18.2 s once, with the PC's commit charge near its limit | 2.0–3.0 s | 132–136 / 170–175 ms | 246–264 ms | 96–139 / 317–421 ms |
| 16 GB, 9.7 GB left available: 4,096 / 512 | 5,646 MB | 7.8 GB (5.8 + 2.0) | 1.1 GB | 13.1 s | 2.0 s | 133 / 172 ms | 273 ms | 105 / 375 ms |
| 16 GB, 9.7 GB left available: 8,192 / 2,048 | 7,114 MB | 9.4 GB (5.8 + 3.6) | 1.6 GB | 14.3 s | 3.2 s | 142 / 185 ms | 345 ms | 98 / 347 ms |
| 32 GB, 15.6 GB left in all: 4,096 / 512 | 5,646 MB | 5.1 GB at most, 1.1 at the end | 0.2 GB | 17.5 s | 2.5 s | 131 / 183 ms | 244 ms | 238 / 383 ms |
| 32 GB, 15.6 GB left in all: 8,192 / 2,048 | 7,114 MB | 6.4 GB at most, 1.3 at the end | 0.06 GB | 17.1 s | 3.7 s | 133 / 187 ms | 370 ms | 304 / 450 ms |

The first level leaves about what a 16 GB Snapdragon has once Windows (about 4.5 GB) and the manor at rest (about 2 GB) are in. The second leaves 15.6 GB for everything, this PC's other programs included: about 24 GB of them were running, which Windows had to page out to make room.

- **Nothing failed** at either level or setting. Every chat, picture and embedding answered, neither server stopped, and none was refused memory. Windows grew its page file as the commit charge reached its limit (the limit went from 53.6 to 72.7 GB, the charge peaking at 72.0), as a 16 GB PC's page file grows.
- **The NPU's memory doesn't move under pressure.** GenieX held 4,238 MB and the embedding server 1,408 MB (2,876 at the old setting) at every level, as with no ballast. Windows trimmed the processes' own memory instead. At 32 GB, GenieX's working set fell from 5.8 GB to 11–350 MB between requests and the embedding server's from 2.0 GB to 0.7 GB, read back as they answered. So a chat took 240–300 ms, against 100 ms, and the cold load 17 s, against 13 s with 9.7 GB available and 9–10 s with no ballast (18 s once, with this PC's commit charge near its limit). The embeddings' times hardly moved (131–142 ms a chunk, median, at every level).
- **The new setting leaves a 16 GB PC 1.6 GB more** with both loaded: 7.8 GB against 9.4 at 9.7 GB available. Its embedding server got healthy 0.7–1.2 s sooner and read the 2,000-character input 70–130 ms faster under pressure. The PC wrote out fewer pages a second at the new setting (2,600 against 6,000 on average at 9.7 GB available, 12,700 against 13,200 at 32 GB), but those counts are the whole PC's, other work included.

What the ballast can't show:
- **The device limit.** Windows sets how much one device may hold from the memory the PC starts with (half: 23.8 GB on this PC), and a ballast doesn't change that. The 7.8 GB a 16 GB PC's NPU may hold is still worked out: 5,646 MB at the new setting is 2.2 GB under it, and 7,114 MB at the old 0.7 GB under.
- **All of the 32 GB.** A process can't hold its memory against the page file without the right to lock pages. At 32 GB Windows paged part of the ballast out as well (20.2 to 32.8 GB of it stayed resident while the servers ran), so they had somewhat more than a 16 GB PC would.

## Detection

Detection asks Windows for the devices it lists as **Neural processors** (the `ComputeAccelerator` device class, as Heiward's `NpuHardware.cs` reads it), with their maker, PnP device id and driver (`DETECT_PS`, its `npu2|…` line). A PC whose Windows lists none is asked for a Hexagon driver as before.

- **Maker**: Qualcomm (or a Hexagon name), Intel, or AMD ("Advanced Micro Devices", or AMD as a word), from the maker and the name.
- **Generation**: a Snapdragon by its name, the X2's first (`X2E`/`X2P`, "X2 Elite", "X2 Plus": `snapdragon-x2`, which covers the X2 Elite Extreme's E2E94100, X2000096 and XG002002 and the X2 Elite's EG102004 and XG201032 too), then the first X's (`X1E`/`X1P`, `X1` and five digits as the plain X's X124100, X126100 and X126101, "X Elite", "X Plus", "Snapdragon X -", and the dev kit's X1E001DE: `snapdragon-x`), then the ones before it (`snapdragon-8cx`, below). A name that doesn't say which Snapdragon (a bare "Qualcomm Hexagon NPU") is told by its ACPI device id, as Qualcomm's drivers bind them (`devices.qualcomm`: `0D0A` and `0D19` the X, `qcnspmcdm8380.inf`; `0FF0` (this laptop), `104F` and `1050` the X2, `qcnspmcdm8480.inf`); where both say, the name wins, so a Snapdragon setup doesn't know by name stays `unknown` whatever id it lists. A Hexagon seen only by its driver (the older `npu|` line, with no device id) is a Snapdragon before the X: every X and X2 lists its NPU as a Neural processor. Intel and AMD by the PCI device id (`npu-vendors.json`'s `devices`: Intel `7D1D` Meteor Lake and Arrow Lake-U (a Core Ultra 5 225U shows it, 2026-10-14: Intel's driver serves `7D1D` and `AD1D` from one NPU 3720 section; Arrow Lake-H, the same NPU, likely shows it too), `AD1D` Arrow Lake-S, `643E` Lunar Lake, `B03E` Panther Lake, `FD3E` Wildcat Lake, as Linux's ivpu driver lists them; AMD `1502` XDNA, the Ryzen 7040 and 8040, `17F0` XDNA 2). Anything else from a known maker is `unknown`, tried on guessed values (below).
- **Supported** or not, and why, in plain words: a maker setup doesn't know, a generation no server runs language models on (AMD's first XDNA: no NPU server supports it, and AMD's own Lemonade says none plans to; the Snapdragons before the X, below), an NPU driver older than the server needs (Intel 32.0.100.4023, as Intel's NPU model cards for OpenVINO 2026 state, and 32.0.100.5540 on Panther Lake and Wildcat Lake, where OpenVINO 2026.2–2026.4 may crash with older drivers (its known issue CVS-233822); AMD 32.0.203.311; a generation's own `driverMin` comes first), or a server built for the other processor (GenieX is Arm64 only; OpenVINO Model Server and FastFlowLM are x64 only).

An NPU the manor can't use is still recorded in `hardware.json` as an NPU (so a model is never called the NPU on it falsely), and setup says why it isn't set up; its work goes to the graphics card or the processor. `accelerators` (the report) shows the maker, generation, driver and the reason.

### The Snapdragons before the X

The 8cx (Gen 1 to 3), 8c, 7c and 7c+, Microsoft's SQ1 to SQ3, the 850 and the 835 are `snapdragon-8cx` (kit 2.74.7), `supported: false`, and refused by name before anything is downloaded: "the Snapdragon 8cx, 8c, 7c, SQ1–SQ3, 850 or 835 (Hexagon v68 or older) NPU can't run the manor's models: GenieX and Qualcomm AI Hub's model builds cover only the Snapdragon X and X2 (Hexagon v73 and v81), and llama.cpp's Hexagon backend runs at least v73 code, which an older Hexagon can't". Until then such a PC was tried on guessed values, and downloaded GenieX and its 4.4 GB model before its test request could fail. A Snapdragon newer than setup knows (an X3, say) is still tried on guessed values, not refused.

### A known maker's NPU of a generation setup doesn't know

A new NPU from Qualcomm, Intel or AMD whose PCI id (or Snapdragon name) isn't in `npu-vendors.json` used to be refused ("isn't one setup knows yet"), though its maker's server most likely runs on it. It is now **tried**, on guessed values. Its generation is `unknown` (`UNKNOWN_GENERATION`), which no catalog stores: `unknownGeneration` works it out from the route's supported generations, the most cautious of each (all through `routeFor`):

- **the smallest cap** of any of them, never over the route's, with that generation's `args` (so OpenVINO's `--max_prompt_len` and prompt chunks match the cap: the NPU 3720's 2,048 and 128 on Intel, with its `BEST_PERF`), and each kind's cap at most that;
- **the longest timeouts and cold load**, each on its own, never under the route's own, its values for a generation nobody measured (Intel: Arrow Lake-S's 60 s + 0.4 s a token and 360 s; AMD: the route's 20 s + 0.4 s a token and 120 s, not XDNA 2's measured 0.15 s a token and 30 s);
- **the most memory** per kind (`memoryGb`), so the memory check is the strictest;
- **the latest driver minimum** (Intel: Panther Lake's 32.0.100.5540, so an unknown Intel NPU needs it; AMD: the route's 32.0.203.311).

On AMD it is XDNA 2's cap with the route's own timeouts, on Qualcomm the route's: **its 2,400-token cap is never raised** (an ~8K prompt bluescreened the X2 Elite), whatever a generation might carry. It is `verified: false` and `guessed: true`, so setup's test request (it must answer "ready", nothing degenerate) and calibration (under 2 tokens a second isn't used) decide whether the NPU is kept, as on any unverified generation; the arch and driver checks still apply. Its label says so: "AMD NPU of a generation setup doesn't know yet, device 17F1".

Still refused: a maker setup doesn't know; AMD's first XDNA (`1502`, Phoenix and Hawk Point), which `devices` names and no server runs; the Snapdragons before the X (above); a route with no supported generation to take values from.

When it passes, its note says so in plain words, kept in `npu-note.json` and shown by `accelerators` (the report's `npuNote`): "The NPU (Intel NPU of a generation setup doesn't know yet, device ABCD) runs on guessed values: setup gave it the most cautious cap it has (2,048 tokens) and this PC's own timeouts, measured. It passed its test, so it's used; a kit update that knows this NPU may change them." The plan and the report add "(tried on guessed values, the most cautious it has, and kept only if it passes its test)". When it fails, the note is the usual "isn't used" one. The NPU check (below) is how such an NPU gets values of its own.

**FastFlowLM's `flm validate` was looked at as AMD's compatibility check, and isn't one** (read from FastFlowLM 1.0.7's source and `flm.exe`, not run: another session held the NPU). On Windows it asks WMI for `VEN_1022&DEV_17F0` alone, so any other PCI id is "no AMD device found"; its driver check compares only the driver version's fourth part against 32.0.203.304's; and its `--json` is `{"object":"npu_stack_validation","platform":"windows","amd_device_found":…,"npu_driver_ok":…,"ready":…}`. It would refuse exactly the NPUs this tries, so setup's test request decides instead. (`flm serve` also runs `xrt-smi configure --pmode` as it starts.)

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

**The NPU failing is never an error** (kit 2.68.0). Setup logs what failed as a `note:`, not a `problem:`, and its exit code doesn't count it: Manor shows nothing red, and nothing raises an alarm. Chat and embeddings fall back separately: what the NPU doesn't serve goes to a graphics card set up beside it, else setup sets the processor up for it in the same run (asking first, for its download, unless `--yes`). Why the NPU, or its embeddings, isn't used is kept in plain words (`npu-note.json` in the tools home, cleared once the NPU is set up whole) and shown with the accelerators (`smith accelerators`, the report's `npuNote`), e.g. "The NPU (Core Ultra Series 1 or 200U, Meteor Lake or Arrow Lake-U (NPU 3720)) isn't used: it didn't answer its test in time. The graphics card or the processor does its work instead."

**The graphics card beside the NPU** (kit 2.69.0). With Manor's "Use the graphics card for models when there's an NPU" off (`gpuWithNpu`, read by `setupCommand`), a card is set up only for the work no NPU serves, the rule requests and the keeper follow (ACCELERATORS.md): beside Intel's NPU, vision alone, so the card's chat and embedding models (about 3.1 GB) aren't downloaded; the plan lists the rest as left to the NPU. What the NPU fails at setup goes to that card in the same run (its second pass, before the processor's); an NPU that fails outright leaves the card everything. A card the NPU would leave nothing (a Snapdragon's) is set up whole, as before: Manor offers the switch only beside a configured card. With the switch on, or no Manor, every card is set up for everything; turning it on later, the next Set up fills the card's other kinds in. A card set up before keeps the entries, ports and files it had for the NPU's work: nothing is removed, and the keeper keeps them out.

**Memory first** (kit 2.68.0). The NPU has no memory of its own: its models sit in the PC's, beside Windows, the browser and the manor's agents. Setup gives the NPU at most 40% of the PC's memory (`NPU_MEMORY_SHARE`), against the route's measured sizes (`memoryGb`: on Intel, chat 4.3 GB at the 4,096 cap and embeddings 1.74 GB, measured on the Lunar Lake; chat 3.8 GB at the NPU 3720's 2,048, its prefix cache off). A 16 GB PC (about 15.6 GB to Windows: 6.2 GB) keeps both, with over 9 GB left; a 12 GB PC (4.6 GB) keeps chat and makes embeddings elsewhere; an 8 GB PC (3 GB) keeps the NPU out. 40% because it lets the common 16 GB laptop keep both models with over 9 GB for everything else, while on an 8 GB PC chat alone (3.8 to 4.3 GB, half the PC) would leave Windows, a browser and the agents under 4 GB and paging. Memory that can't be read never keeps the NPU out.

An NPU entry a person configured is left alone unless `npu` is asked for by name; the GenieX entry an older install wrote by default is replaced by a set-up one, and dropped on a PC whose NPU the manor can't use.

The entry carries everything an agent and the keeper need: the server's `startCommand` (with its port), its `env` where the server needs one (OpenVINO Model Server's `PYTHONHOME` and `PATH`, as its `setupvars` script sets them), the caps, the timeouts and the quirks.

## Ports

GenieX 18181 (its default, as before), the Snapdragon's embedding server 18182, OpenVINO Model Server 18183, FastFlowLM 18184; the next free one from 18191 when a card already has it. All on 127.0.0.1.

## Caps and timeouts

Conservative where nothing has been measured. The NPU always has one slot.

| Maker | Cap (prompt and answer) | Background request | Cold load | Why |
|---|---|---|---|---|
| Qualcomm | 2,400 tokens, chat and vision; 1,365 for embeddings (by the kit's estimate: 4,096 real tokens) | the rules' 15 s + 0.3 s a token | the rules' 90 s | measured on the X2 Elite: an ~8K prompt bluescreened it; GenieX writes ~34 tokens a second. The embedding server's context is 4,096 tokens (Memory on a 16 GB Snapdragon) |
| Intel | 4,096 tokens, chat; 680 for embeddings (by the kit's estimate: 2,048 real tokens) | 30 s + 0.3 s a token | 180 s | OpenVINO's NPU pipeline is compiled for a prompt length (`--max_prompt_len 4096`); measured on a Lunar Lake: about 25–28 tokens a second, a first load with its compile 41 s, 3,492 tokens read in 4.5 s; the NPU 3720's own values are its generations' (below). The embedding server is compiled for 2,048 tokens (Embeddings on Intel's NPU) |
| AMD | 4,096 tokens, chat and vision | 20 s + 0.4 s a token; XDNA 2's own 20 s + 0.15 s | 120 s; XDNA 2's own 30 s | FastFlowLM holds its whole context from its start, so it is started with the cap (`--ctx-len 4096`): its own default, the model's 40,960 tokens, never loaded on a 16 GB Krackan (below). Measured there: about 14 tokens a second, 3,115 tokens read in 6.6 s, a start to a first answer 4 to 16 s, 3,827 answered and 4,352 refused plainly |

A cap can differ per kind (`maxContextTokens` on an endpoint: the core's `capFor`), and an accelerator's own `timeouts` take the rules' place (the core's `requestTimeoutMs`). Only GenieX is restarted for holding too much memory (the keeper's 9 GB recycle); the others aren't known to leak.

### Per generation, where nothing has been measured

A generation in `npu-vendors.json` can carry its own `timeouts`, `maxContextTokens`, `caps`, `args` (replacing the value of a flag the route's command already has) and `memoryGb` over the route's (`routeFor`). Intel's, from the Lunar Lake's numbers and how the others compare (kit 2.68.0):

| Generation | NPU | Prompt cap | Background request | Cold load | Why |
|---|---|---|---|---|---|
| Lunar Lake | NPU 4, 48 TOPS | 4,096, read 512 tokens at a time | 30 s + 0.3 s a token | 180 s | Measured (the route's own values), its prompt settings estimated from the NPU 3720 (Estimated, below): 512-token chunks, `BEST_PERF`, the prefix cache off. |
| Meteor Lake, Arrow Lake-U (`7D1D`) | NPU 3720, about 11 TOPS | 2,048 (`--max_prompt_len 2048`), read 128 tokens at a time | 15 s + 0.2 s a token | 120 s | Measured (Verified, below): 12.3–13.1 tokens a second written (`BEST_PERF`), about 1,730 read in 6.3–6.5 s, a first load with its compile 57–69 s, 3.8 GB with the prefix cache off. At 3,072 it held 0.4 GB more and read 5–10% slower; at 4,096, 1.0 GB more, too much beside the embedding server on the 16 GB laptops these come in, and Reeve's and the agents' requests fit in 2,048. Its embeddings run on the processor's graphics (`embedArgs`: The NPU 3720's embeddings, above). |
| Arrow Lake-S (`AD1D`) | NPU 3720 | 2,048, read 128 tokens at a time | 60 s + 0.4 s a token | 360 s | The same NPU as Arrow Lake-U, with its prompt settings and memory, but not yet run: the generous starting values stay until the NPU check runs on one. |
| Panther Lake | NPU 5, 50 TOPS | 4,096, read 512 tokens at a time | 30 s + 0.3 s a token | 240 s | Lunar Lake's, with its estimated prompt settings, the cold load with a third more room for a new compiler. |
| Wildcat Lake | NPU 5, 15–17 TOPS | 2,048, read 128 tokens at a time | 30 s + 0.3 s a token | 240 s | Panther Lake's timeouts; the NPU 3720's prompt settings and memory, estimated (below): its NPU is about 1.4 times the NPU 3720, in laptops of 8 to 16 GB. |

Embeddings keep `--max_length 2048` on every generation: the kit's 680-token estimate of a chunk (3 characters a token) undercounts hex, base64 and ids, whose 1,500-character chunks reach about 1,338 real tokens, so a shorter `max_length` would need a pessimistic estimate of about a character a token.

**The NPU 3720 reads a prompt 128 tokens at a time** (`--plugin_config {"NPUW_LLM_PREFILL_CHUNK_SIZE":"128"}`). OpenVINO's NPU pipeline reads a prompt in chunks of 1,024 tokens unless told otherwise, and every chunk costs its whole length: on the NPU 3720 a one-line question took 3.1 s, the time of a 1,024-token read. In chunks of 128 it took 0.5 s, 1,550 tokens were read in 4–6.4 s against 7 s, the first compile was a few seconds shorter and the memory 0.2 GB less, with the same answers word for word (Core Ultra 5 225U, 2026-10-14; 256 gave 0.77 s and 512 1.37 s). `PERFORMANCE_HINT` `LATENCY` already holds. The route's command carries `--plugin_config {}` (OpenVINO Model Server's graph is the same as without it) so a generation's `args` can replace it, and `--enable_prefix_caching false` (below); off the NPU both are dropped with the other NPU-only flags, so the graphics card and processor keep OpenVINO's own. The other generations' chunks are estimated from these (Estimated, below).

**It writes with `GENERATE_HINT` `BEST_PERF`, its prefix cache off** (`{"NPUW_LLM_PREFILL_CHUNK_SIZE":"128","GENERATE_HINT":"BEST_PERF"}`, and the route's `--enable_prefix_caching false`), from 20 quick benchmarks on the Core Ultra 5 225U (2026-10-14) and 11 more on `castellan-npu-bench/2` (NPU-BENCHMARK.md), whose reads and jobs are prompts no cache has seen (2026-10-15):
- `BEST_PERF` wrote 12.3–13.1 tokens a second against 9.3–11.2, and the benchmark's jobs took 27.3–28.0 s against 29.1–35.6 (with any cache setting), with the same answers. Reads of 512, 1,024 and about 1,730 tokens took 2.2–2.3, 3.4–3.5 and 6.3–6.5 s. Its first compile takes 56.5–68.7 s against 25.8–28.9, once per PC and driver (the compile cache keeps it): hence the 120 s cold load.
- OpenVINO Model Server 2026.4.1 turns the NPU's prefix caching on by itself (`--enable_prefix_caching` defaults to true; its graph carries `NPUW_LLM_ENABLE_PREFIX_CACHING`), so whole 128-token blocks of a prompt seen before aren't read again: a repeated 512-token read takes about 0.7 s against 2.3. But the agents' prompts share only their system prompt at the start, 25–90 tokens, less than a block (Aletaster's, about 150–190, alone clear one, and nothing 256), so a cache is hardly ever hit. When nothing hits it costs: with `BEST_PERF`, the cache off read 2–5% faster and did the jobs in 27.25–27.48 s against 27.67–28.01 with 32 blocks (two runs each, never overlapping), and the server held 3.72 GB at the benchmark's end against 4.30 GB with 32 blocks and 5.98 GB with OpenVINO Model Server's 128. So it is off: `memoryGb` is 3.8. Suite 1 had the cache saving time (the jobs 32.4 s without it, against 26–27.8) because it timed prompts the cache had already seen. It has to be the server's flag: with `NPUW_LLM_ENABLE_PREFIX_CACHING` in `--plugin_config`, OpenVINO Model Server refuses the graph ("Doubled NPUW_LLM_ENABLE_PREFIX_CACHING parameter"), writing that key itself from the flag, and never loads.
- Prompt chunks (suite 1), against prompts no cache had seen: 64 tokens answered short in 0.35 s but read 1,740 tokens in 8.1 s; 128 in 0.5 and 6.3 s; 256 in 0.78 and 6.0 s; 512 in 1.43 and 6.4 s; OpenVINO's 1,024 in 3.1 and 6.9 s. 128 stays.
- No faster: `PREFILL_HINT` `STATIC` (every prompt 7.4 s, the full 2,048 each time), `NPUW_LLM_PREFILL_ATTENTION_HINT` `STATIC` (reads 15–20% slower, a 21 s compile), `NPU_TURBO`.

These are starting values only: setup's calibration replaces them on the PC, and the NPU check on one of each verifies them.

### Estimated, for the Intel NPUs no one will run

The Lunar Lake and this Arrow Lake-U's NPU 3720 are the only Intel NPUs there are to run (the owner, 2026-10-15). So the other generations' prompt settings (chunks, `GENERATE_HINT`, the prefix cache, the cap) are estimated from the NPU 3720's sweep, scaled by the Lunar Lake's own numbers. Setup still calibrates each unverified generation's timeouts on the PC; nothing calibrates these settings.

- **A chunk costs a fixed part and a part for each of its tokens.** On the NPU 3720 at a 2,048-token cap, a chunk of c tokens took about 110 ms + 2.34 ms × c: 0.26 s at 64, 0.41 s at 128, 0.71 s at 256 and 1.31 s at 512. A 1,024-token chunk cost more, 3.0 s. A prompt costs whole chunks, and later chunks of a long prompt 10–20% more. That fits the sweep's short answers, and its reads of 512 to 1,740 tokens no cache had seen, to within about 20%. A 4,096-token cap added about 5%.
- **The NPU 4 is about four times as fast.** The Lunar Lake read a 1,024-token chunk in 0.68 s (a short answer, 0.72 s) against the NPU 3720's 3.0 s, and two in 1.79 s against 7.0 s: 0.23 to 0.26 of the time. Whether its fixed part is faster too isn't known, so both cases are taken: (A) all of it four times as fast, and (B) the fixed part the NPU 3720's 110 ms.
- **The NPU 3720's choice, carried over.** It took 128-token chunks over 256, for a short prompt's one chunk in 0.41 s rather than 0.71 s, though 256 and 512 read long prompts a little faster. So for each NPU, among the chunks one of which takes no longer than that, the pick is the one that reads the jobs' prompts fastest (NPU-BENCHMARK.md's three, about 290, 900 and 850 tokens with the chat template).

| A short prompt's chunk / the three jobs' prompts | 128 | 256 | 512 | 1,024 (OpenVINO's) | Pick |
|---|---|---|---|---|---|
| NPU 3720 (the fit) | 0.41 s / 7.4 s | 0.71 / 7.1 | 1.31 / 6.5 | 3.0 / 9.0 | 128 |
| NPU 4, and Panther Lake's NPU 5 (A) | 0.10 / 1.8 | 0.17 / 1.7 | 0.32 / 1.6 | 0.73 / 2.2 | 512 |
| the same (B) | 0.18 / 3.3 | 0.26 / 2.6 | 0.40 / 2.0 | 0.82 / 2.5 | 512 |
| Wildcat Lake's NPU 5, 16 TOPS (A, B) | 0.29–0.33 / 5.3–5.9 | 0.51–0.54 / 5.1–5.4 | 0.94–0.97 / 4.7–4.9 | 2.2 / 6.5 | 128 |

- **Lunar Lake and Panther Lake read in 512-token chunks.** Panther Lake's NPU 5 is 50 TOPS, about the NPU 4's 48. Against OpenVINO's 1,024 that should give a short prompt in 0.3–0.4 s rather than 0.72 s, and the jobs' prompts 18–27% faster, in either case. Their cap stays at 4,096, as measured on the Lunar Lake.
- **Wildcat Lake gets the NPU 3720's settings.** Its NPU 5 is 15–17 TOPS (the Core 3 304 to the Core 7 360), about 1.4 times the NPU 3720, so it reads in 128-token chunks. It also comes in low-cost laptops of 8 to 16 GB, so it gets the NPU 3720's 2,048-token cap and memory.
- **The NPU 3720 at the 4,096-token cap bears the chunks out** (suite 2, one quick run each, 2026-10-15). A short answer took 0.53 s in 128-token chunks, 0.83 in 256, 1.43 in 512 and 3.12 in OpenVINO's 1,024; about 3,500 tokens took 15.0–15.8, 13.5–14.0, 12.9–13.3 and 16.2–16.6 s. 512 reads long prompts fastest there too, and 1,024 loses everywhere.
- **`BEST_PERF` on every generation.** It is the compiler's effort on the model that writes, which made the NPU 3720 write 30% faster at the 4,096 cap (13.0–13.3 tokens a second against 10.09) and about 25% at 2,048. It doubles the first compile, 80–90 s against 42 at the 4,096 cap: on the Lunar Lake that takes 31–41 s now, so 60–90 s, inside every generation's cold load.
- **The prefix cache is off on every generation**, the route's own command (an Intel NPU setup doesn't know too). Whether a cache is hit depends on the prompts, not the NPU, and the agents' share less than a block. At the 4,096 cap on the NPU 3720 it held 0.42–0.58 GB more and read no faster (1–5% slower near the cap); at OpenVINO Model Server's own 128 blocks the server reached 6.17 GB, alone near a 16 GB PC's 6.2 GB for chat and embeddings together. The Lunar Lake keeps its measured 4.3 GB until it is run with the cache off.

A quick benchmark on the Lunar Lake (NPU-BENCHMARK.md) would check its estimate. Its report, set against the Lunar Lake's first run on suite 2, says whether to keep it.

### Calibration

On a generation still `verified: false`, setup measures the NPU it has just set up and writes that PC's timeouts into its entry (`calibrate`): a token's time twice what writing one took; the base twice a full-cap read and a warm answer, reading taken as the route's `readPerWrite` times faster than writing, else 10 (27 times on the Lunar Lake, nearer 12 expected on the NPU 3720; AMD's route says 30, FastFlowLM having read 34 to 36 times faster on a Krackan); the cold load half again the first load it timed. Never under the generation's starting values (a busy moment doesn't shrink them), never over 1.5 s a token, a 180 s base or a 30-minute cold load. Under 2 tokens a second the NPU isn't used for chat.

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
| Under 20 GB of memory (8, 12 and 16 GB laptops; Windows shows 16 GB as 15.3 to 15.9) | its route's own minutes: GenieX and its llama-server 5, OpenVINO Model Server's two 5, FastFlowLM 5 (6 for its vision model) |
| 20 GB or more, or memory unknown | rules.json's `npuIdleStopMinutes`, 10, as before |

A route's minutes are 20 times its cold start (stopped to its first answer), never under 5: waking it costs at most a twentieth of the quiet spell it ends, and a conversation's pauses, or an agent's rounds a minute apart, never pay it. GenieX starts and loads in 9 to 15 s (measured), so 5, and its llama-server answers in 2 to 3 s (measured; through kit 2.75.0 taken as 10 s), so 5; OpenVINO Model Server starts from its compile cache in 4 s on a Lunar Lake and 6.9 s on an NPU 3720, its embeddings in 2.8 s there (measured; the first compile is once per PC), so 5; FastFlowLM starts and loads its chat model in 6.6 s on an XDNA 2 (measured), so 5, and its vision model, its switch from chat included, in 15.7 s, so 6 (through kit 2.74.4 it wasn't measured, taken as 30 s, so 10). `npuIdleStopMinutes` in config.json (the Smith's Settings) overrides the rule on any PC, either way: 240 keeps it longer, 0 never stops it.

An idle stop never races a request: the keeper stops a server only holding the NPU's turn (the NPU 3720's embedding server, the graphics': its requests' turn, above), joining only an empty line, so a request in flight keeps it; a request that took the NPU after the keeper's look makes it give way (its turn wasn't had at once: `TURN_AT_ONCE_MS`), and a request arriving during the stop waits its turn, then starts the server again. That first request waits for the cold start: a server just started is given the cold-load allowance for its model's load, whatever shorter timeout the caller gave (`requestBaseMs` plus the larger of rules.json's and the route's `coldLoadMs`). A caller that passes `onWaking` (the kit's `AskOptions`) is told before it waits, with a line for the person: "Waking the local AI on the NPU: it rests when nobody uses it, so the first answer takes about 4 s longer."

### The embedding server gives way to chat (kit 2.77.5)

On a PC under 20 GB, with no `npuIdleStopMinutes` in config.json, a chat or vision request on the NPU first stops the NPU's own embedding server when the NPU hasn't answered an embedding for 30 s. That is Qualcomm's llama-server (18182) or Intel's second OpenVINO Model Server (18186). The chat gets its memory: on a Snapdragon, 1,408 MB of the NPU's and a 1.7 to 2.0 GB working set; on Intel, 1.7 GB. Only the embedding side gives way. It starts again for the next embedding in 2 to 3 s, where GenieX takes 9 to 17 s to load a model.

- **In the chat's own turn**, so no embedding is in flight (the kit's `embedGivesWay`, with keeper.ts' `yieldEmbedServer`):
  - It looks at the server's `/v1/models`, and stops it only when it answers ready. A server still loading is left alone.
  - It finds the server by its program and the address its command line serves, never by the port alone, then waits up to 10 s for the port to close.
  - Finding the processes may take 5 s. Past that, or on any error, the chat goes on beside the server.
  - Each stop is written in the keeper's log.
- **When the NPU last answered an embedding**: every agent writes `<accelerators>/<id>.embedded.json` (`{at}`) after its embeddings there, at most every 5 s. With no record, the server counts as unused.
- **Never stopped**:
  - FastFlowLM's route, which has no NPU embeddings.
  - npu-embed, which exits by itself.
  - A server shared with chat.
  - A server whose requests take another device's turn.
  - Anything on a bigger PC, which never loads this code.

**Why 30 s.** The manor's NPU and graphics-card turns were watched for two hours on the 48 GB X2 Elite (2026-10-15, 20:48 to 22:48 UTC). They were merged onto one NPU, as on a 16 GB Snapdragon where chat and embeddings both run on it. Tests and other sessions' benchmark runs were left out. That left 3,525 embeddings and 17 chats:

- **Embeddings**: Reeve indexing four repositories, plus 35 searches and maps for Claude.
- **Chats**: Reeve's map, triage and summarize for Claude, Heiward, Porter, and two unnamed.

The embedding server's own 5-minute idle stop started it again 4 times (2 an hour). Giving way to chat adds:

| Gives way | Extra starts in 2 h | An hour |
|---|---|---|
| At every chat | 8 | 4 |
| After 10 s without an embedding | 5 | 2.5 |
| After 30 s | 2 | 1 |
| After 60 s | 2 | 1 |
| After 120 s | 1 | 0.5 |

At every chat, 5 of the 8 extra starts fell on Reeve's requests for Claude a second or so after its map or summary, and the other 3 on an index being built between chats. With 30 s, 2 remain: chats more than half a minute after the last embedding. Counting the benchmark sessions, it's 8 an hour at every chat and 2 an hour with 30 s.

**Measured** on the X2 Elite on private ports (28181 GenieX, 28182 llama-server, `-c 4096 -ub 512`). Every request went through the kit's `Npu` in the NPU's turn, as a 15.6 GB PC would run it:

| | |
|---|---|
| The embedding server's cold start, alone / beside a loaded GenieX | 3.6 s / 1.7 s (twice) |
| An embedding, warm | 16 ms |
| A warm chat that stops the embedding server / with nothing to stop | 0.47 to 0.63 s (the stop 0.35 to 0.53 s, mostly finding the process) / 0.10 s |
| A cold chat that stops it | 12.3 s (the stop 0.7 s) |
| The NPU's memory when it stops | 1,409 MB less (10,152 to 8,743 MB) |
| The PC's memory when it stops | the server's 1,680 MB working set freed, 1.4 GB more available |

So a chat that finds the embedding server idle pays about half a second once, and the next embedding about 1.7 s. On an NPU 3720, whose embedding server runs on the processor's graphics (`embedArgs`), the server gives way too while its requests take the NPU's turn: an entry set up before the graphics' turn, until its refresh writes one. That frees the PC's memory rather than the NPU's. With its `turn`, it answers beside the chat instead and is never stopped for it ([The NPU 3720's embeddings in the graphics' turn](#the-npu-3720s-embeddings-in-the-graphics-turn)).

## Models and sizes

| Maker | Model | Kinds | Download |
|---|---|---|---|
| Qualcomm | `qualcomm/Qwen3-VL-4B-Instruct:W4A16` (Qualcomm AI Hub's NPU build) | chat, vision | 4.4 GB |
| Qualcomm | Qwen3-Embedding-0.6B Q8_0 (`Qwen/Qwen3-Embedding-0.6B-GGUF`, the graphics card's) | embeddings | 639 MB |
| Intel | `Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov` (Castellan's channel-wise INT4 export, the kind the NPU runs properly; its files pinned) | chat | 2.2 GB |
| Intel | `OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov` (OpenVINO's channel-wise INT4 export; its files pinned) | embeddings | 428 MB |
| AMD | `qwen3.5:2b` (Qwen3.5-2B, FastFlowLM's NPU2 build) | chat, vision | 2.0 GB |

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
| Qwen3-4B-Instruct-2507, Qwen3-VL-4B-Instruct, Qwen3-Embedding-0.6B, Qwen3.5-2B | Apache-2.0 | |
| Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov, on Hugging Face | Apache-2.0, the base model's | Castellan's own export, so Castellan publishes this one: with the base model's LICENSE, and a model card saying what was changed (the weights converted and compressed, nothing else) and how, as Apache-2.0 asks. |
| Avoided | Llama 3.2 (community licence), Gemma and EmbeddingGemma (Gemma's terms flow down to users), AMD's Ryzen AI ONNX runtime (AMD's software licence) | Not installed by setup. |

Each customer's PC downloads the servers, runtimes and models from their makers (GitHub releases, Microsoft, Hugging Face, Qualcomm AI Hub); Castellan doesn't redistribute them, except Intel's NPU model, its own export, which it publishes on Hugging Face as Castellan-AI.

## The NPU check (on a new maker's hardware)

`node <agent>\src\kit\npu-check.ts --yes` (kit 2.60.0; the kit as an agent carries it, e.g. Manor's `%USERPROFILE%\.manor\app\src\kit\npu-check.ts`) runs everything below that hasn't run on real hardware, on the PC's own NPU, and measures it. It writes no config.json and leaves nothing running:

1. **detect**: the NPU's name, maker, generation, PCI device id and driver, and whether the manor can use it. An NPU of a generation setup doesn't know is run on its guessed values ("… on guessed values, the most cautious its route has"), and its PCI id is printed, ready to add to `devices` (`{"devices":{"amd":{"17F1":"amd-17f1"}}}`, also the report's `unknownDevice`); a Snapdragon, which has none, is told by its name, in `npuGeneration`, or where its name doesn't say, by its ACPI id in `devices.qualcomm` (the line prints it).
2. **requirements**: what the route needs besides itself, and that setup brings it (the Visual C++ runtime beside OpenVINO Model Server).
3. **setup**: the server downloaded, checked and installed, and its models pulled, as setup does them, each step timed.
4. **start**: the server started from its entry, and the time until it answers `/v1/models`.
5. **first-answer**: the first chat answer, and the whole first load (OpenVINO's compile for the NPU) from the start. The measurements compile in a cache of their own, `.check-cache` beside the manor's `.npu-cache`, emptied before the first start (`checkServe`), so this is a real compile, as on a PC that has never run the model or after a driver update; `--idle` and `--harden` keep the manor's cache. From the manor's warm cache, an NPU 3720 whose compile took 30–48 s answered first in 9 s, and the check suggested a 30 s cold load (2026-10-14).
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

The report names the NPU's generation (`generation`) and runs it with that generation's starting values. On a generation still `verified: false`, every step passing gives `patch` (kit 2.68.0): the change to `npu-vendors.json` that flips it to `verified: true`, with the suggested timeouts (and cap, where a request under it failed) and what they were measured on, printed and kept in the JSON report, ready to merge into the generation. A verified generation (the Lunar Lake) gets none: its values stay. On an NPU of a generation setup doesn't know, every step passing gives a patch that adds it: its PCI id to `devices` as a new generation, `<maker>-<pci id>` (`amd-17f1`), verified, on the guessed values it ran with and the timeouts measured (its label, "AMD NPU, device 17F1", wants its processors' name before it's merged). A Snapdragon of a new generation gets none: it is told by its name, in code.

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

`--route intel --device CPU` rehearses Intel's route off the NPU (OpenVINO on the processor), on any PC that runs x64 programs, Windows on Arm included: its download, layout, environment, pull, serve and routes, all but the NPU. `--generation <id>` rehearses with a generation's starting values (e.g. `meteor-lake`, or `unknown` for the guessed ones). A rehearsal runs only with REEVE_HOME set to a scratch folder, so this PC's servers, models and locks are left alone, and never gives a patch. GenieX and FastFlowLM run on the NPU only, so they can't be rehearsed off it; an older Snapdragon is played on a newer one instead (below).

On the NPU itself, `--generation <id>` of another generation runs that generation on this NPU, a rehearsal that gives no patch. On Intel and AMD that is its starting values alone (the Lunar Lake standing in for an NPU 3720): their servers build for the NPU they find, so nothing else of the other generation can be run.

### Playing an older Snapdragon on a newer one

On a Snapdragon X2, `--generation snapdragon-x` (kit 2.74.7) plays the first X whole, its model build and its Hexagon code (`playGeneration`, `playedRoute`):

- **GenieX on a data folder of its own**, `{tools}\played\snapdragon-x\geniex` (GenieX's `--data-dir` before its command, and `GENIEX_DATADIR`), whose `config.json` names the X to Qualcomm AI Hub, `{"chipset": "qualcomm-snapdragon-x-elite"}`. GenieX pulls and serves AI Hub's X Elite build there (v73 context binaries), checked against `pinned["snapdragon-x"]` in that folder. The real cache, `%USERPROFILE%\.cache\geniex`, and its X2 build are left alone.
- **The embeddings on the X's Hexagon code**: the embedding server is started with `GGML_HEXAGON_ARCH=v73`, so llama.cpp's Hexagon backend loads `libggml-htp-v73.so`, as on an X, in place of the v81 library it finds. The variable is never set empty, which llama.cpp would read as arch 0.

Each Snapdragon generation's `hexagonArch` (`v73`, `v81`) and `aiHubChipset` in `npu-vendors.json` say how it's played. The report's `played` names the generation, the folder, the chip and the Hexagon code, and the run is a rehearsal: no patch. The numbers are the X's code on the X2's NPU, never the X's speed (45 TOPS against the X2's 80) or memory pressure.

It refuses before anything is set up: a newer Snapdragon on an older one (`snapdragon-x2` on an X, whose v73 Hexagon can't run v81 code), `snapdragon-8cx` (no server runs it), and a generation the route hasn't. `npu-bench --generation snapdragon-x` plays it the same way. Its report says `run.played`, carries a `played` mark and is never ranked; on any NPU but a Snapdragon the benchmark refuses `--generation`.

To play an X on an X2, stop the manor's NPU servers first (the check refuses a port that's held). If an X Elite build of Qwen3-VL-4B is at hand, copy it into `{tools}\played\snapdragon-x\geniex\models\qualcomm\Qwen3-VL-4B-Instruct` to save its 4.4 GB download (its pins say whether it's the right build). Then run:

```
node <agent>\src\kit\npu-check.ts --generation snapdragon-x --yes
node <agent>\src\kit\npu-bench.ts --generation snapdragon-x --yes
```

## Verified, and not

**Run on real hardware** (the owner's Snapdragon X2 Elite Extreme, X2E94100, Hexagon driver 30.0.228.10000, 2026-10-07):
- detection through the Neural processor class: maker, generation, driver;
- the plan with GenieX 0.7.0 and the model already there (nothing to download);
- the pinned SHA-256 of GenieX 0.7.0's installer (downloaded to a scratch folder) and of every Qwen3-VL-4B model file;
- GenieX 0.8.0 (2026-10-07, the Smith's scout's first try): its installer's SHA-256 as GitHub publishes it, the silent per-user install over 0.7.0, the test request (chat and vision) on the route's own arguments and on the PC's configured entry, and every pinned Qwen3-VL-4B file unchanged under it;
- the test request, chat and vision, through the kit, in the NPU's turn: answered in 14 s;
- the keeper's GenieX handling (measured since kit 2.6.0);
- the embedding server's memory (2026-10-15, GenieX 0.8.0, b11125): 14 settings of `-c` and `-ub`, 26 starts, the same vectors at each; `-c 4096 -ub 512` beside a loaded GenieX three times, 5,646 MB on the NPU together, and `-c 8192 -ub 2048` twice, 7,114 MB (Memory on a 16 GB Snapdragon). Both, with GenieX, under a 16 GB PC's memory: a ballast leaving 9.7 GB available and then 15.6 GB in all, nothing failing at either. InternVL3.5-2B screened against Qwen3-VL-4B with the benchmark's suite.

**Run on an Intel Lunar Lake** (Core Ultra 7 256V, PCI `643E`, NPU driver 32.0.100.4512, 2026-10-12), the NPU check passing every step:
- setup from nothing: OpenVINO Model Server 2026.4.1's zip, the Visual C++ runtime beside it (the PC had it in System32 too, from Office; Windows loaded the copies beside `ovms.exe`), the model's pull;
- `Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov` on the NPU, downloaded by setup from Hugging Face into an empty folder, its pinned files checked: a first load with its compile 31 s, 5 s from its cache; about 24–26 tokens written and 650–670 read a second; a short answer warm in 0.7 s; 1,395 tokens answered and 1,792 refused plainly at the 1,536 cap; two at once; 3.6 GB working set; the kit's test request in the NPU's turn;
- the cap at 4,096 (2026-10-13), the NPU check passing every step: a first load 41 s, 3,112 tokens read in 4.6 s, 3,827 answered and 4,352 refused plainly, 4.3 GB;
- `OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov` on the NPU (2026-10-13), pulled by OpenVINO Model Server and served as the route's `embedServer` serves it: the card's results, beside the chat server, at `--max_length` 512, 1,024, 1,536 and 2,048 (refusing plainly what's past it);
- OpenVINO's Qwen3-VL-4B on the NPU failing in OpenVINO Model Server 2026.4.1 (`prompt_ids.get_size() >= tokenized_history.size()`), answering on the Arc: why vision stays off Intel's NPU;
- OpenVINO's `Qwen3-8B-int4-cw-ov` there too, before Castellan's 4B was made: right, at 14.8 tokens a second, a 51 s first load and 5.5 GB;
- `OpenVINO/Qwen3-4B-int4-ov`, the route's first model, answering nonsense on the NPU (right on the processor and the Arc 140V): why setup's test request now checks its answer says "ready".

**Run on an Intel Arrow Lake-U** (Core Ultra 5 225U, PCI `7D1D` as on Meteor Lake, NPU 3720, NPU driver 32.0.100.5540, 15.4 GB of memory, 2026-10-14), the NPU check passing every step:
- Manor's "Set up local AI" from nothing, run without administrator rights: OpenVINO Model Server, the chat and embedding models, a first compile 48 s and a warm answer in 3.5 s at the starting values, 6.0 minutes in all; the Smith, the Auditor, the Shepherd, the Constable, the Surveyor and Reeve each answered by it;
- `Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov` at 2,048 tokens, read 128 at a time, its compile from an empty cache: a first load 33 s, 6 s from its cache; a short answer warm in 0.5 s; about 10 tokens written a second; 1,550 read in 6.4 s; 1,882 answered and 2,304 refused plainly; two at once in 1.2 s; 3.88 GB working set; the kit's test request in the NPU's turn;
- `OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov` beside it at 2,048: a first vector in 18 s, a query 1.1 s (Embeddings on Intel's NPU); and on the processor's graphics (2026-10-15, OpenVINO Model Server started by hand with the route's embedding command and `--target_device GPU`, beside the chat server with the route's command): a query in 50 ms, 16 of Reeve's chunks in 4.8 s, the NPU's vectors (cosine 0.997–0.999), chat writing as fast as alone while it indexed (The NPU 3720's embeddings, above); and the embedding endpoint the kit writes for it (`planNpu`, `npuEntry`), started with its own command and environment from a scratch tools home: a first vector 6.6 s after the start with the graphics' compile, a query in 43–50 ms, a dense chunk in 0.85 s;
- OpenVINO Model Server idle uses no processor time between requests;
- the keeper's idle stop (`--idle`, 2026-10-15, with the route's command from the Estimated section: its prefix cache off): the chat and embedding servers woken through the kit held 3.6 and 1.2 GB; the keeper stopped both once the NPU went unused a minute, freeing 4.8 GB; a person's request after it was told the local AI was waking and answered in 6.85 s, an embedding in 2.74 s; a request in flight was never stopped;
- `--harden` (2026-10-15): a driver below the minimum and a test given 1 s each left the NPU out with a plain note; setup's calibration, as for a generation nobody has measured, measured a first answer 6 s after the start, 0.51 s warm and 10.0 tokens a second, and wrote 45 s, 250 ms a token and a 120 s cold load. The model that answers nonsense wasn't downloaded for it (2.4 GB), so that step is still to run on this NPU;
- the benchmark, 20 quick runs over the prompt chunks (64 to 1,024), the prompt cap (2,048, 3,072 and 4,096, each compiled and answering 23 of 24) and the NPU options that touch reading or writing: `BEST_PERF` kept (Per generation, above);
- on `castellan-npu-bench/2` (2026-10-15), 11 quick runs over the prefix cache (OpenVINO Model Server's 128 blocks, 32 and off) and the 4,096-token cap's chunks: the cache turned off (Per generation, above).

**Run on an AMD Krackan** (Ryzen AI 7 350 w/ Radeon 860M, XDNA 2, PCI `17F0`, NPU driver 32.0.20102.3930, 15.3 GB of memory, 2026-10-15), the NPU check passing every step, `--harden` and `--idle` too:
- FastFlowLM 1.0.7's zip and both models pulled by setup's steps (`qwen3-it:4b` and `qwen3vl-it:4b`, 7.4 GB in 521 s), `--no-setup` finding them by their files (through kit 2.74.4 the route named none, so it never did);
- its own default context never loaded: the chat model at FastFlowLM's default (`--ctx-len` -1, the model's 40,960 tokens: about 5.6 GB of context beside 3.3 GB of weights) failed every time, from a fresh start too, with XRT's 0xc01e0200 (the video memory manager couldn't page every allocation in at once). Windows lets a device hold half the PC's memory at once, 7.6 GB there. It served on all the same, `/v1/models` answering, every chat request answered 200 with only `{"error":"Failed to load qwen3-it:4b model!"}`, and the kit took that for an empty answer; the NPU check's start passed on `/v1/models` (the kit after 2.74.4 fails both: `failedWithOk`, and `/api/ps` for the model it holds);
- at `--ctx-len 4096`, the cap: started with its model in 4 to 6 s, 4.5 GB; a short answer warm in 1.3 s; about 14 tokens written and 475 read a second (3,115 tokens in 6.6 s); 3,827 answered and 4,352 refused plainly (400, "Max length reached!"), the server still up; two at once in 3.0 s; a start again 5 s; the kit's test request in the NPU's turn. At 8,192: 10.6 s to start, 5.1 GB, the same speed. Its vision model at 4,096: 5.3 GB, a picture's colour named right, 9.2 s with its switch from chat, 1.8 s warm; the switch back 7.7 s;
- its `--pmode` (powersaver, balanced, performance, turbo) wrote and read alike on mains power, 14.0 tokens a second each, and on battery, each doing the same jobs in the same time; none drew clearly less there, their differences inside the battery meter's own swing (4.7 to 11.3 W at rest from one run to the next). **That says nothing of the modes** (found 2026-10-15): `flm serve` sets its mode by running `cd "C:\Windows\System32\AMD" && .\xrt-smi.exe configure --pmode <mode> > NUL 2>&1`, and ignores the result. On the Krackan, an older driver's `xrt_coreutil.dll` (2024) still sits in `System32\AMD` beside the newer `xrt-smi.exe` (32.00.20102.3931), and it lacks a constructor that `xrt-smi` needs (`xrt::ext::kernel(const hw_context&, const std::string&)`; the current one, in `System32`, has it). Windows loads the DLL beside the program first, so `xrt-smi` failed to load at every start, and every run was in one mode. From Node, which the kit starts it from, the failure is silent; from anywhere else, each start shows an "Entry Point Not Found" dialog and waits for it. Prefill chunks smaller than its 4,096 only read slower;
- its vision model's picture size (`--img-pre-resize`: a large picture is scaled down to a height before it's read; a small one isn't enlarged), on a 1920×1080 desktop screen and a 1080×2400 phone screen with a dialog and an error, asked Reeve's own questions about the phone's (`screenFacts`): at its default, a height of 720, the desktop screen cost 960 tokens and 4.5 s an answer and the phone screen 270 tokens and 2.3 s, every answer right; at the original size 2,080 and 2,600 tokens, 8.8 s and 10.5 s, and nothing more right; at 1,080 and 1,440 slower again, and nothing more right; at 480 the desktop screen's small text was misread. The suite's pictures (224 to 448 px) cost 97 to 137 tokens at any setting. So the route keeps the default. The kit counts 400 tokens a picture (rules.json's `imageTokens`), under a desktop screen's 960, which the cap and the timeouts absorb. It keeps no prefix cache: every request asked twice took the same time both times, so each question about a picture reads all of it again (Reeve's eight about one phone screen took 19 s);
- on battery (`npu-bench --profile full --energy`, the Balanced plan, the screen on): 20.7 mJ a token (6.6 W at rest, 11.6 W working: 49 jobs, 44,637 tokens in 3 minutes), 13.1 tokens written a second against 14.4 on mains power, its jobs 21.9 s against 19.8 s, and its model loaded in 12.7 s against 5.4 s (the idle stop's rule still gives 5 minutes for chat). Writing costs far more than reading: roughly 1 J a token written against 15 to 28 mJ a token read, by the power modes' runs (their rest readings swung, so these are rough);
- the keeper's idle stop (`--idle`): the stop freed 4.3 GB, a person's request after it was told the local AI was waking and answered in 6.6 s, and a request in flight was never stopped;
- `--harden`: a driver below the minimum, a test given 1 s and a model answering nonsense each left the NPU out with a plain note. Its calibration measured the switch back from the vision model as a short answer, warm (9.2 s, so a 105 s base): setup's test request now asks about the picture first, and chat last. Run again with kit 2.74.5, every step passing: chat warm in 1.31 s, 9.7 tokens a second over two short requests, the first answer (now the picture's) 26 s after the start, so 90 s, 250 ms a token and a cold load of 60 s. The base is mostly calibrate's reading estimate, a tenth of writing speed (4,096 tokens at 97 a second), where FastFlowLM read about 34 times faster than it wrote: the route's `readPerWrite` is now 30, which gives the same measurement a 35 s base. The Krackan's own timeouts (20 s + 0.15 s a token, 30 s) are the NPU check's, not calibrate's.
- **Qwen3.5-2B in the Qwen3-4B pair's place** (`qwen3.5:2b`, one model for chat and pictures, 2026-10-15). Measured while Reeve embedded on the Radeon 860M, which shares the PC's memory with the NPU; the starts below are on the slow side for it.
  - **The NPU check:** every measuring step passed:
    - a start with its model in 12.0 s, and its first answer 13 s from the start;
    - a short answer warm in 0.89 to 0.96 s;
    - 19.4 tokens written a second, and 3,272 tokens read in 4.1 s;
    - at the 4,096 cap, 3,827 tokens answered and 4,352 refused plainly;
    - two requests at once in 2.3 s;
    - 3.73 GB held;
    - a start again in 13 s, and the kit's test request (a picture, then chat) 16.5 s from a stopped server.
    - Suggested timeouts: 15 s + 0.15 s a token, and a 30 s cold load.
  - **`--idle`:** every step passed. The stop freed 3.7 GB, and a person's request after it answered in 15.0 s, told it was waking. That gives 6 minutes for chat and for pictures.
  - **`--harden`:**
    - The driver and 1 s cases passed.
    - Calibration measured a first answer (the picture's) 14 s after the start, 0.99 s warm and 13.4 tokens a second, and wrote 25 s, 150 ms a token and a 30 s cold load.
    - **harden-nonsense failed, and fails the same on the Qwen3-4B route run that day.** The check puts `OpenVINO/Qwen3-4B-int4-ov` in the chat model's place. FastFlowLM doesn't know that model, so `flm serve` exits at once ("Model not found"), and setup's note says the server didn't pass its test, not that the model doesn't run properly. The NPU is left out either way. Its earlier passes, an answer of "No", were most likely another server answering on 18184. The step has no nonsense model to force on FastFlowLM.
  - **Started alike from Node,** on a spare port, three times each, alternating: Qwen3.5-2B came up in 10.8 to 11.5 s and answered first in 11.8 to 12.4 s, holding 3.72 GB. Qwen3-4B came up in 8.5 to 9.3 s and answered first in 10.1 to 10.7 s, holding 4.26 GB. Qwen3-4B came up in 4 to 6 s on the quieter PC before.
  - **The benchmark** (quick, then full; Models and sizes, and the kit's CHANGELOG): 22 of 24 quality items, every must-pass one right, against the 4B's 23. 20.4 to 21.0 tokens written a second against 13.6, and its jobs 1.4 to 3 times faster. Pictures 3 of 4, in 1.2 to 1.4 s, as the 4B vision model's 3 of 4 in 1.8 to 2.0 s. Its speed held 89% over 10 minutes.

**Played on the X2 Elite Extreme** (2026-10-15), the first X's code on the X2's NPU (Playing an older Snapdragon, above): what an X runs, not at an X's speed:
- the embeddings with `GGML_HEXAGON_ARCH=v73` against the native v81, Qwen3-Embedding-0.6B at `-c 8192`, each request with a fresh nonce (llama-server's prompt cache otherwise fakes the timings): cosine 1.000 on every text; a start in 1.8 s either way; 20 tokens in 21 ms either way; 551 tokens in 184 ms native and 195 ms on v73; 2,112 tokens in 970 ms native and 1,014 ms on v73 (about 5% slower); the same memory, 4.36 GB working set and 1.55 GB private. It ran the v73 code: without `libggml-htp-v73.so` it fails (0x80000406);
- GenieX 0.8.0 serving AI Hub's X Elite build (soc 60, v73 context binaries) on the X2's v81 QAIRT runtime: a picture's colour named right ("red", 8.0 s cold), "ready" in 115 ms warm, a count to ten in 1.19 s (40 tokens). Once, warm, it wrote "tenth" without its spaces; setup's check of a count still passes it, as it needs only three and seven and no repetition. The X2's own build beside it: 11.0 s cold, 105 ms, 1.20 s. Both held 5.8 GB working set, 1.6 GB private.
- the kit's own runs (kit 2.74.7), with the X Elite build seeded in the played folder so nothing downloaded: `npu-check --generation snapdragon-x` passed as a rehearsal with no patch. Setup found the six pinned files whole in `{tools}\played\snapdragon-x\geniex` (its `config.json` naming `qualcomm-snapdragon-x-elite`). Its other measurements: a first answer in 12 s, warm answers in 0.16–0.22 s, 17.3 tokens a second over 256, 1,812 tokens read in 1.8 s, 2,656 tokens under the cap answered, two requests at once in 0.38 s, a start again in 12 s. The kit's own test request (vision and "ready") passed, and so did its embeddings with `GGML_HEXAGON_ARCH=v73`: a vector in 2.9 s, then 21 ms a query and 165 ms a chunk, 1,024 dimensions. GenieX held 5.68 GB (1.55 GB private). `npu-bench --profile quick --generation snapdragon-x`, marked played and never ranked, against the X2's own build's quick run the same day:

  | | played X | X2's own |
  |---|---|---|
  | job time | 5.5 s | 6.16 s |
  | writing | 38.8 tokens a second | 39.9 tokens a second |
  | cold load | 9.4 s | 10.0 s |
  | quality | 23 of 24 (wrong: time) | 23 of 24 |
  | vision | 3 of 4 | 2 of 4 |

  The played run's cached load was 9.5 s. A quick run tries each measurement only 3 times, and the reply and summary jobs varied by more than 15%, so the two are alike within its noise.

**Checked from source or the release, not run**: OpenVINO Model Server 2026.4.1's zip (its SHA-256, its layout, its `/v1/models` and `/v1/chat/completions` routes in its source at that tag); FastFlowLM 1.0.7's `flm validate --json`, from its source and `flm.exe`: it looks for PCI `17F0` alone, so it can't vouch for an AMD NPU setup doesn't know (Detection, above).

**Unverified on hardware**, each needing a run on a real PC:
- GenieX's silent install on a clean PC (the flags are Inno Setup's standard ones);
- a real first-generation Snapdragon X, which the X2 only plays: GenieX's own V73 QAIRT runtime (played, the X's build ran on the X2's v81 runtime; GenieX's v73 runtime wasn't tried on the X2, for the risk of a bluescreen), the X's own speed (45 TOPS against the X2's 80), its memory, and the embedding server's `-c 4096 -ub 512` on its Hexagon (v73). On a 16 GB X Elite, GenieX (5.8 GB) and the embedding server (2.0 GB from kit 2.75.1, 4.4 GB before) beside it hold about 8 GB of the 16, and setup's memory check doesn't weigh them yet (Qualcomm's route has no `memoryGb`): whether a 16 GB X keeps both is the owner's to decide;
- a real 16 GB Snapdragon running chat, pictures and embeddings on the NPU beside the manor's agents. The X2 Elite ran them under a 16 GB PC's memory (a ballast: Memory on a 16 GB Snapdragon), but the 7.8 GB its NPU may hold is still worked out, since Windows sets it from the memory the PC starts with;
- the Snapdragons before the X refused on a real one, and the ACPI ids from Qualcomm's driver files (`0D0A`, `0D19`, `104F`, `1050`): only `0FF0`, this laptop's, has been seen;
- Intel beyond Lunar Lake and Arrow Lake-U: Meteor Lake itself (verified through the Arrow Lake-U, which shares its NPU and PCI id, but not run on one), Arrow Lake-S and -H, Panther Lake and Wildcat Lake (their PCI ids, speed, the driver minimum, and their starting values: setup calibrates them on each PC until the NPU check's patch verifies them);
- the prompt settings estimated from the NPU 3720 (Estimated, above): Lunar Lake's and Panther Lake's 512-token chunks and `BEST_PERF`, their prefix cache off, and Wildcat Lake's NPU 3720 settings. Only a benchmark on the Lunar Lake can check any of them;
- the NPU 3720's embeddings on the processor's graphics through setup and the NPU check (`embedArgs`; measured with the same command started by hand, and the entry the kit writes started once from a scratch tools home: a query in 43–50 ms), on a Meteor Lake's Arc graphics, and with a game on the graphics (the keeper defers the card's models for one, not the NPU entry's); and their energy for each chunk against the NPU's;
- AMD beyond the Krackan: Strix Point, Strix Halo and Gorgon Point (XDNA 2 too, the same PCI id, but not run on one), a PC with 24 GB or more (where FastFlowLM's default context may well load: the cap keeps it at 4,096 everywhere), and the driver minimum, 32.0.203.311 (only 32.0.20101.3760 and 32.0.20102.3930 ran);
- FastFlowLM's `--pmode`: on the Krackan its `xrt-smi` never ran (above), so no mode has been measured. Still to run on a PC whose `xrt-smi.exe configure` works;
- that AMD's XDNA (Phoenix, Hawk Point) is refused with the right words on a real PC;
- a known maker's NPU of a generation setup doesn't know, tried on guessed values: no such NPU has run it (the tests run it on the kit's fake servers, and the NPU check's patch for one). A Snapdragon before the X is refused before anything downloads (above), but one that lists a Neural processor by a name that doesn't say which, under an ACPI id `devices` doesn't know, is still tried, and downloads GenieX and its 4.4 GB model before its test request can fail; on Intel, the latest driver minimum (32.0.100.5540) may refuse an NPU that would run on an older driver;
- the keeper's idle stops of OpenVINO Model Server and its cold starts after one on a Lunar Lake (`npu-check --idle`: it passed on the NPU 3720).
