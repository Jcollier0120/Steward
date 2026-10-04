# round.json: each round's outcome

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/ROUND.md` in [Jcollier0120/Steward](https://github.com/Jcollier0120/Steward). A change to the file's shape is a kit change: made here, released as a kit version, and taken by every agent from that release. Since kit 2.8.0.

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
| `ok` | boolean | `true` when the round went through, `false` when it threw. |
| `error` | string or null | When it threw: the error's message, its first line, trimmed, at most 500 characters (`"it failed"` when that is empty). `null` when `ok`. |
| `everyMs` | number | The interval between rounds, in milliseconds, as it was when the round ended. Each wait varies by ±10% about it. |
| `next` | ISO 8601 (UTC) or null | When the next scheduled round is due. `null` when none is coming: the agent is off duty (only Run now runs a round then), or the schedule was stopped. The same as `/api/ping`'s `nextRunAt` just after the round. |

Times are what `Date.prototype.toISOString()` gives: `YYYY-MM-DDTHH:mm:ss.sssZ`.

## When it is written

- **At the end of each round that runs**: a scheduled one, or one from Run now. A scheduled round skipped off duty runs nothing and writes nothing. Nothing is written when a round starts, so a round under way shows only in `/api/ping`'s `runningSince`.
- **Read, changed, written whole:** the writer reads the file, replaces its own schedule's entry, keeps every other entry and any other top-level key, and writes the file through a temporary file and a rename (store.ts's `writeJson`), so a reader never sees half a file. A file that can't be read, or isn't an object, is started afresh.
- **Never at the round's cost:** a file that can't be written (a data folder that can't be written to, say) is said once in the agent's log, and the rounds go on as before.
- **Kept across restarts:** the file stays when the agent stops; a schedule writes its entry again after its first round in the next process. A schedule the agent no longer runs leaves its last entry.

## For a reader

- Read the file with any JSON reader; a byte-order mark may be skipped. A missing file means no round has ended since the agent took kit 2.8.0 (or it doesn't run its rounds with the kit's scheduler).
- Skip keys you don't know: later kit versions may add some, in an entry or beside `rounds`.
- How long since `finished`, against `everyMs`, says whether the rounds are keeping up; `next` in the past while the agent is on duty says a round is overdue or under way.

## Where it is implemented

| Part | Implementation |
|---|---|
| node | `schedule.ts`'s `every()`, since kit 2.8.0 (`roundFile()`, `RoundRecord`, `roundError()`). Every Node agent that runs its rounds with `every()` writes it, with nothing to do. |
| dotnet | **Node-only for now.** The dotnet part has no scheduler (Heiward schedules its own work), so Heiward doesn't write round.json yet. A .NET agent that does writes this same shape, in its own data folder. |
