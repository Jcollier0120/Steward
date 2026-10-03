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
| `node` | `kit\node\` | `src\kit\` | The TypeScript modules: accelerators.ts, agent-checks.ts, duty.ts, gpu-load.ps1, install.ts, lock.ts, look.ts, manor.ts, npu-queue.ts, npu.ts, page.ts, ps.ts, release.ts, rules.ts, schedule.ts, server.ts, service.ts, settings-kit.ts, store.ts, themes.ts, work.ts. The queue, the lock and the accelerators are the core's rules, carried out with Node's fs and timers. page.ts draws every agent's page in Heiward's look (the manor's themes: Windows 11's Light and Dark and six colour themes, the manor's own when Manor is installed; a title bar with a status pill), and look.ts gives each agent its own colour and a small scene in its title bar that moves while a round runs. |
| `web` | `kit\web\` | `src\kit\web\` | Browser files any agent's page can use, whatever its server: settings-panel.js and settings-panel.css, and the manor's themes, themes.css (every theme's colours) and themes.json (the list the Theme menus show), which page.ts puts in every kit page and Manor carries a copy of. A page includes them as plain files; the panel needs an element with `data-settings-panel`, a `<meta name="page-token">`, and `GET`/`POST /api/settings` on its own origin. |
| `spec` | `kit\spec\` | `src\kit\spec\` | The language-neutral rules: [NPU-QUEUE.md](kit/spec/NPU-QUEUE.md) (was Reeve's), [ACCELERATORS.md](kit/spec/ACCELERATORS.md) (was Manor's), rules.json (the timings and limits, as data, which the core takes), and the vectors every implementation runs: npu-queue-vectors.json (the queue), turn-vectors.json (a turn, step by step) and accelerator-vectors.json. This is now their home. The core brings it. |
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

An agent's release (`src/kit/release.ts`, `npm run release`) carries `src\kit\`, with `kit.json` and `tools/kit.ts`, and its release.json says `"kit": "2.0.0"`. It refuses to build when `src\kit\VERSION` isn't the pinned version. So an installed agent needs neither the Steward nor GitHub.

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

The Steward's own releases stay **`v<version>`** (`npm run release`), and are separate: a kit release needs no Steward release, and a kit release is never marked Latest.

## Making a kit change

1. Edit `kit\` (and its tests in `kit\test\`), or `tools/kit.ts`, raise `kit\VERSION`, add its entry to `kit\CHANGELOG.md`, and set this repository's own `kit.json` to the new version (a test checks they agree). `npm test` runs the kit's tests on the fixture, tools/kit.ts's, and the vectors against the core and the node part; then the dotnet part's, when a .NET 10 SDK is found (`npm run test:dotnet` runs those alone, and fails without one).
   - **A rule** is a change to `kit\core\`. `npm run core-types` then writes its `.d.ts` again (a test says when they're stale), and `npm run vectors` writes turn-vectors.json and accelerator-vectors.json from the scenarios in `kit\test\*-scenarios.ts`: their diff is the change in behaviour, for review. A timing or a limit is a change to `kit\spec\rules.json`.
   - **The dotnet part**: `npm run test:dotnet-publish` publishes it as Heiward does (self-contained, single-file or not, Arm64 and x64) and trimmed, and runs each exe. Jint's version is pinned in `kit\dotnet\Steward.Kit.props`.
2. To try it in an agent before releasing it: `node tools/kit.ts --from ..\Steward\kit` there, or `steward bump --kit-from kit` (below).
3. PR it to the Steward, and merge it.
4. Release it: `npm run kit-release -- --publish`.
5. Roll it out, a stage at a time: `bump`, `push`, `merge`, `release`.

## The rollout

Each stage is a command and a button on the page (each asks first, and only the ticked employees are touched). Each reports for every employee (done, skipped, refused or failed, and why), and the page shows the last stage's results and log. Stages run one at a time on this PC: a lock in the data folder keeps the page and a terminal apart. On duty it also merges and releases by itself, in its round (Page and commands, below).

1. **`steward bump [--kit <version>] [--employees a,b]`**: for each employee that takes the kit, a fresh git worktree of its branch on origin (fetched first), on the branch `steward/kit-<version>`, in the work folder (`%USERPROFILE%\.steward\work\<id>`). Never the person's own checkout. There `kit.json`'s pin moves to the kit, `tools/kit.ts` becomes the Steward's when it differs (for an agent whose kit is filled by it), and the patch version goes up in every version file (package.json, both of package-lock.json's own entries, and src/app.ts, which release.ts requires to agree). Then, for a Node agent, `npm ci` if it has no node_modules; its kit is filled with the new tools/kit.ts, and its checks run (`npx tsc -p . --noEmit` and `npm test` for a hire). When every one passes, the changes are committed: "Porter 0.4.1: the Steward's kit 1.0.1". The Steward's tools/kit.ts is its checkout's, or, installed, the one its release carries. A failure leaves the worktree for a look. `--kit` defaults to the newest kit release; one that isn't released is refused, since the employees couldn't fetch it, unless `--kit-from <kit folder>` fills from a kit tree instead (for a trial). `--base <ref>` starts from a local ref instead of origin's branch. A bump made before and not pushed is made again from scratch; one already on origin is refused until its PR is merged or closed.
2. **`steward push`**: each prepared branch is pushed (a plain push, never forced) and gets a PR against the employee's branch, titled "Porter 0.4.1: the Steward's kit 1.0.1", its body the changelog's entries since the kit it had. A PR already open is left as it is.
3. **`steward merge [--yes] [--team]`**: the Steward's open PRs (head `steward/…`, a branch of the employee's repository itself, never a fork's), with their checks and whether they merge. With `--yes` (or the page's button, which asks first), those that merge cleanly into the employee's branch, aren't drafts, and have no failing or running checks (none counts as green; the hires have no CI) are merged with a merge commit and their branch deleted (`gh pr merge --merge --delete-branch`), and the Steward's worktree for each is removed. The rest wait, and say why. With "Release right after merging" on in Settings, release follows for the merged.

   **`--team`** (the page's **Merge the team's PRs**) takes the team's open PRs as well: those opened by one of the GitHub accounts in Settings' **Team**, from any branch. By default that is `Jcollier0120`, you, which covers Claude Code too, since it opens its PRs with your account. They wait and merge by the same rules, and only into the employee's branch: a PR stacked on another branch waits for that one. A team member's branch is theirs, so it isn't deleted (it may still be checked out in a worktree). `--team` covers an employee that doesn't take the kit yet too: merging has nothing to do with the kit. A PR anyone else opened is never merged, nor listed. A team PR that isn't a draft is ready to merge: that is the team's rule, so work still in progress is opened as a draft.

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
4. **`steward release`**: for each employee whose branch on origin pins the kit and carries a version with no GitHub release yet, a worktree at that very commit, and its release command run there (`npm run release -- --publish` for a hire), after `npm ci` for a Node agent, since the worktree is fresh and Reeve's release builds its dashboard with its packages. Releases come from the branch, never from a PR's, so a release and its branch never drift apart.
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

## Install

The Steward installs itself, from a release, as every agent does. In a checkout of this repository:

```powershell
npm run release -- --install     # build a release, and install it
```

Or unpack a release zip anywhere (from GitHub, or `artifacts\steward\` after `npm run release`) and run `node src\cli.ts install` in it.

`install` copies the release to `%USERPROFILE%\.steward\app`; its data stays in `%USERPROFILE%\.steward`. It registers one sign-in task, `\Steward\Home page`, which runs `open` when you sign in, so the page comes back after a restart. Then it starts the page through that task and waits for it. A new install goes on duty. To update, install a newer release the same way. `--no-start` installs without starting it, and `--dry-run` says what it would do and changes nothing. `node %USERPROFILE%\.steward\app\src\cli.ts uninstall` ends the page process, deletes the task and removes `app`; `uninstall --purge` also removes the data folder, with the work folder's worktrees (git then lists them as prunable).

A checkout is a development copy, and keeps out of the installed one's way: its data is in `%USERPROFILE%\.steward-dev`, its page is on port 29494, and `install` refuses to run from it. The installed copy has no `kit\` folder: it hands out the newest kit release, or the version named with `--kit`. The details, which every agent shares, are in Manor's INSTALLING.md.

The Steward needs git and `gh` (signed in, with rights to push and merge in the employees' repositories) on this PC, and each employee's checkout where Settings say.

## Page and commands

The page at http://steward.localhost:19494/ shows the kit the Steward hands out, the staff's table, a tick box for each employee (one that doesn't take the kit starts unticked) and a button for each stage, with **Merge the team's PRs** after them, the last stage's results and log, and **Settings**. While a stage runs, the page refreshes itself. The table is refreshed after each stage, on **Refresh**, and when the page is opened more than 10 minutes after the last time. `GET /api/ping` answers `{"app":"steward","name":"Steward","version":"0.1.0","pid":…,"running":true,"busy":false,"stage":null}`, `busy` while a stage runs. Like every agent page, it answers only to its own host names, and its buttons need the token from the page itself.

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

Its duty works as the hires' does, and its round is this: **it merges and releases by itself.** While it's on duty, and "Merges and releases by itself" is on in Settings (it is, by default), a round comes every 10 minutes ("A round every"), through the kit's `every()`, which pauses off duty:

1. **Merge**, as `merge --yes --team`: every open PR of its own and the team's that is ready (not a draft, merges cleanly into the employee's branch, no failing or running checks) is merged, and then what each asks for after merging is done (release, install, approve-jobs: its steward block, above). A PR that isn't ready waits for a later round.
2. **Release**: every employee whose branch carries a version with no GitHub release yet is released from its branch, whatever kit it pins, as `steward release` would: a PR that raised the version, or a version pushed straight to the branch. A release that fails isn't tried again at the same commit (it's kept in `round-failed.json`): the round says so, and leaves it to you, the Release button or a new commit on the branch.

A round with nothing merged, released or failed leaves no trace; one that did something is the last stage on the page, and a line in stages.log, as any stage is. A round passes while a stage runs (the stage lock). **Run now** (`steward round` in a terminal) does one round, on duty or not. Manor's employee card shows the rounds, from `/api/ping`. With "Merges and releases by itself" off, the stages run only when asked.

## Settings

Changed on the page, under **Settings**, and kept in `%USERPROFILE%\.steward\settings.json`. They are used from the next stage on.

| Setting | Default | Meaning |
|---|---|---|
| Employees (`employees`) | the eight hires, Reeve and Heiward | Each: `id`, `name`, `repo` (owner/name), `checkout` (`C:\Projects\<Name>`), `branch` (main; Heiward's master), whether it takes the kit (`usesKit`), its kit `parts`, the command that fills its kit (`fill`), its checks (`test`), its `versionFiles`, its `release` command, and its `install` command, run in its release unpacked when a merged PR asks for install (`node src/cli.ts install`; empty, as Heiward's, for none), and its `approve` command for a job, `{job}` its name (Reeve's only). |
| Team (`team`) | Jcollier0120 | The GitHub accounts whose PRs `merge --team` merges as well as the Steward's (a GitHub App's as gh names it, `app/<name>`). Claude Code opens its PRs with your account, so yours covers them. Empty: `--team` merges only the Steward's. |
| Work folder (`workRoot`) | `%USERPROFILE%\.steward\work` | Where the Steward makes its worktrees, one folder per employee. |
| Release right after merging (`releaseAfterMerge`) | off | Release is a stage of its own unless this is on. |
| The Steward's repository (`stewardRepo`) | Jcollier0120/Steward | Where the kit releases are. |
| Checked at once (`parallel`) | 2 | How many employees a bump tests at the same time, 1 to 10. |
| Merges and releases by itself (`byItself`) | on | On duty, its round: every ready PR of its own and the team's merged, with what each asks for after, then every version not yet released released (Page and commands, below). Off: only when asked. |
| A round every (`roundMinutes`) | 10 | Minutes between rounds, 2 to 240. |

## Files

All in `%USERPROFILE%\.steward` (`%USERPROFILE%\.steward-dev` for a checkout; `STEWARD_HOME` overrides it; `STEWARD_PORT` moves the page):

| File | What |
|---|---|
| `app\` | The installed program (see Install). |
| `home-page.task.xml` | The sign-in task, as it was registered. |
| `settings.json` | Settings. |
| `staff.json` | The staff's table, as last refreshed. |
| `last-stage.json`, `stages.log` | The last stage, with its log; every stage's results, one line each (a round's only when it did something). |
| `round-failed.json` | The commit, for each employee, whose release failed in a round: the rounds don't try it again. |
| `work\` | The worktrees of the employees' bumps and releases. |
| `kits\` | The kit releases tools/kit.ts downloaded, by version, for every agent on this PC. Always `%USERPROFILE%\.steward\kits`, for a checkout too (`STEWARD_KITS` overrides it). |
| `duty.json`, `server.json`, `serve.log` | On duty or not; the running page's pid, port and token; its output. |

## Manor entry

```json
{ "id": "steward", "name": "Steward", "role": "Keeps the essentials every agent shares, and brings each update to all of them at once",
  "description": "Keeps the kit the agents share in one place, and rolls each kit version out to every employee: a bump, its PR, the merge and the release, each one stage, reported per employee.",
  "fills": ["steward"], "app": "steward",
  "home": "http://steward.localhost:19494/", "ping": "http://127.0.0.1:19494/api/ping",
  "icon": "%USERPROFILE%\\.steward\\app\\art\\icon.svg",
  "paths": { "app": ["%USERPROFILE%\\.steward\\app"], "node": ["C:\\tools\\node-v22.23.3-win-arm64\\node.exe", "%ProgramFiles%\\nodejs\\node.exe"] },
  "cwd": "{app}",
  "commands": { "start": ["{node}", "{app}\\src\\cli.ts", "start"], "stop": ["{node}", "{app}\\src\\cli.ts", "stop"], "status": ["{node}", "{app}\\src\\cli.ts", "status", "--json"], "open": ["{node}", "{app}\\src\\cli.ts", "open"] } }
