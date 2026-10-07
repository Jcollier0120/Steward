# The Steward's changelog

Each version of the Steward itself, newest first, released as `v<version>`. The kit it hands out has its own changelog, [kit/CHANGELOG.md](kit/CHANGELOG.md). Versions before 0.8.1 are described in their commits and pull requests.

## 0.23.1

**An employee's kit parts are read from its own kit.json, the one place they are kept.**

### What changed

- The Steward no longer keeps its own copy of each repository's kit parts. That copy didn't know the React part, so every agent with a React page carried a note on the Steward's page, "kit.json takes node, web, spec, react; Settings say node, web, spec", though nothing was wrong: an agent's kit has always been filled from its kit.json.
- The page now shows each repository's parts as its kit.json says them, React included, and the note is gone.
- Settings no longer has a Kit parts field for a repository. To change an agent's parts, change its kit.json.
- Taking on a repository (Look after, or `employ`) lists the parts its kit.json takes.

### Before you update

- Nothing: it updates itself as usual. The old parts in settings.json are left there and no longer read.

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
