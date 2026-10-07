# Several PCs

The owner works on a desktop or a laptop, depending on the job, and each may run a Steward signed in to the same
GitHub account. Without taking turns, two of them merge and release the same pull requests. Most of the staff act only
on their own PC and need nothing: Porter, Heiward, the Lamplighter, the Smith, the local AI. The Steward publishes to
shared remotes, so it takes turns.

The PCs work this out among themselves, through each repository's own remote, with plain git. No licence, no
Exchequer and nothing particular to GitHub is involved, so it works for anyone, Freehold included. (Merging itself still
uses `gh`; that is separate.)

## One release PC per repository

Each repository's remote holds `refs/manor/release-pc`: a tiny commit, with no parent, whose `release-pc.json` says
which PC has the repository's turn.

```json
{ "pc": "<device id>", "name": "DESKTOP-ABC", "until": "…", "since": "…", "pinned": false, "checkout": true }
```

- The device id is Manor's (`%USERPROFILE%\.manor\device.json`), or the Steward's own when Manor hasn't made one.
- It is read with `git ls-remote <remote> refs/manor/release-pc`, and its commit fetched with an explicit refspec.
- It is written by compare-and-swap: `git push --force-with-lease=refs/manor/release-pc:<old sha, or empty> <remote>
  <new>:refs/manor/release-pc`. Losing that race is normal: someone else has the turn.
- All of this happens in a scratch bare repository in the Steward's work folder (`work\_turns.git`), never in the
  person's own clone.

The rules (`src/lease.ts`):

- **Taking the turn.** A turn that is free, or ran out more than 2 minutes ago, is taken for three rounds (at least 15
  minutes). The PC that has it renews it once half of that time is gone.
- **Who has it.** Another PC's turn is left alone, and the page says so ("Merging and releasing for Clerk: done by
  DESKTOP-ABC").
- **Do it here** writes the turn to this PC at once.
- **Keep it on this PC** pins it there. A pinned turn is never taken while its PC renews it.
  - A pin silent for more than 24 hours may be taken, and the page says that PC has gone quiet.
  - **Unpin** lets it go back to the usual rules.
- **Checkouts.** A PC with a checkout of the repository takes the turn from one without. A PC without a checkout still
  takes part, through the remote's URL, so kit-update PRs keep flowing when no PC with a checkout is around.
- **Re-checking.** Before every publishing act, one `ls-remote`: the PC acts only while the turn is still its own,
  renewing it if it is near its end.

## What the turn gates, and what it never does

Only publishing to the shared remote waits for the turn:

- merging;
- releasing, including the Release button;
- the push after a refresh;
- a kit rollout's push (the round's, and the Push button);
- a catch-up's push.

Nothing local ever waits, with or without a remote or a turn:

- builds, tests and tastings;
- bumps and local commits;
- claiming a version;
- the Wright's and Reeve's work;
- any `npm run build`.

## When things fail

- **The remote can't be reached.** The stage goes on as before for that repository: it can't publish there anyway.
  The page says, in plain words and not as an alarm, that releasing waits until this PC can reach the remote.
- **The host refuses the ref.** This PC works alone there, as before, and the page says so once. Tested on GitHub
  (write, a lost race, read, delete). GitLab and Azure DevOps should accept any `refs/…` ref too, unless a server rule
  forbids it, but they weren't tested.
- **No turns at all** (development setups under `node --test`, or before any PC has written the ref): every repository
  acts exactly as before. The first look writes the ref.

## Version claims across PCs

`refs/manor/claims` holds `claims.json`: the live claims of every PC for the repository (and its kit).

- `claim-version` reads it, chooses exactly as the local store always has, and writes it back by compare-and-swap,
  retrying when another PC wrote first. Same branch, same version. A claim lives until it lands, is given back, or has
  gone three days with no PR naming it.
- **Remote out of reach:** the claim is made in the local store, as before.
  - The next round that reaches the remote shares it.
  - If another PC claimed the same version meanwhile, this PC's claim stays local and is marked, and the page says so.
  - The merge stage then holds the PR that sets that version, and catch-up gives it a fresh one.
- Each round copies every PC's claims into the local store, so the merge stage sees them. It also lets go of landed
  and stale claims in the ref.

## Later

- **The LAN part.** Instant handover notices between PCs on the same network, so Do it here takes effect without
  waiting for the other PC's next re-check.
- **The Wright, the Aletaster and the Developer Herald.** They can use the same mechanism, with refs of their own
  (`refs/manor/wright-work`, say). The plumbing is `src/remote-ref.ts`; it moves into the kit when a second agent
  needs it.
