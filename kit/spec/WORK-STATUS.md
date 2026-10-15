# An agent's work status

Since kit 2.75.0, every agent answers `GET /api/peer/work` on its page with its **work status**: what it may run at once, what it runs, what waits and in which line, the PC's shared lines, its recent results and what holds its work up. Manor's Work page gathers it from each agent on the PC, and, with Other PCs on, from each PC on the licence over Manor's link (`GET /agents/<id>/work`, which the other PC's Manor hands to its agent as `GET /api/peer/work`). It is read only.

The kit's server answers it for every agent (`node/server.ts`), built by `workStatus()` (`node/work-status.ts`) from what the kit knows, with what the agent adds (`serve({ work })`). An agent in another language answers the same shape.

## The shape

```jsonc
{
  "v": 1,                                   // a reader takes v 1 and ignores fields it doesn't know
  "agent": { "id": "steward", "name": "Steward", "version": "0.36.46", "pid": 1234 },
  "at": "2026-10-15T11:00:00.000Z",
  "pc": { "name": "DESKTOP-1", "processors": 18, "memoryMb": 32000, "freeMemoryMb": 12000,
          "busy": 0.42, "pace": "gentle", "checksCap": 3333 },
  "slots": [ { "kind": "stage", "name": "Stages at once", "of": 2, "used": 1 } ],
  "running": [ { "id": "w3", "kind": "check", "what": "Reeve#212's checks", "repo": "me/reeve",
                 "commit": "…", "tree": "…", "pr": 212, "parent": "w1",
                 "since": "…", "runningSince": "…" } ],
  "waiting": [ { "id": "w4", "kind": "trial", "what": "…", "since": "…",
                 "line": "checks", "inLineSince": "…", "ahead": 2 } ],
  "lines": [ { "id": "checks", "kind": "checks", "name": "The checks pace's turns", "slots": 3,
               "holders": [ { "who": "assayer", "what": "npm test", "pid": 99, "since": "…", "work": "w2" } ],
               "waiting": [ { "who": "steward", "what": "node --test", "pid": 98, "since": "…", "work": "w4" } ] } ],
  "results": [ { "kind": "checks", "repo": "me/reeve", "tree": "…", "commit": "…", "ok": true, "at": "…" } ],
  "blocked": [ { "kind": "version-queue", "what": "Reeve's version queue", "by": "#233 (v0.18.2), a draft",
                 "since": "…", "repo": "me/reeve", "pr": 233, "url": "…", "waiting": ["#236"] } ]
}
```

- **`slots`**: the agent's own limits, each kind of work it runs at once (`of`, null for none) and how many it runs now. The kit has none of its own; the Steward gives its stages.
- **`running`, `waiting`**: its **tasks**. A task has a kind (one word: `round`, `check`, `trial`, `whole-suite`…), what it is in words, and what it runs on when that's a repository's code: the repository, the commit, its tree, the PR. `parent` is the task it is part of. A running task has `runningSince`; a waiting one the `line` it waits in (a line's id), `inLineSince`, and `ahead`, how many in that line have waited longer.
- **`lines`**: the lines work waits in, with who holds a place (`holders`) and who waits (`waiting`), since when. The PC's are the same from every agent on it: `checks` (the checks pace's turns, `slots` null when the pace is full), `work` (the kit pace's work line), `first-round`, and `accelerator:<id>` for each accelerator. An agent may add its own, `<agent>:<name>`, kind `agent`. A place names its agent (`who`) when the line says, else its process (`pid`); `work` is that agent's task.
- **`results`**: what its work came to, **one per kind, repository and code tree** (git's tree id: the same code has the same tree, whatever the commit), the latest; the newest first, at most 50. A result with no tree known has `tree` null and its commit.
- **`blocked`**: what holds its work up, by what, since when: a version queue held by a PR that isn't ready, with what waits behind it.

## In the kit

- **Tasks** (`node/work-tasks.ts`): `withWork(fields, fn)` runs `fn` as a task, ended however it ends; `startWork(fields)` gives a handle to `waitIn(line)`, `running()`, `set(fields)` and `done()`. A task started inside another's `withWork` is its part; work started in `outsideWork(fn)` is a task of its own, for a job that outlives the task that started it. Every scheduled round is a task (`node/schedule.ts`): waiting in the first-round line or the work line, then running, the work it tracks its part.
- **The checks pace's runs** (`node/checks-pace.ts`): each paced run's launcher writes `<pid>.run` in `checksRunsDir()` while it runs: `waiting -1 <since>`, `turn <n> <since>` or `running -1 <since>`, then a line naming the agent, its task and what it runs, tab apart (`KIT_CHECKS_WHO`, set by `pacedCommand` from the task it runs in). A task whose every check waits for a turn waits in the `checks` line. A file whose launcher has gone is removed by the next reader.
- **Results** (`node/work-status.ts`): `recordResult({ kind, repo, tree, commit, ok, note })` keeps the latest per key in `work-results.json` (200 of them); `resultFor({ kind, repo, tree })` finds one. `codeAt(dir)` reads a checkout's commit, tree and whether it's clean, for a task's fields and before its result is kept: the Steward keeps each check run's this way, unless a kit under trial filled it.
