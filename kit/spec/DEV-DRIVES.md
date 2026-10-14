# Dev Drives and linked folders: every path compared by its real path

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/DEV-DRIVES.md` in the Steward's repository, and `src/kit/spec/DEV-DRIVES.md` in every agent that takes the part. Since kit 2.73.1.

A developer's folders often live somewhere other than where they're named. The Pinder walks developers onto a Dev Drive (its 0.6.0), and Windows then reaches the old folder through a junction, or mounts the whole drive in a folder: `C:\Projects` is `D:\`, `C:\DevData` is `E:\`, and `%TEMP%` (`C:\DevData\Temp`) is `E:\Temp`. Symbolic links and junctions made by hand do the same. All of it is supported: an agent works the same in a linked folder as in a plain one.

## Why it breaks

One folder has two spellings, and different parts of the system give different ones:

| Gives the real path (`E:\...`) | Gives the path as it was named (`C:\DevData\...`) |
|---|---|
| `import.meta.url` of the script node was started with, and `__dirname` | `process.argv[1]`, `process.cwd()`, `os.tmpdir()`, `os.homedir()` |
| `git worktree list`, `git rev-parse --show-toplevel`, `--git-dir`, `--git-common-dir` | a setting, a path in a config file, a command-line argument |
| `fs.realpathSync`, `fs.realpathSync.native` | `path.resolve`, `path.join`, `path.normalize` |

Compare a path from one column with a path from the other and they never match. Nothing throws: the code takes the "not the same" branch every time.

What it cost, on the owner's PC, from 2026-10-13 to 10-14:

- **Releases did nothing.** Kit 2.69.1's `release.ts` started only when `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`. Run from the Steward's work folder (a junction to the Dev Drive), the two differed, so it exited 0 without building or publishing anything, and every round reported its agents released. Reeve's own `tools/release.ts` had the same check.
- **Worktrees were left registered.** Git records a worktree by its real path. The Steward named it through the junction, so it never found it again to remove, and the next `git worktree add` refused: "a missing but already registered worktree", every other round.
- **Tests failed.** A test that makes a temporary folder with `mkdtempSync(os.tmpdir())` and compares it with what git or a script reports saw `C:\DevData\Temp\...` against `E:\Temp\...`.

## The rules

1. **Compare paths only by their real paths**, both sides through the same function, and without regard to case on Windows.
   - Against git's paths, or any time a drive may be mounted in a folder, use `fs.realpathSync.native`: it gives the drive letter (`E:\...`), as git does. Plain `fs.realpathSync` follows junctions and links but stops at a drive mounted in a folder (`C:\DevData\...`).
   - Against `import.meta.url`, which node makes with plain `fs.realpathSync`, use that (rule 2).
   - For a path that may not exist yet, resolve the deepest part that does and keep the rest (the Steward's `realOf` in `src/git.ts`, the kit's `realPlace` in `node/manor.ts`, Reeve's `realPath`).
   - Leave a share (`\\server\...`) as it is: resolving it can wake WSL.
2. **A script's run-as-itself check** is always:
   ```ts
   if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) { ... }
   ```
   never `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, and never the `pathToFileURL(...).href === import.meta.url` form without `realpathSync`.
3. **Work where git and node look.** A folder an agent makes worktrees in, or runs scripts from, is taken by its real path once, where it's read from settings (the Steward's `workRootOf`). Everything under it then agrees with git and with `import.meta.url`.
4. **Tests take their temporary folder by its real path**: `realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'x-')))`. A developer's `%TEMP%` may well be on a Dev Drive.
5. **Never key on a path's spelling.** A map of folders, a "this folder is inside that one" check, or a `startsWith` on paths: real paths, both sides.
6. **A command that should have made something is checked for it.** A release command that exits 0 must have made its GitHub release (the Steward checks since 0.36.17). An exit code alone said "released" for a day while nothing went out.

## Advising a Dev Drive

When the Pinder (or anyone) moves a developer's folders onto a Dev Drive:

- **Give the Dev Drive a drive letter, and keep it** (the Pinder 0.6.2). Settings that name a folder on it are better written with the letter (`E:\steward-work`) than through the junction left behind.
- **Agents on kit 2.71.1 or later run their release from a linked folder.** An agent on an older kit releases only from a folder named by its real path. The Steward's work folder is taken by its real path since Steward 0.36.17, whatever its setting says.
- **Expect the old spellings to keep working** for people and programs that only read and write files there. It's code that compares paths that has to follow these rules.
