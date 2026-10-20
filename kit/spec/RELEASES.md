# Releases: built, and public

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/RELEASES.md` in the Steward's repository, and `src/kit/spec/RELEASES.md` in every agent that takes the part. Since kit 2.17.0.

The agents' source stays in their private repositories. What a PC installs is a **built** release, published in one **public** repository, [Jcollier0120/Manor-releases](https://github.com/Jcollier0120/Manor-releases), so any PC downloads it without signing in to GitHub, and nobody reads the source from it.

## Built: `node/minify.ts`

`npm run release` (the kit's `release.ts`) stages what the release carries, then builds it with esbuild, an exact devDependency of every kit agent (esbuild 0.28.2):

- Each `.ts` file under `src\` (the agent's own and `src\kit\`) is minified **on its own**: it is esbuild's entry point (ESM, Node 22, `keepNames`) with every import left outside it, and an import of another relative `.ts` (static, dynamic or `export ... from`) pointing at its `.js`. esbuild's own parser finds them, never a text search, so an import written inside a string stays as it is. Imports stay as written (`verbatimModuleSyntax`): one kept only for what loading it does stays, and `import type` goes. It is written as a `.js` beside where it was, and the `.ts` goes. Every module stays in its folder, so whatever it finds next to itself (`import.meta.url`, `import.meta.dirname`: the kit's web part, a PowerShell script, rules.json) is where it was.
- **`src\cli.ts` stays, as a one-line stub** that imports `./cli.js`: installers, Task Scheduler's tasks and Manor's staff list start an agent as `node src\cli.ts`. The kit's `service.ts` starts the page through it too, so its command line still says `cli.ts` (Pinder and the Surveyor know the manor's agents by it). (`ENTRY_STUBS`; a caller may name more.)
- Plain `.js` files under `src\` are minified where they are, with no module format, so a page's classic script keeps its global names and a module keeps its imports. `.d.ts` files go. CSS (Manor reads themes.css as text), PowerShell, JSON, SVG and the rest are as they were.
- Names are kept (`keepNames`), so stack traces in the logs, and an error's or a class's name, read as they did.
- The **README stays out** of the zip: it's for the repository. LICENSE, `kit.json` and `tools/kit.ts` (the kit's own, public) go in, as before.
- `release.json` says `"form": "minified"`. `npm run release -- --readable` builds without minifying, to look into on this PC (`"form": "readable"`); it is never published.

## Public: `Jcollier0120/Manor-releases`

`npm run release -- --publish` publishes the built release as **`<id>-v<version>`** in the releases repository, `releasesRepo()` (`porter-v0.4.26`; the repository holds every agent's releases, so the tag names the agent), with the zip, `SHA256SUMS.txt` and `manor-agent.json` when the agent announces itself. Its tag points at the releases repository's own branch, which holds only a README: the commit built is in the notes and in `release.json`.

**For now, also as `v<version>` in the agent's own repository**, as before: a Manor from before the releases repository looks there. A version already released there (before the releases repository) is published in the releases repository alone. A version the releases repository has already is refused.

**Since kit 2.32.0 the releases repository is read when a release is published, never built in** (`releasesRepo()`): `MANOR_RELEASES_REPO` when set (the Steward sets it for each release it runs), else the Steward's settings on this PC (`releasesCastellan` and `releasesRepo`). With none, as for an agent built on the kit by anyone else, `--publish` publishes `v<version>` in the agent's own repository alone, and refuses a version it has already.

Manor looks for releases, and downloads them, in the releases repository over plain HTTPS, with no sign-in; a release it doesn't find there it looks for in the agent's own repository with `gh`, as before.

## Sold: the Exchequer (`node/exchequer.ts`)

Castellan sells the staff by subscription. The **Exchequer**, Castellan's release service at `https://api.castellan-software.com` (`EXCHEQUER_URL` overrides it), hands each PC the releases its licence covers. Since kit 2.30.0, `npm run release -- --publish`, once the release is on GitHub (the releases repository, or with none the agent's own), publishes **the same files** there too:

