# Set up your pipeline

The Steward builds and releases each repository the way that repository says. You say it in a `.steward.json` file
committed at the top of the repository, or in the Steward's Settings, under **Repositories**, **Pipelines**. Without
either, it does what it has always done. This page gives every option, how to sign in to each host, an example for
each kind of project, and how to see what a build would do before it does anything (`src/repoconfig.ts`).

## Where it is said

The Steward reads three sources, and a later one wins for each option it gives:

1. **The defaults:** what Settings' fields have always meant. Its tests are **Test it**, its version files are
   **Version files**, and **Release it** is a command or `tag`. Versions are claimed up front, and the tag is
   `v<version>`.
2. **Settings, Pipelines:** a pipeline for a repository, keyed by its name (`owner/name`, `gitlab.com/group/app`) or its
   id. Its value is the same JSON as a `.steward.json`. Use this for a repository you can't commit to.
3. **`.steward.json`** at the top of the repository's clone. It goes with the repository, so every PC and every person
   that builds it gets the same steps.

A pipeline that can't be read holds that repository: nothing is built or released until it is fixed. Each mistake is
said in a sentence on the Steward's page and in the dry run. The other repositories carry on.

## The options

```json
{
  "host": "gitlab",
  "build": ["npm run build"],
  "test": ["npm run typecheck", "npm test"],
  "release": "npm publish",
  "versioning": "claim",
  "versionFiles": ["package.json", "package-lock.json"],
  "tagFormat": "v{version}",
  "changelog": "auto",
  "releaseTo": "auto",
  "mergeMethod": "merge",
  "vouch": true,
  "sharedRefs": true
}
```

Leave out any option to keep its default. `"//"` and `"$schema"` keys are ignored, so you can leave a note.

