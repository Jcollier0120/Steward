# Release notes: each repository's changelog

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/RELEASE-NOTES.md` in [Jcollier0120/Steward](https://github.com/Jcollier0120/Steward). Since kit 2.19.0.

Every release says what it brings. A release's notes come from its repository's **`CHANGELOG.md`**, at the repository's root, and are what Manor's **What's new** link opens. Each version has an entry there, newest first. Whoever raises the version writes it, in the same change: a person, a Claude Code session, the Wright's worker, or the Steward's kit bump.

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

## What the release does with it

The kit's `release.ts` (and Manor's and Reeve's own, with `notes.ts`) publishes these notes:

1. A first line, `<Name> <version>, built from <commit>, with the Steward's kit <kit>.`: Manor reads the commit from it (a release in the releases repository is tagged on that repository's own branch).
2. The entry, as written, without its `## ` heading.
3. **Installing**: how to install the release by hand.

`npm run release` says where the notes came from, and warns when the entry lacks **Before you update**, or has neither **What's new** nor **What changed**. A version with **no entry** still gets notes: a **What changed** that says no entry was written and lists its commits since the release before (each pull request's title, on the branch's first-parent line), with a warning at build time. A release never goes out saying nothing.

## The kit bump

The Steward's kit bump (`steward bump`, a round's rollout) raises an agent's version, so it writes that version's entry, at the top of the agent's `CHANGELOG.md` (starting one when there's none): the kit it now carries, a **What changed** line for each kit version since the one it pinned (that entry's headline, its opening bold sentence), and a **Before you update** made of those kit entries' own **Before you update** sections, or "Nothing: it updates itself as usual." when none has one.

So a kit entry in `kit/CHANGELOG.md` that needs something of the people updating says so under its own `### Before you update`: it reaches every agent's notes.

## Merging

Two changes side by side each add an entry at the top. The Steward's catch-up keeps both, the newer under the version it ends up with (`mergeChangelogs`), and renames a PR's top entry when it gives the PR another version.
