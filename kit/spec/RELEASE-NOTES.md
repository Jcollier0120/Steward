# Release notes: each repository's changelog

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/RELEASE-NOTES.md` in the Steward's repository, and `src/kit/spec/RELEASE-NOTES.md` in every agent that takes the part. Since kit 2.19.0.

Every release says what it brings. A release's notes come from its repository's **`CHANGELOG.md`**, at the repository's root, and are what Manor's **What's new** link opens. Each version has an entry there, newest first. Whoever does the work writes it, in the same change: a person, a Claude Code session, the Wright's worker, or the Steward's kit bump. On the build pipeline (**Entries in changes/** below), as every agent is from Steward 0.36.248, the work writes it in `changes/`, and the Steward's build moves it into `CHANGELOG.md` under the version it gives the release.

## An entry

```markdown
## 0.4.31

**One line that says what this version is about.**

### What's new

- What it can do now that it couldn't before, as the person using it sees it.

### What changed

- What works differently, what was fixed, and what went away.

### Before you update

- Anything a person must know or do before or after updating: a setting that moved or was renamed, data that is converted or rebuilt (and how long it takes), anything that stops working, another agent that must be updated first, a step after installing.
- Or, when there is none: Nothing: it updates itself as usual.
```

- **The heading is the version**, exactly as the version files have it (`## 0.4.31`; `## v0.4.31` and `## [0.4.31] - 2026-10-05` are read too).
- **What's new** and **What changed**: give the one that applies, or both. Write for the person who uses the agent, not its maintainer: what they'll see, not which function moved. Leave out what nobody outside the code would notice, or say it in one line.
- **Before you update is always there.** "Nothing: it updates itself as usual." is an answer, and saying so is the point: a person reading the notes knows it was thought about.
- The notes are public (they are published in Jcollier0120/Manor-releases with the release), so no secrets, private paths or another person's details, and no links into the private repositories.

## An urgent fix

Customers get Castellan's releases on its **release days**, Tuesdays and Fridays at 14:00 UTC (the Exchequer, from 0.8.0), so a week's work reaches them together. A fix that can't wait for that says so in its entry: its bold line starts with **`Urgent fix:`**, saying what it fixes, as a customer reads it.

```markdown
## 0.4.32

**Urgent fix: updates no longer stop after a look for new releases that never ends.**
```

A release whose entry has a line starting `**Urgent fix:` (or one it brings, from a version never released on its own) is published to the Exchequer as **urgent**: out to customers at once, not on the next release day. `npm run release -- --publish --urgent` (or `--exchequer --urgent`) does the same for a release whose entry isn't marked. One published already is let out from the PC that releases Castellan with the Steward's `release-now <agent> [version]`; the Steward's round does that itself for a marked entry an older kit published. Keep the mark for what really can't wait: customers chose the calm of twice a week.

## What the release does with it

The kit's `release.ts` (and Manor's and Reeve's own, with `notes.ts`) publishes these notes:

1. A first line, `<Name> <version>, built from <commit>, with the Steward's kit <kit>.`: Manor reads the commit from it (a release in the releases repository is tagged on that repository's own branch).
2. The entry, as written, without its `## ` heading. Where versions were merged since the release before and never released on their own (the Steward releases once for all it merged in a round), their entries follow, each under its own `## <version>`, after a line that names them (`combinedEntry`).
3. **Installing**: how to install the release by hand.

`npm run release` says where the notes came from, and warns when the entry lacks **Before you update**, or has neither **What's new** nor **What changed**. A version with **no entry** still gets notes: a **What changed** that says no entry was written and lists its commits since the release before (each pull request's title, on the branch's first-parent line), with a warning at build time. A release never goes out saying nothing.

## The kit bump

The Steward's kit bump (`steward bump`, a round's rollout) writes the agent's entry for the kit it now carries: a **What changed** line for each kit version since the one it pinned (that entry's headline, its opening bold sentence), and a **Before you update** made of those kit entries' own **Before you update** sections, or "Nothing: it updates itself as usual." when none has one.

It writes it as any work on the build pipeline does: in `changes/steward-kit-<kit, dots as dashes>.md`, setting no version and leaving `CHANGELOG.md` alone, so an agent's own pull request open beside it never meets it in the same lines. One without `changes/README.md` gets that file in the same bump, which puts it on the pipeline. Only an agent worked with plain git, where the Steward opens no pull requests and so has nothing to stamp through, is bumped the old way: its version raised, and the entry at the top of its `CHANGELOG.md` under that version.

So a kit entry in `kit/CHANGELOG.md` that needs something of the people updating says so under its own `### Before you update`: it reaches every agent's notes.

A kit entry marked urgent (its bold line starts with `Urgent fix:`) makes every agent's bump entry urgent too: its bold line starts `**Urgent fix:`, naming the kit. The Steward then rolls that kit out at once rather than at its next build, builds each agent as soon as its bump merges, and each release goes out to customers at once, as any urgent fix does.

```markdown
## 0.5.84

**Urgent fix: it carries the Steward's kit 2.136.1, with an urgent fix to the parts every agent of the manor shares.**
```

## Merging

On the build pipeline, work side by side never meets: each piece writes a file of its own in `changes/`. Off it, two changes side by side each add an entry at the top, and set a version. The Steward's catch-up keeps both entries, the newer under the version it ends up with (`mergeChangelogs`), and renames a PR's top entry when it gives the PR another version.

## Entries in changes/

A repository with `changes/README.md` on its branch rides the **build pipeline**: its work writes its entries as files of their own, and the Steward's build sets the version, so two pieces of work side by side never touch the same lines. Every agent the Steward rolls its kit out to is on it from the first build after Steward 0.36.248 is installed: the rollout adds `changes/README.md` on its own, in a pull request the Steward opens and merges, to one on the newest kit already, and the kit bump adds it to one behind (**The kit bump** above). Manor has been on it since 2026-10-09.

1. Ask the Steward (`claim-version <repo> --branch <your branch>`): it claims nothing, says the repository rides the build pipeline, and names the file to write, `changes/<your branch, slashes as dashes>.md` (`claude/some-work` writes `changes/claude-some-work.md`).
2. Write the entry there, as above, without its `## ` heading. A first line `minor: true` asks for a minor step. Leave the version files (`package.json`, `package-lock.json`, `src/app.ts`, or a .NET agent's project file) and `CHANGELOG.md` as they are.
3. Merge the pull request once it's vouched for, as any other.
4. At its next build the Steward stamps main: in a pull request of its own (`steward/stamp-<commit>`), which it opens and merges, it sets the release's version in the version files, moves every entry waiting in `changes/` into one `CHANGELOG.md` entry under that version (`Brings 3 changes: …`, or `Urgent fix: brings 3 changes: …` when one of them is urgent), and deletes their files. The version is the next free one above every version released or claimed; when main's own version isn't released yet, the entries join its entry instead. What covered main's head (its vouch) covers the stamp, since only versions and entries changed. Then it releases.

The switch is gentle. A pull request opened before it, which set its version and wrote its `CHANGELOG.md` entry the old way, still merges cleanly, since the kit bump and the entries in `changes/` touch none of its lines; while it is next in its repository's version line, the stamp waits for it, and its version is the one the stamp gives the entries merged beside it. One stuck there for an hour is passed over: the stamp goes ahead, and the Steward gives it the next free version.

An entry that says nothing waits for its author. In the Steward's own repository the kit has the same, in `kit/changes/`. A repository without `changes/README.md` keeps the way above, and the catch-up merges its entries as before.
