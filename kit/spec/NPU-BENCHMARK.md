# The NPU benchmark

A standard measurement of how well each chip runs Castellan's local AI, and each model on it, so the website can rank them. The command is built (kit 2.62.0, `npu-bench.ts`) and has run on a real Lunar Lake; the website's boards aren't yet. It builds on the NPU check (`npu-check.ts`, NPU-VENDORS.md's "Verified, and not"), which sets a route up, starts its server and measures it.

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

Every model Castellan runs today is a Qwen3 4B model at 4-bit weights, all with the same tokenizer, so token counts mean the same thing on every row:

| Maker | Server | Model | Weights |
|---|---|---|---|
| Qualcomm | GenieX 0.8.0 | Qwen3-VL-4B-Instruct (W4A16) | 4-bit, 16-bit activations; also does vision |
| Intel | OpenVINO Model Server 2026.4.1 | Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov | 4-bit symmetric, channel-wise |
| AMD | FastFlowLM 1.0.7 | qwen3-it:4b (Qwen3-4B-Instruct-2507) | 4-bit |

They are not the same weights: each maker's NPU needs its own format, and Qualcomm's is the vision model. So the chips board doesn't claim identical models. It compares what each chip delivers with its shipped model, names the model on every row, and shows a quality score beside the speed, so a faster chip whose model answers worse can't hide it.

## The suite

The suite is data, `npu-bench-suite.json` beside this file, with a version (`castellan-npu-bench/1`). The website compares only runs of the same major version. A change to a prompt, a grade or a setting is a new version.

### Settings for every request

- `temperature: 0` and a fixed `max_tokens` per request, as the kit's own `chatBody` sends, and the model's thinking turned off where it has any.
- **Streamed** (`stream: true`, with usage in the last chunk), so the time to the first token (reading the prompt) and the time between tokens (writing) are measured separately. The NPU check doesn't stream, so it estimates writing speed by taking off half a short answer's time. That is close enough for a timeout, but not for a ranking. A server that can't stream is measured without it and the run is marked: its job times still count, its reading and writing speeds are shown as estimates and not ranked.
- Token counts come from the server's own usage numbers. A server that doesn't report them is marked the same way.
- Every prompt fits under 1,280 tokens, prompt and answer together, so it runs under every route's cap (the smallest is Intel's 1,536). A route whose cap is lower can't run the suite, and the website says so rather than leaving it out silently.

### What it measures

