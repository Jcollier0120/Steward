# The Steward's changelog

Each version of the Steward itself, newest first, released as `v<version>`. The kit it hands out has its own changelog, [kit/CHANGELOG.md](kit/CHANGELOG.md). Versions before 0.8.1 are described in their commits and pull requests.

## 0.36.74

**Every Snapdragon X2 now runs Qwen3-VL-2B on its NPU, whatever its memory, and on a PC with the Smith the keeper's own refreshes run at last.**

### What's new

- **Qwen3-VL-2B on every Snapdragon X2.** This Steward hands out kit 2.78.8. With it, a PC with a Snapdragon X2 runs Qwen3-VL-2B on its NPU for chat and pictures, with the pictures read on its Adreno graphics, however much memory it has. Until now only an X2 with less than 20 GB did, and a bigger one ran Qwen3-VL-4B. In the benchmark on a 48 GB X2 Elite the 2B was as accurate as the 4B and read pictures better (4 of 4 against 3), wrote about 75 tokens a second against 41, did the test jobs in about half the time and held 4.3 GB against 6.1. A first-generation Snapdragon X keeps Qwen3-VL-4B.

### What changed

- **The keeper's look now does its PC chores under the Smith.** Once a day the look should update the PC's record of its hardware, and once for each new kit it should bring the NPU's command and the graphics cards' picture settings up to what that kit's setup writes. On a PC where the Smith runs, none of the three ever ran, so a change a kit made to them reached only PCs where Set up local AI was pressed again. Now they run there too.
- **The local AI's own folder is found where its servers really are.** On a PC set up in Manor's folder for the local AI, a Reeve folder that holds only logs made the kit look there for the AI's servers and models, so the NPU's refresh couldn't find them. The kit now looks in the folder the PC's own settings run the servers from. A PC whose servers are in Reeve's folder keeps it.

### Before you update

- A Snapdragon X2 that is set up and already has Qwen3-VL-2B switches to it at the keeper's next look, once nobody has used the NPU for two minutes.
- Any other Snapdragon X2 switches when you press Set up local AI in Manor, which downloads 1.9 GB.
- Qwen3-VL-4B (4.4 GB) stays on the PC until you remove it: `geniex remove qualcomm/Qwen3-VL-4B-Instruct`.
- On a PC with the Smith, the first look after the update may also change the graphics cards' picture settings, as earlier kits meant to. Each change is written in the keeper's log, and a setting you changed yourself is kept.

## 0.36.70

**Builds do less work: ready pull requests merge between builds and wait on main to be released at the build, one kit is tried and rolled out per build, an agent is released for a new kit alone only when the kit changes what it runs, and the whole suite is never tested beside a kit's trial.**

### What's new

- **Ready pull requests merge ahead of the build.** Between builds, beside the rounds and at the checks' gentle pace, the Steward now does the build's merge pass ahead of time:
  - Each ready pull request merges into main in version order, as in a build: stamped, tested once with the others, the one that broke a stack found and left out, a kit pull request after its trial on the agents, and the rest caught up.
  - Nothing is released and no kit is rolled out. What merged waits on main until the build.
  - At the build, the Steward merges whatever is left and releases each repository once. A repository with several pull requests merged since the last build gets one release, and its notes bring every version merged ahead. A new kit merged ahead is released, and rolled out to the agents, at the build alone.
  - Nothing merges ahead once a build has begun, so main never moves under a build. A pull request left out ahead of a build is tried again by the build itself.
  - Build now and urgent fixes work as before.
  - For customers, updates still come at the build times, and builds end sooner.
- **A new kit alone no longer releases every agent.** When the only change in an agent's version since its last release is the Steward's kit bump, the Steward releases it only:
  - if a file the new kit changes is one the agent runs: its own code, what that code imports, the kit scripts and lists it names, and the folders it reads. At most one such release a day per agent; or
  - if the kit's changelog entry says it's urgent, or names a fix for that agent (a line starting "**Fix for Reeve, Crier: …**").

  Otherwise the bump is merged and waits. It goes out with the agent's next release of its own, and that release's notes carry the bump's entry too. Since Monday 12 October, 447 of the 601 agent releases were a new kit alone. Most kits change files every agent runs, so the one-a-day limit does most of the saving: about 140 of those 447 would have gone out.
  - For customers, this means fewer updates of agents in which nothing they'd notice changed. A kit fix for an agent, or an urgent one, still reaches them at once.
  - Release on the Steward's page still releases such a version at once.

### What changed

- **A build tries one kit.** A build stacks every kit pull request that's ready when it begins, tries that stack on the agents once, and rolls that one kit out.
  - A kit pull request pushed to during the build no longer starts a second trial in it. It gives up its turn, so the pull requests above it merge, and its kit is tried between builds, for the next one.
  - A catch-up that only changes versions keeps its trial, as before.
  - The 08:00 build of 16 October tried two kits on 34 agents each, 30 minutes apart, because one pull request was pushed to after the first trial began.
- **The whole suite never runs beside a kit's trial.**
  - The whole suite that a kit's release waits for now waits while a kit's trial, or a rollout's checks, run beside the rounds.
  - A kit's trial waits while the whole suite runs.
  - The round after one ends starts the other.
  - Before, a whole suite run beside a trial could hit its 20-minute limit and then run again: 35 minutes in all on 16 October.
- How many agents a trial tries at once is unchanged. On an 18-core laptop, four at once checked 25 agents in 43 seconds, against 61 for two at once.

### Before you update

- Nothing: it updates itself as usual. On the Steward's page, an agent's version that is a new kit alone, held, shows as skipped with the reason.

## 0.36.69

**In a build, the agents' pull requests no longer wait while the Steward tests its own.**

### What changed

- **In a build, the agents' merges go beside the Steward's own.** A pull request to the Steward that was pushed to after the build was prepared is still tested in the build, about ten minutes a run. Until now, each round of a build tested those first and only then merged the agents' ready pull requests: in one build, 34 kit pull requests waited an hour behind two such runs. Now the agents' pull requests merge while the Steward's are being tested. What depends on the Steward's own still waits for it: the kit's rollout (a newer kit merging in the same build goes first) and the build's releases.
- **A kit released during those merges still reaches every agent in that round.** When the Steward releases a new kit while the agents' merges run, the agents' pull requests that waited for that kit are looked at again at once and merge in the same round, and the agents the round hadn't looked at are looked at too, so the rollout takes the kit to all of them together.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.68

**A full pace never takes the whole PC any more: everything the manor runs, together, its AI model servers included, stays within 85% of the processor, and nothing new starts while more than 85% of the memory is in use.**

### What changed

