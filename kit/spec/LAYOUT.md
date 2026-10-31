# A page's layout at three widths

> **This page's home is the Steward's kit**, its `spec` part: `kit/spec/LAYOUT.md` in the Steward's repository, and `src/kit/spec/LAYOUT.md` in every agent that takes the part. Since kit 2.147.0.

An agent's page is seen on a phone, on a 1080p desktop and on a 2K or 3K screen. Stacking every section down one column wastes a wide screen, so each page is laid out for three widths, each its own layout. Things may move between them; each should look right at its own width.

| Width | From (CSS px) | Where | Layout |
| --- | --- | --- | --- |
| narrow | 0 | a phone, or a window under 1200 px | one column, as before |
| desktop | 1200 (`DESKTOP_FROM`) | a 1080p screen | sections side by side, usually two |
| wide | 2000 (`WIDE_FROM`) | a 2K or 3K screen | more side by side, usually three; tabs can open side by side |

The widths are CSS pixels. Windows' display scaling divides a screen's own pixels, so a 2K screen at 125% is 2048 px wide, which counts as wide. A 1080p screen's maximised window is about 1900 px, which counts as desktop.

## The parts (react/layout.tsx)

- **`Columns`** puts sections side by side: `desktop` columns at desktop (1 to 3, default 2), `wide` columns at wide (1 to 4, default 3), and one column when narrow. Children fill the row in order, each at the top of its row. `weights="2 1"` makes the columns unequal at desktop and wide, for a main part with something narrower beside it. It's CSS only: it holds before the page's script runs, and as the window is resized.
- **`Span`** is a part of `Columns` that takes more of its row. `cols="all"` takes the whole row at every width, for a table that wants the page's width. `cols={2}` takes two columns where the row has three or four, and the whole row where it has two.
- **`PageTabs` `side`**: from that width up (`'wide'`, or `'desktop'`), the tabs are drawn side by side, a column each under its name, with no tab strip. Narrower, they stay tabs. It suits two to four tabs of moderate length. A tab with a wide table is better left as a tab.
- **`useWidth()`** gives `'narrow' | 'desktop' | 'wide'`, kept as the window is resized, for a page that changes more than its columns. It is `'desktop'` while drawn on the server.

## How to lay a page out

1. **What matters first stays first, across the whole width**: Needs you, the glance tiles, a driver on trial, anything waiting for the person.
2. **Then the page's parts in `Columns`**: status and its controls beside the details they act on, small sections beside each other. Put the part people use most on the left; it's the one that comes first when narrow.
3. **Long or wide content takes the row** (`Span cols="all"`): a long table, a log, a timeline that reads better wide.
4. **Tabs open side by side when wide** (`side="wide"`) when there are two to four and each fits a third of a 2K screen.
5. **Narrow is one column, in reading order.** Columns does that by itself; check the order reads well top to bottom.
6. **Check it at all three widths**: about 375 px, about 1900 px and about 2500 px.

```tsx
import { Columns, PageTabs, Section, Span } from '../kit/react/index.ts';

<Glance tiles={tiles} />
<Columns desktop={2} wide={3}>
  <Section title="Status">…</Section>
  <Section title="This PC">…</Section>
  <Section title="Accelerators">…</Section>
  <Span cols="all">
    <Section title="History">…</Section>
  </Span>
</Columns>
<PageTabs tabs={tabs} side="wide" />
```
