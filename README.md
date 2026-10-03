<img src="art/icon.svg" width="40" align="left" alt="">

# Steward

Keeps the essentials every agent shares, and brings each update to all of them at once.

The *steward* ran the household for its lord: he kept the keys, saw that every servant had what the work needed, and carried the lord's orders to each of them. Its mark is a ring of keys.

One of the agents employed at Manor, the home of the local agents on this PC: the senior employee. Its page is http://steward.localhost:19494/.

The hires (Porter, Auditor, Clerk, Herald, Warrener, Aletaster, Miller and Pinder) each carried a copy of the same kit: the page and its server, Settings, install and release, the accelerators and the NPU queue. A change to it meant the same PR in eight repositories. The Steward keeps that kit once, in this repository, and rolls each new version out to every employee: one command, or one button, per stage, each reporting per employee.

## The kit

The kit lives in `kit\`, versioned by `kit\VERSION` (1.0.0) with `kit\CHANGELOG.md`. It comes in **parts**, and an agent takes the ones that fit it:

| Part | In the kit | In a Node agent | What |
|---|---|---|---|
| `node` | `kit\node\` | `src\kit\` | The TypeScript modules: accelerators.ts, agent-checks.ts, duty.ts, gpu-load.ps1, install.ts, lock.ts, look.ts, npu-queue.ts, npu.ts, page.ts, ps.ts, release.ts, schedule.ts, server.ts, service.ts, settings-kit.ts, store.ts, work.ts. page.ts draws every agent's page in Heiward's look (Windows 11's colours, Light or Dark, a title bar with a status pill), and look.ts gives each agent its own colour and a small scene in its title bar that moves while a round runs. |
| `web` | `kit\web\` | `src\kit\web\` | Browser files any agent's page can use, whatever its server: settings-panel.js and settings-panel.css. A page includes them as plain files; the panel needs an element with `data-settings-panel`, a `<meta name="page-token">`, and `GET`/`POST /api/settings` on its own origin. |
| `spec` | `kit\spec\` | `src\kit\spec\` | The language-neutral rules: [NPU-QUEUE.md](kit/spec/NPU-QUEUE.md) (was Reeve's), [ACCELERATORS.md](kit/spec/ACCELERATORS.md) (was Manor's) and npu-queue-vectors.json, the cases every implementation of the queue runs. This is now their home. |

`kit\test\` holds the kit's own tests, which run here against a fixture agent (`kit\test\fixture`, the smallest agent the kit runs in). Agents don't get them; each runs only its own tests, and the kit's checks of itself (below).

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
  "kit": "1.0.0",
  "parts": ["node", "web", "spec"]
}
```

Its `src\kit\` is git-ignored and filled by `tools/kit.ts`, the one shared file left in each repository: small, dependency-free, the same in every agent. This repository's `tools/kit.ts` is the canonical one, and `bump` hands it out with each new pin (below), so a change to it reaches every agent as a kit change does. `npm run kit` runs it, and so does every npm script that runs the kit: `pretest`, `pretypecheck`, `prestart`, `prestop`, `prestatus` and `preopen`, and `serve` and `release` before their command. So a fresh clone works whichever it runs first. It writes `src\kit\VERSION` (and `PARTS`), and does nothing when they already match the pin. Otherwise it takes the pinned version from the first of:

1. `--from <dir>`, or the `STEWARD_KIT` environment variable: a kit tree on this PC, such as a Steward checkout's `kit\`, copied every time. For development; it warns when the tree's version isn't the pinned one, and a release refuses that.
2. A sibling checkout, `..\Steward\kit`, when its VERSION is the pinned one: with the default checkouts, `C:\Projects\<Name>`, that is `C:\Projects\Steward\kit`.
3. `%USERPROFILE%\.steward\kits\<version>`, the cache.
4. The kit release: `https://github.com/Jcollier0120/Steward/releases/download/kit-v<version>/kit-<version>.zip` and its `SHA256SUMS.txt`, over plain HTTPS with no sign-in (the repository is public), or through `gh release download` if that fails. The zip is checked against SHA256SUMS.txt, unpacked with Windows' own tar.exe, and kept in the cache.

