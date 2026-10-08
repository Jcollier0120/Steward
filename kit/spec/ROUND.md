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
| `waiting` | string, or absent | The round was held for the agent's required settings (onboarding's `required`), and ran nothing: what it waits for, in words ("Thunderbird or Mail accounts"), as `/api/ping`'s `needsSettings.text`. `ok` is null, `error` null and `next` null; `started` and `finished` are when it was held. Absent otherwise. Since kit 2.34.0. |
| `timedOut` | true, or absent | `true` when the round ran past its time limit (three intervals and at least two hours, unless the agent gives its own) and was let go: `ok` is false and `error` says so, and the next round tries again. Absent otherwise. Since kit 2.34.0. |
| `error` | string or null | When it threw: the error's message, its first line, trimmed, at most 500 characters (`"it failed"` when that is empty). `null` when `ok`. |
| `everyMs` | number | The interval between rounds, in milliseconds, as it was when the round ended. Each wait varies by ±10% about it. |
| `next` | ISO 8601 (UTC) or null | When the next scheduled round is due. `null` when none is coming: the agent is off duty (only Run now runs a round then), or the schedule was stopped. The same as `/api/ping`'s `nextRunAt` just after the round. |

Times are what `Date.prototype.toISOString()` gives: `YYYY-MM-DDTHH:mm:ss.sssZ`.

## When it is written

- **At the end of each round that runs**: a scheduled one, or one from Run now. A scheduled round skipped off duty runs nothing and writes nothing. Nothing is written when a round starts, so a round under way shows only in `/api/ping`'s `runningSince`.
- **At each scheduled round held for the agent's required settings** (since kit 2.34.0): an entry with `waiting`, so the file never goes quiet while the agent waits for the person. Before 2.34.0 a held round wrote nothing, and an agent waiting for its settings looked like one whose rounds had stopped.
- **When a round runs past its time limit** (since kit 2.34.0): an entry with `timedOut`, at the limit, and the next round is scheduled. The job let go may still end later; that changes nothing in the file.
- **Read, changed, written whole:** the writer reads the file, replaces its own schedule's entry, keeps every other entry and any other top-level key, and writes the file through a temporary file and a rename (store.ts's `writeJson`), so a reader never sees half a file. A file that can't be read, or isn't an object, is started afresh.
- **Never at the round's cost:** a file that can't be written (a data folder that can't be written to, say) is said once in the agent's log, and the rounds go on as before.
- **Kept across restarts:** the file stays when the agent stops; a schedule writes its entry again after its first round in the next process. A schedule the agent no longer runs leaves its last entry.

## For a reader

- Read the file with any JSON reader; a byte-order mark may be skipped. A missing file means no round has ended since the agent took kit 2.8.0 (or it doesn't run its rounds with the kit's scheduler).
- Skip keys you don't know: later kit versions may add some, in an entry or beside `rounds`.
- How long since `finished`, against `everyMs`, says whether the rounds are keeping up; `next` in the past while the agent is on duty says a round is overdue or under way.
- An entry with `waiting` is an agent waiting for the person, not one that has stopped: say what it waits for, not that its rounds are late.

## Pace (kit 2.43.0)

Manor's settings.json `"backgroundPace"` sets how every agent's scheduled rounds share the PC: `gentle` (the default) or `full` (as before).

- **First rounds one at a time.** A schedule whose round has never gone through waits for its first round in one line with the other agents' first rounds (the lock folder `<locks>irst-rounds`, one slot, the kit's line as the NPU's), and runs it once the one before it has finished. The first round is the heavy one; the rounds after it only catch up on what changed, so nothing else waits.
  - round.json's `"wentThrough": { "<schedule>": "<ISO time>" }` says which have gone through. A round.json from before 2.43.0, with rounds but no `wentThrough`, counts every schedule it names as through: updating an agent never puts it in the line.
  - A round that waited six hours without its turn is recorded with `"ok": null` and `"waiting"`, and waits again at its next round. A holder whose process has gone gives up its place at once.
- **Below-normal priority.** A scheduled round runs at below-normal priority, and the programs it starts take that class too.
- **A round asked for** (Run now) never waits, and runs at normal priority.
- **Settling into the manor.** While a first round waits its turn, or a long one runs (a look's `firstRound`: Reeve's, Heiward's), the status pill says "Settling in" and the page shows a banner in the role's colour: the manor's door, with footsteps walking up to it, and a line saying it is new and takes longer this once. Its state's `firstRound` is `waiting` or `running`.

An agent that doesn't run its rounds with every() (Heiward's .NET scans) takes the same line through the kit's .NET lock on the same folder.

## Where it is implemented

| Part | Implementation |
|---|---|
| node | `schedule.ts`'s `every()`, since kit 2.8.0 (`roundFile()`, `RoundRecord`, `roundError()`). Every Node agent that runs its rounds with `every()` writes it, with nothing to do. |
| dotnet | **Node-only for now.** The dotnet part has no scheduler (Heiward schedules its own work), so Heiward doesn't write round.json yet. A .NET agent that does writes this same shape, in its own data folder. |
