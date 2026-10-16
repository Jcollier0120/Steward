# round.json: each round's outcome

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/ROUND.md` in the Steward's repository, and `src/kit/spec/ROUND.md` in every agent that takes the part. A change to the file's shape is a kit change: made here, released as a kit version, and taken by every agent from that release. Since kit 2.8.0.

Every agent that runs its rounds with the kit's scheduler leaves each round's outcome in one file, the same way, so a reader outside the agent (the Surveyor, which checks every agent's health and changes nothing) reads one file per agent instead of each agent's own report.json, status.json or state.json.

## Where

`round.json` in the agent's data folder: the folder the kit's `store.ts` `dataFile()` uses, `dataDir` in the agent's `src/app.ts` (`%USERPROFILE%\.<id>`, `%USERPROFILE%\.<id>-dev` for a checkout, or `<ID>_HOME`).

## The shape

```json
{
  "rounds": {
    "round": {
      "started": "2026-10-03T14:00:00.000Z",
      "finished": "2026-10-03T14:01:12.345Z",
      "ok": true,
      "error": null,
      "everyMs": 600000,
      "next": "2026-10-03T14:11:05.000Z"
    }
  }
}
```

`rounds` holds one entry per schedule, by its name: the `name` given to `every()`, or `"round"` when none is. An agent may run several schedules in one process (the Miller grinds and names on two), and each keeps its own entry. Each entry is that schedule's **last round to end**:

| Key | Type | What |
|---|---|---|
| `started` | ISO 8601 (UTC) | When the round began. |
| `finished` | ISO 8601 (UTC) | When it ended, whether or not it went through. |
| `ok` | boolean or null | `true` when the round went through, `false` when it threw or ran past its time limit. `null` when it threw only because this PC was offline (kit 2.15.0, OFFLINE.md): it waited for the network, and is no failure; or when it was held for the agent's required settings (`waiting`, kit 2.34.0). |
| `offline` | true, or absent | `true` when `ok` is null: the round waited for the network. Absent otherwise. Since kit 2.15.0. |
| `waiting` | string, or absent | The round was held for the agent's required settings (onboarding's `required`), and ran nothing: what it waits for, in words ("Thunderbird or Mail accounts"), as `/api/ping`'s `needsSettings.text`. `ok` is null, `error` null and `next` null; `started` and `finished` are when it was first held for that reason (kit 2.71.3; before, when it was last held). Absent otherwise. Since kit 2.34.0. Also a round whose turn didn't come in the first-round line (kit 2.43.3) or the work line (kit 2.56.0) before its next was due: see Pace. |
| `timedOut` | true, or absent | `true` when the round ran past its time limit (three intervals and at least two hours, unless the agent gives its own) and was let go: `ok` is false and `error` says so, and the next round tries again. Absent otherwise. Since kit 2.34.0. |
| `error` | string or null | When it threw: the error's message, its first line, trimmed, at most 500 characters (`"it failed"` when that is empty). `null` when `ok`. |
| `everyMs` | number | The interval between rounds, in milliseconds, as it was when the round ended, kept to the whole second from a minute up (kit 2.72.0). On the clock (see The clock), the rounds fall on its slots; off it, each wait varies by ±10% about it. |
| `phaseMs` | number, or absent | On the clock: how far into each of its slots the schedule's rounds fall, in milliseconds (whole minutes). Absent off the clock. Since kit 2.72.0. |
| `next` | ISO 8601 (UTC) or null | When the next scheduled round is due. `null` when none is coming: the agent is off duty (only Run now runs a round then), or the schedule was stopped. The same as `/api/ping`'s `nextRunAt` just after the round. |
| `turn` | `"first"`, `"work"`, or absent | Beside `waiting`, when the round waited its turn in a line (`first`: the first-round line; `work`: the work line) rather than for the person. A reader says it waited its turn, never that it waits for the person's settings. A first-round wait recorded before kit 2.56.0 has no `turn`; its `waiting` begins "its first round:". Since kit 2.56.0. |
| `waitedMs` | number, or absent | How long the round waited its turn (the first-round line, the work line) before it ran, in milliseconds, when that was a second or more. `started` is when it began to run. Since kit 2.56.0. |
| `cpuMs` | number, or absent | The processor time the agent's own process used in the round, in milliseconds; the programs it started (git, ffmpeg) aren't counted. Absent when the round never ran (it waited, or was held). Since kit 2.56.0. |
| `memoryMb` | number, or absent | The most memory the agent's process held during the round, in megabytes, sampled every five seconds. Absent when it never ran. Since kit 2.56.0. |

Times are what `Date.prototype.toISOString()` gives: `YYYY-MM-DDTHH:mm:ss.sssZ`.

## When it is written

- **At the end of each round that runs**: a scheduled one, or one from Run now. A scheduled round skipped off duty runs nothing and writes nothing. Nothing is written when a round starts, so a round under way shows only in `/api/ping`'s `runningSince`.
- **At the first scheduled round held for the agent's required settings** (since kit 2.34.0), or for its ended trial: an entry with `waiting`, so a reader sees what the agent waits for, never a schedule gone quiet. Before 2.34.0 a held round wrote nothing, and an agent waiting for its settings looked like one whose rounds had stopped. From kit 2.71.3 the entry is written again only when what it waits for (or its `everyMs`) changes, not at every interval: a reader takes an entry with `waiting` for an agent waiting for the person, however old (below), never for one whose rounds are late.
- **When a round runs past its time limit** (since kit 2.34.0): an entry with `timedOut`, at the limit, and the next round is scheduled. The job let go may still end later; that changes nothing in the file.
- **Read, changed, written whole:** the writer reads the file, replaces its own schedule's entry, keeps every other entry and any other top-level key, and writes the file through a temporary file and a rename (store.ts's `writeJson`), so a reader never sees half a file. A write that would change nothing leaves the file as it is (kit 2.71.3). A file that can't be read, or isn't an object, is started afresh.
- **Never at the round's cost:** a file that can't be written (a data folder that can't be written to, say) is said once in the agent's log, and the rounds go on as before.
- **Kept across restarts:** the file stays when the agent stops; a schedule writes its entry again after its first round in the next process. A schedule the agent no longer runs leaves its last entry.

## For a reader

- Read the file with any JSON reader; a byte-order mark may be skipped. A missing file means no round has ended since the agent took kit 2.8.0 (or it doesn't run its rounds with the kit's scheduler).
- Skip keys you don't know: later kit versions may add some, in an entry or beside `rounds`.
- How long since `finished`, against `everyMs`, says whether the rounds are keeping up; `next` in the past while the agent is on duty says a round is overdue or under way.
- An entry with `waiting` is an agent waiting for the person, not one that has stopped: say what it waits for, not that its rounds are late. With `turn` (or a `waiting` that begins "its first round:" or "its turn:") it waited its turn behind other agents instead: nothing for the person to do.

## The clock (kit 2.72.0)

The manor's agents share one 30-minute clock, so their rounds don't drift and don't all fire in the same minute.

- **Intervals that fit it:** whole minutes that divide 30 minutes (1, 2, 3, 5, 6, 10, 15, 30), or multiples of 30 minutes that divide the day (1, 2, 3, 4, 6, 8, 12, 24 hours; 90 minutes). A schedule with one of these is on the clock; any other interval keeps the old way, each wait counted from the last round and varied by ±10%.
- **Slots:** a schedule's rounds fall on multiples of its interval counted from local midnight, plus its phase: a 30-minute round at :00 and :30, a 6-hourly one at 00:00, 06:00, 12:00 and 18:00, in this PC's time.
- **Phase:** whole minutes, under both the interval and 30 minutes, from the agent's id and the schedule's name (the same on every PC and at every start), unless the agent gives `every()` a `phaseMs`. An hourly round falls 0 to 29 minutes past the hour; a 5-minute round 0 to 4 minutes into each five.
- **The next round** is the first slot at least half an interval after the last round ended, so a round that waited its turn or ran long keeps its slot, and one asked for (Run now) doesn't bring the next one forward.
- The first round after the agent starts still comes after its start's stagger (Pace), then the rounds go on the clock.

## Pace (kit 2.43.3)

Manor's settings.json `"backgroundPace"` sets how every agent's scheduled rounds share the PC: `gentle` (the default) or `full` (as before).

- **First rounds one at a time.** A schedule whose round has never gone through waits for its first round in one line with the other agents' first rounds (the lock folder `<locks>irst-rounds`, one slot, the kit's line as the NPU's), and runs it once the one before it has finished. The first round is the heavy one; the rounds after it only catch up on what changed, so nothing else waits.
  - round.json's `"wentThrough": { "<schedule>": "<ISO time>" }` says which have gone through. A round.json from before 2.43.3, with rounds but no `wentThrough`, counts every schedule it names as through: updating an agent never puts it in the line.
  - A round that waited six hours without its turn is recorded with `"ok": null` and `"waiting"`, and waits again at its next round. A holder keeps its turn for its round's time limit, and 12 hours at the least (a first scan of every drive takes hours); one whose process has gone gives up its place at once.
- **A few agents at a time** (kit 2.56.0, the work line). Every scheduled round, at either pace, takes a slot in one line shared by every agent on the PC (the lock folders `<locks>\work`, `work.2` …, the kit's line as the NPU's): as many side by side as Manor's settings.json `"agentsAtOnce"` says (1 to 6; 0 lifts the line), or 2 at a gentle pace and 4 at a full one when it doesn't. The rest wait their turn, first come, first served.
  - **Fewer on a busy PC.** Before it joins, a round looks at the PC's load, from Node's own counters over a second: with the processor 60% busy or more, or less than 15% of memory free, it may take only the first slot (one at a time); at 35% busy, half of them, rounded up. The other agents' rounds count in that load, which is the point.
  - A holder keeps its slot for its round's time limit, and one whose process has gone gives it up at once. A round whose turn doesn't come before its next is due (its interval, and a minute at the least) is recorded with `"ok": null` and `"waiting"`, and waits again at its next round. A first round takes its first-round turn, then its work turn.
  - While a round waits, its state's `waiting` (`/api/ping`'s `rounds`) says so, so a schedule waiting its turn is never taken for one with nothing coming.
  - A schedule whose rounds are light (`every()`'s `light`: a few requests, a look at a file) runs them at once, outside the line, as a round asked for always does. `light` may be a function, asked before each round: light while nothing is due, say.
  - `MANOR_AGENTS_AT_ONCE` says instead of Manor (0 for no line). Under node --test there is no line unless it says.
- **Below-normal priority.** A scheduled round runs at below-normal priority, and the programs it starts take that class too.
- **Heiward's background pace** (kit 2.50.0, `node/gentle.ts`). On Windows the agent runs as Heiward does in the background, from its start and in its scheduled rounds:
  - Windows' efficiency mode (EcoQoS);
  - a very low disk priority;
  - a hard processor cap, on a job holding the agent and every program it starts: a quarter of the processor, and two processors' worth at most.

  They are set from outside the process by the agent's PowerShell worker, with `node/gentle.cs` compiled once to `<locks>\..\kit\gentle-<hash>.dll`, shared by every agent, and only when what's wanted changes. The worker then joins the job itself (kit 2.73.0), so nothing the agent runs is outside it. `KIT_GENTLE=0` leaves an agent to priority alone.

  **The pace is the owner's setting alone** (kit 2.73.0): Manor's Settings `"backgroundPace"`, gentle or full. Nothing else lifts it: not a page being looked at (`pageInUse()` does nothing now), not a round asked for. What a page shows is what the agent costs in the background, and the worker runs PowerShell only when the setting changes.

  A long-lived process that doesn't run its work with `every()` (an MCP server, a page of its own, a scheduled job) calls `containSelf()` first, before it starts anything. That sets it at the setting now, and reads the setting again every 5 minutes.

  Model servers leave the asker's job (`node/apart.ts`, `checks-pace.exe apart`, `CREATE_BREAKAWAY_FROM_JOB`): they serve every agent, so an asker's cap isn't theirs. The gentle job allows breakaway for this. A job that doesn't (Task Scheduler's, a terminal's) keeps them, and they stay in it.
- **The checks pace** (kit 2.70.0, its limits as below from 2.73.0, its cap and turns from 2.74.2; `node/checks-pace.ts`). Test runs, type checks, installs and builds an agent starts, whatever its pace, go through `pacedCommand()`: a launcher (`node/checks-pace.cs`, compiled once to `<locks>\..\kit\checks-pace-<hash>.exe`) starts the command suspended in a job with a hard processor cap (a third of the processor by default, from kit 2.74.2; a quarter before, four processors' worth at most in 2.74.1 and two, the gentle pace's, up to 2.74.0), memory caps (per program an eighth of the PC's, 2 to 6 GB; the job a quarter, 4 to 12 GB) and below-normal priority, then lets it run. At most three paced runs go at once on the PC (two before kit 2.74.2) (named mutexes `Local\kit-checks-turn-<n>`; a run inside another's takes none); the rest wait, 20 minutes at most. The job (`Local\kit-checks-pace`) is one for the PC, so check runs side by side share the cap; it ends what is left in it once no launcher holds it. Manor's Settings pace (`"backgroundPace"`) at full lifts it, as it lifts the agents' own pace: one switch. While that is gentle, settings.json `"checksPace"` (or `KIT_CHECKS_PACE`) may set the cap: 10 to 100 (percent), or `"full"` for none. Nothing else lifts it (no per-run fast). Under node --test nothing is paced unless `KIT_CHECKS_PACE` says. Since a paced run is slower (kit 2.74.2), a runner stretches its time limit by as much as the cap slows it (`pacedSlower`: the whole processor against the share the cap leaves, 4 at least; 9 for two of 18 processors) plus the 20 minutes it may wait for a turn (`Paced.slower`, `Paced.waitMs`); and a `node --test` command (node itself, not an npm script) gets `--test-concurrency` of twice the processors the cap leaves, 2 at least (`pacedTestConcurrency`), not a test file per processor but one. The command leaves the agent's own gentle job before it joins the checks job (kit 2.74.6; `CREATE_BREAKAWAY_FROM_JOB`, which the gentle job allows), so the checks pace's cap holds it and the agent's tighter one doesn't as well; where Windows refuses, it stays in the jobs it is in. The command is told how much slower it runs, in `KIT_CHECKS_SLOWER` (kit 2.74.6; `checksSlower()`), and a test stretches its own waits and timeouts by it with `paced(ms)`: at the pace it takes longer, never failing for want of the processor.
- **The PC kept awake for work** (kit 2.74.8, `node/awake.ts`). A round's job gets `awake(what)`, and anything in the agent may call `stayAwake(what)` or `whileAwake(what, fn)`: while any hold is had, Windows doesn't sleep on its own. A helper holds it (`node/awake.cs`, compiled once to `<locks>\..\kit\awake-<hash>.exe`, `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`), started for the first hold and let go after the last, or when the agent ends. A round's holds end with the round at the latest. Idle sleep only: a sleep the person chooses (Start's Sleep, the power button, the lid) still happens, and the display still turns off. Only for work (checks, merges, releases), never a round that only looks: a hold resets Windows' idle timer. Other platforms do nothing, and under node --test nothing is held unless a test sets `setAwakeDeps`.
- **The PC woken for work due at set times** (kit 2.78.2, `node/wake.ts`). A hold keeps an awake PC from sleeping on its own; it can't bring back one that has gone to sleep. An agent with work due at set times (the Steward's builds) keeps a task in Task Scheduler (`\<App>\Wake`) in step with them: `keepWakeTask(plan)` whenever the times may have changed, `keepWakeTask(null)` when there is nothing to wake for. The task wakes the PC `beforeMinutes` before each time, only on AC (never on battery, never late), and runs the awake helper with `--for <holdMinutes × 60>`, the work's longest. The agent ends its run with `endWakeTask()` once the work is done (not when the agent merely stops: an update's restart leaves the PC held for it). While the task runs, Task Scheduler keeps the PC out of sleep, with the screen off. Uninstall removes the task.

  What was measured on a Modern Standby PC (a Snapdragon X; Kernel-Power 506/507/566, `powercfg /sleepstudy`, `powercfg /requests`, and a probe that beat once a second and logged its gaps), 2026-10-16, plugged in:
  - **A chosen sleep can't be blocked.** A sleep the person chooses (Start's Sleep, the power button, the lid; 566's reason SleepButton, 506's SC_MONITORPOWER) goes from screen off to sleep within seconds, whatever an app holds: the awake helpers' ES_SYSTEM_REQUIRED held it no more than nothing. In sleep the agent's timers and rounds stop: the night before, sleep lasted from 00:35 to 08:39, and the 08:00 build waited for the mouse.
  - **Idle never sleeps here.** Where the plan never sleeps on its own plugged in, idle only turns the screen off ("Video Idle Timeout"), and the PC goes on working: a hold changes nothing there.
  - **A wake timer brings the PC back.** A task with `WakeToRun` (or Windows' maintenance, at 03:29) brings the PC out of sleep when wake timers are allowed (Power Options' "Allow wake timers"; on that PC, enabled plugged in and disabled on battery, the default). It wakes to screen off, not to the screen: no 507, and the screen stays dark.
  - **A running task holds the PC.** While a task that woke the PC runs, "PDC Task Client: Maintenance Scheduler" keeps it out of sleep: each sleep the probe chose while one ran ended within a second, back to screen off, and `powercfg /requests` listed the Schedule service's request ("…scheduled task that requested waking the computer") for the task's whole run. With no such task, the maintenance wake at 03:29 went back to sleep 18 s later.
  - **In screen off, apps are throttled.** The Desktop Activity Moderator still paused the task's own processes 5 to 20 s at a time (about 75 to 85 % of the time ran), whether they held nothing, ES_SYSTEM_REQUIRED, `PowerSetRequest`'s ExecutionRequired, away mode or the display. So the agent's work goes on, slower. A packaged app's processes (Claude's, which holds ExecutionRequired) weren't paused.
  - **Not measured:** whether an agent's own hold keeps a woken PC out of sleep once the task has ended. Other holds were held throughout (another agent's helper, an app's audio), and the PC stayed in screen off for 11 minutes after the probe's last task. So the task runs until the work is done rather than handing over to the agent's hold.
  - **Late builds still begin.** A build the PC slept through begins at the agent's first round after it wakes (fresh-start.ts sees the gap), and says it was late.
- **The agent's name in Task Manager** (`node/named.ts`). `open` starts the page through a launcher named for the agent (`node/named.cs`, compiled once per agent to `<locks>\..\kit\named-<id>-<hash>.exe`, its title the agent's name), so Task Manager's Processes tab shows the agent by name with what its page runs inside, not as "Node.js JavaScript Runtime". The launcher starts the page suspended in a job of the agent's own (`Local\Castellan-<id>`, a checkout's `<id>-dev`), so a tool can find the agent's processes by its id. The job sets no limits and ends nothing: what the page starts detached (an install's watcher, which must outlive the page it replaces; a model server) outlives it, as before. It allows breakaway, so model servers started apart still leave it, and the gentle job nests inside it. The page builds its launcher 30 to 120 s after it starts (random, as agents start together), never `open`, which Manor waits on: the page started after that is named. Where it can't be had (not Windows, the compiler refused), the page starts as node.exe, as before. Under node --test nothing is built unless `KIT_NAMED=1`.
- **Rounds wait for Manor's update** (kit 2.75.2, `node/update-hold.ts`). Manor installs an automatic update only while the agent is idle, and looks every minute: an agent whose rounds ran back to back was never idle then, and waited for hours. While Manor's files say it has one due (`updates.json`: a newer version available, not one it has given up on or waits to try again; `settings.json`: the agent's automatic updates on; and not a version the agent's install refuses), a scheduled round, and `runSoon()`'s, waits, looking again every 30 s, its state's `waiting` saying so: 5 minutes at most for a version, then the rounds go on, and wait again 30 minutes later. A round asked for never waits. An agent that starts rounds beside its schedule asks `updateHold()` first (the Steward does).
- **First rounds come later.** A schedule's first round comes 2 to 15 minutes after the agent starts (random), not 30 s to 3 min, so a PC that has just started isn't ground down by every agent at once.
- **A round asked for** (Run now) never waits, but runs at the pace like any other (kit 2.73.0; before, it lifted the cap, efficiency mode and disk priority until it ended). `runSoon()` starts a scheduled round now, at the pace: for an agent's own reasons (something changed), never the person's.
- **Settling into the manor.** While a first round waits its turn, or a long one runs (a look's `firstRound`: Reeve's, Heiward's), the status pill says "Settling in" and the page shows a banner in the role's colour: the manor's door, with footsteps walking up to it, and a line saying it is new and takes longer this once. Its state's `firstRound` is `waiting` or `running`.

An agent that doesn't run its rounds with every() (Heiward's .NET scans) takes the same first-round line through the kit's .NET lock on the same folder. It doesn't take the work line yet; it keeps its own pace.

## Where it is implemented

| Part | Implementation |
|---|---|
| node | `schedule.ts`'s `every()`, since kit 2.8.0 (`roundFile()`, `RoundRecord`, `roundError()`). Every Node agent that runs its rounds with `every()` writes it, with nothing to do. |
| dotnet | **Node-only for now.** The dotnet part has no scheduler (Heiward schedules its own work), so Heiward doesn't write round.json yet. A .NET agent that does writes this same shape, in its own data folder. |

## Repairs

Since kit 2.51.0 an agent takes repairs another agent asks for (`repair.ts`): the Surveyor, finding something the agent can put right itself, asks it to rather than showing the person a fix to follow, and shows it only when the repair fails or the agent says it needs the person.

- `POST /api/repair` with `{ "kind", "finding"?, "detail"? }`, behind the page's token like every POST. It answers `{ "ok", "did", "needsYou"? }`: whether it is in hand, what it did in a few words, and what only the person can do, when that's so.
- `/api/ping`'s `repairs` lists the kinds it takes. Every agent takes `round`: its scheduled rounds start now, at the pace (`runSoon`), for rounds that stopped coming or went stale. An agent adds its own with `onRepair(kind, fn)` (the Smith's model servers, for example).
- `askRepair(origin, ask)` is the asker's side: the token read from the agent's page, as its own script reads it, then the POST. An agent on an older kit answers 404, which is no answer: the asker shows the finding as before.
