import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { findBrowser, openTab, type Tab } from './browser.ts';

// Copy at a block's top-right (react/staff.tsx CopyButton, in Output and in a page's own <pre>), in a real browser: it
// copies all of the text, the lines scrolled out of sight too, says Copied and goes back to Copy; Enter and Space press
// it; it sits beside the first line, never over it, and stays in sight as the block scrolls; it takes the theme's colours.
// The clipboard is the page's own stand-in, so a test never touches this PC's.
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { loadEsbuild } = await import('../node/minify.ts');
const browser = findBrowser();
const skip = browser ? false : 'no Chromium browser on this PC (Edge, Chrome or Chromium; KIT_TEST_BROWSER names one)';
const kit = path.join(STEWARD, 'kit/react/index.ts').split(path.sep).join('/');

const FIRST = 'aletaster: origin as fetched at 2026-10-30T15:02:49.164Z (following main): not fetched again, a first line long enough to reach the corner';
const LOG = [FIRST, ...Array.from({ length: 150 }, (_, i) => `line ${i + 2}: installing packages (package-lock.json)`)].join('\n');
const TAIL_OF = 'the whole run, line 1\nline 2\nline 3\nline 4 of the whole run';

const PAGE = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CopyButton, Output, SidePanel, UI_CSS } from '${kit}';

const copied = [];
const commanded = [];
let clipboard = 'works';
let command = true;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { if (clipboard !== 'works') throw new DOMException('refused', 'NotAllowedError'); copied.push(text); } } });
document.execCommand = (name) => {
  if (name !== 'copy') return false;
  const f = document.activeElement;
  commanded.push({ text: f.value, inBlock: !!f.closest('pre'), selected: f.selectionEnd - f.selectionStart });
  return command;
};