An agent's release (`src/kit/release.ts`, `npm run release`) carries `src\kit\`, with `kit.json` and `tools/kit.ts`, and its release.json says `"kit": "1.0.0"`. It refuses to build when `src\kit\VERSION` isn't the pinned version. So an installed agent needs neither the Steward nor GitHub.

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

A kit version is released once, as **`kit-v<version>`** in this repository, with `kit-<version>.zip` (VERSION, CHANGELOG.md and the parts, from `kit\` at HEAD through `git archive`, never the tests) and `SHA256SUMS.txt`. Its notes are the changelog's entry. `npm run kit-release` builds them into `artifacts\kit\`; `npm run kit-release -- --publish` makes the release, from a committed and pushed tree, and refuses a version already released.

The Steward's own releases stay **`v<version>`** (`npm run release`), and are separate: a kit release needs no Steward release, and a kit release is never marked Latest.

## Making a kit change

1. Edit `kit\` (and its tests in `kit\test\`), or `tools/kit.ts`, raise `kit\VERSION`, add its entry to `kit\CHANGELOG.md`, and set this repository's own `kit.json` to the new version (a test checks they agree). `npm test` runs the kit's tests on the fixture, and tools/kit.ts's.
2. To try it in an agent before releasing it: `node tools/kit.ts --from ..\Steward\kit` there, or `steward bump --kit-from kit` (below).
3. PR it to the Steward, and merge it.
4. Release it: `npm run kit-release -- --publish`.
5. Roll it out, a stage at a time: `bump`, `push`, `merge`, `release`.

## The rollout

Each stage is a command and a button on the page (each asks first, and only the ticked employees are touched). Each reports for every employee (done, skipped, refused or failed, and why), and the page shows the last stage's results and log. Stages run one at a time on this PC: a lock in the data folder keeps the page and a terminal apart.

1. **`steward bump [--kit <version>] [--employees a,b]`**: for each employee that takes the kit, a fresh git worktree of its branch on origin (fetched first), on the branch `steward/kit-<version>`, in the work folder (`%USERPROFILE%\.steward\work\<id>`). Never the person's own checkout. There `kit.json`'s pin moves to the kit, `tools/kit.ts` becomes the Steward's when it differs (for an agent whose kit is filled by it), and the patch version goes up in every version file (package.json, both of package-lock.json's own entries, and src/app.ts, which release.ts requires to agree). Then, for a Node agent, `npm ci` if it has no node_modules; its kit is filled with the new tools/kit.ts, and its checks run (`npx tsc -p . --noEmit` and `npm test` for a hire). When every one passes, the changes are committed: "Porter 0.4.1: the Steward's kit 1.0.1". The Steward's tools/kit.ts is its checkout's, or, installed, the one its release carries. A failure leaves the worktree for a look. `--kit` defaults to the newest kit release; one that isn't released is refused, since the employees couldn't fetch it, unless `--kit-from <kit folder>` fills from a kit tree instead (for a trial). `--base <ref>` starts from a local ref instead of origin's branch. A bump made before and not pushed is made again from scratch; one already on origin is refused until its PR is merged or closed.
2. **`steward push`**: each prepared branch is pushed (a plain push, never forced) and gets a PR against the employee's branch, titled "Porter 0.4.1: the Steward's kit 1.0.1", its body the changelog's entries since the kit it had. A PR already open is left as it is.
3. **`steward merge [--yes]`**: the Steward's open PRs (head `steward/…`), with their checks and whether they merge. With `--yes` (or the page's button, which asks first), those that merge cleanly, aren't drafts, and have no failing or running checks (none counts as green; the hires have no CI) are merged with a merge commit and their branch deleted (`gh pr merge --merge --delete-branch`), and the Steward's worktree for each is removed. The rest wait, and say why. With "Release right after merging" on in Settings, release follows for the merged.
4. **`steward release`**: for each employee whose branch on origin pins the kit and carries a version with no GitHub release yet, a worktree at that very commit, and its release command run there (`npm run release -- --publish` for a hire). Releases come from the branch, never from a PR's, so a release and its branch never drift apart.
5. **`steward staff [--json] [--no-fetch]`**, and the page's table: each employee's checkout and its branch, the version and kit on its branch (and whether its tools/kit.ts is the Steward's), its latest release and the kit that release carries, the Steward's open PRs (checks, mergeable), a bump prepared here, and the kit version the Steward hands out (the newest kit release, and this checkout's `kit\VERSION`).

(`status --json` is Manor's command, as every agent's is: the employees' status is `staff`.)

### Old kit files

There are no copies of the kit to drift any more. Instead `staff` and the page flag one of the eight hires whose branch still tracks the old kit at its old paths (`src/npu.ts`, `tools/release.ts`, `test/kit.test.ts` and the rest), and `bump` refuses it: it needs converting first. Only the hires ever carried those copies (`OLD_KIT_HIRES`): Reeve has files of its own at some of the same paths (src/accelerators.ts, src/duty.ts, src/install.ts, tools/release.ts), which are never flagged.

## Converting a hire

`tools/convert.ts <worktree> --version <new>` turns a hire that carries its own copy of the kit into one that takes the Steward's: it removes the 22 old kit files (`git rm`), rewrites the hire's imports to `./kit/…`, ignores `src/kit/`, adds `kit.json`, `tools/kit.ts` and `test/agent.test.ts`, makes npm fill the kit first, raises the version, and points the README at the Steward with a section on the kit. It stages; it commits nothing. It refuses any agent that isn't one of the eight hires, before it removes anything.

The eight hires were converted that way, each on a branch **`steward/use-kit-1.0.0`** from its `release-0.3.1`, each in a worktree of its own, at version 0.4.0, then filled from this checkout's kit, typechecked and tested: all eight pass. Their `main` now has `release-0.3.1` merged, with the same tree, so each branch merges cleanly. Those branches aren't pushed. Until they are merged, each hire's main still carries the old kit, and `bump` refuses it.

## Reeve and Heiward

Both take the kit (`usesKit` in Settings), so every stage covers them as it does the hires.

- **Reeve** (Node, with a React dashboard) takes `node` and `spec`: the NPU queue and lock, the accelerator ids, and the queue's rules and vectors, which its Python npu-embed lock runs too. Its own `src/accelerators.ts` stays: it reads `config.json` as the file's owner, and a test checks that the kit's reading agrees with it. Its version is in package.json, package-lock.json and src/mcp.ts, and its release is `npm run release -- --publish`. It fills its kit with `node tools/kit.ts`, as a hire does. It has no `src/app.ts` or `SETTINGS_SPEC` (its page is its own), so it doesn't run the kit's agent checks.
- **Heiward** (C#/.NET, public, on `master`) takes `spec`: its NpuLock tests run the queue's vectors, so the C# lock follows the same protocol. It fills `kit` with its own `toolskit.ps1` (Windows PowerShell 5.1), from the same sources as tools/kit.ts, and its build stops with "run toolskit.ps1" while the kit isn't filled. Its version is `<VersionPrefix>` in HEI.Agent/HEI.Agent.csproj, its tests `dotnet test HEI.Core.Tests`, its release `powershell -File HEI.Agentelease.ps1 -Publish`. A bump changes only kit.json and the .csproj: no npm, no tools/kit.ts. The Steward runs its commands with a .NET that has an SDK (DOTNET_ROOT, then C:	oolsdotnet10, then Program Files'), since Task Scheduler's PATH finds Program Files' runtime first.

**How a logic change reaches Heiward:** the rule changes in the `spec` part, as a document and new or changed vectors, released as a kit version; the Steward's bump moves Heiward's pin, and Heiward's C# tests run the new vectors and fail until a Heiward PR changes the C# side. Kit 2.0 (Next) takes the C# side away.

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

The page at http://steward.localhost:19494/ shows the kit the Steward hands out, the staff's table, a tick box for each employee and a button for each stage, the last stage's results and log, and **Settings**. While a stage runs, the page refreshes itself. The table is refreshed after each stage, on **Refresh**, and when the page is opened more than 10 minutes after the last time. `GET /api/ping` answers `{"app":"steward","name":"Steward","version":"0.1.0","pid":…,"running":true,"busy":false,"stage":null}`, `busy` while a stage runs. Like every agent page, it answers only to its own host names, and its buttons need the token from the page itself.

```powershell
node src/cli.ts bump [--kit <version>] [--employees a,b] [--kit-from <dir>] [--base <ref>]
node src/cli.ts push [--kit <version>] [--employees a,b]
node src/cli.ts merge [--yes] [--employees a,b]
node src/cli.ts release [--kit <version>] [--employees a,b]
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

Its duty works as the hires' does, but it has no rounds of their kind yet: on duty or off, the stages run only when asked. The place for a scheduled check is marked in src/agent.ts, through the kit's `every()`, which pauses off duty (a daily `staff` that notices a new kit release, say).

## Settings

Changed on the page, under **Settings**, and kept in `%USERPROFILE%\.steward\settings.json`. They are used from the next stage on.

| Setting | Default | Meaning |
|---|---|---|
| Employees (`employees`) | the eight hires, Reeve and Heiward | Each: `id`, `name`, `repo` (owner/name), `checkout` (`C:\Projects\<Name>`), `branch` (main; Heiward's master), whether it takes the kit (`usesKit`), its kit `parts`, the command that fills its kit (`fill`), its checks (`test`), its `versionFiles`, and its `release` command. |
| Work folder (`workRoot`) | `%USERPROFILE%\.steward\work` | Where the Steward makes its worktrees, one folder per employee. |
| Release right after merging (`releaseAfterMerge`) | off | Release is a stage of its own unless this is on. |
| The Steward's repository (`stewardRepo`) | Jcollier0120/Steward | Where the kit releases are. |
| Checked at once (`parallel`) | 2 | How many employees a bump tests at the same time, 1 to 10. |

## Files

All in `%USERPROFILE%\.steward` (`%USERPROFILE%\.steward-dev` for a checkout; `STEWARD_HOME` overrides it; `STEWARD_PORT` moves the page):

| File | What |
|---|---|
| `app\` | The installed program (see Install). |
| `home-page.task.xml` | The sign-in task, as it was registered. |
| `settings.json` | Settings. |
| `staff.json` | The staff's table, as last refreshed. |
| `last-stage.json`, `stages.log` | The last stage, with its log; every stage's results, one line each. |
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

- **It acts with your git and gh.** Pushes, PRs, merges and releases are yours. It never force-pushes, never touches your checkouts' working trees (it fetches, and adds and removes worktrees of them), and merges only what is mergeable and green.
- **An employee's checks run on this PC**, with the commands in Settings. A bump is only as good as its tests.
- **A kit version must be released before the employees pin it**, or a fresh clone of theirs couldn't fill its kit. `--kit-from` is for trials only.
- **tools/kit.ts reaches an agent with a bump**, so a change to it waits for the next kit version, and the old one does the filling until then: keep it small, stable and able to read the kit releases it will meet.
- **Checks count as green when there are none.** The hires have no CI, so a PR's mergeability is the only check GitHub makes; the bump ran their tests before the commit.
- **Manor isn't an employee:** it is the next candidate to take the `node` and `web` parts (its settings-kit.ts and settings-panel.js are the kit's already).
- **Kit releases come from GitHub** for the installed copy. Without network it can still bump with `--kit-from`.

## Next

Planned, not in 0.1.0:

- **"Back to Manor" in every agent's header** (a kit change, rolled out by the Steward, after the Surveyor is hired). When an agent is installed alongside Manor, its page header shows Manor's icon and a "Back to <manor name>" link beside the agent's own icon and title, so people move between Manor and the agents easily. The kit's page.ts finds Manor through `%USERPROFILE%\.manor\settings.json`: its name, port, and icon (a path inside `%USERPROFILE%\.manor\app`). The agent serves Manor's icon itself, at `/manor-icon.svg` say, because the page's CSP allows images from `'self'` only. The header shows nothing when Manor isn't installed. It belongs in the `web` part as one script and its CSS, reading `/api/manor` from the agent's own server, so a page that isn't the kit's can include it too. Reeve and Heiward don't use the kit's page, so each needs it separately (Reeve's React dashboard, Heiward's wwwroot).
- **Kit 2.0: one core, two thin drivers.** All decision logic written once, as plain JavaScript (ES2022 modules, JSDoc-typed, with a .d.ts for the TypeScript agents), with no I/O and no Node APIs: a pure, sans-IO **`core`** part. It covers the queue and lock as a state machine (`step(state, observation) → { actions, waitMs }`), ticket ordering and the late, dead and aged rules, holder eviction, the accelerator config's reading, validation and auto order, candidates and pick, failure-marker expiry, games-busy, the id slug, the timings and limits as data in `spec/rules.json`, and the user-facing messages. The TypeScript driver (`node`) performs the core's actions with Node's fs and timers, and stays async so it never blocks an agent's server. A new **`dotnet`** part, C# source files, performs the same actions with Win32/.NET I/O, running the core's JavaScript in **Jint** (pure managed, on NuGet, no native parts, so it works on Arm64, in the Store package and in a self-contained exe); Heiward is its first consumer, its NpuLock internals and Accelerators.cs moving onto it. The `spec` vectors run against both drivers, and the Steward's tests include a small .NET test project, run with the .NET 10 SDK. A logic change is then one edit to the core; only a new kind of I/O action touches the drivers. WebAssembly was considered and rejected: it needs another toolchain and a native runtime in C#, and gains nothing over JavaScript, which the TypeScript agents already run. Kit 1.0.0 is ready for it: the queue, lock and accelerator code sit behind the same module boundaries as before (npu-queue.ts, lock.ts, accelerators.ts, npu.ts), so 2.0 can change their insides without the agents' imports changing much, and the vectors are plain JSON.
- **src/cli.ts into the kit.** Six hires have the same cli.ts; the Auditor's adds `audit` and the Clerk's `search`. A kit `agentCli({ run, extra })` with each agent's own commands passed in would take it.
- **Reeve, Heiward and Manor take the kit** (above), and the stages stop passing them over.
- **Scheduled checks** in the Steward's duty: a daily `staff`, noticing a new kit release or a release lagging its branch.
- **app.ts's shared half** (`isDevCheckout`, `placeFor` and the place they compute) could be the kit's too, leaving the agent's app.ts its `APP` and port.

## Development

Node 22.18+ runs the TypeScript directly; there is no build step and no runtime dependency.

```powershell
npm install          # TypeScript and @types/node, for the typecheck
npm run kit          # fill src\kit (and the fixture's) from kit\
npm test             # the Steward's tests and the kit's, on the fixture; pretest fills the kit
npm run typecheck
npm run release      # artifacts\steward\Steward-<version>.zip and its SHA256SUMS.txt; -- --install installs it
npm run kit-release  # artifacts\kit\kit-<version>.zip and its SHA256SUMS.txt; -- --publish makes kit-v<version>
```

The Steward takes its own kit the way a hire does: `kit.json` pins it (the `node` and `web` parts), and `npm run kit` fills `src\kit\` from this checkout's `kit\` (`--from kit`). The tests make fake employees with git in temporary folders, with gh standing in, and serve tools/kit.ts a kit release from a local server; nothing reaches GitHub but one lookup of a release that isn't there. A checkout runs as the development copy, in `%USERPROFILE%\.steward-dev` on port 29494.
