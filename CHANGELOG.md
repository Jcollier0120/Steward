# The Steward's changelog

Each version of the Steward itself, newest first, released as `v<version>`. The kit it hands out has its own changelog, [kit/CHANGELOG.md](kit/CHANGELOG.md). Versions before 0.8.1 are described in their commits and pull requests.

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