const LOG = ${JSON.stringify(LOG)};
const TAIL_OF = ${JSON.stringify(TAIL_OF)};
function App() {
  const [panel, setPanel] = useState(false);
  return (
    <main>
      <style>{UI_CSS}</style>
      <section id="out" style={{ width: 560 }}><Output text={LOG} label="repo-sync log" /></section>
      <pre id="own" style={{ width: 560, maxHeight: 120, overflow: 'auto', padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
        <CopyButton text={TAIL_OF} />
        {TAIL_OF.split('\\n').slice(-2).join('\\n')}
      </pre>
      <button id="open" type="button" onClick={() => setPanel(true)}>Open</button>
      {panel && <SidePanel title="repo-sync log" onClose={() => setPanel(false)}><Output text={LOG} label="repo-sync log" /></SidePanel>}
    </main>
  );
}
createRoot(document.getElementById('root')).render(<App />);

const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left }; };
const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
window.kitTest = {
  copied, commanded,
  clipboard: (how) => { clipboard = how; },
  command: (on) => { command = on; },
  button: (block) => document.querySelector(block + ' .ui-copy'),
  press: (block) => { const b = kitTest.button(block); b.focus(); b.click(); },
  focus: (block) => kitTest.button(block).focus(),
  said: (block) => { const b = kitTest.button(block); return { text: b.textContent, label: b.getAttribute('aria-label'), glyph: b.querySelector('svg rect') ? 'copy' : b.querySelector('svg') ? 'check' : 'none', copied: b.classList.contains('ui-copied'), focused: document.activeElement === b }; },
  /** Whether Copy's word shows (only when it couldn't copy: else it is for a screen reader), and the button's size. */
  shown: (block) => { const b = kitTest.button(block); const w = b.querySelector('.ui-copy-said').getBoundingClientRect(); const r = b.getBoundingClientRect(); return { word: w.width > 2 && w.height > 2, width: r.width, height: r.height, title: b.title }; },
  /** Each line of the block's text that the button's box meets, at the block's scroll now. */
  covered: (block) => {
    const pre = document.querySelector(block + ' pre') || document.querySelector(block);
    const b = box(kitTest.button(block));
    const text = [...pre.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    const range = document.createRange();
    range.selectNodeContents(text);
    return [...range.getClientRects()].filter((r) => r.width > 0 && meets(b, r)).length;
  },
  /** The button's place in what scrolls it: how far below its top and in from its right (its scroll bar left out) it is, and whether it shows. */
  place: (block, scroller) => {
    const s = document.querySelector(scroller);
    const b = box(kitTest.button(block));
    const v = s.getBoundingClientRect();
    const right = v.left + s.clientLeft + s.clientWidth;
    return { below: b.top - v.top, inFromRight: right - b.right, shows: b.top >= v.top && b.bottom <= v.bottom };
  },
  scroll: (sel, y) => { document.querySelector(sel).scrollTop = y; return document.querySelector(sel).scrollTop; },
  open: () => document.querySelector('#open').click(),
  colours: (theme) => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    const probe = document.createElement('div');
    probe.style.cssText = 'color: var(--muted)';
    document.body.append(probe);
    const want = getComputedStyle(probe);
    const got = getComputedStyle(kitTest.button('#out'));
    const block = getComputedStyle(document.querySelector('#out pre'));
    const r = { background: got.backgroundColor, color: got.color, block: block.backgroundColor, muted: want.color, font: got.fontFamily };
    probe.remove();
    return r;
  },
  /** The button's middle in the viewport, for the mouse. */
  middle: (block) => { const r = kitTest.button(block).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
  /** The button's colour now, and the theme's --ok and --fg. */
  tint: (block) => {
    const probe = (v) => { const p = document.createElement('div'); p.style.cssText = 'color: var(' + v + ')'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
    return { color: getComputedStyle(kitTest.button(block)).color, ok: probe('--ok'), fg: probe('--fg'), hovered: kitTest.button(block).matches(':hover') };
  },
  selection: (block) => { const s = getSelection(); const t = s.toString(); s.removeAllRanges(); return t; },
  selectBlock: (block) => getSelection().selectAllChildren(document.querySelector(block + ' pre') || document.querySelector(block)),
  until: (look, ms = 5000) => new Promise((ok, no) => {
    const end = performance.now() + ms;
    const again = () => {
      let v;
      try { v = look(); } catch (e) { return no(e); }
      if (v) return ok(v);
      if (performance.now() > end) return no(new Error('timed out waiting for ' + look));
      setTimeout(again, 10);
    };
    again();
  }),
};
`;

let server: http.Server | undefined;
let tab: Tab | undefined;
const run = <T = unknown>(js: string) => tab!.run<T>(js);
type Said = { text: string; label: string; glyph: string; copied: boolean; focused: boolean };
const said = (block: string) => run<Said>(`kitTest.said(${JSON.stringify(block)})`);
const back = (block: string) => run<Said>(`kitTest.until(() => { const s = kitTest.said(${JSON.stringify(block)}); return s.text === 'Copy' && s; }, 4000)`);

before(async () => {
  if (!browser) return;
  const esbuild = await loadEsbuild(STEWARD);
  if ('error' in esbuild) throw new Error(esbuild.error);
  const built = await esbuild.build({ stdin: { contents: PAGE, resolveDir: STEWARD, loader: 'tsx', sourcefile: 'copy-page.tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const js = built.outputFiles![0].text;
  const themes = readFileSync(path.join(STEWARD, 'kit/web/themes.css'), 'utf8');
  // page.ts's own classes (button, the focus ring), read from it: it imports the agent's app.ts, which the kit has none of.
  const CSS = /^export const CSS = `([^`]*)`;/m.exec(readFileSync(path.join(STEWARD, 'kit/node/page.ts'), 'utf8'))![1];
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Copy</title><style>${themes}\n${CSS}</style></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>`;
  server = http.createServer((req, res) => {
    const page = req.url === '/page.js';
    res.writeHead(200, { 'content-type': page ? 'text/javascript' : 'text/html' });
    res.end(page ? js : html);
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  tab = await openTab(browser, `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  await run(`kitTest.until(() => !!document.querySelector('#out .ui-copy'))`);
});

after(async () => {
  await tab?.close();
  server?.close();
});

test('Copy copies all of the text, the lines scrolled out of sight too, says Copied, then Copy again', { skip }, async () => {
  assert.deepEqual(await said('#out'), { text: 'Copy', label: 'Copy: repo-sync log', glyph: 'copy', copied: false, focused: false });
  const shown = await run<{ word: boolean; width: number; height: number; title: string }>(`kitTest.shown('#out')`);
  assert.equal(shown.word, false, 'the copy glyph alone: its word is for a screen reader');
  assert.equal(shown.title, 'Copy', 'and a tip on hover');
  assert.ok(shown.width < 30 && shown.height < 30, `a small square: ${JSON.stringify(shown)}`);
  assert.ok((await run<number>(`kitTest.scroll('#out pre', 0) === 0 && document.querySelector('#out pre').scrollHeight - document.querySelector('#out pre').clientHeight`)) > 200, 'the log scrolls');
  await run(`kitTest.press('#out')`);
  await run(`kitTest.until(() => kitTest.copied.length === 1)`);
  assert.equal(await run<string>('kitTest.copied[0]'), LOG, 'all of it, as it was given');
  assert.deepEqual(await said('#out'), { text: 'Copied', label: 'Copied', glyph: 'check', copied: true, focused: true });
  assert.deepEqual(await back('#out'), { text: 'Copy', label: 'Copy: repo-sync log', glyph: 'copy', copied: false, focused: true }, 'Copy again, focus where it was');
});

test("a page's own block copies the text it was given (the whole run), not only the lines it shows", { skip }, async () => {
  assert.equal((await said('#own')).label, 'Copy all of it', 'with no label, a name that still says what it does');
  await run(`kitTest.copied.length = 0; kitTest.press('#own')`);
  await run(`kitTest.until(() => kitTest.copied.length === 1)`);
  assert.equal(await run<string>('kitTest.copied[0]'), TAIL_OF);
  await back('#own');
});

test('Enter and Space press it, as any button', { skip }, async () => {
  await run(`kitTest.copied.length = 0; kitTest.focus('#out')`);
  await tab!.key('Enter');
  await run(`kitTest.until(() => kitTest.copied.length === 1)`);
  assert.equal((await said('#out')).text, 'Copied');
  await back('#out');
  await tab!.key('Space');
  await run(`kitTest.until(() => kitTest.copied.length === 2)`);
  assert.deepEqual(await run<string[]>('kitTest.copied'), [LOG, LOG]);
  await back('#out');
});

test("clicked with the mouse, the pointer still on it, Copied's check is the theme's ok colour, not hover's", { skip }, async () => {
  await run(`kitTest.scroll('#out pre', 0); kitTest.copied.length = 0`);
  const { x, y } = await run<{ x: number; y: number }>(`kitTest.middle('#out')`);
  await tab!.click(x, y);
  await run(`kitTest.until(() => kitTest.copied.length === 1)`);
  const t = await run<{ color: string; ok: string; fg: string; hovered: boolean }>(`kitTest.tint('#out')`);
  assert.ok(t.hovered, 'the pointer is still on it');
  assert.notEqual(t.ok, t.fg);
  assert.equal(t.color, t.ok);
  await back('#out');
  await tab!.hover(0, 0);
  assert.equal(await run<boolean>(`kitTest.tint('#out').hovered`), false, 'the pointer away again, for the colours below');
});

test('it sits beside the first line, never over it, at the top-right corner; and stays in sight as the block scrolls', { skip }, async () => {
  await run(`kitTest.scroll('#out pre', 0)`);
  assert.equal(await run<number>(`kitTest.covered('#out')`), 0, 'no line of the text under it');
  let p = await run<{ below: number; inFromRight: number; shows: boolean }>(`kitTest.place('#out', '#out pre')`);
  assert.ok(p.shows && p.below >= 0 && p.below <= 8 && p.inFromRight >= 0 && p.inFromRight <= 8, `at the top-right corner: ${JSON.stringify(p)}`);
  await run(`kitTest.scroll('#out pre', 600)`);
  p = await run(`kitTest.place('#out', '#out pre')`);
  assert.ok(p.shows && p.below >= 0 && p.below <= 8, `still at the top as the block scrolls: ${JSON.stringify(p)}`);
  await run(`kitTest.scroll('#out pre', 0)`);
  assert.equal(await run<number>(`kitTest.covered('#own')`), 0, "a page's own block too");
});

test('in a side panel the panel scrolls, and Copy stays at its top while the log is in sight', { skip }, async () => {
  await run(`kitTest.open(); kitTest.until(() => !!document.querySelector('.ui-side-panel .ui-copy'))`);
  assert.equal(await run<number>(`kitTest.covered('.ui-side-panel')`), 0);
  assert.ok((await run<number>(`kitTest.scroll('.ui-side-panel', 900)`)) > 0, 'the panel scrolls');
  const p = await run<{ below: number; shows: boolean }>(`kitTest.place('.ui-side-panel', '.ui-side-panel')`);
  assert.ok(p.shows && p.below >= 0 && p.below <= 16, `at the panel's top, inside its padding: ${JSON.stringify(p)}`);
  await run(`kitTest.copied.length = 0; kitTest.press('.ui-side-panel')`);
  await run(`kitTest.until(() => kitTest.copied.length === 1)`);
  assert.equal(await run<string>('kitTest.copied[0]'), LOG);
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await run(`kitTest.until(() => !document.querySelector('.ui-side-panel'))`);
});

test("a hand's selection of the block takes its text, not Copy's word", { skip }, async () => {
  await run(`kitTest.selectBlock('#own')`);
  assert.equal(await run<string>(`kitTest.selection('#own')`), TAIL_OF.split('\n').slice(-2).join('\n'));
});

test("where the page has no clipboard it copies with the browser's copy command, from a field inside the block", { skip }, async () => {
  await run(`kitTest.clipboard('refused'); kitTest.copied.length = 0; kitTest.press('#out')`);
  await run(`kitTest.until(() => kitTest.commanded.length === 1)`);
  assert.deepEqual(await run('kitTest.commanded[0]'), { text: LOG, inBlock: true, selected: LOG.length }, 'inside the block, so a modal dialog lets it be selected');
  assert.deepEqual(await said('#out'), { text: 'Copied', label: 'Copied', glyph: 'check', copied: true, focused: true }, 'focus back on Copy');
  assert.equal(await run<number>(`document.querySelectorAll('#out textarea').length`), 0, 'the field gone');
  await back('#out');
});

test('when neither copies, it selects the block for the keyboard and says so', { skip }, async () => {
  await run(`kitTest.command(false); kitTest.press('#own')`);
  await run(`kitTest.until(() => kitTest.said('#own').text === 'Press Ctrl+C')`);
  assert.equal((await said('#own')).copied, false);
  assert.equal((await run<{ word: boolean }>(`kitTest.shown('#own')`)).word, true, 'this word shows');
  assert.equal(await run<string>(`kitTest.selection('#own')`), TAIL_OF.split('\n').slice(-2).join('\n'), "the block's text, not Copy's");
  await run(`kitTest.clipboard('works'); kitTest.command(true)`);
  await back('#own');
});

test("it takes the theme's colours, light and dark, in the page's font", { skip }, async () => {
  type Colours = { background: string; color: string; block: string; muted: string; font: string };
  const light = await run<Colours>(`kitTest.colours('light')`);
  const dark = await run<Colours>(`kitTest.colours('dark')`);
  await run(`kitTest.colours(null)`);
  for (const c of [light, dark]) {
    assert.equal(c.background, c.block, "on the block's own background");
    assert.equal(c.color, c.muted);
    assert.match(c.font, /Segoe UI/, 'not the block\'s monospace');
  }
  assert.notEqual(light.background, dark.background);
});
