# The Steward's changelog

Each version of the Steward itself, newest first, released as `v<version>`. The kit it hands out has its own changelog, [kit/CHANGELOG.md](kit/CHANGELOG.md). Versions before 0.8.1 are described in their commits and pull requests.

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
