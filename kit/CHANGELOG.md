# The kit's changelog

Each version of the Steward's kit, newest first. A version is released as `kit-v<version>` (tools/kit-release.ts), and each agent takes it by pinning it in its `kit.json`. An entry says what an agent's maintainer needs to know: what changed, and anything the agent must do.

## 2.74.5

**The NPU: a PC set up by an older kit gets this kit's command, Intel's NPU 3720 writes about 13% faster and holds less, AMD's runs on a 16 GB Ryzen AI (XDNA 2 verified), a known maker's NPU of a generation setup doesn't know is tried instead of refused, and the benchmark times prompts the server hasn't seen.**

### What's new

- **`npu-refresh.ts`**: `refreshNpu(deps)`, one look at whether the NPU's entry in config.json is what setup would write now on this PC: its commands, their environments, its caps and quirks. It runs once for each kit version, and never takes back a newer kit's. When the entry differs, nothing has to be downloaded, and the NPU is idle, it runs in the NPU's turn: it stops the NPU's servers, asks the new command the test question (and a test embedding), and writes the entry only when it answers properly and the entry didn't change meanwhile. It keeps the slots, timeouts and switch, and every other key. A failed test keeps the old command, and this kit doesn't try again. `argChanges(from, to)` gives the arguments that changed, for the log.
- keeper.ts: **`startNpuRefresh()`**, the refresh in the background of the keeper's look (`keeperLook`, as the Smith and Reeve run it), once at a time, and only when nobody has held, waited for or used the NPU for 2 minutes (`NPU_REFRESH_QUIET_MS`). What it changed, or why it didn't, goes in reaper.log.
- setup.ts: **`npu-refresh.json`** beside config.json (`readNpuRefresh`, `rememberNpuRefresh`, `npuRefreshFile`): the kit that last wrote or looked at the NPU's command, and what it found. Setup writes `set-up` when it writes the NPU's entry. `kitVersion()` is this kit's VERSION.
- setup.ts: `testNpuEntry` and `testNpuEmbed` take `held: true` when the caller already holds the NPU's turn and has stopped its servers.
- keeper.ts: `reaperTurn` takes the turn's `staleMs`.

### What changed

- **A command that changed between kits now reaches PCs already set up.** Before, it reached only PCs set up after it: setup leaves a configured NPU alone. An Intel NPU 3720 set up with the shipped command answered a short question in 3.1 s; with the chunked command, in 0.5 s. So the NPU 3720's prompt chunks (kit 2.73.3), and its settings below, reach the PCs set up before them, without setting them up again. Spec: ACCELERATORS.md (the keeper), NPU-VENDORS.md (A later kit's command).
- **npu-vendors.json, Intel's `meteor-lake` and `arrow-lake`** (the NPU 3720): `--plugin_config` is `{"NPUW_LLM_PREFILL_CHUNK_SIZE":"128","GENERATE_HINT":"BEST_PERF","NPUW_LLM_PREFIX_CACHING_MAX_NUM_BLOCKS":"32"}` (was the 128-token chunks alone). From 20 quick benchmarks on a Core Ultra 5 225U (2026-10-14):
  - `BEST_PERF` writes 10.7–11.6 tokens a second against 9.6–10.5. The benchmark's jobs take 22.6–24.3 s against 26.0–27.8, five runs each and never overlapping, with the same reads and answers. Its first compile takes 57–62 s against 27–39, once per PC and driver.
  - OpenVINO Model Server turns the NPU's prefix caching on by itself. Its 128 blocks left the server holding 5.2 GB after a dozen varied long prompts. 32 blocks (4,096 tokens) held 3.8 GB with the same times.
- **`meteor-lake`'s cold load is 120 s** (was 60): the slowest first compile with `BEST_PERF`, 62 s, with half again. Its chat memory is 4.3 GB (was 3.9), the working set at the end of the benchmark. `arrow-lake` takes the same memory; its 360 s cold load stays.
- Unchanged, as measured: 128-token chunks (64 read 1,740 tokens in 8.1 s against 6.3; 256 answered short in 0.78 s against 0.5) and the 2,048-token cap (3,072 held 0.4 GB more and read 5–10% slower; 4,096 held 1.0 GB more). `PREFILL_HINT` `STATIC`, static prefill attention and `NPU_TURBO` were no faster.
- **npu-vendors.ts**: an NPU from Qualcomm, Intel or AMD whose PCI id (or Snapdragon name) isn't in `npu-vendors.json` is now generation `unknown` (`UNKNOWN_GENERATION`), not null. `unknownGeneration(route)` works its values out from the route's supported generations: the smallest cap (with that generation's `args`, so OpenVINO's `--max_prompt_len` matches), the longest timeouts and cold load (never under the route's own, its values for a generation nobody measured), the most memory, the latest driver minimum; `verified: false`. `generationOf(route, id)` gives it, and `routeFor` takes it. `npuSupport` marks it `guessed: true` and labels it "AMD NPU of a generation setup doesn't know yet, device 17F1". On Intel that is 2,048 tokens, the NPU 3720's plugin settings (its prompt chunks, `BEST_PERF` and 32 cached blocks), 60 s + 0.4 s a token, a 360 s cold load and driver 32.0.100.5540; on AMD, XDNA 2's cap with the route's 20 s + 0.4 s a token and 120 s cold load, not XDNA 2's measured 0.15 s a token and 30 s. Qualcomm's 2,400-token cap is never raised. AMD's first XDNA (`1502`) and unknown makers are still refused. `MAKERS` is exported.
- **setup.ts**: such an NPU goes through setup's test request and calibration like any unverified generation, and is kept only if it passes. Its note says it runs on guessed values (`npuGuessedNote`), kept in `npu-note.json` and shown by the report; the plan and the report say it is "tried on guessed values, the most cautious it has, and kept only if it passes its test".
- **npu-check.ts**: on such an NPU, the detect step says it runs on guessed values and prints its PCI id ready for `devices` (`unknownDevice`, `unknownDeviceSay`; the report's `unknownDevice`). Every step passing gives a patch adding it as a new verified generation, `<maker>-<pci id>`, with its `devices` entry (`checkPatch`'s `device`). `--generation unknown` rehearses the guessed values.
- **npu-vendors.json's amd route** starts FastFlowLM with `--ctx-len 4096`, the cap. FastFlowLM holds its whole context from its start, and its default is the model's own, 40,960 tokens for Qwen3-4B (about 5.6 GB beside 3.3 GB of weights). On a Ryzen AI 7 350 with 16 GB, where Windows lets a device hold half the PC's memory at once, that never loaded (XRT 0xc01e0200), so setup's test request failed and the NPU was left out. At 4,096 it starts in 4 to 6 s and holds 4.5 GB (5.3 GB with its vision model), as fast as at 8,192 (about 14 tokens a second).
- **XDNA 2 is verified**: the NPU check passed every step on that Krackan (NPU driver 32.0.20102.3930), with `--harden` and `--idle`. Its own timeouts are the check's (20 s + 0.15 s a token, a cold load 30 s), and its models' memory is measured (`memoryGb`: chat 4.5, vision 5.3).
- **FastFlowLM's idle stop** comes from its measured cold start, 6.6 s (vision 15.7 s, its switch from chat included), not the 30 s taken: on a PC under 20 GB the keeper stops it after 5 minutes unused (6 for vision), not 10.
- **`postJson`** takes a 200 that carries only an error (`failedWithOk`) for the server failing (`AcceleratorDown`): the accelerator is marked and the request goes to the next. FastFlowLM answers so when its model didn't load, and serves on; before, the work took an empty answer from the NPU.
- **The NPU check's start** fails when FastFlowLM answers `/v1/models` but holds no model (its `/api/ps`: `reportsLoaded`), with the reason from its log (`loadFailure`). Before, it passed on `/v1/models`, and failed only at its first answer, with "no answer: null". An answer that is only an error now keeps its words in the report.
- **Setup's test request** asks about the picture first and chat last: a server holding one model at a time is left holding chat, and setup's measuring after it times chat warm. On FastFlowLM it timed the switch back from the vision model (9.2 s against 1.3 s) and wrote timeouts five times too long.
- **The amd route's models name their files** (`present`), so `npu-check --no-setup` finds them. FastFlowLM's folders aren't named by the model's id, so npu-bench's `candidateRoute` drops a `present` whose path doesn't name the model. Kept, an AMD `--candidate` would have counted as downloaded, never been pulled, and had the route's own model's files measured as its own.
- **Every read and job is asked as a new prompt.** npu-bench.ts puts a line of its own first, `[bench <run>-<count>]`, in each warm-up and try of the reads and jobs, the read near the cap, holding speed and energy (`freshPrompt`). OpenVINO Model Server turns the NPU's prefix caching on, so suite 1, which asked one prompt over and over, timed mostly the cache: on an NPU 3720, 0.74 s to the first token at 512 tokens, against 2.26 s for a prompt it hadn't seen. The short answer, writing and quality prompts are as they were. GenieX's requests were already new, by their nonce.
- **The suite is `castellan-npu-bench/2`.** The website compares runs of one major version, so suite 1's runs don't rank against these. The report's format (`castellan-npu-bench-report/1`) is unchanged.
- spec/NPU-VENDORS.md: the NPU 3720 sweep's numbers, and how the prefix cache makes the benchmark's repeated reads faster than a new prompt's; Detection (the guessed values, the note, and why FastFlowLM 1.0.7's `flm validate` isn't AMD's check: it looks for PCI `17F0` alone), the NPU check, and what's unverified; the AMD Krackan's run, and what is still unverified on AMD.

### For an agent

