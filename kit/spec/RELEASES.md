# Releases: built, and public

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/RELEASES.md` in the Steward's repository, and `src/kit/spec/RELEASES.md` in every agent that takes the part. Since kit 2.17.0.

The agents' source stays in their private repositories. What a PC installs is a **built** release, published in one **public** repository, [Jcollier0120/Manor-releases](https://github.com/Jcollier0120/Manor-releases), so any PC downloads it without signing in to GitHub, and nobody reads the source from it.

## Built: `node/minify.ts`

`npm run release` (the kit's `release.ts`) stages what the release carries, then builds it with esbuild, an exact devDependency of every kit agent (esbuild 0.28.2):

- Each `.ts` file under `src\` (the agent's own and `src\kit\`) is minified **on its own**: it is esbuild's entry point (ESM, Node 22, `keepNames`) with every import left outside it, and an import of another relative `.ts` (static, dynamic or `export ... from`) pointing at its `.js`. esbuild's own parser finds them, never a text search, so an import written inside a string stays as it is. Imports stay as written (`verbatimModuleSyntax`): one kept only for what loading it does stays, and `import type` goes. It is written as a `.js` beside where it was, and the `.ts` goes. Every module stays in its folder, so whatever it finds next to itself (`import.meta.url`, `import.meta.dirname`: the kit's web part, a PowerShell script, rules.json) is where it was.
- **`src\cli.ts` stays, as a one-line stub** that imports `./cli.js`: installers, Task Scheduler's tasks and Manor's staff list start an agent as `node src\cli.ts`. The kit's `service.ts` starts the page through it too, so its command line still says `cli.ts` (Pinder and the Surveyor know the manor's agents by it). (`ENTRY_STUBS`; a caller may name more.)
- Plain `.js` files under `src\` are minified where they are, with no module format, so a page's classic script keeps its global names and a module keeps its imports. `.d.ts` files go. CSS (Manor reads themes.css as text), PowerShell, JSON, SVG and the rest are as they were.
- Names are kept (`keepNames`), so stack traces in the logs, and an error's or a class's name, read as they did.
- **A release whose code imports a file it doesn't carry isn't built** (kit 2.146.5, `importsLeftOut`), readable or not, by the kit's release and by any release that calls `minifyRelease` (Manor's, Reeve's): `Not built: its code imports what the release doesn't carry, ...`, naming each file and the one it imports. The installed agent would stop there with `ERR_MODULE_NOT_FOUND`, as Reeve 0.19.10 and 0.19.11 did on every PC (`src/assistants.ts` imported `src/web/ps-arg.ts`, which `releasePage` leaves out). Read by esbuild's parser, before anything is built, from every `.ts` and `.js` the build reads: a static `import`, an `export ... from` and an `import()` of a literal count; `import type` and `export type` don't. `import { type A } from` counts too, as Node and the built release keep it (`import './a.js'`). Only relative imports are looked at. A release doesn't carry tests, documents, `.d.ts` files, anything outside `src\` and `art\` but its few top-level files, and, with a React page, `src\web\` but `page.js` and the kit's `react\` part.
- The **README stays out** of the zip: it's for the repository. LICENSE, `kit.json` and `tools/kit.ts` (the kit's own, public) go in, as before.
- **No document goes** (kit 2.134.0, `isDoc`): not a `.md` anywhere in the zip, the kit's own pages in `src\kit\spec\` and the READMEs beside its vendored builds included. They're for whoever works on the agent, and nothing reads them at run time (the spec part's `.json` files still go). A license or notice file written as `.md` (`LICENSE.md`) still goes.
- **`CHANGELOG.md` goes, cut to its newest 20 entries** (kit 2.143.0, notes.ts's `releaseChangelog`): its opening and those entries, at the zip's top level, which the About view's **What's new** reads (`node/whats-new.ts`). The whole history (hundreds of KB) stays in the repository.
- **`THIRD-PARTY-NOTICES.txt`** goes at the zip's top level (kit 2.134.0), below.

## Notices: `node/notices.ts`

Every release carries `THIRD-PARTY-NOTICES.txt`, made by `release.ts` from what the zip carries, never by hand, as Manor's release makes its own. A part is something someone else made, under its heading between two lines of `=`, with where the release carries it, its license, and the license and notice files its maker asks to be kept with every copy:

- **The npm packages bundled into the page** (react, react-dom, scheduler...), from esbuild's own list of what `releasePage` took from `node_modules` (its metafile), each with its license files from `node_modules`. The bundle leaves their license comments out, so this file is where they're kept.
- **Each folder the zip carries with license or notice files of its own** (`isLicenseFile`: `LICENSE`, `NOTICE`, `COPYING`, `third-party-programs.txt`...), but the agent's own top level and `src\kit\` (the kit's MIT license): the kit's build of GenieX's plugin (`src\kit\geniex`), OpenVINO GenAI's notice (`src\kit\openvino`). Their files are copied in whole.
- **The native files' notices**, kit.json's `native` `notices` (below).

**A release that carries something of others' with no notice for it isn't built** (`Not built: it carries what others made with no notice for it: ...`):

- a bundled npm package with no license file in its folder;
- a program, library or font (`.dll`, `.exe`, `.node`, `.wasm`, `.woff`/`.woff2`, `.ttf`, `.otf`) with no license or notice file in its folder or one above it, outside the kit's own builds (`src\kit\prebuilt`, built from the kit's own sources);
- native files when kit.json's `native` lists no `notices`.

Put the maker's license (and a `NOTICE` saying what you changed, for a modified build) beside what you carry.
- `release.json` says `"form": "minified"`. `npm run release -- --readable` builds without minifying, to look into on this PC (`"form": "readable"`); it is never published.
- A published release's `release.json` says whether the Exchequer sells the agent, as its list says then (`"sold": true` or `false`, from `saleOf`; kit 2.110.0). Since kit 2.113.0 the license check (license-check.ts) doesn't read it: every agent but Manor and Heiward needs a license for its PC, sold or not. When the Exchequer can't say, there's no `sold`.

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
- **`notices`:** files in the repository that go with the native files, into `<out>\notices\`. Use it for the licenses of the runtimes they carry (ONNX Runtime's MIT license, .NET's). Since kit 2.134.0 they're also copied into `THIRD-PARTY-NOTICES.txt`, and a release whose native files have none isn't built (Notices, above).
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

## Signed scripts (`node/signed-scripts.ts`, kit 2.123.0)

Smart App Control, and any Windows that enforces App Control for scripts, runs a PowerShell script it can't trust in Constrained Language Mode, where `Add-Type` and most .NET calls stop. A script signed with a certificate Windows trusts runs as written. So a **published** release signs every `.ps1`, `.psm1` and `.psd1` it ships, the way it signs native files: Authenticode, SHA-256, an RFC 3161 timestamp, the newest Windows SDK's **x64** signtool.

**Which certificate:**

- kit.json's `native.thumbprint`, when it has one.
- Else, on the PC that releases Castellan (a releases repository), the owner's (`prebuilt.ts`' `SIGNED_BY`).
- Else none: anyone else's agent ships its scripts unsigned, and the build says so.
- A local build or `--install` signs nothing, as with native files.

**When the key can't be reached:**

- When a script has no signed copy kept (below), the signer check (a timestamped test signature) runs before anything is built.
- If this PC can't sign, the release isn't built: `Not published: its scripts can't be signed: ...`. The Steward knows those words and waits, as it does for native files.
- A release from the PC that releases Castellan is never published with unsigned scripts.

