# The page of an MCP staff

Some of the manor's agents are tools an AI assistant calls: Reeve, the Assayer, and any agent that serves MCP. Their pages answer the same questions in the same places, so a person who knows one knows the others. This is the layout every such page follows (kit 2.74.0 and later), taken from Reeve's page. The parts are the react part's `react/staff.tsx`; the page frame (title bar, duty, Settings, About, the theme) is `Page`'s, as on every agent.

An agent that doesn't follow it yet keeps working; its page just reads differently from the others until it does.

## The order

`StaffLayout` holds it:

1. **Needs you** (`NeedsYou`), only while something does: a card each, its edge the colour of its badge, the most urgent first, each saying what to do and with the button that does it. When nothing needs you, it goes further down or away.
2. **At a glance** (`Glance`): three to five tiles, the first thing read. Each is a number or a word ("3", "9 of 11 OK", "Nothing"), a short line of what it's made of, and its colour (`success`, `caution`, `danger`, or plain). A tile goes to its section (`to`, the section's `tour`). Typical tiles: what needs you, how the agent's own work went, what is under way, what it saved.
3. **Connect your AI** (`ConnectAI`): the agent is an MCP server. Until an AI tool is connected, the card is open: what the agent gives an AI, the one-press connect where the agent has one, each AI tool's setup as tabs, and the line for the AI's instructions. Once connected, it is one line ("✓ Your AI is connected to Reeve · Claude Code, last used 3 minutes ago") that opens again to connect another. The browser remembers the fold.
4. **Kept** (`Kept`): what the agent read on this PC so the AI didn't have to: this month, last month and all time, then what each tool read, then how it is counted. Estimates, and said to be, at about 4 characters a token and the price per million input tokens in Settings.
5. **The agent's own sections**, each a `Section` with its count in its heading and its `tour`, in the order a person needs them: what failed or waits, then the rest.

## The rules

- **A row is one line.** A list shows each item as one line (`Row`): a badge for its state, its name, the one fact that matters, when, and its buttons at the end. Its details open under it with Details; the list never opens them all at once.
- **Long output goes beside the page, never in it.** A log, a failing test's output, a stack trace, a report: a button on its row opens it in the `SidePanel` (`Output` for text as it was printed). The page never prints more than a few lines of output.
- **What's fine is one line.** A section where everything passed or nothing waits says so in a line ("All 39 pass") rather than listing each.
- **Counts in headings**, the state in a badge, the time as `ago()` says it, with the exact time in its title.
- **Developer content follows spec/DEVELOPER-OPTIONS.md**: with the switch off, the page is one plain line.
- **The kit's look**: its components and classes only, every colour a theme variable (web/themes.css), so each theme applies.

## The parts

| Part | What it draws |
|---|---|
| `StaffLayout` | The order above: `needsYou` (with `needs`), `glance`, `connect`, `kept`, then its children. |
| `NeedsYou`, `Need` | Needs you: a card each, with its `tone` (danger, caution), badge `label`, `title`, `text`, `action` and anything longer as children; `empty` when nothing does. |
| `Row` | One line of a list: `mark`, `title`, `meta`, `actions`, and `more` under it behind Details (`open` to start open). |
| `Glance`, `GlanceTile` | The tiles: `label`, `value`, `note`, `tone`, `to` (a section's tour), or an `action` button instead. |
| `ConnectAI`, `ClientSetup`, `ConnectedClient` | Connect your AI: `agent`, `connected`, `clients` or `status` for its line, `about`, `action`, `setups` (each AI tool's `where` and `text`), `instruction`, and any more as children. |
| `Kept`, `KeptStat`, `KeptRow` | Kept: `title`, `intro`, `stats`, `rows`, `counted`, `empty`, `footnote`. |
| `SidePanel`, `Output` | A panel beside the page, with a `title`, `meta` lines and Close (Escape, or a click outside, closes it too); text as it was printed. |
| `Paste` | Text to copy, with Copy. |
| `useFold(name, byDefault)` | Whether a fold is open, as this browser left it. |
| `showSection(tour)` | Scrolls to a section by its tour name. |
