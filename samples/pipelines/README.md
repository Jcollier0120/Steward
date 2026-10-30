# Sample pipelines

Hello, world on each kind of repository, each with a `.steward.json` that says how the Steward builds and releases it
([docs/PIPELINE.md](../../docs/PIPELINE.md) has every option). They are for trying the Steward's pipelines on
something small before your own repositories.

| Sample | Stack | Origin | What its pipeline shows |
| --- | --- | --- | --- |
| `node-hello` | Node.js | a folder | the defaults said outright: versions claimed, `package.json`, a `v<version>` tag |
| `python-hello` | Python | a folder | `pyproject.toml`'s version, pytest, its own tag format (`python-hello-<version>`), notes from `CHANGELOG.md` |
| `rust-hello` | Rust | a folder | a build before its tests, `Cargo.toml`'s version, released by a command of its own |
| `dotnet-hello` | .NET | a folder | `dotnet publish`, the `.csproj`'s `<VersionPrefix>`, released to a folder |
| `go-hello` | Go | a folder | versioned by its tags alone, no version file, no notes |
| `local-only` | Windows batch | none | a repository on this PC alone: no host, no vouches, no shared refs, released to a folder |
| `gitlab-hello` | Node.js | a fake GitLab | a GitLab of your own (`baseUrl`), squash merges, GitLab's own notes |
| `folder-release` | Node.js | a folder | `npm run build` into `dist`, and `dist` copied to a folder |
| `broken-pipeline` | none | a folder | wrong on purpose: each mistake said, and its builds and releases held |

## Spin them up

```bash
node tools/samples.ts
```

This makes each sample a git repository in `C:\Projects\pipeline-samples`, or in a folder you name
(`node tools/samples.ts D:\samples`), with one commit on `main`. Each origin is a bare repository in `.origins`
beside them, so nothing is asked of any host. `gitlab-hello`'s origin has a GitLab address
(`https://gitlab.example.test/samples/gitlab-hello.git`), and git's `insteadOf` sends its pushes to a folder. If a
sample is there already, it is left as it is. `--only node-hello,go-hello` makes only those.

## Try one

To see each step a build would take, with nothing run:

```bash
node src/cli.ts build --dry-run C:\Projects\pipeline-samples\python-hello
```

To have the Steward look after one, open its page and go to **Found on this PC**. Press **Look again** to list it, or
type its folder into **Add a clone by its folder**. Its releases go to its origin in `.origins`. The folder releases go
to `releases\<sample>\<tag>`.

`gitlab-hello` is worked with plain git unless glab is signed in on this PC. If glab is signed in, the Steward would ask
`gitlab.example.test`, which doesn't exist.
