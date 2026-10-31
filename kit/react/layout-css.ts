/**
 * The widths a page is laid out for (layout.tsx) and their styles (Columns, Span, PageTabs' `side`), apart from the
 * components so styles.ts takes them without React.
 */

/** Where desktop starts, in CSS pixels: a 1080p screen's window, with room for two columns. */
export const DESKTOP_FROM = 1200;
/** Where wide starts: a 2K or 3K screen's window, with room for three. */
export const WIDE_FROM = 2000;

const query = (px: number) => `(min-width: ${px}px)`;

/**
 * The rule for each count of columns, inside a width's media query. Each is also as specific as the weights at the
 * width before (.ui-cols.ui-weighted:is(…)), so a weighted grid with one column when wide (wide={1}) is one column
 * there, not its desktop weights.
 */
const counts = (prefix: 'd' | 'w', n: number[]) => n.map((k) => `.ui-cols.ui-${prefix}${k}, .ui-cols.ui-weighted.ui-${prefix}${k} { grid-template-columns: repeat(${k}, minmax(0, 1fr)); }`).join('\n  ');

/** Columns' and Span's styles, and PageTabs' `side`: part of UI_CSS. */
export const LAYOUT_CSS = `
/* Columns is spaced as a section is (22 px above it) and its rows as sections are, by its row gap; so its cells' first
   parts start at their row's top, and a Columns first in a tab starts at the tab's top, as a Section does. */
.ui-cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px 20px; align-items: start; margin-top: 22px; }
.ui-cols > * { min-width: 0; }
.ui-cols > .ui-span-all { grid-column: 1 / -1; }
.ui-cols > :is(.ui-section, .card, h2, h3), .ui-cols > * > :is(.ui-section, .card, h2, h3):first-child { margin-top: 0; }
.tab-panel > .ui-cols:first-child, .tab-panel > .ui-side-title + .ui-cols { margin-top: 0; }
@media ${query(DESKTOP_FROM)} {
  ${counts('d', [1, 2, 3])}
  .ui-cols.ui-weighted:is(.ui-d2, .ui-d3) { grid-template-columns: var(--ui-weights); }
  .ui-cols.ui-d2 > .ui-span-2 { grid-column: 1 / -1; }
  .ui-cols.ui-d3 > .ui-span-2 { grid-column: span 2; }
}
@media ${query(WIDE_FROM)} {
  ${counts('w', [1, 2, 3, 4])}
  .ui-cols.ui-weighted:is(.ui-w2, .ui-w3, .ui-w4) { grid-template-columns: var(--ui-weights); }
  .ui-cols.ui-w1 > .ui-span-2 { grid-column: auto; }
  .ui-cols.ui-w2 > .ui-span-2 { grid-column: 1 / -1; }
  .ui-cols:is(.ui-w3, .ui-w4) > .ui-span-2 { grid-column: span 2; }
}
.ui-side-title { display: none; margin: 0 0 8px; }
/* Under its title, a side-by-side tab's first part starts at once, as it does at the top of a tab. */
.tab-panel > .ui-side-title + :is(h2, h3, .ui-section, .card) { margin-top: 0; }
@media ${query(DESKTOP_FROM)} {
  .ui-tabs-side-desktop > .tabs { display: none; }
  .ui-tabs-side-desktop > .ui-side-panels { display: grid; grid-template-columns: repeat(var(--ui-tabs), minmax(0, 1fr)); column-gap: 20px; align-items: start; margin-top: 22px; }
  .ui-tabs-side-desktop > .ui-side-panels > .tab-panel[hidden] { display: block; }
  .ui-tabs-side-desktop .ui-side-title { display: block; }
}
@media ${query(WIDE_FROM)} {
  .ui-tabs-side-wide > .tabs { display: none; }
  .ui-tabs-side-wide > .ui-side-panels { display: grid; grid-template-columns: repeat(var(--ui-tabs), minmax(0, 1fr)); column-gap: 20px; align-items: start; margin-top: 22px; }
  .ui-tabs-side-wide > .ui-side-panels > .tab-panel[hidden] { display: block; }
  .ui-tabs-side-wide .ui-side-title { display: block; }
}
`;
