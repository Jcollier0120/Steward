<img src="art/icon.svg" width="40" align="left" alt="">

# Steward

Keeps the essentials every agent shares, and brings each update to all of them at once.

The *steward* ran the household for its lord: he kept the keys, saw that every servant had what the work needed, and carried the lord's orders to each of them. Its mark is a ring of keys.

One of the agents employed at Manor, the home of the local agents on this PC: the senior employee. Its page is http://steward.localhost:19494/.

The hires (Porter, Auditor, Clerk, Herald, Warrener, Aletaster, Miller and Pinder) each carried a copy of the same kit: the page and its server, Settings, install and release, the accelerators and the NPU queue. A change to it meant the same PR in eight repositories. The Steward keeps that kit once, in this repository, and rolls each new version out to every employee: one command, or one button, per stage, each reporting per employee.

## The kit

The kit lives in `kit\`, versioned by `kit\VERSION` (2.0.0) with `kit\CHANGELOG.md`. It comes in **parts**, and an agent takes the ones that fit it:

| Part | In the kit | In a Node agent | What |
|---|---|---|---|
| `core` | `kit\core\` | `src\kit\core\` | Every rule the agents share, written once ([below](#one-core-two-drivers)): plain JavaScript (ES2022 modules, typed with JSDoc, a `.d.ts` beside each), with no I/O. node and dotnet bring it. |
| `node` | `kit\node\` | `src\kit\` | The TypeScript modules: accelerator-config.ts, accelerators.ts, agent-checks.ts, detect.ts, duty.ts, gpu-load.ps1, install.ts, keeper.ts, lock.ts, look.ts, manor.ts, minify.ts, net.ts, notes.ts, npu-queue.ts, npu.ts, page.ts, ps.ts, release.ts, rules.ts, schedule.ts, server.ts, service.ts, settings-kit.ts, setup.ts, store.ts, themes.ts, work.ts. keeper.ts, setup.ts, detect.ts and accelerator-config.ts keep the model servers and own config.json's accelerators: the Smith runs them, and Reeve where there is no Smith. The queue, the lock and the accelerators are the core's rules, carried out with Node's fs and timers. page.ts draws every agent's page in Heiward's look (the manor's themes: Windows 11's Light and Dark and six colour themes, the manor's own when Manor is installed; a title bar with a status pill, which stays at the top as the page scrolls; its panel the width of the window, with no column of its own for text), net.ts says whether this PC is online, so what fails only because it is offline is waited out, never an alarm (spec/OFFLINE.md), and look.ts gives each agent its own colour and a small scene in its title bar that moves while a round runs. |
| `web` | `kit\web\` | `src\kit\web\` | Browser files any agent's page can use, whatever its server: settings-panel.js and settings-panel.css, and the manor's themes, themes.css (every theme's colours) and themes.json (the list the Theme menus show), which page.ts puts in every kit page and Manor carries a copy of. A page includes them as plain files; the panel needs an element with `data-settings-panel`, a `<meta name="page-token">`, and `GET`/`POST /api/settings` on its own origin. |
| `spec` | `kit\spec\` | `src\kit\spec\` | The language-neutral rules: [NPU-QUEUE.md](kit/spec/NPU-QUEUE.md) (was Reeve's), [ACCELERATORS.md](kit/spec/ACCELERATORS.md) (was Manor's), [ROUND.md](kit/spec/ROUND.md) (round.json, each round's outcome), [RELEASE-NOTES.md](kit/spec/RELEASE-NOTES.md) (each repository's CHANGELOG.md, which a release's notes are made from), rules.json (the timings and limits, as data, which the core takes), and the vectors every implementation runs: npu-queue-vectors.json (the queue), turn-vectors.json (a turn, step by step) and accelerator-vectors.json. This is now their home. The core brings it. |
| `dotnet` | `kit\dotnet\` | (a .NET agent: `kit\dotnet\`) | C# source a .NET project compiles by importing `Steward.Kit.props`: the core run in Jint, and its turns, locks and failure markers carried out with .NET and Win32. Heiward's. |

`kit\test\` holds the kit's own tests, which run here against a fixture agent (`kit\test\fixture`, the smallest agent the kit runs in), and the dotnet part's (`kit\test\dotnet`). Agents don't get them; each runs only its own tests, and the kit's checks of itself (below).

### One core, two drivers

All the shared decision logic is the **core**: the ticket order and the late, dead and aged rules, a lock holder's eviction, the turn and the plain lock as a state machine, reading, checking and auto-ordering Reeve's accelerator config, the candidates and the pick, failure-marker expiry, games-busy, the id slug, a request's size, and the messages. It reads no file and has no clock or randomness of its own, so it gives the same answer in any engine: a driver hands it what it read and the time, and does what it says.

- **The turn** is `startTurn(rules, options)`, then `step(state, observation)` until it ends: each step is the actions to take in order (`mkdirs`, `write`, `touch`, `list`, `alive`, `remove`, `mkdir`, `read`, `stat`, `rmdir`, `note`, with paths as names below the locks folder), how long to wait after them, and, once it has, how it ended (`held`, `timeout`, `full`, `io`). The driver performs them, waits, and calls `step` with the clock and each action's result. `release(state, now)` lets go the same way. A state is plain data.
- **The timings and limits** are data, `spec\rules.json`, which a driver reads once and passes to the core (`checkRules`).
- **The node part** carries it out with Node's fs and timers, and stays async, so a turn never blocks an agent's server. Its modules keep 1.0.0's boundaries and exports, so the hires' imports didn't change.
- **The dotnet part** carries it out with .NET and Win32 I/O, running the core's JavaScript in [Jint](https://github.com/sebastienros/jint) (4.16.4, pinned in `Steward.Kit.props`), a JavaScript interpreter written in C#: no native code, so it runs on x64 and Arm64, in a Store package and in a self-contained or single-file exe, trimmed too. The core's modules and rules.json are embedded in the assembly, and values cross as JSON text, with no reflection. `KitCore.Shared` hosts it (thread-safe); `AcceleratorLock.Acquire` takes a turn, blocking or async; `FailureMarkers` reads, writes and clears markers in any folder.
- **The vectors** in `spec\` run against the core directly and through each driver: here, `kit\test\vectors.test.ts` (the core, the node part) and `kit\test\dotnet` (the core in Jint, the dotnet part). Reeve's npu-embed/npu_lock.py, a Python implementation of the lock, runs npu-queue-vectors.json.

A logic change is one edit to the core; only a new kind of action touches the drivers. WebAssembly was considered and rejected: it needs another toolchain and a native runtime in C#, and gains nothing over JavaScript, which the TypeScript agents already run.

### The agent interface

What the kit needs from the agent it sits in, kept small:

- **`src/app.ts`** exports `APP` (`id`, `name`, `role`, `version`), `appRoot`, `devCheckout`, `dataDir`, `port`, `pageUrl` and `HOST_NAME`. The kit imports it as `../app.ts`.
- **`src/settings.ts`** exports `SETTINGS_SPEC`, the agent's settings for the kit's Settings panel. Only agent-checks.ts imports it (as `../settings.ts`); the agent hands it to `serve()` itself.
- **`src/cli.ts`** is the entry point: install's sign-in task runs `src\cli.ts open`, and `serve` runs the page.
- **`art/icon.svg`**, which the page serves as `/favicon.svg` and Manor shows.
- **`package.json`**: its `name` is `APP.id` and its `version` is `APP.version` (release.ts checks it); and **`kit.json`**.

`agent-checks.ts` checks all of it: each agent's `test/agent.test.ts` is one line, `import '../src/kit/agent-checks.ts';`, and fails when the agent and the kit disagree (its schema and defaults too, as each hire's settings-kit.test.ts used to check).

### With Manor: manor.ts

An agent works at a manor when Manor is installed here: its folder (`MANOR_HOME`, else `%USERPROFILE%\.manor`) has `settings.json` and `app`. `manorLink()` reads that settings.json afresh each time, as Manor does, and is null without Manor. It gives:

- **Manor's name, port and page**, for the title bar's "Back to <manor>", with Manor's icon served from the agent's own address as `/manor-icon.svg` (`manorIcon()`).
- **The manor's theme**, which page.ts stamps on `<html data-theme>`; the agent's Theme menu then says it's Manor's, with a link to change it there.
- **Its Developer options** (kit 2.5.0): `"developerOptions"`, the switch on Manor's Settings page that holds or vacates the developer roles, or null when Manor hasn't said. An agent with developer features of its own asks `developerOptions(ownSwitch)` on each page load and each round: `{ on, setBy }`, where Manor's value wins when it says (`setBy` is Manor), else the agent's own switch. While `setBy` is set, the agent shows page.ts's `developerOptionsNote(setBy)` in place of its own switch: "<manor>'s Developer options set this", with "Change it in <manor>" to Manor's Settings (`manorSettingsUrl()`, its page at `#/settings`). Without Manor, or before Manor says, its own switch works as ever. No hire has developer options yet; Heiward, whose page isn't the kit's, follows the same key itself.

