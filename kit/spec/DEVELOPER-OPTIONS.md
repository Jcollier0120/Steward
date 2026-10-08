# Developer options

Castellan is sold to three audiences: **general purpose** (photos, videos, documents), **gamers** (performance, stability, very large files) and **developers** (repositories, and every agent). Only developers see developer content. Manor's **Developer options** switch says which of them this PC belongs to, and every agent obeys it: on its page, and in what its API answers.

This is the rule for every agent on the kit (kit 2.39.0 and later). An agent that doesn't follow it yet keeps working; it just shows its developer content to everyone until it does.

## The switch

- **Under Manor**, Manor's settings.json `"developerOptions"` (the switch on Manor's Settings page) decides. On, Manor's developer roles are held (Reeve, the Auditor, the Developer Herald, the Aletaster, the Pinder, the Steward); off, they're vacant and general twins hold their offices.
- **Without Manor**, or with a Manor that hasn't said, the agent's own: `"developerOptions": true` in its own settings.json. Off unless it says `true`.
- It's read afresh on every request (`node/developer.ts`): flipping it in Manor takes effect at the next request, with no agent restarted. An open page notices within seconds (`/api/ping` says `developer`) and draws itself again.
- An agent with a switch of its own shows `developerOptionsNote(setBy)` (`node/page.ts`) in its place while Manor decides.

## What a non-developer never sees

With the switch off, none of this is on an agent's page, in its notices, or in what its API sends the page:

- repositories, git and GitHub, branches, commits, pull requests, CI, releases as builds, build outputs, worktrees and checkouts;
- ports, PIDs, process names and command lines;
- the model servers' insides: GenieX, llama.cpp and llama-server, QNN, execution providers, model names and quantisations, endpoints;
- logs, stack traces, exit codes and raw error messages;
- JSON, settings.json and its keys;
- file and folder paths (the person's own choices, like a folder they picked to watch, are theirs to see);
- command-line commands, PowerShell, WMI, winget, pnputil, FFmpeg and other tools by name;
- checksums and hashes (SHA-256).

Say it in plain words instead. Reeve's model and its servers are **the local AI**. A failure says what didn't happen, what the agent does next, and what the person can do, if anything: "The local AI couldn't start. It tries again in a minute." Never the error itself.

## How an agent obeys it

**Gate the data, not just the page.** What a non-developer may not see is left out of what the server sends: hiding it in the browser alone isn't enough. In `node/developer.ts`:

- `developer()` and `isDeveloper()`: the switch now (`{ on, setBy }`). Call them per request, never once at start.
- `developerOnly(value, fallback?)`: `value` when on (a function is called only then, so the data isn't even worked out), else `fallback`.
- `withoutDeveloper(payload, keys)`: the payload with those fields gone, at any depth, when off.
- `failureFor(error, plain)`: the error's message for a developer, the agent's plain words for everyone else.

```ts
json: {
  rounds,
  log: developerOnly(() => tail(logFile)),
  servers: withoutDeveloper(servers, ['pid', 'port', 'model', 'endpoint']),
  error: failure && failureFor(failure, "The scan didn't finish. It tries again at the next round."),
}
```

**Then hide it in the page.** A React page (`react/developer.tsx`, from `react/index.ts`):

- `useDeveloper()`: the switch, from the page's data (`PageShell.developer`); off outside a `<Page>`.
- `<DeveloperOnly fallback={…}>`: its children only while on; the fallback (plain words, or nothing) otherwise.

A string-built page reads `isDeveloper()` as it draws.

**Developer-only features** (a repository's checks, a code review, tools for an agent's own makers) are off and out of sight while the switch is off: not shown, not run on a schedule, not on by default.

## What the kit does already

- **Where its work runs** (`node/work.ts`) is in plain words when off: the local AI for Reeve, each line's `plain` wording, no developer-only line (`dev: true`), and no tool or server by name.
- **The footer** names the agent's data folder only when on; `PageShell.dataDir` is empty when off.
- **Settings** (`/api/settings`): the settings.json path (`file`) is empty when off, and its problems are one plain line (`PLAIN_PROBLEM`); a save refused by the agent's own rules says `PLAIN_REFUSAL`. Both settings panels say "Changes are checked and saved here" without a path.
- **`/api/ping`** says `developer`, so an open page draws itself again when it flips.

Tests: `kit/test/developer.test.ts`, and both ways in `work.test.ts`, `settings-kit.test.ts` and `react-page.test.ts`.
