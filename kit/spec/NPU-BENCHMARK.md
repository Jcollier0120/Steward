# The NPU benchmark

A standard measurement of how well each chip runs Castellan's local AI, and each model on it, so the website can rank them. The command is built (kit 2.66.0, `npu-bench.ts`) and has run on a real Lunar Lake; the website's boards aren't yet. It builds on the NPU check (`npu-check.ts`, NPU-VENDORS.md's "Verified, and not"), which sets a route up, starts its server and measures it.

The owner decided three things on 2026-10-12: count the tokens agents really send, so the jobs' mix can be set from them (the token tally, below); publish energy figures where the battery reading holds up; and show the Lunar Lake's Arc graphics card as a row on the chips board beside its NPU.

The two stay separate tools with shared parts:

| | NPU check | NPU benchmark |
|---|---|---|
| Asks | Does this route work on this NPU, and what caps and timeouts suit it? | How fast and how well does this chip do Castellan's work, against others? |
| Prompts | Whatever finds the limits (past the cap, two at once, a restart) | A fixed, versioned suite, the same on every PC |
| Output | Pass or fail per step, and suggested numbers for `npu-vendors.json` | A report in a fixed format, comparable across makers, for the website |
| Quality | The answer says "ready" | Graded answers; a run that fails the gate isn't ranked |

## What is being ranked

A **run** is one PC, one device on it (the NPU, or its graphics card or processor for comparison), one model, one server version and driver, measured with one version of the suite.

The website shows two boards:

- **Chips**: one row per chip generation (Snapdragon X2 Elite, Lunar Lake, Ryzen AI 300...), each with the model Castellan ships for it, measured by us. This is what a customer gets on that chip.
- **Models**: per chip, every model we've measured on it, shipped or a candidate. This is how we choose what to ship.

Every model Castellan runs today is a Qwen model at 4-bit weights:

| Maker | Server | Model | Weights |
|---|---|---|---|
| Qualcomm X | GenieX 0.8.0 | Qwen3-VL-4B-Instruct (W4A16) | 4-bit, 16-bit activations; also does vision |
| Qualcomm X2 | GenieX 0.8.0 (its llama.cpp plugin) | unsloth/Qwen3-VL-2B-Instruct-GGUF (Q4_0) | 4-bit; also does vision, its encoder on the Adreno |
| Intel | OpenVINO Model Server 2026.4.1 | Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov | 4-bit symmetric, channel-wise |
| AMD | FastFlowLM 1.0.7 | qwen3.5:2b (Qwen3.5-2B) | 4-bit; also does vision |

They are not the same weights: each maker's NPU needs its own format, Qualcomm's are vision models, and AMD's is a smaller model that does both. So the chips board doesn't claim identical models. It compares what each chip delivers with its shipped model, names the model on every row, and shows a quality score beside the speed, so a faster chip whose model answers worse can't hide it.

The Qwen3 models share one tokenizer (151,936 tokens), so their token counts mean the same thing. Qwen3.5's is larger (248,320), so the same text is usually fewer tokens to it, and its tokens a second aren't quite the Qwen3 rows' tokens a second. The jobs, timed in seconds, compare as they are.

## The suite

The suite is data, `npu-bench-suite.json` beside this file, with a version (`castellan-npu-bench/2`). The website compares only runs of the same major version. A change to a prompt, a grade or a setting is a new version. Version 2 (kit, Unreleased) asks every read and job as a prompt the server hasn't seen (Settings, below); version 1's asked the same prompt again, so on Intel its reads and jobs were partly the prefix cache's and don't compare.

### Settings for every request