**What ships is what was signed:**

- Signing appends a signature block (`# SIG # Begin signature block` … `# SIG # End signature block`) and changes nothing before it. Any later change to the script breaks its signature.
- Scripts are signed last, after everything else is staged. After zipping, the release unpacks the scripts from the zip and checks each one's SHA-256 against what was signed. Any difference stops the release.
- An install and the kit's copy into `src\kit\` copy files as they are, so the signatures stay valid on the PC that installs them.
- A staged `.json` that lists a script's SHA-256 gets the signed script's hash instead, so an installer that checks scripts against it accepts them. Example: a guard's `manifest.json`, which its `install-guard.ps1` checks before copying. An agent's page that compares a guard's installed scripts with the release's will ask once to update the guard.
- A script that already carries a Valid signature is its maker's, and ships as it is. A script whose signature no longer checks out loses that signature and is signed again.

**Signed copies kept:**

- Every signed script is kept in one store for every agent on this PC (`KIT_SIGNED_SCRIPTS`, else `%USERPROFILE%\.steward\signed-scripts`). It's keyed by the certificate and the script's text, with plain line ends.
- A later release takes the kept copy when the copy is exactly that script plus its signature block, and the signature is still Valid, the certificate's and timestamped. Most releases then need no key: the kit's scripts are the same in every agent.
- A copy no release has taken for 90 days is removed.
- The Steward reads the same keys, so a release whose scripts are all kept isn't held while this PC can't sign.
