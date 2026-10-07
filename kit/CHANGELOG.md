# The kit's changelog

Each version of the Steward's kit, newest first. A version is released as `kit-v<version>` (tools/kit-release.ts), and each agent takes it by pinning it in its `kit.json`. An entry says what an agent's maintainer needs to know: what changed, and anything the agent must do.

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