- Nothing to do: the Smith, else Reeve, runs the refresh in its look, and an agent that keeps the servers itself with `keeperLook` gets it the same way. A PC with an NPU 3720 set up by an earlier kit takes the new command once its NPU is idle; its first start with it compiles once, in about a minute. A PC whose NPU was refused as one setup doesn't know is tried at its next Set up.
- A Ryzen AI PC whose setup left the NPU out gets it the next time setup runs (Manor's "Set up local AI"), which writes the NPU's entry afresh with the new command.
- A run made to compare with an earlier one needs both on suite 2.

## 2.74.4
**One process for every PowerShell, not two: powershell.exe shares the page's windowless console, as git and gh do since 2.73.2.**

### What changed

- **ps.ts**: the PowerShell worker and a script on its own (`oneShot`) start powershell.exe with `psStart()`, `windowsHide: !sharesConsole()` (console.ts). In a page started by this kit's `open`, powershell.exe shares the page's windowless console instead of getting a console host (conhost.exe) of its own, and what it starts with no window of its own shares it too. Its output is piped as before. Measured on a page whose 4 scripts (3 in the worker, 1 on its own) each start `cmd /c ver`: 11 processes before, 9 now, none of them a console host. The worker goes after 2 minutes with nothing to run, so an agent that runs a script every round started 2 processes for its worker each round; now 1.
- A shared console's output code page is UTF-8 once a script has set `[Console]::OutputEncoding` (every script on its own does). Console programs started from that page later, and which print in the console's code page when their output is piped, then print UTF-8, as Node reads it.

### For an agent

- Nothing to do: take the kit and release as usual.
- A PowerShell script that starts a console program with `System.Diagnostics.ProcessStartInfo` and `CreateNoWindow = $true` still gives that program a console host of its own. Leave `CreateNoWindow` off (`$false`) and it shares powershell.exe's console, which has no window.

## 2.74.3

**The staff page's Needs you: its heading sits like every other section's, and it takes what belongs under it without being a need.**

### What's new

- **`NeedsYou` takes children**, drawn inside its section under the cards, or under the empty line when nothing needs you. For quiet things that belong under the heading without counting as a need: Reeve's review queues with nothing waiting, its "No review queue yet".

### What changed

- **Needs you's heading is a `Section`'s.** Its h2 was straight in `.ui-section-head`, so page.ts's `h2` top margin (26px) stacked on `.ui-section`'s own (22px): about 48px of space above Needs you at the top of the page. It is now in `.ui-section-name`, as `Section` draws it, with no margin of its own, and it is the plain section heading rather than the larger `ui-heading`: the cards' edges and badges carry the urgency (spec/STAFF-PAGE.md says why).

### For an agent

- Nothing to do: a page drawing `NeedsYou` gets the spacing as it pins this kit. Anything it draws just after Needs you that belongs under its heading can move into its children.

## 2.74.2
**Paced runs go faster: the checks pace's cap is a third of the processor and three runs go at once; and paced test runs get room to finish, a time limit stretched as much as the cap slows them, as many test files at once as the cap has room for.**

### What's new

- checks-pace.ts: **`pacedSlower(cap)`**, how many times its full-speed time limit a paced command may take: the whole processor against the share the cap leaves, 4 at least (9 for two of 18 processors). **`CHECKS_TURN_MS`**, the 20 minutes a run may wait for a turn. `pacedCommand()` gives both on what it returns, as `slower` and `waitMs` (left out when the command runs as it is).
- **`pacedTestConcurrency(cap, processors)`** and **`withTestConcurrency(file, args, n)`**: a paced `node … --test …` (node itself, every argument before `--test` one of node's options, no concurrency of its own) gets `--test-concurrency` of twice the processors the cap leaves, 2 at least. `pacedCommand()` adds it. An npm script's node isn't seen, and `--test-concurrency` can't go in NODE_OPTIONS.

### What changed

- **The checks pace's cap is a third of the processor by default** (`checksCap()`, now with no argument: 3333), whatever the PC's processors. It was a quarter and four processors' worth at most (2.74.1; two, the gentle pace's, up to 2.74.0): 22% on an 18-thread laptop. The agents' own background pace (`gentleCap()`) is unchanged. Manor's `"checksPace"` and `KIT_CHECKS_PACE` still set it, and Settings' pace at full still lifts it.
- **Three paced runs go at once on the PC** (`CHECKS_AT_ONCE`), not two. They share the one cap, so a third run takes no more of the processor; a short check no longer waits behind two long ones. A launcher of an older kit, asking two, takes one of the first two turns, so both kinds keep within three.
- **Why:** on 2026-10-14 six paced runs waited for one of two turns, held to two processors' worth, while the 18-thread laptop's processor was 28% busy with 20 GB of memory free. At a third, `pacedSlower` is 4 and a `node --test` runs 12 files at once there.
- Nothing else changes for a command that isn't `node --test`: its arguments and environment are as they were.
- **Why the time limit and the test files:** on 2026-10-14 the Steward vouched for Reeve's 60 test files at the pace on an 18-thread laptop. Node's runner started 17 files at once, all held to two processors' worth and sharing them with another run, and the runner's fixed four-times time limit (80 minutes) stopped it a third of the way through. Nothing had failed, but the vouch said only "Command failed".

### For an agent

- If your runner stretches a paced command's time limit by a fixed amount, use `slower` and `waitMs` from `pacedCommand()` instead: `timeoutMs * (paced.slower ?? 4) + (paced.waitMs ?? 0)`, as the Steward's run.ts does.
- If you call `checksCap(processors)`, drop the argument: the default no longer depends on the processors.
- Nothing else to do to take it.

### What changed in the NPU benchmark

Made on WEASELDEV02 (#255, #257, #258) and released first in this version.

**The NPU benchmark runs, reports and reads near the generation's own cap, and counts an energy figure only when the battery's reading can tell it. On a Snapdragon its pictures reach GenieX as files and a text candidate is measured as one, a candidate's report carries its files' SHA-256s, and its spec says how to run it on a PC.**

#### What changed

- **npu-bench.ts runs the route as setup does on this NPU's generation** (`routeFor`, as the NPU check already did). Before, it took the route's own values:
  - on a Meteor Lake NPU 3720, the report said cap 4096, while the server ran at the generation's 2048;
  - its read "near the cap" asked for about 3,700 tokens and got no answer.
  - The generation's timeouts and server arguments now apply too.
- **`--cap` is no longer undone by a generation with its own cap.** The bench's route went through `planNpu`, which put the generation's `--max_prompt_len` back. It is now planned as it is. Off the NPU, `--cap` sets where the long read goes instead of being refused. Without it, a graphics card's long read is at the NPU's cap, so the two runs compare.
- **An energy figure counts only when working reads clearly more than rest**: by 1 W and by a tenth of the rest reading (`ENERGY_MIN_EXTRA`).
  - On the Lunar Lake laptop the battery's rate gave 2.3 mJ a token, and on its graphics card a negative figure, both reported as if they counted.
  - Such a run now keeps both readings, with `millijoulesPerToken: null`, and its log says why.
- **npu-server.ts' `setUpRoute`** (the bench's and the NPU check's setup step) no longer passes on setup's "asking … a test question on the NPU" and "measuring … on this NPU" lines, since it asks and measures nothing itself. Setup's "answered on the NPU: chat, embed" becomes "is set up for: chat, embed". A graphics-card run no longer says it asked the NPU.
- **The bench's pictures reach GenieX as files** (its `image-path` quirk).
  - Each suite picture is written to a file of its own in the temporary folder, and its path is sent, as an agent's pictures go to GenieX. Before, they went as `data:` URLs, which the kit passes on as they are whatever the quirk says, and GenieX reads only a local path. The files are removed after the run.
  - Other servers still get `data:` URLs. `picturePng` gives a picture's bytes; `picture` is its `data:` URL, as before.
- **GenieX's `prefix-leak` nonce was already there.** The bench's requests are the kit's own (`chatBody`, `visionBody`), and its entry carries the route's quirks, so every request starts with a nonce. A test now holds it to that, and the run's log names the quirks it applied.
- **One picture as a warm-up, not counted**, before the four graded, as every other measurement has. GenieX holds one model at a time and loads its vision part for a picture, so the first picture's time was that load's. Only routes with vision are affected (GenieX's; Intel's has none).
- **A `--candidate` only chats, unless `--vision` says it sees.** `candidateRoute(route, id, { vision })` took the kinds of the model it stood in for. On GenieX's route, whose one model chats and sees, a text model was therefore:
  - pulled with `--model-type vlm`, where GenieX's pull takes `llm` or `vlm`; it now gets `llm`, or `vlm` with `--vision`;
  - asked the four pictures, and reported 0 of 4; it now has no vision column.
  - Its `present` file kept the route's own model's folder, because GenieX's folder drops the id's `:W4A16` tag. So a candidate counted as downloaded whenever Qwen3-VL was, and was never pulled. The id is now renamed with and without its tag, in one pass.
  - `--vision` on a route with no vision (Intel's) is refused, and so is `--vision` without `--candidate`.
- **A `--candidate`'s files are measured.** The spec said its report carries their SHA-256s, but `run.files` came only from a model's `pinned` files, which a candidate has none of, so it was always null.
  - Once setup has pulled it, `candidateFiles` reads every file in its model's folder (where its `present` file is: GenieX's `%USERPROFILE%\.cache\geniex\models\<org>\<name>`, OpenVINO's `{tools}\models\openvino\<org>\<name>`) and puts each one's `{ size, sha256 }` in `run.files`, by its name in that folder, as `pinned` lists a model's.
  - FastFlowLM's route has no `present`, so nothing says where its models are: there `run.files` stays null and the log says so, as it does when the folder isn't there.
- **spec/NPU-BENCHMARK.md**:
  - says all of the above;
  - drops the `streams` a route was said to declare in `npu-vendors.json`, which none does: the bench sees whether each answer was streamed and marks the run `not-streamed` (or `no-usage`) when not. Whether GenieX streams, with usage in its last chunk, is still to be checked on the X2 Elite;
  - gains **Running it on a PC**, a runbook an agent can follow unaided, with a Snapdragon section: the Steward's own kit, an Arm64 Node, the conditions, pausing the keeper and stopping the NPU's servers, the quick then full run, `--energy` on battery, and what to send back. On a Snapdragon it covers GenieX's quirks, its one model at a time, the 2,400-token cap and the ~8K prompt that bluescreened the X2 Elite, why `--device GPU` and `--cap` are refused there, and the streaming and energy still to be seen.

#### For an agent

- Nothing to do.

## 2.74.1

**The checks pace allows four processors' worth, not two.**

### What changed

- **`checksCap()`** is a quarter of the processor and four processors' worth at most (was the gentle pace's, `gentleCap()`: two at most). Up to eight processors nothing changes; on 18 the cap goes from 11% to 22%. A suite that starts a git for every step was too slow at two: the Steward's own took over an hour on an 18-processor laptop that was otherwise idle. The agents' own background pace (`gentleCap()`) is unchanged. spec/ROUND.md says so.

### For an agent

- Nothing to do: paced commands take the new cap as they start.

## 2.74.0

**A page template for the staff an AI assistant calls: Reeve's page, in parts every MCP agent can share, so their pages read alike.**

### What's new

- **spec/STAFF-PAGE.md**: the layout of an agent that serves MCP (Reeve, the Assayer): what needs you first, then at a glance, Connect your AI, Kept, then the agent's own sections. Plus the rules that keep such a page from becoming a data dump: a row is one line, long output opens beside the page rather than in it, what's fine is one line, counts go in headings.
- **react/staff.tsx**, in the react part's index:
  - `StaffLayout`: that order.
  - `NeedsYou`: what the person must look at or do, a card each, its edge the colour of its badge.
  - `Glance`: a row of tiles, each a number, a line and a colour, going to its section. Reeve's at a glance.
  - `ConnectAI`: how to give an AI tool the agent's tools, as tabs per tool, the one-press connect where the agent has one, and the line for the AI's instructions. Open until an AI is connected, then one line naming it and when it last used the tools.
  - `Kept`: what the agent read so the AI didn't have to, its three totals and what each part read.
  - `Row`: one line of a list (its badge, name, what matters, its buttons), its details opening under it.
  - `SidePanel` and `Output`: long output (a log, a failing test's output, a report) in a panel beside the page.
  - `Paste` (text with Copy), `useFold` (a fold the browser remembers) and `showSection`.
- Their styles are in `UI_CSS` (`ui-glance`, `ui-tile`, `ui-need`, `ui-line`, `ui-list-row`, `ui-connect`, `ui-kept`, `ui-paste`, `ui-output`, `ui-side-panel`), every colour a theme variable.

### For an agent

- Nothing changes until a page uses them. An agent that serves MCP lays its page out as spec/STAFF-PAGE.md says, with these parts in place of its own tiles, connect card and output blocks.

## 2.73.5

**Every folder the kit compares, it compares by its real path: through a junction, a link or a Dev Drive mounted in a folder, one folder is one folder.**

### What's new

- **`real-path.ts`**: `realPath(p)`, a path with its junctions, links and mounted folders followed (`realpathSync.native` of the deepest part that exists, the rest kept as given; a share such as `\\wsl.localhost\...` taken as it is, so WSL and the network are never woken; answers kept a minute), and `pathKey`, `samePath`, `inside` and `keyInside` to compare by it. `forgetRealPaths()` is for a test that makes a junction. spec/DEV-DRIVES.md's rule 1 points to it.
- native.ts: `spellingsOf(dir)`, a folder as given and its real path when that's another.

### What changed

- install.ts: `--purge`'s guard compares the data folder with the profile and Windows' folders by their real paths, and refuses a whole drive mounted in a folder (`C:\DevData`, where `E:` is mounted). Before, a data folder named for the agent that held the profile through a junction passed as the agent's own, and would have been emptied. `install` knows its installed copy however its release and data folder are spelled.
- An update ends the programs running from the app folder under either spelling (`processesUnder`): Windows names a process's program as it was started, through a junction or a mounted folder if it was.
- keeper.ts: a model server's program (`sameProgram`) and the manor's servers folders (`manorOwns`, `manorServerDirs`) are compared by their real paths. A configured server whose process was started under the other spelling wasn't known as itself, and could be stopped as an orphan.
- accelerators.ts, accelerator-config.ts: Reeve's older config.json is the accelerators' own when one's folder is a junction to the other's, so it's neither moved nor mirrored onto itself.
- folders.ts: `uniqueFolders` lists a folder once however it's spelled.
- manor.ts compares a project's checkout through `real-path.ts`, as it has since 2.73.1, now with its answers kept a minute.

### For an agent

- Take the kit and release as usual.
- Compare your own folders with `samePath`, `inside` or `pathKey` from `./kit/real-path.ts`, not `path.resolve(...).toLowerCase()` (spec/DEV-DRIVES.md, rules 1 and 5).

## 2.73.4

**An NPU's own timeouts are used: its requests run on them, and a model found still loading is given its cold load.**

### What changed

- **A request runs on its accelerator's own `timeouts`.** `core.requestTimeoutMs` has always taken an accelerator's `timeouts` in place of rules.json's, but npu.ts never passed them, so every request ran on the rules': 15 s plus 0.3 s a token, and 90 s more for a cold load. Now a route's own in npu-vendors.json (Intel's up to 60 s plus 0.4 s a token and a 360 s cold load on Meteor Lake and Arrow Lake, AMD's 120 s), and what setup measured on a generation nobody had measured and wrote into its entry (`calibrate`), are what its requests get. A Qualcomm NPU has none of its own, so its requests are unchanged.
- **A server found still loading its model gets the cold-load allowance for its warm-up**, as one just started does (2.71.0): `requestBaseMs` plus the larger of rules.json's `coldLoadMs` and the accelerator's own. Before, when another agent had started the server, the warm-up got the caller's `timeoutMs` (a person's 20 s), or 105 s with none. That was too short for an NPU that compiles its model on first load, and the request was deferred while the model went on loading.
- **A warm-up with no `timeoutMs` gets the same allowance**, for example the first request after the server's keepalive has unloaded the model. Before, it got rules.json's 105 s whatever the accelerator's own cold load.
- **npu-bench's energy (`--energy`) is measured on a busy PC too.** Each window now takes at least one reading, and the working window lasts until a job has finished, with a reading taken after it. Before, a process held past a window's end before its first look took no reading, and the report said "the battery gave no discharge rate". This was also why its test failed now and then while other tests ran beside it.

### For an agent

- Nothing to do: requests on an Intel or AMD NPU, or on one setup measured, wait as long as its timeouts allow. A caller's own `timeoutMs` still decides a request, as before.

## 2.73.3
**An install or a settings file written just before the PC crashes comes back whole, not as files full of nothing; and Intel's NPU 3720 is measured and verified, a short answer in 0.5 s, not 3.1.**

### What's new

- **`flush.ts`**: `flushTree(dir)` writes every file under a folder through to the disk (fsync) and says how many it flushed and how many it couldn't; `flushFile(file)` does one. A folder that is renamed into place is flushed first.

### What changed

- **install.ts**: the release copied to `app.new` is flushed before it is swapped in for `app`, and so is `app` after the release is copied into a folder that can't be moved (`replaceContents`, which now flushes what it copied into). Windows writes a rename at once and a file's contents a few seconds later: when a PC crashed right after an update, the agent's app folder came back with every file the right size and nothing in it but NUL bytes, and its page couldn't start until it was installed again. `InstallDeps.flush` stands in for the flush in tests.
- **safeinstall.ts**: `app.prev`, the copy a rollback puts back, is flushed as it's made.
- **store.ts** `writeJson`, accelerator-config.ts `writeJsonWhole` and the accelerators' shared files: the temporary file is flushed before the rename, so a crash leaves the old file or the new one. About 1 ms more a write (0.2 ms to 1.2 ms on the owner's laptop); a write that would change nothing still writes nothing.
- An agent's app folder of 130 files flushes in about 0.03 s.

### What changed for Intel's NPU 3720

Written on the Intel laptop and released first in this version.

- **npu-vendors.json, Intel's `meteor-lake`** (PCI `7D1D`, the NPU 3720 of Meteor Lake and Arrow Lake-U) is **verified**, by the NPU check on a Core Ultra 5 225U (Arrow Lake-U), every step passing: its timeouts are now 15 s + 0.2 s a token and a 60 s cold load (were 60 s + 0.4 s and 360 s), its chat memory 3.9 GB (was 3.6), and its label "Core Ultra Series 1 or 200U, Meteor Lake or Arrow Lake-U (NPU 3720)". A Core Ultra 200U showed Meteor Lake's PCI id, and Intel's driver serves `7D1D` and `AD1D` from one NPU 3720 section.
- **The NPU 3720 reads a prompt 128 tokens at a time**: `meteor-lake` and `arrow-lake` carry `--plugin_config {"NPUW_LLM_PREFILL_CHUNK_SIZE":"128"}`. OpenVINO's default chunk of 1,024 tokens made every prompt cost a whole chunk: a one-line question took 3.1 s, two at once 6.4 s. Now 0.5 s and 1.2 s, the same answers word for word, a shorter compile and 0.2 GB less. The Intel route's command carries `--plugin_config {}` (the same graph as without it) so a generation's `args` can replace it, and `routeOnDevice` drops it off the NPU. The embedding server never gets it: there it hangs at its start.
- `arrow-lake` (`AD1D`, Arrow Lake-S) stays unverified, on its generous starting values, with the NPU 3720's prompt chunks and memory.
- **npu-check.ts measures a real compile**: its measurements serve from a compile cache of its own (`checkServe`: `.check-cache` beside the manor's `.npu-cache`), emptied before the first start, so the first load is a PC's first load or one after a driver update. From the manor's warm cache an NPU 3720 whose compile takes 30–48 s answered first in 9 s, and the check suggested a 30 s cold load. `--idle` and `--harden` keep the manor's cache. Its io takes `clearCache` for tests.
- spec/NPU-VENDORS.md: the NPU 3720's numbers (chat, the prompt chunks, embeddings at each `--max_length`), the Arrow Lake-U run, and what's still unverified.

### What an agent must do

- Nothing: it takes the kit as usual.
- A PC set up from now on gets the prompt chunks and the verified timeouts. One set up before keeps its config.json entry as it is (setup leaves a configured NPU alone): `accelerators setup npu` sets it up again with them, and its first start compiles once more.

## 2.73.2
**One process for every git, not two: a page keeps a windowless console its git and gh can share, and a test's commits start no upkeep.**

### What's new

- **`console.ts`**: `sharesConsole()`, whether this process has a console the console programs it starts can share (asked once), and `hasConsole()`. Start git and gh with `windowsHide: !sharesConsole()`, not detached: in a page started by this kit they then share its windowless console. Started hidden, or from a page with no console, each one gets a console host (conhost.exe) of its own, detached or not. 40 git and gh calls from a page started 82 processes; sharing its console, 43.
- service.ts: **`pageLaunch(node, entry)`**, how `open` starts the page: the program, its arguments and its spawn options.

### What changed

- **`open` starts the page with a console of its own, with no window.** On Windows it goes through `cmd /d /s /c "start "" /b …"`, cmd started hidden: the page keeps cmd's windowless console after cmd has exited, and `start` takes it out of the job Node puts what it starts in, so it outlives the process that ran `open`, as before. Its command line still names `src\cli.ts serve`, its output still goes to serve.log, its folder is still the data folder. Off Windows, and on a path holding `%` or `"`, it starts detached, as before. The page's one console host lasts as long as the page.
- **unsigned-git.ts** also turns off `maintenance.auto`, so a test's throwaway commits no longer each start `git maintenance run --auto`: 20 commits started 62 processes, now 42. `UNSIGNED_KEYS` is now `OFF_KEYS`. test-git.ts and the Steward's checks get it as they are.
- schedule.ts: a round on the clock (2.72.0) now says it's due exactly on its slot. Before, on a busy PC its `nextRunAt` could be a millisecond past the slot, because the wait read the time twice, and the clock's test then failed now and then. When it runs is unchanged.

### For an agent

- Nothing to do to take it: the page gets its console the next time it starts.
- To save the processes, start git and gh in your runner with `windowsHide: !sharesConsole()` (from `./kit/console.ts`) and without `detached`. Keep other commands hidden: a program that opens a window would show it.

## 2.73.1

**Linked folders are fully supported: every script in the kit recognises itself through a junction, a symbolic link or a Dev Drive mounted in a folder.**

### What's new

- **spec/DEV-DRIVES.md**: why one folder has two spellings on a PC with a Dev Drive (`C:\DevData` is `E:\`), which calls give which, what went wrong on 2026-10-13, and the rules every agent follows: paths compared only by their real paths, the run-as-itself check's one form, temporary folders in tests taken by their real path, and what to tell a developer who moves onto a Dev Drive.

### What changed

- `card-check.ts`, and the kit's own `test/core-types.ts`, `test/turn-scenarios.ts` and `test/accelerator-scenarios.ts`, now compare their own path with the one they were started by through `realpathSync`, as `release.ts`, `npu-check.ts` and `npu-bench.ts` have since 2.71.1. Started from a linked folder, they did nothing and exited 0.
- `manor.ts`: a project's checkout is compared with the others, and with the Steward's own, by its real path (`realPlace`, `realpathSync.native` of the deepest part that exists). One clone named through `C:\Projects` and by its Dev Drive's letter was two projects; a checkout inside the Steward's, spelled the other way, was let through.

### For an agent

- Take the kit and release as usual.
- Check your own scripts for `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, or the `pathToFileURL(...).href === import.meta.url` form, and compare real paths instead (spec/DEV-DRIVES.md, rule 2). Started from a linked folder, such a script does nothing and exits 0.
## 2.73.0

**The checks pace holds to the gentle cap, with memory caps and turns, and the pace is the owner's setting alone: viewing a page, Run now or a fast vouch no longer lifts it.**

### What's new

- **`containSelf(own)`** (`node/gentle.ts`): for a long-lived process that doesn't run its work with `every()`, such as an MCP server, a page of its own or a scheduled job. It sets the process at the owner's pace, then reads the setting again every 5 minutes (`CONTAIN_CHECK_MS`). Call it first, before the process starts anything.
- **Model servers start apart from the asker's job** (`node/apart.ts` `startApart()`, `checks-pace.exe apart`). They serve every agent. One started by a capped agent used to run at that agent's cap for as long as it lived; now it doesn't. Measured on this PC:
  - it leaves every job that allows breakaway (the gentle job now does) and stays in the first that doesn't, such as Task Scheduler's or a terminal's;
  - where Windows refuses, it starts as before.
- **The PowerShell worker joins its agent's job** (`gentle.cs` `Join`). It made the job, so it was the one program the agent ran outside it.
- **The checks pace's limits** (2.70.0's `pacedCommand`). The launcher's first word now carries them: `cap[,MB per program,MB for the job,runs at once]` (`checksLimits()`).
  - **A cap on memory** (`checksMemory()`): each program gets an eighth of the PC's memory (2 to 6 GB), the whole job a quarter (4 to 12 GB). A runaway test fails rather than paging the PC.
  - **A turn**: at most `CHECKS_AT_ONCE` (2) paced runs at once on the PC, from any agent or Claude session, through named mutexes `Local\kit-checks-turn-<n>`. The rest wait, 20 minutes at most, then run anyway.
    - A run started inside another's (`KIT_CHECKS_TURN` set, as when the Assayer paces `steward vouch`) takes no turn.
    - `KIT_CHECKS_TURN_NAME` gives a test turns of its own.

### What changed

- **One switch decides the pace** (`node/gentle.ts`): Manor's Settings `"backgroundPace"`, gentle or full.
  - A page being looked at no longer lifts its agent's cap, or its round children's, for a minute after each request. What a page shows is now what the agent costs in the background. A visit no longer starts PowerShell twice, to lift the cap and set it again.
  - Run now runs at the setting's pace too.
  - `pageInUse()` stays but does nothing, so an agent that calls it (Chronicler) still builds.
  - `paceProcess(p)` and `setPriorityFor(p)` lose their `asked` argument.
- **The checks pace's cap is the gentle pace's** (`checksCap()` = `gentleCap()`: a quarter of the processor, two processors' worth at most), no longer half the processor.
  - Measured on an 18-core laptop with the Assayer's suite (155 tests). On a quiet PC: no cap, the whole PC peaked at 91% (the suite's own 68%) in 39 s; at the gentle cap, 43% (16%) in 65 s. On a busy PC: no cap, 73 s and 57%; half the processor, 44 s and 49% (half barely held it); the gentle cap, 219 s and 17%.
  - The suite's memory peaked at 0.8 GB.
- **The checks cap follows the owner's setting** (`checksPaceCap()`). There is none when Manor's Settings pace is full. While the pace is gentle, settings.json `"checksPace"` (or `KIT_CHECKS_PACE`) may set it.
- **`pacedCommand`'s `fast` is gone.** A run asked for by hand is paced like any other.

### Before you update

- An agent that starts its tests through `pacedCommand`:
  - drops `fast`;
  - should allow paced runs about four times their usual time (the Steward's `PACED_TIME`).
- An agent that calls `paceProcess(p, asked)` or `setPriorityFor(p, asked, set)` drops the `asked` argument. Surveyor's `setPriorityFor(pace())` is fine as it is.
- An agent with an MCP server, or a process of its own outside `every()` (Reeve, the Assayer, Manor's installs), calls `containSelf()` at its start.

## 2.72.1

**The graphics card on demand: beside an NPU, the card does only the work the NPU can't, and only while it's asked for.**

This builds on 2.68.0, which it needs.

### What's new

- **The card on demand.** With Manor's "Use the graphics card for models when there's an NPU" off (its default), a graphics card beside an NPU now keeps the work no enabled NPU on the PC serves, instead of being left out altogether.
  - Beside Intel's NPU, which can't run the vision model, the card does vision: the first vision request starts its server (`ensureServer`, as for any server), and the keeper stops it after `gpuIdleStopMinutes` unused (10 by default). The card's other servers stay stopped.
  - Beside a Snapdragon's NPU, which chats, sees and makes embeddings, nothing is left for the card: it is left out, as before.
  - An NPU whose chat or embeddings failed at setup (2.68.0's fallback) leaves that work to the card the same way; with no card, to the processor where it is set up for it.
  - Vision with no card and no processor set up for it stays unavailable, with the same plain note as before ("no vision model …").
- **`card-check.ts`**, a check for a real PC with an NPU that can't see and a card that can: a chat question (the NPU's), a vision question (the card's, its server seen to start), then the keeper's looks with a short idle time until that server is stopped as unused, not sooner; then chat again on the NPU, and none of the card's other servers started. It prints PASS or FAIL and exits 0 or 1; it changes nothing in config.json. `node <agent>\src\kit\card-check.ts [--idle-minutes 1] [--out <file>]`.
- core: **`npuServes(list)`**, the kinds of work an enabled NPU in the list serves.
- keeper.ts: **`cardOnDemand(accs, withNpu)`**, what each card still does while it's kept out beside the NPU (`[{ id, kinds }]`).
- **Setup by the same rule.** With the switch off, setup sets up a card beside an NPU only for the work no NPU serves after the NPU's own setup and tests (core's new **`cardWorkBesideNpu(kinds, npu)`**, which `withoutGpuBesideNpu` uses too, so setup, requests and the keeper can't drift apart). On an Intel PC the card gets vision alone: its chat and embedding models (about 3.1 GB) aren't downloaded. The plan says so per card (`SetupPlan.leftToNpu`, `SetupTarget.leftToNpu`, and a line in `describePlan`).
  - The NPU failing a kind at setup: the card is set up for that kind too, in setup's second pass (before the processor's, which still serves a PC with no card). The NPU failing outright: the card gets everything, as before.
  - The switch turned on: the next Set up fills in the card's other kinds; nothing re-runs setup on the switch itself. A card the NPU leaves nothing to (a Snapdragon's) is set up whole, as before, so the switch stays offered for it.
  - `setupCommand` reads the switch (manor.ts's `gpuWithNpu()`) unless given `gpuWithNpu`; with no Manor it's the agent's default (on), as before. `planSetup` takes `gpuWithNpu` (left out: every card, as before). Kinds asked for by name are set up as asked.

### What changed

- core: **`withoutGpuBesideNpu(list, false)`** keeps a card with only the work no enabled NPU serves (a copy; the same object when that's all it does; dropped when that's nothing). A reranker stays off the card beside an NPU. A vision endpoint on its chat endpoint's server keeps that server when chat goes.
- keeper.ts: `reapedServers(…, { keepGpuOut })` marks `keptOut` only the card's servers for the NPU's work; the on-demand ones get the card's idle time like any other. `gpuKeptOut` is true when a card is kept out of any work. The keeper still never starts a stopped server itself.
- npu.ts: `new Npu(cfg, { gpuWithNpu })` takes Manor's switch as a check gives it. A request for the card by name, for work the NPU does, still says the card isn't used beside the NPU.
- setup.ts: a card set up again keeps the entries it had for the kinds left to the NPU (`keepingAddOns`, `keptKinds`), and their ports: an install whose card has its chat and embeddings keeps them, files and all; the keeper keeps them out. A card's kinds it had take their ports before one it gains, so a card set up again never moves a server it kept.
- npu-server.ts: **`longFetch`**, fetch over node:http for a local server, limited only by the request's own signal. Node's fetch gave up after 300 s without headers (undici's headersTimeout), although `npu-check`'s steps allow 10 minutes: `serverClient` (the NPU check and the benchmark) now uses it, and a request past its limit still says "no answer in N s".

### For an agent

- Nothing: take the kit and release as usual. On an Intel PC with a graphics card, vision starts working with Manor's default settings, on the card, when something asks for it; nothing runs on the card otherwise.
- An agent that runs setup (`setupCommand`) gets the switch read for it; one calling `planSetup` itself passes `gpuWithNpu` to follow it.
- An agent that took "the switch off" to mean "no card at all" must now ask `withoutGpuBesideNpu` about the very list it routes: a card can keep part of its work. Reeve, which gives the NPU an embedder of its own, names its search index after the model its routed list embeds with from 0.17.56: take that Reeve first.

## 2.72.0

**Rounds on the manor's shared 30-minute clock: they don't drift, and each agent's schedules fall in a minute of their own.**

It comes after 2.69.0 to 2.71.2, still waiting to be merged here, and touches none of their files but `kit/VERSION`.

### What's new

- **On the clock.** `every()` puts a schedule whose interval fits the shared clock (`fitsClock`: whole minutes that divide 30, or multiples of 30 minutes that divide the day: 1, 5, 10, 15, 30 minutes, 1, 3, 6, 12, 24 hours…) on its slots: multiples of the interval from local midnight, plus the schedule's phase (`nextOnClock`). The next round is the first slot at least half an interval after the last one ended, so a round that waited its turn or ran long keeps its slot.
- **A phase for each schedule.** `clockPhase(id, name, everyMs)`: whole minutes under both the interval and 30 minutes, from the agent's id and the schedule's name, the same on every PC and at every start. An agent may give its own with `every()`'s `phaseMs`.
- round.json's entries say the phase (`phaseMs`; spec/ROUND.md's new section, The clock).

### What changed

- The interval is kept to the whole second from a minute up (`wholeInterval`), so one worked out in another unit can't drift off the clock.
- An interval off the clock (7 minutes, 5 hours, anything under a minute or not in whole minutes) keeps the old way: each wait counted from the last round, varied by ±10%.
- The first round after a start keeps its stagger (2 to 15 minutes at a gentle pace).

### For an agent

- Nothing to do: take the kit. To share the clock, give a schedule an interval that fits it (an hour rather than 50 minutes).
- An interval function must return the interval, not the time left until the next round: every() works out the wait itself. (Porter returned the time left, which put odd values in round.json's `everyMs`.)
- A test that expects a 1-minute schedule's next round a whole minute after the last should use an interval off the clock (70 s): on it, the next round falls on the next minute.

## 2.71.3

**An agent's small files cost a stat, not a read, while they are unchanged, and a write that would change nothing writes nothing: Manor's pings, the pace and round.json stop touching the disk for nothing.**

### What changed

- **`writeJson` leaves a file that holds exactly that JSON as it is** (store.ts): no temporary file, no rename, its modified time as it was. A file whose size differs is never read for the comparison. `{ always: true }` writes all the same, for a write whose time is read; the settings kit's save uses it, so a person's save of Settings still moves the file's time (the Steward's migration notes go by it).
- **Reads are kept by what a stat says** (new `file-cache.ts`: `readText`, `readJsonFile`, `statOf`, `holds`, and `fileCounts` for tests and measurements). A file unchanged since this process read it (the same modified time, change time, size and file id) costs one stat; any change is read again at once. A file modified within 2 s of being read (`SETTLED_MS`) is read every time until it settles, so two changes in one tick of the file system's clock are never missed. Files over 1 MB are never kept, and at most 256 are. `readJson` goes through it and still parses afresh at every call.
- **Manor's settings.json**, read by `pace()`, `agentsAtOnce()`, `manorLink()`, `developerOptions()`, `gpuWithNpu()`, `notifyPrefs()` and `manorProjects()`, and **the agent's own settings** (`readSettings()`, so `needsSettings()`), `duty()` and `ownDeveloperOptions()` all read through it. Each still answers what the file says now: a change in Manor's Settings applies at the next request or round, as before.
- **`/api/ping` reads no file** while nothing has changed: measured with the fixture agent (a settings spec, one schedule held for a required setting), a ping went from 8 reads and 15 other file calls to 0 reads and 12 stats.
- **A round held for the person** (its required settings, or an ended trial) is written to round.json when the hold starts or what it waits for changes, not at every interval (spec/ROUND.md): its `started` and `finished` are when the hold began. A reader takes an entry with `waiting` for an agent waiting for the person, however old.

### Before you update

- Nothing: it updates itself as usual. An agent that ages a file by its modified time, and writes it with `writeJson` with content that may not change, passes `{ always: true }`.

## 2.71.2

**A refused project's reason speaks of projects and the manor's own, never of employees.** To the person using the manor, the repositories in Manor's Settings are just their projects. They never think of the manor's own repositories as employees, so the refusal no longer says "an employee is looked after as staff".

### What changed

- **node/manor.ts:** `projectsFrom` gives "is <owner/name>, one of the manor's own: the manor looks after it itself, so it can't be a project", and for a checkout "is one of / inside one of / a folder holding one of the manor's own checkouts: the manor looks after those itself, so it can't be a project". The doc comments of `projectsFrom` and `manorProjects` call them the owner's projects. The rules themselves are unchanged.
- **What an agent must do:** nothing, unless a test of its own matches the old words. Manor's server test matched the whole message: it now matches only up to "one of the manor's own" (Manor 0.16.144), so take that Manor before pinning this kit there.
- **Its tests:** kit/test/manor.test.ts, which also checks that no refusal mentions an employee.

### Before you update

- Nothing: it updates itself as usual.

## 2.71.1

**Tests sign no commits (`unsigned-git.ts`, and `test-git.ts` for a test script's `--import`), and release builds are tested once, before a kit is published, not in every run.**

### What's new

- `unsigned-git.ts`: `unsignedGitVars(env)` gives the environment variables that turn git's `commit.gpgsign` and `tag.gpgsign` off (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`), after any the environment already has, and nothing when it has them; `unsignedGit(env)` adds them in place. With the person's own commit signing on (an SSH key, as the manor's owner has it), every throwaway commit a test makes starts ssh-keygen, and Defender scans each signing buffer: 461 in one run of the Steward's tests. The person's own settings are never touched.
- `test-git.ts` sets them for a whole test run: `"test": "node --import=./src/kit/test-git.ts --test \"test/**/*.test.ts\""`. The `=` keeps the script one the Steward can narrow to the tests a change reaches. Nothing else imports it: it changes the environment as it loads.

### What changed

- The Steward runs every repository's checks with them, whatever the repository's test script says.
- The kit's release tests build one release each, the minified one as released, and list the zip (`tar -t`) instead of unpacking it twice; the native test unpacks only what it checks. The other builds (readable, dirty, no announcement, native and dirty: there were five and two) run with `STEWARD_RELEASE_TESTS=1`: `npm run test:release`, and `tools/kit-release.ts --publish` before it publishes a kit (`--skip-release-tests` leaves them out). In the full suite under load the two tests took 524 s and 514 s, and set the time of every vouch.
- The kit's tests that serve a page take a port nothing listens on (`kit/test/free-port.ts`: from 40000-48999, checked on 127.0.0.1 and ::1), never the fixture's own 17979. Every checkout's tests used 17979, so two test runs at once met there and one failed with EADDRINUSE.

- `release.ts`, `npu-bench.ts` and `npu-check.ts` run when started from a folder reached through a junction or link: they compared the path they were started by with their own real path, and did nothing, silently, when the two differed.

### For an agent

- Nothing needed: the Steward's and the Assayer's checks already sign nothing. To make `npm test` run by hand sign nothing too, add `--import=./src/kit/test-git.ts` to its test script once it takes this kit.

## 2.71.0

**On a PC with little memory, the NPU's model server rests sooner when nobody uses it, and the first request after that waits for it to wake instead of failing.**

### What's new

- **The NPU's idle stop by the PC's memory** (`npu-vendors.json`'s `idleStop`, spec/NPU-VENDORS.md "Resting when unused"). With no `npuIdleStopMinutes` in config.json:
  - under 20 GB of memory (`smallPcGb`; 16 GB shows as 15.3 to 15.9), each server stops after its route's own minutes: GenieX and its llama-server 5, OpenVINO Model Server's chat and embedding servers 5, FastFlowLM 10;
  - 20 GB or more, or memory unknown: rules.json's 10, as before.
  - A route's minutes are 20 times its cold start, never under 5 (`idleMinutesFor`): GenieX 15 s and OpenVINO Model Server 4 s measured, FastFlowLM taken as 30 s.
  - `npuIdleStopMinutes` in config.json, when set, wins on any PC (0 never stops).
  - None of the three servers can unload its model and keep running, so stopping is the unload. The next request starts it again.
  - New in `npu-vendors.ts`: `idleMinutesFor`, `smallPc`, `routeOfServer`, `coldStartMsOf`, `npuIdleStopMinutes`; the route's `idleStop` (`coldStartMs`, `minutes`, `basis`, `verify`). `serversToReap` takes `ramBytes` (default the PC's).
- **Callers can be told the local AI is waking.** `AskOptions.onWaking(w: Waking)` is called before a request waits for a server to start (`how: 'starting'`) or to finish loading (`'loading'`). `w.line` is a plain line for the person, such as "Waking the local AI on the NPU: it rests when nobody uses it, so the first answer takes about 4 s longer.", and `w.aboutMs` is the route's cold start. `wakingOf` builds it. `ensureServer` takes `onWaking` too.
- **`npu-check.ts --idle`** (its steps in the new `node/npu-idle.ts`) runs the rest and the waking on a real NPU, each step passing or failing:
  - idle-wake;
  - idle-stop: the keeper's own look stops every server after a minute unused;
  - idle-cold-answer: a person's 20 s request after that is told it's waking and answers within the cold load, and its cold start is printed as `idleStop` numbers;
  - idle-in-flight: a request in flight is never stopped.
  - `npu-vendors.json`'s Intel and AMD `idleStop.verify` say how to run it on a 16 GB Lunar Lake and a Ryzen AI 300.

### What changed

- **Intel's embedding server is stopped when idle.** It is a second OpenVINO Model Server holding 1.7 GB, and the keeper now stops it with the NPU's lock and idle time. Before, it ran until the PC restarted.
- **An idle stop never races a request.** The keeper already stopped a server only in the accelerator's turn. Now a stop whose turn isn't had within 2 s (`TURN_AT_ONCE_MS`) gives way and reports `in-use`: someone took the accelerator after the keeper looked. A request arriving during a stop waits its turn, then starts the server again.
- **The first request after a start gets the cold-load allowance.** After the kit starts an NPU server, its warm-up gets at least `requestBaseMs` plus the larger `coldLoadMs`, even when the caller's `timeoutMs` is shorter (Envoy's 20 s captions). Before, that first request could time out and fail while the model was loading.

### What an agent must do

- **The Smith and Reeve** (the keepers): take 2.71.0, and the rule applies where they keep.
  - The Smith's Settings should show the NPU's idle minutes as the rule gives them on this PC (`npuIdleStopMinutes({program, kind, ramBytes, otherwise})`).
  - It should write `npuIdleStopMinutes` to config.json only when the person changes it: a value there overrides the rule.
- **Envoy**: pass `onWaking` on caption requests and show `w.line` where the person is waiting, in the setting-up card's style.
- **Manor's chat**: it can show `w.line` in place of its own "getting the model ready".
- Nothing else: config.json's format is unchanged, and an agent that does nothing gets the new timings and the longer first wait.

## 2.70.0

**The checks pace: test runs, type checks, installs and builds an agent starts can't peg the processor any more.**

### What's new

- **`node/checks-pace.ts`**: `pacedCommand(file, args, { fast })` gives the command to start instead, through a small launcher (`node/checks-pace.cs`, compiled once per PC to `<locks>\..\kit\checks-pace-<hash>.exe`, as `gentle.cs` is to a DLL). The launcher starts the command suspended, puts it in a job, and only then lets it run, so it and every program it starts are held by:
  - a hard cap on the processor: half of it by default (`checksCap()`), two processors' worth at least;
  - below-normal priority, which its programs take from it (a program may still raise its own).
- **One job for the whole PC** (`Local\kit-checks-pace`): two check runs side by side share the cap rather than taking it twice. A process already in a job of another family gets a job of its own with the same cap. The job ends what is left in it once no launcher holds it: a test's server left running, or a command stopped on a timeout.
- **The cap is a setting**: Manor's settings.json `"checksPace"` (or `KIT_CHECKS_PACE`), a percentage of the processor from 10 to 100, or `"full"` for none (`checksPaceCap()`). `fast: true` (a run the person asked to be quick) isn't paced, as Run now lifts the gentle pace. Under `node --test` nothing is paced unless `KIT_CHECKS_PACE` says, so a test never builds the launcher in the PC's kit folder.
- Off Windows a paced command runs under `nice -n 10`. A launcher that can't be built leaves the command as it is, said once in the log: the pace never fails a check.

Measured on an 18-core laptop (the Steward's own checks: its kit filled, a type check and its whole test suite): before, 60 s of 201 s at 98% or more; at half the processor, 1 s of 203 s (the rest of the PC's work on top, Windows Defender's scans of what the tests write among it).

### Before you update

- Nothing for an agent that doesn't start test runs or builds. One that does (the Assayer) adopts it by starting them through `pacedCommand`.

## 2.69.1

**An update is no longer rolled back because the network went down while it was installing.**

### What changed

- **The probation asks for the home page on 127.0.0.1** (`homePageUrl`, `homePageStatus`), as the ping always did, not at the page's `<agent>.localhost` name. Windows doesn't resolve `*.localhost` itself: it asks the network's DNS server (a home router answers 127.0.0.1). So while the network is down the name doesn't resolve, and a page that was up and answering was rolled back and flagged unsafe with "its home page didn't answer". On 2026-10-13 that happened to seven agents within the same minute: Windows logged that its DNS server stopped answering at 14:16:32Z, the moment the first one was rolled back. The page's server already takes 127.0.0.1 as its host.
- **A home page that doesn't answer at all is asked again at each look**, and fails the probation only if it hasn't rendered by the end of it (90 s). An answer that's an error status still fails at once, and so do the wrong version answering and a page that stops answering its ping.
  - The install's own settling (15 s) leaves the home page to the background watcher, which asks again.
  - A rollback for a home page that never rendered keeps its old words, "its home page didn't answer", which the Steward's retry of such rollbacks reads.
- `probation()` takes `homeLater`, for a settling whose end isn't its own to judge.

### For an agent

- Nothing: take the kit and release as usual. The fix works from the agent's next update on, since a release's own install runs the probation. `unsafe-updates.json` is unchanged, so versions flagged before stay flagged until they are allowed again (`install --allow-unsafe`, or the Steward's retry of such rollbacks).

## 2.68.0

**Intel NPUs nobody has measured yet (Meteor Lake, Arrow Lake, Panther Lake, Wildcat Lake) are set up safely: setup measures each PC's NPU, checks that its answers make sense, and falls back quietly when it can't use it.**

This builds on 2.67.0 (Intel's 4,096-token cap and embeddings on the NPU), which it needs.

### What's new

- **Starting values for each Intel generation** in `npu-vendors.json` (`generations.<id>`: `timeouts`, `maxContextTokens`, `caps`, `args`, `memoryGb`, `basis`; the route with them is `routeFor(route, generation)`).
  - The NPU 3720 (Meteor Lake and Arrow Lake, about a quarter of Lunar Lake's compute): prompts of up to 2,048 tokens, 60 s plus 400 ms a token, and a 6-minute cold load.
  - NPU 5 (Panther Lake and Wildcat Lake): Lunar Lake's values with a 4-minute cold load.
  - Lunar Lake keeps its measured values. Every generation but Lunar Lake stays `verified: false`.
- **Setup calibrates an unverified generation on the PC.** After the test request, two short requests more (a warm "ready", and a count to twenty) measure it. `calibrate` turns the measurements into that PC's timeouts in its NPU entry, never under the starting values and never past `CALIBRATION`'s bounds. Under 2 tokens a second the NPU isn't used for chat. `setUpNpu` returns `measured`, and `NpuIo.measure` replaces the measuring requests in tests (null skips them).
- **Sanity, not just an answer.**
  - The chat test refuses the same few characters five times over (`repetitive`), as well as an answer without "ready". The measuring count must count (`countsSensibly`).
  - The embedding test sends three sentences (`EMBED_TEST`). `embedSanity` checks the dimensions (`dims` on the embedding server's model: Qwen3-Embedding-0.6B's 1,024), that the values are numbers and not all zero, and that "a cat" lands nearer "a kitten" than "an invoice".
- **A memory check before choosing the NPU.** `npuMemoryFit` gives the NPU at most 40% of the PC's memory (`NPU_MEMORY_SHARE`), against the route's `memoryGb` (Intel: chat 4.3 GB, embeddings 1.74 GB; 3.6 GB at the NPU 3720's 2,048):
  - 16 GB keeps both;
  - 12 GB keeps chat;
  - 8 GB keeps the NPU out.
- **The NPU check names the generation, and gives the patch that verifies it.** The report's `generation`, and `patch`: on an unverified generation, with every step passing, the change to `npu-vendors.json` that flips it to `verified: true`, with the suggested timeouts and what they were measured on. `--generation <id>` runs a rehearsal with a generation's starting values.
- **`npu-check.ts --harden`** forces setup's failures on a real NPU, then checks its calibration against what it measured. Each step passes or fails:
  - a driver minimum above the driver;
  - a 1-second test;
  - `OpenVINO/Qwen3-4B-int4-ov`, which answers nonsense there;
  - the calibration itself.
- **`npu-check.ts --generation <id>`** on a real NPU runs as that generation of its maker's, with that generation's starting values and prompt cap. For example, a Lunar Lake can stand in for an NPU 3720. The run counts as a rehearsal and changes nothing in npu-vendors.json.
- **npu-check never measures someone else's server.** On the NPU, if a server already answers on the route's port (the manor's own local AI, most likely), it refuses and says to stop that server first. In a rehearsal off the NPU, its servers move to free ports instead.

### What changed

- **The NPU failing is no longer an error.** `setupCommand` logs the NPU's failures as `note:` lines and leaves them out of its exit code.
  - Chat and embeddings fall back separately. What the NPU doesn't serve goes to a card set up beside it; with no card, the processor is set up for it in the same run.
  - Why the NPU, or its embeddings, isn't used is kept in plain words (`npu-note.json`, via `rememberNpuNote`/`readNpuNote`). The accelerators' report shows it (`npuNote`).
  - `setUpNpu` returns that note (`note`, built by `npuNoteFor`).
- `planNpu` takes `noEmbed`, and `planSetup` takes `skipNpu` and `cpuKinds`. The plan's `npuPlain` says why the NPU, or its embeddings, isn't used.
- A test request that times out says "didn't answer in time (N s)". `testNpuEntry` takes `timeoutMs`.
- An NPU driver too old now reads "the NPU's driver needs an update: …".
- `NpuIo.clockMs` is the clock the first start is timed by, for tests. It isn't called `now`, so an agent whose io extends `NpuIo` with a `now` of its own still compiles. The Smith's trial does that, with a `now` that returns a Date. Every member `NpuIo` gained in this version is optional.

### For an agent

- Nothing: take the kit and release as usual. Setup no longer fails when the NPU does, so a Set up that showed an NPU error now finishes, with the graphics card or the processor doing that work and a note saying why.

## 2.67.0

**Intel's NPU: three times the text a request may carry, and embeddings on the NPU, so a PC with default settings can search its code.**

### What changed

- **Intel's cap is 4,096 tokens** (it was 1,536): `--max_prompt_len 4096`, with the timeouts that suit it (30 s, plus 300 ms a token, and 180 s for a cold load, leaving room for Meteor Lake's slower NPU). On a Lunar Lake the NPU check passed every step at that cap. A short answer costs about 70 ms more, and the benchmark's jobs no time at all (job time 11.0 s, against 11.8).
- **Embeddings on Intel's NPU.** The route's `embedServer` is a second OpenVINO Model Server: the route's own program and environment on port 18186, serving OpenVINO's channel-wise INT4 Qwen3-Embedding-0.6B (428 MB, pulled as the chat model is, its files pinned) with `--pooling LAST --max_length 2048`.
  - The NPU compiles a fixed shape, so a request longer than 2,048 tokens is refused. A dense 1,500-character chunk (UUIDs, hex, base64) runs to 1,338 tokens, so 1,024 wasn't enough.
  - The entry's embed cap is 680 tokens by the kit's estimate, which stays under 2,048 real tokens.
  - On the Lunar Lake: the graphics card's own results, a query in 166 ms, and 16 of Reeve's chunks in 2.6 s, against 5.9 s on the Arc as setup gives it.
  - Until now, a default Intel install had no embedder at all: Manor's `gpuWithNpu` is off, so the Arc is set aside.
- `NpuEmbedServer` takes either kind of server.
  - It may have no `download`, `into` or `exe`: it is then the route's own program, started a second time with the route's environment.
  - Its `model` is either a file to download (`NpuEmbedFile`) or a model the route's program pulls (`NpuEmbedPull`: `pull`, `present`, `pinned`; `isPulled` tells them apart).
  - `embedPaths` now takes the route. The plan's `embed.modelPull` holds the pull's arguments while the model isn't here.
  - Setup pulls the model, then checks its pinned files. A failure leaves the NPU's chat as it was, without embeddings.
  - An embedding endpoint carries its route's `caps.embed`.
- `npu-check.ts --device CPU|GPU` moves the embedding server along with the route when it has a device argument too, and drops the NPU's `--max_length` off the NPU.
- `checkPinned` takes anything with an `id` and `pinned`.

### For an agent

- Nothing: take the kit and release as usual. On an Intel PC, setup run again pulls the embedding model and adds embeddings to the NPU's entry. Reeve then builds a new index under that model's name, `OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov`.

## 2.66.0

**The NPU benchmark: a fixed suite that measures how fast and how well a chip does Castellan's work, for the website's boards; and a count of the tokens agents send, to weigh it.**

### What's new

- **node/npu-bench.ts**: `node <agent>\src\kit\npu-bench.ts [--profile quick|full] [--device NPU|GPU|CPU] [--model <id>] [--candidate <id>] [--cap <tokens>] [--energy] [--yes] [--no-setup] [--out <file>]`. It sets a route up as the NPU check does, without writing config.json, then streams a fixed suite at its server: first and cached loads, a short answer, writing and reading speed (time to the first token at 512 and 1,024 tokens and near the cap), three graded reference jobs (triage, reply, summary) whose medians add up to the **job time** the chips board ranks by, 24 graded quality items with three that must pass, vision where the model has it, memory, holding speed over ten minutes (full runs), and energy on battery (`--energy`). It records the conditions (plugged in, Windows' power mode, battery, brightness, how busy the processor was, the laptop's make and model) and marks a run that can't be ranked, with the reason. The report is JSON, checked against its schema, and names no person, PC or path. spec/NPU-BENCHMARK.md describes it all.
- **spec/npu-bench-suite.json** (`castellan-npu-bench/1`, the prompts, grades and settings) and **spec/npu-bench.schema.json** (the report's schema).
- **node/npu-server.ts**: starting and stopping a model server, asking it (streamed or not), waiting for it and reading its memory, out of the NPU check, which uses them and behaves as before.
- **node/token-tally.ts**: every chat and vision request is counted, by day, agent, work, lane and accelerator kind: how many, prompt and answer tokens, time, and how sizes spread. Counts only, never what was asked or answered, kept in the accelerators folder (`usage\<day>\<agent>.json`) for 60 days and sent nowhere. `npu-bench.ts --mix [days]` prints them. The benchmark's job sizes are set from them.
- **spec/NPU-BENCHMARK.md**: the benchmark's design, the owner's decisions, and the first run (a Lunar Lake's NPU: job time 11.8 s, 23 of 24 right).

### What changed

- Intel's model has a `present` file (its `graph.pbtxt`, which OpenVINO writes last), so a finished download counts as here.

### For an agent

- Nothing: take the kit and release as usual. The tally writes a small file a day in the accelerators folder.

## 2.65.0

**Intel's NPU route, run on a real Lunar Lake: a model that works on the NPU, the runtime it needs brought by setup, and a test request that checks the answer.**

### What changed

- **Intel's model is now `Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov` (2.2 GB), a channel-wise INT4 export Castellan made for the NPU and publishes on Hugging Face.** The route's first model, OpenVINO's `Qwen3-4B-int4-ov` (a group-wise AWQ export), loaded and answered fast on a Lunar Lake NPU, but with nonsense ("?option?option…"), while answering properly on that PC's processor and graphics card. OpenVINO publishes channel-wise exports for the NPU, but none of a Qwen3 4B; its Qwen3-8B one worked (14.8 tokens a second, 4.7 GB). Castellan's 4B export of Qwen3-4B-Instruct-2507, the model the AMD and graphics-card routes chat with, passed every step of the NPU check after setup downloaded it from Hugging Face: a first load with its compile 31 s, 5 s from its cache, about 25 tokens a second, the 1,536-token cap refusing plainly. Its files are pinned (size and SHA-256), and Lunar Lake is now `verified`.
- **A model pinned for every generation**: `pinned['*']` in npu-vendors.json, for a model that is the same file on each (OpenVINO's, which each PC compiles for its own NPU). A generation's own pin comes first.
- **Setup's test request checks the answer.** It asks for the single word "ready", and the NPU entry is written only if the answer says it (`saysReady`, `withoutThinking` in setup.ts). Before, any text passed, so a broken model would have been configured, and every agent's request would have come back as nonsense. The NPU check's first, warm and restart answers are checked the same way.

- **OpenVINO Model Server's runtime comes with it.** The server needs the Microsoft Visual C++ runtime. Until now setup refused Intel's route on a PC without it, saying an administrator must install it once, so the NPU never showed and nobody was told what to do. Intel's route now names a `runtime` in spec/npu-vendors.json: Microsoft's own package of those DLLs (the Visual Studio catalog's CRT redist, 3 MB, size and SHA-256 pinned, from download.visualstudio.microsoft.com). Setup downloads it with the server, after the server, and copies its five DLLs beside `ovms.exe`, where Windows looks first. Nothing is installed for the whole PC and nothing needs an administrator. A server that has them all beside it isn't given them again.
- The plan says so: `get  the Microsoft Visual C++ runtime 14.44 (3 MB, SHA-256 pinned), beside ovms.exe: no administrator`, and its size counts in the download.
- `NpuPlan.missing`, `NpuRoute.requires` and the System32 check behind them are gone. `NpuPlan.runtime` (an `NpuRuntime` with where it goes) takes their place. `setup.ts`' `installRuntime` does the copying, and `NpuIo.copy` lets a test watch it.
- **The NPU check starts the server as the keeper does.** Setup writes the server's paths as `%USERPROFILE%\...`, and the check started that command without expanding it. So with a tools home under the user's folder it started nothing, said nothing, and waited 20 minutes. It expands them now, and a start that fails is written to the server's log. Found on the first run on an Intel NPU (Lunar Lake, 2026-10-12).

### For an agent

- Nothing: take the kit and release as usual. Manor's page shows the runtime as a download only if it lists the plan's parts itself (Manor's local-ai.ts `planParts` does).

## 2.64.0

**Fewer programs started for each git command: git's own git.exe, and `ls-remote` over https asked in the agent's process.**

### What's new

- **node/git-exe.ts**: `gitExe()`, the git to start. On Windows, PATH finds Git for Windows' `cmd\git.exe`, a launcher that starts the real `git.exe` (under `clangarm64`, `mingw64` or `mingw32`) and, for an agent with no console, a console host for it: three processes for every git command. `gitExe()` names the real one, so git starts alone; the real git.exe sets up the environment the launcher would have (MSYSTEM, HOME, PATH) by itself. A git earlier on PATH that isn't the launcher, or a launcher with nothing behind it, stays `git`. Everywhere else it's `git`.
- **node/smart-http.ts**: `advertisedRefs(url)` reads a remote's refs over https in the agent's own process (one request for its ref advertisement), and `lsRemoteText(args, refs)` prints them as `git ls-remote` would for the options it reads (`--heads`, `--tags`, `--refs`, `-q`) and plain patterns. Checked against git's own output.
- **node/git-auth.ts**: `signedIn` answers `git ls-remote` over https itself, with the same sign-in it would have handed git, when the URL is plain https and nothing in git's config or environment changes how git would talk to it (a URL rewrite, a proxy, own certificates or headers). Anything else, and any failure (refused, redirected, timed out, an answer that isn't a ref list), runs git as before. `KIT_SMART_HTTP=0` turns it off. `remoteUrl(repo, name)` reads a clone's remote URL from its config file without starting git.

### For an agent

- Start git through `gitExe()` where you start it yourself (`execFile(gitExe(), …)`), and run your git through `signedIn` to get the in-process `ls-remote`. Nothing else: take the kit and release as usual.

## 2.63.0

**On a Snapdragon, embeddings run on the Hexagon NPU: Qwen3-Embedding-0.6B through llama.cpp's own server over GenieX's libraries.**

### What's new

- **Qualcomm's route has an embedding server** (`embedServer` in spec/npu-vendors.json, `NpuEmbedServer` in node/npu-vendors.ts). GenieX serves no `/v1/embeddings`, but it carries llama.cpp b11125 with its Hexagon backend and Qualcomm's signed HTP libraries. Setup downloads llama.cpp's own b11125 release for Windows on Arm (13 MB), copies GenieX's 13 llama.cpp libraries over it (`overlay`, node/setup.ts `overlayFiles`), downloads Qwen3-Embedding-0.6B (Q8_0, 639 MB, the model the graphics card already uses, so an index carries over), and writes the NPU's entry with an `embed` endpoint on port 18182: `llama-server --device HTP0 -ngl 99 --embeddings --pooling last`, with `ADSP_LIBRARY_PATH` set to the server's folder in the endpoint's `env` (FastRPC finds the HTP library there; without it the session doesn't open).
- **Measured on the Snapdragon X2 Elite** (search-eval over a real repository, 9 questions): the NPU 9/9 in the top five, warm queries 45–73 ms; the graphics card (Adreno, OpenCL) 9/9, 103–155 ms; npu-embed's nomic 8/9, 73–88 ms. Indexing: 124 ms a 1,600-character chunk on the NPU, 265 ms on the graphics card. The NPU's vectors match the graphics card's (cosine 0.999 or more). spec/NPU-VENDORS.md, "Embeddings on the Hexagon", has the table.
- **The NPU check has an embed step**: when the route has an embedding server, `npu-check` starts it, times a query and a full-size chunk, and stops it again.
- `testNpuEmbed(entry)` (node/setup.ts): the NPU's embedding server answers one embedding, in the NPU's turn. `planNpu`'s plan carries `embed` (the server and model downloads, null when there already), counted in `downloadBytes`; `describePlan` lists them.

### What changed

- A Snapdragon with no graphics card no longer gets embeddings on the processor: they go to the NPU.
- The graphics card's download of the same model file is skipped when the NPU's setup fetches it.
- The keeper reaps the NPU's llama-server embedding server in the NPU's lock, with its idle time, like the NPU's chat server; npu-embed is still left to stop itself.
- When the embedding server fails its test, the NPU's entry is written without embeddings (they go to the graphics card or the processor), and setup says why.

### For an agent

- Nothing in the agent itself: take the kit and release as usual. An agent that starts servers from an endpoint on its own, not through the kit's `ensureServer` or keeper, must pass the endpoint's `env` (the kit's `serverEnv(ep)`) to the server it starts, or the NPU's embedding server exits at once. Reeve does so from 0.17.39, which must be out before this kit reaches a Snapdragon.

## 2.62.0

**A release can carry an agent's own native program for each processor, signed, and the installed copy keeps this PC's.**

### What's new

- **kit.json's `"native"`** (node/native.ts, spec/RELEASES.md "Native files"):
  - `{"build": "native/build.ps1", "out": "native/build", "notices": [...], "thumbprint": "<SHA-1>"}`.
  - `npm run release` runs the build script once per processor (`-Arch arm64`, `-Arch x64`), each into an emptied `<out>\<arch>\`.
  - The zip carries both processors' files at the same paths, with the notices in `<out>\notices\`. `release.json` says `"native": {"out", "arch", "signed"}`.
- **Signing** (node/sign.ts):
  - A published release signs each `.exe` and `.dll` that isn't signed already, with the x64 signtool (a cloud key's provider is x64 only), and timestamps it. Files signed by their maker keep that signature.
  - Every file is then checked: Valid, the certificate's, timestamped.
  - The signer is checked with a trial signature before anything is built.
  - A release with native files is never published unsigned.
- **Install:**
  - It keeps only this PC's processor's folder.
  - Before an update or uninstall moves the app folder, it waits up to 5 seconds for programs running from it to end, then ends them.
  - `nativeFolder(appRoot)` gives a copy its folder for this PC, checkout or installed.

### What changed

- Nothing, for an agent without `"native"`: its release, install and update are as before. Windows is asked about running programs only when the installed copy's release carried native files.

### For an agent

- To carry a native program:
  - add `"native"` to kit.json and git-ignore its `out` folder;
  - have the program end when the page does (tell it on `onStop`);
  - keep the notices of any runtime it carries.
- Nothing otherwise.

## 2.61.0

**A handler can stream its reply: a live recording sent to another PC as it is made.**

### What's new

- **A streamed reply** (node/server.ts): a handler can answer `{ stream, type, status? }` with a Node `Readable`, and the server pipes it to the client as it comes, for a reply too long to hold or one with no end until the client stops it. The stream is destroyed when the client goes away, and the reply is cut off when the stream fails. A HEAD gets the status and type, and the stream is destroyed unread.
- **The request's `headers` and a `signal`**: a handler now gets the request's headers, and an `AbortSignal` that is aborted when the client goes away before the reply has ended, so long work for one caller stops when nobody waits for it. Both are optional in the `Request` type, so a test that builds a request without them still compiles; `serve()` always gives them.

### For an agent

- Nothing: take the kit as usual. The Chronicler uses the streamed reply to record a game played on another PC (Manor's Other PCs forward `/api/peer/*` to it).

## 2.60.0

**The NPU check: one command that tries a maker's NPU route on real hardware and measures it.**

### What's new

- **node/npu-check.ts**: `node <agent>\src\kit\npu-check.ts --yes` on a PC whose NPU route hasn't run on hardware (Intel's OpenVINO Model Server, AMD's FastFlowLM). It does setup's NPU steps, timed, without writing config.json, then measures the server: its start and first load (OpenVINO compiles for the NPU), warm answers, tokens written and read a second, a request under and past the cap (refused plainly, the server still up), two at once, its memory, a start again from the compile cache, and the kit's own test request in the NPU's turn. It prints the caps and timeouts the numbers suggest for npu-vendors.json and keeps the whole report as JSON in the tools home. spec/NPU-VENDORS.md, "The NPU check", lists its steps.
- `--route intel --device CPU` rehearses Intel's route on the processor of any PC that runs x64 programs, in a scratch REEVE_HOME.
- **Intel's NPU route, checked against OpenVINO Model Server 2026.4.1's source and Intel's driver pages**: Intel's NPU driver minimum is now 32.0.100.4023 (Intel's own NPU model cards for OpenVINO 2026), and 32.0.100.5540 on Panther Lake (OpenVINO 2026.2–2026.4 may crash there with older drivers). A generation can carry its own `driverMin`. Wildcat Lake's NPU (`FD3E`) is known; `AD1D` is Arrow Lake-S.

### What changed

- **OpenVINO Model Server is waited on until its model is loaded.** It answers `/v1/models` within a second of starting, with an empty list, and refuses requests (404) until its model is loaded, which on the NPU means compiled: minutes. Every agent's first request after it started would have failed. A server started from `ovms.exe` is now ready only once it lists a model (`listsWhenLoaded`, `probe(…, { listsWhenLoaded })`); every other server is ready once it answers, as before. Found by rehearsing Intel's route on the processor.
- A request waits on a server loading its model as long as its accelerator's `coldLoadMs` allows, when that's longer than the rules' `readyWaitMs`.

### For an agent

- Nothing: take the kit and release as usual. The check is a tool for trying a route, not something an agent calls.

## 2.59.0

**An urgent fix reaches customers at once, not on the Exchequer's next release day.**

### What's new

- From Exchequer 0.8.0, customers get Castellan's releases on its release days, Tuesdays and Fridays at 14:00 UTC, so a week's work arrives together. An urgent fix goes out at once instead:
  - **The entry says so**: a version whose `CHANGELOG.md` entry has a line starting `**Urgent fix:` (its bold line, saying what it fixes), or brings one from a version never released on its own, is published as urgent (node/exchequer.ts `isUrgent`, spec/RELEASE-NOTES.md "An urgent fix").
  - **Or the release does**: `npm run release -- --publish --urgent`, and `--exchequer --urgent` for a release on GitHub already. One published to the Exchequer already is let out then too.
- **node/exchequer.ts `letOut(id, version)`**: lets a release published already out to customers now, with the publisher's key (the Exchequer's `POST /api/v1/admin/releases/:id/:version/out`). It says when the release is out already, isn't published, or the Exchequer has no release days yet. The Steward's `release-now` uses it.

### What changed

- An urgent publish asks the Exchequer's `/done` with `{ urgent: true }`. A release that isn't urgent asks it with no body, as before. An Exchequer from before release days ignores the body and offers every release once it's published, so nothing changes there. One that couldn't let it out early publishes it all the same, and the line says it waits for its release day.

### For an agent

- Nothing: take the kit and release as usual. Mark an entry `**Urgent fix:` only for what can't wait.

## 2.58.0

**Two pieces for agents that talk to git remotes a lot: git's sign-in asked once per host, and the branch heads another agent has just read.**

### What's new

- **node/git-auth.ts** (moved from the Steward's src/git-auth.ts, where it has run since Steward 0.35.31). Over https, every fetch, push or ls-remote of a private repository has git ask the credential helper for the sign-in, and Git Credential Manager answers in processes of its own. Measured on this PC for one `git ls-remote --heads origin` of a GitHub repository: 9 git processes and 2 of the manager's, against 3 git processes when the sign-in is handed over.
  - `signedIn(run)` wraps an agent's own runner: its git commands that talk to a remote over https get the host's sign-in as an Authorization header, through git's environment config (`GIT_CONFIG_COUNT`…), never the command line. The sign-in is asked once per host (`git credential fill`) and kept 30 minutes in memory, never on disk. A host that refuses it is asked the helper's way, and its sign-in asked again after 10 minutes.
  - `scriptEnv(origins, run)`: the same for a script (a PowerShell job). It asks once per host and gives back the environment to start the script with. The credential helpers are switched off only for those hosts (`credential.<origin>.helper`, empty), so any other host the script talks to signs in as before.
- **node/remote-heads.ts**: branch heads one agent read, shared with the others in `remote-heads.json` in Manor's folder. `shareRemoteHeads` writes them (through a temporary file and a rename), and `freshRemoteHeads(url)` reads a remote's back when they're fresh (`FRESH_MS`, 20 minutes) and are all its branches. Otherwise it returns null, and the agent asks the remote itself. `remoteKey` makes one key of every way of writing a remote (https, scp-style, ssh://, owner/name). The Steward 0.35.39 writes the file after each glance.

### For an agent

- Nothing unless it fetches a lot: take the kit and release as usual. An agent that talks to remotes in a loop can wrap its runner in `signedIn`, and one that only checks whether a remote moved can try `freshRemoteHeads` before its `ls-remote`. Never rely on the file: no Steward, no GitHub, or an old read all mean asking the remote as before.

## 2.57.1

**Pages that answer at once: on ::1 too, at a normal pace while someone uses them, and Manor's always.**

### What's new

- **A page in use runs at a normal pace** (node/gentle.ts `pageInUse()`). Every request a browser makes (it sends `Sec-Fetch-Site`; Manor's pings and the CLI's requests don't) lifts the agent's process to a normal pace, as for a round someone asked for, and it goes back to its pace a minute (`IN_USE_MS`) after the last. At a gentle pace a page waited behind every program at normal priority: under a full processor load a below-normal page took up to 11 s to answer where the same page at normal priority took under 1 s. The background work keeps its gentle pace whenever nobody is looking.
- **A hidden tab doesn't ask** (react/page-data.ts): `usePageData()` skips its looks while `document.hidden`, and looks at once when the tab is shown again, so a tab left open doesn't hold its agent at a normal pace (and costs it nothing).

- **`keepResponsive()`** (node/gentle.ts), for a process people wait on: its rounds never set it gentle, so it keeps normal priority, no efficiency mode and no processor cap at any pace, and a gentle pace already set is lifted. Manor calls it as it starts serving: at a gentle pace its page sat ready to run for up to half a minute at a time while Windows gave it no processor (its Open said "Opening…" all that while), and the programs it starts were held to its cap with it. An agent's own process keeps its pace.

### What changed

- **`serve()` listens on ::1 as well as 127.0.0.1** (node/server.ts `alsoOnV6Loopback()`). A browser asks for `<agent>.localhost` on ::1 first, and where nothing listened there it waited about 300 ms before trying 127.0.0.1, on every new connection: each Open from Manor and each first request paid it. A second listener on ::1 hands its connections to the same server, so the host check and the token are the same; closing the page closes both. Loopback only, as before. On a PC without IPv6, or with ::1's port taken, it goes without and nothing changes.

### Before you update

- Nothing: take it by pinning 2.57.1 in kit.json. Only a process people wait on calls `keepResponsive()`; an agent shouldn't.
- An agent whose own page polls outside `usePageData()` should skip its polls while `document.hidden` too, or an open tab keeps it at a normal pace.

## 2.57.0

**An agent of Manor's staff no longer starts from a hidden sign-in task: Castellan, in Windows' Startup apps, starts Manor, and Manor starts its staff.**

### What changed

- **node/install.ts: no sign-in trigger where Manor starts the staff.** `install` looks for Manor's entry in Windows' Startup apps (`MANOR_STARTUP`: the value `Castellan` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which Manor 0.16.120 and later writes). Where it's there, the agent's task `\<Name>\Home page` is registered without its logon trigger (`homePageTaskXml`'s `atSignIn: false`): Manor's first round opens each agent on duty, one at a time, and the task still runs when an install asks (`schtasks /Run`), outside whatever started the install. An update replaces the task, so an agent's hidden sign-in start goes at its next update. Where it isn't (no Manor, or an older one), the task starts the agent at sign-in as before.
- Turned off in Startup apps, the value stays and nothing starts at sign-in: the person's choice, which an update keeps.

### For an agent

- Nothing: take the kit and release as usual.

## 2.56.1

**`uninstall --purge` removes only the agent's own data folder.**

### What changed

- **node/install.ts, `purgeRefusal()`.** `<ID>_HOME` can name any folder, and `--purge` deletes everything in it. The kit now refuses, and changes nothing, when that folder:
  - is a whole drive, the profile, or one of Windows' or the person's own folders (Documents, Desktop, Downloads, Pictures, Videos, Music, OneDrive, source, Projects, AppData, Program Files, ProgramData, Windows), or holds one;
  - is a git repository;
  - isn't named for the agent (`%USERPROFILE%.<id>` or a `<ID>_HOME` such as `D:data<id>`) and holds no copy of it.
- Before, only a drive and the home folder were refused.

### Before you update

- Nothing for an agent: take the new kit as usual. An uninstall that's refused says why, and leaves everything as it was.

## 2.56.0

**A few agents' rounds at a time, fewer while the PC is busy.**

### What's new

- **The work line (node/pace.ts, `inWorkTurn()`).** Every scheduled round from `every()` now takes a slot in one line shared by every agent on the PC (`<locks>\work`, `work.2` …, the kit's line as the NPU's), at either pace. As many run side by side as Manor's settings.json `"agentsAtOnce"` says (1 to 6; 0 lifts the line), or 2 at a gentle pace and 4 at a full one when it doesn't. The rest wait their turn, first come, first served. A first round takes its first-round turn, then its work turn.
- **Load-aware.** Before it joins, a round looks at the PC's load from Node's own counters over a second (`measureLoad()`, no program started): at 60% of the processor busy or more, or under 15% of memory free, it may take only the first slot, so a busy PC runs one round at a time; at 35% busy, half the slots (`slotsFor()`, `LOAD`).
- **`every()`'s `light`**: a schedule whose rounds are light (a few requests, a look at a file) runs them at once, outside the line. It may be a function, asked before each round, for a schedule that ticks often and only sometimes has work (light while nothing is due).
- **round.json says what a round used** (spec/ROUND.md): `cpuMs`, the processor time of the agent's own process in the round; `memoryMb`, its most memory, sampled every five seconds; and `waitedMs`, how long it waited its turn, when that was a second or more.

### What changed

- A round whose work turn doesn't come before its next is due (its interval, a minute at the least) is recorded as one that waited (`"ok": null`, `"waiting"`), as a first round's turn already was, and waits again at its next round. A holder keeps its slot for its round's time limit; one whose process has gone gives it up at once.
- A round someone asked for (Run now) never waits, as before.
- While a round waits in the work line, its state's `waiting` (`/api/ping`'s `rounds`) says so, so a reader never takes it for a schedule with nothing coming.
- round.json's new `turn` (`"first"` or `"work"`) marks a round that waited its turn, beside `waiting`, so a reader can tell it from one held for the person's settings.
- `MANOR_AGENTS_AT_ONCE` says instead of Manor (0 for no line). Under node --test there is no line unless it says.

### For an agent

- Nothing: take the kit and release as usual. An agent whose schedule only looks at something light can pass `light: true` to `every()`. Heiward's .NET scans don't take the work line yet.

## 2.55.0

**The Settings form for a long list: records on one line that says what each does, tabs by name, less said.**

### What's new

- **A record's line (react/settings-form.tsx).** A folded record is a line now, not a bare title: after its title, the values of the records' `line` fields (its repository and branch, say), muted; a chip for each field with a `chip` while it is set, or its `chipOff` while it isn't; and each switch marked `inline`, working right there. Its advanced fields fold under `advancedLabel` (default Advanced). More than eight records: a box finds one by any text in it.
- **`tab` on a top-level setting** puts it in a tab of that name in a long form, so a long list of settings is split up without changing settings.json's shape; a group's label puts it in that group's tab. A form that names any tab has its tabs in the schema's order, the first one open; one that names none is as before (General first).
- **`missing: 'made'` on a path rule (node/settings-kit.ts)**: a path the agent makes itself, such as a work folder, is kept with no warning while it doesn't exist yet. A warning makes a hidden field show, so a folder the agent makes shouldn't carry one.
- **`noAdd` on records**: no Add button, for records that arrive another way; each can still be changed or removed.
- **`hidden` on a field**: kept in the file and carried through every save, and drawn only when the agent has something to say about it (an error or warning), so it can ask for the value it couldn't find. For a value the agent decides itself. A hidden field's `chip` still shows on its record's line, and "Set every field to its default" leaves it alone.

### What changed

- A setting at its default no longer says "Default: … Reset to default" under it; one you've changed still does.
- A record with a warning in it says "needs a look" on its line, and stays folded; one with an error opens, as before.
- **web/settings-panel.css:** in a window 1100 pixels wide or more, a long form's tab of plain settings is in two columns, no setting split between them; a tab of records stays one to a line.
- **web/settings-panel.css:** the panel's filled-button rule no longer reaches a long form's tabs. It outranked `.tab`, so every tab was filled with the accent: hard to read in the dark theme.

### For an agent

- Nothing: take the kit and release as usual. A schema can use `tab`, `line`, `chip`, `inline`, `hidden`, `noAdd`, `advancedLabel` and `missing: 'made'` where they help; web/settings-panel.js leaves out `hidden` fields and ignores the rest.

## 2.54.0

**Settings' tabs read as tabs again.**

### What changed

- **web/settings-panel.css: its filled buttons leave the tabs alone.** `.sf-panel button` outranked react/styles.ts' `.tab`, so a long form's tabs (react/settings-form.tsx) were drawn as accent-filled buttons, unreadable in the dark theme. The panel's base and hover button rules now skip `.tab`; look.test.ts checks it.

### For an agent

- Nothing: take the kit and release as usual.

## 2.53.0

**Demo mode: an agent's page with made-up data, for Manor's pictures of each employee.**

### What's new

- **node/demo.ts, and node/server.ts in demo mode.** With `KIT_DEMO=1` (the agent's `demo` folder) or `KIT_DEMO=<folder>`, the page server lays the demo folder's file for a GET over the agent's own answer, key by key at the top (`demo/api/page.json` holding just `{ "body": … }` keeps the frame the kit builds), says `demo: true` in its ping, shows no developer content whatever the PC's Developer options (unless the demo's `hero.json` says `"developer": true`, for a developer agent's picture), refuses every button with 403, runs no rounds (node/schedule.ts) and holds nothing for required settings (node/required.ts): the page as it is once set up. The developer view's footer names `C:\Users\Alex\.<id>` as its data folder (`shownDataDir()`), never the PC's own. Run beside `<ID>_HOME` (an empty folder) and `<ID>_PORT`, nothing of the installed copy is read or touched. `isDemo()` tells an agent's own background work to stay off.
- **spec/DEMO.md**: how to run one, and what the demo folder holds: made-up data only, and an optional `demo/hero.json` saying which view Manor's capture pictures.

### For an agent

- Nothing: Manor keeps each agent's made-up data and takes its picture. Keep any background work of the page process off while `isDemo()`.

## 2.52.0

**An update's install no longer holds Manor's update pass for its whole probation.**

### What changed

- **node/safeinstall.ts: the probation is watched in the background.** The install now waits only until the new version is up and answering (about 15 s, `SETTLE_MS`), then hands the rest of the 90 s probation to a watcher started from the new copy (`install --watch-probation`, hidden and detached), and exits. Manor's update pass, which installs agents one after another, goes on to the next agent instead of waiting a minute and a half for each. A version that fails later is still rolled back and flagged as before; the watcher writes what it saw to `probation.log` in the data folder (its last 200 lines), and `probation.json` while it watches. The watcher leaves alone an agent that was updated again or rolled back in the meantime.
- If the watcher can't be started (it must say it is watching within 10 s), the install waits out the probation itself, as 2.51.0 did. `install --wait` always does.

### For an agent

- Nothing: take the kit and release as usual.

## 2.51.0

**The Steward's safe install for every agent, and sign-in tasks that wait and try again.**

### What's new

- **node/safeinstall.ts: every agent's install is behind the Steward's fail-safe.** An update keeps the version it replaces whole beside it (`app.prev`), installs as before, then is on probation for 90 s: its page must answer as the new version (three missed looks in a row on a busy PC are forgiven) and its home page must render. One that doesn't hold up is rolled back: the failed copy set aside as `app.unsafe-<version>`, the version before put back and started, and the version flagged in the data folder's `unsafe-updates.json`. A flagged version is refused at once (exit 3, nothing changed), so Manor's automatic updates stop trying it; a newer version installs as usual. `install --allow-unsafe` allows it again. `KIT_PROBATION_MS` changes the probation.
- **node/repair.ts: repairs another agent asks for.** `POST /api/repair` (`{ kind, finding?, detail? }`, behind the page's token) answers `{ ok, did, needsYou? }`, and `/api/ping` lists the kinds it takes in `repairs`. Every agent takes `round` (its scheduled rounds start now, at the pace); an agent adds its own with `onRepair()`. `askRepair(origin, ask)` is the asker's side. The Surveyor uses it to pass a finding to the agent that can put it right, and shows the person only what fails or needs them (spec/ROUND.md, Repairs).
- `installCli('install', …)` goes through it, so an agent needs no change: its `install` command is the safe one from this kit on. An agent with its own way to allow a version (the Steward's Dismiss) passes `allowHint` to `safeInstallCli`.

### What changed

- **node/install.ts: the sign-in task waits, and tries again.** `homePageTaskXml` gives the logon trigger a delay of 30 to 180 s, the same for an agent each time and spread across agents (`signInDelaySeconds(id)`), and Windows restarts a failed start up to five times, a minute apart. On 11 October every agent's task failed at sign-in (0x80070003, path not found) after a restart, while Heiward's, which waits a minute, started.

### For an agent

- Take the kit and release: the new task is registered with the next install, and the safe install guards the one after it.

## 2.50.0

**Heiward's background pace for every agent, and fewer programs started all day.**

### What's new

- **node/gentle.ts, node/gentle.cs: Heiward's background pace.** At the manor's gentle pace (the default), Windows runs an agent as it runs Heiward in the background, from the agent's start and through its scheduled rounds:
  - in Windows' efficiency mode;
  - at a very low disk priority;
  - under a hard cap on the processor, of a quarter and two processors' worth at most. The cap holds the agent and every program it starts (git, ffmpeg, PowerShell, a model's runtime), however many threads they run.

  A round the person asked for (Run now) lifts all three while it runs, and a full pace in Manor's Settings never sets them. The agent's PowerShell worker sets them, with a small helper compiled once per PC and shared by every agent, and only when the pace changes. `KIT_GENTLE=0` leaves an agent at below-normal priority alone, as before.
- **node/schedule.ts: `runSoon()`.** Starts a scheduled round now, at the pace. Use it for an agent's own reasons to start early (a file changed, a request came in); `runNow()` is for the person, and runs at full speed.
- **node/ps.ts: one PowerShell for the agent.** `powershell()` runs scripts in one long-lived PowerShell (node/ps-worker.ps1), each in its own runspace and several at once, rather than starting powershell.exe for each script. The worker leaves after 2 minutes with nothing to run, and is replaced after 500 scripts. A script that calls `exit`, or writes to the console itself (`[Console]::Out`, `[Console]::WriteLine`), still gets its own powershell.exe, and `KIT_PS_WORKER=0` turns the worker off.
- **node/github.ts: `GitHubApi`.** GitHub's REST and GraphQL from Node, signed in as the GitHub CLI is (it asks `gh auth token` once). GETs keep their ETag, so an unchanged answer costs nothing of the rate limit. Use it in place of starting `gh` for each question.

### What changed

- **node/schedule.ts:** at a gentle pace, a schedule's first round comes 2 to 15 minutes after the agent starts (random), not 30 s to 3 min, so a PC that has just started isn't ground down by every agent at once. At a full pace it is as before.

### What an agent must do

- Nothing, for the background pace: every() sets it.
- A round the agent starts for its own reasons should call `runSoon()`, not `runNow()`, so it runs at the pace.
- Where it starts `gh` to read from GitHub, it can ask `GitHubApi` instead.

### Before you update

- Nothing: it updates itself as usual. The first time an agent runs gently, it spends a few seconds compiling the shared helper, once per PC.

## 2.49.0

**Developer Pro: the Wright's and the Bailiff's work with the rest of the staff, shown only where it's sold.**

### What's new

- **node/developer-pro.ts:** `developerPro()`, which says whether this PC may see and run what other agents do with the Wright and the Bailiff. That covers the Assayer testing the Wright's drafts, failures filed for the Wright, the Aletaster's work orders sent to the Wright's queue, the Surveyor's findings handed to the Wright, and the Steward's look at the Wright's drafts. Today it is true only on the maker's laptop, by the same salted firmware check as the Steward's maker.ts. Once the Exchequer sells a Developer Pro license, its tier turns it on too, with no change in the agents. `CASTELLAN_CUSTOMER=1` makes even the maker's laptop answer no. `developerProForTests` stands in for the PC in a test.

### What an agent must do

- Ask `developerPro()` before showing a setting, a line or a button that names the Wright or the Bailiff, and before doing that work. Having the Wright installed is no longer enough. Ask it per request: after the first call it costs nothing.

## 2.48.0

**About, beside Settings: what's read once, out of the way of what's used every day.**

### What's new

- **react/shell.tsx:** an About view at #/about, with its button in the title bar beside Settings, where Manor's title bar has its own. It holds `Page`'s new `about` (what a person reads once: how the agent works, what it sets up, setting it up again), then "Where its work runs". The button shows whenever there's either. Its part for the tour is `about`.
- **node/page.ts:** `body.on-about` shows `#about-view` alone, as `on-settings` does Settings.

### What changed

- **react/shell.tsx:** "Where its work runs" moves from Settings to About, so Settings holds only settings.
- **react/tabs.tsx:** a page tab's id is never `about` either, and choosing a tab leaves an About address as it is. `PageTabs` and Settings' tabs draw on the server too, where there's no address (an agent's tests rendering its page): the first tab, where 2.47.0 stopped with "location is not defined".
- **What an agent must do:** nothing, for "Where its work runs" to move. To give About more, pass `about` to `Page`: reference parts of the page that a person won't need every day (a long how-it-works, a setup done once) belong there rather than in a page tab. A string-built page (node/page.ts) is unchanged.

### Before you update

- Nothing: it updates itself as usual.

## 2.47.0

**A long page, and long Settings, in tabs; a short one stays a single column.**

### What's new

- **react/tabs.tsx:** `PageTabs` (`{ id, label, count?, mark?, content }[]`), an agent's page in tabs, for a page too long for one column. The agent puts it in its body after whatever shows on every tab (a summary). The chosen tab is in the address, `#/<id>` (`usePageTab`, `pageTabInHash`; never `settings` or `tour`), kept through Settings and back. Every panel is drawn and kept while hidden, so what's typed or ticked in one stays. `count` shows beside a tab's name, `mark` a dot with its words on hover.
- **react/tour.tsx:** a tour step whose part is in a hidden tab shows that tab first (`SHOW_TAB`), then brings the part into view.
- **react/settings-form.tsx:** a long Settings form, two or more groups and `TAB_FIELDS` (10) ordinary settings, is in tabs: General (the settings in no group, then Advanced), then a tab for each group, in place of the jump links and folded sections. One Save sends them all. A tab with a problem is marked, and a refused save shows the first one. A shorter form is as before.
- **react/styles.ts:** `.tab-count`, `.tab-mark`, and `.tab-panel[hidden]`.
- **node/settings-kit.ts, react/settings-form.tsx:** a `list` field's `item` takes `options` (`{ value, label }[]`): its items are then picked from a dropdown of the options not chosen yet, not typed. Each item shows by its option's label with Remove; one no longer offered still shows until it's removed. The agent fills `options` when it serves the schema (a getter on `schema` works), for a list of things it knows, such as its repositories. An older kit ignores `options` and shows the list as text boxes, as before.

### What changed

- **react/tabs.tsx:** `Tabs` takes `count` and `mark` on each tab.
- **web/settings-panel.css, react/styles.ts:** the foot of a Settings form is clean. The Save bar takes the panel's own background (it was `--card`, a band of another shade on a darker panel). The field before Advanced, or before Save, has no rule of its own under the edge that follows. Advanced has room under it.
- **What an agent must do:** nothing, to keep its page as it is. To offer a list's items as picks, give its `item` `options`. A long Settings form changes by itself (on the agents today, the Steward's). To put a long page in tabs, use `PageTabs`, and only where it helps: a short page needs none.

### Before you update

- Nothing: it updates itself as usual.

## 2.46.1

**Settings' "changed" mark shows only beside a field that's changed.**

### What changed

- **web/settings-panel.css:** the rule hiding `.sf-changed` is `.sf .sf-changed`, so a page's own `.badge` rule drawn after `settings.css` (the React shell's styles) no longer shows the mark on every field. Reeve's Settings had it on every field and group, with nothing edited.
- **What an agent must do:** nothing; take the kit as usual.

### Before you update

- Nothing: it updates itself as usual.

## 2.46.0

**Every agent's Settings can be in tabs.**

### What's new

- **react/tabs.tsx:** `Tabs`, a row of tabs by the WAI-ARIA pattern (the arrows, Home and End move between them, the chosen one alone in the tab order; each panel `<prefix>-panel-<id>`, labelled by `<prefix>-tab-<id>`), for Settings or any page. `useSettingsTab(ids)` keeps the chosen tab in the address, `#/settings/<id>`, so a reload or a link keeps it; `settingsTabInHash` reads it.
- **react/shell.tsx:** `Page`'s `settingsTabs` (`{ id, label, content }[]`): Settings in tabs. The first, General, is the kit's Settings form, with `settings` above it and "Where its work runs" below, as before; then the agent's own. Only the chosen tab is drawn.
- **react/styles.ts:** the tabs' look (`.tabs`, `.tab`, `.tab-panel`), in every theme.

### What changed

- **react/shell.tsx:** `useRoute()` reads `#/settings/<tab>` as Settings too.
- **What an agent must do:** nothing. Without `settingsTabs`, Settings is one page as before. Manor's own Settings uses the same tabs.
- **Its tests:** kit/test/react-page.test.ts.

### Before you update

- Nothing: it updates itself as usual.

## 2.45.0

**Each agent Castellan sells checks the trial's end itself, from the license Manor holds.**

### What's new

- **node/license.ts:** the license a PC holds, shared by Manor and the agents: `LICENSE_KEYS` (the Exchequer's public key), `trustedKeys`, `verifyLicense` (EdDSA, offline), `LicensePayload`, and `readHeld` / `readHeldFile` for Manor's licence.json. It imports nothing of the agent's, so Manor can take it in place of its own license-keys.ts and the same functions in its license.ts.
- **node/license-check.ts:** an agent the Exchequer sells (its id in Manor's exchequer.json `agents` as `household` or `workshop`, and not held back or internal in Manor's staff.json) reads Manor's licence.json as it starts, every hour, and as soon as the file changes. Only a verified trial whose `runsUntil` has passed holds it:
  - its scheduled rounds wait, and Run now with them (schedule.ts), recorded in round.json as `"ok": null, "waiting": "The trial ended: a license brings it back"`, never a failure;
  - its page says "The trial ended: a license brings it back", that its settings and data are kept, and its pill says "Trial ended" (string-built and React pages alike; the React shell's `trialEnded`);
  - /api/ping and the status command say `running: false` with that line as `summary`, and `license: { state, ended, runsUntil, problem }`.
  duty.json isn't touched: once a license is here the hold lifts by itself.
- Everything else runs as before: a paid license, one that lapsed (the Freehold license), one of another tier, one awaiting its first payment. No licence.json, one that can't be read, or one that doesn't verify: it runs, and `license.problem` in its ping says why. Never an alarm.
- The time is the latest of this PC's clock, the license's `iat` and the latest time the agent has seen (license-check.json in its data folder, kept for a trial only), so setting the clock back doesn't bring an ended trial back.
- Manor and Heiward never check, nor does an agent the Exchequer doesn't list (the Wright, the Bailiff), nor any agent while Manor's exchequer.json can't say.
- **Under node --test** an agent checks only with `MANOR_LICENSE_CHECK=on`, so no agent's tests read the PC's own license.

### What changed

- **node/service.ts:** `dutyStatus(duty, up, trialEnded?)`: a third argument, false unless given.
- **node/page.ts:** `pillOf` and `statusPill` take `ended`.
- **What an agent must do:** nothing. An agent whose Run now doesn't go through the kit's `every()` should check `trialEnded()` (license-check.ts) before it works.
- **Its tests:** kit/test/license-check.test.ts.

### Before you update

- Nothing: it updates itself as usual. Manor's own copy of the keys and the license check (its license-keys.ts and license.ts) can move to this kit's license.ts in a later Manor change.

## 2.44.0

**A release's notes bring every version merged since the release before; entries can wait in changes/.**

### What's new

- **node/notes.ts:** `releaseNotes` now adds, after the version's own entry, the entries of the versions merged since the release before and never released on their own (the Steward releases once for all it merged in a round), each under its own `## <version>`, after a line that names them. `combinedEntry`, `entriesBetween` and `tagBefore` do it; `NotesInput.since` names the release before instead of asking git. A repository with no tags, or one released version by version, gets the same notes as before.
- **spec/RELEASE-NOTES.md:** "Entries in changes/": in a repository with `changes/README.md` on its branch, a piece of work writes its entry as `changes/<version>.md` and leaves the version files and `CHANGELOG.md` alone; the Steward sets the version and moves the entry in as it merges.

### Before you update

- Nothing: it updates itself as usual.

## 2.43.5

**A queue ticket can say what the request is for, and an agent can say it is setting up.**

### What's new

- **spec/NPU-QUEUE.md, core/queue.js:** a ticket's contents may carry `doing`, what the request is for ("search index: Heiward (17 of 673 files)"), at most 80 characters (`DOING_MAX`, cut with an ellipsis by writers and readers). `ticketText` takes it, `startTurn`'s and `withAcceleratorTurn`'s options pass it (`doing`), and `waitingOf` / `queueSnapshot` give it back for status pages. A program on a long job says the job's overall progress there, so a status page can show that rather than guess when one turn ends. Informational only: nobody's turn depends on it.
- **node/server.ts:** `SettingUp` and `settingUpFromPing()`. An agent doing a long piece of work once, or again after a big change (Reeve reading every project for search, the first time and with each new model), puts `settingUp: { text, done?, total?, unit?, until?, accelerator? }` in its ping (`ServeOptions.ping`) until it's done. Manor shows it as a calm banner, never an alarm.

### What changed

- **What an agent must do:** nothing. A ticket without `doing` and a ping without `settingUp` read as before. An agent that queues long jobs should pass `doing`. One that sets itself up at length should say `settingUp`.
- **The kit's dotnet part** doesn't write `doing` yet. Its tickets read as before.
- **Its tests:** kit/test/core.test.ts, kit/test/npu-queue.test.ts, kit/test/setting-up.test.ts.

### Before you update

- Nothing: it updates itself as usual.

## 2.43.4

**The kit's MIT license comes with the kit, as `src/kit/LICENSE`.** An agent's own LICENSE now points to the kit's license instead of pasting the MIT text, so the kit brings its license itself, and every agent's release carries it beside the kit.

### What changed

- **tools/kit.ts:** filling `src/kit` copies the kit's `LICENSE` beside its `VERSION`, as `src/kit/LICENSE`. A kit release has held `LICENSE` all along (tools/kit-release.ts); only the fill left it out. A kit tree or release without one (as a test's may be) fills as before, with no `LICENSE`.
- **What an agent must do:** nothing: the Steward's bump brings the new tools/kit.ts and fills `src/kit` again. An agent's release takes everything under `src/`, so `src/kit/LICENSE` goes into its zip with the kit.
- **Its tests:** test/kit-tool.test.ts.

## 2.43.3

**The manor's pace: agents new to the manor do their heavy first rounds one at a time, and every scheduled round gives way to the person.** A first install, or every agent hired together, ran each one's first round at once, at normal priority: first indexes, first scans, a first look at every repository, together, and the PC ground to a halt.

### What's new

- **node/pace.ts:** Manor's settings.json `"backgroundPace"`, `gentle` (the default) or `full` (as before), read afresh with `pace()`.
  - **First rounds one at a time.** A schedule whose round has never gone through waits for its first round in one line with the others (`inFirstRoundTurn`, the lock folder `first-rounds` beside the accelerators' locks, one slot), and runs once the one before it has finished. Later rounds, which only catch up, never wait.
  - **Below-normal priority** for a scheduled round (`setPriorityFor`), passed on to the programs it starts.
  - A round the person asks for never waits, and runs at normal priority. Under node --test the pace is full unless `MANOR_PACE` says, so no test waits in this PC's line.
- **node/schedule.ts:** `every()` does all of that. round.json keeps `wentThrough` (each schedule's first round that went through; a round.json from before counts as through, so an update never queues anyone). A round's state has `firstRound` (`waiting` or `running`), and `firstRoundNow()` gives the agent's.
- **Settling into the manor.** While a first round waits its turn, or a long one runs, the status pill says "Settling in" and the page, string-built or React, shows a banner in the role's colour (the manor's door, with footsteps walking up to it) saying it is new and takes longer this once (`settlingText`, `SETTLING_SVG`). A look's new `firstRound` says what a long first round does: Reeve's and Heiward's have one.

### What changed

- spec/ROUND.md has a Pace section.
- **What an agent must do:** nothing: its rounds take the pace with this kit. One whose first round takes much longer than the rest gives its look a `firstRound`. An agent that schedules its own heavy work outside every() (Heiward) joins the same line through the kit's lock on `first-rounds`.
- **Its tests:** kit/test/pace.test.ts.

## 2.43.2

**The Toller and the Assayer say where their work runs, and have their own scenes.**

### What's new

- **node/work.ts:** `WORK` entries for the Toller (its hourly round over your projects' lockfiles, changed files and tools, and one look at the listening ports; no model) and the Assayer (test runs in throwaway worktrees at below-normal priority, at most 3 a round, every 15 minutes; no model). Both are developer roles (`developerRole`): with Developer options off, their pages have no "Where its work runs".
- **node/look.ts:** a scene for each: the Toller's striped bar lifts once the coin drops; the Assayer's balance tips and settles.

### What changed

- **What an agent must do:** nothing. The Toller and the Assayer show the new section and scene once they take this kit.
- **spec/DEVELOPER-OPTIONS.md:** the developer roles' list names the Toller and the Assayer.
- **Its tests:** kit/test/work.test.ts, kit/test/look.test.ts.

### Before you update

- Nothing: it updates itself as usual.

## 2.42.0

**One list of tracked repositories, in Manor.** The repositories the manor looks after on a PC were set in five places: the Steward's employees, Manor's non-employee projects, Reeve's found repositories, the Wright's and the Aletaster's own lists. From this version Manor's list (settings.json's `"projects"`) is the one place, and each agent derives its own from it. The rule is the new spec/REPOSITORIES.md.

### What's new

- **node/manor.ts:** a project has `merges` (the Steward merges the team's ready pull requests into its branch; needs `repo`) and `release` (`tag` or a command; needs `repo` and `versionFiles`). Both are off unless it says, as the person's yes. `projectsFrom()` checks them, and says why it leaves out an entry that gets them wrong.
- **spec/REPOSITORIES.md:** staff (Castellan's own agents, only where Castellan is released) and tracked repositories (the person's own, on every PC), an entry's keys, which agent uses which, and the move to one list.

### What changed

- **`manorOwn()`** counts the Steward's employees as the manor's own only where the Steward releases Castellan (`releasesCastellan` not false), as before there. On any other PC the repositories a person gave the Steward are theirs, and may be tracked as projects. A Steward settings.json from before `releasesCastellan` reads as before.
- **What an agent must do:** nothing to keep working: a project read before has `merges` false and `release` empty. An agent that keeps its own list of repositories should derive it from `manorProjects()` where Manor is installed, as spec/REPOSITORIES.md says. Manor, the Steward and the Wright follow in their own PRs.
- **Manor** moves with it: its tests check a project's every key, so Manor before 0.16.24 fails three of them on this kit. Manor 0.16.24 (its tracked-repositories change) expects `merges` and `release` and passes, so this kit is released with `kit:breaks-agents` and Manor 0.16.24 merges right after.
- **Its tests:** kit/test/manor.test.ts.

### Before you update

- Nothing: it updates itself as usual.

## 2.41.0

**A reranker the keeper sets up and keeps: a fourth serve kind, `rerank`.** Reeve's search gives its ten best files a second look by a reranker (Qwen3-Reranker-0.6B through llama.cpp's `/v1/rerank`), which on its 24 test questions put the right file first 16 times instead of 13. A reranker started by hand on a manor port was stopped as an orphan after 5 minutes, since no configured server was it. Now it is one.

### What's new

- **node/accelerator-config.ts:** a new `EndpointKind` (`ENDPOINT_KINDS`): the routed `ServeKind` (chat, vision, embed; unchanged) and `rerank`. An accelerator has its `rerank` endpoint, read, checked and written as the others, and `serves()` and `endpointFor()` take an `EndpointKind`, so `endpointFor(a, 'rerank')` gives it. It is an add-on, not routed work: `ServeKind` and the core's `Work` don't change, and no agent's requests go to it unless it asks for it.
- **node/setup.ts:** `--serve rerank` (`kinds: ['rerank']`) downloads ggml-org's Qwen3-Reranker-0.6B Q8_0 GGUF (639 MB) and starts llama-server with `--reranking`, on a graphics card or the processor (`setup cpu --serve rerank`). It is set up only when asked for (`DEFAULT_KINDS` stays chat, vision and embed), beside what the accelerator already serves: its other servers, slots and cap stay, with their ports, and setting them up again keeps the reranker (`keepingAddOns`, `keptKinds`). A reranker alone never sets the NPU up.
- **node/keeper.ts:** a graphics card's or the processor's reranker is kept like its other servers: stopped when idle, restarted when it stops answering, never an orphan. Its log is `<id>.rerank.log`.

### What changed

- **What an agent must do:** nothing: its code that handles each `ServeKind` is unchanged. An agent that sets up or shows every endpoint (the Smith) lists `ENDPOINT_KINDS`; one that asks the reranker (Reeve) takes `endpointFor(a, 'rerank')`. (A first draft added `rerank` to `ServeKind` itself, and the Steward's trial caught Reeve's router, which hands a `ServeKind` to the core's request timings, failing to compile.)
- **Its tests:** kit/test/setup.test.ts.

### Before you update

- Nothing: it updates itself as usual.

## 2.40.0

**Settings obey the Developer options switch from the schema alone, and the kit's own parts leak nothing more with it off.** What the agents had to work around when they took 2.39.0 is now the kit's.

### What's new

- **node/settings-kit.ts:** `developerOnly` on a field (at the top level, in a group, or in a list of records) and on a choice's option leaves it out of what `/api/settings` sends while the switch is off, and a save then keeps its stored value as settings.json had it. A record with a field left out carries a handle (`KEPT`) instead, by which the save finds its hidden values. `plain` on a field gives its label, help, pattern hint and placeholder in plain words. The schema is served per request (`schemaFor`, `valuesFor`), so an agent writes its schema once, in full, with no getter, and no check-and-fix-up around a save.
- **A developer's whole form:** `developerOnly: true` on the `SettingsSpec` (or every field `developerOnly`) makes `/api/settings` say `developerOnly` with the switch off, with no field; both Settings panels leave the form out, and a save is refused (`DEVELOPER_ONLY_FORM`).
- **node/work.ts:** `AgentWork.developerRole`, set for the Auditor, the Developer Herald, the Aletaster, the Pinder and the Steward: with the switch off their page has no "Where its work runs", since none of their work runs then.

### What changed

- **/api/ping** sends `pid` only with the switch on. Its one reader, the Pinder, finds an agent by the port it listens on first.
- **"Where its work runs"** in plain words no longer names the NPU, its maker (Qualcomm Hexagon, Snapdragon), the vision model or Task Manager: the NPU is "the AI chip", the processor is "the processor", and a graphics card keeps its name. The Miller's and the Lamplighter's lines and the Clerk's note say it so too.
- **What an agent must do:** nothing to keep working; a getter or a save workaround it has still works. To drop them, mark its developer fields and choices `developerOnly` (and give `plain` words where its labels need them), or the whole spec for a developer role's form, as spec/DEVELOPER-OPTIONS.md says.
- **Its tests:** kit/test/settings-developer.test.ts, and both ways in work.test.ts, settings-kit.test.ts and react-settings.test.ts.

### Before you update

- Nothing: it updates itself as usual.

## 2.39.0

**Every agent gets Manor's Developer options switch, and the kit's own parts of every page obey it.** Castellan is sold to general users, gamers and developers, and only developers see developer content. With the switch off, the kit's parts no longer show repositories, tools, model servers or file paths, and an agent can keep its own developer content out of its page and its API. The rule is the new spec/DEVELOPER-OPTIONS.md.

### What's new

- **node/developer.ts**, the switch for every agent. Under Manor, Manor's settings.json `"developerOptions"` decides. Without Manor, or with a Manor that hasn't said, the agent's own `"developerOptions": true` in its settings.json decides, and it's off by default. It's read afresh on every call, so a flip in Manor applies at the next request with no restart.
  - `developer()` returns `{ on, setBy }`, and `isDeveloper()` returns `on`.
  - `developerOnly(value, fallback?)` gives `value` only when on. A function is called only then.
  - `withoutDeveloper(payload, keys)` removes those fields from a payload at any depth when off.
  - `failureFor(error, plain)` gives the error's message to a developer and the agent's plain words to everyone else.
- **react/developer.tsx**: `useDeveloper()` and `<DeveloperOnly fallback>`, exported from react/index.ts. `<Page>` passes the switch down from the page's data.
- **node/react-page.ts: `PageShell.developer`**, read for every page and every /api/page.
- **/api/ping says `developer`.** An open page, React or string-built, draws itself again within seconds when the switch flips.
- **spec/DEVELOPER-OPTIONS.md**: the three audiences, everything a non-developer never sees, plain words in its place, and how an agent gates its data first and its page second.

### What changed

- **node/work.ts:** with the switch off, "Where its work runs" talks about "the local AI" instead of Reeve. Each line gives its `plain` wording, with no PowerShell, WMI, pnputil, winget, FFmpeg, GenieX, llama.cpp, SHA-256 or listening ports. Developer work (`dev: true`) is left out: the Aletaster's, the Developer Herald's and the Steward's lines. Notes have `plainNotes`. With the switch on, everything is said as before. `workSection` takes `developer`, `thisPc` takes a second argument, and `workLine()` is new.
- **The footer** names the data folder only when on, on both page kinds. `PageShell.dataDir` is empty when off.
- **node/settings-kit.ts:** with the switch off, `/api/settings` sends an empty `file` and gives its problems as one plain line (`PLAIN_PROBLEM`). A save refused by the agent's own rules says `PLAIN_REFUSAL`. `settingsReply` and `saveSettingsReply` take an optional `developer`. Both settings panels say "Changes are checked and saved here" without a path, and the problem badge says "Settings".
- **What an agent must do:** nothing to keep working. To obey the switch, gate its developer content as spec/DEVELOPER-OPTIONS.md says.
- **Its tests:** kit/test/developer.test.ts, plus both-ways tests in work.test.ts, settings-kit.test.ts and react-page.test.ts.

### Before you update

- Nothing: it updates itself as usual. On a PC where Manor's Developer options are off, or with no Manor, each agent's Settings page stops showing the settings file's path and the technical lines in Where its work runs. Turn Developer options on in Manor to see them again.

## 2.38.0

**Reeve, the Chamberlain and Heiward have their own title-bar scenes too.**
- **node/look.ts:** a scene and an accent for each, in its icon's colour, moving while it works (`LOOK`): Reeve's log scrolls up through an amber reading line while the count is kept beside it in gate tallies, four bars and a strike ("Reading the logs"); the Chamberlain presses its keyhole seal into the red wax on a letter and files the letter in its pigeonhole ("Filing your papers"); Heiward's shears go along the hedge snipping each sprig that has grown out of it, by a picket fence ("Trimming the hedges"). They have no lines in `WORK`: an agent's page shows its look whether or not it has them.
- **This kit brings 2.36.2**, never released on its own: the Thatcher's, the Reckoner's, the Weigher's and the Shepherd's scenes and their lines in `WORK`.
- **What an agent must do:** nothing. Each takes its scene with this kit.

### Before you update

Nothing: it updates itself as usual.

## 2.37.0

**Nothing of Castellan's but Heiward is published on GitHub.** Castellan now comes only from castellan-software.com (Manor 0.16.0; Manor's docs/SELLING.md, "Getting Castellan"), and Manor updates itself, and the staff held back from sale, from the Exchequer.
- **node/release.ts: `publishTo`**: an agent of Castellan's (one with a releases repository) other than Heiward goes to the Exchequer, then to its own repository as `v<version>`, never to the public releases repository. That holds whether the Exchequer sells it or it's held back from sale: `forSale` no longer decides where a release goes. When the Exchequer doesn't take it, the release now fails (exit 1), with a line saying `npm run release -- --exchequer` finishes it from the agent's own repository. Before, it fell back to the public releases repository.
- **Heiward**, free, AGPL and public, still goes to the releases repository and its own, as before. Anyone else's agent (no releases repository) goes to its own repository and then the Exchequer, as before.
- **node/exchequer.ts: `NEVER_SOLD`** is `['heiward']`: Manor is published to the Exchequer now. Manor's own release tool calls `publishToExchequer` for it.
- **What an agent must do:** nothing. Its next release goes to the Exchequer and its own repository.
- **Its tests:** kit/test/release-for-sale.test.ts (where each release goes) and kit/test/exchequer.test.ts (`NEVER_SOLD`).

### Before you update

- Nothing: it updates itself as usual. Manor 0.16.0 needs this kit to publish itself to the Exchequer.

## 2.36.2

**The Thatcher, the Reckoner, the Weigher and the Shepherd have their own title-bar scenes, and say where their work runs.**
- **node/look.ts:** a scene and an accent for each, moving while it works (`LOOK`): the Thatcher thatches a roof course by course from the eaves up, patting each down with the leggett ("Mending the roof"); the Reckoner slides counters across a counting board ("Taking stock"); the Weigher's balance tips as a load drops into one pan, swings and settles level ("Weighing"); the Shepherd's crook walks a sheep the other way from the Pinder's, into a stone fold where another waits ("Bringing them in"). The sheep is now one drawing (`sheep`) the Pinder's and the Shepherd's share. Until now each showed the cog every agent without a look has.
- **node/work.ts:** their lines in Where its work runs (`WORK`): what each round does, on what, and how often. The Weigher has no model work, and says so.
- **What an agent must do:** nothing. The four take theirs with this kit.

### Before you update

Nothing: it updates itself as usual.

## 2.36.1

**GenieX 0.8.0 is the NPU's server on a Snapdragon.** spec/npu-vendors.json's qualcomm route pins GenieX 0.8.0's installer (`geniex-cli-setup-windows-arm64-v0.8.0.exe`, 65,196,910 bytes, SHA-256 `fcc4d932…1ec734`, as GitHub publishes it) in place of 0.7.0's. Its install arguments, its `serve` arguments and the model (Qwen3-VL-4B-Instruct W4A16, every pinned file unchanged) stay as they were.
- **Run on real hardware** (the Snapdragon X2 Elite, 2026-10-07, the Smith's first scout try): the silent per-user install over 0.7.0, the test request (chat and vision) on the route's own arguments and on the PC's configured entry, and the pinned model files under it. spec/NPU-VENDORS.md says so.
- **The quirks stay as measured on 0.7.0** (`prefix-leak`, `image-path`, the keepalive notes): 0.8.0 answered the test with them on.
- **What an agent must do:** nothing. Setup installs 0.8.0 on a PC whose NPU isn't set up yet; a PC with 0.7.0 keeps it until the person tries 0.8.0 from the Smith's New for your NPU, or sets the NPU up again.
- **Its tests:** kit/test/npu-vendors.test.ts names 0.8.0's installer.

### Before you update

- Nothing: it updates itself as usual. This kit comes after 2.36.0; 2.33.0 (Steward 0.19.4) is still to be released and doesn't depend on it.

## 2.36.0

**Castellan's staff releases are published only where the Exchequer's publisher key is.** On 2026-10-07, 12 staff releases reached the public releases repository and never the Exchequer. They were published by a release run outside the PC that releases Castellan, which has no publisher key, and kit 2.35.0 let such a release go to GitHub alone with just a line saying so.
- **node/release.ts: `publishTo`** first checks the publisher key when there is a releases repository (Castellan's own agents) and the agent isn't Manor or Heiward. Without the key, it publishes nothing: no GitHub release, in the releases repository or the agent's own, and no Exchequer call. It says why ("Not published: <id>-v<version> is Castellan's, and its releases go through the Exchequer, but this PC has no publisher key …") and exits 1. That covers a Steward from before 0.19.0 that still releases to the releases repository, another PC's Steward, and a release run by hand.
- `PublishSteps.keyMissing()` is new: where the key was looked for when it isn't there, else null (exchequer.ts `publisherKey`). The key itself is never read into a line.
- Unchanged: with the key, everything is as in 2.35.0. Manor and Heiward publish to GitHub as before with or without it. An agent with no releases repository (anyone else's) publishes to its own repository as before.
- **spec/RELEASES.md** says so.
- **What an agent must do:** nothing. Its next release, made by the Steward on the PC that releases Castellan, has the key.

### Before you update

- Nothing: it updates itself as usual. Publishing a staff release by hand now needs the publisher key on that PC (`%USERPROFILE%\.steward\exchequer-publisher.key` or `EXCHEQUER_PUBLISHER_KEY`).

## 2.35.0

**A release of an agent Castellan sells goes to the Exchequer, and no longer to the public releases repository.** Castellan's paid agents are served by the Exchequer alone. Their releases were also going to GitHub's public releases repository, where anyone could download them.
- **node/exchequer.ts: `saleOf(id)`** is new. It reads the Exchequer's public agents list, where each agent has `forSale` (Exchequer 0.6.0):
  - `true`: for sale.
  - `false`: not for sale (Manor, Heiward, the agents held back from sale), or not listed at all.
  - `null`: the Exchequer couldn't say. It didn't answer, or its answer has no `forSale` (an Exchequer from before 0.6.0, or one whose database isn't migrated yet).
  - It never throws. `reachedExchequer(outcome)` is new too: published, or there already.
- **node/release.ts: `publishTo(release, steps)`** now decides where `--publish` goes. With a releases repository (Castellan's own agents):
  - **For sale:** the Exchequer first, from the files just built, then `v<version>` in the agent's own repository, and never the releases repository. It's refused when the agent's own repository already has the version. If the Exchequer doesn't take it (it's down or refuses, or this PC has no publisher's key), the release goes to the releases repository as before, so it's never missing everywhere. The Exchequer's line stays a note.
  - **Not for sale, unknown, or the Exchequer can't say:** exactly as before. The releases repository, then the agent's own, then the Exchequer too, so an agent held back from sale is already there when it goes on sale.
  - Without a releases repository (anyone else's agent), nothing changes. The exit code is still GitHub's.
- **`npm run release -- --exchequer`** takes the release from the releases repository, else from the agent's own `v<version>` (where an agent for sale has it).
- **spec/RELEASES.md** says so.
- **What an agent must do:** nothing. Its next release follows the Exchequer's list. Until the Exchequer says `forSale`, every release goes to GitHub as before.

### Before you update

- Nothing: it updates itself as usual. Agents for sale stop appearing in the public releases repository once the Exchequer 0.6.0 is deployed with its migration applied. Until then, releases go there as before.

## 2.34.0

**An agent's rounds never stop silently.** On 2026-10-07 the Chamberlain finished no round for 18 hours. Nothing had hung: it declared a mail source `required`, so `every()` skipped each round, documents too, and a skipped round wrote nothing, so it looked like an agent that had stopped.
- **node/schedule.ts: a held round is recorded.** A scheduled round held for the agent's required settings still runs nothing, but writes its round.json entry each interval with `"ok": null` and `"waiting": "<what>"` (needsSettings' text), and `RoundState.waiting` (in /api/ping's `rounds`) says the same. Run now is still refused while it waits.
- **node/schedule.ts: a time limit on every round.** A round that runs past `timeoutMs` (new in `every()`'s options, a number or a function; else `roundTimeLimit(everyMs)`, three intervals and at least two hours) is let go. Its job's signal is aborted, it is recorded with `"ok": false`, `"timedOut": true` and an error saying so, and the next round is scheduled, which tries again. A hung await can no longer stop every round after it. If the job let go ends later, the log says so and nothing else changes. `RoundTimeout` is new.
- **The job is handed `{ signal }`** (`every(everyMs, ({ signal }) => …)`): a job that can stop when asked passes it on (fetch, child processes). One that ignores it simply isn't waited for after the limit.
- **`required` is only for an agent that can do nothing at all without the setting** (node/onboarding.ts, required.ts). A setting that only part of the work needs goes in `settings` alone, and the page says what it adds: one missing setting must not stop the work that doesn't need it.
- **spec/ROUND.md** documents `waiting` and `timedOut`.
- **What an agent must do:** nothing. A job that takes no arguments works as before. An agent whose rounds can rightly run longer than three intervals and two hours passes its own `timeoutMs`. An agent with `required` checks that it can truly do nothing without it; only the Developer Herald has one (its feeds), and it can't.

### Before you update

- Nothing: it updates itself as usual. This kit comes after 2.33.0 (Steward 0.19.4); if 2.33.0 isn't released yet, release it first.

## 2.32.1

**The kit names the app the person bought: Castellan.** Where the kit tells a person to open or use the app, it says Castellan, not Manor. Only words change.
- **core/messages: `NOT_SET_UP`** (and `REEVE_NOT_SET_UP`, the same) is "Local AI isn't set up on this PC yet: open Castellan and choose Set up local AI". `say.gpuSetAside` says "Castellan's Settings: …". spec/accelerator-vectors.json carries the new words.
- **node:** the on-duty badge's tooltip says "Castellan's Stop pauses them" (page.ts); a hire's release notes say "Castellan installs and updates it by itself" (release.ts); the keeper's log says Castellan's Settings keep the graphics card out (keeper.ts); the Aletaster's and the Surveyor's work lines name Castellan (work.ts).
- **Unchanged:** "Back to <manor>" says the manor's name, and Castellan when it has none, as 2.32.0 made it; identifiers, paths, environment variables and the in-story "manor" stay as they were.
- **What an agent must do:** nothing. No agent's tests compare the kit's old words through the kit (checked on every agent's main): the Auditor's test/auditor.test.ts (lines 698 and 700) writes the old sentence out itself, as its own input, so it still passes; its README says "open Manor and choose Set up local AI" too, which it may want to update.

### Before you update

- Nothing: it updates itself as usual.

## 2.32.0

**A release goes to the agent's own repository, and to a releases repository only where one is named.** `npm run release -- --publish` used to publish every agent to one built-in releases repository as well as its own, so an agent built on the kit by anyone else failed its first release. The releases repository is now read when a release is published, never built in.
- **node/release.ts: `releasesRepo(env?, home?)`**, new, replaces the `RELEASES_REPO` constant: `MANOR_RELEASES_REPO` when it is set (the Steward sets it for every release it runs, from Steward 0.19.0: its Settings' releases repository on the PC that releases Castellan itself, else empty); for a release run by hand, the Steward's settings on this PC (`STEWARD_HOME`, else `%USERPROFILE%\.steward\settings.json`: `releasesCastellan` and `releasesRepo`); else none.
- **With none**, `--publish` publishes `v<version>` in the agent's own repository only, and refuses a version that is already released there. With one, it publishes there as `<id>-v<version>` and in the agent's own as before. Either way, once GitHub has it, the Exchequer gets the same files (kit 2.30.0), and `--exchequer` takes them from the releases repository, or with none from the agent's own `v<version>`.
- **gh is found on PATH only.** node/release.ts and node/manor.ts no longer look in a folder of one particular PC. Without gh on PATH, `--publish` says: gh isn't installed: install GitHub CLI, then run gh auth login.
- **What an agent must do:** nothing. On the PC that releases Castellan, the Steward's settings name the releases repository it always published to, so every release, by the Steward or by hand, goes where it went before. An agent that imported `RELEASES_REPO` calls `releasesRepo()` instead.
- **A Steward from before 0.19.0** has no `releasesCastellan` in its settings yet (it writes it once it updates). Until then `releasesRepo()` gives the releases repository that Steward always published to, so an agent that takes this kit before its Steward updates still releases where every Manor looks. A new Steward writes `releasesCastellan: false` on its first read, so no one else's PC takes that path.
- **"Back to <manor>" says Castellan when the manor has no name** (node/manor.ts, react/tour.tsx). The title bar's link, and the tour's last step when Manor opened it, say the name in Manor's settings, as before; with none (or a blank one, or settings it can't read) they say **Back to Castellan**, not "Back to Manor": Castellan is what the person bought. `MANOR_DEFAULT_NAME` is new (node/manor.ts); `Tour` takes `manorName`, which the kit's `Page` passes from the shell. **What an agent must do:** nothing, unless it expects `manorLink()`'s name to be "Manor" with no name set: it is "Castellan" now (labelled `kit:breaks-agents`). Reeve does: its test/manor-theme.test.ts expects "Manor" from the kit's reader, and its own `MANOR_DEFAULT_NAME` (src/manor-theme.ts) and `whereIsManor` (src/manor.ts) say "Manor" too.

## 2.31.0

**Local AI on every Copilot+ NPU, installed by setup: Qualcomm Snapdragon, Intel Core Ultra and AMD Ryzen AI.** The owner's call: Snapdragon-only was a deal breaker. The NPU is now found by the Neural processor class whatever its maker, setup installs its maker's model server and models with a pinned SHA-256 and writes its entry only after a test request, and the accelerators move to a folder Manor owns, so a household gets working AI without Reeve. spec/NPU-VENDORS.md says which server each maker gets, why, and what is still unverified on hardware.
- **node/npu-vendors.ts and spec/npu-vendors.json are new.** The routes, as data: Qualcomm's GenieX 0.7.0 (chat and vision on one Qwen3-VL-4B), Intel's OpenVINO Model Server 2026.4.1 (chat on Qwen3-4B INT4), AMD's FastFlowLM 1.0.7 (chat and vision on Qwen3-4B-Instruct-2507 and Qwen3-VL-4B, XDNA 2 only). Each has its pinned download (URL, size, SHA-256), how it installs (GenieX's installer per user and silent; the others unpacked into the tools home), its port (18181, 18183, 18184), its start arguments and environment, its models, caps, timeouts, quirks and licences, and per generation whether it is supported and verified. `npuVendorOf`, `npuGeneration`, `npuSupport` (supported, or why not: an unknown maker or generation, AMD's first XDNA, a driver older than the server needs, the wrong processor for its build), `planNpu`, `npuEntry`, `routeEnv`, `checkPinned` (a pulled model's files against their pinned SHA-256s: the X2 Elite's Qwen3-VL-4B is pinned).
- **node/detect.ts: vendor-neutral detection, as Heiward's NpuHardware.cs.** DETECT_PS lists the ComputeAccelerator class with its maker, PnP id and driver (`npu2|…`), and falls back to the Hexagon driver. `Detection.npu` is a `DetectedNpu`: as before, plus `manufacturer`, `deviceId`, `vendor`, `generation`, `label`, `supported`, `why`, `verified`. `parseNpus(text, arch)` is new. An NPU the manor can't use is still an NPU in hardware.json.
- **node/setup.ts: the NPU first, then the cards, then the processor.** `planSetup` plans the NPU's server and models (`SetupPlan.npu`, or `npuNote` saying why not) unless a person configured the NPU (asking for `npu` by name sets it up again), counts them in the download it asks about, and with no graphics card sets the processor up for embeddings when the NPU chats (none of the NPU servers makes embeddings). `runSetup` sets the NPU up first (`setUpNpu`: download and check, install, pull, check the pinned files, then `testNpuEntry`, a chat and a vision answer in the NPU's turn), and writes its entry only when all of it worked. `SetupIo` gains `run`, `exists`, `testNpu` and `hash` (`NpuIo`); `PlanInput` and `SetupOptions` take `env`. The install's GenieX default is dropped on a PC whose NPU the manor can't use too. The report shows the NPU's maker, generation and why it isn't used.
- **The accelerators' own folder, Manor's** (node/accelerators.ts, accelerator-config.ts). `acceleratorsHome()` (`%USERPROFILE%\.manor\accelerators`, `MANOR_HOME`'s, or `ACCELERATORS_HOME`), `acceleratorConfigFile()` (its config.json; `ACCELERATORS_CONFIG`, `REEVE_CONFIG` and a scratch `REEVE_HOME` as before), `legacyConfigFile()` (Reeve's, when it's another file), `readableConfigFile()` (agents read theirs, else Reeve's until it moves). `migrateAcceleratorConfig()` copies the accelerators' keys out of Reeve's config.json once, word for word, never changing Reeve's file; `readConfigFile` does it on first read. `writeConfigFile` mirrors the keeper's keys back into Reeve's file while it's there (`mirrorToLegacy`), for agents on an older kit. `loadAccelerators()` reads `readableConfigFile()`. `toolsHome()` is the accelerators' folder, except on a PC whose builds or models are already in `.reeve`. The locks and shared files stay in `.npu-agent`, where Heiward's released builds look.
- **The keeper never stops a program for its port alone** (node/keeper.ts, a safety fix). An orphan is stopped only when it is the manor's own (`manorOwns`): its program in the manor's servers folders (`manorServerDirs`), or a record that the manor started that very process (accelerators.ts' `noteStarted`, `readStarted`: `started.<pid>.json` beside the failure markers, written by every start). A person's own GenieX on 18181, another program's server, or one whose program Windows won't name is left alone; `sameProgram` no longer matches an unreadable path. `ReaperDeps.owned` is new, and without it nothing is an orphan. The keeper reads OpenVINO Model Server's `--rest_port` and FastFlowLM's `--port`, and recycles GenieX alone.
- **core: per-kind caps, an accelerator's own timeouts, a server's environment.** An endpoint may carry `maxContextTokens` (`capFor(a, work)`, used by `candidates` and `tooBig`) and `env` (set over the starter's when it starts its server: accelerators.ts' `serverEnv`); an accelerator may carry `timeouts` (`requestBaseMs`, `requestPerTokenMs`, `coldLoadMs`), which `requestTimeoutMs` takes in place of the rules'. accelerator-config.ts reads and checks them.
- **The not-set-up message points to Manor.** `NOT_SET_UP` (and `REEVE_NOT_SET_UP`, the same) is "Local AI isn't set up on this PC yet: open Manor and choose Set up local AI". The other messages say "the accelerators' config" for "Reeve's config".
- **spec:** NPU-VENDORS.md is new; ACCELERATORS.md says where the accelerators are kept now and how they moved, the NPU servers, the new fields, `started.<pid>.json`, and that the keeper stops only its own.
- **What an agent must do:** nothing in its code, unless it reads `.reeve\config.json` itself (Reeve does, in his own change), calls `Reaper` with its own deps (give it `owned`), or builds `Detection` by hand (it has more fields). An agent with its own "set Reeve up" words should point to Manor's Set up local AI instead.
- **Its tests may need to change** (labelled `kit:breaks-agents`). This kit, tried on every agent's main, fails two, both for their own changes: **Reeve** (test/install.test.ts builds a `DetectedNpu` by hand, which has more fields now; test/setup.test.ts expects detection's old NPU shape and the old "the NPU runs GenieX" problem) and **the Smith** (test/smith.test.ts's fake detection, the same). The other agents pass: their tests hand the old not-set-up words to their own fakes, and none compares them with the kit's. Their READMEs and those fixtures still say "Reeve isn't set up here", and the Auditor, the Chamberlain and the Clerk keep their own copies of "in Reeve's config.json" in their code: words to bring up to date, not failures.

### Before you update

- The accelerators move from Reeve's `config.json` to `%USERPROFILE%\.manor\accelerators\config.json` the first time the Smith (or Reeve's keeper) reads them after updating: a copy, word for word, and Reeve's file is left as it was. Nothing to do.
- On a PC whose NPU isn't set up yet, the Smith's or Manor's Set up now offers its maker's server and models (several GB) and asks first.

## 2.30.0

**A release is published to the Exchequer, Castellan's release service, as well as to GitHub.** Castellan sells the staff by subscription, and the PCs whose licence covers an agent will download its releases from the Exchequer (https://api.castellan-software.com). GitHub's releases repository stays where every Manor looks for now; publishing there ends later, once Manor takes the staff's releases from the Exchequer.
- **node/exchequer.ts is new: `publishToExchequer(release, { env?, home?, fetch? })`.** With the files a release published on GitHub (the zip, SHA256SUMS.txt, and manor-agent.json when the agent announces itself, which also goes as the draft's `announcement`), it asks the Exchequer which agents it sells (`GET /api/v1/agents`, public), makes a draft (`POST /api/v1/publish/<id>/<version>` with each file's name, size and SHA-256, the commit and the notes), PUTs each file to the signed upload URL it hands back, and asks it to check them and publish (`POST …/done`). Its answer is one line and `ok`; it never throws.
  - **Only an agent the Exchequer sells:** Manor and Heiward never (`NEVER_SOLD`), nor an agent its list leaves out: "The Exchequer: heiward isn't sold there, so heiward-v1.7.2 is on GitHub alone."
  - **Only with the publisher's key:** `EXCHEQUER_PUBLISHER_KEY`, else `%USERPROFILE%\.steward\exchequer-publisher.key`, trimmed (`publisherKey`). Without one: "Not published to the Exchequer: no publisher key at … (or EXCHEQUER_PUBLISHER_KEY).", and nothing is asked of the Exchequer. The key goes to the Exchequer alone, as a Bearer token: never to the agents list or the storage the upload URLs point at, and never into a line (`withoutKey` takes it out, even when the Exchequer says it back).
  - **Where:** `EXCHEQUER_URL`, else https://api.castellan-software.com (`exchequerUrl`).
  - **Done again, it finishes:** a draft is made afresh and an upload replaces the file, and a release published there already (`409 already-published`, or `alreadyPublished` from /done) counts as published: "The Exchequer has porter-v0.4.26 published already."
- **node/release.ts:** `--publish`, once the release is in the releases repository (and the agent's own), publishes the same files to the Exchequer and prints its line. Whatever happens there, the exit code is GitHub's: an Exchequer that is down, refuses, or has no key on this PC never fails a release. Its failure says "Not published to the Exchequer: <why>. The GitHub release stands; npm run release -- --exchequer finishes it."
- **`npm run release -- --exchequer` is new:** the release the releases repository already has at package.json's version, published to the Exchequer from GitHub's own files (so the bytes are the ones every Manor checked), with its notes and the commit its release.json names. It builds nothing, and exits 1 when it didn't go.
- **spec/RELEASES.md** says so.
- **What an agent must do:** nothing. Its next release publishes to the Exchequer too, from the PC that has the publisher's key.

### Before you update

Nothing: it updates itself as usual. A PC that releases without the publisher's key publishes to GitHub alone, as before, and says so in a line.

## 2.29.0

**Every agent's page fits a phone: the title bar's action and wide tables no longer push the page sideways.**
- **node/page.ts, at 640px and narrower:** the title bar's tools wrap, so its action (Run now, Check the fingerprints now) goes under the status pill instead of off the side, and a long pill is cut with an ellipsis (its title says it all). A table in the page (`main.view table`) scrolls inside itself instead of the page: it is laid out as a block that holds the table, as GitHub shows tables. On seven agents' pages the title bar ran off the side, and on seven a table did.
- **What an agent must do:** nothing. One that wrapped its tables in its own scrolling box keeps working; a table narrower than a phone no longer stretches to its full width there.

### Before you update

Nothing: it updates itself as usual.

## 2.28.1

**Security fix: a value with curly quotes in it could break out of a PowerShell string.** Windows PowerShell ends a single-quoted string at the curly quotes ‘ ’ ‚ ‛ as well as at `'`, and `psQuote` doubled only `'`. A file name, folder or other text that an agent hands to PowerShell could end the string early and be read as code.
- **node/ps.ts: `psQuote` doubles every one of `'` ‘ ’ ‚ ‛** (`PS_SINGLE_QUOTES`, new), each with itself, which is how a single-quoted string holds one: PowerShell reads back exactly the text, curly quotes, `$( )` and backticks included.
- **node/keeper.ts:** the WQL filter for a model server's processes went to PowerShell in double quotes, where `$` and backticks are live. It now goes as a `psQuote`d literal, and the program's name in it is escaped as WQL escapes it (`wqlName`, new: a backslash before `\` and `'`).
- Tests run every quote, a profile like `O’Brien`, `$( )` and backticks through PowerShell, both as `-EncodedCommand` and as a script file, and check each comes back unchanged.
- **What an agent must do:** nothing, if it quotes with the kit's `psQuote`: taking this kit fixes it. An agent with its own copy of the rule (a `replace(/'/g, "''")` of its own, in TypeScript or in C#) should use `psQuote`, or double the curly quotes too.

### Before you update

Nothing: it updates itself as usual.

## 2.28.0

**Required settings: an agent that can't work without something from you waits for it, and onboarding asks for it.** The user's call: "each agent has designated which of its settings fields are required for the agent to operate... get the user to fill those out during onboarding... before the agent can begin", as the Chamberlain can do nothing until a mail account is set up.
- **node/onboarding.ts: `Onboarding.required`**, the settings among `settings` the agent can't work without: each entry a key that must be filled in, or a list of keys of which one is enough (`[['thunderbird', 'imapAccounts']]`: Thunderbird, or a mail account). New: `Required`, `requiredGroups`, `filled(v)` (a switch on, a number other than 0, text not blank, a list with something filled in it, a group by its `on`/`enabled` switch, else anything filled in it), `unmetRequired(o, values)` and `requiredText(keys, schema)` ("Thunderbird or Mail accounts"). `onboardingProblems` (agent-checks.ts) now says when a required key isn't one onboarding asks for, an entry names none, or a key is required twice.
- **node/required.ts is new.** It reads the agent's onboarding once as it starts (`AGENT_ONBOARDING`, moved here from react-page.ts, which imports it) and, with the settings serve() is given (`watchRequired`), says what is still missing: `needsSettings()`, `{ keys, text }` or null, read from settings.json each time, so a save lets the agent go at once.
- **node/schedule.ts:** while its required settings aren't filled in, `every()`'s rounds don't run, scheduled or asked for: `runNow()` returns false, and `nextRunAt` is null.
- **node/server.ts:** `/api/ping` says `needsSettings` (null when none), so Manor can show that a new hire waits for its settings.
- **node/page.ts and react-page.ts:** the status pill says **Needs settings** (its title what for) before Off duty; `PageShell.needs` carries it. **node/settings-kit.ts: `readSettings(spec)`**, the settings in use, as GET /api/settings reads them.
- **react/shell.tsx:** while it needs settings, a banner says **Waiting for its settings**, with **Fill them in**, which opens the tour at its settings step (`#/tour?step=settings`). After onboarding saves, the page's data is read again.
- **react/tour.tsx:** step 2 says what it can't start without ("Needed before it can start: …"), and its Next waits until it's filled in and saved; Skip still leaves, and the page's banner brings it back. `tourStart(hash)`: `#/tour?step=settings` (or `tour`) opens at that step.
- **What an agent must do:** nothing, unless it can't work without a setting: then name it in its src/onboarding.ts's `required` (it must be among `settings`). An agent with none behaves as before.

### Before you update

Nothing: it updates itself as usual.

## 2.27.0

**An accelerator's name is what the PC calls it, never a setting.** The user's call: "Just keep it what it's called, there's no reason for custom names." config.json's accelerators keep no `name`; every program names each one from what this PC is, the same way.
- **core/accelerators.js: `acceleratorName(kind, id, hw)`**, the rule: the NPU's name as Windows lists it, a card's as DXGI describes it (" #2" on a second card of a name), found by its id, and the processor's, all from hardware.json, each shown as Manor shows it (core/ids.js' new `deviceName`): (R), (TM) and (C) taken out and spaces collapsed, a "<chip> - <part number> - <model>" name only its model, and no last "NPU", "CPU" or "GPU" (its kind says it): "Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU" is "Qualcomm Hexagon", "Qualcomm(R) Adreno(TM) X2-90 GPU" is "Qualcomm Adreno X2-90". A card's id doesn't change: it is still made from its DXGI name as given (`gpu-qualcomm-r-adreno-tm-x2-90-gpu`), so lock folders and configs keep theirs, and hardware.json's cards keep that name. Without one, the kind's (`LEGACY_NAMES`: "NPU", "Graphics card", "Processor"). `parseAccelerators` and `readConfig` name every entry, an older config's too, by it, and ignore a `name` in the file.
- **hardware.json gains `npuName` and `cpuName`.** `npuName` (with `"npu": true`) is the NPU's device name in full, (R) and (TM) taken out and its spaces collapsed: "Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Hexagon NPU" (shown as "Qualcomm Hexagon"), where detection used to shorten it to "Snapdragon X2 Elite Extreme NPU" (node/detect.ts' `npuName`, `hardwareOf`). `cpuName` is the processor's. node/accelerators.ts' `Hardware`, `readHardware` and `rememberHardware` carry both. The keeper's `refreshHardware` asks again at once when hardware.json says there's an NPU but not its name, and after an hour when it lacks the processor's, so a PC doesn't wait a day for its names.
- **The no-NPU rule:** an entry listed as the NPU on a PC known to have none takes the id and name of what runs it (its one card, "Graphics card" when there are several, the processor), whatever the entry carried (`notTheNpu`).
- **node/accelerator-config.ts:** `readAccelerator(v, hw?)` and `legacyAccelerators(raw, hw?)` name from `hw` (the kind's name without it); `readAccelerators` passes its hardware.json down. `validateAccelerators` no longer asks for a name. `AcceleratorEntry` (an accelerator as config.json keeps it, without its name), `entryOf(a)` and `withoutNames(raw)` are new; `writeConfigFile` and `saveConfig` write no name, so an older file's go at its next save.
- **node/setup.ts:** `acceleratorEntry` writes no name (`EntryInput` has none) and returns an `AcceleratorEntry`; `mergeEntries(raw, entries)` drops the names an older list has and takes no `npuName`; `runSetup(plan, raw, io)` takes no `npuName` either. The entries setup hands back are still named, as acceleratorName shows them; so are node/detect.ts' `detectedAccelerators`.
- **spec/ACCELERATORS.md** says so; accelerator-vectors.json's configs may carry `hw` (hardware.json's content), with cases for names from the PC and for the no-NPU rule.
- **What an agent must do:** nothing in what it does, unless it lets a person edit an accelerator's name: then it stops (the Smith's Settings page does in its own change). An agent with its own copy of the naming rule should take the kit's `acceleratorName` instead. One that calls `mergeEntries`, `runSetup` or `acceleratorEntry` itself drops the name and npuName it passed.
- **Its tests may need to change** (labelled `kit:breaks-agents`: the kit's trial fails these five). A test that writes a `name` into config.json's accelerators and expects it back now gets the kind's ("the NPU", "the graphics card", "the processor"), because the name is ignored. Either expect that, or give the test a hardware.json (`{ npu, cards: [{ name, memoryGb }], npuName, cpuName }`, passed to `readAccelerators`/`parseAccelerators` or written beside the locks) and expect the name as `deviceName` shows it: "Snapdragon X2 Elite - X2E88100 - Qualcomm Hexagon NPU" is "Qualcomm Hexagon", "Qualcomm(R) Adreno(TM) X2-90 GPU" is "Qualcomm Adreno X2-90".
  - **Clerk** (test/clerk.test.ts: the vision models' line, re-ranking on a card, and one more): "on the Snapdragon X2 Elite NPU" and "on the NVIDIA GeForce RTX 4090" come out as "on the NPU" and "on the graphics card".
  - **Chamberlain** (test/semantic.test.ts, the Ask line): the same, "on the NPU" and "on the graphics card".
  - **Manor** (test/npu.test.ts: a two-slot card's holders, and a card's name from detection): a card named only in config.json is "Graphics card", not that name.
  - **Reeve** (test/setup.test.ts, test/accelerators.test.ts): its copies of the kit's setup tests call `runSetup` and `mergeEntries` without the npuName, and no longer expect "name is missing". Reeve#80 does it.
  - **Smith** (test/smith.test.ts, the Settings section): the names are listed read-only, by `deviceName`. Smith#21 does it.

### Before you update

Nothing: it updates itself as usual. A name written in config.json is ignored from now on, and taken out the next time the file is saved. The NPU and the processor go by their model ("Qualcomm Hexagon", "Qualcomm Oryon") from the keeper's next look.

## 2.26.0

**The kit names no one's GitHub account, private repository or folder.** It runs on every PC that hires an agent, and the manor is for that PC's owner: their repositories are the ones it looks after, and nothing in it may hand out the maker's (the user's rule). The public releases repository, where every PC downloads from, stays; so do the developer tools.
- **node/manor.ts: `MANOR_REPO` is gone.** `manorOwn()` no longer counts a built-in repository as the manor's own, nor a built-in folder as the Steward's checkout: only what this PC's Manor and Steward name (staff.json, agents.json, the Steward's settings and staff table). A project's example path in its message is a neutral one.
- **node/release.ts: manor-agent.json names no repository.** `release.repo` is optional and best left out: Manor finds every release in the public releases repository by its id (`<id>-v<version>`), and the name would be published there. One still given must be origin's, as before, until it's taken out; the message says to leave it out.
- **spec:** each page's home is said without a link into a private repository, and the accelerator page no longer cites a private issue.
- **What an agent must do:** take `release.repo` out of its manor-agent.json once Manor finds releases by id alone. Nothing else.

### Before you update

Nothing: it updates itself as usual.

## 2.25.0

**The rest of the settings audit's shared helpers, and a tour that fits the page it's on.** One round interval, one plain-words notes switch and one model-call limit with the same key and words in every agent; the folders Windows keeps, wherever OneDrive moved them; a list kept with buttons on the page; and a tour that can take a new hire back to Manor and walks only the parts of the page that are there.
- **node/shared-settings.ts is new: the settings agents share.** `roundEveryField({ min, max, default })` is `roundEvery`, minutes between rounds, always under Advanced, with the agent's bounds; `readRoundEvery(raw, bounds, { was?, problems? })` reads it in the normalizer, taking it over from the agent's older key (`was: { key: 'everyHours', minutes: 60 }` for one in hours); `roundEveryMs(() => settings, bounds)` hands it to every(), read at each wait. `plainNotesField()` is `plainNotes`, the plain-words notes switch, on the page, and `readPlainNotes(raw, fallback, { was? })` reads it. `modelCallsField({ max, default }, { unit? })` is `modelCallsPerRound`, under Advanced, 0 allowed, and `readModelCalls(raw, bounds, { was?, problems? })` reads it. Token sizes are no setting: a piece is the client's `budget(answerTokens)` (npu.ts), from the accelerators that would serve it.
- **node/folders.ts is new: `knownFolders()`**, this PC's Desktop, Documents, Downloads, Pictures, Music, Videos and Screenshots, from the registry's User Shell Folders (where OneDrive's folder backup moves them), the usual places in the home folder for the rest, and the OneDrive folder; read once. `foldersFrom(regOutput)`, `parseShellFolders` and `uniqueFolders` are its parts, for tests and for agents that list candidates. It is the Clerk's resolver, widened.
- **react/lists.tsx is new: `OnPageList`**, a list a person keeps with buttons on the page (what they trusted, ignored or put off), each entry with a Remove that posts `{ id }` (or `field`) to the agent's `remove` path and reloads the page; the count in its heading, an empty note when there's nothing. For lists a button maintains, which no longer belong in Settings.
- **react/tour.tsx: `#/tour?from=<url>`.** Opened from Manor's hire flow with the role's card as `from` (encoded), the last step offers Back to Manor beside Done. Only an address on this PC is followed (localhost, 127.0.0.1, [::1], a *.localhost name; `tourFrom(hash)`). Without one, Done closes the tour as before.
- **react/tour.tsx: only the parts on the page are walked.** Step 3 works out its steps from the `data-tour` parts on the page as it starts (`onPage()`), after step 2's save, so a page that differs by its settings (the Herald's sections by variant) keeps one static ONBOARDING; "Step n of m" counts only those, and with none, the settings are the last step.
- **/api/ping: `tour`**, whether the agent's page has a tour at #/tour (a React page and an onboarding; react-page.ts's `hasTour()`), so Manor's hire flow offers Take the tour only where it works.
- **node/manor.ts: notify times are read exactly as Manor reads them.** A time with spaces around it (" 07:00") is no longer trimmed: like "7:00", it falls back to its default, so an agent and Manor never disagree about the quiet hours.
- **node/work.ts:** the Herald's "Where its work runs" describes today's Herald (its sources by variant, at most 6 summaries a round); the developer Herald has its own entry, `developer-herald`, with the old lines, and its own look (node/look.ts): the Herald's trumpet in violet, "Reading release notes" while busy.
- **What an agent must do:** nothing. Moving an agent's interval, notes switch and model-call limit onto the shared keys (its normalizer taking the old key over), and its folder defaults onto `knownFolders()`, is each agent's own change.

### Before you update

Nothing: it updates itself as usual.

## 2.24.0

**What every agent asked Manor, its owner or GitHub for by hand, from the kit.** The settings audit (the user's call: fewer settings) found agents asking the person for what the PC already knows: another agent's address, the GitHub owner, and, soon, when to notify. These are the first of its helpers; the round interval, the plain-words notes switch, the model calls per round, the known folders and the on-page list follow in 2.25.0.
- **node/manor.ts: `agentUrl(id, { dev?, home?, staffFile? })`**, another agent's page, from its `home` in Manor's agents.json, else its staff.json, with a trailing slash; with `dev`, its development checkout's, on its port + `DEV_PORT_OFFSET` (10000, as every app.ts and Manor's settings.ts place one). Null when Manor doesn't know the agent. Read afresh: never keep an agent's address in settings.
- **node/manor.ts: `githubOwner()`**, the GitHub login gh is signed in as on this PC, from gh's config without the network, else GitHub through gh; kept once known, asked again after ten minutes when not. Null without gh or a sign-in. For defaults that would otherwise name someone: they start empty and mean this.
- **node/manor.ts: the manor's notification preferences.** Manor's settings.json gains `"notify": { "on": true, "quietFrom": "22:00", "quietTo": "07:00" }` (Manor's Settings page; the user's call: one switch and quiet hours for every agent, none of its own). `notifyPrefs()` reads it afresh (`NotifyPrefs` {on, quietFrom, quietTo}; quiet hours null when there are none), null without an installed Manor or one that doesn't say; `mayNotify(now = new Date())` is whether an agent may notify the owner now (on, and outside the quiet hours, which may span midnight), always true without Manor's say; `notifyAllowed(prefs, now)` is the same for preferences in hand. A wrong field falls back to its default (`NOTIFY_DEFAULT`), and equal times mean no quiet hours, as Manor's panel has it.
- **node/settings-kit.ts: `applies` gains `'reinstall'` and `'admin'`**, beside `'restart'`, for a setting saved but only used when the agent is next installed or updated (written into a scheduled task, say), or only when installed as an administrator. The Settings form (React, and settings-panel.js) marks each with its note, `APPLIES_NOTE`, and a save says it for each such setting it changed.
- **What an agent must do:** nothing. Dropping a setting these answer, and marking settings `reinstall` or `admin`, is each agent's own change.

### Before you update

Nothing: it updates itself as usual.

## 2.23.0

**Settings in React, and short; and a new hire's tour of its page.** The kit's React Settings form replaces settings-panel.js on a React page, and a page that is one long column of every setting becomes a short one: the user asked for fewer, shorter settings. Onboarding is new: Manor starts empty, and each employee a person hires walks them through three steps on its own page.
- **react/settings-form.tsx is new: `SettingsForm`**, from GET /api/settings and saving the changed values with POST /api/settings, as settings-panel.js does, field for field and class for class (web/settings-panel.css styles both): every field kind (switch, whole, number, text, choice, choices, list, records, group, map, read-only), each field's default with Reset to default, "changed" until saved, each message from the server beside its field, Save, Cancel, Set every field to its default, and a warning before leaving with unsaved changes. Its controls are the react part's (Switch, Button). **Shorter:** each top-level group is a section of its own, folded unless it's the only one, with a row of jump links at the top when there are two or more; the advanced settings come last, folded under Advanced (a group's own advanced fields fold inside it); and a message under a folded field opens it. A record is a table row only while it is a few plain fields (at most four, none advanced); any other folds to one line, its title, opening on a click, with its own advanced fields folded inside it: the Steward's employees, the Aletaster's projects and the Surveyor's agents become a list of names. `keys` limits it to a few: onboarding's, where a `shownWhen` is followed live (picking the Herald's variant shows the settings that variant has, on the same step).
- **node/settings-kit.ts's schema: two new field properties.** `advanced: true`: seldom changed, so folded under Advanced, and never in onboarding. `shownWhen: { key, is }`: shown only while another top-level setting holds one of those values (as text: a switch is "true" or "false"), as the Herald's `stocks` for its general and financial variants. A hidden field keeps its value and is still saved, and a message about it shows it anyway. react/settings-values.ts is new: the form's value rules (`canon`, `same`, `words`, `blank`, `tidy`, `shownNow`), which are settings-panel.js's.
- **node/onboarding.ts is new: `Onboarding`** (`intro` {title, text}; `settings`, the keys only the person can choose on day one, at most `ONBOARDING_MAX_SETTINGS`, 3, never an advanced one; `tour`, steps by data-tour name) and `onboardingProblems`. An agent keeps it in src/onboarding.ts as `ONBOARDING` and passes it to `pageShell({ onboarding })`; **node/agent-checks.ts checks it** when it's there.
- **react/tour.tsx is new: `Tour`**, which `Page` draws at #/tour from the shell's onboarding, so an agent writes no tour of its own: (1) what the role is, (2) its few settings in the Settings form, or that the defaults just work, (3) its page, part by part, each part brought into view and outlined beside a card saying what it is. Skip or Done goes back to the page. Manor's hire flow opens a new employee's page at #/tour.
- **react/shell.tsx:** the Settings view is the React form (drawn again after onboarding saves). The legacy panel is no longer loaded on a React page; string-built pages keep settings-panel.js.
- **What an agent must do:** nothing, unless it has a React page: it gets the new form by itself. Marking settings `advanced` or `shownWhen`, and writing src/onboarding.ts, is each agent's own change.

### Before you update

Nothing: it updates itself as usual.

## 2.22.0

**The react part's components are GamerNexus's UI kit, in the manor's look.** The user's call: the kit's React components keep GamerNexus's mobile UI kit API (apps/mobile/components/ui: names, props, variants, behaviour) rather than a design of their own, drawn with the manor's themes and page.ts's classes. GamerNexus's are React Native, so these are written for a page; where its prop names have a web meaning they are kept (`onPress`, `onChangeText`, `onValueChange`, `icon` by Ionicons name).
- **react/ui.tsx:** `Text` (title, heading, body, muted, label), `Card` (a button with `onPress`), `CardFooter`, `Section` (title, icon or `leading`, `count`, `right`, `gap` md or lg), `DetailRow`, `Button` (primary, secondary, ghost, danger, danger-quiet × sm, md, lg; `loading`, `disabledLook`, `icon`, `leftIcon`; `tooltip` is the web's title, since GamerNexus's `title` is the label), `IconButton`, `Badge` (GamerNexus's nine tones: neutral, info, success, premium, caution, danger, night, subscription, host, on the manor's colours), and the manor's own `Notes` and `PostButton`, now a `Button` (`title`, `variant`). **Changed:** `Badge` takes `label` and `tone` (it took children and `kind`), `PostButton` takes `title` and `variant` (children and `quiet`), and `Muted` is gone: `<Text variant="muted">`.
- **react/forms.tsx is new:** `Input` (label, error, `clearable`, `busy`), `Select` (the browser's own list; GamerNexus opens a sheet on a phone), `Switch`, `ChoiceGroup` (row, wrap, stack), `Segmented`, `SaveStatus`: what the schema-driven Settings form and onboarding's settings step are built from.
- **react/feedback.tsx is new:** `Loading`, `ErrorNote` (with Try again), `EmptyNote`, `QueryView` (data first, else the error, else offline, else loading, else empty), `Toast`, `ModalCard`.
- **react/icons.tsx is new:** `Icon` (the glyphs the components use, by their Ionicons names) and `Spinner`. **react/styles.ts is new:** `UI_CSS`, which `Page` puts in the page once, every colour a theme variable.
- **What an agent must do:** nothing, unless it has a React page: then `Badge`, `PostButton` and `Muted` as above. The Steward's is done.

### Before you update

Nothing: it updates itself as usual.

## 2.21.0

**A page drawn in the browser, with React: the kit's react part.** The first step of the manor's move to React and TypeScript. An agent's page can be React components in the browser rather than HTML written in strings on the server; the Steward's page is the first. Nothing changes for an agent that doesn't take the part.
- **react/ is a new part** (kit.json's `"react"`, which brings node and web; it lands in src\kit\react\). **react/shell.tsx:** `Page`, the kit's frame, element for element and class for class as page.ts draws it, so page.ts's CSS styles both: the title bar (back to the manor, the agent's icon, name and role, its scene, the status pill, Settings, the Theme menu, and the agent's own `action`, such as Run now), the off-duty notice with Back on duty, the Settings view at #/settings (the Settings panel, still web/settings-panel.js, placed once and left to itself; and "Where its work runs"), and the footer. Also `ThemeMenu` and `mount`. **react/ui.tsx:** `Badge`, `Muted`, `Card`, `Notes` and `PostButton` (a POST with the page's token: it asks first with `confirm`, says an error or the server's `message`, then looks for news), the markup every agent wrote out by hand. **react/page-data.ts:** `usePageData` (the page's first data, then /api/page every 3 s while busy, every `refreshSec` otherwise, after each button, and when /api/ping, asked every 5 s as 2.20.0's pages ask it, says a round started or ended: no reloads, so a ticked box or a scroll stays), `post`, `pageToken`, `roundState`, and the `PageShell` type. **Room for the onboarding tour:** `Page`'s `tour` is drawn over the page at #/tour (`useRoute`), and the frame's parts are named for it with `data-tour` (titlebar, status, settings, theme, action, settings-panel, work); `Card`'s `tour` names an agent's own sections. Accelerators are named only from the server's data (pageShell's "Where its work runs"), never by the react part itself. **react/time.ts:** `ago`, as page.ts's says it, and `useNow`. **react/index.ts** exports them all.
- **node/react-page.ts is new:** `pageShell()` (the frame's data: the pill, the scene, the manor, the themes, Off duty since, "Where its work runs"), `reactPage({ token, data })` (the HTML: page.ts's head, the manor's theme at first paint, `<div id="root">`, the first data as JSON, `/page.js`), `scriptJson`, `bundlePage` (esbuild: one browser module, React included), `pageScript` and `releasePage`.
- **node/server.ts serves /page.js** for an agent with a src/web/main.tsx: built on each request in a checkout (again after a change to src/web or src/kit/react), and as released otherwise; 404 without one.
- **node/release.ts** bundles the page into src/web/page.js, minified unless `--readable`, and leaves its sources out of the zip (src/web's other files, src/kit/react). React is a devDependency: a release runs no React of its own.
- **node/page.ts:** `pillOf` (the status pill as data, which `statusPill` and the React title bar both draw), and its `CSS` and `lookCss` are exported.
- **tools/kit.ts** knows the react part.
- **What an agent must do:** nothing but take this version. One moving to React takes the part, adds react, react-dom, @types/react and @types/react-dom as devDependencies, writes its page in src/web/main.tsx, serves `{ shell: pageShell(…), body }` as /api/page and `reactPage(…)` as /, and type-checks src/web and src/kit/react with a tsconfig of their own (DOM and JSX): the Steward's tsconfig.web.json.

## 2.20.0

**A model on a graphics card is never called the NPU, and pages show a round as it starts and ends.** On a desktop with no NPU and an RTX 4080 SUPER, pages said "the NPU" was the accelerator, requests went to an NPU that wasn't there, and a page drawn between rounds never showed the next round's work.
- **What the PC has decides, never the model.** spec/ACCELERATORS.md's "What this PC has" is new. Detection's answer (whether the PC has an NPU, and its graphics cards) is kept in `hardware.json` in the shared accelerators folder. On a PC known to have no NPU, a config entry said to be the NPU (or an old config's endpoint that says no device) is read as what the PC has instead: its one card by name, "the graphics card" when it has several, the processor when it has none. It's never routed as an NPU. A card's own entry comes first and the two are one card. An old config's GenieX quirks go, and the order follows the new id. No model name or server address is looked at, so any model works.
  - core: `parseAccelerators(rules, raw, hw?)` and `readConfig(rules, file, text, hw?)` take it; new `instead(hw)`, `notTheNpu(a, hw)`, the `Hardware` type, and `say.notTheNpu`, which a config's problems carry.
  - node: `readHardware()`, `rememberHardware(hw)`, `hardwareFile()` and `Hardware` (accelerators.ts); `hardwareOf(detection)` (detect.ts), which is null unless both the NPU's and the cards' questions were answered; `refreshHardware()` (keeper.ts). `loadAccelerators`, `parseAccelerators` and accelerator-config's `readAccelerators`/`configuredAccelerators` read hardware.json by default, so setup's next save writes the entry as the card's.
  - Who writes it: setup, from its detection, and the keeper's look once a day (Reeve's page, or the Smith's rounds).
- **A note that says nothing of where it was written** is "from a local model", not "the NPU": `theAccelerator(null)` is `UNKNOWN_ACCELERATOR`, and page.ts' `unverified` says "Written by a local model" with no place. The accelerator vectors say so.
- **Settings' "Where its work runs"** speaks of the NPU only when Reeve lists one. Otherwise it gives the graphics cards' and the processor's order, and Task Manager's GPU graph.
- **Every kit page watches its own `/api/ping`** every 5 seconds, and draws itself again when a round starts or ends (busy, `lastRunAt`, `runningSince`), whoever started it. It still never reloads under someone typing, ticking a box, in Settings or the theme menu; it waits for them.
- **What an agent must do:** nothing but take this version. Agents that pass their own accelerator to a note keep doing so; one that labels a note "NPU" by default (Clerk's `{ id: 'npu', name: 'NPU' }`) should pass nothing instead.

### Before you update

Nothing: it updates itself as usual.

## 2.19.0

**Every release says what it brings: its notes are the agent's CHANGELOG.md entry for the version.** A release's notes said only which commit it was built from and how to unpack it, so Manor's What's new link showed nothing new. spec/RELEASE-NOTES.md is new, and says how an entry is written: a bold headline, then `### What's new`, `### What changed` and `### Before you update` (always there, "Nothing: it updates itself as usual." when updating needs nothing).
- **node/notes.ts is new:** `releaseNotes({ root, name, version, commit, kit, install })` gives the notes (the first line Manor reads, "built from <commit>"; the entry; how to install it), where they came from, and warnings. Also `entryOf`, `sectionOf`, `headlineOf`, `entryWarnings`, `commitsSince`, `withEntry`, `changelogHead`, `HEADINGS`, `NOTHING_TO_DO`.
- **A version with no entry** is published with a "What changed" that says so and lists its commits since the release before (each pull request's title), never with nothing.
- **release.ts:** the build says where its notes come from, and warns of an entry that's missing or lacks a heading; `--publish` publishes them through a file (`--notes-file`), since an entry's quotes could reach gh split on Windows. New export: `INSTALL_NOTE`.
- **The Steward's kit bump writes the agent's entry** for the version it raises (starting a CHANGELOG.md when there's none): each kit version's headline, and those kit entries' own "Before you update".
- **What an agent must do:** nothing but take this version. From then on, whoever raises its version writes its entry in CHANGELOG.md, in the same change.

### Before you update

Nothing: it updates itself as usual.

## 2.18.0

**Non-employee projects: repositories that ride along with the manor.** Each PC's Manor may list, in settings.json's `"projects"` (its Settings page's Non-employee projects), other repositories it looks after without employing them: the agents that clean up and fix repositories (Reeve's rounds, the Surveyor's test runs, the Wright's and the Bailiff's fixes) work on them too, but they take no kit, the Steward never touches them, they hold no role, and the manor never merges or releases them.
- **node/manor.ts:**
  - `manorProjects(home = manorHome()): ManorProject[]`: the projects, checked and read afresh; none when Manor isn't installed, its settings can't be read, or it lists none.
  - `ManorProject` is `{ name, checkout, repo: string | null, branch, test: string | null, versionFiles: string[], cleanBranches: boolean }`. `branch` is "main" unless said; `versionFiles` (paths inside the checkout) are the files the Wright sets the version in, and empty means the manor never changes the project's version; `cleanBranches` (true unless said) is whether Reeve's rounds delete branches already merged into `branch`.
  - `projectsFrom(raw, own, problems)`: the rules, which Manor's own settings use as well, so they are kept in one place. A wrong entry is left out and said. One whose `repo`, or whose clone's origin, is the manor's own (Manor's, its staff's and announced agents', the Steward's employees'), or whose checkout is, is inside, or holds one of the Steward's employees' checkouts, is refused: an employee is looked after as staff, never as a project.
  - Also `manorOwn()`, `originRepo(checkout)`, `githubRepo(url)`, `MANOR_REPO`, `MAX_PROJECTS` (50) and `MAX_VERSION_FILES` (20).
- **work.ts:** the Aletaster's hand-over of work orders says "each for at most 20 minutes" (it was 45), its new limit.
- **Nothing for an agent to do** but take this version. Reeve, the Surveyor, the Wright and the Bailiff take up `manorProjects()` in their own PRs.

## 2.17.0

**A release is built, never the readable source, and published in the public Jcollier0120/Manor-releases.** The agents' repositories stay private; what a PC installs comes from one public repository that holds releases alone, so any PC downloads them with no sign-in, and the source can't be read from them. spec/RELEASES.md is new.
- **node/minify.ts is new:** `loadEsbuild(root)` (the agent's devDependency, or `STEWARD_ESBUILD`'s), `minifyRelease(stage, esbuild)`. It builds each `.ts` under `src\` on its own with esbuild: minified, ESM, `keepNames`, imports as written (`verbatimModuleSyntax`), every import left outside it, and a relative `.ts` pointing at its `.js` (by esbuild's parser, never a text search). Each is written as a `.js` beside where it was. `src\cli.ts` stays as a stub, `import './cli.js'`; `.js` is minified with no module format; `.d.ts` goes; CSS and everything else are left as they were. Also `builtSpecifier`, `stubFor`, `ENTRY_STUBS`.
- **release.ts:**
  - It builds what it stages (a Steward release went from 864 KB of code to 418 KB), and leaves the README out.
  - `release.json` says `"form": "minified"`. `--readable` skips the build to look into on this PC, and is never published.
  - `--publish` publishes as `<id>-v<version>` in `RELEASES_REPO` (Jcollier0120/Manor-releases), and as `v<version>` in the agent's own repository too, for Manors from before.
  - A version already in the agent's own repository goes to the releases repository alone; one already in the releases repository is refused.
  - New exports: `RELEASES_REPO`, `releaseTag`.
- **service.ts:** `open()` starts the page through the `src\cli.ts` stub when it's there, so a built agent's command line still says `cli.ts` (Pinder and the Surveyor know the manor's agents by it).
- **install.ts:** `Release.form`.
- **release.ts fix:** an earlier build's zip in `artifacts\<id>\` is removed again. Its prefix had kept ".zip" on the end, so nothing ever matched it.
- **What an agent must do:** have **esbuild 0.28.2** as an exact devDependency (every hire has it since its "esbuild, to build its releases" PR). Its release now needs its packages, so the Steward runs `npm ci` before it.

## 2.16.0

**Every agent's page uses the width of the window.** The page's panel held everything in it (text, cards, tables, Settings) to a 1180px column, so on a wide window the lines broke short and the rest of the panel stood empty; and the title bar cut the agent's role at 90 characters' width even with room to spare (the Wright's and the Bailiff's were never shown whole).
- **page.ts:** `main.view > * { max-width: 1180px; }` is gone: the panel's content runs its width, inside its own padding (24px a side, 14px in a narrow window).
- **The role:** `.brand .role` loses `max-width: 90ch`, and `.brand` is `flex: 1 1 220px; max-width: max-content`: the name and role take the room the bar has, up to their own width, so the role is whole when it fits and cut with an ellipsis only when the window is too narrow for it, without pushing the tools to a second row. Still one line (two in a narrow window, as before).
- **Kept, since they hold a control and not a run of text:** a text box in Settings (`min(100%, 560px)`, and 560px in a list), a number box (130px), the Theme menu (272px), the `max-width: 100%` guards and the narrow-window breakpoints. settings-panel.css had no other cap.
- **Nothing for an agent to do** but take this version. An agent whose own page CSS sets a column (a `max-width` in `ch` or px on its text or panels) keeps it until its own PR takes it out.

## 2.15.0

**Offline is waited out, never a failure.** A PC that is offline knows it, so nothing in the manor says so again: a round that fails only because the network isn't there waits for it, and is tried at its usual time. spec/OFFLINE.md is new, and says what waits where.
- **node/net.ts is new:** `online()` (a cached look: port 443 of github.com, www.msftconnecttest.com and www.cloudflare.com, any one answering is online; kept a minute online, 20 s offline), `offlineSince()`, `isNetworkError(e)` (by code or by words: Node's, git's, gh's; never `ECONNREFUSED`, which a local server gives), `offlineFailure(e)` (a network failure while offline, or an `Offline` thrown), the `Offline` error, `probeHosts()`, and `setOnlineProbe()` / `forgetOnline()` for tests. `MANOR_OFFLINE=1` says offline without looking, `0` online.
- **schedule.ts's `every()`:** a round that throws an offline failure waited for the network. `lastRunOk` is null and the new `lastRunOffline` is true (both in `/api/ping`, by `roundTimes()`); round.json says `"ok": null, "offline": true` (spec/ROUND.md: `ok` may be null, and `offline` is new); the log says "this PC is offline, so the round waits for the network", never "run failed". So the Surveyor finds no failed round, and Manor's card says nothing failed, with no change to either.
- **Nothing for most agents to do** but take this version. An agent whose round catches its own network errors (a feed at a time: the Herald's, the Developer Herald's, the Chamberlain's mailboxes) asks `offlineFailure(e)` and shows that feed as waiting, in its own PR; or throws `Offline` when every feed waited.

## 2.14.0

**The title bar stays at the top as the page scrolls.** On a long page (the Steward's staff table, the Auditor's findings, Settings) the title bar, with its status pill, Settings, Theme and Run now, scrolled away with the rest.
- **page.ts:** `.titlebar` is `position: sticky; top: 0; z-index: 40`, on the page's own colour (`--bg`), so nothing shows through it in any theme. Once the page has scrolled, the script marks it `.stuck`: a `--line` border and the theme's `--shadow` under it (none at the top, where the panel's own edge meets it).
- **A jump to a #section lands below it:** `html` has `scroll-padding-top: calc(var(--titlebar-h) + 8px)`. `--titlebar-h` is 57px (97px in a narrow window, where the bar wraps to two rows), and the script keeps it to the bar's real height with a ResizeObserver.
- **The Theme menu's height** allows for the bar (`calc(100vh - var(--titlebar-h) - 16px)`), since a menu in a bar that doesn't scroll can't be scrolled into view.
- The kit has no other sticky bar at the top (the Settings panel's Save bar sticks to the bottom), so nothing else moves. An agent's own sticky element at `top: 0` should use `top: var(--titlebar-h)`.
- **Nothing for an agent to do** but take this version. The `<header class="titlebar">` markup is unchanged.

## 2.13.1

**An update that moves an agent's port ends the old page.** The installer ended the running page only when it answered on this version's port, so the Chamberlain's 0.1.3 (moved from 19898 to 20303) left 0.1.2's page running on 19898, where the Developer Herald's page then couldn't start.
- **service.ts:** `pageAt()` is new. It gives the port the page answers on: this version's, else the one server.json says the running page took. `shutdown()` stops the page there, and `ping(at)` takes a port.
- **install.ts:** `InstallDeps.running()` is new and optional (ping when unset). The installer uses it to decide whether there's a page to end, and to wait until it's gone.
- **Nothing for an agent to do** but take this version. Its next update after a port change ends the old page.

## 2.13.0

**The NPU first.** The NPU does model work without the processor or a graphics card, so it is used as much as it can be, and the others only when it can't do the work. Before, the auto order put graphics cards with 2 GB or more of their own memory ahead of the NPU, and a request the NPU could do went to a free card whenever the NPU was busy.
- **The auto order** (the core's `autoOrder`, and the keeper's in node/accelerator-config.ts): the NPU, then graphics cards with 2 GB or more of their own memory by memory, then shared graphics, then the processor.
- **The candidates** (the core's `candidates`, which now also returns `npuFirst`): when the first that serves a request and fits it is the NPU, and it hasn't failed lately, it is the only candidate. Busy, it is waited for; resting after a long line, a background request is deferred; never passed over for a card. A card or the processor takes a request only when the NPU doesn't serve that kind, the request is too big for it, or it failed in the last 10 minutes.
- **npu.ts:** the NPU's model still loading no longer sends the request to the next accelerator: it waits (NpuBusy). `budget()` sizes pieces to the NPU's cap when it comes first, so long inputs are split to fit the NPU.
- **An `acceleratorOrder` list that puts something else first** is the person's choice, and kept: then the pick is as before.
- **"Where its work runs"** on every kit agent's Settings page says so; ACCELERATORS.md's Choosing steps too. accelerator-vectors.json is regenerated.
- **Nothing for an agent to do** but take this version.

## 2.12.1

**A release zip's name has no spaces.** `npm run release` named the zip after the agent's name, so the Developer Herald's was `Developer Herald-0.5.2.zip`. GitHub stores a space in an asset's name as a dot (`Developer.Herald-0.5.2.zip`), which no longer matched its SHA256SUMS.txt line, and Manor, which looks for `DeveloperHerald-*.zip`, found no zip at all.
- **release.ts:** `zipName(name, version)` is new, and gives the zip's name without spaces (`DeveloperHerald-0.5.3.zip`). An agent whose name is one word is named as before.
- **Nothing for an agent to do** but take this version. The Developer Herald's next release is the first that installs.

## 2.12.0

**A release announces its agent to every Manor, when the checkout has manor-agent.json.** Manor 0.4.35 finds new agents on GitHub: on each hourly look it asks which of its staff's owners' repositories have `manor-agent.json` on their latest release, checks it against that release's SHA256SUMS.txt (it must be listed there), and offers Hire on the role's card. The file is `{ "agent": { ...its entry as Manor's staff.json has it, with "release": { "repo", "kind": "node" } }, "roles": [ ...optional, as Manor's roles.json has them ] }`. node/release.ts now carries it:
- **`npm run release`** copies the checkout's `manor-agent.json` (at its root) into `artifacts\<id>\`, beside the zip, and adds its line to SHA256SUMS.txt after the zip's. **`--publish`** uploads it with the zip and SHA256SUMS.txt. A checkout without one releases as before, and an earlier build's copy is removed.
- **It refuses to build** when the file isn't one Manor would take: its `agent.id` isn't this agent's (release.json's id), its `release.repo` isn't origin's GitHub repository (or origin isn't GitHub), its `release.kind` isn't `node`, its `paths.app` isn't exactly `["%USERPROFILE%\\.<id>\\app"]`, or its `roles` isn't a list of objects. The error says which, and to fix it or remove it.
- **A change to manor-agent.json makes the release dirty** (`+dev.<commit>`), so an uncommitted one is never published.
- New exports: `ANNOUNCEMENT`, `checkAnnouncement(json, id, repo)`, `announcementOf(dir, id, repo)` and `sumsText(files)`.
- **Nothing for an agent to do** but take this version. An agent that wants Manor to offer it adds `manor-agent.json` at its root and releases.

## 2.11.0

**Keeping the model servers moves into the kit, for the Smith.** Reeve, a developer role, kept the model servers every agent works from: when Developer options were off, its role went vacant and its servers kept running only by special case. The Smith, a new general role, takes the job over; Reeve keeps it only where there is no Smith. Both run the same code, which is Reeve 0.4.x's, moved here unchanged in what it does:
- **keeper.ts** (Reeve's src/reaper.ts): once a minute, a model server whose accelerator nobody has used for `npuIdleStopMinutes` / `gpuIdleStopMinutes` (10 each by default) is stopped; a card's servers stop once a game is using the card and nobody has used it for 2 minutes; a server that hasn't answered for 3 minutes while nobody uses its accelerator is restarted (busy-aware: GenieX answers nothing while it loads or answers); GenieX is restarted at a 9 GB working set while nobody uses the NPU. Each holding all the accelerator's slots, the first through its line as a background turn that joins only an empty line (`maxAhead` 1; 0 would refuse every turn). Also `acceleratorStatus()` and `describeStatus()` (Reeve's status), `startReaping()` (Reeve's home page), and `keeper()`, `smithInstalled()`: the Smith keeps the servers where `%USERPROFILE%\.smith\app` (or SMITH_HOME's) is, else Reeve.
- **New in the keeping: orphans.** A `llama-server` or GenieX on the manor's ports (18181, 18191-18199, 18282 and every configured server's) that no configured server is (another program, or another port: a test's or a scratch home's, or one an earlier config named) is stopped once seen for 5 minutes, and said in the log with its path and command line. An 8 GB llama-server from a scratch home had been left running on 18191 with nobody tracking it.
- **The keeper follows Manor's `gpuWithNpu`** (2.10.0: manor.ts's `gpuWithNpu()`, the core's `withoutGpuBesideNpu`): while it keeps a graphics card out beside the NPU, the card's servers stop as soon as nobody uses the card, and are never restarted.
- **setup.ts** and **detect.ts** (Reeve's src/setup.ts, detect.ts and geniex.ts, and the command from accel-status.ts): detecting the hardware, choosing llama.cpp's build and the models, the memory budget (all of a card's servers at once with 1.5 GB left for the desktop; vision left off when they don't fit), downloading and checking, finding each card's device, and writing config.json. `setupCommand()` takes the file, the home and the check, so the Smith and Reeve each pass theirs.
- **accelerator-config.ts** (Reeve's src/accelerators.ts and settings.ts): config.json as its owner reads it (as written, an old config's single endpoint included), checks it and writes it: `acceleratorConfigFile()`, `readConfigFile()`, `saveConfig()` with its etag (a file changed since it was read is refused), `KEEPER_KEYS`, `keeperSettings()`.
- **config.json stays where it is**, `%USERPROFILE%\.reeve\config.json`: every agent's kit reads it there, so the Smith took over the same file. The keeper writes `accelerators`, `acceleratorOrder`, `npuIdleStopMinutes` and `gpuIdleStopMinutes`; Reeve its own keys. spec/ACCELERATORS.md says so.
- **rules.json** has a `keeper` section: `lookEveryMs`, the two idle defaults, `gameGraceMs`, `unansweredMs`, `recycleBytes`, `turnWaitMs`, `turnMaxAhead`, `otherSlotsWaitMs`, `orphanGraceMs`. The core's `checkRules` requires it, so take rules.json from this release with the core (the dotnet part embeds them together).
- accelerators.ts's **`ensureServer()`** takes `logFile` and `env`, for the keeper's restarts; a request's start is as before.
- **look.ts and work.ts**: the Smith's scene (the hammer on the anvil, sparks, the forge glowing; copper, #a3501c) and its lines in Where its work runs.
- **Nothing for most agents to do.** Reeve moves onto these modules in its own PR, and the Smith is built on them.

## 2.10.0

**Manor can keep the graphics card out of model work on a PC with an NPU.** Manor 0.4.29 has a Settings switch, "Use the graphics card for models when there's an NPU", saved as `"gpuWithNpu": true | false` in its settings.json. It is on by default, and an absent key means on, so nothing changes until someone turns it off. Off, on a PC whose Reeve config has an NPU that serves something, no graphics card is ever chosen for a request: not first, and not as the fallback when the NPU fails, is busy or its line is full. The processor, if configured, stays as before. Without an NPU the switch means nothing.
- core/accelerators.js: **`withoutGpuBesideNpu(list, gpuWithNpu)`** is the rule. False, with an NPU in the list (not `enabled: false`, and serving chat, vision or embed), leaves out every `gpu` accelerator; otherwise the list is unchanged.
- core/messages.js: **`say.gpuSetAside(acc)`**, for a request only a set-aside card could serve (one naming the card, or embeddings only the card serves).
- node/manor.ts: **`ManorLink.gpuWithNpu`** (true unless settings.json says false: an older Manor, without the key, never set the card aside), and **`gpuWithNpu(own = true)`**, `{ on, setBy }` as `developerOptions(own)`: Manor's value while it's installed and says true or false, else the agent's own switch (true for an agent without one). It reads afresh on each call.
- node/npu.ts: `Npu.accelerators` applies the rule on every read, so every request, `budget()`, `hasVision` and `hasEmbed` follow Manor's switch at once, with no restart.
- spec/ACCELERATORS.md says so.
- **Nothing for an agent to do.** Agents that build on `Npu` follow it. Reeve, which routes requests and starts servers itself, follows it in its own PR. Heiward, which runs its own models, is unchanged.

## 2.9.1

**An NPU turn skips its warm-up while the model is still loaded.** Since 2.6.0 every chat or vision turn on the NPU began with a one-token warm-up request, in case GenieX had to load the model. With Reeve keeping one model loaded for hours (`--keepalive`, one model for chat and vision), that was a second request on every turn. Now a turn skips the warm-up when the server was already up and answered this same model within its keepalive (less 30 s; GenieX's default 300 s when its `startCommand` names none):
- accelerators.ts: **`servedFile(id)`**, **`noteServed(id, ep)`**, **`servedRecently(id, ep)`** and **`keepaliveMs(startCommand)`**. Every agent writes `<accelerators>/<id>.served.json` after each NPU answer, so one agent's turn tells the next.
- A server just started or found busy, another model answered since, or no record: the turn warms up as before.
- spec/ACCELERATORS.md says so.
- **Nothing for an agent to do.**

## 2.9.0

**`/api/ping` says since when an agent is off duty, so Manor needn't run its status command.** The ping said `running` (on duty) but not since when, which only `status --json` said; so for an agent off duty, Manor ran `node src\cli.ts status --json` on every look to learn it. Now the ping carries what that command says:
- **`stoppedSince`**: when it went off duty (ISO), or null while on duty, as `status --json` gives it.
- **`summary`**: the same line, "On duty." or "Off duty since 2 hours ago: its scheduled rounds are paused."
- service.ts's **`dutyStatus(duty, pageUp)`** is new, and makes all three for the ping and for `statusJson()`, so they never say different things. On the ping the page is up, so `running` is still whether it's on duty.
- **The kit's tests clean up after themselves, and wait on conditions, not time.** npu-queue.test.ts keeps every test's lock folder under one temporary folder that it removes (it left one in %TEMP% per test, hundreds by now), and manor.test.ts and work.test.ts remove theirs. The fixed sleeps in kit.test.ts, settings-kit.test.ts and accelerators.test.ts wait for what they were waiting for. accelerators.test.ts's free port comes from below the range Windows hands out to other programs (one from `listen(0)` could be taken by any outgoing connection the moment after), and the fake model server it starts ends with its test, not 8 s later.
- **Nothing for an agent to do.** Manor already reads `stoppedSince` from a ping when it's there, and runs the status command only when it isn't.

## 2.8.3

**A Qwen3 Instruct model is never told /no_think.** accelerators.ts appended `/no_think` to every request to a Qwen3 model but the 2507 Instruct ones, so Qwen3-VL-4B-Instruct got it too, though no Instruct model thinks. Measured 2026-10-04 on the NPU (the Auditor's eight golden questions and ten more shaped like the agents' requests), the VL model answered 8/8 and 8/10 without it, 8/8 and 7/10 with it; the chat model 8/8 and 6/10, at the same speed. Now only a Qwen3 that isn't an Instruct model (Qwen3-4B, a -Thinking model) is told; `thinks()` is exported.
- **Nothing for an agent to do.** It matters most once Reeve's chat runs on the VL model, one model for chat and vision.

## 2.8.2

**spec/ACCELERATORS.md says what Reeve's reaper stops: every model server it can start again, not only GenieX.** Reeve 0.4.7 (Reeve#31) extended it: a graphics card's and the processor's llama-servers (chat, vision and embeddings) stop after `gpuIdleStopMinutes` (10 by default; 0 never) with nobody holding or waiting on that accelerator's lock, and a card's stop once `games.json` says a game is using the card and nobody has used it for 2 minutes. The not-answering restart (3 minutes) applies to each of them; the 9 GB working-set restart stays GenieX's. On a card with more than one slot, the reaper takes one slot through the line (background, `maxAhead` 1) and holds the other slot folders as plain locks (2 s wait), so no request starts on a server being stopped.
- **Nothing for an agent to do.** The kit's code is unchanged: `ensureServer()` already looks at its server afresh in every turn, so the next request starts a server Reeve stopped.

## 2.8.1

**A JSON file's rename that Windows refuses for a moment is tried again.** store.ts's `writeJson` writes a temporary file and renames it over the old one, and Windows sometimes refuses that rename with EPERM, EACCES or EBUSY while an antivirus or the search indexer has the file open: about one rename in a thousand in %TEMP% or a scanned folder (the Wright measured it for the Miller, Miller#22, where it failed a test now and then and could fail a round part-way through a save). Now such a rename is tried again every 25 ms for up to half a second (`RENAME_TRIES`, 20); after that, or on any other error, the temporary file is removed and the error thrown, as before.
- **Nothing for an agent to do.** An agent with a retry of its own (the Miller's `writeJsonFirmly`) can drop it for the kit's.

## 2.8.0

**Every agent leaves its rounds' outcome in one file, the same way.** schedule.ts's `every()` writes `round.json` in the agent's data folder at the end of each round that runs (scheduled, or Run now), so the Surveyor reads one file per agent instead of guessing from each agent's own report.json, status.json or state.json. spec/ROUND.md is new, and says the shape for any reader:
- **The shape:** `{ "rounds": { "<name>": { "started", "finished", "ok", "error", "everyMs", "next" } } }`. `<name>` is the `name` given to `every()`, or `"round"`; several schedules in one process each keep their own entry. `started` and `finished` are ISO times; `ok` says whether the round went through; `error` is the thrown error's message, its first line, at most 500 characters (null when `ok`); `everyMs` is the interval; `next` is when the next round is due, null off duty or once stopped (as `/api/ping`'s `nextRunAt`).
- **Written whole:** read, the schedule's own entry replaced, every other entry and key kept, and written through a rename (store.ts's `writeJson`). A file that isn't JSON is started afresh.
- **Never at the round's cost:** a round.json that can't be written (a data folder that can't be written to) is said once in the log, and the rounds go on.
- schedule.ts also exports `roundFile()`, `RoundRecord` and `roundError()`.
- **Node only for now:** the dotnet part has no scheduler, so Heiward doesn't write round.json yet.
- **Nothing for an agent to do.** Every agent whose rounds run with `every()` writes it from this version on.

## 2.7.0

**The Lamplighter's scene, and its lines in Where its work runs.** The manor's new general role, the Lamplighter, keeps the last good graphics drivers and rolls a new one back when it leaves the screen dark (a guard that runs as SYSTEM, in Windows PowerShell). Its look and its work are kept here by its id, as every kit agent's are:
- **look.ts:** its scene, a street lamp on its post. While a round runs, the lamplighter's long pole rises to the lantern, its little flame lights the lamp, and the pole comes down again. Its colour is a flame's vermilion (#c4471a, #ff9a6b on a dark theme); its pill says "Lighting the lamps".
- **work.ts:** its four lines (the guard's look and its archive of drivers, a rollback, its page, a few plain words on a rollback), and a note that the guard is the one part of the manor that runs as an administrator, and uses no model.
- **`AgentWork.npuOnly`** is new: an agent whose model work goes to the NPU only. Its "Its model work" paragraph says so, and whether this PC has an NPU, in place of the shared order (graphics cards first). The Lamplighter's does: the GPU is what it guards, and right after a driver failure it may be the broken part, so it never asks a graphics card or the processor.
- **Nothing for an agent to do.** The Lamplighter shows its scene from this version on; before it, the grey cog.

## 2.6.0

**A model server that is busy loading is waited on, not started twice, and a slow model load is no failure.** GenieX answers nothing, not even `/v1/models`, while it loads a model or answers a request (measured 2026-10-03), and the kit took that for a server that wasn't running: it started a second geniex.exe (which exits at once, its port taken), waited 30 s for an answer, and marked the NPU failed for every agent for 10 minutes. And a background request had 180 s whatever its size, while a load can come on any turn: GenieX keeps one model at a time, so a chat request after a vision one loads the chat model again (9 to 15 s), as does the first after 5 idle minutes. spec/ACCELERATORS.md's new "Model servers" section has the rules; node/accelerators.ts and node/npu.ts carry them out:
- **`probe(baseUrl)`** is new: `ready`, `busy` (a 503, or no answer in 3 s from a server that took the connection) or `down` (the connection refused). `ping()` is `probe() === 'ready'`, as before.
- **`ensureServer()`** looks afresh on every turn (Reeve now stops an idle GenieX, and its next request starts it again), waits up to 180 s for a busy server rather than starting another, and returns `{ started, waited }`. A start command that exits with nothing answering fails at once. `forgetServers()` has nothing left to forget, and stays for callers.
- **Each chat or vision turn on the NPU starts with a warm-up**: a one-token request given 105 s, so the request after it runs warm (a warm model answers it in about 0.15 s).
- **A background chat or vision request's timeout** is 15 s plus 0.3 s per token it may answer, never more than the config's `requestTimeoutMs`; a person waiting, and embeddings, keep `requestTimeoutMs`. Off the NPU, a request whose server was just started or found busy gets 90 s more. core's **`requestTimeoutMs(rules, ...)`** works it out.
- **`ModelLoading`** (an `AcceleratorDown`) is a timeout while the model loaded: the warm-up's, or one given the allowance. Nothing is marked failed; the request goes to the next candidate, else background work is deferred (`NpuBusy`) and the agent leaves that accelerator alone for 5 minutes. **`postJson(..., { loading: true })`** throws it.
- **`Npu.reachable()`** counts a busy server as running.
- **rules.json** has five new timings under `accelerators`: `probeMs`, `readyWaitMs`, `requestBaseMs`, `requestPerTokenMs` and `coldLoadMs`.
- **Nothing for an agent to do** but take this version: its requests on the NPU get the warm-up and the new timeouts by themselves. An agent that calls `ensureServer()` or `postJson()` itself may use the new return value and option. Reeve, which has its own servers code, follows in its own PR, with the idle stop.

## 2.5.0

**The manor's Developer options, passed down.** Manor's Settings page has a Developer options switch (Heiward's Developer mode, copied), saved as `"developerOptions": true | false` in its settings.json: on, its developer roles are held (Reeve, the Auditor, the Herald, the Aletaster, the Pinder and the Steward); off, they're vacant. An agent with developer features of its own follows it in place of its own switch, while Manor is installed and says. node/manor.ts:
- **`manorLink()`** also reads `developerOptions`: Manor's value when it's true or false, else `null` (Manor hasn't said: no key, or anything else).
- **`developerOptions(own)`** is new: `{ on, setBy }`. With Manor installed (its folder has settings.json and app) and saying, `on` is Manor's value and `setBy` is Manor's link; otherwise `on` is `own`, the agent's own switch, and `setBy` is null. It reads afresh each call, so call it on each page load and each round, not once.
- **`manorSettingsUrl(link)`** is Manor's Settings page (its page at `#/settings`), where the switch is.
- **page.ts's `developerOptionsNote(setBy)`** is what stands in place of the agent's own switch while Manor sets it: "<manor>'s Developer options set this", and "Change it in <manor>" linking to Manor's Settings. It's empty when `setBy` is null, so it can sit where the switch would; its look (`.manor-decides`) is in every kit page.
- **Nothing for an agent to do.** No hire has developer options today. One that adds them reads `developerOptions(ownSwitch)`, shows its developer features when `on`, and in its settings shows `developerOptionsNote(setBy)` instead of its own switch when `setBy` is set. Heiward follows Manor's switch in its own PR.

## 2.4.0

**The manor's themes, chosen once in Manor.** Every page in the manor shares one theme: the nine Heiward has (Match Windows, Light, Dark, and the six colour themes Arcade, Onyx, Carbon, Tinsel, Rose Gold and Quest, the user's own Gamer Nexus themes), kept once here:
- **web/themes.css is new:** every theme's colours, as `:root[data-theme="..."]` blocks, with Heiward's values for the tokens Heiward has. The manor's own tokens follow the same rules: `--npu` is Gamer Nexus's host text and its `-bg` a 20% tint, `--gold` its star, `--quiet-bg` a step past `--surface-2`; `--ink`, `--ink-soft`, `--ink-deep` and `--paper` (the scenes') are the Light or Dark ink. Every text pair is 4.5:1 or more (kit/test/themes.test.ts checks).
- **web/themes.json is new:** the list the Theme menus show (each theme's name, label, description, swatch, group, and whether it's light or dark). **node/themes.ts** reads both for page.ts: `themes()`, `themeNamed()`, `groupLabel()` and `themesCss()`.
- **With Manor installed,** `manorLink()` also reads the manor's theme (settings.json's `"theme"`, which Manor's Theme menu saves), and page.ts stamps it on `<html data-theme>` as it draws the page, so it's right at first paint, with `data-manor` and `data-manor-url` (as Heiward's and Reeve's pages mark it). The agent's Theme menu shows the manor's theme and says "<manor> chooses the theme, for every page in the manor", with a link to change it in Manor; what the agent's page kept in the browser doesn't apply.
- **Without Manor,** the agent's own Theme menu has all nine, under Windows and Colour themes as on Heiward's, kept in the browser per agent as before.
- **Each agent's scene** takes its Dark colour on the dark colour themes, and its Light one on the light ones. All ten scenes were checked on every theme: none needed a colour of its own.
- **`manorLink()` no longer throws** on a settings.json that is JSON but not an object (`null`, say): that is Manor's defaults, as an unreadable one is.
- **page.ts takes its colours from the web part**, as its Settings panel does: every kit agent with a page takes it already. Manor carries a copy of themes.css and themes.json.
- **Nothing for an agent to do.** Heiward and Reeve, whose pages aren't the kit's, follow Manor's theme in their own PRs.

## 2.3.0

**Back to the manor, from every agent's page.** When Manor is installed here, the title bar starts with Manor's icon and "Back to <manor>" (its name from Manor's settings, "Back to Weasel Manor" say), linking to Manor's page; a narrow window shows the icon alone. node/manor.ts is new:
- **`manorLink()`** reads Manor's settings.json (in %USERPROFILE%\.manor, or MANOR_HOME, as Manor reads it) for its name and port. It is null when Manor isn't installed (no settings.json, or no app folder beside it), and then the title bar says nothing.
- **`/manor-icon.svg`** serves Manor's icon from the agent's own address (its page loads images from itself only): the one Manor's page shows, kept for ten minutes; else the generic icon in Manor's app folder; else a plain house. An SVG with anything that runs is never served.
- **Nothing for an agent to do.** Reeve's and Heiward's pages, which aren't the kit's, get the link in their own PRs.

## 2.2.1

**The Aletaster's lines in Where its work runs, for its 0.5.0.** Each round it now also asks Manor and the Steward who works at the manor, and tastes each agent too (about 14 projects a round); before each tasting it clones a project that isn't on this PC and fetches each clone, fast-forwarding its default branch when it's checked out and clean (the network and the disk); and, when Settings → Work orders names a worker (it's off by default), it hands up to 2 projects' work orders a round to it, one at a time, in a git worktree of its own, each for at most 45 minutes: Claude Code (`claude -p`, which runs on Anthropic's servers, with its tool calls on this PC's processor) or a command. Three lines say so, beside its two. Nothing for an agent to do.

## 2.2.0

**Every agent says when it last ran and when it runs next.** schedule.ts's `every()` records each schedule's rounds: when the last one ended and whether it went through, when the next is due (none off duty), and since when one has been running. `rounds()` lists them, and `roundTimes()` sums them up.
- **`/api/ping`** gives `lastRunAt`, `lastRunOk`, `nextRunAt` and `runningSince` (ISO times), plus `rounds`, each schedule by its name. An agent's own ping fields still win. Manor's employee cards read them.
- **The page's status pill** says "On duty · next round in 25 min" for every agent whose rounds run with `every()`, without the agent passing `nextAt`.
- `every()` takes an optional `name` ("round" unless said), and its handle has `state`.
- **Nothing for an agent to do.**

## 2.1.0

**Every agent's page in Heiward's look, with a little character per role.** page.ts draws one design for all of them, Manor's and Heiward's: Windows 11's colours, and the agent's body on one panel under a compact title bar.
- **The title bar** has the agent's icon, name and role; its **scene**; a **status pill** (what it is doing while a round runs, "On duty", or "Off duty"); the **Settings** gear (its label at wide widths); a **Theme** menu (Match Windows, Light or Dark, kept in the browser per agent, with nothing lost when storage is blocked); and the agent's **Run now**. The script moves the body's first button that POSTs `/api/run` and says "Run now" into the title bar, or a button marked `data-titlebar`. A button that sends a form or a body stays put, as does the Auditor's "Check the fingerprints now". Without JavaScript, everything stays where the agent put it.
- **look.ts is new:** `LOOK` holds each agent's look by its id, as work.ts holds its work: its colour for Light and Dark, its words for the pill while busy ("Tasting", "At the mill"), and a small inline-SVG scene (64 × 40 px) in its colour and its icon's ink. The Aletaster's glasses of ale are drunk one after another as the tasting goes on; the Miller's millstone turns under the hopper; the Porter's gate swings and its lantern sways; the Clerk's quill writes on the roll; the Herald's banner flutters on its trumpet; the Warrener's rabbits hop into their burrow; the Pinder's stray walks into the pound and the gate locks; the Auditor's tally stick is notched; the Steward's ring of keys jingles; the Surveyor's theodolite sweeps. An agent not listed gets `DEFAULT_LOOK`, a grey cog.
- **A scene moves only while busy**, and keeps time across the page's own reloads every few seconds. Idle, it sits still. Someone who asks Windows for less motion sees it still.
- **The kit's classes** look like Heiward's: cards, tables, badges, buttons (`quiet` is Heiward's secondary button), details and summary, empty states, form fields. The off-duty notice is a banner under the title bar, on every view. The Settings page, Where its work runs and the Settings panel (web/settings-panel.css) follow. New and free to use: `.tiles`, `.tile`, `.tile-value`, `.chips` and `.chip`.
- **The older colour names stay**, for the agents' own styles: `--card`, `--soft`, `--accent`, `--ok`, `--warn`, `--alert`, `--npu` and their `-bg`s.
- **`page()` takes `nextAt`**, the next scheduled round if the agent knows it, and the pill says "On duty · next round in 25 min". No agent passes it yet; without it, the pill says "On duty".
- **Nothing for an agent to do.** Checked against the real pages of the ten kit agents running here (the eight hires, the Steward and the Surveyor), their own styles included, in Light and Dark, at a desktop's width and a phone's.

**tools/kit.ts puts a downloaded kit into the shared cache whole, by a rename.** The Steward fills two agents at once, and in kit 2.0.0's rollout two fills of the same kit shared the cache: one deleted it while the other read it, and the Auditor's bump failed. Now each copies into a staging folder beside the cache and renames it into place; whoever renames first wins, and the other uses that copy. A test fills four agents at once.

## 2.0.0

**One core, two thin drivers.** Every rule the agents share is written once, in plain JavaScript, in a new part, **core**, and each language's part only carries it out: **node** (TypeScript, for the Node agents) and a new **dotnet** part (C#, for Heiward). A rule's change is now one edit to the core, released as a kit version; only a new kind of disk action touches a driver.
- **core**, at `src/kit/core/` in a Node agent: ES2022 modules typed with JSDoc, each with its `.d.ts` (made from the JSDoc). It does no I/O and has no clock or randomness of its own: a driver hands it what it read and the time. It holds the ticket order and the late, dead and aged rules, a lock holder's eviction, the turn and the plain lock as a state machine (`startTurn`, `step(state, observation)` → the actions to take and how long to wait, `release`), reading, checking and auto-ordering Reeve's accelerator config, the candidates and the pick, failure markers (when one counts, what one says), the game check, the ids and their slug, a request's size, and every message the kit's model code gives (`say`).
- **spec** gains **rules.json**: the timings and limits (heartbeat, late, dead, age, polls, stale, retries, failed-for, games, maxAhead, slots, caps, back-off, the token estimate) as data, which a driver passes to the core. And two sets of vectors every driver runs: **turn-vectors.json** (the turn and the plain lock, step by step, in 24 situations) and **accelerator-vectors.json** (ids, cards' names, Reeve's config, the order, markers, games, candidates, the pick, the messages). npu-queue-vectors.json gains `holders`, the eviction rule; its format is unchanged, and a reader skips keys it doesn't know.
- **A part brings what it needs:** node brings the core, the core brings spec (its rules.json), dotnet brings the core. tools/kit.ts fills them whatever kit.json names, so `{"kit": "2.0.0", "parts": ["node", "web", "spec"]}` is all a hire changes. A kit release carries `core\` and `dotnet\`.

**For a Node agent (the eight hires, the Steward): only the pin.** `steward bump` moves kit.json to 2.0.0 and hands out the new tools/kit.ts; `src/kit/` gains `core/`, `spec/rules.json` and rules.ts (node/rules.ts, which reads rules.json for the node part). npu-queue.ts, lock.ts, accelerators.ts and npu.ts keep their module boundaries and every export, with the same signatures; their insides are the core's. New exports, for anyone who drives the core: npu-queue.ts's `drive`, `onDisk`, `performOnDisk`, `holding` and `DriveEnv`, and `TurnOptions.onNote` (told when a turn waits behind others or takes over from a holder that died); accelerators.ts's `candidates` takes an optional `now`. The types (`Accelerator`, `Ticket`, `Failure`, `Games`, …) are the core's, by the same names. What behaves differently:
- **withLock lets go only while owner.json still names it**, as a turn's release always did, retrying while a file in the folder is open; it evicts a dead or overstayed holder by the same rules, trying twice, then every 150 ms.
- **A failure marker's reason** is trimmed and cut at the first line break, `\r` too, and is "it failed" when empty (as Heiward's markers always were).
- **The shared files' times** (a marker's `since`, games.json's `checkedAt`) are read as ISO 8601 with a zone, the same in every engine; anything else counts as absent, as an unreadable file does. Every program writes them that way.
- **A turn on a line whose folder can't be listed** (other than its being gone) ends with an error instead of waiting blind, and a ticket that goes missing twice in a row waits a poll before it is written again. An error from the disk reads "couldn't take turns on the NPU: <the system's words>".
- **queueSnapshot** lists a ticket whose contents aren't JSON (without its `who`), and a holder only when owner.json reads as `{pid, since}`. `QUEUE` is a copy of rules.json's: changing it changes nothing.

**For Heiward: the dotnet part**, kit `dotnet\`: C# source its HEI.Core project compiles by importing `Steward.Kit.props`, which also embeds the core's JavaScript and rules.json and references **Jint 4.16.4**, the JavaScript interpreter the core runs in (pure managed, from NuGet: Arm64, the Store package and a self-contained or single-file exe all run it; trimmed too). `KitCore` hosts the core (thread-safe, once per process); `AcceleratorLock.Acquire` takes a turn on a lock folder, blocking or async, by the core's machine, with Win32 CreateDirectory for the atomic take; `FailureMarkers` reads, writes whole and clears `<id>.failed.json` in any folder. NpuLock.cs and Accelerators.cs keep their callers and lose their insides to it; that is Heiward's own PR. Heiward's kit.json takes `["dotnet"]` (bringing core and spec), laid out as the kit tree is: `kit\core`, `kit\dotnet`, `kit\spec`.

**For Reeve:** its src/npu-queue.ts copy is retired when it takes the node part. npu-embed's npu_lock.py stays Python, its own implementation of the lock: it keeps running npu-queue-vectors.json unchanged (`order`, `dead`), may run `holders`, and may read its timings from rules.json.

**In the Steward:** kit/test runs the vectors against the core directly and through the node part, and kit/test/dotnet against the core in Jint and through the dotnet part, with the .NET 10 SDK (`npm run test:dotnet`, and npm test's posttest when one is found). `npm run core-types` writes the core's `.d.ts`, `npm run vectors` the two new vector files, `npm run test:dotnet-publish` publishes the dotnet part as Heiward does and runs it.

## 1.2.1

**A wording fix in Where its work runs.** Its Task Manager line said "Performance, NPU: it isn't…". The Aletaster's page test forbids "NPU:" anywhere on its page, from when the NPU was the only accelerator, so its 1.2.0 bump failed and was held back. The line now reads "on a graph of its own (Performance, then NPU)". A kit test checks that no agent's section says "NPU:" or "NPU note". Nothing for an agent to do.

## 1.2.0

**Where its work runs**, at the end of every kit agent's Settings page. It says what the agent does, where it runs (the processor, a graphics card's encoder, the network, Reeve's model) and when, so someone who sees the processor or a graphics card busy for a minute can tell why. node/work.ts is new:
- **`WORK`** holds each kit agent's lines, by its id: the eight hires, the Steward and the Surveyor. An agent not listed shows the shared part only. A change to what an agent does is a change here.
- **The shared part** says how model requests take turns (one at a time on the NPU, shared with every agent), Reeve's order, and that background work keeps off a graphics card a game is using. It names the accelerators this PC actually has, read from Reeve's config.json as every request reads it: "On this PC, Reeve lists the NPU (chat, vision). So its model work runs on the NPU only, never on the processor or a graphics card." It also says that Task Manager shows the NPU's work under its own graph.
- **page.ts** adds the section to every page, marked `data-settings-extra`. The Settings page takes it after the agent's own Settings section, and that section now stops before it. Without JavaScript, it stays at the end of the page.
- **Nothing for an agent to do.**

## 1.1.0

**Settings is a page of its own**, as on Manor's, Reeve's and Heiward's, so an agent's page is no longer as tall as its settings. page.ts:
- **The header** has a Settings link with a gear, on the right. It opens Settings at `#/settings` (`#settings` too), and the Settings page's back link returns.
- **The Settings page** is the section the agent's body already has: page.ts's script lifts it out of the page. The section runs from the panel back to the heading before it, when that heading says Settings, and on to the next heading. That takes the agent's own Settings cards with it (Clerk's folders, Warrener's locations, Miller's hopper, Aletaster's projects) and the version line, and leaves every other section on the main page.
- **The page doesn't refresh itself while Settings is open,** as it doesn't while something is ticked or being typed in.
- **Without JavaScript** (which the panel needs anyway), the page is as before, and the link stays hidden.
- **Nothing for an agent to do.** Its view.ts keeps writing its Settings section where it always did. Checked against all nine kit agents' real pages.

## 1.0.0

The kit's first version: the files the eight hires (Porter, Auditor, Clerk, Herald, Warrener, Aletaster, Miller, Pinder) each carried as an identical copy, as of their release-0.3.1, kept once here. tools/kit-from.ts found them by comparing the hires; the seed commit has them as they were, only moved.

**Where it lives in an agent.** An agent no longer carries the kit's code. Its `kit.json` pins a version and the parts it takes, `{"kit": "1.0.0", "parts": ["node", "web", "spec"]}`, and its `tools/kit.ts` fills `src/kit/` (git-ignored) from a kit release; a release of the agent carries `src/kit/`.
- **node**, at `src/kit/`: accelerators.ts, duty.ts, gpu-load.ps1, install.ts, lock.ts, npu-queue.ts, npu.ts, page.ts, ps.ts, release.ts (was tools/release.ts), schedule.ts, server.ts, service.ts, settings-kit.ts, store.ts, and agent-checks.ts (new). An agent imports `./kit/npu.ts` where it imported `./npu.ts`.
- **web**, at `src/kit/web/`: settings-panel.js, and settings-panel.css (new).
- **spec**, at `src/kit/spec/`: npu-queue-vectors.json (was test/), NPU-QUEUE.md (was Reeve's docs/NPU-QUEUE.md) and ACCELERATORS.md (was Manor's docs/ACCELERATORS.md). This is now their home; each says so. The kit's npu-queue.ts is now the original of the NPU queue, and Reeve's src/npu-queue.ts its copy.
- The kit reaches the agent's own code through two fixed paths, `src/app.ts` and `src/settings.ts` (the agent interface, in the Steward's README).

**Changes over the hires' copies:**
- settings-kit.ts and settings-panel.js are Manor's newer copy. `SettingsSpec` takes an optional `usedFrom`, the panel's first line saying when a saved change is used ("from the next round on" when it's left out, as before). Backwards compatible.
- Reeve not set up reads the same in each case: no config.json (Reeve writes none on a PC without an NPU), an empty `accelerators` list (Reeve's setup dropped the install's `npu` entry), or a list where nothing serves anything. The message is "Reeve isn't set up here: open Reeve's page, Settings → Set up (or run `reeve accelerators setup`)" (`REEVE_NOT_SET_UP` in accelerators.ts), without the config's path, and an agent's `npu.problem` says it. A list whose entries can't be read is named as such ("lists no accelerator that can be used (…)"). A config that serves some kinds but not the one asked for (no vision, say) keeps its message naming the kind. Like every message of the kit's model code, it has no full stop of its own: an agent ends its sentence as it always has ("No notes: ….", or none), so none shows two.
- The Settings panel's styles moved out of page.ts's CSS into web/settings-panel.css; page.ts links it as `/settings.css`, and server.ts serves it beside `/settings.js`, from the web part. An agent without the web part has no panel (both answer 404). `button.link` and `button.small` stay in page.ts, for every page.
- release.ts (src/kit/release.ts) finds the agent's root above src/kit, refuses to build unless `src/kit/VERSION` is the version `kit.json` pins, and writes `"kit": "<version>"` into release.json and the release notes. A release also carries `kit.json` and `tools/kit.ts` (a change to either makes it dirty), so an unpacked release can fill its kit again, and the installed Steward has the tools/kit.ts it hands out. install.ts's `Release` has the optional `kit`.
- tools/kit.ts, the one file each agent keeps, is the Steward's: `steward bump` copies it into each agent with the new pin, so a change to it is released and rolled out as a kit version.
- agent-checks.ts is new: the kit's checks of the agent it is in (its package.json and src/app.ts agree, src/kit is the pinned kit, it has art/icon.svg, and its settings schema, defaults and normalize agree, as each hire's settings-kit.test.ts checked). An agent runs them from one line, `test/agent.test.ts`: `import '../src/kit/agent-checks.ts';`.
- The kit's own tests (accelerators, npu-queue, kit, install, settings-kit) run in the Steward against a fixture agent, kit\test\fixture, and no longer in each agent. test/kit.test.ts and test/npu-queue.test.ts, the same in every hire but for its name, are among them.
