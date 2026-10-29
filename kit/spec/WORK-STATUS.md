# An agent's work status

Since kit 2.76.0, every agent answers `GET /api/peer/work` on its page with its **work status**: what it may run at once, what it runs, what waits and in which line, the PC's shared lines, its recent results and what holds its work up. Manor's Work page gathers it from each agent on the PC, and, with Other PCs on, from each PC on the licence over Manor's link (`GET /agents/<id>/work`, which the other PC's Manor hands to its agent as `GET /api/peer/work`). It is read only.

The kit's server answers it for every agent (`node/server.ts`), built by `workStatus()` (`node/work-status.ts`) from what the kit knows, with what the agent adds (`serve({ work })`). An agent in another language answers the same shape.

## The shape

```jsonc
{
  "v": 1,                                   // a reader takes v 1 and ignores fields it doesn't know
  "agent": { "id": "steward", "name": "Steward", "version": "0.36.46", "pid": 1234 },
  "at": "2026-10-15T11:00:00.000Z",
  "pc": { "name": "DESKTOP-1", "processors": 18, "memoryMb": 32000, "freeMemoryMb": 12000,
          "busy": 0.42, "pace": "gentle", "checksCap": 3333,
          "npu": { "pace": "full", "why": null, "lookedAt": "…" } },
  "slots": [ { "kind": "stage", "name": "Stages at once", "of": 2, "used": 1 } ],
  "running": [ { "id": "w3", "kind": "check", "what": "Reeve#212's checks", "repo": "me/reeve",
                 "commit": "…", "tree": "…", "pr": 212, "parent": "w1",
                 "since": "…", "runningSince": "…" } ],
  "waiting": [ { "id": "w4", "kind": "trial", "what": "…", "since": "…",
                 "line": "checks", "inLineSince": "…", "ahead": 2 } ],
  "lines": [ { "id": "checks", "kind": "checks", "name": "The checks pace's turns", "slots": 3,
               "holders": [ { "who": "assayer", "what": "npm test", "pid": 99, "since": "…", "work": "w2" } ],
               "waiting": [ { "who": "steward", "what": "node --test", "pid": 98, "since": "…", "work": "w4" } ] },
             { "id": "accelerator:npu", "kind": "accelerator", "name": "npu", "slots": 1, "holders": [], "waiting": [],
               "today": { "day": "2026-10-18", "busyMs": 206312, "requests": 191, "promptTokens": 78391, "answerTokens": 11782 } } ],
  "results": [ { "kind": "checks", "repo": "me/reeve", "tree": "…", "commit": "…", "ok": true, "at": "…" } ],
  "blocked": [ { "kind": "version-queue", "what": "Reeve's version queue", "by": "#233 (v0.18.2), a draft",
                 "since": "…", "repo": "me/reeve", "pr": 233, "url": "…", "waiting": ["#236"] } ]
}
```