```

It points at the installed copy (see Install). Its role in Manor's roles is `steward`.

## Limits

- **It acts with your git and gh.** Pushes, PRs, merges and releases are yours. It never force-pushes, never touches your checkouts' working trees (it fetches, and adds and removes worktrees of them), and merges only what is mergeable and green: its own PRs, and, with `--team` or in its rounds, those the team opened. It deletes only its own branches.
- **In its rounds it merges and releases with no one asking.** A team PR that isn't a draft is ready, so open work in progress as a draft, and switch "Merges and releases by itself" off in Settings to have it act only when asked.
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
- **More in its rounds**: a daily `staff`, noticing a new kit release (its rounds already merge and release).
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
```

The Steward takes its own kit the way a hire does: `kit.json` pins it (the `node` and `web` parts, which bring the core and spec), and `npm run kit` fills `src\kit\` from this checkout's `kit\` (`--from kit`). The dotnet tests restore Jint and xUnit from nuget.org (`kit\test\nuget.config`), whatever this PC's NuGet config lists. The tests make fake employees with git in temporary folders, with gh standing in, and serve tools/kit.ts a kit release from a local server; nothing reaches GitHub but one lookup of a release that isn't there. A checkout runs as the development copy, in `%USERPROFILE%\.steward-dev` on port 29494.