| Option | What it says | Default |
| --- | --- | --- |
| `host` | The kind of host its repository is on: `github`, `gitlab`, `azure`, `gitea`, `bitbucket`, `git` (plain git, any host) or `none` (this PC alone). For a host of your own, give its address too: `{ "kind": "gitlab", "baseUrl": "https://gitlab.acme.com" }`. | Read from its origin's name |
| `build` | Commands run in order before its tests. They also run before a release to a folder or by a command. | none |
| `test` | Commands that must all pass on the commit before it is released, unless a vouch covers that commit. | Settings' **Test it** |
| `release` | The one command that releases it, run in a fresh worktree of the commit. Put the steps before it in `build`. | Settings' **Release it** |
| `versioning` | `claim`: each branch claims the next free version up front (`claim-version`), set in `versionFiles`. `files`: the version in `versionFiles`, as you set it, with nothing claimed. `tags`: no file carries it; its tags do, and the next version is the patch after the newest tag once there are new commits (`0.1.0` first). `none`: never released. | `claim` |
| `versionFiles` | The files its version is set in: `package.json`, `package-lock.json`, a `.ts` with `version: 'x.y.z'`, a `.csproj` or `.props` with `<VersionPrefix>`, `Cargo.toml` (`[package]` or `[workspace.package]`), `pyproject.toml` (`[project]` or `[tool.poetry]`). | Settings' **Version files** |
| `tagFormat` | Its release tags, with `{version}` in them once: `v{version}`, `app-{version}`, `release/{version}`. | `v{version}` |
| `changelog` | Its release notes. `auto`: `changes/` entries stamped into `CHANGELOG.md` where it keeps a `changes/README.md`, and the version's `CHANGELOG.md` entry as the notes. `changes-dir`: the same, said outright. `changelog-md`: the version's `CHANGELOG.md` entry, as you write it. `host`: the host's own notes, from the commits. `none`: no notes. | `auto` |
| `releaseTo` | Where a release goes. `auto`: a release on its host, or a tag on plain git. `host`: a release on its host. `tag`: a tag at the commit, pushed to its origin. `command`: its `release` command, then its tag. `none`: never released. A folder: `{ "folder": "D:\\Releases\\app", "from": "dist" }` copies what its build leaves in `from` to `<folder>\<tag>`, and tags the commit in your clone. | `auto` when it has a release, else `none` |
| `mergeMethod` | How its own pull requests (the Steward's stamps and kit bumps) are merged: `merge`, `squash` or `rebase`. GitLab merges by `merge` or `squash`. | `merge` |
| `vouch` | Whether `steward vouch` tests its pull requests and marks the commit tested. | `true` |
| `sharedRefs` | Whether its release turns and version claims are kept on its origin (`refs/manor/*`), for your other PCs. `false`: on this PC alone. | `true` |

Some options don't fit together, and the Steward says so in a sentence:

- `claim` or `files` with no `versionFiles`.
- `releaseTo` `command` with no `release` command.
- `tags` with `versionFiles` (tags carry the version, so no file does).
- `releaseTo` `host` on `git` or `none`, which have no releases.
- `releaseTo` `tag` on `none`, which has no origin.
- `sharedRefs` `true` on `none`.
- `mergeMethod` `rebase` on GitLab.

## Sign in to your host

The Steward works a repository its host's way once that host's tool is installed and signed in on this PC. Until then
it uses plain git: it fetches and pushes tags with git, has no pull requests, vouches for nothing, and a release is a
tag. Every tool keeps its own sign-in, and the Steward never reads, stores or shows a token.

| Host | Its tool | Sign in | The Steward checks with |
| --- | --- | --- | --- |
| GitHub, GitHub Enterprise | the GitHub CLI, `gh` | `gh auth login` | `gh auth token` (its exit code only) |
| GitLab, self-hosted GitLab | the GitLab CLI, `glab` | `glab auth login --hostname gitlab.acme.com` (on http or another port: `glab auth login --hostname gitlab.acme.lan:8080 --api-protocol http --git-protocol http`) | `glab auth status` |
| Azure DevOps | the Azure CLI, `az` | `az login` | `az account show` |
| Gitea, Forgejo, Codeberg | the Gitea CLI, `tea` (a version with `tea api`) | `tea login add --url https://codeberg.org` | `tea logins list` |
| Bitbucket Cloud | Git for Windows | an Atlassian API token in Windows' Credential Manager, as `git:https://api.bitbucket.org` (your email as the user name) | `git credential fill` |
| Any other git server, a share, this PC | Git for Windows | git's own (SSH keys, the credential manager) | `git ls-remote` |

With Settings' **Team** empty, the accounts these tools are signed in as are the team: theirs are the vouches the
Steward trusts.

Where a repository's pipeline names its host but that host's tool isn't installed or signed in here, the dry run (below)
says so in its second line, and what to run. For a GitLab of your own at `http://gitlab.acme.lan:8080`:

```text
why plain git: its pipeline names GitLab, but the GitLab CLI isn't signed in (glab auth login --hostname gitlab.acme.lan:8080 --api-protocol http --git-protocol http), as the Steward last looked (2026-10-31 02:30 UTC): plain git until then
```

Until then a release to its host (`"releaseTo": "host"`) is held, and the build says why: plain git has no releases.

## An example for each stack

Each of these is a sample in [samples/pipelines](../samples/pipelines), ready to try (below).

**Node.js:** the defaults, said outright.

```json
{ "test": ["npm test"], "versioning": "claim", "versionFiles": ["package.json"], "releaseTo": "tag" }
```

**Python:** the version in `pyproject.toml`, which you set yourself, and its own tag format.

```json
{
  "test": ["python -m pytest"],
  "versioning": "files",
  "versionFiles": ["pyproject.toml"],
  "tagFormat": "python-hello-{version}",
  "changelog": "changelog-md",
  "releaseTo": "tag"
}
```

**Rust:** built in release before its tests, and released by a command of its own (`cargo publish`, say).

```json
{
  "build": ["cargo build --release"],
  "test": ["cargo test"],
  "versioning": "files",
  "versionFiles": ["Cargo.toml"],
  "release": "cargo publish",
  "releaseTo": "command"
}
```

Install Rust with rustup (`winget install Rustlang.Rustup`). Its usual toolchain, MSVC, links with Visual Studio's C++
Build Tools. On a PC without them, `rustup default stable-x86_64-pc-windows-gnu` switches to the GNU toolchain, which
links by itself. The Rust sample builds, tests and releases with either.

**.NET:** published, then released to a folder.

```json
{
  "build": ["dotnet publish -c Release -o publish"],
  "test": ["dotnet test"],
  "versioning": "files",
  "versionFiles": ["src/App/App.csproj"],
  "releaseTo": { "folder": "D:\\Releases\\app", "from": "publish" }
}
```

**Go:** no version file. Its tags carry the version.

```json
{ "test": ["go test ./..."], "versioning": "tags", "changelog": "none", "releaseTo": "tag" }
```

**A repository on this PC alone:** no origin and no host. Its tags are made in your clone, and its releases are copied
to a folder.

```json
{
  "host": "none",
  "versioning": "tags",
  "releaseTo": { "folder": "%USERPROFILE%\\Releases\\notes" },
  "vouch": false,
  "sharedRefs": false
}
```

**A GitLab of your own:** its address, squash merges, and GitLab's own release notes.

```json
{
  "host": { "kind": "gitlab", "baseUrl": "https://gitlab.acme.com" },
  "versionFiles": ["package.json"],
  "changelog": "host",
  "mergeMethod": "squash"
}
```

On http or another port, give its address as it is (`"baseUrl": "http://gitlab.acme.lan:8080"`): the Steward asks glab
for it there, and the merge command a vouch says names it there too
(`glab mr merge 7 --repo http://gitlab.acme.lan:8080/team/app`).

## See it first: the dry run

`steward build --dry-run` prints each step a build of one repository would take, and runs, fetches and writes nothing.
It takes a repository the Steward looks after (its id or name), or the folder of any clone on this PC, looked after or
not. A clone that isn't looked after yet is read as Look after would take it, so you can try a `.steward.json` before
you add the repository. Like the Steward's other commands for developers, it needs Developer options on in Manor's
Settings.

```bash
node tools/samples.ts
```

```bash
node src/cli.ts build --dry-run C:\Projects\pipeline-samples\python-hello
```

```text
python-hello (local/python-hello), branch main, worked with plain git
not looked after yet: read from C:\Projects\pipeline-samples\python-hello as Look after would take it
pipeline: test from .steward.json, versioning from .steward.json, versionFiles from .steward.json, tagFormat from .steward.json, changelog from .steward.json, releaseTo from .steward.json
 1. test      python -m pytest  (in a fresh worktree of origin/main; must pass)
 2. version   the version in pyproject.toml, as you set it; nothing claimed
 3. changelog the version's CHANGELOG.md entry, as written by hand
 4. release   tags python-hello-<version> at the commit and pushes it to its origin
 5. merge     none: plain git has no pull requests
 6. vouch     none: plain git has no pull requests to vouch for (test a branch with steward vouch's dry run, or push it to the branch)
 7. refs      turns and version claims kept on its origin, for other PCs
Nothing was run (dry run).
```

The first line says how the repository is worked with: its host's way, or plain git. The second line says where each
option came from. A pipeline with mistakes lists each one and ends with `held:`, and the command exits 1:

```bash
node src/cli.ts build --dry-run C:\Projects\pipeline-samples\broken-pipeline
```

```text
error: .steward.json: "versioning" must be one of claim, files, tags, none, not "sometimes"
error: .steward.json: "tagFormt" isn't a pipeline option (did you mean "tagFormat"?); the options are host, build, ...
held: its pipeline can't be read, so nothing is built or released until it's fixed: ...
```

## Add it

Open the Steward's page and go to **Found on this PC**. It lists your clones on GitHub that you can push to, and every
clone on another host or on this PC alone. Press **Look after** next to one, or type a clone's folder into **Add a clone
by its folder**. Off the makers' PC, Look after adds it to Manor's Repositories. A repository on this PC alone goes in
with no `repo`, and its `.steward.json` says how it is released.

## Updating

Nothing changes for a repository with no `.steward.json` and nothing in Settings' Pipelines. Its tests, versions,
releases, tags and notes are what they were.
