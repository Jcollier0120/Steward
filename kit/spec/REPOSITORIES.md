# Tracked repositories: one list, in Manor

Since kit 2.42.0, the repositories the manor looks after on a PC are set in one place: the Repositories section of Manor's Settings, `"projects"` in Manor's settings.json. Every agent that works on repositories derives its own list from it, through the kit's `manorProjects()` (node/manor.ts), and never keeps a second one a person has to keep in step.

## Two kinds of repository

- **Staff:** Castellan's own: its agents, which take the kit and hold roles, and what else is released as Castellan (its site, its sales). Only the PC that releases Castellan has staff to look after: there the Steward's employees are staff, and its Settings keep them. A tracked repository may never be one of them (`manorOwn()`).
- **Tracked repositories:** the person's own, on every PC, the makers' included. Manor's list holds them. They take no kit and hold no role.

On any other PC there is no staff: everything the person develops is a tracked repository.

## An entry

`{ "name", "checkout", "repo"?, "branch"?, "test"?, "versionFiles"?, "cleanBranches"?, "merges"?, "release"? }`, checked by `projectsFrom()`. A wrong entry is left out, and the reason is given among Manor's settings problems.

| Key | What it is | Default |
|---|---|---|
| `name` | What the pages call it | (required) |
| `checkout` | Its clone on this PC, a full path | (required) |
| `repo` | owner/name on GitHub | none |
| `branch` | Where its work goes and its releases come from | `main` |
| `test` | The command that runs its tests | none |
| `versionFiles` | The files its version is set in | none: its version is never changed |
| `cleanBranches` | Reeve deletes branches already merged | true |
| `merges` | The Steward merges the team's ready pull requests into `branch` (needs `repo`) | false |
| `release` | How the Steward releases the version on `branch`: `tag`, or a command run in a worktree of it (needs `repo` and `versionFiles`) | none: never released |

`merges` and `release` are the person's yes, repository by repository. Nothing merges or releases a repository that doesn't say so.

## Who uses what

| Agent | From each tracked repository |
|---|---|
| Reeve | Its rounds: tidy the clone, delete merged branches (`cleanBranches`). It also offers the repositories it finds on the PC as candidates for the list. |
| The Steward | It merges where `merges` is set and releases where `release` is set. It claims versions and keeps the version queue where `versionFiles` is set. |
| The Wright | Its work: it drafts fixes, setting the next free version in `versionFiles`. |
| The Bailiff, the Surveyor, the Assayer | They review the Wright's drafts, run `test`, and so on, as each one's spec says. |

An agent installed without Manor keeps its own list, as before, and reads it only then.

## Moving to one list

Manor brings in, once, what the agents kept apart before 2.42.0. On a PC that doesn't release Castellan, that is the repositories the person added to the Steward with Look after: each becomes a tracked repository with its `merges` and `release` as the Steward had them. After that, the agents' own lists are read only where there is no Manor.
