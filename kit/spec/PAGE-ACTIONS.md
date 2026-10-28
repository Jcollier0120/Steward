# A page's actions

A button on an agent's page that does something (saves, runs, removes, starts a job) is an action. While its action runs, the whole page waits: the button pressed shows a spinner, every control on the page is disabled, the cursor is the busy one, and the page says `aria-busy`. So nothing is pressed twice, and nothing is pressed meanwhile on what the action is changing. When the action is done, failed, was refused or took too long, the page is usable again and focus is back where it was.

The kit does this for every page drawn with its `Page` (kit 2.144.0, `react/page-busy.ts`), for the buttons below. A page writes its actions with them and needs nothing of its own.

## An action button

One of these, never a bare `<button onClick>` with a `fetch` of its own:

| Button | When |
|---|---|
| `PostButton` | A POST to the agent's server, then the page looks for news. `confirm` asks first, in the page's own dialog. |
| `Button` with `onPress` | Anything else: `onPress` returns the promise of its work, and the page waits until it settles. |
| `BusyButton` with `onClick` | The same, for a button in the page's own classes. |

The work POSTs with the kit's `post()`, which carries the page's token and recovers from a restart (kit 2.143.3). A `post()` a press started holds the page by itself, and spins the button pressed: so a page's own `<button onClick>` whose handler awaits `post()` is held too, even when it doesn't return its promise. A `fetch` of the page's own is not: the page goes on as if nothing ran.

The page's own questions are `confirmDialog` and `alertDialog`, never the browser's `confirm()` and `alert()`.

## What holds the page, and what doesn't

- **Held:** the promise a kit button's press returned (`Button`'s `onPress`, `BusyButton`'s `onClick`, `PostButton`'s POST and the look for news after it), and a `post()` made within ten seconds of a press (a click on a button, a link, a switch or a box, a form's submit, a choice in a list), with no typing in between. A press whose handler first asks (`confirmDialog`, even the browser's `confirm()`) still counts.
- **Not held:** polling (`usePageData`'s looks for news, `/api/ping`), a `post()` no press started (one sent as someone types, or on a timer), a `fetch` of the page's own, and a button's `loading` or `busy` (the page's own word that work runs: it spins that button only).
- **Long work** holds the page only until its request answers, never until the work ends: Run now, a job started, a stream. The work's progress is the page's to show. Work that can't go through `post()` (a streamed answer) holds the page with `holdPage()` until its request answers, then lets go.
- **At most 30 seconds** (`PAGE_WAIT_MS`; `pageWait(ms)` sets another): a request that doesn't answer lets the page go, while its button still spins.

## What stays usable

- **A dialog the action opens** while it runs: a question it asks, a sign-in it needs (`ModalCard`, `SidePanel`, `confirmDialog`, `alertDialog`). A dialog that was open before the action began waits with the page, like the rest of it. A dialog of the page's own making (not the kit's) is not known to the kit: it waits with the page, so an action mustn't open one.
- **The title bar's way out:** Back to Manor, the agent's name, About, Settings and the Theme menu. They never act on the agent, and someone waiting on a request that doesn't answer can always leave. The title bar's own action (Run now) waits with the page.
- **The out-of-date banner's Reload**, which mends a page whose agent restarted.

Links and pressable cards in the page take no presses while it waits either, though the browser doesn't draw them disabled.

## Nested waits

A `BusyArea` still disables its part of the page while work in it runs, as before, inside the page's own. A string-built page (page.ts) keeps its own: a button's form or card waits, not the whole page.