**Non-employee projects** (kit 2.18.0): `manorProjects()` gives the repositories this PC's manor looks after without employing them: Manor's settings.json `"projects"` (its Settings page's Non-employee projects), checked, or none without Manor. Each is `{ name, checkout, repo, branch, test, versionFiles, cleanBranches }`: `repo` owner/name or null, `branch` "main" unless said, `test` a command run in the checkout or null, `versionFiles` the files the Wright sets the version in (empty: the manor never changes its version), `cleanBranches` whether Reeve deletes branches already merged into `branch` (true unless said). An agent that cleans up and fixes repositories works on them as well as on the staff, and never as staff: no kit, no Steward, no merge or release. The rules are `projectsFrom(raw, own, problems)`, which Manor's own settings use too, so the two agree: an entry whose repository or clone's origin is the manor's own, or whose checkout is, is inside or holds one of the Steward's employees' checkouts (`manorOwn()`), is left out.

### What the ping says

Every kit agent's `GET /api/ping` answers what Manor needs to show it without starting anything: `app`, `name`, `version`, `pid`, `running` (on duty), and from kit 2.9.0 `stoppedSince` (when it went off duty, null while on) and `summary` ("On duty.", or "Off duty since 2 hours ago: its scheduled rounds are paused."), the same words as `status --json`; then its rounds (`lastRunAt`, `lastRunOk`, `nextRunAt`, `runningSince`, `rounds`) and the agent's own fields. So Manor runs an agent's status command only when its page doesn't answer.

### What the kit leaves in the data folder: round.json

Each round an agent runs with schedule.ts's `every()` leaves its outcome in `round.json` in the agent's data folder (kit 2.8.0), the same in every agent, so the Surveyor reads one file per agent: `{ "rounds": { "<name>": { "started", "finished", "ok", "error", "everyMs", "next" } } }`, one entry per schedule by its `name` ("round" unless said). [spec/ROUND.md](kit/spec/ROUND.md) says the shape and when it is written. A round.json that can't be written never fails the round. The node part only, for now: the dotnet part has no scheduler.

### kit.json, and filling src\kit

Each agent pins one exact kit version and its parts in `kit.json`:

```json
{
  "kit": "2.0.0",
  "parts": ["node", "web", "spec"]
}
```

**A part brings the parts it needs**, whatever kit.json names: `node` brings `core`, `core` brings `spec` (its rules.json), `dotnet` brings `core`. So a hire's pin names the three it always did, and gets four. A kit from before 2.0.0 has no core, and then none is filled. `src\kit\PARTS` still says the parts kit.json pins, and tools/kit.ts's line says what it filled.

Its `src\kit\` is git-ignored and filled by `tools/kit.ts`, the one shared file left in each repository: small, dependency-free, the same in every agent. This repository's `tools/kit.ts` is the canonical one, and `bump` hands it out with each new pin (below), so a change to it reaches every agent as a kit change does. `npm run kit` runs it, and so does every npm script that runs the kit: `pretest`, `pretypecheck`, `prestart`, `prestop`, `prestatus` and `preopen`, and `serve` and `release` before their command. So a fresh clone works whichever it runs first. It writes `src\kit\VERSION` (and `PARTS`), and does nothing when they already match the pin. Otherwise it takes the pinned version from the first of:

1. `--from <dir>`, or the `STEWARD_KIT` environment variable: a kit tree on this PC, such as a Steward checkout's `kit\`, copied every time. For development; it warns when the tree's version isn't the pinned one, and a release refuses that.
2. A sibling checkout, `..\Steward\kit`, when its VERSION is the pinned one: with the default checkouts, `C:\Projects\<Name>`, that is `C:\Projects\Steward\kit`.
3. `%USERPROFILE%\.steward\kits\<version>`, the cache.
4. The kit release: `https://github.com/Jcollier0120/Steward/releases/download/kit-v<version>/kit-<version>.zip` and its `SHA256SUMS.txt`, over plain HTTPS with no sign-in (the repository is public), or through `gh release download` if that fails. The zip is checked against SHA256SUMS.txt, unpacked with Windows' own tar.exe, and kept in the cache.

An agent's release (`src/kit/release.ts`, `npm run release`) carries `src\kit\`, with `kit.json` and `tools/kit.ts`, and its release.json says `"kit": "2.0.0"`. It refuses to build when `src\kit\VERSION` isn't the pinned version. So an installed agent needs neither the Steward nor GitHub. An agent that announces itself to every Manor (Manor's "New agents, announced on GitHub") keeps `manor-agent.json` at its root: the release copies it beside the zip, lists it in SHA256SUMS.txt and publishes it with the zip, and refuses to build when its `agent.id` isn't the agent's, its `release.repo` isn't origin's, or it isn't otherwise one Manor would take (a Node release, installed in `%USERPROFILE%\.<id>\app`).

**A fresh clone of a hire builds** with `npm install`, `npm run kit` and `npm test`. `npm run kit` needs one of the sources above: the kit release on GitHub (no sign-in once this repository is public; `gh`, signed in, while it's private), or a Steward checkout beside the hire.

### How the kit was found

`tools/kit-from.ts` compares the hires' trees (CRLF made LF) and, with `--write`, lays the shared files out as the kit, their imports rewritten for their new places. Kit 1.0.0 was seeded from the eight hires' `release-0.3.1` branches, each checked out on its own: the commit "The kit, seeded from the eight hires' common files" is its output, the hires' code only moved (into `kit\src`, before the kit had parts), and the next commit holds 1.0.0's changes. Run today, with Manor's newer settings kit as an overlay, it writes the parts layout (each `<…>` a checkout's folder):

```powershell
node tools/kit-from.ts --from <Porter>,<Auditor>,<Clerk>,<Herald>,<Warrener>,<Aletaster>,<Miller>,<Pinder> `
  --overlay "src/settings-kit.ts=<Manor>\src\settings-kit.ts,src/settings-panel.js=<Manor>\web\settings-panel.js" --write
```

What it found, across 150 files:

| | Files |
|---|---|
| **The same in all eight: the kit** (20) | src/accelerators.ts, duty.ts, gpu-load.ps1, install.ts, lock.ts, npu-queue.ts, npu.ts, page.ts, ps.ts, schedule.ts, server.ts, service.ts, settings-kit.ts, settings-panel.js, store.ts; tools/release.ts; test/accelerators.test.ts, install.test.ts, npu-queue-vectors.json, settings-kit.test.ts |
| **The same but for the agent's name** (2) | test/kit.test.ts (its `PORTER_HOME`, `porter-test-`) and test/npu-queue.test.ts (its temp prefix). They test only kit code, so they joined the kit's tests, with the fixture's name. |
| **Near-identical** (1) | src/cli.ts: the same in six; the Auditor's adds `audit`, the Clerk's `search`. Left per agent (see Next). |
| **The same, but the project's own** (2) | .gitignore and tsconfig.json: left with each agent, which may need its own. |
| **Per agent** (125) | app.ts, settings.ts, view.ts, agent.ts and each agent's own logic, tests and fixtures; README, package.json, package-lock.json, art\icon.svg. |

`node tools/kit-from.ts --from <dirs>` without `--write` only reports: after 1.0.0 the kit changes in `kit\`, and a re-run with `--write` would put the hires' old copies back.

## Kit releases

A kit version is released once, as **`kit-v<version>`** in this repository, with `kit-<version>.zip` (VERSION, CHANGELOG.md and the parts, `core\` and `dotnet\` too, from `kit\` at HEAD through `git archive`, never the tests) and `SHA256SUMS.txt`. Its notes are the changelog's entry. `npm run kit-release` builds them into `artifacts\kit\`; `npm run kit-release -- --publish` makes the release, from a committed and pushed tree, and refuses a version already released.

The Steward's own releases stay **`v<version>`** (`npm run release`), and are separate: a kit release needs no Steward release, and a kit release is never marked Latest. On duty, the round makes both itself when main carries a version that has none (Page and commands, "Its own releases"). What changed in each Steward version is in [CHANGELOG.md](CHANGELOG.md).

## Making a kit change

1. Edit `kit\` (and its tests in `kit\test\`), or `tools/kit.ts`, raise `kit\VERSION`, add its entry to `kit\CHANGELOG.md`, and set this repository's own `kit.json` to the new version (a test checks they agree). `npm test` runs the kit's tests on the fixture, tools/kit.ts's, and the vectors against the core and the node part; then the dotnet part's, when a .NET 10 SDK is found (`npm run test:dotnet` runs those alone, and fails without one).
   - **A rule** is a change to `kit\core\`. `npm run core-types` then writes its `.d.ts` again (a test says when they're stale), and `npm run vectors` writes turn-vectors.json and accelerator-vectors.json from the scenarios in `kit\test\*-scenarios.ts`: their diff is the change in behaviour, for review. A timing or a limit is a change to `kit\spec\rules.json`.
   - **The dotnet part**: `npm run test:dotnet-publish` publishes it as Heiward does (self-contained, single-file or not, Arm64 and x64) and trimmed, and runs each exe. Jint's version is pinned in `kit\dotnet\Steward.Kit.props`.
2. To try it in an agent before releasing it: `node tools/kit.ts --from ..\Steward\kit` there, or `steward bump --kit-from kit` (below).
3. PR it to the Steward, with the Steward's own version raised too, and merge it.
4. Release it: `npm run kit-release -- --publish`, then the Steward's own `npm run release -- --publish`. On duty, the round does both by itself once the change is on main (below, "Its own releases").
5. Roll it out, a stage at a time: `bump`, `push`, `merge`, `release`. On duty, the round does that by itself too, once Manor has installed the Steward release that carries the kit (below, "The rollout in a round").

## The rollout

Each stage is a command and a button on the page (each asks first, and only the ticked employees are touched). Each reports for every employee (done, skipped, refused or failed, and why), and the page shows the last stage's results and log. Stages run one at a time on this PC: a lock in the data folder keeps the page and a terminal apart. On duty it also does them by itself, in its round: it bumps and pushes a new kit to each employee behind it, then merges and releases (Page and commands, below).

1. **`steward bump [--kit <version>] [--employees a,b]`**: for each employee that takes the kit, a fresh git worktree of its branch on origin (fetched first), on the branch `steward/kit-<version>`, in the work folder (`%USERPROFILE%\.steward\work\<id>`). Never the person's own checkout. There `kit.json`'s pin moves to the kit, `tools/kit.ts` becomes the Steward's when it differs (for an agent whose kit is filled by it), and the patch version goes up in every version file (package.json, both of package-lock.json's own entries, and src/app.ts, which release.ts requires to agree). Then, for a Node agent, its packages: the worktree's `node_modules` is a junction to the set installed once for its lockfile in the work folder's `_modules` (`src/stages/modules.ts`: keyed by the lockfile's packages, its own name and version aside, so the hires share one set; `npm ci` runs there once per set, with the project's own scripts left out; the six sets most lately used are kept), or `npm ci` in the worktree if that can't be done. Removing a worktree removes the link, never the packages. Its kit is filled with the new tools/kit.ts, and its checks run (`npx tsc -p . --noEmit` and `npm test` for a hire). When every one passes, the changes are committed: "Porter 0.4.1: the Steward's kit 1.0.1". The Steward's tools/kit.ts is its checkout's, or, installed, the one its release carries. Checks that fail are run once more, as a PR's are here (a round bumps several employees at once, and a test that keeps time can fail under that load): a pass the second time is committed, and says so ("checks passed on a second try (the first: …)"). Failing twice leaves the worktree for a look, with the failed step's whole output beside it (`work\<id>.log`), and the failure names the tests that failed and their errors, read from `node --test`'s output (`npm test failed (exit 1): "its name" (its error), twice`), so the alarm says what broke. `--kit` defaults to the newest kit release; one that isn't released is refused, since the employees couldn't fetch it, unless `--kit-from <kit folder>` fills from a kit tree instead (for a trial). `--base <ref>` starts from a local ref instead of origin's branch. A bump made before and not pushed is made again from scratch; one already on origin is refused until its PR is merged or closed. A bump a person asks for (the button, or the command) also lets the rounds try again an employee whose rollout failed in a round (below).
2. **`steward push`**: each prepared branch is pushed (a plain push, never forced) and gets a PR against the employee's branch, titled "Porter 0.4.1: the Steward's kit 1.0.1", its body the changelog's entries since the kit it had. A PR already open is left as it is. Like Bump, a person's Push lets the rounds try a failed rollout again.
3. **`steward merge [--yes] [--team]`**: the Steward's open PRs (head `steward/…`, a branch of the employee's repository itself, never a fork's), with their checks and whether they merge. With `--yes` (or the page's button, which asks first), those that merge cleanly into the employee's branch, aren't drafts, and have no failing or running checks (none counts as green; the hires have no CI) are merged with a merge commit and their branch deleted (`gh pr merge --merge --delete-branch`), and the Steward's worktree for each is removed. The rest wait, and say why. With "Release right after merging" on in Settings, release follows for the merged.

   **`--team`** (the page's **Merge the team's PRs**) takes the team's open PRs as well: those opened by one of the GitHub accounts in Settings' **Team**, from any branch. By default that is `Jcollier0120`, you, which covers Claude Code too, since it opens its PRs with your account. They wait and merge by the same rules, and only into the employee's branch: a PR stacked on another branch waits for that one. A team member's branch is theirs, so it isn't deleted (it may still be checked out in a worktree). `--team` covers an employee that doesn't take the kit yet too: merging has nothing to do with the kit. A PR anyone else opened is never merged, nor listed.

   **A team PR that isn't a draft is ready to merge**: that is the team's rule. A person or a session that wants a PR reviewed first (by you, or the session coordinating the rollouts) **opens it as a draft**, and marks it ready once reviewed. Since no one asked for a team PR here, it is held to more than the Steward's own, which their bump tested:
   - **Tested here when GitHub runs no checks on it.** Reeve and the hires have no CI, so the Steward runs the employee's own checks (Settings, as bump runs them: its packages for a Node agent, linked from the shared set, its kit filled, then each test command: the typecheck and `npm test` for a hire, `dotnet test` for Heiward) at the PR's head commit, in a worktree of its own, before it merges it. The result is kept by commit (`pr-checks.json`): a failure is tried once more at once, so one flaky test doesn't hold a PR ("checks passed here at abc1234 on a second try (the first: …)"); one that fails twice is said once, as a failed merge, and the PR then waits quietly until a new push is tested afresh, or until its branch moves on (then it is caught up, below); a pass is said with the merge ("merged #17 (checks passed here at abc1234)"). A PR whose CI passes on GitHub isn't tested again here. Only the team's PRs are tested here, so only code from your own accounts runs on this PC this way.
   - **The version it sets must be new.** A team PR that changes the version waits when that version is already released, isn't above the version on its branch, or is the one another ready PR sets too (both wait: "#17 and #20 both set v0.3.9: each needs a version of its own"), so a merge never leaves a version conflict behind, and two changes never share a version. After a merge in the same run, the next PR is checked again against the branch as it is then.
   - **Caught up when only its branch moved.** In a round, after the merges, a ready team PR from the repository itself (never a fork's, never a draft) that waits only because its branch moved on is caught up (`src/stages/catchup.ts`): one that conflicts with its branch or is behind it, whose version is no longer new, or whose checks failed here before the branch moved on. The Steward merges the branch into it (a merge commit on top: nothing of the PR's is rewritten), resolving a conflict only in a version file and only where one side changed nothing but versions, or in `CHANGELOG.md` where each side only added an entry at its top (the branch's entries kept, the PR's put above them under the version it ends up with); gives it the next free version when its own is taken (released, not above the branch's, or another PR's; the first of two that clash keeps its own); pushes that to the PR's branch; fixes the version in its title; and says what it did in a comment. The next round tests it at its new head and merges it. Any other conflict goes back to whoever wrote the PR (`src/stages/kickback.ts`), the branch untouched: **the Wright's** (labelled `wright`, or a `wright/…` branch) is closed, its branch kept, and the issue it closes queued for the Wright again (its `wright:done` label removed), so the Wright does it afresh from the branch as it is then; **a Claude Code session's** (`claude/…`) and **anyone else's** gets a comment that names the files and asks for the branch to be merged in and pushed (the desktop app's Auto-fix wakes a session that has it on). Each is sent back once for a PR's head and its branch's (`kickbacks.json`); the round says where ("it conflicts with main in src/view.ts: back with the Claude Code session that opened it, in a comment on it"), and the PR's hold says so until it is fixed. Settings' `catchUp` switches it off.

     **The Steward's own kit PRs** (`steward/kit-…`) are caught up by the same rules (a team PR that took their version, say), since no one else would: the branch merged in, a conflict resolved only in the version lines, the next free version. No one tests the Steward's PRs on their way in, so its kit is filled again and the employee's checks run (as its bump ran them) before the push; one whose checks then fail isn't pushed, and says why. A kit PR that conflicts beyond its version files isn't left for a person: the Steward closes it, with a comment, and deletes its branch, and the next round's rollout, seeing the employee still behind the kit with no kit PR open, bumps it again from its branch's head.

   **After merging: what a PR asks for.** A PR says what it needs once merged in a fenced block in its description, which the Steward reads, checks before merging, and runs after, reporting each step per employee with the merge:

   ````markdown
   ```steward
   {"after": ["release", "install", "approve-jobs"], "jobs": ["aletaster-orders"]}
   ```
   ````

   The steps are words the Steward knows, never commands: whoever can edit a PR's description chooses among them, not what runs, and each employee's commands are its own, in Settings.
   - **`release`**: the version on its branch, released from the branch as `steward release` does, whatever kit it pins. Before merging, the Steward reads the version the PR would leave on the branch (fetching `refs/pull/<n>/head`), and holds a PR whose version is already released: "raise the version in the PR".
   - **`install`**: its newest release on this PC. The zip is downloaded from GitHub, checked against its `SHA256SUMS.txt`, unpacked in the work folder, its `release.json` checked, and its install command (Settings, `node src/cli.ts install` by default) run there. After a release the PR asked for, only when that release was made. An employee with no install command (Heiward, a Windows app) holds the PR.
   - **`approve-jobs`**, with `jobs` and `install`: each job named is approved in the installed copy, with the employee's approve command (Settings; Reeve's is `node %USERPROFILE%\.reeve\app\src\cli.ts jobs approve {job}`, the others have none), once the PR's install is done. **Merging the PR counts as reading its scripts**: that is your decision, and why the step needs the install, since an approval pins the installed script's sha256, so it is the merged script that runs unattended. A `jobs/*.ps1` the PR changed but didn't name isn't approved, and the result says so. An employee with no approve command holds the PR.

   A block the Steward can't read, two blocks, an unknown step or key, jobs without `approve-jobs` (or the other way round), or `approve-jobs` without `install` hold the PR, and say why: merged without it, what the PR asked for would silently not happen. "Release right after merging" in Settings still releases every merged employee, at the kit the Steward hands out; a PR that asks for a release gets its own.
4. **`steward release`**: for each employee whose branch on origin pins the kit and carries a version with no GitHub release yet, a worktree at that very commit, and its release command run there (`npm run release -- --publish` for a hire), after `npm ci` for a Node agent whose release builds something: Reeve's builds its dashboard with vite. A hire's release (`npm run release`, whose scripts run only `node tools/kit.ts` and `node src/kit/release.ts`) packs its files with Node alone, so it gets no `npm ci` (`releaseNeedsPackages`, read from the employee's package.json; a release command it can't read gets `npm ci`, as every release did before). Releases happen a few employees at a time (Settings' `parallel`). Releases come from the branch, never from a PR's, so a release and its branch never drift apart.

   **The Aletaster tastes it first** (`src/tasting.ts`; Settings' `tasteBeforeRelease`, on by default). Every release (a round's, a merged PR's, the button's) waits, once its commit and version are known and before its worktree is made, for a passing tasting of that very commit. The Steward reads the Aletaster's token from its page (`GET http://127.0.0.1:19191/`, `<meta name="page-token">`), asks `POST /api/taste` with `{repo, commit, version, name, versionFiles, checkout}` (the token in `x-token`, no Origin), and, while the answer says `"state": "running"`, asks `GET /api/taste?id=…` every two seconds for up to 90 seconds. It publishes only when the answer says `"state": "done"` and `"release": true` (a pass; a warning too, unless the Aletaster's own settings say warnings hold), and says so: "released v0.4.13 …; tasted by the Aletaster: pass". Anything else holds the release, with the tasting's reason ("v0.4.13 at 4c1d2e9 waits for the Aletaster's tasting: fail: …") and a link to it, and the next round looks at that employee again, whatever GitHub says. The holds are kept in `tasting-held.json`; one that lasts is an alarm (below). The gate never stalls the manor:
   - **No Aletaster here** (`%USERPROFILE%\.aletaster\app` absent, or `ALETASTER_HOME`'s), or **off duty for Developer options** (Manor's `developerOptions` false, and the Aletaster a developer role in Manor's staff.json): released with "released without a tasting: the Aletaster isn't here".
   - **An Aletaster that predates the tasting** (`POST /api/taste` answers the route's own 404, with no `verdict`, as against the 404 for a repository it doesn't know, which has `"verdict": "not checked"` and holds), or **whose page doesn't answer at all** (no connection, at any step): released, with a note saying which.
   - **The Aletaster's own release** is never held by its tasting, so a broken Aletaster can always be fixed.
5. **`steward staff [--json] [--no-fetch]`**, and the page's table: each employee's checkout and its branch, the version and kit on its branch (and whether its tools/kit.ts is the Steward's), its latest release and the kit that release carries, the open PRs of the Steward and the team (checks, mergeable, and whose), a bump prepared here, and the kit version the Steward hands out (the newest kit release, and this checkout's `kit\VERSION`).

(`status --json` is Manor's command, as every agent's is: the employees' status is `staff`.)

### Old kit files

There are no copies of the kit to drift any more. Instead `staff` and the page flag one of the eight hires whose branch still tracks the old kit at its old paths (`src/npu.ts`, `tools/release.ts`, `test/kit.test.ts` and the rest), and `bump` refuses it: it needs converting first. Only the hires ever carried those copies (`OLD_KIT_HIRES`): Reeve has files of its own at some of the same paths (src/accelerators.ts, src/duty.ts, src/install.ts, tools/release.ts), which are never flagged.

## Converting a hire

`tools/convert.ts <worktree> --version <new>` turns a hire that carries its own copy of the kit into one that takes the Steward's: it removes the 22 old kit files (`git rm`), rewrites the hire's imports to `./kit/…`, ignores `src/kit/`, adds `kit.json`, `tools/kit.ts` and `test/agent.test.ts`, makes npm fill the kit first, raises the version, and points the README at the Steward with a section on the kit. It stages; it commits nothing. It refuses any agent that isn't one of the eight hires, before it removes anything.

The eight hires were converted that way, each on a branch **`steward/use-kit-1.0.0`** from its `release-0.3.1`, each in a worktree of its own, at version 0.4.0, then filled from this checkout's kit, typechecked and tested: all eight pass. Their `main` now has `release-0.3.1` merged, with the same tree, so each branch merges cleanly. Those branches aren't pushed. Until they are merged, each hire's main still carries the old kit, and `bump` refuses it.

## Reeve and Heiward

Both take the kit (`usesKit` in Settings), so every stage covers them as it does the hires.

- **Reeve** (Node, with a React dashboard) takes `node` and `spec` (and node brings the core): the NPU queue and lock, the accelerator ids, and the queue's rules and vectors. The kit's core is now the original of the queue, and Reeve's own src/npu-queue.ts a copy of kit 1.0.0's, until Reeve uses the kit's. Its npu-embed/npu_lock.py stays Python, the lock's one implementation outside the core, and keeps running npu-queue-vectors.json. Its own `src/accelerators.ts` stays: it reads `config.json` as the file's owner, and a test checks that the kit's reading agrees with it. Its version is in package.json, package-lock.json and src/mcp.ts, and its release is `npm run release -- --publish`. It fills its kit with `node tools/kit.ts`, as a hire does. It has no `src/app.ts` or `SETTINGS_SPEC` (its page is its own), so it doesn't run the kit's agent checks.
- **Heiward** (C#/.NET, public, on `master`) takes `spec`: its NpuLock tests run the queue's vectors, so the C# lock follows the same protocol. It fills `kit\` with its own `tools\kit.ps1` (Windows PowerShell 5.1), from the same sources as tools/kit.ts, and its build stops with "run tools\kit.ps1" while the kit isn't filled. Its version is `<VersionPrefix>` in HEI.Agent/HEI.Agent.csproj, its tests `dotnet test HEI.Core.Tests`, its release `powershell -File HEI.Agent\release.ps1 -Publish`. A bump changes only kit.json and the .csproj: no npm, no tools/kit.ts. The Steward runs its commands with a .NET that has an SDK (DOTNET_ROOT, then C:\tools\dotnet10, then Program Files'), since Task Scheduler's PATH finds Program Files' runtime first. From kit 2.0.0 it is to take `dotnet` instead (which brings the core and spec): HEI.Core imports `kit\dotnet\Steward.Kit.props`, and its NpuLock.cs and Accelerators.cs keep their callers and hand their insides to the part (its turns, the ids, the failure markers' rules, files and messages). For that, tools\kit.ps1 brings the parts a part needs, as tools/kit.ts does, laid out as the kit tree is (`kit\core`, `kit\dotnet`, `kit\spec`).

**How a logic change reaches Heiward:** the rule changes in the core (and, for a timing, rules.json), with the vectors that show it, released as a kit version; the Steward's bump moves Heiward's pin, its build embeds the new core, and its tests run the new vectors. No C# changes, unless the core asks for a new kind of action.

## Versions claimed up front

Two pieces of work started side by side on one repository each used to take "the next version" when they began, the same one, and found out when the second conflicted on its way in. Now whoever starts work asks the Steward for its version first (`src/claims.ts`):

```powershell
node %USERPROFILE%\.steward\app\src\cli.ts claim-version porter --branch claude/my-fix --for "the Run now button"
# Porter 0.4.22: yours. Set it in package.json, package-lock.json, src/app.ts.
```

It takes an employee's id, name or `owner/repo` (the Steward's own too), and hands out the next version no one has: above its branch's version on GitHub, every release, every open PR's (by the version in its title), and every live claim. `--minor` for the next minor; `--json` for programs; `--by` says who asks (`claude` unless said). Claims go one at a time under a machine-wide lock, so two workers asking at once get two versions; the same branch asking again gets the same one. `claims` lists them (and `GET /api/versions`); `release-version <employee> <version>` gives one back.

A claim lives until its version is on the branch or overtaken by a release (the work landed), until it is given back, or for three days with no open PR that names it (its branch, or its version in a title); each round prunes them. While it lives, the merge stage holds another PR that sets that version ("it sets v0.4.22, which wright claimed for #7 (wright/7-…): it needs a version of its own") and catches it up to a free one. The Wright claims for each job before its worker starts, and gives the version back when no PR comes of it.

## Install

The Steward installs itself, from a release, as every agent does. In a checkout of this repository:

```powershell
npm run release -- --install     # build a release, and install it
```

Or unpack a release zip anywhere (from GitHub, or `artifacts\steward\` after `npm run release`) and run `node src\cli.ts install` in it.

`install` copies the release to `%USERPROFILE%\.steward\app`; its data stays in `%USERPROFILE%\.steward`. It registers one sign-in task, `\Steward\Home page`, which runs `open` when you sign in, so the page comes back after a restart. Then it starts the page through that task and waits for it. A new install goes on duty. To update, install a newer release the same way.

**An update is on probation** (`src/safeinstall.ts`), since the rounds merge and release the Steward's own changes and Manor installs them with no one watching. Before anything changes, the version it replaces is copied whole to `app.prev`. Once the new one is in place and started, it must answer its ping as the new version, and keep answering, for 90 seconds, and its home page must render. If it doesn't (or the install itself fails once the new copy is in place), it is rolled back at once: its page ended, the new copy set aside as `app.unsafe-<version>` for a look, `app.prev` put back as `app` and started again. That version is flagged in `unsafe-updates.json` and refused, nothing changed, by every install after, so Manor's automatic updates give up on it after their few tries; it's an alarm at once. Dismissing that alarm (or `node src\cli.ts allow-update <version>`) is your look, and allows it again. A newer version installs as usual. An install that changed nothing (the old page wouldn't stop, say) flags nothing and is tried again; a first install, and `--no-start`, have nothing to go back to. `app.prev` stays until the next update, to go back to by hand. `--no-start` installs without starting it, and `--dry-run` says what it would do and changes nothing. `node %USERPROFILE%\.steward\app\src\cli.ts uninstall` ends the page process, deletes the task and removes `app`; `uninstall --purge` also removes the data folder, with the work folder's worktrees (git then lists them as prunable).

A checkout is a development copy, and keeps out of the installed one's way: its data is in `%USERPROFILE%\.steward-dev`, its page is on port 29494, and `install` refuses to run from it. The installed copy has no `kit\` folder: it hands out the newest kit release, or the version named with `--kit`. The details, which every agent shares, are in Manor's INSTALLING.md.

The Steward needs git and `gh` (signed in, with rights to push and merge in the employees' repositories) on this PC, and each employee's checkout where Settings say.

## Page and commands

The page at http://steward.localhost:19494/ shows the kit the Steward hands out, the staff's table, a tick box for each employee (one that doesn't take the kit starts unticked) and a button for each stage, with **Merge the team's PRs** after them, the last stage's results and log, and **Settings**. While a stage runs, the page refreshes itself. The table is made again after each stage (from a fresh glance at GitHub), on **Refresh**, after a round when GitHub says something new of anyone, and when the page is opened more than 10 minutes after it was last made or checked while no rounds run. While the rounds run on duty, each one checks the table against its own glance, so opening the page asks GitHub nothing. `GET /api/ping` answers `{"app":"steward","name":"Steward","version":"0.8.6","pid":…,"running":true,"stoppedSince":null,"summary":"On duty.",…,"busy":false,"stage":null}`, `busy` while a stage runs. Like every agent page, it answers only to its own host names, and its buttons need the token from the page itself.

```powershell
node src/cli.ts bump [--kit <version>] [--employees a,b] [--kit-from <dir>] [--base <ref>]
node src/cli.ts push [--kit <version>] [--employees a,b]
node src/cli.ts merge [--yes] [--team] [--employees a,b]
node src/cli.ts release [--kit <version>] [--employees a,b]
node src/cli.ts round [--employees a,b]   # one round, as it runs by itself on duty (Run now)
node src/cli.ts staff [--json] [--no-fetch]
node src/cli.ts start            # on duty, and its page up (Manor's Start)
node src/cli.ts stop             # off duty (Manor's Stop); the page stays up
node src/cli.ts open             # make sure its page is up, without changing duty
node src/cli.ts shutdown         # end its page process
node src/cli.ts status [--json]  # on duty and working (exit 0) or not (exit 3); --json prints what Manor reads
node src/cli.ts serve            # the page in this window (what start and open run in the background)
node src/cli.ts install          # install this release (see Install); --no-start, --dry-run
node src/cli.ts uninstall        # remove the installed copy and its sign-in task; --purge also its data; --dry-run
```

`--hires` is the same as `--employees`. An unknown option is refused, so a mistyped `--yes` never merges.

Its duty works as the hires' does, and its round is this: **it merges, releases and rolls out by itself.** While it's on duty, and "Merges and releases by itself" is on in Settings (it is, by default), a round comes every 10 minutes ("A round every"), through the kit's `every()`, which pauses off duty:

1. **Merge**, as `merge --yes --team` (with the Steward's own kit PRs caught up as the team's are): every open PR of its own and the team's that is ready (not a draft, merges cleanly into the employee's branch, no failing or running checks; for a team PR, tested here when GitHub runs no checks, and with a new version if it sets one: above) is merged, and then what each asks for after merging is done (release, install, approve-jobs: its steward block, above). A PR that isn't ready waits for a later round.
2. **Release**: every employee whose branch carries a version with no GitHub release yet is released from its branch, whatever kit it pins, as `steward release` would: a PR that raised the version, or a version pushed straight to the branch. Each waits for a passing tasting of its commit from the Aletaster first (Release, above): one the tasting holds says why, and is asked about again next round. A release that fails isn't tried again at the same commit (it's kept in `round-failed.json`): the round says so, and leaves it to you, the Release button or a new commit on the branch.
3. **Its own PRs** (`src/stages/selfmerge.ts`): the team's PRs to the Steward's own repository are merged in the round as an employee's are, after the employees': tested here first (no CI runs on it: `npm run kit`, then `npm run typecheck` and `npm test`, in a worktree of its own), each needing a version of its own, caught up with main or sent back to their author (above). Its releases are step 4's, never the merge stage's, and Manor installs them behind the install's fail-safe (Install, below). Settings' "Merges its own PRs" (`mergeSelf`) switches it off.
4. **Its own releases** (`src/stages/self.ts`), kept apart from the employees', since the Steward's repository isn't an employee's: when the Steward's main on GitHub carries a kit version (`kit\VERSION`) with no `kit-v<version>` release, or a Steward version (package.json's) with no `v<version>` release, the round releases it as a person would, kit first: `node tools/kit.ts --from kit` and `node tools/kit-release.ts --publish` (`npm run kit-release -- --publish`, its kit filled first), then `npm run release -- --publish`. It reads both versions and the releases from its glance at GitHub (below), so it costs no call of its own. Each is made in a fresh worktree of the Steward's checkout (Settings' "The Steward's checkout", `C:\Projects\Steward`) at that very commit of origin/main, in the work folder (`_steward-release`), never your working tree, and the worktree is removed after. Never from a tree with anything uncommitted in it (checked before publishing, and both scripts refuse one too), never a version already released (both scripts refuse that as well), and never a version that isn't above the newest release of its kind: that is left to you. A Steward version waits for its kit's release. A release carries only what is committed on main, never this PC's Settings or data, so an internal agent (the Wright) is never in anything it publishes. A release that fails is an alarm at once, and isn't tried again until a new commit lands on main (`self-failed.json`); a Steward version released tells Manor, as an employee's does (After a release, below), so Manor installs it within minutes. Settings' "Releases its own new versions" (`releaseSelf`) switches it off; a checkout whose origin isn't Settings' "The Steward's repository" is refused.
5. **The rollout in a round** (`src/stages/rollout.ts`): when the newest kit release is newer than the kit an employee's branch pins (kit.json at origin/<branch>), and the employee has no PR of the Steward's for a kit open (`steward/kit-…`) and no bump to that kit that failed at its branch's head, the round runs `bump` and then `push` for it, a few employees at a time (Settings' `parallel`), exactly as the stages do. The PR goes through the later rounds' merge and release like any of the Steward's. One already on the kit (or ahead of it), one with a kit PR open, one without a checkout or a kit.json, and one that doesn't take the kit are left alone. A bump that fails its checks, or a push that fails, is kept in `rollout-failed.json` with the kit and the head it failed at: an alarm at once, its worktree left for a look, and the rounds don't try that kit again until a new commit lands on the employee's branch, or a person presses Bump or Push (or runs `steward bump` / `steward push`). A newer kit is tried at once. **It waits while this Steward carries a kit older than the newest release** (its own kit.json): a bump hands out the Steward's tools/kit.ts, which is the one released with the kit it carries. So a kit change reaches the employees in order: the round releases the kit and the Steward that carries it (step 4), Manor installs that Steward, and its rounds roll the kit out. A kit that waits that way for a day is an alarm. Settings' "Rolls out a new kit by itself" (`rollout`) switches it off: then Bump and Push run only when asked.
5. **Jobs**: an employee with an approve command and an installed copy in Settings (Reeve) has its jobs approved when they are what was merged. A job runs unattended only while its script is approved (Reeve pins its sha256), so an update that changes a script leaves the job waiting: that is how Reeve's `fast-forward`, which keeps every repository's `main`, `master` and release checkouts current, stopped after Reeve 0.4.1. Merged code counts as reviewed, so the round approves a job when its installed script is exactly the one in the commit the installed release was built from (`release.json`), and that commit is merged on the employee's branch on origin, whoever installed it (Manor's auto-update, the Steward, you). Never a development build (`release.json` says dirty), a release built from a commit that isn't merged, or a script that isn't what was merged: that is said once, and left to you. What it approved is kept in `jobs-approved.json`, so each script is approved once, and one you approved yourself stays quiet. The approve command reads the script again, so the round gives it the hash it checked, as `{sha256}`: Reeve's default, `jobs approve {job} --sha256 {sha256}` (Reeve 0.4.3 and later), approves that script or none, reading it once, so a script changed after its check is refused, not approved. For a command without `{sha256}`, the round checks afterwards that what it pinned (Reeve prints the sha256) is what was checked, and a script that changed in between, which can't be unapproved from here, is said loudly, once.

**A round asks GitHub once.** It begins with one `gh api graphql` query (`src/glance.ts`) for every employee at once: each repository's open PRs, with what merge, catch-up and the look at the Wright's drafts read; its branch's head commit; its releases, with the commit each tags; and the Steward's own releases, the kit's among them, with its main's head, `kit\VERSION` and package.json's version (one query per 15 employees). Then it looks again (fetches, reads the version files and kit.json, tests, merges, releases, rolls out) only at the employees whose repository, or whose Settings, changed since the last round that went well for them, or for whom the kit a rollout would bring changed: a new kit release, or this Steward now carrying a newer kit (`src/stages/changes.ts`, kept in `round-seen.json`). The others are "nothing new on GitHub since the last round", and their PRs that waited still wait, for the alarms. Every employee is looked at when the round is asked for (Run now, `steward round`), when GitHub couldn't be asked that way (then each is asked on its own, as before: the kit releases too, so a glance that missed never stalls a rollout), after a round that failed, after an employee's own work failed, and once an hour whatever happened; each of those looks covers the rollout too. So a quiet round is one GitHub query and no git at all. A branch is fetched only when GitHub's head isn't the one the checkout has, and the merges and releases that remain run a few employees at a time (Settings' `parallel`).

**After a release**, the pages in Settings' "Told after a release" are POSTed as their own buttons would be (`src/upkeep.ts`: the token read from the page, the POST with it and no Origin): Manor's update check, so it installs the release within minutes rather than at its next look, up to 6 hours away; and the Aletaster's Run now, so it tastes it. Each has 5 seconds; one that doesn't answer is only a line in the log.

A round with nothing merged, released, bumped, pushed or failed leaves no trace; one that did something is the last stage on the page, and a line in stages.log, as any stage is (the Steward's own releases are its row, "Steward", each line beginning "self:"; a rollout's lines begin "rollout:"). A round passes while a stage runs (the stage lock). **Run now** (`steward round` in a terminal) does one round, on duty or not, looking at every employee. `steward round --employees a,b` leaves the Steward's own releases out. Manor's employee card shows the rounds, from `/api/ping`. With "Merges and releases by itself" off, the stages run only when asked.

### Alarms

After every round, done or not, the Steward lists what needs you: the few things no one in the manor can see to by themselves (`src/alarms.ts`). Code decides each one; no model is asked. A condition becomes an alarm once it has lasted its while:

| Condition | After |
|---|---|
| A PR to an employee that the round holds: a draft no one marked ready, conflicts, failing checks, a version that clashes, a base that isn't the employee's branch | 24 hours (`waitingHours`) |
| A release that failed, which the rounds won't try again at that commit (`round-failed.json`) | at once; handed to the Wright, 24 hours after it was filed (below) |
| A kit's bump or push that failed in a round, which the rounds won't try again until the employee's branch moves (`rollout-failed.json`; while `rollout` is on) | at once; a bump handed to the Wright, 24 hours after it was filed (below) |
| A new kit the rounds can't roll out because the Steward itself carries an older one (no Steward release carries it yet, or Manor hasn't installed it) | 24 hours (`waitingHours`) |
| One of the Steward's own releases that failed, which the rounds won't try again until main moves (`self-failed.json`; while `releaseSelf` is on) | at once |
| The round can't run at all (gh signed out, say) | an hour |
| An update Manor couldn't install (`/api/state`'s updates) | two hours |
| Manor's update checks failing | twelve hours |
| Manor's page not answering | an hour |
| A port two agents claim, one kept for the model servers, or one another program answers on so an agent's page can't start (Manor's `/api/summary` `ports`, Manor 0.4.38 and later), one alarm a port | a quarter of an hour |
| A problem the Surveyor has reported (`/api/survey`; its warnings and notes never count), from when it first saw it | 6 hours (`problemHours`) |
| The Surveyor's page not answering | two hours |
| An issue the Wright got stuck on (`wright:stuck`), its PR that changes what a person reviews (`wright:needs-you`), or Claude Code unusable for it (not found, or not signed in), from its `/api/work` | at once |
| The Wright's page not answering | two hours |
| The Bailiff unable to review (Claude Code not found, or not signed in), or its review of a PR failing twice at one head, from its `/api/reviews` (only where it is installed) | at once |
| The Bailiff's page not answering | two hours |
| A release the Aletaster's tasting holds (`tasting-held.json`; while `tasteBeforeRelease` is on), with its reason and a link to the tasting | 6 hours (`tastingHours`) |
| Each open alert of Reeve's jobs, from his `GET /api/alerts` (where Reeve is installed), as `reeve:<id>` with his title, detail, link and since. An older Reeve without it, or his page down, is quiet: the Surveyor already reports his page down | at once |

**Work the team can do goes to the Wright first** (`src/work.ts`; Settings' `fileWork`, on). An employee's bump to a new kit that failed its checks, its release that failed at a commit, and one of Reeve's alerts that is code work in an employee's repository (a new high or critical security advisory from dependency-health, a failed Maestro flow from maestro-runs, naming the employee) is filed as a `manor:work` issue in that repository: what failed, the end of its output with secrets taken out (`src/redact.ts`), the branch or commit, where the fix goes and what done means. A bump's fix goes on the employee's branch: `steward/kit-<version>` was never pushed, and the Steward makes it afresh from the branch once it moves. Each is filed once, by a hidden marker in its body (`<!-- steward:work:<id> -->`, per employee, kind and kit version or commit), at most three a day (`work-filed.json`), and only in an employee's repository the Wright's `GET /api/work` lists while it takes work, with gh signed in as one of its team; never in one of the PC's other projects the Wright helps with. Its alarm then waits 24 hours (`waitingHours`) from when it was filed, and is raised at once, saying why, when the Wright gets stuck on the issue (`wright:stuck`), its PR for it waits for a person (`wright:needs-you`), the Wright has no queue for that repository, or it couldn't be filed. The Steward's own releases, a push GitHub refused, and Reeve's other alerts (the NPU driver, the test phone, a job that crashed) stay alarms as before.

**One alarm for one crashed Reeve job.** The Surveyor reports a Reeve job that exited non-zero as the problem `agent.reeve.job.<job>`, and Reeve lists the same crash as an open alert whose `job` is that job. While Reeve's alerts name a job, the Surveyor's condition with the id `survey:agent.reeve.job.<job>` is dropped and Reeve's alert stands: his is at once, with the job's own words and link. When Reeve gives no answer, the Surveyor's stays. Reeve raises no notification of his own when Manor and the Steward are installed, so the Steward's is the one for his alerts.

An alarm is raised once, with one Windows notification for all raised in a round (clicking it opens this page), and stays at the top of the page under **Needs you**, and at `GET /api/alarms` for Manor, until its condition clears. **Dismiss** quiets one until it clears and comes back. The Steward never acts on an alarm: it says what it saw and what to do.

**What passed here, for the Surveyor.** `GET /api/tested` lists, for each employee (and the Steward itself), the last 20 commits whose checks passed in one of the Steward's stages, newest first (`src/tested.ts`, `tested.json`): `{"at":…,"keep":20,"employees":{"porter":{"repo":"Jcollier0120/Porter","tested":[{"commit":"<40 hex>","stage":"merge","at":…,"branch":"claude/x","pr":41},…]}}}`. `stage` is `bump` (the commit on `steward/kit-<version>`, before it is pushed), `catch-up` (a kit PR's new head), `merge` (a team PR's head, tested before it merged) or `release` (the commit of the branch a release was built from and published); `branch`, `pr` and `version` are there where they are known. The Surveyor runs every agent's tests again once a day.

### The Wright's drafts

The Wright opens every pull request as a draft, so nothing it wrote merges without a look. In each round the Steward looks at each draft the Wright opened (labelled `wright`, by the team), in code (`src/review.ts`):

- it isn't labelled `wright:needs-you`, the Wright's own word that a person reviews it;
- none of its changed files is one a person reviews: Reeve's job scripts, PowerShell, installers and setup, release tooling, CI, `tools/`, `kit.json`, `.csproj` files (Settings). The files are checked here again, not only trusted from the label;
- it changes no dependencies (package.json's `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, at its head against where it started);
- it changes at most 600 lines (Settings).

One that passes is marked ready, with a comment saying what was looked at, and goes on as any ready team PR: tested here at its head with the employee's own checks, then merged, with what its steward block asks for after. One that doesn't stays a draft for you; the round says why (`a draft from the Wright, waiting for you: …`), and after a day the alarm does too. A draft of your own is never the Steward's to look at.

**With the Bailiff.** Where the Bailiff is installed (`%USERPROFILE%\.bailiff\app`, or `BAILIFF_HOME`'s; the same rule as the Wright's), a draft that passes the look above is marked ready only once the Bailiff has approved its current head commit: the PR is labelled `bailiff:approved`, and the Bailiff's last review comment by the team's account ends with `<!-- bailiff-review {"head":"<sha>","verdict":"approved"} -->` naming exactly the head the round listed, which is still the PR's head (one `gh pr view --json headRefOid,comments`, only for drafts labelled approved that passed the look). Until then it stays a draft, and the round says why: `a draft from the Wright, with the Bailiff: waiting for the Bailiff's review` (or that it asked for changes, couldn't review it yet, or approved an earlier commit). The Steward's own look always comes first: an approval never overrides it. The comment that marks it ready names the commit the Bailiff approved. Without the Bailiff, nothing changes. The Bailiff, like the Wright, is ours alone: an employee and an alarm source only where it is installed.

## Settings

Changed on the page, under **Settings**, and kept in `%USERPROFILE%\.steward\settings.json`. They are used from the next stage on.

| Setting | Default | Meaning |
|---|---|---|
| Employees (`employees`) | the eight hires, Reeve and Heiward, the Surveyor, the Lamplighter, the Smith, the Developer Herald, the Chamberlain, the Thatcher, the Reckoner, the Weigher and the Shepherd; and the Wright and the Bailiff, each where it is installed (they are ours alone, never anyone else's default) | Each: `id`, `name`, `repo` (owner/name), `checkout` (`C:\Projects\<Name>`), `branch` (main; Heiward's master), whether it takes the kit (`usesKit`), its kit `parts`, the command that fills its kit (`fill`), its checks (`test`), its `versionFiles`, its `release` command, and its `install` command, run in its release unpacked when a merged PR asks for install (`node src/cli.ts install`; empty, as Heiward's, for none), and its `approve` command for a job, `{job}` its name and `{sha256}` the hash of the script checked (Reeve's only), with its `installed` copy (`%USERPROFILE%\.<id>\app`), where each round looks for jobs merged but not yet approved. |
| Team (`team`) | Jcollier0120 | The GitHub accounts whose PRs `merge --team` merges as well as the Steward's (a GitHub App's as gh names it, `app/<name>`). Claude Code opens its PRs with your account, so yours covers them. Empty: `--team` merges only the Steward's. |
| Work folder (`workRoot`) | `%USERPROFILE%\.steward\work` | Where the Steward makes its worktrees, one folder per employee. |
| Release right after merging (`releaseAfterMerge`) | off | Release is a stage of its own unless this is on. |
| The Steward's repository (`stewardRepo`) | Jcollier0120/Steward | Where the kit releases are. |
| Checked at once (`parallel`) | 2 | How many employees a bump tests at the same time, 1 to 10. |
| Merges and releases by itself (`byItself`) | on | On duty, its round: every ready PR of its own and the team's merged, with what each asks for after, then every version not yet released released; and, as `releaseSelf` and `rollout` say, its own new versions released and a new kit rolled out (Page and commands, above). Off: only when asked. |
| A round every (`roundMinutes`) | 10 | Minutes between rounds, 2 to 240. Each asks GitHub once, and looks again only at the employees with something new (all of them each hour). |
| Told after a release (`afterRelease`) | `http://127.0.0.1:18585/api/updates/check`, `http://127.0.0.1:19191/api/run` | Local pages POSTed, as their own buttons, when a stage or a round has released something: Manor's update check and the Aletaster's Run now. Empty: none. |
| The Wright's drafts (`wrightReview`) | on; 600 lines; the Wright's list | Whether rounds look at the Wright's drafts and mark ready the ones that pass (`on`), the most lines one may change (`maxLines`, 10 to 5000), and the path patterns a person reviews (`sensitive`). |
| Catch PRs up (`catchUp`) | on | Whether rounds catch a ready team PR, or a kit PR of the Steward's, up with its branch when that is all it waits on: above. |
| Waits for the Aletaster's tasting (`tasteBeforeRelease`) | on | Whether a release waits for a passing tasting of its commit from the Aletaster (The Aletaster tastes it first, above). Off: released without asking. |
| Rolls out a new kit by itself (`rollout`) | on | Whether rounds bump and push each employee whose branch pins a kit older than the newest kit release (The rollout in a round, above). Off: Bump and Push only when asked. |
| Merges its own PRs (`mergeSelf`) | on | Whether rounds merge the team's ready PRs to the Steward's own repository, tested here first (Its own PRs, above). Off: they are left to you. |
| Hands failures to the Wright (`fileWork`) | on | Whether a failed bump or release, and a Reeve alert that is code work, is filed as an issue in the Wright's queue, its alarm waiting while it is worked on (Alarms, above). Off: each is an alarm at once. |
| Releases its own new versions (`releaseSelf`) | on | Whether rounds release a kit version or a Steward version on the Steward's own main that has no release yet (Its own releases, above). |
| The Steward's checkout (`stewardCheckout`) | `C:\Projects\Steward` | Your clone of the Steward, which its own releases are made from: a worktree of it at origin/main, in the work folder. Without one, those releases are left to you. |
| Alarms (`alarms`) | on, with a notification; 24 hours, 6 hours, 6 hours; `http://127.0.0.1:18585`, `http://127.0.0.1:19595`, `http://127.0.0.1:18383`; the Wright's `http://127.0.0.1:19797` and the Bailiff's `http://127.0.0.1:19999` only where each is installed | Whether rounds raise alarms (`on`), with a Windows notification (`toast`); how long a PR waits (`waitingHours`), a Surveyor's problem lasts (`problemHours`) and the Aletaster's tasting holds a release (`tastingHours`), 1 to 168, before it is one; Manor's page (`manorUrl`), the Surveyor's (`surveyorUrl`), Reeve's (`reeveUrl`, read only where Reeve is installed) the Wright's (`wrightUrl`) and the Bailiff's (`bailiffUrl`), local addresses only, empty for not read. |

## Files

All in `%USERPROFILE%\.steward` (`%USERPROFILE%\.steward-dev` for a checkout; `STEWARD_HOME` overrides it; `STEWARD_PORT` moves the page):

| File | What |
|---|---|
| `app\` | The installed program (see Install). |
| `home-page.task.xml` | The sign-in task, as it was registered. |
| `settings.json` | Settings. |
| `staff.json` | The staff's table, as last refreshed. |
| `last-stage.json`, `stages.log` | The last stage, with its log; every stage's results, one line each (a round's only when it did something). stages.log is rotated at 1 MB, the last two kept as `stages.1.log` and `stages.2.log`. |
| `round-seen.json` | What each employee's repository and Settings were when a round last looked at it and it went well, with its PRs that waited, and when the last full round was: how a round tells what's new. |
| `round.json` | Its last round's outcome, as every kit agent leaves it (kit 2.8.0, [spec/ROUND.md](kit/spec/ROUND.md)), for the Surveyor. |
| `round-failed.json` | The commit, for each employee, whose release failed in a round: the rounds don't try it again. |
| `rollout-failed.json` | For each employee whose bump or push to a kit failed in a round: the kit, its branch's head then, and what was said. The rounds don't try that kit again at that head; Bump or Push lets it go. |
| `self-failed.json` | Each of the Steward's own releases (by tag) that failed in a round, with the commit of main: the rounds don't try it again at that commit. |
| `tasting-held.json` | Each employee whose release the Aletaster's tasting holds: the commit, the version, since when, the reason and the link. For the alarms; gone once it is released or no longer waits. |
| `alarms.json` | The alarms: open, dismissed and lately cleared, and each condition watched since it was first seen. |
| `work-filed.json` | Each issue filed for the Wright (by its marker's id): its URL, repository and when. Forgotten a month after its failure is gone. |
| `tested.json` | Each employee's last 20 commits whose checks passed here, newest first, by stage: `GET /api/tested`, for the Surveyor. |
| `version-claims.json` | The versions claimed up front and not yet landed: the repository, the version, the branch, who and what for, and when. |
| `kickbacks.json` | Each conflicting team PR sent back to its author, by its head and its branch's: sent once, and again only when either moves. |
| `unsafe-updates.json` | Each version of the Steward its install rolled back: what failed, the version it went back to, and where the failed copy is kept. Refused until allowed again. |
| `app.prev`, `app.unsafe-<version>` | The version before the last update, to go back to; a rolled-back version's copy, for a look. |
| `pr-checks.json` | What testing each team PR here said, by its head commit: tested once, and a new push afresh. |
| `jobs-approved.json` | Each employee's job scripts the Steward approved (or turned down) as merged, by sha256: each is looked at once. |
| `work\` | The worktrees of the employees' bumps and releases, and `_modules\`, the packages they share (one set per lockfile). |
| `kits\` | The kit releases tools/kit.ts downloaded, by version, for every agent on this PC. Always `%USERPROFILE%\.steward\kits`, for a checkout too (`STEWARD_KITS` overrides it). Once a day the versions no one pins (an employee's branch or latest release, the Steward's own kit.json, the kit it hands out) are let go, beyond the newest three and any touched in the last day (`kits-pruned.json` says when, and which); tools/kit.ts fetches one again if it is asked for. |
| `duty.json`, `server.json`, `serve.log` | On duty or not; the running page's pid, port and token; its output. |

## Manor entry

[manor-agent.json](manor-agent.json) is its entry, as Manor's staff.json has it, and its role, as Manor's roles.json has it. Every release publishes it beside the zip, listed in SHA256SUMS.txt (the kit's release.ts, from kit 2.12.0), so a Manor that finds it on GitHub offers Hire on the Steward's card (Manor's "New agents, announced on GitHub"). The release refuses to build when its `release.repo` isn't this repository or its id isn't `steward`. Keep it the same as Manor's staff.json entry.

It points at the installed copy (see Install). Its role in Manor's roles is `steward`.

## Limits

- **It acts with your git and gh.** Pushes, PRs, merges and releases are yours. It never force-pushes, never touches your checkouts' working trees (it fetches, and adds and removes worktrees of them), and merges only what is mergeable and green: its own PRs, and, with `--team` or in its rounds, those the team opened. It deletes only its own branches.
- **In its rounds it merges, releases and rolls out with no one asking.** A team PR that isn't a draft is ready: open a PR that needs review as a draft. A team PR with no CI is merged only once its employee's own checks pass here, so it is only as safe as those checks. A new kit is bumped and pushed to every employee behind it, and merged once its PR is ready: only as safe as the employees' checks, which the bump runs. Whatever is on the Steward's own main with a new version is released: merge to it only what you mean to publish. Switch "Merges and releases by itself" off in Settings to have it act only when asked, or `rollout` and `releaseSelf` for those two alone.
- **A kit PR that conflicts beyond its versions is closed, not merged by hand.** The Steward catches its own kit PRs up as the team's, but one whose conflict isn't in its version lines is closed and bumped again from the branch's head: whatever that PR carried beyond the new pin, its version and tools/kit.ts is made again by the next bump, never resolved.
- **A release is only as held as the Aletaster is here.** With no Aletaster, one off duty for Developer options, one that predates the tasting or doesn't answer, and for the Aletaster's own release, the Steward releases without a tasting, and says so.
- **An employee's checks run on this PC**, with the commands in Settings. A bump is only as good as its tests.
- **A kit version must be released before the employees pin it**, or a fresh clone of theirs couldn't fill its kit. `--kit-from` is for trials only.
- **tools/kit.ts reaches an agent with a bump**, so a change to it waits for the next kit version, and the old one does the filling until then: keep it small, stable and able to read the kit releases it will meet.
- **Checks count as green when there are none.** The hires have no CI, so a PR's mergeability is the only check GitHub makes; the bump ran their tests before the commit.
- **Manor isn't an employee:** it is the next candidate to take the `node` and `web` parts (its settings-kit.ts and settings-panel.js are the kit's already).
- **Kit releases come from GitHub** for the installed copy. Without network it can still bump with `--kit-from`.

## Next

Planned, not in 0.1.0:

- **"Back to Manor" in every agent's header** (a kit change, rolled out by the Steward, after the Surveyor is hired). When an agent is installed alongside Manor, its page header shows Manor's icon and a "Back to <manor name>" link beside the agent's own icon and title, so people move between Manor and the agents easily. The kit's page.ts finds Manor through `%USERPROFILE%\.manor\settings.json`: its name, port, and icon (a path inside `%USERPROFILE%\.manor\app`). The agent serves Manor's icon itself, at `/manor-icon.svg` say, because the page's CSP allows images from `'self'` only. The header shows nothing when Manor isn't installed. It belongs in the `web` part as one script and its CSS, reading `/api/manor` from the agent's own server, so a page that isn't the kit's can include it too. Reeve and Heiward don't use the kit's page, so each needs it separately (Reeve's React dashboard, Heiward's wwwroot).
- **src/cli.ts into the kit.** Six hires have the same cli.ts; the Auditor's adds `audit` and the Clerk's `search`. A kit `agentCli({ run, extra })` with each agent's own commands passed in would take it.
- **Heiward on the dotnet part** (kit 2.0.0, above): its tools\kit.ps1 bringing the parts a part needs, its NpuLock.cs and Accelerators.cs on the part, and Settings' kit parts listing `core` and `dotnet` (src/settings.ts's `PART_NAMES`, which keeps only the parts it lists). **Manor** takes the kit after it.
- **More in its rounds**: a daily `staff` (its rounds already merge, release, roll out a new kit and release the Steward itself); catching up its own kit PRs when their branch moves on.
- **app.ts's shared half** (`isDevCheckout`, `placeFor` and the place they compute) could be the kit's too, leaving the agent's app.ts its `APP` and port.

## Development

Node 22.18+ runs the TypeScript directly; there is no build step and no runtime dependency.

```powershell
npm install          # TypeScript and @types/node, for the typecheck
npm run kit          # fill src\kit (and the fixture's) from kit\
npm test             # the Steward's tests and the kit's, on the fixture; pretest fills the kit, posttest runs test:dotnet when it can
npm run test:dotnet  # the dotnet part's tests (kit\test\dotnet), with a .NET 10 SDK: DOTNET_ROOT, PATH, C:\tools\dotnet10 or %ProgramFiles%\dotnet
npm run test:dotnet-publish  # the dotnet part published as Heiward publishes it, and run
npm run core-types   # the core's .d.ts, from its JSDoc
npm run vectors      # spec\turn-vectors.json and spec\accelerator-vectors.json, from the core's answers
npm run typecheck
npm run release      # artifacts\steward\Steward-<version>.zip and its SHA256SUMS.txt; -- --install installs it
npm run kit-release  # artifacts\kit\kit-<version>.zip and its SHA256SUMS.txt; -- --publish makes kit-v<version>
npm run ui:inventory # docs\UI-INVENTORY.md and .html: the page's components, their sizes, and markup written out more than once
```

### The UI inventory

`npm run ui:inventory` (tools/ui-inventory.ts, ported from GamerNexus's apps/mobile script) asks what a page is made of, and flags what could be broken down and reused. It reads the Steward and its kit by default, and any agent's repository or Manor's with `-- --repo <folder>`: every page is moving to React, and the same questions apply in JSX as in template strings.

A **component** is a named function that writes markup (JSX, a tag in a string or template, or an `h('tag', …)` call as in settings-panel.js), and it **renders** the components it calls or puts in its JSX. TypeScript 7's own parser reads the code (`typescript/unstable/sync`, through a project of exactly the files read, made outside the repository), so a tag in a comment or a `<branch>` in usage text isn't counted. Tests, builds, `src\kit\` (the Steward's kit, copied in) and build-time tools (`art\`, `scripts\`, `tools\`) are left out.

- **Repeated markup**, the leading indicator: an element with the same tag and classes (`span.muted`) written out 4 times or more. A bare `<td>` and SVG drawing don't count.
- **Largest components:** over 60 for a component, 150 for a page, where size is lines, or characters / 100 when that's more (a line here can run to hundreds of characters).
- **File-local** components, those **never used** (the kit's exports serve every agent: check them before deleting), what each file **writes by hand** per component, the **most reused**, and the **render tree** from each page (a route's, or a React root's `render(<App/>)`) down to the core: the kit's page.ts, or a `components/ui` folder.

Every finding is a question, not a defect. Reports go in the Steward's `docs\` (git-ignored): `UI-INVENTORY.md` and `.html`, or `UI-INVENTORY-<repository>.*` for another, which is never written to. `-- --tree` prints the tree, `-- --check` says whether the report is current, `-- --strict` fails on any finding, and `-- --ci` only on a component past 140 or a page past 320.

The Steward takes its own kit the way a hire does: `kit.json` pins it (the `node` and `web` parts, which bring the core and spec), and `npm run kit` fills `src\kit\` from this checkout's `kit\` (`--from kit`). The dotnet tests restore Jint and xUnit from nuget.org (`kit\test\nuget.config`), whatever this PC's NuGet config lists. The tests make fake employees with git in temporary folders, with gh standing in, and serve tools/kit.ts a kit release from a local server; nothing reaches GitHub but one lookup of a release that isn't there. A checkout runs as the development copy, in `%USERPROFILE%\.steward-dev` on port 29494.
