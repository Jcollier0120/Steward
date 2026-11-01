# Developer options

Castellan is sold to three audiences: **general purpose** (photos, videos, documents), **gamers** (performance, stability, very large files) and **developers** (repositories, and every agent). Only developers see developer content. Developer options (`developerOptions`) say which of them this PC belongs to, and every agent obeys them: on its page, and in what its API answers. They are on while developer staff are employed, and otherwise as the person switches them in Manor's Settings, Employees: someone with no developer staff can still turn them on, to see a general agent's developer content (Heiward's, cleaning up their repositories).

This is the rule for every agent on the kit (kit 2.39.0 and later). An agent that doesn't follow it yet keeps working; it just shows its developer content to everyone until it does.

## What turns it on

- **Under Manor**, Manor's settings.json `"developerOptions"` decides. Manor keeps it `true` while any developer staff member is employed (staff.json marks them `"developer"`: Reeve, the Auditor, the Developer Herald, the Aletaster, the Pinder, the Steward), and refuses to switch it off then. With none employed, the person switches it either way in Settings, Employees, so it can be `true` with no developer staff (Manor#530, the owner's choice). The kit never second-guesses it from staff.json. A hired developer staff member holds its office, with the general staff member that can fill it on duty behind it; not hired, the general one holds it.
- **Without Manor**, or with a Manor that hasn't said, the agent's own: `"developerOptions": true` in its own settings.json. Off unless it says `true`.
- It's read afresh on every request (`node/developer.ts`): a hire, a let-go or a switch in Manor takes effect at the next request, with no agent restarted. An open page notices within seconds (`/api/ping` says `developer`) and draws itself again.
- An agent with a switch of its own shows `developerOptionsNote(setBy)` (`node/page.ts`) in its place while Manor decides: "Developer options are set in <manor>: on while developer staff are employed there, or when you turn them on", with "Change it in <manor>" linking to Manor's Settings, Employees (`manorStaffUrl`), where the switch is.
- **What a person reads** names the switch as Manor does, "Developer options", and never says they are on only while developer staff are hired (`DEVELOPER_ONLY_FORM`: "These settings can be changed only while Developer options are on.").

## What a non-developer never sees

With it off (`developerOptions` false, however it is set: no developer staff employed and the person's switch off; "the switch" below), none of this is on an agent's page, in its notices, or in what its API sends the page:

- repositories, git and GitHub, branches, commits, pull requests, CI, releases as builds, build outputs, worktrees and checkouts;
- ports, PIDs, process names and command lines;
- the model servers' insides: GenieX, llama.cpp and llama-server, QNN, execution providers, model names and quantisations, endpoints;
- logs, stack traces, exit codes and raw error messages;
- JSON, settings.json and its keys;
- file and folder paths (the person's own choices, like a folder they picked to watch, are theirs to see);
- command-line commands, PowerShell, WMI, winget, pnputil, FFmpeg and other tools by name;
- checksums and hashes (SHA-256);
- the hardware that wrote a model's words: the NPU, a graphics card or the processor by name, or a chip's (kit 2.97.1). Where an agent's work runs is said in plain words instead (`node/work.ts`, below).

Say it in plain words instead. Reeve's model and its servers are **the local AI**, and a model's note is labelled with the staff member's own word and name, "summary from the Herald" (`noteLabel(from)`), wherever it ran. A failure says what didn't happen, what the agent does next, and what the person can do, if anything: "The local AI couldn't start. It tries again in a minute." Never the error itself.

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

**Settings** (`node/settings-kit.ts`, kit 2.40.0) take the switch from the schema itself, written once, in full: no getter, and no fix-up around a save. The kit serves `/api/settings` for whoever is looking at each request (`schemaFor`, `valuesFor`).

- `developerOnly: true` on a field: left out of the schema and the values with the switch off, at the top level, in a group, or in a list of records. A save then keeps its stored value as it was, so turning the switch on again finds it unchanged. Each record with a field left out carries a handle (`KEPT`) in its place, by which the save finds the record's hidden values; a new record whose hidden fields are needed can't be added then.
- `developerOnly: true` on a choice's option (`choice` or `choices`): not offered with the switch off, not among the values sent, and kept through a save as settings.json had it.
- `plain: { label, help, patternHint, placeholder }` on a field: its words while the switch is off.
- `developerOnly: true` on the whole `SettingsSpec` (a developer role's form, all about its work), or every field `developerOnly`: with the switch off, `/api/settings` says `developerOnly` with no field, both panels leave the form out (no empty form, no card), and a save is refused (`DEVELOPER_ONLY_FORM`).

**Developer-only features** (a repository's checks, a code review, tools for an agent's own makers) are off and out of sight while the switch is off: not shown, not run on a schedule, not on by default.

## What the kit does already

- **Where its work runs** (`node/work.ts`) is in plain words when off: the local AI for Reeve, the AI chip for the NPU, each line's `plain` wording, no developer-only line (`dev: true`), and no tool, server, chip maker or Task Manager graph by name. A developer role's agent (`developerRole`: the Auditor, the Developer Herald, the Aletaster, the Pinder, the Steward, the Toller, the Assayer, the Seneschal), whose work doesn't run while the switch is off, has no section then at all.
- **A model's note** (`core/messages.js`, kit 2.148.1): `noteLabel(from)` is what it is and which staff member wrote it, "summary from the Herald" (`theName(APP.name)`: "the Herald", but Reeve and Heiward by name), whatever ran it; a staff member whose notes aren't summaries passes its own word, `noteLabel(from, developer, 'caption')`. `noteLabel(from, true)` adds where it was written ("summary from the Herald, written on the NVIDIA GeForce RTX 4090", or "…, written by a local model" for a note that doesn't say) for a developer's view or a log. `page.ts`'s `unverified(text, from, developer, what)` reads the switch itself, and its hover says "Written by the local AI. Check it against the facts beside it." when off. `theAccelerator(a)` names the hardware, so it's for developers' views, logs and the kit's messages, never for what everyone reads. Before 2.148.1 the label was "note from the local AI, unverified" (kit 2.97.1).
- **The footer** names the agent's data folder only when on; `PageShell.dataDir` is empty when off.
- **Settings** (`/api/settings`): the settings.json path (`file`) is empty when off, and its problems are one plain line (`PLAIN_PROBLEM`); a save refused by the agent's own rules says `PLAIN_REFUSAL`. Both settings panels say "Changes are checked and saved here" without a path.
- **`/api/ping`** says `developer`, so an open page draws itself again when it flips. It sends the page's process id (`pid`) only while on (kit 2.40.0): the Pinder, a developer role, knows an agent by the port it listens on first.

Tests: `kit/test/developer.test.ts`, and both ways in `work.test.ts`, `settings-kit.test.ts`, `settings-developer.test.ts`, `react-settings.test.ts` and `react-page.test.ts`.
