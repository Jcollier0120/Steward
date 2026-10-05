/**
 * The inventory as a local page (tools/ui-inventory.ts writes it to docs\UI-INVENTORY.html).
 *
 * WHY A SECOND RENDERER. The Markdown reviews well in a diff and badly in a browser. A table of 25 files is
 * easier to read when you can sort and filter it, and "which file is worst" is a question a bar answers at a
 * glance and a column of numbers does not.
 *
 * SELF-CONTAINED AND NOT SERVED. No CDN, no webfont, no build step: one file opened from disk, which is the
 * only way it is useful mid-refactor and offline. It follows Windows' light or dark.
 *
 * Both renderers read the SAME tree the analyser produced, so the two views can't disagree about the shape
 * of the page.
 */

/** One node of the render forest. Mirrors the analyser's shape structurally. */
export interface TreeNodeLike {
  name: string;
  file: string;
  lines: number;
  uses: number;
  core: boolean;
  mark: '' | 'repeat' | 'cycle';
  children: TreeNodeLike[];
}

export interface ComponentLike {
  name: string;
  file: string;
  line: number;
  lines: number;
  size: number;
  exported: boolean;
  isScreen: boolean;
}

export interface InventoryData {
  all: ComponentLike[];
  screens: ComponentLike[];
  shared: { def: ComponentLike; uses: { file: string; count: number }[] }[];
  oversized: ComponentLike[];
  unused: ComponentLike[];
  fileLocal: ComponentLike[];
  repeated: { shape: string; count: number; files: number; where: string[] }[];
  rawRanked: { file: string; total: number; defs: number; perDef: number; tags: [string, number][] }[];
  tree: TreeNodeLike[];
  totalLines: number;
  usesOf: (d: ComponentLike) => number;
  thresholds: { bigComponent: number; bigScreen: number; repeatedMin: number; charsPerLine: number };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (n: number, d: number) => (d === 0 ? '0' : ((n / d) * 100).toFixed(0));

const CSS = `
:root{color-scheme:dark;--bg:#0b0f1a;--surface:#131a2a;--surface2:#1b2438;--border:#26304a;--fg:#e8ecf5;
--muted:#93a0bd;--subtle:#6b7899;--accent:#6366f1;--accent-text:#a5b4fc;--warn:#fbbf24;--ok:#34d399;--nav:rgba(11,15,26,.93)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f7fb;--surface:#fff;--surface2:#eceff6;--border:#dde2ee;
--fg:#1a2033;--muted:#566079;--subtle:#7a849c;--accent:#4f46e5;--accent-text:#4338ca;--warn:#b45309;--ok:#047857;--nav:rgba(246,247,251,.93)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent-text);text-decoration:none}a:hover{text-decoration:underline}
code,.mono{font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Menlo,Consolas,monospace}
header{padding:28px 24px 18px;border-bottom:1px solid var(--border);background:var(--surface)}
h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px}
nav{position:sticky;top:0;z-index:5;display:flex;gap:4px;flex-wrap:wrap;padding:10px 24px;
background:var(--nav);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
nav a{padding:5px 11px;border-radius:999px;color:var(--muted);font-size:13px}
nav a:hover{background:var(--surface2);color:var(--fg);text-decoration:none}
main{padding:8px 24px 80px;max-width:1180px}
section{margin:36px 0;scroll-margin-top:58px}
h2{font-size:17px;margin:0 0 6px;display:flex;align-items:baseline;gap:10px}
h2 .n{font:600 12px/1 ui-monospace,monospace;color:var(--subtle);background:var(--surface2);padding:4px 8px;border-radius:999px}
.note{color:var(--muted);font-size:13px;margin:0 0 14px;max-width:80ch}
.note strong{color:var(--fg)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin-top:18px}
.card{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.card .v{font-size:22px;font-weight:650;letter-spacing:-.02em}
.card .k{color:var(--muted);font-size:12px;margin-top:2px}
.card.good .v{color:var(--ok)}.card.warn .v{color:var(--warn)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--fg)}
th[data-dir]::after{content:" \\2193";color:var(--accent-text)}
th[data-dir="asc"]::after{content:" \\2191";color:var(--accent-text)}
td.num,th.num{text-align:right;font-family:ui-monospace,monospace;white-space:nowrap}
td.over{color:var(--warn)}
tbody tr:hover{background:var(--surface)}
.bar{height:6px;border-radius:3px;background:var(--accent);min-width:2px;display:block;margin-top:6px}
.bar.hot{background:var(--warn)}
.tags{color:var(--muted);font-size:12px}
details.where summary{cursor:pointer;color:var(--muted);font-size:12px}
details.where div{font-size:12px;color:var(--muted)}
input[type=search]{width:100%;max-width:340px;padding:7px 11px;border-radius:8px;
border:1px solid var(--border);background:var(--surface);color:var(--fg);font-size:13px;margin-bottom:12px}
input[type=search]:focus{outline:none;border-color:var(--accent)}
.tree{font-size:13px}
.tree summary{cursor:pointer;padding:2px 0;list-style:none}
.tree summary::-webkit-details-marker{display:none}
.tree summary::before{content:"\\25B8";display:inline-block;width:14px;color:var(--subtle);transition:transform .12s}
.tree details[open]>summary::before{transform:rotate(90deg)}
.tree .leaf{padding:2px 0 2px 14px}
.tree ul{list-style:none;margin:0;padding-left:16px;border-left:1px solid var(--border)}
.tree>ul{padding-left:0;border-left:none}
.root{margin-top:18px}
.nm{font-family:ui-monospace,monospace}
.meta{color:var(--subtle);font-size:12px;margin-left:6px}
.dot{color:var(--accent-text)}.mk{color:var(--subtle)}
.pill{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--surface2);color:var(--muted);font-size:11px}
.empty{color:var(--subtle);font-style:italic}
`;

const JS = `
// Click a column to sort: numeric when the cell carries data-v, else by text.
document.querySelectorAll("table").forEach(function (t) {
  t.querySelectorAll("th").forEach(function (th, i) {
    th.addEventListener("click", function () {
      var dir = th.getAttribute("data-dir") === "desc" ? "asc" : "desc";
      t.querySelectorAll("th").forEach(function (o) { o.removeAttribute("data-dir"); });
      th.setAttribute("data-dir", dir);
      var body = t.tBodies[0];
      Array.prototype.slice.call(body.rows).sort(function (a, b) {
        var x = a.cells[i], y = b.cells[i];
        var r = x.dataset.v !== undefined && y.dataset.v !== undefined
          ? Number(x.dataset.v) - Number(y.dataset.v)
          : x.textContent.trim().localeCompare(y.textContent.trim());
        return dir === "desc" ? -r : r;
      }).forEach(function (r) { body.appendChild(r); });
    });
  });
});
// A filter box hides non-matching rows in the section it names.
document.querySelectorAll("input[type=search]").forEach(function (box) {
  box.addEventListener("input", function () {
    var q = box.value.toLowerCase();
    document.getElementById(box.dataset.scope).querySelectorAll("tbody tr").forEach(function (r) {
      r.style.display = r.textContent.toLowerCase().indexOf(q) === -1 ? "none" : "";
    });
  });
});
// The nav scrolls itself: a plain fragment link does nothing in some places this page is opened from.
document.querySelectorAll('nav a[href^="#"]').forEach(function (a) {
  a.addEventListener("click", function (e) {
    var el = document.getElementById(a.getAttribute("href").slice(1));
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});
var toggle = document.getElementById("tree-toggle");
if (toggle) {
  toggle.addEventListener("click", function (e) {
    e.preventDefault();
    var open = toggle.dataset.open !== "1";
    document.querySelectorAll("#tree details").forEach(function (d) { d.open = open; });
    toggle.dataset.open = open ? "1" : "0";
    toggle.textContent = open ? "Collapse all" : "Expand all";
  });
}
`;

function treeHtml(nodes: TreeNodeLike[]): string {
  const meta = (n: TreeNodeLike, root: boolean) =>
    `<span class="meta">${n.lines}L${root ? ` &middot; ${esc(n.file)}` : ` &middot; ${n.uses}×`}</span>` +
    (n.core ? ' <span class="dot" title="core component - the tree stops here">●</span>' : '') +
    (n.mark === 'repeat' ? ' <span class="mk" title="shown in full above">↑</span>' : '') +
    (n.mark === 'cycle' ? ' <span class="mk" title="renders itself">↺</span>' : '');
  const li = (n: TreeNodeLike, root = false): string => {
    const label = `<span class="nm">${esc(n.name)}</span>${meta(n, root)}`;
    if (n.children.length === 0) return `<li class="leaf">${label}</li>`;
    return `<li><details open><summary>${label}</summary><ul>${n.children.map((c) => li(c)).join('')}</ul></details></li>`;
  };
  return nodes.map((n) => `<div class="tree root"><ul>${li(n, true)}</ul></div>`).join('');
}

/** A table with sortable headers: `[label, numeric]` per column, then the rows' HTML. */
const table = (cols: [string, boolean][], rows: string) =>
  `<div class="scroll"><table><thead><tr>${cols.map(([c, num]) => `<th${num ? ' class="num"' : ''}>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
const num = (v: number, shown: string | number = v, cls = '') => `<td class="num${cls}" data-v="${v}">${shown}</td>`;
const where = (d: ComponentLike) => `<td class="mono tags">${esc(d.file)}:${d.line}</td>`;

export function buildHtml(d: InventoryData): string {
  const t = d.thresholds;
  const over = (c: ComponentLike) => c.size > (c.isScreen ? t.bigScreen : t.bigComponent);
  const card = (v: number | string, k: string, cls = '') => `<div class="card ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  const empty = (s: string) => `<p class="empty">${s}</p>`;

  const repeatedSection =
    d.repeated.length === 0
      ? empty('Nothing repeated above the threshold.')
      : table(
          [['n', true], ['files', true], ['element', false], ['where', false]],
          d.repeated
            .slice(0, 40)
            .map((r) => `<tr>${num(r.count)}${num(r.files)}<td class="mono">${esc(r.shape)}</td><td><details class="where"><summary>${esc(r.where[0])}${r.where.length > 1 ? ` and ${r.where.length - 1} more` : ''}</summary><div class="mono">${r.where.slice(1).map(esc).join('<br>')}</div></details></td></tr>`)
            .join(''),
        );

  // The bar is per def, the number the table is sorted by, against the largest of them (not the first row's).
  const maxPer = Math.max(1, ...d.rawRanked.map((r) => r.perDef));
  const rawRows = d.rawRanked
    .map((r) => {
      const w = Math.max(2, Math.round((r.perDef / maxPer) * 100));
      const per = Math.round(r.perDef * 10) / 10;
      const tags = r.tags.slice(0, 6).map(([tag, n]) => `${esc(tag)} ×${n}`).join(', ');
      return `<tr>${num(r.total)}${num(r.defs)}<td class="num" data-v="${r.perDef}" style="width:120px">${per}<span class="bar${r.perDef >= maxPer * 0.6 ? ' hot' : ''}" style="width:${w}%"></span></td><td class="mono">${esc(r.file)}</td><td class="tags">${tags}</td></tr>`;
    })
    .join('');

  const bigRows = d.all
    .slice(0, 60)
    .map((c) => `<tr>${num(c.size, c.size, over(c) ? ' over' : '')}${num(c.lines)}${c.isScreen ? '<td class="num" data-v="-1"><span class="pill">page</span></td>' : num(d.usesOf(c))}<td class="mono">${esc(c.name)}</td>${where(c)}</tr>`)
    .join('');

  const useRows = d.shared
    .map(({ def, uses }) => `<tr>${num(uses.reduce((s, u) => s + u.count, 0))}${num(uses.length)}<td class="mono">${esc(def.name)}</td>${num(def.size)}${where(def)}</tr>`)
    .join('');

  const localRows = d.fileLocal.map((c) => `<tr>${num(c.size, c.size, over(c) ? ' over' : '')}<td class="mono">${esc(c.name)}</td>${where(c)}</tr>`).join('');
  const unusedRows = d.unused.map((c) => `<tr>${num(c.size)}<td class="mono">${esc(c.name)}${c.exported ? ' <span class="pill">exported</span>' : ''}</td>${where(c)}</tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI inventory</title><style>${CSS}</style></head>
<body>
<header>
  <h1>UI inventory</h1>
  <div class="sub">The Steward and its kit &middot; generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} by <code>npm run ui:inventory</code>. Every finding is a question, not a defect.</div>
  <div class="cards">
    ${card(d.all.length, 'components')}
    ${card(d.screens.length, 'pages')}
    ${card(d.totalLines.toLocaleString('en-US'), 'lines in components')}
    ${card(`${pct(d.shared.length, d.all.length)}%`, 'shared across files')}
    ${card(d.repeated.length, `markup repeated ${t.repeatedMin}+`, d.repeated.length === 0 ? 'good' : 'warn')}
    ${card(d.oversized.length, 'over the size threshold', d.oversized.length === 0 ? 'good' : 'warn')}
    ${card(d.unused.length, 'never used', d.unused.length === 0 ? 'good' : 'warn')}
  </div>
</header>
<nav>
  <a href="#repeated">Repeated markup</a>
  <a href="#largest">Largest</a>
  <a href="#local">File-local</a>
  <a href="#unused">Never used</a>
  <a href="#below">By hand</a>
  <a href="#reused">Most reused</a>
  <a href="#tree">Render tree</a>
</nav>
<main>

<section id="repeated"><h2>Repeated markup <span class="n">${d.repeated.length}</span></h2>
<p class="note"><strong>The leading indicator.</strong> The same element, tag and classes, written out ${t.repeatedMin}+ times. A bare <code>&lt;li&gt;</code> or <code>&lt;td&gt;</code> is how HTML works and isn't counted, nor is SVG drawing; <code>…</code> is a class or tag decided at run time. A set of visual decisions written out this many times is a component nobody has extracted yet.</p>
${repeatedSection}</section>

<section id="largest"><h2>Largest components <span class="n">${d.oversized.length} over</span></h2>
<p class="note">Over ${t.bigComponent} for a component, ${t.bigScreen} for a page, in amber. <strong>Size</strong> is lines, or characters / ${t.charsPerLine} when that is more, since a line here can run to hundreds of characters. A page is allowed to be longer, since its job is to assemble, but a long one is usually several components never separated.</p>
<input type="search" data-scope="largest" placeholder="Filter components&hellip;">
${table([['size', true], ['lines', true], ['uses', true], ['component', false], ['file', false]], bigRows)}</section>

<section id="local"><h2>File-local components <span class="n">${d.fileLocal.length}</span></h2>
<p class="note">Defined and used in <strong>one</strong> file, pages excluded. Not every one should move: a helper that only makes sense next to its caller is fine where it is. The big ones are the ones to look at.</p>
${d.fileLocal.length ? table([['size', true], ['component', false], ['file', false]], localRows) : empty('None.')}</section>

<section id="unused"><h2>Never used <span class="n">${d.unused.length}</span></h2>
<p class="note">Nothing this scan reads renders these. The kit's exports are for every agent, so check the agents before deleting one.</p>
${d.unused.length ? table([['size', true], ['component', false], ['file', false]], unusedRows) : empty('None.')}</section>

<section id="below"><h2>Written by hand <span class="n">${d.rawRanked.length} files</span></h2>
<p class="note">Raw HTML elements each file writes itself rather than through a component, <strong>ordered by per def</strong> (elements per component in the file), so a file of many small components doesn't look worse than one big one. Not a target to drive to zero - a table needs <code>&lt;td&gt;</code> - which is why the breakdown is here. page.ts and html.ts are left out: they are the vocabulary.</p>
<input type="search" data-scope="below" placeholder="Filter files or tags&hellip;">
${table([['raw', true], ['defs', true], ['per def', true], ['file', false], ['what it writes', false]], rawRows)}</section>

<section id="reused"><h2>Most reused <span class="n">${d.shared.length}</span></h2>
<p class="note">Load-bearing: a change here reaches every one of these files. Worth a test, and worth reading twice.</p>
${d.shared.length ? table([['uses', true], ['files', true], ['component', false], ['size', true], ['defined in', false]], useRows) : empty('Nothing is used outside its own file.')}</section>

<section id="tree"><h2>Render tree <span class="n">${d.screens.length} pages</span></h2>
<p class="note">Rooted at each page and <strong>bottoming out at the core components</strong> (page.ts's and html.ts's, <span class="dot">●</span>). <span class="mk">↑</span> means shown in full above; <span class="mk">↺</span> marks recursion.</p>
<p><a href="#" id="tree-toggle" data-open="1">Collapse all</a></p>
${treeHtml(d.tree)}</section>

</main>
<script>${JS}</script>
</body></html>
`;
}
