# Accelerators: the NPU, graphics cards and the CPU

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/ACCELERATORS.md` in [Jcollier0120/Steward](https://github.com/Jcollier0120/Steward). It was Manor's `docs/ACCELERATORS.md`. A change to the contract is a kit change: made here, released as a kit version, and taken by every agent from that release. Since kit 2.0.0 its rules are the kit's core (`core/accelerators.js`, `core/ids.js`, `core/messages.js`): reading and checking the config, the order, the candidates and the pick, the failure markers, the game check, the ids and the messages, with the timings and limits of [rules.json](rules.json). The kit's node part (`node/accelerators.ts`, `node/npu.ts`) and dotnet part carry them out, and [accelerator-vectors.json](accelerator-vectors.json) holds the cases every implementation runs. The queue it uses is [NPU-QUEUE.md](NPU-QUEUE.md), beside this page.

The manor's agents ask a model to label, name, summarise or describe; code still decides everything (house rule 1). Until now every model ran on one Hexagon NPU, through one lock and one line. This is how the same agents run on any PC: a Snapdragon laptop's NPU, a gaming desktop's graphics cards (one or several), or only its processor. Every agent follows it, so each still works on its own.

The model is Heiward's: list the devices, recommend one, let the person choose, check it before committing to it, fall back when it fails, and say where the work actually ran. Heiward's graphics-card choice (Jcollier0120/Heiward#54) is the reference for naming and choosing cards.

## Accelerators and their ids

An **accelerator** is a device that runs the manor's models, behind a model server:

| Kind | Id | Name |
|---|---|---|
| The NPU | `npu` | The NPU's own name, e.g. "Snapdragon X2 Elite NPU" |
| A graphics card | `gpu-` + its name in lowercase, each run of other characters a dash, none at either end, e.g. `gpu-nvidia-geforce-rtx-4090` | DXGI's description, as Heiward lists it: Windows' software adapters (Basic Render, Remote Display, Hyper-V) left out, and a second card of the same name `… #2` (id `…-2`) |
| The processor | `cpu` | The processor's name |

Names, not DXGI's numbers, identify cards: DXGI's numbers can change from boot to boot. A card's DXGI number and LUID are looked up when a server starts.

## Where they're kept

The accelerators are in **`config.json`** in Reeve's data folder (`%USERPROFILE%\.reeve\config.json`), which every agent already reads for its model endpoint. Whoever keeps the model servers owns its accelerators: **the Smith** where it is installed (`%USERPROFILE%\.smith\app`), else Reeve. The keeper detects them, sets up their servers, and offers them on its Settings page; nobody edits the file by hand. The Smith took over the same file in kit 2.10.0 rather than move it, so every agent reads it where it always has. Its keys are shared out: the keeper writes `accelerators`, `acceleratorOrder`, `npuIdleStopMinutes` and `gpuIdleStopMinutes` (the kit's `accelerator-config.ts`, `KEEPER_KEYS`); Reeve writes its own (repositories, jobs, Foundry Local). Each write keeps every other key, and is refused when the file changed since it was read. llama.cpp's builds and the models stay in `%USERPROFILE%\.reeve\servers` and `models`, and the keeper's log in `servers\logs\reaper.log`, whoever keeps them.

```json
{
  "accelerators": [
    {
      "id": "gpu-nvidia-geforce-rtx-4090", "kind": "gpu", "name": "NVIDIA GeForce RTX 4090", "memoryGb": 24,
      "slots": 2, "maxContextTokens": 16384,
      "chat":   { "baseUrl": "http://127.0.0.1:18191", "model": "qwen3-4b-instruct-2507",
                  "startCommand": ["%USERPROFILE%\\.reeve\\servers\\llama.cpp\\b11349-cuda-12.4-x64\\llama-server.exe", "--port", "18191", "--device", "CUDA0", "..."] },
      "vision": { "model": "qwen3-4b-instruct-2507" },
      "embed":  { "baseUrl": "http://127.0.0.1:18192", "model": "qwen3-embedding-0.6b", "startCommand": ["..."] },
      "quirks": []
    },
    {
      "id": "npu", "kind": "npu", "name": "Snapdragon X2 Elite NPU", "slots": 1, "maxContextTokens": 2400,
      "chat":   { "baseUrl": "http://127.0.0.1:18181", "model": "qualcomm/Qwen3-4B-Instruct-2507:W4A16", "startCommand": ["%LOCALAPPDATA%\\GenieX CLI\\geniex.exe", "serve", "--skip-update"] },
      "vision": { "model": "Qwen3-VL-4B-Instruct:W4A16" },
      "quirks": ["prefix-leak", "image-path"]
    }
  ],
  "acceleratorOrder": "auto"
}
```