- `temperature: 0` and a fixed `max_tokens` per request, as the kit's own `chatBody` sends, and the model's thinking turned off where it has any.
- **Every read and job is new to the server.** Its prompt starts with a line of its own, `[bench <run>-<count>]`, different in every request: the warm-up, each try, each size, the read near the cap, holding speed and energy (`freshPrompt`). OpenVINO Model Server turns the NPU's prefix caching on, which keeps every whole block of a prompt it has read (128 tokens on an NPU 3720) and doesn't read them again. Asked the same prompt a warm-up and three times over, the NPU 3720 took 0.74 s to the first token at 512 tokens; asked one it hadn't seen, 2.26 s, and 3.6 s at 1,024 against the same 0.75 s (Core Ultra 5 225U, 2026-10-14). An agent's prompts are mostly new text, so the new prompt's time is the one that counts. The short answer and the writing prompt stay the same every time, being shorter than a block, and so do the quality items, which are graded, not timed. GenieX's requests were already new, by their nonce (next), and only its route has vision.
- **The server's quirks, as an agent's requests carry them** (the route's `quirks`, ACCELERATORS.md). GenieX's `prefix-leak`: every request starts with a nonce, because GenieX leaks state between requests that share a prompt's start, and the benchmark asks each prompt a warm-up and five times over. GenieX's `image-path`: each picture is written to a file of its own in the temporary folder and its path sent, because GenieX reads a local path, not a `data:` URL. Other servers get pictures as `data:` URLs. FastFlowLM's `sides-of-32`: a picture 720 px tall or less with a side of a whole number of 32 px gets that side a pixel longer, as an agent's does (three of the suite's four pictures), before its request's clock starts. The run's log names the quirks it applied.
- **Streamed** (`stream: true`, with usage in the last chunk), so the time to the first token (reading the prompt) and the time between tokens (writing) are measured separately. The NPU check doesn't stream, so it estimates writing speed by taking off half a short answer's time. That is close enough for a timeout, but not for a ranking. A server that can't stream is measured without it and the run is marked: its job times still count, its reading and writing speeds are shown as estimates and not ranked.
- Token counts come from the server's own usage numbers. A server that doesn't report them is marked the same way.
- Every prompt fits under 1,280 tokens, prompt and answer together, so it runs under every route's cap (the smallest chat cap is Qualcomm's 2,400). A route whose cap is lower can't run the suite, and the website says so rather than leaving it out silently.

### What it measures

1. **Loading.** The first start with an empty compile cache (OpenVINO compiles the model for the NPU; 31 s on a Lunar Lake), then a start again from the cache. Each start is timed to the first correct answer.
2. **A short answer, warm.** "Reply with the single word: ready". This is the shortest wait a person sees. Shown as the median of five.
3. **Writing speed.** A prompt that makes the model write at least 256 tokens (the numbers one to one hundred in words). Tokens a second between the first token and the last, median of five.
4. **Reading.** Prompts of 512 and 1,024 tokens, each one new to the server (Settings, above), timed to the first token, median of five each. Also measured once at 90% of the route's own cap and shown, but not ranked, because caps differ. The board shows this as **seconds to start answering**, not as tokens a second, because an NPU may not read in proportion to length. Intel's NPU reads a prompt in pieces of about 1,024 tokens, and each piece costs about the same however full it is. Streamed on the Lunar Lake, the first token came after 0.75–0.77 s for prompts of 15, 505 and 980 tokens, after 1.79 s for 1,227 and 1,645 tokens (two pieces), and after 4.37 s for 3,312 (four). A tokens-a-second figure would call it 20 for a short prompt and 1,280 for a long one, and neither is the truth. The NPU check's "650 a second" has the same flaw. The time to the first token, at fixed sizes, means the same on every chip.
5. **Three reference jobs.** Real-shaped requests, each graded as well as timed:

   | Job | Reads | Writes | Like an agent's |
   |---|---|---|---|
   | Triage | about 850 tokens (an email thread) | up to 24 (a JSON label) | sorting what came in |
   | Reply | about 250 (a message) | up to 120 (a reply) | drafting a short answer |
   | Summary | about 800 (a document) | up to 200 (a summary) | reading something for its owner |

   Each job is run five times, and its median time is taken. **Job time** is the three medians added together, in seconds. It is the chips board's ranking: one number, lower is better, which says "how long this chip takes to do a typical piece of agent work". It weighs reading against writing the way Castellan's agents actually use them, which a ranking by writing speed alone would not. The mix is checked against what the agents really send (the token tally, below) before the suite's first release.
6. **Quality.** 24 graded items (below). The score is the share answered correctly.
7. **Memory.** The server's working set and private bytes after the jobs, as the NPU check reads them.
8. **Holding speed** (the full run only). Ten minutes of triage jobs back to back. It shows how fast the job runs in the first minute and in the last: a laptop that gets hot and slows down shows it here.
9. **Energy** (optional, `--energy`). What the run reads depends on the PC (`power-meter.ts`, kit 2.98.0):
   - **Windows' Energy Meter counters**, where the PC's firmware has them (the Snapdragon X2 laptop does): a running energy total for each part it meters (`npu`, `gpu`, each `cpu_cluster`, `memory`, `soc`, and `system`, the whole PC), read through CIM (`Win32_PerfRawData_PowerMeterCounter_EnergyMeter`: picowatt-hours, at a clock in milliseconds) with no administrator, and only at each stretch's two ends, so the reading's own cost is the same in every stretch and taking rest away takes it out. They read plugged in or not. `--meter auto`, the default, uses them where they're there.
     An Intel laptop has Intel's own (RAPL; a Core Ultra 5 225U does): `rapl_package0_pkg`, the processor chip whole (its cores, graphics, NPU and the rest of it); `_pp0`, its cores; `_pp1`, its graphics; and `_dram`, memory, which reads 0 on the 225U. No `system`, so the chip is the whole (kit 2.98.2; before, the first counter listed, its graphics, was), and no `npu`: the NPU's share is the chip's less its cores' and graphics'. The screen and the rest of the PC aren't in it.
   - **A Shelly plug** (Gen2 or later, `--meter shelly:<address>`): the whole PC from the wall, its charger's loss too, its power read every second over the local network (`/rpc/Switch.GetStatus?id=0`). Plugged in, with the battery full: a charging battery would swamp it, so the run reads `BatteryStatus` and says when it was charging (`charging` in the report).
   - **The graphics card's own reading** (`--meter nvidia`): nvidia-smi's running total (`total_energy_consumption`) where the card keeps one, else its draw every second. The card alone, for a desktop.
   - **The battery's discharge rate** (`--meter battery`, and `auto` unplugged on a PC without the counters; `root\wmi` `BatteryStatus.DischargeRate`, in milliwatts, every 5 s). The least trusted: on the Lunar Lake laptop, an HP OmniBook X 17, it read 28–29 W at rest while the battery's real drain was about 16 W, and working read only 2–6% more, or less. So its figure counts only when working reads clearly more than rest: by 1 W and by a tenth of the rest reading (`ENERGY_MIN_EXTRA`); otherwise the report keeps both readings with no millijoules a token, and the log says why. With it the run measures the triage minutes alone, as before kit 2.98.0.

   With any meter, the run reads a minute at rest after everything else, then three minutes of triage jobs back to back: the extra energy divided by the tokens done gives **millijoules a token**. With a meter other than the battery it also measures:
   - **What keeping a model loaded costs**: the PC at rest with no model loaded (a minute, before the server starts), and with the model loaded (a minute, just after its cold load). The agents keep their model loaded all day, so this can matter more than any one job.
   - **Batches** of the agents' work, each measured on its own: 20 of each job (5 on a quick run), 20 reads of 1,024 tokens, and up to 8 pictures where the model sees (after one untimed, as for vision). A batch's energy, less what each part draws at rest over as long, is the work's own: by part, for one of them, and for a token.

   A whole-PC figure includes the screen and everything else, so the run records the screen's brightness (it doesn't change it). This is where an NPU should show what it's for: on Intel slower than its graphics card, but with far less power.

   From kit 2.99.0, the embedding model is measured the same way (11, below): the PC at rest with it loaded, against no model (`energy.embed`), and a batch of embedding requests (`batches.embed`, 20 on a full run, 5 on a quick one).

   From kit 2.99.0, each rest is read once the PC has settled: its draw is read ten seconds at a time until two readings in a row agree within 5% (or 0.1 W), for up to three minutes (the suite's `settleSeconds` and `settleMinutes`), and the log says when it had to wait, or never settled. A rest read straight after other work reads high: on the X2, rests read just after another device's run came out up to 7 W over, so the model loaded seemed to cost less than no model. The battery's reading is read as it is, never settling.

   From kit 2.99.0, a run with `--energy` holds the PC awake with its screen on from its start to its end, as a video player does (`holdAwake`: Windows is asked to, and lets go when the run ends however it ends; its settings stay as they are). With the screen off, Windows takes a PC into Modern Standby, and there the X2 rested at 5.4 W against 9–10 W awake: a run that crossed into it compared two different PCs. Windows' log then says whether the PC went into standby all the same (a lid closed, the power button): the report's `conditions.standby`, marked `standby` and not ranked when it did.
10. **Vision** (where the model has it). Four questions about fixed pictures, graded, after one picture as a warm-up that isn't counted: GenieX holds one model at a time and loads its vision part for a picture, so the first picture's time would be that load's. Shown as its own column; it is not part of job time, because Intel's route has no vision yet.
11. **Embeddings** (kit 2.99.0, where the route has an embedding model: Intel's and the Snapdragon's, and llama.cpp's beside the model off the NPU; AMD's NPU route has none). Once the chat server has stopped, the embedding server is started by itself, as an agent's first request starts it, and timed to its first vector. Then a query (`suite.embed.query`) and requests of 16 texts of about 1,500 characters each (an agent's chunks of a file), each request's texts new (`embedTexts`), a warm-up and then the tries as for the rest: each one's time, the tokens the server counted, and tokens a second. The server is stopped again before the run ends.

### Quality items

24 items with answers a program can grade, six of each kind:

- **Following an instruction**: one word, a number only, a given format. Graded by an exact match or a regular expression.
- **Finding something in a long text**: a fact placed at the start, middle or end of a prompt of about 1,000 tokens. Graded by an exact match. These also catch a server that quietly reads only part of a long prompt.
- **JSON**: an answer that must parse and have given fields with given values. Graded by parsing.
- **Short reasoning**: arithmetic, dates, which of two. Graded by number: the first number in the answer. An answer that shows its working when asked for the number alone ("3 + 2 × 4 = 11") counts as wrong, because an agent reads the answer as a number, and so does one that hedges ("32, or 42").

Three of them are **must-pass**: the "ready" answer, a find at the end of the long text, and one JSON answer. A model that fails any of them runs badly on that device (the group-wise Qwen3-4B on Intel's NPU answered nonsense fast; kit 2.65.0), and the run isn't ranked however fast it was.

The **gate** for ranking is all three must-pass items, and a score no lower than the gate in the suite. The gate is calibrated before the suite's first release, by running it on every route known to work (the Snapdragon X2 Elite's NPU, the Lunar Lake's NPU and its Arc graphics card) and setting the gate 10 points below the lowest of them. Until it is calibrated it is a placeholder (75%).

### Conditions, and runs that don't count

Laptops vary with power and heat, so every run records how it was measured, and a run is ranked only when these conditions hold:

- **Plugged in** (except energy read from the battery, which needs it unplugged), with Windows' power mode recorded. The power mode Windows ships with is the one ranked. Whether "Best performance" changes much on an NPU is worth measuring once.
- **Nothing else working**: the processor under 15% busy for 30 seconds before the start, and no other model server answering (as the NPU check refuses to measure beside the keeper's server). From kit 2.99.0 a busy processor is waited for, up to 10 minutes (`quiet.waitMinutes`), before the run starts, so a series' next run starts once whatever ran meanwhile has finished. And a route's port that something else holds (the keeper's own server, most likely) is left to it, never stopped: the run takes ports beside it (100 to 199 above) and is marked `beside`, since the other server may be working meanwhile.
- **Steady**: for each measurement, the spread of its five tries ((slowest − fastest) / median) is under 15%. A noisy measurement is shown as noisy and the run isn't ranked.
  - A job's tries are judged at one answer length (kit 2.78.0). Each try is a prompt the server hasn't seen, so each gets an answer of its own length, and a longer answer takes longer to write without the server being slower. So each try's writing, from its first token to its last, is scaled to the tries' median answer length (the server's token counts) before the spread is taken: `spreadAtLength`. The job's median is still of the whole times, what a person waits.
  - Before, the jobs kept every GenieX full run off the board, even with the PC quiet. On the X2 Elite the 4B's summary took 3.3 to 4.3 s and the 2B's reply 508 to 666 ms, while the short answer, writing and reading held within 5%: the server was steady, and most likely only the answers' lengths varied. Those runs didn't record token counts. The first run that does will show it.
  - A server that doesn't stream or count tokens (marked so anyway) has its jobs judged on whole times. No number changes, so runs still compare within version 2, and a report from before keeps its verdict.
- **Passed the gate**, with every job answered.

Before the five measured tries of each kind, there is one warm-up try, which isn't counted.

### How long a run takes

Past setup: about 8 minutes for the quick run (loading, short answer, speeds, the jobs and quality, each three times instead of five, so it's shown but not ranked), and about 25 for the full run (five tries each, holding speed, and energy if asked for). The first start's compile adds about half a minute on Intel, and the embeddings (from kit 2.99.0) a minute or two, three more with `--energy`. With `--energy`, each of its four rests waits for the PC to settle first (kit 2.99.0): about twenty seconds on a quiet PC, up to three minutes on a busy one.

## The report

One JSON file per run, `castellan-npu-bench-report/1`, with its schema beside this file (`npu-bench.schema.json`):

- **suite**: version (`castellan-npu-bench/2`), kit version, profile (quick or full).
- **pc**: the processor and its chip generation (as detection labels it, e.g. "Intel Core Ultra 7 256V, Lunar Lake"), the NPU's name, PCI device and driver version and date, RAM, Windows build, and the laptop's make and model (cooling and power limits differ between laptops with the same chip).
- **conditions**: plugged in or battery, power mode, battery charge, how busy the processor was before the start, and (kit 2.99.0) `beside`: the route's ports another server held, so the run took others; with `--energy`, `awake` (the run held the PC awake, its screen on) and `standby` (how many times it went into Modern Standby all the same, from Windows' log).
- **run**: device, server and version, model id, size and each file's SHA-256 (as `npu-vendors.json` pins them; a candidate's are measured once setup has pulled it, except on FastFlowLM's route: see `--candidate` in **What's built**), and whether it is shipped or a candidate. On a played run (`--generation`, below), `played`: the older Snapdragon's generation this NPU played. From kit 2.99.0, off the NPU on llama.cpp, the server is `llama.cpp b11734 (<its build>)` and the files are the GGUFs it ran (Comparing devices, below); and where the kit builds the server's plugin (GenieX's on an X2), `plugin`: the kit's build installed (`kit`), a copy of the server running it (`kit-copy`), the server's own (`server`, not ranked), or neither (`other`).
- **results**: each measurement's five tries, their median and spread, and the job time. Each job also has each try's answer tokens (`answerTokens`) and first-token time (`firstTokenMs`), and its spread at one answer length (`spreadAtLength`). With `--energy`, `energy`: the power at rest and through the triage minutes, and millijoules a token; from kit 2.98.0, with a meter other than the battery, also the meter (`meter`, and the part that is the whole PC, `whole`), whether the battery was charging, each part's power at rest without the model and with it (`idle`, and what keeping it loaded costs, `keepLoadedMilliwatts`), each part's at rest and working (`restParts`, `loadParts`), and each batch (`batches`: how many, how long, the tokens, each part's energy and over rest, one's and a token's). From kit 2.99.0, `embed`: the embedding server and model, its time to the first vector (`loadMs`), a query's and a request's times (`queryMs`, `requestMs`), the texts a request, the tokens counted, tokens a second and the vectors' length (`dims`); null where it wasn't measured. And in `energy`, `embed`: each part at rest with the embedding model loaded, and what keeping it loaded costs, with its batch in `batches.embed`.
- **quality**: each item's answer, its grade, the score, and whether the gate passed.
- **marks**: anything that keeps it off the board (not streamed, estimated tokens, noisy, battery, gate failed, played, and from kit 2.99.0 `beside`, `standby` and `plugin`), each with its reason in plain words.

A series of runs (`--runs`, `--device NPU,GPU,CPU`, Comparing devices, below) writes each run's report and a **summary** beside them, `castellan-npu-bench-summary/1`: each device's figures, each the median of its runs.

Nothing in it names the person or the PC: no user name, PC name, serial number or paths. The laptop's make and model is the most it says about whose PC it was.

## Running it on a PC

What an agent (or a person) does to measure a PC for the website's boards, start to finish. A run changes nothing on the PC: it sets the route up as setup does without writing `config.json`, starts the server itself, and stops it at the end. Ask the owner before the steps that pause their agents.

**1. The newest kit.** Every agent carries the benchmark in its `src\kit\`, at the kit version its `kit.json` pins, so an agent's copy can be older than this page. Run the Steward's instead, from a worktree of its own (never switch the branch of a checkout another session works in):

```powershell
git -C C:\Projects\Steward fetch origin
git -C C:\Projects\Steward worktree add C:\worktrees\Steward-bench origin/main   # or the branch to test, before it merges
cd C:\worktrees\Steward-bench
npm ci
npm run kit        # fills src\kit\ from kit\
```

`src\kit\VERSION` is the kit it runs, and the report says it (`suite.kit`).

**2. Node for the processor.** Node 22.18 or later (the kit runs TypeScript as it is), built for this PC's processor: `node -p "process.arch"` must print `arm64` on a Snapdragon and `x64` on Intel or AMD. An x64 Node on a Snapdragon runs under emulation, which slows the benchmark's own timing and stream reading. If it prints the wrong one, install the right one (`winget install OpenJS.NodeJS.LTS --architecture arm64` on a Snapdragon) and open a new terminal.

**3. The conditions** (Conditions, above). A run that misses one still writes its report, marked, but isn't ranked:

- Plugged in, for the speed run (energy is a second run, step 7).
- Windows' default power mode, **Balanced** (Settings › System › Power & battery › Power mode). It is the one ranked, and on Intel's NPU Best performance changed nothing.
- **The processor under 15% busy** before the start: the benchmark reads it ten times, 3 s apart, and marks the run `busy` above 15%. Close other programs and wait for Windows Update or a Defender scan to finish; Task Manager shows it.
- The PC stays awake for the half hour: if its screen or sleep timeouts are shorter, lengthen them for the run (Settings › System › Power & battery › Screen, sleep & hibernate timeouts) and put them back after. From kit 2.99.0 a run with `--energy` keeps the PC awake with its screen on by itself, until it ends, and changes no setting. Leave the brightness as it is: the report records it. Leave the lid open.

**4. Nothing else on the NPU.** The benchmark needs the NPU to itself. From kit 2.99.0, where the keeper's server holds the route's port (GenieX 18181, OpenVINO Model Server 18183, FastFlowLM 18184, or an embedding server's), the benchmark leaves it running and takes ports beside it, but marks the run `beside` and doesn't rank it, since the keeper's server may be working meanwhile. Before kit 2.99.0 it stopped at once, exit 1. For a ranked run, with the owner's OK:

- In Manor, pause the keeper's duty (the Smith's, else Reeve's), so it starts nothing, and the agents that ask the local models, so none sends the server a request mid-run.
- Stop the NPU's servers that are still running, and its embedding server (the Snapdragon's llama-server on 18182, Intel's second OpenVINO Model Server on 18186): it holds the NPU's memory, and the benchmark doesn't ask it anything.

  ```powershell
  Get-NetTCPConnection -State Listen -LocalPort 18181,18182,18183,18184,18186 -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Process -Id $_.OwningProcess } | Select-Object Id, Name, Path
  Stop-Process -Id <each Id listed>   # the manor's own: geniex, llama-server, ovms or flm
  ```

  Run the first command again: it must list nothing. A program that isn't the manor's (its path outside the GenieX CLI folder and the tools home's `servers\`) is the owner's to stop, not yours.

  From kit 2.98.2 each of the benchmark's requests takes the NPU's turn, as an agent's does, whichever device it runs on: its server is on the route's port, which the keeper's reaper watches as the NPU's and stops once nobody has taken the NPU's turn for 5 minutes. Before, it stopped the benchmark's server partway through every run on a Core Ultra 5 225U, and every answer after failed. A turn held for the whole run doesn't do: anyone else counts a holder stale after `rules.json`'s `lock.staleMs` (10 minutes). An agent's request still gets the NPU's turn between two of the benchmark's, and reaches its server, so pausing the agents still matters.

**5. A quick run first** (about 8 minutes past setup), to see every step works before the half hour:

```powershell
node src\kit\npu-bench.ts --profile quick --yes 2>&1 | Tee-Object -FilePath npu-bench-quick.log
```

On a PC where Set up local AI already ran, nothing is downloaded; on a fresh one, `--yes` lets it download what setup would instead of asking: the server and its model (about 4.4 GB on a Snapdragon X, 1.9 GB on an X2, 2.4 GB on Intel), and from kit 2.99.0 the route's embedding server and model for the embeddings (Intel's 428 MB). `--no-setup` never fetches them: the embeddings are then left out, and the log says so. It exits 0 when it ran to the end, ranked or not, and 1 when it couldn't, with the reason in its last lines.

**6. The full run, plugged in.** This is the one the boards rank, about 25 minutes past setup:

```powershell
node src\kit\npu-bench.ts --profile full --yes 2>&1 | Tee-Object -FilePath npu-bench-full.log
```

Its last line says `Ranked: it met every condition.` or why not. A run that isn't ranked is still worth sending: the marks say what to fix.

**7. Energy.** First see which meter the PC has. It takes a few seconds and changes nothing:

```powershell
node src\kit\power-meter.ts
```

It prints `The meter: Windows' Energy Meter counters (…)` and what each part draws now, or `No meter: …` and why. Then, with the PC set as in steps 3 and 4:

- **With the counters** (the Snapdragon X2 has them; an Intel or AMD laptop may): stay plugged in, the battery full if you can, and run the NPU, the graphics and the processor in turn, three times each (Comparing devices, below):

  ```powershell
  node src\kit\npu-bench.ts --device NPU,GPU,CPU --runs 3 --energy --yes 2>&1 | Tee-Object -FilePath npu-bench-devices.log
  ```

  It is nine runs, about 12 minutes each on a quick profile (`--profile quick`) and about 35 on a full one, plus waits for a quiet processor. From kit 2.99.0 every route runs on every device: Intel's server itself, GenieX's and FastFlowLM's model on llama.cpp off the NPU.
- **Without them, with a Shelly plug**: the PC plugged into it, the battery full, and `--meter shelly:<the plug's address>` added to the same commands.
- **With neither**: unplug, with enough charge for half an hour, and run the first command. It reads the battery (`--meter battery`), the least trusted figure, and its speed figures aren't ranked (marked `battery`).

`--energy` adds about 10 minutes to a run (the rests, the triage minutes and the batches). Its log lines begin `energy`: the meter, the two rests and what keeping the model loaded costs, the triage minutes' millijoules a token, then each batch, such as `energy, 20 reply jobs: 31.0 J in 12.3 s; each over rest 1.05 J (npu 0.08 J, graphics 0.00 J, processor 0.52 J, memory 0.04 J)`. A quick run (`--profile quick`) does 5 of each, for a first look.

**8. What to send back.** For each run:

- **The report.** Its last lines say where: `The report: <path>`, by default `npu-bench-<maker>-<device>-<date>.json` in the tools home (`%USERPROFILE%\.manor\accelerators`, or `%USERPROFILE%\.reeve` on a PC set up before kit 2.31.0; `--out <file>` puts it elsewhere). It names nothing personal.
- **The log** (the `Tee-Object` file), and when a step failed, the server's own output, `servers\logs\npu-bench-<maker>.log` in the tools home. Logs hold the PC's folder paths, so send them privately (to the session or person who asked, or a secret gist), never to a public page.
- **The summary**, for a series: `npu-bench-summary-<maker>-<date>.json` beside the reports (or `<out>-summary.json` with `--out`), and the table the log ends with.

Then resume the keeper and the agents in Manor, and put any timeouts back.

### On a Snapdragon

The route is GenieX 0.8.0 on port 18181, one model for chat and vision: on an X2, Qwen3-VL-2B (unsloth's Q4_0 GGUF, through GenieX's llama.cpp plugin, its pictures' encoder on the Adreno; kit 2.78.8), and on a first-generation X, Qualcomm's Qwen3-VL-4B-Instruct (W4A16). Run it as above, with an Arm64 Node, and look for these:

- **GenieX's quirks are applied.** Near the start the log says `GenieX's requests as the kit sends them: a nonce first in every request (prefix-leak); each picture as a file of its own, its path sent (image-path)`. If that line is missing, `src\kit` is older than this page: go back to step 1. Without the nonce GenieX reuses state across the tries of one prompt, and without the files it can't read the pictures.
- **One model at a time.** GenieX holds one model and loads its vision part for a picture after text. The benchmark sends one picture as an untimed warm-up before the four graded ones, so their times aren't a load's, and its second start (the cached load) is a new process. GenieX's DSP fails after about a dozen vision loads in one process (ACCELERATORS.md); a run sends five. This is also why nothing else may ask GenieX during the run (step 4): another agent's request would make it swap.
- **The cap is 2,400 tokens, and stays there.** The kit counts three characters a token, so for text like the suite's 2,400 by its count is about 1,700 by the server's. An ~8K-token prompt bluescreened the X2 Elite (bug check 0x18B). The benchmark's longest prompt is its read near the cap: 90% of 2,400 at four characters a token, about 2,050 tokens by the server's count. That is more than an agent ever sends GenieX, and a quarter of what crashed it. `--cap` is refused on GenieX (exit 2: it compiles no prompt length). Never raise the cap in `npu-vendors.json`, or the suite's sizes, to read further on a Snapdragon.
- **The Adreno and the processor run the same model on llama.cpp** (kit 2.99.0). GenieX runs on the NPU only, so `--device GPU` and `--device CPU` run the X2's model, the very GGUFs GenieX pulled (from its cache, nothing downloaded), on llama.cpp b11734: its OpenCL build for the Adreno, found by name as setup finds it, and its Arm64 build on the processor. They run at GenieX's context (2,560) and picture cap (1,024 tokens), on ports 100 above GenieX's. Only llama.cpp's two builds are downloaded (13 MB each), into setup's own folders. A first-generation X has no llama.cpp form of its 4B (it's AI Hub's QAIRT build), and is refused, exit 2.
- **The kit's build of GenieX's plugin** (kit 2.99.0). The X2 runs Castellan's build of GenieX's llama.cpp plugin once the keeper puts it in (NPU-VENDORS.md), whose processor threads sleep while the NPU works (GENIEX_PATCH_POLL, kit 2.98.1). Where GenieX's own plugin is still in place (the keeper hasn't put it in yet, or the owner keeps it off), the benchmark runs a copy of GenieX in the tools home's `bench\` folder with the kit's build, its QAIRT folder linked rather than copied, and removes it after. GenieX's own files are never touched. The report says which (`run.plugin`). A run on GenieX's own plugin, where the copy can't take the kit's (a GenieX the build isn't made for), is marked `plugin` and not ranked: its processor threads spin, which makes its energy meaningless.
- **Streaming is unverified.** Whether GenieX streams one chunk a token and puts its token counts in the last chunk hasn't been checked. The first run's report says: `run.streamed` and `run.usageReported`. If either is false, the run is marked `not-streamed` or `no-usage` and isn't ranked; send it back anyway, as that is the finding. If the first load fails with a 4xx in GenieX's log, it refused the streamed request (`stream_options`, say): send the log.
- **Energy on the X2 Elite: its counters.** The X2 laptop has Windows' Energy Meter counters, so it needs no meter, plugged in or not, and their whole agrees with the charger's own rail (`system` 21.3 W against `psu_usb` 21.1 W, 2026-10-22). A first trial, five short chats to the keeper's GenieX (Qwen3-VL-2B) on a PC that wasn't quiet, measured twice: the NPU drew 5.1–5.3 W (0.17 W at rest), but the processor rose from 5 W to 25–40 W, and GenieX's own processor time grew by 45 s over those 11 s of chats: about four cores busy for the NPU's chat. The whole PC took about 1 J a token over rest, 80 mJ of it the NPU's. A quiet run says how much of that is GenieX's own. If it holds, GenieX's llama.cpp threads cost more than the NPU does, waiting on it by spinning (llama.cpp's `--poll`?), and that is the first thing to cut.
- **Setup checks the model's files.** On the X2 Elite each of Qwen3-VL-2B's pinned files is read and its SHA-256 checked before the server starts (1.9 GB; the 4B's, 4.3 GB, with `--model` the 4B), so the first lines take a little while. A `--candidate`'s files are read once too, after setup, for the report's SHA-256s.
- **A start again waits for GenieX's port.** GenieX killed is gone at once, but its port stays bound about 2 s: requests time out for the first second, then are reset, then refused (measured on the X2 Elite, 2026-10-15). The benchmark, like the NPU check, waits until a connection is refused before it starts GenieX again (kit 2.74.7). Before, it started it while the port was held: GenieX couldn't bind it ("Only one usage of each socket address" in its log), and the cached load failed with "no correct answer".
- **The X2's model** (kit 2.78.8). The benchmark measures the models setup runs on the PC: on every X2, whatever its memory, its generation's own, Qwen3-VL-2B (from kit 2.78.0 on an X2 under 20 GB alone, its `smallPc`). `--model qualcomm/Qwen3-VL-4B-Instruct:W4A16` measures the route's own 4B on an X2, for comparing; a `--candidate` is pulled and served as that 4B is (AI Hub's QAIRT build). `--small-pc` measures a generation's `smallPc` models, of which there are none now. The report's `run.model` says which.
- **An X played on the X2.** `--generation snapdragon-x` (kit 2.74.7) runs the first X's code on the X2's NPU: AI Hub's X Elite build of the model, served by GenieX from a folder of its own (`{tools}\played\snapdragon-x\geniex`, whose `config.json` names the X Elite to AI Hub), checked against the X Elite's pins there. The report says `run.played`, carries a `played` mark, and is never ranked: its numbers are the X's code on the X2, not an X's speed. A newer Snapdragon on an older one is refused (exit 2), as is `--generation` on any NPU but a Snapdragon, where it would be another generation's starting values alone (NPU-VENDORS.md, Playing an older Snapdragon on a newer one).

The plugged-in full run's report is what the website's speed table takes for the Snapdragon row.

### On Intel: energy on a Core Ultra 5 225U

The first energy runs on Intel (kit 2.98.2, 2026-10-22): a Lenovo 83KS, Core Ultra 5 225U (NPU 3720, Arc graphics), plugged in, Balanced, Reeve stopped, Qwen3-4B-Instruct-2507 int4-cw on OpenVINO Model Server 2026.4.1, the full run with `--energy` on each device, each ranked. Energy is the chip's (RAPL `pkg`) over rest; each job's is a batch of 20's, divided by 20.

| | job time (3 jobs) | writing | read 1,024 | triage, reply, summary: each | the three | over rest while working | a token (triage minutes) |
|---|---|---|---|---|---|---|---|
| NPU | 27.4 s | 13.2 tok/s | 3.5 s | 34, 63, 81 J | 178 J | 6.7 W | 36 mJ |
| Graphics | 21.6 s | 19.0 tok/s | 4.3 s | 79, 112, 145 J | 336 J | 16.2 W | 85 mJ |
| Processor | 36.3 s | 18.0 tok/s | 11.0 s | 249, 208, 361 J | 818 J | 22.3 W | 279 mJ |

The graphics card does the three jobs 21% faster than the NPU, for 1.9 times the energy; the processor is slower than the NPU and takes 4.6 times it. The NPU's own share has no counter: its cores drew 2–6 J a job, the rest is the NPU and the chip around it. All three answered the same 23 of 24 quality items. Keeping the model loaded cost nothing measurable on any of them (−0.6 to +0.3 W, within the rest's noise).

## Comparing devices (kit 2.99.0)

What the NPU is for shows against the rest of the chip: the same model on the NPU, the built-in graphics and the processor, each measured the same way, and what the whole PC spends on each.

```powershell
node src\kit\npu-bench.ts --device NPU,GPU,CPU --runs 3 --energy --yes 2>&1 | Tee-Object -FilePath npu-bench-devices.log
```

- **The same model on each.** Intel's server runs on all three (`--target_device`). GenieX and FastFlowLM run on the NPU only, so off it their model runs on llama.cpp b11734, setup's pinned build for the device: the Adreno's OpenCL build and Arm64's on a Snapdragon X2, a Radeon's Vulkan build and x64's on AMD (NPU-VENDORS.md, Off the NPU). It runs at the NPU's context and picture cap, with its thinking off where the NPU's server turns it off, and with setup's embedding model beside it. What it needs is downloaded into setup's own folders, once asked (`--yes`): llama.cpp's build (13–33 MB), and on AMD the model as GGUF (1.9 GB, FastFlowLM's own weights being its NPU format). On an X2 the model is the GGUF GenieX already has.
- **A round at a time.** Each device in turn, then again (NPU, GPU, CPU, NPU …), so whatever drifts on the PC (its warmth, what else runs) falls on every device alike. Each run waits for a quiet processor (up to 10 minutes), writes its own report (`<out>-<device>-<round>.json` with `--out`), and leaves nothing running. A device refused (exit 2: no llama.cpp form of a candidate, say) isn't tried again.
- **The summary.** Then each device's figures, each the median of its runs, are written beside the reports (`castellan-npu-bench-summary/1`) and printed as a table, a column a device. `npu-bench.ts --summary <report.json>...` sums up reports from runs made separately.

### Reading the summary

Speed and quality read as in a report. The energy rows need a meter other than the battery (the counters, a Shelly plug or a card's own reading), and are the whole PC's (the meter's `system`, or the plug's), so the screen and everything else are in them alike on every device:

- **keeping the model loaded**: the PC at rest with the model loaded, less at rest with no model, and the same over a day (Wh/day): what the agents' habit of keeping their model loaded all day costs, used or not. **keeping the embedder loaded** is the same for the embedding model by itself. Below nothing, it reads **too small to tell**: the two rests varied by more than the model costs, which is no saving.
- **`<batch>: each over rest`**: one job's energy over the PC at rest just before the batch (working less idle), and **a token over rest** the same a token. This is the work's own cost: the device that does a job for the fewest joules.
- **`<batch>: the whole PC, the batch`**: everything the PC spent finishing the batch, rest included, and how long it took. A device that draws more but finishes sooner can spend less here than a slower, frugal one, because the PC's own draw runs on until the work is done: this is what a battery sees.
- The summary's JSON also has each batch's job by part (`eachByPart`: the NPU's, the graphics', each processor cluster's, the memory's), which says where the energy went.

Three runs, medians: one run's hiccup (a Defender scan, an update) moves no figure. The runs' own marks are listed with each device (`quick` for the quick profile; `beside` or `plugin` say a figure isn't what this PC does unhindered, and `standby` that a run's energy is partly a sleeping PC's).

### The Snapdragon X2 Elite, 2026-10-23

Kit 2.99.0, the quick profile, three runs of each device a round at a time, medians (00:07–01:50, 1 h 43 min). The same model on each, Qwen3-VL-2B (unsloth's Q4_0 GGUF, the files GenieX holds), and the same embedding model, Qwen3-Embedding-0.6B (Q8_0). On the NPU, GenieX 0.9.3 running the kit's build of its plugin (a copy, `kit-copy`), with the NPU's own embedding server (llama.cpp b11645 on the Hexagon). On the Adreno and the processor, llama.cpp b11734's OpenCL and Arm64 builds. Plugged in, Windows' power mode Best performance (this PC's own), the screen on at 75% and held on by each run (no run went into standby), the manor and its servers paused, and the processor 4–6% busy at each start. The energy is the whole PC's (the counters' `system`).

| | NPU | Graphics (Adreno) | Processor |
|---|---|---|---|
| first answer after a start | 2.1 s | 4.2 s | 1.6 s |
| short answer | 59 ms | 28 ms | 19 ms |
| writing | 70.5 tokens/s | 71.7 tokens/s | 91.3 tokens/s |
| reading 1,024 tokens | 324 ms | 749 ms | 1,141 ms |
| job time | 3.53 s | 4.51 s | 4.13 s |
| quality (of 24), pictures (of 4) | 22, 4 | 22, 4 | 22, 4 |
| embedding texts | 5,357 tokens/s | 3,274 tokens/s | 2,113 tokens/s |
| keeping the model loaded | 1,130 mW (27.1 Wh/day) | too small to tell | too small to tell |
| keeping the embedder loaded | 1,348 mW (32.4 Wh/day) | too small to tell | 90 mW (2.2 Wh/day) |
| triage: each over rest | 9.6 J | 47.7 J | 118.2 J |
| reply: each over rest | 13.5 J | 38.4 J | 62.9 J |
| summary: each over rest | 34.0 J | 105.1 J | 198.1 J |
| reading 1,024 tokens: each over rest | 7.3 J | 45.0 J | 111.9 J |
| a picture: each over rest | 4.0 J | 11.7 J | 54.0 J |
| embedding: a token over rest | 3.8 mJ | 12.4 mJ | 48.0 mJ |
| triage ×5: the whole PC | 81.8 J in 3.1 s | 285.8 J in 4.6 s | 648.5 J in 6.2 s |
| reply ×5: the whole PC | 107.7 J in 3.7 s | 236.0 J in 4.3 s | 346.0 J in 3.4 s |
| summary ×5: the whole PC | 299.4 J in 12.2 s | 650.5 J in 12.8 s | 1,088.9 J in 10.7 s |
| embedding ×5: the whole PC | 222.8 J in 7.0 s | 551.8 J in 11.3 s | 1,893.0 J in 16.3 s |

- **The NPU does the agents' work for a third to a fifteenth of the energy.** Each job over rest costs the NPU 9.6–34 J, the Adreno 38–105 J and the processor 63–198 J. Embedding costs 3.8 mJ a token on the NPU, 12.4 on the Adreno and 48 on the processor. The whole PC spends the least on the NPU for every batch. That holds even where the processor finishes first (five replies in 3.4 s against 3.7 s, for 346 J against 108 J).
- **Speed is close.** The processor writes fastest (91 tokens a second against 70–72) and answers short questions fastest. The NPU reads fastest, a 1,024-token read in a third of a second, and has the best job time. All three answer the same 22 of 24 questions and all four pictures right.
- **A model held on the NPU costs about a watt doing nothing.** GenieX loaded costs the whole PC 1.1 W, and the NPU's embedding server 1.3 W (27–32 Wh a day). The NPU itself draws 0.13–0.15 W of it. The rest is the chip around it: `infra` 0.48 → 1.2 W, `soc` 1.3 → 2.0 W. llama.cpp loaded on the Adreno or the processor costs nothing the meter can tell. So the keeper's stopping the NPU's servers when nobody uses them saves about a watt for each.
- **Awake, quiet, the X2 rests at 9.1–10.1 W** with the screen at 75%. A first series ran with the screen off, in Modern Standby, where it rests at 5.4 W. Its costs over rest came out within 15% of these (NPU triage 11.0 J, Adreno 50.0 J, processor 115.8 J), but its rests, and so what keeping a model loaded costs, didn't. Hence the hold awake (Energy, above).
- Two runs' rests with no model caught a burst of other work: the NPU's first (35 W, the processor at 18 W) and the processor's third (11.7 W). Each made that run's "keeping it loaded" negative. The medians leave them out, which is what three runs are for.

### On Intel and AMD

On a laptop with Windows' Energy Meter counters (`node src\kit\power-meter.ts` says), from a worktree of the Steward at kit 2.99.0 or later (Running it on a PC, step 1), plugged in, the lid open, the PC quiet (step 3) and its agents paused (step 4). The run keeps the PC awake with its screen on by itself, so the figures are an awake PC's, as the X2's are:

```powershell
node src\kit\power-meter.ts
node src\kit\npu-bench.ts --device NPU,GPU,CPU --runs 3 --energy --profile quick --yes 2>&1 | Tee-Object -FilePath npu-bench-devices.log
```

On Intel the counters are RAPL's, the chip's own (`pkg`: its cores, graphics and NPU; On Intel, above), with no `system`: the energy rows are then the chip's, not the whole PC's, and the screen isn't in them. Without the counters, a Shelly plug (`--meter shelly:<address>`) gives the whole PC's rows; the battery gives speed only. Send back the summary (`npu-bench-summary-<maker>-<date>.json`), the nine reports, and the log, privately. On AMD the graphics and processor runs download Qwen3.5-2B's GGUF (1.9 GB) into the tools home's `models\unsloth\Qwen3.5-2B-GGUF`, which nothing else uses: remove it after. llama.cpp's builds (`servers\llama.cpp\llama.cpp-b11734-*`) are setup's own, and can stay.

## The website

- **The chips board**: one row per chip generation, ranked by job time, and a row for a chip's graphics card where it runs the same model on the same server (the Lunar Lake's Arc 140V beside its NPU), named as the graphics card, so the board shows what each part of the chip is for: the NPU for less power, the graphics card for speed. Columns: job time, writing and reading speed, short answer, first and cached load, memory, quality, energy where measured, vision, holding speed, then the model, server, driver and date. A chip measured on more than one laptop shows the median, with each laptop on its own page.
- **The models board** for each chip, with the same columns, including candidates.
- **A run's page**: everything in its report, and the suite's prompts, so anyone can see what was asked.
- **History**: the newest run counts, older ones are kept, so a driver or server update that made a chip faster shows as a line over time.
- **How it's measured**: this page, in the website's words.

**Who submits.** At first, only us: runs from our own laptops, made with `--profile full`, put in the website's data by hand. Anyone else's submissions come later, once there are people who want to send them. They would be uploaded from Manor with consent, held for a look before they're shown, and marked apart from ours, because a report is a file anyone could edit.

## The first run

A quick run on the Lunar Lake (Core Ultra 7 256V, HP OmniBook X 17, plugged in, Best performance) with Intel's shipped model, 2026-10-12. It was not ranked: a quick run, and the processor 21% busy before the start. It was suite 1, which asked each read and job the same prompt again, so its reads and jobs (and the cap's, below) were likely partly read from the prefix cache: rerun them with suite 2.

| | NPU |
|---|---|
| First load, with its compile | 29.9 s |
| Cached load | 4.5 s |
| Short answer | 0.72 s |
| Writing | 25.1 tokens a second |
| Reading 512 / 1,024 tokens | 0.76 / 0.77 s to the first token |
| Reading near the cap (1,303 of 1,536) | 1.79 s |
| Triage / reply / summary | 1.28 / 5.38 / 5.10 s, each 3 of 3 right |
| **Job time** | **11.76 s** |
| Quality | 23 of 24 (it showed its working for "apples") |
| Memory | 3.9 GB working set |

The same model on the Arc 140V, measured with the experiment harness rather than the benchmark: 38.8 tokens a second, 0.08 s for the short answer, 0.28–0.31 s to start reading, 7.8 s to load.

**Intel's prompt cap.** The NPU reads in pieces of about 1,024 tokens, so a bigger cap doesn't slow short prompts much. At 2,048 nothing changed (short answer 0.72 s, load 28 s, 3.6 GB). So Intel's cap is now 4,096 (kit 2.67.0), three times the text an agent may send. Its quick run, 2026-10-13: first load 41.2 s, cached 4.5 s, short answer 0.80 s, writing 27.9 tokens a second, reading 512 / 1,024 tokens 0.83 / 0.83 s, near the cap (3,492 of 4,096) 4.54 s, the jobs 1.30 / 4.97 / 4.72 s, **job time 10.99 s**, quality 23 of 24, 4.3 GB.

## What's built

1. **Shared parts out of the NPU check**: starting and stopping a server, asking, waiting for it to answer, and reading its memory move into `npu-server.ts`. The NPU check uses them as it does now and behaves the same.
2. **Streamed requests**: `askStream` sends `stream: true` with `stream_options.include_usage`, reads the server's events, and returns the time to the first token, each token's time and the usage. No route declares whether its server streams: the benchmark asks every request streamed and sees what comes back. An answer that comes all at once, not as server-sent events, is read that way, and a run where any did is marked `not-streamed` (the report's `run.streamed` false); one whose stream carried no token counts is marked `no-usage` (`run.usageReported` false). OpenVINO Model Server streams with usage in its last chunk. This was checked on the Lunar Lake's NPU: one chunk a token, and the writing rate between tokens was 24.1–24.2 a second over 256 tokens, steady from one try to the next. Whether GenieX streams, and puts its usage in the last chunk, still has to be checked on the X2 Elite (its first run's `run.streamed` and `run.usageReported` say). FastFlowLM's too, once there's AMD hardware.
3. **The suite** as data (`npu-bench-suite.json`): settings, warm-ups and tries, the speed prompts, the three jobs, the quality items with their grades, the vision items and pictures, the gate.
4. **Grading**: an exact match, a regular expression, a number, JSON fields.
5. **Conditions**: plugged in or not, battery charge and discharge rate, Windows' power mode, how busy the processor is, the Windows build, the laptop's make and model (`Win32_ComputerSystem`).
6. **`npu-bench.ts`**, the command:

   ```
   node <agent>\src\kit\npu-bench.ts [--profile quick|full] [--device NPU|GPU|CPU[,...]] [--runs <n>] [--model <id>] [--candidate <id> [--vision]] [--cap <tokens>] [--generation <id>] [--small-pc] [--energy] [--meter auto|emi|shelly:<address>|nvidia|battery] [--yes] [--no-setup] [--out <file>]
   node <agent>\src\kit\npu-bench.ts --mix [days]
   node <agent>\src\kit\npu-bench.ts --summary <report.json>...
   node <agent>\src\kit\power-meter.ts [--meter auto|emi|shelly:<address>|nvidia|battery] [--seconds <n>]
   ```

   It sets the route up as the NPU check does, with the NPU's generation's own values (its cap, timeouts and server arguments, as setup runs it), without writing config.json, measures, grades, and writes the report beside the servers. The report's cap, and the read near it, are the generation's: 2,048 on Meteor Lake's NPU 3720, not the route's 4,096. `--candidate` measures a model that isn't in `npu-vendors.json` (the Qwen3-1.7B we might export for Intel, say) without a release, pulled as the route pulls its own: the report marks it as a candidate. Its files aren't pinned, so once setup has pulled it the benchmark measures them: every file in its model's folder, the one its `present` file is in (GenieX's `%USERPROFILE%\.cache\geniex\models\<org>\<name>`, OpenVINO's `{tools}\models\openvino\<org>\<name>`), each by its name there, with its size and SHA-256, in `run.files` as `npu-vendors.json` pins a model's. FastFlowLM's route doesn't say where its models are, so there `run.files` stays null, and the log says so. A candidate only chats, whatever the route's model does: on GenieX's route, whose one model chats and sees, a text model is pulled as one (`--model-type llm`) and asked no pictures. `--vision` says the candidate sees too: it is pulled as a vision model (`vlm`) and asked the pictures, on a route that has vision. `--cap` serves the model with another prompt cap, in its own compile cache. Off the NPU nothing is compiled for a cap, so there `--cap` only sets where the long read goes. Without it, a graphics card's long read is at the NPU's cap on that PC, so the two runs compare. `--generation snapdragon-x` on a Snapdragon X2 plays the first X (On a Snapdragon, above): never ranked. `--no-setup` measures what's already set up, and stops, exit 1, if the server, its runtime or its model would have to be fetched. It exits 0 when it ran to the end (ranked or not), 1 when it couldn't, and 2 for a request it doesn't understand.
7. **The report's schema** (`npu-bench.schema.json`), and the report checked against it before it's written.
8. **Tests**, with fake servers as the NPU check's tests have: streaming and its timing, grading, the gate, the conditions that keep a run off the board, the job time, a server that can't stream, the report against its schema, every read and job a prompt not sent before, and a Snapdragon's run with GenieX's quirks (a nonce in every request, each picture a file).
9. **The token tally** (`token-tally.ts`): every chat and vision request an agent's kit answers is counted, by day, agent, work, lane and accelerator kind: how many, the prompt and answer tokens (the server's counts, or the kit's estimate where it gives none), the time, and how they spread over size buckets. Counts only, never what was asked or answered, kept on the PC in the accelerators folder (`usage\<day>\<agent>.json`) for 60 days, and sent nowhere. `npu-bench.ts --mix` prints them.

10. **`power-meter.ts`** (kit 2.98.0): the four meters (Energy, above), a stretch's energy from them (`measureSpan`: a meter with totals read at its two ends, one without every so often), and, as a command, which meter this PC has and what each part draws over a few seconds (`--seconds`, 10 by default).
11. **Devices, embeddings and series** (kit 2.99.0): a route's model off the NPU on llama.cpp (`planOffNpu`, `setUpOffNpu`, from the route's `offNpu`), the kit's build of GenieX's plugin from a copy of GenieX (`kitPlugin`), the embeddings (`embedTexts`), ports beside a held one, the wait for a quiet processor, each rest read once the PC has settled (`settle`), the PC held awake through an energy run and a run that went into standby all the same marked (`holdAwake`, `standbyCount`), and several runs with their summary (`npuBenchSeries`, `benchSummary`, `summarySay`). Tested with fake servers, downloads and meters: nothing real starts.

Later, not in the first version: a **Measure this PC** button in Manor's Accelerators page; the website's import and pages (in the website's repository); uploads from other people.

## Open questions

- **The jobs' mix.** The three jobs' sizes are a guess at the agents' work. The token tally counts what agents send from kit 2.66.0 on; a week of it on the owner's PCs (`--mix 7`) sets the sizes before the suite's first release. They are the ranking, so this matters most.
- **Energy.** To be published (decided). The battery's rate doesn't hold up on the Lunar Lake, so kit 2.98.0 reads Windows' Energy Meter counters where a PC has them, a Shelly plug, or a card's own reading. Kit 2.99.0 measures every route on its NPU, graphics and processor, and the embeddings (Comparing devices, above). Still to do: the same on an Intel and an AMD laptop with the counters, and the full profile's figures for the website.
- **The gate's calibration** needs the three known-good routes measured first. AMD's route can't join the calibration until there's AMD hardware.