- At a full pace (Manor's Settings), the Steward's checks used to run with no cap at all. These are test runs, type checks, installs and builds, an agent's whole suite before it merges, and a kit's trial on every agent. Now they are held to 85% of the processor, all of them together. Up to six run at once, as many agents as run at once at full, and they share the 85% rather than each adding to it. Each check run also keeps the memory limits it has at a gentle pace.
- An agent at a full pace keeps normal priority, but its own work, and everything it starts, stays within 85% of the processor too. So does Manor's own page.
- The AI model servers the agents share (the graphics card's, the NPU's) used to run with no cap at any pace. Now they stay within 85% of the processor too, all of them together, whatever the pace. A server that's already running gets the cap the next time it starts.
- While more than 85% of this PC's memory is in use, no agent starts a scheduled round, whatever the pace. It waits for room, and says why it waits. A round already running finishes, and a round you ask for (Run now) still runs.
- A kit trial starts no new try while more than 85% of the memory is in use. It goes on at the next round. It also tries fewer agents at once when memory is tight: only as many as the free memory holds above the 15% left to you.
- A checks pace you set (checksPace), or KIT_CHECKS_PACE, still sets a lower cap. 100% or "full" now means 85%.
- This Steward hands out kit 2.78.3, which brings the same ceiling to every agent that takes it.

### Before you update

- At a full pace the manor now always leaves 15% of the processor and memory to you and Windows, so big jobs such as a whole suite or a kit trial may take a little longer than before. Nothing to set: it updates itself as usual. Each agent's own work gets the ceiling when it takes kit 2.78.3.

## 0.36.67

**Builds are short: the next build's tests run between builds, a build only merges what passed and releases it, and it takes 30 minutes at most.**

### What's new

- **The next build's tests run ahead of it.** Between builds, beside the rounds and at the checks' gentle pace, the Steward now tests what the next build will merge: each ready pull request at its head, a version queue as one train, a build's batch, and a new kit's trial on every agent, the Steward's own first. Nothing is merged, pushed or released until the build.
  - At the build, a pull request, train or batch whose code hasn't moved since merges without being tested again. Anything pushed to since is tested in the build, as before.
  - A pull request that raises the kit runs its whole suite ahead of the build, not only the tests its change reaches. The whole suite the kit's release waits for then doesn't run again in the build, when nothing moved.
  - A repository is looked at again only once its branch, its ready pull requests or the kit move, so quiet hours cost nothing.
- **Where a build's time goes.** Each build now keeps when each of its parts started and ended: the tests of each repository, the kit's trial, the whole suite before a kit's release, the merges, the rollout, the releases (signing included) and telling Manor. The Steward's page says in a line how long the last build took and where the time went, and how much of its testing ran ahead of it.

### What changed

- **A build rolls out the newest kit, once.** When a newer kit is merging in the same build (its trial on the agents still going, or its release waiting for its whole suite), the rollout now waits for it. Before, the build sent the kit before it to every agent, with each one's checks run, and the next build bumped them all again. In a build, the newest kit now goes at once, without the hours a new kit waits to settle between builds.
- **A build's releases run side by side.** Up to a third of the PC's cores at once (six at most), or Settings' parallel releases if that's more. Releases that sign start first, one after another in a lane of their own, since signing takes longest and the signing key answers one signtool at a time. The rest release beside them.
- **A test that failed on a busy PC no longer holds up a release.** On a fully loaded PC, one of the Steward's own tests could have its request dropped after a minute's wait, which failed the whole suite before a kit's release. It now waits for the answer, up to three minutes.
- **A build takes 30 minutes at most** unless you set it otherwise, and "A build takes at most … minutes" can no longer be set above 60. A build that runs out of time releases what it merged; the rest waits for the next build.

### Before you update

- Nothing: it updates itself as usual. If you left the build window at its old two hours, it becomes 30 minutes; if you set it to more than an hour yourself, it becomes an hour.

## 0.36.66

**Builds run on time on a PC that sleeps: plugged in, it wakes a few minutes before each build and stays up until the build closes. A build the PC slept through says so, and a build shows as under way from its start.**

### What's new

- **The PC wakes for its builds.** When it's plugged in, Windows wakes the PC five minutes before each build time in Settings' Build pipeline, on its days. The Steward then keeps it up until that build has closed. Before, a PC that had gone to sleep missed its build until someone woke it.
  - The wake is a hidden task in Task Scheduler (`\Steward\Wake`), kept in step with Settings' build times and days. It goes when the Steward has no builds to run (off duty, say, or not running rounds by itself).
  - Lean by default: the screen stays off, nothing is held between builds, and a PC on battery is never woken. With the screen off, Windows runs the build a little slower than while someone uses the PC.
  - The Steward's page says so under the build times.
- **A build the PC slept through says so.** It still begins as soon as the PC wakes, and the page and the round's log say, for example, "the 08:00 build was late: the PC was in standby until 08:39".

### What changed

- **A build is under way from its start.** Before, a build was recorded as under way only when its first round ended, and that round is often its longest. Until then Manor saw no build, so it could install updates in the middle of it, and the Steward's page showed none.
- Uninstalling the Steward removes its wake task too.
- **Kit 2.78.2** lets every agent wake the PC, plugged in, for work due at set times.

### Before you update

- Nothing: it updates itself as usual.
- If the PC still isn't woken for its builds, check that wake timers are allowed when it's plugged in: Control Panel, Power Options, the plan's advanced settings, Sleep, "Allow wake timers", Plugged in: Enable.

## 0.36.65

**Where the Seneschal is on this PC, the Steward's checks wait their turn in its one order, and its jams are alarms. Kit 2.78.1.**

### What's new

- With the Seneschal on this PC (it comes with Developer Pro), each run of a repository's checks asks it for a turn first: a PR's test, a vouch, the whole suite before a kit's release, and each kit trial (one per agent and kit). What a person waits on goes first (`steward vouch`, a round started by Run now or Build now), then what a merge or a release waits on, then the rest, and kit trials last. The checks then run without a turn of the checks pace: the Seneschal's turn is theirs, so the PC isn't held back twice.
- A pass of exactly the same checks on the same code that the Seneschal already has (another agent ran them) stands in for running them again. A failure it has never does: the checks run here.
- A task the Seneschal has left waiting far past its usual time is raised as an alarm, with a link to the Seneschal's page.
- Without the Seneschal, with it off duty, or on a PC without Developer Pro, the checks run exactly as before.

### What changed

- The kit the Steward hands out lists the Seneschal, the new agent that hands out your agents' work on this PC in order, among the developer agents. With Developer options off, its Settings page no longer shows a "Where its work runs" section for work that doesn't run then.
- Its page gets its own colour and title-bar scene: a ledger whose lines are ticked one by one as their work goes out to free slots.
- Its Settings page says it comes with Developer Pro: on a PC without it, it hands out no work, and each agent runs its own as before.

### Before you update

- Nothing: it updates itself as usual. The checks wait for the Seneschal only once the Seneschal 0.1.0 or later is on this PC.

## 0.36.64

**Kit 2.78.0: on a 16 GB Snapdragon X2, the local AI on the NPU uses a smaller model, Qwen3-VL-2B. It is faster, better with pictures, and leaves the PC about 2 GB more memory.**

### What changed

- On a Snapdragon X2 PC with 16 GB of memory, the local AI on the NPU now uses Qwen3-VL-2B for chat and pictures instead of Qwen3-VL-4B. On the same tests it wrote nearly twice as fast (75 tokens a second against 41), did the test jobs in half the time, started in about 5 seconds instead of 10, and read all four test pictures right (the 4B read three). On the quality checks it scored 22 of 24, as the 4B did, with every must-pass item right.
- It leaves the PC about 2 GB more memory once loaded, room a 16 GB PC needs beside Windows and the other agents.
- The pictures are read by the PC's graphics (the Adreno) rather than the NPU: the current GenieX can't read them properly on the NPU with this model.
- Snapdragon X2 PCs with more memory, first-generation Snapdragon X PCs, and Intel and AMD PCs are unchanged.
- The NPU benchmark no longer counts a test job as unsteady just because the model wrote answers of different lengths from one try to the next: it now compares the tries as if their answers were the same length. Until now this most likely kept every full run on a Snapdragon off the leaderboard, even on a quiet PC.
- The kit the Steward hands out (2.78.0) brings this to every agent.
- That kit also brings work not released before: each agent shows under its own name in Task Manager, and on a PC with a Core Ultra 200H or 200HX, the NPU is named for that processor.

### Before you update

- A 16 GB Snapdragon X2 already set up keeps the 4B until its local AI is set up again (in Manor, Set up local AI), which downloads Qwen3-VL-2B (1.9 GB). The 4B stays on disk (4.4 GB) until you remove it: `geniex remove qualcomm/Qwen3-VL-4B-Instruct`.
- It was measured on a Snapdragon X2 Elite with 48 GB, not yet on a 16 GB PC.

## 0.36.63

**The Steward now always builds at set times, four a day, and an urgent fix goes out at once.**

### What changed

- **The build pipeline is how the Steward works, with no switch.** Ready pull requests wait for the next build. At each build time the Steward merges every ready pull request, tests each repository's together once, and releases each repository once. Then it tells Manor once, so each agent is installed at most once a build. Before, the pipeline was off unless switched on, and every round merged and released as pull requests went ready, all day.
  - The **Build at set times** switch is gone from Settings' Build pipeline tab. A setting saved with it, on or off, builds at its times all the same.
- **Four builds a day to start with**: 00:00, 06:00, 12:00 and 18:00, every day. Before, it was 08:00, 13:00 and 18:00. Settings' Build pipeline tab still changes them, and the rest stays as it was: a build still takes at most two hours, and the newest kit still goes into every build.
- **An urgent fix doesn't wait for a build time.** A ready pull request whose changelog entry has a line starting `**Urgent fix:` builds at once, in its own build for its repository alone, the Steward's own included. It doesn't wait for the next build, and it doesn't bring the newest kit. Its release goes out to customers at once, as any urgent release does.
  - A vouch between builds asks for a round straight away, so an urgent fix boards within a minute or so. The vouch says so.
  - A pull request boards once at the commit it is at. If its checks fail, it waits for a new push or for the next build.
- **Claiming a version** in a repository that writes its entries in `changes/` now always tells you to write `changes/<your branch>.md`. The Steward gives it the next release's version as it merges.
- The Steward's page and `steward round --help` describe the build times and urgent fixes. The Steward always answers Manor's question about its build times, so Manor shows the next build on the Steward's card.

### Before you update

- From this version, the Steward merges and releases only at its build times, four a day: 00:00, 06:00, 12:00 and 18:00. A pull request marked ready waits for the next build, unless its changelog entry marks it an urgent fix.
- If a build time has passed when it updates, the first build begins at once.
- If you switched the build pipeline on and kept its build times as they were (08:00, 13:00 and 18:00), they become the new four. Build times you chose yourself stay as you set them.
- Manor's Settings may still show a **Build at set times** switch for the Steward. It no longer does anything: the Steward builds at its times whatever it says.

## 0.36.62

**SimplySign Desktop waiting for you to sign in no longer holds up merges or fails a release, even when it starts waiting while a release builds.**

### What's new

- With kit 2.77.9, a button on the Steward's page whose work takes a while spins until it's done, and the part of the page it changes waits with it. Questions and messages appear in the page's own dialogs instead of the browser's.

### What changed

- SimplySign Desktop's session sometimes ends while a release is being built. When that happened, the release used to wait ten minutes for signtool, then fail for good and raise an alarm. Every other release that signs in the same round then built and waited its own ten minutes. Now the release waits until this PC can sign, as it does when the Steward finds the key gone before it builds. The other releases that sign don't build, and the rounds don't try signtool again for a quarter of an hour.
- This Steward hands out kit 2.77.9. A release made with it gives up on signtool within a minute: it checks once before building and again before signing, since the session may end in between.
- This also covers Manor's setup, and the staff still on an older kit. Their releases still wait their ten minutes the first time, but no longer fail for it, and the round's other signed releases don't wait too.

### Before you update

- Nothing: it updates itself as usual. The staff whose releases sign get the one-minute limit when they take kit 2.77.9.

## 0.36.61

**Merging stalls less: catch-up handles `## Unreleased` changelog entries, a kit trial's comment says what failed, and a vouch gets past GitHub's passing errors and has time for all the tests it runs.**

### What changed

- **Catch-up and `## Unreleased` entries.** A PR whose changelog entry is `## Unreleased` is now caught up like one with a version: its entry stays on top, above the branch's new ones. Before, it went back to its author as a conflict.
- **The branch's `## Unreleased` entries go into a caught-up PR's own.** When a PR with a version is caught up past an `## Unreleased` entry on its branch, the PR's entry takes it in. Its headline goes on to say "It also brings what wasn't released before: …", and each section's lines go under the section of the same name (What's new, What changed, then Before you update or For an agent). A "Nothing to do" gives way to a line that says more. Before, the Unreleased notes were left below the new version, where no release reads them.
  - The same goes for the kit's changelog, and for the merge train. A catch-up that resolved only these keeps the PR's vouch, as before.
  - Only an entry still waiting for its release is taken in. One below a version the branch has released since already went out with that version, so it stays where it is.
- **A kit trial's comment quotes what failed.** Under each agent the new kit fails, the comment now shows the first few distinct error lines its checks printed. The same error from forty test files shows once.
  - The failed step's whole output is kept in the work folder's `_kit-trial-logs`, one file for each agent and kit (the newest 40). It is still there after the agent's next try, which used to clear it. The comment and the Wright's issue point to it.
- **A vouch gets past GitHub's passing trouble.** Sometimes GitHub's answer to the vouch's status is cut short, or is a server error, or the network drops. The vouch now tries again after 2, 5 and 10 s before it gives up. A refusal (no access, no such commit) still stops it at once. The Steward's own PR test sets its vouch the same way.
- **A vouch's time limit allows for how many tests it runs.** A vouch is stopped five minutes past the average of its recent runs. When a change reaches far more test files than usual, its limit now grows to match, up to the whole suite's limit. Before, a change that reached most of the tests was stopped before it could finish, and the Steward had to test it again itself. A vouch now records how many test files it ran, so the longer limit applies once three vouches since the update have recorded theirs.
- **Kit 2.77.8**: PowerShell's time limits stretch at the checks pace, so the kit's PowerShell tests no longer time out on a busy PC.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.60

**A new kit's rollout no longer holds up merges: ready pull requests merge while the staff are being moved to it.**

### What changed

- When a new kit comes out, the Steward moves each of the staff to it: it raises their version, runs their checks, and opens a pull request. That used to happen inside a round, so every ready pull request waited until all of it was done. Rounds that rolled a kit out took 20 to 56 minutes this week, against 15 to 20 for the others. Now the rollout runs beside the rounds, and the next round starts at once and merges what's ready.
- While the rollout is working on one of the staff, the rounds leave that one alone and look at it again once the rollout is done with it. The round after the rollout ends lists what it did, merges its pull requests and releases them.
- If another rollout is already running on this PC (a round started from a terminal, say), the round leaves the kit to that one, and looks again next round.
- The Steward checks that this PC can sign before it starts a release that signs. If SimplySign Desktop is waiting for you to sign in, that check used to wait as well, and so did the round behind it, for up to half an hour. Now a check that gets no answer within a minute counts as "can't sign yet". The release waits, without holding the round, and the Steward doesn't ask signtool again for a quarter of an hour. The alarm says SimplySign Desktop may be waiting for you to sign in.

### Before you update

- Nothing: it updates itself as usual.

## Unreleased

**The NPU check's hardening run passes every step on Intel's NPU 3720.**

### What changed

- The NPU check's hardening run now passes every step on Intel's NPU 3720 (Meteor Lake and Arrow Lake-U). Before, one of its steps could ask a server that an earlier step had left starting, and fail.
- How much memory the local AI holds on a 16 GB PC with the NPU 3720 is now measured and written down: chat and search together hold about 4.3 GB, inside what setup allows. Nothing changes for it.
- The kit the Steward hands out brings this to every agent.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.59

**Kit 2.77.6: the local AI's NPU unloads its models about five minutes after its last request, even while Reeve indexes on the graphics card.**

### What changed

- On a PC whose local AI runs on more than one accelerator (an NPU and a graphics card), each one's models now unload when that one has been idle. Before, work on any of them kept them all loaded, so Reeve indexing on the graphics card held the NPU's memory, and the NPU's chat held the card's.
- How long each waits before it unloads is unchanged.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.58

**Kit 2.77.5: on a PC with under 20 GB of memory, the local AI's search model steps aside while you chat, so the chat model gets its memory.**

### What changed

- On a PC with under 20 GB of memory, the search model on the NPU now stops when a chat or a picture question starts, if nothing has searched in the last 30 seconds. The chat model gets the memory back: about 1.4 GB of the NPU's on a Snapdragon, and close to 2 GB of the PC's. The next search wakes the search model again in about 2 seconds.
- The search model keeps running while it's in use, for example a search right after a summary, or an index being built between chats. Measured on two hours of the manor's own traffic, that means about one extra wake-up an hour.
- PCs with 20 GB or more, and PCs where you've set how long the local AI stays loaded, are unchanged.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.57

**The Steward's notifications come under Castellan's name, with the castle, instead of Windows PowerShell.**

### What changed

- The Steward's Windows notifications (an alarm that needs you, a release that stopped) now say **Castellan**, as Manor's own do, with the castle on each one. In Windows' notification settings, Castellan's notifications are turned on or off together, without touching Windows PowerShell's.

### Before you update

- Nothing: it updates itself as usual. The castle shows once Manor 0.16.165 or later is installed; before that, the notifications already say Castellan.

## 0.36.56

**Kit 2.77.3: on an AMD Ryzen AI PC, one smaller model answers chat and pictures on the NPU: faster, lighter, and a much smaller download.**

### What changed

- On an AMD Ryzen AI 300 PC, the local AI on the NPU now uses one model, Qwen3.5-2B, for both chat and pictures, instead of two 4B models. It writes about half again as fast, holds 0.4 GB less memory for chat and 1.2 GB less for pictures, and downloads 2.0 GB instead of 7.4 GB. It no longer pauses 8 to 9 seconds to switch models between a chat and a picture. On the quality checks it scored 22 of 24 against the 4B's 23, with every must-pass item right.
- It takes about 1.7 seconds longer to start. Waking it after a rest is now announced as about 15 seconds, where the 4B's chat took about 7.
- The kit the Steward hands out (2.77.3) brings this to every agent. Intel and Snapdragon PCs are unchanged.

### Before you update

- A PC already set up keeps using the two 4B models until its local AI is set up again (in Manor, Set up local AI), which downloads Qwen3.5-2B (2.0 GB). The 4B models stay on disk (7.4 GB) until you remove them: `flm remove qwen3-it:4b` and `flm remove qwen3vl-it:4b`.

## 0.36.55

**Kit 2.77.2: the local AI's search model on a graphics card or the processor holds about 600 MB less memory, as fast and with the same results.**

### What changed

- The search model that runs on a graphics card, or on the processor, now starts with a smaller working space and holds about 600 MB less memory: 1.3 GB instead of 1.9 GB on an AMD Radeon 860M, and 1.4 GB instead of 2.0 GB on a Core Ultra 5's Intel graphics. It answers just as fast and gives the same results, so existing search indexes carry over. Where the graphics share the PC's memory, as on most laptops, that is 600 MB more for everything else.
- One piece of text sent to it at once is now limited to about 4,000 characters. The manor's agents send at most about 2,000, so nothing changes for them; a longer text is refused with a note to split it.
- The kit the Steward hands out (2.77.2) brings this to every agent. Snapdragon PCs had the same change in kit 2.75.1.

### Before you update

- A PC whose local AI is already set up keeps the search model's old settings until its local AI is set up again (in Manor, Set up local AI). Otherwise nothing: it updates itself as usual.

## 0.36.52

**A draft holding a repository's version queue can be moved out of the way in one click.**

### What's new

- The alarm for a pull request that has held a version queue for an hour (a draft, usually) now has a **Move it past the others** button, here and in Manor's **Needs you**. It asks first. Then the Steward gives that pull request a version above every other one in line, tells its author in a comment on the pull request, and clears the alarm. The pull requests that waited behind it merge at the round that follows, which comes at once.
- Nothing is pushed to the moved pull request's branch, so it works for anyone's pull request, a fork's too. Once it is ready, the Steward catches it up to its new version itself where it can (a pull request from the repository itself, with Catch up on); otherwise the comment asks its author to set that version.
- Drafts just above it that would hold the queue next are moved with it, so one click frees the queue. The alarm names them.
- **What holds the version queues** on the Steward's page has the same button, so you needn't wait for the hour.
- `move-past <repository> <pull request number>` does the same from a terminal.

### What changed

- A moved pull request that isn't ready gives up its turn. One marked ready afterwards waits its turn at its new version, behind the pull requests it was moved past, rather than merging first at its old one.
- The move is recorded with the version claims every PC shares, so another PC whose turn it is to merge in that repository honours it too.
- A pull request by someone outside Settings' team, which the Steward never merges, no longer counts as holding a version queue. Its draft no longer raises an alarm or a heads-up, and the pull requests above it no longer count as waiting for it. It is still listed in the queue.
- Settings' **A PR holding others up for** (it was "A conflicting PR holding others up for") now says it covers drafts and other pull requests that aren't ready, as the alarm already did.

### Before you update

- Nothing: it updates itself as usual. Manor shows the button in Needs you from Manor 0.16.164; an older Manor shows these alarms with Dismiss only.

## 0.36.51

**Code that already passed its checks isn't tested again: not on this PC, and, with Manor's Other PCs on, not on another of your PCs either.**

### What's new

- Before the Steward runs a repository's checks, it looks for a pass of exactly the same code. It doesn't matter which commit the code came from, only that the code is the same. It looks in three places:
  - the Assayer's check of that folder, as before for a vouch;
  - this PC's own results;
  - with Other PCs on, the other PCs on your licence, asked through Manor (Manor 0.16.163 and later).

  If it finds one, it takes it and runs nothing. The round's log says so ("its checks passed on LAPTOP at 14:02, on exactly this code: not run again"), and so does Manor's Work page ("passed on LAPTOP, not run again here").
- This counts wherever the Steward runs checks: testing a pull request, a vouch, a merge train, a build, a catch-up, and the whole suite before a kit's release. A vouch whose pass came from another PC says so on GitHub ("… passed on LAPTOP at abc1234").
- A pass stands in only when:
  - it covers all of the checks, not only the tests a change reached;
  - it is for the same repository;
  - it is less than a day old;
  - it ran on the same Node.js major version and the same OS;
  - it ran every check your Settings give that repository.
- A failure never stands in. If the code failed here after it passed on another PC, the checks run here again.

### What changed

- Every run of the checks now records which commands it ran and on which Node.js and OS.
- This release brings the Steward's kit 2.77.0, which gives every agent the same: a pass by code tree, from this PC or another PC on the licence.

### Before you update

- Nothing: it updates itself as usual. Results kept before this version don't say which Node.js or checks they ran, so they are run again once. With Other PCs off, or with an older Manor, only this PC's own passes count.

## 0.36.50

**Kit 2.76.0: the Steward, and every agent, say what they are working on and what is waiting, for Manor's Work page.**

### What's new

- The Steward reports what it is doing right now, and Manor reads it from its page:
  - each stage it runs, and how many it may run at once (Settings' Stages at once);
  - each run of a repository's checks, with the repository and commit;
  - the whole suite or a kit trial running beside the rounds, with the checks they run.
- Work that waits says which line it waits in: a turn of the checks pace, the work line, the first-round line, or an accelerator.
- It says what holds each version queue: the pull request that isn't ready, since when, and the pull requests waiting behind it.
- What each run of the checks came to is kept by the code it ran on, so a pass on the same code can be found later, whatever the commit.
- Manor 0.16.161 has a **Work** page that gathers this from every agent on the PC, and from the licence's other PCs when Other PCs is on.

### What changed

- The kit the Steward hands out (2.76.0) brings the same to every agent: their scheduled rounds and their place in the checks pace's turns show too.
- Kit 2.76.0 also brings NPU work that wasn't released before. On Intel's NPU 3720, embeddings now run on the processor's graphics: a search answers in about 50 ms instead of 1.1 s, and Reeve indexes about 3.7 times as fast.

### Before you update

- Nothing: it updates itself as usual. The checks pace's launcher is built again once, at the first check after the update.

## 0.36.49

**Updates go in on a busy PC: an agent slow to start after an update is no longer rolled back as broken, and the Steward pauses its rounds for a few minutes so Manor can update it.**

### What's new

- Manor updates an agent only while it's idle. A Steward busy with one round after another could go hours without being idle when Manor looked, so its updates waited, or waited for you to press Update. Now, while Manor has an automatic update ready for the Steward, its rounds wait up to 5 minutes so the update can go in. If it hasn't gone in by then, the rounds go on, and wait again half an hour later. Run now never waits. Every agent gets the same with kit 2.75.2.

### What changed

- When an update starts an agent while the PC is busy (a release's checks running, say), its page can take more than 20 seconds to answer. The update used to take that for a broken release: it put the version before back, marked the new one unsafe and refused it from then on, and the new version kept running over the older version's files. On 15 October this happened to the Steward's 0.36.46 and the Assayer's 0.4.2. Now the update waits while the agent is still starting, up to 5 minutes, and one that answers late as the new version is kept, and checked as usual.
- If an update does have to be rolled back, the new version is stopped completely first, even while it's still starting, so the version put back is the one that runs.
- Once a newer version is installed and holds up, an older version marked unsafe no longer is, and its alarm goes away.

### Before you update

- If your Steward's update to 0.36.46 was rolled back (its page has an alarm saying so, and Manor shows 0.36.42 installed), this update sets it right: it stops the Steward that's running, installs 0.36.49 whole, and clears the 0.36.46 alarm once 0.36.49 holds up. Until 0.36.49 is running, the Steward doesn't pause its rounds for Manor yet, so if Manor keeps waiting for the Steward to be idle, press Update in Manor. Other agents rolled back the same way are set right by their next release.

## 0.36.48

**Kit 2.75.1: on a Snapdragon, the local AI's search model holds half the memory it did, so everything fits on a 16 GB PC.**

### What changed

- On a Snapdragon PC, the search model that runs on the NPU beside the chat model now holds 1.4 GB of memory instead of 2.9 GB. It answers just as fast and gives the same results, so existing search indexes carry over. Together the two models now hold 5.6 GB instead of 7.1 GB, comfortably inside what Windows lets the NPU hold on a 16 GB PC. Tried with only a 16 GB PC's worth of memory free, chat, pictures and search all kept working, and the two models left 1.6 GB more of it for everything else than before.
- Waking the search model after a rest is now announced as taking about 3 seconds, as measured, instead of 10.
- The kit the Steward hands out (2.75.1) brings this to every agent. Intel and AMD PCs are unchanged.

### Before you update

- Nothing: it updates itself as usual. On a Snapdragon already set up, the agents switch the search model to its new settings as they update, with nothing to download.

## 0.36.46

**A build whose checks fail no longer holds everything back: the Steward finds the pull request that broke it, takes it out, and ships the rest.**

### What's new

- At each build, the kit's pull request and the pull requests that write changelog fragments go together as one batch: stacked in the order they went ready (the kit first), stamped with one version and tested once.
- When the batch's checks fail, the Steward tries once more (a flaky test doesn't break up a build), then tests the bottom half of the stack, and halves again, to find the one pull request that broke it.
- That pull request is taken out and turned back into a draft, with a comment saying which tests failed and which pull request it clashed with, so the session that opened it can fix it for the next build. It also gets a red **steward/build** status. The rest of the batch ships without it.
- If the kit's pull request is the one that broke it, the agent ships without the new kit, stays on its old one, and the kit rollout alarm goes off.
- If the halving can't single out one pull request, the ones at the bottom of the stack that passed ship, and the rest wait for the next build, with an alarm naming them.
- A new setting, **To find the PR that breaks a build, at most** (Build pipeline, advanced; `bisectRuns`, 3 by default, 0 to 6): how many extra test runs the halving may take. At 0 it doesn't look: what passed at the bottom ships, the rest wait.

### What changed

- A kit is no longer held back from release by one of the Steward's own tests failing only because the PC was busy. The test of the NPU queue letting go of its lock while another program reads it now says it couldn't tell, rather than failing, when that program was held up longer than the queue waits. This kept kit 2.74.6 from being released on 15 October, while kit trials ran beside the check.

### Before you update

- Nothing: it updates itself as usual. The batch only runs with the build pipeline on. This release brings 0.36.40's build pipeline too, if that wasn't released on its own.

## 0.36.45

**The whole test suite before a kit's release no longer holds up merging, the Steward says which pull request is holding a version queue, and the PC stays awake while the Steward is working.**

### What's new

- While the Steward runs checks, merges a pull request or makes a release, Windows doesn't put the PC to sleep on its own. Once that work ends, the PC may sleep again. On 15 October the PC slept for an hour in the middle of a round's checks, and again for 13 minutes, which is much of why that round ran out of time. This only stops sleep from idling: if you choose Sleep, press the power button or close the lid, the PC still sleeps, and the display still turns off as usual. Rounds that only look at GitHub don't keep the PC awake, so it still sleeps when nothing is being worked on. This comes with kit 2.74.8.

- The Steward's page has a new card, **What holds the version queues**. It appears when the lowest version waiting in a repository is a draft, untested, or has failing or running checks, while ready pull requests above it wait their turn (the lowest version always merges first). It names the pull request holding the queue, why it isn't ready, which pull requests wait behind it, and since when. The round's log says the same.
- When a queue has been held that way for more than an hour, it is an alarm (the same hour as a conflict that holds a queue, Settings' `blockingHours`). The alarm says what to do: mark the pull request ready, give it a version above the others, or close it. This covers the Steward's own repository too, where three drafts held every merge for hours on 14 and 15 October without anything saying so.
- While the whole suite runs before a kit's release, the page shows it, with the commit and how long it has been running.

### What changed

- Before it releases a kit, the Steward runs its whole test suite (twice if the first run fails). That used to happen inside a round, and the round waited: a slow run held every merge for 45 minutes to 2 hours on 14 and 15 October, until the round was given up at its time limit with its tests still running. Now the suite runs on its own, beside the rounds. The round that starts it goes on merging at once, and the kit waits. The first round after the suite passes releases the kit. If it fails, the kit is held as a failed release, as before. Only one run goes at a time, never a second beside it.
- A new commit on main stops a whole suite still running for the old commit and starts one for the new commit. When the Steward stops, its whole suite stops with it, along with every program it started. If a Steward ended without stopping it, the next Steward ends whatever was left running when it starts.
- Code that has already passed the whole suite on this PC is still not run again, and a kit whose two runs failed only on different tests is still released.
- With several PCs taking turns at the Steward's work, the whole suite runs only on the PC whose turn the Steward's own repository is. If the turn moves to another PC, this PC stops its run, and the other PC runs the suite there. The alarm for a held version queue is raised only by the PC whose turn that repository is, so two PCs never both raise it.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.44

**Kit 2.74.7: every first-generation Snapdragon X is recognised, the Snapdragons before it are turned down before anything downloads, and an X2 can stand in for an X.**

### What's new

- On a Snapdragon X2 laptop, the NPU check and the NPU benchmark can play a first-generation Snapdragon X (`--generation snapdragon-x`): they run the X's own model build and its NPU code on the X2, from a folder of their own, so the laptop's own local AI and its model are left alone. A played benchmark is shown, never ranked: it runs the X's code, not at an X's speed.

### What changed

- The kit the Steward hands out (2.74.7) recognises every first-generation Snapdragon X by the name Windows gives it, the plain X and X Plus included, and by its device id where the name doesn't say. On an X, setup now checks the model it downloads file by file against the X's own build, as it does on an X2.
- On a Snapdragon from before the X (the 8cx, 8c, 7c, Microsoft's SQ1 to SQ3, the 850 and 835), setup now says plainly that its NPU can't run the manor's models, and why, before downloading anything. Before, it downloaded the NPU's server and a 4.4 GB model only for its test to fail. Its local AI runs on the graphics card or the processor instead, as it did once that test failed.
- The NPU benchmark on a Snapdragon no longer fails its second start: it now waits until the stopped server has let go of its port before starting it again.
- Steward 0.36.43's kit (2.74.6) also brought Intel's and AMD's NPU work, which its notes left out:
  - Setup's first timeouts for an AMD NPU of a generation nobody has measured now allow for how fast its server actually reads: a 35 s base where it was 90 s.
  - AMD's NPU has been measured on battery.
  - On every Intel NPU, OpenVINO Model Server's prompt cache is now off.
  - Intel's newer NPUs get prompt settings estimated from the ones measured.

### Before you update

- Nothing: it updates itself as usual, and agents get it as they pin the kit. On a PC with an Intel NPU (Lunar Lake, or the NPU 3720) that's already set up, the NPU compiles its model once more as an agent takes this kit, for a minute or so.

## 0.36.43

**Kit 2.74.6: checks get the share of the processor Manor's Settings give them, and tests run at that pace take longer instead of failing.**

### What changed

- Checks the Steward and the other agents start (vouches, merge checks, kit trials, the Assayer's checks) were held by two limits at once: Manor's checks pace, and the agent's own gentle pace, which is far tighter. The gentle one won: two processors' worth, 11% on an 18-thread PC, so raising the checks pace in Manor's Settings did nothing for them. Now checks leave the agent's gentle limit and are held only by the checks pace.
- The checks pace holds test runs to a share of the processor, a third unless Manor's Settings say otherwise. A run's overall time limit was already stretched to match, but the waits and timeouts a test sets itself weren't, so on a busy PC a test could fail with nothing wrong. Each paced run is now told how much slower it runs, and the kit's tests stretch their own waits and timeouts by that much. At the pace they take longer; at full speed nothing changes.
- The kit the Steward hands out (2.74.6) brings this to every agent, for tests that use it.

### Before you update

- Nothing: it updates itself as usual, and agents get it as they pin the kit.

## 0.36.42

**Full test runs keep to the checks pace without starving their own tests, and a kit's release is no longer held by tests that fail at random.**

### What changed

- When the Steward runs a repository's whole test suite (before releasing a kit, or for a change that reaches every test), it now starts the test runner itself instead of going through `npm test`. The checks pace can then see how many test files run at once and limit them to what its share of the processor allows. Through `npm test` it couldn't: on an 18-thread laptop 17 test files started together, all within a third of the processor, and tests that time themselves failed. The repository's pretest and posttest still run, before and after, as `npm test` runs them.
- Before a kit is released, its whole suite runs a second time when the first run fails, as before. The kit was then held whenever the second run failed too, even when a different test failed each time, each passing in the other run. Those are tests failing at random, not a real problem, so the kit is now released. A test that fails in both runs still holds it. On 15 October kit 2.74.5 was held this way, and the Steward's own release waited behind it.
- Two of the kit's tests that failed on a busy PC now allow for one: the test of moving to the next accelerator when one is slow, and the test that starts pages with a console of their own.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.40

**The build pipeline: the Steward can merge and release at set times a few times a day, each agent released and updated once per build.**

### What's new

- A new Settings tab, **Build pipeline**. Switched on, the Steward builds at set times (08:00, 13:00 and 18:00 to start with, on the days you choose) instead of whenever a pull request goes ready.
- At each build it merges every ready pull request, rolls out the newest kit (every build, or only the day's first), and once everything has settled releases each repository once and tells Manor once. So each agent is updated at most once per build.
- Between builds its rounds only look: nothing is merged, rolled out or released, and ready pull requests wait for the next build.
- A build the PC slept through runs as soon as the PC wakes. A build that hasn't settled in time (two hours by default) releases what it merged, and the rest waits for the next build.
- An owner's override, **Build now**, for emergencies: `steward build` at a console, which asks you to type "build" first. It can build some repositories only, and with `--to-customers` let that build's releases out to customers at once.
- The Steward's page says when the next build is, and Manor can ask whether a build is under way.
- Changelog entries without versions: in a repository that writes its entries in `changes/`, a piece of work writes `changes/<its branch>.md` and picks no version. Every entry merged before the next release shares that release's version and is composed into its one changelog entry. A first line `minor: true` asks for a minor step. With the build pipeline on, `claim-version` answers with the file to write instead of a version.

### What changed

- With the build pipeline on, the Steward no longer releases after each merge, and the vouch's "merge soon" says which build a pull request will go into.

### Before you update

- Nothing: it updates itself as usual. The build pipeline is off until you switch it on in Settings.

## 0.36.39

**Fewer git commands again: projects' version queues, and pull requests that set no version.**

### What changed

- Version queues for Manor's projects (not just the agents) now fetch a repository only when its branch on GitHub has moved. The Steward checks this against the branch heads other agents share, instead of fetching every project each round.
- A version queue that already has a branch's head keeps it without asking the clone again, and a repository the round has just merged or released to is always fetched, so its queue is never a round behind.
- A pull request that sets no version above its branch is no longer read again every round while nothing about it has changed.
- A branch with no version found at its head isn't read again until the branch moves.
- The staff table reads a clone's branch correctly from git when the clone uses git's newer reftable format.
## 0.36.38

**Kit 2.74.5: the NPU's local AI gets faster on PCs already set up, Intel's NPU 3720 writes about 13% faster, AMD's NPU runs on a 16 GB Ryzen AI, and a newer NPU is tried instead of refused.**

### What changed

- The kit the Steward hands out (2.74.5) brings a better NPU command to PCs set up by an older kit. Before, a PC kept the command it was set up with until its NPU was set up again. Now the agent that keeps the local AI running (the Smith, else Reeve) tries the new command while nobody is using the NPU, and switches to it only if it answers properly. On an Intel NPU 3720, a short question that took 3.1 s now takes 0.5 s.
- On an Intel NPU 3720 (Core Ultra 200 series), the local AI writes about 13% faster and holds about 1.4 GB less memory after long, varied prompts. Its first start on a PC compiles once, in about a minute instead of half a minute.
- On a Ryzen AI PC with 16 GB of memory, the NPU's local AI never started, so setup left the NPU out. Its server reserved room for a far longer conversation than the kit ever sends. It now reserves what the kit uses: it starts in about 5 seconds and holds 4.5 GB. Such a PC gets its NPU the next time you run Manor's "Set up local AI". AMD's current NPUs (XDNA 2) have now passed every step of the NPU check.
- When AMD's NPU server fails to load its model, the work goes to the next accelerator instead of taking an empty answer from it.
- An NPU from Intel, AMD or Qualcomm that setup doesn't know yet, such as a newer generation, is no longer refused. Setup tries it on the most cautious settings its maker's NPUs use, and keeps it only if it passes setup's test.
- The NPU benchmark now times prompts the server hasn't seen before, instead of the ones its cache already holds. Its results are suite 2, which doesn't rank against suite 1's.
- This brings together five NPU changes made on a second PC, under one version.

### Before you update

- It updates itself as usual, and agents get it as they pin the kit.
- On a Ryzen AI PC whose NPU setup left out, run Manor's "Set up local AI" once after the agents have it, to bring the NPU in.

## 0.36.36

**Kit PRs no longer wait for a trial each: a queue of them is tried once, and a catch-up keeps the trial.**

### What changed

- Kit PRs waiting one behind another are tried on the agents together, once: the first one's trial tries the kit with each one queued after it merged in, in the order they merge. When every agent passes, they merge one after another without a trial each. When an agent fails, the first is tried alone, as before, so a failure is only held against the PR that brings it. On 14 October eight kit PRs waited for a trial each, one at a time, for hours.
- A kit PR caught up with its branch keeps its trial when the catch-up changed only versions and changelogs (the kit's version, its changelog, version lines), as a vouch is kept. Before, every catch-up started its trial over on every agent.
- An agent that fails a kit's trial the way a busy PC fails (a test killed, a folder still in use, a run stopped at its time limit), or that fails without the new kit too, is tried once more, alone, after the rest of the trial, and holds the PR only if it fails again. Two agents held a kit PR this way on 14 October.

### Before you update

- Nothing: it updates itself as usual. Trials already kept are used as they are.

## 0.36.33

**A pull request that conflicts with its branch is caught up within minutes, not when the round next reaches it.**

### What's new

- Every 5 minutes, while one of the Steward's stage slots is free, it checks GitHub once for ready pull requests that conflict with their branch, and catches them up at once in that free slot. Until now only the round did that, one repository after another, and a long round (a vouch's tests, a kit trial on every agent) could leave a conflicting pull request, and every one queued behind it, waiting for hours.
- It handles conflicts only. It merges nothing, tests nothing and leaves alone a repository another stage is working on. When it has caught one up, a round follows to merge it. A conflict it can't resolve goes back to whoever opened the pull request, as before.
- While it works, the page shows it as a running stage named "conflicts". When nothing conflicts, it takes no slot at all.

### Before you update

- Nothing: it updates itself as usual. Settings' "Catch PRs up" switches this off along with the round's catch-ups.
## 0.36.32

**It hands out kit 2.74.4: each PowerShell an agent starts is one process, not two.**

### What changed

- The kit 2.74.4: the PowerShell an agent's page starts shares the page's windowless console instead of starting a console host (conhost.exe) of its own beside it. Agents get it as they take the kit.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.31

**Kit 2.74.3: on the pages of the agents your AI assistant calls, Needs you sits closer to the top and can show what waits under it.**

### What changed

- The kit the Steward hands out (2.74.3) lays out Needs you on Reeve's and the Assayer's pages without the large empty gap above it, its heading like the page's other section headings. Agents get it as they pin the kit.
- Needs you can now show quiet things under its cards that aren't something to do, such as a review queue with nothing waiting. Reeve moves its own there in its next update.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.30

**Releases that need code signing wait for SimplySign instead of failing.**

### What changed

- Before it starts a release that signs (an agent's native files, or Manor's setup), the Steward now checks that this PC can sign. While it can't, because SimplySign Desktop isn't connected, the release waits: nothing is built and nothing fails. Once SimplySign is connected, the next round releases it by itself.
- All the releases waiting to be signed share one alarm, raised at once so you know to connect SimplySign. It clears by itself once they're released. They are no longer filed as failures that the rounds won't try again, and none is handed to the Wright: there's nothing in the code to fix.
- A release that loses SimplySign partway through its build waits the same way.
- Releases that failed earlier only because SimplySign wasn't connected are tried again: they wait for it like the rest.
## 0.36.29

**Tests, checks and builds run faster: they get a third of the processor, three at a time, and long test runs get the time they need.**

### What changed

- The checks pace now gives the test runs, type checks, installs and builds that the agents start a third of the processor, on any PC, and lets three run at once instead of two. Before, they had a quarter of the processor and never more than four processors' worth (two before 0.36.28): 22% on an 18-thread PC, 11% before. Checks waited in line while the PC sat mostly idle, and vouches, kit trials and releases took far longer than they needed. The other two thirds stay free for you. `"checksPace"` in Manor's settings.json still sets your own share.
- The Steward used to give a paced run four times its usual time limit, which suits a quarter of the processor. With a smaller share, a big test suite could be stopped part way through, with nothing failed, and the vouch or check said only "Command failed". Now the time limit grows with how much the pace slows the run (four times at a third, nine at 11%), plus the 20 minutes it may wait for its turn.
- The Steward's chosen tests now run as many test files at a time as their share of the processor has room for (12 at a third of 18 processors), not one per processor.
- A command stopped at its time limit now says "stopped after N minutes, its time limit at the checks pace" instead of "Command failed" and its whole command line.
- Two of the Steward's own tests, one for the NPU benchmark's energy reading and one for renaming a shared package set, failed now and then at the checks pace, with nothing wrong, and made a vouch or a kit release run again. They no longer depend on how fast the PC runs them.
- This brings kit 2.74.2. It also carries the NPU benchmark's fixes made on another PC: it runs at each NPU generation's own prompt length, counts an energy figure only when the battery's reading can tell it, and runs on a Snapdragon's GenieX.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.28

**A vouch that runs five minutes past its usual time is stopped, and check runs get twice the processor on a big PC.**

### What's new

- **A time limit on `steward vouch`.** Once a repository has three vouches that passed, a vouch's checks are stopped when they have run five minutes longer than its last ten passing vouches took on average. Whole-suite runs and runs of only the tests a change reaches are averaged apart, since one takes a fraction of the other. A stopped vouch says so, with the limit and how it was worked out, and sets nothing: the Steward tests the PR itself before merging, as for any PR without a vouch. Before, a stuck vouch could run for 80 minutes.

### What changed

- A command stopped at its time limit is ended with every program it started, not only the one the Steward started: a test run under npm, or under the checks pace, used to run on.
- Kit 2.74.1: test runs, type checks, installs and builds may use a quarter of the processor, up to four processors' worth, where it was two. On a PC with more than eight processors they finish sooner. The Steward's own tests had taken over an hour on an 18-processor laptop that was otherwise idle. Agents take it as usual.

### Before you update

- Nothing: it updates itself as usual. The time limit starts once three vouches of a repository have passed on this version.
## 0.36.27

**Your second development PC can claim versions of the manor's repositories.**

### What's new

- On a PC you develop on beside the one that merges and releases, `claim-version` and `release-version` now work for the manor's own repositories (and the kit, from a Steward clone) when GitHub says the account that PC is signed in with can push to them. Before, they were refused anywhere but the maker's laptop, so work started there couldn't take a version.
- The claim goes straight to the repository's shared claims on GitHub, which the merging PC reads. If GitHub can't be reached, nothing is claimed, rather than a claim only that PC would know about.
- Nothing else moves: merging, releasing, ports and recalls stay on the maker's laptop.

### Before you update

- Nothing: it updates itself as usual. To claim from another PC, see "Except a version claim from the maker's other development PCs" in the README.
## 0.36.26

**Kit 2.74.0: a page layout for the agents your AI assistant calls, taken from Reeve's page, so they all read alike.**

### What's new

- The kit the Steward hands out (2.74.0) has a shared page layout for agents that serve MCP, like Reeve and the Assayer: what needs you first, then a row of tiles at a glance, connecting your AI, what was kept out of its context, then the agent's own sections. Lists show one line per item; details and long output open beside the page instead of filling it. Agents take it up as they pin kit 2.74.0, the Assayer first.
## 0.36.25

**The other agents see a merge within seconds, however long the Steward's round takes.**

### What changed

- The Steward shares the branches of your repositories on GitHub with the other agents, so they needn't ask GitHub themselves. Reeve uses them to bring each clone's main up to a merge. Before, they were read only as a round began, and a long round (one trying a new kit can take hours) left them out of date: the agents asked GitHub again, and Reeve couldn't tell a clone was behind.
- Now the Steward's page also reads them on its own every 5 minutes, unless a round just did, and 10 seconds after each pull request it merges.
- It costs about one of GitHub's 5,000 points an hour per read, and only happens while the Steward merges and releases by itself and is on duty. It never touches the tenth of GitHub's limit the Steward keeps spare.
## 0.36.24

**The Steward starts fewer git commands when it takes its turn in a repository or shares a version claim, and when it clears its work folders, so its rounds put less load on your PC.**

### What changed

- Writing the turn record or the shared version claims to a repository's remote used to start four git commands to build the commit before the push. The Steward now writes that small commit itself, and only the push still goes through git. The push's compare-and-swap is the same as before, so two PCs still can't both take a turn. The commit is the same one git would have made.
- Reading a turn record or the claims back no longer starts git to read the file. The Steward reads it from the objects it already has, and asks git only when they're packed.
- Clearing a stage's worktree used to list every worktree with git, remove it, and then always tidy up git's records of worktrees. The Steward now reads those records from git's own files and tidies up only when a worktree folder has gone missing. A folder that isn't there anymore costs no git command at all. Worktrees under a junction or a Dev Drive, and ones deleted by hand, are still found and cleared as before.
- The Steward's own tests of these parts run faster: on the owner's laptop, the turn and claims tests went from 29 to 23 seconds and the catch-up's from 37 to 35.
## 0.36.23

**Kit 2.73.5: the kit sees one folder as one folder, however it's named.**

### What changed

- The kit's install, update and model-server checks now compare folders by their real paths, through a junction, a link or a Dev Drive mounted in a folder (the Steward's work folder, `%USERPROFILE%\.steward\work`, is often one). An update ends the programs still running from the old copy whichever way they were started. Uninstalling with `--purge` refuses a folder that holds your profile, or a whole drive mounted in a folder, however it's named. A model server started under the other spelling is still known as the manor's own, and never stopped as an orphan.
- Agents take kit 2.73.5 as usual.

### Before you update

- Nothing: it updates itself as usual.
## 0.36.22

**The Steward's kit 2.73.4: an NPU that loads its model slowly is given the time its own settings allow.**

### What changed

- On a PC with an Intel or AMD NPU, the agents' local AI requests now wait as long as that NPU's own settings allow. Before, they all waited the same short time, so a slower NPU's answers, or its first answer while it prepared its model, could be cut off and the work put off until later. The timings setup measured for an NPU nobody had measured before are used now too.
- When one agent finds the NPU still loading its model because another agent just woke it, it now waits for the load to finish, as it already did when it woke the NPU itself.
- On a PC with a Qualcomm NPU, nothing changes.
- The NPU benchmark's battery measurement no longer comes out empty when the PC is busy.

### Before you update

- Nothing: it updates itself as usual. The agents get it as each takes kit 2.73.4.
## 0.36.21

**An update cut short by a crash no longer leaves an agent that can't start: what an update or a save writes is on the disk before it takes its place.**

### What changed

- The Steward hands out kit 2.73.3 and runs on it. When the PC went down seconds after Manor updated an agent, Windows had kept the swap of the agent's folder but not its files: they came back full of nothing (NUL bytes), and the agent's page couldn't start until it was installed again. Now each update writes the new version's files to the disk before swapping them in, and the copy kept for a rollback too.
- The same for every settings and state file the Steward and the agents write: after a crash each is as it was before the save or as it was after, never empty. Each save takes about a millisecond longer.
- Kit 2.73.3 also brings Intel's NPU 3720 tuning: on a PC with that NPU (Core Ultra Series 1, or 200U), the agents' local model answers a short question in about half a second instead of three, and the NPU check measures a real first compile. A PC whose NPU is already set up keeps its settings until it is set up again.

### Before you update

- Nothing: it updates itself as usual. Each agent gets the same once the Steward moves it onto kit 2.73.3.

## 0.36.20

**The Steward's own tests run faster, so a vouch on one of its pull requests and the test run before each kit release finish sooner.**

### What changed

- The Steward's tests no longer build each stand-in repository from scratch with eight git commands. They build the first of each kind once and copy it for the rest, each copy with a first commit of its own. Its slowest test files take about a quarter less time: on the owner's laptop, the merge guard's tests went from 30 to 22 seconds and the catch-up's from 80 to 59. The whole set of seven slowest files went from 218 to 181 seconds.
- A few tests make several of their stand-in pull requests in one push instead of one push each.
- Nothing the Steward does outside its tests changed.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.19

**A vouch no longer tests code again when the Assayer already ran the tests the change reaches, not just the whole suite.**

### What changed

- When a session checks its work with the Assayer's `affected` check (only the tests the change reaches) and commits exactly that, `steward vouch` now takes that pass instead of running the tests a second time. It does so when the test files the Assayer ran include every one the vouch would pick itself against `origin/<branch>`, and every other check (the typecheck and the rest) ran in full. Its status then says so: `npm test (affected: 12 of 126 test files, the Assayer's)`.
- If the Assayer ran fewer test files than the vouch would, or doesn't say which (Vitest and Jest pick their own), or Settings have the vouch run the whole suite while the Assayer ran only some, the vouch runs the checks itself, as before. A full Assayer pass is still taken as it was.

### Before you update

- Nothing: it updates itself as usual. The Assayer records which test files an affected check ran from its 0.3.35 on. Until then, only its full checks stand in for a vouch.

## 0.36.18
**Half the processes for its git and gh calls: they share its page's console instead of each starting a console host of its own.**

### What changed

- The Steward's page now keeps a console with no window, and the git and gh commands it runs all day share it. Before, Windows started a console host (conhost.exe) beside every one of them: 40 git and gh calls started 82 processes, and now start 43. In a trace of the Steward's rounds, console hosts were 40% of everything it started.
- The tests it runs (a kit's trial, a vouch, a pull request's test) no longer start git's upkeep after each of their throwaway commits, which made a third of the processes a test's commits started.
- With the Steward's kit 2.73.2, every agent's page gets the same console the next time it starts. The agents start sharing it once they take that kit and start their git that way.

### Before you update

- Nothing: it updates itself as usual. The change takes effect when its page restarts after the update.

## 0.36.17

**Releases go out again on a PC whose folders are on a Dev Drive: the Steward works in its work folder by its real path, and a release that published nothing is no longer called released.**

### What changed

- The Steward now works in its work folder by its real path, wherever the folder is reached through a junction, a symbolic link or a Dev Drive mounted in a folder. From the evening of 2026-10-13, when the owner's work folder became a junction to a Dev Drive, every agent's release ran its release command there and did nothing: the kit's release script didn't recognise itself through the junction and exited without building or publishing. The Steward reported each one released, round after round, and every other round failed with "a missing but already registered worktree".
- A release command that finishes without making the agent's GitHub release is now a failed release on the PC that releases Castellan too, as it already was everywhere else, rather than "released". Such a release raises the usual alarm and waits for a person or a new commit, instead of reporting success.
- A folder the Steward made in its work folder is recognised as its own however its path is spelled, so one a stopped stage left behind is still cleared.
- The Steward hands out kit 2.73.1: the kit's scripts recognise themselves through junctions and Dev Drive mounts too, and the kit's new spec/DEV-DRIVES.md sets out how every agent compares paths.

### Before you update

- Nothing: it updates itself as usual. If you set the Work folder in settings.json to a Dev Drive's own letter to get releases going, you can leave it: it now works either way.
## 0.36.13

**The Steward's checks go easier on your PC: a quarter of the processor at most, a cap on memory, two runs at a time, and your Settings as the only switch.**

### What's new

- Checks can't take all your memory. Each program gets at most an eighth of the PC's memory (2 to 6 GB), and all the checks together a quarter (4 to 12 GB). A test that runs away fails instead of slowing the whole PC.
- At most two check runs go at once on the PC, from the Steward, the Assayer or a Claude session. The rest wait their turn, 20 minutes at most.
- Local AI model servers no longer run at the limits of whichever agent started them, so they answer every agent at full speed.

### What changed

- Tests, type checks, installs and release builds the Steward runs now use at most a quarter of your processor (two cores' worth at most), the same share as the agents' own background work. Before, they could use half.
  - Measured on an 18-core laptop with the Assayer's test suite on a quiet PC: before, the whole PC peaked at 91% and the suite took 39 seconds; now it peaks at 43% and takes 65 seconds.
  - The Steward allows checks four times their usual time before it gives up on one.
- Your background pace in Manor's Settings decides how hard the Steward and the agents work. At Full speed, checks run at full speed too. While it's gentle, `"checksPace"` in Manor's settings.json can give checks a different share.
- Nothing else lifts it:
  - `steward vouch --fast` is gone (it says so and vouches at the usual pace);
  - looking at an agent's page no longer lifts its limits, so the page shows what the agent really costs in the background;
  - Run now runs at your pace.
- Brings the Steward's kit 2.73.0.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.12

**A new kit that fails some agents no longer holds up the Steward's queue: what isn't the kit's doing is set apart, the rest goes to the Wright, and the PRs behind it merge meanwhile.**

### What's new

- When a new kit fails an agent's checks in its trial, the Steward runs the same checks once more on that agent as it is, without the new kit. If they fail there too, the problem is the agent's or this PC's, not the kit's: it no longer holds the kit back, and the trial's comment names it apart.
- When a new kit fails an agent's checks before release, the Steward hands that agent to the Wright: an issue in the agent's repository asks for a change that works with the new kit. Once that change is ready and passes, the kit goes ahead, and the agent's change follows it. The issue closes by itself when it's no longer needed.
- A kit PR whose trial still fails agents gives up its turn in the queue, as a PR with a conflict already does. The PRs behind it merge meanwhile, and it merges once its trial passes.
- Failures that an older Steward recorded in a kit trial are tried again once by the updated Steward, so a problem in the Steward itself doesn't keep a kit waiting after it was fixed.

### What changed

- A kit change that fails some agents is brought up to date by itself when a fix for the kit has landed in the meantime, and tried again with that fix, instead of failing the same way round after round.
- The Steward's comment on such a change says that the Wright has the failing agents, and that the change is tried again once the kit moves underneath it.
- On a PC whose work folder is on a drive that has no letter (a Dev Drive mounted only in a folder), the shared packages the Steward links into each check couldn't be found by esbuild, and every agent's page test failed. On 2026-10-13 that "failed" 22 of 34 agents in kit 2.69.0's trial and held every Steward PR behind it. On such a drive each check now installs its own packages. Giving the drive a letter as well (in its Properties) puts the shared packages back in use.

### Before you update

- Nothing: it updates itself as usual. The Wright gets this work only on a PC where the Wright is installed; elsewhere a failing kit still waits for a person, as before.

## 0.36.10

**A vouch or a PR test on the Steward's own code runs only the tests its change reaches, and its whole suite runs before every kit release.**

### What changed

- A changelog entry, a README or another Markdown file no longer runs most of the tests. Only code that reads that file from its own place counts, such as a test checking the Steward's own changelog. Code that reads the changelog of a worktree or a commit it's given doesn't.
- In the Steward's own repository, a change to the kit runs the kit's tests and the tests of the code that uses the kit's copies in the repository, instead of the whole suite. A kit version step (`kit/VERSION` and `kit.json`'s pin) runs only the tests that check the versions agree. In an agent's repository a kit change still runs everything.
- A file in a folder that code reads as a whole (`new URL('./core/', import.meta.url)`) now reaches that code, rather than running everything.
- On the Steward's last twelve merged PRs, a vouch would have run about 45 of 126 test files on average instead of about 100, and taken about a third less test time. Seven of those twelve ran the whole suite before; none do now.
- This release brings the versions below it that weren't released on their own (0.35.61 to 0.36.6) too, and the Steward uses kit 2.72.1 itself.

### What's new

- Before releasing a kit, which every agent takes, the Steward runs its own whole suite at that commit, unless it has already passed that exact code whole. A failure there holds the kit's release like any failed release: an alarm, and no retry until a new commit lands on main. The Steward's own releases aren't held for it.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.6

**The Steward's kit 2.71.1: the tests the Steward runs no longer sign their throwaway commits with your key, and release builds are tested once, before a kit is released, not in every check.**

### What changed

- When the Steward runs a repository's checks (a kit's trial, a vouch, a pull request's test, a catch-up, a merge train), git's commit and tag signing is off for those checks alone. With commit signing on (an SSH or GPG key), every throwaway commit a test made started ssh-keygen or gpg, and Windows Defender scanned each one: 461 in one run of the Steward's own tests. Your own git settings are untouched, and the commits the Steward pushes are signed as before.
- The Steward's own tests sign nothing either, and its two tests of building a release build once each instead of five and two times: the builds those tests made over and over now run once, before a kit is released, and checking a pull request takes minutes less.
- Before it releases a kit, the Steward installs its packages and builds every kind of release the kit makes (`npm run test:release`). A kit whose release builds fail isn't released, and says so.
- A check of the Steward no longer fails now and then because another one ran at the same time: its tests that open a page each take a port nothing else is using, instead of sharing one.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.4

**The branch heads it shares with your other agents now include its own repository and every branch of a large one, so they stop asking GitHub for these themselves.**

### What changed

- Each round the Steward shares what it read of every repository's branches, so the other agents (the Assayer, Reeve) can tell whether anything moved without asking GitHub themselves. Its own repository was left out of that, and so was any repository with more than 100 branches (Manor's has about 150): the agents asked GitHub about those on their own, every time. Both are shared whole now. A repository with more than 100 branches costs one more small question to GitHub a round, asked for all such repositories together.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.2

**The Steward's kit 2.71.3: agents read and write their small files far less often, so Manor checking on them costs almost nothing.**

### What changed

- Each time Manor checks on an agent (about 1,300 times an hour with Manor's page closed, 15,800 with it open), the agent used to read its settings, its on-duty switch and Manor's settings from disk. It now reads them only after they change, and otherwise only checks that they haven't.
- An agent no longer rewrites a file with what it already holds.
- An agent waiting for its settings (or for a license) notes it once, not again every round. Manor and the Surveyor still say what it waits for.
- The Steward uses kit 2.71.3 itself.

### Before you update

- Nothing: it updates itself as usual.

## 0.36.1

**The Steward's kit 2.72.0: the agents run on a better schedule, on one shared clock, each in a minute of its own.**

### What's new

- Every agent that takes this kit runs its rounds on the manor's shared 30-minute clock: a round every 5, 10, 15 or 30 minutes, or every 1, 3 or 6 hours, falls on fixed times instead of drifting a little later each round.
- Each agent has its own minute on that clock, so they no longer all start work in the same minute and load the PC at once.

### What changed

- The Steward's own rounds go on the clock too.

### Before you update

- Nothing: it updates itself as usual. Each agent goes on the clock when it takes this kit.

## 0.35.79

**An agent update that stopped for a moment's trouble on this PC is finished by itself.**

### What's new

- When an agent's update was rolled back only because this PC's network dropped for a moment (its page gave no answer while the PC was offline, or while several agents were rolled back together), the Steward now allows that version again by itself and asks Manor to install it. It does this once the PC has been quiet for half an hour, as many agents at once as Manor lets agents work at once (two, unless Manor's settings say otherwise), and only once for each version. The install still goes through its usual checks, so a release that really fails is rolled back again.
- A rollback that doesn't look like the PC's doing, or one that happens again after the Steward allowed the version, raises an alarm that gives the real reason and when it happened, instead of Manor's "failed 3 times".
- When Manor gives up on an update for another reason, the Steward checks whether Manor's install would take the new version now (a dry run, which changes nothing). If it would, the Steward presses Update for it once; if not, it raises an alarm in the install's own words.
- All of this comes under "Keeps the staff's pages up" in Settings: switched off, the Steward leaves Manor's updates alone.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.78

**A quiet round starts about two git processes instead of over a hundred.**

### What changed

- Turns are read only for the repositories the round looks at, through GitHub's API from the Steward's own process, instead of one `git ls-remote` per repository every round.
- A PC that has seen no other PC for a month takes its turns for half a day, so it renews them twice a day instead of every few rounds.
- Version queues fetch a repository only when GitHub says its main branch has moved.
- The staff table rebuilds only the rows whose repository changed, and checking a checkout for uncommitted work no longer lists untracked files.
- On a PC that merges the Steward's own pull requests, the round reads them in the same GitHub query as everyone else's, so merging them and showing the Steward's row in the staff table no longer ask GitHub separately. A new pull request to the Steward now refreshes its row in the table, too.
- Ports are read from each clone again only after its branch has moved.
- Your PC should be noticeably quieter: far fewer git windows and credential checks in the background.

### Before you update

- If you add a second PC later, it takes over each repository's turn when the first PC's half-day turn runs out, or at once with **Do it here**. Otherwise nothing: it updates itself as usual.

## 0.35.77

**The kit it hands out, 2.71.2, gives a refused project's reason without talking about employees.**

### What changed

- When a project in Manor's Settings is one of the manor's own repositories or checkouts, the reason it's turned away now reads "the manor looks after it itself, so it can't be a project". It used to talk about employees and staff. Which projects are refused hasn't changed.

### Before you update

- Nothing: it updates itself as usual. Each agent picks up the new wording with its next kit update.

## 0.35.76

**The Steward's kit 2.71.0: on a PC with 16 GB of memory or less, the local AI on the NPU gives its memory back sooner when nobody is using it, and wakes again when it's needed.**

### What's new

- On a PC with under 20 GB of memory, the NPU's local AI stops after 5 minutes unused (10 on AMD NPUs, whose AI takes longer to start), instead of 10. That frees 2 to 6 GB for everything else. On bigger PCs nothing changes.
- The first question after a rest waits a few seconds while the local AI wakes, and agents can say so ("Waking the local AI on the NPU…") rather than leaving you wondering.
- The NPU check can test the rest and the waking on a real NPU (`--idle`), and says whether each step passed.

### What changed

- On Intel NPUs, the code-search server is stopped when idle too. Before, it kept 1.7 GB until the PC restarted.
- A request that arrives just as the local AI is resting is never cut off: it waits, then wakes it.
- The first answer after the local AI wakes is given the time it needs to load, so it no longer fails on a short timeout.
- The NPU's idle minutes in Settings still win when you've set them, on any PC (0 keeps it running).

### Before you update

- Nothing: it updates itself as usual. Your agents get the new timings as they take kit 2.71.0.

## 0.35.75

**A Wi-Fi drop during an update no longer rolls the update back.**

### What changed

- The Steward's kit 2.69.1. After an update, each agent (the Steward too) checks that its page came up before keeping the new version. Part of that check used the page's name, such as `lamplighter.localhost`, and on Windows that name is looked up through your network. When the Wi-Fi or router dropped mid-update, the lookup failed, and an update that was working was rolled back and marked unsafe. The check now goes straight to the page on this PC, and a page that's slow to show its first screen gets the whole check (90 seconds) to do it. A page that shows an error, answers as the wrong version, or stops is still rolled back as before.

### Before you update

- Nothing: it updates itself as usual. Each agent gets the fix with its next release built on this kit. Updates already rolled back this way stay marked until they're allowed again; the Steward retries them by itself.

## 0.35.74

**The Steward's kit 2.72.1: when the NPU can't do something, the graphics card does it, only while it's needed.**

### What's new

- On a PC whose NPU can't look at pictures (Intel's), the staff can now describe images and screenshots: the graphics card loads its vision model when they're asked to, and unloads it after 10 minutes unused, so it isn't kept running and drawing power.
- The same goes for any work the NPU couldn't take on at Set up: the graphics card does it when asked, then rests.
- Set up downloads less beside an NPU: with "Use the graphics card for models when there's an NPU" off, the graphics card gets only the models for work the NPU can't do. On an Intel PC that's its vision model alone, about 3.1 GB less than before. If the NPU fails part of its test at Set up, the graphics card is set up for that part instead.

### What changed

- With "Use the graphics card for models when there's an NPU" off (the default), the graphics card is no longer left out altogether: it still never does the NPU's own work, and on a PC whose NPU does everything (a Snapdragon) it isn't used at all, as before.
- The NPU check waits as long as each of its steps allows; before, a very slow answer gave up after 5 minutes.
- Turning "Use the graphics card for models when there's an NPU" on later: press "Set up again" for local AI, and it sets up the rest of the graphics card's models then.

### Before you update

- Nothing: it updates itself as usual. How long the graphics card may rest unused before it unloads is the same setting as before (10 minutes by default).
- A graphics card already set up with its chat and search models keeps them: nothing is deleted, and the staff simply don't use them beside the NPU while the switch is off.

## 0.35.73

**A release, a kit trial or a PR's test no longer stops for good when its last work folder vanished.**

### What changed

- On a PC where the Steward's work folder is a link to another drive, the Steward didn't recognise its own work folders, so it never told git they were gone. The next time it needed the same folder, git refused it ("a missing but already registered worktree"), and that release, kit trial or test failed every round. On 2026-10-13 this held up the Steward's kit trial, every Steward PR waiting behind it, and Reeve's release for hours. The Steward now finds its work folders through the link.
- Whenever it clears a work folder a stopped job left behind, it also makes git forget it. If git still refuses a work folder that has gone missing some other way, the Steward clears git's record and tries once more. This covers releases, kit trials, catch-ups, merge trains, refreshes, PR tests and the Steward's own release.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.72

**`steward vouch` no longer runs the tests a second time on code the Assayer just passed.**

### What changed

- If the Assayer's check passed your work (every check, the whole suite) and you then commit exactly that code, `steward vouch` takes the Assayer's pass and records the vouch in seconds without running anything. It says so in one line: "the Assayer passed this exact tree at <time>". Before, vouch ran the same suite again on identical code, which doubled the load on your PC.
- The Assayer's pass counts only for exactly the committed code, with the same installed dependencies and the same Steward's kit, when it's under a day old and covers each check the Steward would run. Anything else (no check, a partial one, different code, a failure since) runs the checks as before.

### Before you update

- Update the Assayer to 0.3.31 or later: older Assayers don't record which code they checked, so vouch runs the checks as before.

## 0.35.68

**New kits roll out once they settle, and releases take far less of the PC's time.**

### What's new

- A new kit goes out to the agents once two hours pass with no newer kit, not as soon as it's released. When kits come in a burst, only the newest goes out, so each agent gets one update instead of one per kit. No kit waits more than 12 hours, counted from the oldest kit still waiting. A kit whose changelog entry starts with "Urgent" goes out at once.
- Two new settings on the Castellan tab, under advanced: **A new kit settles for** (2 hours by default; 0 sends each kit at once) and **A new kit waits at most** (12 hours).
- While a kit settles, the round's log says until when. The kit rolled out last still reaches any agent that's behind it.

### What changed

- A kit update now runs only the tests the kit's changes reach, as the kit's trial does, not each agent's whole suite. An agent the kit changes nothing for still gets its update, with its build and type checks but no tests. When the trial already passed an agent at the same commit, its checks aren't run again, even if the trial ran only some of its tests.
- Releases use the packages already installed for the same lockfile, as kit updates do, instead of installing them afresh every time.
- The site refresh keeps its folder from one refresh to the next, and installs the site's packages again only when they change. While a rollout is merging and releasing round after round, one refresh covers all of those releases, and none waits more than an hour.
- Twelve sets of shared packages are kept instead of six, so a set is no longer removed and installed again within the same round. A half-finished install is cleared as soon as the process that started it has stopped, instead of after a day.

### Before you update

- Nothing: it updates itself as usual. To roll out each kit at once, as before, set **A new kit settles for** to 0.

## 0.35.66

**No package's install script runs where the Steward installs packages unless you allow it, and a PR that brings new packages waits for you.**

### What's new

- Every install the Steward makes (the shared packages for checks, a bump's, a PR's checks, a release's, a refresh's, its own release) now runs `npm ci --ignore-scripts`. Only the packages on a short list in Settings, **Install scripts allowed**, then have their install scripts run, by name. The list starts with the three the manor's own repositories need: esbuild, unrs-resolver and fsevents.
- A package with an install script that isn't on the list stops the work before anything is installed. An alarm (and a Windows notification) names the package, its version, the repository and the script it would have run. If you trust it, add it to the list and the next round goes on; if not, take it out of the repository's dependencies.
- Any pull request, not only the Wright's, whose `package-lock.json` brings a package new to the repository, or a package with an install script that isn't allowed, waits for you. Look at what it brings, then merge it yourself or label it `owner-done`.

### What changed

- A dependency installed from git, rather than from npm's registry, always stops the work, whatever its name: npm runs its prepare script as it installs.

### Before you update

- Nothing: it updates itself as usual. Pull requests that update dependencies now wait for you when they bring packages the repository didn't have.

## 0.35.64

**The Steward's checks can't max out your processor any more, and each pull request is tested once rather than twice.**

### What's new

- Tests, type checks, installs and release builds that the Steward runs use at most half your processor, at low priority, so your PC stays quiet and responsive while they run. That covers `vouch`, the kit's trials on every agent, the checks before a merge, rollouts and releases. Several running at once share that half rather than taking half each.
- To change the share, set `"checksPace"` in Manor's settings.json: a percentage from 10 to 100, or `"full"` for no limit. `steward vouch --fast` runs one vouch at full speed.
- When the Steward tests a pull request itself and it passes, it marks that commit as tested on GitHub, as `vouch` does. So does a pull request it catches up or stamps where only version lines and changelogs changed, since it isn't tested again. The Assayer then doesn't install and test the same pull request a second time, which used to double the work on your PC (and Windows Defender's scanning of every file each install wrote).

### What changed

- Measured on an 18-core laptop with the Steward's own checks: before, the processor sat at 98% or more for a full minute of a 3½-minute run. Now it gets there for about a second, and the run takes about as long as before.
- Brings the Steward's kit 2.70.0, whose checks pace other agents can use for their own test runs.

### Before you update

- Nothing: it updates itself as usual. The first paced check builds a small helper program once (about half a second).

## 0.35.60

**The Steward's kit 2.68.0: local AI is set up safely on Intel NPUs that haven't been tested yet, and an NPU that can't do the work never shows an error.**

### What's new

- On a PC with a newer or older Intel NPU than the one tested so far (Meteor Lake, Arrow Lake, Panther Lake, Wildcat Lake), Set up measures that PC's NPU and sets its waiting times to suit it, instead of guessing.
- Set up checks that the NPU's answers make sense, not just that it answers, for both chat and code search.
- Set up uses the NPU only where the PC has the memory for it. On an 8 GB PC the NPU is left out; on a 12 GB PC it chats, and code search runs elsewhere.

### What changed

- When the NPU can't do something, Set up no longer reports an error. The graphics card or the processor takes over that work (chat and code search separately), and the accelerators' details say in plain words why the NPU isn't used.

### Before you update

- Nothing: it updates itself as usual. On an Intel PC, running Set up again applies the new checks.

## 0.35.59

**The Steward's tests pass on any PC, not only on its maker's laptop.**

### What changed

- Eleven tests took part of their setup from the PC they ran on, and failed elsewhere (on the Intel test laptop, say). The pieces they took were these:
  - whether this is the PC with Developer Pro;
  - Manor's Developer options switch;
  - whether the Surveyor is installed.
- Each test now says what it means. Nothing in the Steward itself changed.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.58

**The Steward's kit 2.67.0: Intel's NPU takes longer requests, and makes embeddings.**

### What changed

- The Steward's kit 2.67.0. On a PC with an Intel NPU, a request to the NPU may now be up to 4,096 tokens (it was 1,536). The NPU also makes embeddings, so code search works on such a PC with Manor's default settings; before, nothing there made them.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.57

**Two pieces of work on the same repository no longer end up with the same version.**

### What changed

- A version claimed for new work while a round was running could be forgotten at the end of that round, so the next catch-up handed the same version to another pull request. Claims made mid-round are now kept, and catch-ups skip them.
- The Steward reads the shared list of claimed versions as it is when it copies it, not as it was when the round began.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.56

**Installing a project's packages no longer falls back to a slow install of its own now and then.**

### What changed

- Once the Steward has installed a set of packages to share, it moves the finished folder into place. Windows sometimes refuses that for a moment while Defender or the indexer is still reading the new files, and the Steward then gave up on sharing and installed the packages again in that worktree. It now waits briefly and tries again, for up to 15 seconds.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.54

**The Steward's kit 2.66.0, with a benchmark for ranking chips and models.**

### What changed

- The Steward's kit 2.66.0: a benchmark that measures how fast and how well a PC's NPU (or graphics card) does Castellan's work, for the website's rankings. Nothing changes on your PC unless someone runs it.
- Agents now count how many tokens they send to their local models each day, so the benchmark can weigh its jobs the way agents really work. Only the counts are kept, on your PC, for 60 days, and nothing is sent anywhere.

## 0.35.53

**The Steward unpacks a project's packages once for all the staff that use them, and one install at a time.**

### What changed

- Staff whose packages are the same now share one copy, even when their own project details differ (the command they install, the version ranges they ask for). Before, six agents with the very same packages each had a copy of their own, about 50 MB and 800 files unpacked six times.
- Only one package install runs at a time on the PC, whichever part of the Steward asks for it: its page, a round in a terminal, or a check before a merge. Several installs side by side were the heaviest bursts of disk and memory work the PC saw.
- Packages already in npm's own cache are taken from there without asking the registry again.

### Before you update

- Nothing: it updates itself as usual. The first checks after updating install the packages once more into the new shared copy. The old copies are cleared away as they go unused.

## 0.35.52

**A new kit is tried on the staff in one go, beside the rounds, instead of a few each round.**

### What changed

- When the Steward's own PR brings a new kit, its trial on the staff now runs on its own from the Steward's page, start to finish, while the rounds go on merging and releasing the rest. Before, each round tried the staff for 8 minutes and then waited for the next round, so a trial took many rounds.
- Up to 4 staff are tried at once on a PC with enough processors (more if Settings ask for more), but never more than its free memory holds, at about 3 GB each.
- As soon as a trial ends, a round comes to merge the PR or say which staff it fails, without waiting for the next scheduled one.
- A second kit's trial waits for the first to end, and a trial another Steward process is already running is left to it.
- A round run from a terminal still tries a few each round, as before.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.50

**The Steward's kit 2.65.0: an Intel NPU that works, run on a real Lunar Lake.**

### What changed

- The Steward's kit 2.65.0. On an Intel Core Ultra PC without Microsoft's Visual C++ runtime, setting up local AI used to skip the NPU and say an administrator must install the runtime first. Now setup downloads the runtime from Microsoft and puts it beside the NPU's model server, with no administrator, and the NPU is set up.
- Intel's NPU now runs a version of Qwen3-4B made for it (2.2 GB): the model it had answered with nonsense on a real Lunar Lake. Setup now checks that the NPU's answer makes sense before using it.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.49

**A pull request stuck on a conflict no longer holds up the pull requests queued behind it.**

### What's new

- A new alarm, **A conflicting PR holding others up for** (in Settings, under Alarms, 1 hour by default). It goes off when the lowest-version PR in a repository conflicts with its branch and other ready PRs are waiting their turn behind it. It names the PR, the files it conflicts in, and the PRs it holds up. Before, nothing showed for a whole day (the "A PR waiting for" alarm), however many PRs were held up meanwhile.
- When a conflict has been left unresolved for that hour after its author was told, it is handed to the Wright (where the Wright works) as a work issue. The Wright opens a draft that carries the PR's change with the conflict resolved. The PR gets one comment saying the Wright has it. If its author resolves it first, the issue closes by itself.

### What changed

- A ready PR whose conflict needs a person, and whose author has been told, now gives up its turn. The ready PRs above it merge without waiting for it. Once it is resolved, it is caught up and given a version above theirs, as a PR overtaken by a lower one already was. A draft still keeps its place. So does a conflict the Steward couldn't tell anyone about, and the new alarm goes off for that one within the hour.
- The comment telling an author about a conflict is posted once. It is posted again only if the PR gets a new push or the conflict moves to other files, not each time another PR merges.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.47

**The Steward starts far fewer programs each round.**

### What changed

- git starts on its own, without Git for Windows' launcher and a console host for it: a third of the programs each git command started.
- Checking which PC releases each repository asks the remote over https from the Steward itself, not through git, and reads the turn record again only when it changed. On one PC that was about 140 git commands in 22 minutes, each two programs or more.
- A checkout's remote address is read from its config file instead of asking git.
- gh no longer starts a copy of itself after each command to send telemetry, nor looks for its own updates.
- The files a round reads from each repository (its version, its kit, its port) are read with one git command instead of one each: on 38 repositories, 38 commands instead of 266.
- The Steward's kit 2.64.0, which brings the first two to every agent that takes it.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.46

**The round's one look at GitHub works again, and shares every branch it read with the rest of the staff.**

### What changed

- The round asks GitHub about every repository in one go, then looks closer only at those that changed. With many repositories that question took GitHub longer than the 10 seconds it allows, so GitHub gave up, and every round fell back to asking about each repository on its own: many more questions to GitHub and many more programs started. The Steward now asks about 5 repositories at a time, which takes a few seconds each. If GitHub still gives up on one of these questions, it asks again in halves.
- With that look working, the branch heads it reads now reach the rest of the staff, as kit 2.58.0 meant them to. Reeve's hourly round uses them instead of asking each repository's origin itself.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.45

**The Steward's kit 2.63.0: on a Snapdragon, search runs on the NPU.**

### What changed

- The Steward's kit 2.63.0: setting up local AI on a Snapdragon now puts the work behind search (embeddings) on the NPU, beside its chat. It finds the right files as well as the graphics card does, in about half the time, and leaves the graphics card free.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.44

**Releases can carry an agent's own native program, signed, for both kinds of Windows processor.**

### What's new

- The Steward's kit 2.62.0. An agent that needs a program of its own beside Node (Envoy's media host, which hears voice chat on the NPU) says so in its kit.json.
  - Its release builds that program for Arm and x64 PCs and signs it with your code-signing certificate.
  - The release carries both builds; each PC keeps its own.

### What changed

- Releasing such an agent needs your code-signing certificate's key, as Manor's setup does: connect SimplySign Desktop first. Without it, the release stops before building, and says so.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.43

**The kit it hands out is 2.61.0: an employee's page can stream a reply.**

### What changed

- The Steward hands out kit 2.61.0. An employee's page can now send a long reply as it is made, which the Chronicler needs to record a game played on another of your PCs.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.41

**The Steward's kit 2.60.0, with a check for trying an NPU on new hardware.**

### What changed

- The Steward's kit 2.60.0: a check that sets up the model server for an Intel or AMD NPU, measures how it runs, and suggests its limits from the numbers. Nothing changes on your PC unless someone runs it.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.40

**An urgent fix can reach customers at once instead of waiting for the next release day.**

### What's new

- Castellan's releases reach customers on Tuesdays and Fridays. When a fix can't wait, start its changelog entry's bold line with "Urgent fix:". The Steward's round then lets that release out to customers as soon as it's published, whichever kit the agent has.
- `release-now <agent> [version]` lets a release that's already published out to customers now, on the PC that releases Castellan. Without a version, it takes the agent's newest release.

### What changed

- The Steward's kit 2.59.0, which publishes an urgent release as urgent (`--urgent`, or an entry marked "Urgent fix:").

### Before you update

- Nothing: it updates itself as usual.

## 0.35.39

**Fewer programs started for each round's fetches, and the branch heads it reads shared with your other agents.**

### What changed

- The Steward's kit 2.58.0. The way the Steward hands git its sign-in up front (since 0.35.31) is now in the kit, so other agents can use it: Reeve's fetches and its scheduled jobs can sign in once per host instead of starting Git Credential Manager for every fetch.
- Each round's glance at GitHub now also reads every branch head of your employees' repositories, in the same query, and leaves them in Castellan's folder (remote-heads.json). An agent that only wants to know whether a repository changed reads them there instead of asking GitHub itself. When the Steward hasn't read them lately, or isn't there, agents ask GitHub as before.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.38

**A program missing for a moment, such as Git updating itself, no longer holds kit updates for you to push.**

### What changed

- When a program the Steward runs can't be started for a moment (Git for Windows updating itself replaces it for about 20 seconds), the Steward waits for it to come back instead of counting the failure against the update it was working on. Before, a Git update in the middle of a round held each agent's kit update that the round was pushing, with a "push failed" alarm each, until you pressed Push.
- An update held this way before is let go by itself in the first round after this update, and its alarm goes. If the program stays missing, the alarm stays, and goes once the program is back.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.37

**The Steward's own tests wait for what they check instead of guessing how long it takes, so they no longer fail now and then on a busy PC.**

### What changed

- Tests that waited a fixed time before checking a result now wait for the result itself, with a deadline. A test that never sees it fails saying what it waited for, instead of hanging or passing by luck.
- This changes nothing in the Steward or the kit it hands out: only how their tests run. Pull requests should be held back less often by a test that failed for no reason.

### Before you update

Nothing: it updates itself as usual.

## 0.35.36

**The Steward's page, and every agent's once it takes kit 2.57.1, answers at once, even on a busy PC.**

### What changed

- While you have an agent's page open, the agent works at normal speed, so the page answers at once even when its background work runs gently or the PC is busy with something else. A minute after you stop using it, it goes back to working gently. A tab left open in the background doesn't count.
- Each page now also answers where browsers ask first (IPv6's ::1), so opening it, and its first request, no longer wait about a third of a second before the browser tries again.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.35

**Your staff start the usual way: Castellan, in Windows' Startup apps, starts them, not a hidden task each.**

### What changed

- The Steward's kit 2.57.0. Where Castellan is in Windows' Startup apps, an employee no longer starts from a hidden sign-in task of its own: Castellan starts at sign-in and starts your staff one at a time. Each employee moves over as it takes this kit. Turned off in Startup apps, Castellan and your staff start when you open Castellan instead.

## 0.35.34

**A restart in the middle of a test run no longer holds PRs back.**

### What changed

- When Windows ends the tests because the PC is restarting or shutting down, the Steward no longer counts that as the tests failing. The next round tests the train, or the pull request, again. Before, a restart in the middle of a merge train's tests made the Steward refuse that train afterwards, so its pull requests merged one at a time.
- The same goes for a release or a kit update whose commands Windows ended while shutting down: nothing is held against that commit.

### Before you update

Nothing: it updates itself as usual. A train held this way before the update is tried again in the first round after it.

## 0.35.33

**Uninstalling an employee with its data never removes a folder that isn't its own.**

### What changed

- The Steward's kit 2.56.1. When an employee is uninstalled together with its data, only its own data folder is removed. If its settings point that folder somewhere else (a drive, your profile, Documents, a projects folder, a repository), the uninstall stops and changes nothing, and says why. Employees take this kit as they update.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.32

**What the Steward did last is at the top of its page, and its settings are shorter.**

### What changed

- **Last stage** is on the Steward's page, above the staff, instead of in About: it's the quickest way to see what's going on. Its log stays folded unless the stage stopped or something in it failed.
- The **How it works** tab is shorter. Settings that nearly always stay as they are now fold under Advanced: **Catches PRs up with their branch**, **Merges ready PRs together**, **Tests only what a change reaches**, **Release right after merging**, **Checked at once** and **Stages at once**. Their values are kept.
- **Told after a release** is no longer shown: the Steward fills it in with Manor's update check itself. What's in it is kept.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.31

**The Steward starts far fewer programs: about half as many for each fetch, and none for a pull request it already has.**

### What changed

- **Fewer programs for each fetch and push.** Fetching a private repository over HTTPS started nine programs, six of them only to look up your sign-in and store it again. The Steward now looks your sign-in up once every half hour and hands it to git itself, so a fetch starts five. Your sign-in stays where it was: the Steward keeps it in memory only, and never writes it anywhere or puts it on a command line.
- **No fetch for a pull request that's already here.** Before reading a pull request, the Steward fetched it every round, even when the commit was already on your PC. Now it checks your clone first, from its files, and fetches only what's missing.
- **Gentler on your PC's memory.** On some Windows PCs every program that ends leaves a little kernel memory behind until you restart. Fewer programs means it builds up more slowly.
- **Safe with a stale sign-in.** If GitHub (or your git host) refuses the sign-in the Steward kept, it runs the command once more the usual way and looks the sign-in up again later. Your stored sign-in is never changed or erased.

### Before you update

Nothing: it updates itself as usual.

## 0.35.30

**The Steward only ever clears its own work folders.**

### What changed

- Before it makes a work folder again, the Steward removes only what it made there: a git worktree, or what's left of one in its own work folder. If Settings point the work folder somewhere else, such as your projects folder, a clone or any other folder there is never deleted. The Steward stops on it and says so.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.29

**A new kit reaches the agents in one round and a few minutes, not an hour or more.**

### What changed

- **The kit goes out in the round that releases it.** Before, the rollout waited for Manor to install the Steward that carries the new kit, and for the Steward to restart: up to an hour. Now the round hands each agent the kit's own tools as released, read from the kit's release in the Steward's clone, so nothing waits for the update.
- **Kit PRs merge a couple of minutes after they open.** A round that opened kit PRs brings the next round sooner, and the Steward's own kit PRs no longer wait to be 10 minutes old (**A PR merges once it is**, on the **How it works** tab, still holds every other PR). Their checks already passed here before they were opened.
- **After a restart, the first round comes within a minute**, not 2 to 15 minutes later. Manor restarts the Steward whenever it updates it, often halfway through a release, and that work now picks up again at once.
- **The Steward's own rounds don't queue behind the agents' work.** With the agents now taking turns (0.35.28), the Steward's rounds keep their own limit (**Stages at once**) rather than waiting for a turn among them.

### Before you update

Nothing: it updates itself as usual.

## 0.35.28

**Your agents now take turns: a few at a time, and fewer while the PC is busy.**

### What's new

- **A few agents at a time.** Agents that take this kit (2.56.0) run their scheduled rounds a few at a time instead of all at once: two at a time at a gentle background pace, four at full power. The rest wait their turn and follow as soon as one finishes. While your PC is busy or short of memory, they go one at a time.
- Each round now notes how much processor time and memory it used, and how long it waited its turn, so it's easy to see which agents are the heavy ones.

### What changed

- Run now still starts a round straight away, whatever else is running.
- The Steward hands out kit 2.56.0. Each agent changes once it takes the new kit and is released.

### Before you update

- Nothing: it updates itself as usual. Manor's Settings will get a setting for how many agents work at once; until then, the defaults above apply.

## 0.35.27

**Two stages at once: press Release while a round is running, and it starts straight away.**

### What's new

- **Stages run side by side.** A round no longer greys out the stage buttons: a Release, Bump, Push or Merge you press starts beside it, and so does Manor's ask to approve jobs after an install. The page shows a **Working** card for each stage running.
- **Stages at once**, a new setting on the **How it works** tab, says how many stages may run at the same time: 2 to start with, up to 4. Set it to 1 to go back to one stage at a time.
- Two stages never work on the same repository at once. Where both want one (you release Manor while the round is merging Manor's PRs, say), the second waits for the first to finish with it, and its log says so. The other repositories carry on meanwhile.

### What changed

- Still one round at a time. Run now is refused while a round runs, and a round asked for then comes once it can.
- With every slot taken, a button says which stages are running and to wait for one to finish. A stage started in a terminal counts too.
- The staff table's refresh leaves alone a repository that another stage is working in, and catches up with it at its next look.

### Before you update

- Nothing: it updates itself as usual. If you'd rather keep one stage at a time, set **Stages at once** to 1 in Settings.

## 0.35.26

**One box ticks every repository for a stage, or none.**

### What's new

- The repositories you pick for a stage on the Steward's page (the kit rollout, a release) now start with an **All** box, which says how many are ticked ("All (12 of 37)"). Tick it to pick every repository, untick it to clear them all, then tick the few you want. It shows half-ticked while only some are picked.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.25

**An alarm about a failed release or refresh says why it failed, and what to do.**

### What changed

- When a release, a refresh or a kit update fails, its alarm now quotes the end of what the command printed: the line that says what went wrong ("couldn't sign the setup: no certificate was found", say, or the check that failed), instead of only "failed (exit 1)". It names the file that holds the whole output, and it still says why in later rounds, not only in the round that failed.
- Where the Steward knows the cure, the alarm says it: a release that couldn't sign for want of its certificate tells you to sign in to the certificate's app (SimplySign, say) and release it again.
- A refresh whose own command fails now keeps its output too, as a failed release always did.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.24

**On the PC Castellan is made on, the Steward retires or recalls an employee from every manor, with your reason.**

### What's new

- `recall <agent> --why "..." [--versions 0.4.26]` takes versions of an employee back from every Castellan: each one stops it, updates it to a fixed version where there is one, or else takes its program off the PC with its settings and data kept, and never installs those versions again. Your words in `--why` are what the person whose PC it is reads.
- `retire <agent> --why "..." [--instead <agent>]` stops offering an employee; one already at work goes on, and its card says why.
- `lift-recall <agent>` takes it off the list, and `recalls` shows the list every Castellan reads now.
- Each list is signed on this PC with the recall key, so neither the Exchequer nor anything between it and a Castellan can make one.

### Before you update

- Nothing: it updates itself as usual. The commands work once the Exchequer 0.7.20 and Castellan 0.16.101 are out; they only work on the PC that holds the recall key.

## 0.35.23

**Settings you can read: each repository on one line, and only what's yours to choose.**

### What's new

- **Repositories have their own tab, and it opens first.** Each repository is one line: its name, its repository and branch, its note, what the Steward does for it (releases, or not released; no tests) and its **Merges PRs** switch, which you can flip right there. With more than eight, a box above the list finds one by name or repository.
- A repository opens to just what you decide: whether and how it's released, and its note. What the Steward finds by itself from your clone (its name, repository, branch, clone, tests, version files, and the kit, install and job commands) isn't shown at all, so it can't be set wrong by hand. If the Steward can't find one of them, that setting shows, with a line saying what to set.
- Everything else is on one more tab, **How it works**: your team, the rounds, merging and releasing, then **Alarms** and **The Wright's drafts** under headings of their own, in two columns in a wide window. On the PC that releases Castellan there's a **Castellan** tab too. Three tabs at most, where there were six.

### What changed

- Settings no longer has an Add button for repositories: they arrive by Hire, or by Look after on the Steward's page, with everything found from their clones. Each can still be removed here.
- "Takes the Steward's kit" is gone from Settings: whether a repository takes the kit is the Steward's to decide, from the kit.json on its branch. Saving Settings keeps what the Steward decided.
- Other settings the Steward works out for itself are gone from Settings too: the work folder, the .NET SDK, the Steward's own repository and clone, and where Castellan's releases go. Your settings.json keeps them, and one still shows if something is wrong with it.
- The pages the Steward reads for alarms (Manor's, the Surveyor's, Reeve's, the Wright's and the Bailiff's) are no longer settings at all: the Steward asks Manor where each one is, every time, so a page that moves is followed. An address saved in settings.json by an earlier Steward is ignored.
- Every setting's help is a line or two now, instead of a paragraph. A setting says its default, and offers Reset to default, only once you've changed it.
- A repository with a warning (an installed copy that isn't there yet, say) says "needs a look" on its line instead of opening by itself; one with an error still opens.
- Settings' tabs are underlined, and no longer filled with the accent colour, which was hard to read in the dark theme.
- The Steward takes the kit 2.55.0, which brings all of this to the Settings form.

### Before you update

- Nothing: it updates itself as usual. Your settings.json keeps its shape: nothing in it is moved or rewritten, though the alarm pages' addresses are dropped from it the next time you change an alarm setting.

## 0.35.22

**Every agent that carries the kit is looked after on it, however it was added.**

### What changed

- An agent added with **Look after** that carries the kit is now taken on as a hired one is: it takes each new kit, and the Steward's rounds test, merge, release and install it. Until now it was listed but left off the kit, unticked in **Roll out the kit**. Merging and releasing still follow what you ticked when you added it.
- Agents added that way before this version go onto the kit by themselves within a few minutes of updating. Repositories without the kit, such as a website, stay as they are.
- **Merge the team's PRs** shows only when Settings name a team. With no team set, the Steward's rounds still merge your ready PRs as before.
- Settings' tabs (General, Alarms and the rest) are plain tabs again, underlined when chosen, instead of bright filled buttons that were hard to read in the dark theme. This comes with kit 2.54.0, which every agent takes in turn.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.21

**The Steward no longer tries to open a pull request that is already open.**

### What changed

- When work opened its own pull request while a long round was under way (the Steward merging and releasing its own changes first), the Steward could try to open a second one for the same branch later in that round. GitHub refused it, and the round logged a failure that the Surveyor then reported as a warning. The Steward now checks with GitHub just before it opens one, and leaves the branch alone when its pull request is already there.
- If GitHub still answers that a pull request already exists, that branch counts as open, and the Steward goes on to its other branches instead of stopping.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.20

**A new kit's trial no longer holds up everything else, and takes far less time.**

### What changed

- Before a new kit is released, the Steward tries it on every agent. That trial used to take up a whole round, sometimes an hour, with no other pull request merged or released meanwhile. Now it goes a few agents at a time, at most 8 minutes each round, and the rest of the round's work goes on between. The kit's pull request waits meanwhile, its line says how far the trial has got, and the next round comes sooner.
- An agent that takes none of the kit's changed parts (a change to the web pages, say, for an agent without a page) isn't tried at all: its checks would run the same code as before.
- An agent the kit does change runs only the tests that reach the kit files that changed, rather than all of them. All of its tests still run once the kit is released, in the update the Steward opens for it.

### Before you update

- Nothing: it updates itself as usual. A kit trial already under way when it updates goes on as before; the next one goes the new way.

## 0.35.19

**A new kit reaches your agents sooner: each agent is tested with it once, not twice.**

### What changed

- Before a new kit is released, the Steward tries it on every agent and runs their checks. Once it's released, the update it opens for each agent no longer runs those same checks again where nothing has changed since: the agent's code is where it was when the kit was tried, and the kit and its fill tool are the ones that were tried. An agent that changed since is checked as before.
- A pull request that brings a new kit, caught up with its branch afterwards without changing the kit, keeps its trial: the agents aren't tried again for a version-number change.
- A pull request with a lower version than a new kit's no longer waits for that kit's trial on every agent: it merges first, and the kit's pull request follows it. Before, the lower one waited the whole trial, then had to be renumbered.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.18

**Your repositories' ready pull requests merge together as one train even where GitHub runs checks on them.**

### What changed

- Merge trains (several ready PRs of a repository stacked lowest version first, tested once and merged together) now take PRs that GitHub runs checks on, such as a site's preview build. Before, only PRs with no checks rode, so such a repository's PRs merged one at a time, each waiting for its checks again after every catch-up. Now the checks run once more on the whole stack, on the top PR, and the train merges once they pass: one wait for the lot.
- If those checks are still running after ten minutes, the PRs wait for them together (none merges alone meanwhile), and the next round merges the stack as it is, without testing it again. If they fail, the PRs merge one at a time, as before.
- A PR whose branch already holds the PRs under it (a stack pushed by the Steward, or one opened on top of the others) is taken as it is, rather than stacked again.

### Before you update

- Nothing: it updates itself as usual. Merge trains are on unless you switched them off in Settings.

## 0.35.17

**Each repository's pull requests sit under a heading of their own on the Steward's page.**

### What changed

- In Your repositories, a repository's open pull requests now sit under a small heading, in the words its host uses: Pull requests on GitHub, Azure DevOps, Gitea and Bitbucket, Merge requests on GitLab.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.16

**It hands out the kit 2.53.0, with a demo mode for each agent's page.**

### What's new

- The kit 2.53.0's demo mode: an agent's page can be shown with made-up data, so Manor can show a picture of each employee at work in the hire popup and on its role's page, without anyone's own files or mail in it.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.15

**A PR you labelled owner-done is merged even while it still carries owner-first.**

### What changed

- A PR that needs you first (labelled owner-first) is merged once you label it owner-done, as the rule says, whether or not you also took owner-first off. Before, the two labels together held it for good: CastellanSite's early-access PR waited five hours as next in line, and every PR behind it waited too. Its hold now says to label it owner-done, rather than to take the label off.

### Before you update

- Nothing: it updates itself as usual. A PR held this way merges at the Steward's first round after the update.

## 0.35.13

**It hands out the kit 2.52.0: Manor's updates no longer wait a minute and a half for each agent.**

### What changed

- Since the last kit, each agent's update was watched for 90 seconds before Manor moved on to the next one, so updating everyone took a long time. Now an update is checked for about 15 seconds, until the new version is up, and the rest of its watch runs in the background. A version that fails is still put back and flagged, as before.

### Before you update

- Nothing: it updates itself as usual. Each agent picks this up with its next release.

## 0.35.12

**The Steward and Manor bring each other back, and it hands out the kit 2.51.0: every agent's updates are rolled back when they don't hold up.**

### What's new

- Every agent can now be asked to put something right itself, such as starting its rounds again when they stopped coming. The Surveyor uses this to pass problems straight to the agent that can fix them, so you see only the ones that need you.
- When Manor's page stops answering, the Steward starts it again, as signing in would: after a minute and a half (Manor may just be updating itself), then up to three times, five minutes apart, then hourly. Manor already did the same for the Steward, so either one brings the other back.

### What changed

- After the PC starts, each agent's page now starts a little after you sign in, each at its own moment, and Windows tries again if it fails. A restart at noon on 11 October left every page down, because Windows ran them all at once before your folders were ready.
- Manor's down alarm now says the Steward is starting it again, and where to look if it stays down.

### Before you update

- Nothing: it updates itself as usual. Each agent gets the safe install with its next release built on the kit 2.51.0.

## 0.35.11

**Lighter in the background: it hands out the kit 2.50.0, and starts far fewer programs itself.**

### What changed

- Each round asks GitHub what changed straight from the Steward, instead of starting the GitHub command-line tool to ask. That tool now starts once, to sign in.
- It reads each repository's branches from the repository's own files, and starts git only to fetch or change something.
- Running in the background, git and the GitHub tool start without a console of their own, so each one is a single process rather than two.
- The Steward's own rounds run in the kit 2.50.0's background pace: Windows' efficiency mode, a very low disk priority and a cap on the processor while nobody is waiting on them.
- The kit 2.50.0 gives every agent the same background pace (its notes say more).

### Before you update

- Nothing: it updates itself as usual.

## 0.35.10

**It hands out the kit 2.49.0: Developer Pro, for the work the Wright and the Bailiff do with the rest of the staff.**

### What changed

- The Steward looks at the Wright's drafts, reads the Wright's and the Bailiff's pages for alarms, and shows their settings only with Developer Pro. That isn't sold yet, so on a customer's PC none of it shows, even with a Wright installed.
- The kit 2.49.0 gives every agent the same check.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.9

**Its page keeps what you act on; the rest is in About, beside Settings.**

### What changed

- About, beside Settings in the title bar, now has what you read now and then: the kit it hands out, the last stage with its log, and the merge conflicts it has settled.
- Merge conflicts stays on the page while a pull request it lists is still open.
- Found on this PC stays on the page while it has repositories to offer you, and moves to About once it has none.
- The tour's last step is now About.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.8

**It carries the kit 2.48.0: About beside Settings on every agent's page.**

### What's new

- The kit 2.48.0: each agent's title bar has an About button beside Settings, as Manor's has. About holds what you read once rather than every day, such as "Where its work runs" and, on agents that give one, how it works and how to set it up again.

### What changed

- "Where its work runs" moves from Settings to About on every agent once it takes the kit 2.48.0, so Settings holds only settings.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.7

**It carries the kit 2.47.0: long pages and long Settings in tabs.**

### What's new

- The Steward's Settings is in tabs: General, Alarms and the Wright's drafts, instead of one long form. One Save still keeps them all, and a tab with something to fix is marked.
- The kit 2.47.0: an agent whose page is long can put it in tabs, each with its own address. Short pages and short Settings stay as they are.
- The kit 2.47.0: a setting that lists things an agent already knows, such as your repositories, can be picked from a dropdown instead of typed.

### What changed

- The foot of every agent's Settings is tidier once it takes the kit 2.47.0: no band of another shade behind Save, and no lines stacked over each other above it.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.6

**It carries the kit 2.46.1: Settings marks a field "changed" only when you've changed it.**

### What changed

- The kit 2.46.1: on some agents' pages (Reeve's among them), every setting showed a "changed" mark even when nothing had been edited. Now the mark appears only beside a field you've changed and not yet saved.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.5

**A ready PR waits until it's 10 minutes old before it merges, which leaves time to push a small fix first.**

### What's new

- New setting: **A PR merges once it is** (default 10 minutes). The Steward won't merge a PR, even a ready one, until that long after it was opened. While it waits, its line says how long ago it was opened and when it will merge, and the next round comes sooner. Set it to 0 to merge as soon as a PR is ready.

### Before you update

- Nothing: it updates itself as usual. From now on, a PR opened less than 10 minutes ago waits for that time before it merges.

## 0.35.4

**It carries the kit 2.46.0: every agent's Settings can be in tabs.**

### What's new

- The kit 2.46.0: an agent can split its Settings into tabs, each with its own address, the way Castellan's Settings is. General holds the settings every agent has; the agent's own tabs follow.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.3

**After the PC sleeps, shuts down or loses its connection, the Steward tries again what failed meanwhile.**

### What changed

- When the Steward starts, or notices the PC has just woken from sleep, it gives each release that failed before one more try. Before, a failed release waited for you to release it by hand. If it goes through, its alert clears; if it fails again, the alert stays as before.
- When the PC wakes, the Steward runs a round straight away instead of waiting for the next one, so alerts that are no longer true clear within minutes.
- An agent whose page didn't answer before the PC went down is opened again at once, rather than an hour later. Its alert stays until its page answers.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.2

**The Steward stays at least 10% under GitHub's API limit, and spreads its rounds over the hour.**

### What changed

- A round asks GitHub about four times less than before. Looking at every repository at once used to cost 152 of the 5,000 points GitHub allows an hour for 38 repositories. It now costs 38.
- The Steward reads the account's limit, and what's left of it, from GitHub at every round. It never uses the last tenth, which stays free for your own `gh`, your sessions and the other agents on the same account.
- Rounds are spread over the hour. When a round would spend more than the hour so far allows, it waits and asks GitHub nothing. Its merges and releases come at the next round the budget allows. Run now still goes at once, short of the spare tenth.
- If GitHub still says the limit is reached, the Steward waits until the limit resets and writes one line saying until when. Before, every repository failed on its own, with a warning each.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.1

**Castellan's 7-day trial now ends in each agent too, not only in Manor.**

### What changed

- The Steward carries kit 2.45.0 and hands it to every agent. With it, an agent Castellan sells checks the license Manor holds, as it starts and every hour, without going online. Once a trial has ended, its rounds wait and its page says "The trial ended: a license brings it back". Its settings and data are kept, and a license brings it straight back.
- A paid license, even one whose paid time has passed, never stops an agent. Nor does a missing or unreadable license: the agent keeps running, and says so in its status.
- Free agents (Manor, Heiward) and the manor's own internal agents never check.

### Before you update

- Nothing: it updates itself as usual.

## 0.35.0

**Repositories worked with plain git: you say what the Steward does when a branch is ready, and after a release.**

### What's new

- Two new commands for each repository in Settings, used only when it's worked with plain git (it has no pull requests):
  - **When a branch is ready.** A branch that claimed a version and is pushed gets tested here at its head with your Test it commands. Then your command runs in your clone, lowest version first. Examples: `git push origin {commit}:refs/heads/{base}` lands it as a fast-forward, or a command of your own can open a review or send a mail. It fills in `{branch}`, `{base}`, `{commit}`, `{version}`, `{title}`, `{notesFile}` (the changelog entry), `{repo}` and `{checkout}`.
  - **After a release.** This runs once a release's tag is pushed, with `{tag}`, `{version}`, `{commit}` and `{notesFile}` (the release's notes), for a script that uploads the build or tells the team.
- A command that says yes isn't run again for that commit.
- A failing command is tried again at the next rounds, up to three times per commit, before it's reported as failed. A branch that can't go in holds the versions above it.
- A failed After a release is noted on the release, and the release still stands.

### What changed

- The Source control help in Settings now points to the two new commands.

### Before you update

- Nothing: it updates itself as usual. Both commands start empty, and an empty command changes nothing.

## 0.34.0

**Repositories on Bitbucket Cloud get their pull requests merged, stamped and released, as on GitHub.**

### What's new

- A repository on Bitbucket Cloud (bitbucket.org) is now worked with Bitbucket's way once an Atlassian API token for it is saved on the PC. Its pull requests are merged in version order, and only while their head is still the commit that was checked; `steward vouch` works on them and on branches with no pull request yet; the Steward opens a vouched branch's pull request itself. Bitbucket has no releases, so a release there is a `v<version>` tag with the changelog entry as its message. Without a token, such a repository is worked with plain git, as before.
- With no team named in Settings, the token's Bitbucket account joins the team.
- Settings' **Source control** says whether a Bitbucket token was found.

### Before you update

- Nothing: it updates itself as usual. To use Bitbucket's way, create an Atlassian API token with Bitbucket scopes (read and write for repositories and pull requests, read for your account), then open Windows' **Credential Manager**, choose **Windows Credentials**, **Add a generic credential**, and enter `git:https://api.bitbucket.org` as the address, your Atlassian account's email as the user name and the token as the password. The Steward notices within the hour, and never stores the token itself.
- Bitbucket Data Center (a Bitbucket server of your own) is still worked with plain git. On Bitbucket, the Wright's work issues aren't filed, and a pull request from a fork isn't worked with.

## 0.33.0

**Repositories on Gitea and Forgejo, Codeberg among them, get their pull requests merged, stamped and released, as on GitHub.**

### What's new

- A repository on a Gitea or Forgejo server (gitea.com, codeberg.org, or one of your own) is now worked with Gitea's way once the Gitea CLI (`tea`) is installed and has a login for that server. Its pull requests are merged in version order, at the commit that was checked; `steward vouch` works on them and on branches with no pull request yet; the Steward opens a vouched branch's pull request itself; and a release is a Gitea release with the changelog entry as its notes, whose files can be downloaded for an install after merging. Without `tea`, or with no login for that server, such a repository is worked with plain git, as before.
- With no team named in Settings, the account `tea` is signed in as on each server joins the team.
- Settings' **Source control** says whether the Gitea CLI was found and which servers it can work with.

### Before you update

- Nothing: it updates itself as usual. To use Gitea's way, install a Gitea CLI recent enough to have `tea api`, and add a login with `tea login add`; the Steward notices within the hour.
- The Wright's work issues are still filed on GitHub only.

## 0.32.0

**Repositories on Azure DevOps get their pull requests merged, stamped and released, as on GitHub.**

### What's new

- A repository on Azure DevOps (dev.azure.com, or an older organization.visualstudio.com) is now worked with Azure DevOps' way once the Azure CLI (`az`) is installed and signed in on the PC. Its pull requests are completed in version order, at the commit that was checked; `steward vouch` works on them and on branches with no pull request yet; the Steward opens a vouched branch's pull request itself. Azure DevOps has no releases, so a release there is an annotated `v<version>` tag with the changelog entry as its message. Without `az`, such a repository is worked with plain git, as before.
- With no team named in Settings, the account `az` is signed in as joins the team for that organization.
- Settings' **Source control** says whether the Azure CLI was found and signed in.

### Before you update

- Nothing: it updates itself as usual. To use Azure DevOps' way, install the Azure CLI and sign in with `az login`; the Steward notices within the hour.
- On Azure DevOps, the Wright's work issues aren't filed (they stay on GitHub), and a pull request from a fork isn't worked with.

## 0.31.0

**Repositories on GitLab get their merge requests merged, stamped and released, as on GitHub.**

### What's new

- A repository on GitLab (gitlab.com, or a GitLab of your own whose address says gitlab) is now worked with GitLab's way once the GitLab CLI (`glab`) is installed and signed in on the PC. Its merge requests are merged in version order, at the commit that was checked; `steward vouch` works on them and on branches with no merge request yet; the Steward opens a vouched branch's merge request itself; and a release is a GitLab release with the changelog entry as its notes. Without `glab`, such a repository is worked with plain git, as before.
- With no team named in Settings, the account `glab` is signed in as joins the team, as the GitHub account already did.
- Settings' **Source control** says whether the GitLab CLI was found and signed in.

### What changed

- A release's link in the round's line and on the page points at the release on its own host.

### Before you update

- Nothing: it updates itself as usual. To use GitLab's way, install the GitLab CLI and sign in with `glab auth login`; the Steward notices within the hour.
- The Wright's work issues are still filed on GitHub only.

## 0.30.0

**The groundwork for pull requests on hosts other than GitHub.**

### What changed

- Everything the Steward asks of where a repository lives (its pull requests, the vouch on a commit, its releases, and the Wright's issues) now goes through one place, with GitHub behind it. Nothing works differently today: on GitHub it runs the same commands as before. GitLab, Azure DevOps, Gitea and Forgejo, and Bitbucket come next, each in its own release, so a repository on any of them gets its pull requests merged in version order, stamped and released, as on GitHub.

### Before you update

- Nothing: it updates itself as usual.

## 0.29.1

**Work doesn't need to open its own pull request: push the branch, vouch for it, and the Steward opens it.**

### What's new

- `steward vouch` now works on a branch that has no pull request yet, once a version is claimed for that branch (`claim-version … --branch <branch>`) and the branch is pushed as it is in the clone. It runs the checks and records that they passed, as before, and asks the Steward for a round that looks at the repository.
- At that round the Steward opens the pull request itself, ready: titled with the repository's name, the version and the changelog entry's bold line, and described by the entry, with who vouched for it and what the claim says the work is. The same round then merges it without testing it again, stamping its version first where the repository keeps its entries in `changes`.
- A branch isn't opened while it has no vouch from your team, once its work is already merged, or when a pull request from it was closed at that same commit. The Wright's branches and the Steward's own still open their own pull requests. Only repositories on GitHub: one worked with plain git has no pull requests to open.

### Before you update

- Nothing: it updates itself as usual.

## 0.29.0

**Pull requests side by side stop fighting over version lines: a repository can let the Steward set the version as it merges.**

### What's new

- A repository can now keep its changelog entries waiting in a `changes` folder: each piece of work writes its entry as `changes/<version>.md` and leaves the version files and `CHANGELOG.md` alone. Just before merging such a pull request, the Steward brings it up to date, sets its version, moves its entry into `CHANGELOG.md` and deletes the file, all on the pull request's own branch, then merges it. Two pull requests opened side by side no longer conflict on the version or the changelog, and a version someone else took meanwhile is simply replaced by the next free one, with the pull request's title following. A pull request that was vouched for, or passed its checks on this PC, isn't tested again for it. A repository joins by having `changes/README.md` on its branch; others work exactly as before.
- `claim-version` says which file to write the entry in, for a repository that keeps its entries in `changes`.

### What changed

- A release now brings the changelog entries of every version merged since the release before, not just its own, so versions merged together in one round all reach the release notes and Manor's **What's new**.
- A pull request written that way never rides a merge train: it merges alone once stamped, without another test run.
- Brings the Steward's kit 2.44.0.

### Before you update

- Nothing: it updates itself as usual.

## 0.28.16

**A vouch and a pull request tested here run only the tests the change reaches.**

### What's new

- When `steward vouch` runs a pull request's checks, and when the Steward tests a single pull request itself, `npm test` now runs only the test files the change can reach: the ones it changed, the ones whose imports (and their imports, and so on) take in a changed file, and the ones that name a changed file. A change that is only a version step and its changelog entry runs no test at all. The vouch says what it ran ("affected: 26 of 91 test files").
- Whatever it can't follow runs the whole suite as before: the TypeScript or npm setup, the kit, test fixtures, a file deleted or renamed, a file no code names, or more than 200 files at once. A merge train, a kit catch-up, a version step and a release always run the whole suite.
- It needs no tags or settings in the repository: it reads the imports. It works for repositories whose test script is `node --test "<files>"`, as the manor's are; any other test script runs whole.
- Settings has a switch for it, **Tests only what a change reaches**, on by default.

### Before you update

- Nothing: it updates itself as usual.

## 0.28.15

**Ready pull requests merge together, tested once; and a pull request that needs you first waits for you.**

### What's new

- When two or more of a repository's ready pull requests wait their turn (each raising the version one step), the Steward now stacks them on the branch, lowest version first, settles their version lines and changelog entries as it does when it catches one up, runs the checks once on the whole stack, and merges them together through the top pull request. Before, each one was caught up after the one under it merged and tested again on its own: five ready pull requests meant five test runs, now it is one. Each keeps its own version and changelog entry.
- A pull request labelled **owner-first** is never merged by the Steward, and neither is one that adds or changes a database migration (an `.sql` file, or anything in a `migrations` folder), labelled or not. Do what it needs (run the migration), then merge it yourself, take the label off, or label it **owner-done**. Pull requests above it in the version queue wait for it, as they wait for a draft.

### What changed

- **Merges ready PRs together** is a new switch in Settings, on by default. Off, pull requests merge one at a time as before.
- A pull request that conflicts with the one under it beyond its version lines ends the stack there and goes its own way as before; if the stack's checks fail, the pull requests merge one at a time, and the same stack isn't built again until one of them, or the branch, moves on.
- Pull requests with checks on GitHub, steps to run after merging, the Wright's, and ones that raise the kit still merge on their own.

### Before you update

- Nothing: it updates itself as usual.

## 0.28.14

**A queue of tested pull requests merges much faster: catching one up no longer means testing it again.**

### What changed

- Two pull requests written side by side always meet in their version lines and changelog, so each merge used to make the others conflict. The Steward catches those up by itself, but the push left the pull request untested, and the Steward then ran all its checks again before merging. Now, when the catch-up changed only version lines and changelog entries, a pull request its author vouched for, or that already passed its checks here, keeps that standing and merges in the same round with no new test run. Its comment and line say so: "its checks not run again (only version lines and the changelog changed since abc1234)".
- A catch-up that also settled `kit.json`, or resolved anything else, is tested again as before, since a different kit is different code.

### Before you update

- Nothing: it updates itself as usual.

## 0.28.13

**A pull request someone has vouched for merges in minutes, not at the next round.**

### What changed

- Once `steward vouch` has run a pull request's checks and recorded that they passed, it asks the Steward running on the same PC to start its round straight away, so the pull request merges as soon as its turn has come, rather than up to a round's interval later. If the Steward is busy, the round comes as soon as it finishes. The vouch says what the Steward answered. If the Steward isn't running, doesn't merge by itself, or is off duty, the vouch still counts, and the pull request merges at the next round as before.

### Before you update

- Nothing: it updates itself as usual.

## 0.28.12

**Fewer kit pull requests: a newer kit goes onto the one still open.**

### What changed

- When a new kit comes out while the Steward's pull request for the last one is still open (waiting its turn behind an agent's other pull requests), the Steward now puts the new kit onto that pull request, at the version it already has, instead of waiting for it to merge and opening a second one. Its title, description and changelog entry are rewritten for the new kit, covering every kit since the one the agent's main branch carries. One pull request to merge and one release, where there were two.
- If that pull request merged or closed while the new kit was being checked, nothing is pushed, and the next round brings the kit in a pull request of its own, as before.

### Before you update

- Nothing: it updates itself as usual.

## 0.28.11

**More pull requests caught up without help: lockfiles, and changelogs whose older notes were edited.**

### What changed

- When a pull request falls behind and its `package-lock.json` clashes only in its version lines, the Steward now settles it as it does `package.json`, even where its settings name `package.json` alone. Before, it handed the pull request back for a person to merge.
- When a pull request edited older entries of its changelog (a spelling swept through the notes, say) while the branch added a new entry, the Steward now keeps both: the branch's new entry, and the pull request's wording of the older ones. Only an older entry changed differently on both sides still goes back to its author.
- When the Steward changes a pull request's version, its `package-lock.json` follows too, wherever it said the same version as `package.json`.

### Before you update

- Nothing: it updates itself as usual.

## 0.28.10

**The kit it hands out, 2.43.4, brings its own MIT license.**

### What changed

- The Steward hands out kit 2.43.4: each agent's copy of the kit now comes with the kit's license, and so does every agent's release. The agents' own license files are short and point to it.

## 0.28.9

**The kit it hands out, 2.43.3, keeps the agents from all doing their heavy first work at once.**

### What changed

- The Steward hands out kit 2.43.3. Agents new to the manor do their first rounds one at a time, and their pages say they're settling in. Every agent's scheduled rounds run at low priority, so they give way to whatever you are doing. Manor's Settings will have the switch for it; until then it is on.

## 0.28.8

**The Steward has a row of its own in the staff table, and is never looked after twice.**

### What changed

- On the PC that releases Castellan, the Steward's own repository is a row of the staff table, like every employee's: its checkout, branch, kit, latest release, release PC and open pull requests. Its release PC sits in that row, so the lines that used to appear under the table for it (sometimes twice) are gone.
- Its row isn't one of the stages' tick boxes: its own rounds merge and release it, as before.
- Found on this PC no longer offers the Steward's own repository. If it was looked after from there already, that extra entry is ignored, so its pull requests aren't merged twice. You can remove it from Settings, under Repositories.
- Version claims for the Steward are now let go once their work lands or goes stale, as every other repository's are.

### Before you update

- Nothing: it updates itself as usual. The Steward's row appears the next time the table is refreshed.

## 0.28.7

**Look after several of the repositories found on this PC in one go.**

### What's new

- Under Found on this PC, each repository has a box to pick it, and All picks every one. Look after N then adds all the picked ones at once, each with its own Merge my ready PRs and Release each new version ticks. If some can't be added, the page says which and why, and adds the rest.

## 0.28.6

**See what the Steward does with pull requests that conflict with their branch.**

### What's new

- A new **Merge conflicts** section on the Steward's page, under your repositories. It lists each pull request that conflicted with its branch in the last two weeks, and what the Steward did with it:
  - **caught up**: only version lines, a changelog's new entry or a kit pin conflicted, so it resolved them and pushed a merge commit;
  - **sent back**: something needed judgement, so it left a comment for whoever wrote it (a Claude Code session or a person);
  - **closed**: one of the Wright's, queued for the Wright to do again, or a kit update of its own, to be bumped again;
  - **couldn't**: it tried and something went wrong, with why.
- Each one says which files conflicted and which of them needed a person, when the Steward did it, when it last looked again, and whether the pull request is still open.
- In your repositories' table, a pull request it has dealt with carries the same badge on its line. Hover over it for what was done.

### Before you update

- Nothing: it updates itself as usual. The section fills from the next round on; conflicts handled before this version aren't listed.

## 0.28.5

**A pull request whose author already ran its tests merges without the Steward running them again.**

### What's new

- `steward vouch`: run it in the clone you pushed a pull request from. It runs the repository's checks there, and once they pass it records that on the pull request's commit on GitHub. The Steward then merges that pull request without testing it again, saving a full test run per pull request.
- It trusts the record only from your team's GitHub accounts, only for the exact commit that was tested, and never for the Wright's pull requests or a fork's. Anything pushed afterwards, including the Steward's own catch-ups, is tested by the Steward as before.

### What changed

- A passing commit status no longer counts as one of a pull request's GitHub checks when it is this record, so it can never skip the Steward's testing by itself.

### Before you update

- Nothing: it updates itself as usual. To use it, have whoever opens pull requests run `steward vouch` after pushing.

## 0.28.4

**A change that needs both a new kit and an agent's matching change no longer waits for you.**

### What changed

- When a new kit breaks an agent's tests as its main stands, but that agent has a ready pull request that takes the new kit and passes with it, the kit no longer waits. The kit's pull request merges and the kit is released, and its comment says why ("Manor moves with it in #135 (passes with this kit)"). The agent's pull request is then tested with the released kit and merged. Before, the two waited for each other until you labelled the kit's pull request.
- If that agent's pull request fails with the new kit, or is still a draft, the kit waits as before, and the reason says so.
- An agent's pull request that takes a kit not released yet now says which pull request brings that kit, for example "waits for kit 2.42.0, which Steward#126 brings: it merges once that's released". If no open pull request brings it, it says that instead, because only a person can sort that out.

### Before you update

- Nothing: it updates itself as usual.

## 0.28.3

**The Steward is yours: it looks after your own repositories, and nothing of Castellan's.**

### What's new

- The Steward looks after the repositories you pick (in Manor's Repositories, or from the ones Reeve finds on this PC with **Look after**), and only those: it claims each new version up front so work going on side by side never collides, watches your pull requests and releases, and merges your ready, green pull requests and releases, each only where you say yes.
- Castellan's own repositories (Manor and its agents, its website and its licensing service) are its makers' alone. The Steward doesn't offer them, and refuses to look after one, to claim a version of it, to merge it or to release it, saying why in a sentence. A repository of yours whose name is the same as one of Castellan's agents gets its own id instead (porter-2, say).
- It is a hire for people who write software: with Developer options off in Manor's Settings, it does nothing. Its rounds don't run, its buttons and commands say why, and its page is one plain line.

### What changed

- The work that only Castellan's makers do (handing out the kit, publishing to Castellan's releases, the ports of new agents) is off everywhere else and can't be turned on. Its commands say they are the makers' only, and its page and Settings show none of it.
- The Toller and the Assayer are named among the developer hires, with where their work runs (kit 2.43.2).

### Before you update

- Nothing: it updates itself as usual. Your repositories it already looks after stay as they are; one of Castellan's that you had added stays where you added it, unused.
- Turn on Developer options in Manor's Settings if it's off, or the Steward waits.

## 0.28.2

**The Steward releases itself again, and stops reinstalling agents it has already installed.**

### What changed

- When the Steward's own repository was also one of the repositories it looks after, its rounds stopped releasing its new versions and stopped merging its team's pull requests through its own path, without a word in the log. They do both again.
- An agent released only on this PC (its release installs it here rather than publishing it) counts the version it has installed as released. Before, the round rebuilt and reinstalled it every time, restarting its page, because it looked only on GitHub for that version.

### Before you update

- Nothing: it updates itself as usual. A Steward that has stopped releasing itself needs this version released once by hand; after that it carries on by itself.

## 0.27.40

**A tidier staff table: open pull requests sit under their repository, and Notes shows only when there's something in it.**

### What changed

- A repository's open pull requests are no longer a column of their own. They are a small table on a line under its row, below the Employee, Checkout and Branch columns: each one's number, title and branch, its checks and whether it can merge.
- The Notes column shows only when some repository has a note, such as a fetch that failed or a missing kit.json. When none do, the room goes to the other columns.
- "Keep it on this PC" and "Do it here" stay on one line instead of wrapping in a narrow Release PC column.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.39

**Your repositories in one list, in Manor: the Steward looks after the ones there.**

### What changed

- On your PC (unless it releases Castellan), the repositories the Steward looks after are the ones in Manor's Settings, under Repositories: the one list every agent reads. Each says whether the Steward merges its ready pull requests and how it is released. Manor 0.16.24 brings in the repositories you gave the Steward before, with your choices as they were, once.
- **Look after** on the Steward's page now adds a repository to Manor's Repositories; you change or remove it there.
- Without Manor, or with a Manor older than 0.16.24, the Steward keeps the repositories it had, as before.
- It hands out kit 2.42.0, which describes the one list.

### Before you update

- Update Manor to 0.16.24 first, so your repositories are in its list before the Steward reads it. If you update the Steward first, nothing changes until Manor is updated.

## 0.27.38

**A new kit is merged and released first in a round, so the agents' pull requests that need it aren't held up.**

### What changed

- In a round, the Steward's own pull requests are now merged before the agents', and one that raises the kit goes first of all, ahead of the version line. The new kit is released right after, before any agent's pull request is tested. An agent's pull request made for that kit is then tested with it in the same round, instead of failing because the kit isn't out yet.
- After a new kit is released, the round looks at every agent's pull requests again, including ones it would otherwise skip because nothing changed on GitHub.
- A pull request whose checks failed here while filling its kit is tested again once a newer kit is released. Before, it waited for ever, and so did every pull request queued behind it.
- A pull request that takes a kit with no release yet now says so ("waits for the kit it takes: kit 2.42.0 isn't released yet") and isn't tested until the kit is out, instead of failing its checks.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.31

**A round keeps merging a repository's pull requests until its queue runs out.**

### What changed

- When several pull requests wait in line on one repository, a round used to merge at most five of them and leave the rest for later rounds. It now keeps going until none is left that it can merge: each one merges, the next is caught up with the branch, tested and merged, and so on down the line. A round with a long line takes longer, but the line is cleared in one go.
- After a merge, a pull request that was stacked on the merged one, or that GitHub was still working out, is looked at again in the same round instead of the next.
- A pull request that fails its checks here doesn't keep the round going round in circles: once two looks in a row merge nothing, the round moves on.
- A pull request with checks on GitHub still merges once those pass, at a round that comes sooner.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.29

**Pull requests that pile up on one repository merge in one round, and the next round comes sooner when one is nearly ready.**

### What changed

- Several pull requests to one repository, each raising its version, used to merge one per round: once the lowest merged, the next was caught up with the branch and waited a whole round before merging. Where GitHub runs no checks on them, the Steward now tests the caught-up pull request at its new head and merges it in the same round, and does the same for the next one, up to five in a round.
- A round that leaves a pull request waiting only on something that settles itself in a few minutes (its checks still running, a head just caught up, or GitHub still working out whether it merges) now has the next round come 2 minutes later instead of 10. This happens at most three times in a row.
- Each merge now names the exact commit the Steward looked at and tested, so a pull request pushed to in the meantime waits instead of merging untested.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.26

**A pull request waits less for GitHub to work out whether it merges.**

### What changed

- When GitHub hadn't yet worked out whether a ready pull request merges ("GitHub is still working out whether it merges"), the Steward left it for the next round, ten minutes or more later. It now asks GitHub again a few times over about 25 seconds and, once GitHub has said, merges it in the same round. This is often the case for a pull request just caught up with its branch, or just pointed at the main branch after the one it was stacked on merged.
- A pull request whose checks are failing or still running, or that is a draft, isn't asked about again: it would wait anyway.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.19

**A pull request built on another one no longer gets stuck once that one has merged.**

### What changed

- When a pull request is built on another one's branch (stacked), it waits for that one, and the day's report now says so: "stacked on #N". Once #N has merged, the Steward points the stacked pull request at the main branch itself, leaves a comment on it saying so, and merges it in its turn like any other. Before, it waited for ever: the Steward keeps your branch after merging your pull request, so GitHub never moved what was stacked on it.
- This happens only in repositories whose pull requests you've let the Steward merge, and never to a pull request from someone outside your team.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.18

**The kit it hands out, 2.41.0, can set up and keep a reranker, for Reeve's search.**

### What changed

- The Steward hands out kit 2.41.0: the accelerators can serve a reranker, a small model that judges how well a passage answers a question. Reeve's search uses one to put the right file first more often. It is set up only when asked for, beside what a graphics card or the processor already serves, and the keeper keeps it running as it does the other model servers.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.17

**A draft near the front of the merge line gets a heads-up, so it can be ready before it holds anyone up.**

### What's new

- After each round, the Steward looks for drafts near the front of a repository's line (within the first three) or already holding back pull requests that are ready. It leaves one comment on each, saying where it stands and what waits on it, and a second only if it then starts holding ready pull requests back.
- When the draft is one of the Wright's, the Bailiff is woken to review it now instead of at its next round. The Steward's version queues list these drafts first for the Bailiff, which reviews them ahead of the rest once it is updated too.
- Other drafts are their author's: the comment asks to mark it ready when done, or close it, in which case its version is skipped and the next in line goes on.
- This happens only in repositories whose pull requests you've let the Steward merge.

### Before you update

- Nothing: it updates itself as usual. The Bailiff reviews the coming drafts first once it is updated as well; until then it is still woken for them.

## 0.27.16

**Draft pull requests hold their place in the merge order.**

### What changed

- A draft that raises the version now keeps its place in line. Ready pull requests with a higher version wait until it merges, so it never ends up below main's version and needs renumbering. Before, drafts were passed over.
- If a draft is closed instead, its version is simply skipped. The next pull request in line merges at its own version, and nothing is renumbered.
- The version queues Manor shows now include drafts, marked as waiting.

### Before you update

- Nothing: it updates itself as usual. A draft that raises the version now holds back the pull requests above it until it merges or is closed.

## 0.27.15

**The Steward tells Manor where each repository's version stands, and which versions are lined up to merge next.**

### What's new

- After each round, the Steward notes the version on each repository's main branch and the versions its open pull requests bring, lowest first: the order it merges them in. It notes the version it is working on next (the lowest in line) and the latest one that is ready to merge, and updates both as each pull request merges. Manor shows them.
- This covers Manor's non-employee projects too, not just the agents. The Steward only reads them: it still never merges, releases or changes one. A project that names no version files has its version read from its package.json or VERSION file when it has one.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.14

**Pull requests merge in version order, and a new kit held back by one agent goes ahead on its own once that agent is fixed.**

### What changed

- When several pull requests to the same repository each raise its version, the Steward now merges them lowest version first, whichever was opened first. Each one above waits its turn, and the hold says which one it is waiting for. Once the one below has merged, the Steward catches it up: it settles the version lines and changelog itself, and the PR merges at the next round. Pull requests that don't change the version merge first, as before. Drafts are never in the queue.
- Before releasing a new kit, the Steward tries it on every agent. Until now, if one agent failed, the kit stayed held until the kit itself changed, even after that agent had been fixed. Now the Steward checks each round whether a failing agent has changed since its trial. If it has, the Steward tries that agent again with the same kit, and only that agent. Once every agent passes, the kit is released as usual, with a note on its pull request saying so.
- A kit held from before this update is tried again on its failing agents once, at the next round.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.13

**Kit roll-outs no longer clash with your own open work, and a release isn't held by an Aletaster that has Developer options off.**

### What's new

- It hands out kit 2.40.0. With Developer options off, every agent's settings leave out what's for developers and keep it as it was when you save. A developer role's agent (the Auditor, the Developer Herald, the Aletaster, the Pinder, the Steward) has no "Where its work runs" then, and can leave its settings form out altogether. The plain "Where its work runs" talks about the AI chip, not the NPU or its maker's name.

### What changed

- A new kit is no longer rolled out to an agent whose own open pull request already brings that kit. Before, the Steward opened a kit-only pull request beside it at the same version, which then had to be closed or caused a conflict.
- A kit bump claims its version, as other work does. It never takes the version of a pull request that's open or of work that has claimed one. If GitHub can't be reached to claim it, the bump waits for the next round.
- Without Manor, an Aletaster with its own Developer options off tastes nothing. Releases now go without a tasting then, as they do when the Aletaster's role is vacant, and say so, instead of waiting for good.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.12

**Each repository's release PC is shown in the staff table now, so it no longer needs a section of its own.**

### What changed

- The Release PC section is gone. Each repository's row in the Staff (or Your repositories) table has a Release PC column. It says which PC merges and releases the repository and whether it's kept there, and it holds the Do it here, Keep it on this PC and Unpin buttons.
- Claims another PC made too, and turns for repositories still being looked at, are listed under the table.

### Before you update

Nothing: it updates itself as usual.

## 0.27.11

**It hands out kit 2.39.0, which hands every agent Manor's Developer options switch.**

### What's new

- Every agent can now follow the Developer options switch on Manor's Settings page. If you don't develop software, Castellan's pages leave the technical detail out. Turning the switch on or off applies to every agent within seconds, with nothing restarted.

### What changed

- When Developer options are off, each agent's **Where its work runs** says "the local AI" and describes its work in plain words, without the names of tools or model servers. The agent's page doesn't show where its files are kept. Its settings don't show the settings file's path or that file's own error messages.
- Turn Developer options on to see all of it, as before.

### Before you update

- Nothing: it updates itself as usual. If you want the technical detail on your agents' pages, turn on Developer options on Manor's Settings page.

## 0.27.10

**It hands out kit 2.38.0: Reeve, the Chamberlain and Heiward get their own title-bar scenes, and so do the Thatcher, the Reckoner, the Weigher and the Shepherd.**

### What's new

- Three more agents have their own picture in the title bar, moving while they work, in the colours of their icons: Reeve reads a log scrolling past an amber line and keeps count in tally marks; the Chamberlain seals a letter in red wax and files it in its pigeonhole; Heiward's shears trim the sprigs growing out of a hedge.
- This release brings 0.27.8 too, which was never released on its own: the Thatcher's, the Reckoner's, the Weigher's and the Shepherd's scenes.

### Before you update

Nothing: it updates itself as usual. Each agent takes the new kit as the Steward rolls it out.

## 0.27.9

**The kit it hands out publishes nothing of Castellan's on GitHub but Heiward.**

### What changed

- This brings kit 2.37.0. Every agent's release now goes to Castellan's release service and to its own repository, never to the public releases repository. Agents held back from sale are included. Heiward is the exception and is still published on GitHub. A release the release service doesn't take now fails, with a line saying how to finish it, instead of going to GitHub.
- Manor can now be published to the release service.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.8

**It hands out kit 2.36.2: the Thatcher, the Reckoner, the Weigher and the Shepherd get their own title-bar scenes.**

### What's new

- Each of the four newest agents has its own picture in its title bar, moving while it works, in its own colour: a roof thatched course by course, counters slid across a counting board, a balance that tips and settles, and a sheep walked into its fold. Until now they showed the turning cogs of an agent without one. Their Settings' **Where its work runs** now says what each round does too.

### Before you update

Nothing: it updates itself as usual. Each agent takes the new kit as the Steward rolls it out.

## 0.27.7

**An agent's release notes for a new kit never name a repository, and a kit is tried with the notes its rollout will write.**

### What changed

- When the Steward rolls out a kit whose changelog it couldn't read, each agent's release notes now say "the parts every agent of the manor shares". Before, they named the repository the kit came from, and those notes are published with each release.
- When a kit change is tried on every agent before it merges, each agent's notes are now written from that kit's own changelog, as its real rollout will write them. An agent whose tests check its notes no longer fails the trial over a line it would never ship.

### Before you update

- Nothing: it updates itself as usual.

## 0.27.5

**An employee's kit parts are read from its own kit.json, the one place they are kept.**

### What changed

- The Steward no longer keeps its own copy of each repository's kit parts. That copy didn't know the React part, so every agent with a React page carried a note on the Steward's page, "kit.json takes node, web, spec, react; Settings say node, web, spec", though nothing was wrong: an agent's kit has always been filled from its kit.json.
- The page now shows each repository's parts as its kit.json says them, React included, and the note is gone.
- Settings no longer has a Kit parts field for a repository. To change an agent's parts, change its kit.json.
- Taking on a repository (Look after, or `employ`) lists the parts its kit.json takes.
- Taking on an agent whose src/app.ts writes its id and name in double quotes (or backticks) now takes its name as written: the Crier was taken on as "crier".

### Before you update

- Nothing: it updates itself as usual. The old parts in settings.json are left there and no longer read.

## 0.27.2

**It installs one of your own agents the first time, when Manor's Hire asks.**

### What's new

- An agent that is yours alone (built here from its clone, never published) can now be hired the first time: Manor's Hire asks the Steward, which builds the version on its branch and installs it. Before, a release only kept such an agent up to date once it was installed, and the first install was a command run by hand in its clone.
- In a terminal: `node src\cli.ts release --employees <id> --hire`.

### What changed

- A hire installs only an agent built here that isn't installed yet. One that is fired stays gone until it is hired again.

### Before you update

- Nothing: it updates itself as usual. Manor shows Hire for your own agents once it is updated too.

## 0.27.0

**Your PCs agree among themselves which one merges and releases each repository, through the repository itself: no licence or Castellan service needed.**

### What's new

- Each repository gets one release PC, chosen by your PCs through a small marker in the repository's own remote. It works with any Git host, and for anyone, with or without a licence.
- The Steward's page shows who has each repository ("Merging and releasing for Clerk: done by DESKTOP-ABC"), with **Do it here** to move it now, and **Keep it on this PC** to keep it there. A kept PC that goes quiet for a day can be taken over, and the page says so.
- Version claims are shared through the repository too, so work started side by side on two PCs never takes the same version. Offline, a claim is made on the PC as before, and shared once it can reach the remote. If another PC took the same version meanwhile, the page says so and the later work gets a new version when it merges.

### What changed

- Only publishing waits for a PC's turn: merging, releasing, and the pushes of a refresh, a kit update or a catch-up. Builds, tests, tastings, bumps and claims never wait, online or offline.
- When this PC can't reach a repository's remote, the page says releasing waits until it can. Nothing else stops.
- Taking turns no longer goes through Castellan's release service. The turns from 0.24.0 are gone.

### Before you update

- Nothing: it updates itself as usual. On its first round each PC marks the repositories it looks after. With only one PC, everything works exactly as before.
- Update the Steward on every PC: an older one doesn't take turns, and the alarm for another Steward names it.

## 0.26.0

**GitHub is no longer required: the Steward finds the source control on your PC and sets itself up for each repository.**

### What's new

- The Steward looks at what is installed on your PC (Git, the GitHub CLI, and others such as Mercurial or Subversion) and chooses by itself how to work with each repository. A new Settings choice, **Source control**, shows what it found and offers only what you have, usually one option. Automatic is the default.
- **Repositories on any host.** GitLab, Azure DevOps, Bitbucket, your own server or a shared folder: anything you reach with plain git. The Steward reads each repository's branch and tags from its origin. When the branch carries a version that isn't released yet, it runs your release command (or none, with Release it set to tag) and pushes a `v<version>` tag to the repository, with that version's changelog entry as the tag's message. There are no pull requests to merge that way: what lands on the branch is released.
- **Look after** now offers your clones on any host, not only the ones on GitHub.
- Repositories on GitHub work exactly as before wherever the GitHub CLI is installed and signed in. Without it, they're worked with plain git too.

### What changed

- A repository's name in Settings can be a host and path, such as `gitlab.com/group/app`, as well as GitHub's `owner/name`.
- Mercurial, Subversion, Perforce and Plastic SCM are found and named, but the Steward doesn't work with them yet.

### Before you update

- Nothing: it updates itself as usual. A PC where the GitHub CLI is installed and signed in keeps working with GitHub as before.

## 0.25.2

**It hands out ports for new agents, as it hands out versions, and says when two agents share one.**

### What's new

- `claim-port <agent id>` gives a new agent its page's port before anyone writes one: the next free one after every port Manor's staff, this PC's own staff, the agents announced on GitHub, each repository's src/app.ts and every earlier claim use, with its development port (+10000) free too. A new agent needs no repository yet. Asking again for the same agent gives the same port; an agent that has one keeps it. `release-port` gives one back.
- `ports` lists every port in use, by whom and where each says so.
- When two agents have the same port, a round raises an alarm naming both, before either is installed. Manor offers only one of two such agents for hire, so the other's role used to sit empty with no word why: the Assayer and the Shepherd both had 20707.

## 0.25.1

**A Castellan release service that can't be reached never stops a Steward that works alone.**

### What changed

- On a PC with a Castellan licence, the Steward 0.24.0 stopped merging and releasing whenever it couldn't reach Castellan's release service, even though it had never taken turns with another PC. Now it goes on exactly as before. Only a PC that was already taking turns waits for the service, so it never merges beside another of your PCs.
- An answer from the service that says nothing about turns counts as no turns, the same as before.

### Before you update

- Nothing: it updates itself as usual.

## 0.24.1

**Work merged out of order no longer gets stuck on its version: the Steward renumbers the kit too, and keeps the version claims in step.**

### What's new

- **The kit's version can be claimed**, as every repository's can: `claim-version kit --branch <b> --for "<what>"`, and `release-version kit <version>`. It counts above kit/VERSION, every kit release, every kit version an open pull request names, and every live claim, apart from the Steward's own version.

### What changed

- When another change with a higher version merges first, catching a pull request up now settles the kit as well as the Steward's version: kit/VERSION, the kit's changelog (its entry above the one that merged first, under its new number), the Steward's pin of its own kit, the kit number its own changelog entry names, and its title. Before, a conflict there waited for a person.
- A pull request caught up to a new version takes its branch's claim with it: the old version is free again, the new one is held, and the work's author asking again is handed the new one.

### Before you update

- Nothing: it updates itself as usual.

## 0.24.0

**Your PCs on one Castellan licence take turns: each repository is merged and released by one Steward, and versions are claimed once for all of them.**

### What's new

- On a PC with a Castellan licence, the Steward takes its turn at each repository before it merges or releases there, through the Exchequer. A repository another of your PCs is looking after is left alone, so two Stewards never merge and release the same pull requests.
- The page says which repositories another PC looks after ("Merging and releasing for Clerk: done by DESKTOP-ABC"), with a **Do it here** button that moves it to this PC at once.
- A repository cloned on only one PC is always looked after there.
- `claim-version` hands out versions for all your PCs at once, so work started on the desktop and the laptop side by side never takes the same version.

### What changed

- When the Exchequer can't be reached, the Steward keeps looking after the repositories it already had, until its turn runs out, and takes on no others: a round may be slower, but nothing is merged twice.
- The alarm for another Steward (0.23.2) doesn't count what a PC does in a repository whose turn it has: only a Steward that doesn't take turns raises it.

### Before you update

- Nothing: it updates itself as usual. Without a licence on the PC, or until the Exchequer takes turns (its 0.7.0), everything works exactly as before.
- For the turns to work, update the Steward on every PC: an older one doesn't take turns.

## 0.23.5

**An old Steward on a second PC updates quietly: it no longer takes itself for the PC that releases Castellan.**

### What changed

- A Steward from before 0.19 that updates on a PC without the Exchequer's publisher key now comes up with Castellan's work off: no kit rollout, no releases of its own, nothing merged or released by itself. It waits for your yes in its Settings. Before, any Steward that had run before was taken as Castellan's release machine. On a second PC that made it a second Steward, merging and releasing the same repositories as the first.
- The PC that holds the key updates exactly as before.

### Before you update

- Nothing: it updates itself as usual. A Steward already on 0.19 or later keeps its Settings as they are.

## 0.23.2

**It raises an alarm when another Steward, or someone else, merges its PRs or releases its agents.**

### What's new

- On the PC that releases Castellan, the Steward now notices when one of its own PRs is merged, or one of its agents is released, and no round of its own did it. Most likely another PC runs a Steward signed in to the same GitHub account. One alarm names the agents, the PRs and the releases, in the Steward's page and in Manor, and clears by itself a day after the last one.
- Did it yourself, by hand? Dismiss the alarm: what it names is taken as yours, and only a new one raises it again. Or mark it as yours, before or after: `node src\cli.ts mine porter v0.5.14` (or `#65` for a PR).
- It is seen from what each round already reads from GitHub, plus git in the agent's checkout here. Nothing more is asked of GitHub.

### Before you update

- Nothing: it updates itself as usual. The first round after the update only learns which releases and PRs are already there, so the update itself raises nothing. On every other PC nothing changes.

## 0.21.3

**It hands out the kit 2.36.1: GenieX 0.8.0 is the NPU's server on a Snapdragon.**

### What changed

- A Snapdragon PC whose NPU is set up from now on gets GenieX 0.8.0 instead of 0.7.0. It has been run on a Snapdragon X2 Elite: it installs the same way, answers chat and pictures, and uses the same model files.
- A PC already running 0.7.0 keeps it. The Smith offers 0.8.0 to try under New for your NPU, and puts 0.7.0 back if you remove it.
- Each agent gets this with its next kit update, through the Steward as usual.

### Before you update

- Nothing: it updates itself as usual.

## 0.21.2

**It hands out the kit 2.36.0: a staff release is published only on the PC that holds the Exchequer's key, so none skips the Exchequer.**

### What changed

- A release of one of Castellan's staff now publishes nothing on a PC without the Exchequer's publisher key. That means no GitHub release, public or private. Before, such a release went to GitHub alone, and paying customers never got it from the Exchequer.
- With the key, as on the PC that releases Castellan, releases go out exactly as before.
- Manor and Heiward, which are never sold, are released as before.
- Each agent gets this with its next kit update, through the Steward as usual.

### Before you update

- Nothing: it updates itself as usual.

## 0.21.0

**It hands out the kit 2.35.0: a release of an agent Castellan sells goes to the Exchequer, not the public releases repository.**

### What changed

- The release of an agent that Castellan sells is published to the Exchequer, Castellan's release service, and no longer to the public releases repository. The Steward still sees it released, by the agent's own repository.
- The agents not for sale go to the releases repository as before, and to the Exchequer too. That's Manor, Heiward, and the agents held back from sale.
- If the Exchequer can't say which agents it sells, or doesn't take a release, the release goes to the releases repository as before. A release is never held back, and nothing becomes an alarm.
- Each agent gets this with its next kit update, through the Steward as usual.

### Before you update

- Nothing: it updates itself as usual. Agents for sale stop appearing in the public releases repository once the Exchequer says which ones are for sale (its 0.6.0).

## 0.20.1

**A refresh after releases cleans up after itself, however deep its packages go.**

### What changed

- A refresh's working copy is removed whatever the length of the paths in it. A site's packages go deeper than git on Windows deletes, so its copy could be left behind, and the next refresh would then have failed to start.
- One left behind by a refresh cut short (the PC turned off mid-run) is cleared before the next refresh.

### Before you update

- Nothing: it updates itself as usual.

## 0.20.0

**A repository can be refreshed after every release: a site that lists your release notes and downloads stays up to date by itself.**

### What's new

- **Refresh after releases**, a new setting for each repository in Settings, under Repositories. Name a command (a site's `npm run sync`, say), and after the Steward releases anything, it runs that command in a fresh copy of the repository's branch. When the command changed something, the repository's tests run, and only when they all pass is the change committed ("Release notes and downloads after …") and pushed to the branch, never forced. When nothing changed, nothing is pushed. A round that released nothing runs no refresh.
- A refresh that fails, or whose tests fail, pushes nothing and is an alarm on the Steward's page and in Castellan, until a later refresh goes through.
- **Note**, a new setting for each repository: a word shown first on its row of the Steward's page, such as why its pull requests are left to you.

### What changed

- A version kept in a TypeScript constant (`export const VERSION = '1.2.3'`) is read and claimed like one in `version: '1.2.3'`, and Look after finds it.
- A Next.js project's tests get their own packages in the Steward's worktree, as its build refuses packages linked from elsewhere. Other projects still share theirs.
- Settings save when a repository has no kit to fill, as one you looked after from the list of repositories found on this PC. Before, its empty "Fill its kit" stopped the save.

### Before you update

- Nothing: it updates itself as usual. Nothing is refreshed until you name a command for a repository.

## 0.19.5

**It hands out the kit 2.34.0: an agent's rounds never stop silently.**

### What changed

- An agent waiting for a setting only you can give now says so in its round record each time a round comes due. Before, it went quiet, and looked to the Surveyor like an agent whose rounds had stopped.
- A round that hangs, waiting on something that never answers, is let go after its time limit (three intervals, and at least two hours), recorded as failed, and tried again at the next round. Before, one hung round stopped every round after it until the agent was restarted.
- Each agent gets this with its next kit update, through the Steward as usual.

### Before you update

- Nothing: it updates itself as usual.

## 0.19.3

**When GitHub has a bad hour, the Steward waits it out by itself: no alarm, no Push to press.**

### What changed

- A push, pull request or release that GitHub answers with its own error ("Internal Server Error", a 502, 503 or 504, a connection it drops) counts like the network being down: the Steward tries it again on its next round, and raises no alarm. Before, each one was set aside until you pressed Push, with an alarm per agent.
- Any agent still set aside for that reason is let go on the first round after this update, and pushed then.

### Before you update

- Nothing: it updates itself as usual.

## 0.19.1

**It hands out kit 2.32.1: the agents name Castellan, the app you bought.**

### What changed

- Kit 2.32.1: an agent with no local AI set up says "open Castellan and choose Set up local AI" (it said Manor), and the agents' other words that send you to the app name Castellan too.
- The Steward's card in Castellan shows again: its one-line role is shorter ("Looks after your repositories: claims versions, merges your ready pull requests and releases, where you say yes"), within the 120 characters a card takes.

### Before you update

- Nothing: it updates itself as usual.

## 0.19.0

**The Steward looks after your own repositories: the ones Reeve finds, as you say.**

### What's new

- **Found on this PC.** Its page lists your repositories that Reeve finds here, on GitHub, that you can push to. **Look after** adds one to Settings (now called **Repositories**) with how to test it and the files that carry its version, read from your clone.
- **Nothing happens without your yes.** For each repository you choose whether it merges your ready, green pull requests (**Merges your ready PRs**) and whether it releases new versions (**Release it**): with the repository's own `npm run release`, or as a GitHub release of the branch it makes itself, its notes your CHANGELOG.md entry. Both are off until you tick them, and so is **Merges and releases by itself**: until you switch that on, nothing is merged or released but by a button.
- **Versions claimed for any repository.** `claim-version` takes any repository: one you look after, one Reeve found here, or the clone you run it in.
- **Merge your ready PRs** and **Release** buttons for your repositories, and a page and Settings that speak of them only.

### What changed

- Every release goes to the repository's own GitHub repository (kit 2.32.0: the releases repository is a setting now, never built in).
- Kit 2.32.0: an agent's **Back to …** link, and its tour's, says your manor's name as before, and **Back to Castellan** when it has none (it said Back to Manor).
- The kit, its rollout and the Steward's own releases happen only on the PC that releases Castellan itself (**Releases Castellan itself**, in Settings' advanced part), with their settings shown only there.
- The Wright's and the Bailiff's settings show, and their work runs, only where the Wright is installed. A pull request labelled `wright` is anyone's where it isn't.
- No alarm that the Surveyor's page doesn't answer where the Surveyor isn't installed.
- Keeping the staff's pages up and the manor-wide alarms are to move to Manor: once Manor says it does them, the Steward leaves them to it.
- gh is found on PATH only; without it, you're told to install it and run `gh auth login`. A .NET SDK is taken from Settings (**.NET SDK**), DOTNET_ROOT or Program Files.
- `allow-update` takes a version again (its check was broken).
- The code that converted the first agents to the kit is out of the release.

### Before you update

- Nothing: it updates itself as usual. A Steward that was already looking after repositories keeps doing all it did: on its first start it writes into its Settings what it used to assume (that this PC releases Castellan itself, where its releases go, that it merges and releases by itself, and that each repository's ready PRs are merged).

## 0.18.0

**It hands out kit 2.31.0: local AI on every Copilot+ NPU (Qualcomm, Intel, AMD), installed by setup.**

### What's new

- Kit 2.31.0: setup finds the NPU whatever its maker, installs that maker's model server and models (checked against pinned checksums, for your user, without an administrator), and uses it only once it has answered a test question. Snapdragon gets GenieX, Intel Core Ultra gets OpenVINO Model Server, and AMD Ryzen AI 300 and later get FastFlowLM. An NPU the manor can't use (AMD's Ryzen 7040 and 8040, or an old driver) is named, with the reason, and the graphics card or the processor does its work.
- The model setup now lives in a folder Manor owns, so the household agents work without Reeve.

### What changed

- Kit 2.31.0: the model keeper stops a leftover model server only when the manor started it or it is in the manor's own folders, never because of the port it uses. Your own GenieX or another program's server is left alone.
- The "isn't set up" message now sends you to Manor's Set up local AI instead of Reeve.

### Before you update

- Your model setup is copied from Reeve's settings to Manor's folder the first time it is read after the update, word for word; Reeve's file is left as it was. Nothing to do.

## 0.17.1

**It hands out kit 2.30.0: each staff release is published to the Exchequer, Castellan's release service, as well as to GitHub.**

### What's new

- Kit 2.30.0: when an agent is released, the same files that go to GitHub also go to the Exchequer (https://api.castellan-software.com), where the PCs that subscribe will download the staff from. Only the agents it sells are published there (never Manor or Heiward), and only from a PC with the publisher's key. GitHub's releases stay where every Manor looks for now.
- `npm run release -- --exchequer` in an agent's checkout publishes a release that is already on GitHub to the Exchequer, from GitHub's own files.

### What changed

- A release that reached GitHub but not the Exchequer (no publisher key on this PC, or the Exchequer down or refusing) is still released: the Steward's page shows it as done, with the reason as a note ("Not published to the Exchequer: …"). It is never a failure or an alarm, and never mistaken for the network failing a release.

### Before you update

- Nothing: it updates itself as usual. Each agent takes the new kit as the Steward rolls it out. To publish to the Exchequer, the PC that releases needs the publisher's key in `%USERPROFILE%\.steward\exchequer-publisher.key` (or `EXCHEQUER_PUBLISHER_KEY`); without it, releases go to GitHub alone, as before.

## 0.17.0

**A new agent is taken on with one command: `employ`.**

### What's new

- **`employ <its clone>`** adds a new agent to the Steward's employees, so its page lists it and its rounds test, merge and release it, with no hand-editing of settings.json. Everything comes from the clone: its id and name (from manor-agent.json, or src/app.ts), its GitHub repository, its kit parts, and how to fill, test, version and release it. `--dry-run` shows what it would add.
- An agent that announces itself to Manor is published, so every Manor offers Hire for it. Manor's internal staff, and an agent that doesn't announce itself yet, are built and installed on this PC only.
- An agent the Steward looks after already, or a folder that isn't a clone with a GitHub origin, is refused, with why.

### Before you update

Nothing: it updates itself as usual.

## 0.16.1

**It hands out kit 2.29.0: every agent's page fits a phone.**

### What changed

- On a phone, an agent's title bar no longer runs off the side: its action button (Run now, Check the fingerprints now) moves under the status instead. A wide table scrolls by itself instead of dragging the whole page sideways. This covers the Steward's own page too.
- **Last stage** lists what the stage did (merged, released, refused, failed) first, and folds the employees it skipped, with nothing to do, under their count. After a round, most of the 60-odd lines were "skipped".

### Before you update

Nothing: it updates itself as usual. Each agent takes the new kit as the Steward rolls it out.

## 0.14.1

**It names no folders of one particular PC.**

### What changed

- Its entry for Manor (manor-agent.json) no longer names a Node in a folder only one PC has: it runs on Manor's own Node, or one installed in the usual place.

### Before you update

Nothing: it updates itself as usual.

## 0.12.6

**A security fix: it hands out kit 2.28.1, where a value with curly quotes can no longer break out of a PowerShell string.**

### What changed

- Kit 2.28.1: Windows PowerShell treats the curly quotes ‘ ’ ‚ ‛ as quote marks, and the kit's quoting only escaped the plain one, so a file or folder name with curly quotes in it, handed to PowerShell by an agent, could be read as a command. Every quote mark is escaped now, and each agent is fixed as it takes the new kit.

### Before you update

Nothing: it updates itself as usual. Each agent takes the new kit as the Steward rolls it out.

## 0.12.3

**It hands out kit 2.28.0: an agent that needs a setting from you waits for it, and its tour asks for it.**

### What's new

- Kit 2.28.0: each agent can name the settings it can't work without (the Chamberlain needs a mail account). Until you fill them in, its rounds wait, its page says **Waiting for its settings** with a **Fill them in** button, its status says **Needs settings**, and the first-hire tour won't move past its settings step until they're saved.

### Before you update

Nothing: it updates itself as usual. Each agent takes the new kit as the Steward rolls it out.

## 0.12.2

**A tour of the Steward's page when you hire it.**

### What's new

- When you hire the Steward from Manor, **Take the tour** walks you through it in three steps: what it does, the three settings only you can choose (whose pull requests it merges, whether it merges and releases by itself, and whether it reopens an agent's page that stopped answering), and its page, part by part. You can take it again any time from its page at `#/tour`.

### Before you update

Nothing: it updates itself as usual.

## 0.12.1

**Kit 2.27.0: an accelerator's name is what your PC calls it, never a setting** (kit/CHANGELOG.md).

### What changed

- Every agent names the NPU, each graphics card and the processor from what Windows calls them, as Manor shows them: by the model alone, without (R), (TM) or a last "NPU", "CPU" or "GPU": "Qualcomm Hexagon", "Qualcomm Oryon", "Qualcomm Adreno X2-90". A name written in Reeve's config.json is no longer used, and is taken out the next time the file is saved.
- Nothing else on the Steward's own page: it hands the new kit to every agent.

### Before you update

- Nothing: it updates itself as usual.

## 0.12.0

**The Steward now keeps the rest of the staff up and answering, with or without repositories to look after.**

### What's new

- **The staff's pages are kept up.** No one did this before. In every round, whether or not the Steward has repositories to look after, an agent that is on duty but whose page has stopped answering (it crashed, or an update left it down, so its rounds aren't running) has its page opened again through Manor, as Manor's own Open button would. It gets three tries, five minutes apart, then one an hour. If it still doesn't come back, or Manor can't open it, an alarm says so until it answers. An agent you stopped stays stopped: the Steward never changes anyone's duty, and leaves alone the agents Manor keeps off duty for Developer options.
- The page has a new section, **The staff's pages**, listing any agent that's down and the ones lately opened again.
- A new setting, **Keeps the staff's pages up**, is on by default. It needs only Manor's page (Settings, Alarms).

### What changed

- **No repositories, no GitHub.** On a PC where none of the Steward's employees has a clone, and it has no checkout of its own, a round no longer asks GitHub anything. Before, it sent an empty query every round and logged that it had no team. Now keeping the staff's pages up and raising the alarms is the whole round. The page says that's what it is doing and leaves out the kit's stage buttons until you add an employee. Its kit card reads **The kit the Steward manages**, since there's no one to hand the kit to: the Steward keeps it only to run on.
- With **Merges and releases by itself** off, rounds still come on duty to keep the staff's pages up, but they do nothing on GitHub. **Run now** still does a whole round.
- If there are no repositories and **Keeps the staff's pages up** is off, the page says the Steward has nothing to do, and what to add.

### Before you update

- Nothing: it updates itself as usual. Agents on duty whose pages are down are opened again within a round of updating. If you'd rather keep an agent's page down, stop it in Manor (off duty), or switch off **Keeps the staff's pages up** in the Steward's Settings.

## 0.11.13

**A release that "failed" but is out anyway stops being reported as failed.**

### What changed

- When releasing an agent failed in a round, the Steward stopped trying that commit and raised an alarm until someone released it. If the version was in fact published (a retry, or another run that got there first: on 2026-10-06 Reeve 0.6.5 was published, then the round's own attempt found it there and failed), the alarm and the hold stayed, because only a release made by the round cleared them. Now a round that finds the version already released clears its failure too.

### Before you update

- Nothing: it updates itself as usual. Reeve's "release failed at f2e18a8" clears at the first round after the update.

## 0.11.12

**One alarm while the Bailiff can't review, not one more for each Wright PR waiting on it.**

### What changed

- While the Bailiff's page doesn't answer, or the Bailiff can't use Claude Code, the Wright's drafts that wait only for its review used to each raise their own "has waited 24 hours" alarm on top of the Bailiff's. Now the Bailiff's alarm lists them ("The Wright's drafts waiting on it: …") and they raise nothing of their own. A draft held for another reason (the Steward's own look, or the Bailiff asking for changes) still has its own alarm. Once the Bailiff reviews again, everything is as before.

### Before you update

- Nothing: it updates itself as usual.

## 0.11.11

**Without the Wright and the Bailiff, the manor keeps itself running but takes on no new work.**

### What changed

- **New work needs both.** The Wright's pull requests are marked ready and merged only after the Bailiff approves them. Before, with no Bailiff on this PC, the Steward's own quick look was enough for a Wright PR to merge. Now it stays a draft and says so: review it yourself and mark it ready, or hire the Bailiff.
- **A removed agent stays removed.** If an employee's install folder is gone (it was fired in Manor, or uninstalled), the Steward still looks after its code and kit, but no longer installs it again: not after a merge, and not through a release built on this PC (which installs it). Before, the next kit rollout quietly put the Wright or the Bailiff back. Hire it in Manor to bring it back.
- **No Wright on this PC: work waits for you, and the alarm says so.** A failed bump or release is no longer described as "the Wright's page isn't set". The alarm now says the Wright isn't on this PC. Work already filed for a Wright that's since been removed no longer holds its alarm back for a day, since nobody is working on it.
- **No stale "down" alarms.** The Wright's and the Bailiff's pages are read only while they're installed, even if Settings still name them, so a removed one can't show as down forever.
- Everything else carries on without them as before: rounds, merging the team's and the Steward's own PRs, releases, kit rollouts, installs and alarms.

### Before you update

- Nothing: it updates itself as usual. With both the Wright and the Bailiff installed, nothing changes. Without the Bailiff, any open Wright drafts wait for you.

## 0.11.10

**When the Steward copies your employees into Settings and can't find something, it keeps looking and fills it in itself.**

### What changed

- When the Steward first copied its employees into Settings, it read what each needs (the command that fills its kit, its tests, its version files, how it's released) from that employee's folder on this PC, as the folder happened to be checked out. A folder left on an old branch looked like it was missing things, so you got an alarm such as "Manor: couldn't tell Fill its kit from its clone" that didn't say what to fill in and only cleared once you saved Settings. Now the Steward reads each employee's main branch (the branch the Steward works from), whatever the folder is checked out on.
- Until you save Settings, the Steward looks again every few minutes and fills in whatever it now finds. The alarm drops each item it fills, clears once nothing is left, and puts an employee that was left off the kit's stages back on once it has a test command and a release command.
- The alarm now says what it looked for (for the kit, `tools/kit.ts` or `tools/kit.ps1`), on which branch, and that you don't need to do anything if the Steward can find it.

### Before you update

- Nothing: it updates itself as usual. If you have this alarm open, it clears by itself within a few minutes of updating, provided the item is on the employee's main branch. You can still fill it in under Settings, Employees, and save.
- This release also brings 0.11.9 (below): it wasn't released on its own.

## 0.11.9

**Work for the Wright is filed in a repository that doesn't have the Wright's label yet.**

### What changed

- The Steward files work for the Wright as issues carrying the Wright's queue label (`manor:work`). In a repository that had never had work filed before, such as an agent just added as an employee, GitHub refused the issue because the label didn't exist yet. The alarm then said the work wasn't handed to the Wright, and someone had to create the label by hand. Now the Steward creates the label itself, with the same color and description the other repositories have, and files the issue again. Its log says when it did.

### Before you update

- Nothing: it updates itself as usual.

## 0.11.8

**A PR that asks for an install or a job approval no longer waits forever on an employee the Steward doesn't do that for.**

### What changed

- A PR's steward block can ask for an install, or for its jobs to be approved, after the merge. When Settings give that employee no install command (it is installed another way: Heiward installs from its own installer, and Manor's updates bring its new releases), or no approve command, the PR used to wait in every round with "it asks for install, but Settings give … no install command". Now it merges, the release it asks for still happens, and the install or approval line says it was skipped and why.

### Before you update

- Nothing: it updates itself as usual. A PR held only for this merges at the next round. A job a merged PR names isn't approved by the Steward when that employee has no approve command, so approve it in the agent itself if it needs one.

## 0.11.7

**No one's repositories are built in: the Steward looks after the ones you add.**

### What changed

- Employees in Settings start empty. Add one for each repository of yours the Steward should look after: its GitHub repository (owner/name), your clone of it, and how to test and release it. The page says how when there are none.
- The Steward's repository and the Steward's checkout in Settings start empty too. Empty, the Steward doesn't release itself or merge its own PRs, and a kit rollout needs a kit you name. With only a clone named, its origin is used as the repository.
- `claim-version steward` finds the Steward's own repository from Settings, or from the Steward clone it is run in.
- The examples in Settings no longer name anyone's account or repository.
- **Private employees are released on this PC.** Manor's internal staff (the agents listed in Manor's `staff.local.json`, or marked internal in its staff.json) are built and installed from their clones here, with `npm run release -- --install`, and never published. Their row in the staff table compares the installed copy's version with their branch's, not a GitHub release, and the install after a merge is their release itself.

### Before you update

- Nothing to do: an install that has been running keeps what it looks after. The first time the new version reads its settings, if settings.json doesn't list employees yet, the employees from its last look are written into settings.json once, each read from its clone on this PC. One whose clone isn't on this PC is left out. A .NET project's test command is found too: `dotnet test` on the unit tests of the project the others build on (never integration, GUI or benchmark tests). If something can't be read from a clone, an alarm says what, and that employee waits off the kit's stages until you fill it in under Settings, Employees, and save.
- Settings you already saved are kept as they are.

## 0.11.6

**A kit-bump issue closes by itself once that agent is past the kit, so the Wright isn't sent to fix nothing.**

### What changed

- When an agent's bump to a kit failed, the Steward filed an issue for the Wright. If a later bump then passed, the issue stayed open: the Wright took it up, found nothing to fix, and got stuck, and each one became an alarm. On 2026-10-06 that was six alarms for Reeve, Herald, Clerk and Auditor, all already on the newest kit. Now each round closes a bump issue as soon as that agent's main carries that kit or a newer one, saying why.

### Before you update

Nothing: it updates itself as usual.

## 0.11.5

**A Reeve update's jobs are approved as soon as it's installed, not up to a round later.**

### What changed

- When Manor installs an update that changes one of Reeve's job scripts, the job showed "Needs approval" until the Steward's next round approved it, up to ten minutes later. Manor now asks the Steward right after it installs, and the Steward approves at once. If a round is running, it approves as soon as that round ends. As before, it approves only a script that is exactly the one merged on Reeve's main; anything else stays yours to look at.

### Before you update

Nothing: it updates itself as usual. Manor asks only once it has the matching update too; until then, the rounds approve as before.

## 0.11.4

**Manor keeps itself up to date like every other agent, more merge conflicts clear themselves, and the Wright gets one issue per agent for a failing kit, not one per kit.**

### What's new

- **Manor is one of the Steward's employees.** Its PRs are tested and merged by the rounds, its new versions released (setup included), and new kits rolled out to it, as for every other agent. Manor installs its own releases as before, through its "Update automatically" switch.

### What changed

- **A `kit.json` conflict no longer needs a person.** When a PR and its branch both move the kit pin, the catch-up pins the newer kit of the two, with every part either side takes, and the PR merges once its tests pass. Before, every PR in that spot went back to whoever opened it.
- **A Steward kit PR whose agent already carries that kit, or a newer one, is closed by itself.** It has nothing left to do, and the next round bumps the agent from its branch as it is then.
- **One Wright issue per agent for a failing kit.** When a newer kit's bump fails for an agent that still has an older kit's bump issue open, that issue is rewritten for the newer kit and any other older ones are closed as superseded. Before, a new issue was filed for every kit version, so the Wright would have fixed the same thing two or three times.

### Before you update

- Manor's PRs merge on their own from now on. Its open PRs merge in version order, each caught up with a new version where it needs one.
- Manor's first release this way needs its lockfile: Manor's PR "a package-lock.json, as every kit agent has" merges first, on its own.
- This release doesn't bring 0.11.3, which is still a draft of its own.

## 0.11.2

**A new kit is tried on every agent before it's released, and some files always wait for you, whatever Settings say.**

### What's new

- **A kit is tried before it's released.** When a pull request to the Steward raises the kit's version, the round first bumps every agent to the new kit, as the rollout would, and runs its checks. Nothing is committed or pushed. If every agent passes, the PR merges as before. If any fail, the PR waits, and a comment on it names each agent and the tests that failed. Whoever wrote it can fix the kit before any agent sees it. If the agents have to change with the kit, label the PR `kit:breaks-agents`: it then merges, and each failed bump goes to the Wright. Each commit is tried once. This would have caught the kit change that failed nine agents' bumps on 2026-10-05.

### What changed

- **The Wright's drafts:** some files now always wait for your review, even if they aren't in Settings' "For a person to review" list:
  - Claude Code's settings and instructions: `.claude/`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`
  - `.npmrc`
  - secrets: `.env` files and keys
  - the code that guards the merge: the Steward's look at drafts and its merge rules, the Wright's worker and settings, and the Bailiff's review

  A draft that loosened one of these could otherwise pass the very look it changed.
- A draft that changes the scripts npm runs when it installs (`preinstall`, `install`, `postinstall`, `prepare`) or package.json's `overrides` waits for you, as a dependency change already did.

### Before you update

Nothing: it updates itself as usual. A round that merges a PR raising the kit takes longer, because it runs every agent's checks first.

## 0.11.1

**Kit 2.26.0: the kit names no one's GitHub account, private repository or folder** (kit/CHANGELOG.md). What runs on your PC knows only what your PC says.

### What changed

- Nothing on the Steward's own page: it hands the new kit to every agent.

### Before you update

Nothing: it updates itself as usual.

## 0.10.6

**Kit 2.25.0: shared settings for every agent, and a tour that fits the page** (kit/CHANGELOG.md): one round interval, a plain-words notes switch and a model-call limit with the same name in every agent, the folders Windows keeps wherever OneDrive moved them, and a new hire's tour that can take you back to Manor.

### What changed

- Nothing on the Steward's own page: it hands the new kit to every agent.

### Before you update

Nothing: it updates itself as usual.

## 0.10.5

**The team is whoever gh is signed in as, unless you name one.**

### What changed

- Team in Settings starts empty, and empty means the GitHub account gh is signed in as on this PC: yours, which covers the PRs Claude Code opens with it. Nobody else's account is built in any more.
- When Team is empty and gh isn't signed in, there is no team: Merge the team's PRs merges only the Steward's own, and the page, the stage's results and its log say so and how to fix it (`gh auth login`). Nothing stops working.

### Before you update

- Nothing: it updates itself as usual. A team you already named in Settings is kept as it is. This release brings kit 2.24.0 (0.10.4) too, if that wasn't released on its own.

## 0.10.4

**Kit 2.24.0: what agents asked for by hand, from the kit** (kit/CHANGELOG.md): another agent's address from Manor, the GitHub owner from gh, the manor's notification preferences, and settings marked as used only at the next install.

### What changed

- Nothing on the Steward's own page: it hands the new kit to every agent.

### Before you update

Nothing: it updates itself as usual.

## 0.10.3

**A kit that breaks many agents at once goes to the Wright all at once, and the Wright can redo a PR the Steward closed.**

### What changed

- When a new kit fails several agents' checks, every failed bump goes to the Wright the same day. A kit's failed bumps now count as one of the Wright's three issues a day, since they're one change with usually one cause. Before, three were filed and the rest stayed alarms, saying "this one waits for tomorrow", for days.
- When the Steward closes a Wright PR that conflicts and queues its issue again, it now deletes the PR's branch too. The Wright's redo uses the same branch name, so it couldn't push and got stuck ("the branch couldn't be pushed").

### Before you update

Nothing: it updates itself as usual. Bumps that are waiting for tomorrow are filed for the Wright at the next round, and their alarms wait while it works on them.

## 0.10.2

**Kit 2.23.0: the Steward's Settings are a React form, and shorter to read** (kit/CHANGELOG.md).

### What changed

- Settings looks as it did, field for field; its groups (Alarms, and the others) are sections you open, with links to each at the top, so the page is no longer one long column.
- A new hire's tour of its page (#/tour) is the kit's, for the agents whose onboarding is written.

### Before you update

Nothing: it updates itself as usual.

## 0.10.1

**Kit 2.22.0: the page's components are GamerNexus's UI kit, in the manor's look** (kit/CHANGELOG.md).

### What changed

- The Steward's page is built on them: its sections have headings with a count (Staff · 21), Refresh has its icon, and a button spins while what it started is under way.

### Before you update

Nothing: it updates itself as usual.

## 0.10.0

**The Steward's page is drawn in the browser, with React: the first of the manor's pages to move.** With kit 2.21.0 (kit/CHANGELOG.md), whose new react part draws the title bar, Settings and the rest of the frame.

### What changed

- The page looks as it did, and keeps itself current without reloading: every few seconds while a stage or round runs, and at once after a button. A ticked employee, an open log or where you'd scrolled to stays as it is.
- Run now is in the title bar from the start.

## 0.9.8

**The kit 2.20.0: on a PC without an NPU, a model is never called the NPU, and pages show a round as it starts and ends.**

### What's new

- What this PC has (whether it has an NPU, and its graphics cards) is kept in `hardware.json`, and decides what a config's "NPU" entry really is: on a desktop with an RTX 4080 SUPER, Reeve's model shows and works as the card's.
- Every agent's page draws itself again when a round starts or ends, without a reload by hand.

### What changed

- A note that says nothing of where it was written is "from a local model", never "the NPU".
- Settings' "Where its work runs" speaks of the NPU only on a PC that has one.

### Before you update

Nothing: it updates itself as usual.

## 0.9.6

**A UI inventory: which components are too big, and which markup is written out again and again, in any agent's page.**

### What's new

- `npm run ui:inventory` (tools/ui-inventory.ts, ported from GamerNexus's): every component of a page, how big each is, which renders which, and the markup written out by hand more than once. It reads the Steward and its kit, or any agent's repository or Manor's with `-- --repo <folder>`, in template strings or JSX alike, for the move of every page to React. It writes docs/UI-INVENTORY.md (or UI-INVENTORY-<repository>.md) and a sortable page beside it to open from disk; `--tree` prints the render tree, `--ci` fails on a component past its size ceiling.

### Before you update

Nothing: it updates itself as usual.

## 0.9.5

**The Thatcher, the Reckoner, the Weigher and the Shepherd are employees.** They are the general agents of the developer offices. Each shares its office with the developer agent there, as the Herald shares the Herald's: the Thatcher keeps your apps upgraded in Reeve's office, the Reckoner checks your devices after updates in the Auditor's, the Weigher measures your internet against your plan in the Aletaster's, and the Shepherd brings in background apps in the Pinder's. Like the Chamberlain, they are built on the kit, and Manor offers them from their releases' `manor-agent.json` (Manor 0.4.51). The Steward rolls the kit out to them, merges their PRs and publishes their releases.

## 0.9.4

**An update the Steward rolls back really goes back: the new page is ended, and the old one must answer as itself.**

### What changed

- Its update's probation forgives a look or two its page misses on a busy PC (each look allows 2 s): only three in a row, some 15 s with no answer, count as its page having stopped. 0.9.2 missed one, 83 s in, and was rolled back for it, though its page answered for hours after.
- A rollback ends the new version's page whether it answers or not: asked to stop, then its process ended (server.json's pid, when that is a Node). Before, a page that didn't answer was left running: it kept the port, the old version, started beside it, found a page up and stayed off, and the new version went on running from the old one's files. Manor then saw an update still waiting, and its installs failed.
- The old version counts as back only when its page answers as that version. Otherwise the rollback says which version answers, and how to end it.

### Before you update

Nothing: it updates itself as usual. If the Steward's page says 0.9.2 while Manor offers 0.9.2 as an update, its files are 0.9.1's: Dismiss the 0.9.2 alarm on its page (or `node src\cli.ts allow-update 0.9.2`), and this version installs over both.

## 0.9.2

**Kit 2.19.0: every release's notes say what it brings, from the repository's CHANGELOG.md** (kit/CHANGELOG.md, kit/spec/RELEASE-NOTES.md).

### What's new

- A kit bump writes the employee's changelog entry for the version it raises, at the top of its CHANGELOG.md (starting one when it has none): the kit it now carries, each kit version's headline since the one it pinned, and those kit entries' "Before you update", else that updating needs nothing. So the release a bump leads to has notes that say what changed.
- The Steward's own releases have the same notes: this file's entry for the version.

### What changed

- A manual Bump reads the kit's changelog too, as the round's rollout does, for that entry.

### Before you update

Nothing: it updates itself as usual.

## 0.9.1

**Kit 2.18.0: non-employee projects** (kit/CHANGELOG.md). The kit's `manorProjects()` gives the repositories a PC's Manor looks after without employing them (settings.json's `"projects"`), with the rules Manor's own settings use; a project is never an employee, and the Steward never touches one. The Aletaster's hand-over row says its new limit, 20 minutes.

## 0.9.0

**A failed bump or release is work for the Wright, not an alarm for you** (src/work.ts; Settings: "Hands failures to the Wright", `fileWork`, on). An employee's bump to a new kit that fails its checks, and its release that fails at a commit, used to be alarms at once ("Reeve's bump to kit 2.12.1 failed, and the rounds won't try it again until its branch moves"), though someone working in the repository could fix them.
- **Each is filed as a `manor:work` issue in the employee's repository**: what failed, the end of its output with secrets taken out (src/redact.ts, the Aletaster's rules), the branch or commit, where the fix goes (main: the bump's `steward/kit-<version>` was never pushed, and is made afresh from main once it moves) and what done means. Once each, by a hidden marker per employee, kind and kit version or commit (`<!-- steward:work:bump:porter:2.12.1 -->`); at most three a day (`work-filed.json`).
- **Only in an employee's repository the Wright's `GET /api/work` lists**, while it takes work, and only when gh is signed in as one of its team, as the Surveyor and the Aletaster file. Never in a repository the Wright works in that isn't the Steward's employee's (a project of the PC's own).
- **Its alarm waits** a day (`waitingHours`) from when it was filed, and is raised at once, saying why, when the Wright gets stuck on it (`wright:stuck`), its PR for it waits for a person (`wright:needs-you`), the Wright has no queue for that repository, or it couldn't be filed. The Steward's own releases stay alarms.
- **Reeve's alerts that are code work** go the same way: a new high or critical security advisory (dependency-health) or a failed Maestro flow (maestro-runs) that names an employee. His others (the NPU driver, the test phone, a job that crashed) stay alarms.
- A failed release's whole output is kept beside its worktree (`work\<id>-release.log`), as a bump's is.

**`GET /api/tested`, for the Surveyor**: each employee's last 20 commits whose checks passed here, newest first, with the stage (`bump`, `catch-up`, `merge` before merging, `release` for the commit a release was built from), when, and the branch, PR and version where there is one (`tested.json`).

## 0.8.23

**Kit 2.17.0: releases are built, and published in the public Jcollier0120/Manor-releases** (kit/CHANGELOG.md, kit/spec/RELEASES.md).
- The Steward's own release is built the same way and published there as `steward-v<version>`, as well as in its own repository. esbuild 0.28.2 is its devDependency.
- **A hire with esbuild in its package.json gets `npm ci` before its release** (`releaseNeedsPackages`): the kit's release builds with it. Before, a hire's release packed its files with Node alone, and got none.
- **The Steward's own release in a round (stages/self.ts) gets `npm ci` first too**, for the same reason.

## 0.8.22

**A release, bump or self-release cut short by the network is tried again, not held.** A failed command's message said only "failed (exit 1)". So when gh's publish timed out ("net/http: TLS handshake timeout") and the PC was online again by the time the round asked, the commit was kept in round-failed.json for a person to release (the Developer Herald's 0.5.6). The failure's message now carries the output line that says the network failed (`networkNote`). `networkFailure` sees it, along with the network failures the kit's words miss: Go's TLS and HTTP client timeouts, and Windows' "connection attempt failed".

## 0.8.21

**Kit 2.16.0: every agent's page uses the width of the window.** The kit's page no longer holds its panel's content to a 1180px column, and the title bar shows an agent's whole role when there is room for it (see [kit/CHANGELOG.md](kit/CHANGELOG.md)). The Steward's own page, a kit page, is the first to have it.

## 0.8.20

**Versions are claimed up front.** Work started side by side on one repository each took "the next version" and clashed on its way in. Now a worker asks the Steward first: `node src\cli.ts claim-version <employee> --branch <b> --for "<what>"` hands out the next version no one has (above the branch, every release, every open PR's title and every live claim), one claim at a time under a machine-wide lock, the same again for the same branch (src/claims.ts).
- `claims` and `GET /api/versions` list them; `release-version` gives one back. A claim lives until its work lands (on the branch, or overtaken by a release), it is given back, or three days pass with no PR that names it; each round prunes them (`version-claims.json`).
- The merge stage holds a PR that sets a version other work claimed, and its catch-up gives it a free one.
- The Wright 0.1.16 claims for each job before its worker starts.

## 0.8.19

**The Steward merges its own PRs, sends a conflict back to whoever wrote it, and rolls back an update of itself that fails.** Today's conflicts on its own PR were two PRs each adding a top entry to CHANGELOG.md under the same next version, and no one but a person merged the Steward's PRs.
- **A new entry at the top of CHANGELOG.md, on both sides, is resolved** in a catch-up, as version lines are: the branch's entries kept, the PR's above them under the version it ends up with (`mergeChangelogs` in catchup.ts). A PR given a new version without a conflict has its top entry renamed too.
- **A conflict that needs judgement goes back to its author** (stages/kickback.ts): the Wright's PR is closed and its issue queued for the Wright again; anyone else's, a Claude Code session's too, gets a comment naming the files. Once for a head (`kickbacks.json`).
- **Its own PRs are merged in its rounds** (stages/selfmerge.ts), as an employee's team PRs are: tested here first (`npm run kit`, `npm run typecheck`, `npm test`), a version of their own each, caught up or sent back. New setting: Merges its own PRs (`mergeSelf`), on.
- **An update of itself is on probation** (src/safeinstall.ts): the version before is kept as `app.prev`; the new one must answer as itself for 90 seconds, and render its home page. One that doesn't, or whose install fails once it is in place, is rolled back to `app.prev` and started again, set aside as `app.unsafe-<version>`, and flagged in `unsafe-updates.json`: refused by every install after, so Manor stops trying it, and an alarm at once. Dismissing the alarm, or `node src\cli.ts allow-update <version>`, allows it again.

## 0.8.18

**A bump that fails says which test, keeps its output, and is tried once more.** The rollout of kit 2.12.1 failed for two employees with only "npm test failed (exit 1)": the log keeps the last 25 lines of the output, and the failed test was far above them.
- A failed check's message names the tests that failed and the first lines of their errors, read from `node --test`'s output (`failedTests` in run.ts), so the alarm says what broke: `npm test failed (exit 1): "its name" (each request came after its warm-up: 5 !== 8)`. The log lists them too, before the tail.
- The failed step's whole output is kept beside its worktree, as `work\<id>.log`, and the message says where.
- A bump's checks that fail are run once more, as a PR's tested here are: Reeve's failed in the round, under the load of several bumps at once, and passed three times alone. A pass the second time is committed, and its result and commit message say so; failing twice is the failure, as before.

## 0.8.17

**Offline, the Steward waits, and raises no alarm the PC's being offline caused.** With kit 2.15.0 (kit/CHANGELOG.md, spec/OFFLINE.md):
- **A round while this PC is offline asks GitHub nothing:** no glance, no PR lists, no release lists. It would only fail for every employee, every few minutes. It records nothing (stages.log, last-stage.json) and says in its log that it waits for the network; the alarms still look at the pages on this PC.
- **The alarms leave out what is only the network's while offline** (`withoutOffline`): Manor's update look and an update it couldn't download, and any condition whose words are a network failure (an agent's round as the Surveyor saw it, a Reeve job's alert). An open one clears, and its hours start afresh once the PC is back online and it still fails. Everything else (a full disk, a page that doesn't answer, a port clash) is as ever, toast and all.
- **A release, one of the Steward's own, or a kit rollout that fails offline, or with a network failure's words, is never held against its commit** (round-failed.json, self-failed.json, rollout-failed.json; `networkFailure` in stages/common.ts): the next round tries it again, where before it waited for a person.
- Under `node --test`, the Steward is online unless a test says otherwise (`StageOptions.online`), so no test looks at the real network.

## 0.8.16

**A port clash is an alarm.** Each round the Steward reads Manor's `/api/summary` (Manor 0.4.38 and later) and its `ports`. It raises one alarm per port that two agents claim, that is kept for the model servers, or that another program answers on, so an agent's page can't start there (the Chamberlain on the Developer Herald's 19898). The alarm comes after a quarter of an hour, so a page restarting through an update isn't one. If the summary doesn't answer in a round, a port alarm stays as it was rather than clearing and coming back with a second toast.

## 0.8.15

**The Steward announces itself to every Manor.** `manor-agent.json` at the root is its staff.json entry and its role, as Manor's main has them; its own release (the kit's release.ts, from 2.12.0) publishes it beside the zip, listed in SHA256SUMS.txt, as every Node agent of the manor's now does. `test/manor-agent.test.ts` checks it with the kit's `checkAnnouncement`. Numbered 0.8.15, after 0.8.14 (kit 2.14.0) on main.

## 0.8.14

**Kit 2.14.0: the title bar stays at the top as the page scrolls.** The Steward hands out kit 2.14.0 (kit/CHANGELOG.md). Every kit agent's title bar (the Steward's own too) stays in place on a long page, with a line under it once scrolled, and a jump to a #section lands below it.

## 0.8.13

**Kit 2.13.1: an update that moves an agent's port ends the old page.** The Steward hands out kit 2.13.1 (kit/CHANGELOG.md). An agent's installer now finds its running page on the port server.json recorded, as well as its own, and stops it there.

## 0.8.12

**The Chamberlain is an employee.** The manor's new hire for its private papers is built on the kit as the other hires are, and the Steward now rolls the kit out to it, merges its PRs and publishes its releases. Manor offers it from its release's `manor-agent.json` (Manor 0.4.35), not from its own staff.json.

## 0.8.11

**Kit 2.13.0: the NPU first.** The Steward hands out kit 2.13.0 (kit/CHANGELOG.md): model work goes to the NPU whenever it can do it, busy or not, and to a graphics card or the processor only when it can't.

## 0.8.10

**Kit 2.12.1: a release zip's name has no spaces.** The Steward hands out kit 2.12.1 (kit/CHANGELOG.md). An agent whose name has two words (the Developer Herald) now publishes a zip that GitHub stores under the name SHA256SUMS.txt gives it, and that Manor finds.

## 0.8.9

**The Developer Herald is an employee.** It is the Herald's developer half since Herald 0.5.0, and the Steward now looks after it as it does the Smith: it rolls the kit out to it, merges its PRs and publishes its releases. A name of two words gives the id `developer-herald` and the repository and checkout `DeveloperHerald`.

## 0.8.8

**Kit 2.12.0: a release publishes manor-agent.json, when the agent's checkout has one.** The Steward hands out kit 2.12.0 (kit/CHANGELOG.md): `npm run release -- --publish` copies the checkout's `manor-agent.json` beside the zip, lists it in SHA256SUMS.txt and uploads it, so Manor 0.4.35 offers the agent for hire; and it refuses to build when the file names another repository than origin's, or another agent. (0.8.7 was kit 2.11.0's, for the Smith.)

## 0.8.6

**The Wright's drafts wait for the Bailiff, where it is installed.** The Bailiff (ours alone, like the Wright) reviews each of the Wright's drafts with Claude Code, read-only, and labels it `bailiff:approved` or `bailiff:changes`, with a comment ending in a marker that names the head commit it reviewed.

- Where `%USERPROFILE%\.bailiff\app` (or `BAILIFF_HOME`'s) exists, a draft that passes the Steward's code-only look is marked ready only when it carries `bailiff:approved` and the Bailiff's last marked comment by the team approves its current head. Otherwise it stays a draft, and its hold says why (`a draft from the Wright, with the Bailiff: …`). Without the Bailiff, nothing changes.
- The Bailiff is an employee, and its `GET /api/reviews` an alarm source (Claude Code unusable, a review failing twice, its page down), only where it is installed: new setting **The Bailiff's page** (`alarms.bailiffUrl`).
- Numbered 0.8.6, after 0.8.5 (kit 2.10.0) on main.

## 0.8.5

**Kit 2.10.0: Manor's gpuWithNpu keeps the graphics card out of model work beside an NPU.** The Steward hands out kit 2.10.0 (kit/CHANGELOG.md): with Manor's "Use the graphics card for models when there's an NPU" off and an NPU configured, no graphics card is chosen for a request, not even as the fallback. On by default. (0.8.4 is the Bailiff PR's.)

## 0.8.3

**The Aletaster's release gate, Reeve's alerts as alarms, and the Steward's own kit PRs caught up.**

- **A release waits for a passing tasting.** Before it publishes an employee's release (a round's, a merged PR's, or the Release button's), the Steward asks the Aletaster to taste the very commit it would release from (`POST /api/taste` with the page's token, then `GET /api/taste?id=…` every two seconds for up to 90 seconds), and publishes only when the tasting is done and lets it through (`release: true`: a pass, or a warning unless the Aletaster's own settings say warnings hold). Anything else holds the release, with the tasting's reason; the round looks at that employee again next round, whatever GitHub says.
  - It never deadlocks. With no Aletaster installed, or one off duty for Developer options (Manor's switch off, and the Aletaster a developer role in Manor's staff.json), the release goes with "released without a tasting: the Aletaster isn't here". With an Aletaster that predates `/api/taste` (its POST answers the route's own 404, with no `verdict`), or whose page doesn't answer at all, it goes with a note too. The Aletaster's own release is never held by its tasting, so a broken Aletaster can always be fixed.
  - A release held longer than **A release the Aletaster's tasting holds for** (`alarms.tastingHours`, 6 hours) is an alarm, with the reason and a link to the tasting. The holds are kept in `tasting-held.json`.
  - New setting **Waits for the Aletaster's tasting** (`tasteBeforeRelease`), on by default.
- **Reeve's alerts are alarms.** Each round reads Reeve's `GET /api/alerts` (where Reeve is installed; **Reeve's page**, `alarms.reeveUrl`, `http://127.0.0.1:18383`): one alarm per open alert of his jobs, at once, `reeve:<id>`, with his title, detail, link and since, and the Steward's Windows notification, since Reeve raises none of his own when Manor and the Steward are installed. An older Reeve without the endpoint, or his page down, is quiet (the Surveyor already reports his page down).
  - **One alarm for one crashed job.** The Surveyor reports a Reeve job that exited non-zero as the problem `agent.reeve.job.<job>`. While Reeve's alerts name that job, the Surveyor's condition for it is dropped and Reeve's stands; with no answer from Reeve, the Surveyor's stays.
- **The Steward's own kit PRs are caught up.** A round no longer leaves a `steward/kit-…` PR waiting as conflicting when a team PR took its version (Reeve#39): it is caught up by the team's rules (its branch merged in, a conflict resolved only in its version lines, the next free version), its kit filled again and the employee's checks run, then pushed, with a comment. One that conflicts beyond its version files is closed with its branch deleted, and the next round's rollout bumps the employee again from its branch's head.

## 0.8.2

The automatic rollout and self-release described under 0.8.1, as released: #34 (kit 2.9.1, an NPU turn skips its warm-up while the model is loaded) and #35 both raised the Steward to 0.8.1, and #34 was released as v0.8.1 first, so v0.8.1 doesn't carry #35. #36 released #35 as 0.8.2.

## 0.8.1

**The Steward rolls out a new kit by itself, and releases its own new versions.** Until now a round merged ready PRs, caught branches up, looked at the Wright's drafts and released the employees' new versions, but a new kit still needed a person: `npm run kit-release -- --publish`, then `steward bump` and `steward push`. Now the round does it.

- **The rollout in a round.** When the newest kit release is newer than the kit an employee's branch pins, and the employee has no kit PR of the Steward's open and no bump to that kit that failed at its branch's head, the round bumps it and pushes its PR, a few employees at a time. Later rounds merge and release that PR as any of the Steward's.
  - A bump whose checks fail, or a push that fails, raises an alarm at once. That kit isn't tried again until a new commit lands on the employee's branch, or a person presses Bump or Push (or runs the command). A newer kit is tried at once.
  - It waits while the Steward itself carries an older kit than the newest release, because a bump hands out the Steward's own tools/kit.ts. A kit that waits that way for a day raises an alarm.
  - The decision reads only the round's glance at GitHub (the kit releases, the open PRs) and each employee's kit.json on its branch, fetched only when the branch moved: no GitHub call of its own.
  - New setting **Rolls out a new kit by itself** (`rollout`), on by default.
- **Its own releases.** When the Steward's main carries a kit version with no `kit-v` release, or a Steward version with no `v` release, the round releases it as a person would, kit first, with the repository's own scripts.
  - Each release is made in a fresh worktree of the Steward's checkout at that commit of origin/main. A release carries only what is committed on main, so the Wright is never in anything published from here.
  - It never releases from an unclean tree, never a version already released, and never one that isn't above the newest release of its kind. A Steward version waits for its kit's release.
  - A release that fails raises an alarm at once, and isn't tried again until main moves. A Steward release tells Manor, as an employee's does, so Manor installs it within minutes.
  - New settings **Releases its own new versions** (`releaseSelf`, on by default) and **The Steward's checkout** (`stewardCheckout`, `C:\Projects\Steward`).
- **The glance reads more.** The round's one GitHub query also reads the Steward's main: its head, kit/VERSION and package.json's version. A new kit release, or the Steward now carrying a newer kit, counts as something new for every employee, so the round looks at all of them. The hourly full look, Run now, and a round without a glance all cover the rollout.
- **New files** in the data folder: `rollout-failed.json` and `self-failed.json`, which hold what the rounds won't try again.