1. `GET /api/v1/agents` (public): the agents it sells. Manor and Heiward are never published there (`NEVER_SOLD`: Manor is free and updates from GitHub; Heiward is free and AGPL), nor an agent the list leaves out.
2. `POST /api/v1/publish/<id>/<version>` with `Authorization: Bearer <the publisher's key>` and `{ commit, notes, assets: [{ name, size, sha256 }], announcement? }` (manor-agent.json's content, when the agent announces itself): a draft, and a signed upload URL for each file.
3. Each file `PUT` to its URL, with the headers given and **without** the key.
4. `POST /api/v1/publish/<id>/<version>/done`: the Exchequer checks each file's size and SHA-256, and publishes.

**The publisher's key** is `EXCHEQUER_PUBLISHER_KEY`, else `%USERPROFILE%\.steward\exchequer-publisher.key` (trimmed), on the PC that releases. It is never printed or logged. **Without it, a release of Castellan's publishes nothing** (kit 2.36.0): with a releases repository, any agent but Manor and Heiward is refused before GitHub is asked ("Not published: <id>-v<version> is Castellan's, and its releases go through the Exchequer, but this PC has no publisher key …"), and the exit code is 1. Only the PC that releases Castellan publishes its staff, so none reaches GitHub without the Exchequer. Without a releases repository (anyone else's agent), the release says "Not published to the Exchequer: no publisher key at …" and is published to its own repository alone.

**It never fails a release.** An Exchequer that is down or refuses is one line ("Not published to the Exchequer: <why>. The GitHub release stands; …"), and the exit code is GitHub's. The Steward's round shows that line as a note on a release that is done. **Every step can be done again**: a draft is made afresh, an upload replaces the file, and a version published already counts as published (`409 already-published`, `alreadyPublished`). `npm run release -- --exchequer` publishes the release GitHub already has at package.json's version (the releases repository's, else the agent's own `v<version>`, where an agent for sale has it), from GitHub's own files, and builds nothing.

**An agent for sale is published to the Exchequer alone** (kit 2.35.0). The Exchequer's agents list says which agents it sells (`forSale`, Exchequer 0.6.0; `saleOf`), and release.ts' `publishTo` follows it, with a releases repository (Castellan's own agents):

- **For sale** (`forSale: true`): the Exchequer first, from the files just built, then `v<version>` in the agent's own repository (the Steward knows a release by it). Not the public releases repository. Refused when the agent's own repository has the version already. When the Exchequer doesn't take it (down, or refusing), the release goes to the releases repository as before, so it is never missing from every place Manor looks; `--exchequer` later finishes it.
- **Not for sale** (`forSale: false`: Manor, and the agents held back from sale), or **unknown to the Exchequer**: the releases repository and the agent's own as before, then the Exchequer too, so one that goes on sale is there already.
- **The Exchequer can't say** (no answer, an error, or an answer with no `forSale`: an Exchequer from before 0.6.0, or whose database isn't migrated yet): GitHub as before. An unsure Exchequer never keeps a release from GitHub.

Without a releases repository (anyone else's agent), nothing changes: the agent's own repository, then the Exchequer when it takes the agent. Manor's own releases and setup, and Heiward's, are never published by this and stay on GitHub.

## Native files (`node/native.ts`, kit 2.62.0)

Some agents need a program that isn't Node, such as Envoy's media host (`envoy-media.exe`), which turns speech into text on the NPU. kit.json declares it, and the release builds it, signs it and carries it:

```json
"native": {"build": "native/build.ps1", "out": "native/build", "notices": ["native/NOTICES.txt"], "thumbprint": "6B654D9C34800D4307D42ACD63B925EDA5CE8D33"}
```

**The keys:**

- **`build`:** a PowerShell script in the repository.
  - `npm run release` runs it once per processor, as `-Arch arm64` and then `-Arch x64`, after emptying `<out>\<arch>\`. Nothing from an earlier build rides along.
  - It must leave that processor's files in `<out>\<arch>\`.
  - A build that fails, or leaves nothing, stops the release, with the script's last lines.
  - Its folder holds the native sources, so a change there makes a release dirty.
- **`out`:** the folder it builds into. It must be git-ignored; the release refuses one that isn't, so a build never makes the tree look changed.
- **`arch`:** which processors to build (default `["arm64", "x64"]`).
- **`notices`:** files in the repository that go with the native files, into `<out>\notices\`. Use it for the licenses of the runtimes they carry (ONNX Runtime's MIT license, .NET's).
- **`inputs`** (kit 2.92.0): files or folders outside the build script's folder that the build reads, such as a vendored runtime or a shared project. With the script's folder they are the **native sources**: a change to them makes a release dirty, and builds and signs its native files afresh (below). List every one: a change to a file the build reads that isn't listed would ship the files signed before it.
- **`thumbprint`:** the code-signing certificate's SHA-1 thumbprint, in `Cert:\CurrentUser\My`.
  - **`timestamp`** is its RFC 3161 server; the default is Certum's, `http://time.certum.pl`.
  - A release with native files is **never published unsigned**. Without a thumbprint, `--publish` is refused before anything is built, and so is it when this PC can't sign now.
  - The signer check is a real signature of a test file, timestamped as the release's will be (kit 2.92.0), so a cloud key that isn't connected, or a timestamp server that doesn't answer, is found before minutes of building, not after. A key signtool can't reach ("No certificates were found", "The specified CSP could not be found", "Keyset does not exist") is said at once; anything else is tried once more after 15 seconds.

**Signing** (`node/sign.ts`, as Manor signs its setup):

- It uses the newest Windows SDK's **x64** signtool, never its Arm64 one: a cloud key's provider (Certum's SimplySign) comes as x64 DLLs only.
- It signs each `.exe` and `.dll` whose Authenticode signature isn't Valid already, and timestamps it. A runtime's own DLLs keep their maker's signature.
- It then checks every one is Valid, the certificate's, and timestamped.
- Only a published release is signed: a local build or `--install` isn't. `release.json` says which (`"native": {"out", "arch", "signed"}`).

**Signed files kept** (`node/signed-native.ts`, kit 2.92.0):

- Once a published release has signed a processor's files, it keeps a copy in the agent's checkout data folder (`<ID>_HOME`, else `%USERPROFILE%\.<id>-dev`), under `signed-native\<key>\`, the newest two per processor.
- The key is the native sources as git has them at the commit released (each one's object id), the processor, the certificate, and the `build` and `out` kit.json names.
- A later published release with the same key takes that copy instead of building and signing that processor, once each file's SHA-256 is the one kept and `signtool verify /pa` still accepts them. It needs neither the build nor the signing key: when every processor's copy is kept, the signer check isn't made at all.
- A copy whose files don't match is let go; one whose signatures don't check out now is kept, and the release builds and signs as before. A dirty tree takes and keeps none.
- The Steward reads the same keys, so it doesn't hold a release that won't sign while this PC can't.

**One zip, both processors:**

- The zip carries `<out>\<arch>\` for each processor at the paths the checkout has them, so every Manor, the Exchequer and Castellan's setup take it as they take any release.
- Envoy's media host is about 15 MB zipped per processor.

**Installing:**

- `install` keeps only this PC's processor's folder, plus the notices. When the release has none for this PC's processor, it keeps them all and says so.
- An installed copy finds its files where its checkout does: `nativeFolder(appRoot)` is `<appRoot>\<out>\<arch>`, or null.
- **Before an update moves the app folder** (Windows won't move it while a program in it runs), install waits up to 5 seconds for the old copy's programs to end with its page, then ends those that stay. Uninstall does the same.
  - So an agent's native program should end when its page does: the page tells it to on `onStop`.
  - This only happens for a copy whose release carries native files; for any other agent, an update asks Windows nothing more.

**Third-party files:**

- What the build puts in `<out>\<arch>\` is redistributed with the agent. Carry only what its license allows inside an application, and keep its notices.
- Qualcomm's QNN runtime is licensed only "as incorporated in your application" and is revocable, so Envoy doesn't carry it: the agent fetches it from Qualcomm's own NuGet package on first use.