1. **Loading.** The first start with an empty compile cache (OpenVINO compiles the model for the NPU; 31 s on a Lunar Lake), then a start again from the cache. Each start is timed to the first correct answer.
2. **A short answer, warm.** "Reply with the single word: ready". This is the shortest wait a person sees. Shown as the median of five.
3. **Writing speed.** A prompt that makes the model write at least 256 tokens (the numbers one to one hundred in words). Tokens a second between the first token and the last, median of five.
4. **Reading.** Prompts of 512 and 1,024 tokens, timed to the first token, median of five each. Also measured once at 90% of the route's own cap and shown, but not ranked, because caps differ. The board shows this as **seconds to start answering**, not as tokens a second, because an NPU may not read in proportion to length. Intel's NPU reads a prompt in pieces of about 1,024 tokens, and each piece costs about the same however full it is. Streamed on the Lunar Lake, the first token came after 0.75–0.77 s for prompts of 15, 505 and 980 tokens, after 1.79 s for 1,227 and 1,645 tokens (two pieces), and after 4.37 s for 3,312 (four). A tokens-a-second figure would call it 20 for a short prompt and 1,280 for a long one, and neither is the truth. The NPU check's "650 a second" has the same flaw. The time to the first token, at fixed sizes, means the same on every chip.
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
9. **Energy** (optional, on battery only). Windows reports the battery's discharge rate (`root\wmi` `BatteryStatus.DischargeRate`, in milliwatts). The run reads it for a minute at rest, then through three minutes of triage jobs. The extra drain divided by the tokens done gives **millijoules a token**. This is where Intel's NPU should show what it's for: slower than its graphics card, but with far less power. It is a whole-laptop measurement (screen, fans, everything), so the run records the screen's brightness (it doesn't change it) and the figure is shown as an approximation. The discharge rate can be read without an administrator: this was checked on the Lunar Lake laptop, an HP OmniBook X 17, where plugged in it reads 0, as it should. How steady it is under load still has to be measured on battery.
10. **Vision** (where the model has it). Four questions about fixed pictures, graded. Shown as its own column; it is not part of job time, because Intel's route has no vision yet.

### Quality items

24 items with answers a program can grade, six of each kind:

- **Following an instruction**: one word, a number only, a given format. Graded by an exact match or a regular expression.
- **Finding something in a long text**: a fact placed at the start, middle or end of a prompt of about 1,000 tokens. Graded by an exact match. These also catch a server that quietly reads only part of a long prompt.
- **JSON**: an answer that must parse and have given fields with given values. Graded by parsing.
- **Short reasoning**: arithmetic, dates, which of two. Graded by number: the first number in the answer. An answer that shows its working when asked for the number alone ("3 + 2 × 4 = 11") counts as wrong, because an agent reads the answer as a number, and so does one that hedges ("32, or 42").

Three of them are **must-pass**: the "ready" answer, a find at the end of the long text, and one JSON answer. A model that fails any of them runs badly on that device (the group-wise Qwen3-4B on Intel's NPU answered nonsense fast; kit 2.61.0), and the run isn't ranked however fast it was.

The **gate** for ranking is all three must-pass items, and a score no lower than the gate in the suite. The gate is calibrated before the suite's first release, by running it on every route known to work (the Snapdragon X2 Elite's NPU, the Lunar Lake's NPU and its Arc graphics card) and setting the gate 10 points below the lowest of them. Until it is calibrated it is a placeholder (75%).

### Conditions, and runs that don't count

Laptops vary with power and heat, so every run records how it was measured, and a run is ranked only when these conditions hold:

- **Plugged in** (except the energy part, which needs the battery), with Windows' power mode recorded. The power mode Windows ships with is the one ranked. Whether "Best performance" changes much on an NPU is worth measuring once.
- **Nothing else working**: the processor under 15% busy for 30 seconds before the start, and no other model server answering (as the NPU check refuses to measure beside the keeper's server).
- **Steady**: for each measurement, the spread of its five tries ((slowest − fastest) / median) is under 15%. A noisy measurement is shown as noisy and the run isn't ranked.
- **Passed the gate**, with every job answered.

Before the five measured tries of each kind, there is one warm-up try, which isn't counted.

### How long a run takes

Past setup: about 8 minutes for the quick run (loading, short answer, speeds, the jobs and quality, each three times instead of five, so it's shown but not ranked), and about 25 for the full run (five tries each, holding speed, and energy if asked for). The first start's compile adds about half a minute on Intel.

## The report

One JSON file per run, `castellan-npu-bench/1`, with its schema beside this file (`npu-bench.schema.json`):

- **suite**: version, kit version, profile (quick or full).
- **pc**: the processor and its chip generation (as detection labels it, e.g. "Intel Core Ultra 7 256V, Lunar Lake"), the NPU's name, PCI device and driver version and date, RAM, Windows build, and the laptop's make and model (cooling and power limits differ between laptops with the same chip).
- **conditions**: plugged in or battery, power mode, battery charge, how busy the processor was before the start.
- **run**: device, server and version, model id, size and each file's SHA-256 (as `npu-vendors.json` pins them; a candidate's are measured), and whether it is shipped or a candidate.
- **results**: each measurement's five tries, their median and spread, and the job time.
- **quality**: each item's answer, its grade, the score, and whether the gate passed.
- **marks**: anything that keeps it off the board (not streamed, estimated tokens, noisy, battery, gate failed), each with its reason in plain words.

Nothing in it names the person or the PC: no user name, PC name, serial number or paths. The laptop's make and model is the most it says about whose PC it was.

## The website

- **The chips board**: one row per chip generation, ranked by job time, and a row for a chip's graphics card where it runs the same model on the same server (the Lunar Lake's Arc 140V beside its NPU), named as the graphics card, so the board shows what each part of the chip is for: the NPU for less power, the graphics card for speed. Columns: job time, writing and reading speed, short answer, first and cached load, memory, quality, energy where measured, vision, holding speed, then the model, server, driver and date. A chip measured on more than one laptop shows the median, with each laptop on its own page.
- **The models board** for each chip, with the same columns, including candidates.
- **A run's page**: everything in its report, and the suite's prompts, so anyone can see what was asked.
- **History**: the newest run counts, older ones are kept, so a driver or server update that made a chip faster shows as a line over time.
- **How it's measured**: this page, in the website's words.

**Who submits.** At first, only us: runs from our own laptops, made with `--profile full`, put in the website's data by hand. Anyone else's submissions come later, once there are people who want to send them. They would be uploaded from Manor with consent, held for a look before they're shown, and marked apart from ours, because a report is a file anyone could edit.

## The first run

A quick run on the Lunar Lake (Core Ultra 7 256V, HP OmniBook X 17, plugged in, Best performance) with Intel's shipped model, 2026-10-12. It was not ranked: a quick run, and the processor 21% busy before the start.

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

## What's built

1. **Shared parts out of the NPU check**: starting and stopping a server, asking, waiting for it to answer, and reading its memory move into `npu-server.ts`. The NPU check uses them as it does now and behaves the same.
2. **Streamed requests**: `askStream` sends `stream: true` with `stream_options.include_usage`, reads the server's events, and returns the time to the first token, each token's time and the usage. A route says whether its server streams (`streams` in `npu-vendors.json`). OpenVINO Model Server streams with usage in its last chunk. This was checked on the Lunar Lake's NPU: one chunk a token, and the writing rate between tokens was 24.1–24.2 a second over 256 tokens, steady from one try to the next. Whether GenieX and FastFlowLM do the same has to be checked.
3. **The suite** as data (`npu-bench-suite.json`): settings, warm-ups and tries, the speed prompts, the three jobs, the quality items with their grades, the vision items and pictures, the gate.
4. **Grading**: an exact match, a regular expression, a number, JSON fields.
5. **Conditions**: plugged in or not, battery charge and discharge rate, Windows' power mode, how busy the processor is, the Windows build, the laptop's make and model (`Win32_ComputerSystem`).
6. **`npu-bench.ts`**, the command:

   ```
   node <agent>\src\kit\npu-bench.ts [--profile quick|full] [--device NPU|GPU|CPU] [--model <id>] [--candidate <id>] [--cap <tokens>] [--energy] [--yes] [--no-setup] [--out <file>]
   node <agent>\src\kit\npu-bench.ts --mix [days]
   ```

   It sets the route up as the NPU check does, without writing config.json, measures, grades, and writes the report beside the servers. `--candidate` measures a model that isn't in `npu-vendors.json` (the Qwen3-1.7B we might export for Intel, say) without a release, pulled as the route pulls its own: the report marks it as a candidate, with the SHA-256 of its files as measured. `--cap` serves the model with another prompt cap, in its own compile cache. `--no-setup` measures what's already set up. It exits 0 when it ran to the end (ranked or not), 1 when it couldn't, and 2 for a request it doesn't understand.
7. **The report's schema** (`npu-bench.schema.json`), and the report checked against it before it's written.
8. **Tests**, with fake servers as the NPU check's tests have: streaming and its timing, grading, the gate, the conditions that keep a run off the board, the job time, a server that can't stream, the report against its schema.
9. **The token tally** (`token-tally.ts`): every chat and vision request an agent's kit answers is counted, by day, agent, work, lane and accelerator kind: how many, the prompt and answer tokens (the server's counts, or the kit's estimate where it gives none), the time, and how they spread over size buckets. Counts only, never what was asked or answered, kept on the PC in the accelerators folder (`usage\<day>\<agent>.json`) for 60 days, and sent nowhere. `npu-bench.ts --mix` prints them.

Later, not in the first version: a **Measure this PC** button in Manor's Accelerators page; the website's import and pages (in the website's repository); uploads from other people.

## Open questions

- **The jobs' mix.** The three jobs' sizes are a guess at the agents' work. The token tally counts what agents send from kit 2.62.0 on; a week of it on the owner's PCs (`--mix 7`) sets the sizes before the suite's first release. They are the ranking, so this matters most.
- **Energy.** To be published (decided), but how steady the battery reading is under load still has to be seen on battery, on the Lunar Lake and the Snapdragon. A reading that swings too much is shown as noisy and kept off the board.
- **Intel's prompt cap.** Measured on the Lunar Lake: because the NPU reads in pieces of about 1,024 tokens, a bigger cap doesn't slow short prompts much. At 2,048 nothing changed (short answer 0.72 s, load 28 s, 3.6 GB). At 4,096 the short answer took 0.77 s instead of 0.72, the first load 41 s instead of 31, and the memory 4.3 GB instead of 3.6. Raising Intel's cap to 4,096 would let agents send three times the text, for about 50 ms on every answer. That is a change to npu-vendors.json to propose, with the timeouts that a 3,300-token prompt (4.4 s to start) needs.
- **The gate's calibration** needs the three known-good routes measured first. AMD's route can't join the calibration until there's AMD hardware.
