# The kit's changelog

Each version of the Steward's kit, newest first. A version is released as `kit-v<version>` (tools/kit-release.ts), and each agent takes it by pinning it in its `kit.json`. An entry says what an agent's maintainer needs to know: what changed, and anything the agent must do.

## 2.146.4

**A repository's name keeps its server's own port: a GitLab or Gitea of your own at `http://127.0.0.1:8929` is named `127.0.0.1:8929/group/app`, so anything keyed by its name reaches it there.**

### What changed

- **manor.ts' `Origin` has a `port`** where an http or https remote gives one other than its scheme's own (80, 443), on a host that isn't a public one (github.com, gitlab.com, bitbucket.org, Azure DevOps, codeberg.org, gitea.com). It's a number, and the key is there only then: every other origin is as it was. An ssh remote's port is ssh's, not its site's, and isn't kept.
- **`originName`** gives such a repository as `host:port/path`. A name without a port is exactly as it was, so no stored name changes.
- **`originOfName`** reads `host:port/path` back as `https://host:port/path`, its `port` kept. A name never says http: an http server's page, and the way to reach it, come only from its clone's own origin. A name whose port isn't one (0, past 65535) is null.
- **`repoNameOk`**, and the Seneschal's own check of a task's repository, take a port from 1 to 65535 on a name's first part only: not `:0`, `:65536`, an empty port, a leading 0, or a port on a later part.
- **An Azure DevOps Server of your own** on another port has its page at that port.

### What's new

- **`sameRepoName(a, b)`**: whether two names are one repository's. They match if they're the same but for case, or the same once one's port is taken off and the other has none. A name stored before 2.146.4 (`127.0.0.1/group/app`) still matches the one its clone gives now (`127.0.0.1:8929/group/app`). Two different ports are two servers.

### Before you update

- **Code that compares a name from `originName` with a name stored before** (settings, a project's `repo`, a record) should compare them with `sameRepoName`. For a server on its own port, the two now differ by the port.
- **A regex of your own that checks a repository's name** should take `:port` on its first part, or use `repoNameOk`. Otherwise a name with a port is refused.
- **Code that cuts a name's host off its path** (`name.split('/')[0]`, `slice(hostName.length + 1)`) gets `host:port`. `--hostname` (glab) refuses that; take the port apart from the host, or reach the server at its address (`GITLAB_HOST`).
- **Tests** that `deepEqual` a `parseOrigin` of an http(s) URL with a port of its own see `port` now, and a name from one has the port.

## 2.146.3

**assistants.ts, tried with the real assistants: Copilot CLI is the eleventh, each assistant says the names it connects by, Claude Desktop from the Store and Cline 4 are connected where they read their settings now, claude runs in the home it was given, and CODEX_HOME and GEMINI_CLI_HOME are followed.**

### What's new

- **Copilot CLI** (`copilot-cli`, an id added to `AssistantId`): GitHub Copilot's CLI keeps its servers in `~/.copilot/mcp-config.json` (`COPILOT_HOME` moves the folder, as its CLI reads it). The kit writes its entry as `copilot mcp add` does (`"tools": ["*"]`, `"type": "local"`, then its command, arguments and env), so a server added either way reads as the same. VS Code's Copilot Chat is still `vscode`.
- **`clients`** on every assistant: what it calls itself when it connects to an MCP server (its clientInfo name: `copilot-cli`, as Copilot CLI 1.0.105 gave it, `claude-code`, `claude-ai`, `cursor-vscode`, …), as the agents have seen it. `assistantOfClient(name)` gives the assistant a connected client is.
- The Staff page spec names the eleven.

### What changed

- **Claude Desktop from the Store** keeps its data in `%LOCALAPPDATA%\Claude-Data\Claude_pzs8sxrjxfjjc` now, and leaves its old folders with a `.user-data-left` marker. Its servers were written to the package's old copy, which it no longer reads: they go in `Claude-Data`'s `claude_desktop_config.json` now, whenever that folder is there.
- **Cline 4** keeps its servers in `~/.cline/data/settings/cline_mcp_settings.json`, shared with its own CLI, and no longer reads or makes VS Code's storage copy: the kit didn't find Cline at all. Once `~/.cline/data` is there, that file is the only one read and written.
- **Claude Code:** `addServer` and `removeServer` run `claude` in the `home` and `env` they were given (its `CLAUDE_CONFIG_DIR`, else that home), as `serverStatus` reads them. It ran in this process's own environment, so it added to this account's Claude Code and then said the server wasn't there. A test's `run` is handed that environment as its third argument.
- **Codex CLI and Gemini CLI:** `CODEX_HOME` (Codex's `.codex` itself) and `GEMINI_CLI_HOME` (the home its `.gemini` is in) are followed, as `CLAUDE_CONFIG_DIR` is for Claude Code.
- **Live tests:** `kit/test/assistants-live.test.ts`, skipped unless `STEWARD_LIVE_ASSISTANTS=1`, runs Claude Code, Codex CLI, Gemini CLI, Copilot CLI, VS Code and Cursor's agent CLI both ways round in temp homes. With `STEWARD_LIVE_APPS=1` too, it starts Zed, and VS Code with Cline and with Continue, each in a temp profile (their windows open), and sees each start the kit's server beside the person's own.

### Before you update

- Nothing to do. `copilot-cli` is a new `AssistantId`: code that names every id (a `switch` over them, a list of its own) has one more to name.

## 2.146.2

**The Repositories spec says where a repository's own build and release steps are: its `.steward.json`.**

### What's new

- **spec/REPOSITORIES.md:** a repository's `.steward.json`, committed at its top, says how the Steward builds, tests, versions and releases it, over the Steward's Settings and the keys' old meanings. A repository with no `repo` (one on this PC alone) is released only as its `.steward.json` says.

### Before you update

- Nothing: no code changed.

## 2.146.1

**git-auth.ts says what a runner does with `env`: it lays it over the command's own environment, never runs a command with it alone. The sign-in's git settings are numbered after the ones that environment already has.**

### What changed

- **node/git-auth.ts, `GitRunOptions.env`, `GitRunner`, `signedIn`, `scriptEnv`:** documented. `signedIn` hands its inner runner only its own few variables: `git credential fill`'s QUIET ones, or a sign-in's GIT_CONFIG_* entries numbered after the GIT_CONFIG_COUNT of `{...process.env, ...opts.env}`. A runner that took `env` as the whole environment ran `git credential fill` with no PATH, home or git settings. It also ran a signed fetch with GIT_CONFIG_KEY_3 and up but none from 0, which git refuses: "missing config key GIT_CONFIG_KEY_0", "unable to parse command-line config". The Assayer's runner did this; the Assayer fixes it in its own runner. No code changed here.
- **test/assistants.test.ts:** the test of Claude Code on a Linux PATH passes on Windows too. A Windows folder's drive colon split it, so its folder is now given relative to the current one.

### Before you update

- Nothing for a runner that spawns with `{ ...process.env, ...opts.env }`, as the Steward's and Reeve's do. A runner whose commands get an environment of their own (a session's) passes that environment whole in `env` to the runner `signedIn` wraps, its GIT_CONFIG_COUNT included, and lays the `env` `signedIn` hands back over that same environment.

## 2.146.0

**A repository may be on any host, or on none: GitHub, GitHub Enterprise, GitLab (subgroups and self-hosted too), Bitbucket, Azure DevOps, Gitea, Forgejo and Codeberg, any other git server, or a folder on this PC. And an agent that is an MCP server can connect itself to ten AI assistants, adding only its own entry to each one's settings.**

### What's new

- **node/manor.ts, `parseOrigin(url, hint?)`:** a remote's place, `{ kind, hostName, path, webUrl }`, however its URL is written: https with or without .git, ssh://, scp-style, git://, file://, a drive, a share or a relative path. `kind` is `github`, `gitlab`, `bitbucket`, `azure`, `gitea`, `other` or `local`. GitLab keeps its subgroups; Azure DevOps reads as `org/project/_git/name` from each of its forms; Bitbucket Data Center drops its `scm/`. A host is known by its name (`kindOfHost`), or by a hint from settings, which never changes a public host. Null for what isn't a remote.
- **node/manor.ts, `originOf(checkout, hint?)`:** a clone's origin on any host, from its git config (a worktree's through its main clone); `local` for a clone with no origin, null for a folder that isn't a clone. `originRepo` is unchanged: GitHub's owner/name or null.
- **node/manor.ts, `originName`, `originOfName`, `repoNameOk`, `projectOrigin`, `HOST_KINDS`:** the manor's name for a repository (owner/name on github.com, as always; host/path elsewhere; local/<folder>), read back, checked, and a tracked repository's place.
- **node/manor.ts, `projectsFrom`:** a project's `repo` may be host/path on any host, or its clone URL (read as owner/name on GitHub, host/path elsewhere). A new `host` key says the kind where a host's name doesn't (a self-hosted GitLab). A folder given as a `repo` is refused, in a sentence.
- **node/assistants.ts:** `ASSISTANTS` (Claude Code, Claude Desktop, Cursor, VS Code with Copilot, Windsurf, Gemini CLI, Codex CLI, Cline, Continue and Zed, with each one's settings files on Windows, macOS and Linux), `assistantsFound(home?, options?)` (the installed ones), `serverStatus(id, name, options?)` (`not-installed`, `installed` or `connected`; it only reads), and `addServer(id, server, options?)` and `removeServer(id, name, options?)`. Only the agent's own entry is added, changed or removed. Each file is edited in place, keeping comments in JSON with comments, TOML and YAML, and it is backed up once, to `<file>.castellan.bak`, before the first write. Nothing is written for an assistant that isn't installed, a file that doesn't parse is refused in a sentence and left as it is, and a secret in a server's env or arguments is refused. Claude Code's ~/.claude.json is never written: its server is added with `claude mcp add --scope user`, or, without the claude command, `paste` gives the line to run. Claude Desktop from the Microsoft Store uses its package's own copy of its settings.
- **react/staff.tsx, `ConnectAI`'s `assistants`, `onConnect` and `onDisconnect`:** the assistants on the PC as rows (`AssistantRow`), each with its state, Connect or Disconnect, the text to paste where the agent can't write, and why where its settings don't parse. The installed ones come first.
- **react/styles.ts:** the `.ui-assistants` and `.ui-assistant` rules.
- **node/seneschal.ts, node/work-status.ts:** a task's repository, and a peer's result's, may be host/path on any host. `work.ts`'s line says git clone for one off GitHub.
- **spec/REPOSITORIES.md, spec/STAFF-PAGE.md:** the `repo` and `host` keys, any host's place, and the assistants' rows.

### What changed

- A project whose `repo` was a clone URL was left out; it is read now.
- A Seneschal task or a peer result whose repository has a part starting with "-" is refused (one never names a real repository; it would read as an option to git).

### Before you update

- Nothing for an agent on GitHub: its projects, staff.json and results read exactly as before, and a project has no `host` key unless its entry gives one. An agent that builds GitHub URLs from a project's `repo` should use `projectOrigin(p).webUrl` instead, or check that the repo is owner/name first, because it may now be host/path. A page that copies the kit's CSS by hand copies the `.ui-assistant` rules too.

## 2.145.0

**Every block of output has a copy button at its top-right: `Output` carries one, and `CopyButton` puts one in a page's own `<pre>`. One click copies the whole block, the lines scrolled out of sight too.**

### What's new

- **react/staff.tsx, `CopyButton`:** a small button with the copy glyph, made the first child of a `<pre>` (`<pre><CopyButton text={all} label="The setup's log" />{shown}</pre>`). It copies `text`, all of it, which may be more than the block shows (a run's whole log under its last lines). Once copied its glyph is a check in `--ok` for two seconds, then the copy glyph again. It floats right, so the first line wraps short of it rather than running under it, and it is sticky, so it stays at the block's top as the block scrolls (or the side panel, in a `SidePanel`). Its name is "Copy: <label>", or "Copy all of it" with no label, and "Copied" once copied, said politely; its word is hidden but for a screen reader, and its tip on hover is the same word. It is a plain button: it never holds the page busy.
- **react/staff.tsx, `copyText(text, near?)`:** the clipboard's `writeText`, and where the page may not use it, the browser's copy command from a hidden field placed in `near` (so a modal dialog's focus trap lets it be selected), with the focus put back. True once copied. Where neither copies, `CopyButton` selects its block's text and says "Press Ctrl+C". `Paste` copies with it too.
- **react/icons.tsx:** the `copy` glyph (Ionicons' name): two sheets, one in front of the other.
- **react/staff.tsx, `Output`:** has a `CopyButton` as its first child, for its `text` and `label`.
- **react/styles.ts:** `button.ui-copy` (on the block's own background, `--muted`, the page's font, `--hover` under the pointer, `--ok` once copied, pointer or not, the focus ring in `--accent`), and in a side panel `.ui-output` no longer scrolls on its own (the panel scrolls, so Copy stays at its top).
- **test/browser.ts, `Tab`:** `key` (Enter, Space, Tab), and `click` and `hover` with the mouse, as a person's would be.
- **spec/STAFF-PAGE.md:** every block of output has Copy at its top-right: `Output`, or a `CopyButton` first in a page's own `<pre>`.

### Before you update

- A page with its own `<pre>` of output (a log, a command's lines, a report to be sent) puts `<CopyButton text={…} label="…" />` first in it, or uses `Output`. A page that copies the kit's CSS by hand (Manor's app.css) copies the `button.ui-copy` rules too.

## 2.144.2

**An update's probation watcher outlives the install that started it again: it starts apart from the install's jobs, so the last agents of Manor's update round finish their probation and clear app.prev, rather than being ended with Manor's install.**

### What changed

- **node/safeinstall.ts, the probation watcher (`safeDeps().watch`):** started apart (apart.ts `startApart`, out of the jobs that let it leave), and detached only where it can't be (not Windows, no launcher). Manor's install runs at the owner's pace in a gentle job of its own (gentle.ts `containSelf`), and every program it starts is in that job too. Merely detached, a watcher was ended with Manor's install, with no line in probation.log, leaving its probation.json and app.prev behind, whenever the round ended within its 90 s probation: always for the last agent or two of a round, and for an agent updated alone. Its probation went unwatched for the rest, so an update that stopped answering then wasn't rolled back.
- **node/apart.ts, `startApart`:** a `cap` option. `0` leaves the program out of the model servers' job (`apart:0`), for a program that only needs to outlive its starter. Left out, it is the servers' cap, as before.
- **test/checks-pace.test.ts:** on Windows, a starter at the gentle pace starts one program detached and one apart, then ends: the detached one ends with it, and the one apart runs on.

### Before you update

- Nothing: it updates itself as usual. An agent whose last update left probation.json and app.prev behind clears them at its next update.

## 2.144.1

**Ready for the Workshop Pro plan: every agent accepts a Workshop Pro license (tier `workshop-pro`) and runs under it as it does under Workshop, and a PC holding one has what Developer Pro brought, now named Workshop Pro: the Wright's and the Bailiff's work with the rest of the staff, and the Seneschal. Until now a license of a tier the kit didn't know was refused as no license at all, so this kit reaches every agent before the Exchequer signs one.**

### What's new

- **node/license.ts:** `LicenseTier` gains `'workshop-pro'`, and `LICENSE_TIERS` lists the tiers a license may have: `household`, `workshop`, `workshop-pro` and `trial`. An agent's own tier is `free`, `household`, `workshop` or `workshop-pro`, each holding the ones before it; a trial holds every one.
- **node/developer-pro.ts, `workshopProLicense`:** whether this PC holds a Workshop Pro license: Manor's licence.json verified offline, of tier `workshop-pro`, made for this PC, paid, waiting for its first payment or lapsed. It is read again only when licence.json changes, or an hour on (a stat per call), and under `node --test` only with `MANOR_LICENSE_CHECK=on`, as the license check. `forgetWorkshopProLicense` drops the reading, for tests.

### What changed

- **node/license.ts, `verifyLicense`:** a license whose tier is `workshop-pro` verifies. One of a tier not in `LICENSE_TIERS` is still refused ("its payload isn't a license's"), so the agent holds as it does with no license for this PC.
- **node/license-check.ts, `judgeLicense`:** a Workshop Pro license runs every agent, whatever its tier, the Wright, the Bailiff and the Crier included: paid, waiting for its first payment, or lapsed (Freehold), as a Household or Workshop license does. A trial already ran everything, and still does. `licenseCheckOn` moved to license.ts, and license-check.ts exports it as before.
- **node/developer-pro.ts, `developerPro`:** yes on the maker's laptop, as before, and now also on a PC holding a Workshop Pro license, so every agent that asks shows and does the Wright's, the Bailiff's and the Seneschal's work there without a change of its own. A trial doesn't turn it on yet: Workshop Pro isn't on sale, so a trial mustn't show its staff; once it is, a running trial joins (the place is marked in `holdsWorkshopPro`). `CASTELLAN_CUSTOMER=1` still answers no, a license and all, and `developerProForTests` still stands in for the whole PC.
- **Developer Pro is named Workshop Pro** in words: the Seneschal's line in the staff's work list (work.ts, "It comes with Workshop Pro"), node/seneschal.ts, node/developer-pro.ts and spec/WORK-STATUS.md. Code names (`developerPro`, developer-pro.ts) stay.
- **test/license-check.test.ts:** a Workshop Pro license verifies and runs every agent, paid, pending and lapsed; a license of an unknown tier holds. **test/developer-pro.test.ts:** a Workshop Pro license for this PC turns it on, paid, pending and lapsed; a running trial, Household, Workshop, another PC's license, a bad signature, an unknown tier or none don't; `CASTELLAN_CUSTOMER=1` still answers no; under `node --test` no license is read without `MANOR_LICENSE_CHECK=on`; a changed licence.json is read at once, an unchanged one kept an hour. test/seneschal.test.ts matches the new words.

### Before you update

- Nothing: it updates itself as usual.

## 2.144.0

**While a button's action runs, the whole page waits: the button pressed spins, and every control on the page is disabled until the action is done, has failed or has timed out, then focus is back where it was. A page's own button whose handler awaits `post()` gets it too.**

### What's new

- **react/page-busy.ts:** the page's wait. `holdPage()` holds it until the call it returns, or `PAGE_WAIT_MS` (30 s; `pageWait(ms)` sets another) at most; `pageHeld()` says whether it waits. `openDialog()` marks a dialog open (`ModalCard`, `SidePanel` and the page's own confirm and alert do): one opened while an action runs is usable, one opened before it waits with the page. A listener on the document notes the last press (a click on a button, a link, a switch, a box or a tab, a form's submit, a choice in a list) and forgets it as someone types in a text field.
- **react/busy.tsx, `PageArea`:** the page's own busy area, a fieldset with no box of its own (`display: contents`), so the page lays out as it did. While the page waits it is disabled, with `aria-busy` and the busy cursor, and its links and pressable cards take no presses; its controls dim only after 0.3 s, so a quick action doesn't flash the page. Focus comes back to where it was once the button pressed is enabled again.
- **react/shell.tsx, `Page`:** the banners, the page, Settings, About, the tour and the footer are in one `PageArea`, the title bar's action (Run now) in another. The title bar's way out (back to the manor, the agent's name, About, Settings) and its Theme menu stay usable, so a request that doesn't answer never traps anyone; so does the out-of-date banner's Reload.
- **spec/PAGE-ACTIONS.md:** what an action button is (`PostButton`, a `Button` whose `onPress` returns its promise, `BusyButton`; never a bare `<button onClick>` with a `fetch` of its own), what holds the page and what doesn't. spec/STAFF-PAGE.md's rules and react/index.ts say the same.

### What changed

- **react/busy.tsx, `useTracked`:** the work a kit button tracks (`Button`'s `onPress` promise, `BusyButton`'s `onClick` promise, `PostButton`'s POST and its look for news after) holds the whole page, as well as its `BusyArea`. A button's own `loading` or `busy` doesn't: that is long work the page shows itself.
- **react/page-data.ts, `post`:** a POST a press started (within 10 s of it with no typing between; a handler that asks first, even with the browser's `confirm()`, still counts) holds the page while it runs, 2.143.3's retry with the new token included, and the button pressed spins (`data-ui-busy`; styles.ts draws the spinner in its icon's place). A `post()` no press started (an auto-save as someone types, a timer's) doesn't, nor does polling (`usePageData`'s looks are GETs of their own).
- **react/modal.tsx, `ModalCard`, and react/staff.tsx, `SidePanel`:** each tells the page it is open (`openDialog`), before focus moves into it.
- **react/index.ts:** exports `PageArea`, `holdPage`, `pageHeld`, `pageWait`, `PAGE_WAIT_MS` and `openDialog`.
- **test/react-page-busy.test.ts (new), with test/browser.ts:** a page on the kit's `Page` in a real browser (Edge, Chrome or Chromium, headless; skipped on a PC without one). `BusyButton`, `PostButton` and a plain button awaiting `post()` each disable the whole page and spin, then come back on success, failure, a refused token and a timeout, focus where it was. Polling and a `post()` as someone types don't hold it. A confirm the action asks and a dialog it opens are answerable; a dialog open before it waits. A `BusyArea` inside still works, links and cards wait, and the title bar's Settings link doesn't.

### Before you update

- Nothing for a page whose actions are `PostButton`s, kit `Button`s whose `onPress` returns its promise, `BusyButton`s, or handlers that `post()`: from this kit on, the whole page waits on them. A page whose own code sends an action with `fetch` gets none of it: send it with `post()`, or hold the page with `holdPage()` until its request answers (a streamed answer, say). A dialog of the page's own making that an action opens while it runs waits with the page: make it a `ModalCard`. A handler that asks with the browser's `confirm()` still works; `confirmDialog` is the page's own.

## 2.143.3

**A page left open while its agent updated, or restarted, saves again: its server starts with a new token each time, so the tab's POSTs were refused, and Save said only "forbidden" until the tab was reloaded.**

### What changed

- **react/page-data.ts, `post`:** a POST the server refuses for its token (403, `forbidden`) reads the token as the server has it now from the page itself (`GET /`, which the browser's cookie signs in where GETs are strict, open where they aren't), keeps it for the POSTs after, and sends the same POST once more, never more than once. Where the page gives no token (strict, and the cookie no longer taken), nothing is sent again, and the error says plainly that the page is out of date since the agent updated (or restarted), to reload it and try again.
- **react/shell.tsx and react/settings-form.tsx:** then a banner at the top of the page says the same with a Reload button, and the Settings form's bar offers Reload beside Save. Neither reloads by itself: with changes not saved, the browser asks first, as before.
- **react/index.ts:** exports `freshToken` (the token as the server has it now, kept in the page) and `useOutOfDate` (the out-of-date words, or null), for a page whose own code POSTs with `pageToken()` and its own fetch rather than `post`.
- **test/page-restart.test.ts:** `post` against the fixture's server started again with a new token, strict and not: it saves; with the cookie no longer taken, it says to reload; and a POST refused again is sent twice at most.

### Before you update

- Nothing for a page that POSTs with `post` (its Settings form and its PostButtons do): a tab opened from this kit on recovers by itself; one opened before needs a reload once. A page whose own code POSTs with `pageToken()` and its own fetch gets none of this until it uses `post`, or `freshToken` on a 403 `forbidden`.

## 2.143.2

**The keeper's looks no longer set a lock folder's time against the clock: on Windows a folder's time often runs a millisecond or two ahead of `Date.now()`, so a slot taken just before a look could make the next look count the shared folder's next change, an agent's work turn say, as this accelerator's let-go.**

### What changed

- **node/keeper.ts, `lastUseMs` (the NPU refresh's and patch's quiet wait) and the Reaper's let-go (`letGoMs`):** "in use since the last look" is the accelerator's own lock folders' time having moved since that look (one file time against another), or held then. It was that time set against the clock at the look. A slot taken a moment before a look no longer lets a work turn, or another accelerator's let-go, count as this one's use, which kept the NPU's quiet wait, or a server's idle time, going longer than it should. Nothing else changes.
- **test/keeper.test.ts:** the quiet wait's taken-and-let-go-between-looks case no longer depends on the disk and the clock agreeing to the millisecond (it failed once in 2.143.1's whole suite, and 1 run in 400 under load on a Snapdragon X2), and a new case sets the folders' times a little ahead of the clock, as Windows' often are.

### Before you update

- Nothing: it updates itself as usual.

## 2.143.1

**A call Envoy captions on the NPU comes first: the staff's background model work waits for the call's end, and when the call doesn't translate, the NPU's servers stop once unused for two minutes. Beside the NPU's chat model answering, Envoy's speech slowed (Whisper small's decoder steps tripled on a Ryzen AI 7 350), and on AMD the NPU itself timed out.**

### What's new

- **node/accelerators.ts:** `npu-call.json` in the shared accelerators folder, beside `games.json`: `{ by, pid, since, at, translating }`. The agent captioning a call writes it with `holdNpuForCall({ by, translating, since? })` at the call's start, every `NPU_CALL_EVERY_MS` (20 s) while it lasts and when `translating` changes, and removes it with `releaseNpuForCall(by)`. `npuCallNow()` reads the call on now: the file not written again for `callFreshMs` (60 s, rules.json's accelerators) counts as no call. `readNpuCall()` and `npuCallFile()` are there too.
- **core/accelerators.js, `candidates`:** a new `call` (the core's `callOf` and `callNow`). While one is on, a background request doesn't take the NPU (skipped as `call`, "Envoy is captioning a call on the NPU"). With the NPU first, that leaves it no candidate, so it is deferred as on a busy NPU (`whyNone`'s busy), never moved to a graphics card or the processor. A request someone is waiting on still has the NPU. npu.ts reads the call for every background request and for `budget`.
- **node/keeper.ts:** while a call that doesn't translate is on and nobody has used the NPU for `callGraceMs` (2 minutes, rules.json's keeper), the NPU's servers stop (`stopped-for-call`), in the NPU's turn, as a game's card does. A call that translates keeps them. The memory guard's own reaper doesn't stop for calls.
- **spec/ACCELERATORS.md:** "Calls", and `npu-call.json` under "Shared files".

### Before you update

- Nothing for most agents: it updates itself as usual. Background work on the NPU now waits while Envoy captions a call, so a round during a call defers its model work to a later round. Envoy writes `npu-call.json` from its next release on this kit; until then, nothing changes. Reeve's own routing reads the file from its own release.

## 2.143.0

**Every agent's About page opens with What's new: its own changelog's entries for the versions its latest updates brought, newest first, so a person sees what changed after an update that moved through several versions, not just the last one's notes.**

### What's new

- **react/whats-new.tsx, at the top of the About view (`#/about`):** a **What's new** section, each version under its own heading ("Version 0.4.31 · updated 27 October"); with several, the newest is open and the older are folded. Entries are drawn as text, never as HTML: the bold line, `###` headings as small headings, `- ` points as a list, `**bold**` and `` `code` ``, a link as its words. The page asks for them as About first opens, so nothing is read on any other look. About is there whenever it has a What's new, even with nothing else to say.
- **node/whats-new.ts:** `versions.json` in the data folder records each version the agent first started at, and when (`{ "versions": [{ "version", "since" }] }`, oldest first, at most 30). `serve()` writes it as the page starts, only when the version changed; a copy with no record yet starts it after the version its update kept in `app.prev`. About shows the entries of every version newer than the one that ran before the latest update, and those of its other updates in the last 30 days, at most 10; a fresh install shows its own version's entry. `GET /api/whats-new` is a new kit route (`{ versions: [{ version, since, entry }] }`), and `PageShell.whatsNew` says whether there is anything to show.
- **node/release.ts:** a release carries `CHANGELOG.md`, cut to its opening and newest 20 entries (notes.ts's `releaseChangelog`). Until now an installed copy held no changelog at all. notes.ts also gives `entriesOf()` (every entry in one pass) and `compareVersions()`.

### Before you update

- Nothing: it updates itself as usual. The section appears from the agent's first release on this kit, which is the first to carry its changelog; until its next update it shows that version's entry, or the versions since the one in `app.prev`. An agent with its own route named `/api/whats-new` must rename it (none has one). Reeve's and Manor's own release scripts don't carry the changelog yet, so their About shows no What's new until they do.

## 2.142.3

**The shared video switch is called "Keep GPS and camera details in video copies". Its old name, "Keep a video's place and camera details", read as where the videos are kept, and sent the owner to Manor's Staff settings looking for a folder setting that isn't there.**

### What changed

- **node/shared-settings.ts, `keepVideoTagsField()`:** the label is "Keep GPS and camera details in video copies", and its default help says "where it was filmed (GPS)" without "its place included". The key (`keepVideoTags`), its values and what it does are unchanged, on an agent's own Settings and on Manor's.

### Before you update

- Nothing, unless the agent passes its own `help` that speaks of "a video's place" (the Miller's does): say "where it was filmed" there instead.

## 2.142.2

**spec/RELEASE-NOTES.md says how every agent rides the build pipeline: its work writes its changelog entry in changes/, and the Steward's build sets the version.**

### What changed

- **spec/RELEASE-NOTES.md, "The kit bump":** a kit bump writes its entry in `changes/steward-kit-<kit, dots as dashes>.md` and sets no version, adding `changes/README.md` where it's missing. Only an agent worked with plain git is bumped the old way.
- **"Entries in changes/"** describes the pipeline as it is: `claim-version` names `changes/<your branch>.md`, the work leaves the version files and `CHANGELOG.md` alone, and the Steward's next build stamps main in a pull request of its own. A pull request opened before the switch, which set its version itself, still merges cleanly, and the stamp waits for it while it's next in its version line.

### Before you update

- Nothing: it updates itself as usual. Once Steward 0.36.248 is installed, its next build puts each agent on the build pipeline, in a pull request it opens and merges itself; from then on, write each piece of work's entry in `changes/<branch>.md` and leave the version files and `CHANGELOG.md` alone.

## 2.142.1

**A page in demo mode no longer shows "This PC holds no license for it", so Manor's hero pictures show each page as it is on a licensed PC.**

### What changed

- **node/license-check.ts, `shownHold()`:** what the page shows of a license hold, the same as `licenseHeld()` but none in demo mode (`KIT_DEMO`). The kit's page (node/page.ts) and React shell (node/react-page.ts) use it for the banner and the status pill.
- Only what the page shows changed: a demo's rounds and Run now still hold without a license, its ping still says so, and a demo runs no rounds anyway.

### Before you update

- Nothing.

## 2.142.0

**A link to a part of the page in a tab not shown opens that tab, a time still to come reads "in 6 hours", and an empty number setting says what empty means.**

### What changed

- **react/staff.tsx, `showSection`:** a part in a hidden page tab (`PageTabs`) has its tab chosen first (`SHOW_TAB`, as the tour does). The page then scrolls to it once the tab is drawn. Glance's tiles use it, and so does any agent's in-page link that calls it.
- **`ago()`, in node/page.ts and react/time.ts:** a time more than 45 seconds ahead reads "in 6 hours" or "in 2 days", not "just now". A clock a moment ahead still reads "just now".
- **react/settings-form.tsx:** a `nullable` whole or number field says what its empty box means ("Empty: The variant's own…"), as a text field already did. It no longer draws a bare empty box.

### Before you update

- Nothing breaks.
- **A test that renders a future time and expects "just now"** finds "in …" instead.

## 2.141.0

**Settings and tabbed pages take less room: no box inside the Settings panel, no headings over an empty table, tabs that stay put, and a tab's title said once.**

### What changed

- **react/settings-form.tsx:**
  - The form's busy area draws no border or padding of its own: the panel holds the fields directly, not in a second box (react/styles.ts' `.sf-panel .ui-busy-area`, over settings-panel.css' boxed `.sf-panel fieldset`).
  - An empty records list or map draws no table and no headings, only its Add.
  - A flat records table has no column for a `hidden` field. The field's value is still kept in each record.
  - A long form is in tabs at `TAB_FIELDS` = 8 ordinary settings (it was 10). They're counted over every one the form has, shown now or not (`shownWhen`), so the tabs no longer come and go as a switch shows its fields. A hidden one never counts, and there are never tabs with only one to show.
  - A form that can't be loaded says the server's own `error`, not only its status.
  - The line naming the settings set on Manor puts each in quotes ("Look for new clips every" is set with…).
- **react/ui.tsx, `Section`:** in a page tab of the same name (`PageTabs`, matched without case), it leaves its title, icon and count to the tab. It keeps `leading` and `right`, and draws no heading row without them (`TabLabel`).
- **react/styles.ts:** a page tab's first heading, section or card has no top margin, so the gap under the tabs is the tabs' own.
- **server.ts, GET /api/settings:** an agent with no rounds (no `every()`) and no `usedFrom` of its own says its settings are used "from now on", not "from the next round on". `usedFrom` must still read after "They are used " ("at once", "from the next look on").
- **settings-kit.ts, `settingsReply`:** in a demo (`KIT_DEMO`), a developer's form names its file where it would be on Alex's PC (`shownDataDir()`), never the picture-taker's folder.
- **shared-settings.ts:** `manorSharedFields()` and `MANOR_SHARED_DEFAULTS`, the settings Manor's Staff settings keeps for the whole staff and their defaults, so Manor reads them from the kit (spec/SHARED-SETTINGS.md).

### Before you update

- Nothing breaks.
- **A Settings form of 8 or 9 ordinary settings, in two or more groups or named tabs,** is in tabs now. Look at it once.
- **A `Section` titled as its page tab** no longer repeats its title. Take out any agent-side workaround.
- **A test that matches an empty records or map field's `<table>` or its headings** finds none.

## 2.140.0

**The settings the staff share are set once, on Manor's Settings (Staff settings), and an agent's own Settings leaves them out; a list of short words is drawn in columns.**

### What changed

- **shared-settings.ts:** each shared field says where Manor keeps it (`inManor`, spec/SHARED-SETTINGS.md).
  - The agent's own value, which Manor's Settings shows and saves through the agent (`'own'`): `roundEveryField`, `modelCallsField`.
  - One value for the whole staff, in Manor's settings.json `"shared"` (`'shared'`):
    - `plainNotesField`.
    - New: `semanticRerankField`, `videoQualityField` (the `preset` key: smaller, balanced, better) and `keepVideoTagsField`.
  - `readPlainNotes` takes Manor's value first when it says one it can use, and so do the new `readSemanticRerank`, `readVideoQuality` and `readKeepVideoTags`. Otherwise they fall back to the agent's own value, then the default.
- **manor.ts:**
  - `manorShared(key)`: Manor's value, read afresh.
  - `sharedSettingsManor()`: the Manor whose Settings show them.
  - `manorStaffSettingsUrl()`: `#/settings/staff`.
  - Under node --test none is read unless a test says where.
- **settings-kit.ts, `settingsReply` and `saveSettingsReply`, by where they're asked from (`FormPlace`, `formPlace(query)`; server.ts passes the request's):**
  - **The agent's own page, with Manor installed:** the fields with `inManor` are left out. The reply says them as `inManor: { manor, url, labels }`, and a save naming one is refused with where it's set.
  - **`?manor=1`, Manor's Settings:** only those fields; a save takes only the `'own'` ones.
  - **Without Manor:** every field, as before.
- **react/settings-form.tsx:**
  - The whole form says the fields set on Manor in a line, linking to its Staff settings. Onboarding's few settings don't.
  - `SettingsForm`'s new `api` is where it's read and saved (/api/settings unless said).
  - A list of more than two short words (no path, none over 24 characters) is drawn in columns rather than one a line (web/settings-panel.css' `.sf-short`).
- spec/SHARED-SETTINGS.md (new) says all of it.

### Before you update

- Nothing breaks: a field built by hand has no `inManor` and stays on the agent's page.
- **To move a shared setting to Manor:**
  - Build it with its factory.
  - Read it with its read function. Clerk and Chamberlain read `semanticRerank` by hand; Miller and Chronicler read `preset` and `keepVideoTags` by hand.
  - Take the agent's own default from DEFAULT_SETTINGS.
- **A test that counts an agent's settings fields under node --test** sees them all, as before: no Manor is read there.

## 2.139.0

**The kit's page talks like the manor: newcomers wait their turn at the door, the off-duty put their feet up by the fire, and an agent short of settings is awaiting orders.**

### What changed

- **node/page.ts and react/shell.tsx**, the wording only:
  - The status pill for missing required settings says **Awaiting orders** (was "Needs settings"). Its title stays plain: "Waiting for its settings before it can start: …". The React shell's banner leads with **Awaiting orders** too.
  - Off duty, in the pill's title and both banners: "Off duty since 2 hours ago, feet up by the fire: its scheduled rounds are paused. Run now still works."
  - Settling in (`settlingText`): "Reeve is new to the manor and waits their turn at the door: newcomers do their first rounds one at a time, so this PC is never swamped. They start as soon as the one before them has finished." While it runs: "Reeve is learning the lay of the land in their first round: …". The waiting pill's title says "newcomers to the manor" for "agents new to the manor".
- **node/update-hold.ts, `updateWaiting`:** a round held for Manor's update waits for "Castellan to teach it the new skills of 0.4.2 (its update), a few minutes at most: lessons wait until it's idle".
- Left plain on purpose: what went wrong (`stoppedWaiting`, which the Surveyor reads), `ping`'s summary, the installer's lines Manor reads, the logs, and license and held-back text.

### Before you update

- A test that pins any of these lines needs the new words: `Awaiting orders`, `waits their turn at the door`, `is learning the lay of the land in their first round`, `Castellan to teach it the new skills of`, and `, feet up by the fire` after the off-duty time.
- Nothing else: the page's structure, classes and every value Manor reads are as they were.

## 2.138.0

**The whole staff employed at once: rounds placed apart on each PC by Manor's rota, staggered after a start or a wake, a model loaded only under the manor's memory ceiling, and at most 2 or 4 agents' text readers at once.**

### What changed

- **rota.ts (new), Manor's rota:** `rotaEntry(who)`, `rotaPhase(who, schedule, everyMs)` and `rotaStartAt(who, schedule)` read `<Manor's folder>\rota.json`, which Manor keeps on each PC from the staff's round.json (Manor#415). It places each schedule's phase anywhere in its interval where the day's load is least, the busiest rounds first and salted by the PC, and each agent's place in the start window. It's read leniently through the file cache: no rota, or a malformed one, keeps the clock's phases and a random place, as before. A phase counts only for the interval it was placed for. Under node --test none is read unless a test gives `every()` a `rotaHome`.
- **schedule.ts, `every()`:**
  - A round's phase on the clock is the agent's own `phaseMs`, else the rota's, else `clockPhase()`'s, as before. round.json's new `phaseFrom` says which (`agent`, `rota` or `clock`; spec/ROUND.md).
  - The first round after a start comes in the start window (`startWindow(pace)`: 2 to 15 minutes at a gentle pace, 30 s to 3 minutes at a full one, as before), at the rota's place for the schedule or its agent, else by chance.
  - **New:** a scheduled round whose timer fired 2 minutes or more late (`WOKE_LATE_MS`: the PC slept) waits its place in the start window again before it runs, unless its rounds are `light`. A round the person asks for runs at once, as before.
- **memory-guard.ts (new), the memory guard,** called from `accelerators.ts`' start, so before every model server starts:
  - It needs the model's files (`modelBytes`: llama-server's `-m` and `--mmproj`, OpenVINO's `--model_path`, OpenVINO Model Server's `--source_model` folder) and the 15% of memory the manor's ceiling leaves (`headroomBytes`, at least 1.5 GB) in what Windows has available. A card with its own memory is left alone.
  - Short of it, it stops the manor's other servers unused for 30 s, the longest unused first, in the keeper's turn on each (`pcReaper`, which takes a `log` now). It never stops one in use, one whose idle stop config.json turns off, or another on the starting server's accelerator.
  - Still short, a person's request looks again every 10 s for up to 2 minutes, then starts anyway. Background work waits up to 30 s, then starts nothing: `ensureServer`'s new `whenShort: 'defer'` throws `NoRoomToLoad`, and `npu.ts` gives background requests that option and defers them (`NpuBusy`, "model work deferred for 5 min", that accelerator left alone for `backOffMs`), as for a model still loading.
  - Its lines go in the keeper's log, `memory guard: …`. Under node --test it looks at nothing unless `ensureServer` is given a `room` stand-in.
- **ocr-npu.ts, readers at once:**
  - At most 2 agents' text readers run at once on a PC under 24 GB, 4 with 24 GB or more (`readersAtOnce`). An agent's readers (the NPU's and the processor's) take one place between them in a line every agent shares (`ocr-readers`), before either starts and never inside the NPU's turn.
  - They keep the place while one runs. When another agent waits, they end after the batch they're reading, never in its middle, and give it up; the next batch starts them again from the cache.
  - A place not had in 5 minutes is gone without: the reader starts anyway, since the model reads more exactly than Windows OCR.
  - `modelReader`'s new `cap` option gives the places, or `null` for none. Under node --test there are none unless a test gives them.
- spec/ROUND.md (Phase, Start, `phaseFrom`), spec/ACCELERATORS.md (Room to start a server) and spec/OCR.md (Readers at once) say all of this.
- This release brings 2.137.2's changes too.

### Before you update

- A test that moves the clock past a scheduled round's time with mock timers (`setTime`) before ticking it now sees the round wait its place in the start window first. Tick to the round's time, or make it `light`.
- A test that compares a whole round.json record on the clock needs `phaseFrom`.
- Nothing else: an agent's own `phaseMs` and `firstDelayMs` keep their meaning, and a background request that finds no room to load its model is deferred as a busy NPU's is, which agents already handle.

## 2.137.2

**Three fixes from the launch checks: a video the kit makes no longer carries where it was filmed, the known folders come back right whatever script a user or folder name is in, and "Back to Castellan" goes to Castellan's own address.**

### What changed

- **ffmpeg.ts, video copies' tags:**
  - New `tagArgs(info, all?)`: `-map_metadata -1`, then only `creation_time` and each track's language, by name, and `-movflags +faststart`. Where the video was filmed, the camera's make, model and serial number, the owner's name and every other tag stay with the original, as they do for photos. Rotation needs no tag: the picture is turned upright as it's re-encoded.
  - `grindArgs` takes `tags` (tagArgs' options). Left out, the copy carries none of the original's tags. Before, it carried every one (`-map_metadata 0` with `+use_metadata_tags`).
  - `shrinkVideo` takes `keepTags`: true keeps every tag, as copies did before. Leave it off unless the person asks, as the Miller's `keepVideoTags` setting does.
  - `media-probe.ts`: `parseProbe` gives each track's `language` (ISO 639-2) when it names one ("und" is none).
  - No staff member calls the kit's `grindArgs` or `shrinkVideo` yet: the Miller and the Chronicler have their own copies. The Miller's already keeps only these tags; the Chronicler's still keeps every one.
- **folders.ts, the known folders:**
  - `knownFolders()` asks Windows in one PowerShell script, UTF-8 end to end (`KNOWN_FOLDERS_SCRIPT`): `[Environment]::GetFolderPath(..., 'DoNotVerify')` for Desktop, Documents, Pictures, Music and Videos, and the registry's User Shell Folders, expanded, for Downloads, Screenshots and Captures. The usual places are the fallback, as before.
  - Before, it read `reg.exe query`, which answers in the console's code page: a user or folder name in another script (Jürgen, Документы, 書類) came back mangled, and the folder wasn't found.
  - Downloads is read by FOLDERID_Downloads' GUID. The GUID here before was another one, so a Downloads folder moved elsewhere was never found.
  - `knownFolders()` is still synchronous and still read once, through the new `powershellSync` (ps.ts), about 0.2 s the first time. When Windows doesn't answer, it gives the usual places and asks again 10 minutes later, where before it kept the usual places until the agent restarted.
  - New `readKnownFolders(ask?)` runs the script (a stand-in in tests). `foldersFrom` reads the script's JSON, and a `reg query`'s text as before; a value that isn't a full path is no place to look.
  - The Cellarer, the Chronicler, the Miller, the Scribe, the Toller and the kit's own `captures.ts` read these folders.
- **manor.ts, the Back link:** `manorLink().url` is `http://castellan.localhost:<port>/` (`MANOR_HOST`), the address Manor's own links use since Manor 0.11.0. It was `manor.localhost`, which Manor still answers and sends a browser on from. "Back to <manor>" in `page.ts` and `react/shell.tsx`, the locked page's "Open from <manor>" and the developer-options note all follow it.
- **page-access.ts:** `pageToken` and `pageHeaders` read Manor's token for `castellan.localhost` as they do for `manor.localhost`, so a GET to Manor's page by its link is still signed in. `manorAnswers` still asks at `manor.localhost`, which every Manor answers.

### Before you update

- A test that pins `manorLink().url`, or anything built from it, as `http://manor.localhost:…` needs `castellan.localhost`, or a check that holds for both.
- A test that pins `grindArgs`' `-map_metadata 0` needs `tagArgs`' options, or `tags: tagArgs(info, true)` for every tag.
- Nothing else: the exports and their results are the same.

## 2.137.1

**The text reader's helper is prebuilt and signed again: `kit/node/prebuilt/ocr-npu-87e019a2736d.exe`, for `ocr-npu.cs` as it is since 2.137.0.**

### What changed

- **prebuilt/:** `ocr-npu-87e019a2736d.exe`, compiled and signed by `tools/sign-helpers.ts` (Certum, SHA-256, timestamped). 2.137.0 changed `ocr-npu.cs` and removed `ocr-npu-8d1348367dd3.exe`, so since then each PC compiled the helper itself, unsigned, which Smart App Control may block.
- The other five helpers are unchanged.
- 2.137.0 was never released on its own; this release brings it too.

### Before you update

- Nothing to do. An agent that pins this kit uses the signed helper (`signedHelper`), even on a PC where it compiled its own before.

## 2.137.0

**AMD's XDNA 2 NPU (Ryzen AI 300 and later) reads with the text reader's model by default, with a copy of model 2 made for it (`ocr-model-v2-amd`). Measured on a Ryzen AI 7 350, a picture costs 27% less energy there than on its processor (3,492 mJ against 4,757), and it reads 1,221 of the check's 1,253 lines, against the processor's 1,224 and Windows OCR's 736. The three lines are the owner's call.**

### What changed

- **ocr-npu.ts: AMD's NPU reads by default.**
  - `VITISAI_GENERATIONS` (`['xdna2']`): `packFor` gives an AMD chip of that generation `VITISAI_PACK` (npu-vendors.json's 17F0). The first XDNA (1502), and an AMD PC whose NPU isn't known, read on the processor as before.
  - `AMD_MODEL_FILES` pins the release `ocr-model-v2-amd`: its `det.onnx` and `rec.onnx` (int8, 1.6 MB in all), `LICENSE.txt` and `NOTICE.txt`, each by size and SHA-256. They go in `model-2-amd` beside model 2's folder and read with model 2's `charset.txt`. The processor's reader, the self-check's yardstick, reads model 2.
  - `KIT_OCR_NPU=vitisai` stays a test, where the NPU isn't an XDNA 2. `none` still reads on the processor.
  - A PC's first start compiles the copy's nine graphs in the background, as before: 97 s, three at once, on an idle Ryzen AI 7 350, or three to seven minutes each beside a busy processor. Compiled, they keep 35 MB. The FP32 model's took half an hour.
- **ocr-npu.cs:**
  - `--npu-models <folder>`: the NPU's reader reads that folder's models, while the processor's reads `--models`.
  - `enable_cache_file_io_in_mem=0` in VitisAI's options. Without it an int8 compile stays in memory, so every start compiled again and the program, finding no compiled graphs, read on the processor.
  - `AmdWidths` is gone: the int8 recognizer compiles at all of `Reader.Buckets`' eight widths, to 2,048, where the FP32 model's stopped at 1,024.
- **prebuilt/:** `ocr-npu-8d1348367dd3.exe` is removed, as `ocr-npu.cs` changed. Each PC compiles the helper itself, unsigned, until `tools/sign-helpers.ts` signs it again.
- **tools/ocr-model/** makes the copy (its README's "AMD's NPU's copy"):
  - `gelu_free.py` swaps each of model 2's GELUs (13 in the detector, 10 in the recognizer) for `polygelu`, x times a polynomial gate of clips, products and sums, within 0.0054 of the GELU. AMD's NPU computes those exactly, where its own GELU is coarse and its sigmoid a table.
  - `train.py --onnx --act polygelu --teacher` fine-tunes the swapped recognizer a little toward model 2's own, and `export.py --rec-only` writes it.
  - `screens.py` draws whole screens and pages, to calibrate the detector.
  - `amd_int8.py` rewrites both models as AMD's compiler takes them and quantizes them: 8-bit weights per channel, 16-bit activations. It writes the release's four files, its notice from `NOTICE-amd.txt`.
  - `distill_det.py` is what was tried for the detector, kept with its result: it only lost boxes.
- **spec/OCR.md** ("Intel and AMD") has the measurements, what reads differently, and what was tried before. "The exceptions (the owner's calls)" names the lines given up on Intel's NPU and the X2 (2026-10-24) and on AMD's (2026-10-25).

### Measured (spec/OCR.md, "Intel and AMD")

On a Ryzen AI 7 350 on 2026-10-25 (VitisAI plugin 1.8.75, Windows ML 2.4.89), with the manor stopped and the display held on: the check's three runs, and the energy the median of three interleaved rounds of its 32 GDI pictures:

| Model 2 on the Ryzen AI 7 350 | Lines read exactly | A picture beyond the start | Its processor time | Its energy over rest | A start |
|---|---|---|---|---|---|
| FP32 on the processor | 1,224/1,253 | 255 ms | 754 ms | 4,757 mJ | 13.6 J |
| AMD's copy, int8, on the NPU | 1,221/1,253 | 540 ms | 56 ms | 3,492 mJ | 57.3 J |

- A start on the NPU costs 44 J more, saved back after about 35 pictures. At the agent's gentle pace the processor costs 5.2 J a picture, so the NPU saves a third there.
- The NPU reads six lines worse than the processor and three better, each by a space, a letter or a quote mark. Every group still reads far better than with Windows OCR.

### Before you update

- Nothing to do. On a Ryzen AI 300 or later, after the update the PC fetches AMD's copy (1.6 MB) and Windows ML (52 MB fetched, 1 MB kept) once, in the background, compiles the copy's graphs, and reads on the processor until they're in place. The program's self-check still compares the NPU's read with the processor's before it reads there.
- A new model needs a new AMD copy, made and measured again, before it ships, or `VITISAI_GENERATIONS` emptied, since the copy's release is named after `MODEL_VERSION`.

## 2.136.6

**Three fixes before launch. Install and uninstall refuse an empty, relative or someone else's data folder. FFmpeg prefers the manor's signed build, and borrows Heiward's only while it can't be fetched. Model setup weighs the NVIDIA driver and the PC's memory, and by default sets up only the cards with memory of their own.**

### What changed

- **install.ts: the data folder is checked before anything is touched.**
  - `homeRefusal(dataDir)` refuses three kinds of data folder: an empty `<ID>_HOME`, one that isn't a full path (`C:\…` or `\\server\share\…`), and one whose `app` isn't the agent's. An `app` is the agent's when the folder is named for it, or when its release.json, app.old's or app.prev's names the agent's id.
  - install and safeInstall refuse such a folder with exit 2, before any swap and before app.prev.
  - `uninstallRefusal(dataDir)` asks homeRefusal's question, and also refuses a folder that is neither named for the agent nor holds a copy of it.
  - uninstall refuses with exit 2 before --dry-run, and before any task is asked about, ended or deleted. Before, an empty or relative `<ID>_HOME` made a plain uninstall delete `.\app` in whatever folder it ran from, and made an install move that `app` aside and delete it.
  - `refusedHomeLine` says why, and says to set `<ID>_HOME` to the full path or to remove it.
  - `purgeRefusal`'s "holds a copy of it" is now that release.json marker, as Manor's purge asks, not any `app` folder.
  - The default data folder (`%USERPROFILE%\.<id>`) always passes.
- **ffmpeg.ts: the manor's signed build first.**
  - `toolDirs` looks in this order: the setting, the shared build, the agent's own, PATH, the one used last, `also`, then Heiward's. Before, PATH and the one used last came before the manor's build.
  - `HEIWARD_SOURCE` labels Heiward's folder wherever it's reached (on PATH, or as the one used last), except in the setting.
  - video-shrink.ts' `decideEncoder` fetches the manor's build when only Heiward's is found. It borrows Heiward's only while that fetch fails, and its `why` says so.
  - Borrowing isn't counted as `ownFailed`, so the decision stays fresh and no test encodes run again. getFfmpeg's 15-minute wait between tries keeps the retries cheap.
  - The Miller's own `src/ffmpeg.ts` isn't changed here.
- **detect.ts: each card's display driver.**
  - DETECT_PS prints Win32_VideoController's `display|<driver>|<PNP id>|<name>` lines.
  - `parseDisplays` and `withDrivers` give each GpuCard its `driver`, matched by name, else by maker.
  - A failure to read them is quiet: the driver is then unknown.
- **setup.ts: which build.**
  - `variantFor` takes `driver`. An NVIDIA card whose driver is known and older than `CUDA_MIN_DRIVER` (551.61, CUDA 12.4's minimum) gets `vulkan-x64`, with a `why` that the plan's line shows.
  - `nvidiaDriver` reads NVIDIA's number from Windows' version.
  - A card whose driver is unknown gets CUDA, as before.
  - A card whose entry already runs a CUDA build keeps it, so set-up-again and repairs never move it.
- **setup.ts: which cards, and what fits.**
  - With no ids, `planSetup` sets up the cards with memory of their own (`OWN_MEMORY_GB`) that a build runs on. Shared-memory cards are set up only when there's none. The plan's new `notes` name each card left out.
  - With no usable card, the processor is set up. Before, that happened only on a PC with no card at all.
  - `SHARED_SERVER_GB`, `SHARED_MEMORY_SHARE` (0.4, the NPU's share), `sharedNeedGb` and `sharedFit` keep shared-memory cards and the processor, together, within 40% of the PC's memory.
  - When their servers don't fit, vision is left off first, then the reranker, then the embeddings. Chat is kept.
  - When even chat doesn't fit, nothing is set up there: a note when no ids were given, a target's `problem` when it was named.
  - Kinds given (`kinds`, or `cpuKinds` for the processor) are kept, so set-up-again, repairs and the processor's pass after a failed NPU are unchanged. When the PC's memory is unknown, the plan is made as before.
  - `SetupTarget.leftWhy`, `SetupPlan.notes` and `leftToNpu[].variant` are new, all optional. runSetup now asks for CUDA's catalogs only for a card left to the NPU that would get a CUDA build.
  - SMALL_SPEC is already the smallest model everywhere, so the models don't change.

### Before you update

- Nothing: it updates itself as usual. An agent's own tests that compare a `leftToNpu` entry whole will find its `variant` too.

## 2.136.5

**GenieX's QAIRT clock keeper is off: GENIEX_CLOCK_KEEPER_THREADS 0 goes in the environment of every GenieX the kit starts, so AI Hub's 4B no longer keeps a processor core spinning through every answer (qualcomm/GenieX#1330). Speed, memory and answers are unchanged. A PC set up before gets it from npu-refresh, after its test. The 4B's X2 pins are AI Hub's v0.65.0 build, with the earlier build kept.**

### What changed

- **npu-vendors.json:** the qualcomm route's `env` is `{ "GENIEX_CLOCK_KEEPER_THREADS": "0" }`.
  - `npuEntry` puts it in the chat entry's `env`, beside GENIEX_IMAGE_MAX_TOKENS, and `playedRoute` keeps it.
  - The embedding server and the reranker (llama-server) don't get it. Nor do the Intel and AMD entries.
  - `serverEnv` replaces a variable of that name in any case, so one set on the PC doesn't turn the clock keeper back on.
- **Measured on the X2 Elite with the 4B,** npu-bench quick, three runs each way, interleaved (spec/NPU-VENDORS.md, GenieX's QAIRT clock keeper):

  | | On (before) | Off (now) |
  |---|---|---|
  | GenieX's processor while it writes | 1.04 cores, 26.1 ms a token | 0.05 cores, 1.2 ms a token |
  | GenieX's processor over the whole run | 0.83 cores | 0.23 cores |
  | Writing | 40.7 tokens a second | 40.5 tokens a second |
  | First token after 512, 1,024 and ~2,050 tokens | 247, 398, 933 ms | 243, 398, 924 ms |
  | Working set / private memory | 6.12 / 1.69 GB | 6.12 / 1.69 GB |

  - The answers that differed, asked 30 more times each way: 59 of 90 with it on, 56 of 90 with it off, missed the same ways in both.
  - Energy isn't measured yet.
  - GenieX's llama.cpp plugin, which runs the 2B, has no clock keeper, so there the variable changes nothing.
- **A PC set up before gets it from npu-refresh,** with no new setup.
  - Its keeper sees `GENIEX_CLOCK_KEEPER_THREADS=0 added`. Once the NPU is idle, it stops GenieX in the NPU's turn, tests the new entry and writes it. If the test fails, it keeps the old entry.
  - An X Elite on its 4B fallback keeps the 4B.
- **The 4B's X2 pins** (`pinned["snapdragon-x2"]`) are now AI Hub's current build: models release v0.65.0, QAIRT 2.50.0, pulled 2026-10-25.
  - It replaced the 2026-10-04 build the kit had pinned. That build is kept in `earlier`, so an X2 that pulled it still passes `checkPinned`.
  - On an X2, only npu-bench's `--model qualcomm/Qwen3-VL-4B-Instruct:W4A16` pulls the 4B.
- **Agents need nothing of their own.** Reeve and the Smith start GenieX from its config.json entry, whose `env` `serverEnv` already applies.

### Before you update

- Nothing: it updates itself as usual. The first time the manor's keeper (the Smith, else Reeve) runs this kit with the NPU idle, it restarts GenieX once to test the new entry.

## 2.136.4

**A kit entry marked urgent makes every agent's kit bump an urgent fix too: the Steward rolls that kit out in its own urgent build and builds each agent as its bump merges, in minutes rather than at the next build. spec/RELEASE-NOTES.md says so.**

### What changed

- **spec/RELEASE-NOTES.md, The kit bump:** a kit entry whose bold line starts `Urgent fix:` makes each agent's bump entry start `**Urgent fix:`, naming the kit (`**Urgent fix: it carries the Steward's kit 2.136.1, with an urgent fix to the parts every agent of the manor shares.**`; a later plain kit that brings it names it in brackets). Its release is then published urgent, as any marked entry is.
- **Nothing else in the kit changes.** The Steward 0.36.234 does the rest:
  - its urgent rule (stages/urgent.ts) reads `kit/CHANGELOG.md` and `kit/changes/` too, so an urgent kit merged alone begins an urgent build of the Steward's own;
  - that build waits for the kit's trial and whole suite (until now it closed while the kit was tried, and released nothing), releases the kit and the Steward, and rolls the kit out to every agent still behind it (`kitRides` with the urgent kit; a plain kit is still left to the next build);
  - each bump's entry reads the kit's whole changelog from its `kit-v<kit>` tag, so it sees urgent kits that were never released on their own;
  - the build closes with the next round two minutes on, which finds each agent's urgent entry on its main and builds it at once, for its repository alone.
- **Why:** kit 2.136.1, an urgent fix, merged at 03:44Z on 2026-10-25. Its bumps (Clerk 0.5.84 and the rest) had a plain bold line, and the urgent build took no kit, so every agent waited for the 14:00Z build and released at 14:10Z.

### Before you update

- Nothing: it updates itself as usual.

## 2.136.3

**On AMD, a ticked reranker runs on the Radeon beside the NPU with "Use the graphics card for models when there's an NPU" off, Manor's default, as on Intel since kit 2.135.5: started by the first rerank, stopped once unused. Nearly the same ranks as the processor's, in a third of the time and a hundredth of its processor time. Chat stays on the NPU. AMD's own NPU reranker was tried and is parked.**

### What changed

- **The owner's ruling (2026-10-25):** "Yes: on AMD too, a ticked reranker goes to the Radeon on demand even with the switch off, like Intel's; it stops when idle."
- **Before this, with the switch off, a ticked reranker didn't run on AMD.** The Smith's Set up names the kinds, so the Radeon was set up with the reranker. Then the core's rule beside the NPU took the card's reranker away from every request, and AMD's NPU doesn't rerank. Unless the processor had been set up for it, Reeve searched without it.
- **Data only:** AMD XDNA 2's generation in npu-vendors.json adds `rerank` to its `order` (`routes.amd.generations.xdna2.order.rerank`): the Radeon, then the processor. Its `basis` gives the figures below and the ruling. The rest is kit 2.135.5's, unchanged:
  - setup writes the order apart from `workOrder`, as `rerankOrder` (a kit before refuses a `rerank` in `workOrder`), and puts a ticked reranker on the Radeon, not the processor, the switch on or off;
  - the core's `cardWorkBesideNpu` and `withoutGpuBesideNpu` keep the Radeon its reranker beside the NPU, with its pictures and embeddings; never chat;
  - the keeper stops the reranker's server after `gpuIdleStopMinutes` unused (5 on a PC under 20 GB) and never starts it;
  - the keeper's look (npu-refresh.ts' `orderNow`) writes `rerankOrder` once to a PC set up before;
  - set-up-again (`orderAdds`) gives the Radeon a reranker where the processor took the one the person ticked; the processor's stays, next in the order.
  - AMD's other generations, Intel's and the Snapdragons' are unchanged.
- **What was measured** (Reeve's 24 captured reranks, each a search's first ten files from its keyword search, about 1,600 characters a file; the Dell 14, Ryzen AI 7 350 with the Radeon 860M, 16 GB; Qwen3-Reranker-0.6B Q8_0 on llama.cpp b11734 with the kit's flags; three interleaved runs each, the manor stopped, 2026-10-25):
  - Blended as Reeve's search blends: the right file first for 12 of 24 on both; in the top five for 19 on the Radeon and 20 on the processor; mean reciprocal rank 0.638 on the Radeon and 0.629 on the processor. The same first file for all 24.
  - Ten files: 3.08 s median (p90 3.49) on the Radeon, 9.09 s (p90 10.04) on the processor.
  - The processor's time a rerank: 0.70 s with the Radeon, 73.8 s on the processor.
  - Memory while it runs: about 2.0 GB on the Radeon (it shares the PC's), 1.2 GB on the processor (1.4 GB at its peak), freed when the server stops. Energy isn't measured yet.
- **AMD's NPU reranker, tried and parked** (NPU-VENDORS.md, Reranking on AMD's NPU). The build ran Qwen3-Reranker-0.6B on the XDNA 2 through VitisAI in BF16, and stopped at its accuracy gate:
  - it ranked a little worse than the Radeon, by an amount that moved from compile to compile, and was slower on every set;
  - it needed a 36-minute compile of up to 6.3 GB, and an unsigned helper.
  - Its code stays on the `claude/amd-npu-reranker` branches (Steward's 6acfe36, Reeve's c7a7fa7). The versions they carry (kit 2.137.0, Steward 0.36.233, Reeve 0.18.77) are no longer theirs: a reopened build takes new ones.
  - **What would reopen it:** a later VitisAI plugin that compiles a16w8, or a BF16 compile within the Radeon's error of FP32. The last layers or the score head on the processor is untried.
  - Clerk and Chamberlain rerank by embeddings; Reeve's search is the only caller of `/v1/rerank`.
- **Tests:**
  - npu-vendors: AMD XDNA 2's order has the Radeon first for a reranker, with its basis. Setup beside AMD's NPU with the switch off or on puts a ticked reranker on the Radeon, not the processor, writes `rerankOrder` apart, and leaves the Radeon its pictures, embeddings and reranker beside the NPU. Nothing ticked: no reranker, as before.
  - card-on-demand: AMD with the switch off keeps the Radeon's reranker on demand. Its server is started by the first rerank, stopped by the keeper once unused, never restarted. Chat never goes to the card, the NPU failed or not.
  - npu-refresh: the keeper's look writes AMD's `rerankOrder` to a PC set up before, nothing else changed.
  - set-up-again: an AMD PC whose processor took the reranker gains the Radeon's, gently, with no errors in its log. A PC with no reranker, one whose Radeon has one, or one with an order of its own gains nothing.
  - accelerators: the core keeps the Radeon's reranker by AMD's order, and never by an order without one.
- **Docs:** NPU-VENDORS.md (a new The reranker on AMD's Radeon; Reranking on AMD's NPU, tried and parked; Each work's order on a generation) and ACCELERATORS.md (`rerankOrder`, set up again, The graphics card beside the NPU).

### Before you update

- Nothing: it updates itself as usual. An agent that routes its own requests with `withoutGpuBesideNpu` should read the order with `workOrderIn(raw)`, as Reeve does from 0.18.79.

## 2.136.2

**A schedule stops its rounds after three failed in a row, until the agent is updated or Run now goes through. An error no round can get past is met three times, not every interval all day.**

### What changed

- **Why:** on kit 2.136.1's error (spawn ENAMETOOLONG), the Clerk's round failed 36 times in 24 hours, and Manor's card counted every one. The owner: "We need it to stop trying after 3-5 attempts if it isnt working".
- **schedule.ts's `every()`** counts the rounds in a row that failed: thrown, or run past the time limit. One that waited for the network or its turn is neither a failure nor a round that went through.
  - At `STOP_AFTER_FAILURES` (3), its scheduled rounds stop. The log says so once. Its state's `nextRunAt` is null, and its `waiting` says "its rounds stopped after 3 failed in a row: they start again once it's updated, or when Run now goes through".
  - `runSoon()` and `reschedule()` start none while they're stopped, so the `round` repair doesn't restart them either.
- **round.json** keeps `failedInARow` on each failed round, and `"stopped": "<version>"` with `waiting` on the one that stopped them (spec/ROUND.md).
  - A restart at the same version stays stopped, and the log says so at its start.
  - At another version (the agent updated), the rounds go on, counted afresh.
- **Run now always runs.** One that goes through starts the rounds again. One that fails leaves them stopped.
- **`every()`'s `stopAfterFailures`** sets another count for a schedule that must keep trying; 0 never stops.
- **Tests:** kit/test/round.test.ts covers:
  - three failures stop the rounds, and runSoon and reschedule start none;
  - a restart keeps them stopped;
  - a failed Run now leaves them stopped, and one that goes through starts them again;
  - another version starts them, counted afresh;
  - a round that waited for the network doesn't count;
  - 0 never stops.

### Before you update

- Nothing in an agent's code: take the kit and release. An agent whose rounds must never stop passes `stopAfterFailures: 0` to `every()`.

## 2.136.1

**Urgent fix: the PowerShell worker starts in a signed release. Since kit 2.123.0 signed ps-worker.ps1, it was too long for a command line: no agent released since could start its worker (spawn ENAMETOOLONG), and every `powershell()` call failed.**

### What changed

- **What broke:** a release signs its scripts (kit 2.123.0), and the signature block took ps-worker.ps1 from 3.4 KB to 18 KB. ps.ts started the worker as `-EncodedCommand`, its text as UTF-16 in base64: about 48,000 characters, over the 32,767 a Windows command line holds. `spawn` threw ENAMETOOLONG at every start. It threw out of `powershell()` itself, not as a rejection, so the script never fell back to a powershell.exe of its own.
  - Seen on the owner's laptop from 2026-10-24 21:34Z, in each agent released signed (Chamberlain, Clerk, Envoy, Manor, Reeve, the Steward, the Surveyor). Clerk's rounds failed in OCR's `runScript` and `otherAlphabetLanguages`. Every one's pace was set by priority alone ("the full pace couldn't be set beyond priority"). Manor couldn't look at the accelerators.
- **ps.ts' worker runs from its file** (`-File`, with `-ExecutionPolicy Bypass` as before): its length no longer matters, and its signature counts where Windows checks one (Smart App Control).
- **A worker Windows won't start at all** (spawn throwing, for any reason) no longer fails the script. It runs on its own (`oneShot`), and so does every later script in that process, as when powershell.exe can't start.
- Unchanged: a script sent to the worker goes on its standard input, and a long one on its own goes in as a temporary file.
- **Tests:** kit/test/ps-worker.test.ts runs ps.ts with a worker signed as a release signs it (a signature block of the same size).
  - As `-EncodedCommand`, Windows refuses it (ENAMETOOLONG).
  - Through ps.ts it starts, and a 40,000-character script runs in it, and on its own from a temporary file that is removed after.
  - Where the worker's spawn throws, scripts run on their own, and the start is tried once.

### Before you update

- Nothing in an agent's code: take the kit and release. An agent released on kit 2.123.0 or later needs this kit for its PowerShell to work.

## 2.135.5

**On Intel, a ticked reranker runs on the graphics card beside the NPU with "Use the graphics card for models when there's an NPU" off, Manor's default: started by the first rerank, stopped once unused. The same ranks as the processor's, in about half the time and a hundredth of its processor time. Chat stays on the NPU.**

### What changed

- **The owner's ruling (2026-10-24):** "Yes: on Intel, a ticked reranker goes to the graphics card on demand even with the switch off, like AMD's pictures; it stops when idle."
- **Before this, with the switch off, a ticked reranker didn't run on Intel.** The Smith's Set up names the kinds, so the card was set up with the reranker, the switch on or off. Then the core's rule beside the NPU (`withoutGpuBesideNpu`) took the card's reranker away from every request, and no Intel NPU reranks. Unless the processor had been set up for it, Reeve searched without it.
- **The rule is data:** Intel's route in npu-vendors.json has an `order` of its own (`routes.intel.order`, NpuRoute's new `order`): `rerank`, the graphics card, then the processor, for every generation, an unknown one too. `workOrderFor` puts a generation's own order over its route's, work by work.
  - AMD's route has none: its reranker waits for its own VitisAI trial. The Snapdragons' have none: an X2's NPU reranks.
  - Another vendor joins by data alone: an `order.rerank` with the card first.
- **The core:** a work order may order a reranker (`OrderedWork`, `ORDERED_WORKS`). `cardWorkBesideNpu` keeps a card's reranker where the order puts the card first for it, and `withoutGpuBesideNpu` keeps it on the card's copy. Never chat, as before.
- **config.json's `rerankOrder`:** the reranker's order is written apart from `workOrder`. A kit before 2.135.5 refuses a `workOrder` with any work but chat, vision and embed, and would then refuse every later write of config.json (the Smith's Settings, the keeper's look).
  - The core's `workOrderIn(raw)` reads the two as one work order. `readWorkOrder` reads `workOrder` alone, as before.
  - setup.ts' `withWorkOrder` writes both, each taken out when the order has none.
  - `validateAccelerators` checks `rerankOrder` as one work's order, and still names a `rerank` in `workOrder`.
  - `rerankOrder` is in `KEEPER_KEYS` and `ACCELERATOR_KEYS`, so it moves and is mirrored with the rest.
- **Every caller follows it:**
  - npu.ts' requests: a rerank goes to the card and starts its server.
  - keeper.ts' `gpuKeptOut`, `cardOnDemand` and `reapedServers`: the keeper stops the card's rerank server after `gpuIdleStopMinutes` unused (5 on a PC under 20 GB) and never starts it.
  - setup.ts: a ticked reranker goes on the card, not the processor, the switch on or off, and `rerankOrder` is written.
  - npu-refresh.ts' `orderNow`: the keeper's look writes `rerankOrder` once for this kit, so a PC set up before gets it without being set up again.
- **A PC set up before:** one whose card has the reranker uses it as soon as the keeper's look has written the order. One whose processor took it gains the card's at set-up-again (`orderAdds`, as AMD's pictures in kit 2.135.3), and the processor's stays, next in the order. One with no reranker gains none.
- **What was measured** (Reeve's 23 search questions, each one's first ten files from its keyword search, about 500 tokens a file; a Core Ultra 5 225U's Intel Graphics, 16 GB; Qwen3-Reranker-0.6B Q8_0 on llama.cpp b11734 with the kit's flags; 2026-10-24):
  - Blended as Reeve's search blends: the right file first for 12 of 23, in the top five for 18, mean reciprocal rank 0.621, on the card and the processor alike. Keyword search alone: 8, 17, 0.502.
  - Ten files: 7.9 s median (p90 8.6) on the card, 16.2 s (p90 17.7) on the processor.
  - The processor's time a question: 1.67 s with the card, 193 s on the processor.
  - Memory while it runs: about 1.9 GB on the card (it shares the PC's), 0.66 GB on the processor, freed when the server stops.
  - Batching the ten files otherwise moved the card's times by under 5%. Energy isn't measured yet.
- **Tests:**
  - Intel with the switch off: the card keeps its reranker alone beside the NPU, its server started by the first rerank and stopped by the keeper once unused, never started by it. A person's `acceleratorOrder` keeps it out. The switch on is unchanged.
  - The X2 keeps its NPU reranker, the card's staying out. AMD's card reranker stays out for now.
  - Setup on Intel: a ticked reranker on the card, not the processor, `rerankOrder` written and no `workOrder`; nothing ticked, as before.
  - The update path: the keeper's look writes `rerankOrder` to an Intel PC set up before, and takes both orders out where the generation has none. A processor's reranker gains the card's at set-up-again; a card that has one, or a PC with none, gains nothing.
  - config.json: `rerankOrder` checked and read, `withWorkOrder` writing the two apart; new accelerator vectors.
- **Docs:** NPU-VENDORS.md (a new The reranker on Intel's graphics card; No reranker on Intel's NPU; Each work's order on a generation) and ACCELERATORS.md (`workOrder`, `rerankOrder`, set up again, The graphics card beside the NPU).

### Before you update

- Nothing: it updates itself as usual. An agent that routes its own requests with `withoutGpuBesideNpu` (Reeve's router) should read the order with `workOrderIn(raw)`, not `readWorkOrder(raw.workOrder)`, so it sees `rerankOrder` too.

## 2.135.4

**A 16 GB Snapdragon X2 reranks on its NPU, beside chat and embeddings, as a bigger PC does. Measured there with a 16 GB PC's memory: nothing failed, chat wasn't slowed, and the NPU held 4.7 GB against its 6.2 GB share.**

### What changed

- **Setup's rule for the NPU's reranker:** a PC under 20 GB (`smallPc`) now gets it on a generation its route's `rerankServer.smallPc` names. Through kit 2.135.3 no small PC did, and the reranker went to the graphics card or the processor.
  - npu-vendors.json names `snapdragon-x2` alone, with what was measured as its `basis`. The new `rerankFits(route, generation, ramBytes)` in npu-vendors.ts decides it, and setup.ts calls it where it checked `smallPc` before.
  - The first-generation Snapdragon X keeps the rule as it was. It wasn't measured, its pictures are read on the Adreno, and its fallback Qwen3-VL-4B with both llama-servers would put the NPU over its share.
  - Intel's and AMD's routes have no NPU reranker, so nothing changes for them.
  - The reranker doesn't give way to chat as the embedding server does. Giving way would add 0.1 to 0.3 s to the chat that stops it and about 1.1 s to the next rerank, to free memory the measured levels didn't need. The keeper stops it when idle as it stops the embedding server, at the small PC's 5 minutes.
- **What was measured** (the X2 Elite Extreme, 2026-10-24, a ballast leaving 9.7 GB available, and another leaving 15.6 GB in all, each level twice):
  - The NPU held 4,660 MB with all three loaded: GenieX 2,454 MB, each llama-server 1,103 MB. That is 1.5 GB under the 40% share of a 16 GB PC and 3.1 GB under the 7.8 GB Windows lets one device hold.
  - With 9.7 GB available at rest, 4.9 to 5.1 GB stayed available with all three loaded.
  - Nothing failed, and the System log showed no DSP restart. `testNpuRerank` passed, and Reeve's 24 queries reranked as on 2026-10-23.
  - Ten files reranked in 858 to 865 ms (median). Chat, pictures, embeddings and GenieX's quality items were the same with the reranker loaded as without.
- **A PC set up before** keeps its reranker where it is, since Set up local AI doesn't ask for one. Once setup runs with the reranker asked for, the NPU's is added and answers first, with the card's kept behind it.
- **Tests:**
  - A 16 GB X2 gets the NPU's reranker; a 16 GB first-generation X goes to its card; a 32 GB one gets the NPU's.
  - The update path: a 16 GB X2 set up before with its reranker on the Adreno. Set up again without the reranker asked for, nothing moves. Asked for, the NPU reranks first, the card's entry is kept as it was, and the keeper stops the reranker with the embedding server at the small PC's minutes.
  - The catalog: `smallPc` names only generations the route supports, with its figures, and `rerankFits` follows it at 16 and 32 GB.
- **Docs:** NPU-VENDORS.md (Reranking on the Hexagon, and a new The reranker on a 16 GB X2, with the power modes GenieX 0.9.3 and llama.cpp b11645 expose) and ACCELERATORS.md (`rerank`, the keeper).

### Before you update

- Nothing: it updates itself as usual. Reeve's sharper search, set up again on a 16 GB X2, moves its reranker to the NPU.

## 2.135.3

**On AMD's Ryzen AI 300, pictures go to the Radeon even with "Use the graphics card for models when there's an NPU" off, Manor's default. The card's picture server starts when a picture comes and stops once unused. Chat stays on the NPU.**

### What changed

- **The core's rule beside the NPU:** with the switch off, a graphics card also keeps the work the PC's work order puts it first for, even though the NPU serves it. This is the owner's ruling of 2026-10-24: "Yes: on AMD, pictures go to the Radeon on demand even with the graphics-card switch off; chat stays off the card."
  - Today that is AMD XDNA 2's pictures (its order: the Radeon, then the NPU, then the processor). Intel's and Snapdragon's generations have no order, so nothing changes there.
  - Chat never goes to the card beside an NPU, whatever an order says, the NPU failed or not. The card's reranker stays out too.
  - The order is config.json's `workOrder` as the core reads it: none with an `acceleratorOrder` list of the person's own, so their pictures stay on the NPU.
  - `withoutGpuBesideNpu(list, gpuWithNpu, order)` and `cardWorkBesideNpu(kinds, npu, order)` take the order as a new last argument. Without it they work as before. The new `workOrderIn(raw)` reads the order from config.json as the core does.
- **Every caller follows it:**
  - npu.ts' `accelerators` passes config.json's order, so a picture request goes to the Radeon first and starts its server.
  - keeper.ts' `gpuKeptOut`, `cardOnDemand` and `reapedServers` take the order, and `serversToReap` reads it. The keeper stops the picture server once unused (`gpuIdleStopMinutes`) and never starts it; it keeps the card's chat and reranker servers out.
  - setup.ts' plan, with the switch off, sets the Radeon up for pictures and embeddings on a fresh AMD setup, not chat.
  - set-up-again.ts' `orderAdds` adds the pictures with the switch off too: an AMD PC set up before gains them by itself, gently, as in kit 2.135.2.
  - card-check.ts checks AMD's shape too: an NPU that sees, with the card first for pictures by the order.
- **Tests:** the switch off on AMD (pictures to the Radeon on demand, stopped once unused, chat never to the card even with the NPU down, embeddings as before); Intel and Snapdragon unchanged; a person's own order; a fresh AMD setup's plan; the update path with the switch off; and the older calls without an order.
- **Docs:** ACCELERATORS.md (The graphics card beside the NPU) and NPU-VENDORS.md (What setup does, Set up again).

### Before you update

- Nothing: it updates itself as usual. An agent that calls `withoutGpuBesideNpu` or `cardWorkBesideNpu` itself (Reeve's router) should pass config.json's order (`workOrderIn`) to route pictures the same way.

## 2.135.2

**An AMD Ryzen AI 300 PC set up before kit 2.111.0 gets its pictures on the Radeon by itself: the keeper sets the card up again for them, gently, as it does when the pins move on.**

### What changed

- **set-up-again.ts:** a graphics card the PC's work order puts first for a work it doesn't serve yet is behind (`orderAdds`, read in `behindPins`).
  - Today that is AMD XDNA 2's pictures. A Radeon set up before kit 2.111.0 serves only embeddings, so kit 2.135.1's order, which puts it first for pictures, changed nothing there until Set up local AI.
  - It is planned, staged, tested and switched like any other card behind its pins: the same pace, quiet retries, and the old entry serving until the new servers answer in the card's turn. Its pictures get a server of their own; its embeddings stay as they were.
  - Only the first enabled card in the core's order gains the work, and only when a plan from the pins gives it. Setup leaves pictures off a card they don't fit on beside the rest, so such a card gains nothing.
  - The person's choices stand. A card they turned off, an `acceleratorOrder` of their own, and Manor's "Use the graphics card for models when there's an NPU" off add nothing. With that switch off, Manor's default, the card is kept out of the NPU's work, pictures included. A model file of their own keeps the entry theirs, as before.
  - `AgainDeps` takes `gpuWithNpu`, read at each look (manor.ts' `gpuWithNpu()` when left out). `behindPins` takes it too, on when left out.
- **Tests:** an old AMD config gains pictures on the Radeon, on this kit's build or an older one; the switch off, the person's own order, a card turned off and a model file of theirs add nothing; Intel's and Snapdragon's generations have no order; a 4 GB card gains nothing; and the update path, the keeper's look through a staged setup to the new entry.
- **Docs:** NPU-VENDORS.md (Set up again when the kit's pins move on) and ACCELERATORS.md.

### Before you update

- Nothing: it updates itself as usual.

## 2.135.1

**On AMD's Ryzen AI 300, every picture goes to the Radeon, which reads small numbers more reliably than the NPU, and for less energy once its server is up. PCs already set up get the new order by themselves.**

### What changed

- **npu-vendors.json:** AMD's XDNA 2 order for pictures is the Radeon, then the NPU, then the processor, with no `runningFirst` or `batchAt`. This is the owner's ruling of 2026-10-24: "Yes: AMD single pictures go to the Radeon." Until now a lone picture went to the NPU while FastFlowLM was up and the Radeon's server wasn't, unless 4 or more waited.
  - The Radeon read the suite's pictures right 8 times of 8, against the NPU's 6 of 8.
  - A warm picture there costs 10.4 J, against 26.6 J on the NPU.
  - Starting its server for a lone picture costs 66 J, the price of the better read.
- **The core's `candidates`:** a work's order now puts its first device alone whatever the order, not only with `runningFirst` or a batch. When it's busy, it is waited for, not passed over for a free device that spends more.
  - On AMD, pictures wait for a busy Radeon, and so do embeddings (12.8 mJ a token there, against the processor's 44.1).
  - The NPU or the processor takes the work only when the first can't: it failed lately, a game is using it, or it's rested after a long line.
  - `runningFirst` and `batchAt` stay, and are read as before. No generation's order has them now.
  - The accelerator vectors have the new cases.
- **npu-refresh.ts:** the keeper's look, once for each kit version, brings config.json's `workOrder` to this kit's (`workOrderFor` on the PC's NPU generation) when they differ, as setup writes it.
  - It does so whatever comes of the NPU's servers, and also on a PC whose NPU has no entry but whose setup wrote an order.
  - Its log names the new order.
  - Before, only setup wrote it, so a changed order reached only PCs set up after it.
- **Docs:** ACCELERATORS.md and NPU-VENDORS.md give the new rule and the ruling. ACCELERATORS.md no longer says Intel's NPU can't see: it has since kit 2.103.0.

### Before you update

- Nothing: it updates itself as usual.
- An agent that routes on its own (Reeve's `src/routing.ts`) sends a picture to the Radeon when it's free. Until that agent mirrors the core's `candidates`, it still gives a picture to a free NPU while the Radeon is busy.
- A PC set up before kit 2.111.0 has a Radeon with no vision model. Its pictures move only after Set up local AI, as before.

## 2.135.0

**The text reader on the processor runs in Windows' efficiency mode at a gentle pace: the same lines read, for about half the energy a picture.**

### What changed

- **gentle.ts** has `paceStarted(pid)`: a program the agent started is set to the agent's pace beyond what it inherits. Windows passes a process's priority class and job on to the programs it starts, but not its efficiency mode (EcoQoS) or its disk priority. At a gentle pace the program gets both, through the same signed helper the agent's own pace uses, and stays in the agent's job. At a full pace, before any round set a pace, or with `KIT_GENTLE=0`, nothing is done.
- **ocr-npu.ts** calls it for every program it starts on the processor: where no NPU reads, where an NPU fails its self-check, and for a background batch the NPU's line is too long for. The NPU's program is left as it starts. `ReaderOptions.paced` stands in for it in tests.
- Measured on a Snapdragon X2 Elite's processor (model 2, the check's 41 pictures, energy of the SoC and memory over rest): at a gentle pace a picture cost 6.7 J and 655 ms before, and costs 3.2 J and 812 ms in efficiency mode. Every picture read exactly as before. The figures, and what was measured and not taken (fewer threads, bigger pieces than the NPU's tiles, int8 copies), are in spec/OCR.md, "On the processor".

### Before you update

- Nothing: it updates itself as usual. The signed helpers are unchanged, so nothing is compiled anew.

## 2.134.1

**The text reader reads with our model 2 (`ocr-model-v2`). Fine-tuned again on small screen text, it reads 1,223 of the check's 1,253 lines exactly on a Snapdragon's NPU, against model 1's 1,211 and Windows OCR's 733, and no group worse than either.**

### What changed

- **ocr-npu.ts** pins `ocr-model-v2` (`MODEL_VERSION` is `'2'`): a new `rec.onnx` and `NOTICE.txt`. The detector, `charset.txt` and `LICENSE.txt` are model 1's.
- **The recognizer** was fine-tuned from model 1 on 60,000 more generated lines, mostly 11 to 13 px. They aim at what model 1 got wrong: spaces between short words, figures and signs ("Col 17", "Time & language"), narrow marks, zeros, and a capital I. Model 1's raised space output is gone.
- **The check, by group,** in lines read exactly on the NPU, model 2 against model 1:
  - screens at 11 px: 125/132 against 123;
  - screens at 13 px: 106/108 against 105;
  - pages: 180/182 against 178;
  - held-out screens: 156/165 against 150;
  - held-out browser: 28/28 against 27;
  - every other group the same.

  The processor reads as the NPU does (1,224). 15 of model 1's 42 missed lines are now right, and 3 others are newly missed.
- **spec/OCR.md** has model 2's figures, what's left (30 lines, from 42), and the owner's rule for choosing how a PC reads:
  - accuracy is never given up for less power;
  - a route that reads clearly better wins over a cheaper one, without asking the owner again;
  - the least energy decides between routes that read as well.

### Before you update

- Nothing to do. After the update, each PC fetches model 2 (4 MB) once, in the background, and reads as before until it's in place. An NPU compiles model 2's graphs on its first start, about 17 s on a Snapdragon. Model 1's folder stays, for agents on older kits.
- Model 2 hasn't been measured on Intel's or AMD's PCs yet. The program's self-check still compares each NPU's read with the processor's before it reads.

## 2.134.0

**A release carries no documents, and carries THIRD-PARTY-NOTICES.txt, made from what it carries. A release that carries something of others' with no notice for it isn't built.**

### What's new

- **notices.ts:** `THIRD-PARTY-NOTICES.txt` at the zip's top level, written by `release.ts` after the page, minify and the native files, as Manor's release writes its own (spec/RELEASES.md, "Notices"). Each part has its heading between two lines of `=`, where the release carries it, its license, and the license and notice files its maker asks to be kept, copied in whole:
  - the npm packages bundled into the page (react, react-dom, scheduler), from esbuild's metafile, with their license files from `node_modules` (the bundle leaves their license comments out);
  - each folder with license or notice files of its own (`isLicenseFile`), but the agent's top level and `src\kit\`: `src\kit\geniex` and `src\kit\openvino` today;
  - the native files' notices (kit.json's `native` `notices`).
- **The release refuses** (`Not built: it carries what others made with no notice for it: ...`) a bundled package with no license file, a `.dll`, `.exe`, `.node`, `.wasm` or font with no license or notice file in its folder or one above it (outside `src\kit\prebuilt`, the kit's own builds), and native files whose kit.json lists no `notices`.
- **`geniex/NOTICE`:** the GenieX plugin builds' statement that they're modified builds, what changed and that they aren't Qualcomm's release. Until now only its README said so, and READMEs no longer ship.
- **react-page.ts `bundlePageWith`:** the bundle with the npm packages in it. `releasePage` returns them as `packages`, beside `kb`.

### What changed

- **No `.md` goes in a release** (`isDoc` in `pickReleaseFiles`): the kit's pages in `src\kit\spec\` and the READMEs beside its vendored builds stay out, as the agent's own README always did. Nothing reads them at run time; the spec part's `.json` files still go. A license or notice file written as `.md` still goes.
- An installed copy is about 0.5 MB (18 files) smaller for it.

### Before you update

- An agent whose own `src\` or `art\` carries a program, library or font of someone else's needs that maker's license (and a `NOTICE`, for a modified build) beside it, or its release won't build. None of the staff does today.
- An agent that builds its release with its own tool, not `release.ts` (Manor, Reeve), gets neither change: Manor writes its own notices; Reeve's tool needs the same steps.

## 2.133.0

**Page sign-in is on by default (kit 2.96.0's plan, its last step): a page's GETs need its token or its cookie once every staff member installed in the account runs this kit or a later one.**

### What changed

- **page-access.ts** `strictPages()`: `KIT_STRICT_PAGES=1` always, `0` never, unset `strictByDefault()`.
  - `strictByDefault()` is strict once `olderStaff()` finds no staff member installed in this account with a kit before `STRICT_FROM` (2.133.0). An install is a `.<id>\app` folder in the home with a kit.json, Manor's too, or one in an `<ID>_HOME`; its kit is its `src\kit\VERSION`, else kit.json's pin. It looks once a minute.
  - Under node --test it is never strict unless the test gives it a home to look in, so a test's pages answer as before.
- **react/page-data.ts**: a page whose `/api/page` answers 401 reloads itself. A tab opened before strict, in a browser without the cookie, goes through Castellan and comes back signed in.

### Before you update

- An agent whose code GETs another page (or its own, from its CLI or MCP server) must send the token before it takes this kit: 2.118.0's `pageHeaders(url)` or `staffHeaders(id)`. Put that change on its main before this kit's bump. Pages refuse only once every installed staff member has 2.133.0, so an older one is never turned away.
- A developer's script that reads a page's GETs needs the token from its server.json. `KIT_STRICT_PAGES=0` in the page's environment keeps it open.

## 2.132.1

**The text reader's helper is prebuilt and signed again: `kit/node/prebuilt/ocr-npu-8d1348367dd3.exe`, for `ocr-npu.cs` as it is since 2.127.0.**

### What changed

- **prebuilt/:** `ocr-npu-8d1348367dd3.exe`, compiled and signed by `tools/sign-helpers.ts` (Certum, SHA-256, timestamped). 2.127.0 changed `ocr-npu.cs` and removed the old `ocr-npu-3fa4156fe5a3.exe`, so since then each PC compiled the helper itself, unsigned. Smart App Control may block a helper compiled on the PC, as it did in kit 2.91.0's first test.
- The other five helpers are unchanged.

### Before you update

- Nothing to do. An agent that pins this kit uses the signed helper (`signedHelper`), even on a PC where it compiled its own before.

## 2.129.0

**Text in an alphabet other than Latin (Cyrillic, Greek, Chinese, Arabic…) is read again by Windows' own OCR, where Windows has an OCR language of that alphabet for the account. Windows' lines replace the model's only where they hold that alphabet; text in the Latin alphabet keeps the model's read. This was the owner's call.**

### What's new

- **ocr-reread.ts:**
  - `looksUnread`: the model's read of a page looks like another alphabet. That's a line with two odd words, or with half its words odd (case changing inside a word, or signs among its letters), or a page mostly in capitals.
  - `otherAlphabet`: a line of Windows' read holds another alphabet. At least two of its letters, and 15% of them, are neither Latin nor drawn like Latin.
  - `keepBetter`: the page's lines, with the better read kept line by line.
  - `otherAlphabetLanguages`: Windows' OCR languages whose script isn't Latin, asked once an hour.
- **ocr.ts** reads such pages again with Windows OCR in each such language (`readInLanguage`), at the scale and orientation the model read them, and keeps the better read line by line.
  - `OcrResult.engine` is `'model-npu+windows'` or `'model-cpu+windows'` when some lines are Windows', and `ms` counts both reads.
  - A line in the agent's log reports each read again.
  - `OcrOptions.otherAlphabets` and `readAgain` are for tests.
- **ocr.ps1** takes `language`, a tag such as `ru-RU`: it reads in that OCR language rather than the account's first. A picture job may also carry its own `scale` and `orient`.

### What changed

- **ocr-check.ts** measures each engine alone, without reading again.
- **A PC whose Windows has only Latin-alphabet OCR languages** reads as before.

### Before you update

- Nothing to do. An agent that looks at `engine` should read a `+windows` ending as the model's read, with some lines from Windows OCR.

## 2.127.0

**AMD's NPU, through VitisAI, can read with our own model as a test (`KIT_OCR_NPU=vitisai`). Measured on a Ryzen AI 7 350, it reads worse, so the program's self-check refuses it, and an AMD PC reads on the processor as since 2.121.0.**

### What's new

- **ocr-npu.ts** `KIT_OCR_NPU=vitisai` takes `VITISAI_PACK`: Windows ML 2.4.89 from Microsoft's NuGet package (52 MB fetched, 1 MB kept), which asks Windows for AMD's VitisAI plugin. Nothing of AMD's is fetched.
- **ocr-npu.cs** `--vitisai <folder>` reads on AMD's NPU. Every shape is fixed and the CPU fallback is off.
  - **Its graphs** are compiled into the reader's cache, keyed by the model, the NPU's driver and the plugin. The plugin is reached through a junction in the cache, since its compiler can't open itself from under WindowsApps.
  - **`--prepare`** compiles them, each in a program of its own, as many at once as the cores and memory allow, below normal priority. `--export` copies them out for a release, and `--graphs` takes graphs compiled ahead.
  - **`--compiled-only`** reads on the processor rather than compile; its hello says `"prepare":true`.
- **ocr-npu.ts** `prepareReader` runs `--prepare` (up to 90 minutes, `PREPARE_MS`), under a lock beside the NPU's, so one agent on a PC compiles. `modelReader` compiles in the background while the processor reads, and starts on the NPU from the next batch once they're compiled. After a failed compile the NPU isn't tried for six hours; while another agent compiles, it looks again in ten minutes.
- **`AMD_GRAPHS`** pins graphs compiled ahead, for a release: null, while AMD's NPU reads worse.

### What changed

- **AMD's recognizer stops at 1,024 wide** (`AmdWidths`): its compiler can't place 1,280 or wider. A longer line is narrowed; on the processor, the check's lines read the same so.
- **A failed compile** leaves no folder behind, its paths too long for .NET deleted through Win32. One that ends without a word counts as a failed try.
- **ocr-npu.cs's signed copy** (`prebuilt/ocr-npu-3fa4156fe5a3.exe`) is removed, as its source changed: each PC compiles the program itself, as the kit does for an unsigned helper, until it's signed again (`tools/sign-helpers.ts`).

### Measured (spec/OCR.md, "On the processor" and "Intel and AMD")

- **AMD's NPU** (plugin 1.8.75, FP32 run as BF16) reads the same as the processor for 94 to 95% of lines 128 to 384 wide, 39% at 512, 1% at 768 and 40% at 1,024. Its detector changes 255 of 952 lines.
- **The model on a Ryzen AI 7 350's processor** reads 1,212 of 1,253 lines, against Windows OCR's 736. A picture takes 268 ms and 776 ms of processor, and 4,875 mJ against Windows OCR's 698 mJ.

### Before you update

- Nothing. AMD's NPU is a test; nothing changes on any PC by default.

## 2.126.0

**When the NPU's line is too long for a background batch, a second copy of the text reader reads it with our own model on the processor. Windows OCR used to read it. The owner chose how well it reads over the power it costs.**

### What changed

- **ocr-npu.ts:** a batch the NPU's turn gives up on (`NpuBusy`: the line too long, no turn within 10 minutes, or the NPU resting) is now read by a second program started with `--on cpu`. It reads the rest of the batch, or all of it if the NPU's program had no turn to start. The second program is started beside the NPU's when it's first needed. It holds the processor's sessions while it runs and ends itself after two minutes idle, as the NPU's does. If it can't start, Windows OCR reads, as before.
- **The reader's fetch tries a rename again** (`renameSoon`) every 100 ms for up to five seconds when Windows refuses it for a moment (EPERM, EACCES or EBUSY), as with a folder just unpacked whose DLLs an antivirus is still scanning. It used to fail the fetch, and Windows OCR read until the next try.
- **`ReaderOptions.turn`:** a stand-in for the NPU's turn, for tests.

### Before you update

- Nothing.

## 2.124.0

**Wherever no NPU can read with our own model, it reads on the processor: an NPU that fails its self-check, a Snapdragon's included, no longer leaves the reading to Windows OCR. The owner chose how well it reads over the power it costs.**

### What changed

- **ocr-npu.ts** `ON_PROCESSOR` is true. A Snapdragon or an Intel NPU 3720 whose NPU reads the program's own picture differently now reads with the model on the processor. Before, Windows OCR read. AMD and Intel PCs read on the processor as in 2.121.0 and 2.122.0.
- **`ON_PROCESSOR_MAKERS` and `onProcessor(env)` (2.121.0) are gone**: with every maker on the processor, `ON_PROCESSOR` says it.
- **Windows OCR still reads** until the model has been fetched, when `KIT_OCR_ENGINE=windows` says so, and for a background batch the NPU's line is too long for.

### Before you update

- Nothing. No staff member uses `ON_PROCESSOR_MAKERS` or `onProcessor`.

## 2.123.0

**A published release signs its PowerShell scripts, as it signs its native files: Smart App Control runs a signed script as written, and an unsigned one in Constrained Language Mode.**

### What's new

- **release.ts** signs every `.ps1`, `.psm1` and `.psd1` a published release carries (spec/RELEASES.md, "Signed scripts"). It uses Authenticode, SHA-256 and an RFC 3161 timestamp, with the Windows SDK's x64 signtool.
  - **Which certificate:** kit.json's `native.thumbprint`; else, on the PC that releases Castellan, the owner's (`prebuilt.ts`' `SIGNED_BY`). Anyone else's agent ships its scripts unsigned, and the build says so. A local build or `--install` signs nothing.
  - **When it can't sign:** if a script needs signing, the signer check runs before anything is built. A PC that can't sign refuses with `Not published: its scripts can't be signed: ...`, which the Steward waits on.
  - **What ships is what was signed:** scripts are signed last in the stage. After zipping, each one is unpacked and checked against what was signed, and any difference stops the release.
  - **Hashes follow the scripts:** a staged `.json` listing a script's SHA-256 (a guard's `manifest.json`) gets the signed script's hash.
  - **Signed by their makers:** a script that already carries a Valid signature stays as it is. One whose signature no longer checks out is signed afresh.
- **signed-scripts.ts**: signed scripts are kept, by certificate and text, in one store for every agent on the PC (`KIT_SIGNED_SCRIPTS`, else `%USERPROFILE%\.steward\signed-scripts`). A release whose scripts are all kept takes those copies and needs no key. A kept copy is checked again first (Valid, the certificate's, timestamped), and one no release takes for 90 days goes.

### What changed

- **sign.ts**: `signFiles` takes `what` (the words its errors use; the native files' by default), and `signaturesWrong` is exported.

### Before you update

- **Don't change a script after the release signs it.** Nothing in the kit does: an install and the kit's fill copy files byte for byte. A script an agent writes or rewrites at run time isn't signed, and runs in Constrained Language Mode where Smart App Control is on.
- **An agent with a guard** (the Lamplighter, the Watchman): its `manifest.json` now lists the signed scripts' SHA-256. A PC whose guard has the unsigned scripts sees them as behind the release, and the agent's page offers to update the guard once.
- **An agent whose release isn't the kit's `release.ts`** signs nothing from this: it needs its own signing.

## 2.122.0

**An Intel PC whose NPU isn't measured yet, or that has none, reads text with our own model on the processor, as an AMD PC does since 2.121.0. The owner chose how well it reads over the power it costs.**

### What changed

- **ocr-npu.ts** `ON_PROCESSOR_MAKERS` is `['AuthenticAMD', 'GenuineIntel']`. On Intel, the NPU 3720 (`OPENVINO_GENERATIONS`) still reads with the model on the NPU. Every other Intel PC now reads with the model on the processor, where it read with Windows OCR: Lunar Lake's NPU 4000 and later, the 200S and 200HX, and PCs with no NPU. An Intel NPU 3720 that fails its self-check falls back to the processor too, no longer to Windows OCR.
- **What it costs:** like an AMD PC, it fetches about 81 MB once for the whole PC, and keeps 19 MB. On a Core Ultra 5 225U's processor a picture costs 326 ms and 972 ms of processor time, against Windows OCR's 59 ms and 61 ms (spec/OCR.md, "On the processor").
- **A Snapdragon is unchanged.**

### Before you update

- Nothing. `KIT_OCR_ENGINE=windows` still keeps Windows OCR.

## 2.121.0

**An AMD PC's text reader reads with our own model, on the processor: Windows OCR read 736 of the check's 1,253 lines exactly, the model 1,212. It costs more processor time and power than Windows OCR, and the owner chose it for how much better it reads, until AMD's NPU route is measured.**

### What's new

- **ocr-npu.ts** `ON_PROCESSOR_MAKERS` (`['AuthenticAMD']`) and `onProcessor(env)`: whether the model reads on the processor where no NPU can, by Windows' `PROCESSOR_IDENTIFIER`. `ON_PROCESSOR` stays false for every other PC.

### What changed

- **On an AMD PC, `modelReader` reads with the model on the processor**, where it read with Windows OCR. The reader fetches about 81 MB once for every agent on the PC (ONNX Runtime and the model, no NPU plugin) and keeps 19 MB. Until it's there, Windows OCR reads, as before. Measured on an Intel Core Ultra 5 225U's processor, a picture costs 326 ms and 972 ms of processor time, against Windows OCR's 59 ms and 61 ms (spec/OCR.md, "On the processor").
- **Intel PCs are unchanged:** the NPU 3720 reads with the model, and other generations with Windows OCR.

### Before you update

- Nothing. `KIT_OCR_ENGINE=windows` still keeps Windows OCR.

## 2.118.0

**The kit's calls to Castellan carry its token, and a page's token is found by its address: the callers' step before page sign-in goes on (kit 2.96.0's plan). This release brings 2.115.0 and 2.117.0 too, never released on their own.**

### What's new

- **page-access.ts**:
  - `pageToken(url)` and `pageHeaders(url)`: the token for a local page by its address, `http://<id>.localhost:<port>/…` as `agentUrl` and Manor's link give it, from that page's server.json. It goes only to the port server.json names, so a checkout's page 10000 above is never sent the installed copy's token. Manor's address gets Manor's token, which its page takes as `x-token`.
  - `serverFile(dir)`: a page's port and token from the server.json in its data folder.
- **manor.ts** `manorHeaders(link)`: Manor's token (`x-manor-token`), from server.json in its folder, only for the port its settings name.

### What changed

- **The kit's calls to Castellan carry its token**: `passOnOtherPcs` (`GET /api/peers/result`) and `manorIcon` (`/favicon.svg`). A Castellan from before its sign-in writes no server.json, and they go without it, as before.
- **askRepair** takes the page's token from the server.json its address names (`pageToken`) before it reads `GET /` for it, which a strict page never gives.

### Before you update

- An agent that GETs another staff member's page (`/api/*`, or `GET /` for its token) must send its token: `pageHeaders(url)` for an `agentUrl` address, `staffHeaders(id)` for a 127.0.0.1 one. So must an agent's CLI or MCP server that GETs its own page from another process. A later kit makes the GETs need it, and only once every staff member installed in the account runs that kit, so nothing breaks before then. A refused call answers 401: let it degrade quietly.

## 2.117.0

**The text reader reads with our own model on Intel's NPU 3720 too: on a Core Ultra 5 225U it reads 1,212 of the check's 1,253 lines exactly, where Windows OCR read 736.**

### What changed

- **ocr-npu.ts**: `packFor` gives Intel's plugin (`OPENVINO_PACK`, OpenVINO 1.7.0) on an x64 PC whose NPU is of a generation in `OPENVINO_GENERATIONS`: `meteor-lake`, the NPU 3720 of the Core Ultra Series 1 and the 200U and 200H.
  - The generation comes from setup's report of the NPU (npu-report.json's `chip`, `npuChipOutsideTests`), so a PC reads with Windows OCR until its local AI is set up. Under node:test there is none.
  - A third argument gives the chip for tests.
  - `KIT_OCR_NPU=openvino` still tries the plugin on any x64 PC, and `none` keeps the model off the NPU.
- **The figures**, measured with the manor stopped, a picture beyond the start:
  - Windows OCR: 59 ms, 61 ms of processor, 465 mJ over rest.
  - The model on the NPU: 171 ms, 55 ms of processor, 859 mJ.
  - The model on the processor: 326 ms, 972 ms, 6,991 mJ.

  It reads no worse than Windows OCR in any group, at less processor time a picture. It spends 1.85 times Windows OCR's energy a picture, and the owner chose it for how much better it reads. spec/OCR.md, "Intel and AMD", has the rest.

### Before you update

- Nothing for an agent. On an Intel NPU 3720 whose local AI is set up, the reader fetches 199 MB once, in the background: ONNX Runtime 77 MB, OpenVINO's plugin 118 MB and the model 4 MB. It keeps 131 MB, plus 48 MB of compiled graphs.

## 2.115.0

**The keeper sets an accelerator up again by itself when a later kit pins another llama.cpp build, model or NPU server; and setup finds a packaged app through gaps in its process chain.**

### What's new

- **set-up-again.ts**: the keeper's look sets up again, in the background, a card, the processor or the NPU whose entry is behind the kit's pins (spec/NPU-VENDORS.md, "Set up again when the kit's pins move on").
  - `behindPins` finds them from a plan made from the pins alone. A card's or the processor's entry on the kit's llama.cpp and models folders is behind when its build or model files aren't the pins'. The NPU's is behind when the NPU refresh left it `needs-setup` for this kit. An entry of the person's own is left alone.
  - `setUpAgain` sets up one a look, once it has been unused for 2 minutes, never while the manor is stopped, through `setupCommand`'s new `staged` option. A failure is tried again after 6 hours, one found in use after 10 minutes; what Smart App Control blocked waits for a later kit. Its tries are kept in `set-up-again.json` beside config.json.
  - A `staged` setup puts the new build, models and NPU server beside the old, which keeps serving. Then, in the accelerator's turn, it stops the old servers and tests the new ones (chat, pictures, embeddings, reranking). It writes only an entry that answered and serves all the old one did, and never moves the NPU's work to a card. GenieX, installed in one place, is swapped in the NPU's turn with its old folder kept aside, and put back if the new entry isn't written. At the manor's gentle pace, downloads go at 4 MB a second at most (`pacedFetch`).
  - `removeReplaced` removes the old build folders and model files 3 days after nothing names them: config.json, or a running server's command line.
- **outside.ts** `redirectedTo`: whether this process's writes to %LOCALAPPDATA% land in a package's folder. `packagedApp` asks it when the walk up the parents finds no packaged app, as when a parent has already exited.
- **setup.ts**: `SetupOptions.cpuKinds` (exactly what the processor serves) and `staged`. `NpuIo.testEmbed` is given the model's dimensions.

### What changed

- **A GenieX older than its generation's pin is replaced by the pin** (npu-vendors.ts' `plannedAt`). Setup installs the pin over it, and the NPU refresh leaves it `needs-setup`, which the keeper now sets up by itself. Until now a Snapdragon X2 set up with GenieX 0.8.0 or 0.9.1 kept it. A later one than the pin (the Smith's Use it) still runs as it is.
- **The keeper's look** (`startRepairs`) runs `setUpAgain` at most every 10 minutes, after a missing server's repair, then `removeReplaced`. The NPU's refresh waits while the NPU is being set up again.

### Before you update

- Nothing for an agent to do: the keeper runs it. On a PC behind the pins, a look soon after the update downloads what the new pins need, in the background.

## 2.114.0

**The text reader reads with our own model on the NPU: on a Snapdragon it reads 1,211 of the check's 1,253 lines exactly, where Windows OCR read 733.**

### What's new

- **ocr-npu.ts**: the reader's own model, PP-OCRv6 tiny with its recognizer fine-tuned on screen and document text (Apache-2.0, the release `ocr-model-v1` in the manor's public releases). spec/OCR.md, "Our own model", has the choice, the figures, and what's left.
  - `modelReader` gives the model's reader for this PC, or null when Windows OCR reads instead. Null means Windows OCR is set, the model isn't fetched yet (the fetch then starts in the background), no NPU the model runs on, or an NPU that failed the self-check (refused for 6 hours, `REFUSED_MS`).
  - `fetchReader` fetches ONNX Runtime 1.27.0, the NPU maker's plugin (Qualcomm's QNN 2.6.0 on Arm; Intel's OpenVINO 1.7.0 as a test) and the model. Each is pinned by size and SHA-256 (`ORT_ZIPS`, `QNN_PACK`, `OPENVINO_PACK`, `MODEL_FILES`), and goes into the reader's shared folder (`ocrHome`: %USERPROFILE%\.npu-agent\ocr, or `KIT_OCR_HOME`). About 226 MB on a Snapdragon.
  - Reading on the NPU takes the NPU's turn (`acceleratorTurn`), `TURN_PAGES` (8) pages a turn, in the caller's lane. When the NPU's line is too long, or no turn comes in time, Windows OCR reads the rest.
  - `KIT_OCR_ENGINE` (`windows`, `model`, unset for where it's worth it) and `KIT_OCR_NPU` (`none`, `openvino`). Under node:test the reader is Windows OCR unless `KIT_OCR_ENGINE` says otherwise.
  - `ON_PROCESSOR` is false: on the processor the model reads as well, but at 20 times Windows OCR's processor time, so Windows OCR reads where the NPU can't.
- **ocr-npu.cs**, shipped signed as `prebuilt/ocr-npu-3fa4156fe5a3.exe`: the program that reads.
  - It runs ONNX Runtime through its C API, loads the model once and stays until two minutes idle.
  - On Qualcomm's NPU it uses static shapes (640×640 detector tiles, recognizer widths 128 to 2,048), fp16 with no CPU fallback, power-saver mode and one thread, and compiled graphs kept in its cache folder. That folder is also its working folder, where VitisAI's signature files will land.
  - Before reading, it reads a picture it draws itself, on the NPU and on the processor, and won't use an NPU that reads it differently.
- **ocr-check.ts**: the engines `model-npu` and `model-cpu`, beside `windows`, each with its processor time and peak memory.
- **prebuilt.ts**: a helper can name the assemblies it's compiled against (`refs`) and take `ARM64_MANIFEST`, so Windows on Arm runs it as Arm. Both are hashed into its name; the helpers that have neither keep theirs.
- **ocr.ps1**: `render` renders a PDF's pages for the model to read, with no OCR language needed.

### What changed

- **`ocrFiles` and `ocrImages`** read with the model where it can, and with Windows OCR the rest. `OcrResult.engine` is `'model-npu'`, `'model-cpu'` or `'windows'`. The API is as it was.
- **`tooWide`** (signatures.ts) reads a drive alone ("D:") as the drive's root wherever the process runs. Resolved, it was the folder the process was in on that drive.
- **spec/OCR.md**: "Our own model" replaces "Next".

### Before you update

- Nothing: take the kit as usual. On a Snapdragon, the first read after an agent takes it starts the 226 MB fetch in the background. Windows OCR reads until the fetch is done, and the first start then compiles the NPU's graphs (about 17 s). Every agent on the PC shares the one folder, so it's fetched once.

## 2.113.5

**Setup runs outside a packaged app (the Claude desktop app is one), and a server whose program is gone is set up again by the keeper.**

### What's new

- **outside.ts.** It finds the packaged app a process runs inside, and runs a step outside it.
  - `packagedApp` walks the process's ancestors (Win32_Process) to one from WindowsApps; `parseProcessTable` and `packagedAncestor` are ported from Manor's windows.ts. `packagedOutsideTests` gives none in a test run.
  - `inAppData` tells whether a path is in %LOCALAPPDATA%, %APPDATA% or the profile's AppData. %TEMP% doesn't count: Windows doesn't redirect it.
  - `runOutside(job)` runs a job as a one-off Task Scheduler task, like `manor install`'s hop: no trigger, InteractiveToken, LeastPrivilege, hidden, `conhost --headless node outside-run.ts <folder>`. It passes on the run's log lines as they come and returns its result. The task is deleted after. Task Scheduler refusing, or not starting it within 2 minutes, throws `OutsideUnavailable`.
  - The job folder is in the accelerators' home (`outside\<id>`), never in AppData. Its job.json carries the kit's own variables (`carriedEnv`), never one that names a token, key, secret or password.
- **outside-run.ts** is the run outside. It sets the job's variables before importing any of the kit, since the kit's modules read their folders as they load, and sets `KIT_OUTSIDE=1`, so a run outside never looks for a package again.
- **server-repair.ts.** `missingServers(raw)` lists the enabled servers whose program isn't there. It only counts a program setup puts there (`setupFolders`: the tools home, and GenieX's %LOCALAPPDATA%\GenieX CLI). `repairMissing(deps)` sets one of those up again (`setupCommand({ ids: [id], yes: true })`) once it has been missing for 5 minutes across looks. It sets up one server a look, never while the manor is stopped, and retries a failing one at most every 6 hours. Its record is server-repair.json, beside config.json.
- **keeper.ts' `startRepairs`.** It runs the repair in the background of the keeper's look (`keeperLook`, with the PC's own reaper), not while the NPU's refresh is testing.
- **`ProgramMissing`** (accelerators.ts, an `AcceleratorDown`): a startCommand whose absolute program isn't there is said with `core.say.notInstalled` rather than Node's ENOENT. Node gives ENOENT for a missing working folder too.

### What changed

- **`setupCommand`** plans, says the plan and asks as before. Then, inside a packaged app, it runs the rest outside (`runOutside` of a `setup` job) and returns that run's code and entries.
  - It hops on every route. The servers setup tries write their own caches to AppData too (llama.cpp's OpenCL kernels).
  - Where Task Scheduler won't run it, the steps `writesAppData(plan)` lists are refused in a plain message, and nothing is set up. On Qualcomm's route those are GenieX's installer (HKCU too) or Castellan's signed build put together in %LOCALAPPDATA%\GenieX CLI, and a plugin patch in its folder. Intel's and AMD's routes have none unless the tools home is in AppData, so their setup runs in the process, with a note.
  - New `SetupOptions`: `asked` (the run outside: the plan isn't said or asked again), `packaged` and `outside` (tests). Nothing is asked about packages when setup is given a `detection` or `io` of its own.
- **`patchNpu`** (npu-patch.ts): inside a packaged app, the moves of a server file in AppData (GenieX's plugin) are `patch-in` and `stock-back` jobs run outside. Refused, the plugin "couldn't be put in", and GenieX keeps its own. `putStockBack` is exported. New deps: `packaged`, `outside`.
- **`core.say.notInstalled(program, file)`**: "… isn't installed where the staff look for it (…). They set it up again by themselves; to do it now, open Castellan and choose Set up local AI".

### Before you update

- Nothing: take the kit as usual. An agent that runs the keeper's look (the Smith, Reeve) sets up again a server whose program is missing, a few minutes after it takes this kit. On a PC whose GenieX was set up from the Claude app, that means downloading and installing GenieX again, for real this time.

## 2.113.4

**The guide's card figure for Intel's pictures is the current setup's.**

### What changed

- spec/NPU-VENDORS.md (Intel's pictures stay on the NPU) is measured again on a Core Ultra 5 225U on 2026-10-24, with the manor running, in three rounds that took three servers in turn:
  - the card as setup gives it now (LLAMA_PIN b11734, Qwen3-VL-2B Q4_K_M with its Q8_0 projector): 36 J a picture warm (30–48 J), in 1.9 s; 20–68 J to start and read a first picture; 3.2 GB;
  - the NPU: 20 J (18–26 J), in 1.4 s;
  - the 4B on b11669 that an older kit set up: 46 J, in 2.7 s; 4.9 GB.
  The 41 J before was that older setup's. No `batchAt` pays either way, and Intel's generations still record no `order`.
- spec/NPU-BENCHMARK.md: the 225U's picture bullet gives the same figures.

### Before you update

- Nothing: take the kit as usual. Only the guides change.

## 2.113.2

**Intel's pictures stay on the NPU, and the guide says why.**

### What changed

- spec/NPU-VENDORS.md (Each work's order on a generation, Intel's pictures stay on the NPU) records the measurements on a Core Ultra 5 225U, 2026-10-24.
  - OpenVINO on the Arc spent 13.3 J on a picture against the NPU's 17.5 J, but read the 896 px tally picture's 4827 as 4877 three times in four. The NPU and the processor read it right.
  - The card server setup gives Intel's integrated graphics (llama.cpp Vulkan, its encoder on the processor, `encodesOnProcessor`) spent about 41 J a picture warm, and 56–66 J to start and read its first.
  - So no `batchAt` pays, and Intel's generations record no `order`.
- spec/NPU-BENCHMARK.md: the 225U's picture bullet says the same.

### Before you update

- Nothing: take the kit as usual. Only the guides change.

## 2.113.1

**The NPU benchmark says where the embedder ran, and its summary compares pictures a picture each: OpenVINO counts a picture's tokens unalike on the NPU and off it.**

### What changed

- **`results.embed.device`** (npu-bench, its report): where the embedding server ran. That is OpenVINO's `--target_device` (on the NPU 3720 the graphics, from its generation's `embedArgs`), or the run's own device off the NPU (llama.cpp's, beside the model); null where the route doesn't say. spec/npu-bench.schema.json has it, not required, so earlier reports still match.
- **The summary** (`benchSummary`, `summarySay`): each device's `embed.device`, and a row `the embedder ran on` where a column's embedder ran on another device than its model.
- **No token figure for the pictures batch**: `millijoulesPerToken` is null and there is no `pictures: a token over rest` row. OpenVINO Model Server 2026.4.1 counts a picture as 8 prompt tokens whatever its size on the graphics and the processor, and as its own tokens on the NPU (64 for the suite's 224 px square). The picture and the answers are the same on all three. Measured on a Core Ultra 5 225U, 2026-10-24.
- spec/NPU-BENCHMARK.md: the Intel Core Ultra 5 225U's series (kit 2.106.0, 2026-10-24). The NPU does the chat jobs for about half the Arc's energy and under a third of the processor's. A picture is cheapest on the Arc. The NPU's embedding rows are the Arc's. Also brought up to date: Reading the summary, the report's `embed`, and On Intel and AMD.

### Before you update

- Nothing: take the kit as usual. Only the benchmark changes, nothing an agent runs.

## 2.113.0

**Every agent but Manor and Heiward needs a license for its PC. No staff member works for free: sold or not, held back, internal, or one the Exchequer doesn't list, each waits on a PC without one.**

### What changed

- **Who checks** (`license-check.ts`): every agent but Manor and Heiward (`checksLicense(id)`). Before, only a sold agent checked, so an agent ran on a PC with no license when Manor's exchequer.json was missing or couldn't be read, when the Exchequer's list left it out or gave it a tier but Household or Workshop, when Manor's staff.json held it back or marked it internal (the Wright, the Bailiff, the Crier), or when its release.json said `"sold": false`. None of that decides anything now.
- **`ownSale` and `soldHere` are gone**, and `readLicenseFor` and `checkLicense` take no `sold`. `LicenseReading.sold` is `checked`. release.json's `sold` is still stamped as a release is published, and nothing reads it.
- **An error of the check's own holds the agent** (state `unreadable`, with the error in `problem`), as a license it can't read does. Before, it let the agent run.
- What holds an agent, and what its page, pill and ping say, are as in 2.110.0: no license for this PC, one that can't be read or verified, another PC's, or an ended trial. A paid, lapsed (the Freehold license) or pending license runs, as does a running trial.

### What an agent must do

- Nothing: release it on this kit. An agent that passed `sold` to `checkLicense` or `readLicenseFor` drops it.

### Before you update

- **On a PC that holds no license, every agent released on this kit waits, Manor and Heiward aside.** That includes the internal staff (the Wright, the Bailiff, the Crier) and any held back from sale, on developers' and test PCs too: give each PC a license (a complimentary one does).
- **What a held agent shows, and how it runs again.** Its page says "This PC holds no license for it: signing in brings it back" (after a trial, "The trial ended: a license brings it back"), its pill says No license (or Trial ended), its rounds and Run now wait, and its ping says it isn't running. Its settings and data are kept. Sign in on that PC in Manor's Settings > License, with the email the license was bought with, or enter a key: the agent sees the new licence.json at its next look (licence.json changing is read at once), with nothing to reinstall.

## 2.112.1

**On AMD's Ryzen AI 300 a picture waits in the Radeon's line, rather than going to a free NPU that spends more on it.**

### What changed

- **The order's first, alone** (`candidates`, the core, and its vectors): where the work's order puts one first, by its `runningFirst` or a batch (as many of the work waiting as its `batchAt`), the first in that order that can take the request is its only candidate, as the NPU first is. Busy, it's waited for. The next takes the request only when that one failed lately, is a game's, or is rested after a long line.
- **Why**: until now the pick shared the request out to whichever candidate had a free slot or the shortest line. On AMD that sent most of a batch of 4 background pictures to the NPU, at 26.6 J each against the Radeon's 10.4 (found by the Reeve session, 2026-10-24). An agent's background pictures count those of its own already headed to a line, so from the second the Radeon looked busier than a free NPU. A picture sent while the Radeon read another went to the NPU the same way. Waiting for a busy Radeon costs a picture about 0.47 s for each one ahead of it.
- **A background request behind `maxAhead` (4) in that one line is deferred** for a later round (`NpuBusy`), as on the NPU, rather than going to the next device.
- **`isBatch(order, waiting)`** (the core, exported): whether as many of the work wait as its order's `batchAt`. `workOrdered` keeps the work's devices' order for a batch, whoever's server is up, by it, as before.
- spec/ACCELERATORS.md (Choosing an accelerator, step 2), spec/NPU-VENDORS.md (Counting the pictures that wait).

### Before you update

- Nothing: take the kit as usual. Only AMD's XDNA 2 has a work order, and only its pictures have `runningFirst` and `batchAt`: its chat keeps the NPU first, and its embeddings the Radeon, then the processor. A `candidates` caller without `workOrder` gets the candidates it got before.
- Reeve's own routing (`src/routing.ts`, which reads `workOrder` from Reeve 0.18.63) mirrors the pick, and takes the same change in its own repository, with `isBatch`.

## 2.111.0

**AMD's NPU server is FastFlowLM 1.0.10. A generation can say which device each work spends least on, and on AMD's Ryzen AI 300 pictures go to the Radeon.**

### What changed

- **FastFlowLM 1.0.10** is AMD's route's server (`npu-vendors.json`: its zip, 30,484,687 bytes, SHA-256 `a7063890d7b91037a07f381a396a0d7787ebdb69e1b03280971faf0a80f35b73`, 296 files). It does the same as 1.0.7 within noise: three interleaved runs of each on a Ryzen AI 7 350's NPU, means, triage 25.0 J against 26.2, a reply 24.6 against 29.4, a summary 47.4 against 51.7, reading 1,024 tokens 31.5 against 31.1, writing 22.9 tokens a second against 22.5 (spec/NPU-BENCHMARK.md). Its NPU check passed every step, and its timeouts stay.
- **Its signed catalog is the route's** (`catalogs`): `node/catalogs/castellan-amd-fastflowlm-1.0.10.cat`, kit 2.108.0's (17,357 bytes, SHA-256 `5b989f4fc81fe06d0d3a8cb5d1a9a3c7e52f0eb9d45b54d7853fee71b2281a69`, listing 1.0.10's 36 unsigned program files), beside 1.0.7's. Where Smart App Control is on, setup installs it before 1.0.10 runs, asking once for an administrator, and removes 1.0.7's in the same prompt. `tools/sign-binaries.ts`' `FASTFLOWLM_ALSO` is empty: 1.0.10 is the route's own.
- **Its licences**: the MIT License for its runtime, orchestration and CLI (`LICENSE_RUNTIME.txt`), and AMD's FastFlowLM NPU Binary License for its NPU kernels and engine libraries (`LICENSE_BINARY.txt`: any use, commercial included, redistributed only unmodified with that licence). Both are in its zip with `THIRD_PARTY_NOTICES.txt`. The route's `licence` says so, with the credit its README asks for: "Powered by [FastFlowLM](https://github.com/ROCm/FastFlowLM)".
- **It still misreads a picture with a side of a whole number of 32 px**, so `sides-of-32` stays. llama.cpp's Qwen3-VL-2B on the Radeon 860M misread the same four sizes (spec/NPU-VENDORS.md); the kit doesn't nudge a card's pictures yet.
- **1.0.7's folder is retired**: `{tools}\servers\fastflowlm-1.0.7` in the route's `retired`, removed three days after nothing names it (kit 2.101.0's rule). The models in `%USERPROFILE%\.flm\models` serve both, and stay.
- **`NpuGeneration.order`** (optional): for `chat`, `vision` and `embed`, the kinds of device that work spends least energy on, first preferred (`devices`: `npu`, `gpu`, `cpu`, each once), `runningFirst`, `batchAt`, and a `basis` with the figures. `workOrderFor(route, generation)` gives it without its bases (null for none), and `fallbackDevices(route, generation, work)` the devices after the NPU (a card, then the processor, unless the order says otherwise). Only AMD's XDNA 2 has one: chat on the NPU, the Radeon, the processor; pictures on the Radeon, the NPU, the processor, a running server first unless 4 or more wait; embeddings on the Radeon, the processor.
- **config.json's `workOrder`**, a keeper key (`KEEPER_KEYS`, `ACCELERATOR_KEYS`): those orders, as setup writes them. `parseAccelerators` reads it only when `acceleratorOrder` is "auto" (the core's `readWorkOrder`), leaving out a work written wrong, and `validateAccelerators` names it.
- **`candidates` follows the work's order** (the core, and its vectors): the fitting accelerators in that work's devices' order, any it leaves out after them (`workOrdered`), and with `runningFirst`, those whose server is up first (the state's `running`), unless as many of the work wait as its `batchAt` (the state's `waiting`). The NPU first then applies as before. The node `candidates` takes `workOrder`, `running(id)` and `waiting`. `serversUp(accs, work, workOrder, look?)` asks each server of that work whether it's up (a GET of its `/v1/models`, all at once, 0.5 s at most: `UP_PROBE_MS`), only when that work's order goes by it. `Npu` asks before each request (its `serversUp` option replaces it in tests). Manor's gpuWithNpu off still keeps a card out.
- **Why pictures go to the Radeon on AMD** (a Ryzen AI 7 350, 2026-10-23): a warm picture costs the Radeon 10.4 J (Qwen3-VL-2B, llama.cpp) against the NPU's 26.6 J (FastFlowLM 1.0.10), and the Radeon read 8 of 8 against the NPU's 6. But starting the Radeon's server and one picture costs 66 J. n pictures cost about 55.6 + 10.4n J on the Radeon from a stopped server, against 26.6n J on the NPU: the same at 3.4. **The owner's answers**: asked by the AMD manager where pictures should go, "Radeon unless only NPU up"; then, to the Snapdragon manager, "keep single pictures on the NPU when it's running, but send batches of 4 or more waiting pictures to the Radeon." So a picture goes to the NPU only when FastFlowLM is up, the Radeon's server isn't, and fewer than 4 pictures wait (vision's `batchAt` 4). With both servers up, a single picture goes to the warm Radeon (10.4 J against 26.6 J): the owner's ruling on that case, to the Snapdragon manager, of "With both servers up, a single picture stays on the NPU. Only batches of 4 or more go to the Radeon.", was "actually change that, make it the gpu instead". The Radeon's server, once started, takes the pictures after (`runningFirst`) and holds its 2.8 GB beside FastFlowLM's 3.8 GB until the keeper stops it.
- **Counting what waits** (`waitingFor(work, turns)`, npu.ts): this process's requests of the work from when each is asked until its turn starts, so a batch sent at once counts itself whole, and other processes' tickets in those turns' lines that say they're of it. `Npu` counts only for a work whose order has a `batchAt`. **`AskOptions.batch`**: how many the caller is sending together, this one included (a folder of screenshots); the larger of the two counts.
- **A ticket says its work** (spec/NPU-QUEUE.md): `"work"` in its contents, `chat`, `vision`, `embed` or `rerank` (the core's `ticketText`, its sixth argument; `waitingOf` reads it back, and `queueSnapshot`'s waiting has it). `TurnOptions.work` and `acceleratorTurn`'s `work` write it. Informational: a ticket without it counts as no picture.
- **Setup writes `workOrder`** from the NPU's generation, whether its NPU was set up or blocked (`withWorkOrder`), and removes it where there's none. When the NPU can't take a work, its fallback follows the order (`fallbackDevices`): a work whose order puts the processor before a card goes to the processor.
- spec/NPU-VENDORS.md (Each work's order on a generation; the sides of 32 px on 1.0.10 and on llama.cpp's Qwen3-VL-2B; Licences), ACCELERATORS.md (`workOrder`; Choosing an accelerator), NPU-QUEUE.md (a ticket's `work`), NPU-BENCHMARK.md (FastFlowLM 1.0.10 against 1.0.7).

### Before you update

- Nothing for most agents: take the kit as usual. Every new field is optional, so an older kit (the Smith pins 2.99.1) reads the catalog and config.json as before. A `candidates` caller without `workOrder` gets the order it got before. A program in the NPU's line that doesn't write a ticket's `work` (npu-embed, Heiward's) is read as before; its requests count as no pictures.
- A staff member that sends several pictures at once may say how many (`AskOptions.batch`), so a folder's worth starts the Radeon's server on AMD at the first picture.
- An AMD PC gets 1.0.10, and its order, the next time setup runs: the keeper's look finds 1.0.10 missing and leaves it for setup. A PC on any other NPU gets no `workOrder`.
- Reeve's own routing (`src/routing.ts`) doesn't read `workOrder` yet. On AMD his embeddings go to the Radeon first by the auto order anyway.

## 2.110.0

**A sold agent doesn't run without a license for its PC. No license, one that can't be read or verified, or another PC's holds its rounds, as an ended trial does.**

### What changed

- **Closed when there's no license** (`license-check.ts`). A sold agent's rounds wait, and Run now with them, when licence.json is missing, can't be read, doesn't verify, or was made for another PC (states `missing`, `unreadable`, `bad-signature` and the new `another-pc`). Its page says "This PC holds no license for it: signing in brings it back" (`NO_LICENSE_TEXT`), and its pill says "No license". Its settings and data are kept, and a license lifts the hold at once. Before, anything the check couldn't judge ran. A paid, lapsed (the Freehold license) or pending license runs as before, as does a running trial.
- **Its release says whether it's sold** (`release.json`'s `sold`; `ownSale`). `npm run release -- --publish` stamps it from the Exchequer's list (`saleOf`). A sold agent then checks whatever Manor's exchequer.json and staff.json say, so deleting one of Manor's files doesn't stop the check. A copy whose release doesn't say goes by Manor's files, as before: a release from before, a checkout, or one built while the Exchequer couldn't say.
- **This PC's license** (`license.ts`: `deviceIdFor`, `machineGuid`, `readDeviceId`, `isThisPc`, `DEVICE_FILE`; `everyone.ts`: `sharedLicenseFolder`).
  - A license's `sub` must be device.json's id, in Manor's folder or in an Everyone install's shared license folder, as Manor's readLicense has it.
  - With no device.json, an id made from a PC (version 8) is made again from MachineGuid and the folder, so a licence.json copied from another PC on its own isn't this PC's.
  - An id from before 2026-10-21 (random) with no device.json, or a PC whose MachineGuid can't be read, has nothing to check it by, and counts.
  - reg.exe is run by its full path.
- **The API**:
  - `LicenseCheck.held` is new; `ended` is still the trial's end alone.
  - `licenseHeld()` and `heldNote()` say either hold. `trialEnded()` and `trialEndedNote()` are their old names, and now say either too. `holdText(check)` gives a hold's words, and `holdPill(text)` its pill.
  - `dutyStatus(duty, up, held)` takes the hold's words; true still means the trial's end.
  - The ping's `license` has `held`.

### What an agent must do

- Nothing: release it on this kit. An agent whose Run now doesn't go through `every()` should check `licenseHeld()`, not `licenseNow().ended`.

### Before you update

- **On a PC that holds no license, the sold staff released on this kit wait.** That includes test PCs and developers' PCs: they need a license, and a complimentary one does. Manor already takes them off duty there (Manor#364); now the staff wait by themselves too.
- **What a held agent shows, and how it runs again.** Its page says "This PC holds no license for it: signing in brings it back" (after a trial, that the trial has ended), its pill says No license (or Trial ended), and its rounds and Run now wait. Signing in on that PC brings it back: Manor's Settings > License, with the email the license was bought with, or a key. The agent sees the new licence.json at its next look, with nothing to reinstall and its settings and data as they were.

## 2.108.0

**Every program the staff's local models run is signed, by its maker or by Castellan, or listed in a catalog Castellan signs, so Windows' Smart App Control lets them run.**

### What's new

- **Castellan's signed builds** (`NpuSignedBuild`, a route's `signedBuilds`, a version each): GenieX without its installer, which Smart App Control blocks as it unpacks its own setup program. Setup downloads Qualcomm's own SDK zip of the version (its `files`, whose `lib` folder is the folder GenieX's installer fills, its QAIRT runtime signed by Qualcomm) and Castellan's zip of signed copies of GenieX's own unsigned files (`signed`), takes the folder from the first, lays the copies over it file by file and puts it where the installer puts GenieX (`installSignedBuild`, `NpuPlan.build`, in place of `download`). No installer runs and no administrator is asked. `copies` pins each signed file by its path, as Qualcomm ships it and signed; `sameFile` takes a signed copy as the file it was, so the X2's plugin patch (npu-patch.ts) goes in over a signed GenieX as over Qualcomm's, keeps the signed copy as `.stock`, and its `needs` are met by signed copies. A version without one installs as before.
- `overlayFiles` makes the folder of each file it copies where it isn't there.
- **Who signed each server's files** (`node/signatures.ts`): every .exe, .dll, .pyd and .node in the folder of each model server config.json starts, with the signature Windows finds on it (its maker's, Castellan's, a catalog's, or none) and its signer (`signatureInventory`, `inventorySay`). `node <agent>\src\kit\signatures.ts [--all] [--json]` prints this PC's. The NPU check shows it (`NpuCheckReport.signatures`, its log's Signatures line and each unsigned file), and setup keeps it in signatures.json beside blocked.json (`rememberSignatures`; `SetupOptions.signaturesFile`). A developer's view: nothing in it is a notice for the staff.
- **Castellan's catalogs** (`node/catalogs.ts`, `node/catalog.cs`). A route's `catalogs` (`NpuSignedCatalog`: a server version, the file, its size and SHA-256, what it lists) are signed catalogs of its maker's unsigned files, carried in `node/catalogs/`. Setup installs the ones for the route's version in Windows' catalog database before anything of the server runs, and removes the route's older ones, through one administrator prompt, only where Smart App Control is on or in evaluation (`ensureCatalogs`, `NpuPlan.catalogs`, `NpuIo.catalogs`). The staff still download the server from its maker. `node <agent>\src\kit\catalogs.ts` lists the ones Windows holds; `remove` removes them; `test <file.cat> <folder>` checks that a catalog lets Windows load what Smart App Control blocks.
- **The catalog helper**, `catalog` in prebuilt.ts' `HELPERS`: a console program that adds and removes catalogs and loads a file as Windows would to run it. It runs only from its signed copy: compiled on the PC, Smart App Control would block it too.
- **One administrator prompt a run.** Setup asks for every catalog the run may need before anything of it runs (`catalogsOnce`): the NPU's server's and, beside a CUDA build of llama.cpp, NVIDIA's runtime's (`LLAMA_CATALOGS`, route `cuda`). It asks again only for a catalog it wasn't asked for, so a prompt turned down isn't put up again for the NPU's second models or for the card set up in its place. `NpuIo.catalogs` takes the routes whose older catalogs go (`routes: string[]`).

### What changed

- **The Snapdragon X2 pins GenieX 0.9.3** (its `serverPin`, 0.9.1 before), as the first X does since kit 2.101.0, so one GenieX and one signed build serve both. 0.9.3 is 0.9.1 with `/status` and a signed catalog for its Hexagon libraries: the same llama.cpp e467e5b, plugin source and b11645 embedding server, and the plugin patch's 0.9.3 entry (0.9.1's build over 0.9.3's own) was measured on an X2 running it. Setup puts 0.9.3 on a new X2; the NPU check and the benchmark run an X2 whose GenieX can't say its version as 0.9.3; the reports count an X2's speeds at 0.9.3.
- **Signed, and pinned** (the signing sitting of 2026-10-23, `tools/sign-binaries.ts`): GenieX 0.9.3's signed build (`signedBuilds`: Qualcomm's SDK zip and Castellan's 16 signed copies, each pinned both ways), so a new Snapdragon X or X2 runs no installer; the Snapdragon NPU's embedding servers from Castellan's signed copies of llama.cpp b11645 and b11125 (`embedServer.download`, the releases repository's, in place of ggml-org's unsigned zips); FastFlowLM 1.0.7's catalog (`catalogs`, castellan-amd-fastflowlm-1.0.7.cat) and NVIDIA's CUDA runtime 12.4's (`LLAMA_CATALOGS`, castellan-cuda-cudart-12.4.cat), carried in `node/catalogs/`; and the catalog helper, signed (`node/prebuilt/catalog-635f89b2d399.exe`).
- **FastFlowLM 1.0.10's catalog, carried but not used** (`node/catalogs/castellan-amd-fastflowlm-1.0.10.cat`, 17,357 bytes, SHA-256 5b989f4f…; it lists 1.0.10's 36 unsigned program files): made and signed in the same sitting, for the kit that moves AMD's route to FastFlowLM 1.0.10. In 2.108.0 the route stays on 1.0.7 and no route's `catalogs` names it, so setup never installs it.
- `installSignedBuild` says which step failed (`{ step, why }`: a download, or putting it together), so setup's NPU step fails at `download` or `install` as with an installer; `NpuIo.installBuild` stands in for it.

### Before you update

- Nothing: take the kit as usual. A route without `catalogs` or `signedBuilds` sets up as before, and nothing asks for an administrator where Smart App Control is off. A GenieX already installed isn't changed: its installer's files stay as they are, and an X2 on GenieX 0.9.1 keeps running 0.9.1 with 0.9.1's build (the Smith offers it 0.9.3). An embedding server already set up is kept too: only a new one comes from the signed copy.

## 2.106.0

**A generation of an NPU can say the biggest model size a manager has tested on it; the Smith offers no bigger.**

### What changed

- **`NpuGeneration.testedUpTo`** (`{ params, basis }`) is new: the biggest model, in billions of parameters, a manager has tested on that generation's NPU and found worth letting customers try, and how it was tested. The kit doesn't read it. The Smith's scout (Smith 0.8.87) offers newer models up to the larger of this and the size of the model the NPU runs now, within what the PC's memory allows. Without it, nothing bigger than the model the NPU runs is offered. To lift the cap for one NPU, set it in a kit after benchmarking that size; no Smith release is needed.
- No generation sets it yet. spec/NPU-VENDORS.md ("Bigger models the Smith offers") says why and how.
- The catalog's test checks any `testedUpTo` it finds: a size above zero, and a basis.

### What an agent must do

- Nothing. Only the Smith reads the field, and it reads it in a way that also works with earlier kits.

## 2.104.0

**Setup knows when Windows' Smart App Control blocks a model server, and goes on to the next one that runs; the NPU check and the benchmark stop at once when their server exits.**

### What changed

- **Smart App Control's state is detected** for every maker: `Detection.smartAppControl` (`on`, `evaluation`, `off`, or null where it can't be read, and always in a test run: `smartAppControlOutsideTests`, app-control.ts). `detect()` takes its reader as a second argument.
- **A blocked start is known by its exit as well as by the log.** `BLOCKED_EXIT` (0xC0E90002, STATUS_SYSTEM_INTEGRITY_POLICY_VIOLATION), `blockedExit`, `saysBlockedExit`, `exitCodeSay` and `blockedExitSay`. FastFlowLM 1.0.7's flm.exe exits so at once under Smart App Control, printing nothing, to pull and to serve (a Ryzen AI 7 350, 2026-10-22); the Code Integrity log names the library it stopped at (`llama_npu.dll`, `qwen3_5vl_npu.dll`, `qwen3_5_omni_npu.dll`, `qwen3vl_flash.dll`). The keeper's start (`blockedFirst`) says so too where the log names no file.
- **Setup tries the NPU's server anyway, then falls back.** When its pull or test request fails and the log names blocked files in its folder (events 3033 and 3077, read only), or it exited 0xC0E90002, the NPU fails as `not-supported`, `NpuSetup.blocked` lists the files, and its work goes to the graphics card or the processor as for any NPU that fails. Their llama.cpp build is tried in turn: a blocked file other than a processor variant (`stoppingBlocks`) stops it, said as a problem, and when the card's build is blocked the processor is tried next (`setupCommand`). Nothing is judged before it's tried.
- **The note says where the work went** (`npuBlockedNote`, `chatInstead`): "The NPU (…) isn't used: Windows' Smart App Control blocks its model server, as its maker doesn't sign it. The staff use the processor instead." When nothing setup tried runs: "Windows' Smart App Control blocks the staff's local models on this PC: …". It never asks the person to turn Smart App Control off.
- **blocked.json** (`blockedFile()`, beside npu-note.json): each file Windows blocked at setup's last run, with its policy and its server, and Smart App Control's state then (`rememberBlocked`, `readBlocked`), for a round of signing. It's cleared when setup runs with nothing blocked. `SetupOptions.blockedFile` puts it elsewhere; with a detection given, none is kept unless it says where.
- **`blockedIn` moved from `SetupIo` to `NpuIo`**, which `SetupIo` extends; `NpuIo.smartAppControl` gives the state.
- **npu-check and npu-bench stop when their server exits before it answers.** `RunningServer.exited()` says whether it has (its exit code for a plain child, null for one started apart, watched by its process id). `serverClient.untilAnswers(deadline, gone)` returns null at once when `gone()` says so, and `exitedSay` says why: the block, the exit code and the log's last three lines. The check's `start` step (its `data.exited` and `data.blocked`) and the benchmark's cold or cached load fail with it, where they waited out their 20 minutes or more. The benchmark's wait for its embedding server stops the same way.
- **Tests that compile and load a DLL or launcher of their own** (pace's two with gentle-test.dll, working-set's, named's two launchers) skip with the reason while Smart App Control is on.
- spec/NPU-BENCHMARK.md: AMD's three-way series (a Ryzen AI 7 350, 2026-10-23), its counters' names with their " power" suffix, `rapl_package0_pkg` as its whole, and FastFlowLM streaming with its usage.

### Before you update

- Nothing for most agents: take the kit as usual. An agent's own `SetupIo` with `blockedIn` keeps working, as `SetupIo` extends `NpuIo`. A fake `RunningServer` without `exited` waits as before.

## 2.103.0

**Intel's NPU now answers questions about pictures as well as chat: Qwen3-VL-2B takes the 4B's place, on Castellan's build of OpenVINO GenAI.**

### What changed

- **Intel's model is now `Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov` (2.5 GB), for chat and pictures.** It's Castellan's symmetric INT8 export of Qwen3-VL-2B-Instruct, on Hugging Face with its card; every model file and its two picture configs are pinned. Its `size.longest_edge` is 1,048,576 pixels, so a picture is at most about 1,024 tokens inside the NPU's compiled prompt. Its vision endpoint's `pictureTokens` is 1,024 too, so the kit redraws a larger picture to fit and counts each one so.
  - OpenVINO's INT4 export of the 2B (group size 128) answered "Yes" to "Reply with the single word: ready", every time. OpenVINO's NPU build of the 4B answered as well, but about three times slower, in 2.5 GB more memory.
  - **Its picture detail is in the form the NPU runs.** Qwen3-VL adds features from its picture encoder's middle layers to its first three language-model layers (DeepStack). optimum-intel exports that step as a masked add, which the NPU plugin (NPUW, 2026.4.1) doesn't recognise: it never fills the mask, so on the NPU those features were zeroed and clear text was misread (4837 for 4827). The export has the three steps rewritten into transformers' own form (`scatter_deepstack.py`, in its Hugging Face repository; the weights unchanged), and the language model's two files are pinned anew. On the NPU it now answers as the processor does, 16 pictures of 16; on the processor and the graphics, word for word as before.
- **Castellan's build of OpenVINO GenAI** (`node/openvino/`: `README.md`, `openvino-genai-castellan.patch`, `build-openvino-genai.bat`, `LICENSE` and `NOTICE`). Before it, Qwen3-VL failed on the NPU with OpenVINO Model Server 2026.4.1's own `openvino_genai.dll`: a prompt without a picture crashed, and once a request had failed, every later one failed until the server restarted. The build fixes both.
  - It's 7.5 MB, so it isn't in the kit. The route's `pluginPatch` pins it on Manor-releases by `url`, size and SHA-256 (`NpuPluginPatch.patched.url`, in place of `from`), for every Intel generation.
  - `planNpu`'s plan has it as `patch`, and counts its download.
  - Setup downloads it into the tools home (`servers\patches`, `hostedPatchFile`) and puts it in before it tests the model (`installPatch`). It goes in only over OpenVINO Model Server 2026.4.1's own file, and only while `openvino.dll` and `tbb12.dll` are that version's. Intel's own is kept as `openvino_genai.dll.stock`.
  - The keeper's look (`patchNpu`) puts it in again, tested, where the server's own came back. It never downloads: without the file, its record says `not-downloaded`.
  - `NpuPluginPatch.required` says why a route's models need its patch. config.json's `npuPatch: false` doesn't take such a patch out.
- **A PC already on the 4B moves to the 2B at Set up local AI.** The keeper's look never downloads: it finds the 2B and the build missing and records `needs-setup` (`npu-refresh.json`). Until now setup with no ids left a configured NPU entry alone, so nothing acted on that record, and a PC stayed on its old model however often Set up local AI was pressed (a Snapdragon X2 on the Qwen3-VL-4B too, though spec/NPU-VENDORS.md said it would move).
  - `planSetup` takes the record (`npuRefresh`, which `setupCommand` reads with `readNpuRefresh`). With no ids, an entry the look left for setup, on the route's own server (`runsRoute`), is set up again. One a person pointed at another server, or one the keeper found current or hasn't looked at, is still left alone.
  - So is an entry on its generation's `fallback` (a first-generation X Elite on the Qwen3-VL-4B, where its 2B failed): Set up local AI tries the 2B again, as spec/NPU-VENDORS.md said it would, and should it fail again sets the 4B up again quietly (`fellBack`, no note, no alarm). The keeper's look still keeps the fallback as it is, so it's never retried on the look's rounds.
  - Setup downloads the 2B and the build, then tests the 2B with a picture and a chat. If the test fails, config.json keeps the 4B's entry, and the record stays `needs-setup`, so the next Set up local AI tries again. The graphics card or the processor takes the pictures. Where the 2B doesn't fit (a 12 GB Intel PC), the 4B's entry is left as it is.
  - The setup log's line for a card taking the NPU's work names only what the card takes: "The graphics card takes the NPU's vision instead" where the 4B's kept entry still chats.
  - Setup's test now first stops a server of the entry's own program that answers on its port without listing the model (`stopOtherModel`), in the NPU's turn. OpenVINO Model Server serves only the model it started with, so before this the old 4B server would have answered the 2B's test with a 404, and the PC would never have switched.
- **Intel's retired list** (`routes.intel.retired`, by kit 2.101.0's rule): the 4B's folder, `{tools}\models\openvino\Castellan-AI\Qwen3-4B-Instruct-2507-int4-cw-ov`, since 2.103.0. The keeper removes it three days after nothing on the PC names it; a PC whose 2B failed still names it in its entry, so there it stays. There's no generation `fallback` to the 4B: the 2B is the route's own model on every Intel generation.
- **The NPU 3720's prompt is read 256 tokens at a time** (meteor-lake, arrow-lake, wildcat-lake: `NPUW_LLM_PREFILL_CHUNK_SIZE` 256, `GENERATE_HINT` BEST_PERF; it was 128). Measured with the 2B on a Core Ultra 5 225U: a 1,805-token prompt in 3.8 to 3.9 s against 4.3 to 4.4 in 128-token chunks, and a small picture in 1.8 s against 2.0, for a short answer 0.5 to 0.7 s against 0.3 to 0.6. At these settings the 2B does the benchmark's three jobs in 12.9 s, writing 17.9 tokens a second, against 18.7 s at OpenVINO's own settings and the 4B's 27.4 s and 13.2 tokens a second.
- **Intel's `memoryGb`**: the NPU 3720's chat 4.9 GB (it was 3.8), with its embeddings on the graphics 1.3 (meteor-lake); arrow-lake's and wildcat-lake's chat 4.9; the route's chat, Lunar Lake's and Panther Lake's at 4,096 tokens, 5.5 (it was 4.3).
  - OpenVINO GenAI runs Qwen3-VL's picture encoder on the processor beside an NPU, and the server keeps what a full-size screenshot took: 1.9 GB more, the screenshot read in 12 to 15 s on the NPU 3720. On its graphics the encoder read twice as fast, but read a large picture's 4827 as 4877 three times in four, which the processor read right every time: it stays on the processor.
  - So a 16 GB Lunar Lake or Panther Lake no longer has room for embeddings beside chat (`npuMemoryFit`): setup gives them to the graphics card or the processor. A 12 GB Intel PC no longer runs the NPU's chat. A 16 GB NPU 3720 keeps both: measured together after full-size screenshots, the two took 5.8 GB of its 6.2.
- **setup's plan** names a downloaded build of a server file (`describePlan`: get Castellan's build of OpenVINO GenAI …, in place of the server's own `openvino_genai.dll`). A server without the file isn't patched.
- **npu-bench** runs a server copy with a downloaded build too (`kitPlugin`).
- spec/NPU-VENDORS.md and spec/NPU-BENCHMARK.md: the 2B's figures on Intel's NPU.

### Before you update

- Nothing for an agent: take the kit as usual. An Intel PC moves to the 2B the first time its local AI is set up after the keeper (the Smith, else Reeve) has looked at it with this kit, and that setup downloads 2.5 GB. Before that look, Set up local AI leaves its NPU as it is. On a 16 GB Lunar Lake or Panther Lake, that setup also moves its embeddings off the NPU.
- A Snapdragon X2 still on the Qwen3-VL-4B moves to the 2B the same way (1.9 GB), as spec/NPU-VENDORS.md said it would.
- A first-generation X Elite on its fallback 4B tries the 2B again at each Set up local AI, which tests it on the NPU (nothing to download where it was pulled before).

## 2.102.0

**One text reader for the Clerk, the Scribe, Reeve and the Warrener: PDFs read from their own text, word boxes for Reeve, answers that no console can garble, and a check any PC can run.**

### What's new

- **One reader, for all four** (spec/OCR.md). `ocr.ts` keeps `ocrFiles` as it was, so the Clerk and the Scribe take it unchanged, and adds what the others need:
  - `boxes`: each page read in `layout` (`OcrPage`: `file`, `page`, `width`, `height`, `lines`, `source`), each line's words with their boxes (`OcrLine`, `OcrWord`: `t`, `x`, `y`, `w`, `h`) in the picture's own pixels. A PDF page's are in the page as rendered at `pdfScale`, from the text layer or the engine alike (on a display scaled above 100%, Windows renders bigger, and the engine's boxes are scaled back).
  - `ocrImages(files, { scale, batch, tmpRoot })`, Reeve's: each picture's `{ file, width, height, lines }`, or its `error`. Pictures are read as stored, as Reeve's reader did (`orient: false`).
  - `scale: 'auto'` (2 below 1,000 pixels, else 1) and `pdfMaxPages: 1`, the Warrener's peek. OneDrive's online-only files are left unread (`cloudOnly`), PDFs now checked before Node opens them.
  - `orient` (default true): photos turned as their EXIF says.
  - `source` (`'text'`, `'ocr'` or `'mixed'`) and `engine` (`OCR_ENGINE`, `'windows'` for now) on each result. The engine sits behind the API: the NPU's model, next, changes no staff code.
- **PDFs that carry their text are read from it** (`pdf-text.ts`, `readPdfText`, `needsOcr`), exactly and without rendering: about 60 ms for a PDF against 500 to 700 ms rendered and OCRed. Only the pages without text (scans, text drawn as shapes) are OCRed; a PDF of both is read page by page. Encrypted PDFs and those over 64 MB are OCRed whole, as before. It is the kit's own, on Node's zlib: no dependency, and nothing more in each agent's `src/kit` than its 1,300 lines (pdf.js would bring megabytes). `pdfText: false` OCRs every page, as before.
- **The reader's check** (`ocr-check.ts`, with `ocr-fixtures.ps1` and `spec/ocr-check.json`): `node src/kit/ocr-check.ts [--scale 1,2] [--runs 3] [--out report.json]`. It draws the Snapdragon Dev Manager's 25 bench pictures (the same figures as the baseline), the same strings drawn by Edge at 100 to 200%, a PDF with a text layer and a scanned one, and a held-out set of strings and fonts no model may be trained on. Then it reports, per engine and per group, characters and words right, lines read exactly, ms a picture, processor time and peak memory. Windows OCR's figures on a Snapdragon X2 are in spec/OCR.md.
- `pdf-make.ts`: small PDFs with known text, or a JPEG page, for tests and the check.

### What changed

- **Answers in ASCII.** `ocr.ps1` writes everything outside printable ASCII as `\uXXXX`. Where PowerShell's output was the console's code page (437), a bullet became a bell character, which broke the answer's line, so that file went unread. `parseAnswers` also reads a line with a raw control character, and gives a line that still won't parse as that file's error rather than dropping it.
- `OCR_SCRIPT`, the engine's script as ocr.ts sends it, is exported (for the check).

### Before you update

- Nothing for the Clerk and the Scribe: `ocrFiles` answers as before, with `source` and `engine` added. A PDF with a text layer now gives its exact text, which may differ from what OCR made of it (an agent that compares text across runs sees it change once). Reeve and the Warrener can drop their own readers for `ocrImages` and `ocrFiles`.

## 2.101.0

**The first-generation Snapdragon X runs Qwen3-VL-2B, with the 4B as its fallback, and the keeper removes the model files the NPU's routes no longer run.**

### What's new

- **Qwen3-VL-2B on the first-generation X** (X Elite, X Plus). Its generation (`snapdragon-x`) has the X2's Qwen3-VL-2B Q4_0 as its own `models`, and pins GenieX 0.9.3 (`serverPin`): Qualcomm AI Hub builds no 2B for the X Elite, and 0.9.3 carries llama.cpp's signed Hexagon v73 code. Played on the X2 Elite on v73 code (2026-10-23): a first answer 2.2 s after the start, 71.2 tokens written a second, 21 of 24 quality items, 4 of 4 pictures and setup's red picture seen red, 0.05 processor cores busy, a 2.69 GB working set; AI Hub's X Elite build of the 4B, played the same way, 8.1 s, 41.1, 22 of 24, 3 of 4, 1.02 cores and 5.92 GB (spec/NPU-VENDORS.md, Qwen3-VL-2B on the first-generation X).
  - On GenieX 0.9.0 and later the X gets Castellan's build of GenieX's plugin, GENIEX_PATCH_POLL with it, so its processor's threads sleep while the NPU writes. A version's `pluginPatch` may name another generation's build by its id (`"snapdragon-x": "snapdragon-x2"`), which `pluginPatchOf` follows.
  - `playedRoute` gives GenieX `GGML_HEXAGON_ARCH` too, so a played X's 2B runs v73 code in GenieX's llama.cpp plugin as its embeddings do.
- **A generation's fallback** (`NpuGeneration.fallback`: the route's own models it names, and why). The X's is the 4B. `routeFor(…, { fallback: true })` and `planNpu({ fallback: true })` give the route with them; `planSetup` puts that plan on `NpuPlan.fallback` where it fits the PC's memory, and `describePlan` says so.
  - `setUpNpu` tries the generation's own models first, its test requiring the red picture seen red (`NpuIo.testNpu`'s `seeRed`: its options are now testNpuEntry's, so an agent's io that passes a `logFile` still extends `NpuIo`). Should a step after the server's install fail (pull, checksum, test, measure), it stops their server in the NPU's turn (`NpuIo.stopServer`, by default the keeper's new `stopServerAt`) and sets the fallback up on the same server. The NPU gets its entry and no problem is said: `NpuSetup.fellBack` holds the fallback's route, its models and what failed first, and the report names the fallback. Should the fallback fail too, the first try's failure, as before.
  - The keeper's NPU refresh keeps an entry on a fallback model (npu-refresh.ts), and never moves it in the background.
- **The model files the routes no longer run are removed** (retired.ts). Each route in npu-vendors.json may list them: `retired`, npu-vendors.ts' `NpuRetired` (`path`, a `match` for the files in that folder it names, the GenieX `model` id it was served by, `since`, `why`). The keeper's look calls `removeRetiredModels` after `refreshSmallModel`.
  - It looks on a PC that has the route's server installed, or whose NPU entry runs it. A file or folder no string in config.json and no running model server's command line names (by its path, its name or its model id) is recorded in `retired-models.json` beside config.json, and removed once unnamed for `RETIRED_GRACE_MS` (three days), a folder renamed aside first. Named again, it's kept and its count starts over. Never in an Everyone install's shared folder.
  - Qualcomm's list: setup's Qwen3-VL-2B Q4_K_M for the graphics and the processor (since 2.100.0), AI Hub's Qwen3-VL-4B, and `qualcomm/Qwen3-4B-Instruct-2507`, the install's own GenieX entry's model until 2.100.0. A route that stops running a model adds it there.
- **A pin may accept the builds pinned before** (`pinned[generation].earlier`, npu-vendors.ts' `PinnedFiles`): `checkPinned` passes files that are wholly one of them, and still says what differs from the current build otherwise. The 4B's X Elite pin is AI Hub's current build (v0.65.0, QAIRT 2.50), with its earlier build, no longer published, kept there for an X that pulled it.

### What changed

- **`refreshSmallModel` no longer removes the Q4_K_M** (`removeRetiredModels` does, the first file on Qualcomm's list): it takes no `running`, returns `{ changed }`, and drops a retired file from `small-model.json` once it's named again or gone. `SMALL_MODEL_GRACE_MS` is gone: retired.ts' `RETIRED_GRACE_MS` replaces it. A Q4_K_M a person points config.json at again is kept while config.json names it.
- `routeFor` merges a server version's embedding server `env` over the route's, so a route given again (a played one) keeps what a caller added.
- spec/NPU-VENDORS.md and spec/NPU-BENCHMARK.md name the X's models, its fallback and the retired files.

### Before you update

- Nothing for an agent: take the kit as usual. One that called `refreshSmallModel` with `running`, or read `SMALL_MODEL_GRACE_MS` or the `removed` it returned, drops them: the keeper's look removes the files now. An X set up before keeps its 4B until setup is run again.

## 2.100.0

**On a Snapdragon X2 the reranker runs on the NPU, the graphics and the processor read the NPU's own Qwen3-VL-2B file, and the GenieX default is the X2's model.**

### What's new

- **The NPU reranks on a Snapdragon X2.** Asked for a reranker (`--serve rerank`), setup puts it on the NPU where the NPU has llama.cpp's embedding server: that server's program and environment started a third time, `--reranking` on port 18185 (the route's new `rerankServer`, npu-vendors.ts' `NpuRerankServer`), `-c 4096 -b 2048 -ub 512`, with Qwen3-Reranker-0.6B Q8_0. It is tested first (setup.ts' `testNpuRerank`), in the NPU's turn; a failed test leaves it to the processor (`npuMissing` now says `rerank`). Not on a PC under 20 GB (`smallPc`).
  - Measured on the X2 Elite Extreme: Reeve's 24 rerank queries gave the same results as on the Adreno (12 first, 19 in the top five), its order the same up to near-ties; a ten-file rerank in 849 ms against 1,558 on the Adreno and 2,286 on the processor; 1.10 GB of the NPU's memory; GenieX's chat beside it at 73.2 tokens a second against 73.3 (spec/NPU-VENDORS.md, Reranking on the Hexagon).
  - `npuEntry` takes `rerank` (its file, model and port) and `npuRerank` builds the endpoint from an entry's embedding server. The keeper looks after it as the NPU's (`reapedServers`) and stops it when idle as it stops the embedding server; the NPU refresh stops it with the others and makes it again on the embedding server it writes.
- **One copy of Qwen3-VL-2B on an X2.** Where GenieX's cache has unsloth's Q4_0 at its pinned size (setup.ts' `npuChatFile`, from the route's `offNpu`), setup gives the graphics and the processor that file in place of downloading the Q4_K_M, with setup's own Q8_0 projector beside it (`ModelFile.path`; the plan says `have …: the NPU's own copy`). As fast on the Adreno and the processor, the same answers (spec/NPU-VENDORS.md, One copy of Qwen3-VL-2B).
  - On a PC set up before, the keeper's look (`refreshSmallModel`, each look) points their `-m` at that file (`withNpuChatFile`), starting and stopping nothing, and removes the Q4_K_M once nothing in config.json has named it for three days and no running process names it (`small-model.json` beside config.json). Never in an Everyone install's shared folder; a Q4_K_M a person puts back is kept.

### What changed

- **`GENIEX_CHAT_MODEL` is `unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0`**, the X2's. The old id, `qualcomm/Qwen3-4B-Instruct-2507:W4A16`, is still known as a default (`GENIEX_EARLIER_CHAT_MODELS`), so `isInstallDefaultNpu` still drops an npu an earlier kit wrote by default on a PC without an NPU, and nothing else.
- spec/NPU-VENDORS.md: the makers' table names each route's models now (AMD's `qwen3.5:2b`, the X2's Qwen3-VL-2B Q4_0 on GenieX 0.9.x); spec/NPU-BENCHMARK.md and spec/ACCELERATORS.md the same.

### Before you update

- Nothing for an agent: take the kit as usual. An agent that reads `rerank` with `endpointFor(a, 'rerank')` finds the NPU's the same way. Its model servers on the NPU take the NPU's turn, as before.

## 2.99.1

**No model server is started while the manor is stopped from Manor's Settings.**

### What changed

- **`ensureServer` honours Manor's stop.** While Manor's `stopped.json` is in its folder (Settings, **Stop the manor**, until **Start the manor**), a server that is down isn't started: `ensureServer` throws `ManorStopped`, a `ServerNotRunning`, before any start. So a request through `Npu` marks nothing failed and goes on to a server that is already running, if one serves it; with none, its `NpuError` says the manor is stopped (the core's `say.manorStopped`). The keeper's restarts are refused the same way, logged once as a skip, and setup's tests say so.
  - Before, Reeve's MCP tools or any agent's model work started GenieX or another server again moments after Manor's stop had ended them.
- **manor.ts' `manorStopped()`**: since when the manor is stopped, or null (no file, or one without `since`). Under `node --test` only a test's own `MANOR_HOME` counts, so a PC with its manor stopped never fails an agent's tests.
- The NPU benchmark starts its own servers (npu-server.ts' `startServer`) and isn't held: the owner stops the manor to run it on a quiet PC.
- spec/ACCELERATORS.md: the stopped manor.

### Before you update

- Nothing for an agent: take the kit as usual. It needs a Manor with **Stop the manor**; with an older Manor nothing changes.

## 2.99.0

**The NPU benchmark measures the same model on the NPU, the graphics and the processor on every route, measures embeddings, and runs a series of runs with a summary of their medians.**

### What's new

- **`npu-bench --device GPU|CPU` on the Snapdragon and AMD routes.** GenieX and FastFlowLM run on the NPU only, so off it their model runs on llama.cpp b11734, setup's pinned build for the device (`variantFor`): the Adreno's OpenCL build or Arm64's on an X2, a Radeon's Vulkan build or x64's on AMD.
  - A route says its model's llama.cpp form in `offNpu` (npu-vendors.ts' `NpuOffNpu`): the GGUF files, pinned, where they may already be (`present`), the context and any arguments.
  - The X2's is the very Qwen3-VL-2B GGUF GenieX pulls, at GenieX's `--nctx` 2560. AMD's is unsloth's Qwen3.5-2B Q4_0 GGUF, at FastFlowLM's 4096, its thinking off.
  - `planOffNpu` says what's needed and what's missing; `setUpOffNpu` downloads it, checks each file in place against its pin, finds the graphics' llama.cpp device by name, and builds the entry as setup would (`acceleratorEntry`), without writing config.json. The runs take ports 100 above the route's.
- **Embeddings.** The suite's new `embed` section: once the chat server has stopped, the embedding server is started by itself and timed to its first vector, then a query and requests of 16 texts of 1,500 characters (`embedTexts`).
  - The report's `results.embed`. With a meter, `energy.embed` (what keeping the embedding model loaded costs) and `batches.embed`.
  - The route's embedding server is set up with it, but never past `--no-setup`, which leaves the embeddings out and says so.
- **A series, and its summary.** `--device NPU,GPU,CPU` runs several devices, a round at a time; `--runs <n>` runs each n times (`npuBenchSeries`). Each run writes its report; then `benchSummary` takes each device's medians (`castellan-npu-bench-summary/1`), and `summarySay` prints them as a table.
  - The summary has what keeping each model loaded costs a day (Wh/day), each batch's job over rest by part, and the whole PC's energy and time for each batch.
  - `--summary <report.json>...` sums up reports from separate runs.
- **The kit's build of GenieX's plugin** (`kitPlugin`). Where GenieX's own plugin is still in place on an X2, the run takes a copy of GenieX in `{tools}\bench\` with the kit's build: GenieX's files are copied, its QAIRT folder is linked, and the copy is removed after (`removeCopy`, links first), with the bench folder once it's empty.
  - The report's `run.plugin` says which plugin ran. A run on GenieX's own is marked `plugin` and not ranked.
- **A held port is left to its server.** Where something holds a route's port (the keeper's server), the run takes ports beside it (`routeOnFreePorts`) and is marked `beside` (`conditions.beside`), rather than stopping.
- **A busy processor is waited for**, up to `quiet.waitMinutes` (10), before a run starts.
- **Each rest waits for the PC to settle** (`settle`). The whole PC's draw is read ten seconds at a time until two readings agree within 5% (`SETTLED`), for up to three minutes (the suite's `energy.settleSeconds` and `settleMinutes`). Only then is the rest read; the battery's is read as it is.
  - On the X2, rests read straight after another device's run came out up to 7 W high, and a model loaded seemed to cost less than none.
  - The summary shows a cost below nothing as "too small to tell".
- **A run with `--energy` holds the PC awake with its screen on** (`holdAwake`), from its start to its end, as a video player does. No setting changes, and the hold ends however the run ends.
  - With the screen off, Windows takes a PC into Modern Standby. The X2 rested there at 5.4 W against 9–10 W awake, so a run that crossed into it compared two different PCs.
  - The report says so (`conditions.awake`), and how many times the PC went into standby all the same, from Windows' log (`conditions.standby`). More than none is marked `standby` and not ranked.
- `energyBatch` is exported: a batch of work as one stretch on the meter.

### What changed

- spec/npu-bench.schema.json: `conditions.beside`, `conditions.awake`, `conditions.standby`, `run.plugin`, `results.embed` and `energy.embed`, all optional. The suite stays `castellan-npu-bench/2`: nothing it asked before changed.
- With `--yes`, a fresh Intel PC downloads the route's embedding model too (428 MB), and the prompt counts it.
- The embedding requests take the NPU's turn as the chat requests do (2.98.2's `io.turn`), so the keeper's reaper leaves the embedding server alone too.
- spec/NPU-BENCHMARK.md: Comparing devices (how to run a series and read its summary, the X2 Elite's figures, and the commands for Intel and AMD); spec/NPU-VENDORS.md: Off the NPU.
  - On the X2 Elite, the NPU does the agents' work for a third to a fifteenth of the energy the Adreno and the processor take, at much the same speed. A model held on the NPU costs the whole PC about 1.1–1.3 W at rest, mostly in the chip around it.

### Before you update

- Nothing for an agent: the benchmark is a command run by hand, and nothing else uses it.

## 2.98.2

**The NPU benchmark measures energy on Intel, and runs to the end: its requests take the NPU's turn, so the keeper's reaper no longer stops its server partway.**

### What changed

- **power-meter.ts reads Intel's counters.** On a Core Ultra 5 225U, Windows' Energy Meter counters are RAPL's: `rapl_package0_pkg` (the chip whole), `_pp0` (its cores), `_pp1` (its graphics) and `_dram` (0 there). With no `system`, the whole was the first one listed, the graphics. Now it is the package (`pkg`), and `partsSay` names its cores the processor, `_pp1` the graphics and `_dram` memory. The Snapdragon's are unchanged.
- **npu-bench.ts takes the NPU's turn for each request** (`BENCH_TURN`, `io.turn`), as an agent's request does, whichever device it runs on. Its server is on the route's port, which the keeper's reaper watches as the NPU's and stops once nobody has taken the NPU's turn for its idle time.
  - Without it the reaper stopped the benchmark's server 7 minutes into a run on the 225U, and every answer after failed (quality 0 of 24).
  - A turn held for the whole run was tried and doesn't do: anyone else counts a holder stale after `rules.json`'s `lock.staleMs` (10 minutes), and the reaper took the lock then (every energy batch 0 of 20, on each device).
  - A request that waits `BENCH_TURN.waitMs` (10 minutes) for the turn ends the run with a `start` mark that says so.
- spec/NPU-BENCHMARK.md: Intel's counters, the turn (Running it, step 4), and the first energy runs on Intel (the 225U's NPU, graphics and processor).

### Before you update

- Nothing for an agent: only the benchmark and the meter changed.

## 2.98.1

**Castellan's GenieX build lets the processor's threads sleep while the model is on the NPU, and GenieX 0.9.3 gets that build too.**

### What changed

- **geniex/0.9.1/geniex_plugin.dll**, rebuilt with a fifth commit, GENIEX_PATCH_POLL (`node/geniex/README.md`). With the model on an accelerator, ggml's threads poll 0 and sleep between operations rather than spin.
  - Measured on the X2 Elite: 0.05 processor cores busy against 5.12, and 251 mJ a token over rest against 699, at the same 72–73 tokens a second (Windows' Energy Meter counters).
  - The confirmation 2.98.0 asked for: GenieX's processor use was its threadpool spinning, not work.
  - A model on the processor keeps ggml's default. 0.8.0's build is unchanged.
  - Its SHA-256 is now `8205873d…`, 370,768 bytes, and the 0.9.0 entry's `pluginPatch` pins it.
- **The route's `versions` gain `0.9.3`.** GenieX 0.9.3 is 0.9.1 with a `/status` endpoint and its libraries rebuilt, so the entry names 0.9.1's build over 0.9.3's own plugin.
  - It pins 0.9.3's plugin (`9612f66a…`) and its six libraries.
  - It repeats 0.9.0's command and embedding server (b11645).
  - Before, a PC the Smith's Use it moved to 0.9.3 ran GenieX's own plugin: 3.54 GB working set after pictures against 2.72 with the build.
- spec/NPU-VENDORS.md: the processor's threads, and GenieX 0.9.3.

### Before you update

- Nothing for an agent: the keeper puts the new build in at its next look after the kit changes, in the NPU's turn, and tests it as before.

## 2.98.0

**The NPU benchmark measures energy with a real meter: Windows' Energy Meter counters, part by part, where a PC has them (the Snapdragon X2 does), a Shelly plug, or a graphics card's own reading. With one it measures what keeping a model loaded costs, and batches of each job, read and picture.**

### What's new

- **power-meter.ts**, the four meters (spec/NPU-BENCHMARK.md, Energy):
  - `emi`: Windows' Energy Meter counters. Each part's running total (`npu`, `gpu`, `cpu_cluster_*`, `memory`, `soc`, `system`), read through CIM in picowatt-hours, no administrator, at each stretch's two ends only.
  - `shelly:<address>`: a Shelly Gen2+ plug's `apower`, read every second.
  - `nvidia`: nvidia-smi's `total_energy_consumption`, else `power.draw`.
  - `battery`: the discharge rate, as before.

  The module also has `openMeter`, `measureSpan` and `partsSay`. As a command, `node src/kit/power-meter.ts [--meter …] [--seconds n]` says which meter the PC has and what each part draws.
- **npu-bench.ts `--meter auto|emi|shelly:<address>|nvidia|battery`** (it implies `--energy`; `auto` is the default):
  - `auto` reads the counters where they're there, plugged in or not; otherwise the battery, unplugged.
  - With a meter other than the battery, `--energy` also measures the PC at rest before the server starts and just after the cold load (`idle`, with `keepLoadedMilliwatts`).
  - Each part's power at rest and through the triage minutes (`restParts`, `loadParts`).
  - Batches: `energy.batch` in the suite, 20 of each job on a full run and 5 on a quick one; as many reads of 1,024 tokens; up to 8 pictures. Each batch reports each part's energy, the work's own over rest, one's and a token's.
  - It also records whether the battery was charging (`charging`).
- **The report's `results.energy`** gains `meter`, `charging`, `idle`, `restParts`, `loadParts` and `batches`, all optional. Its old fields are as they were. The format stays `castellan-npu-bench-report/1` and the suite `castellan-npu-bench/2`: no speed figure changes.
- **The spec's run guide, step 7**: check the meter with `power-meter.ts`, then run `--energy` on each device the route has.

### What changed

- `--energy` plugged in now measures where the PC has the counters. Without them it says so and how to get a figure. It used to say only to unplug.
- The battery's reading keeps its rule (`ENERGY_MIN_EXTRA`) and measures the triage minutes alone. Another meter's figure counts whenever working draws more than rest.
- A first trial on the X2 (NPU-BENCHMARK.md, On a Snapdragon): GenieX's chat drew 5 W on the NPU, but about four cores of the processor (25–40 W). A quiet run is to confirm it.

### Before you update

- Nothing for an agent: it carries the new file and the benchmark's new options, and nothing else changes. A reader of the benchmark's reports that rejects unknown fields in `results.energy` should allow the new ones.

## 2.97.1

**What everyone reads names no hardware: a model's note is "note from the local AI, unverified" wherever it ran. Developer features are said to come with hired developer staff, not a Developer options switch. And the QAIRT runtime's licence is Qualcomm's AI Runtime SDK EULA. This release brings 2.97.0 too, never released on its own.**

### What changed

- **core/messages.js: `noteLabel(a, developer = false)`.** Without `developer` it's "note from the local AI, unverified", whatever wrote the note. Before, every agent's page showed everyone where it was written ("note from the NPU, unverified"), developer features off too. `noteLabel(a, true)` is the label as it was, naming where, for a developer's view or a log. New: `LOCAL_AI` ("the local AI", as spec/DEVELOPER-OPTIONS.md calls the model). `theAccelerator` is unchanged and still names the hardware: it's for developers' views, logs and the kit's messages, never for what everyone reads.
- **page.ts: `unverified(text, from, developer = isDeveloper())`** labels the note that way, and its hover says "Written by the local AI" unless it's a developer's view, which still says "Written by a local model on the NPU".
- **accelerator-vectors.json:** each message case's `noteLabel` is the plain label now, and the new `developerNoteLabel` is the one that names where.
- **Developer staff, not a Developer options switch.** Manor has had no Developer options switch since Manor 0.16.33: hiring a developer staff member is what turns developer features on, and letting the last one go turns them off. `developerOptionsNote(setBy)` now says "Developer features show while developer staff are hired in <manor>", linking to Manor's Settings, Employees (`manorStaffUrl`, new). `DEVELOPER_ONLY_FORM` says "These settings can be changed only while developer staff are hired." spec/DEVELOPER-OPTIONS.md says how it works now. `developerOptions`, settings.json's key, and every name in code stay.
- **`plainNotesField`'s help** says "by the local AI on this PC, labelled unverified", no longer "labelled with where it ran".
- **npu-vendors.json: the QAIRT runtime's licence.** 2.97.0 said the QAIRT runtime inside GenieX's installer had no licence of its own (all rights reserved, so Qualcomm's Terms of Use and personal, non-commercial use). That was wrong. GenieX's QAIRT plugin's THIRD_PARTY_NOTICES.md (items 1 and 2) puts the runtime under Qualcomm's AI Runtime SDK EULA, which allows commercial use as part of an app. The Snapdragon route's `licence` and its QAIRT `terms` entry now say so, in one line of what it allows and forbids, linking to the notices. NPU-VENDORS.md's Licences table gives the owner's reading of the grant, from two copies of the SDK's licence, and still says to have it reviewed. GenieX's own entry (BSD-3-Clause, and Qualcomm's Terms of Use) is as it was.

### Before you update

- **A test that asserts a note's label by its words fails**: `noteLabel(from)` and `unverified(…)` say "note from the local AI, unverified" now, never "note from the NVIDIA GeForce RTX 4090, unverified", "note from the NPU, unverified" or "note from a local model, unverified". A test that compares with `noteLabel(undefined)` passes as it is. Where the page's developer view should still say where a note was written, pass `noteLabel(from, isDeveloper())` and assert that.
- **A hover that names `theAccelerator(from)` to everyone** ("Written by a local model on the NPU") should name it only in a developer's view, as `unverified` now does.
- A label an agent saved with its note (a cache of explanations) keeps its old words until the note is written again.
- An agent whose own words tell a customer about a "Developer options" switch should say developer staff instead.
- Nothing else: the exports are the same, and `noteLabel`'s new argument is optional.

## 2.97.0

**Local-AI setup downloads only the llama.cpp build and models the kit pins, each checked against a SHA-256 carried in the kit, and names Qualcomm's terms before it downloads anything for a Snapdragon's NPU.**

### What's new

- **setup.ts: pinned downloads (`LLAMA_PIN`, `MODEL_PINS`, `pinnedRelease`, `pinnedHfFiles`, `pinnedModelUrl`, `PinnedDownload`).** llama.cpp b11734, the manor's signed copy (`llama.cpp-b11734`), for every variant: the processor's on x64 and Arm64, CUDA 12.4 with NVIDIA's runtime from ggml-org's release of b11734, Vulkan, and OpenCL for the Adreno. The models at a Hugging Face commit, fetched from `resolve/<commit>/`: Qwen3-VL-2B-Instruct's Q4_K_M and its Q8_0 projector, Qwen3-Embedding-0.6B's Q8_0, and Qwen3-Reranker-0.6B's Q8_0. Each file's size and SHA-256 are in the kit's code, taken from downloads checked on 2026-10-22 against the release's checksums and Hugging Face's own record. `llamaReleases()` returns the pin and asks GitHub nothing; `setupCommand` plans from `pinnedHfFiles` and asks Hugging Face nothing. They are the build and files setup took before, in the same folders, so a PC set up already downloads nothing again.
- **Mirrors (`PinnedDownload.mirrors`, carried on `ReleaseAsset`, `ModelFile` and `Download`).** Other places that serve the very same file, tried in turn when the first fails or serves another file, each checked against the pinned size and SHA-256: never trusted for their own word. None is listed yet.
- **npu-vendors.ts: a maker's terms (`MakerTerms`, `terms` on `NpuRoute` and `NpuModel`, `npuTerms`).** The Snapdragon route names GenieX's licence (BSD-3-Clause), the QAIRT runtime inside it (Qualcomm's AI Runtime SDK EULA, as 2.97.1 corrects it) and Qualcomm's Responsible AI License; AI Hub's Qwen3-VL-4B adds its model card's Usage and Limitations. `npuTerms(plan)` gives the ones that come with what the plan downloads (the route's when its server is to be installed, a model's when it is to be pulled; each document once, the Responsible AI License last; none once everything is there).
- **`SetupPlan.terms` and `termsLines`.** `describePlan` prints them after the download's size, one line each with its link, under "Qualcomm's terms come with what this downloads for the NPU: setting it up means you accept them, for everyone using this PC and your staff.", and `setupCommand`'s question becomes "Download 5.1 GB, under the terms above? [y/N]".
- **The Steward's tools/sign-llama.ts** writes the pin of the build it signs (`llama-pin.ts`, beside the zips), to put in setup.ts.

### What changed

- **`download` keeps only a pinned file.** One without a 64-character SHA-256 is refused before anything is fetched. A source that serves another size or SHA-256 is refused, and the next mirror is tried. When none serves the pinned file it throws "<file> wasn't downloaded: <host> served a file whose SHA-256 is …, not the … the kit pins: refused. Nothing was installed from it; setting up again tries once more", leaving no `.part` and a file already at `dest` as it was.
- **Gone from setup.ts:** `KIT_LLAMA_UNSIGNED` (ggml-org's newest builds), `parseSignedReleases` (the releases repository's newest signed build), `ghExe` and the GitHub API calls. `hfFiles` stays, to find a new pin, and returns `HfFile[]`; setup never plans from it.
- A build lacking what a card needs now says "the llama.cpp build this kit pins (b11734) has no <variant>". The first line of a run reads "Looking up what this PC needs (llama.cpp b11734 and the models, as this kit pins them)...".
- **npu-vendors.json:** the Snapdragon's embedding model is fetched at Qwen's commit (the same file and SHA-256 as before), and the Qualcomm route's and AI Hub model's `licence` lines say what the review found.
- NPU-VENDORS.md's Licences table and ACCELERATORS.md's "Pinned downloads" say the same.

### Before you update

- An agent that imports `ghExe` or `parseSignedReleases` from the kit's setup.ts, or sets `KIT_LLAMA_UNSIGNED`, must stop: they're gone. `SetupOptions.hfFiles` and `PlanInput.hfFiles` take `(repo) => Promise<HfFile[] | null>`; a function returning Hugging Face's list as before still fits.
- A page that shows setup's plan before its Set up button should show `plan.terms` there, with their links: they're in the plan's lines too.

## 2.96.2

**An update's copy of the version before goes once the new one has held up, a swap cut short is put back, and uninstall takes the kept copies with it.**

### What changed

- **safeinstall.ts: `app.prev` goes once the new version holds up.** Since 2.51.0 every agent's update keeps the version it replaces in `app.prev` and puts the new one on probation, going back to `app.prev` if it fails. `app.prev` then stayed until the next update, and through uninstall. Now it is removed once the probation passes, whether the install waited for it (`--wait`, or no watcher) or its watcher (`install --watch-probation`) did. The watcher removes it only while `app` and `app.prev` still hold the versions it was started for: a later install's `app.prev` is that install's to keep. The line that says so is now `<name> <version> held up for 90 s, so <before>, kept in …\app.prev to go back to, is removed.` (it was `<before> stays in …\app.prev, to go back to by hand`). Manor's update log leaves the new line out, as it leaves out any "held up" line it doesn't read.
- **install.ts: a swap cut short is put back first (`unfinishedSwap`, `finishSwap`).** An install moves `app` aside to `app.old`, then the release in. If the PC went off between the two, `app` was missing and the installed copy was in `app.old`: the next install took that for a first install, deleted `app.old` and put the agent on duty. Now `install` and `safeInstall` move `app.old` back to `app` first, and say so, so the update keeps the duty it had and is guarded like any other. Every kit's install swaps this way, so this mends one an older kit left too. `safeInstall` does it before refusing a flagged version, so the agent can start again. `--dry-run` says it would.
- **install.ts: uninstall removes `app.prev` and `app.unsafe-<version>` (`keptCopies`).** They're copies of the program, not its data. `--dry-run` names them. One that can't be removed (a file in it is open) is named, and uninstall goes on.
- **kit/test/update-path.test.ts (new).** The kit's real install behind its fail-safe, over real folders: updates from copies older kits installed, with the layouts they left (`app.prev` kept since the last update, a stale `app.old`, a swap cut short, an older version's flag and kept copy), a new version that holds up, one that stops answering on probation, one that never answers after the swap, a flagged version refused and a newer one taken, the watcher, and uninstall.

### Before you update

- Nothing: take the kit and release as usual. An update runs the new release's own kit, so an agent behaves this way from the update after the one that brings it this kit.

## 2.96.1

**A strict page sends a browser that isn't signed in to Castellan, which opens that same page signed in.**

### What changed

- **page-access.ts, strict pages (`KIT_STRICT_PAGES=1`, still off by default).** A browser opening a page without the sign-in (a bookmark, a link: `Sec-Fetch-Mode: navigate`, `isNavigation`) is no longer shown a page that says to open it from Castellan. It is sent (303) to Manor's `GET /open/<id>?at=<path and query>` (`manorOpenUrl`). Manor asks the page for a launch URL (`POST /api/page-launch` with the token from its server.json and `{"path": at}`) and sends the browser on to it, so the page opens at the same address, signed in, and its hash is kept. This needs Manor to answer `/open`, which comes with the step that turns strict on.
- Only while Manor isn't answering (`manorAnswers`: its `/api/ping`, asked at most every few seconds) or isn't on this PC does the browser get `lockedPage`, so a bookmark never lands on a dead page. Its button now opens the page from Manor's `/open`, for the same address. A program's `GET /` still gets `lockedPage` (a 200, no token), and its other GETs a 401: a script's fetch is never redirected.
- **guard-kit.ps1, the shared guard's let-go mark.** `Set-LetGo` makes `<Root>\let-go` owned by Administrators (`icacls /setowner`), whatever owner Windows gave the elevated file, so `Test-Trusted` still trusts the folder when the guard is turned on again. If that fails, the mark is taken away again and it throws. `Test-LetGo`, `Set-LetGo` and `Clear-LetGo` each check the SID themselves. Call `Set-LetGo` only for a folder `Test-Trusted` trusts: one it doesn't is no guard to share, and is turned off for every account as before (as the Lamplighter's and the Watchman's install-guard.ps1 do).
- This release also brings 2.96.0, which wasn't released on its own.

### Before you update

- Nothing: pages aren't strict unless `KIT_STRICT_PAGES=1`, and an agent with a guard takes the let-go steps into its own install-guard.ps1.

## 2.96.0

**Ready for Castellan for everyone on a PC: a guard is shared by the accounts that have its agent, and an agent's page can ask who is reading it.**

### What's new

- **guard-kit.ps1 and guard.ts: one guard for the PC, shared by its accounts.** A guard (the Lamplighter's, the Watchman's) acts on the PC itself: its graphics drivers, its System Protection and restore points. Two guards would fight over the same driver, so a guard stays one per PC, under one folder and one set of task names, whichever account turned it on. With Castellan for everyone on a PC, each account may have the agent, and turning the guard off from one account must not take it from another. So an account that turns it off while another account still has the agent installed (`<profile>\.<id>\app`) only lets go of it. That leaves a mark, `<Root>\let-go\<its SID>`, written elevated and readable by every account, and the guard stays on. Once no other account holds it, turning it off removes it as before. `-Everyone` removes it for every account at once. Turning it on again holds it again.
  - guard-kit.ps1 adds `Get-ProfileList` (Windows' ProfileList: local, Microsoft, and work or school accounts; the tests replace it), `Get-AccountSid`, `Test-LetGo`, `Get-OtherHolders`, `Set-LetGo` and `Clear-LetGo`. An agent's install-guard.ps1 takes `[string]$Account` and `[switch]$Everyone`. Its `Uninstall-*` lets go, rather than removing the guard, while `Get-OtherHolders` finds anyone. Its `Install-*` calls `Clear-LetGo`.
  - guard.ts adds `letGoFile`, `letGo(root, sid)`, `guardHeld(root, sid)` and `scriptTakes(script, param)`. `GuardCommandOptions` takes `account` (this account's SID, `userSid()`) and `everyone`. `guardCommand` passes `-Account` and `-Everyone` only to a script that takes them: the guard's own older copy, used when the agent's is gone, turns it off for the PC as before.
  - `uninstallAgent` takes `sid?()` and refuses only while this account holds the guard (`guardHeld`). After `--guard-off` it goes on to uninstall when the guard stays on for others, and says so. `guardOnWords` has a last line saying so.
- **page-access.ts (new): who may read an agent's page.** The page answers on 127.0.0.1, which any process of any Windows account on the PC can reach. Its POSTs needed the token, but `GET /` handed the token to whoever asked, and `GET /api/*` were open. Now a page can tell a signed-in GET from any other:
  - **The token.** `x-token`, as Manor, the CLI and another staff member send it. `staffToken(id)` and `staffHeaders(id)` read it from that agent's `server.json` in this account's own data folder.
  - **The cookie.** `castellan_<port>`, holding the page key (`page-key.json`, kept across restarts). It is HttpOnly, SameSite=Lax and lasts 400 days.
  - **Launch URLs.** `POST /api/page-launch` (a kit route, with the token; `{"path": "/…"}`, `/` unless given) answers `{ url, expires }`: the page's address with a one-time `launch` code that lasts two minutes. A GET with a live code sets the cookie and answers 303 to the same address without the code, so a bookmark never keeps one, and a hash (`#/tour`) is kept.
  - **Strict pages.** With `KIT_STRICT_PAGES=1`, a GET that has neither the token nor the cookie gets only `OPEN_GETS` (`/api/ping` and the page's own files). `GET /` gets `lockedPage`: no token, no data, a 200 that says to open the page from Castellan and links there. Anything else gets 401 (`SIGN_IN_FIRST`). Strict is off by default for now: until Manor and every staff member that reads another's data send the token, every GET is answered as before, though a launch URL already signs a browser in.
- **service.ts:** `pageAddress()` is the address the CLI's `open` gives: a launch URL when strict, else the page's own.
- **repair.ts:** `askRepair` takes `token` (`staffToken(id)`) and then never reads the page for it.

### What changed

- Every page now says it is never to be shown in another site's frame (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), so no page can lay buttons over a signed-in one. No page of the manor's frames another.
- `postAllowed` compares the token with `sameSecret` (constant time, as before).
- `KIT_ROUTES.post` has `/api/page-launch`. No agent has a route of that name.

### Before you update

- An agent with a guard should take the shared guard into its own install-guard.ps1, guard.ts and uninstall.ts, as above. Changing install-guard.ps1 makes each PC's guard ask to be updated once.
- An agent that reads another staff member's GETs (`/api/*`, or `GET /` for its token) should send `staffHeaders(id)` on them, and give `askRepair` `token: staffToken(id)`. Pages will need it once strict is on by default.
- Nothing else: a page that isn't strict answers as before.

## 2.95.0

**Ready for Castellan's "Everyone on this PC" install: each Windows account's tasks in a Task Scheduler folder of its own, and the model files once per PC.**

Manor's Everyone install (Manor's docs/EVERYONE-INSTALL.md) gives each Windows account on a PC its own manor and staff. Task Scheduler's names are the PC's, not the account's, so two accounts' `\<Name>\Home page` were one task: the second install replaced the first's, which then started under the wrong account or not at all. And each account downloaded the same few GB of model files again.

### What's new

- **node/install.ts: a task folder per account.** `TASK_NAME` is `\<Name> (<account>)\Home page` and `WAKE_TASK_NAME` `\<Name> (<account>)\Wake`, as Manor's own tasks. `taskAccount(env)` is the account: the last part of `%USERPROFILE%` (else `USERNAME`), each of `\/:*?"<>|` made `_`; `taskName(task, env?, program?)` builds a name (the Steward's tend uses it for Manor's). `OLD_TASK_NAME` and `OLD_WAKE_TASK_NAME` are the names before.
- **node/install.ts: the old tasks moved, never another account's.** `isOwnTask(name, deps)` reads the task's XML (`schtasks /Query /XML`) and compares its principal's `<UserId>`, a SID or a name, with this account's (`userSid()`: `whoami /user`, read once). `dropOldTask(name, deps)` ends and deletes a task only when it is this account's own. `install` drops both old tasks once the new one is registered, before it starts the page; `uninstall` deletes the new names and the old ones that are this account's. A task of the old name that belongs to another account (a PC where two accounts installed the staff before) is left as it is: that account's own update moves it.
- **node/install.ts: `runOwnTask(names, deps)`** runs the first task of a list that runs, trying an older name only when it is this account's own; `taskDeps()` gives it the real schtasks. `install` (an unchanged copy) and `safeinstall`'s roll-back start the page through it, so a page still registered under the old name starts until its update moves it.
- **node/everyone.ts** (new): `sharedRoot()` (`%ProgramData%\Castellan`, or `CASTELLAN_SHARED`), `hasEveryone()` (its `everyone.json`; `removed.json` alone doesn't count), `sharesModels()` (an Everyone install, and not a Manor in a folder of its own: `MANOR_HOME` without `CASTELLAN_SHARED` shares nothing) and `sharedAcceleratorsHome()` (`%ProgramData%\Castellan\accelerators`).
- **node/accelerator-config.ts: the model files once per PC.** In an Everyone install `toolsHome()` is the shared folder, so the setup puts the model files and the model servers' builds in `%ProgramData%\Castellan\accelerators\models` and `servers`. An account whose config.json already runs servers from its own folder (set up before the PC was set up for everyone) keeps them there, as a PC set up before keeps `.reeve`. Each account keeps its own config.json, and its own server logs: `serverLogsDir()` (the keeper's reaper and NPU logs use it). `isSharedTools(dir)` says whether a folder is the shared one.
- **node/setup.ts: two accounts setting up at once.** In the shared folder, the steps that put files in place (the downloads, the NPU server's install, runtime and model pulls, the embedding model) run under a lock (`inSharedTools`: `withLock` on `accelerators\locks\setup`, held up to six hours, stale once its holder's process is gone). The second account waits for the first, logging that another account is putting the files in place, then finds them there and downloads nothing. A download still lands as a `.part` renamed into place, and a build's zip now unpacks into a new folder whole, by one rename, so a server is never seen half there. Each account's Smith still starts its own servers.

### What changed

- `InstallDeps` takes `userSid?()` (`TaskDeps` is the part the task helpers need). An agent's own install tests that fake `schtasks` see a `/Query /TN <old> /XML` for each old name after `/Create`, and in `uninstall`.
- Under `node --test`, sharing is off unless the test sets `CASTELLAN_SHARED`, so a PC with an Everyone install never decides a test.

### Before you update

- An agent that names its task in its own code (`\<Name>\Home page`, or `schtasks /Run` by hand) should use `TASK_NAME`, or `runOwnTask([TASK_NAME, OLD_TASK_NAME], taskDeps())`. One that only shows `TASK_NAME` in its usage text needs nothing.
- Nothing else: the old tasks move at each agent's next update, with nothing for the person to do.

## 2.94.0

**The guard's administrator prompt names Castellan, not Windows PowerShell, where Manor can show it.**

Turning a guard on or off asks Windows for an administrator, and Windows named what it was asked to run: Windows PowerShell, which looks alarming in a prompt the person didn't expect to see named so. Manor 0.17.7 added `Castellan.exe --admin <arguments>`, its signed launcher, which runs the same Windows PowerShell with the same arguments and ends with its exit code. The prompt now asks for that where it is there, so it names Castellan, signed by its publisher.

### What's new

- **guard.ts:** `elevatedCommand(inner, castellan?, from?)` builds the PowerShell command that asks for the administrator prompt (`runElevated`, so `guardCommand`, turning a guard on or off). Given Manor's `Castellan.exe` (`castellanPath()`: `%USERPROFILE%\.manor\app\bin\Castellan.exe`, or under `MANOR_HOME`), it asks Windows for that with `--admin` in front of the arguments, when its FileVersion is `CASTELLAN_ADMIN_FROM` (0.17.7) or later. The command checks the file itself, so no extra process runs. A Castellan.exe that is missing, unreadable or older (it doesn't know `--admin`: it would start Manor's page task and exit 0) is passed over silently, and Windows PowerShell is asked for as before.
- **guard.ts:** `runElevated` and `GuardCommandOptions` take `castellan` (`castellanPath()` unless given; `null`: Windows PowerShell alone, as tests do).

### What changed

- The elevated command is now `$f = <powershell>; $a = <arguments>; ... try { $p = Start-Process -FilePath $f ... -ArgumentList $a; exit $p.ExitCode } catch { ...; exit 1223 }`: the program and its arguments are set first, so Castellan.exe can replace the program. Exit codes are as they were, 1223 when the prompt is turned down or can't open.

### Before you update

- Nothing in an agent's code: the Watchman and the Lamplighter have this in their own guard already, and no agent takes it from the kit yet. An agent that turns its guard on or off through `guardCommand` or `runElevated` gets the Castellan prompt once its Manor is 0.17.7 or later, with no change of its own.

## 2.93.3

**A test file that never ends no longer holds a whole check run, and the PC's turn, until its time limit.**

On 2026-10-21 a kit trial of the Reckoner's sat for 52 minutes on one test file whose tests had finished. One of them had failed (its port was in a range Windows keeps for itself), and the schedule that test never got to stop kept the file's process alive, its next round an hour away. Node's test runner waits for every file's process to end, so the run waited with it, holding one of the PC's check turns, until it was ended by hand. Left alone, the Steward's time limit at the pace would have stopped it at 100 minutes, reported as a run out of time rather than the test that failed.

### What changed

- **checks-pace.ts:** a paced `node --test` (node itself, as the Steward's and the Assayer's runs are) gets node's own guards, beside its `--test-concurrency` (`withTestGuards`):
  - `--test-force-exit`: a file whose tests are all done ends, though it left a timer or a server running. Its results are reported as they are: the failed test above showed its error in a second, where it had waited.
  - `--test-timeout`: a file still running past two and a half minutes (`TEST_FILE_MS`), stretched as the pace stretches the run's limit (`pacedSlower`: ten minutes at the usual caps), is ended and failed, "test timed out" under its name, while the other files run on. Its limit counts from the file's start, not its wait for a place.
- A guard the command gives itself (its own `--test-timeout`, `--test-force-exit`) stays as it is. Commands that aren't node's own `--test` (an npm script, a type check) are as they were.

### Before you update

- Nothing in an agent's code. A test file that took longer than ten minutes at the pace now fails: none of the manor's comes near (their whole suites take a few). A file that keeps its process alive after its tests is still a bug to fix in the agent (stop what it started, even when a test fails before its `finally`), but it no longer stalls the run.

## 2.93.2

**Urgent fix: the staff's FFmpeg is signed, so Smart App Control lets it run.**

The FFmpeg the staff fetch (the Miller to shrink videos, the Chronicler to record) is the manor's own lean LGPL build, and nothing in it was signed. Smart App Control blocks an unsigned program it doesn't know, which the manor's build is: where it's on, a video wasn't shrunk and a recording didn't start, with a Smart App Control notice for each try.

### What changed

- **ffmpeg.ts:** the pinned build is n8.1.3-6, n8.1.3-5 with every program and library in it signed by the manor, from the public Manor-releases (`ffmpeg-v8.1.3-6`), pinned by SHA-256 for each processor.
- **ffmpeg.ts:** `olderBuild(dir)` says whether a folder is an older build of the manor's (`<base>\ffmpeg\<version>\<folder>\bin`, a version no longer pinned). `toolDirs` leaves those out (the FFmpeg the agent used last, PATH, `also`), so a PC that used the unsigned build fetches the signed one in its place, once, shared by the staff. A folder the FFmpeg setting names is kept: that's the person's choice.

### Before you update

- Nothing in an agent's code. Each PC fetches the signed build (about 12 MB) the first time an agent looks for FFmpeg after the update. The older build stays on disk, unused.

## 2.93.1

**Urgent fix: where Smart App Control is on, a sign-in no longer brings a notice for every staff member: their pages start as Node.js, which its maker signs.**

On 2026-10-21 the owner's gaming desktop (Smart App Control on) showed a stream of Smart App Control notices at each sign-in, one for each agent's `named-<id>-<hash>.exe`. That is the launcher that shows an agent by name in Task Manager. It's compiled on each PC, so no one has signed it, and Smart App Control blocks a program it doesn't know unless it's signed. Kit 2.91.0 started the page as plain node after the block, but the block and its notice still came first, at every sign-in.

### What changed

- **named.ts:** no launcher is built or used where Smart App Control is on, or where Windows is still weighing whether to turn it on (evaluation: it may turn on at any time). The page starts as node.exe, as it does off Windows; it isn't shown by name in Task Manager there.
  - `namedHeld` asks Smart App Control's state each time a launcher would be used or built. It holds every agent's launcher on the PC in `named.held`, in the kit folder they share. A hold for Smart App Control is let go once it's off.
  - `namedBuilt` returns null while held, so `open` starts the page as node at once. `namedLauncher` compiles nothing while held.
- **service.ts:** a launcher Windows blocked holds every agent's launcher from then on (`namedHold`), whatever policy blocked it. Only the first agent to start after the update can meet a block; the rest start as node.
- **app-control.ts:**
  - `smartAppControlState()` reads Smart App Control's state from the registry without elevation (`VerifiedAndReputablePolicyState`: 1 on, 2 evaluation, 0 off), with one reg.exe of about 20 ms. It's null off Windows or where it can't be read.
  - `parseSacState` reads reg query's answer.
  - `bySmartAppControl(blocks)` says whether Smart App Control made a block.

### Before you update

- Nothing in an agent's code. An agent whose own code compiles a program or library on the PC (PowerShell's `Add-Type -OutputAssembly`) can ask `smartAppControlState()` and compile in memory instead where it's on or in evaluation, as Smart App Control blocks the compiled file too.
- On a PC with Smart App Control on, the agents' pages no longer show by name in Task Manager. The launchers already compiled stay in the kit folder, unused.

## 2.93.0

**A repository's own checks can go through the Seneschal to any of the owner's PCs, even one with no copy of the repository, uncommitted changes included.**

### What's new

- **The `checks` kind (Seneschal 0.5.0):** the Assayer's work, a repository's checks as its files at a commit set them out, on any git host.
  - A task says where its code is got from (`remote`: the repository's URL, https, ssh or scp-like, with no sign-in in it) and the tools its files need (`needs.tools`, from the closed list `SENESCHAL_TOOLS`).
  - A worker that gets the code itself says `clones`. It may then name no repository and ask for `checks` of any, and clones from the remote with its own PC's sign-in.
  - A worker is handed a `checks` task only when it names the kind, so the Steward's workers never see one.
- **Uncommitted changes as a patch (Seneschal 0.5.2):** a `checks` task may carry `patch`, the text of `git diff --binary` from its commit, at most `SENESCHAL_MOST_PATCH` (512 KB). Only a worker that says `patches` is handed one; its lease carries `{ sha256, bytes, text }`, and `patchOf` checks the text against both.
- **`prepMs` in a report (Seneschal 0.4.0):** of a run's time, what went to getting the code ready (clone or fetch, checkout, patch, install). It is kept between none and the run's whole time.

### What changed

- **seneschal.ts:**
  - `SeneschalCheckKind` gains `checks`. `CHECK_KINDS`, which `jobOf` takes by default, doesn't, so a worker gets one only by naming it.
  - `SeneschalTask` gains `remote` and `patch` (text); `SeneschalNeeds` gains `tools`; `SeneschalOutcome` gains `prepMs`.
  - `SeneschalJob` gains `remote`, `tools` and `patch`. `jobOf(t, kinds, { patches })` checks each again (a remote that isn't a path, an option or another transport; tools off the list; a patch only on `checks`, only for a worker that applies patches).
  - `SeneschalWorkOptions` gains `clones` and `patches`; `seneschalWork` sends them, and with `clones` asks with no `repos`.
  - New `remoteOf` and `patchOf`.

### Before you update

- Nothing: an agent that doesn't name `checks` works as before. An older Seneschal refuses a `checks` task, and it runs as before.

## 2.92.0

**A release now proves it can sign before it builds, and reuses the signed native files of a release before whose native sources haven't changed, so most releases don't need SimplySign Desktop at all.**

### What's new

- **A real test signature first:** before a published release builds its native files, it signs a throwaway file with its own certificate and timestamp server.
  - On 2026-10-20 the old check passed while SimplySign Desktop's session had dropped. The build ran for minutes, then every file failed with "The specified CSP could not be found".
  - Now a key that can't be reached is said at once, before anything is built, in plain words: connect SimplySign Desktop.
  - Any other error (a timestamp server that didn't answer) is tried once more after 15 seconds, then said as signtool said it.
- **Signed native files kept and reused:** once a release has signed a processor's native files, a copy is kept, keyed by what they were built from. A later release with the same key takes that copy instead of building and signing that processor. It does so only once each file is the one kept and `signtool verify /pa` still accepts it.
  - The key: the native sources at the commit released, the processor, the certificate, and kit.json's `build` and `out`. The native sources are the build script's folder plus the new `"inputs"`.
  - A release whose native sources haven't changed needs neither the build nor the signing key, and doesn't check the key at all.
- **A dropped session said in words:** "The specified CSP could not be found" and "Keyset does not exist" now mean the key can't be reached. Signing stops at once instead of trying a batch three times.

### What changed

- **sign.ts:**
  - `trialProblem` signs with `signArgs`, timestamped, `TRIAL_TRIES` (2) tries `AGAIN_MS` (15 s) apart. Anything but a key it can't reach or a hang ends in `TRIAL_FAILED` ("signtool couldn't sign a test file …") with signtool's last two lines. It takes `timestamp` and `pause`.
  - `KEY_GONE` holds signtool's words for a key it can't reach; `signProblem` uses it.
  - `verifySigned` runs `signtool verify /pa` on the kept programs, 40 at a time. Then it checks that those signed here are Valid, the certificate's and timestamped.
  - `signFiles` takes `pause`.
- **signed-native.ts (new):** `signedStoreOf`, `sourcesAt`, `signedKey`, `keptSigned`, `takeSigned` and `keepSigned`.
  - Copies are kept in the agent's checkout data folder (`<ID>_HOME`, else `%USERPROFILE%\.<id>-dev`), under `signed-native\<key>\`, the newest two per processor.
  - A copy whose files don't match what was kept is let go. One whose signatures don't check out now is kept, and the release signs afresh.
- **native.ts:**
  - kit.json's `"native"` takes `"inputs"`: files or folders outside the build script's folder that the build reads.
  - `nativeSources` lists the native sources, and `filesUnder` is exported.
  - `NativeSteps` takes optional `reuse` and `keep`. `buildNative` takes a processor's kept copy when `reuse` gives one, and keeps the files it signs.
- **release.ts:**
  - `signingFor` asks for the signer before building only when some processor has no kept copy, or the tree is dirty. Otherwise it asks only if a kept copy fails its check.
  - The native sources count toward a dirty tree. A reused processor's line in the release's output names the release its files came from.

### Before you update

- Nothing in an agent's code. If an agent's native build reads files outside its build script's folder, list them in kit.json's `"native"` as `"inputs"`. Otherwise a change to them alone ships the files signed before it.
- The first release on this kit builds and signs as before, and keeps its signed files: up to two copies of each processor's native files.

## 2.91.0

**The kit's own helper programs are signed, and a start that Smart App Control blocked gets one more try.**

- **Signed helpers:** the small programs the kit runs beside an agent (the checks' pace launcher, the one that keeps the PC awake during work, and the two that set the gentle pace and hand a model server's memory back) used to be compiled on each PC. On a PC with Smart App Control on, Windows blocks a program it has never seen unless it's signed, and a program each PC compiles itself is one it has never seen. On 2026-10-19 the gaming desktop blocked the checks' pace launcher eight times in two seconds, so a check failed to start (`spawn UNKNOWN`). The kit now ships them compiled and signed with Castellan's certificate. A PC compiles one itself only when its source has changed since it was last signed.
- **One more try after a block:** when a local AI server couldn't start and Windows' log shows it blocked a file of it, the server is started once more, 2 seconds later. On the desktop where they were seen, each block was a one-off. If it's blocked again, the message says so as before.
- **An agent's page starts even if its name launcher is blocked:** the launcher that shows an agent by name in Task Manager is compiled for each agent, so it can't be signed in advance. When Windows blocked it, the page now starts as plain node instead of not at all.

### What changed

- **prebuilt.ts (new):** `HELPERS` lists the four helpers (checks-pace, awake, gentle, working-set), with each one's output type. `prebuilt\` holds each one signed, named for its source (`prebuiltName`). The hash is taken with plain line ends, so a checkout's CRLF names the same file. This kit's are `checks-pace-b01ccaf308fc.exe`, `awake-84217c865cad.exe`, `gentle-049b3ec19d1a.dll` and `working-set-73c38b5f495c.dll`. `signedHelper` copies it into the shared kit folder as `<name>.signed.<ext>` and returns that path. It returns null when the kit has no prebuilt copy for this source, and the caller then compiles as before. It never throws.
- **checks-pace.ts, awake.ts, gentle.ts, working-set.ts:** each takes `signedHelper(...)` first, then its own compiled file. awake.ts takes its output type from `HELPERS`.
- **accelerators.ts:**
  - `start` tries once more after `BLOCKED_AGAIN_MS` (2 s) when `blockedFirst` found a block (a `BlockedStart`). The retry is noted in the server's log.
  - `ensureServer`'s `readBlocks` gives tests their own Code Integrity log.
- **service.ts:** when an agent's page didn't come up through its named launcher, and Windows' log shows that launcher blocked in the last 15 s, the page is started again without it.
- **The Steward's `tools/sign-helpers.ts`** compiles each helper as a PC would (Windows PowerShell's Add-Type), signs it (Certum, timestamped), checks it, and puts it in `kit\node\prebuilt\`. It removes any copy there whose source has changed. A kit test fails when a prebuilt helper no longer matches its source: sign it again, or remove it.

### Before you update

- Nothing in an agent's code. The prebuilt helpers come with the kit's node part, about 70 KB in `src\kit\prebuilt\`.
- A helper already compiled on a PC stays in its folder, unused once the signed one is there.

## 2.90.0

**Local AI's llama.cpp builds are now signed, so Windows' Smart App Control lets them run.**

- **Signed for Smart App Control:** ggml-org signs none of its llama.cpp builds, and on a PC with Smart App Control on, Windows blocks unsigned files it doesn't know. On 2026-10-19 the gaming desktop's blocked one of b11734's processor variants. Setup now downloads llama.cpp only from the manor's signed copies: each build is ggml-org's own, unchanged, and every .exe and .dll in it that ggml-org left unsigned carries Castellan's signature, which Smart App Control trusts whatever its cloud knows of the file. On that desktop, with Smart App Control on, the signed b11734 served Qwen3-VL-2B on its RTX 4080 SUPER and on its processor with no block.
- **Fewer files loaded at each start:** once a llama-server is ready, the processor variants its build holds beside the one it chose are removed, as kit 2.88.4 meant to do at setup.
- **Builds that were checked first:** a new llama.cpp build reaches the PCs only once it's signed, after the Smith's checks have passed on it, so a build that answers wrongly (as b11511 did on the Adreno) never reaches them.

### What changed

- **setup.ts:**
  - `llamaReleases` reads the signed builds, the releases repository's `llama.cpp-<build>` releases (`SIGNED_LLAMA_REPO`, `parseSignedReleases`), newest first. It adds NVIDIA's CUDA runtime (`CUDART_ZIP`) from ggml-org's release of the same build: NVIDIA's files, unchanged and not ours to sign, as ggml-org ships them. It never falls back to ggml-org's unsigned builds. `KIT_LLAMA_UNSIGNED=1` takes ggml-org's newest instead, to try a build before it's signed.
  - A signed build unpacks into a folder named by its signed tag (`servers\llama.cpp\llama.cpp-b11734-cuda-12.4-x64`), so a PC set up with ggml-org's copy gets the signed one in full.
  - When no signed build has the files a card needs, setup says so (`no llama.cpp build signed for the manor … has cuda-12.4-x64`) and downloads none.
  - `LLAMA_VARIANTS` lists the builds `variantFor` names, which are the ones the manor signs.
  - `cpuVariantLoaded` and `keepCpuVariant` move to `app-control.ts`; setup.ts still exports them.
- **accelerators.ts, app-control.ts:** the x64 builds of b11734 never print `loaded CPU backend from …` with their output redirected, so 2.88.4's setup kept all 14 processor variants there. Once a llama-server whose folder holds more than one is ready, `keepLoadedVariant` reads the variant the process loaded (`loadedCpuVariant`: `tasklist /m ggml-cpu-*`, ggml-cpu-alderlake.dll on the desktop's Intel processor) and removes the others (`keepCpuVariant`). The server's log says so. A folder is asked once: after that it holds one.
- **The Steward's `tools/sign-llama.ts`** signs a build and drafts its release. It downloads ggml-org's zip for each of `LLAMA_VARIANTS`, checks it against GitHub's digest, signs each unsigned .exe and .dll (Certum, timestamped), checks every one, and zips it again under its own name. llama.cpp's MIT license goes beside the zips, as ggml-org's carry none. Its release is a draft until a PC with Smart App Control on has run it.

### Before you update

- Nothing in an agent's code.
- A PC set up before keeps its unsigned build until its local AI is set up again. Setting it up again downloads the signed build once: about 0.6 GB for an NVIDIA card (its build and CUDA runtime), and under 35 MB for the others. The old build's folder stays.

## 2.89.0

**Graphics cards with memory of their own now chat and see with one Qwen3-VL-2B server, as integrated graphics and the processor already do, in place of Qwen3-4B beside Qwen3-VL-4B.**

- **A smaller first download:** setting up local AI on such a PC downloads 2.2 GB of models where it downloaded 6.1 GB.
- **More of the card left free:** about 4 GB of a 16 GB card.
- **One server fewer to start again after a game.**
- **Faster answers at the same scores:** about twice as fast.
- **Pictures on smaller cards:** 8 to 12 GB cards now read pictures too.

A PC set up before moves its chat onto the Qwen3-VL-4B server it already has at the keeper's next look, so its card holds one server in place of two with nothing to download. It gets the 2B the next time its local AI is set up.

The owner asked on 2026-10-19, from a gaming desktop setting up its local AI, whether its models could be consolidated as the NPUs' were. Measured that day on its RTX 4080 SUPER (CUDA, llama.cpp b11734), with the harness of the 2026-10-17 runs:

- Every server passed all 13 of the Smith's checks.
- On the 18 tasks scored by code, Qwen3-VL-2B and Qwen3-4B got 16 each, and Qwen3-VL-4B got 15.
- At the card's own flags (two slots, `-c 16384`), 18 other tasks of the same kind, asked twice, scored 15, 16 and 16.
- The 2B wrote 332 tokens a second against Qwen3-4B's 180, and read 22,370 against 10,845.
- The 2B's one server held 3,932 MiB of the card where the two 4B servers held 9,780.

spec/ACCELERATORS.md has the tables.

### What changed

- **setup.ts:**
  - `specFor(kind)` gives `SMALL_SPEC` for chat and vision on every accelerator, cards with memory of their own included. It takes the kind alone, and `runsSmall` is gone. Setup downloads neither 4B model any more. `MODEL_SPECS` keeps their entries: the keeper's look knows an older kit's pair by them.
  - Every accelerator asked for chat and vision gets one server for both on chat's port (`chatOnVision`). The server takes chat's slots and the larger of chat's and vision's contexts (`kindFlags`). On a 16 GB card that is `-c 32768 --parallel 2`, its projector on the card.
  - Sizing counts that one server (`cardNeedGb`), with the 2B's sizes as measured on the 4080 SUPER (`SERVER_GB`: 2.1 GB with its projector, 1.4 without; `KV_BYTES`: 112 KiB a token for every model):
    - A 16 GB card serves two requests of 16,384 tokens, where it served two of 8,192.
    - A 12 GB card chats and sees at two of 16,384, where it left vision off.
    - An 8 GB card chats and sees at one of 8,192, where it chatted alone at 4,096.
    - A 6 GB card still leaves vision off.
  - The keeper's move covers cards set up before:
    - `chatsOnVision` is true for a card with memory of its own, whatever the PC's memory.
    - `withChatOnVision` moves its chat onto its Qwen3-VL-4B server's port and command, with chat's slots (`--parallel`) and the larger context (`-c`), so a card keeps its two chat slots.
    - It still changes only setup's own pair. The keeper's log says what the card gained.
- **spec/ACCELERATORS.md:** "Chat and vision on one small model" covers cards, with the measurements and the new sizes. The example config shows the 2B.

### Before you update

- Nothing in an agent's code, unless it calls `specFor(kind, accelerator)` or `runsSmall` (none of the manor's repositories does): `specFor` takes the kind alone.
- On a PC set up before, the keeper's look moves chat onto the card's Qwen3-VL-4B server:
  - Nothing is started or stopped, and nothing is downloaded.
  - A vision server already running takes chat one request at a time until its next start.
  - The Qwen3-4B server left on chat's old port stops as an orphan after 5 minutes.
  - The models' files stay in `models\`.
- The next Set up local AI downloads the 2B (1.55 GB with its projector) and sizes the card for it.

## 2.88.4

**Smart App Control: llama.cpp no longer trips it at every start, and a server it blocks says so in plain words.**

On 2026-10-19 the owner's gaming desktop (Intel processor, RTX 4080 SUPER) had Smart App Control on, and it blocked one llama.cpp file: `ggml-cpu-ivybridge.dll`, one of the processor variants ggml loads at each start to pick the best for the processor. The Code Integrity log showed events 3033 and 3077 (policy VerifiedAndReputableDesktop), and nothing else was blocked. The CUDA backend loaded, and the card ran. ggml skips a variant it can't load, but every start loaded it again, so Windows blocked it again and could show its notice each time.

### What changed

- `setup.ts`: setup asks each llama.cpp build to list its devices once, the processor's build too. The build logs `loaded CPU backend from …`, and setup keeps only that variant, removing the other `ggml-cpu-*.dll` files (`cpuVariantLoaded`, `keepCpuVariant`). The kept variant is the one ggml would pick again, so a start loads one file, not a dozen, and a variant Smart App Control blocks is never loaded again. A build that doesn't say which variant it picked keeps them all.
- New `app-control.ts`: it reads the Code Integrity log (`wevtutil`, no elevation needed) for blocks of files in a folder (`blockedIn`), and says them in plain words (`blockedSay`): "Windows' Smart App Control blocked ggml-cuda.dll, part of llama.cpp: its maker doesn't sign it, and Smart App Control blocks unsigned files it doesn't know". Another policy is named by its own name.
- When a card's llama.cpp lists no device, setup's problem names the block first, if there was one. The same goes for a server that can't start or exits while starting (`accelerators.ts` `start`), GenieX's included.

### Before you update

- Nothing in an agent's code. The next setup trims each build's processor variants. A build set up earlier keeps them all until then.
- Still open: llama.cpp's and GenieX's files aren't signed, so Smart App Control could block one the server needs (`llama-server.exe`, `ggml-cuda.dll`). The person is now told when that happens. The fix for it is a signed copy of each build, published by the manor, and that waits on the owner.

## 2.88.3

**The tour holds the page on every step, as Castellan's own welcome does: the person answers it or skips it before going on.**

The owner asked on 2026-10-19 that each staff member's onboarding disable the rest of its page, as Manor's welcome does. The tour's first two steps had a backdrop, but its third, walking the page's parts, had none: the page stayed clickable under it, and nothing stopped Tab reaching the page under any step.

### What changed

- `react/tour.tsx`: `useHoldPage` makes everything but the tour's layer inert while the tour shows (no clicks, no Tab), and lets it go when it ends. The kit's dialogs (`modal.tsx`'s host) stay usable.
- The steps that walk the page now sit on a backdrop too, `.tour-backdrop-light` (`react/styles.ts`), a light dim so the outlined part still shows.

### Before you update

- Nothing in an agent's code: its tour holds its page once it takes this kit up.

## 2.88.2

**The helper that keeps the PC awake for the staff's work no longer opens a terminal. Before, the wake task before each of the Steward's builds put a terminal window on the desktop for up to 65 minutes. Where kit 2.88.1 wasn't released before it, this release brings it too.**

The owner found a Windows Terminal window titled `…\.npu-agent\kit\awake-b333ef6686d2.exe` open over Manor on 2026-10-19. The awake helper (awake.cs) was compiled as a console program, so `\Steward\Wake`, the Task Scheduler task that wakes the PC for the Steward's builds and runs the helper with `--for 3900`, opened a console for it on the desktop. Windows 11 shows that console in Windows Terminal, where it stayed up for the whole hold, and then remained as an exited tab. It was the only scheduled task of the manor's on this PC that started a console program without a hidden console.

### What changed

- **awake.ts:** the helper is compiled as a Windows application (`-OutputType WindowsApplication`, `AWAKE_OUTPUT`), so it has no console and nothing that starts it shows a window: neither the wake task nor an agent's hold. Its input pipe works as before. An agent still ends its hold by closing the helper's input, and kills it 10 seconds later if it hasn't ended. The wake task still ends after its `--for` hold, or when the agent ends it once the work is done.
- **awakeExe:** the helper's name now hashes what it's built as together with its source. A PC that built the console helper builds the new one beside it on first use, and the wake task's XML, and so its key, changes, so `keepWakeTask` registers it again with the new helper.
- **awake.test.ts:** the real compile test checks that the built exe is for the Windows subsystem (2), not the console (3), and still holds while its input is open and ends once it closes.

### Before you update

- Nothing in an agent's code. Each agent builds the new helper (a few seconds, once per PC) the first time it holds the PC awake, and the Steward re-registers its wake task. A terminal the old helper already opened closes when its hold ends, or you can close it: closing it ends nothing but that hold.
- The old `awake-*.exe` stays in `%USERPROFILE%\.npu-agent\kit` (a few KB). Nothing uses it once the wake task has moved.

## Unreleased (its version needs claiming on the main laptop)

**An agent's own route can't take one of the kit's any more. serve() refuses it as the page starts, and agent-checks finds it in the agent's source before that. The Chronicler's shrinking card had its own `POST /api/stop`, so `chronicler shutdown` and an update's install couldn't end its page.**

The kit's server answers some routes itself for every agent, and spreads the agent's own `get` and `post` over them. So an own route of the same name took the kit's place without a word. The Chronicler's Stop for the copy being made smaller was `POST /api/stop` from its 0.1.0 until its 0.4.17 (Jcollier0120/Chronicler#28, merged). The kit's `shutdown()`, which an update's install calls, posts `/api/stop` and waits. For the Chronicler that only stopped the shrinking: the page stayed up, the install said "page is still running, so nothing was changed", and `shutdown` said the page didn't stop.

The Chronicler's main has its 0.4.17 now, whose card's Stop is `POST /api/shrink/stop`, so it can take this kit. A Chronicler before 0.4.17 fails its agent-checks on this kit, and its page wouldn't start. No other agent is affected: no route named as one of the kit's was found in the source of the 34 repositories with a kit.json on the owner's PC. Manor's `src/demo.ts` names `/api/ping` and `/favicon.svg`, but as answers in its demo data, not routes; Manor runs neither agent-checks nor the kit's server.

### What changed

- **kit-routes.ts** (new): the kit's own routes, and the guards that keep an agent's routes off them.
  - `KIT_ROUTES` lists them. GET: `/api/ping`, `/favicon.svg`, `/manor-icon.svg`, `/settings.js`, `/settings.css`, `/page.js`, `/api/peer/work` and `/api/peer/result`. POST: `/api/stop`, `/api/duty` and `/api/repair`.
  - `SETTINGS_ROUTE` is `/api/settings`, GET and POST: the kit's when serve() is given the agent's `settings`.
  - `shadowedRoutes(own, settings)` names the agent's own routes that would take one of the kit's, as `POST /api/stop`.
  - `ownRouteClashes(root)` finds them in an agent's source by reading it, without starting anything.
    - It reads `src`, but not `src/kit` or `src/web`.
    - It looks for a property named as a kit route (`'/api/stop': …`). A fetch of the route, or a ternary naming it, isn't one.
- **server.ts**: `serve()` throws when the agent's own `get` or `post` names one of the kit's routes. It names each one and says to give it a name of its own. It throws before anything starts: nothing listens and no `server.json` is written.
- **agent-checks.ts**: a new check, "its own routes leave the kit's alone". It fails with each place in the agent's source (file and line) that names a kit route as its own.
- A kit test keeps `KIT_ROUTES` the same as the tables server.ts builds, so a new built-in can't be left out.

### What an agent must do

Nothing, unless its agent-checks fail on this kit: then give the route they name a name of its own, and change whatever posts it (its page, usually).

## 2.88.1

**On a Snapdragon X2 running GenieX 0.9, a vision model's pictures go to the NPU's second Hexagon session, about three times sooner than on the Adreno, and its embeddings to a llama.cpp built for 0.9. On GenieX 0.9.1, Castellan's build of its plugin holds no more memory at rest than 0.8.0 with its build. Setup now puts GenieX 0.9.1 on a new X2. An X2 set up before keeps 0.8.0 until its owner moves it with the Smith's Use it, and every other PC keeps 0.8.0, unchanged.**

The owner pressed Try twice on the Smith's offer of GenieX 0.9.1 on 2026-10-18, and both tries failed on the first picture. The X2's Qwen3-VL-2B was set to read its pictures on the Adreno (`--vit-compute GPUOpenCL`), and GenieX 0.9.1, asked for that, tries to allocate 9.4 GB in OpenCL and crashes (0xC0000005). GenieX 0.9 reads pictures on the Hexagon's second session (HTP1) by default, so this kit asks a PC's GenieX its version and gives 0.9 its own arguments. The measurements are in spec/NPU-VENDORS.md, "A later GenieX on the PC: 0.9".

On the X2 Elite, 0.9.1 with its pictures on the Hexagon against 0.8.0 with Castellan's build and its pictures on the Adreno:

| | GenieX 0.8.0, pictures on the Adreno | GenieX 0.9.1, pictures on the Hexagon |
|---|---|---|
| Screen questions at 1,024 picture tokens | 33 of 35, a median 4.49 s | 34 of 35, a median 1.50 s |
| Questions about ten photos | 21 of 21, a median 4.42 s | 21 of 21, a median 1.45 s |
| The first picture after a chat | 2.0 s | 0.55 s |
| Chat | 73.0 tokens a second | 72.6 |
| On the Adreno after a picture | 1.54 GB | nothing |
| After a chat: working set / on the NPU | 1.6 / 1.48 GB | 3.27 / 3.21 GB |
| The first answer after a start | 3.1 s | 4.7 s |

With its own plugin, 0.9.1 holds about 1.5 GB more at rest, because Castellan's build is for 0.8.0's libraries and doesn't apply to it. So this kit carries the same patch built for 0.9.1 too, and the keeper puts it in on an X2 running 0.9.1. Measured the same evening:

| | 0.8.0 with its build | 0.9.1's own plugin | 0.9.1 with its build |
|---|---|---|---|
| The first answer after a start | 3.1 s | 4.7 s | 3.5 s |
| After a chat: working set / on the NPU | 1.6 / 1.48 GB | 3.27 / 3.21 GB | 1.62 / 1.50 GB |
| After a picture: on the NPU | 1.48 GB (and 1.54 on the Adreno) | 3.21 GB | 2.45 GB |
| The PC's available memory 75 s after a picture | 2.1 GB lower | 3.6 GB lower | 1.6 GB lower |
| The first picture after a chat | 2.0 s | 0.59 s | 1.0 s |
| Screen questions / photos / npu-bench's pictures | 33 of 35, 4.49 s / 21 of 21, 4.42 s / 419 ms | 34 of 35, 1.50 s / 21 of 21, 1.45 s / 282 ms | the same as 0.9.1's own / 278 ms |
| Chat / quality items | 73.0 t/s, 22 of 24 | 72.6 t/s, 21 of 24 | 72.5 t/s, 21 of 24 |

With 0.9.1 and its build ahead on every count but the first picture after a quiet spell, the X2 now pins GenieX 0.9.1 of its own, and setup installs it on a new X2. The route keeps 0.8.0 for the first-generation X, where 0.9.1 hasn't been measured. An X2 already set up keeps its 0.8.0, since setup never replaces an installed server: the Smith offers it 0.9.1, and its Use it moves it.

### What's new

- **npu-vendors.ts:** a route can say how to ask its server's version, and what changes from a later one.
  - `NpuRoute.versionCommand` (`{ args, pattern }`) and `installedVersion(route, { tools, env?, exists?, run? })`, which runs the route's server with those arguments and answers the version the pattern finds, or null (no server, an exit other than 0, no match, or a start that failed).
  - `NpuRoute.versions` (`NpuServerVersion[]`: `{ version, serve?, embedServer?, basis }`) and `serverVersionOf(route)`, the newest entry at or before `route.version`. `routeFor` applies it after the model's own: each model's `serve` it names, and the embedding server's `version`, `download`, `into`, `exe` and `env`.
  - `atVersion(route, version)`: the route with the version found on the PC (the route itself when null or the same).
  - `planNpu` takes `serverVersion`.
  - `NpuServerVersion.pluginPatch` (by generation) and `pluginPatchOf(route, generation)`: the kit's build of a server file for the route's version, its `versions` entry's when one applies, else the generation's own `pluginPatch` (now the pinned version's alone).
  - `NpuGeneration.serverPin` (`{ version, download, basis }`): a generation's own server version and installer, in place of the route's. `pinnedRoute(route, generation)` gives the route with it, the route itself where the generation pins none. Use it before `atVersion`, so the PC's own version still wins where its server says one.
  - `planNpu` pins only when given `serverVersion` (even null). A route a caller passes at its own version, such as a try of a later server with its own installer, is planned as given.
- **node/geniex/0.9.1/** (new): Castellan's build of GenieX 0.9.1's llama.cpp plugin (370,768 bytes, signed), its patch against v0.9.1 and its build script. The same switches as 0.8.0's build; the port keeps 0.9.1's pictures on HTP1 (the encoder, loaded later, goes there too) and loads the encoder for a `decide` with a picture. node/geniex/README.md says what changed.
- **spec/npu-vendors.json** (Qualcomm): `versionCommand` is `geniex version --skip-update`, and from 0.9.0:
  - the X2's Qwen3-VL-2B runs with `--compute npu --nctx 2560`, its pictures on HTP1;
  - the X2's `pluginPatch` is that build, over GenieX 0.9.1's own plugin and while its six libraries are 0.9.1's;
  - the embedding server is llama.cpp b11645 (e467e5b, the llama.cpp in GenieX 0.9.0 and 0.9.1, and one Metal-only commit), 13 MB with its SHA-256, in its own folder `b11645-hexagon`. b11125's `llama-server` doesn't start over 0.9's libraries (0xC0000139), and b11125's folder, which a PC on 0.8.0 uses, is never copied over.
  - the X2's `serverPin` is GenieX 0.9.1: `geniex-cli-setup-windows-arm64-v0.9.1.exe`, 70,519,444 bytes, with the SHA-256 GitHub and GenieX's own `.sha256` publish, checked on a download.

### What changed

- **npu-refresh.ts, setup.ts, npu-check.ts, npu-bench.ts** ask the PC's GenieX its version (`installedVersion`) and plan with it (`atVersion`). Each takes a `serverVersion` dep or io for tests. npu-check's rehearsal doesn't ask. npu-bench's report names the version it ran (`GenieX 0.9.1`).
- The Smith's try and Use it already set the route's version to the server they try, so they get 0.9's arguments without asking.
- With 0.9 on the PC, the keeper's refresh changes the 2B's command and offers the embeddings on b11645 (kit 2.86.0's offer) once its zip is on the PC. Setup downloads it otherwise.
- Embeddings from b11645 over 0.9.1 match b11125 over 0.8.0 (cosine 0.99936 or more over 206 texts, a median 0.999998). Reeve's search eval answered each of its nine questions at the same rank with either (4 of 9 first, 9 of 9 in the top five). A chunk takes 72 ms in batches of 16 (112), and the server holds 1.10 GB on the NPU (1.41).
- **npu-patch.ts:** the keeper asks the PC's GenieX its version (`installedVersion`, its `serverVersion` dep for tests) and puts in the build for that version (`pluginPatchOf`): 0.8.0's over 0.8.0, 0.9.1's over 0.9.1, each with the same care (the NPU's turn, a picture and a chat as its test, GenieX's own kept as `.stock`). A PC moved between the two gets the other build, with that version's own kept in place of the other's. GenieX 0.9.0, 0.9.2 or any other keeps its own plugin.
- Its message when the build doesn't fit the version is now `the patch is for GenieX 0.9.1, and this PC's is 0.9.2`.
- **setup.ts, npu-refresh.ts, npu-check.ts, npu-bench.ts, npu-patch.ts, npu-reports.ts** plan an X2 at its pin (`pinnedRoute`), then at the version its GenieX says. So setup installs 0.9.1 on a new X2. An X2 whose GenieX can't say its version is checked, benchmarked and patched as 0.9.1, and the reports count an X2's speeds only at 0.9.1.
- **npu-refresh.ts:** on a generation that pins a version other than the route's, a server that is there but can't say its version keeps its command (`unknown-version`, not written, so a later look asks again). An X2 may run 0.8.0, whose pictures need `--vit-compute GPUOpenCL`, or 0.9.1, which crashes when asked for it.

### Before you update

- Setting up a new Snapdragon X2 downloads GenieX 0.9.1's installer (71 MB) in place of 0.8.0's (65 MB), and llama.cpp b11645 for its embeddings (13 MB) in place of b11125.
- Nothing on any other PC running GenieX 0.8.0 (every PC an older kit set up, X2s included): nothing is downloaded or rebuilt, and nothing restarts. An X2 moves to 0.9.1 only when its owner takes the Smith's offer (Use it).
- On an X2 whose owner moved to GenieX 0.9 with the Smith's Use it, the keeper's next look restarts the 2B with its new command (a few seconds) and moves the embeddings to llama.cpp b11645, a 13 MB download if the Smith's try didn't already bring it. Nothing is indexed again: the vectors are the same.
- On an X2 running GenieX 0.9.1, the keeper then puts Castellan's build for 0.9.1 in, in the NPU's turn: GenieX stops, the build is tested with a picture and a chat, a few seconds in all. The kit carries the build, so nothing more is downloaded. Set `"npuPatch": false` in the keeper's config.json to keep GenieX's own.
- An agent needs no change: the keeper (the Smith, else Reeve) does it on the PC once it runs this kit.

## 2.88.0

**FFmpeg and making a video smaller are now in the kit: finding FFmpeg, fetching the manor's build once for every agent, choosing the video encoder, and re-encoding one video with its checks. The Miller and the Chronicler each carried their own copy of this, pinned to different builds. Nothing changes for either until it takes the kit's up.**

The owner's review, item 9 ("Move forked code into the kit"): the Miller and the Chronicler each carried about 1,000 lines of the same FFmpeg code (ffmpeg.ts, getffmpeg.ts, encoders.ts, media.ts, the video half of checks.ts, files.ts, and the encoder's choice and one video's re-encode in mill.ts and shrink.ts). The Chronicler copied it from the Miller on 2026-10-08, and the two have drifted apart since. They were pinned to different builds: the Miller to n8.1.3-4, the Chronicler to n8.1.3-5, which also reads capture cards (DirectShow). Each fetched its own copy (about 12 MB) into its data folder.

Merge order: this kit comes after kit 2.86.1 (claude/console-outlives-job) and kit 2.87.0 (claude/kit-shared). Rebased on them, this file and VERSION conflict, as expected: keep every entry, newest first, and VERSION 2.88.0.

### What changed

- **ffmpeg.ts** (new): FFmpeg found, fetched and run.
  - `BUILDS` pins one build for every agent: n8.1.3-5 for arm64 and x64, with the Chronicler's URLs and SHA-256 as they were.
  - `getFfmpeg({ dataDir?, shared?, home?, arch?, deps?, now?, log?, agent? })` fetches it once for every agent on the PC, into Manor's folder: `%USERPROFILE%\.manor\ffmpeg\<version>` (MANOR_HOME's when set).
    - The download is checked against its SHA-256, then unpacked beside the builds, then moved into place, as each agent's own fetch did. Nothing of a failed fetch is kept, and the next try waits 15 minutes.
    - Two agents fetching at once take turns: a lock (`.fetching`) beside the builds. The second finds the first's and downloads nothing.
    - An agent's own build, fetched into its data folder before this kit, is still found, and nothing is fetched.
    - When Manor's folder can't be made, it fetches into the agent's data folder as before. `shared: false` always does; given to `findTools`, it doesn't look in Manor's folder either.
    - The download's User-Agent and its lines name the agent (its APP.name).
  - `findTools(setting, remembered?, passOver?, { start?, dataDir?, shared?, home?, also?, agent? })` and `toolDirs` look in this order: the FFmpeg setting, PATH, the one used last, the staff's shared build (`SHARED_SOURCE`), the agent's own, `also` (more folders), and Heiward's. `-version` is asked once per build while its two files are unchanged.
  - Also: `run`, `encode`, `lastError`, `PASSED_OVER`, `HEIWARD_BIN`, `testEncode`, `pickEncoder(t, preset, words?)`, `probe`, `grindArgs` (with `format` and `cores`), `extractFrame`, `ownBin(base, arch?)` and `_resetFfmpegFetch`.
- **video-encoders.ts** (new): which encoder, with what options.
  - The `Preset` type and `PRESETS`.
  - `RANKED`, `parseEncoders`, `candidatesIn`, `targetBitRate`, `videoArgs`, `audioArgs`, `chooseEncoder(listed, trials, words?)`.
  - The gentle pace's `coreLimit`, `grindCores` and `threadArgs`.
  - `EncoderWords` (`agent`, `meanwhile`, `ownNeed`): the only words that differed between the two agents' encoder lines.
- **media-probe.ts** (new): `parseProbe`, `rate`, `isHdr` and `ProgressParser`, with the `MediaInfo`, `VideoStream` and `Progress` types.
- **video-shrink.ts** (new): making one video smaller.
  - Whether to make a copy, and whether to keep it: `planVideo`, `checkVideo`, `verdict`, `fmtBytes`, `MB`, `MAX_RATIO` (0.9) and `DURATION_SLACK`, with the `Check`, `Plan` and `VideoExpected` types.
  - `EncoderState`, an agent's state.json `encoder`, and `decideEncoder(settings, encoderState, { force?, deps?, words? })`. This is the Miller's decideEncoder; the Chronicler's encoderFor was the same but for its save and `force`. It answers `{ t, encoder? }`, and the agent saves `encoder` when there is one. `realEncoderDeps({ find?, get?, words? })` makes its deps from findTools, getFfmpeg and pickEncoder with an agent's options.
  - `shrinkVideo(file, { t, encoder, preset, inBytes, videoMinMB, temp, final, cores?, format?, onPhase?, onProgress?, onRunning?, stopping?, words?, deps? })` re-encodes one video, as the Miller's grindVideo and the Chronicler's shrinkOne did.
    - It answers `{ status, reason, checks, outPath, outBytes, how, info }`, with a status of `kept`, `refused` or `skipped`. It answers null when the agent stopped it.
    - `temp()` is asked once the plan says to make a copy, and `final()` once the copy passed its checks. So where a copy goes, and its name, stay the agent's.
- **files.ts** (new): `setFileTimes` and `recycle`, as both agents had them.
  - The agents' `writeJsonFirmly` is already store.ts' `writeJson` (kit 2.8.1), which since kit 2.73.3 also flushes the file first. Unlike `writeJsonFirmly`, it skips a file that already holds the same JSON; `always: true` writes it all the same.

### Where the two copies differed, and what the kit took

- **The build:** n8.1.3-5 (the Chronicler's) for both. The Miller gains DirectShow, which it doesn't use.
- **Where it's fetched:** once, in Manor's folder, for both. Before, each agent fetched its own into its data folder.
- **Starting FFmpeg:** the Miller's way, `windowsHide: !sharesConsole()` (kit 2.73.2). The Chronicler started a console host (conhost.exe) beside each FFmpeg.
- **`-version`:** the Miller's way, asked once per build while its files are unchanged. The Chronicler asked every time it looked.
- **`grindArgs`:** the Miller's, with `format` and `cores`. Without them it is the Chronicler's command exactly.
- **The Chronicler's look at the Miller's FFmpeg** (`~\.miller`) is `also`. With the shared build it isn't needed. It also only ever found the Miller's build when both pinned the same version, which they didn't.
- **The words are options.** They cover the agent's name, what waits while there's no encoder, the need while its own can't be fetched, whose size an early stop names ("the original's" or "the clip's") and the line for a file ffprobe can't read. Left out, each is the Miller's words with the agent's name, but `meanwhile`, which has none.
- **Kept on each agent's side:**
  - where a copy goes and what it's called: the temporary names and the final ones, the Miller's flour folder, the Chronicler's `library\<game>`;
  - what an agent records of each video (its Item), and saving its encoder state;
  - the Chronicler's look for a clip that has gone before it starts;
  - the Miller's photos (checks.ts), and its `sampleHash` and `freeName`.
- **Unchanged:** an agent keeps the FFmpeg it used last ahead of the manor's build, as both copies did. A Miller that used its own n8.1.3-4 keeps it while it works there. Clearing its state's `encoder.ffmpeg`, or that folder, moves it to n8.1.3-5.

### What an agent must do

- Nothing until it takes these up: no agent imports them yet, and nothing changes for one that doesn't.
- **The Miller**, pinned to this kit:
  - Delete getffmpeg.ts, ffmpeg.ts, encoders.ts and media.ts, and import from `./kit/ffmpeg.ts`, `./kit/video-encoders.ts` and `./kit/media-probe.ts`.
  - checks.ts keeps its photo checks and takes the rest from `./kit/video-shrink.ts`. files.ts keeps `sampleHash`, and `writeJsonFirmly` becomes `writeJson` (with `always: true` to write as before). settings.ts re-exports `Preset` and `PRESETS` from the kit, and state.ts takes `EncoderState`.
  - mill.ts calls `decideEncoder` with `words: { meanwhile: 'Videos wait in the hopper meanwhile.', ownNeed: OWN_NEED }`, and saves the `encoder` it answers.
  - grindVideo calls `shrinkVideo`:
    - `temp` and `final` in the flour folder, with its own names;
    - `cores` from `grindCores`;
    - `onPhase`, with `encoding` as its `grinding`;
    - `onProgress`, `onRunning` and `stopping` for its `current` and `stopGrinding`;
    - its Item's length, capture date and kind come from the answer's `info`.
  - getffmpeg.test.ts, find-tools.test.ts and miller.test.ts' tests of the moved code are the kit's now (kit/test/ffmpeg.test.ts, video-encoders, media-probe, video-shrink and files).
- **The Chronicler**, pinned to this kit:
  - Delete getffmpeg.ts, ffmpeg.ts, encoders.ts, media.ts, checks.ts and files.ts.
  - shrink.ts' `encoderFor` calls `decideEncoder` and saves the `encoder` it answers, with `words: { meanwhile: 'Clips wait their turn meanwhile.', ownNeed }`. Its own `ownNeed` has no "LGPL"; the default adds it.
  - `shrinkOne` keeps its check for a clip that has gone, then calls `shrinkVideo`:
    - `temp()` makes `library\<game>`, sweeps its temporary copies and names a new one; `final()` is `freeName(copyName(c))` there;
    - `words: { original: "the clip's", unreadable: "it couldn't be read" }`;
    - `skipped` is its `left`.
  - agent.ts' `getFfmpeg` and `findTools` calls drop `dataDir` (it's the default). The look at `~\.miller` goes, or moves to `also`. getffmpeg.test.ts, and engine.test.ts but for its settings, are the kit's now.

## 2.87.0

**Code that several agents each had their own copy of is now in the kit: OCR, the NPU check for speech, BM25 search, the router and the connection, game captures, the game check, the folder watcher and the guard installers' helpers. No agent changes until it adopts them.**

The owner's review, item 9: "Move forked code into the kit." Each of these was copied between agents, and the copies had started to drift. Here they are once, each the union of the copies, with every agent's current behaviour still expressible exactly (an option or a parameter where they differed). Who copies what today:

| Module | Copies today |
| --- | --- |
| ocr.ts, ocr.ps1 | the Clerk, the Scribe |
| detect.ts `NPU_PS` | the Envoy (speech-npu.ts) |
| search.ts | the Clerk, the Chamberlain |
| network.ts | the Weigher (checks.ts, speed.ts), the Bridgeward (probe.ts) |
| captures.ts, folders.ts `captures` | the Chronicler (clips.ts), the Scribe (shots.ts) |
| accelerators.ts `gameIn`, `gameNow` | the Scribe, the Marshal (game.ts), the Chronicler (autostart.ts) |
| watch.ts | the Chamberlain (#76), the Cellarer (#29) |
| guard.ts, guard-kit.ps1 | the Watchman, the Lamplighter |

This merges after kit 2.86.1 (Steward #350); kit 2.88.0 (FFmpeg, #351) comes after it.

### What changed

- **ocr.ts, ocr.ps1:** the Clerk's, with only its import changed (`./ps.ts`). `ocrFiles(jobs, { tmpRoot, onBatch? })` reads images and PDFs (the first five pages, with a thumbnail of page 1) with Windows' own OCR, in batches (`batches`); file names reach PowerShell as text, never as code.
- **detect.ts:** `NPU_PS`, the NPU lines of `DETECT_PS` alone, ending `done|` once Windows has answered (else `problem|NPU: <why>`). `parseNpus` reads its output. `DETECT_PS` itself is byte for byte as it was: the two now share their opening and their NPU lines. The Envoy's own copy differed only in looping over the devices inline; it had no Hexagon fallback, nor does `NPU_PS`.
- **search.ts:** `SearchIndex<D, F>`, BM25 (k1 1.2, b 0.75) over the fields an agent names (`fields: [{ text, weight? }]`; a file name or title at `NAME_WEIGHT` 2), with prefix matches at 0.6 (at most 30 words each) and codes found inside words ("25006" in "0x25006").
  - `search(query, limit = 50, { filter?, width? })`: a filter leaves records out of the answer, not out of how rare a word is.
  - Equal scores: the newest first (`newest`), else in the records' order.
  - Each hit has its `snippet` (escaped, the query's words in `<mark>`) from the first passage (`passages`, the first field by default) that has them, and which one it was (`from`).
  - Also exported: `tokenize`, `snippet` and the constants.
- **network.ts:**
  - The router: `parseDefaultGateway`, `defaultGateway(run?)` (null: no default route; undefined: route couldn't run), `pingTimes(address, count, run?)` and `parsePing`, and the Weigher's `gatewayState(run?)` (`up`, `down`, `none`, `unknown`).
  - The connection: `CONNECTION_SCRIPT`, one script for both agents (`up`, the cost read in its own try, Wi-Fi and its SSID, cellular, the adapter's type and link speed, signal bars, battery saver). `parseConditions` gives `{ cost, metered, batterySaver, connection }` (the Weigher's), `parseConnection` the `Connection` alone (the Bridgeward's). `readConditions(ps?)` throws when PowerShell fails; `readConnection(ps?)` gives null.
  - `ConnectionKind`, `Connection`, `Conditions`, `Gateway`, `Run`.
- **captures.ts:**
  - `gameFromName(name, { requireStamp? })`: the Chronicler's reading by default (a name with no date is its own game); with `requireStamp`, the Scribe's (a copy's " (2)" taken off, and no game without a capture app's date and time).
  - `capturePlaces({ videos, captures, more })`: Game Bar's, NVIDIA's (the app's and GeForce Experience's), AMD's and Settings' other folders.
  - `walkCaptures(places, { ext, settledMs, now, list?, skip?, requireStamp?, notGames? })` lists the settled captures, each once, with their game (null when nothing says), newest first. It gives a list where the agents' copies called `add`: the agent maps null to its "Other clips" and adds its own fields. A place with `game` set (a Steam game's screenshot folder) gives every capture there that game.
  - `NOT_GAMES` (both agents' lists together), `isNvidiaName`, `captureKey`, `list`.
- **folders.ts:** `KnownFolders.captures`, Game Bar's Captures folder (`{EDC0FE71-…}` in User Shell Folders), else Videos\Captures.
- **accelerators.ts:**
  - `gameIn(games)` is the program using a card ("a game" when the check didn't say which), or null.
  - `gameWatchCards(accs, hardware)`: the config's accelerators while one is an enabled graphics card (as `currentGames` always had it). Else hardware.json's cards are added beside them, for the check only.
  - `gameNow({ file?, hw?, now?, probe? })`: the game using a card now, from games.json while it's under 15 s old, else checked and written for everyone. Never throws. spec/ACCELERATORS.md says so.
- **watch.ts:** `FolderWatch`, the Chamberlain's and the Cellarer's watcher. It watches each folder with its subfolders (`fs.watch`, recursive, never keeping the process alive), and keeps the names changed (`Changes`: name → added, removed or renamed) until `take()`. It gives `'all'` for a folder watched only since the last take, a change with no name, more than `MAX_CHANGES` (20,000), or a watcher that failed (closed, then opened again by the next `refresh()`). Each folder's `wants(rel, named)` is the agent's own. `folderKey` is the Chamberlain's `pathKey` and the Cellarer's `folderKey`, and `key` takes another. `watch` takes a stand-in for tests.
- **guard.ts:** a guard's agent side, taking the agent's names and folders.
  - The release's scripts: `readScriptManifest`, `sha256Of`, `scriptsBehind`, `guardManifest`, `copyGuardKit`, `GUARD_KIT`.
  - Turning the guard on and off: `guardCommand(action, { dryRun, out, source, guardRoot, root?, dataDir, args, dev, elevated?, runner?, timeoutMs? })`, `runElevated`, `isElevated`, `DEV_GUARD`, `guardPresent`.
  - Uninstalling: `uninstallAgent(args, { uninstall, guardOff, out, root, words })`, `guardOnWords(root, words)` and `GUARD_STILL_ON`. The words reproduce each agent's text exactly.
  - Running programs: `run`, `Runner`, `POWERSHELL`, `psFile`.
- **guard-kit.ps1:** the installers' helpers, without the agents' prefixes (Write-WOut, Write-LOut). It is dot-sourced, then `Initialize-GuardKit -Log $Log -WhatIf:$WhatIf`. Then: `Write-Out`, `Invoke-Do`, `Invoke-Native`, `Test-Admin`, `ConvertTo-XmlText`, `Get-OwnerSid`, `Test-Trusted -Except`, `Read-ScriptManifest -Files`, `Test-ScriptHashes -Files`, `Set-FolderRights` (the SDDL is the agent's) and `Register-Task`, and `Open-Log` and `Close-Log`. Every hardening is kept as it was:
  - the log is made afresh (CreateNew), never in a folder that is a link, and held open until the end;
  - a folder is trusted only when it and all in it are SYSTEM's, Administrators' or TrustedInstaller's;
  - SHA-256 is compared in lower case, case-sensitively.
  What changed from the copies: `$Log`, `$WhatIf` and `$script:Files` are passed in rather than read from the installer. `Invoke-Do` refuses before `Initialize-GuardKit`. Naming no scripts is an error, never "all match". The Lamplighter's inbox exception is `-Except 'inbox'`. Every line printed is kept in `$script:GuardLines` (the Lamplighter's `$script:Lines`).

### Where the copies differed

- **network.ts:**
  - Its ping reading also reads a reply whose time isn't in "ms" by the number before its TTL (Russian's "время=3мс"). The Bridgeward's copy counted those as lost.
  - The connection script reads the cost in its own try. The Weigher's failed whole when Windows wouldn't give the cost; now the connection is read, with its cost null, and counted as metered, as Unknown is.
  - `parseConditions` reads the script's last line, so a warning before it does no harm.
  - JSON without `up` (the Weigher's script before this) is up when it has a cost.
- `NOT_GAMES` is both agents' lists together: "thumbnails" is new to the Chronicler, "desktop.ini" to the Scribe. Neither is ever a game folder; each agent can pass its own (`notGames`).
- `gameNow` with no enabled graphics card in the config (no local AI set up, or none on a card, or a config that can't be read) checks hardware.json's cards. The Scribe's and the Marshal's said no game there. It reads the counters (gpu-load.ps1, about 2 s) at most once in 15 s for the whole manor, and only on PCs whose hardware.json lists a card.

### What an agent must do

Nothing until it adopts a module; then it deletes its own copy and imports the kit's (`./kit/<module>.ts`), once it pins kit 2.87.0.

- **The Clerk, the Scribe (OCR):** import `ocrFiles` and `batches` from `./kit/ocr.ts`; delete src/ocr.ts and src/ocr.ps1.
- **The Envoy:** import `NPU_PS` (and `parseNpus`) from `./kit/detect.ts`.
- **The Clerk (search):** `new SearchIndex(rolls, { fields: [{ text: r => r.text }, { text: r => r.caption }, { text: r => basename without extension, weight: NAME_WEIGHT }], passages: [{ from: 'text', text: r => r.text }, { from: 'caption', text: r => r.caption }], newest: r => r.mtimeMs })`.
- **The Chamberlain (search):** `fields: [{ text: i => i.text }, { text: i => (i.from ?? '') + ' ' + (i.to ?? '') }, { text: i => title without extension, weight: NAME_WEIGHT }]`, `newest: i => i.at`, and its kind as `filter`. Its own title regex, `/.[a-z0-9]{1,5}$/i`, has an unescaped dot: it takes a last word of up to five letters off any title ("Meeting notes" is searched as "Meeting"). Pass the same regex to keep that exactly, or `/\.[a-z0-9]{1,5}$/i` to fix it.
- **The Weigher:** `gatewayState()` for its gateway check, `readConditions()` / `parseConditions()` for its speed test's conditions.
- **The Bridgeward:** `defaultGateway()` then `pingTimes(gateway, 3)` for its router probe, and `readConnection()` / `parseConnection()`.
- **The Chronicler:** `walkCaptures(capturePlaces({ videos, captures: knownFolders().captures, more }), { ext: CLIP_EXT, settledMs: SETTLED_MS, now, skip })`, mapping a null game to "Other clips". Its game check: `const g = readGames(); return g && !gamesStale(g, now) ? gameIn(g) : undefined`. Note that `gameIn` says "a game" for a busy card with no program named, where its own said no game. The kit's `knownFolders()` reads the registry once a process; the Chronicler's read it at each look.
- **The Scribe (screenshots):** `walkCaptures([...capturePlaces(…), ...steam.map(s => ({ dir: s.dir, source: 'steam', byFolder: false, game: s.game }))], { ext: SHOT_EXT, settledMs: SETTLED_MS, now, requireStamp: true })`, adding its `id` to each.
- **The Scribe, the Marshal (game check):** delete `gameIn` and `gameNow` from game.ts and import them from `./kit/accelerators.ts`. The Marshal keeps its `GameHold`.
- **The Chamberlain, the Cellarer (watcher), once their PRs (#76, #29) are merged:** import `FolderWatch`, `MAX_CHANGES`, `folderKey` and the types from `./kit/watch.ts`; keep `watchedFolders`. The Chamberlain passes `key: pathKey` (the same function) or uses `folderKey`.
- **The Watchman, the Lamplighter (guard):**
  1. Import the agent side from `./kit/guard.ts`, passing the agent's names (`GuardWords`), folders and settings as `args`. The Watchman passes `timeoutMs: 30 * 60_000`; its undo can call `runElevated` with its bin\undo.ps1.
  2. Copy guard-kit.ps1 beside install-guard.ps1 (`copyGuardKit('src/guard')`, in tools/guard-manifest.ts before it hashes, and commit the copy), and dot-source it in install-guard.ps1: `. (Join-Path $PSScriptRoot 'guard-kit.ps1')`, then `Initialize-GuardKit -Log $Log -WhatIf:$WhatIf`.
  3. **Add `guard-kit.ps1` to `GUARD_SCRIPTS` (guard.ts, tools/guard-manifest.ts) and to install-guard.ps1's `$script:Files`.** The guard's SYSTEM tasks run scripts from its bin\, and install-guard.ps1 copies every script there only after checking its SHA-256 against the release's manifest: a script it dot-sources that isn't in the list is never copied, and the guard's scripts in bin\ would fail. A guard set up before then has none in bin\; the page says the guard is behind until Update the guard.
  4. Rename the prefixed calls (`Write-WOut` → `Write-Out`, `Invoke-LDo` → `Invoke-Do`, …). Pass `$script:Files` to `Read-ScriptManifest` and `Test-ScriptHashes`, and the Lamplighter `-Except 'inbox'` to `Test-Trusted`. Tests that stand in for `Get-WOwnerSid` define `Get-OwnerSid` instead, and the Lamplighter's read `$script:GuardLines`.

## 2.86.1

**A page's console no longer ends when Manor updates, and a page whose console has gone runs its git, gh and PowerShell hidden instead of failing every one.**

On WEASELDEV02 (Intel Core Ultra 5 225U), on 2026-10-17 at 18:21Z, Manor updated itself once the PC woke from Modern Standby. Its update ends Manor's task (`schtasks /End`), and Task Scheduler then ends every process in the task's job. That job held more than Manor:

- Manor starts each page through the agent's `open`, detached. Node never asks for CREATE_BREAKAWAY_FROM_JOB, so that `open`, the cmd its `start /b` runs, cmd's console host (conhost.exe) and the named launcher all stay in the task's job.
- Only the page leaves it (named.cs, under the manor's ceiling).

So every page ran on with a console whose host had gone. From kit 2.72.2 (console.ts) and 2.74.4 (ps.ts), git, gh and powershell.exe share the page's console, and every one of them then failed before it ran, with exit 3221225794 (0xC0000142, STATUS_DLL_INIT_FAILED). For 23 hours:

- The Smith, Pinder and the Warrener failed every round.
- The Toller reported 39 projects and 0 lockfiles as a good round.
- The Steward read no version of git or gh.

`AttachConsole` on each of the ten pages Manor had started answered ERROR_PIPE_NOT_CONNECTED. A test page started the same way inside a job showed both sides:

- Ending the job: its shared starts failed with 3221225794 from the next one on, while its hidden starts ran.
- With this kit's launcher, the same page's shared starts ran on.

### What changed

- **named.cs:** the launcher starts the page with a windowless console of its own (CREATE_NO_WINDOW), on both paths:
  - out of the jobs (the manor's ceiling), where its host is outside them and so outlives Manor's task;
  - in them, as before, where it ends with them as the page does.
  
  The launcher then lets go of cmd's console (`FreeConsole`), whose host ends with cmd, so an agent still has one console host. The launcher is a new exe (a new source), built by each agent's page as usual.
- **console.ts:**
  - `sharesConsole()` looks again each time while the answer is yes: one open of `\\.\CONOUT$` (EPIPE once the host has gone), no process. Once the console has gone, the answer is no for good.
  - New: `startFailed(code, windowsHide)`, which is true for a start that shared the console and exited `DLL_INIT_FAILED` (3221225794). It also makes `sharesConsole()` say no from then on.
- **ps.ts:**
  - A one-shot PowerShell that couldn't start on a console that had gone runs once more, hidden, within its time.
  - The worker that couldn't start says so too. Its scripts already ran on their own, now hidden.

### Before you update

- Nothing for an agent that starts git or gh with `windowsHide: !sharesConsole()` per start (the Toller, the Steward, the Surveyor, the Developer Herald): its next start is hidden once the console has gone.
- An agent that keeps `sharesConsole()`'s answer, or has its own copy (the Assayer's run.ts), should ask per start, or check `startFailed` and start again hidden.
- A page running now with a console that has gone needs a restart; an update restarts it.

## 2.86.0

**The keeper's refresh now offers the NPU its own embeddings where its entry makes none, when their server and model are already on the PC: tested in the NPU's turn, taken up only when they answer.**

The owner, 2026-10-18: search indexing and embeddings belong on the NPU. The Snapdragon X2 Elite set up before kit 2.63.0 had its chat on the Hexagon and its embeddings on the Adreno, because the refresh kept an entry's embeddings "on or off as before". With Manor's `gpuWithNpu` off, Reeve's search fell back to npu-embed's nomic-embed-text v1.5 (inputs cut to 128 tokens) and Chamberlain's and Clerk's embeddings used the card. The Hexagon's llama-server b11125 and Qwen3-Embedding-0.6B were already on the PC.

### What changed

- **npu-refresh.ts:** `refreshNpu` offers the route's embedding server to an NPU entry without one. All of these must hold:
  - the route has an embedding server (Qualcomm's, Intel's; AMD's has none);
  - `npuMemoryFit` finds room for it beside the chat, as setup decides;
  - its server and model are already on the PC (`planNpu`'s `downloadBytes` is 0 with them). Otherwise the look goes on without them, as before, and setup brings them.
  In the same turn, after the chat's test, it copies the route's server's files over the embedding server's (Qualcomm's `overlay`, through the new optional dep `overlay`, setup's `overlayFiles` by default), then asks a test embedding. Taken up, the entry is written with them, and the log names `embeddings: on the NPU's own server (<server> <version>, <model>)`.
- **Refused** (the copy or the test failed): the chat's new command, if any, is written without them, their server is stopped (not the chat's), the outcome is `current` or `refreshed` with the problems, and the record keeps `embedOffer` (`{ server, tries, at, problems }`, setup.ts' `NpuEmbedOffer`), carried in every later record until they're taken up. A later kit offers them again, `NPU_REFRESH_TRIES` (3) kits in all, then not until the route's embedding server (its name and version) changes.
- **setup.ts:** `NpuRefreshRecord.embedOffer` and the `NpuEmbedOffer` type.
- spec/ACCELERATORS.md (the keeper) and spec/NPU-VENDORS.md (A later kit's command) say so.

### What an agent must do

- Nothing: the keeper (the Smith, else Reeve) does it on the PC once it runs this kit. Reeve's indexes are named by their embedding model, so on a PC whose Reeve searched with npu-embed, it settles in once with Qwen3-Embedding. Chamberlain's and Clerk's indexes carry over: the Hexagon's vectors match the card's (cosine 0.999 and more).

## 2.85.0

**The NPU can now run at full speed when an agent has work for it: model work left after a round's calls runs back to back on the NPU while the PC is plugged in, cool and quiet, and has the NPU to itself. The work status says how busy each accelerator was today.**

The owner, 2026-10-18: the NPU is where we want as much work as possible, while the gentle pace keeps the processor, the graphics cards, the disk and the network quiet. Measured on the Snapdragon X2 Elite (GenieX, Qwen3-VL-2B), the whole manor used the NPU for 2 to 7 minutes a day in the week before (29 to 116 requests): a round's 3 to 10 calls, then nothing until the next round. The same NPU did 60 note-sized requests back to back in 53 s, 0.89 s each and 98.5% busy, through `npuBacklog`.

### What's new

- **npu-pace.ts** (node): the NPU at full speed (spec/ACCELERATORS.md, "The NPU at full speed").
  - `npuBacklog(name, next, { work?, budgetMs?, signal? })` works through an agent's backlog: `next()` does one item (one request, and keeping its answer) and says whether there was one. Each item is a turn of its own in the NPU's line, so a person's requests and the other agents' come in between. The rule is looked at again before each item. It stops when nothing is left, when the rule says gentle, after 15 minutes at a time (`stretchMs`), at an NpuBusy or another failure, or when the agent stops, and answers `{ done, ms, stopped, why }`. It never throws. Only one runs per name at a time in an agent, and it shows as a `model-backlog` task in the work status. `startNpuBacklog` runs it outside the round, so the round gives back its place in the work line while the NPU works through the rest, and `backlogLine` says the end in the log.
  - `npuPace({ work })` gives `{ full, why, room }`, and `whyGentle()` is the rule. Full speed needs all of these:
    - Manor's settings.json `"npuPace"` isn't `"gentle"` (full when absent; `MANOR_NPU_PACE` overrides it; gentle under node --test).
    - An NPU takes the work first (`npuTakesFirst`): work that goes to a graphics card or the processor keeps the rounds' pace.
    - Mains power, with Windows' energy saver off.
    - No thermal zone holds the processor back.
    - No other program used an NPU over a second's look (raw `GPU Engine` counters on a device with no 3D engine), apart from the manor's own servers (`MANOR_NPU_PROGRAMS`).
    - At most 85% of the memory is in use, and the processor is under 60% busy.
  - `npuRoom()` looks at the power, the heat and the NPU's users with one PowerShell script (`ROOM_SCRIPT`, about 1.8 s, read by `roomOf`). It shares the look in `npu-room.json` for a minute (`roomFreshMs`), with the folder `npu-room.look` as its lock. `lastNpuRoom()` reads that file without looking.
- **token-tally.ts:** `busyToday()` adds every agent's requests together for each accelerator on the PC's day: `busyMs` (the NPU serves one request at a time, so this is the time it was busy), `requests`, `promptTokens`, `answerTokens` and `agents`. It also exports `tallyDay()` and the `TallyRequest` and `AcceleratorDay` types.
- **work-status.ts:** each accelerator's line has `today`, and `pc.npu` gives the NPU's pace as the last look found it. spec/WORK-STATUS.md has both.
- **rules.json** has a new `npuPace` section (`roomFreshMs`, `lookWaitMs`, `stretchMs`, `otherUsePercent`), which the core checks (core/rules.js, rules.d.ts).

### What changed

- **The tally:**
  - Each row now names its accelerator (`acc`).
  - Embeddings are counted too (`work: 'embed'`, its tokens by the kit's estimate), and `readTally` leaves them out of the benchmark's mix.
  - A day is the PC's own date, not UTC's.
  - A row from before this version counts as its kind's accelerator.
- **spec/ROUND.md** says the NPU is the pace's exception. spec/ACCELERATORS.md has the rule, the look, the backlog, the measurements and the new shared file.

### Before you update

- Nothing: it updates itself as usual. Nothing changes until an agent calls `startNpuBacklog` for work it has more of than its round's calls. Each agent takes that up in its own change.

## 2.84.0

**An agent can now tell when a vendor's screen saver keeps putting the PC to sleep, and say which setting stops it. spec/ROUND.md no longer takes Windows' SleepButton / SC_MONITORPOWER for a sleep the person chose.**

On 2026-10-18 the owner's ASUS Zenbook A16 (Snapdragon X2) was found sleeping about 30 s after ASUS's OLED Care screen saver (MyASUS's Pixel Refresh) came on, ever since Windows' cumulative update KB5127646 (2026-10-14): all 15 Kernel-Power 506 SC_MONITORPOWER entries came 22 to 30 s after a start in the screen saver's log, and one start closed after 26 s brought none. The overnight sleep the spec cited as "a sleep the person chooses" was one of them.

### What's new

- **sleep-cause.ts** (node): `saverSleeps()` reads the screen saver's logs for the last 7 days (`%ProgramData%\ASUS\ARMOURY CRATE Diagnosis\ROGScreenSaver`) and, only when it started in that week, Windows' Kernel-Power 506 entries (one `wevtutil` query, about 60 ms). It pairs each SC_MONITORPOWER entry (`Reason` 3) with a start 15 to 45 s before it that hadn't closed. It answers `{ saver, sleeps, line }`, or null when there were none, when the vendor's folder isn't there (nothing more is read), off Windows, and under node --test unless the test gives `programData` and `standbys`. It never throws, and changes no setting.
  - `saverSleepLine(saver, sleeps, now)` is what the person is told, once there were 2 in the week and 1 in the last 3 days: "This PC went to sleep 15 times since Wednesday at 16:54, the last today at 11:10, each about 30 seconds after ASUS's OLED Care screen saver came on. The staff stop while it sleeps: to keep them working while you're away, turn off Pixel Refresh in MyASUS → OLED Care." Ask it at the time you show it, since its days ("today", "yesterday") are the clock's.
  - The parts are exported for tests and other vendors: `saverEvents`, `standbysOf`, `pairSleeps`, `whenWords`, `ASUS_OLED_CARE` (a `Saver`), `SC_MONITORPOWER`, `AFTER_START_MS`, `LOOK_DAYS`, `SAY_AFTER`, `SAY_WITHIN_DAYS`.

### What changed

- **spec/ROUND.md:** 506's SC_MONITORPOWER (566's SleepButton) is a program turning the screen off, not the person's choice. It ends the same way on Modern Standby, whatever an app holds. The lid logs its own reason (Lid, 15). A new bullet, "A vendor's screen saver can put the PC to sleep", gives the measurements. awake.ts and wake.ts say the same in their notes (awake.cs is unchanged, so the helper isn't rebuilt).

### Before you update

- Nothing: it updates itself as usual. Showing the line is up to each agent; nothing calls `saverSleeps()` by itself.

## 2.83.2

**A file an agent only reads is now parsed once while it is unchanged, not on every read. The Steward reads Manor's staff list (64 KB) and its own settings every two seconds, and now parses them only when they change.**

On 2026-10-18 the Steward's efficiency audit found that each read of its settings parsed Manor's app\staff.json twice and agents.json once, and its own settings.json up to three times. With 40 repositories, a read took about 0.5 ms, and the Steward reads its settings several times a second while it works.

### What changed

- **file-cache.ts:** `readJsonShared(file, fallback, broken?)` keeps a file's parsed JSON with its text, so a file unchanged since the last read costs one stat and no parse. Every caller gets the same value, frozen all the way down, so no caller can change what the next one gets: a change throws. `broken`, when given, is what a file that is there but isn't JSON gives, apart from a missing one. `readJson` still parses afresh, for callers that change what they get.
- **manor.ts:**
  - `agentUrl`, `manorOwn` and `manorProjects` read Manor's files through it.
  - `manorProjects` reads the manor's own (four more files) only when Manor lists projects.
  - `originRepo` reads a clone's `.git` files through the file cache: a stat each while they are unchanged.

### Before you update

- Nothing: it updates itself as usual. If your agent calls `readJsonShared`, don't change what it returns: it is frozen.

## 2.83.1

**When the NPU's server installer fails, setup now says why, in the installer's own words, instead of only "GenieX's installer ended with 1".**

On 2026-10-18 the Smith's try of GenieX 0.9.1 on a Snapdragon X2 Elite failed with just that line. An Inno Setup installer prints nothing, so finding the reason took a hand-run of the installer with logging on.

### What changed

- **setup.ts:** `setUpNpu` runs an Inno Setup server installer (GenieX's) with `/LOG=` the tools home's `npu-installer.log`. When it fails, its problem line carries `installerSaid(log)`: the message box it would have shown (its text alone), then its last telling line. For example: "GenieX's installer ended with 1: Uninstall failed (ErrCode: 2). / InitializeSetup returned False; aborting. (its log: …\npu-installer.log)". The log is kept until an install works, and it lives in the tools home, so it outlives a Smith try's own folder.
- **spec/NPU-VENDORS.md:** the server step says so.

### Before you update

- Nothing: it updates itself as usual.

## 2.83.0

**Graphics that share the PC's memory, and the processor, now chat and see with one Qwen3-VL-2B server in place of Qwen3-4B and Qwen3-VL-4B: about twice as fast, about 2 GB less memory than Qwen3-VL-4B alone, and the same scores. Cards with memory of their own keep the 4B models. On the Adreno, setup takes llama.cpp b11715 or later.**

Measured on 2026-10-17 on an Intel Core Ultra 5 225U (its graphics and its processor), an AMD Radeon 860M and a Qualcomm Adreno X2-90, with the same harness. The 2B passed all 13 of the Smith's checks on each, and 15 to 16 of 18 tasks scored by code, as the 4B models did. It wrote 1.8 to 2.2 times as fast and read 2.4 to 2.6 times as fast. Its server held 3.1 to 3.4 GB, against 4.7 to 5.8 GB for Qwen3-VL-4B (spec/ACCELERATORS.md has the table).

### What changed

- **setup.ts:**
  - `SMALL_SPEC` is Qwen3-VL-2B-Instruct (Q4_K_M, with its Q8_0 projector). `runsSmall` is true for the processor and for graphics with under `OWN_MEMORY_GB` of their own. `specFor(kind, accelerator)` picks the model for each kind.
  - Such an accelerator asked for chat and vision gets one server for both on chat's port (`chatOnVision`), whatever the PC's memory, and Qwen3-4B and Qwen3-VL-4B aren't downloaded for it.
    - Asked for chat alone, it runs the 2B without its projector, which isn't downloaded.
  - The processor now serves vision too, when no NPU does. Its pictures are capped and timed as on Intel's integrated graphics (`picturesOnProcessor`).
  - `OLDEST_BUILD`: `pickRelease` skips Adreno builds before b11715. Earlier builds garble the 2B with flash attention on: b11511 passed 5 of the 13 checks, b11715 all 13.
  - `findModels` takes a kind or a `ModelSpec`. `ModelFile` names its model (`model`) in place of its kind.
  - Kept for a PC not set up again: `chatsOnVision` and `withChatOnVision`, the keeper's move of an Intel PC under 32 GB onto its Qwen3-VL-4B server.
- **spec/ACCELERATORS.md:** "Chat and vision on one small model" replaces "Chat on the vision server", with the measurements.

### Before you update

- Nothing in an agent's code. A PC set up before keeps its models until its local AI is set up again (Manor's Set up local AI). That run downloads the 2B (1.55 GB with its projector) and, on the Adreno, a build from b11715 on. The keeper's look never downloads, so it doesn't make this change by itself.
- Code that read `ModelFile.kind` from `findModels` or `planSetup`'s `models` reads `model`.

## 2.82.4

**Each agent's PowerShell worker stays 4 minutes with nothing to run, not 2, so agents start PowerShell less often.**

On a Snapdragon X2 Elite running the manor as usual (about 20 staff), the workers were the PC's biggest source of process starts and exits: 21 started in 32 minutes, about 40 an hour. Typically 2 were alive at once (198 MB committed in all), 6 at most (815 MB). Each is 80 to 215 MB committed and about 13 MB in memory. On that PC each process's exit leaves kernel records behind until a restart, so fewer starts are worth more than the memory an idle worker holds 2 minutes longer.

### What changed

- **ps.ts:** `IDLE_MS` is 4 minutes (was 2). The worker still goes after `MAX_SCRIPTS` (500) and when a script times out, and an idle worker still never keeps a command from exiting.

### Before you update

- Nothing: it updates itself as usual.

## 2.82.3

**The NPU's refresh and patch looks wait for the NPU to be quiet, not the whole manor. They counted every agent's work turn as use of the NPU, so on a PC with a dozen staff they hardly ever ran: kit 2.82.1's GenieX build, which frees the vision encoder after a minute, waited on this X2 for over an hour.**

The looks wait until nobody has used the NPU for 2 minutes (`NPU_REFRESH_QUIET_MS`). That wait read `lastActivityMs`, which counts the time of the folder every lock shares. The agents' work turns (pace.ts' `work` and `first-rounds` locks) are taken and let go in that folder too. On the X2 Elite, over ten minutes, the Smith, the Pinder, the Wright, the Shepherd, the Lamplighter and the Porter took one every one to three minutes, so the NPU was almost never quiet for 2 minutes by that count. Asked every 15 seconds for 45 minutes, the look found it busy every time.

### What changed

- **keeper.ts:** `lastUseMs(lockDirs)` is when an accelerator was last in use, reckoned the way the Reaper reckons its idle time (`letGoMs`):
  - it counts now while the accelerator is held or waited on;
  - it counts when its lock was last taken (`ownActivityMs`);
  - it counts the folder every lock shares only when the accelerator was in use since the process's last look, which dates its let-go.
- **The NPU refresh's and patch's quiet wait** (`startNpuRefresh`'s `idle`) uses `lastUseMs` for the NPU and for its embedding turn's device. The 2 minutes are unchanged.
- **`lastActivityMs` is unchanged.** The Smith's quiet look still uses it, since it asks whether anything changed at all.

### Before you update

- Nothing: it updates itself as usual. On a PC where kit 2.82.1's GenieX build is still waiting, the keeper's next look with this kit puts it in.

## 2.82.2

**A slow start is noticed. Some PCs come up from a restart with the NPU decoding well below its usual speed until the next restart, and nothing but the speed shows it. The kit now keeps the decode speed each chat answer was written at, by boot, so Manor can say when this boot is slow and that a restart usually fixes it.**

On WEASELDEV03 (an AMD Ryzen AI 7 350, qwen3.5:2b on FastFlowLM 1.0.7), a boot that went into Modern Standby in its first two minutes decoded 16- to 31-token answers at 15.8 tokens a second against 20.5 to 20.8 after a normal start (17.4 against 22.9 for answers of 100 tokens and more), all day, until a restart. Prompts read as fast as ever.

### What's new

- **boot-speed.ts** (node): `noteSpeed(agent, speed)` keeps one answer's speed in `speed\<agent>.json` in the accelerators folder, never throwing. `readSpeeds()` reads every program's. `bootSpeedOf(acc)` says how this boot's speed on an accelerator compares with earlier boots', or null until there's enough to say. `bootMs()` is when this PC started: the clock less Windows' uptime, which goes on through sleep and standby.
- **npu.ts:** an answer carries `tokensPerSecond` where its server reports its decode speed (FastFlowLM's `usage.decoding_speed_tps`). A chat's is kept with `noteSpeed` under the agent's id, for answers of 16 tokens or more. Vision's isn't.
- **The core:** `SPEED_SIZES` (16, 32 and 64: answers are compared only with answers of their own size), `speedSize`, `speedsOf` (a speeds file read leniently), `addSpeed` (the latest 30 a row, the latest 10 boots) and `bootSpeed`. This boot is slow at 85% of the usual or less, the usual being the fastest earlier boot's median, once there are 8 answers of one size this boot and 8 in an earlier one. `say.slowBoot(now, usual)` words it. Types `Speeds`, `SpeedBoot`, `SpeedRow`, `Speed` and `BootSpeed`.
- **rules.json:** a `speed` section: `keptPerBoot` 30, `keptBoots` 10, `samplesNeeded` 8, `slowPercent` 85, `bootSlackMs` 120000. `checkRules` requires it.
- **spec/ACCELERATORS.md:** "A slow start", and `speed\<program>.json` among the shared files.

### Before you update

- Nothing: agents keep speeds as they answer, through `npu.ts`. Manor shows the notice once it pins this kit. A driver that builds its own rules object (not from rules.json through `checkRules`) needs the `speed` section.

## 2.82.1

**The Snapdragon X2's GenieX plugin frees its vision encoder after 60 s without a picture: 1.1 GB less working set (1.3 GB less private) from a minute after the last picture until the server stops.**

### What changed

- **node/geniex/geniex_plugin.dll:** a new build, signed, 304,208 bytes. A thread frees the vision encoder once no request with media has come for GENIEX_VISION_IDLE_SECONDS (60 by default), and the next picture loads it again, as the first does (about 1 s). The encoder is freed only between requests. GENIEX_PATCH_VISION_IDLE=0 keeps it loaded. `geniex-castellan-memory.patch` and `README.md` say so.
- **spec/npu-vendors.json:** snapdragon-x2's `pluginPatch.patched` pins the new build; its `what` and `basis` say what it does and what was measured.
- On a PC with 2.81.0's build in, the keeper's next look replaces it with this one, in the NPU's turn and after its test, as for a first put-in. It knows 2.81.0's build by the SHA-256 in `npu-patch.json`.
- spec/NPU-VENDORS.md: the measurement. The 0.3 to 0.4 GB still held above a chat's is GenieX's OpenCL backend's own (ggml-opencl.dll).

### Before you update

- Nothing for an agent: only the keeper changes the file.

## 2.81.0

**On the Snapdragon X2, the keeper puts Castellan's build of GenieX 0.8.0's llama.cpp plugin in place of GenieX's own, which holds about 2 GB less with Qwen3-VL-2B loaded: its working set after a chat 1.77 GB instead of 4.0, cold load 2.4 s instead of 5.0. It goes in only over GenieX 0.8.0's own file, in the NPU's turn, and stays only once a picture and a chat answer through it; anything else, and GenieX's own stays or goes back.**

### What's new

- **node/npu-patch.ts:** `patchNpu(deps)`, one look at the NPU server's patched file, after the NPU's refresh in the keeper (`startNpuRefresh`). Its outcome goes to `npu-patch.json` beside config.json (`readNpuPatch`). It looks once for each kit version, and again when the file changes (GenieX installed or updated since), or when config.json's NPU entry appears.
  - The build goes in only if three things hold: the file is GenieX's own (`pluginPatch.stock`), the files it links against are 0.8.0's (`pluginPatch.needs`), and config.json's NPU entry runs GenieX.
  - It waits until nobody uses the NPU, then, holding the NPU's turn, stops GenieX. It keeps GenieX's file as `geniex_plugin.dll.stock`, renames the kit's build in, and asks the entry's test (`testNpuEntry` with `seeRed`).
  - A build that fails its test is taken out and GenieX's own goes back. A test that failed for its server is made again an hour on, three tests in all, as the NPU's refresh does.
  - A file that is neither GenieX 0.8.0's nor a kit's build (a GenieX update) is left alone, and the old `.stock` copy is removed.
- **node/geniex/:** the build, `geniex_plugin.dll` (signed, 301,136 bytes), with GenieX's BSD-3-Clause `LICENSE`, `README.md` (what changed and how it was measured), `geniex-castellan-memory.patch` (the change, against qualcomm/GenieX v0.8.0) and `build-geniex-plugin.bat`.
- **npu-vendors.json:**
  - `pluginPatch` on the snapdragon-x2 generation (`NpuPluginPatch`): the file, GenieX's own and the build's sizes and SHA-256s, and the files the build needs.
  - `pictureTokensEnv` on the Qualcomm route: `npuEntry` sets that variable (GENIEX_IMAGE_MAX_TOKENS) in GenieX's environment to the vision model's `pictureTokens`, so the build scales down a picture that didn't come through `fitPicture`. GenieX's own plugin ignores it.
- **config.json:** `npuPatch: false` puts GenieX's own file back at the keeper's next look and keeps it; `validateKeeperConfig` takes only true or false.
- **npu-refresh.ts:** `envChanges(from, to)`. The refresh's log names a changed environment (`GENIEX_IMAGE_MAX_TOKENS=1024 added`). `servers` and `stillAnswering` are exported.
- **setup.ts:** `testNpuEntry`'s `seeRed`: the vision answer must say the test picture is red.

### What changed

- An X2 set up before gets GENIEX_IMAGE_MAX_TOKENS=1024 in its NPU entry at the keeper's next look, after the refresh's usual test. Then the patch look puts the build in, after its own test.
- A later kit that no longer patches a PC puts GenieX's own file back. It knows the build by the SHA-256 the earlier look recorded. A newer kit's look is never taken back by an older one.

### Before you update

- Nothing for an agent. Only the keeper (the Smith, else Reeve) changes the file. Every agent's kit carries the build (295 KB) in `src\kit\geniex\`.

## 2.80.3

**spec/NPU-VENDORS.md says why the Smith's check picture read "Tally 827" on the Snapdragon X2's Qwen3-VL-2B, and why the kit doesn't change pictures for it.**

### What changed

- **spec/NPU-VENDORS.md** (Large greyscale text on whole squares): the 2B misreads large greyscale-smoothed text on a picture whose sides are both a whole number of 32 px, which llama.cpp passes to the model as it is. Every font, size and text drawn so read wrong; a pixel off whole squares, or drawn in ClearType, it read right 8 times in 8. The Smith draws its picture 513 × 512 from its 0.8.45.
- It says why the kit doesn't make such pictures a pixel wider, as `sides-of-32` does for FastFlowLM: crisp screen text sent as it was read 15 of 18 questions right, and 12 of 18 a pixel wider.
- spec/ACCELERATORS.md points there from the cards' Qwen3-VL-2B measurement.

### Before you update

- Nothing: no code changed.

## 2.80.2

**Pictures fit the Snapdragon X2's Qwen3-VL-2B. It reads a picture at its own size, a token for each 32 × 32 px, so a 3840 × 2160 screen came to about 8,160 tokens and GenieX refused it, while the kit counted every picture as 400. Now a picture over 1,024 of its tokens is redrawn to fit before it's sent, and counted as 1,024 against the NPU's cap. And its window is 2,560 tokens instead of 4,096, 168 MB less memory.**

### What's new

- **The core:** `pictureTokensFor(rules, a)`, the tokens a picture counts on an accelerator: its vision's `pictureTokens`, else the rules' `imageTokens` (400). `visionTokens(rules, question, a)` takes the accelerator as its third argument; without it a picture counts 400, as before.
- **accelerators.ts:**
  - `pictureTokensOf(size)`: the tokens such a server reads a picture as. `PICTURE_TOKEN_PX` is 32.
  - `pictureFit(size, tokens)`: the size to redraw it at, within that many tokens, each side a multiple of 32, never larger; null when it fits already.
  - `pictureSizeFor(acc, size)`: the size `fitPicture` redraws at on that server, with `sides-of-32` applied after.
- **config.json:** `vision.pictureTokens`, a whole number from 64 to 4,096, on a vision endpoint only (`validateAccelerators` says so otherwise). `NpuModel.pictureTokens` in npu-vendors.json, written by `npuEntry`.

### What changed

- **`fitPicture`** redraws a picture over its server's `vision.pictureTokens` to fit, and takes the accelerator's `vision` beside its `quirks`. A picture within it goes as it is.
- **A picture's request** (npu.ts's `vision`) counts its picture with each serving accelerator's own count, and the largest of them goes against the cap.
- **The X2's Qwen3-VL-2B** has `--nctx 2560` in its own `serve` and `pictureTokens: 1024`. Measured on the X2 Elite: on five screens from 1920 × 1080 to 3840 × 2160 and a phone's, 35 of 35 questions about their text right at 1,024 tokens, against 18 of 35 had they been fitted to 400 (the small text misread); 3840 × 2160, refused before, answered right. A question takes 4.4 to 4.7 s, against about 1.5 s at 400; fitting a picture 65 to 112 ms. spec/NPU-VENDORS.md has the measurements.
- **The keeper's NPU refresh** brings both to an X2 set up before, after the same test as any new command. Its log says `--nctx 2560 added, pictures: at most 1024 tokens`.
- **The Smith's check picture** still reads "Tally 827" on the 2B, as before this kit: at 512 × 512 it is 256 tokens and isn't fitted (spec/NPU-VENDORS.md).

### Before you update

- Nothing for an agent that sends pictures through the kit's `vision`. One that counts a picture with `visionTokens` itself should pass the accelerator.
- An agent still on an older kit ignores `pictureTokens`: on an X2 it sends pictures at their own size, and a 4K screen is refused until it takes this kit.

## 2.80.1

**FastFlowLM's working set is handed back to Windows once its model has loaded: qwen3.5:2b's went from 3,814 MB to 171 MB, and Gemma 4 E2B's from 6,595 MB to 173 MB. Both decode as fast as before.**

### What's new

- **working-set.ts:**
  - `trimWorkingSet(pid)` empties a process's working set (EmptyWorkingSet) through the asker's PowerShell worker. `working-set.cs` is compiled once to `working-set-<hash>.dll`, beside the accelerators' locks, and every agent on the PC shares it.
  - It answers `trimmed <MB it held>`, or why it couldn't, and never throws.
  - `KIT_SERVER_TRIM=0` leaves every server's working set as it is.

### What changed

- **accelerators.ts:**
  - A server the kit starts with FastFlowLM's command (`trimmedOnceLoaded`) has its working set trimmed once it first answers. The trim runs in the background, so the request that started the server goes on at once.
  - The server's log says what it held, or stderr where there's no log. Other servers are left as they are.
- **Why FastFlowLM:** 1.0.7 copies its model's lookup tables into ordinary private memory and reads one row of them a token, so most of what it holds is never read again.
- **Where the trimmed pages go:** Windows keeps them compressed in RAM, or writes them to the pagefile when it needs the room. What the NPU holds is untouched.
- **What it doesn't change:** RAM is freed, not commit, because the server's private memory stays the same. The upstream fix reads the tables from a mapping of the model's file, which frees both (FastFlowLM#807).
- **Measured on a Ryzen AI 7 350 (16 GB):**
  - Decoding was the same before and after: 22.8 to 22.9 tokens a second for qwen3.5:2b, and 20.7 to 21.1 for gemma4-it:e2b.
  - The first request after a trim took 6,360 ms against 6,350 before it for qwen3.5:2b, and 7,709 ms against 7,260 for gemma4-it:e2b.
  - A 1,500-token prompt of new words read 25 MB back from disk, in 8,866 ms against 8,948.
- **What an agent must do:** nothing.

## 2.80.0

**seneschal.ts asks for the Wright's and Reeve's turns (Seneschal 0.3.0): two turn kinds named by their job rather than a commit, what a task needs of the room, and `defer` for an asker that can come back at its next round instead of running beside a full PC.**

### What's new

- **The turn kinds, `wright-job` and `reeve-job`** (`SeneschalTurnKind`). Only their asker can run them, so the Seneschal hands out a turn and nothing else.
  - **`SeneschalTask` names its `job`** (the key): the Wright's issue `#212`, or `pr#41` for a conflict run; Reeve's `repo-sync`, or `index:<name>:<8 hex>:<model>` for an index fill. A turn kind needs no `commit`: it names no code, so a new commit on main isn't new work.
  - `SeneschalCheckKind` is the other three (`pr-check`, `kit-trial`, `full-suite`), which still name their commit. `SeneschalTask` is a union of the two, so a check without a commit, or a turn kind without a job, doesn't typecheck.
- **`SeneschalTask.needs`** (`SeneschalNeeds`): `clone`, `accelerator`, `memoryMb`, and two for the turn kinds only:
  - `light: true` takes no processor slot (an index fill spends the NPU, not the processors);
  - `line: 'claude-code'` holds Claude Code's line, which has a cap of its own.
- **`SeneschalTask.tries`**: how many runs a task gets before it fails for good. A lost lease counts as one, so 1 means it never starts twice (the Wright's job).
- **`SeneschalTurnOptions.defer`**: a turn that doesn't come in `waitMs` answers **`{ later, id }`** instead of null. `later` is why it waits, in the Seneschal's words ("no room: 3 tasks running"), for the agent's status. Run nothing then, and ask again at the next round.
  - **Only while the Seneschal answers.** No Seneschal, one off duty or without Developer Pro, a refused task, one that stopped answering, or a last ask that went unanswered: null, run as before, as without `defer`.
  - **A deferring asker's wait counts all the time it asks,** including the time another run of the same work holds the task (another Reeve process filling that index). So a short `waitMs` (Reeve's 45 s, while it holds its runner lock) is the longest it waits.

### What changed

- **A `wright-job` never answers `{ reused }` or `{ failed }`.** An issue is never skipped for a job that finished: the client says so in its log and answers null (run as before). The Seneschal 0.3.0 never hands one back; this is in case an older one, keyed by commit, would.
- **`jobOf` takes the check kinds by default** (it took `wright-job` too). A worker is never handed a turn kind, which only its asker runs.

### Before you update

- Nothing for an agent to do: the Steward's own calls are unchanged, and an agent that never asks for a turn kind sees no difference.
- **An older Seneschal (0.2.x)** refuses a `reeve-job` (an unknown kind) and a `wright-job` with no commit: `seneschalTurn` answers null, and the work runs as before. Only the turn is lost.
- An agent that switches on the answer and says `defer` should handle `{ later }`.

## 2.79.1

**The title bar's status pill sits beside the agent's name, with the role alone on the line under them.**

### What changed

- **The title bar (page.ts and the React shell, shell.tsx):** the pill moved up from the role's line to the name's: `<div class="name-line"><h1>…</h1><span class="status-pill …">…</span></div><p class="role" title="…">…</p>`. `.role-line` is gone, and the role is a `p` of its own. The pill is still plain text in the brand's link, nothing to press. Its classes (on, off, busy and the busy pulse), its title and `data-tour="status"` are as they were.
  - **The name and the pill** stay whole. The pill (16px) is centred on the name's 19.5px line, so the brand stays 43.7px high and the bar 57px.
  - **The role** has its line to itself, up to its own width. It's cut with an ellipsis at a word when the bar has no room for it: one clamped line (`-webkit-line-clamp: 1`), not `nowrap`, so its least width is a word's. Its whole text is its title.
  - **Wrapping:** the brand is never narrower than its icon, the name and the pill (`min-width: min-content`, now set by the name line). A window too narrow for that wraps the tools to a second row.
  - **In a narrow window** (640px or less): the pill goes under the name when they don't fit side by side, and is cut with an ellipsis when it's longer than the line. The role keeps its one line under them. `--titlebar-h`'s narrow default stays 109px.
- **Checked in a Chromium browser,** at 780px and 375px wide, for the Smith while it works ("At the forge") and the Porter on duty (a long pill and a long role): no sideways scroll, and the bar 57px and 109px.

### Before you update

- An agent whose own CSS styles `.brand .role-line`, or `.brand .role` as a `span`, should look at its title bar. No agent in the manor does. Otherwise there's nothing to do: it updates itself as usual.

## 2.78.26

**The NPU benchmark sets up chat alone, so `--no-setup` downloads nothing. Before, it set up the route's embedding server too, and its check for what was missing counted only the route's models. On an Intel NPU 3720, whose chat model was there and embedder wasn't, `--no-setup` went on and pulled Qwen3-Embedding (428 MB) through OpenVINO Model Server.**

### What changed

- **npu-bench.ts plans the route without its embeddings (`planNpu`'s `noEmbed`, as the NPU check's hardening does).** The suite never asks for an embedding, so the embedding server and its model (Intel's second OpenVINO Model Server and Qwen3-Embedding, the Snapdragon's llama-server and its model) are no longer fetched or set up for a run. FastFlowLM's route is as it was.
  - **`--no-setup`** stops with a `setup` mark, exit 1, whenever the plan would fetch anything: the server, its runtime, its model, or an embedding server and its model, if a plan ever carries one.
  - **The download prompt** names the plan's own total (`downloadBytes`): on a fresh PC about 2.4 GB on Intel (was 2.8), 4.4 GB on a Snapdragon X (was 5.1) and 1.9 GB on an X2 (was 2.6).
- **NPU-BENCHMARK.md** says what `--yes` fetches now, and that `--no-setup` refuses instead.

### Before you update

- Nothing to do: it updates itself as usual. A bench run in a tools home where setup already ran fetches nothing, as before.

## 2.78.25

**On a PC under 20 GB, the keeper stops a graphics card's model servers after 5 minutes unused, not 10, when the card shares the PC's memory (integrated graphics). Their models hold the PC's own memory, as the NPU's do, and they start again from the disk cache in 2 to 5 s.**

### What changed

- **npu-vendors.ts' `cardIdleStopMinutes`:** the NPU's small-PC rule (20 times the cold start, never under `floorMinutes`), for a card with under `OWN_MEMORY_GB` (2) of its own, from llama.cpp's cold start (`idleStop.cardColdStartMs`, 6 s in npu-vendors.json): 5 minutes. On a PC of 20 GB or more, for a card with memory of its own, or one whose `memoryGb` config.json doesn't give, it's `gpuIdleStopMinutes` (rules.json's 10), as before.
- **keeper.ts:**
  - **`serversToReap`** gives a card's servers that time when config.json has no `gpuIdleStopMinutes`, as it gives the NPU's servers their route's minutes when it has no `npuIdleStopMinutes`. A `gpuIdleStopMinutes` in config.json still wins, on any PC: longer, shorter or 0 for never. The processor keeps its 10.
  - **`reapedServers`** takes `idle.otherMsFor`, a card's or the processor's own idle time, over `idle.otherMs`.
- **Measured on a Core Ultra 5 225U with 15.4 GB** (Intel Graphics with 0.1 GB of their own; llama.cpp b11669-vulkan, from the disk cache), from start to the first answer:
  - Qwen3-4B chat: 3.8 to 5.2 s.
  - Qwen3-VL-4B vision with its projector: 3.8 to 5.4 s.
  - The embedding model: 1.6 to 2.9 s.
  - Its keeper had stopped the vision server three times in a day, each after 10 to 11 minutes unused, holding some 5 GB of the 15.4 for 5 minutes longer than this keeps it. spec/NPU-VENDORS.md has the table.
- **spec:** NPU-VENDORS.md, A card that shares the PC's memory rests the same way, and ACCELERATORS.md's idle stop.
- **What an agent must do:** nothing. The keeper takes the new time at its next look with this kit, and a `gpuIdleStopMinutes` the owner set stays theirs.

## 2.78.24

**The local models take less of a PC's memory. llama-server keeps no RAM cache of earlier prompts: by default each server keeps up to 8 GB of them in the PC's memory, beside what its card holds, for prompts that start the same way, and the manor's rarely do. On a Core Ultra 5 225U's Intel Graphics, the chat server held 3.59 GB instead of 4.54 GB after 34 of the manor's kind of requests, and gave the same answers a little faster. And Intel's integrated graphics on a PC with under 32 GB chat on their vision server: one Qwen3-VL-4B for both, 5.0 GB of the PC's memory where Qwen3-4B beside it made 8.5 GB. On text it is as fast and passes the Smith's checks, but it got one of 18 of the manor's kind of tasks wrong that Qwen3-4B got right. A PC set up before gets both at the keeper's next look; nothing to download, nothing to set up again.**

### What's new

- **setup.ts:**
  - `NO_RAM_CACHE`: `{ LLAMA_ARG_CACHE_RAM: '0' }`, the environment that turns the cache off. It goes in the environment, not the command, because a build from before `--cache-ram` ignores the variable but refuses the flag.
  - `withoutRamCache(raw)`: config.json with it in the `env` of each llama-server on the cards and the processor that lacks it, and the accelerators changed. A server that already says how much to cache (`--cache-ram`, `-cram`, or the variable: a person's) is left as it is, and so is a command that isn't llama-server's, an NPU's among them.
  - `chatsOnVision(card, ramGb)`: whether a card's chat runs on its vision server. That is a card that encodes on the processor (`encodesOnProcessor`: Intel's integrated graphics on Vulkan) on a PC with under `CHAT_ON_VISION_RAM_GB` (32).
  - `withChatOnVision(raw, ramGb)`: config.json with each such card's chat moved onto its vision server's port and command, and vision on chat's server with its model and time, and the cards changed. Only setup's own pair is changed: each llama-server, setup's models, one slot, on ports of their own.
  - `refreshCardVision` does both, once for each kit version, as it adds the vision flag; `ramGb` is this PC's memory (`os.totalmem()` when not given). Its log says which accelerators it changed, and a person who undoes either keeps it so until the next kit.
  - `SetupTarget.chatOnVision` and `EntryInput.chatOnVision`: a card set up that way.

### What changed

- **Setup** (`acceleratorEntry`) writes the variable into the `env` of every llama-server it sets up: chat, vision, embeddings and a reranker.
- **Setup on such a card** (`planSetup`) downloads no Qwen3-4B, gives vision no port, and writes chat with vision's model and flags on chat's port. The vision endpoint has only its model and time, so requests and the keeper find it on chat's server (`endpointFor`). Setting up again on a PC set up before gives chat the port its vision server had. Its plan says "chat and vision on 18191 (one qwen3-vl-4b-instruct server)".
- **A PC set up before** keeps its servers running: the vision server takes chat as it is, and the Qwen3-4B server on chat's old port is no configured server's, so the keeper stops it as an orphan after 5 minutes.
- **spec/ACCELERATORS.md** says why, with the measurements, and why not the smaller Qwen3-VL-2B: it read the Smith's check picture, TALLY 4827, as "Tally 827".

### Before you update

- Nothing. An agent that finds a server with `endpointFor` finds vision on chat's, as it always could. One that reads a card's `vision.baseUrl` itself finds none on such a card now.

## 2.78.22

**seneschal.ts knows the Seneschal's other PCs (Seneschal 0.2.0): a task running on another PC isn't timed out, results name the PC they ran on and say flaky or confirmed, a failure's try on another PC can be waited for, `seneschalWork` is the worker's side, and a whole suite can be cut into shards.**

### What's new

- **`SeneschalResult` gains `pc`, `flaky` and `confirmed`.**
  - `pc`: the PC a run was on, when that was another PC on the licence. `by` is then "steward on LAPTOP".
  - `flaky: { on, note? }`: a pass after a failure on another PC.
  - `confirmed: { on }`: a failure after a failure on another PC.
- **`seneschalTurn` can answer `{ failed, id }`**: a failure of exactly these commands confirmed on two PCs while it waited for its turn. That's the change's failure, so don't run it again. A failure the Seneschal held already when it was asked is still asked for again, as before.
- **`turn.elsewhere()`**: after a failure `hold` reported, the Seneschal may try the task once more on another PC. This waits for that run and gives back its result (`flaky` or `confirmed`), or null when it isn't tried elsewhere or the first failure stands.
- **`turn.giveBack(note)`** hands a task back unstarted: it spends no try.
- **`seneschalWork({ worker, kinds, repos, slot? })`** is a worker's ask: any task of those kinds and repositories, this PC's or another PC's (`from`), at its turn. It answers `{ job }` (run it under `job.turn.hold`), `{ idle, retryMs }`, or null with no Seneschal. A task it can't read is given back. `jobOf` checks a task again: an owner/name repository, full commit ids, and a branch git takes as one.
- **Shards of a whole suite.** `SeneschalTask.shard` and `SeneschalJob.shard` (`{ index, of }`, from 1, `SENESCHAL_MOST_SHARDS` at most): one part of a full-suite task, part of its key. `jobOf` refuses a shard that's out of range or on any other kind, and `shardOf` checks one.
- **`seneschalSiblings({ kind, repo })`**: the other PCs whose workers run that kind for that repository now, as this PC's Seneschal last read them. Empty while it shares no work; null with no Seneschal.
- **Kit trials for a worker** (Seneschal 0.2.3): `SeneschalJob.kit` and `SeneschalJob.agent`. `jobOf` takes a `kit-trial` job only with both: the kit as a version (`2.78.22`) or a version and 12 hex digits of the Steward's commit it's made from (`2.78.22-1a2b3c4d5e6f`), and the agent as an agent's id. A job of any other kind that names a kit or an agent is refused.
- `SENESCHAL_RUN_MS` (2 hours) and `SENESCHAL_IDLE_MS` (30 s).

### What changed

- **The 20-minute wait for a turn (`SENESCHAL_WAIT_MS`) doesn't count the time its task runs elsewhere** (`state: 'leased'`: another worker's run, another PC's). That time is limited by `SENESCHAL_RUN_MS` instead.

### Before you update

- Nothing for an agent to do: `seneschalTurn` answers as before where no other PC runs its tasks. An agent that switches on its answer should handle `{ failed }`.

## 2.78.18

**The keeper's NPU refresh starts the server it tests again. In kit 2.78.12 it never did, so every refresh was refused on every vendor's NPU, and each PC kept its old command for the whole kit. It now waits until the old servers' ports are quiet before its test, its test's servers print to a log, and a test that failed for its server is made again an hour later.**

### What changed

- **setup.ts `testNpuEntry` starts its server whoever asks.** Kit 2.78.9 wrote `o.onReady?.(await ensureServer(…))`. With no `onReady`, the optional call skips its arguments, so `ensureServer` was never called.
  - **Who passed none:** the keeper's NPU refresh, which stops the NPU's servers first and so was refused on every PC (`/v1/chat/completions on … refused the connection (ECONNREFUSED)`). Also npu-check's kit-test, harden-timeout, harden-nonsense and calibrate steps, which stop the server first too.
  - **Setup passes one,** so Set up local AI was never affected.
  - **Seen on all three vendors under kit 2.78.12, on 2026-10-17:**
    - **Snapdragon X2 (WEASELDEV01, GenieX), 01:31Z:** refused on 127.0.0.1:18181, so it kept Qwen3-VL-4B instead of Qwen3-VL-2B.
    - **AMD XDNA 2 (WEASELDEV03, FastFlowLM), 01:32Z:** refused on 18184, so it kept qwen3-it:4b and qwen3vl-it:4b instead of qwen3.5:2b.
    - **Intel NPU (WEASELDEV02, OpenVINO Model Server), 02:46Z:** refused on 18183, so it kept a 5.98 GB command instead of 3.72 GB.
    - The managers put the cost at about 1 to 1.2 GB on the X2 and the XDNA 2, and 2.3 GB on Intel's.
    - No new server was started on any of them: no `started.<pid>.json` for 18181, and no new OVMS graph or NPU cache. A refresh replayed by hand passed on the X2 in 20 s and on the XDNA 2 in 22 s. The XDNA 2's started its server through `ensureServer` itself before the test.
  - A PC whose `npu-refresh.json` says `failed` for 2.78.12 looks again with this kit, as with any newer kit.
- **The refresh's test servers print to `<tools>\servers\logs\npu-refresh.log`** (keeper.ts `npuRefreshLog`), each test after a line naming its command. A failed test's line in the keeper's log names that file.
  - `testNpuEntry` and `testNpuEmbed` take a `logFile`, passed to `ensureServer`. Nothing else passes one, so their other callers keep no log, as before.
- **The old servers' ports are waited on before the test** (npu-refresh.ts `stillAnswering`). The keeper's stop gives up after 10 s, and an old server still on its port would answer the test itself, so the new command would be written untested.
  - After the stop, each port the test will ask is asked every `NPU_REFRESH_PORT_STEP_MS` (0.5 s) until nothing takes the connection, for up to `NPU_REFRESH_PORT_WAIT_MS` (30 s).
  - **What it asks:** `whatAnswers`, the port's `/v1/models` with a 2 s limit. Any answer counts, a 404 too.
  - **One still answering after that:** no test, and the problem names the port and what it said (`stillAnswered`).
- **A test that failed for its server is made again** (npu-refresh.ts `serverFailed`). That's a server that refused the connection, exited while starting, or an old server still answering.
  - The record keeps `tries` and `retryAt`, an hour on, and a look from then on tests again, up to `NPU_REFRESH_TRIES` (3) tests for a kit.
  - An answer that makes no sense, vectors that don't, or a config.json that won't be written stay final for the kit, as before.
  - A look that finds the NPU in use writes nothing, so a test that's due stays due.
- **Tests:** npu-refresh.test.ts runs `testNpuEntry` with no `onReady` against a real server program, one that answers and one that exits while starting. The first fails on main's setup.ts with the refusal above. The tests also cover the port wait (a port that goes quiet, and one that doesn't), `whatAnswers` against real sockets, the retries, their record and log lines, and which failures count as the server's.

### Before you update

- Nothing: it updates itself as usual. A PC whose `npu-refresh.json` says `failed` for 2.78.12 tests its NPU's new command again by itself, once nobody is using the NPU.

## 2.78.14

**The title bar's status pill sits on the role's line, after the role, so it no longer pushes the title bar to a second row in a normal desktop window.**

### What changed

- **The title bar (page.ts and the React shell, shell.tsx):** the status pill moved out of `.tools` and into the brand, after the role: `<p class="role-line"><span class="role" title="…">…</span><span class="status-pill …">…</span></p>`. It is plain text in the brand's link, nothing to press. Its classes (on, off, busy and the busy pulse), its title and `data-tour="status"` are as they were.
  - **The role** takes the room the pill leaves, at least 96px, and is cut with an ellipsis. Its whole text is its title.
  - **The pill** stays whole, 16px high (padding `0 8px`, no taller than the role's line), so the bar keeps its 57px. It is `inline-block` now (was `inline-flex`), so a pill that is cut shows its ellipsis.
  - **Wrapping:** the brand is never narrower than its icon, the pill and 96px of role (`min-width: min-content`, from the role line's grid). A window too narrow for that wraps the tools to a second row, rather than squeezing the role away. With the manor's link, About, Settings and Run now, the Steward's bar is one row from about 1,010px wide. Before, it needed about 1,090px.
  - **In a narrow window** (640px or less): the pill goes under the role when they don't fit side by side, and is cut with an ellipsis when it is longer than the line. The role keeps one line (it was two), and the tools sit at the end of their own row. `--titlebar-h`'s narrow default is 109px (was 97px). The script keeps it to the bar's real height, as before.

### Before you update

- An agent whose own CSS styles `.brand .role` or the pill in `.tools` should look at its title bar: the role is a `span` in `.role-line` now, and the pill is beside it. No agent in the manor does. Otherwise nothing to do: it updates itself as usual.

## 2.78.12

**npu-reports.ts counts a report against the model its generation runs (`routeFor`), so an X2's reports on its 2B count, and its reports on the route's 4B are stale. tools/kit.ts warns when a pin is a kit that has no release. Also brings 2.78.10, which wasn't released on its own.**

### What changed

- **tools/kit.ts says when a kit.json pin is for development only.** It fills from a kit tree (`--from`, or the sibling `..\Steward\kit`) at the version kit.json pins, as before, and then warns if that kit has no release. A build releases one kit, the top of the stack of every kit PR ready then, so most versions on the Steward's main are never released: commit main's pin instead, and the build's kit reaches the PR by catch-up. Nothing for an agent to do: the new tools/kit.ts comes with the kit.
  - **The warning** comes after the fill, which goes on as before. Manor#276 pinned kit 2.78.3, Steward main's kit on 2026-10-16, and filled it from the sibling without a word.
  - **No network:** whether the kit has a release is asked of this PC only. It looks first in the cache (`%USERPROFILE%\.steward\kits\<version>`, kept from a download), then for the tag `kit-v<version>` in the Steward clone that holds the tree (as of that clone's last fetch). When neither can say (a tree in no clone, a clone with no kit tags, no git), it says nothing.
  - **Not told:** the Steward filling its own kit or its fixture (`npm run kit`, a tree in the same checkout), and the Steward's trial, which fills through `STEWARD_KIT`.
- **`reportsPatch`:** a report is the route as it runs now when its server, its server's version and its chat model match `routeFor(route, generation)`, the generation's own models where it has them. Before, the model was compared with the route's own, so every report from a generation with its own models was stale.
- **Tests:** npu-reports.test.ts gives the X2 small-PC models in a copy of the catalog, since none ships them now. in-use.test.ts asks its page at above normal priority, starved below normal beside a kit trial, and checks that a request leaves the priority and the job's cap as they are.

## 2.78.10

**On a PC set up before, a card's embedding server is brought down to setup's smaller context: about 0.6 GB less of the graphics' memory, with the same vectors, from its next start.**

## 2.78.9

**Setup keeps a report of how this PC's NPU did, for its owner to send if they choose (spec/NPU-REPORTS.md). It measures every NPU it sets up now, verified or not: three short requests and a 1,000-token read, a few seconds in the NPU's turn. Only an unverified generation is calibrated from them, as before; a verified one is used whatever they say. The report holds hardware ids, versions and times, and never a file, a path, a name or the licence. Nothing in the kit sends it: the app shows it to its owner and sends it only on their word. `npu-reports.ts` turns the Exchequer's count of the reports into the patch for npu-vendors.json that they support.**

### What's new

- **npu-report.ts:** the report, `castellan-npu-report/1` (spec/npu-report.schema.json):
  - **`npuReportFromSetup` and `npuReportFromCheck`:** the report of a setup, or of an NPU check on this PC's NPU. A failure is a step's code (`test-timeout`, `driver`, `cap`…), never setup's words, which can hold a path.
  - **`rememberNpuReport` and `readNpuReport`:** `npu-report.json` beside `npu-note.json`, written whole and read back only when it matches its schema.
  - **`reporterId`:** a random id kept in `npu-reporter.json`, made for these reports alone, so one PC counts once.
  - **`npuReportKey`:** what makes two reports the same, for an app that offers each once.
  - **`checkNpuReport`:** the schema, which the Exchequer checks too.
- **npu-reports.ts:** `node <agent>\src\kit\npu-reports.ts <summary.json>`, or `--fetch` with the publisher's key. It reads the Exchequer's `castellan-npu-summary/1` against this kit's npu-vendors.json and prints, per generation, what the reports say and the merge patch they support. A generation is verified by 3 PCs passing with under 1 in 5 failing. Timeouts come from the slow end, by calibrate's formulas and bounds, and are never lowered. `measured` is for the site. A PCI id nobody has listed gets a line once 2 PCs report it. It changes nothing.
- **json-schema.ts:** the small part of JSON Schema npu-bench.ts used, now shared with npu-report.ts, with `$ref` to a schema's own `$defs`.
- **spec/NPU-REPORTS.md** and **spec/npu-report.schema.json.**
- **NpuGeneration's `measured`:** a generation's speed from its owners' reports, for the website: `{ pcs, server, model, tokensPerSecond, coldStartS, at }`.

### What changed

- **setup.ts:**
  - **`withSmallerEmbedServer(raw)`:** a graphics card's (`kind: 'gpu'`) llama-server embedding command still at the context and micro-batch setup wrote from 2.11.0 (`-c 8192 … -ub 2048`) gets setup's own: `-c` `EMBED_CONTEXT` (4096) and `-ub 512`. Its `embed.maxContextTokens` becomes `EMBED_CAP` (1,365), or stays lower if it already was. A command with any other context or micro-batch, changed by hand, is left as it is.
  - **`refreshCardVision`** now runs it after `withEncoderOnProcessor`, so the keeper's look at the cards' commands, once for each kit version (keeper.ts), changes both. Its log line names the cards whose embedding server changed and what it saves.
  - Measured on an AMD Radeon 860M with Qwen3-Embedding-0.6B: 1,874 MB of the graphics' memory before, 1,274 MB after.
- **What an agent must do:** nothing. The change reaches config.json once the keeper runs this kit, and the server takes it at its next start.

  - **`setupCommand`:** keeps the NPU's report (`npuReportFile`, the accelerators folder's `npu-report.json` by default; none with a given detection unless a file is given). It writes one whenever it set the NPU up or left it out, and none when it left a configured NPU alone. `app` names the app in it ("manor 0.16.200").
  - **`setUpNpu`:** measures every NPU after its test request. Its result has `failed`, the step's code, and `speeds`. `measureNpu` also reads a prompt of about 1,000 tokens (`readTokens`, `readMs`). `fillerPrompt` moved here from npu-check.ts, which exports it still.
  - **Code that fakes `NpuIo.measure`:** it is now called for a verified generation too. A fake that returns null there leaves the NPU on the route's values, as before.
- **npu-check.ts:** a run on this PC's NPU (not a rehearsal) keeps the same report from its own steps (`npuReportFile`, `app`).

### What an agent must do

For NPU reports, nothing: setup and npu-check keep the report by themselves, and nothing is sent. An app that offers it reads `npu-report.json` (`npuReportFile`) and passes its name and version as `app`. A PC under 20 GB that runs its generation's `smallPc` models reports those models. `npu-reports.ts` lists them on their own and doesn't count them toward the route's model.

## 2.78.8

**Qwen3-VL-2B is every Snapdragon X2's NPU model, whatever its memory, and a first-generation X keeps Qwen3-VL-4B. And under the Smith, the keeper's look now runs the PC's refreshes (the NPU's command, the cards' vision, hardware.json), which until now never ran there. The tools home is now the folder config.json's commands are in, so a PC set up in the accelerators' folder no longer looks for its servers in a ~\.reeve that holds only logs.**

### What's new

- **A generation's own models** (npu-vendors.ts, npu-vendors.json): `NpuGeneration.models` are the models a generation runs in the route's place on every PC of it, whatever its memory. `routeFor` puts them there, and a small PC's `smallPc` still goes over them. The Snapdragon X2 has Qwen3-VL-2B (`unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0`, 1.9 GB, its pictures' encoder on the Adreno with `--vit-compute GPUOpenCL`) as its `models`. Kit 2.78.0 gave it as `smallPc`, so only an X2 under 20 GB ran it. No generation has `smallPc` now; the mechanism stays. The route's own `models` stays Qwen3-VL-4B, which the first-generation X (Hexagon v73) runs, as does a Snapdragon setup doesn't know.

### What changed

- **Setup, the NPU check and the NPU's refresh** plan, check and refresh the 2B on an X2 of any memory, through `routeFor`. An X2 set up with the 4B is `needs-setup` until setup has pulled the 2B. Once the 2B is there, the refresh puts it in the 4B's place and adds `--compute npu` and `--vit-compute GPUOpenCL`.
- **`routeFor` keeps a caller's own models.** The X2's 2B, and a small PC's models, go only in place of the route's own, as npu-vendors.json has them. A route handed in with other models, such as the Smith's try of a newer model, keeps them, so the try pulls and tests the model it names.
- **npu-bench** measures what setup runs on the PC. `--model` takes the generation's models or the route's own, so `--model qualcomm/Qwen3-VL-4B-Instruct:W4A16` measures the 4B on an X2. A `--candidate` is pulled and served as the route's own model is (AI Hub's build on a Snapdragon), whatever the generation runs.
- **`keeperLook`** (keeper.ts) brings hardware.json, the cards' vision commands and the NPU's command up to date whenever its reaper is the PC's own (`pcReaper`'s; `asksPc` says so), whether or not it's handed config.json. Until now a handed config.json meant a test. The Smith always hands the one it read for its round, and Reeve leaves its looks to the Smith, so on every PC with the Smith none of the three ever ran: no npu-refresh.json or card-refresh.json was written, and hardware.json changed only when setup ran. A test's reaper asks no PC.
- **`toolsHome()`** (accelerator-config.ts) is the folder most of config.json's `startCommand`s are in, ~\.reeve or ~\.manor\accelerators, once %NAME% is expanded (`commandsHome`). A command in neither (GenieX's, FastFlowLM's flm, a program on the PATH) doesn't count. With none, or as many in each, ~\.reeve counts only when it holds a server build or a model, not just logs\ and downloads\. Before, any ~\.reeve\servers made ~\.reeve the tools home. So on a PC set up in the accelerators' folder, where something later made a ~\.reeve\servers with only logs in it (an Intel PC and an AMD PC were seen), the NPU's refresh and setup looked for the servers and models in the wrong folder: the refresh missed the embedding server and recorded `needs-setup`. On those PCs they now find the real servers and models. A PC whose commands are in ~\.reeve keeps it: the X2 Elite, whose config.json is in the accelerators' folder and whose card's embedding server runs from ~\.reeve\servers, still gets ~\.reeve.
- **`redrawPicture`** (accelerators.ts) takes an optional `timeoutMs`. The picture-redraw test gives PowerShell three minutes on a busy PC, where 30 s timed out under a kit trial's load; agents still use 30 s.
- **Measured** on the 47.6 GB X2 Elite (2026-10-16) with this kit, beside the card's own embedding llama-server on the Adreno under a steady load. The NPU check passed every step: 74.7 tokens a second, 1,812 tokens read in 0.7 s, both cap sizes answered, 3.95 GB held. A quick npu-bench gave 22 of 24 quality items, pictures 4 of 4, 75.4 tokens a second and jobs in 3.3 s, with 4.30 GB working set. The card's server answered all 52 of its requests with the same vectors throughout, at a median of 432 ms, its working set 3.54 GB before and 3.73 GB after.

### Before you update

- Nothing for an agent to change: it takes this kit as usual.
- A Snapdragon X2 that is set up and already has Qwen3-VL-2B switches to it at the keeper's next look, once nobody has used the NPU for two minutes.
- Any other Snapdragon X2 switches when Set up local AI is pressed, which pulls 1.9 GB.
- Qwen3-VL-4B (4.4 GB) stays on the PC until it's removed: `geniex remove qualcomm/Qwen3-VL-4B-Instruct`.
- Under the Smith, the first look with this kit may also change the cards' vision commands in config.json, as earlier kits' looks meant to (`refreshCardVision`: each flag only where it's missing). Each change goes in the keeper's log.

## 2.78.7

**Everything the manor runs now stays within 85% of the PC together. The agents, their check runs and the model servers each had a cap of 85%, so all three busy at once could take the whole processor; now they share one. And the NPU check's and the NPU benchmark's server starts apart, as an agent's does, so they measure the server an agent gets. And if kit 2.78.0 to 2.78.3 weren't released on their own, this release brings them too: their entries follow.**

### What's new

- **The manor's ceiling, one job above every family's** (`Local\kit-manor-ceiling`). It is hard-capped at `CEILING_CAP` (85%), and the agents' own jobs, the check runs' job and the servers' job nest inside it, so their 85% caps no longer add up.
  - **pace.ts:** `ceilingCap()` gives its cap, and `CEILING_ENV` (`KIT_CEILING`) is the variable the launchers read it from. Under node --test there is none unless `KIT_CEILING_CAP` sets one, and then only in `KIT_CEILING_JOB_NAME`'s ceiling, never the PC's.
  - **checks-pace.cs:** a check run or a server started apart joins the ceiling before its family's job (`Local\kit-checks-pace`, `Local\kit-apart-pace`), which then nests inside it. `pacedCommand()` and `startApart()` pass the cap.
  - **named.cs:** with a ceiling, the agent's launcher starts the page out of the jobs that let it leave (Task Scheduler's, which Manor runs in), puts it in the ceiling, then in `Local\Castellan-<id>`. Where Windows refuses, the page starts in the launcher's jobs, as before. `open()` passes the cap, and 0 for Manor's own page.
  - **gentle.cs, gentle.ts:** an agent in no job (one run from a terminal) joins the ceiling before its own job is made. `KitGentle.Set` takes the ceiling's cap as a fourth argument, and `gentleScript()` as a sixth. `keepResponsive()` keeps Manor's page out.
  - **The ceiling is only ever made for a program in no job**, so it is never inside another program's job tree (a Claude session's, a terminal's, Task Scheduler's), whose end could end what joined it later. A program that couldn't leave such a job can't join it, and keeps its family's cap alone, as before.
  - It ends nothing and limits nothing else. Each program in it holds a handle to it, so it lasts while any runs.
  - **Measured on an 18-thread Snapdragon X2 Elite**, with a check run, a server started apart and an agent's page at full each keeping every processor busy at once, all read over the same 8 s:

    | | The three together, by their jobs' own accounting | The whole PC, by Windows' % Processor Utility |
    |---|---|---|
    | Each family at its own 85%, no ceiling | 98.3% | 100% |
    | In the manor's ceiling | 86.6% | 88.8% (the PC's other work took about 7% just before and after) |

    Windows' accounting read the ceiling a point or two above its 85% hard cap in each of five runs (86.5% to 87.7%). The check run, at its low priority, got almost nothing while the other two were busy, in both rounds.
  - **Under test**, with a ceiling of 10%: a check run and a server started apart, each keeping every processor busy at its family's cap of 10%, took under 14% together. With no ceiling the same two took 23.8%, a cap each.
- **checks-pace.cs:** `KIT_CHECKS_JOB_NAME` names the check runs' job, so a test's runs share a job of their own. Before, a test's launcher set the PC's real job's limits to the test's.

### What changed

- **npu-server.ts: `startServer`** starts the route's server through `startApart()` (apart.ts), as the keeper does.
  - It leaves the job of whatever ran the tool (a check run's, a terminal's) and joins `Local\kit-apart-pace`, hard-capped at `CEILING_CAP` (85%).
  - Where it can't start apart (not Windows, no launcher, node --test without `KIT_APART=1`), it starts a plain detached child, as before.
  - Its `pid` is the server's own, as before, so `stop()` still ends its whole tree, and `processMemory()` reads the server.
  - Its output still goes to the tool's log.
  - The timing of the cold start begins after `startServer` returns, so a first start that builds the launcher isn't counted.
- **Found by the AMD Dev Manager.** On an AMD PC, kit 2.78.3's `startApart` with FastFlowLM 1.0.7 (qwen3.5:2b) showed no measurable cost from the cap: writing at 22.71 tokens/s capped against 22.72 uncapped. But npu-check and npu-bench weren't starting their server that way.
- **Checked on an 18-thread Snapdragon X2 Elite.**
  - Outside node --test, `startServer`'s server was in `Local\kit-apart-pace`, whose rate control read flags 5 (enabled, hard cap) and cap 8500.
  - Under test, at a cap of 10% (`KIT_APART_CAP=1000`), a server keeping every processor busy took no more than that. Started the old way, the same server took 62.5%.

### Before you update

- With the agents, their checks and the servers all busy, together they now get 85% of the processor where they could take all of it, so a heavy hour may run a little longer.
- The checks launcher, the agents' launchers and the pace helper changed, so each PC builds them once more. An agent joins the ceiling at its next start through its launcher.
- A page that leaves Task Scheduler's job is no longer ended when Manor's task is ended in Task Scheduler. It already outlived Manor's own process.
- It updates itself as usual. An NPU benchmark run after it is measured at the manor's ceiling. A route whose server leans on the processor (a llama.cpp one, the processor's own) may score a little lower than before. One that runs on the NPU, like FastFlowLM's, scores the same.

## 2.78.3

**A full pace never takes the whole PC any more. Everything the manor runs, together, stays within 85% of the processor (the kit's `PACE_CEILING`), and no scheduled round starts while more than 85% of the PC's memory is in use. Before, full meant no cap at all. The model servers every agent shares, which ran with no cap at any pace, are held to the same 85%. It also brings what wasn't released before: Pictures on the AMD route read right. FastFlowLM 1.0.7 misread a picture 720 px tall or less when a side was a whole number of 32 px, including Smith's audit's 512×512 vision check and a 1280×720 picture. The kit now makes such a side a pixel longer before sending the picture.**

### What's new

- **A quirk, `sides-of-32`** (accelerator-config.ts' and the core's `QUIRKS`), on the AMD route (spec/npu-vendors.json). A PC set up before it gets it from the keeper's refresh of the NPU's entry, after the refresh's usual test.
- **accelerators.ts:**
  - `fitPicture(acc, image)`: the picture as `acc`'s server should get it.
  - `sidesOff32(size)`: the size it should have, or null.
  - `pictureSize(bytes)`: a PNG's, JPEG's, GIF's or BMP's size, from its header.
  - `redrawPicture(from, to, size)`: System.Drawing's high-quality bicubic.
- **npu-refresh.ts:** a refresh that changes an entry's quirks names them in its `changes` and its log line.

### What changed

- **pace.ts:**
  - **`PACE_CEILING`** (0.85), **`CEILING_CAP`** (8500, in the hundredths of a percent a Windows job takes) and **`CEILING_WORDS`** ("85%") hold the manor's ceiling. It is written once, and everything below reads it.
  - **The work line:**
    - Short of memory now means more than `PACE_CEILING` of it in use (`shortOfMemory()`). This is the same measure as before, when it was less than 15% free. `LOAD.lowMemory` is gone.
    - When short of memory, the line gives one slot, and no scheduled round starts until there is room (`roomToStart()`, looking every 10 s). That holds both in its turn and at once with no line (agentsAtOnce 0).
    - While it waits, the round's state says `MEMORY_WAITING`. If there is still no room when its next round is due, it throws `NoRoom` (a `LockTimeout`), and round.json records a round that waited.
    - A round asked for (Run now) and a light round don't wait.
    - Under node --test, it looks at memory only when `load` or `inUse` stands in for it.
  - **`memoryInUse()`:** the share of the PC's memory in use now.
- **gentle.ts, gentle.cs:**
  - At full, the agent keeps normal priority, no efficiency mode and its usual disk priority. It now stays in its job, the worker too, capped at `CEILING_CAP`; before, the cap was lifted. Manor's `keepResponsive()` gets the ceiling too.
  - `paceCap(p)` gives the cap, and `paceSet()` says `full 8500`. A cap of 0 makes no job.
  - Under node --test, full has no cap, as before.
- **checks-pace.ts:**
  - At a full pace (Manor's `backgroundPace`), check runs are held to `CEILING_CAP` in the PC's one job, instead of running with no cap. `checksPaceCap()` never returns more than that.
  - A cap set as `checksPace` or `KIT_CHECKS_PACE` of "full", or of 100 and up, means the ceiling. A lower percentage still sets a lower cap: `KIT_CHECKS_PACE` at either pace, `checksPace` at gentle.
  - At full, up to `CHECKS_AT_ONCE_FULL` runs go at once (`checksAtOnce()`): six, `AGENTS_AT_ONCE.most`. They share the cap rather than each adding to it. At gentle it stays three.
  - A run's memory limits now apply at full too: an eighth of the PC's memory for each program, a quarter for the job.
  - `pacedTestConcurrency()` never gives more test files at once than there are processors.
  - Under node --test, commands are unpaced unless `KIT_CHECKS_PACE` says a percentage under 100, as before.
- **apart.ts, checks-pace.cs (the model servers):**
  - A server started apart (llama.cpp's, FastFlowLM's, the NPU routes') still leaves the asker's job. It now also joins the servers' job, one for the PC (`Local\kit-apart-pace`, `checks-pace.exe apart:<cap>`). That job is hard-capped at `CEILING_CAP` whatever the asker's pace, so all the servers together stay within 85% of the processor. Before, they ran with no cap at all.
  - The job limits nothing else and ends nothing. Each server holds a handle to it, so it lasts while any server runs, and the next server joins the same job.
  - A server that can't join it gets a job of its own with the same cap. If neither works, it runs as before.
  - `apartCap()` gives the cap. Under node --test there is none unless `KIT_APART_CAP` sets one, and a test's servers use `KIT_APART_JOB_NAME`'s job.
  - The launcher's source changed, so each PC builds it once more, at its next check run or server start.
  - Measured on an 18-thread laptop with two programs each keeping every processor busy, started apart together:

    | How they were started | Their share of the processor, together |
    |---|---|
    | `apart`, no cap | 88.4% (other work on the PC took the rest) |
    | `apart:8500` | 83.5% |
    | `apart:1000` | 10.5% |

    At 10% they shared one job's cap: two jobs would have allowed 20%.
- **schedule.ts:** every() takes a `room` option, so tests can stand in for the memory in use.
- **work-status.ts:** the checks' turns come from `checksAtOnce()`.
- **spec/ROUND.md:** the Pace section now describes the manor's ceiling and what full means.
- **`Npu.vision`, setup's vision test, and the NPU check's and benchmark's requests** (npu-server.ts' `serverClient`) fit each picture first. On the AMD route, three of the benchmark's four pictures go a pixel larger. The benchmark's log names the quirk, and its times leave out the redraw.
- **spec/NPU-VENDORS.md:** the measurements, in "FastFlowLM's pictures with sides of 32 px".
- `visionBody` is unchanged and stays synchronous.

### What an agent must do

Nothing, if it asks through `Npu.vision`. An agent that builds its own vision requests with `visionBody` awaits `fitPicture(acc, image)` first.

### Before you update

- At a full pace, an agent and its checks now leave 15% of the processor and memory to the person and Windows, so heavy work at full (a test run, a build) may take a little longer. The same goes for the model servers at any pace. A server already running gets the cap the next time it starts. Nothing to do: it updates itself as usual.

## 2.78.2

**An agent can have Windows wake the PC, plugged in, for work due at set times (`node/wake.ts`), and keep it up, with the screen off, until the work is done (`endWakeTask`).**

A Modern Standby PC that goes to sleep is out of an agent's reach: a sleep the person chooses (Start's Sleep, the power button, the lid) enters standby at once, whatever an app holds, and the desktop apps are suspended there. Only a wake timer brings the PC back, and Windows allows those plugged in (Power Options' "Allow wake timers", on AC). While the task that woke it runs, Task Scheduler keeps the PC out of sleep, with the screen off; an app's own hold didn't keep its process from being throttled there. So the task runs until the work is done. spec/ROUND.md has what was measured.

### What's new

- **wake.ts:**
  - **`WakePlan`**: `{ times, days, beforeMinutes, holdMinutes, why }`, the times (`HH:MM`, local) and days work is due, how many minutes before each to wake, the longest the woken PC is held (the work's longest), and what for, in words.
  - **`wakeTimes(plan)`**: each time `beforeMinutes` early, on the day that makes (a midnight time wakes the day before), grouped by time, the days in the week's order.
  - **`wakeTaskXml(plan, { exe, user })`**: the task's definition. One calendar trigger for each wake time (daily on every day, else weekly on its days). It wakes the PC (`WakeToRun`), only on AC (`DisallowStartIfOnBatteries`, `StopIfGoingOnBatteries`), never late (`StartWhenAvailable` false), hidden, as the person signed in with least privilege, and stops 5 minutes past its hold. It runs the awake helper with `--for <holdMinutes × 60>`.
  - **`keepWakeTask(plan | null, log)`**: keeps the task (`WAKE_TASK_NAME`) in step with the plan. It registers it when the plan changes (`schtasks /Create /XML /F`, the definition written UTF-16 to the data folder's `wake.task.xml`), removes it for a null plan, and asks Task Scheduler nothing while the plan is the one it set. The first look in a process checks the task is still there. A refusal is logged once and tried again an hour later (`WAKE_RETRY_MS`). Answers `set`, `same`, `removed`, `none` (nothing registers here: not Windows, a dev checkout, or under node --test) or `failed`.
  - **`endWakeTask(log)`**: ends the task's run once the work is done (`schtasks /End`), so the PC may sleep again. The task stays registered for the next time, and Task Scheduler answers SUCCESS for one that isn't running. Answers `ended`, `none` (no task kept) or `failed`, logged.
  - **`wakesPc()`**: whether the task is set, for the page.
  - **`setWakeDeps(deps | null)`**: stands in for Task Scheduler in tests.
- **install.ts**: `WAKE_TASK_NAME`, `\<App>\Wake`. Uninstalling ends and deletes it as well, beside the agent's own task.
- **awake.cs**: `--for <seconds>`: holds the PC (`ES_CONTINUOUS | ES_SYSTEM_REQUIRED`) that long, then lets go and exits. It is what the wake task runs: no agent, no input. The agent ends the task sooner, once its work is done (`endWakeTask`).
- **awake.ts**: `awakeHelperExe(log)`, the compiled helper's path (compiled first if needed), for the wake task.

### For an agent

- Nothing to do: take the kit and release as usual. Nothing is woken until an agent calls `keepWakeTask`.
- An agent with work due at set times calls `keepWakeTask(plan)` whenever the times may have changed (a cheap call: it asks Task Scheduler nothing while the plan is the same), and `keepWakeTask(null)` when it has nothing to wake for. Its `holdMinutes` is the longest the work may take. Once the work is done it calls `endWakeTask()`, but not when the agent merely stops (an update): the task then holds the PC until the agent is back. While it works it holds the PC with `stayAwake(what)`, as ever. Never wake a PC on battery, and never keep the screen on.
- An agent that has a wake task removes it at uninstall through the kit's `uninstall`.

## 2.78.1

**The Seneschal is one of the manor's developer roles, comes with Developer Pro, and an agent can ask it for its turn: node/seneschal.ts.**

### What's new

- **node/seneschal.ts:** the Seneschal's work client. `seneschalTurn(task, { worker, commands })` submits a task (a repository and a commit, never a command), asks for it by name every 5 seconds until its turn comes, and answers `{ turn }` (run it inside `turn.hold()`, which sends the lease's heartbeats and reports the result), `{ reused }` (a pass of exactly these commands on the same code: nothing to run), or null: run it as before. Null whenever the Seneschal isn't on the PC, doesn't answer, is off duty, the PC has no Developer Pro, the turn doesn't come in 20 minutes, or the run is already inside a checks pace turn (`KIT_CHECKS_TURN`). A failure it holds is never taken for this run's: the task is asked for again, and run. A run under its lease sets `TURN_HELD_ENV` for its commands, so the checks pace's launcher takes no turn of its own. Under node --test it asks only a Seneschal the test gave a home of its own.

### What changed

- **node/work.ts:** a `WORK` entry for the Seneschal: handing out the staff's work in order, by lane and as the PC has room, and its look at the PC's room every 15 seconds. It is a developer role (`developerRole`), so with Developer options off its Settings page has no "Where its work runs". Its notes say it runs no work of its own and comes with Developer Pro.
- **node/look.ts:** the Seneschal's look: deep blue, "Handing out work" on its pill, and a scene where each line of a ledger is ticked in turn and its task goes out to a free slot beside the steward's staff.
- **node/developer-pro.ts:** Developer Pro covers the Seneschal too. Without it, the Seneschal hands out no work, and each agent runs its own as before.
- **spec/DEVELOPER-OPTIONS.md** lists the Seneschal among the developer roles.

### Before you update

- Nothing: it updates itself as usual. The Seneschal's own page asks `developerPro()` itself.

## 2.78.0

**On a Snapdragon X2 under 20 GB of memory (a 16 GB PC), the NPU runs Qwen3-VL-2B in place of the 4B, its pictures' encoder on the Adreno. It writes 75 tokens a second against 41, reads 4 pictures of 4 against 3, scores the same 22 of 24, and leaves the PC about 2 GB more. A generation can now name the models a small PC runs, and a model its own server arguments. The NPU benchmark judges a job's tries at one answer length, so answers of different lengths no longer keep a run off the board. It also brings what wasn't released before: Intel's NPU labels name the Core Ultra 200H and 200HX. The NPU 3720 at PCI `7D1D` is "Core Ultra Series 1, 200U or 200H, Meteor Lake or Arrow Lake-U or -H (NPU 3720)", and the one at `AD1D` is "Core Ultra 200S or 200HX, Arrow Lake-S or -HX (NPU 3720)". Nothing a PC runs changes: each device is the same generation, with the same values. Each agent shows under its own name in Task Manager. Its page starts through a small launcher named for it, so the Processes tab shows "Smith" with its page, PowerShell and git inside, and the processor and memory they take together, in place of one more "Node.js JavaScript Runtime". They run in a Windows job of the agent's own (`Local\Castellan-<id>`), which ends nothing: what the page starts detached (an install's watcher, a model server) outlives it, as before. The page builds its launcher a minute or two after it starts, so its next start is named: after the update, a sign-in or a restart. The page's console, its log and its pace are as they were.**

### What's new

- **npu-vendors.ts:**
  - **`NpuGeneration.smallPc`** (`{ models, basis }`): the models a generation runs in the route's place on a PC with little memory (`smallPc`: under `idleStop.smallPcGb`, 20).
  - **`routeFor(route, generation, small)`**: with `small`, the generation's `smallPc` models in the route's place; without it, as before. **`planNpu({ small })`** passes it on.
  - **`NpuModel.serve`**: server arguments a model needs beside the route's `serve`. `npuEntry` adds the chat model's after the route's, so they go with that model alone.
- **npu-check.ts and npu-bench.ts: `--small-pc`** runs a small PC's models on any PC. On a PC under 20 GB they run anyway, as setup would run them. `npu-bench --model` one of a small PC's models runs them too, and `--model` one of the route's own measures it on a small PC. The report's model says which ran.

### What changed

- **npu-vendors.json's qualcomm route**, the `snapdragon-x2` generation's `smallPc`: `unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0`, chat and vision.
  - Pulled from Hugging Face (`--model-hub hf --model-type vlm`): AI Hub has no QAIRT build of the 2B, only this GGUF.
  - Served by GenieX's llama.cpp plugin with `--compute npu --vit-compute GPUOpenCL`: the language model on the Hexagon, the pictures' encoder on the Adreno. GenieX 0.8.0's llama.cpp reads every picture as grey on the Hexagon, and on the processor each picture takes about 5.5 s of its time, against 0.8 s on the Adreno.
  - 1,876,179,296 bytes, its Q4_0 GGUF and F16 projector pinned for the X2 (unsloth's repository at 8dcb98e5). Apache-2.0, the base model's.
  - The route's cap (2,400), timeouts and idle stop are unchanged. Its cold start, 5.1 to 9.1 s, is inside the route's 15 s.
  - **Measured** with the full benchmark (`castellan-npu-bench/2`) on the 48 GB X2 Elite, 2026-10-15, against the 4B:

    | | Qwen3-VL-2B (Q4_0, llama.cpp) | Qwen3-VL-4B (W4A16, QAIRT) |
    |---|---|---|
    | Quality items | 22 of 24, every must-pass one right | 22 of 24 |
    | Pictures | 4 of 4 | 3 of 4 |
    | Tokens written a second | 75.0 | 41.1 |
    | Jobs: triage, reply, summary | 0.56, 0.43 and 1.95 s | 0.73, 0.98 and 3.88 s |
    | Cold / cached load | 5.1 / 5.4 s | 10.0 / 9.9 s |
    | Speed held over 10 minutes | 95% (100% run again quiet) | 100% |
    | Working set / private | 4.31 / 2.34 GB | 6.12 / 1.68 GB |
    | On the NPU | 2.1 GB | 4.2 GB |
    | The PC's available memory, lower once loaded | 3.5 to 4.2 GB | 6.1 GB |

    The Adreno holds about 1.5 GB of the PC's shared memory beside it. Not ranked: the processor was busy at its start, and GenieX's reply and summary jobs varied by more than 15%, as in the 4B's own full run. Run again on a quiet PC with the kit's own command (`npu-bench --small-pc`, later on 2026-10-15), it gave the same quality and pictures, 74.6 tokens a second, 3.01 s of jobs and a 4.3 s cold load, and its speed held 100%. Only the reply job's spread kept it off the board (508 to 666 ms), judged then on whole times: see npu-bench.ts below.
- **setup.ts**: on a PC under 20 GB, the NPU is planned with its generation's `smallPc` models (`smallPc(detection.ramBytes)`).
- **npu-refresh.ts**: the keeper's look plans with the PC's memory too. On a 16 GB X2 set up with the 4B, it leaves the NPU for setup (`needs-setup`) while the 2B isn't there, since it never downloads. Once it is there, the look tests it in the NPU's turn, as any new command, and switches. Its log and `changes` name a model change: `model … in …'s place`.
- **npu-bench.ts: a job's tries are judged at one answer length.**
  - Each try of a job is a prompt the server hasn't seen, so each gets an answer of its own length, and a longer one takes longer to write without the server being slower. That most likely kept every GenieX full run off the board, even on a quiet X2 Elite: the 4B's summary took 3.3 to 4.3 s and the 2B's reply 508 to 666 ms, while the short answer, writing and reading held within 5%. Those runs recorded no token counts, so the next run will show it.
  - Each job's tries now record their answer tokens (`answerTokens`, the server's count) and first-token times (`firstTokenMs`). Whether they are steady is the spread with each try's writing scaled to the tries' median answer length (`spreadAtLength`; `atAnswerLength`, `jobMeasure`).
  - The job's median, the job time and every other measurement are as before, so runs still compare within `castellan-npu-bench/2`, and a report from before keeps its verdict. A server that doesn't stream or count tokens is judged on whole times, as before (it is marked anyway).
  - The `noisy` mark names such a job "at one answer length". **spec/npu-bench.schema.json**: the three new fields, optional so earlier reports still match.
- **spec/NPU-VENDORS.md**: "Qwen3-VL-2B on a 16 GB Snapdragon X2", the model and licence rows, `--small-pc`, and what's still unverified. **spec/NPU-BENCHMARK.md**: its row, `--small-pc`, and a job's steadiness.
- **named.cs and named.ts:**
  - **The launcher:** `named.cs` starts the command after the agent's id with its console and output, in the job `Local\Castellan-<id>`, and returns its exit code. Its title is the agent's name, which Windows shows as its description, and its product is Castellan. The job sets no limits and ends nothing when the launcher ends. A program may leave it, as a model server started apart does. Exit codes: 2 for an id it won't take, 127 for a program that isn't there.
  - **`namedLauncher(app)`:** compiles it once per agent and per `named.cs` into the kit folder, `named-<id>-<hash>.exe` beside the checks pace's. `namedBuilt(app)` is that exe once it's there, else null.
  - **`namedWanted(app)`:** Windows only, and an id of letters, digits and hyphens. Under `node --test` it is off unless `KIT_NAMED=1`.
- **server.ts:** `serve` builds the agent's launcher in the background, 30 to 120 s after it starts.
- **service.ts:** `open` starts the page through the launcher once it's built (`pageLaunch`'s `named`). A checkout's job is `<id>-dev`, so it never joins the installed agent's. An id or path that cmd would misread starts the page as before. `pageLaunch`'s `args` are the page's arguments after its entry, `serve` unless given, for an agent whose page has a command of its own (Reeve's `dashboard --port <n>`).

- **spec/npu-vendors.json:** Intel's `meteor-lake` and `arrow-lake` labels. Their devices, `verified` and timings are as they were. No 200H or 200HX has been run.
- **spec/NPU-VENDORS.md:** Detection's Generation cites Linux's intel_pmc_core for Arrow Lake-H's `7D1D` (commit `f2eae58c4428`, "Fix Arrow Lake U/H NPU PCI ID", which defines `ARL_H_NPU_PCI_DEV` `0x7d1d`), in place of "likely". Arrow Lake-HX is the S die in a laptop, so `AD1D` is expected, but it has never been seen.

### For an agent

- Nothing to do.
- A 16 GB Snapdragon X2 already set up keeps the 4B until it is set up again (Manor's Set up local AI), which pulls the 2B (1.9 GB) and writes it. The 4B stays in `%USERPROFILE%\.cache\geniex\models` (4.4 GB) until removed (`geniex remove qualcomm/Qwen3-VL-4B-Instruct`).
- Not yet run: a real 16 GB X2 (the X2 Elite ran it with 48 GB, the kit's own command through `npu-bench --small-pc`), its pull through setup, the Adreno's first OpenCL compile on a fresh PC, and the encoder beside the card's own llama-server on the Adreno, whose turn it doesn't take.

## 2.77.9

**A release that signs gives up within a minute when SimplySign Desktop is waiting for its sign-in, before it builds or before it signs, instead of after ten minutes. It also brings what wasn't released before: A button whose work takes time spins while it runs, and the part of the page it changes waits with it. Questions and messages are the page's own dialogs, never the browser's alert or confirm.**

**Intel's integrated graphics read pictures again: their vision server encodes each picture on the processor (`--no-mmproj-offload`), and its language model stays on the graphics. On a Core Ultra 5 225U's Intel Graphics, llama.cpp's Vulkan encoder lost the device at the server's warm-up, so it exited as it started (4 of 4 of the Smith's audits on 2026-10-15), and the kit marked the graphics failed for 10 minutes. Now it is ready in 5 s and reads the Smith's check picture in 6 s, a 1,920 × 1,200 screenshot in 93 s. A PC set up before gets the flag at the keeper's next look; nothing to download, nothing to set up again.**

**On those graphics a picture's first question takes about 30 s, whatever its size, and has the time it needs. Their vision server caps each picture at 1,024 tokens (`--image-max-tokens 1024`), and their vision endpoint has its own `timeouts`: a background request may take 90 s and 0.3 s a token. Uncapped, a 1,920 × 1,200 screenshot took 89 s and a phone's 27 s, past the 16.2 s a 4-token question gets (Reeve's screens asks those), and a timeout marks the card failed, its chat too, for 10 minutes. Capped, every answer measured was the same. A PC set up before gets both at the keeper's next look, with or without the flag already.**

### What's new

- **busy.tsx:**
  - **`BusyButton`:** a button in the page's own classes (`className`, any button attribute) that spins while its work runs: a spinner in place of its `icon` (before its words without one), `aria-busy`, and no presses. Its work is `busy`, the page's own word for it (a store's "updating"), and any promise its `onClick` returns.
  - **`BusyArea`:** a part of the page that is disabled while its work runs: a `<fieldset>` drawn as a plain block, every control in it disabled, `aria-busy`, the progress cursor. Busy while `busy` says so, and while a BusyButton, PostButton or Button in it runs.
  - **Focus stays:** a control the browser lets go of as it's disabled has the focus back when the work is done.
- **modal.tsx:**
  - **`confirmDialog(text, { ok, cancel, danger, title })`** and **`alertDialog(text, { ok, danger, title })`:** the page's own `confirm()` and `alert()`. The same words, and the same choices: OK and Cancel (OK alone for a message). `confirmDialog` is true for OK, false for Cancel or Escape. They draw themselves (no host for a page to mount), one at a time, oldest first, over the tour too. Inside an open modal `<dialog>`, they're drawn in it, so they can be pressed.
  - **Each dialog:** an `alertdialog` that names its text (`aria-describedby`). OK has the focus, as the browser's had. Tab stays in it, Escape is Cancel (OK for a message), and focus goes back to where it was. Line breaks in the text stay.
  - **`DialogHost`** (a page may draw its own; a test does), **`dialogsOpen()`** and **`nextStop`** (where Tab goes) are exported too.
- **core:** an endpoint may carry its own `timeouts` (`requestBaseMs`, `requestPerTokenMs`, `coldLoadMs`), each over its accelerator's for that kind's requests alone: `timeoutsFor(accelerator, work)`. The core's config reader keeps them, on vision's own server or its chat endpoint's.
- **accelerator-config.ts:** `Endpoint.timeouts`, read as an accelerator's are and checked by `validateAccelerators` the same way.
- **setup.ts:**
  - `encodesOnProcessor(card)`: whether a card's vision server encodes on the processor. That is Intel's graphics (its id is `gpu-intel-…`) with under `OWN_MEMORY_GB` of its own, on a Vulkan device. `ENCODER_ON_PROCESSOR` is the flag.
  - `PICTURE_CAP` and `PICTURE_TOKENS` (1,024): the cap on a picture's tokens on such a card. `VISION_ON_PROCESSOR_TIMEOUTS` (`{ requestBaseMs: 90000 }`): its vision's own time, three times the slowest first question measured.
  - `withEncoderOnProcessor(raw)`: config.json with each of the flag (after the `--mmproj` file), the cap (after the flag) and vision's `timeouts` added where missing, on each such card's llama-server vision, and the cards changed. A cap or time a person set stays theirs. A command that keeps the encoder on the card (`--mmproj-offload`), or that isn't llama-server's, is left alone.
  - `refreshCardVision({ configFile, kit, log })` writes that into config.json once for each kit version, recorded in `card-refresh.json` beside it (`readCardRefresh`). A kit never redoes what a newer one looked at, so a person who takes the flag out keeps it out until the next kit.
- **keeper.ts:** `refreshCards()`, called by the keeper's look (`keeperLook`) before the NPU's refresh. What it changed goes in the keeper's log.

### What changed

- **sign.ts**: `trialProblem(signtool, thumbprint)` signs a throwaway script without a timestamp, within `TRIAL_MS` (60 s). If signtool says "No certificates were found", the key can't be reached. If it doesn't answer in time, SimplySign Desktop is waiting for someone to sign in, and that now counts as "can't sign" too. Before, `readySigner`'s trial gave signtool two minutes and counted no answer as "can sign", so the release built and then waited ten minutes on its first batch.
- `signFiles` tries a trial signature before it signs, because SimplySign's session can end while the release builds. When that trial fails, the release stops with `couldn't sign the native files: signtool didn't answer within 60 seconds …`. Nothing has been signed by then.
- A batch that runs past its ten minutes now says SimplySign Desktop may be waiting for you to sign in. The Steward (0.36.62) reads all of these as "waits until this PC can sign", not as a failed release.
- **`ModalCard`** (moved to modal.tsx, still exported from feedback.tsx and index.ts) keeps focus in it: Tab and Shift+Tab go round it. Only the top modal hears Escape. Focus moves to an element marked `data-autofocus`, else the card. A page that draws `onClose` anew each render no longer moves focus about while it's open. New props: `role` (`alertdialog`), `describedBy` and `modalClassName`.
- **`Button`:** an `onPress` that returns a promise spins the button until it settles, as `loading` does. `onPress` is `() => unknown` now; a `() => void` still fits.
- **`PostButton`:** its `confirm` asks in the page's own dialog. The server's error or `message` is said there once the POST is done and the page has looked for news, and a server that doesn't answer is said too (before, nothing was). Its BusyArea waits with it.
- **The Settings form** (settings-form.tsx) disables its fields, Cancel and "Set every field to its default" while it saves. **OnPageList**'s Removes wait for each other.
- **The tour:** "Save your changes first, or Cancel them." and "… can't start without …" are the page's own dialog.
- **page.ts's script:** `data-confirm` asks in the page's own dialog, and the server's error or message is said there. While its POST runs, the button spins and takes no presses, and so do its `data-form` form or the form or card it's in. A failure gives them back, and on success the page reloads as before. A network failure is said, and the page doesn't reload itself under a dialog or a button that waits.
- **settings-panel.js:** Save spins while it saves, and the fields, Cancel and "Set every field to its default" wait with it. "Try again" spins while the settings load.
- **The CSS:** the spinner, the modal card and the dialogs are page.ts's CSS now (both kinds of page draw them), with `button:has(> .ui-spinner)`. The react part's UI_CSS adds `.ui-busy-area`.
- **Setup** (`acceleratorEntry`) writes the flag into such a card's vision command, right after its projector, then the cap, and gives its vision endpoint `VISION_ON_PROCESSOR_TIMEOUTS`. The card's chat and embeddings, and every other card, are unchanged.
- **npu.ts:** a request's timeout, and the wait for its server to be ready, take its kind's own `timeouts` over its accelerator's (`timeoutsFor`).
- **spec/ACCELERATORS.md** says where a card's vision encoder runs, and why, with the measurements: `--no-warmup` started the server, but lost the device on the screenshot. So did flash attention off, cooperative matrices off, and pictures capped at 1,024 tokens. It also gives a picture's time on the processor, uncapped and capped, measured through the kit's own requests, and an endpoint's own `timeouts`.

### For an agent

- Nothing to do for PostButton, `data-confirm`, OnPageList, the Settings form or the tour: they use the page's own dialog by themselves.
- A page of its own that calls `window.confirm()` or `window.alert()` calls `await confirmDialog(text)` or `await alertDialog(text)` instead, with the same words.
- A button whose handler awaits is a `BusyButton` (or the kit's `Button`, whose `onPress` returns the promise). Wrap what the work changes in a `BusyArea`.
- A page that copies the kit's CSS (Manor's app.css, under a policy with no inline style) adds `.ui-busy-area`, `.ui-modal.ui-dialog` and the `.ui-dialog-*` rules from page.ts's CSS.

## 2.77.8

**PowerShell's time limits stretch at the checks pace, as a test's own waits do. It also brings what wasn't released before: The NPU 3720's embeddings, which run on the processor's graphics, answer in the graphics' turn, beside the NPU's chat. On the 225U, a search query while chat writes takes 52–57 ms instead of 6.9–7.4 s, and chat's first token while 16 chunks are indexed takes 0.52–0.60 s instead of 6.2–6.5 s. Setup notices when FastFlowLM can't set an AMD NPU's power mode, and says why. `npu-check --harden` passes every step on the NPU 3720: it waits for the server the timeout case started to answer, then stops it. spec/NPU-VENDORS.md has the NPU 3720's memory on a 16 GB PC.**

FastFlowLM sets the mode with AMD's `xrt-smi.exe` and ignores the result. On a PC where an older AMD NPU driver left its DLLs in `Windows\System32\AMD`, xrt-smi can't start, and the NPU runs at its default mode. This was found on the Krackan test PC, from a Dell factory image.

### What's new

- **An endpoint's `turn`** (the core's Endpoint, and the keeper's config): the id of the device its server runs on, `gpu-…` or `cpu`, when that isn't its accelerator. Its requests take that device's lock and line (the core's `turnOf`; the kit's `turnFor`). The NPU's id, or anything that isn't an id, isn't a turn: the entry is read without it, and the check names it. A vision model on its chat endpoint's server takes chat's. spec/ACCELERATORS.md has it.
- **npu-vendors.ts**: `embedTurn(route, cards)` gives a route's embedding server that runs on the graphics (`--target_device GPU`: the NPU 3720's) the id of the Intel graphics that shares the PC's memory, else the first Intel card. `planNpu` takes the PC's `cards` for it, and `npuEntry` writes the embeddings' `turn`.
- **accelerators.ts**: `turnsWithoutEntry(list)`, the devices whose turns an entry's servers take without an entry of their own. `acceleratorLines()` and the work status's `pcLines()` list their lines too.
- **npu-vendors.ts:**
  - **A route's `powerTool`:** `exe`, `args` (read only), `brokenExit` and `broken`, the reason in plain words.
  - **AMD's:** `%SystemRoot%\System32\AMD\xrt-smi.exe examine`, broken on exit 0xC0000139 (3221225785, as Node reports it).
  - `planNpu` expands its path into the plan's `powerTool`.
  - **`checkPowerTool(plan, io)`:** runs it once, from Node, so a loader failure stays silent rather than showing a dialog. It gives `{ exe, missing, code, broken }`, or null when the route has no power tool.
- **setup.ts:**
  - **`setUpNpu`:** once its server answered, it checks the power tool and returns the check as `power`.
  - **On `broken`:** the NPU is still used, and `npuPowerNote` adds "The NPU (…) is used, at its default power mode: …" to its note (`npu-note.json`, the report's `npuNote`). Setup logs the exit.
  - **Never:** it doesn't fail on it, and it changes nothing on the PC.
- **npu-server.ts:** `setUpRoute` returns `power`. It doesn't time the power tool's run as an install.
- **npu-check.ts:** a `power-tool` step, right after `setup`, on every route that has a power tool. Its `ok` is null, never a failure. It says whether the tool ran, couldn't start, or isn't on the PC, and its data is the check, so the reports count the PCs where this happens.
- **spec/NPU-VENDORS.md:** the check, and how the Krackan was fixed.

### What changed

- **ps.ts**: `powershell(script, { timeoutMs })` stretches its time limit (60 s unless given) by as much as the checks pace slows the process (`psPaced`, which reads `KIT_CHECKS_SLOWER` as checks-pace.ts's `paced` does). A test run at the pace starts its own powershell.exe inside the pace's job, beside every other test file's, and .NET's start alone could pass the keeper's 30 s process query, or a script's 60 s, there. The keeper's and psQuote's tests timed out so on a busy PC. Unpaced, as an agent's own work runs, nothing changes.
- **npu.ts**: a request takes the turn of the device its server runs on. The pick reads that turn's line, and a background request's back-off is that turn's. An NPU 3720's search query no longer waits for the NPU's chat, nor its chat for an indexing batch. Its failure marker, cap and name stay the NPU's.
- **Setup** (`planSetup`, `setUpNpu`) and the check (`npu-check`) plan the NPU with this PC's cards, so an NPU 3720's embeddings get their `turn`.
- **The NPU's refresh** (npu-refresh.ts) writes the turn into a PC set up before it, after its usual test, and stops and tests holding both turns. A detection that lists no cards keeps the entry's turn.
- **The keeper** (keeper.ts) looks after such a server in its turn's lock folders, with its accelerator's idle time and log (`otherTurn`). Its idle-in-flight check (`npu-check --idle`) looks only at the servers in the NPU's turn.
- **The embedding server's giving way to chat** (2.77.5) leaves it alone: with its `turn` it answers beside the chat, and the keeper's `ownEmbedServer` already skips an endpoint with one. spec/NPU-VENDORS.md says so for the NPU 3720.
- **spec/NPU-VENDORS.md** has The NPU 3720's embeddings in the graphics' turn, with the measurements before and after.
- **npu-check.ts's `--harden`** waits, up to a minute, for the server the timeout case's setup started to answer before stopping it. Given 1 s, that server hadn't opened its port when the check stopped servers, and only a server that answers is stopped, so it was left loading the route's model, and the nonsense case's test asked it instead of starting its own: a 404 for the nonsense model, and the step failed (the NPU 3720, 2026-10-15). With it, every `--harden` step passes on the NPU 3720, the nonsense case too: OpenVINO's group-wise Qwen3-4B compiles there (its first load 125 s) and answers nonsense, as on the Lunar Lake, and setup leaves the NPU out.
- **spec/NPU-VENDORS.md** gains Memory on a 16 GB Intel PC: on the NPU 3720, with the route's commands, chat held 3.20 GB and embeddings 1.16 GB on the NPU (1.14–1.27 on the graphics), 4.2–4.4 GB of the PC's available memory together, under the route's `memoryGb` (5.54) and the 6.2 GB budget; Windows lets the NPU hold 8.80 GB. Nothing changes: the Snapdragon's smaller embedding context (kit 2.75.1) saves nothing on OpenVINO's NPU.

### For an agent

- Nothing to do: take the kit and release as usual.
- On an AMD NPU, the next setup checks xrt-smi by itself. On a PC with the old DLLs, the NPU's note says so.

## 2.77.6

**Each accelerator's servers stop when that accelerator has been idle, whatever the others do. Before, a let-go of any accelerator's lock counted as use of all of them, so Reeve indexing on a graphics card kept the NPU's servers loaded, and the NPU kept a card's.**

### What changed

- **keeper.ts**: the Reaper's idle time for an accelerator counts only its own lock and line.
  - `ownActivityMs(lockDirs)`: when the accelerator's own lock folder or line last changed.
  - `locksActivityMs(lockDirs)`: when anyone last took or let go of any accelerator's lock (the folder every lock shares).
  - `lastActivityMs(lockDirs)` is the later of the two, as before, for the quiet looks that wait for the whole PC (the Smith's, the NPU refresh's).
  - A let-go leaves its time only on the shared folder, since the slot's folder is removed. So the Reaper counts that folder's time for an accelerator only when it saw the accelerator held, waited on or taken since its last look: at most a minute late, never early. At its first look, no later than `lock.staleMs` after the accelerator's lock was last taken.
  - `ReaperDeps.locksActivityMs` is new and optional. A Reaper given only `lastActivityMs` works as before.
- The idle-stop times (`npuIdleStopMinutes`, `gpuIdleStopMinutes`), `npuMemoryFit` and `NPU_MEMORY_SHARE` are unchanged.

### Before you update

- Nothing: it updates itself as usual. The keeper of a PC that runs on more than one accelerator now stops each one's servers on its own idle time.

## 2.77.5

**On a PC under 20 GB, the NPU's embedding server gives way to its chat: a chat or vision request stops it first once no embedding has been answered for 30 s, so the chat has its 1.4 GB of the NPU's memory.**

### What changed

- **npu.ts**: a chat or vision request on the NPU, in its own turn and before its server is asked, lets the NPU's own embedding server give way (`embedGivesWay`). This applies on a PC under npu-vendors.json's `idleStop.smallPcGb` (20) with no `npuIdleStopMinutes` in config.json. A bigger PC never loads the code for it.
  - It frees the chat 1,408 MB of the NPU's memory and a 1.7 to 2.0 GB working set on a Snapdragon, or 1.7 GB on Intel.
  - Only the embedding side gives way. It starts again for the next embedding in 2 to 3 s (1.7 s beside a loaded GenieX, measured), where GenieX loads in 9 to 17 s.
- **keeper.ts**: `ownEmbedServer(acc)` finds the NPU's own embedding server, and `yieldEmbedServer` stops it.
  - **Which servers**: Qualcomm's llama-server and Intel's second OpenVINO Model Server. Not FastFlowLM's route, npu-embed, a server shared with chat, or one whose requests take another device's turn.
  - **When it stops one**: only when the server answers ready (a loading one is left alone) and the NPU hasn't answered an embedding for `YIELD_GRACE_MS` (30 s).
  - **How**: by its program and the address its command line serves. It waits up to 10 s for the port to close, and each stop is written in the keeper's log.
  - **When it gives up**: if finding the processes takes more than 5 s, or on any error, the chat goes on beside the server. It never throws.
- **accelerators.ts**: `noteEmbedded(id)` and `embeddedAt(id)` keep `<accelerators>/<id>.embedded.json` (`{at}`). Every agent writes it after its embeddings on the NPU, at most every 5 s per process.
- **Why 30 s**: the manor's traffic, watched for two hours and merged onto one NPU as on a 16 GB Snapdragon. Giving way at every chat would start the embedding server 4 more times an hour, mostly for Reeve's search right after its map or summary. After 30 s without an embedding, it's 1 more an hour.
- **Measured** on private ports through the kit's own requests: a warm chat that stops the server takes 0.47 to 0.63 s, against 0.10 s with nothing to stop. The NPU's memory falls by 1,409 MB.
- **spec/NPU-VENDORS.md** (The embedding server gives way to chat) has the traffic, the measurements and what's left alone. spec/ACCELERATORS.md's keeper bullet points there.

### For an agent

- Nothing to do: take the kit and release as usual. On a 20 GB PC or bigger, nothing changes.

## 2.77.3

**On an AMD Ryzen AI 300, one smaller model, Qwen3.5-2B, answers chat and pictures on the NPU. It writes half again as fast, holds 0.4 GB less of the PC's memory for chat and 1.2 GB less for pictures, downloads 2.0 GB instead of 7.4, and never switches models between a chat and a picture. It starts about 1.7 s slower.**

### What changed

- **npu-vendors.json's amd route** (AMD's alone; Qualcomm's and Intel's routes, the keeper and `npuMemoryFit` are unchanged):
  - **`models`**: `qwen3.5:2b` (Qwen3.5-2B, FastFlowLM's NPU2 build, Apache-2.0) for chat and vision. It replaces `qwen3-it:4b` for chat and `qwen3vl-it:4b` for vision. It is 2,014,970,646 bytes with its vision weights and tokenizer, and its `present` file is the vision weights (`vision_weight.q4nx`). The 8 to 9 s switch between the two 4B models, either way, is gone: the one server holds one model that does both.
  - **Measured with the benchmark** (`castellan-npu-bench/2`, quick, on the Krackan, Ryzen AI 7 350 with 16 GB, FastFlowLM 1.0.7, 2026-10-15), against the 4B:

    | | Qwen3.5-2B | Qwen3-4B (and its VL model) |
    |---|---|---|
    | Quality items | 22 of 24, every must-pass one right | 23 of 24 |
    | Tokens written a second | 20.4 to 21.0 | 13.6 |
    | Jobs: triage, reply, summary | 2.1, 2.9 and 4.4 s | 3.3, 8.8 and 7.1 s |
    | First token of a 1,024-token prompt | 1.47 s | 2.43 s |
    | Short answer | 0.82 s | 1.37 s |
    | Working set | 4.0 GB | 5.7 GB |
    | Pictures | 3 of 4, 1.2 to 1.4 s | 3 of 4, 1.8 to 2.0 s |

    It missed `apples`, as the 4B did, and `json-list`: it listed the bread and milk with the fruit. On pictures, it misread a number. Its full profile scored the same 22 of 24 and passed all 15 jobs. Its speed held 89% over 10 minutes, against the 4B's 96%.
  - **Smaller or other models**:
    - Qwen3.5-0.8B scored 19 of 24, Gemma3-1B and LFM2.5-1.2B 18, Qwen3-1.7B 17 and Qwen3-0.6B 13.
    - Llama 3.2 1B failed setup's first-load check.
    - Gemma4-E2B scored 24 but held 6.8 GB.
    - Qwen2.5-VL-3B scored 23, with every picture right, but it is under Qwen's research licence, which bars commercial use.
  - **Thinking:** FastFlowLM serves Qwen3.5 with its thinking off, and the benchmark's answers carried none. The kit sends it no `/no_think`, since `thinks()` already left out Qwen3.5.
  - **From the NPU check on the Krackan** (2026-10-15). These were measured while Reeve embedded on the Radeon 860M, which shares the PC's memory with the NPU, so the starts are on the slow side:
    - **`memoryGb`**: 4.1 for chat and for pictures. It held 3.7 GB started and 4.0 to 4.1 GB after the benchmark's jobs and pictures, against 4.5 and 5.3 for the 4B pair.
    - **xdna2 `timeouts`**: 15 s + 150 ms a token, and a 30 s cold load. The base was 20 s. Measured: 19.4 tokens written a second, 3,272 tokens read in 4.1 s, and the slowest start to a first answer 17 s.
    - **`idleStop`**:
      - 15.1 s for chat: `--idle`'s cold answer took 15.0 s, and the keeper's stop freed 3.7 GB.
      - 16.6 s for pictures: the kit's test request on a stopped server, a picture and then chat.
      - Both give 6 minutes. A person waking it is told about 15 s, where the 4B's chat was 6.6 s.
    - **The start:** timed alike from Node, three starts each, Qwen3.5-2B answered first in 11.8 to 12.4 s and the 4B in 10.1 to 10.7 s. So it starts about 1.7 s slower, but nothing switches afterwards. The 4B took 9.2 s more for its first picture.
  - **`notes`**: rewritten for the one model, and corrected on FastFlowLM's power mode (below).
- **FastFlowLM's `--pmode` was never measured on the Krackan** (spec/NPU-VENDORS.md, npu-vendors.json's notes):
  - `flm serve` sets its mode by running `C:\Windows\System32\AMD\xrt-smi.exe configure --pmode`, and ignores the result.
  - There, an older driver's `xrt_coreutil.dll` (2024) beside the newer `xrt-smi.exe` lacks a function `xrt-smi` needs. So `xrt-smi` failed to load at every start, and every `--pmode` run was in one mode.
  - The failure is silent from Node, which the kit starts it from. From anywhere else, each start shows an "Entry Point Not Found" dialog.
  - The route still sets no mode. The modes are still to measure, on a PC whose `xrt-smi` runs.
- **`npu-check --harden`'s harden-nonsense step fails on FastFlowLM, for both models.** It puts `OpenVINO/Qwen3-4B-int4-ov` in the chat model's place, and `flm serve` exits at once ("Model not found"). So setup's note says the server didn't pass its test, not that the model doesn't run properly. The NPU is left out either way.
  - It fails the same on the Qwen3-4B route, run the same day. Its earlier passes were most likely another server answering on 18184.
  - Not changed here: the step has no model that answers nonsense on FastFlowLM to force.
- **spec/NPU-VENDORS.md** has the AMD model row, the licences row, and the Krackan's runs with Qwen3.5-2B under "Verified, and not". **spec/NPU-BENCHMARK.md** has the AMD row. It also says that Qwen3.5's tokenizer (248,320 tokens) isn't the Qwen3 models' (151,936). So its tokens a second compare only roughly with the other rows', while its jobs, timed in seconds, compare as they are.

### For an agent

- Nothing to do.
- A PC already set up keeps serving the 4B models until it is set up again (Manor's Set up local AI), which pulls Qwen3.5-2B (2.0 GB).
- The 4B models stay in `%USERPROFILE%\.flm\models` (7.4 GB) until removed (`flm remove qwen3-it:4b`, `flm remove qwen3vl-it:4b`).

## 2.77.2

**A graphics card's embedding server holds about 600 MB less: it starts with `-c 4096 -ub 512`, and a request to it is capped at 1,365 tokens (4,095 characters), with the same vectors and times.**

### What changed

- **setup.ts**: the embedding server on a graphics card (or the processor) starts with `-c 4096 -b 2048 -ub 512`, not `-c 8192 -b 2048 -ub 2048`. Its endpoint gets its own `maxContextTokens`, 1,365 (`EMBED_CAP`), below the card's: by the kit's estimate of 3 characters a token, an input under it is at most 4,095 characters, and so fits 4,096 tokens even at a token a character.
  - On a Radeon 860M (WEASELDEV03, llama.cpp b11669 Vulkan), the server held 1,278 MB of the card's memory against 1,891 MB, and its working set was 1,386 MB against 2,049 MB. The times were the same: 28 ms against 31 ms for a query, 288 ms against 293 ms for Reeve's longest input (2,060 characters, 451 tokens), and 2.22 s against 2.24 s for 2,694 tokens. Every vector matched old against new (cosine 1.000000), as it did old against old.
  - **On a Core Ultra 5 225U's Intel Graphics** (WEASELDEV02, 4 Xe cores, llama.cpp b11624 Vulkan, 2026-10-15). Runs went old, new, old, new, with each input sent 5 times warm. It held 0.60 GB less:
    - working set 1.37 GB against 1.97;
    - private bytes 1.41 GB against 2.01;
    - the card's shared memory 1.25 GB against 1.85;
    - by llama.cpp's own buffers, the KV cache took 448 MiB against 896, and compute 26 + 12 MiB against 120 + 64.

    The times were the same within noise:
    - a query 145–147 ms against 137–138 (minimums 133–134 against 132–133);
    - a 430-token chunk 759–766 ms against 749–759;
    - 2,679 tokens 9.02–9.30 s against 9.06–9.10;
    - a dense chunk at the new limit (4,095 characters, 3,379 tokens) 13.4–13.9 s against 13.5–13.8, answered in 7 passes of 512.

    Every vector matched (cosine 1.000000), old against new, old against old, and new against new.
  - `-b 2048` stays, as on Qualcomm's route (2.75.1). With embeddings, llama-server sets the batch to the micro-batch itself, 512, and warns so ("embeddings enabled with n_batch (2048) > n_ubatch (512)").
  - An input longer than a 512-token micro-batch is split across several, so nothing that fit before is refused by the server for its length.
  - The reranker keeps `-c 8192 -ub 2048`.
  - Sizing is unchanged. `serverContext` and `SERVER_GB` still count the embedding server as it was, so every card is sized as before. That estimate is now high for it: it counts 2.7 GB, and the Radeon's server held 1.3 GB.
- **npu.ts**: a request over every serving accelerator's cap for its kind is refused before it's sent, saying that cap ("refusing a request of ~1400+0 tokens (cap 1365); split the input"). Before, a request under the accelerator's cap but over its kind's was dropped from the candidates, and said only that no accelerator could take it. `budget(maxTokens, work)` gives the largest cap for that kind, so chunking for embeddings fits 1,365 on a card.

### For an agent

- Nothing to do for the agents of the manor: their longest input is Reeve's cluster item, about 2,060 characters, and Clerk's and Chamberlain's are cut at 600. An agent that embeds more than 4,095 characters at once on a card should chunk by `budget(0, 'embed')`.
- A PC set up before keeps its embedding server's old flags and no cap until it's set up again (Manor's Set up local AI, or the Smith's Set up). Nothing rewrites a card's entry on its own.

## 2.77.0

**A pass anywhere, for the same code: before an agent runs work again on a clean checkout, it can take a pass of exactly that code tree from this PC's results, or from another PC on the licence through Manor (spec/WORK-STATUS.md, A pass anywhere, for the same code).**

### What's new

- **work-status.ts**:
  - `passFor({ kind, repo, tree, commands })` gives the pass that stands in for running that work again, or null. It looks at this PC's own result for the tree first, then asks another PC's through Manor.
  - `whyNotPass(result, query)` says why a result doesn't stand in, or null when it does. To stand in, a result must:
    - have passed;
    - be of the same kind: an `affected checks` pass never stands in for `checks`;
    - be for the same repository and tree;
    - be under a day old (`PASS_STANDS_MS`);
    - have run on the same Node.js major and OS (`toolchainHere()`);
    - have run every command asked.
  - A failure here newer than the other PC's pass, and that pass isn't taken. A failure elsewhere never stands in. A pass taken from another PC is kept here as that PC's (`from`).
- **The kit's server**: `GET /api/peer/result?kind=…&repo=…&tree=…` answers this agent's own result for one tree (`peerResult`), from all of `work-results.json`, not only the 50 a status lists. It never passes on a pass taken from another PC. It is read only, so Manor's link passes it on as `GET /agents/<id>/result`.
- **manor.ts**: `passOnOtherPcs(query, { agent })` asks Manor on this PC (`GET /api/peers/result`, Manor 0.16.163 and later) for the first pass among the other PCs it hears from. It answers null when:
  - Manor isn't here, or is older (its 404);
  - Other PCs is off;
  - under `node --test`, unless the test gives Manor a home (`MANOR_HOME` or `home`).

### What changed

- **WorkResult** has `commands`, `node`, `platform` and `from`. A result kept before 2.77.0 says none of them, and so never stands in.

### For an agent

- Nothing to do: the route comes with the kit's server. To skip work that already passed, call `passFor` before running it, and record what it ran with `recordResult({ …, commands, ...toolchainHere() })`.

## 2.76.0

**Every agent says what it is working on. `GET /api/peer/work` answers with its work status (spec/WORK-STATUS.md): what it may run at once, what it runs, what waits and in which line, the PC's lines, its results by code tree, and what holds its work up. Manor's Work page reads it. It also brings the NPU work not released before: the NPU 3720's embeddings run on the processor's graphics, a query in 50 ms rather than 1.1 s, Reeve's indexing 3.7 times as fast, the same vectors, and chat on the NPU no slower beside it.**

### What's new

- **work-status.ts**: `workStatus(extra)` builds an agent's status (shape version 1) from what the kit knows, plus what the agent adds. The kit's server answers it for every agent at `GET /api/peer/work`. The route is read-only, so Manor's link to other PCs passes it on as it is. `serve({ work })` gives the agent's own part: its `slots`, more `running`, `waiting` or `lines`, its `results`, and what is `blocked`.
  - `pcLines()`: the PC's lines as they stand, each with who holds a place and who waits, since when:
    - the checks pace's turns (`checks`);
    - the kit pace's work line (`work`);
    - the first-round line (`first-round`);
    - each accelerator's line (`accelerator:<id>`).
  - `pcLoad()`: the PC's name, processors and memory, how busy its processors are (0 to 1), its pace, and the checks pace's cap.
  - `recordResult()`, `resultFor()`, `recentResults()`: what work came to, one per kind, repository and code tree (git's tree id, the same for the same code whatever the commit). The latest is kept in `work-results.json` (200 of them).
  - `codeAt(dir)`: a checkout's commit and tree, and whether anything tracked has changed. It is read with git itself, apart from the agent's runner.
- **work-tasks.ts**: an agent's tasks.
  - `withWork(fields, fn)` runs `fn` as a task. `startWork(fields)` gives a handle to `waitIn(line)`, `running()`, `set()` and `done()`.
  - A task started inside another is its part (`parent`). `outsideWork(fn)` makes work that outlives its task (a job beside the rounds) a task of its own.
- **schedule.ts**: every scheduled round is a task. It waits in the first-round line or the work line, then runs, and the work its job does is its part.
- **checks-pace.ts and checks-pace.cs**: the checks pace's turns are in sight.
  - Each launcher that takes part in the turns writes `<pid>.run` in `checksRunsDir()` while it runs. The file says whether it waits for a turn or holds one, since when, and which agent, task and command it is for (`KIT_CHECKS_WHO`, which `pacedCommand` sets).
  - `checksRuns()` reads the files, and removes those whose launcher has gone.
  - The turns themselves work as before. The launcher's source changed, so each PC compiles it again once.
- **npu-vendors.ts**: a generation's `embedArgs`, its embedding server's arguments that differ on it, replace those in the route's `embedServer.serve` as `args` do in `serve` (`routeFor`). An unknown generation takes none.

### What changed

- **npu-vendors.json's `meteor-lake`** (the NPU 3720 of Meteor Lake and Arrow Lake-U): `embedArgs` `{"--target_device": "GPU"}`, the same OpenVINO Model Server, model, pooling, `--max_length 2048` and port, on the processor's graphics. Measured on a Core Ultra 5 225U's Intel Graphics (2026-10-15, two runs each, spec/NPU-VENDORS.md, The NPU 3720's embeddings): a query in 49–50 ms against the NPU's 1.13 s; 16 of Reeve's chunks in 4.8 s against 18.0; a dense chunk (1,100–1,320 tokens) in 0.73–0.95 s against 2.5; vectors at cosine 0.997–0.999 to the NPU's, under the same model name, so Reeve's index stays. Beside the chat server with the route's command, chat wrote 13.1–13.3 tokens a second while the graphics indexed, as fast as alone, against 6.5–6.8 with both on the NPU. The NPU's entry still takes one request at a time, so chat waits for an indexing batch: about 5 s for 16 chunks, against 18 s on the NPU (about 40 for dense ones).
  - Not chosen: the NPU at `--max_length` 512 answers a query in 0.27 s but refuses Reeve's dense chunks, so it would need a second server for queries; 1,024 saves 4–6% and refuses them too. The processor slowed chat by a fifth while indexing and held about 2.4 GB. llama.cpp's Vulkan build, setup's for a card, was slower on the same graphics, with another model's vectors. `NPUW_LLM_PREFILL_CHUNK_SIZE` in the embedding server's `--plugin_config` (128 or 256) stops OpenVINO Model Server at its start (0xC0000409), as before.
  - Arrow Lake-S, the same NPU, keeps its embeddings on the NPU: its F models have no graphics. So does every other generation, and one setup doesn't know.
- **npu-check.ts's `routeOnDevice`** leaves the embedding server where the route has it when the check runs on the NPU, so the NPU 3720's stays on the graphics; on the processor or the graphics it goes with chat, as before.

### For an agent

- Nothing to do: the route comes with the kit's server. To say more, pass `work: () => ({ slots, blocked, … })` to `serve()`, and wrap long work in `withWork` so that it shows as a task.
- Nothing to do: take the kit and release as usual.
- On an NPU 3720 already set up, the NPU refresh tries the new command as the agent pins this kit (`embeddings: --target_device GPU added`), testing a chat answer and an embedding. The graphics compile the embedding model once, in 4–12 s. It keeps the old command if either doesn't answer properly, and a PC whose graphics can't run OpenVINO fails setup's embedding test, its embeddings going to the card or the processor as before.
- The embedding endpoint the kit writes for an NPU 3720 (`planNpu`, `npuEntry`), started with its own command and environment on the 225U, answered a query in 43–50 ms and a dense chunk in 0.85 s, its first vector 6.6 s after the start with the graphics' compile. Setup and the NPU check haven't run it on a PC yet, nor has anyone on a Meteor Lake's Arc graphics, or with a game on the graphics: the keeper defers a card's models for a game, not the NPU entry's embedding server.

## 2.75.2

**Automatic updates work on a busy PC: a page slow to start after an update is waited for instead of rolled back, a rollback never leaves the new page running over the old files, and an agent's rounds make room for Manor's update.**

### What's new

- **update-hold.ts**: while Manor has an automatic update due for the agent, a scheduled round waits (`every()`, and `runSoon()`'s rounds too), looking again every 30 s (`UPDATE_LOOK_MS`), its state's `waiting` saying "Manor to update it to <version>". Manor updates an agent only while it's idle, and looks every minute: an agent whose rounds ran back to back was never idle then, and its update waited for hours. It waits 5 minutes at most for a version (`UPDATE_HOLD_MS`), then the rounds go on, and wait again 30 minutes later (`UPDATE_HOLD_AGAIN_MS`). A round asked for (Run now) never waits.
- `updateDue()` reads Manor's files: `updates.json` (a version newer than this one available, Manor's last look not cut short by a problem or the network, not one Manor has given up on after its three tries or waits to try again) and `settings.json` (the agent's automatic updates on). A version the agent's own install refuses (`unsafe-updates.json`) isn't due, nor is anything in a development checkout. `updateHold()` is the agent's one hold, shared by all its schedules; `updateHolder()` makes another; `compareVersions` compares dotted versions.
- **native.ts**: `pagesFrom(app)` lists the Node processes running the page from an app folder (`<app>\src\cli.ts serve`, and the `open` that starts it) by their command lines, which `processesUnder` can't see, since Node runs from its own folder. `pagesIn(lines, app)` reads PowerShell's lines for it.

### What changed

- **install.ts**: after starting the page, an install waits 20 s for it as before (`PAGE_FIRST_MS`), then on while its process is still starting, up to 5 minutes (`PAGE_START_MS`). A page whose process has ended isn't waited for past the 20 s. Its line says `up, after <n> s: the PC is busy`, `didn't answer, and its process has ended`, or `still starting after 5 minutes`. `waitForPage(ok, app, d)` is exported, and `InstallDeps.pagesStarting` stands in for `pagesFrom` in a test. On 15 October the Steward's 0.36.46 and the Assayer's 0.4.2 took longer than 20 s to answer on a PC running a release's checks: each was rolled back and flagged as unsafe, and went on running over the older version's files.
- **safeinstall.ts**: an install that gave up waiting for the page, whose page answers as the new version by the time it is judged, goes on to its probation, which judges it as any other. Before, it was rolled back and flagged.
- **safeinstall.ts**: a rollback ends any page process still starting from app, and the `open` starting it (`endStartingPages`, in the real `endPage`), before it puts the version before back. Such a page has no `server.json` yet, so the rollback used to miss it, and it came up over the older files. The rollback then waits for the old page as an install does.
- **safeinstall.ts**: once a version holds up for its probation, the flags of the versions before it are dropped (allowed again), and with them an agent's alarm for one. Their kept copies (`app.unsafe-<version>`) stay.

### For an agent

- Nothing to do for its schedule. An agent that starts rounds itself, beside its schedule (the Steward does, after a kit trial or on waking), asks `updateHold()` first and starts none while it answers: the schedule runs that round once the wait ends.
- A PC already left with a newer page running over an older version's files, that version flagged, is set right by the agent's next release: its install ends the running page, puts the whole release in, and drops the old flag once the new version holds up. Until the agent runs this kit, its rounds don't wait for Manor, so its next update may still wait for an idle moment, or for Update in Manor.
- A test that runs `every()` reads Manor's files from `MANOR_HOME` (else `%USERPROFILE%\.manor`): set it to a folder of the test's own when the test's agent id could have automatic updates on.

## 2.75.1

**On a Snapdragon, the embedding server beside GenieX holds 1.4 GB of the NPU's memory, not 2.9 GB, in the same time and to the same vectors, so chat, pictures and embeddings fit a 16 GB PC with room to spare.**

### What changed

- **npu-vendors.json's qualcomm route** (Qualcomm's alone; Intel's and AMD's routes, the graphics card's and the processor's llama-server, the keeper and `npuMemoryFit` are unchanged):
  - **`embedServer.serve`**: `-c 4096 -ub 512`, not `-c 8192 -ub 2048`. Measured on the X2 Elite, 14 settings, each started fresh on a private port in the NPU's turn: 1,408 MB on the NPU against 2,876, a 2.0 GB working set against 4.4, 629 MB private against 1,567. A query took 30 ms, a 432-token chunk 131 ms and a 2,707-token text 1.0 s, as before, and the vectors matched (cosine 0.99999 or more). Beside a loaded GenieX the two hold 5,646 MB of the NPU's memory, against 7,114 MB. Windows lets one device hold about half a PC's memory, 7.8 GB on a 16 GB Snapdragon.
  - **`caps.embed`: 1,365**, by the kit's estimate of 3 characters a token, so a request stays under the server's 4,096 real tokens even at one token a character. Embeddings had the route's 2,400 before. The longest input any agent sends is about 2,060 characters (Reeve's cluster items), an estimate of 687, so every request still goes to the NPU. A longer one goes to the next accelerator that makes embeddings.
  - **`idleStop.coldStartMs.embed`: 3,000**, measured (1.3 to 3.0 s alone, 1.5 to 2.2 s beside a loaded GenieX), not the 10,000 assumed. A person waking it is told about 3 s; the minutes stay 5.
- **spec/NPU-VENDORS.md** has the measurements (Memory on a 16 GB Snapdragon) and what stays as it was: GenieX's own 1.56 GB float32 embedding table, which GenieX 0.8.0 reads whole for vision-language models and won't take quantized; its 4,096-token context, AI Hub's only build; InternVL3.5-2B, smaller and faster but 19 of 24 on the quality items against 22, a must-pass one wrong; recycling GenieX sooner, which the 5-minute idle stop makes moot on a small PC; and no `memoryGb` for Qualcomm, which at the 40% share would leave embeddings off the NPU on every 16 GB Snapdragon. It also has the route run under a 16 GB PC's memory (a ballast on the X2 Elite, at 9.7 GB available and at 15.6 GB in all). Nothing failed at either level. The NPU held the same 5,646 MB as with no ballast (7,114 at the old setting), and the new setting left 1.6 GB more of the PC's memory.

### For an agent

- Nothing to do: take the kit and release as usual.
- On a Snapdragon already set up, the NPU refresh brings the embedding server's new command and cap in as the agent pins this kit, once it answers its test. Nothing is downloaded, and no index is rebuilt: the model and its vectors are the same.

## 2.74.8

**An agent's work can keep the PC awake: while it runs checks, merges or a release, Windows doesn't sleep on its own, and once the work ends it may again.**

### What's new

- **awake.ts**: `stayAwake(what)` holds the PC awake until the function it returns is called, and `whileAwake(what, fn)` holds it while `fn` runs. Holds from anywhere in the agent's process share one hold of Windows, which ends when the last is let go. `awakeFor()` lists what holds it now.
- **schedule.ts**: a round's job gets `awake(what)` beside its `signal`. It holds the PC awake for the round's work, and anything it still holds is let go when the round ends.
- On Windows a small helper holds it (`awake.cs`, compiled once to `awake-<hash>.exe` beside the checks pace's launcher, shared by every agent on the PC). It asks Windows to keep the system working (`ES_CONTINUOUS | ES_SYSTEM_REQUIRED`) until the agent closes its input. It lets go if the agent ends first, so a hold never outlives the agent, and `powercfg /requests` lists it while it holds.
- It prevents idle sleep only. A sleep the person chooses (Start's Sleep, the power button, closing the lid) still happens, the display still turns off, and other platforms do nothing. A helper that can't be built or started leaves the PC to its own power settings, said once in the log, and never fails the work.
- On 15 October a PC slept on its own for an hour in the middle of the Steward's checks, and for 13 minutes later, which is much of why that round ran out of time.

### For an agent

- Nothing to do: nothing is held until the agent asks. Hold it only around real work: a hold resets Windows' idle timer, so a round every few minutes that held it while only looking would keep the PC up all day. Under `node --test` nothing is held unless the test sets `setAwakeDeps`.

## 2.74.7

**Older Snapdragons: every first-generation X is recognised and checked against its own model build, the Snapdragons before the X are refused before anything downloads, an X2 can play an X to test the X's code, and a server stopped is waited for until its port is free.**

### What's new

- **npu-vendors.ts, playing an older Snapdragon on a newer one**: `playGeneration(npu, generation)` says whether this NPU can play another generation: `own`, `played` (a Snapdragon playing an older Snapdragon), `values` (an Intel or AMD NPU, or Qualcomm's `unknown`: the starting values alone) or `refused`, with why. `playedRoute(route, played)` gives GenieX a data folder of its own (`playedDataDir`: `{tools}\played\<generation>\geniex`, its `--data-dir` before the command, and `GENIEX_DATADIR`), finds the model and checks its pins there, and gives the embedding server `GGML_HEXAGON_ARCH`, the played Hexagon. `setUpPlayed(played, tools)` writes that folder's `config.json` naming AI Hub's chip (other settings in it kept). `playedSay` says it in a sentence. `LEGACY_SNAPDRAGON` and `GENIEX_DATA_DIR` are exported.
- **npu-check.ts `--generation snapdragon-x`** on a Snapdragon X2 plays the first X whole: AI Hub's X Elite build from that folder, and the embeddings on Hexagon v73 code. The report's `played` says the generation, folder, chip and Hexagon; it's a rehearsal, with no patch. A newer Snapdragon on an older one, or `snapdragon-8cx`, is refused (exit 2, step `play`) before anything is set up.
- **npu-bench.ts `--generation <id>`** plays it the same way. The report's `run.played` (schema: optional) names it, the `played` mark keeps it off the board, and it is never ranked. On any NPU but a Snapdragon it is refused: there it would be another generation's starting values alone.
- npu-vendors.json: each Snapdragon generation's `hexagonArch` (`v73`, `v81`) and `aiHubChipset` (`qualcomm-snapdragon-x-elite`, `qualcomm-snapdragon-x2-elite`), on `NpuGeneration`.

### What changed

- **`npuGeneration` knows every first-generation X by name**: the plain X's and X Plus's part numbers (`X1` and five digits: X124100, X126100, X126101), "Snapdragon X -", alongside `X1E`/`X1P`, "X Elite", "X Plus" and the dev kit's X1E001DE. The X2's names (including E2E94100, X2000096, XG002002, EG102004, XG201032) are tested first. A name that doesn't say which Snapdragon is told by its ACPI device id, in npu-vendors.json's new `devices.qualcomm`: `0D0A` and `0D19` the X, `0FF0`, `104F` and `1050` the X2. Where both say, the name wins.
- **The Snapdragons before the X are refused**: a new generation, `snapdragon-8cx` (8cx Gen 1 to 3, 8c, 7c and 7c+, SQ1 to SQ3, 850, 835, and a Hexagon seen only by its driver on the older `npu|` line), `supported: false`, with its reason in plain words. Before, such a PC was tried on guessed values and downloaded GenieX and its 4.4 GB model before its test request could fail. A Snapdragon newer than setup knows is still tried on guessed values.
- **The X Elite's model build is pinned** (`pinned["snapdragon-x"]`, six files), so setup on an X checks GenieX's pull of it file by file, as on the X2.
- npu-check.ts: an unknown Snapdragon's line now points to `devices.qualcomm` by its ACPI id, where its name doesn't say.
- **A server stopped is gone only once its port refuses a connection** (npu-server.ts' `refusedConnection`, which `listening`, `untilGone`, `stopStartedAt` and the NPU check's own waits now use). Before, any failed request counted as gone, a timeout included. GenieX killed on the X2 Elite was gone in 71 ms, but its port stayed bound about 2 s: requests timed out for the first second, then were reset. The benchmark's start again came too soon, GenieX couldn't bind its port ("Only one usage of each socket address"), and the cached load failed with "no correct answer".
- Spec: NPU-VENDORS.md (Detection, The Snapdragons before the X, Playing an older Snapdragon on a newer one, Verified and not), NPU-BENCHMARK.md (`--generation`, `run.played`).

### For an agent

- Nothing to do: take the kit and release as usual. Setup on a first-generation X now reads and checks the model's six files (4.3 GB) after its pull, as it does on an X2.

## 2.74.6

**Paced checks get the share Manor's checksPace gives them, not the agent's gentle cap too, and a test's own waits stretch with the pace: a test takes longer instead of failing. An AMD NPU of a generation nobody has measured gets a 35 s base, not 90 s, and Intel's other NPUs get prompt settings estimated from the NPU 3720, their prefix cache off.**

### What's new

- **checks-pace.ts**: a paced command is told how much slower it runs, in `KIT_CHECKS_SLOWER` (`CHECKS_SLOWER_ENV`): its `pacedSlower`, 4 at a third of the processor or more. Under `nice` (off Windows), 4. `checksSlower(env)` reads it (1 when unpaced, 50 at most), and `paced(ms)` stretches a test's own wait or timeout by it. A run's time limit was already stretched that way since 2.74.2; the timeouts a test sets itself weren't, so at the pace a 400 ms timeout or a 10 s wait failed with nothing wrong (the Steward's whole suite before kit 2.74.5's release, twice, 2026-10-15).

### What changed

- **checks-pace.cs**: the launcher starts the command out of the agent's own gentle job (`CREATE_BREAKAWAY_FROM_JOB`, which gentle.cs allows), then puts it in the checks job, as before. Before, a command an agent with the gentle pace started stayed in that agent's job too, so the gentle cap held it as well: two processors' worth, 11% of an 18-thread PC, whatever Manor's checksPace said (66% there on 2026-10-15). Where Windows refuses (a job that doesn't let it leave), it starts in the jobs it is in, as before. The launcher's source changed, so each PC compiles it again once.
- The kit's own tests (kit/test): `until` waits its time stretched by the pace, and `paced` is exported beside it. The accelerators, console, card-on-demand, page and NPU-check tests stretch their own waits and timeouts. A test that shows something taking longer than a timeout stretches both, so the one stays longer than the other.
- **`calibrate`** takes a full-cap read at the route's `readPerWrite` times the writing speed it measured, else `CALIBRATION.readPerWrite` (10) as before. npu-vendors.json's amd route says 30: FastFlowLM read 34 to 36 times faster than it wrote on a Krackan (472 to 512 tokens a second read, 13.1 to 14.4 written). On the Krackan's `--harden` measurement, that gives a 35 s base where 10 gave 90 s. It applies only where setup calibrates, on an AMD generation nobody has measured; XDNA 2 is verified and keeps its own timeouts. Intel's and Qualcomm's routes are unchanged.
- **spec/NPU-VENDORS.md and the amd route's notes** have the Krackan's run on battery. `npu-bench --profile full --energy` gave 20.7 mJ a token (6.6 W at rest, 11.6 W working), 13.1 tokens written a second against 14.4 on mains power, and a model load of 12.7 s against 5.4 s; the idle stop's rule still gives 5 minutes for chat. FastFlowLM's four `--pmode` values did the same jobs in the same time on battery, and none drew clearly less than the battery meter's own swing (several watts at rest from one run to the next), so the route starts FastFlowLM without one, as before. Whether a power mode saves less than such a meter can tell stays unverified.
- **spec/NPU-VENDORS.md** has `npu-check --harden` run again on the Krackan with kit 2.74.5, whose test request asks about the picture first: calibration timed chat warm in 1.31 s (9.18 s before, the switch back from the vision model) and wrote a 90 s base, not 105 s. Most of the 90 s was calibrate's reading estimate, a tenth of writing speed; with the route's `readPerWrite` (above), the same measurement gives 35 s.
- **spec/NPU-VENDORS.md and the amd route's notes** have FastFlowLM's picture size (`--img-pre-resize`) measured. At its default, a height of 720, a desktop screen costs 960 tokens and 4.5 s an answer and a phone screen 270 tokens and 2.3 s, every answer right, including Reeve's own questions about a screen. The original size costs 2 to 10 times the tokens for nothing more right, and 480 misreads small text, so the route keeps the default. FastFlowLM keeps no prefix cache: each question about a picture reads all of it again.
- **npu-vendors.json's Intel generations** (spec/NPU-VENDORS.md, Estimated). No Intel NPU beyond the Lunar Lake and the NPU 3720 will be run, so the others are estimated from the NPU 3720's sweep, scaled by the Lunar Lake's numbers.
  - **`lunar-lake` and `panther-lake`**: `--plugin_config` `{"NPUW_LLM_PREFILL_CHUNK_SIZE":"512","GENERATE_HINT":"BEST_PERF"}`. That should be a short answer in 0.3–0.4 s rather than 0.72 s, and the jobs' prompts read 18–27% faster; on the NPU 3720 at their 4,096-token cap, 512 read about 3,500 tokens fastest too. The Lunar Lake's other values are as measured.
  - **`wildcat-lake`**: the NPU 3720's settings: 2,048-token cap, 128-token chunks, `BEST_PERF`, 3.8 GB. Its NPU 5 is 15–17 TOPS, about 1.4 times the NPU 3720, in laptops of 8 to 16 GB.
- **The prefix cache is off on every Intel NPU** (`--enable_prefix_caching false` in the route's command), from 11 quick benchmarks on the NPU 3720 on `castellan-npu-bench/2`, whose prompts no cache has seen. The agents' prompts share only 25–90 tokens at their start, less than one 128-token block, so it is hardly ever hit, and when nothing hits it costs. With it off the NPU 3720 read 2–5% faster, did the jobs in 27.25–27.48 s against 27.67–28.01 with #261's 32 blocks, and held 3.72 GB against 4.30 (5.98 with OpenVINO Model Server's own 128). So `meteor-lake` and `arrow-lake` drop the block count from `--plugin_config`, and their `memoryGb.chat` is 3.8, down from 4.3. `--plugin_config` can't turn it off: OpenVINO Model Server refuses `NPUW_LLM_ENABLE_PREFIX_CACHING` there as doubled.
- **Intel's `idleStop`**: the NPU check's `--idle` passed on the NPU 3720, every step, with this command. Chat started from its compile cache in 6.85 s and embeddings in 2.74 s, against the 4 s measured on the Lunar Lake and assumed for embeddings. `coldStartMs` is now 6,900 and 2,800, so a person waking it is told about 7 s for chat. The minutes stay 5.
- **npu-check.ts's `routeOnDevice`** drops `--enable_prefix_caching` off the NPU with the other NPU-only flags, so the graphics card and processor keep OpenVINO's own caching.

### For an agent

- Nothing to do: take the kit and release as usual.
- A test of the agent's own that waits for something or sets a short timeout can use `paced(ms)` from `src/kit/checks-pace.ts`, so the checks pace makes it slower, never failing. It stretches only under a paced run (the Steward's vouch and merge checks, the Assayer's): run by hand it waits as written.
- A PC already set up keeps the timeouts measured on it. Setup's next calibration on an AMD generation nobody has measured uses the new estimate.
- On a Lunar Lake or NPU 3720 already set up, the NPU refresh (2.74.5) tries the new command as the agent pins this kit. It compiles the model once more, for about a minute or a minute and a half. It keeps the old command if the new one doesn't answer properly.

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
