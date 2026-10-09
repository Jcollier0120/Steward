# The NPU queue

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/NPU-QUEUE.md` in the Steward's repository, and `src/kit/spec/NPU-QUEUE.md` in every agent that takes the part. It was Reeve's `docs/NPU-QUEUE.md`. A change to the protocol is a kit change: made here, with the vectors beside it, released as a kit version, and taken by every agent from that release. Since kit 2.0.0 the original implementation is the kit's core (`core/queue.js` for the rules, `core/turn.js` for a turn step by step), which the kit's node and dotnet parts carry out; Reeve's `src/npu-queue.ts` is a copy of kit 1.0.0's until Reeve takes the kit.

Every program on this PC that runs work on the Hexagon NPU takes turns through one machine-wide lock. The NPU queue makes those turns first come, first served, and hands the NPU straight to the next in line when the holder lets go. The implementations that follow this page must agree to the letter:

Every other accelerator (each graphics card, the processor; [ACCELERATORS.md](ACCELERATORS.md), beside this page) has a lock and a line of its own, by exactly these rules; see [Every accelerator, with slots](#every-accelerator-with-slots). The NPU's stay where they are.

| Program | Implementation | Lane |
|---|---|---|
| The kit (Manor's agents: Auditor, Clerk, Herald, …) | the kit's core, the original, carried out by its node part (an agent's `src/kit/npu-queue.ts`) | background |
| Reeve | `src/npu-queue.ts`, a copy of the kit's until Reeve takes it | interactive for MCP and terminal commands; background for the rounds and the home page |
| npu-embed | Reeve's `npu-embed/npu_lock.py` | background (model compile and load), or `NPU_QUEUE_LANE` |
| Heiward | `HEI.Core/AI/NpuLock.cs`, on the kit's dotnet part (the core, in Jint) once it takes it | background |

[npu-queue-vectors.json](npu-queue-vectors.json) holds the cases every implementation's tests run unchanged: the kit's tests (against the core, the node part and the dotnet part), Reeve's, npu-embed's and Heiward's. Its `order`, `dead`, `holders` and `slots` are the rules any implementation follows; [turn-vectors.json](turn-vectors.json) is the turn step by step, for the drivers of the kit's core. The timings below are [rules.json](rules.json)'s, which the core takes and anyone may read.

## Why

The lock alone has no queue. Whoever retries first after a release gets in, so a waiter can lose race after race, and a Claude session waiting on Reeve can sit behind batch work that arrived later. With the queue:
- a request a person is waiting on goes ahead of background work;
- within a lane, the first to arrive is the first served;
- a program that loops over many requests takes a new ticket for each one, so it goes to the back of the line every time, and the others get their turns in between.

## The lock (unchanged)

- The lock is the folder `%USERPROFILE%\.npu-agent\locks\npu` (override: `NPU_AGENT_NPU_LOCK`). Taking it is an atomic create of that folder. The holder then writes `owner.json`: `{"pid": <int>, "since": <ms since epoch>}`.
- A holder is evicted when its process is gone or its `since` is over 10 minutes old (callers may set a longer limit). A folder with no `owner.json` for 10 s is a crash leftover. (`holders` in the vectors.)
- **Release:** remove the folder only while `owner.json` still names you, pid and since both. An evicted holder must not remove the next holder's lock, and the next holder's folder exists for a moment before its `owner.json` does.
- **Reading and removing on Windows:** a delete fails while another process has a file in the folder open without sharing delete. So read `owner.json` sharing read, write *and delete* (Python's `open()` and .NET's `File.ReadAllText` don't; Node's reads do), and when removing the folder (a release or an eviction) fails, check again that it's still yours (or still stale) and retry every 25 ms for up to a second. A remove given up on leaves the lock taken until it goes stale. A ticket write that finds the queue folder gone creates it again.

A program that predates the queue still takes and releases the lock this way. It can jump the line, but it can never run alongside anyone. So the queue rolls out one program at a time.

## The queue

The line is the folder next to the lock: `<lock>.queue` (`%USERPROFILE%\.npu-agent\locks\npu.queue`).

**A ticket** is a file in it named

    <lane>-<time>-<pid>-<nonce>.ticket

| Part | |
|---|---|
| `lane` | `0` interactive (a person is waiting on the answer), `1` background |
| `time` | when it joined, in microseconds since the Unix epoch, as 17 digits with leading zeros. Strictly increasing within a process |
| `pid` | the waiter's process id, in decimal |
| `nonce` | random lowercase hex (8 characters), so two waiters in one process never collide |

Its contents are informational: `{"pid", "since", "lane", "who"}`, and optionally `"doing"`. `who` names the program for status displays. `doing` says what this request is for, in words a person reads beside `who` (`search index: Heiward (17 of 673 files)`): at most 80 characters (a writer cuts a longer one, ending it in `…`, and so does a reader), left out when there's nothing to say. A program that takes turn after turn for one job says the job's overall progress there, so a status display can show it rather than guess when this one turn ends. Readers must not depend on the contents, and a writer that predates `doing` is read as before. A name that doesn't match `^([01])-(\d{17})-(\d+)-([0-9a-z]+)\.ticket$` is ignored.

**The order of the line:** sort by (effective lane, time, pid, nonce), all ascending; the nonce compares as a string.
- The effective lane is `0` for an interactive ticket.
- It is also `0` for a background ticket that has waited 120 s or more. That keeps background work from waiting forever behind a stream of interactive requests: after two minutes it's served by arrival time.
- Otherwise it is `1`.

**Heartbeat:** a waiter sets its ticket's modification time to now at least every 2 s.

**A dead ticket** may be deleted by anyone reading the line:
- its modification time is more than 15 s old, whatever its pid says (pids get reused), or
- its modification time is more than 5 s old and no process with its pid is running.

**Waiting:**
1. Create your ticket.
2. Repeat:
   - Heartbeat if 2 s have passed.
   - Read the line: list the folder, skip non-tickets, delete dead tickets other than your own, and sort.
   - If your ticket is missing, someone took you for dead (a long pause, a suspended laptop). Write it again under the same name, which keeps your place.
   - If your ticket heads the line, try the lock. Evict a dead or overstayed holder as above. If you get the lock, delete your ticket: it's your turn.
   - If the wait is over, delete your ticket and give up.
   - Sleep 50 ms if you head the line (so the handoff is quick), otherwise 100 ms.
3. On any exit from waiting (success, timeout, error), delete your ticket.

Hold the lock only for the NPU work itself, and take a new ticket for each request. A long job is then a series of turns, not one long one.

## Lanes

Interactive means someone is waiting on this answer now: a Claude session's MCP call, or a command typed in a terminal. Everything scheduled or unattended is background:
- Reeve's rounds (the runner sets `NPU_QUEUE_LANE=background` for every job script, and the `reeve` commands they run inherit it);
- Heiward's scans;
- npu-embed's model load;
- Manor's agents.

`NPU_QUEUE_LANE` (`interactive` or `background`) overrides a program's default.

## Every accelerator, with slots

Each accelerator has its own lock and line, with the rules above unchanged: tickets, lanes, heartbeats, ages, eviction and release.

- **Folders:** in `%USERPROFILE%\.npu-agent\locks\` (the folder that holds the NPU's lock, so `NPU_AGENT_NPU_LOCK` moves them all). An accelerator's first slot is the folder `<id>` (the NPU's is `npu`, as always); its others are `<id>.2` … `<id>.<slots>`. Its line is `<id>.queue`.
- **Slots:** an accelerator with several slots serves that many requests at once (llama-server's `--parallel`). The NPU has one.
- **Waiting:** as above, except that the ticket at the head of the line tries each slot folder in order and takes the first it gets. Once it holds one, its ticket goes and the next ticket is the head, which takes another free slot, if there is one.
- **Releasing:** the slot folder you took, by the release rule above.
- **A program that knows nothing of slots** (Heiward, npu-embed, anything older) takes the first slot only, through the same line. It stays compatible: it never runs in a slot someone holds, and it never takes more than one.

`slots` in [npu-queue-vectors.json](npu-queue-vectors.json) lists the folders for a few accelerators.

## Seeing the line

`reeve status` prints, for each accelerator, who holds each slot and who is waiting, in order. `queueSnapshot()` (one lock) and `lineSnapshot()` (an accelerator's slots) in the kit's npu-queue.ts return the same for a page.

## Timings

As data in [rules.json](rules.json) (`queue` and `lock`), which is the source: this table says the same in words.

| | |
|---|---|
| Heartbeat | every 2 s |
| Late | 5 s without a heartbeat (then the pid is checked) |
| Dead | 15 s without a heartbeat |
| Background counts as interactive after | 120 s in line |
| Head of the line tries the lock every | 50 ms |
| Everyone else looks every | 100 ms |
| Holder overstayed after | 10 min (callers may set more) |
| A lock folder with no owner.json is a crash leftover after | 10 s |
| A removal that finds a file open tries again | every 25 ms, 40 times |
