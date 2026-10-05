# The Steward's changelog

Each version of the Steward itself, newest first, released as `v<version>`. The kit it hands out has its own changelog, [kit/CHANGELOG.md](kit/CHANGELOG.md). Versions before 0.8.1 are described in their commits and pull requests.

## 0.8.4

**The Wright's drafts wait for the Bailiff, where it is installed.** The Bailiff (ours alone, like the Wright) reviews each of the Wright's drafts with Claude Code, read-only, and labels it `bailiff:approved` or `bailiff:changes`, with a comment ending in a marker that names the head commit it reviewed.

- Where `%USERPROFILE%\.bailiff\app` (or `BAILIFF_HOME`'s) exists, a draft that passes the Steward's code-only look is marked ready only when it carries `bailiff:approved` and the Bailiff's last marked comment by the team approves its current head. Otherwise it stays a draft, and its hold says why (`a draft from the Wright, with the Bailiff: …`). Without the Bailiff, nothing changes.
- The Bailiff is an employee, and its `GET /api/reviews` an alarm source (Claude Code unusable, a review failing twice, its page down), only where it is installed: new setting **The Bailiff's page** (`alarms.bailiffUrl`).
- Numbered 0.8.4, since the open #37 takes 0.8.3.

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
