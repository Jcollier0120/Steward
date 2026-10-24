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
| Qualcomm Snapdragon X, X2 | GenieX (Qualcomm, formerly Nexa) | 0.9.3 on the X2 (from kit 2.108.0; 0.9.1 where kit 2.88.1 to 2.107.0 or the Smith's Use it put it), 0.9.3 on the X (from kit 2.101.0; 0.8.0 where an earlier kit put it) | chat, vision (one model: Qwen3-VL-2B-Instruct Q4_0, on the X with Qwen3-VL-4B W4A16 as its fallback); embeddings, and on the X2 a reranker when asked for, on llama.cpp's server over GenieX's libraries | Castellan's signed build where the route has one for the version (kit 2.108.0: Qualcomm's SDK zip with Castellan's signed copies of GenieX's own files, no installer), else its Inno Setup installer, silent, per user; no administrator either way |
| Intel Core Ultra (Meteor Lake, Arrow Lake, Lunar Lake, Panther Lake, Wildcat Lake) | OpenVINO Model Server | 2026.4.1 | chat, vision (one model: Qwen3-VL-2B, symmetric INT8, on Castellan's build of OpenVINO GenAI) | a zip, unpacked into the accelerators' folder |
| AMD Ryzen AI 300 and later (XDNA 2) | FastFlowLM | 1.0.10 (kit 2.111.0; 1.0.7 before) | chat, vision (one model: `qwen3.5:2b`, Qwen3.5-2B) | a portable zip, unpacked into the accelerators' folder |

Second choices, if a route fails on hardware: Foundry Local for Snapdragon and Intel; Lemonade Server (AMD's, Apache-2.0, which itself runs FastFlowLM) for AMD.

**Embeddings** run on the Snapdragon's and Intel's NPUs, each through a server of its own (below); the NPU 3720's on the processor's graphics beside it. A Snapdragon X2 reranks on its NPU too, when a reranker is asked for (Reranking on the Hexagon, below). AMD's stay off the NPU: FastFlowLM's embedding model is EmbeddingGemma, under Gemma's terms. There they go to the graphics card, or to the processor on a PC without one: setup sets the processor up for embeddings when the NPU chats but makes none and there is no card.

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

GenieX serves no `/v1/embeddings` (its issue #1149), but it carries llama.cpp (build b11125 in GenieX 0.8.0) with llama.cpp's Hexagon backend and Qualcomm's signed HTP libraries (`libggml-htp-v73/v75/v79/v81.so` and their catalogue `libggml-htp.cat`), so nothing needs test-signing. The route's `embedServer` runs llama.cpp's own `llama-server` of that very build (its release zip, pinned) over GenieX's libraries (its `overlay`: GenieX's `ggml*.dll`, `llama.dll`, `llama-common.dll`, `mtmd.dll` and the HTP files, copied whenever they differ), on `--device HTP0`, with Qwen3-Embedding-0.6B Q8_0, the graphics card's model. A llama-server of another build doesn't load GenieX's libraries (a missing entry point), so `embedServer.version` moves with GenieX's: GenieX 0.9's libraries (llama.cpp e467e5b) run under b11645's, in a folder of its own (A later GenieX on the PC, below). The HTP library is loaded through FastRPC, which finds it by `ADSP_LIBRARY_PATH` (the entry's `env`) or the working folder.

Measured on the X2 Elite (2026-10-12), Reeve's search eval on GamerNexus (9 questions), against the Adreno's llama.cpp and npu-embed's nomic-embed-text v1.5 on the NPU:

| | Hexagon (Qwen3-Embedding) | Adreno X2-90 (Qwen3-Embedding) | NPU, nomic v1.5 (npu-embed) |
|---|---|---|---|
| Right file in the top 5 | 9/9 | 9/9 | 8/9 |
| Right file first | 4/9 | 5/9 | 4/9 |
| A query, warm | 45–73 ms | 103–155 ms | 73–88 ms |
| A 1,600-character chunk | 124 ms | 265 ms | (128 tokens at most) |
| Indexing GamerNexus, gentle pace | 31 min | about 65 min | 3 min |

Its vectors match the card's (cosine 0.9990–0.9998 on the same texts), so it keeps the card's model name, `qwen3-embedding-0.6b-gguf`, and an index made by either serves both. Several requests at once are slower on the Hexagon, not faster (`--parallel 4`: 702 ms a chunk), so it takes one at a time. It holds 1.4 GB of the NPU's memory beside GenieX's model (604 MB model, 448 MB context, 302 MB compute; 2.9 GB through kit 2.75.0: below) and is stopped when idle, as GenieX is.

### Reranking on the Hexagon (kit 2.100.0)

A reranker (ACCELERATORS.md's `rerank`: Reeve's opt-in sharper search) is set up only when asked for (`--serve rerank`). On a Snapdragon whose NPU has llama.cpp's embedding server, setup now puts it on the NPU: that server's very program and environment (`ADSP_LIBRARY_PATH`) started a third time, `--reranking` on its own port (18185, the route's `rerankServer`), on `--device HTP0`, with the graphics card's reranker, Qwen3-Reranker-0.6B Q8_0 (ggml-org's GGUF, 639 MB). No download of its own beyond the model, no build of its own. Setup tests it before writing it (`testNpuRerank`: a question and two passages, the one that answers ranked first), in the NPU's turn, which every rerank takes, as chat and embeddings do. A test that fails leaves the reranker to the processor, as before. It isn't set up on a PC under 20 GB (`smallPc`), whose NPU memory is chat's and the embeddings'; there it goes where it went before. The keeper stops it as it stops the embedding server (`npuIdleStopMinutes` for embeddings), and the NPU's refresh makes it again on the embedding server it writes, its file and port kept.

Measured on the X2 Elite Extreme (Hexagon v81, 48 GB, 2026-10-23), llama.cpp b11645 over GenieX 0.9.3's libraries, against the Adreno's llama.cpp b11734 (setup's card) and the processor's:

| | Hexagon | Adreno X2-90 | Processor |
|---|---|---|---|
| Reeve's 24 rerank queries, blended with search's order: right file first / in the top five | 12 / 19 | 12 / 19 | 12 / 19 |
| Order against the Adreno's: the same first file / the same top three / swapped pairs | 21 / 19 / 10, each within 0.0074 | | 22 / 20 / 12, up to 0.051 apart |
| Ten files of 1,600 characters, median (p90) | 849 ms (943) | 1,558 ms (1,698) | 2,286 ms (2,760) |
| Memory it holds | 1.10 GB of the NPU's at `-c 4096 -ub 512` (1.65 at the cards' `-c 8192 -ub 2048`, as fast) | 2.08 GB of the card's | 1.6 GB of the PC's |

- **The same order, up to near-ties.** The Hexagon's order differs from the Adreno's as little as the processor's does: the files it swaps were within 0.0074 of each other, and the three queries whose first file differs had their top two within 0.0012. Reeve's results were the same on all three. Its words alone (no reranker) put 8 first and 18 in the top five.
- **Chat isn't slowed.** In the NPU's turn, GenieX wrote 73.2 tokens a second with reranks asked between its chats, and 73.3 without. A chat waited at most one rerank (about 0.85 s); a rerank waited a median 0.19 s for a chat (1.5 s at most). Asked at the same moment outside the turn, a rerank slowed a chat about five times, so it always takes the NPU's turn.
- **Its context.** `-c 4096 -b 2048 -ub 512`, as the NPU's embedding server: ten files and a question fit in one request, at 0.55 GB less of the NPU's memory than the cards' flags.
- **Reeve's warm-up.** Reeve sends a chat warm-up to a server it starts on the NPU; the reranking server answers it (200) without harm.

### Harrier-OSS-v1-0.6B on trial (2026-10-24)

Microsoft's harrier-oss-v1-0.6b (MIT, published 2026-03-30) is Qwen3-Embedding-0.6B's network trained again: `Qwen3Model`, 1,024 dimensions, last-token pooling, queries written the same way (`Instruct: …\nQuery: …`). Its card gives 69.0 on multilingual MTEB v2 against about 64 for Qwen3-Embedding-0.6B (the vendor's figures, not ours). A trial on the X2 Elite Extreme (Hexagon v81, 48 GB) asked whether it should replace Qwen3-Embedding. No pin changed.

- **Its file.** Microsoft publishes no GGUF, and the two others found (a gguf-my-repo Q8_0 and a format of its own) aren't from anyone we trust, so it was converted here: revision f9b9dc8d367d443f2479d27aa5d8d2850c0774ee, every file checked against Hugging Face's own hashes, then llama.cpp b11645's `convert_hf_to_gguf.py --outtype q8_0`. Two conversions gave the same bytes: `harrier-oss-v1-0.6b-Q8_0.gguf`, 639,447,840 bytes, SHA-256 `c9ee3148d6a12b4a6b57bcbdf2fef3a511481590063353ce6e216ce3917859df`. Its metadata is Qwen's GGUF's (qwen3, last-token pooling, the end token 151643 added), plus NFC normalizing, with the vocabulary padded to 151,936 (151,669).
- **Its vectors.** 77 texts (Reeve's 24 questions with its instruction, 44 of Reeve's chunks, 4 dense and 5 short ones; 21,955 tokens). On the Hexagon, through the NPU's embedding server as setup runs it, against the processor's b11734: cosine 0.99975 or more (median 0.99989), the same nearest chunk for 20 of the 24 questions and 4.96 of the top five. Against Microsoft's float32 weights in PyTorch: 0.99983 or more, with the same token counts. Qwen3-Embedding's, the same way: 0.99915 or more, 24 of 24.
- **The same speed and memory.** The 77 texts took 4.8 s on the Hexagon with either (about 4,570 tokens a second), and 14.5 s (Harrier) and 15.1 s on the processor at 8 threads. Reeve indexed as fast with either: GamerNexus's 7,775 chunks in 542 s (Qwen3-Embedding) and 541–555 s (Harrier), Reeve's 2,424 in 175 s and 179–180 s. Each server holds 1.10 GB of the NPU's memory (1,102 and 1,104 MB), and 2.5 GB of the PC's after the same work.

Reeve's 24 search questions (the reranker's, above) on frozen copies of the same repositories, the same chunks and the same instruction, only the embedder changed. Reeve keeps 512 of the 1,024 dimensions (`embedDims`). Qwen3-Embedding is trained for that (Matryoshka); Harrier's card doesn't say, so both were measured at 512 and at 1,024. Right file first / in the top five, then the mean reciprocal rank:

| | Qwen3-Embedding, 512 | Harrier, 512 | Qwen3-Embedding, 1,024 | Harrier, 1,024 |
|---|---|---|---|---|
| Search alone (hybrid) | 9 / 21, 0.590 | 13 / 21, 0.660 | 9 / 21, 0.597 | 11 / 21, 0.639 |
| Reranked (blended, ten files) | 12 / 20, 0.640 | 12 / 21, 0.642 | 12 / 21, 0.638 | 11 / 20, 0.619 |

- **A little better without the reranker, the same with it.** At Reeve's 512 dimensions Harrier put four more right files first: it ranked the right file higher on 6 questions, lower on 3, and the same on 15, which 24 questions can't tell from chance (a sign test's p is 0.5). At 1,024 it was two more. Reranked there is no difference (12 and 12; 11 and 12).
- **Three questions can't be scored.** They name files that have since moved: two jobs went from `.ps1` to `.ts`, and `src/kit/` is left out of Reeve's index. So every run misses them. For the two jobs, both models' search put the moved file first.
- **Energy wasn't measured.** The owner put the energy runs off until the feature work is done. Both are the same 0.6B network at Q8_0, at the same speed and with the same NPU memory, so a token should cost the same. npu-bench's embedding rows are measured for both before any switch.

**Not switching, for now.** Accuracy comes first, and Harrier's gain isn't clear: it shows only without the reranker (opt-in, so how most PCs search), it is within chance on 24 questions, and it is gone once results are reranked. A switch rebuilds every search index once: this PC's Reeve holds 66,069 chunks, about 80 minutes of the Hexagon at full pace (14 chunks a second), before Clerk's and Chamberlain's indexes. More questions would settle it. If Harrier then wins, the switch is its GGUF on the Hexagon and the graphics cards, and an OpenVINO export for Intel's NPU.

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

### Qwen3-VL-2B on every Snapdragon X2 (kit 2.78.8; on a 16 GB X2 alone from kit 2.78.0)

On every Snapdragon X2, whatever its memory, setup runs Qwen3-VL-2B in place of the 4B. It is the X2 generation's own `models` in `npu-vendors.json`, which `routeFor` puts in the route's place on that generation. Every first-generation X (Hexagon v73), where the 2B was never run, keeps the route's 4B, as does a Snapdragon setup doesn't know yet.

From kit 2.78.0 the 2B was the X2's `smallPc`, for an X2 under 20 GB (`idleStop.smallPcGb`) alone, and a bigger X2 kept the 4B. The benchmark below, on the 48 GB X2 Elite, showed the 2B as accurate and faster there too (the owner, 2026-10-16: "It's faster and just as accurate"), so kit 2.78.8 made it every X2's. `smallPc` stays in the code, the models a generation runs over its own on a PC under 20 GB, and no generation has any now.

- **What it is.** unsloth's Q4_0 GGUF of Qwen3-VL-2B-Instruct (`unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0`, 1.9 GB with its F16 vision projector), pulled from Hugging Face by GenieX (`--model-hub hf`) and served by GenieX's llama.cpp plugin: the language model on the Hexagon (`--compute npu`), the pictures' encoder on the Adreno (`--vit-compute GPUOpenCL`). AI Hub has no QAIRT build of the 2B, only this GGUF. Its two files are pinned for the X2.
- **Why the Adreno.** GenieX 0.8.0's llama.cpp reads every picture as grey on the Hexagon (GELU and IM2COL in its Hexagon backend, fixed in llama.cpp after the commit GenieX pins), and with the encoder on a second Hexagon session it aborts. On the processor it reads them right, but each picture takes about 5.5 s of processor time; on the Adreno 0.8 s, and the picture is read in 0.3 to 0.7 s. GenieX 0.9 reads them right on the Hexagon's second session, and a PC that runs it reads them there. From kit 2.88.1 setup puts GenieX 0.9.1 on a new X2 (0.9.3 from kit 2.108.0), and an X2 set up before keeps 0.8.0 and the Adreno until the Smith's Use it moves it (A later GenieX on the PC, below).
- **Per-model arguments.** `--compute` and `--vit-compute` are the model's own `serve` (`NpuModel.serve`), which `npuEntry` adds after the route's. The 4B's QAIRT command never gets them. A later GenieX may want others: from 0.9.0 the 2B's are `--compute npu --nctx 2560` (the route's `versions`).
- **Measured** with the full benchmark (`castellan-npu-bench/2`) on the 48 GB X2 Elite, 2026-10-15, against the 4B:

  | | Qwen3-VL-2B (Q4_0, llama.cpp, pictures on the Adreno) | Qwen3-VL-4B (W4A16, QAIRT) |
  |---|---|---|
  | Quality items | 22 of 24, every must-pass one right (wrong: time, apples) | 22 of 24 (wrong: capitals, time) |
  | Pictures | 4 of 4 | 3 of 4 |
  | Tokens written a second | 75.0 | 41.1 |
  | Short answer | 58 ms | 92 ms |
  | First token at 512 / 1,024 / 2,056 tokens | 181 / 320 / 714 ms | 259 / 430 / 1,012 ms |
  | Jobs: triage, reply, summary | 0.56, 0.43 and 1.95 s | 0.73, 0.98 and 3.88 s |
  | Cold / cached load | 5.1 / 5.4 s | 10.0 / 9.9 s |
  | Speed held over 10 minutes | 95% (100% run again quiet) | 100% |
  | Working set / private | 4.31 / 2.34 GB | 6.12 / 1.68 GB |
  | On the NPU | 2.1 GB | 4.2 GB |
  | The PC's available memory, lower once loaded | 3.5 to 4.2 GB | 6.1 GB |

  Not ranked: the processor was 31% busy at the start, and GenieX's reply and summary jobs varied by more than 15%, as in the 4B's own full run. Run again on a quiet PC with the kit's own command (`npu-bench --small-pc`, later on 2026-10-15, the processor 6% busy), it gave the same quality and pictures, 74.6 tokens a second, 3.01 s of jobs, a 4.3 s cold load and a 4.0 s cached one, and its speed held 100% over 10 minutes. Only the reply job kept that run off the board: its tries spread 24% (508 to 666 ms) with no outlier, judged then on whole times. Kit 2.78.0 judges a job's tries at one answer length (NPU-BENCHMARK.md, Steady), since each try's answer has a length of its own. Its private memory is 0.65 GB more, the vision encoder's weights in the PC's memory rather than the NPU's, and the Adreno holds about 1.5 GB of the PC's shared memory while it's loaded. With the embedding server beside it, the screen (the encoder on the processor) took 5.8 GB of the PC's available memory against the 4B's 8.2; the Adreno adds 0.2 to 0.7 GB to that.
- **A PC already set up** keeps the 4B until its local AI is set up again (Set up local AI), which pulls the 2B (1.9 GB). The keeper's look for a later kit's command never downloads: on an X2 where the 2B is there already, it tests it and switches (its log says `model unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0 in qualcomm/Qwen3-VL-4B-Instruct:W4A16's place`); where it isn't, it leaves it for setup (`needs-setup` in `npu-refresh.json`), which Set up local AI acts on from kit 2.103.0; before it, setup left the entry alone (A later kit's command, below). The 4B stays on disk (4.4 GB) until removed: `geniex remove qualcomm/Qwen3-VL-4B-Instruct`.
- **The keeper's look under the Smith** (kit 2.78.8). The Smith hands the kit's `keeperLook` the `config.json` it read for its round, and until kit 2.78.8 a handed `config.json` meant a test: the look skipped the NPU's refresh, the cards' vision refresh and `hardware.json`, and Reeve leaves its looks to the Smith wherever the Smith is installed. So on every PC with the Smith none of the three ever ran: the X2 Elite had no `npu-refresh.json` or `card-refresh.json` beside its `config.json`, its NPU entry still the 4B's from 2026-10-08. The look now asks the PC itself whenever its reaper is the PC's own (`pcReaper`'s, `asksPc`), handed a `config.json` or not; a test's reaper never does.
- **The 4B's cap, timeouts and idle stop**: 2,400 tokens, the rules' timeouts, 5 minutes. Its cold start (5.1 to 9.1 s with the encoder on the Adreno) is inside the route's 15 s.
- **The Adreno's turn.** GenieX's encoder runs on the Adreno without the card's turn. A Snapdragon's Adreno is set up as a card too (the fallback), so a picture can be read beside the card's own llama-server. Each picture holds the Adreno well under a second.
- **Its pictures (kit 2.80.2).** The 2B reads a picture at its own size, a token for each 32 × 32 px (16 px patches merged two by two, each side rounded to the nearest 32): 448 × 448 is 196 tokens, 1920 × 1080 about 2,040, 2560 × 1440 about 3,600, and 3840 × 2160 about 8,160, which GenieX refused (HTTP 400, `context_length_exceeded`). The kit counted every picture as 400 tokens (`rules.json`'s `imageTokens`). So the 2B's vision endpoint carries `pictureTokens: 1024` (`NpuModel.pictureTokens`, which `npuEntry` writes into `config.json`): the kit redraws a larger picture to fit within 1,024 tokens, each side a multiple of 32 (`fitPicture`, `pictureFit`), and counts each picture on that server as 1,024 against its cap (`pictureTokensFor`). A picture already within 1,024 goes as it is. Measured on the 48 GB X2 Elite, 2026-10-17, GenieX 0.8.0 with `--nctx 2560`, five screens drawn at 1920 × 1080, 2560 × 1440, 2880 × 1800, 3840 × 2160 (at 100% and 150%) and a 1080 × 2400 phone, 35 questions about their text, asked at temperature 0:

  | Each picture at most | Right | A question | Prompt tokens | Fitting |
  |---|---|---|---|---|
  | 400 tokens (832 × 480) | 18 of 35: every phone question, but the desktops' small text misread (ERR-7359, "Northwood", 09:47, 1,384) | 1.3 to 1.5 s | 418 to 454 | 51 to 339 ms |
  | 1,024 tokens (1344 × 768) | 35 of 35, 3840 × 2160 included | 4.4 to 4.7 s | 1,028 to 1,071 | 65 to 112 ms |

  Reeve's screens and the Smith's check are small text, so the kit spends the tokens rather than shrinking pictures further. The 4B (QAIRT) sizes pictures itself and has no `pictureTokens`; its pictures count 400, as before.
- **Its window (kit 2.80.2).** `--nctx 2560` in the 2B's own `serve`: GenieX's llama.cpp plugin keeps a 4,096-token window by default, more than the route's 2,400-token cap and a 1,024-token picture need. At 2,560 its KV cache is 282 MiB against 448, 168 MB less, and chat and pictures answer as before. A PC already set up gets both from the keeper's NPU refresh: it tests the 2B with the new command and rewrites its entry (its log says `--nctx 2560 added, pictures: at most 1024 tokens`).
- **Large greyscale text on whole squares** (kit 2.80.3). The Smith's check picture (TALLY 4827, Segoe UI 64 px bold with greyscale anti-aliasing, 512 × 512, 256 tokens, so never fitted) read "Tally 827" on the 2B 8 times in 8, with or without `--nctx`, its encoder on the Adreno or the processor. Measured 2026-10-17 on the X2 Elite, the Smith's question at temperature 0, each request as the kit builds it:
  - Every such picture drawn with both sides a whole number of 32 px, which the server's resize leaves as it is, read wrong: other fonts (Arial), sizes (48 and 80 px), weights, texts ("4827" read "47", "LEDGER 3519" "Elder 319", "TALLY 4444" "TALLY 444") and canvases (448, 480, 544, 640, 512 × 256).
  - The same drawn on a side that isn't (500, 513, 520, 448 × 449, 512 × 513, 513 × 512) read right, and so did the Smith's own pixels with a white column and row added (513 × 513), and any picture the kit redraws: the server's resize, or the kit's, is what the 2B reads such text right after. Drawn in ClearType, as Windows draws text on a screen, it read right on 512 × 512 too, 8 times in 8.
  - **Why the kit doesn't nudge pictures off whole squares** (as `sides-of-32` does for FastFlowLM): a window's screen text, crisp ClearType crops of the drawn desktop at 1280 × 768, 1024 × 768 and 1280 × 736 (960, 768 and 920 tokens, sent as they are), read 15 of 18 questions right as they were and 12 of 18 a pixel wider: the extra resample blurs small text. The Smith draws its picture 513 × 512 instead (Smith 0.8.45: 8 times in 8 right, and through the NPU's own server).
- **The 4B on an X2**: `npu-bench --model qualcomm/Qwen3-VL-4B-Instruct:W4A16` measures the route's own 4B on an X2, for comparing. A `--candidate` is pulled and served as the route's own model is (AI Hub's QAIRT build), whatever the generation runs. `--small-pc` runs a generation's `smallPc` models, of which there are none now.

### One copy of Qwen3-VL-2B on an X2 (kit 2.100.0)

The X2's graphics card and processor run Qwen3-VL-2B too (ACCELERATORS.md), setup's Q4_K_M with its Q8_0 projector, so an X2 kept two copies of one model: GenieX's Q4_0 (1.06 GB) and setup's Q4_K_M (1.11 GB). From kit 2.100.0 the card and the processor read GenieX's own file where it is (`npuChatFile`: the route's `offNpu` file, at its pinned size, in GenieX's cache), and setup's Q8_0 projector stays beside it. GenieX's F16 projector isn't used: it holds 0.35 GB more, and the processor took 0.77 s a picture with it against 0.43.

Measured on the X2 Elite Extreme (2026-10-23, llama.cpp b11734, setup's flags), GenieX's Q4_0 against setup's Q4_K_M, each run twice in turn:

| | Adreno, Q4_0 | Adreno, Q4_K_M | Processor, Q4_0 | Processor, Q4_K_M |
|---|---|---|---|---|
| Tokens written a second | 66 | 67 to 71 | 64 to 70 | 61 to 70 |
| 1,024 tokens read | 0.82 s | 0.85 to 0.87 s | 1.25 to 1.30 s | 1.47 to 1.77 s |
| A picture | 0.34 s | 0.29 to 0.31 s | as fast | |
| Memory | 3.2 GB of its memory | 3.2 GB | 0.1 GB less | |
| Answers right / pictures right | 22 of 24 / 4 of 4 | 22 of 24 / 4 of 4 | 22 of 24 / 4 of 4 | 22 of 24 / 4 of 4 |

- **Setup** plans the card's and the processor's Qwen3-VL-2B from GenieX's copy when it is there, downloading only the projector; its plan says `have Qwen3-VL-2B-Instruct-Q4_0.gguf: the NPU's own copy, used where it is`. Without GenieX's copy (another Snapdragon, or GenieX hasn't pulled it yet), the Q4_K_M as before.
- **A PC set up before**: the keeper's look (`refreshSmallModel`, each look, cheap) points the card's and the processor's `-m` at GenieX's copy, and logs it. Nothing is started or stopped: a server running keeps its file until its next start. The Q4_K_M is removed once nothing in `config.json` has named it for three days and no running process names it: an agent that read `config.json` before may still start a server with it. From kit 2.101.0 that removal is the keeper's look at the files the routes no longer run (below), the Q4_K_M first on Qualcomm's list; `small-model.json` keeps only what `refreshSmallModel` moved.
- **Left as it is**: a Q4_K_M a person puts back in `config.json` (kept while it names it, never moved off again), a PC set up for everyone in the shared folder (another account can't read GenieX's cache in this one's profile), and a command that isn't llama-server's. Should GenieX's copy go while the Q4_K_M is still there, the card and the processor read the Q4_K_M again.

### Qwen3-VL-2B on the first-generation X, the 4B its fallback (kit 2.101.0)

From kit 2.101.0 the first-generation Snapdragon X (X Elite, X Plus; Hexagon v73) runs Qwen3-VL-2B too: the X2's Q4_0 GGUF through GenieX's llama.cpp plugin, its language model and its pictures on the Hexagon. The owner's choice: the 2B had been better all round on the X2 (Qwen3-VL-2B on every Snapdragon X2, above). It is the `snapdragon-x` generation's own `models`, and the generation pins GenieX 0.9.3 (`serverPin`), which setup installs on a new X.

- **Why the 2B, and why GenieX 0.9.3.** Qualcomm AI Hub builds no Qwen3-VL-2B for the X Elite's chip: its release (v0.65.0) has only unsloth's universal GGUF, for GenieX's llama.cpp plugin. GenieX 0.9.3 (QAIRT 2.50, llama.cpp e467e5b) carries llama.cpp's signed Hexagon code for every Hexagon from v73 (`libggml-htp-v73.so` to `-v81.so`, with its catalog), and reads pictures on the Hexagon's second session. It runs AI Hub's current X Elite build of the 4B as well (v0.65.0, built with QAIRT 2.50.0), which replaced the build the kit had pinned (no longer published): the 4B's X Elite pins are that build's now, the earlier build's kept beside them. On GenieX 0.9.0 and later the X gets Castellan's build of the plugin, as the X2 does (each version's `pluginPatch` names `"snapdragon-x": "snapdragon-x2"`), so its processor's threads sleep while the NPU works (GENIEX_PATCH_POLL, A later GenieX on the PC, below): about five cores fewer busy while it writes.
- **Measured** on the X2 Elite Extreme playing an X (2026-10-23, GenieX 0.9.3 with Castellan's build, `GGML_HEXAGON_ARCH=v73`, its own data folder naming the X Elite's chip, a private port in the NPU's turn; llama.cpp's log showed the v73 library loaded and the pictures read on the Hexagon's second session), npu-bench's quality items and pictures:

  | | 2B, the X's v73 code | 2B, the X2's v81 | 4B, AI Hub's X Elite build |
  |---|---|---|---|
  | First answer after a start | 2.2 s | 2.0 s | 8.1 s |
  | Tokens written a second | 71.2 | 72.9 | 41.1 |
  | Quality items | 21 of 24 | 22 of 24 | 22 of 24 |
  | npu-bench's pictures | 4 of 4, median 413 ms | 4 of 4, 398 ms | 3 of 4 |
  | Setup's red picture | seen red | seen red | seen red |
  | Processor busy while writing | 0.05 cores | 0.07 cores | 1.02 cores |
  | Working set | 2.69 GB | 2.68 GB | 5.92 GB |

  That is the X's code on an X2's NPU, never an X's speed (45 TOPS against 80) or memory. Against the 4B played the same way, the 2B wrote 1.7 times as fast and held under half the memory.
- **The 4B is its fallback** (the generation's `fallback`; `routeFor` and `planNpu` take a `fallback` option): no X has run the 2B yet. Setup's plan for an X carries the 4B beside it (`NpuPlan.fallback`), and says so: `should it not answer properly on this NPU: qualcomm/Qwen3-VL-4B-Instruct:W4A16 (…) in its place`. `setUpNpu` tries the 2B first, its test requiring the red picture seen red (`seeRed`). Should its pull, its pinned files, its test or its measuring fail once GenieX is in place, setup stops the 2B's server in the NPU's turn and sets the 4B up on the same GenieX, tested as before. The X keeps chat and pictures on the NPU, and no problem is shown: what the 2B met goes in setup's log and in the result's `fellBack`, and the report names the 4B. Only should the 4B fail too does setup say why (the 2B's failure). A failure before the models (GenieX's download, its installer) is said as before, with no fallback.
- **A PC set up before** is left as it is. The keeper's NPU refresh keeps an X on the 4B (it reads the entry's model against the generation's fallback), and never pulls the 2B in the background: setup (Set up local AI) run again tries the 2B first. Until kit 2.103.0 it didn't: setup with no ids left a configured NPU alone, and the look keeps an entry on the fallback, so nothing tried the 2B again. From kit 2.103.0 `planSetup` sets up again an entry on its generation's fallback, on the route's own server. Should the 2B fail again, the 4B is set up again quietly, as the first time (`fellBack`, its reason in the log), with no note or alarm. An X an earlier kit set up has GenieX 0.8.0, which setup doesn't replace: there it tries the 2B as 0.8.0 runs it, its pictures on the Adreno (`--vit-compute GPUOpenCL`) with GenieX's own plugin, and falls back should that fail. Its 4B is AI Hub's earlier build, which the pin still accepts (`earlier`: a build pinned before, passing where it's whole; a pull now must give the current one), so the fallback finds it in place. Neither has run on an X (Verified, and not).

### Model files the routes no longer run (kit 2.101.0)

Each route in `npu-vendors.json` lists the model files and folders it no longer runs (`retired`, npu-vendors.ts' `NpuRetired`): a `path` (with `{tools}` and `%VARIABLES%`), a `match` for the files in that folder it names or else the folder itself, the GenieX `model` id it was served by, the kit version that retired it (`since`), and `why`. The keeper's look (`removeRetiredModels`, retired.ts, after `refreshSmallModel`) removes each one nothing has used for three days (`RETIRED_GRACE_MS`):

- **Where**: a route's list applies on a PC that has its server installed, or whose NPU entry runs it.
- **Used**: while any string in `config.json` names it (its path, its file or folder name, or the model id its server serves it by), or a running model server's command line does. A PC that never moved off it keeps it, and so does one a person points at it again.
- **When**: first seen unnamed, it is recorded (`retired-models.json` beside `config.json`) and logged; named again, it is kept and its count starts over; three days unnamed and no running server naming it, it is removed and logged with its size, a folder first renamed aside (`<folder>.removing`) so a server never finds half of it. Windows refusing (a program has it open) is tried at a later look; with the process list unread nothing is removed that look; with `config.json` unreadable nothing is looked at.
- **Never** in the PC's shared folder (an Everyone install), whose files other accounts read.

Qualcomm's list:

| Retired | Since kit | Why |
|---|---|---|
| `{tools}\models\Qwen3VL-2B-Instruct-Q4_K_M.gguf`, under either repository's name | 2.100.0 | the graphics' and the processor's copy: they read GenieX's Q4_0 now (One copy of Qwen3-VL-2B, above) |
| GenieX's `models\qualcomm\Qwen3-VL-4B-Instruct` | 2.101.0 | AI Hub's 4B, the route's model before the generations' 2B; an X that fell back to it names it, and keeps it |
| GenieX's `models\qualcomm\Qwen3-4B-Instruct-2507` | 2.101.0 | the model of the install's own GenieX entry (`GENIEX_CHAT_MODEL`) until kit 2.100.0 |

Intel's list:

| Retired | Since kit | Why |
|---|---|---|
| `{tools}\models\openvino\Castellan-AI\Qwen3-4B-Instruct-2507-int4-cw-ov` | 2.103.0 | Castellan's Qwen3-4B, the route's model, text only, until Qwen3-VL-2B took its place (Qwen3-VL-2B on Intel's NPU, below); a PC whose 2B failed setup's test names it, and keeps it |

A route adds a file when it stops running it. Every PC reads the list, so one that still uses a file keeps it.

### Qwen3-VL-2B on Intel's NPU (kit 2.103.0)

From kit 2.103.0 Intel's NPU chats and reads pictures with one model: Qwen3-VL-2B-Instruct, as Castellan exported it to symmetric INT8 (`Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov`, 2.5 GB). OpenVINO Model Server's `--pull` takes it from Hugging Face, its 17 files pinned. It takes the place of the Qwen3-4B (`Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov`, text only) on every Intel generation. Until then an Intel PC's pictures went to its graphics card or its processor.

- **Why not before.** OpenVINO GenAI 2026.4.1.0, the one in OpenVINO Model Server 2026.4.1, fails Qwen3-VL on the NPU. The route runs on Castellan's build of it, which setup downloads and puts in before it tests the model (Castellan's build of OpenVINO GenAI, below).
- **Why the 2B.** On the NPU 3720 at OpenVINO's own prompt settings, the 2B answered 22 of 24 and 4 of 4 pictures, against OpenVINO's Qwen3-VL-4B's 23 of 24 and 4 of 4. It read a picture in 2.1 to 2.5 s against 6.6 to 7.1, did the three jobs in 18.7 s against 46.6, and held 4.4 GB against 6.9 (NPU-BENCHMARK.md, On Intel). Castellan's symmetric INT4 export of the 2B answered "Yes" to "Reply with the single word: ready" every time, so the route takes the INT8 one.
- **Its picture detail (DeepStack).** Qwen3-VL adds features from its picture encoder's middle layers to the first three layers of its language model, at the picture's positions. They carry a picture's fine detail. optimum-intel 2.2.0 exports that step as a masked add (`cumsum` and `index_select` over `visual_pos_masks`, times the mask), as OpenVINO's own Qwen3-VL exports have it. The NPU plugin's NPUW (2026.4.1, `ReplaceDeepstackScatterWithAdd`) recognises only transformers' own form, a `ScatterNDUpdate` of `GatherND(hidden, positions)` plus the layer's features, which it turns into a plain add of features it fills in itself. With the masked add it never fills `visual_pos_masks`, so the features were multiplied by zero:
  - On the NPU the 2B misread clear text that the processor and the graphics read right: TALLY 4827 in ClearType on 448 × 448 read "4837", on 896 × 896 "4877", and on 448 × 449 the text came back repeated ("TALLY TALLY 4827 4827 TALLY 4827"). Every NPU setting gave the same answers (chunk sizes, `GENERATE_HINT`, `PREFILL_HINT` STATIC, NPUW's `FOLD`, `DQ` and `DCOFF_SCALE` off, Intel's own `openvino_genai.dll`), and so did NPUW with every part on the processor (`NPUW_DEVICES` CPU). The processor's own pipeline with the features zeroed in the model gave the NPU's answers word for word.
  - Castellan's export has the three injections put back in transformers' form (`scatter_deepstack.py`, in its Hugging Face repository; the weights unchanged). With it the NPU gave the processor's answers on every picture, 16 of 16, and the processor's two pipelines and the graphics answered as before, word for word. The benchmark was unchanged: 22 of 24, 4 of 4 pictures, the jobs in 12.9 s against 13.4, 17.9 tokens a second against 17.3. Measured 2026-10-23 on the Core Ultra 5 225U.
- **Its prompt is read 256 tokens at a time** on the NPU 3720 (meteor-lake, arrow-lake and wildcat-lake: `NPUW_LLM_PREFILL_CHUNK_SIZE` 256, with `GENERATE_HINT` BEST_PERF and the prefix cache off as before). The 4B's 128 was its best (Per generation, below), but not the 2B's. Measured on the Core Ultra 5 225U, 2026-10-23, the server started as the kit starts it, each chunk compiled afresh:

  | Chunk | A short answer | A 1,805-token prompt | A 236-token picture |
  |---|---|---|---|
  | 128 (the 4B's) | 0.3 to 0.6 s | 4.3 to 4.4 s | 2.0 s |
  | 256 | 0.5 to 0.7 s | 3.8 to 3.9 s | 1.8 s |
  | 512 | 0.9 to 1.2 s | 3.7 to 3.8 s | 2.2 s |
  | 1,024 (OpenVINO's own) | 1.9 to 2.5 s | 3.9 s | 3.5 s |

  256 reads long prompts and pictures about a tenth quicker than 128, for about a tenth of a second more on a short answer. 512 is no quicker on long prompts and slower on short ones. With 256 the benchmark's three jobs took 12.9 to 13.4 s, against 18.7 at OpenVINO's own settings and the 4B's 27.4.
- **Its cap** stays 2,048 tokens (`--max_prompt_len`) on the NPU 3720, and Lunar Lake and Panther Lake keep the 4B's 4,096 in 512-token chunks. On the NPU 3720 the 2B at 4,096 in 512-token chunks answered the 1,805-token prompt and full-size screenshots too, and held 5.45 GB after them, 0.6 GB more than at 2,048. The route's `memoryGb` takes that for the Lunar Lake's chat (5.5).
- **Its pictures.** Qwen3-VL reads a token for each 32 × 32 px. The export caps a picture at 1,048,576 px (`size.longest_edge` in its processor configs), about 1,024 tokens, so the NPU's compiled prompt holds one with its question. The model's `pictureTokens: 1024` has the kit fit a larger one the same way (`fitPicture`), as for the X2's 2B. A 1920 × 1080 screenshot (1,043 prompt tokens) read its invoice number and a line's count right in 11 to 15 s; a 448 × 448 picture (229 to 236 tokens) took 1.5 to 1.8 s.
- **Large greyscale text on whole squares** reads wrong here too, the model's own doing (Qwen3-VL-2B on every Snapdragon X2, above): TALLY 4827 in greyscale on 448 × 448 read "487" on the NPU, the processor and the graphics, and in Qwen's own PyTorch model (bf16, transformers 5.0.0). On 448 × 449 it read right on all of them.
- **Its picture encoder runs on the processor.** OpenVINO GenAI runs the encoder on `AUTO`, which beside an NPU it limits to the processor (`MULTI_DEVICE_PRIORITIES` CPU). The server keeps the memory the encoder took: after a full-size screenshot it holds 4.8 to 4.9 GB, 1.9 more than once loaded (5.0 at its peak). On the graphics (`"DEVICE_PROPERTIES":"{AUTO:{MULTI_DEVICE_PRIORITIES:GPU}}"` in `--plugin_config`) the encoder read the screenshot in 6 to 7 s, almost twice as fast, but it read the 896 × 896 picture's 4827 as "4877" three times in four, which the processor read right every time. At `INFERENCE_PRECISION_HINT` f32 the graphics answered nonsense, in 25 s. So the encoder stays on the processor.
- **A PC set up with the 4B** keeps it until its local AI is set up again (Set up local AI). The keeper's look never downloads: it records `needs-setup` (`npu-refresh.json`). Until kit 2.103.0, setup with no ids left any configured NPU entry alone, so nothing acted on that record. Now `planSetup` reads it (`npuRefresh`), and sets up again an entry the look left for setup that runs the route's own server. One a person pointed at another server, or that no look has left for setup, is left as before. Setup downloads Castellan's build and the 2B (2.5 GB), puts the build in, and tests the 2B with a picture and a chat before it writes the NPU's entry. If the test fails, config.json keeps the 4B's entry, the record stays `needs-setup` (the next Set up local AI tries again), and the graphics card or the processor takes the pictures as before. Where the 2B doesn't fit (a 12 GB PC), the 4B's entry is left as it is. OpenVINO Model Server serves only the model it started with, so the test first stops the 4B's server, in the NPU's turn (`stopOtherModel`); otherwise the 4B's server would have answered the test with a 404. The 4B's folder is retired (Model files the routes no longer run, above): it goes three days after nothing names it.
- **No fallback.** The 2B is the route's own model on every Intel generation, not a generation's own as on the first-generation X, so there's no `fallback` to the 4B. A new PC whose 2B fails setup's test leaves chat and pictures to its graphics card or processor, as any failed test does.

### Memory on a 16 GB Intel PC (the NPU 3720)

The NPU 3720's PC (a Core Ultra 5 225U with 16 GB) shows Windows 15.43 GB, and its NPU and graphics have no memory of their own. Windows lets each of them hold 8.80 GB at once (DXCore's `SharedSystemMemory`, 2026-10-15), more than half, while the kit's budget for the NPU's models (`NPU_MEMORY_SHARE`, 40%) is 6.2 GB. Measured with the kit's own commands for `meteor-lake` (`npuEntry`: chat at 2,048 tokens in 128-token chunks, `BEST_PERF`, the prefix cache off), on private ports from a scratch tools home, two passes each, both servers loaded and then given twice over three short answers, a 1,498-token prompt, 200 tokens written, four queries, two batches of 16 of the kit's own code chunks (6,490 and 6,708 tokens) and two dense chunks (1,360 and 1,906 tokens):

| Embeddings | Chat | Embeddings | On the NPU, both | The PC's available memory, before / both loaded |
|---|---|---|---|---|
| On the NPU (kit 2.75.2) | 3.20 GB working set (3.07 before the requests, 5.14 at its peak while it loaded); 2.95 GB on the NPU | 1.16 GB (1.54 at its peak); 0.96 GB on the NPU | 3.91 GB | 8.46–8.50 / 4.16–4.22 GB |
| On the graphics (`embedArgs`, now) | the same | 1.14–1.27 GB; 0.80–0.81 GB on the graphics | 2.95 GB | 8.54–8.55 / 4.12–4.31 GB |

- **Both fit, with room.** The two servers took 4.2–4.4 GB of the PC's available memory, under the route's `memoryGb` for them (3.8 + 1.74 = 5.54 GB), which is itself 0.66 GB inside the budget; and the NPU held 3.91 GB of the 8.80 Windows allows it.
- **The Snapdragon's cut doesn't carry over** (kit 2.75.1). There the embedding server's memory was llama.cpp's KV cache and compute buffer; here it is OpenVINO's model compiled for a fixed shape, and at `--max_length` 512 it held more, 1.30–1.33 GB against 1.14–1.18, while 1,024 or 512 refuse Reeve's dense chunks (The NPU 3720's embeddings, above).
- **`memoryGb` stayed, for the 4B.** Chat's 3.8 GB was from the benchmark's end (3.72), after longer prompts than these. The embeddings' 1.74 is the Lunar Lake's, 0.5 GB over the NPU 3720's, but no PC's choice would change at 1.2: a 12 GB PC's 4.6 GB budget kept chat alone either way.
- **The 2B takes more** (kit 2.103.0, Qwen3-VL-2B on Intel's NPU, above). Its chat is 4.9 GB, since the server keeps what its picture encoder took, and the NPU 3720's embeddings on the graphics are 1.3: 6.2 GB, the budget exactly. Measured together after full-size screenshots, the two took 5.8 GB. A 12 GB PC's 4.6 GB no longer holds the chat.
- **Chat's working set peaks at 5.1 GB as it loads**, from its compile cache, and settles at 3.1 GB once loaded. A 16 GB PC has the room, and the budget counts what a server holds once loaded.
- **The Lunar Lake** (the 4B's chat 4.3 GB at 4,096 tokens, measured with its prefix cache on, and embeddings 1.74) came to 6.04 GB against a 16 GB PC's budget of 6.1 to 6.4: it fit, with little to spare. With the cache off it should hold less, as the NPU 3720 held 0.4 to 0.6 GB less at 4,096, but it won't be measured again. The 2B's chat at 4,096 is 5.5 GB (measured on the NPU 3720), so from kit 2.103.0 a 16 GB Lunar Lake or Panther Lake has no room for embeddings beside it (5.5 + 1.74 = 7.24 GB): the graphics card or the processor makes them.

### FastFlowLM's pictures with sides of 32 px (AMD)

FastFlowLM 1.0.7 misreads a picture it doesn't shrink when one of its sides is a whole number of 32 px. Its `--img-pre-resize` 2 (the default, the route's) shrinks only a picture taller than 720 px. The model's own resize then brings each side to a whole number of 32 px (16 px patches, merged in twos), and a side that already is one comes out misread. It was found from Smith's audit, whose vision check (TALLY 4827 in black on a white 512×512 PNG) failed on the Krackan.

Measured there on 2026-10-16, asking each picture "What text is written in this image?" at temperature 0. With Qwen3.5-2B (the route's model), on a server of its own:

| Picture | Tokens | Answer |
|---|---|---|
| 512×512 | 284 | wrong ("tuya") |
| the same, redrawn at 513×513 | 284 | right |
| 500×500, 520×520 (the 512 redrawn), 600×600 | 284–389 | right |
| 640×640, 704×704, 960×540, 1024×576 | 428–604 | wrong |
| 1280×720 | 948 | wrong ("TALLY 482") |
| 1281×721 (the same, redrawn), 1290×720 | 948 | right |
| 1280×360, 1440×720, 2560×720 | 468–1,868 | wrong |
| 720×360, 1272×360, 2550×720 | 281–1,868 | right |
| 1920×1080, which FastFlowLM shrinks to 1280×720 | 948 | right |

One picture broke the pattern: 700×700 read "TALLY 487", a digit short. Through the kit's own `Npu.vision`, with this PC's Qwen3-4B vision model (qwen3vl-it:4b), the 512, 640, 1280×720, 1280×360 and 1024×576 pictures read "1482" or "TALY4827" as sent today, and all five read right with the quirk. Neither the format (32-bit or 24-bit PNG, JPEG) nor the alpha channel changed it.

So the route has the quirk `sides-of-32`. Before a picture goes to FastFlowLM, the kit's `fitPicture` makes a side of a whole number of 32 px a pixel longer, on a picture 720 px tall or less. It redraws the picture with System.Drawing (high-quality bicubic) and sends it as a PNG `data:` URL. The redraw took 59 to 74 ms in the agent's PowerShell worker. The model's resize brings the picture back to the same number of patches, so it costs no tokens.

Enlarging such a picture to 720 px tall fixes a square too, at twice the tokens, but not a wide one: 1280×360 enlarged to 2560×720 still misread ("ITALY 487"). A picture whose size the kit can't read from its header (WebP) goes as it is. FastFlowLM 1.0.8's and 1.0.9's notes mention no fix. When a later version reads these right, the route drops the quirk.

**1.0.10 still misreads them** (kit 2.111.0, 2026-10-23, Qwen3.5-2B, the same tally picture sent as it is): 512×512, 640×640, 1280×720 and 1024×576 wrong ("FALLY", "TALLY", "taly492", "taly"), 513×513 and 1281×721 right. So the quirk stays. **llama.cpp's Qwen3-VL-2B misread the same four too** (b11734 Vulkan on the Radeon 860M, Q4_K_M and its Q8_0 projector, the model setup gives a graphics card: "Taly487", "Taly 487", "TALY 47", "Taly 87") and read the same two right, once each on one PC. The kit doesn't nudge a card's pictures: that's to measure on other cards and pictures first, against the X2's finding that a pixel's resample blurs small screen text (Qwen3-VL-2B on every Snapdragon X2, above).

## Detection

Detection asks Windows for the devices it lists as **Neural processors** (the `ComputeAccelerator` device class, as Heiward's `NpuHardware.cs` reads it), with their maker, PnP device id and driver (`DETECT_PS`, its `npu2|…` line). A PC whose Windows lists none is asked for a Hexagon driver as before.

- **Maker**: Qualcomm (or a Hexagon name), Intel, or AMD ("Advanced Micro Devices", or AMD as a word), from the maker and the name.
- **Generation**: a Snapdragon by its name, the X2's first (`X2E`/`X2P`, "X2 Elite", "X2 Plus": `snapdragon-x2`, which covers the X2 Elite Extreme's E2E94100, X2000096 and XG002002 and the X2 Elite's EG102004 and XG201032 too), then the first X's (`X1E`/`X1P`, `X1` and five digits as the plain X's X124100, X126100 and X126101, "X Elite", "X Plus", "Snapdragon X -", and the dev kit's X1E001DE: `snapdragon-x`), then the ones before it (`snapdragon-8cx`, below). A name that doesn't say which Snapdragon (a bare "Qualcomm Hexagon NPU") is told by its ACPI device id, as Qualcomm's drivers bind them (`devices.qualcomm`: `0D0A` and `0D19` the X, `qcnspmcdm8380.inf`; `0FF0` (this laptop), `104F` and `1050` the X2, `qcnspmcdm8480.inf`); where both say, the name wins, so a Snapdragon setup doesn't know by name stays `unknown` whatever id it lists. A Hexagon seen only by its driver (the older `npu|` line, with no device id) is a Snapdragon before the X: every X and X2 lists its NPU as a Neural processor. Intel and AMD by the PCI device id (`npu-vendors.json`'s `devices`: Intel `7D1D` Meteor Lake and Arrow Lake-U and -H (a Core Ultra 5 225U shows it, 2026-10-14: Intel's driver serves `7D1D` and `AD1D` from one NPU 3720 section; Arrow Lake-H's is Linux's intel_pmc_core, commit `f2eae58c4428bd792c8e91e3666ab0718d87b44a`, "platform/x86/intel/pmc: Fix Arrow Lake U/H NPU PCI ID": it defines `ARL_H_NPU_PCI_DEV` `0x7d1d` beside `ARL_NPU_PCI_DEV` `0xad1d`, and its message says Arrow Lake-H and -U have a different NPU device from Arrow Lake-S), `AD1D` Arrow Lake-S and -HX (Arrow Lake-HX is the S die in a laptop, so `AD1D` is expected, but it has never been seen), `643E` Lunar Lake, `B03E` Panther Lake, `FD3E` Wildcat Lake, as Linux's ivpu driver lists them; AMD `1502` XDNA, the Ryzen 7040 and 8040, `17F0` XDNA 2). Anything else from a known maker is `unknown`, tried on guessed values (below).
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

**Once FastFlowLM answers, setup checks AMD's `xrt-smi`, the tool FastFlowLM sets the NPU's power mode with.** This is the route's `powerTool`, checked by `checkPowerTool`.
- **The problem:** `flm serve` runs `C:\Windows\System32\AMD\xrt-smi.exe configure --pmode` at each start and ignores the result. An older AMD NPU driver may have left its `xrt_core.dll` and `xrt_coreutil.dll` in `System32\AMD`. If so, xrt-smi loads them instead of the current driver's copies (in `System32`) and can't start: exit 0xC0000139, an entry point not found.
- **Where it was found:** on the Krackan, 2026-10-15. Dell's factory image had left AMD's kipudrv 10.1109.8.196, of 2024, which no device used.
- **The check:** setup runs `xrt-smi examine`, which only reads. It runs it from Node, where the loader's failure stays silent; from PowerShell's Start-Process it shows a dialog and waits for a click.
- **On that exit:** the NPU is used all the same, at its default power mode. Its note says why: "The NPU (…) is used, at its default power mode: an older AMD NPU driver left its files in Windows\System32\AMD, … (an administrator's job, with pnputil /delete-driver)." Nothing on the PC is changed.
- **The NPU check:** its report has a `power-tool` step on every run. The step is noted, never failed, so the reports count the PCs where this happens.
- **The fix on the Krackan:** removing the old package (`pnputil /delete-driver oem73.inf`, as an administrator) fixed it. The real xrt-smi ran, and `configure --pmode` worked without an administrator.

## What setup does (NPU first, then graphics cards, then the processor)

Manor's **Set up local AI**, `smith accelerators setup` and the Settings pages' Set up all run the kit's `setupCommand`:

1. **Plan, and ask.** It lists what it would install for the NPU (its server and each model, and whether they're already here), then each graphics card's llama.cpp build and models, then the total download, then the maker's terms that come with it (a Snapdragon's: Licences, below), and asks before downloading anything (`--yes` skips the question; `--dry-run` only plans).
2. **The server**: downloaded whole, its size and SHA-256 checked against the pinned ones in `npu-vendors.json` (a mismatch deletes the file and stops), then installed for this user: GenieX's installer with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER` and `/LOG=` the tools home's `npu-installer.log` (an Inno Setup installer prints nothing, so its log is the only place it says why it stopped: a failure's line carries the message box it would have shown and its last telling line, such as "Uninstall failed (ErrCode: 2). / InitializeSetup returned False; aborting.", and names the log, which is kept until an install works; kit 2.83.1), the others unpacked into the tools home's `servers\` (`%USERPROFILE%\.manor\accelerators\servers\`). Nothing needs an administrator. A server already installed is used as it is.
   - **Castellan's signed build** (kit 2.108.0), where the route has one for the version it installs (`signedBuilds`, `NpuSignedBuild`): GenieX without its installer. Smart App Control blocks GenieX's installer, whose temporary setup program isn't signed, and then its own files, which Qualcomm doesn't sign. Qualcomm's SDK zip of the same version (`geniex-sdk-windows-arm64-v<version>.zip`) carries GenieX's folder in its `lib` folder, file for file, but for `geniex.exe`; its QAIRT runtime and Hexagon libraries are Qualcomm's, signed. So setup downloads that zip from Qualcomm's release and Castellan's zip of signed copies of GenieX's own unsigned files (`geniex.exe` among them, with each source's notices), both pinned by size and SHA-256, puts the `lib` folder together beside where GenieX goes with the signed copies laid over it file by file, and moves it into place (`installSignedBuild`; `NpuPlan.build`, in place of `download`). The copies are GenieX's files with Castellan's signature added and nothing else changed (BSD-3-Clause, and llama.cpp's MIT); the QAIRT runtime comes only from Qualcomm. `copies` pins each by its path, as Qualcomm ships it and signed, so the plugin patch takes a signed copy as GenieX's own (`sameFile`, below). A GenieX already installed, by its installer or a person, is left as it is.
   - **Castellan's signed catalog** (kit 2.108.0, catalogs.ts), where the route has one for the version it runs (`catalogs`, `NpuSignedCatalog`): FastFlowLM's, whose maker signs none of its program files. Where Smart App Control is on, setup installs it in Windows' catalog database before anything of the server runs, asking once for an administrator, and removes the route's older ones in the same prompt. The server is still downloaded from its maker, unchanged. FastFlowLM 1.0.10's (`castellan-amd-fastflowlm-1.0.10.cat`, its 36 unsigned program files) since kit 2.111.0; 1.0.7's stays listed, for a server at that version.
   - **Its runtime**, where the route names one (`runtime` in `npu-vendors.json`): OpenVINO Model Server needs the Microsoft Visual C++ runtime, which a PC may not have and which only an administrator can install for everyone. So setup downloads Microsoft's own package of those DLLs (the Visual Studio catalog's CRT redist, 3 MB, size and SHA-256 pinned) and copies its five DLLs beside `ovms.exe`, where Windows looks first. A server that has them all beside it isn't given them again. Until kit 2.65.0 the route was refused on a PC without the runtime, with "administrator installs once": nothing the person could act on, and the NPU never showed.
3. **The models**: each pulled with the server's own command, unless it is already there. Where `npu-vendors.json` pins a model's files for this generation (GenieX's Qwen3-VL-4B on the X2 Elite, measured on the owner's laptop), each file's size and SHA-256 are checked after the pull.
4. **Its embedding server**, where the route has one (the Snapdragon's): its zip downloaded and checked against its pinned SHA-256, unpacked into the tools home's `servers\llama.cpp\`, the route's server's files copied over it, and its model downloaded into `models\` (checked the same way) unless it's there. When a graphics card is set up too, the card uses that same file rather than downloading it again.
5. **A test request** in the NPU's turn (its lock and line): the server started if it isn't running, one short chat answer, which must say "ready" as asked and nothing degenerate (a model that doesn't run properly on an NPU answers fast, with nonsense: "?option?option…", kit 2.65.0; the same few characters five times over is refused since kit 2.68.0), and one about a small picture when it serves vision. The first load may take minutes (OpenVINO compiles the model for the NPU), so it is given 15. Then its embedding server, started the same way, embeds three sentences (kit 2.68.0): their vectors must have the model's dimensions where the route names them, be numbers and not all zero, and put "a cat" nearer "a kitten" than "an invoice".
6. **Measuring**, on every NPU (since the kit after 2.77.9; before it, only on an unverified generation): a warm "ready", a count to twenty (which must count) and a prompt of about 1,000 tokens read. On a generation nobody has run the NPU check on (`verified: false`, kit 2.68.0) this is **calibration**: the entry gets this PC's own timeouts from the first two and from how long the test request's first load took (Calibration below), and one that writes under 2 tokens a second is too slow for the chat model, and isn't used. On a verified one the numbers go only into the NPU's report, and the NPU is used whatever they say.
   - **The NPU's report** (spec/NPU-REPORTS.md): what setup set up and measured, or why it left the NPU out, as ids, versions, times and a failed step's code, kept in `npu-report.json` beside `npu-note.json`. The app shows it to its owner and sends it to the Exchequer only on their word; their reports, counted, verify generations and widen timeouts in this file (`npu-reports.ts`).
7. **Only then** is the `npu` entry written into config.json, beside the cards'. Any failure (download, installer, pull, checksum, test, calibration) leaves no NPU entry, and the rest of setup goes on. A failure of the embedding server alone leaves the entry without embeddings.

**The NPU failing is never an error** (kit 2.68.0). Setup logs what failed as a `note:`, not a `problem:`, and its exit code doesn't count it: Manor shows nothing red, and nothing raises an alarm. Chat and embeddings fall back separately: what the NPU doesn't serve goes to a graphics card set up beside it, else setup sets the processor up for it in the same run (asking first, for its download, unless `--yes`). Why the NPU, or its embeddings, isn't used is kept in plain words (`npu-note.json` in the tools home, cleared once the NPU is set up whole) and shown with the accelerators (`smith accelerators`, the report's `npuNote`), e.g. "The NPU (Core Ultra Series 1, 200U or 200H, Meteor Lake or Arrow Lake-U or -H (NPU 3720)) isn't used: it didn't answer its test in time. The graphics card or the processor does its work instead."

**The graphics card beside the NPU** (kit 2.69.0). With Manor's "Use the graphics card for models when there's an NPU" off (`gpuWithNpu`, read by `setupCommand`), a card is set up only for the work no NPU serves, and the work the PC's work order puts it first for (kit 2.135.3), the rule requests and the keeper follow (ACCELERATORS.md): beside Intel's NPU, vision alone, so the card's chat and embedding models (about 3.1 GB) aren't downloaded; beside AMD's XDNA 2, pictures and embeddings, never chat; the plan lists the rest as left to the NPU. What the NPU fails at setup goes to that card in the same run (its second pass, before the processor's); an NPU that fails outright leaves the card everything. A card the NPU would leave nothing (a Snapdragon's) is set up whole, as before: Manor offers the switch only beside a configured card. With the switch on, or no Manor, every card is set up for everything; turning it on later, the next Set up fills the card's other kinds in. A card set up before keeps the entries, ports and files it had for the NPU's work: nothing is removed, and the keeper keeps them out.

**Memory first** (kit 2.68.0). The NPU has no memory of its own: its models sit in the PC's, beside Windows, the browser and the manor's agents. Setup gives the NPU at most 40% of the PC's memory (`NPU_MEMORY_SHARE`), against the route's measured sizes (`memoryGb`: on Intel, chat 4.3 GB at the 4,096 cap and embeddings 1.74 GB, measured on the Lunar Lake; chat 3.8 GB at the NPU 3720's 2,048, its prefix cache off). A 16 GB PC (about 15.6 GB to Windows: 6.2 GB) keeps both, with over 9 GB left; a 12 GB PC (4.6 GB) keeps chat and makes embeddings elsewhere; an 8 GB PC (3 GB) keeps the NPU out. 40% because it lets the common 16 GB laptop keep both models with over 9 GB for everything else, while on an 8 GB PC chat alone (3.8 to 4.3 GB, half the PC) would leave Windows, a browser and the agents under 4 GB and paging. Memory that can't be read never keeps the NPU out.

An NPU entry a person configured is left alone unless `npu` is asked for by name. One on the route's own server that the keeper's look left for setup (`needs-setup`: this kit's command for it needs a download, as a new model does) is set up again from kit 2.103.0, and kept should the new one fail its test (A later kit's command, below). The GenieX entry an older install wrote by default is replaced by a set-up one, and dropped on a PC whose NPU the manor can't use.

The entry carries everything an agent and the keeper need: the server's `startCommand` (with its port), its `env` where the server needs one (OpenVINO Model Server's `PYTHONHOME` and `PATH`, as its `setupvars` script sets them), the caps, the timeouts and the quirks.

### Setup from inside a packaged app (kit 2.113.5)

The Claude desktop app is an MSIX package, and so is every process a session in it starts. Windows keeps what such a process writes under AppData (%LOCALAPPDATA%, %APPDATA%) in the package's own folder (`%LOCALAPPDATA%\Packages\<package>\LocalCache`), and its HKCU writes in the package's own hive. The process that wrote them reads them back where it wrote them; nothing outside the package sees them. The profile itself, `%TEMP%` and `%ProgramData%` aren't redirected.

On 2026-10-24 an X2 Elite's NPU failed every request for days because of this. GenieX 0.9.3 and Castellan's build of its plugin had been set up from a session, so both sat in the package alone. The staff, started by Task Scheduler, found no `geniex.exe` and got `spawn … ENOENT`. Of the routes' steps, only Qualcomm's write AppData: GenieX's installer (its files in `%LOCALAPPDATA%\GenieX CLI`, and HKCU) or Castellan's signed build put together there, and the plugin patch in its `llama_cpp` folder. GenieX's models go in `%USERPROFILE%\.cache\geniex`. Intel's OpenVINO Model Server, its GenAI build, `.npu-cache` and models, AMD's FastFlowLM (its models in `%USERPROFILE%\.flm`), llama.cpp's builds and every GGUF go in the tools home. The servers setup tests write their own caches to AppData too (llama.cpp's OpenCL kernels in `%LOCALAPPDATA%\llama.cpp\cl-cache`).

So `setupCommand` first plans, says the plan and asks, as always. Then, when one of its process's ancestors runs from `WindowsApps` (outside.ts' `packagedApp`, Manor's `insidePackagedApp` ported), it runs the rest outside, on every route. The walk up the parents stops at one that has exited (a session's command run under Git's `timeout`), and Windows' own `GetCurrentPackageFullName` says "no package" for a session's processes though their writes are redirected. So from kit 2.115.0, where the walk finds no package, the redirect itself is the test (`redirectedTo`): a marker written in `%LOCALAPPDATA%` that shows under a package's `LocalCache\Local` was kept by that package. The marker is removed either way. That run is a one-off Task Scheduler task, as `manor install`'s hop does it: no trigger, this user's interactive token at least privilege, hidden, `conhost --headless node outside-run.ts <folder>`, deleted when done. Its folder is `outside\<id>` in the accelerators' home, which both sides see. The session shows the run's lines as it writes them, and gets back its exit code and entries. The run sets the kit's own variables from the session's (`carriedEnv`, never a secret's) and `KIT_OUTSIDE=1` before loading the kit, and doesn't ask again (`asked`). Where Task Scheduler won't take or start the task, the steps `writesAppData(plan)` lists are refused in a plain message and nothing is set up; a plan with none (Intel's, AMD's) runs in the session, with a note. The keeper's plugin patch (npu-patch.ts) moves a file in AppData the same way, as `patch-in` and `stock-back` jobs.

Machine-wide installers don't come into it. Nothing a route installs needs an administrator, and the one prompt setup can raise (Castellan's signed catalogs, `catalogs.ts`) writes Windows' catalog database, which isn't redirected.

### Each work's order on a generation (kit 2.111.0)

The NPU first was the rule for every work (ACCELERATORS.md, Choosing an accelerator). A generation may now record, as `order` in `npu-vendors.json`, the device each work spends least energy on, then the next, with the figures behind it (`basis`, the device named beside each figure). Setup writes it into config.json as `workOrder` (the devices, and any `runningFirst` and `batchAt`, without the figures: npu-vendors.ts' `workOrderFor`), whether or not the NPU could be set up. Requests follow it (the core's `candidates`), and so does setup's fallback when the NPU can't take a work (Smart App Control blocked FastFlowLM, or its test failed): the work goes to the devices after the NPU in its order (`fallbackDevices`), a graphics card and then the processor unless the order puts the processor first. A work the order leaves out goes to the NPU first, as before, and a generation with none writes none. Each field is optional, so an older kit (the Smith pins 2.99.1) reads the catalog and config.json as before, without it. A PC set up before kit 2.111.0 got it the next time setup ran (on AMD, setting FastFlowLM 1.0.10 up was that time: the keeper's look leaves it for setup). **A later order reaches PCs already set up** (kit 2.135.1): the keeper's look (npu-refresh.ts' `orderNow`), once for each kit version, writes this kit's `workOrderFor` over config.json's `workOrder` when they differ, whatever comes of the NPU's servers, and on a PC whose NPU has no entry but whose setup wrote an order. Only setup and this look write it, so nothing of a person's is lost. A PC set up before kit 2.111.0 whose card has no vision model still needs Set up local AI for its pictures to go to the card: the look plans no card.

Only AMD's Ryzen AI 300 (XDNA 2) records one. The Snapdragon's NPU spends least on every work. Intel's records none. On the NPU 3720 (a Core Ultra 5 225U, NPU-BENCHMARK.md) the NPU spends least on chat, its embeddings already run on its graphics (`embedArgs`), and its pictures stay on the NPU (Intel's pictures stay on the NPU, below). Intel's other generations aren't measured.

**AMD's figures.** A Ryzen AI 7 350 w/ Radeon 860M (Krackan, 16 GB), the package meter (Windows' Energy Meter, `rapl_package0_pkg`: the chip's energy, there being no whole-PC part), each job over the PC at rest. npu-bench's quick profile, three runs on each device, medians, kit 2.99.1, 2026-10-23 (NPU-BENCHMARK.md):

| Job | NPU (FastFlowLM 1.0.7, Qwen3.5-2B) | Radeon 860M (llama.cpp b11734 Vulkan) | Processor (llama.cpp b11734) | The order |
|---|---|---|---|---|
| Triage | 26.4 J | 40.7 J | 88.6 J | chat: NPU, Radeon, processor |
| Reply | 27.5 J | 87.3 J | 79.4 J | |
| Summary | 48.7 J | 89.8 J | 128.5 J | |
| Read 1,024 tokens | 31.1 J | 32.2 J | 87.5 J | |
| A picture | 26.1 J | 12.1 J | 22.8 J | vision: Radeon, NPU, processor (whoever's server is up, kit 2.135.1) |
| Embeddings, a token | none on this route | 12.8 mJ | 44.1 mJ | embed: Radeon, processor |

The Radeon and the processor ran Qwen3.5-2B Q4_0 (and its F16 projector) there, and Qwen3-Embedding-0.6B Q8_0 for embeddings. FastFlowLM 1.0.10 is the same within noise (NPU-BENCHMARK.md). Embeddings on AMD already went to the Radeon: FastFlowLM's embedding model is EmbeddingGemma, which the manor avoids (Licences), so setup gives them to a card or the processor, and the order records why the Radeon comes first.

**A picture from a stopped server.** Setup gives a graphics card Qwen3-VL-2B for pictures (Q4_K_M and its Q8_0 projector, on one server with its chat), not that series' Qwen3.5-2B, and a card's servers rest after 5 minutes unused on a PC under 20 GB. So the same PC, FastFlowLM 1.0.10, NPU driver 32.0.20102.4480, three interleaved rounds, means (range), 2026-10-23:

| | Radeon 860M, Qwen3-VL-2B | Radeon 860M, Qwen3.5-2B Q4_0 | NPU, FastFlowLM 1.0.10 |
|---|---|---|---|
| Its server started, and one picture | 66 J in 3.9 s (55–86 J; 86 its first load ever) | 73 J in 4.4 s (69–76 J) | 177 J in 10.8 s (164–192 J) |
| Each picture after that, warm | 10.4 J in 0.47 s (10.0–10.7 J) | 13.7 J in 0.64 s | 26.6 J in 1.28 s |
| Its server's memory | 2.8 GB | 2.8 GB | 3.8 GB |
| The suite's four pictures, twice each | 8 of 8 right | | 6 of 8 (its 472 read as 13) |

So pictures go to the Radeon first. Starting its server costs about 56 J over a warm picture there. With FastFlowLM already up, a lone picture costs less on the NPU (26.6 J against 66), and the Radeon wins its start back only from the fourth picture in a row: n pictures cost about 55.6 + 10.4n J there from a stopped server, against 26.6n J on the NPU, the same at 3.4 pictures. **The owner's answers** (2026-10-23): asked by the AMD manager where pictures should go, "Radeon unless only NPU up"; then, to the Snapdragon manager, "keep single pictures on the NPU when it's running, but send batches of 4 or more waiting pictures to the Radeon." So until kit 2.135.1 a picture went to the Radeon, unless FastFlowLM was up and the Radeon's server wasn't (`runningFirst`), and then too when 4 or more pictures waited (`batchAt`). With both servers up, a single picture went to the warm Radeon (10.4 J against 26.6 J): the owner's ruling on that case, to the Snapdragon manager, of "With both servers up, a single picture stays on the NPU. Only batches of 4 or more go to the Radeon.", was "actually change that, make it the gpu instead". A picture's request looked at each candidate's server first (accelerators.ts' `serversUp`: a GET of its `/v1/models`, all at once, waiting 0.5 s at most and starting nothing; a refused connection is down, any other answer or none is up), and put those up first, the order kept otherwise. The NPU first that way was the NPU first as ever: the only candidate, waited for when busy.

**The owner's ruling** (2026-10-24, to the Snapdragon manager): "Yes: AMD single pictures go to the Radeon." So from kit 2.135.1 every picture goes to the Radeon, whoever's server is up, and vision's order has no `runningFirst` or `batchAt`: the Radeon reads the pictures right where the NPU doesn't (8 of 8 against 6 of 8, its 472 read as 13), and a warm picture there costs 10.4 J against 26.6 J. A lone picture that starts the Radeon's server costs more than one on an NPU already up (66 J against 26.6 J): the price of the better read. No server is asked whether it's up (`serversUp` asks only for an order with `runningFirst`). The NPU reads a picture only when the Radeon can't: no card, Manor's "Use the graphics card for models when there's an NPU" off, a card that failed lately, a game's, or one rested after a long line. The Radeon's server, once up, holds its 2.8 GB beside FastFlowLM's 3.8 GB until the keeper stops it, after 5 minutes unused on a PC under 20 GB. PCs already set up get the order at the keeper's next look (above).

**Counting the pictures that wait** (npu.ts' `waitingFor`): this agent's pictures from when each is asked until its turn starts, so a batch sent at once counts itself whole, and other agents' tickets in the lines of the accelerators that serve pictures that say they're pictures (a ticket's `work`, NPU-QUEUE.md; a program that doesn't write it counts as none). A caller that knows it's sending a batch (a folder of screenshots) says how many (`AskOptions.batch`), and the larger of the two counts. Another agent's pictures count once each is in line: an agent queues its background requests on an accelerator one at a time. **Pictures wait in the Radeon's line** (kit 2.112.1). Until then the pick shared them out: an agent's background pictures count those of its own already headed to a line, so from the second the Radeon looked busier than a free NPU, and most of a batch of 4 ran there at 26.6 J rather than the Radeon's 10.4 (found by the Reeve session, 2026-10-24); so did a picture sent while the Radeon answered another. Now the first in vision's order that can take a picture is its only candidate, as the NPU first is (with `runningFirst` or a batch from kit 2.112.1; for every work order from kit 2.135.1, so AMD's embeddings wait for a busy Radeon too, rather than going to the processor at 44.1 mJ a token against 12.8): a busy Radeon is waited for, about half a second a picture. The NPU takes it when the Radeon failed lately, is a game's, or is rested after a long line. Until kit 2.135.1, once a batch had started the Radeon's server, the pictures after it went there too (`runningFirst`, both up). With Manor's "Use the graphics card for models when there's an NPU" off, the Radeon isn't set up for pictures, and they stay on the NPU.

**Intel's pictures stay on the NPU** (the NPU 3720 on a Core Ultra 5 225U, 2026-10-24). In the benchmark's Arc run, OpenVINO Model Server on the graphics, a picture cost 13.3 J over rest. On the NPU it cost 17.5 J, and 14.6 J of that was the cores', since the NPU route's picture encoder runs on the processor (Qwen3-VL-2B on Intel's NPU, above). By AMD's rule, the Arc would take batches, and single pictures once its server is warm. But neither of the Arc's servers gives that saving with the right answers:

- **OpenVINO on the graphics misreads fine text.** With its encoder on the Arc, it read the 896 × 896 tally picture (TALLY 4827 in greyscale) as 4877 three times in four. The 513, 449 and 448 px pictures it read the same each time, as the processor does. That is the misread it made with the NPU route's encoder moved to the graphics (above). The NPU and the processor read the 896 px picture right, and a screenshot is larger still. Setup also gives the Arc no OpenVINO server: it would be a third server beside the NPU's two, and those two already hold the 16 GB PC's whole budget (Memory on a 16 GB Intel PC, above).
- **The card's own server spends more than the NPU's.** Setup gives Intel's integrated graphics llama.cpp's Vulkan build with the picture encoder on the processor (setup.ts' `encodesOnProcessor`: with the encoder on the graphics, they lose the device). Measured with the manor running, in three rounds that took three servers in turn, the order rotating. Each started from stopped and read one picture, then read the suite's four pictures twice, warm. The first warm picture is left out: it repeats the start's picture, and llama-server answered it from its cache.
  - **The card as setup gives it now** (LLAMA_PIN b11734, Qwen3-VL-2B Q4_K_M with its Q8_0 projector, MODEL_PINS): 36 J a new picture over rest (30–48 J, the middle half) in 1.9 s; 20–68 J to start and read a first picture, in 3.6–6.1 s; 3.2 GB held.
  - **The NPU in the same rounds:** 20 J a picture (18–26 J) in 1.4 s; 57–90 J to start and read a first picture, in about 7 s. The benchmark's 17.5 J was measured with the manor stopped.
  - **This PC's card as an older kit set it up** (b11669, Qwen3-VL-4B Q4_K_M): 46 J (35–59 J) in 2.7 s; 73–96 J to start; 4.9 GB. A card moves to the 2B at its next Set up local AI, which plans every card again; the keeper's look downloads nothing.
  - **Answers:** the suite's four, the same on all three.

So as the manor runs it, a picture costs about 1.8 times as much on the Arc as on the NPU, whatever the batch size. No `batchAt` pays, and Intel's vision has no order. That changes if OpenVINO's encoder on the graphics reads fine text right, or if llama.cpp's Vulkan build keeps its device with the encoder on Intel's graphics.

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

A generation in `npu-vendors.json` can carry its own `timeouts`, `maxContextTokens`, `caps`, `args` (replacing the value of a flag the route's command already has) and `memoryGb` over the route's (`routeFor`), and `models`, the models it runs in the route's place (kit 2.78.8: the X2's Qwen3-VL-2B, above), and `smallPc`, the models it runs over those on a PC under 20 GB (none now). Intel's, from the Lunar Lake's numbers and how the others compare (kit 2.68.0):

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

A route's command changes between kits: Intel's NPU 3720 got its 128-token prompt chunks (`--plugin_config`), and a generation its own `--max_prompt_len`. Setup leaves a configured NPU alone, so before this a PC kept the command it was set up with until someone ran setup again. On the 225U the shipped command answered a short question in 3.1 s and the chunked one in 0.5 s, with the same answers. The keeper now brings the entry up to its kit's command once for each kit version, only when nobody is using the NPU and the new command answers its test, and never takes back a newer kit's ([ACCELERATORS.md](ACCELERATORS.md), the keeper). A command that needs a download, such as a new server version or another model, is still left for setup: the look's record says `needs-setup`. Until kit 2.103.0 nothing read that record, and setup with no ids (Manor's Set up local AI) left a configured NPU alone, so such a PC stayed on its old command. From kit 2.103.0 `planSetup` reads it (`npuRefresh`), and an entry the look left for setup, on the route's own server (`runsRoute`), is set up again: downloaded, tested, and written only if it answers. A failed test keeps the old entry, and the record stays `needs-setup`, so the next Set up local AI tries again. From kit 2.115.0 the keeper's look runs that setup itself, in the background (Set up again when the kit's pins move on, below). Where the new model doesn't fit beside everything else, the old entry is left as it is. From kit 2.88.1 the look plans at the server version the PC has, not the route's own (A later GenieX on the PC, above).

Since kit 2.86.0 the same look offers the NPU its own embeddings where its entry has none, with nothing downloaded. The Snapdragon X2 Elite set up before kit 2.63.0 had its chat on the Hexagon and its embeddings on the Adreno: with Manor's `gpuWithNpu` off, Reeve's search used npu-embed's nomic-embed-text v1.5 (every input cut to 128 tokens; 8 of 9 in the eval above) and Chamberlain's and Clerk's embeddings the card. The Hexagon's llama-server (b11125) and Qwen3-Embedding-0.6B were already on it, the model being the card's own file, so the look takes them up after their test: 124 ms a chunk against the card's 265, 9 of 9, the card's own vectors (an index made by either serves both), and the card left to the person. Reeve's indexes, named by their model, are built again once with Qwen3-Embedding (Reeve's settling in).

### A server whose program is missing (kit 2.113.5)

A server's program can be gone from where its entry starts it. It may have been set up from inside a packaged app before kit 2.113.5 (Setup from inside a packaged app, above), or someone removed its files. A request to it then fails at once with `ProgramMissing`: "… isn't installed where the staff look for it (…)" (accelerators.ts). The keeper's look (`startRepairs`, server-repair.ts) sets it up again, as Manor's Set up local AI would with `--yes`, for that accelerator alone: `npu`, or a card or the processor for what it served. Setup itself runs outside a packaged app where the keeper runs in one.

- **Only a program setup puts there** (`setupFolders`): one in the tools home, or in a route's install folder (GenieX's `%LOCALAPPDATA%\GenieX CLI`). A person's own command (a script, a program elsewhere, one on PATH) is never replaced, and a switched-off entry is left alone.
- **Missing for 5 minutes** (`REPAIR_AFTER_MS`) across looks first, so a setup or an update replacing it meanwhile isn't taken for a loss. A program whose path changes starts its 5 minutes again.
- **One server a look**, in the background, never while the NPU's refresh tests its servers, and never while the manor is stopped.
- **At most every 6 hours** (`REPAIR_AGAIN_MS`) while setting it up doesn't bring it back.
- What it did goes in the keeper's log, setup's lines too. It's remembered in `server-repair.json` beside config.json: since when each program was missing, when it was last set up again, and setup's code. A program that's back is forgotten.

### Set up again when the kit's pins move on (kit 2.115.0)

Setup writes an entry once. So a kit that pins another llama.cpp build, another model for a card or the processor, or another server or model for the NPU (AMD's FastFlowLM 1.0.7 to 1.0.10, the X2's GenieX 0.9.1 to 0.9.3) reached only the PCs set up after it, until someone pressed Set up local AI again. The owner's decision (2026-10-24): the manor sets such an accelerator up again by itself, in the background, gently, outside the Claude app, with no action from the person. The keeper's look does it (`startRepairs`, set-up-again.ts), every 10 minutes at most, after a missing server's repair:
- **What is behind** (`behindPins`). A card's or the processor's entry whose servers run from the kit's llama.cpp folder and load models from its models folder, where a plan made from the pins alone (nothing asked of the network) would start another build or load other files. An entry of the person's own (another program, a model file of theirs) is never set up again, nor a switched-off one. The NPU's when the keeper's look at it, this kit's, found its command needs a download (`needs-setup`, A later kit's command, above): its server's version, its models, its embedding server. That is the path `needs-setup` takes now, rather than waiting for Set up local AI.
- **What its work order adds** (kit 2.135.2, `orderAdds`). A graphics card the PC's work order puts first for a work it doesn't serve yet is behind too, and gains that work the same way: planned, staged, tested and switched like the rest, its old entry serving until then. Today that is AMD XDNA 2's pictures on the Radeon. A PC set up before kit 2.111.0 has a Radeon with embeddings only, so its pictures stayed on the NPU after kit 2.135.1's order put the Radeon first. The first enabled card in the core's order gains it, and only where a plan from the pins gives it: setup leaves pictures off a card they don't fit on beside the rest. The person's choices stand. A card they turned off and an `acceleratorOrder` of their own (the core then reads no work order) add nothing. A model file of their own keeps the entry theirs, as before. Manor's `gpuWithNpu` off, Manor's default, adds the pictures too from kit 2.135.3 (the owner's ruling): the card keeps the work its order puts it first for, run on demand, never chat. Kit 2.135.2 added nothing with the switch off. An order that put a card first for chat would add chat only with the switch on.
- **A GenieX older than its pin** (kit 2.115.0, npu-vendors.ts' `plannedAt`): planned at the pin, which setup puts in its place. Until kit 2.115.0 an older one ran as it was (A later GenieX on the PC, below), so the X2's pin of 0.9.3 never reached one set up with 0.8.0 or 0.9.1. A later one than the pin (the Smith's Use it) still runs as it is.
- **Gently.** One accelerator a look, once nobody has used it for 2 minutes (`AGAIN_QUIET_MS`), never while the manor is stopped. At the manor's gentle pace, a download goes at 4 MB a second at most (`pacedFetch`), its size and SHA-256 checked as always. A model the NPU's own server pulls (GenieX's, FastFlowLM's) comes at that server's pace. Setup runs as `local-ai` would with `--yes`, outside a packaged app where the keeper runs in one (Setup from inside a packaged app, above).
- **The old serves until the new has answered** (`stage`, setup's `staged`). New builds and models go beside the old ones: a build's folder is named by its tag, a model by its file. config.json keeps the old entry meanwhile. Then, in the accelerator's turn (the keeper's: background, taken only when nobody is in line), its old servers are stopped, its ports waited on, and the new servers asked their test questions: chat, pictures, embeddings and reranking, each it serves. Only an entry whose every server answered, and that serves all the old one did, is written, over config.json as it is then; an entry changed meanwhile (Settings, another setup) is left as it is. The NPU's work never goes to a card here: its old entry still serves it.
- **GenieX, installed in one place** (`%LOCALAPPDATA%\GenieX CLI`), is put together beside it (`GenieX CLI.next`) and swapped in the NPU's turn with its servers stopped, the old folder kept as `GenieX CLI.kept`. When the new entry isn't written, the old folder goes back. Between the swap and the new entry's test (the models' pull, if any), a request starts the new GenieX with the old command, which a picture may fail; the test follows in the same setup. FastFlowLM and OpenVINO Model Server go in folders named by their version, beside the old.
- **Then the old files go** (`removeReplaced`). The build folders and model files a switch left unnamed, and a `.kept` folder, are noted in `set-up-again.json` beside config.json. Each is removed once 3 days have passed (`RETIRED_GRACE_MS`, as retired models are) with nothing naming it: config.json, or a running server's command line. Nothing in the PC's shared folder (an Everyone install) is removed.
- **Quietly.** A failure keeps the old entry, goes in the keeper's log, and is tried again 6 hours later (`AGAIN_RETRY_MS`). An accelerator in use when it was to be switched is tried again 10 minutes later, with what was downloaded kept. What Windows' Smart App Control blocks (FastFlowLM's unsigned libraries on AMD) is said once, plainly, and not tried again until a later kit: the PC keeps what it has, and nothing loops.

### Castellan's build of GenieX's llama.cpp plugin (kit 2.81.0)

GenieX 0.8.0 held about 4 GB of the X2's memory for Qwen3-VL-2B, half of it for nothing (qualcomm/GenieX#1557). It read the model file into memory rather than mapping it, reserved logits for 512 outputs where the vision model asks for one, and loaded the vision encoder before any picture came.

Castellan's build of the plugin (`node/geniex/`, its README says what changed) fixes those three. Measured on the X2 Elite with the 2B:

| | GenieX's own | The build |
|---|---|---|
| After a chat: working set | 4.0 GB | 1.77 GB |
| After a chat: private | 2.15 GB | 0.21 GB |
| After a picture: working set | 4.08 GB | 3.36 GB |
| Cold load | 5.0 s | 2.4 s |
| Writing speed | 70.4 t/s | 75.5 t/s |

The same items came out right on both: quality 21 and 22 of 24, pictures 4 of 4, and 34 of 36 screen questions at 1,024 tokens.

The keeper puts it in after the NPU's refresh (npu-patch.ts, npu-vendors.json's `pluginPatch`), with the refresh's care:
- **When:** only over GenieX 0.8.0's own file, while the files it links against are 0.8.0's, and only when nobody uses the NPU. A file of Castellan's signed build counts as GenieX's own (kit 2.108.0, `sameFile`): the build's `copies` pin it as Qualcomm shipped it and signed, so the patch goes in over a GenieX put together without its installer, and the signed copy is what's kept as `.stock` and put back.
- **How:** in the NPU's turn, GenieX stopped first. GenieX's file is kept as `geniex_plugin.dll.stock`.
- **Kept:** only once a picture and a chat answer through it. Otherwise GenieX's own goes back, as it does when config.json says `npuPatch: false` or a later kit drops the patch.
- **Left alone:** a GenieX update the kit has no build for. From kit 2.88.1 it has one for 0.9.1 (A later GenieX on the PC, below).
- **Files moved by renaming:** Windows lets a loaded DLL be renamed but not replaced, so a GenieX the keeper didn't stop keeps running on what it loaded.

GENIEX_IMAGE_MAX_TOKENS, which only the build reads, is set to the 2B's `pictureTokens` (`pictureTokensEnv`). That way a picture that didn't come through `fitPicture` is scaled down too, rather than overflowing the window.

From kit 2.82.1 the build also frees the vision encoder once no picture has come for 60 s (GENIEX_VISION_IDLE_SECONDS), and the next picture loads it again in about 1 s. Until then GenieX held it until the keeper stopped the server, 10 idle minutes later. Measured on the X2 Elite with `--nctx 2560`:

| After | Working set | Private |
|---|---|---|
| a chat | 1.60 GB | 0.21 GB |
| a picture | 3.19 GB | 1.97 GB |
| the encoder is freed | 2.08 GB | 0.67 GB |

What stays above a chat's, 0.3 to 0.4 GB, is the OpenCL backend's own buffers, in GenieX's ggml-opencl.dll, which the kit doesn't build.

### Castellan's build of OpenVINO GenAI (kit 2.103.0)

OpenVINO Model Server 2026.4.1 carries OpenVINO GenAI 2026.4.1.0 (`openvino_genai.dll`). On Intel's NPU it fails Qwen3-VL, the route's model from kit 2.103.0, in two ways:
- **A prompt without a picture crashes** (`roi_end <= max_dim`). NPUW's chunked prefill slices `visual_pos_masks` along the prompt, but a text-only prompt's mask has one element.
- **After one failed request, every later one fails** (`prompt_ids.get_size() >= tokenized_history.size()`) until the server restarts. The failed prompt's tokens stay in the pipeline's history. This was the Lunar Lake's failure with OpenVINO's Qwen3-VL-4B on 2026-10-13 (Verified, below).

Castellan's build of the same file fixes both (`node/openvino/`, whose README says what changed and how it was built). It goes on the same way GenieX's plugin does, with two differences:
- **It's downloaded, not carried.** At 7.5 MB, it's too big for every agent's kit. The route's `pluginPatch` pins it on Manor-releases by `url`, size and SHA-256, for every Intel generation. `planNpu` counts it in the plan's download (`patch`). Setup downloads it into `servers\patches` in the tools home (`hostedPatchFile`) and puts it in before it tests the model (`installPatch`).
- **It's required** (`required`). The route's model doesn't run without it, so config.json's `npuPatch: false` leaves it in place.

The rest is as for GenieX's plugin:
- **When:** only over OpenVINO Model Server 2026.4.1's own file, and only while `openvino.dll` and `tbb12.dll` are 2026.4.1's.
- **Kept:** Intel's own file is kept beside it as `openvino_genai.dll.stock`.
- **The keeper's look** keeps it, and puts it in again, tested, where Intel's own came back (setup unpacking the server again). It never downloads: without the file, its record says `not-downloaded`.
- **Taken out:** a later kit that drops the patch puts Intel's own back. That happens once a server release carries a GenAI with both fixes.

Measured on the NPU 3720 with Qwen3-VL-2B: with Intel's own file, every prompt without a picture failed. With the build, npu-bench's full run answered 22 of 24, and 4 of 4 pictures (Qwen3-VL-2B on Intel's NPU, above).

A third problem, the NPU dropping Qwen3-VL's DeepStack features, is in the NPU plugin (NPUW), not in this file. It's fixed in the model's export rather than here: its language model has the three DeepStack steps in the form NPUW recognises (Qwen3-VL-2B on Intel's NPU, above).

### A later GenieX on the PC: 0.9 (kit 2.88.1)

The route pins GenieX 0.8.0, and setup installs that, except on the Snapdragon X2, which pins 0.9.1 of its own from kit 2.88.1 and 0.9.3 from kit 2.108.0 (below, "The X2 on 0.9.1", "GenieX 0.9.3"), and the first X, which pins 0.9.3 from kit 2.101.0. The Smith offers later versions, and its try installs one in place of the one there; Use it keeps it. So a PC can run a GenieX its generation doesn't pin. The route's `versions` (`NpuServerVersion`) say how each later version runs, from its `version` on until the next one listed, and `routeFor` applies the newest at or before the route's version:
- **The Smith's try** builds its route at the candidate's version (its `trialRoute`), so the try and the entry Use it writes run as that version runs.
- **The keeper's refresh, setup, the NPU check and the benchmark** ask the PC's own GenieX which version it is (`versionCommand`: `geniex version --skip-update`, about 60 ms; `installedVersion`) and plan at that version (`planNpu`'s `serverVersion`, `atVersion`). Before kit 2.88.1 they planned at 0.8.0 whatever was installed, so after Use it of 0.9.1 the refresh would have tested 0.8.0's arguments, which crash 0.9.1, up to three kits in a row.
- **A version older than the generation's pin** (kit 2.115.0, `plannedAt`) is planned at the pin instead: setup installs the pin over it, and the refresh leaves it for setup (`needs-setup`), which the keeper runs by itself (Set up again when the kit's pins move on, above). Until kit 2.115.0 it ran as it was, so an X2 set up with 0.8.0 or 0.9.1 never got 0.9.3. A later version than the pin keeps its own plan.

GenieX 0.9.0 and 0.9.1 carry llama.cpp e467e5b and read a vision model's pictures on the Hexagon's second session (HTP1) by default (qualcomm/GenieX#1548). Asked for the Adreno (`--vit-compute GPUOpenCL`, the X2's 2B's own `serve` for 0.8.0), 0.9.1 tries to allocate 9.4 GB in OpenCL and crashes (0xC0000005) on the first picture: the Smith's two tries of it on 2026-10-18 failed so. From 0.9.0 the 2B's `serve` is `--compute npu --nctx 2560`.

Measured on the 48 GB X2 Elite, 2026-10-18, each on a private port in the NPU's turn, with the kit's own requests (`chatBody`, `visionBody`, `fitPicture` at 1,024 tokens): GenieX 0.9.1 (its own plugin, no `--vit-compute`) against 0.8.0 as the manor runs it (Castellan's build, pictures on the Adreno).

| | 0.8.0, pictures on the Adreno | 0.9.1, pictures on the Hexagon |
|---|---|---|
| Screen questions at 1,024 picture tokens | 33 of 35, a median 4.49 s (4.31–4.79) | 34 of 35, a median 1.50 s (1.37–2.17) |
| Questions about ten photos (Wikimedia Commons, up to 5388 × 3368) | 21 of 21, a median 4.42 s (1.40–4.91) | 21 of 21, a median 1.45 s (0.55–1.89) |
| npu-bench's four pictures | 4 of 4, a median 419 ms | 4 of 4, a median 282 ms |
| The first picture after a chat / the next | 2.0 / 0.18 s | 0.55–0.59 / 0.14–0.19 s |
| A picture after 75 quiet seconds | 634 ms (its encoder loaded again) | 167 ms |
| A paragraph | 1.54 s, 73.0 tokens a second | 1.39–1.63 s, 72.5–72.6 |
| Quality items | 22 of 24 | 21 of 24 (as GenieX's own 0.8.0 plugin: one more wrong, three words asked, five given) |
| The first answer after a start | 3.1 s | 4.7 s |
| After a chat: working set / private / on the NPU | 1.6 / 0.22 / 1.48 GB | 3.27 / 0.73 / 3.21 GB |
| After a picture: private / on the Adreno | 1.97–2.07 / 1.54 GB | 0.74–0.90 GB / none |
| The PC's available memory: after a picture / 75 s later | 3.2 / 2.1 GB lower | 3.6 / 3.6 GB lower |

Both misread the Smith's tally picture drawn on a whole number of 32 px squares ("Tally 827"), as 0.8.0 always did, and both answered every must-pass quality item right. What 0.9.1 gives a PC that runs it: pictures about three times sooner, the Adreno left free (no 1.5 GB there, no picture work beside the card's own servers), and 1.2 GB less private memory after a picture. What it costs with its own plugin: about 1.5 GB more held at rest, and 1.6 s more to the first answer after a start, because Castellan's build for 0.8.0 (built against 0.8.0's libraries) doesn't apply to it: 0.9.1 reads the model file into memory and loads its vision encoder at the start. qualcomm/GenieX#1557, the upstream fix, is still open. Castellan's build for 0.9.1 (below) takes that cost back, so the X2 now pins 0.9.1 (The X2 on 0.9.1, below).

**Its embeddings.** llama.cpp b11125's `llama-server` doesn't start over GenieX 0.9.1's libraries (0xC0000139: an entry point it needs isn't there). From 0.9.0 the embedding server is llama.cpp b11645, which is e467e5b and one Metal-only commit (13 MB, SHA-256 pinned), in a folder of its own (`b11645-hexagon`), so the b11125 folder a PC still running 0.8.0 uses is never copied over. GenieX's same 13 files go over it. Measured the same evening, b11645 over 0.9.1's libraries against b11125 over 0.8.0's, 206 texts (Reeve's nine search-eval questions with their Qwen3 prefix, and Reeve-sized chunks of GamerNexus):

| | b11125 over 0.8.0 | b11645 over 0.9.1 |
|---|---|---|
| Healthy after the start | 1.6–1.9 s | 1.6–1.7 s |
| A query | 12–21 ms | 23–26 ms |
| A chunk, in Reeve's batches of 16 | 112 ms | 72 ms |
| A 1,539-character chunk alone, first time | 119–121 ms | 78–110 ms |
| On the NPU / working set / private | 1.41 / 2.00 / 0.63 GB | 1.10 / 1.39 / 0.33 GB |

The vectors are the same: cosine 0.99936 or more between the two (a median 0.999998), and the top five chunks for each of the nine questions came out in the same order. So an index built with either serves both, and nothing is indexed again. Reeve's search eval (kit 2.86.0's nine questions) gave the same answer to each: an index of GamerNexus and the Maestro docs built with b11125 over 0.8.0, then asked with each server, put the right file first for 4 of 9 and in the top five for 9 of 9, each question at the same rank with both.

**Castellan's build for 0.9.1.** The same patch, carried to GenieX v0.9.1 and built against its libraries (`node/geniex/0.9.1/`, its README says what the port kept of 0.9.1's own changes), signed as 0.8.0's is. The route's 0.9.0 entry names it for the X2 (`NpuServerVersion.pluginPatch`, `pluginPatchOf`), pinned to 0.9.1: its own file, the six files it links against, and the build's hash. So the keeper puts it in over GenieX 0.9.1's own plugin, as it does 0.8.0's over 0.8.0's, and a GenieX 0.9.0 or 0.9.2 keeps its own. The keeper asks the PC's GenieX its version for this (`installedVersion`); a PC moved from 0.8.0 to 0.9.1 gets 0.9.1's build, with 0.9.1's own kept as `.stock` in place of 0.8.0's, and the other way round. Measured the same evening, with the same requests:

| | 0.8.0 with its build, pictures on the Adreno | 0.9.1's own plugin | 0.9.1 with its build |
|---|---|---|---|
| The first answer after a start | 3.1 s | 4.7 s | 3.5 s |
| After a chat: working set / private / on the NPU | 1.6 / 0.22 / 1.48 GB | 3.27 / 0.73 / 3.21 GB | 1.62 / 0.25 / 1.50 GB |
| After a picture: on the NPU / on the Adreno | 1.48 / 1.54 GB | 3.21 GB / none | 2.45 GB / none |
| The PC's available memory: after a picture / 75 s later | 3.2 / 2.1 GB lower | 3.6 / 3.6 GB lower | 2.6 / 1.6 GB lower |
| The first picture after a chat | 2.0 s | 0.59 s | 1.0 s |
| A picture after 75 quiet seconds | 634 ms | 167 ms | 988 ms |
| Screen questions / photos | 33 of 35, 4.49 s / 21 of 21, 4.42 s | 34 of 35, 1.50 s / 21 of 21, 1.45 s | 34 of 35, 1.50 s / 21 of 21, 1.45 s |
| npu-bench's four pictures | 419 ms | 282 ms | 278 ms |
| Chat / quality items | 73.0 t/s, 22 of 24 | 72.6 t/s, 21 of 24 | 72.5 t/s, 21 of 24 |

0.9.1 with its build holds at rest what 0.8.0 with its build does, its first answer comes 1.2 s sooner than with its own plugin, and its pictures are as quick and as right. The first picture after a chat or a quiet spell takes 0.4 to 0.8 s more, while the encoder loads on HTP1. With this, the cost that kept the X2 on 0.8.0 is gone.

**The X2 on 0.9.1.** So the X2 pins GenieX 0.9.1 of its own (`NpuGeneration.serverPin`: its version, its installer pinned by size and SHA-256 as GitHub and GenieX's own `.sha256` publish them, checked on a download, and why). The route's own version stays 0.8.0 for the first X, where 0.9.1 hasn't been measured, and for a Snapdragon setup doesn't know. `pinnedRoute(route, generation)` puts the pin in the route's place. Each place that plans the route for this PC calls it before `atVersion`, so the PC's own version still wins where GenieX says one:
- **setup**, through `planNpu`'s `serverVersion`, installs 0.9.1 on a new X2;
- **the NPU check and the benchmark** run an X2 whose GenieX can't say its version as 0.9.1;
- **the keeper's refresh** leaves such an X2's command as it is (`unknown-version`, not written, so a later look asks again): it may be 0.8.0, set up by an older kit, whose pictures need the Adreno, or 0.9.1, which crashes when asked for it. Without GenieX there at all, it's left for setup (`needs-setup`), as before;
- **the keeper's plugin patch** puts in 0.9.1's build there;
- **the reports** count an X2's speeds only at 0.9.1 (`npu-reports.ts`).

`planNpu` pins only when it is told the PC's version (setup's and the refresh's `serverVersion`, even null). A route a caller gives it, already at its version (npu-check's, npu-bench's, the Smith's try of a later GenieX with its own installer), is planned as given.

An X2 set up before this kit keeps its GenieX 0.8.0: setup never replaces an installed server, and nothing here updates one. On such an X2 the Smith offers 0.9.1, newer than the 0.8.0 installed there (its `newerServers`), and Use it moves it. Its refresh then runs it as 0.9.1 runs and offers the embeddings on b11645, and the keeper puts in 0.9.1's build (above).

**The processor's threads (kit 2.98.1).** GenieX's llama.cpp plugin starts one processor thread for each math core (18 on the X2 Elite) for the few operations the NPU leaves it. At ggml's default (poll 50) they spin after each operation waiting for the next, so all of them stay busy through every token: about five of the processor's cores while GenieX writes, for no speed. Castellan's build for 0.9.1 sets their poll to 0 when the model is on an accelerator (GENIEX_PATCH_POLL, `node/geniex/README.md`), so they sleep instead. Measured with Windows' Energy Meter counters on the X2 Elite, 2026-10-22, eight chats of about 1,200 tokens: 5.12 cores busy and 699 mJ a token over the PC at rest with poll 50, 0.05 cores and 251 mJ with poll 0, at 72.3 and 72.9 tokens a second, the NPU's own 78 mJ a token in both. A model on the processor keeps ggml's default, since there the threads do the work. 0.8.0's build is unchanged.

**GenieX 0.9.3 (kit 2.98.1).** The Smith's Use it can put a newer GenieX in place than the X2 pins, and a PC on 0.9.3 kept 0.9.3's own plugin, holding what Castellan's build gives back. 0.9.3 is 0.9.1 with a `/status` endpoint (qualcomm/GenieX#1560) and a signed catalog for its Hexagon libraries: the same llama.cpp and plugin source, its libraries rebuilt (the same sizes, other hashes). Built against v0.9.3, the patch gives 0.9.1's file byte for byte, so the route's `0.9.3` entry names that file, pinned to 0.9.3's own plugin and the six libraries it links against, with 0.9.0's command and embedding server repeated (each entry replaces the ones before it). On the X2 Elite, 2026-10-22, 0.9.3 with the build against its own plugin: npu-bench's four pictures right with both, 2.72 GB working set after them against 3.54, a 1,392-token read in 516 ms against 527, and 245 mJ a token against 636, with 0.08 processor cores busy against 5.22.

**The X2 on 0.9.3 (kit 2.108.0).** The X2's pin moves to 0.9.3 (its installer pinned by size and SHA-256), so one GenieX, and one signed build of it (Castellan's signed build, above), serves both generations. 0.9.3 is 0.9.1 with `/status` and the signed Hexagon catalog, on the same llama.cpp e467e5b, plugin source and b11645 embedding server; this X2 Elite has run 0.9.3 with Castellan's build since 2026-10-22, and the plugin patch's 0.9.3 entry was measured there (above). Everything the pin decides follows it: setup puts 0.9.3 on a new X2, the NPU check and the benchmark run an X2 whose GenieX can't say as 0.9.3, the keeper's plugin patch puts in 0.9.1's build over 0.9.3's own there, and the reports count an X2's speeds at 0.9.3. A PC already on 0.9.1 keeps it, as an installed server always is: setup and the refresh plan at the version GenieX says, run 0.9.1 as before with 0.9.1's build, and the Smith offers 0.9.3 as a newer GenieX there (its try runs 0.9.3's installer, which Smart App Control blocks where it is on). 0.8.0's route is unchanged.

### Resting when unused (kit 2.71.0)

None of the three servers can drop its model and keep running: GenieX's `--keepalive` unloads it, but the process keeps some 340 MB from every load until it exits; OpenVINO Model Server started with `--source_model` can't unload one (only its config-file mode can, by editing the file); FastFlowLM documents no unload. So the keeper stops the server, holding the NPU's turn, and the next request starts it again in its own turn. Intel's embedding server, a second OpenVINO Model Server holding 1.7 GB, is stopped with the chat server now; before 2.71.0 the keeper left every NPU embedding server but llama-server's running.

When, with no `npuIdleStopMinutes` in config.json (`npu-vendors.json`'s `idleStop`):

| PC | Stopped after |
|---|---|
| Under 20 GB of memory (8, 12 and 16 GB laptops; Windows shows 16 GB as 15.3 to 15.9) | its route's own minutes: GenieX and its llama-server 5, OpenVINO Model Server's two 5, FastFlowLM 5 (6 for its vision model) |
| 20 GB or more, or memory unknown | rules.json's `npuIdleStopMinutes`, 10, as before |

A route's minutes are 20 times its cold start (stopped to its first answer), never under 5: waking it costs at most a twentieth of the quiet spell it ends, and a conversation's pauses, or an agent's rounds a minute apart, never pay it. GenieX starts and loads in 9 to 15 s (measured), so 5, and its llama-server answers in 2 to 3 s (measured; through kit 2.75.0 taken as 10 s), so 5; OpenVINO Model Server starts from its compile cache in 4 s on a Lunar Lake and 6.9 s on an NPU 3720, its embeddings in 2.8 s there (measured; the first compile is once per PC), so 5; FastFlowLM starts and loads its chat model in 6.6 s on an XDNA 2 (measured), so 5, and its vision model, its switch from chat included, in 15.7 s, so 6 (through kit 2.74.4 it wasn't measured, taken as 30 s, so 10). `npuIdleStopMinutes` in config.json (the Smith's Settings) overrides the rule on any PC, either way: 240 keeps it longer, 0 never stops it.

An idle stop never races a request: the keeper stops a server only holding the NPU's turn (the NPU 3720's embedding server, the graphics': its requests' turn, above), joining only an empty line, so a request in flight keeps it; a request that took the NPU after the keeper's look makes it give way (its turn wasn't had at once: `TURN_AT_ONCE_MS`), and a request arriving during the stop waits its turn, then starts the server again. That first request waits for the cold start: a server just started is given the cold-load allowance for its model's load, whatever shorter timeout the caller gave (`requestBaseMs` plus the larger of rules.json's and the route's `coldLoadMs`). A caller that passes `onWaking` (the kit's `AskOptions`) is told before it waits, with a line for the person: "Waking the local AI on the NPU: it rests when nobody uses it, so the first answer takes about 4 s longer."

### A card that shares the PC's memory rests the same way (kit 2.78.25)

Integrated graphics have under 2 GB of memory of their own (`OWN_MEMORY_GB`: an Intel Core Ultra's, an AMD Ryzen AI's Radeon, a Snapdragon's Adreno), so their llama.cpp servers hold the PC's own memory, as the NPU's do. On a PC under 20 GB, with no `gpuIdleStopMinutes` in config.json, the keeper stops such a card's servers (chat, vision, embeddings and a reranker) by the NPU's rule, from llama.cpp's cold start (`idleStop.cardColdStartMs`, 6 s): 20 times it is 2 minutes, so the floor's 5 (npu-vendors.ts' `cardIdleStopMinutes`). A card with memory of its own, one whose memory config.json doesn't give, the processor, and any card on a bigger PC keep rules.json's 10, as before.

Measured on WEASELDEV02 (Core Ultra 5 225U, 15.4 GB, Intel Graphics with 0.1 GB of their own), llama.cpp b11669-vulkan, from the disk cache, below-normal priority, start to the first answer, two runs each:

| Server | Cold start | Holds while idle |
|---|---|---|
| Qwen3-4B Q4_K_M chat, `-c 4096` | 5.2, 3.8 s | 3.5 GB |
| Qwen3-VL-4B Q4_K_M vision with its Q8_0 projector, `-c 8192` | 5.4, 3.8 s | 5.0 GB |
| Qwen3-Embedding-0.6B Q8_0, `-c 4096 -ub 512` | 2.9, 1.6 s | 1.3 GB |

That PC's keeper stopped its vision server three times on 2026-10-16, each after 10 to 11 minutes unused. Each time it held some 5 GB of the PC's 15.4 for 5 minutes longer than this rule keeps it. The cost is a reload of 4 to 5 s for a request that comes 5 to 10 minutes after the last.

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
| Qualcomm X | `qualcomm/Qwen3-VL-4B-Instruct:W4A16` (Qualcomm AI Hub's NPU build) | chat, vision | 4.4 GB |
| Qualcomm X2 | `unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0` (unsloth's Q4_0 GGUF of Qwen3-VL-2B-Instruct and its F16 vision projector, from Hugging Face; its files pinned) | chat, vision | 1.9 GB |
| Qualcomm | Qwen3-Embedding-0.6B Q8_0 (`Qwen/Qwen3-Embedding-0.6B-GGUF`, the graphics card's) | embeddings | 639 MB |
| Intel | `Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov` (Castellan's symmetric INT8 export, its pictures capped at about 1,024 tokens; its files pinned) | chat, vision | 2.5 GB |
| Intel | `OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov` (OpenVINO's channel-wise INT4 export; its files pinned) | embeddings | 428 MB |
| AMD | `qwen3.5:2b` (Qwen3.5-2B, FastFlowLM's NPU2 build) | chat, vision | 2.0 GB |

Plus the server: GenieX 65 MB (and llama.cpp b11125's zip, 13 MB, for its embeddings), OpenVINO Model Server 140 MB (and its Visual C++ runtime, 3 MB, and Castellan's build of OpenVINO GenAI, 7.5 MB), FastFlowLM 40 MB.

Intel's model was Castellan's channel-wise INT4 export of Qwen3-4B-Instruct-2507 (2.2 GB, chat only) until kit 2.103.0.

**Off the NPU, for the benchmark (kit 2.99.0).** GenieX and FastFlowLM run on the NPU only, so a route of theirs says how the benchmark runs its model on the graphics and the processor instead (`offNpu`): the same model as llama.cpp reads it, at the NPU's context, served by setup's pinned llama.cpp build for the device (`variantFor`), with setup's embedding model beside it. Only `npu-bench --device GPU|CPU` uses it; setup and the keeper never do.

| Route | The model off the NPU | Files | Context | Builds |
|---|---|---|---|---|
| Qualcomm X2 | `unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0`, the very files GenieX pulls (their `present`: GenieX's cache) | 1.9 GB, none downloaded where GenieX has them | 2,560, GenieX's `--nctx` | b11734 `opencl-adreno-arm64` and `cpu-arm64` |
| AMD | `qwen3.5:2b` as unsloth's Q4_0 GGUF and F16 projector (`unsloth/Qwen3.5-2B-GGUF` at f6d5376b, Apache-2.0), its thinking off (`--reasoning-budget 0`): FastFlowLM's own weights are its NPU format (q4nx), which nothing else reads | 1.9 GB, into the tools home's `models\` | 4,096, FastFlowLM's `--ctx-len` | b11734 `vulkan-x64` and `cpu-x64` |

Intel's route needs none: OpenVINO Model Server runs the same model on the graphics and the processor (`--target_device`).

AMD's `--reasoning-budget 0` is checked (2026-10-23, the pinned Q4_0 on b11734's `cpu-arm64` on the X2, the same llama.cpp as `cpu-x64`). With it, Qwen3.5-2B answered at once: "391" in 6 tokens, a sentence in 28, and no reasoning. Without it, the same questions took 296 and 400 tokens of thinking, and the second ran out before it answered.

### Bigger models the Smith offers (kit 2.106.0)

The Smith's scout looks on Hugging Face for newer models built for the NPU, and offers each one for a try.
- **Until Smith 0.8.87** it offered any size the PC's memory allowed. That meant up to 14B on a 32 GB PC, including an X2 running its 2B. Nobody had tested those sizes on the NPU.
- **Now** it offers models no bigger than the model the NPU runs now, unless a manager has tested a bigger size on that generation and found it worth letting customers try.

That size is the generation's `testedUpTo` (`{ params, basis }`): the biggest model, in billions of parameters, and how it was tested.
- The Smith offers up to the larger of `testedUpTo` and the size of the model the NPU runs now. It never offers more than the PC's memory allows.
- On a generation the route doesn't know, the Smith takes the least that the supported generations have tested. It takes none until every one of them has a `testedUpTo`.
- The card names the sizes it leaves out, and why.

A bigger model may answer better, but on the NPU it's slower, holds more memory and draws more power. The manor's rule is the smallest model that serves, so a size is lifted only on a measured need: a manager benchmarks it on that NPU (NPU-BENCHMARK.md) and sets `testedUpTo` in a kit.

The kit itself doesn't read `testedUpTo`. No generation sets one yet. The first X's 4B stays its fallback, and isn't offered as a try on an X running its 2B.

## Licences

| What | Licence | Note |
|---|---|---|
| GenieX | BSD-3-Clause ([LICENSE](https://github.com/qualcomm/GenieX/blob/main/LICENSE)), and Qualcomm's [Terms of Use](https://www.qualcomm.com/site/terms-of-use), which its README says apply too | Setup names both before it downloads GenieX (kit 2.97.0, below). The installer isn't code-signed, nor are GenieX's own files. From kit 2.108.0 Castellan hosts signed copies of those files on Manor-releases, unchanged but for the signature, with the notices of GenieX, its QAIRT plugin, geniex-proc and llama.cpp at the commits GenieX's tag builds from: BSD-3-Clause and MIT let anyone pass them on so. |
| The QAIRT runtime inside GenieX's installer (Qualcomm's AI runtime and its HTP libraries, QAIRT 2.50.40) | Qualcomm's AI Runtime SDK End User License Agreement (EULA), not BSD-3-Clause ([THIRD_PARTY_NOTICES.md](https://github.com/qualcomm/geniex-qairt-plugin/blob/main/THIRD_PARTY_NOTICES.md), items 1 and 2) | The owner's reading, not legal advice (kit 2.97.1; 2.97.0 said it had no licence of its own, wrongly). GenieX takes the runtime from `qualcomm/geniex-qairt-plugin`, whose notices put the SDK's files and its prebuilt Windows libraries under the SDK's EULA "as distributed with the SDK download"; the plugin's own code is BSD-3-Clause. That exact 2.50.40 text couldn't be fetched (Qualcomm's download server answered 503), so the grant was read from two copies of the SDK's licence: QTI's "AI Stack License" (Microsoft's onnxruntime-qnn carries the SDK's `LICENSE.pdf` as `Qualcomm_LICENSE.pdf`) and QuIC's "AI Model Hub License", which covers Qualcomm's own `com.qualcomm.qti:qnn-runtime` 2.51.0 on Maven Central ([LICENSE.pdf](https://softwarecenter.qualcomm.com/api/download/software/licenses/ai_model_hub/v1/LICENSE.pdf)). Both grant the same: a non-exclusive, revocable, royalty- and fee-free licence to use and copy it to develop your applications, and to distribute and sublicense it only in object code and as incorporated in your application, never on its own. No personal or non-commercial limit. Both forbid reverse engineering, ask that Qualcomm's notices be kept, and let Qualcomm end the licence at any time without cause. Prohibited uses: the Model Hub copy forbids outright essential services, justice and democratic processes, emotion recognition, biometrics, education and vocational training, employment and workers management, exploiting vulnerabilities, social scoring, law enforcement, critical infrastructure, migration, predictive policing, real-time remote biometric identification, social-media recommenders and scraping facial images; the AI Stack copy forbids a shorter list (manipulation and deception, exploiting vulnerabilities, predictive policing, social scoring, emotion recognition at work or school, real-time remote biometric identification in public for law enforcement, biometric categorisation by sensitive traits, facial-recognition databases scraped from images) and advises against the high-risk ones. Setup names the wider list. Qualcomm's Terms of Use limit a download to personal, non-commercial use only "unless otherwise indicated", and this EULA indicates otherwise, so they don't limit the runtime. Each PC downloads it inside GenieX's installer, or from kit 2.108.0 inside Qualcomm's SDK zip of GenieX, from Qualcomm's GitHub release, so Castellan doesn't redistribute it (Castellan's signed build carries none of it): **have it reviewed**. Setup names it before it downloads GenieX. |
| Qualcomm's [Responsible AI License](https://www.qualcomm.com/site/responsible-ai-license) (last revised 2026-02-17) | Applies to what Qualcomm makes available for AI, quantized models among them | Section 1(b)'s prohibited uses bind the person, who may not let anyone else use them so either, so they're passed on: military use; crime and predictive policing; breaking the law; exploiting or harming people; false information, defamation, harassment, impersonation; content not disclosed as machine-made; fully automated decisions on legal rights or binding obligations; discrimination and social scoring; exploiting vulnerable groups; manipulation and deception; facial-recognition databases scraped from the internet or CCTV; biometric categorization by sensitive traits; real-time remote biometric identification in public for law enforcement; emotion recognition at work or school. Section 3's high-risk uses (biometrics, critical infrastructure, education, employment, essential services, law enforcement, migration, social-media recommendations, justice and democratic processes, consequential decisions) are at the user's own risk, and section 4 has them indemnify Qualcomm. Setup names it last, after what it covers. |
| Castellan's build of GenieX's llama.cpp plugin (the kit's `node/geniex/`) | BSD-3-Clause, GenieX's | A modified build that Castellan redistributes, signed with its certificate. GenieX's copyright notice and license go with it (`LICENSE` beside it), and its README says it isn't Qualcomm's release. The license forbids using Qualcomm's name to endorse it. |
| Qualcomm AI Hub's W4A16 builds (the first-generation X's Qwen3-VL-4B, [its card](https://huggingface.co/qualcomm/Qwen3-VL-4B-Instruct)) | Apache-2.0, with the card's "Usage and Limitations", and the Responsible AI License | The card says they're not for: essential services; justice and democratic processes; emotional state; biometrics and real-time remote biometric identification; education and employment decisions; exploiting vulnerabilities; social scoring; law enforcement and predictive policing; critical infrastructure; migration; social-media recommenders; scraping facial images; subliminal manipulation. Setup names the card and the Responsible AI License before it pulls one. **Have them reviewed** against Castellan's terms. |
| llama.cpp (the Snapdragon's embedding server) | MIT | Run over GenieX's own libraries, under GenieX's terms. |
| OpenVINO Model Server | Apache-2.0 | Its zip carries its third-party licences. |
| Castellan's build of OpenVINO GenAI (`openvino_genai.dll`, the kit's `node/openvino/`, downloaded from Manor-releases) | Apache-2.0, OpenVINO GenAI's | A modified build that Castellan redistributes, signed with its certificate. GenAI's licence, a NOTICE saying what changed and that it isn't Intel's release, the patch, and GenAI's third-party programs list go with it, in the kit and in the release. |
| The Microsoft Visual C++ runtime DLLs beside it | Visual Studio's "Distributable Code" terms | Microsoft lets an application carry these DLLs in its own folder; here each PC downloads them from Microsoft, so Castellan doesn't redistribute them either: **have it reviewed**. |
| OpenVINO's model exports | the base model's (Apache-2.0 for Qwen3) | |
| FastFlowLM (1.0.10, kit 2.111.0) | MIT for its runtime, orchestration and CLI (`LICENSE_RUNTIME.txt`); AMD's FastFlowLM NPU Binary License for its NPU kernels and prebuilt engine libraries (`LICENSE_BINARY.txt`: free for any use, commercial included, redistributed only unmodified and with that licence beside them) | Both, and its `THIRD_PARTY_NOTICES.txt`, are in its zip; 1.0.7's `TERMS.md` is gone. Its README asks to be acknowledged in the product: the third-party notices say "Powered by [FastFlowLM](https://github.com/ROCm/FastFlowLM)". |
| Qwen3-4B-Instruct-2507, Qwen3-VL-4B-Instruct, Qwen3-VL-2B-Instruct, Qwen3-Embedding-0.6B, Qwen3.5-2B | Apache-2.0 | |
| unsloth/Qwen3-VL-2B-Instruct-GGUF (a 16 GB X2's model) | Apache-2.0, the base model's | A format conversion and Q4_0 quantization of Qwen's weights, nothing else. |
| Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov and Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov, on Hugging Face | Apache-2.0, the base model's | Castellan's own exports, so Castellan publishes them: with the base model's LICENSE, and a model card saying what was changed and how, as Apache-2.0 asks: the weights converted and compressed, and in the 2B's, the picture size its configs allow. |
| Avoided | Llama 3.2 (community licence), Gemma and EmbeddingGemma (Gemma's terms flow down to users), AMD's Ryzen AI ONNX runtime (AMD's software licence) | Not installed by setup. |

Each customer's PC downloads the servers, runtimes and models from their makers (GitHub releases, Microsoft, Hugging Face, Qualcomm AI Hub); Castellan doesn't redistribute them, except Intel's NPU model, its own export, which it publishes on Hugging Face as Castellan-AI, its build of GenieX's llama.cpp plugin, which the kit carries, and its build of OpenVINO GenAI, which it publishes on Manor-releases.

**Qualcomm's terms, named before the download** (kit 2.97.0). A maker's terms beyond a licence are in `npu-vendors.json`, as `terms` on the route (for its server and what that carries) and on a model (`MakerTerms`: the maker, what they cover, what they say in a line, and a link). On a Snapdragon, the route's are GenieX's licence, the QAIRT runtime's (Qualcomm's AI Runtime SDK EULA, linked through the plugin's THIRD_PARTY_NOTICES.md; kit 2.97.0 named Qualcomm's Terms of Use for it, wrongly) and the Responsible AI License; AI Hub's Qwen3-VL-4B adds its card and the Responsible AI License. Setup's plan carries the ones that come with what it will download (`npuTerms`: the route's when its server is to be installed, a model's when it is to be pulled, each document once, the Responsible AI License last; none once they're all here), as `SetupPlan.terms`. `describePlan` prints them after the download's size, under "Qualcomm's terms come with what this downloads for the NPU: setting it up means you accept them, for everyone using this PC and your staff.", one line each with its link, and the command's question becomes "Download 5.1 GB, under the terms above? [y/N]". The X2's own model is unsloth's GGUF (Apache-2.0), so a new X2 is shown GenieX's terms alone. Intel's and AMD's routes carry none: their licences are open ones.

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
- **harden-nonsense** (on the NPU only): `OpenVINO/Qwen3-4B-int4-ov`, the group-wise export that answers nonsense on the Lunar Lake's NPU and the NPU 3720's, pulled and set up in the route's model's place: no NPU entry, and its note says the chat model doesn't run properly (where it answers sensibly, nothing was forced, and the step isn't counted);
- **harden-calibrate**: setup's measuring requests, as on a generation nobody has measured: the timeouts it writes must be calibrate's from what it measured, cover what it measured, and stay inside the bounds; too slow fails on the NPU.

`--idle` (kit 2.71.0) runs the NPU's rest and waking for real instead (npu-idle.ts), the keeper given a minute's idle time; after the setup step, four steps, each passing or failing:
- **idle-wake**: a chat, and an embedding where the route has its own embedding server, asked through the kit as an agent asks; what each server holds of the PC's memory;
- **idle-stop**: the keeper's own look, on this PC's processes and the NPU's real line, stops every server once the NPU has gone unused a minute, and their processes are gone (the memory freed is said); and what the rule chooses on this PC;
- **idle-cold-answer**: a person's request after that (the interactive lane, Envoy's 20 s caption timeout) is told the local AI is waking, and answers within the route's cold load; so does an embedding. Its time is this PC's cold start, and the `idleStop` numbers it gives are printed for npu-vendors.json;
- **idle-in-flight**: a keeper's look given 1 ms of idle time, while a request holds the NPU, finds it in use and stops nothing; the request answers.

`--route intel --device CPU` rehearses Intel's route off the NPU (OpenVINO on the processor), on any PC that runs x64 programs, Windows on Arm included: its download, layout, environment, pull, serve and routes, all but the NPU. `--generation <id>` rehearses with a generation's starting values (e.g. `meteor-lake`, or `unknown` for the guessed ones). A rehearsal runs only with REEVE_HOME set to a scratch folder, so this PC's servers, models and locks are left alone, and never gives a patch. GenieX and FastFlowLM run on the NPU only, so they can't be rehearsed off it; an older Snapdragon is played on a newer one instead (below).

On the NPU itself, `--generation <id>` of another generation runs that generation on this NPU, a rehearsal that gives no patch. On Intel and AMD that is its starting values alone (the Lunar Lake standing in for an NPU 3720): their servers build for the NPU they find, so nothing else of the other generation can be run.

The check runs the models setup does on this PC: its generation's own `models`, where it has any (every Snapdragon X2's Qwen3-VL-2B, kit 2.78.8), and on a PC under 20 GB its generation's `smallPc`, where it has any (none now). `--small-pc` runs those on a bigger PC (kit 2.78.0).

### Playing an older Snapdragon on a newer one

On a Snapdragon X2, `--generation snapdragon-x` (kit 2.74.7) plays the first X whole, its model build and its Hexagon code (`playGeneration`, `playedRoute`):

- **GenieX on a data folder of its own**, `{tools}\played\snapdragon-x\geniex` (GenieX's `--data-dir` before its command, and `GENIEX_DATADIR`), whose `config.json` names the X to Qualcomm AI Hub, `{"chipset": "qualcomm-snapdragon-x-elite"}`. GenieX pulls and serves AI Hub's X Elite build there (v73 context binaries), checked against `pinned["snapdragon-x"]` in that folder. The real cache, `%USERPROFILE%\.cache\geniex`, and its X2 build are left alone.
- **The embeddings on the X's Hexagon code**: the embedding server is started with `GGML_HEXAGON_ARCH=v73`, so llama.cpp's Hexagon backend loads `libggml-htp-v73.so`, as on an X, in place of the v81 library it finds. The variable is never set empty, which llama.cpp would read as arch 0.

Each Snapdragon generation's `hexagonArch` (`v73`, `v81`) and `aiHubChipset` in `npu-vendors.json` say how it's played. The report's `played` names the generation, the folder, the chip and the Hexagon code, and the run is a rehearsal: no patch. The numbers are the X's code on the X2's NPU, never the X's speed (45 TOPS against the X2's 80) or memory pressure.

It refuses before anything is set up: a newer Snapdragon on an older one (`snapdragon-x2` on an X, whose v73 Hexagon can't run v81 code), `snapdragon-8cx` (no server runs it), and a generation the route hasn't. `npu-bench --generation snapdragon-x` plays it the same way. Its report says `run.played`, carries a `played` mark and is never ranked; on any NPU but a Snapdragon the benchmark refuses `--generation`.

To play an X on an X2, stop the manor's NPU servers first (the check refuses a port that's held). From kit 2.101.0 the X plays its Qwen3-VL-2B, pulled into the played folder (1.9 GB), as GenieX 0.9.3 runs it, with GenieX's llama.cpp plugin on v73 code too (`GGML_HEXAGON_ARCH` in GenieX's environment). For its fallback, AI Hub's X Elite build of the 4B, copy one at hand into `{tools}\played\snapdragon-x\geniex\models\qualcomm\Qwen3-VL-4B-Instruct` to save its 4.4 GB download (its pins say whether it's the right build). Then run:

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
- Qwen3-VL-2B as every X2 runs it (kit 2.78.8, 2026-10-16, on the 47.6 GB X2 Elite, private ports, the manor's own GenieX left running) beside the card's own embedding llama-server on the Adreno, started by the kit as `config.json` starts it and sent one request of about 1,500 characters every 2 s throughout:
  - `npu-check` passed every step: nothing to download; a start in 1.0 s and a first answer 4 s from it; warm answers in 0.06–0.09 s; 74.7 tokens written a second and 1,812 read in 0.7 s; 2,216 and 2,656 tokens both answered; two at once in 0.15 s; 3.95 GB held (2.12 GB private); a start again in 3 s; the kit's test request in its NPU turn (4.5 s); the Hexagon's embeddings, a vector in 1.5 s, a query 19 ms and a chunk 135 ms;
  - `npu-bench --profile quick`: 22 of 24 quality items (wrong: time, apples), every must-pass one right; pictures 4 of 4; 75.4 tokens written a second; jobs 3.3 s; a first load 2.8 s, 3.3 s from its cache; 4.30 GB working set (2.33 GB private). Not ranked: a quick run;
  - the card's server answered all 52 of its requests (a median of 432 ms, 446 ms at p90, none failing), its vectors the same before, between and after (1,024 dimensions, "a cat" nearer "a kitten" than a tax deadline); it held 3.54 GB working set before and 3.73 GB after, and the PC's available memory stayed at 26.2 GB.
- Qwen3-VL-2B's pictures and window (kit 2.80.2, 2026-10-17, on the 47.6 GB X2 Elite, GenieX 0.8.0 on a private port in the NPU's turn, `--nctx 2560`): 35 questions about the text of five screens from 1920 × 1080 to 3840 × 2160 and a phone's, each picture fitted by the kit's `fitPicture`: 35 of 35 right at 1,024 tokens (1344 × 768, 4.4 to 4.7 s a question), 18 of 35 at 400 (832 × 480, 1.3 to 1.5 s); 3840 × 2160, refused before (HTTP 400), answered right; fitting 51 to 339 ms. The Smith's check picture read "Tally 827" at its own 512 × 512, with the window cut or not, as before the change: large greyscale text on whole squares (above), which the Smith draws 513 × 512 from its 0.8.45.

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
- `--harden` (2026-10-15), every step passing: a driver below the minimum and a test given 1 s each left the NPU out with a plain note; `OpenVINO/Qwen3-4B-int4-ov`, the group-wise export, compiles on this NPU too (its first load 125 s with `BEST_PERF`) and answers nonsense as on the Lunar Lake ("vanished" asked for "ready", "ível" over and over asked for France's capital), and setup left the NPU out, noting its chat model doesn't run properly; setup's calibration, as for a generation nobody has measured, measured a first answer 6 s after the start, 0.48 s warm and 11.3 tokens a second, and wrote 40 s, 200 ms a token and a 120 s cold load (an earlier run, at 10.0 tokens a second: 45 s and 250 ms). The first run's nonsense step asked the timeout step's server instead, left loading the route's model because it hadn't opened its port when the check stopped servers, and failed on its 404 for the nonsense model: the check now waits for that server to answer before stopping it;
- the benchmark, 20 quick runs over the prompt chunks (64 to 1,024), the prompt cap (2,048, 3,072 and 4,096, each compiled and answering 23 of 24) and the NPU options that touch reading or writing: `BEST_PERF` kept (Per generation, above);
- on `castellan-npu-bench/2` (2026-10-15), 11 quick runs over the prefix cache (OpenVINO Model Server's 128 blocks, 32 and off) and the 4,096-token cap's chunks: the cache turned off (Per generation, above).
- `Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov` on Castellan's build of `openvino_genai.dll` (2026-10-22 and 23): with Intel's own file every prompt without a picture failed; with the build, npu-bench's full run on the kit's command (2,048 tokens read 256 at a time, `BEST_PERF`, the prefix cache off) answered 22 of 24 and 4 of 4 pictures, did the jobs in 12.9 s and wrote 17.9 tokens a second; the prompt chunks from 128 to 1,024, the cap at 4,096, full-size screenshots, and the picture encoder on the graphics (Qwen3-VL-2B on Intel's NPU, above); OpenVINO's Qwen3-VL-4B on the same server for comparison;
- its DeepStack rewrite: four pictures of TALLY 4827 asked four ways, the NPU's 16 answers the processor's, and the processor's two pipelines and the graphics answering word for word as before it.

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
- Qwen3-VL-2B and AI Hub's current X Elite build of the 4B on GenieX 0.9.3 (2026-10-23), the X's models from kit 2.101.0: Qwen3-VL-2B on the first-generation X, above.

**Checked from source or the release, not run**: OpenVINO Model Server 2026.4.1's zip (its SHA-256, its layout, its `/v1/models` and `/v1/chat/completions` routes in its source at that tag); FastFlowLM 1.0.7's `flm validate --json`, from its source and `flm.exe`: it looks for PCI `17F0` alone, so it can't vouch for an AMD NPU setup doesn't know (Detection, above).

**Unverified on hardware**, each needing a run on a real PC:
- GenieX's silent install on a clean PC (the flags are Inno Setup's standard ones);
- Qwen3-VL-2B on a real first-generation X (kit 2.101.0): its speed, memory and pictures there, and on GenieX 0.8.0, which an X an earlier kit set up keeps (its pictures on the Adreno). The 4B is its fallback for that reason;
- a real first-generation Snapdragon X, which the X2 only plays: GenieX's own V73 QAIRT runtime (played, the X's build ran on the X2's v81 runtime; GenieX's v73 runtime wasn't tried on the X2, for the risk of a bluescreen), the X's own speed (45 TOPS against the X2's 80), its memory, and the embedding server's `-c 4096 -ub 512` on its Hexagon (v73). On a 16 GB X Elite, GenieX (5.8 GB) and the embedding server (2.0 GB from kit 2.75.1, 4.4 GB before) beside it hold about 8 GB of the 16, and setup's memory check doesn't weigh them yet (Qualcomm's route has no `memoryGb`): whether a 16 GB X keeps both is the owner's to decide;
- Qwen3-VL-2B (Qwen3-VL-2B on every Snapdragon X2, above) on a real 16 GB X2: its pull from Hugging Face through setup, and the Adreno's first OpenCL compile on a fresh PC. On the 48 GB X2 Elite, `npu-bench --small-pc` ran the kit's own command and checked its pinned files (pulled already), and its pictures were read beside the card's own llama-server on the Adreno (kit 2.78.8, Verified on hardware). Neither full run was ranked, for the reply job's spread on whole times, and a run under kit 2.78.0's rule (a job judged at one answer length) is still to come;
- a real 16 GB Snapdragon running chat, pictures and embeddings on the NPU beside the manor's agents. The X2 Elite ran them under a 16 GB PC's memory (a ballast: Memory on a 16 GB Snapdragon), but the 7.8 GB its NPU may hold is still worked out, since Windows sets it from the memory the PC starts with;
- the Snapdragons before the X refused on a real one, and the ACPI ids from Qualcomm's driver files (`0D0A`, `0D19`, `104F`, `1050`): only `0FF0`, this laptop's, has been seen;
- Intel beyond Lunar Lake and Arrow Lake-U: Meteor Lake itself (verified through the Arrow Lake-U, which shares its NPU and PCI id, but not run on one), Arrow Lake-S, -HX and -H, Panther Lake and Wildcat Lake (their PCI ids, speed, the driver minimum, and their starting values: setup calibrates them on each PC until the NPU check's patch verifies them);
- the prompt settings estimated from the NPU 3720 (Estimated, above): Lunar Lake's and Panther Lake's 512-token chunks and `BEST_PERF`, their prefix cache off, and Wildcat Lake's NPU 3720 settings. Only a benchmark on the Lunar Lake can check any of them;
- the NPU 3720's embeddings on the processor's graphics through setup and the NPU check (`embedArgs`; measured with the same command started by hand, and the entry the kit writes started once from a scratch tools home: a query in 43–50 ms), on a Meteor Lake's Arc graphics, and with a game on the graphics (the keeper defers the card's models for one, not the NPU entry's); and their energy for each chunk against the NPU's;
- AMD beyond the Krackan: Strix Point, Strix Halo and Gorgon Point (XDNA 2 too, the same PCI id, but not run on one), a PC with 24 GB or more (where FastFlowLM's default context may well load: the cap keeps it at 4,096 everywhere), and the driver minimum, 32.0.203.311 (only 32.0.20101.3760 and 32.0.20102.3930 ran);
- FastFlowLM's `--pmode`: on the Krackan its `xrt-smi` never ran (above), so no mode has been measured. Still to run on a PC whose `xrt-smi.exe configure` works;
- that AMD's XDNA (Phoenix, Hawk Point) is refused with the right words on a real PC;
- a known maker's NPU of a generation setup doesn't know, tried on guessed values: no such NPU has run it (the tests run it on the kit's fake servers, and the NPU check's patch for one). A Snapdragon before the X is refused before anything downloads (above), but one that lists a Neural processor by a name that doesn't say which, under an ACPI id `devices` doesn't know, is still tried, and downloads GenieX and its 4.4 GB model before its test request can fail; on Intel, the latest driver minimum (32.0.100.5540) may refuse an NPU that would run on an older driver;
- the keeper's idle stops of OpenVINO Model Server and its cold starts after one on a Lunar Lake (`npu-check --idle`: it passed on the NPU 3720).
- Qwen3-VL-2B through setup on a real Intel PC (kit 2.103.0): Castellan's build downloaded from Manor-releases and put in, the 2B pulled through `--pull` and checked against its pins, and a PC on the 4B moving at Set up local AI once the keeper's look left it for setup. Only the kit's tests run these, on its fake servers;
- Qwen3-VL-2B on a Lunar Lake or Panther Lake, at 4,096 tokens read 512 at a time: run only on the NPU 3720, where it answered and held 5.45 GB.
