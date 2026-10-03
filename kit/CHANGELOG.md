# The kit's changelog

Each version of the Steward's kit, newest first. A version is released as `kit-v<version>` (tools/kit-release.ts), and each agent takes it by pinning it in its `kit.json`. An entry says what an agent's maintainer needs to know: what changed, and anything the agent must do.

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
