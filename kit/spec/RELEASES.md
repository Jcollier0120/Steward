# Releases: built, and public

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/RELEASES.md` in [Jcollier0120/Steward](https://github.com/Jcollier0120/Steward). Since kit 2.16.0.

The agents' source stays in their private repositories. What a PC installs is a **built** release, published in one **public** repository, [Jcollier0120/Manor-releases](https://github.com/Jcollier0120/Manor-releases), so any PC downloads it without signing in to GitHub, and nobody reads the source from it.

## Built: `node/minify.ts`

`npm run release` (the kit's `release.ts`) stages what the release carries, then builds it with esbuild, an exact devDependency of every kit agent:

- Each `.ts` file under `src\` (the agent's own and `src\kit\`) is minified **on its own** (esbuild's `transformSync`: ESM, Node 22, `keepNames`) and written as a `.js` beside where it was; its imports of other `.ts` files (`from './x.ts'`, `import('./x.ts')`, `new URL('./x.ts', import.meta.url)`) point at their `.js`. The `.ts` goes. Every module stays in its folder, so whatever it finds next to itself (`import.meta.url`, `import.meta.dirname`: the kit's web part, a PowerShell script, rules.json) is where it was.
- **`src\cli.ts` stays, as a one-line stub** that imports `./cli.js`: installers, Task Scheduler's tasks and Manor's staff list start an agent as `node src\cli.ts`. (`ENTRY_STUBS`; a caller may name more.)
- `.js` and `.css` files under `src\` are minified where they are; `.d.ts` files go. PowerShell, JSON, SVG and the rest are as they were.
- Names are kept (`keepNames`), so an error's, a class's and a function's name read as they did.
- The **README stays out** of the zip: it's for the repository. LICENSE, `kit.json` and `tools/kit.ts` (the kit's own, public) go in, as before.
- `release.json` says `"form": "minified"`. `npm run release -- --readable` builds without minifying, to look into on this PC (`"form": "readable"`); it is never published.

## Public: `Jcollier0120/Manor-releases`

`npm run release -- --publish` publishes the built release as **`<id>-v<version>`** in `RELEASES_REPO` (`porter-v0.4.24`; the repository holds every agent's releases, so the tag names the agent), with the zip, `SHA256SUMS.txt` and `manor-agent.json` when the agent announces itself. Its tag points at the releases repository's own branch, which holds only a README: the commit built is in the notes and in `release.json`.

**For now, also as `v<version>` in the agent's own repository**, as before: a Manor from before the releases repository looks there. A version already released there (before the releases repository) is published in the releases repository alone. A version the releases repository has already is refused.

Manor looks for releases, and downloads them, in the releases repository over plain HTTPS, with no sign-in; a release it doesn't find there it looks for in the agent's own repository with `gh`, as before.
