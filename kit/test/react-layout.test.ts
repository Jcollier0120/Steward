import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DESKTOP_FROM, LAYOUT_CSS, WIDE_FROM } from '../react/layout-css.ts';
import { UI_CSS } from '../react/styles.ts';

// A page laid out at three widths (react/layout.tsx, spec/LAYOUT.md): Columns, Span, PageTabs' side and useWidth,
// rendered with react-dom/server, and the styles that lay them out.
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { bundleForNode, importPath } = await import('./react-render.ts');

const ui = await bundleForNode<{ html: Record<string, () => string>; widthAt: (px: number | null) => string }>(
  `import { renderToStaticMarkup as r } from 'react-dom/server';
   import { Columns, PageTabs, Section, Span, widthNow } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   const tabs = [
     { id: 'drivers', label: 'Graphics drivers', count: 2, content: <Section title="Graphics drivers"><p>cards</p></Section> },
     { id: 'points', label: 'Restore points', content: <p>points</p> },
   ];
   export const html = {
     cols: () => r(<Columns><Section title="One"><p>1</p></Section><Section title="Two"><p>2</p></Section></Columns>),
     some: () => r(<Columns desktop={3} wide={4} className="mine"><p>a</p></Columns>),
     weighted: () => r(<Columns weights="2 1"><p>a</p><p>b</p></Columns>),
     spans: () => r(<Columns><Span><p>all</p></Span><Span cols={2}><p>two</p></Span></Columns>),
     tabs: () => r(<PageTabs tabs={tabs} />),
     side: () => r(<PageTabs tabs={tabs} side="wide" />),
   };
   export function widthAt(px) {
     globalThis.matchMedia = px === null ? undefined : (q) => ({ matches: px >= Number(/(\\d+)px/.exec(q)[1]) });
     return widthNow();
   }`,
  { location: { hash: '' } },
);
const h = ui.html;

test('Columns: a grid with its counts at desktop and wide, each child a cell; weights as a style', () => {
  assert.equal(h.cols(), '<div class="ui-cols ui-d2 ui-w3"><section class="ui-section ui-gap-md"><div class="ui-section-head"><div class="ui-section-name"><h2>One</h2></div></div><p>1</p></section><section class="ui-section ui-gap-md"><div class="ui-section-head"><div class="ui-section-name"><h2>Two</h2></div></div><p>2</p></section></div>');
  assert.match(h.some(), /^<div class="ui-cols ui-d3 ui-w4 mine">/);
  assert.match(h.weighted(), /class="ui-cols ui-d2 ui-w3 ui-weighted" style="--ui-weights:minmax\(0, 2fr\) minmax\(0, 1fr\)"/);
});

test('Span: the whole row, or two columns', () => {
  assert.match(h.spans(), /<div class="ui-span ui-span-all"><p>all<\/p><\/div><div class="ui-span ui-span-2"><p>two<\/p><\/div>/);
});

test("PageTabs: as before without side; with it, the tabs and the panels in a frame, each panel under its name, for the styles to lay side by side", () => {
  const plain = h.tabs();
  assert.ok(!plain.includes('ui-tabs-side') && !plain.includes('ui-side-title'), 'no side: the same tabs as before');
  assert.match(plain, /^<div class="tabs" role="tablist"/);
  const side = h.side();
  assert.match(side, /^<div class="ui-tabs-side ui-tabs-side-wide" style="--ui-tabs:2"><div class="tabs" role="tablist"/);
  assert.match(side, /<div class="ui-side-panels"><div class="tab-panel" role="tabpanel" id="page-panel-drivers" aria-labelledby="page-tab-drivers"><h2 class="ui-side-title">Graphics drivers<span class="muted ui-count"> · 2<\/span><\/h2>/);
  assert.match(side, /id="page-panel-points" aria-labelledby="page-tab-points" hidden=""><h2 class="ui-side-title">Restore points<\/h2><p>points<\/p>/, 'a hidden tab is still drawn, for the styles to show');
  assert.ok(!/<h2>Graphics drivers<\/h2>/.test(side), "the section titled as its tab leaves the title to the tab's name");
});

test('the widths: narrow under 1200 px, desktop from 1200, wide from 2000; desktop on the server', () => {
  assert.deepEqual([DESKTOP_FROM, WIDE_FROM], [1200, 2000]);
  assert.deepEqual([375, 1199, 1200, 1903, 1999, 2000, 2560].map((px) => ui.widthAt(px)), ['narrow', 'narrow', 'desktop', 'desktop', 'desktop', 'wide', 'wide']);
  assert.equal(ui.widthAt(null), 'desktop', 'no matchMedia: drawn on the server');
});

test("the styles: one column by default, each count inside its width's query, a span never widens one column, side tabs only from their width", () => {
  assert.ok(UI_CSS.includes(LAYOUT_CSS), 'part of the page');
  const at = (px: number) => {
    const start = LAYOUT_CSS.indexOf(`@media (min-width: ${px}px) {`);
    return LAYOUT_CSS.slice(start, LAYOUT_CSS.indexOf('\n}', start));
  };
  const base = LAYOUT_CSS.slice(0, LAYOUT_CSS.indexOf('@media'));
  assert.match(base, /\.ui-cols \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
  assert.ok(!/span 2/.test(base), 'one column: a span of 2 would make a second');
  assert.match(at(1200), /\.ui-cols\.ui-d2, \.ui-cols\.ui-weighted\.ui-d2 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(at(1200), /\.ui-cols\.ui-d3 > \.ui-span-2 \{ grid-column: span 2; \}/);
  assert.match(at(2000), /\.ui-cols\.ui-w4, \.ui-cols\.ui-weighted\.ui-w4 \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
  assert.match(at(2000), /\.ui-cols\.ui-w1 > \.ui-span-2 \{ grid-column: auto; \}/);
  assert.match(at(2000), /\.ui-cols\.ui-weighted\.ui-w1 \{ grid-template-columns: repeat\(1, minmax\(0, 1fr\)\); \}/, "a weighted grid's one column when wide outranks its desktop weights");
  assert.ok(at(2000).indexOf('.ui-weighted.ui-w2 {') < at(2000).indexOf('.ui-cols.ui-weighted:is(.ui-w2'), 'and its weights when wide come after the counts, so they win there');
  assert.match(LAYOUT_CSS, /@media \(min-width: 2000px\) \{\n  \.ui-tabs-side-wide > \.tabs \{ display: none; \}/);
  assert.match(LAYOUT_CSS, /\.ui-tabs-side-wide > \.ui-side-panels > \.tab-panel\[hidden\] \{ display: block; \}/);
  assert.match(LAYOUT_CSS, /\.ui-side-title \{ display: none;/, 'narrower, the tab names the panel, not a title');
});