- **`slots`**: the agent's own limits, each kind of work it runs at once (`of`, null for none) and how many it runs now. The kit has none of its own; the Steward gives its stages.
- **`running`, `waiting`**: its **tasks**. A task has a kind (one word: `round`, `check`, `trial`, `whole-suite`…), what it is in words, and what it runs on when that's a repository's code: the repository, the commit, its tree, the PR. `parent` is the task it is part of. A running task has `runningSince`; a waiting one the `line` it waits in (a line's id), `inLineSince`, and `ahead`, how many in that line have waited longer.
- **`lines`**: the lines work waits in, with who holds a place (`holders`) and who waits (`waiting`), since when. The PC's are the same from every agent on it: `checks` (the checks pace's turns, `slots` null when the pace is full), `work` (the kit pace's work line), `first-round`, and `accelerator:<id>` for each accelerator. An agent may add its own, `<agent>:<name>`, kind `agent`. A place names its agent (`who`) when the line says, else its process (`pid`); `work` is that agent's task. Since kit 2.85.0 an accelerator's line has its **`today`**, every agent's requests on it since midnight (the PC's own), added together: their time (`busyMs`; the NPU serves one at a time, so the time it was busy), how many, and their prompt and answer tokens; left out when nothing was counted (token-tally.ts' `busyToday`).
- **`pc.npu`** (kit 2.85.0): the NPU's pace for the agents' backlogs ([ACCELERATORS.md](ACCELERATORS.md#the-npu-at-full-speed-kit-2850)), `full`, or `gentle` and `why`, as the last shared look at the PC's room found it (`lookedAt`, null before any): the status never looks itself. Left out where no NPU takes chat first.
- **`results`**: what its work came to, **one per kind, repository and code tree** (git's tree id: the same code has the same tree, whatever the commit), the latest; the newest first, at most 50. A result with no tree known has `tree` null and its commit. Since kit 2.77.0 a result also says the `commands` it ran, the `node` (Node.js's version) and `platform` (the OS) it ran on, and, for a pass taken from another PC, `from` (`{ id, name }`: that PC).
- **`blocked`**: what holds its work up, by what, since when: a version queue held by a PR that isn't ready, with what waits behind it.

## In the kit

- **Tasks** (`node/work-tasks.ts`): `withWork(fields, fn)` runs `fn` as a task, ended however it ends; `startWork(fields)` gives a handle to `waitIn(line)`, `running()`, `set(fields)` and `done()`. A task started inside another's `withWork` is its part; work started in `outsideWork(fn)` is a task of its own, for a job that outlives the task that started it. Every scheduled round is a task (`node/schedule.ts`): waiting in the first-round line or the work line, then running, the work it tracks its part.
- **The checks pace's runs** (`node/checks-pace.ts`): each paced run's launcher writes `<pid>.run` in `checksRunsDir()` while it runs: `waiting -1 <since>`, `turn <n> <since>` or `running -1 <since>`, then a line naming the agent, its task and what it runs, tab apart (`KIT_CHECKS_WHO`, set by `pacedCommand` from the task it runs in). A task whose every check waits for a turn waits in the `checks` line. A file whose launcher has gone is removed by the next reader.
- **The Seneschal's turns** (`node/seneschal.ts`, kit 2.78.1): where the Seneschal is on the PC, an agent asks it for its work's turn (`seneschalTurn`), and runs that work under its lease (`turn.hold`) with `KIT_CHECKS_TURN` set, so the launcher takes no turn and writes no `.run` file: the Seneschal counts it among its own, and hands out only the checks pace's turns the PC's other runs don't hold. While it waits, its task waits in the line `seneschal:<lane>`. With no Seneschal, one off duty, or no Workshop Pro, `seneschalTurn` answers null and the work runs at the checks pace as before. The Wright's jobs and Reeve's heavy work ask too (kit 2.80.0, Seneschal 0.3.0), as turn kinds (`wright-job`, `reeve-job`) named by their `job`, not a commit; an asker that says `defer` is answered `{ later }` when its turn doesn't come in its wait, and waits for its next round instead of running beside a full PC. A repository's own checks (`checks`, kit 2.93.0, Seneschal 0.5.0 and 0.5.2) name where their code is got from (`remote`) and the tools they need (`needs.tools`), and may carry uncommitted changes as a patch on a pushed commit; a worker that says `clones` (and `patches`) is handed them for any repository, gets the code itself with its own PC's sign-in, and reports what that took (`prepMs`).
- **Results** (`node/work-status.ts`): `recordResult({ kind, repo, tree, commit, ok, note })` keeps the latest per key in `work-results.json` (200 of them); `resultFor({ kind, repo, tree })` finds one. `codeAt(dir)` reads a checkout's commit, tree and whether it's clean, for a task's fields and before its result is kept: the Steward keeps each check run's this way, unless a kit under trial filled it.

## A pass anywhere, for the same code

Since kit 2.77.0 an agent about to run work on a clean checkout can take a pass of exactly that code instead, from this PC or another PC on the licence.

- **`passFor({ kind, repo, tree, commands })`** looks for one: this PC's own result for the tree first, else another PC's through Manor (`passOnOtherPcs`, `node/manor.ts`). Either is taken only when `whyNotPass` finds nothing against it:
  - it **passed**;
  - it is of the **same kind** (`checks` is the whole checks; `affected checks`, only the tests a change reached, never stands in for them);
  - it is for the **same repository** and **tree**;
  - it is under **a day** old (`PASS_STANDS_MS`), and not more than ten minutes ahead of this PC's clock;
  - it ran on the **same Node.js major and OS** as here (`toolchainHere()`). The kit, the lockfile and everything else the tree holds are already the same, since the tree is;
  - it ran **every command asked**.

  A failure here newer than the other PC's pass, and that pass isn't taken. A failure elsewhere never stands in for anything. A pass taken from another PC is kept here as that PC's (`from`, at the time it ran there). A result from before kit 2.77.0 says no Node.js or OS, and never stands in.
- **`GET /api/peer/result?kind=<kind>&repo=<owner/name>&tree=<tree>`** (`node/server.ts`, `peerResult`) answers `{ "v": 1, "result": … }` with this agent's own result for that tree, read from all it keeps, or `null`. It never passes on a pass it took from another PC. It is read only, so Manor's link passes it on as `GET /agents/<id>/result`.
- **Manor** (0.16.163 and later) answers `GET /api/peers/result?agent=<id>&kind=…&repo=…&tree=…&node=<major>&platform=…` on this PC, with an `X-Castellan-Peer` header, as the first pass from the PCs it hears from, asked all at once for a few seconds: `{ "v": 1, "result": { …, "pc": { "id", "name" } } | null, "asked": <n>, "why": … }`. With Other PCs off it asks no one. An older Manor's 404, like any other answer that isn't a pass, is no pass: the work runs.