- `slots`: how many requests it serves at once (llama-server's `--parallel`). The NPU has 1.
- `maxContextTokens`: the most a request may be, prompt and answer, by the kit's pessimistic estimate. The NPU keeps 2,400: an ~8K-token prompt bluescreened this laptop (bug check 0x18B). A graphics card's comes from its memory and the model's context. A request over every candidate's cap is refused before it's sent, as now.
- `chat`, `vision`, `embed`: what it serves, each an OpenAI-compatible endpoint (`/v1/chat/completions`, `/v1/embeddings`), its model, and the command that starts its server when it isn't running (detached, hidden, as GenieX is started now). Leaving one out means it doesn't serve that kind.
- `quirks`, per server: `prefix-leak` (GenieX v0.7.0: each request starts with a nonce), `image-path` (the server reads a local image path; otherwise images are sent as `data:` URLs).
- `acceleratorOrder`: `"auto"`, or a list of ids, first preferred. Auto puts graphics cards with 2 GB or more of their own memory first, by memory; then the NPU; then graphics that share the PC's memory; then the CPU.
- An old config with only `chatEndpoint` (and `visionModel`, `embedEndpoint`, `npuMaxContextTokens`) still works: it is read as one accelerator per device it names, `npu`, `gpu-graphics-card` or `cpu`.
- The kind comes from the id. The NPU always has one slot; the others at most 16.
- `enabled: false` keeps an entry but sends it nothing. `%VAR%` in a `startCommand` is expanded.

## Model servers

| Accelerator | Server | Notes |
|---|---|---|
| Snapdragon NPU | GenieX (chat, vision); npu-embed (embeddings) | As now |
| NVIDIA | llama.cpp `llama-server`, CUDA build | One server per card, pinned with `--device CUDAn` |
| AMD, Intel, any other card | `llama-server`, Vulkan build | `--device Vulkann` |
| Snapdragon's Adreno | `llama-server`, OpenCL Adreno build (Arm64) | |
| CPU | `llama-server`, CPU build | A last resort, for short requests |
| Any of them | Ollama, LM Studio, Foundry Local, another llama-server | "Bring your own": an endpoint, a model name, and slots |

Setup (`smith accelerators setup` and the Set up button on the Smith's Settings page; Reeve's where there is no Smith: the kit's `setup.ts`) downloads llama.cpp's build for each card from ggml-org/llama.cpp's releases into `%USERPROFILE%\.reeve\servers\llama.cpp\`, and the models, as GGUF files, from Hugging Face into `%USERPROFILE%\.reeve\models\`: the same models as on the NPU (Qwen3-4B-Instruct-2507 for chat, Qwen3-VL-4B-Instruct for vision, Qwen3-Embedding-0.6B for embeddings), so answers stay comparable. It says how much it will download and asks first. It matches each card to llama-server's device by name (`llama-server --list-devices`), and gives each server its own port from 18191 up.

## The lock and the line, per accelerator

Reeve's `docs/NPU-QUEUE.md` protocol, unchanged in its rules, once per accelerator:

- Its lock folders are in `%USERPROFILE%\.npu-agent\locks\`: `<id>` for its first slot (the NPU's is `npu`, as now), `<id>.2` … `<id>.<slots>` for the others. `NPU_AGENT_NPU_LOCK` still moves the NPU's, and its folder holds the others.
- Its line is `<id>.queue`, with the same tickets, lanes, heartbeats and ages. The ticket at the head of the line takes any free slot; once it holds one, its ticket goes and the next is the head.
- A program that knows nothing of slots (Heiward, npu-embed) takes the first slot only, through the same line, and stays compatible.

## Choosing an accelerator for a request

Each request, in the kit and in Reeve:

1. **Candidates**: the accelerators that serve its kind, whose cap fits it, that haven't failed in the last 10 minutes, and, for a background request, that a game isn't using (below). When every one that serves it and fits has failed, they are all candidates again, as a last resort: a PC with only the NPU isn't left without model work for 10 minutes after one hiccup.
2. **Order**: `acceleratorOrder`. With a list, the ids it leaves out follow in the auto order.
3. **Pick**: the first candidate in that order with a free slot and nobody waiting; else the one whose line is shortest, ties by order. A background request that would be fifth or later in every line is deferred, as on the NPU now. An interactive one always joins.
4. **Fallback**: when its server won't start within 30 s, refuses the connection, answers 5xx or times out, the request leaves its turn, the accelerator is marked failed (`%USERPROFILE%\.npu-agent\accelerators\<id>.failed.json`: when, and why), and the request goes once to the next candidate. A failed accelerator is tried again after 10 minutes. A timeout while the model was loading is not a failure (below): nothing is marked, and the request goes to the next candidate, or waits for a later round.
5. **Where it ran**: every answer says which accelerator gave it. An agent's unverified note says so ("note from the RTX 4090, unverified").

**The graphics card beside the NPU.** Manor's Settings switch "Use the graphics card for models when there's an NPU" is saved as `"gpuWithNpu": true | false` in Manor's settings.json; on by default, and an absent key (an older Manor, or none) means on. Off, on a PC whose config has an NPU that serves something (not `enabled: false`), every graphics card is left out before step 1: it is never a candidate, not even as the fallback when the NPU fails, is busy or has a full line, and its servers aren't started. The processor stays a candidate as before. Without an NPU, the switch means nothing. The rule is the core's `withoutGpuBesideNpu`; the node part reads the switch afresh for each request (`gpuWithNpu()` in manor.ts). Reeve follows the same rule for its own requests, and the keeper (the Smith, else Reeve) stops a card's llama-servers while it's off.

## Model servers: busy, loading, and how long a request may take

As measured on GenieX v0.7.0 on the Snapdragon X2 Elite (2026-10-03): GenieX keeps one model loaded at a time and unloads it after 5 idle minutes (`--keepalive`); loading one takes 9 to 15 s (in every memory state tried, from 39 GB to 63 GB committed, with the model's files cached or read from disk), and a chat request after a vision one loads the chat model again. While it loads a model or answers a request, it answers nothing, not even `/v1/models`. npu-embed answers 503 while it loads.

- **A look at a server** is a GET of its `/v1/models`, waiting 3 s (`probeMs`): an answer is **ready**; a 503, or no answer from a server that took the connection, is **busy**; a refused connection (or any other answer) is **down**.
- **In its turn**, a request looks at its server afresh (a server can stop between turns: Reeve stops idle ones). Ready: on. Busy: it waits for ready, up to 180 s (`readyWaitMs`), and never starts a second server. Down: it starts the server from its `startCommand`, which has 30 s (`startWaitMs`) to take connections; a command that exits with nothing answering has failed at once. GenieX exits at once (code 0) when another server holds its port.
- **On the NPU**, each chat or vision turn starts with a **warm-up**: a one-token request to the turn's model, given 105 s (`requestBaseMs` + `coldLoadMs`). The request after it runs warm. A warm model answers the warm-up in about 0.15 s.
- **The warm-up is skipped** when the server was already up (not just started, nor found busy) and answered this same model within its keepalive, less 30 s: GenieX's `--keepalive` in the endpoint's `startCommand`, else its default, 300 s. Every agent writes `<accelerators>/<id>.served.json` (`{baseUrl, model, at}`) after each answer, so one agent's turn tells the next. Another model answered since, another server, or no record: the turn warms up.
- **A background chat or vision request** may take 15 s (`requestBaseMs`) plus 0.3 s for each token it may answer (`requestPerTokenMs`; GenieX writes about 34 a second), and never more than the config's `requestTimeoutMs`. A person waiting, and embeddings, get the config's `requestTimeoutMs`. Off the NPU (no warm-up), a request whose server was just started, or found busy, gets 90 s more (`coldLoadMs`).
- **A timeout while the model was loading** (the warm-up's, or one with the cold-load allowance) is the model being slow, not the server failing: the accelerator is not marked failed. The request goes to the next candidate, if any; else background work is deferred, and that agent leaves the accelerator alone for 5 minutes.
- **The keeper stops idle model servers** (the Smith, else Reeve: the kit's `keeper.ts`, with `rules.json`'s `keeper` timings), looking once a minute: the NPU's GenieX when no one has held or waited on the NPU for 10 minutes (`npuIdleStopMinutes` in its config), and a graphics card's or the processor's llama-servers (chat, vision and embeddings) when no one has held or waited on that accelerator's lock for 10 minutes (`gpuIdleStopMinutes`; 0 never stops them). A card's servers stop sooner when `games.json` says a game is using the card and nobody has used the card for 2 minutes: the game gets the card's memory back (a card's three servers hold some 10 to 14 GB of it). The next request starts a stopped server again. Reeve also restarts any of these servers that is running but hasn't answered for 3 minutes while nobody uses its accelerator, and GenieX alone when its working set reaches 9 GB while nobody uses the NPU. It does each holding every one of the accelerator's slots, so never in anyone's turn: one slot through the accelerator's line, as a background request that joins only an empty line (`maxAhead` 1), and, on a card with more slots, the other slot folders as plain locks (waiting 2 s for each), so no request starts on a server being stopped; when someone is in line, it waits for its next look. GenieX holds on to some 340 MB of committed memory for each model it loads, until it exits, and the NPU's DSP fails (a subsystem restart, and GenieX exits) after about a dozen vision loads in one process: stopping it frees both.
- **The keeper stops orphans**: a `llama-server` or GenieX process on the manor's ports (18181, 18191-18199, 18282 and every configured server's) that no configured server is, by its program and the address its command line serves (a test's, a scratch home's, a server an earlier config named), once it has seen it for 5 minutes (`orphanGraceMs`; 0 never), and says so in its log with the program's path and command line. Nothing nobody tracks keeps a card's memory.
- **Manor's `gpuWithNpu`** (above): while it keeps the graphics cards out beside the NPU, the keeper stops a card's servers as soon as nobody uses the card, and never restarts them.

## Games

A gaming desktop is for games first. While a game or another full-screen 3D program uses a graphics card, background work doesn't run on that card: it goes to another accelerator, or waits. A request someone is waiting on still may. A card counts as in use by a game while any other program's 3D engine on it is over 25% (Windows' `GPU Engine` counters, by the card's LUID), checked at most every 15 seconds. Heiward's ThreeDWatch does the same for its scans.

## Shared files

Every agent reads and writes these the same way, in `%USERPROFILE%\.npu-agent\accelerators\` (beside `locks\`, moved with it: with `NPU_AGENT_NPU_LOCK` set, the folder `accelerators` beside the lock folder's parent; a scratch `REEVE_HOME` gets its own). Each is written whole (a temporary file, then a rename), and anything unreadable counts as absent.

- `<id>.failed.json`: `{ "since": "<ISO time>", "reason": "<one line, at most 300 characters, starting with the kind of request: chat, vision or embed>", "by": "<who>" }`. The ISO time has its zone (`Z`, as every program writes it); a time without one counts as unreadable. The reason is the failure's first line, trimmed ("it failed" when there's none). Written when a request on the accelerator fails as above; the accelerator is skipped until 10 minutes after `since` (a marker exactly 10 minutes old has expired); a success on it deletes the file. A marker is about the accelerator's model server, so only programs that use the servers write or clear them.
- `games.json`: `{ "checkedAt": "<ISO time>", "cards": { "<id>": { "busy": true, "percent": 87, "by": ["game.exe"] } } }`. Whoever finds it older than 15 seconds checks the counters again and rewrites it; everyone else reads it. A card missing from it isn't busy. `percent` is the busiest 3D engine's, rounded; `by` lists the programs (`name.exe`). Not counted: the checking process itself, `dwm.exe`, and the model servers (`llama-server.exe`, `geniex.exe`, and any configured `startCommand` program). A check that fails leaves the file as it was. A card's LUID in the counters is lowercase `0x<high>_0x<low>`.

## What each part does

- **The Smith**: keeps the accelerators and their servers (detects them, sets up their servers, offers them in Settings, and the keeping above), with the kit's `keeper.ts`, `setup.ts`, `detect.ts` and `accelerator-config.ts`. It uses no model.
- **Reeve**: routes its own chat, vision and embedding requests by the rules above, and starts servers when needed. Where there is no Smith it keeps the accelerators too, with the same kit code; where the Smith is installed it leaves the keeping to it, and its Settings page links to the Smith's.
- **The hires' kit** (`npu.ts` and its lock and line): the same choosing, per request; one lock and line per accelerator; the game check; the failure markers.
- **Heiward**: its AI already runs on the NPU, a chosen graphics card (DirectML) or the CPU. On a card, it takes that card's lock per batch, as it does the NPU's (the first slot only; the CPU it leaves unlocked). Auto is the NPU, then a graphics card it has checked (with its current driver), then the CPU. It records why it fell back, and `status --json` says which device and card. Heiward runs its models in its own process, not behind a server, so a failure of its tells nothing about a device's servers: it keeps its failure markers in its own folder (by the same rules, through the kit's dotnet part), and neither writes, reads nor clears the shared ones. It keeps its own game watch (ThreeDWatch, on the scan's card) rather than `games.json`.
- **The Auditor**: audits each accelerator. Each one's toolchain (its driver, its server and version, its models) has its own fingerprint and baseline.
- **Manor**: the page's NPU card becomes **Accelerators**, one per accelerator, each with who holds it (per slot), for how long, when it should let go, and its line.
