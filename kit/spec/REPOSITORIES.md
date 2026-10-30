# Tracked repositories: one list, in Manor

Since kit 2.42.0, the repositories the manor looks after on a PC are set in one place: the Repositories section of Manor's Settings, `"projects"` in Manor's settings.json. Every agent that works on repositories derives its own list from it, through the kit's `manorProjects()` (node/manor.ts), and never keeps a second one a person has to keep in step.

## Two kinds of repository

- **Staff:** Castellan's own: its agents, which take the kit and hold roles, and what else is released as Castellan (its site, its sales). Only the PC that releases Castellan has staff to look after: there the Steward's employees are staff, and its Settings keep them. A tracked repository may never be one of them (`manorOwn()`).
- **Tracked repositories:** the person's own, on every PC, the makers' included. Manor's list holds them. They take no kit and hold no role.

On any other PC there is no staff: everything the person develops is a tracked repository.

## An entry

`{ "name", "checkout", "repo"?, "host"?, "branch"?, "test"?, "versionFiles"?, "cleanBranches"?, "merges"?, "release"? }`, checked by `projectsFrom()`. A wrong entry is left out, and the reason is given among Manor's settings problems.

| Key | What it is | Default |
|---|---|---|
| `name` | What the pages call it | (required) |
| `checkout` | Its clone on this PC, a full path | (required) |
| `repo` | Where it is hosted: owner/name on GitHub, as always; host/path on any other host (`gitlab.com/group/sub/app`, `dev.azure.com/acme/Platform/_git/app`, `github.acme.com/team/app`); or its clone URL, read as one of those. A repository kept only on this PC, or on a share, has none (since kit 2.146.0; GitHub only before) | none |
| `host` | What kind of host it is, where its name doesn't say (a self-hosted GitLab at `code.acme.com`): `github`, `gitlab`, `bitbucket`, `azure`, `gitea` (Forgejo and Codeberg too) or `other`. It never changes github.com, gitlab.com, bitbucket.org, Azure DevOps, codeberg.org or gitea.com (since kit 2.146.0) | from the host's name |
| `branch` | Where its work goes and its releases come from | `main` |
| `test` | The command that runs its tests | none |
| `versionFiles` | The files its version is set in | none: its version is never changed |
| `cleanBranches` | Reeve deletes branches already merged | true |
| `merges` | The Steward merges the team's ready pull requests into `branch` (needs `repo`) | false |
| `release` | How the Steward releases the version on `branch`: `tag`, or a command run in a worktree of it (needs `repo` and `versionFiles`). A repository with no `repo` is released only as its own `.steward.json` says (since kit 2.146.2) | none: never released |

`merges` and `release` are the person's yes, repository by repository. Nothing merges or releases a repository that doesn't say so.

How the Steward builds, tests, versions and releases a repository is its own: a `.steward.json` committed at its top says so (its build and test commands, how it is versioned, its tag format, its notes, where it is released to), else the Steward's Settings, else what the keys above have always meant. The Steward's docs/PIPELINE.md has each option. The list above stays the one place a repository is named (since kit 2.146.2).

## Who uses what

| Agent | From each tracked repository |
|---|---|
| Reeve | Its rounds: tidy the clone, delete merged branches (`cleanBranches`). It also offers the repositories it finds on the PC as candidates for the list. |
| The Steward | It merges where `merges` is set and releases where `release` is set. It claims versions and keeps the version queue where `versionFiles` is set. |
| The Wright | Its work: it drafts fixes, setting the next free version in `versionFiles`. |
| The Bailiff, the Surveyor, the Assayer | They review the Wright's drafts, run `test`, and so on, as each one's spec says. |

An agent installed without Manor keeps its own list, as before, and reads it only then.

## Any host, or none

Since kit 2.146.0 a repository's place is an `Origin` (node/manor.ts): `{ kind, hostName, path, webUrl }`, its `kind` one of `github`, `gitlab`, `bitbucket`, `azure`, `gitea`, `other` or `local`.

- `parseOrigin(url, hint?)` reads a remote however it is written: https with or without .git, ssh://, scp-style (`git@host:path`), git://, file://, a drive, a share or a relative path. GitLab keeps its subgroups. Azure DevOps reads as `org/project/_git/name` on dev.azure.com, from its ssh form too, and as `project/_git/name` on org.visualstudio.com. Bitbucket Data Center drops its `scm/`. A host is known by its name (`kindOfHost`: github.com and GitHub Enterprise, gitlab.*, bitbucket.*, dev.azure.com and *.visualstudio.com, gitea, forgejo and codeberg.org), or by the project's `host`.
- `originOf(checkout, hint?)` is a clone's origin from its git config (a worktree's through its main clone). A clone with no origin is `local`; a folder that isn't a clone is null.
- `originName(origin)` is the name the manor gives it: owner/name on github.com, exactly as before; `host/path` anywhere else; `local/<folder>` for one kept on this PC. `originOfName(name, hint?)` reads one back, and `repoNameOk(name)` says whether an agent may be asked about it (a Seneschal task, a peer's result).
- `projectOrigin(project)` is a tracked repository's place: from its `repo`, else from its clone.

A project on GitHub reads exactly as before: its `repo` is owner/name, and it has no `host` key unless its entry gives one. `originRepo(checkout)` is still GitHub's alone.

## Moving to one list

Manor brings in, once, what the agents kept apart before 2.42.0. On a PC that doesn't release Castellan, that is the repositories the person added to the Steward with Look after: each becomes a tracked repository with its `merges` and `release` as the Steward had them. After that, the agents' own lists are read only where there is no Manor.
